'use strict';

// The accounts Shipyard trusts to open a release PR, and to have written the comments and issues a job counts as its own:
// the fleet's GitHub Apps and the Actions bot, each by its user ID. A login changes when an App is renamed, and a freed
// login can be taken by another App; an account's ID never changes and is never reused. So an account is trusted only by
// its ID, and the logins below are for messages, and for mapping a login a caller names to its account.
//
// This is the one list of those IDs. The workflows cannot read this file, so `workflows/router.yml` and the canonical
// `shipyard-release.yml` write the same IDs in their allow-list `if:` (`github.actor_id`, `ACTOR_IDS`), and
// test/openers-workflows.test.js holds every copy to this list.
//
//   const openers = openersOf({ ids: [123], logins: ['old-bot[bot]'] });   // exactly what a caller names, or the built-in IDs
//   isOpener(pr.user, openers);   // true for an author whose ID is one of them, or whose login a caller named
//
// A repo on `.github/shipyard.yml` trusts the built-in accounts alone, whatever its caller passes. A caller on
// `.github/release.json` (or with no file) that names accounts trusts exactly those: by ID with `--automation-ids`, or by
// login with `--automation-logins`, kept so callers that pass it keep working. A repo names only the fleet's bot so that no
// other workflow's job token counts as its release automation: `--automation-logins turbot-agent-fleet[bot]` trusts the
// fleet's App (by its ID) and not `github-actions[bot]`. A caller that names none trusts the built-in accounts. A login that
// one of the built-in accounts has had is never trusted by its text, only as that account's ID: once an App is renamed,
// whoever takes its old login is not the fleet.
//
// The Actions bot is also the job token's own account, apart from opening release PRs: `ACTIONS_BOT_ID` is trusted for the
// job's own markers (`ownAccounts`, lib/announce.js) and in the workflows' allow-list, whoever a caller names. Once every release
// it opened the old way has drained, it comes off `ACCOUNTS` as an opener (turbot/shipyard#563), and `ACTOR_IDS` keeps it in
// the allow-list.

const { ReleaseError } = require('./release-git');

const ACCOUNTS = Object.freeze([
  Object.freeze({ id: 340042353, logins: Object.freeze(['turbot-agent-fleet[bot]', 'turbot-fleet[bot]']) }),
  Object.freeze({ id: 340045443, logins: Object.freeze(['turbotio-agent-fleet[bot]', 'turbotio-fleet[bot]']) }),
  Object.freeze({ id: 41898282, logins: Object.freeze(['github-actions[bot]']) }),
]);
// The IDs, in the order above.
const OPENER_IDS = Object.freeze(ACCOUNTS.map((a) => a.id));
// The job token's account: its comments and issues are the job's own, and its dispatches pass the allow-list, whoever opens
// release PRs.
const ACTIONS_BOT_ID = 41898282;
// The IDs the workflows' allow-list `if:` names: the openers and the job token's account, in that order.
const ACTOR_IDS = Object.freeze([...new Set([...OPENER_IDS, ACTIONS_BOT_ID])]);
// Every login a built-in account has had, lower case, to the account's ID: never trusted by its text.
const BUILT_IN_LOGINS = new Map(ACCOUNTS.flatMap((a) => a.logins.map((l) => [l.toLowerCase(), a.id])));
// An account as a person reads it: a built-in one by its first login and its ID, another by its ID.
const nameOf = (id) => {
  const a = ACCOUNTS.find((x) => x.id === id);
  return a ? `${a.logins[0]} (${a.id})` : `user ${id}`;
};
const BUILT_IN_NAMES = OPENER_IDS.map(nameOf);

const ID = /^[1-9][0-9]{0,15}$/;
const oneLine = (s, max = 60) => {
  const t = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const textsOf = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((s) => String(s).trim()).filter(Boolean);

/**
 * User IDs from a comma-separated text (or a list): each a positive whole number, as GitHub gives `user.id`.
 * @param {string|Array<string|number>|undefined|null} value
 * @param {string} [flag]  the flag or input it came from, for the error
 * @returns {number[]}
 * @throws {ReleaseError} for an entry that is not an ID
 */
function parseIds(value, flag = '--automation-ids') {
  const ids = [];
  for (const t of textsOf(value)) {
    if (!ID.test(t) || !Number.isSafeInteger(Number(t))) throw new ReleaseError(`${flag} ${JSON.stringify(oneLine(t))} is not a user ID: give each account's numeric ID (GitHub's user.id), comma-separated`);
    ids.push(Number(t));
  }
  return ids;
}

/**
 * The accounts trusted to open a release PR. When the caller names any (`ids` or `logins`), exactly those: a login that a
 * built-in account has had, old or new, is that account's ID and never its text, and any other login is kept as named. When
 * the caller names none, the built-in accounts.
 * @param {{ids?: Array<number|string>|string, logins?: string[]|string}} [given]
 * @returns {{ids: number[], logins: string[]}}  logins in lower case
 */
function openersOf({ ids = [], logins = [] } = {}) {
  const parsed = parseIds(ids);
  const texts = textsOf(logins);
  if (!parsed.length && !texts.length) return { ids: [...OPENER_IDS], logins: [] };
  const all = new Set(parsed);
  const names = new Set();
  for (const l of texts) {
    const key = l.toLowerCase();
    if (BUILT_IN_LOGINS.has(key)) all.add(BUILT_IN_LOGINS.get(key));
    else names.add(key);
  }
  return { ids: [...all], logins: [...names] };
}

/**
 * The accounts whose comments and issues count as a job's own: the openers, and the job token's account (the Actions bot)
 * whoever the openers are, as the job posts with that token.
 * @param {{ids: number[], logins: string[]}} openers
 * @returns {{ids: number[], logins: string[]}}
 */
function ownAccounts(openers) {
  return { ids: [...new Set([...openers.ids, ACTIONS_BOT_ID])], logins: [...openers.logins] };
}

/**
 * Whether `user` (as GitHub gives it: `id`, `login`) is one of `openers`: its ID is one of theirs, or its login is one a
 * caller named.
 * @param {{id?: number|string, login?: string}|null|undefined} user
 * @param {{ids: number[], logins: string[]}} openers
 */
function isOpener(user, openers) {
  if (!user || typeof user !== 'object') return false;
  const id = ID.test(String(user.id ?? '')) ? Number(user.id) : null;
  if (id !== null && openers.ids.includes(id)) return true;
  return Boolean(user.login) && openers.logins.includes(String(user.login).toLowerCase());
}

/**
 * The openers as a person reads them, for a message: each ID (a built-in account by its login and ID), then each login.
 * @param {{ids: number[], logins: string[]}} openers
 */
function openerNames(openers) {
  return [...openers.ids.map(nameOf), ...openers.logins].join(', ');
}

/**
 * The openers a reader uses. On `.github/shipyard.yml` (`settings` given) they are the built-in accounts alone: what the
 * caller still gives is not used, and one warning names each flag that adds an account. On `.github/release.json` or no
 * file, exactly the accounts the caller names, or the built-in accounts when it names none (`openersOf`).
 * @param {{settings: object|null, logins?: string[]|string, ids?: Array<number|string>|string, warn?: (line: string) => void}} o
 * @returns {{ids: number[], logins: string[]}}
 */
function openersFor({
  settings, logins = [], ids = [], warn = (line) => process.stderr.write(`${line}\n`),
}) {
  const given = openersOf({ ids, logins });
  if (!settings) return given;
  const extraIds = given.ids.filter((id) => !OPENER_IDS.includes(id));
  const said = (flag, what) => warn(oneLine(`${flag} is ignored: this repo is on .github/shipyard.yml, so the release PR openers are ${BUILT_IN_NAMES.join(', ')}, by ID, not ${what.join(', ')}.`, 400));
  if (given.logins.length) said('--automation-logins', given.logins);
  if (extraIds.length) said('--automation-ids', extraIds.map(String));
  return openersOf();
}

module.exports = {
  ACCOUNTS, OPENER_IDS, ACTIONS_BOT_ID, ACTOR_IDS, BUILT_IN_LOGINS, parseIds, openersOf, ownAccounts, isOpener, openerNames, openersFor,
};
