'use strict';

// A prerelease's build runs on the work branch, never under `main` (docs/release-prerelease.md). The run on `main`, which holds the
// release key, runs none of the commit's code: its `build` step starts the repo's build workflow on the work branch and waits for it,
// and its `publish` step takes that run's files by the run's id, as the cut takes the prep file by `prep-run`.
//
//   startBuild    dispatches the build workflow on the branch, finds the run it started and waits for it to end. The commit is
//                 the branch's tip: a run on a branch is at its tip, and GitHub names that commit as the run's `head_sha`, which
//                 the publish step reads back. The run is the one that uploaded the artifact named for this prerelease's tag
//                 (`<assets>-<tag>`), so a run someone started for another tag is never taken for it. Returns the run's id.
//   checkBuildRun refuses a run that is not that commit's build: not a run of this repo, not finished with success, not a
//                 dispatch, not on the branch, not at the commit, not of the build workflow, or with no unexpired artifact.
//
// GitHub is the only thing read: no checkout, and nothing of the commit is run.

const { GitHubError } = require('./github');
const { ReleaseError, Refusal } = require('./release-git');
const { ACTIONS } = require('./route');

const SHA = /^[0-9a-f]{40}$/;
// How long the build may take (its own job's limit is an hour), and how long GitHub may take to show the run it was asked for.
const WAIT_MS = 75 * 60 * 1000;
const DISCOVER_MS = 10 * 60 * 1000;
const POLL_MS = 15 * 1000;
// How long a run that ended with no artifact of the name may stand alone before the step calls the build failed: a run someone else
// started at the same commit may end first, and the run this step started may not be listed yet.
const SETTLE_MS = 90 * 1000;

const lower = (s) => String(s || '').toLowerCase();
// The artifact a prerelease's build uploads: the caller's name for it and the tag it is for, so the files carry the tag whose version
// they were built with, and a build made for another tag is never taken for this one.
const buildArtifact = (assets, tag) => `${assets}-${tag}`;
const short = (sha) => String(sha || '').slice(0, 7);
const show = (value, max = 80) => {
  const text = JSON.stringify(String(value));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
// A run's workflow file, `.github/workflows/<file>`; on a branch other than the default GitHub may add `@<ref>`.
const workflowPath = (run) => String((run && run.path) || '').replace(/@.*$/, '');
const sleepFor = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

/**
 * The inputs the build workflow is started with. A repo's own build workflow takes the tag. The release file every repo has
 * (`shipyard-release.yml`) takes an `action` and one JSON `args`.
 */
function buildInputs({ action, tag }) {
  if (action && !Object.hasOwn(ACTIONS, action)) throw new ReleaseError(`${show(action, 40)} is not an action of the release file (${Object.keys(ACTIONS).join(', ')})`);
  return action ? { action, args: JSON.stringify({ tag }) } : { tag };
}

const sameRepo = (run, repo) => {
  const of = (x) => lower(x && x.full_name);
  return of(run.repository) === lower(repo) && (!run.head_repository || of(run.head_repository) === lower(repo));
};

// A sentence for an error when the branch is no longer at the commit: the run GitHub made is at the branch's tip, so it is at another commit.
async function movedOn(github, repo, branch, commit) {
  const tip = await github.branchTip(repo, branch);
  return tip && tip !== commit ? ` ${branch} has moved on to ${short(tip)}, so a run of it is at that commit, not ${short(commit)}: start the prerelease again at its tip.` : '';
}

// How each run stands, for an error: none of them is known to be this build's, so none is named as the build.
const describeRuns = (runs) => runs.map((r) => {
  if (r.status !== 'completed') return `run ${r.id} is ${show(r.status || 'not finished', 30)}`;
  return `run ${r.id} ${r.conclusion === 'success' ? 'ended with success and uploaded no unexpired artifact of that name' : `ended ${show(r.conclusion || 'with no result', 30)}`}`;
}).join('; ');

async function hasArtifact(github, repo, runId, artifact) {
  const found = (await github.listRunArtifacts(repo, runId)).filter((a) => a && a.name === artifact);
  return found.some((a) => a.expired !== true);
}

/**
 * Starts the build workflow on `branch` and waits for the run it started: `{ runId }`. Throws a Refusal when the branch's tip is
 * not `commit` (the build is of the tip, so no other commit can be built), and a ReleaseError when the run does not start, does
 * not end with success in time, or ends with no artifact.
 *
 * The run is found by what GitHub shows at the commit: a dispatch of the workflow on the branch that was not there before this
 * call dispatched, which uploaded `artifact`, the name made for this tag (`buildArtifact`). A run someone else started at the same
 * commit for another tag uploads another name, so it is never taken. Two runs for the same tag at the same commit are the same
 * build; the oldest is taken.
 */
async function startBuild({
  github, repo, workflow, action = '', branch, commit, tag, artifact, say = () => {}, sleep = sleepFor, now = Date.now,
  waitMs = WAIT_MS, discoverMs = DISCOVER_MS, pollMs = POLL_MS, settleMs = SETTLE_MS,
}) {
  if (!SHA.test(String(commit))) throw new ReleaseError(`--commit must be a full 40-character commit id, not ${show(commit, 50)}`);
  const tip = await github.branchTip(repo, branch);
  if (!tip) throw new Refusal(`${branch} is not a branch of ${repo}`);
  if (tip !== commit) {
    throw new Refusal(`${short(commit)} is not the tip of ${branch}, which is at ${short(tip)}: a prerelease's build runs on the work branch, at its tip, so it is made of the tip. Start the prerelease at ${short(tip)}, or when ${branch} has moved on, again once it is at the commit you mean. Nothing was built`);
  }
  const file = `.github/workflows/${workflow}`;
  const mine = (run) => run && run.event === 'workflow_dispatch' && run.head_branch === branch && run.head_sha === commit && workflowPath(run) === file;
  const before = new Set((await github.listWorkflowRuns(repo, commit)).map((r) => r.id));
  const inputs = buildInputs({ action, tag });
  try {
    await github.dispatchWorkflow(repo, workflow, branch, inputs);
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    throw new ReleaseError(`could not start ${workflow} on ${branch}: ${e.message}. The build workflow must be on ${branch}, take workflow_dispatch and accept the inputs ${Object.keys(inputs).join(' and ')} (docs/release-prerelease.md). Nothing was built`);
  }
  say(`Started ${workflow} on ${branch} at ${short(commit)}, for ${tag}: waiting for its run, which uploads ${show(artifact, 100)}.`);

  const began = now();
  let seen = '';
  let changed = began;
  for (;;) {
    const runs = (await github.listWorkflowRuns(repo, commit)).filter((r) => !before.has(r.id) && mine(r) && sameRepo(r, repo)).sort((a, b) => a.id - b.id);
    // What GitHub shows of them now; a change starts the settle clock again.
    const state = runs.map((r) => `${r.id}:${r.status}:${r.conclusion}`).join(',');
    if (state !== seen) {
      seen = state;
      changed = now();
    }
    const done = runs.filter((r) => r.status === 'completed');
    for (const run of done) {
      if (run.conclusion === 'success' && await hasArtifact(github, repo, run.id, artifact)) {
        say(`The build is run ${run.id} of ${workflow} on ${branch}.`);
        return { runId: String(run.id) };
      }
    }
    const waited = now() - began;
    if (runs.length && done.length === runs.length && now() - changed >= settleMs) {
      // None of them is known to be this build's, so say how each one ended, and never name one as the failed build.
      const ended = describeRuns(runs);
      throw new ReleaseError(`no run of ${workflow} on ${branch} at ${short(commit)} uploaded ${show(artifact, 100)} (the build uploads its files under that name: the artifact name, a dash and the tag it was started with): ${ended}.${await movedOn(github, repo, branch, commit)} Nothing is published and no number is taken. Fix the build and start the prerelease again`);
    }
    if (!runs.length && waited > discoverMs) {
      throw new ReleaseError(`${workflow} was started on ${branch} and no run of it at ${short(commit)} showed up in ${Math.round(discoverMs / 60000)} minutes: is it a workflow_dispatch workflow of the branch?${await movedOn(github, repo, branch, commit)} Nothing was built`);
    }
    if (waited > waitMs) {
      throw new ReleaseError(`no run of ${workflow} on ${branch} at ${short(commit)} uploaded ${show(artifact, 100)} in ${Math.round(waitMs / 60000)} minutes: ${runs.length ? describeRuns(runs) : 'none was listed'}.${await movedOn(github, repo, branch, commit)} Run the job again, or start the prerelease again`);
    }
    await sleep(pollMs);
  }
}

/**
 * Checks that run `runId` is the build of `commit` on `branch`, made by `workflow`, with the artifact `artifact`: a Refusal naming what
 * is not; nothing when it is. The run is read from GitHub, never taken on a caller's word. A run on a branch is at its tip, so
 * the run's `head_sha` is the commit it built: the workflow checks out its own commit and no other.
 */
async function checkBuildRun({
  github, repo, runId, commit, branch, workflow, artifact,
}) {
  const name = `run ${runId}`;
  if (!/^[1-9][0-9]{0,15}$/.test(String(runId))) throw new ReleaseError(`--build-run ${show(runId, 40)} is not a run id: it is the number of a run`);
  const run = await github.getWorkflowRun(repo, runId);
  if (!run) throw new Refusal(`${name}, which the build is, is not a run of ${repo}. Nothing was made`);
  if (!sameRepo(run, repo)) throw new Refusal(`${name} is not a run of ${repo}'s own branches: a fork's run is never a build to publish. Nothing was made`);
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    throw new Refusal(`${name} ${run.status === 'completed' ? `ended ${show(run.conclusion || 'with no result', 30)}` : `is ${show(run.status || 'not finished', 30)}`}, not a build that completed with success. Nothing was made`);
  }
  if (run.event !== 'workflow_dispatch') throw new Refusal(`${name} is a ${show(run.event || 'no', 30)} run: a prerelease's build is a workflow_dispatch of ${workflow} on ${branch}. Nothing was made`);
  if (run.head_branch !== branch) throw new Refusal(`${name} ran on ${show(run.head_branch || 'no branch', 60)}, not on ${branch}, the work branch the prerelease is of. Nothing was made`);
  if (run.head_sha !== commit) throw new Refusal(`${name} built ${short(run.head_sha)}, not ${short(commit)}, the commit to publish: the build must be of that commit. Nothing was made`);
  if (workflowPath(run) !== `.github/workflows/${workflow}`) {
    throw new Refusal(`${name} is a run of ${show(workflowPath(run) || 'no workflow', 80)}, not of .github/workflows/${workflow}, the build workflow. Nothing was made`);
  }
  let found;
  try {
    found = await hasArtifact(github, repo, runId, artifact);
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    throw new GitHubError(`could not read the artifacts of ${name}: ${e.message}`, e.status);
  }
  if (!found) throw new Refusal(`${name} has no unexpired artifact ${show(artifact, 60)}: the build uploads its files under that name. Nothing was made`);
}

module.exports = {
  startBuild, checkBuildRun, buildInputs, buildArtifact, WAIT_MS, DISCOVER_MS, POLL_MS, SETTLE_MS,
};
