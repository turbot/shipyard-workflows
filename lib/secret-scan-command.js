'use strict';

// `shipyard secret-scan`: the required PR check that no secret was added. It runs gitleaks over the commits the PR
// adds (base to head) and fails when it finds one, naming the file, the line and the rule and never the value.
// Exit 0: nothing found. Exit 1: a possible secret. Exit 2: the scan could not run, so nothing is known
// (no gitleaks, a shallow checkout, a report it cannot read): a scan that did not happen never passes.
//
//   shipyard secret-scan --base <sha> --head <sha> [--dir <checkout>] [--gitleaks <binary>]
//
// The repo's own `.gitleaks.toml` and `.gitleaksignore`, read from the checkout, hold its exceptions; nothing
// here names a repo or a path (docs/secret-scan.md).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  LEAK_EXIT, LOG_OPTS, ScanError, rangeOf, gitleaksArgs, findingsOf, oneLine, escapeData, escapeProperty, describe, EXCEPTION_FILES,
} = require('./secret-scan');

const USAGE = 'usage: shipyard secret-scan --base <sha> --head <sha> [--dir <checkout>] [--gitleaks <binary>]';
const TITLE = 'Secret scan';
const MAX_LINES = 200;       // findings listed in the log
const MAX_ANNOTATIONS = 10;  // GitHub shows no more than ten error annotations for a step
const MAX_TOOL_LINES = 10;

class UsageError extends Error {}

function parseArgs(argv, flags) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    if (!flags.includes(flag)) throw new UsageError(`unknown option ${flag}`);
    if (inline !== undefined) opts[flag.slice(2)] = inline;
    else if (i + 1 < argv.length) opts[flag.slice(2)] = argv[++i];
    else throw new UsageError(`${flag} needs a value`);
  }
  return opts;
}

function git(dir, args, env) {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env });
  if (r.error) throw new ScanError(`git did not run: ${r.error.message}`);
  return r;
}

// The checkout must hold both commits, or the range means nothing: a shallow clone is a scan that did not happen.
function requireCommit(dir, sha, what, env) {
  if (git(dir, ['cat-file', '-e', `${sha}^{commit}`], env).status !== 0) {
    throw new ScanError(`the checkout does not hold the ${what} commit ${sha.slice(0, 12)}: check it out with its full history (fetch-depth: 0)`);
  }
}

// The exception files this PR changes, as the PR shows them (the base's merge-base to the head). Never fatal: it is a notice.
function changedExceptionFiles(dir, base, head, env) {
  const r = git(dir, ['diff', '--name-only', '-z', `${base}...${head}`], env);
  if (r.status !== 0) return [];
  return r.stdout.split('\0').filter((f) => EXCEPTION_FILES.includes(path.posix.basename(f)));
}

// What a gitleaks that did not run says, for a person to read: a few plain lines, no control characters.
function toolLines(text) {
  return String(text).split(/\r?\n/).filter((l) => l.trim()).slice(0, MAX_TOOL_LINES).map((l) => oneLine(l).slice(0, 300));
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const inActions = env.GITHUB_ACTIONS === 'true';
  let tmp = null;
  try {
    const opts = parseArgs(argv, ['--base', '--head', '--dir', '--gitleaks']);
    if (!opts.base || !opts.head) throw new UsageError('--base and --head are both needed');
    const dir = path.resolve(opts.dir || '.');
    const range = rangeOf(opts.base, opts.head);
    if (!fs.existsSync(dir)) throw new ScanError(`${opts.dir || '.'} is not a folder`);
    requireCommit(dir, opts.base, 'base', env);
    requireCommit(dir, opts.head, 'head', env);

    const counted = git(dir, ['rev-list', '--count', range], env);
    if (counted.status !== 0) throw new ScanError(`git could not list ${range}: ${toolLines(counted.stderr).join(' ')}`);
    const commits = Number(counted.stdout.trim());
    if (commits === 0) {
      out.write(`${TITLE}: the PR adds no commits, so there is nothing to scan.\n`);
      return 0;
    }

    // gitleaks lists the commits with git and, when git rejects an option (an old git has no --diff-merges=remerge),
    // logs it and exits 0 with an empty report: a scan that read nothing. So git is asked the same thing first.
    const listed = git(dir, ['log', '-1', '--format=%H', ...LOG_OPTS, range], env);
    if (listed.status !== 0) throw new ScanError(`this git cannot list ${range} the way the scan needs (${LOG_OPTS.join(' ')}; git 2.36 or newer): ${toolLines(listed.stderr).join(' ')}`);

    for (const f of changedExceptionFiles(dir, opts.base, opts.head, env)) {
      const msg = `${f} changes in this PR, and its exceptions apply to this scan: a reviewer should read the change.`;
      out.write(`${TITLE}: ${oneLine(msg)}\n`);
      if (inActions) out.write(`::warning title=${TITLE},file=${escapeProperty(f)}::${escapeData(msg)}\n`);
    }

    tmp = fs.mkdtempSync(path.join(env.RUNNER_TEMP || os.tmpdir(), 'secret-scan-'));
    const reportPath = path.join(tmp, 'report.json');
    // The runner's own gitleaks settings never stand in for the repo's: its `.gitleaks.toml` is the one read.
    const childEnv = { ...env };
    delete childEnv.GITLEAKS_CONFIG;
    delete childEnv.GITLEAKS_CONFIG_TOML;
    const bin = opts.gitleaks || 'gitleaks';
    const r = spawnSync(bin, gitleaksArgs({ repo: dir, range, reportPath }), {
      cwd: dir, env: childEnv, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    });
    if (r.error) throw new ScanError(`gitleaks did not run (${oneLine(bin)}): ${oneLine(r.error.message)}`);
    if (r.status !== 0 && r.status !== LEAK_EXIT) {
      // gitleaks exits 1 when it fails to run; its own message names the cause (a bad config, a bad range).
      throw new ScanError(`gitleaks failed (exit ${r.status === null ? `signal ${r.signal}` : r.status}), so nothing was scanned${toolLines(r.stderr).map((l) => `\n  ${l}`).join('')}`);
    }
    if (!fs.existsSync(reportPath)) throw new ScanError('gitleaks wrote no report, so nothing is known about the PR');
    const findings = findingsOf(fs.readFileSync(reportPath, 'utf8'));
    if (r.status === LEAK_EXIT && findings.length === 0) throw new ScanError('gitleaks said it found a secret and listed none');
    if (r.status === 0 && findings.length > 0) throw new ScanError('gitleaks listed findings and said it found none');

    const noun = commits === 1 ? 'commit' : 'commits';
    if (findings.length === 0) {
      out.write(`${TITLE}: no secret in the ${commits} new ${noun} (${opts.base.slice(0, 12)}..${opts.head.slice(0, 12)}).\n`);
      return 0;
    }

    out.write(`${TITLE}: ${findings.length} possible secret${findings.length === 1 ? '' : 's'} in the ${commits} new ${noun}. The values are not shown.\n`);
    findings.slice(0, MAX_LINES).forEach((f, i) => {
      out.write(`  ${oneLine(describe(f))}\n`);
      if (f.fingerprint) out.write(`    a false positive: add this line to .gitleaksignore: ${oneLine(f.fingerprint)}\n`);
      if (inActions && i < MAX_ANNOTATIONS) {
        const props = `title=${TITLE},file=${escapeProperty(f.file)}${f.line ? `,line=${f.line}` : ''}`;
        out.write(`::error ${props}::${escapeData(`${describe(f)}: a possible secret. Rotate it first, then remove it.`)}\n`);
      }
    });
    if (findings.length > MAX_LINES) out.write(`  ... and ${findings.length - MAX_LINES} more\n`);
    out.write('If one is real: rotate the secret first (removing it from the branch leaves it in the history), then remove it from the commits.\n');
    return 1;
  } catch (e) {
    if (e instanceof UsageError) err.write(`shipyard secret-scan: ${e.message}\n${USAGE}\n`);
    else if (e instanceof ScanError) {
      err.write(`shipyard secret-scan: ${e.message}\n`);
      if (inActions) out.write(`::error title=${TITLE}::${escapeData(e.message.split('\n')[0])}\n`);
    } else err.write(`shipyard secret-scan: ${e && e.message ? e.message : e}\n`);
    return 2;
  } finally {
    if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  }
}

module.exports = { run };
