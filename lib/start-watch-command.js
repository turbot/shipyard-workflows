'use strict';

// `shipyard start-watch [--jobs-repo <owner>/<name>]`: read the open prep jobs and ask the area's
// approvers about each one that has waited too long (lib/start-watch.js). Exit 0 when every job
// was read, 2 when one could not be.

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { ReleaseError } = require('./release-git');
const { parseOptions } = require('./release-args');
const { watchJobs } = require('./start-watch');

const USAGE = 'usage: shipyard start-watch [--jobs-repo <owner>/<name>] [--out <result.json>] [--dry-run]';
const FLAGS = { '--jobs-repo': 'jobsRepo', '--out': 'out' };
const SWITCHES = { '--dry-run': 'dryRun' };

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const now = io.now || (() => new Date());
  try {
    const opts = parseOptions(argv, FLAGS, {}, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-start.md for the timeouts.\n`);
      return 0;
    }
    const jobsRepo = opts.jobsRepo || env.GITHUB_REPOSITORY;
    if (!jobsRepo || !/^[^/\s]+\/[^/\s]+$/.test(jobsRepo)) throw new ReleaseError('--jobs-repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL });
    const jobsGithub = io.jobsGithub || createClient({ token: env.SHIPYARD_JOBS_TOKEN || token, apiUrl: env.GITHUB_API_URL });

    const results = await watchJobs({ jobsGithub, jobsRepo, githubFor: () => github, now: now().getTime(), dryRun: Boolean(opts.dryRun) });
    if (!results.length) out.write(`No open prep jobs in ${jobsRepo}.\n`);
    for (const r of results) out.write(`#${r.job} ${r.repo} ${r.branch}: ${r.outcome}: ${r.reason}\n`);
    if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify({ jobsRepo, results }, null, 2)}\n`);
    return results.some((r) => r.outcome === 'error') ? 2 : 0;
  } catch (e) {
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    err.write(`shipyard start-watch: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
