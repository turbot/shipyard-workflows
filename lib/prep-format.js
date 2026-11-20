'use strict';

// Why this file exists: a release cut before prep format 3 (its release PR's body, or its `releases/<tag>/`
// folder) holds a format-2 prep, and the lint now refuses format 2. A reader turns that prep into format 3
// in memory, so such a release still records, asks, re-ships and tags with no step by hand (decision 11 of
// project 387). The stored text is never rewritten: the digest the cut commit pins stays the digest of what
// was stored. This file can go when no open release PR and no re-ship can hold a format-2 prep.

const { isBeforeYouUpdate } = require('./lint-prep');

const isObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// The label each format-2 group becomes. A name not here is kept as it is, for the lint to refuse.
const GROUP_LABEL = {
  Added: "What's new",
  Changed: 'Improvements',
  Fixed: 'Bug fixes',
  Removed: "What's new",
  Security: 'Security',
  Internal: 'Internal',
};

// The kind of a format-2 section, from its heading.
function kindOfHeading(heading) {
  const h = String(heading ?? '');
  if (isBeforeYouUpdate(h)) return 'Before you upgrade';
  if (/secur/i.test(h)) return 'Security';
  if (/fix/i.test(h)) return 'Bug fixes';
  if (/requir/i.test(h)) return 'Requirements';
  if (/new|add/i.test(h)) return "What's new";
  return 'Improvements';
}

function upgradeGroups(groups) {
  if (!isObject(groups)) return groups;
  const out = {};
  for (const [key, list] of Object.entries(groups)) {
    const label = Object.hasOwn(GROUP_LABEL, key) ? GROUP_LABEL[key] : key;
    // Two groups that map to one label merge their lists, in the file's order.
    out[label] = Array.isArray(list) && Array.isArray(out[label]) ? [...out[label], ...list] : (Array.isArray(list) ? [...list] : list);
  }
  return out;
}

function upgradeNotes(notes) {
  if (!isObject(notes) || !Array.isArray(notes.sections)) return notes;
  const items = [];
  for (const section of notes.sections) {
    if (!isObject(section) || !Array.isArray(section.items)) continue;
    const kind = kindOfHeading(section.heading);
    for (const item of section.items) {
      if (!isObject(item)) continue;
      const next = { kind };
      if (item.name !== undefined) next.name = item.name;
      next.text = item.text;
      next.covers = Array.isArray(item.covers) ? [...item.covers] : item.covers;
      items.push(next);
    }
  }
  return { title: notes.title, summary: notes.summary, items };
}

/**
 * A format-2 prep as format 3, a new object (the input is never changed). Anything else, a format-1 or
 * format-3 prep, a light release's, null, comes back as it is.
 */
function upgradePrep(prep) {
  if (!isObject(prep) || prep.format !== 2) return prep;
  const out = JSON.parse(JSON.stringify(prep));
  out.format = 3;
  if ('groups' in out) out.groups = upgradeGroups(out.groups);
  if ('notes' in out) out.notes = upgradeNotes(out.notes);
  return out;
}

module.exports = { upgradePrep, GROUP_LABEL, kindOfHeading };
