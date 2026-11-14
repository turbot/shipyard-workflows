# Shipyard

Shared release automation for Turbot repositories. Shipyard holds the reusable GitHub Actions workflows and the scripts that:

- start a release on a repository's schedule, or at once when a change asks for it;
- gather the facts of a release: the changes since the last one, and each change's `Changelog:` line;
- cut the release candidate, build it once and test that build;
- check the release PR, and ask the right people to approve it;
- tag the release once it is live, and publish its changelog and release notes.

**Status:** under construction. The `changelog-line`, `cut` and `record` workflows are ready; the rest is on its way.

## Published from turbot/shipyard

This repository is a published copy. Its source is turbot/shipyard, and every Shipyard release publishes it here: the workflows land in `.github/workflows/`, with the scripts they run in `bin/` and `lib/`, as one commit tagged with the release's version (`v1.2.3`).

Nothing is written here by hand. The repository's rules let only the publish job write a branch or a tag.

## Pin by commit

Call a workflow at a full 40-character commit, never a tag or a branch:

```yaml
jobs:
  changelog-line:
    uses: turbot/shipyard-workflows/.github/workflows/changelog-line.yml@<40-character commit sha>
```

A tag tells you which release a commit is; the commit is what you pin. A workflow checks out this repository at its own commit and runs the scripts from there, so a pinned caller runs exactly the code it pinned.

## No pull requests

Pull requests are not accepted here: a change made in this repository would be replaced by the next release. Shipyard changes in its source repository, where work lands on `develop` by reviewed pull request and a release is an approved pull request into `main`.

## License

[Apache 2.0](LICENSE)
