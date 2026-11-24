'use strict';

// A partial clone of a product repo for the central schedule's exact check: every commit, branch and tag, no file
// content. Git fetches a file's content on demand (a blob a check reads, as `.github/shipyard.yml`), so the clone
// stays small. The token travels as an HTTP header, never in a URL or an argument: the clone command reads it from
// the environment, and the clone's own config keeps it (in a file only this user reads) for the on-demand fetches.
// The caller removes the folder when the check is done.

const fs = require('node:fs');
const path = require('node:path');
const { ReleaseError, git } = require('./release-git');

const REPO = /^(?![.-])[A-Za-z0-9_.-]+\/(?![.-])[A-Za-z0-9_.-]+$/;
const CLONE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * @param {object} opts
 * @param {string} opts.repo         `<owner>/<name>`
 * @param {string} opts.dir          an empty folder
 * @param {string} opts.token
 * @param {string} [opts.serverUrl]  `https://github.com` unless the run says otherwise (`GITHUB_SERVER_URL`)
 */
function partialClone({ repo, dir, token, serverUrl = 'https://github.com' }) {
  if (!REPO.test(repo)) throw new ReleaseError(`${JSON.stringify(String(repo).slice(0, 80))} is not a repo name to clone`);
  if (!token) throw new ReleaseError('no token to clone with');
  const base = String(serverUrl).replace(/\/+$/, '');
  const header = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  const key = `http.${base}/.extraheader`;
  git(dir, ['clone', '--quiet', '--filter=blob:none', '--no-checkout', '--', `${base}/${repo}.git`, '.'], {
    timeout: CLONE_TIMEOUT_MS,
    env: {
      GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: key, GIT_CONFIG_VALUE_0: header,
    },
  });
  // The on-demand fetches that come later need the header again. Written to the file, not passed in an argument; the
  // caller's folder is a private temporary one (mkdtemp, mode 0700), so the file is no one else's to read.
  const config = path.join(dir, '.git', 'config');
  fs.appendFileSync(config, `[http "${base}/"]\n\textraheader = ${header}\n`);
  return dir;
}

module.exports = { partialClone, REPO };
