'use strict';

// Who drove a change: its human author, its issues' authors, and whoever armed it (put the
// arming label on the PR or on an issue). Read from GitHub by `record`, `release-check` and `ask`.

const { GitHubError } = require('./github');

const BOT = (user) => !user || user.type === 'Bot' || /\[bot\]$/i.test(user.login || '');

// Lowercase logins of the people who drove a change. An issue is a number in `repo`, or
// `{ repo, number }` for one GitHub links from another repo.
async function driversOf({ github, repo, pr, issues, armedLabel }) {
  const drivers = new Set();
  const add = (user) => {
    if (user && user.login && !BOT(user)) drivers.add(user.login.toLowerCase());
  };
  if (pr.author) drivers.add(String(pr.author).toLowerCase());
  const refs = new Map();
  for (const i of issues) {
    const ref = typeof i === 'object' && i ? { repo: i.repo, number: i.number } : { repo, number: i };
    refs.set(`${ref.repo.toLowerCase()}#${ref.number}`, ref);
  }
  const owned = [{ repo, number: pr.number }, ...refs.values()];
  // `Refs #N` may name a discussion, a deleted issue or a typo: GitHub answers 404 or 410, and
  // there is nobody to count. Any other failure stops the record, since the list may be short.
  const unlessGone = async (read, none) => {
    try {
      return await read();
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 410)) return none;
      throw e;
    }
  };
  for (const i of refs.values()) {
    const issue = await unlessGone(() => github.getIssue(i.repo, i.number), null);
    if (issue && issue.user) add(issue.user);
  }
  for (const i of owned) {
    for (const e of await unlessGone(() => github.listIssueEvents(i.repo, i.number), [])) {
      if (e && e.event === 'labeled' && e.label && e.label.name === armedLabel) add(e.actor);
    }
  }
  return drivers;
}

module.exports = { BOT, driversOf };
