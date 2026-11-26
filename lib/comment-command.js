'use strict';

// `shipyard comment`: answers `/shipped` and `/level` on a PR, for a repo on `.github/shipyard.yml`. It is the step of
// `pr.yml`'s comment job, which the fixed caller `shipyard-pr.yml` runs on an `issue_comment`, so it holds the job's own
// token (contents and pull requests read, actions write) and no secret. Reads the event ($GITHUB_EVENT_PATH):
//
//   `/shipped`  on a merged release PR, from a person with write access: the checks `shipyard tag` makes of a `/shipped`
//               (lib/tag-command.js `startTagRun`, the one implementation), then starts `shipyard-release.yml` on the
//               PR's base branch with the action `shipped` and `{"pr":<PR>,"comment":<comment>}` as `args`. That run
//               reads the comment again and tags in the `release` environment.
//   `/level`    (`/level major`, `/level minor [product]`) on a PR into `main` or `main-<x.y>`, from a person with write
//               access: starts `shipyard-release.yml` on the PR's base branch with the action `check` and `{"pr":<PR>}`,
//               which runs the release check, the only code that reads a `/level` (lib/release-check.js). It re-reads each
//               open release PR's `/level` comments, and ignores one that is not from a member of the area's approver
//               team. This job holds no token that can read that team, so the approver check is the release check's, never
//               this step's: all this step does is keep the dispatch to people who could dispatch it by hand.
//
// A repo not on `shipyard.yml` is skipped: its own workflows answer both comments (`tag.yml`'s `issue_comment` form, the
// release check's caller), and it has no `shipyard-release.yml` to start. A comment that is not one of the two, an edited
// or deleted one, and one on an issue that is not a PR also do nothing. Nothing here reads a file of the PR's head, nothing
// of the comment reaches a shell, and the only thing written is the dispatch.
//
// Exit 0 when a run was started or the event is not one to act on, 1 when refused (nothing started: the commenter has no
// write access or is a bot, the PR is not a release PR), 2 when it could not run.

const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, readJson } = require('./release-args');
const { parseLevelComment, lineOf } = require('./release-check');
const { loadReaderConfig, settingsOf } = require('./reader-config');
const { YAML_FILE } = require('./repo-config');
const { dispatchInputs, ROUTER_WORKFLOW } = require('./dispatch-inputs');
const { isShippedComment, isBot, loginText, show, WRITE_ACCESS } = require('./tag');
const { startTagRun } = require('./tag-command');

const USAGE = 'usage: shipyard comment [--event <event.json>]';
const FLAGS = { '--event': 'event' };
const HOW = 'docs/release-tag.md';

/** `shipped`, `level` or null: which command a comment's body is, by its first line. */
function commandOf(body) {
  if (isShippedComment(body)) return 'shipped';
  return parseLevelComment(body) ? 'level' : null;
}

// What the event asks for, or why it is not ours.
function targetOf(event) {
  if (!event || typeof event !== 'object') throw new ReleaseError('the event is not a JSON object');
  if (!event.issue || !event.comment) return { skip: 'the event is not a comment' };
  if (event.action !== 'created') return { skip: `the comment was ${String(event.action).slice(0, 20)}, and only a new comment is a command` };
  if (!event.issue.pull_request) return { skip: 'the comment is on an issue, not a PR' };
  const command = commandOf(event.comment.body);
  if (!command) return { skip: 'the comment is not /shipped or /level' };
  if (!Number.isInteger(event.issue.number)) throw new ReleaseError('the event has no PR number');
  if (!Number.isSafeInteger(event.comment.id) || event.comment.id < 1) throw new ReleaseError('the event has no comment ID');
  return { command, number: event.issue.number, comment: event.comment };
}

// `/level` is a dispatch of the release check on the PR's base branch, for a person with write access.
async function startCheck({ github, repo, target, say, summary }) {
  const pr = await github.getPull(repo, target.number);
  const base = pr.base && pr.base.ref;
  if (lineOf(base) === null) {
    say(`Comment skipped: #${pr.number} went into ${show(base, 40)}, not main or main-<version>, so there is no release check for a /level.`);
    return 0;
  }
  const who = target.comment.user;
  if (isBot(who)) throw new Refusal(`/level on #${pr.number} is from ${show(who && who.login, 40)}, which is a bot: only a person with write access can ask for a release check`);
  const permission = await github.collaboratorPermission(repo, who.login);
  if (!WRITE_ACCESS.has(permission)) throw new Refusal(`/level on #${pr.number} is from ${show(who.login, 40)}, who has ${show(permission, 20)} access: it takes write access`);
  try {
    await github.dispatchWorkflow(repo, ROUTER_WORKFLOW, base, dispatchInputs(ROUTER_WORKFLOW, 'check', { pr: Number(pr.number) }, {}));
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    throw new GitHubError(`/level by ${loginText(who.login)} on #${pr.number} checks out, but ${ROUTER_WORKFLOW} could not be started on ${base}: ${e.message}. The calling job grants actions: write, and ${ROUTER_WORKFLOW} on ${base} takes workflow_dispatch with the inputs action and args (${HOW}). Run the job again`, e.status);
  }
  const line = `/level by ${loginText(who.login)} on #${pr.number} checks out: started ${ROUTER_WORKFLOW} on ${base} with the action check, which reads the level again. The release check ignores it unless the author is in the area's approver team.`;
  say(line);
  summary(`### Comment\n\n- ${line}\n`);
  return 0;
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  const summary = (text) => {
    if (!env.GITHUB_STEP_SUMMARY) return;
    try {
      require('node:fs').appendFileSync(env.GITHUB_STEP_SUMMARY, text);
    } catch {
      // the summary is a courtesy; the dispatch and the exit code are the result
    }
  };
  try {
    const opts = parseOptions(argv, FLAGS, {});
    if (opts.help) {
      out.write(`${USAGE}\n\nSee ${HOW} for the two commands.\n`);
      return 0;
    }
    const eventPath = opts.event || env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new ReleaseError('no event: set GITHUB_EVENT_PATH or pass --event');
    const event = readJson(eventPath, 'event');
    const repo = env.GITHUB_REPOSITORY || (event.repository && event.repository.full_name);
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('no repo: set GITHUB_REPOSITORY');

    const target = targetOf(event);
    if (target.skip) {
      say(`Comment skipped: ${target.skip}.`);
      return 0;
    }
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: env.GITHUB_API_URL, sleep: io.sleep });
    const warn = (line) => err.write(`${line}\n`);

    // A repo that has not moved keeps its own workflows for both comments, and has no release file to start.
    const facts = await github.repoFacts(repo);
    if (!facts) throw new ReleaseError(`cannot read ${repo}: the job's token cannot see it`);
    // The commit the run is on: for a comment, the default branch's tip. Without one (a run by hand), the branch itself.
    const ref = /^[0-9a-f]{40}$/.test(String(env.GITHUB_SHA || '')) ? env.GITHUB_SHA : facts.defaultBranch;
    const loaded = await loadReaderConfig({ github, repo, ref }, { warn });
    if (loaded.file !== YAML_FILE) {
      say(`Comment skipped: ${repo} is not on ${YAML_FILE}, so its own workflows answer /${target.command}.`);
      return 0;
    }

    if (target.command === 'level') return await startCheck({ github, repo, target, say, summary });

    // The opener logins and the tag prefix are the resolved settings of the default branch's config (the org's list); the run
    // that tags reads them again at the release PR's merge commit.
    const settings = await settingsOf(loaded, {
      repo, area: facts.area, defaultBranch: facts.defaultBranch, github, warn,
    });
    // The router skips `shipped` for a repo that owns it (or whose kind has no such step): starting it would only say a tag is
    // made that is not, so the repo's own handler answers.
    if (!settings.flows.includes('shipped')) {
      say(`Comment skipped: ${repo} does not run /shipped through the release file (its \`own\` list or its kind leaves it out), so its own workflow answers.`);
      return 0;
    }
    return await startTagRun({
      github,
      repo,
      target: { kind: 'comment', number: target.number, comment: target.comment },
      prefix: settings.tagPrefix,
      openersAt: async () => settings.openerLogins,
      env,
      say,
      workflow: ROUTER_WORKFLOW,
    });
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Comment::${escapeData(e.message)}\n`);
      err.write(`shipyard comment: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    out.write(`::error title=Comment::${escapeData(e.message)}\n`);
    err.write(`shipyard comment: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required|takes no))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE, targetOf, commandOf };
