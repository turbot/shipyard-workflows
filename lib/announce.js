'use strict';

// What follows the tag: the changelog page on the product's site repo, the #releases line for a
// product with no page, and a "Live in" comment on each issue the release closes. Reads GitHub only:
// no checkout, and nothing from the repo is ever run. The release PR, the notes and the config are
// read at the release PR's merge commit, which the release tag names, so the text is the text the
// approver approved. Every output can be run again: it looks for what an earlier run did before it
// writes, and a failure never undoes the tag.

const crypto = require('node:crypto');
const { GitHubError } = require('./github');
const { SlackError } = require('./slack');
const {
  ReleaseError, Refusal, parseTag,
} = require('./release-git');
const {
  releaseOf, commitOfRef, isReleaseBase, isReleaseHead, show, short,
} = require('./tag');

const ACTIONS_BOT = 'github-actions[bot]';
const BUG_LABEL = 'bug';
const OUTPUTS = ['page', 'post', 'comments'];
const REPO = /^[^/\s]+\/[^/\s]+$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const PAGE_PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const PLACEHOLDERS = /\{(tag|version|dashed)\}/g;
const MAX_ATTEMPTS = 3;

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
// A string cut to one line of at most `max` characters, for a message or a title.
const oneLine = (value, max = 200) => {
  const text = String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// ---------------------------------------------------------------------------
// The release the tag names

/**
 * The release a tag stands for, read from GitHub: the tag must exist, name the merge commit of a
 * merged release PR from one of the release automation's accounts, and agree with that PR's title.
 * Returns `{ skip }` for a name that is no release tag (the floating `v1` moves under the same push
 * trigger), a Refusal for anything else that is wrong.
 */
async function findRelease({ github, repo, tag, prefix, automationLogins }) {
  if (!parseTag(tag, prefix)) return { skip: `${show(tag, 60)} is not a release tag (${show(prefix, 20)} and X.Y.Z), so there is nothing to announce` };
  const ref = await github.getTagRef(repo, tag);
  if (!ref) throw new Refusal(`${tag} is not a tag of ${repo}: the announcement follows the tag`);
  const sha = await commitOfRef(github, repo, ref);
  const found = (await github.listPullsOfCommit(repo, sha))
    .filter((p) => p && p.merged_at && p.merge_commit_sha === sha && p.base && isReleaseBase(p.base.ref) && p.head && isReleaseHead(p.head.ref));
  if (!found.length) throw new Refusal(`${tag} is at ${short(sha)}, which is not the merge of a release PR: nothing is announced`);
  const pr = await github.getPull(repo, found[0].number);
  const release = releaseOf(pr, {
    repo, prefix, automationLogins, sha,
  });
  if (release.tag !== tag) throw new Refusal(`#${release.number} is the release PR of ${release.tag}, not ${tag}`);
  // The moment it shipped is the annotated tag's own date, so a run again writes the same page.
  let date = null;
  if (ref.type === 'tag') date = (await github.getTagObject(repo, ref.sha)).date || null;
  return { release, date };
}

// ---------------------------------------------------------------------------
// What the repo says: `announce` in `.github/release.json`

/**
 * The announce setting of a repo's `.github/release.json`, parsed ({} for none):
 *   "announce": { "page": { "repo": "<owner>/<name>", "path": "<path with {version}>", "base": "main" } }
 * A repo with no `page` has no page: it gets the #releases line instead.
 */
function parseAnnounce(config, product) {
  if (config === undefined || config === null) return { page: null };
  if (!isObject(config)) throw new ReleaseError('.github/release.json is not an object');
  if (config.announce === undefined) return { page: null };
  const where = '.github/release.json: announce';
  const a = config.announce;
  if (!isObject(a)) throw new ReleaseError(`${where} must be an object`);
  for (const key of Object.keys(a)) if (key !== 'page') throw new ReleaseError(`${where} has no setting ${show(key, 40)} (settings: page)`);
  if (a.page === undefined) return { page: null };
  const p = a.page;
  if (!isObject(p)) throw new ReleaseError(`${where}.page must be an object`);
  for (const key of Object.keys(p)) {
    if (!['repo', 'path', 'base'].includes(key)) throw new ReleaseError(`${where}.page has no setting ${show(key, 40)} (settings: repo, path, base)`);
  }
  if (typeof p.repo !== 'string' || !REPO.test(p.repo)) throw new ReleaseError(`${where}.page.repo must be <owner>/<name>`);
  if (p.repo.toLowerCase() === String(product).toLowerCase()) throw new ReleaseError(`${where}.page.repo is the product repo itself: a page goes to the site's repo`);
  if (typeof p.path !== 'string') throw new ReleaseError(`${where}.page.path must be a path with {version}, {tag} or {dashed} in it`);
  if (!p.path.match(PLACEHOLDERS)) throw new ReleaseError(`${where}.page.path must hold {version}, {tag} or {dashed}, so each release has its own page`);
  if (/[{}]/.test(p.path.replace(PLACEHOLDERS, ''))) throw new ReleaseError(`${where}.page.path holds a { or } that is not {version}, {tag} or {dashed}`);
  const base = p.base === undefined ? 'main' : p.base;
  if (typeof base !== 'string' || !BRANCH.test(base)) throw new ReleaseError(`${where}.page.base must be a branch name`);
  const page = { repo: p.repo, path: p.path, base };
  pagePath(page.path, { tag: 'v1.2.3', parts: [1, 2, 3] });
  return { page };
}

// The page's file path for a release: the template filled in, and held to a markdown file in a
// folder that is not hidden, so the release bot's merge can touch a changelog page and nothing else.
function pagePath(template, release) {
  const filled = template
    .replace(/\{tag\}/g, release.tag)
    .replace(/\{version\}/g, release.parts.join('.'))
    .replace(/\{dashed\}/g, release.parts.join('-'));
  const segments = filled.split('/');
  const ok = filled.length <= 200 && segments.every((s) => PAGE_PATH_SEGMENT.test(s)) && /\.mdx?$/.test(filled);
  if (!ok) throw new ReleaseError(`.github/release.json: announce.page.path makes ${show(filled, 80)}, which is not a markdown file (.md or .mdx) in a folder with plain, visible names`);
  return filled;
}

// What the caller allows: `<owner>/<name>:<folder>/` entries, comma-separated. A page may go to a
// site repo only at a path inside a folder the caller named for it, whatever `.github/release.json`
// says: that is what keeps the release bot to changelog pages.
function parseTargets(text) {
  return String(text || '').split(',').map((t) => t.trim()).filter(Boolean).map((t) => {
    const m = /^([^/\s:]+\/[^/\s:]+):(.+)$/.exec(t);
    const segments = m ? m[2].split('/') : [];
    const last = segments.pop();
    if (!m || last !== '' || !segments.length || !segments.every((x) => PAGE_PATH_SEGMENT.test(x))) {
      throw new ReleaseError(`${show(t, 80)} is not <owner>/<name>:<folder>/, a site repo and the folder of its changelog pages`);
    }
    return { repo: m[1].toLowerCase(), folder: m[2] };
  });
}

// Refuses a page outside what the caller allowed. `file` is the page's filled-in path.
function checkTarget(targets, page, file) {
  const inside = targets.filter((t) => t.repo === page.repo.toLowerCase());
  if (!inside.length) throw new Refusal(`the page goes to ${page.repo}, which the caller did not list in page-targets: no page is opened`);
  if (!inside.some((t) => file.startsWith(t.folder))) {
    throw new Refusal(`the page path ${show(file, 100)} is outside the changelog folder the caller named for ${page.repo} (${inside.map((t) => show(t.folder, 60)).join(', ')}): no page is opened`);
  }
}

// ---------------------------------------------------------------------------
// The release notes

/**
 * `releases/<tag>/release-notes.md` as text, or null when the release has no release notes: no
 * file, or no section with an item (the same test the release check makes). `title` is the
 * `# ` line, `body` is everything under it.
 */
function parseNotes(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).replace(/\r\n?/g, '\n');
  if (!/^## \S/m.test(text) || !/^- \S/m.test(text)) return null;
  const m = /^# (.+)$/m.exec(text);
  const title = m ? oneLine(m[1], 300) : null;
  const body = m ? text.replace(/^# .+\n+/m, '') : text;
  return { title, body: body.replace(/^\n+/, '') };
}

function needTitle(notes, tag) {
  if (!notes.title) throw new ReleaseError(`releases/${tag}/release-notes.md has no title line (# ...)`);
  return notes.title;
}

// ---------------------------------------------------------------------------
// Retrying

// An error a second try can clear: GitHub's 5xx and rate limit, Slack's refusal to take the
// message, a connection that failed or timed out.
function isTransient(e) {
  if (e instanceof GitHubError) return e.status >= 500 || e.status === 429;
  if (e instanceof SlackError) return e.retryable;
  return Boolean(e) && (e.name === 'TimeoutError' || e.name === 'AbortError' || (e instanceof TypeError && /fetch failed/i.test(e.message)));
}

// An error an output reports as its own failure (and files a Bug for), not a bug in this code.
const isFailure = (e) => e instanceof ReleaseError || e instanceof GitHubError || e instanceof SlackError || isTransient(e);

// Runs `fn`, again after a pause when it fails in a way a second try can clear. `fn` must be safe to
// run again: it reads what an earlier try did before it writes.
async function retrying(fn, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), attempts = MAX_ATTEMPTS } = {}) {
  for (let i = 1; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts || !isTransient(e)) throw e;
      await sleep(1000 * 4 ** (i - 1));
    }
  }
}

// ---------------------------------------------------------------------------
// What an earlier run left, read only from the job's own comments

const markerOf = (kind, tag) => `<!-- shipyard:announce ${kind} ${tag} -->`;

// A login whose comments and issues count as the job's own: the job token's, and the release automation's.
const trustedLogins = (automationLogins) => new Set([ACTIONS_BOT, ...automationLogins].map((l) => l.toLowerCase()));
const isTrusted = (trusted, user) => Boolean(user && user.login) && trusted.has(String(user.login).toLowerCase());

// Whether the job already left `marker` on an issue or PR. Anyone may write a comment, so only a
// comment of the job's own accounts counts: a marker pasted by someone else never stops an output.
async function hasMarker(github, repo, number, marker, trusted) {
  return (await github.listIssueComments(repo, number)).some((c) => c && isTrusted(trusted, c.user) && String(c.body || '').includes(marker));
}

// ---------------------------------------------------------------------------
// The changelog page

function renderPage({ title, body, date }) {
  return `---\ntitle: ${JSON.stringify(title)}\ndate: ${date}\n---\n\n${body}`;
}

// Two pages are the same page when only the date differs: the date is the moment of shipping,
// and a run again may only know a later one.
const withoutDate = (text) => String(text).replace(/^date: .*$/m, 'date:');
const samePage = (a, b) => withoutDate(a) === withoutDate(b);

// One branch for each product's release, named from a hash so a private repo's name is never
// written into a site repo's branch list.
const pageBranch = (repo, tag) => `shipyard/changelog-${tag}-${crypto.createHash('sha1').update(repo.toLowerCase()).digest('hex').slice(0, 8)}`;

/**
 * Opens the page PR on the site repo and merges it. Returns `{ status, message }`; a Refusal when
 * what is there is not what this would write (a different page, a PR closed unmerged, a PR that
 * changes more than the page). Safe to run again at any point.
 */
async function openPage({
  github, repo, release, notes, page, date, prNumber,
}) {
  const { repo: site, base } = page;
  const title = needTitle(notes, release.tag);
  const file = pagePath(page.path, release);
  const text = renderPage({ title, body: notes.body, date });
  const where = `${site} ${show(file, 100)}`;

  const tip = await github.branchTip(site, base);
  if (!tip) throw new ReleaseError(`${site} has no branch ${show(base, 40)} to open the page against`);
  const onBase = await github.getFile(site, file, base);
  if (onBase) {
    if (samePage(onBase.text, text)) return { status: 'done', message: `The page is already on ${site}'s ${base} (${show(file, 100)}): nothing to do.` };
    throw new Refusal(`${where} is already on ${base} with other text: a page is never written over`);
  }

  const branch = pageBranch(repo, release.tag);
  let head = await github.getRefSha(site, `heads/${branch}`);
  if (!head) {
    try {
      await github.createBranch(site, branch, tip);
      head = tip;
    } catch (e) {
      // A second run made the branch between the read and the write: use it.
      if (!(e instanceof GitHubError) || e.status !== 422) throw e;
      head = await github.getRefSha(site, `heads/${branch}`);
      if (!head) throw e;
    }
  }
  const onBranch = await github.getFile(site, file, branch);
  if (!onBranch) {
    head = await github.putFile(site, file, { message: `Add changelog page: ${title}`.slice(0, 200), text, branch });
  } else if (!samePage(onBranch.text, text)) {
    throw new Refusal(`the branch ${branch} of ${site} holds other text at ${show(file, 100)}: it is not changed`);
  }

  const prs = (await github.listPullsByHead(site, branch)).filter((p) => p.base && p.base.ref === base);
  if (prs.some((p) => p.merged_at)) return { status: 'done', message: `The page PR on ${site} was already merged.` };
  let pr = prs.find((p) => p.state === 'open');
  if (!pr && prs.length) throw new Refusal(`the page PR #${prs[0].number} on ${site} was closed without merging: it is not opened again`);
  if (!pr) {
    pr = await github.createPull(site, {
      title: `Add changelog page: ${title}`.slice(0, 200),
      head: branch,
      base,
      body: `The changelog page for ${release.tag}, made by Shipyard from the release notes the approver saw. It adds one file and nothing else.`,
    });
  }

  // Merge only what was checked: one new file, at the page's path, with the page's text, from a
  // branch of the site repo, and only while the PR's head is still the commit that was checked.
  const fresh = await github.getPull(site, pr.number);
  const headRepo = fresh.head && fresh.head.repo && String(fresh.head.repo.full_name).toLowerCase();
  if (headRepo !== site.toLowerCase() || fresh.head.ref !== branch || !fresh.base || fresh.base.ref !== base) {
    throw new Refusal(`page PR #${pr.number} on ${site} is not ${branch} into ${base} of that repo: not merged`);
  }
  if (fresh.state !== 'open' || fresh.merged_at) throw new Refusal(`page PR #${pr.number} on ${site} is no longer open: not merged`);
  const { files, truncated } = await github.listPullFiles(site, pr.number);
  if (truncated || files.length !== 1 || files[0].filename !== file || files[0].previous_filename) {
    throw new Refusal(`page PR #${pr.number} on ${site} changes more than the page (${truncated ? 'a very long file list' : `${files.length} files`}): the release bot merges changelog-page paths only, so it is not merged`);
  }
  const atHead = await github.getFile(site, file, fresh.head.sha);
  if (!atHead || !samePage(atHead.text, text)) throw new Refusal(`page PR #${pr.number} on ${site} holds other text than the release notes: not merged`);
  await github.mergePull(site, pr.number, {
    sha: fresh.head.sha, method: 'squash', title: `Add changelog page: ${title}`.slice(0, 200), message: `Release PR #${prNumber}`,
  });
  return { status: 'done', message: `Merged the changelog page PR #${pr.number} on ${site} (${show(file, 100)}).` };
}

// ---------------------------------------------------------------------------
// The #releases line

// Slack's mrkdwn reads `&`, `<` and `>` as syntax (a link, a mention): they are sent as entities.
const slackEscape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const releaseUrl = (serverUrl, repo, tag) => `${serverUrl.replace(/\/+$/, '')}/${repo}/releases/tag/${encodeURIComponent(tag)}`;

/**
 * Posts the one #releases line of a release: its title and the GitHub Release link. The job's own
 * comment on the release PR is the record that it was posted, so a run again posts nothing twice.
 * A failure after the post never posts again: it is `posted` on the error, for the Bug to say.
 */
async function postLine({
  github, slack, channel, repo, release, notes, serverUrl, trusted, sleep,
}) {
  const title = needTitle(notes, release.tag);
  const marker = markerOf('post', release.tag);
  const text = `${slackEscape(title)}\n${releaseUrl(serverUrl, repo, release.tag)}`;
  if (await retrying(() => hasMarker(github, repo, release.number, marker, trusted), { sleep })) {
    return { status: 'done', message: `The ${channel} line for ${release.tag} was already posted: nothing to do.` };
  }
  await retrying(() => slack.postMessage(channel, text), { sleep });
  try {
    await retrying(() => github.createIssueComment(repo, release.number, `Posted the ${slackEscape(channel)} line for ${release.tag}.\n\n${marker}`), { sleep });
  } catch (e) {
    e.message = `the line was posted, but the note that records it on #${release.number} was not written (${e.message}): check ${channel} before running this again, or it posts a second line`;
    throw e;
  }
  return { status: 'done', message: `Posted the ${channel} line for ${release.tag}.` };
}

// ---------------------------------------------------------------------------
// "Live in" comments

/**
 * Comments "Live in <tag>" on each issue the release closes: the issues GitHub links to each PR of
 * the release as ones it closes (`Fixes #1`, not `Refs #1`), in the product repo. Each issue is
 * looked at on its own, so one that cannot be commented on never holds back the rest. Returns the
 * counts, and `failed` with each issue that could not be commented on.
 */
async function liveInComments({
  github, repo, release, facts, trusted, sleep,
}) {
  const prs = facts && Array.isArray(facts.prs) ? facts.prs.map((p) => p && p.number).filter(Number.isInteger) : null;
  if (!prs) throw new ReleaseError(`releases/${release.tag}/facts.json lists no pull requests: there is no way to know which issues the release closes`);
  const issues = new Set();
  const outside = new Set();
  for (const n of prs) {
    for (const link of await retrying(() => github.listClosingIssues(repo, n), { sleep })) {
      if (link.repo.toLowerCase() === repo.toLowerCase()) issues.add(link.number);
      else outside.add(`${link.repo}#${link.number}`);
    }
  }
  const marker = markerOf('live-in', release.tag);
  const body = `Live in ${release.tag} (release PR #${release.number}).\n\n${marker}`;
  const done = [];
  const already = [];
  const failed = [];
  for (const n of [...issues].sort((a, b) => a - b)) {
    try {
      // Reading the comments and writing one is the unit that runs again: a second try reads first.
      await retrying(async () => {
        if (await hasMarker(github, repo, n, marker, trusted)) {
          already.push(n);
          return;
        }
        await github.createIssueComment(repo, n, body);
        done.push(n);
      }, { sleep });
    } catch (e) {
      if (!isFailure(e)) throw e;
      failed.push({ number: n, why: e.message });
    }
  }
  return {
    done, already, failed, outside: [...outside],
  };
}

// ---------------------------------------------------------------------------
// A Bug for an output that failed, and its close when a run again works

const OUTPUT_NAMES = { page: 'changelog page', post: '#releases line', comments: '"Live in" comments' };

function bugBody({ tag, output, message, runUrl }) {
  return [
    `The ${OUTPUT_NAMES[output]} for ${tag} did not go out. The release itself is done: the tag is made and nothing is undone.`,
    '',
    `**What failed:** ${oneLine(message, 600)}`,
    ...(runUrl ? ['', `**The run:** ${runUrl}`] : []),
    '',
    `**To try again:** run the Announce job for ${tag} again (the same \`announce\` call: re-run its job, or run the workflow with the tag). It first looks for what was already done, so it never repeats it.${output === 'post' ? ' Look in the channel first: a line that timed out may have been posted.' : ''} When it works, this issue closes by itself.`,
    '',
    markerOf(`bug-${output}`, tag),
  ].join('\n');
}

// The open Bug of an earlier failure of this output, if there is one that the job itself filed.
async function findBug(github, repo, tag, output, trusted) {
  const marker = markerOf(`bug-${output}`, tag);
  const open = await github.listOpenIssuesByLabel(repo, BUG_LABEL);
  return open.find((i) => i && isTrusted(trusted, i.user) && String(i.body || '').includes(marker)) || null;
}

async function fileBug({
  github, repo, tag, output, message, runUrl, trusted,
}) {
  const existing = await findBug(github, repo, tag, output, trusted);
  if (existing) {
    await github.createIssueComment(repo, existing.number, `It failed again: ${oneLine(message, 600)}${runUrl ? `\n\n${runUrl}` : ''}`);
    return { number: existing.number, created: false };
  }
  const issue = await github.createIssue(repo, {
    title: `Release ${tag}: the ${OUTPUT_NAMES[output]} did not go out`,
    body: bugBody({
      tag, output, message, runUrl,
    }),
    labels: [BUG_LABEL],
  });
  return { number: issue.number, created: true };
}

async function settleBug({
  github, repo, tag, output, trusted,
}) {
  const existing = await findBug(github, repo, tag, output, trusted);
  if (!existing) return null;
  await github.createIssueComment(repo, existing.number, 'It went out on a later run. Closing.');
  await github.closeIssue(repo, existing.number);
  return existing.number;
}

module.exports = {
  ACTIONS_BOT, OUTPUTS, findRelease, parseAnnounce, parseTargets, checkTarget, pagePath, parseNotes, needTitle, retrying, isTransient, isFailure, markerOf, trustedLogins,
  hasMarker, renderPage, samePage, pageBranch, openPage, slackEscape, releaseUrl, postLine, liveInComments, bugBody, fileBug, settleBug, oneLine,
};
