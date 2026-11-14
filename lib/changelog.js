'use strict';

// The CHANGELOG section, the release notes file and the release PR's body for one version.
// Pure: no network and no files. A PR's `Changelog:` line goes in as the facts hold it: this
// module joins lines, it never rewrites one.

const { GROUPS, lintPrep, checkFacts } = require('./lint-prep');
const { Refusal } = require('./release-git');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RECOMMENDATION_SHIP = '**Recommendation: SHIP.**';

// The parts of the body `shipyard record` writes into: the risk list (so a risk it finds sits
// beside the prep run's) and the table of where the rest is kept. `shipyard cut` writes each pair
// empty-handed, and the record replaces what is between.
const RISKS_START = '<!-- shipyard:risks:start -->';
const RISKS_END = '<!-- shipyard:risks:end -->';
const WHERE_START = '<!-- shipyard:where:start -->';
const WHERE_END = '<!-- shipyard:where:end -->';

// The sections of the body, in order: the link text of the Contents line, the heading, and the
// anchor GitHub gives that heading (lowercase, spaces to hyphens, punctuation dropped).
const SECTIONS = [
  ['What changes', 'What changes for users', 'what-changes-for-users'],
  ['Risks and undo', 'Risks and undo', 'risks-and-undo'],
  ['Not tested', 'Not tested', 'not-tested'],
  ['Release notes', 'Release notes (public)', 'release-notes-public'],
  ['Where to find the rest', 'Where to find the rest', 'where-to-find-the-rest'],
  ['Control record', 'Control record', 'control-record'],
];

// Text from the prep file or the facts, as one line: a line the record later replaces by pattern must not run on.
const oneLine = (text) => String(text).trim().replace(/\s+/g, ' ');

// A table cell: one line, with the bar that would end it written out.
const cell = (text) => oneLine(text).replace(/\|/g, '\\|');

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

// The risks, each with how to undo it, as list items; `extra` are lines the record found that the
// prep run could not (already formatted). With neither, a sentence says none was named.
function renderRiskLines(report, extra = []) {
  const lines = [...extra, ...report.risks.map((r) => `- ${oneLine(r.risk)} To undo: ${oneLine(r.undo)}`)];
  return lines.length ? lines.join('\n') : 'No risk was named.';
}

// The release notes file, quoted as it is: every line behind `> `.
const quote = (text) => text.replace(/\s+$/, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

// The release notes have something to publish when a section holds an item (as the release check reads them).
const hasNotes = (text) => /^## \S/m.test(text) && /^- \S/m.test(text);

/**
 * The release PR's body, as `shipyard cut` writes it: the title, the recommendation and the level,
 * a Contents line, then the sections of SECTIONS in order, down to the table of where the rest is
 * kept. `shipyard record` adds the control record below it.
 *
 * `releaseNotes` is the text of releases/<tag>/release-notes.md, quoted word for word.
 */
function renderPrBody({ tag, facts, prep, releaseNotes }) {
  const { report, level } = prep;
  const product = facts.repo.name.split('/')[1].replace(/^./, (c) => c.toUpperCase());
  const internal = [...((prep.groups && prep.groups.Internal) || [])].sort((a, b) => a - b);
  const internalText = `${internal.length} internal change${internal.length === 1 ? '' : 's'}`;

  const changes = report.changes.length
    ? ['| Change | Proven by |', '|---|---|', ...report.changes.map((c) => `| ${cell(c.change)} | ${cell(c.proof)} |`)].join('\n')
    : 'No change a user sees.';
  const internalLine = internal.length ? `\n\n\\+ ${internalText} (${internal.map((n) => `#${n}`).join(', ')}), listed in the control record.` : '';
  const notes = hasNotes(releaseNotes)
    ? `Approving says these may be published.${internal.length ? ` Left out: ${internalText}.` : ''}\n\n${quote(releaseNotes)}`
    : 'No release notes: users see nothing in this release.';
  const untested = report.untested.length ? report.untested.map((u) => `- ${oneLine(u)}`).join('\n') : 'Nothing was named.';
  const heading = (i) => `### ${SECTIONS[i][1]}`;

  const parts = [
    `<!-- shipyard:release-pr ${tag} -->`,
    `## ${product} ${tag} · ${level.bump} · since ${facts.range.from}`,
    `${RECOMMENDATION_SHIP} ${oneLine(report.summary)}`,
    `**Level: ${level.bump}.** ${level.reasons.map(oneLine).join(' ')}`,
    `Contents: ${SECTIONS.map(([label, , anchor]) => `[${label}](#${anchor})`).join(' · ')}`,
    `${heading(0)}\n\n${changes}${internalLine}`,
    `${heading(1)}\n\n${RISKS_START}\n${renderRiskLines(report)}\n${RISKS_END}`,
    `${heading(2)}\n\n${untested}`,
    `${heading(3)}\n\n${notes}`,
    `${heading(4)}\n\n${WHERE_START}\nThe control record below says where each file is kept, once its evidence is in.\n${WHERE_END}`,
  ];
  const body = `${parts.join('\n\n')}\n`;
  // Text from the prep file must not hold a marker the record finds its places by.
  for (const marker of [RISKS_START, RISKS_END, WHERE_START, WHERE_END, '<!-- shipyard:record:start -->', '<!-- shipyard:record:end -->']) {
    const expected = marker.includes('record') ? 0 : 1;
    if (body.split(marker).length - 1 !== expected) throw new Refusal(`the report or the release notes hold ${marker}, which the release PR's body uses as a marker: reword the text`);
  }
  return body;
}

module.exports = {
  buildSection, insertSection, renderReleaseNotes, renderPrBody, renderRiskLines, assertPrepPasses, checkVersion, headingFor,
  RECOMMENDATION_SHIP, RISKS_START, RISKS_END, WHERE_START, WHERE_END, SECTIONS, oneLine, cell,
};
