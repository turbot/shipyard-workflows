'use strict';

// `shipyard route --event <name> --repo <owner>/<name> --area <area> --default-branch <branch> [--dir <checkout>]`:
// print, as JSON, the release flows to run for an event (lib/route.js). It reads the repo's `.github/shipyard.yml` and
// its workflow files at `--rev` (default HEAD) of the checkout, resolves the settings (lib/resolve.js), and never lists a
// flow the repo owns. The decision carries `inputs`, what the router's jobs pass to the flows that run (lib/router-inputs.js),
// with `--pr` the PR of a pull_request or pull_request_review event. Exit 0 with the decision printed (an empty `flows` list
// and a `message` when nothing runs), 2 when it could not decide: a malformed `args`, args that lack what a flow that runs
// needs (`pr`, or a prep's `commit` and `prep`), a repo with no `shipyard.yml`, a config that does not resolve, a bad option.

const path = require('node:path');
const { loadRepoConfigAt, YAML_FILE } = require('./repo-config');
const { resolveConfig, ConfigResolveError } = require('./resolve');
const { workflowFiles } = require('./workflow-texts');
const { route, ownedByWorkflows, RouteError } = require('./route');
const { routerInputs, ciWorkflowsOf } = require('./router-inputs');
const { ReleaseError } = require('./release-git');
const { parseOptions, need } = require('./release-args');

const USAGE = 'usage: shipyard route --event <name> --repo <owner>/<name> --area <area> --default-branch <branch> [--action <action>] [--args <json>] [--ref <ref>] [--base <branch>] [--pr <number>] [--dir <checkout>] [--rev <commit>]';
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
};

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
    const { settings } = resolveConfig(loaded.config, { repo, area, facts: { defaultBranch } });
    const files = workflowFiles(dir, opts.rev);
    const owned = ownedByWorkflows(files.map((f) => f.text));

    const decision = route({
      event, action: opts.action, args: opts.args, ref: opts.ref, base: opts.base, settings, owned,
    });
    const inputs = routerInputs({
      decision, settings, repo, pr: opts.pr, ciWorkflows: ciWorkflowsOf(files),
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
