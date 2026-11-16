'use strict';

// `shipyard cut --facts <facts.json> --prep <prep.json>`: make `release/<version>` at the commit
// the facts read, with the CHANGELOG section and `releases/<tag>/release-notes.md` committed, and
// write the `release-pr` artifact the fleet's hook opens the PR from. Exit 0 when cut, 1 when
// refused (the number is taken, the facts are stale, the prep file fails lint-prep), 2 when the
// cut could not run (an unreadable file, an API error, a dirty checkout).

const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { LintError } = require('./lint-prep');
const { cut, reshipCut } = require('./cut');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need, readJson } = require('./release-args');

const USAGE = 'usage: shipyard cut --facts <facts.json> --prep <prep.json> [--dir <checkout>] [--out <release-pr dir>] [--base <branch>] [--work-branch <branch>] [--date YYYY-MM-DD] [--changelog <path>]\n       shipyard cut --reship <version> [--tag-prefix <prefix>] [--repo <owner>/<name>] [--dir <checkout>] [--out <release-pr dir>] [--changelog <path>]';
const FLAGS = {
  '--facts': 'facts', '--prep': 'prep', '--dir': 'dir', '--out': 'out', '--base': 'base', '--work-branch': 'workBranch', '--date': 'date', '--changelog': 'changelog',
  '--reship': 'reship', '--tag-prefix': 'tagPrefix', '--repo': 'repo',
};

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const now = io.now || (() => new Date());
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.', out: 'release-pr', base: 'main', changelog: 'CHANGELOG.md' });
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-cut.md for the number, the branch and the artifact.\n`);
      return 0;
    }
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (opts.reship !== undefined) {
      // A re-ship cuts the version that merged, from the files it left on the base: no facts, no prep
      // file, no level. `--base` and `--work-branch` are the merged PR's and its first cut's. A run of
      // cut.yml passes --work-branch for every cut, so it is read and set aside, not refused.
      const clash = ['facts', 'prep', 'date'].filter((k) => opts[k] !== undefined).map((k) => `--${k}`);
      if (clash.length) throw new ReleaseError(`--reship cuts the version from the files it left on the base: leave out ${clash.join(' and ')}`);
      if (opts.repo !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) throw new ReleaseError('--repo must be <owner>/<name>');
      const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL });
      const { artifact } = await reshipCut({
        dir: path.resolve(opts.dir),
        version: opts.reship,
        tagPrefix: opts.tagPrefix === undefined ? 'v' : opts.tagPrefix,
        repo: opts.repo || null,
        github,
        out: path.resolve(opts.out),
        changelogFile: opts.changelog,
      });
      out.write(`Cut the re-ship of ${artifact.tag}: ${artifact.branch} at ${artifact.commit.slice(0, 7)}, for #${artifact.reship.releasePr} and its failed run ${artifact.reship.failedRun.id}; artifact in ${opts.out}.\n`);
      return 0;
    }
    if (opts.tagPrefix !== undefined || opts.repo !== undefined) throw new ReleaseError('--tag-prefix and --repo go with --reship: a cut reads both from the facts');
    const facts = readJson(need(opts, 'facts', '--facts'), 'facts');
    const prep = readJson(need(opts, 'prep', '--prep'), 'prep file');
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL });
    const { artifact } = await cut({
      dir: path.resolve(opts.dir),
      facts,
      prep,
      github,
      out: path.resolve(opts.out),
      base: opts.base,
      workBranch: opts.workBranch || null,
      changelogFile: opts.changelog,
      date: opts.date || now().toISOString().slice(0, 10),
    });
    out.write(`Cut ${artifact.tag}: ${artifact.branch} at ${artifact.commit.slice(0, 7)}, artifact in ${opts.out}${artifact.replacesClosedCandidate ? ` (the number was free: candidate #${artifact.replacesClosedCandidate} closed untagged)` : ''}.\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      err.write(`shipyard cut: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof LintError || e instanceof GitHubError)) throw e;
    err.write(`shipyard cut: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
