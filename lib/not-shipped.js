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
// is no negation: a pattern starting with `!` is an error, never silently ignored.

class PatternError extends Error {}

function compilePattern(pattern) {
  if (typeof pattern !== 'string' || !pattern.trim()) throw new PatternError('a notShipped pattern must be a non-empty string');
  let p = pattern.trim().replace(/^(?:\.?\/)+/, '');
  if (p.startsWith('!')) throw new PatternError('a notShipped pattern cannot start with "!": negation is not supported');
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
  return new RegExp(`^${source}$`, 's');
}

/**
 * @param {string[]} patterns `notShipped` of `.github/release.json`
 * @returns {(path: string) => boolean} true when the path ships nothing
 */
function createMatcher(patterns) {
  if (!Array.isArray(patterns)) throw new PatternError('notShipped must be a list of patterns');
  const regexps = patterns.map(compilePattern);
  return (path) => regexps.some((re) => re.test(String(path).replace(/^(?:\.?\/)+/, '')));
}

/**
 * True when there is at least one file and every one of them matches. A PR with no files
 * listed is never "ships nothing": an empty list means the files are unknown.
 *
 * @param {string[]} patterns
 * @param {string[]} paths
 */
function shipsNothing(patterns, paths) {
  if (!patterns.length || !paths.length) return false;
  const matches = createMatcher(patterns);
  return paths.every(matches);
}

// Shipyard's own files ship nothing in any repo, with no setting: the release settings, and the
// changelog, which only the cut writes. A repo's `notShipped` adds its own paths to these.
const BUILT_IN = Object.freeze(['.github/release.json', 'CHANGELOG.md']);

module.exports = { PatternError, createMatcher, shipsNothing, BUILT_IN };
