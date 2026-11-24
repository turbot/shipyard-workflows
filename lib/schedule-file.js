'use strict';

// The filing half of the central start: for a repo the schedule calls due (or one a person names), run the exact check
// of `shipyard start` (lib/start.js) on a partial clone, and file the prep job in the product repo through the
// prep-job text. One call to `fileRepo` is one repo; it never throws for what a repo does (a clone that fails, a config
// that cannot be used, GitHub refusing the issue): that is the repo's `error`, so the others are still started.
//
// A run is in shadow or live. Shadow runs the whole check and files nothing (`would file`). Live files only for a repo
// whose default branch already holds `.github/shipyard.yml`; a repo still on `.github/release.json` stays in shadow,
// so it is never started twice while its own timer runs. The only write is the issue that is the prep job: nothing
// dispatches a workflow.
//
// The job's body carries a marker naming the start (lib/prep-job.js), so a person or a tool can tell which start it
// answers. A second run does not file a second job because the due rule sees a job made since the start, open or
// closed, and the start's own check sees an open one for the branch.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { GitHubError } = require('./github');
const { CheckError } = require('./changelog-line');
const { notShippedOf } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { startOf } = require('./start-config');
const { YAML_FILE } = require('./repo-config');
const { profileOf } = require('./light');
const { runStart } = require('./start');

const oneLine = (s, max = 400) => {
  const t = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * @param {object} opts
 * @param {object} opts.github       the client (lib/github.js); it files the job, so its token is the Start App's
 * @param {string} opts.repo         `<owner>/<name>`
 * @param {string} opts.area         the repo's `release_area` property
 * @param {boolean} opts.live        file where the repo may be filed for; else decide and report
 * @param {(opts: {repo: string, dir: string}) => Promise<void>|void} opts.clone  makes the partial clone in `dir`
 * @param {string} opts.familiesDir
 * @param {string} opts.startedAt    the start the job answers (an ISO time): the area's start time, or now for a start by hand
 * @param {number} opts.now          ms since the epoch
 * @param {string} [opts.branch]     a start by hand (`--repo`): this work branch, else the repo's default one. Without it,
 *   the start is the schedule's: its decided branch, on its cadence.
 * @param {string} [opts.cadence]   the cadence the decision named (a start by the schedule), so a repo that fails before its
 *   branch is read still says which start it was
 * @param {boolean} [opts.byHand]
 * @param {number} [opts.pr]         a start for a merged `release:now` PR: that PR's merge commit, whatever the repo's cadence
 *   (even `manual`), through the start's own release:now rule, which waits for no check (a check that has not passed is
 *   `waiting` or `refused`: the caller asks again)
 * @returns {Promise<object>} `{ repo, area, branch, trigger, outcome, reason, notes, mode, ... }`; outcome is
 *   `started`, `would-start`, `skipped`, `refused` or `error`
 */
async function fileRepo({
  github, repo, area, live, clone, familiesDir, startedAt, now, branch, cadence = null, byHand = false, pr = null,
}) {
  const notes = [];
  // `live` once the run knows it may file for this repo, so a refusal or an error after that says so too.
  let mode = 'shadow';
  const base = { repo, area, branch: branch || null, trigger: byHand ? 'by hand' : pr !== null ? 'release:now' : cadence };
  const result = (outcome, reason, more = {}) => ({
    ...base, outcome, reason: oneLine(reason), notes: notes.map((n) => oneLine(n)), mode, ...more,
  });
  let dir = null;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-schedule-'));
    await clone({ repo, dir });
    const defaultBranch = await github.defaultBranch(repo);
    if (!defaultBranch) throw new ReleaseError(`${repo} has no default branch GitHub would tell: it was not found`);
    const { start, config, file } = await startOf({
      dir, rev: 'HEAD', repo, familiesDir, area, warn: (line) => notes.push(line), defaultBranch: async () => defaultBranch,
    });
    if (!start) throw new ReleaseError(`${repo} has no start setting: add .github/shipyard.yml, or "start" to its .github/release.json, or list it in a family file`);
    // The branch the schedule decides for a repo: the default branch when `start` lists it, else the first one listed.
    const chosen = start.branches.find((b) => b.name === defaultBranch) || start.branches[0];
    base.branch = branch || chosen.name;
    if (profileOf(config, file || '.github/release.json') === 'light') {
      return result('skipped', 'a light repo: the schedule does not start it, and its caller cuts it', { code: 'light' });
    }
    if (!byHand && pr === null && chosen.cadence === 'manual') return result('skipped', 'the repo\'s cadence is manual: the schedule never starts it', { code: 'manual' });
    base.trigger = byHand ? 'by hand' : pr !== null ? 'release:now' : chosen.cadence;
    const select = pr !== null ? { pr } : byHand ? { branch: base.branch } : { cadence: chosen.cadence, only: chosen.name };

    const mayFile = live && file === YAML_FILE;
    if (mayFile) mode = 'live';
    if (live && !mayFile) notes.push(`stays in shadow: its default branch holds no ${YAML_FILE} (it is on ${file || 'no config file'}), so its own timer still starts it`);
    const results = await runStart({
      dir, repo, github, jobsGithub: github, jobsRepo: repo, start, notShipped: notShippedOf(config, file || '.github/release.json'), config, select, dryRun: !mayFile, startedAt, now: () => now,
    });
    const r = results[0];
    if (!r) return result('skipped', `no branch of ${repo} starts ${base.trigger}`, { code: 'no-branch' });
    return result(r.outcome, r.reason, {
      ...(r.code ? { code: r.code } : {}),
      ...(r.title ? { title: r.title } : {}),
      ...(r.body ? { body: r.body } : {}),
      ...(r.job ? { job: r.job } : {}),
      ...(r.url ? { url: r.url } : {}),
      ...(r.commit ? { commit: r.commit } : {}),
      ...(r.from ? { from: r.from } : {}),
      ...(r.pulls ? { pulls: r.pulls } : {}),
      branch: r.branch,
      trigger: r.trigger,
      mode: mayFile ? 'live' : 'shadow',
      // a note runStart made (a prep job it closed) comes after the ones made here
      notes: [...notes, ...(r.notes || []).filter((n) => !notes.includes(n))].map((n) => oneLine(n)),
    });
  } catch (e) {
    if (e instanceof Refusal) return result('refused', e.message, { code: 'refused' });
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof CheckError)) throw e;
    return result('error', e.message, { code: 'error' });
  } finally {
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  }
}

const VERBS = {
  started: 'filed', 'would-start': 'would file', skipped: 'not filed', refused: 'refused', error: 'error', waiting: 'waiting',
};

// One line a person can read the filing by: what was done, for which repo and branch, and why.
function filingLine(f) {
  return `${VERBS[f.outcome] || f.outcome}: ${f.repo} (${f.branch ? `${f.branch}, ` : ''}${f.trigger || 'no trigger'}): ${f.reason}`;
}

// A filing that failed: the run exits non-zero and names it.
const failed = (f) => f.outcome === 'error' || f.outcome === 'refused';

module.exports = { fileRepo, filingLine, failed };
