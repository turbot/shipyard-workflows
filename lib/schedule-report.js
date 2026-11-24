'use strict';

// The schedule's weekly report: which release repos have shipped work that has waited more than 8 days, and which
// repos' `.github/shipyard.yml` is invalid. It is one issue in the schedule's own repo, titled `Release report <ISO
// week>`, made on the Sunday and updated in place when it is run again that week. It files nothing in any release
// repo's own issues.
//
// Two ways to run it (lib/schedule-command.js):
//
//   --report           build it now and make the week's issue, or update it (the ISO week of now)
//   --report-if-due    what the hourly run does: decide from the clock and the issues whether the week's issue is missing
//
// `--report-if-due` reads the clock first. From Sunday 00:00 UTC to the end of Tuesday the Sunday's ISO week is due, so a
// Sunday run that never happened is made up by Monday's first run, and by Tuesday's if Monday's also failed. Any other day
// makes no call at all. On a due day it makes one issues call (the issues that carry the report label, made since that
// week's Monday); when the week's issue is there, the run stops, and only when it is not does it read the repos.
//
// The report's two lists come from rules this repo already has: a repo waits when `assessRange` (the exact check's own
// rule, lib/start.js) finds a shipped change between its newest release tag and its work branch, and the age is that of
// the oldest such commit; a repo is invalid when the strict validator (lib/config.js, the PR check's) has an error on its
// `shipyard.yml`, or the start cannot use the file or its area.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitHubError } = require('./github');
const { CheckError } = require('./changelog-line');
const { notShippedOf } = require('./changelog-line-command');
const {
  ReleaseError, git, isAncestor, newestReleaseTag, resolveCommit,
} = require('./release-git');
const { parseConfig } = require('./config');
const { YAML_FILE } = require('./repo-config');
const { resolveConfig, ConfigResolveError } = require('./resolve');
const { startOf } = require('./start-config');
const { rangeStart } = require('./first-release');
const { assessRange } = require('./start');

const REPORT_LABEL = 'weekly-release-report';
const WAITING_DAYS = 8;
const DAY_MS = 24 * 60 * 60 * 1000;
const TITLE_PREFIX = 'Release report ';

const oneLine = (s, max = 300) => {
  const t = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

// Text from a repo goes into the issue inside a code span: GitHub shows it as it is, so it can mention no one, open no
// tag and break no table. A backtick in it would end the span, so it becomes an apostrophe.
const code = (s, max = 300) => `\`${oneLine(s, max).replace(/`/g, "'").replace(/\|/g, '/')}\``;

// ---------------------------------------------------------------------------------------------------------------------
// The clock

const dayStart = (ms) => ms - (((ms % DAY_MS) + DAY_MS) % DAY_MS);

// The ISO 8601 week of a moment, in UTC: `2026-W48`. A week runs from Monday to Sunday, and belongs to the year of its Thursday.
function isoWeek(ms) {
  const day = new Date(dayStart(ms));
  const weekday = (day.getUTCDay() + 6) % 7; // Monday is 0
  const thursday = new Date(day.getTime() + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const first = Date.UTC(year, 0, 1);
  const week = Math.floor((thursday.getTime() - first) / DAY_MS / 7) + 1;
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// The Monday 00:00 UTC of a moment's ISO week.
const mondayOf = (ms) => {
  const day = dayStart(ms);
  return day - ((new Date(day).getUTCDay() + 6) % 7) * DAY_MS;
};

/**
 * Which week's report the clock asks for, or null. A Sunday, Monday or Tuesday asks for the ISO week of the Sunday at or
 * before it; every other day asks for none.
 *
 * @param {number} now ms since the epoch
 * @returns {{week: string, sunday: string, monday: number}|null}
 */
function dueWeek(now) {
  const sinceSunday = new Date(now).getUTCDay(); // Sunday is 0
  if (sinceSunday > 2) return null;
  const sunday = dayStart(now) - sinceSunday * DAY_MS;
  return { week: isoWeek(sunday), sunday: new Date(sunday).toISOString(), monday: mondayOf(sunday) };
}

const titleOf = (week) => `${TITLE_PREFIX}${week}`;

// The issue for a week, or null: the one issues call. An issue is found open or closed (a person closing it means "done").
// The API's `since` is on the last update, which is never before the day the issue was made, so the week's Monday holds it.
async function findReport({ github, repo, week, monday }) {
  const since = new Date(monday).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const found = (await github.listIssuesSince(repo, REPORT_LABEL, since)).filter((i) => i.title === titleOf(week));
  return found.sort((a, b) => a.number - b.number)[0] || null;
}

// ---------------------------------------------------------------------------------------------------------------------
// What one repo says

/**
 * `{ repo, area, invalid: string[], waiting: null | {...}, error: string|null }` for one release repo. A repo that fails
 * (its clone, GitHub) is its own `error`, so the others are still read.
 */
async function checkRepo({
  github, repo, area, areas, clone, familiesDir, now,
}) {
  const row = {
    repo, area, invalid: [], waiting: null, error: null,
  };
  if (!areas[area]) row.invalid.push(`the area ${JSON.stringify(oneLine(area, 60))} of its release_area property is not in org/areas.yml, so it has no start time`);
  let dir = null;
  try {
    const branch = await github.defaultBranch(repo);
    if (!branch) {
      row.error = `${repo} has no default branch GitHub would tell: it was not found`;
      return row;
    }
    // The file as the PR check reads it (strictly), at the default branch, as data.
    const text = await github.getFileText(repo, YAML_FILE, branch);
    if (text !== null) {
      const parsed = parseConfig(text, { strict: true });
      row.invalid.push(...parsed.errors.map((e) => oneLine(e)));
      if (!parsed.errors.length && areas[area]) {
        try {
          resolveConfig(parsed.config, { repo, area, facts: { defaultBranch: branch } });
        } catch (e) {
          if (!(e instanceof ConfigResolveError)) throw e;
          row.invalid.push(...e.problems.map((p) => oneLine(p)));
        }
      }
    }

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-report-'));
    await clone({ repo, dir });
    let found;
    try {
      found = await startOf({
        dir, rev: 'HEAD', repo, familiesDir, area, warn: () => {}, defaultBranch: async () => branch,
      });
    } catch (e) {
      if (!(e instanceof ReleaseError)) throw e;
      if (!row.invalid.length) row.invalid.push(oneLine(e.message));
      return row;
    }
    const { start, config, file } = found;
    if (!start) {
      if (!row.invalid.length) row.invalid.push(`${repo} has no start setting: add ${YAML_FILE}`);
      return row;
    }
    const chosen = start.branches.find((b) => b.name === branch) || start.branches[0];
    // No release tag and no firstRelease: nothing has been released, so there is nothing to wait since.
    if (!newestReleaseTag(dir, start.tagPrefix) && (config.firstRelease === undefined || config.firstRelease === null)) return row;
    let range;
    try {
      range = rangeStart(dir, start.tagPrefix, config, file || '.github/release.json');
    } catch (e) {
      // A firstRelease the start cannot use (malformed, or naming no tag or commit): the repo cannot be started.
      if (!(e instanceof ReleaseError)) throw e;
      row.invalid.push(oneLine(e.message));
      return row;
    }
    const tipRef = ['refs/remotes/origin/', 'refs/heads/'].find((p) => git(dir, ['rev-parse', '--verify', '--quiet', `${p}${chosen.name}^{commit}`], { allowFail: true }));
    if (!tipRef) throw new ReleaseError(`${chosen.name} is not in the checkout of ${repo}`);
    const tip = resolveCommit(dir, `${tipRef}${chosen.name}`);
    if (!isAncestor(dir, range.commit, tip)) throw new ReleaseError(`${range.from}, the newest release, is not in the history of ${chosen.name}`);
    const { shipped } = await assessRange({
      dir, repo, github, notShipped: notShippedOf(config, file || '.github/release.json'), from: range.commit, to: tip,
    });
    if (!shipped.length) return row;
    // The commits come newest first: the last is the oldest, and it is the one that has waited the longest.
    const oldest = shipped[shipped.length - 1];
    const at = Date.parse(git(dir, ['log', '-1', '--format=%cI', oldest.sha]).trim());
    if (!Number.isFinite(at)) throw new ReleaseError(`the date of ${oldest.sha.slice(0, 7)} in ${repo} cannot be read`);
    row.waiting = {
      branch: chosen.name, since: range.from, changes: shipped.length, oldest: { sha: oldest.sha, pr: oldest.pr, at: new Date(at).toISOString() }, days: Math.floor((now - at) / DAY_MS), over: now - at > WAITING_DAYS * DAY_MS,
    };
    return row;
  } catch (e) {
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof CheckError)) throw e;
    row.error = oneLine(e.message);
    return row;
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// The issue

// The last line of the issue: which week it is, and the day it was built. The day tells the hourly run whether a report
// that a person made by hand early in the week is older than the Sunday it should show.
const MARKER = /^<!-- shipyard:release-report \S+ built (\d{4}-\d{2}-\d{2}) -->$/m;
const markerOf = (week, day) => `<!-- shipyard:release-report ${week} built ${day} -->`;
const builtOn = (body) => { const m = MARKER.exec(String(body)); return m ? m[1] : null; };
const withoutMarker = (body) => String(body).replace(MARKER, '').trim();

const days = (n) => `${n} day${n === 1 ? '' : 's'}`;

/**
 * The text of the week's issue, from the rows `checkRepo` made and the day it is built (`day`, its last line). Apart from
 * that line it is a pure function of the rows: a rerun with nothing changed gives the same text, so `--report` writes it once.
 */
function renderReport(rows, week, day) {
  const waiting = rows.filter((r) => r.waiting && r.waiting.over).sort((a, b) => b.waiting.days - a.waiting.days || (a.repo < b.repo ? -1 : 1));
  const invalid = rows.filter((r) => r.invalid.length);
  const unread = rows.filter((r) => r.error);
  const out = [];
  if (!waiting.length && !invalid.length) {
    out.push(`Nothing waiting: no release repo has shipped work that has waited more than ${days(WAITING_DAYS)}, and no \`shipyard.yml\` is invalid.`);
  }
  if (waiting.length) {
    out.push(`### Shipped work waiting more than ${days(WAITING_DAYS)}`, '',
      'The age is that of the oldest change since the newest release that ships (the start\'s own rule), whatever the repo\'s cadence.', '',
      '| Repo | Branch | Waiting | Oldest change | Changes | Newest release |', '| --- | --- | --- | --- | --- | --- |');
    for (const r of waiting) {
      const w = r.waiting;
      const oldest = w.oldest.pr !== null ? `#${w.oldest.pr}` : w.oldest.sha.slice(0, 7);
      out.push(`| ${r.repo} | ${code(w.branch, 100)} | ${days(w.days)} | ${oldest}, ${w.oldest.at.slice(0, 10)} | ${w.changes} | ${code(w.since, 60)} |`);
    }
    out.push('');
  }
  if (invalid.length) {
    out.push('### Invalid `shipyard.yml`', '');
    for (const r of invalid) {
      out.push(`- **${r.repo}**`);
      for (const m of r.invalid) out.push(`  - ${code(m)}`);
    }
    out.push('');
  }
  if (unread.length) {
    out.push('### Not checked', '', 'These repos could not be read this time, so the lists above may miss them:', '');
    for (const r of unread) out.push(`- ${r.repo}: ${code(r.error)}`);
    out.push('');
  }
  out.push(markerOf(week, day));
  return `${out.join('\n')}\n`;
}

/**
 * Make or update the week's issue.
 *
 * @param {object} opts
 * @param {object} opts.github     the client; its token makes the issue in `repo`
 * @param {string} opts.repo       where the issue lives (the schedule's own repo)
 * @param {string} opts.week       `2026-W48`
 * @param {number} opts.monday     ms of the week's Monday 00:00 UTC, where the look for the issue starts
 * @param {boolean} opts.updateExisting  `--report`: rewrite the issue when it is there (not when the text is the same)
 * @param {string|null} opts.current  `--report-if-due`: the Sunday's date; an issue built before it is built again. Null: not asked
 * @param {number} opts.now          ms since the epoch
 * @param {() => Promise<object[]>} opts.rows  reads the repos; called only when the issue must be written
 * @returns {Promise<{action: 'created'|'updated'|'unchanged'|'exists', week: string, number: number, url?: string, rows?: object[]}>}
 */
async function postReport({
  github, repo, week, monday, updateExisting, current = null, now, rows,
}) {
  const existing = await findReport({
    github, repo, week, monday,
  });
  // The hourly run leaves an issue that was built on or after `current` (the Sunday's date) as it is. One built earlier
  // (a person ran `--report` in the week) shows the week before its end, so it is built again, once.
  if (existing && !updateExisting && (current === null || (builtOn(existing.body) || '') >= current)) {
    return { action: 'exists', week, number: existing.number };
  }
  const read = await rows();
  const body = renderReport(read, week, new Date(now).toISOString().slice(0, 10));
  if (!existing) {
    const issue = await github.createIssue(repo, { title: titleOf(week), body, labels: [REPORT_LABEL] });
    return {
      action: 'created', week, number: issue.number, url: issue.url, rows: read,
    };
  }
  if (updateExisting && withoutMarker(existing.body) === withoutMarker(body)) return { action: 'unchanged', week, number: existing.number, rows: read };
  await github.updateIssueBody(repo, existing.number, body);
  return { action: 'updated', week, number: existing.number, rows: read };
}

// One line a person can read the run by.
function reportLine(r) {
  const verb = {
    created: 'made', updated: 'updated', unchanged: 'left as it was', exists: 'already made',
  }[r.action] || r.action;
  const counts = r.rows
    ? `: ${r.rows.filter((x) => x.waiting && x.waiting.over).length} waiting, ${r.rows.filter((x) => x.invalid.length).length} invalid, ${r.rows.filter((x) => x.error).length} not checked`
    : '';
  return `release report ${r.week}: issue #${r.number} ${verb}${counts}`;
}

module.exports = {
  REPORT_LABEL, WAITING_DAYS, isoWeek, mondayOf, dueWeek, titleOf, findReport, checkRepo, renderReport, postReport, reportLine,
};
