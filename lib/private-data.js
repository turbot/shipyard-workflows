'use strict';

// The rules that keep private data out of the public copy, turbot/shipyard-workflows.
// Pure: the caller (private-data-command.js, publish-command.js) supplies each file's text
// and the rules from publish/publish.json.
//
// A finding names the file, the line and the rule, never the text it matched: a log can
// be read by more people than the repo, and the match may be the very name or term the
// rule keeps out. The one exception is a finding in a file's own name, which the finding
// has to print to say where it is.

const { SECRET_PATTERNS, termRegExp } = require('./changelog-line');

// An address a person or a team reads. `git@github.com` is the user of an SSH remote
// (`git@github.com:owner/repo.git`), not anyone's address.
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const NOT_EMAILS = new Set(['git@github.com']);

// A 12-digit AWS account ID, alone or in an ARN, and the same written in three groups of four.
// Not digits inside a longer word, such as a 40-character commit.
const ACCOUNT_IDS = [
  /(?<![0-9A-Za-z])\d{12}(?![0-9A-Za-z])/,
  /(?<![0-9A-Za-z-])\d{4}-\d{4}-\d{4}(?![0-9A-Za-z-])/,
];

class RulesError extends Error {}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The rules, checked and ready to use.
 *
 * @param {object} raw `privateData` of publish/publish.json
 * @param {string[]} raw.orgs          every `<org>/<name>` in a published file must be on `mayName`
 * @param {string[]} raw.mayName       the `<org>/<name>` repos a published file may name
 * @param {string[]} raw.internalTerms words that never leave the private repo
 */
function compileRules(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new RulesError('privateData must be an object');
  const list = (key, test, what) => {
    const v = raw[key];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || !test(x.trim()))) {
      throw new RulesError(`privateData.${key} must be a list of ${what}`);
    }
    return v.map((x) => x.trim());
  };
  const orgs = list('orgs', (x) => /^[A-Za-z0-9-]+$/.test(x), 'GitHub owner names');
  if (orgs.length === 0) throw new RulesError('privateData.orgs must name at least one owner');
  const mayName = list('mayName', (x) => /^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(x), '`owner/name` repos');
  const internalTerms = list('internalTerms', (x) => x.length > 0, 'non-empty strings');
  const unknown = Object.keys(raw).filter((k) => !['orgs', 'mayName', 'internalTerms'].includes(k));
  if (unknown.length) throw new RulesError(`privateData has ${unknown.length} field${unknown.length === 1 ? '' : 's'} outside orgs, mayName and internalTerms`);
  return {
    repoRefs: new RegExp(`(?<![\\w.-])(${orgs.map(escapeRegExp).join('|')})\\/([A-Za-z0-9_.-]+)`, 'gi'),
    mayName: new Set(mayName.map((r) => r.toLowerCase())),
    terms: internalTerms.map((t) => termRegExp(t)),
  };
}

// Every repo of one of the orgs that a line names, as `org/name` in lower case.
function reposNamed(line, rules) {
  const names = [];
  for (const m of line.matchAll(rules.repoRefs)) {
    const name = m[2].replace(/\.git$/i, '').replace(/\.+$/, '');
    if (name) names.push(`${m[1]}/${name}`.toLowerCase());
  }
  return names;
}

/**
 * Check one file's text.
 *
 * @param {string} file where the text will be published, for the finding
 * @param {string} text
 * @param {ReturnType<typeof compileRules>} rules
 * @returns {{file: string, line: number, rule: string, message: string}[]}
 */
function checkText(file, text, rules) {
  const problems = [];
  const lines = String(text).split(/\r\n|\r|\n/);
  lines.forEach((line, i) => {
    const problem = (rule, message) => problems.push({ file, line: i + 1, rule, message });

    if (reposNamed(line, rules).some((r) => !rules.mayName.has(r))) {
      problem('repo-name', 'names a repo that is not on the list the public copy may name (privateData.mayName). It may be private: remove it, or add it to the list if it is public.');
    }
    if ([...line.matchAll(EMAIL)].some((m) => !NOT_EMAILS.has(m[0].toLowerCase()))) {
      problem('email', 'holds an email address. Remove it.');
    }
    if (ACCOUNT_IDS.some((re) => re.test(line))) {
      problem('account-id', 'holds what looks like an account ID (a 12-digit number). Remove it.');
    }
    for (const [label, re] of SECRET_PATTERNS) {
      if (re.test(line)) problem('secret', `holds ${label}. Remove it, and rotate it if it was real.`);
    }
    const terms = rules.terms.filter((re) => re.test(line)).length;
    if (terms) {
      problem('internal-term', `uses ${terms} internal term${terms === 1 ? '' : 's'} (privateData.internalTerms). Reword it for a public reader.`);
    }
  });
  return problems;
}

/**
 * Check every file of the public copy.
 *
 * @param {{path: string, content: string}[]} files
 * @param {object} rawRules `privateData` of publish/publish.json
 */
function checkFiles(files, rawRules) {
  const rules = compileRules(rawRules);
  return files.flatMap((f) => [...checkText(f.path, f.path, rules).map((p) => ({ ...p, line: 0 })), ...checkText(f.path, f.content, rules)]);
}

module.exports = { RulesError, compileRules, checkText, checkFiles, reposNamed };
