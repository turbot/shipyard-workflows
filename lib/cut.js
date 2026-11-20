'use strict';

// The cut: the next version number, the release branch at the commit the facts read, the
// CHANGELOG section committed on it (the one file it changes), and the artifact the fleet's
// release-PR hook reads. The commit is made through GitHub's API (lib/api-commit.js), so GitHub signs
// it: the cut runs no local commit and no push, and leaves the checkout as it found it. It never
// opens the PR: the hook holds the token that does, and the branch it is handed is the one made here.

const fs = require('node:fs');
const path = require('node:path');
const { checkFacts } = require('./lint-prep');
const {
  ReleaseError, Refusal, WORK_BRANCH_TRAILER, isBranchName, git, newestReleaseTag, parseTag, bump, resolveCommit, isAncestor, lineOf,
} = require('./release-git');
const {
  buildSection, insertSection, changelogSection, renderReleaseNotes, renderPrBody, renderLightPrBody, assertPrepPasses, headingFor,
} = require('./changelog');
const { firstReleaseOf, firstReleaseCommit, factsFirstRelease } = require('./first-release');
const {
  FILE: RESHIP_FILE, waitingRelease, failedRunFromWorkflows, reshipFile, reshipEntryOfFile, parseFixes, describeFix,
} = require('./reship');
const { readReleaseConfig } = require('./start-config');
const { releasePulls } = require('./start');
const { announceCalled } = require('./announce-called');
const { tagSignal } = require('./tag-signal');
const { lightVersion } = require('./light');
const { personNamesOf } = require('./deploy-rows');
const { evidence, nextNumber } = require('./next-number');
const {
  textEntry, treeOf, commitChain, placeBranch, entriesBetween,
} = require('./api-commit');
const {
  FORMAT: RELEASE_DATA_FORMAT, DATA_TRAILER, encodeReleaseData, checkBlockSize, withReleaseData, readReleaseInputs, commitsFromGit,
} = require('./release-data');

const ARTIFACT_FORMAT = 1;
const CHANGELOG = 'CHANGELOG.md';

// What the facts must hold for a cut, on top of what `lint-prep` reads. Returns the release tag the
// range starts at, or, for a first release (lib/first-release.js), `{ first }` with no tag.
function checkRange(facts) {
  const r = facts.range;
  if (!r || typeof r.from !== 'string' || !/^[0-9a-f]{40}$/.test(String(r.to)) || !/^[0-9a-f]{40}$/.test(String(r.fromCommit))
    || typeof facts.tagPrefix !== 'string') {
    throw new ReleaseError('the facts have no range (from, fromCommit, to) or tagPrefix: make them again with `shipyard facts`');
  }
  if (!/^[A-Za-z0-9._-]*$/.test(facts.tagPrefix) || facts.tagPrefix.includes('..')) {
    throw new ReleaseError(`the facts' tagPrefix ${JSON.stringify(facts.tagPrefix)} is not a name a release folder can have`);
  }
  const first = factsFirstRelease(facts);
  if (first) return { tag: null, parts: null, first };
  const tag = parseTag(r.from, facts.tagPrefix);
  if (!tag) throw new ReleaseError(`the facts' range starts at ${r.from}, which is not a release tag (${facts.tagPrefix}X.Y.Z)`);
  return { ...tag, first: null };
}

// A release is cut from the working branch: the commit the facts read must be in the history of `within`,
// the commit the run started from (a light cut: the working branch's fetched tip). A commit of another branch is refused before anything is made.
function checkWithin({ dir, cutFrom, within }) {
  if (!within) return;
  const at = resolveCommit(dir, within);
  if (!isAncestor(dir, cutFrom, at)) {
    throw new Refusal(`the release was cut from ${cutFrom.slice(0, 7)}, which is not in the history of ${within}: a release is cut from the working branch`);
  }
}

// The range the facts read still starts where the shared rule starts it now, at the commit they end
// at: the same newest tag, or, for a first release, still no release tag and the same `firstRelease`
// in the repo's `.github/release.json` there. Throws a Refusal naming what moved.
function checkRangeStart({ dir, facts, start, toSha }) {
  const newest = newestReleaseTag(dir, facts.tagPrefix);
  if (start.first) {
    if (newest) throw new Refusal(`the facts are for a first release from ${facts.range.from}, but ${newest.tag} is a release tag now: make the facts again`);
    const named = firstReleaseOf(readReleaseConfig(dir, toSha));
    if (!named || named.from !== start.first.from || named.version !== start.first.version) {
      throw new Refusal(`the facts' first release (${start.first.version} from ${start.first.from}) is not the firstRelease in .github/release.json at ${toSha.slice(0, 7)}: make the facts again`);
    }
    if (firstReleaseCommit(dir, start.first.from) !== facts.range.fromCommit) {
      throw new Refusal(`${start.first.from} no longer points where the facts read it: make the facts again`);
    }
    return;
  }
  if (resolveCommit(dir, `refs/tags/${start.tag}`) !== facts.range.fromCommit) {
    throw new Refusal(`${start.tag} no longer points where the facts read it: make the facts again`);
  }
  if (newest.tag !== start.tag) {
    throw new Refusal(`the facts start at ${start.tag}, but ${newest.tag} is newer: make the facts again`);
  }
}

// A patch is started by hand on the work branch its fixes merged into, where the newest caller lives, and goes into a
// release line. The work branch is recorded as `Release-From`, so the merge-back after the tag goes there.
function checkPatchStart({ patch, workBranch, base }) {
  if (!workBranch) throw new Refusal('a patch is started on the work branch its fixes merged into, and this run started on none (a tag): start it on the work branch');
  if (lineOf(workBranch) !== null) throw new Refusal(`a patch is started on the work branch its fixes merged into, not on ${workBranch}, a release branch: start it on ${patch.workBranch}`);
  if (workBranch !== patch.workBranch) throw new Refusal(`the facts are a patch of fixes on ${patch.workBranch}, but this run started on ${workBranch}: start it on ${patch.workBranch}`);
  if (lineOf(base) === null) throw new Refusal(`a patch goes into the production tag's branch (main, or main-<x.y>), not ${base}`);
}

// The commit is the tip of `base`, not just a commit in its history: a patch or a re-ship is cut from the tip of the
// release line, read from `origin/<base>` (or the local branch when there is no remote one).
function checkBaseTip({ dir, base, toSha, what }) {
  const tipRef = ['refs/remotes/origin/', 'refs/heads/'].find((p) => git(dir, ['rev-parse', '--verify', '--quiet', `${p}${base}^{commit}`], { allowFail: true }));
  if (!tipRef) throw new ReleaseError(`${base} is not in the checkout: fetch it first`);
  const baseTip = resolveCommit(dir, `${tipRef}${base}`);
  if (baseTip !== toSha) throw new Refusal(`${toSha.slice(0, 7)} is not the tip of ${base} (${baseTip.slice(0, 7)}): cut ${what} from the tip of ${base}`);
}

// A patch takes the next number after the production tag, so a candidate in flight, open or merged and waiting for its
// tag, would ship beside it or be passed by it: the patch waits for it, as a start does (lib/start.js, releasePulls).
const WAITING_MS = 14 * 24 * 60 * 60 * 1000;
async function checkNoCandidate({ dir, github, repo, tagPrefix, now }) {
  const tags = git(dir, ['tag', '--list']).split('\n').map((t) => t.trim()).filter(Boolean);
  const { open, awaitingTag } = await releasePulls(github, repo, { tagPrefix, tags, sinceMs: now() - WAITING_MS });
  if (open.length) throw new Refusal(`the candidate #${open[0].number} (${open[0].head.ref}) is open: a patch waits until it merges and is tagged, or closes`);
  if (awaitingTag.length) throw new Refusal(`the candidate #${awaitingTag[0].number} (${awaitingTag[0].head.ref}) merged and waits for its tag: a patch waits until it is tagged (or re-ship it)`);
}

/**
 * @param {object} opts
 * @param {string} opts.dir     the product repo's checkout (its working tree is never read or changed)
 * @param {object} opts.facts
 * @param {object} opts.prep
 * @param {object} opts.github  lib/github.js client
 * @param {string} opts.out     where the release-pr artifact goes
 * @param {string} [opts.base]  the branch the release PR goes into (`main`)
 * @param {string} [opts.workBranch] the work branch this cut started from (`develop`), recorded on
 *                              the cut commit so the merge-back after the tag knows where to go
 * @param {string} opts.date    YYYY-MM-DD
 * @param {string} [opts.changelogFile] the product's changelog, relative to the repo (`CHANGELOG.md`)
 * @param {string} [opts.within] a ref the commit the facts read must be in the history of (the commit the run
 *                              started from; a light cut's, the working branch's fetched tip): a release is cut from the working branch, never from another
 *
 * A patch (facts with `patch`, from `shipyard facts --fixes`) is cut from the tip of `base` (`main`, `main-<x.y>`) in
 * place of the working branch: the commit the facts read must be that tip, the run must have started on the work branch
 * the facts name (it is recorded as `Release-From`, so the merge-back goes there), no other candidate may be open or
 * waiting for its tag, and the fixes are checked and picked onto the branch after the cut commit, as a re-ship's are.
 */
async function cut({
  dir, facts, prep, github, out, base = 'main', date, changelogFile = CHANGELOG, workBranch = null, within = null, now = Date.now,
}) {
  if (path.isAbsolute(changelogFile) || changelogFile.split(/[\\/]/).includes('..') || /^-|[\r\n]/.test(changelogFile)) {
    throw new ReleaseError(`--changelog must be a path inside the repo, not ${JSON.stringify(changelogFile)}`);
  }
  if (workBranch !== null && !isBranchName(workBranch)) {
    throw new ReleaseError(`--work-branch must be a branch name, not ${JSON.stringify(String(workBranch).slice(0, 80))}`);
  }
  checkFacts(facts);
  const fromTag = checkRange(facts);
  // An urgent fix is checked to be a patch from the facts, which say so (`patch`).
  assertPrepPasses(facts, prep);
  const repo = facts.repo.name;
  const prefix = facts.tagPrefix;
  const patch = facts.patch || null;
  if (patch) checkPatchStart({ patch, workBranch, base });

  // The cut reads git's copy of the commit and writes nothing in the checkout, so what is in the
  // working tree (changes, the facts, the artifact) is no concern of it.
  const toSha = resolveCommit(dir, facts.range.to);
  checkRangeStart({ dir, facts, start: fromTag, toSha });
  if (!isAncestor(dir, facts.range.fromCommit, toSha)) throw new Refusal(`${facts.range.from} is not in the history of ${toSha.slice(0, 7)}`);
  // A patch is cut from the tip of the production tag's branch, which is not the working branch: it is checked against
  // that tip, in place of `within`.
  if (patch) checkBaseTip({ dir, base, toSha, what: 'a patch' });
  else checkWithin({ dir, cutFrom: toSha, within });
  if (patch) await checkNoCandidate({ dir, github, repo, tagPrefix: prefix, now });

  // A first release's number is set by the repo; any other is the newest tag plus the prep run's level, then the next
  // patch while that number is used (lib/next-number.js): a cut uses up its number.
  const { version, skipped } = await nextNumber({
    start: fromTag.first ? fromTag.first.version.split('.').map(Number) : bump(fromTag.parts, prep.level.bump),
    tagPrefix: prefix,
    look: evidence({ dir, github, repo }),
    fixed: Boolean(fromTag.first),
  });
  const tag = `${prefix}${version}`;
  const branch = `release/${version}`;

  // A patch's fixes are checked before anything is made: on the work branch, merged by a PR, no workflow file.
  const picks = patch ? await checkFixes({
    dir, github, repo, shas: patch.fixes.map((f) => f.commit), workBranch, toSha, branch, what: 'patch', changelogFile, tag,
  }) : [];

  // Everything that can fail on its own is made before git moves.
  const section = buildSection({ facts, prep, version, date });
  const changelogBefore = git(dir, ['show', `${toSha}:${changelogFile}`], { allowFail: true });
  const changelog = insertSection(changelogBefore, section.text, version);
  const notes = renderReleaseNotes(prep.notes);
  // The facts, the prep file and the notes ride in the release PR's body (lib/release-data.js), pinned by the
  // commit's `Release-Data` trailer; the commit itself changes the CHANGELOG alone.
  const data = encodeReleaseData({
    format: RELEASE_DATA_FORMAT, tag, profile: 'full', facts, prep, notes, reships: [],
  });
  checkBlockSize(data.block, facts.prs.length);
  const body = withReleaseData(renderPrBody({
    tag, facts, prep, releaseBody: section.text, releaseNotes: notes, base, workBranch, announces: announceCalled(dir, toSha), shipSignal: tagSignal(dir, toSha), names: await personNamesOf({ github, report: prep.report, refuse: true }),
  }), data.block);

  // The trailers carry what the release check reads back: the prep run's level, and the
  // facts' breaking signs (a candidate with any must have release notes).
  const trailers = [`Release-Level: ${prep.level.bump}`];
  const breaking = (facts.breaking || []).map((b) => b && b.id).filter(Boolean);
  if (breaking.length) trailers.push(`Release-Breaking: ${breaking.join(', ')}`);
  // The work branch the candidate came from: `shipyard merge-back` reads it after the tag.
  if (workBranch) trailers.push(`${WORK_BRANCH_TRAILER}: ${workBranch}`);
  if (patch) trailers.push(`Release-Patch: ${picks.map((p) => `#${p.pull.number}`).join(', ')}`);
  trailers.push(`${DATA_TRAILER}: ${data.digest}`);
  const patchNote = patch
    ? ` A patch of ${base}: the fix${picks.length === 1 ? ' is a commit' : `es are ${picks.length} commits`} of ${workBranch}, reviewed there and cherry-picked onto this branch after this commit: ${picks.map((p) => `#${p.pull.number}`).join(', ')}.`
    : '';
  const message = [
    `chore(release): ${tag}`,
    `The ${version} section of ${changelogFile}, cut from ${facts.range.from}..${toSha.slice(0, 7)}. The facts, the prep file and the release notes it was made from are in the release PR's body.${patchNote}`,
    trailers.join('\n'),
  ].join('\n\n').concat('\n');
  const entries = [textEntry(changelogFile, changelog)];
  // A patch's fixes are worked out in git, in memory, before anything is made: one that does not apply stops the cut.
  const pickSteps = picks.length ? await pickFixes({
    dir, github, repo, toSha, picks, base,
  }) : [];
  // The commit is made by the API, and the branch is made last: a refusal at any step leaves no branch and no artifact.
  // A cut only ever makes a new branch: one that appeared since the number was read is refused, never replaced.
  const { commit } = await commitChain({
    github, repo, parent: toSha, baseTree: treeOf(dir, toSha), steps: [{ message, entries }, ...pickSteps],
  });
  await placeBranch({
    github, repo, dir, branch, commit, replace: false,
  });

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'body.md'), body);
  const artifact = {
    format: ARTIFACT_FORMAT,
    repo,
    version,
    tag,
    branch,
    base,
    commit,
    cutFrom: toSha,
    title: `Release ${tag}`,
    bodyFile: 'body.md',
    changelog: changelogFile,
    // Always null: the release notes are in the body's release-data block, not a file of the candidate.
    releaseNotes: null,
    skipped,
    workBranch,
    ...(patch ? { patch: { fixes: picks.map((p) => ({ commit: p.sha, pr: p.pull.number })) } } : {}),
  };
  fs.writeFileSync(path.join(out, 'release-pr.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  // The four files the fleet's release-PR hook reads: `branch`, `sha`, `title` and `body.md`. Each
  // is one value with no newline after it; `sha` is the branch's tip.
  fs.writeFileSync(path.join(out, 'branch'), branch);
  fs.writeFileSync(path.join(out, 'sha'), commit);
  fs.writeFileSync(path.join(out, 'title'), artifact.title);
  return { artifact, section };
}

/**
 * The cut of a light release (lib/light.js): the same branch, number check and artifact as `cut`, with no prep file, no
 * CHANGELOG section and no release notes. The version is the day's: `<year>.<MDD>.<n>`. Its one commit changes no file: the
 * facts, which the record, the ask and the tag step read the merged PRs from, ride in the release PR's body (lib/release-data.js).
 *
 * @param {object} opts  as `cut`, without `prep` and `changelogFile`; the commit is made through the API, so the checkout is never written to
 * @param {string} opts.date `YYYY-MM-DD`, UTC: the day the release is cut, which makes its version
 */
async function cutLight({
  dir, facts, github, out, base = 'main', date, workBranch = null, within = null,
}) {
  if (workBranch !== null && !isBranchName(workBranch)) {
    throw new ReleaseError(`--work-branch must be a branch name, not ${JSON.stringify(String(workBranch).slice(0, 80))}`);
  }
  checkFacts(facts);
  if (facts.profile !== 'light') throw new ReleaseError('the facts are not a light release\'s: they do not say `"profile": "light"`');
  const fromTag = checkRange(facts);
  if (!facts.prs.length && !(facts.unattributed || []).length) throw new Refusal(`nothing to release: no merged change since ${facts.range.from}`);
  const repo = facts.repo.name;
  const prefix = facts.tagPrefix;
  const toSha = resolveCommit(dir, facts.range.to);
  checkRangeStart({ dir, facts, start: fromTag, toSha });
  if (!isAncestor(dir, facts.range.fromCommit, toSha)) throw new Refusal(`${facts.range.from} is not in the history of ${toSha.slice(0, 7)}`);
  checkWithin({ dir, cutFrom: toSha, within });

  const tags = git(dir, ['tag', '--list']).split('\n').map((t) => t.trim()).filter(Boolean);
  // A release branch of the day already made counts as a tag does, so the count starts past it. From there the count goes
  // on while the number is used (lib/next-number.js), as a full cut's patch does: a candidate that closed, or one that merged
  // and was never tagged (its deployment failed), whose branch GitHub deleted, is found by its PR.
  const made = git(dir, ['for-each-ref', '--format=%(refname)', 'refs/heads/', 'refs/remotes/']).split('\n')
    .map((r) => /^refs\/(?:heads|remotes\/[^/]+)\/release\/(\d+\.\d+\.\d+)$/.exec(r.trim())).filter(Boolean).map((m) => `${prefix}${m[1]}`);
  const { version, skipped } = await nextNumber({
    start: lightVersion({ tags: [...tags, ...made], tagPrefix: prefix, date }).parts,
    tagPrefix: prefix,
    look: evidence({ dir, github, repo }),
    waitingIsUsed: true,
  });
  const tag = `${prefix}${version}`;
  const branch = `release/${version}`;

  const data = encodeReleaseData({
    format: RELEASE_DATA_FORMAT, tag, profile: 'light', facts, prep: null, notes: null, reships: [],
  });
  checkBlockSize(data.block, facts.prs.length);
  const body = withReleaseData(renderLightPrBody({
    tag, facts, base, workBranch, announces: announceCalled(dir, toSha),
  }), data.block);

  const trailers = ['Release-Profile: light'];
  if (workBranch) trailers.push(`${WORK_BRANCH_TRAILER}: ${workBranch}`);
  trailers.push(`${DATA_TRAILER}: ${data.digest}`);
  const message = [
    `chore(release): ${tag}`,
    `The merged changes of the light release ${version}, cut from ${facts.range.from}..${toSha.slice(0, 7)}: the release PR's body holds the list the release PR and the GitHub Release show. A light release has no prep file, CHANGELOG section or release notes, and this commit changes no file.`,
    trailers.join('\n'),
  ].join('\n\n').concat('\n');
  // The commit is made by the API, and the branch is made last: a refusal at any step leaves no branch and no artifact.
  const { commit } = await commitChain({
    github, repo, parent: toSha, baseTree: treeOf(dir, toSha), steps: [{ message, entries: [] }],
  });
  await placeBranch({
    github, repo, dir, branch, commit, replace: false,
  });

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'body.md'), body);
  const artifact = {
    format: ARTIFACT_FORMAT,
    profile: 'light',
    repo,
    version,
    tag,
    branch,
    base,
    commit,
    cutFrom: toSha,
    title: `Release ${tag}`,
    bodyFile: 'body.md',
    changelog: null,
    releaseNotes: null,
    skipped,
    workBranch,
  };
  fs.writeFileSync(path.join(out, 'release-pr.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'branch'), branch);
  fs.writeFileSync(path.join(out, 'sha'), commit);
  fs.writeFileSync(path.join(out, 'title'), artifact.title);
  return { artifact };
}

// The `Release-From` trailer of a commit's message, or null.
function workBranchOfMessage(message) {
  const m = new RegExp(`^${WORK_BRANCH_TRAILER}:[ \\t]*(\\S+)[ \\t]*$`, 'm').exec(String(message));
  return m && isBranchName(m[1]) ? m[1] : null;
}

/**
 * Each fix commit, checked before anything is made: a full commit id the checkout holds, on the working
 * branch, not already in the base's tip, and the merge commit of a merged PR of this repo (the review the
 * release record shows). Returns `[{ sha, merge, pull }]` in the order given, or a Refusal naming the
 * first commit that fails; a fix that changes a file under `.github/workflows/` is refused last, all of
 * them named (`refuseWorkflowFixes`).
 */
async function checkFixes({
  dir, github, repo, shas, workBranch, toSha, branch, what = 're-ship', changelogFile = null, tag = null,
}) {
  if (!shas.length) return [];
  const ref = ['refs/remotes/origin/', 'refs/heads/'].find((p) => git(dir, ['rev-parse', '--verify', '--quiet', `${p}${workBranch}^{commit}`], { allowFail: true }));
  if (!ref) throw new ReleaseError(`the working branch ${workBranch} is not in the checkout: fetch it first`);
  const tip = `${ref}${workBranch}`;
  const picks = [];
  for (const sha of shas) {
    if (git(dir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }) === null) throw new Refusal(`${sha} is not a commit in this checkout: fix commits are commits of ${workBranch}`);
    if (!isAncestor(dir, sha, tip)) throw new Refusal(`${sha} is not on ${workBranch}: a fix is reviewed there first, so merge its PR into ${workBranch} and name the merge commit`);
    if (isAncestor(dir, sha, toSha)) throw new Refusal(`${sha} is already in ${toSha.slice(0, 7)}, the tip of the base: there is nothing to pick`);
    const pulls = (await github.listPullsOfCommit(repo, sha)).filter((p) => p && p.merged_at && p.merge_commit_sha === sha);
    if (pulls.length !== 1) throw new Refusal(`${sha} is not the merge commit of a merged pull request of ${repo}: a fix is a commit that came by a reviewed PR`);
    const parents = git(dir, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ').length - 1;
    picks.push({ sha, merge: parents > 1, pull: pulls[0] });
  }
  refuseWorkflowFixes({ dir, picks, branch, what });
  // A patch's cut commit writes the changelog's section before the picks (its only file: the facts, prep file and notes
  // ride in the release PR's body): a fix that changes the changelog would be picked over it, so it is refused, named,
  // before anything is made.
  if (changelogFile && tag) {
    for (const p of picks) {
      const clash = git(dir, ['diff', '--name-only', '--no-renames', '-z', `${p.sha}^`, p.sha]).split('\0')
        .filter((f) => f === changelogFile);
      if (clash.length) throw new Refusal(`${p.sha} (#${p.pull.number}) changes ${clash.join(', ')}, which the cut writes for ${tag}: a fix leaves it to the cut. Nothing was written`);
    }
  }
  return picks;
}

const WORKFLOWS_DIR = '.github/workflows/';

// The files a fix changes under `.github/workflows/`, as the cherry-pick would change them: against the
// first parent, which is the parent a merge commit is picked onto (`-m 1`). Renames are listed as a delete
// and an add, so a workflow file moved out of the folder is seen too.
function workflowFilesOf(dir, sha) {
  const out = git(dir, ['diff', '--name-only', '--no-renames', '-z', `${sha}^`, sha]);
  return out.split('\0').filter((f) => f.startsWith(WORKFLOWS_DIR));
}

// The cut writes `release/<version>` through the API with the job's own token, and GitHub refuses a commit from
// that token when it changes a file under `.github/workflows/` (it cannot be given the `workflows` permission).
// A cherry-picked fix is such a new commit, so it is refused here, before anything is made, with the steps a
// person takes in its place.
function refuseWorkflowFixes({ dir, picks, branch, what = 're-ship' }) {
  const found = picks.map((p) => ({ pick: p, files: workflowFilesOf(dir, p.sha) })).filter((f) => f.files.length);
  if (!found.length) return;
  const list = found.map(({ pick, files }) => `${pick.sha} (#${pick.pull.number}) changes ${files.join(', ')}`).join('; ');
  const noun = found.length === 1 ? 'a fix changes' : 'fixes change';
  const picksText = found.map(({ pick }) => `\`git cherry-pick -x ${pick.merge ? '-m 1 ' : ''}${pick.sha}\``).join(' and then ');
  throw new Refusal(
    `${noun} a file under ${WORKFLOWS_DIR}: ${list}. The cut writes ${branch} with the job's own token, and GitHub refuses a commit from that token that changes a workflow file, so the cut stops before it writes. Nothing was written. `
    + `Do this by hand: cut the ${what} again with the other fixes${what === 'patch' ? ' (a patch takes at least one)' : ', or none'}; then on ${branch} run ${picksText} and push ${found.length === 1 ? 'it' : 'them'}. `
    + 'The release record names the fix as it does a PR into the branch.',
  );
}

// The scratch identity of the commits git needs to work out a pick: they are made in the checkout's own object
// store with no ref, never pushed, and replaced by the commits the API makes.
const SCRATCH = {
  GIT_AUTHOR_NAME: 'shipyard', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'shipyard', GIT_COMMITTER_EMAIL: '',
};

/**
 * Each fix as a step for `commitChain`, as `git cherry-pick -x` would make it: its original's change over its own
 * first parent (a merge commit is read as what it brought in), merged into the commit before it, with its message and
 * a `(cherry picked from commit <sha>)` line. The merge is git's (`merge-tree`), made in memory: no branch and no
 * commit of this checkout moves. A pick that does not apply is a Refusal naming it.
 */
async function pickFixes({
  dir, github, repo, toSha, picks, base,
}) {
  // Every pick is worked out before any blob is uploaded, so a pick that fails writes nothing at all.
  const worked = [];
  let ours = toSha;
  for (const pick of picks) {
    let tree;
    try {
      tree = git(dir, ['merge-tree', '--write-tree', `--merge-base=${pick.sha}^1`, ours, pick.sha]).split('\n')[0].trim();
    } catch (e) {
      throw new Refusal(`${pick.sha} (#${pick.pull.number}) does not apply on ${toSha.slice(0, 7)}, the tip of ${base}, with the fixes before it: ${String(e.message).replace(/^git merge-tree failed: ?/, '').slice(0, 200) || 'it conflicts'}. Nothing was written`);
    }
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new ReleaseError(`git merge-tree answered something that is not a tree for ${pick.sha}`);
    const message = git(dir, ['log', '-1', '--format=%B', pick.sha]).trimEnd();
    worked.push({ message: `${message}\n\n(cherry picked from commit ${pick.sha})\n`, from: treeOf(dir, ours), to: tree });
    // Not a commit of the checkout's history: a loose object, so the next pick merges into this one.
    ours = git(dir, ['commit-tree', tree, '-p', ours, '-m', `pick ${pick.sha}`], { env: SCRATCH }).trim();
  }
  const steps = [];
  for (const w of worked) {
    steps.push({
      message: w.message,
      entries: await entriesBetween({
        dir, github, repo, from: w.from, to: w.to,
      }),
    });
  }
  return steps;
}

/**
 * The re-ship cut (lib/reship.js): `release/<version>` again, at the checkout's HEAD (the tip of the
 * base the version merged into), for a version whose release PR merged and whose ship run failed. It
 * makes no facts and asks no prep run: the version is the one that merged, with its CHANGELOG section on
 * the base and its facts, prep file and notes in the release data of the merged release PR's body
 * (lib/release-data.js), or, for a version cut before that, in `releases/<tag>/` on the base. One commit
 * changes no file; the new release PR's body carries the same release data with this re-ship added to
 * its `reships`, and the commit's `Release-Data` trailer pins it.
 *
 * @param {object} opts
 * @param {string} opts.dir        the product repo's checkout at the base's tip (refused when it is not), with its tags (its working tree is never read or changed)
 * @param {string} opts.version    the version that waits for its tag (`0.1.26`)
 * @param {string} opts.tagPrefix  the prefix of the repo's release tags
 * @param {object} opts.github     lib/github.js client
 * @param {string} opts.out        where the release-pr artifact goes
 * @param {string} [opts.repo]     `<owner>/<name>`; when left out, the version's facts in `releases/<tag>/` name it, and
 *                                 a version whose release data is in its PR's body is refused (the PR is found by the repo)
 * @param {string} [opts.changelogFile]
 * @param {string[]|string} [opts.fixes] full commit ids of the working branch, cherry-picked in order onto
 *                                 the new branch after the re-ship commit: each must be on `runBranch` and
 *                                 be the merge commit of a merged PR, and none may be in the base already
 * @param {string} [opts.runBranch] the working branch the run started on; needed with `fixes`
 */
async function reshipCut({
  dir, version, tagPrefix = 'v', github, out, repo = null, changelogFile = CHANGELOG, fixes = [], runBranch = null, warn = () => {},
}) {
  const fixShas = Array.isArray(fixes) ? parseFixes(fixes.join(' ')) : parseFixes(fixes);
  if (fixShas.length && runBranch !== null && !isBranchName(runBranch)) {
    throw new ReleaseError(`--work-branch must be a branch name, not ${JSON.stringify(String(runBranch).slice(0, 80))}`);
  }
  if (fixShas.length && !runBranch) throw new Refusal('--fixes are commits of the working branch, and this run started on none (a tag): start the re-ship on the working branch');
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(String(version))) throw new ReleaseError(`--reship takes a version, X.Y.Z, not ${JSON.stringify(String(version).slice(0, 40))}`);
  if (!/^[A-Za-z0-9._-]*$/.test(tagPrefix) || tagPrefix.includes('..')) throw new ReleaseError(`--tag-prefix ${JSON.stringify(tagPrefix)} is not a tag prefix`);
  if (path.isAbsolute(changelogFile) || changelogFile.split(/[\\/]/).includes('..') || /^-|[\r\n]/.test(changelogFile)) {
    throw new ReleaseError(`--changelog must be a path inside the repo, not ${JSON.stringify(changelogFile)}`);
  }
  const tag = `${tagPrefix}${version}`;
  const toSha = resolveCommit(dir, 'HEAD');
  const short = toSha.slice(0, 7);
  const read = (p) => git(dir, ['show', `${toSha}:${p}`], { allowFail: true });
  const folder = `releases/${tag}`;
  // The repo the release PR is found in: the one named, or the one a version cut before the release data moved
  // to the PR's body names in its facts on the base.
  let name = repo;
  if (!name) {
    const folderFacts = read(`${folder}/facts.json`);
    try {
      name = folderFacts === null ? null : JSON.parse(folderFacts).repo.name;
    } catch {
      throw new ReleaseError(`${folder}/facts.json at ${short} is not valid JSON`);
    }
    if (typeof name !== 'string' || !name) throw new Refusal(`--repo is needed: ${short} has no ${folder}/facts.json to name the repo, and ${tag}'s release PR, which holds its release data, is found by it`);
  }

  // The number is the waiting one: merged, never tagged, and its ship run failed.
  const release = await waitingRelease({
    github, repo: name, tagPrefix, version, tagged: Boolean(git(dir, ['tag', '--list', tag]).trim()),
  });
  if (!isAncestor(dir, release.mergeCommit, toSha)) {
    throw new Refusal(`${short} does not contain ${release.mergeCommit.slice(0, 7)}, the merge of #${release.pr}: cut the re-ship from the tip of ${release.base}`);
  }
  // The commit is the base's tip, not just a commit in its history: a release is cut from the tip the version
  // merged into, and an older commit that is in its history would be cut from the wrong files.
  const tipRef = ['refs/remotes/origin/', 'refs/heads/'].find((p) => git(dir, ['rev-parse', '--verify', '--quiet', `${p}${release.base}^{commit}`], { allowFail: true }));
  if (!tipRef) throw new ReleaseError(`${release.base} is not in the checkout: fetch it first`);
  const baseTip = resolveCommit(dir, `${tipRef}${release.base}`);
  if (baseTip !== toSha) {
    throw new Refusal(`${short} is not the tip of ${release.base} (${baseTip.slice(0, 7)}): cut the re-ship from the tip of ${release.base}`);
  }

  // The version's facts, prep file and notes: from the release data in the merged release PR's body, checked against
  // the cut commit below its head (the PR's commits are in the base's history; GitHub is asked for one the checkout
  // lacks), or, for a version cut before that, from `releases/<tag>/` at the base's tip.
  const pr = await github.getPull(name, release.pr);
  const headSha = String((pr && pr.head && pr.head.sha) || '');
  if (!/^[0-9a-f]{40}$/.test(headSha)) throw new ReleaseError(`#${release.pr} has no head commit to read its release data from`);
  const fromGit = commitsFromGit(dir);
  const inputs = await readReleaseInputs({
    body: pr.body,
    tag,
    headSha,
    prNumber: release.pr,
    getCommit: (sha) => (git(dir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }) === null ? github.getCommit(name, sha) : fromGit(sha)),
    readFolderFile: (file) => read(`${folder}/${file}`),
  });
  const fromBody = inputs.source === 'body';
  const { facts, prep, notes } = inputs;
  if (fromBody && (inputs.profile !== 'full' || !prep || notes === null)) {
    throw new Refusal(`the release data in #${release.pr}'s body is a light release's (no prep file, CHANGELOG section or release notes): only a full release can be re-shipped`);
  }
  if (!fromBody && (facts === null || prep === null || notes === null)) {
    throw new Refusal(`${short} has no ${folder}/ from \`shipyard cut\` (facts.json, prep.json, release-notes.md), and #${release.pr}'s body has no release data: only a version Shipyard cut, and that merged, can be re-shipped`);
  }
  const factsWhere = fromBody ? `the facts in #${release.pr}'s release data` : `${folder}/facts.json`;
  const prepWhere = fromBody ? `the prep file in #${release.pr}'s release data` : `${folder}/prep.json at ${short}`;
  checkFacts(facts);
  if (facts.tagPrefix !== tagPrefix) throw new Refusal(`${factsWhere} ${fromBody ? 'are' : 'is'} for the tag prefix ${JSON.stringify(facts.tagPrefix)}, not ${JSON.stringify(tagPrefix)}`);
  // The body is written again by this Shipyard, and the record lints the prep file again: a prep file this version
  // refuses (format 1, written for an earlier Shipyard) is refused here, saying what to do, never part-way into the body.
  try {
    assertPrepPasses(facts, prep, { names: false });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    // The prep file of a merged version cannot be changed (the base takes only release PRs), so the way out is an older Shipyard.
    throw new Refusal(`${prepWhere} is one this Shipyard cannot write the body from: ${e.message}\nRe-ship ${version} with the last Shipyard release that reads its prep file, the one before the release whose CHANGELOG says format 1 is refused: point the repo's cut and record callers at that release for the re-ship, as the record lints it too, then move them back`);
  }
  if (facts.repo.name.toLowerCase() !== name.toLowerCase()) throw new Refusal(`${factsWhere} ${fromBody ? 'are' : 'is'} for ${facts.repo.name}, not ${name}`);
  const changelog = read(changelogFile);
  if (changelog === null || !headingFor(version).test(changelog)) {
    throw new Refusal(`${changelogFile} at ${short} has no section for ${version}: a re-ship finishes a version that is already written down`);
  }

  const picks = await checkFixes({
    dir, github, repo: name, shas: fixShas, workBranch: runBranch, toSha, branch: release.branch,
  });
  const run = await failedRunFromWorkflows({ github, repo: name, release });
  // The re-ships the version already had: the release data's list, or, for a version cut before it, the re-ship
  // files on the base. A run is re-shipped once.
  const reshipFiles = (git(dir, ['ls-tree', '--name-only', toSha, '--', `${folder}/`], { allowFail: true }) || '')
    .split('\n').map((l) => l.trim().slice(folder.length + 1)).filter((n) => RESHIP_FILE.test(n))
    .sort((a, b) => Number(RESHIP_FILE.exec(a)[1]) - Number(RESHIP_FILE.exec(b)[1]));
  if (reshipFiles.includes(`reship-${run.id}.json`)) throw new Refusal(`${folder}/reship-${run.id}.json already exists at ${short}: run ${run.id} has been re-shipped once`);
  const earlier = fromBody ? inputs.reships : reshipFiles.map((file) => reshipEntryOfFile(read(`${folder}/${file}`), { tag, name: file }));
  if (earlier.some((r) => r.failedRun.id === run.id)) throw new Refusal(`the release data in #${release.pr}'s body already names run ${run.id}: run ${run.id} has been re-shipped once`);

  // The work branch the version was cut from, for the merge-back: the first cut's `Release-From`, on the cut commit the
  // release data was read through, or, for a version cut before that, on the oldest commit that added its prep file.
  let workBranch;
  if (fromBody) {
    workBranch = workBranchOfMessage(inputs.cut.message);
  } else {
    const added = (git(dir, ['log', '--diff-filter=A', '--format=%H', toSha, '--', `${folder}/prep.json`], { allowFail: true }) || '')
      .split('\n').map((l) => l.trim()).filter(Boolean);
    const firstCut = added.pop();
    workBranch = firstCut ? workBranchOfMessage(git(dir, ['log', '-1', '--format=%B', firstCut])) : null;
  }

  const fixPrs = [];
  for (const pick of picks) fixPrs.push(await describeFix({ github, repo: name, pull: pick.pull }));
  const reship = {
    releasePr: release.pr, mergedAt: release.mergedAt, failedRun: run, fixes: fixPrs,
  };
  const entry = reshipFile({
    release, run, cutFrom: toSha, fixes: picks.map((p, i) => ({ commit: p.sha, pr: p.pull.number, title: fixPrs[i].title })),
  });
  // The first cut's release data, with every re-ship of the version, this one last: the tag reads them all.
  const data = encodeReleaseData({
    format: RELEASE_DATA_FORMAT, tag, profile: 'full', facts, prep, notes, reships: [...earlier, entry],
  });
  checkBlockSize(data.block, facts.prs.length);
  // The GitHub Release's text is the CHANGELOG section the base holds, as the tag step reads it at the merge. A re-ship is
  // for a release whose ship job broke, so its flow is the ship job's and no signal is read.
  const body = withReleaseData(renderPrBody({
    tag, facts, prep, releaseBody: changelogSection(changelog, version), releaseNotes: notes, base: release.base, workBranch, reship, announces: announceCalled(dir, toSha), names: await personNamesOf({ github, report: prep.report, warn }),
  }), data.block);

  const branch = release.branch;
  // The same trailers the version's first cut carried, so the release check reads the same level and
  // signs, and the merge-back goes to the same work branch; the PR this re-ships; and the release data.
  const trailers = [`Release-Level: ${prep.level && prep.level.bump}`];
  const breaking = (facts.breaking || []).map((b) => b && b.id).filter(Boolean);
  if (breaking.length) trailers.push(`Release-Breaking: ${breaking.join(', ')}`);
  if (workBranch) trailers.push(`${WORK_BRANCH_TRAILER}: ${workBranch}`);
  trailers.push(`Release-Reship: #${release.pr}`);
  trailers.push(`${DATA_TRAILER}: ${data.digest}`);
  const fixNote = picks.length
    ? `The fix is ${picks.length === 1 ? 'a commit' : `${picks.length} commits`} of ${runBranch}, reviewed there and cherry-picked onto this branch after this commit: ${picks.map((p) => `#${p.pull.number}`).join(', ')}.`
    : 'The fix comes as a PR into this branch, or as a commit a person cherry-picks onto it.';
  const reshipMessage = [
    `chore(release): ${tag}`,
    `Re-ship of ${version}: #${release.pr} merged as ${release.mergeCommit.slice(0, 7)} and its ship run ${run.id} failed, so ${tag} was never made. ${fixNote} This commit changes no file: the release PR's body names the re-ship, beside the facts, the prep file and the release notes of the version.`,
    trailers.join('\n'),
  ].join('\n\n').concat('\n');
  // The fixes are worked out here, in git, before anything is made: each is its original's change over the
  // commit before it, in the order given. One that conflicts stops the cut with nothing written to the remote.
  const baseTree = treeOf(dir, toSha);
  const pickSteps = await pickFixes({
    dir, github, repo: name, toSha, picks, base: release.base,
  });
  const { commit } = await commitChain({
    github,
    repo: name,
    parent: toSha,
    baseTree,
    steps: [{ message: reshipMessage, entries: [] }, ...pickSteps],
  });
  await placeBranch({
    github, repo: name, dir, branch, commit,
  });

  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'body.md'), body);
  const artifact = {
    format: ARTIFACT_FORMAT,
    repo: name,
    version,
    tag,
    branch,
    base: release.base,
    commit,
    cutFrom: toSha,
    title: `Release ${tag}`,
    bodyFile: 'body.md',
    changelog: changelogFile,
    // Always null: the release notes are in the body's release-data block, not a file of the candidate.
    releaseNotes: null,
    skipped: [],
    workBranch,
    reship: {
      releasePr: release.pr, failedRun: run, fixes: picks.map((p, i) => ({ commit: p.sha, pr: p.pull.number, title: fixPrs[i].title })),
    },
  };
  fs.writeFileSync(path.join(out, 'release-pr.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'branch'), branch);
  fs.writeFileSync(path.join(out, 'sha'), commit);
  fs.writeFileSync(path.join(out, 'title'), artifact.title);
  return { artifact };
}

module.exports = {
  reshipCut, cut, cutLight, checkRange, ARTIFACT_FORMAT,
};
