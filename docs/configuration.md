# Configuration reference

sapwood is configured by `sapwood.config.yaml` in the repo it operates on. The file is
YAML (with inline comments), but the loader also accepts JSON (`sapwood.config.json`) —
YAML is a superset of JSON, so no separate parser is needed. Config is validated with a
strict [Zod](https://zod.dev) schema (`engine/src/config.ts`): **unknown keys are a
validation error**, not a silently-dropped typo, and every numeric ceiling rejects
non-finite values (so `1e999` can't silently disable a budget cap).

`sapwood init` writes a starter file with every key commented; `sapwood validate`
loads and validates a config with zero side effects — run it after any edit:

```
sapwood validate [path]
```

The loader probes, in order: `sapwood.config.yaml`, `sapwood.config.yml`,
`sapwood.config.json`. Only `board.owner`, `board.repo`, and `board.projectNumber` are
required; every other key has a default.

## `board`

Identifies the repo and ProjectV2 board the loop drives.

| Key | Default | Meaning |
|---|---|---|
| `owner` | *(required)* | GitHub user or org that owns the repo + board. |
| `repo` | *(required)* | Repository name — every `gh` call targets `owner/repo`. |
| `ownerKind` | auto-detected | `user` \| `org`. Detected at `init` if omitted. |
| `projectNumber` | *(required)* | The ProjectV2 board number. |
| `statusField` | `Status` | The board's single-select field used as the work queue. |
| `status.ready` | `Ready` | Lane name for dispatchable issues. |
| `status.inProgress` | `In Progress` | Lane name for claimed issues. |
| `status.done` | `Done` | Lane name for finished issues. |

## `engine`

| Key | Default | Meaning |
|---|---|---|
| `tickIntervalSec` | `60` | How often the engine calls `tick()`. Also feeds the wall-clock cost ceiling's session-gap scaling, so a real (non-default) cadence keeps that ceiling accurate. |
| `driver` | `rounds` | Which engine `sapwood run` drives (#106). `rounds` — the round orchestrator: peripheral roles (aligning/architecting/plan_review/harvesting/retro) wrapped around the same tick engine, one round at a time (see [`PLAN.md`'s round-orchestrator section](../docs/PLAN.md#v02-north-star-the-round-orchestrator)). `tick` — the bare M4 loop driver, no peripherals; `--once`/`--until-idle` only apply in this mode (under `rounds` they are a startup **error** — exit 1 before any dispatch — never silently ignored). Every safety behavior (KILL_SWITCH, cost ceilings, drain-before-kill, graceful stop still running harvest) holds under both. |

## `lanes`

Concurrency and dispatch shape.

| Key | Default | Meaning |
|---|---|---|
| `max` | `3` | Max concurrent workers (occupied lanes). |
| `roundDispatchCap` | `2` | Max new dispatches in a single round/tick (conservative by design). |
| `reserveCap` | `1` | **Accepted, not yet wired** — parsed and validated, but no engine code reads it yet. |
| `prFixCap` | `2` | **Accepted, not yet wired** — the PR-fix iteration loop it will bound doesn't exist yet (review findings currently escalate to `needs-human`). |
| `frictionMin` | `0` | **Accepted, not yet wired** — no dispatch rate-limit is enforced from it yet. |
| `gatedReentryCap` | `2` | (#147) Bounds the **GATED RECLAIM** phase: a gate②-escalated PR whose issue's `needs-human` label a human removes is reclaimed back to `driving` and re-driven through the existing gate①/gate② + merge path — no new worker, same PR/branch. Each reclaim counts as one attempt; once this many have re-escalated, a further label removal is rejected (re-applies `needs-human` + a "cap reached" comment) and the lane is never retried again — merge it by hand. `0` disables automatic reentry outright. |

## `worker`

Per-worker execution.

| Key | Default | Meaning |
|---|---|---|
| `model` | `opus` | Model the headless worker runs as. |
| `effort` | `high` | `low` \| `medium` \| `high`. |
| `timeoutSec` | `3600` | Wall-clock hard cap per worker (enforced). |
| `budgetUsdSoft` | `10` | **Soft** per-worker USD budget, auto-enforced via a live token-usage estimate (stream-json carries no in-progress real cost). Crossing it triggers a graceful handoff (commit + push WIP, progress note, `.handoff` sentinel, clean exit) — never a mid-work kill. The estimate is a per-model rate-table approximation (see `pricingFile` below), reconciled (logged, not enforced) against the real cost when the worker finishes; `timeoutSec` plus the engine's hard `cost` ceiling below remain the actual backstop. |
| `pricingFile` | unset | Override the model rate table the soft-budget estimator prices against. A relative path resolves against **the config file's own directory** (same rule as `promptFile`). Unset uses the engine's shipped `pricing.yaml` — a commented snapshot of per-model USD-per-million-token rates (`input` / `output` / `cacheWrite` / `cacheRead` per model alias). Your file **replaces** the shipped table entirely (no merging), so copy every model you use; you may add your own aliases. Aliases match case-insensitively as substrings of the model id (`opus` matches `claude-opus-4-8`); a model matching nothing is priced at the most expensive tier in the loaded table. A set-but-missing/unreadable/malformed file is a fail-fast startup error (`sapwood validate` catches it too) — never a silent fallback to the shipped rates. |
| `heartbeatStaleSecs` | `180` | A worker heartbeat older than this is considered dead (stale-heartbeat reclaim). |
| `promptFile` | unset | Override the worker's prompt template with your own file. A relative path resolves against **the config file's own directory**, not the CLI's cwd — so the same config behaves identically no matter where `sapwood` is invoked from. Unset uses the engine's shipped `prompts/worker.md` (TDD + two-gate method). |

**`worker.promptFile` template variables:** `{{issue.number}}`, `{{issue.title}}`,
`{{issue.body}}`, `{{issue.labels}}`, `{{labels.verifyNa}}`. `{{issue.labels}}` renders
the issue's label list; `{{labels.verifyNa}}` renders the configured `verify:n/a` label
name (`labels.verifyNa` below), so a custom prompt can still tell the worker which label
means "skip the test-driven gate and make the doc change instead."

**Fail-fast rules:** the template is loaded once, eagerly, at engine startup (before any
dispatch) — never lazily on first use. A `promptFile` that's set but missing, unreadable,
or empty is a startup error, and so is a template referencing an unknown `{{var}}`. There
is no silent fallback to the shipped default once `promptFile` is set: either the exact
file you named loads and validates, or the engine refuses to start. `sapwood validate`
runs this same check, so a broken `promptFile` is caught before you ever run the engine.

## `cost`

Engine-enforced **hard** ceilings — the actual runaway-spend safety boundary, independent
of the soft per-worker budget above.

| Key | Default | Meaning |
|---|---|---|
| `roundBudgetUsd` | `30` | Soft per-round throttle (not the hard safety boundary — see `dailyBudgetUsd`). The gate mechanism exists in the tick, but the live `sapwood run` currently always reports round spend as `0`, so it never triggers in a real run yet — live round-spend tracking is future wiring. |
| `dailyBudgetUsd` | `100` | Cumulative daily USD cap, summed from completed workers' actual cost and persisted across restarts. Breaching it freezes new dispatch/merges engine-wide and drains in-flight workers. |
| `maxWallClockSec` | `14400` (4h) | Aggregate wall-clock ceiling over the engine's *active* session (a stop/crash/pause longer than the stale gap resets the session). Independent of `worker.timeoutSec`, which bounds one worker. |
| `drainWindowSec` | `300` (5min) | Bounded grace window after a ceiling breach (daily budget / wall-clock / kill switch) during which running workers are asked to hand off gracefully before the conductor escalates to a hard process-tree kill. |

## `stop`

Goal-based **final** stop conditions for `sapwood run` — "when is this run complete."
All optional; none set is today's behavior exactly (the run only stops on a signal,
`--once`, or `--until-idle` idleness). Each has a matching CLI flag
(`--stop-after-issues`, `--stop-after-prs`, `--stop-on-milestone`) that overrides the
config value for a single invocation. Conditions are OR'd — the first one satisfied wins
and converts the rest of the run into the same wind-down `--until-idle` uses: stop
dispatching new lanes, let every in-flight lane finish on its own (never a mid-work
kill), then exit, naming the condition that fired.

| Key | Default | Meaning |
|---|---|---|
| `afterIssuesMerged` | unset | Stop once this many issues have been merged during **this run** (counted from this process's own tick results — a restart starts the counter back at 0). |
| `afterPRsOpened` | unset | Stop once this many PRs have been opened during this run (counted the first time a lane's PR becomes known to the engine). |
| `onMilestoneComplete` | unset | Stop once the named milestone has zero open issues left. The name must match the milestone's title **exactly** as GitHub displays it — validated against the repo at startup, before any dispatch; a typo aborts the run with the available titles listed rather than silently never firing. |

**Floor semantics:** each count is a floor, not an exact stopping point. Conditions are
evaluated at tick boundaries, and the tick that crosses the threshold has already run its
own dispatch phase — so up to `lanes.roundDispatchCap` additional lanes may launch in
that same tick and run to completion (including merge) during the wind-down. With
`--once`, a condition hit on the single tick is named in the exit line but the run does
not wait for a wind-down.

**Startup validation:** a configured (or flagged) `onMilestoneComplete` is checked against
the repo's real milestone titles before the run starts dispatching anything; an unknown
title is a hard startup error, not a condition that silently never fires.

The `--stop-*` CLI flags cannot combine with `--dry-run` (which never runs the loop at
all); config-file `stop.*` keys are simply ignored by a dry run.

**`run --milestone NAME` (#129):** a shortcut for the single most common bounded-run
intent — "work only milestone NAME, stop when it's done" — that would otherwise need two
separate settings: `round.milestone` (dispatch scope, config-only) plus
`--stop-on-milestone` (this run's final stop condition). `--milestone NAME` sets both to
`NAME`, **for this run only** (never written back to the config file), and gets the same
startup validation as `--stop-on-milestone` above. Precedence: the CLI flag always wins
over both `round.milestone` and `stop.onMilestoneComplete` in config; it cannot combine
with an explicit `--stop-on-milestone` (ambiguous which name should win — rejected at
startup, before any dispatch, even when the two names match) or with `--dry-run` (same
rule as every `--stop-*` flag above). The scope half (`round.milestone`) only affects the
round orchestrator's dispatch candidates — under `engine.driver: tick` only the
stop-condition half has any effect, since the tick driver has no round to scope. See
[`round`](#round) below for the scoping mechanism on its own.

## `round`

Round-loop scoping (#86) — which issues the round orchestrator's dispatch batch draws
from. Distinct from (but composable with) `stop.onMilestoneComplete` above: scope and
stop are orthogonal mechanisms that happen to reuse the same GitHub-milestone concept —
one can be set without the other, or to two different milestones. `run --milestone NAME`
(above) is a shortcut that sets both to the same name in one flag, for callers who want
the common case ("just work M, stop when it's done") without reasoning about the two
mechanisms separately.

| Key | Default | Meaning |
|---|---|---|
| `milestone` | unset | Milestone TITLE (exact match, same mechanism `stop.onMilestoneComplete` validates against) that scopes this run's dispatch candidates — `sapwood run` only claims/dispatches `Ready` issues in this milestone; every other issue is left untouched. Also skips a round's dispatch batch once the milestone has zero open issues left (a round-level pause, distinct from `stop.onMilestoneComplete`'s run-ending final condition). Unset (the default) scopes nothing — every `Ready` issue is a candidate, today's behavior. Round-orchestrator only (`engine.driver: rounds`); has no effect under the `tick` escape hatch. |

## `recovery`

| Key | Default | Meaning |
|---|---|---|
| `rollbackRetryCap` | `5` | Max retries for a durably-persisted rollback/requeue (e.g. rolling a failed claim back to `Ready`) before the conductor stops retrying and escalates to `needs-human` instead. |

## `reviewer`

Gate② — who reviews a PR before it can merge.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `different-model-codex` | The reviewer kind: `different-model-codex` (0day-style fresh non-author Codex review), `same-model-trusted` (allowlisted reviewers only), or `human` (any non-author approval). |
| `trustedReviewers` | `[]` | Allowlisted reviewer logins, used by `same-model-trusted`. |
| `pollIntervalSec` | `120` | Documents the operational review re-poll cadence (the actual cadence is driven by the tick loop). |
| `pollTimeoutSec` | `1200` | **Accepted, not yet wired** — the timeout it describes isn't enforced yet. Today `REVIEW_UNAVAILABLE` (which queues the PR — never skips or softens gate②) arises only from review-data read failures. |
| `fallback` | `[]` | Ordered, opt-in list of reviewer modes to fail over to when the primary is unavailable past `failoverAfterSec`. Each entry keeps its own mode semantics (identity allowlist for bot modes, any-non-author-approval for `human`). Empty (the default) is byte-for-byte pre-failover behavior: an unavailable primary queues the PR forever, no silent degradation. `same-model-trusted` in `fallback` with an empty `trustedReviewers` is rejected at parse — it could never produce a verdict, so the failover would be silently inert. |
| `failoverAfterSec` | `1200` (20min) | How long the primary reviewer may stay non-decisive before gate② hands off to the first fallback entry that itself reaches a decisive verdict. Irrelevant when `fallback` is empty. |

A fallback-obtained approval is **advisory, never verdict-bearing** on its own: it's
re-verified against live PR data through the recorded mode's own rules at every use, and
the always-blocking signals (unresolved review threads, a standing
`CHANGES_REQUESTED` from anyone) block regardless of any failover state.

## `merge`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `conductor-merge` | `conductor-merge`: once gate① (CI green) and gate② (a fresh review on the current head) both pass, the conductor squash-merges, pinned to that exact head (`--match-head-commit`, closing the TOCTOU window). `produce-pr-and-stop`: both gates are still computed and reported every tick, but the engine never calls the merge API — a human merges. |

## `labels`

The label taxonomy the loop reads and writes. `sapwood init` provisions all of these
(plus the fixed `type:*`/`prio:*` labels and `origin:agent`, which aren't
individually configurable).

| Key | Default | Meaning |
|---|---|---|
| `inProgress` | `in-progress` | Applied to a claimed issue. |
| `needsHuman` | `needs-human` | Escalation — stop autonomy on this issue/PR, ask a human. |
| `blocked` | `blocked` | Held out of the main dispatch lane. |
| `reserve` | `reserve` | Not part of the main dispatch lane. |
| `verifyNa` | `verify:n/a` | Marks an issue as inherently unverifiable by tests — skips the verification-plan gate and routes through the doc-gate path instead. |
| `planApproved` | `plan:approved` | gate⓪ (#88): required, together with a genuine verification-plan section, for `getReadyIssues` to dispatch a non-`verifyNa` issue. Applied by the plan-reviewer peripheral after quality-reviewing the plan — plan *presence* alone is no longer sufficient. See [`security.md`](security.md#plan-approved). |

## `roles`

Peripheral-role configuration. The round orchestrator (`driver: rounds`, the
`sapwood run` default) loads and runs every one of these role prompts each round.

**Issues-only role sessions carry no shell (#110).** `planReviewer`, `planDrafter`,
`po` (align + triage), `harvest`, and `architect` sessions hold no `Bash` tool grant at
all — pure computation: the issue/config context is substituted into the prompt, and
the session has no `Read`/`gh` access of its own. Each session's final message ends in
a structured output block; the engine parses it, validates it against a per-role
schema plus cheap content invariants (e.g. re-confirming an "approve" claim's body
really carries a verification-plan section), and performs every GitHub write itself.
Malformed or invalid output retries once, then the role's own degrade path — never a
silent no-op, never a wedged round. `retro` is the one exception: a worker-class
session with `Read` + local git only (proposals land exclusively as PRs, never a
direct write) — see [`security.md`](security.md) for the full model.

**`retro` holds no `gh` grant at all (#111).** Reads: its prompt is seeded with an
engine-built round-scoped digest — PR descriptions + diffs + review signals for every
PR the round touched, comments/labels for every escalated issue, and the round's
commit history — assembled deterministically before the session runs and substituted
in as `{{round.digest}}`. Writes: the session edits, commits, and pushes a proposal
branch, then records its intended PR (branch/title/body, or `none` for a quiet round)
in a fixed scratch file (`.sapwood-retro-pr`) in its worktree; the engine parses that
file fail-closed, verifies the branch really exists on the forge, and opens the PR
itself via the same forge layer every other engine write uses. `retro` keeps only
local git (branch/checkout/add/commit/push/diff/status/log, for its own worktree).

| Key | Default | Meaning |
|---|---|---|
| `planReviewer.promptFile` | unset | Override the gate⓪ plan-reviewer's prompt (same `#74` pattern as `worker.promptFile`: a relative path resolves against the config file's own directory, not the CLI's cwd). Unset uses the engine's shipped `prompts/plan-reviewer.md`. |
| `planReviewer.maxDraftCycles` | `2` | gate⓪ self-heal bound (#77 Amendment 2): max draft→re-review cycles per issue when the reviewer requests a plan draft (a scoped, issues-only drafting session — never a worker lane, never an implementation). Exhausted → the loop applies `needs-human` with the attempt trail. Positive integer only — `0` would turn every draft request into an instant `needs-human`. |
| `retro.promptFile` | unset | Override the retro/self-evolution peripheral's prompt (same `#74` pattern). Unset uses the engine's shipped `prompts/retro.md`. |
| `retro.everyNRounds` | `1` | Retro cadence (#104): `1` runs every round; `N > 1` skips every round whose id isn't a multiple of `N` (the phase still closes, marker still set — never wedges the round). |
| `retro.digestMaxChars` | `60000` | Hard cap, in characters, on the engine-built round-scoped read digest (#111 PR-A) substituted into retro's prompt as `{{round.digest}}` — PR diffs + review signals for every PR the round touched, comments/labels for every escalated issue, and the round's commit history. Oversize digests are truncated **deterministically** (same prefix every time for the same content+cap) and the cut is marked in the digest text itself, never silently dropped. |

## `guard`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `hard` | `hard`: fail-closed deny — the actual producer≠merger/boundary-write enforcement. `soft`: observe-only — log what would be blocked, but allow it. `soft` is a first-run/dogfood affordance only, never the shipped default; it reaches the hook via a spawn env a worker cannot itself rewrite. |

## `escalation`

| Key | Default | Meaning |
|---|---|---|
| `humanLabels` | `[needs-human, blocked]` | Any of these labels on an issue means "stop autonomy, ask a human" for that issue. |

## `coverage`

| Key | Default | Meaning |
|---|---|---|
| `minPercent` | `0` | **Accepted, not yet wired** — no coverage gate is enforced from it yet; setting it does not add a merge check. |

## `optimize`

| Key | Default | Meaning |
|---|---|---|
| `recur` | `false` | **Accepted, not yet wired** — the recurring optimization round doesn't exist yet. |

## `milestones`

| Key | Default | Meaning |
|---|---|---|
| `milestones` | `[]` | Milestones `sapwood init` ensures exist (idempotent, detect-before-create). Empty = create none — the loop only needs labels and board lanes; milestones are your organizational choice. |

## See also

- [`security.md`](security.md) — why these ceilings and gates exist and what they
  actually guarantee.
- [`troubleshooting.md`](troubleshooting.md) — what a config validation error looks
  like and how to fix it.
