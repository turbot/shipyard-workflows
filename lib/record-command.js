'use strict';

// `shipyard record --facts <facts.json> --prep <prep.json> --results <results.json> --pr <number>`:
// write the release PR's audit record from GitHub's own data, commit the test summaries, staging
// results and checks.json on the candidate (through GitHub's API, so the commit is signed: no local
// commit and no push), and write the PR body: the top again with the verdict
// the record found ("Do not approve" when anything did not pass), and the audit record in its fold.
// With --update it also posts the notes for the release manager as a comment. Exit 0 when the
// record is written, SHIP or HOLD alike; 1 when refused (the PR is not this release's, the
// checkout is not its head, the facts are stale); 2 when it could not run.

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
const { textEntry, treeOf, commitChain } = require('./api-commit');
const { parseStart } = require('./start-config');
const { announceCalled } = require('./announce-called');
const { TagsError, readTagCommits, versionAt } = require('./published-tags');
const {
  readResults, buildRecord, applyRecord, tagOf, clean, REPORT_FILES, readReportText, workflowRunOf, onlyReleaseRun, checksFile, managerNotesComment, notesMarker, RELEASE_STATUS, releaseStatus,
} = require('./record');
const { checkReleasePr } = require('./release-pr');
const { driversOf } = require('./drivers');
const { isLight, lightPrepFor } = require('./light');

const USAGE = 'usage: shipyard record (--facts <facts.json> --prep <prep.json> | --from-candidate) --results <results.json> --pr <number> [--shipyard-sha <commit>] [--dir <checkout>] [--out <body file>] [--update] [--no-commit] [--draft-until-ship] [--release-run <run id>] [--commit-out <file>] [--changelog <path>] [--armed-label <label>] [--fleet-logins <a,b>] [--ignore-checks <a,b>]\n       shipyard record --from-evidence --pr <number> [--shipyard-sha <commit>] [--dir <checkout>] [--out <body file>] [--update] [--changelog <path>] [--armed-label <label>] [--fleet-logins <a,b>] [--ignore-checks <a,b>]';
const FLAGS = {
  '--facts': 'facts', '--prep': 'prep', '--results': 'results', '--pr': 'pr', '--dir': 'dir', '--out': 'out', '--changelog': 'changelog',
  '--armed-label': 'armedLabel', '--fleet-logins': 'fleetLogins', '--ignore-checks': 'ignoreChecks', '--release-run': 'releaseRun', '--shipyard-sha': 'shipyardSha', '--commit-out': 'commitOut',
};
const SWITCHES = { '--update': 'update', '--no-commit': 'noCommit', '--draft-until-ship': 'draftUntilShip', '--from-candidate': 'fromCandidate', '--from-evidence': 'fromEvidence' };
const RELEASE_JSON = '.github/release.json';
const DEFAULT_EVIDENCE = 'releases/{tag}/evidence';
const EVIDENCE_FORMAT = 1;
const EVIDENCE_NAMES = ['test-summary.json', 'staging-results.json'];
const CHECKS_NAME = 'checks.json';

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);

// ---------------------------------------------------------------------------
// Where the evidence goes

// `evidence` in the repo's `.github/release.json`, read at the commit it is given (the build's source): a folder, with
// `{tag}` for the release's tag. A path that could leave the repo or reach git's own files is refused.
function readReleaseJson(dir, head) {
  const text = git(dir, ['show', `${head}:${RELEASE_JSON}`], { allowFail: true });
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    throw new ReleaseError(`${RELEASE_JSON} at ${head.slice(0, 7)} is not valid JSON`);
  }
}

// `start.approvers` of the same release.json: who may approve a release of the repo, for the approver line.
// A repo with none, or a `start` this cannot read, names none, and the line then names no other approver.
function approversOf(dir, commit) {
  const json = readReleaseJson(dir, commit);
  if (!json || typeof json !== 'object' || json.start === undefined) return [];
  try {
    return parseStart(json.start, RELEASE_JSON).approvers;
  } catch {
    return [];
  }
}

// `tests` of the same release.json: the names of the jobs that are tests, so a skipped job it does not name is left out
// of the checks as not a test. Null when the repo names none, and every skipped job is then counted as skipped.
const TESTS_MAX = 50;
function testsOf(dir, commit) {
  const json = readReleaseJson(dir, commit);
  if (!json || typeof json !== 'object' || json.tests === undefined) return null;
  const ok = Array.isArray(json.tests) && json.tests.length <= TESTS_MAX
    && json.tests.every((t) => typeof t === 'string' && t.trim() && !/[\r\n]/.test(t));
  if (!ok) throw new ReleaseError(`${RELEASE_JSON}: tests must be a list of job names, each on one line (${TESTS_MAX} at most)`);
  return json.tests.map((t) => t.trim());
}

function evidencePathOf(dir, head, tag) {
  const json = readReleaseJson(dir, head);
  let template = DEFAULT_EVIDENCE;
  if (json !== null) {
    if (json && typeof json === 'object' && json.evidence !== undefined) {
      if (typeof json.evidence !== 'string' || !json.evidence.trim()) throw new ReleaseError(`${RELEASE_JSON}: evidence must be a folder path`);
      template = json.evidence.trim();
    }
  }
  const rel = template.replace(/\{tag\}/g, tag).replace(/\/+$/, '');
  const parts = rel.split('/');
  if (!rel || path.isAbsolute(rel) || /[\\\u0000-\u001f]/.test(rel) || parts.some((p) => !p || p === '.' || p === '..')
    || parts[0] === '.git' || /^-/.test(rel) || rel.toLowerCase().startsWith('.github/workflows')) {
    throw new ReleaseError(`${RELEASE_JSON}: evidence must be a folder inside the repo, not ${JSON.stringify(template)}`);
  }
  return rel;
}

// `report.templateDiff` and `report.prodPlan` of `.github/release.json` at `commit` (the build's source, as the
// evidence folder is): the settings that are on, as the entries of `REPORT_FILES`. Each is `true` or `false`.
function reportSettingsOf(dir, commit) {
  const json = readReleaseJson(dir, commit);
  const report = json && typeof json === 'object' && json.report && typeof json.report === 'object' && !Array.isArray(json.report) ? json.report : {};
  return REPORT_FILES.filter((f) => {
    if (report[f.key] !== undefined && typeof report[f.key] !== 'boolean') {
      throw new ReleaseError(`${RELEASE_JSON}: report.${f.key} must be true or false`);
    }
    return report[f.key] === true;
  });
}

// The files the build step wrote next to the results file, for each setting that is on; `text` is null for one it did
// not write. Never read through a link, so a file the artifact links to somewhere else is not copied into the repo.
function readReportFiles(settings, folder) {
  return settings.map((f) => {
    const file = path.join(folder, f.name);
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (!stat) return { ...f, text: null };
    if (!stat.isFile()) throw new ReleaseError(`${f.name} next to the results file must be a regular file, not a link or a folder`);
    return { ...f, text: readReportText(fs.readFileSync(file, 'utf8'), f.name) };
  });
}

// The same files as the candidate holds them at `head`, for a record read from the evidence.
function readCommittedReportFiles(dir, head, evidencePath, settings) {
  return settings.map((f) => {
    const text = git(dir, ['show', `${head}:${path.posix.join(evidencePath, f.name)}`], { allowFail: true });
    return { ...f, text: text === null ? null : readReportText(text, `${evidencePath}/${f.name}`) };
  });
}

// The evidence is written into the repo's tree by the API, not into the checkout: a folder that is a link in the
// repo, or sits under one, would make the write land somewhere else than the path names.
function refuseLinkedFolder(dir, commit, rel) {
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const at = parts.slice(0, i).join('/');
    const entry = git(dir, ['ls-tree', commit, '--', at], { allowFail: true });
    if (entry && /^120000 /.test(entry)) throw new ReleaseError(`${at} is a link in the repo; the evidence is not written through it`);
  }
}

// `run` is the id of the release run that made the candidate, when the record was told it: a review reads it
// back from here, so it judges the same checks the first record did.
function evidenceFiles(results, tag, run = null) {
  return {
    'test-summary.json': {
      format: EVIDENCE_FORMAT, tag, ...(run ? { run } : {}), build: results.build, tests: results.tests, ...(results.skipReasons ? { skipReasons: results.skipReasons } : {}),
    },
    'staging-results.json': { format: EVIDENCE_FORMAT, tag, build: results.build, staging: results.staging },
  };
}

// Commits the two summaries and any template diff or prod plan on the candidate, through GitHub's API (a commit the
// API makes with the job's token is signed, a local one is not), and moves the branch to it: a fast-forward only, so
// a branch that moved since the checkout was made is refused. Nothing is committed when `parent` already holds them
// as they are. Returns the new commit, or null. The checkout is not touched: the commit is not in it until it is fetched.
async function commitEvidence({
  dir, github, repo, branch, parent, rel, files, tag,
}) {
  refuseLinkedFolder(dir, parent, rel);
  const entries = [];
  for (const [name, json] of Object.entries(files)) {
    const file = path.posix.join(rel, name);
    const text = typeof json === 'string' ? json : `${JSON.stringify(json, null, 2)}\n`;
    if (git(dir, ['show', `${parent}:${file}`], { allowFail: true }) !== text) entries.push(textEntry(file, text));
  }
  if (!entries.length) return null;
  const message = `chore(release): evidence for ${tag}\n\nThe test summaries and staging results the ${tag} record was read from, kept in the repo because GitHub keeps Actions logs for 90 days.\n`;
  const { commit } = await commitChain({
    github, repo, parent, baseTree: treeOf(dir, parent), steps: [{ message, entries }],
  });
  try {
    await github.updateBranch(repo, branch, commit);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 422) {
      // A 422 is a branch that is no longer a fast-forward of the parent, or one GitHub will not take: say which.
      const now = await github.getRefSha(repo, `heads/${branch}`).catch(() => null);
      if (now && now !== parent) {
        throw new Refusal(`${branch} is no longer at ${parent.slice(0, 7)}, so the evidence was not committed: it moved to ${now.slice(0, 7)} while the record was made. Run the record again`);
      }
      throw new ReleaseError(`${branch} could not be moved to the evidence commit ${commit.slice(0, 7)}: ${e.message}`);
    }
    throw e;
  }
  return commit;
}

// The checks file the head already holds for this tag and build, parsed, or null. The record workflow writes the
// record twice for one build (before and after the evidence push): the second keeps the file the first committed,
// so it commits nothing and the PR's head does not move under it.
function committedChecks(dir, head, evidencePath, tag) {
  const text = git(dir, ['show', `${head}:${path.posix.join(evidencePath, CHECKS_NAME)}`], { allowFail: true });
  if (text === null) return null;
  try {
    const json = JSON.parse(text);
    return json && typeof json === 'object' && json.tag === tag ? json : null;
  } catch {
    return null;
  }
}

// Each person's GitHub profile name, by lowercase login, for the page: the changes' authors, the people who asked
// for them and everyone who reviewed them or the release. A bot has none to read.
async function namesOf({ github, facts, driversByPr, reviewsByPr, releaseReviews }) {
  const logins = new Set();
  const add = (login) => { if (login && !/\[bot\]$/i.test(login)) logins.add(String(login).toLowerCase()); };
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
  return names;
}

// The notes for the release manager, as one comment on the release PR: made once, and edited when they change.
// Only a bot's comment that starts with the marker is taken for the one already made. Returns what it did.
async function postManagerNotes({ github, repo, prNumber, tag, notes }) {
  const body = managerNotesComment(tag, notes);
  if (!body) return 'none';
  const marker = notesMarker(tag);
  const isBot = (u) => Boolean(u) && (u.type === 'Bot' || /\[bot\]$/i.test(String(u.login || '')));
  const ours = (await github.listIssueComments(repo, prNumber))
    .find((c) => c && isBot(c.user) && String(c.body || '').replace(/\r\n?/g, '\n').split('\n')[0].trim() === marker);
  if (!ours) {
    await github.createIssueComment(repo, prNumber, body);
    return 'created';
  }
  if (String(ours.body).replace(/\r\n?/g, '\n') === body) return 'unchanged';
  await github.updateIssueComment(repo, ours.id, body);
  return 'updated';
}

// ---------------------------------------------------------------------------
// The evidence already committed: a review changes the record, the tests do not run again

// What `--from-evidence` reads in place of a results file: the two summaries committed at `head`,
// read from git's copy of that commit and never from the working tree. Returns
// `{ results, evidencePath, files }`, or `{ missing, evidencePath }` with the reason the record
// shows when the commit holds no evidence, or evidence that cannot stand for the build. It never
// makes evidence: the record says HOLD, and the run of the next push commits it.
function readCommittedEvidence({ dir, head, tag }) {
  const evidencePath = evidencePathOf(dir, head, tag);
  const names = EVIDENCE_NAMES;
  const texts = names.map((name) => git(dir, ['show', `${head}:${path.posix.join(evidencePath, name)}`], { allowFail: true }));
  const where = `\`${evidencePath}/\``;
  const at = head.slice(0, 7);
  const absent = names.filter((_, i) => texts[i] === null);
  if (absent.length === names.length) {
    return { missing: `no evidence of the tests and staging is committed in ${where} at ${at}; the record that runs on the next push commits it`, evidencePath };
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
  // The folder is the one the tested build's own release.json names, as in the first pass: a
  // candidate that moved it after the build has not kept the evidence where the build says.
  const named = evidencePathOf(dir, results.build.source, tag);
  if (named !== evidencePath) return bad(`the build's release.json names \`${named}/\``);
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

// `shipyard cut` commits them to `releases/<tag>/` on the candidate, so the record reads the same
// ones each time it runs. The PR's body names the tag; the repo is `GITHUB_REPOSITORY`. Everything
// read here is checked again against the PR below, as when they are named by hand.
async function readCandidateInputs({ opts, env, github }) {
  if (opts.facts || opts.prep) throw new ReleaseError('--from-candidate reads the facts and the prep file from the candidate: leave out --facts and --prep');
  const repoName = env.GITHUB_REPOSITORY;
  if (!repoName || !/^[^/\s]+\/[^/\s]+$/.test(repoName)) throw new ReleaseError('--from-candidate needs GITHUB_REPOSITORY, as <owner>/<name>');
  const prNumber = Number(need(opts, 'pr', '--pr'));
  if (!Number.isInteger(prNumber) || prNumber < 1) throw new ReleaseError('--pr must be the release PR\'s number');
  const tag = tagOf((await github.getPull(repoName, prNumber)).body);
  if (!tag || !/^[A-Za-z0-9._-]+$/.test(tag) || tag.includes('..')) throw new Refusal(`#${prNumber} is not a release PR \`shipyard cut\` opened: its body names no release tag`);
  const folder = path.join(path.resolve(opts.dir), 'releases', tag);
  const facts = readJson(path.join(folder, 'facts.json'), 'facts the candidate was cut from');
  // A light release (lib/light.js) has no prep file: its page is made from the facts.
  const prep = isLight(facts) ? lightPrepFor(facts) : readJson(path.join(folder, 'prep.json'), 'prep file the candidate was cut from');
  if (!facts || !facts.repo || String(facts.repo.name).toLowerCase() !== repoName.toLowerCase()) {
    throw new Refusal(`the facts on the candidate are for ${facts && facts.repo ? facts.repo.name : 'no repo'}, not ${repoName}`);
  }
  return { facts, prep };
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
    // Checked first: a flag that is wrong stops the run before it commits anything.
    const shipyard = shipyardOf(opts.shipyardSha, io.publishedRemote);
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, graphqlUrl: env.GITHUB_GRAPHQL_URL });
    // A review changes the record and nothing else: the tests ran when the evidence was made, so the
    // record is read again from that evidence and the body is all that is written.
    if (opts.fromEvidence) {
      const clash = ['results', 'facts', 'prep'].filter((k) => opts[k]).map((k) => `--${k}`);
      if (opts.noCommit) clash.push('--no-commit');
      if (opts.draftUntilShip) clash.push('--draft-until-ship');
      if (opts.releaseRun !== undefined) clash.push('--release-run');
      if (clash.length) throw new ReleaseError(`--from-evidence reads the evidence committed on the candidate: leave out ${clash.join(' and ')}`);
      opts.fromCandidate = true;
    }
    let facts;
    let prep;
    if (opts.fromCandidate) {
      ({ facts, prep } = await readCandidateInputs({ opts, env, github }));
    } else {
      facts = readJson(need(opts, 'facts', '--facts'), 'facts');
      if (isLight(facts)) {
        if (opts.prep) throw new ReleaseError('--prep: a light release has no prep file');
        prep = lightPrepFor(facts);
      } else {
        prep = readJson(need(opts, 'prep', '--prep'), 'prep file');
      }
    }
    let results = opts.fromEvidence ? null : readResults(readJson(need(opts, 'results', '--results'), 'results file'));
    const prNumber = Number(need(opts, 'pr', '--pr'));
    if (!Number.isInteger(prNumber) || prNumber < 1) throw new ReleaseError('--pr must be the release PR\'s number');
    if (opts.releaseRun !== undefined && !/^[1-9]\d{0,18}$/.test(opts.releaseRun)) throw new ReleaseError('--release-run must be the id of a workflow run (digits)');
    if (opts.update && opts.noCommit) throw new ReleaseError('--update needs the evidence step: leave out --no-commit');
    if (/\.\.|^\/|^-|[\r\n]/.test(opts.changelog)) throw new ReleaseError(`--changelog must be a path inside the repo, not ${JSON.stringify(opts.changelog)}`);

    checkFacts(facts);
    const fromTag = checkRange(facts);
    // A release cut before names were required has none: only the cut asks for them. A light release has no prep file to lint.
    if (!isLight(facts)) assertPrepPasses(facts, prep, { names: false });
    const repo = facts.repo.name;
    const dir = path.resolve(opts.dir);

    const { pr, tag } = await checkReleasePr({ github, repo, prNumber, facts, prep, fromTag });

    // The record starts: the PR is a draft until the record has written a SHIP at its head, so an approval
    // that cannot count yet (a push of the evidence dismisses it) is not asked for. Only the pass that
    // commits evidence does it; the one that writes the body marks it ready.
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

    // The evidence is what the candidate holds at its head; with none, the record is HOLD and says why.
    let committedEvidence = null;
    if (opts.fromEvidence) {
      committedEvidence = readCommittedEvidence({ dir, head: startHead, tag });
      results = committedEvidence.results || null;
    }

    // What GitHub says now.
    const fleetLogins = list(opts.fleetLogins);
    const reviewsByPr = new Map();
    const driversByPr = new Map();
    const headsByPr = new Map();
    for (const change of facts.prs) {
      // The change's last head before it merged, which an approval must have seen, and the issues
      // GitHub links to it, which an edit of its body after the merge cannot drop.
      const [reviews, merged, linked] = await Promise.all([
        github.listPullReviews(repo, change.number),
        github.getPull(repo, change.number),
        github.listClosingIssues(repo, change.number),
      ]);
      reviewsByPr.set(change.number, reviews);
      headsByPr.set(change.number, merged.head && /^[0-9a-f]{40}$/.test(String(merged.head.sha)) ? merged.head.sha : null);
      driversByPr.set(change.number, await driversOf({ github, repo, pr: change, issues: [...linked, ...(change.issues || [])], armedLabel: opts.armedLabel }));
    }
    // A push made with a job's own token starts no workflow, so the evidence commit has no checks of
    // its own but those the record workflow runs on it (`required-check-workflows`): the checks of
    // the commit the build was made from count too, a later one replacing an earlier.
    const sourceCommit = results ? git(dir, ['rev-parse', '--verify', '--quiet', `${results.build.source}^{commit}`], { allowFail: true }) : null;
    const checked = [...new Set([sourceCommit && sourceCommit.trim(), startHead].filter(Boolean))];
    let checkRuns = [];
    const statuses = [];
    for (const [order, sha] of checked.entries()) {
      const workflowRuns = await github.listWorkflowRuns(repo, sha);
      checkRuns.push(...(await github.listCheckRuns(repo, sha)).map((r) => {
        const w = workflowRunOf(r, workflowRuns);
        return { ...r, order, event: w ? w.event : null, workflowPath: w ? w.path : null, workflowRunId: w ? w.id : null };
      }));
      statuses.push(...(await github.listCommitStatuses(repo, sha)).map((r) => ({ ...r, order })));
    }
    // The release run that made the candidate: told by the caller, or read from the evidence a first record committed.
    // An earlier run of the same workflow on the commit (a release refused or cancelled, then started again) is not
    // this release's checks.
    const releaseRun = opts.releaseRun !== undefined ? opts.releaseRun : committedEvidence ? committedEvidence.run : null;
    if (releaseRun) checkRuns = onlyReleaseRun(checkRuns, releaseRun);

    // The evidence folder is the one the tested build's own release.json names, never one the
    // candidate changed after the build: a change to release.json is then a change to the build.
    const configAt = sourceCommit ? results.build.source : startHead;
    const evidencePath = committedEvidence ? committedEvidence.evidencePath : evidencePathOf(dir, configAt, tag);
    // The template diff and the prod plan, for each that the same release.json switches on: the files the
    // build step wrote beside the results file, or, for a record read from the evidence, the ones committed.
    const settings = reportSettingsOf(dir, configAt);
    const approvers = approversOf(dir, configAt);
    const tests = testsOf(dir, configAt);
    const reportFiles = opts.fromEvidence
      ? readCommittedReportFiles(dir, startHead, evidencePath, settings)
      : readReportFiles(settings, path.dirname(path.resolve(opts.results)));
    const reportKept = reportFiles.filter((f) => f.text !== null);
    const files = results ? { ...evidenceFiles(results, tag, opts.releaseRun), ...Object.fromEntries(reportKept.map((f) => [f.name, f.text])) } : {};
    // Each test run and staging step of these results, in checks.json, written on every pass as the test summary is:
    // the same results write the same file, so a second record commits nothing, and tests run again on the same build
    // write it afresh. The check runs change after the evidence is committed, so the page names them at each pass.
    const heldChecks = committedChecks(dir, startHead, evidencePath, tag);
    if (results && !opts.fromEvidence) files[CHECKS_NAME] = checksFile({ tag, results });
    const allowed = [`releases/${tag}`, ...[...Object.keys(files), CHECKS_NAME].map((name) => path.posix.join(evidencePath, name)), opts.changelog];
    const same = results
      ? sameBuild({ dir, results, head: startHead, allowed })
      : { ok: false, detail: 'not known: the head holds no usable evidence of which build was tested.' };

    // The evidence is committed before the record is written, so the record names what is in the repo.
    // A record read from the evidence commits nothing: the head stays the head the PR has.
    const committed = opts.noCommit || opts.fromEvidence ? null : await commitEvidence({
      dir, github, repo, branch: pr.head.ref, parent: startHead, rel: evidencePath, files, tag,
    });
    if (opts.commitOut !== undefined) fs.writeFileSync(path.resolve(opts.commitOut), committed || '');
    // The commit the API made is the head the PR will have, but it is not in this checkout: what the record reads from
    // git it reads at `startHead`, and the evidence commit changes nothing but the evidence folder.
    const head = committed || startHead;

    // The commit `shipyard cut` made is the one that added the prep file; a link to a file at it
    // works after the release branch is gone. With none found, the head holds the same files.
    const added = git(dir, ['log', '--diff-filter=A', '--format=%H', '--', `releases/${tag}/${isLight(facts) ? 'facts' : 'prep'}.json`], { allowFail: true });
    const cutCommit = (added || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || head;
    const links = { repoUrl: `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}`, cutCommit, changelog: opts.changelog };
    // What the merge will publish, as the head holds it: the CHANGELOG section the tag step reads, and the notes.
    const changelogAtHead = isLight(facts) ? null : git(dir, ['show', `${startHead}:${opts.changelog}`], { allowFail: true });
    const releaseBody = changelogAtHead === null ? null : changelogSection(changelogAtHead, versionOf(tag, facts.tagPrefix));
    const published = releaseBody ? { releaseBody, releaseNotes: git(dir, ['show', `${startHead}:releases/${tag}/release-notes.md`], { allowFail: true }) || '' } : null;

    // The release PR's reviews are read last, just before the page and the status are made from them: an approval that
    // comes in while the rest is read is in both, and the review run it starts, which sets its own status, can only be
    // about as late as this read (a build that read them first could set `pending` over it, and nothing would turn it green).
    const releaseReviews = await github.listPullReviews(repo, prNumber);
    const record = buildRecord({
      shipyard,
      facts, prep, results, tag, head, reviewsByPr, driversByPr, headsByPr, releaseReviews, checkRuns, statuses, sameBuild: same, fleetLogins,
      ignoreChecks: list(opts.ignoreChecks), links, approvers, tests, prNumber, published, announces: announceCalled(dir, startHead),
      report: reportFiles.map(({ key, title, word, name, text }) => ({ key, title, word, name, text })),
      evidence: {
        path: evidencePath,
        files: committedEvidence
          ? [...(committedEvidence.files || []), ...(committedEvidence.files ? reportKept.map((f) => f.name) : []), ...(committedEvidence.files && heldChecks ? [CHECKS_NAME] : [])]
          : opts.noCommit ? [] : Object.keys(files),
      },
      names: await namesOf({
        github, facts, driversByPr, reviewsByPr, releaseReviews,
      }),
      evidenceMissing: committedEvidence && committedEvidence.missing ? committedEvidence.missing : null,
    });

    // The body is read again, so an edit made while this ran is kept, and a PR that moved is not written over.
    const fresh = await github.getPull(repo, prNumber);
    if (fresh.head.sha !== pr.head.sha && fresh.head.sha !== committed) throw new Refusal(`#${prNumber} moved from ${String(pr.head.sha).slice(0, 7)} to ${String(fresh.head.sha).slice(0, 7)} while the record was read: run it again`);
    let body = applyRecord(fresh.body, record, { recordedAt: now().toISOString().replace(/\.\d+Z$/, 'Z') });
    // A re-ship's body says what the fix changes: the PRs merged into the candidate since its re-ship cut.
    if (body.includes(RESHIP_FIX_START)) {
      body = fillReshipFix(body, await reshipFixes({ dir, github, repo, tag, head: startHead, branch: pr.head.ref }));
    }
    fs.writeFileSync(path.resolve(opts.out), body);

    // The lint counted the top the cut writes; the record's own rows (check names, approvers) can make it longer.
    // Its line count never grows past the lint's (the lint counts every row the record can add), but a name can.
    for (const [rule, message] of topProblems(record.top)) out.write(`Warning: the release PR's top ${/^renders /.test(message) ? message : `is too long: ${message}`} [${rule}]\n`);
    out.write(`Record for ${tag}: ${record.recommendation}${record.reasons.length ? ` (${record.reasons.length} reason${record.reasons.length === 1 ? '' : 's'}: ${record.reasons.join('; ')})` : ''}. Body in ${opts.out}${committed ? `, evidence committed at ${head.slice(0, 7)} in ${evidencePath}/` : ''}.\n`);
    if (opts.update) {
      if (head !== pr.head.sha) {
        throw new Refusal(`the evidence was just committed at ${head.slice(0, 7)}, which this checkout does not hold, so the PR was not updated: check out the candidate's head, then run this again with --update`);
      }
      await github.updatePullBody(repo, prNumber, body);
      out.write(`Updated the body of #${prNumber}.\n`);
      // The verdict the body now shows, as a status on the head the PR has (the evidence commit, or the candidate
      // when it has none), so `main` can require it. Written right after the body, so a failure leaves the body as it is.
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
      // The notes are a courtesy to the release manager: a comment that cannot be posted never holds back the status.
      const notes = await postManagerNotes({
        github, repo, prNumber, tag, notes: prep.report.managerNotes,
      });
      if (notes !== 'none') out.write(`Notes for the release manager: ${notes === 'unchanged' ? 'the comment is already there' : `comment ${notes}`}.\n`);
      // Last, so a person is asked to approve only a page that is whole: the body and the manager's notes are in.
      if (opts.draftUntilShip) await settleDraft({ github, repo, prNumber, head, ship: record.recommendation === 'SHIP', out, err });
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

// The fix PRs of a re-ship (lib/reship.js): each commit on the first-parent line from the commit that added
// the newest `releases/<tag>/reship-<run>.json` to `head` is a fix when it is a PR that GitHub says merged
// into the candidate's branch, or a cherry-pick of the merge commit of a merged PR (`shipyard cut --reship
// --fixes`), exactly its original's change. Each with its title, its `Changelog:` line and its reviews.
async function reshipFixes({ dir, github, repo, tag, head, branch }) {
  const added = (git(dir, ['log', '--diff-filter=A', '--format=%H', head, '--', `releases/${tag}/reship-*.json`], { allowFail: true }) || '')
    .split('\n').map((l) => l.trim()).filter(Boolean);
  if (!added.length) return [];
  const fixes = [];
  const seen = new Set();
  for (const sha of git(dir, ['log', '--first-parent', '--format=%H', `${added[0]}..${head}`]).split('\n').map((l) => l.trim()).filter(Boolean)) {
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
  reshipFixes, fillReshipFix, run, USAGE, evidencePathOf, approversOf, driversOf, DEFAULT_EVIDENCE,
};
