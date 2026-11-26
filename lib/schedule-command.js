'use strict';

// `shipyard schedule [--live | --shadow | --decide-only] [--repo <owner>/<name> [--branch <name>]] [--org <org>] ...`:
// decide which release repos the central start would start this hour (lib/schedule.js), run the exact check of each
// due repo on a partial clone and file its prep job (lib/schedule-file.js), and print one line for each. The mode is
// shadow (the default: decide and log, file nothing) or live (file, but only for a repo whose default branch already
// holds `.github/shipyard.yml`). A run (but `--decide-only` and `--repo`) first starts the repo of each PR merged lately
// with the `release:now` label, whatever the area's start time (lib/schedule-release-now.js). `--repo` starts that one
// repo at once, whatever the time. `--report` makes or updates the week's report issue, and `--report-if-due` makes it only when the
// clock and the issues say it is missing (lib/schedule-report.js). The token comes from the
// environment (`GITHUB_TOKEN`, else `GH_TOKEN`), never from a file of a repo or a flag. Exit 0 when every repo was
// decided and every due one checked (and filed, live); 1 when GitHub failed on a repo, or the exact check or the filing
// of one failed (the rest are still done, and the run names each at the end); 2 when the run could not decide at all: no
// token, no list of repos, no areas file, a bad option.

const fs = require('node:fs');
const { createClient, GitHubError } = require('./github');
const { ReleaseError, Refusal } = require('./release-git');
const { parseOptions } = require('./release-args');
const {
  decideAll, releaseRepos, lineOf, PROPERTY,
} = require('./schedule');
const { BRANCH } = require('./start-config');
const { fileRepo, filingLine, failed } = require('./schedule-file');
const { runReleaseNow, releaseNowLine, releaseNowFailed } = require('./schedule-release-now');
const { partialClone } = require('./partial-clone');
const {
  isoWeek, mondayOf, dueWeek, checkRepo, postReport, reportLine,
} = require('./schedule-report');

const USAGE = 'usage: shipyard schedule [--live | --shadow | --decide-only | --report | --report-if-due] [--repo <owner>/<name> [--branch <name>]] [--org <org>] [--areas-repo <owner>/<name> | --areas-file <path>] [--property <name>] [--families <folder>] [--now <time>] [--json] [--out <result.json>]';
const FLAGS = {
  '--org': 'org', '--areas-repo': 'areasRepo', '--areas-file': 'areasFile', '--property': 'property', '--families': 'families', '--now': 'now', '--out': 'out', '--repo': 'repo', '--branch': 'branch',
};
const SWITCHES = {
  '--json': 'json', '--live': 'live', '--shadow': 'shadow', '--decide-only': 'decideOnly', '--report': 'report', '--report-if-due': 'reportIfDue',
};
const REPO = /^[^/\s]+\/[^/\s]+$/;
const ORG = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const PROPERTY_NAME = /^[A-Za-z0-9_.-]{1,75}$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

const AREAS_PATH = 'org/areas.yml';

async function areasText({ opts, github, areasRepo }) {
  if (opts.areasFile) {
    try {
      return fs.readFileSync(opts.areasFile, 'utf8');
    } catch (e) {
      throw new ReleaseError(`cannot read the areas file ${opts.areasFile}: ${e.code || e.message}`);
    }
  }
  // The areas file is read at the default branch of its repo, as org/README.md says.
  const branch = await github.defaultBranch(areasRepo);
  if (!branch) throw new ReleaseError(`${areasRepo} was not found, so its ${AREAS_PATH} could not be read`);
  const text = await github.getFileText(areasRepo, AREAS_PATH, branch);
  if (text === null) throw new ReleaseError(`${AREAS_PATH} is not in ${areasRepo} at ${branch}`);
  return text;
}

async function run(argv, io = {}) {
  const env = io.env || process.env;
  const out = io.stdout || process.stdout;
  const err = io.stderr || process.stderr;
  try {
    const opts = parseOptions(argv, FLAGS, { families: 'families' }, SWITCHES);
    if (opts.help) {
      out.write(`${USAGE}\n\nSee docs/release-schedule.md for the rule, the calls it makes and the decisions it prints.\n`);
      return 0;
    }
    const here = env.GITHUB_REPOSITORY && REPO.test(env.GITHUB_REPOSITORY) ? env.GITHUB_REPOSITORY : null;
    const org = opts.org || (here && here.split('/')[0]);
    if (!org || !ORG.test(org)) throw new ReleaseError('--org is required, as the name of the org (or set GITHUB_REPOSITORY)');
    const areasRepo = opts.areasRepo || here;
    if (!opts.areasFile && (!areasRepo || !REPO.test(areasRepo))) throw new ReleaseError('--areas-repo is required, as <owner>/<name> (or set GITHUB_REPOSITORY), unless --areas-file names a file');
    if (opts.areasFile && opts.areasRepo) throw new ReleaseError('give --areas-repo or --areas-file, not both');
    if (opts.live && opts.shadow) throw new ReleaseError('give --live or --shadow, not both');
    const reporting = Boolean(opts.report || opts.reportIfDue);
    if (opts.report && opts.reportIfDue) throw new ReleaseError('give --report or --report-if-due, not both');
    if (reporting && (opts.live || opts.shadow || opts.decideOnly || opts.repo !== undefined || opts.branch !== undefined)) {
      throw new ReleaseError('give --report and --report-if-due alone: they take neither --live, --shadow, --decide-only, --repo nor --branch');
    }
    if (opts.decideOnly && (opts.live || opts.shadow || opts.repo !== undefined)) throw new ReleaseError('give --decide-only alone: it takes neither --live, --shadow nor --repo');
    if (opts.repo !== undefined && !REPO.test(opts.repo)) throw new ReleaseError('--repo must be <owner>/<name>');
    if (opts.branch !== undefined && opts.repo === undefined) throw new ReleaseError('give --branch with --repo: it names the work branch of the one repo to start');
    if (opts.branch !== undefined && !BRANCH.test(opts.branch)) throw new ReleaseError('--branch must be a branch name');
    const property = opts.property || PROPERTY;
    if (!PROPERTY_NAME.test(property)) throw new ReleaseError('--property must be the name of a custom property');
    if (opts.now !== undefined && !ISO_WITH_ZONE.test(opts.now)) throw new ReleaseError('--now must be a time with its zone, such as 2026-11-24T09:07:00Z');
    const now = opts.now !== undefined ? Date.parse(opts.now) : (io.clock ? io.clock() : Date.now());
    if (!Number.isFinite(now)) throw new ReleaseError('--now is not a time');

    const token = env.GITHUB_TOKEN || env.GH_TOKEN;
    if (!token) throw new ReleaseError('GITHUB_TOKEN (or GH_TOKEN) is not set: the schedule takes its token from the environment');
    const github = io.github || createClient({ token, apiUrl: env.GITHUB_API_URL, sleep: io.sleep });
    const clone = io.clone || (({ repo, dir }) => partialClone({
      repo, dir, token, ...(env.GITHUB_SERVER_URL ? { serverUrl: env.GITHUB_SERVER_URL } : {}),
    }));
    if (reporting) {
      return await runReport({
        opts, env, out, err, github, clone, org, areasRepo, here, property, now,
      });
    }
    const mode = opts.decideOnly ? 'decide-only' : opts.live ? 'live' : 'shadow';
    const fileOne = (row, more) => fileRepo({
      github, repo: row.repo, area: row.area, live: mode === 'live', clone, familiesDir: opts.families, now, ...more,
    });

    const text = await areasText({ opts, github, areasRepo });
    let decisions = [];
    const filings = [];
    let areaWarnings;
    let releaseNow = [];
    if (opts.repo !== undefined) {
      // A start by hand: the exact check and the filing, whatever the time. Only a release repo of the org is started.
      const found = await releaseRepos({
        github, org, areasText: text, property,
      });
      areaWarnings = found.areaWarnings;
      const row = found.repos.find((r) => r.repo.toLowerCase() === opts.repo.toLowerCase());
      if (!row) throw new Refusal(`${opts.repo} is not a release repo of ${org}: it has no ${property} property, so the schedule does not start it`);
      if (!found.areas[row.area]) throw new Refusal(`the area ${JSON.stringify(row.area.slice(0, 60))} of the ${property} property of ${row.repo} is not in ${AREAS_PATH}, so it has no start time`);
      filings.push(await fileOne(row, { byHand: true, branch: opts.branch, startedAt: new Date(now).toISOString() }));
    } else {
      const found = await releaseRepos({
        github, org, areasText: text, property,
      });
      // A merged release:now PR starts its repo first, so the daily rule then sees that job and files no second one.
      if (mode !== 'decide-only') {
        releaseNow = await runReleaseNow({
          github, org, repos: found.repos, areas: found.areas, now, fileOne, home: here || areasRepo || null,
        });
      }
      const decided = await decideAll({
        github, org, areasText: text, now, property, familiesDir: opts.families, found,
      });
      areaWarnings = decided.areaWarnings;
      ({ decisions } = decided);
      if (mode !== 'decide-only') {
        // Each due repo in turn: one that fails is named at the end and the next is still started.
        for (const d of decisions.filter((x) => x.decision === 'due')) filings.push(await fileOne(d, { startedAt: d.since, cadence: d.cadence }));
      }
    }

    const report = {
      at: new Date(now).toISOString(), org, mode, decisions, filings, releaseNow,
    };
    if (opts.json) {
      out.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      for (const r of releaseNow) {
        out.write(`${releaseNowLine(r)}\n`);
        for (const n of r.notes) out.write(`  ${n}\n`);
      }
      for (const d of decisions) {
        out.write(`${lineOf(d)}\n`);
        for (const n of d.notes) out.write(`  ${n}\n`);
      }
      if (!decisions.length && opts.repo === undefined) out.write(`No repo of ${org} has the ${property} property set.\n`);
      for (const f of filings) {
        out.write(`${filingLine(f)}\n`);
        for (const n of f.notes) out.write(`  ${n}\n`);
      }
    }
    for (const w of areaWarnings) err.write(`${w}\n`);
    summary(env, decisions, filings, releaseNow);
    if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify(report, null, 2)}\n`);
    const broken = [
      ...decisions.filter((d) => d.decision === 'error').map((d) => `${d.repo} (${d.reason})`),
      ...filings.filter(failed).map((f) => `${f.repo} (${f.outcome}: ${f.reason})`),
      ...releaseNow.filter(releaseNowFailed).map((r) => `${r.repo ? `${r.repo}#${r.pr}` : 'release:now'} (${r.reason})`),
    ];
    if (broken.length) err.write(`shipyard schedule: failed for ${broken.join('; ')}\n`);
    return broken.length ? 1 : 0;
  } catch (e) {
    if (e instanceof Refusal) {
      err.write(`shipyard schedule: refused: ${String(e.message).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')}\n`);
      return 1;
    }
    if (!(e instanceof ReleaseError || e instanceof GitHubError)) throw e;
    err.write(`shipyard schedule: ${String(e.message).replace(/[\p{Cc}\u2028\u2029]+/gu, ' ')}\n`);
    if (/^(unknown option|unexpected argument|--\S+ (needs|is required)|give )/.test(e.message)) err.write(`${USAGE}\n`);
    return 2;
  }
}

// `--report` and `--report-if-due` (lib/schedule-report.js): the weekly report issue, in the schedule's own repo.
async function runReport({
  opts, env, out, err, github, clone, org, areasRepo, here, property, now,
}) {
  const home = here || opts.areasRepo;
  if (!home || !REPO.test(home)) throw new ReleaseError('the report needs the repo to make its issue in: set GITHUB_REPOSITORY, or give --areas-repo');
  let week = isoWeek(now);
  let monday = mondayOf(now);
  let current = null;
  if (opts.reportIfDue) {
    const due = dueWeek(now);
    if (!due) {
      out.write(`No release report is due: it is made from Sunday to Tuesday (now ${new Date(now).toISOString()}).\n`);
      return 0;
    }
    ({ week, monday } = due);
    current = due.sunday.slice(0, 10);
  }
  const warnings = [];
  const rows = async () => {
    const text = await areasText({ opts, github, areasRepo });
    const found = await releaseRepos({
      github, org, areasText: text, property,
    });
    warnings.push(...found.areaWarnings);
    const read = [];
    for (const row of found.repos) {
      read.push(await checkRepo({
        github, repo: row.repo, area: row.area, areas: found.areas, clone, familiesDir: opts.families, now,
      }));
    }
    return read;
  };
  const result = await postReport({
    github, repo: home, week, monday, updateExisting: Boolean(opts.report), current, now, rows,
  });
  if (opts.json) out.write(`${JSON.stringify({ at: new Date(now).toISOString(), org, report: result }, null, 2)}\n`);
  else out.write(`${reportLine(result)}\n`);
  for (const w of warnings) err.write(`${w}\n`);
  if (opts.out) fs.writeFileSync(opts.out, `${JSON.stringify({ at: new Date(now).toISOString(), org, report: result }, null, 2)}\n`);
  const unread = (result.rows || []).filter((r) => r.error);
  if (unread.length) err.write(`shipyard schedule: could not check ${unread.map((r) => `${r.repo} (${r.error})`).join('; ')}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    try {
      fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `### Release report\n\n- ${reportLine(result)}\n`);
    } catch {
      // a courtesy: the output and the exit code are the result
    }
  }
  return unread.length ? 1 : 0;
}

// The same lines in the run's step summary. A courtesy: the output and the exit code are the result.
function summary(env, decisions, filings, releaseNow = []) {
  if (!env.GITHUB_STEP_SUMMARY || !(decisions.length || filings.length || releaseNow.length)) return;
  const lines = [...releaseNow.map((r) => releaseNowLine(r)), ...decisions.map((d) => lineOf(d)), ...filings.map((f) => filingLine(f))];
  const text = `### Release schedule\n\n${lines.map((l) => `- ${l}\n`).join('')}`;
  try {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, text);
  } catch {
    // nothing to add: the decisions are already printed
  }
}

module.exports = { run, USAGE };
