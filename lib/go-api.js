'use strict';

// A Go library's exported API, compared between the previous release and the commit that ships, and the level it
// sets. `shipyard facts` writes the `api` block from `apiBlock`; the prep lint and the release check both judge a
// level with `apiLevel` and `apiProblems`, so the two cannot drift.
//
// The tool is `apidiff` (golang.org/x/exp/cmd/apidiff), pinned at API_TOOL_VERSION. What its source says at that
// version, and what this file relies on:
//
// - Module mode (`-m`). `apidiff -m -w FILE MODULE_PATH` loads `MODULE_PATH/...` from the module in the current
//   directory and writes every package's export data to FILE (a zip, the module path in it). `apidiff -m OLD NEW`
//   takes OLD or NEW as such a file when it is a regular file, else loads the module from the current directory.
//   Packages are matched by their path inside the module, so a move from example.com/lib to example.com/lib/v2
//   compares the same packages.
// - Packages whose path inside the module has an `internal` element are left out (it prints "Ignoring internal
//   package ..." on standard error). `main` packages are not left out: Shipyard drops their names itself, since no
//   other module can import a `main` package. Test files are not loaded.
// - The report (`apidiff/report.go`, `Report.Text`): the heading "Incompatible changes:" then a "- <name>: <what>"
//   line for each, then the heading "Compatible changes:" and its lines. A heading with no lines is not printed, so
//   no change prints nothing. The lines under each heading are sorted.
// - A name (`apidiff/messageset.go`, `objectString`): an object in the module's root package is its bare name
//   (`Parse`); in another package of the module it starts with "./" and that package's path inside the module
//   (`./client.Client`); outside the module, the package's full path. A method is `T.M` or `(*T).M`, with a
//   generic receiver's type parameters (`(*Set[K]).Add`); a field or an interface method is `T.F`; a method an
//   embedded type gave another type is `inner.M, method set of *T`. A whole package added or removed is
//   "- package <full import path>: added" or ": removed".
// - "removed" is the whole <what> of an incompatible line for a removed name, field, method or package.
// - It exits 0 whatever it finds; a failure to load or read exits 1 with the reason on standard error.
//
// The block keeps names only, as a person finds them in the code: the package path inside the module (none for
// the root package), then the name, with no "./", no pointer receiver and no type parameters (`client.Client.Close`).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { ReleaseError, git, bump: bumpParts } = require('./release-git');

const API_TOOL = 'apidiff';
const API_TOOL_MODULE = 'golang.org/x/exp/cmd/apidiff';
// A third-party tool a release job installs is pinned to a version at least 14 days old when its PR opens: this is
// golang.org/x/exp at a52e3aef5920 (2026-11-09), the newest commit that old when the pin's PR opened (2026-11-24), with
// the pseudo-version proxy.golang.org/golang.org/x/exp/@v/a52e3aef5920.info gives. Its cmd/apidiff has module mode (`-m`).
// cut.yml's APIDIFF_VERSION is held equal to it (test/cut-api-tool.test.js); move both together, to a version as old.
const API_TOOL_VERSION = 'v0.0.0-20261109185158-a52e3aef5920';
const API_TOOL_INSTALL = `go install ${API_TOOL_MODULE}@${API_TOOL_VERSION}`;

const TOOL_TIMEOUT_MS = 600000;
const TOOL_MAX_BYTES = 8 * 1024 * 1024;
const LIST_CAP = 10;
const RANK = { patch: 0, minor: 1, major: 2 };

const oneLine = (s) => String(s).replace(/\s+/g, ' ').trim();
const IDENT = /^[\p{L}_][\p{L}\p{N}_]*(?:\.[\p{L}_][\p{L}\p{N}_]*)*$/u;

const unreadable = (line) => new ReleaseError(`${API_TOOL} printed a line Shipyard cannot read: ${JSON.stringify(oneLine(line).slice(0, 300))}`);

// The package path inside the module: '' for the root package, null when the path is not in the module.
function insideModule(pkgPath, modulePath) {
  if (!modulePath) return null;
  if (pkgPath === modulePath) return '';
  return pkgPath.startsWith(`${modulePath}/`) ? pkgPath.slice(modulePath.length + 1) : null;
}

// One object name of the report as the block keeps it: `{ pkg, name }`, `pkg` the package path inside the module
// ('' for the root package, or a full path for a package outside it). Null when it is not a name apidiff writes.
function objectName(text) {
  let s = text;
  let embedder = null;
  const set = /^(.+), method set of \*?([\p{L}_][\p{L}\p{N}_]*)(?:\[[^\]]*\])?$/u.exec(s);
  if (set) [, s, embedder] = set;
  let pkg = '';
  let inside = true;
  const relative = s.startsWith('./');
  if (relative) s = s.slice(2);
  // The package is everything up to the first dot after its last slash; a receiver's brackets never hold a slash.
  const head = s.search(/[([]/);
  const slash = s.lastIndexOf('/', head === -1 ? s.length : head);
  if (relative || slash !== -1) {
    const dot = s.indexOf('.', slash + 1);
    if (dot <= 0) return null;
    pkg = s.slice(0, dot);
    s = s.slice(dot + 1);
    if (!pkg || /\s|:/.test(pkg)) return null;
    inside = relative;
  }
  s = s.replace(/^\(\*([^)]*)\)/, '$1').replace(/\[[^\]]*\]/g, '');
  if (embedder) s = `${embedder}.${s.slice(s.lastIndexOf('.') + 1)}`;
  if (!IDENT.test(s)) return null;
  return { pkg, name: s, inside };
}

// Each line of the report as `{ kind, pkg, name }`, `kind` removed, changed or added. `modulePath` ({ from, to }),
// when given, makes a whole package's full path a path inside the module.
function apidiffEntries(text, modulePath = {}) {
  const entries = [];
  let compatible = null;
  for (const raw of String(text).split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line === '') continue;
    if (line === 'Incompatible changes:') { compatible = false; continue; }
    if (line === 'Compatible changes:') { compatible = true; continue; }
    if (compatible === null) throw unreadable(line);
    let found = null;
    let what;
    const pkgLine = /^- package (\S+): (removed|added)$/.exec(line);
    if (pkgLine) {
      what = pkgLine[2];
      const side = what === 'removed' ? modulePath.from : modulePath.to;
      const inside = insideModule(pkgLine[1], side);
      found = { pkg: inside === null ? pkgLine[1] : inside, name: null, inside: inside !== null };
    } else {
      const m = /^- (.+?): (.+)$/.exec(line);
      if (!m) throw unreadable(line);
      what = m[2];
      found = objectName(m[1]);
    }
    if (!found) throw unreadable(line);
    const kind = compatible ? 'added' : what === 'removed' ? 'removed' : 'changed';
    const name = found.name === null ? (found.pkg || '.') : found.pkg ? `${found.pkg}.${found.name}` : found.name;
    entries.push({ kind, pkg: found.pkg, inside: found.inside, name });
  }
  return entries;
}

const sortedOnce = (names) => [...new Set(names)].sort();

function listsOf(entries) {
  const of = (kind) => sortedOnce(entries.filter((e) => e.kind === kind).map((e) => e.name));
  return { removed: of('removed'), changed: of('changed'), added: of('added') };
}

/**
 * apidiff's report as three lists of names: `removed` (an incompatible "removed"), `changed` (every other
 * incompatible change) and `added` (every compatible change), each sorted and each name once. Empty text is no
 * change. A line it does not read throws a ReleaseError quoting it.
 * @param {string} text
 * @param {{ from?: string, to?: string }} [modulePath] the two module paths, to name a whole package by its path inside the module
 */
function parseApidiff(text, modulePath) {
  return listsOf(apidiffEntries(text, modulePath));
}

/** The path of go.mod's `module` line, quoted or bare; throws when there is none. */
function modulePathOf(goModText) {
  for (const raw of String(goModText).split('\n')) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    const m = /^module\s+(?:"((?:[^"\\]|\\.)+)"|`([^`]+)`|(\S+))$/.exec(line);
    if (m) {
      const p = m[1] !== undefined ? m[1].replace(/\\(.)/g, '$1') : m[2] !== undefined ? m[2] : m[3];
      if (p && !/\s/.test(p)) return p;
    }
  }
  throw new ReleaseError('go.mod has no module line');
}

function goModAt(dir, sha) {
  const text = git(dir, ['show', `${sha}:go.mod`], { allowFail: true });
  if (text === null) throw new ReleaseError(`a Go library's API is read from its root go.mod, and ${sha.slice(0, 7)} has none`);
  try {
    return modulePathOf(text);
  } catch {
    throw new ReleaseError(`the go.mod of ${sha.slice(0, 7)} has no module line`);
  }
}

// A changed file that can change the API: a `.go` file that is not a test.
const isGoSource = (file) => file.endsWith('.go') && !file.endsWith('_test.go');

// The tool gets the PATH, the home folder, the temporary folder and Go's own settings (GOPROXY, GOFLAGS,
// GOTOOLCHAIN, GOPRIVATE and the rest, all GO and capitals or digits), never a token or any other variable.
// The platform is fixed to the Linux runner's (TARGET_ENV, the build BUILD_TAGS describes), whatever the machine
// or the caller says, so a prep run on a Mac or an arm64 machine reads the same files as the cut and finds the same API.
const TARGET_ENV = Object.freeze({ GOOS: 'linux', GOARCH: 'amd64', CGO_ENABLED: '1' });
function toolEnv(from = process.env) {
  const env = {};
  for (const [k, v] of Object.entries(from)) {
    if (v === undefined) continue;
    if (k === 'PATH' || k === 'HOME' || k === 'TMPDIR' || /^GO[A-Z0-9]+$/.test(k)) env[k] = v;
  }
  return { ...env, ...TARGET_ENV };
}

function lastLines(text, n = 3) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  return oneLine(lines.slice(-n).join(' ')).slice(0, 500);
}

function runTool(args, cwd, step, execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl(API_TOOL, args, { cwd, env: toolEnv(), timeout: TOOL_TIMEOUT_MS, maxBuffer: TOOL_MAX_BYTES, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout || ''));
      if (error.code === 'ENOENT') {
        return reject(new ReleaseError(`${API_TOOL} was not found on the PATH: a Go library's facts compare its exported API with it. Install it with \`${API_TOOL_INSTALL}\` and put Go's bin folder on the PATH`));
      }
      const why = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? `printed more than ${TOOL_MAX_BYTES / 1024 / 1024} MiB`
        : error.killed ? `timed out after ${TOOL_TIMEOUT_MS / 1000} s`
          : `exited with ${error.code === undefined || error.code === null ? (error.signal || 'an error') : error.code}`;
      const tail = lastLines(stderr);
      // A library with its own cgo files needs a C compiler for Linux amd64 to be read as TARGET_ENV's build, which any
      // other machine (a Mac, an arm64 Linux machine) has not: say so, rather than leave the
      // person with Go's "could not import C".
      const cgo = /could not import C\b/.test(String(stderr || ''))
        ? ` (the library has cgo files, and its API is read as the cut's Linux amd64 build with cgo, which needs a C compiler for Linux amd64: make the facts on a Linux amd64 machine, as the cut does; a Mac or an arm64 machine cannot)`
        : '';
      return reject(new ReleaseError(`${API_TOOL} ${why} while ${step}${cgo}${tail ? `: ${tail}` : ''}`));
    });
  });
}

// The build tags a plain `go build` on a Linux runner has, the platform TARGET_ENV gives the tool. `ignore` (the usual mark of a generator kept beside a
// library) and any other tag are not set, so a file that needs one is not part of the built package.
const BUILD_TAGS = new Set(['linux', 'amd64', 'unix', 'gc', 'cgo']);
const tagSet = (tag) => BUILD_TAGS.has(tag) || /^go1\.\d+$/.test(tag);

// Evaluates a `//go:build` expression (`||`, `&&`, `!` and parentheses); null when it cannot be read.
function evalBuildExpr(expr) {
  const tokens = expr.match(/\|\||&&|!|\(|\)|[A-Za-z0-9_.]+/g) || [];
  let i = 0;
  const bad = () => { throw new Error('unreadable build constraint'); };
  const primary = () => {
    const t = tokens[i++];
    if (t === '!') return !primary();
    if (t === '(') {
      const v = or();
      if (tokens[i++] !== ')') bad();
      return v;
    }
    if (t === undefined || /^(\|\||&&|\))$/.test(t)) bad();
    return tagSet(t);
  };
  const and = () => { let v = primary(); while (tokens[i] === '&&') { i++; const r = primary(); v = v && r; } return v; };
  const or = () => { let v = and(); while (tokens[i] === '||') { i++; const r = and(); v = v || r; } return v; };
  try {
    const v = or();
    return i === tokens.length ? v : null;
  } catch {
    return null;
  }
}

// Whether a Go file's build constraints (`//go:build`, or the older `// +build` lines) let it into the built package.
// A constraint that cannot be read counts as met, so a file is never dropped on a guess.
function builtByDefault(text) {
  const header = [];
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (/^package\b/.test(l)) break;
    header.push(l);
  }
  const goBuild = header.find((l) => /^\/\/go:build\s/.test(l));
  if (goBuild) {
    const v = evalBuildExpr(goBuild.replace(/^\/\/go:build\s+/, ''));
    return v === null ? true : v;
  }
  const plus = header.filter((l) => /^\/\/\s*\+build\s/.test(l));
  return plus.every((l) => l.replace(/^\/\/\s*\+build\s+/, '').split(/\s+/).some((alt) => alt.split(',').every((t) => (t.startsWith('!') ? !tagSet(t.slice(1)) : tagSet(t)))));
}

// A folder of the worktree holds a `main` package when one of its built Go files (not a test, not one a build
// constraint such as `//go:build ignore` leaves out) says `package main`.
function isMainPackage(root, rel) {
  let names;
  try {
    names = fs.readdirSync(path.join(root, rel));
  } catch {
    return false;
  }
  return names.some((n) => {
    if (!isGoSource(n)) return false;
    try {
      const text = fs.readFileSync(path.join(root, rel, n), 'utf8');
      return builtByDefault(text) && /^package\s+main\b/m.test(text);
    } catch {
      return false;
    }
  });
}

/**
 * The `api` block of a Go library's facts: its exported API at `fromSha` (the previous release) against `shipSha`
 * (the commit that ships), by apidiff in a scratch worktree of each. No `.go` file changed (tests aside): the block
 * says so and the tool is not run.
 * @param {object} opts
 * @param {string} opts.dir      the repo's checkout
 * @param {string} opts.fromSha
 * @param {string} opts.shipSha
 * @param {Function} [opts.execFileImpl] node's execFile, or a test's stand-in
 */
async function apiBlock({ dir, fromSha, shipSha, execFileImpl = execFile }) {
  const modulePath = { from: goModAt(dir, fromSha), to: goModAt(dir, shipSha) };
  const changedFiles = git(dir, ['diff', '--name-only', '--no-renames', '-z', fromSha, shipSha]).split('\0').filter(Boolean);
  const goFilesChanged = changedFiles.some(isGoSource);
  const block = { tool: API_TOOL, goFilesChanged, modulePath, removed: [], changed: [], added: [] };
  if (!goFilesChanged) return block;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shipyard-api-'));
  const oldTree = path.join(tmp, 'old');
  const newTree = path.join(tmp, 'new');
  const exportFile = path.join(tmp, 'old.api');
  const made = [];
  try {
    for (const [tree, sha] of [[oldTree, fromSha], [newTree, shipSha]]) {
      git(dir, ['worktree', 'add', '--detach', '--quiet', tree, sha]);
      made.push(tree);
    }
    await runTool(['-m', '-w', exportFile, modulePath.from], oldTree, `writing the API of ${fromSha.slice(0, 7)}`, execFileImpl);
    const report = await runTool(['-m', exportFile, modulePath.to], newTree, `comparing the API of ${shipSha.slice(0, 7)} with it`, execFileImpl);
    // A `main` package's names are no API: no other module can import it.
    const mains = new Map();
    const isMain = (pkg) => {
      if (!mains.has(pkg)) mains.set(pkg, isMainPackage(oldTree, pkg) || isMainPackage(newTree, pkg));
      return mains.get(pkg);
    };
    const entries = apidiffEntries(report, modulePath).filter((e) => !(e.inside && isMain(e.pkg)));
    return { ...block, ...listsOf(entries) };
  } finally {
    for (const tree of made) git(dir, ['worktree', 'remove', '--force', tree], { allowFail: true });
    if (made.length) git(dir, ['worktree', 'prune'], { allowFail: true });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

const hasIncompatible = (api) => api.removed.length > 0 || api.changed.length > 0;

/** The level the API sets: major for a removed or changed name (minor below 1.0.0), minor for an added one, else patch. */
function apiLevel(api, fromParts) {
  if (hasIncompatible(api)) return Array.isArray(fromParts) && fromParts[0] === 0 ? 'minor' : 'major';
  return api.added.length ? 'minor' : 'patch';
}

function capped(names) {
  const shown = names.slice(0, LIST_CAP).join(', ');
  return names.length > LIST_CAP ? `${shown} and ${names.length - LIST_CAP} more` : shown;
}

// Go's rule for the path a major version needs: `/vN` for N of 2 or more (`.vN` for gopkg.in, which v0 and v1
// carry too), no suffix for v0 and v1.
function modulePathFor(current, major) {
  const gopkg = /^(gopkg\.in\/.+)\.v\d+(?:-unstable)?$/.exec(current);
  if (gopkg) return `${gopkg[1]}.v${major}`;
  const base = current.replace(/\/v(?:[2-9]|[1-9]\d+)$/, '');
  return major >= 2 ? `${base}/v${major}` : base;
}

/**
 * What the API refuses of a chosen level: a list of `{ rule, message }`, empty when all is well.
 * - `api-level-low`: the level is below what the API sets, naming the names behind it (ten, then "and N more").
 * - `api-module-path`: a major whose new version needs a module path go.mod does not have, or a module path that
 *   changed at a level other than major.
 * @param {object} opts
 * @param {object} opts.api        the facts' `api` block
 * @param {string} opts.bump       the chosen level: major, minor or patch
 * @param {number[]} opts.fromParts the previous release's [major, minor, patch]
 */
function apiProblems({ api, bump, fromParts }) {
  const problems = [];
  if (!api || !Object.hasOwn(RANK, bump)) return problems;
  const floor = apiLevel(api, fromParts);
  if (RANK[bump] < RANK[floor]) {
    const names = hasIncompatible(api) ? [...api.removed, ...api.changed] : api.added;
    const does = hasIncompatible(api) ? 'removes or changes' : 'adds';
    problems.push({
      rule: 'api-level-low',
      message: `the library's exported API needs at least a ${floor}, not a ${bump}: this release ${does} ${capped(names)}`,
    });
  }
  const { from, to } = api.modulePath;
  if (bump === 'major' && Array.isArray(fromParts)) {
    const next = bumpParts(fromParts, 'major');
    const needed = modulePathFor(to, next[0]);
    if (to !== needed) {
      problems.push({
        rule: 'api-module-path',
        message: `a major makes v${next.join('.')}, which needs the module path ${needed} in go.mod, and it has ${to}: move the module path to ${needed} in its own PR first`,
      });
    }
  } else if (bump !== 'major' && from !== to) {
    problems.push({
      rule: 'api-module-path',
      message: `the module path changed from ${from} to ${to}, which only a major may do, and this release is a ${bump}`,
    });
  }
  return problems;
}

module.exports = {
  API_TOOL, API_TOOL_MODULE, API_TOOL_VERSION, API_TOOL_INSTALL,
  parseApidiff, modulePathOf, apiBlock, apiLevel, apiProblems,
};
