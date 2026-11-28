'use strict';

// How a record-side reader (the record, the release check, the ask, the tag, the prerelease, the announcement) gets
// its config and its trust values, written once. Every reader has the same shape:
//
//   const warn = (line) => process.stderr.write(`${line}\n`);
//   // 1. Load at the source the reader reads today: { dir, rev } (git), { github, repo, ref } (the API), or { dir }.
//   const loaded = await loadReaderConfig({ github, repo, ref }, { warn });   // loadReaderConfigAt({ dir, rev }, { warn }) with no await
//   // 2. On shipyard.yml, the resolved settings; on release.json or no file, null, and GitHub is asked nothing.
//   const settings = await settingsOf(loaded, { repo, area: opts.area, defaultBranch: opts.defaultBranch, github, warn });
//   // 3. Each trust value through trustValue; every other key from loaded.config, as before.
//   const approvers = trustValue({ settings, resolved: settings && [`@${settings.approversTeam}`], given: list(opts.approvers), flag: '--approvers', warn });
//   const targets = trustValue({ settings, resolved: settings && settings.pageTargets, given: parseTargets(opts.pageTargets), flag: '--page-targets', warn });
//   // The release PR openers are the one trust value that never needs a flag: Shipyard's own accounts, by user ID, or on
//   // release.json exactly the accounts the caller names (lib/openers.js).
//   const openers = openersFor({ settings, logins: list(opts.automationLogins), ids: parseIds(opts.automationIds), warn });
//   // 4. A trust flag stays required, with today's message, only when settings is null.
//   if (!settings && !approvers.length) throw new ReleaseError('--approvers is required');
//   // 5. The command's USAGE gains [--area <release_area>] [--default-branch <name>], and its docs name both.
//
// Which path a reader takes is decided by the file the loader found: only `.github/shipyard.yml` takes the new one.
// A repo on `.github/release.json`, or with neither file, keeps today's inputs, defaults and messages.

const { loadRepoConfig, loadRepoConfigAt, NoConfigError, YAML_FILE } = require('./repo-config');
const { resolveConfig, ConfigResolveError } = require('./resolve');
const { ReleaseError } = require('./release-git');

const stderr = (line) => process.stderr.write(`${line}\n`);
const oneLine = (s, max = 200) => {
  const t = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const none = () => ({ file: null, config: {}, warnings: [] });

// A client that is the given one, save that it counts the file reads that came back. The loader reads both files
// before anything else, so once both have come back empty, any later failure is its check of the ref.
function countingReads(github) {
  const seen = { empty: 0 };
  const wrapped = Object.create(github);
  wrapped.getFileText = async (...args) => {
    const text = await github.getFileText(...args);
    if (text === null || text === undefined) seen.empty += 1;
    return text;
  };
  return { wrapped, seen };
}

/**
 * The repo's config, through the loader (lib/repo-config.js), for a reader.
 *
 * Neither file is `{ file: null, config: {}, warnings: [] }`, so every reader keeps its old path for a repo with no
 * config. A `shipyard.yml` that is not YAML, or a `release.json` that is not JSON, is the loader's error, never a fall
 * back to the other file or to defaults.
 *
 * A ref the API cannot read: once both files have come back as not there, the loader asks GitHub whether the ref
 * exists, and fails when it does not. A reader takes that as neither file, as its own read of `release.json` with
 * `getFileText` did (the contents API answers 404 for a missing file and a missing ref alike), so it takes its old
 * path, where each trust value still needs its flag; so does that check failing outright, which no reader made
 * before. GitHub failing to read either file (a 5xx, a rate limit) still throws.
 * A commit of a checkout that names no commit is the loader's error: no reader read a checkout that was not there.
 *
 * @param {{dir?: string, rev?: string, github?: object, repo?: string, ref?: string}} source  as loadRepoConfig takes
 * @param {{warn?: (line: string) => void}} [opts]  where the loader's warnings go (standard error when unset)
 * @returns {Promise<{file: string|null, config: object, warnings: string[]}>}
 */
async function loadReaderConfig(source, { warn = stderr } = {}) {
  if (source && typeof source === 'object' && source.github) {
    const { wrapped, seen } = countingReads(source.github);
    try {
      return await loadRepoConfig({ ...source, github: wrapped }, { warn });
    } catch (e) {
      if (seen.empty >= 2) return none(); // both files read and absent: no config, or a ref this token cannot read
      throw e;
    }
  }
  try {
    return await loadRepoConfig(source, { warn });
  } catch (e) {
    if (e instanceof NoConfigError) return none();
    throw e;
  }
}

/**
 * The same, for a commit of a checkout, with no await.
 * @param {{dir: string, rev: string}} source
 * @param {{warn?: (line: string) => void}} [opts]
 * @returns {{file: string|null, config: object, warnings: string[]}}
 */
function loadReaderConfigAt({ dir, rev }, { warn = stderr } = {}) {
  try {
    return loadRepoConfigAt({ dir, rev }, { warn });
  } catch (e) {
    if (e instanceof NoConfigError) return none();
    throw e;
  }
}

const given = (v) => v !== undefined && v !== null && v !== '';

/**
 * The resolved settings (lib/resolve.js) of a repo on `shipyard.yml`, or null for `release.json` or no file, when
 * nothing is asked of GitHub.
 *
 * The area is `area` when given, else the repo's `release_area` property; the default branch is `defaultBranch` when
 * given (a name, or a function answering one or a promise of one), else GitHub's. With neither, the reader cannot
 * know its approvers or work branch, so it fails naming the flag: nothing is guessed.
 *
 * @param {{file: string|null, config: object}|null} loaded  what loadReaderConfig answered
 * @param {object} opts
 * @param {string} opts.repo  `<owner>/<name>`
 * @param {string} [opts.area]
 * @param {string|(() => string|Promise<string>)} [opts.defaultBranch]
 * @param {object} [opts.github]  a client (lib/github.js), asked only for what was not given
 * @param {(line: string) => void} [opts.warn]  where resolveConfig's warnings go, each prefixed with the file
 * @returns {Promise<object|null>}
 * @throws {ReleaseError}
 */
async function settingsOf(loaded, {
  repo, area, defaultBranch, github, warn = stderr,
} = {}) {
  if (!loaded || loaded.file !== YAML_FILE) return null;

  // One read of the repo gives its release area and its default branch; --area and --default-branch win when given.
  const facts = github && (!given(area) || !given(defaultBranch)) ? await github.repoFacts(repo) : null;

  let theArea = given(area) ? area : null;
  if (theArea === null && facts) theArea = facts.area;
  if (!given(theArea)) {
    throw new ReleaseError(`${repo} is on ${YAML_FILE}: give its release area with --area, or set the repo's \`release_area\` property; the area names its approvers`);
  }

  let branch = null;
  if (given(defaultBranch)) branch = typeof defaultBranch === 'function' ? await defaultBranch() : defaultBranch;
  else if (facts) branch = facts.defaultBranch;
  if (!given(branch)) {
    throw new ReleaseError(`${repo} is on ${YAML_FILE}: its work branch is its default branch, and none was given (--default-branch) or found`);
  }

  try {
    const { settings, warnings } = resolveConfig(loaded.config, { repo, area: theArea, facts: { defaultBranch: branch } });
    for (const w of warnings) warn(`${YAML_FILE}: ${w}`);
    return settings;
  } catch (e) {
    if (e instanceof ConfigResolveError) throw new ReleaseError(`${YAML_FILE}: ${e.problems.join(' ')}`);
    throw e;
  }
}

// A trust value as a set of lower-case texts, to compare: a list (of names, or of `{ repo, folder }` page targets), or
// a comma-separated text.
const itemText = (v) => (v && typeof v === 'object' ? `${v.repo}:${v.folder}` : String(v)).trim();
const itemsOf = (v) => {
  if (!given(v)) return [];
  const list = Array.isArray(v) ? v : String(v).split(',');
  return list.map(itemText).filter(Boolean);
};
const sameSet = (a, b) => {
  const x = new Set(a.map((s) => s.toLowerCase()));
  const y = new Set(b.map((s) => s.toLowerCase()));
  return x.size === y.size && [...x].every((s) => y.has(s));
};

/**
 * A trust value (approvers, page targets). With settings (a repo on `shipyard.yml`), the resolved value:
 * a value the caller still gives is not used, and when it differs from the resolved one, one warning names the flag
 * and what the value is instead. Without settings, the given value, untouched.
 *
 * @param {{settings: object|null, resolved: any, given: any, flag: string, warn?: (line: string) => void}} opts
 */
function trustValue({
  settings, resolved, given: value, flag, warn = stderr,
}) {
  if (!settings) return value;
  const had = itemsOf(value);
  if (had.length && !sameSet(had, itemsOf(resolved))) {
    const instead = itemsOf(resolved);
    warn(oneLine(`${flag} is ignored: this repo is on ${YAML_FILE}, so it is ${instead.length ? instead.join(', ') : 'none'}, not ${had.join(', ')}.`, 400));
  }
  return resolved;
}

module.exports = {
  loadReaderConfig, loadReaderConfigAt, settingsOf, trustValue,
};
