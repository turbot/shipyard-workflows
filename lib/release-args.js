'use strict';

// Options for the release steps: `--flag value` or `--flag=value`, each flag named by the
// step, no positional arguments. A mistake is a ReleaseError, which the step prints as exit 2.

const fs = require('node:fs');
const { ReleaseError } = require('./release-git');

/**
 * @param {string[]} argv
 * @param {Record<string, string>} flags  `--flag` -> the key it sets
 * @param {Record<string, unknown>} [defaults]
 * @param {Record<string, string>} [switches]  `--flag` -> the key it sets to true; takes no value
 */
function parseOptions(argv, flags, defaults = {}, switches = {}) {
  const opts = { ...defaults };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (!arg.startsWith('--')) throw new ReleaseError(`unexpected argument ${arg}`);
    const [flag, inline] = arg.split(/=(.*)/s);
    if (Object.hasOwn(switches, flag)) {
      if (inline !== undefined) throw new ReleaseError(`${flag} takes no value`);
      opts[switches[flag]] = true;
      continue;
    }
    if (!Object.hasOwn(flags, flag)) throw new ReleaseError(`unknown option ${flag}`);
    if (inline !== undefined) opts[flags[flag]] = inline;
    else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) opts[flags[flag]] = argv[++i];
    else throw new ReleaseError(`${flag} needs a value`);
  }
  return opts;
}

function need(opts, key, flag) {
  if (!opts[key]) throw new ReleaseError(`${flag} is required`);
  return opts[key];
}

// A JSON file a step reads. The parser's own message may quote the file, so it is never echoed.
function readJson(file, what) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new ReleaseError(`cannot read the ${what} at ${file}: ${e.code || e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseError(`the ${what} at ${file} is not valid JSON`);
  }
}

module.exports = { parseOptions, need, readJson };
