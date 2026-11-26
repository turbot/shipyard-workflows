'use strict';

// `shipyard facts --repo <owner>/<name> --to <commit>`: write facts.json for the range from the
// newest release tag to the commit. Exit 0 when written, 1 when refused (the commit's workflow files are held by no branch or
// tag, so the cut could not push it, the commit lacks the newest commit of its release branch (`main`), or the router's gate workflow is not on `main`), 2 when the facts could not be made
// (no tag, a clone without GitHub's newest release tag, a range with no start, an API error, a detector
// that failed). Nothing is written then.

const fs = require('node:fs');
const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { CheckError } = require('./changelog-line');
const { buildFacts } = require('./facts');
const {
  ReleaseError, Refusal, git, resolveCommit, isBranchName, lineOf,
} = require('./release-git');
const { parseFixes } = require('./reship');
const { parseOptions, need } = require('./release-args');
const { releaseSettingsOf } = require('./release-settings');
const { JSON_FILE } = require('./repo-config');
const { unpushableMessage } = require('./pushable');
const { routerGateWorkflow, gateMissingMessage } = require('./gate-on-main');
const { containsBaseMessage } = require('./contains-base');
const { ownedByWorkflows } = require('./route');
const { workflowFiles } = require('./workflow-texts');

const USAGE = 'usage: shipyard facts --repo <owner>/<name> [--to <commit>] [--from <tag>] [--tag-prefix <prefix>] [--base <release branch>] [--dir <checkout>] [--out <facts.json>] [--fixes "<sha> <sha> ..." --work-branch <branch>]';
const FLAGS = {
  '--repo': 'repo', '--to': 'to', '--from': 'from', '--tag-prefix': 'tagPrefix', '--base': 'base', '--dir': 'dir', '--out': 'out', '--fixes': 'fixes', '--work-branch': 'workBranch',
};

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.', to: 'HEAD', tagPrefix: 'v', base: 'main', out: 'facts.json' });
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

    // The branch the release PR goes into, as the cut's `--base` names it (cut.yml passes its `base` input): the commit must hold its tip.
    if (!isBranchName(opts.base) || lineOf(opts.base) === null) {
      throw new ReleaseError(`--base must be a release branch (main, or main-<x.y>), not ${JSON.stringify(String(opts.base).slice(0, 80))}`);
    }

    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, sleep: io.sleep });
    const toSha = resolveCommit(dir, opts.to);
    // The repo's config at the commit being released, with its tag prefix and work branch: from `.github/shipyard.yml`
    // through `resolveConfig`, else from `.github/release.json` and the flags (lib/release-settings.js).
    const settings = await releaseSettingsOf({ dir, rev: toSha }, {
      repo, github, tagPrefix: opts.tagPrefix, workBranch: opts.workBranch || null, warn: (line) => err.write(`Warning: ${line}\n`),
    });

    // The cut pushes a new `release/<version>` ref at this commit with a token that has no `workflows` permission, which GitHub
    // refuses when no branch or tag tip holds the commit's workflow files (the start's check, lib/pushable.js). The prep run makes
    // its facts first, so it learns here, before any report is written, that the cut would stop. A patch's commit is the tip of
    // its base, a branch, so it always passes.
    const why = unpushableMessage(dir, toSha, { branch: settings.workBranch, nothing: 'No facts were written.' });
    if (why) throw new Refusal(why);

    // The release PR goes into `--base` (`main`), and the release check fails a candidate that lacks that branch's newest commit
    // (`contains-base`), after the cut has pushed its branch and opened the PR. So the prep run stops here, before the cut, when the
    // branch holds a commit the commit lacks (lib/contains-base.js). A patch's commit is the tip of its own release branch, and its prep run may name no `--base`: not asked.
    if (!fixes.length) {
      const behind = containsBaseMessage(dir, toSha, { branch: opts.base, workBranch: settings.workBranch, nothing: 'No facts were written.' });
      if (behind) throw new Refusal(behind);
    }

    // The router starts the release gate by dispatching its `shipyard-release.yml` on `main` and reads `.github/shipyard.yml` there, and a
    // repo's `main` holds both only after its first router release merges (lib/gate-on-main.js). A repo the router releases without either there would have the cut push its
    // release branch and then fail to start the gate, so the prep run stops here, before the cut.
    const gate = routerGateWorkflow({
      file: settings.file, settings: settings.config, owned: ownedByWorkflows(workflowFiles(dir, toSha).map((f) => f.text)),
    });
    if (gate) {
      const missing = await gateMissingMessage({ github, repo, workflow: gate, nothing: 'No facts were written.' });
      if (missing) throw new Refusal(missing);
    }

    const facts = await buildFacts({
      dir, repo, to: toSha, from: opts.from, tagPrefix: settings.tagPrefix, github, config: settings.config, configPath: settings.file || JSON_FILE, execFileImpl: io.execFileImpl,
      note: (line) => out.write(`${line}\n`), fixes, workBranch: settings.workBranch,
    });
    fs.writeFileSync(opts.out, `${JSON.stringify(facts, null, 2)}\n`);
    out.write(`Facts written to ${opts.out}: ${facts.prs.length} PRs from ${facts.range.from} to ${facts.range.to.slice(0, 7)}${facts.firstRelease ? ` (the first release, ${facts.firstRelease.version})` : ''}${facts.patch ? ` (a patch of ${facts.patch.fixes.length} fix${facts.patch.fixes.length === 1 ? '' : 'es'} from ${facts.patch.workBranch})` : ''}${facts.mergeBacks.length ? ` (and ${facts.mergeBacks.length} merge-back, not counted)` : ''}, ${facts.flags.length} flags, ${facts.breaking.length} breaking signs.\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      err.write(`shipyard facts: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof CheckError)) throw e;
    err.write(`shipyard facts: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
