'use strict';

// The CHANGELOG section, the release notes file and the release PR's body for one version.
// Pure: no network and no files. A PR's `Changelog:` line goes in as the facts hold it: this
// module joins lines, it never rewrites one.

const { GROUPS, lintPrep, checkFacts } = require('./lint-prep');
const { Refusal } = require('./release-git');
const { clean } = require('./clean');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The summary strip under the title (a one-row table and the report's summary): `shipyard cut`
// writes it from the facts and the prep file, and `shipyard record` rewrites it with what it
// found, so a reader sees the recommendation, the level and the risks at a glance.
const STRIP_START = '<!-- shipyard:strip:start -->';
const STRIP_END = '<!-- shipyard:strip:end -->';
const WARN = '\u26a0';

// The parts of the body `shipyard record` writes into: the strip, the risk table (so a risk it finds sits
// beside the prep run's) and the table of where the rest is kept. `shipyard cut` fills the strip and
// the risk table from the prep file and the where table with a placeholder; the record replaces what is between.
const RISKS_START = '<!-- shipyard:risks:start -->';
const RISKS_END = '<!-- shipyard:risks:end -->';
const WHERE_START = '<!-- shipyard:where:start -->';
const WHERE_END = '<!-- shipyard:where:end -->';

// The sections of the body, in order: the link text of the Contents line, the heading, and the
// anchor GitHub gives that heading (lowercase, spaces to hyphens, punctuation dropped).
const SECTIONS = [
  ['What changes', 'What changes for users', 'what-changes-for-users'],
  ['Risks', 'Risks and what we do', 'risks-and-what-we-do'],
  ['Not tested', 'Not tested', 'not-tested'],
  ['Release notes', 'Release notes (public)', 'release-notes-public'],
  ['Where to find the rest', 'Where to find the rest', 'where-to-find-the-rest'],
  ['Control record', 'Control record', 'control-record'],
];

// Text from the prep file or the facts, as one line, so it stays in its table cell or its sentence.
const oneLine = (text) => String(text).trim().replace(/\s+/g, ' ');

// A table cell: one line, with the bar that would end it written out.
const cell = (text) => oneLine(text).replace(/\|/g, '\\|');

// A table cell for a sentence: the one full stop at its end is left off, as a cell has no sentence after it.
const sentenceCell = (text) => cell(text).replace(/(?<!\.)\.$/, '');

// The groups a user can see, in the CHANGELOG's order. `Internal` is the one they cannot.
const USER_KINDS = GROUPS.filter((g) => g !== 'Internal');
const groupList = (prep, group) => [...((prep.groups && prep.groups[group]) || [])];
const userPrs = (prep) => USER_KINDS.flatMap((g) => groupList(prep, g)).sort((a, b) => a - b);
const kindOf = (prep, n) => USER_KINDS.concat('Internal').find((g) => groupList(prep, g).includes(n));

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

/**
 * The strip: one row of six cells and, under it, the paragraph that says what the release is.
 * `cells` are one-line text the caller has already made safe for a table. `condition` is what a
 * SHIP waits on ("once a person other than e-gineer approves"), so the verdict is one line.
 */
function renderStrip({ recommendation, condition = '', level, changes, tests, approver, upgrade, paragraph }) {
  return [
    '| Recommendation | Level | Changes | Tests | Second approver | Upgrade steps |',
    '|---|---|---|---|---|---|',
    `| **${recommendation}**${condition ? ` ${condition}` : ''} | ${level} | ${changes} | ${tests} | ${approver} | ${upgrade} |`,
    '',
    paragraph,
  ].join('\n');
}

// The cells that come from the prep file alone, so the cut and the record agree on them. A first
// release (the facts' `firstRelease`, lib/first-release.js) has its number set by the repo, not by the level.
function prepCells(prep, facts = null) {
  const internal = groupList(prep, 'Internal').length;
  const steps = upgradeSteps(prep);
  return {
    level: facts && facts.firstRelease ? 'first release' : cell(prep.level.bump),
    changes: `${userPrs(prep).length} for users \u00b7 ${internal} internal`,
    upgrade: steps ? `${WARN} ${steps}, in the notes` : 'none',
  };
}

// The table of what changes: a row for each change in the report, with the PRs it covers, their kind and what proves it,
// then a row for each PR a user can see that no change covers, which says so. The prep run cannot hide one.
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
  const missing = [];
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
      const line = pr.changelog;
      if (typeof line !== 'string' || !line.trim() || /[\r\n]/.test(line)) {
        missing.push(n);
        continue;
      }
      let item = `- ${line.trim()} (#${n})`;
      if (typeof pr.updateNeeds === 'string' && pr.updateNeeds.trim() && !/[\r\n]/.test(pr.updateNeeds)) {
        item += `\n  - Update needs: ${pr.updateNeeds.trim()}`;
      }
      items.push(item);
      included.push(n);
    }
    if (items.length) blocks.push(`### ${group}\n\n${items.join('\n')}`);
  }
  if (missing.length) {
    throw new Refusal(`no single valid Changelog line in the facts for ${missing.map((n) => `#${n}`).join(', ')}: a line is never written here, so the PR needs one and the facts must be made again`);
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

// The risks, each with what we do about it, as a table; `extra` are rows the record found that the prep
// run could not, `{ risk, undo }`, and come first. With neither, a sentence says none was named.
function renderRiskRows(report, extra = []) {
  const rows = [...extra, ...report.risks].map((r) => `| ${sentenceCell(r.risk)} | ${sentenceCell(r.undo)} |`);
  return rows.length ? ['| Risk | What we do |', '|---|---|', ...rows].join('\n') : 'No risk was named.';
}

// The release notes file, quoted as it is: every line behind `> `.
const quote = (text) => text.replace(/\s+$/, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

// The release notes have something to publish when a section holds an item (as the release check reads them).
const hasNotes = (text) => /^## \S/m.test(text) && /^- \S/m.test(text);

/**
 * The release PR's body, as `shipyard cut` writes it: the title, the summary strip, a Contents line,
 * then the sections of SECTIONS in order (the level on one line sits in the first), down to the table
 * of where the rest is kept. `shipyard record` adds the control record below it.
 *
 * `releaseNotes` is the text of releases/<tag>/release-notes.md, quoted word for word. `base` is the
 * branch the PR merges into and `workBranch` the one the cut started from (null when not recorded).
 */
function renderPrBody({ tag, facts, prep, releaseNotes, base = 'main', workBranch = null }) {
  const { report, level } = prep;
  // A first release (lib/first-release.js): its number is set by the repo, and the level moves nothing.
  const first = facts.firstRelease || null;
  const product = facts.repo.name.split('/')[1].replace(/^./, (c) => c.toUpperCase());
  const internal = [...((prep.groups && prep.groups.Internal) || [])].sort((a, b) => a - b);
  const internalText = `${internal.length} internal change${internal.length === 1 ? '' : 's'}`;
  const titles = new Map(facts.prs.map((p) => [p.number, p.title]));

  const changes = renderChanges({ facts, prep });
  const cells = prepCells(prep, facts);
  const strip = renderStrip({
    recommendation: 'SHIP', level: cells.level, changes: cells.changes, tests: 'not run yet', approver: 'not checked yet', upgrade: cells.upgrade, paragraph: oneLine(report.summary),
  });
  // Each by its title, so a reader sees what it was and a risk it caused is never hidden behind a number.
  const internalLine = internal.length
    ? `\n\n${internalText[0].toUpperCase()}${internalText.slice(1)}, which users do not see:\n\n${internal.map((n) => `- #${n} ${clean(titles.get(n), 80)}`).join('\n')}`
    : '';
  // The merge back needs the work branch the cut recorded: with none, nothing does it, and a person must.
  const toTag = `Shipyard makes the tag \`${tag}\` and the GitHub Release (its text is the CHANGELOG section) and adds a "Shipped" comment to this PR`;
  const mergeBack = workBranch
    ? `merges the release back into \`${clean(workBranch, 80)}\`, the branch it was cut from (unless the repo turned that off)`
    : 'does not merge the release back, as this cut recorded no work branch: merge it into the branch it was cut from by hand';
  const merges = `**When this merges:** the merge into \`${base}\` starts the repo's ship job. When that job passes, ${toTag}, and ${mergeBack}. If the ship job fails, nothing is tagged.`;
  const notes = hasNotes(releaseNotes)
    ? `Approving says these may be published.${internal.length ? ` Left out: ${internalText}.` : ''}\n\n${quote(releaseNotes)}`
    : 'No release notes: users see nothing in this release.';
  // A first release's line says its number is set by the repo; the prep run's level is still shown, as it moves nothing.
  const levelLine = first
    ? `**First release: ${oneLine(first.version)}**, set by firstRelease in .github/release.json, not by a level. The prep run's level was ${level.bump}: ${oneLine(level.reasons[0])}`
    : `**Level: ${level.bump}.** ${oneLine(level.reasons[0])}`;
  const untested = report.untested.length ? report.untested.map((u) => `- ${oneLine(u)}`).join('\n') : 'Nothing was named.';
  const heading = (i) => `### ${SECTIONS[i][1]}`;

  const parts = [
    `<!-- shipyard:release-pr ${tag} -->`,
    `## ${product} ${tag} · ${first ? 'first release' : level.bump} · since ${facts.range.from}`,
    `${STRIP_START}\n${strip}\n${STRIP_END}`,
    merges,
    `Contents: ${SECTIONS.map(([label, , anchor]) => `[${label}](#${anchor})`).join(' · ')} (the table of checks at the foot of this PR)`,
    `${heading(0)}\n\n${changes}\n\n${levelLine}${internalLine}`,
    `${heading(1)}\n\n${RISKS_START}\n${renderRiskRows(report)}\n${RISKS_END}`,
    `${heading(2)}\n\n${untested}`,
    `${heading(3)}\n\n${notes}`,
    `${heading(4)}\n\n${WHERE_START}\nThe control record below says where each file is kept, once its evidence is in.\n${WHERE_END}`,
  ];
  const body = `${parts.join('\n\n')}\n`;
  // Text from the prep file must not hold a marker the record finds its places by.
  for (const marker of [STRIP_START, STRIP_END, RISKS_START, RISKS_END, WHERE_START, WHERE_END, '<!-- shipyard:record:start -->', '<!-- shipyard:record:end -->']) {
    const expected = marker.includes('record') ? 0 : 1;
    if (body.split(marker).length - 1 !== expected) throw new Refusal(`the report or the release notes hold ${marker}, which the release PR's body uses as a marker: reword the text`);
  }
  return body;
}

module.exports = {
  buildSection, insertSection, renderReleaseNotes, renderPrBody, renderRiskRows, renderStrip, prepCells, assertPrepPasses, checkVersion, headingFor,
  STRIP_START, STRIP_END, WARN, RISKS_START, RISKS_END, WHERE_START, WHERE_END, SECTIONS, oneLine, cell, sentenceCell,
};
