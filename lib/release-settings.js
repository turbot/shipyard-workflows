'use strict';

// What a cut-side reader releases by: its config, its tag prefix and its work branch, for a repo on either file.
//
//   const { config, file, tagPrefix, workBranch, warnings } = await releaseSettingsOf(source, {
//     repo: 'example-org/example-cli',     // <owner>/<name>
//     github,                              // a client (lib/github.js), asked only for a repo on shipyard.yml
//     tagPrefix: 'v',                      // the command's --tag-prefix (default `v`)
//     workBranch: null,                    // the command's --work-branch (default none)
//     area, defaultBranch,                 // optional: given, they stand in for what GitHub holds
//     warn,                                // where a warning is printed, once each (standard error when unset)
//   });
//
// `source` is what `loadRepoConfig` takes (lib/repo-config.js): `{ dir }`, `{ dir, rev }` or `{ github, repo, ref }`.
// One place decides this, so the commands that read it (facts, cut) cannot drift apart:
//
//   .github/shipyard.yml   the file goes through `resolveConfig` (lib/resolve.js), and `config` is its settings. The
//                          tag prefix is `v` and the work branch is the repo's default branch. The area and the
//                          default branch come from one GitHub read (`repoFacts`) unless the caller gives both.
//   .github/release.json   the file as it is, with the caller's own tag prefix and work branch: the old values.
//   neither                `{}`, with the caller's values, as every cut-side reader has done with no release.json.
//
// Neither file and release.json make no GitHub call. Any other loader error (a file that is not YAML or not JSON,
// a revision that names no commit) is thrown as it is: a broken file is never read as no file.
//
// For a repo on shipyard.yml a flag that disagrees with the resolved value is refused, never obeyed: a silent
// override would start a range at the wrong tag or record the wrong work branch, valid-looking and wrong. So are a
// repo this token cannot see, a repo with no release area, and a file `resolveConfig` refuses. Each is a
// `ReleaseError` of one line, and any repo or caller text in it is a short one-line quote.

const { loadRepoConfig, NoConfigError, YAML_FILE, JSON_FILE } = require('./repo-config');
const { resolveConfig, ConfigResolveError } = require('./resolve');
const { ReleaseError } = require('./release-git');

const oneLine = (s, max = 80) => {
  const t = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const quote = (s) => JSON.stringify(oneLine(s));

// The area and the default branch: the caller's where given, else one read of the repo.
async function factsOf({ repo, github, area, defaultBranch }) {
  if (area != null && defaultBranch != null) return { area, defaultBranch };
  if (!github || typeof github.repoFacts !== 'function') {
    throw new ReleaseError(`${oneLine(repo)} is on ${YAML_FILE}, and its release area and default branch need a GitHub client to read`);
  }
  const facts = await github.repoFacts(repo);
  if (!facts) throw new ReleaseError(`${oneLine(repo)} cannot be seen with this token, so its release area and default branch were not read`);
  return { area: area ?? facts.area, defaultBranch: defaultBranch ?? facts.defaultBranch };
}

/**
 * @param {{dir?: string, rev?: string, github?: object, repo?: string, ref?: string}} source
 * @param {{repo?: string, github?: object, tagPrefix?: string, workBranch?: string|null, area?: string, defaultBranch?: string, warn?: (line: string) => void}} [opts]
 * @returns {Promise<{config: object, file: string|null, tagPrefix: string, workBranch: string|null, warnings: string[]}>}
 * @throws {ReleaseError}
 */
async function releaseSettingsOf(source, {
  repo, github, tagPrefix = 'v', workBranch = null, area, defaultBranch, warn = (line) => process.stderr.write(`${line}\n`),
} = {}) {
  let loaded;
  try {
    loaded = await loadRepoConfig(source, { warn });
  } catch (e) {
    if (e instanceof NoConfigError) return { config: {}, file: null, tagPrefix, workBranch, warnings: [] };
    throw e;
  }
  const { config, file, warnings, errors = [] } = loaded;
  if (file === JSON_FILE) return { config, file, tagPrefix, workBranch, warnings };

  // The file is shipyard.yml. The repo and the client may come from an API source.
  const name = repo ?? (source && source.repo);
  if (typeof name !== 'string' || !name) throw new ReleaseError(`releaseSettingsOf needs the repo (<owner>/<name>) to resolve ${YAML_FILE}`);
  const facts = await factsOf({ repo: name, github: github ?? (source && source.github), area, defaultBranch });
  if (facts.area == null) {
    throw new ReleaseError(`${oneLine(name)} is on ${YAML_FILE} and has no release area: set its release_area custom property on GitHub`);
  }

  let resolved;
  try {
    resolved = resolveConfig(config, { repo: name, area: facts.area, facts: { defaultBranch: facts.defaultBranch } });
  } catch (e) {
    if (e instanceof ConfigResolveError) throw new ReleaseError(`${YAML_FILE}: ${e.problems.map((p) => oneLine(p, Infinity)).join(' ')}`);
    throw e;
  }
  const { settings } = resolved;
  // release.json refuses a malformed key; shipyard.yml must too, or the same repo cuts a different release
  // (a dropped detector means a breaking change gets no sign). The loader warned; the cut side stops.
  if (errors.length) {
    throw new ReleaseError(`${YAML_FILE} has a key the cut cannot read, so the cut would differ from ${JSON_FILE}: ${errors.map((e) => oneLine(e, Infinity)).join(' ')}`);
  }
  const all = [...warnings];
  for (const w of resolved.warnings) {
    const line = oneLine(`${YAML_FILE}: ${w}`, Infinity);
    if (all.includes(line)) continue;
    all.push(line);
    warn(line);
  }

  if (tagPrefix !== settings.tagPrefix) {
    throw new ReleaseError(`--tag-prefix ${quote(tagPrefix)} disagrees with ${YAML_FILE}, whose tag prefix is ${quote(settings.tagPrefix)}: drop --tag-prefix or pass ${settings.tagPrefix}`);
  }
  if (workBranch != null && workBranch !== settings.workBranch) {
    throw new ReleaseError(`--work-branch ${quote(workBranch)} disagrees with ${YAML_FILE}, whose work branch is the default branch, ${quote(settings.workBranch)}: drop --work-branch or pass ${oneLine(settings.workBranch)}`);
  }
  return { config: settings, file, tagPrefix: settings.tagPrefix, workBranch: settings.workBranch, warnings: all };
}

module.exports = { releaseSettingsOf };
