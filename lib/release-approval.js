'use strict';

// The approval a release PR needs, kept in one place: `shipyard ask` stops asking once a release
// PR has it, and the release check's "every change has an approval from a person who did not
// drive it" (S4, check 9) is to read it from here rather than keep a second copy.
//
// An approval of the release PR counts when it is a person's (the fleet's reviews never count),
// given at the PR's current head, by a listed approver (a login in the `SHIPYARD_APPROVERS` map). It covers every change
// its approver did not drive. The release PR has the approval it needs when at least one approval
// counts and every change that still needs an independent approval is covered.

const { lastReviews, isFleet } = require('./record');

const key = (login) => String(login || '').toLowerCase();

/**
 * @param {object} i
 * @param {object[]} i.releaseReviews  the release PR's reviews, as the API lists them
 * @param {string} i.head              the release PR's head commit
 * @param {Set<string>} i.fleetLogins  lowercase logins whose reviews never count (bots never count either)
 * @param {Set<string>} i.approvers  lowercase logins of the listed approvers (the list is what says whose approval counts)
 * @param {{ ref: string, drivers: Set<string> }[]} i.needing  each change that still needs an
 *   independent approval and the lowercase logins that drove it (a commit with no PR: an empty set)
 * @returns {{ state: 'pass' | 'waiting', by: string[], uncovered: string[], notCounted: { login: string, why: string, unlisted?: true }[] }}
 */
function releaseApproval({ releaseReviews, head, fleetLogins, approvers, needing }) {
  const by = [];
  const notCounted = [];
  for (const r of lastReviews(releaseReviews || []).values()) {
    if (r.state !== 'APPROVED') continue;
    if (isFleet(r.user, fleetLogins)) notCounted.push({ login: r.login, why: 'the fleet\'s reviews never count' });
    else if (r.commit !== head) notCounted.push({ login: r.login, why: 'it approved an earlier commit' });
    else if (!approvers.has(key(r.login))) notCounted.push({ login: r.login, why: 'not in the approver list', unlisted: true });
    else by.push(r.login);
  }
  const uncovered = needing.filter((c) => !by.some((login) => !c.drivers.has(key(login)))).map((c) => c.ref);
  return { state: by.length && !uncovered.length ? 'pass' : 'waiting', by, uncovered, notCounted };
}

module.exports = { releaseApproval };
