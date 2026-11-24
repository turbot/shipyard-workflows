'use strict';

// The one vendored runtime dependency: vendor/yaml/ holds the `yaml` package's published
// files, and vendor/yaml/VENDORED.json records what they are (the version, the tarball's
// integrity from package-lock.json, each file's sha256 as vendored, and each file edited to
// drop an email address). A workflow runs Shipyard from a plain checkout with no install step,
// so what runs is these bytes: this check fails when one of them changes.
//
// Local files only. The test (test/vendored.test.js) calls it on the repo and on a temp copy.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECORD = 'VENDORED.json';

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');

// Every file under `dir` (relative, `/`-separated, sorted), but the record. A symlink is
// refused: what it points at may be outside the folder.
function walk(dir, rel = '') {
  const out = [];
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) out.push({ file: child, symlink: true });
    else if (entry.isDirectory()) out.push(...walk(dir, child));
    else if (entry.isFile() && child !== RECORD) out.push({ file: child });
  }
  return out;
}

/**
 * Check a vendored package folder against its record.
 *
 * @param {string} dir a folder holding the package's files and VENDORED.json
 * @returns {{file: string, why: string}[]} one entry per file that is not as recorded
 */
function checkVendored(dir) {
  let record;
  try {
    record = JSON.parse(fs.readFileSync(path.join(dir, RECORD), 'utf8'));
  } catch (e) {
    return [{ file: RECORD, why: `cannot be read as JSON (${e.code || 'not valid JSON'})` }];
  }
  if (!record || typeof record !== 'object' || !record.files || typeof record.files !== 'object' || Array.isArray(record.files)) {
    return [{ file: RECORD, why: 'has no `files` object of sha256 digests' }];
  }
  const problems = [];
  const seen = new Set();
  for (const { file, symlink } of walk(dir)) {
    seen.add(file);
    if (symlink) {
      problems.push({ file, why: 'is a symlink: vendor only real files' });
    } else if (!(file in record.files)) {
      problems.push({ file, why: `is not in ${RECORD}` });
    } else if (sha256(fs.readFileSync(path.join(dir, file))) !== record.files[file]) {
      problems.push({ file, why: `differs from its digest in ${RECORD}` });
    }
  }
  for (const file of Object.keys(record.files)) {
    if (!seen.has(file)) problems.push({ file, why: `is in ${RECORD} but not in the folder` });
  }
  for (const e of Array.isArray(record.edited) ? record.edited : []) {
    if (!e || typeof e.file !== 'string' || !(e.file in record.files)) problems.push({ file: String(e && e.file), why: `is listed as edited in ${RECORD} but is not one of its files` });
  }
  return problems;
}

module.exports = { RECORD, sha256, checkVendored };
