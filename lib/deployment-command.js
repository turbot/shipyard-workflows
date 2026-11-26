'use strict';

// `shipyard deployment --sha <commit>`: the ship signal of a repo that deploys on merge. Waits for the production
// deployment of the merge commit to report success, and writes `result=success` (or `none` for a repo with no deployments:
// its signal is the merge) to the step's outputs. A failed deployment, or one still going at the deadline, is a refusal
// (exit 1): the job fails, so the tag job after it, which takes this job's result as the ship result, tags nothing.
// Exit 0 when the signal is given, 1 when refused, 2 when it could not run.

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need } = require('./release-args');
const { awaitDeployment, DEFAULT_ENVIRONMENT } = require('./deployment');

const USAGE = 'usage: shipyard deployment --sha <commit> [--repo <owner>/<name>] [--environment <name>] [--wait <minutes>] [--grace <seconds>]';
const FLAGS = {
  '--sha': 'sha', '--repo': 'repo', '--environment': 'environment', '--wait': 'wait', '--grace': 'grace',
};
const REPO = /^[^/\s]+\/[^/\s]+$/;
const MAX_WAIT_MINUTES = 120;
const MAX_GRACE_SECONDS = 600;

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { environment: DEFAULT_ENVIRONMENT, wait: '30', grace: '120' });
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-deployment.md for what counts as the signal.\n`);
      return 0;
    }
    const sha = need(opts, 'sha', '--sha');
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new ReleaseError('--sha must be a full 40-character commit id');
    const repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!repo || !REPO.test(repo)) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
    if (!/^[A-Za-z0-9 ._:-]{1,60}$/.test(opts.environment)) throw new ReleaseError('--environment is the name of a deployment environment, such as production');
    if (!/^\d{1,3}$/.test(opts.wait) || Number(opts.wait) > MAX_WAIT_MINUTES) throw new ReleaseError(`--wait is a number of minutes, at most ${MAX_WAIT_MINUTES}`);
    if (!/^\d{1,3}$/.test(opts.grace) || Number(opts.grace) > MAX_GRACE_SECONDS) throw new ReleaseError(`--grace is a number of seconds, at most ${MAX_GRACE_SECONDS}`);

    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: env.GITHUB_API_URL, sleep: io.sleep });
    const seen = await awaitDeployment({
      github, repo, sha, environment: opts.environment, waitMs: Number(opts.wait) * 60000, graceMs: Number(opts.grace) * 1000,
      ...(io.pollMs ? { pollMs: io.pollMs } : {}), ...(io.clock ? { now: io.clock } : {}), ...(io.sleep ? { sleep: io.sleep } : {}),
    });
    if (seen.state === 'failure') throw new Refusal(`${seen.detail}, so ${sha.slice(0, 7)} is not tagged. Fix the deployment and run it again: the tag follows its success`);
    if (seen.state === 'waiting') throw new Refusal(`${seen.detail} after ${opts.wait} minutes, so ${sha.slice(0, 7)} is not tagged yet. Run this again when the deployment finishes`);
    const result = seen.state === 'success' ? 'success' : 'none';
    out.write(result === 'success' ? `${seen.detail}.\n` : `${seen.detail}: the signal is the merge.\n`);
    if (env.GITHUB_OUTPUT) {
      try {
        fs.appendFileSync(env.GITHUB_OUTPUT, `result=${result}\n`);
      } catch {
        // the exit code is the result: the job fails or passes on it
      }
    }
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Deployment::${escapeData(e.message)}\n`);
      err.write(`shipyard deployment: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    out.write(`::error title=Deployment::${escapeData(e.message)}\n`);
    err.write(`shipyard deployment: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
