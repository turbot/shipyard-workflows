'use strict';

// The cut: the next version number, the release branch at the commit the facts read, the
// CHANGELOG section and the release notes committed on it, and the artifact the fleet's
// release-PR hook reads. The cut never pushes (`shipyard push` does) and never opens the PR: the
// hook holds the token that does, and the branch it is handed is the one made here.

const fs = require('node:fs');
const path = require('node:path');
const { checkFacts } = require('./lint-prep');
const {
  ReleaseError, Refusal, WORK_BRANCH_TRAILER, isBranchName, git, newestReleaseTag, parseTag, bump, formatVersion, resolveCommit, isAncestor,
} = require('./release-git');
const {
  buildSection, insertSection, changelogSection, renderReleaseNotes, renderPrBody, assertPrepPasses, headingFor,
} = require('./changelog');
const { firstReleaseOf, firstReleaseCommit, factsFirstRelease } = require('./first-release');
const {
  waitingRelease, failedRunFromWorkflows, reshipFile, reshipPath, parseFixes, describeFix,
} = require('./reship');
const { readReleaseConfig } = require('./start-config');
const { announceCalled } = require('./announce-called');

const ARTIFACT_FORMAT = 1;
const CHANGELOG = 'CHANGELOG.md';
// The facts and the prep file the candidate was cut from, kept on it so `shipyard record` reads
// the same ones each time it runs.
const INPUT_FILES = ['facts.json', 'prep.json'];

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

// A version number is free unless a tag has it, or a candidate for it is open or has merged and
// waits for its tag. A closed candidate that never merged, and so never got a tag, frees it.
async function checkNumberFree({ dir, github, repo, version, tag, branch }) {
  if (git(dir, ['tag', '--list', tag]).trim()) throw new Refusal(`${tag} is already a tag: ${version} is taken`);
  const candidates = await github.listPullsByHead(repo, branch);
  const open = candidates.find((p) => p.state === 'open');
  if (open) throw new Refusal(`${version} is taken: the candidate #${open.number} (${branch}) is open. Close it, or finish it, before cutting again`);
  // A branch name is shared by every product of the repo; a merged candidate that was cut
  // for another product's tag (its title says so) is that product's history, not this one's.
  const merged = candidates.find((p) => p.merged_at && p.title === `Release ${tag}`);
  if (merged) throw new Refusal(`${version} is taken: the candidate #${merged.number} (${branch}) merged and waits for its tag ${tag}`);
  // Any closed candidate (merged or not) explains a branch that is still on the remote; only an
  // unmerged one cut for this tag is the candidate this cut replaces.
  const closed = candidates.filter((p) => p.state === 'closed');
  const remote = git(dir, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`]).trim();
  if (remote && !closed.length) {
    throw new Refusal(`${version} is taken: ${branch} exists on a remote and no closed candidate owns it`);
  }
  const replaced = closed.filter((p) => !p.merged_at && p.title === `Release ${tag}`).map((p) => p.number).sort((a, b) => b - a);
  return replaced.length ? replaced[0] : null;
}

/**
 * @param {object} opts
 * @param {string} opts.dir     the product repo's checkout (clean)
 * @param {object} opts.facts
 * @param {object} opts.prep
 * @param {object} opts.github  lib/github.js client
 * @param {string} opts.out     where the release-pr artifact goes
 * @param {string} [opts.base]  the branch the release PR goes into (`main`)
 * @param {string} [opts.workBranch] the work branch this cut started from (`develop`), recorded on
 *                              the cut commit so the merge-back after the tag knows where to go
 * @param {string} opts.date    YYYY-MM-DD
 * @param {string} [opts.changelogFile] the product's changelog, relative to the repo (`CHANGELOG.md`)
 */
async function cut({
  dir, facts, prep, github, out, base = 'main', date, changelogFile = CHANGELOG, workBranch = null,
}) {
  if (path.isAbsolute(changelogFile) || changelogFile.split(/[\\/]/).includes('..') || /^-|[\r\n]/.test(changelogFile)) {
    throw new ReleaseError(`--changelog must be a path inside the repo, not ${JSON.stringify(changelogFile)}`);
  }
  if (workBranch !== null && !isBranchName(workBranch)) {
    throw new ReleaseError(`--work-branch must be a branch name, not ${JSON.stringify(String(workBranch).slice(0, 80))}`);
  }
  checkFacts(facts);
  const fromTag = checkRange(facts);
  assertPrepPasses(facts, prep);
  const repo = facts.repo.name;
  const prefix = facts.tagPrefix;

  // Untracked files are no harm (the facts and the artifact usually sit in the checkout); the
  // cut stages four paths of its own. A change to a tracked file, or a file already at any of
  // them, would be lost or overwritten.
  if (git(dir, ['status', '--porcelain', '--untracked-files=no']).trim()) {
    throw new ReleaseError('the checkout is not clean: the cut needs no changes to tracked files');
  }

  const toSha = resolveCommit(dir, facts.range.to);
  checkRangeStart({ dir, facts, start: fromTag, toSha });
  if (!isAncestor(dir, facts.range.fromCommit, toSha)) throw new Refusal(`${facts.range.from} is not in the history of ${toSha.slice(0, 7)}`);

  // A first release's number is set by the repo; any other is the newest tag plus the prep run's level.
  const version = fromTag.first ? fromTag.first.version : formatVersion(bump(fromTag.parts, prep.level.bump));
  const tag = `${prefix}${version}`;
  const branch = `release/${version}`;
  const replaces = await checkNumberFree({ dir, github, repo, version, tag, branch });

  // Everything that can fail on its own is made before git moves.
  const section = buildSection({ facts, prep, version, date });
  const changelogBefore = git(dir, ['show', `${toSha}:${changelogFile}`], { allowFail: true });
  const changelog = insertSection(changelogBefore, section.text, version);
  const notesPath = `releases/${tag}/release-notes.md`;
  const inputPaths = INPUT_FILES.map((f) => `releases/${tag}/${f}`);
  for (const p of [notesPath, ...inputPaths]) {
    if (git(dir, ['cat-file', '-e', `${toSha}:${p}`], { allowFail: true }) !== null) {
      throw new Refusal(`${p} already exists at ${toSha.slice(0, 7)}`);
    }
  }
  // An untracked file at any of these paths is somebody's work: never write over it.
  if (git(dir, ['status', '--porcelain', '--', changelogFile, notesPath, ...inputPaths]).trim()) {
    throw new ReleaseError(`a file is already at ${changelogFile} or in releases/${tag}/ in the checkout and is not part of ${toSha.slice(0, 7)}`);
  }
  const notes = renderReleaseNotes(prep.notes);
  const body = renderPrBody({
    tag, facts, prep, releaseBody: section.text, releaseNotes: notes, base, workBranch, announces: announceCalled(dir, toSha),
  });

  const startedOn = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const startedAt = startedOn === 'HEAD' ? git(dir, ['rev-parse', 'HEAD']).trim() : startedOn;
  git(dir, ['checkout', '-B', branch, toSha]);
  let commit;
  try {
    fs.mkdirSync(path.join(dir, 'releases', tag), { recursive: true });
    fs.mkdirSync(path.dirname(path.join(dir, changelogFile)), { recursive: true });
    fs.writeFileSync(path.join(dir, changelogFile), changelog);
    fs.writeFileSync(path.join(dir, notesPath), notes);
    fs.writeFileSync(path.join(dir, inputPaths[0]), `${JSON.stringify(facts, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, inputPaths[1]), `${JSON.stringify(prep, null, 2)}\n`);
    git(dir, ['add', '--', changelogFile, notesPath, ...inputPaths]);
    // The trailers carry what the release check reads back: the prep run's level, and the
    // facts' breaking signs (a candidate with any must have release notes).
    const trailers = [`Release-Level: ${prep.level.bump}`];
    const breaking = (facts.breaking || []).map((b) => b && b.id).filter(Boolean);
    if (breaking.length) trailers.push(`Release-Breaking: ${breaking.join(', ')}`);
    // The work branch the candidate came from: `shipyard merge-back` reads it after the tag.
    if (workBranch) trailers.push(`${WORK_BRANCH_TRAILER}: ${workBranch}`);
    git(dir, ['commit', '--quiet', '-m', `chore(release): ${tag}`, '-m', `The ${version} section of ${changelogFile}, ${notesPath} and the facts and prep file they were made from, cut from ${facts.range.from}..${toSha.slice(0, 7)}.`, '-m', trailers.join('\n')]);
    commit = git(dir, ['rev-parse', 'HEAD']).trim();
  } catch (e) {
    // Put the checkout back the way it was found, so a re-run starts clean.
    git(dir, ['checkout', '--force', startedAt], { allowFail: true });
    git(dir, ['branch', '-D', branch], { allowFail: true });
    throw e;
  }

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
    releaseNotes: notesPath,
    replacesClosedCandidate: replaces,
    workBranch,
  };
  fs.writeFileSync(path.join(out, 'release-pr.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  // The four files the fleet's release-PR hook reads: `branch`, `sha`, `title` and `body.md`. Each
  // is one value with no newline after it; `sha` is the branch's tip, which `shipyard push` checks.
  fs.writeFileSync(path.join(out, 'branch'), branch);
  fs.writeFileSync(path.join(out, 'sha'), commit);
  fs.writeFileSync(path.join(out, 'title'), artifact.title);
  return { artifact, section };
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
  dir, github, repo, shas, workBranch, toSha, branch,
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
  refuseWorkflowFixes({ dir, picks, branch });
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

// The cut pushes `release/<version>` with the job's own token, and GitHub refuses a push from that token
// when a new commit changes a file under `.github/workflows/` (it cannot be given the `workflows`
// permission). A cherry-picked fix is such a new commit, so it is refused here, before anything is made,
// with the steps a person takes in its place.
function refuseWorkflowFixes({ dir, picks, branch }) {
  const found = picks.map((p) => ({ pick: p, files: workflowFilesOf(dir, p.sha) })).filter((f) => f.files.length);
  if (!found.length) return;
  const list = found.map(({ pick, files }) => `${pick.sha} (#${pick.pull.number}) changes ${files.join(', ')}`).join('; ');
  const noun = found.length === 1 ? 'a fix changes' : 'fixes change';
  const picksText = found.map(({ pick }) => `\`git cherry-pick -x ${pick.merge ? '-m 1 ' : ''}${pick.sha}\``).join(' and then ');
  throw new Refusal(
    `${noun} a file under ${WORKFLOWS_DIR}: ${list}. The cut pushes ${branch} with the job's own token, and GitHub refuses a push from that token that changes a workflow file, so the cut stops before it pushes. Nothing was pushed. `
    + `Do this by hand: cut the re-ship again with the other fixes, or none; then on ${branch} run ${picksText} and push ${found.length === 1 ? 'it' : 'them'}. `
    + 'The release record names the fix as it does a PR into the branch.',
  );
}

/**
 * The re-ship cut (lib/reship.js): `release/<version>` again, at the checkout's HEAD (the tip of the
 * base the version merged into), for a version whose release PR merged and whose ship run failed. It
 * makes no facts and asks no prep run: the version is the one that merged, with its CHANGELOG section,
 * notes, facts and prep file already on the base. One commit adds `releases/<tag>/reship-<run>.json`.
 *
 * @param {object} opts
 * @param {string} opts.dir        the product repo's checkout at the base's tip (refused when it is not), with its tags (clean)
 * @param {string} opts.version    the version that waits for its tag (`0.1.26`)
 * @param {string} opts.tagPrefix  the prefix of the repo's release tags
 * @param {object} opts.github     lib/github.js client
 * @param {string} opts.out        where the release-pr artifact goes
 * @param {string} [opts.repo]     `<owner>/<name>`; the version's own facts name it when left out
 * @param {string} [opts.changelogFile]
 * @param {string[]|string} [opts.fixes] full commit ids of the working branch, cherry-picked in order onto
 *                                 the new branch after the re-ship commit: each must be on `runBranch` and
 *                                 be the merge commit of a merged PR, and none may be in the base already
 * @param {string} [opts.runBranch] the working branch the run started on; needed with `fixes`
 */
async function reshipCut({
  dir, version, tagPrefix = 'v', github, out, repo = null, changelogFile = CHANGELOG, fixes = [], runBranch = null,
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
  if (git(dir, ['status', '--porcelain', '--untracked-files=no']).trim()) {
    throw new ReleaseError('the checkout is not clean: the cut needs no changes to tracked files');
  }
  const tag = `${tagPrefix}${version}`;
  const toSha = resolveCommit(dir, 'HEAD');
  // The version's own files, as its cut left them on the base.
  const read = (p) => git(dir, ['show', `${toSha}:${p}`], { allowFail: true });
  const factsText = read(`releases/${tag}/facts.json`);
  const prepText = read(`releases/${tag}/prep.json`);
  const notes = read(`releases/${tag}/release-notes.md`);
  if (factsText === null || prepText === null || notes === null) {
    throw new Refusal(`${toSha.slice(0, 7)} has no releases/${tag}/ from \`shipyard cut\` (facts.json, prep.json, release-notes.md): only a version Shipyard cut, and that merged, can be re-shipped`);
  }
  let facts;
  let prep;
  try {
    facts = JSON.parse(factsText);
    prep = JSON.parse(prepText);
  } catch {
    throw new ReleaseError(`releases/${tag}/facts.json or prep.json at ${toSha.slice(0, 7)} is not valid JSON`);
  }
  checkFacts(facts);
  if (facts.tagPrefix !== tagPrefix) throw new Refusal(`releases/${tag}/facts.json is for the tag prefix ${JSON.stringify(facts.tagPrefix)}, not ${JSON.stringify(tagPrefix)}`);
  // The body is written again by this Shipyard, and the record lints the prep file again: a prep file this version
  // refuses (format 1, written for an earlier Shipyard) is refused here, saying what to do, never part-way into the body.
  try {
    assertPrepPasses(facts, prep, { names: false });
  } catch (e) {
    if (!(e instanceof Refusal)) throw e;
    // The prep file on the base cannot be changed (the base takes only release PRs), so the way out is an older Shipyard.
    throw new Refusal(`releases/${tag}/prep.json at ${toSha.slice(0, 7)} is one this Shipyard cannot write the body from: ${e.message}\nRe-ship ${version} with the last Shipyard release that reads its prep file, the one before the release whose CHANGELOG says format 1 is refused: point the repo's cut and record callers at that release for the re-ship, as the record lints it too, then move them back`);
  }
  const name = repo || facts.repo.name;
  if (repo && facts.repo.name.toLowerCase() !== repo.toLowerCase()) throw new Refusal(`releases/${tag}/facts.json is for ${facts.repo.name}, not ${repo}`);
  const changelog = read(changelogFile);
  if (changelog === null || !headingFor(version).test(changelog)) {
    throw new Refusal(`${changelogFile} at ${toSha.slice(0, 7)} has no section for ${version}: a re-ship finishes a version that is already written down`);
  }

  // The number is the waiting one: merged, never tagged, and its ship run failed.
  const release = await waitingRelease({
    github, repo: name, tagPrefix, version, tagged: Boolean(git(dir, ['tag', '--list', tag]).trim()),
  });
  if (!isAncestor(dir, release.mergeCommit, toSha)) {
    throw new Refusal(`${toSha.slice(0, 7)} does not contain ${release.mergeCommit.slice(0, 7)}, the merge of #${release.pr}: cut the re-ship from the tip of ${release.base}`);
  }
  // The commit is the base's tip, not just a commit in its history: the push after the cut checks the
  // release against the base (`--within origin/<base>`), so an older commit would pass it.
  const tipRef = ['refs/remotes/origin/', 'refs/heads/'].find((p) => git(dir, ['rev-parse', '--verify', '--quiet', `${p}${release.base}^{commit}`], { allowFail: true }));
  if (!tipRef) throw new ReleaseError(`${release.base} is not in the checkout: fetch it first`);
  const baseTip = resolveCommit(dir, `${tipRef}${release.base}`);
  if (baseTip !== toSha) {
    throw new Refusal(`${toSha.slice(0, 7)} is not the tip of ${release.base} (${baseTip.slice(0, 7)}): cut the re-ship from the tip of ${release.base}`);
  }
  const picks = await checkFixes({
    dir, github, repo: name, shas: fixShas, workBranch: runBranch, toSha, branch: release.branch,
  });
  const run = await failedRunFromWorkflows({ github, repo: name, release });
  const file = reshipPath(tag, run.id);
  if (read(file) !== null) throw new Refusal(`${file} already exists at ${toSha.slice(0, 7)}: run ${run.id} has been re-shipped once`);
  if (git(dir, ['status', '--porcelain', '--', file]).trim()) throw new ReleaseError(`a file is already at ${file} in the checkout and is not part of ${toSha.slice(0, 7)}`);

  // The work branch the version was cut from, for the merge-back: the first cut's `Release-From`.
  const added = (git(dir, ['log', '--diff-filter=A', '--format=%H', toSha, '--', `releases/${tag}/prep.json`], { allowFail: true }) || '')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const firstCut = added.pop();
  const workBranch = firstCut ? workBranchOfMessage(git(dir, ['log', '-1', '--format=%B', firstCut])) : null;

  const fixPrs = [];
  for (const pick of picks) fixPrs.push(await describeFix({ github, repo: name, pull: pick.pull }));
  const reship = {
    releasePr: release.pr, mergedAt: release.mergedAt, failedRun: run, fixes: fixPrs,
  };
  // The GitHub Release's text is the CHANGELOG section the base holds, as the tag step reads it at the merge.
  const body = renderPrBody({
    tag, facts, prep, releaseBody: changelogSection(changelog, version), releaseNotes: notes, base: release.base, workBranch, reship, announces: announceCalled(dir, toSha),
  });
  const text = reshipFile({
    release, run, cutFrom: toSha, fixes: picks.map((p, i) => ({ commit: p.sha, pr: p.pull.number, title: fixPrs[i].title })),
  });

  const branch = release.branch;
  const startedOn = git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
  const startedAt = startedOn === 'HEAD' ? toSha : startedOn;
  git(dir, ['checkout', '-B', branch, toSha]);
  let commit;
  try {
    fs.mkdirSync(path.join(dir, 'releases', tag), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
    git(dir, ['add', '--', file]);
    // The same trailers the version's first cut carried, so the release check reads the same level and
    // signs, and the merge-back goes to the same work branch; and the PR this re-ships.
    const trailers = [`Release-Level: ${prep.level && prep.level.bump}`];
    const breaking = (facts.breaking || []).map((b) => b && b.id).filter(Boolean);
    if (breaking.length) trailers.push(`Release-Breaking: ${breaking.join(', ')}`);
    if (workBranch) trailers.push(`${WORK_BRANCH_TRAILER}: ${workBranch}`);
    trailers.push(`Release-Reship: #${release.pr}`);
    const fixNote = picks.length
      ? `The fix is ${picks.length === 1 ? 'a commit' : `${picks.length} commits`} of ${runBranch}, reviewed there and cherry-picked onto this branch after this commit: ${picks.map((p) => `#${p.pull.number}`).join(', ')}.`
      : 'The fix comes as a PR into this branch, or as a commit a person cherry-picks onto it.';
    git(dir, ['commit', '--quiet', '-m', `chore(release): ${tag}`, '-m', `Re-ship of ${version}: #${release.pr} merged as ${release.mergeCommit.slice(0, 7)} and its ship run ${run.id} failed, so ${tag} was never made. ${fixNote}`, '-m', trailers.join('\n')]);
    // The fixes, in the order given, each with its `(cherry picked from commit ...)` line. A pick that
    // conflicts stops the cut here, before anything is pushed: the checkout goes back as it was found.
    for (const pick of picks) {
      try {
        git(dir, ['cherry-pick', '-x', ...(pick.merge ? ['-m', '1'] : []), pick.sha]);
      } catch (e) {
        git(dir, ['cherry-pick', '--abort'], { allowFail: true });
        throw new Refusal(`${pick.sha} (#${pick.pull.number}) does not apply on ${toSha.slice(0, 7)}, the tip of ${release.base}, with the fixes before it: ${String(e.message).replace(/^git cherry-pick failed: ?/, '').slice(0, 200) || 'it conflicts'}. Nothing was pushed`);
      }
    }
    commit = git(dir, ['rev-parse', 'HEAD']).trim();
  } catch (e) {
    git(dir, ['cherry-pick', '--abort'], { allowFail: true });
    git(dir, ['checkout', '--force', startedAt], { allowFail: true });
    git(dir, ['branch', '-D', branch], { allowFail: true });
    throw e;
  }

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
    releaseNotes: `releases/${tag}/release-notes.md`,
    replacesClosedCandidate: null,
    workBranch,
    reship: {
      releasePr: release.pr, failedRun: run, file, fixes: picks.map((p, i) => ({ commit: p.sha, pr: p.pull.number, title: fixPrs[i].title })),
    },
  };
  fs.writeFileSync(path.join(out, 'release-pr.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  fs.writeFileSync(path.join(out, 'branch'), branch);
  fs.writeFileSync(path.join(out, 'sha'), commit);
  fs.writeFileSync(path.join(out, 'title'), artifact.title);
  return { artifact };
}

module.exports = {
  reshipCut, cut, checkNumberFree, checkRange, ARTIFACT_FORMAT, INPUT_FILES, HOOK_FILES: ['branch', 'sha', 'title', 'body.md'],
};
