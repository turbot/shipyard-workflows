'use strict';

// The version of the Shipyard that is running, for a cut to write into its release data. `shipyard publish`
// writes the version into the `package.json` of the published copy (lib/publish.js `withVersion`), and every
// published step runs from that copy; this repo's own `package.json` has no version, so a run from a checkout
// (by hand, or in a test) has none and gets null. It lives here, not in lib/cut.js, because that file never
// reads `package.json`: the version is never set by hand, and reading the published one sets nothing.
//
// Every step that reads a release's data checks the Shipyard that cut it against this one (`cutterRefusal`, run by
// lib/release-data.js): a release cut by the previous minor version is finished, and one cut two or more back is refused.

const fs = require('node:fs');
const path = require('node:path');

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

// The Shipyard that cut a release whose data names none: a payload with no `shipyard` key, or a release cut before
// the data rode in the body (its files are under `releases/<tag>/`). It is v0.32.0, the last release before the one
// that ships this check, so every release cut then counts as cut by it, or by an older one we cannot tell apart.
const UNNAMED_CUTTER = 'v0.32.0';

/**
 * `v<version>` from `<root>/package.json`, or null when there is no file, no `version` or a bad one.
 *
 * @param {string} [root] defaults to the folder above `lib/`
 */
function ownTag(root = path.join(__dirname, '..')) {
  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  const version = pkg && typeof pkg === 'object' ? pkg.version : undefined;
  return typeof version === 'string' && VERSION.test(version) ? `v${version}` : null;
}

// The major and minor of a tag such as v0.33.0, or null for anything else.
function majorMinor(tag) {
  const m = typeof tag === 'string' ? TAG.exec(tag) : null;
  return m ? { major: Number(m[1]), minor: Number(m[2]) } : null;
}

/**
 * The Shipyard that runs, for a step to check a release's cutter against: `io.shipyardTag` when `io` has that key
 * (a test stands in for the published version with it), else `ownTag()`. Null when unknown.
 */
function currentOf(io = {}) {
  return io && Object.hasOwn(io, 'shipyardTag') ? io.shipyardTag : ownTag();
}

/**
 * Why a release cut by `cutter` is not read by the Shipyard `current`, or null when it is read. `cutter` is the release
 * data's `shipyard` value (`{ tag, commit }`), or its tag on its own. A release whose data names no cutter (no key,
 * undefined or null) counts as cut by UNNAMED_CUTTER; a key whose `tag` is null (a cut run from a checkout) is read.
 * A release cut by a different major, or two or more minor versions back, is refused; the patch is ignored, and a
 * newer cutter is read (a caller held back to an older Shipyard still finishes its release). Nothing is refused when
 * `current` is unknown, a run from a checkout. Every published run knows its version.
 *
 * @returns {string | null} the message of the Refusal
 */
function cutterRefusal({ cutter, current, prNumber }) {
  const now = majorMinor(current);
  if (!now) return null;
  const unnamed = cutter === undefined || cutter === null;
  let tag;
  if (unnamed) tag = UNNAMED_CUTTER;
  else if (typeof cutter === 'string') tag = cutter;
  else if (typeof cutter === 'object') tag = cutter.tag;
  // A cut run from a checkout knows no version, and a key of another shape is the format check's to refuse.
  const then = majorMinor(tag);
  if (!then) return null;
  if (then.major === now.major && now.minor - then.minor < 2) return null;
  const by = unnamed ? `${UNNAMED_CUTTER} or older (its release data names no Shipyard version)` : tag;
  return `#${prNumber} was cut by Shipyard ${by}, and this is Shipyard ${current}: a release cut two or more minor versions back is not read, so nothing was done with it. Cut the release again: the new cut takes the next free number`;
}

module.exports = {
  ownTag, currentOf, cutterRefusal, UNNAMED_CUTTER,
};
