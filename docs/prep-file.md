# The prep file

The prep run reads the facts of a release's range and returns one JSON file: the level, the group of each PR, the release notes and the report's words. `node bin/shipyard lint-prep` checks that file before anything uses it.

The schema is [`lib/prep-schema.json`](../lib/prep-schema.json) (JSON Schema 2020-12). A writer, such as the release-report skill, writes to it. [`examples/prep.json`](examples/prep.json) is a file that passes against [`examples/facts.json`](examples/facts.json).

## The fields

All text fields hold at least one character that is not a space. No field outside this list is allowed.

| Field | What it holds |
|---|---|
| `format` | `3`, the version of this format. A format 1 or format 2 file is refused, with a message that says what to write: format 3 moved `notes.sections` to `notes.items` (each item has a `kind`), made the groups the six labels plus `Internal`, put the title's `v` before the version, raised an item's text to 300 characters and added the optional `notes.reference`. A release cut in format 2 is still read ([below](#how-the-release-pr-shows-it)). |
| `level.bump` | `major`, `minor` or `patch`. |
| `level.reasons` | Why this level: a list of sentences, at least one. The first is the reason that sets the level, as short as it can be: the audit record shows it beside the level. |
| `level.flags` | An answer for each read-first flag in the facts: a list of `{ "flag": "<id>", "answer": "<text>" }`. `flag` is the flag's `id` in the facts; `answer` is what the prep run found and what it means for the level. |
| `groups` | The group of each PR in the range, under the six labels of the release notes or `Internal`: `Before you upgrade`, `Security`, `What's new`, `Improvements`, `Bug fixes`, `Requirements` and `Internal`, each a list of PR numbers. Every PR in the range is in exactly one group. A group with no PRs may be left out. A format 2 group becomes: `Added` is `What's new`, `Changed` is `Improvements` (`What's new` for a new thing a user can do), `Fixed` is `Bug fixes`, `Removed` is `Before you upgrade` when the PR has an `Update-Needs:` line and `What's new` when it has none, and `Security` stays `Security`. A dependency-only PR is `Security` when it fixes a CVE, `Improvements` when a user notices it and `Internal` otherwise. A PR that changes what a user needs in place is `Requirements`. The CHANGELOG section lists each PR's own line under its label, in this order, and leaves `Internal` out. |
| `notes.title` | The title of the release notes: `<Product> v<version> - <the main point>`, with the product's own name (`Example Product`, not `Example Product CLI`), a space, a `v` straight before the version, a space, a hyphen, a space and the main point. A new cut refuses another shape (`title-shape`); whether the number is the release's is the release check's job. The main point is the best thing a user gets from the release ([Writing the release notes](#writing-the-release-notes)). |
| `notes.summary` | One sentence of 140 characters or fewer, in the same voice as the title ([Writing the release notes](#writing-the-release-notes)). |
| `notes.items` | The items of the release notes, the main point first: a list of `{ "kind": "<label>", "name": "<2 to 4 words>", "text": "<the item>", "covers": [<PR numbers>] }`, at least one. The order of the file never sets the order of the labels: the notes walk the six labels in order and keep the items of one label in file order. |
| `notes.items[].kind` | The item's label, exactly one of the six: `Before you upgrade`, `Security`, `What's new`, `Improvements`, `Bug fixes`, `Requirements` (with a plain apostrophe in `What's new`). A note, a warning or a breaking change is `Before you upgrade`; "Enhancements" is `Improvements`; a security fix is `Security`, never `Bug fixes`. |
| `notes.items[].name` | 2 to 4 words: the release notes show it as `- **<name>:** <text>`, and the #releases post as a bullet with the name in italics. Every item of a kind other than `Before you upgrade` has one. An item of that kind needs none, but the #releases post titles its action block with one (2 to 4 words). Only a new cut asks for names: the record and a re-ship read a prep file cut earlier, with no names, as it is. |
| `notes.items[].text` | The item, 300 characters or fewer. Its first sentence stands alone and says what the reader gains ([Writing the release notes](#writing-the-release-notes)), because the #releases post shows an item's name and that first sentence only. The text of a `Before you upgrade` item starts with its condition: `If your repo writes prep files, before its next cut: take who out of each change.` |
| `notes.items[].covers` | The PRs in the range the item is about, at least one. |
| `notes.reference` | Optional. Lists of types for reference (policy types, controls, actions): a list of `{ "title": "<text>", "entries": ["<text>"] }`, at least one. The notes show them after the items, below a `---` line, each as a `### <title>` with one bullet for each entry: never as labels, and the #releases post leaves them out. |
| `notes.reference[].title` | The list's title, 60 characters or fewer, such as `Policy types`. |
| `notes.reference[].entries` | The entries of the list, one line each, at least one. |
| `report.headline` | What the release does, in 8 words or fewer. It ends the page's heading: `## <product> <version>: <headline>`. |
| `report.ask` | The one paragraph of the Slack ask, written as a person asking a colleague to approve would write it. It starts with `This release`, is 15 to 70 words of plain sentences, and says what a person gets and what could go wrong. The tool adds the greeting, the release PR's link, the sentence on the checks and `Thanks!` around it (see [release-ask.md](release-ask.md)), so it holds none of them. Only a new cut needs it: the record, the ask and a re-ship read a prep file cut earlier, with none, as it is; but the ask posts nothing for one without it. An example: `This release lets any report download as a spreadsheet, fixes the dates that showed the wrong day after midnight, and makes the search page load faster. Nothing is removed.` |
| `report.changes` | What changes for users, 5 rows at most: a list of `{ "before": "<text>", "after": "<text>", "label": "<text>", "covers": [<PR numbers>] }`. `before` is what a person saw or had before the release, `after` what they have now, in plain words (the column is headed Now, so it does not start with "Now"), and it reads on its own, because the Now column shows it without its `before`. `label` is the change in 2 to 4 words, such as "the mod page change": the page's Still needed row names it. `covers` lists the PRs in the range the change is about, at least one; a row may cover several. Every PR grouped under any label but `Internal` is in some change's `covers`, unless the list holds 5 rows: the page then counts the rest as "Also N more changes". |
| `report.safety` | Could it break anything? `{ "answer": "<text>", "why": "<text>" }`. `answer` is 4 words or fewer and starts with its answer word (No, Not, Unlikely, Yes, Likely, Possibly, Maybe, Only, Rarely or Hardly); `why` is one line of 25 words or fewer. |
| `report.risks` | What could go wrong, a row each of the page's If \| Then table: a list of `{ "if": "<text>", "then": "<text>", "untested": "<text>" }`. `if` reads as the If cell ("the release fails before the site updates"), `then` what happens or what we do, and `untested` (optional) why that case was not tested. The tool adds the last row, how to go back. |
| `report.undo` | How to go back: `{ "how": "<text>", "howLong": "<text>" }`. `how` is what going back is, in a few words that name no version (the tool names it): "we publish it again". `howLong` is how long it takes, from the repo's real merge-to-live time: "About 20 minutes". |
| `report.internal` | Each change no user sees: a list of `{ "text": "<text>", "covers": [<PR numbers>] }`, each `text` 12 words or fewer. It is there when a PR is grouped `Internal`, and left out when none is. A security fix no user sees may be one too: the page leads with it. |
| `report.managerNotes` | Notes for the person running the release (a paused run to approve, a step to run again): a list of sentences, which may be empty. They are a comment on the release PR, never part of its body. |
| `report.duringDeploy` | Optional. What customers notice while the release goes out, one line of 15 words or fewer: `Each running workspace restarts once, 5 at a time: about 1 minute without queries`. The page shows it as its During the deploy row, only when it is set. Leave it out when customers notice nothing. |
| `report.personSteps` | Optional, 2 at most. Each step after the merge that a named person runs or has agreed to run: a list of `{ "who": "<login>", "step": "<text>", "state": "to do" }`. `who` is the person's GitHub login with no `@`; the page writes their profile name, never an @mention. `shipyard cut` refuses a login GitHub has no name for (a mistyped login, or a person who has set none) and says which; a record written later, if the name has gone, shows the login and warns. `step` is what they do, starting with its verb and reading after their name: `applies the queue settings, the last step`. `state` is `to do` or `agreed`. The page shows each as an A person's step row: `⏳` for a step to do, `✅` for one agreed. |
| `report.urgent` | Optional. `true` only on a patch cut from the production tag to fix something broken now: the page adds ` (urgent fix)` after the version in its heading, `## Example site 1.28.1 (urgent fix): the query editor works again`. The lint refuses `true` on a level that is not `patch`, on a first release, and on facts that are not a patch's (no `patch`). |

## Writing the release notes

The notes lead with what a user gains, and stay factual. Positive means order and emphasis, not euphemism: the title, the summary and the first items lead with the best real gain, and a removal is still called a removal. Make no claim the diff cannot back, and use no hype words (`hype-word`). The examples are Powerpipe v1.7.0, whose best news is that its server reloads when mods change, and which deprecated two run flags. An item is shown as its name, a colon, then its text.

### The title

The main point is the best thing a user gets from this release, in a few words. It is never a removal or deprecation, unless the release is only that (`title-removal`). An action needs no title: `Before you upgrade` is always labelled and shown.

- Good: `Powerpipe v1.7.0 - the server reloads when your mods change`
- Not good: `Powerpipe v1.7.0 - runs no longer install mods` (it leads with a deprecation, while the release's best news is the live reload)

### The summary

One sentence in the same voice as the title: the best gain first, then the rest.

- Good: `Your server picks up mod installs, updates and uninstalls without a restart, and two run flags are deprecated.`
- Not good: `Runs no longer install mods, and the server can reload.` (it leads with what is gone)

### An item's first sentence

It says what the reader gains, in the second person (you, your), with a concrete case. The #releases post shows only that sentence. The mechanism comes after. It never leads with what no longer happens (`item-gain-first`).

- Good: `Live mod reloads: Install, update or uninstall a mod and your running server picks it up, with no restart. It watches the mods in its workspace folder.`
- Not good: `Live mod reloads: The server reloads when mods are installed, updated or uninstalled in its workspace folder.` (it says what the code does, not what the reader gains)

### A removal or deprecation

It is called what it is ("deprecated", "removed"), in its own item of kind `What's new`, with a one-clause reason when that helps and the replacement named. It is never dressed up as a feature, and never the headline. When its PR has an `Update-Needs:` line, the action is a second item, under `Before you upgrade`.

- Good: `Deprecated run flags: --mod-install and --pull on benchmark, control, dashboard and detection runs are deprecated, and ignored with a warning. They never worked reliably: a missing mod failed before the install could help, and --pull updated mods one run late. Use powerpipe mod install or powerpipe mod update instead.`
- Not good: `Safer mod locks: Your runs now leave the mod lock file alone.` (a deprecation dressed up as a feature: it never says the flags are deprecated, or what to use instead)

### Before you upgrade

It stays factual and short, starts with its condition (`step-condition`), and says why the new way is better.

- Good: `Update mods before runs: If you pass --pull to a run command to update mods, run powerpipe mod update before the run instead. It updates them before the run reads them, not one run late.`
- Not good: `Update mods before runs: If you use --pull, note that it is deprecated in this release and that the run commands have changed how they handle mods.` (no replacement, and no reason the new way is better)

## How the release PR shows it

The release PR's body is a page a person reads in under a minute: about 20 rendered lines above two folds. The top, in this order and nothing else:

- the heading, `## <product> <version>: <headline>`, where the product is `product` in the repo's `.github/release.json` (the repo's name as it is, when it has none), a first release adds ` (first release)` after the version, and a report with `urgent: true` adds ` (urgent fix)` after it;
- the decision table, which the tool writes from what it found: its header row is the decision (`❌ No: do not approve`, `⏳ Not yet: checks still running`, `🔁 Approve again: ...`, `✅ Approved: ready to merge` or `✅ Yes`), then the rows Checks, Production setup (when the repo turns the production plan on), During the deploy (when `report.duringDeploy` is set), A person's step (a row for each of `report.personSteps`), Approved by and Still needed;
- **What changes for** the repo's `audience` (`visitors`, `customers` or `repos` in its `.github/release.json`; users when it has none): a Before \| Now table, a row for each change, the kind first (the first of the six labels, in their order, that groups a PR it covers: `Security`, `What's new`, `Bug fixes` and so on), then one line naming the `internal` changes. When no change is one a user sees: **What changes: nothing** they see, then each `internal` change as a bullet, 5 at most;
- **Could it break anything?** with `safety.answer`, then `safety.why`, then an If \| Then table: a row for each of `risks` (an `untested` reason after its If text), and last, how to go back: the version, which the tool names, then `undo.how` and `undo.howLong`.

Then two folds, never one inside another: **What gets published**, a table of where each text goes and each text word for word (the GitHub Release's text, the CHANGELOG section, and the release notes), and **Evidence**, with a table of who asked for, made and reviewed each change, a table of the checks, a table of the facts of the release and what happens on merge. `managerNotes` are a comment on the PR.

Above the folds, the manager's fields (`headline`, `ask`, each change's `before`, `after` and `label`, `safety`, `risks`, `undo` and each `internal` text) hold none of the words for how Shipyard runs a release: ship, hold, level, major, minor, patch, drove, independent, second approver, record, prep, facts, cut, ship job, tag, merge back, digest, job, run, workflow, step, artifact, input, pin, evidence, not judged, made or asked for and today. Nor a PR number, a commit, a file path, a config key or code in backticks, or an HTML code such as `&#35;`. Say what happens in plain words instead. The public release notes are exempt: their readers are the product's users.

**A public repo's texts are public.** When the facts say the repo is public, `lint-prep` holds every text the release PR, the prep job's comment and the Slack ask show to the release notes' two rules: no internal term from the facts' `internalTerms` and no link to a private repo or an internal page. That is each field of `report` above the folds (the headline, `ask`, each change, `safety`, `risks`, `undo`, `internal`, `duringDeploy`, each person's step), `report.managerNotes`, `level.reasons` and each `level.flags[].answer`. A private repo's texts are not held to it. A problem names the field (`internal-term` or `private-link`) and never the text it matched. No text in the prep, in any repo, names a security advisory that is not yet published or a security problem not yet fixed, `managerNotes` included: the lint cannot tell, so the writer must.

A prep file written now is format 3: format 1 and format 2 files are refused (`format-1`, `format-2`), and the release manager writes the prep for the version the repo pins. The cut and the record of one release write the body together, so a repo updates both at once. A release cut in format 2 is still read: its stored prep is turned into format 3 in memory when the record, the ask or a re-ship reads it (`Added` is `What's new`, `Changed` is `Improvements`, `Fixed` is `Bug fixes`, `Removed` is `What's new`, and each section's items take a kind from its heading), and the notes text it stored is shown as it is, never written again. A reader of that text takes the old `## Fixes` headings and the new labels alike.

A short file:

```json
{
  "format": 3,
  "level": {
    "bump": "patch",
    "reasons": ["Only a fix."],
    "flags": []
  },
  "groups": { "Bug fixes": [103] },
  "notes": {
    "title": "Example Product v1.4.3 - dates past midnight show correctly",
    "summary": "Your run dates now show correctly across midnight.",
    "items": [
      { "kind": "Bug fixes", "name": "Midnight runs fixed", "text": "Your runs that cross midnight show the day they started.", "covers": [103] }
    ]
  },
  "report": {
    "headline": "dates past midnight show correctly",
    "ask": "This release fixes the dates that showed the wrong day for runs that cross midnight. Only the date shown changes, and nothing stored does.",
    "changes": [{
      "before": "A late night showed the day it ended.",
      "after": "It shows the day it started.",
      "label": "the midnight date fix",
      "covers": [103]
    }],
    "safety": { "answer": "No", "why": "Only the date shown changes; no stored data does." },
    "risks": [{ "if": "a date still looks wrong", "then": "Only the date shown is wrong; nothing is lost" }],
    "undo": { "how": "update back to it", "howLong": "a few minutes" },
    "managerNotes": []
  }
}
```

## Labels and the display rule

Each item carries its `kind`, one of the six labels. The release notes show the items by that rule:

- When every item has the same kind, and that kind is neither `Before you upgrade` nor `Security`, the notes show **no label**: the bullets alone.
- `Before you upgrade` and `Security` are **always labelled**.
- In every other case, each label that has items shows as a `## <label>` line, in this order: `Before you upgrade`, `Security`, `What's new`, `Improvements`, `Bug fixes`, `Requirements`. A label with no items does not show.

So a writer never writes an empty or out-of-order label: the order of `items` in the file sets only the order inside one label. The CHANGELOG section follows the same rule at `### <label>`. The optional `notes.reference` comes last, under a `---` line, and never counts as an item. Each example below is a `notes` object, then the text the release notes show for it; a test renders each with the real code and compares.

#### Example: one kind, no labels

Every item is `Bug fixes`, so the notes show the bullets and no label.

```json
{
  "title": "Example Product v1.4.3 - dates past midnight show correctly",
  "summary": "Your run dates now show correctly across midnight, and two other bugs are fixed.",
  "items": [
    { "kind": "Bug fixes", "name": "Midnight runs fixed", "text": "Your runs that cross midnight show the day they started. Before, they showed the day they ended.", "covers": [103] },
    { "kind": "Bug fixes", "name": "Search page crash", "text": "Your searches with a quote mark in them now return results. Before, the search page stopped.", "covers": [104] },
    { "kind": "Bug fixes", "name": "Export file names", "text": "An exported report keeps the name you gave it.", "covers": [105] }
  ]
}
```

```markdown
# Example Product v1.4.3 - dates past midnight show correctly

Your run dates now show correctly across midnight, and two other bugs are fixed.

- **Midnight runs fixed:** Your runs that cross midnight show the day they started. Before, they showed the day they ended.
- **Search page crash:** Your searches with a quote mark in them now return results. Before, the search page stopped.
- **Export file names:** An exported report keeps the name you gave it.
```

#### Example: a Security item is always labelled

One item, and it is `Security`: the label shows although every item has the same kind.

```json
{
  "title": "Example Product v1.4.4 - a session leak is closed",
  "summary": "A fix keeps your session tokens out of the debug logs.",
  "items": [
    { "kind": "Security", "name": "Session tokens stay private", "text": "Your session tokens stay out of the debug logs. If you turned debug logs on before this release, delete the old ones.", "covers": [201] }
  ]
}
```

```markdown
# Example Product v1.4.4 - a session leak is closed

A fix keeps your session tokens out of the debug logs.

## Security

- **Session tokens stay private:** Your session tokens stay out of the debug logs. If you turned debug logs on before this release, delete the old ones.
```

#### Example: mixed kinds, every label in order

Five kinds, written out of order in the file. The notes show the labels in the fixed order, each with its items, then the `reference` block under a rule. The #releases post shows the `Before you upgrade` item as its action block and each other item's name and first sentence; it shows no labels and no reference lists. The removed option has its own item under `What's new`, and the step it asks for is under `Before you upgrade`.

```json
{
  "title": "Example Product v1.5.0 - reports download as spreadsheets",
  "summary": "You can download any report as a spreadsheet, the search page loads faster and a date bug is fixed.",
  "items": [
    { "kind": "Bug fixes", "name": "Midnight runs fixed", "text": "Your runs that cross midnight show the day they started.", "covers": [103] },
    { "kind": "Requirements", "name": "Newer runtime needed", "text": "You need version 20 of the runtime or newer to run Example Product.", "covers": [112] },
    { "kind": "Improvements", "name": "Faster search page", "text": "Your search page opens twice as fast on large projects. Nothing changes in how it looks.", "covers": [110] },
    { "kind": "Before you upgrade", "name": "Rename the export option", "text": "If a script of yours calls the export with --csv, use --format csv instead. One option now names every format.", "covers": [108] },
    { "kind": "What's new", "name": "CSV option removed", "text": "The export's --csv option is removed. Use --format csv, which does the same.", "covers": [108] },
    { "kind": "What's new", "name": "Spreadsheet downloads", "text": "You can download any report as a spreadsheet from its page.", "covers": [101] }
  ],
  "reference": [
    { "title": "Report types", "entries": ["Monthly summary", "Run history", "Search usage"] },
    { "title": "Export formats", "entries": ["CSV", "Spreadsheet"] }
  ]
}
```

```markdown
# Example Product v1.5.0 - reports download as spreadsheets

You can download any report as a spreadsheet, the search page loads faster and a date bug is fixed.

## Before you upgrade

- **Rename the export option:** If a script of yours calls the export with --csv, use --format csv instead. One option now names every format.

## What's new

- **CSV option removed:** The export's --csv option is removed. Use --format csv, which does the same.
- **Spreadsheet downloads:** You can download any report as a spreadsheet from its page.

## Improvements

- **Faster search page:** Your search page opens twice as fast on large projects. Nothing changes in how it looks.

## Bug fixes

- **Midnight runs fixed:** Your runs that cross midnight show the day they started.

## Requirements

- **Newer runtime needed:** You need version 20 of the runtime or newer to run Example Product.

---

### Report types

- Monthly summary
- Run history
- Search usage

### Export formats

- CSV
- Spreadsheet
```

## What callers must give

A release of Shipyard cannot make a published workflow need more from its callers without a new major version, unless the release manager has checked every caller and the prep file says so. Once every repo calls the floating major tag (`@v0`), a minor or patch release that needs more would break the runs of any caller that does not grant it at the moment the tag moves. GitHub checks every job of a called workflow against what the caller grants, a skipped job too, so one new job that asks for `pull-requests: write` fails each caller that grants `read`.

**The contract file.** `workflows/contract.json` records, for each published workflow, the permissions each job asks for, the inputs it requires (`required: true` with no default) and the secrets it requires. It is published with the workflows and made from `workflows/*.yml` alone: `node bin/shipyard contract` writes it, and `node bin/shipyard contract --check` exits 1 when the committed file differs. A test runs the same check, so a PR that changes what callers must give always shows it as a diff of this file.

**The release check.** `shipyard facts` reads the workflows as the range's first commit and its last hold them, lists in `callerNeeds` what rose, and raises a read-first flag for each raise:

- a job's permission rises from none to read or write, or from read to write, past the most any job of that workflow asked before (a caller grants a permission to the whole workflow, so a new job asking for what another job already needed raises nothing);
- a workflow requires an input or a secret it did not require before.

The flag's id is `caller-needs-<workflow>-<kind>-<name>`, with the job after the kind for a permission (`caller-needs-record.yml-permission-record-contents`). It is answered in `level.flags` like any other, and **the answer must name every caller checked and what each grants**: an org code search for the workflow at the floating tag (`@v0`), each repo it found, and for each, that it grants the permission (or passes the input or secret). A caller the search found and the answer leaves out, or a caller that does not grant it, means the answer is not true and the level is `major`.

`lint-prep` (and so the cut, which runs the same lint) refuses a prep file whose `level.bump` is `minor` or `patch` while a raise's flag has no answer, with `caller-needs-raised`. The refusal names the workflow, the job and what rose. With the flag answered, a `minor` or `patch` passes. A `major` level passes with no answer. Below 1.0 that is a new line, 0.x to 1.0.0, not a minor: the rule that a breaking change is a minor in version 0.x does not cover this. Lowering a need, adding an optional input or secret, adding a new workflow, and removing a workflow raise nothing, and have no flag. A first release raises nothing either, as its range starts at an old tag.

**How to add a feature without a major.** Put a job that needs more in a new published workflow that callers add when they want it, instead of a new job in one they already call. That keeps `@v0` working for every repo that does not opt in.

## What the lint reads from the facts

`facts.json` comes from `shipyard facts` ([docs/release-cut.md](release-cut.md)), which checks that the checkout has GitHub's newest release tag before it starts the range, so the range never starts one release too early. It holds more than this; the lint reads only these fields, and stops with exit 2 when one is missing or the wrong type.

| Field | What it holds |
|---|---|
| `repo.name` | The product repo, `<owner>/<name>`. |
| `repo.private` | `true` or `false`. A link into the product repo is private when the repo is. |
| `prs[].number` | Each PR in the range. |
| `flags[].id` | Each read-first flag. A raised caller need has one, `caller-needs-<workflow>-<kind>-<name>` (see [What callers must give](#what-callers-must-give)). |
| `product` | Optional. The product's display name, `product` in its `.github/release.json`. |
| `audience` | Optional. Whom the release is for, `audience` in its `.github/release.json`: `visitors`, `customers` or `repos`. The page's What changes heading names them. |
| `profile` | Optional. `light` when its `.github/release.json` says `"profile": "light"` ([Light releases](how-we-release.md#light-releases)): the release has no prep file, and the facts are all its page and its GitHub Release are made from. Absent for a full release. |
| `patch` | Optional. Only a patch's facts have it (`shipyard facts --fixes`, [release-cut.md](release-cut.md#a-patch)): the range runs from the production tag to the tip of its branch, and `prs` are the fixes, already merged into the work branch, that the cut picks onto it. The level is `patch`. |
| `patch.workBranch` | The work branch the fixes merged into, where the patch was started (`develop`). |
| `patch.fixes[].commit`, `patch.fixes[].pr` | Each fix: its merge commit on the work branch and its PR, in the order the cut picks them. |
| `shippedAsPicks` | Optional. Commits in the range that the newest release already shipped as cherry-picks (a patch's or a re-ship's fixes), left out of `prs`: each `commit`, its `pr` and the `pick`. Nothing to write about. |
| `couldItBreak` | Optional, only with `profile`. `light.couldItBreak` of the same file: the one line a light release's page answers "Could it break anything?" with. |
| `askSecondApprover` | Optional. `true` when its `.github/release.json` asks for a second approver of each change: the page's Still needed row then names one. Off by default. |
| `callerNeeds` | Optional. Only a repo that publishes workflows with a contract (`workflows/contract.json`) has it: what its workflows ask of callers now that they did not at the range's start (see [What callers must give](#what-callers-must-give)). A list that may be empty. |
| `callerNeeds[].workflow` | The workflow file, such as `release-start.yml`. |
| `callerNeeds[].kind` | `permission`, `input` or `secret`. |
| `callerNeeds[].name` | The permission, the input or the secret. |
| `callerNeeds[].job` | For a permission, the job that asks for it. |
| `callerNeeds[].from`, `callerNeeds[].to` | For a permission, the most the workflow asked for before (`none`, `read` or `write`) and what it asks for now (`read` or `write`). |
| `internalTerms` | The repo's internal terms (`notes.internalTerms` in its `.github/release.json`), a list that may be empty. |
| `publicRepos` | Optional. Other repos the release notes may link to, `<owner>/<name>`. |
| `privateHosts` | Optional. More hosts whose pages count as private, such as `wiki.example.com`. |

## What the lint refuses

`node bin/shipyard lint-prep <prep.json> --facts <facts.json>` refuses the file (exit 1) and prints each problem, with where it is and its rule, when:

- the file is not valid JSON (`json`), or breaks the schema (`schema`): a missing or unknown field, a level that is not `major`, `minor` or `patch`, a summary over 140 characters, a PR listed twice in one group;
- a PR in the range is in no group (`pr-in-no-group`), or in two (`pr-in-two-groups`);
- a PR that ships something (`shipsNothing` is not `true`) has no single valid Changelog line in the facts, in any group, `Internal` too (`pr-no-changelog-line`). The cut refuses it the same way, as it never writes a line. The fix is on the PR (give it one line) and the facts are made again: answering its `no-changelog-line-<n>` flag does not clear it;
- a group holds a PR that is not in the range (`group-not-in-range`);
- the facts' `callerNeeds` is not empty, `level.bump` is `minor` or `patch` and a raise's flag has no answer (`caller-needs-raised`): the problem names the workflow, the job and what rose. A `major` passes with no answer, below 1.0 too (see [What callers must give](#what-callers-must-give));
- a flag in the facts has no answer (`flag-unanswered`), an answer names a flag the facts do not raise (`flag-not-in-facts`), or a flag is answered twice (`flag-answered-twice`);
- the file is format 1 (`format-1`) or format 2 (`format-2`), refused alone with a message that says what format 3 holds and, for format 2, what moved (`notes.sections` to `notes.items`, the groups to the six labels plus `Internal`, the title's `v`, 300 characters, `notes.reference`);
- a `covers` entry, of a release-notes item or a report change, is not a PR in the range (`covers-not-in-range`);
- a PR a user can see (any label but `Internal`) is in no change's `covers` (`pr-no-change`);
- `internal` is missing when a PR is grouped `Internal` (`internal-missing`), there when none is (`internal-unneeded`), or one of its texts is over 12 words (`internal-too-long`);
- a new cut's `report.ask` is missing (`ask-missing`, which shows an example), does not start with "This release" (`ask-start`) or is not 15 to 70 words (`ask-length`); its words are checked above the folds like the rest, but do not count in the report's 300;
- `report.duringDeploy` is over 15 words (`during-deploy-too-long`); `report.urgent` is `true` on a level that is not `patch` (`urgent-not-patch`), on a first release (`urgent-first-release`) or on facts that are not a patch's, with no `patch` (`urgent-not-from-production`): an urgent fix is a patch cut from the production tag, whichever branch its run started on, so the prep run, the lint and the cut all read the rule from the facts. `lint-prep` still takes `--work-branch <branch>`, which no longer changes it; a patch's `level.bump` is not `patch` (`patch-not-patch`). A person step's `step` text is held to the plain-words rules (no PR number, commit, file path, config key or HTML code, no internal term) but not to the banned words: a step after the merge is a step;
- the headline is over 8 words (`headline-too-long`); `safety.answer` does not start with its answer word (`safety-no-answer`) or is over 4 words (`safety-answer-too-long`); `safety.why` is over 25 words (`safety-why-too-long`); a change's `label` is not 2 to 4 words (`label-length`);
- a field above the folds (above) holds one of the banned words, or an internal term from the facts' `internalTerms`, matched as a whole word in any case (`approver-term`); or a PR number (`pr-number`), a commit (`commit`), a file path (`file-path`), a config key or code (`config-key`) or an HTML code (`html-code`);
- a change has a `who` field, which an earlier format 2 allowed (`who-removed`): the Now cell holds `after` alone, so take `who` out. A prep an earlier Shipyard already cut is read again as it is, its `who` ignored;
- the top of the page, rendered as the cut writes it with every row the record can add, has over 25 lines (`top-too-long`), a paragraph or a bullet over 25 words (`paragraph-too-long`), or a table cell over 15 words (`cell-too-long`). What is counted is what the page renders: a Now cell holds `after`, and the undo row the version the tool names. A blank line and a table's alignment row are not lines;
- an item of kind `Before you upgrade` has a `text` that does not start with `If`, `When`, `Before`, `Once` or `Only`, in any case (`step-condition`): the #releases post shows it as "Action needed" and it says who must act and when. A prep cut earlier is read as it is;
- a new cut's `notes.title` is not `<Product> v<version> - <the main point>`, with the product's own name from the facts (`title-shape`): a missing `v`, the product's name changed or a missing main point. The number itself is the release check's job;
- a new cut's `notes.title` has a main point that leads with a removal or deprecation (`no longer`, `removed`, `removes`, `removal`, `deprecated`, `deprecates`, `deprecation`, `drops`, `dropped`) while at least one item is news (`title-removal`): the title is the best thing a user gets from the release, and the removal has its own item. A release that is only removals, with its action under `Before you upgrade`, keeps a removal title. A prep cut earlier is read as it is;
- a new cut's item, other than `Before you upgrade` and other than a removal or deprecation item, whose first sentence has no word addressed to the reader (`you`, `your`, `yours`, `yourself`, `yourselves`, `you're`, `you'll`, `you've`, `you'd`) or leads with `no longer` (`item-gain-first`): the #releases post shows only the first sentence, so it says what the reader gains, to them, and the mechanism comes after. A prep cut earlier is read as it is;
- a new cut's notes title, summary, item name or item text that holds a word that sells instead of telling, such as `amazing`, `seamless`, `blazing` or `game-changing` (`hype-word`): the notes stay factual, and a fact can be "faster". A prep cut earlier is read as it is;
- an item's `kind` is not one of the six labels, or `notes.items` is empty (`schema`);
- an item of the release notes of a kind other than `Before you upgrade` has no `name` (`item-name-missing`), a `name` of fewer than 2 or more than 4 words (`item-name-length`), or a `text` over 300 characters (`item-text-too-long`);
- the release notes (title, summary, an item's name or text, a reference title or an entry) hold:
  - an internal term from the facts' `internalTerms`, matched as a whole word in any case (`internal-term`);
  - a private link (`private-link`), with any scheme (`https://`, `ftp://`, `file://`) or none: a GitHub link (an `api.github.com/repos/…` link, a `git@github.com:<owner>/<repo>.git` remote, or a `<owner>/<repo>#12` or `<owner>/<repo>@<sha>` reference, which GitHub turns into a link) into a repo that is neither the product repo when it is public nor one of `publicRepos` (GitHub's own pages such as `github.com/features` are fine); a GitHub attachment or a gist; a link to an IP address, a host with no dot (`http://buildbox/`), or a `localhost`, `.local`, `.internal`, `.intranet`, `.corp` or `.lan` host; a link to Slack, claude.ai, Google Docs or Drive, Notion, Linear, Atlassian or Figma; a link to one of `privateHosts`; or a link with a user name or password in it. With no scheme, an IP address or `localhost` counts only with a port or a path, so a version such as `1.2.3.4` is fine;
  - a file path or a file's name (`file-path`; not checked in the `reference` lists, where a type's name can look like a path), with or without a line number, a line anchor or a query: `lib/prep.js`, `src/main.rs:42`, `src/main.rs#L42-L50`, `./run.sh`, `~/.config`, `$HOME/.config`, `%APPDATA%\example`, `/etc/hosts`, `.github/workflows`, `C:\tools`, `C:/tools`, a lowercase path of three parts or more, or ending in `/`, that starts in a source folder (`pkg/`, `internal/`, `cmd/`, `src/`, `lib/`, `vendor/`, `node_modules/`, `dist/` or `usr/`, as in `pkg/query/execute` or `internal/auth/`; prose such as `internal/external`, `build/deploy`, `Linux/macOS/Windows` or `11/13/2026` is fine), or a name such as `server.go`, `config.yml` or `.gitignore` (a product's name such as `Node.js`, and a kind of file such as `.json` or `.env`, is fine; a link's address is checked as a link, not a path);
- the report is over 300 words (`report-too-long`). Every word of `report` counts but the ask's own paragraph (`report.ask`, 15 to 70 words of its own): the headline, each change with its before, after and label, the safety answer and why, each risk, the undo, each internal change and each note for the release manager. The PR numbers in `covers` and the fixed words of the release PR are not words of the report.

A problem names the field, never the text it matched, because the log of a public repo is public. A field outside the format is named by its place in its object (`notes: holds a field outside this format (field 4)`), not by its name, and an answer to an unknown flag does not repeat the flag.

Exit 0: the file passes. Exit 1: it is refused. Exit 2: the lint could not run (a missing file, facts without the fields above, a bad option).

```
$ node bin/shipyard lint-prep docs/examples/prep.json --facts docs/examples/facts.json
Prep file OK: 5 PRs grouped, 2 flags answered, report 135 words.
```

In GitHub Actions (`GITHUB_ACTIONS=true`), each problem is also printed as an `::error` line, so it shows on the run.
