'use strict';

// The approver ask, as pure functions: who is left to tag, the text of the ask and of its
// reminder, and the note a release PR keeps so a re-run neither asks twice nor forgets to remind.
// No network, no files. `ask-command.js` reads GitHub and Slack and hands the answers in.

const { hasSecret } = require('./record');

const REMIND_AFTER_MS = 4 * 60 * 60 * 1000;
const STATE_MARKER = 'shipyard:ask';
const STATE_PATTERN = /<!-- shipyard:ask (\{[^\n]*?\}) -->/;
const SLACK_TS = /^\d{1,12}\.\d{1,9}$/;
const SLACK_CHANNEL_ID = /^[A-Z0-9]{5,20}$/;
// A GitHub login is at most 39 characters. The approver list, `people.tag` and `--tag` are held to the
// same pattern and cap the note is read back with, so the ask never writes a note it cannot read.
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const MAX_TAGGED = 100;
// The report's headline is eight words or fewer (docs/prep-file.md); a longer one is cut, never dropped.
const SUMMARY_MAX = 400;

// ---------------------------------------------------------------------------
// Text from outside

// What Slack treats as markup is `&`, `<` and `>`: escaped, so a name can never open a link or a
// mention. One line, no control characters, no secret pattern, a length cap.
function slackText(value, max = 80) {
  let text = String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (hasSecret(text)) text = '(redacted)';
  if ([...text].length > max) text = `${[...text].slice(0, max - 1).join('')}…`;
  return text.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const mention = (id) => `<@${id}>`;

const nameList = (names) => {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

// ---------------------------------------------------------------------------
// Who to leave out

// The logins that drove every change in `driverSets` (one set of lowercase logins for each change
// that still needs an independent approval). No such change, or one nobody drove (a commit with
// no PR is an empty set), leaves nobody out.
function drovesEvery(driverSets) {
  if (!driverSets.length) return new Set();
  const [first, ...rest] = driverSets;
  return new Set([...first].filter((login) => rest.every((s) => s.has(login))));
}

// ---------------------------------------------------------------------------
// The text

/**
 * @param {object} i
 * @param {string[]} i.mentions        Slack ids to tag
 * @param {{ repo: string, tag: string, number: number, url: string, recommendation: string, summary: string, changes: number, needing: number }} i.release
 *   `summary` is the prep file's `report.headline`, the release in a few words
 * @param {string[]} i.leftOut         logins of the people who drove every change that needs an independent approval
 * @param {string[]} i.untagged        GitHub logins named (or who approved) with no entry in the approver list: named, never mentioned
 */
function askText({ mentions, release: r, leftOut, untagged }) {
  const tags = mentions.length ? `${mentions.map(mention).join(' ')} ` : '';
  const detail = `${r.changes} change${r.changes === 1 ? '' : 's'}${r.needing ? `, ${r.needing} still need${r.needing === 1 ? 's' : ''} an approval from a person who did not drive ${r.needing === 1 ? 'it' : 'them'}` : ''}`;
  const lines = [`${tags}Release ${slackText(r.tag, 40)} of ${slackText(r.repo, 80)} is ready for approval: <${r.url}|#${r.number}>. Recommendation: ${r.recommendation}. ${detail}.`];
  // The report's own words, so an approver can judge without opening the PR: escaped like a name.
  const words = slackText(r.summary, SUMMARY_MAX);
  if (words) lines.push(words);
  if (leftOut.length) lines.push(`It needs an approver other than ${nameList(leftOut.map((n) => slackText(n)))}.`);
  if (untagged.length) lines.push(`Not tagged, no entry in the approver list: ${untagged.map((n) => slackText(n)).join(', ')}.`);
  return lines.join('\n');
}

function reminderText({ mentions, release: r }) {
  const tags = mentions.length ? `${mentions.map(mention).join(' ')} ` : '';
  return `${tags}Still waiting for an approval of <${r.url}|#${r.number}> (${slackText(r.repo, 80)} ${slackText(r.tag, 40)}). It has been more than 4 hours since the ask.`;
}

// ---------------------------------------------------------------------------
// The note on a release PR

const isoDate = (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/.test(v) && !Number.isNaN(Date.parse(v));

// The state in a comment body, checked field by field, or null when there is none or any of it
// is out of shape (a comment a person edited into something else is not trusted).
function parseState(body) {
  const m = STATE_PATTERN.exec(String(body || ''));
  if (!m) return null;
  let s;
  try {
    s = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!s || typeof s !== 'object' || s.v !== 1) return null;
  if (typeof s.channel !== 'string' || !SLACK_CHANNEL_ID.test(s.channel)) return null;
  if (typeof s.asked !== 'string' || !s.asked || s.asked.length > 100) return null;
  if (typeof s.ts !== 'string' || !SLACK_TS.test(s.ts)) return null;
  if (!isoDate(s.sentAt)) return null;
  if (s.remindedAt !== null && !isoDate(s.remindedAt)) return null;
  // The logins the ask tagged, never their Slack ids: the reminder looks the ids up in the approver list again.
  if (!Array.isArray(s.tagged) || s.tagged.length > MAX_TAGGED || s.tagged.some((l) => typeof l !== 'string' || !LOGIN.test(l))) return null;
  return {
    v: 1, channel: s.channel, asked: s.asked, ts: s.ts, sentAt: s.sentAt, remindedAt: s.remindedAt, tagged: [...s.tagged],
  };
}

// The comment: a line for people, then the state where only a machine reads it (the channel, the
// thread, the times and the logins tagged: no Slack user id goes into a comment). `>` is escaped so
// nothing in the state can close the comment early.
function stateComment(state) {
  const seen = state.remindedAt
    ? `Asked the approvers in Slack at ${state.sentAt}, and reminded them at ${state.remindedAt}.`
    : `Asked the approvers in Slack at ${state.sentAt}. One reminder follows in the thread, from the start watch, after 4 hours with no approval.`;
  const json = JSON.stringify({ v: 1, ...state }).replace(/>/g, '\\u003e');
  return `${seen}\n\n<!-- ${STATE_MARKER} ${json} -->\n`;
}

const reminderDueAt = (state) => new Date(Date.parse(state.sentAt) + REMIND_AFTER_MS);

module.exports = {
  REMIND_AFTER_MS, LOGIN, MAX_TAGGED, slackText, drovesEvery, askText, reminderText, parseState, stateComment, reminderDueAt,
};
