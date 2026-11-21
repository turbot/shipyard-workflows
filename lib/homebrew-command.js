'use strict';

// `shipyard homebrew`: writes a CLI's Homebrew formula into its tap from the published GitHub Release (lib/homebrew.js,
// workflows/homebrew.yml, docs/release-cli.md). It runs after the tag, because the formula points at the Release's files.
//
// In order: reads the Release at the tag in the source repo (it must be published: a draft has no files a person can
// download), makes the formula from the four archives and the SHA-256 GitHub holds for each, reads the formula the tap holds,
// and commits the new one through GitHub's API on the tap's default branch. The same Release always gives the same formula, so
// a run again finds it written and does nothing; a failed write leaves the tap as it was and a run again finishes it. A formula
// that is newer than this release is never written over.
//
// Tokens: GITHUB_TOKEN reads the source repo's Release; RELEASE_TOKEN (the release App's, for the tap alone, contents write)
// writes the tap. Exit 0 when the formula is written or already is, 1 when it is refused (the Release or one of its files is
// missing, or the tap holds a newer version), 2 when it could not run (a bad option, a GitHub error: run it again).

const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need } = require('./release-args');
const {
  HomebrewError, REPO, versionOfTag, checkNames, archiveNames, checksumsOf, formulaFiles, planFormula,
} = require('./homebrew');

const USAGE = 'usage: shipyard homebrew --tag <tag> --tap <owner>/<name> --formula <name> --desc <text> --homepage <https url> [--license <spdx>] [--versioned] [--repo <owner>/<name>] [--tag-prefix <prefix>] [--binary <name>] [--archive <file name with {os} and {arch}; {ext} for tar.gz or zip>] [--test-args <args>] [--branch <tap branch>] [--dir <formula folder in the tap>]';
const FLAGS = {
  '--tag': 'tag', '--tap': 'tap', '--formula': 'formula', '--desc': 'desc', '--homepage': 'homepage', '--license': 'license', '--repo': 'repo',
  '--tag-prefix': 'tagPrefix', '--binary': 'binary', '--archive': 'archive', '--test-args': 'testArgs', '--branch': 'branch', '--dir': 'dir',
};
const SWITCHES = { '--versioned': 'versioned' };

const safePath = (p) => /^[A-Za-z0-9._/-]+$/.test(p) && !p.startsWith('/') && !p.split('/').some((s) => s === '..' || s === '' || s === '.git');

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, { tagPrefix: 'v' }, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-cli.md.\n`);
      return 0;
    }
    if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError('--tag-prefix may hold only letters, digits, dot, underscore and hyphen');
    const tag = need(opts, 'tag', '--tag');
    const tap = need(opts, 'tap', '--tap');
    const repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!repo || !REPO.test(repo)) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
    if (!REPO.test(tap)) throw new ReleaseError('--tap is the tap repo, as <owner>/<name>');
    const version = versionOfTag(tag, opts.tagPrefix);
    const names = checkNames({
      formula: opts.formula, binary: opts.binary, desc: opts.desc, homepage: opts.homepage, license: opts.license, testArgs: opts.testArgs, archive: opts.archive, versioned: opts.versioned === true,
    });
    const dir = opts.dir || 'Formula';
    if (!safePath(dir)) throw new ReleaseError('--dir is a folder inside the tap');
    if (opts.branch && !/^[A-Za-z0-9._/-]+$/.test(opts.branch)) throw new ReleaseError('--branch is a branch name');

    const api = env.GITHUB_API_URL;
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: api });
    const tapToken = env.RELEASE_TOKEN;
    if (!io.tapGithub && !tapToken) throw new ReleaseError('RELEASE_TOKEN is not set: the job makes it with the release App, which must be installed on the tap with contents: write');
    const tapGithub = io.tapGithub || createClient({ token: tapToken, apiUrl: api });

    // The files first: nothing is written for a release that is not on GitHub whole.
    const release = await github.getPublishedRelease(repo, tag);
    if (!release) throw new Refusal(`${repo} has no published GitHub Release at ${tag}: the formula points at its files, so Homebrew comes after the tag and its Release. Run the tag job, then this one again`);
    const archives = archiveNames(names, version);
    let files;
    try {
      files = checksumsOf(archives, release.assets);
    } catch (e) {
      if (e instanceof HomebrewError) throw new Refusal(e.message);
      throw e;
    }
    const formulas = formulaFiles({
      names, version, tag, repo, files, dir,
    });

    const branch = opts.branch || await tapGithub.defaultBranch(tap);
    if (!branch) throw new GitHubError(`${tap} is not visible to the release App: install it there with contents: write`, 404);
    const tip = await tapGithub.getRefSha(tap, `heads/${branch}`);
    if (!tip) throw new GitHubError(`${tap} has no branch ${branch}`, 404);
    const existing = {};
    for (const f of formulas) existing[f.path] = await tapGithub.getFileText(tap, f.path, tip);

    const plan = planFormula({ existing, files: formulas, version });
    if (plan.action === 'refuse') throw new Refusal(plan.reason);
    if (plan.action === 'current') {
      say(`Homebrew: ${names.formula} ${version} is already in ${tap} (${formulas.map((f) => f.path).join(', ')}). Nothing to write.`);
      return 0;
    }

    // One commit made through the API with the App's token, so GitHub signs it. The branch moves only forward: a tap that
    // changed since it was read refuses the write (422), and a run again reads it afresh.
    const base = await tapGithub.getCommit(tap, tip);
    const tree = await tapGithub.createTree(tap, formulas.map((f) => ({ path: f.path, mode: '100644', type: 'blob', content: f.text })), { baseTree: base.tree });
    const commit = await tapGithub.createCommit(tap, {
      message: `${names.formula} ${version}\n\nWritten by Shipyard from ${release.url}`, tree, parents: [tip],
    });
    await tapGithub.updateBranch(tap, branch, commit);
    say(`Homebrew: wrote ${names.formula} ${version} to ${tap} (${formulas.map((f) => f.path).join(', ')}; ${commit.slice(0, 7)}).`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Homebrew::${escapeData(e.message)}\n`);
      err.write(`shipyard homebrew: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof HomebrewError)) throw e;
    // A GitHub error is a step to run again: the tag is made, and the formula is written once the tap answers.
    const again = e instanceof GitHubError ? ' The tag is made and the Release is published: run this job again and it finishes the formula.' : '';
    out.write(`::error title=Homebrew::${escapeData(e.message + again)}\n`);
    err.write(`shipyard homebrew: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
