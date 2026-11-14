'use strict';

// The tag after the shipped signal. Reads GitHub only: no checkout, and nothing from the repo
// is ever run. A release PR that merged into `main` or `main-<x.y>` is tagged at its merge
// commit with an annotated tag, once something says it shipped. A release tag is only ever
// created: one that exists is read, never moved and never deleted. A floating major tag (`v1`)
// is the one tag that moves.

const { GitHubError } = require('./github');
const {
  ReleaseError, Refusal, parseTag, formatVersion, compareParts,
} = require('./release-git');
const { lineOf } = require('./release-check');

const MARKER = /^<!-- shipyard:release-pr (\S+) -->/m;
const WRITE_ACCESS = new Set(['admin', 'write']);
const MAX_PEEL = 5;
const MAX_FOLLOW = 3;

// An untrusted string, quoted and cut short, for a message.
const show = (value, max = 80) => {
  const text = JSON.stringify(String(value));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};
const short = (sha) => String(sha).slice(0, 7);

// ---------------------------------------------------------------------------
// The release PR

// The branches that can hold a release: `main`, and `main-<x.y>` for an older version.
const isReleaseBase = (ref) => lineOf(ref) !== null;
const isReleaseHead = (ref) => /^release\//.test(String(ref || ''));

/**
 * What a merged PR must be for its merge to be tagged, read from GitHub as it stands now.
 * Returns the tag and the commit to tag; throws a Refusal naming what is wrong.
 */
function releaseOf(pr, { repo, prefix, automationLogins, sha = null }) {
  const n = `#${pr.number}`;
  if (!pr.merged_at || pr.merged === false) throw new Refusal(`${n} is not merged: there is nothing to tag`);
  const merge = String(pr.merge_commit_sha || '');
  if (!/^[0-9a-f]{40}$/.test(merge)) throw new Refusal(`${n} has no merge commit`);
  if (sha && merge !== sha) throw new Refusal(`${n} merged as ${short(merge)}, not ${short(sha)}`);
  const base = pr.base && pr.base.ref;
  if (!isReleaseBase(base)) throw new Refusal(`${n} went into ${show(base)}, not main or main-<version>`);
  const head = pr.head || {};
  const headRepo = head.repo && String(head.repo.full_name).toLowerCase();
  if (headRepo !== repo.toLowerCase()) throw new Refusal(`${n}'s head is not a branch of ${repo}`);
  if (!isReleaseHead(head.ref)) throw new Refusal(`${n}'s head is ${show(head.ref)}, not a release/ branch`);

  const title = /^Release (\S+)$/.exec(String(pr.title || '').trim());
  const parsed = title ? parseTag(title[1], prefix) : null;
  if (!parsed) throw new Refusal(`${n}'s title ${show(pr.title)} is not "Release <tag>" with a release tag that starts with ${show(prefix)}`);
  if (head.ref !== `release/${formatVersion(parsed.parts)}`) {
    throw new Refusal(`${n}'s head is ${show(head.ref)}, but its title ${show(pr.title)} makes release/${formatVersion(parsed.parts)}`);
  }
  const marker = MARKER.exec(String(pr.body || '').replace(/\r\n?/g, '\n'));
  if (!marker || marker[1] !== parsed.tag) {
    throw new Refusal(`the body of ${n} has a release-pr marker for ${marker ? show(marker[1], 40) : 'no tag'}, not ${parsed.tag}`);
  }
  const author = String(pr.user && pr.user.login).toLowerCase();
  if (!automationLogins.some((l) => l.toLowerCase() === author)) {
    throw new Refusal(`${n} was opened by ${show(pr.user && pr.user.login, 40)}, which is not one of the release automation's accounts`);
  }
  return { number: pr.number, tag: parsed.tag, parts: parsed.parts, sha: merge, base, mergedAt: pr.merged_at };
}

// ---------------------------------------------------------------------------
// The tags

// The commit a tag ref names, through any annotated tag objects on the way.
async function commitOfRef(github, repo, ref) {
  let at = ref;
  for (let i = 0; i < MAX_PEEL; i++) {
    if (at.type === 'commit') return at.sha;
    if (at.type !== 'tag') throw new ReleaseError(`a tag in ${repo} names a ${show(at.type, 20)}, not a commit`);
    at = await github.getTagObject(repo, at.sha);
  }
  throw new ReleaseError(`a tag in ${repo} is wrapped in more than ${MAX_PEEL} tag objects`);
}

function messageOf(release, signal) {
  return `Release ${release.tag}\n\nRelease PR: #${release.number}\nShipped: ${signal}\n`;
}

// Makes the annotated release tag at the merge commit. A tag already there at that commit is
// done; one at another commit is a refusal, and nothing is written. Returns `created` or `exists`.
async function makeReleaseTag({ github, releaser, repo, release, signal }) {
  const settle = async () => {
    const found = await github.getTagRef(repo, release.tag);
    if (!found) return null;
    const at = await commitOfRef(github, repo, found);
    if (at !== release.sha) {
      throw new Refusal(`${release.tag} already exists at ${short(at)}, not at the merge commit ${short(release.sha)}. A release tag never moves and is never deleted: nothing was changed`);
    }
    return 'exists';
  };
  if (await settle()) return 'exists';
  const object = await releaser.createTagObject(repo, { tag: release.tag, message: messageOf(release, signal), commit: release.sha });
  try {
    await releaser.createTag(repo, release.tag, object);
  } catch (e) {
    // A second run won the race: the tag is there. It is fine only if it is the same commit.
    if (!(e instanceof GitHubError) || e.status !== 422) throw e;
    if (await settle()) return 'exists';
    throw e;
  }
  return 'created';
}

// The floating major tag (`v1`) follows the newest release of its major: a lightweight ref at
// the same commit as that release. A patch for an older line (`v1.4.3` after `v1.5.0`) leaves it.
// Runs may overlap (a ship job's push and a `/shipped`, or two releases back to back), so after a
// write the newest release is read again: a newer one made meanwhile is followed, never undone.
async function moveFloatingMajor({ github, releaser, repo, prefix, release }) {
  const name = `${prefix}${release.parts[0]}`;
  if (parseTag(name, prefix)) throw new ReleaseError(`${name} is a release tag, not a floating one`);
  const newestOf = async () => {
    const names = await github.listTagNames(repo, prefix);
    return [...names.map((t) => parseTag(t, prefix)).filter(Boolean), { tag: release.tag, parts: release.parts }]
      .filter((t) => t.parts[0] === release.parts[0])
      .sort((a, b) => compareParts(a.parts, b.parts))
      .pop();
  };
  const first = await newestOf();
  if (first.tag !== release.tag) return { name, action: 'left', why: `${first.tag} is newer` };

  let target = { tag: release.tag, sha: release.sha };
  let result = null;
  for (let round = 0; round < MAX_FOLLOW; round++) {
    const found = await github.getTagRef(repo, name);
    const at = found ? await commitOfRef(github, repo, found) : null;
    let action = 'unchanged';
    try {
      if (at === null) {
        await releaser.createTag(repo, name, target.sha);
        action = 'created';
      } else if (at !== target.sha) {
        await releaser.moveTag(repo, name, target.sha);
        action = 'moved';
      }
    } catch (e) {
      // Another run made the ref between the read and the write: read it again.
      if (e instanceof GitHubError && e.status === 422 && round < MAX_FOLLOW - 1) continue;
      throw e;
    }
    // What the report says: the first write's action and where the ref was before it, and where it ended.
    const wrote = result !== null && result.action !== 'unchanged';
    result = {
      name, action: wrote ? result.action : action, from: wrote ? result.from : at, to: target.sha,
    };
    const now = await newestOf();
    if (now.tag === target.tag) break;
    // A newer release of this major was tagged meanwhile: follow it.
    const ref = await github.getTagRef(repo, now.tag);
    if (!ref) break;
    target = { tag: now.tag, sha: await commitOfRef(github, repo, ref) };
  }
  return result;
}

// ---------------------------------------------------------------------------
// The signal

// What the first line of a comment asks for: `/shipped`, alone.
const isShippedComment = (body) => /^\/shipped[ \t]*$/.test(String(body || '').replace(/\r\n?/g, '\n').split('\n')[0]);

const isBot = (user) => !user || user.type === 'Bot' || /\[bot\]$/i.test(user.login || '');

// A login for a tag message: GitHub's own characters only.
const loginText = (login) => String(login).replace(/[^A-Za-z0-9_[\]-]/g, '?').slice(0, 60);

module.exports = {
  releaseOf, makeReleaseTag, moveFloatingMajor, commitOfRef, isShippedComment, isBot, isReleaseBase, isReleaseHead, loginText, show, short, WRITE_ACCESS,
};
