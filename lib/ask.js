'use strict';

// The approver ask, as pure functions: who is left to tag, the text of the ask, and the note a
// release PR keeps so a re-run never asks twice.
// No network, no files. `ask-command.js` reads GitHub and Slack and hands the answers in.

const { hasSecret } = require('./record');

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

// The bullets are capped at the page's own limit (the prep file holds five change rows at most).
const BULLETS_MAX = 5;
const BULLET_MAX = 300;

// A sentence: its first letter a capital, and a full stop unless it ends in one already.
const asSentence = (text) => {
  const t = text.replace(/^./u, (c) => c.toUpperCase());
  return /[.!?)]$/.test(t) ? t : `${t}.`;
};

// The checks line, from the count the release PR's own page gives. A page that says anything but "N of M passed" (a check still
// running or not passed) gets no count of its own: the ask does not say more than the page does.
function checksLine(checks) {
  if (!checks) return '';
  if (checks.state !== 'pass') return 'Not every check has passed yet: the PR has the details.';
  const { passed, total } = checks;
  const where = 'on the build that goes live, and the evidence is in the PR.';
  if (passed === total) return total === 1 ? `The check passed ${where}` : `All ${total} checks passed ${where}`;
  return `${passed} of ${total} checks passed ${where}`;
}

/**
 * The ask, as a person would write it: a greeting with the tags, the release and its PR, what changes in the prep file's
 * own words, whether the checks passed, could it break anything, and thanks.
 *
 * @param {object} i
 * @param {string[]} i.mentions        Slack ids to tag
 * @param {{ product: string, tag: string, number: number, url: string, headline: string, changes: { kind: string, after: string }[], internal: number, checks: ({ state: 'pass', passed: number, total: number } | { state: 'open' } | null), safety: string }} i.release
 *   `headline` and `safety` are the prep file's `report.headline` and `report.safety.answer`; each of `changes` is a row of
 *   `report.changes` as the page shows it, its kind (New, Changed, Fixed, Removed or Security) and its `after`; `internal` is
 *   the number of changes no user sees
 * @param {string[]} i.leftOut         names (profile names, else logins) of the people who drove every change that needs an independent approval
 * @param {string[]} i.untagged        names (profile names, else logins) of people named (or who approved) with no entry in the approver list: named, never mentioned
 */
function askText({ mentions, release: r, leftOut, untagged }) {
  const name = `${slackText(r.product, 80)} ${slackText(r.tag, 40)}`;
  const greeting = mentions.length === 0
    ? `Hi, can someone please do the SOC2 approval for ${name}?`
    : `Hi ${mentions.map(mention).join(' ')}, can ${mentions.length === 1 ? 'you' : 'one of you'} please do the SOC2 approval for ${name}?`;
  const head = [greeting, `\u2022 <${r.url}|${slackText(`Release ${r.tag} (#${r.number})`, 120)}>`];

  // What changes: the report's own words, so an approver can judge without opening the PR, each escaped like a name.
  const what = [];
  const words = slackText(r.headline, SUMMARY_MAX);
  if (words) what.push(asSentence(words));
  if (r.changes.length) {
    for (const c of r.changes.slice(0, BULLETS_MAX)) what.push(`\u2022 ${slackText(c.kind, 20)}: ${slackText(c.after, BULLET_MAX)}`);
  } else {
    what.push(`Nothing users see changes${r.internal ? `: ${r.internal} internal change${r.internal === 1 ? '' : 's'}` : ''}.`);
  }

  const safe = [checksLine(r.checks)];
  const safety = slackText(r.safety, SUMMARY_MAX);
  if (safety) safe.push(`Could it break anything? ${asSentence(safety)}`);

  const notes = [];
  if (leftOut.length) notes.push(`It needs an approver other than ${nameList(leftOut.map((n) => slackText(n)))}, who asked for these changes.`);
  if (untagged.length) notes.push(`Not tagged, no entry in the approver list: ${untagged.map((n) => slackText(n)).join(', ')}.`);

  return [head, what, safe.filter(Boolean), notes, ['Thanks!']].filter((p) => p.length).map((p) => p.join('\n')).join('\n\n');
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
  // The logins the ask tagged, never their Slack ids. A note written before the reminder was dropped
  // also has `remindedAt`. Nothing reads it, so it is neither checked nor kept: the note still reads,
  // and the ask is still never sent twice.
  if (!Array.isArray(s.tagged) || s.tagged.length > MAX_TAGGED || s.tagged.some((l) => typeof l !== 'string' || !LOGIN.test(l))) return null;
  return {
    v: 1, channel: s.channel, asked: s.asked, ts: s.ts, sentAt: s.sentAt, tagged: [...s.tagged],
  };
}

// The comment: a line for people, then the state where only a machine reads it (the channel, the
// thread, the times and the logins tagged: no Slack user id goes into a comment). `>` is escaped so
// nothing in the state can close the comment early.
function stateComment(state) {
  const seen = `Asked the approvers in Slack at ${state.sentAt}.`;
  const json = JSON.stringify({ v: 1, ...state }).replace(/>/g, '\\u003e');
  return `${seen}\n\n<!-- ${STATE_MARKER} ${json} -->\n`;
}

module.exports = {
  LOGIN, MAX_TAGGED, slackText, drovesEvery, askText, parseState, stateComment,
};
