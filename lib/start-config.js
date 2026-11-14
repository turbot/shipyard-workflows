'use strict';

// The `start` setting of a repo: which branches start a release, how often, and who to ask
// when a prep job gets no answer. It comes from the repo's `.github/release.json`, read at a
// commit of the product checkout, or else from the family file in this repo that names the repo.
//
//   "start": {
//     "branches": [{ "name": "develop", "cadence": "daily" }, { "name": "main", "cadence": "weekly" }],
//     "tagPrefix": "v",                  // optional, `v` unless the repo's tags start otherwise
//     "greenCheck": "develop-green",     // optional: the full check `release:now` waits for
//     "approvers": ["alice-example", "@example-org/release-approvers"]   // optional
//   }
//
// A family file is `families/<name>.json`: `{ "repos": ["<owner>/<name>", ...], "start": { ... } }`.
// A repo whose own `release.json` has a `start` never reads a family file.

const fs = require('node:fs');
const path = require('node:path');
const { ReleaseError, git, resolveCommit } = require('./release-git');

const CADENCES = ['daily', 'weekly', 'manual'];
// A branch name git accepts, narrowed to what a title, a path and a comment can carry safely.
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const TAG_PREFIX = /^[A-Za-z0-9._-]{0,20}$/;
// A login (`alice-example`) or a team (`example-org/release-approvers`), with or without `@`.
const APPROVER = /^@?[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/;
const KEYS = new Set(['branches', 'tagPrefix', 'greenCheck', 'approvers']);

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function parseStart(start, where) {
  if (!isObject(start)) throw new ReleaseError(`${where}: start must be an object`);
  for (const key of Object.keys(start)) {
    if (!KEYS.has(key)) throw new ReleaseError(`${where}: start has no setting "${key}" (settings: ${[...KEYS].join(', ')})`);
  }
  const { branches, tagPrefix = 'v', greenCheck, approvers = [] } = start;
  if (!Array.isArray(branches) || !branches.length) throw new ReleaseError(`${where}: start.branches must list at least one branch`);
  const seen = new Set();
  const list = branches.map((b, i) => {
    if (!isObject(b) || typeof b.name !== 'string' || !BRANCH.test(b.name)) {
      throw new ReleaseError(`${where}: start.branches[${i}].name must be a branch name`);
    }
    if (!CADENCES.includes(b.cadence)) {
      throw new ReleaseError(`${where}: start.branches[${i}].cadence must be one of ${CADENCES.join(', ')}`);
    }
    if (Object.keys(b).some((k) => k !== 'name' && k !== 'cadence')) {
      throw new ReleaseError(`${where}: start.branches[${i}] holds only a name and a cadence`);
    }
    if (seen.has(b.name)) throw new ReleaseError(`${where}: start.branches names ${b.name} twice`);
    seen.add(b.name);
    return { name: b.name, cadence: b.cadence };
  });
  if (typeof tagPrefix !== 'string' || !TAG_PREFIX.test(tagPrefix)) throw new ReleaseError(`${where}: start.tagPrefix must be a short prefix such as "v"`);
  if (greenCheck !== undefined && (typeof greenCheck !== 'string' || !greenCheck.trim() || greenCheck.length > 100 || /[\u0000-\u001f]/.test(greenCheck))) {
    throw new ReleaseError(`${where}: start.greenCheck must be the name of a check`);
  }
  if (!Array.isArray(approvers) || approvers.length > 20 || approvers.some((a) => typeof a !== 'string' || !APPROVER.test(a))) {
    throw new ReleaseError(`${where}: start.approvers must be a list of at most 20 logins or teams`);
  }
  return {
    branches: list,
    tagPrefix,
    greenCheck: greenCheck === undefined ? null : greenCheck.trim(),
    approvers: approvers.map((a) => (a.startsWith('@') ? a : `@${a}`)),
  };
}

// The family file that names the repo, or null. Two that name it are an error: neither is the
// one to follow.
function familyStart(familiesDir, repo) {
  let names;
  try {
    names = fs.readdirSync(familiesDir).filter((n) => n.endsWith('.json')).sort();
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw new ReleaseError(`cannot read the family files at ${familiesDir}: ${e.code || e.message}`);
  }
  const found = [];
  for (const name of names) {
    const file = path.join(familiesDir, name);
    let json;
    try {
      json = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      throw new ReleaseError(`the family file ${name} is not valid JSON`);
    }
    if (!isObject(json) || !Array.isArray(json.repos) || json.repos.some((r) => typeof r !== 'string')) {
      throw new ReleaseError(`the family file ${name} must hold "repos" (a list of <owner>/<name>) and "start"`);
    }
    if (json.repos.some((r) => r.toLowerCase() === repo.toLowerCase())) found.push({ name, start: json.start });
  }
  if (found.length > 1) throw new ReleaseError(`${repo} is in more than one family file (${found.map((f) => f.name).join(', ')}): list it in one`);
  return found.length ? parseStart(found[0].start, `the family file ${found[0].name}`) : null;
}

/**
 * The repo's start setting, or null when it has none.
 *
 * @param {object} opts
 * @param {object} opts.config      the repo's `.github/release.json`, parsed ({} when it has none)
 * @param {string} opts.repo        `<owner>/<name>`
 * @param {string} [opts.familiesDir]
 */
function loadStart({ config, repo, familiesDir = 'families' }) {
  if (config.start !== undefined) return parseStart(config.start, '.github/release.json');
  return familyStart(familiesDir, repo);
}

// `.github/release.json` as it is at a commit of the product checkout; {} when the repo has none.
function readReleaseConfig(dir, ref) {
  resolveCommit(dir, ref); // a folder that is no checkout is an error, not a repo with no config
  const text = git(dir, ['show', `${ref}:.github/release.json`], { allowFail: true });
  if (text === null) return {};
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ReleaseError('.github/release.json is not valid JSON');
  }
  return isObject(json) ? json : {};
}

module.exports = { CADENCES, BRANCH, APPROVER, parseStart, loadStart, readReleaseConfig };
