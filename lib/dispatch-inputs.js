'use strict';

// The inputs of a `workflow_dispatch` that starts one of Shipyard's flows, by the workflow it starts.
//
// `shipyard-release.yml`, the one fixed release file of a repo, takes two inputs and no others: `action`, one of the actions
// `lib/route.js` runs (ACTIONS), and `args`, one JSON string holding an object (the PR number, the comment, a prep file name)
// that the router parses. A caller written before it takes the flow's own inputs (`pr`, `comment`).
//
// GitHub refuses a dispatch that carries an input the workflow does not declare (422, "Unexpected inputs provided"), so one
// dispatch cannot carry both sets: the target decides. A dispatch of `shipyard-release.yml` sends `action` and `args`; a
// dispatch of any other workflow sends the old inputs, exactly as before, for as long as callers that read them exist.
//
// The numbers go into `args` as JSON numbers (`{"pr":12,"comment":345}`), the form `shipyard route --args` documents.

const { ACTIONS } = require('./route');

const ROUTER_WORKFLOW = 'shipyard-release.yml';

/**
 * @param {string} workflow  the file name of the workflow about to be started (`ask.yml`, `shipyard-release.yml`)
 * @param {string} action    the router's action for the flow (a key of ACTIONS)
 * @param {Record<string, number>} args  the flow's arguments, whole numbers (`pr`, `comment`)
 * @param {Record<string, string>} legacy  the inputs a caller written before the release file reads, as strings
 * @returns {Record<string, string>} the `inputs` of the dispatch
 */
function dispatchInputs(workflow, action, args, legacy) {
  if (!Object.hasOwn(ACTIONS, action)) throw new TypeError(`${JSON.stringify(action)} is not an action of the router (${Object.keys(ACTIONS).join(', ')})`);
  for (const [name, value] of Object.entries(args)) {
    if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`args.${name} must be a positive whole number, not ${JSON.stringify(value)}`);
  }
  if (workflow === ROUTER_WORKFLOW) return { action, args: JSON.stringify(args) };
  return { ...legacy };
}

module.exports = { dispatchInputs, ROUTER_WORKFLOW };
