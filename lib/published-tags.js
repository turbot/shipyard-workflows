'use strict';

// The tags of turbot/shipyard-workflows, read with `git ls-remote` (the repo is public, so no key is
// needed): which commit a release's tag names, and which commit the floating `v<major>` tag
// callers use names. `git ls-remote --tags` prints `<sha>\trefs/tags/<tag>`, and for an annotated
// tag a second `<sha>\trefs/tags/<tag>^{}` line holding the commit the tag object points at; that
// one wins.

const { execFileSync } = require('node:child_process');

const PUBLISHED = 'turbot/shipyard-workflows';
const PUBLISHED_URL = `https://github.com/${PUBLISHED}`;
const VERSION_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const MAJOR_TAG = /^v(?:0|[1-9]\d*)$/;
const TAG_LINE = /^refs\/tags\/(v[0-9.]+)(\^\{\})?$/;

class TagsError extends Error {}

// The output of `git ls-remote --tags` as a Map of tag name to the commit it names, for the tags
// that are a release (`v1.2.3`) or a floating major (`v1`).
function tagCommits(output) {
  const commits = new Map();
  const peeled = new Set();
  for (const line of String(output).split('\n')) {
    const [sha, ref] = line.trim().split(/\s+/);
    const m = TAG_LINE.exec(ref || '');
    if (!m || !/^[0-9a-f]{40}$/.test(sha) || !(VERSION_TAG.test(m[1]) || MAJOR_TAG.test(m[1]))) continue;
    if (m[2]) {
      commits.set(m[1], sha);
      peeled.add(m[1]);
    } else if (!peeled.has(m[1])) {
      commits.set(m[1], sha);
    }
  }
  return commits;
}

// The tags of `remote` (a URL, or a path to a repo), or a TagsError saying it could not read them.
function readTagCommits(remote = PUBLISHED_URL, { timeoutMs = 30000 } = {}) {
  try {
    const out = execFileSync('git', ['ls-remote', '--tags', remote], {
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, HOME: process.env.HOME, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' },
    });
    return tagCommits(out);
  } catch (e) {
    const detail = String(e.stderr || e.message || '').trim().split('\n')[0];
    throw new TagsError(`could not read the tags of ${PUBLISHED}${detail ? `: ${detail}` : ''}`);
  }
}

const parts = (tag) => VERSION_TAG.exec(tag).slice(1).map(BigInt);
const compareTags = (a, b) => {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
};

// The release tag (`v0.11.0`) that names `sha`: the newest when several do, null when none does.
function versionAt(commits, sha) {
  const found = [...commits].filter(([tag, at]) => at === sha && VERSION_TAG.test(tag)).map(([tag]) => tag);
  return found.length ? found.sort(compareTags).pop() : null;
}

module.exports = { PUBLISHED, PUBLISHED_URL, TagsError, readTagCommits, versionAt };
