# Contributing to sapwood

Thanks for considering a contribution. This file covers the mechanics of landing
a change; the [development guide](docs/dev-guide/README.md) covers the codebase
itself.

## Ground rules

- **Branch + pull request, always.** Nothing is committed directly to `main`.
- **Every PR passes the quality gate**: `npm test`, `npm run lint`, and
  `npm run typecheck` green (CI runs these on every PR — see
  [dev-guide 04](docs/dev-guide/04-commands.md)). New behavior ships with
  colocated `*.test.ts` coverage.
- **No test assertion depends on real time.** A test that seeds a timestamp
  injects that same clock into the code under test, and no assertion's
  pass/fail may turn on real timer ordering, real subprocess duration, or
  scheduler order — deliberate exceptions carry a comment saying so. See
  [dev-guide 04](docs/dev-guide/04-commands.md#how-tests-are-written-here).
- **Some paths are human-merge-only.** Changes touching the guard, reviewer,
  merge driver, security-relevant config, `.claude/settings*.json`, or
  `.github/workflows/**` are never auto-merged, regardless of review outcome —
  see [Human-merge-only paths](docs/security.md#human-merge-only-paths) for the
  canonical list and rationale, and the
  [change-risk map](docs/dev-guide/08-change-risk.md) before touching anything
  near them.
- **Docs are part of done.** A change to durable, user-visible behavior updates
  the relevant `docs/` page (or `docs/configuration.md` for config keys) in the
  same PR. GitHub issues/PRs record process; docs record what is true now.

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

## Reporting problems

Open a GitHub issue. For anything security-sensitive (a way to defeat the
guard, escape the worktree, or bypass the merge gate), please avoid a public
issue and use the private channel described in [SECURITY.md](SECURITY.md).
