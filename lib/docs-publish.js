'use strict';

// A docs repo's publish (workflows/docs-publish.yml, `shipyard docs-publish`). A merge to the docs repo's `main` publishes the
// site: it calls the site's Vercel deploy hook, starts the site's workflows, and records the result as a GitHub deployment
// of the merge commit in `production`, which is what the light release's ship signal (lib/deployment.js) reads.
//
// The site says what it serves. Its build writes one public file, `/docs-version.json` at the site's address, holding the
// commit of each docs repo it built from: `{"<docs repo name>": "<full commit>"}`. The publish reads that file until it holds
// the merge commit or a later commit of the docs repo (GitHub's compare says `ahead` or `identical`). So the docs are live
// whichever build put them there, a build of a push to the site's own `main` as well, and an older commit never counts.
// Nothing here needs a Vercel token or writes to the site.

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

// Where the site says what it serves, at the root of the site's address.
const VERSION_PATH = '/docs-version.json';
// A larger answer is not the file.
const MAX_VERSION_BYTES = 64 * 1024;
const COMMIT = /^[0-9a-f]{40}$/;

const DEFAULT_ENVIRONMENT = 'production';
const DEFAULT_WAIT_MS = 30 * 60 * 1000;
const DEFAULT_POLL_MS = 20 * 1000;

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

// The highest run id of the site's workflow now, of those started by dispatch. 0 for none.
async function latestRunId(siteGithub, site, workflow) {
  const runs = await siteGithub.listDispatchedRuns(site, workflow);
  return runs.reduce((top, r) => (r && Number.isSafeInteger(r.id) && r.id > top ? r.id : top), 0);
}

// The address of the site's version file: `/docs-version.json` at the root of the site's address, whatever path it has.
function versionUrl(siteUrl) {
  return new URL(VERSION_PATH, siteUrl).href;
}

// Reads the commit of `name` that the site serves. Returns `{ sha }`, or `{ detail }` saying why there is none yet. A file
// that is missing, not JSON or names no commit is waited on, never a failure: the site may still be building.
async function readServed(fetchImpl, url, name) {
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: 'application/json', 'cache-control': 'no-cache' }, cache: 'no-store', signal: AbortSignal.timeout(20000) });
  } catch {
    return { detail: `the site's ${VERSION_PATH} could not be fetched` };
  }
  if (!res.ok) {
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
    return { detail: `the site's ${VERSION_PATH} answered ${res.status}` };
  }
  let text;
  try {
    text = await res.text();
  } catch {
    return { detail: `the site's ${VERSION_PATH} could not be read` };
  }
  if (text.length > MAX_VERSION_BYTES) return { detail: `the site's ${VERSION_PATH} is larger than ${MAX_VERSION_BYTES / 1024} KB` };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { detail: `the site's ${VERSION_PATH} is not JSON` };
  }
  const sha = parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.hasOwn(parsed, name) ? parsed[name] : undefined;
  if (typeof sha !== 'string' || !COMMIT.test(sha)) return { detail: `the site's ${VERSION_PATH} names no commit of ${name}` };
  return { sha };
}

// One look at the site. Returns `{ state, detail }`: `success`, `failure`, `waiting` or `unreadable`. `compared` keeps
// GitHub's answer for each served commit: how two commits stand never changes, so each pair is asked once.
async function look({ site, siteGithub, docsGithub, docsRepo, sha, fetchImpl, siteUrl, workflow, runLine, compared }) {
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
  const name = docsRepo.split('/')[1];
  const served = await readServed(fetchImpl, versionUrl(siteUrl), name);
  if (!served.sha) return { state: 'waiting', detail: served.detail };
  const short = served.sha.slice(0, 7);
  if (served.sha === sha) return { state: 'success', detail: `the site serves ${short} of ${name}` };
  let status = compared.get(served.sha);
  if (status === undefined) {
    try {
      status = await docsGithub.compareStatus(docsRepo, sha, served.sha);
    } catch (e) {
      if (unreadable(e)) return { state: 'unreadable', detail: `the commits of ${name} could not be compared (${e.status}): the job needs contents: read` };
      // GitHub answers 422 to a commit it cannot compare with this one: not a commit of the docs repo.
      if (!e || e.status !== 422) throw e;
      status = null;
    }
    if (status === 'ahead' || status === 'identical' || status === 'behind' || status === 'diverged') compared.set(served.sha, status);
  }
  if (status === 'ahead' || status === 'identical') return { state: 'success', detail: `the site serves ${short} of ${name}, which holds ${sha.slice(0, 7)}` };
  if (status === 'behind' || status === 'diverged') return { state: 'waiting', detail: `the site serves ${short} of ${name}, which is older than ${sha.slice(0, 7)}` };
  return { state: 'waiting', detail: `the site serves ${short}, which is not a commit of ${name}` };
}

/**
 * Waits until the site serves the docs repo's commit `sha` or a later one. `runLine` is the highest run id of `workflow`
 * seen before it started; with a `workflow`, its run must have succeeded too. Returns `{ state, detail }`: `success`;
 * `failure` (the run failed); `waiting` (the deadline passed, with what it last saw); `unreadable` (a read the job needs
 * was refused). The clock and the sleep are the caller's, so a test never waits.
 */
async function awaitPublished({
  site, siteGithub, docsGithub, docsRepo, sha, siteUrl, fetchImpl = globalThis.fetch, workflow = null, runLine = 0,
  waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS, unreadableWhy = null, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (unreadableWhy) return { state: 'unreadable', detail: unreadableWhy };
  const deadline = now() + waitMs;
  const compared = new Map();
  for (;;) {
    const seen = await look({ site, siteGithub, docsGithub, docsRepo, sha, fetchImpl, siteUrl, workflow, runLine, compared });
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
  PublishError, DEFAULT_ENVIRONMENT, DEFAULT_WAIT_MS, DEFAULT_POLL_MS, HOOK_HOST, VERSION_PATH,
  checkSite, checkSiteUrl, checkWorkflow, checkHook, checkInputs, latestRunId, versionUrl, readServed, look, awaitPublished, callHook,
};
