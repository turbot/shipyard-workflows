'use strict';

// A site's docs preview (workflows/site-docs-preview.yml, `shipyard site-docs-preview`). A docs repo's push starts the
// site's preview workflow (docs-preview.yml), which calls this: it points the site's branch `docs/<prefix><ref_name>` at
// a new empty commit on the tip of the site's default branch. Vercel's Git integration then builds that branch as the
// preview. Vercel builds only a signed commit, so the commit names no author or committer: GitHub then makes it as the
// token's own identity (github-actions[bot] with the job's GITHUB_TOKEN) and signs it. A commit that names either is
// unsigned, and Vercel blocks its deployment.
//
// It writes one ref, under `refs/heads/docs/`, and one empty commit: the default branch is only read.

const { GitHubError } = require('./github');
const { ACCEPTED_REF, PreviewError, checkPrefix } = require('./docs-preview');

// The branches this step may write all start with this, and no other.
const BRANCH_ROOT = 'docs/';
const MAX_REF_LENGTH = 200;

class Refused extends Error {}

const NOT_GIT = 'the branch name is not one git accepts: no empty part, no part that starts with a dot or ends in .lock, no .. and no ending dot.';

// Whether git takes `name` as a branch name: a part that is empty, starts with a dot (`..` too) or ends in `.lock`, and a
// name that ends in a dot, are all refused by git, and `..` in a request's path would walk out of `refs/heads/docs/` besides.
const gitShaped = (name) => !name.split('/').some((s) => s === '' || s.startsWith('.') || s.endsWith('.lock')) && !name.includes('..') && !name.endsWith('.');

// A name the site builds nothing for, or that git would not take as part of a branch name.
function checkRef(ref) {
  if (typeof ref !== 'string' || ref === '' || !ACCEPTED_REF.test(ref)) {
    throw new Refused('the branch name has a character the site\'s build refuses. Use only letters, digits, . _ / and -.');
  }
  if (ref.length > MAX_REF_LENGTH) throw new Refused(`the branch name is longer than ${MAX_REF_LENGTH} characters.`);
  if (!gitShaped(ref)) throw new Refused(NOT_GIT);
  return ref;
}

// The site branch for a docs branch.
function previewBranchOf(prefix, ref) {
  const branch = `${BRANCH_ROOT}${prefix}${ref}`;
  // Whatever the checks above let through (a prefix of `../`), this step never names a ref outside docs/.
  if (!branch.startsWith(BRANCH_ROOT) || !gitShaped(branch)) throw new Refused(NOT_GIT);
  return branch;
}

const messageOf = (ref, runId) => [
  `Build the docs preview of ${ref}`,
  '',
  `An empty commit made by the docs preview workflow so that Vercel builds this branch.${runId ? ` Run ${runId}.` : ''}`,
].join('\n');

/**
 * Points `docs/<prefix><ref>` of `repo` at a new empty commit (the default branch's tree, the default branch's tip as its
 * parent, made and signed by GitHub as the token), creating the branch or moving it when it is there. Returns
 * `{ branch, base, commit, created }`. A name the site refuses (`Refused`) is thrown before anything is asked of GitHub.
 */
async function pointPreviewBranch({
  github, repo, prefix = '', ref, runId,
}) {
  checkPrefix(prefix);
  checkRef(ref);
  const branch = previewBranchOf(prefix, ref);
  const base = await github.defaultBranch(repo);
  if (!base) throw new PreviewError(`the token cannot see ${repo}`);
  const tip = await github.getRefSha(repo, `heads/${base}`);
  if (!tip) throw new PreviewError(`${repo} has no commit on its default branch ${base}`);
  const { tree } = await github.getCommit(repo, tip);
  // The commit is made before the ref moves: a failure here leaves every branch as it was.
  const commit = await github.createCommit(repo, { message: messageOf(ref, runId), tree, parents: [tip] });
  if (await github.getRefSha(repo, `heads/${branch}`) === null) {
    try {
      await github.createBranch(repo, branch, commit);
      return { branch, base, commit, created: true };
    } catch (e) {
      // A push close behind another made the branch between the read and the write (422, "Reference already exists"): this
      // push's commit is the one to build, so the branch is moved to it. Any other failure is the step's.
      if (!(e instanceof GitHubError) || e.status !== 422) throw e;
    }
  }
  // The branch is the preview's alone, and a new commit on the default branch's tip is not its child: a forced move.
  await github.replaceBranch(repo, branch, commit);
  return { branch, base, commit, created: false };
}

module.exports = {
  BRANCH_ROOT, Refused, checkRef, previewBranchOf, pointPreviewBranch,
};
