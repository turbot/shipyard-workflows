'use strict';

// The `notShipped` matcher: which paths of a repo ship nothing. Pure: no network and no files.
// The list is BUILT_IN (below) and the repo's own `notShipped` patterns in `.github/release.json`. The
// changelog-line check uses it today; the starts (C1) and the facts (S3) use the same
// patterns and must use this module, so all three agree on what ships.
//
// A pattern is matched against the whole repo-relative path, with `/` separators:
//   `*`   any run of characters inside one path segment
//   `**`  any run of characters, across segments; `**/` also matches no directory at all
//   `?`   one character inside a segment
//   a trailing `/` means everything under that folder (`docs/` is `docs/**`)
// Everything else is literal and case-sensitive. A leading `./` or `/` is dropped. There
// is no negation in a repo's `notShipped`; a repo's `shipped` list names paths that ship although `notShipped`
// matches them (changelog-line-command.js `notShippedOf`). They reach this module as `!` patterns, and the
// LAST pattern that matches a path decides, so `docs/` then `!docs/api.md` leaves `docs/api.md` shipped
// (as in a .gitignore). A `!` pattern that matches nothing changes nothing. `!!x` and a bare `!` are
// errors, never silently ignored.

class PatternError extends Error {}

function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new PatternError('a notShipped pattern must be a non-empty string');
  let p = pattern.trim().replace(/^(?:\.?\/)+/, '');
  const negate = p.startsWith('!');
  if (negate) p = p.slice(1).replace(/^(?:\.?\/)+/, '');
  if (p.startsWith('!')) throw new PatternError('a notShipped pattern cannot start with "!!"');
  if (p.endsWith('/')) p += '**';
  if (!p) throw new PatternError('a notShipped pattern must name a path');

  let source = '';
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === '*') {
      if (p[i + 1] === '*') {
        if (p[i + 2] === '/') {
          source += '(?:.*/)?';
          i += 2;
        } else {
          source += '.*';
          i += 1;
        }
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }
  }
  return { re: new RegExp(`^${source}$`, 's'), negate };
}

/**
 * @param {string[]} patterns `notShipped` of `.github/release.json`, in order (the last match wins)
 * @returns {(path: string) => boolean} true when the path ships nothing
 */
function createMatcher(patterns) {
  if (!Array.isArray(patterns)) throw new PatternError('notShipped must be a list of patterns');
  const compiled = patterns.map(compilePattern);
  return (path) => {
    const clean = String(path).replace(/^(?:\.?\/)+/, '');
    let hit = false;
    for (const { re, negate } of compiled) {
      if (re.test(clean)) hit = !negate;
    }
    return hit;
  };
}

/**
 * True when every path matches the patterns, so an empty list is true: a PR whose file list was
 * read in full and holds no file (a merge commit whose net diff is empty) changes nothing.
 * `prShipsNothing` does not ask when GitHub cut the list short.
 *
 * @param {string[]} patterns
 * @param {string[]} paths
 */
function shipsNothing(patterns, paths) {
  if (!patterns.length) return false;
  const matches = createMatcher(patterns);
  return paths.every(matches);
}

// Shipyard's own files ship nothing in any repo, with no setting: the release settings (the old `.github/release.json`
// and the new `.github/shipyard.yml`) and the changelog, which only the cut writes. A repo's `notShipped` adds its own paths to these.
const BUILT_IN = Object.freeze(['.github/release.json', '.github/shipyard.yml', 'CHANGELOG.md']);

module.exports = { PatternError, createMatcher, shipsNothing, BUILT_IN };
