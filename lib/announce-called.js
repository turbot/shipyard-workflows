'use strict';

// Whether a repo calls Shipyard's announce workflow: a `uses:` of the published announce.yml in one of its workflow
// files at a commit. The release PR's page says what a merge sets off, and Announce is one of the steps only for a
// repo that calls it. Reads git only: a workflow file is text here, never run.

const { workflowTexts } = require('./workflow-texts');
const { git } = require('./release-git');

// A step's own line, never a comment: `uses: turbot/shipyard-workflows/.github/workflows/announce.yml@v0`.
const CALLS_ANNOUNCE = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?turbot\/shipyard-workflows\/\.github\/workflows\/announce\.yml@/m;

// True when a workflow file of the repo at `rev` calls announce.yml. A commit with no workflows, or one that cannot be
// read, is false: the page then leaves the Announce line out rather than promise it.
function announceCalled(dir, rev) {
  return workflowTexts(dir, rev).some((text) => CALLS_ANNOUNCE.test(text));
}

// The repo the product's changelog page goes to: `announce.page.repo` of `.github/release.json` at `rev`, or null for a
// repo with no page (and for a file that is missing, unreadable or has no repo
// named as plain owner/name: the flow then keeps to the #releases line it had, never a name it cannot show as it is). A product with a page gets no #releases line.
function announcePage(dir, rev) {
  const text = git(dir, ['show', `${rev}:.github/release.json`], { allowFail: true });
  if (!text) return null;
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return null;
  }
  const page = config && typeof config === 'object' && config.announce && typeof config.announce === 'object' ? config.announce.page : null;
  const repo = page && typeof page === 'object' ? page.repo : null;
  return typeof repo === 'string' && /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo) ? repo : null;
}

module.exports = { announceCalled, announcePage, CALLS_ANNOUNCE };
