# Shipyard

Shared release automation for Turbot repositories. Shipyard holds the reusable GitHub Actions workflows and the scripts that:

- start a release on a repository's schedule, or at once when a change asks for it;
- gather the facts of a release: the changes since the last one, and each change's `Changelog:` line;
- cut the release candidate, build it once and test that build;
- check the release PR, and ask the right people to approve it;
- tag the release once it is live, and publish its changelog and release notes.

**Status:** under construction. Nothing here is ready to use yet.

## How a repository uses Shipyard

A repository declares its release settings in `.github/release.json` and calls Shipyard's workflows from a small workflow of its own, pinned to a released commit of Shipyard.

## How Shipyard changes

Work lands on `develop` by reviewed pull request. A Shipyard release is an approved pull request into `main`. Callers pin to a released commit, and an automated pull request moves the pin.

## License

[Apache 2.0](LICENSE)
