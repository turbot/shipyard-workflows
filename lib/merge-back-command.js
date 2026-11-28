'use strict';

// `shipyard merge-back`: after a release is tagged, merges the release branch back into the work
// branch the candidate was cut from (docs/release-tag.md). Reads the same event as `shipyard tag`
// in the job that holds the release token: a push to main or main-<x.y>, or the `workflow_dispatch`
// a `/shipped` comment started there. (The comment's own run holds no token and only starts that
// run, so it merges nothing back.) It finds the merged release PR from GitHub, never from the event. It acts only when the tag exists at that PR's merge commit, so it is
// never ahead of the tag. The work branch is the `Release-From` trailer of the PR's cut commit.
// Then it opens one PR from the release branch into the work branch (or finds the open one) and
// merges it with a merge commit once the work branch's required checks pass; the tag's commit already in the branch is done.
// Exit 0 when merged or already in, or the event is not one to merge back; 1 when it could not be
// done and the PR (if any) stays open, with the message saying what to do; 2 when it could not run
// (run it again: nothing it did is done twice).

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, readJson } = require('./release-args');
const { targetOf } = require('./tag-command');
const {
  releaseOf, mergedPullOfPush, commitOfRef, isReleaseHead, isReleaseBase, show, short,
} = require('./tag');
const { workBranchOf, checkWorkBranch, mergeBack } = require('./merge-back');
const { openersOf, parseIds } = require('./openers');

const USAGE = 'usage: shipyard merge-back [--automation-ids <id,id>] [--automation-logins <a,b>] [--tag-prefix <prefix>] [--wait-minutes <n>] [--wait-for-tag-minutes <n>] [--event <event.json>]';
const FLAGS = {
  '--event': 'event', '--tag-prefix': 'tagPrefix', '--automation-logins': 'automationLogins', '--automation-ids': 'automationIds', '--wait-minutes': 'waitMinutes', '--wait-for-tag-minutes': 'waitForTagMinutes',
};
const DEFAULT_WAIT_MINUTES = 20;
const MAX_WAIT_FOR_TAG_MINUTES = 60;

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, { tagPrefix: 'v', waitMinutes: String(DEFAULT_WAIT_MINUTES), waitForTagMinutes: '0' });
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-tag.md for what the merge-back does and what it needs.\n`);
      return 0;
    }
    if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError(`--tag-prefix ${show(opts.tagPrefix)} is not a tag prefix`);
    // The accounts that open release PRs: exactly the ones the flags name, or Shipyard's own, by user ID, when they name none
    // (lib/openers.js).
    const openers = openersOf({ ids: parseIds(opts.automationIds), logins: list(opts.automationLogins) });
    const waitMinutes = Number(opts.waitMinutes);
    if (!/^\d+$/.test(String(opts.waitMinutes)) || waitMinutes > 60) throw new ReleaseError(`--wait-minutes must be a whole number of minutes, at most 60, not ${show(opts.waitMinutes, 20)}`);
    const waitForTag = Number(opts.waitForTagMinutes);
    if (!/^\d+$/.test(String(opts.waitForTagMinutes)) || waitForTag > MAX_WAIT_FOR_TAG_MINUTES) {
      throw new ReleaseError(`--wait-for-tag-minutes must be a whole number of minutes, at most ${MAX_WAIT_FOR_TAG_MINUTES}, not ${show(opts.waitForTagMinutes, 20)}`);
    }
    const eventPath = opts.event || env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new ReleaseError('no event: set GITHUB_EVENT_PATH or pass --event');
    const event = readJson(eventPath, 'event');
    const repo = env.GITHUB_REPOSITORY || (event.repository && event.repository.full_name);
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('no repo: set GITHUB_REPOSITORY');

    const target = targetOf(event);
    if (target.skip) {
      say(`Merge-back skipped: ${target.skip}.`);
      return 0;
    }
    if (target.kind === 'comment') {
      say('Merge-back skipped: a /shipped comment only starts the tag run, and the merge-back follows the tag there.');
      return 0;
    }
    const apiUrl = env.GITHUB_API_URL;
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl, sleep: io.sleep });
    if (!io.writer && !env.RELEASE_TOKEN) throw new ReleaseError('no release token: set RELEASE_TOKEN to the release App\'s token');
    const writer = io.writer || createClient({ token: env.RELEASE_TOKEN, apiUrl, sleep: io.sleep });

    let pr;
    if (target.kind === 'push') {
      // The tag's own lookup (lib/tag.js), with merge-back's one skip line.
      const found = await mergedPullOfPush({
        github, repo, branch: target.branch, sha: target.sha,
      });
      if (found.skip) {
        say(`Merge-back skipped: ${short(target.sha)} on ${target.branch} is not the merge of a release PR.`);
        return 0;
      }
      pr = await github.getPull(repo, found.number);
    } else {
      pr = await github.getPull(repo, target.number);
      if (!isReleaseHead(pr.head && pr.head.ref) || !pr.base || !isReleaseBase(pr.base.ref)) {
        say(`Merge-back skipped: #${pr.number} is not a release PR.`);
        return 0;
      }
      // As the tag does: the run that tags is on the branch the PR went into.
      if (pr.base.ref !== target.branch) {
        throw new Refusal(`#${pr.number} went into ${show(pr.base.ref, 40)}, and its merge-back is made by a run on that branch, not on ${show(target.branch, 40)}`);
      }
    }

    // The same checks as the tag's: the merged release PR is what the tag was made from.
    const release = releaseOf(pr, {
      repo, prefix: opts.tagPrefix, openers, sha: target.kind === 'push' ? target.sha : null,
    });
    // Never ahead of the tag: with no tag at the merge commit there is nothing to merge back yet.
    // A repo that tags in its own workflow (the router does not tag it) is merged back by this run beside that one, so with
    // `--wait-for-tag-minutes` it waits, for at most that long, for the tag to appear: never merging ahead of it.
    const isTagged = async () => {
      const ref = await github.getTagRef(repo, release.tag);
      return Boolean(ref) && (await commitOfRef(github, repo, ref)) === release.sha;
    };
    let tagged = await isTagged();
    if (!tagged && waitForTag > 0) {
      const timing = io.timing || {};
      const now = timing.now || Date.now;
      const sleep = timing.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
      const pollMs = timing.pollMs || 30000;
      const until = now() + waitForTag * 60000;
      while (!tagged && now() + pollMs <= until) {
        await sleep(pollMs);
        tagged = await isTagged();
      }
    }
    if (!tagged) {
      throw new Refusal(`${release.tag} is not tagged at the merge commit ${short(release.sha)}, so release PR #${release.number} is not merged back yet: it follows the tag`);
    }
    // The tag is out: say which, before the merge-back, which can wait for a person. The router's announcement of a repo that
    // tags in its own workflow reads it, so a merge-back that fails leaves the output set.
    output(env, `tag=${release.tag}\n`);
    const into = await workBranchOf(github, repo, pr.head.sha, release.tag);
    checkWorkBranch(into, release);

    const result = await mergeBack({
      github, writer, repo, release, into, ownRun: /^\d+$/.test(env.GITHUB_RUN_ID || '') ? env.GITHUB_RUN_ID : null, waitMs: waitMinutes * 60000, ...(io.timing || {}),
    });
    const line = result.action === 'already'
      ? `${release.tag}'s commit ${short(release.sha)} is already in ${into}: nothing to merge back.`
      : `${release.base} merged back into ${into} by #${result.number}${result.opened ? '' : ' (found open)'}, with a merge commit.`;
    say(line);
    summary(env, `### Merge-back\n\n- ${line}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Merge-back::${escapeData(e.message)}\n`);
      err.write(`shipyard merge-back: ${e.message}\n`);
      summary(env, `### Merge-back\n\n- Not done: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    out.write(`::error title=Merge-back::${escapeData(e.message)}\n`);
    err.write(`shipyard merge-back: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required|takes no))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

function summary(env, text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  } catch {
    // the summary is a courtesy; the result and the exit code are the answer
  }
}

// A step output for the workflow's later jobs. Failing to write it only leaves it out: the merge-back and the exit code are the result.
function output(env, text) {
  if (!env.GITHUB_OUTPUT) return;
  try {
    fs.appendFileSync(env.GITHUB_OUTPUT, text);
  } catch {
    // the announcement then waits for the tag job's own output, or for a dispatch
  }
}

module.exports = { run, USAGE };
