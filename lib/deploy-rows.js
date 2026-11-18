'use strict';

// The rows of the release PR's decision table that only some repos need, each there only when it applies:
//
//   During the deploy   what customers notice while the release goes out       (`report.duringDeploy`)
//   A person's step     a step after the merge that a named person runs        (`report.personSteps`)
//
// Pure: no network and no files. The words come from the prep file; the names of people come from GitHub's profiles
// (`names`, a map of lowercase login to profile name).

const { clean } = require('./clean');
const { Refusal } = require('./release-git');

const ICON = { 'to do': '⏳', agreed: '✅' };
const DEPLOY_ICON = '⚠';
const STATES = Object.keys(ICON);
// What the lint counts for a person's name before GitHub has been asked: two words, a first name and a last.
const NAME_STAND_IN = 'Firstname Lastname';
// A GitHub login: letters, digits and single hyphens, 39 characters at most.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

const oneLine = (text) => String(text).trim().replace(/\s+/g, ' ');
const phrase = (text) => oneLine(text).replace(/(?<!\.)\.$/, '');

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A person as the page names them: their profile name, else their login. Never an @mention: a login is written
// without its `@`, and an `@` inside a profile name is written out.
function personName(login, names) {
  const key = String(login).replace(/^@/, '');
  const named = names && names.get(key.toLowerCase());
  return clean(named || key, 60).replace(/@/g, '&#64;');
}

/**
 * The During the deploy and A person's step rows for a prep file's report, as `[key, value]` pairs of the decision
 * table, in that order; none for a report that sets neither. A person's step has a row each. `lint` counts the rows
 * with a person's name of two words, which GitHub has not been asked for.
 */
function deployRows({ report, names = null, lint = false }) {
  const rows = [];
  if (!isObject(report)) return rows;
  if (typeof report.duringDeploy === 'string' && report.duringDeploy.trim()) {
    rows.push(['During the deploy', `${DEPLOY_ICON} ${phrase(report.duringDeploy)}`]);
  }
  for (const s of Array.isArray(report.personSteps) ? report.personSteps : []) {
    if (!isObject(s) || typeof s.who !== 'string' || typeof s.step !== 'string' || !s.step.trim() || !Object.hasOwn(ICON, s.state)) continue;
    const who = lint ? NAME_STAND_IN : personName(s.who, names);
    rows.push(["A person's step", `${ICON[s.state]} ${who} ${phrase(s.step)}`]);
  }
  return rows;
}

// The logins of a prep file's person steps, once each, for the names the page asks GitHub for.
function personStepLogins(report) {
  const out = new Set();
  for (const s of isObject(report) && Array.isArray(report.personSteps) ? report.personSteps : []) {
    if (isObject(s) && typeof s.who === 'string' && LOGIN.test(s.who)) out.add(s.who.toLowerCase());
  }
  return [...out].sort();
}

// The profile names of a prep file's person steps, as GitHub has them: a map of lowercase login to name. A person with no
// name (or no such login, which GitHub answers the same way) is left out: with `refuse`, that is a Refusal naming each
// login, so a page is never opened with a login, or a mistyped one, as the person who owns a step; without it the page
// shows the login, as it does for any other person, and `warn` is told. A failed call fails the caller.
async function personNamesOf({
  github, report, warn = () => {}, refuse = false,
}) {
  const names = new Map();
  const missing = [];
  for (const login of personStepLogins(report)) {
    const name = await github.getUserName(login);
    if (name) names.set(login, String(name).replace(/\s+/g, ' ').trim().slice(0, 200));
    else missing.push(login);
  }
  if (missing.length && refuse) {
    throw new Refusal(`report.personSteps names ${missing.length === 1 ? 'a login' : 'logins'} with no profile name on GitHub (${missing.join(', ')}): check the login, or ask the person to set a name on their profile, and prepare the release again`);
  }
  for (const login of missing) warn(`${login} has a step on the page and no profile name on GitHub (or no such login), so the page shows the login: check the login, or ask them to set a name`);
  return names;
}

module.exports = {
  ICON, STATES, LOGIN, DEPLOY_ICON, deployRows, personStepLogins, personNamesOf, personName,
};
