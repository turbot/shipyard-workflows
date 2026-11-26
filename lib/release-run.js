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
//     at a later commit of that branch when nothing that runs changed since: the cut commit's parent is
//     an ancestor of the run's commit and the two hold the same `.github/workflows` files (the branch
//     moved between the dispatch and the run; the run still built the commit it was given), or
//     on the release branch itself at a commit the candidate holds from the cut commit on (a release
//     run started by the release PR). A run on any other branch, a writer's own, cannot supply them;
//   - its `results` artifact is there and has not expired, and was downloaded;
//   - the results' build source is the commit the run ran on: the cut commit's parent (also for a run
//     at a later commit of the working branch), or the release branch's commit.
//
// A release prepared again (`/prepare-again`, lib/prepare-again-cut.js) has one more `chore(release): <tag>` commit for each
// request it applied, and no run built it: the record of its new head reads the release run the old page named. So a run on the
// release branch also counts from the oldest `chore(release): <tag>` commit, when every newer one carries `Release-Prepared-Again`
// and changes only this version's CHANGELOG section, as the release check's rule 3 lets that section change after the build.
// Every other run is judged from the newest cut commit, as before.
//
// Anything else is a reason the record shows as HOLD, naming the one that failed.

const fs = require('node:fs');
const { GitHubError } = require('./github');
const { ReleaseError, git, isAncestor } = require('./release-git');
const { readResults } = require('./record');
const { trailerValues, CUT_LIMIT } = require('./release-data');
const { workflowFilesDiffering, listFiles } = require('./pushable');
const { TRAILER: PREPARED_AGAIN } = require('./prepare-again');

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

// True when `commit` changes no file but `changelog`, and that file only in `version`'s section.
function changesOnlySection(dir, commit, changelog, version) {
  // Read when called: lib/release-check.js loads lib/record-command.js, which loads this file.
  const { withoutSection } = require('./release-check');
  const parent = parentOf(dir, commit);
  if (!parent) return false;
  const files = (git(dir, ['diff', '--name-only', '--no-renames', '-z', parent, commit], { allowFail: true }) || '').split('\0').filter(Boolean);
  if (files.some((f) => f !== changelog)) return false;
  const at = (sha) => git(dir, ['show', `${sha}:${changelog}`], { allowFail: true });
  const before = at(parent);
  const after = at(commit);
  return before !== null && after !== null && withoutSection(before, version) === withoutSection(after, version);
}

/**
 * The oldest `chore(release): <tag>` commit of a release prepared again: from the newest cut commit `cut` down the first-parent
 * line, at most `limit` commits, each cut commit that carries `Release-Prepared-Again` and changes only `version`'s section of
 * `changelog`, down to the first one that carries none, which is returned. Null when `cut` carries none (a release not prepared
 * again), when one of them changes anything else, or when no older cut commit is found.
 */
function preparedAgainBase({
  dir, cut, changelog, version, limit = CUT_LIMIT,
}) {
  if (!changelog || !version || !cut || !SHA.test(String(cut.sha))) return null;
  const subject = String(cut.message || '').split('\n')[0].trim();
  if (!/^chore\(release\): \S+$/.test(subject)) return null;
  let sha = cut.sha;
  let message = String(cut.message);
  let applied = 0;
  for (let n = 0; sha && n < limit; n += 1) {
    if (String(message).split('\n')[0].trim() === subject) {
      if (!trailerValues(message, PREPARED_AGAIN).length) return applied ? sha : null;
      if (!changesOnlySection(dir, sha, changelog, version)) return null;
      applied += 1;
    }
    sha = parentOf(dir, sha);
    message = sha ? git(dir, ['log', '-1', '--format=%B', sha], { allowFail: true }) || '' : '';
  }
  return null;
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
 * @param {string} [a.changelog]    the product's changelog, and
 * @param {string} [a.version]      this release's version: with both, a run on the release branch from the oldest cut commit of a
 *                                  release prepared again counts too (see the top of this file)
 */
async function readReleaseRun({
  github, repo, runId, dir, cut, releaseBranch, head, resultsFile, changelog = null, version = null,
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
    const on = short(working, 80);
    const cutFrom = cutParent ? sha7(cutParent) : 'the commit';
    // Another run would cut a new version, so the reasons here say what to check, not to run the workflow again.
    const notThisCut = (why) => ({ missing: `${why}: a new release run would cut a new version, so check that the run was started on ${on} and that nothing under .github/workflows changed between ${cutFrom} and the run's commit` });
    if (!cutParent) {
      return notThisCut(`${name} ran on ${on} at ${sha7(ranAt)}, and the cut commit ${sha7(cut.sha)} has no parent it was cut from`);
    }
    if (ranAt !== cutParent) {
      // The branch moved on between the dispatch and the run: the run is this release's when nothing that runs changed.
      // A commit from the cut commit on is the release branch's (or a merge back's), never one the run could have built.
      if (!SHA.test(ranAt) || !isAncestor(dir, cutParent, ranAt) || isAncestor(dir, cut.sha, ranAt)) {
        return notThisCut(`${name} ran on ${on} at ${sha7(ranAt)}, not at ${sha7(cutParent)} the cut commit ${sha7(cut.sha)} was cut from, and not at a later commit of ${on} that holds ${sha7(cutParent)}`);
      }
      const differing = workflowFilesDiffering(dir, cutParent, ranAt);
      if (differing === null) {
        return notThisCut(`${name} ran on ${on} at ${sha7(ranAt)}, and the checkout cannot compare its workflow files with those at ${sha7(cutParent)}, the commit the cut commit ${sha7(cut.sha)} was cut from`);
      }
      if (differing.length) {
        return notThisCut(`${name} ran on ${on} at ${sha7(ranAt)}, not at ${sha7(cutParent)} the cut commit ${sha7(cut.sha)} was cut from, and ${listFiles(differing)} differ${differing.length === 1 ? 's' : ''} between the two`);
      }
    }
    source = cutParent;
  } else if (ranOn === releaseBranch) {
    const within = (from) => SHA.test(ranAt) && isAncestor(dir, from, ranAt) && isAncestor(dir, ranAt, head);
    // A release prepared again: a run from its oldest cut commit on built what every newer cut commit left alone.
    let counts = within(cut.sha);
    if (!counts && SHA.test(ranAt)) {
      const base = preparedAgainBase({
        dir, cut, changelog, version,
      });
      counts = Boolean(base) && within(base);
    }
    if (!counts) {
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
    const built = `the results of ${name} are of a build made from ${sha7(results.build.source)}, not from ${sha7(source)}`;
    if (source === cutParent) {
      const cutFrom = `which the cut commit ${sha7(cut.sha)} was cut from`;
      if (ranAt === source) return missing(`${built}, the commit it ran on, ${cutFrom}`);
      return { missing: `${built}, ${cutFrom} (the run was at ${sha7(ranAt)}): a new release run would cut a new version, so check which commit the run was given` };
    }
    return missing(`${built}, the commit it ran on`);
  }
  return { results };
}

module.exports = { readReleaseRun, preparedAgainBase, ARTIFACT };
