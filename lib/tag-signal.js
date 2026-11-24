'use strict';

// Which signal tags a repo's release: the one its own workflows wire (docs/release-tag.md § The signal). The release PR's
// page says what a merge sets off, and that depends on the signal: a ship job that deploys then tags, a person's
// `/shipped` after steps done by hand, both, or the merge alone (a Go library). Reads git only: a workflow file is text
// here, never run.

const { workflowTexts } = require('./workflow-texts');
const { routedRepo, ownsFlow } = require('./routed');

// A caller's own `uses:` line, never a comment: the published tag.yml.
const CALLS_TAG = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?turbot\/shipyard-workflows\/\.github\/workflows\/tag\.yml@/m;
// The ship job's result is passed as `ship-result:`; the library's signal is `signal: merge`; a `/shipped` is an
// `issue_comment` trigger, as a key, a list item or in a flow list.
const SHIP_RESULT = /^[ \t]*ship-result:[ \t]*\S/m;
const SIGNAL_MERGE = /^[ \t]*signal:[ \t]*["']?merge["']?[ \t]*$/m;
const COMMENT_TRIGGER = /^[ \t]*issue_comment:|^[ \t]*-[ \t]+issue_comment[ \t]*$|^on:.*\bissue_comment\b/m;

// What the repo's own workflow files wire for the tag (a caller of the published tag.yml), as the signal or null.
function callerSignal(dir, rev) {
  const seen = { ship: false, shipped: false, merge: false };
  for (const raw of workflowTexts(dir, rev)) {
    const text = raw.replace(/^[ \t]*#.*$/gm, '').replace(/[ \t]+#.*$/gm, '');
    if (!CALLS_TAG.test(text)) continue;
    if (SHIP_RESULT.test(text)) seen.ship = true;
    if (COMMENT_TRIGGER.test(text)) seen.shipped = true;
    if (SIGNAL_MERGE.test(text)) seen.merge = true;
  }
  if (seen.merge) return seen.ship || seen.shipped ? null : 'merge';
  if (seen.ship && seen.shipped) return 'both';
  if (seen.ship) return 'ship-job';
  if (seen.shipped) return 'shipped';
  return null;
}

/**
 * Who tags the repo's release at `rev`, and by which signal: `{ via, signal }`.
 *
 * - `via: 'router'`: the repo holds `.github/shipyard.yml` and does not own `tag` (by its list or by a workflow of its own), so the router tags. Its signal comes
 *   from the kind: a go-library tags when its release PR merges (`merge`, the tag is the publish), every other kind
 *   ships first and tags on the ship job's success (`ship-job`). No kind, or one the router does not know, is null.
 * - `via: 'own'`: the repo holds `shipyard.yml` and lists `tag` under `own`, or a workflow of its own calls tag.yml (the router
 *   skips the tag then, lib/route.js): its own workflow tags, and its signal is read
 *   from that workflow's caller of the published tag.yml, as for a repo on callers (null when it shows none).
 * - `via: 'callers'`: the repo is still on `release.json`, and the signal is read from its callers.
 * - `via: null`: the repo is on `release.json` and no caller of tag.yml shows a signal (the signal is then null too).
 *
 * The signal is `ship-job`, `shipped` (a `/shipped` comment only), `both`, `merge`, or null when it cannot be told: the
 * page then says so and never guesses.
 */
function tagWiring(dir, rev) {
  const routed = routedRepo(dir, rev);
  if (routed && !ownsFlow(dir, rev, routed, 'tag')) {
    const signal = routed.kind === 'go-library' ? 'merge' : routed.kind ? 'ship-job' : null;
    return { via: 'router', signal };
  }
  const signal = callerSignal(dir, rev);
  if (routed) return { via: 'own', signal };
  return { via: signal ? 'callers' : null, signal };
}

// The signal alone, for the page of what a merge sets off (lib/changelog.js).
function tagSignal(dir, rev) {
  return tagWiring(dir, rev).signal;
}

module.exports = { tagSignal, tagWiring };
