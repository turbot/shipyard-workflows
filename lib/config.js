'use strict';

// The one validator of `.github/shipyard.yml`, a repo's release config. Every reader, the check on a PR that
// changes the file and the weekly report use this file and no other: there is no published schema.
//
//   const { config, warnings, errors } = parseConfig(text);            // lenient: what a reader uses
//   const { config, warnings, errors } = parseConfig(text, { strict: true });   // the check on a PR that changes the file
//
// Lenient and strict read the same text the same way. They differ in one thing: an unknown key (a stale one, a
// misspelt one, one of the keys the file dropped) is a warning when lenient, so a stale key never stops a release,
// and an error when strict, so a PR cannot add one. A wrong type, a value outside its kind and YAML that cannot be
// read are errors in both. `config` holds the keys that passed; a key with an error is left out of it.
//
// The text is data: it is parsed with the vendored `yaml` package and never run, and no message holds more of it
// than a short, one-line quote.
//
// Each message names the key and the fix. A YAML trap (a value that begins with `#`, read as a comment, or with `{`,
// read as a map) says to quote the value.

const YAML = require('../vendor/yaml');
const { createMatcher, PatternError } = require('./not-shipped');

const FILE = '.github/shipyard.yml';
const MAX_BYTES = 64 * 1024;

const KINDS = Object.freeze(['go-cli', 'go-library', 'service', 'docs-site', 'shipyard']);
const CADENCES = Object.freeze(['daily', 'weekly', 'manual']);
// The flows a repo may run in its own files (`own`).
const FLOWS = Object.freeze(['cut', 'record', 'ship', 'tag', 'shipped']);
const AUDIENCES = Object.freeze(['visitors', 'customers', 'repos']);

// Keys of `.github/release.json` that `shipyard.yml` drops or replaces, each with what to do about it. A file that
// still has one is read, and the key is a warning (an error when strict).
const DROPPED = Object.freeze({
  start: 'replaced by `cadence` (daily, weekly or manual) for the default branch, and by `greenCheck` at the top level',
  workBranch: 'the work branch is the repo\'s default branch',
  tagPrefix: 'the tag prefix is `v`',
  approvers: 'the approvers come from the repo\'s release area',
  'automation-logins': 'the automation logins are one list for the whole org',
  'page-targets': 'a page may go only where `announce.page` says, under the product\'s own site',
  archive: 'it is read from the repo\'s `.goreleaser.yml`',
  'required-check-workflows': 'it is the workflow that holds the `ci` job',
});
// The same for a setting inside a key that stays.
const DROPPED_NESTED = Object.freeze({
  'people.approvers': 'the approvers come from the repo\'s release area',
  'people.ask': 'the ask\'s channel is `ask.channel`',
});

const CHANNEL = /^(?:[CG][A-Z0-9]{6,20}|#?[a-z0-9][a-z0-9._-]{0,79})$/;
const LOGIN = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const PAGE_REPO = /^[^/\s]+\/[^/\s]+$/;
const BRANCH = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,100}$/;
const TARGET = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const WORKFLOW = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml$/;
const PAGE_PATH_SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
const PLACEHOLDERS = /\{(tag|version|dashed)\}/g;
const FRONT_PLACEHOLDERS = /\{(title|date|tag|version|dashed)\}/g;
const FRONT_KEY = /^[A-Za-z][A-Za-z0-9_-]{0,39}$/;
const MAX_FRONT_FIELDS = 12;
const PLAIN_TEXT = /^[^"\\#\r\n\0]{1,200}$/;
const SPDX = /^[A-Za-z0-9.+() -]{1,80}$/;
const FIRST_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const FIRST_FROM = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;
const TAG_PREFIX = /^[A-Za-z0-9._-]{0,20}$/;
const PRODUCT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const PRERELEASE = /^[A-Za-z][A-Za-z0-9]{0,19}$/;
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
const TESTS_MAX = 50;
const MAX_WAIT_MINUTES = 180;
const COULD_IT_BREAK_MAX = 200;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A piece of the file's own text, as one short line, for a message.
function show(value, max = 40) {
  const text = String(value).replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function describe(value) {
  if (value === null || value === undefined) return 'empty';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'a map';
  if (typeof value === 'string') return JSON.stringify(show(value));
  if (typeof value === 'number') return `the number ${value}`;
  return String(value);
}

const or = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} or ${list[list.length - 1]}`);

// The closest of `names` to a misspelt `key`, or null: one or two letters apart.
function closest(key, names) {
  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let prev = row[0];
      row[0] = i;
      for (let j = 1; j <= b.length; j++) {
        const keep = row[j];
        row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1));
        prev = keep;
      }
    }
    return row[b.length];
  };
  let best = null;
  let bestD = 3;
  for (const n of names) {
    const d = distance(String(key), n);
    if (d < bestD) {
      best = n;
      bestD = d;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Where YAML read something other than what the writer meant

const pathOf = (parts) => parts.reduce((acc, part) => (typeof part === 'number' ? `${acc}[${part}]` : acc ? `${acc}.${part}` : part), '');

// Each value that YAML read as something other than the text it was written as, by its path: a comment
// (`channel: #tailpipe` is an empty value and a comment), a flow map (`title: {title}` is a map with one key), an
// anchor (`product: &x` is an empty value that names an anchor) or a tag (`product: !x`). The checks below add the
// hint to an error at that path. `marks` collects a value that read as text but lost its first word to an anchor or
// a tag (`product: &beta release` is "release"), unless an alias uses the anchor: nothing is wrong with the value's
// type, so only a warning says so.
function findTraps(node, parts, found) {
  if (YAML.isMap(node)) {
    for (const pair of node.items) {
      const key = YAML.isScalar(pair.key) ? String(pair.key.value) : null;
      if (key !== null) trapOf(pair.value, [...parts, key], found);
    }
  } else if (YAML.isSeq(node)) {
    node.items.forEach((item, i) => trapOf(item, [...parts, i], found));
  }
}

function trapOf(value, parts, found) {
  const { traps, marks, aliases } = found;
  const tag = YAML.isNode(value) && typeof value.tag === 'string' && /^![^!]/.test(value.tag) ? value.tag : null;
  const anchor = YAML.isNode(value) && value.anchor ? value.anchor : null;
  const empty = YAML.isScalar(value) && (value.value === null || value.value === '');
  if (empty && anchor) {
    traps.set(pathOf(parts), `YAML read "&${show(anchor, 30)}" as an anchor, so the value is empty: if "&${show(anchor, 30)}" is the value, put it in quotes`);
  } else if (empty && tag) {
    traps.set(pathOf(parts), `YAML read "${show(tag, 30)}" as a tag, not as text: put the value in quotes`);
  } else if ((anchor && !aliases.has(anchor)) || tag) {
    const what = anchor ? `the anchor "&${show(anchor, 30)}"` : `the tag "${show(tag, 30)}"`;
    const first = anchor ? `&${show(anchor, 30)}` : show(tag, 30);
    marks.push(`${pathOf(parts) || 'the file'} carries ${what}, which this file does not use: remove it, or, if the value began with "${first}", put the whole value in quotes.`);
  }
  if (YAML.isScalar(value) && value.value === null && value.comment && !anchor && !tag) {
    traps.set(pathOf(parts), `YAML read "#${show(value.comment.trim(), 30)}" as a comment, so the value is empty: if "#${show(value.comment.trim(), 30)}" is the value, put it in quotes`);
  } else if (YAML.isMap(value) && value.flow && value.items.length
    && value.items.every((p) => YAML.isScalar(p.key) && (p.value === null || (YAML.isScalar(p.value) && p.value.value === null)))) {
    const names = value.items.map((p) => String(p.key.value));
    traps.set(pathOf(parts), `YAML read "{${show(names.join(', '), 30)}}" as a map, not as text: put the value in quotes, such as "{${show(names[0], 20)}}"`);
  }
  findTraps(value, parts, found);
}

// A plain value that starts with one of these is YAML's own syntax, not text.
const SYNTAX_START = /^([*&!@%`])\S/;
// A line of the file: `key: value`, or a list item `- value`.
const KEY_LINE = /^\s*(?:-\s+)*(?:"([^"]{1,60})"|'([^']{1,60})'|([^\s#'"-][^#]{0,60}?))\s*:(?:\s+(.*))?$/;
const ITEM_LINE = /^\s*-\s+(.*)$/;

// A syntax error, in the file's own terms: the line, the key on it, and the likely cause with the fix. YAML reports
// the first error well and the ones after it as its own fallout, so only the first is said.
function parseProblem(error, lines) {
  const first = String(error.message).split('\n')[0].replace(/ at line \d+, column \d+:?$/, '').replace(/:$/, '');
  const line = error.linePos && error.linePos[0] ? error.linePos[0].line : null;
  // YAML reports a list or map that was never closed at the line after it began: that error looks one line back.
  const unclosed = /^Flow (sequence|map)/.test(first);
  const at = unclosed && line > 1 && !KEY_LINE.test(lines[line - 1] || '') && !ITEM_LINE.test(lines[line - 1] || '') ? line - 1 : line;
  const source = at ? lines[at - 1] || '' : '';
  const km = KEY_LINE.exec(source);
  const key = km ? km[1] || km[2] || km[3] : null;
  const value = (km ? km[4] : (ITEM_LINE.exec(source) || [])[1] || '').trim();
  let text = `the file is not valid YAML${at ? ` (line ${at}${key ? `, ${show(key)}` : ''})` : ''}: ${show(first, 120)}.`;
  const quoted = `put the whole value in quotes, such as ${JSON.stringify(show(value, 40))}`;
  const m = SYNTAX_START.exec(value);
  if (value.startsWith('{')) text += ` A value that begins with "{" is read as a map, not as text: ${quoted}.`;
  else if (value.startsWith('[')) text += ` A value that begins with "[" is read as a list, and a # or a { inside one ends it early: if it is text, ${quoted}; if it is a list, put an item that begins with # or { in quotes.`;
  else if (m) text += ` A value that begins with "${m[1]}" is YAML syntax, not text: ${quoted}.`;
  else if (/:\s/.test(value)) text += ` A value that holds ": " is read as a nested map: ${quoted}.`;
  return text;
}

// ---------------------------------------------------------------------------
// What a check records

class Check {
  constructor({ strict, traps }) {
    this.strict = strict;
    this.traps = traps;
    this.errors = [];
    this.warnings = [];
    this.kind = null;
  }

  hint(path) {
    const h = this.traps.get(path);
    return h ? ` ${h}.` : '';
  }

  error(path, message) {
    this.errors.push(`${path ? `${path} ` : ''}${message}${path ? this.hint(path) : ''}`);
  }

  // A value that is not what the key needs.
  bad(path, expectation, value) {
    this.error(path, `must be ${expectation} (it is ${describe(value)}).`);
  }

  // Something Shipyard does not read: a warning, and an error when strict.
  soft(message) {
    (this.strict ? this.errors : this.warnings).push(message);
  }

  unknown(name, parent, names) {
    const near = closest(name, names);
    const where = parent ? `${parent} has no setting "${show(name)}"` : `"${show(name)}" is not a key of ${FILE}`;
    const fix = near ? `did you mean "${near}"? Otherwise remove it` : `remove it (${parent ? 'settings' : 'keys'}: ${names.join(', ')})`;
    this.soft(`${where}: ${fix}.`);
  }
}

// A map of settings. `shape` maps each setting to its check, which returns the value to keep (or undefined).
function mapOf(value, path, c, shape, expectation = 'a map of settings') {
  if (!isObject(value)) {
    c.bad(path, expectation, value);
    return undefined;
  }
  const kept = [];
  for (const key of Object.keys(value)) {
    const sub = `${path}.${key}`;
    if (Object.hasOwn(shape, key)) {
      const before = c.errors.length;
      const v = shape[key](value[key], sub, c);
      if (c.errors.length === before && v !== undefined) kept.push([key, v]);
    } else if (Object.hasOwn(DROPPED_NESTED, sub)) {
      c.soft(`${sub} is dropped: ${DROPPED_NESTED[sub]}. Remove it.`);
    } else {
      c.unknown(key, path, Object.keys(shape));
    }
  }
  return Object.fromEntries(kept);
}

function listOf(item, expectation, { min = 0, max = 100 } = {}) {
  return (value, path, c) => {
    if (!Array.isArray(value)) {
      c.bad(path, `a list of ${expectation}`, value);
      return undefined;
    }
    if (value.length < min) {
      c.error(path, `must hold at least ${min} entr${min === 1 ? 'y' : 'ies'}.`);
      return undefined;
    }
    if (value.length > max) {
      c.error(path, `must hold at most ${max} entries (it holds ${value.length}).`);
      return undefined;
    }
    const out = value.map((v, i) => item(v, `${path}[${i}]`, c));
    return out.some((v) => v === undefined) ? undefined : out;
  };
}

// ---------------------------------------------------------------------------
// The value checks

// One line of text. `re` narrows it; `what` says what it is for the message.
const line = ({ what = 'one line', max = 200, re = null } = {}) => (value, path, c) => {
  if (typeof value !== 'string' || !value.trim() || CONTROL.test(value) || value.trim().length > max || (re && !re.test(value.trim()))) {
    c.bad(path, what === 'one line' ? `one line of at most ${max} characters` : what, value);
    return undefined;
  }
  return value.trim();
};

const bool = (value, path, c) => {
  if (typeof value !== 'boolean') {
    c.bad(path, 'true or false', value);
    return undefined;
  }
  return value;
};

const oneOf = (names) => (value, path, c) => {
  if (typeof value !== 'string' || !names.includes(value)) {
    c.bad(path, `one of ${or(names)}`, value);
    return undefined;
  }
  return value;
};

const target = line({ what: 'the name of one make target', max: 100, re: TARGET });

// A key a kind does not use: `build` and `homebrew` are for a Go CLI.
const onlyFor = (kind, key, check) => (value, path, c) => {
  if (c.kind && c.kind !== kind) {
    c.error(path, `is only for kind ${kind}, and this file says kind: ${c.kind}. Remove ${key}, or change kind.`);
    return undefined;
  }
  return check(value, path, c);
};

const own = (value, path, c) => {
  const flows = listOf((v, p, cc) => {
    if (typeof v !== 'string' || !FLOWS.includes(v)) {
      cc.error(p, `is ${describe(v)}, which is not a flow a repo can run itself: use ${or(FLOWS)}.`);
      return undefined;
    }
    return v;
  }, `flows (${or(FLOWS)})`, { max: FLOWS.length })(value, path, c);
  if (flows) {
    const dup = flows.find((f, i) => flows.indexOf(f) !== i);
    if (dup) {
      c.error(path, `lists "${dup}" twice: list each flow once.`);
      return undefined;
    }
  }
  return flows;
};

const build = onlyFor('go-cli', 'build', (value, path, c) => mapOf(value, path, c, {
  cgo: bool,
  make: target,
  test: target,
}));

const homebrew = onlyFor('go-cli', 'homebrew', (value, path, c) => mapOf(value, path, c, {
  desc: (v, p, cc) => (typeof v === 'string' && PLAIN_TEXT.test(v) && v.trim() ? v.trim()
    : cc.bad(p, 'one line with no double quote, backslash or #', v)),
  homepage: (v, p, cc) => (typeof v === 'string' && /^https:\/\/[^\s"]+$/.test(v) ? v : cc.bad(p, 'an https address', v)),
  license: (v, p, cc) => (typeof v === 'string' && SPDX.test(v) ? v : cc.bad(p, 'an SPDX name, such as AGPL-3.0', v)),
}));

// The text of a front matter value: its own placeholders, and no other brace.
function frontMatter(value, path, c) {
  if (!isObject(value)) {
    c.bad(path, 'a map of field name to value', value);
    return undefined;
  }
  const keys = Object.keys(value);
  if (!keys.length) {
    c.error(path, 'names no field: leave it out for the default (a title and a date).');
    return undefined;
  }
  if (keys.length > MAX_FRONT_FIELDS) {
    c.error(path, `names ${keys.length} fields: at most ${MAX_FRONT_FIELDS}.`);
    return undefined;
  }
  const out = [];
  for (const key of keys) {
    const sub = `${path}.${key}`;
    const v = value[key];
    if (!FRONT_KEY.test(key)) {
      c.error(path, `has the field name "${show(key)}": a name is a letter, then letters, digits, - or _ (40 at most).`);
    } else if (typeof v !== 'string' || !v || v.length > 200) {
      c.bad(sub, 'text of 1 to 200 characters', v);
    } else if (/[{}]/.test(v.replace(FRONT_PLACEHOLDERS, ''))) {
      c.error(sub, 'holds a { or } that is not {title}, {date}, {tag}, {version} or {dashed}.');
    } else {
      out.push([key, v]);
    }
  }
  return Object.fromEntries(out);
}

// A page's path, filled in with a sample release, must be a markdown file in a folder with plain, visible names.
function pagePath(value, path, c) {
  if (typeof value !== 'string') {
    c.bad(path, 'a path with {version}, {tag} or {dashed} in it', value);
    return undefined;
  }
  if (!value.match(PLACEHOLDERS)) {
    c.error(path, 'must hold {version}, {tag} or {dashed}, so each release has its own page.');
    return undefined;
  }
  if (/[{}]/.test(value.replace(PLACEHOLDERS, ''))) {
    c.error(path, 'holds a { or } that is not {version}, {tag} or {dashed}.');
    return undefined;
  }
  const filled = value.replace(/\{tag\}/g, 'v1.2.3').replace(/\{version\}/g, '1.2.3').replace(/\{dashed\}/g, '1-2-3');
  if (!(filled.length <= 200 && filled.split('/').every((s) => PAGE_PATH_SEGMENT.test(s)) && /\.mdx?$/.test(filled))) {
    c.error(path, `makes ${JSON.stringify(show(filled, 80))}, which is not a markdown file (.md or .mdx) in a folder with plain, visible names.`);
    return undefined;
  }
  return value;
}

// A setting the map must hold.
function needs(value, names, path, c) {
  if (!isObject(value)) return;
  for (const name of names) if (!Object.hasOwn(value, name)) c.error(path, `needs "${name}".`);
}

const announcePage = (value, path, c) => {
  needs(value, ['repo', 'path'], path, c);
  return mapOf(value, path, c, {
    repo: (v, p, cc) => (typeof v === 'string' && PAGE_REPO.test(v) ? v : cc.bad(p, '<owner>/<name>, the site repo the page goes to', v)),
    path: pagePath,
    base: (v, p, cc) => (typeof v === 'string' && BRANCH.test(v) ? v : cc.bad(p, 'a branch name', v)),
    frontMatter,
  });
};

const announce = (value, path, c) => mapOf(value, path, c, { page: announcePage });

const askBlock = (value, path, c) => mapOf(value, path, c, {
  channel: (v, p, cc) => (typeof v === 'string' && CHANNEL.test(v) ? v : cc.bad(p, 'a Slack channel id or name, such as "#shipyard-dev"', v)),
});

const people = (value, path, c) => mapOf(value, path, c, {
  tag: listOf((v, p, cc) => (typeof v === 'string' && LOGIN.test(v) ? v : cc.bad(p, 'a GitHub login', v)), 'GitHub logins', { min: 1, max: 20 }),
});

const tagBlock = (value, path, c) => mapOf(value, path, c, { floatingMajor: bool });

const firstRelease = (value, path, c) => {
  needs(value, ['from', 'version'], path, c);
  return mapOf(value, path, c, {
    from: (v, p, cc) => (typeof v === 'string' && FIRST_FROM.test(v) ? v : cc.bad(p, 'an old tag or a commit id where the first range starts', v)),
    version: (v, p, cc) => (typeof v === 'string' && FIRST_VERSION.test(v) ? v : cc.bad(p, 'a plain X.Y.Z, such as 1.0.0', v)),
  });
};

const light = (value, path, c) => mapOf(value, path, c, {
  couldItBreak: line({ what: 'one line', max: COULD_IT_BREAK_MAX }),
});

const patterns = (key) => (value, path, c) => {
  const list = listOf((v, p, cc) => {
    if (typeof v !== 'string' || !v.trim()) return cc.bad(p, 'a path pattern', v);
    if (v.trim().replace(/^(?:\.?\/)+/, '').startsWith('!')) {
      return cc.error(p, `cannot start with "!": ${key === 'notShipped' ? 'list a path that ships although notShipped matches it under "shipped"' : 'list the paths that ship, without "!"'}.`);
    }
    return v.trim();
  }, 'path patterns', { max: 200 })(value, path, c);
  if (list) {
    try {
      createMatcher(list);
    } catch (e) {
      if (!(e instanceof PatternError)) throw e;
      c.error(path, `${e.message}.`);
      return undefined;
    }
  }
  return list;
};

const notes = (value, path, c) => mapOf(value, path, c, {
  internalTerms: listOf(line({ what: 'a term', max: 100 }), 'terms'),
  requirements: line({ what: 'a path', max: 200 }),
  credit: line({ what: 'one line', max: 100 }),
  page: (v, p, cc) => (v === null || isObject(v) ? v : cc.bad(p, 'a map, or null for no page', v)),
});

const readFirst = (value, path, c) => {
  if (!isObject(value)) {
    c.bad(path, 'a map of flag name to path patterns', value);
    return undefined;
  }
  const out = [];
  for (const key of Object.keys(value)) {
    const sub = `${path}.${key}`;
    const v = value[key];
    const one = line({ what: 'a path pattern', max: 200 });
    const got = Array.isArray(v) ? listOf(one, 'path patterns')(v, sub, c) : one(v, sub, c);
    if (got !== undefined) out.push([key, got]);
  }
  return Object.fromEntries(out);
};

const breaking = (value, path, c) => mapOf(value, path, c, {
  detector: listOf(line({ what: 'one word of the command', max: 200 }), 'strings, such as [node, scripts/breaking.js]', { min: 1, max: 20 }),
});

const report = (value, path, c) => mapOf(value, path, c, {
  staging: line({ what: 'one line', max: 200 }),
  performance: line({ what: 'one line', max: 200 }),
  pins: listOf(line({ what: 'a path', max: 200 }), 'paths'),
  templateDiff: bool,
  prodPlan: bool,
});

const evidence = (value, path, c) => {
  const v = line({ what: 'a folder inside the repo', max: 200 })(value, path, c);
  if (v === undefined) return undefined;
  const rel = v.replace(/\{tag\}/g, 'v1.2.3').replace(/\/+$/, '');
  const parts = rel.split('/');
  if (!rel || rel.startsWith('/') || /[\\]/.test(rel) || parts.some((p) => !p || p === '.' || p === '..')
    || parts[0] === '.git' || /^-/.test(rel) || rel.toLowerCase().startsWith('.github/workflows')) {
    c.error(path, `must be a folder inside the repo, not ${JSON.stringify(show(v, 80))}.`);
    return undefined;
  }
  return v;
};

const versionFiles = listOf((value, path, c) => {
  if (!isObject(value)) return c.bad(path, 'a map with a "path" and a "json" field or a "regex"', value);
  const path_ = value.path;
  if (typeof path_ !== 'string' || !path_.trim() || path_.split('/').includes('..') || path_.startsWith('/')) {
    return c.bad(`${path}.path`, 'a path inside the repo', path_);
  }
  if ((typeof value.json === 'string') === (typeof value.regex === 'string')) {
    return c.error(path, 'needs exactly one of "json" (the field that holds the version) and "regex" (a pattern with one group).');
  }
  if (typeof value.regex === 'string') {
    try {
      new RegExp(value.regex, 'm'); // eslint-disable-line no-new
    } catch {
      return c.error(`${path}.regex`, 'is not a valid regular expression.');
    }
  }
  const extra = Object.keys(value).filter((k) => !['path', 'json', 'regex'].includes(k));
  for (const k of extra) c.unknown(k, path, ['path', 'json', 'regex']);
  return { ...(Object.fromEntries(['path', 'json', 'regex'].filter((k) => typeof value[k] === 'string').map((k) => [k, value[k]]))) };
}, 'version files, each a map of "path" and "json" or "regex"');

const products = (value, path, c) => {
  const list = listOf((v, p, cc) => {
    const got = mapOf(v, p, cc, {
      id: line({ what: 'a lower-case id such as "te"', max: 40, re: PRODUCT_ID }),
      name: line({ what: 'the product\'s name', max: 100 }),
      tagPrefix: (x, q, cq) => (typeof x === 'string' && TAG_PREFIX.test(x) ? x : cq.bad(q, 'a short tag prefix in quotes, such as "pgbouncer-" (or "" for none)', x)),
    }, 'a map of "id", "name" and "tagPrefix"');
    if (got && isObject(v)) for (const k of ['id', 'name']) if (!Object.hasOwn(v, k)) cc.error(p, `needs "${k}".`);
    return got;
  }, 'products, each a map of "id", "name" and "tagPrefix"', { min: 1, max: 20 })(value, path, c);
  if (list) {
    const ids = list.map((p) => p.id);
    const dup = ids.find((id, i) => ids.indexOf(id) !== i);
    if (dup) {
      c.error(path, `names the product "${dup}" twice.`);
      return undefined;
    }
  }
  return list;
};

const version = (value, path, c) => mapOf(value, path, c, {
  prerelease: line({ what: 'a short word, such as "rc"', max: 20, re: PRERELEASE }),
});

// The keys, in the order the checks run: `kind` first, because the keys of a kind need it.
const KEYS = Object.freeze({
  kind: oneOf(KINDS),
  cadence: oneOf(CADENCES),
  own,
  afterShip: listOf(line({ what: 'the file name of a workflow, such as test.yml', max: 100, re: WORKFLOW }), 'workflow file names', { max: 20 }),
  build,
  homebrew,
  announce,
  greenCheck: line({ what: 'the name of a check', max: 100 }),
  product: line({ what: 'one line', max: 100 }),
  products,
  audience: oneOf(AUDIENCES),
  askSecondApprover: bool,
  tests: listOf(line({ what: 'a job name', max: 200 }), 'job names, each on one line', { max: TESTS_MAX }),
  profile: oneOf(['light']),
  light,
  version,
  firstRelease,
  notShipped: patterns('notShipped'),
  shipped: patterns('shipped'),
  notes,
  readFirst,
  breaking,
  report,
  consumers: listOf(line({ what: '<owner>/<name>', max: 140, re: REPO }), 'repos, each <owner>/<name>', { max: 50 }),
  people,
  ask: askBlock,
  tag: tagBlock,
  checkWaitMinutes: (value, path, c) => (Number.isInteger(value) && value >= 0 && value <= MAX_WAIT_MINUTES ? value
    : c.bad(path, `a whole number of minutes, 0 to ${MAX_WAIT_MINUTES}`, value)),
  evidence,
  versionFiles,
  ownDependencies: listOf(line({ what: 'a module or package prefix', max: 200 }), 'module or package prefixes', { max: 50 }),
});

const KNOWN_KEYS = Object.freeze(Object.keys(KEYS));
const DROPPED_KEYS = Object.freeze(Object.keys(DROPPED));

// ---------------------------------------------------------------------------

/**
 * @param {string} text   the text of a `.github/shipyard.yml`
 * @param {{strict?: boolean}} [opts]  strict: an unknown or dropped key is an error, not a warning
 * @returns {{config: object, warnings: string[], errors: string[], unreadable: boolean}}  `unreadable`: the text was
 *   not YAML, not a map of settings, not text, or over the size limit, so `config` is empty and says nothing about the repo
 */
function parseConfig(text, { strict = false } = {}) {
  const c = new Check({ strict, traps: new Map() });
  const fail = (message) => ({
    config: {}, warnings: c.warnings, errors: [...c.errors, message], unreadable: true,
  });

  if (typeof text !== 'string') return fail(`${FILE} must be text.`);
  if (Buffer.byteLength(text) > MAX_BYTES) return fail(`${FILE} is over ${MAX_BYTES / 1024} KiB: a repo's config is short.`);

  let doc;
  try {
    doc = YAML.parseDocument(text, { version: '1.2', uniqueKeys: true, maxAliasCount: 20 });
  } catch (e) {
    return fail(`the file is not valid YAML: ${show(e && e.message ? String(e.message).split('\n')[0] : e, 120)}.`);
  }
  const lines = text.split(/\r?\n/);
  if (doc.errors.length) {
    return {
      config: {}, warnings: [], errors: [parseProblem(doc.errors[0], lines)], unreadable: true,
    };
  }
  for (const w of doc.warnings.filter((x) => x.code !== 'TAG_RESOLVE_FAILED')) c.soft(`the file is not plain YAML (line ${w.linePos && w.linePos[0] ? w.linePos[0].line : '?'}): ${show(String(w.message).split('\n')[0].replace(/ at line \d+, column \d+:?$/, ''), 100)}.`);

  let data;
  try {
    data = doc.toJS({ maxAliasCount: 20 });
  } catch (e) {
    const first = e && e.message ? String(e.message).split('\n')[0] : String(e);
    const alias = /^Unresolved alias[^:]*: (.*)$/.exec(first);
    if (alias) return fail(`the file is not valid YAML: a value that begins with "*" is read as an alias, not as text: put the value in quotes, such as "*${show(alias[1], 40)}".`);
    return fail(`the file is not valid YAML: ${show(first, 120)}.`);
  }
  if (data === null || data === undefined) data = {};
  if (!isObject(data)) return fail(`${FILE} must be a map of settings, starting with "kind:" (it is ${describe(data)}).`);
  const aliases = new Set();
  YAML.visit(doc, { Alias(_, node) { aliases.add(node.source); } });
  const found = { traps: c.traps, marks: [], aliases };
  trapOf(doc.contents, [], found);
  for (const mark of found.marks) c.soft(mark);

  const kept = [];
  // `kind` first: it decides which keys are for the repo.
  if (!Object.hasOwn(data, 'kind')) {
    c.error('kind', `is required: say what the repo is, one of ${or(KINDS)}.`);
  } else {
    const k = KEYS.kind(data.kind, 'kind', c);
    if (k !== undefined) {
      c.kind = k;
      kept.push(['kind', k]);
    }
  }
  for (const key of Object.keys(data)) {
    if (key === 'kind') continue;
    if (Object.hasOwn(KEYS, key)) {
      const before = c.errors.length;
      const v = KEYS[key](data[key], key, c);
      if (c.errors.length === before && v !== undefined) kept.push([key, v]);
    } else if (Object.hasOwn(DROPPED, key)) {
      c.soft(`${show(key)} is dropped: ${DROPPED[key]}. Remove it.`);
    } else {
      c.unknown(key, '', KNOWN_KEYS);
    }
  }
  return {
    config: Object.fromEntries(kept), warnings: c.warnings, errors: c.errors, unreadable: false,
  };
}

module.exports = {
  parseConfig, FILE, KINDS, CADENCES, FLOWS, AUDIENCES, KNOWN_KEYS, DROPPED_KEYS, DROPPED, DROPPED_NESTED, MAX_BYTES,
};
