'use strict';

// `shipyard cli-results`: writes the results.json of a CLI candidate (docs/release-record.md, docs/release-cli.md) from what the
// build job found: the test run, the snapshot build and its smoke check, each as `name=pass|fail|skip`. A step that failed is
// written as `fail` and the file is still written, so the record shows HOLD; this command never judges. The build is the
// SHA-256 of the checksums.txt the build made, so the digest follows the files and not the commit. A CLI has no staging
// environment: its staging is the install smoke check on the built archive, so the build and staging digests are one.
//
// `--out` is written only when everything checks out: a bad option or an unreadable checksums.txt is exit 2 and no file.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError } = require('./release-git');
const { parseOptions, need } = require('./release-args');
const { readResults } = require('./record');

const USAGE = 'usage: shipyard cli-results --source <commit> --checksums <checksums.txt> --tests <name=pass,...> --steps <name=pass,...> --out <results.json> [--url <https run link>]';
const FLAGS = {
  '--source': 'source', '--checksums': 'checksums', '--tests': 'tests', '--steps': 'steps', '--out': 'out', '--url': 'url',
};
const STATUS = new Set(['pass', 'fail', 'skip']);

// `unit=pass,build=fail` as `[{ name, status }]`. A name is words (letters, digits, space, . _ -) so it names no secret.
function pairs(text, flag) {
  const rows = String(text || '').split(',').map((s) => s.trim()).filter(Boolean).map((item) => {
    const m = /^([A-Za-z0-9][A-Za-z0-9 ._-]{0,60})=(pass|fail|skip)$/.exec(item);
    if (!m) throw new ReleaseError(`${flag} holds name=pass, name=fail or name=skip, comma-separated: ${JSON.stringify(item.slice(0, 40))} is not one`);
    return { name: m[1], status: m[2] };
  });
  if (!rows.length) throw new ReleaseError(`${flag} names at least one`);
  return rows;
}

async function run(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS);
    if (opts.help) {
      out.write(`${USAGE}\n`);
      return 0;
    }
    const source = need(opts, 'source', '--source');
    if (!/^[0-9a-f]{40}$/.test(source)) throw new ReleaseError('--source must be a full 40-character commit id');
    const tests = pairs(need(opts, 'tests', '--tests'), '--tests');
    const steps = pairs(need(opts, 'steps', '--steps'), '--steps');
    // A build that failed made no checksums. Its digest is then that of the commit it was meant to build, and only a result that
    // says `fail` may have one: a green result with no files is a job that could not run, never a results file.
    const failed = [...tests, ...steps].some((r) => r.status === 'fail');
    let bytes;
    try {
      bytes = fs.readFileSync(need(opts, 'checksums', '--checksums'));
      if (!bytes.length) throw Object.assign(new Error('empty'), { code: 'EMPTY' });
    } catch (e) {
      if (!failed) throw new ReleaseError(`cannot read the checksums at ${opts.checksums}: ${e.code === 'EMPTY' ? 'the file is empty, the build made no files' : e.code || e.message}`);
      bytes = Buffer.from(source);
    }
    const digest = `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
    const url = opts.url ? { url: opts.url } : {};
    const results = {
      format: 1,
      build: { digest, source },
      tests: tests.map((t) => ({ ...t, ...url })),
      staging: { digest, steps: steps.map((s) => ({ ...s, ...url })) },
    };
    readResults(results); // the record's own check, so a file this writes is one the record reads
    const file = need(opts, 'out', '--out');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
    out.write(`Wrote ${file}: ${tests.map((t) => `${t.name} ${t.status}`).concat(steps.map((s) => `${s.name} ${s.status}`)).join(', ')}.\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    out.write(`::error title=CLI results::${escapeData(e.message)}\n`);
    err.write(`shipyard cli-results: ${e.message}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
