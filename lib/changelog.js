'use strict';

// The CHANGELOG section, the release notes file and the release PR's body for one version.
// Pure: no network and no files. A PR's `Changelog:` line goes in as the facts hold it: this
// module joins lines, it never rewrites one.

const { GROUPS, lintPrep, checkFacts } = require('./lint-prep');
const { Refusal } = require('./release-git');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RECOMMENDATION_SHIP = '**Recommendation: SHIP**';

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

// The release PR's body: the report, as the top block. `shipyard record` adds the control
// record below it.
function renderPrBody({ tag, report }) {
  // The prep run's own answer is SHIP; `shipyard record` writes HOLD over it when anything did not pass.
  const parts = [`<!-- shipyard:release-pr ${tag} -->`, `## Release ${tag}`, RECOMMENDATION_SHIP, report.summary.trim()];
  if (report.changes.length) {
    parts.push(`### What changes\n\n${report.changes.map((c) => `- ${c.change.trim()} Proof: ${c.proof.trim()}`).join('\n')}`);
  }
  if (report.risks.length) {
    parts.push(`### Risks\n\n${report.risks.map((r) => `- ${r.risk.trim()} To undo: ${r.undo.trim()}`).join('\n')}`);
  }
  if (report.untested.length) {
    parts.push(`### Not tested\n\n${report.untested.map((u) => `- ${u.trim()}`).join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}

module.exports = {
  buildSection, insertSection, renderReleaseNotes, renderPrBody, assertPrepPasses, checkVersion, RECOMMENDATION_SHIP,
};
