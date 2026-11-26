'use strict';

// `shipyard record --facts <facts.json> --prep <prep.json> --results <results.json> --pr <number>`:
// write the release PR's audit record from GitHub's own data and the results of the release run, and
// write the PR body: the top again with the verdict the record found ("Do not approve" when anything did
// not pass), and the audit record in its fold. It commits nothing: the release PR's head stays the commit
// the cut made, and the results stay in the release run's `results` artifact, which the page links.
// With --update it writes the body, sets the `shipyard/release` status and posts the notes for the
// release manager as a comment. With --gate-workflow it sets no status: it starts the repo's release gate
// (docs/release-gate.md), which posts `shipyard/release` as the area's release App. With --prepared-again <dir> (a release PR a cut
// prepared again for `/prepare-again`) it first puts the cut's new page on the PR, or answers the cut's refusal, then records the
// new head from the release run the old page named and answers the request. Exit 0 when the record is written, SHIP or HOLD alike; 1 when refused
// (the PR is not this release's, the checkout is not its head, the facts are stale); 2 when it could not run.

const fs = require('node:fs');
const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { LintError, checkFacts, topProblems } = require('./lint-prep');
const { checkRange } = require('./cut');
const { firstReleaseCommit } = require('./first-release');
const {
  assertPrepPasses, RESHIP_FIX_START, RESHIP_FIX_END, reshipFixText, changelogSection, versionOf,
} = require('./changelog');
const {
  ReleaseError, Refusal, git, parseTag, bump, formatVersion, resolveCommit, isAncestor, prNumberOf,
} = require('./release-git');
const { parseOptions, need, readJson } = require('./release-args');
const { cherryPickOrigin, describeFix } = require('./reship');
const { parseStart } = require('./start-config');
const { announceCalled, announcePage } = require('./announce-called');
const { loadReaderConfigAt, settingsOf } = require('./reader-config');
const { TagsError, readTagCommits, versionAt } = require('./published-tags');
const {
  readResults, buildRecord, applyRecord, plainTitle, tagOf, clean, REPORT_FILES, readReportText, workflowRunOf, onlyReleaseRun, managerNotesComment, notesMarker, RELEASE_STATUS, releaseStatus, releaseRunOf,
  releaseRunMarker, START: RECORD_START,
} = require('./record');
const {
  TRAILER: PREPARED_AGAIN, parseRequestMarkers, pageMarker, pageReply, cutRefusedReply,
} = require('./prepare-again');
const { RESULT_FILE: AGAIN_RESULT, BODY_FILE: AGAIN_BODY } = require('./prepare-again-cut');
const { readReleaseRun } = require('./release-run');
const { checkReleasePr } = require('./release-pr');
const { driversOf } = require('./drivers');
const { personStepLogins } = require('./deploy-rows');
const { isLight, lightPrepFor } = require('./light');
const {
  readReleaseInputs, commitsFromGit, dataTrailerOf, trailerValues, findReleaseData, MAX_BODY,
} = require('./release-data');
const { currentOf } = require('./shipyard-version');
const { readGated } = require('./release-gated');
const { dispatchInputs } = require('./dispatch-inputs');

const USAGE = [
  'usage: shipyard record (--facts <facts.json> --prep <prep.json> | --from-candidate) --results <results.json> --pr <number> [--shipyard-sha <commit>] [--dir <checkout>] [--out <body file>] [--update] [--draft-until-ship] [--release-run <run id>] [--changelog <path>] [--armed-label <label>] [--fleet-logins <a,b>] [--ignore-checks <a,b>] [--ask-workflow <file>] [--gate-workflow <file>] [--area <release_area>] [--default-branch <name>]',
  '       shipyard record --from-candidate --review --release-run <run id> --results <results.json> --pr <number> [--update] [...]',
  '       shipyard record --from-evidence --pr <number> [--shipyard-sha <commit>] [--dir <checkout>] [--out <body file>] [--update] [--changelog <path>] [--armed-label <label>] [--fleet-logins <a,b>] [--ignore-checks <a,b>] [--ask-workflow <file>] [--gate-workflow <file>] [--area <release_area>] [--default-branch <name>]',
  '       shipyard record --find-release-run --pr <number> --out <file>',
  '       shipyard record --prepared-again <dir> --pr <number> [--dir <checkout>] --out <file>',
  '       shipyard record --from-candidate --prepared-again <dir> --release-run <run id> --results <results.json> --pr <number> [--draft-until-ship] [--update] [...]',
  '--no-commit is still accepted and does nothing: the record commits nothing.',
].join('\n');
const FLAGS = {
  '--facts': 'facts', '--prep': 'prep', '--results': 'results', '--pr': 'pr', '--dir': 'dir', '--out': 'out', '--changelog': 'changelog',
  '--armed-label': 'armedLabel', '--fleet-logins': 'fleetLogins', '--ignore-checks': 'ignoreChecks', '--ask-workflow': 'askWorkflow', '--gate-workflow': 'gateWorkflow', '--release-run': 'releaseRun', '--shipyard-sha': 'shipyardSha',
  '--area': 'area', '--default-branch': 'defaultBranch', '--prepared-again': 'preparedAgain',
};
const SWITCHES = {
  '--update': 'update', '--no-commit': 'noCommit', '--draft-until-ship': 'draftUntilShip', '--from-candidate': 'fromCandidate', '--from-evidence': 'fromEvidence',
  '--review': 'review', '--find-release-run': 'findReleaseRun',
};
const RELEASE_JSON = '.github/release.json';
const ASK_WORKFLOW = /^[A-Za-z0-9_][A-Za-z0-9._-]*\.ya?ml$/;
const DEFAULT_EVIDENCE = 'releases/{tag}/evidence';
const EVIDENCE_FORMAT = 1;
const EVIDENCE_NAMES = ['test-summary.json', 'staging-results.json'];
// The files a record made before it stopped committing kept in the evidence folder: a candidate that holds them has not
// changed its build by them (the Same build row).
const EVIDENCE_KEPT = [...EVIDENCE_NAMES, ...REPORT_FILES.map((f) => f.name), 'checks.json'];

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Where the evidence goes

// The repo's config at a commit (the build's source), read through the loader: `.github/shipyard.yml`, else
// `.github/release.json`, else none (`file: null`, an empty config). `warn` is quiet unless the caller says where it goes.
const quiet = () => {};
const configAt = (dir, commit, warn = quiet) => loadReaderConfigAt({ dir, rev: commit }, { warn });
// The loaded config as an object: a file that is JSON but not a map holds no setting. The file's name is what every
// message names; with no file there is nothing to name, and nothing to complain about.
const settingsFrom = (loaded) => (loaded.config && typeof loaded.config === 'object' && !Array.isArray(loaded.config) ? loaded.config : {});
const fileOf = (loaded) => loaded.file || RELEASE_JSON;

// Who may approve a release of the repo, for the approver line. On release.json, `start.approvers`: a repo with none, or
// a `start` this cannot read, names none, and the line then names no other approver. On shipyard.yml, the area's team
// (`settings`, from `settingsOf`): the file's own `start` and approvers are ignored.
function approversOf(loaded, settings = null) {
  if (settings) return [`@${settings.approversTeam}`];
  const json = settingsFrom(loaded);
  if (json.start === undefined) return [];
  try {
    return parseStart(json.start, fileOf(loaded)).approvers;
  } catch {
    return [];
  }
}

// `tests` of the config: the names of the jobs that are tests, so a skipped job it does not name is left out
// of the checks as not a test. Null when the repo names none, and every skipped job is then counted as skipped.
const TESTS_MAX = 50;
function testsOf(loaded) {
  const json = settingsFrom(loaded);
  if (json.tests === undefined) return null;
  const ok = Array.isArray(json.tests) && json.tests.length <= TESTS_MAX
    && json.tests.every((t) => typeof t === 'string' && t.trim() && !/[\r\n]/.test(t));
  if (!ok) throw new ReleaseError(`${fileOf(loaded)}: tests must be a list of job names, each on one line (${TESTS_MAX} at most)`);
  return json.tests.map((t) => t.trim());
}

// `evidence` of the config, read at the commit it is given (the build's source): a folder, with `{tag}` for the
// release's tag. A path that could leave the repo or reach git's own files is refused. `loaded` is the config already
// read at that commit, when the caller has it.
function evidencePathOf(dir, head, tag, loaded = configAt(dir, head)) {
  const json = settingsFrom(loaded);
  let template = DEFAULT_EVIDENCE;
  if (json.evidence !== undefined) {
    if (typeof json.evidence !== 'string' || !json.evidence.trim()) throw new ReleaseError(`${fileOf(loaded)}: evidence must be a folder path`);
    template = json.evidence.trim();
  }
  const rel = template.replace(/\{tag\}/g, tag).replace(/\/+$/, '');
  const parts = rel.split('/');
  if (!rel || path.isAbsolute(rel) || /[\\\u0000-\u001f]/.test(rel) || parts.some((p) => !p || p === '.' || p === '..')
    || parts[0] === '.git' || /^-/.test(rel) || rel.toLowerCase().startsWith('.github/workflows')) {
    throw new ReleaseError(`${fileOf(loaded)}: evidence must be a folder inside the repo, not ${JSON.stringify(template)}`);
  }
  return rel;
}

// `report.templateDiff` and `report.prodPlan` of the config: the settings that are on, as the entries of
// `REPORT_FILES`. Each is `true` or `false`.
function reportSettingsOf(loaded) {
  const json = settingsFrom(loaded);
  const report = json.report && typeof json.report === 'object' && !Array.isArray(json.report) ? json.report : {};
  return REPORT_FILES.filter((f) => {
    if (report[f.key] !== undefined && typeof report[f.key] !== 'boolean') {
      throw new ReleaseError(`${fileOf(loaded)}: report.${f.key} must be true or false`);
    }
    return report[f.key] === true;
  });
}

// The files the build step wrote next to the results file, for each setting that is on; `text` is null for one it did
// not write (or a results file that was not downloaded). Never read through a link, so a file the artifact links to
// somewhere else is not read onto the page.
function readReportFiles(settings, folder) {
  return settings.map((f) => {
    const file = path.join(folder, f.name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return { ...f, text: null };
    if (!stat.isFile()) throw new ReleaseError(`${f.name} next to the results file must be a regular file, not a link or a folder`);
    return { ...f, text: readReportText(fs.readFileSync(file, 'utf8'), f.name) };
  });
}

// The same files as a candidate recorded before the record stopped committing holds them at `head`, for a record read
// from that evidence.
function readCommittedReportFiles(dir, head, evidencePath, settings) {
  return settings.map((f) => {
    const text = git(dir, ['show', `${head}:${path.posix.join(evidencePath, f.name)}`], { allowFail: true });
    return { ...f, text: text === null ? null : readReportText(text, `${evidencePath}/${f.name}`) };
  });
}

// Each person's GitHub profile name, by lowercase login, for the page: the changes' authors, the people who asked
// for them and everyone who reviewed them or the release. A bot has none to read.
async function namesOf({ github, facts, prep, driversByPr, reviewsByPr, releaseReviews, warn = () => {} }) {
  const logins = new Set();
  const add = (login) => { if (login && !/\[bot\]$/i.test(login)) logins.add(String(login).toLowerCase()); };
  // The people the report names for a step after the merge.
  for (const login of personStepLogins(prep && prep.report)) add(login);
  for (const pr of facts.prs) {
    add(pr.author);
    for (const d of driversByPr.get(pr.number) || []) add(d);
    for (const r of reviewsByPr.get(pr.number) || []) add(r && r.user && r.user.login);
  }
  for (const r of releaseReviews) add(r && r.user && r.user.login);
  const names = new Map();
  for (const login of [...logins].sort()) {
    const name = await github.getUserName(login);
    // Kept as GitHub gave it, on one line: nameOf cleans it where it is shown, so cleaning here would show its escapes.
    if (name) names.set(login, String(name).replace(/\s+/g, ' ').trim().slice(0, 200));
  }
  for (const login of personStepLogins(prep && prep.report)) {
    if (!names.has(login)) warn(`${login} has a step on the page and no profile name on GitHub (or no such login), so the page shows the login: check the login, or ask them to set a name`);
  }
  return names;
}

// The notes for the release manager, as one comment on the release PR: made once, and edited when they change.
// Only a bot's comment that starts with the marker is taken for the one already made. Returns what it did.
async function postManagerNotes({ github, repo, prNumber, tag, notes }) {
  const body = managerNotesComment(tag, notes);
  if (!body) return 'none';
  const marker = notesMarker(tag);
  const ours = (await github.listIssueComments(repo, prNumber))
    .find((c) => c && isBotUser(c.user) && String(c.body || '').replace(/\r\n?/g, '\n').split('\n')[0].trim() === marker);
  if (!ours) {
    await github.createIssueComment(repo, prNumber, body);
    return 'created';
  }
  if (String(ours.body).replace(/\r\n?/g, '\n') === body) return 'unchanged';
  await github.updateIssueComment(repo, ours.id, body);
  return 'updated';
}

// `--find-release-run`: the release run the record on the PR's page names, written to `--out` (the run id, or nothing when
// the page names none), for the review job to download its `results` before it records. Whether the run is this
// release's is checked when the record reads it (`--review`), never here.
async function findReleaseRun({ opts, env, github, out }) {
  const clash = ['results', 'facts', 'prep', 'releaseRun'].filter((k) => opts[k] !== undefined).map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  for (const [key, flag] of [['update', '--update'], ['fromCandidate', '--from-candidate'], ['fromEvidence', '--from-evidence'], ['review', '--review'], ['draftUntilShip', '--draft-until-ship']]) if (opts[key]) clash.push(flag);
  if (clash.length) throw new ReleaseError(`--find-release-run only reads the release PR: leave out ${clash.join(' and ')}`);
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('--find-release-run needs GITHUB_REPOSITORY, as <owner>/<name>');
  const prNumber = Number(need(opts, 'pr', '--pr'));
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new ReleaseError('--pr must be the release PR\'s number');
  const pull = await github.getPull(repo, prNumber);
  const runId = releaseRunOf(pull.body);
  fs.writeFileSync(path.resolve(opts.out), runId || '');
  out.write(runId
    ? `The record on #${prNumber} names release run ${runId}.\n`
    : `The record on #${prNumber} names no release run: it is read from the evidence its head holds, if any.\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// A release prepared again: the cut's new page on the PR (decision 8 of #593)

// `prepared-again.json` of the cut's artifact `prepared-again` (lib/prepare-again-cut.js), checked field by field: what the cut did
// for which request on which PR. Anything else is a ReleaseError: the mode writes nothing.
function readOutcome(folder) {
  const file = path.join(path.resolve(folder), AGAIN_RESULT);
  let o;
  try {
    o = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw new ReleaseError(`--prepared-again: ${AGAIN_RESULT} in ${folder} could not be read as JSON, so nothing was written`);
  }
  const positive = (v) => Number.isSafeInteger(v) && v > 0;
  const bad = (why) => new ReleaseError(`--prepared-again: ${AGAIN_RESULT} ${why}, so nothing was written`);
  if (!o || typeof o !== 'object' || Array.isArray(o)) throw bad('is not an object');
  if (!positive(o.pr)) throw bad('names no PR');
  if (!positive(o.request)) throw bad('names no request');
  if (o.outcome !== 'applied' && o.outcome !== 'refused') throw bad('says neither applied nor refused');
  if (typeof o.message !== 'string') throw bad('has no message');
  if (typeof o.tag !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._+-]{0,99}$/.test(o.tag)) throw bad('names no release tag');
  if (o.outcome === 'applied' && !/^[0-9a-f]{40}$/.test(String(o.sha))) throw bad('says applied and names no commit');
  return {
    pr: o.pr, request: o.request, outcome: o.outcome, message: o.message, sha: o.outcome === 'applied' ? o.sha : null, tag: o.tag,
  };
}

const isBotUser = (u) => Boolean(u) && (u.type === 'Bot' || /\[bot\]$/i.test(String(u.login || '')));

// Who asked: the login the accepted request's reply names (a comment of the repo's Actions, lib/prepare-again.js), or null.
function requesterOf(comments, request) {
  const found = parseRequestMarkers(comments).filter((m) => m.request === request);
  return found.length ? found[found.length - 1].by : null;
}

// The one reply of the mode to a request, made once and edited when a run comes again: only a bot's comment whose first line is
// the request's marker is taken for it. Returns what it did.
async function postPageReply({
  github, repo, prNumber, request, body, comments,
}) {
  const marker = pageMarker(request);
  const ours = (comments || await github.listIssueComments(repo, prNumber))
    .find((c) => c && isBotUser(c.user) && String(c.body || '').replace(/\r\n?/g, '\n').split('\n')[0].trim() === marker);
  if (!ours) {
    await github.createIssueComment(repo, prNumber, body);
    return 'posted';
  }
  if (String(ours.body).replace(/\r\n?/g, '\n') === body) return 'already there';
  await github.updateIssueComment(repo, ours.id, body);
  return 'edited';
}

// `--prepared-again <dir>` alone: the cut's outcome, read from `<dir>`, put on the PR. A refusal (the cut refused the new prep) is
// answered on the PR with the cut's message and nothing else is written (exit 1). An applied one is checked against GitHub and the
// checkout first: the PR is open, at the commit the cut made, which carries `Release-Prepared-Again` for the request, and the new
// body's release data is the one its `Release-Data` trailer pins; any check that fails writes nothing (exit 2). Then the body is
// replaced by the cut's new body, carrying the release run the page named, whose id goes to `--out` for the record that follows.
async function preparedAgainPage({ opts, env, github, out }) {
  const clash = ['results', 'facts', 'prep', 'releaseRun'].filter((k) => opts[k] !== undefined).map((k) => `--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  for (const [key, flag] of [['update', '--update'], ['fromEvidence', '--from-evidence'], ['review', '--review'], ['draftUntilShip', '--draft-until-ship']]) if (opts[key]) clash.push(flag);
  if (clash.length) throw new ReleaseError(`--prepared-again without --from-candidate puts the cut's page on the PR: leave out ${clash.join(' and ')}`);
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[^/\s]+\/[^/\s]+$/.test(repo)) throw new ReleaseError('--prepared-again needs GITHUB_REPOSITORY, as <owner>/<name>');
  const prNumber = Number(need(opts, 'pr', '--pr'));
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new ReleaseError('--pr must be the release PR\'s number');
  const outFile = path.resolve(need(opts, 'out', '--out'));
  const outcome = readOutcome(opts.preparedAgain);
  if (outcome.pr !== prNumber) throw new ReleaseError(`--prepared-again: the cut prepared #${outcome.pr} again, not #${prNumber}, so nothing was written`);
  const { request } = outcome;
  const comments = await github.listIssueComments(repo, prNumber);
  const by = requesterOf(comments, request);

  if (outcome.outcome === 'refused') {
    const did = await postPageReply({
      github, repo, prNumber, request, comments, body: cutRefusedReply({ request, by, message: outcome.message }),
    });
    out.write(`The cut refused the new prep for request ${request} on #${prNumber}: reply ${did}. Nothing else was written.\n`);
    throw new Refusal(`the cut refused the new prep of ${outcome.tag} for request ${request}: ${outcome.message}`);
  }

  // Every check before anything is written.
  const nothing = (why) => new ReleaseError(`#${prNumber} was not prepared again: ${why}. Nothing was written`);
  const pull = await github.getPull(repo, prNumber);
  if (pull.state !== 'open') throw nothing(`it is ${clean(pull.state, 20)}`);
  const at = String(pull.head && pull.head.sha);
  if (at !== outcome.sha) throw nothing(`its head is ${at.slice(0, 7)}, not ${outcome.sha.slice(0, 7)}, the commit the cut made: a record of its head writes its page`);
  const dir = path.resolve(opts.dir);
  const checkout = resolveCommit(dir, 'HEAD');
  if (checkout !== outcome.sha) throw nothing(`the checkout is at ${checkout.slice(0, 7)}, not ${outcome.sha.slice(0, 7)}`);
  const message = git(dir, ['log', '-1', '--format=%B', outcome.sha]);
  if (!trailerValues(message, PREPARED_AGAIN).includes(String(request))) {
    throw nothing(`its head ${outcome.sha.slice(0, 7)} carries no ${PREPARED_AGAIN}: ${request} trailer`);
  }
  let body;
  try {
    body = fs.readFileSync(path.join(path.resolve(opts.preparedAgain), AGAIN_BODY), 'utf8');
  } catch {
    throw nothing(`the cut's ${AGAIN_BODY} could not be read`);
  }
  if (tagOf(body) !== outcome.tag) throw nothing(`the cut's ${AGAIN_BODY} is not the page of ${outcome.tag}`);
  let data;
  try {
    data = findReleaseData(body);
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    throw nothing(`the cut's ${AGAIN_BODY}: ${e.message}`);
  }
  const pinned = dataTrailerOf(message);
  if (!data) throw nothing(`the cut's ${AGAIN_BODY} holds no release data`);
  if (!pinned || data.digest !== pinned) throw nothing(`the release data of the cut's ${AGAIN_BODY} is ${data.digest}, and ${outcome.sha.slice(0, 7)} pins ${pinned || 'none'}`);
  // The results stay the release run's the page named: its marker goes on the new body, in the record's block, for the record.
  const run = releaseRunOf(pull.body);
  if (!run) throw nothing('the page names no release run, so there are no results to record the new head from: run the release workflow again');
  const s = body.indexOf(RECORD_START);
  if (s === -1 || s !== body.lastIndexOf(RECORD_START)) throw nothing(`the cut's ${AGAIN_BODY} has no record block`);
  const next = `${body.slice(0, s + RECORD_START.length)}\n${releaseRunMarker(run)}${body.slice(s + RECORD_START.length)}`;
  if (releaseRunOf(next) !== run) throw nothing(`the cut's ${AGAIN_BODY} has a broken record block`);
  if (next.length > MAX_BODY) throw nothing(`the new body is ${next.length} characters, over GitHub's limit of ${MAX_BODY}`);

  await github.updatePullBody(repo, prNumber, next);
  fs.writeFileSync(outFile, run);
  out.write(`Put the new page of ${outcome.tag} on #${prNumber} at ${outcome.sha.slice(0, 7)}, for request ${request}; its results are release run ${run}'s.\n`);
  return 0;
}

// ---------------------------------------------------------------------------
// The evidence a candidate recorded before this change holds: a review of one changes the record, the tests do not run again

// What `--from-evidence` reads in place of a results file: the two summaries a record made before the record stopped
// committing left at `head`, read from git's copy of that commit and never from the working tree. A review takes this
// path for a page that names no release run. Returns `{ results, evidencePath, files }`, or `{ missing, evidencePath }`
// with the reason the record shows when the commit holds no evidence, or evidence that cannot stand for the build. It
// never makes evidence: the record says HOLD, and the release workflow run again writes a record from its results.
function readCommittedEvidence({ dir, head, tag }) {
  const evidencePath = evidencePathOf(dir, head, tag);
  const names = EVIDENCE_NAMES;
  const texts = names.map((name) => git(dir, ['show', `${head}:${path.posix.join(evidencePath, name)}`], { allowFail: true }));
  const where = `\`${evidencePath}/\``;
  const at = head.slice(0, 7);
  const absent = names.filter((_, i) => texts[i] === null);
  if (absent.length === names.length) {
    return { missing: `no results of the tests and staging were found for ${at}: the record names no release run, and no evidence is committed in ${where}. Run the release workflow again`, evidencePath };
  }
  if (absent.length) return { missing: `the evidence in ${where} at ${at} lacks ${absent.map((n) => `\`${n}\``).join(' and ')}`, evidencePath };
  const bad = (why) => ({ missing: `the evidence in ${where} at ${at} cannot be used: ${why}`, evidencePath });
  let summary;
  let staging;
  try {
    [summary, staging] = texts.map((t) => JSON.parse(t));
  } catch {
    return bad('a file is not valid JSON');
  }
  for (const [name, file] of [[names[0], summary], [names[1], staging]]) {
    if (!file || typeof file !== 'object' || file.format !== EVIDENCE_FORMAT) return bad(`\`${name}\` is not format ${EVIDENCE_FORMAT}`);
    if (file.tag !== tag) return bad(`\`${name}\` is for ${clean(file.tag, 40)}, not ${clean(tag, 40)}`);
  }
  if (JSON.stringify(summary.build) !== JSON.stringify(staging.build)) return bad('the two files name different builds');
  let results;
  try {
    results = readResults({
      format: 1, build: summary.build, tests: summary.tests, staging: staging.staging, skipReasons: summary.skipReasons,
    });
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    return bad(clean(e.message, 160));
  }
  // The folder is the one the tested build's own config names (shipyard.yml or release.json), as in the first pass: a
  // candidate that moved it after the build has not kept the evidence where the build says.
  const loadedBuild = configAt(dir, results.build.source);
  const named = evidencePathOf(dir, results.build.source, tag, loadedBuild);
  if (named !== evidencePath) return bad(`the build's ${loadedBuild.file || 'repo config'} names \`${named}/\``);
  // An older file has no run id, or one that is not digits: it names no run, and every run of the workflow is judged.
  return { results, evidencePath, files: names, run: /^\d+$/.test(String(summary.run)) ? String(summary.run) : null };
}

// ---------------------------------------------------------------------------
// The build tested is the build that ships

function sameBuild({ dir, results, head, allowed }) {
  const { build, staging } = results;
  if (build.digest !== staging.digest) {
    return { ok: false, detail: `the tests ran build ${build.digest.slice(0, 19)} but staging ran ${staging.digest.slice(0, 19)}.` };
  }
  const src = git(dir, ['rev-parse', '--verify', '--quiet', `${build.source}^{commit}`], { allowFail: true });
  if (!src || !isAncestor(dir, build.source, head)) {
    return { ok: false, detail: `the build's source ${build.source.slice(0, 7)} is not in this candidate's history.` };
  }
  // `--no-renames` lists both names of a move: a shipped file moved into an allowed folder is still a change.
  const changed = git(dir, ['diff', '--name-only', '--no-renames', '-z', build.source, head]).split('\0').filter(Boolean);
  const outside = changed.filter((f) => !allowed.some((a) => f === a || f.startsWith(`${a}/`)));
  if (outside.length) {
    return { ok: false, detail: `${outside.length} file${outside.length === 1 ? '' : 's'} changed since the build's source ${build.source.slice(0, 7)}, outside the notes, changelog and evidence paths (${outside.slice(0, 3).join(', ')}${outside.length > 3 ? ', ...' : ''}).` };
  }
  return { ok: true, detail: `Staging ran the build the tests ran (${build.digest.slice(0, 19)}), made from ${build.source.slice(0, 7)}; since then only the release notes, changelog and evidence changed.` };
}

// ---------------------------------------------------------------------------
// The facts and the prep file the candidate was cut from

// `shipyard cut` keeps them in the release PR's body, pinned by the cut commit's `Release-Data` trailer
// (lib/release-data.js); a candidate cut before that holds them in `releases/<tag>/`. The PR's body names the
// tag; the repo is `GITHUB_REPOSITORY`. A body that does not match its cut commit is refused here, before
// anything is written, as is a candidate cut two or more minor versions before `current`, the Shipyard that reads.
// Everything read here is checked again against the PR below, as when they are named by hand.
async function readCandidateInputs({
  opts, env, github, current = null,
}) {
  if (opts.facts || opts.prep) throw new ReleaseError('--from-candidate reads the facts and the prep file from the candidate: leave out --facts and --prep');
  const repoName = env.GITHUB_REPOSITORY;
  if (!repoName || !/^[^/\s]+\/[^/\s]+$/.test(repoName)) throw new ReleaseError('--from-candidate needs GITHUB_REPOSITORY, as <owner>/<name>');
  const prNumber = Number(need(opts, 'pr', '--pr'));
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new ReleaseError('--pr must be the release PR\'s number');
  const pull = await github.getPull(repoName, prNumber);
  const tag = tagOf(pull.body);
  if (!tag || !/^[A-Za-z0-9._-]+$/.test(tag) || tag.includes('..')) throw new Refusal(`#${prNumber} is not a release PR \`shipyard cut\` opened: its body names no release tag`);
  const dir = path.resolve(opts.dir);
  // The cut commit is found from the PR's head in this checkout: a PR that moved to a commit the checkout does not hold
  // is refused here, as it is below once the facts are read.
  const checkout = resolveCommit(dir, 'HEAD');
  if (pull.head && pull.head.sha !== checkout) {
    throw new Refusal(`the checkout is at ${checkout.slice(0, 7)} but #${prNumber} is at ${String(pull.head.sha).slice(0, 7)}: check out the candidate's head`);
  }
  const folder = path.join(dir, 'releases', tag);
  const readFolderFile = async (name) => {
    try {
      return fs.readFileSync(path.join(folder, name), 'utf8');
    } catch {
      return null;
    }
  };
  const inputs = await readReleaseInputs({
    body: pull.body, tag, headSha: pull.head && pull.head.sha, getCommit: commitsFromGit(dir), prNumber, readFolderFile, current,
  });
  const { facts } = inputs;
  if (inputs.source === 'folder') {
    // The folder's own errors, as readJson words them.
    if (!facts) readJson(path.join(folder, 'facts.json'), 'facts the candidate was cut from');
    // A light release (lib/light.js) has no prep file: its page is made from the facts.
    if (!isLight(facts) && !inputs.prep) readJson(path.join(folder, 'prep.json'), 'prep file the candidate was cut from');
  }
  if (!facts || !facts.repo || String(facts.repo.name).toLowerCase() !== repoName.toLowerCase()) {
    throw new Refusal(`the facts on the candidate are for ${facts && facts.repo ? facts.repo.name : 'no repo'}, not ${repoName}`);
  }
  const prep = isLight(facts) ? lightPrepFor(facts) : inputs.prep;
  return {
    facts, prep, source: inputs.source, notes: inputs.notes, cut: inputs.cut,
  };
}

// The Shipyard code that ran this record: `--shipyard-sha` (the commit of the published workflow, which the
// record job reads from its own token) and the release tag that names it. The tag is read from the public
// repo; one that cannot be read is said so (`unread`), and never stops the record. No flag, no row.
function shipyardOf(sha, remote) {
  if (sha === undefined) return null;
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new ReleaseError('--shipyard-sha must be a full 40-character commit');
  try {
    return { sha, version: versionAt(readTagCommits(remote), sha) };
  } catch (e) {
    if (!(e instanceof TagsError)) throw e;
    return { sha, version: null, unread: true };
  }
}

// A change of the PR's draft state is a courtesy to the approver, never part of the record: a failure
// (a repo whose plan has no drafts, a token that may not, a dropped connection) is a warning and the verdict stands.
async function tidyDraft(err, change, what) {
  try {
    return await change();
  } catch (e) {
    // Any failure, a dropped connection or a timeout as much as an answer from GitHub.
    err.write(`shipyard record: warning: ${what}: ${e && e.message ? e.message : e}\n`);
    return false;
  }
}

// After the body is written: a SHIP at the head the PR has now marks it ready; a HOLD leaves it a draft
// (and makes it one if it is not). The PR is read again, so a push made while the record ran is seen:
// that head has no verdict yet, and its own record run will have the PR a draft until it does.
async function settleDraft({ github, repo, prNumber, head, ship, out, err }) {
  let now;
  try {
    now = await github.getPull(repo, prNumber);
  } catch (e) {
    err.write(`shipyard record: warning: could not read #${prNumber} to set its draft state: ${e && e.message ? e.message : e}\n`);
    return;
  }
  if (now.head.sha !== head) {
    out.write(`#${prNumber} moved to ${String(now.head.sha).slice(0, 7)} since the record was written: its draft state is left to the record of that commit.\n`);
    return;
  }
  if (ship) {
    const changed = await tidyDraft(err, () => github.setPullDraft(now, false), `could not mark #${prNumber} ready for review`);
    if (changed) out.write(`Marked #${prNumber} ready for review.\n`);
  } else {
    if (now.draft === true) {
      out.write(`#${prNumber} stays a draft: the record says HOLD.\n`);
    } else if (await tidyDraft(err, () => github.setPullDraft(now, true), `could not make #${prNumber} a draft`)) {
      out.write(`Made #${prNumber} a draft: the record says HOLD.\n`);
    }
  }
}

// Reads the release PR as it stands: the candidate's data, the results of the release run, the checks, the statuses and the
// reviews, and builds the record from them. It writes nothing to GitHub (but for a draft state, with --draft-until-ship, on the
// first pass) and nothing to disk: `run` writes the body and the status from what it returns, and `shipyard release-gate`
// reads the verdict from it. One builder, so a review and the gate count the same record.
async function readRecord({
  opts, env, github, out, err, shipyard, current = null,
}) {
  let facts;
  let prep;
  let inputs = null;
  if (opts.fromCandidate) {
    inputs = await readCandidateInputs({
      opts, env, github, current,
    });
    ({ facts, prep } = inputs);
  } else {
    facts = readJson(need(opts, 'facts', '--facts'), 'facts');
    if (isLight(facts)) {
      if (opts.prep) throw new ReleaseError('--prep: a light release has no prep file');
      prep = lightPrepFor(facts);
    } else {
      prep = readJson(need(opts, 'prep', '--prep'), 'prep file');
    }
  }
  // A review's results, and those of a release prepared again (the run the old page named), are read once the run is checked, below.
  const judgeRun = Boolean(opts.review || opts.preparedAgain !== undefined);
  let results = opts.fromEvidence || judgeRun ? null : readResults(readJson(need(opts, 'results', '--results'), 'results file'));
  const prNumber = Number(need(opts, 'pr', '--pr'));
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new ReleaseError('--pr must be the release PR\'s number');
  if (opts.releaseRun !== undefined && !/^[1-9]\d{0,18}$/.test(opts.releaseRun)) throw new ReleaseError('--release-run must be the id of a workflow run (digits)');
  if (/\.\.|^\/|^-|[\r\n]/.test(opts.changelog)) throw new ReleaseError(`--changelog must be a path inside the repo, not ${JSON.stringify(opts.changelog)}`);

  checkFacts(facts);
  const fromTag = checkRange(facts);
  // A release cut before names were required has none: only the cut asks for them. A light release has no prep file to lint.
  if (!isLight(facts)) assertPrepPasses(facts, prep, { names: false });
  const repo = facts.repo.name;
  const dir = path.resolve(opts.dir);

  const { pr, tag } = await checkReleasePr({ github, repo, prNumber, facts, prep, fromTag });

  // The record starts: the PR is a draft until the record has written a SHIP at its head, so an approval
  // is not asked for before the checks the record waits for have run. Only the first pass (no --update)
  // does it; the one that writes the body marks it ready.
  if (opts.draftUntilShip && !opts.update) {
    await tidyDraft(err, () => github.setPullDraft(pr, true), `could not make #${prNumber} a draft`);
  }

  if (git(dir, ['status', '--porcelain', '--untracked-files=no']).trim()) {
    throw new ReleaseError('the checkout is not clean: the record needs no changes to tracked files');
  }
  // The facts are the ones this candidate was cut from: the tag still points where they read it,
  // and the commit they end at is in the candidate.
  const fromCommit = fromTag.first ? firstReleaseCommit(dir, fromTag.first.from) : resolveCommit(dir, `refs/tags/${fromTag.tag}`);
  if (fromCommit !== facts.range.fromCommit) {
    throw new Refusal(`${facts.range.from} no longer points where the facts read it: make the facts again`);
  }
  const startHead = resolveCommit(dir, 'HEAD');
  if (!isAncestor(dir, facts.range.to, startHead)) {
    throw new Refusal(`the candidate does not contain ${facts.range.to.slice(0, 7)}, where the facts end: make them again`);
  }
  if (startHead !== pr.head.sha) {
    throw new Refusal(`the checkout is at ${startHead.slice(0, 7)} but #${prNumber} is at ${String(pr.head.sha).slice(0, 7)}: check out the candidate's head`);
  }
  // A release prepared again is recorded at the commit the cut made for it, and only there: a head that moved since is a push,
  // whose own record writes its page.
  const outcome = opts.preparedAgain !== undefined ? readOutcome(opts.preparedAgain) : null;
  if (outcome) {
    if (outcome.outcome !== 'applied' || outcome.pr !== prNumber || outcome.tag !== tag) {
      throw new ReleaseError(`--prepared-again: the cut's outcome is ${outcome.outcome} for ${clean(outcome.tag, 40)} on #${outcome.pr}, not a page of ${tag} on #${prNumber} to record`);
    }
    if (outcome.sha !== startHead) throw new Refusal(`#${prNumber} moved from ${outcome.sha.slice(0, 7)}, the commit the cut prepared again, to ${startHead.slice(0, 7)}: the record of that commit writes its page`);
  }

  // A record read from evidence a candidate recorded before this change holds at its head, or a review's results from
  // the release run the page names: with none that can be used, the record is HOLD and says why.
  let committedEvidence = null;
  let runMissing = null;
  let runUnreadable = false;
  if (opts.fromEvidence) {
    committedEvidence = readCommittedEvidence({ dir, head: startHead, tag });
    results = committedEvidence.results || null;
  } else if (judgeRun) {
    // The changelog and the version let a run from before a release was prepared again count for its new head (lib/release-run.js).
    const read = await readReleaseRun({
      github, repo, runId: opts.releaseRun, dir, cut: inputs.cut, releaseBranch: pr.head.ref, head: startHead, resultsFile: path.resolve(opts.results),
      changelog: opts.changelog, version: versionOf(tag, facts.tagPrefix),
    });
    results = read.results || null;
    runMissing = read.missing || null;
    runUnreadable = Boolean(read.unreadable);
  }

  // What GitHub says now.
  const fleetLogins = list(opts.fleetLogins);
  const reviewsByPr = new Map();
  const driversByPr = new Map();
  const headsByPr = new Map();
  const pullsByPr = new Map();
  for (const change of facts.prs) {
    // The change's last head before it merged, which an approval must have seen, and the issues
    // GitHub links to it, which an edit of its body after the merge cannot drop.
    const [reviews, merged, linked] = await Promise.all([
      github.listPullReviews(repo, change.number),
      github.getPull(repo, change.number),
      github.listClosingIssues(repo, change.number),
    ]);
    reviewsByPr.set(change.number, reviews);
    pullsByPr.set(change.number, merged);
    headsByPr.set(change.number, merged.head && /^[0-9a-f]{40}$/.test(String(merged.head.sha)) ? merged.head.sha : null);
    driversByPr.set(change.number, await driversOf({ github, repo, pr: change, issues: [...linked, ...(change.issues || [])], armedLabel: opts.armedLabel }));
  }
  // The changes that merged past a reviewer's call for a person: read now, so a label or marker put on after the cut counts.
  const gated = await readGated({
    github, repo, pulls: pullsByPr, changes: facts.prs.map((c) => ({ number: c.number, title: plainTitle(c.title), url: `https://github.com/${repo}/pull/${c.number}` })),
  });
  // The checks of the head, and of the commit the build was made from (a later one replacing an earlier): a release
  // run on the working branch built the commit below the cut, and the head's own checks are the ones the record
  // workflow runs on it (`required-check-workflows`).
  const sourceCommit = results ? git(dir, ['rev-parse', '--verify', '--quiet', `${results.build.source}^{commit}`], { allowFail: true }) : null;
  const checked = [...new Set([sourceCommit && sourceCommit.trim(), startHead].filter(Boolean))];
  let checkRuns = [];
  const statuses = [];
  for (const [order, sha] of checked.entries()) {
    const workflowRuns = await github.listWorkflowRuns(repo, sha);
    checkRuns.push(...(await github.listCheckRuns(repo, sha)).map((r) => {
      const w = workflowRunOf(r, workflowRuns);
      // A run of the repo's ask workflow or its release gate (the record starts each by `workflow_dispatch`) is no test of the commit it lands on.
      const askRun = Boolean(opts.askWorkflow && w && w.path === `.github/workflows/${opts.askWorkflow}`);
      const gateRun = Boolean(opts.gateWorkflow && w && w.path === `.github/workflows/${opts.gateWorkflow}`);
      return { ...r, order, event: w ? w.event : null, workflowPath: w ? w.path : null, workflowRunId: w ? w.id : null, askRun, gateRun };
    }));
    statuses.push(...(await github.listCommitStatuses(repo, sha)).map((r) => ({ ...r, order })));
  }
  // The release run that made the candidate: told by the caller, or read from the evidence a record committed before this change.
  // An earlier run of the same workflow on the commit (a release refused or cancelled, then started again) is not
  // this release's checks.
  const releaseRun = opts.releaseRun !== undefined ? opts.releaseRun : committedEvidence ? committedEvidence.run : null;
  if (releaseRun) checkRuns = onlyReleaseRun(checkRuns, releaseRun);

  // The tested build's own config says which reports the build wrote, and where a record made before this
  // change kept its evidence: a change to the config after the build is a change to the build.
  const configCommit = sourceCommit ? results.build.source : startHead;
  const warnConfig = (line) => err.write(`Warning: ${line}\n`);
  const loadedConfig = configAt(dir, configCommit, warnConfig);
  // A repo on shipyard.yml has its approvers from its area's team: GitHub is asked for the area and the default branch
  // only then, and not at all for what --area and --default-branch give.
  const resolved = await settingsOf(loadedConfig, {
    repo, area: opts.area, defaultBranch: opts.defaultBranch, github, warn: warnConfig,
  });
  const evidencePath = committedEvidence ? committedEvidence.evidencePath : evidencePathOf(dir, configCommit, tag, loadedConfig);
  // The template diff and the prod plan, for each that the same release.json switches on: the files the
  // build step wrote beside the results file, or, for a record read from the evidence, the ones committed.
  const settings = reportSettingsOf(loadedConfig);
  const approvers = approversOf(loadedConfig, resolved);
  const tests = testsOf(loadedConfig);
  const reportFiles = opts.fromEvidence
    ? readCommittedReportFiles(dir, startHead, evidencePath, settings)
    : readReportFiles(settings, path.dirname(path.resolve(opts.results)));
  // Nothing is committed: the head the record is written for is the head the PR has. The release notes, the changelog
  // and the evidence a record made before this change committed are the files that may change after the build.
  const head = startHead;
  const allowed = [`releases/${tag}`, ...EVIDENCE_KEPT.map((name) => path.posix.join(evidencePath, name)), opts.changelog];
  const same = results
    ? sameBuild({ dir, results, head, allowed })
    : { ok: false, detail: `not known: ${judgeRun ? 'the release run the record names gave no usable results.' : 'the head holds no usable evidence of which build was tested.'}` };

  // The commit `shipyard cut` made, found by its subject from the head (the release data's cut commit); a link to a file
  // at it works after the release branch is gone. A release whose data is in `releases/<tag>/` finds it as the commit that
  // added the prep file. With none found, the head holds the same files.
  const fromBody = inputs && inputs.source === 'body';
  const added = fromBody ? null : git(dir, ['log', '--diff-filter=A', '--format=%H', '--', `releases/${tag}/${isLight(facts) ? 'facts' : 'prep'}.json`], { allowFail: true });
  const cutCommit = fromBody ? inputs.cut.sha : (added || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || head;
  const links = { repoUrl: `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}`, cutCommit, changelog: opts.changelog };
  // The digest the cut commit's `Release-Data` trailer holds: what pins the data this page was made from.
  if (fromBody) links.dataDigest = dataTrailerOf(inputs.cut.message);
  // What the merge will publish, as the head holds it: the CHANGELOG section the tag step reads, and the notes.
  const changelogAtHead = isLight(facts) ? null : git(dir, ['show', `${startHead}:${opts.changelog}`], { allowFail: true });
  const releaseBody = changelogAtHead === null ? null : changelogSection(changelogAtHead, versionOf(tag, facts.tagPrefix));
  const releaseNotes = fromBody ? inputs.notes || '' : git(dir, ['show', `${startHead}:releases/${tag}/release-notes.md`], { allowFail: true }) || '';
  const published = releaseBody ? { releaseBody, releaseNotes } : null;

  // The release PR's reviews are read last, just before the page and the status are made from them: an approval that
  // comes in while the rest is read is in both, and the review run it starts, which sets its own status, can only be
  // about as late as this read (a build that read them first could set `pending` over it, and nothing would turn it green).
  const releaseReviews = await github.listPullReviews(repo, prNumber);
  const record = buildRecord({
    shipyard,
    facts, prep, results, tag, head, reviewsByPr, driversByPr, headsByPr, releaseReviews, checkRuns, statuses, sameBuild: same, fleetLogins,
    ignoreChecks: list(opts.ignoreChecks), links, gated, approvers, tests, prNumber, published, announces: announceCalled(dir, startHead), announcePage: announcePage(dir, startHead, repo), configFile: loadedConfig.file,
    report: reportFiles.map(({ key, title, word, name, text }) => ({ key, title, word, name, text })),
    // The run whose results the page shows, which a review reads back; a record read from committed evidence names its folder.
    // A run the review could not read is named too (with no results), so the next review reads it again.
    releaseRun: !opts.fromEvidence && opts.releaseRun !== undefined && (results || runUnreadable) ? opts.releaseRun : null,
    evidencePath: committedEvidence && results ? evidencePath : null,
    names: await namesOf({
      github, facts, prep, driversByPr, reviewsByPr, releaseReviews, warn: (line) => err.write(`Warning: ${line}\n`),
    }),
    evidenceMissing: committedEvidence && committedEvidence.missing ? committedEvidence.missing : runMissing,
  });

  // The body is read again, so an edit made while this ran is kept, and a PR that moved is not written over.
  const fresh = await github.getPull(repo, prNumber);
  if (fresh.head.sha !== pr.head.sha) throw new Refusal(`#${prNumber} moved from ${String(pr.head.sha).slice(0, 7)} to ${String(fresh.head.sha).slice(0, 7)} while the record was read: run it again`);
  return {
    record, pr, fresh, tag, repo, prNumber, startHead, head, prep, dir,
  };
}

// Starts the repo's release gate by `workflow_dispatch` on `main` with the PR's number (the job's own token may start a workflow
// that way, and no other). `main`, not the default branch: the release environment, which holds the App's key, admits `main` and
// the gate refuses any other ref (a repo's default branch may be `develop`). It is no judge of the gate's run: the gate posts its own check.
const GATE_REF = 'main';
async function startGate({ github, repo, workflow, prNumber, head, out }) {
  try {
    await github.dispatchWorkflow(repo, workflow, GATE_REF, dispatchInputs(workflow, 'gate', { pr: Number(prNumber) }, { pr: String(prNumber) }));
  } catch (e) {
    if (!(e instanceof GitHubError)) throw e;
    throw new ReleaseError(`the body of #${prNumber} is updated, but the release gate ${workflow} could not be started on ${GATE_REF} (${e.message}): it must exist there and accept workflow_dispatch with an input pr (shipyard-release.yml takes the inputs action and args), and ${RELEASE_STATUS} stays unmet until it runs. Run it by hand for #${prNumber}`);
  }
  out.write(`Started ${workflow} on ${GATE_REF} for #${prNumber} (the record at ${head.slice(0, 7)}).\n`);
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const now = io.now || (() => new Date());
  try {
    const opts = parseOptions(argv, FLAGS, { dir: '.', out: 'release-record.md', changelog: 'CHANGELOG.md', armedLabel: 'agent:ready' }, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-record.md for the rows, the evidence and when it says HOLD.\n`);
      return 0;
    }
    // Checked first: a flag that is wrong stops the run before it reads or writes anything.
    const shipyard = shipyardOf(opts.shipyardSha, io.publishedRemote);
    // The repo's ask workflow, whose runs on the commit the record does not judge (`workflow_dispatch` runs it by name).
    if (opts.askWorkflow !== undefined && !ASK_WORKFLOW.test(opts.askWorkflow)) throw new ReleaseError('--ask-workflow must be the file name of a workflow in .github/workflows (ask.yml)');
    if (opts.gateWorkflow !== undefined && !ASK_WORKFLOW.test(opts.gateWorkflow)) throw new ReleaseError('--gate-workflow must be the file name of a workflow in .github/workflows (release-gate.yml)');
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, graphqlUrl: env.GITHUB_GRAPHQL_URL, sleep: io.sleep });
    if (opts.findReleaseRun) return await findReleaseRun({ opts, env, github, out });
    // A review of a release PR recorded before the record stopped committing (its page names no release run): the
    // record is read again from the evidence its head holds, and the body is all that is written.
    if (opts.fromEvidence) {
      const clash = ['results', 'facts', 'prep'].filter((k) => opts[k]).map((k) => `--${k}`);
      if (opts.draftUntilShip) clash.push('--draft-until-ship');
      if (opts.releaseRun !== undefined) clash.push('--release-run');
      if (opts.review) clash.push('--review');
      if (clash.length) throw new ReleaseError(`--from-evidence reads the evidence committed on the candidate: leave out ${clash.join(' and ')}`);
      opts.fromCandidate = true;
    }
    // A review of a release PR whose page names its release run: the record is read again from that run's results, once
    // the run is checked to be this release's (lib/release-run.js). It leaves the draft state alone.
    if (opts.review) {
      if (!opts.fromCandidate || opts.releaseRun === undefined || opts.results === undefined) throw new ReleaseError('--review reads the results of the release run the record names: give --from-candidate, --release-run and --results');
      if (opts.draftUntilShip) throw new ReleaseError('--review leaves the draft state alone: leave out --draft-until-ship');
    }
    // A release prepared again (decision 8 of #593). Alone, the flag puts the cut's new page on the PR; with --from-candidate, the
    // new head is recorded as the record job records a head, from the results of the release run the old page named, checked as a
    // review checks them, and the request is answered once the body is written.
    if (opts.preparedAgain !== undefined) {
      if (!String(opts.preparedAgain).trim()) throw new ReleaseError('--prepared-again must be the folder of the cut\'s artifact prepared-again');
      if (!opts.fromCandidate && !opts.fromEvidence) return await preparedAgainPage({ opts, env, github, out });
      if (opts.review || opts.fromEvidence) throw new ReleaseError('--prepared-again records the head the cut made: leave out --review and --from-evidence');
      if (opts.releaseRun === undefined || opts.results === undefined) throw new ReleaseError('--prepared-again reads the results of the release run the old page named: give --release-run and --results');
    }
    const {
      record, pr, fresh, tag, repo, prNumber, startHead, head, prep, dir,
    } = await readRecord({
      opts, env, github, out, err, shipyard, current: currentOf(io),
    });
    let body = applyRecord(fresh.body, record, { recordedAt: now().toISOString().replace(/\.\d+Z$/, 'Z') });
    // A re-ship's body says what the fix changes: the PRs merged into the candidate since its re-ship cut.
    if (body.includes(RESHIP_FIX_START)) {
      body = fillReshipFix(body, await reshipFixes({ dir, github, repo, tag, head: startHead, branch: pr.head.ref }));
    }
    // GitHub refuses a longer body (422); the record says so in its own words, and writes nothing.
    if (body.length > MAX_BODY) {
      throw new Refusal(`the PR body with the record is ${body.length} characters, over GitHub's limit of ${MAX_BODY}, so nothing was written: shorten the notes or the prep file's report, or cut from an earlier commit so the release holds fewer PRs`);
    }
    fs.writeFileSync(path.resolve(opts.out), body);

    // The lint counted the top the cut writes; the record's own rows (check names, approvers) can make it longer.
    // Its line count never grows past the lint's (the lint counts every row the record can add), but a name can.
    for (const [rule, message] of topProblems(record.top)) out.write(`Warning: the release PR's top ${/^renders /.test(message) ? message : `is too long: ${message}`} [${rule}]\n`);
    out.write(`Record for ${tag}: ${record.recommendation}${record.reasons.length ? ` (${record.reasons.length} reason${record.reasons.length === 1 ? '' : 's'}: ${record.reasons.join('; ')})` : ''}. Body in ${opts.out}.\n`);
    if (opts.update) {
      await github.updatePullBody(repo, prNumber, body);
      out.write(`Updated the body of #${prNumber}.\n`);
      // The verdict the body now shows, as a status on the head the PR has, so `main` can require it. Written right after the body, so a failure leaves the body as it is.
      // Where the repo has a release gate, no status is set: `shipyard/release` has one source, the gate's check run, so `main` never sees two.
      if (opts.gateWorkflow !== undefined) {
        out.write(`Set no ${RELEASE_STATUS} status: the release gate (${opts.gateWorkflow}) posts it as a check run.\n`);
      } else {
        const verdict = releaseStatus(record);
        try {
          await github.createStatus(repo, head, {
            state: verdict.state, context: RELEASE_STATUS, description: verdict.description,
            targetUrl: fresh.html_url || `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}/pull/${prNumber}`,
          });
        } catch (e) {
          if (!(e instanceof GitHubError)) throw e;
          throw new ReleaseError(`the body of #${prNumber} is updated, but ${RELEASE_STATUS} could not be set on ${head.slice(0, 7)}: ${e.message}`);
        }
        out.write(`Set ${RELEASE_STATUS} to ${verdict.state} on ${head.slice(0, 7)}: ${verdict.description}\n`);
      }
      // The notes are a courtesy to the release manager: a comment that cannot be posted never holds back the status.
      const notes = await postManagerNotes({
        github, repo, prNumber, tag, notes: prep.report.managerNotes,
      });
      if (notes !== 'none') out.write(`Notes for the release manager: ${notes === 'unchanged' ? 'the comment is already there' : `comment ${notes}`}.\n`);
      // Last, so a person is asked to approve only a page that is whole: the body and the manager's notes are in.
      if (opts.draftUntilShip) await settleDraft({ github, repo, prNumber, head, ship: record.recommendation === 'SHIP', out, err });
      // A release prepared again: the request is answered once its page is whole, with one reply a run that comes again edits.
      if (opts.preparedAgain !== undefined) {
        const { request } = readOutcome(opts.preparedAgain);
        const comments = await github.listIssueComments(repo, prNumber);
        const did = await postPageReply({
          github, repo, prNumber, request, comments, body: pageReply({
            request, by: requesterOf(comments, request), sha: head, tag, recommendation: record.recommendation,
          }),
        });
        out.write(`Answered request ${request} on #${prNumber}: reply ${did}.\n`);
      }
      // Last of all, so the gate recounts a page that is whole. It runs on `main` (the release environment's key is read only there) and reads the PR itself: it is told which PR, never what the verdict is. A gate that cannot be started fails this
      // run, in words, because `main` then waits for a check that will not come.
      if (opts.gateWorkflow !== undefined) await startGate({ github, repo, workflow: opts.gateWorkflow, prNumber, head, out });
    }
    return 0;
  } catch (e) {
    if (e instanceof Refusal) {
      err.write(`shipyard record: refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof LintError || e instanceof GitHubError)) throw e;
    err.write(`shipyard record: ${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required|takes no))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

// The fix PRs of a re-ship (lib/reship.js): each commit on the first-parent line from the re-ship cut to `head` is a fix
// when it is a PR that GitHub says merged into the candidate's branch, or a cherry-pick of the merge commit of a merged PR
// (`shipyard cut --reship --fixes`), exactly its original's change. The re-ship cut is the newest commit on that line,
// `chore(release): <tag>`, with a `Release-Reship:` trailer; a re-ship cut before the release data moved to the PR's body
// is the newest commit that added a `releases/<tag>/reship-<run>.json`. Each fix with its title, its `Changelog:` line
// and its reviews.
function reshipCutOf({ dir, tag, head }) {
  const out = git(dir, ['log', '--first-parent', '--format=%H%x00%B%x01', '--grep=^Release-Reship:', head], { allowFail: true }) || '';
  for (const entry of out.split('\x01')) {
    const at = entry.indexOf('\0');
    if (at === -1) continue;
    const message = entry.slice(at + 1);
    if (message.split('\n')[0].trim() === `chore(release): ${tag}` && trailerValues(message, 'Release-Reship').length) return entry.slice(0, at).trim();
  }
  const added = (git(dir, ['log', '--diff-filter=A', '--format=%H', head, '--', `releases/${tag}/reship-*.json`], { allowFail: true }) || '')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  return added.length ? added[0] : null;
}

async function reshipFixes({ dir, github, repo, tag, head, branch }) {
  const cutSha = reshipCutOf({ dir, tag, head });
  if (!cutSha) return [];
  const fixes = [];
  const seen = new Set();
  for (const sha of git(dir, ['log', '--first-parent', '--format=%H', `${cutSha}..${head}`]).split('\n').map((l) => l.trim()).filter(Boolean)) {
    let fix = null;
    const origin = cherryPickOrigin(dir, sha);
    if (origin) {
      const found = (await github.listPullsOfCommit(repo, origin)).filter((p) => p && p.merged_at && p.merge_commit_sha === origin);
      if (found.length === 1) fix = found[0];
    } else {
      const n = prNumberOf(git(dir, ['log', '-1', '--format=%s', sha]).trim());
      if (n === null) continue;
      try {
        fix = await github.getPull(repo, n);
      } catch (e) {
        if (e instanceof GitHubError && e.status === 404) continue;
        throw e;
      }
      if (!fix.merged_at || !fix.base || fix.base.ref !== branch) continue;
    }
    if (!fix || seen.has(fix.number)) continue;
    seen.add(fix.number);
    fixes.push(await describeFix({ github, repo, pull: fix }));
  }
  return fixes.sort((a, b) => a.number - b.number);
}

function fillReshipFix(body, fixes) {
  const a = body.indexOf(RESHIP_FIX_START);
  const b = body.indexOf(RESHIP_FIX_END);
  if (b < a || a !== body.lastIndexOf(RESHIP_FIX_START) || b === -1 || b !== body.lastIndexOf(RESHIP_FIX_END)) {
    throw new Refusal(`the PR body has a broken re-ship block: ${RESHIP_FIX_START} and ${RESHIP_FIX_END} must be there once each, start first. Put back the block the cut wrote`);
  }
  return `${body.slice(0, a + RESHIP_FIX_START.length)}\n${reshipFixText(fixes)}\n${body.slice(b)}`;
}

module.exports = {
  readRecord, shipyardOf, reshipFixes, fillReshipFix, run, USAGE, evidencePathOf, approversOf, driversOf, DEFAULT_EVIDENCE,
};
