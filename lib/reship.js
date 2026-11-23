'use strict';

// A re-ship: a version whose release PR merged into `main` (or `main-<x.y>`) but whose ship run on
// the merge failed, so it was never tagged. Re-running that run runs the ship job as it was at the
// merge, which can never pass when the ship job itself is broken, and `main` takes only release PRs.
// So the same version is finished by a second candidate: `shipyard start --reship <version>` files
// the job, `shipyard cut --reship <version>` makes `release/<version>` again from the base, the fix
// comes with the cut (its `--fixes`: commits of the working branch, cherry-picked on) or as a PR into
// it, and the merge runs the fixed ship job. The tag then tags the version at
// the re-ship's merge commit.
//
// The start, the cut and the tag share what is read here: the merged candidate that waits for its
// tag, the failed ship run on its merge commit, and the entry the cut adds to the `reships` list of
// the release data (lib/release-data.js) the new release PR's body carries, which names both. The
// re-ship commit changes no file; the list holds every re-ship of the version, oldest first. A
// version re-shipped before the release data moved to the body has a file under `releases/<tag>/`
// (`reship-<run id>.json`) for each, read back by the parser here.

const { Refusal, ReleaseError, lineOf, git, isPickOf } = require('./release-git');
const { changelogOf } = require('./changelog-line');
const { reviewOf } = require('./facts');

const FORMAT = 1;
const FILE = /^reship-([1-9][0-9]{0,19})\.json$/;
const SHA = /^[0-9a-f]{40}$/;
// A run that ended in one of these failed; `cancelled` and `skipped` are not a failed ship.
const FAILED = new Set(['failure', 'timed_out', 'startup_failure']);

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

// A re-ship's entry in the release data's `reships` list: what is re-shipped, and why. The fields a
// `reship-<run>.json` file held, less `format`, `tag` and `version`, which the payload carries itself.
function reshipFile({ release, run, cutFrom, fixes = [] }) {
  return {
    releasePr: release.pr,
    mergeCommit: release.mergeCommit,
    mergedAt: release.mergedAt,
    failedRun: { id: run.id, url: run.url, failedAt: run.failedAt },
    cutFrom,
    // The commits of the working branch the cut picked onto the branch, in order; the entry is read back
    // for the PR it names, and these are for a person reading what the re-ship carries.
    ...(fixes.length ? { fixes } : {}),
  };
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

// A re-ship file of a version re-shipped before the release data moved to the body, as an entry of the
// `reships` list, checked as `parseReshipFile` checks it: a re-ship of that version carries it forward.
function reshipEntryOfFile(text, { tag, name }) {
  const checked = parseReshipFile(text, { tag, name });
  const d = JSON.parse(text);
  const fixes = Array.isArray(d.fixes) ? d.fixes : [];
  return {
    releasePr: checked.releasePr,
    mergeCommit: checked.mergeCommit,
    mergedAt: checked.mergedAt,
    failedRun: { id: checked.failedRun.id, url: String(d.failedRun.url || ''), failedAt: checked.failedRun.failedAt },
    cutFrom: String(d.cutFrom || ''),
    ...(fixes.length ? { fixes } : {}),
  };
}

// ---------------------------------------------------------------------------
// The fixes a re-ship carries: commits of the working branch, reviewed there, that the cut
// cherry-picks onto the release branch in place of a fix PR into it.

const FIX_SHA = /^[0-9a-f]{40}$/;

// `a b c` (spaces or newlines) as a list of full commit ids, each once; a ReleaseError for anything else.
function parseFixes(text) {
  const list = String(text ?? '').split(/\s+/).filter(Boolean);
  for (const sha of list) {
    if (!FIX_SHA.test(sha)) throw new ReleaseError(`--fixes takes full 40-character commit ids, not ${JSON.stringify(sha.slice(0, 50))}`);
  }
  const dup = list.find((sha, i) => list.indexOf(sha) !== i);
  if (dup) throw new ReleaseError(`--fixes names ${dup} twice`);
  return list;
}

// The commit a cherry-pick says it came from (`git cherry-pick -x`), or null.
function cherryPickedFrom(message) {
  const found = [...String(message).matchAll(/^\(cherry picked from commit ([0-9a-f]{40})\)[ \t]*$/gm)];
  return found.length ? found[found.length - 1][1] : null;
}

// The commit `sha` was cherry-picked from, when its message says so and the original is in the
// checkout and `sha` is exactly the original's change on its own parent: a line in a message is a
// claim, the replay is the proof.
function cherryPickOrigin(dir, sha) {
  const origin = cherryPickedFrom(git(dir, ['log', '-1', '--format=%B', sha], { allowFail: true }) || '');
  if (!origin || git(dir, ['cat-file', '-e', `${origin}^{commit}`], { allowFail: true }) === null) return null;
  return isPickOf(dir, sha, origin) ? origin : null;
}

// The commits a release already shipped as picks, `Map<origin, pick>`: each commit whose verified cherry-pick (a patch's or a
// re-ship's fix, `git cherry-pick -x`) is in `from`'s history. The work branch still holds the originals after the
// merge-back, so the next release's facts and start leave them out: they shipped. The newest PICK_LOOKBACK picks are read.
const PICK_LOOKBACK = 500;
function pickedOrigins(dir, from) {
  const out = git(dir, ['log', '--format=%H', `--max-count=${PICK_LOOKBACK}`, '-E', '--grep=^\\(cherry picked from commit [0-9a-f]{40}\\)', from], { allowFail: true }) || '';
  const origins = new Map();
  for (const sha of out.split('\n').map((l) => l.trim()).filter(Boolean)) {
    const origin = cherryPickOrigin(dir, sha);
    if (origin && !origins.has(origin)) origins.set(origin, sha);
  }
  return origins;
}

// The scratch identity of the commits git needs to work out a pick: made in the checkout's own object store with no ref,
// never pushed.
const SCRATCH = {
  GIT_AUTHOR_NAME: 'shipyard', GIT_AUTHOR_EMAIL: '', GIT_COMMITTER_NAME: 'shipyard', GIT_COMMITTER_EMAIL: '',
};

// `to` with each of `shas` picked on in order, as `git cherry-pick -x` would (a merge commit as what it brought in over its
// first parent): the commit a patch ships, made as loose objects with no ref, so no branch of the checkout moves. A
// ReleaseError names the first fix that does not apply.
function pickedTip(dir, to, shas) {
  let ours = to;
  for (const sha of shas) {
    const out = git(dir, ['merge-tree', '--write-tree', `--merge-base=${sha}^1`, ours, sha], { allowFail: true });
    const tree = out && out.split('\n')[0].trim();
    if (!tree || !/^[0-9a-f]{40,64}$/.test(tree)) throw new ReleaseError(`the fix ${sha} does not apply on ${to.slice(0, 7)} with the fixes before it`);
    ours = git(dir, ['commit-tree', tree, '-p', ours, '-m', `pick ${sha}`], { env: SCRATCH }).trim();
  }
  return ours;
}

// What a review of a fix PR says, in a few words.
function reviewText(reviews) {
  const r = reviewOf(reviews);
  if (r.state === 'changes-requested') return `changes requested by ${r.changesRequestedBy.join(', ')}`;
  return r.state === 'approved' ? `approved by ${r.approvedBy.join(', ')}` : 'no approval';
}

/**
 * A fix PR as the re-ship's page lists it: `{ number, title, changelog, review }`, from the PR as
 * GitHub holds it and its reviews. `changelog` is its single valid `Changelog:` line, or null.
 */
async function describeFix({ github, repo, pull }) {
  const lines = changelogOf(pull).changelog;
  return {
    number: pull.number,
    title: pull.title,
    changelog: lines.length === 1 && lines[0].trim() ? lines[0].trim() : null,
    review: reviewText(await github.listPullReviews(repo, pull.number)),
  };
}

module.exports = {
  pickedOrigins, pickedTip, parseFixes, cherryPickedFrom, cherryPickOrigin, reviewText, describeFix,
  FILE, FAILED, waitingRelease, pickFailed, failedRunFromWorkflows, failedRunFromChecks, reshipFile, parseReshipFile, reshipEntryOfFile, runUrl, oneLine,
};
