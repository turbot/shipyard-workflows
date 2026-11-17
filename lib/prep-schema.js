'use strict';

// The prep file's JSON schema (prep-schema.json) and a validator for it. The schema is the
// one description of the format: the release-report skill reads the same file, and
// docs/prep-file.md explains it.
//
// No runtime dependencies, so the validator knows only the keywords below. A schema that
// uses any other keyword throws, rather than letting that keyword be silently ignored.

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, 'prep-schema.json');
const schema = JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));

const KEYWORDS = new Set([
  // annotations: they say what a field is and check nothing
  '$schema', '$id', '$defs', 'title', 'description',
  // assertions
  '$ref', 'type', 'const', 'enum', 'required', 'properties', 'additionalProperties',
  'items', 'minItems', 'maxItems', 'uniqueItems', 'minLength', 'maxLength', 'pattern', 'minimum',
]);

const TYPES = {
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: Array.isArray,
  string: (v) => typeof v === 'string',
  integer: Number.isInteger,
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  boolean: (v) => typeof v === 'boolean',
  null: (v) => v === null,
};

// Characters as a reader counts them (code points), not UTF-16 units.
const length = (s) => [...s].length;

// `a.b[2].c`: where a problem is, in the words of the file.
function at(where, key) {
  if (typeof key === 'number') return `${where}[${key}]`;
  return where ? `${where}.${key}` : key;
}

function resolve(root, ref) {
  if (!ref.startsWith('#/')) throw new Error(`schema: only local $ref is supported, not ${ref}`);
  let node = root;
  for (const part of ref.slice(2).split('/')) {
    if (!node || typeof node !== 'object' || !Object.hasOwn(node, part)) throw new Error(`schema: $ref ${ref} names nothing`);
    node = node[part];
  }
  return node;
}

// Throws when the schema uses a keyword this validator does not check.
function assertSupported(node, where = '#') {
  if (!node || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    if (!KEYWORDS.has(key)) throw new Error(`schema: ${where} uses "${key}", which the validator does not check`);
  }
  for (const name of ['properties', '$defs']) {
    for (const [key, child] of Object.entries(node[name] || {})) assertSupported(child, `${where}/${name}/${key}`);
  }
  if (node.items) assertSupported(node.items, `${where}/items`);
  if (Object.hasOwn(node, 'additionalProperties') && typeof node.additionalProperties !== 'boolean') {
    throw new Error(`schema: ${where} sets additionalProperties to a schema; the validator checks only true or false`);
  }
}

// Every problem with `value` against `node`, as `{ at, message }`. Never throws for bad data.
function validate(value, node = schema, root = node, where = '', problems = []) {
  const say = (message) => problems.push({ at: where || '(the file)', message });

  if (node.$ref) validate(value, resolve(root, node.$ref), root, where, problems);

  if (node.type) {
    const types = [].concat(node.type);
    if (!types.some((t) => TYPES[t](value))) {
      say(`must be ${types.map((t) => (t === 'integer' || t === 'array' || t === 'object' ? `an ${t}` : `a ${t}`)).join(' or ')}`);
      return problems;
    }
  }
  if (Object.hasOwn(node, 'const') && value !== node.const) say(`must be ${JSON.stringify(node.const)}`);
  if (node.enum && !node.enum.includes(value)) say(`must be one of ${node.enum.join(', ')}`);

  if (typeof value === 'string') {
    if (node.minLength !== undefined && length(value) < node.minLength) say(`must be at least ${node.minLength} characters`);
    if (node.maxLength !== undefined && length(value) > node.maxLength) {
      say(`must be ${node.maxLength} characters or fewer (it is ${length(value)})`);
    }
    if (node.pattern !== undefined && !new RegExp(node.pattern, 'u').test(value)) {
      say(node.pattern === '\\S' ? 'must not be empty' : `must match ${node.pattern}`);
    }
  }
  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) say(`must be ${node.minimum} or more`);

  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) {
      say(node.minItems === 1 ? 'must not be empty' : `must hold at least ${node.minItems} entries`);
    }
    if (node.maxItems !== undefined && value.length > node.maxItems) say(`must hold ${node.maxItems} entries at most`);
    if (node.uniqueItems) {
      const seen = new Set();
      value.forEach((item, i) => {
        const key = JSON.stringify(item);
        // A number is named; any other entry is not, because its text may be what the log keeps out.
        if (seen.has(key)) problems.push({ at: at(where, i), message: typeof item === 'number' ? `repeats ${item}` : 'repeats an earlier entry' });
        seen.add(key);
      });
    }
    if (node.items) value.forEach((item, i) => validate(item, node.items, root, at(where, i), problems));
  }

  if (TYPES.object(value)) {
    for (const key of node.required || []) {
      if (!Object.hasOwn(value, key)) problems.push({ at: at(where, key), message: 'is missing' });
    }
    const props = node.properties || {};
    Object.entries(value).forEach(([key, child], n) => {
      if (Object.hasOwn(props, key)) validate(child, props[key], root, at(where, key), problems);
      else if (node.additionalProperties === false) {
        // The key is the file's own text: say which field by its place, never by its name.
        problems.push({ at: where || '(the file)', message: `holds a field outside this format (field ${n + 1})` });
      }
    });
  }
  return problems;
}

assertSupported(schema);

module.exports = { schema, SCHEMA_PATH, validate, assertSupported, KEYWORDS };
