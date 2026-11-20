'use strict';

// `shipyard facts --repo <owner>/<name> --to <commit>`: write facts.json for the range from the
// newest release tag to the commit. Exit 0 when written, 2 when the facts could not be made
// (no tag, a clone without GitHub's newest release tag, a range with no start, an API error, a detector
// that failed). Nothing is written then.

const fs = require('node:fs');
const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { CheckError } = require('./changelog-line');
const { loadReleaseConfig } = require('./changelog-line-command');
const { buildFacts } = require('./facts');
const {
  ReleaseError, git, resolveCommit, isBranchName, lineOf,
} = require('./release-git');
const { parseFixes } = require('./reship');
const { parseOptions, need } = require('./release-args');

const USAGE = 'usage: shipyard facts --repo <owner>/<name> [--to <commit>] [--from <tag>] [--tag-prefix <prefix>] [--dir <checkout>] [--out <facts.json>] [--fixes "<sha> <sha> ..." --work-branch <branch>]';
const FLAGS = {
  '--repo': 'repo', '--to': 'to', '--from': 'from', '--tag-prefix': 'tagPrefix', '--dir': 'dir', '--out': 'out', '--fixes': 'fixes', '--work-branch': 'workBranch',
};

// `.github/release.json` as it is at the commit being released, not as the working tree has it.
function configReader(dir, commit) {
  return (file) => {
    const out = git(dir, ['show', `${commit}:${file}`], { allowFail: true });
    if (out === null) throw Object.assign(new Error(`${file} is not in ${commit}`), { code: 'ENOENT' });
    return out;
  };
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.', to: 'HEAD', tagPrefix: 'v', out: 'facts.json' });
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-cut.md for what the facts hold.\n`);
      return 0;
    }
    const repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
    const dir = path.resolve(need(opts, 'dir', '--dir'));
    // A patch (docs/release-cut.md, "A patch"): `--to` is the tip of the production tag's branch, and the fixes are merge
    // commits of the work branch. Both flags or neither.
    if ((opts.fixes === undefined) !== (opts.workBranch === undefined)) throw new ReleaseError('--fixes and --work-branch go together: a patch names its fixes and the work branch they merged into');
    const fixes = opts.fixes === undefined ? [] : parseFixes(opts.fixes);
    if (opts.fixes !== undefined && !fixes.length) throw new ReleaseError('--fixes names no commit: a patch takes at least one fix');
    if (opts.workBranch !== undefined && (!isBranchName(opts.workBranch) || lineOf(opts.workBranch) !== null)) {
      throw new ReleaseError(`--work-branch must be a work branch (develop, or the repo's workBranch), not ${JSON.stringify(String(opts.workBranch).slice(0, 80))}: a patch is started on the branch its fixes merged into`);
    }

    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL });
    const toSha = resolveCommit(dir, opts.to);
    const configPath = '.github/release.json';
    const config = loadReleaseConfig(configPath, configReader(dir, toSha));

    const facts = await buildFacts({
      dir, repo, to: toSha, from: opts.from, tagPrefix: opts.tagPrefix, github, config, configPath, execFileImpl: io.execFileImpl,
      note: (line) => out.write(`${line}\n`), fixes, workBranch: opts.workBranch || null,
    });
    fs.writeFileSync(opts.out, `${JSON.stringify(facts, null, 2)}\n`);
    out.write(`Facts written to ${opts.out}: ${facts.prs.length} PRs from ${facts.range.from} to ${facts.range.to.slice(0, 7)}${facts.firstRelease ? ` (the first release, ${facts.firstRelease.version})` : ''}${facts.patch ? ` (a patch of ${facts.patch.fixes.length} fix${facts.patch.fixes.length === 1 ? '' : 'es'} from ${facts.patch.workBranch})` : ''}${facts.mergeBacks.length ? ` (and ${facts.mergeBacks.length} merge-back, not counted)` : ''}, ${facts.flags.length} flags, ${facts.breaking.length} breaking signs.\n`);
    return 0;
  } catch (e) {
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof CheckError)) throw e;
    err.write(`shipyard facts: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
