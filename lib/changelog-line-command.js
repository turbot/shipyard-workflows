'use strict';

// `shipyard changelog-line`: the required PR check. Exit 0 when the PR body has one valid
// `Changelog:` line, 1 when it does not, 2 when the check itself could not run.
//
// With `--status` it also posts the commit status `shipyard/changelog-line` on the PR's head, so a ruleset
// can require a name Shipyard chooses (a check-run's name changes with the caller's shape). Off unless asked.
//
// Reads the PR event ($GITHUB_EVENT_PATH), then the live PR from the API: a re-run of a
// failed job replays the old event, whose body is the one the author has since fixed.

const fs = require('node:fs');
const { createClient } = require('./github');
const {
  CheckError, checkBody, classifyAuthor, changelogFromTitle, extractLines, withChangelogLine,
} = require('./changelog-line');
const { PatternError, createMatcher, shipsNothing, BUILT_IN } = require('./not-shipped');

const STATUS_CONTEXT = 'shipyard/changelog-line';
const STATUS_DESCRIPTION_MAX = 140;

const OUTSIDE_NOTE =
  'This PR is from an outside contributor. The Changelog line is written by the reviewer: ' +
  'a reviewer, please edit the PR body to add one `Changelog:` line (and an `Update-Needs:` line if people must act).';

function parseArgs(argv) {
  const opts = { visibility: null };
  for (let i = 0; i < argv.length; i++) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => {
      if (inline !== undefined) return inline;
      if (i + 1 >= argv.length) throw new CheckError(`${flag} needs a value`);
      return argv[++i];
    };
    if (flag === '--status') {
      if (inline !== undefined) throw new CheckError('--status takes no value');
      opts.status = true;
    } else if (flag === '--event') opts.event = value();
    else if (flag === '--config') opts.config = value();
    else if (flag === '--visibility') opts.visibility = value();
    else throw new CheckError(`unknown option ${flag}`);
  }
  if (opts.visibility && !['public', 'private'].includes(opts.visibility)) {
    throw new CheckError('--visibility is public or private');
  }
  return opts;
}

// .github/release.json. A missing file means no terms and only Shipyard's own files not shipped; a file
// that cannot be read as the schema says is an error, never "no terms".
function loadReleaseConfig(path, readFile) {
  let text;
  try {
    text = readFile(path, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new CheckError(`Cannot read ${path}: ${err.message}`);
  }
  let json;
  try {
    json = JSON.parse(text);
  } catch (err) {
    throw new CheckError(`${path} is not valid JSON: ${err.message}`);
  }
  return json && typeof json === 'object' ? json : {};
}

// `notes.internalTerms`
function internalTermsOf(json, path) {
  const terms = json.notes && json.notes.internalTerms;
  if (terms === undefined) return [];
  if (!Array.isArray(terms) || terms.some((t) => typeof t !== 'string' || !t.trim())) {
    throw new CheckError(`${path}: notes.internalTerms must be a list of non-empty strings`);
  }
  return terms.map((t) => t.trim());
}

// The patterns of paths that ship nothing: the repo's `notShipped`, then its `shipped` (paths that ship
// although `notShipped` matches them, passed on as `!` patterns, which the last match wins), then
// Shipyard's own files (lib/not-shipped.js), last so that nothing in the repo's file can take them back.
// A repo writes no `!` itself: negation is `shipped`, a key an older Shipyard ignores, so a repo can name
// one before its pin moves and nothing breaks in between.
function notShippedOf(json, path) {
  const patterns = json.notShipped === undefined ? [] : json.notShipped;
  const shipped = json.shipped === undefined ? [] : json.shipped;
  try {
    if (!Array.isArray(shipped)) throw new PatternError('shipped must be a list of patterns');
    for (const [key, list] of [['notShipped', patterns], ['shipped', shipped]]) {
      if (Array.isArray(list) && list.some((p) => typeof p === 'string' && p.trim().replace(/^(?:\.?\/)+/, '').startsWith('!'))) {
        throw new PatternError(`${key}: a pattern cannot start with "!": list a path that ships although notShipped matches it in "shipped"`);
      }
    }
    createMatcher(patterns);
    createMatcher(shipped);
  } catch (err) {
    if (err instanceof PatternError) throw new CheckError(`${path}: ${err.message}`);
    throw err;
  }
  return [...patterns, ...shipped.map((p) => `!${p.trim()}`), ...BUILT_IN];
}

function readInternalTerms(path, readFile) {
  return internalTermsOf(loadReleaseConfig(path, readFile), path);
}

// Whether every file the PR changes is Shipyard's own or matches `notShipped`. A rename counts both of its
// paths: moving a shipped file into a not-shipped folder still removes it from the product.
// A truncated list (GitHub shows 3000 files at most) is never "all the files". A list read in full with
// no file in it (a merge whose net diff is empty) changes nothing, so it ships nothing.
async function prShipsNothing(github, repo, number, patterns) {
  const { files, truncated } = await github.listPullFiles(repo, number);
  if (truncated) return { shipsNothing: false, count: files.length };
  const paths = files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  return { shipsNothing: shipsNothing(patterns, paths), count: files.length };
}

// A status description is 140 characters at most and one line: the first problem, then how many more.
// The full reasons stay in the job log.
function statusDescription(messages) {
  const first = String(messages[0]).replace(/\s+/g, ' ').trim();
  const more = messages.length > 1 ? ` (+${messages.length - 1} more)` : '';
  const room = STATUS_DESCRIPTION_MAX - more.length;
  const head = first.length > room ? `${first.slice(0, room - 1).trimEnd()}…` : first;
  return `${head}${more}`;
}

// Workflow commands read `%`, CR and LF as syntax: a title or a repo name must not inject one.
const escapeData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const readFile = io.readFile || fs.readFileSync;
  const say = (text) => out.write(`${text}\n`);

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err.write(`shipyard changelog-line: ${e.message}\n`);
    return 2;
  }

  // For `--status`: what the catch below needs to say "could not run" on the head, if it got far enough to know it.
  let statusTarget = null;
  let statusFailed = false;

  try {
    const eventPath = opts.event || env.GITHUB_EVENT_PATH;
    if (!eventPath) throw new CheckError('No event: set GITHUB_EVENT_PATH or pass --event');
    let event;
    try {
      event = JSON.parse(readFile(eventPath, 'utf8'));
    } catch (e) {
      throw new CheckError(`Cannot read the event at ${eventPath}: ${e.message}`);
    }
    if (!event || !event.pull_request) throw new CheckError('Not a pull request event');

    const repo = env.GITHUB_REPOSITORY || (event.repository && event.repository.full_name);
    if (!repo) throw new CheckError('No repo: set GITHUB_REPOSITORY');
    const number = event.pull_request.number;

    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL });
    const live = Boolean(io.github || token);
    const eventHead = event.pull_request.head && event.pull_request.head.sha;
    if (opts.status && live && eventHead) statusTarget = { github, repo, sha: eventHead };
    const pr = live ? await github.getPull(repo, number) : event.pull_request;
    if (opts.status && live && pr.head && pr.head.sha) statusTarget = { github, repo, sha: pr.head.sha };

    // Unknown visibility is treated as public: the stricter rules.
    const baseRepoPrivate = pr.base && pr.base.repo && pr.base.repo.private;
    const privateFlag = typeof baseRepoPrivate === 'boolean' ? baseRepoPrivate : event.repository && event.repository.private;
    const isPublic = opts.visibility ? opts.visibility === 'public' : privateFlag !== true;

    // Read in every repo: a private repo skips the terms but still has a `notShipped` list.
    const configPath = opts.config || '.github/release.json';
    const releaseConfig = loadReleaseConfig(configPath, readFile);
    const internalTerms = isPublic ? internalTermsOf(releaseConfig, configPath) : [];
    const notShipped = notShippedOf(releaseConfig, configPath);

    const author = classifyAuthor(pr);
    const body = pr.body || '';
    const checkOpts = {
      isPublic,
      internalTerms,
      repoVisibility: live ? (owner, name) => github.repoVisibility(owner, name) : undefined,
    };
    let result = await checkBody(body, checkOpts);
    let wrote = false;
    const earlyProblems = [];

    // A PR that ships nothing needs no line. Asked only when the line is missing, so a PR
    // that has its line costs no extra API call.
    let ships = null;
    if (result.problems.some((p) => p.rule === 'missing') && live) {
      ships = await prShipsNothing(github, repo, number, notShipped);
      if (ships.shipsNothing) result = { ...result, problems: result.problems.filter((p) => p.rule !== 'missing') };
    }
    const shipsNothingPr = Boolean(ships && ships.shipsNothing);

    if (author === 'dependabot' && !shipsNothingPr && extractLines(body).changelog.length === 0) {
      const line = changelogFromTitle(pr.title);
      if (!line) {
        earlyProblems.push({ rule: 'dependabot-title', message: 'The Dependabot PR has no title to write the Changelog line from.' });
      } else {
        // Written only when the new body is valid: never leave a bad line on the PR.
        const candidate = withChangelogLine(body, line);
        const candidateResult = await checkBody(candidate, checkOpts);
        result = candidateResult;
        if (candidateResult.problems.length === 0) {
          if (!live) throw new CheckError('Cannot write the Dependabot Changelog line: no GITHUB_TOKEN');
          await github.updatePullBody(repo, number, candidate);
          wrote = true;
          say('Wrote the Changelog line from the PR title.');
        }
      }
    }

    const problems = [...earlyProblems, ...result.problems];

    const messages = problems.map((p) => p.message);
    if (problems.length && author === 'outside') messages.unshift(OUTSIDE_NOTE);

    // The head the PR has now: a re-run of an old event judges the live PR, so its status goes on the live head.
    const postStatus = async (state, description) => {
      if (!opts.status) return;
      if (!live) throw new CheckError('Cannot post the status: no GITHUB_TOKEN');
      const sha = pr.head && pr.head.sha;
      if (!sha) throw new CheckError('Cannot post the status: the PR has no head sha');
      try {
        await github.createStatus(repo, sha, { state, context: STATUS_CONTEXT, description });
      } catch (e) {
        statusFailed = true;
        throw new CheckError(`Cannot post the ${STATUS_CONTEXT} status: ${e.message}`);
      }
    };

    if (problems.length === 0) {
      if (shipsNothingPr) {
        const n = ships.count;
        if (n === 0) {
          say('Changelog line OK: this PR changes no files, so it ships nothing and needs no line.');
          summary(env, '### Changelog line\n\nOK. This PR changes no files, so it ships nothing and needs no `Changelog:` line.\n');
          return 0;
        }
        const which = n === 1 ? 'its 1 changed file is' : `all ${n} changed files are`;
        say(`Changelog line OK: this PR ships nothing (${which} Shipyard's own or on \`notShipped\`), so it needs no line.`);
        summary(env, `### Changelog line\n\nOK. This PR ships nothing: ${which} Shipyard's own (\`.github/release.json\`, \`CHANGELOG.md\`) or on the repo's \`notShipped\` list, so it needs no \`Changelog:\` line.\n`);
        await postStatus('success', 'This PR ships nothing, so it needs no Changelog line.');
        return 0;
      }
      say(`Changelog line OK${wrote ? ' (written for Dependabot)' : ''}: ${author} PR.`);
      summary(env, `### Changelog line\n\nOK.${wrote ? ' Written from the PR title.' : ''}\n`);
      await postStatus('success', 'The PR has one valid Changelog line.');
      return 0;
    }
    for (const m of messages) out.write(`::error title=Changelog line::${escapeData(m)}\n`);
    summary(env, `### Changelog line\n\n${messages.map((m) => `- ${m}`).join('\n')}\n`);
    await postStatus('failure', statusDescription(problems.map((p) => p.message)));
    return 1;
  } catch (e) {
    out.write(`::error title=Changelog line::${escapeData(e.message)}\n`);
    err.write(`shipyard changelog-line: ${e.message}\n`);
    // A check that could not finish must not leave an earlier `success` standing on the head: a ruleset that
    // requires this status would let a PR through that this run could not judge. Best effort: exit 2 either way.
    if (statusTarget && !statusFailed) {
      try {
        await statusTarget.github.createStatus(statusTarget.repo, statusTarget.sha, {
          state: 'error', context: STATUS_CONTEXT, description: 'The check could not run. See the job log.',
        });
      } catch {
        // the exit code is the check
      }
    }
    return 2;
  }
}

function summary(env, text) {
  if (!env.GITHUB_STEP_SUMMARY) return;
  try {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  } catch {
    // the summary is a courtesy; the exit code is the check
  }
}

module.exports = {
  run, parseArgs, readInternalTerms, escapeData, OUTSIDE_NOTE, loadReleaseConfig, internalTermsOf, notShippedOf, prShipsNothing, statusDescription, STATUS_CONTEXT,
};
