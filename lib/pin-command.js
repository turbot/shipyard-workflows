'use strict';

// `shipyard pin [--dir <checkout>] [--ref <ref>]`: print the commit of turbot/shipyard-workflows the
// repo's cut workflow calls, as it is at `--ref` (HEAD when left out): the commit it names, or the
// commit `v<major>` names now when it calls that tag. That is the code the
// cut makes the facts and lints the prep file with, so the prep run makes both with it too
// (lib/pin.js). Exit 0 and the 40-character commit on stdout; 1 when there is none to name (no
// caller of the published cut.yml, callers that use different refs, or a tag that cannot be read),
// the reason on stderr;
// 2 when it could not run (a bad option, a ref that is no commit).

const path = require('node:path');
const { cutPin } = require('./pin');
const { ReleaseError, resolveCommit } = require('./release-git');
const { parseOptions } = require('./release-args');

const USAGE = 'usage: shipyard pin [--dir <checkout>] [--ref <ref>]';

async function run(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, { '--dir': 'dir', '--ref': 'ref' }, { dir: '.', ref: 'HEAD' });
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-cut.md: the facts and the lint are made with this code.\n`);
      return 0;
    }
    const dir = path.resolve(opts.dir);
    const pin = cutPin(dir, resolveCommit(dir, opts.ref), io.remote ? { remote: io.remote } : {});
    if (!pin.sha) {
      err.write(`shipyard pin: ${pin.why}\n`);
      return 1;
    }
    out.write(`${pin.sha}\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    err.write(`shipyard pin: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ needs)/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
