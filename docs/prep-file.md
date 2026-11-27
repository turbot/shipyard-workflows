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
| `notes.title` | The title of the release notes: `<Product> v<version> - <the main point>`, with the product's own name (`Example Product`, not `Example Product CLI`), a space, a `v` straight before the version, a space, a hyphen, a space and the main point. A new cut refuses another shape (`title-shape`). The version is the facts' `versions` entry for `level.bump`, never `range.from` plus the level counted by hand: a number a closed or failed cut used is passed by the next cut, so the title must name the one the cut will make, and a new cut refuses another (`title-version`, naming both numbers). A level with no entry (an open candidate holds the number, as in a prepare-again) or a first release (`firstRelease.version`) is not checked here; the release check reads the number again. The main point is the best thing a user gets from the release ([Writing the release notes](#writing-the-release-notes)). |
| `notes.summary` | One sentence of 140 characters or fewer, in the same voice as the title ([Writing the release notes](#writing-the-release-notes)). |
| `notes.items` | The items of the release notes, the main point first: a list of `{ "kind": "<label>", "name": "<2 to 4 words>", "text": "<the item>", "covers": [<PR numbers>] }`, at least one, except on a release whose every PR is grouped `Internal`: no user sees a change, so it has no item and holds `[]`. Any PR under one of the six labels needs an item, and so does an all-`Internal` release the release check asks notes of: a major level, a breaking sign in the facts, a PR with an `Update-Needs:` line or a title marked breaking (`notes-needed`). `notes.title` is still written, with its shape and version, with a plain main point such as `internal changes only`. The CHANGELOG section then says the release changes only internal code, and the release makes no page and no #releases post. The order of the file never sets the order of the labels: the notes walk the six labels in order and keep the items of one label in file order. |
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

The notes lead with what a user gains, and stay factual. Positive means order and emphasis, not euphemism: the title, the summary and the first items lead with the best real gain, and a removal is still called a removal. Make no claim the diff cannot back, and use no hype words (`hype-word`). The examples are Powerpipe v1.7.0, whose best news is that its server reloads when mods change, and which deprecated two run flags. The three rules at the end of the guide on code, on what a user notices and on security items use Steampipe v2.5.3, Tailpipe v0.9.0 and Powerpipe v1.9.0. An item is shown as its name, a colon, then its text.

### The title

The main point is the best thing a user gets from this release, in a few words. It is never a removal or deprecation, unless the release is only that (`title-removal`). An action needs no title: `Before you upgrade` is always labelled and shown.

- Good: `Powerpipe v1.7.0 - the server reloads when your mods change`
- Not good: `Powerpipe v1.7.0 - runs no longer install mods` (it leads with a deprecation, while the release's best news is the live reload)

### The summary

One sentence in the same voice as the title: the best gain first, then the rest.

- Good: `Your server picks up mod installs, updates and uninstalls without a restart, and two run flags are deprecated.`
- Not good: `Runs no longer install mods, and the server can reload.` (it leads with what is gone)

### An item's first sentence

It says what the user gains, with a concrete case, in whatever voice reads best: it need not use the word "you". The #releases post shows only that sentence. The mechanism comes after. It never leads with what no longer happens (`item-gain-first`).

- Good: `Failed saves show as failed: A connection whose state could not be saved now shows as failed, with an error that names it. Before, it showed as up to date.`
- Not good: `Failed state saves: You see a connection as failed, with an error naming it, when Steampipe cannot save its state, in place of seeing it as up to date.` (a forced "you" turns a plain fix into a sentence a reader has to read twice)

### A removal or deprecation

It is called what it is ("deprecated", "removed"), in its own item of kind `What's new`, with a one-clause reason when that helps and the replacement named. It is never dressed up as a feature, and never the headline. When its PR has an `Update-Needs:` line, the action is a second item, under `Before you upgrade`.

- Good: ``Deprecated run flags: `--mod-install` and `--pull` on the run commands are deprecated, and ignored with a warning. They never worked reliably: a missing mod failed before the install could help, and `--pull` updated mods one run late. Use `powerpipe mod install` or `powerpipe mod update` instead.``
- Not good: `Safer mod locks: Your runs now leave the mod lock file alone.` (a deprecation dressed up as a feature: it never says the flags are deprecated, or what to use instead)

### Before you upgrade

It stays factual and short, starts with its condition (`step-condition`), and says why the new way is better. It is the short lead: the notes put each covered PR's own `Update-Needs:` line under it, word for word, so the item need not restate that line ([Labels and the display rule](#labels-and-the-display-rule)).

- Good: ``Update mods before runs: If you pass `--pull` to a run command to update mods, run `powerpipe mod update` before the run instead. It updates them before the run reads them, not one run late.``
- Not good: ``Update mods before runs: If you use `--pull`, note that it is deprecated in this release and that the run commands have changed how they handle mods.`` (no replacement, and no reason the new way is better)

### A change that refuses what worked before

A change that now refuses an input, a config or a flag that worked in the last release gets a `Before you upgrade` item, whatever its group. So does a risk of that shape, where something that worked is now refused. The PR keeps its own group (`Improvements`, `Security` and so on) and still gets its own item; the step is a second item covering the same PR, as a removal's action is. A person who runs the old way should read about it before the upgrade, never find it out when it fails.

- Good: a PR that tightens how a config key is read is grouped `Improvements`, with its own item, and a second item under `Before you upgrade`: `Mod paths: If your config sets mod_path with a slash at the end, remove the slash before you upgrade. The new version refuses it and stops at startup.`
- Not good: the same PR as one `Improvements` item, `Stricter mod_path: The server now checks mod_path more carefully.` (a config that worked is now refused, and no step says so, so a person finds out when the server stops)

### A step names the exact change

A `Before you upgrade` item names the exact change to make, in the words of the input itself: the character, setting or value to add, remove or write, and where. A step that only says to check or fix something leaves the reader to find out what to do.

- Good: `If your config sets base_url, add a slash at the end before you upgrade. The new version refuses one without it.`
- Not good: `Check your base_url: If your config sets base_url, fix it before you upgrade. The new version can refuse it.` (no change named, so the reader cannot act)

### A dependency bump

A bump PR's own text is often cut short, and a version change shows nothing of what the dependency now does. The writer reads the dependency's release notes for each version the bump crosses, and judges each change against what a user of the product can hit. A change that refuses an input, a config or a flag that worked before gets a `Before you upgrade` item, as above, though the bump itself is grouped `Internal`, `Security` or `Improvements`. When the product hands the dependency an input it parses (a URL, a path, a config value), each refusal the dependency's notes give for a form of that input is a candidate for the product's own input, whether or not the PR's text names it, unless the product's code or docs show no user can reach it. The writer's final message says which release notes were read.

### A file a user edits

Name a file or folder a user writes or edits, in a code span, because a reader searches the notes for the name they know. The lint refuses a path into the product's source (`lib/prep.js`, `pkg/query/execute`, `src/main.rs:42`), never `pg_hba.conf`.

- Good: ``Rules in `pg_hba.conf.d/` now load after the ones in `pg_hba.conf`.``
- Not good: `Your own database access rules now load in a new order.` (the reader who wrote those rules cannot tell which they are)

### What a user types is in code

A command, a flag, an environment variable, a value or a message that a user types or sees is in a code span (between backticks), wherever the notes name it: in the title, the summary, an item's name and an item's text. A reader cannot copy what they cannot pick out, and a sentence's full stop sticks to a flag. The lint refuses a `--flag` or an `ENV_VARIABLE` outside a code span (`code-span-missing`); a command, a value or a message is the writer's to judge. A message a user sees goes in a code span too, inside a sentence of its own: never a fragment such as "in place of plugin not installed". The #releases post shows a code span as code, with no backtick left.

- Good: ``Stop the service at once: `steampipe service stop --force` stops the service even while queries run. Set `--query-timeout` to cap one query, and `STEAMPIPE_MAX_PARALLEL` to cap how many run at once.``
- Not good: `Stop the service at once: steampipe service stop --force stops the service even while queries run. Set --query-timeout to cap one query, and STEAMPIPE_MAX_PARALLEL to cap how many run at once.` (Steampipe v2.5.3 showed its flags and variables as plain text: a reader cannot pick out what to type, and a full stop follows each name)

### Only what a user notices

An item is a change a user sees: something they can now do, something that works differently, something they must do. A change no user sees is grouped `Internal`, named once in the report's `internal` list, and left out of the notes: a library update with nothing the user uses changed, a leak that was freed, a test or a build step. Ask of each item: what would a user do differently, or see? When the answer is nothing, it is no item. The lint refuses an item that says nothing changes for a user (`item-unseen`); an item about an unseen change that does not say so is the writer's to leave out. A dependency bump is an item only when a user notices it, or when it fixes a CVE ([A dependency bump](#a-dependency-bump)).

- Good: no item. The Go library update is grouped `Internal`, and the report's `internal` list says `A library was updated`.
- Not good: `Updated Go libraries: Go libraries are updated. Nothing you use changes.` (Tailpipe v0.9.0 shipped this: an item that says itself that no user notices it is no item. Steampipe v2.5.3's `Query timeouts freed` was the same kind of leak no user sees)

### A security item says what was at risk

A `Security` item says, after what the user gains, what was exposed, in which versions, and what to do about it: whether anything already written (a log, a file, a token) may hold what leaked, and whether to change or delete it. It never says how to exploit the problem, and it names no advisory before it is published; once it is published, the item links it once. "Fixed" or "stays put" alone leaves a user unable to judge whether to act.

- Good: ``Errors keep passwords out of logs: Error messages leave out a connection's password. Before 2.5.3 a failed connection could write it to the log, so if you kept or shared those logs, delete them and change that password.``
- Not good: `Errors hide passwords: Errors no longer show passwords.` (Steampipe v2.5.3: it does not say whether old logs may hold a password, in which versions, or what to do. Powerpipe v1.9.0's `Dependencies stay put` had the same gap: it never said what could happen before)

### An absolute claim

A claim built on an absolute word ("every", "never", "always", "any", "can no longer", "exactly as") is written only when a PR's `Changelog:` or `Update-Needs:` line, or its diff, makes it. When none does, say what the PR does, with its limit.

- Good: `Your server skips a report that has no title. It still opens one whose title is blank.` (the diff checks only for a missing title, and the item says so)
- Not good: `Your server never opens an untitled report.` (the diff does not make "never": a blank title still opens, so the claim is false for that case)

## How the release PR shows it

The release PR's body is a page a person reads in under a minute: about 20 rendered lines above two folds. The top, in this order and nothing else:

- the heading, `## <product> <version>: <headline>`, where the product is `product` in the repo's config, `.github/shipyard.yml` or `.github/release.json` until it moves (the repo's name as it is, when it has none), a first release adds ` (first release)` after the version, and a report with `urgent: true` adds ` (urgent fix)` after it;
- the decision table, which the tool writes from what it found: its header row is the decision (`❌ No: do not approve`, `⏳ Not yet: checks still running`, `🔁 Approve again: ...`, `✅ Approved: ready to merge` or `✅ Yes`), then the rows Checks, Production setup (when the repo turns the production plan on), During the deploy (when `report.duringDeploy` is set), A person's step (a row for each of `report.personSteps`), Approved by and Still needed;
- **What changes for** the repo's `audience` (`visitors`, `customers` or `repos` in its config; users when it has none): a Before \| Now table, a row for each change, the kind first (the first of the six labels, in their order, that groups a PR it covers: `Security`, `What's new`, `Bug fixes` and so on), then one line naming the `internal` changes. When no change is one a user sees: **What changes: nothing** they see, then each `internal` change as a bullet, 5 at most;
- **Could it break anything?** with `safety.answer`, then `safety.why`, then an If \| Then table: a row for each of `risks` (an `untested` reason after its If text), and last, how to go back: the version, which the tool names, then `undo.how` and `undo.howLong`.

Then two folds, never one inside another: **What gets published**, a table of where each text goes and the text word for word (the release notes, which are the GitHub Release's text and the page's, or the CHANGELOG section for a release with no release notes), and **Evidence**, with a table of who asked for, made and reviewed each change, a table of the checks, a table of the facts of the release and what happens on merge. `managerNotes` are a comment on the PR.

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

So a writer never writes an empty or out-of-order label: the order of `items` in the file sets only the order inside one label. The CHANGELOG section follows the same rule at `### <label>`. A `Before you upgrade` item is followed by each PR it covers whose facts hold an `Update-Needs:` line, in `covers` order, as `  - Update needs: <line>`, word for word, as the CHANGELOG section writes it; the cut adds these lines when it renders the notes, so the item stays the short lead and need not restate the line. In a public repo the cut also ends every item, of any label, with a link to each PR it covers, `([#12](https://github.com/<owner>/<name>/pull/12))`, so a reader can go from the item to the change; a private repo's notes get none. Never write these links in an item's `text`: the cut adds them. A covered PR with no line, and an item of any other label, add no `Update needs:` line, and the #releases post never shows the line (its action block is the item's own name and first sentence). The optional `notes.reference` comes last, under a `---` line, and never counts as an item. Each example below is a `notes` object, then the text the release notes show for it; a test renders each with the real code and compares.

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

#### Example: a step and its PR's own line

A `Before you upgrade` item covers PR #301, whose `Update-Needs:` line is `Move the api_key setting from config.toml into secrets.toml before you start the new version.` The cut renders the line under the item, word for word; the item itself stays the short lead. The PR's line is read from the facts, not from the prep file.

```json
{
  "title": "Example Product v1.6.0 - keys live in their own file",
  "summary": "Your API key now lives in its own file, so a shared config no longer exposes it.",
  "items": [
    { "kind": "Before you upgrade", "name": "Move the API key", "text": "If your config.toml sets api_key, move it to secrets.toml. The new version no longer reads it from config.toml.", "covers": [301] },
    { "kind": "Improvements", "name": "Keys in their own file", "text": "Your API key stays out of the config you share. Nothing else about the config changes.", "covers": [301] }
  ]
}
```

```markdown
# Example Product v1.6.0 - keys live in their own file

Your API key now lives in its own file, so a shared config no longer exposes it.

## Before you upgrade

- **Move the API key:** If your config.toml sets api_key, move it to secrets.toml. The new version no longer reads it from config.toml.
  - Update needs: Move the api_key setting from config.toml into secrets.toml before you start the new version.

## Improvements

- **Keys in their own file:** Your API key stays out of the config you share. Nothing else about the config changes.
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
    { "kind": "Before you upgrade", "name": "Rename the export option", "text": "If a script of yours calls the export with `--csv`, use `--format csv` instead. One option now names every format.", "covers": [108] },
    { "kind": "What's new", "name": "CSV option removed", "text": "The export's `--csv` option is removed. Use `--format csv`, which does the same.", "covers": [108] },
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

- **Rename the export option:** If a script of yours calls the export with `--csv`, use `--format csv` instead. One option now names every format.

## What's new

- **CSV option removed:** The export's `--csv` option is removed. Use `--format csv`, which does the same.
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

## What a Go library's API sets

A Go library is tagged, not built, so its tag is its publish and the Go proxy serves it. Its level is judged from what other code can import, not only from what the PRs say. `shipyard facts` runs `apidiff` over the library's exported API at the range's start and at the commit that ships, and writes the result as `api` (below). It reads the library as a Linux amd64 build with cgo, the cut's runner, on whatever machine it runs, so the prep run and the cut find the same API. A library with its own cgo files needs a C compiler for Linux amd64 to be read that way, so off Linux amd64 (a Mac, or an arm64 Linux machine) its facts stop with an error that says so: make them on a Linux amd64 machine. The names in it are as a person finds them in the code: the package path inside the module, then the name.

The API sets a floor for `level.bump`, never a ceiling:

- `removed` or `changed` is not empty: at least `major`. Below 1.0.0 (the previous tag's major is 0) it is a `minor`, as the 0.x rule says; a chosen `major` from 0.x is still allowed and makes 1.0.0.
- Only `added` is not empty: at least `minor`.
- All three are empty, or no Go file changed: `patch` is enough.

A level above the floor passes: a repo may call a release a minor for a reason outside its API. The module path must fit the level, by Go's rule: a `major` that makes v2 or later needs the new module path (`/v2`) in `go.mod` already, put there by its own PR first, and a module path that changed between the two commits must be a `major`.

`lint-prep` refuses a lower level with `api-level-low`, naming the removed or changed names (or the added ones for a minor), ten at most and then "and N more", and a path that does not fit with `api-module-path`, naming the paths. The release check applies the same rules to the level the approver ends up with ([release-check.md](release-check.md)). Facts with no `api` are linted as before.

## What the lint reads from the facts

`facts.json` comes from `shipyard facts` ([docs/release-cut.md](release-cut.md)), which checks that the checkout has GitHub's newest release tag before it starts the range, so the range never starts one release too early. It holds more than this; the lint reads only these fields, and stops with exit 2 when one is missing or the wrong type.

| Field | What it holds |
|---|---|
| `repo.name` | The product repo, `<owner>/<name>`. |
| `repo.private` | `true` or `false`. A link into the product repo is private when the repo is. |
| `prs[].number` | Each PR in the range. |
| `flags[].id` | Each read-first flag. A raised caller need has one, `caller-needs-<workflow>-<kind>-<name>` (see [What callers must give](#what-callers-must-give)). |
| `product` | Optional. The product's display name, `product` in its config (`.github/shipyard.yml`, or `.github/release.json` until the repo moves). |
| `audience` | Optional. Whom the release is for, `audience` in its config: `visitors`, `customers` or `repos`. The page's What changes heading names them. |
| `profile` | Optional. `light` when its config says `"profile": "light"` ([Light releases](how-we-release.md#light-releases)): the release has no prep file, and the facts are all its page and its GitHub Release are made from. Absent for a full release. |
| `patch` | Optional. Only a patch's facts have it (`shipyard facts --fixes`, [release-cut.md](release-cut.md#a-patch)): the range runs from the production tag to the tip of its branch, and `prs` are the fixes, already merged into the work branch, that the cut picks onto it. The level is `patch`. |
| `patch.workBranch` | The work branch the fixes merged into, where the patch was started (`develop`). |
| `patch.fixes[].commit`, `patch.fixes[].pr` | Each fix: its merge commit on the work branch and its PR, in the order the cut picks them. |
| `shippedAsPicks` | Optional. Commits in the range that the newest release already shipped as cherry-picks (a patch's or a re-ship's fixes), left out of `prs`: each `commit`, its `pr` and the `pick`. Nothing to write about. |
| `couldItBreak` | Optional, only with `profile`. `light.couldItBreak` of the same file: the one line a light release's page answers "Could it break anything?" with. |
| `askSecondApprover` | Optional. `true` when its `.github/release.json` asks for a second approver of each change: the page's Still needed row then names one. Off by default. |
| `versions.patch`, `versions.minor`, `versions.major` | Optional. The version a cut makes at each level (`shipyard facts`; [release-cut.md](release-cut.md#facts)), past any number a tag, a `release/<version>` branch or a PR titled `Release <tag>` already uses. A level a cut would refuse has none. A new cut's `notes.title` names the entry for `level.bump` (`title-version`). |
| `callerNeeds` | Optional. Only a repo that publishes workflows with a contract (`workflows/contract.json`) has it: what its workflows ask of callers now that they did not at the range's start (see [What callers must give](#what-callers-must-give)). A list that may be empty. |
| `callerNeeds[].workflow` | The workflow file, such as `release-start.yml`. |
| `callerNeeds[].kind` | `permission`, `input` or `secret`. |
| `callerNeeds[].name` | The permission, the input or the secret. |
| `callerNeeds[].job` | For a permission, the job that asks for it. |
| `callerNeeds[].from`, `callerNeeds[].to` | For a permission, the most the workflow asked for before (`none`, `read` or `write`) and what it asks for now (`read` or `write`). |
| `api` | Optional. Only a Go library's facts have it (`kind: go-library`, and not a first release): its exported API at the range's start against the commit that ships, made by `apidiff` ([What a Go library's API sets](#what-a-go-librarys-api-sets)). |
| `api.tool` | The tool that made it, `apidiff`. |
| `api.goFilesChanged` | `false` when no `.go` file other than a test changed in the range: the tool was not run and the three lists are empty, which says nothing in the API could have changed. |
| `api.modulePath.from`, `api.modulePath.to` | The `module` line of `go.mod` at the range's start and at the commit that ships. |
| `api.removed` | Exported names the range removes (`Parse`, `client.Client.Close`), sorted, each once. |
| `api.changed` | Exported names whose signature or type changed incompatibly, or whose method set shrank. |
| `api.added` | Exported names the range adds. |
| `internalTerms` | The repo's internal terms (`notes.internalTerms` in its config), a list that may be empty. |
| `publicRepos` | Optional. Other repos the release notes may link to, `<owner>/<name>`. |
| `privateHosts` | Optional. More hosts whose pages count as private, such as `wiki.example.com`. |

## What the lint refuses

`node bin/shipyard lint-prep <prep.json> --facts <facts.json>` refuses the file (exit 1) and prints each problem, with where it is and its rule, when:

- the file is not valid JSON (`json`), or breaks the schema (`schema`): a missing or unknown field, a level that is not `major`, `minor` or `patch`, a summary over 140 characters, a PR listed twice in one group;
- a PR in the range is in no group (`pr-in-no-group`), or in two (`pr-in-two-groups`);
- a PR that ships something (`shipsNothing` is not `true`) has no single valid Changelog line in the facts, in any group, `Internal` too (`pr-no-changelog-line`). The cut refuses it the same way, as it never writes a line. The fix is on the PR (give it one line) and the facts are made again: answering its `no-changelog-line-<n>` flag does not clear it;
- a group holds a PR that is not in the range (`group-not-in-range`);
- the facts' `callerNeeds` is not empty, `level.bump` is `minor` or `patch` and a raise's flag has no answer (`caller-needs-raised`): the problem names the workflow, the job and what rose. A `major` passes with no answer, below 1.0 too (see [What callers must give](#what-callers-must-give));
- the facts hold an `api` block and `level.bump` is below what it sets (`api-level-low`), or a `major` has no new module path in `go.mod`, or the module path changed at a level other than `major` (`api-module-path`): the problem names the removed, changed or added names, or the paths. The floor is only a floor (see [What a Go library's API sets](#what-a-go-librarys-api-sets));
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
- a new cut's `notes.title` is not `<Product> v<version> - <the main point>`, with the product's own name from the facts (`title-shape`): a missing `v`, the product's name changed or a missing main point;
- a new cut's `notes.title` names a version other than the facts' `versions` entry for the level (`title-version`). A prep cut earlier is read as it is, and never refused for its title's number;
- a new cut's `notes.title` has a main point that leads with a removal or deprecation (`no longer`, `removed`, `removes`, `removal`, `deprecated`, `deprecates`, `deprecation`, `drops`, `dropped`) while at least one item is news (`title-removal`): the title is the best thing a user gets from the release, and the removal has its own item. A release that is only removals, with its action under `Before you upgrade`, keeps a removal title. A prep cut earlier is read as it is;
- a new cut's item, other than `Before you upgrade` and other than a removal or deprecation item, whose first sentence leads with `no longer` (`item-gain-first`): the #releases post shows only the first sentence, so it says what the user gains, and the mechanism comes after. The lint does not ask for the word "you". A prep cut earlier is read as it is;
- a new cut's item, other than `Before you upgrade`, with a sentence, or the end of one after a comma, a semicolon or a colon, that says nothing changes for a user (`Nothing you use changes.`, `Nothing changes for users.`, `with no change for you`, `and you will not notice it`, `no user-visible change`) (`item-unseen`): a sentence that only holds such words, such as `nothing changes for users who set none`, is not read: a change no user notices is grouped `Internal` and left out of the notes. A prep cut earlier is read as it is;
- a new cut's notes title, summary, item name or item text that names a command-line flag (`--query-timeout`) or an environment variable (`STEAMPIPE_MAX_PARALLEL`: capitals with an underscore) outside a code span (`code-span-missing`): what a user types is between backticks. A code span, and a link's address, are not read for it. A prep cut earlier is read as it is;
- a new cut's notes title, summary, item name or item text that holds a word that sells instead of telling, such as `amazing`, `seamless`, `blazing` or `game-changing` (`hype-word`): the notes stay factual, and a fact can be "faster". A prep cut earlier is read as it is;
- an item's `kind` is not one of the six labels, or `notes.items` is empty while any PR in the range is grouped under one of the six labels, or the range holds no PR (`schema`). A new cut whose every PR is grouped `Internal` may hold `notes.items: []`, unless the release check asks it for notes: then `notes-needed` is raised too;
- an item of the release notes of a kind other than `Before you upgrade` has no `name` (`item-name-missing`), a `name` of fewer than 2 or more than 4 words (`item-name-length`), or a `text` over 300 characters (`item-text-too-long`);
- the release notes (title, summary, an item's name or text, a reference title or an entry) hold:
  - an internal term from the facts' `internalTerms`, matched as a whole word in any case (`internal-term`);
  - a private link (`private-link`), with any scheme (`https://`, `ftp://`, `file://`) or none: a GitHub link (an `api.github.com/repos/…` link, a `git@github.com:<owner>/<repo>.git` remote, or a `<owner>/<repo>#12` or `<owner>/<repo>@<sha>` reference, which GitHub turns into a link) into a repo that is neither the product repo when it is public nor one of `publicRepos` (GitHub's own pages such as `github.com/features` are fine); a GitHub attachment or a gist; a link to an IP address, a host with no dot (`http://buildbox/`), or a `localhost`, `.local`, `.internal`, `.intranet`, `.corp` or `.lan` host; a link to Slack, claude.ai, Google Docs or Drive, Notion, Linear, Atlassian or Figma; a link to one of `privateHosts`; or a link with a user name or password in it. With no scheme, an IP address or `localhost` counts only with a port or a path, so a version such as `1.2.3.4` is fine;
  - a path into the product's source (`file-path`; not checked in the `reference` lists, where a type's name can look like a path): a path that starts in a source folder (`pkg/`, `internal/`, `cmd/`, `src/`, `lib/`, `vendor/`, `node_modules/`, `dist/` or `usr/`) with three parts or more, or ending in `/`, as in `pkg/query/execute` or `internal/auth/` (prose such as `internal/external`, `build/deploy`, `Linux/macOS/Windows` or `11/13/2026` is fine); a source file, one that ends in `.go`, `.js`, `.ts`, `.py`, `.rs`, `.java`, `.sh`, `.html`, `.css` or another source extension, such as `lib/prep.js` or `server.go`; or any file name or path with a line number or a line anchor, such as `src/main.rs:42` or `config.yml#L3`. The name of a file a user writes or edits passes: `pg_hba.conf`, `pg_hba.conf.d/`, `config.spc`, `~/.steampipe/config`, `config.yml` or `.gitignore`. Put such a name in a code span, so a reader can search for it. The report above the folds keeps the stricter rule above and refuses every file path and name, with or without a line number, a line anchor or a query: `lib/prep.js`, `src/main.rs:42`, `./run.sh`, `~/.config`, `$HOME/.config`, `%APPDATA%\example`, `/etc/hosts`, `.github/workflows`, `C:\tools`, `C:/tools`, a folder named for a file such as `pg_hba.conf.d/`, a lowercase path of three parts or more, or ending in `/`, that starts in a source folder, or a name such as `server.go`, `config.yml` or `.gitignore` (a product's name such as `Node.js`, and a kind of file such as `.json` or `.env`, is fine; a link's address, such as `docs.rs/`, is checked as a link, not a path);
- the report is over 300 words (`report-too-long`). Every word of `report` counts but the ask's own paragraph (`report.ask`, 15 to 70 words of its own): the headline, each change with its before, after and label, the safety answer and why, each risk, the undo, each internal change and each note for the release manager. The PR numbers in `covers` and the fixed words of the release PR are not words of the report.

A problem names the field, never the text it matched, because the log of a public repo is public. A field outside the format is named by its place in its object (`notes: holds a field outside this format (field 4)`), not by its name, and an answer to an unknown flag does not repeat the flag.

Exit 0: the file passes. Exit 1: it is refused. Exit 2: the lint could not run (a missing file, facts without the fields above, a bad option).

```
$ node bin/shipyard lint-prep docs/examples/prep.json --facts docs/examples/facts.json
Prep file OK: 5 PRs grouped, 2 flags answered, report 135 words.
```

In GitHub Actions (`GITHUB_ACTIONS=true`), each problem is also printed as an `::error` line, so it shows on the run.
