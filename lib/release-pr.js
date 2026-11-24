'use strict';

// Checks that a PR is the release PR `shipyard cut` opened for the tag the facts and the prep
// file make, and reads the control record `shipyard record` folded into its body.

const { Refusal, parseTag } = require('./release-git');
const { evidence, checkNumber } = require('./next-number');
const { tagOf, unclean, START, END } = require('./record');
const { TOP_START, TOP_END } = require('./changelog');
const { isLight, lightProblem } = require('./light');
const { gatedCount } = require('./release-gated');

// Returns the PR and its tag, or throws a Refusal. `fromTag` is `checkRange(facts)`'s answer. A caller
// that has read the PR already passes it as `pr`, so the check does not read it again.
async function checkReleasePr({ github, repo, prNumber, facts, prep, fromTag, pr: given }) {
  const pr = given || await github.getPull(repo, prNumber);
  const tag = tagOf(pr.body);
  if (!tag || !parseTag(tag, facts.tagPrefix)) throw new Refusal(`#${prNumber} is not a release PR \`shipyard cut\` opened: its body names no release tag`);
  if (isLight(facts)) {
    // A light release's number is the day's (lib/light.js): the cut has no level to count from, and the date is not kept, so the
    // tag is checked for the shape and the order a light version has after the release the facts start at.
    const problem = lightProblem({ parts: parseTag(tag, facts.tagPrefix).parts, previous: fromTag.first ? null : fromTag.parts });
    if (problem) throw new Refusal(`#${prNumber} is the PR for ${tag}, which is not the next light release after ${facts.range.from}: ${problem}`);
  } else if (fromTag.first) {
    // A first release's number is the one the facts carry from the repo's firstRelease, not a level's.
    const expected = `${facts.tagPrefix}${fromTag.first.version}`;
    if (tag !== expected) throw new Refusal(`#${prNumber} is the PR for ${tag}, but the facts and the prep file make ${expected}: make them again`);
  } else {
    // The number the cut makes (lib/next-number.js): the newest tag plus the level, then the next patch while that one is
    // used. The tags, branches and PRs are read from the API: the ask has no checkout of the repo.
    const n = await checkNumber({
      from: fromTag.parts,
      fromName: fromTag.tag,
      level: prep.level.bump,
      parts: parseTag(tag, facts.tagPrefix).parts,
      tagPrefix: facts.tagPrefix,
      look: evidence({ github, repo }),
      except: prNumber,
    });
    if (n.kind === 'level') throw new Refusal(`#${prNumber} is the PR for ${tag}, but the facts and the prep file make ${facts.tagPrefix}${n.expected}: make them again`);
    if (n.problem) throw new Refusal(`#${prNumber} is the PR for ${tag}, but ${n.problem}`);
  }
  if (pr.state !== 'open') throw new Refusal(`#${prNumber} is ${pr.state}: only an open candidate is recorded or asked about`);
  if (!pr.head || pr.head.ref !== `release/${tag.slice(facts.tagPrefix.length)}` || !pr.head.repo || String(pr.head.repo.full_name).toLowerCase() !== repo.toLowerCase()) {
    throw new Refusal(`#${prNumber} does not come from release/${tag.slice(facts.tagPrefix.length)} of ${repo}`);
  }
  return { pr, tag };
}

// What the body says: its recommendation (the decision in the top row of the page's decision table), the commit the
// control record was read for (seven characters), whether evidence was kept (`evidence`: a record of a release
// before the record stopped committing it links the folder) and whether the record read the release run's results
// (`tested`: it holds the build marker `<!-- shipyard:build sha256:... -->`). `null` when the body holds no complete record.
function readRecord(body) {
  const text = String(body || '').replace(/\r\n?/g, '\n');
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  if (s === -1 || e === -1 || e < s || text.indexOf(START) !== text.lastIndexOf(START) || text.indexOf(END) !== text.lastIndexOf(END)) return null;
  const block = text.slice(s, e);
  // The recommendation is the decision `shipyard record` writes in the first row of the decision table, above the record
  // (`decisionOf` in lib/record.js): `No: do not approve` is HOLD, and every other decision (yes, not yet because the
  // checks still run, approve again, approved) is SHIP.
  const a = text.indexOf(TOP_START);
  const b = text.indexOf(TOP_END);
  const top = a !== -1 && b > a && b < s && text.indexOf(TOP_START, a + 1) === -1 ? text.slice(a + TOP_START.length, b) : '';
  const decision = /^\| Ready to approve\? \| (?:(\u274c No: do not approve)|\u2705 Yes|\u23f3 Not yet: checks still running|\u{1f501} Approve again: [^\n]*?|\u2705 Approved: ready to merge) \|$/mu.exec(top);
  const recommendation = decision ? (decision[1] ? 'HOLD' : 'SHIP') : null;
  const head = /^Read from GitHub[^\n]*?, for commit `([0-9a-f]{7,40})`\./m.exec(block);
  if (!recommendation || !head) return null;
  // The Checks row of the same table, as the page words it: `✅ 7 of 7 passed, on the build that goes live` is a count the
  // ask can repeat. With a check skipped the page says `✅ 37 of 38 passed, on the build that goes live. Billing proof skipped:
  // no billing code changed` (the reason only when the check gave one, and only with one skipped): the page accepts such a skip,
  // so `skipped` is how many and `skipReason` the page's own words. Any other answer (a check still running or not passed, a
  // short count the page does not explain as skips) is `open`, and a body with no row is `null`.
  const row = /^\| Checks \| ([^\n]*) \|$/m.exec(top);
  const count = row ? /^\u2705 (\d+) of (\d+) passed, on the build that goes live(?:\. (.+))?$/.exec(row[1]) : null;
  let checks = !row ? null : { state: 'open' };
  if (count) {
    const passed = Number(count[1]);
    const total = Number(count[2]);
    const skip = count[3] === undefined ? null : /^.+? skipped(?:: (.+))?$/.exec(count[3]);
    if (passed === total) checks = { state: 'pass', passed, total };
    else if (passed < total && passed > 0 && skip) checks = { state: 'pass', passed, total, skipped: total - passed, ...(total - passed === 1 && skip[1] ? { skipReason: unclean(skip[1]) } : {}) };
  }
  return {
    gated: gatedCount(text), recommendation, head: head[1], evidence: /\[evidence folder\]\(/.test(block), tested: /^<!-- shipyard:build sha256:[0-9a-f]{64} -->$/m.test(block), checks,
  };
}

module.exports = { checkReleasePr, readRecord };
