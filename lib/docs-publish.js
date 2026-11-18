'use strict';

// A docs repo's publish (workflows/docs-publish.yml, `shipyard docs-publish`). A merge to the docs repo's `main` publishes the
// site: it calls the site's Vercel deploy hook, starts the site's workflows, and records the result as a GitHub deployment
// of the merge commit in `production`, which is what the light release's ship signal (lib/deployment.js) reads. The site's
// build is another repo's, so this file only reads it: the newest production deployment of the site that is newer than the
// publish's own start, and, for a site that builds from a workflow, that workflow's run.
//
// "Newer than the start" is a number, never a time: GitHub numbers deployments and runs upwards, so the highest id seen
// before the publish starts is the line, and a runner clock that is a minute out cannot take an earlier build for this one.

const { stateOf } = require('./deployment');

class PublishError extends Error {}

const SITE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const WORKFLOW = /^[A-Za-z0-9._-]+\.ya?ml$/;
// Vercel's deploy hook: a URL that is itself the secret, so it is checked and never quoted.
const HOOK_HOST = 'api.vercel.com';
const HOOK_PATH = '/v1/integrations/deploy/';
const SITE_URL = /^https:\/\/[A-Za-z0-9](?:[A-Za-z0-9.-]{0,120}[A-Za-z0-9])?(?::\d{1,5})?(?:\/[A-Za-z0-9._~/-]{0,100})?$/;
const INPUT_NAME = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_INPUTS = 20;
const MAX_INPUT_VALUE = 200;

const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 20 * 1000;

const FAILED = new Set(['failure', 'error']);
const OPEN = new Set(['queued', 'pending', 'in_progress']);

function checkSite(site) {
  if (typeof site !== 'string' || !SITE.test(site)) throw new PublishError('--site is the site repo, as <owner>/<name>');
  return site;
}

function checkSiteUrl(url) {
  if (typeof url !== 'string' || !SITE_URL.test(url)) throw new PublishError('--site-url is the site\'s address, such as https://powerpipe.io');
  return url;
}

function checkWorkflow(workflow, flag) {
  if (typeof workflow !== 'string' || !WORKFLOW.test(workflow)) throw new PublishError(`${flag} is the file name of a workflow of the site, such as update-search-records.yml`);
  return workflow;
}

// The deploy hook is a secret. Only Vercel's own host, over https, is called with it, and no message here quotes it.
function checkHook(hook) {
  let url;
  try {
    url = new URL(hook);
  } catch {
    throw new PublishError('the deploy hook is not a URL');
  }
  if (url.protocol !== 'https:' || url.hostname !== HOOK_HOST || url.username || url.password || url.port || !url.pathname.startsWith(HOOK_PATH) || url.pathname.length === HOOK_PATH.length) {
    throw new PublishError(`the deploy hook must be a Vercel deploy hook, https://${HOOK_HOST}${HOOK_PATH}...`);
  }
  return url.href;
}

// The production workflow's inputs: a JSON object of short strings. Nothing of the text is echoed back.
function checkInputs(text) {
  if (text === undefined || text === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new PublishError('--production-inputs is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new PublishError('--production-inputs is a JSON object, such as {"docs_update":"pipes"}');
  const entries = Object.entries(parsed);
  if (entries.length > MAX_INPUTS) throw new PublishError(`--production-inputs has more than ${MAX_INPUTS} inputs`);
  for (const [name, value] of entries) {
    if (!INPUT_NAME.test(name)) throw new PublishError('--production-inputs has an input name outside letters, digits, _ and -');
    if (typeof value !== 'string' || value.length > MAX_INPUT_VALUE) throw new PublishError(`--production-inputs values are strings of at most ${MAX_INPUT_VALUE} characters`);
  }
  return Object.fromEntries(entries);
}

// A token that cannot read the site, or what it asks for, answers 401, 403 or 404.
const unreadable = (e) => e && (e.status === 401 || e.status === 403 || e.status === 404);

const isProduction = (d, environment) => d && typeof d.environment === 'string' && d.environment.toLowerCase().startsWith(environment) && Number.isSafeInteger(d.id);

// The highest deployment id of the site now, of any environment (a deployment made later always has a higher id). 0 for a site with none.
async function latestDeploymentId(siteGithub, site) {
  const all = await siteGithub.listRecentDeployments(site);
  return all.reduce((top, d) => (d && Number.isSafeInteger(d.id) && d.id > top ? d.id : top), 0);
}

// The highest run id of the site's workflow now, of those started by dispatch. 0 for none.
async function latestRunId(siteGithub, site, workflow) {
  const runs = await siteGithub.listDispatchedRuns(site, workflow);
  return runs.reduce((top, r) => (r && Number.isSafeInteger(r.id) && r.id > top ? r.id : top), 0);
}

// One look at the site. Returns `{ state, detail }`: `success`, `failure`, `waiting` or `unreadable`.
async function look({ site, siteGithub, readGithub, workflow, deploymentLine, runLine, environment }) {
  if (workflow) {
    let runs;
    try {
      runs = await siteGithub.listDispatchedRuns(site, workflow);
    } catch (e) {
      if (unreadable(e)) return { state: 'unreadable', detail: `the runs of ${workflow} could not be read (${e.status}): the App needs actions: write on the site` };
      throw e;
    }
    // The first run after the line is the one this publish dispatched, unless someone else's came in between.
    const ours = runs.filter((r) => r && Number.isSafeInteger(r.id) && r.id > runLine).sort((a, b) => a.id - b.id)[0];
    if (!ours) return { state: 'waiting', detail: `${workflow} has not started on the site` };
    if (ours.status !== 'completed') return { state: 'waiting', detail: `${workflow} is ${String(ours.status).replace('_', ' ').slice(0, 20)} on the site` };
    if (ours.conclusion !== 'success') return { state: 'failure', detail: `${workflow} on the site ended ${String(ours.conclusion).slice(0, 20)}` };
  }
  let deployments;
  try {
    deployments = await readGithub.listRecentDeployments(site);
  } catch (e) {
    if (unreadable(e)) return { state: 'unreadable', detail: `the site's deployments could not be read (${e.status}): the App needs deployments: read` };
    throw e;
  }
  const newest = deployments.filter((d) => isProduction(d, environment) && d.id > deploymentLine).sort((a, b) => b.id - a.id)[0];
  if (!newest) return { state: 'waiting', detail: 'the site\'s production build has not started' };
  let state;
  try {
    state = stateOf(await readGithub.listDeploymentStatuses(site, newest.id));
  } catch (e) {
    if (unreadable(e)) return { state: 'unreadable', detail: `the site's deployment statuses could not be read (${e.status}): the App needs deployments: read` };
    throw e;
  }
  if (state === 'success') return { state: 'success', detail: `the site's production deployment ${newest.id} reported success` };
  if (FAILED.has(state)) return { state: 'failure', detail: `the site's production deployment ${newest.id} reported ${state}` };
  if (OPEN.has(state)) return { state: 'waiting', detail: `the site's production deployment ${newest.id} is ${state.replace('_', ' ')}` };
  return { state: 'waiting', detail: `the site's production deployment ${newest.id} reported ${String(state).slice(0, 20)}, which is not a result` };
}

/**
 * Waits for the site's production build that this publish started. `deploymentLine` and `runLine` are the highest ids seen
 * before it started (`null` for a deployment line when the site could not be read then: the first look says so). With a
 * `workflow`, its run must have succeeded too. Returns `{ state, detail }`: `success`; `failure` (the build or the run
 * failed); `waiting` (the deadline passed); `unreadable` (the App cannot read the site's deployments or runs). The clock
 * and the sleep are the caller's, so a test never waits.
 */
async function awaitPublished({
  site, siteGithub, readGithub, workflow = null, deploymentLine, runLine = 0, environment = DEFAULT_ENVIRONMENT,
  waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS, unreadableWhy = null, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!readGithub || deploymentLine === null) return { state: 'unreadable', detail: unreadableWhy || 'the site\'s deployments could not be read: no token that reads them was made (the App needs deployments: read)' };
  const deadline = now() + waitMs;
  for (;;) {
    const seen = await look({ site, siteGithub, readGithub, workflow, deploymentLine, runLine, environment });
    if (seen.state !== 'waiting') return seen;
    if (now() + pollMs > deadline) return seen;
    await sleep(pollMs);
  }
}

// Calls the deploy hook (a POST to the secret URL). Never quotes the URL; a redirect is an error, not followed.
async function callHook(fetchImpl, hook) {
  let res;
  try {
    res = await fetchImpl(hook, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000) });
  } catch {
    throw new PublishError('the deploy hook could not be called');
  }
  if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
  if (!res.ok) throw new PublishError(`the deploy hook answered ${res.status}`);
}

module.exports = {
  PublishError, DEFAULT_ENVIRONMENT, DEFAULT_WAIT_MS, DEFAULT_POLL_MS, HOOK_HOST,
  checkSite, checkSiteUrl, checkWorkflow, checkHook, checkInputs, latestDeploymentId, latestRunId, look, awaitPublished, callHook,
};
