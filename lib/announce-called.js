'use strict';

// Whether a repo calls Shipyard's announce workflow: a `uses:` of the published announce.yml in one of its workflow
// files at a commit. The release PR's page says what a merge sets off, and Announce is one of the steps only for a
// repo that calls it. Reads git only: a workflow file is text here, never run.

const { workflowTexts } = require('./workflow-texts');

// A step's own line, never a comment: `uses: turbot/shipyard-workflows/.github/workflows/announce.yml@v0`.
const CALLS_ANNOUNCE = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?turbot\/shipyard-workflows\/\.github\/workflows\/announce\.yml@/m;

// True when a workflow file of the repo at `rev` calls announce.yml. A commit with no workflows, or one that cannot be
// read, is false: the page then leaves the Announce line out rather than promise it.
function announceCalled(dir, rev) {
  return workflowTexts(dir, rev).some((text) => CALLS_ANNOUNCE.test(text));
}

module.exports = { announceCalled, CALLS_ANNOUNCE };
