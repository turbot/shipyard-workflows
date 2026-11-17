'use strict';

// The newest release tag as GitHub holds it, and a clone that has it. `facts` starts a range at the
// newest release tag of the clone it is given. A clone that never fetched the newest tag (a fetch of
// the work branch does not bring a tag that is on another branch's history) would start the range one
// release too early, and `lint-prep` would pass it, as it lints against those same facts. So before it
// reads the clone's tags, `facts` asks GitHub for the newest release tag and makes the clone agree.

const { ReleaseError, git, parseTag, compareParts } = require('./release-git');

const FETCH_TIMEOUT_MS = 60000;
const MAX_PEEL = 5;
const short = (sha) => String(sha).slice(0, 7);

const byVersion = (a, b) => compareParts(a.parts, b.parts);

// The newest of a list of tag names that are release tags, by version; null when none is.
function newestOf(names, prefix) {
  const found = names.map((n) => parseTag(n, prefix)).filter(Boolean).sort(byVersion);
  return found.length ? found[found.length - 1].tag : null;
}

/**
 * GitHub's newest release tag with the prefix, as `{ tag, commit }`, or null when it has none: the
 * newest published GitHub Release (a draft is no release yet), else the newest matching tag. The
 * commit is the one GitHub's tag names, through any annotated tag objects.
 */
async function githubNewestTag(github, repo, prefix) {
  const releases = (await github.listReleases(repo)).filter((r) => !r.draft).map((r) => r.tag);
  const tag = newestOf(releases, prefix) || newestOf(await github.listTags(repo), prefix);
  if (!tag) return null;
  const ref = await github.getTagRef(repo, tag);
  if (!ref) throw new ReleaseError(`GitHub lists ${tag} as ${repo}'s newest release but has no such tag`);
  return { tag, commit: await commitOf(github, repo, ref) };
}

// The commit a tag ref names, through any annotated tag objects on the way. (Not lib/tag.js's own: that
// file reaches `facts` through the release check, and the two would require each other.)
async function commitOf(github, repo, ref) {
  let at = ref;
  for (let i = 0; i < MAX_PEEL; i++) {
    if (at.type === 'commit') return at.sha;
    if (at.type !== 'tag') throw new ReleaseError(`a tag in ${repo} names a ${String(at.type).slice(0, 20)}, not a commit`);
    at = await github.getTagObject(repo, at.sha);
  }
  throw new ReleaseError(`a tag in ${repo} is wrapped in more than ${MAX_PEEL} tag objects`);
}

const localCommit = (dir, tag) => {
  const out = git(dir, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`], { allowFail: true });
  return out && /^[0-9a-f]{40}$/.test(out.trim()) ? out.trim() : null;
};

function fetchTag(dir, tag) {
  git(dir, ['fetch', '--quiet', '--no-tags', 'origin', 'tag', tag], { timeout: FETCH_TIMEOUT_MS, env: { GIT_TERMINAL_PROMPT: '0' } });
}

/**
 * Makes sure the clone has GitHub's newest release tag, at GitHub's commit, before the range is read
 * from it. A tag the clone lacks is fetched once (`git fetch origin tag <tag>`). A tag it cannot get,
 * or has at another commit, is a refusal: no facts are made from a range that may start too early.
 * Returns the tag it checked, or null when GitHub has no release tag with the prefix.
 */
async function ensureNewestTag({ dir, repo, prefix, github, fetchImpl = fetchTag }) {
  const newest = await githubNewestTag(github, repo, prefix);
  if (!newest) return null;
  const { tag, commit } = newest;
  if (tag.startsWith('-')) throw new ReleaseError(`${repo}'s newest release tag, ${tag}, starts with a dash: it cannot be fetched safely`);
  const fix = `git fetch origin tag ${tag}`;
  let have = localCommit(dir, tag);
  if (!have) {
    try {
      fetchImpl(dir, tag);
    } catch (e) {
      throw new ReleaseError(`this clone has no ${tag}, ${repo}'s newest release, and fetching it failed (${e.message}): run \`${fix}\` in it, then make the facts again`);
    }
    have = localCommit(dir, tag);
    if (!have) throw new ReleaseError(`this clone has no ${tag}, ${repo}'s newest release, and \`${fix}\` did not bring it (is \`origin\` ${repo}?): fetch it from the remote that is, then make the facts again`);
  }
  if (have !== commit) {
    throw new ReleaseError(`this clone's ${tag} is ${short(have)}, but ${repo}'s ${tag} is ${short(commit)}: run \`git fetch --force origin tag ${tag}\` in it (from the remote that is ${repo}), then make the facts again`);
  }
  return tag;
}

module.exports = { ensureNewestTag, githubNewestTag, newestOf };
