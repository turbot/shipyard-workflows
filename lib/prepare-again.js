'use strict';

// `/prepare-again`: an area approver's request, on an open release PR, for a new prep of the same release at the same commit.
// The one parser of the command and of the request marker, which the comment job (lib/comment-command.js), the request
// (lib/prepare-again-command.js), the cut and the record read; and the words of the replies the request posts.
//
// The command is the comment's first line, trimmed, equal to `/prepare-again` ignoring case. Anything after the first line is
// ignored, and `/prepare-again now` is not the command.
//
// An accepted request is answered with one comment, written with the job's own token (so by `github-actions[bot]`, type `Bot`),
// that carries the marker:
//
//   <!-- shipyard:prepare-again {"request":<comment id>,"by":"<login>","job":<issue number>,"head":"<40 hex>","tag":"<tag>"} -->
//
// A marker is read only from a comment of that account, and only when every field holds what it must: a person's comment that
// copies it, or a marker edited out of shape, is not read. The comment's own text is never passed on.

const { trailerValues, CUT_LIMIT } = require('./release-data');

const COMMAND = '/prepare-again';
// The trailer the cut's prepared-again commit carries, naming the request (the comment id) it applied.
const TRAILER = 'Release-Prepared-Again';
const BOT_LOGIN = 'github-actions[bot]';
const MARKER = /^<!-- shipyard:prepare-again (\{[^\n]*\}) -->$/gm;
const KEYS = Object.freeze(['request', 'by', 'job', 'head', 'tag']);
const SHA = /^[0-9a-f]{40}$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const positive = (v) => Number.isSafeInteger(v) && v > 0;

/** True when the comment's first line, trimmed, is `/prepare-again`, ignoring case. */
function isPrepareAgainComment(body) {
  const first = String(body ?? '').replace(/\r\n?/g, '\n').split('\n')[0].trim();
  return first.toLowerCase() === COMMAND;
}

// The problem with a marker's fields, or null when each holds what it must.
function fieldProblem(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return 'is not an object';
  const keys = Object.keys(d).sort();
  if (keys.length !== KEYS.length || !KEYS.every((k) => keys.includes(k))) return `must hold exactly ${KEYS.join(', ')}`;
  if (!positive(d.request)) return 'request must be the comment id, a positive whole number';
  if (typeof d.by !== 'string' || !LOGIN.test(d.by)) return 'by must be a person\'s login';
  if (!positive(d.job)) return 'job must be the prep job\'s issue number, a positive whole number';
  if (typeof d.head !== 'string' || !SHA.test(d.head)) return 'head must be a full 40-character commit';
  if (typeof d.tag !== 'string' || !TAG.test(d.tag)) return 'tag must be a release tag';
  return null;
}

/**
 * The marker line of an accepted request. Throws on a field that does not hold what it must: the request only writes one
 * it can read back.
 * @param {{request: number, by: string, job: number, head: string, tag: string}} m
 */
function requestMarker({
  request, by, job, head, tag,
}) {
  const data = {
    request, by, job, head, tag,
  };
  const problem = fieldProblem(data);
  if (problem) throw new Error(`a prepare-again marker's ${problem}`);
  return `<!-- shipyard:prepare-again ${JSON.stringify(data)} -->`;
}

// The one marker a comment's body holds, or null: none, two, or one whose fields are not all right.
function markerOf(body) {
  const found = [...String(body ?? '').replace(/\r\n?/g, '\n').matchAll(MARKER)];
  if (found.length !== 1) return null;
  let d;
  try {
    d = JSON.parse(found[0][1]);
  } catch {
    return null;
  }
  return fieldProblem(d) ? null : {
    request: d.request, by: d.by, job: d.job, head: d.head, tag: d.tag,
  };
}

const byActions = (c) => Boolean(c && c.user && c.user.login === BOT_LOGIN && c.user.type === 'Bot');

/**
 * The request markers of a PR's comments, oldest first: only those on a comment of `github-actions[bot]` (type `Bot`), each
 * with every field checked. Each carries the id of the comment it is on (`comment`) and its time (`at`, or null).
 * @param {object[]} comments  the PR's comments as `listIssueComments` gives them
 * @returns {{request: number, by: string, job: number, head: string, tag: string, comment: number|null, at: string|null}[]}
 */
function parseRequestMarkers(comments) {
  const out = [];
  for (const c of Array.isArray(comments) ? comments : []) {
    if (!byActions(c)) continue;
    const m = markerOf(c.body);
    if (!m) continue;
    out.push({ ...m, comment: positive(c.id) ? c.id : null, at: typeof c.created_at === 'string' ? c.created_at : null });
  }
  return out;
}

/**
 * The requests the PR's own commits say were applied: each `Release-Prepared-Again: <comment id>` trailer on the first-parent line
 * from `headSha` down to the release's first cut commit (`chore(release): <tag>` with no such trailer), at most `limit` commits.
 * `getCommit(sha)` is async and returns `{ message, parents }` (lib/release-data.js `commitsFromGit` or `commitsFromGitHub`).
 * @returns {Promise<Set<number>>}
 */
async function appliedRequests({
  headSha, tag, getCommit, limit = CUT_LIMIT,
}) {
  const subject = `chore(release): ${tag}`;
  const found = new Set();
  let sha = headSha;
  for (let n = 0; sha && n < limit; n += 1) {
    const c = await getCommit(sha);
    const message = String((c && c.message) || '');
    const values = trailerValues(message, TRAILER);
    for (const v of values) if (/^[1-9][0-9]{0,15}$/.test(v)) found.add(Number(v));
    if (message.split('\n')[0].trim() === subject && !values.length) break;
    sha = c && Array.isArray(c.parents) && c.parents.length ? c.parents[0] : null;
  }
  return found;
}

// A value of the PR or the comment, quoted and cut short, for a reply: one line, never markdown that pings or links.
const shown = (value, max = 60) => {
  const text = String(value ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/[@`<>]/g, '?');
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

/**
 * The reply to an accepted request, ending in its marker.
 * @param {{request: number, by: string, job: number, head: string, tag: string}} m
 */
function acceptedReply(m) {
  const marker = requestMarker(m);
  return [
    `Prepare again: the request from ${shown(m.by, 40)} (comment ${m.request}) is accepted. Prep job #${m.job} makes a new report of ${m.tag} at ${m.head.slice(0, 7)}.`,
    '',
    `When it is done, its report replaces this one on this PR, for the same version: no new PR, no new cut and no new staging run. The PR then has a new head, so any approval given before that no longer counts: approve again once the new report is on the page. A new prep at another level is refused; to change the level, an area approver writes \`/level <level>\` on this PR.`,
    '',
    marker,
    '',
  ].join('\n');
}

/** The reply to a refused request: it says why, and that nothing was filed. */
function refusedReply(reason) {
  return [
    `Prepare again: the request is refused, and nothing was filed: ${String(reason).replace(/[\r\n]+/g, ' ').replace(/[.\s]+$/, '')}.`,
    '',
  ].join('\n');
}

// The record's prepared-again mode (lib/record-command.js) answers each request once more, after the cut: the new page is on the
// PR, or the cut refused the new prep. Its reply's first line is this marker, so a run of the mode again finds its own reply (a
// comment of the repo's Actions) and edits it rather than adding a second.
const pageMarker = (request) => `<!-- shipyard:prepared-again ${Number(request)} -->`;

// Who asked, for a reply: the login the accepted reply's marker names, shown with no `@` (a reply never pings), or the comment.
const askedBy = (request, by) => (by ? `the request from ${shown(by, 40)} (comment ${request})` : `request ${request}`);

/**
 * The reply once the record has put the new page on the PR: the new report is on the page at the new head, an approval given before
 * it no longer counts, and the approver reads the page and approves again.
 * @param {{request: number, by: string|null, sha: string, tag: string, recommendation: string}} r
 */
function pageReply({
  request, by, sha, tag, recommendation,
}) {
  return [
    pageMarker(request),
    `Prepare again: the new report of ${shown(tag, 100)} is on the page at ${String(sha).slice(0, 7)}, for ${askedBy(request, by)}, and the record there says ${recommendation === 'SHIP' ? 'SHIP' : 'HOLD'}. Approvals given before it no longer count: the approver reads the new page and approves again.`,
    '',
  ].join('\n');
}

/**
 * The reply when the cut refused the new prep (another level, or a head the report cannot be made again on): the cut's own message,
 * quoted, which names `/level` for a level change. Nothing on the PR changed.
 * @param {{request: number, by: string|null, message: string}} r
 */
function cutRefusedReply({ request, by, message }) {
  const quoted = String(message ?? '').replace(/[\p{Cc}\p{Zl}\p{Zp}]+/gu, ' ').replace(/@/g, '@​').trim().slice(0, 1000);
  return [
    pageMarker(request),
    `Prepare again: the cut refused the new prep for ${askedBy(request, by)}, so the report on this PR is unchanged. The cut said:`,
    '',
    `> ${quoted}`,
    '',
  ].join('\n');
}

module.exports = {
  COMMAND, BOT_LOGIN, TRAILER, isPrepareAgainComment, requestMarker, parseRequestMarkers, appliedRequests, acceptedReply, refusedReply, shown,
  pageMarker, pageReply, cutRefusedReply,
};
