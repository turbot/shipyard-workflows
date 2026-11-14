'use strict';

// A small GitHub REST client over fetch: the calls the changelog-line check, the release
// steps (facts, cut) and the publish step make.

class GitHubError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const FILES_PER_PAGE = 100;
const MAX_FILE_PAGES = 30; // GitHub lists at most 3000 files of a PR
const MAX_LIST_PAGES = 50;
const TAGS_PER_PAGE = 100;
const MAX_TAG_PAGES = 100;

// GitHub's GraphQL endpoint beside a REST one: `https://api.github.com/graphql`, or on a GitHub
// Enterprise Server `https://<host>/api/graphql` beside `https://<host>/api/v3`.
const graphqlUrlOf = (apiUrl) => `${apiUrl.replace(/\/+$/, '').replace(/\/v3$/, '')}/graphql`;

function createClient({
  token, apiUrl = 'https://api.github.com', graphqlUrl, fetchImpl = globalThis.fetch, timeoutMs = 20000,
} = {}) {
  const graphqlAt = graphqlUrl || graphqlUrlOf(apiUrl);

  async function graphql(query, variables) {
    const res = await fetchImpl(graphqlAt, {
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
    if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} to a GraphQL query`, res.status);
    const answer = await res.json();
    if (answer && Array.isArray(answer.errors) && answer.errors.length) {
      const first = String((answer.errors[0] && answer.errors[0].message) || 'an error').replace(/\s+/g, ' ').slice(0, 200);
      throw new GitHubError(`GitHub's GraphQL API answered: ${first}`, 200);
    }
    return answer && answer.data;
  }

  async function request(method, path, payload) {
    const res = await fetchImpl(`${apiUrl.replace(/\/+$/, '')}${path}`, {
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
    if (res.status === 404 && method === 'GET') return { status: 404, data: null };
    if (!res.ok) throw new GitHubError(`GitHub answered ${res.status} to ${method} ${path}`, res.status);
    return { status: res.status, data: await res.json() };
  }

  const repoPath = (repo) => `/repos/${repo.split('/').map(encodeURIComponent).join('/')}`;

  // A list that pages 100 at a time; stops at a short page, or fails at the page cap rather
  // than answer with a list that may be short.
  async function pages(path, what) {
    const joiner = path.includes('?') ? '&' : '?';
    const items = [];
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      const { status, data } = await request('GET', `${path}${joiner}per_page=${FILES_PER_PAGE}&page=${page}`);
      if (status === 404) throw new GitHubError(`${what} not found`, 404);
      if (!Array.isArray(data)) throw new GitHubError(`GitHub answered something that is not a list to GET ${path}`, 200);
      items.push(...data);
      if (data.length < FILES_PER_PAGE) return items;
    }
    throw new GitHubError(`${what} has more than ${MAX_LIST_PAGES * FILES_PER_PAGE} entries at ${path}; refusing to use a list that may be short`, 200);
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
    // Every comment of an issue or a PR, oldest first (`body`, `user.login`).
    async listIssueComments(repo, number) {
      return pages(`${repoPath(repo)}/issues/${number}/comments`, `Issue ${repo}#${number}`);
    },
    async createIssueComment(repo, number, body) {
      await request('POST', `${repoPath(repo)}/issues/${number}/comments`, { body });
    },
    // The open issues that carry a label, PRs left out (the issues API lists both).
    async listOpenIssuesByLabel(repo, label) {
      const all = await pages(`${repoPath(repo)}/issues?state=open&labels=${encodeURIComponent(label)}`, `Repo ${repo}`);
      return all.filter((i) => i && !i.pull_request);
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
    // A branch's tip commit, or null when there is no such branch.
    async branchTip(repo, branch) {
      const { status, data } = await request('GET', `${repoPath(repo)}/branches/${encodeURIComponent(branch)}`);
      if (status === 404) return null;
      return data && data.commit ? data.commit.sha : null;
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
    // Every comment on an issue or a PR's conversation, oldest first (`user`, `body`, `created_at`).
    async listIssueComments(repo, number) {
      return pages(`${repoPath(repo)}/issues/${number}/comments`, `Issue ${repo}#${number}`);
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
    // A commit's tree sha and message.
    async getCommit(repo, sha) {
      const { status, data } = await request('GET', `${repoPath(repo)}/git/commits/${encodeURIComponent(sha)}`);
      if (status === 404) throw new GitHubError(`commit ${sha} not found in ${repo}`, 404);
      if (!data || !data.tree || typeof data.tree.sha !== 'string' || typeof data.message !== 'string') {
        throw new GitHubError(`GitHub answered something that is not a commit to GET ${repoPath(repo)}/git/commits/${sha}`, status);
      }
      return { tree: data.tree.sha, message: data.message };
    },
    // The name of every tag in the repo, all pages. A page that is not a tag list is an
    // error, never a shorter list, and so is a list longer than it will read.
    async listTags(repo) {
      const names = [];
      for (let page = 1; page <= MAX_TAG_PAGES; page++) {
        const { status, data } = await request('GET', `${repoPath(repo)}/tags?per_page=${TAGS_PER_PAGE}&page=${page}`);
        if (status === 404 || !Array.isArray(data) || data.some((t) => !t || typeof t.name !== 'string')) {
          throw new GitHubError(`GitHub did not list the tags of ${repo}`, status);
        }
        names.push(...data.map((t) => t.name));
        if (data.length < TAGS_PER_PAGE) return names;
      }
      throw new GitHubError(`${repo} has more than ${MAX_TAG_PAGES * TAGS_PER_PAGE} tags: too many to read them all`, 200);
    },
    // A whole tree from scratch (no base tree), so a file left out of `entries` is deleted.
    async createTree(repo, entries) {
      const { data } = await request('POST', `${repoPath(repo)}/git/trees`, { tree: entries });
      return data.sha;
    },
    async createCommit(repo, { message, tree, parents }) {
      const { data } = await request('POST', `${repoPath(repo)}/git/commits`, { message, tree, parents });
      return data.sha;
    },
    // Fast-forward only: a branch that moved since it was read makes this fail.
    async updateBranch(repo, branch, sha) {
      await request('PATCH', `${repoPath(repo)}/git/refs/heads/${encodeURIComponent(branch)}`, { sha, force: false });
    },
    async createTag(repo, tag, sha) {
      await request('POST', `${repoPath(repo)}/git/refs`, { ref: `refs/tags/${tag}`, sha });
    },

    // The calls the tag step makes (lib/tag-command.js).

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
      return { type: data.object.type, sha: data.object.sha };
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
    // Moves an existing tag ref. Only the floating major tag is ever moved; a release tag never is.
    async moveTag(repo, tag, sha) {
      await request('PATCH', `${repoPath(repo)}/git/refs/tags/${tag.split('/').map(encodeURIComponent).join('/')}`, { sha, force: true });
    },
  };
}

module.exports = { createClient, GitHubError, graphqlUrlOf };
