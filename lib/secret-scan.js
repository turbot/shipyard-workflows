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

// gitleaks drops a finding whose line holds this text, and says nothing about it. It matches the text as it is
// (case and all), so this does too: a line that holds it is a line the scan did not judge.
const ALLOW_SIGNATURE = 'gitleaks:allow';

// The `git log` that shows each added line the way gitleaks reads it: the same commits and LOG_OPTS, no context
// lines (gitleaks's own -U0), and a marker line before each commit. The prefixes, colour, external diff tools and
// path quoting are set here, so a runner's git settings cannot change what is parsed.
const COMMIT_MARK = 'shipyard-commit ';
function allowLogArgs(range) {
  return [
    '-c', 'core.quotePath=false', 'log', '-p', '-U0', '--no-color', '--no-ext-diff', '--no-notes',
    '--src-prefix=a/', '--dst-prefix=b/', `--format=${COMMIT_MARK}%H`, ...LOG_OPTS, range,
  ];
}

// A path as git writes it after `+++ ` (less the tab git ends it with when it holds a space): as is, or in double quotes with C escapes (a control character, a quote,
// a backslash). An escaped byte is octal, so the bytes are gathered and read as UTF-8.
function unquotePath(text) {
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) return text;
  const named = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92 };
  const bytes = [];
  const inner = text.slice(1, -1);
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c !== '\\') {
      bytes.push(...Buffer.from(c, 'utf8'));
      continue;
    }
    const next = inner[i + 1];
    if (/[0-3]/.test(next) && /^[0-7]{3}$/.test(inner.slice(i + 1, i + 4))) {
      bytes.push(parseInt(inner.slice(i + 1, i + 4), 8));
      i += 3;
    } else if (next in named) {
      bytes.push(named[next]);
      i += 1;
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// Reads the output of `git log <allowLogArgs>` one line at a time and keeps each added line that holds
// ALLOW_SIGNATURE, as { file, line, commit }. A hunk is read by the counts in its `@@` header, never by how a line
// looks: an added line whose text is `++ b/x` or `@@ ...` is content, and cannot pass for a header. It keeps the
// first `keep` and counts the rest in `total`.
function allowCommentReader(keep = 1000) {
  const found = [];
  let total = 0;
  let commit = '';
  let file = null;
  let oldLeft = 0;
  let newLeft = 0;
  let lineNo = 0;
  const line = (raw) => {
    const text = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (oldLeft > 0 || newLeft > 0) {
      const mark = text[0];
      if (mark === '\\') return; // "\ No newline at end of file"
      if (mark === '+') {
        if (file !== null && text.includes(ALLOW_SIGNATURE)) {
          total += 1;
          if (found.length < keep) found.push({ file, line: lineNo, commit });
        }
        lineNo += 1;
        newLeft -= 1;
      } else if (mark === '-') {
        oldLeft -= 1;
      } else {
        lineNo += 1;
        newLeft -= 1;
        oldLeft -= 1;
      }
      return;
    }
    if (text.startsWith(COMMIT_MARK)) {
      commit = text.slice(COMMIT_MARK.length).trim();
      file = null;
    } else if (text.startsWith('diff ')) {
      file = null;
    } else if (text.startsWith('+++ ')) {
      // git ends the line with a tab when the name holds a space; a tab in the name itself is quoted as \t.
      const name = unquotePath(text.slice(4).replace(/\t$/, ''));
      file = name === '/dev/null' ? null : name.replace(/^b\//, '');
    } else {
      const hunk = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(text);
      if (hunk) {
        oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1]);
        lineNo = Number(hunk[2]);
        newLeft = hunk[3] === undefined ? 1 : Number(hunk[3]);
      }
    }
  };
  return { line, found, total: () => total };
}

// `src/config.js:12 (commit 3ce8d6f7dd61)`
function describeAllow(a) {
  return `${a.file}:${a.line}${a.commit ? ` (commit ${a.commit.slice(0, 12)})` : ''}`;
}

module.exports = {
  LEAK_EXIT, LOG_OPTS, ScanError, rangeOf, gitleaksArgs, findingsOf, oneLine, escapeData, escapeProperty, describe, EXCEPTION_FILES,
  ALLOW_SIGNATURE, allowLogArgs, unquotePath, allowCommentReader, describeAllow,
};
