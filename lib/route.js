'use strict';

// Which release flows run for an event: the decision the one fixed `shipyard-release.yml` makes from data. A pure
// function of the event, the dispatch's `action` and `args`, the branch and a repo's resolved settings
// (lib/resolve.js), so it is tested apart from the workflow that acts on it. It reads no file, no clock and no
// network. The table is the epic's:
//
//   dispatch `prep`                                   prep, then cut
//   PR into a release branch                          check, then record, then ask
//   review of such a PR                               check, then record, then ask
//   dispatch `record`                                 record, then ask
//   dispatch `check`                                  check (the release check, release-check.yml)
//   dispatch `gate`                                   gate (Shipyard's release gate)
//   push to a release branch                          ship by kind, then tag, merge-back, announce, afterShip
//   dispatch `shipped`, `reship`, `prerelease`,
//            `prerelease-files`, `ask`, `announce`    that flow
//
// A release branch is `main`, `main-<x>` or `main-<x.y>` (lib/release-git.js `lineOf`). A push or a PR on any other
// branch, an event or action that is not in the table, and a push of a tag run nothing, and say why.
//
// A flow the repo owns is never run. A repo owns a flow when its settings list it under `own` (the file's list over
// the kind's) or when a workflow of its own runs it (`ownedByWorkflows`). Only `cut`, `record`, `ship`, `tag` and
// `shipped` can be owned. The ask and the announcement never are: an owned `record` still returns `ask`, and an
// owned `tag` still returns `announce`, for the owned workflow ends by dispatching the action `ask` or `announce`
// (and a repo's own record that has not run yet is no harm: the ask posts nothing for a release PR with no record,
// and posts once for one that has it). A flow the repo's kind has no step for (a Go library has no `ship`) is
// skipped with that reason.

const { FLOWS } = require('./config');
const { lineOf } = require('./release-git');

class RouteError extends Error {}

const MAX_ARGS = 65536;

// What each dispatch action runs, in order.
const ACTIONS = Object.freeze({
  prep: ['prep', 'cut'],
  record: ['record', 'ask'],
  check: ['check'],
  gate: ['gate'],
  shipped: ['shipped'],
  reship: ['reship'],
  prerelease: ['prerelease'],
  // The build of a prerelease's files, run on the work branch by the `prerelease` run on `main` (docs/release-prerelease.md).
  'prerelease-files': ['prerelease-files'],
  ask: ['ask'],
  announce: ['announce'],
});
const PUSH = Object.freeze(['ship', 'tag', 'merge-back', 'announce', 'afterShip']);
const PULL_REQUEST = Object.freeze(['check', 'record', 'ask']);
// A review runs the check again, before the record: the release check does not pass a release PR until it is approved (rule 9), and only
// a run after the approval says otherwise. The record counts the check's status, so it comes after it.
const REVIEW = Object.freeze(['check', 'record', 'ask']);

// The published workflow that runs each ownable flow. A repo whose own file calls one of them runs that flow itself.
const FLOW_WORKFLOWS = Object.freeze({
  cut: 'cut.yml',
  record: 'record.yml',
  ship: 'go-cli-ship.yml',
  tag: 'tag.yml',
});
const PUBLISHED = 'turbot/shipyard-workflows/\\.github/workflows';

const oneLine = (s, max = 60) => {
  const t = String(s).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** True for `main`, `main-<x>` and `main-<x.y>`: the branches a release merges into (`lineOf`, which the tag and merge-back steps ask too). */
const isReleaseBranch = (name) => typeof name === 'string' && lineOf(name) !== null;

/**
 * The flows a repo runs in its own files, found from the texts of its workflow files: a step that `uses:` the
 * published workflow of a flow (a line of its own, never a comment).
 * @param {string[]} texts  the workflow files' texts
 * @returns {string[]} flows, in the order of the validator's list
 */
function ownedByWorkflows(texts) {
  const found = [];
  for (const [flow, file] of Object.entries(FLOW_WORKFLOWS)) {
    const re = new RegExp(`^[ \\t]*(?:-[ \\t]+)?uses:[ \\t]*["']?${PUBLISHED}/${file.replace('.', '\\.')}@`, 'm');
    for (const raw of texts) {
      const text = String(raw).replace(/^[ \t]*#.*$/gm, '').replace(/[ \t]+#.*$/gm, '');
      if (re.test(text)) {
        found.push(flow);
        break;
      }
    }
  }
  return FLOWS.filter((f) => found.includes(f));
}

// `args` of a dispatch: one JSON string holding an object (the PR number, the comment, a prep file name). Empty is none.
function parseArgs(args) {
  if (args === undefined || args === null || args === '') return {};
  if (typeof args !== 'string') throw new RouteError('args must be one JSON string holding an object');
  if (args.length > MAX_ARGS) throw new RouteError(`args is longer than ${MAX_ARGS} characters`);
  let parsed;
  try {
    parsed = JSON.parse(args);
  } catch {
    throw new RouteError('args is not valid JSON: it must be one JSON string holding an object, such as {"pr": 12}');
  }
  if (!isObject(parsed)) throw new RouteError('args must hold a JSON object, such as {"pr": 12}');
  return parsed;
}

// The branch a push is on: `refs/heads/<name>` (a bare name is read as a branch), or null for a tag.
function pushedBranch(ref) {
  if (typeof ref !== 'string' || !ref) throw new RouteError('a push needs its ref');
  if (ref.startsWith('refs/tags/')) return null;
  return ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
}

function notReleaseBranch(what, branch) {
  const b = oneLine(branch);
  if (/^main-/.test(branch)) return `${what} ${b}: not a release branch. A release branch is main, main-<x> or main-<x.y>, so nothing runs.`;
  return `${what} ${b}: not a release branch (main, main-<x> or main-<x.y>), so nothing runs.`;
}

/**
 * @param {object} input
 * @param {string} input.event    the event's name: `push`, `pull_request`, `pull_request_review` or `workflow_dispatch`
 * @param {string} [input.action] a dispatch's `action`
 * @param {string} [input.args]   a dispatch's `args`, one JSON string
 * @param {string} [input.ref]    a push's ref
 * @param {string} [input.base]   the base branch of a PR or a review
 * @param {{own?: string[], flows?: string[], afterShip?: string[]}} input.settings  `resolveConfig`'s `settings`
 * @param {string[]} [input.owned] flows a workflow of the repo's own runs (`ownedByWorkflows`)
 * @returns {{event: string, action?: string, branch?: string, args?: object, flows: string[], afterShip?: string[], skipped: {flow: string, why: string}[], message: string|null}}
 * @throws {RouteError}
 */
function route({ event, action, args, ref, base, settings, owned = [] } = {}) {
  if (typeof event !== 'string' || !event) throw new RouteError('the event is required');
  if (!isObject(settings) || !Array.isArray(settings.own) || !Array.isArray(settings.flows)) {
    throw new RouteError("the repo's resolved settings are required: resolve the config with resolveConfig first");
  }
  if (!Array.isArray(owned) || !owned.every((f) => FLOWS.includes(f))) throw new RouteError(`owned must list flows from ${FLOWS.join(', ')}`);

  const result = { event, flows: [], skipped: [], message: null };
  const none = (message) => ({ ...result, message });

  let sequence;
  let what;
  if (event === 'workflow_dispatch') {
    const parsed = parseArgs(args);
    if (typeof action !== 'string' || !action) return none('a dispatch with no action runs nothing: the action is one of ' + Object.keys(ACTIONS).join(', '));
    result.action = action;
    result.args = parsed;
    if (!Object.hasOwn(ACTIONS, action)) return none(`the action ${JSON.stringify(oneLine(action))} is not one Shipyard knows, so nothing runs. The actions are ${Object.keys(ACTIONS).join(', ')}.`);
    sequence = ACTIONS[action];
    what = `dispatch ${action}`;
  } else if (event === 'push') {
    const branch = pushedBranch(ref);
    if (branch === null) return none(`a push of a tag (${oneLine(ref)}) runs nothing.`);
    result.branch = branch;
    if (!isReleaseBranch(branch)) return none(notReleaseBranch('a push on', branch));
    sequence = PUSH;
    what = 'a push';
  } else if (event === 'pull_request' || event === 'pull_request_review') {
    if (typeof base !== 'string' || !base) throw new RouteError(`${event} needs its base branch`);
    result.branch = base;
    const label = event === 'pull_request' ? 'a PR' : 'a review';
    if (!isReleaseBranch(base)) return none(notReleaseBranch(`${label} into`, base));
    sequence = event === 'pull_request' ? PULL_REQUEST : REVIEW;
    what = label;
  } else {
    return none(`the event ${JSON.stringify(oneLine(event))} is not one the release file takes (push, pull_request, pull_request_review, workflow_dispatch), so nothing runs.`);
  }

  const own = new Set([...settings.own, ...owned]);
  const via = (flow) => (settings.own.includes(flow) ? "its kind's or the file's `own` list" : 'a workflow of its own runs it');
  for (const flow of sequence) {
    if (flow === 'afterShip') {
      if (Array.isArray(settings.afterShip) && settings.afterShip.length) {
        result.flows.push(flow);
        result.afterShip = [...settings.afterShip];
      }
      continue;
    }
    if (FLOWS.includes(flow)) {
      if (own.has(flow)) {
        result.skipped.push({ flow, why: `owned by the repo (${via(flow)})` });
        continue;
      }
      if (!settings.flows.includes(flow)) {
        result.skipped.push({ flow, why: 'the repo\'s kind has no such step' });
        continue;
      }
    }
    result.flows.push(flow);
  }
  if (!result.flows.length) {
    result.message = `${what} runs nothing for this repo: ${result.skipped.map((s) => `${s.flow} is skipped (${s.why})`).join('; ') || 'nothing in the table applies'}.`;
  }
  return result;
}

module.exports = {
  route, ownedByWorkflows, parseArgs, isReleaseBranch, RouteError, ACTIONS, FLOW_WORKFLOWS,
};
