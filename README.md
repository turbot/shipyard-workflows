<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo/shipyard-logo-darkmode.svg">
  <img src="logo/shipyard-logo.svg" alt="The Shipyard logo" width="112">
</picture>

# Shipyard

Shared release automation for Turbot repositories. Shipyard holds the reusable GitHub Actions workflows and the scripts that:

- start a release on a repository's schedule, or at once when a change asks for it;
- gather the facts of a release: the changes since the last one, and each change's `Changelog:` line;
- cut the release candidate, build it once and test that build;
- check the release PR, and ask the right people to approve it;
- tag the release once it is live, and publish its changelog and release notes.

**Status:** under construction. The `changelog-line`, `cut` and `record` workflows are ready; the rest is on its way.

## Published from turbot/shipyard

This repository is a published copy. Its source is turbot/shipyard, and every Shipyard release publishes it here: the workflows land in `.github/workflows/`, with the scripts they run in `bin/` and `lib/`, and the release-report skill (`.claude/skills/release-report/SKILL.md`) with the two docs it names, `docs/prep-file.md` and `docs/release-cut.md`, as one commit tagged with the release's version (`v1.2.3`).

Nothing is written here by hand. The repository's rules let only the publish job write a branch or a tag.

## Call it at the major tag

Call a workflow at `v0` while the version is 0.x, and at `v1` from 1.0.0:

```yaml
jobs:
  changelog-line:
    uses: turbot/shipyard-workflows/.github/workflows/changelog-line.yml@v0
```

Each release moves its major tag to the release's own commit, so a caller runs the latest release with no pull request. The repository's rules let only the publish job create, move or delete a tag, and it does so after a release a person approved. A workflow checks out this repository at its own commit and runs the scripts from there. To hold a caller back on one release, call a full 40-character commit in place of the tag, and move it on when you are ready.

## No pull requests

Pull requests are not accepted here: a change made in this repository would be replaced by the next release. Shipyard changes in its source repository, where work lands on `develop` by reviewed pull request and a release is an approved pull request into `main`.

## License

[Apache 2.0](LICENSE)
