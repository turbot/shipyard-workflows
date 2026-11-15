'use strict';

// Where a release's range starts, and what its version is based on: the one rule `facts`,
// `start`, `cut`, `record` and the release check share.
//
// A repo's newest release tag (`<prefix>X.Y.Z`) starts the range, and the next version is that
// tag plus a level. A repo that has never made one names its way in once, in `.github/release.json`:
//
//   "firstRelease": { "from": "release-2026-11-14-d22c0172", "version": "1.0.0" }
//
// `from` is an old tag or a commit id where the first range starts; `version` is the first
// release's number, set rather than counted. The setting counts only while the repo has no
// release tag: once one exists it is ignored, and the tag rules as for any release.

const { ReleaseError, git, newestReleaseTag, parseTag, resolveCommit } = require('./release-git');

const SETTING = 'firstRelease';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
// A tag name or a commit id: letters, digits and `._/-`, never a leading `-` or a `..`.
const REF = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const COMMIT_ID = /^[0-9a-f]{7,40}$/;
const HOW = `"${SETTING}": { "from": "<an old tag or a commit>", "version": "X.Y.Z" }`;

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * The repo's `firstRelease` setting, checked, or null when it has none.
 * @returns {{from: string, version: string} | null}
 */
function firstReleaseOf(config, where = '.github/release.json') {
  const s = isObject(config) ? config[SETTING] : undefined;
  if (s === undefined) return null;
  if (!isObject(s)) throw new ReleaseError(`${where}: ${SETTING} must be an object, such as ${HOW}`);
  const extra = Object.keys(s).filter((k) => k !== 'from' && k !== 'version');
  if (extra.length) throw new ReleaseError(`${where}: ${SETTING} holds only "from" and "version", not "${extra[0].slice(0, 40)}"`);
  if (typeof s.from !== 'string' || !REF.test(s.from)) {
    throw new ReleaseError(`${where}: ${SETTING}.from must be an old tag or a commit id where the first range starts`);
  }
  if (typeof s.version !== 'string' || !VERSION.test(s.version)) {
    throw new ReleaseError(`${where}: ${SETTING}.version must be a plain X.Y.Z, such as "1.0.0"`);
  }
  return { from: s.from, version: s.version };
}

// The commit `from` names: a tag of the repo, else a commit id. Never a branch: a branch moves, and
// the range would start somewhere else each time it is read.
function firstReleaseCommit(dir, from, where = '.github/release.json') {
  if (git(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${from}^{commit}`], { allowFail: true })) {
    return resolveCommit(dir, `refs/tags/${from}`);
  }
  if (COMMIT_ID.test(from)) {
    const out = git(dir, ['rev-parse', '--verify', '--quiet', `${from}^{commit}`], { allowFail: true });
    if (out && out.trim().startsWith(from)) return out.trim();
  }
  throw new ReleaseError(`${where}: ${SETTING}.from is ${from}, which is no tag or commit id in this checkout (fetch its tags)`);
}

/**
 * Where the range starts. With a release tag, the newest by version (`tag` is set, `first` is null,
 * and `ignored` says so when the repo also names a first release). With none, the repo's
 * `firstRelease` (`first` is set, `tag` is null). With neither, an error that names the setting.
 *
 * @returns {{from: string, commit: string, tag: {tag: string, parts: number[]} | null,
 *   first: {from: string, version: string} | null, ignored: string | null}}
 */
function rangeStart(dir, prefix, config, where = '.github/release.json') {
  const first = firstReleaseOf(config, where);
  const newest = newestReleaseTag(dir, prefix);
  if (newest) {
    return {
      from: newest.tag,
      commit: resolveCommit(dir, `refs/tags/${newest.tag}`),
      tag: newest,
      first: null,
      ignored: first ? `${SETTING} in ${where} is ignored: the repo has a release tag, ${newest.tag}, and the range starts there` : null,
    };
  }
  if (!first) {
    throw new ReleaseError(`this repo has no release tag (${prefix}X.Y.Z) to start the range at: for its first release, add ${HOW} to ${where}`);
  }
  return { from: first.from, commit: firstReleaseCommit(dir, first.from, where), tag: null, first, ignored: null };
}

// A first release as the facts carry it (`facts.firstRelease`), checked; null when they carry none.
function factsFirstRelease(facts) {
  const f = facts.firstRelease;
  if (f === undefined || f === null) return null;
  if (!isObject(f) || typeof f.version !== 'string' || !VERSION.test(f.version) || f.from !== facts.range.from) {
    throw new ReleaseError('the facts\' firstRelease must be { "from": <the range\'s start>, "version": "X.Y.Z" }: make them again with `shipyard facts`');
  }
  if (parseTag(facts.range.from, facts.tagPrefix)) {
    throw new ReleaseError(`the facts name a first release but start at ${facts.range.from}, a release tag: make them again with \`shipyard facts\``);
  }
  return { from: f.from, version: f.version, parts: f.version.split('.').map(Number) };
}

module.exports = { SETTING, firstReleaseOf, firstReleaseCommit, rangeStart, factsFirstRelease };
