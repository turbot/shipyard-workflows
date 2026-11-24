'use strict';

// The light release (docs/how-we-release.md, "Light releases"): a release for a repo that ships on
// merge with no version of its own, such as a docs repo or a site. It has the same branches and the
// same one approval as every other release, and no prep file, no CHANGELOG and no release notes.
//
//   .github/shipyard.yml:  profile: light
//                          light: { couldItBreak: Only this site's content changes. }
//   .github/release.json:  { "profile": "light", "light": { "couldItBreak": "Only this site's content changes." } }
//                          (the same two settings, until the repo moves to shipyard.yml)
//
// The version is made, never chosen: `<year>.<MDD>.<n>`, where MDD is the month and the day as one
// number (18 Nov is 1118, 5 Jan is 105: a leading zero is not valid semver) and n counts the day's
// releases from 0. It sorts by time. Pure: no network and no files, except `profileOf`'s argument.

const { ReleaseError, Refusal, parseTag, compareParts } = require('./release-git');
const { clean } = require('./clean');

const PROFILES = ['light'];
// The PRs the page lists before it says "and N more".
const MAX_LISTED = 20;
const DEFAULT_COULD_IT_BREAK = "Only this site's content changes.";
const COULD_IT_BREAK_MAX = 200;

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

/**
 * `profile` of a repo's `.github/release.json`: `'light'`, or null for the full release. Anything else is
 * refused, so a typo never turns a full release into a light one or the other way round.
 */
function profileOf(config, where = '.github/release.json') {
  if (!isObject(config) || config.profile === undefined) return null;
  if (!PROFILES.includes(config.profile)) throw new ReleaseError(`${where}: profile must be "light" (leave it out for the full release), not ${JSON.stringify(String(config.profile).slice(0, 40))}`);
  return config.profile;
}

/**
 * `light.couldItBreak` of the same file: the one line the light page answers "Could it break anything?" with.
 * Null when the repo says nothing, and the page then uses the default.
 */
function couldItBreakOf(config, where = '.github/release.json') {
  if (!isObject(config) || config.light === undefined) return null;
  if (!isObject(config.light)) throw new ReleaseError(`${where}: light must be an object, such as { "couldItBreak": "..." }`);
  const extra = Object.keys(config.light).filter((k) => k !== 'couldItBreak');
  if (extra.length) throw new ReleaseError(`${where}: light holds only "couldItBreak", not "${extra[0].slice(0, 40)}"`);
  const text = config.light.couldItBreak;
  if (text === undefined) return null;
  if (typeof text !== 'string' || !text.trim() || /[\r\n]/.test(text) || text.length > COULD_IT_BREAK_MAX) {
    throw new ReleaseError(`${where}: light.couldItBreak must be one line of at most ${COULD_IT_BREAK_MAX} characters`);
  }
  return text.trim();
}

const isLight = (facts) => Boolean(facts) && facts.profile === 'light';

// ---------------------------------------------------------------------------
// The version

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// `[year, MDD]` of a `YYYY-MM-DD` date, or a Refusal for a date that is not one.
function dayParts(date) {
  const m = DAY.exec(String(date));
  const [year, month, day] = m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [];
  const real = m && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (!real) throw new ReleaseError(`the date must be YYYY-MM-DD, not ${JSON.stringify(String(date).slice(0, 20))}`);
  return [year, month * 100 + day];
}

/**
 * Whether `parts` (a tag's three numbers) are a light version: a year, a month-and-day that is a real day, and a count.
 */
function isLightParts(parts) {
  if (!Array.isArray(parts) || parts.length !== 3) return false;
  const [year, mdd] = parts;
  const month = Math.floor(mdd / 100);
  const day = mdd % 100;
  return year >= 2000 && year <= 9999 && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/**
 * The next light version: `<year>.<MDD>.0` for the first release of a day, then `.1`, `.2`.
 *
 * @param {string[]} tags       the repo's tag names
 * @param {string} tagPrefix
 * @param {string} date         `YYYY-MM-DD`, UTC: the day the release is cut
 * @returns {{ version: string, parts: number[] }}
 */
function lightVersion({ tags, tagPrefix, date }) {
  const [year, mdd] = dayParts(date);
  const known = tags.map((t) => parseTag(t, tagPrefix)).filter(Boolean);
  const newest = [...known].sort((a, b) => compareParts(a.parts, b.parts)).pop();
  // A tag from a later day (a clock set wrong, or a release cut for tomorrow) would make this version sort before it.
  if (newest && compareParts(newest.parts, [year, mdd, 0]) > 0 && !(newest.parts[0] === year && newest.parts[1] === mdd)) {
    throw new Refusal(`${newest.tag} is newer than ${date}: a light release is dated by the day it is cut, so it would sort before it`);
  }
  const today = known.filter((t) => t.parts[0] === year && t.parts[1] === mdd);
  const n = today.length ? Math.max(...today.map((t) => t.parts[2])) + 1 : 0;
  const parts = [year, mdd, n];
  return { version: parts.join('.'), parts };
}

/**
 * What is wrong with a light release's version, or null, for the release check. It has no date to read, so it asks that
 * the version is a real light version and newer than the newest tag before it. A count may skip numbers: a release of the
 * day that merged and was never tagged (its deployment failed) has taken one.
 */
function lightProblem({ parts, previous }) {
  if (!isLightParts(parts)) return `${parts.join('.')} is not a light version (<year>.<month and day as one number>.<count>)`;
  if (!previous) return null;
  if (compareParts(parts, previous) <= 0) return `${parts.join('.')} is not newer than ${previous.join('.')}, the newest release before it`;
  return null;
}

// ---------------------------------------------------------------------------
// What a light release is made of: no prep file, so the pages that read one get this

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The product as the page's heading names it (lib/changelog.js `productOf`, which this file cannot require: it requires this one).
const productName = (facts) => (typeof facts.product === 'string' && facts.product.trim() ? facts.product.trim().replace(/\s+/g, ' ') : String(facts.repo && facts.repo.name || '').split('/')[1] || 'this product');

// The version the range starts at, as a person reads it (`2026.1117.0`), or null when it starts at no release tag of the repo.
function sinceOf(facts) {
  const range = facts.range || {};
  const found = typeof range.from === 'string' ? parseTag(range.from, String(facts.tagPrefix || '')) : null;
  return found ? found.parts.join('.') : null;
}

/**
 * The paragraph the Slack ask posts for a light release (`report.ask` of a full release's prep file, which a light release
 * has none of): it starts `This release`, holds the count and the product, never a PR title or number, and says the release
 * PR lists the changes.
 */
function lightAsk(facts) {
  const n = facts.prs.length + (facts.unattributed || []).length;
  const since = sinceOf(facts);
  const changes = `${n === 1 ? 'the 1 change' : `the ${n} changes`} merged since ${since || 'the last release'}`;
  // "Reviewed in its own PR" is true only when every change came in as a PR; a commit with no PR has none.
  const reviewed = (facts.unattributed || []).length ? '' : `${n === 1 ? 'It was' : 'Each one was'} reviewed in its own PR, and `;
  return `This release puts ${changes} live on ${productName(facts).slice(0, 80)}. ${reviewed ? reviewed + 'the' : 'The'} release PR lists ${n === 1 ? 'it' : 'them'}.`;
}

/**
 * The prep file the record, the ask and the release PR check read, made from the facts and never written: a light
 * release has none. The level is `patch` for the places that show one; the version is the date's.
 */
function lightPrepFor(facts) {
  const n = facts.prs.length + (facts.unattributed || []).length;
  return {
    format: 'light',
    level: { bump: 'patch', reasons: ['A light release: its version is the date and the count of the day, so no level is chosen'] },
    report: {
      headline: count(n, 'change', 'changes'),
      ask: lightAsk(facts),
      changes: [],
      internal: [],
      safety: { answer: couldItBreakText(facts), why: '' },
      managerNotes: [],
    },
  };
}

// ---------------------------------------------------------------------------
// The page

// One merged PR as a list item: its title (cleaned, as a table cell is), its number as a link and its author.
function prItem(pr) {
  const who = pr.author ? ` by ${clean(pr.author, 40)}` : '';
  const link = /^https:\/\/\S+$/.test(String(pr.url || '')) ? `[#${pr.number}](${pr.url})` : `#${pr.number}`;
  return `- ${clean(pr.title, 120)} (${link}${who})`;
}

// The merged PRs of the range, newest number last; a commit with no PR (the facts' `unattributed`) is named by its sha.
function listedChanges(facts) {
  const prs = [...facts.prs].sort((a, b) => a.number - b.number).map(prItem);
  const loose = (facts.unattributed || []).map((u) => `- ${clean(u.subject, 120)} (commit \`${String(u.sha).slice(0, 7)}\`, no pull request)`);
  return [...prs, ...loose];
}

/**
 * The PR list: at most MAX_LISTED lines, then "and N more". Returns the lines.
 */
function changeLines(facts, max = MAX_LISTED) {
  const all = listedChanges(facts);
  if (all.length <= max) return all;
  return [...all.slice(0, max), `- and ${all.length - max} more`];
}

const couldItBreakText = (facts) => (typeof facts.couldItBreak === 'string' && facts.couldItBreak.trim() ? facts.couldItBreak.trim() : DEFAULT_COULD_IT_BREAK);

// What changes, then could it break anything. The decision table goes above, as the full release's does.
function whatChanges(facts) {
  const lines = changeLines(facts);
  return `### What changes\n\n${lines.length ? lines.join('\n') : 'No changes.'}`;
}

function couldItBreak(facts) {
  return `### Could it break anything? ${clean(couldItBreakText(facts), COULD_IT_BREAK_MAX)}`;
}

/**
 * The first line of the light page's top: the product, the version and how many changes.
 */
function heading({ facts, tag, productOf, versionOf }) {
  const n = facts.prs.length + (facts.unattributed || []).length;
  return `## ${productOf(facts)} ${versionOf(tag, facts.tagPrefix)}: ${count(n, 'change', 'changes')}`;
}

/**
 * The GitHub Release's text for a light release: the merged PRs, as the page lists them. It is read from the facts
 * the cut committed, because a light release has no CHANGELOG section.
 */
function lightReleaseBody(facts) {
  return `${changeLines(facts).join('\n')}\n`;
}

module.exports = {
  PROFILES, MAX_LISTED, DEFAULT_COULD_IT_BREAK, profileOf, couldItBreakOf, isLight, dayParts, isLightParts, lightVersion, lightProblem,
  lightPrepFor, lightAsk, changeLines, whatChanges, couldItBreak, heading, lightReleaseBody, couldItBreakText,
};
