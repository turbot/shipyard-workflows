'use strict';

// `shipyard site-docs-preview --ref <branch> [--prefix <prefix>] [--repo <owner>/<name>]`: a site's docs preview
// (lib/site-docs-preview.js, workflows/site-docs-preview.yml). Points the site's branch `docs/<prefix><branch>` at a
// new empty commit by github-actions[bot] on the tip of its default branch, so Vercel's Git integration builds it.
// GITHUB_TOKEN holds `contents: write` on the site repo (the repo the job runs in).
//
// Exit 0 when the branch was made or moved, 1 when the branch name is one the site refuses (nothing is written), 2 when it
// could not run.

const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError } = require('./release-git');
const { parseOptions, need } = require('./release-args');
const { PreviewError } = require('./docs-preview');
const { Refused, pointPreviewBranch } = require('./site-docs-preview');

const USAGE = 'usage: shipyard site-docs-preview --ref <branch> [--prefix <prefix>] [--repo <owner>/<name>]';
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, { '--ref': 'ref', '--prefix': 'prefix', '--repo': 'repo' }, { prefix: '' });
    if (opts.help) {
      out.write(`${USAGE}\n`);
      return 0;
    }
    const ref = need(opts, 'ref', '--ref');
    const repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!repo || !REPO.test(repo)) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (!token && !io.github) throw new ReleaseError('GITHUB_TOKEN is not set');
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, sleep: io.sleep });
    const runId = /^\d{1,20}$/.test(env.GITHUB_RUN_ID || '') ? env.GITHUB_RUN_ID : undefined;
    const done = await pointPreviewBranch({
      github, repo, prefix: opts.prefix, ref, runId,
    });
    out.write(`${done.created ? 'Made' : 'Moved'} ${done.branch} of ${repo} to the empty commit ${done.commit.slice(0, 7)} on ${done.base}. Vercel builds it as the preview.\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refused) {
      out.write(`::error title=Site docs preview::${escapeData(`No preview: ${e.message}`)}\n`);
      err.write(`shipyard site-docs-preview: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof PreviewError)) throw e;
    out.write(`::error title=Site docs preview::${escapeData(e.message)}\n`);
    err.write(`shipyard site-docs-preview: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
