'use strict';

// The five kind presets: what a repo's `kind` decides before its own `.github/shipyard.yml` says anything. A
// preset holds a default, never a trust value, and `resolveConfig` (lib/resolve.js) lays the file over it.
//
//   cadence   how often the central schedule starts the repo (the area gives the time and, for `weekly`, the day)
//   runs      the flows Shipyard has an implementation of for the kind. A kind with no `ship` has none to run: a Go
//             library's tag is its publish, and a service, a docs site and Shipyard itself deploy in the repo's own
//             workflows
//   own       the flows that are the repo's own whatever its file says. A file adds to this list, never takes from it
//   build     go-cli only: the file's `build` settings go over these
//   homebrew  go-cli only: a setting the file leaves out is the repo's own description, homepage or licence, which a
//             reader passes to `resolveConfig` as `facts` (GitHub holds them)
//
// The weekly defaults for `go-cli` and `go-library` and the daily defaults for the other three are the plan's choice
// (the epic 503 plan, item config-resolve); the README § The config file shows them in a table.

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
};

const KIND_PRESETS = deepFreeze({
  'go-cli': {
    cadence: 'weekly',
    runs: ['cut', 'record', 'ship', 'tag', 'shipped'],
    own: [],
    build: { cgo: false },
    homebrew: { desc: 'repo', homepage: 'repo', license: 'repo' },
  },
  'go-library': {
    cadence: 'weekly',
    runs: ['cut', 'record', 'tag', 'shipped'],
    own: [],
  },
  service: {
    cadence: 'daily',
    runs: ['cut', 'record', 'tag', 'shipped'],
    own: ['ship'],
  },
  'docs-site': {
    cadence: 'daily',
    runs: ['cut', 'record', 'tag', 'shipped'],
    own: ['ship'],
  },
  shipyard: {
    // Shipyard ships itself by `publish.yml`.
    cadence: 'daily',
    runs: ['cut', 'record', 'tag', 'shipped'],
    own: ['ship'],
  },
});

/** The preset of a kind, or null for a name that is no kind. */
const presetOf = (kind) => (typeof kind === 'string' && Object.hasOwn(KIND_PRESETS, kind) ? KIND_PRESETS[kind] : null);

module.exports = { KIND_PRESETS, presetOf };
