'use strict';

// `shipyard kind [--dir <checkout>] [--rev <commit>]`: print the `kind` of the repo's `.github/shipyard.yml` at a commit
// of a checkout (defaults `.` and `HEAD`), and a newline. A repo on `.github/release.json`, one with no config and a
// `shipyard.yml` with no usable `kind` print nothing and exit 0: they have no kind. Exit 2 with `shipyard kind: <why>`
// when the file cannot be read there or the commit names nothing.
//
// It reads with `loadRepoConfigAt`, the loader the facts use, so a step that asks for the kind decides what the facts do.
// The cut's install step runs it to know whether the repo is a Go library (docs/release-cut.md, "Install apidiff for a Go library").

const path = require('node:path');
const { loadRepoConfigAt, NoConfigError, YAML_FILE } = require('./repo-config');
const { ReleaseError } = require('./release-git');
const { parseOptions } = require('./release-args');

const USAGE = 'usage: shipyard kind [--dir <checkout>] [--rev <commit>]';
const FLAGS = { '--dir': 'dir', '--rev': 'rev' };

// A line stays one line, and a workflow command (`::error::`) is never started by text from a file.
const oneLine = (s) => String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/^::/, ': :').trim();

async function run(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.', rev: 'HEAD' });
    if (opts.help) {
      out.write(`${USAGE}\n\nPrints the kind of .github/shipyard.yml at the commit, and a newline. Prints nothing for a repo on .github/release.json or with no config. Exit 2: the file cannot be read there, or the commit names nothing.\n`);
      return 0;
    }
    let loaded;
    try {
      loaded = loadRepoConfigAt({ dir: path.resolve(opts.dir), rev: opts.rev }, { warn: () => {} });
    } catch (e) {
      if (e instanceof NoConfigError) return 0;
      throw e;
    }
    const kind = loaded.file === YAML_FILE && loaded.config ? loaded.config.kind : null;
    if (typeof kind === 'string' && kind) out.write(`${kind}\n`);
    return 0;
  } catch (e) {
    if (e instanceof ReleaseError) {
      err.write(`shipyard kind: ${oneLine(e.message)}\n${/^(unknown option|unexpected argument|--)/.test(e.message) ? `${USAGE}\n` : ''}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { run, USAGE };
