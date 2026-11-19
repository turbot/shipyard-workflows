'use strict';

// `shipyard release-version`: the version a push to `main` (or `main-<x.y>`) releases, read from the release PR that merged as that
// commit, never from a file the merge adds and never from a tag (the tag is made last, after the ship job). A ship job asks it
// for the version to build, and the Homebrew job for the tag whose Release it writes the formula from (workflows/go-cli-ship.yml,
// workflows/homebrew.yml, docs/release-cli.md).
//
// The PR is read from GitHub as the tag step reads it (lib/tag.js `releaseOf`): merged as this commit, from `release/<version>` of
// this repo into main or main-<x.y>, titled `Release <tag>`, carrying its marker, opened by one of `--automation-logins`. It writes
// `release`, `tag`, `version` and `pr` as `key=value` lines to stdout and, when GITHUB_OUTPUT is set, to that file.
// A push that is no release (no PR merged as the commit, or one from another branch) is `release=false` and exit 0, so a ship
// job builds nothing for it. A release PR that fails a rule is exit 1, never a guess at a version. Exit 2: it could not run.

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions } = require('./release-args');
const { lineOf } = require('./release-check');
const { releaseOf, isReleaseHead } = require('./tag');

const USAGE = 'usage: shipyard release-version --automation-logins <a,b> [--sha <commit>] [--tag-prefix <prefix>] [--repo <owner>/<name>]\n'
  + '       --sha is GITHUB_SHA by default, the merge commit of the push';
const FLAGS = {
  '--sha': 'sha', '--tag-prefix': 'tagPrefix', '--automation-logins': 'automationLogins', '--repo': 'repo',
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

    const merged = (await github.listPullsOfCommit(repo, sha)).filter((p) => p && p.merged_at && p.merge_commit_sha === sha && p.base && lineOf(p.base.ref) !== null);
    const found = merged.find((p) => isReleaseHead(p.head && p.head.ref));
    let answer = ['release=false'];
    if (found) {
      const release = releaseOf(await github.getPull(repo, found.number), { repo, prefix: opts.tagPrefix, automationLogins: logins, sha });
      answer = ['release=true', `tag=${release.tag}`, `version=${release.tag.slice(opts.tagPrefix.length)}`, `pr=${release.number}`];
    }
    out.write(`${answer.join('\n')}\n`);
    if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${answer.join('\n')}\n`);
    if (!found) err.write(`shipyard release-version: ${sha.slice(0, 7)} is not the merge of a release PR: nothing to release.\n`);
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
