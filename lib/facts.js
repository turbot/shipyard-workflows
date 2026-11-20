'use strict';

// The facts of a release's range: for each PR from the newest release tag to a commit, its
// `Changelog:` line, its issue and its review, the read-first flags, the breaking signs of
// the repo's detector, and which PRs only bump a dependency. Written to facts.json, which
// the prep run reads and `lint-prep`, `changelog` and `cut` check against.
//
// The one place the facts are made. A fact is read from the PR as GitHub holds it now, never
// from the PR body's text alone: the body is data and is never run.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { extractLines, visibleText } = require('./changelog-line');
const { prShipsNothing, internalTermsOf, notShippedOf } = require('./changelog-line-command');
const { GitHubError } = require('./github');
const {
  ReleaseError, parseTag, compareParts, resolveCommit, isAncestor, rangeCommits, prNumberOf, git, lineOf,
} = require('./release-git');
const { rangeStart } = require('./first-release');
const { hasContractAt, contractAtCommit, raisedNeeds, describeRaise, callerNeedFlagId } = require('./contract');
const { ensureNewestTag } = require('./newest-release-tag');
const { profileOf, couldItBreakOf } = require('./light');

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

// A PR body's `Changelog:` and `Update-Needs:` lines as the facts hold them: each the one line of its kind,
// trimmed, or null when the body has none, more than one, or an empty one.
function changelogLinesOf(body) {
  const lines = extractLines(body || '');
  const one = (list) => (list.length === 1 && list[0].trim() ? list[0].trim() : null);
  return { changelog: one(lines.changelog), updateNeeds: one(lines.updateNeeds) };
}

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
 * @param {(dir: string, tag: string) => void} [opts.fetchTagImpl] fetches a tag into the clone (a test's stand-in)
 * @param {string[]} [opts.fixes]   a patch: the merge commits, on `workBranch`, of the fix PRs the cut picks onto the
 *                                  production tag's branch. `to` is that branch's tip; the PRs are these fixes (and any
 *                                  PR the range holds), and the facts carry `patch`
 * @param {string} [opts.workBranch] with `fixes`: the work branch they merged into
 */
async function buildFacts({ dir, repo, to, from, tagPrefix = 'v', github, config, configPath = '.github/release.json', execFileImpl, fetchTagImpl, note = () => {}, fixes = [], workBranch = null }) {
  const patch = fixes.length > 0;
  if (patch && !workBranch) throw new ReleaseError('a patch names the work branch its fixes merged into (--work-branch)');
  const internalTerms = internalTermsOf(config, configPath);
  const notShipped = notShippedOf(config, configPath);
  const detector = detectorOf(config, configPath);
  // The product's display name, which heads the release PR's page: `product` in the repo's release.json.
  if (config && config.product !== undefined && (typeof config.product !== 'string' || !config.product.trim() || /[\r\n]/.test(config.product))) {
    throw new ReleaseError(`${configPath}: product must be the product's name, on one line`);
  }
  const product = config && typeof config.product === 'string' ? config.product.trim() : null;
  // Whom the release is for, which the page's What changes heading names, and whether the repo asks for a second
  // approver of each change: both beside `product`.
  if (config && config.audience !== undefined && !['visitors', 'customers', 'repos'].includes(config.audience)) {
    throw new ReleaseError(`${configPath}: audience must be visitors, customers or repos`);
  }
  if (config && config.askSecondApprover !== undefined && typeof config.askSecondApprover !== 'boolean') {
    throw new ReleaseError(`${configPath}: askSecondApprover must be true or false`);
  }
  const audience = config && config.audience !== undefined ? config.audience : null;
  const askSecondApprover = Boolean(config && config.askSecondApprover === true);
  // A light release (lib/light.js): the page lists the PRs and says one fixed line about what could break.
  const profile = profileOf(config, configPath);
  const couldItBreak = profile === 'light' ? couldItBreakOf(config, configPath) : null;

  let fromTag = from;
  let fromSha;
  let first = null;
  // The range starts at a release tag of the clone, so the clone must have GitHub's newest one, at
  // GitHub's commit, whichever way the start is named. Never a range that starts older than it.
  const checkClone = () => ensureNewestTag({ dir, repo, prefix: tagPrefix, github, ...(fetchTagImpl ? { fetchImpl: fetchTagImpl } : {}) });
  if (fromTag) {
    const named = parseTag(fromTag, tagPrefix);
    if (!named) throw new ReleaseError(`${fromTag} is not a release tag (${tagPrefix}X.Y.Z)`);
    const newest = await checkClone();
    if (newest && compareParts(named.parts, parseTag(newest, tagPrefix).parts) < 0) {
      throw new ReleaseError(`--from ${fromTag} starts the range before ${newest}, ${repo}'s newest release: start at ${newest}, or leave --from out`);
    }
    fromSha = resolveCommit(dir, `refs/tags/${fromTag}`);
  } else {
    await checkClone();
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

  if (patch && first) throw new ReleaseError('a patch is cut from the production tag, and this repo has no release tag yet');
  const commits = rangeCommits(dir, fromSha, toSha);
  // A patch's change is its fixes: the range from the production tag to the tip of its branch often holds nothing.
  if (!commits.length && !patch) throw new ReleaseError(`nothing to release: ${fromTag} is already ${toSha.slice(0, 7)} or ahead of it`);

  // lib/reship.js reads this file's reviewOf, so it is loaded here, not at the top.
  const { pickedOrigins, pickedTip } = require('./reship');
  // A commit the newest release already shipped as a pick (a patch's or a re-ship's fix) is in the range again once the
  // release merges back: it shipped, so it is left out, and named in `shippedAsPicks`.
  const shippedPicks = pickedOrigins(dir, fromSha);
  const shippedAsPicks = [];
  const numbers = new Set();
  const unattributed = [];
  const asCommit = (c, why) => ({ sha: c.sha, subject: oneLine(c.subject).slice(0, 200), why });
  const candidates = [];
  for (const c of commits) {
    const n = prNumberOf(c.subject);
    if (shippedPicks.has(c.sha)) {
      shippedAsPicks.push({ commit: c.sha, pr: n, pick: shippedPicks.get(c.sha) });
      continue;
    }
    if (n === null) {
      // A merge commit that carries no PR (a back-merge of main) holds no change of its own.
      if (c.parents <= 1) unattributed.push(asCommit(c, 'no pull request number in its subject'));
    } else {
      candidates.push({ n, commit: c });
      numbers.add(n);
    }
  }

  // A patch's fixes: each the merge commit of a merged PR of this repo, not already in the tip it is picked onto. The
  // cut checks the rest (on the work branch, applies cleanly, no workflow file) before it writes anything.
  const fixList = [];
  for (const sha of fixes) {
    if (git(dir, ['cat-file', '-e', `${sha}^{commit}`], { allowFail: true }) === null) throw new ReleaseError(`the fix ${sha} is not a commit in this checkout: fixes are commits of ${workBranch}`);
    if (isAncestor(dir, sha, toSha)) throw new ReleaseError(`the fix ${sha} is already in ${toSha.slice(0, 7)}: there is nothing to pick`);
    if (shippedPicks.has(sha)) throw new ReleaseError(`the fix ${sha} already shipped in ${fromTag}, picked as ${shippedPicks.get(sha).slice(0, 7)}: there is nothing to pick`);
    const pulls = (await github.listPullsOfCommit(repo, sha)).filter((p) => p && p.merged_at && p.merge_commit_sha === sha);
    if (pulls.length !== 1) throw new ReleaseError(`the fix ${sha} is not the merge commit of a merged pull request of ${repo}: a fix is a commit that came by a reviewed PR`);
    const n = pulls[0].number;
    if (isMergeBack(pulls[0], repo)) throw new ReleaseError(`the fix ${sha} is #${n}, a merge-back of a release branch, which holds no fix`);
    if (numbers.has(n) || fixList.some((f) => f.pr === n)) throw new ReleaseError(`the fix ${sha} is #${n}, which the patch already holds`);
    fixList.push({ commit: sha, pr: n });
    candidates.push({ n, commit: { sha } });
    numbers.add(n);
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
    const files = await prShipsNothing(github, repo, n, notShipped);
    const { changelog, updateNeeds } = changelogLinesOf(pr.body);
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

  // What a patch ships is the tip with its fixes picked on, in order: the breaking signs and what callers must give are
  // read there, so a fix is judged by them as it would be in a release of the work branch. A fix that does not apply
  // stops the facts, naming it.
  const shipSha = fixList.length ? pickedTip(dir, toSha, fixList.map((f) => f.commit)) : toSha;
  let breaking = [];
  if (detector && shipSha !== toSha) {
    // The detector runs in a checkout of what ships: a patch's is a scratch worktree at the picked tip, removed after.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-patch-'));
    try {
      git(dir, ['worktree', 'add', '--detach', '--quiet', tmp, shipSha]);
      breaking = await runDetector(detector, tmp, { from: fromTag, to: shipSha, execFileImpl });
    } finally {
      git(dir, ['worktree', 'remove', '--force', tmp], { allowFail: true });
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  } else if (detector) {
    if (git(dir, ['rev-parse', 'HEAD']).trim() !== toSha) {
      throw new ReleaseError(`the breaking-change detector runs in the checkout of the commit being released: check out ${toSha.slice(0, 7)} first`);
    }
    breaking = await runDetector(detector, dir, { from: fromTag, to: toSha, execFileImpl });
  }

  // A repo that publishes workflows with a contract (`workflows/contract.json`) lists what a caller must give now
  // and did not at the range's start. Never for a first release: its range starts at an old tag, not a published one.
  const callerNeeds = !first && hasContractAt(dir, shipSha) ? raisedNeeds(contractAtCommit(dir, fromSha), contractAtCommit(dir, shipSha)) : null;

  const flags = [];
  const flag = (id, why) => flags.push({ id, why });
  for (const s of breaking) flag(`breaking-${s.id}`, `The repo's detector reports a breaking sign: ${s.why}`);
  for (const p of prs) {
    if (p.dependencyOnly) flag(`dependency-bump-${p.number}`, `PR #${p.number} only bumps a dependency`);
    if (p.updateNeeds) flag(`update-needs-${p.number}`, `PR #${p.number} says people must act when they update`);
    if (!p.changelog && !p.shipsNothing) flag(`no-changelog-line-${p.number}`, `PR #${p.number} ships something and has no single valid Changelog line: it needs one on the PR and the facts made again, and answering this flag does not clear it`);
    if (p.review.state === 'changes-requested') flag(`changes-requested-${p.number}`, `PR #${p.number} merged with a review still asking for changes`);
  }
  // A raised caller need is answerable: below a major the prep must name every caller checked and say each grants it.
  for (const r of callerNeeds || []) {
    flag(callerNeedFlagId(r), `A published workflow now asks more of its callers (${describeRaise(r)}). Below a major, answer it with every caller checked (an org code search for the workflow at the floating tag) and that each grants it; a major needs no answer`);
  }
  for (const u of unattributed) flag(`commit-without-pr-${u.sha.slice(0, 7)}`, `Commit ${u.sha.slice(0, 7)} is in the range and ${u.why}`);

  return {
    format: FORMAT,
    repo: { name: repo, private: visibility === 'private' },
    ...(product ? { product } : {}),
    ...(audience ? { audience } : {}),
    ...(askSecondApprover ? { askSecondApprover } : {}),
    ...(profile ? { profile } : {}),
    ...(couldItBreak ? { couldItBreak } : {}),
    tagPrefix,
    range: { from: fromTag, fromCommit: fromSha, to: toSha },
    // A first release: the range starts at the repo's `firstRelease`, and the version is set by it.
    ...(first ? { firstRelease: { from: first.from, version: first.version } } : {}),
    ...(patch ? { patch: { workBranch, fixes: fixList } } : {}),
    prs,
    mergeBacks,
    ...(shippedAsPicks.length ? { shippedAsPicks } : {}),
    unattributed,
    breaking,
    ...(callerNeeds ? { callerNeeds } : {}),
    flags,
    internalTerms,
  };
}

module.exports = {
  FORMAT, buildFacts, issuesOf, reviewOf, isDependencyOnly, isMergeBack, changelogLinesOf,
};
