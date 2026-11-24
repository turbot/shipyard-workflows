'use strict';

// The one loader of a repo's release config. It reads `.github/shipyard.yml`, or, only when that file is absent,
// `.github/release.json`, so a reader works for a repo before and after its move with one code path.
//
//   await loadRepoConfig({ dir })                          // a checkout folder (its working tree)
//   await loadRepoConfig({ dir, rev })                     // a commit in a checkout (`git show`, never the tree)
//   await loadRepoConfig({ github, repo, ref })            // a repo read through the API, with no checkout
//   -> { config, file, warnings, errors }
//
// `config` is the object a reader takes today. `file` names the file it came from, so a reader can say so.
// `warnings` are the lines it printed (to `opts.warn`, standard error unless given), each once.
// `errors` are the problems of a `shipyard.yml` that left a key out of `config` (each as the validator worded it, which
// starts with the key's path), so a reader that cannot do without a key can tell it was dropped. `release.json` has none.
//
// Which file wins:
//   - only `shipyard.yml`: it is read with the validator (lib/config.js), leniently.
//   - only `release.json`: it is read as JSON and returned as it is.
//   - both: `shipyard.yml` wins, and a warning names the leftover `release.json`.
//   - neither: an error naming both paths.
//
// A `shipyard.yml` that is YAML but has a problem (an unknown key, a wrong type, a missing `kind`) never stops a
// release: the keys that passed are returned, and each problem is a warning. One that is not YAML at all (or not a
// map of settings, or over the size limit) has nothing to return, so it is an error naming the file and the line. It never falls back to a
// leftover `release.json`: that would release by settings the repo has already moved away from.

const fs = require('node:fs');
const path = require('node:path');
const { parseConfig, FILE: YAML_FILE } = require('./config');
const { GitHubError } = require('./github');
const { ReleaseError, git, resolveCommit } = require('./release-git');

const JSON_FILE = '.github/release.json';

class RepoConfigError extends ReleaseError {}
// A place that was read in full and holds neither file. A reader that can go on with no settings (the PR check) takes
// this one apart from a config it could not read.
class NoConfigError extends RepoConfigError {}

const oneLine = (s) => String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();

// A reader answers a file's text, or null when the file is not there. Any other failure throws.
function directoryReader(dir) {
  return {
    where: `the folder ${path.resolve(dir)}`,
    async read(file) {
      try {
        return fs.readFileSync(path.join(dir, file), 'utf8');
      } catch (e) {
        if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return null;
        throw e;
      }
    },
  };
}

// A commit of a checkout, read with no await: the one reader both loaders use.
function commitTexts(dir, rev) {
  // A revision that names no commit would look like a repo with no config at all, so it fails here.
  const sha = resolveCommit(dir, rev);
  return {
    where: `commit ${sha.slice(0, 7)}`,
    read(file) {
      // `cat-file -e` tells a file that is not in the commit from a git that failed.
      if (git(dir, ['cat-file', '-e', `${sha}:${file}`], { allowFail: true }) === null) return null;
      return git(dir, ['show', `${sha}:${file}`]);
    },
  };
}

function commitReader(dir, rev) {
  const { where, read } = commitTexts(dir, rev);
  return { where, read: async (file) => read(file) };
}

// The contents API answers 404 for a file that is not there and for a repo or ref it cannot find alike, so a
// repo with no config is told from a ref that was never read only by asking for the ref itself.
async function refResolves(github, repo, ref) {
  try {
    if (/^[0-9a-f]{40}$/i.test(ref)) return Boolean(await github.getCommit(repo, ref));
    if (await github.branchTip(repo, ref)) return true;
    return Boolean(await github.getRefSha(repo, `tags/${ref}`));
  } catch (e) {
    // A 404 is a ref that does not exist; a tag object (an annotated tag) is a tag that does. Any other failure
    // (a 5xx, a rate limit) is GitHub's own error, never "no such ref".
    if (e instanceof GitHubError && e.status === 404) return false;
    if (e instanceof GitHubError && /does not name a commit/.test(e.message)) return true;
    throw e;
  }
}

function gitHubReader(github, repo, ref) {
  return {
    where: `${repo} at ${ref}`,
    read: (file) => github.getFileText(repo, file, ref),
    async checkRead() {
      if (!(await refResolves(github, repo, ref))) throw new RepoConfigError(`${repo} has no commit, branch or tag ${oneLine(ref).slice(0, 100)} that this token can read, so its config was not read`);
    },
  };
}

function readerOf(source) {
  if (!source || typeof source !== 'object') throw new RepoConfigError('loadRepoConfig needs a source: { dir }, { dir, rev } or { github, repo, ref }');
  if (source.github) {
    if (!source.repo || !source.ref) throw new RepoConfigError('loadRepoConfig needs the repo and the ref to read through the API');
    return gitHubReader(source.github, source.repo, source.ref);
  }
  if (!source.dir) throw new RepoConfigError('loadRepoConfig needs a source: { dir }, { dir, rev } or { github, repo, ref }');
  return source.rev ? commitReader(source.dir, source.rev) : directoryReader(source.dir);
}

function fromJson(text) {
  let json;
  try {
    json = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    throw new RepoConfigError(`${JSON_FILE} is not valid JSON: ${oneLine(e && e.message ? e.message : e).slice(0, 120)}`);
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) throw new RepoConfigError(`${JSON_FILE} must be an object of settings`);
  return json;
}

// What a config is, once the texts of the two files are read (null for a file that is not there). One reading for
// the async loader (any source) and the sync one (a commit), so the two never decide differently.
function settle({ yml, json, where }, say) {
  if (yml !== null) {
    const parsed = parseConfig(yml);
    if (parsed.unreadable) throw new RepoConfigError(`${YAML_FILE} at ${where}: ${parsed.errors.join(' ')}`);
    for (const w of parsed.warnings) say(`${YAML_FILE}: ${w}`);
    for (const e of parsed.errors) say(`${YAML_FILE}: ${e}`);
    if (json !== null) say(`${JSON_FILE} is still in ${where} beside ${YAML_FILE}: ${YAML_FILE} is read and ${JSON_FILE} is ignored. Remove ${JSON_FILE}.`);
    return { config: parsed.config, file: YAML_FILE, errors: parsed.errors.map(oneLine) };
  }
  if (json === null) return null;
  return { config: fromJson(json), file: JSON_FILE, errors: [] };
}

const sayOnce = (warn) => {
  const warnings = [];
  const say = (line) => {
    const text = oneLine(line);
    if (warnings.includes(text)) return;
    warnings.push(text);
    warn(text);
  };
  return { warnings, say };
};

/**
 * @param {{dir?: string, rev?: string, github?: object, repo?: string, ref?: string}} source
 * @param {{warn?: (line: string) => void}} [opts]  where a warning is printed, once each (standard error when unset)
 * @returns {Promise<{config: object, file: string, warnings: string[], errors: string[]}>}
 */
async function loadRepoConfig(source, { warn = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const reader = readerOf(source);
  const { warnings, say } = sayOnce(warn);
  const yml = await reader.read(YAML_FILE);
  const json = await reader.read(JSON_FILE);
  const found = settle({ yml, json, where: reader.where }, say);
  if (found) return { ...found, warnings };
  // Nothing was found: say so only when the place was really read.
  if (reader.checkRead) await reader.checkRead();
  throw new NoConfigError(`neither ${YAML_FILE} nor ${JSON_FILE} is in ${reader.where}: add ${YAML_FILE}`);
}

/**
 * The same read, for a commit of a checkout, with no await: for the scanners that read git alone and answer at once.
 * @param {{dir: string, rev: string}} source
 * @param {{warn?: (line: string) => void}} [opts]
 * @returns {{config: object, file: string, warnings: string[], errors: string[]}}
 */
function loadRepoConfigAt({ dir, rev }, { warn = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const { where, read } = commitTexts(dir, rev);
  const { warnings, say } = sayOnce(warn);
  const found = settle({ yml: read(YAML_FILE), json: read(JSON_FILE), where }, say);
  if (!found) throw new NoConfigError(`neither ${YAML_FILE} nor ${JSON_FILE} is in ${where}: add ${YAML_FILE}`);
  return { ...found, warnings };
}

module.exports = {
  loadRepoConfig, loadRepoConfigAt, RepoConfigError, NoConfigError, YAML_FILE, JSON_FILE,
};
