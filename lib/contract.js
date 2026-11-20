'use strict';

// What a published workflow asks of the repos that call it: the permissions each job needs, the inputs
// it requires and the secrets it requires. `workflows/contract.json` records it, made from
// `workflows/*.yml` and nothing else, so a change to what callers must give is always a visible diff.
// A release that raises a need goes out below a new major only when its read-first flag is answered: the answer names every
// caller checked and what each grants (lib/lint-prep.js, docs/prep-file.md).
//
// No runtime dependencies, so the YAML is read by a small reader that knows the shapes workflow files use
// (block maps, `{}` and one-line `{ a: b }` maps, one-line `[a, b]` lists, and the block lists and block scalars it skips). A line it cannot read
// is an error that names the file and the line: it never guesses what a caller must give.

const fs = require('node:fs');
const path = require('node:path');
const { ReleaseError, git } = require('./release-git');

const FORMAT = 1;
const WORKFLOWS_DIR = 'workflows';
const CONTRACT_FILE = `${WORKFLOWS_DIR}/contract.json`;
const LEVELS = ['none', 'read', 'write'];
const rank = (level) => (level === undefined ? 0 : LEVELS.indexOf(level));

// A ReleaseError, so the steps that read the contract print it and exit 2 as they do any other.
class ContractError extends ReleaseError {}

// ---------------------------------------------------------------------------
// A small YAML reader

const KEY_LINE = /^(?:"((?:[^"\\]|\\.)*)"|'((?:[^']|'')*)'|([^\s#'"{[\-][^:]*?|-[^\s:][^:]*?)):(?:\s+(.*))?$/;

function tokensOf(text, file) {
  const out = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    if (/^\s*(#.*)?$/.test(raw)) return;
    if (/^ *\t/.test(raw)) throw new ContractError(`${file}:${i + 1}: a tab indents this line, which YAML does not allow`);
    out.push({ n: i + 1, indent: raw.length - raw.trimStart().length, text: raw.trim() });
  });
  return out;
}

// A scalar's text without its comment and quotes.
function scalarOf(value) {
  const v = value.trim();
  const quote = v[0];
  if (quote === '"' || quote === "'") {
    for (let i = 1; i < v.length; i++) {
      if (quote === '"' && v[i] === '\\') i++;
      else if (v[i] === quote) {
        if (quote === "'" && v[i + 1] === "'") i++;
        else return v.slice(1, i);
      }
    }
    return v.slice(1);
  }
  const hash = v.search(/(^|\s)#/);
  return (hash === -1 ? v : v.slice(0, hash)).trim();
}

// `{}` or `{ a: b, c: d }` on one line, as a Map of its scalars.
function flowMapOf(value, where) {
  const inner = scalarOf(value);
  if (!/^\{.*\}$/.test(inner)) throw new ContractError(`${where}: a map written on one line must end with a closing brace`);
  const map = new Map();
  const body = inner.slice(1, -1).trim();
  if (!body) return map;
  for (const part of body.split(',')) {
    const m = /^\s*([^:\s][^:]*?)\s*:\s*(\S.*?)\s*$/.exec(part);
    if (!m) throw new ContractError(`${where}: cannot read this one-line map`);
    map.set(scalarOf(m[1]), scalarOf(m[2]));
  }
  return map;
}

// `[a, b]` on one line, as an array of its scalars.
function flowListOf(value, where) {
  const inner = scalarOf(value);
  if (!/^\[.*\]$/.test(inner)) throw new ContractError(`${where}: a list written on one line must end with a closing bracket`);
  const body = inner.slice(1, -1).trim();
  return body ? body.split(',').map((x) => scalarOf(x)) : [];
}

// The block map of tokens[from..to) at `indent`: a Map of key -> Map | string | null | LIST. A block list and a block
// scalar are never read into: nothing a caller must give sits in one.
const LIST = Symbol('list');

function parseMap(tokens, from, to, indent, file) {
  const map = new Map();
  let i = from;
  while (i < to) {
    const t = tokens[i];
    const m = KEY_LINE.exec(t.text);
    if (t.indent !== indent || !m) throw new ContractError(`${file}:${t.n}: cannot read this line`);
    const key = m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2].replace(/''/g, "'") : m[3];
    const value = m[4] === undefined ? '' : m[4];
    const bare = scalarOf(value) === '' && !/^["']/.test(value.trim());
    // The key's block: every following line indented deeper, and the items of a list written at the key's own indent.
    let j = i + 1;
    while (j < to && (tokens[j].indent > indent || (bare && tokens[j].indent === indent && /^-(\s|$)/.test(tokens[j].text)))) j++;
    if (map.has(key)) throw new ContractError(`${file}:${t.n}: this key is set twice`);
    if (bare && !/^[|>]/.test(value.trim())) {
      if (j === i + 1) map.set(key, null);
      else if (/^-(\s|$)/.test(tokens[i + 1].text)) map.set(key, LIST);
      else map.set(key, parseMap(tokens, i + 1, j, tokens[i + 1].indent, file));
    } else if (value.trim().startsWith('{')) {
      map.set(key, flowMapOf(value, `${file}:${t.n}`));
    } else if (value.trim().startsWith('[')) {
      map.set(key, flowListOf(value, `${file}:${t.n}`));
    } else if (/^[|>]/.test(value.trim())) {
      map.set(key, LIST);
    } else {
      map.set(key, scalarOf(value));
    }
    i = j;
  }
  return map;
}

function parseYaml(text, file) {
  const tokens = tokensOf(text, file);
  if (!tokens.length) return new Map();
  return parseMap(tokens, 0, tokens.length, tokens[0].indent, file);
}

// ---------------------------------------------------------------------------
// One workflow's needs

const isMap = (v) => v instanceof Map;

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
    if (required !== undefined && !/^(true|false)$/i.test(required)) throw new ContractError(`${where}.${name}: required must be true or false`);
    if (/^true$/i.test(required) && !def.has('default')) names.push(name);
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
  // `on: workflow_call` and `on: [push, workflow_call]` are callable with nothing declared. A block list is not read, so
  // the workflow's needs would be unknown: never a quiet "not callable".
  if (on === LIST) throw new ContractError(`${file}: cannot read the triggers (on:) written as a list on several lines: write them on one line`);
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
