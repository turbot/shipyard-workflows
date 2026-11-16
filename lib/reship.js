'use strict';

// A re-ship: a version whose release PR merged into `main` (or `main-<x.y>`) but whose ship run on
// the merge failed, so it was never tagged. Re-running that run runs the ship job as it was at the
// merge, which can never pass when the ship job itself is broken, and `main` takes only release PRs.
// So the same version is finished by a second candidate: `shipyard start --reship <version>` files
// the job, `shipyard cut --reship <version>` makes `release/<version>` again from the base, the fix
// comes as a PR into it, and its merge runs the fixed ship job. The tag then tags the version at
// the re-ship's merge commit.
//
// The start, the cut and the tag share what is read here: the merged candidate that waits for its
// tag, the failed ship run on its merge commit, and the file the cut adds under `releases/<tag>/`
// (`reship-<run id>.json`), which names both. A new file each time, so a ship job that finds its
// version from the files a merge adds finds a re-ship too, and a second re-ship never edits the first.

const { Refusal, ReleaseError, lineOf } = require('./release-git');

const FORMAT = 1;
const FILE = /^reship-([1-9][0-9]{0,19})\.json$/;
const SHA = /^[0-9a-f]{40}$/;
// A run that ended in one of these failed; `cancelled` and `skipped` are not a failed ship.
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

const reshipPath = (tag, runId) => `releases/${tag}/reship-${runId}.json`;
const oneLine = (text, max = 120) => String(text ?? '').replace(/[\r\n\t]+/g, ' ').replace(/[`<>]/g, "'").trim().slice(0, max);

/**
 * The merged candidate of `version` that waits for its tag. Refuses when the version is tagged,
 * when a candidate for it is open, and when none has merged.
 *
 * @returns {{ tag, version, branch, pr, base, mergeCommit, mergedAt }}
 */
async function waitingRelease({ github, repo, tagPrefix, version, tagged }) {
  const tag = `${tagPrefix}${version}`;
  if (tagged) throw new Refusal(`${tag} is already tagged: it shipped, so there is nothing to re-ship`);
  const branch = `release/${version}`;
  const candidates = await github.listPullsByHead(repo, branch);
  const open = candidates.find((p) => p.state === 'open');
  if (open) throw new Refusal(`the candidate #${open.number} (${branch}) is open and has not merged: a re-ship finishes a version whose release PR merged`);
  const merged = candidates
    .filter((p) => p.merged_at && p.title === `Release ${tag}` && SHA.test(String(p.merge_commit_sha)) && p.base && lineOf(p.base.ref) !== null)
    .sort((a, b) => Date.parse(b.merged_at) - Date.parse(a.merged_at));
  if (!merged.length) throw new Refusal(`no release PR for ${tag} (${branch}) has merged into main or main-<x.y>: a re-ship finishes a version whose release PR merged`);
  const pr = merged[0];
  return {
    tag, version, branch, pr: pr.number, base: pr.base.ref, mergeCommit: pr.merge_commit_sha, mergedAt: pr.merged_at,
  };
}

// The newest failed run among `runs` ({ id, url, status, conclusion }), or a refusal saying why there
// is none: a run still going, or no run that failed.
// While any run on the merge still runs, nothing is decided: the ship run may be that one, and may
// yet pass (or be run again) and tag.
function pickFailed(runs, { sha, pr }) {
  if (runs.some((r) => r.status !== 'completed')) {
    throw new Refusal(`a run on ${sha.slice(0, 7)}, the merge of #${pr}, is still running: wait for every run to end`);
  }
  const failed = runs.filter((r) => FAILED.has(r.conclusion)).sort((a, b) => b.id - a.id);
  if (failed.length) return failed[0];
  throw new Refusal(`no run on ${sha.slice(0, 7)}, the merge of #${pr}, failed: a re-ship is for a ship run that failed (run it again for a failure outside the repo)`);
}

/**
 * The failed ship run on a merge commit, from its workflow runs (the cut's job holds `actions: read`):
 * the newest run of a push to the base that failed, and where it failed, from its jobs.
 *
 * @returns {{ id: number, url: string, failedAt: string }}
 */
async function failedRunFromWorkflows({ github, repo, release }) {
  const runs = (await github.listWorkflowRuns(repo, release.mergeCommit))
    .filter((r) => r && r.event === 'push' && r.head_branch === release.base && Number.isSafeInteger(r.id) && r.id > 0)
    .map((r) => ({ id: r.id, url: String(r.html_url || ''), status: r.status, conclusion: r.conclusion, name: r.name }));
  const run = pickFailed(runs, { sha: release.mergeCommit, pr: release.pr });
  const jobs = await github.listRunJobs(repo, run.id);
  const job = jobs.find((j) => j && FAILED.has(j.conclusion));
  const step = job && Array.isArray(job.steps) ? job.steps.find((s) => s && FAILED.has(s.conclusion)) : null;
  const failedAt = job ? `${oneLine(job.name, 80)}${step ? ` / ${oneLine(step.name, 80)}` : ''}` : oneLine(run.name || 'the run', 80);
  return { id: run.id, url: runUrl(repo, run.id), failedAt };
}

/**
 * The failed ship run on a merge commit, from its check runs (the start's job holds `checks: read`):
 * each job of an Actions run is a check run whose link names its run.
 *
 * @returns {{ id: number, url: string, failedAt: string }}
 */
async function failedRunFromChecks({ github, repo, release }) {
  const byRun = new Map();
  for (const c of await github.listCheckRuns(repo, release.mergeCommit)) {
    const m = /\/actions\/runs\/([1-9][0-9]{0,19})\/job\//.exec(String(c && (c.details_url || c.html_url)));
    if (!m) continue;
    const id = Number(m[1]);
    const run = byRun.get(id) || { id, status: 'completed', conclusion: 'success', jobs: [] };
    if (c.status !== 'completed') run.status = c.status;
    if (c.status === 'completed' && FAILED.has(c.conclusion)) {
      run.conclusion = 'failure';
      run.jobs.push(oneLine(c.name, 80));
    }
    byRun.set(id, run);
  }
  const run = pickFailed([...byRun.values()], { sha: release.mergeCommit, pr: release.pr });
  return { id: run.id, url: runUrl(repo, run.id), failedAt: run.jobs.join(', ') || 'a job' };
}

const runUrl = (repo, id) => `https://github.com/${repo}/actions/runs/${id}`;

// The re-ship file's text: what is re-shipped, and why.
function reshipFile({ release, run, cutFrom }) {
  return `${JSON.stringify({
    format: FORMAT,
    tag: release.tag,
    version: release.version,
    releasePr: release.pr,
    mergeCommit: release.mergeCommit,
    mergedAt: release.mergedAt,
    failedRun: { id: run.id, url: run.url, failedAt: run.failedAt },
    cutFrom,
  }, null, 2)}\n`;
}

// A re-ship file read back, checked field by field, or a ReleaseError naming the file.
function parseReshipFile(text, { tag, name }) {
  let d;
  try {
    d = JSON.parse(text);
  } catch {
    throw new ReleaseError(`releases/${tag}/${name} is not valid JSON`);
  }
  const m = FILE.exec(name);
  if (!d || d.format !== FORMAT || d.tag !== tag || !Number.isSafeInteger(d.releasePr) || d.releasePr < 1
    || !SHA.test(String(d.mergeCommit)) || !d.failedRun || !m || String(d.failedRun.id) !== m[1]) {
    throw new ReleaseError(`releases/${tag}/${name} is not a re-ship file \`shipyard cut --reship\` wrote`);
  }
  return {
    releasePr: d.releasePr, mergeCommit: d.mergeCommit, mergedAt: String(d.mergedAt || ''), failedRun: { id: Number(m[1]), failedAt: oneLine(d.failedRun.failedAt) },
  };
}

module.exports = {
  FILE, FAILED, reshipPath, waitingRelease, pickFailed, failedRunFromWorkflows, failedRunFromChecks, reshipFile, parseReshipFile, runUrl, oneLine,
};
