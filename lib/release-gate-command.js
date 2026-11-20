'use strict';

// `shipyard release-gate --pr <number> --dir <checkout> --results <results.json> [--release-run <run id>] [...]`:
// count the release PR's verdict again, as the record does for a review, and post it on the PR's head as a check run named
// `shipyard/release`, with the area's release App's token (docs/release-gate.md). `main` accepts that name only from that App,
// so only this step can make a release PR pass.
//
// Two tokens, never mixed: GITHUB_TOKEN (the job's, read-only in effect) reads the PR, its reviews, its checks and the release
// run; RELEASE_TOKEN (the App's, made for this repo with `checks: write` alone) posts the one check run. Nothing is read from
// the PR's code but as data: the checkout holds the candidate's files, and this command is run from the published copy.
//
// The verdict is the record's own (`releaseStatus`): success only for SHIP with the head's approval seen and nothing else open;
// in_progress while a step is open or the approval is not there yet; failure for HOLD, and for a PR whose body names no
// release run (nothing then shows what was tested). Exit 0 when the check is posted, whatever it says; 1 when refused (not a
// release PR, or the PR moved while it was read: the record of the new head posts its own); 2 when it could not run.

const { createClient, GitHubError } = require('./github');
const { LintError } = require('./lint-prep');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need } = require('./release-args');
const { readRecord, shipyardOf } = require('./record-command');
const { RELEASE_STATUS, releaseStatus } = require('./record');

const USAGE = 'usage: shipyard release-gate --pr <number> --results <results.json> [--release-run <run id>] [--dir <checkout>] [--shipyard-sha <commit>] [--changelog <path>] [--armed-label <label>] [--fleet-logins <a,b>] [--ignore-checks <a,b>] [--ask-workflow <file>] [--gate-workflow <file>]';
const FLAGS = {
  '--pr': 'pr', '--dir': 'dir', '--results': 'results', '--release-run': 'releaseRun', '--shipyard-sha': 'shipyardSha', '--changelog': 'changelog',
  '--armed-label': 'armedLabel', '--fleet-logins': 'fleetLogins', '--ignore-checks': 'ignoreChecks', '--ask-workflow': 'askWorkflow', '--gate-workflow': 'gateWorkflow',
};
const ASK_WORKFLOW = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml$/;

/**
 * The record's verdict as the check run `shipyard/release` shows it.
 *   failure -> completed, failure;  pending -> in_progress (the check is not met);  success -> completed, success.
 */
function checkOf(verdict) {
  const base = { name: RELEASE_STATUS, title: verdict.description, summary: verdict.description };
  if (verdict.state === 'success') return { ...base, status: 'completed', conclusion: 'success' };
  if (verdict.state === 'failure') return { ...base, status: 'completed', conclusion: 'failure' };
  return { ...base, status: 'in_progress' };
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.', changelog: 'CHANGELOG.md', armedLabel: 'agent:ready' });
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-gate.md.\n`);
      return 0;
    }
    const shipyard = shipyardOf(opts.shipyardSha, io.publishedRemote);
    if (opts.askWorkflow !== undefined && !ASK_WORKFLOW.test(opts.askWorkflow)) throw new ReleaseError('--ask-workflow must be the file name of a workflow in .github/workflows (ask.yml)');
    // The gate's own caller, whose run on `main` is no test of a commit the build was made from (a re-ship builds main's tip).
    if (opts.gateWorkflow !== undefined && !ASK_WORKFLOW.test(opts.gateWorkflow)) throw new ReleaseError('--gate-workflow must be the file name of a workflow in .github/workflows (release-gate.yml)');
    if (/\.\.|^\/|^-|[\r\n]/.test(opts.changelog)) throw new ReleaseError(`--changelog must be a path inside the repo, not ${JSON.stringify(opts.changelog)}`);
    const prNumber = Number(need(opts, 'pr', '--pr'));
    if (!Number.isInteger(prNumber) || prNumber < 1) throw new ReleaseError('--pr must be the release PR\'s number');
    if (opts.releaseRun !== undefined && !/^[1-9]\d{0,18}$/.test(opts.releaseRun)) throw new ReleaseError('--release-run must be the id of a workflow run (digits)');
    need(opts, 'results', '--results');
    const repo = env.GITHUB_REPOSITORY;
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('release-gate needs GITHUB_REPOSITORY, as <owner>/<name>');
    // Both tokens are needed before anything is read: a gate that can read and not post would leave `main` waiting with no word why.
    const readToken = env.GITHUB_TOKEN || env.GH_TOKEN;
    const gateToken = env.RELEASE_TOKEN;
    if (!readToken) throw new ReleaseError('release-gate needs GITHUB_TOKEN, to read the release PR');
    if (!gateToken) throw new ReleaseError('release-gate needs RELEASE_TOKEN, the release App\'s token, to post the check');
    if (readToken === gateToken) throw new ReleaseError('RELEASE_TOKEN must be the release App\'s token, not the one that reads the PR');
    const api = { apiUrl: env.GITHUB_API_URL, graphqlUrl: env.GITHUB_GRAPHQL_URL };
    const github = io.github || createClient({ token: readToken, ...api });
    const poster = io.poster || createClient({ token: gateToken, ...api });

    let verdict;
    let head;
    let url;
    if (opts.releaseRun === undefined) {
      // The page names no release run, so nothing shows what was tested: not a pass. The PR is still checked to be a release PR.
      const pull = await github.getPull(repo, prNumber);
      if (pull.state !== 'open' || !/^release\/\d+\.\d+\.\d+$/.test(String(pull.head && pull.head.ref)) || String(pull.head.repo && pull.head.repo.full_name).toLowerCase() !== repo.toLowerCase()) {
        throw new Refusal(`#${prNumber} is not an open release PR of ${repo}`);
      }
      head = pull.head.sha;
      url = pull.html_url;
      verdict = { state: 'failure', description: 'HOLD: the release PR names no release run, so nothing shows what was tested' };
    } else {
      const read = await readRecord({
        opts: { ...opts, fromCandidate: true, review: true }, env, github, out, err, shipyard,
      });
      head = read.head;
      url = read.fresh.html_url;
      verdict = releaseStatus(read.record);
    }
    if (!/^[0-9a-f]{40}$/.test(String(head))) throw new ReleaseError(`the head of #${prNumber} is not a commit`);
    const check = checkOf(verdict);
    try {
      await poster.createCheckRun(repo, {
        ...check, headSha: head, detailsUrl: url || `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}/pull/${prNumber}`,
      });
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      throw new ReleaseError(`${RELEASE_STATUS} could not be posted on ${head.slice(0, 7)}: ${e.message}. The release App needs Checks: write on this repo (docs/release-gate.md)`);
    }
    out.write(`Posted ${RELEASE_STATUS} on ${head.slice(0, 7)}: ${check.status === 'completed' ? check.conclusion : check.status}, ${verdict.description}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      err.write(`shipyard release-gate: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof LintError || e instanceof GitHubError)) throw e;
    err.write(`shipyard release-gate: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE, checkOf };
