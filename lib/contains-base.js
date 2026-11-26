'use strict';

// Whether a commit to release contains the newest commit of the branch the release PR merges into (`main`, or the `--base` a
// repo's cut passes, `main-<x.y>`). The release check's
// `contains-base` rule (lib/release-check.js) fails a release PR whose candidate lacks it, but it runs only after the cut has pushed
// `release/<version>` and opened the PR, which then can never pass: a failed merge-back, a fix made by hand on `main`, or a `main`
// set up by hand before a first release leaves `main` ahead of the work branch. `shipyard facts`, the first step of both paths
// to a cut, asks here and stops before anything is cut. The release check's rule is unchanged.

const { git, resolveCommit, isAncestor } = require('./release-git');
const { clean } = require('./clean');

const RELEASE_BRANCH = 'main';

// The tip of a release branch in the checkout, read as the release check reads it: `origin/<branch>`, else a local one. Null when
// the checkout has neither (a repo with no `main` yet has no newest commit to contain).
function releaseBranchTip(dir, branch = RELEASE_BRANCH) {
  const ref = ['refs/remotes/origin/', 'refs/heads/'].find((p) => git(dir, ['rev-parse', '--verify', '--quiet', `${p}${branch}^{commit}`], { allowFail: true }));
  return ref ? resolveCommit(dir, `${ref}${branch}`) : null;
}

// The text of a refusal when `commit`'s history lacks the tip of `branch`, or null when it holds it (or the branch has no tip in
// the checkout). `workBranch` is the branch the release is cut from, which `branch` is to be merged into; `nothing` is the
// sentence that says what was left unwritten.
function containsBaseMessage(dir, commit, { branch = RELEASE_BRANCH, workBranch = null, nothing = 'Nothing was written.' } = {}) {
  const tip = releaseBranchTip(dir, branch);
  if (tip === null || isAncestor(dir, tip, commit)) return null;
  const subject = clean((git(dir, ['log', '-1', '--format=%s', tip], { allowFail: true }) || '').split('\n')[0], 80);
  const into = workBranch || 'the working branch';
  return `${commit.slice(0, 7)} does not contain ${tip.slice(0, 7)}${subject ? ` (${subject})` : ''}, the newest commit of ${branch}, so the release PR into ${branch} could never pass the release check's \`contains-base\` rule. ${nothing} Merge ${branch} into ${into} with a merge commit (a person's step, or the merge-back's), then start a new prep job.`;
}

module.exports = { RELEASE_BRANCH, releaseBranchTip, containsBaseMessage };
