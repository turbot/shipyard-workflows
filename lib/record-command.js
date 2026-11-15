'use strict';

// `shipyard record --facts <facts.json> --prep <prep.json> --results <results.json> --pr <number>`:
// write the release PR's control record from GitHub's own data, commit the test summaries and
// staging results on the candidate, and write the PR body with the record folded under the top
// block (and HOLD in place of the prep run's SHIP when anything did not pass). Exit 0 when the
// record is written, SHIP or HOLD alike; 1 when refused (the PR is not this release's, the
// checkout is not its head, the facts are stale); 2 when it could not run.

const fs = require('node:fs');
const path = require('node:path');
const { createClient, GitHubError } = require('./github');
const { LintError, checkFacts } = require('./lint-prep');
const { checkRange } = require('./cut');
const { firstReleaseCommit } = require('./first-release');
const { assertPrepPasses } = require('./changelog');
const {
  ReleaseError, Refusal, git, parseTag, bump, formatVersion, resolveCommit, isAncestor,
} = require('./release-git');
const { parseOptions, need, readJson } = require('./release-args');
const {
  readResults, buildRecord, applyRecord, tagOf, clean, REPORT_FILES, readReportText,
} = require('./record');

const USAGE = 'usage: shipyard record (--facts <facts.json> --prep <prep.json> | --from-candidate) --results <results.json> --pr <number> [--dir <checkout>] [--out <body file>] [--update] [--no-commit] [--changelog <path>] [--armed-label <label>] [--fleet-logins <a,b>] [--ignore-checks <a,b>]\n       shipyard record --from-evidence --pr <number> [--dir <checkout>] [--out <body file>] [--update] [--changelog <path>] [--armed-label <label>] [--fleet-logins <a,b>] [--ignore-checks <a,b>]';
const FLAGS = {
  '--facts': 'facts', '--prep': 'prep', '--results': 'results', '--pr': 'pr', '--dir': 'dir', '--out': 'out', '--changelog': 'changelog',
  '--armed-label': 'armedLabel', '--fleet-logins': 'fleetLogins', '--ignore-checks': 'ignoreChecks',
};
const SWITCHES = { '--update': 'update', '--no-commit': 'noCommit', '--from-candidate': 'fromCandidate', '--from-evidence': 'fromEvidence' };
const RELEASE_JSON = '.github/release.json';
const DEFAULT_EVIDENCE = 'releases/{tag}/evidence';
const EVIDENCE_FORMAT = 1;
const EVIDENCE_NAMES = ['test-summary.json', 'staging-results.json'];

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

// Writes through no link that leaves the checkout: the deepest folder that exists must resolve inside it.
function assertInside(dir, rel) {
  const root = fs.realpathSync(dir);
  let at = path.join(dir, rel);
  while (!fs.existsSync(at)) at = path.dirname(at);
  const real = fs.realpathSync(at);
  if (real !== root && !real.startsWith(`${root}${path.sep}`)) {
    throw new ReleaseError(`${rel} leaves the checkout through a link; the evidence is not written there`);
  }
}

function evidenceFiles(results, tag) {
  return {
    'test-summary.json': { format: EVIDENCE_FORMAT, tag, build: results.build, tests: results.tests },
    'staging-results.json': { format: EVIDENCE_FORMAT, tag, build: results.build, staging: results.staging },
  };
}

// Commits the two summaries and any template diff or prod plan; nothing is committed when they are already there as they are.
function commitEvidence({ dir, rel, files, tag }) {
  assertInside(dir, rel);
  const paths = [];
  fs.mkdirSync(path.join(dir, rel), { recursive: true });
  assertInside(dir, rel);
  for (const [name, json] of Object.entries(files)) {
    const file = path.posix.join(rel, name);
    fs.writeFileSync(path.join(dir, file), typeof json === 'string' ? json : `${JSON.stringify(json, null, 2)}\n`);
    paths.push(file);
  }
  try {
    git(dir, ['add', '--', ...paths]);
    if (!git(dir, ['diff', '--cached', '--name-only', '--', ...paths]).trim()) return false;
    git(dir, ['commit', '--quiet', '-m', `chore(release): evidence for ${tag}`, '-m', `The test summaries and staging results the ${tag} record was read from, kept in the repo because GitHub keeps Actions logs for 90 days.`, '--', ...paths]);
    return true;
  } catch (e) {
    // Put the checkout back the way it was found, so a re-run starts clean.
    for (const file of paths) {
      if (git(dir, ['cat-file', '-e', `HEAD:${file}`], { allowFail: true }) !== null) {
        git(dir, ['checkout', '--quiet', 'HEAD', '--', file], { allowFail: true });
      } else {
        git(dir, ['rm', '--quiet', '--cached', '--ignore-unmatch', '--', file], { allowFail: true });
        fs.rmSync(path.join(dir, file), { force: true });
      }
    }
    throw e;
  }
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
    results = readResults({ format: 1, build: summary.build, tests: summary.tests, staging: staging.staging });
  } catch (e) {
    if (!(e instanceof ReleaseError)) throw e;
    return bad(clean(e.message, 160));
  }
  // The folder is the one the tested build's own release.json names, as in the first pass: a
  // candidate that moved it after the build has not kept the evidence where the build says.
  const named = evidencePathOf(dir, results.build.source, tag);
  if (named !== evidencePath) return bad(`the build's release.json names \`${named}/\``);
  return { results, evidencePath, files: names };
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
// Who drove a change

const BOT = (user) => !user || user.type === 'Bot' || /\[bot\]$/i.test(user.login || '');

// Its human author, its issues' authors, and whoever armed it (put the label on the PR or on an issue).
// An issue is a number in `repo`, or `{ repo, number }` for one GitHub links from another repo.
async function driversOf({ github, repo, pr, issues, armedLabel }) {
  const drivers = new Set();
  const add = (user) => {
    if (user && user.login && !BOT(user)) drivers.add(user.login.toLowerCase());
  };
  if (pr.author) drivers.add(String(pr.author).toLowerCase());
  const refs = new Map();
  for (const i of issues) {
    const ref = typeof i === 'object' && i ? { repo: i.repo, number: i.number } : { repo, number: i };
    refs.set(`${ref.repo.toLowerCase()}#${ref.number}`, ref);
  }
  const owned = [{ repo, number: pr.number }, ...refs.values()];
  // `Refs #N` may name a discussion, a deleted issue or a typo: GitHub answers 404 or 410, and
  // there is nobody to count. Any other failure stops the record, since the list may be short.
  const unlessGone = async (read, none) => {
    try {
      return await read();
    } catch (e) {
      if (e instanceof GitHubError && (e.status === 404 || e.status === 410)) return none;
      throw e;
    }
  };
  for (const i of refs.values()) {
    const issue = await unlessGone(() => github.getIssue(i.repo, i.number), null);
    if (issue && issue.user) add(issue.user);
  }
  for (const i of owned) {
    for (const e of await unlessGone(() => github.listIssueEvents(i.repo, i.number), [])) {
      if (e && e.event === 'labeled' && e.label && e.label.name === armedLabel) add(e.actor);
    }
  }
  return drivers;
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
  const prep = readJson(path.join(folder, 'prep.json'), 'prep file the candidate was cut from');
  if (!facts || !facts.repo || String(facts.repo.name).toLowerCase() !== repoName.toLowerCase()) {
    throw new Refusal(`the facts on the candidate are for ${facts && facts.repo ? facts.repo.name : 'no repo'}, not ${repoName}`);
  }
  return { facts, prep };
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
    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, graphqlUrl: env.GITHUB_GRAPHQL_URL });
    // A review changes the record and nothing else: the tests ran when the evidence was made, so the
    // record is read again from that evidence and the body is all that is written.
    if (opts.fromEvidence) {
      const clash = ['results', 'facts', 'prep'].filter((k) => opts[k]).map((k) => `--${k}`);
      if (opts.noCommit) clash.push('--no-commit');
      if (clash.length) throw new ReleaseError(`--from-evidence reads the evidence committed on the candidate: leave out ${clash.join(' and ')}`);
      opts.fromCandidate = true;
    }
    let facts;
    let prep;
    if (opts.fromCandidate) {
      ({ facts, prep } = await readCandidateInputs({ opts, env, github }));
    } else {
      facts = readJson(need(opts, 'facts', '--facts'), 'facts');
      prep = readJson(need(opts, 'prep', '--prep'), 'prep file');
    }
    let results = opts.fromEvidence ? null : readResults(readJson(need(opts, 'results', '--results'), 'results file'));
    const prNumber = Number(need(opts, 'pr', '--pr'));
    if (!Number.isInteger(prNumber) || prNumber < 1) throw new ReleaseError('--pr must be the release PR\'s number');
    if (opts.update && opts.noCommit) throw new ReleaseError('--update needs the evidence step: leave out --no-commit');
    if (/\.\.|^\/|^-|[\r\n]/.test(opts.changelog)) throw new ReleaseError(`--changelog must be a path inside the repo, not ${JSON.stringify(opts.changelog)}`);

    checkFacts(facts);
    const fromTag = checkRange(facts);
    assertPrepPasses(facts, prep);
    const repo = facts.repo.name;
    const dir = path.resolve(opts.dir);

    // The PR is this release's: the tag its body names is the one the facts and the prep file make.
    const pr = await github.getPull(repo, prNumber);
    const tag = tagOf(pr.body);
    if (!tag || !parseTag(tag, facts.tagPrefix)) throw new Refusal(`#${prNumber} is not a release PR \`shipyard cut\` opened: its body names no release tag`);
    // A first release's number is the one the facts carry from the repo's firstRelease, not a level's.
    const expected = `${facts.tagPrefix}${fromTag.first ? fromTag.first.version : formatVersion(bump(fromTag.parts, prep.level.bump))}`;
    if (tag !== expected) throw new Refusal(`#${prNumber} is the PR for ${tag}, but the facts and the prep file make ${expected}: make them again`);
    if (pr.state !== 'open') throw new Refusal(`#${prNumber} is ${pr.state}: a record is written for an open candidate`);
    if (!pr.head || pr.head.ref !== `release/${tag.slice(facts.tagPrefix.length)}` || !pr.head.repo || String(pr.head.repo.full_name).toLowerCase() !== repo.toLowerCase()) {
      throw new Refusal(`#${prNumber} does not come from release/${tag.slice(facts.tagPrefix.length)} of ${repo}`);
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
    const releaseReviews = await github.listPullReviews(repo, prNumber);
    // A push made with a job's own token starts no workflow, so the evidence commit has no checks of
    // its own but those the record workflow runs on it (`required-check-workflows`): the checks of
    // the commit the build was made from count too, a later one replacing an earlier.
    const sourceCommit = results ? git(dir, ['rev-parse', '--verify', '--quiet', `${results.build.source}^{commit}`], { allowFail: true }) : null;
    const checked = [...new Set([sourceCommit && sourceCommit.trim(), startHead].filter(Boolean))];
    const checkRuns = [];
    const statuses = [];
    for (const [order, sha] of checked.entries()) {
      checkRuns.push(...(await github.listCheckRuns(repo, sha)).map((r) => ({ ...r, order })));
      statuses.push(...(await github.listCommitStatuses(repo, sha)).map((r) => ({ ...r, order })));
    }

    // The evidence folder is the one the tested build's own release.json names, never one the
    // candidate changed after the build: a change to release.json is then a change to the build.
    const configAt = sourceCommit ? results.build.source : startHead;
    const evidencePath = committedEvidence ? committedEvidence.evidencePath : evidencePathOf(dir, configAt, tag);
    // The template diff and the prod plan, for each that the same release.json switches on: the files the
    // build step wrote beside the results file, or, for a record read from the evidence, the ones committed.
    const settings = reportSettingsOf(dir, configAt);
    const reportFiles = opts.fromEvidence
      ? readCommittedReportFiles(dir, startHead, evidencePath, settings)
      : readReportFiles(settings, path.dirname(path.resolve(opts.results)));
    const reportKept = reportFiles.filter((f) => f.text !== null);
    const files = results ? { ...evidenceFiles(results, tag), ...Object.fromEntries(reportKept.map((f) => [f.name, f.text])) } : {};
    const allowed = [`releases/${tag}`, ...Object.keys(files).map((name) => path.posix.join(evidencePath, name)), opts.changelog];
    const same = results
      ? sameBuild({ dir, results, head: startHead, allowed })
      : { ok: false, detail: 'not known: the head holds no usable evidence of which build was tested.' };

    // The evidence is committed before the record is written, so the record names what is in the repo.
    // A record read from the evidence commits nothing: the head stays the head the PR has.
    const committed = opts.noCommit || opts.fromEvidence ? false : commitEvidence({ dir, rel: evidencePath, files, tag });
    const head = resolveCommit(dir, 'HEAD');

    // The commit `shipyard cut` made is the one that added the prep file; a link to a file at it
    // works after the release branch is gone. With none found, the head holds the same files.
    const added = git(dir, ['log', '--diff-filter=A', '--format=%H', '--', `releases/${tag}/prep.json`], { allowFail: true });
    const cutCommit = (added || '').split('\n').map((l) => l.trim()).filter(Boolean).pop() || head;
    const links = { repoUrl: `https://github.com/${repo.split('/').map(encodeURIComponent).join('/')}`, cutCommit, changelog: opts.changelog };

    const record = buildRecord({
      facts, prep, results, tag, head, reviewsByPr, driversByPr, headsByPr, releaseReviews, checkRuns, statuses, sameBuild: same, fleetLogins,
      ignoreChecks: list(opts.ignoreChecks), links,
      report: reportFiles.map(({ key, title, word, name, text }) => ({ key, title, word, name, text })),
      evidence: {
        path: evidencePath,
        files: committedEvidence ? [...(committedEvidence.files || []), ...(committedEvidence.files ? reportKept.map((f) => f.name) : [])] : opts.noCommit ? [] : Object.keys(files),
      },
      evidenceMissing: committedEvidence && committedEvidence.missing ? committedEvidence.missing : null,
    });

    // The body is read again, so an edit made while this ran is kept, and a PR that moved is not written over.
    const fresh = await github.getPull(repo, prNumber);
    if (fresh.head.sha !== pr.head.sha) throw new Refusal(`#${prNumber} moved from ${String(pr.head.sha).slice(0, 7)} to ${String(fresh.head.sha).slice(0, 7)} while the record was read: run it again`);
    const body = applyRecord(fresh.body, record, { recordedAt: now().toISOString().replace(/\.\d+Z$/, 'Z') });
    fs.writeFileSync(path.resolve(opts.out), body);

    out.write(`Record for ${tag}: ${record.recommendation}${record.reasons.length ? ` (${record.reasons.length} reason${record.reasons.length === 1 ? '' : 's'}: ${record.reasons.join('; ')})` : ''}. Body in ${opts.out}${committed ? `, evidence committed at ${head.slice(0, 7)} in ${evidencePath}/` : ''}.\n`);
    if (opts.update) {
      if (head !== pr.head.sha) {
        throw new Refusal(`the evidence is committed at ${head.slice(0, 7)} and not pushed, so the PR was not updated: push the branch, then run this again with --update`);
      }
      await github.updatePullBody(repo, prNumber, body);
      out.write(`Updated the body of #${prNumber}.\n`);
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

module.exports = { run, USAGE, evidencePathOf, driversOf, DEFAULT_EVIDENCE };
