'use strict';

// `shipyard docs-preview start|link`: a docs repo's site preview (lib/docs-preview.js, workflows/docs-preview.yml).
//
//   start  On a push to a docs branch: runs the site's preview workflow on the site's default branch, with `ref_name` set
//          to the branch. The site builds `docs/<prefix><branch>`. SITE_TOKEN is a token for the site that may run its
//          workflows.
//   link   On a PR from the docs repo itself: makes a deployment of the PR's head commit in the environment
//          `<site name> preview`, waits for the preview, and sets the deployment to `success` with the preview's address
//          as its `environment_url`, so the PR shows "deployed to <site name> preview" and a "View deployment" button.
//          GITHUB_TOKEN writes the deployment; SITE_TOKEN, when given, reads the site's branch and deployments.
//
// A `workflow_dispatch` on a branch other than main (a docs repo's release-pr.yml on `release/<version>`, whose push the
// cut's token makes with no run) runs both, for the run's own branch and commit.
//
// It writes no comment and edits no PR body: a public docs repo holds a PR whose text came from a bot.
// Exit 0 when the preview was started or linked, 1 when there is no preview (a branch name the site refuses, a build that
// failed or did not finish in time), 2 when it could not run.

const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need } = require('./release-args');
const {
  ACCEPTED_REF, PreviewError, previewLink, environmentOf, checkSite, checkPrefix, checkProject, checkWorkflow, awaitPreview,
} = require('./docs-preview');

const USAGE = [
  'usage: shipyard docs-preview start --site <owner>/<name> --workflow <file> --ref <branch>',
  '       shipyard docs-preview link --site <owner>/<name> --project <vercel project> --ref <branch> --sha <commit> [--prefix <prefix>] [--repo <owner>/<name>] [--wait <minutes>]',
].join('\n');
const REPO = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const MAX_WAIT_MINUTES = 60;
const REFUSED = 'No preview: the branch name has a character the site\'s build refuses. Use only letters, digits, . _ / and -.';

const clip = (text) => (text.length > 140 ? `${text.slice(0, 139)}…` : text);

async function start(argv, { env, out, io }) {
  const opts = parseOptions(argv, { '--site': 'site', '--workflow': 'workflow', '--ref': 'ref' });
  if (opts.help) return { help: true };
  const site = checkSite(need(opts, 'site', '--site'));
  const workflow = checkWorkflow(need(opts, 'workflow', '--workflow'));
  const ref = need(opts, 'ref', '--ref');
  // The site's own check, before anything is asked of it: it would build nothing for such a name.
  if (!ACCEPTED_REF.test(ref)) throw new Refusal(REFUSED);
  const token = env.SITE_TOKEN;
  if (!token && !io.siteGithub) throw new ReleaseError('SITE_TOKEN is not set: the job makes it with the site\'s App');
  const siteGithub = io.siteGithub || createClient({ token, apiUrl: env.GITHUB_API_URL, sleep: io.sleep });
  const branch = await siteGithub.defaultBranch(site);
  if (!branch) throw new ReleaseError(`the App's token cannot see ${site}: is the App installed on it?`);
  try {
    await siteGithub.dispatchWorkflow(site, workflow, branch, { ref_name: ref });
  } catch (e) {
    if (e instanceof GitHubError && !e.dropped) throw new GitHubError(`${workflow} of ${site} could not be started on ${branch} (${e.status}): it must take workflow_dispatch with the input ref_name, and the App must hold actions: write on ${site}`, e.status);
    throw e;
  }
  out.write(`Started ${workflow} of ${site} on ${branch} for this branch. The preview builds in a few minutes.\n`);
  return { code: 0 };
}

// The time a site branch's head must not be older than to be this push's build: when the docs repo got the PR's head
// commit (its activity), since the site commits its build after the push that started it. A commit's own date can be
// older than an earlier push's build (made while that build ran, or pushed back), so it is the fallback only, for a push
// the activity no longer lists or a token that cannot read it.
async function sinceWhen(github, repo, ref, sha) {
  const pushed = await github.pushTime(repo, ref, sha).catch((e) => {
    if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) return null;
    throw e;
  });
  const at = Date.parse(pushed || await github.commitDate(repo, sha));
  if (!Number.isFinite(at)) throw new GitHubError(`GitHub gave no time for ${sha.slice(0, 7)} in ${repo}`, 200);
  return at;
}

// What the deployment says once the wait is over.
function finalStatus(seen, link, waitMinutes) {
  if (seen.state === 'failure') return { state: 'failure', description: `No preview: ${seen.detail}.` };
  if (seen.state === 'waiting') {
    return { state: 'error', description: `No preview after ${waitMinutes} minutes: ${seen.detail}.`, environment_url: link.url };
  }
  const description = {
    build: link.linked ? 'The preview of this push is up.' : 'The preview is up. No link can be worked out for this branch name, so this lists every preview.',
    link: 'The preview answers. The site\'s build could not be read, so it may still show the last push.',
    none: 'No link can be worked out for this branch name, and the site\'s build could not be read: this lists every preview.',
  }[seen.checked];
  return { state: 'success', description, environment_url: link.url };
}

async function link(argv, { env, out, io }) {
  const opts = parseOptions(argv, {
    '--site': 'site', '--prefix': 'prefix', '--project': 'project', '--ref': 'ref', '--sha': 'sha', '--repo': 'repo', '--wait': 'wait',
  }, { prefix: '', wait: '20' });
  if (opts.help) return { help: true };
  const site = checkSite(need(opts, 'site', '--site'));
  const prefix = checkPrefix(opts.prefix);
  const project = checkProject(need(opts, 'project', '--project'));
  const ref = need(opts, 'ref', '--ref');
  const sha = need(opts, 'sha', '--sha');
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new ReleaseError('--sha must be a full 40-character commit id');
  const repo = opts.repo || env.GITHUB_REPOSITORY;
  if (!repo || !REPO.test(repo)) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
  if (!/^\d{1,2}$/.test(opts.wait) || Number(opts.wait) < 1 || Number(opts.wait) > MAX_WAIT_MINUTES) {
    throw new ReleaseError(`--wait is a number of minutes, from 1 to ${MAX_WAIT_MINUTES}`);
  }
  const environment = environmentOf(site);
  const preview = previewLink({ site, project, prefix, ref });

  const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: env.GITHUB_API_URL, sleep: io.sleep });
  const siteGithub = io.siteGithub !== undefined ? io.siteGithub : (env.SITE_TOKEN ? createClient({ token: env.SITE_TOKEN, apiUrl: env.GITHUB_API_URL, sleep: io.sleep }) : null);
  const logUrl = env.GITHUB_SERVER_URL && env.GITHUB_RUN_ID && REPO.test(env.GITHUB_REPOSITORY || '')
    ? `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : undefined;
  const status = (s) => ({ ...s, description: clip(s.description), ...(logUrl ? { log_url: logUrl } : {}), auto_inactive: false });

  const id = await github.createDeployment(repo, {
    ref: sha,
    environment,
    description: clip(`The preview of this branch on ${site.split('/')[1]}`),
    transient_environment: true,
    production_environment: false,
    required_contexts: [],
    auto_merge: false,
  });
  if (!preview.accepted) {
    await github.createDeploymentStatus(repo, id, status({ state: 'failure', description: REFUSED }));
    throw new Refusal(REFUSED);
  }
  let seen;
  try {
    await github.createDeploymentStatus(repo, id, status({ state: 'in_progress', description: 'The preview is building.' }));
    const after = await sinceWhen(github, repo, ref, sha);
    seen = await awaitPreview({
      site, siteGithub, link: preview, after, waitMs: Number(opts.wait) * 60000,
      ...(io.fetch ? { fetchImpl: io.fetch } : {}), ...(io.pollMs ? { pollMs: io.pollMs } : {}),
      ...(io.clock ? { now: io.clock } : {}), ...(io.sleep ? { sleep: io.sleep } : {}),
    });
  } catch (e) {
    // The deployment never stays `in progress` for a run that stopped.
    await github.createDeploymentStatus(repo, id, status({ state: 'error', description: 'The preview could not be checked: see the run.' })).catch(() => {});
    throw e;
  }
  const final = finalStatus(seen, preview, opts.wait);
  await github.createDeploymentStatus(repo, id, status(final));
  if (final.state !== 'success') throw new Refusal(final.description);
  out.write(`Linked ${preview.url} as the ${environment} deployment ${id} of ${sha.slice(0, 7)}: ${final.description}\n`);
  return { code: 0 };
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const [action, ...rest] = argv;
  try {
    if (action === '--help' || action === '-h') {
      out.write(`${USAGE}\n`);
      return 0;
    }
    const step = { start, link }[action];
    if (!step) throw new ReleaseError(`docs-preview needs start or link, not ${action === undefined ? 'nothing' : JSON.stringify(String(action).slice(0, 20))}`);
    const done = await step(rest, { env, out, io });
    if (done.help) {
      out.write(`${USAGE}\n`);
      return 0;
    }
    return done.code;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Docs preview::${escapeData(e.message)}\n`);
      err.write(`shipyard docs-preview: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof PreviewError)) throw e;
    out.write(`::error title=Docs preview::${escapeData(e.message)}\n`);
    err.write(`shipyard docs-preview: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required)|docs-preview needs)/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE, finalStatus };
