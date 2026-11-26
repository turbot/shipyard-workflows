'use strict';

// `shipyard prepare-again --pr <n> --comment <id> [--approvers <org>/<team>] [--automation-logins <a,b>] [--note <text>]
// [--dir <checkout>]`: the router's `prepare-again` job (workflows/prepare-again.yml), the run a `/prepare-again` comment on an
// open release PR starts (lib/prepare-again.js). It reads the comment and the PR again from GitHub, checks the request, files
// one prep job for the release in this repo (labelled `agent:release`, trigger `prepare again`, the PR and the comment in its
// marker) and replies on the PR with the request marker the cut and the record read. In order:
//
//   - a request this PR's replies already accepted (a marker naming this comment, by `github-actions[bot]`) is said so, and
//     nothing is written: a run again of the job files no second job and posts no second reply;
//   - the comment must be on this PR, by a person, unedited, and still the command;
//   - the PR must be open, and a release PR of this repo: its head a `release/` branch of this repo, its base `main` or
//     `main-<x.y>`, its body carrying `<!-- shipyard:release-pr <tag> -->`;
//   - the comment's author must be an area approver (lib/approver-team.js, the check `/level` uses: `--approvers`, read with
//     `SHIPYARD_ORG_TOKEN`, else the job's own token);
//   - `--note`, set by the route job when the router does not run both the cut and the record for the repo, refuses it;
//   - the release data must verify against the cut commit, and be one that can be prepared again: in the body (not a release
//     cut before the data moved there), not light, not a patch or a re-ship, and with a release run on the page;
//   - no other accepted request may be pending: one whose prep job is still open and which no commit of the PR has applied.
//
// Every refusal is one reply on the PR naming the reason, and nothing else is written. Nothing of the comment's text reaches a
// shell, the job's body or the prep run: the job is made from the release data the cut pinned.
//
// Exit 0 when the job is filed and the reply posted (or the request was accepted before), 1 when refused (the reply says why),
// 2 when it could not run: a bad option, GitHub could not be read, or a reply that could not be posted.

const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal, lineOf, isBranchName } = require('./release-git');
const { parseOptions } = require('./release-args');
const { readReleaseInputs, commitsFromGitHub, trailerValues } = require('./release-data');
const { tagOf, releaseRunOf } = require('./record');
const { isLight } = require('./light');
const { isBot, isReleaseHead } = require('./tag');
const { approverCheck } = require('./approver-team');
const {
  JOB_LABEL, jobTitle, jobBody, parseJob,
} = require('./prep-job');
const { cutPin } = require('./pin');
const { loadRepoConfigAt, YAML_FILE } = require('./repo-config');
const { currentOf } = require('./shipyard-version');
const {
  BOT_LOGIN, isPrepareAgainComment, parseRequestMarkers, appliedRequests, acceptedReply, refusedReply, shown,
} = require('./prepare-again');

const USAGE = 'usage: shipyard prepare-again --pr <number> --comment <id> [--approvers <org>/<team>] [--automation-logins <a,b>] [--note <text>] [--dir <checkout>]';
const FLAGS = {
  '--pr': 'pr',
  '--comment': 'comment',
  '--approvers': 'approvers',
  '--automation-logins': 'automationLogins',
  '--note': 'note',
  '--dir': 'dir',
};
const HOW = 'docs/how-we-release.md, "After the release PR opens"';
const TEAM = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
const wholeNumber = (value, flag) => {
  const text = String(value ?? '');
  if (!/^[1-9][0-9]{0,15}$/.test(text)) throw new ReleaseError(`${flag} must be a positive whole number, not ${JSON.stringify(shown(text, 30))}`);
  return Number(text);
};
const sameRepo = (a, b) => String(a || '').toLowerCase() === String(b || '').toLowerCase();
// An issue the repo's own Actions filed: the only prep job this command trusts as its own.
const byActions = (issue) => Boolean(issue && issue.user && issue.user.login === BOT_LOGIN);
const isCommentOn = (comment, repo, number) => String(comment.issue_url || '').toLowerCase().endsWith(`/repos/${repo.toLowerCase()}/issues/${number}`);

// The checks, in order: a Refusal names what is wrong. Returns what to do: `{ before }` for a request already accepted, else
// `{ job, marker }`, the job to file and the reply's marker fields.
async function decide({
  github, orgGithub, repo, number, commentId, opts, dir, current, publishedRemote,
}) {
  // Read first: a request already accepted is answered once, whatever has changed since (the cut may have applied it).
  const comments = await github.listIssueComments(repo, number);
  const markers = parseRequestMarkers(comments);
  const before = markers.find((m) => m.request === commentId);
  if (before) return { before };

  const comment = await github.getIssueComment(repo, commentId);
  if (!comment) throw new Refusal(`comment ${commentId} is not there any more: it was deleted`);
  if (!isCommentOn(comment, repo, number)) throw new Refusal(`comment ${commentId} is not a comment on #${number}`);
  if (isBot(comment.user)) throw new Refusal(`comment ${commentId} is from ${shown(comment.user && comment.user.login, 40)}, a bot: only a person can ask for a new prep`);
  if (comment.created_at && comment.updated_at && comment.updated_at !== comment.created_at) {
    throw new Refusal(`comment ${commentId} was edited after it was written: write /prepare-again again in a new comment`);
  }
  if (!isPrepareAgainComment(comment.body)) throw new Refusal(`comment ${commentId} is no longer /prepare-again`);

  const pull = await github.getPull(repo, number);
  if (pull.merged_at) throw new Refusal(`#${number} is merged: only an open release PR can be prepared again`);
  if (pull.state !== 'open') throw new Refusal(`#${number} is closed: only an open release PR can be prepared again`);
  const head = pull.head || {};
  const headRepo = head.repo && head.repo.full_name;
  if (!isReleaseHead(head.ref) || !sameRepo(headRepo, repo)) throw new Refusal(`#${number} is not a release PR: its head is not a release/ branch of ${repo}`);
  if (!pull.base || lineOf(pull.base.ref) === null) throw new Refusal(`#${number} is not a release PR: it goes into ${shown(pull.base && pull.base.ref, 40)}, not main or main-<x.y>`);
  const tag = tagOf(pull.body);
  if (!tag || !TAG.test(tag) || tag.includes('..')) throw new Refusal(`#${number} is not a release PR: its body has no <!-- shipyard:release-pr <tag> --> marker`);
  if (typeof head.sha !== 'string' || !/^[0-9a-f]{40}$/.test(head.sha)) throw new ReleaseError(`GitHub gave #${number} no head commit`);

  const who = await approverCheck({
    orgGithub, team: opts.approvers || null, user: comment.user, fleetLogins: list(opts.automationLogins),
  });
  if (!who.accepted) throw new Refusal(`/prepare-again ${who.why}. Only an area approver can ask for a new prep, as for /level`);

  if (opts.note) throw new Refusal(opts.note);

  let inputs;
  try {
    inputs = await readReleaseInputs({
      body: pull.body, tag, headSha: head.sha, getCommit: commitsFromGitHub(github, repo), prNumber: number, readFolderFile: async () => null, current,
    });
  } catch (e) {
    if (e instanceof GitHubError && e.status !== 404) throw e;
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    throw new Refusal(`the release data of #${number} does not verify: ${e.message}`);
  }
  if (inputs.source === 'folder') throw new Refusal(`${tag} was cut before the release data moved into the PR's body, so it cannot be prepared again: cut the release again`);
  const { facts } = inputs;
  if (!facts || !facts.repo || !sameRepo(facts.repo.name, repo) || !facts.range) throw new Refusal(`the release data of #${number} is not for ${repo}`);
  if (inputs.profile === 'light' || isLight(facts)) throw new Refusal(`${tag} is a light release, which has no prep to make again`);
  const cutMessage = inputs.cut.message;
  if (trailerValues(cutMessage, 'Release-Patch').length) throw new Refusal(`${tag} is a patch: its report is the fixes it picks, and a patch is not prepared again`);
  if (trailerValues(cutMessage, 'Release-Reship').length) throw new Refusal(`${tag} is a re-ship, which ships the report that merged, and is not prepared again`);
  if (!releaseRunOf(pull.body)) throw new Refusal(`#${number}'s page names no release run yet, so there are no results to record the new report with: wait for the record, then ask again`);

  // A request already accepted is pending while its job is open and no commit of the PR has applied it: one a reply names, or one
  // whose job the repo's Actions filed for this PR and whose reply was lost.
  const openJobs = (await github.listOpenIssuesByLabel(repo, JOB_LABEL)).map((i) => ({ issue: i, job: byActions(i) ? parseJob(i.body) : null }));
  const open = new Set(openJobs.map((j) => j.issue.number));
  const waiting = [
    ...markers.filter((m) => m.request !== commentId && open.has(m.job)).map((m) => ({ job: m.job, request: m.request })),
    ...openJobs.filter((j) => j.job && j.job.prepareAgain && j.job.prepareAgain.pr === number && j.job.prepareAgain.request !== commentId)
      .map((j) => ({ job: j.issue.number, request: j.job.prepareAgain.request })),
  ];
  if (waiting.length) {
    const applied = await appliedRequests({ headSha: head.sha, tag, getCommit: commitsFromGitHub(github, repo) });
    const pending = waiting.find((m) => !applied.has(m.request));
    if (pending) throw new Refusal(`a request is already pending: prep job #${pending.job}, for comment ${pending.request}, is still open. Wait for its report, or close that job and ask again`);
  }
  // The job this request filed before, when its reply was lost: reused, never filed twice.
  const found = openJobs.find((j) => j.job && j.job.prepareAgain && j.job.prepareAgain.pr === number && j.job.prepareAgain.request === commentId);

  const froms = trailerValues(cutMessage, 'Release-From');
  const branch = froms.length === 1 && isBranchName(froms[0]) && lineOf(froms[0]) === null ? froms[0] : null;
  if (!branch) throw new Refusal(`the cut commit of ${tag} names no work branch (Release-From), so a prep job has no branch to name: cut the release again`);
  const commit = facts.range.to;
  const tagPrefix = typeof facts.tagPrefix === 'string' ? facts.tagPrefix : 'v';
  const firstRelease = facts.firstRelease && typeof facts.firstRelease.version === 'string' ? facts.firstRelease.version : null;
  const shipped = [
    ...(facts.prs || []).filter((p) => p && !p.shipsNothing && Number.isSafeInteger(p.number)).map((p) => ({ pr: p.number })),
    ...(facts.unattributed || []).filter((u) => u && /^[0-9a-f]{40}$/.test(String(u.sha))).map((u) => ({ sha: u.sha })),
  ];
  let pin;
  try {
    pin = cutPin(dir, commit, publishedRemote ? { remote: publishedRemote } : {});
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    pin = { why: `the checkout could not be read at ${String(commit).slice(0, 7)}: ${e.message}` };
  }
  let kind = null;
  try {
    const loaded = loadRepoConfigAt({ dir, rev: commit }, { warn: () => {} });
    if (loaded.file === YAML_FILE && typeof loaded.config.kind === 'string') kind = loaded.config.kind;
  } catch {
    // the kind only adds the API tool's note for a Go library; a job without it is still right for every other kind
  }
  const fields = {
    repo, branch, commit, trigger: 'prepare again', from: facts.range.from, tagPrefix, approvers: [`@${opts.approvers}`], firstRelease,
  };
  const body = jobBody({
    ...fields, shipped, bumps: [], pin, kind, prepareAgain: { pr: number, request: commentId },
  });
  if (!parseJob(body)) throw new ReleaseError(`the prep job made for ${tag} does not read back: its range or branch is not one a job can name`);
  return {
    job: { title: jobTitle({ repo, branch, commit }), body },
    filed: found ? found.issue.number : null,
    marker: {
      request: commentId, by: comment.user.login, head: head.sha, tag,
    },
  };
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.' });
    if (opts.help) {
      out.write(`${USAGE}\n\nChecks a /prepare-again comment on an open release PR, files one prep job for the release in this repo and replies on the PR. Every refusal replies with its reason and files nothing. See ${HOW}.\n`);
      return 0;
    }
    const number = wholeNumber(opts.pr, '--pr');
    const commentId = wholeNumber(opts.comment, '--comment');
    if (opts.approvers !== undefined && opts.approvers !== '' && !TEAM.test(opts.approvers)) throw new ReleaseError(`--approvers must be the approver team, as <org>/<team>, not ${JSON.stringify(shown(opts.approvers, 60))}`);
    const repo = env.GITHUB_REPOSITORY;
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('no repo: set GITHUB_REPOSITORY');
    const apiUrl = env.GITHUB_API_URL;
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl, sleep: io.sleep });
    // Team membership needs a token that can read the org; the job's own token cannot (as the release check reads it).
    const orgToken = env.SHIPYARD_ORG_TOKEN;
    const orgGithub = io.orgGithub || (orgToken ? createClient({ token: orgToken, apiUrl, sleep: io.sleep }) : github);

    let decided;
    try {
      decided = await decide({
        github, orgGithub, repo, number, commentId, opts, dir: path.resolve(opts.dir), current: currentOf(io), publishedRemote: io.publishedRemote,
      });
    } catch (e) {
      if (!(e instanceof Refusal)) throw e;
      out.write(`::error title=Prepare again::${escapeData(e.message)}\n`);
      err.write(`shipyard prepare-again: refused: ${e.message}\n`);
      try {
        await github.createIssueComment(repo, number, refusedReply(e.message));
      } catch (posting) {
        if (!(posting instanceof GitHubError)) throw posting;
        throw new GitHubError(`the request is refused, and the reply saying so could not be posted on #${number}: ${posting.message}`, posting.status);
      }
      return 1;
    }

    if (decided.before) {
      say(`Prepare again: comment ${commentId} on #${number} was accepted before (prep job #${decided.before.job}): nothing is filed or posted again.`);
      return 0;
    }
    const found = decided.filed;
    const job = found ? { number: found } : await github.createIssue(repo, { ...decided.job, labels: [JOB_LABEL] });
    say(found
      ? `Prepare again: prep job #${job.number} for comment ${commentId} was filed before, and its reply was not posted: posting it now.`
      : `Prepare again: filed prep job #${job.number}, ${decided.job.title}, for comment ${commentId} on #${number}.`);
    try {
      await github.createIssueComment(repo, number, acceptedReply({ ...decided.marker, job: job.number }));
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      throw new GitHubError(`prep job #${job.number} is filed, but the reply on #${number} could not be posted: ${e.message}. Run the job again: it posts the reply and files no second job`, e.status);
    }
    say(`Prepare again: replied on #${number}. The cut applies the new prep to it when the job's prep run is done.`);
    return 0;
  } catch (e) {
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    out.write(`::error title=Prepare again::${escapeData(e.message)}\n`);
    err.write(`shipyard prepare-again: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required|must|takes no))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
