'use strict';

// `shipyard lint-prep <file> --facts <facts.json>`: check the prep run's file against the
// facts of its range. Exit 0 when the file passes, 1 when it is refused (each problem is
// printed), 2 when the lint itself could not run (a missing file, unusable facts, a bad
// option).

const fs = require('node:fs');
const { LintError, checkFacts, lintPrep, countWords, reportTexts } = require('./lint-prep');

const USAGE = 'usage: shipyard lint-prep <prep.json> --facts <facts.json>';

function parseArgs(argv) {
  const opts = { file: null, facts: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') return { help: true };
    if (arg.startsWith('--')) {
      const [flag, inline] = arg.split(/=(.*)/s);
      if (flag !== '--facts') throw new LintError(`unknown option ${flag}`);
      if (inline !== undefined) opts.facts = inline;
      else if (i + 1 < argv.length) opts.facts = argv[++i];
      else throw new LintError('--facts needs a value');
    } else if (opts.file === null) {
      opts.file = arg;
    } else {
      throw new LintError(`one prep file at a time, not ${arg}`);
    }
  }
  if (!opts.file) throw new LintError('name the prep file');
  if (!opts.facts) throw new LintError('--facts is required');
  return opts;
}

function readJson(path, readFile, what) {
  let text;
  try {
    text = readFile(path, 'utf8');
  } catch (e) {
    throw new LintError(`cannot read the ${what} at ${path}: ${e.code || e.message}`);
  }
  try {
    return { json: JSON.parse(text) };
  } catch {
    // The parser's message quotes the file's text, which may be the very thing kept out of logs.
    return { error: 'is not valid JSON' };
  }
}

// Workflow commands read `%`, CR and LF as syntax.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

// A plain line stays one line: a control character in a facts id cannot start a new one,
// which a runner could read as a workflow command.
const oneLine = (s) => String(s).replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const readFile = io.readFile || fs.readFileSync;
  const inActions = env.GITHUB_ACTIONS === 'true';

  try {
    const opts = parseArgs(argv);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/prep-file.md for the format and each refusal.\n`);
      return 0;
    }

    const facts = readJson(opts.facts, readFile, 'facts');
    if (facts.error) throw new LintError(`the facts at ${opts.facts} ${facts.error}`);
    checkFacts(facts.json);

    const prep = readJson(opts.file, readFile, 'prep file');
    const problems = prep.error
      ? [{ rule: 'json', at: '(the file)', message: prep.error }]
      : lintPrep(prep.json, facts.json);

    if (problems.length === 0) {
      const words = reportTexts(prep.json.report).reduce((sum, t) => sum + countWords(t), 0);
      out.write(`Prep file OK: ${facts.json.prs.length} PRs grouped, ${facts.json.flags.length} flags answered, report ${words} words.\n`);
      return 0;
    }
    out.write(`Prep file refused: ${problems.length} problem${problems.length === 1 ? '' : 's'} in ${opts.file}\n`);
    for (const p of problems) {
      out.write(`  ${oneLine(`${p.at}: ${p.message}`)} [${p.rule}]\n`);
      if (inActions) out.write(`::error title=Prep file::${escapeData(`${p.at}: ${p.message}`)}\n`);
    }
    return 1;
  } catch (e) {
    if (!(e instanceof LintError)) throw e;
    err.write(`shipyard lint-prep: ${e.message}\n`);
    if (/^(unknown option|name the|--facts|one prep file)/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, parseArgs, USAGE };
