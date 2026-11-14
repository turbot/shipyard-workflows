'use strict';

// `shipyard private-data`: check the files the publish step would copy to the public
// turbot/shipyard-workflows for private repo names, email addresses, account IDs, secrets
// and internal terms. Exit 0 when nothing is found, 1 when something is (each finding is
// printed), 2 when the check could not run. A required check on every PR here, and the
// publish step runs the same check on the files it writes.

const path = require('node:path');
const { PublishError, CONFIG, readConfig, publishSet } = require('./publish');
const { RulesError, checkFiles } = require('./private-data');

const USAGE = 'usage: shipyard private-data [--root <checkout>] [--config <publish.json>]';

// Workflow commands read `%`, CR and LF as syntax, and `,` and `:` end a property.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escapeProperty = (s) => escapeData(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

// A plain line stays one line: a control character in a file's name cannot start a new one,
// which a runner could read as a workflow command.
const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

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

// `lib/x.js:12: holds an email address. [email]`; a finding in a file's name has line 0.
function describe(p) {
  return `${p.file}${p.line ? `:${p.line}` : ' (its name)'}: ${p.message} [${p.rule}]`;
}

function report(problems, { out, env, title }) {
  const inActions = env.GITHUB_ACTIONS === 'true';
  for (const p of problems) {
    out.write(`  ${oneLine(describe(p))}\n`);
    if (inActions) {
      out.write(`::error title=${title},file=${escapeProperty(p.file)}${p.line ? `,line=${p.line}` : ''}::${escapeData(describe(p))}\n`);
    }
  }
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseArgs(argv, ['--root', '--config']);
    const root = path.resolve(opts.root || '.');
    const config = readConfig(root, opts.config ? path.resolve(opts.config) : path.join(root, CONFIG));
    const files = publishSet(root, config);
    const problems = checkFiles(files, config.privateData);
    if (problems.length === 0) {
      out.write(`Private data check OK: ${files.length} files for ${config.repo}, nothing private found.\n`);
      return 0;
    }
    out.write(`Private data check refused: ${problems.length} finding${problems.length === 1 ? '' : 's'} in the files for ${config.repo}\n`);
    report(problems, { out, env, title: 'Private data' });
    return 1;
  } catch (e) {
    if (!(e instanceof UsageError || e instanceof PublishError || e instanceof RulesError)) throw e;
    err.write(`shipyard private-data: ${e.message}\n`);
    if (e instanceof UsageError) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, parseArgs, describe, report, escapeData, escapeProperty, UsageError, USAGE };
