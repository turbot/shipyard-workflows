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

// True when `commit` has no workflow files, or some branch or tag tip holds the same ones.
function cutCanPush(dir, commit) {
  const want = workflowKey(dir, commit);
  if (want === '') return true;
  if (want === null) return false;
  return tipCommits(dir).some((tip) => workflowKey(dir, tip) === want);
}

module.exports = { cutCanPush };
