'use strict';

// `shipyard push --branch release/<version>`: push a release candidate's branch to its remote
// with the job's own token, and check it landed. The cut never pushes and the fleet's hook never
// does either, so this is the one step that does.
//
// With `--artifact <dir>` (the cut's `--out`) the push is the cut's: the four files the hook reads
// must agree with each other and with the branch's tip, and the commit the facts read must be in
// the history of `--within`, the commit the run started from (the working branch); for a re-ship, the base
// it was cut from (`origin/<base>`). A leftover
// branch of that name from a closed candidate is replaced, and only the commit the checkout saw. Without `--artifact` the
// push is a fast-forward of the candidate (the record's evidence commit), and a branch that
// diverged is refused. Exit 0 when the remote holds the tip, 1 when refused, 2 when it could not run.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  ReleaseError, Refusal, git, resolveCommit, isAncestor,
} = require('./release-git');
const { parseOptions, need } = require('./release-args');
const { HOOK_FILES } = require('./cut');

const USAGE = 'usage: shipyard push --branch release/<version> [--dir <checkout>] [--remote <name>] [--artifact <release-pr dir>] [--within <ref>]';
const FLAGS = { '--branch': 'branch', '--dir': 'dir', '--remote': 'remote', '--artifact': 'artifact', '--within': 'within' };
const BRANCH = /^release\/(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// The token goes to git as an environment setting, never as an argument (a process list shows
// arguments) and never in the URL. It is the header `actions/checkout` itself would persist.
function authEnv(env) {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const base = { ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'true' };
  if (!token) return { env: base, token: null };
  const server = String(env.GITHUB_SERVER_URL || 'https://github.com').replace(/\/+$/, '');
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  return {
    token,
    env: { ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: `http.${server}/.extraheader`, GIT_CONFIG_VALUE_0: header },
  };
}

// git against the remote, with the token in the environment. Whatever git prints is scrubbed of it.
function remoteGit(dir, args, auth) {
  try {
    return execFileSync('git', ['-c', 'core.quotepath=off', ...args], {
      cwd: dir, encoding: 'utf8', env: auth.env, stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000,
    });
  } catch (e) {
    let detail = String(e.stderr || e.message || '').trim().split('\n').filter(Boolean).slice(-2).join(' / ');
    if (auth.token) detail = detail.split(auth.token).join('***');
    throw new ReleaseError(`git ${args[0]} failed${detail ? `: ${detail}` : ''}`);
  }
}

function remoteTip(dir, remote, branch, auth) {
  const out = remoteGit(dir, ['ls-remote', '--heads', remote, `refs/heads/${branch}`], auth).trim();
  const line = out.split('\n').find((l) => l.endsWith(`\trefs/heads/${branch}`));
  return line ? line.split('\t')[0] : null;
}

const readFile = (dir, name) => {
  try {
    return fs.readFileSync(path.join(dir, name), 'utf8');
  } catch (e) {
    throw new Refusal(`the artifact has no ${name} (${e.code || e.message}): run the cut again`);
  }
};

// The artifact is the cut's, whole: the hook's four files and release-pr.json say one thing.
function checkArtifact({ artifact, branch, tip, within, dir }) {
  for (const name of HOOK_FILES) readFile(artifact, name);
  let json;
  try {
    json = JSON.parse(readFile(artifact, 'release-pr.json'));
  } catch (e) {
    if (e instanceof Refusal) throw e;
    throw new Refusal('the artifact\'s release-pr.json is not valid JSON: run the cut again');
  }
  if (readFile(artifact, 'branch') !== branch || json.branch !== branch) {
    throw new Refusal(`the artifact is for another branch than ${branch}: run the cut again`);
  }
  if (readFile(artifact, 'sha') !== tip || json.commit !== tip) {
    throw new Refusal(`the artifact's sha is not ${branch}'s tip (${tip.slice(0, 7)}): run the cut again`);
  }
  if (readFile(artifact, 'title') !== json.title) throw new Refusal('the artifact\'s title and release-pr.json disagree: run the cut again');
  if (!/^[0-9a-f]{40}$/.test(String(json.cutFrom))) throw new Refusal('the artifact names no commit the cut was made from: run the cut again');
  if (within) {
    const at = resolveCommit(dir, within);
    if (!isAncestor(dir, json.cutFrom, at)) {
      throw new Refusal(`the release was cut from ${json.cutFrom.slice(0, 7)}, which is not in the history of ${within}: a release is cut from the working branch`);
    }
  }
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.', remote: 'origin' });
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-cut.md for what the push checks.\n`);
      return 0;
    }
    const branch = need(opts, 'branch', '--branch');
    if (!BRANCH.test(branch)) throw new Refusal(`${JSON.stringify(branch)} is not a release branch (release/X.Y.Z)`);
    if (/^-/.test(opts.remote) || /[\r\n]/.test(opts.remote)) throw new ReleaseError(`--remote must be a remote's name, not ${JSON.stringify(opts.remote)}`);
    const dir = path.resolve(opts.dir);
    const auth = authEnv(env);

    const tipOut = git(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { allowFail: true });
    if (!tipOut) throw new Refusal(`${branch} is not a branch of this checkout: nothing to push`);
    const tip = tipOut.trim();
    if (opts.artifact) checkArtifact({ artifact: path.resolve(opts.artifact), branch, tip, within: opts.within, dir });
    else if (opts.within) throw new ReleaseError('--within needs --artifact');

    const before = remoteTip(dir, opts.remote, branch, auth);
    if (before === tip) {
      out.write(`${branch} is already at ${tip.slice(0, 7)} on ${opts.remote}: nothing to push.\n`);
      return 0;
    }
    const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
    if (before === null) {
      remoteGit(dir, ['push', '--quiet', opts.remote, refspec], auth);
    } else if (git(dir, ['cat-file', '-e', `${before}^{commit}`], { allowFail: true }) !== null && isAncestor(dir, before, tip)) {
      remoteGit(dir, ['push', '--quiet', opts.remote, refspec], auth);
    } else if (opts.artifact) {
      // `cut` refused a branch that no closed candidate owns, so what it saw on the remote was a
      // closed candidate's leftover. Replace exactly that commit: a branch that appeared, or moved,
      // since the checkout last read the remote was never vetted, and is never overwritten.
      const seen = git(dir, ['rev-parse', '--verify', '--quiet', `refs/remotes/${opts.remote}/${branch}^{commit}`], { allowFail: true });
      if (!seen || seen.trim() !== before) {
        throw new Refusal(`${branch} on ${opts.remote} (${before.slice(0, 7)}) is not the branch this checkout saw${seen ? ` (${seen.trim().slice(0, 7)})` : ' (it had none)'}: it appeared or moved since, so nothing was pushed`);
      }
      remoteGit(dir, ['push', '--quiet', `--force-with-lease=refs/heads/${branch}:${before}`, opts.remote, refspec], auth);
    } else {
      throw new Refusal(`${branch} on ${opts.remote} (${before.slice(0, 7)}) is not in this branch's history: it moved, so nothing was pushed`);
    }

    const after = remoteTip(dir, opts.remote, branch, auth);
    if (after !== tip) throw new ReleaseError(`pushed ${branch}, but ${opts.remote} holds ${after ? after.slice(0, 7) : 'no such branch'}, not ${tip.slice(0, 7)}`);
    out.write(`Pushed ${branch} at ${tip.slice(0, 7)} to ${opts.remote}.\n`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      err.write(`shipyard push: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError)) throw e;
    err.write(`shipyard push: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE, authEnv };
