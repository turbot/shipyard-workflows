'use strict';

// `shipyard cut --facts <facts.json> --prep <prep.json>`: make `release/<version>` on the remote at the
// commit the facts read (a patch's facts, from `shipyard facts --fixes`, add the fixes picked on after it), with the
// CHANGELOG section committed (a light cut commits no file; the facts, prep file and notes go in the release PR's body)
// through GitHub's API (so the commit is signed), and write the `release-pr` artifact the fleet's hook
// opens the PR from. Exit 0 when cut, 1 when refused (an open or merged untagged candidate holds the number, the facts are stale, the
// prep file fails lint-prep), 2 when the cut could not run (an unreadable file, an API error, a ref the
// token may not write).

const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { LintError } = require('./lint-prep');
const { cut, cutLight, reshipCut } = require('./cut');
const { isLight } = require('./light');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need, readJson } = require('./release-args');
const { describeSkipped } = require('./next-number');
const { ownTag } = require('./shipyard-version');
const { releaseSettingsOf } = require('./release-settings');

const USAGE = 'usage: shipyard cut --facts <facts.json> [--prep <prep.json>: a light release has none] [--dir <checkout>] [--out <release-pr dir>] [--base <branch>] [--work-branch <branch>] [--within <ref>] [--date YYYY-MM-DD] [--changelog <path>] [--shipyard-sha <commit>]\n       shipyard cut --reship <version> [--fixes \"<sha> <sha> ...\" --work-branch <branch>] [--tag-prefix <prefix>] [--repo <owner>/<name>] [--dir <checkout>] [--out <release-pr dir>] [--changelog <path>] [--shipyard-sha <commit>]';
const FLAGS = {
  '--facts': 'facts', '--prep': 'prep', '--dir': 'dir', '--out': 'out', '--base': 'base', '--work-branch': 'workBranch', '--within': 'within', '--date': 'date', '--changelog': 'changelog',
  '--reship': 'reship', '--tag-prefix': 'tagPrefix', '--repo': 'repo', '--fixes': 'fixes',
  '--shipyard-sha': 'shipyardSha',
};

// The numbers the cut passed because they were used, for the line a cut prints: a cut uses up its number.
function skippedText(artifact) {
  const skipped = artifact.skipped || [];
  if (!skipped.length) return '';
  return ` (skipped ${describeSkipped(skipped)}: a cut never makes a used number again)`;
}

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
    // The Shipyard that cuts, written into the release data: the version of the code that runs (`io.shipyardTag` stands in for it in a
    // test) and the published commit the workflow names (`--shipyard-sha`). Each is null when unknown.
    if (opts.shipyardSha !== undefined && !/^[0-9a-f]{40}$/.test(opts.shipyardSha)) throw new ReleaseError('--shipyard-sha must be a full 40-character commit');
    const shipyard = {
      tag: Object.hasOwn(io, 'shipyardTag') ? io.shipyardTag : ownTag(),
      commit: opts.shipyardSha === undefined ? null : opts.shipyardSha,
    };
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const warn = (line) => err.write(`Warning: ${line}\n`);
    if (opts.reship !== undefined) {
      // A re-ship cuts the version that merged, from the release data its PR's body carries (or the files an older cut left on the base): no facts, no prep
      // file, no level. `--base` is the merged PR's. `--work-branch` is the branch the run started on: it
      // is where `--fixes` must be, and with none it is set aside, not refused (a run of cut.yml passes
      // it for every cut).
      const clash = ['facts', 'prep', 'date', 'within'].filter((k) => opts[k] !== undefined).map((k) => `--${k}`);
      if (clash.length) throw new ReleaseError(`--reship cuts the version that merged, from its release PR's data: leave out ${clash.join(' and ')}${clash.includes('--within') ? ' (a re-ship is checked against the tip of its base)' : ''}`);
      if (opts.repo !== undefined && !/^[^/\s]+\/[^/\s]+$/.test(opts.repo)) throw new ReleaseError('--repo must be <owner>/<name>');
      const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, sleep: io.sleep });
      // The repo's config at the checkout's HEAD: for a repo on shipyard.yml the tag prefix is its own, and a `--tag-prefix`
      // that disagrees is refused before anything is read or cut. The run branch is where a re-ship's fixes are, not the work branch.
      const settings = await releaseSettingsOf({ dir: path.resolve(opts.dir), rev: 'HEAD' }, {
        repo: opts.repo || env.GITHUB_REPOSITORY || undefined, github, tagPrefix: opts.tagPrefix === undefined ? 'v' : opts.tagPrefix, warn,
      });
      const { artifact } = await reshipCut({
        dir: path.resolve(opts.dir),
        version: opts.reship,
        tagPrefix: settings.tagPrefix,
        repo: opts.repo || null,
        github,
        out: path.resolve(opts.out),
        changelogFile: opts.changelog,
        fixes: opts.fixes === undefined ? [] : opts.fixes,
        runBranch: opts.workBranch || null,
        warn,
        shipyard,
      });
      out.write(`Cut the re-ship of ${artifact.tag}: ${artifact.branch} at ${artifact.commit.slice(0, 7)}, for #${artifact.reship.releasePr} and its failed run ${artifact.reship.failedRun.id}; artifact in ${opts.out}.\n`);
      return 0;
    }
    if (opts.tagPrefix !== undefined || opts.repo !== undefined || opts.fixes !== undefined) throw new ReleaseError('--tag-prefix, --repo and --fixes go with --reship: a cut reads the first two from the facts, and takes no fixes');
    if (opts.within !== undefined && (/^-/.test(opts.within) || /[\r\n]/.test(opts.within))) throw new ReleaseError(`--within must be a ref, not ${JSON.stringify(opts.within)}`);
    const facts = readJson(need(opts, 'facts', '--facts'), 'facts');
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, sleep: io.sleep });
    // The repo's config at the commit the facts read, and the work branch it sets: for a repo on shipyard.yml the facts' tag
    // prefix must be `v` and a `--work-branch` must be the default branch (a disagreeing flag is refused); for a repo on
    // release.json, or on neither, the flag is the work branch, as it has always been. Facts too broken to read are left
    // to the cut, which names what is wrong with them.
    const factsReadable = facts && facts.range && typeof facts.range.to === 'string' && facts.repo && typeof facts.repo.name === 'string';
    const settings = factsReadable
      ? await releaseSettingsOf({ dir: path.resolve(opts.dir), rev: facts.range.to }, {
        repo: facts.repo.name, github, tagPrefix: facts.tagPrefix, workBranch: opts.workBranch || null, warn,
      })
      : { workBranch: opts.workBranch || null };
    // A light release (lib/light.js) has no prep file: its facts say so, and the version is the day's.
    if (isLight(facts)) {
      if (opts.prep !== undefined) throw new ReleaseError('--prep: a light release has no prep file (its repo\'s config says `profile: light`)');
      const { artifact } = await cutLight({
        dir: path.resolve(opts.dir), facts, github, out: path.resolve(opts.out), base: opts.base, within: opts.within || null, workBranch: settings.workBranch, date: opts.date || now().toISOString().slice(0, 10), shipyard,
      });
      out.write(`Cut ${artifact.tag} (a light release): ${artifact.branch} at ${artifact.commit.slice(0, 7)}, artifact in ${opts.out}${skippedText(artifact)}.\n`);
      return 0;
    }
    const prep = readJson(need(opts, 'prep', '--prep'), 'prep file');
    const { artifact } = await cut({
      dir: path.resolve(opts.dir),
      facts,
      prep,
      github,
      out: path.resolve(opts.out),
      base: opts.base,
      within: opts.within || null,
      workBranch: settings.workBranch,
      changelogFile: opts.changelog,
      date: opts.date || now().toISOString().slice(0, 10),
      shipyard,
    });
    const patchText = artifact.patch ? ` (a patch of ${artifact.base}, with ${artifact.patch.fixes.map((f) => `#${f.pr}`).join(', ')} picked from ${artifact.workBranch})` : '';
    out.write(`Cut ${artifact.tag}${patchText}: ${artifact.branch} at ${artifact.commit.slice(0, 7)}, artifact in ${opts.out}${skippedText(artifact)}.\n`);
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
