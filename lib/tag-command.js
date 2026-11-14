'use strict';

// `shipyard tag`: tags a release after the shipped signal. Reads the event ($GITHUB_EVENT_PATH):
//   - a `push` to main or main-<x.y> (the merge of a release PR), with the signal `ship-job` (the
//     repo's ship job ran first and its result is `--ship-result`) or `merge` (a Go library: the tag
//     is the publish), or
//   - an `issue_comment` that starts `/shipped`, from a person with write access, on a release PR
//     that has merged (where steps after the merge are still done by hand).
// Then it makes an annotated tag at the merge commit, as the release App, and with `--floating-major`
// moves the floating major tag (`v1`). The release PR is read from GitHub, never from the event.
// Exit 0 when tagged (or already tagged, or the event is not one to tag), 1 when refused (no tag),
// 2 when it could not run (a failed call is run again, and nothing it did is done twice).

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, readJson } = require('./release-args');
const { lineOf } = require('./release-check');
const {
  releaseOf, makeReleaseTag, moveFloatingMajor, isShippedComment, isBot, isReleaseHead, loginText, show, short, WRITE_ACCESS,
} = require('./tag');

const USAGE = 'usage: shipyard tag --automation-logins <a,b> [--signal ship-job|merge] [--ship-result <result>] [--tag-prefix <prefix>] [--floating-major] [--event <event.json>]';
const FLAGS = {
  '--event': 'event', '--tag-prefix': 'tagPrefix', '--automation-logins': 'automationLogins', '--signal': 'signal', '--ship-result': 'shipResult',
};
const SWITCHES = { '--floating-major': 'floatingMajor' };
const SIGNALS = { 'ship-job': "the repo's ship job passed", merge: 'the merge (a library: the tag is the publish)' };

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);

function checkOptions(opts) {
  if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError(`--tag-prefix ${show(opts.tagPrefix)} is not a tag prefix`);
  if (!Object.hasOwn(SIGNALS, opts.signal)) throw new ReleaseError(`--signal must be ship-job or merge, not ${show(opts.signal, 40)}`);
  if (!list(opts.automationLogins).length) throw new ReleaseError('--automation-logins is required: name the accounts that open release PRs, or any PR from a release/ branch could be tagged');
  if (opts.signal === 'merge' && opts.shipResult) throw new ReleaseError('--ship-result goes with the ship-job signal, not merge');
}

// What the event asks for: a push to a release branch or a `/shipped` comment, or why it is not ours.
function targetOf(event) {
  if (!event || typeof event !== 'object') throw new ReleaseError('the event is not a JSON object');
  if (event.issue && event.comment) {
    if (event.action !== 'created') return { skip: `the comment was ${String(event.action).slice(0, 20)}, and only a new comment is a signal` };
    if (!event.issue.pull_request) return { skip: 'the comment is on an issue, not a PR' };
    if (!isShippedComment(event.comment.body)) return { skip: 'the comment does not start with /shipped' };
    if (!Number.isInteger(event.issue.number)) throw new ReleaseError('the event has no PR number');
    return { kind: 'comment', number: event.issue.number, comment: event.comment };
  }
  if (typeof event.ref === 'string' && typeof event.after === 'string') {
    const branch = event.ref.replace(/^refs\/heads\//, '');
    if (!event.ref.startsWith('refs/heads/') || lineOf(branch) === null) return { skip: `${show(event.ref, 60)} is not main or main-<version>` };
    if (event.deleted || !/^[0-9a-f]{40}$/.test(event.after)) return { skip: 'the push deleted the branch' };
    return { kind: 'push', branch, sha: event.after };
  }
  throw new ReleaseError('not a push or a comment event');
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, { tagPrefix: 'v', signal: 'ship-job' }, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-tag.md for the signals, the tag and the floating major tag.\n`);
      return 0;
    }
    checkOptions(opts);
    const eventPath = opts.event || env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new ReleaseError('no event: set GITHUB_EVENT_PATH or pass --event');
    const event = readJson(eventPath, 'event');
    const repo = env.GITHUB_REPOSITORY || (event.repository && event.repository.full_name);
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('no repo: set GITHUB_REPOSITORY');

    const target = targetOf(event);
    if (target.skip) {
      say(`Tag skipped: ${target.skip}.`);
      return 0;
    }
    // Two tokens: the job's own reads the PR and the tags; the release App's only writes them.
    const apiUrl = env.GITHUB_API_URL;
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl });
    if (!io.releaser && !env.RELEASE_TOKEN) throw new ReleaseError('no release token: set RELEASE_TOKEN to the release App\'s token');
    const releaser = io.releaser || createClient({ token: env.RELEASE_TOKEN, apiUrl });
    const prefix = opts.tagPrefix;
    const automationLogins = list(opts.automationLogins);

    let pr;
    let signal;
    if (target.kind === 'push') {
      if (opts.signal === 'ship-job' && !opts.shipResult) {
        throw new ReleaseError('--ship-result is required with the ship-job signal on a push: pass the ship job\'s own result, so a failed ship can never be tagged');
      }
      const found = (await github.listPullsOfCommit(repo, target.sha))
        .filter((p) => p && p.merged_at && p.merge_commit_sha === target.sha && p.base && p.base.ref === target.branch);
      if (!found.length) {
        say(`Tag skipped: ${short(target.sha)} on ${target.branch} is not the merge of a pull request.`);
        return 0;
      }
      if (!isReleaseHead(found[0].head && found[0].head.ref)) {
        say(`Tag skipped: #${found[0].number} is not a release PR.`);
        return 0;
      }
      if (opts.signal === 'ship-job' && opts.shipResult !== 'success') {
        throw new Refusal(`the ship job's result is ${show(opts.shipResult, 40)}, not success, so release PR #${found[0].number} is not tagged. Run the ship job again: the tag follows its pass`);
      }
      pr = await github.getPull(repo, found[0].number);
      signal = SIGNALS[opts.signal];
    } else {
      pr = await github.getPull(repo, target.number);
      if (!isReleaseHead(pr.head && pr.head.ref) || !pr.base || lineOf(pr.base.ref) === null) {
        say(`Tag skipped: #${pr.number} is not a release PR.`);
        return 0;
      }
      const who = target.comment.user;
      if (isBot(who)) throw new Refusal(`/shipped on #${pr.number} is from ${show(who && who.login, 40)}, which is a bot: only a person with write access gives the signal`);
      const permission = await github.collaboratorPermission(repo, who.login);
      if (!WRITE_ACCESS.has(permission)) throw new Refusal(`/shipped on #${pr.number} is from ${show(who.login, 40)}, who has ${show(permission, 20)} access: it takes write access`);
      if (!pr.merged_at) throw new Refusal(`/shipped on #${pr.number} came before the PR merged: say it again once the steps after the merge are done`);
      if (!(Date.parse(target.comment.created_at) >= Date.parse(pr.merged_at))) {
        throw new Refusal(`/shipped on #${pr.number} was written before the PR merged: say it again once the steps after the merge are done`);
      }
      signal = `/shipped by ${loginText(who.login)}`;
    }

    const release = releaseOf(pr, { repo, prefix, automationLogins, sha: target.kind === 'push' ? target.sha : null });
    const made = await makeReleaseTag({
      github, releaser, repo, release, signal,
    });
    const lines = [made === 'created'
      ? `Tagged ${release.tag} at ${short(release.sha)} (annotated; release PR #${release.number}; ${signal}).`
      : `${release.tag} is already tagged at ${short(release.sha)}: left as it is.`];
    if (opts.floatingMajor) {
      const f = await moveFloatingMajor({
        github, releaser, repo, prefix, release,
      });
      lines.push({
        created: `${f.name} created at ${short(f.to)}.`,
        moved: `${f.name} moved from ${short(f.from || '')} to ${short(f.to)}.`,
        unchanged: `${f.name} already at ${short(f.to)}.`,
        left: `${f.name} left where it is: ${f.why}.`,
      }[f.action]);
    }
    for (const l of lines) say(l);
    summary(env, `### Tag\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Tag::${escapeData(e.message)}\n`);
      err.write(`shipyard tag: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    out.write(`::error title=Tag::${escapeData(e.message)}\n`);
    err.write(`shipyard tag: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required|takes no))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

function summary(env, text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  } catch {
    // the summary is a courtesy; the tag and the exit code are the result
  }
}

module.exports = { run, USAGE, targetOf };
