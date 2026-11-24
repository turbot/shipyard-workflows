'use strict';

// Whether a repo at a commit runs its release through Shipyard's router (`.github/shipyard.yml`) and which flows it
// keeps for its own files (`own`). A moved repo has no `uses:` line for the flows the router runs, so a scan of its
// workflow files for them would call it unwired; the scanners (announce-called.js, tag-signal.js, pin.js) ask this
// first and read the callers only for a repo that is not routed, or for a flow it owns. Reads git only.

const { loadRepoConfigAt, YAML_FILE } = require('./repo-config');
const { ReleaseError } = require('./release-git');
const { workflowTexts } = require('./workflow-texts');
const { ownedByWorkflows } = require('./route');

// The router is in charge of a repo only through its `shipyard.yml`. A repo on `release.json` alone, a commit that
// cannot be read, and a `shipyard.yml` that is not YAML at all (which has no `own` to read) are all "not routed":
// the scanners then read the callers as they always did, and never throw. The loader's own warnings are the readers'
// to print; saying them again from a scan would repeat them.
/**
 * @returns {{ kind: string|null, own: string[] } | null}
 */
function routedRepo(dir, rev) {
  let loaded;
  try {
    loaded = loadRepoConfigAt({ dir, rev }, { warn: () => {} });
  } catch (e) {
    if (e instanceof ReleaseError) return null; // RepoConfigError is one
    throw e;
  }
  if (loaded.file !== YAML_FILE) return null;
  const { kind, own } = loaded.config;
  return { kind: typeof kind === 'string' ? kind : null, own: Array.isArray(own) ? own : [] };
}

// Whether a routed repo runs `flow` in its own files: its `own` list names it, or a workflow of its own calls the
// published workflow that runs it (the same test the router's decision makes, lib/route.js), so a scanner never says
// the router runs a flow the router skips.
function ownsFlow(dir, rev, routed, flow) {
  return routed.own.includes(flow) || ownedByWorkflows(workflowTexts(dir, rev)).includes(flow);
}

module.exports = { routedRepo, ownsFlow };
