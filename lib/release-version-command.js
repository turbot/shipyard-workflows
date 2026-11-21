'use strict';

// `shipyard release-version`: the version a push to `main` (or `main-<x.y>`) releases, read from the release PR that merged as that
// commit, never from a file the merge adds and never from a tag (the tag is made last, after the ship job). A ship job asks it
// for the version to build, and the Homebrew job for the tag whose Release it writes the formula from (workflows/go-cli-ship.yml,
// workflows/homebrew.yml, docs/release-cli.md).
//
// The answer is `releaseOfPush`'s (lib/tag.js), the one `shipyard tag` uses for the same push, so the two cannot disagree
// (issue #453, test/release-same-code.test.js). The PR is read from GitHub as the tag reads it: merged as this commit into the
// pushed branch, from `release/<version>` of this repo, titled `Release <tag>`, carrying its marker, opened by one of
// `--automation-logins`, its release data matching its cut commit. It writes `release`, `tag`, `version`, `pr` and `digest` (the
// build digest its audit record holds, empty when it holds none) as `key=value` lines to stdout and, when GITHUB_OUTPUT is set,
// to that file. A push that is no release (a branch that is not main, no PR merged as the commit, or one from another branch) is
// `release=false` and exit 0, so a ship job builds nothing for it. A release PR that fails a rule is exit 1, never a guess at a
// version. Exit 2: it could not run.

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions } = require('./release-args');
const { releaseOfPush } = require('./tag');

const USAGE = 'usage: shipyard release-version --automation-logins <a,b> [--sha <commit>] [--branch <name>] [--tag-prefix <prefix>] [--repo <owner>/<name>]\n'
  + '       --sha is GITHUB_SHA by default, the merge commit of the push\n'
  + '       --branch is the pushed branch: the branch of GITHUB_REF by default';
const FLAGS = {
  '--sha': 'sha', '--branch': 'branch', '--tag-prefix': 'tagPrefix', '--automation-logins': 'automationLogins', '--repo': 'repo',
};

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { tagPrefix: 'v' });
    if (opts.help) {
      out.write(`${USAGE}\n`);
      return 0;
    }
    if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError('--tag-prefix may hold only letters, digits, dot, underscore and hyphen');
    const logins = String(opts.automationLogins || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!logins.length) throw new ReleaseError('--automation-logins is required: name the accounts that open release PRs');
    const sha = opts.sha || env.GITHUB_SHA;
    if (!/^[0-9a-f]{40}$/.test(String(sha))) throw new ReleaseError('--sha must be a full 40-character commit id (or set GITHUB_SHA)');
    const repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: env.GITHUB_API_URL });

    const ref = env.GITHUB_REF;
    let { branch } = opts;
    if (!branch && ref && ref.startsWith('refs/heads/')) branch = ref.slice('refs/heads/'.length);
    if (!branch && !ref) throw new ReleaseError('--branch is required (or set GITHUB_REF to the pushed branch)');
    let answer = ['release=false'];
    if (!branch) {
      err.write(`shipyard release-version: ${JSON.stringify(ref.slice(0, 60))} is not a branch: nothing to release.\n`);
    } else {
      const found = await releaseOfPush({
        github, repo, branch, sha, prefix: opts.tagPrefix, automationLogins: logins,
      });
      if (found.skip) {
        err.write(`shipyard release-version: ${found.skip}: nothing to release.\n`);
      } else {
        const { release } = found;
        answer = ['release=true', `tag=${release.tag}`, `version=${release.tag.slice(opts.tagPrefix.length)}`, `pr=${release.number}`, `digest=${release.digest || ''}`];
        if (!release.digest) out.write(`::warning title=Release version::the audit record of #${release.number} holds no build digest\n`);
      }
    }
    out.write(`${answer.join('\n')}\n`);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${answer.join('\n')}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Release version::${escapeData(e.message)}\n`);
      err.write(`shipyard release-version: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    out.write(`::error title=Release version::${escapeData(e.message)}\n`);
    err.write(`shipyard release-version: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
