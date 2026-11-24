'use strict';

// What a published workflow asks of the repos that call it: the permissions each job needs, the inputs
// it requires and the secrets it requires. `workflows/contract.json` records it, made from
// `workflows/*.yml` and nothing else, so a change to what callers must give is always a visible diff.
// A release that raises a need goes out below a new major only when its read-first flag is answered: the answer names every
// caller checked and what each grants (lib/lint-prep.js, docs/prep-file.md).
//
// The YAML is read by the vendored yaml package (vendor/yaml), Shipyard's one dependency. A file it cannot read, a tab-indented line or a
// key set twice included, is an error that names the file, and the line when it knows it: it never guesses what a caller must give.

const fs = require('node:fs');
const path = require('node:path');
const YAML = require('../vendor/yaml');
const { ReleaseError, git } = require('./release-git');

const FORMAT = 1;
const WORKFLOWS_DIR = 'workflows';
const CONTRACT_FILE = `${WORKFLOWS_DIR}/contract.json`;
const LEVELS = ['none', 'read', 'write'];
const rank = (level) => (level === undefined ? 0 : LEVELS.indexOf(level));

const isMap = (v) => v instanceof Map;

// A ReleaseError, so the steps that read the contract print it and exit 2 as they do any other.
class ContractError extends ReleaseError {}

// ---------------------------------------------------------------------------
// Reading YAML

/**
 * @param {string} text  a YAML file
 * @param {string} file  its name, for errors
 * @returns {Map<string, any>} the top-level map; maps are Maps, lists arrays, and scalars as YAML 1.2 types them (`true` is a boolean,
 *   `no` a string). An empty file is an empty map.
 * @throws {ContractError} naming the file (and the line) for text the package reports as an error or a warning, and for a top level that is not a map
 */
function parseYaml(text, file) {
  const doc = YAML.parseDocument(text, { version: '1.2', uniqueKeys: true, mapAsMap: true });
  const problem = doc.errors[0] || doc.warnings[0];
  if (problem) {
    const line = problem.linePos && problem.linePos[0] ? `:${problem.linePos[0].line}` : '';
    const reason = problem.message.split('\n')[0].replace(/ at line \d+, column \d+:?$/, '');
    throw new ContractError(`${file}${line}: ${reason}`);
  }
  let root;
  try {
    root = doc.toJS({ mapAsMap: true });
  } catch (e) {
    throw new ContractError(`${file}: ${e.message}`);
  }
  if (root === null || root === undefined) return new Map();
  if (!isMap(root)) throw new ContractError(`${file}: the top level is not a map of keys`);
  return root;
}

// ---------------------------------------------------------------------------
// One workflow's needs

// The permissions of a `permissions:` value as { name: 'read' | 'write' }; `none` asks for nothing.
function permissionsOf(value, where) {
  if (value === null) return {};
  if (!isMap(value)) throw new ContractError(`${where}: permissions must be a map of permission names ("read-all" and "write-all" hide what a caller must give)`);
  const out = {};
  for (const [name, level] of [...value].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (typeof level !== 'string' || !LEVELS.includes(level)) throw new ContractError(`${where}: ${name} must be none, read or write`);
    if (level !== 'none') out[name] = level;
  }
  return out;
}

const sorted = (names) => [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// The names under `inputs` or `secrets` of workflow_call that a caller must give: `required: true` with no default.
function requiredOf(group, where) {
  if (group === undefined || group === null) return [];
  if (!isMap(group)) throw new ContractError(`${where}: cannot read this list of names`);
  const names = [];
  for (const [name, def] of group) {
    if (def === null) continue;
    if (!isMap(def)) throw new ContractError(`${where}.${name}: cannot read this definition`);
    const required = def.get('required');
    if (required !== undefined && typeof required !== 'boolean') throw new ContractError(`${where}.${name}: required must be true or false`);
    if (required === true && !def.has('default')) names.push(name);
  }
  return sorted(names);
}

/**
 * @param {string} text  a workflow file
 * @param {string} file  its name, for errors
 * @returns {{ inputs: string[], secrets: string[], jobs: Record<string, Record<string, string>> } | null}
 *   null when the workflow cannot be called by another (no `workflow_call`)
 */
function needsOfWorkflow(text, file) {
  const root = parseYaml(text, file);
  const on = root.get('on');
  // `on: workflow_call` and `on: [push, workflow_call]` (or the same list over several lines) are callable with nothing declared.
  if (typeof on === 'string' ? on === 'workflow_call' : Array.isArray(on) && on.includes('workflow_call')) {
    return needsOfJobs(root, file, [], []);
  }
  if (!isMap(on) || !on.has('workflow_call')) return null;
  const call = on.get('workflow_call');
  if (call !== null && !isMap(call)) throw new ContractError(`${file}: cannot read workflow_call`);
  const inputs = requiredOf(call && call.get('inputs'), `${file} inputs`);
  const secrets = requiredOf(call && call.get('secrets'), `${file} secrets`);
  return needsOfJobs(root, file, inputs, secrets);
}

function needsOfJobs(root, file, inputs, secrets) {
  const top = root.has('permissions') ? permissionsOf(root.get('permissions'), `${file} permissions`) : null;
  const jobsNode = root.get('jobs');
  if (!isMap(jobsNode)) throw new ContractError(`${file}: has no jobs`);
  const jobs = {};
  for (const id of sorted(jobsNode.keys())) {
    const job = jobsNode.get(id);
    if (!isMap(job)) throw new ContractError(`${file}: job ${id} cannot be read`);
    if (job.has('permissions')) jobs[id] = permissionsOf(job.get('permissions'), `${file} job ${id} permissions`);
    else if (top) jobs[id] = top;
    else throw new ContractError(`${file}: job ${id} sets no permissions and the workflow sets none above: what it needs would depend on the caller's settings`);
  }
  return { inputs, secrets, jobs };
}

// ---------------------------------------------------------------------------
// The contract of a set of workflow files

/** @param {Record<string, string>} files  file name -> text, for each `.yml` / `.yaml` of the workflows folder */
function buildContract(files) {
  const workflows = {};
  for (const name of sorted(Object.keys(files))) {
    const needs = needsOfWorkflow(files[name], name);
    if (needs) workflows[name] = { inputs: needs.inputs, secrets: needs.secrets, jobs: needs.jobs };
  }
  return { format: FORMAT, workflows };
}

const formatContract = (contract) => `${JSON.stringify(contract, null, 2)}\n`;

const isWorkflowName = (name) => /\.ya?ml$/.test(name);

/** The contract of `<dir>/workflows` as it is in the working tree. An absent folder holds no workflow. */
function contractOfDir(dir) {
  let names;
  try {
    names = fs.readdirSync(path.join(dir, WORKFLOWS_DIR));
  } catch (e) {
    if (e.code === 'ENOENT') return buildContract({});
    throw e;
  }
  const files = {};
  for (const name of names.filter(isWorkflowName)) files[name] = fs.readFileSync(path.join(dir, WORKFLOWS_DIR, name), 'utf8');
  return buildContract(files);
}

/** The contract of the workflows folder as a commit holds it. A commit with no such folder holds no workflow. */
function contractAtCommit(dir, commit) {
  const listing = git(dir, ['ls-tree', '--name-only', commit, `${WORKFLOWS_DIR}/`], { allowFail: true });
  const files = {};
  for (const entry of (listing || '').split('\n').filter(Boolean)) {
    const name = entry.slice(WORKFLOWS_DIR.length + 1);
    if (!isWorkflowName(name) || name.includes('/')) continue;
    files[name] = git(dir, ['show', `${commit}:${entry}`]);
  }
  return buildContract(files);
}

/** True when the commit keeps a `workflows/contract.json`: the repo publishes workflows with a contract. */
function hasContractAt(dir, commit) {
  return git(dir, ['cat-file', '-e', `${commit}:${CONTRACT_FILE}`], { allowFail: true }) !== null;
}

// ---------------------------------------------------------------------------
// What a later contract asks that an earlier one did not

/**
 * The needs a caller of `before` does not meet in `after`, for each workflow both hold. A workflow only in
 * `after` is a new one callers add when they want it, and so raises nothing. A caller grants a permission to the
 * whole workflow, so a job's permission rises only past the most any job of the workflow asked before. Lowering a
 * need, or adding an optional input or secret, raises nothing.
 *
 * @returns {{ workflow: string, kind: 'permission' | 'input' | 'secret', name: string, job?: string, from?: string, to?: string }[]}
 */
function raisedNeeds(before, after) {
  const raised = [];
  for (const [workflow, now] of Object.entries(after.workflows)) {
    if (!Object.hasOwn(before.workflows, workflow)) continue;
    const was = before.workflows[workflow];
    const most = {};
    for (const perms of Object.values(was.jobs)) {
      for (const [name, level] of Object.entries(perms)) if (rank(level) > rank(most[name])) most[name] = level;
    }
    for (const [job, perms] of Object.entries(now.jobs)) {
      for (const [name, level] of Object.entries(perms)) {
        if (rank(level) > rank(most[name])) raised.push({ workflow, kind: 'permission', job, name, from: most[name] || 'none', to: level });
      }
    }
    for (const name of now.inputs) if (!was.inputs.includes(name)) raised.push({ workflow, kind: 'input', name });
    for (const name of now.secrets) if (!was.secrets.includes(name)) raised.push({ workflow, kind: 'secret', name });
  }
  return raised;
}

// One line a person reads: the workflow, the job and what rose.
function describeRaise(r) {
  if (r.kind === 'permission') return `${r.workflow}, job ${r.job}: ${r.name} rises from ${r.from} to ${r.to}`;
  return `${r.workflow}: a new required ${r.kind}, ${r.name}`;
}

// The id of the read-first flag a raised need becomes: it names the workflow, the kind and, for a permission, the job.
function callerNeedFlagId(r) {
  return ['caller-needs', r.workflow, r.kind, ...(r.kind === 'permission' ? [r.job] : []), r.name].join('-');
}

module.exports = {
  FORMAT, CONTRACT_FILE, ContractError, parseYaml, needsOfWorkflow, buildContract, formatContract, contractOfDir, contractAtCommit,
  hasContractAt, raisedNeeds, describeRaise, callerNeedFlagId,
};
