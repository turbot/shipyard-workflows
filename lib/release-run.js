'use strict';

// The release run a review reads its results from. The record commits nothing, so a review (a person's
// approval, which must not be dismissed by a push) has no evidence of its own to read: it reads the
// `results` artifact of the release run the record already on the PR's page names
// (`<!-- shipyard:release-run <id> -->`, lib/record.js), and uses it only when that run is this
// release's. A page names its run, but anyone with write access can edit a body, so the run is checked
// against what the approved cut commit names, never taken on the page's word:
//
//   - the run is a run of this repo, not of a fork, and completed with success;
//   - it ran on the working branch the cut commit's `Release-From` trailer names, at the cut commit's
//     parent (a release run started on the working branch, which cut the release from where it ran), or
//     on the release branch itself at a commit the candidate holds from the cut commit on (a release
//     run started by the release PR). A run on any other branch, a writer's own, cannot supply them;
//   - its `results` artifact is there and has not expired, and was downloaded;
//   - the results' build source is the commit the run ran on: the cut commit's parent, or the release
//     branch's commit.
//
// Anything else is a reason the record shows as HOLD, naming the one that failed.

const fs = require('node:fs');
const { GitHubError } = require('./github');
const { ReleaseError, git, isAncestor } = require('./release-git');
const { readResults } = require('./record');
const { trailerValues } = require('./release-data');

const ARTIFACT = 'results';
const SHA = /^[0-9a-f]{40}$/;
const sha7 = (sha) => String(sha || '').slice(0, 7);
const lower = (s) => String(s || '').toLowerCase();
// A value from GitHub or a file, on one line and cut short: the record cleans the whole reason where it shows it.
const short = (s, n) => String(s).replace(/\s+/g, ' ').trim().slice(0, n);

// The cut commit's parent, or null for a cut with none.
function parentOf(dir, commit) {
  const out = git(dir, ['rev-parse', '--verify', '--quiet', `${commit}^1`], { allowFail: true });
  return out && SHA.test(out.trim()) ? out.trim() : null;
}

/**
 * The results of release run `runId`, read from the downloaded `resultsFile`, when the run is this
 * release's (see the top of this file): `{ results }`, or `{ missing }` with the reason the record shows. A read that failed
 * for a reason that passes (an API error, a download) returns `{ missing, unreadable: true }`: the record keeps the run named.
 *
 * @param {object} a
 * @param {object} a.github         the GitHub client (getWorkflowRun, listRunArtifacts)
 * @param {string} a.repo           `<owner>/<name>`
 * @param {string} a.runId          the run the page names
 * @param {string} a.dir            the checkout of the candidate
 * @param {{ sha: string, message: string }} a.cut  the cut commit the release data was checked against
 * @param {string} a.releaseBranch  the release PR's branch (`release/X.Y.Z`)
 * @param {string} a.head           the PR's head, which the checkout is at
 * @param {string} a.resultsFile    where the shell downloaded the artifact's results.json
 */
async function readReleaseRun({
  github, repo, runId, dir, cut, releaseBranch, head, resultsFile,
}) {
  const name = `release run ${runId}`;
  const missing = (why) => ({ missing: `${why}: run the release workflow again` });
  // A read that failed for a reason that passes (a download, an API error) has not judged the run: the page keeps its
  // name, so a later review reads the same run again, and the reason says to run the review again, not the workflow.
  const unreadable = (why) => ({ missing: `${why}: run the release review again`, unreadable: true });
  let run;
  try {
    run = await github.getWorkflowRun(repo, runId);
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    return unreadable(`could not read the results of ${name}, which the record names: ${short(e.message, 120)}`);
  }
  if (!run) return missing(`${name}, which the record names, is not a run of ${repo}`);
  const of = (x) => lower(x && x.full_name);
  if (of(run.repository) !== lower(repo) || (run.head_repository && of(run.head_repository) !== lower(repo))) {
    return missing(`${name} is not a run of ${repo}'s own branches`);
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    return missing(`${name} ${run.status === 'completed' ? `ended ${short(run.conclusion || 'with no result', 40)}` : `is ${short(run.status || 'not finished', 40)}`}, not a run that completed with success`);
  }
  const ranOn = String(run.head_branch || '');
  const ranAt = String(run.head_sha || '');
  const working = trailerValues(cut.message, 'Release-From')[0] || null;
  const cutParent = parentOf(dir, cut.sha);
  let source;
  if (working && ranOn === working) {
    if (!cutParent || ranAt !== cutParent) {
      return missing(`${name} ran on ${short(working, 80)} at ${sha7(ranAt)}, not at ${cutParent ? sha7(cutParent) : 'the commit'} the cut commit ${sha7(cut.sha)} was cut from`);
    }
    source = cutParent;
  } else if (ranOn === releaseBranch) {
    if (!SHA.test(ranAt) || !isAncestor(dir, cut.sha, ranAt) || !isAncestor(dir, ranAt, head)) {
      return missing(`${name} ran on ${short(releaseBranch, 80)} at ${sha7(ranAt)}, which is not a commit of this candidate from its cut commit ${sha7(cut.sha)} on`);
    }
    source = ranAt;
  } else {
    return missing(`${name} ran on ${ranOn ? short(ranOn, 80) : 'no branch'}, not on ${working ? `the working branch ${short(working, 80)}, which the cut commit names, or ` : ''}the release branch ${short(releaseBranch, 80)}`);
  }
  let artifacts;
  try {
    artifacts = await github.listRunArtifacts(repo, runId);
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    return unreadable(`could not read the artifacts of ${name}: ${short(e.message, 120)}`);
  }
  const found = artifacts.filter((a) => a && a.name === ARTIFACT);
  if (!found.length) return missing(`${name} has no \`${ARTIFACT}\` artifact`);
  if (found.every((a) => a.expired === true)) return missing(`the \`${ARTIFACT}\` artifact of ${name} has expired`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
  } catch {
    return unreadable(`the \`${ARTIFACT}\` artifact of ${name} could not be downloaded, or holds no readable results.json`);
  }
  let results;
  try {
    results = readResults(raw);
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    return missing(`the results of ${name} cannot be used: ${short(e.message, 160)}`);
  }
  if (results.build.source !== source) {
    return missing(`the results of ${name} are of a build made from ${sha7(results.build.source)}, not from ${sha7(source)}, the commit it ran on${source === cutParent ? `, which the cut commit ${sha7(cut.sha)} was cut from` : ''}`);
  }
  return { results };
}

module.exports = { readReleaseRun, ARTIFACT };
