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
// `report.ask` is 70 words at most (lib/lint-prep.js); the cap here only keeps a prep file no lint read from posting a wall of text.
const ASK_MAX = 800;

// ---------------------------------------------------------------------------
// Text from outside

// A text from outside as one line: no control characters, no secret pattern, a length cap. The blocks use it as it is.
function cleanText(value, max = 80) {
  let text = String(value === undefined || value === null ? '' : value).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (hasSecret(text)) text = '(redacted)';
  if ([...text].length > max) text = `${[...text].slice(0, max - 1).join('')}…`;
  return text;
}
// What Slack treats as markup in `text` is `&`, `<` and `>`: escaped, so a name can never open a link or a mention.
function slackText(value, max = 80) {
  return cleanText(value, max).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}

const mention = (id) => `<@${id}>`;

// Slack turns a bare domain in the `text` of a message (`guardrails.turbot.com`) into a link, and a product can be named that way.
// What people read is the `blocks` (`askPost`), where a `text` element is never linked: only a `link` element is. This `text` is the
// fallback of a notification, and a zero-width space after each dot of the name keeps it plain there too. (Escaped like any name.)
const plainName = (value, max) => slackText(value, max).replace(/\.(?=[A-Za-z0-9])/g, '.\u200b');

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

// The checks sentence, from the count the release PR's own page gives. It says "all" only of a count that is all of them, or
// all of those that apply: a check skipped by design (the page's `✅ 37 of 38 passed ... skipped`) is counted out, said once and
// given the page's own reason. A check still running, a partial count the page does not call skips or no count at all gets the
// sentence that claims nothing. `esc` is how the reason from outside is cleaned for where it goes.
const WHERE = 'on the build that goes live, and the evidence is linked in the PR.';
const NOT_PASSED = 'Not every check has passed yet, and the PR has the details.';
const SKIP_REASON_MAX = 200;
function checksSentence(checks, esc = cleanText) {
  if (!checks || checks.state !== 'pass' || !(checks.total > 0)) return NOT_PASSED;
  if (checks.passed === checks.total) return checks.total === 1 ? `The check passed ${WHERE}` : `All ${checks.total} checks passed ${WHERE}`;
  const skipped = checks.skipped;
  if (!(checks.passed > 0) || !Number.isInteger(skipped) || skipped !== checks.total - checks.passed) return NOT_PASSED;
  const applied = checks.passed === 1 ? `The 1 check that applies passed ${WHERE}` : `All ${checks.passed} checks that apply passed ${WHERE}`;
  const reason = skipped === 1 && checks.skipReason ? esc(String(checks.skipReason).replace(/[.\s]+$/, ''), SKIP_REASON_MAX) : '';
  const skip = skipped === 1 ? '1 was skipped' : `${skipped} were skipped`;
  return `${applied} ${reason ? `${skip}: ${reason}.` : `${skip}, and the PR says why.`}`;
}

// The sentence about PRs that merged past a reviewer's call for a person, when the release holds any: how many, and where they
// are listed. Nothing for none, or for a count that is not a whole number above zero.
function gatedSentence(count) {
  if (!Number.isInteger(count) || count < 1) return '';
  return count === 1
    ? "1 PR in this release merged past a reviewer's call for a person to look at it: it is listed at the top of the PR, so read it before you approve."
    : `${count} PRs in this release merged past a reviewer's call for a person to look at them: they are listed at the top of the PR, so read them before you approve.`;
}

// A link for Slack: only `&`, `<` and `>` are markup, and the release PR's address holds none of the last two.
const slackUrl = (url) => String(url).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

/**
 * The ask, as a person would write it, in three blocks: a greeting with the tags and the release PR's link (a bare address, which
 * Slack does not unfurl: `slack.js` posts with unfurling off), the release
 * manager's one paragraph (`report.ask`) with the checks sentence, and thanks. The page of the release PR keeps the
 * headline, the changes and the answer to "could it break anything?": the ask carries none of them.
 *
 * Returns what `postMessage` takes: `blocks` is what Slack shows, one `rich_text` block, and `text` the same words as the fallback of a
 * notification. In the blocks a name, the paragraph and the notes are `text` elements, which Slack shows as typed and never reads
 * as a link or a mention, so a product named `guardrails.turbot.com` stays plain; the tags are `user` elements and the PR's address
 * is a `link` element.
 *
 * @param {object} i
 * @param {string[]} i.mentions        Slack ids to tag
 * @param {{ product: string, tag: string, url: string, ask: string, gated?: number, checks: ({ state: 'pass', passed: number, total: number, skipped?: number, skipReason?: string } | { state: 'open' } | null) }} i.release
 *   `ask` is the prep file's `report.ask`
 * @param {string[]} i.leftOut         names (profile names, else logins) of the people who drove every change that needs an independent approval
 * @param {string[]} i.untagged        names (profile names, else logins) of people named (or who approved) with no entry in the approver list: named, never mentioned
 * @returns {{ text: string, blocks: object[] }}
 */
function askPost({ mentions, release: r, leftOut, untagged }) {
  const who = mentions.length === 1 ? 'you' : 'one of you';
  // The words of the ask, once, with each piece from outside passed through `esc`: the text sent for a notification escapes it,
  // the blocks do not (no element of them is read as markup).
  const words = (esc, name) => {
    const ending = `please approve ${name(r.product, 80)} ${esc(r.tag, 40)}?`;
    return {
      // What follows the tags (or is the whole greeting, with nobody to tag).
      greeting: mentions.length === 0 ? `Hi, can someone ${ending}` : `, can ${who} ${ending}`,
      body: [esc(r.ask, ASK_MAX), checksSentence(r.checks, esc), gatedSentence(r.gated)].filter(Boolean).join(' '),
      notes: [
        ...(leftOut.length ? [`It needs an approver other than ${nameList(leftOut.map((n) => esc(n)))}, who asked for these changes.`] : []),
        ...(untagged.length ? [`Not tagged, no entry in the approver list: ${untagged.map((n) => esc(n)).join(', ')}.`] : []),
      ],
    };
  };

  const e = words(slackText, plainName);
  const hello = mentions.length === 0 ? e.greeting : `Hi ${mentions.map(mention).join(' ')}${e.greeting}`;
  const text = [[hello, `\u2022 ${slackUrl(r.url)}`], [e.body], e.notes, ['Thanks!']].filter((p) => p.length).map((p) => p.join('\n')).join('\n\n');

  const t = (value) => ({ type: 'text', text: value });
  const p = words(cleanText, cleanText);
  const greeting = mentions.length === 0
    ? [t(p.greeting)]
    : [t('Hi '), ...mentions.flatMap((id, i) => [...(i ? [t(' ')] : []), { type: 'user', user_id: String(id) }]), t(p.greeting)];
  // A blank line is "\n" at the start of the section after the list, which has no line end of its own.
  const rest = ['\n', p.body, '\n\n', ...(p.notes.length ? [p.notes.join('\n'), '\n\n'] : []), 'Thanks!'].join('');
  const blocks = [{
    type: 'rich_text',
    elements: [
      { type: 'rich_text_section', elements: [...greeting, t('\n')] },
      { type: 'rich_text_list', style: 'bullet', elements: [{ type: 'rich_text_section', elements: [{ type: 'link', url: String(r.url) }] }] },
      { type: 'rich_text_section', elements: [t(rest)] },
    ],
  }];
  return { text, blocks };
}

// The text of the ask alone: the fallback `askPost` sends with its blocks.
const askText = (input) => askPost(input).text;

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
  LOGIN, MAX_TAGGED, slackText, drovesEvery, askText, askPost, parseState, stateComment,
};
