'use strict';

// The code a repo's cut runs: the commit of turbot/shipyard-workflows its workflows call `cut.yml`
// at. A caller names it as `@v<major>` (`@v0`, a tag each Shipyard release moves to its own commit:
// docs/pin-updates.md) or, in a repo that holds back, as a full commit. The cut makes the facts and
// lints the prep file with that code, so the prep file has to be made, and linted, with it too. A
// prep job names it (lib/prep-job.js) and the README's hand route says how to find it. The files
// are read as text at the commit or ref asked for (a prep job reads them again on the branch, since
// the cut runs the pin the branch has when it starts), never run. The commit a `@v<major>` tag names
// is read from turbot/shipyard-workflows, which is public.

const { git } = require('./release-git');
const {
  PUBLISHED, PUBLISHED_URL, TagsError, readTagCommits, versionAt,
} = require('./published-tags');

const SHA = /^[0-9a-f]{40}$/;
const CUT_CALL = new RegExp(`^[ \\t]*uses:[ \\t]*${PUBLISHED}/\\.github/workflows/cut\\.yml@([0-9a-f]{40}|v(?:0|[1-9][0-9]*))(?:[ \\t]+#[ \\t]*(\\S+))?[ \\t]*$`, 'gm');
// Where a repo's callers are: live ones first, then ones parked for a person to move.
const FOLDERS = ['.github/workflows', '.github/pending'];

/**
 * The pin of the cut in the repo at `commit`: `{ sha, version, file }`, or `{ why }` when there is
 * none to name (no call of the published cut.yml, or callers that use different refs). For a call at
 * a commit, `version` is the tag in its comment (null when there is none). For a call at `v<major>`,
 * `sha` is the commit that tag names now in `remote` and `version` the release tag naming that
 * commit; `ref` says which tag the callers use.
 *
 * @param {string} dir a checkout of the repo
 * @param {string} commit
 * @param {{ remote?: string }} [opts] where turbot/shipyard-workflows is read from (tests give a local repo)
 */
function cutPin(dir, commit, { remote = PUBLISHED_URL } = {}) {
  const found = [];
  const live = new Set();
  for (const folder of FOLDERS) {
    const listing = git(dir, ['ls-tree', '--name-only', commit, `${folder}/`], { allowFail: true });
    for (const file of (listing || '').split('\n').filter((f) => /\.ya?ml$/.test(f))) {
      // A copy parked for a person to move waits behind the live file of the same name: the live one is what runs.
      const name = file.slice(file.lastIndexOf('/') + 1);
      if (folder !== FOLDERS[0] && live.has(name)) continue;
      if (folder === FOLDERS[0]) live.add(name);
      const text = git(dir, ['show', `${commit}:${file}`], { allowFail: true });
      for (const m of String(text || '').matchAll(CUT_CALL)) {
        found.push({ ref: m[1], version: m[2] && /^[A-Za-z0-9._+-]{1,30}$/.test(m[2]) ? m[2] : null, file });
      }
    }
  }
  if (found.length === 0) return { why: `no workflow of the repo calls ${PUBLISHED} cut.yml at that commit` };
  const refs = [...new Set(found.map((f) => f.ref))];
  if (refs.length > 1) {
    const allShas = refs.every((r) => SHA.test(r));
    return { why: allShas
      ? `the callers of cut.yml pin different commits (${refs.map((r) => r.slice(0, 7)).join(', ')})`
      : `the callers of cut.yml use different refs (${refs.map((r) => (SHA.test(r) ? r.slice(0, 7) : r)).join(', ')})` };
  }
  const [{ ref, version, file }] = found;
  if (SHA.test(ref)) return { sha: ref, version, file };
  try {
    const tags = readTagCommits(remote);
    const sha = tags.get(ref);
    if (!sha) return { why: `the callers of cut.yml use ${ref}, and ${PUBLISHED} has no tag ${ref}` };
    return { sha, version: versionAt(tags, sha), file, ref };
  } catch (e) {
    if (!(e instanceof TagsError)) throw e;
    return { why: `the callers of cut.yml use ${ref}, and ${e.message}` };
  }
}

module.exports = { cutPin, PUBLISHED };
