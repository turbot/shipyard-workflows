'use strict';

// `shipyard tag`: tags a release after the shipped signal. Reads the event ($GITHUB_EVENT_PATH):
//   - a `push` to main or main-<x.y> (the merge of a release PR), with the signal `ship-job` (the
//     repo's ship job ran first and its result is `--ship-result`) or `merge` (a Go library: the tag
//     is the publish),
//   - an `issue_comment` that starts `/shipped`, from a person with write access, on a release PR
//     that has merged (where steps after the merge are still done by hand). A comment runs on the
//     default branch, which the `release` environment refuses, so this run holds no release token:
//     it checks the comment and starts the caller's workflow on the PR's base branch
//     (`workflow_dispatch`, inputs `pr` and `comment`), or
//   - that `workflow_dispatch`: it reads the comment again from GitHub, checks it as before, and tags.
// Then it makes an annotated tag at the merge commit, as the release App, and with `--floating-major`
// moves the floating major tag (`v1`). Then it makes the GitHub Release at the tag (its body the
// CHANGELOG section; with `--assets`, as a draft that gets the caller's files and is then published)
// and one "Shipped" comment on the release PR, each once. The release PR is read
// from GitHub, never from the event.
// Exit 0 when tagged (or already tagged, or the tag run started, or the event is not one to tag), 1
// when refused (no tag), 2 when it could not run (a failed call is run again, and only what is left
// is done).

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, readJson } = require('./release-args');
const { lineOf } = require('./release-check');
const { loadAssets, checkArtifactName } = require('./tag-assets');
const {
  releaseOf, releaseOfPull, releaseOfPush, makeReleaseTag, moveFloatingMajor, makeGitHubRelease, postShippedComment, isShippedComment, isBot, isReleaseHead, loginText, show, short, WRITE_ACCESS,
} = require('./tag');

const USAGE = 'usage: shipyard tag --automation-logins <a,b> [--signal ship-job|merge] [--ship-result <result>] [--tag-prefix <prefix>] [--floating-major] [--product <name>] [--changelog <path>] [--assets <artifact> --assets-dir <dir> [--assets-failed]] [--event <event.json>]';
const FLAGS = {
  '--event': 'event', '--tag-prefix': 'tagPrefix', '--automation-logins': 'automationLogins', '--signal': 'signal', '--ship-result': 'shipResult', '--product': 'product', '--changelog': 'changelog', '--assets': 'assets', '--assets-dir': 'assetsDir',
};
const SWITCHES = { '--floating-major': 'floatingMajor', '--assets-failed': 'assetsFailed' };
const SIGNALS = { 'ship-job': "the repo's ship job passed", merge: 'the merge (a library: the tag is the publish)' };

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
const positive = (value) => (/^[1-9][0-9]{0,15}$/.test(String(value ?? '')) ? Number(value) : null);
const HOW = 'docs/release-tag.md';

function checkOptions(opts) {
  if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError(`--tag-prefix ${show(opts.tagPrefix)} is not a tag prefix`);
  if (!Object.hasOwn(SIGNALS, opts.signal)) throw new ReleaseError(`--signal must be ship-job or merge, not ${show(opts.signal, 40)}`);
  if (!list(opts.automationLogins).length) throw new ReleaseError('--automation-logins is required: name the accounts that open release PRs, or any PR from a release/ branch could be tagged');
  if (/[\r\n]/.test(opts.product || '')) throw new ReleaseError('--product is one line');
  if (!/^[A-Za-z0-9._/-]+$/.test(opts.changelog) || opts.changelog.startsWith('-') || opts.changelog.startsWith('/') || opts.changelog.split('/').includes('..')) {
    throw new ReleaseError(`--changelog must be a path inside the repo, not ${show(opts.changelog)}`);
  }
  if (opts.assetsFailed && !opts.assets) throw new ReleaseError('--assets-failed goes with --assets');
  if (Boolean(opts.assets) !== Boolean(opts.assetsDir)) throw new ReleaseError('--assets (the artifact\'s name) and --assets-dir (the folder it was downloaded into) go together');
  if (opts.assets) checkArtifactName(opts.assets);
  if (opts.assetsDir && (opts.assetsDir.startsWith('-') || /[\r\n\0]/.test(opts.assetsDir))) throw new ReleaseError(`--assets-dir must be a folder, not ${show(opts.assetsDir)}`);
  if (opts.signal === 'merge' && opts.shipResult) throw new ReleaseError('--ship-result goes with the ship-job signal, not merge');
}

// What the event asks for: a push to a release branch, a `/shipped` comment, the run a `/shipped`
// started, or why it is not ours.
function targetOf(event) {
  if (!event || typeof event !== 'object') throw new ReleaseError('the event is not a JSON object');
  if (event.issue && event.comment) {
    if (event.action !== 'created') return { skip: `the comment was ${String(event.action).slice(0, 20)}, and only a new comment is a signal` };
    if (!event.issue.pull_request) return { skip: 'the comment is on an issue, not a PR' };
    if (!isShippedComment(event.comment.body)) return { skip: 'the comment does not start with /shipped' };
    if (!Number.isInteger(event.issue.number)) throw new ReleaseError('the event has no PR number');
    if (!positive(event.comment.id)) throw new ReleaseError('the event has no comment ID');
    return { kind: 'comment', number: event.issue.number, comment: event.comment };
  }
  // A workflow_dispatch event names its workflow and carries its inputs, and has no `after`.
  if (typeof event.workflow === 'string' && typeof event.ref === 'string' && event.after === undefined) {
    const inputs = event.inputs && typeof event.inputs === 'object' ? event.inputs : {};
    const number = positive(inputs.pr);
    const commentId = positive(inputs.comment);
    if (!number || !commentId) {
      throw new ReleaseError(`the run has no pr and comment inputs: a /shipped comment starts it with both, the release PR's number and the comment's ID (${HOW})`);
    }
    if (!event.ref.startsWith('refs/heads/')) throw new ReleaseError(`the run is on ${show(event.ref, 60)}, not a branch`);
    return { kind: 'dispatch', number, commentId, branch: event.ref.slice('refs/heads/'.length) };
  }
  if (typeof event.ref === 'string' && typeof event.after === 'string') {
    const branch = event.ref.replace(/^refs\/heads\//, '');
    if (!event.ref.startsWith('refs/heads/') || lineOf(branch) === null) return { skip: `${show(event.ref, 60)} is not main or main-<version>` };
    if (event.deleted || !/^[0-9a-f]{40}$/.test(event.after)) return { skip: 'the push deleted the branch' };
    return { kind: 'push', branch, sha: event.after };
  }
  throw new ReleaseError('not a push, a comment or a workflow_dispatch event');
}

// The checks a `/shipped` comment passes, on the comment and the PR as GitHub holds them: a person
// (not a bot) with write access wrote it, after the PR merged. Returns the signal for the tag message.
async function checkShipped(github, repo, pr, comment) {
  const who = comment.user;
  if (isBot(who)) throw new Refusal(`/shipped on #${pr.number} is from ${show(who && who.login, 40)}, which is a bot: only a person with write access gives the signal`);
  const permission = await github.collaboratorPermission(repo, who.login);
  if (!WRITE_ACCESS.has(permission)) throw new Refusal(`/shipped on #${pr.number} is from ${show(who.login, 40)}, who has ${show(permission, 20)} access: it takes write access`);
  if (!pr.merged_at) throw new Refusal(`/shipped on #${pr.number} came before the PR merged: say it again once the steps after the merge are done`);
  if (!(Date.parse(comment.created_at) >= Date.parse(pr.merged_at))) {
    throw new Refusal(`/shipped on #${pr.number} was written before the PR merged: say it again once the steps after the merge are done`);
  }
  return `/shipped by ${loginText(who.login)}`;
}

// The caller's own workflow file, which the `/shipped` check starts again on the release PR's base
// branch. In a called workflow GITHUB_WORKFLOW_REF names the caller's workflow:
// `<owner>/<repo>/.github/workflows/<file>@<ref>`.
function callerWorkflowOf(workflowRef, repo) {
  const m = /^([^/]+\/[^/]+)\/\.github\/workflows\/([A-Za-z0-9._-]+\.ya?ml)@/.exec(String(workflowRef || ''));
  if (!m || m[1].toLowerCase() !== repo.toLowerCase()) {
    throw new ReleaseError(`cannot tell which workflow to start: GITHUB_WORKFLOW_REF is ${show(workflowRef)}, not a workflow of ${repo}`);
  }
  return m[2];
}

// A comment's `issue_url` names the issue or PR it is on.
const isCommentOn = (comment, repo, number) => String(comment.issue_url || '').toLowerCase().endsWith(`/repos/${repo.toLowerCase()}/issues/${number}`);

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, {
      tagPrefix: 'v', signal: 'ship-job', product: '', changelog: 'CHANGELOG.md', assets: '', assetsDir: '',
    }, SWITCHES);
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
    // Two tokens: the job's own reads the PR and the tags; the release App's only writes them. A
    // `/shipped` comment runs with no release token: it only checks and starts the tag run.
    const apiUrl = env.GITHUB_API_URL;
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl });
    const prefix = opts.tagPrefix;
    const automationLogins = list(opts.automationLogins);
    if (target.kind === 'comment') {
      return await startTagRun({
        github, repo, target, prefix, automationLogins, env, say,
      });
    }
    if (!io.releaser && !env.RELEASE_TOKEN) throw new ReleaseError(`no release token: set RELEASE_TOKEN to the release App's token, which the tag workflow makes in the release environment (docs/release-apps.md)`);
    const releaser = io.releaser || createClient({ token: env.RELEASE_TOKEN, apiUrl });

    let release;
    let signal;
    if (target.kind === 'push') {
      if (opts.signal === 'ship-job' && !opts.shipResult) {
        throw new ReleaseError('--ship-result is required with the ship-job signal on a push: pass the ship job\'s own result, so a failed ship can never be tagged');
      }
      // The one answer to "is this push a release merge" (lib/tag.js). A failed ship is refused once
      // the release PR is found, before it is read.
      const found = await releaseOfPush({
        github,
        repo,
        branch: target.branch,
        sha: target.sha,
        prefix,
        automationLogins,
        beforeRead: (number) => {
          if (opts.signal === 'ship-job' && opts.shipResult !== 'success') {
            throw new Refusal(`the ship job's result is ${show(opts.shipResult, 40)}, not success, so release PR #${number} is not tagged. Run the ship job again: the tag follows its pass`);
          }
        },
      });
      if (found.skip) {
        say(`Tag skipped: ${found.skip}.`);
        return 0;
      }
      release = found.release;
      signal = SIGNALS[opts.signal];
    } else {
      // The run a `/shipped` started. Whoever started it, the comment is read again from GitHub and
      // must still pass every check, and the run must be on the release PR's own base branch.
      const pr = await github.getPull(repo, target.number);
      const base = pr.base && pr.base.ref;
      if (base !== target.branch) {
        throw new Refusal(`#${pr.number} went into ${show(base, 40)}, and its tag is made by a run on that branch, not on ${show(target.branch, 40)}`);
      }
      const comment = await github.getIssueComment(repo, target.commentId);
      if (!comment || !isCommentOn(comment, repo, pr.number)) throw new Refusal(`comment ${target.commentId} is not a comment on #${pr.number}`);
      if (!isShippedComment(comment.body)) throw new Refusal(`comment ${target.commentId} on #${pr.number} does not start with /shipped`);
      signal = await checkShipped(github, repo, pr, comment);
      release = await releaseOfPull({
        github, repo, pr, prefix, automationLogins, sha: null,
      });
    }

    // The release's files, read before the tag is made: a release that cannot carry them is never
    // tagged. A Release already published needs none (and could take none), so a run again after the
    // artifact has expired still finishes what is left.
    let files = null;
    if (opts.assets && !(await github.getRelease(repo, release.tag))) {
      // A download that failed may have left some of the files: a release is never tagged on part of them.
      if (opts.assetsFailed) {
        throw new Refusal(`the download of the artifact ${show(opts.assets, 60)} failed, so the files may be missing or short. Run the job again once the artifact is there (docs/release-tag.md). This run changed nothing`);
      }
      files = loadAssets({ dir: opts.assetsDir, name: opts.assets });
    }
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

    // The outputs follow the tag. Each is made once; one that fails fails the job, and a run again makes what is missing.
    const product = (opts.product || '').trim() || repo.split('/')[1];
    let shipped;
    let shippedUrl;
    try {
      const gitHubRelease = await makeGitHubRelease({
        github, releaser, repo, prefix, release, product, changelog: opts.changelog, assets: files,
      });
      lines.push(gitHubRelease.action === 'created'
        ? `GitHub Release ${release.tag} made: ${gitHubRelease.url}`
        : `GitHub Release ${release.tag} already exists: left as it is.`);
      if (gitHubRelease.files) {
        const kept = gitHubRelease.files.filter((f) => !gitHubRelease.uploaded.includes(f));
        lines.push(`Files on the Release: ${gitHubRelease.files.join(', ')}${kept.length ? ` (${kept.length} already on the draft: ${kept.join(', ')})` : ''}.`);
      }
      shippedUrl = gitHubRelease.url;
      shipped = await postShippedComment({
        github, releaser, repo, release, url: gitHubRelease.url, automationLogins,
      });
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      throw new GitHubError(`${release.tag} is tagged, but ${e.message}. The release App's token needs contents write (for the Release) and pull-requests write (for the comment). Run the job again: it makes only what is left`, e.status);
    }
    lines.push(shipped === 'created'
      ? `Shipped comment posted on #${release.number}.`
      : `Shipped comment already on #${release.number}: left as it is.`);
    for (const r of release.reships) {
      let done;
      try {
        done = await postShippedComment({
          github, releaser, repo, release, url: shippedUrl, automationLogins, number: r.releasePr, via: release.number,
        });
      } catch (e) {
        if (!(e instanceof GitHubError)) throw e;
        throw new GitHubError(`${release.tag} is tagged, but the Shipped comment on #${r.releasePr}, the release PR this re-ships, failed: ${e.message}. Run the job again: it makes only what is left`, e.status);
      }
      lines.push(done === 'created'
        ? `Shipped comment posted on #${r.releasePr}, the release PR this re-ships.`
        : `Shipped comment already on #${r.releasePr}: left as it is.`);
    }
    for (const l of lines) say(l);
    summary(env, `### Tag\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
    // The workflow's merge-back step runs only for a release that is tagged: it reads this.
    output(env, `tag=${release.tag}\n`);
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

// A `/shipped` comment, in a run with no release token: checks the comment and the release PR, then
// starts the caller's workflow on the PR's base branch, where the tag job can reach the release App.
async function startTagRun({
  github, repo, target, prefix, automationLogins, env, say,
}) {
  const pr = await github.getPull(repo, target.number);
  if (!isReleaseHead(pr.head && pr.head.ref) || !pr.base || lineOf(pr.base.ref) === null) {
    say(`Tag skipped: #${pr.number} is not a release PR.`);
    return 0;
  }
  const signal = await checkShipped(github, repo, pr, target.comment);
  const release = releaseOf(pr, { repo, prefix, automationLogins });
  const workflow = callerWorkflowOf(env.GITHUB_WORKFLOW_REF, repo);
  try {
    await github.dispatchWorkflow(repo, workflow, release.base, { pr: String(release.number), comment: String(target.comment.id) });
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    throw new GitHubError(`${signal} on #${release.number} checks out, but ${workflow} could not be started on ${release.base}: ${e.message}. The calling job grants actions: write, and ${workflow} on ${release.base} takes workflow_dispatch with the inputs pr and comment (${HOW}). Run the job again`, e.status);
  }
  const line = `${signal} on #${release.number} checks out: started ${workflow} on ${release.base}, which tags ${release.tag} in the release environment.`;
  say(line);
  summary(env, `### Tag\n\n- ${line}\n`);
  return 0;
}

function summary(env, text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  } catch {
    // the summary is a courtesy; the tag and the exit code are the result
  }
}

// A step output for the workflow's later steps. Failing to write it only skips them: the tag is made.
function output(env, text) {
  if (!env.GITHUB_OUTPUT) return;
  try {
    fs.appendFileSync(env.GITHUB_OUTPUT, text);
  } catch {
    // the later steps then do not run; the tag and the exit code are the result
  }
}

module.exports = { run, USAGE, targetOf, callerWorkflowOf };
