'use strict';

// The cut of a release prepared again (`/prepare-again`, lib/prepare-again.js). `shipyard cut` calls `prepareAgainCut` after the
// prep file passes and before it looks for a number. When an open release PR into `base` already holds the facts' range (the same
// `from`, `fromCommit` and `to`), the cut does not refuse it as a candidate holding the number: if the PR has a pending accepted
// request, it adds one commit to the PR's branch instead, for the same version.
//
//   - The request: the newest `shipyard:prepare-again` marker on the PR by `github-actions[bot]` whose request no commit of the PR
//     names in a `Release-Prepared-Again` trailer. None pending: the cut goes on, and refuses the open candidate as it always has.
//   - The level: the new prep's must be the one the release was cut at (`Release-Level` of the oldest `chore(release): <tag>` commit
//     on the branch, the one the release check reads). Another level is refused: `/level` changes it.
//   - The commit: on the PR's head, its tree the head's with only this version's CHANGELOG section made again from the new facts and
//     prep, at the date the section already has; its subject `chore(release): <tag>`, so every reader finds the new release data
//     through it; the cut commit's `Release-Level`, `Release-Breaking` and `Release-From` trailers, then `Release-Prepared-Again:
//     <request>`, then `Release-Data`. The branch moves by a fast-forward only: a head that moved since it was read fails the move,
//     and nothing is written.
//   - The output: no `release-pr` files, so nothing opens or comments on a PR. `prepared-again/prepared-again.json` under the cut's
//     `--out` says what happened (`{ pr, request, outcome, message, sha, tag }`), and `prepared-again/body.md` is the PR's new body,
//     which the record's prepared-again mode puts on the PR. A refusal of the level or the CHANGELOG writes the JSON too, then the
//     cut exits 1.

const fs = require('node:fs');
const path = require('node:path');
const { GitHubError } = require('./github');
const {
  Refusal, ReleaseError, git, parseTag, formatVersion,
} = require('./release-git');
const {
  buildSection, replaceSection, renderReleaseNotes, renderPrBody, headingFor,
} = require('./changelog');
const { textEntry, commitChain } = require('./api-commit');
const {
  FORMAT: RELEASE_DATA_FORMAT, DATA_TRAILER, CUT_LIMIT, encodeReleaseData, checkBlockSize, withReleaseData, readReleaseInputs,
  commitsFromGit, trailerValues,
} = require('./release-data');
const { tagOf } = require('./record');
const { announceCalled, announcePage } = require('./announce-called');
const { tagSignal } = require('./tag-signal');
const { personNamesOf } = require('./deploy-rows');
const { TRAILER, parseRequestMarkers, appliedRequests } = require('./prepare-again');

const FOLDER = 'prepared-again';
const RESULT_FILE = 'prepared-again.json';
const BODY_FILE = 'body.md';
const SHA = /^[0-9a-f]{40}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
// The cut commit's trailers a prepared-again commit carries again, in this order.
const KEPT_TRAILERS = ['Release-Level', 'Release-Breaking', 'Release-From'];

const sameRepo = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
const sameRange = (a, b) => Boolean(a && b) && a.from === b.from && a.fromCommit === b.fromCommit && a.to === b.to;

// A commit as `{ message, parents, tree }`, from the checkout when it has it (fetch-depth 0 has every release branch), else from
// GitHub. Each is read once.
function commitReader({ dir, github, repo }) {
  const fromGit = commitsFromGit(dir);
  const seen = new Map();
  return (sha) => {
    if (!seen.has(sha)) {
      seen.set(sha, (async () => {
        if (SHA.test(String(sha)) && git(dir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }) !== null) {
          const c = await fromGit(sha);
          return { ...c, tree: git(dir, ['rev-parse', '--verify', `${sha}^{tree}`]).trim() };
        }
        return github.getCommit(repo, sha);
      })());
    }
    return seen.get(sha);
  };
}

// A file's text at a commit: the checkout's copy, else GitHub's. Null when the commit has no such file.
async function fileAt({
  dir, github, repo, sha, file,
}) {
  if (git(dir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }) !== null) return git(dir, ['show', `${sha}:${file}`], { allowFail: true });
  return github.getFileText(repo, file, sha);
}

/**
 * The open release PR into `base` whose verified release data is for the facts' range, or null. A PR whose data does not verify
 * is not one: the cut goes on, and refuses it as a candidate when it holds the number.
 *
 * @returns {Promise<{ pull: object, tag: string, version: string, inputs: object } | null>}
 */
async function openReleaseOf({
  github, repo, base, facts, getCommit,
}) {
  const open = (await github.listOpenPulls(repo))
    .filter((p) => p && p.state !== 'closed' && p.base && p.base.ref === base && p.head && /^release\//.test(String(p.head.ref || ''))
      && p.head.repo && sameRepo(p.head.repo.full_name, repo))
    .sort((a, b) => a.number - b.number);
  for (const pull of open) {
    const tag = tagOf(pull.body);
    if (!tag || !TAG.test(tag) || tag.includes('..')) continue;
    const parsed = parseTag(tag, facts.tagPrefix);
    if (!parsed) continue;
    const version = formatVersion(parsed.parts);
    if (pull.head.ref !== `release/${version}` || !SHA.test(String(pull.head.sha))) continue;
    let inputs;
    try {
      inputs = await readReleaseInputs({
        body: pull.body, tag, headSha: pull.head.sha, getCommit, prNumber: pull.number, readFolderFile: async () => null, current: null,
      });
    } catch (e) {
      if (e instanceof Refusal || e instanceof ReleaseError || (e instanceof GitHubError && e.status === 404)) continue;
      throw e;
    }
    if (inputs.source !== 'body' || inputs.profile !== 'full' || !inputs.facts || !sameRange(inputs.facts.range, facts.range)) continue;
    if (!inputs.facts.repo || !sameRepo(inputs.facts.repo.name, repo)) continue;
    return {
      pull, tag, version, inputs,
    };
  }
  return null;
}

// The oldest `chore(release): <tag>` commit on the first-parent line from `headSha`, down to the commit the release was cut from
// (`stopAt`), at most CUT_LIMIT commits: the cut commit the release check reads the level and the work branch from.
async function oldestCutCommit({
  headSha, tag, stopAt, getCommit,
}) {
  const subject = `chore(release): ${tag}`;
  let oldest = null;
  let sha = headSha;
  for (let n = 0; sha && sha !== stopAt && n < CUT_LIMIT; n += 1) {
    const c = await getCommit(sha);
    const message = String((c && c.message) || '');
    if (message.split('\n')[0].trim() === subject) oldest = { sha, message };
    sha = c && Array.isArray(c.parents) && c.parents.length ? c.parents[0] : null;
  }
  return oldest;
}

// The JSON the record's prepared-again mode reads, and the body when applied.
function writeOutput(out, result, body = null) {
  const dir = path.join(out, FOLDER);
  fs.mkdirSync(dir, { recursive: true });
  if (body !== null) fs.writeFileSync(path.join(dir, BODY_FILE), body);
  fs.writeFileSync(path.join(dir, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
}

/**
 * Applies a new prep to the open release PR that holds the facts' range, when it has a pending request. Returns null when no open
 * release PR holds the range or none has a pending request (the cut goes on as it always has), else the result it wrote. A Refusal
 * (another level, a head with no section for the version) writes `outcome: 'refused'` first.
 *
 * @param {object} o  as `cut` (lib/cut.js): dir, facts, prep (already checked), github, out, base, date, changelogFile, shipyard
 * @returns {Promise<{ pr: number, request: number, outcome: 'applied', message: string, sha: string, tag: string, branch: string } | null>}
 */
async function prepareAgainCut({
  dir, facts, prep, github, out, base, date, changelogFile, shipyard,
}) {
  const repo = facts.repo.name;
  const getCommit = commitReader({ dir, github, repo });
  const found = await openReleaseOf({
    github, repo, base, facts, getCommit,
  });
  if (!found) return null;
  const {
    pull, tag, version, inputs,
  } = found;
  const number = pull.number;
  const headSha = pull.head.sha;

  const applied = await appliedRequests({ headSha, tag, getCommit });
  const markers = parseRequestMarkers(await github.listIssueComments(repo, number)).filter((m) => m.tag === tag && !applied.has(m.request));
  const pending = markers.length ? markers[markers.length - 1] : null;
  if (!pending) return null;
  const { request } = pending;

  // From here every refusal is the request's answer: the JSON says so, for the record to reply with, before it leaves the cut.
  try {
    return await apply({
      dir, facts, prep, github, out, base, date, changelogFile, shipyard, repo, getCommit, pull, tag, version, inputs, request,
    });
  } catch (e) {
    if (e instanceof Refusal) {
      writeOutput(out, {
        pr: number, request, outcome: 'refused', message: e.message, sha: null, tag,
      });
    }
    throw e;
  }
}

// The commit, the new release data and the new body, for a pending request whose prep is at the cut's level.
async function apply({
  dir, facts, prep, github, out, base, date, changelogFile, shipyard, repo, getCommit, pull, tag, version, inputs, request,
}) {
  const number = pull.number;
  const headSha = pull.head.sha;

  const cut = await oldestCutCommit({
    headSha, tag, stopAt: facts.range.to, getCommit,
  });
  if (!cut) throw new Refusal(`#${number} has no cut commit, chore(release): ${tag}, in the ${CUT_LIMIT} commits below its head ${headSha.slice(0, 7)}, so the report cannot be prepared again: cut the release again`);
  const levels = trailerValues(cut.message, 'Release-Level');
  const cutLevel = levels.length === 1 ? levels[0] : null;
  if (prep.level.bump !== cutLevel) {
    throw new Refusal(`the new prep's level is ${prep.level.bump}, but ${tag} was cut at ${cutLevel || 'no level'}: the report can be prepared again only at the same level; to change the level, an area approver writes /level ${prep.level.bump} on #${number}`);
  }

  const toSha = facts.range.to;
  const head = await getCommit(headSha);
  const before = await fileAt({
    dir, github, repo, sha: headSha, file: changelogFile,
  });
  if (before === null || !headingFor(version).test(String(before).replace(/\r\n?/g, '\n'))) {
    throw new Refusal(`${changelogFile} at ${headSha.slice(0, 7)}, the head of #${number}, has no section for ${version}, so it cannot be made again: cut the release again`);
  }
  // The section keeps the date it was cut with.
  const heading = new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]? - (\\d{4}-\\d{2}-\\d{2})\\s*$`, 'm').exec(String(before).replace(/\r\n?/g, '\n'));
  const section = buildSection({
    facts, prep, version, date: heading ? heading[1] : date,
  });
  const changelog = replaceSection(before, section.text, version);
  const notes = renderReleaseNotes(prep.notes, facts);
  const data = encodeReleaseData({
    format: RELEASE_DATA_FORMAT, tag, profile: 'full', facts, prep, notes, reships: Array.isArray(inputs.reships) ? inputs.reships : [], shipyard,
  });
  checkBlockSize(data.block, facts.prs.length);
  const froms = trailerValues(cut.message, 'Release-From');
  const workBranch = froms.length === 1 && froms[0] ? froms[0] : null;
  const body = withReleaseData(renderPrBody({
    tag, facts, prep, releaseBody: section.text, releaseNotes: notes, base, workBranch, announces: announceCalled(dir, toSha), announcePage: announcePage(dir, toSha), shipSignal: tagSignal(dir, toSha), names: await personNamesOf({ github, report: prep.report, refuse: true }),
  }), data.block);

  const trailers = [];
  for (const name of KEPT_TRAILERS) for (const value of trailerValues(cut.message, name)) trailers.push(`${name}: ${value}`);
  trailers.push(`${TRAILER}: ${request}`);
  trailers.push(`${DATA_TRAILER}: ${data.digest}`);
  const message = [
    `chore(release): ${tag}`,
    `Prepared again for request ${request} on #${number}: the ${version} section of ${changelogFile} made again from a new prep of ${facts.range.from}..${toSha.slice(0, 7)}, at the same level. The facts, the prep file and the release notes are in the release PR's body.`,
    trailers.join('\n'),
  ].join('\n\n').concat('\n');

  // The commit is made by the API on the head the release data was read through, and the branch moves only by a fast-forward:
  // a head that moved since fails the move, and nothing more is written.
  const { commit } = await commitChain({
    github, repo, parent: headSha, baseTree: head.tree, steps: [{ message, entries: [textEntry(changelogFile, changelog)] }],
  });
  try {
    await github.updateBranch(repo, pull.head.ref, commit);
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 422) throw e;
    throw new GitHubError(`${pull.head.ref} moved since the cut read #${number} at ${headSha.slice(0, 7)}, so ${commit.slice(0, 7)} is not a fast forward of it: the branch was left as it is and nothing was written. Run the cut again`, e.status);
  }

  const result = {
    pr: number,
    request,
    outcome: 'applied',
    message: `The new report of ${tag} is on ${pull.head.ref} at ${commit.slice(0, 7)}, for request ${request}: any approval given before it no longer counts.`,
    sha: commit,
    tag,
  };
  writeOutput(out, result, body);
  return { ...result, branch: pull.head.ref };
}

module.exports = {
  prepareAgainCut, openReleaseOf, oldestCutCommit, FOLDER, RESULT_FILE, BODY_FILE,
};
