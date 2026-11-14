'use strict';

// The prep job: the issue the start files in this repo for one release, "Prepare <product> from
// <branch> @ <commit>", labelled `agent:release`. The issue's body ends with a machine block the
// start-watch step reads back. The block is data: it is parsed and checked, never trusted.

const { BRANCH, APPROVER } = require('./start-config');
const { parseTag } = require('./release-git');

const JOB_LABEL = 'agent:release';
const MARKER = /<!-- shipyard:prep-job (\{[^\n]*\}) -->/;
const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA = /^[0-9a-f]{40}$/;
const TRIGGERS = ['daily', 'weekly', 'by hand', 'release:now'];

const productOf = (repo) => repo.split('/')[1];

function jobTitle({ repo, branch, commit }) {
  return `Prepare ${productOf(repo)} from ${branch} @ ${commit.slice(0, 7)}`;
}

function jobMarker({ repo, branch, commit, trigger, from, tagPrefix, approvers }) {
  const data = { repo, branch, commit, trigger, now: trigger === 'release:now', from, tagPrefix, approvers };
  return `<!-- shipyard:prep-job ${JSON.stringify(data)} -->`;
}

// The job's issue body. A PR is named with its repo (`owner/name#12`): a bare `#12` would link
// to this repo's own issue 12.
function jobBody({ repo, branch, commit, trigger, from, tagPrefix, shipped, bumps, approvers }) {
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
  lines.push(
    '',
    'Run the release-report skill for it (`.claude/skills/release-report/SKILL.md`). Make the facts first, with the product checkout at that commit:',
    '',
    '```',
    `GITHUB_TOKEN=$(gh auth token) node bin/shipyard facts --repo ${repo} --to ${commit} --from ${from}${tagPrefix === 'v' ? '' : ` --tag-prefix=${tagPrefix}`} --dir <product checkout> --out facts.json`,
    '```',
    '',
    'Taking the job counts when a worker picks it up or it is assigned to a person. If it gets no answer in time, the approvers are asked to pick a level and start the cut (docs/release-start.md).',
    '',
    jobMarker({ repo, branch, commit, trigger, from, tagPrefix, approvers }),
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
  if (typeof d.from !== 'string' || !parseTag(d.from, d.tagPrefix)) return null;
  if (!Array.isArray(d.approvers) || d.approvers.length > 20 || d.approvers.some((a) => typeof a !== 'string' || !APPROVER.test(a))) return null;
  return { repo: d.repo, branch: d.branch, commit: d.commit, trigger: d.trigger, now: d.now, from: d.from, tagPrefix: d.tagPrefix, approvers: d.approvers };
}

module.exports = { JOB_LABEL, jobTitle, jobBody, jobMarker, parseJob, productOf };
