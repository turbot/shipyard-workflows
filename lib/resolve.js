'use strict';

// The full settings of a repo's release, from its kind, its area and its file. Most of today's inputs equal a
// default or follow from a fact Shipyard can read, and this is where they come from:
//
//   const { config } = parseConfig(text);                         // or loadRepoConfig(...), lib/repo-config.js
//   const { settings, warnings } = resolveConfig(config, {
//     repo: 'example-org/example-cli',                            // <owner>/<name>
//     area: 'pipelings',                                          // the repo's `release_area` property
//     facts: { defaultBranch: 'main', description, homepage, license },   // what GitHub holds about the repo
//   });
//
// The file's values go over the kind's preset (lib/kinds.js). What the file cannot say comes from elsewhere:
//
//   tagPrefix      `v`
//   workBranch     the repo's default branch (`facts.defaultBranch`, required)
//   approversTeam  `turbot/<area>-release-approvers`, releaseApp `turbot-<area>-release`: the area's, by its naming rule
//   openerLogins   the one org list below
//   pageTargets    the folder of the announce page, `[{ repo, folder }]`, and only under the product's own site
//
// A trust value is never read from the repo's file alone. A file that sets approvers, opener logins or page
// targets (or the work branch, the tag prefix or `start`, which Shipyard knows) is read with a warning and the
// value is ignored. A page whose repo is not the product's site fails, naming the key; `ConfigResolveError`
// holds every problem it found.
//
// The product's site is `facts.site` (`<owner>/<name>`) when a reader knows it, else `<owner>/<name>.io` of the
// repo (example-org/example-cli's is example-org/example-cli.io).

const { approversTeamOf, releaseAppOf, AreasError } = require('./areas');
const { KNOWN_KEYS, DROPPED, DROPPED_NESTED, FLOWS } = require('./config');
const { presetOf } = require('./kinds');

// The accounts that may open a release PR, for every repo of the org. `github-actions[bot]` stays until every
// release it opened the old way has drained; then it is taken off this list, and only here.
const OPENER_LOGINS = Object.freeze(['turbot-agent-fleet[bot]', 'github-actions[bot]']);
const TAG_PREFIX = 'v';

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;

class ConfigResolveError extends Error {
  constructor(problems) {
    super(problems.join('\n'));
    this.name = 'ConfigResolveError';
    this.problems = problems;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const oneLine = (s, max = 80) => {
  const t = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// What each trust value is instead, for the warning.
const INSTEAD = (area) => ({
  approvers: `the approvers are ${approversTeamOf(area)}`,
  'automation-logins': `the opener logins are ${OPENER_LOGINS.join(' and ')}`,
  automationLogins: `the opener logins are ${OPENER_LOGINS.join(' and ')}`,
});
// The camel-case spellings of a dropped key a reader's own object may carry.
const SPELLINGS = Object.freeze({ automationLogins: 'automation-logins', pageTargets: 'page-targets' });

function ignoredKeys(config, area, warnings) {
  const instead = INSTEAD(area);
  const names = [...Object.keys(DROPPED), ...Object.keys(SPELLINGS)];
  for (const key of names) {
    if (!Object.hasOwn(config, key)) continue;
    const reason = DROPPED[key] || DROPPED[SPELLINGS[key]];
    warnings.push(`${key} is set in the file and ignored: ${reason}${instead[key] ? ` (${instead[key]})` : ''}. Remove it.`);
  }
  if (isObject(config.people)) {
    for (const key of ['approvers', 'ask']) {
      if (Object.hasOwn(config.people, key)) {
        warnings.push(`people.${key} is set in the file and ignored: ${DROPPED_NESTED[`people.${key}`]}${key === 'approvers' ? ` (${instead.approvers})` : ''}. Remove it.`);
      }
    }
  }
}

// The folder a page may go in: the directories of its path before the first one that holds a placeholder.
function folderOf(pagePath) {
  const dirs = String(pagePath).split('/').slice(0, -1);
  const fixed = [];
  for (const d of dirs) {
    if (d.includes('{')) break;
    fixed.push(d);
  }
  return fixed.length ? `${fixed.join('/')}/` : null;
}

function check(config, { repo, area, facts }) {
  const problems = [];
  if (!isObject(config)) problems.push('the config must be a map of settings: read the file with parseConfig or loadRepoConfig first.');
  if (typeof repo !== 'string' || !REPO.test(repo)) problems.push(`repo must be <owner>/<name> (got ${oneLine(repo)}).`);
  if (!isObject(facts) || typeof facts.defaultBranch !== 'string' || !BRANCH.test(facts.defaultBranch)) {
    problems.push(`facts.defaultBranch must be the repo's default branch, as the work branch is that (got ${oneLine(isObject(facts) ? facts.defaultBranch : facts)}).`);
  }
  try {
    approversTeamOf(area);
  } catch (e) {
    if (!(e instanceof AreasError)) throw e;
    problems.push(`area: ${e.message}`);
  }
  if (isObject(config) && !presetOf(config.kind)) {
    problems.push(`kind is ${config.kind === undefined ? 'missing' : oneLine(config.kind)}: a repo's settings come from its kind, one of go-cli, go-library, service, docs-site or shipyard.`);
  }
  if (facts !== undefined && facts !== null && !isObject(facts)) problems.push('facts must be a map.');
  if (isObject(facts) && facts.site !== undefined && (typeof facts.site !== 'string' || !REPO.test(facts.site))) {
    problems.push(`facts.site must be <owner>/<name>, the product's site repo (got ${oneLine(facts.site)}).`);
  }
  return problems;
}

/**
 * @param {object} config  what `parseConfig` or `loadRepoConfig` returned as `config`
 * @param {{repo: string, area: string, facts: {defaultBranch: string, site?: string, description?: string, homepage?: string, license?: string}}} where
 * @returns {{settings: object, warnings: string[]}}
 * @throws {ConfigResolveError}
 */
function resolveConfig(config, { repo, area, facts } = {}) {
  const problems = check(config, { repo, area, facts });
  if (problems.length) throw new ConfigResolveError(problems);

  const warnings = [];
  const preset = presetOf(config.kind);
  ignoredKeys(config, area, warnings);

  // Only a key the validator knows is read, so a stale or unknown key never reaches a reader.
  const settings = {};
  for (const key of KNOWN_KEYS) if (Object.hasOwn(config, key)) settings[key] = structuredClone(config[key]);

  // `people` keeps the logins to tag; what a repo's file says of approvers and the ask's channel is not read.
  if (isObject(settings.people)) {
    delete settings.people.approvers;
    delete settings.people.ask;
  }

  settings.kind = config.kind;
  settings.cadence = config.cadence ?? preset.cadence;
  const own = new Set([...preset.own, ...(Array.isArray(config.own) ? config.own : [])]);
  settings.own = FLOWS.filter((f) => own.has(f));
  settings.flows = preset.runs.filter((f) => !own.has(f));

  if (preset.build) {
    settings.build = { ...preset.build, ...(isObject(config.build) ? config.build : {}) };
    settings.homebrew = {};
    const file = isObject(config.homebrew) ? config.homebrew : {};
    const fact = { desc: facts.description, homepage: facts.homepage, license: facts.license };
    for (const key of Object.keys(preset.homebrew)) settings.homebrew[key] = file[key] ?? fact[key] ?? null;
  } else {
    for (const key of ['build', 'homebrew']) {
      if (Object.hasOwn(settings, key)) {
        delete settings[key];
        warnings.push(`${key} is set in the file and ignored: it is only for kind go-cli, and this file says kind: ${config.kind}. Remove it.`);
      }
    }
  }

  settings.tagPrefix = TAG_PREFIX;
  settings.workBranch = facts.defaultBranch;
  settings.area = area;
  settings.approversTeam = approversTeamOf(area);
  settings.releaseApp = releaseAppOf(area);
  settings.openerLogins = [...OPENER_LOGINS];

  settings.pageTargets = [];
  const page = isObject(config.announce) && isObject(config.announce.page) ? config.announce.page : null;
  if (page) {
    const site = facts.site || `${repo.split('/')[0]}/${repo.split('/')[1]}.io`;
    const errors = [];
    if (typeof page.repo !== 'string' || page.repo.toLowerCase() !== site.toLowerCase()) {
      errors.push(`announce.page.repo is ${oneLine(page.repo)}, which is not the product's site, ${site}: a page may go only under the product's own site. Set it to ${site}, or remove announce.page.`);
    }
    const folder = folderOf(page.path);
    if (!folder) errors.push(`announce.page.path ${JSON.stringify(oneLine(page.path))} is not in a folder: a page goes in a folder of the site, such as content/changelog/.`);
    if (errors.length) throw new ConfigResolveError(errors);
    settings.pageTargets.push({ repo: site, folder });
  }

  return { settings, warnings };
}

module.exports = { resolveConfig, ConfigResolveError, OPENER_LOGINS, TAG_PREFIX };
