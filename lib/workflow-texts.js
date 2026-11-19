'use strict';

// The text of each workflow file of a repo at a commit (`.github/workflows/*.yml` and `*.yaml`), read from git only: a
// workflow file is text here, never run. A parked file (`.github/pending/`) is not a workflow, so it is not read.

const { git } = require('./release-git');

const WORKFLOWS = '.github/workflows';

// The files' texts, or [] for a commit with no workflows or one that cannot be read.
function workflowTexts(dir, rev) {
  const listed = git(dir, ['ls-tree', '--name-only', rev, `${WORKFLOWS}/`], { allowFail: true });
  if (!listed) return [];
  const texts = [];
  for (const file of listed.split('\n').map((l) => l.trim()).filter((l) => /\.ya?ml$/.test(l))) {
    const text = git(dir, ['show', `${rev}:${file}`], { allowFail: true });
    if (text) texts.push(text);
  }
  return texts;
}

module.exports = { workflowTexts };
