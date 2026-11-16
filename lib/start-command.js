'use strict';

// `shipyard start --repo <owner>/<name> (--cadence daily|weekly | --branch <name> | --pr <number>)`:
// start the release of each branch the trigger selects, by filing a prep job in this repo when a
// shipped change is waiting (lib/start.js). Exit 0 when every branch was decided (started or
// skipped), 3 when one waits for its full check, 1 when one was refused (the full check failed,
// or the trigger names no branch the repo starts), 2 when a branch could not be read. The worst
// of them wins: 2, then 1, then 3.

const fs = require('node:fs');
const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { CheckError } = require('./changelog-line');
const { notShippedOf } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need } = require('./release-args');
const { loadStart, readReleaseConfig } = require('./start-config');
const { runStart } = require('./start');

const USAGE = 'usage: shipyard start --repo <owner>/<name> (--cadence daily|weekly | --branch <name> | --pr <number> | --reship <version>) [--dir <checkout>] [--families <folder>] [--jobs-repo <owner>/<name>] [--wait <minutes>] [--out <result.json>] [--dry-run]';
const FLAGS = {
  '--repo': 'repo', '--cadence': 'cadence', '--branch': 'branch', '--pr': 'pr', '--reship': 'reship', '--dir': 'dir', '--families': 'families', '--jobs-repo': 'jobsRepo', '--wait': 'wait', '--out': 'out',
};
const SWITCHES = { '--dry-run': 'dryRun' };
const REPO = /^[^/\s]+\/[^/\s]+$/;
const MAX_WAIT_MINUTES = 180;

function exitCodeOf(results) {
  if (results.some((r) => r.outcome === 'error')) return 2;
  if (results.some((r) => r.outcome === 'refused')) return 1;
  if (results.some((r) => r.outcome === 'waiting')) return 3;
  return 0;
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.', families: 'families' }, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-start.md for when a branch starts and what is filed.\n`);
      return 0;
    }
    const repo = need(opts, 'repo', '--repo');
    if (!REPO.test(repo)) throw new ReleaseError('--repo must be <owner>/<name>');
    const triggers = ['cadence', 'branch', 'pr', 'reship'].filter((k) => opts[k] !== undefined);
    if (triggers.length !== 1) throw new ReleaseError('give exactly one of --cadence, --branch, --pr and --reship');
    if (opts.reship !== undefined && !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(opts.reship)) throw new ReleaseError('--reship takes the version that waits for its tag, X.Y.Z');
    if (opts.cadence !== undefined && !['daily', 'weekly'].includes(opts.cadence)) throw new ReleaseError('--cadence is daily or weekly (a branch started by hand is --branch)');
    if (opts.pr !== undefined && !/^[1-9]\d*$/.test(opts.pr)) throw new ReleaseError('--pr must be a pull request number');
    const jobsRepo = opts.jobsRepo || env.GITHUB_REPOSITORY;
    if (!jobsRepo || !REPO.test(jobsRepo)) throw new ReleaseError('--jobs-repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');

    if (opts.wait !== undefined && (!/^\d{1,3}$/.test(opts.wait) || Number(opts.wait) > MAX_WAIT_MINUTES)) {
      throw new ReleaseError(`--wait is a number of minutes, at most ${MAX_WAIT_MINUTES}`);
    }
    if (opts.wait !== undefined && opts.pr === undefined) throw new ReleaseError('--wait is for --pr: only release:now waits');
    const dir = path.resolve(opts.dir);
    const config = readReleaseConfig(dir, 'HEAD');
    const start = loadStart({ config, repo, familiesDir: path.resolve(opts.families) });
    if (!start) throw new Refusal(`${repo} has no start setting: add "start" to its .github/release.json, or list it in a family file`);
    const notShipped = notShippedOf(config, '.github/release.json');

    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL });
    const jobsGithub = io.jobsGithub || createClient({ token: env.SHIPYARD_JOBS_TOKEN || token, apiUrl: env.GITHUB_API_URL });
    const select = opts.reship !== undefined ? { reship: opts.reship }
      : opts.pr !== undefined ? { pr: Number(opts.pr) } : opts.branch !== undefined ? { branch: opts.branch } : { cadence: opts.cadence };

    const results = await runStart({ dir, repo, github, jobsGithub, jobsRepo, start, notShipped, config, select, dryRun: Boolean(opts.dryRun),
      waitMs: Number(opts.wait || 0) * 60000, ...(io.pollMs ? { pollMs: io.pollMs } : {}), ...(io.clock ? { now: io.clock } : {}), ...(io.sleep ? { sleep: io.sleep } : {}),
    });
    if (!results.length) out.write(`No branch of ${repo} starts ${opts.cadence}.\n`);
    for (const r of results) {
      out.write(`${r.branch} (${r.trigger}): ${r.outcome}: ${r.reason}\n`);
      for (const note of r.notes || []) out.write(`  ${note}\n`);
    }
    if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify({ repo, results }, null, 2)}\n`);
    return exitCodeOf(results);
  } catch (e) {
    if (e instanceof Refusal) {
      err.write(`shipyard start: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof CheckError)) throw e;
    err.write(`shipyard start: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required)|give exactly)/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE, exitCodeOf };
