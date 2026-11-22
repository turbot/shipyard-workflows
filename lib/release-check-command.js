'use strict';

// `shipyard release-check`: the required status on a PR into `main` or `main-*`. Reads the PR
// event ($GITHUB_EVENT_PATH: a pull_request_target, pull_request_review or issue_comment event),
// reads the PR as GitHub holds it now, runs the ten rules of lib/release-check.js against a
// checkout holding every branch and tag, and sets the commit status `release-check` on the PR's
// head. Exit 0 when every rule passes (or the event is not for a release PR), 1 when one fails,
// 2 when the check could not run.

const fs = require('node:fs');
const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { CheckError } = require('./changelog-line');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, git, parseTag } = require('./release-git');
const { parseOptions, readJson } = require('./release-args');
const { gather, evaluate, lineOf } = require('./release-check');
const { currentOf } = require('./shipyard-version');

const CONTEXT = 'release-check';
const USAGE = 'usage: shipyard release-check [--event <event.json>] [--dir <checkout>] [--tag-prefix <prefix>] [--changelog <path>] [--approvers <org>/<team>] [--product <name>] [--automation-logins <a,b>] [--fleet-logins <a,b>] [--armed-label <label>] [--no-status]';
const FLAGS = {
  '--event': 'event', '--dir': 'dir', '--tag-prefix': 'tagPrefix', '--changelog': 'changelog', '--approvers': 'approvers', '--product': 'product',
  '--automation-logins': 'automationLogins', '--fleet-logins': 'fleetLogins', '--armed-label': 'armedLabel',
};
const SWITCHES = { '--no-status': 'noStatus' };

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);

function checkOptions(opts) {
  if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError(`--tag-prefix ${JSON.stringify(opts.tagPrefix)} is not a tag prefix`);
  if (/\.\.|^\/|^-|[\r\n]/.test(opts.changelog)) throw new ReleaseError(`--changelog must be a path inside the repo, not ${JSON.stringify(opts.changelog)}`);
  if (opts.approvers && !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(opts.approvers)) throw new ReleaseError('--approvers must be <org>/<team-slug>');
}

// The PR number an event is about, or null with the reason it is not one to check.
function prOfEvent(event) {
  if (!event || typeof event !== 'object') throw new ReleaseError('the event is not a JSON object');
  if (event.pull_request && Number.isInteger(event.pull_request.number)) return { number: event.pull_request.number };
  // Every comment on the PR reruns it, not only /level: the runs for one PR share a queue that
  // keeps only the newest waiting run, so a skipped run could drop a rerun a review asked for.
  if (event.issue && event.issue.pull_request && Number.isInteger(event.issue.number)) return { number: event.issue.number };
  if (event.issue) return { number: null, why: 'the comment is on an issue, not a PR' };
  // A push to main, main-* or a release tag can change rules 2, 5 and 6 for every open candidate.
  if (typeof event.ref === 'string' && event.ref.startsWith('refs/')) return { push: event.ref };
  throw new ReleaseError('not a pull request, review, comment or push event');
}

function render(results) {
  return results.map((c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.n}. ${c.title}\n${c.detail.map((d) => `       ${d}`).join('\n')}`).join('\n');
}

function summaryText(results, head) {
  const rows = results.map((c) => `| ${c.n} | ${c.title} | ${c.ok ? 'Pass' : 'Fail'} | ${c.detail.map((d) => d.replace(/[|\r\n]/g, ' ')).join('<br>')} |`);
  return `### Release check at \`${head.slice(0, 7)}\`\n\n| # | Rule | Result | Detail |\n|---|---|---|---|\n${rows.join('\n')}\n`;
}

function describe(results) {
  const failed = results.filter((c) => !c.ok);
  const text = failed.length ? `Fails ${failed.length} of ${results.length}: ${failed.map((c) => c.id).join(', ')}` : `All ${results.length} release checks pass`;
  return text.length > 140 ? `${text.slice(0, 139)}…` : text;
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, {
      dir: '.', tagPrefix: 'v', changelog: 'CHANGELOG.md', armedLabel: 'agent:ready',
    }, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-check.md for the ten rules.\n`);
      return 0;
    }
    checkOptions(opts);
    const eventPath = opts.event || env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new ReleaseError('no event: set GITHUB_EVENT_PATH or pass --event');
    const event = readJson(eventPath, 'event');
    const repo = env.GITHUB_REPOSITORY || (event.repository && event.repository.full_name);
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('no repo: set GITHUB_REPOSITORY');

    const target = prOfEvent(event);
    if (target.number === null) {
      say(`Release check skipped: ${target.why}.`);
      return 0;
    }
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, graphqlUrl: env.GITHUB_GRAPHQL_URL });
    // Team membership needs a token that can read the org; the job's own token cannot.
    const orgToken = env.SHIPYARD_ORG_TOKEN;
    const orgGithub = io.orgGithub || (orgToken ? createClient({ token: orgToken, apiUrl: env.GITHUB_API_URL }) : github);
    const options = {
      tagPrefix: opts.tagPrefix,
      changelog: opts.changelog,
      armedLabel: opts.armedLabel,
      fleetLogins: list(opts.fleetLogins),
      automationLogins: list(opts.automationLogins),
      approvers: opts.approvers || null,
      product: opts.product || null,
    };
    const ctx = {
      repo, dir: path.resolve(opts.dir), github, orgGithub, options, opts, env, say, out, err, current: currentOf(io),
    };

    if (target.push) {
      const open = (await github.listOpenPulls(repo)).filter((p) => p.base && lineOf(p.base.ref));
      say(`${target.push} moved: checking ${open.length} open PR${open.length === 1 ? '' : 's'} into main or main-<version>.`);
      let worst = 0;
      for (const p of open) worst = Math.max(worst, await checkOne(ctx, p.number));
      return worst;
    }
    return await checkOne(ctx, target.number);
  } catch (e) {
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof CheckError)) throw e;
    return couldNotRun({ out, err, env, io }, e, null);
  }
}

// One PR: read it, run the rules, set its status. Exit code 0, 1 or 2 for this PR.
async function checkOne(ctx, number) {
  const {
    repo, dir, github, orgGithub, options, opts, env, say, out, current,
  } = ctx;
  let status = null;
  try {
    const pr = await github.getPull(repo, number);
    if (!pr.base || !lineOf(pr.base.ref)) {
      say(`Release check skipped: #${pr.number} goes into ${String(pr.base && pr.base.ref).slice(0, 80)}, not main or main-<version>.`);
      return 0;
    }
    if (pr.state !== 'open') {
      say(`Release check skipped: #${pr.number} is ${pr.state}.`);
      return 0;
    }
    const head = String(pr.head && pr.head.sha);
    if (!/^[0-9a-f]{40}$/.test(head)) throw new ReleaseError(`#${pr.number} has no head commit`);
    if (!opts.noStatus) status = { repo, head };

    const started = Date.now();
    const read = await gather({
      dir, repo, pr, github, orgGithub, options, current,
    });
    const results = evaluate(read);
    const ok = results.every((c) => c.ok);
    say(`Release check for #${pr.number} at ${head.slice(0, 7)} (${Date.now() - started} ms):\n${render(results)}`);
    for (const c of results.filter((x) => !x.ok)) out.write(`::error title=Release check ${c.n}::${escapeData(`#${pr.number} ${c.title}: ${c.detail.join('; ')}`)}\n`);
    summary(env, summaryText(results, head));
    // A pass is written only when it still holds. The checkout was fetched before this ran and runs
    // queue apart (one queue per PR, one for pushes), so what a newer run may have read since is read
    // again: the base's tip, the release tags, the candidate's head, title, body, base and state, its reviews and its comments. If
    // any moved, the event that moved it started a run that reads it; this one writes no pass.
    let stale = false;
    if (status && ok) {
      const sig = (list) => JSON.stringify(list.map((x) => [x.id, x.state, x.updated_at, x.body, x.user && x.user.login, x.commit_id]));
      const [tip, tags, now, reviews, comments] = await Promise.all([
        github.branchTip(repo, pr.base.ref),
        github.listTagNames(repo, options.tagPrefix),
        github.getPull(repo, pr.number),
        github.listPullReviews(repo, pr.number),
        github.listIssueComments(repo, pr.number),
      ]);
      const local = new Set(git(dir, ['tag', '--list']).split('\n').map((t) => t.trim()).filter(Boolean));
      stale = tip !== read.base || tags.some((t) => parseTag(t, options.tagPrefix) && !local.has(t))
        || String(now.head && now.head.sha) !== head || now.title !== pr.title || now.body !== pr.body || now.state !== pr.state
        || String(now.base && now.base.ref) !== pr.base.ref || sig(reviews) !== sig(read.releaseReviews) || sig(comments) !== sig(read.comments);
      if (stale) say(`#${pr.number}: the base, the release tags or the PR moved while this ran: no pass is written; the run that move started writes the status.`);
    }
    if (status && !stale) {
      await github.createStatus(repo, head, {
        state: ok ? 'success' : 'failure', context: CONTEXT, description: describe(results), targetUrl: runUrl(env),
      });
    }
    return ok ? 0 : 1;
  } catch (e) {
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof CheckError)) throw e;
    return couldNotRun(ctx, e, status);
  }
}

// A check that could not run is never a pass: the status says so, when there is a commit to put it on.
async function couldNotRun({
  out, err, env, github, io,
}, e, status) {
  out.write(`::error title=Release check::${escapeData(e.message)}\n`);
  err.write(`shipyard release-check: ${e.message}\n`);
  if (/^(unknown option|unexpected argument|--\S+ (needs|is required|takes no))/.test(e.message)) err.write(`${USAGE}\n`);
  if (status) {
    const client = github || (io && io.github) || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: env.GITHUB_API_URL });
    const text = `Could not run: ${e.message}`;
    try {
      await client.createStatus(status.repo, status.head, {
        state: 'error', context: CONTEXT, description: text.length > 140 ? `${text.slice(0, 139)}…` : text, targetUrl: runUrl(env),
      });
    } catch (e2) {
      err.write(`shipyard release-check: could not set the status either: ${e2.message}\n`);
    }
  }
  return 2;
}

function runUrl(env) {
  if (!env.GITHUB_SERVER_URL || !env.GITHUB_REPOSITORY || !env.GITHUB_RUN_ID) return undefined;
  return `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}`;
}

function summary(env, text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  } catch {
    // the summary is a courtesy; the status and the exit code are the check
  }
}

module.exports = { run, USAGE, CONTEXT, prOfEvent };
