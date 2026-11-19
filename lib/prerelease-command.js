'use strict';

// `shipyard prerelease`: a prerelease of the next version (`v1.5.0-rc.1`) at a commit of a work branch.
// Two steps, around the caller's own build (workflows/prerelease.yml):
//   --step start     checks who started the run, the branch, the commit and the version, and names the
//                    tag (`tag` and `version` as step outputs) for the build. Holds no release token.
//   --step publish   checks all of it again, then makes the annotated tag as the release App and the
//                    GitHub Release, marked as a prerelease, with the build's files (`--assets`). Its body
//                    is the `Changelog:` lines of the PRs since the newest release (lib/prerelease.js).
// Only a person in the area's approver team (`--approvers <org>/<team>`, read with SHIPYARD_ORG_TOKEN)
// starts one, by hand. It writes no commit, branch, CHANGELOG section, PR, comment or announcement.
// Exit 0 when made (or already made), 1 when refused (nothing made), 2 when it could not run (a run
// again makes only what is left).

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions } = require('./release-args');
const { loadAssets, checkArtifactName } = require('./tag-assets');
const { newestOf } = require('./newest-release-tag');
const {
  parseVersion, checkKind, checkTeam, checkStarter, checkBranch, checkCommit, planPrerelease, nextPrerelease, resolveExpected, makeTag, makePrereleaseRelease, prereleaseBody, messageOf, show, short,
} = require('./prerelease');

const USAGE = 'usage: shipyard prerelease --step start|publish --commit <sha> --branch <work branch> --version <X.Y.Z> --pre alpha|beta|rc --approvers <org>/<team> [--tag-prefix <prefix>] [--product <name>] [--tag <tag from start> (publish)] [--assets <artifact> --assets-dir <dir> [--assets-failed]]';
const FLAGS = {
  '--step': 'step',
  '--commit': 'commit',
  '--branch': 'branch',
  '--version': 'version',
  '--pre': 'pre',
  '--approvers': 'approvers',
  '--tag-prefix': 'tagPrefix',
  '--product': 'product',
  '--tag': 'tag',
  '--assets': 'assets',
  '--assets-dir': 'assetsDir',
};
const SWITCHES = { '--assets-failed': 'assetsFailed' };
const HOW = 'docs/release-prerelease.md';

function checkOptions(opts) {
  if (opts.step !== 'start' && opts.step !== 'publish') throw new ReleaseError(`--step must be start or publish, not ${show(opts.step || '', 30)}`);
  for (const [key, flag] of [['commit', '--commit'], ['branch', '--branch'], ['version', '--version'], ['pre', '--pre'], ['approvers', '--approvers']]) {
    if (!opts[key]) throw new ReleaseError(`${flag} is required`);
  }
  if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError(`--tag-prefix ${show(opts.tagPrefix)} is not a tag prefix`);
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(opts.branch) || opts.branch.startsWith('-') || opts.branch.includes('..')) throw new ReleaseError(`--branch must be a branch name, not ${show(opts.branch, 60)}`);
  if (/[\r\n]/.test(opts.product || '')) throw new ReleaseError('--product is one line');
  parseVersion(opts.version);
  checkKind(opts.pre);
  checkTeam(opts.approvers);
  if (opts.step === 'start' && (opts.tag || opts.assets || opts.assetsDir || opts.assetsFailed)) {
    throw new ReleaseError('--tag and --assets go with --step publish: the start step only names the tag');
  }
  if (opts.step === 'publish' && !opts.tag) throw new ReleaseError('--tag is required with --step publish: the tag the start step named, which the build was made for');
  if (opts.assetsFailed && !opts.assets) throw new ReleaseError('--assets-failed goes with --assets');
  if (Boolean(opts.assets) !== Boolean(opts.assetsDir)) throw new ReleaseError('--assets (the artifact\'s name) and --assets-dir (the folder it was downloaded into) go together');
  if (opts.assets) checkArtifactName(opts.assets);
  if (opts.assetsDir && (opts.assetsDir.startsWith('-') || /[\r\n\0]/.test(opts.assetsDir))) throw new ReleaseError(`--assets-dir must be a folder, not ${show(opts.assetsDir)}`);
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, {
      tagPrefix: 'v', product: '', tag: '', assets: '', assetsDir: '',
    }, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee ${HOW} for the caller and the order of the steps.\n`);
      return 0;
    }
    checkOptions(opts);
    const repo = env.GITHUB_REPOSITORY;
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('no repo: set GITHUB_REPOSITORY');
    const apiUrl = env.GITHUB_API_URL;
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl });
    // The job's own token cannot see a team, and would read everyone as no member: never fall back to it.
    if (!io.orgGithub && !env.SHIPYARD_ORG_TOKEN) {
      throw new ReleaseError(`no SHIPYARD_ORG_TOKEN: the caller passes org-token, a token that can read ${opts.approvers}, so the run can tell who may start a prerelease (${HOW}). Nothing was made`);
    }
    const orgGithub = io.orgGithub || createClient({ token: env.SHIPYARD_ORG_TOKEN, apiUrl });
    const starter = { eventName: env.GITHUB_EVENT_NAME, actor: env.GITHUB_ACTOR, triggeringActor: env.GITHUB_TRIGGERING_ACTOR };
    const prefix = opts.tagPrefix;
    const base = {
      github, repo, prefix, commit: opts.commit, branch: opts.branch, version: opts.version, kind: opts.pre,
    };

    if (opts.step === 'start') {
      const plan = await planPrerelease({ ...base, orgGithub, approvers: opts.approvers, starter });
      const line = plan.resumed
        ? `Prerelease ${plan.tag} of ${opts.branch} is tagged at ${short(opts.commit)} with no Release yet (a run that failed after its tag), started again by ${plan.people.join(', ')}: build it, then publish it to finish it.`
        : `Prerelease ${plan.tag} of ${opts.branch} at ${short(opts.commit)}, started by ${plan.people.join(', ')}: build it, then publish it.`;
      say(line);
      summary(env, `### Prerelease\n\n- ${line}\n`);
      output(env, `tag=${plan.tag}\nversion=${plan.version}\n`);
      return 0;
    }

    // publish: every check again, on GitHub as it stands now. Whoever started the run, it is read again.
    if (!io.releaser && !env.RELEASE_TOKEN) throw new ReleaseError('no release token: set RELEASE_TOKEN to the release App\'s token, which the prerelease workflow makes in the release environment (docs/release-apps.md)');
    const releaser = io.releaser || createClient({ token: env.RELEASE_TOKEN, apiUrl });
    const people = await checkStarter({ orgGithub, approvers: opts.approvers, ...starter });
    const parts = parseVersion(opts.version);
    checkBranch(opts.branch, parts);
    await checkCommit(base);
    const tag = opts.tag;
    const { exists } = await resolveExpected({ ...base, expected: tag });
    const names = await github.listTagNames(repo, prefix);
    let newest = newestOf(names, prefix);
    if (!exists) {
      const next = nextPrerelease({
        names, prefix, parts, kind: opts.pre,
      });
      if (next.tag !== tag) {
        throw new Refusal(`the next ${opts.pre} of ${opts.version} is ${next.tag}, not ${tag}, which the build was made for: another prerelease took the number meanwhile. Start a new prerelease. Nothing was made`);
      }
      newest = next.newest;
    }

    // The build's files and the Release's body, read before the tag: a prerelease that cannot carry them is
    // never tagged. A Release already made needs neither.
    let files = null;
    let body = null;
    if (!(await github.getRelease(repo, tag))) {
      if (opts.assets) {
        if (opts.assetsFailed) {
          throw new Refusal(`the download of the artifact ${show(opts.assets, 60)} failed, so the files may be missing or short. Run the job again once the artifact is there (${HOW}). ${exists ? `${tag} is tagged; the Release is not made yet` : 'Nothing was made'}`);
        }
        files = loadAssets({ dir: opts.assetsDir, name: opts.assets });
      }
      try {
        body = await prereleaseBody({
          github, repo, newest, commit: opts.commit,
        });
      } catch (e) {
        if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
        const left = exists ? `${tag} is tagged; the Release is not made yet` : 'Nothing was made';
        const why = `the Release's body, the Changelog lines of the PRs since ${newest}, could not be read: ${e.message}. Run the job again: it makes only what is left. ${left}`;
        throw e instanceof GitHubError ? new GitHubError(why, e.status) : new ReleaseError(why);
      }
    }

    const lines = [];
    const made = exists ? 'exists' : await makeTag({
      github, releaser, repo, tag, commit: opts.commit, message: messageOf({ tag, branch: opts.branch, people }),
    });
    lines.push(made === 'created'
      ? `Tagged ${tag} at ${short(opts.commit)} (annotated; from ${opts.branch}; started by ${people.join(', ')}).`
      : `${tag} is already tagged at ${short(opts.commit)}: left as it is.`);
    const product = (opts.product || '').trim() || repo.split('/')[1];
    let gh;
    try {
      gh = await makePrereleaseRelease({
        github, releaser, repo, tag, body: body || '', title: `${product} ${tag.slice(prefix.length)}`, assets: files,
      });
    } catch (e) {
      if (!(e instanceof GitHubError)) throw e;
      throw new GitHubError(`${tag} is tagged, but ${e.message}. The release App's token needs contents write. Run the job again: it makes only what is left`, e.status);
    }
    lines.push(gh.action === 'created'
      ? `GitHub Release ${tag} made, marked as a prerelease: ${gh.url}`
      : `GitHub Release ${tag} already exists: left as it is.`);
    if (gh.files) lines.push(`Files on the Release: ${gh.files.join(', ')}.`);
    for (const l of lines) say(l);
    summary(env, `### Prerelease\n\n${lines.map((l) => `- ${l}`).join('\n')}\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Prerelease::${escapeData(e.message)}\n`);
      err.write(`shipyard prerelease: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    out.write(`::error title=Prerelease::${escapeData(e.message)}\n`);
    err.write(`shipyard prerelease: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required|takes no))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

function summary(env, text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  } catch {
    // the summary is a courtesy; the tag and the exit code are the result
  }
}

// The start step's outputs, which the build and the publish step read. Unlike the tag's, a failed write
// fails the step: a build with no version must not run.
function output(env, text) {
  if (!env.GITHUB_OUTPUT) return;
  try {
    fs.appendFileSync(env.GITHUB_OUTPUT, text);
  } catch (e) {
    throw new ReleaseError(`cannot write the step's outputs: ${e.code || e.message}`);
  }
}

module.exports = { run, USAGE };
