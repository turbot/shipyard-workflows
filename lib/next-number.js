'use strict';

// A cut uses up its number (docs/release-cut.md, "The cut", item 2). A version names one build, so a number a cut has
// made is never made again: a re-cut takes the next free patch. The cut asks `nextNumber` for its number; the release PR
// check (lib/release-pr.js) and the release check (lib/release-check.js) ask `checkNumber` whether a version is one the
// cut makes. Both read `numberState`, so the cut never makes a number the checks refuse.
//
// A number is used when a tag has it, when `release/<version>` exists on the remote, or when a PR of this repo from
// `release/<version>` titled `Release <tag>` exists, open, merged or closed. Nothing here deletes, moves or replaces
// anything to free one.

const { Refusal, git, bump, formatVersion } = require('./release-git');

// How many used numbers a cut walks past, and a check reads, before it stops: a bound on the calls one version makes.
const MAX_SKIPS = 20;

/**
 * Where the evidence is read. With `dir`, a checkout holding every branch and tag (fetch-depth 0): git's tags and branches,
 * the remote's as `refs/remotes/<remote>/release/<version>`. With none (the ask has no checkout of the repo): the API's. The
 * PRs always come from the API. Each answer is read once.
 */
function evidence({ dir = null, github, repo }) {
  const pulls = new Map();
  return {
    async tag(tag) {
      if (dir) return Boolean(git(dir, ['tag', '--list', tag]).trim());
      return (await github.getTagRef(repo, tag)) !== null;
    },
    async branch(branch) {
      if (dir) return Boolean(git(dir, ['for-each-ref', '--format=%(refname)', `refs/remotes/*/${branch}`, `refs/heads/${branch}`]).trim());
      return (await github.getRefSha(repo, `heads/${branch}`)) !== null;
    },
    async pulls(branch) {
      if (!pulls.has(branch)) pulls.set(branch, await github.listPullsByHead(repo, branch));
      return pulls.get(branch);
    },
  };
}

const stateOf = (p) => (p.merged_at ? 'merged' : p.state === 'open' ? 'open' : 'closed');

/**
 * What holds one number: `open`, an open PR from its branch (any title: a release branch is the repo's, whichever product
 * cut it); `waiting`, a candidate titled `Release <tag>` that merged and has no tag yet; `merged`, any such candidate that
 * merged; and `used`, why the number is used, or null. `except` is the PR a check reads: its own PR, and with it its own
 * branch, are the number it holds, not a sign that another cut used it.
 */
async function numberState({
  version, tagPrefix, look, except = null,
}) {
  const tag = `${tagPrefix}${version}`;
  const branch = `release/${version}`;
  const pulls = (await look.pulls(branch)).filter((p) => p && p.number !== except);
  const mine = pulls.filter((p) => p.title === `Release ${tag}`).sort((a, b) => b.number - a.number);
  const tagged = await look.tag(tag);
  const open = pulls.find((p) => p.state === 'open') || null;
  const merged = mine.find((p) => p.merged_at) || null;
  let used = null;
  if (tagged) used = `${tag} is a tag`;
  else if (except === null && await look.branch(branch)) used = `${branch} exists`;
  else if (mine.length) used = `#${mine[0].number} (Release ${tag}) is ${stateOf(mine[0])}`;
  return {
    version, tag, branch, tagged, open, merged, waiting: merged && !tagged ? merged : null, used,
  };
}

/**
 * The number a cut makes: `start`, then the next patch while that number is used. An open candidate refuses the cut, and so
 * does one that merged and waits for its tag (a light cut, whose count may pass such a release, gives `waitingIsUsed`).
 * With `fixed` (a first release, whose number the repo sets) a used number is refused, never passed.
 *
 * @returns {{ version: string, parts: number[], skipped: { version: string, why: string }[] }}
 */
async function nextNumber({
  start, tagPrefix, look, waitingIsUsed = false, fixed = false,
}) {
  const skipped = [];
  let parts = start;
  for (;;) {
    const version = formatVersion(parts);
    const s = await numberState({ version, tagPrefix, look });
    if (s.open) throw new Refusal(`${version} is taken: the candidate #${s.open.number} (${s.branch}) is open. Close it, or finish it, before cutting again`);
    if (s.waiting && !waitingIsUsed) throw new Refusal(`${version} is taken: the candidate #${s.waiting.number} (${s.branch}) merged and waits for its tag ${s.tag}`);
    const why = s.used || (s.waiting ? `#${s.waiting.number} (Release ${s.tag}) merged and waits for its tag` : null);
    if (!why) return { version, parts, skipped };
    if (fixed) throw new Refusal(`${version} is used (${why}), and a cut never makes a used number again: a first release's number is set by firstRelease in .github/release.json, so set the next free one there`);
    skipped.push({ version, why });
    if (skipped.length >= MAX_SKIPS) throw new Refusal(`${skipped.length} numbers from ${skipped[0].version} on are used: a cut walks past at most ${MAX_SKIPS - 1}, so look at what holds them`);
    parts = [parts[0], parts[1], parts[2] + 1];
  }
}

/**
 * Whether `parts` is the number a cut makes from `from` at `level`: `bump(from, level)` with its patch raised by k >= 0,
 * where each of the k numbers below it is used, and the number itself is used by nothing but this candidate (`except`, its
 * PR number). A merged candidate for the same tag is the first PR of a re-ship (docs/release-cut.md, "A re-ship"), which
 * finishes that version again: it does not count against it.
 *
 * @returns {{ problem: string|null, kind: 'level'|'used'|'unused'|null, expected: string, skipped: { version, why }[] }}
 */
async function checkNumber({
  from, fromName, level, parts, tagPrefix, look, except,
}) {
  const base = bump(from, level);
  const expected = formatVersion(base);
  const version = formatVersion(parts);
  const k = parts[2] - base[2];
  const no = (kind, problem) => ({
    problem, kind, expected, skipped: [],
  });
  if (parts[0] !== base[0] || parts[1] !== base[1] || k < 0) return no('level', `${fromName} plus ${level} is ${expected}, not ${version}`);
  if (k >= MAX_SKIPS) return no('unused', `${version} is ${k} patches past ${expected}, ${fromName} plus ${level}: a cut walks past at most ${MAX_SKIPS - 1} used numbers`);
  const own = await numberState({
    version, tagPrefix, look, except,
  });
  if (own.used && (own.tagged || !own.merged)) {
    return no('used', `${version} is used (${own.used}), and a cut never makes a used number again: the next cut takes the next free patch`);
  }
  const skipped = [];
  for (let j = 0; j < k; j++) {
    const below = formatVersion([base[0], base[1], base[2] + j]);
    const s = await numberState({ version: below, tagPrefix, look });
    if (!s.used) return no('unused', `${fromName} plus ${level} is ${expected}, and ${below} is not used (no tag, no release/${below}, no PR titled Release ${tagPrefix}${below}), so a cut would make ${below}, not ${version}`);
    skipped.push({ version: below, why: s.used });
  }
  return {
    problem: null, kind: null, expected, skipped,
  };
}

// The skipped numbers as a person reads them: `1.43.0 (release/1.43.0 exists)`.
const describeSkipped = (skipped) => skipped.map((s) => `${s.version} (${s.why})`).join(', ');

module.exports = {
  MAX_SKIPS, evidence, numberState, nextNumber, checkNumber, describeSkipped,
};
