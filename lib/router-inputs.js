'use strict';

// What the jobs of `workflows/router.yml` take, from the router's decision (lib/route.js) and the repo's resolved settings
// (lib/resolve.js). The router's first job prints these as its outputs, and each later job passes them to the published workflow
// it calls, so a value a job needs is worked out, and checked, once, before any flow runs.
//
//   pr                  the release PR: a dispatch's `args.pr`, else the PR of the event. Needed by `record` and `gate`.
//   commit, prep        a `prep` dispatch's `args.commit` (the commit the prep job read) and `args.prep` (the prep file, as JSON)
//   approvers           the area's approver team, `<org>/<team>`, for the release check's `/level` comments
//   automation-logins   the org's one list of the accounts that open release PRs, comma-separated
//   candidate           the published workflow that builds and tests the candidate before the record, by kind: `go-cli`
//                       (go-cli-results.yml) or `go-library` (go-library-candidate.yml); empty for a kind with none, and when
//                       no record runs
//   binary, make-target, test-target, consumer
//                       that workflow's inputs: the program is named as the repo is; `build.make` and `build.test` of a
//                       go-cli; a go-library's first `consumers` entry, its main consumer
//   ci-workflows        the repo's workflow files that hold a job named `ci` (the `ci` contract), which the record runs on the
//                       release PR's head
//   tag-signal          for a push that tags: `merge` for a go-library (the tag is the publish), `ship-job` for every other kind (the ship
//                       job's result is what lets it tag); empty when no tag runs
//   ship-note           why the ship is not run although the router decided it, or empty: a Go CLI built with cgo needs a build image,
//                       which `shipyard.yml` cannot name yet, so it owns its `ship` until it can
//   tag-note            why no tag is made although the router decided it, or empty: a repo that owns its `ship` but not its `tag` has no
//                       result of that ship in this run, and a tag with none could tag a release that failed to ship, so it owns `tag`
//                       too, and tags in its own ship workflow once the ship passes
//   page-targets        where the changelog page may go, `<owner>/<name>:<folder>/` entries, comma-separated: the product's own site
//                       under `announce.page`; empty when the repo has no page
//   after-ship          the repo's `afterShip` workflow files, comma-separated, when that flow runs
//   product, floating-major, assets
//                       the tag's inputs: the product's name (empty: the repo's), whether `tag.floatingMajor` is on, and the artifact a
//                       go-cli's ship job uploads (`release-assets`; empty for every other kind). A `shipped` dispatch may name one
//                       of its own: `args.assets` with the `args.assets-run-id` of the run that uploaded it
//   shipped-assets-run-id
//                       that run id, or empty
//   announce-tag        an `announce` dispatch's `args.tag`, the release tag to announce
//   reship, fixes       a `reship` dispatch's `args.reship` (the version, X.Y.Z) and `args.fixes` (full commit ids, space-separated)
//   pre-branch, pre-version, pre-kind
//                       a `prerelease` dispatch's (a Go CLI's is refused: the router has no build for its files) `args.branch` (the work branch when absent), `args.version` and `args.pre`
//                       (`alpha`, `beta` or `rc`); its `args.commit` is `commit`
//   record-note         why the record is not run although the router decided it, or empty: the record reads the candidate's
//                       results, and Shipyard has no candidate build for every repo yet (a kind with no published candidate
//                       workflow, a Go CLI built with cgo, whose build image `shipyard.yml` cannot name). Such a repo owns its
//                       `record` until it has one
//
// A value that does not hold what the flow needs is a RouteError naming the input, so the router's first job fails and no
// flow runs. Nothing here reads a file, the clock or the network.

const { RouteError } = require('./route');
const { parseYaml } = require('./contract');

const SHA = /^[0-9a-f]{40}$/;
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A value shown in an error: one line, cut short, so an input never writes a workflow command or a long line.
const shown = (v) => String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').slice(0, 60);
const positive = (v) => Number.isSafeInteger(v) && v > 0;

// The flows that read the release PR's number, and must have it.
const NEEDS_PR = Object.freeze(['record', 'gate']);
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const RELEASE_TAG = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/;
const PRE_KINDS = Object.freeze(['alpha', 'beta', 'rc']);
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const MAX_FIXES = 100;
const WORKFLOW_FILE = /^[A-Za-z0-9._-]{1,100}\.ya?ml$/;
// The artifact a go-cli's ship job uploads, which the tag job attaches to the GitHub Release (go-cli-ship.yml `artifact`).
const SHIP_ARTIFACT = 'release-assets';
// The published workflow that makes a kind's candidate results before its record.
const CANDIDATES = Object.freeze({ 'go-cli': 'go-cli', 'go-library': 'go-library' });
// The two fixed files every repo holds: neither is the `ci` workflow, whatever it holds.
const FIXED_FILES = Object.freeze(['shipyard-pr.yml', 'shipyard-release.yml']);

/**
 * The workflow files that hold the `ci` job: a job whose id is `ci`, or whose `name:` is `ci`. A file that is not YAML, or not
 * a map of jobs, is passed over: it holds no job GitHub would run either.
 * @param {{file: string, text: string}[]} files  each workflow file of `.github/workflows`, by its name in that folder
 * @returns {string[]} the file names, sorted
 */
function ciWorkflowsOf(files) {
  const found = [];
  for (const { file, text } of files) {
    const name = String(file).split('/').pop();
    if (FIXED_FILES.includes(name)) continue;
    let jobs;
    try {
      jobs = parseYaml(String(text), name).get('jobs');
    } catch {
      continue;
    }
    if (!(jobs instanceof Map)) continue;
    for (const [id, job] of jobs) {
      if (id === 'ci' || (job instanceof Map && job.get('name') === 'ci')) {
        found.push(name);
        break;
      }
    }
  }
  return found.sort();
}

/**
 * @param {object} o
 * @param {{flows: string[], args?: object}} o.decision  what `route` decided
 * @param {object} o.settings     `resolveConfig`'s settings
 * @param {string} o.repo         `<owner>/<name>`
 * @param {number|string} [o.pr]  the PR of a pull_request or pull_request_review event
 * @param {string[]} [o.ciWorkflows]  `ciWorkflowsOf` of the repo's workflow files
 * @returns {Record<string, string>} the outputs, each a string, empty where the flows that run take none
 * @throws {RouteError}
 */
function routerInputs({ decision, settings, repo, pr, ciWorkflows = [] }) {
  const flows = decision.flows || [];
  const args = decision.args || {};
  const runs = (flow) => flows.includes(flow);
  const out = {
    pr: '',
    commit: '',
    prep: '',
    approvers: settings.approversTeam,
    'automation-logins': settings.openerLogins.join(','),
    candidate: '',
    binary: '',
    'make-target': '',
    'test-target': '',
    consumer: '',
    'ci-workflows': ciWorkflows.join(','),
    'record-note': '',
    'tag-signal': '',
    'ship-note': '',
    'tag-note': '',
    'after-ship': '',
    'page-targets': '',
    product: typeof settings.product === 'string' ? settings.product : '',
    'floating-major': String(Boolean(isObject(settings.tag) && settings.tag.floatingMajor === true)),
    assets: '',
    'shipped-assets-run-id': '',
    'announce-tag': '',
    reship: '',
    fixes: '',
    'pre-branch': '',
    'pre-version': '',
    'pre-kind': '',
  };

  // A dispatch names its PR in args; an event's PR is the event's own. A dispatch's args win over nothing else: a dispatch has no
  // event PR.
  let number = null;
  if (Object.hasOwn(args, 'pr')) {
    if (!positive(args.pr)) throw new RouteError(`args.pr must be the release PR's number, a positive whole number such as {"pr": 12}, not ${JSON.stringify(args.pr)}`);
    number = args.pr;
  } else if (pr !== undefined && pr !== null && pr !== '') {
    const n = typeof pr === 'number' ? pr : (/^[1-9][0-9]{0,9}$/.test(String(pr)) ? Number(pr) : NaN);
    if (!positive(n)) throw new RouteError(`the event's PR must be a positive whole number, not ${JSON.stringify(String(pr))}`);
    number = n;
  }
  const needing = NEEDS_PR.filter(runs);
  if (needing.length && number === null) {
    throw new RouteError(`args.pr is required: ${needing.join(' and ')} ${needing.length === 1 ? 'reads' : 'read'} the release PR, so give its number, such as {"pr": 12}`);
  }
  if (number !== null) out.pr = String(number);

  if (runs('prep')) {
    if (typeof args.commit !== 'string' || !SHA.test(args.commit)) {
      throw new RouteError('args.commit is required for prep: the full 40-character commit the prep job read, such as {"commit": "<sha>", "prep": {...}}');
    }
    if (!isObject(args.prep)) throw new RouteError('args.prep is required for prep: the prep file the prep run wrote, as a JSON object, such as {"commit": "<sha>", "prep": {...}}');
    out.commit = args.commit;
    out.prep = JSON.stringify(args.prep);
  }

  // A reship names the commit (the tip of the work branch the version merged from), the version and, when it has them, the fixes.
  if (runs('reship')) {
    if (typeof args.commit !== 'string' || !SHA.test(args.commit)) throw new RouteError('args.commit is required for reship: the full 40-character commit the re-ship is cut from, such as {"commit": "<sha>", "reship": "1.2.3"}');
    if (typeof args.reship !== 'string' || !VERSION.test(args.reship)) throw new RouteError(`args.reship is required for reship: the version to ship again, X.Y.Z, such as {"commit": "<sha>", "reship": "1.2.3"}, not ${JSON.stringify(shown(args.reship))}`);
    let fixes = [];
    if (Object.hasOwn(args, 'fixes')) {
      fixes = typeof args.fixes === 'string' ? args.fixes.split(/\s+/).filter(Boolean) : null;
      if (!fixes || fixes.length > MAX_FIXES || !fixes.every((f) => SHA.test(f))) throw new RouteError(`args.fixes must be full 40-character commit ids separated by spaces (at most ${MAX_FIXES}), not ${JSON.stringify(shown(args.fixes))}`);
    }
    out.commit = args.commit;
    out.reship = args.reship;
    out.fixes = fixes.join(' ');
  }

  // A prerelease names the commit, the version and the kind; the branch is the work branch unless given. Its Release carries the
  // build's files, which a repo's own job builds between the start and the publish: the router has no build to run there, so a
  // Go CLI, whose Release is its files, is refused rather than given an empty prerelease that takes an `rc` number.
  if (runs('prerelease')) {
    if (settings.kind === 'go-cli') {
      throw new RouteError('a prerelease of a Go CLI is not run here: its Release is its build files, and the router has no build to run between the start and the publish, so an empty prerelease would take the rc number. Start the repo\'s own prerelease workflow');
    }
    if (typeof args.commit !== 'string' || !SHA.test(args.commit)) throw new RouteError('args.commit is required for prerelease: the full 40-character commit, such as {"commit": "<sha>", "version": "1.5.0", "pre": "rc"}');
    if (typeof args.version !== 'string' || !VERSION.test(args.version)) throw new RouteError(`args.version is required for prerelease: the version still to come, X.Y.Z, not ${JSON.stringify(shown(args.version))}`);
    if (!PRE_KINDS.includes(args.pre)) throw new RouteError(`args.pre is required for prerelease: ${PRE_KINDS.join(', ')}, not ${JSON.stringify(shown(args.pre))}`);
    const branch = Object.hasOwn(args, 'branch') ? args.branch : settings.workBranch;
    if (typeof branch !== 'string' || !BRANCH.test(branch) || branch.includes('..')) throw new RouteError(`args.branch must be a branch name such as develop, not ${JSON.stringify(shown(branch))}`);
    out.commit = args.commit;
    out['pre-version'] = args.version;
    out['pre-kind'] = args.pre;
    out['pre-branch'] = branch;
  }

  // A shipped dispatch: the `/shipped` comment's PR and ID, which `shipyard tag` reads again from the event and checks; asked here
  // so a dispatch without them fails the first job, and the files of a run the repo's own ship uploaded (both or neither).
  if (runs('shipped') && decision.action === 'shipped') {
    for (const name of ['pr', 'comment']) {
      if (!positive(args[name])) throw new RouteError(`args.${name} is required for shipped: ${name === 'pr' ? "the release PR's number" : "the /shipped comment's ID"}, a positive whole number such as {"pr": 12, "comment": 345}, not ${JSON.stringify(shown(args[name]))}`);
    }
    const hasRun = Object.hasOwn(args, 'assets-run-id');
    const hasAssets = Object.hasOwn(args, 'assets');
    if (hasRun !== hasAssets) throw new RouteError('args.assets and args.assets-run-id go together: the artifact\'s name and the number of the run of this repo that uploaded it');
    if (hasAssets) {
      if (typeof args.assets !== 'string' || !/^[^\u0000-\u001f\u007f]{1,100}$/.test(args.assets)) throw new RouteError('args.assets is the name of one artifact, on one line');
      if (!positive(args['assets-run-id'])) throw new RouteError(`args.assets-run-id must be a run id, a positive whole number, not ${JSON.stringify(shown(args['assets-run-id']))}`);
      out.assets = args.assets;
      out['shipped-assets-run-id'] = String(args['assets-run-id']);
    }
  }

  // An announce dispatch names the tag to announce; one that follows a push takes it from the tag job.
  if (runs('announce') && decision.action === 'announce') {
    if (typeof args.tag !== 'string' || !RELEASE_TAG.test(args.tag)) throw new RouteError(`args.tag is required for announce: the release tag, such as {"tag": "v1.5.0"}, not ${JSON.stringify(shown(args.tag))}`);
    out['announce-tag'] = args.tag;
  }

  // What a push that ships and tags takes from the config.
  if (runs('tag') && decision.event === 'push') {
    out['tag-signal'] = settings.kind === 'go-library' ? 'merge' : 'ship-job';
    if (settings.kind === 'go-cli') out.assets = SHIP_ARTIFACT;
    if (out['tag-signal'] === 'ship-job' && (decision.skipped || []).some((k) => k.flow === 'ship' && /^owned/.test(k.why))) {
      out['tag-signal'] = '';
      out['tag-note'] = "the tag is not made here: this repo owns its ship, so no result of it reaches this run, and a tag made without one could tag a release that failed to ship. Own tag (own: [tag]) and tag in the ship workflow, with tag.yml, once the ship passes.";
    }
  }
  if (runs('tag') && decision.event === 'push' && Array.isArray(settings.pageTargets)) {
    out['page-targets'] = settings.pageTargets.map((t) => `${t.repo}:${t.folder}`).join(',');
  }
  if (runs('afterShip')) {
    const files = Array.isArray(settings.afterShip) ? settings.afterShip : [];
    if (!files.every((f) => typeof f === 'string' && WORKFLOW_FILE.test(f))) throw new RouteError('afterShip must list workflow file names, such as test.yml');
    out['after-ship'] = files.join(',');
  }

  const build = isObject(settings.build) ? settings.build : {};
  if (runs('ship') && settings.kind === 'go-cli') {
    if (build.cgo === true) {
      out['ship-note'] = "the ship is not run: a Go CLI built with cgo needs a build image, which .github/shipyard.yml cannot name yet. Own ship (own: [ship]) and run it from the repo's own workflow until it can.";
    } else {
      out['make-target'] = typeof build.make === 'string' ? build.make : '';
    }
  }
  if (runs('record') && !Object.hasOwn(CANDIDATES, settings.kind)) {
    out['record-note'] = `the record is not run: Shipyard has no candidate build for a ${settings.kind}, so the record would have no results. Own record (own: [record]) and run it from the repo's own workflow until it has one.`;
  } else if (runs('record') && settings.kind === 'go-cli' && build.cgo === true) {
    out['record-note'] = 'the record is not run: a Go CLI built with cgo needs a build image, which .github/shipyard.yml cannot name yet. Own record (own: [record]) and run it from the repo\'s own workflow until it can.';
  } else if (runs('record')) {
    out.candidate = CANDIDATES[settings.kind];
    if (settings.kind === 'go-cli') {
      out.binary = String(repo).split('/')[1] || '';
      out['make-target'] = typeof build.make === 'string' ? build.make : '';
      out['test-target'] = typeof build.test === 'string' ? build.test : '';
    } else {
      // An empty consumer fails the candidate with a message that names `consumers` (go-library-candidate.yml).
      out.consumer = Array.isArray(settings.consumers) && typeof settings.consumers[0] === 'string' ? settings.consumers[0] : '';
    }
  }
  return out;
}

module.exports = { routerInputs, ciWorkflowsOf, NEEDS_PR, FIXED_FILES };
