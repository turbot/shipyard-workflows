'use strict';

// The CHANGELOG section, the release notes file and the release PR's body for one version.
// Pure: no network and no files. A PR's `Changelog:` line goes in as the facts hold it: this
// module joins lines, it never rewrites one.

const { GROUPS, lintPrep, checkFacts } = require('./lint-prep');
const { Refusal } = require('./release-git');
const { clean } = require('./clean');
const light = require('./light');
const { deployRows } = require('./deploy-rows');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

// The release PR's page: the part a person reads to approve, then two folds. `shipyard cut` writes the top from
// the facts and the prep file, and `shipyard record` writes it again with what it found (the checks, the reviews).
const TOP_START = '<!-- shipyard:top:start -->';
const TOP_END = '<!-- shipyard:top:end -->';
// The audit record, in the second fold: the cut writes a placeholder, the record replaces it.
const RECORD_START = '<!-- shipyard:record:start -->';
const RECORD_END = '<!-- shipyard:record:end -->';
// What gets published, in the first fold: the cut writes it, and the record writes it again from the head.
const PUBLISHED_START = '<!-- shipyard:published:start -->';
const PUBLISHED_END = '<!-- shipyard:published:end -->';
// What happens on merge, after what gets published in the same fold: the cut writes it, and the record writes its Announce line again.
const MERGE_START = '<!-- shipyard:merge:start -->';
const MERGE_END = '<!-- shipyard:merge:end -->';
// A re-ship's line on what the fix changes: the cut writes the fixes it picked (or a placeholder), the record the fix PRs.
const RESHIP_FIX_START = '<!-- shipyard:reship-fix:start -->';
const RESHIP_FIX_END = '<!-- shipyard:reship-fix:end -->';

// The two folds under the top, in order, never one inside another: the summary's bold part, then what it is for.
const FOLDS = [
  ['What gets published', 'when this merges'],
  ['Evidence', 'for auditors; you do not need to open this'],
];
// Where the page says what happens on merge.
const TAG_DOC = 'https://github.com/turbot/shipyard/blob/main/docs/release-tag.md';

// Text from the prep file or the facts, as one line, so it stays in its table cell or its sentence.
const oneLine = (text) => String(text).trim().replace(/\s+/g, ' ');

// A table cell: one line, with the bar that would end it written out.
const cell = (text) => oneLine(text).replace(/\|/g, '\\|');

// A phrase with the one full stop at its end left off, and a sentence that ends in one.
const phrase = (text) => oneLine(text).replace(/(?<!\.)\.$/, '');
const sentence = (text) => {
  const t = oneLine(text);
  return /[.!?)]$/.test(t) ? t : `${t}.`;
};
const cap = (text) => String(text).replace(/^./, (c) => c.toUpperCase());

const andList = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`);

function checkVersion(version) {
  if (!VERSION.test(version)) throw new Refusal(`the version must be X.Y.Z, not ${JSON.stringify(String(version))}`);
}

// The facts and the prep file must pass the same checks `lint-prep` makes before anything is
// built from them. Returns nothing; throws a Refusal naming each problem.
function assertPrepPasses(facts, prep, { names = true, workBranch } = {}) {
  checkFacts(facts);
  const problems = lintPrep(prep, facts, { names, workBranch });
  if (problems.length) {
    throw new Refusal(`the prep file is refused by lint-prep (${problems.length} problem${problems.length === 1 ? '' : 's'}):\n${problems.map((p) => `  ${p.at}: ${p.message} [${p.rule}]`).join('\n')}`);
  }
}

/**
 * One PR's item, as a CHANGELOG section lists it: its `Changelog:` line as it is, its link (`(#N)`), and its
 * `Update-Needs:` line under it where it has one. `pr` is `{ number, changelog, updateNeeds }`, as the facts
 * hold a PR. The one place an item is written: the section and a prerelease's body (lib/prerelease.js) both use it.
 */
function changelogItem(pr) {
  let item = `- ${pr.changelog.trim()} (#${pr.number})`;
  if (typeof pr.updateNeeds === 'string' && pr.updateNeeds.trim() && !/[\r\n]/.test(pr.updateNeeds)) {
    item += `\n  - Update needs: ${pr.updateNeeds.trim()}`;
  }
  return item;
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
      items.push(changelogItem(pr));
      included.push(n);
    }
    if (items.length) blocks.push(`### ${group}\n\n${items.join('\n')}`);
  }
  const body = blocks.length ? blocks.join('\n\n') : 'Nothing in this release changes what ships.';
  return { text: `## [${version}] - ${date}\n\n${body}\n`, included, left };
}

const headingFor = (version) => new RegExp(`^## \\[?v?${version.replace(/\./g, '\\.')}\\]?(?:\\s|$)`, 'm');

// The CHANGELOG section for a version: its `## [x.y.z]` heading and everything under it up to the
// next `## ` heading. Null when the file has no such section.
function changelogSection(text, version) {
  const file = String(text || '').replace(/\r\n?/g, '\n');
  const start = headingFor(version).exec(file);
  if (!start) return null;
  const from = file.slice(start.index);
  const afterHeading = from.indexOf('\n') + 1;
  const next = afterHeading > 0 ? /^## /m.exec(from.slice(afterHeading)) : null;
  const section = next ? from.slice(0, afterHeading + next.index) : from;
  return `${section.trim()}\n`;
}

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

// One item of the published notes: `- **<name>:** <text>` when it has a name, else `- <text>`.
const renderNotesItem = (i) => `- ${typeof i.name === 'string' && i.name.trim() ? `**${i.name.trim()}:** ` : ''}${i.text.trim()}`;

// The published notes, from `prep.notes`: title, summary, then each heading with its items.
function renderReleaseNotes(notes) {
  const parts = [`# ${notes.title.trim()}`, notes.summary.trim()];
  for (const s of notes.sections) {
    parts.push(`## ${s.heading.trim()}\n\n${s.items.map(renderNotesItem).join('\n')}`);
  }
  return `${parts.join('\n\n')}\n`;
}

// The release notes file, quoted as it is: every line behind `> `.
const quote = (text) => text.replace(/\s+$/, '').split('\n').map((l) => (l ? `> ${l}` : '>')).join('\n');

// The release notes have something to publish when a section holds an item (as the release check reads them).
const hasNotes = (text) => /^## \S/m.test(text) && /^- \S/m.test(text);

// The product's display name: `product` in its `.github/release.json`, as the facts carry it; with none, the repo's
// name as it is, never guessed at with a capital letter.
const productOf = (facts) => (typeof facts.product === 'string' && facts.product.trim() ? oneLine(facts.product) : facts.repo.name.split('/')[1]);
// A tag without its prefix: `v0.5.1` is 0.5.1.
const versionOf = (tag, prefix) => (prefix && String(tag).startsWith(prefix) ? String(tag).slice(prefix.length) : String(tag));

// A fold: a summary line a reader opens, and what is under it.
const fold = ([bold, rest], inner) => `<details>\n<summary><b>${bold}</b> · ${rest}</summary>\n\n${inner}\n\n</details>`;

// The decision table before anything is checked, as the cut writes it: its header row, then each row.
const NOT_CHECKED = {
  header: '⏳ Not yet: checks still running',
  rows: [['Checks', '⏳ Not checked yet'], ['Approved by', '⏳ No one yet'], ['Still needed', '⏳ The checks finish. Then 1 approval']],
};

// The decision table, straight under the heading: the decision, then Checks, Production setup (when the repo turns
// the production plan on), During the deploy and A person's step (when the report sets them), Approved by and Still needed.
// The icons are this table's alone.
function decisionTable(decision) {
  return [`| Ready to approve? | ${cell(decision.header)} |`, '|:--|:--|', ...decision.rows.map(([k, v]) => `| ${k} | ${cell(v)} |`)].join('\n');
}

// The kind of a change, from the groups of the PRs it covers: the first group in GROUPS order wins.
const KIND = {
  Added: 'New', Changed: 'Changed', Fixed: 'Fixed', Removed: 'Removed', Security: 'Security',
};
function kindOf(change, groups) {
  for (const g of GROUPS) {
    if (g === 'Internal') continue;
    if ((groups[g] || []).some((n) => change.covers.includes(n))) return KIND[g];
  }
  return 'Changed';
}

// Names for a line, three at most: "a · b · c and 2 more".
const dotted = (items, max, more = (n) => `and ${n} more`) => (items.length > max ? `${items.slice(0, max).join(' · ')} ${more(items.length - max)}` : items.join(' · '));

// Whom the release is for, as the page's What changes heading names them: `audience` in the repo's release.json.
const audienceOf = (facts) => (typeof facts.audience === 'string' && facts.audience.trim() ? oneLine(facts.audience) : 'users');

// What changes. Some change a user sees: a Before | Now table, a row each, then one line for the changes no user
// sees. None: the internal changes as bullets, a security fix first.
function whatChanges(prep, facts) {
  const { report } = prep;
  const groups = prep.groups || {};
  const audience = audienceOf(facts);
  const internal = report.internal || [];
  const security = new Set(groups.Security || []);
  const isSecurity = (x) => x.covers.some((n) => security.has(n));
  if (report.changes.length) {
    const rows = report.changes.map((c) => `| **${kindOf(c, groups)}** | ${cell(phrase(c.before))} | ${cell(phrase(c.after))} |`);
    const covered = new Set(report.changes.flatMap((c) => c.covers));
    const left = GROUPS.filter((g) => g !== 'Internal').flatMap((g) => groups[g] || []).filter((n) => !covered.has(n) && !internal.some((x) => x.covers.includes(n)));
    const after = [];
    if (left.length) after.push(`Also ${left.length} more change${left.length === 1 ? '' : 's'}, in Evidence`);
    if (internal.length) after.push(`Also ${internal.length} internal change${internal.length === 1 ? '' : 's'}: ${dotted(internal.map((x) => phrase(x.text)), 3)}`);
    return [`### What changes for ${audience}`, ['| | Before | Now |', '|:--|:--|:--|', ...rows].join('\n'), ...after].join('\n\n');
  }
  const heading = `### What changes: nothing ${audience} see`;
  if (!internal.length) return `${heading}\n\nNo changes.`;
  const ordered = [...internal.filter(isSecurity), ...internal.filter((x) => !isSecurity(x))];
  const bullets = ordered.slice(0, 5).map((x) => `- ${isSecurity(x) ? '**Security:** ' : ''}${phrase(x.text)}`);
  if (ordered.length > 5) bullets.push(`- and ${ordered.length - 5} more, in Evidence`);
  return `${heading}\n\n${internal.length} internal change${internal.length === 1 ? '' : 's'}:\n\n${bullets.join('\n')}`;
}

// Could it break anything, and how to go back: the answer, one line of why, then If | Then with the undo last.
function couldItBreak({ facts, report }) {
  const first = facts.firstRelease || null;
  const rows = (report.risks || []).map((r) => `| ${cell(phrase(r.if))}${r.untested ? ` (untested: ${cell(phrase(r.untested))})` : ''} | ${cell(phrase(r.then))} |`);
  const back = first ? `There is no earlier version: ${phrase(report.undo.how)}` : `Go back to ${versionOf(facts.range.from, facts.tagPrefix)}: ${phrase(report.undo.how)}`;
  rows.push(`| we need to undo the release | ${cell(back)}. ${cell(cap(phrase(report.undo.howLong)))} |`);
  return [`### Could it break anything? ${phrase(report.safety.answer)}`, sentence(report.safety.why), ['| If | Then |', '|:--|:--|', ...rows].join('\n')].join('\n\n');
}

/**
 * The top of the page, and nothing else: the heading, the decision table, what changes, and could it break anything
 * with how to go back. Each fact is said once; the folds below prove it.
 *
 * `status` is what `shipyard record` found, null before it runs (the cut): `{ decision: { header, rows } }`.
 * `lint` renders the cut's form with every row the record can add, for lint-prep's count of lines.
 */
function renderTop({
  facts, prep, tag, status = null, lint = false, names = null,
}) {
  if (light.isLight(facts)) return renderLightTop({ facts, tag, status });
  const { report } = prep;
  const first = facts.firstRelease || null;
  const urgent = report.urgent === true ? ' (urgent fix)' : '';
  const heading = `## ${productOf(facts)} ${versionOf(tag, facts.tagPrefix)}${first ? ' (first release)' : ''}${urgent}: ${phrase(report.headline)}`;
  let decision = status && status.decision ? status.decision : null;
  if (!decision) {
    // Before the record: the cut's rows, with the rows the prep file asks for. The lint counts every row the record can add.
    const [checks, ...rest] = NOT_CHECKED.rows;
    decision = {
      header: NOT_CHECKED.header,
      rows: [
        checks,
        ...(lint ? [['Production setup', '✅ No change']] : []),
        ...deployRows({ report, names, lint }),
        ...rest,
      ],
    };
  }
  return [heading, decisionTable(decision), whatChanges(prep, facts), couldItBreak({ facts, report })].join('\n\n');
}

// What happens on merge, after the published texts in the first fold: a flow in a code block, then the tagging doc.
// `base` is the branch the PR merges into and `workBranch` the one the cut started from (null when not recorded). A re-ship
// (`reship`, lib/reship.js) is tagged at its own merge commit and comments on the release PR it finishes too, and always
// has the ship job: it exists for a release whose ship job broke.
// `announce` is null when the repo does not call Shipyard's announce.yml (no Announce line), else `{ notes }`: whether the release has release notes.
// `shipSignal` is the repo's tag signal (lib/tag-signal.js): the ship job, `/shipped`, both, or the merge alone; null when
// the cut could not read it, and the flow then says so and names no steps. Left out, it is the ship job.
function whenThisMerges({
  tag, base, workBranch, reship = null, announce = null, shipSignal = 'ship-job',
}) {
  const signal = reship ? 'ship-job' : shipSignal;
  const merge = `merge into ${oneLine(base)}`;
  const shipped = `  -> "Shipped" comment on this PR${reship ? ` and on #${reship.releasePr}` : ''}`;
  const back = workBranch ? `  -> merge back into ${clean(workBranch, 80)}` : '  -> no merge back: this cut recorded no work branch, so merge it back by hand';
  const shipLines = {
    'ship-job': [
      `  -> the repo's ship job: deploys, then tags ${tag}${reship ? " at this PR's merge commit" : ''} and makes the GitHub Release`,
      '     (if the ship job fails, there is no tag)',
    ],
    both: [
      `  -> the repo's ship job: deploys, then tags ${tag} and makes the GitHub Release`,
      '     (if the ship job fails, there is no tag; a person with write access can comment /shipped on this PR to tag a release that is live but whose ship job cannot pass)',
    ],
    shipped: [
      '  -> nothing runs by itself: the release manager does the steps after the merge',
      `  -> a person with write access comments /shipped on this PR once they are done: ${tag} is tagged and the GitHub Release made`,
      '     (until then there is no tag)',
    ],
    merge: [`  -> ${tag} is tagged on the merge, and the GitHub Release made (a library: the tag is the publish)`],
  }[signal];
  // A repo whose signal could not be read gets no steps: any would be another repo's flow.
  const flow = shipLines
    ? [merge, ...shipLines, shipped, ...announceLines(announce), back]
    : [merge, "  -> this cut could not read how the repo's workflows tag a release, so this page does not say what the merge sets off"];
  return `#### When this merges\n\n\`\`\`\n${flow.join('\n')}\n\`\`\`\n\n[How a release is tagged](${TAG_DOC})`;
}

// The Announce step of the flow: its "Live in" comments always, and its #releases line only for a release with notes.
function announceLines(announce) {
  if (!announce) return [];
  return [
    '  -> Announce: "Live in" comment on each issue this closes',
    announce.notes ? '     (and a #releases line: this release has release notes)' : '     (no #releases line: this release has no release notes)',
  ];
}

// The flow the cut wrote, with its Announce step written again for what the record found at the head: the lines between
// the "Shipped" comment and the merge back are replaced and nothing else moves, so a re-ship keeps its own wording.
// A block with no such lines (one a person edited) is returned as it is.
function withAnnounce(block, announce) {
  const lines = block.split('\n');
  const shipped = lines.findIndex((l) => l.startsWith('  -> "Shipped" comment'));
  const back = lines.findIndex((l, i) => i > shipped && /^  -> (?:no )?merge back/.test(l));
  if (shipped === -1 || back === -1) return block;
  return [...lines.slice(0, shipped + 1), ...announceLines(announce), ...lines.slice(back)].join('\n');
}

// What the release publishes, first in the first fold: where each text goes, then each text, word for word.
// `releaseBody` is the GitHub Release's text (the CHANGELOG section, as lib/tag.js `releaseTexts` reads it);
// `releaseNotes` is releases/<tag>/release-notes.md, for the changelog page and the Slack post.
function published({ tag, releaseBody, releaseNotes }) {
  const notes = hasNotes(releaseNotes);
  const table = [
    '| Where | What |',
    '|:--|:--|',
    `| GitHub Release \`${tag}\` | The text below, word for word |`,
    `| Changelog page and Slack post | ${notes ? 'The release notes below, word for word' : 'Nothing: this release has no release notes'} |`,
  ].join('\n');
  return [table, `GitHub Release \`${tag}\`:`, quote(releaseBody), ...(notes ? ['Release notes:', quote(releaseNotes)] : [])].join('\n\n');
}

/**
 * The release PR's body, as `shipyard cut` writes it: the top, then two folds, never one inside another: what gets
 * published with what happens on merge after it, and the evidence (which `shipyard record` fills in). The notes for the
 * release manager are a comment the record posts, never part of the body.
 *
 * `releaseBody` is the CHANGELOG section the GitHub Release publishes, and `releaseNotes` the text of
 * releases/<tag>/release-notes.md: each is quoted word for word. `announces` is whether the repo calls Shipyard's
 * announce.yml (lib/announce-called.js), which adds the Announce step to what happens on merge, and `shipSignal` the repo's tag
 * signal (lib/tag-signal.js), which says what the merge sets off. `names` maps a lowercase
 * login to a profile name, for the person steps of the report (lib/deploy-rows.js).
 */
function renderPrBody({
  tag, facts, prep, releaseBody, releaseNotes, base = 'main', workBranch = null, reship = null, announces = false, shipSignal = 'ship-job', names = null,
}) {
  if (typeof releaseBody !== 'string' || !releaseBody.trim()) throw new Refusal('the release PR needs the GitHub Release text, the CHANGELOG section, to show it');
  const evidence = `${RECORD_START}\nWho reviewed each change, the checks and the files are written here once the tests have finished.\n${RECORD_END}`;
  const merge = whenThisMerges({
    tag, base, workBranch, reship, announce: announces ? { notes: hasNotes(releaseNotes) } : null, shipSignal,
  });
  const parts = [
    `<!-- shipyard:release-pr ${tag} -->`,
    ...(reship ? [renderReshipPart({ tag, facts, reship })] : []),
    `${TOP_START}\n${renderTop({ facts, prep, tag, names })}\n${TOP_END}`,
    fold(FOLDS[0], `${PUBLISHED_START}\n${published({ tag, releaseBody, releaseNotes })}\n${PUBLISHED_END}\n\n${MERGE_START}\n${merge}\n${MERGE_END}`),
    fold(FOLDS[1], evidence),
  ];
  const body = `${parts.join('\n\n')}\n`;
  // Text from the prep file must not hold a marker the record finds its places by.
  for (const marker of [TOP_START, TOP_END, PUBLISHED_START, PUBLISHED_END, MERGE_START, MERGE_END, RECORD_START, RECORD_END, ...(reship ? [RESHIP_FIX_START, RESHIP_FIX_END] : [])]) {
    if (body.split(marker).length - 1 !== 1) throw new Refusal(`the report or the release notes hold ${marker}, which the release PR's body uses as a marker: reword the text`);
  }
  return body;
}

/**
 * The top of a light release's page (lib/light.js): the heading with the number of changes, the decision table, what
 * changes as the merged PRs' titles, and the fixed could-it-break line. No Before | Now table: a light release has no
 * prep file to write one from.
 */
function renderLightTop({ facts, tag, status = null }) {
  const decision = status && status.decision ? status.decision : NOT_CHECKED;
  return [
    light.heading({ facts, tag, productOf, versionOf }), decisionTable(decision), light.whatChanges(facts), light.couldItBreak(facts),
  ].join('\n\n');
}

// What happens on merge for a light release: the deployment (where the repo has one) is the ship signal, and the #releases
// line is left out, since a light release has no release notes.
function lightWhenThisMerges({ tag, base, workBranch, announces }) {
  const flow = [
    `merge into ${oneLine(base)}`,
    `  -> the production deployment of the merge commit reports success, then ${tag} is tagged and the GitHub Release made`,
    '     (a repo with no deployments is tagged on the merge; a failed deployment makes no tag)',
    '  -> "Shipped" comment on this PR',
    ...(announces ? ['  -> Announce: "Live in" comment on each issue this closes', '     (no #releases line: a light release has no release notes)'] : []),
    workBranch ? `  -> merge back into ${clean(workBranch, 80)}` : '  -> no merge back: this cut recorded no work branch, so merge it back by hand',
  ];
  return `#### When this merges\n\n\`\`\`\n${flow.join('\n')}\n\`\`\`\n\n[How a release is tagged](${TAG_DOC})`;
}

/**
 * The release PR's body for a light release, as `shipyard cut` writes it: the same page as the full release's, with the
 * merged PRs where the CHANGELOG section and the notes would be. The record fills the same places.
 */
function renderLightPrBody({
  tag, facts, base = 'main', workBranch = null, announces = false,
}) {
  const evidence = `${RECORD_START}\nWho reviewed each change, the checks and the files are written here once the tests have finished.\n${RECORD_END}`;
  const releaseText = `GitHub Release \`${tag}\`:\n\n${quote(light.lightReleaseBody(facts))}`;
  const table = ['| Where | What |', '|:--|:--|', `| GitHub Release \`${tag}\` | The list below, word for word |`, '| Changelog page and Slack post | Nothing: a light release has no release notes |'].join('\n');
  const parts = [
    `<!-- shipyard:release-pr ${tag} -->`,
    `${TOP_START}\n${renderLightTop({ facts, tag })}\n${TOP_END}`,
    fold(FOLDS[0], `${PUBLISHED_START}\n${table}\n\n${releaseText}\n${PUBLISHED_END}\n\n${MERGE_START}\n${lightWhenThisMerges({ tag, base, workBranch, announces })}\n${MERGE_END}`),
    fold(FOLDS[1], evidence),
  ];
  return `${parts.join('\n\n')}\n`;
}

// The text above the first fold of a body: the part a lint and a test count and check for plain words.
function aboveFolds(body) {
  const text = String(body);
  const at = text.indexOf('<details>');
  return at === -1 ? text : text.slice(0, at);
}

/**
 * A re-ship's part, first in its body: that this is a re-ship, which run failed and where, and what
 * the fix changes. `reship` is `{ releasePr, mergedAt, failedRun: { id, url, failedAt } }`; a fix
 * that merges into the branch after the cut is not known then, so `shipyard record` fills the line again.
 */
function renderReshipPart({ tag, facts, reship }) {
  const version = versionOf(tag, facts.tagPrefix);
  const day = /^\d{4}-\d{2}-\d{2}/.exec(String(reship.mergedAt || ''));
  const run = reship.failedRun;
  return [
    `## Re-ship of ${version}`,
    `**This is a re-ship.** ${version} merged${day ? ` on ${day[0]}` : ''} as #${reship.releasePr}, and its ship failed at ${clean(run.failedAt, 160)} ([run ${run.id}](${run.url})), so ${tag} was never made. This PR fixes the ship job and finishes ${version}: the same version, tagged at this PR's merge commit once the fixed ship job passes. Approve the fix.`,
    `**What the fix changes:**\n${RESHIP_FIX_START}\n${reshipFixText(reship.fixes || [])}\n${RESHIP_FIX_END}`,
  ].join('\n\n');
}

// The fix PRs a re-ship holds, one line each: `{ number, title, changelog, review? }`. A fix cherry-picked
// onto the branch by the cut, or merged into it since, is the same line; `review` says what its own PR's
// reviews are.
function reshipFixText(fixes) {
  if (!fixes.length) return 'No fix is on this branch yet. It comes with the cut (`fixes`), as a PR into it, or as a commit a person cherry-picks onto it (a workflow fix), and the record names it here.';
  return fixes.map((f) => `- #${f.number}: ${clean(f.title, 160)}${f.changelog ? ` (Changelog: ${clean(f.changelog, 200)})` : ' (no Changelog line: the fix ships nothing users see)'}${f.review ? `. Review: ${clean(f.review, 160)}.` : ''}`).join('\n');
}

// The words of a text as a reader counts them: anything with a letter or a digit.
const wordCount = (text) => String(text).split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;

module.exports = {
  buildSection, changelogItem, insertSection, changelogSection, renderReleaseNotes, renderPrBody, renderLightPrBody, renderLightTop, lightWhenThisMerges, renderTop, assertPrepPasses, checkVersion, headingFor, wordCount, aboveFolds,
  productOf, versionOf, audienceOf, whenThisMerges, withAnnounce, hasNotes, published, decisionTable, kindOf, TOP_START, TOP_END, PUBLISHED_START, PUBLISHED_END, MERGE_START, MERGE_END, RECORD_START, RECORD_END, RESHIP_FIX_START, RESHIP_FIX_END, reshipFixText, FOLDS, NOT_CHECKED, TAG_DOC, oneLine, cell, phrase, sentence, cap, andList,
};
