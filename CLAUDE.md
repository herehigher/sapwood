# CLAUDE.md — borehole

Guide for Claude sessions working in this repo. Keep it short; the canonical
detail lives in [`docs/PLAN.md`](docs/PLAN.md) — **read that first.**

## What this is

borehole = "the autonomous coding loop with governance built in." A Claude Code
plugin that turns a GitHub backlog into reviewed PRs: *issues in → reviewed PRs
out*. It is the dev-loop **framework** extracted from the `0day` project and
re-implemented as a standalone, public tool. Status: **early development, pre-v1.**

## Where things are

- `docs/PLAN.md` — full goals, architecture, security model, milestones, verification.
- Source to port FROM: the `0day` repo (sibling: `../0day`). The framework lives in
  its `ops/loop/*.sh` (conductor/worker/merge-driver), `scripts/*.sh` (GitHub
  plumbing), and `backend/src/zeroday/loop/guard.py` (the safety hook). Port the
  *logic*, not the trading domain.

## Non-negotiables

- **producer ≠ reviewer ≠ merger.** The worker that writes code never approves or
  merges it. Enforced by a fail-closed PreToolUse hook (`guard.ts`), not a prompt.
  Anything touching `guard.ts`, hook wiring, `reviewer.ts`, or security config is
  **human-merge-only**.
- **Guard ships green before anything autonomous runs** (M1, before M2 engine).
- **GitHub is the source of truth** — the ProjectV2 board `Status` + labels are the
  work queue. No parallel task DB.

## Locked decisions (see PLAN.md table)

TypeScript engine · Claude Code plugin form factor · trusted repos first · default
merge gate = produce-PR-and-stop (autonomous-merge opt-in) · dashboard deferred to
v0.2 (built *by* borehole as the flagship dogfood) · JSON config default · 0day's
TDD/two-gate method as overridable defaults.

## This repo's own governance

- Work is tracked as GitHub issues on **Project #4**, grouped by milestones
  `M0 → M0.5 → M1 → M2 → M3 → M4 → v0.2`. Labels: `type:*`, `prio:0-3`,
  `in-progress`, `needs-human`, `blocked`, `reserve`.
- **Never push directly to `main`** — branch + PR. (The repo dogfoods its own model.)
- From M2 onward, borehole builds borehole; prefer routing real work through the loop.
