'use strict';

// The `start` setting of a repo: which branches start a release, how often, and who to ask
// when a prep job gets no answer. It comes from the repo's `.github/release.json`, read at a
// commit of the product checkout, or else from the family file in this repo that names the repo.
//
//   "start": {
//     "branches": [{ "name": "develop", "cadence": "daily" }, { "name": "main", "cadence": "weekly" }],
//     "tagPrefix": "v",                  // optional, `v` unless the repo's tags start otherwise
//     "greenCheck": "develop-green",     // optional: the full check every start needs passed (release:now waits for it; the others name the newest green commit)
//     "approvers": ["alice-example", "@example-org/release-approvers"]   // optional
//   }
//
// A family file is `families/<name>.json`: `{ "repos": ["<owner>/<name>", ...], "start": { ... } }`.
// A repo whose own `release.json` has a `start` never reads a family file.
//
// A repo on `.github/shipyard.yml` has no `start`: `startOf` (below) takes the same setting from the resolved config
// (lib/resolve.js): its one branch is the repo's default branch, on the config's `cadence`, with the config's
// `greenCheck`, the tag prefix `v` and the area's approvers team. It never reads a family file.

const fs = require('node:fs');
const path = require('node:path');
const { ReleaseError, git, resolveCommit } = require('./release-git');
const { loadRepoConfigAt, NoConfigError, YAML_FILE } = require('./repo-config');
const { resolveConfig, ConfigResolveError } = require('./resolve');

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

/**
 * The start setting from a resolved `shipyard.yml` (`resolveConfig`'s `settings`): the one branch it starts is the
 * work branch, on the file's cadence (its kind's when the file has none).
 */
function startFromSettings(settings) {
  return {
    branches: [{ name: settings.workBranch, cadence: settings.cadence }],
    tagPrefix: settings.tagPrefix,
    greenCheck: typeof settings.greenCheck === 'string' && settings.greenCheck.trim() ? settings.greenCheck.trim() : null,
    approvers: [`@${settings.approversTeam}`],
  };
}

// The loader is lenient: a key the validator refuses is left out of the config with a warning. The start cannot go on
// without the ones it reads, as it cannot with a `release.json` they are wrong in: a dropped `greenCheck` would file the
// job without waiting for the check, a dropped `cadence` would start on the kind's, a dropped `notShipped` or `shipped`
// would judge what ships by the wrong list, and a dropped `profile`, `light` or `firstRelease` would file a full prep
// job where the repo asked for a light release or a first one.
function checkNothingDropped(errors) {
  const hit = (errors || []).filter((m) => /^(?:cadence|greenCheck|notShipped|shipped|profile|light|firstRelease)(?![A-Za-z0-9_])/.test(m));
  if (hit.length) {
    throw new ReleaseError(`${YAML_FILE}: ${hit.join(' ')} The start cannot run until this is fixed.`);
  }
}

/**
 * Where a repo's start setting comes from, for the checkout at `rev`.
 *
 *   - `.github/shipyard.yml`: resolved with `area` (the repo's `release_area` property) and `defaultBranch`; the
 *     family files are not read, and a `start` the file still holds is ignored with a warning.
 *   - `.github/release.json` (a repo that has not moved yet): its `start`, else the family file that names the repo.
 *   - neither file: the family file that names the repo.
 *
 * Returns `{ start, config, file }`: `start` is null when the repo has none; `config` is the file's settings (the
 * reader's `notShipped`, `profile`, `firstRelease`), `{}` with no file; `file` names the file read, or null.
 *
 * @param {object} opts
 * @param {string} opts.dir
 * @param {string} opts.rev
 * @param {string} opts.repo         `<owner>/<name>`
 * @param {string} [opts.familiesDir]
 * @param {string|(() => Promise<string|null>|string|null)} [opts.area] needed only for a repo on `shipyard.yml`: the area, or a
 *   function answering it (asked only then, and only when this has no area to give)
 * @param {() => Promise<string>|string} [opts.defaultBranch] asked only for a repo on `shipyard.yml`
 * @param {(line: string) => void} [opts.warn]
 */
async function startOf({
  dir, rev, repo, familiesDir = 'families', area, defaultBranch, warn = () => {},
}) {
  let loaded;
  try {
    loaded = loadRepoConfigAt({ dir, rev }, { warn });
  } catch (e) {
    if (!(e instanceof NoConfigError)) throw e;
    return { start: familyStart(familiesDir, repo), config: {}, file: null };
  }
  const { config, file, errors } = loaded;
  if (file !== YAML_FILE) return { start: loadStart({ config, repo, familiesDir }), config, file };
  checkNothingDropped(errors);

  const theArea = typeof area === 'function' ? await area() : area;
  if (theArea === undefined || theArea === null || theArea === '') {
    throw new ReleaseError(`${repo} is on ${YAML_FILE}: it has no \`release_area\` property, which names its release area and so its approvers; set the property on GitHub, or give the area with --area`);
  }
  const branch = defaultBranch ? await defaultBranch() : null;
  if (!branch) throw new ReleaseError(`${repo} is on ${YAML_FILE}: its work branch is its default branch, and none was given or found (--default-branch)`);
  try {
    const { settings, warnings } = resolveConfig(config, { repo, area: theArea, facts: { defaultBranch: branch } });
    for (const w of warnings) warn(`${YAML_FILE}: ${w}`);
    return { start: startFromSettings(settings), config, file };
  } catch (e) {
    if (e instanceof ConfigResolveError) throw new ReleaseError(`${YAML_FILE}: ${e.problems.join(' ')}`);
    throw e;
  }
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

module.exports = {
  CADENCES, BRANCH, APPROVER, parseStart, loadStart, readReleaseConfig, startFromSettings, startOf, checkNothingDropped,
};
