'use strict';

// The facts of a release's range: for each PR from the newest release tag to a commit, its
// `Changelog:` line, its issue and its review, the read-first flags, the breaking signs of
// the repo's detector, and which PRs only bump a dependency. Written to facts.json, which
// the prep run reads and `lint-prep`, `changelog` and `cut` check against.
//
// The one place the facts are made. A fact is read from the PR as GitHub holds it now, never
// from the PR body's text alone: the body is data and is never run.

const { execFile } = require('node:child_process');
const { extractLines, visibleText } = require('./changelog-line');
const { prShipsNothing, internalTermsOf, notShippedOf } = require('./changelog-line-command');
const { GitHubError } = require('./github');
const {
  ReleaseError, parseTag, resolveCommit, isAncestor, rangeCommits, prNumberOf, git, lineOf,
} = require('./release-git');
const { rangeStart } = require('./first-release');

const FORMAT = 1;
const DETECTOR_TIMEOUT_MS = 120000;
const DETECTOR_MAX_BYTES = 1024 * 1024;
const SIGN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const BOT_DEPENDENCY_AUTHORS = new Set(['dependabot[bot]', 'renovate[bot]']);
const BUMP_TITLE = /^(?:[a-z]+(?:\([^)]*\))?!?:\s*)?bump\s+\S.*\s+from\s+\S+\s+to\s+\S+/i;

// `Fixes #12`, `Closes #12`, `Resolves #12`, `Refs #12`: the same repo's issues the PR names.
function issuesOf(body) {
  const found = new Set();
  const text = visibleText(body);
  for (const m of text.matchAll(/\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|refs?)\b:?\s+#(\d+)\b/gi)) found.add(Number(m[1]));
  return [...found].sort((a, b) => a - b);
}

// Each reviewer's last say counts: a later approval clears an earlier request for changes,
// and a dismissed review counts for nothing. Comments and pending reviews decide nothing.
function reviewOf(reviews) {
  const last = new Map();
  for (const r of reviews) {
    const login = r && r.user && r.user.login;
    if (!login) continue;
    const state = String(r.state || '').toUpperCase();
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') last.set(login, state);
    else if (state === 'DISMISSED') last.delete(login);
  }
  const approvedBy = [...last].filter(([, s]) => s === 'APPROVED').map(([l]) => l).sort();
  const changesRequestedBy = [...last].filter(([, s]) => s === 'CHANGES_REQUESTED').map(([l]) => l).sort();
  const state = changesRequestedBy.length ? 'changes-requested' : approvedBy.length ? 'approved' : 'none';
  return { state, approvedBy, changesRequestedBy };
}

function isDependencyOnly(pr) {
  const login = String((pr.user && pr.user.login) || '').toLowerCase();
  return BOT_DEPENDENCY_AUTHORS.has(login) || BUMP_TITLE.test(String(pr.title || '').trim());
}

// A merge-back brings a release branch into the work branch it was cut from: its head is a
// branch of this repo that releases (`main`, `main-<x.y>`) and its base is not one. It carries the
// release's own files back and no change of its own, so the facts name it and never count it.
// A fork's own `main` is no release branch of this repo: that PR is a change like any other.
function isMergeBack(pr, repo) {
  const head = pr.head || {};
  const headRepo = head.repo && String(head.repo.full_name).toLowerCase();
  return headRepo === repo.toLowerCase() && lineOf(head.ref) !== null && Boolean(pr.base && pr.base.ref) && lineOf(pr.base.ref) === null;
}

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();

// The detector is a command the repo names in `.github/release.json`, as an argument list
// (no shell), run in the checkout of the commit being released. It prints a JSON list of
// `{ "id", "why" }`, one for each breaking sign. It gets no token and no secret.
function detectorOf(config, path) {
  const d = config.breaking && config.breaking.detector;
  if (d === undefined) return null;
  if (!Array.isArray(d) || !d.length || d.some((a) => typeof a !== 'string' || !a)) {
    throw new ReleaseError(`${path}: breaking.detector must be a command as a list of strings, such as ["node", "scripts/breaking.js"]`);
  }
  return d;
}

function runDetector(argv, dir, { from, to, execFileImpl = execFile }) {
  return new Promise((resolve, reject) => {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, SHIPYARD_FROM: from, SHIPYARD_TO: to };
    execFileImpl(argv[0], argv.slice(1), { cwd: dir, env, timeout: DETECTOR_TIMEOUT_MS, maxBuffer: DETECTOR_MAX_BYTES, encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        const why = error.killed ? 'timed out' : error.code === 'ENOENT' ? 'was not found' : `exited with ${error.code}`;
        return reject(new ReleaseError(`the breaking-change detector ${why}`));
      }
      let signs;
      try {
        signs = JSON.parse(stdout);
      } catch {
        return reject(new ReleaseError('the breaking-change detector did not print valid JSON'));
      }
      if (!Array.isArray(signs)) return reject(new ReleaseError('the breaking-change detector must print a JSON list'));
      const seen = new Set();
      const out = [];
      for (const [i, s] of signs.entries()) {
        if (!s || typeof s !== 'object' || typeof s.id !== 'string' || !SIGN_ID.test(s.id) || typeof s.why !== 'string' || !s.why.trim()) {
          return reject(new ReleaseError(`the breaking-change detector's entry ${i + 1} must be { "id": "<kebab-case>", "why": "<text>" }`));
        }
        if (seen.has(s.id)) return reject(new ReleaseError(`the breaking-change detector names "${s.id}" twice`));
        seen.add(s.id);
        out.push({ id: s.id, why: oneLine(s.why).slice(0, 500) });
      }
      resolve(out);
    });
  });
}

/**
 * @param {object} opts
 * @param {string} opts.dir         the product repo's checkout
 * @param {string} opts.repo        `<owner>/<name>`
 * @param {string} opts.to          the commit to release (anything git names)
 * @param {string} [opts.from]      the release tag to start at; when left out, the newest release tag,
 *                                  or the repo's `firstRelease` while it has none (lib/first-release.js)
 * @param {string} [opts.tagPrefix] `v` unless the repo's tags start otherwise
 * @param {object} opts.github      lib/github.js client
 * @param {object} opts.config      the repo's `.github/release.json` at `to`
 * @param {string} [opts.configPath]
 * @param {(line: string) => void} [opts.note] told one line when the repo's `firstRelease` is ignored
 */
async function buildFacts({ dir, repo, to, from, tagPrefix = 'v', github, config, configPath = '.github/release.json', execFileImpl, note = () => {} }) {
  const internalTerms = internalTermsOf(config, configPath);
  const notShipped = notShippedOf(config, configPath);
  const detector = detectorOf(config, configPath);

  let fromTag = from;
  let fromSha;
  let first = null;
  if (fromTag) {
    if (!parseTag(fromTag, tagPrefix)) throw new ReleaseError(`${fromTag} is not a release tag (${tagPrefix}X.Y.Z)`);
    fromSha = resolveCommit(dir, `refs/tags/${fromTag}`);
  } else {
    const start = rangeStart(dir, tagPrefix, config, configPath);
    if (start.ignored) note(start.ignored);
    ({ from: fromTag, commit: fromSha, first } = start);
  }
  const toSha = resolveCommit(dir, to);
  if (!isAncestor(dir, fromSha, toSha)) {
    throw new ReleaseError(`${fromTag} is not in the history of ${toSha.slice(0, 7)}: the range has no start`);
  }

  const visibility = await github.repoVisibility(...repo.split('/'));
  if (visibility === 'not-found') throw new ReleaseError(`cannot see ${repo} with this token`);

  const commits = rangeCommits(dir, fromSha, toSha);
  if (!commits.length) throw new ReleaseError(`nothing to release: ${fromTag} is already ${toSha.slice(0, 7)} or ahead of it`);

  const numbers = new Set();
  const unattributed = [];
  const asCommit = (c, why) => ({ sha: c.sha, subject: oneLine(c.subject).slice(0, 200), why });
  const candidates = [];
  for (const c of commits) {
    const n = prNumberOf(c.subject);
    if (n === null) {
      // A merge commit that carries no PR (a back-merge of main) holds no change of its own.
      if (c.parents <= 1) unattributed.push(asCommit(c, 'no pull request number in its subject'));
    } else {
      candidates.push({ n, commit: c });
      numbers.add(n);
    }
  }

  const prs = [];
  const mergeBacks = [];
  for (const n of [...numbers].sort((a, b) => a - b)) {
    let pr;
    try {
      pr = await github.getPull(repo, n);
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 404) throw e;
      pr = null;
    }
    if (!pr || !pr.merged_at) {
      for (const c of candidates.filter((x) => x.n === n)) unattributed.push(asCommit(c.commit, `#${n} is not a merged pull request`));
      continue;
    }
    if (isMergeBack(pr, repo)) {
      mergeBacks.push({
        number: n,
        title: oneLine(pr.title),
        url: `https://github.com/${repo}/pull/${n}`,
        mergedAt: pr.merged_at,
        commit: candidates.find((x) => x.n === n).commit.sha,
        from: pr.head.ref,
        into: pr.base.ref,
      });
      continue;
    }
    const files = notShipped.length ? await prShipsNothing(github, repo, n, notShipped) : { shipsNothing: false };
    const lines = extractLines(pr.body || '');
    const changelog = lines.changelog.length === 1 && lines.changelog[0].trim() ? lines.changelog[0].trim() : null;
    const updateNeeds = lines.updateNeeds.length === 1 && lines.updateNeeds[0].trim() ? lines.updateNeeds[0].trim() : null;
    prs.push({
      number: n,
      title: oneLine(pr.title),
      url: `https://github.com/${repo}/pull/${n}`,
      author: (pr.user && pr.user.login) || null,
      mergedAt: pr.merged_at,
      commit: candidates.find((x) => x.n === n).commit.sha,
      changelog,
      updateNeeds,
      issues: issuesOf(pr.body),
      review: reviewOf(await github.listPullReviews(repo, n)),
      shipsNothing: Boolean(files.shipsNothing),
      dependencyOnly: isDependencyOnly(pr),
    });
  }

  let breaking = [];
  if (detector) {
    if (git(dir, ['rev-parse', 'HEAD']).trim() !== toSha) {
      throw new ReleaseError(`the breaking-change detector runs in the checkout of the commit being released: check out ${toSha.slice(0, 7)} first`);
    }
    breaking = await runDetector(detector, dir, { from: fromTag, to: toSha, execFileImpl });
  }

  const flags = [];
  const flag = (id, why) => flags.push({ id, why });
  for (const s of breaking) flag(`breaking-${s.id}`, `The repo's detector reports a breaking sign: ${s.why}`);
  for (const p of prs) {
    if (p.dependencyOnly) flag(`dependency-bump-${p.number}`, `PR #${p.number} only bumps a dependency`);
    if (p.updateNeeds) flag(`update-needs-${p.number}`, `PR #${p.number} says people must act when they update`);
    if (!p.changelog && !p.shipsNothing) flag(`no-changelog-line-${p.number}`, `PR #${p.number} ships something and has no single valid Changelog line`);
    if (p.review.state === 'changes-requested') flag(`changes-requested-${p.number}`, `PR #${p.number} merged with a review still asking for changes`);
  }
  for (const u of unattributed) flag(`commit-without-pr-${u.sha.slice(0, 7)}`, `Commit ${u.sha.slice(0, 7)} is in the range and ${u.why}`);

  return {
    format: FORMAT,
    repo: { name: repo, private: visibility === 'private' },
    tagPrefix,
    range: { from: fromTag, fromCommit: fromSha, to: toSha },
    // A first release: the range starts at the repo's `firstRelease`, and the version is set by it.
    ...(first ? { firstRelease: { from: first.from, version: first.version } } : {}),
    prs,
    mergeBacks,
    unattributed,
    breaking,
    flags,
    internalTerms,
  };
}

module.exports = { FORMAT, buildFacts, issuesOf, reviewOf, isDependencyOnly };
