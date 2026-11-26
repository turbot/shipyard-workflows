'use strict';

// Whether a repo the router releases can have its release gate started. The router's record job starts the gate by
// `workflow_dispatch` of `shipyard-release.yml` on `main` (workflows/router.yml, `gate-workflow:`), and GitHub answers a dispatch
// of a workflow its ref does not hold with a 404; the gate's `route` job then reads `.github/shipyard.yml` from that same commit. A repo's
// `main` holds both files only after its first router release merges, so a first cut would push `release/<version>` and then fail to
// start the gate. `shipyard facts`, the first step of both
// paths to a cut, asks here and stops before anything is cut.

const { FILE: YAML_FILE } = require('./config');
const { CANDIDATES } = require('./router-inputs');

// The fixed caller the router's record job names as its `gate-workflow:`. A test pins it equal to workflows/router.yml.
const ROUTER_GATE_WORKFLOW = 'shipyard-release.yml';
const WORKFLOWS = '.github/workflows';
const GATE_BRANCH = 'main';

// The gate workflow the router starts for this repo, or null when the check does not apply: the repo is not on
// `.github/shipyard.yml`, the router does not run its `record`, the repo's kind has no candidate build (the router then runs no
// record: lib/router-inputs.js `record-note`), or the repo's own workflow does (its record names its own gate).
// `settings` is the resolved config (`own`, `flows`, `kind`); `owned` is the flows the repo's own workflows run (`ownedByWorkflows`).
function routerGateWorkflow({ file, settings, owned } = {}) {
  if (file !== YAML_FILE) return null;
  if (!settings || !Array.isArray(settings.flows) || !settings.flows.includes('record')) return null;
  if (!Object.hasOwn(CANDIDATES, settings.kind)) return null;
  if (Array.isArray(settings.own) && settings.own.includes('record')) return null;
  if (owned && [...owned].includes('record')) return null;
  return ROUTER_GATE_WORKFLOW;
}

// The text of a refusal when `main` lacks a file the router's gate reads there, or null when it has both: the gate workflow
// `.github/workflows/<workflow>` and the config `.github/shipyard.yml`. The router's `route` job reads the config from the event's commit,
// which for a gate dispatched on `main` is `main`'s tip, so a `main` with the workflow and no config starts no gate either. One text names
// each file that is missing. A GitHub error that is not a 404 propagates. `nothing` is the sentence that says what was left unwritten.
async function gateMissingMessage({ github, repo, workflow, nothing = 'Nothing was written.' }) {
  const wanted = [`${WORKFLOWS}/${workflow}`, YAML_FILE];
  const missing = [];
  for (const path of wanted) {
    const text = await github.getFileText(repo, path, GATE_BRANCH);
    if (text === null || text === undefined) missing.push(path);
  }
  if (!missing.length) return null;
  const names = missing.map((p) => `\`${p}\``).join(' and ');
  return `${GATE_BRANCH} of ${repo} has no ${missing.join(' and no ')}, so the release gate could not start: the router starts the gate from ${wanted[0]} and reads ${YAML_FILE} on ${GATE_BRANCH}, and the release PR could never pass \`shipyard/release\`. ${nothing} Put ${names} on ${GATE_BRANCH} through a PR into ${GATE_BRANCH}, byte for byte the same as on the default branch (the canonical ${workflow} is the text in turbot/shipyard, docs/canonical/shipyard-release.yml), before the repo's release_area property is set (turbot/shipyard docs/release-gate.md, section "A repo's first release through the router"), then start a new prep job.`;
}

module.exports = { ROUTER_GATE_WORKFLOW, routerGateWorkflow, gateMissingMessage };
