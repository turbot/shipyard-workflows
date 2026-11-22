'use strict';

// `shipyard changelog-page`: writes a release's changelog page into the product's site repo, as its own job after the tag
// (lib/announce.js `openPage`, workflows/changelog-page.yml, docs/release-announce.md). Like Homebrew it runs in the caller's
// `release` environment on `main`, where the area's release App can make a token for the site repo alone, so the page needs
// no secret of its own and no run from the tag's push.
//
// In order: finds the release the tag names (a merged release PR from one of `--automation-logins`), refuses when the GitHub
// Release is not published (the page says a release is out), reads `.github/release.json` at the merge commit and the release
// notes from the release data in the release PR's body (checked against its cut commit; a release cut before that has them in
// `releases/<tag>/` at the merge commit), and refuses a site repo or a folder the caller did not list in `--page-targets`. A release with no page setting or no
// release notes has no page: exit 0 and nothing written. Then it opens the page PR on the site repo and merges it.
//
// `--resolve` stops before the write and says, as `page`, `site-owner` and `site-name` in $GITHUB_OUTPUT, where the page would go,
// so the job can make a token for that repo alone. The same checks run again with the write, so a token is never used for a
// repo that was not checked. Tokens: GITHUB_TOKEN reads the product repo; RELEASE_TOKEN (the release App's, for the site repo
// alone, contents and pull requests write) writes the page.
//
// A failed write is finished by running the job again: it reads what an earlier run did before it writes, so it never opens a
// second PR or writes a second page. Exit 0 when the page is written, already there, or has nothing to write; 1 when it is
// refused (nothing was written); 2 when it could not run (a bad option, a GitHub error: run it again).

const fs = require('node:fs');
const { createClient } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need } = require('./release-args');
const { show } = require('./tag');
const { currentOf } = require('./shipyard-version');
const {
  findRelease, readAnnounceConfig, readReleaseNotes, parseTargets, checkTarget, pagePath, retrying, isFailure, openPage, oneLine,
} = require('./announce');

const USAGE = 'usage: shipyard changelog-page --tag <tag> --automation-logins <a,b> --page-targets <owner/name:folder/,...> [--tag-prefix <prefix>] [--resolve] [--repo <owner>/<name>]';
const FLAGS = {
  '--tag': 'tag', '--tag-prefix': 'tagPrefix', '--automation-logins': 'automationLogins', '--page-targets': 'pageTargets', '--repo': 'repo',
};
const SWITCHES = { '--resolve': 'resolve' };
const REPO = /^[^/\s]+\/[^/\s]+$/;

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, { tagPrefix: 'v', pageTargets: '' }, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-announce.md.\n`);
      return 0;
    }
    if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError(`--tag-prefix ${show(opts.tagPrefix)} is not a tag prefix`);
    const tag = need(opts, 'tag', '--tag');
    if (/[\s\u0000-\u001f]/.test(tag)) throw new ReleaseError(`--tag ${show(tag, 40)} is not a tag name`);
    const automationLogins = list(opts.automationLogins);
    if (!automationLogins.length) throw new ReleaseError('--automation-logins is required: name the accounts that open release PRs, or any PR from a release/ branch could get a page');
    const targets = parseTargets(opts.pageTargets);
    const repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!repo || !REPO.test(repo)) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');

    const apiUrl = env.GITHUB_API_URL;
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl });
    const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

    // What the job learns, and the job's answer to the step that makes the token.
    const answer = (lines) => {
      if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `${lines.join('\n')}\n`);
    };
    const noPage = (why) => {
      say(`Changelog page: ${why}. Nothing to write.`);
      answer(['page=false']);
      return 0;
    };

    // Reads only, so a failed call is tried again.
    const found = await retrying(() => findRelease({
      github, repo, tag, prefix: opts.tagPrefix, automationLogins, current: currentOf(io),
    }), { sleep });
    if (found.skip) return noPage(found.skip);
    const { release } = found;
    const published = await retrying(() => github.getPublishedRelease(repo, tag), { sleep });
    if (!published) {
      throw new Refusal(`${repo} has no published GitHub Release at ${tag}: the page says the release is out, so it comes after the tag job and its Release. Run the tag job, then this one again`);
    }
    const ctx = {
      github, repo, release, sleep,
    };
    const { page } = await readAnnounceConfig(ctx);
    if (!page) return noPage(`${repo} has no page (its .github/release.json has no announce.page), so the #releases line is posted instead`);
    const notes = await readReleaseNotes(ctx);
    if (!notes) return noPage(`${tag} has no release notes, so it has no page`);
    checkTarget(targets, page, pagePath(page.path, release));

    if (opts.resolve) {
      const [owner, name] = page.repo.split('/');
      say(`Changelog page: ${tag} goes to ${page.repo}.`);
      answer(['page=true', `site-owner=${owner}`, `site-name=${name}`]);
      return 0;
    }

    const token = env.RELEASE_TOKEN;
    if (!token && !io.pageGithub) throw new ReleaseError('RELEASE_TOKEN is not set: the job makes it with the release App, which must be installed on the site repo with contents and pull requests write');
    const pageGithub = io.pageGithub || createClient({ token, apiUrl });
    const date = found.date || (io.clock ? io.clock() : new Date()).toISOString().replace(/\.\d+Z$/, 'Z');
    const result = await retrying(() => openPage({
      github: pageGithub, repo, release, notes, page, date, prNumber: release.number,
    }), { sleep });
    say(`Changelog page: ${result.message}`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Changelog page::${escapeData(e.message)}\n`);
      err.write(`shipyard changelog-page: ${e.message}\n`);
      return 1;
    }
    if (!isFailure(e)) throw e;
    // A GitHub error is a step to run again: the tag is made, and the page is written once GitHub answers.
    const again = e instanceof ReleaseError ? '' : ' The tag is made and the Release is published: run this job again and it finishes the page.';
    out.write(`::error title=Changelog page::${escapeData(oneLine(e.message, 400) + again)}\n`);
    err.write(`shipyard changelog-page: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
