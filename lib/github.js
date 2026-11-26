'use strict';

// A small GitHub REST client over fetch: the calls the changelog-line check, the release
// steps (facts, cut, record, ask, tag) and the publish step make.

class GitHubError extends Error {
  constructor(message, status, options) {
    super(message, options);
    this.status = status;
  }
}

const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 30; // GitHub lists at most 3000 files of a PR
const MAX_LIST_PAGES = 50;
const MAX_CLOSED_PAGES = 10;
const TAGS_PER_PAGE = 100;
const MAX_TAG_PAGES = 100;

const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;

// A read that GitHub answers with one of these, that times out or whose connection drops is tried
// again: up to `READ_WAITS_MS.length + 1` tries in all, after each wait in turn. A write is never
// tried again.
const RETRY_STATUSES = new Set([502, 503, 504]);
const READ_WAITS_MS = [2000, 5000];
const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isTimeout = (e) => Boolean(e) && (e.name === 'TimeoutError' || e.name === 'AbortError');

// Node's `fetch` fails with a TypeError `fetch failed` when a connection drops, resets or cannot be
// resolved; the reason (`ECONNRESET`, ...) is in its cause.
const isDropped = (e) => e instanceof TypeError && /fetch failed/i.test(e.message);

// The reason a dropped connection gives: its cause's code, else its message, on one short line. It
// never holds the token or a header, which `fetch` does not put in its errors.
function reasonOf(e) {
  const cause = e && e.cause;
  const reason = cause && (typeof cause.code === 'string' && cause.code ? cause.code : cause.message);
  return String(reason || 'fetch failed').replace(/\s+/g, ' ').slice(0, 200);
}

// A Release as GitHub answers it: its link and ID, the upload address it names (`...{?name,label}`)
// and the files it holds so far.
function releaseOf(data, what) {
  if (!data || typeof data.html_url !== 'string') throw new GitHubError(`GitHub answered something that is not a release ${what}`, 200);
  const assets = (Array.isArray(data.assets) ? data.assets : [])
    .filter((a) => a && Number.isSafeInteger(a.id) && typeof a.name === 'string')
    .map((a) => ({
      id: a.id, name: a.name, size: a.size, state: a.state, digest: typeof a.digest === 'string' ? a.digest : null,
    }));
  return {
    url: data.html_url,
    id: Number.isSafeInteger(data.id) ? data.id : null,
    uploadUrl: typeof data.upload_url === 'string' ? data.upload_url : null,
    assets,
  };
}

// Where a file of a Release is uploaded: the `upload_url` GitHub gave, without its template. It must
// end in this Release's assets and sit on GitHub's own upload host for the API in use (uploads.github.com
// for api.github.com, else the API's own host), so the release token is sent nowhere else.
function uploadUrlOf(release, apiUrl) {
  let url;
  let api;
  if (!release.uploadUrl || release.id === null) throw new GitHubError('GitHub gave a Release with no ID or upload address', 200);
  try {
    url = new URL(String(release.uploadUrl).replace(/\{\?[^}]*\}$/, ''));
    api = new URL(apiUrl);
  } catch {
    throw new GitHubError('GitHub gave an upload address that is not a URL', 200);
  }
  const host = api.hostname === 'api.github.com' ? 'uploads.github.com' : api.hostname;
  if (url.protocol !== api.protocol || url.hostname !== host || url.search || url.hash || url.username || url.password || !/\/releases\/[0-9]+\/assets$/.test(url.pathname)
    || !url.pathname.endsWith(`/releases/${release.id}/assets`)) {
    throw new GitHubError(`GitHub gave an upload address that is not an upload address of this Release on ${host}`, 200);
  }
  return url;
}

// GitHub's GraphQL endpoint beside a REST one: `https://api.github.com/graphql`, or on a GitHub
// Enterprise Server `https://<host>/api/graphql` beside `https://<host>/api/v3`.
const graphqlUrlOf = (apiUrl) => `${apiUrl.replace(/\/+$/, '').replace(/\/v3$/, '')}/graphql`;

function createClient({
  token, apiUrl = 'https://api.github.com', graphqlUrl, fetchImpl = globalThis.fetch, timeoutMs = 20000, pageSize = FILES_PER_PAGE,
  sleep = realSleep, readWaitsMs = READ_WAITS_MS,
} = {}) {
  const graphqlAt = graphqlUrl || graphqlUrlOf(apiUrl);

  // What a dropped connection fails with: it names the call and the reason, and `dropped` lets a caller
  // tell it from an answer GitHub gave (it has no status).
  function droppedError(what, e) {
    const err = new GitHubError(`GitHub could not be reached for ${what}: ${reasonOf(e)}`, undefined, { cause: e });
    err.dropped = true;
    return err;
  }

  async function graphql(query, variables) {
    let res;
    try {
      res = await fetchImpl(graphqlAt, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'shipyard',
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (!isDropped(e)) throw e;
      throw droppedError('a GraphQL call', e);
    }
    if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} to a GraphQL query`, res.status);
    const answer = await res.json();
    if (answer && Array.isArray(answer.errors) && answer.errors.length) {
      const first = String((answer.errors[0] && answer.errors[0].message) || 'an error').replace(/\s+/g, ' ').slice(0, 200);
      throw new GitHubError(`GitHub's GraphQL API answered: ${first}`, 200);
    }
    return answer && answer.data;
  }

  // One try of a call: the answer's status and body, or the error it fails with.
  async function attempt(method, path, payload) {
    let res;
    try {
      res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}${path}`, {
        method,
        headers: {
          Accept: 'application/vnd.github+json',
          'User-Agent': 'shipyard',
          'X-GitHub-Api-Version': '2022-11-28',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      if (!isDropped(e)) throw e;
      throw droppedError(`${method} ${path}`, e);
    }
    if (res.status === 404 && method === 'GET') return { status: 404, data: null };
    if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} to ${method} ${path}`, res.status);
    // 204 No Content (a workflow dispatch) has no body to read.
    if (res.status === 204) return { status: 204, data: null };
    return { status: res.status, data: await res.json() };
  }

  // A read that fails in a way a second try can clear (a 502, 503 or 504, a timeout or a dropped connection) is tried again
  // after each wait of `readWaitsMs`; the last failure is the one thrown. Any other call, and any
  // other failure (a 4xx, a body that is not JSON), is sent once.
  async function request(method, path, payload) {
    for (let i = 0; ; i++) {
      try {
        return await attempt(method, path, payload);
      } catch (e) {
        const transient = isTimeout(e) || (e instanceof GitHubError && (e.dropped === true || RETRY_STATUSES.has(e.status)));
        if (method !== 'GET' || !transient || i >= readWaitsMs.length) throw e;
        await sleep(readWaitsMs[i]);
      }
    }
  }

  const repoPath = (repo) => `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;

  // A list that pages `pageSize` (100) at a time; stops at a short page, or fails at the page cap rather
  // than answer with a list that may be short.
  async function pages(path, what) {
    const joiner = path.includes('?') ? '&' : '?';
    const items = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const { status, data } = await request('GET', `${path}${joiner}per_page=${pageSize}&page=${page}`);
      if (status === 404) throw new GitHubError(`${what} not found`, 404);
      if (!Array.isArray(data)) throw new GitHubError(`GitHub answered something that is not a list to GET ${path}`, 200);
      items.push(...data);
      if (data.length < pageSize) return items;
    }
    throw new GitHubError(`${what} has more than ${MAX_LIST_PAGES * pageSize} entries at ${path}; refusing to use a list that may be short`, 200);
  }

  // Every tag with the commit it names (`{ name, sha }`), all pages, read as listTags reads them.
  async function listTagCommits(repo) {
    const tags = [];
    for (let page = 1; page <= MAX_TAG_PAGES; page++) {
      const { status, data } = await request('GET', `${repoPath(repo)}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`);
      if (status === 404 || !Array.isArray(data) || data.some((t) => !t || typeof t.name !== 'string')) {
        throw new GitHubError(`GitHub did not list the tags of ${repo}`, status);
      }
      tags.push(...data.map((t) => ({ name: t.name, sha: t.commit && typeof t.commit.sha === 'string' ? t.commit.sha : null })));
      if (data.length < TAGS_PER_PAGE) return tags;
    }
    throw new GitHubError(`${repo} has more than ${MAX_TAG_PAGES * TAGS_PER_PAGE} tags: too many to read them all`, 200);
  }

  return {
    async getPull(repo, number) {
      const { status, data } = await request('GET', `${repoPath(repo)}/pulls/${number}`);
      if (status === 404) throw new GitHubError(`Pull request ${repo}#${number} not found`, 404);
      return data;
    },
    async updatePullBody(repo, number, body) {
      await request('PATCH', `${repoPath(repo)}/pulls/${number}`, { body });
    },
    // Turns a PR into a draft (`draft` true) or marks it ready for review (false). Only GraphQL can: the REST
    // API has no call for it. `pr` is a PR as `getPull` answers it, whose `node_id` the mutation needs. A
    // PR that is already as asked is left as it is. Returns whether it changed anything.
    async setPullDraft(pr, draft) {
      if (!pr || typeof pr.node_id !== 'string' || !pr.node_id) throw new GitHubError('GitHub gave no node id for the pull request, so it cannot be made a draft or ready', 200);
      if ((pr.draft === true) === draft) return false;
      const name = draft ? 'convertPullRequestToDraft' : 'markPullRequestReadyForReview';
      const data = await graphql(
        `mutation($id: ID!) { ${name}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
        { id: pr.node_id },
      );
      const done = data && data[name] && data[name].pullRequest;
      if (!done || done.isDraft !== draft) throw new GitHubError(`GitHub did not ${draft ? 'make the pull request a draft' : 'mark it ready for review'}`, 200);
      return true;
    },
    // Turns on auto-merge for a PR, with `method` (`merge`, `squash` or `rebase`): GitHub then merges it once every
    // rule of its base branch is met (the approval, the required checks). Only GraphQL can: the REST API has no call
    // for it. `pr` is a PR as `getPull` answers it, whose `node_id` the mutation needs. A repo that does not allow
    // auto-merge is GitHub's error, which reaches the caller as a GitHubError saying so.
    async enablePullAutoMerge(pr, method) {
      if (!pr || typeof pr.node_id !== 'string' || !pr.node_id) throw new GitHubError('GitHub gave no node id for the pull request, so auto-merge cannot be turned on', 200);
      const mergeMethod = { merge: 'MERGE', squash: 'SQUASH', rebase: 'REBASE' }[method];
      if (!mergeMethod) throw new GitHubError(`auto-merge method ${JSON.stringify(method)} is not merge, squash or rebase`, 200);
      const data = await graphql(
        'mutation($id: ID!, $method: PullRequestMergeMethod!) { enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $method }) { pullRequest { autoMergeRequest { mergeMethod } } } }',
        { id: pr.node_id, method: mergeMethod },
      );
      const asked = data && data.enablePullRequestAutoMerge && data.enablePullRequestAutoMerge.pullRequest
        && data.enablePullRequestAutoMerge.pullRequest.autoMergeRequest;
      if (!asked || asked.mergeMethod !== mergeMethod) throw new GitHubError('GitHub did not turn on auto-merge for the pull request', 200);
    },
    // Every file the PR changes: `filename`, plus `previous_filename` on a rename. The API
    // pages 100 at a time and lists at most 3000 files; `truncated` says the list may be
    // short, so a caller must not read it as "all the files".
    async listPullFiles(repo, number) {
      const files = [];
      for (let page = 1; page <= MAX_FILE_PAGES; page++) {
        const { status, data } = await request('GET', `${repoPath(repo)}/pulls/${number}/files?per_page=${FILES_PER_PAGE}&page=${page}`);
        if (status === 404) throw new GitHubError(`Pull request ${repo}#${number} not found`, 404);
        if (!Array.isArray(data)) throw new GitHubError(`GitHub answered something that is not a file list to GET ${repoPath(repo)}/pulls/${number}/files`, 200);
        files.push(...data);
        if (data.length < FILES_PER_PAGE) return { files, truncated: false };
      }
      return { files, truncated: true };
    },
    // Every review of a PR, oldest first, as the API lists them (`user.login`, `state`).
    async listPullReviews(repo, number) {
      return pages(`${repoPath(repo)}/pulls/${number}/reviews`, `Pull request ${repo}#${number}`);
    },
    // Every PR, open or closed, whose head is `branch` of this same repo. The API's own
    // `head=` filter is advisory, so the answer is filtered again: a fork that names its
    // branch the same must never count as the repo's own candidate.
    async listPullsByHead(repo, branch) {
      const owner = repo.split('/')[0];
      const all = await pages(`${repoPath(repo)}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}`, `Repo ${repo}`);
      return all.filter((p) => p && p.head && p.head.ref === branch
        && p.head.repo && String(p.head.repo.full_name).toLowerCase() === repo.toLowerCase());
    },
    // Every open PR of this repo, as the API lists them (`head.ref`, `head.repo`, `base.ref`).
    async listOpenPulls(repo) {
      return pages(`${repoPath(repo)}/pulls?state=open`, `Repo ${repo}`);
    },
    // The most recently updated closed PRs, one page: enough to see a release PR that merged
    // lately without reading a repo's whole history.
    async listRecentClosedPulls(repo) {
      const { status, data } = await request('GET', `${repoPath(repo)}/pulls?state=closed&sort=updated&direction=desc&per_page=${FILES_PER_PAGE}`);
      if (status === 404 || !Array.isArray(data)) throw new GitHubError(`GitHub did not list the closed pull requests of ${repo}`, status);
      return data;
    },
    // A person's GitHub profile name, or null when they set none or GitHub has no such login.
    async getUserName(login) {
      const { status, data } = await request('GET', `/users/${encodeURIComponent(login)}`);
      if (status === 404 || !data) return null;
      return typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;
    },
    // The open issues that carry a label, PRs left out (the issues API lists both).
    async listOpenIssuesByLabel(repo, label) {
      const all = await pages(`${repoPath(repo)}/issues?state=open&labels=${encodeURIComponent(label)}`, `Repo ${repo}`);
      return all.filter((i) => i && !i.pull_request);
    },
    // The closed issues that carry a label, newest first, PRs left out. `since` (an ISO time) ends the read: pages are read
    // until one holds an issue made before it, and the issues made before it are left out. A list longer than
    // MAX_CLOSED_PAGES pages is cut there, not an error: the caller asks only about a recent issue, so a short list can
    // only make it miss a very old one.
    async listClosedIssuesByLabel(repo, label, { since = null } = {}) {
      const sinceMs = since === null ? null : Date.parse(since);
      const found = [];
      for (let page = 1; page <= MAX_CLOSED_PAGES; page++) {
        const { status, data } = await request('GET', `${repoPath(repo)}/issues?state=closed&labels=${encodeURIComponent(label)}&sort=created&direction=desc&per_page=${pageSize}&page=${page}`);
        if (status === 404) throw new GitHubError(`Repo ${repo} not found`, 404);
        if (!Array.isArray(data)) throw new GitHubError(`GitHub answered something that is not a list to GET ${repoPath(repo)}/issues?state=closed`, 200);
        for (const i of data) {
          if (!i || i.pull_request) continue;
          if (sinceMs !== null && Date.parse(i.created_at) < sinceMs) return found;
          found.push(i);
        }
        if (data.length < pageSize) return found;
      }
      return found;
    },
    // Rewrites an issue's body, leaving its title, labels and state as they are.
    async updateIssueBody(repo, number, body) {
      await request('PATCH', `${repoPath(repo)}/issues/${number}`, { body });
    },
    async closeIssue(repo, number) {
      await request('PATCH', `${repoPath(repo)}/issues/${number}`, { state: 'closed', state_reason: 'completed' });
    },
    // How `head` stands to `base` (`ahead`, `identical`, `behind` or `diverged`): `ahead` or
    // `identical` means head contains base. Null when GitHub cannot compare them.
    async compareStatus(repo, base, head) {
      const { status, data } = await request('GET', `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);
      if (status === 404 || !data || typeof data.status !== 'string') return null;
      return data.status;
    },
    // The commit where `head` left `base` (the merge base), or null when GitHub cannot compare them. One commit of the
    // comparison is asked for: only the merge base is read.
    async mergeBase(repo, base, head) {
      const { status, data } = await request('GET', `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`);
      if (status === 404) return null;
      const sha = data && data.merge_base_commit && data.merge_base_commit.sha;
      if (typeof sha !== 'string' || !sha) throw new GitHubError(`GitHub answered something that is not a comparison to GET ${repoPath(repo)}/compare/${base}...${head}`, status);
      return sha;
    },
    // The commits `head` holds that `base` does not, oldest first, with how `head` stands to `base` (as
    // compareStatus): `{ status, commits: [{ sha, subject, parents }] }`, `subject` being the message's first
    // line and `parents` its parents' shas, the first parent first. Every page is read, and a list shorter than GitHub's own count
    // of the commits is an error, never a shorter range. Null when GitHub cannot compare them.
    async compareCommits(repo, base, head) {
      const path = `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`;
      const commits = [];
      let total = null;
      let status = null;
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const answer = await request('GET', `${path}?per_page=${FILES_PER_PAGE}&page=${page}`);
        if (answer.status === 404) return null;
        const { data } = answer;
        if (!data || typeof data.status !== 'string' || !Number.isSafeInteger(data.total_commits) || !Array.isArray(data.commits)) {
          throw new GitHubError(`GitHub answered something that is not a comparison to GET ${path}`, 200);
        }
        ({ status } = data);
        total = data.total_commits;
        for (const c of data.commits) {
          if (!c || typeof c.sha !== 'string' || !c.commit || typeof c.commit.message !== 'string') {
            throw new GitHubError(`GitHub answered a commit with no sha or message to GET ${path}`, 200);
          }
          const parents = Array.isArray(c.parents) ? c.parents.map((p) => p && p.sha).filter((sha) => typeof sha === 'string') : [];
          commits.push({ sha: c.sha, subject: c.commit.message.split('\n')[0], parents });
        }
        if (commits.length >= total || data.commits.length < FILES_PER_PAGE) break;
      }
      if (commits.length !== total) {
        throw new GitHubError(`GitHub listed ${commits.length} of the ${total} commits from ${base} to ${head} in ${repo}; refusing to use a list that may be short`, 200);
      }
      return { status, commits };
    },
    async createIssue(repo, { title, body, labels }) {
      const { data } = await request('POST', `${repoPath(repo)}/issues`, { title, body, labels });
      if (!data || typeof data.number !== 'number') throw new GitHubError(`GitHub answered something that is not an issue to POST ${repoPath(repo)}/issues`, 200);
      return { number: data.number, url: data.html_url };
    },
    // An issue as the API returns it (`user.login`), or null when there is none. A PR number
    // answers too, as an issue; the caller reads only who opened it.
    async getIssue(repo, number) {
      const { data } = await request('GET', `${repoPath(repo)}/issues/${number}`);
      return data;
    },
    // The issues GitHub itself links to a PR as the ones it closes (`{ repo, number }`): set by a
    // closing keyword in a PR into the default branch, or in the PR's Development sidebar. This is
    // GitHub's record, kept after the merge, not the body's text, which anyone may edit later.
    async listClosingIssues(repo, number) {
      const [owner, name] = repo.split('/');
      const data = await graphql(
        'query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) { closingIssuesReferences(first: 100) { totalCount nodes { number repository { nameWithOwner } } } } } }',
        { owner, name, number },
      );
      const pr = data && data.repository && data.repository.pullRequest;
      if (!pr) throw new GitHubError(`Pull request ${repo}#${number} not found`, 404);
      const refs = pr.closingIssuesReferences;
      if (!refs || !Array.isArray(refs.nodes)) throw new GitHubError(`GitHub answered no list of linked issues for ${repo}#${number}`, 200);
      if (Number(refs.totalCount) > refs.nodes.length) {
        throw new GitHubError(`${repo}#${number} links more than ${refs.nodes.length} issues; refusing to use a list that may be short`, 200);
      }
      const linked = refs.nodes.map((n) => ({ repo: String(n && n.repository && n.repository.nameWithOwner), number: Number(n && n.number) }));
      // An entry GitHub could not fill in (an issue the token cannot read) is not dropped: the list would be short.
      if (linked.some((n) => !/^[^/\s]+\/[^/\s]+$/.test(n.repo) || !Number.isInteger(n.number) || n.number < 1)) {
        throw new GitHubError(`GitHub answered a linked issue of ${repo}#${number} it could not name`, 200);
      }
      return linked;
    },
    // Every event of an issue or a PR, oldest first (`event`, `actor.login`, `label.name`).
    async listIssueEvents(repo, number) {
      return pages(`${repoPath(repo)}/issues/${number}/events`, `Issue ${repo}#${number}`);
    },
    // Every check run on a commit: `name`, `status` and `conclusion`.
    async listCheckRuns(repo, sha) {
      const runs = [];
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const { status, data } = await request('GET', `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/check-runs?per_page=${FILES_PER_PAGE}&page=${page}`);
        if (status === 404) throw new GitHubError(`Commit ${sha} of ${repo} not found`, 404);
        if (!data || !Array.isArray(data.check_runs)) throw new GitHubError(`GitHub answered something that is not a check-run list for ${sha}`, 200);
        runs.push(...data.check_runs);
        if (data.check_runs.length < FILES_PER_PAGE) return runs;
      }
      throw new GitHubError(`${sha} has more than ${MAX_LIST_PAGES * FILES_PER_PAGE} check runs; refusing to use a list that may be short`, 200);
    },
    // Every workflow run made for a commit (`actions/runs?head_sha=`): `id`, `event`, `name`, `path` and
    // `check_suite_id`. It maps an Actions check run to the event that started its workflow.
    async listWorkflowRuns(repo, sha) {
      const all = [];
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const { status, data } = await request('GET', `${repoPath(repo)}/actions/runs?head_sha=${encodeURIComponent(sha)}&per_page=${FILES_PER_PAGE}&page=${page}`);
        if (status === 404) throw new GitHubError(`Commit ${sha} of ${repo} not found`, 404);
        if (!data || !Array.isArray(data.workflow_runs)) throw new GitHubError(`GitHub answered something that is not a workflow-run list for ${sha}`, 200);
        all.push(...data.workflow_runs);
        if (data.workflow_runs.length < FILES_PER_PAGE) return all;
      }
      throw new GitHubError(`${sha} has more than ${MAX_LIST_PAGES * FILES_PER_PAGE} workflow runs; refusing to use a list that may be short`, 200);
    },
    // The jobs of a workflow run's latest attempt (`actions/runs/<id>/jobs`): `name`, `conclusion` and
    // `steps` (each `name` and `conclusion`). It says where a failed ship run failed.
    async listRunJobs(repo, runId) {
      const all = [];
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const { status, data } = await request('GET', `${repoPath(repo)}/actions/runs/${encodeURIComponent(runId)}/jobs?filter=latest&per_page=${FILES_PER_PAGE}&page=${page}`);
        if (status === 404) throw new GitHubError(`Workflow run ${runId} of ${repo} not found`, 404);
        if (!data || !Array.isArray(data.jobs)) throw new GitHubError(`GitHub answered something that is not a job list for run ${runId}`, 200);
        all.push(...data.jobs);
        if (data.jobs.length < FILES_PER_PAGE) return all;
      }
      throw new GitHubError(`run ${runId} has more than ${MAX_LIST_PAGES * FILES_PER_PAGE} jobs; refusing to use a list that may be short`, 200);
    },
    // The artifacts of a workflow run (`actions/runs/<id>/artifacts`): `name`, `expired` and `expires_at`. A review
    // reads it to learn whether the release run's `results` are still there before it downloads them.
    async listRunArtifacts(repo, runId) {
      const all = [];
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const { status, data } = await request('GET', `${repoPath(repo)}/actions/runs/${encodeURIComponent(runId)}/artifacts?per_page=${FILES_PER_PAGE}&page=${page}`);
        if (status === 404) throw new GitHubError(`Workflow run ${runId} of ${repo} not found`, 404);
        if (!data || !Array.isArray(data.artifacts)) throw new GitHubError(`GitHub answered something that is not an artifact list for run ${runId}`, 200);
        all.push(...data.artifacts);
        if (data.artifacts.length < FILES_PER_PAGE) return all;
      }
      throw new GitHubError(`run ${runId} has more than ${MAX_LIST_PAGES * FILES_PER_PAGE} artifacts; refusing to use a list that may be short`, 200);
    },
    // Every commit status (the status API, as `statuses` of the combined status): `context` and
    // `state` (`success`, `pending`, `failure` or `error`).
    async listCommitStatuses(repo, sha) {
      const all = [];
      for (let page = 1; page <= MAX_LIST_PAGES; page++) {
        const { status, data } = await request('GET', `${repoPath(repo)}/commits/${encodeURIComponent(sha)}/status?per_page=${FILES_PER_PAGE}&page=${page}`);
        if (status === 404) throw new GitHubError(`Commit ${sha} of ${repo} not found`, 404);
        if (!data || !Array.isArray(data.statuses)) throw new GitHubError(`GitHub answered something that is not a status list for ${sha}`, 200);
        all.push(...data.statuses);
        if (data.statuses.length < FILES_PER_PAGE) return all;
      }
      throw new GitHubError(`${sha} has more than ${MAX_LIST_PAGES * FILES_PER_PAGE} statuses; refusing to use a list that may be short`, 200);
    },
    // The deployments made for a commit (`deployments?sha=`): `id`, `sha`, `environment` and `created_at`. Vercel makes one
    // for each deploy of a commit, `Production` for the production deploy.
    async listDeployments(repo, sha) {
      return pages(`${repoPath(repo)}/deployments?sha=${encodeURIComponent(sha)}`, `Deployments of ${sha} in ${repo}`);
    },
    // The statuses of one deployment, newest first: `state` (`queued`, `pending`, `in_progress`, `success`, `failure`,
    // `error` or `inactive`).
    async listDeploymentStatuses(repo, id) {
      return pages(`${repoPath(repo)}/deployments/${encodeURIComponent(id)}/statuses`, `Deployment ${id} of ${repo}`);
    },
    // The login the token belongs to, or null when it has none: a GitHub App's installation token
    // is no one (GitHub answers 403 or 404 to `GET /user`), a personal access token is a user.
    async viewerLogin() {
      try {
        const { status, data } = await request('GET', '/user');
        return status === 200 && data && typeof data.login === 'string' ? data.login : null;
      } catch (e) {
        if (e instanceof GitHubError && (e.status === 403 || e.status === 404)) return null;
        throw e;
      }
    },
    // An Actions run of a repo (`path`, `event`, `head_branch`, `repository`, `head_repository`),
    // or null when the repo has no such run.
    async getWorkflowRun(repo, id) {
      const { status, data } = await request('GET', `${repoPath(repo)}/actions/runs/${encodeURIComponent(id)}`);
      if (status === 404) return null;
      if (!data || typeof data !== 'object') throw new GitHubError(`GitHub answered something that is not a run to GET ${repoPath(repo)}/actions/runs/${id}`, status);
      return data;
    },
    // The comments of an issue or a PR, oldest first (`id`, `body`, `user.type`, `user.login`).
    async listIssueComments(repo, number) {
      return pages(`${repoPath(repo)}/issues/${number}/comments`, `Issue ${repo}#${number}`);
    },
    async createIssueComment(repo, number, body) {
      const { data } = await request('POST', `${repoPath(repo)}/issues/${number}/comments`, { body });
      return data;
    },
    async updateIssueComment(repo, id, body) {
      await request('PATCH', `${repoPath(repo)}/issues/comments/${encodeURIComponent(id)}`, { body });
    },
    // A branch's tip commit, or null when there is no such branch.
    async branchTip(repo, branch) {
      const { status, data } = await request('GET', `${repoPath(repo)}/branches/${encodeURIComponent(branch)}`);
      if (status === 404) return null;
      return data && data.commit ? data.commit.sha : null;
    },
    // The names of the checks a branch requires before a PR into it merges, as GitHub judges a person's
    // merge: the `required_status_checks` rules of its active rulesets (`rules/branches/<branch>`), and
    // its classic protection (the `protection` of the branch itself, which needs no admin read). A name is
    // a check run's `name` or a commit status's `context`. An empty list is a branch that requires none.
    async listRequiredChecks(repo, branch) {
      const names = new Set();
      const rules = await pages(`${repoPath(repo)}/rules/branches/${encodeURIComponent(branch)}`, `Rules of ${branch} in ${repo}`);
      for (const rule of rules) {
        if (!rule || rule.type !== 'required_status_checks') continue;
        const list = rule.parameters && rule.parameters.required_status_checks;
        if (!Array.isArray(list)) throw new GitHubError(`GitHub answered a required-checks rule of ${branch} in ${repo} with no list of checks`, 200);
        for (const c of list) if (c && typeof c.context === 'string' && c.context) names.add(c.context);
      }
      const { status, data } = await request('GET', `${repoPath(repo)}/branches/${encodeURIComponent(branch)}`);
      if (status === 404) throw new GitHubError(`Branch ${branch} of ${repo} not found`, 404);
      const classic = data && data.protection && data.protection.required_status_checks;
      if (classic && classic.enforcement_level !== 'off') {
        for (const c of Array.isArray(classic.contexts) ? classic.contexts : []) if (typeof c === 'string' && c) names.add(c);
        for (const c of Array.isArray(classic.checks) ? classic.checks : []) if (c && typeof c.context === 'string' && c.context) names.add(c.context);
      }
      return [...names];
    },
    // Every tag name that starts with `prefix`. GitHub answers this list whole, in one page: it
    // ignores per_page and page, so it is never paged here.
    async listTagNames(repo, prefix) {
      const { data } = await request('GET', `${repoPath(repo)}/git/matching-refs/tags/${encodeURIComponent(prefix)}`);
      if (!Array.isArray(data)) throw new GitHubError(`GitHub answered something that is not a ref list for the tags of ${repo}`, 200);
      return data.map((r) => String(r.ref || '').replace(/^refs\/tags\//, '')).filter(Boolean);
    },
    // Every open PR of the repo.
    async listOpenPulls(repo) {
      return pages(`${repoPath(repo)}/pulls?state=open`, `Repo ${repo}`);
    },
    // Opens a PR. Returns its number and URL. A PR for the same head and base that is already open, or
    // no commit between them, is GitHub's 422.
    async createPull(repo, {
      title, body, head, base,
    }) {
      const { data } = await request('POST', `${repoPath(repo)}/pulls`, {
        title, body, head, base,
      });
      if (!data || typeof data.number !== 'number') throw new GitHubError(`GitHub answered something that is not a PR to POST ${repoPath(repo)}/pulls`, 200);
      return { number: data.number, url: data.html_url };
    },
    // Merges a PR with the given method (`merge`, `squash` or `rebase`), only if its head is still `sha`;
    // `title` and `message` are the merge commit's, when given.
    // GitHub answers 405 when the PR cannot be merged now (a conflict, a required check or review
    // missing) and 409 when its head moved: both reach the caller as a GitHubError with that status.
    async mergePull(repo, number, {
      method, sha, title, message,
    }) {
      const { data } = await request('PUT', `${repoPath(repo)}/pulls/${number}/merge`, {
        merge_method: method, sha, commit_title: title, commit_message: message,
      });
      if (!data || data.merged !== true) throw new GitHubError(`GitHub did not merge ${repo}#${number}`, 200);
    },
    // A user's membership of an org's team: `active`, `pending`, or null when they are not in it.
    // The token must be able to read the team; GitHub answers 404 both for "not a member" and
    // for a team the token cannot see, so a wrong token reads as nobody being a member.
    async teamMembership(org, team, login) {
      const { status, data } = await request('GET', `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(team)}/memberships/${encodeURIComponent(login)}`);
      if (status === 404) return null;
      return data && typeof data.state === 'string' ? data.state : null;
    },
    // Sets a commit status (`state`: success, failure, error or pending) under one context.
    async createStatus(repo, sha, { state, context, description, targetUrl }) {
      await request('POST', `${repoPath(repo)}/statuses/${encodeURIComponent(sha)}`, {
        state, context, description, ...(targetUrl ? { target_url: targetUrl } : {}),
      });
    },
    // Posts a check run on a commit (the Checks API; only a GitHub App's token may). `status` is in_progress, or completed with a
    // `conclusion`. A later run of the same name from the same App takes the place of an earlier one in the rollup.
    async createCheckRun(repo, { name, headSha, status, conclusion, title, summary, detailsUrl }) {
      const { data } = await request('POST', `${repoPath(repo)}/check-runs`, {
        name, head_sha: headSha, status, ...(conclusion ? { conclusion } : {}), ...(detailsUrl ? { details_url: detailsUrl } : {}),
        output: { title, summary },
      });
      return data;
    },
    // 404 is "private, or not there": from a public repo's token the two look alike.
    async repoVisibility(owner, name) {
      const { status, data } = await request('GET', `${repoPath(`${owner}/${name}`)}`);
      if (status === 404) return 'not-found';
      return data.private ? 'private' : 'public';
    },

    // The calls the publish step makes (lib/publish-command.js).

    // Every repo an installation token can reach, `owner/name`, all pages. A page that
    // breaks the shape the API promises is an error, never a shorter list.
    async installationRepos() {
      const names = [];
      for (let page = 1; ; page++) {
        const { status, data } = await request('GET', `/installation/repositories?per_page=100&page=${page}`);
        if (status === 404 || !data || !Array.isArray(data.repositories) || typeof data.total_count !== 'number') {
          throw new GitHubError('GitHub did not list the repositories this token can reach', status);
        }
        for (const r of data.repositories) names.push(String(r.full_name));
        if (data.repositories.length < 100 || names.length >= data.total_count) {
          if (names.length !== data.total_count) {
            throw new GitHubError(`GitHub listed ${names.length} repositories but counted ${data.total_count}`, status);
          }
          return names;
        }
      }
    },
    // The commit a ref names (`heads/main`, `tags/v1.2.3`), or null when there is no such ref.
    async getRefSha(repo, ref) {
      const { status, data } = await request('GET', `${repoPath(repo)}/git/ref/${ref.split('/').map(encodeURIComponent).join('/')}`);
      if (status === 404) return null;
      if (!data || !data.object || data.object.type !== 'commit') {
        throw new GitHubError(`${ref} in ${repo} does not name a commit`, status);
      }
      return data.object.sha;
    },
    // A commit's tree sha, message and parents (their shas, first parent first).
    async getCommit(repo, sha) {
      const { status, data } = await request('GET', `${repoPath(repo)}/git/commits/${encodeURIComponent(sha)}`);
      if (status === 404) throw new GitHubError(`commit ${sha} not found in ${repo}`, 404);
      if (!data || !data.tree || typeof data.tree.sha !== 'string' || typeof data.message !== 'string') {
        throw new GitHubError(`GitHub answered something that is not a commit to GET ${repoPath(repo)}/git/commits/${sha}`, status);
      }
      const parents = Array.isArray(data.parents) ? data.parents.map((p) => String(p && p.sha)) : [];
      return { tree: data.tree.sha, message: data.message, parents };
    },
    // The name of every tag in the repo, all pages. A page that is not a tag list is an
    // error, never a shorter list, and so is a list longer than it will read.
    async listTags(repo) {
      return (await listTagCommits(repo)).map((t) => t.name);
    },
    listTagCommits,
    // The repos of an org with their custom property values, every page (`GET /orgs/<org>/properties/values`, 100 a
    // page): `[{ repo: '<owner>/<name>', properties: { <name>: <value> } }]`. A property a repo has not set is null.
    async listOrgPropertyValues(org) {
      const all = await pages(`/orgs/${encodeURIComponent(org)}/properties/values`, `Org ${org}`);
      return all.map((r) => {
        const name = r && (r.repository_full_name || (r.repository_name && `${org}/${r.repository_name}`));
        if (typeof name !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(name) || !Array.isArray(r.properties)) {
          throw new GitHubError(`GitHub answered a property row of ${org} with no repo name or no properties`, 200);
        }
        const properties = {};
        for (const p of r.properties) if (p && typeof p.property_name === 'string') properties[p.property_name] = p.value === undefined ? null : p.value;
        return { repo: name, properties };
      });
    },
    // The issues of a repo that carry a label, open or closed, made or changed since `sinceIso` (the API's `since` is on
    // the last update, so it holds every one made since), PRs left out: `[{ number, state, createdAt, title, body }]`.
    async listIssuesSince(repo, label, sinceIso) {
      const all = await pages(`${repoPath(repo)}/issues?state=all&labels=${encodeURIComponent(label)}&since=${encodeURIComponent(sinceIso)}`, `Repo ${repo}`);
      return all.filter((i) => i && !i.pull_request).map((i) => ({
        number: i.number, state: String(i.state), createdAt: i.created_at, title: String(i.title || ''), body: String(i.body || ''),
      }));
    },
    // The PRs of an org merged since `sinceIso` that carry a label, in ONE search call (the newest 100: `incomplete` says
    // there are more): `{ total, incomplete, pulls: [{ repo, number, title, mergedAt }] }`. A search result that names no
    // repo or no merge time is left out.
    async searchMergedPulls(org, label, sinceIso) {
      const q = `is:pr is:merged org:${org} label:"${label}" merged:>=${sinceIso}`;
      const { status, data } = await request('GET', `/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${FILES_PER_PAGE}`);
      if (status === 404 || !data || !Array.isArray(data.items)) throw new GitHubError(`GitHub did not answer the search for merged PRs of ${org}`, status);
      const pulls = [];
      for (const i of data.items) {
        const repo = /\/repos\/([^/\s]+\/[^/\s]+)$/.exec(String(i && i.repository_url || ''));
        const mergedAt = i && i.pull_request && i.pull_request.merged_at;
        if (repo && Number.isSafeInteger(i.number) && typeof mergedAt === 'string') pulls.push({ repo: repo[1], number: i.number, title: String(i.title || ''), mergedAt });
      }
      return { total: Number(data.total_count) || pulls.length, incomplete: data.incomplete_results === true, pulls };
    },
    // The newest Releases of a repo, one page only (100, newest first), published ones: `[{ tag, publishedAt, prerelease }]`.
    // A caller that wants the newest by version reads only the recent past, so one page is enough and costs one call.
    async listRecentReleases(repo) {
      const { status, data } = await request('GET', `${repoPath(repo)}/releases?per_page=${FILES_PER_PAGE}&page=1`);
      if (status === 404 || !Array.isArray(data)) throw new GitHubError(`GitHub did not list the releases of ${repo}`, status);
      return data.filter((r) => r && r.draft !== true && typeof r.tag_name === 'string').map((r) => ({
        tag: r.tag_name, publishedAt: r.published_at || r.created_at || null, prerelease: r.prerelease === true,
      }));
    },
    // How far `head` is ahead of `base`, in one call that lists no commit: `{ status, aheadBy }`, or null when GitHub
    // cannot compare them.
    async compareAhead(repo, base, head) {
      const { status, data } = await request('GET', `${repoPath(repo)}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}?per_page=1`);
      if (status === 404) return null;
      if (!data || typeof data.status !== 'string' || !Number.isSafeInteger(data.ahead_by)) {
        throw new GitHubError(`GitHub answered something that is not a comparison to GET ${repoPath(repo)}/compare/${base}...${head}`, 200);
      }
      return { status: data.status, aheadBy: data.ahead_by };
    },
    // A tree from `entries`. With no `baseTree` it is whole, so a file left out of `entries` is
    // deleted; with one, the entries are changes to that tree (an entry with `sha: null` deletes its path).
    async createTree(repo, entries, { baseTree } = {}) {
      const { data } = await request('POST', `${repoPath(repo)}/git/trees`, { ...(baseTree ? { base_tree: baseTree } : {}), tree: entries });
      return data.sha;
    },
    // A file's bytes as a blob, for a tree entry that names it by `sha`: never text decoded and encoded again.
    async createBlob(repo, bytes) {
      const { data } = await request('POST', `${repoPath(repo)}/git/blobs`, { content: Buffer.from(bytes).toString('base64'), encoding: 'base64' });
      if (!data || !/^[0-9a-f]{40}$/.test(String(data.sha))) throw new GitHubError(`GitHub answered something that is not a blob to POST ${repoPath(repo)}/git/blobs`, 200);
      return data.sha;
    },
    // A commit with no author or committer given: GitHub makes it as the token's own identity, and signs it. Naming either
    // makes it unsigned, which a repo that requires signed commits refuses and Vercel will not deploy.
    async createCommit(repo, { message, tree, parents }) {
      const { data } = await request('POST', `${repoPath(repo)}/git/commits`, { message, tree, parents });
      return data.sha;
    },
    // Fast-forward only: a branch that moved since it was read makes this fail.
    async updateBranch(repo, branch, sha) {
      await request('PATCH', `${repoPath(repo)}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { sha, force: false });
    },
    // Moves a branch to a commit that is not its child. Only for a branch the caller has just checked it may replace.
    async replaceBranch(repo, branch, sha) {
      await request('PATCH', `${repoPath(repo)}/git/refs/heads/${branch.split('/').map(encodeURIComponent).join('/')}`, { sha, force: true });
    },
    async createTag(repo, tag, sha) {
      await request('POST', `${repoPath(repo)}/git/refs`, { ref: `refs/tags/${tag}`, sha });
    },

    // The calls the tag step makes (lib/tag-command.js), tag, GitHub Release and Shipped comment.

    // The pull requests GitHub ties to a commit (as its merge commit or as a head), all pages.
    async listPullsOfCommit(repo, sha) {
      return pages(`${repoPath(repo)}/commits/${encodeURIComponent(sha)}/pulls`, `Commit ${sha} of ${repo}`);
    },
    // What a user may do in a repo: GitHub's `permission` (`admin`, `write`, `read` or `none`;
    // `maintain` reads as `write`, `triage` as `read`). A user it does not know is `none`.
    async collaboratorPermission(repo, login) {
      const { status, data } = await request('GET', `${repoPath(repo)}/collaborators/${encodeURIComponent(login)}/permission`);
      if (status === 404) return 'none';
      if (!data || typeof data.permission !== 'string') {
        throw new GitHubError(`GitHub answered something that is not a permission for ${login} in ${repo}`, status);
      }
      return data.permission;
    },
    // A tag ref as `{ type, sha }`, where `type` is `commit` for a lightweight tag and `tag` for
    // an annotated one; null when there is no such tag.
    async getTagRef(repo, tag) {
      const { status, data } = await request('GET', `${repoPath(repo)}/git/ref/tags/${tag.split('/').map(encodeURIComponent).join('/')}`);
      if (status === 404) return null;
      if (!data || !data.object || typeof data.object.sha !== 'string' || typeof data.object.type !== 'string') {
        throw new GitHubError(`GitHub answered something that is not a ref for tag ${tag} in ${repo}`, status);
      }
      return { type: data.object.type, sha: data.object.sha };
    },
    // The object an annotated tag object points at, as `{ type, sha }`.
    async getTagObject(repo, sha) {
      const { status, data } = await request('GET', `${repoPath(repo)}/git/tags/${encodeURIComponent(sha)}`);
      if (status === 404) throw new GitHubError(`tag object ${sha} not found in ${repo}`, 404);
      if (!data || !data.object || typeof data.object.sha !== 'string' || typeof data.object.type !== 'string') {
        throw new GitHubError(`GitHub answered something that is not a tag object for ${sha} in ${repo}`, status);
      }
      const date = data.tagger && typeof data.tagger.date === 'string' ? data.tagger.date : null;
      return { type: data.object.type, sha: data.object.sha, ...(date ? { date } : {}) };
    },
    // An annotated tag object for a commit. It names no tagger, so GitHub records the caller's own
    // identity (the release App's). The ref that makes it a tag is a separate call (createTag).
    async createTagObject(repo, { tag, message, commit }) {
      const { data } = await request('POST', `${repoPath(repo)}/git/tags`, {
        tag, message, object: commit, type: 'commit',
      });
      if (!data || !/^[0-9a-f]{40}$/.test(String(data.sha))) throw new GitHubError(`GitHub answered something that is not a tag object to POST ${repoPath(repo)}/git/tags`, 200);
      return data.sha;
    },

    // The calls the announce step makes (lib/announce-command.js).

    // A file as it is at a ref: `{ sha, text }`, or null when there is no such file. A file GitHub
    // will not inline (over 1 MB, or a folder) is an error, never an empty text.
    async getFile(repo, filePath, ref) {
      const { status, data } = await request('GET', `${repoPath(repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      if (status === 404) return null;
      if (!data || Array.isArray(data) || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string' || typeof data.sha !== 'string') {
        throw new GitHubError(`GitHub did not answer the text of ${filePath} in ${repo} (a folder, or a file over 1 MB)`, 200);
      }
      return { sha: data.sha, text: Buffer.from(data.content, 'base64').toString('utf8') };
    },
    // Writes one new file on a branch as one commit (it never replaces a file: GitHub refuses a
    // write over an existing file that does not name its blob). Returns the new commit.
    async putFile(repo, filePath, { message, text, branch }) {
      const { data } = await request('PUT', `${repoPath(repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`, {
        message, content: Buffer.from(text, 'utf8').toString('base64'), branch,
      });
      if (!data || !data.commit || !/^[0-9a-f]{40}$/.test(String(data.commit.sha))) {
        throw new GitHubError(`GitHub answered something that is not a commit to PUT ${filePath} in ${repo}`, 200);
      }
      return data.commit.sha;
    },
    async createBranch(repo, branch, sha) {
      await request('POST', `${repoPath(repo)}/git/refs`, { ref: `refs/heads/${branch}`, sha });
    },

    // A file's text at a commit, a branch or a tag, or null when it is not there. A file the contents
    // API will not inline (over 1 MB) is an error, never a shorter text.
    async getFileText(repo, filePath, ref) {
      const { status, data } = await request('GET', `${repoPath(repo)}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      if (status === 404) return null;
      if (!data || Array.isArray(data) || data.type !== 'file' || data.encoding !== 'base64' || typeof data.content !== 'string') {
        throw new GitHubError(`GitHub did not answer the text of ${filePath} at ${ref} in ${repo}`, status);
      }
      return Buffer.from(data.content, 'base64').toString('utf8');
    },
    // The names of the files in a folder at a commit, or an empty list when there is no such folder.
    async listFolder(repo, folder, ref) {
      const { status, data } = await request('GET', `${repoPath(repo)}/contents/${folder.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
      if (status === 404) return [];
      if (!Array.isArray(data)) throw new GitHubError(`GitHub did not answer a folder list for ${folder} at ${ref} in ${repo}`, status);
      return data.filter((e) => e && e.type === 'file' && typeof e.name === 'string').map((e) => e.name);
    },
    // The GitHub Release made at a tag, as `{ url }`, or null when there is none. A draft is not found
    // by tag, and a draft is never made here.
    async getRelease(repo, tag) {
      const { status, data } = await request('GET', `${repoPath(repo)}/releases/tags/${tag.split('/').map(encodeURIComponent).join('/')}`);
      if (status === 404) return null;
      if (!data || typeof data.html_url !== 'string') throw new GitHubError(`GitHub answered something that is not a release for tag ${tag} in ${repo}`, status);
      return { url: data.html_url };
    },
    // The published GitHub Release made at a tag, with the files it holds (`{ name, digest }`, the digest GitHub's
    // `sha256:<hex>`), or null when there is none or it is still a draft (GitHub finds no draft by tag).
    async getPublishedRelease(repo, tag) {
      const { status, data } = await request('GET', `${repoPath(repo)}/releases/tags/${tag.split('/').map(encodeURIComponent).join('/')}`);
      if (status === 404) return null;
      if (!data || typeof data.html_url !== 'string' || !Array.isArray(data.assets)) throw new GitHubError(`GitHub answered something that is not a release for tag ${tag} in ${repo}`, status);
      if (data.draft === true) return null;
      return {
        url: data.html_url,
        assets: data.assets.filter((a) => a && typeof a.name === 'string').map((a) => ({ name: a.name, digest: typeof a.digest === 'string' ? a.digest : null })),
      };
    },
    // Makes a GitHub Release at an existing tag: complete, and a pre-release only when `prerelease` is
    // true (`shipyard prerelease`; a release's tag step never asks). With `draft` it is
    // made as a draft, so files can still be added (a published Release is immutable); a draft is
    // never "latest", so `makeLatest` (`true` or `false`) is read only for a complete one. Returns
    // `{ url, id, uploadUrl, assets }`.
    async createRelease(repo, {
      tag, name, body, makeLatest, draft = false, prerelease = false,
    }) {
      const { data } = await request('POST', `${repoPath(repo)}/releases`, {
        tag_name: tag, name, body, draft, prerelease: prerelease === true, ...(draft ? {} : { make_latest: makeLatest }),
      });
      return releaseOf(data, `to POST ${repoPath(repo)}/releases`);
    },
    // Every Release of the repo, drafts too, as `releaseOf` reads each. A draft is seen only by a
    // token that can write, so the release App's lists it and the job's own read-only one does not.
    async listReleases(repo) {
      const all = await pages(`${repoPath(repo)}/releases`, `Repo ${repo}`);
      return all.map((r) => ({ ...releaseOf(r, `to GET ${repoPath(repo)}/releases`), draft: r.draft === true, tag: String(r.tag_name) }));
    },
    // Publishes a draft (it is complete from then on, and immutable). Returns the Release as it is
    // now: a draft's link is an "untagged" one, so the link to use is this answer's.
    async publishRelease(repo, id, { makeLatest }) {
      const { data } = await request('PATCH', `${repoPath(repo)}/releases/${encodeURIComponent(id)}`, { draft: false, make_latest: makeLatest });
      return releaseOf(data, `to PATCH ${repoPath(repo)}/releases/${id}`);
    },
    // Adds one file to a draft Release. `file` is `{ name, data }`; the upload goes to the host the
    // Release names, which must be GitHub's own for the API in use, so the token goes nowhere else.
    async uploadReleaseAsset(repo, release, { name, data }) {
      const url = uploadUrlOf(release, apiUrl);
      url.searchParams.set('name', name);
      let res;
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'shipyard',
            'Content-Type': 'application/octet-stream',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: data,
          signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        });
      } catch (e) {
        if (!isDropped(e)) throw e;
        throw droppedError(`POST ${url.pathname}`, e);
      }
      if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} to the upload of ${JSON.stringify(name)} to ${repo}`, res.status);
    },
    // Deletes one file of a draft Release (a partial upload, or one that is not the build's).
    async deleteReleaseAsset(repo, id) {
      await request('DELETE', `${repoPath(repo)}/releases/assets/${encodeURIComponent(id)}`);
    },
    // One issue or PR comment by its ID, or null when there is none (deleted, or never there).
    async getIssueComment(repo, id) {
      const { status, data } = await request('GET', `${repoPath(repo)}/issues/comments/${encodeURIComponent(id)}`);
      if (status === 404) return null;
      if (!data || typeof data.issue_url !== 'string' || typeof data.body !== 'string') {
        throw new GitHubError(`GitHub answered something that is not a comment for comment ${id} in ${repo}`, status);
      }
      return data;
    },
    // Starts a workflow of the repo (`workflow_dispatch`) on a branch, with string inputs. The
    // workflow is its file name (`tag.yml`); it must take `workflow_dispatch` on that branch.
    async dispatchWorkflow(repo, workflow, ref, inputs) {
      await request('POST', `${repoPath(repo)}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`, { ref, inputs });
    },
    // The calls of a docs preview (lib/docs-preview-command.js).

    // A repo's default branch, or null when the token cannot see the repo (404).
    async defaultBranch(repo) {
      const { status, data } = await request('GET', repoPath(repo));
      if (status === 404) return null;
      if (!data || typeof data.default_branch !== 'string') throw new GitHubError(`GitHub answered something that is not a repo to GET ${repoPath(repo)}`, status);
      return data.default_branch;
    },
    // A repo's `release_area` custom property, or null when it has none, it is not a text, or the token cannot see the
    // repo. It reads `GET /repos/{repo}/properties/values`, which a job's own read token can call.
    async releaseArea(repo) {
      const { status, data } = await request('GET', `${repoPath(repo)}/properties/values`);
      if (status === 404) return null;
      if (!Array.isArray(data)) throw new GitHubError(`GitHub answered something that is not a list to GET ${repoPath(repo)}/properties/values`, status);
      const row = data.find((p) => p && p.property_name === 'release_area');
      return row && typeof row.value === 'string' && row.value.trim() ? row.value : null;
    },
    // A repo's default branch and its `release_area` property (null when it has none), from one read
    // (`{ defaultBranch, area }`), or null when the token cannot see the repo (404).
    async repoFacts(repo) {
      const { status, data } = await request('GET', repoPath(repo));
      if (status === 404) return null;
      if (!data || typeof data.default_branch !== 'string') throw new GitHubError(`GitHub answered something that is not a repo to GET ${repoPath(repo)}`, status);
      const props = data.custom_properties;
      const area = props && typeof props === 'object' && typeof props.release_area === 'string' ? props.release_area : null;
      return { defaultBranch: data.default_branch, area };
    },
    // A branch's tip commit and its committer date (`{ sha, date }`), or null when there is no such branch.
    async branchHead(repo, branch) {
      const { status, data } = await request('GET', `${repoPath(repo)}/branches/${encodeURIComponent(branch)}`);
      if (status === 404) return null;
      const commit = data && data.commit;
      if (!commit || typeof commit.sha !== 'string') throw new GitHubError(`GitHub answered something that is not a branch to GET ${repoPath(repo)}/branches/${branch}`, status);
      const committer = commit.commit && commit.commit.committer;
      return { sha: commit.sha, date: committer && typeof committer.date === 'string' ? committer.date : null };
    },
    // A commit's committer date (ISO 8601).
    async commitDate(repo, sha) {
      const { status, data } = await request('GET', `${repoPath(repo)}/git/commits/${encodeURIComponent(sha)}`);
      if (status === 404) throw new GitHubError(`commit ${sha} not found in ${repo}`, 404);
      if (!data || !data.committer || typeof data.committer.date !== 'string') {
        throw new GitHubError(`GitHub answered something that is not a commit to GET ${repoPath(repo)}/git/commits/${sha}`, status);
      }
      return data.committer.date;
    },
    // When `sha` was last pushed to `branch` (ISO 8601), from the repo's activity (`GET /repos/{repo}/activity`, newest
    // first), or null when the newest 100 pushes of the branch hold none of it.
    async pushTime(repo, branch, sha) {
      const { status, data } = await request('GET', `${repoPath(repo)}/activity?ref=${encodeURIComponent(`refs/heads/${branch}`)}&per_page=100`);
      if (status === 404) return null;
      if (!Array.isArray(data)) throw new GitHubError(`GitHub answered something that is not a list to GET ${repoPath(repo)}/activity`, status);
      const push = data.find((a) => a && a.after === sha && typeof a.timestamp === 'string');
      return push ? push.timestamp : null;
    },
    // Makes a deployment of a commit and answers its id. `deployment` is the API's body (`ref`, `environment`, ...).
    async createDeployment(repo, deployment) {
      const { status, data } = await request('POST', `${repoPath(repo)}/deployments`, deployment);
      if (!data || !Number.isSafeInteger(data.id)) {
        throw new GitHubError(`GitHub made no deployment of ${deployment.ref} in ${repo}${data && data.message ? `: ${String(data.message).slice(0, 200)}` : ''}`, status);
      }
      return data.id;
    },
    // Sets a deployment's state, with the API's body (`state`, `description`, `environment_url`, `log_url`, ...).
    async createDeploymentStatus(repo, id, deploymentStatus) {
      await request('POST', `${repoPath(repo)}/deployments/${encodeURIComponent(id)}/statuses`, deploymentStatus);
    },
    // The calls of a docs publish (lib/docs-publish-command.js).

    // The newest 30 runs of one workflow that were started by hand or by `workflow_dispatch`, newest first: `id`,
    // `status` (`queued`, `in_progress`, `completed`), `conclusion` and `html_url`.
    async listDispatchedRuns(repo, workflow) {
      const { status, data } = await request('GET', `${repoPath(repo)}/actions/workflows/${encodeURIComponent(workflow)}/runs?event=workflow_dispatch&per_page=30`);
      if (status === 404) throw new GitHubError(`Workflow ${workflow} of ${repo} not found`, 404);
      if (!data || !Array.isArray(data.workflow_runs)) throw new GitHubError(`GitHub answered something that is not a workflow-run list for ${workflow}`, status);
      return data.workflow_runs;
    },
    // Moves an existing tag ref. Only the floating major tag is ever moved; a release tag never is.
    async moveTag(repo, tag, sha) {
      await request('PATCH', `${repoPath(repo)}/git/refs/tags/${tag.split('/').map(encodeURIComponent).join('/')}`, { sha, force: true });
    },
  };
}

module.exports = { createClient, GitHubError, graphqlUrlOf, uploadUrlOf };
