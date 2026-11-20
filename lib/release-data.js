'use strict';

// The release data: the facts, the prep file, the release notes and the re-ships of a release, carried
// in the release PR's body instead of under `releases/<tag>/`. The cut puts one hidden block at the end
// of the body it writes, the gzip of the payload's JSON text in base64:
//
//   <!-- shipyard:release-data
//   H4sIAAAAAAAAA...
//   -->
//
// A body can be edited by anyone with write access, and an edit dismisses no approval, so the cut
// commit pins the block: its `Release-Data: sha256:<hex>` trailer is the SHA-256 of the JSON text, and
// every reader checks the block against the cut commit it finds from the PR's head. A release cut
// before this change has neither, and is read from `releases/<tag>/` as before.
//
// Every step after the cut (record, ask, release check, tag, announce, re-ship) reads the release
// data through this file; none parses the block itself.

const crypto = require('node:crypto');
const zlib = require('node:zlib');
const { Refusal, ReleaseError, git } = require('./release-git');
const { upgradePrep } = require('./prep-format');

const FORMAT = 1;
const DATA_TRAILER = 'Release-Data';
const BLOCK_START = '<!-- shipyard:release-data';
const BLOCK_END = '-->';
// The most the block may hold, so the body stays well inside GitHub's limit with the record beside it.
const MAX_BLOCK = 32768;
// GitHub's limit on a PR body.
const MAX_BODY = 65536;
// The most the gzip may grow to when read: a body edited after the cut cannot make a reader run out of memory.
const MAX_JSON = 8 * 1024 * 1024;
// How far from the PR's head the cut commit may be.
const CUT_LIMIT = 50;
const LINE = 76;

const SHA = /^[0-9a-f]{40}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROFILES = new Set(['full', 'light']);
const FOLDER_FILES = ['facts.json', 'prep.json', 'release-notes.md'];

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const digestOf = (json) => `sha256:${crypto.createHash('sha256').update(json, 'utf8').digest('hex')}`;
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// What is wrong with a payload, or null. A re-ship entry has the fields `reshipFile` writes, less
// `format`, `tag` and `version`, checked as `parseReshipFile` checks them.
function payloadProblem(p) {
  if (!isObject(p)) return 'it is not an object';
  if (p.format !== FORMAT) return `its format is ${JSON.stringify(p.format)}, not ${FORMAT}`;
  if (typeof p.tag !== 'string' || !p.tag.trim()) return 'it has no tag';
  if (!PROFILES.has(p.profile)) return `its profile is ${JSON.stringify(p.profile)}, not full or light`;
  if (!isObject(p.facts)) return 'its facts are not an object';
  if (p.prep !== null && !isObject(p.prep)) return 'its prep is neither an object nor null';
  if (p.notes !== null && typeof p.notes !== 'string') return 'its notes are neither text nor null';
  if (!Array.isArray(p.reships)) return 'its re-ships are not a list';
  const bad = p.reships.findIndex((r) => !isObject(r) || !Number.isSafeInteger(r.releasePr) || r.releasePr < 1
    || !SHA.test(String(r.mergeCommit)) || !isObject(r.failedRun) || !Number.isSafeInteger(r.failedRun.id) || r.failedRun.id < 1);
  if (bad !== -1) return `its re-ship ${bad + 1} is not one \`shipyard cut --reship\` wrote`;
  return null;
}

/**
 * The block a cut puts in the release PR's body, the digest its commit's `Release-Data` trailer
 * carries, and the JSON text both are made from. A ReleaseError for a payload of the wrong shape.
 *
 * @returns {{ block: string, digest: string, json: string, length: number }}
 */
function encodeReleaseData(payload) {
  const problem = payloadProblem(payload);
  if (problem) throw new ReleaseError(`the release data cannot be written: ${problem}`);
  const json = JSON.stringify(payload);
  const base64 = zlib.gzipSync(Buffer.from(json, 'utf8'), { level: 9 }).toString('base64');
  const lines = [];
  for (let i = 0; i < base64.length; i += LINE) lines.push(base64.slice(i, i + LINE));
  const block = [BLOCK_START, ...lines, BLOCK_END].join('\n');
  return {
    block, digest: digestOf(json), json, length: block.length,
  };
}

// The cut's refusal for a block too large for a release PR's body, naming how many PRs the range holds.
function checkBlockSize(block, prCount) {
  const length = String(block).length;
  if (length <= MAX_BLOCK) return length;
  const prs = Number.isSafeInteger(prCount) ? `the range holds ${prCount} PR${prCount === 1 ? '' : 's'}, ` : '';
  throw new Refusal(`the release data is ${length} characters, over the ${MAX_BLOCK} a release PR's body can carry: ${prs}cut from an earlier commit so the release holds fewer`);
}

// Each block's span in a body: from its start to the end that follows it, or to the body's end.
function blockSpans(body) {
  const text = String(body ?? '');
  const spans = [];
  let at = text.indexOf(BLOCK_START);
  while (at !== -1) {
    const close = text.indexOf(BLOCK_END, at + BLOCK_START.length);
    const end = close === -1 ? text.length : close + BLOCK_END.length;
    spans.push({ start: at, end, closed: close !== -1 });
    at = text.indexOf(BLOCK_START, end);
  }
  return spans;
}

/**
 * The body with `block` as its last part, in place of any block already there. The body's first line,
 * `<!-- shipyard:release-pr <tag> -->`, stays first.
 */
function withReleaseData(body, block) {
  let text = String(body ?? '');
  for (const s of blockSpans(text).reverse()) text = text.slice(0, s.start) + text.slice(s.end);
  text = text.replace(/\s+$/, '');
  return text ? `${text}\n\n${block}\n` : `${block}\n`;
}

/**
 * The release data a body carries: null when it has no block, else the JSON text, the payload and the
 * digest of the JSON text. Whitespace inside the base64 (a `\r` a browser's editor added) is ignored.
 * Two blocks, or a block that is not base64, gzip, JSON or a payload, is a ReleaseError naming which.
 *
 * @returns {{ json: string, payload: object, digest: string } | null}
 */
function findReleaseData(body) {
  const spans = blockSpans(body);
  if (!spans.length) return null;
  if (spans.length > 1) throw new ReleaseError(`the body holds ${spans.length} release-data blocks, not one`);
  const [s] = spans;
  if (!s.closed) throw new ReleaseError('the release-data block in the body has no end');
  const inner = String(body).slice(s.start + BLOCK_START.length, s.end - BLOCK_END.length);
  const base64 = inner.replace(/\s+/g, '');
  if (!base64 || base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) {
    throw new ReleaseError('the release-data block in the body is not base64');
  }
  let json;
  try {
    json = zlib.gunzipSync(Buffer.from(base64, 'base64'), { maxOutputLength: MAX_JSON }).toString('utf8');
  } catch {
    throw new ReleaseError('the release-data block in the body is not gzip, or is larger than a release holds');
  }
  let payload;
  try {
    payload = JSON.parse(json);
  } catch {
    throw new ReleaseError('the release-data block in the body is not JSON');
  }
  const problem = payloadProblem(payload);
  if (problem) throw new ReleaseError(`the release-data block in the body is not release data: ${problem}`);
  return { json, payload, digest: digestOf(json) };
}

// Every value of the trailer `name` in a commit message, in order. A trailer is a whole line, `Name: value`.
function trailerValues(message, name) {
  const re = new RegExp(`^${escapeRegExp(name)}:[ \\t]*(.*?)[ \\t]*\\r?$`, 'gm');
  return [...String(message ?? '').matchAll(re)].map((m) => m[1]);
}

// The `Release-Data` trailer's `sha256:<hex>`, or null when the message has none, or more than one, or
// one that is not a digest.
function dataTrailerOf(message) {
  const values = trailerValues(message, DATA_TRAILER);
  return values.length === 1 && DIGEST.test(values[0]) ? values[0] : null;
}

/**
 * The cut commit of `tag`: the first commit on the first-parent line from `headSha`, at most `limit`
 * commits, whose subject is `chore(release): <tag>` (a re-ship commit has the same subject and is
 * reached before the cut it re-ships). `getCommit(sha)` is async and returns `{ message, parents }`,
 * so a caller passes git (`commitsFromGit`) or GitHub (`commitsFromGitHub`).
 *
 * @returns {Promise<{ sha: string, message: string } | null>}
 */
async function findCutCommit({
  headSha, tag, getCommit, limit = CUT_LIMIT,
}) {
  const subject = `chore(release): ${tag}`;
  let sha = headSha;
  for (let n = 0; sha && n < limit; n += 1) {
    const c = await getCommit(sha);
    const message = String((c && c.message) || '');
    if (message.split('\n')[0].trim() === subject) return { sha, message };
    sha = c && Array.isArray(c.parents) && c.parents.length ? c.parents[0] : null;
  }
  return null;
}

// A commit as `findCutCommit` reads it, from a checkout.
function commitsFromGit(dir) {
  return async (sha) => {
    const out = git(dir, ['log', '-1', '--format=%P%x00%B', sha]);
    const at = out.indexOf('\0');
    return { parents: out.slice(0, at).trim().split(' ').filter(Boolean), message: out.slice(at + 1) };
  };
}

// A commit as `findCutCommit` reads it, from GitHub.
function commitsFromGitHub(github, repo) {
  return (sha) => github.getCommit(repo, sha);
}

// The cut commit and the payload it pins, or `payload: null` for a release cut before this change.
async function verifiedReleaseData({
  body, tag, headSha, getCommit, prNumber,
}) {
  const refuse = (why) => new Refusal(`the release data in #${prNumber}'s body does not match its cut commit (${why}): cut the release again`);
  const cut = await findCutCommit({ headSha, tag, getCommit });
  if (!cut) throw new Refusal(`#${prNumber} has no cut commit, chore(release): ${tag}, in the ${CUT_LIMIT} commits below its head ${String(headSha).slice(0, 7)}: cut the release again`);
  let found;
  try {
    found = findReleaseData(body);
  } catch (e) {
    if (e instanceof ReleaseError) throw refuse(e.message);
    throw e;
  }
  const lines = trailerValues(cut.message, DATA_TRAILER);
  const trailer = dataTrailerOf(cut.message);
  if (!found && !lines.length) return { payload: null, cut };
  if (lines.length && !trailer) throw refuse(`its ${DATA_TRAILER} trailer is not one sha256 digest`);
  if (!found) throw refuse(`the cut commit names release data and the body has no release-data block`);
  if (!trailer) throw refuse(`the body has a release-data block and the cut commit has no ${DATA_TRAILER} trailer`);
  if (found.digest !== trailer) throw refuse(`the block's digest is ${found.digest}, the cut commit names ${trailer}`);
  if (found.payload.tag !== tag) throw refuse(`the block is for ${found.payload.tag}, not ${tag}`);
  return { payload: found.payload, cut };
}

/**
 * The release data of the PR `#prNumber` for `tag`, checked against its cut commit (decision 2):
 * `{ payload, cut }`, or null for a release cut before this change (no block and no trailer). A Refusal
 * naming the PR when the body and the cut commit disagree, or no cut commit is found.
 */
async function readReleaseData(args) {
  const { payload, cut } = await verifiedReleaseData(args);
  return payload ? { payload, cut } : null;
}

/**
 * What a reader needs of a release, wherever it is: from the body's block (`source: 'body'`) or, for a
 * release cut before this change, from `releases/<tag>/` (`source: 'folder'`), read through
 * `readFolderFile(name)` (async, the file's text or null). A format-2 prep comes back as format 3, upgraded
 * after the digest check (lib/prep-format.js). A missing file is null: each caller refuses
 * in its own words. A folder release's re-ships are null, read from its re-ship files by the caller.
 *
 * @returns {Promise<{ source, profile, facts, prep, notes, reships, cut }>}
 */
async function readReleaseInputs({
  body, tag, headSha, getCommit, prNumber, readFolderFile,
}) {
  const { payload, cut } = await verifiedReleaseData({
    body, tag, headSha, getCommit, prNumber,
  });
  if (payload) {
    return {
      source: 'body', profile: payload.profile, facts: payload.facts, prep: upgradePrep(payload.prep), notes: payload.notes, reships: payload.reships, cut,
    };
  }
  const [factsText, prepText, notes] = await Promise.all(FOLDER_FILES.map((name) => readFolderFile(name)));
  const parsed = (text, name) => {
    if (text === null || text === undefined) return null;
    try {
      return JSON.parse(text);
    } catch {
      throw new ReleaseError(`releases/${tag}/${name} is not valid JSON`);
    }
  };
  return {
    source: 'folder',
    profile: null,
    facts: parsed(factsText, FOLDER_FILES[0]),
    prep: upgradePrep(parsed(prepText, FOLDER_FILES[1])),
    notes: notes === null || notes === undefined ? null : String(notes),
    reships: null,
    cut,
  };
}

module.exports = {
  FORMAT, DATA_TRAILER, BLOCK_START, MAX_BLOCK, MAX_BODY, CUT_LIMIT,
  encodeReleaseData, checkBlockSize, withReleaseData, findReleaseData, trailerValues, dataTrailerOf,
  findCutCommit, commitsFromGit, commitsFromGitHub, readReleaseData, readReleaseInputs, payloadProblem,
};
