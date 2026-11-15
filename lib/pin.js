'use strict';

// The code a repo's cut runs: the commit of turbot/shipyard-workflows its workflows call `cut.yml`
// at. The cut makes the facts and lints the prep file with that code, so the prep file has to be
// made, and linted, with it too. A prep job names it (lib/prep-job.js) and the README's hand
// route says how to find it. The files are read as text at the commit or ref asked for (a prep
// job reads them again on the branch, since the cut runs the pin the branch has when it starts),
// never run.

const { git } = require('./release-git');

const PUBLISHED = 'turbot/shipyard-workflows';
const CUT_CALL = new RegExp(`^[ \\t]*uses:[ \\t]*${PUBLISHED}/\\.github/workflows/cut\\.yml@([0-9a-f]{40})(?:[ \\t]+#[ \\t]*(\\S+))?[ \\t]*$`, 'gm');
// Where a repo's callers are: live ones, and ones parked for a person to move.
const FOLDERS = ['.github/workflows', '.github/pending'];

/**
 * The pin of the cut in the repo at `commit`: `{ sha, version, file }`, or `{ why }` when there is
 * none to name (no call of the published cut.yml, or callers that pin different commits).
 */
function cutPin(dir, commit) {
  const found = [];
  for (const folder of FOLDERS) {
    const listing = git(dir, ['ls-tree', '--name-only', commit, `${folder}/`], { allowFail: true });
    for (const file of (listing || '').split('\n').filter((f) => /\.ya?ml$/.test(f))) {
      const text = git(dir, ['show', `${commit}:${file}`], { allowFail: true });
      for (const m of String(text || '').matchAll(CUT_CALL)) found.push({ sha: m[1], version: m[2] && /^[A-Za-z0-9._+-]{1,30}$/.test(m[2]) ? m[2] : null, file });
    }
  }
  if (found.length === 0) return { why: `no workflow of the repo calls ${PUBLISHED} cut.yml at that commit` };
  const shas = [...new Set(found.map((f) => f.sha))];
  if (shas.length > 1) return { why: `the callers of cut.yml pin different commits (${shas.map((s) => s.slice(0, 7)).join(', ')})` };
  return found[0];
}

module.exports = { cutPin, PUBLISHED };
