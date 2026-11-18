'use strict';

// The release start: for each branch a trigger selects, decide whether a release should start
// and, when it should, file the prep job in this repo.
//
// A branch starts only when a shipped change is waiting since its newest release tag: a path
// not on the repo's `notShipped`, and not dependency bumps alone (unless a bump fixes a known
// advisory). An open release PR of the repo is never stacked on: the start skips the branch
// and says so in its output, and writes nothing to that PR. `release:now` starts at once, after
// the repo's full check has passed on the PR's merge commit where the repo names one.
//
// The PR and the checkout are data. Nothing a PR's text says is run; its body decides one
// thing only, whether a dependency bump names an advisory.

const { GitHubError } = require('./github');
const { prShipsNothing } = require('./changelog-line-command');
const { createMatcher } = require('./not-shipped');
const { isDependencyOnly } = require('./facts');
const {
  ReleaseError, Refusal, git, parseTag, compareParts, resolveCommit, isAncestor, rangeCommits, prNumberOf,
} = require('./release-git');
const {
  JOB_LABEL, jobTitle, jobBody, parseJob, reshipTitle, reshipJobBody,
} = require('./prep-job');
const { waitingRelease, failedRunFromChecks } = require('./reship');
const { cutPin } = require('./pin');
const { rangeStart } = require('./first-release');

const NOW_LABEL = 'release:now';

// A bump fixes a known advisory when its PR says so: the `security` label, Dependabot's own
// note that the update includes security fixes, or an advisory id in the title.
const ADVISORY_LABELS = new Set(['security']);
const ADVISORY_NOTE = /\b(?:this update includes security fixes|vulnerabilit(?:y|ies) fixed)\b/i;
const ADVISORY_ID = /\b(?:GHSA(?:-[2-9cfghjmpqrvwx]{4}){3}|CVE-\d{4}-\d{4,})\b/i;

function fixesAdvisory(pr) {
  const labels = Array.isArray(pr.labels) ? pr.labels.map((l) => String(l && l.name)) : [];
  return labels.some((l) => ADVISORY_LABELS.has(l.toLowerCase()))
    || ADVISORY_NOTE.test(String(pr.body || ''))
    || ADVISORY_ID.test(String(pr.title || ''));
}

// The files one commit changes against its first parent, a rename counting both paths.
function commitFiles(dir, sha) {
  return git(dir, ['diff', '--name-only', '--no-renames', '-z', `${sha}^1`, sha]).split('\0').filter(Boolean);
}

/**
 * What the range holds that ships. `shipped` lists each PR (or commit with no PR) that does,
 * `bumps` the dependency bumps that do not count alone, `ignored` how many ship nothing.
 */
async function assessRange({ dir, repo, github, notShipped, from, to }) {
  const matches = notShipped.length ? createMatcher(notShipped) : () => false;
  const shipped = [];
  const bumps = [];
  let ignored = 0;
  for (const c of rangeCommits(dir, from, to)) {
    const n = prNumberOf(c.subject);
    if (n !== null) {
      let pr = null;
      try {
        pr = await github.getPull(repo, n);
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 404) throw e;
      }
      if (pr && pr.merged_at) {
        if (notShipped.length && (await prShipsNothing(github, repo, n, notShipped)).shipsNothing) ignored += 1;
        else if (!isDependencyOnly(pr)) shipped.push({ pr: n, sha: c.sha, why: 'a change that ships' });
        else if (fixesAdvisory(pr)) shipped.push({ pr: n, sha: c.sha, why: 'a bump that fixes a known advisory' });
        else bumps.push(n);
        continue;
      }
    } else if (c.parents > 1) {
      continue; // a merge with no PR (a back-merge) holds no change of its own
    }
    // A commit with no merged PR: judged by its own files.
    const files = commitFiles(dir, c.sha);
    if (files.length && !files.every(matches)) shipped.push({ pr: null, sha: c.sha, why: 'a commit with no pull request' });
    else ignored += 1;
  }
  return { shipped, bumps: bumps.sort((a, b) => a - b), ignored };
}

// The state of the repo's full check on a commit: its check runs and commit statuses of that
// name. `pass` only when every one that reported succeeded; `waiting` while one is still going or
// none has reported yet; `fail` otherwise.
async function checkState(github, repo, sha, name) {
  const runs = (await github.listCheckRuns(repo, sha)).filter((r) => r && r.name === name);
  const statuses = (await github.listCommitStatuses(repo, sha)).filter((s) => s && s.context === name);
  if (!runs.length && !statuses.length) return { state: 'waiting', detail: `${name} has not reported on ${sha.slice(0, 7)} yet` };
  if (runs.some((r) => r.status !== 'completed') || statuses.some((s) => s.state === 'pending')) {
    return { state: 'waiting', detail: `${name} is still running on ${sha.slice(0, 7)}` };
  }
  // A re-run of a check leaves the older run beside it: the newest run (highest id) decides.
  const latest = [...runs].sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
  const failed = (latest && latest.conclusion !== 'success') || statuses.some((s) => s.state !== 'success');
  return failed
    ? { state: 'fail', detail: `${name} did not pass on ${sha.slice(0, 7)}` }
    : { state: 'pass', detail: `${name} passed on ${sha.slice(0, 7)}` };
}

const sameRepo = (p, repo) => p && p.head && p.head.repo && String(p.head.repo.full_name).toLowerCase() === repo.toLowerCase();

// The release PRs of a repo that still own it: those open (from a `release/...` branch of the
// same repo), and those that merged lately and wait for their tag (`release/1.5.0` merged,
// `v1.5.0` not made yet). Whatever base they target: `shipyard cut` opens its PR into `main`
// even when it was cut from `develop`, and a release takes its number from the newest tag, so
// one in flight holds every branch of the repo. A fork that names its branch the same is none.
// Neither kind is stacked on. `tags` are the repo's tag names; `sinceMs` is the oldest merge
// that counts.
const RECENT_MERGE_MS = 14 * 24 * 60 * 60 * 1000;
async function releasePulls(github, repo, { tagPrefix, tags, sinceMs }) {
  const own = (p) => sameRepo(p, repo) && /^release\//.test(String(p.head.ref));
  const open = (await github.listOpenPulls(repo)).filter(own);
  const have = new Set(tags);
  const awaitingTag = (await github.listRecentClosedPulls(repo)).filter((p) => {
    const version = /^release\/(\d+\.\d+\.\d+)$/.exec(String(p.head && p.head.ref));
    const mergedAt = Date.parse(p.merged_at);
    return own(p) && version && Number.isFinite(mergedAt) && mergedAt >= sinceMs && !have.has(`${tagPrefix}${version[1]}`);
  });
  return { open, awaitingTag };
}

// The release tag that shipped what a prep job was filed for, or null while it has not. The
// release is out once a release tag newer than the job's range start contains the job's commit.
// The oldest few newer tags are asked, so a repo with many tags costs a bounded number of calls.
const MAX_TAGS_ASKED = 20;
// A first release's job starts at no release tag, so every release tag is newer than its start.
async function shippedBy(github, job) {
  const from = job.firstRelease ? null : parseTag(job.from, job.tagPrefix);
  const newer = (await github.listTags(job.repo))
    .map((t) => parseTag(t, job.tagPrefix))
    .filter((t) => t && (!from || compareParts(t.parts, from.parts) > 0))
    .sort((a, b) => compareParts(a.parts, b.parts))
    .slice(0, MAX_TAGS_ASKED);
  for (const t of newer) {
    const status = await github.compareStatus(job.repo, job.commit, t.tag);
    if (status === 'ahead' || status === 'identical') return t.tag;
  }
  return null;
}

// Why a branch is skipped while a release PR is open. It is a line in the start's output and
// summary; nothing is written to the PR, so the start needs no more than `pull-requests: read`.
function openPullReason(open) {
  const numbers = open.map((p) => `#${p.number}`);
  return `release PR${numbers.length > 1 ? 's' : ''} ${numbers.join(', ')} ${numbers.length > 1 ? 'are' : 'is'} open. A release is never started on top of an open one.`;
}

// Closes a prep job with a comment that says why. Nothing else closes one.
async function closeJob(jobsGithub, jobsRepo, number, why) {
  await jobsGithub.createIssueComment(jobsRepo, number, `${why}\n`);
  await jobsGithub.closeIssue(jobsRepo, number);
}

/**
 * @param {object} opts
 * @param {string} opts.dir          the product repo's checkout, with its tags and branches
 * @param {string} opts.repo         `<owner>/<name>`
 * @param {object} opts.github       client for the product repo
 * @param {object} opts.jobsGithub   client for the repo the prep jobs are filed in
 * @param {string} opts.jobsRepo     `<owner>/<name>` of that repo
 * @param {object} opts.start        the repo's parsed start setting (lib/start-config.js)
 * @param {string[]} opts.notShipped the repo's `notShipped` patterns
 * @param {object} [opts.config]     the repo's `.github/release.json`, for its `firstRelease` (lib/first-release.js)
 * @param {{cadence?: string, branch?: string, pr?: number}} opts.select  one trigger
 * @param {boolean} [opts.dryRun]    decide and report; write nothing
 * @param {number} [opts.waitMs]     how long release:now may wait for its full check, polling every `pollMs`
 * @returns {Promise<Array<{branch: string, outcome: string, reason: string}>>}
 */
async function runStart({
  dir, repo, github, jobsGithub, jobsRepo, start, notShipped, config = {}, select, dryRun = false, waitMs = 0, pollMs = 60000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (select.reship !== undefined) {
    return [await startReship({
      dir, repo, github, jobsGithub, jobsRepo, start, config, version: select.reship, dryRun,
    })];
  }
  let targets;
  if (select.pr !== undefined) {
    const pr = await github.getPull(repo, select.pr);
    if (!pr.merged_at) throw new Refusal(`${repo}#${select.pr} is not merged: release:now starts from a merged PR`);
    if (!Array.isArray(pr.labels) || !pr.labels.some((l) => l && l.name === NOW_LABEL)) {
      throw new Refusal(`${repo}#${select.pr} does not carry the ${NOW_LABEL} label`);
    }
    const branch = pr.base && pr.base.ref;
    if (!start.branches.some((b) => b.name === branch)) throw new Refusal(`${repo}#${select.pr} merged into ${branch}, which the repo's start setting does not list`);
    if (typeof pr.merge_commit_sha !== 'string' || !/^[0-9a-f]{40}$/.test(pr.merge_commit_sha)) {
      throw new ReleaseError(`${repo}#${select.pr} has no merge commit to start from`);
    }
    targets = [{ branch, trigger: 'release:now', commit: pr.merge_commit_sha }];
  } else if (select.branch !== undefined) {
    if (!start.branches.some((b) => b.name === select.branch)) throw new Refusal(`${select.branch} is not a branch the repo's start setting lists`);
    targets = [{ branch: select.branch, trigger: 'by hand' }];
  } else {
    targets = start.branches.filter((b) => b.cadence === select.cadence).map((b) => ({ branch: b.name, trigger: select.cadence }));
  }

  let openJobs = [];
  const results = [];
  for (const target of targets) {
    const { branch, trigger } = target;
    const notes = [];
    const at = (outcome, reason, more = {}) => ({ branch, trigger, outcome, reason, notes, ...more });
    try {
      // Steps 1 to 3 decide whether this branch can start now. They are read again after a wait
      // for the full check, since a release PR or a job may have appeared meanwhile.
      const finish = (result) => ({ done: result });
      const gate = async () => {
        // 1. An open release PR is never stacked on.
        const tags = git(dir, ['tag', '--list']).split('\n').map((x) => x.trim()).filter(Boolean);
        const { open, awaitingTag } = await releasePulls(github, repo, { tagPrefix: start.tagPrefix, tags, sinceMs: now() - RECENT_MERGE_MS });
        if (!open.length && awaitingTag.length) {
          return finish(at('skipped', `release PR ${awaitingTag.map((p) => `#${p.number}`).join(', ')} merged and waits for its tag`, { code: 'release-pr-merged', pulls: awaitingTag.map((p) => p.number) }));
        }
        if (open.length) return finish(at('skipped', openPullReason(open), { code: 'release-pr-open', pulls: open.map((p) => p.number) }));

        // 2. A prep job already open for the branch is the start already made, unless its release
        // has shipped (it is then closed here) or release:now has a newer commit to start at.
        // Listed each time, so a start that ran during a wait is seen.
        openJobs = (await jobsGithub.listOpenIssuesByLabel(jobsRepo, JOB_LABEL))
          .map((i) => ({ number: i.number, job: parseJob(i.body) })).filter((j) => j.job);
        const live = [];
        for (const j of openJobs.filter((o) => o.job.repo.toLowerCase() === repo.toLowerCase() && o.job.branch === branch)) {
          const tag = await shippedBy(github, j.job);
          if (!tag) {
            live.push(j);
          } else if (dryRun) {
            notes.push(`would close prep job #${j.number}: ${tag} shipped it`);
          } else {
            await closeJob(jobsGithub, jobsRepo, j.number, `Released as ${tag}: ${tag} contains this job's commit. Closing it so the branch can start again.`);
            openJobs = openJobs.filter((o) => o !== j);
            notes.push(`closed prep job #${j.number}: ${tag} shipped it`);
          }
        }
        // release:now starts at its own commit with its own limits, so it replaces an open job. Not a
        // job that already holds its commit (the same start run again, or a later one): that would
        // move the release back to an older commit and leave a newer change out.
        const covered = trigger === 'release:now' && live.some((j) => isAncestor(dir, target.commit, j.job.commit));
        if (live.length && (trigger !== 'release:now' || covered)) {
          return finish(at('skipped', `prep job #${live[0].number} is already open for this branch`, { code: 'job-open', job: live[0].number }));
        }
        const superseded = live; // release:now starts at its own commit, with its own limits

        // 3. A shipped change is waiting.
        const tipRef = ['refs/remotes/origin/', 'refs/heads/'].find((p) => git(dir, ['rev-parse', '--verify', '--quiet', `${p}${branch}^{commit}`], { allowFail: true }));
        if (!tipRef) throw new ReleaseError(`${branch} is not in the checkout: fetch it first`);
        const tip = resolveCommit(dir, `${tipRef}${branch}`);
        const commit = target.commit ? resolveCommit(dir, target.commit) : tip;
        if (!isAncestor(dir, commit, tip)) throw new ReleaseError(`${commit.slice(0, 7)} is not in the history of ${branch}: fetch it first`);
        // Where `facts` and `cut` start the range: the newest release tag, or the repo's first release.
        const range = rangeStart(dir, start.tagPrefix, config);
        if (range.ignored && !notes.includes(range.ignored)) notes.push(range.ignored);
        const { from: fromTag, commit: from, first } = range;
        if (!isAncestor(dir, from, commit)) {
          // `cut` refuses facts that do not start at the newest release tag, so a job from an older
          // one could never be cut.
          if (first) return finish(at('refused', `${fromTag}, where firstRelease starts the first release, is not in the history of ${branch}`, { code: 'tag-outside-history' }));
          return finish(at('refused', `${fromTag}, the newest release tag, is not in the history of ${branch}: merge the branch it was cut on back first`, { code: 'tag-outside-history' }));
        }
        const { shipped, bumps, ignored } = await assessRange({ dir, repo, github, notShipped, from, to: commit });
        if (!shipped.length) {
          const why = bumps.length ? `only dependency bumps since ${fromTag} (${bumps.map((n) => `#${n}`).join(', ')}), none for an advisory`
            : ignored ? `nothing that ships since ${fromTag}: ${ignored} change${ignored === 1 ? '' : 's'} ship nothing`
              : `no change since ${fromTag}`;
          return finish(at('skipped', why, { code: 'nothing-shipped', bumps }));
        }
        return { commit, fromTag, first, shipped, bumps, superseded };
      };
      let ready = await gate();
      if (ready.done) {
        results.push(ready.done);
        continue;
      }

      // 4. release:now waits for the full check, where the repo has one.
      if (trigger === 'release:now' && start.greenCheck) {
        let green = await checkState(github, repo, ready.commit, start.greenCheck);
        // The merge event fires before the full check reports: wait for it, up to the deadline.
        const deadline = now() + waitMs;
        let waited = false;
        while (green.state === 'waiting' && now() + pollMs <= deadline) {
          await sleep(pollMs);
          waited = true;
          green = await checkState(github, repo, ready.commit, start.greenCheck);
        }
        if (green.state === 'waiting') {
          results.push(at('waiting', green.detail, { code: 'check-waiting' }));
          continue;
        }
        if (green.state === 'fail') {
          results.push(at('refused', green.detail, { code: 'check-failed' }));
          continue;
        }
        if (waited) {
          ready = await gate();
          if (ready.done) {
            results.push(ready.done);
            continue;
          }
        }
      }
      const { commit, fromTag, first, shipped, bumps, superseded } = ready;

      // 5. File the job.
      const title = jobTitle({ repo, branch, commit });
      const body = jobBody({ repo, branch, commit, trigger, from: fromTag, tagPrefix: start.tagPrefix, shipped, bumps, approvers: start.approvers, pin: cutPin(dir, commit), firstRelease: first ? first.version : null });
      if (dryRun) {
        results.push(at('would-start', `would file "${title}" for ${shipped.length} shipped change${shipped.length === 1 ? '' : 's'}`, { code: 'dry-run', title }));
        continue;
      }
      const issue = await jobsGithub.createIssue(jobsRepo, { title, body, labels: [JOB_LABEL] });
      openJobs.push({ number: issue.number, job: parseJob(body) });
      for (const old of superseded) {
        await closeJob(jobsGithub, jobsRepo, old.number, `Superseded by #${issue.number}: a release:now PR starts this branch at ${commit.slice(0, 7)}.`);
        openJobs = openJobs.filter((o) => o !== old);
        notes.push(`closed prep job #${old.number}: superseded`);
      }
      results.push(at('started', `filed prep job #${issue.number}: ${title}`, { code: 'started', job: issue.number, url: issue.url, commit, from: fromTag }));
    } catch (e) {
      if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
      results.push(at('error', e.message, { code: 'error' }));
    }
  }
  return results;
}

/**
 * A re-ship's start (lib/reship.js), by hand, for a version whose release PR merged and whose ship
 * run on the merge failed: it files the job that names the version, the PR and the run, and that
 * asks for the re-ship cut, not a prep run. Refused when the version is tagged, when its PR has not
 * merged, or when no ship run on the merge failed. Skipped while another release PR is open or a job
 * for the same branch is open. Returns one result, as a branch's in `runStart`.
 */
async function startReship({
  dir, repo, github, jobsGithub, jobsRepo, start, config, version, dryRun,
}) {
  let branch = null;
  const notes = [];
  const at = (outcome, reason, more = {}) => ({ branch: branch || `release/${version}`, trigger: 're-ship', outcome, reason, notes, ...more });
  try {
    const tag = `${start.tagPrefix}${version}`;
    const tagged = Boolean(git(dir, ['tag', '--list', tag]).trim());
    let release;
    let run;
    try {
      release = await waitingRelease({ github, repo, tagPrefix: start.tagPrefix, version, tagged });
      branch = release.base;
      run = await failedRunFromChecks({ github, repo, release });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      return at('refused', e.message, { code: 'reship-refused' });
    }
    // Another release in flight is never stacked on, as for any start.
    const open = (await github.listOpenPulls(repo)).filter((p) => sameRepo(p, repo) && /^release\//.test(String(p.head.ref)));
    if (open.length) {
      return at('skipped', openPullReason(open), { code: 'release-pr-open', pulls: open.map((p) => p.number) });
    }
    const jobs = (await jobsGithub.listOpenIssuesByLabel(jobsRepo, JOB_LABEL))
      .map((i) => ({ number: i.number, job: parseJob(i.body) }))
      .filter((j) => j.job && j.job.repo.toLowerCase() === repo.toLowerCase() && j.job.branch === branch);
    if (jobs.length) return at('skipped', `prep job #${jobs[0].number} is already open for this branch`, { code: 'job-open', job: jobs[0].number });

    const tipRef = ['refs/remotes/origin/', 'refs/heads/'].find((p) => git(dir, ['rev-parse', '--verify', '--quiet', `${p}${branch}^{commit}`], { allowFail: true }));
    if (!tipRef) throw new ReleaseError(`${branch} is not in the checkout: fetch it first`);
    const commit = resolveCommit(dir, `${tipRef}${branch}`);
    if (!isAncestor(dir, release.mergeCommit, commit)) throw new ReleaseError(`${release.mergeCommit.slice(0, 7)}, the merge of #${release.pr}, is not in the history of ${branch}: fetch it first`);
    const range = rangeStart(dir, start.tagPrefix, config);

    const title = reshipTitle({ repo, tag, branch, commit });
    const body = reshipJobBody({
      repo, branch, commit, from: range.from, tagPrefix: start.tagPrefix, approvers: start.approvers, release, run, firstRelease: range.first ? range.first.version : null,
    });
    if (dryRun) return at('would-start', `would file "${title}": #${release.pr} merged and its ship run ${run.id} failed`, { code: 'dry-run', title });
    const issue = await jobsGithub.createIssue(jobsRepo, { title, body, labels: [JOB_LABEL] });
    return at('started', `filed prep job #${issue.number}: ${title}`, {
      code: 'started', job: issue.number, url: issue.url, commit, from: range.from, reship: { version, pr: release.pr, run: run.id },
    });
  } catch (e) {
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    return at('error', e.message, { code: 'error' });
  }
}

module.exports = { startReship, shippedBy, closeJob, NOW_LABEL, runStart, assessRange, checkState, fixesAdvisory };
