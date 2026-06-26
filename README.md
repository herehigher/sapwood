# borehole

**The autonomous coding loop with governance built in.**

borehole turns a GitHub backlog into merged, reviewed code: *issues in → reviewed
PRs out*. It is a [Claude Code](https://claude.com/claude-code) plugin that drives
self-directed development through a real governance layer — not a black box that
self-merges and hopes for the best.

> Status: **early development** (pre-v1). The framework is being extracted and
> re-implemented from a proven private project; see [`docs/PLAN.md`](docs/PLAN.md)
> for the full goals, architecture, and roadmap.

## Why it's different

Most autonomous coding tools ask you to trust the model and let it merge. borehole's
core is the opposite: a **fail-closed safety layer** that structurally separates the
roles in the loop.

- **producer ≠ reviewer ≠ merger** — the worker that writes the code can never
  approve or merge it. Enforced by a fail-closed PreToolUse hook, not a prompt.
- **GitHub is the source of truth** — a ProjectV2 board's `Status` field + issue
  labels *are* the work queue. No hidden database, no opaque state.
- **Configurable review chain** — default is *produce-PR-and-stop* (the loop does
  everything; a human clicks merge). Autonomous-merge with a pluggable reviewer is
  opt-in, once you trust it.
- **Cost is bounded and legible** — engine-enforced spend ceilings, a dry-run
  preview, and a kill switch.

## How it works

A nested loop dispatches one **headless worker per issue**, each in its own git
worktree. Workers do TDD, open a PR, and request review — but never merge. Worker
completion is signaled by the wrapper writing sentinel files, not by the model's
self-report. The conductor reclaims finished lanes, drives PRs through the review
gate, and (in autonomous mode) merges.

```
GitHub issue (Ready)
   → claim → isolated worktree → TDD → PR (Closes #N) → review
   → [default] stop for human merge   |   [opt-in] conductor merges
   → board: Done
```

## Roadmap

| Milestone | Focus |
|-----------|-------|
| M0 | Plugin skeleton, config schema, `IForge` interface, SQLite state |
| M0.5 | Turnkey onboarding (`borehole init`: board/labels/milestones) |
| M1 | Guard port — the fail-closed safety core (ships green first) |
| M2 | Engine core (conductor/worker) — **borehole starts building borehole** |
| M3 | Review gate + opt-in autonomous-merge + cost ceiling |
| M4 | Commands, status CLI, first-run trust ramp, docs |
| v0.2 | Dashboard — built *by* borehole itself, as the flagship dogfood |

Built in TypeScript. Targets your own / your team's repos first (trusted context),
architected toward public-repo hardening.

## License

TBD.
