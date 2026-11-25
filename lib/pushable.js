'use strict';

// Whether a commit is one the cut can push. The cut pushes `release/<version>` with the job's own
// token, which has no `workflows` permission, and GitHub refuses a new ref when the commit's
// `.github/workflows` files match no branch or tag tip: a ref may only carry workflow files some
// ref already holds. So a commit the start names must have its workflow files at the tip of some
// branch or tag.

const { git } = require('./release-git');

const WORKFLOWS = '.github/workflows';
const SHA = /^[0-9a-f]{40}$/;

// The workflow files of a commit as one comparable key: the id of its `.github/workflows` tree,
// '' when it has none (nothing to refuse), null when `sha` is not a commit this checkout holds.
function workflowKey(dir, sha) {
  const line = git(dir, ['ls-tree', sha, '--', WORKFLOWS], { allowFail: true });
  if (line === null) return null;
  return line.trim().split(/\s+/).slice(2, 3).join('') || '';
}

// The commits at the tips of the repo's branches and tags. Branches are the remote-tracking ones
// (`refs/remotes/origin`) when the checkout has any: a local branch may be a copy nobody pushed or
// one that has moved on, which GitHub does not count. The start's workflow checks out the whole
// history, every branch and every tag at the start of the run and keeps no credentials, so it cannot
// ask the remote (`git ls-remote`) for a fresher list: these refs are the ones the run fetched. A
// checkout with no remote-tracking branch (a test repo) uses its local branches.
function tipCommits(dir) {
  const list = (...refs) => git(dir, ['for-each-ref', '--format=%(objectname) %(*objectname) %(refname)', ...refs]).split('\n').filter(Boolean);
  const remote = list('refs/remotes/origin').filter((l) => !l.endsWith(' refs/remotes/origin/HEAD'));
  const shas = new Set();
  for (const l of [...(remote.length ? remote : list('refs/heads')), ...list('refs/tags')]) {
    const [sha, peeled] = l.split(' ');
    shas.add(SHA.test(peeled || '') ? peeled : sha);
  }
  return [...shas];
}

// What the cut can do with `commit`: `{ ok: true }` when it has no workflow files or some branch or tag tip holds the
// same ones. Otherwise `{ ok: false, files, tip }`: the workflow files that differ from the tip that is nearest (the
// fewest files differ; the first of them when two tie), and that tip's commit. `files` is empty and `tip` null when the
// checkout does not hold `commit` at all, or no branch or tag has a tip to compare with.
function pushability(dir, commit) {
  const want = workflowKey(dir, commit);
  if (want === '') return { ok: true };
  if (want === null) return { ok: false, files: [], tip: null };
  const seen = new Map();
  for (const tip of tipCommits(dir)) {
    const key = workflowKey(dir, tip);
    if (key === want) return { ok: true };
    if (key !== null && !seen.has(key)) seen.set(key, tip);
  }
  let best = null;
  for (const tip of seen.values()) {
    const out = git(dir, ['diff', '--name-only', '--no-renames', '-z', tip, commit, '--', WORKFLOWS], { allowFail: true });
    if (out === null) continue;
    const files = out.split('\0').filter(Boolean);
    if (!best || files.length < best.files.length) best = { ok: false, files, tip };
  }
  return best || { ok: false, files: [], tip: null };
}

// The workflow files that differ between two commits, as paths, sorted: empty when they hold the same ones. Null when
// the checkout does not hold one of them, so a caller never takes "cannot tell" for "the same".
function workflowFilesDiffering(dir, a, b) {
  const out = git(dir, ['diff', '--name-only', '--no-renames', '-z', a, b, '--', WORKFLOWS], { allowFail: true });
  return out === null ? null : out.split('\0').filter(Boolean).sort();
}

// True when the cut can push a ref at `commit`. The start, the prep run's facts and the cut all ask this one function.
function cutCanPush(dir, commit) {
  return pushability(dir, commit).ok;
}

// The files a refusal names: at most five, the rest counted, so a message stays a line.
function listFiles(files) {
  if (!files.length) return 'its workflow files';
  const shown = files.slice(0, 5).join(', ');
  return files.length > 5 ? `${shown} and ${files.length - 5} more` : shown;
}

// The text of a refusal for a commit the cut cannot push, or null when it can. `branch` is the working branch a new prep
// job starts at the tip of; `nothing` is the sentence that says what was left unwritten.
function unpushableMessage(dir, commit, { branch = null, nothing = 'Nothing was written.' } = {}) {
  const found = pushability(dir, commit);
  if (found.ok) return null;
  const short = commit.slice(0, 7);
  const tip = branch ? `the tip of ${branch}` : 'the working branch\'s tip';
  if (found.tip === null && !found.files.length) {
    return `${short} has workflow files no branch or tag of this checkout holds (or is not a commit it holds): fetch every branch and tag, or start a new prep job at ${tip}. ${nothing}`;
  }
  return `${short} has workflow files no branch or tag holds, which GitHub refuses a new ref to carry from the job's token: ${listFiles(found.files)} differ${found.files.length === 1 ? 's' : ''} from ${found.tip.slice(0, 7)}, the nearest branch or tag tip (a workflow changed after the prep job named this commit). ${nothing} Start a new prep job at ${tip}.`;
}

module.exports = { cutCanPush, pushability, unpushableMessage, workflowFilesDiffering, listFiles };
