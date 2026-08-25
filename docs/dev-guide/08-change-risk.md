# 08 — Change-risk map

This file turns repository policy into concrete review obligations. [Security](../security.md) contains the full trust model.

## Human-merge-only surface

Any change to the following must be merged by a human, regardless of configured merge mode (canonical list: [Security](../security.md), "Human-merge-only paths"):

| Surface | Why | Enforcement |
| --- | --- | --- |
| `engine/src/guard/guard.ts` | Defines what producer/tool activity is blocked. | Process policy plus protected write paths in `guard.ts`; worker and role sessions receive the hook through `worker.ts`/`peripheral.ts`. |
| Guard-hook wiring, including `engine/src/guard/guard-hook.ts` and the worker/role inline settings in `worker.ts` and `peripheral.ts` | A wiring change can disable a correct guard. | Hard-mode startup rejects a missing compiled hook; `guard-hook.ts` source, the compiled hook artifacts, and `.claude/settings*.json` are guard-protected write paths. `worker.ts`/`peripheral.ts` source is **not** guard-protected — their human-merge-only status is pure process policy, which is exactly why reviewer vigilance matters on these two files. |
| `engine/src/roles/reviewer.ts` | Controls reviewer identity, verdict, head freshness, and fallback semantics. | Process policy plus guard write-path protection for `reviewer.ts`. |
| `engine/src/roles/merge-driver.ts` | The merge path itself: gate derivation, the final pre-merge fail-safe, and the head-pinned merge call. | Process policy plus guard write-path protection for `merge-driver.ts` (source and compiled `dist/` artifact alike). |
| Security-relevant configuration | `guard.mode`, `reviewer.*`, and `merge.*` can weaken the producer/reviewer/merger boundary. | Strict Zod validation and fail-closed defaults in `engine/src/config/config.ts`; guard blocks session writes to the engine config; human review remains a process control because config files are operator-writable. |
| `sapwood.config.example.yaml`/`.json` (`sapwood init`'s starter template) | Carries the same safe-by-default `merge.mode: produce-pr-and-stop` pin every future `sapwood init` inherits; weakening it degrades that default repo-wide, not just this repo's live config. | Guard write-path denial as a sibling rule to the root config's (`engine/src/guard/guard.ts`, #781); also on the default `escalation.instructionPaths` surface. |
| `.claude/settings*.json` and `.github/workflows/**` | Settings carry the hook wiring; workflows are CI integrity — either can neutralize a gate without touching engine source. | Guard write-path denial for both patterns, checked position-independently in Bash commands as well as file tools. |

The guard prevents an autonomous session from writing protected paths through file tools and recognized Bash write vectors. That does not replace the human-merge process rule: a branch prepared outside a guarded session still requires human handling.

## High-risk seams (change with a reviewer's hat on)

| Seam | Risk and required companion work |
| --- | --- |
| `deriveGate()` / `mergeDecision()` in `roles/merge-driver.ts` | These are layered decision tables, with `mergeDecision()` the last pre-merge fail-safe. Update the row-for-row cases in `merge-driver.test.ts`; unknown/empty cases must remain non-merge. |
| `state/state.ts` `MIGRATIONS` | On-disk state is forward-only and restart-critical. Append, never rewrite; test upgrade from the previous populated version and preserve read-only/version behavior. |
| `state/structured-output.ts` and role Zod schemas | Validated role output causes engine-executed GitHub writes. Reject ambiguity, duplicate blocks, target mismatch, and partial application; add malformed/adversarial tests. |
| `forge/labels.ts` and `config.labels.prefix` | Label namespace changes affect readiness, blockers, priority, escalation, pool membership, and existing installations. Preserve prefix-aware and case-normalized matching and exact-vs-substring distinctions. |
| `proxy/access.ts`, `proxy/tools.ts`, caps/budgets | The server-side role/tool matrix is deny-by-default and the proxy exposes trusted forge evidence. Adding a tool requires scope, argument, cap, budget, journal, timeout, and role-matrix tests. |
| `config/config.ts` | `.strict()` schemas make changes user-visible; renamed/removed keys can break existing YAML. Update the commented starter `sapwood.config.example.yaml`, this repo's live `sapwood.config.yaml` if it pins the key, `docs/guide/configuration.md`, validation, and defaults together. |
| Worker sentinel/handoff protocol in `roles/worker.ts` and `loop/conductor.ts` | Wrapper and conductor coordinate through atomic files plus SQLite. Preserve wrapper-owned terminal evidence, resume intent, per-leg budget baselines, worktree retention, and crash adoption/reconciliation tests. |
| Forge write ordering in conductor/role apply paths | A crash between GitHub and SQLite can duplicate or strand work. Add durable intent/success and idempotent rerun logic before introducing a new write. |
| A new engine-wide control-plane sentinel (PAUSE/KILL_SWITCH/EMERGENCY_STOP-shaped: a file the engine polls to change tick behavior) | Adding a tier means mirroring every EXISTING tier's call sites, not just the `tick()` gate. `#293` (EMERGENCY_STOP) needed two separate gate② rejection rounds to find this: first that `tick()`'s own pre-gate reconciler bypassed it, then that neither engine driver's stop lifecycle nor the round orchestrator's peripheral/standby checks saw it at all. Before calling the wiring done, `grep -rn isKillSwitchActive engine/src` (or the nearest existing sibling tier) and add the new sentinel everywhere that pattern appears — `cli.ts`, `state/state.ts` + `state/read-model.ts`, `loop/conductor.ts`'s `tick()` gate *and* its pre-gate reconcilers, and `loop/round.ts`'s driver/peripheral/standby checks — plus a precedence test against every other tier (which wins if both are set) and a test that a lane already at a terminal sentinel keeps its real outcome. |

## Rules that must survive any refactor

1. **Producer ≠ reviewer ≠ merger.** `CLAUDE.md` makes this non-negotiable; `guard/` blocks producer overreach, `Reviewer` has no merge method, and only `MergeDriver.driveOne()` calls `forge.mergePR()` (`roles/reviewer.ts`, `roles/merge-driver.ts`).
2. **Defaults fail closed.** Malformed hook input blocks (`guard-hook.ts`); an empty required CI rollup is not green (`parsePRStatus` in `forge/forge.ts`); unavailable review waits; unknown gate/action becomes `HUMAN`/`ESCALATE` (`deriveGate`, `mergeDecision`).
3. **A soft worker budget never causes a mid-work kill.** It requests a graceful handoff and preserves resumable WIP; only timeout, engine hard ceiling, or kill-switch drain escalation may kill the process tree (`roles/worker.ts`, `loop/conductor.ts`, `CLAUDE.md`).
4. **Externally visible forge writes precede local terminal completion, with durable intent where retry is required.** `pending_rollbacks`, `pending_thread_writes`, `settleTerminalWorker()`, and proxy journal ordering encode the crash-rerun law (`state/state.ts`, `proxy/journal.ts`).
5. **There is no parallel task database.** ProjectV2 status and labels are the work queue; SQLite records engine execution/recovery state (`CLAUDE.md`, `forge/forge.ts`, `state/state.ts`).
6. **Operator tunables live in config, not source constants.** `config/config.ts` defines named defaults and `sapwood.config.yaml` documents them; add corresponding material to `docs/guide/configuration.md`.
7. **The engine never writes hold labels.** `escalation.holdLabels` is a human-applied WAIT signal; engine write paths apply `needsHuman`/workflow labels, while `deriveGate()` only reads hold labels (`forge/labels.ts`, `roles/merge-driver.ts`, `sapwood.config.yaml`).
8. **Peripherals propose and the engine applies.** Issue-oriented roles emit validated structured output and do not hold mutation tools or forge credentials (`roles/peripheral.ts`, `roles/plan-review.ts`, `roles/architect.ts`, `docs/security.md`).

## Practical review checklist for engine PRs

- Colocate focused `*.test.ts` coverage with the changed module; run test, lint, typecheck, and build commands appropriate to the change.
- For every new durable write, identify the crash point before and after it and specify retry, idempotency, and reconciliation behavior.
- Distinguish event deduplication from external-signal/write deduplication; test repeated ticks and restart replay.
- Keep migrations append-only and test a populated previous-version database.
- Keep unknown, empty, malformed, stale-head, and unavailable cases fail-closed.
- For new config keys, update `config.ts`, `sapwood.config.yaml`, validation tests, and `docs/guide/configuration.md`.
- For label changes, test custom and empty prefixes, case normalization, and existing namespace compatibility.
- For proxy changes, test deny-by-default role access, repository scope, caps, budgets, journal ordering, and teardown.
- For sentinel/worker changes, test spawn error, fast exit, timeout, handoff, resume, crash adoption, and retained dirty worktrees.
- Reflect durable user-visible behavior in its canonical docs before considering the change complete (`CLAUDE.md`, “Documentation principle”).
