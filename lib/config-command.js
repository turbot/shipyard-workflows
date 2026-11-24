'use strict';

// `shipyard config-check <file> [--strict]`: read a `.github/shipyard.yml` with the one validator (lib/config.js)
// and print what it finds. Exit 0 when the file has no error (warnings are printed), 1 when it has one, 2 when
// the check could not run (no file, a bad option). `--strict` is how the check on a PR that changes the file
// reads it: an unknown key is then an error too.

const fs = require('node:fs');
const { parseConfig } = require('./config');

const USAGE = 'usage: shipyard config-check <file> [--strict]';

// A line stays one line, and a workflow command (`::error::`) is never started by the file's own text.
const oneLine = (s) => String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/^::/, ': :');

async function run(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const readFile = io.readFile || fs.readFileSync;
  const files = [];
  let strict = false;
  for (const arg of argv) {
    if (arg === '--help' || arg === '-h') {
      out.write(`${USAGE}\n\nChecks a .github/shipyard.yml. Exit 0: no error. Exit 1: an error (an unknown key too, with --strict). Exit 2: the check could not run.\n`);
      return 0;
    }
    if (arg === '--strict') strict = true;
    else if (arg.startsWith('--')) {
      err.write(`shipyard config-check: unknown option ${oneLine(arg)}\n${USAGE}\n`);
      return 2;
    } else files.push(arg);
  }
  if (files.length !== 1) {
    err.write(`shipyard config-check: give one file\n${USAGE}\n`);
    return 2;
  }
  let text;
  try {
    text = readFile(files[0], 'utf8');
  } catch (e) {
    err.write(`shipyard config-check: cannot read ${oneLine(files[0])}: ${e.code || e.message}\n`);
    return 2;
  }
  const { config, warnings, errors } = parseConfig(text, { strict });
  for (const w of warnings) out.write(`warning: ${oneLine(w)}\n`);
  for (const e of errors) out.write(`error: ${oneLine(e)}\n`);
  if (errors.length) {
    out.write(`${oneLine(files[0])}: ${errors.length} error${errors.length === 1 ? '' : 's'}${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}\n`);
    return 1;
  }
  out.write(`${oneLine(files[0])}: ok, kind ${config.kind}${warnings.length ? `, ${warnings.length} warning${warnings.length === 1 ? '' : 's'}` : ''}\n`);
  return 0;
}

module.exports = { run, USAGE };
