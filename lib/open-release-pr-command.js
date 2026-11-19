'use strict';

// `shipyard open-release-pr`: opens the release PR from the `release-pr` artifact `shipyard cut` wrote, for a repo whose PR the
// fleet's release-PR hook does not open (docs/release-cli.md, workflows/open-release-pr.yml). It reads the four files the hook
// reads, `branch`, `sha`, `title` and `body.md`, and opens the PR from the branch into the base with the job's own token.
//
// A PR made with that token starts no workflow of its own (GitHub never lets the job token start another run, except by
// `workflow_dispatch`), so the record and the checks the PR needs are started by name: `--record-workflow` is the repo's workflow
// that calls record.yml, which takes `workflow_dispatch` with the input `pr`.
//
// Run again, it opens no second PR: an open PR for the branch is used, and the record workflow is started for it again (a record
// is written again whenever it runs, so a start that failed the first time is finished by a run again). A branch that no longer holds the artifact's commit is refused: the artifact is of an earlier cut.
// Exit 0: the PR is open. 1: refused, nothing opened. 2: it could not run (run it again).

const fs = require('node:fs');
const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, need } = require('./release-args');

const USAGE = 'usage: shipyard open-release-pr --dir <release-pr artifact folder> [--base main] [--record-workflow <file>] [--repo <owner>/<name>]';
const FLAGS = {
  '--dir': 'dir', '--base': 'base', '--record-workflow': 'recordWorkflow', '--repo': 'repo',
};
const BRANCH = /^release\/(\d+\.\d+\.\d+)$/;

const readOne = (dir, name) => {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, name), 'utf8');
  } catch (e) {
    throw new ReleaseError(`the artifact has no ${name} (${e.code || e.message}): run the cut again`);
  }
  return text;
};

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { base: 'main' });
    if (opts.help) {
      out.write(`${USAGE}\n`);
      return 0;
    }
    const dir = need(opts, 'dir', '--dir');
    const repo = opts.repo || env.GITHUB_REPOSITORY;
    if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('--repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY)');
    if (!/^(main|main-\d+(\.\d+)?)$/.test(opts.base)) throw new ReleaseError('--base is main or main-<version>');
    if (opts.recordWorkflow && !/^[A-Za-z0-9._-]+\.ya?ml$/.test(opts.recordWorkflow)) throw new ReleaseError('--record-workflow is the file name of a workflow of this repo');

    const branch = readOne(dir, 'branch').trim();
    const sha = readOne(dir, 'sha').trim();
    const title = readOne(dir, 'title').trim();
    const body = readOne(dir, 'body.md');
    const m = BRANCH.exec(branch);
    if (!m) throw new ReleaseError(`the artifact's branch is not release/<version>: ${JSON.stringify(branch.slice(0, 40))}`);
    if (!/^[0-9a-f]{40}$/.test(sha)) throw new ReleaseError('the artifact\'s sha is not a full commit id');
    if (!/^Release \S+$/.test(title) || title.length > 100 || !title.endsWith(m[1])) throw new ReleaseError(`the artifact's title must be "Release <tag>" for ${m[1]}`);
    if (!body.includes(`<!-- shipyard:release-pr ${title.slice('Release '.length)} -->`)) throw new ReleaseError('the artifact\'s body has no release-pr marker for its tag');

    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl: env.GITHUB_API_URL });
    const tip = await github.getRefSha(repo, `heads/${branch}`);
    if (tip !== sha) throw new Refusal(`${branch} is ${tip ? tip.slice(0, 7) : 'not on the remote'}, not the ${sha.slice(0, 7)} the cut made: the artifact is of an earlier cut, so no PR is opened. Cut again`);

    const existing = (await github.listPullsByHead(repo, branch)).find((p) => p.state === 'open');
    let pr = existing && { number: existing.number, url: existing.html_url };
    if (pr) out.write(`The release PR for ${branch} is already open: #${pr.number}. No second one is opened.\n`);
    else {
      pr = await github.createPull(repo, { title, body, head: branch, base: opts.base });
      out.write(`Opened #${pr.number} ${pr.url}\n`);
    }
    if (opts.recordWorkflow) {
      // The PR's own workflows did not start, so the record is started by name on the release branch.
      try {
        await github.dispatchWorkflow(repo, opts.recordWorkflow, branch, { pr: String(pr.number) });
      } catch (e) {
        if (e instanceof GitHubError) throw new GitHubError(`#${pr.number} is open, but ${opts.recordWorkflow} could not be started on ${branch} (${e.status}): it must take workflow_dispatch with an input pr, and the job needs actions: write. Run this job again, or start it by hand`, e.status);
        throw e;
      }
      out.write(`Started ${opts.recordWorkflow} on ${branch} for #${pr.number}.\n`);
    }
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Open release PR::${escapeData(e.message)}\n`);
      err.write(`shipyard open-release-pr: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    out.write(`::error title=Open release PR::${escapeData(e.message)}\n`);
    err.write(`shipyard open-release-pr: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
