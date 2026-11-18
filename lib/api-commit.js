'use strict';

// Every commit Shipyard writes goes through GitHub's git data API (blob, tree, commit, ref), never a
// local `git commit` and `git push`. A commit the API makes with a job's token carries no author or
// committer of ours, so GitHub makes it as the token's own identity and signs it: a repo that requires
// signed commits on its release branch and on its base accepts it. A local commit is unsigned.
//
// The three steps are kept apart so a caller can make every commit, and check everything it needs to,
// before the branch moves: the objects `commitChain` makes belong to no branch, so a failure part-way
// leaves nothing on any ref.

const { execFileSync } = require('node:child_process');
const { Refusal, ReleaseError, git } = require('./release-git');

// A tree entry that writes text, with its content in the request.
const textEntry = (filePath, text) => ({
  path: filePath, mode: '100644', type: 'blob', content: text,
});

// The tree a commit of this checkout holds. The remote holds the same commit, so it holds the same tree.
const treeOf = (dir, commit) => git(dir, ['rev-parse', '--verify', `${commit}^{tree}`]).trim();

/**
 * Makes `steps` as commits, each on the one before, the first on `parent`. A step is
 * `{ message, entries }`: the entries change the tree of the commit before it (`createTree` with a base tree).
 * Returns the last commit and the commit of every step. Makes no ref.
 */
async function commitChain({
  github, repo, parent, baseTree, steps,
}) {
  let at = parent;
  let tree = baseTree;
  const commits = [];
  for (const step of steps) {
    tree = await github.createTree(repo, step.entries, { baseTree: tree });
    at = await github.createCommit(repo, { message: step.message, tree, parents: [at] });
    commits.push(at);
  }
  return { commit: at, commits };
}

/**
 * Puts `branch` on `commit`: a new branch, or the leftover of a closed candidate. A branch that exists is
 * replaced only when it is at a commit this checkout has already seen on a remote (`refs/remotes/*`): one
 * that appeared, or moved, since was never vetted, and is never overwritten. A new ref is made by the API,
 * which refuses to make one that exists, so a branch that appears between the read and the write is not
 * overwritten. Replacing a leftover has no lease (the API cannot say "only if it is still at this commit"), so one
 * that moves between the read and the write is overwritten: a window of one request.
 */
async function placeBranch({
  github, repo, dir, branch, commit,
}) {
  const before = await github.getRefSha(repo, `heads/${branch}`);
  if (before === null) {
    await github.createBranch(repo, branch, commit);
    return;
  }
  const seen = git(dir, ['for-each-ref', '--format=%(objectname)', `refs/remotes/*/${branch}`]).split('\n').map((l) => l.trim()).filter(Boolean);
  if (!seen.includes(before)) {
    throw new Refusal(`${branch} on the remote (${before.slice(0, 7)}) is not the branch this checkout saw${seen.length ? ` (${seen[0].slice(0, 7)})` : ' (it had none)'}: it appeared or moved since, so nothing was written`);
  }
  await github.replaceBranch(repo, branch, commit);
}

// A blob's bytes, whole: git's own copy, never text decoded and encoded again.
function blobBytes(dir, sha) {
  try {
    return execFileSync('git', ['cat-file', 'blob', sha], { cwd: dir, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    throw new ReleaseError(`git cat-file failed for ${sha}: ${String(e.stderr || e.message).trim().split('\n')[0]}`);
  }
}

/**
 * The tree entries that turn the local tree `from` into the local tree `to`, with each changed file uploaded as
 * a blob. A deleted file is an entry with no sha. For a change worked out locally, in git, as a cherry-pick is.
 */
async function entriesBetween({
  dir, github, repo, from, to,
}) {
  const raw = git(dir, ['diff-tree', '-r', '-z', '--no-renames', '--raw', from, to]);
  const fields = raw.split('\0');
  const entries = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(fields[i]);
    if (!meta) continue;
    const [, , mode, , sha, status] = meta;
    const filePath = fields[i + 1];
    if (status === 'D') {
      entries.push({
        path: filePath, mode: '100644', type: 'blob', sha: null,
      });
    } else if (mode === '160000') {
      entries.push({
        path: filePath, mode, type: 'commit', sha,
      });
    } else {
      entries.push({
        path: filePath, mode, type: 'blob', sha: await github.createBlob(repo, blobBytes(dir, sha)),
      });
    }
  }
  return entries;
}

module.exports = {
  textEntry, treeOf, commitChain, placeBranch, entriesBetween,
};
