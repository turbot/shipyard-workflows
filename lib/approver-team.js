'use strict';

// Whether a comment's author is an area approver: an active member of the area's approver team (`<org>/<team>`, the resolved
// settings' `approversTeam`). One rule for every command that asks it: the release check's `/level` (lib/release-check.js) and
// `/prepare-again` (lib/prepare-again-command.js). The team is read with a token that can read the org (`SHIPYARD_ORG_TOKEN`,
// else the job's own), through `teamMembership`, which answers null for a login that is not in the team. A comment with no
// author, from a bot account or from one of the fleet's logins is not from a person, and is never looked up.

const { isFleet } = require('./record');

/**
 * @param {object} o
 * @param {{teamMembership: (org: string, team: string, login: string) => Promise<string|null>}} o.orgGithub  a client that can read the team
 * @param {string|null} o.team         the approver team, `<org>/<team>`; empty or null when none is set
 * @param {{login?: string, type?: string}|null} o.user  the comment's author, as GitHub gives it
 * @param {string[]} [o.fleetLogins]   logins that are never a person, beside every bot account
 * @param {Map<string, string|null>} [o.membership]  a cache of each login's membership (lower-case login -> state), filled as read
 * @returns {Promise<{accepted: boolean, why: string|undefined}>} `why` says, in the release check's words, why it is not accepted
 */
async function approverCheck({
  orgGithub, team, user, fleetLogins = [], membership = null,
}) {
  const login = user && user.login;
  if (!team) return { accepted: false, why: 'cannot be checked: no approver team is set' };
  if (!login || isFleet(user, new Set(fleetLogins.map((l) => String(l).toLowerCase())))) return { accepted: false, why: 'is not from a person' };
  const key = login.toLowerCase();
  let state;
  if (membership && membership.has(key)) {
    state = membership.get(key);
  } else {
    const [org, slug] = String(team).split('/');
    state = await orgGithub.teamMembership(org, slug, login);
    if (membership) membership.set(key, state);
  }
  if (state === 'active') return { accepted: true, why: undefined };
  return { accepted: false, why: `is from ${login}, who is not in ${team}` };
}

module.exports = { approverCheck };
