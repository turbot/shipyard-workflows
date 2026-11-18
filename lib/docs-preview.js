'use strict';

// A docs repo's site preview (workflows/docs-preview.yml, `shipyard docs-preview`). A push to a docs branch starts the
// site's preview workflow, which builds the site branch `docs/<prefix><branch>` on Vercel. On a PR, the preview is linked
// as a GitHub deployment of the PR's head commit. Nothing here writes a comment or a PR body: a deployment is neither, so a
// public docs repo's PR is never held for an outsider's text.

// The sites build nothing for a branch name outside this.
const ACCEPTED_REF = /^[A-Za-z0-9._/-]+$/;
// Vercel shortens a host label over 63 characters with a hash nobody can work out.
const MAX_HOST_LABEL = 63;
// The Vercel team every site deploys under: the last part of a branch alias, `<project>-git-<branch>-<team>`.
const VERCEL_TEAM = 'turbot';

const SITE = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
const PROJECT = /^[a-z0-9][a-z0-9-]{0,99}$/;
const PREFIX = /^(?:[A-Za-z0-9._-]+\/)*$/;
const WORKFLOW = /^[A-Za-z0-9._-]+\.ya?ml$/;

const DEFAULT_WAIT_MS = 20 * 60 * 1000;
const DEFAULT_POLL_MS = 20 * 1000;

class PreviewError extends Error {}

// The site branch the preview builds for a docs branch.
const siteBranchOf = (prefix, ref) => `docs/${prefix}${ref}`;

// Vercel's name for a branch in a host: lower-cased, its first `/` turned into `-`, and every character outside
// `[a-z0-9-]` dropped. It matched every past alias of the sites.
const cleanBranch = (branch) => branch.toLowerCase().replace('/', '-').replace(/[^a-z0-9-]/g, '');

// The page that lists every preview of the site, for a branch whose own link cannot be worked out.
const allPreviewsOf = (site) => `https://github.com/${site}/deployments/Preview`;

/**
 * The link rule. Returns `{ accepted, branch, host, url, linked }`:
 * - `accepted` false when the site refuses the branch name (no build is started, and no link is given);
 * - `host` the branch alias (`<project>-git-<branch>-turbot`) and `url` its address when it can be worked out;
 * - else `host` null and `url` the site's page of every preview: the alias would be over 63 characters, or the
 *   branch name has nothing left once cleaned.
 */
function previewLink({ site, project, prefix = '', ref }) {
  if (typeof ref !== 'string' || !ACCEPTED_REF.test(ref)) {
    return { accepted: false, branch: null, host: null, url: null, linked: false };
  }
  const branch = siteBranchOf(prefix, ref);
  const host = `${project}-git-${cleanBranch(branch)}-${VERCEL_TEAM}`;
  // `docs-` is always left: a name with nothing of its own once cleaned has no alias of its own either.
  if (cleanBranch(ref) === '' || host.length > MAX_HOST_LABEL) {
    return { accepted: true, branch, host: null, url: allPreviewsOf(site), linked: false };
  }
  return { accepted: true, branch, host, url: `https://${host}.vercel.app`, linked: true };
}

// The deployment environment of a site's previews: `<site name> preview`, so a PR shows "deployed to powerpipe.io preview".
// Never one that starts with `production`, which deployment.yml reads as a release's ship signal.
function environmentOf(site) {
  const name = site.split('/')[1];
  const environment = `${name} preview`;
  if (/^production/i.test(environment)) throw new PreviewError(`the site ${site} would make a deployment environment that starts with "production", which deployment.yml reads as the ship signal`);
  return environment;
}

function checkSite(site) {
  if (typeof site !== 'string' || !SITE.test(site)) throw new PreviewError('--site is the site repo, as <owner>/<name>');
  return site;
}

function checkPrefix(prefix) {
  if (typeof prefix !== 'string' || prefix.length > 40 || !PREFIX.test(prefix)) {
    throw new PreviewError('--prefix is empty or a branch prefix that ends in "/", such as pipes/');
  }
  return prefix;
}

function checkProject(project) {
  if (typeof project !== 'string' || !PROJECT.test(project)) throw new PreviewError('--project is the Vercel project slug, such as powerpipe-io');
  return project;
}

function checkWorkflow(workflow) {
  if (typeof workflow !== 'string' || !WORKFLOW.test(workflow)) throw new PreviewError('--workflow is the file name of the site\'s preview workflow, such as build-preview.yml');
  return workflow;
}

const FAILED = new Set(['failure', 'error']);

// The newest Vercel preview deployment of a commit: its environment starts with `preview` (`Preview`, or
// `Preview – <project>` for a monorepo). GitHub numbers deployments upwards, so the highest id.
function newestPreview(deployments, sha) {
  return (deployments || [])
    .filter((d) => d && d.sha === sha && typeof d.environment === 'string' && /^preview/i.test(d.environment) && Number.isSafeInteger(d.id))
    .sort((a, b) => b.id - a.id)[0] || null;
}

const stateOf = (statuses) => {
  const live = (statuses || []).find((s) => s && s.state !== 'inactive');
  return live && typeof live.state === 'string' ? live.state : 'pending';
};

// A token that cannot see the site, or its deployments, answers 403 or 404: the site's build cannot be read.
const unreadable = (e) => e && (e.status === 401 || e.status === 403 || e.status === 404);

/**
 * One look at the site's build of this push: the head of the site branch, once it is no older than the docs commit (an
 * older head is an earlier push's build), and its newest Vercel preview deployment. Returns `{ state, detail }`:
 * `success`, `failure`, `waiting` or `unreadable` (the token cannot read the site's branch or deployments).
 */
async function siteBuildState({ site, siteGithub, branch, after }) {
  let head;
  try {
    head = await siteGithub.branchHead(site, branch);
  } catch (e) {
    if (unreadable(e)) return { state: 'unreadable', detail: `the site's branch could not be read (${e.status})` };
    throw e;
  }
  if (!head) {
    // No such branch yet, or a token that cannot see the site: GitHub answers 404 to both. The repo itself tells them apart.
    const branchOfSite = await siteGithub.defaultBranch(site).catch((e) => {
      if (unreadable(e)) return null;
      throw e;
    });
    if (!branchOfSite) return { state: 'unreadable', detail: 'the site could not be read' };
    return { state: 'waiting', detail: `the site has no ${branch} yet` };
  }
  if (!(Date.parse(head.date) >= after)) return { state: 'waiting', detail: `the site's ${branch} still holds an earlier build` };
  let newest;
  try {
    newest = newestPreview(await siteGithub.listDeployments(site, head.sha), head.sha);
  } catch (e) {
    if (unreadable(e)) return { state: 'unreadable', detail: `the site's deployments could not be read (${e.status})` };
    throw e;
  }
  if (!newest) return { state: 'waiting', detail: `the site's build of ${head.sha.slice(0, 7)} has not started` };
  let state;
  try {
    state = stateOf(await siteGithub.listDeploymentStatuses(site, newest.id));
  } catch (e) {
    if (unreadable(e)) return { state: 'unreadable', detail: `the site's deployment statuses could not be read (${e.status})` };
    throw e;
  }
  if (state === 'success') return { state: 'success', detail: `the site's build of ${head.sha.slice(0, 7)} is up` };
  if (FAILED.has(state)) return { state: 'failure', detail: `the site's build of ${head.sha.slice(0, 7)} reported ${state}` };
  return { state: 'waiting', detail: `the site's build of ${head.sha.slice(0, 7)} is ${String(state).replace('_', ' ').slice(0, 20)}` };
}

// Whether the branch alias answers 200 from its own host (a redirect to a sign-in page is not the preview).
async function aliasAnswers(fetchImpl, url) {
  try {
    const res = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(15000) });
    if (res.body && typeof res.body.cancel === 'function') await res.body.cancel().catch(() => {});
    return res.status === 200 && new URL(res.url || url).hostname === new URL(url).hostname;
  } catch {
    return false;
  }
}

/**
 * Waits for the preview of this push. With a token that reads the site, it waits for the site's Vercel deployment of
 * the head of the site branch (`checked: 'build'`); else for the branch alias to answer 200 (`checked: 'link'`), which
 * may still be an earlier push's build; with neither, nothing can be checked (`checked: 'none'`). Returns
 * `{ state: 'success' | 'failure' | 'waiting', checked, detail }`; `waiting` is the deadline passing. The clock, the
 * sleep and fetch are the caller's, so a test never waits.
 */
async function awaitPreview({
  site, siteGithub, link, after, waitMs = DEFAULT_WAIT_MS, pollMs = DEFAULT_POLL_MS, fetchImpl = globalThis.fetch,
  now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  const deadline = now() + waitMs;
  let canRead = Boolean(siteGithub);
  let why = siteGithub ? null : 'no token for the site';
  for (;;) {
    if (canRead) {
      const seen = await siteBuildState({ site, siteGithub, branch: link.branch, after });
      if (seen.state === 'success' || seen.state === 'failure') return { ...seen, checked: 'build' };
      if (seen.state === 'unreadable') {
        canRead = false;
        why = seen.detail;
      } else if (now() + pollMs > deadline) {
        return { state: 'waiting', checked: 'build', detail: seen.detail };
      }
    }
    if (!canRead) {
      if (!link.linked) return { state: 'success', checked: 'none', detail: why };
      if (await aliasAnswers(fetchImpl, link.url)) return { state: 'success', checked: 'link', detail: why };
      if (now() + pollMs > deadline) return { state: 'waiting', checked: 'link', detail: `the preview did not answer (${why})` };
    }
    await sleep(pollMs);
  }
}

module.exports = {
  ACCEPTED_REF, MAX_HOST_LABEL, VERCEL_TEAM, DEFAULT_WAIT_MS, DEFAULT_POLL_MS, PreviewError,
  siteBranchOf, cleanBranch, allPreviewsOf, previewLink, environmentOf, checkSite, checkPrefix, checkProject, checkWorkflow,
  newestPreview, siteBuildState, aliasAnswers, awaitPreview,
};
