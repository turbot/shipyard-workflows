'use strict';

// What goes to the public copy, turbot/shipyard-workflows: publish/publish.json names it,
// and this reads it from a checkout of turbot/shipyard. Local files only; the network side
// is publish-command.js.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

class PublishError extends Error {}

const CONFIG = 'publish/publish.json';

// Semver, so the tag `v<version>` is one a caller can read.
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Read and check publish/publish.json.
 *
 * @returns {{repo: string, branch: string, files: {from: string, to: string}[], privateData: object}}
 */
function readConfig(root, configPath = path.join(root, CONFIG)) {
  let json;
  try {
    json = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    throw new PublishError(`cannot read ${configPath}: ${e.code || 'not valid JSON'}`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new PublishError(`${configPath} must hold an object`);
  if (typeof json.repo !== 'string' || !/^[A-Za-z0-9-]+\/[A-Za-z0-9_.-]+$/.test(json.repo)) {
    throw new PublishError(`${configPath}: repo must be \`owner/name\``);
  }
  if (typeof json.branch !== 'string' || !/^[A-Za-z0-9._/-]+$/.test(json.branch)) {
    throw new PublishError(`${configPath}: branch must be a branch name`);
  }
  if (!Array.isArray(json.files) || json.files.length === 0) throw new PublishError(`${configPath}: files must list what to publish`);
  for (const f of json.files) {
    if (!f || typeof f.from !== 'string' || typeof f.to !== 'string' || !safeRelative(f.from) || !safeRelative(f.to)) {
      throw new PublishError(`${configPath}: each of files is { "from": <path in this repo>, "to": <path in the public copy> }, relative and inside the repo`);
    }
  }
  if (!json.privateData) throw new PublishError(`${configPath}: privateData is required`);
  return { repo: json.repo, branch: json.branch, files: json.files, privateData: json.privateData };
}

// A relative path that stays inside the tree it is relative to.
function safeRelative(p) {
  if (!p || path.isAbsolute(p) || p.includes('\\')) return false;
  const norm = path.posix.normalize(p);
  return norm !== '.' && norm !== '..' && !norm.startsWith('../') && !norm.split('/').includes('.git');
}

// Every file under `dir` (relative to it, `/`-separated, sorted). A symlink is refused:
// what it points at may be outside the repo.
function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new PublishError(`${child} is a symlink: publish only real files`);
    if (entry.isDirectory()) out.push(...walk(dir, child));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/**
 * The public copy, file by file: where each lands, its git mode and its text.
 *
 * @returns {{path: string, source: string, mode: '100644'|'100755', content: string}[]}
 */
function publishSet(root, config, { version } = {}) {
  const files = new Map();
  const add = (source, dest) => {
    const full = path.join(root, source);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) throw new PublishError(`${source} is a symlink: publish only real files`);
    const bytes = fs.readFileSync(full);
    let content = bytes.toString('utf8');
    // The public copy is written as text: a file that is not UTF-8 would change on the way.
    if (!Buffer.from(content, 'utf8').equals(bytes)) throw new PublishError(`${source} is not UTF-8 text`);
    if (files.has(dest)) throw new PublishError(`two files would land at ${dest}`);
    // The version is the release's: the published package.json gets it, the source holds none.
    if (version !== undefined && source === 'package.json') content = withVersion(source, content, version);
    files.set(dest, { path: dest, source, mode: stat.mode & 0o111 ? '100755' : '100644', content });
  };
  for (const { from, to } of config.files) {
    const full = path.join(root, from);
    let stat;
    try {
      stat = fs.lstatSync(full);
    } catch {
      throw new PublishError(`${from} is in publish.json but not in the repo`);
    }
    if (stat.isDirectory()) {
      const inside = walk(full);
      if (inside.length === 0) throw new PublishError(`${from} holds no files`);
      for (const f of inside) add(path.posix.join(from, f), path.posix.join(to, f));
    } else {
      add(from, path.posix.normalize(to));
    }
  }
  return [...files.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
}

// Semver precedence of two versions VERSION accepts: -1, 0 or 1. A pre-release is below its
// release (1.3.0-rc.1 < 1.3.0); its dot-separated parts compare as numbers when both are
// digits, a number is below a word, and more parts win when the rest are equal.
function compareVersions(a, b) {
  const split = (v) => {
    const dash = v.indexOf('-');
    return { core: (dash < 0 ? v : v.slice(0, dash)).split('.').map(BigInt), pre: dash < 0 ? null : v.slice(dash + 1).split('.') };
  };
  const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) {
    if (x.core[i] !== y.core[i]) return cmp(x.core[i], y.core[i]);
  }
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.min(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return cmp(BigInt(p), BigInt(q));
    if (pn !== qn) return pn ? -1 : 1;
    return cmp(p, q);
  }
  return cmp(x.pre.length, y.pre.length);
}

// The version a tag name `v<version>` names, or null when it names none.
function tagVersion(name) {
  return typeof name === 'string' && name.startsWith('v') && VERSION.test(name.slice(1)) ? name.slice(1) : null;
}

// The source's package.json with `version` written in, after `name`. The source keeps no
// version field, so nothing in the repo can disagree with the tag; one that appears is refused.
function withVersion(source, content, version) {
  let pkg;
  try {
    pkg = JSON.parse(content);
  } catch {
    throw new PublishError(`${source} is not valid JSON`);
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) throw new PublishError(`${source} must hold an object`);
  if ('version' in pkg) {
    throw new PublishError(`${source} has a version field, but the version is the release's (the newest CHANGELOG.md section): remove the field`);
  }
  const out = {};
  if (!('name' in pkg)) out.version = version;
  for (const [key, value] of Object.entries(pkg)) {
    out[key] = value;
    if (key === 'name') out.version = version;
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}

const CHANGELOG = 'CHANGELOG.md';
// The newest section of the changelog: `## [1.2.3] - date`, the topmost (a cut inserts above the others).
const SECTION = /^## \[?v?((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\]?(?:\s|$)/m;
const RELEASE_DIR = /^releases\/(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

function git(root, args, { allowFail = false } = {}) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (allowFail) return null;
    const detail = String(e.stderr || e.message || '').trim().split('\n')[0];
    throw new PublishError(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}

// The `releases/<tag>` folders in a commit's tree.
function releaseDirs(root, rev) {
  return git(root, ['ls-tree', '-d', '--name-only', rev, 'releases/'])
    .split('\n')
    .map((l) => RELEASE_DIR.exec(l.trim()))
    .filter(Boolean)
    .map((m) => m[1]);
}

/**
 * The version this publish carries: the release the merge brought. A release is the
 * newest `CHANGELOG.md` section plus its `releases/<tag>/` folder, and the merge brings
 * one when that folder is in the commit and not in the commit's first parent (the branch
 * before the merge). The checkout is the commit being published (`HEAD`), with the first
 * parent in its history.
 *
 * @returns {{version: string} | {version: null, refused: boolean, why: string}} no release
 *   (`refused: false`: nothing to publish) or a release that does not add up (`refused: true`)
 */
function releaseVersion(root) {
  let changelog;
  try {
    changelog = fs.readFileSync(path.join(root, CHANGELOG), 'utf8');
  } catch (e) {
    throw new PublishError(`cannot read ${CHANGELOG}: ${e.code || 'unreadable'}`);
  }
  const head = git(root, ['rev-parse', '--verify', 'HEAD^{commit}']).trim();
  const parent = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD^1^{commit}'], { allowFail: true });
  let before = [];
  if (parent) {
    before = releaseDirs(root, parent.trim());
  } else if (git(root, ['rev-parse', '--is-shallow-repository'], { allowFail: true }) === 'true\n') {
    throw new PublishError(`the checkout is shallow and has no parent of ${head.slice(0, 7)}, so it cannot tell which release this merge brought: check out with fetch-depth 2`);
  }
  const added = releaseDirs(root, head).filter((d) => !before.includes(d));
  // A re-ship (lib/reship.js) brings a release whose folder is already there: its merge adds
  // `releases/<tag>/reship-<run>.json` to it.
  if (parent) {
    for (const file of git(root, ['diff', '--diff-filter=A', '--name-only', '--no-renames', parent.trim(), head, '--', 'releases/']).split('\n')) {
      const m = /^releases\/([^/]+)\/reship-[1-9][0-9]*\.json$/.exec(file.trim());
      if (m && RELEASE_DIR.test(`releases/${m[1]}`) && !added.includes(m[1])) added.push(m[1]);
    }
  }
  if (added.length === 0) {
    return { version: null, refused: false, why: 'this merge brings no release: no new releases/<tag>/ folder or re-ship file since its first parent' };
  }
  const section = SECTION.exec(changelog.replace(/\r\n?/g, '\n'));
  if (!section) return { version: null, refused: true, why: `the merge adds ${added.join(', ')}, but ${CHANGELOG} has no version section` };
  const version = section[1];
  if (!added.includes(`v${version}`)) {
    return { version: null, refused: true, why: `the newest section of ${CHANGELOG} is ${version}, but the merge adds ${added.join(', ')}: the changelog and releases/ must name the same release` };
  }
  return { version };
}

module.exports = { PublishError, CONFIG, readConfig, publishSet, releaseVersion, safeRelative, compareVersions, tagVersion };
