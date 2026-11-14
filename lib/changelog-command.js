'use strict';

// `shipyard changelog --facts <facts.json> --prep <prep.json> --version X.Y.Z`: this version's
// CHANGELOG section, built from each PR's own `Changelog:` line in the prep file's groups. It
// prints the section, or with `--file CHANGELOG.md` puts it at the top of that file. Exit 0
// when built, 1 when refused (the prep file fails lint-prep, a PR has no line, the version is
// already in the file), 2 when it could not run (an unreadable file, a bad option).

const fs = require('node:fs');
const { LintError } = require('./lint-prep');
const { ReleaseError, Refusal } = require('./release-git');
const { buildSection, insertSection } = require('./changelog');
const { parseOptions, need } = require('./release-args');

const USAGE = 'usage: shipyard changelog --facts <facts.json> --prep <prep.json> --version <X.Y.Z> [--date YYYY-MM-DD] [--file CHANGELOG.md]';
const FLAGS = { '--facts': 'facts', '--prep': 'prep', '--version': 'version', '--date': 'date', '--file': 'file' };

function readJson(path, what, readFile) {
  let text;
  try {
    text = readFile(path, 'utf8');
  } catch (e) {
    throw new ReleaseError(`cannot read the ${what} at ${path}: ${e.code || e.message}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    // The parser's message quotes the file's text.
    throw new ReleaseError(`the ${what} at ${path} is not valid JSON`);
  }
}

const today = (now) => now().toISOString().slice(0, 10);

async function run(argv, io = {}) {
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const readFile = io.readFile || fs.readFileSync;
  const now = io.now || (() => new Date());
  try {
    const opts = parseOptions(argv, FLAGS);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-cut.md for the section's format.\n`);
      return 0;
    }
    const facts = readJson(need(opts, 'facts', '--facts'), 'facts', readFile);
    const prep = readJson(need(opts, 'prep', '--prep'), 'prep file', readFile);
    const version = need(opts, 'version', '--version');

    const section = buildSection({ facts, prep, version, date: opts.date || today(now) });
    if (opts.file) {
      let existing = '';
      try {
        existing = readFile(opts.file, 'utf8');
      } catch (e) {
        if (!e || e.code !== 'ENOENT') throw new ReleaseError(`cannot read ${opts.file}: ${e.code || e.message}`);
      }
      (io.writeFile || fs.writeFileSync)(opts.file, insertSection(existing, section.text, version));
      out.write(`Wrote the ${version} section to ${opts.file}: ${section.included.length} PRs, ${section.left.length} left out (they ship nothing).\n`);
    } else {
      out.write(section.text);
    }
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      err.write(`shipyard changelog: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof LintError)) throw e;
    err.write(`shipyard changelog: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
