'use strict';

// The `release:now` half of the central start: a PR merged in the last few hours that carries the `release:now` label
// makes its repo due now, whatever the area's start time, by the same exact check and filing as the daily rule
// (lib/schedule-file.js).
//
// One search call finds the PRs. Each one is then read on its own:
//   - its repo must be a release repo of the org;
//   - the label must have been added by a person: the PR's events name who added it, and a bot's label files nothing;
//   - a prep job made since the merge that holds the merge commit means the repo is started for this merge already: it is
//     not started again (a job that leaves the change out is no start for it);
//   - the start's own check decides the rest. Where the repo has a `greenCheck` that has not passed on the merge commit,
//     the start says `waiting` or `refused` and files nothing, and every later run asks again.
//
// From WAIT_MS after the merge a run asks one last time and, when the repo is still not started, comments once on the PR
// (a marker in the comment says it was made) naming why, how long it waited and the by-hand command. The run after finds
// the marker and stops. The search looks back WAIT_MS plus three more hours, so a run that fails or is skipped at the
// crossing still leaves the next ones to find the PR, try once more and comment.
//
// In shadow, or for a repo still on `release.json`, nothing is filed and nothing is commented: the line says what would be.

const { GitHubError } = require('./github');
const { JOB_LABEL, parseJob } = require('./prep-job');
const { NOW_LABEL } = require('./start');

const HOUR_MS = 60 * 60 * 1000;
const WAIT_MS = 3 * HOUR_MS;
const SEARCH_MS = WAIT_MS + 3 * HOUR_MS;
const COMMENT_MARKER = '<!-- shipyard:release-now-gave-up -->';

const oneLine = (s, max = 400) => {
  const t = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const seconds = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

// "3 hours 4 minutes", "20 minutes", "under a minute".
function howLong(ms) {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m || !h) parts.push(m ? `${m} minute${m === 1 ? '' : 's'}` : 'under a minute');
  return parts.join(' ');
}

// Who added the label last, from the PR's events: `{ login, person }`, or null when no event names it (events are not
// kept for ever, so a label with no event is no person's: fail closed). A person is a user account, never a bot.
async function labelledBy(github, repo, number) {
  const events = await github.listIssueEvents(repo, number);
  const last = [...events].reverse().find((e) => e && e.event === 'labeled' && e.label && e.label.name === NOW_LABEL);
  if (!last || !last.actor || typeof last.actor.login !== 'string') return null;
  const { login } = last.actor;
  return { login, person: last.actor.type === 'User' && !/\[bot\]$/i.test(login) };
}

// The comment a run makes once it gives up on a PR: why, how long it waited and how to start the repo by hand.
function giveUpComment({ repo, reason, waitedMs, home }) {
  const where = home ? `the \`schedule.yml\` workflow of ${home}` : 'the `schedule.yml` workflow of the repo that holds Shipyard\'s schedule';
  return [
    `Shipyard did not start a release for this PR, which carries \`${NOW_LABEL}\`.`,
    '',
    `This run came ${howLong(waitedMs)} after the merge and did not start a release. Why: ${oneLine(reason, 300).replace(/@/g, '@\u200b')}`,
    '',
    `To start the release now, run ${where} with \`repo=${repo}\`, or run \`shipyard schedule --live --repo ${repo}\`.`,
    COMMENT_MARKER,
    '',
  ].join('\n');
}

// A marker in any comment counts: a person who posts it only silences the one comment this run would make on their own PR.
const gaveUp = (comments) => comments.some((c) => c && typeof c.body === 'string' && c.body.includes(COMMENT_MARKER));

// The prep job, of those made since the merge, that holds the PR's merge commit (its commit is the merge commit or a
// descendant of it), or null. A job at an older commit, or for another change, leaves this PR's change out, so it is no
// start for this PR: the start's own check then decides (it replaces an open job that does not hold the commit).
async function coveringJob(github, repo, number, jobs) {
  if (!jobs.length) return null;
  const pr = await github.getPull(repo, number);
  const merge = pr && pr.merge_commit_sha;
  if (typeof merge !== 'string' || !merge) return null;
  for (const j of jobs) {
    const job = parseJob(j.body);
    if (!job || job.repo.toLowerCase() !== repo.toLowerCase()) continue;
    if (job.commit === merge) return j;
    const status = await github.compareStatus(repo, merge, job.commit);
    if (status === 'ahead' || status === 'identical') return j;
  }
  return null;
}

/**
 * Start the repos of the `release:now` PRs merged lately. One search call; then per PR a few reads and, for the PR a repo
 * is started for, the start's own check and filing.
 *
 * @param {object} opts
 * @param {object} opts.github   the client (lib/github.js); its token is the Start App's
 * @param {string} opts.org
 * @param {Array<{repo: string, area: string}>} opts.repos  the org's release repos
 * @param {object} opts.areas    lib/areas.js's areas, by name
 * @param {number} opts.now      ms since the epoch
 * @param {(row: {repo: string, area: string}, more: object) => Promise<object>} opts.fileOne  lib/schedule-file.js's `fileRepo`, for one repo
 * @param {string} [opts.home]   `<owner>/<name>` of the repo that runs the schedule, named in the comment
 * @returns {Promise<Array<object>>} one `{ repo, pr, outcome, code, reason, ... }` for each PR looked at
 */
async function runReleaseNow({
  github, org, repos, areas, now, fileOne, home = null,
}) {
  const results = [];
  let found;
  try {
    found = await github.searchMergedPulls(org, NOW_LABEL, seconds(now - SEARCH_MS));
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    return [{
      repo: null, pr: null, outcome: 'error', code: 'search-failed', reason: oneLine(`the search for merged ${NOW_LABEL} PRs failed: ${e.message}`), notes: [],
    }];
  }
  const byName = new Map(repos.map((r) => [r.repo.toLowerCase(), r]));
  if (found.incomplete || found.total > found.pulls.length) {
    results.push({
      repo: null, pr: null, outcome: 'error', code: 'search-truncated', reason: `the search for merged ${NOW_LABEL} PRs found ${found.total} and returned ${found.pulls.length}: the rest are not looked at`, notes: [],
    });
  }
  const pulls = found.pulls
    .map((p) => ({ ...p, mergedMs: Date.parse(p.mergedAt) }))
    .filter((p) => Number.isFinite(p.mergedMs) && p.mergedMs >= now - SEARCH_MS && p.mergedMs <= now)
    .sort((a, b) => a.mergedMs - b.mergedMs || (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : a.number - b.number));

  for (const p of pulls) {
    const row = byName.get(p.repo.toLowerCase());
    if (!row) continue; // not a release repo: its own flow handles the label
    const age = now - p.mergedMs;
    const at = (outcome, code, reason, more = {}) => ({
      repo: row.repo, pr: p.number, mergedAt: p.mergedAt, outcome, code, reason: oneLine(reason), notes: [], ...more,
    });
    try {
      if (!areas[row.area]) {
        results.push(at('skipped', 'invalid-area', `the area ${JSON.stringify(oneLine(row.area, 60))} of its release_area property is not in org/areas.yml, so it has no start`));
        continue;
      }
      const by = await labelledBy(github, row.repo, p.number);
      if (!by || !by.person) {
        results.push(at('skipped', 'not-a-person', by ? `the ${NOW_LABEL} label was added by ${oneLine(by.login, 80)}, which is not a person: only a person's label starts a release` : `no event names who added the ${NOW_LABEL} label: only a person's label starts a release`));
        continue;
      }
      const jobs = await github.listIssuesSince(row.repo, JOB_LABEL, seconds(p.mergedMs));
      const since = await coveringJob(github, row.repo, p.number, jobs.filter((j) => Date.parse(j.createdAt) >= p.mergedMs));
      if (since) {
        results.push(at('skipped', 'already-started', `prep job #${since.number} was made since the merge and holds it (${since.createdAt}): the repo is started for it already`, { job: since.number }));
        continue;
      }
      const lastTry = age >= WAIT_MS;
      if (lastTry && gaveUp(await github.listIssueComments(row.repo, p.number))) {
        results.push(at('skipped', 'gave-up', `${howLong(WAIT_MS)} passed since the merge and the PR already says why no release was started`));
        continue;
      }

      const f = await fileOne(row, { pr: p.number, startedAt: new Date(now).toISOString() });
      const done = f.outcome === 'started' || f.outcome === 'would-start';
      const r = at(f.outcome, f.code || f.outcome, f.reason, {
        branch: f.branch, mode: f.mode, ...(f.job ? { job: f.job } : {}), ...(f.title ? { title: f.title } : {}), ...(f.body ? { body: f.body } : {}), ...(f.commit ? { commit: f.commit } : {}), notes: f.notes || [],
      });
      // From 3 hours after the merge, a repo still not started gets one comment on the PR. A prep job open for the branch
      // is a release already on its way, so it needs none.
      if (lastTry && !done && f.code !== 'job-open') {
        if (f.mode === 'live') {
          await github.createIssueComment(row.repo, p.number, giveUpComment({
            repo: row.repo, reason: f.reason, waitedMs: age, home,
          }));
          r.commented = true;
          r.notes.push(`commented on ${row.repo}#${p.number}: ${howLong(age)} since the merge and no release was started`);
        } else {
          r.notes.push(`would comment on ${row.repo}#${p.number}: ${howLong(age)} since the merge and no release was started`);
        }
      }
      results.push(r);
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      results.push(at('error', 'error', e.message));
    }
  }
  return results;
}

const VERBS = {
  started: 'filed', 'would-start': 'would file', skipped: 'not filed', refused: 'not filed', waiting: 'waiting', error: 'error',
};

// One line a person can read the PR's outcome by.
function releaseNowLine(r) {
  if (!r.repo) return `error: release:now search: ${r.reason}`;
  const ago = r.mergedAt ? ` merged ${r.mergedAt}` : '';
  return `${VERBS[r.outcome] || r.outcome}: ${r.repo}#${r.pr} (${r.branch ? `${r.branch}, ` : ''}release:now,${ago}): ${r.reason}`;
}

// Only GitHub failing, or the start failing to run, fails the run: a check that has not passed is the rule working.
const releaseNowFailed = (r) => r.outcome === 'error';

module.exports = {
  runReleaseNow, releaseNowLine, releaseNowFailed, COMMENT_MARKER,
};
