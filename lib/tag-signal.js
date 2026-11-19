'use strict';

// Which signal tags a repo's release: the one its own workflows wire (docs/release-tag.md § The signal). The release PR's
// page says what a merge sets off, and that depends on the signal: a ship job that deploys then tags, a person's
// `/shipped` after steps done by hand, both, or the merge alone (a Go library). Reads git only: a workflow file is text
// here, never run.

const { workflowTexts } = require('./workflow-texts');

// A caller's own `uses:` line, never a comment: the published tag.yml.
const CALLS_TAG = /^[ \t]*(?:-[ \t]+)?uses:[ \t]*["']?turbot\/shipyard-workflows\/\.github\/workflows\/tag\.yml@/m;
// The ship job's result is passed as `ship-result:`; the library's signal is `signal: merge`; a `/shipped` is an
// `issue_comment` trigger, as a key, a list item or in a flow list.
const SHIP_RESULT = /^[ \t]*ship-result:[ \t]*\S/m;
const SIGNAL_MERGE = /^[ \t]*signal:[ \t]*["']?merge["']?[ \t]*$/m;
const COMMENT_TRIGGER = /^[ \t]*issue_comment:|^[ \t]*-[ \t]+issue_comment[ \t]*$|^on:.*\bissue_comment\b/m;

/**
 * The signal the repo's workflows at `rev` wire for the tag: `ship-job`, `shipped` (a `/shipped` comment only), `both`,
 * or `merge`. null when it cannot be told: no workflow calls the published tag.yml, none shows a signal, or the
 * ones that do disagree (the merge alone beside another). The page then says so and never guesses.
 */
function tagSignal(dir, rev) {
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

module.exports = { tagSignal };
