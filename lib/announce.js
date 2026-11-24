'use strict';

// What follows the tag: the #releases line for a product with no page and a "Live in" comment on each
// issue the release closes (`shipyard announce`), and the changelog page on the product's site repo (`shipyard
// changelog-page`, a job of its own: lib/changelog-page-command.js). Reads GitHub only:
// no checkout, and nothing from the repo is ever run. The config is read at the release PR's merge
// commit, which the release tag names, and the notes and the facts from the release data in the PR's
// body, checked against its cut commit, so the text is the text the approver approved. Every output can be run again: it looks for what an earlier run did before it
// writes, and a failure never undoes the tag.

const crypto = require('node:crypto');
const { GitHubError } = require('./github');
const { SlackError } = require('./slack');
const { isBeforeYouUpdate, firstSentence } = require('./lint-prep');
const { hasNoteItems } = require('./changelog');
const {
  ReleaseError, Refusal, parseTag,
} = require('./release-git');
const {
  releaseOf, readRelease, commitOfRef, isReleaseBase, isReleaseHead, show, short,
} = require('./tag');
const { JOB_LABEL, parseJob } = require('./prep-job');
const { shippedBy, closeJob } = require('./start');
const { loadReaderConfig, settingsOf, trustValue } = require('./reader-config');
const { YAML_FILE, JSON_FILE } = require('./repo-config');

const ACTIONS_BOT = 'github-actions[bot]';
const BUG_LABEL = 'bug';
const OUTPUTS = ['post', 'comments'];
const REPO = /^[^/\s]+\/[^/\s]+$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const PAGE_PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const PLACEHOLDERS = /\{(tag|version|dashed)\}/g;
// What a front matter value may hold: the page's own title and date, and the release's names.
const FRONT_PLACEHOLDERS = /\{(title|date|tag|version|dashed)\}/g;
const FRONT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_FRONT_FIELDS = 12;
// What a page has when `.github/release.json` says nothing: a title and a date.
const DEFAULT_FRONT_MATTER = Object.freeze({ title: '{title}', date: '{date}' });
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
 * The commit a release tag names, or `{ skip }` for a name that is no release tag (the floating `v1` moves under the same
 * push trigger), a Refusal for a tag that does not exist.
 */
async function tagCommit({
  github, repo, tag, prefix,
}) {
  if (!parseTag(tag, prefix)) return { skip: `${show(tag, 60)} is not a release tag (${show(prefix, 20)} and X.Y.Z), so there is nothing to announce` };
  const ref = await github.getTagRef(repo, tag);
  if (!ref) throw new Refusal(`${tag} is not a tag of ${repo}: the announcement follows the tag`);
  return { sha: await commitOfRef(github, repo, ref), ref };
}

/**
 * The release a tag stands for, read from GitHub: the tag must exist, name the merge commit of a
 * merged release PR from one of the release automation's accounts, and agree with that PR's title.
 * Returns `{ skip }` for a name that is no release tag, a Refusal for anything else that is wrong.
 * `commit` is what `tagCommit` already answered, so the tag is not looked up twice.
 */
async function findRelease({
  github, repo, tag, prefix, automationLogins, current = null, commit = null,
}) {
  const at = commit || await tagCommit({
    github, repo, tag, prefix,
  });
  if (at.skip) return { skip: at.skip };
  const { sha, ref } = at;
  const found = (await github.listPullsOfCommit(repo, sha))
    .filter((p) => p && p.merged_at && p.merge_commit_sha === sha && p.base && isReleaseBase(p.base.ref) && p.head && isReleaseHead(p.head.ref));
  if (!found.length) throw new Refusal(`${tag} is at ${short(sha)}, which is not the merge of a release PR: nothing is announced`);
  const pr = await github.getPull(repo, found[0].number);
  const release = releaseOf(pr, {
    repo, prefix, automationLogins, sha,
  });
  if (release.tag !== tag) throw new Refusal(`#${release.number} is the release PR of ${release.tag}, not ${tag}`);
  // The notes and the facts: from the block in the PR's body, checked against its cut commit, or for a release cut
  // before that, from releases/<tag>/ at the merge commit. A body that does not match its cut commit is a Refusal.
  release.inputs = await readRelease({
    github: {
      getCommit: (r, sha) => github.getCommit(r, sha),
      getFileText: async (r, file, at) => {
        const f = await github.getFile(r, file, at);
        return f ? f.text : null;
      },
    },
    repo,
    release,
    pr,
    current,
  });
  // The moment it shipped is the annotated tag's own date, so a run again writes the same page.
  let date = null;
  if (ref.type === 'tag') date = (await github.getTagObject(repo, ref.sha)).date || null;
  return { release, date };
}

// ---------------------------------------------------------------------------
// What the repo says: `announce` in `.github/shipyard.yml` or `.github/release.json`

/**
 * The announce setting of a repo's config (`.github/shipyard.yml`, else `.github/release.json`; `file` names the one read,
 * for a message), parsed ({} for none):
 *   "announce": { "page": { "repo": "<owner>/<name>", "path": "<path with {version}>", "base": "main",
 *                           "frontMatter": { "<field>": "<text with {title}, {date}, {tag}, {version}, {dashed}>" } } }
 * A repo with no `page` has no page: it gets the #releases line instead.
 */
function parseAnnounce(config, product, file = JSON_FILE) {
  if (config === undefined || config === null) return { page: null };
  if (!isObject(config)) throw new ReleaseError(`${file} is not an object`);
  if (config.announce === undefined) return { page: null };
  const where = `${file}: announce`;
  const a = config.announce;
  if (!isObject(a)) throw new ReleaseError(`${where} must be an object`);
  for (const key of Object.keys(a)) if (key !== 'page') throw new ReleaseError(`${where} has no setting ${show(key, 40)} (settings: page)`);
  if (a.page === undefined) return { page: null };
  const p = a.page;
  if (!isObject(p)) throw new ReleaseError(`${where}.page must be an object`);
  for (const key of Object.keys(p)) {
    if (!['repo', 'path', 'base', 'frontMatter'].includes(key)) throw new ReleaseError(`${where}.page has no setting ${show(key, 40)} (settings: repo, path, base, frontMatter)`);
  }
  if (typeof p.repo !== 'string' || !REPO.test(p.repo)) throw new ReleaseError(`${where}.page.repo must be <owner>/<name>`);
  if (p.repo.toLowerCase() === String(product).toLowerCase()) throw new ReleaseError(`${where}.page.repo is the product repo itself: a page goes to the site's repo`);
  if (typeof p.path !== 'string') throw new ReleaseError(`${where}.page.path must be a path with {version}, {tag} or {dashed} in it`);
  if (!p.path.match(PLACEHOLDERS)) throw new ReleaseError(`${where}.page.path must hold {version}, {tag} or {dashed}, so each release has its own page`);
  if (/[{}]/.test(p.path.replace(PLACEHOLDERS, ''))) throw new ReleaseError(`${where}.page.path holds a { or } that is not {version}, {tag} or {dashed}`);
  const base = p.base === undefined ? 'main' : p.base;
  if (typeof base !== 'string' || !BRANCH.test(base)) throw new ReleaseError(`${where}.page.base must be a branch name`);
  const page = { repo: p.repo, path: p.path, base };
  if (p.frontMatter !== undefined) page.frontMatter = parseFrontMatter(p.frontMatter, `${where}.page.frontMatter`);
  pagePath(page.path, { tag: 'v1.2.3', parts: [1, 2, 3] }, file);
  return { page };
}

// The front matter a site's changelog page needs, as field name to value text. Each value is text with
// {title}, {date}, {tag}, {version} or {dashed} in it, and nothing else in braces, so a repo's file
// can shape the page's header and can write nothing else into it.
function parseFrontMatter(fields, where) {
  if (!isObject(fields)) throw new ReleaseError(`${where} must be an object of field name to value`);
  const keys = Object.keys(fields);
  if (!keys.length) throw new ReleaseError(`${where} names no field: leave it out for the default (title and date)`);
  if (keys.length > MAX_FRONT_FIELDS) throw new ReleaseError(`${where} names ${keys.length} fields: at most ${MAX_FRONT_FIELDS}`);
  const out = {};
  for (const key of keys) {
    if (!FRONT_KEY.test(key)) throw new ReleaseError(`${where} has the field name ${show(key, 40)}: a name is a letter, then letters, digits, - or _ (40 at most)`);
    const value = fields[key];
    if (typeof value !== 'string' || !value || value.length > 200) throw new ReleaseError(`${where}.${key} must be text of 1 to 200 characters`);
    if (/[{}]/.test(value.replace(FRONT_PLACEHOLDERS, ''))) throw new ReleaseError(`${where}.${key} holds a { or } that is not {title}, {date}, {tag}, {version} or {dashed}`);
    out[key] = value;
  }
  return out;
}

// The page's file path for a release: the template filled in, and held to a markdown file in a
// folder that is not hidden, so the release bot's merge can touch a changelog page and nothing else.
function pagePath(template, release, file = JSON_FILE) {
  const filled = template
    .replace(/\{tag\}/g, release.tag)
    .replace(/\{version\}/g, release.parts.join('.'))
    .replace(/\{dashed\}/g, release.parts.join('-'));
  const segments = filled.split('/');
  const ok = filled.length <= 200 && segments.every((s) => PAGE_PATH_SEGMENT.test(s)) && /\.mdx?$/.test(filled);
  if (!ok) throw new ReleaseError(`${file}: announce.page.path makes ${show(filled, 80)}, which is not a markdown file (.md or .mdx) in a folder with plain, visible names`);
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
 * The release notes (the release data's, or `releases/<tag>/release-notes.md` as text) or null when the release has no release notes: no
 * notes, or no item (the same test the release check makes: `hasNoteItems`, bullets with or without a `## ` label). `title` is the
 * `# ` line, `body` is everything under it, the reference block included.
 */
function parseNotes(raw) {
  if (raw === null || raw === undefined) return null;
  const text = String(raw).replace(/\r\n?/g, '\n');
  if (!hasNoteItems(text)) return null;
  const m = /^# (.+)$/m.exec(text);
  const title = m ? oneLine(m[1], 300) : null;
  const body = m ? text.replace(/^# .+\n+/m, '') : text;
  return { title, body: body.replace(/^\n+/, '') };
}

// Where a release's data was read from, for a message: the release PR's body, or the folder of a release cut before that.
const whereOf = (release, file) => (release.inputs && release.inputs.source === 'body'
  ? `the release data in #${release.number}'s body`
  : `releases/${release.tag}/${file}`);

/**
 * The repo's announce setting at `sha`, the commit the release tag names: through the shared reader (lib/reader-config.js), so
 * it is `.github/shipyard.yml`, else `.github/release.json`, and no page for a repo with neither. Returns `{ page, file,
 * settings }`; `settings` is the resolved shipyard.yml (opener logins, page targets) or null for release.json or no file.
 * Reads only, so a call that fails in a way a second try can clear is tried again.
 */
async function readAnnounceConfig({
  github, repo, sha, sleep, area, defaultBranch, warn,
}) {
  const loaded = await retrying(() => loadReaderConfig({ github, repo, ref: sha }, { warn }), { sleep });
  // release.json refuses a malformed announce setting; so must shipyard.yml, or the same repo gets no page from one file and a refusal
  // from the other. The loader left such a key out of `config` and said why in `errors`.
  const errors = loaded.errors || [];
  if (errors.length) {
    throw new ReleaseError(`${YAML_FILE} has a key the page and the announcement cannot read, so they would differ from ${JSON_FILE}: ${errors.map((e) => oneLine(e, 300)).join(' ')}`);
  }
  const settings = await retrying(() => settingsOf(loaded, {
    repo, area, defaultBranch, github, warn,
  }), { sleep });
  return { ...parseAnnounce(loaded.config, repo, loaded.file || JSON_FILE), file: loaded.file, settings };
}

/**
 * What a command that needs the opener logins before it can find the release reads first: the commit the tag names, the
 * config there and, from it, the logins that may open a release PR. On shipyard.yml they are the org's list and a flag the
 * caller still gives is ignored with a warning; on release.json or no file they are `openers` (`--automation-logins`), and
 * `required` is the message when there are none. The config is read once, here, and reused for the page.
 *
 * A failure of that read that a repo passing its logins can live with (an unreadable release.json, GitHub failing) is not
 * thrown: it is `error`, for the command to raise where it needs the config, as it did when it read the file there. A
 * shipyard.yml that cannot be read is thrown, since no logins can then be known.
 * Returns `{ commit, config, error, automationLogins, settings }`; with no `commit`, `error` is the tag's own lookup failing, which
 * findRelease would have met in the same words (the command throws it where it finds the release).
 */
async function readTagConfig({
  github, repo, tag, prefix, sleep, area, defaultBranch, openers, required, warn,
}) {
  let commit = null;
  let read = null;
  let error = null;
  try {
    commit = await retrying(() => tagCommit({
      github, repo, tag, prefix,
    }), { sleep });
    if (commit.sha) {
      read = await readAnnounceConfig({
        github, repo, sha: commit.sha, sleep, area, defaultBranch, warn,
      });
    }
  } catch (e) {
    if (e instanceof Refusal || !isFailure(e)) throw e;
    if (!openers.length || (e instanceof ReleaseError && e.message.includes(YAML_FILE))) throw e;
    error = e;
  }
  const settings = read && read.settings ? read.settings : null;
  const automationLogins = trustValue({
    settings, resolved: settings && settings.openerLogins, given: openers, flag: '--automation-logins', warn,
  });
  // A tag that is no release tag is skipped by findRelease, whoever the openers are.
  if (!settings && !automationLogins.length && !(commit && commit.skip)) throw new ReleaseError(required);
  return {
    commit, config: read, error, automationLogins, settings,
  };
}

// The release notes findRelease read: the release PR's body, or releases/<tag>/ for a release cut before that.
const readReleaseNotes = async (ctx) => parseNotes(ctx.release.inputs.notes);

function needTitle(notes, release) {
  if (!notes.title) throw new ReleaseError(`${release.inputs && release.inputs.source === 'body' ? `the release notes in #${release.number}'s body have` : `releases/${release.tag}/release-notes.md has`} no title line (# ...)`);
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

// Whether the job already left the "Live in" comment `text` on an issue: a comment of the job's own
// accounts whose whole visible text is `text`, or one an earlier release wrote with `oldMarker` after it.
// A comment with the same words from any other account counts for nothing.
async function hasLiveIn(github, repo, number, text, oldMarker, trusted) {
  return (await github.listIssueComments(repo, number)).some((c) => {
    if (!c || !isTrusted(trusted, c.user)) return false;
    const body = String(c.body || '');
    return body.trim() === text || body.includes(oldMarker);
  });
}

// ---------------------------------------------------------------------------
// The changelog page

// The text of one front matter value for a release. Every value is written as a quoted string, a
// date too: the sites sort pages by comparing the value as a string, which a bare YAML timestamp breaks.
function frontLine(key, template, { title, date, release }) {
  const text = template.replace(FRONT_PLACEHOLDERS, (_, name) => {
    if (name === 'title') return title;
    if (name === 'date') return String(date);
    if (name === 'tag') return release.tag;
    if (name === 'version') return release.parts.join('.');
    return release.parts.join('-');
  });
  return `${key}: ${JSON.stringify(text)}`;
}

// `frontMatter` is the page setting of `.github/release.json` (a title and a date when it has none).
// A template with {tag}, {version} or {dashed} needs the `release`.
function renderPage({
  title, body, date, release, frontMatter,
}) {
  const fields = frontMatter || DEFAULT_FRONT_MATTER;
  const lines = Object.entries(fields).map(([key, template]) => frontLine(key, template, { title, date, release }));
  return `---\n${lines.join('\n')}\n---\n\n${body}`;
}

// Two pages are the same page when only the date differs: the date is the moment of shipping,
// and a run again may only know a later one. A field that holds the date is compared without it.
function samePage(a, b, frontMatter) {
  const dated = Object.entries(frontMatter || DEFAULT_FRONT_MATTER).filter(([, t]) => t.includes('{date}')).map(([k]) => k);
  const withoutDate = (text) => dated.reduce((t, key) => t.replace(new RegExp(`^${key}: .*$`, 'm'), `${key}:`), String(text));
  return withoutDate(a) === withoutDate(b);
}

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
  const title = needTitle(notes, release);
  const file = pagePath(page.path, release);
  const text = renderPage({
    title, body: notes.body, date, release, frontMatter: page.frontMatter,
  });
  const where = `${site} ${show(file, 100)}`;

  const tip = await github.branchTip(site, base);
  if (!tip) throw new ReleaseError(`${site} has no branch ${show(base, 40)} to open the page against`);
  const onBase = await github.getFile(site, file, base);
  if (onBase) {
    if (samePage(onBase.text, text, page.frontMatter)) return { status: 'done', message: `The page is already on ${site}'s ${base} (${show(file, 100)}): nothing to do.` };
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
  } else if (!samePage(onBranch.text, text, page.frontMatter)) {
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
  if (!atHead || !samePage(atHead.text, text, page.frontMatter)) throw new Refusal(`page PR #${pr.number} on ${site} holds other text than the release notes: not merged`);
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

// The highlights and the steps of the release notes' body, as `releases/<tag>/release-notes.md` holds them: each
// `- ` line above the first line that is exactly `---` (the reference block's rule) is an item, `- **<name>:** <text>`
// when it has a name. An item under a "Before you upgrade" heading (`isBeforeYouUpdate` takes the older wording too) is a step
// (`before`); every other item, under any heading or none, is a highlight. An item's text is its first sentence.
// The summary paragraph and the reference block are not posted.
function postItems(body) {
  const highlights = [];
  const before = [];
  let inBefore = false;
  for (const line of String(body).split('\n')) {
    if (line.trimEnd() === '---') break;
    const heading = /^## (.+)$/.exec(line);
    if (heading) { inBefore = isBeforeYouUpdate(heading[1]); continue; }
    const item = /^- (\S.*)$/.exec(line);
    if (!item) continue;
    const named = /^\*\*(.+?):\*\*\s+(\S.*)$/.exec(item[1]);
    const entry = named ? { name: oneLine(named[1], 80), text: oneLine(firstSentence(named[2]), 400) } : { name: null, text: oneLine(firstSentence(item[1]), 400) };
    if (inBefore) before.push(entry);
    else highlights.push(entry);
  }
  return { highlights, before };
}

// A link in an item's text, as the notes write it: [label](https://...). Any other address is left as text.
const MARKDOWN_LINK = /\[([^\]\n]+)\]\((https?:\/\/[^\s<>|()]+)\)/g;

// An item's text as rich_text elements, which Slack shows as typed: a link is a link element, and
// `&`, `<` and `>` are plain characters there, so a title or an item can make no mention.
function richElements(text, style) {
  const out = [];
  const plain = (t) => { if (t) out.push({ type: 'text', text: t, ...(style ? { style } : {}) }); };
  let last = 0;
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    plain(text.slice(last, m.index));
    out.push({ type: 'link', url: m[2], text: m[1], ...(style ? { style } : {}) });
    last = m.index + m[0].length;
  }
  plain(text.slice(last));
  return out;
}

// The same text for the `text` fallback, in Slack's own markup, with `&`, `<` and `>` sent as entities.
const mrkdwn = (text) => {
  let out = '';
  let last = 0;
  for (const m of text.matchAll(MARKDOWN_LINK)) {
    out += slackEscape(text.slice(last, m.index)) + `<${m[2]}|${slackEscape(m[1])}>`;
    last = m.index + m[0].length;
  }
  return out + slackEscape(text.slice(last));
};

// A step's name as the action block's title: its first letter in lower case after "Action needed:" ("Drop who from
// preps" is "drop who from preps"); only a first word with a capital after its first letter, such as "API" or
// "OAuth", keeps its case, so a plain name such as "Slack token" is lowered too.
const stepTitle = (name) => (name && !/^[A-Z]{2}|^[A-Z][a-z]*[A-Z]/.test(name) ? name[0].toLowerCase() + name.slice(1) : name);

// The #releases message of a release: one bold line (the product and version), a blank line, the highlights as a
// bulleted list with each name in italics, and a blank line. Each step to take before the next cut is a block
// of its own, `:warning: *Action needed: <name>*` with its text on the next line and a blank line after it. The
// link comes last. `blocks` is what Slack shows, `text` is the fallback of a notification. No PR number is in it:
// only the notes' own words are.
function slackPost({ title, highlights, before, url }) {
  const heading = title.split(' - ')[0].trim() || title;
  const bullet = (h) => ({
    type: 'rich_text_section',
    elements: h.name ? [...richElements(h.name, { italic: true }), { type: 'text', text: ': ' }, ...richElements(h.text)] : richElements(h.text),
  });
  const bold = (t) => ({ type: 'text', text: t, style: { bold: true } });
  const nl = (n) => ({ type: 'text', text: '\n'.repeat(n) });
  // A blank line is "\n\n" at the end of a section, or "\n" at the start of the section after a list, which has
  // no line end of its own.
  const elements = [{ type: 'rich_text_section', elements: [bold(heading), nl(2)] }];
  if (highlights.length) elements.push({ type: 'rich_text_list', style: 'bullet', elements: highlights.map(bullet) });
  let lead = highlights.length ? [nl(1)] : [];
  for (const step of before) {
    elements.push({
      type: 'rich_text_section',
      elements: [
        ...lead, { type: 'emoji', name: 'warning' }, { type: 'text', text: ' ' },
        bold(step.name ? `Action needed: ${stepTitle(step.name)}` : 'Action needed'), nl(1), ...richElements(step.text), nl(2),
      ],
    });
    lead = [];
  }
  elements.push({ type: 'rich_text_section', elements: [...lead, { type: 'text', text: 'Release notes: ' }, { type: 'link', url }] });
  const lines = [`*${slackEscape(heading)}*`, ''];
  if (highlights.length) lines.push(...highlights.map((h) => `\u2022 ${h.name ? `_${slackEscape(h.name)}_: ` : ''}${mrkdwn(h.text)}`), '');
  for (const step of before) lines.push(`:warning: *${slackEscape(step.name ? `Action needed: ${stepTitle(step.name)}` : 'Action needed')}*`, mrkdwn(step.text), '');
  lines.push(`Release notes: ${url}`);
  return { text: lines.join('\n'), blocks: [{ type: 'rich_text', elements }] };
}

/**
 * Posts the one #releases message of a release: the product and version, the notes' named highlights, any
 * step to take before updating, and the GitHub Release link. The job's own comment on the release PR is the
 * record that it was posted, so a run again posts nothing twice. A failure after the post never posts again:
 * it is `posted` on the error, for the Bug to say.
 */
async function postLine({
  github, slack, channel, repo, release, notes, serverUrl, trusted, sleep,
}) {
  const title = needTitle(notes, release);
  const marker = markerOf('post', release.tag);
  const { highlights, before } = postItems(notes.body);
  const { text, blocks } = slackPost({ title, highlights, before, url: releaseUrl(serverUrl, repo, release.tag) });
  if (await retrying(() => hasMarker(github, repo, release.number, marker, trusted), { sleep })) {
    return { status: 'done', message: `The ${channel} line for ${release.tag} was already posted: nothing to do.` };
  }
  await retrying(() => slack.postMessage(channel, text, { blocks }), { sleep });
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
  if (!prs) throw new ReleaseError(`${whereOf(release, 'facts.json')} lists no pull requests: there is no way to know which issues the release closes`);
  const issues = new Set();
  const outside = new Set();
  for (const n of prs) {
    for (const link of await retrying(() => github.listClosingIssues(repo, n), { sleep })) {
      if (link.repo.toLowerCase() === repo.toLowerCase()) issues.add(link.number);
      else outside.add(`${link.repo}#${link.number}`);
    }
  }
  // The comment carries no hidden text: the fleet's public guard holds any item that links a comment
  // with hidden text from an account it does not trust. A run again finds it by its exact visible text,
  // and by the marker an earlier release wrote, so a run again over an old release posts nothing.
  const body = `Live in ${release.tag} (release PR #${release.number}).`;
  const oldMarker = markerOf('live-in', release.tag);
  const done = [];
  const already = [];
  const failed = [];
  for (const n of [...issues].sort((a, b) => a - b)) {
    try {
      // Reading the comments and writing one is the unit that runs again: a second try reads first.
      await retrying(async () => {
        if (await hasLiveIn(github, repo, n, body, oldMarker, trusted)) {
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
// The prep job a release shipped

/**
 * Closes the repo's open prep jobs whose commit a release tag contains, with the comment the start
 * writes (`shippedBy` and `closeJob` of lib/start.js, the same check and the same words).
 * Only jobs filed in this repo are in reach of the job's token, and only a job whose block names this
 * repo is looked at: a job filed in another repo (a `jobs_token` caller's central repo) is left to
 * the daily start. A closed job is not listed, so a run again closes and posts nothing twice. Each job
 * is looked at on its own: one that cannot be closed is in `failed` and holds back no other. A read
 * that still fails after its retries (the list of jobs) throws.
 * Returns `{ closed: [{ number, tag }], failed: [{ number, why }] }`.
 */
async function closeShippedJobs({ github, repo, sleep }) {
  const jobs = (await retrying(() => github.listOpenIssuesByLabel(repo, JOB_LABEL), { sleep }))
    .map((i) => ({ number: i.number, job: parseJob(i.body) }))
    .filter((j) => j.job && j.job.repo.toLowerCase() === repo.toLowerCase())
    .sort((a, b) => a.number - b.number);
  const closed = [];
  const failed = [];
  for (const { number, job } of jobs) {
    try {
      const tag = await retrying(() => shippedBy(github, job), { sleep });
      if (!tag) continue;
      // The comment and the close are writes: not tried again here, the daily start closes what this misses.
      await closeJob(github, repo, number, `Released as ${tag}: ${tag} contains this job's commit. Closing the job.`);
      closed.push({ number, tag });
    } catch (e) {
      if (!isFailure(e)) throw e;
      failed.push({ number, why: e.message });
    }
  }
  return { closed, failed };
}

// ---------------------------------------------------------------------------
// A Bug for an output that failed, and its close when a run again works

const OUTPUT_NAMES = { post: '#releases line', comments: '"Live in" comments' };

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
  ACTIONS_BOT, OUTPUTS, tagCommit, findRelease, readTagConfig, parseAnnounce, parseTargets, checkTarget, pagePath, parseNotes, needTitle, firstSentence, retrying, isTransient, isFailure, markerOf, trustedLogins,
  hasMarker, hasLiveIn, readAnnounceConfig, readReleaseNotes, renderPage, samePage, pageBranch, openPage, slackEscape, releaseUrl, whereOf, postItems, slackPost, postLine, liveInComments, closeShippedJobs, bugBody, fileBug, settleBug, oneLine,
};
