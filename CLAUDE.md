# CLAUDE.md — sapwood

Guide for Claude sessions working in this repo. Keep it short; the canonical
detail lives in [`docs/PLAN.md`](docs/PLAN.md) — **read that first.**

## What this is

sapwood = "the autonomous coding loop with governance built in." A Claude Code
plugin that turns a GitHub backlog into reviewed PRs: *issues in → reviewed PRs
out*. It is the dev-loop **framework** extracted from a private predecessor project and
re-implemented as a standalone, public tool. Status: **early development, pre-v1.**

## Where things are

- `docs/PLAN.md` — full goals, architecture, security model, milestones, verification.
- `engine/prompts/worker.md` ("Working language & comments") — code-comment discipline
  (why, not what). It's the copy guaranteed to reach workers on any target repo; applies
  here too when writing code interactively.
- Source to port FROM: the private predecessor repo (sibling checkout). The framework
  lives in its loop conductor, worker, merge-driver, GitHub-plumbing, and safety-hook
  sources. Port the *generic logic*, not application-specific behavior.

## Non-negotiables

- **producer ≠ reviewer ≠ merger.** The worker that writes code never approves or
  merges it. Enforced by a fail-closed PreToolUse hook (`guard.ts`), not a prompt.
  Anything touching `guard.ts`, hook wiring, `reviewer.ts`, `merge-driver.ts`,
  security-relevant config, `.claude/settings*.json`, or `.github/workflows/**` is
  **human-merge-only** (canonical list: docs/security.md "Human-merge-only paths").
- **Guard ships green before anything autonomous runs** (M1, before M2 engine).
- **GitHub is the source of truth for *process*** — the ProjectV2 board `Status` +
  labels are the work queue (no parallel task DB). For *durable knowledge*, the docs
  are the source of truth — see "Documentation principle" below.
- **No issue is dispatched without a verification plan.** `Ready` requires acceptance
  criteria + how to prove them; the reviewer re-checks the PR against it at gate②.
  Inherently-unverifiable work (docs/chore) is labelled `verify:n/a` and uses the
  doc-gate path instead. (PLAN.md Decision #8.)
- **Worker cost limit is soft, never a mid-work kill.** Reaching the per-worker budget
  triggers a graceful handoff (commit+push WIP, progress note, `.handoff` sentinel,
  clean exit), not a SIGKILL. Hard stop is reserved for the engine safety ceiling /
  kill switch, and even there drains before killing. (PLAN.md Security model.)

## Documentation principle (source-of-truth partition)

Single source of truth, **partitioned by what kind of fact it is** — every fact has
exactly one home, so the two never drift:

- **GitHub (issues / Project #4 / PRs) = the *development process* only:** what's in
  flight, by whom, in what state. The audit trail — *"how did we get here."* Ephemeral.
- **Project docs (`README`, `docs/PLAN.md`, usage/config guides) = *durable
  knowledge*:** goals, plans, architecture, decisions, outcomes of finished work, and
  how to use the tool — *"what is true now."* Users read docs, never issues.
- Docs never mirror issue mechanics; issues never hold knowledge a user needs.

**Round-close documentation gate:** a development round is not "closed" until the
docs reflect that round's **durable-knowledge** changes (new/changed capability,
behavior, decision, or milestone). Trigger on *knowledge change, not every round* —
a round that changed no durable knowledge closes with zero doc edits, and that is a
pass, not churn. Doc changes go through the same review gate as code (gate②) and are
part of an issue's definition-of-done. Distilled outcomes, never issue transcripts.

## Locked decisions (see PLAN.md table)

TypeScript engine · Claude Code plugin form factor · trusted repos first · default
merge gate: Conductor merges on CI green + a fresh local **engine-agent** review, a
different Claude model (#501, 2026-08-01; hosted different-model Codex review stays
selectable — the pre-#501 predecessor-project-style default; produce-PR-and-stop also selectable) ·
dashboard deferred to
v0.2 (built *by* sapwood as the flagship dogfood) · YAML config default (commented;
JSON also accepted) · the predecessor project's
TDD/two-gate method as overridable defaults.

## This repo's own governance

- Work is tracked as GitHub issues on **Project #4**, grouped by milestones
  `M0 → M0.5 → M1 → M2 → M3 → M4 → v0.2`. Labels: `type:*`, `prio:0-3`,
  `in-progress`, `needs-human`, `blocked`, `reserve`.
- **Never push directly to `main`** — branch + PR. (The repo dogfoods its own model.)
- From M2 onward, sapwood builds sapwood; prefer routing real work through the loop.
