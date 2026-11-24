'use strict';

// The decision half of the central start: which release repos are due now. It lists the repos that have the area
// property, reads each one's config through the loader, applies the due rule (lib/due.js) and, for a repo the rule
// calls due, asks GitHub once whether any commit waits since its newest release. It files nothing: the exact check and
// the filing of a due repo are lib/schedule-file.js's.
//
// Each repo ends in one decision:
//
//   due              the rule says start, and commits wait since the newest release (or the repo has no release yet)
//   not due          the rule says not now: off its weekly day, or a prep job or a release has answered this start
//   nothing to ship  the rule says start, and the work branch holds nothing the newest release lacks
//   manual           the repo's cadence is `manual`: the schedule never starts it
//   invalid config   the repo's config, its area or its start setting cannot be read: the rest are still decided
//   error            GitHub failed on this repo: the rest are still decided
//
// The calls, per run: one for each 100 repos of the org (the property list), two for the areas file, and per repo
// the repo (its default branch), its config (`shipyard.yml`, `release.json`, and the branch again for a repo with
// neither). A `manual` repo, and one the rule rejects before it looks at any job or tag (off its weekly day), costs no more. A repo the rule accepts costs three more: the prep jobs since the start (one
// issues call), the newest releases (one call; a repo with no Release adds its tags and one commit) and the comparison
// (one call). No search is ever made.
//
// A pure function of what GitHub holds and the `now` it is given: a rerun in the same hour with nothing changed
// gives the same list.

const { DueError, isDue, latestStart } = require('./due');
const { AreasError, parseAreas } = require('./areas');
const { GitHubError } = require('./github');
const { ReleaseError, parseTag, compareParts } = require('./release-git');
const { loadRepoConfig, NoConfigError, YAML_FILE } = require('./repo-config');
const { resolveConfig, ConfigResolveError } = require('./resolve');
const { loadStart, checkNothingDropped } = require('./start-config');
const { JOB_LABEL } = require('./prep-job');

const PROPERTY = 'release_area';

const oneLine = (s, max = 400) => {
  const t = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const iso = (ms) => new Date(ms).toISOString();

// What the repo's own file says: its cadence, the branch the schedule compares, and the prefix of its release tags.
// Throws a ReleaseError, a ConfigResolveError or a RepoConfigError for a config the start could not use.
async function settingsOf({ github, repo, area, branch, familiesDir, notes }) {
  let loaded;
  try {
    loaded = await loadRepoConfig({ github, repo, ref: branch }, { warn: (line) => notes.push(line) });
  } catch (e) {
    // A repo with neither file may still be named by a family file, which is where its own timer reads `start` from.
    if (!(e instanceof NoConfigError)) throw e;
    loaded = { config: {}, file: null };
    if (!loadStart({ config: {}, repo, familiesDir })) throw e;
  }
  if (loaded.file === YAML_FILE) {
    checkNothingDropped(loaded.errors);
    const { settings, warnings } = resolveConfig(loaded.config, { repo, area, facts: { defaultBranch: branch } });
    for (const w of warnings) notes.push(`${YAML_FILE}: ${w}`);
    return {
      file: loaded.file, cadence: settings.cadence, branch: settings.workBranch, tagPrefix: settings.tagPrefix,
    };
  }
  // A repo still on release.json (or on a family file) names its branches in `start`. The schedule decides one branch
  // per repo: the default branch when `start` lists it, else the first one listed.
  const start = loadStart({ config: loaded.config, repo, familiesDir });
  if (!start) throw new ReleaseError(`${repo} has no start setting: add .github/shipyard.yml, or "start" to its .github/release.json, or list it in a family file`);
  const chosen = start.branches.find((b) => b.name === branch) || start.branches[0];
  if (chosen.name !== branch) notes.push(`start does not list the default branch ${branch}: deciding for ${chosen.name}, the first branch it lists`);
  return {
    file: loaded.file, cadence: chosen.cadence, branch: chosen.name, tagPrefix: start.tagPrefix,
  };
}

// The newest release of the repo by version: `{ tag, at }` (`at` is when it was made) or null. A GitHub Release is read
// first, from the newest page of the repo's Releases (one call), and `at` is when it was published. A repo whose release
// tags have no Release (a library tagged and nothing else) is read from its tags, as lib/newest-release-tag.js reads
// them, and `at` is its commit's date.
async function newestRelease(github, repo, tagPrefix) {
  const found = (await github.listRecentReleases(repo))
    .filter((r) => !r.prerelease)
    .map((r) => ({ ...parseTag(r.tag, tagPrefix), at: r.publishedAt }))
    .filter((r) => r.tag)
    .sort((a, b) => compareParts(a.parts, b.parts));
  if (found.length) return found[found.length - 1];
  const tags = (await github.listTagCommits(repo))
    .map((t) => ({ ...parseTag(t.name, tagPrefix), sha: t.sha }))
    .filter((t) => t.tag)
    .sort((a, b) => compareParts(a.parts, b.parts));
  if (!tags.length) return null;
  const newest = tags[tags.length - 1];
  return { tag: newest.tag, parts: newest.parts, at: newest.sha ? await github.commitDate(repo, newest.sha) : null };
}

const ruleOf = (cadence, area) => {
  if (cadence === 'manual') return 'manual: the schedule never starts it';
  return cadence === 'weekly' ? `weekly, ${area.start} UTC on ${area.weeklyDay}` : `daily, ${area.start} UTC`;
};

/**
 * Decide one repo.
 *
 * @param {object} opts
 * @param {object} opts.github     the client (lib/github.js)
 * @param {string} opts.repo       `<owner>/<name>`
 * @param {string} opts.area       the repo's `release_area` property
 * @param {Record<string, {start: string, weeklyDay: string}>} opts.areas  lib/areas.js's areas
 * @param {number} opts.now        ms since the epoch
 * @param {string} [opts.familiesDir]
 * @returns {Promise<object>} `{ repo, area, decision, rule, since, reason, notes, ... }`
 */
async function decideRepo({
  github, repo, area, areas, now, familiesDir = 'families',
}) {
  const notes = [];
  const out = (decision, reason, more = {}) => ({
    repo, area, decision, rule: null, since: null, reason: oneLine(reason), notes: notes.map((n) => oneLine(n)), ...more,
  });
  try {
    const areaConfig = areas[area];
    if (!areaConfig) {
      return out('invalid config', `the area ${JSON.stringify(oneLine(area, 60))} of its ${PROPERTY} property is not in org/areas.yml, so it has no start time`);
    }
    const branch = await github.defaultBranch(repo);
    if (!branch) return out('invalid config', `${repo} has no default branch GitHub would tell: it was not found`);

    let settings;
    try {
      settings = await settingsOf({
        github, repo, area, branch, familiesDir, notes,
      });
    } catch (e) {
      if (e instanceof ReleaseError || e instanceof ConfigResolveError) {
        return out('invalid config', e.message);
      }
      throw e;
    }
    const rule = ruleOf(settings.cadence, areaConfig);
    const decided = (decision, reason, more = {}) => out(decision, reason, { rule, file: settings.file, cadence: settings.cadence, ...more });

    // The rule first, with no job and no tag: it already says no for a manual repo and for one off its weekly day, and no
    // job or tag can make it say yes, so those repos cost no more calls.
    const first = isDue({ now: new Date(now), area: areaConfig, cadence: settings.cadence });
    const since = settings.cadence === 'manual' ? null : iso(latestStart(now, areaConfig.start));
    if (!first.due) return decided(settings.cadence === 'manual' ? 'manual' : 'not due', first.why, { since });

    const jobs = await github.listIssuesSince(repo, JOB_LABEL, since.replace(/\.\d{3}Z$/, 'Z'));
    const release = await newestRelease(github, repo, settings.tagPrefix);
    const second = isDue({
      now: new Date(now), area: areaConfig, cadence: settings.cadence, prepJobs: jobs, newestTagAt: release ? release.at : null,
    });
    if (!second.due) return decided('not due', second.why, { since });
    if (!release) {
      return decided('due', `${second.why}; the repo has no release yet, so there is nothing to compare: the exact check decides`, { since, newest: null });
    }
    const ahead = await github.compareAhead(repo, release.tag, settings.branch);
    if (!ahead) return decided('error', `GitHub cannot compare ${release.tag} with ${settings.branch}`, { since, newest: release.tag });
    if (ahead.aheadBy === 0) {
      return decided('nothing to ship', `${second.why}; but ${settings.branch} holds nothing ${release.tag}, the newest release, lacks`, { since, newest: release.tag, ahead: 0 });
    }
    return decided('due', `${second.why}; ${ahead.aheadBy} commit${ahead.aheadBy === 1 ? '' : 's'} on ${settings.branch} since ${release.tag}`, { since, newest: release.tag, ahead: ahead.aheadBy });
  } catch (e) {
    if (e instanceof GitHubError || e instanceof DueError) return out('error', e.message);
    throw e;
  }
}

/**
 * The org's release repos: the repos that have the area property set, in name order, and the areas file's areas.
 *
 * @returns {Promise<{areaWarnings: string[], areas: object, repos: Array<{repo: string, area: string}>}>}
 */
async function releaseRepos({
  github, org, areasText, property = PROPERTY,
}) {
  let parsed;
  try {
    parsed = parseAreas(areasText);
  } catch (e) {
    if (e instanceof AreasError) throw new ReleaseError(`org/areas.yml: ${e.message}`);
    throw e;
  }
  const rows = (await github.listOrgPropertyValues(org))
    .filter((r) => typeof r.properties[property] === 'string' && r.properties[property] !== '')
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
  return { areaWarnings: parsed.warnings, areas: parsed.areas, repos: rows.map((r) => ({ repo: r.repo, area: r.properties[property] })) };
}

/**
 * Decide every release repo of the org.
 *
 * @param {object} opts
 * @param {object} opts.github   the client (lib/github.js)
 * @param {string} opts.org
 * @param {string} opts.areasText the text of org/areas.yml
 * @param {number} opts.now      ms since the epoch
 * @param {string} [opts.property] the custom property that names a repo's area (`release_area`)
 * @param {string} [opts.familiesDir]
 * @param {object} [opts.found]  what `releaseRepos` already returned, so the run lists the org's repos once
 * @returns {Promise<{areaWarnings: string[], areas: object, decisions: object[]}>} decisions in the order of the repo names
 */
async function decideAll({
  github, org, areasText, now, property = PROPERTY, familiesDir = 'families', found = null,
}) {
  const { areaWarnings, areas, repos } = found || await releaseRepos({
    github, org, areasText, property,
  });
  const decisions = [];
  for (const row of repos) {
    decisions.push(await decideRepo({
      github, repo: row.repo, area: row.area, areas, now, familiesDir,
    }));
  }
  return { areaWarnings, areas, decisions };
}

// One line a person can compare with the repo's own timer: the decision, the repo, the rule and the date it used.
function lineOf(d) {
  const rule = d.rule ? `rule ${d.rule}` : 'no rule';
  const date = d.since ? `start ${d.since}` : 'no start date';
  return `${d.decision}: ${d.repo} (area ${oneLine(d.area, 60)}; ${rule}; ${date}): ${d.reason}`;
}

module.exports = {
  PROPERTY, decideRepo, decideAll, releaseRepos, lineOf, ruleOf,
};
