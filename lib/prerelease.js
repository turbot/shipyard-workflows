'use strict';

// A prerelease (`v1.5.0-rc.1`): a tag and a GitHub Release marked as a prerelease, at a commit of a
// work branch, made by the area's release App when someone in the area's approver team starts it. It
// reads GitHub only: no checkout, and nothing from the repo is run. It writes the tag and the Release,
// and nothing else: no commit, no branch, no CHANGELOG section, no PR, no comment and no announcement.
// A release tag is `<prefix>X.Y.Z` (lib/release-git.js), so every step that finds the newest release
// (the facts, the cut, the level, the start, the tag, the announce) never reads a prerelease tag.

const { GitHubError } = require('./github');
const {
  ReleaseError, Refusal, parseTag, compareParts, formatVersion, prNumberOf,
} = require('./release-git');
const { attachFiles, draftOf, commitOfRef } = require('./tag');
const { newestOf } = require('./newest-release-tag');
const { changelogItem } = require('./changelog');
const { isMergeBack, changelogLinesOf } = require('./facts');
const { notShippedOf, prShipsNothing } = require('./changelog-line-command');
const { loadReaderConfig } = require('./reader-config');

// The kinds, in semver order: alpha sorts before beta, and beta before rc.
const KINDS = ['alpha', 'beta', 'rc'];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TEAM = /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/;
// A work branch (`develop`, `develop-5.60`, `develop-v6`) or a candidate (`release/1.5.0`). Never a PR's branch.
const WORK_BRANCH = /^develop(-[A-Za-z0-9.]+)?$/;
const CANDIDATE = /^release\/((0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*))$/;

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const show = (value, max = 80) => {
  const text = JSON.stringify(String(value));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const short = (sha) => String(sha).slice(0, 7);
const isBot = (login) => /\[bot\]$/i.test(String(login));

// `<prefix>X.Y.Z-<kind>.N` as `{ tag, parts, kind, n }`, or null when the tag is not a prerelease tag.
function parsePrereleaseTag(tag, prefix) {
  const m = new RegExp(`^${escapeRegExp(prefix)}(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)-(${KINDS.join('|')})\\.([1-9]\\d{0,5})$`).exec(String(tag));
  return m ? {
    tag, parts: [Number(m[1]), Number(m[2]), Number(m[3])], kind: m[4], n: Number(m[5]),
  } : null;
}

function checkKind(kind) {
  if (!KINDS.includes(kind)) throw new ReleaseError(`--pre must be ${KINDS.join(', ')}, not ${show(kind, 30)}`);
}

function checkTeam(approvers) {
  if (!TEAM.test(String(approvers || ''))) throw new ReleaseError('--approvers must be the area\'s approver team, <org>/<team-slug>');
}

function parseVersion(version) {
  const m = VERSION.exec(String(version));
  if (!m) throw new ReleaseError(`--version must be the next version as X.Y.Z (1.5.0), not ${show(version, 40)}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * The branch a prerelease may come from: a work branch, or the candidate of the same version. A PR's
 * branch never: its code may never reach a release (powerpipe's v1.5.0 RCs came from a PR that closed).
 */
function checkBranch(branch, parts) {
  if (WORK_BRANCH.test(branch)) return;
  const m = CANDIDATE.exec(branch);
  if (m) {
    if (m[1] !== formatVersion(parts)) throw new Refusal(`${branch} is the candidate of ${m[1]}, so its prerelease is of ${m[1]}, not ${formatVersion(parts)}`);
    return;
  }
  throw new Refusal(`${show(branch, 60)} is not a work branch (develop, develop-<x.y>) or a candidate (release/X.Y.Z): a prerelease never comes from a PR's branch. Merge the change to a work branch first`);
}

/**
 * The next prerelease of `parts` and `kind`, from every tag name with the prefix: `{ tag, n, newest }`,
 * `newest` being the newest release tag (null with none). The version must be newer than every release,
 * and a kind never goes backwards (no alpha once an rc of the same version is out).
 */
function nextPrerelease({ names, prefix, parts, kind }) {
  const newestTag = newestOf(names, prefix);
  const newest = newestTag ? parseTag(newestTag, prefix) : null;
  if (newest && compareParts(parts, newest.parts) <= 0) {
    throw new Refusal(`${formatVersion(parts)} is not newer than ${newest.tag}, the newest release: a prerelease is of a version still to come`);
  }
  const same = names.map((n) => parsePrereleaseTag(n, prefix)).filter((p) => p && compareParts(p.parts, parts) === 0);
  const later = same.filter((p) => KINDS.indexOf(p.kind) > KINDS.indexOf(kind)).map((p) => p.tag).sort();
  if (later.length) throw new Refusal(`${later[later.length - 1]} is out, and ${kind} sorts before it: a prerelease of ${formatVersion(parts)} is now ${KINDS.slice(KINDS.indexOf(kind) + 1).join(' or ')}`);
  const n = same.filter((p) => p.kind === kind).reduce((max, p) => Math.max(max, p.n), 0) + 1;
  return { tag: `${prefix}${formatVersion(parts)}-${kind}.${n}`, n, newest: newest ? newest.tag : null };
}

/**
 * Who started the run, checked: a run someone started by hand (`workflow_dispatch`), by a person in the
 * approver team, and, when someone else ran it again, that person too. The team is read with a token
 * that can see it; GitHub answers "not found" both for a non-member and for a team the token cannot
 * see, so a wrong token refuses everyone and never lets anyone through.
 */
async function checkStarter({
  orgGithub, approvers, eventName, actor, triggeringActor,
}) {
  if (eventName !== 'workflow_dispatch') throw new Refusal(`the run is a ${show(eventName || 'no', 30)} event: a prerelease is started by a person, by hand (workflow_dispatch)`);
  if (!actor) throw new ReleaseError('no GITHUB_ACTOR: cannot tell who started the run');
  const [org, team] = approvers.split('/');
  const people = [...new Set([actor, triggeringActor].filter(Boolean))];
  for (const login of people) {
    if (isBot(login)) throw new Refusal(`${show(login, 40)} is a bot: only a person in ${approvers} starts a prerelease`);
    const state = await orgGithub.teamMembership(org, team, login);
    if (state !== 'active') throw new Refusal(`${show(login, 40)} is not in ${approvers}: only the area's release approvers start a prerelease. Nothing was made`);
  }
  return people;
}

// The commit is a full id and is in the branch's history: it may be the branch's tip or older.
async function checkCommit({
  github, repo, commit, branch,
}) {
  if (!/^[0-9a-f]{40}$/.test(String(commit))) throw new ReleaseError(`--commit must be a full 40-character commit id, not ${show(commit, 50)}`);
  const status = await github.compareStatus(repo, commit, branch);
  if (status === null) throw new Refusal(`GitHub cannot compare ${short(commit)} with ${branch}: the commit or the branch is not in ${repo}`);
  if (status !== 'ahead' && status !== 'identical') throw new Refusal(`${short(commit)} is not in the history of ${branch} (${branch} is ${status} of it): a prerelease is made from a commit the branch holds`);
}

/**
 * What a prerelease will be, checked before anything is built: the starter, the branch, the commit and
 * the tag. Returns `{ tag, version, newest, people }`; throws a Refusal naming what is wrong.
 */
async function planPrerelease({
  github, orgGithub, repo, prefix, commit, branch, version, kind, approvers, starter,
}) {
  checkKind(kind);
  checkTeam(approvers);
  const parts = parseVersion(version);
  const people = await checkStarter({ orgGithub, approvers, ...starter });
  checkBranch(branch, parts);
  await checkCommit({
    github, repo, commit, branch,
  });
  const names = await github.listTagNames(repo, prefix);
  const next = nextPrerelease({
    names, prefix, parts, kind,
  });
  // A run again of every job, after a publish that failed past its tag: the newest tag of this kind is at
  // this commit and has no Release yet. It is named again, so the publish finishes it rather than leave it
  // with no Release beside a second number.
  const unfinished = await unfinishedOf({
    github, repo, names, prefix, parts, kind, commit,
  });
  const plan = unfinished ? { ...next, tag: unfinished, n: parsePrereleaseTag(unfinished, prefix).n } : next;
  return {
    ...plan, version: plan.tag.slice(prefix.length), parts, people, resumed: Boolean(unfinished),
  };
}

// The newest prerelease tag of this version and kind, when it is at `commit` and has no published Release; else null.
async function unfinishedOf({
  github, repo, names, prefix, parts, kind, commit,
}) {
  const newest = names.map((n) => parsePrereleaseTag(n, prefix))
    .filter((p) => p && p.kind === kind && compareParts(p.parts, parts) === 0)
    .sort((a, b) => b.n - a.n)[0];
  if (!newest) return null;
  const ref = await github.getTagRef(repo, newest.tag);
  if (!ref || await commitOfRef(github, repo, ref) !== commit) return null;
  return (await github.getRelease(repo, newest.tag)) ? null : newest.tag;
}

const messageOf = ({
  tag, branch, people,
}) => `Prerelease ${tag}\n\nFrom: ${branch}\nStarted by: ${people.join(', ')}\n`;

/**
 * The tag the build was made for (`expected`, from the start), checked again and made. It is either
 * already there at the commit (a run again after a failure: finish what is left) or the next free one;
 * a number another prerelease took meanwhile is refused, as the build carries this version.
 */
async function resolveExpected({
  github, repo, prefix, expected, commit, version, kind,
}) {
  const parsed = parsePrereleaseTag(expected, prefix);
  const parts = parseVersion(version);
  if (!parsed || compareParts(parsed.parts, parts) !== 0 || parsed.kind !== kind) {
    throw new Refusal(`--tag ${show(expected, 50)} is not a ${kind} of ${formatVersion(parts)} with the prefix ${show(prefix, 20)}: pass the tag the start step named`);
  }
  const ref = await github.getTagRef(repo, expected);
  if (!ref) return { exists: false };
  const at = await commitOfRef(github, repo, ref);
  if (at !== commit) throw new Refusal(`${expected} already exists at ${short(at)}, not at ${short(commit)}. A tag never moves: start a new prerelease, which takes the next number`);
  return { exists: true };
}

// The annotated tag, made with the release App's token. A second run that won the race is fine only at the same commit.
async function makeTag({
  github, releaser, repo, tag, commit, message,
}) {
  const object = await releaser.createTagObject(repo, { tag, message, commit });
  try {
    await releaser.createTag(repo, tag, object);
  } catch (e) {
    if (!(e instanceof GitHubError) || e.status !== 422) throw e;
    const ref = await github.getTagRef(repo, tag);
    if (!ref) throw e;
    const at = await commitOfRef(github, repo, ref);
    if (at !== commit) throw new Refusal(`${tag} was made at ${short(at)} by another run meanwhile: start a new prerelease, which takes the next number. Nothing was changed`);
    return 'exists';
  }
  return 'created';
}

/**
 * The PRs since the newest release that a tester gets, as the CHANGELOG section of the next release will
 * list them: each merged PR on the first-parent line from `commit` back to `newest` (its number read from the
 * commit's subject), as the facts read the range (lib/release-git.js `rangeCommits`), with its one
 * `Changelog:` line, in number order. A commit inside a merged branch is not on that line. A PR with no
 * line, one that ships nothing (its files all on the repo's `notShipped`, read from the repo's config, `.github/shipyard.yml`
 * or `.github/release.json`, at the commit) and a merge-back are left out. Reads GitHub only. Returns `{ prs, status }`: `status` is how the
 * commit stands to `newest` (compareStatus), and `prs` is empty unless the commit holds `newest`.
 */
async function changesSince({
  github, repo, newest, commit, loaded,
}) {
  const range = await github.compareCommits(repo, newest, commit);
  if (!range) throw new ReleaseError(`GitHub cannot compare ${newest} with ${short(commit)} in ${repo}, so the prerelease's changes cannot be listed`);
  if (range.status !== 'ahead' && range.status !== 'identical') return { prs: [], status: range.status };
  // The first-parent line from the commit back to the newest release: `git log --first-parent newest..commit`.
  const bySha = new Map(range.commits.map((c) => [c.sha, c]));
  const line = [];
  for (let c = bySha.get(commit); c && line.length < bySha.size; c = bySha.get(c.parents[0])) line.push(c);
  const numbers = [...new Set(line.map((c) => prNumberOf(c.subject)).filter((n) => n !== null))].sort((a, b) => a - b);
  let notShipped = null;
  const prs = [];
  for (const number of numbers) {
    let pr;
    try {
      pr = await github.getPull(repo, number);
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
      continue;
    }
    if (!pr || !pr.merged_at || isMergeBack(pr, repo)) continue;
    const { changelog, updateNeeds } = changelogLinesOf(pr);
    if (!changelog) continue;
    if (notShipped === null) notShipped = await notShippedAt({
        github, repo, commit, loaded,
      });
    if ((await prShipsNothing(github, repo, number, notShipped)).shipsNothing) continue;
    prs.push({ number, changelog, updateNeeds });
  }
  return { prs, status: range.status };
}

// The repo's patterns of paths that ship nothing, from its config at the commit (`.github/shipyard.yml` or
// `.github/release.json`, read through the loader), as the release reads them. `loaded` is the config the caller already
// read at this commit; with none it is read here. A repo with neither file lists nothing.
async function notShippedAt({
  github, repo, commit, loaded = null,
}) {
  try {
    const found = loaded || await loadReaderConfig({ github, repo, ref: commit });
    return notShippedOf(found.config, found.file || '.github/release.json');
  } catch (e) {
    if (e instanceof GitHubError) throw e;
    throw new ReleaseError(`${e.message} (at ${short(commit)}), so the prerelease's changes cannot be listed`);
  }
}

/**
 * The prerelease's body: the PRs since the newest release, each with its `Changelog:` line, its link and its
 * `Update-Needs:` line, written as the CHANGELOG writes them (lib/changelog.js `changelogItem`). With none, it
 * says the prerelease has no user-facing changes since the newest release.
 */
async function prereleaseBody({
  github, repo, newest, commit, loaded,
}) {
  if (!newest) return 'This prerelease comes before the first release, so there is no release to list its changes since.\n';
  const { prs, status } = await changesSince({
    github, repo, newest, commit, loaded,
  });
  if (status !== 'ahead' && status !== 'identical') {
    return `${newest}, the newest release, is not in the history of this prerelease's commit (its merge back may not have merged yet), so its changes since that release cannot be listed.\n`;
  }
  if (!prs.length) return `This prerelease has no user-facing changes since ${newest}.\n`;
  return `## Changes since ${newest}\n\n${prs.map(changelogItem).join('\n')}\n`;
}

/**
 * The GitHub Release at the prerelease tag, marked as a prerelease and never "latest". Its body is `body`
 * (`prereleaseBody`); its title `<product> <version>`. With `assets` it is made as a draft, gets each file and
 * is published, as a release's is (lib/tag.js). One that is published is left as it is. Returns
 * `{ action, url, files?, uploaded? }`.
 */
async function makePrereleaseRelease({
  github, releaser, repo, tag, body, title, assets = null,
}) {
  const found = await github.getRelease(repo, tag);
  if (found) return { action: 'exists', url: found.url };
  let draft = assets ? await draftOf(releaser, repo, tag) : null;
  if (!draft) {
    try {
      draft = await releaser.createRelease(repo, {
        tag, name: title, body, prerelease: true, draft: Boolean(assets), makeLatest: 'false',
      });
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 422) throw e;
      const now = await github.getRelease(repo, tag);
      if (now) return { action: 'exists', url: now.url };
      draft = assets ? await draftOf(releaser, repo, tag) : null;
      if (!draft) throw e;
    }
    if (!assets) return { action: 'created', url: draft.url };
  }
  const uploaded = await attachFiles({
    releaser, repo, draft, assets,
  });
  const published = await releaser.publishRelease(repo, draft.id, { makeLatest: 'false' });
  return {
    action: 'created', url: published.url, files: assets.map((f) => f.name), uploaded,
  };
}

module.exports = {
  KINDS, parsePrereleaseTag, parseVersion, checkKind, checkTeam, checkBranch, nextPrerelease, checkStarter, checkCommit, planPrerelease, resolveExpected, makeTag, makePrereleaseRelease, prereleaseBody, messageOf, show, short,
};
