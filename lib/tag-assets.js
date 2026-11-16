'use strict';

// The files a release carries, read from the folder the workflow downloaded the caller's artifact
// into. The artifact is data from the caller's ship job: it is read, never run, and a file that is
// not a plain file of a plain name in the folder itself is refused, so nothing outside the folder is
// ever read and no name can be a path. A refusal is made before the tag, so a release with no files
// (or files that cannot be attached) is never tagged.

const fs = require('node:fs');
const path = require('node:path');
const { Refusal, ReleaseError } = require('./release-git');

// GitHub keeps at most 1000 files on a Release.
const MAX_FILES = 1000;
const NAME = /^[A-Za-z0-9._+@=~-]{1,255}$/;

const quote = (value, max = 80) => {
  const text = JSON.stringify(String(value));
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
};

// The artifact's name, for messages. A single line, so it cannot break an annotation.
function checkArtifactName(name) {
  if (!/^[^\u0000-\u001f\u007f]{1,100}$/.test(String(name))) throw new ReleaseError('--assets is the name of one artifact, on one line');
}

/**
 * The files of the artifact `name`, in `dir`, as `[{ name, path, size }]` sorted by name.
 * Throws a Refusal naming the artifact when the folder is missing or empty, or holds something a
 * Release cannot carry (a folder, a link, a file with no content, a name GitHub would change).
 */
function loadAssets({ dir, name }) {
  const what = `the artifact ${quote(name)}`;
  const advice = 'Its upload must be a step of the ship job in this same workflow run, with files in it (docs/release-tag.md). This run changed nothing';
  checkArtifactName(name);
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ENOTDIR') throw new Refusal(`${what} is missing: the download found nothing to attach. ${advice}`);
    throw new ReleaseError(`cannot read the folder of ${what}: ${e.code || e.message}`);
  }
  if (!entries.length) throw new Refusal(`${what} is empty: the release has no files to attach. ${advice}`);
  if (entries.length > MAX_FILES) throw new Refusal(`${what} holds more than ${MAX_FILES} files, and a Release holds at most ${MAX_FILES}. This run changed nothing`);

  const files = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      throw new Refusal(`${what} has a folder, ${quote(entry.name)}: a Release holds its files flat. Upload the files alone (a path like dist/*). This run changed nothing`);
    }
    if (!entry.isFile()) throw new Refusal(`${what} has ${quote(entry.name)}, which is not a plain file (a link or a special file). This run changed nothing`);
    if (!NAME.test(entry.name) || entry.name === '.' || entry.name === '..') {
      throw new Refusal(`${what} has a file named ${quote(entry.name)}: a Release file's name is letters, digits and . _ + @ = ~ - only, up to 255 characters. This run changed nothing`);
    }
    const file = path.join(dir, entry.name);
    const size = fs.lstatSync(file).size;
    if (size === 0) throw new Refusal(`${what} has ${quote(entry.name)}, which is empty, and GitHub takes no empty file. This run changed nothing`);
    files.push({ name: entry.name, path: file, size });
  }
  const seen = new Set();
  for (const f of files) {
    const key = f.name.toLowerCase();
    if (seen.has(key)) throw new Refusal(`${what} has two files whose names differ only in case, ${quote(f.name)} among them, and GitHub keeps one. This run changed nothing`);
    seen.add(key);
  }
  return files.sort((a, b) => (a.name < b.name ? -1 : 1));
}

module.exports = { loadAssets, checkArtifactName, MAX_FILES };
