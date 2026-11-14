'use strict';

// The release check: ten rules a release PR into `main` or `main-*` must meet before it can
// merge. `gather` reads the candidate from git and GitHub once; each rule is then a plain
// function of what was read, so a rule never calls the network and every answer comes from
// the same reading. `release-check-command.js` runs it on a PR event and writes the status.
//
// Nothing here runs code from the candidate: git is asked for commits, trees and blobs, and
// the PR's own text is data.

const { GitHubError } = require('./github');
const { extractLines, visibleText } = require('./changelog-line');
const { issuesOf } = require('./facts');
const { isFleet, lastReviews } = require('./record');
const { driversOf, evidencePathOf } = require('./record-command');
const {
  ReleaseError, git, parseTag, bump, formatVersion, compareParts, isAncestor, rangeCommits, prNumberOf,
} = require('./release-git');

const RELEASE_JSON = '.github/release.json';
const LEVELS = new Set(['major', 'minor', 'patch']);
const TRUSTED = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);
const CONCURRENCY = 8;

// The ten rules, in the handbook's order. The id is what a log line and the summary show.
const CHECKS = [
  ['automation-branch', 'The head is a release/ branch that automation cut'],
  ['version', 'The version is the newest tag plus the approved level, the same everywhere'],
  ['tested-build', 'The tested build is the candidate, apart from the notes and evidence'],
  ['after-the-cut', 'After the cut, commits with no PR touch only the notes and this version\'s CHANGELOG section'],
  ['contains-base', 'The candidate contains the newest commit of its release branch'],
  ['older-lines', 'The candidate contains the newest release of every older supported line of its major'],
  ['own-dependencies', 'Every dependency on our own products is a released version'],
  ['siblings', 'The state of the other PRs in its pair, train or wave'],
  ['independent-approval', 'Every change has an approval from a person who did not drive it'],
  ['notes-when-needed', 'A breaking, major or Update-Needs candidate has release notes'],
];

// ---------------------------------------------------------------------------
// Small helpers

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const show = (dir, commit, file) => git(dir, ['show', `${commit}:${file}`], { allowFail: true });
const commitOf = (dir, ref) => {
  const out = git(dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });
  return out && /^[0-9a-f]{40}$/.test(out.trim()) ? out.trim() : null;
};
const changedFiles = (dir, from, to) => git(dir, ['diff', '--name-only', '--no-renames', '-z', from, to]).split('\0').filter(Boolean);
const under = (file, folder) => file === folder || file.startsWith(`${folder.replace(/\/+$/, '')}/`);
// A merge with no PR that takes in the release branch: the files it changes that do not read as the
// base's side has them, where the base's side changed them since the merge-base. Null when a merged-in
// parent is not in the base, so it is not such a merge at all. A merge of an old base commit brings
// nothing (its side changed nothing), so a file it deletes or rolls back is the merge's own change.
function filesNotFromBase(dir, sha, base) {
  const [, first, ...extra] = git(dir, ['rev-list', '--parents', '-n', '1', sha]).trim().split(' ');
  if (!first || !extra.length || !extra.every((p2) => isAncestor(dir, p2, base))) return null;
  const sides = extra.map((p2) => ({ p2, mb: (git(dir, ['merge-base', first, p2], { allowFail: true }) || '').trim() }));
  return changedFiles(dir, first, sha).filter((f) => {
    const now = show(dir, sha, f);
    return !sides.some(({ p2, mb }) => mb && now === show(dir, p2, f) && show(dir, p2, f) !== show(dir, mb, f));
  });
}

const oneLine = (s, max = 200) => String(s).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

// The base branch's line: `main` takes every release tag, `main-2` the 2.x tags, `main-1.4` the 1.4.x tags.
function lineOf(baseRef) {
  if (baseRef === 'main') return { name: 'main', major: null, minor: null };
  const m = /^main-(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.exec(String(baseRef));
  if (!m) return null;
  return { name: baseRef, major: Number(m[1]), minor: m[2] === undefined ? null : Number(m[2]) };
}

const inLine = (parts, line) => (line.major === null || parts[0] === line.major) && (line.minor === null || parts[1] === line.minor);

function releaseTags(dir, prefix) {
  return git(dir, ['tag', '--list']).split('\n').map((t) => t.trim()).filter(Boolean)
    .map((t) => parseTag(t, prefix)).filter(Boolean)
    .sort((a, b) => compareParts(a.parts, b.parts));
}

// A CHANGELOG with one version's section (its heading up to the next `## ` heading) taken out,
// so two copies can be compared everywhere but that section.
function withoutSection(text, version) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const heading = new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(?:\\s|$)`);
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (heading.test(line)) inside = true;
    else if (/^## /.test(line)) inside = false;
    if (!inside) out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const hasSection = (text, version) => new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(?:\\s|$)`, 'm').test(String(text || ''));

// `/level <major|minor|patch> [product]` on the first line that holds anything.
function parseLevelComment(body) {
  const first = String(body || '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).find(Boolean) || '';
  const m = /^\/level\s+(\S+)(?:\s+(\S+))?$/i.exec(first);
  if (!m) return null;
  const level = m[1].toLowerCase();
  return LEVELS.has(level) ? { level, product: m[2] || null } : { level: null, product: m[2] || null };
}

// The cut commit's trailers: `Release-Level: minor`, `Release-Breaking: id, id`.
function trailersOf(message) {
  const out = {};
  for (const line of String(message || '').split('\n')) {
    const m = /^(Release-Level|Release-Breaking):\s*(.*?)\s*$/.exec(line);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

// ---------------------------------------------------------------------------
// The version files a repo names in release.json: `{ "path": "package.json", "json": "version" }`
// reads a field, `{ "path": "VERSION", "regex": "^(.+)$" }` the first group of a match.

function versionFilesOf(config) {
  const list = config.versionFiles;
  if (list === undefined) return [];
  const bad = () => new ReleaseError(`${RELEASE_JSON}: versionFiles must be a list of { "path", "json" } or { "path", "regex" }`);
  if (!Array.isArray(list)) throw bad();
  return list.map((v) => {
    if (!v || typeof v !== 'object' || typeof v.path !== 'string' || !v.path.trim() || v.path.split('/').includes('..') || v.path.startsWith('/')) throw bad();
    if ((typeof v.json === 'string') === (typeof v.regex === 'string')) throw bad();
    if (typeof v.regex === 'string') {
      try {
        new RegExp(v.regex, 'm'); // eslint-disable-line no-new
      } catch {
        throw bad();
      }
    }
    return v;
  });
}

function readVersionFile(text, spec) {
  if (text === null) return { found: false, why: 'is not in the candidate' };
  if (spec.json) {
    let value;
    try {
      value = JSON.parse(text);
    } catch {
      return { found: false, why: 'is not valid JSON' };
    }
    for (const key of spec.json.split('.')) value = value && typeof value === 'object' ? value[key] : undefined;
    return typeof value === 'string' ? { found: true, value: value.trim() } : { found: false, why: `has no string at ${spec.json}` };
  }
  const m = new RegExp(spec.regex, 'm').exec(text);
  return m && m[1] !== undefined ? { found: true, value: m[1].trim() } : { found: false, why: 'does not match its pattern' };
}

// ---------------------------------------------------------------------------
// Dependencies on our own products (rule 7)

const RELEASED_GO = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(\+incompatible)?$/;
const RELEASED_NPM = /^[\^~=]?v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function goModDeps(text) {
  const deps = [];
  let block = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (!line) continue;
    if (block) {
      if (line === ')') {
        block = null;
        continue;
      }
      deps.push({ kind: block, text: line });
      continue;
    }
    const open = /^(require|replace)\s*\($/.exec(line);
    if (open) {
      block = open[1];
      continue;
    }
    const one = /^(require|replace)\s+(.+)$/.exec(line);
    if (one) deps.push({ kind: one[1], text: one[2] });
  }
  const out = [];
  for (const d of deps) {
    if (d.kind === 'require') {
      const [name, version] = d.text.split(/\s+/);
      out.push({ name, version: version || '', released: RELEASED_GO.test(version || '') });
    } else {
      // `old [v] => new [v]`: a local path, or a module at a version that is not a release, is not released.
      const [, right = ''] = d.text.split('=>').map((s) => s.trim());
      const [left] = d.text.split('=>').map((s) => s.trim().split(/\s+/)[0]);
      const [target, version] = right.split(/\s+/);
      out.push({ name: left, version: `=> ${right}`, released: Boolean(version) && RELEASED_GO.test(version), replaceTarget: target });
    }
  }
  return out;
}

function packageJsonDeps(text) {
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const out = [];
  // devDependencies never ship, so only what a user's install pulls in counts.
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
    const deps = json && typeof json[field] === 'object' && json[field] ? json[field] : {};
    for (const [name, spec] of Object.entries(deps)) {
      const s = String(spec).trim();
      const alias = /^npm:(@?[^@]+)@(.+)$/.exec(s);
      out.push({ name: alias ? alias[1] : name, alsoNamed: name, version: s, released: RELEASED_NPM.test(alias ? alias[2] : s) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the candidate

/**
 * Reads everything the rules need, once.
 *
 * @param {object} o
 * @param {string} o.dir        a checkout of the product repo with its branches and tags
 * @param {string} o.repo       `<owner>/<name>`
 * @param {object} o.pr         the PR as the API returns it now
 * @param {object} o.github     lib/github.js client
 * @param {object} [o.orgGithub] a client whose token can read the approver team (defaults to `github`)
 * @param {object} o.options    { tagPrefix, changelog, armedLabel, fleetLogins[], automationLogins[], approvers, product }
 */
async function gather({ dir, repo, pr, github, orgGithub = github, options }) {
  const o = options;
  const r = {
    repo, pr, options: o, notes: [], fork: false, headPresent: false, fatal: null,
  };
  r.fork = !pr.head || !pr.head.repo || String(pr.head.repo.full_name).toLowerCase() !== repo.toLowerCase();
  r.head = String(pr.head && pr.head.sha);
  r.headPresent = commitOf(dir, r.head) === r.head;
  r.line = lineOf(pr.base && pr.base.ref);
  if (r.fork) return r;
  if (!r.headPresent) throw new ReleaseError(`the candidate's head ${r.head.slice(0, 7)} is not in the checkout: fetch every branch (fetch-depth: 0)`);

  // The base branch's tip as the checkout has it, else as the PR names it.
  r.base = commitOf(dir, `refs/remotes/origin/${pr.base.ref}`) || commitOf(dir, `refs/heads/${pr.base.ref}`) || commitOf(dir, pr.base.sha);
  if (!r.base) throw new ReleaseError(`the base branch ${pr.base.ref} is not in the checkout`);

  // release.json from the release branch; on the first release under this model the base has none,
  // and the candidate's own is read.
  let configText = show(dir, r.base, RELEASE_JSON);
  r.configFrom = 'base';
  if (configText === null) {
    configText = show(dir, r.head, RELEASE_JSON);
    r.configFrom = configText === null ? 'none' : 'candidate';
  }
  try {
    r.config = configText === null ? {} : JSON.parse(configText);
  } catch {
    throw new ReleaseError(`${RELEASE_JSON} (read from the ${r.configFrom === 'base' ? 'release branch' : 'candidate'}) is not valid JSON`);
  }
  if (!r.config || typeof r.config !== 'object' || Array.isArray(r.config)) r.config = {};
  r.versionFiles = versionFilesOf(r.config);

  // The title names the tag; the body's marker must name the same one.
  const title = /^Release (\S+)$/.exec(String(pr.title || '').trim());
  r.tag = title ? title[1] : null;
  r.parsed = r.tag ? parseTag(r.tag, o.tagPrefix) : null;
  r.version = r.parsed ? formatVersion(r.parsed.parts) : null;
  const marker = /^<!-- shipyard:release-pr (\S+) -->/m.exec(String(pr.body || ''));
  r.markerTag = marker ? marker[1] : null;

  // The cut: the commit `chore(release): <tag>` on the candidate's own line, after the base.
  const own = rangeCommits(dir, r.base, r.head);
  const cut = r.tag ? [...own].reverse().find((c) => c.subject === `chore(release): ${r.tag}`) : null;
  r.cut = cut ? cut.sha : null;
  if (r.cut) {
    r.cutFrom = commitOf(dir, `${r.cut}^1`);
    r.trailers = trailersOf(git(dir, ['log', '-1', '--format=%B', r.cut]));
  } else {
    r.trailers = {};
  }

  // The newest release tag of the base's line, not counting the candidate's own tag.
  const tags = r.line ? releaseTags(dir, o.tagPrefix).filter((t) => inLine(t.parts, r.line) && t.tag !== r.tag) : [];
  r.from = tags.length ? tags[tags.length - 1] : null;
  if (r.from) r.fromCommit = commitOf(dir, `refs/tags/${r.from.tag}`);

  // `/level` comments, and which of them come from the area's approver team.
  r.levels = [];
  const comments = await github.listIssueComments(repo, pr.number);
  r.comments = comments;
  const asked = comments.map((c) => ({ c, parsed: parseLevelComment(c.body) })).filter((x) => x.parsed);
  const membership = new Map();
  for (const { c, parsed } of asked) {
    const login = c.user && c.user.login;
    let accepted = false;
    let why;
    if (!parsed.level) why = 'names no level (major, minor or patch)';
    else if (parsed.product && parsed.product !== o.product) why = `is for ${oneLine(parsed.product, 40)}, not this product`;
    else if (!o.approvers) why = 'cannot be checked: no approver team is set';
    else if (!login || isFleet(c.user, new Set(o.fleetLogins.map((l) => l.toLowerCase())))) why = 'is not from a person';
    else {
      const key = login.toLowerCase();
      if (!membership.has(key)) {
        const [org, team] = o.approvers.split('/');
        membership.set(key, await orgGithub.teamMembership(org, team, login));
      }
      accepted = membership.get(key) === 'active';
      if (!accepted) why = `is from ${login}, who is not in ${o.approvers}`;
    }
    r.levels.push({ login, level: parsed.level, accepted, why, at: c.created_at });
  }

  // Each change: every PR on the first-parent line from the last release to the cut, and every
  // PR merged into the release branch since. A commit with neither is unattributed.
  r.changes = [];
  r.unattributed = [];
  r.afterCut = [];
  if (r.cut) {
    // Every first-parent commit from the last release tag to the cut, whether or not the tag is in
    // the cut's history (a hotfix tagged on main after develop moved on), then every one after it.
    const before = r.fromCommit ? rangeCommits(dir, r.fromCommit, r.cutFrom).reverse() : [];
    const after = rangeCommits(dir, r.cut, r.head).reverse();
    const commits = [
      ...before.map((c) => ({ ...c, n: prNumberOf(c.subject), afterCut: false })),
      ...after.map((c) => ({ ...c, n: prNumberOf(c.subject), afterCut: true })),
    ];
    const numbers = [...new Set(commits.map((c) => c.n).filter((n) => n !== null))].sort((a, b) => a - b);
    const fleet = new Set(o.fleetLogins.map((l) => l.toLowerCase()));
    const fetched = new Map(await mapLimit(numbers, CONCURRENCY, async (n) => {
      try {
        return [n, await github.getPull(repo, n)];
      } catch (e) {
        if (!(e instanceof GitHubError) || e.status !== 404) throw e;
        return [n, null];
      }
    }));
    // A subject is only a claim: a commit is PR #N's when GitHub says #N merged as that very commit.
    // A direct push whose subject ends `(#N)` borrows nothing from #N.
    const attributed = new Map();
    for (const c of commits) {
      const p = c.n === null ? null : fetched.get(c.n);
      const mine = Boolean(p && p.merged_at && p.merge_commit_sha === c.sha);
      if (c.afterCut) r.afterCut.push({ sha: c.sha, subject: c.subject, parents: c.parents, pr: mine ? c.n : null });
      if (mine) {
        if (!attributed.has(c.n)) attributed.set(c.n, { number: c.n, commit: c.sha, afterCut: c.afterCut });
        continue;
      }
      if (c.afterCut) continue; // rule 4 judges what a commit with no PR after the cut may touch
      if (c.n === null) {
        // A merge with no PR holds no change of its own only when what it brings in is already in
        // the release branch (a back-merge of main); any other branch merged by a push is a change.
        const own = c.parents > 1 ? filesNotFromBase(dir, c.sha, r.base) : null;
        if (c.parents > 1 && own === null) r.unattributed.push({ sha: c.sha, subject: oneLine(c.subject), why: 'merges a branch that is not in the release branch, with no pull request' });
        else if (c.parents > 1 && own.length) r.unattributed.push({ sha: c.sha, subject: oneLine(c.subject), why: `merges the release branch with no pull request but changes ${own.slice(0, 3).map((f) => oneLine(f, 80)).join(', ')} itself` });
        else if (c.parents <= 1) r.unattributed.push({ sha: c.sha, subject: oneLine(c.subject), why: 'no pull request number in its subject' });
      } else {
        const why = !p || !p.merged_at ? `#${c.n} is not a merged pull request` : `its subject names #${c.n}, but #${c.n} merged as another commit`;
        r.unattributed.push({ sha: c.sha, subject: oneLine(c.subject), why });
      }
    }
    r.changes = await mapLimit([...attributed.values()].sort((a, b) => a.number - b.number), CONCURRENCY, async (entry) => {
      const p = fetched.get(entry.number);
      const n = entry.number;
      // Its issues are the ones GitHub links to it, which an edit of the body after the merge cannot
      // drop. The issues the body names still count too: a keyword in a PR into a branch other than
      // the default, and every `Refs #N`, makes no link, and an issue only adds people who drove it.
      const issues = [...await github.listClosingIssues(repo, n), ...issuesOf(p.body)];
      const author = p.user && p.user.login && !isFleet(p.user, fleet) ? p.user.login : null;
      const [reviews, drivers] = await Promise.all([
        github.listPullReviews(repo, n),
        driversOf({ github, repo, pr: { number: n, author }, issues, armedLabel: o.armedLabel }),
      ]);
      return {
        ...entry,
        merged: true,
        // The PR's last head before it merged: an approval counts only when it saw that code.
        head: p.head && /^[0-9a-f]{40}$/.test(String(p.head.sha)) ? p.head.sha : null,
        baseRef: p.base && p.base.ref,
        title: oneLine(p.title),
        updateNeeds: extractLines(p.body || '').updateNeeds.some((l) => l.trim()),
        breakingTitle: /^[a-z]+(?:\([^)]*\))?!:/i.test(String(p.title || '').trim()),
        reviews,
        drivers,
      };
    });
  }

  // The candidate's own reviews and who drove it (whoever armed it), for rule 9.
  r.releaseReviews = await github.listPullReviews(repo, pr.number);
  r.releaseDrivers = await driversOf({ github, repo, pr: { number: pr.number, author: null }, issues: [], armedLabel: o.armedLabel });

  // The other PRs of a pair, train or wave: `Release-With: <owner>/<repo>#<n>` lines in the body.
  r.siblings = [];
  const seen = new Set();
  for (const m of visibleText(pr.body).matchAll(/^ {0,3}Release-With:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#(\d+)\s*$/gmi)) {
    const key = `${m[1].toLowerCase()}#${m[2]}`;
    if (seen.has(key) || seen.size >= 50) continue;
    seen.add(key);
    r.siblings.push({ repo: m[1], number: Number(m[2]) });
  }
  r.siblings = await mapLimit(r.siblings, CONCURRENCY, async (s) => {
    let p;
    try {
      p = await orgGithub.getPull(s.repo, s.number);
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) return { ...s, state: 'cannot see' };
      throw e;
    }
    const state = p.merged_at ? 'merged' : p.state;
    let check = 'none';
    if (state === 'open' && p.head && p.head.sha) {
      const statuses = await orgGithub.listCommitStatuses(s.repo, p.head.sha);
      const mine = statuses.find((x) => x.context === 'release-check');
      check = mine ? mine.state : 'none';
    }
    return { ...s, state, check, title: oneLine(p.title, 80) };
  });

  // The evidence folder from the same release.json as the rest of the rules: the release branch's,
  // so a candidate cannot widen what rules 3 and 4 let change.
  r.evidencePath = r.tag ? evidencePathOf(dir, r.configFrom === 'base' ? r.base : r.head, r.tag) : null;
  r.dir = dir;
  return r;
}

// ---------------------------------------------------------------------------
// The rules: each takes what `gather` read and returns { ok, detail[] }

const pass = (...detail) => ({ ok: true, detail });
const fail = (...detail) => ({ ok: false, detail });

function automationBranch(r) {
  const o = r.options;
  if (r.fork) return fail('the head comes from a fork, not a branch of this repo');
  const ref = String(r.pr.head.ref);
  const problems = [];
  if (!/^release\/\S+$/.test(ref)) problems.push(`the head is ${oneLine(ref, 80)}, not a release/ branch`);
  else if (r.version && ref !== `release/${r.version}`) problems.push(`the head is ${oneLine(ref, 80)}, but the title's version makes release/${r.version}`);
  const user = r.pr.user || {};
  const automation = o.automationLogins.map((l) => l.toLowerCase());
  const byAutomation = automation.length ? automation.includes(String(user.login || '').toLowerCase()) : user.type === 'Bot' || /\[bot\]$/i.test(String(user.login || ''));
  if (!byAutomation) problems.push(`the PR was opened by ${oneLine(user.login || 'nobody', 60)}, not by the release automation${automation.length ? ` (${o.automationLogins.join(', ')})` : ' (a bot account)'}`);
  if (!r.cut) problems.push(`the candidate has no cut commit \`chore(release): ${r.tag || '<tag>'}\` after ${r.pr.base.ref}`);
  return problems.length ? fail(...problems) : pass(`${ref}, opened by ${user.login}, cut at ${r.cut.slice(0, 7)}`);
}

function approvedLevel(r) {
  const accepted = r.levels.filter((l) => l.accepted);
  if (accepted.length) {
    const last = accepted[accepted.length - 1];
    return { level: last.level, from: `/level ${last.level} from ${last.login}` };
  }
  const t = r.trailers['Release-Level'];
  if (t && LEVELS.has(t)) return { level: t, from: `the prep run's level (${t})` };
  return { level: null, from: null };
}

function version(r) {
  if (!r.tag || !r.parsed) return fail(`the title must be "Release ${r.options.tagPrefix}X.Y.Z", not "${oneLine(r.pr.title, 80)}"`);
  const problems = [];
  const info = [];
  if (r.markerTag !== r.tag) problems.push(`the body's release-pr marker names ${r.markerTag ? oneLine(r.markerTag, 40) : 'no tag'}, not ${r.tag}`);
  if (!r.line) problems.push(`the base ${oneLine(r.pr.base.ref, 60)} is not main or main-<version>`);
  else if (!inLine(r.parsed.parts, r.line)) problems.push(`${r.version} is not a version of the ${r.line.name} line`);
  const level = approvedLevel(r);
  for (const l of r.levels.filter((x) => !x.accepted)) info.push(`ignored a /level comment: it ${l.why}`);
  if (!r.from) problems.push(`there is no release tag on the ${r.line ? r.line.name : 'base'} line to count from`);
  else if (!level.level) problems.push('there is no approved level: no /level from an approver, and the cut commit has no Release-Level');
  else {
    const expected = formatVersion(bump(r.from.parts, level.level));
    if (expected !== r.version) problems.push(`${r.from.tag} plus ${level.level} is ${expected}, not ${r.version} (${level.from})`);
    else info.push(`${r.from.tag} plus ${level.level} (${level.from}) is ${r.version}`);
  }
  // The notes and the CHANGELOG name this version.
  const notesFile = `releases/${r.tag}/release-notes.md`;
  const notes = show(r.dir, r.head, notesFile);
  if (notes === null) problems.push(`there are no release notes at ${notesFile}`);
  else {
    const titleLine = (/^# (.*)$/m.exec(notes) || [])[1] || '';
    const named = [...titleLine.matchAll(/\bv?(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]);
    if (named.some((v) => v !== r.version)) problems.push(`the release notes' title names ${named.find((v) => v !== r.version)}, not ${r.version}`);
  }
  const changelog = show(r.dir, r.head, r.options.changelog);
  if (!hasSection(changelog, r.version)) problems.push(`${r.options.changelog} has no section for ${r.version}`);
  for (const spec of r.versionFiles) {
    const got = readVersionFile(show(r.dir, r.head, spec.path), spec);
    if (!got.found) problems.push(`the version file ${spec.path} ${got.why}`);
    else if (got.value.replace(/^v/, '') !== r.version) problems.push(`the version file ${spec.path} says ${oneLine(got.value, 40)}, not ${r.version}`);
  }
  return problems.length ? fail(...problems, ...info) : pass(...info, `the title, the notes, ${r.options.changelog}${r.versionFiles.length ? ` and ${r.versionFiles.length} version file${r.versionFiles.length === 1 ? '' : 's'}` : ''} all say ${r.version}`);
}

function testedBuild(r) {
  if (!r.tag) return fail('no release tag in the title, so no evidence folder to read');
  const summaryFile = `${r.evidencePath}/test-summary.json`;
  const text = show(r.dir, r.head, summaryFile);
  if (text === null) return fail(`there is no tested build: ${summaryFile} is not in the candidate (shipyard record writes it)`);
  let source;
  try {
    source = JSON.parse(text).build.source;
  } catch {
    return fail(`${summaryFile} is not a test summary with build.source`);
  }
  if (!/^[0-9a-f]{40}$/.test(String(source)) || commitOf(r.dir, source) !== source) return fail(`the tested build's source ${oneLine(source, 40)} is not a commit of this repo`);
  if (!isAncestor(r.dir, source, r.head)) return fail(`the tested build's source ${source.slice(0, 7)} is not in the candidate's history`);
  const allowed = [`releases/${r.tag}`, r.evidencePath];
  // This version's own CHANGELOG section may be reworded after the build; the rest of the file may not.
  const sectionOnly = (f) => f === r.options.changelog
    && withoutSection(show(r.dir, source, f), r.version) === withoutSection(show(r.dir, r.head, f), r.version);
  const outside = changedFiles(r.dir, source, r.head).filter((f) => !allowed.some((a) => under(f, a)) && !sectionOnly(f));
  if (outside.length) {
    return fail(`${outside.length} file${outside.length === 1 ? '' : 's'} changed since the tested build's source ${source.slice(0, 7)}, outside the notes and evidence paths: ${outside.slice(0, 5).map((f) => oneLine(f, 100)).join(', ')}${outside.length > 5 ? ', ...' : ''}`);
  }
  return pass(`the build tested was made from ${source.slice(0, 7)}; since then only ${allowed.join(', ')} and the ${r.version} section of ${r.options.changelog} changed`);
}

function afterTheCut(r) {
  if (!r.cut) return fail('there is no cut commit to start from');
  const allowedFolder = `releases/${r.tag}`;
  const merged = new Map(r.changes.filter((c) => c.merged).map((c) => [c.number, c]));
  const problems = [];
  const commits = [{ sha: r.cut, subject: `chore(release): ${r.tag}`, pr: null, isCut: true }, ...r.afterCut];
  for (const c of commits) {
    const viaPr = c.pr !== null && c.pr !== undefined && merged.has(c.pr) && merged.get(c.pr).baseRef === r.pr.head.ref;
    if (viaPr) continue;
    const parent = commitOf(r.dir, `${c.sha}^1`);
    const files = parent ? changedFiles(r.dir, parent, c.sha) : [];
    const name = `${c.sha.slice(0, 7)}${c.isCut ? ' (the cut)' : ''}`;
    // A merge with no PR may bring in the release branch's own commits (taking in a moved base, as
    // rule 5 asks): a file it changes counts as the base's when it now reads as one merged-in side has it.
    const own = filesNotFromBase(r.dir, c.sha, r.base);
    const fromBase = own === null ? () => false : (f) => !own.includes(f);
    for (const f of files) {
      if (under(f, allowedFolder) || (r.evidencePath && under(f, r.evidencePath))) continue;
      if (fromBase(f)) continue;
      if (f === r.options.changelog) {
        const before = withoutSection(show(r.dir, parent, f), r.version);
        const after = withoutSection(show(r.dir, c.sha, f), r.version);
        if (before !== after) problems.push(`${name} came by no PR and changes ${f} outside the ${r.version} section`);
        continue;
      }
      problems.push(`${name} came by no PR into ${oneLine(r.pr.head.ref, 60)} and changes ${oneLine(f, 100)}`);
    }
  }
  return problems.length ? fail(...problems.slice(0, 10), ...(problems.length > 10 ? [`and ${problems.length - 10} more`] : []))
    : pass(`${commits.length} commit${commits.length === 1 ? '' : 's'} from the cut on; each came by a PR or touches only ${allowedFolder}/ and the ${r.version} section`);
}

function containsBase(r) {
  if (isAncestor(r.dir, r.base, r.head)) return pass(`contains ${r.pr.base.ref} at ${r.base.slice(0, 7)}`);
  return fail(`does not contain ${oneLine(r.pr.base.ref, 60)} at ${r.base.slice(0, 7)}: bring the release branch into the candidate`);
}

function olderLines(r) {
  if (!r.parsed) return fail('no version in the title to compare lines with');
  const [major, minor] = r.parsed.parts;
  const refs = git(r.dir, ['for-each-ref', '--format=%(refname)', 'refs/remotes/origin/', 'refs/heads/']).split('\n').filter(Boolean);
  const lines = new Map();
  for (const ref of refs) {
    const m = /\/main-(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(ref);
    if (m && Number(m[1]) === major && Number(m[2]) < minor) lines.set(`${m[1]}.${m[2]}`, [Number(m[1]), Number(m[2])]);
  }
  const tags = releaseTags(r.dir, r.options.tagPrefix);
  const problems = [];
  const checked = [];
  for (const [name, [ma, mi]] of [...lines].sort()) {
    const inThis = tags.filter((t) => t.parts[0] === ma && t.parts[1] === mi);
    if (!inThis.length) continue;
    const newest = inThis[inThis.length - 1];
    checked.push(newest.tag);
    if (!isAncestor(r.dir, commitOf(r.dir, `refs/tags/${newest.tag}`), r.head)) problems.push(`does not contain ${newest.tag}, the newest release of main-${name}`);
  }
  if (problems.length) return fail(...problems);
  return pass(checked.length ? `contains ${checked.join(', ')}` : `no older supported line of ${major}.x has a release`);
}

function ownDependencies(r) {
  const owner = r.repo.split('/')[0];
  let prefixes = [`github.com/${owner}/`, `@${owner}/`];
  if (r.config.ownDependencies !== undefined) {
    if (!Array.isArray(r.config.ownDependencies) || r.config.ownDependencies.some((p) => typeof p !== 'string' || !p.trim())) {
      return fail(`${RELEASE_JSON}: ownDependencies must be a list of module or package prefixes`);
    }
    prefixes = r.config.ownDependencies;
  }
  const isOwn = (name) => prefixes.some((p) => String(name).toLowerCase().startsWith(p.toLowerCase()));
  const files = git(r.dir, ['ls-tree', '-r', '--name-only', '-z', r.head]).split('\0').filter(Boolean)
    .filter((f) => /(^|\/)(go\.mod|package\.json)$/.test(f) && !/(^|\/)(node_modules|vendor|testdata)\//.test(f));
  const problems = [];
  let count = 0;
  for (const f of files) {
    const text = show(r.dir, r.head, f);
    const deps = f.endsWith('go.mod') ? goModDeps(text) : packageJsonDeps(text);
    if (deps === null) {
      problems.push(`${oneLine(f, 100)} is not valid JSON`);
      continue;
    }
    for (const d of deps) {
      if (!isOwn(d.name) && !(d.alsoNamed && isOwn(d.alsoNamed)) && !(d.replaceTarget && isOwn(d.replaceTarget))) continue;
      count++;
      if (!d.released) problems.push(`${oneLine(f, 100)}: ${oneLine(d.name, 100)} ${oneLine(d.version, 80)} is not a released version`);
    }
  }
  if (problems.length) return fail(...problems.slice(0, 10), ...(problems.length > 10 ? [`and ${problems.length - 10} more`] : []));
  return pass(count ? `${count} dependenc${count === 1 ? 'y' : 'ies'} on our own products, each a released version` : 'no dependency on our own products');
}

function siblings(r) {
  if (!r.siblings.length) return pass('not part of a pair, train or wave');
  const lines = r.siblings.map((s) => `${s.repo}#${s.number}: ${s.state}${s.state === 'open' ? `, release-check ${s.check}` : ''}`);
  // The rule is to show each sibling's state; one it cannot read is a state it cannot show.
  const unseen = r.siblings.filter((s) => s.state === 'cannot see');
  if (unseen.length) return fail(...lines, `cannot show the state of ${unseen.map((s) => `${s.repo}#${s.number}`).join(', ')}: the token cannot see it (set SHIPYARD_ORG_TOKEN)`);
  return pass(...lines);
}

function independentApproval(r) {
  const o = r.options;
  const fleet = new Set(o.fleetLogins.map((l) => l.toLowerCase()));
  const problems = [];
  // An approval counts only at `at`, the commit it must have seen: with none known, nothing counts.
  const independentOf = (reviews, drivers, at) => [...lastReviews(reviews).values()]
    .filter((x) => x.state === 'APPROVED' && !isFleet(x.user, fleet) && !drivers.has(x.login.toLowerCase()))
    .filter((x) => Boolean(at) && x.commit === at)
    // A review from someone with no standing in the repo (anyone may review a public repo's PR) is not an approval.
    .filter((x) => {
      const raw = reviews.filter((y) => y.user && y.user.login === x.login).pop();
      return !raw.author_association || TRUSTED.has(raw.author_association);
    });
  if (!r.cut) return fail('there is no cut commit, so the changes cannot be read');
  if (!r.from) return fail('there is no release tag to count the changes from');
  for (const u of r.unattributed) problems.push(`commit ${u.sha.slice(0, 7)} ${u.why}, so it has no approval`);
  // A change is approved at its own PR, of the code that merged, or on the release PR at its head by
  // a person who did not drive that change: the fix for a red rule 9 is a second approval of the
  // release, never a new review of an old PR.
  let ownCount = 0;
  let viaRelease = 0;
  for (const c of r.changes.filter((x) => x.merged)) {
    if (independentOf(c.reviews, c.drivers, c.head).length) ownCount++;
    else if (independentOf(r.releaseReviews, c.drivers, r.head).length) viaRelease++;
    else problems.push(`#${c.number} has no approval of its final commit${c.head ? ` ${c.head.slice(0, 7)}` : ''} from a person who did not drive it, and the release PR has none at ${r.head.slice(0, 7)} from such a person either`);
  }
  const release = independentOf(r.releaseReviews, r.releaseDrivers, r.head);
  if (!release.length) problems.push(`the release PR has no approval at ${r.head.slice(0, 7)} from a person who did not drive it`);
  if (problems.length) return fail(...problems.slice(0, 10), ...(problems.length > 10 ? [`and ${problems.length - 10} more`] : []));
  const n = ownCount + viaRelease;
  return pass(`${n} change${n === 1 ? '' : 's'} and the release PR each have an approval from a person who did not drive them (${ownCount} at their own PR, ${viaRelease} on the release PR; ${release.map((x) => x.login).join(', ')} approved the release)`);
}

function notesWhenNeeded(r) {
  const why = [];
  const level = approvedLevel(r).level;
  if (level === 'major') why.push('its level is major');
  if (r.trailers['Release-Breaking']) why.push(`the facts raised breaking signs (${oneLine(r.trailers['Release-Breaking'], 100)})`);
  for (const c of r.changes.filter((x) => x.merged)) {
    if (c.breakingTitle) why.push(`#${c.number} is marked breaking`);
    if (c.updateNeeds) why.push(`#${c.number} has an Update-Needs line`);
  }
  if (!why.length) return pass('no breaking flag, major level or Update-Needs line: notes are not required');
  if (!r.tag) return fail(...why.map((w) => `needs release notes: ${w}`), 'there is no release tag in the title to find them by');
  const notes = show(r.dir, r.head, `releases/${r.tag}/release-notes.md`);
  const hasItems = notes !== null && /^## \S/m.test(notes) && /^- \S/m.test(notes);
  if (!hasItems) return fail(...why.map((w) => `needs release notes: ${w}`), `releases/${r.tag}/release-notes.md has no section with an item`);
  return pass(`release notes are there, as needed: ${why.slice(0, 3).join('; ')}${why.length > 3 ? '; ...' : ''}`);
}

const RULES = {
  'automation-branch': automationBranch,
  version,
  'tested-build': testedBuild,
  'after-the-cut': afterTheCut,
  'contains-base': containsBase,
  'older-lines': olderLines,
  'own-dependencies': ownDependencies,
  siblings,
  'independent-approval': independentApproval,
  'notes-when-needed': notesWhenNeeded,
};

// Every rule, in order. A fork's PR is only rule 1: nothing else of it is read.
function evaluate(r) {
  return CHECKS.map(([id, title], i) => {
    if (r.fork && id !== 'automation-branch') return { n: i + 1, id, title, ok: false, detail: ['not run: the head is not a branch of this repo'] };
    return { n: i + 1, id, title, ...RULES[id](r) };
  });
}

module.exports = {
  CHECKS, gather, evaluate, lineOf, parseLevelComment, trailersOf, withoutSection, goModDeps, packageJsonDeps, readVersionFile,
};
