'use strict';

// The release PR's decision table and Evidence fold: what was tested, who asked for, made and reviewed each change,
// who approved the release, and that the build tested is the build that ships. Pure: no network, no files, no git.
// `record-command.js` reads GitHub and the checkout and hands the answers in. The recommendation is HOLD (the page
// says "❌ No: do not approve") when any test, staging step or check did not pass, or the build tested is not the
// build that ships. A change no one else reviewed is never a HOLD: the fix is an approval of the release PR, which is
// the approvers' to give, and the page asks for it only where the repo's askSecondApprover is on.

const { clean, hasSecret } = require('./clean');
const {
  TOP_START, TOP_END, PUBLISHED_START, PUBLISHED_END, MERGE_START, MERGE_END, withAnnounce, hasNotes, renderTop, published, oneLine, andList, cap, sentence, cell,
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
// (event `dynamic`), scheduled runs, and runs another workflow's run started (event `workflow_run`: a caller's
// `ask.yml` runs on one, on the default branch's tip, which is often the release's source commit). Every other event (push, pull_request, the record's own
// workflow_dispatch, and the rest) is judged. GitHub starts other things as `dynamic` runs too, CodeQL's
// default setup among them (path `dynamic/github-code-scanning/codeql`), and that one tests the commit: a
// `dynamic` run is left out unless its workflow path names a service other than Dependabot.
const NOT_JUDGED_REASON = {
  dynamic: 'a Dependabot update job (event `dynamic`), which does not test the commit',
  schedule: 'a scheduled run (event `schedule`), which does not test the commit',
  workflow_run: 'a run another workflow\'s run started (event `workflow_run`), which does not test the commit',
};
const SUPERSEDED_REASON = 'a later attempt of the same job ran';
// A skipped job the repo does not name as a test (its `tests` in release.json): a job that runs only when something
// else happens, such as one that files an issue when the release fails. It is left out, never counted as a skipped test.
const NOT_A_TEST_REASON = 'not a test';
// The commit status the record sets on the release PR's head, from the verdict it writes into the body.
// GitHub allows 139 characters and a trailing one it cuts; the record keeps under 140.
const RELEASE_STATUS = 'shipyard/release';
const STATUS_MAX = 139;
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
 *     staging: { digest: "sha256:<64 hex>", steps: [{ name, status, url? }] },
 *     skipReasons?: { "<job name>": "<why it was skipped>" } }
 *
 * `skipReasons` is what each test job that was skipped by design says of it (its `skip-reason` output, which
 * the release job copies here): the page shows it beside the skip.
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
  const skipReasons = readSkipReasons(raw.skipReasons);
  return {
    format: RESULTS_FORMAT, build: { digest: b.digest, source: b.source }, tests, staging: { digest: s.digest, steps }, ...(skipReasons ? { skipReasons } : {}),
  };
}

// `skipReasons` of the results file: job name to one line of why it was skipped, or null when there are none. A reason
// that looks like a secret is kept as `(redacted)`, as a name is.
const SKIP_REASONS_MAX = 50;
function readSkipReasons(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new ReleaseError('results: skipReasons must be an object of job name to reason');
  const entries = Object.entries(raw);
  if (entries.length > SKIP_REASONS_MAX) throw new ReleaseError(`results: skipReasons names ${entries.length} jobs, more than ${SKIP_REASONS_MAX}`);
  const out = {};
  for (const [job, reason] of entries) {
    const name = readName(job, 'skipReasons: a job name');
    if (typeof reason !== 'string') throw new ReleaseError(`results: skipReasons of ${JSON.stringify(clean(job, 60))} must be a line of text`);
    const line = reason.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    out[name] = hasSecret(line) ? '(redacted)' : line;
  }
  return Object.keys(out).length ? out : null;
}

// ---------------------------------------------------------------------------
// The template diff and the prod plan: files a repo's own build step writes

// `report.templateDiff` and `report.prodPlan` in the repo's `.github/release.json` switch each on. The
// file is `<evidence folder>/<name>`; the record keeps it with the rest of the evidence and links it.
const REPORT_FILES = [
  { key: 'templateDiff', title: 'Template diff', word: 'template diff', name: 'template-diff.txt' },
  { key: 'prodPlan', title: 'Production plan', word: 'production plan', name: 'prod-plan.txt' },
];
// The most changes of a production plan the page names, one line each.
const PLAN_MAX_LINES = 10;
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
// The production plan's row also has `plan`, its one-line answer for the page: its first line says "No change" (or
// "No changes"), or each line after it that starts with `-` or `*` names one change; with none, the first line does.
function reportRows(entries, evidencePath) {
  return (entries || []).map(({ key, title, word, name, text }) => {
    const file = `${evidencePath}/${name}`;
    const lines = text === null || text === undefined ? [] : text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const first = lines[0] || null;
    const problem = text === null || text === undefined
      ? `the ${word} file "${clean(file, 160)}" is missing`
      : first ? null : `the ${word} file "${clean(file, 160)}" is empty`;
    const row = {
      key, title, word, plain: `the ${word}`, name, file, state: problem ? 'fail' : 'pass', problem, summary: first ? clean(first, 200) : '',
    };
    if (key === 'prodPlan' && !problem) {
      const listed = lines.slice(1).filter((l) => /^[-*]\s+\S/.test(l)).map((l) => clean(l.replace(/^[-*]\s+/, ''), 160));
      // A plan that adds, changes and destroys nothing is no change too, however its tool words it.
      const none = /^no changes?\b/i.test(first) || /^plan: 0 to add, 0 to change, 0 to destroy\b/i.test(first);
      const all = listed.length ? listed : [clean(first, 160)];
      // Past the lines the page shows, the warning says how many more there are, so the list never reads as whole.
      const shown = all.length > PLAN_MAX_LINES ? [...all.slice(0, PLAN_MAX_LINES - 1), `and ${all.length - PLAN_MAX_LINES + 1} more, in the plan file`] : all;
      // The page quotes each line word for word in a code span, where an HTML code would show as text: the raw line,
      // on one line and with no backtick to end the span (readReportText refused a file with a secret in it).
      const raw = (l) => l.replace(/^[-*]\s+/, '').replace(/[`\r\n]/g, '').replace(/\s+/g, ' ').trim().slice(0, 160);
      const words = lines.slice(1).filter((l) => /^[-*]\s+\S/.test(l)).map(raw);
      row.plan = none ? { changes: [], all: [] } : { changes: shown, all: words.length ? words : [raw(first)] };
    }
    return row;
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
    lines.push({
      pr: pr.number,
      title: clean(plainTitle(pr.title), 80),
      issues,
      review,
      author: pr.author ? String(pr.author) : null,
      drivers: [...drivers].map(loginKey).sort(),
      approvedBy: approvals.map((a) => a.login),
      changesRequestedBy: changesRequested.map((r) => r.login),
      independentBy: independent.map((a) => a.login),
    });
    if (!independent.length) {
      failing.push(pr.number);
      // The risk row names the people who drove the change: the fleet is not one of them.
      for (const d of drivers) if (!/\[bot\]$/i.test(d) && !fleetLogins.has(d)) failingDrivers.add(d);
    }
  }
  const unattributed = (facts.unattributed || []).map((u) => ({ sha: String(u.sha).slice(0, 7), subject: clean(u.subject, 80) }));
  return { lines, unattributed, failing, drivers: [...failingDrivers].sort() };
}

// A PR's title as the audit table shows it: without its conventional-commit prefix and its closing reference.
// "feat(tag): attach the files. Closes #143" is "Attach the files".
function plainTitle(title) {
  const t = String(title || '').trim()
    .replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '')
    .replace(/\s*\(#\d+\)$/, '')
    .replace(/[.\s]*\b(?:closes|fixes|resolves|refs)\s+#\d+(?:\s*,\s*#\d+)*\.?$/i, '')
    .replace(/\.$/, '');
  return cap(t || String(title || ''));
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

// The repo's approvers who did not drive the changes: a team counts, as it may hold another person.
function otherApprovers(changes, approvers) {
  const named = new Set(changes.drivers.map(loginKey));
  return approvers.map((a) => String(a).replace(/^@/, '')).filter((a) => a.includes('/') || !named.has(loginKey(a)));
}

// A person as the page names them: their GitHub profile name, else their login. `names` maps a lowercase login to
// the profile name `record-command.js` read; a bot is its login with `(bot)`.
function nameOf(login, names, fleetLogins = new Set()) {
  const key = loginKey(login);
  const bot = /\[bot\]$/i.test(String(login)) || fleetLogins.has(key);
  const shown = clean((names && names.get(key)) || String(login).replace(/\[bot\]$/i, ''), 60);
  return bot ? `${shown} (bot)` : shown;
}

// Who asked for each change, as the record reads it: its drivers but its author, people only. With none, its
// human author asked for it.
function askersOf(line, fleetLogins) {
  const human = (l) => !/\[bot\]$/i.test(l) && !fleetLogins.has(loginKey(l));
  const asked = line.drivers.filter((d) => human(d) && d !== loginKey(line.author));
  if (asked.length) return asked;
  return line.author && human(line.author) ? [loginKey(line.author)] : [];
}

// How weak an answer is, for the weaker of two answers to one test: a failure, then a skip that holds the release (a
// test run's), then a check still running, then a skip that does not hold, then a pass. A wait never hides a hold.
const weakness = (x) => (x.state === 'fail' ? 0 : x.state === 'skip' && x.holds ? 1 : x.state === 'waiting' ? 2 : x.state === 'skip' ? 3 : 4);

// The key two names of one test share: the repo's name for it (its `tests` in release.json), case not counted. A name
// the repo's list does not hold, or no list, is its own key.
const testKey = (name, tests) => String(testNameOf(name, tests) || name).toLowerCase();

// Each test of the results with its one answer, and the checks on the commit that are not one of them. A commit check
// that is the same test as a results test (the repo's name for both) is folded into it, so a test is counted once. When
// the two disagree the weaker answer stands and keeps its reason; a skip holds only if the skip that stands came from a
// results test, which holds, never a check, which does not. `answers` has one item for each of `results.tests`, in order.
function foldTests({ results, checks, tests }) {
  const answers = results ? results.tests.map((t) => (t.status === 'fail' || t.failed > 0
    ? { name: clean(t.name, 40), state: 'fail' }
    : t.status === 'skip' ? { name: clean(t.name, 40), state: 'skip', holds: true } : { name: clean(t.name, 40), state: 'pass' })) : [];
  const keys = results ? results.tests.map((t) => testKey(t.name, tests)) : [];
  const rest = [];
  for (const c of checks) {
    const at = keys.indexOf(c.key);
    if (at === -1) {
      rest.push(c);
      continue;
    }
    const mine = answers[at];
    if (weakness({ state: c.result }) < weakness(mine)) {
      answers[at] = { name: mine.name, state: c.result, ...(c.reason ? { reason: c.reason } : {}) };
    } else if (c.result === mine.state && c.reason && !mine.reason) {
      answers[at] = { ...mine, reason: c.reason };
    }
  }
  return { answers, rest };
}

// Every check the page counts: each test (a test run and the check on the commit that is the same test, once), each
// staging step, each other check on the commits and each report file, as `{ name, state: 'pass'|'fail'|'waiting'|'skip',
// holds? }`. A skipped check never passed, so it is `skip`, never `pass` (#158); a skipped test run or staging step
// holds the release (testedRow names it), a skipped check does not.
function checkItems({ results, tested, report, tests = null }) {
  const { answers, rest } = foldTests({ results, checks: tested.checks, tests });
  const items = [...answers];
  if (results) {
    for (const st of results.staging.steps) items.push(st.status === 'skip' ? { name: clean(st.name, 40), state: 'skip', holds: true } : { name: clean(st.name, 40), state: st.status === 'pass' ? 'pass' : 'fail' });
  }
  for (const c of rest) items.push({ name: c.name, state: c.result, ...(c.reason ? { reason: c.reason } : {}) });
  for (const r of report) items.push({ name: r.plain, state: r.state });
  return items;
}

// Names for a decision row, two at most, so the row stays one short line: "a, b and 2 more".
const someNames = (names) => (names.length > 2 ? `${names.slice(0, 2).join(', ')} and ${names.length - 2} more` : andList(names));

// A plan line in a code span, word for word: a backtick in it would end the span, so it is left out.
const codeSpan = (text) => `\`${String(text).replace(/`/g, '')}\``;

// The Checks row of the decision table.
function checksCell({ hold, items, results, sameBuildFails, unexplained = [] }) {
  const total = items.length;
  if (sameBuildFails) return '❌ the build tested is not the build that would go live';
  if (!results) return '❌ the test results are missing';
  const notPassed = items.filter((x) => x.state === 'fail' || (x.state === 'skip' && x.holds));
  if (hold && notPassed.length) return `❌ ${notPassed.length} of ${total} did not pass: ${someNames(notPassed.map((x) => (x.state === 'skip' ? `${x.name} (skipped)` : x.name)))}`;
  // A reason no check stands for (no test run or no staging step at all) is said in its own words.
  if (hold) return `❌ ${unexplained.length ? cap(unexplained[0]) : 'a check did not pass'}`;
  const waiting = items.filter((x) => x.state === 'waiting');
  if (waiting.length) return `⏳ ${waiting.length} of ${total} still running: ${someNames(waiting.map((x) => x.name))}`;
  if (!total) return '⏳ No checks were found';
  const skipped = items.filter((x) => x.state === 'skip');
  const passed = items.filter((x) => x.state === 'pass').length;
  // One skipped test says why, when its job gave a reason; several are named, and the Checks table gives each reason.
  if (skipped.length === 1 && skipped[0].reason) return `✅ ${passed} of ${total} passed, on the build that goes live. ${cap(skipped[0].name)} skipped: ${skipped[0].reason}`;
  if (skipped.length) return `✅ ${passed} of ${total} passed, on the build that goes live. ${cap(someNames(skipped.map((x) => x.name)))} skipped`;
  return `✅ ${total} of ${total} passed, on the build that goes live`;
}

// The Production setup row, when the repo turns the production plan on: no change, each change word for word (three
// at most), or the file missing. Never a second alert box.
function planCell(row) {
  if (row.problem) return '❌ the plan file is missing';
  const all = row.plan.all || row.plan.changes;
  if (!all.length) return '✅ No change';
  const shown = all.slice(0, 3).map(codeSpan).join(', ');
  return `⚠ ${all.length} change${all.length === 1 ? '' : 's'}: ${shown}${all.length > 3 ? ` and ${all.length - 3} more` : ''}`;
}

// What must still happen before the merge: the failed or running checks, the repo's required approval, a second
// approver only where the repo asks for one, and a person's review of a commit with no PR (their approval of the page).
function stillNeeded({ hold, waiting, approval, askSecondApprover, changes, approvers, labels, names, fleetLogins }) {
  const n = (l) => nameOf(l, names, fleetLogins);
  const parts = [];
  if (hold) parts.push('the failed check passes');
  else if (waiting) parts.push('the checks finish');
  if (!approval.current.length) parts.push('1 approval');
  if (askSecondApprover && changes.failing.length) {
    const other = otherApprovers(changes, approvers).map((a) => (a.includes('/') ? `someone in ${clean(a, 60)}` : n(a)));
    const drivers = changes.drivers.map(n);
    const who = other.length ? someNames(other) : `1 approver other than ${drivers.length ? someNames(drivers) : 'the people who asked for them'}`;
    const total = changes.lines.length;
    const what = changes.failing.length === total && total > 1
      ? `all ${total} changes`
      : someNames([...new Set(changes.failing.map((pr) => labels.get(pr) || 'an internal change'))]);
    parts.push(`${who}, who did not ask for ${what}`);
  }
  // A commit with no PR has no review to show, and nothing after the cut can add one: the approval of the release PR at
  // this head is the person's review of it, so once there is one the step is done (and `shipyard/release` agrees).
  if (!approval.current.length) for (const u of changes.unattributed) parts.push(`a person to review commit ${u.sha} by hand`);
  if (!parts.length) return '✅ Nothing';
  return `⏳ ${parts.map((p, i) => (i === 0 ? cap(p) : `Then ${p}`)).join('. ')}`;
}

// The decision table at the top of the page: its header row, the decision, in this order of precedence (do not
// approve, not yet, approve again, approved, yes), then Checks, Production setup, Approved by and Still needed.
function decisionOf({
  hold, items, results, sameBuildFails, report, approval, names, fleetLogins, askSecondApprover, changes, approvers, labels, unexplained = [],
}) {
  const n = (l) => nameOf(l, names, fleetLogins);
  const waiting = !hold && items.some((x) => x.state === 'waiting');
  const needed = stillNeeded({ hold, waiting, approval, askSecondApprover, changes, approvers, labels, names, fleetLogins });
  let header;
  if (hold) header = '❌ No: do not approve';
  else if (waiting) header = '⏳ Not yet: checks still running';
  else if (!approval.current.length && approval.stale.length) header = `🔁 Approve again: the page changed after ${andList(approval.stale.map(n))} approved`;
  else if (approval.current.length && needed === '✅ Nothing') header = '✅ Approved: ready to merge';
  else header = '✅ Yes';
  const plan = report.find((r) => r.key === 'prodPlan');
  const approved = approval.current.length ? `✅ ${andList(approval.current.map(n))}`
    : approval.stale.length ? `🔁 ${andList(approval.stale.map(n))}, on an earlier version` : '⏳ No one yet';
  const rows = [
    ['Checks', checksCell({ hold, items, results, sameBuildFails, unexplained })],
    ...(plan ? [['Production setup', planCell(plan)]] : []),
    ['Approved by', approved],
    ['Still needed', needed],
  ];
  return { header, rows };
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

// The checks of the one release run that made the candidate. A release started again on the same
// commit (refused, cancelled, or a step failed) leaves the earlier run's check runs on it, and a
// skipped job that calls a reusable workflow keeps the caller's name (`cut`, not `cut / cut`), so
// no name can match them with the later run's. They are told apart by their workflow run: every
// check run of the release run's own workflow file that belongs to another workflow run is left
// out. Check runs of other workflow files (the repo's tests, the runs the record dispatches) and of
// other apps are not the release workflow's and stay. When no check run of the release run is
// listed, there is no workflow file to match, and every run is kept.
function onlyReleaseRun(runs, releaseRun) {
  const id = String(releaseRun);
  const own = runs.find((r) => r.workflowRunId != null && String(r.workflowRunId) === id && r.workflowPath);
  if (!own) return runs;
  return runs.filter((r) => r.workflowPath !== own.workflowPath || String(r.workflowRunId) === id);
}

// The repo's name for the test a check run belongs to: the entry of its `tests` (release.json) that is the check's
// name, or the job of a reusable workflow that entry calls (`billing proof` for `billing proof / billing proof`).
// Null when the repo names no such test; with no `tests` at all, every check is its own test.
function testNameOf(name, tests) {
  if (!tests) return name;
  const key = String(name).toLowerCase();
  return tests.find((t) => key === t.toLowerCase() || key.startsWith(`${t.toLowerCase()} / `)) || null;
}

// The reason a skipped test's job gave (`skipReasons` in the results), by the repo's name for it or the check's own.
function skipReasonOf(reasons, ...names) {
  if (!reasons) return null;
  const byKey = new Map(Object.entries(reasons).map(([k, v]) => [k.toLowerCase(), v]));
  for (const n of names) if (n && byKey.has(String(n).toLowerCase())) return byKey.get(String(n).toLowerCase());
  return null;
}

// With `results` null (a record read from evidence the candidate does not hold), the row is a fail
// that says why; the checks are still read. `tests` is the repo's list of the jobs that are tests (release.json), or
// null: with it, a skipped job it does not name is left out as not a test, and a skipped test goes by the repo's name.
function testedRow({
  results, evidenceMissing = null, checkRuns, statuses, ignoreChecks, tests = null,
}) {
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
  // `key` is the check's test, by the raw names (`testKey`): the cleaned name shown on the page can differ from the results' own.
  const add = (name, result, reason = null, key = testKey(name, tests)) => {
    checks.push({ name: clean(name, 60), key, result, ...(reason ? { reason: clean(reason, 60) } : {}) });
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
    if (run.status === 'completed' && SKIPPED_CONCLUSIONS.has(run.conclusion)) {
      // A skipped job is a skipped test only when the repo names it as one; any other is left out, as not a test.
      const test = testNameOf(run.name, tests);
      if (!test) notJudgedRun(run, NOT_A_TEST_REASON);
      else add(test, 'skip', skipReasonOf(results && results.skipReasons, test, run.name), testKey(run.name, tests));
      continue;
    }
    add(run.name, run.status !== 'completed' ? 'waiting' : FAILED_CONCLUSIONS.has(run.conclusion) ? 'fail' : PASSED_CONCLUSIONS.has(run.conclusion) ? 'pass' : 'fail');
  }
  // The status API reports the same way a check run does: a state, by context.
  for (const st of resolve(statuses, (x) => x.context, () => false)) {
    // The record's own verdict is no test of the commit: judging it would make each run answer to the last.
    if (ignoreChecks.has(st.context) || st.context === RELEASE_STATUS) continue;
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
 * @param {{ repoUrl: string, cutCommit: string, changelog: string }} i.links  where the Evidence fold's Files fact points: the repo's page, the commit `shipyard cut` made, and the changelog's path
 * @param {{ sha: string, version: string|null, unread?: boolean }} [i.shipyard]  the Shipyard code that ran the record: the commit of the published workflow (the job's `job_workflow_sha`) and the release tag that names it, null when none does
 * @param {string[]} [i.approvers]  the repo's `start.approvers`: whether the independent review line names another approver
 * @param {Map<string, string>} [i.names]  each person's GitHub profile name, by lowercase login
 * @param {number} [i.prNumber]  the release PR's number, for the link to its Checks tab
 * @param {string[]|null} [i.tests]  the repo's `tests` (release.json): the jobs that are tests, so a skipped job it does not name is left out; null counts every skipped job
 * @param {{ releaseBody: string, releaseNotes: string }} [i.published]  the CHANGELOG section and the release notes at the head
 */
function buildRecord(i) {
  const fleetLogins = new Set((i.fleetLogins || []).map(loginKey));
  const ignoreChecks = new Set(i.ignoreChecks || []);
  const names = i.names || new Map();
  const changes = changesRow({
    facts: i.facts, reviewsByPr: i.reviewsByPr, driversByPr: i.driversByPr, headsByPr: i.headsByPr, releaseReviews: i.releaseReviews, head: i.head, fleetLogins,
  });
  const independent = independentRow(changes);
  const tested = testedRow({
    results: i.results, evidenceMissing: i.evidenceMissing, checkRuns: i.checkRuns, statuses: i.statuses || [], ignoreChecks, tests: i.tests || null,
  });
  const approval = approvalRow({ releaseReviews: i.releaseReviews, head: i.head, fleetLogins });
  const sameBuild = { state: i.sameBuild.ok ? 'pass' : 'fail', detail: i.sameBuild.detail };
  // A first release (lib/first-release.js) has no release tag before it: its range starts at a ref.
  const previous = { tag: i.facts.range.from, commit: i.facts.range.fromCommit, ...(i.facts.firstRelease ? { first: true } : {}) };
  const report = reportRows(i.report, i.evidence.path);
  const reasons = [
    ...tested.problems,
    ...report.filter((r) => r.problem).map((r) => r.problem),
    ...(sameBuild.state === 'fail' && i.results ? [`the build tested is not the build that ships: ${clean(sameBuild.detail, 200)}`] : []),
  ];
  const recommendation = reasons.length ? 'HOLD' : 'SHIP';
  const items = checkItems({ results: i.results, tested, report, tests: i.tests || null });
  // What the Checks table of the Evidence fold shows: each test's one answer, and the checks on the commit that are no test's.
  const folded = foldTests({ results: i.results, checks: tested.checks, tests: i.tests || null });
  // Each change's label, by PR, for the Still needed row.
  const labels = new Map();
  for (const c of i.prep.report.changes) for (const pr of c.covers) if (!labels.has(pr)) labels.set(pr, oneLine(c.label));
  const decision = decisionOf({
    hold: recommendation === 'HOLD', items, results: i.results, sameBuildFails: sameBuild.state === 'fail' && Boolean(i.results), report, approval, names, fleetLogins,
    askSecondApprover: i.facts.askSecondApprover === true, changes, approvers: i.approvers || [], labels,
    unexplained: i.results ? tested.problems.filter((x) => /^no (test results|staging steps) were recorded$/.test(x)) : [],
  });
  return {
    recommendation,
    reasons,
    decision,
    items,
    top: renderTop({
      facts: i.facts, prep: i.prep, tag: i.tag, status: { decision },
    }),
    level: { bump: i.prep.level.bump, reasons: i.prep.level.reasons.map(oneLine), ...(i.facts.firstRelease ? { first: oneLine(i.facts.firstRelease.version) } : {}) },
    askSecondApprover: i.facts.askSecondApprover === true,
    prNumber: Number.isInteger(i.prNumber) ? i.prNumber : null,
    // `{ releaseBody, releaseNotes }` as the head holds them, for the first fold; null leaves the cut's.
    published: i.published && typeof i.published.releaseBody === 'string' ? { releaseBody: i.published.releaseBody, releaseNotes: String(i.published.releaseNotes || '') } : null,
    links: i.links || null,
    shipyard: i.shipyard && /^[0-9a-f]{40}$/.test(i.shipyard.sha) ? { sha: i.shipyard.sha, version: i.shipyard.version || null, unread: i.shipyard.unread === true } : null,
    tag: i.tag,
    head: i.head,
    names,
    fleetLogins,
    approvers: i.approvers || [],
    folded,
    // Whether the repo calls announce.yml at the head (null: not read), for the Announce step of what happens on merge.
    announces: typeof i.announces === 'boolean' ? i.announces : null,
    rows: {
      changes, tested, independent, approval, sameBuild, previous, report,
    },
    results: i.results,
    evidence: i.evidence,
  };
}

// The checks file kept with the evidence (`checks.json`): every test run and staging step of the results, which the
// audit record counts and links. The check runs change after the evidence is committed (the record waits for them),
// so the Evidence fold's Checks table counts them at each pass instead, with the runs it left out.
const CHECKS_FORMAT = 1;
function checksFile({ tag, results }) {
  return {
    format: CHECKS_FORMAT,
    tag,
    build: results ? results.build : null,
    tests: results ? results.tests : [],
    staging: results ? results.staging.steps : [],
  };
}

// ---------------------------------------------------------------------------
// The status

// A status description is plain text: the entities `clean` wrote for a table cell are turned back, and a backtick,
// which only marks code in the body, is left out.
const UNCLEANED = new Map([...'\\|`<>[]*_~#&'].map((c) => [`&#${c.charCodeAt(0)};`, c]));
const oneLineStatus = (text) => {
  const flat = String(text).replace(/&#\d+;/g, (m) => UNCLEANED.get(m) || m).replace(/`/g, '').replace(/\s+/g, ' ').trim();
  return flat.length > STATUS_MAX ? `${flat.slice(0, STATUS_MAX - 1).trimEnd()}…` : flat;
};

/**
 * The verdict as the commit status `shipyard/release` shows it, from the same record the body shows:
 *   failure  HOLD, the description names the first reason;
 *   pending  SHIP, but a step is still open: a check still running, a second approver (only where the repo's
 *            `askSecondApprover` is on, as the page's Still needed row asks for one), or a commit with no pull
 *            request, which a person must review by hand and then approve;
 *   success  SHIP, and nothing is left but the approval the base branch's rules already require.
 * The description is one line under 140 characters.
 */
function releaseStatus(record) {
  const { rows } = record;
  if (record.recommendation === 'HOLD') {
    return { state: 'failure', description: oneLineStatus(`HOLD: ${record.reasons[0]}`) };
  }
  const open = (why) => ({ state: 'pending', description: oneLineStatus(`SHIP, but a step is open: ${why}`) });
  if (rows.tested.waiting.length) return open(rows.tested.waiting[0]);
  if (record.askSecondApprover && rows.changes.failing.length) {
    return open(`a second approver is needed, #${rows.changes.failing[0]} has no approval from a person who did not drive it`);
  }
  // A commit with no PR has no review to show, and the cut's facts never change, so nothing but a person could clear it: their
  // approval of the release PR at this head is the review (without it the status would stay pending for good).
  if (rows.changes.unattributed.length && rows.approval.state !== 'pass') {
    return open(`a person must review commit ${rows.changes.unattributed[0].sha} by hand, as it has no pull request, and approve`);
  }
  return {
    state: 'success',
    description: oneLineStatus(rows.approval.state === 'pass'
      ? `SHIP: approved at ${record.head.slice(0, 7)}, nothing else is open`
      : 'SHIP: only the approval the base branch requires is left'),
  };
}

// ---------------------------------------------------------------------------
// The text

const list = (items) => items.map((x) => `- ${x}`).join('\n');

// A path in a link: each part encoded, and the brackets a link ends at as well.
const urlPath = (p) => p.split('/').map((part) => encodeURIComponent(part).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

// A file of the evidence as a link at the commit the record is written for, so it works once the release branch is
// gone; a file the run did not commit (`--no-commit`) is named, not linked.
function evidenceLink(record, name, label = name) {
  const l = record.links;
  const file = `${record.evidence.path}/${name}`;
  if (!l || !record.evidence.files.includes(name)) return `\`${file}\` (not committed)`;
  return `[${clean(label, 100)}](${l.repoUrl}/blob/${record.head}/${urlPath(file)})`;
}

const ICON = {
  pass: '✅', fail: '❌', waiting: '⏳', skip: '⏭',
};
// Why a check that never ran is shown as skipped: GitHub gives no reason, and a skip is never a pass.
const SKIP_REASON = 'it did not run, so it never passed';

// The runs left out, counted by reason in plain words: "2 scheduled, 1 Dependabot, 2 that are not tests". No run's name,
// no event word and no code span; a reason with no words of its own here is said in its own. Scheduled runs first, then
// Dependabot's, then the jobs that are not tests (a run another workflow's run started is one), then the rest in the order they came.
function leftOutCounts(notJudged) {
  const kinds = [
    [NOT_JUDGED_REASON.schedule, () => 'scheduled'],
    [NOT_JUDGED_REASON.dynamic, () => 'Dependabot'],
    [NOT_A_TEST_REASON, (n) => `that ${n === 1 ? 'is' : 'are'} not ${n === 1 ? 'a test' : 'tests'}`],
    [SUPERSEDED_REASON, () => 'replaced by a later attempt'],
  ];
  const counts = new Map();
  // A run another workflow's run started is counted with the jobs that are not tests: a reader needs no event word.
  for (const x of notJudged) {
    const reason = x.reason === NOT_JUDGED_REASON.workflow_run ? NOT_A_TEST_REASON : x.reason;
    counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  const known = kinds.filter(([reason]) => counts.has(reason));
  const parts = known.map(([reason, words]) => `${counts.get(reason)} ${words(counts.get(reason))}`);
  for (const [reason, n] of counts) if (!kinds.some(([r]) => r === reason)) parts.push(`${n} ${oneLine(reason).replace(/`/g, '')}`);
  return parts.join(', ');
}

// The Checks table of the Evidence fold: a row for each test, with its one answer, and one for the staging steps, a row for the other checks on
// the commit (named only when they failed, wait or were skipped), a row for the report files and one for the runs left
// out. Never a paragraph.
function checksTable(record) {
  const r = record.results;
  const rows = [];
  const link = (url, label = 'log') => (url ? `[${label}](${url})` : '');
  if (r) {
    // Each test has one answer: the results' own, or the weaker one of the check on the commit that is the same test.
    r.tests.forEach((t, at) => {
      const item = record.folded.answers[at];
      const failed = t.status === 'fail' || t.failed > 0;
      const counts = ['passed', 'failed', 'skipped'].filter((k) => t[k] !== undefined && (k !== 'skipped' || t[k] > 0)).map((k) => `${t[k]} ${k}`).join(', ');
      let result;
      if (item.state === 'skip') result = `⏭ skipped: ${item.reason || SKIP_REASON}`;
      else if (item.state === 'waiting') result = '⏳ still running';
      else if (item.state === 'fail' && !failed) result = `❌ did not pass${item.reason ? `: ${item.reason}` : ''}`;
      else result = `${failed ? '❌' : '✅'} ${counts || (failed ? 'failed' : 'passed')}`;
      rows.push([`Test: ${clean(t.name, 60)}`, result, link(t.url)]);
    });
    const steps = r.staging.steps;
    if (steps.length) {
      const passed = steps.filter((x) => x.status === 'pass').length;
      const bad = steps.filter((x) => x.status !== 'pass');
      const result = bad.length
        ? `${bad.some((x) => x.status === 'fail') ? '❌' : '⏭'} ${passed} of ${steps.length} passed: ${bad.map((x) => `${clean(x.name, 40)} ${x.status === 'skip' ? 'skipped' : 'failed'}`).join(', ')}`
        : `✅ ${steps.length} of ${steps.length} passed`;
      const url = (steps.find((x) => x.url) || {}).url;
      rows.push([`Staging: ${steps.map((x) => clean(x.name, 40)).join(', ')}`, result, link(url)]);
    }
  } else {
    rows.push(['Test results', `❌ ${cap(record.rows.tested.problems[0] || 'no test results were recorded')}`, '']);
  }
  const { notJudged } = record.rows.tested;
  // The checks on the commit that are not a test above: a test is shown once, with its one answer.
  const onCommit = record.folded.rest;
  const checksTab = record.links && record.prNumber ? `[Checks tab](${record.links.repoUrl}/pull/${record.prNumber}/checks)` : '';
  if (onCommit.length) {
    const passed = onCommit.filter((c) => c.result === 'pass').length;
    const named = ['fail', 'waiting', 'skip'].flatMap((state) => onCommit.filter((c) => c.result === state).map((c) => `${c.name} ${{ fail: 'did not pass', waiting: 'still running', skip: 'skipped' }[state]}${c.reason ? `: ${c.reason}` : ''}`));
    const icon = onCommit.some((c) => c.result === 'fail') ? '❌' : onCommit.some((c) => c.result === 'waiting') ? '⏳' : '✅';
    rows.push(['Checks on this commit', `${icon} ${passed} of ${onCommit.length} passed${named.length ? `: ${named.join(', ')}` : ''}`, checksTab]);
  } else {
    rows.push(['Checks on this commit', 'none were found', checksTab]);
  }
  if (record.rows.report.length) {
    const what = record.rows.report.map((x) => x.word).join(' and ');
    const bad = record.rows.report.filter((x) => x.problem);
    const result = bad.length ? `❌ ${bad.map((x) => x.problem).join('; ')}` : `✅ ${record.rows.report.length === 1 ? 'written' : 'both written'}`;
    rows.push([cap(what), result, record.rows.report.filter((x) => !x.problem).map((x) => evidenceLink(record, x.name)).join(' · ')]);
  }
  if (notJudged.length) {
    rows.push(['Left out', `${notJudged.length} run${notJudged.length === 1 ? ' that does' : 's that do'} not test this commit: ${leftOutCounts(notJudged)}`, record.evidence.files.includes('checks.json') ? evidenceLink(record, 'checks.json') : '']);
  } else if (record.evidence.files.includes('checks.json')) {
    rows.push(['Each test run and staging step', 'kept with the evidence', evidenceLink(record, 'checks.json')]);
  }
  // testedRow cleaned each name and result; the reasons are the record's own text.
  return ['| What | Result | Proof |', '|:--|:--|:--|', ...rows.map(([w, res, proof]) => `| ${cell(w)} | ${cell(res)} | ${proof} |`)].join('\n');
}

// The Evidence fold, which proves what the top states and never says it again: the read-at line, then a table of
// each change, the Checks table, a This release table of facts, and (written by the cut, after this block) what
// happens on merge. No fold inside. The full build digest is kept in a marker for the tag step's "Shipped" comment.
function renderRecord(record, { recordedAt } = {}) {
  const { rows, names, fleetLogins } = record;
  const { changes } = rows;
  const n = (l) => nameOf(l, names, fleetLogins);
  const sha7 = (sha) => `\`${String(sha).slice(0, 7)}\``;
  const reviewedBy = (line) => {
    if (line.changesRequestedBy.length) return `${andList(line.changesRequestedBy.map(n))} asked for changes`;
    if (!line.independentBy.length) return 'no one else';
    return andList(line.independentBy.map(n));
  };
  const each = [
    '| PR | Issue | Asked for by | Made by | Reviewed by |',
    '|:--|:--|:--|:--|:--|',
    ...changes.lines.map((l) => {
      const askers = askersOf(l, fleetLogins);
      return `| #${l.pr} | ${l.issues} | ${askers.length ? cell(andList(askers.map(n))) : 'no one named'} | ${l.author ? cell(n(l.author)) : 'not known'} | ${cell(reviewedBy(l))} |`;
    }),
    ...changes.unattributed.map((u) => `| commit \`${u.sha}\` | none | no one named | not known | no pull request: review it by hand |`),
  ].join('\n');

  const r = record.results;
  const facts = [];
  facts.push(['Same build', rows.sameBuild.state === 'pass' && r
    ? `Tests and staging ran on one build, \`${r.build.digest.slice(0, 19)}\`, made from ${sha7(r.build.source)}. Since then only the release notes, changelog and evidence changed`
    : `No. ${clean(rows.sameBuild.detail, 300)}`]);
  facts.push(['Version', record.level.first
    ? `First release, ${record.level.first}, set by firstRelease in .github/release.json. The prep run's level, ${record.level.bump}, moves nothing`
    : `${cap(record.level.bump)}: ${record.level.reasons[0]}`]);
  const p = rows.previous;
  facts.push(['Last release', p.first ? `None: this is the repo's first release, and its range starts at \`${clean(p.tag, 80)}\` (${sha7(p.commit)})` : `\`${clean(p.tag, 80)}\`, at ${sha7(p.commit)}`]);
  if (!record.askSecondApprover && changes.failing.length) {
    const drivers = changes.drivers.map(n);
    facts.push(['Second approver', `Not asked for in this repo. No one other than ${drivers.length ? andList(drivers) : 'the people who made them'} reviewed ${changes.failing.length === changes.lines.length ? 'these changes' : `${changes.failing.length} of these changes`}`]);
  }
  for (const x of rows.report) {
    if (x.key === 'prodPlan') facts.push(['Production plan', "Deploy production reads its plan from this PR's plan commit, never from this page. A plan commit pushed after an approval makes the page ask for the approval again"]);
    // A missing file is the Checks table's to say, once.
    if (x.key === 'templateDiff' && !x.problem) facts.push(['Template diff', x.summary]);
  }
  // The code that made this record. Callers call Shipyard at `@v0`, which moves with each release, so the
  // commit and the release it is are what say which code it was.
  if (record.shipyard) {
    const { sha, version, unread } = record.shipyard;
    // A tag list that could not be read is said so: it does not say no tag names the commit.
    facts.push(['Shipyard', version ? `${clean(version, 40)} (${sha.slice(0, 7)})` : `${sha.slice(0, 7)} (${unread ? 'release tag not read' : 'no release tag names it'})`]);
  }
  const l = record.links;
  const at = (sha, kind, path, label = path) => (l ? `[${clean(label, 100)}](${l.repoUrl}/${kind}/${sha}/${urlPath(path)})` : `\`${path}\``);
  const evidence = record.evidence.files.length ? `${at(record.head, 'tree', record.evidence.path, 'evidence folder')} at ${sha7(record.head)}` : 'no evidence was committed';
  facts.push(['Files', l
    ? `${evidence} · ${at(l.cutCommit, 'blob', l.changelog, 'CHANGELOG.md')}, ${at(l.cutCommit, 'blob', `releases/${record.tag}/facts.json`, 'facts.json')} and ${at(l.cutCommit, 'blob', `releases/${record.tag}/prep.json`, 'prep.json')} at the cut commit ${sha7(l.cutCommit)}`
    : evidence]);
  const factTable = ['| Fact | Value |', '|:--|:--|', ...facts.map(([k, v]) => `| ${k} | ${v.replace(/\n/g, ' ').replace(/(?<!\\)\|/g, '\\|')} |`)].join('\n');

  return [
    START,
    ...(r ? [`<!-- shipyard:build ${r.build.digest} -->`] : []),
    `Read from GitHub${recordedAt ? ` at ${recordedAt.replace(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}).*$/, '$1 $2 UTC')}` : ''}, for commit ${sha7(record.head)}. Run \`shipyard record\` again after a review or a check changes.`,
    '',
    '#### Each change',
    '',
    each,
    '',
    '#### Checks',
    '',
    checksTable(record),
    '',
    '#### This release',
    '',
    factTable,
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

// The new body: the top, and the audit record, each in the place the cut left for it. A record already there is
// replaced, never added to; nothing else in the body moves.
function applyRecord(body, record, opts) {
  let text = String(body || '').replace(/\r\n?/g, '\n');
  const s = text.indexOf(START);
  const e = text.indexOf(END);
  const twice = (marker) => text.indexOf(marker) !== text.lastIndexOf(marker);
  if ((s === -1) !== (e === -1) || e < s || twice(START) || twice(END)) {
    throw new Refusal('the PR body has a broken audit-record block: the start and end markers must be there once each, start first. Put back the block the cut wrote, or cut again');
  }
  text = fill(text, TOP_START, TOP_END, record.top);
  // What gets published, as the head holds it: a CHANGELOG section or release notes edited after the cut show here.
  if (record.published) text = fill(text, PUBLISHED_START, PUBLISHED_END, published({ tag: record.tag, ...record.published }));
  // What happens on merge: its Announce step, as the head's workflows and release notes say. A body cut before this block
  // existed has none, and a record that read neither the workflows nor the notes has nothing to say: both are left as they are.
  const m = [text.indexOf(MERGE_START), text.indexOf(MERGE_END)];
  const oneBlock = m[0] !== -1 && m[1] > m[0] && m[0] === text.lastIndexOf(MERGE_START) && m[1] === text.lastIndexOf(MERGE_END);
  if (oneBlock && record.announces !== null && record.published) {
    const block = text.slice(m[0] + MERGE_START.length, m[1]).replace(/^\n|\n$/g, '');
    const announce = record.announces ? { notes: hasNotes(record.published.releaseNotes) } : null;
    text = fill(text, MERGE_START, MERGE_END, withAnnounce(block, announce));
  }
  text = fill(text, START, END, renderRecord(record, opts), { keep: false });
  return text;
}

// ---------------------------------------------------------------------------
// The notes for the release manager: a comment on the release PR, never part of its body

const notesMarker = (tag) => `<!-- shipyard:manager-notes ${tag} -->`;

// The comment's text, or null when the prep file has no notes.
function managerNotesComment(tag, notes) {
  const items = (notes || []).map((x) => `- ${oneLine(x)}`);
  if (!items.length) return null;
  return [notesMarker(tag), '**Notes for the release manager**', '', ...items, ''].join('\n');
}

module.exports = {
  RESULTS_FORMAT, START, END, RELEASE_STATUS, releaseStatus, REPORT_FILES, CHECKS_FORMAT, readReportText, readResults, buildRecord, renderRecord, decisionOf, applyRecord, tagOf, isFleet, lastReviews,
  clean, workflowRunOf, onlyReleaseRun, checksFile, managerNotesComment, notesMarker, plainTitle, nameOf, changesRow, approvalRow, hasSecret,
};
