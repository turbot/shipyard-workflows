'use strict';

// The prep job: the issue the start files in this repo for one release, "Prepare <product> from
// <branch> @ <commit>", labelled `agent:release`. The issue's body ends with a machine block the
// start's own re-run reads back. The block is data: it is parsed and checked, never trusted.

const { BRANCH, APPROVER } = require('./start-config');
const { parseTag } = require('./release-git');
const { firstReleaseOf } = require('./first-release');
const { clean } = require('./clean');

const JOB_LABEL = 'agent:release';
const MARKER = /<!-- shipyard:prep-job (\{[^\n]*\}) -->/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const TRIGGERS = ['daily', 'weekly', 'by hand', 'release:now', 're-ship'];
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const productOf = (repo) => repo.split('/')[1];

function jobTitle({ repo, branch, commit }) {
  return `Prepare ${productOf(repo)} from ${branch} @ ${commit.slice(0, 7)}`;
}

// `firstRelease` is the version a first release is set to (lib/first-release.js), or left out:
// `from` is then the repo's `firstRelease.from`, not a release tag.
// `reship` is `{ version, pr, run }` for a re-ship's job (lib/reship.js), or left out.
function jobMarker({ repo, branch, commit, trigger, from, tagPrefix, approvers, firstRelease = null, reship = null }) {
  const data = { repo, branch, commit, trigger, now: trigger === 'release:now', from, tagPrefix, approvers, ...(firstRelease ? { firstRelease } : {}), ...(reship ? { reship } : {}) };
  return `<!-- shipyard:prep-job ${JSON.stringify(data)} -->`;
}

// The job's issue body. A PR is named with its repo (`owner/name#12`): a bare `#12` would link
// to this repo's own issue 12.
//
// `pin` is the code the repo's cut calls (lib/pin.js): `{ sha, version, ref }`, or `{ why }` when
// none can be named. The cut makes the facts and lints the file with that code, so the body tells
// the prep run to do both with it: facts made by another version can name other PRs.
function jobBody({ repo, branch, commit, trigger, from, tagPrefix, shipped, bumps, approvers, pin = {}, firstRelease = null }) {
  const prs = shipped.filter((s) => s.pr).map((s) => `${repo}#${s.pr}`);
  const commits = shipped.filter((s) => !s.pr).map((s) => s.sha.slice(0, 7));
  const lines = [
    `Prepare the release of ${repo} from \`${branch}\` at ${commit.slice(0, 7)}.`,
    '',
    `- **Started by:** ${trigger}`,
    `- **Range:** ${from} to ${commit.slice(0, 7)}`,
    `- **Shipped changes waiting:** ${prs.length ? prs.join(', ') : 'none by PR'}${commits.length ? `; commits with no PR: ${commits.join(', ')}` : ''}`,
  ];
  if (bumps.length) lines.push(`- **Dependency bumps only (no reason to start alone):** ${bumps.map((n) => `${repo}#${n}`).join(', ')}`);
  if (firstRelease) lines.push(`- **First release:** ${firstRelease}, set by \`firstRelease\` in the repo's \`.github/release.json\`. The repo has no release tag yet, so the level you pick does not set the number.`);
  // A first release starts at a ref that is no release tag, which `--from` refuses: the facts find it
  // themselves, by the same rule the start used.
  const factsArgs = `--repo ${repo} --to ${commit}${firstRelease ? '' : ` --from ${from}`}${tagPrefix === 'v' ? '' : ` --tag-prefix=${tagPrefix}`} --dir <product checkout> --out facts.json`;
  lines.push('', 'Run the release-report skill for it (`.claude/skills/release-report/SKILL.md`).');
  if (pin.sha) {
    // One folder name, made afresh each time, and the pin read again at the branch's tip when it is
    // run: a clone that already exists would stay at an older pin, and Dependabot may move the pin
    // after the job is filed. The cut runs the pin of the branch when it is started. The old clone goes
    // first, so a pin that cannot be named leaves no code to run by mistake.
    const clone = `rm -rf pinned && pin=$(node bin/shipyard pin --dir <product checkout> --ref origin/${branch}) && git clone --quiet https://github.com/turbot/shipyard-workflows pinned && git -C pinned checkout --quiet "$pin"`;
    lines.push(
      '',
      `The cut makes the facts and lints the file with the code the repo's cut is pinned to (turbot/shipyard-workflows ${pin.sha.slice(0, 7)}${pin.version ? `, ${pin.version}` : ''}${pin.ref ? `, which ${pin.ref} names` : ''} when this job was filed), so make the facts and lint the file with that code, not this checkout's. Get it, with the product checkout fetched, just before you make the facts: the command reads the pin on \`${branch}\` as it is now, which is what the cut runs.`,
      '',
      '```',
      clone,
      '```',
      '',
      'Make the facts, with the product checkout at that commit:',
      '',
      '```',
      `GITHUB_TOKEN=$(gh auth token) node pinned/bin/shipyard facts ${factsArgs}`,
      '```',
      '',
      'Then lint the prep file with the same code, before you hand it over:',
      '',
      '```',
      'node pinned/bin/shipyard lint-prep prep.json --facts facts.json',
      '```',
      '',
    );
  } else {
    lines.push(
      '',
      `No pinned cut was found to name (${pin.why || 'the repo was not read'}), so use this checkout's code. Make the facts first, with the product checkout at that commit:`,
      '',
      '```',
      `GITHUB_TOKEN=$(gh auth token) node bin/shipyard facts ${factsArgs}`,
      '```',
      '',
    );
  }
  lines.push(
    jobMarker({ repo, branch, commit, trigger, from, tagPrefix, approvers, firstRelease }),
  );
  return `${lines.join('\n')}\n`;
}

function reshipTitle({ repo, tag, branch, commit }) {
  return `Re-ship ${productOf(repo)} ${tag} from ${branch} @ ${commit.slice(0, 7)}`;
}

// A re-ship's job: the version that merged and was never tagged, the run that failed, and the cut to
// run. No prep run: the version, its CHANGELOG section, its notes and its report are the ones that merged.
function reshipJobBody({ repo, branch, commit, from, tagPrefix, approvers, release, run, firstRelease = null }) {
  const flag = tagPrefix === 'v' ? '' : ` --tag-prefix=${tagPrefix}`;
  const lines = [
    `Re-ship ${release.tag} of ${repo}: the same version again, from \`${branch}\` at ${commit.slice(0, 7)}.`,
    '',
    '- **Started by:** re-ship, by hand',
    `- **Why:** the release PR ${repo}#${release.pr} merged as ${release.mergeCommit.slice(0, 7)}${/^\d{4}-\d{2}-\d{2}/.test(release.mergedAt) ? ` on ${release.mergedAt.slice(0, 10)}` : ''}, its ship run ${run.id} failed at ${clean(run.failedAt, 160)} (${run.url}), and ${release.tag} was never made.`,
    `- **What happens:** the cut makes \`${release.branch}\` again from \`${branch}\`, with one new file, \`releases/${release.tag}/reship-${run.id}.json\`. The fix to the ship job is merged into the working branch first and named in the cut's \`fixes\` (its merge commit), which cherry-picks it onto that branch. A fix that changes a file under \`.github/workflows/\` cannot go in \`fixes\` (the job's own token cannot push it): the cut stops and names it, and a person cherry-picks it onto \`${release.branch}\` and pushes it. The merge of the re-ship PR runs the fixed ship job. When it passes, ${release.tag} is tagged at that merge.`,
    '',
    `No prep run is needed: the version, its CHANGELOG section, its release notes and its report are the ones that merged. Start the cut with the version (\`cut.yml\` with \`reship\`, run on the working branch with \`commit\` the tip of \`${branch}\`), or by hand in a checkout of the base:`,
    '',
    '```',
    `GITHUB_TOKEN=$(gh auth token) node bin/shipyard cut --reship ${release.version}${flag} --dir <product checkout at ${branch}> --out release-pr`,
    '```',
    '',
    jobMarker({
      repo, branch, commit, trigger: 're-ship', from, tagPrefix, approvers, firstRelease, reship: { version: release.version, pr: release.pr, run: run.id },
    }),
  ];
  return `${lines.join('\n')}\n`;
}

// The job a body describes, or null when it holds no valid block. Every field is checked: an
// issue anyone can edit must not steer which repo or branch the start reads or whom it names.
function parseJob(body) {
  const m = MARKER.exec(String(body || ''));
  if (!m) return null;
  let d;
  try {
    d = JSON.parse(m[1]);
  } catch {
    return null;
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
  if (typeof d.repo !== 'string' || !REPO.test(d.repo)) return null;
  if (typeof d.branch !== 'string' || !BRANCH.test(d.branch)) return null;
  if (typeof d.commit !== 'string' || !SHA.test(d.commit)) return null;
  if (!TRIGGERS.includes(d.trigger)) return null;
  if (d.now !== (d.trigger === 'release:now')) return null;
  if (typeof d.tagPrefix !== 'string' || !/^[A-Za-z0-9._-]{0,20}$/.test(d.tagPrefix)) return null;
  // A first release starts at the repo's `firstRelease.from` and carries its version; any other job
  // starts at a release tag.
  let first = null;
  if (d.firstRelease !== undefined) {
    try {
      first = firstReleaseOf({ firstRelease: { from: d.from, version: d.firstRelease } });
    } catch {
      return null;
    }
  } else if (typeof d.from !== 'string' || !parseTag(d.from, d.tagPrefix)) return null;
  if (!Array.isArray(d.approvers) || d.approvers.length > 20 || d.approvers.some((a) => typeof a !== 'string' || !APPROVER.test(a))) return null;
  // A re-ship's job names the version, its merged PR and the failed run; no other job has the field.
  let reship = null;
  if ((d.trigger === 're-ship') !== (d.reship !== undefined)) return null;
  if (d.reship !== undefined) {
    const r = d.reship;
    if (!r || typeof r !== 'object' || typeof r.version !== 'string' || !VERSION.test(r.version)
      || !Number.isSafeInteger(r.pr) || r.pr < 1 || !Number.isSafeInteger(r.run) || r.run < 1) return null;
    reship = { version: r.version, pr: r.pr, run: r.run };
  }
  return {
    repo: d.repo, branch: d.branch, commit: d.commit, trigger: d.trigger, now: d.now, from: d.from, tagPrefix: d.tagPrefix, approvers: d.approvers,
    ...(first ? { firstRelease: first.version } : {}),
    ...(reship ? { reship } : {}),
  };
}

module.exports = {
  JOB_LABEL, jobTitle, jobBody, jobMarker, parseJob, productOf, reshipTitle, reshipJobBody,
};
