'use strict';

// The ship signal of a repo that deploys on merge (docs/release-deployment.md): the production deployment of the merge
// commit reports success. It is the status GitHub keeps for a deployment, which Vercel posts for each deploy of a commit.
// A repo with no deployments signals on the merge, as a Go library does, after a short wait for the first one to appear.
// Reads GitHub only; nothing from the repo is run.

const DEFAULT_ENVIRONMENT = 'production';
// A deployment is made a few seconds after the push, so the commit may have none yet when the merge is seen.
const DEFAULT_GRACE_MS = 2 * 60 * 1000;
const DEFAULT_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 15 * 1000;

const FAILED = new Set(['failure', 'error']);
const OPEN = new Set(['queued', 'pending', 'in_progress']);

// The newest deployment of the environment for the commit: GitHub numbers them upwards, so the highest id. The environment
// matches by its name's start, case apart, so `Production` and `Production – docs` (a monorepo's project) both count.
function newestOf(deployments, sha, environment) {
  const want = environment.toLowerCase();
  const own = deployments
    .filter((d) => d && d.sha === sha && typeof d.environment === 'string' && d.environment.toLowerCase().startsWith(want) && Number.isSafeInteger(d.id))
    .sort((a, b) => b.id - a.id);
  return own[0] || null;
}

// A deployment's state: its newest status that is not `inactive` (a superseded deployment turns inactive after it was live),
// or `pending` while it has none yet.
function stateOf(statuses) {
  const live = (statuses || []).find((s) => s && s.state !== 'inactive');
  return live && typeof live.state === 'string' ? live.state : 'pending';
}

/**
 * Looks at the commit's production deployment once. Returns `{ state, detail }` with state `success`, `failure`,
 * `waiting` (it has not finished) or `none` (the commit has no deployment of that environment).
 */
async function deploymentState({ github, repo, sha, environment = DEFAULT_ENVIRONMENT }) {
  const newest = newestOf(await github.listDeployments(repo, sha), sha, environment);
  if (!newest) return { state: 'none', detail: `${sha.slice(0, 7)} has no ${environment} deployment` };
  const state = stateOf(await github.listDeploymentStatuses(repo, newest.id));
  if (state === 'success') return { state: 'success', detail: `the ${environment} deployment ${newest.id} of ${sha.slice(0, 7)} reported success` };
  if (FAILED.has(state)) return { state: 'failure', detail: `the ${environment} deployment ${newest.id} of ${sha.slice(0, 7)} reported ${state}` };
  if (OPEN.has(state)) return { state: 'waiting', detail: `the ${environment} deployment ${newest.id} of ${sha.slice(0, 7)} is ${state.replace('_', ' ')}` };
  return { state: 'waiting', detail: `the ${environment} deployment ${newest.id} of ${sha.slice(0, 7)} reported ${String(state).slice(0, 20)}, which is not a result` };
}

/**
 * Waits for the signal. `success` when the production deployment reported it, `none` when the commit has no such
 * deployment after the grace (the signal is then the merge), `failure` when it failed, `waiting` when it had not finished
 * by the deadline. The clock and the sleep are the caller's, so a test never waits.
 */
async function awaitDeployment({
  github, repo, sha, environment = DEFAULT_ENVIRONMENT, waitMs = DEFAULT_WAIT_MS, graceMs = DEFAULT_GRACE_MS, pollMs = DEFAULT_POLL_MS,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const started = now();
  const deadline = started + waitMs;
  for (;;) {
    const seen = await deploymentState({ github, repo, sha, environment });
    if (seen.state === 'success' || seen.state === 'failure') return seen;
    if (seen.state === 'none' && now() - started >= graceMs) return seen;
    if (now() + pollMs > deadline) {
      return seen.state === 'none' ? seen : { state: 'waiting', detail: seen.detail };
    }
    await sleep(pollMs);
  }
}

module.exports = {
  DEFAULT_ENVIRONMENT, DEFAULT_GRACE_MS, DEFAULT_WAIT_MS, DEFAULT_POLL_MS, newestOf, stateOf, deploymentState, awaitDeployment,
};
