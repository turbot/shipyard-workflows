'use strict';

// The merge-back after a release is tagged: the release branch (`main`, `main-<x.y>`) is merged into
// the work branch the candidate was cut from, so the new tag's commit is in that branch's history and
// the next range has a start. One PR does it, merged with a merge commit once its checks pass. A squash
// or a rebase would leave the tag's commit out of the work branch, so neither is ever asked for.
//
// Reads GitHub only, like the tag: no checkout, nothing from the repo is run. The reads use the job's
// token and the writes (the PR, its merge) the release App's. The checks are read with the App's token
// too: the job's own token holds no `checks` or `statuses` permission, and a caller grants only what it
// already did.

const { GitHubError } = require('./github');
const {
  Refusal, lineOf, WORK_BRANCH_TRAILER, isBranchName,
} = require('./release-git');
const { show, short } = require('./tag');

const SETTLED_OK = new Set(['success', 'neutral', 'skipped']);
// More rounds than this of GitHub saying "no" with every check green is a rule, not a race.
const BLOCKED_ROUNDS = 6;

const trailerPattern = new RegExp(`^${WORK_BRANCH_TRAILER}:[ \\t]*(.*?)[ \\t]*$`);

// How far down the candidate's first-parent line from its head to look for the cut commit. The cut
// commit is the first of the candidate, with the record's evidence commits and any fix merged into the
// candidate on top of it: a handful. The release PR's own commit list is no help, for it holds every
// commit of the work branch since the last release and GitHub lists at most 250 of them.
const MAX_WALK = 50;

// The work branch the cut recorded: the `Release-From` trailer of the cut commit, `chore(release): <tag>`,
// found by walking the first-parent line down from the PR's head. A commit with any other subject
// (the record's evidence commit, a merged fix) is not the cut and its trailers are not read.
async function workBranchOf(github, repo, headSha, tag) {
  let sha = headSha;
  for (let step = 0; step < MAX_WALK && /^[0-9a-f]{40}$/.test(String(sha)); step++) {
    const commit = await github.getCommit(repo, sha);
    const lines = String(commit.message).replace(/\r\n?/g, '\n').split('\n');
    if (lines[0].trim() === `chore(release): ${tag}`) {
      for (const line of lines.slice(1)) {
        const m = trailerPattern.exec(line);
        if (m && m[1]) return m[1];
      }
      throw new Refusal(`the cut commit of ${tag} records no work branch (a Release-From line), so there is nowhere to merge it back to. Merge the release branch into the work branch it was cut from by hand, with a merge commit (never a squash or a rebase), so that ${tag}'s commit is in its history`);
    }
    sha = commit.parents[0];
  }
  throw new Refusal(`the cut commit of ${tag} is not in the ${MAX_WALK} commits below the release PR's head, so its work branch is not known. Merge the release branch into the work branch it was cut from by hand, with a merge commit (never a squash or a rebase), so that ${tag}'s commit is in its history`);
}

// A work branch is never a branch that releases, and never a candidate branch.
function checkWorkBranch(branch, release) {
  if (!isBranchName(branch) || branch.startsWith('release/')) {
    throw new Refusal(`the work branch the cut recorded, ${show(branch, 60)}, is not a branch name: merge ${release.base} back by hand`);
  }
  if (lineOf(branch) !== null) {
    throw new Refusal(`${release.tag} was cut from ${branch}, which is a release branch and no work branch: merge ${release.base} into the work branch that should have it by hand, with a merge commit`);
  }
}

// What a commit's checks say: names of the failed and the pending ones. The PR's head is the release
// branch's tip, the commit the push to `main` ran on, so its check runs include the ship and tag jobs of
// the workflow run this step is in (never done while this step waits): those are skipped, by the run id
// in their link.
const ownRunLink = (runId) => `/actions/runs/${runId}/`;
function checksOf(runs, statuses, { ownRun = null } = {}) {
  const failed = [];
  const pending = [];
  for (const r of runs) {
    if (ownRun && String(r.details_url || '').includes(ownRunLink(ownRun))) continue;
    const name = String(r.name || 'a check');
    if (r.status !== 'completed') pending.push(name);
    else if (!SETTLED_OK.has(r.conclusion)) failed.push(name);
  }
  const seen = new Set();
  for (const s of statuses) {
    const name = String(s.context || 'a status');
    if (seen.has(name)) continue; // newest first: the older answers of a context are replaced
    seen.add(name);
    if (s.state === 'pending') pending.push(name);
    else if (s.state !== 'success') failed.push(name);
  }
  return { failed, pending };
}

const names = (list) => list.slice(0, 5).map((n) => show(n, 60)).join(', ') + (list.length > 5 ? ` and ${list.length - 5} more` : '');

function mergePrBody({ release, into }) {
  return [
    `Merges \`${release.base}\` back into \`${into}\` after ${release.tag} (release PR #${release.number}), so the tag's commit is in \`${into}\`'s history and the next release's range has a start.`,
    '',
    'Opened by Shipyard after the tag. **Merge it with a merge commit**, never a squash or a rebase: either would leave the tag\'s commit out of the branch.',
    '',
    'Changelog: The merge-back of a release into its work branch; it holds the release\'s own files and no change.',
    '',
    `<!-- shipyard:merge-back ${release.tag} -->`,
    '',
  ].join('\n');
}

// An open merge-back PR of this repo: from the release branch into the work branch.
const findOpen = async (github, repo, release, into) => (await github.listOpenPulls(repo)).find((p) => p && p.head && p.base
  && p.head.ref === release.base && p.base.ref === into
  && p.head.repo && String(p.head.repo.full_name).toLowerCase() === repo.toLowerCase());

// The tag's commit is in the work branch when the branch is at it or ahead of it.
const contains = async (github, repo, release, into) => {
  const status = await github.compareStatus(repo, release.sha, into);
  return status === 'ahead' || status === 'identical';
};

/**
 * Opens the merge-back PR (or finds the open one) and merges it once its checks pass.
 * Returns `{ action, number }`: `already` (the tag's commit is in the branch, nothing done), or `merged`.
 * A PR that cannot merge is left open and throws a Refusal that says what to do.
 */
async function mergeBack({
  github, writer, repo, release, into, ownRun = null, waitMs = 20 * 60000, pollMs = 20000, graceMs = 60000,
  now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  const { base, tag } = release;
  if ((await github.branchTip(repo, into)) === null) {
    throw new Refusal(`${into}, the work branch ${tag} was cut from, is gone: merge ${base} into the branch that holds that work now, by hand, with a merge commit`);
  }
  if (await contains(github, repo, release, into)) return { action: 'already', number: null };

  let pr = await findOpen(github, repo, release, into);
  let opened = false;
  if (!pr) {
    try {
      const made = await writer.createPull(repo, {
        title: `Merge ${base} back into ${into} after ${tag}`, body: mergePrBody({ release, into }), head: base, base: into,
      });
      pr = { number: made.number };
      opened = true;
    } catch (e) {
      if (!(e instanceof GitHubError) || e.status !== 422) throw e;
      // A second run opened it between the read and the write, or there is nothing left to merge.
      pr = await findOpen(github, repo, release, into);
      if (!pr) {
        if (await contains(github, repo, release, into)) return { action: 'already', number: null };
        throw e;
      }
    }
  }
  const { number } = pr;
  const where = `#${number} (${base} into ${into})`;

  const startedAt = now();
  let blocked = 0;
  for (;;) {
    const current = await github.getPull(repo, number);
    if (current.merged_at) return { action: 'merged', number, opened };
    if (current.state === 'closed') {
      throw new Refusal(`${where} was closed without merging: ${tag}'s commit is not in ${into}. Reopen it, or open the merge-back again by running this job again`);
    }
    if (current.mergeable === false) {
      throw new Refusal(`${where} has a conflict and stays open. Merge ${into} into a branch made from ${base}, settle the conflict there, merge that branch into ${into} with a merge commit (never a squash or a rebase), and close #${number}`);
    }
    const sha = current.head && current.head.sha;
    const checks = checksOf(await writer.listCheckRuns(repo, sha), await writer.listCommitStatuses(repo, sha), { ownRun });
    if (checks.failed.length) {
      throw new Refusal(`${names(checks.failed)} failed on ${where}, which stays open. Fix it there or run the check again, then merge it with a merge commit, or run this job again`);
    }
    // A PR opened a moment ago has no checks yet: its workflows start late, so it is not merged
    // before the grace is over, whatever else has already run on the commit.
    const young = opened && now() - startedAt < graceMs;
    const settled = !checks.pending.length && !young;
    let reason = checks.pending.length ? `${names(checks.pending)} still running` : 'its checks have not started';
    if (settled) {
      try {
        await writer.mergePull(repo, number, { method: 'merge', sha });
        return { action: 'merged', number, opened };
      } catch (e) {
        if (!(e instanceof GitHubError) || (e.status !== 405 && e.status !== 409)) throw e;
        if (e.status === 405) blocked += 1;
        reason = e.status === 405 ? 'GitHub would not merge it' : `its head moved to a newer commit than ${short(sha)}`;
        if (blocked >= BLOCKED_ROUNDS) {
          throw new Refusal(`GitHub would not merge ${where} though its checks pass: a required review or a branch rule is missing. It stays open: approve it and merge it with a merge commit, or run this job again`);
        }
      }
    }
    if (now() + pollMs > startedAt + waitMs) {
      throw new Refusal(`${where} did not merge in ${Math.round(waitMs / 60000)} minutes (${reason}). It stays open: when its checks pass, merge it with a merge commit, or run this job again`);
    }
    await sleep(pollMs);
  }
}

module.exports = {
  workBranchOf, checkWorkBranch, checksOf, mergeBack,
};
