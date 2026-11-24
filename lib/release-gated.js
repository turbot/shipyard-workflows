'use strict';

// PRs the fleet merged into the work branch past a reviewer's call for a person (the repo runs the fleet with
// `--release-gated develop`). The fleet's side marks such a PR with the label `agent:release-gated` and, in a comment
// on it, `<!-- agent-fleet release-gated: <kind> -->`. A release holds them for its approver, who must read them
// before approving, so the release PR's page lists them above everything else. Either one lists a PR, whoever added it:
// each only adds a warning for the approver. This reads only the label and the marker, never the fleet's own data. Pure
// but for `readGated`, which reads the PRs' comments through the client it is given.

const { clean } = require('./clean');

const LABEL = 'agent:release-gated';
const GATED_START = '<!-- shipyard:gated:start -->';
const GATED_END = '<!-- shipyard:gated:end -->';
const MARKER = /<!-- agent-fleet release-gated:([^>\n]*?)-->/g;
// What a kind may be: a short word or two (`security`). Anything else, or no marker, reads "a person".
const KIND = /^[A-Za-z0-9][A-Za-z0-9 _./-]{0,38}$/;
const PERSON = 'a person';
const HEADING = "## Read before approving: merged past a reviewer's call for a person";

const hasLabel = (pull) => Array.isArray(pull && pull.labels) && pull.labels.some((l) => l && l.name === LABEL);

// The kind in the newest marker of the comments, as written (trimmed), or null when no comment has the marker.
function markerOf(comments) {
  let found = null;
  for (const c of Array.isArray(comments) ? comments : []) {
    for (const m of String((c && c.body) || '').matchAll(MARKER)) found = m[1].trim();
  }
  return found;
}

// The kind in the newest comment that has the marker, or "a person" when none does (or the kind is not a plain word).
function kindOf(comments) {
  const found = markerOf(comments);
  return found && KIND.test(found) ? found.replace(/\s+/g, ' ') : PERSON;
}

/**
 * The PRs of the range that carry the label or the marker, as `[{ number, title, url, kind }]`, in the range's order.
 * `pulls` maps a PR number to the PR as GitHub holds it now (the labels are read from it). Every PR's comments are read,
 * since the marker alone lists a PR. A failed read is the caller's failure: a list that may be short is never used.
 */
async function readGated({ github, repo, changes, pulls }) {
  const rows = [];
  for (const change of changes) {
    const comments = await github.listIssueComments(repo, change.number);
    if (!hasLabel(pulls.get(change.number)) && markerOf(comments) === null) continue;
    rows.push({ number: change.number, title: change.title, url: change.url, kind: kindOf(comments) });
  }
  return rows;
}

// The section for the top of the page, or '' when there are none: the heading, one sentence, a row for each PR.
function renderGated(rows) {
  if (!rows || !rows.length) return '';
  const n = rows.length;
  return [
    GATED_START,
    HEADING,
    '',
    `${n === 1 ? 'This release holds 1 change' : `This release holds ${n} changes`} that merged although the reviewer asked for a person to look at ${n === 1 ? 'it' : 'them'}. Read ${n === 1 ? 'it' : 'each'} before you approve.`,
    '',
    '| PR | The reviewer asked for |',
    '|:--|:--|',
    ...rows.map((r) => `| [#${r.number}](${r.url})${r.title ? ` ${clean(r.title, 80)}` : ''} | ${clean(r.kind, 40)} |`),
    GATED_END,
  ].join('\n');
}

// How many PRs a page lists, counted from its rows: 0 for a page with no such section.
function gatedCount(body) {
  const text = String(body || '').replace(/\r\n?/g, '\n');
  const a = text.indexOf(GATED_START);
  const b = text.indexOf(GATED_END);
  if (a === -1 || b < a || a !== text.lastIndexOf(GATED_START) || b !== text.lastIndexOf(GATED_END)) return 0;
  return text.slice(a, b).split('\n').filter((l) => /^\| \[#\d+\]\(/.test(l)).length;
}

// The body with its section written again: the old one removed, the new one put straight before the top. A body with no
// rows ends as it would have with no section at all. The body is returned as it is when there is no top to put it before.
function withGated(body, rows, before) {
  let text = String(body);
  const a = text.indexOf(GATED_START);
  const b = text.indexOf(GATED_END);
  if (a !== -1 && b > a) text = `${text.slice(0, a)}${text.slice(b + GATED_END.length).replace(/^\n+/, '')}`;
  const section = renderGated(rows);
  if (!section) return text;
  const at = text.indexOf(before);
  if (at === -1) return text;
  return `${text.slice(0, at)}${section}\n\n${text.slice(at)}`;
}

module.exports = {
  LABEL, GATED_START, GATED_END, PERSON, kindOf, markerOf, readGated, renderGated, gatedCount, withGated, hasLabel,
};
