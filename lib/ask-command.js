'use strict';

// `shipyard ask (--pr <number> | --head-branch <release/X.Y.Z> | --all)`: once a release PR's control record, with the
// release run's results, is in, post the ask in the area's Slack channel, tagging the area's approvers (the logins and Slack
// user ids of the `SHIPYARD_APPROVERS` variable) and, where the repo asks for a second approver
// (`askSecondApprover`), leaving out anyone who drove every change that still needs an independent
// approval. The ask never asks twice, and nothing follows it: no reminder.
// The release's facts and prep file are the
// ones `shipyard cut` put in the release PR's body (lib/release-data.js; for a release cut before that, in
// `releases/<tag>/` at the PR's head); the repo is `GITHUB_REPOSITORY`. `--head-branch` names the release
// PR by its branch (a record run dispatched by hand names no PR, or one that has nothing to do with the release, but its
// head branch is the release's): the open PR of this repo from that branch, or nothing to ask. `--all` looks at every open
// release PR of the repo, each on its own. Exit 0 when it asked or had nothing to do; 1 when refused
// (the PR is not ready to be asked about: no record yet, or still a draft); 2 when it could not run. A missing or unusable approver
// list is exit 2, naming the variable: nothing is posted, and nothing falls back to "any person's
// approval".

const { createClient, GitHubError } = require('./github');
const { createSlackClient, SlackError } = require('./slack');
const { LintError, checkFacts } = require('./lint-prep');
const { checkRange } = require('./cut');
const { assertPrepPasses, productOf } = require('./changelog');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions } = require('./release-args');
const { loadReaderConfig, settingsOf } = require('./reader-config');
const { changesRow, approvalRow, tagOf } = require('./record');
const { isLight, lightPrepFor } = require('./light');
const { readReleaseInputs, commitsFromGitHub } = require('./release-data');
const { currentOf } = require('./shipyard-version');
const { checkReleasePr, readRecord } = require('./release-pr');
const { driversOf } = require('./drivers');
const { escapeData } = require('./changelog-line-command');
const { releaseApproval } = require('./release-approval');
const {
  LOGIN, MAX_TAGGED, askPost, parseState, stateComment, drovesEvery,
} = require('./ask');

const USAGE = 'usage: shipyard ask (--pr <number> | --head-branch <release/X.Y.Z> | --all) [--channel <channel>] [--tag <login,login>] [--note-author <login,login>] [--armed-label <label>] [--fleet-logins <a,b>] [--area <release_area>] [--default-branch <name>]';
const FLAGS = {
  '--pr': 'pr', '--head-branch': 'headBranch', '--channel': 'channel', '--tag': 'tag',
  '--note-author': 'noteAuthor', '--armed-label': 'armedLabel', '--fleet-logins': 'fleetLogins',
  '--area': 'area', '--default-branch': 'defaultBranch',
};
const SWITCHES = { '--all': 'all' };
const RELEASE_BRANCH = /^release\/(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;
const TAG = /^[A-Za-z0-9._-]+$/;
const RELEASE_JSON = '.github/release.json';
const SLACK_USER = /^[UW][A-Z0-9]{2,19}$/;
const AUTHOR = /^[A-Za-z0-9][A-Za-z0-9-]*(?:\[bot\])?$/;
const CHANNEL = /^(?:[CG][A-Z0-9]{6,20}|#?[a-z0-9][a-z0-9._-]{0,79})$/;

const list = (text) => String(text || '').split(',').map((s) => s.trim()).filter(Boolean);
const iso = (date) => date.toISOString().replace(/\.\d+Z$/, 'Z');

// ---------------------------------------------------------------------------
// The repo's settings

// `ask.channel`, `people.tag` and `askSecondApprover` of the repo's config, read at the PR's base branch: a release PR
// cannot change who it asks. The file is `.github/shipyard.yml`, else `.github/release.json` (lib/reader-config.js).
// `askSecondApprover` is the record's own setting (off by default): only where it is on does a change need an approval
// from a person who did not drive it. The one exception is a repo's first release, which is the release that brings the
// file to the base: with no file on the base at all, it is read from the release PR's head commit (`headSha`, a PR the
// caller has already checked is the release PR `shipyard cut` opened, from a release branch of this repo). A file on the
// base always wins. On shipyard.yml the settings are resolved too (`--area`, `--default-branch`), so the file's own
// warnings are printed and a bad page or area fails as it does for the record; the approvers stay `SHIPYARD_APPROVERS`.
async function loadAt({ github, repo, ref, warn }) {
  try {
    return await loadReaderConfig({ github, repo, ref }, { warn });
  } catch (e) {
    // A release.json that is not JSON, in the words this command has always used for it.
    if (e instanceof ReleaseError && /^\.github\/release\.json is not valid JSON/.test(e.message)) throw new ReleaseError(`${RELEASE_JSON} of ${repo} is not valid JSON`);
    throw e;
  }
}

async function readConfig({
  github, repo, baseRef, headSha, opts = {}, warn = () => {},
}) {
  let loaded = await loadAt({ github, repo, ref: baseRef, warn });
  if (loaded.file === null && headSha) loaded = await loadAt({ github, repo, ref: headSha, warn });
  const file = loaded.file || RELEASE_JSON;
  // Resolved only for shipyard.yml (null otherwise, and GitHub is asked nothing); its warnings go to `warn`.
  await settingsOf(loaded, {
    repo, area: opts.area, defaultBranch: opts.defaultBranch, github, warn,
  });
  const json = loaded.config;
  const ask = json.ask !== undefined ? json.ask : {};
  const people = json.people !== undefined ? json.people : {};
  if (!ask || typeof ask !== 'object' || Array.isArray(ask)) throw new ReleaseError(`${file}: ask must be an object`);
  if (!people || typeof people !== 'object' || Array.isArray(people)) throw new ReleaseError(`${file}: people must be an object`);
  if (ask.channel !== undefined && (typeof ask.channel !== 'string' || !CHANNEL.test(ask.channel))) throw new ReleaseError(`${file}: ask.channel must be a Slack channel id or name`);
  if (people.tag !== undefined && (!Array.isArray(people.tag) || !people.tag.length || people.tag.some((l) => typeof l !== 'string' || !LOGIN.test(l)))) {
    throw new ReleaseError(`${file}: people.tag must be a list of GitHub logins`);
  }
  if (json.askSecondApprover !== undefined && typeof json.askSecondApprover !== 'boolean') {
    throw new ReleaseError(`${file}: askSecondApprover must be true or false`);
  }
  return {
    config: { channel: ask.channel || null, tag: people.tag || null, askSecondApprover: json.askSecondApprover === true },
    file,
  };
}

// ---------------------------------------------------------------------------
// What the release was cut from

// `shipyard cut` puts the facts and the prep file in the release PR's body (lib/release-data.js), pinned by the
// cut commit's `Release-Data` trailer; a release cut before that has them in `releases/<tag>/` on the release
// branch. Both are read at the PR's head commit, so a push between the reads cannot mix two heads, and only after
// the body's tag has matched a plain name. Everything read is checked again below, as when `shipyard record`
// reads it: the facts must be of this repo, and the PR must be the one they make. A body that does not match its
// cut commit is refused, and nothing is asked, as is a release cut two or more minor versions before `current`.
async function readInputs({
  github, repo, prNumber, current = null,
}) {
  const pr = await github.getPull(repo, prNumber);
  const tag = tagOf(pr.body);
  if (!tag || !TAG.test(tag) || tag.includes('..')) throw new Refusal(`#${prNumber} is not a release PR \`shipyard cut\` opened: its body names no release tag`);
  const head = pr.head && pr.head.sha;
  if (!/^[0-9a-f]{40}$/.test(String(head))) throw new ReleaseError(`#${prNumber} names no head commit`);
  // The ask has no use for the notes, so a folder's are not read.
  const readFolderFile = async (name) => (name === 'release-notes.md' ? null : github.getFileText(repo, `releases/${tag}/${name}`, head));
  let inputs;
  try {
    inputs = await readReleaseInputs({
      body: pr.body, tag, headSha: head, getCommit: commitsFromGitHub(github, repo), prNumber, readFolderFile, current,
    });
  } catch (e) {
    // A file of the folder that is not JSON, in the words this command has always used for it.
    const bad = !(e instanceof Refusal) && e instanceof ReleaseError ? /^releases\/[^/]+\/(facts|prep)\.json is not valid JSON$/.exec(e.message) : null;
    if (bad) throw new ReleaseError(`the ${bad[1] === 'facts' ? 'facts' : 'prep file'} at releases/${tag}/${bad[1]}.json on #${prNumber} is not valid JSON`);
    throw e;
  }
  const missing = (name, what) => new Refusal(`#${prNumber} has no ${inputs.source === 'body' ? `${what} in its release data` : `releases/${tag}/${name} at ${head.slice(0, 7)}`}: only a release \`shipyard cut\` made is asked about`);
  if (inputs.facts === null) throw missing('facts.json', 'facts');
  const { facts } = inputs;
  // A light release (lib/light.js) has no prep file: its headline, "<n> changes", is made from the facts.
  if (!isLight(facts) && inputs.prep === null) throw missing('prep.json', 'prep file');
  const prep = isLight(facts) ? lightPrepFor(facts) : inputs.prep;
  checkFacts(facts);
  const fromTag = checkRange(facts);
  // A release cut before names were required has none: only the cut asks for them, as the record and a re-ship read it.
  if (!isLight(facts)) assertPrepPasses(facts, prep, { names: false });
  if (String(facts.repo.name).toLowerCase() !== repo.toLowerCase()) {
    throw new Refusal(`the facts on #${prNumber} are for ${facts.repo.name}, not ${repo}: nothing is asked`);
  }
  return { pr, facts, prep, fromTag, source: inputs.source };
}

// ---------------------------------------------------------------------------
// The note a release PR keeps

// The notes this job wrote: by the login the token belongs to (a personal access token), or by a login
// `--note-author` names (the Actions bot, which `GET /user` cannot tell). A comment by anyone else, a
// bot included, never counts: anyone who can comment could otherwise stop the ask.
async function readNotes({ github, u, authors }) {
  const own = await github.viewerLogin();
  const trusted = new Set([...(own ? [own] : []), ...authors].map((l) => l.toLowerCase()));
  if (!trusted.size) throw new ReleaseError('cannot tell which comments are this job\'s own notes: the token has no login, so pass --note-author <the login its comments carry>');
  const found = [];
  for (const c of await github.listIssueComments(u.repo, u.prNumber)) {
    if (!c || !c.user || !trusted.has(String(c.user.login).toLowerCase())) continue;
    const state = parseState(c.body);
    if (state) found.push({ id: c.id, state });
  }
  found.sort((a, b) => Date.parse(a.state.sentAt) - Date.parse(b.state.sentAt));
  return found;
}

// ---------------------------------------------------------------------------
// Who to tag

// The approver list: `SHIPYARD_APPROVERS`, a JSON object of GitHub login to Slack user id (the
// `slack` environment holds it, set from the area's approver team). Slack ids are not secrets, but
// they name people, so they are never printed. Returns `Map<lowercase login, { login, id }>`. A list
// that is missing, empty, not valid JSON, not an object or with no usable entry is a ReleaseError
// naming the variable (exit 2): nothing is posted, and nothing falls back to "any person's approval".
// The ask is its own workflow, so a failure here never blocks the release. An entry that is not a
// login with a Slack id is skipped with a warning, never echoed.
function readApprovers(text, warn) {
  const name = 'SHIPYARD_APPROVERS';
  if (text === undefined || text === null || !String(text).trim()) {
    throw new ReleaseError(`${name} is not set: set it in the slack environment, as a JSON object of GitHub login to Slack user id`);
  }
  let json;
  try {
    json = JSON.parse(String(text));
  } catch {
    throw new ReleaseError(`${name} is not valid JSON: it must be an object of GitHub login to Slack user id`);
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new ReleaseError(`${name} must be a JSON object of GitHub login to Slack user id`);
  }
  const list = new Map();
  for (const [login, id] of Object.entries(json)) {
    if (!LOGIN.test(login) || typeof id !== 'string' || !SLACK_USER.test(id)) {
      warn(`${name}: the entry for ${JSON.stringify(login.slice(0, 40))} is not a GitHub login with a Slack user id, so it is not used`);
      continue;
    }
    list.set(login.toLowerCase(), { login, id });
  }
  if (!list.size) throw new ReleaseError(`${name} lists no approver: it needs at least one GitHub login with a Slack user id`);
  if (list.size > MAX_TAGGED) throw new ReleaseError(`${name} lists ${list.size} approvers: at most ${MAX_TAGGED} are kept`);
  return list;
}

// The release's changes that still need an independent approval, each with the people who drove it.
// A commit with no PR needs one too, and nobody drove it. Read once per run, and only when needed.
// A repo that does not ask for a second approver (`askSecondApprover` off, the default) has none: no
// change needs one, so nothing is read for them, as the record's page asks for none.
async function loadChanges({ github, u, fleetLogins, armedLabel }) {
  if (!u.config.askSecondApprover) return [];
  if (u.needing) return u.needing;
  const reviewsByPr = new Map();
  const driversByPr = new Map();
  const headsByPr = new Map();
  for (const change of u.facts.prs) {
    // As `shipyard record` reads each change: its reviews, the last head it had before it merged
    // (an approval counts only of that), and the issues GitHub links to it (their authors drove it).
    const [reviews, merged, linked] = await Promise.all([
      github.listPullReviews(u.repo, change.number),
      github.getPull(u.repo, change.number),
      github.listClosingIssues(u.repo, change.number),
    ]);
    reviewsByPr.set(change.number, reviews);
    headsByPr.set(change.number, merged.head && /^[0-9a-f]{40}$/.test(String(merged.head.sha)) ? merged.head.sha : null);
    driversByPr.set(change.number, await driversOf({ github, repo: u.repo, pr: change, issues: [...linked, ...(change.issues || [])], armedLabel }));
  }
  // The release PR's own approvals are not passed: they are what `releaseApproval` weighs next.
  const changes = changesRow({ facts: u.facts, reviewsByPr, driversByPr, headsByPr, fleetLogins });
  u.needing = [
    ...changes.failing.map((n) => ({ ref: `#${n}`, drivers: driversByPr.get(n) || new Set() })),
    ...changes.unattributed.map((c) => ({ ref: `commit ${c.sha}`, drivers: new Set() })),
  ];
  return u.needing;
}

// A person as the page names them: their GitHub profile name, else their login. A name that cannot be read is
// the login: the ask is a courtesy, and never stops for a name.
async function nameOf(github, login) {
  try {
    return (await github.getUserName(login)) || login;
  } catch {
    return login;
  }
}

// Who to tag: the approver list, narrowed to `people.tag` where the repo names it, less (where the repo asks for a
// second approver) anyone who drove every change that still needs an independent approval. A login that is named (by `people.tag`)
// or approved the release PR but has no entry is named in plain text, with no mention: it is `untagged`.
async function resolveApprovers({ github, u, approvers, tagOverride, fleetLogins, armedLabel, unlisted, warn }) {
  const candidates = new Map(); // lowercase login -> { login, id }
  const untagged = new Map(); // lowercase login -> login
  const wanted = tagOverride || u.config.tag;
  if (!wanted) {
    for (const [key, entry] of approvers) candidates.set(key, entry);
  } else {
    for (const login of wanted) {
      const entry = approvers.get(login.toLowerCase());
      if (entry) candidates.set(login.toLowerCase(), entry);
      else {
        untagged.set(login.toLowerCase(), login);
        warn(`${login} has no entry in SHIPYARD_APPROVERS, so is named and not tagged`);
      }
    }
  }
  for (const login of unlisted) {
    if (!untagged.has(login.toLowerCase())) {
      untagged.set(login.toLowerCase(), login);
      warn(`${login} approved the release PR but has no entry in SHIPYARD_APPROVERS, so is named and not tagged`);
    }
  }

  // Where the repo asks for a second approver, everyone who drove every change that still needs an independent
  // approval is left out. A commit with no PR has no one who drove it, so nobody is left out because of it. Where it
  // does not, one approval from the approvers is enough, whoever drove the changes: nobody is left out.
  const excluded = u.config.askSecondApprover
    ? drovesEvery((await loadChanges({ github, u, fleetLogins, armedLabel })).map((c) => c.drivers))
    : new Set();

  const tagged = [];
  const leftOut = [];
  for (const [key, entry] of candidates) {
    if (excluded.has(key)) leftOut.push(entry.login);
    else tagged.push(entry);
  }
  if (!tagged.length) warn('nobody is tagged: the ask is posted with no mention');
  return { tagged, untagged: [...untagged.values()], leftOut };
}

// ---------------------------------------------------------------------------
// One release PR

// Asks about one release PR, or finds nothing to do. Returns 0, or throws a Refusal (exit 1)
// or an error (exit 2). `say` and `warn` write what the run prints.
async function askRelease({ github, getSlack, repo, prNumber, opts, approvers, tagOverride, authors, fleetLogins, now, say, warn, current = null }) {
  const { pr: found, facts, prep, fromTag, source } = await readInputs({
    github, repo, prNumber, current,
  });
  const { pr, tag } = await checkReleasePr({ github, repo, prNumber, facts, prep, fromTag, pr: found });
  if (!pr.base || typeof pr.base.ref !== 'string' || !pr.base.ref) throw new ReleaseError(`#${prNumber} names no base branch`);
  const { config, file: configFile } = await readConfig({
    github, repo, baseRef: pr.base.ref, headSha: pr.head.sha, opts, warn,
  });
  const url = typeof pr.html_url === 'string' && /^https:\/\/[^\s<>|]+$/.test(pr.html_url) ? pr.html_url : `https://github.com/${repo}/pull/${prNumber}`;
  const u = { facts, prep, repo, prNumber, pr, tag, config, url };

  const channel = opts.channel || config.channel;
  // No channel on the base is a notice, not a failure: the first release after `ask.channel` is added to a work branch
  // has none on the base yet, and an ask is a courtesy that must never turn a run red or hold a release. A channel that
  // is set but malformed was refused by readConfig above (exit 2).
  if (!channel) {
    say(`Not asked: ${pr.base.ref} has no ask.channel in ${configFile} yet.\n`);
    return 0;
  }

  const notes = await readNotes({ github, u, authors });
  const earliest = notes[0] || null;
  if (earliest && earliest.state.asked !== channel) {
    throw new Refusal(`the ask was posted in ${earliest.state.asked}, not ${channel}: nothing more is sent`);
  }
  // The ask is never sent twice, and nothing follows it. Nothing about the approvals is read for a
  // release PR already asked about.
  if (earliest) {
    say(`Already asked at ${earliest.state.sentAt}: nothing more is asked.\n`);
    return 0;
  }
  const at = now();

  // A prep file cut before `report.ask` existed has none, and the ask has no paragraph of its own to post: the headline and
  // the changes are not the manager's words for an approver, so nothing is posted until the file holds it. A release already
  // asked about (above) is never refused for it.
  if (typeof prep.report.ask !== 'string' || !prep.report.ask.trim()) {
    throw new Refusal(source === 'body'
      ? `the prep file the cut of #${prNumber} used has no report.ask, the one paragraph the ask posts: add it to the prep file (docs/prep-file.md) and cut the release again; nothing is asked`
      : `the prep file on #${prNumber} has no report.ask, the one paragraph the ask posts: add it to releases/${tag}/prep.json on the release branch (docs/prep-file.md), then run \`shipyard record --update\`; nothing is asked`);
  }

  // A release PR is a draft until its record says SHIP, then it is marked ready for review. An approval
  // cannot count on a draft, so a draft is not asked about: the record run that marks it ready asks.
  if (pr.draft === true) throw new Refusal(`#${prNumber} is a draft: a release PR is asked about once it is ready for review (its record says SHIP)`);

  // The release PR is the one `shipyard cut` opened, and its record is in, for its current commit.
  const record = readRecord(pr.body);
  if (!record) throw new Refusal(`#${prNumber} has no control record yet: run \`shipyard record --update\` first`);
  // The record has results once it holds the build marker, which it writes whenever it read the release run's results;
  // a record from before then has an evidence link instead.
  if (!record.tested && !record.evidence) throw new Refusal(`#${prNumber}'s control record has no results from the release run yet: run \`shipyard record --update\` first`);
  if (!String(pr.head.sha).startsWith(record.head)) {
    throw new Refusal(`#${prNumber}'s control record was read for ${record.head}, but the PR is at ${String(pr.head.sha).slice(0, 7)}: run \`shipyard record --update\` again`);
  }
  u.record = record;

  // A release PR without the approval it needs (lib/release-approval.js: a listed approver, at its
  // current commit, who did not drive the changes still needing one) is still to be asked about.
  const unlisted = new Set(); // logins that approved the release PR and have no entry in the list
  const reviews = await github.listPullReviews(repo, prNumber);
  // With no person's approval at the head there is nothing more to read: it waits.
  if (approvalRow({ releaseReviews: reviews, head: pr.head.sha, fleetLogins }).state === 'pass') {
    const needing = await loadChanges({ github, u, fleetLogins, armedLabel: opts.armedLabel });
    const approval = releaseApproval({
      releaseReviews: reviews, head: pr.head.sha, fleetLogins, approvers: new Set(approvers.keys()), needing,
    });
    if (approval.state === 'pass') {
      say('Nothing to ask: the release PR is approved at its current commit by an approver who did not drive its changes.\n');
      return 0;
    }
    for (const n of approval.notCounted) {
      warn(`#${prNumber}: ${n.login}'s approval does not count: ${n.why}`);
      if (n.unlisted) unlisted.add(n.login);
    }
    if (approval.by.length) warn(`#${prNumber}: the approval of ${approval.by.join(', ')} does not cover ${approval.uncovered.join(', ')}, which ${approval.by.length === 1 ? 'they' : 'they each'} drove`);
  }

  const slack = getSlack();
  const people = await resolveApprovers({ github, u, approvers, tagOverride, fleetLogins, armedLabel: opts.armedLabel, unlisted, warn });
  // The product as the page's heading names it, the release's tag, the release PR, the manager's paragraph, the checks count
  // from the record's decision table and how many PRs the page lists as merged past a reviewer's call for a person: the ask
  // holds nothing else of the page.
  const release = {
    product: productOf(facts),
    tag,
    url,
    ask: prep.report.ask,
    checks: record.checks,
    gated: record.gated,
  };
  const names = people.tagged.map((p) => p.login).join(', ') || 'nobody';

  // The note must read back, or a re-run would ask again: checked before anything is posted.
  const taggedLogins = people.tagged.map((p) => p.login);
  const probe = {
    v: 1, channel: 'C0000000000', asked: channel, ts: '1.1', sentAt: iso(at), tagged: taggedLogins,
  };
  if (!parseState(stateComment(probe))) throw new ReleaseError('the note for this ask would not read back (a login or the channel is out of shape): nothing is posted');

  const { text, blocks } = askPost({
    mentions: people.tagged.map((p) => p.id),
    release,
    // Named as the page names them, by profile name.
    leftOut: await Promise.all(people.leftOut.map((l) => nameOf(github, l))),
    untagged: await Promise.all(people.untagged.map((l) => nameOf(github, l))),
  });
  const posted = await slack.postMessage(channel, text, { blocks });
  if (!posted.ts || !posted.channel) throw new SlackError('Slack answered no message id to chat.postMessage');
  const state = {
    v: 1, channel: posted.channel, asked: channel, ts: posted.ts, sentAt: iso(at), tagged: taggedLogins,
  };
  try {
    await github.createIssueComment(repo, prNumber, stateComment(state));
  } catch (e) {
    throw new ReleaseError(`the ask was posted in Slack, but the note on ${repo}#${prNumber} could not be written (${e.message}); a re-run would ask again, so remove the Slack message or write the note by hand`);
  }
  say(`Asked in ${channel} for ${tag} (tagged: ${names}${people.leftOut.length ? `; left out: ${people.leftOut.join(', ')}` : ''}${people.untagged.length ? `; no entry in the approver list: ${people.untagged.join(', ')}` : ''}).\n`);
  return 0;
}

// ---------------------------------------------------------------------------

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  const now = io.now || (() => new Date());
  // A warning is a workflow annotation, so it shows on the run and not only in the log. The job echoes
  // this command's stderr, which Actions reads.
  const warn = (text) => err.write(`::warning title=Ask::${escapeData(`shipyard ask: ${text}`)}\n`);
  // What an error is: a refusal is exit 1, a failure the command knows is exit 2, anything else is a bug.
  const fail = (e, label) => {
    if (e instanceof Refusal) {
      err.write(`shipyard ask: ${label}refused: ${e.message}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof LintError || e instanceof GitHubError || e instanceof SlackError)) throw e;
    err.write(`shipyard ask: ${label}${e.message}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required|takes no|must))/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  };
  try {
    const opts = parseOptions(argv, FLAGS, { armedLabel: 'agent:ready' }, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-ask.md for who is tagged and when it asks.\n`);
      return 0;
    }
    if (opts.all && opts.pr !== undefined) throw new ReleaseError('--pr must not be given with --all: name one release PR, or ask about every open one');
    if (opts.headBranch !== undefined && (opts.all || opts.pr !== undefined)) throw new ReleaseError('--head-branch must not be given with --pr or --all: name the release PR one way');
    if (!opts.all && opts.pr === undefined && opts.headBranch === undefined) throw new ReleaseError('--pr is required, or --head-branch, or --all');
    if (opts.headBranch !== undefined && !RELEASE_BRANCH.test(opts.headBranch)) throw new ReleaseError('--head-branch must be a release branch, release/X.Y.Z');
    const repo = env.GITHUB_REPOSITORY;
    if (!repo || !/^[A-Za-z0-9][A-Za-z0-9-]*\/[A-Za-z0-9._-]+$/.test(repo)) throw new ReleaseError('GITHUB_REPOSITORY is required, as <owner>/<name>: the ask is about the repo the job runs in');
    if (opts.pr !== undefined && !/^[1-9][0-9]*$/.test(opts.pr)) throw new ReleaseError('--pr must be the release PR\'s number');
    if (opts.channel !== undefined && !CHANNEL.test(opts.channel)) throw new ReleaseError('--channel must be a Slack channel id or name');
    const tagOverride = opts.tag === undefined ? null : list(opts.tag);
    if (tagOverride && (!tagOverride.length || tagOverride.some((l) => !LOGIN.test(l)))) throw new ReleaseError('--tag must be a list of GitHub logins');
    const authors = list(opts.noteAuthor);
    if (authors.some((l) => !AUTHOR.test(l))) throw new ReleaseError('--note-author must be a list of GitHub logins');
    const fleetLogins = new Set(list(opts.fleetLogins).map((l) => l.toLowerCase()));

    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, graphqlUrl: env.GITHUB_GRAPHQL_URL });

    // The release PRs to look at: the one named, the open one of the branch `--head-branch` names, or every open one of this repo (a branch of its own
    // named `release/X.Y.Z`, as `shipyard cut` makes it). With none there is nothing to need a list for.
    let prNumbers;
    if (opts.all || opts.headBranch !== undefined) {
      const open = await github.listOpenPulls(repo);
      prNumbers = open
        .filter((p) => p && p.head && RELEASE_BRANCH.test(String(p.head.ref)) && p.head.repo && String(p.head.repo.full_name).toLowerCase() === repo.toLowerCase())
        .filter((p) => opts.headBranch === undefined || String(p.head.ref) === opts.headBranch)
        .map((p) => p.number)
        .sort((a, b) => a - b);
      if (!prNumbers.length) {
        out.write(opts.all ? 'No open release PR: nothing to ask.\n' : `No open release PR from ${opts.headBranch}: nothing to ask.\n`);
        return 0;
      }
    } else {
      prNumbers = [Number(opts.pr)];
    }

    // The ask needs the list before it posts anything.
    const approvers = readApprovers(env.SHIPYARD_APPROVERS, warn);
    let slack = io.slack || null;
    const getSlack = () => {
      if (slack) return slack;
      if (!env.SHIPYARD_SLACK_BOT_TOKEN) throw new SlackError('SHIPYARD_SLACK_BOT_TOKEN is not set');
      slack = createSlackClient({ token: env.SHIPYARD_SLACK_BOT_TOKEN, apiUrl: env.SLACK_API_URL || undefined });
      return slack;
    };

    // The Shipyard that runs: a release cut two or more minor versions before it is refused (lib/shipyard-version.js).
    const current = currentOf(io);
    // Each release PR on its own: one that is refused or fails never keeps another from being asked.
    let worst = 0;
    for (const prNumber of prNumbers) {
      const label = opts.pr === undefined ? `#${prNumber}: ` : '';
      try {
        const say = (text) => out.write(`${label}${text}`);
        const code = await askRelease({
          github, getSlack, repo, prNumber, opts, approvers, tagOverride, authors, fleetLogins, now, say, warn, current,
        });
        worst = Math.max(worst, code);
      } catch (e) {
        worst = Math.max(worst, fail(e, label));
      }
    }
    return worst;
  } catch (e) {
    return fail(e, '');
  }
}

module.exports = { run, USAGE };
