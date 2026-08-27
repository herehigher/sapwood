# Contributing to sapwood

Thanks for considering a contribution. This file covers the mechanics of landing
a change; the [development guide](docs/dev-guide/README.md) covers the codebase
itself.

## Ground rules

- **Repository requirements.** Follow [Verification](CLAUDE.md#verification), [Non-negotiables](CLAUDE.md#non-negotiables), and the [Documentation principle](CLAUDE.md#documentation-principle-source-of-truth-partition). For the authoritative path list, see [Human-merge-only paths](docs/security.md#human-merge-only-paths).
- **Tests.** Follow [How tests are written here](docs/dev-guide/04-commands.md#how-tests-are-written-here).

## Cutting a release

Versioning policy and the exact release commands live in
[dev-guide 10 — Releasing](docs/dev-guide/10-releasing.md).

## Working on the code

Start with the [development guide](docs/dev-guide/README.md):
[running from source](docs/dev-guide/03-running.md),
[test & quality commands](docs/dev-guide/04-commands.md), and the
[core-module map](docs/dev-guide/05-core-modules.md) to find where a change
belongs.

A quirk worth knowing: this repository dogfoods itself — a portion of its own
PRs are produced and review-gated by sapwood.

## External contributions

External pull requests follow the ordinary pull-request quality gate, then are
reviewed and merged by a human maintainer. The autonomous merge path applies
only to the maintainer's governed dogfood loop; it does not apply to external
contributions.

## Where help is most wanted

Issues labeled [help wanted](https://github.com/herehigher/sapwood/labels/help%20wanted) name the areas where an outside
contribution is most useful right now — the dashboard's UI/UX design first.
Each one states the constraints and where to start; for design work, share a
screenshot or mockup on the issue before opening a PR.

## Reporting problems

Open a GitHub issue. For anything security-sensitive (a way to defeat the
guard, escape the worktree, or bypass the merge gate), please avoid a public
issue and use the private channel described in [SECURITY.md](SECURITY.md).
