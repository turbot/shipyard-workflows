'use strict';

// `shipyard contract [--dir <checkout>] [--check]`: write `workflows/contract.json`, what the published
// workflows ask of their callers (lib/contract.js). With `--check` it writes nothing and exits 1 when the committed
// file differs from what `workflows/*.yml` ask for. Exit 0 when written or equal, 1 when it differs,
// 2 when it could not run (a workflow file it cannot read, a bad option).

const fs = require('node:fs');
const path = require('node:path');
const { CONTRACT_FILE, ContractError, contractOfDir, formatContract } = require('./contract');
const { ReleaseError } = require('./release-git');
const { parseOptions } = require('./release-args');

const USAGE = 'usage: shipyard contract [--dir <checkout>] [--check]';

async function run(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, { '--dir': 'dir' }, { dir: '.' }, { '--check': 'check' });
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/prep-file.md: a release that raises what callers must give needs a new major version.\n`);
      return 0;
    }
    const dir = path.resolve(opts.dir);
    const file = path.join(dir, CONTRACT_FILE);
    const text = formatContract(contractOfDir(dir));
    let committed = null;
    try {
      committed = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (opts.check) {
      if (committed === text) {
        out.write(`${CONTRACT_FILE} matches the workflows.\n`);
        return 0;
      }
      err.write(`shipyard contract: ${CONTRACT_FILE} ${committed === null ? 'is missing' : 'differs from what the workflows ask for'}: run "node bin/shipyard contract" and commit the result\n`);
      return 1;
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    out.write(`${CONTRACT_FILE} ${committed === text ? 'is already up to date' : 'written'}.\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof ReleaseError || e instanceof ContractError)) throw e;
    err.write(`shipyard contract: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ needs)/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
