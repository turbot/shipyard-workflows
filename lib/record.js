'use strict';

// The release PR's control record: what changes, what was tested, who approved each change
// who did not drive it, who approved the release, that the build tested is the build that
// ships, and the risks with what we do about each. Pure: no network, no files, no git. `record-command.js` reads
// GitHub and the checkout and hands the answers in. A HOLD is written over the prep run's
// SHIP when any test, smoke step or check did not pass, or the build tested is not the build that
// ships. A missing second approver is the approver line at the top of the body, never a HOLD: the fix
// is a second approval on the release PR, which is the approvers' to give.

const { clean, hasSecret } = require('./clean');
const {
  TOP_START, TOP_END, WHERE_START, WHERE_END, WARN, renderTop, oneLine, andList,
} = require('./changelog');
const { ReleaseError, Refusal } = require('./release-git');

const RESULTS_FORMAT = 1;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const STATUSES = new Set(['pass', 'fail', 'skip']);
const START = '<!-- shipyard:record:start -->';
const END = '<!-- shipyard:record:end -->';
const MARKER = /^<!-- shipyard:release-pr (\S+) -->/;
const FAILED_CONCLUSIONS = new Set(['failure', 'cancelled', 'timed_out', 'startup_failure', 'action_required']);
// A skipped check is neither: it is shown as `skip` and does not turn the verdict (a skipped job did not fail).
const PASSED_CONCLUSIONS = new Set(['success', 'neutral']);
const SKIPPED_CONCLUSIONS = new Set(['skipped']);
// Workflow runs that do not test the commit, and what the record says of each: Dependabot's update jobs
// (event `dynamic`) and scheduled runs. Every other event (push, pull_request, the record's own
// workflow_dispatch, and the rest) is judged. GitHub starts other things as `dynamic` runs too, CodeQL's
// default setup among them (path `dynamic/github-code-scanning/codeql`), and that one tests the commit: a
// `dynamic` run is left out unless its workflow path names a service other than Dependabot.
const NOT_JUDGED_REASON = {
  dynamic: 'a Dependabot update job (event `dynamic`), which does not test the commit',
  schedule: 'a scheduled run (event `schedule`), which does not test the commit',
};
const SUPERSEDED_REASON = 'a later attempt of the same job ran';
const notJudgedReason = (run) => {
  if (run.event === 'dynamic' && /^dynamic\//.test(String(run.workflowPath || '')) && !/^dynamic\/dependabot\//.test(run.workflowPath)) return null;
  return NOT_JUDGED_REASON[run.event] || null;
};

// ---------------------------------------------------------------------------
// The build and test results the release job writes (results.json)

const isCount = (v) => Number.isInteger(v) && v >= 0;

// A name is kept in the evidence files as well as the PR, so a secret is masked where it is read.
function readName(value, where) {
  if (typeof value !== 'string' || !value.trim()) throw new ReleaseError(`results: ${where} must be a name`);
  return hasSecret(value) ? '(redacted)' : value.trim();
}

// A link that holds a secret (a token in its query) is refused, never echoed or kept.
function readUrl(value, where) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^https:\/\/[^\s()<>|`\\]{1,300}$/.test(value)) {
    throw new ReleaseError(`results: ${where} must be an https link with no spaces or brackets`);
  }
  if (hasSecret(value)) throw new ReleaseError(`results: ${where} holds what looks like a secret; leave it out of the link`);
  return value;
}

/**
 * Checks the results file and returns it as the record keeps it: only the fields below, so a
 * log, a header or an environment a job wrote into it never reaches the PR or the evidence.
 *
 *   { format: 1,
 *     build:   { digest: "sha256:<64 hex>", source: "<40 hex commit>" },
 *     tests:   [{ name, status: "pass"|"fail"|"skip", passed?, failed?, skipped?, url? }],
 *     staging: { digest: "sha256:<64 hex>", steps: [{ name, status, url? }] } }
 */
function readResults(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ReleaseError('results: the file must be a JSON object');
  if (raw.format !== RESULTS_FORMAT) throw new ReleaseError(`results: format must be ${RESULTS_FORMAT}`);
  const b = raw.build;
  if (!b || typeof b !== 'object' || !DIGEST.test(String(b.digest)) || !COMMIT.test(String(b.source))) {
    throw new ReleaseError('results: build needs a digest (sha256:<64 hex digits>) and the source commit (40 hex digits)');
  }
  if (!Array.isArray(raw.tests)) throw new ReleaseError('results: tests must be a list');
  const tests = raw.tests.map((t, i) => {
    if (!t || typeof t !== 'object') throw new ReleaseError(`results: tests[${i}] must be an object`);
    if (!STATUSES.has(t.status)) throw new ReleaseError(`results: tests[${i}].status must be pass, fail or skip`);
    const test = { name: readName(t.name, `tests[${i}].name`), status: t.status };
    for (const k of ['passed', 'failed', 'skipped']) {
      if (t[k] === undefined) continue;
      if (!isCount(t[k])) throw new ReleaseError(`results: tests[${i}].${k} must be a whole number, 0 or more`);
      test[k] = t[k];
    }
    const url = readUrl(t.url, `tests[${i}].url`);
    if (url) test.url = url;
    return test;
  });
  const s = raw.staging;
  if (!s || typeof s !== 'object' || !DIGEST.test(String(s.digest)) || !Array.isArray(s.steps)) {
    throw new ReleaseError('results: staging needs the digest it ran (sha256:<64 hex digits>) and a list of steps');
  }
  const steps = s.steps.map((t, i) => {
    if (!t || typeof t !== 'object') throw new ReleaseError(`results: staging.steps[${i}] must be an object`);
    if (!STATUSES.has(t.status)) throw new ReleaseError(`results: staging.steps[${i}].status must be pass, fail or skip`);
    const step = { name: readName(t.name, `staging.steps[${i}].name`), status: t.status };
    const url = readUrl(t.url, `staging.steps[${i}].url`);
    if (url) step.url = url;
    return step;
  });
  return { format: RESULTS_FORMAT, build: { digest: b.digest, source: b.source }, tests, staging: { digest: s.digest, steps } };
}

// ---------------------------------------------------------------------------
// The template diff and the prod plan: files a repo's own build step writes

// `report.templateDiff` and `report.prodPlan` in the repo's `.github/release.json` switch each on. The
// file is `<evidence folder>/<name>`; the record keeps it with the rest of the evidence and links it.
const REPORT_FILES = [
  { key: 'templateDiff', title: 'Template diff', word: 'template diff', name: 'template-diff.txt' },
  { key: 'prodPlan', title: 'Prod plan', word: 'prod plan', name: 'prod-plan.txt' },
];
const REPORT_MAX_BYTES = 5 * 1024 * 1024;

// The file's text as the record keeps it: whole, never edited. One that is too big, or holds what looks like a
// secret, is refused (exit 2) rather than committed: the evidence is read for years. `where` names the file.
function readReportText(text, where) {
  if (typeof text !== 'string') throw new ReleaseError(`${where} must be text`);
  if (Buffer.byteLength(text) > REPORT_MAX_BYTES) throw new ReleaseError(`${where} is over ${REPORT_MAX_BYTES / (1024 * 1024)} MB: write a shorter one, and link the full output from its first line`);
  if (hasSecret(text)) throw new ReleaseError(`${where} holds what looks like a secret; leave it out of the file`);
  return text;
}

// One row for each setting that is on. `text` is the file's content, null when the build step wrote none.
// A file that is missing or blank is a failed row, which holds the release: a record never shows an empty section.
function reportRows(entries, evidencePath) {
  return (entries || []).map(({ key, title, word, name, text }) => {
    const file = `${evidencePath}/${name}`;
    const first = text === null || text === undefined ? null : text.split(/\r?\n/).map((l) => l.trim()).find(Boolean);
    const problem = text === null || text === undefined
      ? `the ${word} file "${clean(file, 160)}" is missing`
      : first ? null : `the ${word} file "${clean(file, 160)}" is empty`;
    return {
      key, title, word, name, file, state: problem ? 'fail' : 'pass', problem, summary: first ? clean(first, 200) : '',
    };
  });
}

// ---------------------------------------------------------------------------
// People

const loginKey = (login) => String(login || '').toLowerCase();

// The fleet's own reviews never count: a bot account, or a login the repo names.
function isFleet(user, fleetLogins) {
  if (!user || !user.login) return true;
  return user.type === 'Bot' || /\[bot\]$/i.test(user.login) || fleetLogins.has(loginKey(user.login));
}

// Each reviewer's last say counts: a dismissal clears it, a comment decides nothing.
function lastReviews(reviews) {
  const last = new Map();
  for (const r of reviews) {
    const login = r && r.user && r.user.login;
    if (!login) continue;
    const state = String(r.state || '').toUpperCase();
    if (state === 'APPROVED' || state === 'CHANGES_REQUESTED') last.set(loginKey(login), { login, state, user: r.user, commit: r.commit_id || null });
    else if (state === 'DISMISSED') last.delete(loginKey(login));
  }
  return last;
}

const approvalsOf = (reviews) => [...lastReviews(reviews).values()].filter((r) => r.state === 'APPROVED');

// ---------------------------------------------------------------------------
// The rows

// Check 9, as the release check reads it: a change is approved at its own PR, of the last commit the
// PR had when it merged (`headsByPr`; with none known, no approval of it counts), or on the release
// PR at `head` by a person who did not drive that change.
function changesRow({
  facts, reviewsByPr, driversByPr, headsByPr = new Map(), releaseReviews = [], head = null, fleetLogins,
}) {
  const lines = [];
  const failing = [];
  const failingDrivers = new Set();
  const releaseApprovals = approvalsOf(releaseReviews).filter((a) => !isFleet(a.user, fleetLogins) && Boolean(head) && a.commit === head);
  for (const pr of facts.prs) {
    const approvals = approvalsOf(reviewsByPr.get(pr.number) || []).filter((a) => !isFleet(a.user, fleetLogins));
    const drivers = driversByPr.get(pr.number) || new Set();
    const merged = headsByPr.get(pr.number) || null;
    const own = approvals.filter((a) => !drivers.has(loginKey(a.login)) && Boolean(merged) && a.commit === merged);
    const independent = own.length ? own : releaseApprovals.filter((a) => !drivers.has(loginKey(a.login)));
    const changesRequested = [...lastReviews(reviewsByPr.get(pr.number) || []).values()].filter((r) => r.state === 'CHANGES_REQUESTED');
    const review = changesRequested.length
      ? `changes requested by ${changesRequested.map((r) => clean(r.login)).join(', ')}`
      : approvals.length ? `approved by ${approvals.map((a) => clean(a.login)).join(', ')}` : 'no approval';
    const issues = (pr.issues || []).length ? pr.issues.map((n) => `#${n}`).join(', ') : 'none';
    lines.push({ pr: pr.number, title: clean(pr.title, 80), issues, review, independentBy: independent.map((a) => a.login) });
    if (!independent.length) {
      failing.push(pr.number);
      // The risk row names the people who drove the change: the fleet is not one of them.
      for (const d of drivers) if (!/\[bot\]$/i.test(d) && !fleetLogins.has(d)) failingDrivers.add(d);
    }
  }
  const unattributed = (facts.unattributed || []).map((u) => ({ sha: String(u.sha).slice(0, 7), subject: clean(u.subject, 80) }));
  return { lines, unattributed, failing, drivers: [...failingDrivers].sort() };
}

// What was found, for the row and its section: never the rule.
function independentRow(changes) {
  const total = changes.lines.length;
  const lacking = changes.failing.length;
  const problems = [
    ...changes.failing.map((n) => `#${n} has no approval from a person who did not drive it`),
    ...changes.unattributed.map((u) => `commit ${u.sha} has no pull request, so no approval`),
  ];
  let found;
  if (!problems.length) found = `every change has an approval from a person who did not drive it, ${total} of ${total}`;
  else if (lacking === total && total > 0) found = `no PR has an approval from a person who did not drive it, ${total} of ${total}`;
  else if (lacking) found = `${lacking} of ${total} PRs have no approval from a person who did not drive them`;
  else found = '';
  if (changes.unattributed.length) {
    const n = changes.unattributed.length;
    found += `${found ? '; ' : ''}${n} commit${n === 1 ? ' has' : 's have'} no pull request, so no approval`;
  }
  return { state: problems.length ? 'fail' : 'pass', problems, found };
}

// The risk rows a release with no independent approval gets, `{ risk, undo }`: who drove the changes
// and who can clear it, then one row for each commit with no pull request, which an approval of
// the release cannot cover. None when every change has an approval.
function noSecondApproverRows(changes, approvers = []) {
  const lacking = changes.failing.length;
  const total = changes.lines.length;
  const who = changes.drivers.map((d) => clean(d));
  const rows = [];
  if (lacking) {
    const count = lacking === total ? `all ${total} change${total === 1 ? '' : 's'}` : `${lacking} of ${total} changes`;
    rows.push({
      risk: `${WARN} **No second approver.** ${who.length
        ? `${andList(who)} drove ${count}, and no other person approved ${lacking === 1 ? 'it' : 'them'}.`
        : `${count.replace(/^all /, 'All ')} ${lacking === 1 ? 'has' : 'have'} no approval from a person who did not drive ${lacking === 1 ? 'it' : 'them'}.`}`,
      // Never "wait for a person other than X" when X is the repo's only approver: that tells them they cannot approve.
      undo: otherApprovers(changes, approvers).length
        ? 'Ask another of this repo\'s approvers, who did not drive the changes, to approve this PR'
        : 'Weigh it when approving: no other approver of this repo is named in its start.approvers',
    });
  }
  for (const u of changes.unattributed) {
    rows.push({
      risk: `${WARN} **No pull request.** Commit ${u.sha} has no pull request, so it has no approval to show.`,
      undo: 'Review the commit by hand, as an approval of this PR cannot cover it',
    });
  }
  return rows;
}

// The repo's approvers who did not drive the changes: a team counts, as it may hold another person.
function otherApprovers(changes, approvers) {
  const named = new Set(changes.drivers.map(loginKey));
  return approvers.map((a) => String(a).replace(/^@/, '')).filter((a) => a.includes('/') || !named.has(loginKey(a)));
}

// The approver line at the top of the body: who made or asked for the changes no one else approved, and
// each commit with no PR. It never tells the approver they cannot approve: it names another approver only
// when the repo's `start.approvers` holds one who is not among the people it names (a team counts as one).
function approverLine(changes, approvers = []) {
  const total = changes.lines.length;
  const lacking = changes.failing.length;
  const who = changes.drivers.map((d) => clean(d));
  const parts = [];
  if (lacking) {
    const them = lacking === 1 ? 'it' : 'them';
    const count = lacking === total ? (total === 1 ? 'the one change' : `all ${total} changes`) : `${lacking} of the ${total} changes`;
    parts.push(who.length
      ? `${WARN} ${andList(who)} made or asked for ${count}, and no one else approved ${them}.`
      : `${WARN} No one approved ${count} but the people who made or asked for ${them}.`);
    if (otherApprovers(changes, approvers).length) parts.push(`An approval from another of this repo's approvers covers ${them}.`);
  }
  const n = changes.unattributed.length;
  if (n) {
    const shas = changes.unattributed.map((u) => u.sha);
    parts.push(`${WARN} ${n === 1 ? `Commit ${shas[0]} has` : `${n} commits (${shas.join(', ')}) have`} no pull request, so no one approved ${n === 1 ? 'it' : 'them'}: review ${n === 1 ? 'it' : 'them'} by hand.`);
  }
  if (parts.length) return parts.join(' ');
  return total ? 'Every change was approved by a person who did not make or ask for it.' : 'There are no changes to approve.';
}

// What the approver's line says of a check that did not pass: running, skip or fail.
const checkWord = (result) => (result === 'waiting' ? 'running' : result === 'skip' ? 'skip' : 'fail');

// The tests line of the approver's part when a test did not pass: each test run and staging step, and any
// check that did not pass. With one test run that counts its passes, the count stands alone ("828 pass").
function testsCell({ results, tested }) {
  // A record read from evidence the candidate does not hold has no results: say so, and still show the checks.
  if (!results) {
    const failing = tested.checks.filter((x) => x.result !== 'pass').map((c) => `${c.name} ${checkWord(c.result)}`);
    return ['no evidence', ...failing].join(' \u00b7 ');
  }
  const named = results.tests.length > 1;
  const items = results.tests.map((t) => {
    const name = clean(t.name, 40);
    if (t.status === 'fail' || t.failed > 0) return `${name} fail`;
    if (t.status === 'skip') return `${name} skip`;
    return t.passed === undefined ? `${name} pass` : `${named ? `${name} ` : ''}${t.passed} pass`;
  });
  for (const s of results.staging.steps) items.push(`${clean(s.name, 40)} ${s.status === 'pass' ? 'pass' : s.status === 'skip' ? 'skip' : 'fail'}`);
  for (const c of tested.checks.filter((x) => x.result !== 'pass')) items.push(`${c.name} ${checkWord(c.result)}`);
  return items.length ? items.join(' \u00b7 ') : 'none recorded';
}

// Checks come from more than one commit, each item tagged with the order of its commit (`order`,
// oldest first). For each name, the newest commit that has a run of it that was not skipped decides,
// and every run of that name on that commit is graded on its own: a pass never hides a failure
// beside it, and a skipped run never replaces one. A name with only skipped runs is graded as is.
function resolve(items, nameOf, skipped) {
  const byName = new Map();
  for (const item of items) {
    const name = nameOf(item);
    if (!byName.has(name)) byName.set(name, []);
    byName.get(name).push(item);
  }
  const out = [];
  for (const group of byName.values()) {
    const real = group.filter((x) => !skipped(x));
    const pool = real.length ? real : group;
    const newest = Math.max(...pool.map((x) => x.order || 0));
    out.push(...pool.filter((x) => (x.order || 0) === newest));
  }
  return out;
}

// A later attempt of a job replaces an earlier one, as GitHub counts a required check. Among the
// check runs of one name made by one workflow file (`workflowPath`) on one commit, the run that
// started last decides (then the highest id), and every run of the workflow run it belongs to is
// still graded, so a pass never hides a failure beside it. The others are returned as `superseded`.
// A run with no known workflow run or file (another app's, or one the list does not hold), and a
// group where any run has no readable `started_at`, is left as it is: judged, never replaced.
function supersede(runs) {
  const groups = new Map();
  for (const run of runs) {
    if (run.workflowRunId == null || !run.workflowPath) continue;
    const key = JSON.stringify([run.name, run.workflowPath]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(run);
  }
  const superseded = new Set();
  for (const group of groups.values()) {
    if (new Set(group.map((r) => r.workflowRunId)).size < 2) continue;
    const started = (r) => (typeof r.started_at === 'string' ? Date.parse(r.started_at) : NaN);
    if (group.some((r) => Number.isNaN(started(r)))) continue;
    const idOf = (r) => (Number.isFinite(Number(r.id)) ? Number(r.id) : 0);
    const decider = group.reduce((x, y) => (started(y) > started(x) || (started(y) === started(x) && idOf(y) > idOf(x)) ? y : x));
    for (const r of group) if (r.workflowRunId !== decider.workflowRunId) superseded.add(r);
  }
  return { kept: runs.filter((r) => !superseded.has(r)), superseded };
}

// The workflow run an Actions check run belongs to, or null when it is not known: a check run of
// another app, or one whose run the list does not hold. A run with no known workflow run is judged.
// The run is found by the id in the check run's link, then by its check suite.
function workflowRunOf(run, workflowRuns) {
  if (run.app && run.app.slug && run.app.slug !== 'github-actions') return null;
  const m = /\/actions\/runs\/(\d+)(?:[/?#]|$)/.exec(String(run.details_url || ''));
  const suite = run.check_suite && run.check_suite.id;
  const found = workflowRuns.find((w) => (m && String(w.id) === m[1]) || (suite != null && w.check_suite_id === suite));
  return found || null;
}

// With `results` null (a record read from evidence the candidate does not hold), the row is a fail
// that says why; the checks are still read.
function testedRow({ results, evidenceMissing = null, checkRuns, statuses, ignoreChecks }) {
  const problems = [];
  const waiting = [];
  const failedTest = (t) => t.status === 'fail' || t.failed > 0;
  if (!results) {
    problems.push(clean(evidenceMissing || 'no test or staging results were recorded', 300));
  } else {
    if (!results.tests.length) problems.push('no test results were recorded');
    for (const t of results.tests) {
      if (failedTest(t)) problems.push(`test run "${clean(t.name, 60)}" did not pass`);
      else if (t.status === 'skip') problems.push(`test run "${clean(t.name, 60)}" was skipped`);
    }
    if (!results.staging.steps.length) problems.push('no staging steps were recorded');
    for (const s of results.staging.steps) {
      if (s.status === 'fail') problems.push(`staging step "${clean(s.name, 60)}" failed`);
      else if (s.status === 'skip') problems.push(`staging step "${clean(s.name, 60)}" was skipped`);
    }
  }
  const checks = [];
  const notJudged = [];
  const add = (name, result) => {
    checks.push({ name: clean(name, 60), result });
    if (result === 'fail') problems.push(`check "${clean(name, 60)}" did not pass`);
    if (result === 'waiting') waiting.push(`check "${clean(name, 60)}" is still running`);
  };
  const notJudgedRun = (run, reason) => notJudged.push({
    name: clean(run.name, 60), event: run.event, result: run.status !== 'completed' ? 'running' : clean(run.conclusion || 'none', 30), reason,
  });
  // Runs that do not test the commit are set aside first, so a scheduled run never replaces a push run.
  const onCommit = resolve(checkRuns, (r) => r.name, (r) => r.conclusion === 'skipped').filter((r) => !ignoreChecks.has(r.name));
  const { kept, superseded } = supersede(onCommit.filter((r) => !notJudgedReason(r)));
  for (const run of onCommit) {
    const reason = notJudgedReason(run);
    if (reason) notJudgedRun(run, reason);
    else if (superseded.has(run)) notJudgedRun(run, SUPERSEDED_REASON);
  }
  for (const run of kept) {
    add(run.name, run.status !== 'completed' ? 'waiting' : FAILED_CONCLUSIONS.has(run.conclusion) ? 'fail' : SKIPPED_CONCLUSIONS.has(run.conclusion) ? 'skip' : PASSED_CONCLUSIONS.has(run.conclusion) ? 'pass' : 'fail');
  }
  // The status API reports the same way a check run does: a state, by context.
  for (const st of resolve(statuses, (x) => x.context, () => false)) {
    if (ignoreChecks.has(st.context)) continue;
    add(st.context, st.state === 'success' ? 'pass' : st.state === 'pending' ? 'waiting' : 'fail');
  }
  return { state: problems.length ? 'fail' : waiting.length ? 'waiting' : 'pass', problems, waiting, checks, notJudged };
}

function approvalRow({ releaseReviews, head, fleetLogins }) {
  const approvals = approvalsOf(releaseReviews).filter((a) => !isFleet(a.user, fleetLogins));
  const current = approvals.filter((a) => a.commit === head);
  const stale = approvals.filter((a) => a.commit !== head);
  return { state: current.length ? 'pass' : 'waiting', current: current.map((a) => a.login), stale: stale.map((a) => a.login) };
}

/**
 * @param {object} i
 * @param {object} i.facts, i.prep, i.results (checked; null when a record is read from evidence the
 *   candidate does not hold, `i.evidenceMissing` then says why and is the one reason shown for the tests)
 * @param {Map<number, object[]>} i.reviewsByPr   each change's reviews, as the API lists them
 * @param {Map<number, Set<string>>} i.driversByPr  lowercase logins that drove each change
 * @param {Map<number, string>} i.headsByPr      each change's last head commit before it merged
 * @param {object[]} i.releaseReviews  the release PR's reviews
 * @param {object[]} i.checkRuns       check runs on the build's source and the candidate's head, each with `order` (oldest commit 0)
 * @param {object[]} i.statuses        commit statuses on the same commits, tagged the same way
 * @param {{ ok: boolean, detail: string }} i.sameBuild
 * @param {object[]} [i.report]   one entry for each of `report.templateDiff` and `report.prodPlan` that is on: `{ key, title, word, name, text }`, `text` null when the file is missing
 * @param {string} i.head, i.tag, i.evidence ({ path, files })
 * @param {{ repoUrl: string, cutCommit: string, changelog: string }} i.links  where "Where to find the rest" points: the repo's page, the commit `shipyard cut` made, and the changelog's path
 * @param {string[]} [i.approvers]  the repo's `start.approvers`: whether the approver line names another approver
 */
function buildRecord(i) {
  const fleetLogins = new Set((i.fleetLogins || []).map(loginKey));
  const ignoreChecks = new Set(i.ignoreChecks || []);
  const changes = changesRow({
    facts: i.facts, reviewsByPr: i.reviewsByPr, driversByPr: i.driversByPr, headsByPr: i.headsByPr, releaseReviews: i.releaseReviews, head: i.head, fleetLogins,
  });
  const independent = independentRow(changes);
  const tested = testedRow({ results: i.results, evidenceMissing: i.evidenceMissing, checkRuns: i.checkRuns, statuses: i.statuses || [], ignoreChecks });
  const approval = approvalRow({ releaseReviews: i.releaseReviews, head: i.head, fleetLogins });
  const sameBuild = { state: i.sameBuild.ok ? 'pass' : 'fail', detail: i.sameBuild.detail };
  // A missing independent approval is the approver line and a risk row of the control record (`riskRows`),
  // never a reason to hold. Every risk the record lists, its own first, is counted here, so no count can differ from its rows.
  const riskRows = noSecondApproverRows(changes, i.approvers || []);
  const risks = {
    list: [...riskRows, ...i.prep.report.risks.map((r) => ({ risk: clean(r.risk, 200), undo: clean(r.undo, 200) }))],
    // A first release (lib/first-release.js) has no release tag before it: its range starts at a ref.
    previous: { tag: i.facts.range.from, commit: i.facts.range.fromCommit, ...(i.facts.firstRelease ? { first: true } : {}) },
  };
  const report = reportRows(i.report, i.evidence.path);
  const reasons = [
    ...tested.problems,
    ...report.filter((r) => r.problem).map((r) => r.problem),
    ...(sameBuild.state === 'fail' && i.results ? [`the build tested is not the build that ships: ${clean(sameBuild.detail, 200)}`] : []),
  ];
  // The same reasons in the approver's words, for the line at the top: what failed, never how it was found.
  const headlines = [
    ...(i.results ? tested.problems : ['the test results of this release are missing', ...tested.problems.slice(1)]),
    ...report.filter((r) => r.problem).map((r) => r.problem),
    ...(sameBuild.state === 'fail' && i.results ? ['the build tested is not the build that ships'] : []),
  ];
  const recommendation = reasons.length ? 'HOLD' : 'SHIP';
  const approver = approverLine(changes, i.approvers || []);
  // The checks that were skipped, named so the line at the top never says "pass" for a job that did not run.
  const tests = { state: tested.state, text: testsCell({ results: i.results, tested }), skipped: tested.checks.filter((c) => c.result === 'skip').map((c) => c.name) };
  return {
    recommendation,
    reasons,
    headlines,
    approver,
    tests,
    top: renderTop({
      facts: i.facts, prep: i.prep, tag: i.tag, status: { recommendation, headlines, tests, approver },
    }),
    riskRows,
    summary: oneLine(i.prep.report.summary),
    level: { bump: i.prep.level.bump, reasons: i.prep.level.reasons.map(oneLine), ...(i.facts.firstRelease ? { first: oneLine(i.facts.firstRelease.version) } : {}) },
    links: i.links || null,
    tag: i.tag,
    head: i.head,
    rows: { changes, tested, independent, approval, sameBuild, risks, report },
    results: i.results,
    evidence: i.evidence,
  };
}

// ---------------------------------------------------------------------------
// The text

const SYMBOL = { pass: 'Pass', fail: 'Fail', waiting: 'Waiting' };

const cap = (text) => text.replace(/^./, (c) => c.toUpperCase());
// Where the release before this one is: its tag, or, for a first release, where its range starts.
const previousLine = (p) => (p.first ? `this is the repo's first release, and its range starts at \`${p.tag}\`` : `the last release is \`${p.tag}\``);
const list = (items) => items.map((x) => `- ${x}`).join('\n');

// A path in a link: each part encoded, and the brackets a link ends at as well.
const urlPath = (p) => p.split('/').map((part) => encodeURIComponent(part).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

// "Where to find the rest": each file at a commit, never a branch, so the link works after
// `release/<version>` is deleted. The control record's own sections are named, not linked.
function whereTable(record) {
  const l = record.links;
  const sha7 = (sha) => `\`${sha.slice(0, 7)}\``;
  const file = (sha, kind, p) => `[${clean(p, 100)}](${l.repoUrl}/${kind}/${sha}/${urlPath(p)})`;
  const evidence = record.evidence.files.length
    ? `${file(record.head, 'tree', record.evidence.path)} at ${sha7(record.head)}`
    : 'No evidence was committed.';
  const cut = `at the cut commit ${sha7(l.cutCommit)}`;
  return [
    '| To check | Go to |',
    '|---|---|',
    '| Each PR, its issue and its review | Control record › Changes, below |',
    `| Test and staging results | ${evidence} |`,
    `| The CHANGELOG section | ${file(l.cutCommit, 'blob', l.changelog)} ${cut} |`,
    `| The facts, and the prep run's level and flag answers | ${file(l.cutCommit, 'blob', `releases/${record.tag}/facts.json`)} and ${file(l.cutCommit, 'blob', `releases/${record.tag}/prep.json`)} ${cut} |`,
    '| What shipped, and when | The tag, and the "Shipped" comment after the merge |',
  ].join('\n');
}

// "Independent fail · Approval waiting · 4 pass": each row that is not a pass, then how many are.
function summaryOf(rows) {
  const states = [
    ['Changes', 'pass'], ['Tested', rows.tested.state], ['Independent', rows.independent.state],
    ['Approval', rows.approval.state], ['Same build', rows.sameBuild.state], ['Risks', 'pass'],
    ...rows.report.map((r) => [r.title, r.state]),
  ];
  const notPass = states.filter(([, state]) => state !== 'pass').map(([name, state]) => `${name} ${state}`);
  return [...notPass, `${states.length - notPass.length} pass`].join(' · ');
}

// A report file as a link at the commit the record is written for, so it works once the release branch is
// gone; a file the run did not commit (`--no-commit`) is named, not linked.
function reportLink(record, row) {
  const l = record.links;
  if (!l || !record.evidence.files.includes(row.name)) return `\`${row.file}\`${record.evidence.files.includes(row.name) ? '' : ' (not committed)'}`;
  return `[${clean(row.file, 100)}](${l.repoUrl}/blob/${record.head}/${urlPath(row.file)})`;
}

function renderRecord(record, { recordedAt } = {}) {
  const { rows } = record;
  const { changes } = rows;
  const evidence = record.evidence.files.length
    ? `Evidence kept in the repo at \`${record.evidence.path}/\`: ${record.evidence.files.map((f) => `\`${f}\``).join(', ')}.`
    : 'No evidence was committed.';

  const summary = [
    '| Row | Result | What it shows |',
    '|---|---|---|',
    `| Changes | ${changes.lines.length} PR${changes.lines.length === 1 ? '' : 's'}${changes.unattributed.length ? `, ${changes.unattributed.length} with no PR` : ''} | Each PR with its issue and review. |`,
    `| Tested | ${SYMBOL[rows.tested.state]} | ${record.results ? `Build \`${record.results.build.digest}\`: ${record.results.tests.length} test run${record.results.tests.length === 1 ? '' : 's'}, ${record.results.staging.steps.length} staging step${record.results.staging.steps.length === 1 ? '' : 's'}.` : 'No evidence of the tests and staging is committed at this commit.'} |`,
    `| Independent | ${SYMBOL[rows.independent.state]} | ${cap(clean(rows.independent.found, 300))}. |`,
    `| Approval | ${rows.approval.state === 'pass' ? 'Approved' : 'Waiting'} | ${rows.approval.state === 'pass' ? `Approved at this commit by ${rows.approval.current.map((l) => clean(l)).join(', ')}.` : 'No person has approved this commit yet.'} |`,
    `| Same build | ${SYMBOL[rows.sameBuild.state]} | ${clean(rows.sameBuild.detail, 300)} |`,
    `| Risks | | ${rows.risks.list.length} risk${rows.risks.list.length === 1 ? '' : 's'}, each with what we do; ${previousLine(rows.risks.previous)}. |`,
    ...rows.report.map((r) => `| ${r.title} | ${SYMBOL[r.state]} | ${r.problem ? `${cap(r.problem)}.` : `${reportLink(record, r)}: ${r.summary}`} |`),
  ].join('\n');

  const changesTable = [
    '| PR | Issue | Review |',
    '|---|---|---|',
    ...changes.lines.map((l) => `| #${l.pr} ${l.title} | ${l.issues} | ${l.review}${l.independentBy.length ? '' : ' (no independent approval)'} |`),
    ...changes.unattributed.map((u) => `| commit \`${u.sha}\` ${u.subject} | none | no pull request |`),
  ].join('\n');

  const link = (item) => (item.url ? ` ([log](${item.url}))` : '');
  const results = record.results || { build: null, tests: [], staging: { steps: [] } };
  const testLines = results.tests.map((t) => {
    const counts = ['passed', 'failed', 'skipped'].filter((k) => t[k] !== undefined).map((k) => `${t[k]} ${k}`).join(', ');
    return `${clean(t.name, 80)}: ${t.status}${counts ? ` (${counts})` : ''}${link(t)}`;
  });
  const stepLines = results.staging.steps.map((s) => `${clean(s.name, 80)}: ${s.status}${link(s)}`);
  const checkLines = rows.tested.checks.map((c) => `${c.name}: ${c.result}`);
  const notJudgedLines = rows.tested.notJudged.map((n) => `${n.name}: ${n.result}, not judged: ${n.reason}`);

  const sections = [
    `### Changes\n\n${changesTable}`,
    `### Level\n\n${record.level.first ? `**First release: ${record.level.first}**, set by firstRelease in .github/release.json, not by a level. The prep run's level was ${record.level.bump}; its reasons:` : `**${record.level.bump}.** The prep run's reasons:`}\n\n${list(record.level.reasons)}`,
    `### Tested\n\n${record.results ? `Build digest: \`${record.results.build.digest}\` from commit \`${record.results.build.source.slice(0, 7)}\`.` : 'Build digest: not known.'}\n\n${testLines.length ? `Tests:\n\n${list(testLines)}` : 'Tests: none recorded.'}\n\n${stepLines.length ? `Staging (digest \`${record.results.staging.digest}\`):\n\n${list(stepLines)}` : 'Staging: no steps recorded.'}${checkLines.length ? `\n\nChecks on this commit and on the build's source:\n\n${list(checkLines)}` : ''}${notJudgedLines.length ? `\n\nRuns left out of the judgement:\n\n${list(notJudgedLines)}` : ''}\n\n${evidence}`,
    `### Independent\n\n${rows.independent.problems.length ? `${cap(clean(rows.independent.found, 300))}.\n\n${list(rows.independent.problems)}\n\nThe approver line at the top of this PR says so; it is not a HOLD. A person who did not drive the changes clears it by approving this PR.` : 'Every change has an approval from a person who did not open it, write its issue or arm it. The fleet\'s own reviews do not count.'}`,
    `### Approval\n\n${rows.approval.state === 'pass' ? `Approved at \`${record.head.slice(0, 7)}\` by ${rows.approval.current.map((l) => clean(l)).join(', ')}.` : `Waiting for an approval at \`${record.head.slice(0, 7)}\`.`}${rows.approval.stale.length ? ` ${rows.approval.stale.map((l) => clean(l)).join(', ')} approved an earlier commit; that no longer counts.` : ''}`,
    `### Same build\n\n${clean(rows.sameBuild.detail, 300)}`,
    `### Risks\n\n${rows.risks.list.length ? list(rows.risks.list.map((r) => `${r.risk} What we do: ${r.undo}`)) : 'No risk was named.'}\n\n${cap(previousLine(rows.risks.previous))} (\`${rows.risks.previous.commit.slice(0, 7)}\`)${rows.risks.previous.first ? '' : ', the one to go back to'}.`,
    ...rows.report.map((r) => `### ${r.title}\n\n${r.problem
      ? `${cap(r.problem)}. The release is on HOLD until the build step writes it into the evidence it uploads.`
      : `File: ${reportLink(record, r)}\n\nSummary: ${r.summary}`}`),
  ];
  const holds = record.recommendation === 'HOLD' ? `\n\n${list(record.reasons)}` : '';
  return [
    START,
    '### Control record',
    '',
    '<details>',
    `<summary><strong>Control record: ${summaryOf(rows)}</strong></summary>`,
    '',
    `Read from GitHub${recordedAt ? ` at ${recordedAt}` : ''}, for \`${record.head.slice(0, 7)}\`. Run \`shipyard record\` again after a review or a check changes.${holds}`,
    '',
    summary,
    '',
    sections.join('\n\n'),
    '',
    '</details>',
    END,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// The body

// The tag the release PR was cut for, from its body's marker.
function tagOf(body) {
  const m = MARKER.exec(String(body || '').replace(/\r\n?/g, '\n'));
  return m ? m[1] : null;
}

// Puts `inner` between a pair of markers `shipyard cut` wrote. A body without the pair (or with
// it twice) is not one this layout's cut wrote.
function fill(text, start, end, inner, { keep = true } = {}) {
  const a = text.indexOf(start);
  const b = text.indexOf(end);
  if (a === -1 || b === -1 || b < a || a !== text.lastIndexOf(start) || b !== text.lastIndexOf(end)) {
    throw new Refusal(`the PR body has no ${start} ... ${end} block, once: it is not a body the current \`shipyard cut\` wrote, so cut again`);
  }
  return keep ? `${text.slice(0, a + start.length)}\n${inner}\n${text.slice(b)}` : `${text.slice(0, a)}${inner}${text.slice(b + end.length)}`;
}

// The new body: the approver's part at the top, the table of where the rest is kept, and the control
// record, each in the place the cut left for it. A record already there is replaced, never added to;
// nothing else in the body moves.
function applyRecord(body, record, opts) {
  let text = String(body || '').replace(/\r\n?/g, '\n');
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  const twice = (marker) => text.indexOf(marker) !== text.lastIndexOf(marker);
  if ((s === -1) !== (e === -1) || e < s || twice(START) || twice(END)) {
    throw new Refusal('the PR body has a broken control-record block: the start and end markers must be there once each, start first. Put back the block the cut wrote, or cut again');
  }
  text = fill(text, TOP_START, TOP_END, record.top);
  text = fill(text, WHERE_START, WHERE_END, whereTable(record));
  text = fill(text, START, END, renderRecord(record, opts), { keep: false });
  return text;
}

module.exports = {
  RESULTS_FORMAT, START, END, REPORT_FILES, readReportText, readResults, buildRecord, renderRecord, approverLine, applyRecord, tagOf, isFleet, lastReviews, clean, workflowRunOf,
};
