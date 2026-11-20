# From a range of commits to a candidate branch

Three commands take a release from the commits since the last release to a branch a person can review. They run in a checkout of the product repo, in this order, with the prep run's file between the first two:

```
node bin/shipyard facts --repo <owner>/<name> --to <commit>        # writes facts.json
#   the prep run reads facts.json and writes prep.json (docs/prep-file.md)
node bin/shipyard lint-prep prep.json --facts facts.json
node bin/shipyard changelog --facts facts.json --prep prep.json --version 1.5.0   # prints the CHANGELOG section
node bin/shipyard cut --facts facts.json --prep prep.json                         # makes release/1.5.0
```

**Make the facts, and run the lint, with the code the cut runs.** The cut makes its own facts and lints the prep file with the commit of `turbot/shipyard-workflows` its workflows call `cut.yml` at (the commit `v0` names, for `@v0`). A prep file written from the facts of another version, such as develop's code one release ahead of the cut's, can name PRs the cut's facts do not, and the cut refuses it. `shipyard pin [--dir <checkout>] [--ref <ref>]` prints that commit, as the repo's workflows have it at `--ref` (for `@v0`, the commit the tag names now, read from `turbot/shipyard-workflows`): exit 1 when none can be named (no caller of the published `cut.yml`, callers that use different refs, or a tag that cannot be read), 2 when it could not run. Clone the published repo at it afresh and run its `bin/shipyard` for `facts` and `lint-prep`; the README's hand route and the prep job's body show the commands.

All three read `GITHUB_TOKEN` (or `GH_TOKEN`) and `GITHUB_API_URL` from the environment, and exit 0 when they did their work, 1 when they refused it (the inputs are fine and the answer is no), and 2 when they could not run. Nothing is written when one exits 2.

## `facts`

`shipyard facts --repo <owner>/<name> [--to <commit>] [--from <tag>] [--tag-prefix <prefix>] [--dir <checkout>] [--out facts.json]`

The range is the newest release tag up to `--to` (`HEAD` when left out). A release tag is the prefix (`v` unless `--tag-prefix` says otherwise) and a plain `X.Y.Z`; the newest is the highest version, not the latest made, and a pre-release such as `v2.0.0-rc1` is no release. `--from` names the tag to start at instead. The tag must be in the history of `--to`. A range with no start is exit 2.

**The clone must have GitHub's newest release tag.** A fetch of the work branch does not bring a release tag that is on another branch's history, so a long-lived clone can lack the newest tag and start the range one release too early (and `lint-prep` would pass it, as it lints against the same facts). So `facts` first asks GitHub for the repo's newest release tag with the prefix: the newest published GitHub Release, else the newest matching tag. A clone that lacks it gets one `git fetch origin tag <tag>`. If the tag is still missing, the fetch fails, or the clone's tag names a commit other than GitHub's, `facts` is exit 2, names the tag and the command to run (`git fetch origin tag <tag>`, or with `--force` for a tag at another commit, from the remote that is the repo), and writes no file. A clone that already has the tag at GitHub's commit is read as before, with no fetch. `--from` is checked the same way (the prep job's command passes it): the clone gets GitHub's newest tag, and a `--from` older than that tag is exit 2, since the cut makes its own facts from the newest and would refuse a file written for the older range. A repo with no release tag on GitHub is not checked: its `firstRelease` below applies. Nothing else is fetched. This needs a token that can read the repo's releases and tags (`contents: read` does), the one `facts` already uses for the PRs.

**A first release.** A repo that has never made a release tag names its way in once, in `.github/release.json`:

```json
{ "firstRelease": { "from": "release-2026-11-14-d22c0172", "version": "1.0.0" } }
```

`from` is an old tag (here, a date tag from the repo's old release flow) or a commit id, never a branch, which moves. `version` is a plain `X.Y.Z`. While the repo has no release tag, the range starts at `from` and the facts carry `firstRelease`, so the cut makes `release/1.0.0` whatever the prep run's level; the release check passes 1.0.0, and the tag step makes `v1.0.0` as for any release. Once a release tag exists the setting is ignored, and `facts` says so in one line: the newest tag starts the range again. A repo with no release tag and no `firstRelease` is exit 2, and the message names the setting to add. `facts`, `start`, `cut`, `record` and the release check read the same rule (`lib/first-release.js`).

A PR is a commit on the first-parent line of the range whose subject ends `(#12)` or starts `Merge pull request #12`. Each is read from GitHub as it is now. A commit with no PR, or whose number is not a merged PR, is listed in `unattributed` and raises a flag; a merge commit with no PR (a back-merge of `main`) is not.

**A merge-back is not a change.** A merged PR whose head is a release branch of this repo (`main` or `main-<x.y>`) and whose base is not one is the merge-back of an earlier release into its work branch ([release-tag.md](release-tag.md)). It carries that release's own files and no change, so it is left out of `prs[]` and named in `mergeBacks[]`, where the report can say "merge-back, not a change". No flag is raised for it. A PR from a fork's branch of the same name is no merge-back: it stays in `prs[]`.

| Field | What it holds |
|---|---|
| `format` | `1`, the version of this format. |
| `repo.name`, `repo.private` | The product repo and whether it is private. |
| `tagPrefix` | The prefix of the repo's release tags. |
| `range.from`, `range.fromCommit`, `range.to` | The tag the range starts at (for a first release, the `from` of `firstRelease`), the commit it points at, and the commit the range ends at (a full id). |
| `firstRelease` | Only for a first release: `from` and `version`, as the repo's `.github/release.json` names them. The version is set, not counted. |
| `prs[].number`, `title`, `url`, `author`, `mergedAt`, `commit` | The PR, and the commit of the range it came in. |
| `prs[].changelog` | The PR's one `Changelog:` line, unchanged, or `null` when it has none or more than one. |
| `prs[].updateNeeds` | The PR's one `Update-Needs:` line, or `null`. |
| `prs[].issues` | The issues the PR closes or refers to (`Fixes #1`, `Refs #2`), in this repo. |
| `prs[].review` | `state` (`approved`, `changes-requested` or `none`), `approvedBy` and `changesRequestedBy`: each reviewer's last say counts, a dismissal clears it, a comment decides nothing. |
| `prs[].shipsNothing` | `true` when every file of the PR is one of Shipyard's own (`.github/release.json`, `CHANGELOG.md`) or matches `notShipped` in the repo's `.github/release.json` (`lib/not-shipped.js`, the matcher the Changelog line check uses). |
| `prs[].dependencyOnly` | `true` for a PR by Dependabot or Renovate, or titled "Bump x from a to b". |
| `mergeBacks[]` | The merged PRs of the range that only merge a release branch back into a work branch: `number`, `title`, `url`, `mergedAt`, `commit`, `from` (the release branch) and `into` (the work branch). Not in `prs[]`, never counted as a change. |
| `unattributed[]` | The commits of the range with no merged PR: `sha`, `subject`, `why`. |
| `breaking[]` | The breaking signs of the repo's detector: `id` and `why`. |
| `callerNeeds[]` | Only when the repo keeps a `workflows/contract.json` at `--to`: what its published workflows ask of callers now that they did not at the range's start, each as `workflow`, `kind`, `name` and, for a permission, `job`, `from` and `to`. Not written for a first release. `lint-prep` refuses a level below major while it holds anything ([prep-file.md](prep-file.md#what-callers-must-give)). |
| `flags[]` | The read-first flags: `id` and `why`. The prep run answers each one (`level.flags`). |
| `internalTerms` | `notes.internalTerms` of the repo's `.github/release.json`. |
| `publicRepos`, `privateHosts` | Optional, read by `lint-prep` ([prep-file.md](prep-file.md)). `facts` does not write them; a person adds them to the file when the release notes link to other repos or hosts. |

`.github/release.json` is read at `--to`, never from the working tree.

The read-first flags, each with an id that names its PR or sign: `breaking-<sign>` for each of the detector's signs, `dependency-bump-<n>`, `update-needs-<n>`, `no-changelog-line-<n>` (a PR that ships something and has no single line), `changes-requested-<n>` (merged with a review still asking for changes) and `commit-without-pr-<sha7>`.

### The breaking-change detector

A repo that has one names it in `.github/release.json` as a command, a list of strings run without a shell:

```json
{ "breaking": { "detector": ["node", "scripts/breaking.js"] } }
```

It runs in the checkout (which must be at `--to`; for a patch, a scratch worktree at `--to` with the fixes picked on, removed after, with `SHIPYARD_TO` that commit) with `SHIPYARD_FROM` and `SHIPYARD_TO` set, no token and no other secret, and a two-minute limit, and prints a JSON list: `[{ "id": "removed-flag", "why": "The --old flag is gone." }]`. An `id` is lowercase letters, digits, `.`, `_` and `-`. A detector that fails, times out or prints anything else is exit 2: a failed detector is never read as "no signs". A repo with no detector has no signs. The command is code the repo already holds at the commit being released, run by the job that makes the facts; no secret sits beside it.

## `changelog`

`shipyard changelog --facts facts.json --prep prep.json --version X.Y.Z [--date YYYY-MM-DD] [--file CHANGELOG.md]`

Builds this version's section from each PR's own `Changelog:` line, in the prep run's groups (`Added`, `Changed`, `Fixed`, `Removed`, `Security`, `Internal`, in that order; a PR by number inside a group). A line is never edited: it goes in as the facts hold it, then ` (#12)`. A PR's `Update-Needs:` line goes under it. A PR with `shipsNothing` is left out, even when it has a line. A release where nothing ships still gets a section that says so.

```
## [1.5.0] - 2026-11-13

### Added

- Export any report as CSV from the report page. (#101)

### Fixed

- Runs that cross midnight show the day they started. (#103)
  - Update needs: Restart the daemon after updating.
```

The facts and the prep file must pass `lint-prep` first. The command is refused (exit 1) when the prep file fails it, when a PR that ships something has no line, or when the version is already in the file. It prints the section, or with `--file` puts it above the newest section of that file (creating the file with a `# Changelog` heading when it is not there). The date is today in UTC unless `--date` says otherwise.

## `cut`

`shipyard cut --facts facts.json --prep prep.json [--dir <checkout>] [--out release-pr] [--base main] [--work-branch develop] [--within <ref>] [--date YYYY-MM-DD] [--changelog CHANGELOG.md]`

1. **The number** is the facts' release tag plus the prep file's `level.bump`: `v1.4.2` and `minor` make `1.5.0`. The facts must still start at the newest release tag, and the tag must still point where the facts read it; otherwise the cut is refused and the facts are made again. For a first release the number is the facts' `firstRelease.version` and the level does not move it; the cut is refused when a release tag has been made since, when `.github/release.json` at `range.to` no longer names the same `firstRelease`, or when `from` no longer points where the facts read it.
2. **A cut uses up its number.** A version names one build, so a number a cut has made is never made again. A number is **used** when a tag has it, when `release/<version>` exists on the remote, or when a PR of this repo from `release/<version>` titled `Release <tag>` exists, open, merged or closed. A candidate that is **open**, or one that **merged and waits for its tag** (a re-ship finishes that version, below), refuses the cut (exit 1). Otherwise the cut takes the number of item 1, then the next patch while that number is used. **Nothing is deleted, moved or replaced** to free a number. pipes' first release is the example: its cut of 1.43.0 made `release/1.43.0`, its images tagged `1.43.0` ran on staging, and the run stopped before its PR opened. pipes names its images by version and a node keeps an image it already holds, so a second build under 1.43.0 would never reach staging. The next cut from v1.42.1 with `minor` makes `release/1.43.1` and leaves `release/1.43.0` as it is; its line says `(skipped 1.43.0 (release/1.43.0 exists): a cut never makes a used number again)`, and the artifact lists it in `skipped`. Only a PR from a branch of this repo counts: a fork that names its branch `release/1.5.0` uses nothing, and neither does a PR titled for another product's tag. A first release's number is set by `firstRelease`, so a used one is refused: set the next free number there. A cut walks past at most 19 used numbers. The release PR check of `record` and `ask`, and the release check ([release-check.md](release-check.md), rule 2), accept the same numbers.
3. **The branch** `release/<version>` is made on the remote at `range.to`, the commit the facts read, not at the tip of anything newer. With `--within <ref>` that commit must be in the history of `<ref>`, which the workflow sets to the commit its own run started from, so only the working branch's history is released; a commit of another branch is refused (exit 1) before anything is made. The cut reads git's copy of the commit and never reads or changes the checkout's working tree: changes in it, and files such as `facts.json` and the artifact, are of no concern to it. Everything that can fail on its own (the section, the notes, the body) is made first, the commit is made by the API, and the branch moves last, so a refusal at any step (a token that may not write the ref included, exit 2) leaves no branch and no artifact.
4. **One commit**, `chore(release): <tag>`, holds the version's CHANGELOG section (`--changelog` names another file, for a repo with a changelog per product), `releases/<tag>/release-notes.md`, written from the prep file's `notes`, and the two files it was cut from, `releases/<tag>/facts.json` and `releases/<tag>/prep.json`, so `shipyard record --from-candidate` reads the same ones each time it runs ([release-record.md](release-record.md)). It ends with the trailers `Release-Level: <level>` (the prep file's `level.bump`) and, when the facts hold breaking signs, `Release-Breaking: <id>, <id>`, which the release check reads ([release-check.md](release-check.md)). With `--work-branch` it also ends with `Release-From: <branch>`, the work branch this cut started from, which `shipyard merge-back` reads after the tag ([release-tag.md](release-tag.md)); `cut.yml` passes the branch its run started on. The folder is named by the tag, prefix included, so two products with the same version never collide. **The commit is made through GitHub's API** (a blob and a tree on the parent's tree, a commit, then the ref), never by a local `git commit` and `git push`, with no author or committer named, so GitHub makes it as the job's own token and signs it: a repo that requires signed commits on its release branch accepts it, and the release PR shows it `verified`. The cut never tags.
5. **The `release-pr` artifact** goes in `--out`. The fleet's release-PR hook reads four of its files, `branch`, `sha`, `title` and `body.md`, and opens the PR from them:

| File | What it holds |
|---|---|
| `branch` | The branch, `release/<version>`: one value, no newline. |
| `sha` | The branch's tip, the cut commit (`commit` in `release-pr.json`): one value, no newline. |
| `title` | The PR's title, `Release <tag>`: one value, no newline. |
| `release-pr.json` | `format`, `repo`, `version`, `tag`, `branch`, `base`, `commit` (the cut commit), `cutFrom` (the commit the facts read), `title`, `bodyFile`, `changelog`, `releaseNotes`, `skipped` (each number the cut passed because it was used, and why: `[{ "version": "1.43.0", "why": "release/1.43.0 exists" }]`, empty when none) and `workBranch` (the `--work-branch` the cut recorded, or `null`). |
| `body.md` | The PR body: a page a person reads in under a minute. First the top, between marker comments: the heading (`## <product> <version>: <headline>`, with `(first release)` after the version for a first release; the product is `product` in `.github/release.json`, else the repo's name as it is), the decision table (`⏳ Not yet: checks still running` until the record runs), **What changes** from the prep file's changes and `internal`, and **Could it break anything?** from `safety`, `risks` and `undo`, with the version to go back to. Then two folds, never one inside another: **What gets published**, a Where \| What table, the CHANGELOG section the GitHub Release publishes and `releases/<tag>/release-notes.md`, each quoted word for word (or "Nothing: this release has no release notes"), then a "When this merges" flow (what the repo's own tag signal sets off: the ship job, `/shipped`, both or the merge alone; a signal it cannot read is said so and no steps follow; then the tag, the GitHub Release, the Shipped comment, the Announce step when the repo calls `announce.yml`, and the merge back into the work branch); and **Evidence**, a place for the record. `shipyard record` writes the top again with its decision and fills in the Evidence fold; the notes for the release manager are a PR comment, never the body ([release-record.md](release-record.md)). |

A cut only ever makes a new branch: it found its number unused, so `release/<version>` does not exist. A branch of that name that appeared on the remote since is refused (exit 1) and nothing is written: cut again, and the next cut passes that number. The branch is made with the API's create, which refuses one that appears in between. Only a re-ship replaces `release/<version>` (below).

## A patch

```
node bin/shipyard facts --repo <owner>/<name> --to <tip of main> --fixes "<sha> <sha> ..." --work-branch develop
#   the prep run reads facts.json and writes prep.json, level patch
node bin/shipyard cut --facts facts.json --prep prep.json --base main --work-branch develop
```

A **patch** ships fixes already merged into the work branch (`develop`, or the repo's own) from the production tag, without the rest of the work branch. Each fix is merged into the work branch first, reviewed there like any PR; the patch names their merge commits. It is started by hand on the work branch, where the newest caller lives, as a re-ship is: `cut.yml` with `patch: true`, `fixes` and `commit` the tip of `main` (or `main-<x.y>`), dispatched on `develop`.

1. **The facts** (`--fixes` with `--work-branch`) run from the newest release tag to the tip of `main`, which often holds nothing new, and list the fix PRs as the range's PRs, each with its `Changelog:` line, issue and review, in a field `patch` (`workBranch`, and each fix's `commit` and `pr`). The breaking signs and `callerNeeds` are read from what the patch ships: the tip with the fixes picked on, worked out in git with no ref moved (the detector runs in a scratch worktree of it, removed after). A fix that is not a commit of the checkout, is already in the tip or shipped as a pick already, is not the merge commit of a merged PR of the repo, or does not apply stops the facts (exit 2), naming it. Without `--fixes` the same range is "nothing to release", as before.
2. **The prep file** is written from those facts like any other, and its level is `patch`: `lint-prep` refuses any other with `patch-not-patch`. `report.urgent` is allowed only on a patch's facts.
3. **The cut** checks, before anything is made, that the run started on the work branch the facts name (a run on `main`, on a tag or on another branch is refused, exit 1), that the commit is the tip of `--base` (as a re-ship's is, in place of `--within`), that no other candidate is open or merged and waiting for its tag, and that each fix passes the re-ship's checks (item 3 of [A re-ship](#a-re-ship)): on the work branch, the merge commit of a merged PR, no file under `.github/workflows/`. A fix that changes the changelog or `releases/<tag>/` is refused too, as the cut writes them. The number is the newest tag plus a patch, past any used number.
4. **The branch** is `release/<version>` at the tip of `main`: the cut commit (the section, the notes, the facts and the prep file, with `Release-Level: patch`, `Release-From: <work branch>` and `Release-Patch: #<PR>, ...`), then each fix picked as a re-ship picks it, in the order given. A pick that does not apply on the tip, with the fixes before it, stops the cut (exit 1), names the fix and writes nothing. The artifact adds `patch` (`fixes`: each commit and PR) to `release-pr.json`.
5. **After the cut**, the release PR into `main` is tested, approved and merged like any release. The tag's merge-back goes to the work branch the cut recorded, which already holds the fixes. A rollback is the same: the revert PR merged into the work branch is the fix.

**The work branch's next release leaves the fixes out.** The picks are new commits, so after the merge-back the originals are in the range from the new tag again. The facts leave out a commit whose verified cherry-pick (its `(cherry picked from commit <sha>)` line, and its change replayed) is in the range start's history, naming it in `shippedAsPicks` (`commit`, `pr`, `pick`), and the start counts it as nothing to start. A re-ship's fixes are left out the same way.

## A re-ship

`shipyard cut --reship <version> [--fixes "<sha> <sha> ..." --work-branch <branch>] [--tag-prefix <prefix>] [--repo <owner>/<name>] [--dir <checkout>] [--out release-pr] [--changelog CHANGELOG.md]`

A version whose release PR merged and whose ship run on the merge failed was never tagged ([release-tag.md](release-tag.md#a-re-ship)). When the ship job itself is broken, running it again runs it as it was at the merge, and `main` takes only release PRs, so the same version is finished by a **re-ship**: a second candidate of that version, cut from the base it merged into. `shipyard start --reship` files its job ([release-start.md](release-start.md#a-re-ship)).

1. **The checkout** is the tip of the base the version merged into (`main` or `main-<x.y>`), with its tags. The cut refuses (exit 1) a commit that is not that tip, read from `origin/<base>` (or the local branch when there is no remote one): a re-ship's commit is not in the working branch's history (the failed ship made no tag, so nothing merged back), so it is checked against the base, not with `--within`. It must hold the version's own files from its first cut: `releases/<tag>/facts.json`, `prep.json` and `release-notes.md`, and its section of the changelog. No facts are made and no prep file is given: the version, its section, its notes and its report are the ones that merged. The cut lints that prep file as the record will, and refuses (exit 1) one this Shipyard cannot read, such as a format 1 file from a version an earlier Shipyard cut: re-ship that version with the last Shipyard release that reads format 1, by pointing the repo's cut and record callers at it for the re-ship (the record lints the prep file too).
2. **The number is the waiting one.** The cut refuses (exit 1) when the tag exists, when a candidate for `release/<version>` is open, when none titled `Release <tag>` has merged, when the checkout does not hold its merge commit, and when no run of a push to the base on that merge commit failed, or any of them still runs. It reads the runs with the job's `actions: read`. Shipyard cannot tell which workflow is a repo's ship job; it needs none to: while the version has no tag, the run that holds the ship and tag jobs did not pass, so a failed run with none still running is the failed ship. When several failed, the newest is named. One case it cannot tell: a ship run that was cancelled beside another workflow that failed reads as a failed ship, so the approver who starts a re-ship checks the run it names first.
3. **The fixes** (`--fixes`, with `--work-branch`, the branch the run started on) are checked before anything is made, each in turn; the first that fails stops the cut (exit 1), names its commit and writes nothing. A fix is a full commit id that is **on the working branch** (an ancestor of `origin/<work branch>`, so it was reviewed there), is **not already in the base's tip**, and is **the merge commit of a merged pull request** of the repo, as GitHub's list of the PRs of a commit says (a squash or merge commit; a commit inside a merged branch is not one). A commit named twice, a short id and a run that started on a tag (no working branch) are refused too. **A fix that changes a file under `.github/workflows/` is refused as well** (exit 1, before anything is made): the cut writes with the job's own token, and GitHub refuses a commit from that token that changes a workflow file, because a job's token cannot be given the `workflows` permission. The message names each such fix, its PR and its files, and the steps a person takes: cut the re-ship with the other fixes, or none; then, on `release/<version>`, run `git cherry-pick -x <sha>` (`-m 1` for a merge commit) and push it. The release record finds that pick by its `(cherry picked from commit <sha>)` line, as it finds a cut's own, and names the fix as it does a PR into the branch. A fix is judged by its change against its first parent, which is what the pick applies; a workflow file moved out of the folder counts.
4. **One commit**, `chore(release): <tag>`, on `release/<version>` made at the checkout's `HEAD`, adds one file, `releases/<tag>/reship-<run id>.json`: the PR it re-ships (`releasePr`), its merge commit, the failed run (`failedRun`: its id, link and the job and step that failed) and the commit the re-ship was cut from. A new file each time, so a ship job that finds its version from the files a merge adds (`git diff --diff-filter=A HEAD^1 HEAD -- releases/`) finds the re-ship, and `shipyard publish` reads it as the release the merge brings. The commit carries the first cut's trailers (`Release-Level`, `Release-Breaking`, `Release-From`), so the release check reads the same level and the merge-back goes to the same work branch, and `Release-Reship: #<PR>`. It is the only commit the cut writes by itself. When fixes are named, the file also lists them (`fixes`: each commit and its PR), and the cut then picks them as `git cherry-pick -x` would, one commit each in the order given, straight after it (`-m 1` for a merge commit), so each keeps its message and its `(cherry picked from commit <sha>)` line. Each pick is worked out in git first (`git merge-tree`, which needs git 2.40, in memory: no branch and no commit of the checkout moves), as the original's change over its own first parent merged into the commit before it, and then made through the API with that tree, so it is signed like the rest; its author is the job's token (the original's author is not carried over), and the original's message is kept. A pick that conflicts stops the cut (exit 1) with nothing written to the remote, and the message names the commit.
5. **The body** is the first cut's, written again from the same files, with the re-ship part first: that it is a re-ship, when the version merged and as which PR, where its ship failed with a link to the run, and what the fix changes: one line for each fix PR, with its `Changelog:` line and its own PR's reviews (`approved by <login>`, or `no approval`), as the page lists any change. With no `--fixes` the fix is not on the branch yet, so that line says so, and `shipyard record` fills it with each PR merged into the candidate since ([release-record.md](release-record.md)). The artifact is the one a cut writes, with `reship` (`releasePr`, `failedRun`, `file`, `fixes`) in `release-pr.json`; its `sha` is the branch's tip, picks included.

**The fix to the ship job comes with the cut, unless it changes a workflow file.** Merge it into the working branch first, as any change, so the fleet reviews it there, then name its merge commit in `fixes` (`cut.yml`'s input, or `--fixes`): the release PR holds the fix with no PR into `release/<version>`, and the page lists it with the reviews it had. A fix that changes a file under `.github/workflows/` (a broken ship job is often just that) cannot go in `fixes`: a person pushes it onto the release branch, as the cut's refusal says. A fix PR into `release/<version>` still works, but the fleet holds a PR whose base is another open PR's branch behind that PR, and the release PR cannot merge before its fix. An internal fix (a workflow) needs no `Changelog:` line in the version's section, and the notes stay as they are. The picks are new commits, so the originals on the working branch are not in the tag's history; the next release's facts leave them out all the same, as for a patch ([A patch](#a-patch)). `cut.yml` runs a re-ship with the input `reship` (and `fixes`) and no prep file. **It is dispatched on the working branch** (`develop`), as every cut is, with `commit` the base's tip. A run started on `main` would run `main`'s caller, which holds the version of Shipyard of its last release and so may have no `reship` input; `main` takes only release PRs, so it could never get one first. A run on the working branch runs the newest caller, and it is the one run the fleet's release-PR hook opens a PR from. The cut checks the commit against the tip of the base, in place of `--within` the commit the run started from.

## The workflows

`workflows/cut.yml` runs `facts`, `lint-prep` and `cut` in order, and uploads the four files as the artifact `release-pr`; a step that fails stops the job, so a prep file made for another range, or one that fails the lint, never reaches the cut, and the cut passes `--within` the commit the run started from (a light cut: the working branch's tip the job fetched). `workflows/record.yml` runs `record` (which makes the evidence commit through the API), fetches that commit into its checkout, and runs `record --update`. Both are published to `turbot/shipyard-workflows` and called by pinned commit: the README says how.

## The version `publish` tags

The cut is the only place a version is written down: the CHANGELOG section and the folder `releases/<tag>/` it commits. `shipyard publish`, which runs when the release PR merges into `main`, reads them from the merge commit and tags the public copy with that version (`v1.5.0`), writing `1.5.0` into the published `package.json`. The repo's own `package.json` has no `version` field, so nothing can disagree with the tag, and nothing sets one by hand.

- A merge brings a release when `releases/<tag>/` is in the merge commit and not in its first parent. The newest CHANGELOG section must name the same version, or `publish` refuses.
- A merge into `main` that brings no release publishes nothing and says why.
- `publish` is the published code of the commit it runs on, so this holds from the next release after the one that carries it. The job checks out two commits so the first parent is there to compare.

The README's "Publishing to turbot/shipyard-workflows" says the rest.

## A light release

`shipyard cut --facts <facts.json>` with facts that say `"profile": "light"` (the facts carry it from the repo's `release.json`) cuts a light release ([How we release](how-we-release.md#light-releases)). It takes no `--prep` and refuses one, and in `cut.yml` it is the input `profile: light`, which skips the prep file and its lint.

- **The version** is the day's: `<year>.<MMDD>.<n>` (`2026.1118.0`; 5 Jan is `105`), counted from the repo's tags, for the UTC day of `--date` (today when left out). A tag from a later day stops the cut.
- **The branch** is `release/<version>` at the facts' commit, with one commit: `releases/<tag>/facts.json`, and the trailer `Release-Profile: light` (and `Release-From`). No prep file, CHANGELOG section or release notes are written. The commit is made through the API, signed like a full release's, and the checkout is never written to; `cut.yml` passes `--within` as the working branch's tip the job fetched (the start reads the tip when it runs, which can be newer than the commit the run was queued at, so the run's own commit would refuse a valid cut after a merge in between).
- **The body** is the light page: the decision table, the merged PRs and the fixed could-it-break line. It is the only document the cut makes.
- **A count a cut used** is passed, as a full cut's patch is (item 2 of `cut`): a candidate of the day that closed, or merged and was never tagged, uses its count, and the cut takes the next one and lists it in `skipped`.
- **Nothing to release** (no merged change in the facts) is refused, as an open candidate for the number is.
