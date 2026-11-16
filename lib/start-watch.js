'use strict';

// The timeouts of the prep jobs. A job open longer than its limit gets one comment that asks the
// area's approvers to pick a level and start the cut:
//   - no worker took it within 4 hours of the job's being filed;
//   - the run has not answered 2 hours after a worker took it (30 minutes for `release:now`).
//
// A worker took a job when it carries `agent:wip` or is assigned to a person. The run answered
// when the repo has an open release PR (the cut opened it). Each comment carries a marker, so a
// job is asked once for each of the two reasons however often this runs.

const { GitHubError } = require('./github');
const { ReleaseError } = require('./release-git');
const { JOB_LABEL, parseJob } = require('./prep-job');
const { RECENT_MERGE_MS, releasePulls, shippedBy, closeJob } = require('./start');

const HOUR = 60 * 60 * 1000;
const LIMITS = { notTaken: 4 * HOUR, answer: 2 * HOUR, answerNow: 30 * 60 * 1000 };
const WIP_LABEL = 'agent:wip';
const MARKERS = { notTaken: '<!-- shipyard:escalated:not-taken -->', answer: '<!-- shipyard:escalated:no-answer -->' };

const labelNames = (issue) => (Array.isArray(issue.labels) ? issue.labels.map((l) => (typeof l === 'string' ? l : l && l.name)) : []);

// When a worker took the job: the first time it was assigned or labelled `agent:wip`. Null when
// it is not taken now, or is taken but the events do not say when.
function takenAt(issue, events) {
  const taken = (Array.isArray(issue.assignees) && issue.assignees.length > 0) || labelNames(issue).includes(WIP_LABEL);
  if (!taken) return { taken: false, at: null };
  const times = events
    .filter((e) => e && (e.event === 'assigned' || (e.event === 'labeled' && e.label && e.label.name === WIP_LABEL)))
    .map((e) => Date.parse(e.created_at))
    .filter((t) => Number.isFinite(t));
  return { taken: true, at: times.length ? Math.min(...times) : null };
}

const hours = (ms) => (ms >= HOUR ? `${ms / HOUR} hours` : `${ms / 60000} minutes`);

function escalationBody(job, kind, limit) {
  const where = `${job.repo} \`${job.branch}\``;
  const lead = kind === 'notTaken'
    ? `No worker has taken the prep job for ${where} in ${hours(limit)}.`
    : `The prep job for ${where} has had no answer ${hours(limit)} after a worker took it.`;
  // A re-ship has its version already: the ask is to start its cut, not to pick a level.
  const what = job.reship
    ? `start the re-ship cut of ${job.reship.version} (\`shipyard cut --reship ${job.reship.version}\`, or cut.yml with \`reship\`)`
    : 'pick a level (major, minor or patch) and start the cut';
  const ask = job.approvers.length
    ? `${job.approvers.join(' ')}: please ${what}.`
    : `No approvers are named for this repo (\`start.approvers\`). Someone with the release in hand: please ${what}.`;
  return `${lead} ${ask} The cut is in docs/release-cut.md.\n${MARKERS[kind]}\n`;
}

/**
 * @param {object} opts
 * @param {object} opts.jobsGithub  client for the repo the jobs are in
 * @param {string} opts.jobsRepo
 * @param {(repo: string) => object} opts.githubFor  client for a product repo (to see its open release PRs)
 * @param {number} opts.now         ms since the epoch
 * @param {boolean} [opts.dryRun]
 */
async function watchJobs({ jobsGithub, jobsRepo, githubFor, now, dryRun = false }) {
  const results = [];
  for (const issue of await jobsGithub.listOpenIssuesByLabel(jobsRepo, JOB_LABEL)) {
    const job = parseJob(issue.body);
    if (!job) continue; // not one the start filed
    const at = (outcome, reason, more = {}) => ({ job: issue.number, repo: job.repo, branch: job.branch, outcome, reason, ...more });
    try {
      const product = githubFor(job.repo);
      const released = await shippedBy(product, job);
      if (released) {
        if (!dryRun) await closeJob(jobsGithub, jobsRepo, issue.number, `Released as ${released}: ${released} contains this job's commit. Closing the job.`);
        results.push(at(dryRun ? 'would-close' : 'closed', `${released} shipped it`));
        continue;
      }
      // The run answered when the cut opened its release PR: open now, or merged since the job was
      // filed and waiting for its tag.
      const filed = Date.parse(issue.created_at);
      const { open, awaitingTag } = await releasePulls(product, job.repo, {
        tagPrefix: job.tagPrefix, tags: await product.listTags(job.repo), sinceMs: Math.max(now - RECENT_MERGE_MS, Number.isFinite(filed) ? filed : 0),
      });
      if (open.length || awaitingTag.length) {
        results.push(at('answered', open.length ? 'the repo has an open release PR' : 'the release PR merged and waits for its tag'));
        continue;
      }
      const created = Date.parse(issue.created_at);
      if (!Number.isFinite(created)) throw new ReleaseError(`#${issue.number} has no creation time`);
      const events = await jobsGithub.listIssueEvents(jobsRepo, issue.number);
      const taken = takenAt(issue, events);

      let kind = null;
      let limit = null;
      if (!taken.taken) {
        limit = LIMITS.notTaken;
        if (now - created >= limit) kind = 'notTaken';
      } else if (taken.at === null) {
        results.push(at('waiting', 'a worker took it, but the events do not say when'));
        continue;
      } else {
        limit = job.now ? LIMITS.answerNow : LIMITS.answer;
        if (now - taken.at >= limit) kind = 'answer';
      }
      if (!kind) {
        results.push(at('waiting', taken.taken ? 'taken, within its time' : 'not taken yet, within its time'));
        continue;
      }
      const comments = await jobsGithub.listIssueComments(jobsRepo, issue.number);
      if (comments.some((c) => c && typeof c.body === 'string' && c.body.includes(MARKERS[kind]))) {
        results.push(at('already-asked', 'the approvers were asked already', { kind }));
        continue;
      }
      if (!dryRun) await jobsGithub.createIssueComment(jobsRepo, issue.number, escalationBody(job, kind, limit));
      results.push(at(dryRun ? 'would-ask' : 'asked', kind === 'notTaken' ? `no worker took it in ${hours(limit)}` : `no answer ${hours(limit)} after it was taken`, { kind }));
    } catch (e) {
      if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
      results.push(at('error', e.message));
    }
  }
  return results;
}

module.exports = { LIMITS, MARKERS, watchJobs, takenAt, escalationBody };
