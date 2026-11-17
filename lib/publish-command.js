'use strict';

// `shipyard publish`: copy this repo's public files to turbot/shipyard-workflows as one
// commit on its branch, and tag that commit `v<version>`, the version of the release the
// merge brought (releaseVersion in publish.js: the newest CHANGELOG.md section, with its
// releases/<tag>/ folder new in the merge). package.json holds no version: it is written
// into the published copy. A merge that brings no release publishes nothing.
//
// Run by the publish job on `main`, with a token minted from Shipyard's release App. In order,
// and no commit, branch or tag is written until these four have passed:
//   1. the private-data check, on exactly the files it is about to write;
//   2. the token's reach: the repos it can reach must be exactly publish.json's `repo`;
//   3. the version: nothing newer is published already, as a tag or as the branch's tip (a
//      re-run of an older publish would put older files on top of a newer release);
//   4. the tag: a tag that already names another commit is never moved.
// Then it writes the tree, the commit, the branch and the tag through the API, so the
// commit is GitHub's own and needs no git or key on the runner. Last, it points `v<major>`
// (`v0` for 0.x) at the same commit: the ref every caller of the published workflows uses
// (docs/pin-updates.md). See moveMajor. The tree is written before
// the last check (a tag at the tip whose files have changed), which needs its sha; a tree no
// commit uses changes nothing anyone sees.
//
// Exit 0: published, already published, or a merge with no release to publish. Exit 1:
// refused (private data, the token's reach, a changelog and releases/ folder that name
// different versions, a newer version already published, a tag already used). Exit 2: it
// could not run (no token, a bad config, a package.json with a version field of its own, a
// checkout too shallow to see the first parent, an API error).

const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { PublishError, CONFIG, readConfig, publishSet, releaseVersion, compareVersions, tagVersion } = require('./publish');
const { RulesError, checkFiles } = require('./private-data');
const { parseArgs, report, escapeData, UsageError } = require('./private-data-command');

const USAGE = 'usage: shipyard publish [--root <checkout>] [--config <publish.json>] [--source-sha <commit>]';

// Points `v<major>` at `commit`, the commit `v<version>` names: made when it does not exist, moved
// when it names an older release, left alone when it already names the commit or a newer release
// (it is never moved back). A GitHub Release is never made for it, since a release makes its tag
// immutable. The rule that a tag naming another commit is never moved holds for `v<version>` only.
async function moveMajor({ github, repo, version, commit, say }) {
  const major = version.split('.')[0];
  const name = `v${major}`;
  const at = await github.getRefSha(repo, `tags/${name}`);
  if (at === null) {
    await github.createTag(repo, name, commit);
    say(`Made ${name} at ${commit}.`);
    return;
  }
  if (at === commit) {
    say(`${name} already names ${commit}.`);
    return;
  }
  // The release `at` holds: the version tags that name it, and the version its commit was published as.
  const tags = await github.listTagCommits(repo);
  const held = tags.filter((t) => t.sha === at).map((t) => tagVersion(t.name));
  held.push(tagVersion((/^Publish (\S+)(?:\n|$)/.exec((await github.getCommit(repo, at)).message) || [])[1]));
  const newest = held.filter(Boolean).sort(compareVersions).pop();
  if (newest && compareVersions(newest, version) > 0) {
    say(`${name} names ${at}, which is v${newest}, newer than v${version}: left where it is, never moved back.`);
    return;
  }
  await github.moveTag(repo, name, commit);
  say(`Moved ${name} from ${at} to ${commit}${newest ? ` (was v${newest})` : ''}.`);
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  const refuse = (text) => {
    say(`::error title=Publish::${escapeData(text)}`);
    say('Nothing was published: no commit, branch or tag was written.');
    return 1;
  };

  try {
    const opts = parseArgs(argv, ['--root', '--config', '--source-sha']);
    const root = path.resolve(opts.root || '.');
    const config = readConfig(root, opts.config ? path.resolve(opts.config) : path.join(root, CONFIG));
    // The release this merge brought, before anything else: no release, nothing to publish.
    const release = releaseVersion(root);
    if (release.version === null) {
      if (release.refused) return refuse(release.why);
      say(`No release to publish: ${release.why}.`);
      say('Nothing was published: no commit, branch or tag was written.');
      return 0;
    }
    const version = release.version;
    const tag = `v${version}`;
    const sourceSha = opts['source-sha'] || env.GITHUB_SHA || null;
    if (sourceSha !== null && !/^[0-9a-f]{40}$/.test(sourceSha)) throw new UsageError('--source-sha must be a 40-character commit');

    // 1. Private data, on the very files below.
    const files = publishSet(root, config, { version });
    const problems = checkFiles(files, config.privateData);
    if (problems.length) {
      say(`Private data check refused: ${problems.length} finding${problems.length === 1 ? '' : 's'} in the files for ${config.repo}`);
      report(problems, { out, env, title: 'Private data' });
      return refuse('The files to publish hold private data. Remove it, then publish again.');
    }
    say(`Private data check OK: ${files.length} files.`);

    const token = env.GITHUB_TOKEN;
    if (!token) throw new UsageError('no GITHUB_TOKEN: the release App token is needed');
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL });

    // 2. The token reaches the public copy and nothing else. Never name what else it
    // reaches: those may be private repos.
    const reach = await github.installationRepos();
    const target = config.repo.toLowerCase();
    if (reach.length !== 1 || reach[0].toLowerCase() !== target) {
      const found = reach.some((r) => r.toLowerCase() === target)
        ? `${reach.length} repositories: ${config.repo} and ${reach.length - 1} more`
        : `${reach.length} repositor${reach.length === 1 ? 'y' : 'ies'}, and ${config.repo} is not one of them`;
      return refuse(`The publish token reaches ${found}. It must reach exactly ${config.repo} and nothing else: check the App's installation.`);
    }
    say(`The token reaches exactly ${config.repo}.`);

    // 3. The version. A newer release already there, tagged or (after a run that stopped
    // before its tag) only at the branch's tip, means this is an older publish run again.
    const head = await github.getRefSha(config.repo, `heads/${config.branch}`);
    if (!head) throw new PublishError(`${config.repo} has no branch ${config.branch}`);
    const headCommit = await github.getCommit(config.repo, head);
    const tipVersion = tagVersion((/^Publish (\S+)(?:\n|$)/.exec(headCommit.message) || [])[1]);
    const newer = (await github.listTags(config.repo))
      .map(tagVersion)
      .concat(tipVersion ? [tipVersion] : [])
      .filter((v) => v && compareVersions(v, version) > 0)
      .sort(compareVersions)
      .pop();
    if (newer) {
      return refuse(`v${newer} is already published, newer than ${tag}: publishing ${tag} now would put older files on top of it. Publish from the newest ${config.branch} instead, or cut a release above v${newer}.`);
    }

    // 4. The tag.
    const tagged = await github.getRefSha(config.repo, `tags/${tag}`);
    if (tagged && tagged !== head) {
      return refuse(`${tag} is already published at another commit, and a tag is never moved. Cut a new release, then publish again.`);
    }

    // Write. The tree is whole (no base tree): a file no longer published is deleted.
    const tree = await github.createTree(config.repo, files.map((f) => ({ path: f.path, mode: f.mode, type: 'blob', content: f.content })));
    if (tree === headCommit.tree) {
      if (tagged) {
        say(`Already published: ${tag} is ${head} and holds these files.`);
        await moveMajor({ github, repo: config.repo, version, commit: head, say });
        return 0;
      }
      await github.createTag(config.repo, tag, head);
      say(`Nothing changed since ${head}; tagged it ${tag}.`);
      await moveMajor({ github, repo: config.repo, version, commit: head, say });
      return 0;
    }
    if (tagged) {
      return refuse(`${tag} is already published, and the files have changed since. Cut a new release, then publish again.`);
    }
    const message = `Publish ${tag}${sourceSha ? `\n\nSource commit: ${sourceSha}` : ''}\n`;
    const commit = await github.createCommit(config.repo, { message, tree, parents: [head] });
    await github.updateBranch(config.repo, config.branch, commit);
    await github.createTag(config.repo, tag, commit);
    say(`Published ${tag} to ${config.repo} at ${commit}.`);
    await moveMajor({ github, repo: config.repo, version, commit, say });
    return 0;
  } catch (e) {
    if (!(e instanceof UsageError || e instanceof PublishError || e instanceof RulesError || e instanceof GitHubError)) throw e;
    say(`::error title=Publish::${escapeData(e.message)}`);
    err.write(`shipyard publish: ${e.message}\n`);
    if (e instanceof UsageError) err.write(`${USAGE}\n`);
    return 2;
  }
}

module.exports = { run, USAGE };
