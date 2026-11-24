'use strict';

// `shipyard changelog-line`: the required PR check. Exit 0 when the PR body has one valid
// `Changelog:` line, 1 when it does not, 2 when the check itself could not run.
//
// With `--status` it also posts the commit status `shipyard/changelog-line` on the PR's head, so a ruleset
// can require a name Shipyard chooses (a check-run's name changes with the caller's shape). Off unless asked.
//
// With `--sweep --work-branch <branch>` it checks every open PR into that branch instead of one PR from an event,
// and posts the status on each head (the sweep implies `--status`). Each PR is judged against the config of its own
// base branch, read through the API: `.github/shipyard.yml`, or `.github/release.json` while its repo has not moved
// (lib/repo-config.js). A PR into any other branch gets nothing. A PR whose check could not
// run does not stop the others; the exit is 2 at the end, naming it. A PR whose check ran and failed is a posted
// `failure`, not a failed sweep.
//
// The one PR is judged against the config in `--config-dir` (the base branch's checkout; the folder you run in when
// unset), read the same way. A repo holding neither file has no terms and only Shipyard's own files not shipped.
//
// Reads the PR event ($GITHUB_EVENT_PATH), then the live PR from the API: a re-run of a
// failed job replays the old event, whose body is the one the author has since fixed.

const fs = require('node:fs');
const { createClient } = require('./github');
const {
  CheckError, checkBody, classifyAuthor, changelogOf, withChangelogLine,
} = require('./changelog-line');
const { PatternError, createMatcher, shipsNothing, BUILT_IN } = require('./not-shipped');
const { loadRepoConfig, NoConfigError, YAML_FILE } = require('./repo-config');
const { prConfigProblems } = require('./pr-config-check');

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
    } else if (flag === '--sweep') {
      if (inline !== undefined) throw new CheckError('--sweep takes no value');
      opts.sweep = true;
    } else if (flag === '--work-branch') opts.workBranch = value();
    else if (flag === '--event') opts.event = value();
    else if (flag === '--config-dir') opts.configDir = value();
    else if (flag === '--config') throw new CheckError('--config is gone: pass --config-dir <the folder that holds .github/shipyard.yml or .github/release.json>');
    else if (flag === '--visibility') opts.visibility = value();
    else throw new CheckError(`unknown option ${flag}`);
  }
  if (opts.visibility && !['public', 'private'].includes(opts.visibility)) {
    throw new CheckError('--visibility is public or private');
  }
  if (opts.sweep) {
    if (!opts.workBranch || !opts.workBranch.trim()) throw new CheckError('--sweep needs --work-branch: the branch whose open PRs it checks');
    if (opts.event || opts.configDir) throw new CheckError('--sweep reads each PR and its base branch\'s config from the API: it takes no --event or --config-dir');
    opts.status = true;
  } else if (opts.workBranch !== undefined) {
    throw new CheckError('--work-branch is for --sweep');
  }
  return opts;
}

// A repo's config through the one loader: `source` is `{ dir }` or `{ github, repo, ref }`. It answers what the check
// reads (`json`) and a name for messages (`path`). A repo holding neither file has no terms, as before the loader.
// A file that cannot be read is an error, never "no terms". `warn` gets each line the loader would print.
async function readRepoConfig(source, { warn, where = '' }) {
  try {
    const { config, file, errors } = await loadRepoConfig(source, { warn });
    return { json: config, path: `${file}${where}`, dropped: errors };
  } catch (e) {
    if (e instanceof NoConfigError) return { json: {}, path: `${YAML_FILE}${where}`, dropped: [] };
    throw e;
  }
}

// The loader is lenient: a `notShipped`, `shipped` or `notes` value the validator refuses is left out of the config with
// a warning. This check cannot go on without them, as it cannot with a `release.json` they are wrong in (exit 2): a
// dropped `notShipped` would ask for a line a PR does not need, and a dropped `notes` would stop checking the terms of a
// public repo with the job still green. A private repo skips the terms, so only `notShipped` and `shipped` count there.
function checkNothingDropped(dropped, path, isPublic) {
  const mine = new RegExp(`^(?:notShipped|shipped${isPublic ? '|notes' : ''})(?![A-Za-z0-9_])`);
  const hit = (dropped || []).filter((m) => mine.test(m));
  if (hit.length) throw new CheckError(`${path}: ${hit[0]}${hit.length > 1 ? ` (+${hit.length - 1} more)` : ''} The check cannot run until this is fixed.`);
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
  return parseReleaseConfig(text, path);
}

// The same, from the file's text; `null` is a file that is not there.
function parseReleaseConfig(text, path) {
  if (text === null) return {};
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
// no file in it (a merge whose net diff is empty) changes nothing, so it ships nothing. `listing` is a list already read.
async function prShipsNothing(github, repo, number, patterns, listing = null) {
  const { files, truncated } = listing || await github.listPullFiles(repo, number);
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

// A failure of the check itself, as an annotation and on stderr: exit 2.
function reportFailure(e, { out, err, label = '' }) {
  out.write(`::error title=Changelog line::${escapeData(label + e.message)}\n`);
  err.write(`shipyard changelog-line: ${label}${e.message}\n`);
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const readFile = io.readFile || fs.readFileSync;

  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    err.write(`shipyard changelog-line: ${e.message}\n`);
    return 2;
  }

  let event;
  let repo;
  let github;
  let live;
  try {
    if (opts.sweep) {
      repo = env.GITHUB_REPOSITORY;
      if (!repo) throw new CheckError('No repo: set GITHUB_REPOSITORY');
    } else {
      const eventPath = opts.event || env.GITHUB_EVENT_PATH;
      if (!eventPath) throw new CheckError('No event: set GITHUB_EVENT_PATH or pass --event');
      try {
        event = JSON.parse(readFile(eventPath, 'utf8'));
      } catch (e) {
        throw new CheckError(`Cannot read the event at ${eventPath}: ${e.message}`);
      }
      if (!event || !event.pull_request) throw new CheckError('Not a pull request event');
      repo = env.GITHUB_REPOSITORY || (event.repository && event.repository.full_name);
      if (!repo) throw new CheckError('No repo: set GITHUB_REPOSITORY');
    }
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL });
    live = Boolean(io.github || token);
    if (opts.sweep && !live) throw new CheckError('Cannot sweep the open PRs: no GITHUB_TOKEN');
  } catch (e) {
    reportFailure(e, { out, err });
    return 2;
  }

  const common = { env, out, err, github, live, repo, opts };
  // A line the loader prints (a leftover release.json, an unknown key) is an annotation on the job, not a failure.
  const warn = (line) => out.write(`::warning title=Changelog line::${escapeData(line)}\n`);
  if (opts.sweep) return sweep({ ...common, warn });

  const dir = opts.configDir || '.';
  return checkPull({
    ...common,
    number: event.pull_request.number,
    pull: event.pull_request,
    fetchPull: true,
    repository: event.repository,
    loadConfig: () => readRepoConfig({ dir }, { warn }),
  });
}

// Every open PR into the work branch, one after another, each checked against the config of its own
// base branch. A PR whose check could not run is named at the end; the others are posted first.
async function sweep({
  env, out, err, github, repo, opts, warn,
}) {
  const branch = opts.workBranch.trim();
  let open;
  try {
    open = await github.listOpenPulls(repo);
  } catch (e) {
    reportFailure(e, { out, err });
    return 2;
  }
  const pulls = open.filter((p) => p && Number.isSafeInteger(p.number)).sort((a, b) => a.number - b.number);
  const mine = pulls.filter((p) => p.base && p.base.ref === branch);
  out.write(`Sweep of ${repo}: ${mine.length} open PR${mine.length === 1 ? '' : 's'} into ${branch}, ${pulls.length - mine.length} into another branch (left alone).\n`);

  // One read of a base branch's config serves every PR into it; a failed read is not kept, so the next PR asks again.
  const configs = new Map();
  const configOf = (ref) => {
    if (!configs.has(ref)) {
      const read = readRepoConfig({ github, repo, ref }, { warn, where: ` on ${ref}` });
      read.catch(() => configs.delete(ref));
      configs.set(ref, read);
    }
    return configs.get(ref);
  };

  const results = { passed: [], failed: [], unrun: [] };
  for (const pull of mine) {
    const code = await checkPull({
      env, out, err, github, live: true, repo, opts, number: pull.number, pull, fetchPull: true, repository: null,
      loadConfig: () => configOf(pull.base.ref), label: `#${pull.number}: `,
    });
    (code === 0 ? results.passed : code === 1 ? results.failed : results.unrun).push(pull.number);
  }

  const list = (numbers) => numbers.map((n) => `#${n}`).join(', ');
  out.write(`Swept ${mine.length}: ${results.passed.length} passed, ${results.failed.length} failed (the status says why), ${results.unrun.length} could not be checked.\n`);
  summary(env, `### Changelog line sweep\n\n${mine.length} open PR${mine.length === 1 ? '' : 's'} into \`${branch}\`: ${results.passed.length} passed, ${results.failed.length} failed${results.failed.length ? ` (${list(results.failed)})` : ''}, ${results.unrun.length} could not be checked${results.unrun.length ? ` (${list(results.unrun)})` : ''}.\n`);
  if (results.unrun.length) {
    const message = `the check could not run for ${list(results.unrun)}`;
    out.write(`::error title=Changelog line::${escapeData(message)}\n`);
    err.write(`shipyard changelog-line: ${message}\n`);
    return 2;
  }
  return 0;
}

// One PR: the check, and (with `--status`) the status on its head. `pull` is the PR as the event or the list
// gave it; `fetchPull` reads it live instead (a re-run of a failed job replays the old event, and a sweep's list
// can be old by the time a PR's turn comes: an author may have fixed the body, and the event run posted on it). `label` ("#7: ") goes
// before every line of a sweep, which checks many. In a sweep a PR that fails the check is a warning: the failure
// is the status, and the sweep still did its job.
async function checkPull({
  env, out, err, github, live, repo, opts, number, pull, fetchPull, repository, loadConfig, label = '',
}) {
  const say = (text) => out.write(`${label}${text}\n`);
  const annotate = (m) => out.write(`::${label ? 'warning' : 'error'} title=Changelog line::${escapeData(label + m)}\n`);
  const heading = label ? `### Changelog line ${label.slice(0, -2)}` : '### Changelog line';

  // For `--status`: what the catch below needs to say "could not run" on the head, if it got far enough to know it.
  let statusTarget = null;
  let statusFailed = false;

  try {
    const eventHead = pull.head && pull.head.sha;
    if (opts.status && live && eventHead) statusTarget = { github, repo, sha: eventHead };
    const pr = live && fetchPull ? await github.getPull(repo, number) : pull;
    if (opts.status && live && pr.head && pr.head.sha) statusTarget = { github, repo, sha: pr.head.sha };

    // Unknown visibility is treated as public: the stricter rules.
    const baseRepoPrivate = pr.base && pr.base.repo && pr.base.repo.private;
    const privateFlag = typeof baseRepoPrivate === 'boolean' ? baseRepoPrivate : repository && repository.private;
    const isPublic = opts.visibility ? opts.visibility === 'public' : privateFlag !== true;

    // Read in every repo: a private repo skips the terms but still has a `notShipped` list.
    const { json: releaseConfig, path: configPath, dropped } = await loadConfig();
    checkNothingDropped(dropped, configPath, isPublic);
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
    const earlyProblems = [];

    // The PR's own files, read once for both questions below. A PR that changes `.github/shipyard.yml` is checked
    // strictly, on its head's copy (lib/pr-config-check.js); one that does not never reads the file. Without a token
    // the list cannot be read, so the file is not checked.
    const listing = live ? await github.listPullFiles(repo, number) : null;
    const configProblems = listing ? await prConfigProblems({ github, repo, pr, listing }) : [];

    // A PR that ships nothing needs no line. Asked only when the line is missing.
    let ships = null;
    if (result.problems.some((p) => p.rule === 'missing') && live) {
      ships = await prShipsNothing(github, repo, number, notShipped, listing);
      if (ships.shipsNothing) result = { ...result, problems: result.problems.filter((p) => p.rule !== 'missing') };
    }
    const shipsNothingPr = Boolean(ships && ships.shipsNothing);

    // A Dependabot PR with no line in its body is judged by the line made from its title, as everything that reads
    // lines reads it. Nothing is written to the PR: an edit with the job's token would make `github-actions` the
    // last editor of the body, and the fleet's public guard holds an item an outsider edited last.
    let titleLine = null;
    if (author === 'dependabot' && !shipsNothingPr) {
      const own = changelogOf(pr);
      if (own.fromTitle) {
        titleLine = own.changelog[0];
        result = await checkBody(withChangelogLine(body, titleLine), checkOpts);
      } else if (own.changelog.length === 0) {
        earlyProblems.push({ rule: 'dependabot-title', message: 'The Dependabot PR has no title to make the Changelog line from.' });
      }
    }

    const problems = [...configProblems, ...earlyProblems, ...result.problems];

    const messages = problems.map((p) => p.message);
    if (problems.length && author === 'outside') messages.unshift(OUTSIDE_NOTE);
    if (problems.length && titleLine !== null) messages.push('This line is made from the Dependabot PR\'s title. A `Changelog:` line in the PR body is used in its place.');

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
          summary(env, `${heading}\n\nOK. This PR changes no files, so it ships nothing and needs no \`Changelog:\` line.\n`);
          await postStatus('success', 'This PR ships nothing, so it needs no Changelog line.');
          return 0;
        }
        const which = n === 1 ? 'its 1 changed file is' : `all ${n} changed files are`;
        say(`Changelog line OK: this PR ships nothing (${which} Shipyard's own or on \`notShipped\`), so it needs no line.`);
        summary(env, `${heading}\n\nOK. This PR ships nothing: ${which} Shipyard's own (\`.github/release.json\`, \`.github/shipyard.yml\`, \`CHANGELOG.md\`) or on the repo's \`notShipped\` list, so it needs no \`Changelog:\` line.\n`);
        await postStatus('success', 'This PR ships nothing, so it needs no Changelog line.');
        return 0;
      }
      if (titleLine !== null) {
        say(`Changelog line OK: Dependabot PR. Its line is taken from the PR title, and the PR is not edited: ${titleLine}`);
        summary(env, `${heading}\n\nOK. The line is taken from the PR title, and the PR is not edited: ${titleLine}\n`);
        await postStatus('success', 'The Changelog line is taken from the Dependabot PR title.');
        return 0;
      }
      say(`Changelog line OK: ${author} PR.`);
      summary(env, `${heading}\n\nOK.\n`);
      await postStatus('success', 'The PR has one valid Changelog line.');
      return 0;
    }
    for (const m of messages) annotate(m);
    summary(env, `${heading}\n\n${messages.map((m) => `- ${m}`).join('\n')}\n`);
    await postStatus('failure', statusDescription(problems.map((p) => p.message)));
    return 1;
  } catch (e) {
    reportFailure(e, { out, err, label });
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
