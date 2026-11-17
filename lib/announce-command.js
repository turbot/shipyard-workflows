'use strict';

// `shipyard announce --output page|post|comments`: one of the three things that follow a release
// tag (docs/release-announce.md):
//   page      opens the changelog page PR on the product's site repo and merges it as the release bot
//   post      posts the one #releases line, for a product with no page
//   comments  comments "Live in <tag>" on each issue the release closes, then closes the repo's open prep
//             jobs the release shipped (a failure there is a warning, never a failed Announce)
// The tag comes from `--tag`, or from a `push` of a tag ($GITHUB_EVENT_PATH). The release is read from
// GitHub, never from the event. A release with no release notes gets no page and no post.
//
// An output that fails files a Bug in the product repo and exits 0: it never fails the release. A run
// again finds what was done and does the rest, and closes the Bug when it works.
// Exit 0 when the output is done, skipped, or failed with its Bug filed; 1 when the tag is no release
// that can be announced (nothing was written); 2 when it could not run (a bad option, a missing token,
// a failed call before an output starts, a Bug that could not be filed).

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { createSlackClient, SlackError } = require('./slack');
const { escapeData } = require('./changelog-line-command');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions, readJson } = require('./release-args');
const { show } = require('./tag');
const {
  OUTPUTS, findRelease, parseAnnounce, parseTargets, checkTarget, pagePath, parseNotes, retrying, isFailure, trustedLogins, openPage, postLine, liveInComments, closeShippedJobs, fileBug, settleBug, oneLine,
} = require('./announce');

const USAGE = 'usage: shipyard announce --output page|post|comments --automation-logins <a,b> [--tag <tag> | --event <event.json>] [--tag-prefix <prefix>] [--page-targets <owner/name:folder/,...>] [--slack-channel <#channel>]';
const FLAGS = {
  '--output': 'output', '--tag': 'tag', '--event': 'event', '--tag-prefix': 'tagPrefix', '--automation-logins': 'automationLogins', '--page-targets': 'pageTargets', '--slack-channel': 'slackChannel',
};
const REPO = /^[^/\s]+\/[^/\s]+$/;
const CHANNEL = /^(#[a-z0-9._-]{1,80}|[CG][A-Z0-9]{6,20})$/i;

// A missing token or a bad setup of the caller: the job is red, because nothing was tried.
class SetupError extends ReleaseError {}

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);

function checkOptions(opts) {
  if (!OUTPUTS.includes(opts.output)) throw new ReleaseError(`--output is required: one of ${OUTPUTS.join(', ')}`);
  if (!/^[A-Za-z0-9._-]*$/.test(opts.tagPrefix)) throw new ReleaseError(`--tag-prefix ${show(opts.tagPrefix)} is not a tag prefix`);
  if (!list(opts.automationLogins).length) throw new ReleaseError('--automation-logins is required: name the accounts that open release PRs, or any PR from a release/ branch could be announced');
  if (!CHANNEL.test(opts.slackChannel)) throw new ReleaseError(`--slack-channel ${show(opts.slackChannel, 40)} is not a channel name such as #releases, or a channel ID`);
  parseTargets(opts.pageTargets);
  if (opts.tag !== undefined && opts.event !== undefined) throw new ReleaseError('give --tag or --event, not both');
}

// The tag a `push` event is about: a pushed tag ref. Anything else is not ours.
function tagOf(event) {
  if (!event || typeof event !== 'object') throw new ReleaseError('the event is not a JSON object');
  if (typeof event.ref !== 'string' || !event.ref.startsWith('refs/tags/')) throw new ReleaseError('the event is not a tag push: pass --tag, or call this from a push of tags');
  if (event.deleted) return null;
  return event.ref.slice('refs/tags/'.length);
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const say = (text) => out.write(`${text}\n`);
  try {
    const opts = parseOptions(argv, FLAGS, { tagPrefix: 'v', slackChannel: '#releases', pageTargets: '' });
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-announce.md for the three outputs, the settings and the Bug.\n`);
      return 0;
    }
    checkOptions(opts);
    const repo = env.GITHUB_REPOSITORY || '';
    if (!REPO.test(repo)) throw new ReleaseError('no repo: set GITHUB_REPOSITORY');
    let tag = opts.tag;
    if (tag === undefined) {
      const eventPath = opts.event || env.GITHUB_EVENT_PATH;
      if (!eventPath) throw new ReleaseError('no tag: pass --tag, or set GITHUB_EVENT_PATH to a tag push');
      tag = tagOf(readJson(eventPath, 'event'));
      if (tag === null) {
        say('Announce skipped: the push deleted the tag.');
        return 0;
      }
    }
    if (!tag || /[\s\u0000-\u001f]/.test(tag)) throw new ReleaseError(`--tag ${show(tag, 40)} is not a tag name`);

    const apiUrl = env.GITHUB_API_URL;
    const github = io.github || createClient({ token: env.GITHUB_TOKEN || env.GH_TOKEN, apiUrl });
    const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
    const prefix = opts.tagPrefix;
    const automationLogins = list(opts.automationLogins);
    const trusted = trustedLogins(automationLogins);
    const serverUrl = env.GITHUB_SERVER_URL || 'https://github.com';
    const runUrl = env.GITHUB_RUN_ID ? `${serverUrl.replace(/\/+$/, '')}/${repo}/actions/runs/${String(env.GITHUB_RUN_ID).replace(/\D/g, '')}` : null;

    // What went wrong in a courtesy that never fails the job (closing a shipped prep job): a warning
    // in the log and in the summary, and nothing else.
    const warnings = [];
    const flushWarnings = () => {
      for (const w of warnings) say(`::warning title=Announce::${escapeData(w)}`);
      return warnings.map((w) => `\n- Warning: ${w}\n`).join('');
    };

    const names = { page: 'The changelog page', post: 'The #releases line', comments: 'The "Live in" comments' };
    // An output that failed: its Bug (or a comment on the one already open), and exit 0.
    const reportFailure = async (message) => {
      const bug = await fileBug({
        github, repo, tag, output: opts.output, message, runUrl, trusted,
      });
      const line = `${names[opts.output]} for ${tag} did not go out: ${oneLine(message, 300)}. ${bug.created ? 'Filed' : 'Updated'} Bug #${bug.number}; the release is not affected, and the Announce job can be run again.`;
      say(`::warning title=Announce::${escapeData(line)}`);
      summary(env, `### Announce ${tag}: ${opts.output}\n\n${line}\n${flushWarnings()}`);
      return 0;
    };

    // Finding the release is reads, so a failed call is tried again; one that still fails is the
    // output's failure like any other (a Bug), while a tag that is no release is a refusal (exit 1).
    let found;
    try {
      found = await retrying(() => findRelease({
        github, repo, tag, prefix, automationLogins,
      }), { sleep });
    } catch (e) {
      if (e instanceof Refusal || !isFailure(e)) throw e;
      return reportFailure(e.message);
    }
    if (found.skip) {
      say(`Announce skipped: ${found.skip}.`);
      return 0;
    }
    const { release } = found;
    const date = found.date || (io.clock ? io.clock() : new Date()).toISOString().replace(/\.\d+Z$/, 'Z');

    // What the output does, as `{ status: 'done' | 'skipped', message }`. A failure it can name is a
    // Refusal, a ReleaseError, a GitHubError or a SlackError: those become a Bug below.
    const readText = async (file) => {
      const f = await retrying(() => github.getFile(repo, file, release.sha), { sleep });
      return f ? f.text : null;
    };
    const readConfig = async () => {
      const text = await readText('.github/release.json');
      if (text === null) return parseAnnounce({}, repo);
      let config;
      try {
        config = JSON.parse(text);
      } catch {
        throw new ReleaseError('.github/release.json is not valid JSON');
      }
      return parseAnnounce(config, repo);
    };
    const readNotes = async () => parseNotes(await readText(`releases/${release.tag}/release-notes.md`));

    const liveIn = async () => {
      const text = await readText(`releases/${release.tag}/facts.json`);
      if (text === null) throw new ReleaseError(`releases/${release.tag}/facts.json is not in ${release.tag}: there is no way to know which issues the release closes`);
      let facts;
      try {
        facts = JSON.parse(text);
      } catch {
        throw new ReleaseError(`releases/${release.tag}/facts.json is not valid JSON`);
      }
      return liveInComments({
        github, repo, release, facts, trusted, sleep,
      });
    };
    // Closes the prep jobs this release shipped. A failure is a warning, never a failed Announce: the
    // daily start still closes what this misses.
    const closePrepJobs = async () => {
      try {
        const r = await closeShippedJobs({ github, repo, sleep });
        for (const f of r.failed) warnings.push(`could not close prep job #${f.number} (${oneLine(f.why, 120)}): a later start closes it`);
        return r;
      } catch (e) {
        if (!isFailure(e)) throw e;
        warnings.push(`could not look for prep jobs to close (${oneLine(e.message, 120)}): a later start closes a shipped job`);
        return { closed: [], failed: [] };
      }
    };

    const outputs = {
      async page() {
        const { page } = await readConfig();
        if (!page) return { status: 'skipped', message: `${repo} has no page: the changelog page is not made (a #releases line is posted instead)` };
        const notes = await readNotes();
        if (!notes) return { status: 'skipped', message: `${release.tag} has no release notes, so it has no page` };
        checkTarget(parseTargets(opts.pageTargets), page, pagePath(page.path, release));
        const token = env.PAGE_TOKEN;
        if (!token && !io.pageGithub) throw new SetupError('no page token: set PAGE_TOKEN to the release bot\'s token for the site repo');
        const pageGithub = io.pageGithub || createClient({ token, apiUrl });
        return retrying(() => openPage({
          github: pageGithub, repo, release, notes, page, date, prNumber: release.number,
        }), { sleep });
      },
      async post() {
        const { page } = await readConfig();
        if (page) return { status: 'skipped', message: `${repo} has a page, so the site's own feed posts the line: Shipyard posts nothing` };
        const notes = await readNotes();
        if (!notes) return { status: 'skipped', message: `${release.tag} has no release notes, so it gets no #releases line` };
        const token = env.SLACK_TOKEN;
        if (!token && !io.slack) throw new SetupError('no Slack token: set SLACK_TOKEN to the release bot\'s token');
        const slack = io.slack || createSlackClient({ token, apiUrl: env.SLACK_API_URL || undefined });
        return postLine({
          github, slack, channel: opts.slackChannel, repo, release, notes, serverUrl, trusted, sleep,
        });
      },
      async comments() {
        // The "Live in" comments first, then the prep jobs the release shipped. A failure of one never
        // holds back the other: the prep jobs are looked at even when a comment could not be written.
        let live = null;
        let liveError = null;
        try {
          live = await liveIn();
        } catch (e) {
          if (!isFailure(e)) throw e;
          liveError = e;
        }
        const prep = await closePrepJobs();
        if (liveError) throw liveError;
        const counts = `commented on ${live.done.length}, already commented on ${live.already.length}${live.outside.length ? `, left ${live.outside.length} in other repos` : ''}`;
        if (live.failed.length) {
          const shown = live.failed.slice(0, 5).map((f) => `#${f.number} (${oneLine(f.why, 80)})`).join(', ');
          throw new ReleaseError(`could not comment on ${live.failed.length} issue${live.failed.length === 1 ? '' : 's'}: ${shown}${live.failed.length > 5 ? ', ...' : ''}; ${counts}`);
        }
        const jobs = prep.closed.length
          ? `closed prep job${prep.closed.length === 1 ? '' : 's'} ${prep.closed.map((j) => `#${j.number} (${j.tag} shipped it)`).join(', ')}`
          : 'no open prep job here was shipped by it';
        return { status: 'done', message: `"Live in ${release.tag}": ${counts}. Prep jobs: ${jobs}. A prep job filed in another repo is left to the daily start.` };
      },
    };

    let result = null;
    let failure = null;
    try {
      result = await outputs[opts.output]();
    } catch (e) {
      if (e instanceof SetupError || !isFailure(e)) throw e;
      failure = e.message;
    }

    if (failure !== null) return reportFailure(failure);
    let line = `${names[opts.output]}: ${result.message}`;
    if (result.status === 'done') {
      try {
        const closed = await settleBug({
          github, repo, tag, output: opts.output, trusted,
        });
        if (closed) line += ` Closed Bug #${closed}.`;
      } catch (e) {
        // Closing an old Bug is a courtesy: the output is done.
        if (!isFailure(e)) throw e;
        line += ` (could not close its earlier Bug: ${oneLine(e.message, 100)})`;
      }
    }
    say(line);
    summary(env, `### Announce ${tag}: ${opts.output}\n\n${line}\n${flushWarnings()}`);
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      out.write(`::error title=Announce::${escapeData(e.message)}\n`);
      err.write(`shipyard announce: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError || e instanceof SlackError)) throw e;
    out.write(`::error title=Announce::${escapeData(e.message)}\n`);
    err.write(`shipyard announce: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required|takes no)|give --tag)/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

function summary(env, text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  } catch {
    // the summary is a courtesy; the output and the exit code are the result
  }
}

module.exports = { run, USAGE, tagOf };
