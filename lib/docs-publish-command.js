'use strict';

// `shipyard docs-publish`: a docs repo's merge publishes its site, and the result is recorded as a GitHub deployment
// (lib/docs-publish.js, workflows/docs-publish.yml).
//
// In order: makes a deployment of the merge commit in the environment `production` and sets it `in_progress` (so the light
// release's ship signal, deployment.yml, finds it at once and waits); calls the site's Vercel deploy hook (DEPLOY_HOOK) when
// there is one; starts the site's search workflow and its production workflow when they are named; waits until the site
// serves the merge commit or a later one, read from its `/docs-version.json` (lib/docs-publish.js); and sets the deployment
// to `success` with the site's address, or to `failure` when the workflow failed, the site did not serve the commit within
// the wait, or a read was refused. A merge can then be shipped on the site's own result, not on the merge.
//
// Tokens: SITE_TOKEN, for the site repo alone, may start its workflows and read their runs (`actions: write`).
// GITHUB_TOKEN writes the deployment on the docs repo and compares its commits (`contents: read`). The site's file is
// public, so reading it needs no token, and no Vercel token is used.
//
// It writes no comment and edits no PR body. Exit 0 when the site serves the commit, 1 when it does not (the workflow
// failed, the wait ran out, or a read was refused), 2 when it could not run.

const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need } = require('./release-args');
const {
  PublishError, DEFAULT_ENVIRONMENT, checkSite, checkSiteUrl, checkWorkflow, checkHook, checkInputs,
  latestRunId, awaitPublished, callHook,
} = require('./docs-publish');

const USAGE = 'usage: shipyard docs-publish --site <owner>/<name> --site-url <https url> --sha <commit> [--search-workflow <file>] [--production-workflow <file> [--production-inputs <json>]] [--repo <owner>/<name>] [--wait <minutes>]\n'
  + '       the deploy hook is DEPLOY_HOOK in the environment, the site\'s token SITE_TOKEN (actions: write)';
const FLAGS = {
  '--site': 'site', '--site-url': 'siteUrl', '--sha': 'sha', '--repo': 'repo', '--wait': 'wait',
  '--search-workflow': 'searchWorkflow', '--production-workflow': 'productionWorkflow', '--production-inputs': 'productionInputs',
};
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
// The wait ends before the App's tokens (one hour) do, with time over to record the result: so no wait is longer than this.
const MAX_WAIT_MINUTES = 50;
const CANCEL_SIGNALS = ['SIGINT', 'SIGTERM'];
const CANCELLED = 'The publish was cancelled: the run was stopped before the site\'s build was seen.';

// The run was cancelled (the runner sent SIGINT, then SIGTERM). It is a refusal: the deployment says so and the step exits 1.
class Cancelled extends Refusal {}

const clip = (text) => (text.length > 140 ? `${text.slice(0, 139)}…` : text);

// What the deployment says once the wait is over. A site that did not serve the commit in time links the site's own
// deployments, where its builds are: without a Vercel token, a failed build and a slow one look the same from here.
function finalStatus(seen, siteUrl, waitMinutes, siteDeployments) {
  if (seen.state === 'success') return { state: 'success', description: 'The site serves this docs commit.', environment_url: siteUrl };
  if (seen.state === 'failure') return { state: 'failure', description: `The site did not publish: ${seen.detail}.` };
  if (seen.state === 'waiting') {
    return {
      state: 'failure',
      description: `The site did not serve this docs commit within ${waitMinutes} minutes: its build failed or is still running.`,
      environment_url: siteDeployments,
      lastSeen: seen.detail,
    };
  }
  return { state: 'failure', description: `The site's publish could not be read: ${seen.detail}.` };
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { wait: '30' });
    if (opts.help) {
      out.write(`${USAGE}\n`);
      return 0;
    }
    // Every input is checked before anything is asked of GitHub or the site.
    const site = checkSite(need(opts, 'site', '--site'));
    const siteUrl = checkSiteUrl(need(opts, 'siteUrl', '--site-url'));
    const sha = need(opts, 'sha', '--sha');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new ReleaseError('--sha must be a full 40-character commit id');
    const repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!repo || !REPO.test(repo)) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
    if (!/^\d{1,2}$/.test(opts.wait) || Number(opts.wait) < 1 || Number(opts.wait) > MAX_WAIT_MINUTES) {
      throw new ReleaseError(`--wait is a number of minutes, from 1 to ${MAX_WAIT_MINUTES}`);
    }
    const searchWorkflow = opts.searchWorkflow ? checkWorkflow(opts.searchWorkflow, '--search-workflow') : null;
    const productionWorkflow = opts.productionWorkflow ? checkWorkflow(opts.productionWorkflow, '--production-workflow') : null;
    if (opts.productionInputs && !productionWorkflow) throw new PublishError('--production-inputs needs --production-workflow');
    const productionInputs = checkInputs(opts.productionInputs);
    const hook = env.DEPLOY_HOOK ? checkHook(env.DEPLOY_HOOK) : null;
    if (!hook && !productionWorkflow) throw new PublishError('nothing to publish: give a deploy hook, or a production workflow');

    const api = env.GITHUB_API_URL;
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: api });
    const siteGithub = io.siteGithub !== undefined ? io.siteGithub : (env.SITE_TOKEN ? createClient({ token: env.SITE_TOKEN, apiUrl: api }) : null);
    const server = /^https:\/\/[A-Za-z0-9.-]+$/.test(env.GITHUB_SERVER_URL || '') ? env.GITHUB_SERVER_URL : 'https://github.com';
    const logUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID && REPO.test(env.GITHUB_REPOSITORY || '')
      ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
    const siteDeployments = `${server}/${site}/deployments`;
    const status = (s) => ({ ...s, description: clip(s.description), ...(logUrl ? { log_url: logUrl } : {}) });

    // A cancelled run is told to stop by a signal, and has seconds to record it: from here, the signal ends the deployment as a
    // failure instead of killing the step with the deployment `in progress`.
    const signals = io.signals || process;
    let cancelled = false;
    let cancel;
    const cancelP = new Promise((resolve) => { cancel = resolve; });
    const onSignal = () => { cancelled = true; cancel(); };
    for (const name of CANCEL_SIGNALS) signals.on(name, onSignal);
    try {
      // The ship signal looks for this at once, so it waits for the site instead of falling back to the merge.
      const id = await github.createDeployment(repo, {
        ref: sha,
        environment: DEFAULT_ENVIRONMENT,
        description: clip(`The production publish of ${site.split('/')[1]}`),
        transient_environment: false,
        production_environment: true,
        required_contexts: [],
        auto_merge: false,
      });
      const recording = github.createDeploymentStatus(repo, id, status({ state: 'in_progress', description: 'The site is publishing.' }));
      recording.catch(() => {});
      const stopIfCancelled = () => { if (cancelled) throw new Cancelled(CANCELLED); };
      // A wait that a cancel cuts short, and that stops the loop behind it.
      const sleep = async (ms) => {
        if (io.sleep) await io.sleep(ms);
        else await new Promise((resolve) => { const t = setTimeout(resolve, ms); cancelP.then(() => { clearTimeout(t); resolve(); }); });
        stopIfCancelled();
      };
      let seen;
      try {
        const work = async () => {
          await recording;
          // After the deployment is recorded, so a missing token fails it instead of leaving the ship signal to fall back to the merge.
          if ((searchWorkflow || productionWorkflow) && !siteGithub) throw new ReleaseError('SITE_TOKEN is not set: the job makes it with the site\'s App, which must be installed on the site with actions: write');

          // The line the production workflow's run must be after: the runs it already had. A line that could not be read ends
          // the wait at once as unreadable, after the site has been started.
          const unreadable = (e) => e instanceof GitHubError && [401, 403, 404].includes(e.status);
          let runLine = 0;
          let unreadableWhy = null;
          if (productionWorkflow) {
            try {
              runLine = await latestRunId(siteGithub, site, productionWorkflow);
            } catch (e) {
              if (!unreadable(e)) throw e;
              unreadableWhy = `the runs of ${productionWorkflow} could not be read (${e.status}): the App needs actions: write on the site`;
            }
          }

          stopIfCancelled();
          if (hook) {
            await callHook(io.fetch || globalThis.fetch, hook);
            out.write('Called the site\'s deploy hook.\n');
          }
          if (searchWorkflow || productionWorkflow) {
            const branch = await siteGithub.defaultBranch(site);
            if (!branch) throw new ReleaseError(`the App's token cannot see ${site}: is the App installed on it?`);
            for (const [workflow, inputs] of [[searchWorkflow, undefined], [productionWorkflow, productionInputs]]) {
              if (!workflow) continue;
              stopIfCancelled();
              try {
                await siteGithub.dispatchWorkflow(site, workflow, branch, inputs);
              } catch (e) {
                if (e instanceof GitHubError) throw new GitHubError(`${workflow} of ${site} could not be started on ${branch} (${e.status}): it must take workflow_dispatch, and the App must hold actions: write on ${site}`, e.status);
                throw e;
              }
              out.write(`Started ${workflow} of ${site} on ${branch}.\n`);
            }
          }

          return awaitPublished({
            site, siteGithub, docsGithub: github, docsRepo: repo, sha, siteUrl, fetchImpl: io.fetch || globalThis.fetch,
            workflow: productionWorkflow, runLine, unreadableWhy, waitMs: Number(opts.wait) * 60000,
            ...(io.pollMs ? { pollMs: io.pollMs } : {}), ...(io.clock ? { now: io.clock } : {}), sleep,
          });
        };
        seen = await Promise.race([work(), cancelP.then(() => { throw new Cancelled(CANCELLED); })]);
      } catch (e) {
        // The deployment never stays `in progress` for a run that stopped, and a cancel says it was a cancel.
        const stopped = cancelled || e instanceof Cancelled ? new Cancelled(CANCELLED) : e;
        // The status written first lands first, so `failure` is the last word.
        await recording.catch(() => {});
        await github.createDeploymentStatus(repo, id, status({ state: 'failure', description: stopped instanceof Cancelled ? CANCELLED : `The publish could not finish: ${e instanceof Error ? e.message : 'see the run'}` })).catch(() => {});
        throw stopped;
      }
      const { lastSeen, ...final } = finalStatus(seen, siteUrl, opts.wait, siteDeployments);
      await github.createDeploymentStatus(repo, id, status(final));
      if (final.state !== 'success') throw new Refusal(lastSeen ? `${final.description} Last seen: ${lastSeen}. The site's builds: ${siteDeployments}` : final.description);
      out.write(`Published ${site}: ${seen.detail}. Recorded as the ${DEFAULT_ENVIRONMENT} deployment ${id} of ${sha.slice(0, 7)} (${siteUrl}).\n`);
      return 0;
    } finally {
      for (const name of CANCEL_SIGNALS) signals.removeListener(name, onSignal);
    }
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Docs publish::${escapeData(e.message)}\n`);
      err.write(`shipyard docs-publish: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof PublishError)) throw e;
    out.write(`::error title=Docs publish::${escapeData(e.message)}\n`);
    err.write(`shipyard docs-publish: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE, finalStatus };
