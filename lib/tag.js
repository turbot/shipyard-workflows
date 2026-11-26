'use strict';

// The tag after the shipped signal. Reads GitHub only: no checkout, and nothing from the repo
// is ever run. A release PR that merged into `main` or `main-<x.y>` is tagged at its merge
// commit with an annotated tag, once something says it shipped. A release tag is only ever
// created: one that exists is read, never moved and never deleted. A floating major tag (`v1`)
// is the one tag that moves. After the tag, the step makes the GitHub Release at it and one
// "Shipped" comment on the release PR; each is made once, and a run again makes what is missing.

const crypto = require('node:crypto');
const fsp = require('node:fs/promises');
const { GitHubError } = require('./github');
const {
  ReleaseError, Refusal, parseTag, formatVersion, compareParts,
} = require('./release-git');
const { lineOf } = require('./release-check');
const { changelogSection, releaseText } = require('./changelog');
const { FILE: RESHIP_FILE, parseReshipFile } = require('./reship');
const { isLight, lightReleaseBody } = require('./light');
const { readReleaseInputs } = require('./release-data');

const MARKER = /^<!-- shipyard:release-pr (\S+) -->/m;
const WRITE_ACCESS = new Set(['admin', 'write']);
const MAX_PEEL = 5;
const MAX_FOLLOW = 3;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const RECORD_START = '<!-- shipyard:record:start -->';
const RECORD_END = '<!-- shipyard:record:end -->';

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

// The build digest the audit record on the release PR names (its `<!-- shipyard:build sha256:... -->` marker, or
// the "Build digest: `sha256:...`" line of a record an older Shipyard wrote), or null when the body holds no record
// or no valid digest. Only the record block is read.
function digestOf(body) {
  const text = String(body || '').replace(/\r\n?/g, '\n');
  const start = text.indexOf(RECORD_START);
  const end = start === -1 ? -1 : text.indexOf(RECORD_END, start);
  if (end === -1) return null;
  const block = text.slice(start, end);
  const m = /^<!-- shipyard:build (\S+) -->$/m.exec(block) || /^Build digest: `([^`\n]+)`/m.exec(block);
  return m && DIGEST.test(m[1]) ? m[1] : null;
}

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
  return {
    number: pr.number, tag: parsed.tag, parts: parsed.parts, sha: merge, base, mergedAt: pr.merged_at, digest: digestOf(pr.body),
    head: /^[0-9a-f]{40}$/.test(String(head.sha || '')) ? head.sha : null,
  };
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
  const reships = (release.reships || []).map((r) => `Re-ship of: #${r.releasePr} (run ${r.failedRun.id} failed)\n`).join('');
  return `Release ${release.tag}\n\nRelease PR: #${release.number}\n${reships}Shipped: ${signal}\n`;
}

/**
 * What the release PR `pr` (read as `release`) carries: its facts, prep, notes and re-ships, from the block
 * in the body its cut commit pins (`source: 'body'`) or, for a release cut before that, from `releases/<tag>/`
 * at the merge commit (`source: 'folder'`). A body that does not match its cut commit is a Refusal, as is a
 * release cut two or more minor versions before `current`, the Shipyard that reads (lib/shipyard-version.js).
 */
async function readRelease({
  github, repo, release, pr, current = null,
}) {
  if (!release.head) throw new Refusal(`#${release.number} has no head commit to read its release data from`);
  return readReleaseInputs({
    current,
    body: pr.body,
    tag: release.tag,
    headSha: release.head,
    prNumber: release.number,
    getCommit: (sha) => github.getCommit(repo, sha),
    readFolderFile: (name) => github.getFileText(repo, `releases/${release.tag}/${name}`, release.sha),
  });
}

// Checks a re-ship against GitHub: the PR it names must be a merged release PR of the same tag from
// this repo that merged as the commit it names, and not the PR being tagged. `where` says where the
// entry was read, for the refusal.
async function checkReship({
  github, repo, release, r, where,
}) {
  if (r.releasePr === release.number) throw new Refusal(`${where} names #${r.releasePr}, the PR being tagged, as the one it re-ships`);
  const pr = await github.getPull(repo, r.releasePr);
  const headRepo = pr.head && pr.head.repo && String(pr.head.repo.full_name).toLowerCase();
  if (!pr.merged_at || String(pr.title || '').trim() !== `Release ${release.tag}` || headRepo !== repo.toLowerCase()
    || !pr.head || pr.head.ref !== `release/${formatVersion(release.parts)}` || pr.merge_commit_sha !== r.mergeCommit) {
    throw new Refusal(`${where} names #${r.releasePr}, which is not a merged release PR of ${release.tag} that merged as ${short(r.mergeCommit)}`);
  }
}

/**
 * The release PRs a re-ship finishes (lib/reship.js): one for each entry in the release data's `reships`
 * (`inputs`, from readRelease), or, for a release cut before the data rode in the body, one for each
 * `releases/<tag>/reship-<run>.json` at the merge commit, read from GitHub. Each named PR must be a merged
 * release PR of the same tag from this repo, or the entry is refused: it cannot steer a comment onto any
 * other PR. An empty list for a release that is no re-ship.
 */
async function reshipsOf({
  github, repo, release, inputs = null,
}) {
  if (inputs && inputs.source === 'body') {
    const found = [];
    for (const [i, r] of inputs.reships.entries()) {
      const name = `re-ship ${i + 1}`;
      await checkReship({
        github, repo, release, r, where: `re-ship ${i + 1} in the release data in #${release.number}'s body`,
      });
      found.push({ ...r, name });
    }
    return found;
  }
  const names = (await github.listFolder(repo, `releases/${release.tag}`, release.sha)).filter((n) => RESHIP_FILE.test(n)).sort();
  const found = [];
  for (const name of names) {
    const text = await github.getFileText(repo, `releases/${release.tag}/${name}`, release.sha);
    if (text === null) throw new ReleaseError(`releases/${release.tag}/${name} is listed at ${short(release.sha)} but cannot be read`);
    const r = parseReshipFile(text, { tag: release.tag, name });
    await checkReship({
      github, repo, release, r, where: `releases/${release.tag}/${name}`,
    });
    found.push({ ...r, name });
  }
  return found;
}

// ---------------------------------------------------------------------------
// The release of a push

/**
 * Which pull request a push to `branch` is the merge of, read from GitHub: `{ number }` for a release
 * PR, or `{ skip: '<reason>' }` when the branch is not `main` or `main-<x.y>`, no PR merged as `sha`
 * into it, or the first that did is not from a release/ branch.
 */
async function mergedPullOfPush({
  github, repo, branch, sha,
}) {
  if (lineOf(branch) === null) return { skip: `${show(branch, 60)} is not main or main-<version>` };
  const found = (await github.listPullsOfCommit(repo, sha))
    .filter((p) => p && p.merged_at && p.merge_commit_sha === sha && p.base && p.base.ref === branch);
  if (!found.length) return { skip: `${short(sha)} on ${branch} is not the merge of a pull request` };
  if (!isReleaseHead(found[0].head && found[0].head.ref)) return { skip: `#${found[0].number} is not a release PR` };
  return { number: found[0].number };
}

/**
 * The release a merged PR `pr`, already read from GitHub, makes: releaseOf's checks, then its release
 * data and its re-ships, each checked. Throws a Refusal for one that breaks a rule.
 */
async function releaseOfPull({
  github, repo, pr, prefix, automationLogins, sha = null, current = null,
}) {
  const release = releaseOf(pr, {
    repo, prefix, automationLogins, sha,
  });
  // The release data (the notes, the facts, the re-ships), read once from the PR's body and checked
  // against its cut commit; a release cut before that is read from releases/<tag>/. A body that does
  // not check out tags nothing.
  release.inputs = await readRelease({
    github, repo, release, pr, current,
  });
  // A re-ship names, in its release data, the release PR whose ship failed: it gets a Shipped
  // comment too, and the tag's message names it. Read before the tag, so one that does not check
  // out tags nothing.
  release.reships = await reshipsOf({
    github, repo, release, inputs: release.inputs,
  });
  return release;
}

/**
 * The one answer to "is this push a release merge, and which release": the tag step and
 * `shipyard release-version` both call it, so they cannot disagree (issue #453). Returns
 * `{ skip: '<reason>' }` for a push that is no release merge, or `{ pr, release }` for one. A
 * Refusal from it is the tag's own refusal. `beforeRead(number)`, when given, runs once the release
 * PR is found and before it is read.
 */
async function releaseOfPush({
  github, repo, branch, sha, prefix, automationLogins, beforeRead = null, current = null,
}) {
  const found = await mergedPullOfPush({
    github, repo, branch, sha,
  });
  if (found.skip) return { skip: found.skip };
  if (beforeRead) await beforeRead(found.number);
  const pr = await github.getPull(repo, found.number);
  const release = await releaseOfPull({
    github, repo, pr, prefix, automationLogins, sha, current,
  });
  return { pr, release };
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
// The GitHub Release and the "Shipped" comment

const readFile = (file) => fsp.readFile(file);
const usableUrl = (url) => /^https:\/\/[^\s<>`()[\]]+$/.test(String(url));

// The body and the name of the Release. A full release's body is its approved release notes, as the changelog page shows
// them (their body, with no front matter: the title line is the page's title, and the name is the tag); a full release with
// no release notes gets the CHANGELOG section read at the tagged commit. A CLI's update notice reads the latest Release's name
// as its version (the Pipelings hubs strip one `v` and serve it), so the name is never the release notes' title, which is not
// a version. Nothing else reads a Release's body: the hubs, Homebrew and the release check read its name, its files or its link.
async function releaseTexts({
  github, repo, release, changelog,
}) {
  const version = formatVersion(release.parts);
  // What the release PR carries (readRelease), or, for a caller that read none, the folder's files at the merge commit.
  const read = async (name, parse) => {
    const kept = await github.getFileText(repo, `releases/${release.tag}/${name}`, release.sha);
    return kept === null ? null : parse(kept);
  };
  const json = (kept) => {
    try {
      return JSON.parse(kept);
    } catch {
      return null;
    }
  };
  const text = await github.getFileText(repo, changelog, release.sha);
  const notes = release.inputs ? release.inputs.notes : await read('release-notes.md', (kept) => kept);
  let body = releaseText({ releaseNotes: notes, section: text === null ? null : changelogSection(text, version) });
  // A light release (lib/light.js) has no CHANGELOG section: its Release lists the merged PRs the cut kept in its facts.
  if (body === null) {
    const facts = release.inputs ? release.inputs.facts : await read('facts.json', json);
    if (facts && isLight(facts) && Array.isArray(facts.prs)) body = lightReleaseBody(facts);
  }
  if (body === null) {
    const why = text === null ? `${changelog} is not there` : `${changelog} has no section for ${version}`;
    throw new ReleaseError(`at the merge commit ${short(release.sha)}, ${why}, so the GitHub Release has no body. ${release.tag} is tagged: make the Release by hand from the release PR's changelog`);
  }
  return { body, name: release.tag };
}

// Whether a newer release than this one is already tagged, so this one is not the latest.
async function makeLatestOf({ github, repo, prefix, release }) {
  const newer = (await github.listTagNames(repo, prefix))
    .map((t) => parseTag(t, prefix)).filter(Boolean)
    .some((t) => compareParts(t.parts, release.parts) > 0);
  return newer ? 'false' : 'true';
}

// Makes the GitHub Release at the tag: its body the release notes (releaseTexts), else the CHANGELOG section; its
// name its tag. It is made complete, never edited once it is published. One that exists is left as it is. Returns `{ action: 'created' | 'exists', url }`.
//
// With `assets` (the files of the caller's artifact, from loadAssets) the Release is made as a draft,
// gets each file, and is then published: a published Release is immutable, so its files can only be
// there from the start. A draft an earlier attempt left for the tag is reused, and only the files it
// lacks are uploaded; a published Release is still left alone. Returns the same, plus `files`.
async function makeGitHubRelease({
  github, releaser, repo, prefix, release, changelog, assets = null,
}) {
  const found = await github.getRelease(repo, release.tag);
  if (found) return { action: 'exists', url: found.url };
  if (assets) {
    return makeReleaseWithFiles({
      github, releaser, repo, prefix, release, changelog, assets,
    });
  }

  const { body, name } = await releaseTexts({
    github, repo, release, changelog,
  });
  const makeLatest = await makeLatestOf({
    github, repo, prefix, release,
  });
  let created;
  try {
    created = await releaser.createRelease(repo, {
      tag: release.tag, name, body, makeLatest,
    });
  } catch (e) {
    // A second run made the Release between the read and the write: it is there, and is left alone.
    if (!(e instanceof GitHubError) || e.status !== 422) throw e;
    const now = await github.getRelease(repo, release.tag);
    if (now) return { action: 'exists', url: now.url };
    throw e;
  }
  return { action: 'created', url: created.url };
}

// The draft Release at the tag, if one is there. Only the release App's token sees a draft.
async function draftOf(releaser, repo, tag) {
  return (await releaser.listReleases(repo)).find((r) => r.draft && r.tag === tag) || null;
}

// Puts the build's files on a draft Release, and returns the names it uploaded. A file a failed upload left
// half-done, or one whose content is not the build's (GitHub's digest of it is not the build's, or GitHub gave
// none), is replaced: a rebuilt release must never keep an old file beside new ones. One that is whole and the
// same stays. Files the build does not name are left where they are. The prerelease step uses it too.
async function attachFiles({
  releaser, repo, draft, assets,
}) {
  const held = new Map(draft.assets.map((a) => [a.name, a]));
  const uploaded = [];
  for (const file of assets) {
    const there = held.get(file.name);
    const data = await readFile(file.path);
    const digest = `sha256:${crypto.createHash('sha256').update(data).digest('hex')}`;
    if (there && there.state === 'uploaded' && there.size === data.length && there.digest === digest) continue;
    if (there) await releaser.deleteReleaseAsset(repo, there.id);
    await releaser.uploadReleaseAsset(repo, draft, { name: file.name, data });
    uploaded.push(file.name);
  }
  return uploaded;
}

async function makeReleaseWithFiles({
  github, releaser, repo, prefix, release, changelog, assets,
}) {
  let draft = await draftOf(releaser, repo, release.tag);
  if (!draft) {
    const { body, name } = await releaseTexts({
      github, repo, release, changelog,
    });
    try {
      draft = await releaser.createRelease(repo, {
        tag: release.tag, name, body, draft: true,
      });
    } catch (e) {
      // A second run made the Release, or its draft, between the read and the write: use that one.
      if (!(e instanceof GitHubError) || e.status !== 422) throw e;
      const now = await github.getRelease(repo, release.tag);
      if (now) return { action: 'exists', url: now.url };
      draft = await draftOf(releaser, repo, release.tag);
      if (!draft) throw e;
    }
  }
  const uploaded = await attachFiles({
    releaser, repo, draft, assets,
  });
  const makeLatest = await makeLatestOf({
    github, repo, prefix, release,
  });
  const published = await releaser.publishRelease(repo, draft.id, { makeLatest });
  return {
    action: 'created', url: published.url, files: assets.map((f) => f.name), uploaded,
  };
}

const shippedMarker = (tag) => `<!-- shipyard:shipped ${tag} -->`;

// A person's name for a comment: no mention, link, code or table mark, on one line.
const plainName = (name) => String(name).replace(/[`<>@[\]\\*_|~\r\n]/g, '').trim().slice(0, 60) || '(no name)';

// `via` is the re-ship PR that shipped it, on the comment for the release PR a re-ship finished.
function shippedComment(release, url, approvers = [], via = null) {
  if (!usableUrl(url)) throw new ReleaseError(`GitHub answered a link for the release of ${release.tag} that is not one to use`);
  const names = approvers.map(plainName);
  const who = names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return [
    shippedMarker(release.tag),
    `## Shipped: ${release.tag}`,
    '',
    ...(via ? [`Shipped by the re-ship #${via}: this PR's ship run failed, and the re-ship fixed the ship job and finished ${release.tag}.`, ''] : []),
    `- Approved by: ${names.length ? who : 'no approval of the approved commit was found'}`,
    `- Approved commit: ${release.head ? `\`${release.head}\`` : 'not known'}`,
    `- Build: ${release.digest ? `\`${release.digest}\`` : "no build digest in this PR's record"}`,
    `- Tag: \`${release.tag}\``,
    `- Merge commit: \`${release.sha}\``,
    `- Release: ${url}`,
    '',
  ].join('\n');
}

// Who approved the release PR's last commit before it merged: each person's last say counts (a dismissal clears it),
// a bot's never. Each is named by their GitHub profile name, else their login.
async function approversOf(github, repo, release) {
  if (!release.head) return [];
  const last = new Map();
  for (const r of await github.listPullReviews(repo, release.number)) {
    const login = r && r.user && r.user.login;
    if (!login || isBot(r.user)) continue;
    const state = String(r.state || '').toUpperCase();
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') last.set(login.toLowerCase(), { login, state, commit: r.commit_id || null });
    else if (state === 'DISMISSED') last.delete(login.toLowerCase());
  }
  const out = [];
  for (const a of [...last.values()].filter((x) => x.state === 'APPROVED' && x.commit === release.head)) {
    out.push((await github.getUserName(a.login)) || a.login);
  }
  return out;
}

// One "Shipped" comment on the release PR: who approved it and which commit, the build that shipped (from the PR's
// record), the tag, the merge commit and the Release link. A comment whose first line is this tag's marker, from a
// bot or from a release account, is the one already made. Returns `created` or `exists`.
// `number` is the PR to comment on: the release PR, or (with `via`) a release PR a re-ship finished. The approval
// named is always that of `release`, the PR whose merge shipped.
async function postShippedComment({
  github, releaser, repo, release, url, automationLogins, number = release.number, via = null,
}) {
  const marker = shippedMarker(release.tag);
  const ours = (c) => c && String(c.body || '').replace(/\r\n?/g, '\n').split('\n')[0].trim() === marker
    && (isBot(c.user) || automationLogins.some((l) => l.toLowerCase() === String(c.user.login).toLowerCase()));
  if ((await github.listIssueComments(repo, number)).some(ours)) return 'exists';
  await releaser.createIssueComment(repo, number, shippedComment(release, url, await approversOf(github, repo, release), via));
  return 'created';
}

// ---------------------------------------------------------------------------
// The signal

// What the first line of a comment asks for: `/shipped`, alone.
const isShippedComment = (body) => /^\/shipped[ \t]*$/.test(String(body || '').replace(/\r\n?/g, '\n').split('\n')[0]);

const isBot = (user) => !user || user.type === 'Bot' || /\[bot\]$/i.test(user.login || '');

// A login for a tag message: GitHub's own characters only.
const loginText = (login) => String(login).replace(/[^A-Za-z0-9_[\]-]/g, '?').slice(0, 60);

module.exports = {
  attachFiles, draftOf, releaseOf, readRelease, reshipsOf, mergedPullOfPush, releaseOfPull, releaseOfPush, messageOf, digestOf, makeReleaseTag, moveFloatingMajor, makeGitHubRelease, postShippedComment, changelogSection, shippedComment, commitOfRef, isShippedComment, isBot, isReleaseBase, isReleaseHead, loginText, show, short, WRITE_ACCESS,
};
