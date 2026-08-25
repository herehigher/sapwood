# sapwood (plugin)

You are running the **sapwood** plugin inside a target repo — the repo whose GitHub
issue backlog sapwood turns into reviewed pull requests. This file orients you (the
model driving this session), not a sapwood contributor.

## What sapwood does

sapwood dispatches a headless Claude Code worker per `Ready` GitHub issue, in its own
git worktree. The worker does TDD, opens a PR, and stops — it never merges or approves
its own review (enforced by a fail-closed hook, not a prompt). A conductor loop reclaims
finished lanes, drives PRs through a review gate, and — depending on config — merges
them itself or leaves the merge for a human.

## Slash commands

- **`/sapwood-run [--once|--until-idle|--dry-run]`** — run the engine. No flags = the
  **rounds driver** (the default): a governed round of aligning → architecting →
  plan_review → executing → harvesting → retro, with scheduling ticks running inside
  the executing phase. `--once` (a single tick; dispatched workers keep running
  detached, so follow with `/sapwood-status` and further ticks) and `--until-idle`
  (keep ticking until nothing is in flight) are only accepted with
  `engine.driver: tick` in the config — the rounds driver rejects both. `--dry-run` =
  preview what would dispatch + a cost estimate, no worker spawned, no state written.
- **`/sapwood-status [db-path]`** — read engine state (active lanes, PRs awaiting
  review, spend vs. the daily ceiling, e-stop/kill switch/pause state) directly from
  `.sapwood/sapwood.sqlite`. Works with no engine session currently running.
- **`/sapwood-stop [--emergency|--clear-emergency|--pause|--resume|--lift]`** — three
  human-control tiers. `--emergency` sets the strictest, no-drain stop; clear it with
  `--clear-emergency` only after human review. No argument sets the drain-first kill
  switch (freezes all new dispatch/merges, drains running workers), and `--lift`
  removes it. `--pause` freezes new dispatch only (everything in flight keeps going);
  `--resume` removes it.

## Config

`sapwood.config.yaml` (or `.yml`/`.json`) at the target repo's root. Required:
`board.owner`, `board.repo`, `board.projectNumber`. Everything else has a default.
Validate any edit with `sapwood validate` before running the engine.

## Where the docs live

Full documentation lives in the sapwood repo, not here — this plugin install has no
`docs/` directory of its own:

- [Getting started](https://github.com/herehigher/sapwood/blob/main/docs/guide/getting-started.md) — install, `sapwood init`, the first-run trust ramp, how to
  write a `Ready` issue.
- [Configuration](https://github.com/herehigher/sapwood/blob/main/docs/guide/configuration.md) — every config key, its default, and its meaning.
- [Security](https://github.com/herehigher/sapwood/blob/main/docs/security.md) — the trust/governance model: producer≠reviewer≠merger, the guard
  hook, human-merge-only paths, the e-stop/kill switch/pause control tiers, cost ceilings.
- [Troubleshooting](https://github.com/herehigher/sapwood/blob/main/docs/guide/troubleshooting.md) — what common failures (`needs-human`, a dirty-worktree
  degrade, tick errors, auth scope problems) mean and how to resolve them.
- [PLAN](https://github.com/herehigher/sapwood/blob/main/docs/PLAN.md) — full architecture, decision log, and roadmap (contributor-facing;
  read the docs above first for using the tool).

## The one rule that matters

**producer ≠ reviewer ≠ merger.** A worker writing code for an issue never approves its
own review or merges its own PR — that's enforced structurally (a PreToolUse guard
hook), not by asking nicely. Don't try to route around it; if a task genuinely needs to
touch `guard.ts`, `reviewer.ts`, `merge-driver.ts`, hook wiring, security config,
`.claude/settings*.json`, or `.github/workflows/**`, that change is human-merge-only
regardless of sapwood's configured merge mode.
