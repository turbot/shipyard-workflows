'use strict';

// The git and version helpers the facts and the cut share. Every git call is an argument
// list to `git`, never a shell line, so a tag or a branch name is never read as syntax.

const { execFileSync } = require('node:child_process');

class ReleaseError extends Error {}
// A refusal is not a failure to run: the inputs are fine and the answer is no (exit 1).
class Refusal extends ReleaseError {}

// `timeout` (ms) and `env` (added to this process's) are for a call that goes to the network.
function git(dir, args, { allowFail = false, timeout, env } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: dir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      ...(timeout ? { timeout } : {}),
      ...(env ? { env: { ...process.env, ...env } } : {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    if (allowFail) return null;
    const detail = String((e.stderr || e.message || '')).trim().split('\n')[0];
    throw new ReleaseError(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A release tag is the prefix and a plain `X.Y.Z`: no pre-release, no build metadata.
function tagRegExp(prefix) {
  return new RegExp(`^${escapeRegExp(prefix)}(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$`);
}

function parseTag(tag, prefix) {
  const m = tagRegExp(prefix).exec(tag);
  return m ? { tag, parts: [Number(m[1]), Number(m[2]), Number(m[3])] } : null;
}

const compareParts = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

// The newest release tag by version, not by date: a tag made late for an old line does not win.
function newestReleaseTag(dir, prefix) {
  const tags = git(dir, ['tag', '--list']).split('\n').map((t) => t.trim()).filter(Boolean);
  const found = tags.map((t) => parseTag(t, prefix)).filter(Boolean).sort((a, b) => compareParts(a.parts, b.parts));
  return found.length ? found[found.length - 1] : null;
}

function bump(parts, level) {
  if (level === 'major') return [parts[0] + 1, 0, 0];
  if (level === 'minor') return [parts[0], parts[1] + 1, 0];
  if (level === 'patch') return [parts[0], parts[1], parts[2] + 1];
  throw new ReleaseError(`the level must be major, minor or patch, not ${JSON.stringify(level)}`);
}

const formatVersion = (parts) => parts.join('.');

// A full commit id from anything git can name; fails when it names no commit.
function resolveCommit(dir, ref) {
  const out = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  if (!out || !/^[0-9a-f]{40}$/.test(out.trim())) throw new ReleaseError(`${ref} is not a commit in this repo`);
  return out.trim();
}

function isAncestor(dir, ancestor, descendant) {
  return git(dir, ['merge-base', '--is-ancestor', ancestor, descendant], { allowFail: true }) !== null;
}

// Whether `pick` is `origin` cherry-picked onto `pick`'s own first parent: the tree git makes by
// replaying `origin`'s change over that parent is exactly `pick`'s tree. A message that says so proves
// nothing, and a patch with its context or whitespace left out (`git patch-id`) proves too little: a
// line moved, or re-indented in a language where indentation means something, is another change. A
// merge commit is read as what it brought in over its first parent. False when git cannot tell
// (older than 2.40, which has no `merge-tree --merge-base`) or the replay conflicts.
function isPickOf(dir, pick, origin) {
  const replay = git(dir, ['merge-tree', '--write-tree', `--merge-base=${origin}^1`, `${pick}^1`, origin], { allowFail: true });
  const tree = replay && replay.split('\n')[0].trim();
  if (!tree || !/^[0-9a-f]{40,64}$/.test(tree)) return false;
  const picked = git(dir, ['rev-parse', '--verify', '--quiet', `${pick}^{tree}`], { allowFail: true });
  return Boolean(picked) && picked.trim() === tree;
}

// The first-parent commits of `from..to`, newest first, each with its parent count. A
// squash or merge commit is one PR; the commits inside a merged branch are not listed.
function rangeCommits(dir, from, to) {
  const out = git(dir, ['log', '--first-parent', '--format=%H%x1f%P%x1f%s%x1e', `${from}..${to}`]);
  return out.split('\x1e').map((r) => r.replace(/^\n/, '')).filter(Boolean).map((r) => {
    const [sha, parents, subject] = r.split('\x1f');
    return { sha, parents: parents.split(' ').filter(Boolean).length, subject };
  });
}

// The PR a mainline commit came from, by GitHub's own subjects: a squash ends `(#12)` and
// a merge commit starts `Merge pull request #12`.
function prNumberOf(subject) {
  const squash = /\(#(\d+)\)\s*$/.exec(subject);
  if (squash) return Number(squash[1]);
  const merge = /^Merge pull request #(\d+)\b/.exec(subject);
  return merge ? Number(merge[1]) : null;
}

// The base branch's line: `main` takes every release tag, `main-2` the 2.x tags, `main-1.4` the 1.4.x tags.
// Null for any other branch. Here, beside the git helpers, so facts and the tag step can both ask it.
function lineOf(baseRef) {
  if (baseRef === 'main') return { name: 'main', major: null, minor: null };
  const m = /^main-(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(String(baseRef));
  if (!m) return null;
  return { name: baseRef, major: Number(m[1]), minor: m[2] === undefined ? null : Number(m[2]) };
}

// The cut commit's trailer that names the work branch, read back by `shipyard merge-back`.
const WORK_BRANCH_TRAILER = 'Release-From';
// A branch name as the workflows pass it: letters, digits and `._/-`, never a leading `-` or `..`.
const isBranchName = (name) => /^[A-Za-z0-9._/-]+$/.test(name) && !name.startsWith('-') && !name.includes('..') && !name.endsWith('/');
module.exports = {
  WORK_BRANCH_TRAILER, isBranchName, lineOf, ReleaseError, Refusal, git, parseTag, newestReleaseTag, bump, formatVersion, resolveCommit, isAncestor,
  rangeCommits, prNumberOf, compareParts, isPickOf,
};
