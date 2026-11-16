'use strict';

// The CHANGELOG section, the release notes file and the release PR's body for one version.
// Pure: no network and no files. A PR's `Changelog:` line goes in as the facts hold it: this
// module joins lines, it never rewrites one.

const { GROUPS, lintPrep, checkFacts } = require('./lint-prep');
const { Refusal } = require('./release-git');
const { clean } = require('./clean');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const WARN = '⚠';

// The approver's part at the head of the body: what they approve, could it break something, what if
// it goes wrong, and who approved the changes. `shipyard cut` writes it from the facts and the prep
// file, and `shipyard record` writes it again with what it found (the tests, the approvals, a HOLD).
const TOP_START = '<!-- shipyard:top:start -->';
const TOP_END = '<!-- shipyard:top:end -->';
// The table of where the rest is kept, in the folded proof: the cut writes a placeholder, the record the links.
const WHERE_START = '<!-- shipyard:where:start -->';
const WHERE_END = '<!-- shipyard:where:end -->';
// The control record, in the folded proof: the cut writes a placeholder, the record replaces it.
const RECORD_START = '<!-- shipyard:record:start -->';
const RECORD_END = '<!-- shipyard:record:end -->';

// The folds under the approver's part, in order.
const FOLDS = ['Release notes (published on merge)', 'Proof and audit trail: tests, checks, evidence', 'For the release manager'];

// Text from the prep file or the facts, as one line, so it stays in its table cell or its sentence.
const oneLine = (text) => String(text).trim().replace(/\s+/g, ' ');

// A table cell: one line, with the bar that would end it written out.
const cell = (text) => oneLine(text).replace(/\|/g, '\\|');

// A table cell for a sentence: the one full stop at its end is left off, as a cell has no sentence after it.
const sentenceCell = (text) => cell(text).replace(/(?<!\.)\.$/, '');

// A phrase with the one full stop at its end left off, and a sentence that ends in one.
const phrase = (text) => oneLine(text).replace(/(?<!\.)\.$/, '');
const sentence = (text) => {
  const t = oneLine(text);
  return /[.!?)]$/.test(t) ? t : `${t}.`;
};

const andList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

// The groups a user can see, in the CHANGELOG's order. `Internal` is the one they cannot.
const USER_KINDS = GROUPS.filter((g) => g !== 'Internal');
const groupList = (prep, group) => [...((prep.groups && prep.groups[group]) || [])];
const userPrs = (prep) => USER_KINDS.flatMap((g) => groupList(prep, g)).sort((a, b) => a - b);
const kindOf = (prep, n) => USER_KINDS.concat('Internal').find((g) => groupList(prep, g).includes(n));

// Each group in the approver's words: one, many, and the label a change is shown under.
const KIND_WORDS = {
  Added: ['new feature', 'new features', 'New'],
  Changed: ['change', 'changes', 'Change'],
  Fixed: ['fix', 'fixes', 'Fix'],
  Removed: ['removal', 'removals', 'Removal'],
  Security: ['security fix', 'security fixes', 'Security fix'],
};

// "1 fix", "2 new features and 1 fix": the PRs a user can see, counted by group.
function whatShips(prep) {
  const parts = USER_KINDS.map((g) => [g, groupList(prep, g).length]).filter(([, n]) => n)
    .map(([g, n]) => `${n} ${KIND_WORDS[g][n === 1 ? 0 : 1]}`);
  return parts.length ? andList(parts) : 'internal changes only';
}

// The label of a change: the groups of the PRs it covers, in the approver's words.
const kindLabel = (prep, prs) => {
  const kinds = [...new Set(prs.map((n) => kindOf(prep, n)).filter((g) => KIND_WORDS[g]))];
  return kinds.length ? andList(kinds.map((g, i) => (i ? KIND_WORDS[g][2].toLowerCase() : KIND_WORDS[g][2]))) : 'Change';
};

// The PRs whose `Update-Needs:` line raised a read-first flag in the facts.
function flaggedPrs(facts) {
  const out = new Set();
  for (const f of facts.flags || []) {
    const m = /^update-needs-(\d+)$/.exec(String(f && f.id));
    if (m) out.add(Number(m[1]));
  }
  return out;
}

// How many items the notes' "Before you upgrade" section holds: the steps a person takes to update.
function upgradeSteps(prep) {
  const sections = (prep.notes && prep.notes.sections) || [];
  return sections.filter((s) => /^before you upgrade$/i.test(String(s.heading).trim())).reduce((n, s) => n + s.items.length, 0);
}

// The table of what proves each change: a row for each change in the report, with the PRs it covers, their kind and what
// proves it, then a row for each PR a user can see that no change covers, which says so. The prep run cannot hide one.
function renderChanges({ facts, prep }) {
  const flagged = flaggedPrs(facts);
  const covered = new Set();
  const rows = [];
  const kindCell = (prs) => {
    const kinds = [...new Set(prs.map((n) => kindOf(prep, n)).filter(Boolean))];
    return `${kinds.join(', ')}${prs.some((n) => flagged.has(n)) ? ` ${WARN}` : ''}`;
  };
  for (const c of prep.report.changes) {
    const prs = [...c.covers].sort((a, b) => a - b);
    prs.forEach((n) => covered.add(n));
    rows.push(`| ${prs.map((n) => `#${n}`).join(', ')} | ${kindCell(prs)} | ${sentenceCell(c.change)} | ${sentenceCell(c.proof)} |`);
  }
  for (const n of userPrs(prep).filter((x) => !covered.has(x))) {
    rows.push(`| #${n} | ${kindCell([n])} | (no change row in the report) | **No proof given** |`);
  }
  return rows.length ? ['| PR | Kind | Change | Proven by |', '|---|---|---|---|', ...rows].join('\n') : 'No change a user sees.';
}

function checkVersion(version) {
  if (!VERSION.test(version)) throw new Refusal(`the version must be X.Y.Z, not ${JSON.stringify(String(version))}`);
}

// The facts and the prep file must pass the same checks `lint-prep` makes before anything is
// built from them. Returns nothing; throws a Refusal naming each problem.
function assertPrepPasses(facts, prep) {
  checkFacts(facts);
  const problems = lintPrep(prep, facts);
  if (problems.length) {
    throw new Refusal(`the prep file is refused by lint-prep (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${problems.map((p) => `  ${p.at}: ${p.message} [${p.rule}]`).join('\n')}`);
  }
}

/**
 * The section for `version`: each group of the prep file in turn, each PR in it by number,
 * each with its own line. A PR that ships nothing is left out.
 *
 * @returns {{ text: string, included: number[], left: number[] }}
 */
function buildSection({ facts, prep, version, date }) {
  checkVersion(version);
  if (!DATE.test(date || '')) throw new Refusal(`the date must be YYYY-MM-DD, not ${JSON.stringify(String(date))}`);
  assertPrepPasses(facts, prep);

  const byNumber = new Map(facts.prs.map((p) => [p.number, p]));
  const included = [];
  const left = [];
  const blocks = [];
  for (const group of GROUPS) {
    const numbers = [...((prep.groups && prep.groups[group]) || [])].sort((a, b) => a - b);
    const items = [];
    for (const n of numbers) {
      const pr = byNumber.get(n);
      if (pr.shipsNothing === true) {
        left.push(n);
        continue;
      }
      // lintPrep, through assertPrepPasses, has refused a PR that ships with no valid line.
      let item = `- ${pr.changelog.trim()} (#${n})`;
      if (typeof pr.updateNeeds === 'string' && pr.updateNeeds.trim() && !/[\r\n]/.test(pr.updateNeeds)) {
        item += `\n  - Update needs: ${pr.updateNeeds.trim()}`;
      }
      items.push(item);
      included.push(n);
    }
    if (items.length) blocks.push(`### ${group}\n\n${items.join('\n')}`);
  }
  const body = blocks.length ? blocks.join('\n\n') : 'Nothing in this release changes what ships.';
  return { text: `## [${version}] - ${date}\n\n${body}\n`, included, left };
}

const headingFor = (version) => new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(?:\\s|$)`, 'm');

// Puts a section above the newest one already in the file. A file with this version's heading
// already in it is refused: a release is cut once, and a second run must not bury the first.
function insertSection(existing, section, version) {
  checkVersion(version);
  const file = String(existing || '').replace(/\r\n?/g, '\n');
  if (!file.trim()) return `# Changelog\n\n${section}`;
  if (headingFor(version).test(file)) throw new Refusal(`CHANGELOG.md already has a section for ${version}`);
  const m = /^## /m.exec(file);
  if (!m) return `${file.replace(/\s+$/, '')}\n\n${section}`;
  return `${file.slice(0, m.index)}${section}\n${file.slice(m.index)}`;
}

// The published notes, from `prep.notes`: title, summary, then each heading with its items.
function renderReleaseNotes(notes) {
  const parts = [`# ${notes.title.trim()}`, notes.summary.trim()];
  for (const s of notes.sections) {
    parts.push(`## ${s.heading.trim()}\n\n${s.items.map((i) => `- ${i.text.trim()}`).join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// The release notes file, quoted as it is: every line behind `> `.
const quote = (text) => text.replace(/\s+$/, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

// The release notes have something to publish when a section holds an item (as the release check reads them).
const hasNotes = (text) => /^## \S/m.test(text) && /^- \S/m.test(text);

// The product's name, from its repo: `example-org/shipyard` is Shipyard.
const productOf = (facts) => facts.repo.name.split('/')[1].replace(/^./, (c) => c.toUpperCase());
// A tag without its prefix: `v0.5.1` is 0.5.1.
const versionOf = (tag, prefix) => (prefix && String(tag).startsWith(prefix) ? String(tag).slice(prefix.length) : String(tag));

// A fold: a summary line a reader opens, and what is under it.
const fold = (summary, inner) => `<details>\n<summary><strong>${summary}</strong></summary>\n\n${inner}\n\n</details>`;

/**
 * The approver's part, in the order they ask: what am I approving, could this break something, what if
 * it goes wrong; then what else ships and who approved the changes. Each fact is said once; the rest of
 * the body folds below it.
 *
 * `status` is what `shipyard record` found, null before it runs (the cut):
 *   { recommendation: 'SHIP'|'HOLD', headlines: [<what failed, plain>], tests: { state: 'pass'|'waiting'|'fail', text }, approver: <line> }
 */
function renderTop({ facts, prep, tag, status = null }) {
  const { report } = prep;
  const first = facts.firstRelease || null;
  const product = productOf(facts);
  const name = `${product} ${versionOf(tag, facts.tagPrefix)}${first ? ' (first release)' : ''}`;
  const what = whatShips(prep);

  // 1. What am I approving: the decision in words, then the tests and the upgrade steps on one line.
  let decision;
  if (status && status.recommendation === 'HOLD') {
    const [one, ...more] = status.headlines;
    decision = `do not merge: ${phrase(one || 'a check did not pass')}${more.length ? ` (and ${more.length} more, in the proof below)` : ''}`;
  } else if (status && status.tests.state === 'pass') {
    decision = `approve to release ${what}`;
  } else {
    decision = `wait for the tests, then approve to release ${what}`;
  }
  const tests = !status ? 'Tests have not run yet.'
    : status.tests.state === 'pass' ? 'Tests pass.'
      : status.tests.state === 'waiting' ? 'Tests are still running.'
        : sentence(`Tests: ${status.tests.text}`);
  const steps = upgradeSteps(prep);
  const upgrade = steps
    ? `${WARN} Teams using ${product} have ${steps} step${steps === 1 ? '' : 's'} to take before they update: see "Before you upgrade" in the release notes below.`
    : `Nothing for teams using ${product} to change.`;

  // The changes, each with what a person had before and has after. A PR a user can see that no change covers is named, never hidden.
  const covered = new Set();
  const changes = report.changes.map((c) => {
    const prs = [...c.covers].sort((a, b) => a - b);
    prs.forEach((n) => covered.add(n));
    return `**${kindLabel(prep, prs)} (${prs.map((n) => `#${n}`).join(', ')}): ${phrase(c.change)}**\n- Before: ${sentence(c.before)}\n- After: ${sentence(c.after)}`;
  });
  for (const n of userPrs(prep).filter((x) => !covered.has(x))) {
    changes.push(`**${kindLabel(prep, [n])} (#${n})**: ${WARN} the report does not say what this changes.`);
  }

  // 2. Could this break something. 3. What if it goes wrong: the release to go back to, then each risk to users with what we do.
  const safety = `**Could this break something?** ${sentence(report.safety)}`;
  const back = first
    ? 'this is the first release, so there is no earlier one to go back to.'
    : `release ${versionOf(facts.range.from, facts.tagPrefix)} again.`;
  const risks = report.risks.map((r) => `- ${sentence(r.risk)} What we do: ${sentence(r.undo)}`);
  const wrong = `**If it goes wrong:** ${back}${risks.length ? `\n\n${risks.join('\n')}` : ''}`;

  // What users do not see, one plain line each from the prep file: never a PR's title.
  const internal = groupList(prep, 'Internal');
  const lined = new Set();
  const lines = (report.internal || []).map((l) => {
    const prs = [...l.covers].sort((a, b) => a - b);
    prs.forEach((n) => lined.add(n));
    return `${phrase(l.text)} (${prs.map((n) => `#${n}`).join(', ')})`;
  });
  for (const n of internal.filter((x) => !lined.has(x)).sort((a, b) => a - b)) lines.push(`#${n} (no line in the report)`);
  const also = lines.length ? `Also in this release (no effect on users): ${lines.join(', ')}.` : null;

  const approver = status ? status.approver : 'Who approved each change is checked when the tests run.';

  return [
    `## ${name} — ${decision}`,
    `${tests} ${upgrade}`,
    ...changes,
    safety,
    wrong,
    ...(also ? [also] : []),
    approver,
  ].join('\n\n');
}

/**
 * The release PR's body, as `shipyard cut` writes it: the approver's part, then three folds: the
 * release notes, the proof and audit trail (where the control record goes), and the notes for the
 * release manager. `shipyard record` rewrites the approver's part and fills in the proof.
 *
 * `releaseNotes` is the text of releases/<tag>/release-notes.md, quoted word for word. `base` is the
 * branch the PR merges into and `workBranch` the one the cut started from (null when not recorded).
 */
function renderPrBody({ tag, facts, prep, releaseNotes, base = 'main', workBranch = null }) {
  const { report, level } = prep;
  // A first release (lib/first-release.js): its number is set by the repo, and the level moves nothing.
  const first = facts.firstRelease || null;

  const notes = hasNotes(releaseNotes)
    ? `Approving says these may be published.\n\n${quote(releaseNotes)}`
    : 'No release notes: users see nothing in this release.';
  // A first release's line says its number is set by the repo; the prep run's level is still shown, as it moves nothing.
  const levelLine = first
    ? `**First release: ${oneLine(first.version)}**, set by firstRelease in .github/release.json, not by a level. The prep run's level was ${level.bump}: ${oneLine(level.reasons[0])}`
    : `**Level: ${level.bump}.** ${oneLine(level.reasons[0])}`;
  const untested = report.untested.length ? report.untested.map((u) => `- ${oneLine(u)}`).join('\n') : 'Nothing was named.';
  const proof = [
    oneLine(report.summary),
    levelLine,
    `### What proves each change\n\n${renderChanges({ facts, prep })}`,
    `### Not tested\n\n${untested}`,
    `### Where to find the rest\n\n${WHERE_START}\nThe control record below says where each file is kept, once its evidence is in.\n${WHERE_END}`,
    `${RECORD_START}\nThe control record (the table of checks) is written here when the release's tests have run.\n${RECORD_END}`,
  ].join('\n\n');

  // The merge back needs the work branch the cut recorded: with none, nothing does it, and a person must.
  const toTag = `Shipyard makes the tag \`${tag}\` and the GitHub Release (its text is the CHANGELOG section) and adds a "Shipped" comment to this PR`;
  const mergeBack = workBranch
    ? `merges the release back into \`${clean(workBranch, 80)}\`, the branch it was cut from (unless the repo turned that off)`
    : 'does not merge the release back, as this cut recorded no work branch: merge it into the branch it was cut from by hand';
  const merges = `**When this merges:** the merge into \`${base}\` starts the repo's ship job. When that job passes, ${toTag}, and ${mergeBack}. If the ship job fails, nothing is tagged.`;
  const manager = [merges, ...(report.managerNotes.length ? [report.managerNotes.map((n) => `- ${oneLine(n)}`).join('\n')] : [])].join('\n\n');

  const parts = [
    `<!-- shipyard:release-pr ${tag} -->`,
    `${TOP_START}\n${renderTop({ facts, prep, tag })}\n${TOP_END}`,
    fold(FOLDS[0], notes),
    fold(FOLDS[1], proof),
    fold(FOLDS[2], manager),
  ];
  const body = `${parts.join('\n\n')}\n`;
  // Text from the prep file must not hold a marker the record finds its places by.
  for (const marker of [TOP_START, TOP_END, WHERE_START, WHERE_END, RECORD_START, RECORD_END]) {
    if (body.split(marker).length - 1 !== 1) throw new Refusal(`the report or the release notes hold ${marker}, which the release PR's body uses as a marker: reword the text`);
  }
  return body;
}

// The words of a text as a reader counts them: anything with a letter or a digit.
const wordCount = (text) => String(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

module.exports = {
  buildSection, insertSection, renderReleaseNotes, renderPrBody, renderTop, assertPrepPasses, checkVersion, headingFor, upgradeSteps, whatShips, wordCount,
  TOP_START, TOP_END, WHERE_START, WHERE_END, RECORD_START, RECORD_END, WARN, FOLDS, oneLine, cell, sentenceCell, andList,
};
