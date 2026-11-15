'use strict';

// The prep job: the issue the start files in this repo for one release, "Prepare <product> from
// <branch> @ <commit>", labelled `agent:release`. The issue's body ends with a machine block the
// start-watch step reads back. The block is data: it is parsed and checked, never trusted.

const { BRANCH, APPROVER } = require('./start-config');
const { parseTag } = require('./release-git');
const { firstReleaseOf } = require('./first-release');

const JOB_LABEL = 'agent:release';
const MARKER = /<!-- shipyard:prep-job (\{[^\n]*\}) -->/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const TRIGGERS = ['daily', 'weekly', 'by hand', 'release:now'];

const productOf = (repo) => repo.split('/')[1];

function jobTitle({ repo, branch, commit }) {
  return `Prepare ${productOf(repo)} from ${branch} @ ${commit.slice(0, 7)}`;
}

// `firstRelease` is the version a first release is set to (lib/first-release.js), or left out:
// `from` is then the repo's `firstRelease.from`, not a release tag.
function jobMarker({ repo, branch, commit, trigger, from, tagPrefix, approvers, firstRelease = null }) {
  const data = { repo, branch, commit, trigger, now: trigger === 'release:now', from, tagPrefix, approvers, ...(firstRelease ? { firstRelease } : {}) };
  return `<!-- shipyard:prep-job ${JSON.stringify(data)} -->`;
}

// The job's issue body. A PR is named with its repo (`owner/name#12`): a bare `#12` would link
// to this repo's own issue 12.
//
// `pin` is the code the repo's cut is pinned to (lib/pin.js): `{ sha, version }`, or `{ why }` when
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
      `The cut makes the facts and lints the file with the code the repo's cut is pinned to (turbot/shipyard-workflows ${pin.sha.slice(0, 7)}${pin.version ? `, ${pin.version}` : ''} when this job was filed), so make the facts and lint the file with that code, not this checkout's. Get it, with the product checkout fetched, just before you make the facts: the command reads the pin on \`${branch}\` as it is now, which is what the cut runs.`,
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
    'Taking the job counts when a worker picks it up or it is assigned to a person. If it gets no answer in time, the approvers are asked to pick a level and start the cut (docs/release-start.md).',
    '',
    jobMarker({ repo, branch, commit, trigger, from, tagPrefix, approvers, firstRelease }),
  );
  return `${lines.join('\n')}\n`;
}

// The job a body describes, or null when it holds no valid block. Every field is checked: an
// issue anyone can edit must not steer which repo or branch the watch reads or whom it names.
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
  return {
    repo: d.repo, branch: d.branch, commit: d.commit, trigger: d.trigger, now: d.now, from: d.from, tagPrefix: d.tagPrefix, approvers: d.approvers,
    ...(first ? { firstRelease: first.version } : {}),
  };
}

module.exports = { JOB_LABEL, jobTitle, jobBody, jobMarker, parseJob, productOf };
