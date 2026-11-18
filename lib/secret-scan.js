'use strict';

// The pure parts of `shipyard secret-scan`: how gitleaks is asked to scan a PR's new commits, and how its
// report is read into findings that name a file, a line and a rule and never what was found.
//
// gitleaks writes a JSON report even with `--redact`, and that report also holds the commit author, the email
// and the commit message. A finding is therefore rebuilt from the five fields below and nothing else is ever
// carried forward, so a value cannot reach a log by way of a field this file never reads.

// The exit code gitleaks uses for "found a leak". Its own default is 1, which is also what it exits with when it
// fails to run, so a leak gets a code of its own and any other non-zero exit is a scan that did not happen.
const LEAK_EXIT = 99;

const SHA = /^[0-9a-f]{40}$/;

class ScanError extends Error {}

// The commits a PR adds: reachable from its head, not from its base.
function rangeOf(base, head) {
  for (const [name, value] of [['base', base], ['head', head]]) {
    if (!SHA.test(String(value))) throw new ScanError(`--${name} must be a full 40-character commit, got ${JSON.stringify(String(value).slice(0, 60))}`);
  }
  return `${base}..${head}`;
}

// What git is told when gitleaks lists the commits: `--text` so a file marked binary or `-diff` in .gitattributes
// (which a PR can add itself) is still read, and `--diff-merges=remerge` so what a merge commit adds by itself (a new
// file, a conflict resolution) is read too: git shows a merge no diff otherwise. Needs git 2.36 (a runner has it).
const LOG_OPTS = ['--text', '--diff-merges=remerge'];

// The arguments for `gitleaks git`. `--redact` is always on, and the repo's own `.gitleaks.toml` (found in the
// repo) and `.gitleaksignore` (named here, so it is the repo's and not the working directory's) hold its exceptions.
function gitleaksArgs({ repo, range, reportPath }) {
  return [
    'git',
    '--no-banner',
    '--no-color',
    '--log-level=error',
    '--redact=100',
    `--exit-code=${LEAK_EXIT}`,
    '--report-format=json',
    `--report-path=${reportPath}`,
    `--gitleaks-ignore-path=${repo}`,
    `--log-opts=${[...LOG_OPTS, range].join(' ')}`,
    repo,
  ];
}

// Findings from the text of a gitleaks JSON report: { file, line, rule, commit, fingerprint }, in the order
// gitleaks gave them. An empty report is `[]` (or `null` in some versions). Anything else is not a report.
function findingsOf(text) {
  let list;
  try {
    list = JSON.parse(text);
  } catch {
    throw new ScanError('the gitleaks report is not JSON');
  }
  if (list === null) return [];
  if (!Array.isArray(list)) throw new ScanError('the gitleaks report is not a list');
  return list.map((f, i) => {
    if (f === null || typeof f !== 'object' || typeof f.RuleID !== 'string' || typeof f.File !== 'string') {
      throw new ScanError(`finding ${i + 1} of the gitleaks report has no rule or file`);
    }
    const line = Number.isInteger(f.StartLine) && f.StartLine > 0 ? f.StartLine : 0;
    return {
      file: f.File,
      line,
      rule: f.RuleID,
      commit: typeof f.Commit === 'string' ? f.Commit : '',
      fingerprint: typeof f.Fingerprint === 'string' ? f.Fingerprint : '',
    };
  });
}

// A control character in a file name cannot start a new line of the log, which a runner could read as a command.
const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

// Workflow commands read `%`, CR and LF as syntax, and `,` and `:` end a property.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// `src/config.js:12  aws-access-token (commit 3ce8d6f7dd61)`
function describe(f) {
  const where = f.line ? `${f.file}:${f.line}` : f.file;
  return `${where}  ${f.rule}${f.commit ? ` (commit ${f.commit.slice(0, 12)})` : ''}`;
}

// The two files a repo's exceptions live in. A PR that changes one is scanned with the change, so it is said.
const EXCEPTION_FILES = ['.gitleaks.toml', '.gitleaksignore'];

module.exports = {
  LEAK_EXIT, LOG_OPTS, ScanError, rangeOf, gitleaksArgs, findingsOf, oneLine, escapeData, escapeProperty, describe, EXCEPTION_FILES,
};
