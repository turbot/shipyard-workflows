'use strict';

// `shipyard prerelease`: a prerelease of the next version (`v1.5.0-rc.1`) at a commit of a work branch.
// Three steps, the build (workflows/prerelease-build.yml) between the other two (workflows/prerelease.yml). All run on `main` and
// none runs the commit's code; the build step starts the repo's own build workflow, which runs on the work branch:
//   --step start     checks who started the run, the branch, the commit and the version, and names the
//                    tag (`tag` and `version` as step outputs) for the build. Holds no release token.
//   --step build     starts the repo's build workflow on the work branch, at the branch's tip, and waits for its
//                    run (`run` as a step output). It holds no key (lib/prerelease-build.js). The build uploads
//                    its files as the artifact `<--assets>-<--tag>`.
//   --step publish   checks all of it again, checks that the build run (`--build-run`) is that commit's build,
//                    then makes the annotated tag as the release App and the GitHub Release, marked as a
//                    prerelease, with the build's files (`--assets`). Its body is the `Changelog:` lines of the
//                    PRs since the newest release (lib/prerelease.js).
// Only a person in the area's approver team (read with APPROVERS_TOKEN, which the workflow makes from the
// release App with organization Members: read) starts one, by hand. A repo on .github/shipyard.yml has its team
// from its area; a repo on .github/release.json, or with no file, gives it as `--approvers <org>/<team>`. It
// writes no commit, branch, CHANGELOG section, PR, comment or announcement.
// Exit 0 when made (or already made), 1 when refused (nothing made), 2 when it could not run (a run
// again makes only what is left).

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions } = require('./release-args');
const { loadAssets, checkArtifactName } = require('./tag-assets');
const { loadReaderConfig, settingsOf, trustValue } = require('./reader-config');
const { newestOf } = require('./newest-release-tag');
const {
  parseVersion, checkKind, checkTeam, checkStarter, checkBranch, checkCommit, planPrerelease, nextPrerelease, resolveExpected, makeTag, makePrereleaseRelease, prereleaseBody, messageOf, show, short, parsePrereleaseTag,
} = require('./prerelease');
const { startBuild, checkBuildRun, buildArtifact } = require('./prerelease-build');

const USAGE = 'usage: shipyard prerelease --step start|build|publish --commit <sha> --branch <work branch> --version <X.Y.Z> --pre alpha|beta|rc [--approvers <org>/<team> (start, publish)] [--area <release_area>] [--default-branch <name>] [--tag-prefix <prefix>] [--product <name>] [--tag <tag from start> (build, publish)] [--assets <artifact name, to which the build adds -<tag>> --build-workflow <file> (build, publish) [--build-action <action> (build)] [--build-run <id> --assets-dir <dir> [--assets-failed]] (publish)]';
const FLAGS = {
  '--step': 'step',
  '--commit': 'commit',
  '--branch': 'branch',
  '--version': 'version',
  '--pre': 'pre',
  '--approvers': 'approvers',
  '--area': 'area',
  '--default-branch': 'defaultBranch',
  '--tag-prefix': 'tagPrefix',
  '--product': 'product',
  '--tag': 'tag',
  '--assets': 'assets',
  '--assets-dir': 'assetsDir',
  '--build-workflow': 'buildWorkflow',
  '--build-action': 'buildAction',
  '--build-run': 'buildRun',
};
const SWITCHES = { '--assets-failed': 'assetsFailed' };
const HOW = 'docs/release-prerelease.md';

const COMMIT = /^[0-9a-f]{40}$/;

// `--approvers` is not checked here: a repo on shipyard.yml needs no flag, which is only known by reading its file at
// the commit, so `teamOf` requires and checks it once the file is read, for a repo on release.json or with no file.
function checkOptions(opts) {
  if (!['start', 'build', 'publish'].includes(opts.step)) throw new ReleaseError(`--step must be start, build or publish, not ${show(opts.step || '', 30)}`);
  for (const [key, flag] of [['commit', '--commit'], ['branch', '--branch'], ['version', '--version'], ['pre', '--pre']]) {
    if (!opts[key]) throw new ReleaseError(`${flag} is required`);
  }
  if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError(`--tag-prefix ${show(opts.tagPrefix)} is not a tag prefix`);
  if (!/^[A-Za-z0-9._/-]{1,100}$/.test(opts.branch) || opts.branch.startsWith('-') || opts.branch.includes('..')) throw new ReleaseError(`--branch must be a branch name, not ${show(opts.branch, 60)}`);
  if (/[\r\n]/.test(opts.product || '')) throw new ReleaseError('--product is one line');
  const parts = parseVersion(opts.version);
  checkKind(opts.pre);
  if (opts.step === 'start' && (opts.tag || opts.assets || opts.assetsDir || opts.assetsFailed || opts.buildWorkflow || opts.buildAction || opts.buildRun)) {
    throw new ReleaseError('--tag, --assets and the build options go with --step build or publish: the start step only names the tag');
  }
  if (opts.step !== 'start' && !opts.tag) throw new ReleaseError(`--tag is required with --step ${opts.step}: the tag the start step named, which the build is made for`);
  if (opts.buildWorkflow && !/^[A-Za-z0-9._-]{1,100}\.ya?ml$/.test(opts.buildWorkflow)) throw new ReleaseError(`--build-workflow must be the file name of a workflow, such as prerelease-files.yml, not ${show(opts.buildWorkflow, 60)}`);
  if (opts.buildAction && !/^[a-z][a-z-]{0,39}$/.test(opts.buildAction)) throw new ReleaseError(`--build-action must be an action of the release file, not ${show(opts.buildAction, 40)}`);
  if (opts.assets) checkArtifactName(opts.assets);
  if (opts.step === 'build') {
    if (opts.assetsDir || opts.assetsFailed || opts.buildRun) throw new ReleaseError('--assets-dir, --assets-failed and --build-run go with --step publish: the build step starts the build and names its run');
    if (!opts.assets) throw new ReleaseError('--assets is required with --step build: the name of the artifact the build uploads');
    if (!opts.buildWorkflow) throw new ReleaseError('--build-workflow is required with --step build: the file name of the build workflow on the work branch');
    const parsed = parsePrereleaseTag(opts.tag, opts.tagPrefix);
    if (!parsed || parsed.parts.join('.') !== parts.join('.') || parsed.kind !== opts.pre) {
      throw new ReleaseError(`--tag ${show(opts.tag, 60)} is not a ${opts.pre} prerelease of ${opts.version}: it is the tag the start step named`);
    }
    return;
  }
  if (opts.buildAction) throw new ReleaseError('--build-action goes with --step build');
  if (opts.assetsFailed && !opts.assets) throw new ReleaseError('--assets-failed goes with --assets');
  if (Boolean(opts.assets) !== Boolean(opts.assetsDir)) throw new ReleaseError('--assets (the artifact\'s name) and --assets-dir (the folder it was downloaded into) go together');
  if (opts.assets) {
    if (!opts.buildRun) throw new ReleaseError('--assets goes with --build-run: the files are the build run\'s, a run of the build workflow on the work branch, never a job of this run');
    if (!opts.buildWorkflow) throw new ReleaseError('--assets goes with --build-workflow: the file name of the build workflow that made the run');
  } else if (opts.buildRun || opts.buildWorkflow) {
    throw new ReleaseError('--build-run and --build-workflow go with --assets: the artifact the build uploaded');
  }
  if (opts.assetsDir && (opts.assetsDir.startsWith('-') || /[\r\n\0]/.test(opts.assetsDir))) throw new ReleaseError(`--assets-dir must be a folder, not ${show(opts.assetsDir)}`);
}

// The area's approver team and the repo's config, read once at the prerelease commit. On shipyard.yml the team is the
// area's (a `--approvers` the caller still gives is ignored, with a warning); on release.json or no file it is
// `--approvers`, which is then required and checked as it always was.
async function teamOf({
  github, repo, opts, warn,
}) {
  const loaded = COMMIT.test(String(opts.commit)) ? await loadReaderConfig({ github, repo, ref: opts.commit }, { warn }) : { file: null, config: {}, warnings: [] };
  const settings = await settingsOf(loaded, {
    repo, area: opts.area, defaultBranch: opts.defaultBranch, github, warn,
  });
  const team = trustValue({
    settings, resolved: settings && settings.approversTeam, given: opts.approvers, flag: '--approvers', warn,
  });
  if (!settings) {
    if (!team) throw new ReleaseError('--approvers is required');
    checkTeam(team);
  }
  return { team, loaded };
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, {
      tagPrefix: 'v', product: '', tag: '', assets: '', assetsDir: '', buildWorkflow: '', buildAction: '', buildRun: '',
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
    if (opts.step === 'build') {
      // The build step holds no key and reads no team: the start step checked who started the run, and the caller runs this
      // step only after it passed. It starts the build on the work branch and waits for it.
      const parts = parseVersion(opts.version);
      checkBranch(opts.branch, parts);
      const { runId } = await startBuild({
        github, repo, workflow: opts.buildWorkflow, action: opts.buildAction, branch: opts.branch, commit: opts.commit, tag: opts.tag, artifact: buildArtifact(opts.assets, opts.tag), say,
        ...(io.build || {}),
      });
      say(`Build run ${runId} of ${opts.buildWorkflow} on ${opts.branch} made ${buildArtifact(opts.assets, opts.tag)} at ${short(opts.commit)}.`);
      summary(env, `### Prerelease build\n\n- Run ${runId} of ${opts.buildWorkflow} on ${opts.branch} built ${short(opts.commit)} for ${opts.tag}.\n`);
      output(env, `run=${runId}\n`);
      return 0;
    }
    // The job's own token cannot see a team, and would read everyone as no member: never fall back to it. Checked before
    // anything is read, so the team it names is the flag's when one is given, else the area's.
    if (!io.orgGithub && !env.APPROVERS_TOKEN) {
      throw new ReleaseError(`no APPROVERS_TOKEN: set it to a token that can read ${opts.approvers || "the area's approver team"}, which the prerelease workflow makes from the release App (organization Members: read), so the run can tell who may start a prerelease (${HOW}). Nothing was made`);
    }
    const orgGithub = io.orgGithub || createClient({ token: env.APPROVERS_TOKEN, apiUrl });
    const { team: approvers, loaded } = await teamOf({
      github, repo, opts, warn: (line) => err.write(`${line}\n`),
    });
    const starter = { eventName: env.GITHUB_EVENT_NAME, actor: env.GITHUB_ACTOR, triggeringActor: env.GITHUB_TRIGGERING_ACTOR };
    const prefix = opts.tagPrefix;
    const base = {
      github, repo, prefix, commit: opts.commit, branch: opts.branch, version: opts.version, kind: opts.pre,
    };

    if (opts.step === 'start') {
      const plan = await planPrerelease({ ...base, orgGithub, approvers, starter });
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
    const people = await checkStarter({ orgGithub, approvers, ...starter });
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
          throw new Refusal(`the download of the artifact ${show(buildArtifact(opts.assets, tag), 100)} failed, so the files may be missing or short. Run the job again once the artifact is there (${HOW}). ${exists ? `${tag} is tagged; the Release is not made yet` : 'Nothing was made'}`);
        }
        // The files are a run of the build workflow on the work branch: that run is read from GitHub, and refused unless it is this
        // commit's build, before anything in its files is read.
        const artifact = buildArtifact(opts.assets, tag);
        await checkBuildRun({
          github, repo, runId: opts.buildRun, commit: opts.commit, branch: opts.branch, workflow: opts.buildWorkflow, artifact,
        });
        files = loadAssets({ dir: opts.assetsDir, name: artifact, runId: opts.buildRun });
      }
      try {
        body = await prereleaseBody({
          github, repo, newest, commit: opts.commit, loaded,
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
