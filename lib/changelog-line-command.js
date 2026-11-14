'use strict';

// `shipyard changelog-line`: the required PR check. Exit 0 when the PR body has one valid
// `Changelog:` line, 1 when it does not, 2 when the check itself could not run.
//
// Reads the PR event ($GITHUB_EVENT_PATH), then the live PR from the API: a re-run of a
// failed job replays the old event, whose body is the one the author has since fixed.

const fs = require('node:fs');
const { createClient } = require('./github');
const {
  CheckError, checkBody, classifyAuthor, changelogFromTitle, extractLines, withChangelogLine,
} = require('./changelog-line');
const { PatternError, createMatcher, shipsNothing } = require('./not-shipped');

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
    if (flag === '--event') opts.event = value();
    else if (flag === '--config') opts.config = value();
    else if (flag === '--visibility') opts.visibility = value();
    else throw new CheckError(`unknown option ${flag}`);
  }
  if (opts.visibility && !['public', 'private'].includes(opts.visibility)) {
    throw new CheckError('--visibility is public or private');
  }
  return opts;
}

// .github/release.json. A missing file means no terms and nothing "not shipped"; a file
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

// `notShipped`: the patterns of paths that ship nothing (lib/not-shipped.js).
function notShippedOf(json, path) {
  const patterns = json.notShipped;
  if (patterns === undefined) return [];
  try {
    createMatcher(patterns);
  } catch (err) {
    if (err instanceof PatternError) throw new CheckError(`${path}: ${err.message}`);
    throw err;
  }
  return patterns;
}

function readInternalTerms(path, readFile) {
  return internalTermsOf(loadReleaseConfig(path, readFile), path);
}

// Whether every file the PR changes matches `notShipped`. A rename counts both of its
// paths: moving a shipped file into a not-shipped folder still removes it from the product.
// A truncated list (GitHub shows 3000 files at most) is never "all the files".
async function prShipsNothing(github, repo, number, patterns) {
  const { files, truncated } = await github.listPullFiles(repo, number);
  if (truncated) return { shipsNothing: false, count: files.length };
  const paths = files.flatMap((f) => (f.previous_filename ? [f.filename, f.previous_filename] : [f.filename]));
  return { shipsNothing: shipsNothing(patterns, paths), count: files.length };
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
    const pr = live ? await github.getPull(repo, number) : event.pull_request;

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

    // A PR that ships nothing needs no line. Asked only when the line is missing and the
    // repo lists patterns, so a PR that has its line costs no extra API call.
    let ships = null;
    if (notShipped.length && result.problems.some((p) => p.rule === 'missing') && live) {
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

    if (problems.length === 0) {
      if (shipsNothingPr) {
        const n = ships.count;
        say(`Changelog line OK: this PR ships nothing (${n === 1 ? 'its 1 changed file matches' : `all ${n} changed files match`} \`notShipped\`), so it needs no line.`);
        summary(env, `### Changelog line\n\nOK. This PR ships nothing: ${n === 1 ? 'its 1 changed file matches' : `all ${n} changed files match`} \`notShipped\` in \`.github/release.json\`, so it needs no \`Changelog:\` line.\n`);
        return 0;
      }
      say(`Changelog line OK${wrote ? ' (written for Dependabot)' : ''}: ${author} PR.`);
      summary(env, `### Changelog line\n\nOK.${wrote ? ' Written from the PR title.' : ''}\n`);
      return 0;
    }
    for (const m of messages) out.write(`::error title=Changelog line::${escapeData(m)}\n`);
    summary(env, `### Changelog line\n\n${messages.map((m) => `- ${m}`).join('\n')}\n`);
    return 1;
  } catch (e) {
    out.write(`::error title=Changelog line::${escapeData(e.message)}\n`);
    err.write(`shipyard changelog-line: ${e.message}\n`);
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
  run, parseArgs, readInternalTerms, escapeData, OUTSIDE_NOTE, loadReleaseConfig, internalTermsOf, notShippedOf, prShipsNothing,
};
