'use strict';

// The cut: the next version number, the release branch at the commit the facts read, the
// CHANGELOG section and the release notes committed on it, and the artifact the fleet's
// release-PR hook reads. The cut never pushes (`shipyard push` does) and never opens the PR: the
// hook holds the token that does, and the branch it is handed is the one made here.

const fs = require('node:fs');
const path = require('node:path');
const { checkFacts } = require('./lint-prep');
const {
  ReleaseError, Refusal, git, newestReleaseTag, parseTag, bump, formatVersion, resolveCommit, isAncestor,
} = require('./release-git');
const {
  buildSection, insertSection, renderReleaseNotes, renderPrBody, assertPrepPasses,
} = require('./changelog');

const ARTIFACT_FORMAT = 1;
const CHANGELOG = 'CHANGELOG.md';
// The facts and the prep file the candidate was cut from, kept on it so `shipyard record` reads
// the same ones each time it runs.
const INPUT_FILES = ['facts.json', 'prep.json'];

// What the facts must hold for a cut, on top of what `lint-prep` reads.
function checkRange(facts) {
  const r = facts.range;
  if (!r || typeof r.from !== 'string' || !/^[0-9a-f]{40}$/.test(String(r.to)) || !/^[0-9a-f]{40}$/.test(String(r.fromCommit))
    || typeof facts.tagPrefix !== 'string') {
    throw new ReleaseError('the facts have no range (from, fromCommit, to) or tagPrefix: make them again with `shipyard facts`');
  }
  if (!/^[A-Za-z0-9._-]*$/.test(facts.tagPrefix) || facts.tagPrefix.includes('..')) {
    throw new ReleaseError(`the facts' tagPrefix ${JSON.stringify(facts.tagPrefix)} is not a name a release folder can have`);
  }
  const tag = parseTag(r.from, facts.tagPrefix);
  if (!tag) throw new ReleaseError(`the facts' range starts at ${r.from}, which is not a release tag (${facts.tagPrefix}X.Y.Z)`);
  return tag;
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
 * @param {string} opts.date    YYYY-MM-DD
 * @param {string} [opts.changelogFile] the product's changelog, relative to the repo (`CHANGELOG.md`)
 */
async function cut({ dir, facts, prep, github, out, base = 'main', date, changelogFile = CHANGELOG }) {
  if (path.isAbsolute(changelogFile) || changelogFile.split(/[\\/]/).includes('..') || /^-|[\r\n]/.test(changelogFile)) {
    throw new ReleaseError(`--changelog must be a path inside the repo, not ${JSON.stringify(changelogFile)}`);
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
  if (resolveCommit(dir, `refs/tags/${fromTag.tag}`) !== facts.range.fromCommit) {
    throw new Refusal(`${fromTag.tag} no longer points where the facts read it: make the facts again`);
  }
  if (!isAncestor(dir, facts.range.fromCommit, toSha)) throw new Refusal(`${fromTag.tag} is not in the history of ${toSha.slice(0, 7)}`);
  const newest = newestReleaseTag(dir, prefix);
  if (newest.tag !== fromTag.tag) {
    throw new Refusal(`the facts start at ${fromTag.tag}, but ${newest.tag} is newer: make the facts again`);
  }

  const version = formatVersion(bump(fromTag.parts, prep.level.bump));
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
  const body = renderPrBody({ tag, facts, prep, releaseNotes: notes });

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
  };
  fs.writeFileSync(path.join(out, 'release-pr.json'), `${JSON.stringify(artifact, null, 2)}\n`);
  // The four files the fleet's release-PR hook reads: `branch`, `sha`, `title` and `body.md`. Each
  // is one value with no newline after it; `sha` is the branch's tip, which `shipyard push` checks.
  fs.writeFileSync(path.join(out, 'branch'), branch);
  fs.writeFileSync(path.join(out, 'sha'), commit);
  fs.writeFileSync(path.join(out, 'title'), artifact.title);
  return { artifact, section };
}

module.exports = { cut, checkNumberFree, checkRange, ARTIFACT_FORMAT, INPUT_FILES, HOOK_FILES: ['branch', 'sha', 'title', 'body.md'] };
