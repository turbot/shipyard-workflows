'use strict';

// The release areas file: one start time per area and one weekly day for the area's weekly
// repos, read from `org/areas.yml` in turbot/shipyard. The central schedule reads it (through
// the API, at the default branch); a repo of an area that is already listed needs no edit here.
//
//   areas:
//     <area>:
//       start: "09:00"        # HH:MM, UTC
//       weeklyDay: tuesday    # the day a `weekly` repo of the area starts; lower case
//
// An invalid value is an error. An unknown key (top level or inside an area) is a warning, never
// a failure, as in every Shipyard reader. The file holds no trust value: an area's approvers team
// and release App come from the naming rule below, not from the file.

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('../vendor/yaml');

class AreasError extends Error {}

const FILE = path.join(__dirname, '..', 'org', 'areas.yml');
const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
// A lower-case word: letters and digits, with single hyphens inside, starting with a letter.
const AREA = /^[a-z](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/;
const AREA_KEYS = new Set(['start', 'weeklyDay']);
const TOP_KEYS = new Set(['areas']);

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));

/**
 * Check a parsed areas document.
 *
 * @param {unknown} doc the parsed YAML
 * @returns {{areas: Record<string, {start: string, weeklyDay: string}>, errors: string[], warnings: string[]}}
 *   `areas` holds only the areas that are valid
 */
function validateAreas(doc) {
  const errors = [];
  const warnings = [];
  const areas = {};
  if (!isObject(doc)) {
    return { areas, errors: ['areas.yml must be a map with one key, `areas`'], warnings };
  }
  for (const key of Object.keys(doc)) {
    if (!TOP_KEYS.has(key)) warnings.push(`areas.yml: unknown key "${key}" is ignored (the only key is "areas")`);
  }
  if (!isObject(doc.areas) || !Object.keys(doc.areas).length) {
    errors.push('areas.yml: `areas` must be a map with at least one area');
    return { areas, errors, warnings };
  }
  for (const [name, value] of Object.entries(doc.areas)) {
    const where = `area ${show(name)}`;
    const before = errors.length;
    if (!AREA.test(name)) errors.push(`${where}: an area name is a lower-case word (letters, digits and single hyphens, starting with a letter)`);
    if (!isObject(value)) {
      errors.push(`${where}: must be a map with \`start\` and \`weeklyDay\``);
      continue;
    }
    for (const key of Object.keys(value)) {
      if (!AREA_KEYS.has(key)) warnings.push(`${where}: unknown key "${key}" is ignored (keys: ${[...AREA_KEYS].join(', ')})`);
    }
    if (typeof value.start !== 'string' || !TIME.test(value.start)) {
      errors.push(`${where}: start must be a time of day as "HH:MM" in UTC, quoted (got ${show(value.start)})`);
    }
    if (typeof value.weeklyDay !== 'string' || !WEEKDAYS.includes(value.weeklyDay)) {
      errors.push(`${where}: weeklyDay must be a lower-case weekday name, one of ${WEEKDAYS.join(', ')} (got ${show(value.weeklyDay)})`);
    }
    if (errors.length === before) areas[name] = { start: value.start, weeklyDay: value.weeklyDay };
  }
  return { areas, errors, warnings };
}

/**
 * Read the text of an areas file. Throws an AreasError naming every problem when any value is
 * invalid; unknown keys come back as warnings.
 *
 * @param {string} text
 * @returns {{areas: Record<string, {start: string, weeklyDay: string}>, warnings: string[]}}
 */
function parseAreas(text) {
  let doc;
  try {
    doc = YAML.parse(String(text));
  } catch (e) {
    throw new AreasError(`areas.yml is not valid YAML: ${String(e && e.message).split('\n')[0]}`);
  }
  const { areas, errors, warnings } = validateAreas(doc);
  if (errors.length) throw new AreasError(errors.join('\n'));
  return { areas, warnings };
}

/** Read and check an areas file (`org/areas.yml` of this repo unless a path is given). */
function readAreas(file = FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    throw new AreasError(`cannot read the areas file ${file}: ${e.code || e.message}`);
  }
  return parseAreas(text);
}

function checkArea(area) {
  if (typeof area !== 'string' || !AREA.test(area)) {
    throw new AreasError(`${show(area)} is not an area name: it is a lower-case word (letters, digits and single hyphens, starting with a letter)`);
  }
  return area;
}

/** The area's approvers team, by the naming rule. A name outside the rule throws. */
const approversTeamOf = (area) => `turbot/${checkArea(area)}-release-approvers`;

/** The area's release App, by the naming rule. A name outside the rule throws. */
const releaseAppOf = (area) => `turbot-${checkArea(area)}-release`;

module.exports = { AreasError, FILE, WEEKDAYS, TIME, validateAreas, parseAreas, readAreas, approversTeamOf, releaseAppOf };
