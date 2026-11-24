'use strict';

// Whether a repo's releases are announced: the router runs it for a repo holding `shipyard.yml`, and for a repo still
// on `release.json` it is a `uses:` of the published announce.yml in one of its workflow files at a commit. The release PR's page says what a merge sets off, and Announce is one of the steps only for a
// repo that calls it. Reads git only: a workflow file is text here, never run.

const { workflowTexts } = require('./workflow-texts');
const { ReleaseError } = require('./release-git');
const { loadReaderConfigAt } = require('./reader-config');
const { YAML_FILE } = require('./repo-config');
const { routedRepo } = require('./routed');

// A step's own line, never a comment: `uses: turbot/shipyard-workflows/.github/workflows/announce.yml@v0`.
const CALLS_ANNOUNCE = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?turbot\/shipyard-workflows\/\.github\/workflows\/announce\.yml@/m;

// How the announcement is wired at `rev`: `router` for a repo with `.github/shipyard.yml` (the router runs it after
// every tag, whether Shipyard or the repo's own workflow made it, so no caller of the repo is looked for and none is
// ever owned), `callers` when a workflow file of a repo still on `release.json` calls announce.yml, null otherwise.
function announceWiring(dir, rev) {
  if (routedRepo(dir, rev)) return 'router';
  return workflowTexts(dir, rev).some((text) => CALLS_ANNOUNCE.test(text)) ? 'callers' : null;
}

// True when the announcement runs for the repo at `rev`. A commit with no workflows, or one that cannot be
// read, is false: the page then leaves the Announce line out rather than promise it.
function announceCalled(dir, rev) {
  return announceWiring(dir, rev) !== null;
}

// The repo the product's changelog page goes to: `announce.page.repo` of the repo's config at `rev` (`.github/shipyard.yml`,
// else `.github/release.json`), or null for a repo with no page (and for a file that is missing, unreadable or has no repo
// named as plain owner/name: the flow then keeps to the #releases line it had, never a name it cannot show as it is). A product with a page gets no #releases line.
// With `repo` (the product's `<owner>/<name>`), a repo on shipyard.yml gets a page only under the product's own site,
// `<owner>/<name>.io` (lib/resolve.js), as the settings allow no other: the record promises no page it cannot open.
function announcePage(dir, rev, repo) {
  let loaded;
  try {
    loaded = loadReaderConfigAt({ dir, rev }, { warn: () => {} });
  } catch (e) {
    if (e instanceof ReleaseError) return null;
    throw e;
  }
  const config = loaded.config;
  const page = config && typeof config === 'object' && config.announce && typeof config.announce === 'object' ? config.announce.page : null;
  const pageRepo = page && typeof page === 'object' ? page.repo : null;
  if (typeof pageRepo !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(pageRepo)) return null;
  if (loaded.file === YAML_FILE && typeof repo === 'string' && repo.includes('/')) {
    const [owner, name] = repo.split('/');
    if (pageRepo.toLowerCase() !== `${owner}/${name}.io`.toLowerCase()) return null;
  }
  return pageRepo;
}

module.exports = { announceCalled, announceWiring, announcePage, CALLS_ANNOUNCE };
