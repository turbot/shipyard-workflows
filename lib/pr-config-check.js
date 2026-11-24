'use strict';

// The strict check of a PR that changes `.github/shipyard.yml`. Every other reader of the file is lenient (an unknown key
// is a warning, so a stale key never stops a release); here it is an error, so a typo is caught where it is made.
//
// The PR's copy is read through the API as data, at the head commit, and parsed by the one validator (lib/config.js).
// It is never checked out and never run. A PR that does not change the file is not checked and the file is not read.
// A PR that removes the file (or renames it away) fails, and so does one that leaves no `kind`.

const { parseConfig, FILE } = require('./config');
const { CheckError } = require('./changelog-line');

const RULE = 'config';
const problem = (message) => ({ rule: RULE, message });

// Each message names the key and the fix; one that does not already say which file it is about gets the file's name,
// since it stands alone in a commit status.
const aboutFile = (message) => (message.includes('shipyard.yml') ? message : `shipyard.yml: ${message}`);

const REMOVED = `${FILE} is removed by this PR. A repo keeps it, starting with "kind:": put it back.`;

// Where the PR's head commit is read: its own repo (a fork's), else the base repo, which holds the commit of a PR.
const headRepoOf = (pr, repo) => (pr.head && pr.head.repo && typeof pr.head.repo.full_name === 'string' ? pr.head.repo.full_name : repo);

// What the PR does to the file, from the PR's list of changed files: 'removed', 'changed' or null. A list GitHub cut
// short (3000 files) that does not name the file cannot say: the file's text where the PR left the base and on the head is compared.
async function whatChanged({ github, repo, pr, listing }) {
  const entries = listing.files.filter((f) => f && (f.filename === FILE || f.previous_filename === FILE));
  for (const f of entries) {
    if (f.filename !== FILE || f.status === 'removed') return { change: 'removed' };
  }
  if (entries.length) return { change: 'changed' };
  if (!listing.truncated) return { change: null };

  if (!pr.head.sha) throw new CheckError(`Cannot tell whether the PR changes ${FILE}: its file list is cut short and the PR has no head sha`);
  // Against where the PR left the base, never the base's tip now: a base that has since changed the file is not the PR's change.
  const mergeBase = await github.mergeBase(repo, (pr.base && (pr.base.sha || pr.base.ref)) || '', pr.head.sha);
  if (!mergeBase) throw new CheckError(`Cannot tell whether the PR changes ${FILE}: its file list is cut short and GitHub cannot compare it with its base`);
  const [before, after] = await Promise.all([
    github.getFileText(repo, FILE, mergeBase),
    github.getFileText(headRepoOf(pr, repo), FILE, pr.head.sha),
  ]);
  if (before === after) return { change: null };
  return after === null ? { change: 'removed' } : { change: 'changed', text: after };
}

/**
 * The problems of a PR's change to `.github/shipyard.yml`, or an empty list when it does not change it.
 * @param {{github: object, repo: string, pr: object, listing: {files: object[], truncated: boolean}}} args
 *   `pr` is the live PR (`head.sha` and `head.repo` say where its copy is); `listing` is `github.listPullFiles`'s answer
 * @returns {Promise<{rule: string, message: string}[]>}  each problem as the check reports it (`rule: 'config'`)
 */
async function prConfigProblems({ github, repo, pr, listing }) {
  const headSha = pr.head && pr.head.sha;
  const { change, text: known } = await whatChanged({
    github, repo, pr: { ...pr, head: { ...pr.head, sha: headSha } }, listing,
  });
  if (change === null) return [];
  if (change === 'removed') return [problem(REMOVED)];

  if (!headSha) throw new CheckError(`Cannot read ${FILE} on the PR: it has no head sha`);
  const text = known !== undefined ? known : await github.getFileText(headRepoOf(pr, repo), FILE, headSha);
  // The list says the PR changed the file, so a head that has none is GitHub disagreeing with itself: not a pass.
  if (text === null) throw new CheckError(`${FILE} is changed by this PR but cannot be read at its head ${headSha.slice(0, 7)}`);
  return parseConfig(text, { strict: true }).errors.map((m) => problem(aboutFile(m)));
}

module.exports = { prConfigProblems, REMOVED };
