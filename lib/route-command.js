'use strict';

// `shipyard route --event <name> --repo <owner>/<name> --area <area> --default-branch <branch> [--dir <checkout>]`:
// print, as JSON, the release flows to run for an event (lib/route.js). It reads the repo's `.github/shipyard.yml` and
// its workflow files at `--rev` (default HEAD) of the checkout, resolves the settings (lib/resolve.js), and never lists a
// flow the repo owns. The decision carries `inputs`, what the router's jobs pass to the flows that run (lib/router-inputs.js),
// with `--pr` the PR of a pull_request or pull_request_review event, and `--facts` a JSON file of what GitHub holds about the repo
// (description, homepage, license), which a Go CLI's Homebrew settings default to. Exit 0 with the decision printed (an empty `flows` list
// and a `message` when nothing runs), 2 when it could not decide: a malformed `args`, args that lack what a flow that runs
// needs (`pr`, or a prep's `commit` and `prep`), a repo with no `shipyard.yml`, a config that does not resolve, a bad option.

const fs = require('node:fs');
const path = require('node:path');
const { loadRepoConfigAt, YAML_FILE } = require('./repo-config');
const { resolveConfig, ConfigResolveError } = require('./resolve');
const { workflowFiles } = require('./workflow-texts');
const { route, ownedByWorkflows, RouteError } = require('./route');
const { routerInputs, ciWorkflowsOf } = require('./router-inputs');
const { ReleaseError, git } = require('./release-git');
const { FILE: GORELEASER_FILE } = require('./goreleaser');
const { parseOptions, need } = require('./release-args');

const USAGE = 'usage: shipyard route --event <name> --repo <owner>/<name> --area <area> --default-branch <branch> [--action <action>] [--args <json>] [--ref <ref>] [--base <branch>] [--pr <number>] [--dir <checkout>] [--rev <commit>] [--facts <file>]';
const FLAGS = {
  '--event': 'event',
  '--action': 'action',
  '--args': 'args',
  '--ref': 'ref',
  '--base': 'base',
  '--pr': 'pr',
  '--repo': 'repo',
  '--area': 'area',
  '--default-branch': 'defaultBranch',
  '--dir': 'dir',
  '--rev': 'rev',
  '--facts': 'facts',
};

// What GitHub holds about the repo that a setting may default to, from the JSON file `--facts` names: `{description, homepage,
// license}`, each a string or null (the router's `gh api repos/<repo> --jq` projection, which also holds the default branch and the
// area for its own shell, and route ignores them). A license
// GitHub could not name (`NOASSERTION`, `null`) is no license. No `--facts` is no facts; a file that cannot be read or is not that JSON is an error.
function readFacts(file) {
  if (!file) return {};
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new ReleaseError(`--facts ${file} is not the repo's facts as JSON: ${String(e.message).split('\n')[0]}`);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new ReleaseError(`--facts ${file} must hold a JSON map of description, homepage and license`);
  const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  const license = text(data.license);
  return { description: text(data.description), homepage: text(data.homepage), license: license && !/^NOASSERTION$/i.test(license) ? license : undefined };
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.', rev: 'HEAD' });
    if (opts.help) {
      out.write(`${USAGE}\n\nPrints the flows to run for the event as JSON: {event, action, branch, args, flows, skipped, afterShip, message, inputs}, inputs being what the router's jobs pass to the flows that run. A flow the repo owns (its \`own\` list, or a workflow of its own that runs it) is never listed. See README § The router's decision.\n`);
      return 0;
    }
    const event = need(opts, 'event', '--event');
    const repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!repo) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
    const area = need(opts, 'area', '--area');
    const defaultBranch = need(opts, 'defaultBranch', '--default-branch');
    const dir = path.resolve(opts.dir);

    // Warnings are the loader's own to print on the steps that read the file for its values; the router only reads `kind`
    // and the lists, so it says nothing of them.
    const loaded = loadRepoConfigAt({ dir, rev: opts.rev }, { warn: () => {} });
    if (loaded.file !== YAML_FILE) throw new ReleaseError(`${YAML_FILE} is not in ${opts.rev} of ${dir}: only a repo that holds it is routed`);
    const facts = { defaultBranch, ...readFacts(opts.facts) };
    const { settings } = resolveConfig(loaded.config, { repo, area, facts });
    const files = workflowFiles(dir, opts.rev);
    const owned = ownedByWorkflows(files.map((f) => f.text));

    const decision = route({
      event, action: opts.action, args: opts.args, ref: opts.ref, base: opts.base, settings, owned,
    });
    // The goreleaser file names the Homebrew archive when the config does not: read as text, from git, never run.
    const needsArchive = settings.kind === 'go-cli' && settings.homebrew && !settings.homebrew.archive;
    const goreleaser = needsArchive ? git(dir, ['show', `${opts.rev}:${GORELEASER_FILE}`], { allowFail: true }) || null : null;
    const inputs = routerInputs({
      decision, settings, repo, pr: opts.pr, ciWorkflows: ciWorkflowsOf(files), goreleaser, owned,
    });
    out.write(`${JSON.stringify({ ...decision, inputs }, null, 2)}\n`);
    return 0;
  } catch (e) {
    if (e instanceof RouteError || e instanceof ReleaseError || e instanceof ConfigResolveError) {
      const text = String(e.message).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ').replace(/^::/, ': :');
      err.write(`shipyard route: ${text}\n${e instanceof ReleaseError && /^(unknown option|unexpected argument|--)/.test(e.message) ? `${USAGE}\n` : ''}`);
      return 2;
    }
    throw e;
  }
}

module.exports = { run, USAGE };
