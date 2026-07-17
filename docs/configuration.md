# Configuration reference

sapwood is configured by `sapwood.config.yaml` in the repo it operates on. The file is
YAML (with inline comments), but the loader also accepts JSON (`sapwood.config.json`) —
YAML is a superset of JSON, so no separate parser is needed. Config is validated with a
strict [Zod](https://zod.dev) schema (`engine/src/config/config.ts`): **unknown keys are a
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

## Data directory is stateful

Treat `data/` as durable runtime state: back it up, and never delete it while sapwood is
running. SQLite worker rows are the recovery truth; the GitHub board is only a management
view and sapwood deliberately never rebuilds local state from it. `KILL_SWITCH`, `PAUSE`, and
`ESCALATION` also live in this directory and disappear with it. Losing the database resets the
daily `spend_ledger`, so the same UTC day's budget may be spent again; this is a known accepted
residual risk. On the next start sapwood reports detectable board/PR orphans, but does not
requeue, relabel, drive, or otherwise reconstruct them.

## `board`

Identifies the repo and ProjectV2 board the loop drives.

| Key | Default | Meaning |
|---|---|---|
| `owner` | *(required)* | GitHub user or org that owns the repo + board. |
| `repo` | *(required)* | Repository name — every `gh` call targets `owner/repo`. |
| `ownerKind` | auto-detected | `user` \| `org`. Detected at `init` if omitted. |
| `projectNumber` | *(required)* | The ProjectV2 board number. |
| `statusField` | `Status` | The board's single-select field used as the work queue. |
| `status.backlog` | `Todo` | Human-managed intake lane. Whoever adds an item places it here; at startup the engine moves any No-Status issue items here without making them dispatchable. Engine-mediated issue creation must set this Status as its own board-add write. |
| `status.ready` | `Ready` | Lane name for dispatchable issues. |
| `status.inProgress` | `In Progress` | Lane name for claimed issues. |
| `status.done` | `Done` | Lane name for finished issues. |

## `engine`

| Key | Default | Meaning |
|---|---|---|
| `tickIntervalSec` | `60` | How often the engine calls `tick()`. Also feeds the wall-clock cost ceiling's session-gap scaling, so a real (non-default) cadence keeps that ceiling accurate. |
| `driver` | `rounds` | Which engine `sapwood run` drives (#106). `rounds` — the round orchestrator: peripheral roles (aligning/architecting/plan_review/harvesting/retro) wrapped around the same tick engine, one round at a time (see [`PLAN.md`'s round-orchestrator section](../docs/PLAN.md#v02-north-star-the-round-orchestrator)). `tick` — the bare M4 loop driver, no peripherals; `--once`/`--until-idle` only apply in this mode (under `rounds` they are a startup **error** — exit 1 before any dispatch — never silently ignored). Every safety behavior (KILL_SWITCH, cost ceilings, drain-before-kill, graceful stop still running harvest) holds under both. |

## `logging`

Run-scoped, disposable narrative output for humans and LLMs. It complements rather than
duplicates the structured events ledger and raw lane/role output. Opening the configured file
is a fail-fast startup check before dispatch; a later write failure is reported once and file
logging is disabled while stderr teeing continues. Rotation keeps only the current file and
one `<path>.1` generation.

| Key | Default | Meaning |
|---|---|---|
| `path` | `data/logs/sapwood.log` | Destination for the run narrative. A relative path—including the default—resolves against the config file's own directory, not the CLI's cwd. |
| `teeToStderr` | `true` | Write each timestamped file record to stderr as well. |
| `maxBytes` | `10485760` (10 MiB) | Before an append would cross this positive byte limit, replace `<path>.1` with the current file and start a fresh current file. |

## `lanes`

Concurrency and dispatch shape.

| Key | Default | Meaning |
|---|---|---|
| `max` | `3` | Max concurrent workers (occupied lanes). |
| `roundDispatchCap` | `2` | Max new dispatches in a single round/tick (conservative by design). |
| `reserveCap` | `1` | **Accepted, not yet wired** — parsed and validated, but no engine code reads it yet. |
| `prFixCap` | `2` | **Accepted, not yet wired** — the PR-fix iteration loop it will bound doesn't exist yet (review findings currently escalate to `needs-human`). |
| `frictionMin` | `0` | **Accepted, not yet wired** — no dispatch rate-limit is enforced from it yet. |
| `gatedReentryCap` | `2` | (#147) Bounds the **GATED RECLAIM** phase: a gate②-escalated PR whose issue a human clears of **every** `escalation.humanLabels` entry (default `sapwood:needs-human` *and* `sapwood:blocked` — the same hold set dispatch honors) is reclaimed back to `driving` and re-driven through the existing gate①/gate② + merge path — no new worker, same PR/branch. Each reclaim counts as one attempt; once this many have re-escalated, a further label removal is rejected (re-applies `labels.needsHuman` + a "cap reached" comment) and the lane is never retried again — merge it by hand. `0` disables automatic reentry outright. |

## `worker`

Per-worker execution.

| Key | Default | Meaning |
|---|---|---|
| `model` | `opus` | Model the headless worker runs as. |
| `effort` | `high` | `low` \| `medium` \| `high`. |
| `fallbackModel` | `sonnet` | Model passed to Claude's `--fallback-model` when the primary is unavailable. Set to literal `"none"` to omit the flag and fail loud rather than silently downgrade quality; the environment-failure handling path is documented in [#168](https://github.com/herehigher/sapwood/issues/168). |
| `timeoutSec` | `3600` | Wall-clock hard cap per worker (enforced). |
| `budgetUsdSoft` | `10` | **Soft** per-worker USD budget, auto-enforced via a live token-usage estimate (stream-json carries no in-progress real cost). Crossing it triggers a graceful handoff (commit + push WIP, progress note, `.handoff` sentinel, clean exit) — never a mid-work kill. The estimate is a per-model rate-table approximation (see `pricingFile` below), reconciled (logged, not enforced) against the real cost when the worker finishes; `timeoutSec` plus the engine's hard `cost` ceiling below remain the actual backstop. |
| `maxResumes` | `2` | Maximum fresh worker legs after the initial leg hands off. RESUME runs before DISPATCH, keeps the issue In Progress, and reuses the same session/worktree; each leg gets a fresh `budgetUsdSoft`. `0` disables automatic resume. Once exhausted, the handoff is latched and escalated once to `needs-human`. Total per-issue soft-budget exposure is bounded by `budgetUsdSoft × (1 + maxResumes)`, still under the engine-wide daily cap. |
| `pricingFile` | unset | Override the model rate table the soft-budget estimator prices against. A relative path resolves against **the config file's own directory** (same rule as `promptFile`). Unset uses the engine's shipped `pricing.yaml` — a commented snapshot of per-model USD-per-million-token rates (`input` / `output` / `cacheWrite` / `cacheRead`) plus each model's `contextWindow` (tokens — the dashboard's context-usage gauge denominator). Your file **replaces** the shipped table entirely (no merging), so copy every model you use; you may add your own aliases. Aliases match case-insensitively as substrings of the model id (`opus` matches `claude-opus-4-8`); a model matching nothing is priced at the most expensive tier in the loaded table. A set-but-missing/unreadable/malformed file — including a model entry missing `contextWindow` — is a fail-fast startup error (`sapwood validate` catches it too) — never a silent fallback to the shipped rates. |
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
| `roundBudgetUsd` | `30` | Soft per-round dispatch throttle (not the hard safety boundary — see `dailyBudgetUsd`). It counts every `spend_ledger` row after the round's durable start cursor: opening/closing peripheral sessions and each settled worker leg exactly once. Crossing it stops new dispatch, never kills in-flight work, and never skips harvest or retro. |
| `dailyBudgetUsd` | `100` | **Burn-rate cap**, not a total — "$100/day, renews in Xh." Summed from completed workers' actual cost (each worker's terminal `total_cost_usd`, a priced snapshot that settles on that worker's final bill) by **UTC calendar day**, and persisted across restarts (`spend_ledger`), so it renews at the next UTC midnight regardless of any restart in between. A common misreading (2026-07-13 dashboard/cost discussion, #17/#154) is treating this as a run total or an all-time cap — it is neither; see `stop.afterSpendUsd` below for the actual per-run cap. Breaching it freezes new dispatch/merges engine-wide and drains in-flight workers. |
| `maxWallClockSec` | `14400` (4h) | A **continuous-activity window**, not total run duration. It accumulates only while ticks are actually flowing (executing/drain) and **RESETS on any quiet gap** longer than `max(900s, 2 × engine.tickIntervalSec)` — a deep standby wait or a long peripheral stretch resets it, so an idle-heavy multi-day run never trips it. What it actually detects: "the dispatch/drain machinery has churned 4h without a single quiet quarter-hour" — a runaway/batch-scoping smell, **not a long-run limiter**. (A rapid crash-loop still can't evade it: each tick refreshes the session rather than resetting it.) Independent of `worker.timeoutSec`, which bounds one worker, and of run duration generally — there is no run-duration cap at all; see the knob table below. |
| `drainWindowSec` | `300` (5min) | Bounded grace window after a ceiling breach (daily budget / wall-clock / kill switch) during which running workers are asked to hand off gracefully before the conductor escalates to a hard process-tree kill. |

## `stop`

Goal-based **final** stop conditions for `sapwood run` — "when is this run complete."
All optional; none set is today's behavior exactly (the run only stops on a signal,
`--once`, or `--until-idle` idleness). Each has a matching CLI flag
(`--stop-after-issues`, `--stop-after-prs`, `--stop-on-milestone`, `--stop-after-spend`)
that overrides the config value for a single invocation. Conditions are OR'd — the first
one satisfied wins and converts the rest of the run into the same wind-down
`--until-idle` uses: stop dispatching new lanes, let every in-flight lane finish on its
own (never a mid-work kill), then exit, naming the condition that fired.

| Key | Default | Meaning |
|---|---|---|
| `afterIssuesMerged` | unset | Stop once this many issues have been merged during **this run** (counted from this process's own tick results — a restart starts the counter back at 0). |
| `afterPRsOpened` | unset | Stop once this many PRs have been opened during this run (counted the first time a lane's PR becomes known to the engine). |
| `onMilestoneComplete` | unset | Stop once the named milestone has zero open issues left. The name must match the milestone's title **exactly** as GitHub displays it — validated against the repo at startup, before any dispatch; a typo aborts the run with the available titles listed rather than silently never firing. |
| `afterSpendUsd` | unset | (#154) Stop once **this run's own ledgered spend** reaches `$N` — the missing money unit: a per-run authorization ("this run may spend $X"), distinct from `roundBudgetUsd` (per-round/soft), `dailyBudgetUsd` (a cross-restart calendar-day *rate* cap, never a run total), and every other `stop.*` condition above (which bound work, not money). Summed from THIS run's own `spend_ledger` rows only — an id-cursor captured once at engine startup, so a **restart starts this sum back at $0** even mid-day (the daily cap still applies, unchanged, since it is deliberately not run-scoped). Each worker's contribution is its terminal cost — a priced snapshot that settles on that worker's final bill. |

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

**Time & spend units, at a glance (#154):** the engine bounds work at several different
granularities, and each one is bounded by a *different* knob (or, for one deliberate
case, no knob at all) — this table exists because two of these are easy to misread (see
`cost.dailyBudgetUsd`/`maxWallClockSec` above for the long-form clarifications):

| Unit | Bounded by | Notes |
|---|---|---|
| tick | `engine.tickIntervalSec` | The dispatch/reclaim/drive cadence itself — not a duration cap on anything, just how often the loop runs. |
| worker lane | `worker.timeoutSec` (hard) / `worker.budgetUsdSoft` (soft) | Hard wall-clock kill vs. a soft budget that triggers a graceful handoff, never a mid-work kill. |
| peripheral session | `worker.timeoutSec` | Peripheral role sessions (aligning/architecting/plan_review/harvesting/retro) reuse the same wall-clock cap as a worker lane. |
| round | *(deliberately no duration cap)* | Bounded by *work*, not time: `lanes.roundDispatchCap` (dispatch quota) and `cost.roundBudgetUsd` (soft spend throttle) end a round's dispatch; there is no "a round may run at most N minutes" knob, by design — a round's real-world length follows its work. |
| run | `stop.afterSpendUsd` / `afterIssuesMerged` / `afterPRsOpened` / `onMilestoneComplete` | Goal-based, not time-based — a run ends when one of these conditions fires (or on a signal), never on an elapsed-time budget. |
| wall-clock window | `cost.maxWallClockSec` | A *continuous-activity* window that resets on any quiet gap — see above. Detects runaway churn, not a long run. |
| calendar day | `cost.dailyBudgetUsd` | A burn-rate cap that renews at UTC midnight and survives restarts — the one cross-restart ceiling in this table. |

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

Round-loop scoping (#86) and standby (#125) — which issues the round orchestrator's
dispatch batch draws from, and whether a new round opens at all when there is provably
nothing to do. Scoping is distinct from (but composable with) `stop.onMilestoneComplete`
above: scope and stop are orthogonal mechanisms that happen to reuse the same
GitHub-milestone concept — one can be set without the other, or to two different
milestones. `run --milestone NAME` (above) is a shortcut that sets both to the same name
in one flag, for callers who want the common case ("just work M, stop when it's done")
without reasoning about the two mechanisms separately.

| Key | Default | Meaning |
|---|---|---|
| `milestone` | unset | Milestone TITLE (exact match, same mechanism `stop.onMilestoneComplete` validates against) that scopes this run's dispatch candidates — `sapwood run` only claims/dispatches `Ready` issues in this milestone; every other issue is left untouched. Also skips a round's dispatch batch once the milestone has zero open issues left (a round-level pause, distinct from `stop.onMilestoneComplete`'s run-ending final condition). Unset (the default) scopes nothing — every `Ready` issue is a candidate, today's behavior. Round-orchestrator only (`engine.driver: rounds`); has no effect under the `tick` escape hatch. |
| `standby.enabled` | `true` | Pre-round probe (#125): before opening a NEW round, a pure-GitHub-API check — any Ready issue? any plan-review candidate? any open plan-less issue awaiting PO triage? (when `milestone` is set) any open, non-human-held issue left in it? — decides whether there is provably anything for the round to do. All empty -> the round is withheld (an exponential backoff wait, below) instead of opening and running all five peripheral role sessions for nothing. Standby only engages after a round this run already completed with nothing dispatched — the first round always opens, so the PO gets its plan-doc decomposition pass even on a completely empty repo. A probe API failure fails open — the round opens normally (recorded as a `tick-error` event). Known ceiling: a plan-doc edit made *during* standby is invisible to the pure-API probe — file an issue (any probe signal) or restart the run to wake the PO. `false` restores the pre-#125 behavior: a round always opens immediately. **#212:** the milestone check excludes any issue carrying an `escalation.humanLabels` label — a milestone whose open issues are *all* human-held (`needs-human`/`blocked`) no longer counts as work, so standby engages instead of opening empty round after empty round on a backlog nothing enabled can consume; one non-held open issue in the milestone still counts. |
| `standby.backoffCapSec` | `1800` (30min) | Cap on the standby wait: `engine.tickIntervalSec * 2^n` (n = consecutive empty probes), capped here. Any probe hit (a Ready issue appears, etc.) resets the exponent and opens the round immediately — no extra wait. Standby entries/waits/exits are recorded in the event log (`standby-wait`/`standby-exit`). KILL_SWITCH bypasses standby entirely: a round still opens and blocks at its first peripheral phase, same as `standby.enabled: false`. |
| `directiveFile` | `data/DIRECTIVE.md` | #126: a round directive — human steering (why/what direction; execution stays the agents') dropped at this path before or during a round. At round open the engine reads it, substitutes it into both the aligning (`po.md`) and architecting (`architect.md`) prompts as `{{round.directive}}`, then archives it to `data/directives/round-N.md` so it never silently re-applies to a later round. Consume-once is event-sourced (a durable `directive-applied` event, not the file's presence, is the source of truth), so a crash mid-archive is safe to resume. Absent -> prompts render an explicit "No round directive was provided for this round." placeholder, behavior otherwise unchanged. Relative to the process's cwd (same convention as the engine's own `data/sapwood.sqlite` default), **not** resolved relative to this config file like `roles.*.promptFile`/`goal.file`. |
| `directiveMaxChars` | `20000` | Deterministic truncation cap, in characters, on the directive text substituted into the prompts — same marked-cut-never-silent-drop contract as `roles.harvest.artifactMaxChars` / `roles.retro.digestMaxChars` above. |
| `poolFactor` | `1.5` | #212/#233: the engine computes this round's pool CANDIDATE set from Ready (milestone-scoped when `milestone` above is set) — up to `ceil(lanes.roundDispatchCap × poolFactor)` issues, ordered by `prio:*` label ascending then issue number ascending. With `roles.po.poolSelection: false` (the **default**), that full candidate set IS the pool — a deterministic MAIN path, not a fallback (see `roles.po.poolSelection` below for why: controlled testing found the selection session takes every candidate at every model tier anyway). With `roles.po.poolSelection: true`, the PO's dedicated selection session (`roles.po.poolPromptFile`) instead chooses which of those candidates actually belong in this round's pool — it may take all of them, a subset, or (rarely) none. Either way, the engine ATTEMPTS to durably record the decision (a `pool-selected` event) before any label is written, and the open backlog's labels are then RECONCILED to match it exactly — `labels.roundPool` added where missing, removed from any other open issue that has it (healing stale labels from a prior round or a cross-milestone stray as a side effect). A crash-rerun of the aligning phase replays the durable decision instead of recomputing when that event landed — never a fresh, possibly-different PO session unioning onto whatever labels the crashed attempt already applied. That event write is **best-effort today, not fail-closed**: a write failure is logged and reconciliation proceeds against the freshly-computed target regardless, so a crash immediately after a failed write only forfeits the replay optimization on the next rerun (recompute, and on the session path a second session), never correctness — reconcile still converges labels to whatever target that rerun lands on. Making the write load-bearing (fail-closed) is tracked separately by [#232](https://github.com/herehigher/sapwood/issues/232), not implemented here. The executing phase dispatches pool members only (an approved Ready issue outside the pool is never dispatched that round); the standby probe still counts an un-pooled Ready issue as work. `>1` so the candidate set absorbs gate⓪/review attrition between selection and dispatch. The pool label persists through dispatch WITHIN the same round (a dead-lane requeue stays pooled and re-dispatchable) — round close then clears the pool label from **every** open issue that still carries it, with no exemption for "dispatched this round": an issue whose PR is still open at round close loses the label just like any other undispatched member, and must re-enter the pool via a later round's own selection, never by inheriting a stale label. |

## `goal`

The loop's **north-star goal file** (#128) — the alignment yardstick the aligning (PO) and
architecting peripherals read every round, and the entry retro proposals must cite as their
basis.

| Key | Default | Meaning |
|---|---|---|
| `file` | `docs/PLAN.md` | Path to the project's north-star goal file. Same `#74`-style resolution as `worker.promptFile`: a relative path resolves against **the config file's own directory**, not the CLI's cwd. `sapwood init` scaffolds a starter template here — Goal / Non-goals / Constraints / Current milestone, each a short commented section — **iff the resolved path is missing**; it never overwrites an existing file (a second `init` run, or a crash-rerun, is a byte-for-byte no-op once the file exists). **#231:** for the aligning phase's goal-decomposition pass specifically, a missing/unreadable file is now an **explicit, fail-closed failure** — no `po-align` session is spawned, no issues are created that pass, and a durable `goal-file-unreadable` event + a `tick-error` are recorded. This never wedges the round or blocks anything else: the round-start triage pass (which never reads this file) and every other peripheral proceed unaffected, and the next round's own aligning phase retries the read fresh. (The architecting peripheral's own, independent read of this file for its architecture-chapter excerpt is unchanged — it already degrades to a visible placeholder string, never a blank one, on the same failure.) |

**Deprecated back-compat key:** `roles.architect.planMdPath` (#104) was the pre-#128 home for
this same path — it is still accepted, and the two keys are reconciled at config load into the
single resolved `cfg.goal.file` every consumer reads (align.ts's goal-alignment pass and
architect.ts's architecture-chapter extraction no longer read `roles.architect.planMdPath`
directly):

- Only `goal.file` set (or neither, defaulting to `docs/PLAN.md`) — nothing to reconcile.
- Only `roles.architect.planMdPath` set — it wins (today's pre-#128 behavior, unbroken), and
  config load logs exactly **one** deprecation line pointing at `goal.file`.
- Both set and they **agree** — resolves cleanly, no error, no deprecation noise.
- Both set and they **disagree** — a **hard config error at load**, naming both keys, rather
  than silently preferring one (an operator who set both almost certainly meant to change one
  and forgot the other was still there).

## `doctrine`

The loop's **repo-level review doctrine** (#167) — durable review knowledge (recurring technical
invariants + adjudication doctrine for how findings get treated) carried forward across rounds
instead of living only in a human/conductor's memory. Prose for LLM readers, deliberately never
a lint/DSL. Injected into the worker dispatch brief (`{{doctrine}}`), the architect pass
(`{{round.doctrine}}`), and the gate② review-trigger comment (`different-model-codex` mode,
appended after the issue's verification plan so the reviewing bot's attention is aimed at
historical failure zones on top of this PR's own acceptance criteria) — and cited by name in
the gated-PR-reentry-cap escalation comment when automatic fix attempts are exhausted. When no
doctrine file is adopted, the two **internal** prompt surfaces (worker brief, architect pass)
render an explicit "no review doctrine available" placeholder — never a silent empty
substitution — while the **public** gate② trigger comment (posted on the PR) instead appends
nothing at all, byte-identical to before doctrine existed: the internal placeholder text never
appears in a public PR comment.

| Key | Default | Meaning |
|---|---|---|
| `file` | `docs/REVIEW-DOCTRINE.md` | Path to the project's review-doctrine file. Same `#74`-style resolution as `worker.promptFile`/`goal.file`: a relative path resolves against **the config file's own directory**, not the CLI's cwd. `sapwood init` scaffolds a starter template here (technical invariants + adjudication doctrine, seeded from the loop's own distilled review history) **iff the resolved path is missing**; it never overwrites an existing file. **Unlike** `worker.promptFile`, a missing file is not an error — it's a legal, common state (a repo that hasn't adopted the convention, or has opted out): the prompts render an explicit "no review doctrine available" placeholder, behavior otherwise unchanged. |
| `maxChars` | `20000` | Deterministic truncation cap, in characters, on the doctrine text substituted into the prompts — same marked-cut-never-silent-drop contract as `round.directiveMaxChars` / `roles.architect.lastMergedMaxChars` / `roles.retro.digestMaxChars`. |

## Language customization

sapwood has no language-preference config key of its own — it doesn't need one. Every spawned
session (worker, and every peripheral role) runs as a Claude Code session inside the target
repo's own checkout, and Claude Code loads that repo's `CLAUDE.md` automatically. A language
preference — "always respond in Japanese," "write commit messages in French" — belongs there,
in the target repo's own `CLAUDE.md`, exactly like any other repo-specific working convention.
There's nothing to configure in `sapwood.config.yaml` for this.

**Caveat: keep machine-parsed surfaces in English.** A language preference in `CLAUDE.md`
naturally covers everything an agent freely composes — comments, commit messages, PR
descriptions, conversational replies. It must NOT extend to the handful of surfaces sapwood's
own engine code parses with an English-only pattern, since these are read by the engine, not by
an LLM, and a translated heading/label is invisible to a fixed regex:

- **Issue-body verification/acceptance headings** — `forge.ts`'s `extractVerificationPlan` looks
  for a heading matching `/^(#{1,6})\s*(verification|acceptance)[^\n]*$/im`. A translated heading
  (e.g. `## 検証`) is invisible to this regex — the issue reads as having no verification plan at
  all, which blocks dispatch (Decision #8) or silently routes it down the `verify:n/a` doc-gate
  path instead.
- **Labels and board `Status` values** — `type:*`/`prio:*`/`needs-human`/etc. and the ProjectV2
  `Status` field's option names are matched literally against the values `sapwood.config.yaml`
  configures; they are identifiers, not prose, and translating them just breaks the match.
- **Structured-output blocks** — the `<<<SAPWOOD_RESULT>>>`/`<<<BODY>>>` sentinels
  (`structured-output.ts`) and every role's JSON metadata keys are a fixed wire format the engine
  parses; only the free-text BODY content within them is safe to localize.

## `recovery`

| Key | Default | Meaning |
|---|---|---|
| `rollbackRetryCap` | `5` | Max retries for a durably-persisted rollback/requeue (e.g. rolling a failed claim back to `Ready`) before the conductor stops retrying and escalates to `needs-human` instead. |

## `reviewer`

Gate② — who reviews a PR before it can merge.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `different-model-codex` | The reviewer kind: `different-model-codex` (0day-style fresh non-author Codex review), `same-model-trusted` (allowlisted reviewers only), or `human` (any non-author approval). |
| `triggerCommand` | `"@codex review"` | The PR-comment text posted to request a review (`different-model-codex` mode). Non-empty string; rejected empty at parse. |
| `trustedReviewers` | `[]` | Allowlisted reviewer logins, used by `same-model-trusted`. |
| `fallback` | `[]` | Ordered, opt-in list of reviewer modes to fail over to when the primary is unavailable past `failoverAfterSec`. Each entry keeps its own mode semantics (identity allowlist for bot modes, any-non-author-approval for `human`). Empty (the default) is byte-for-byte pre-failover behavior: an unavailable primary queues the PR forever, no silent degradation. `same-model-trusted` in `fallback` with an empty `trustedReviewers` is rejected at parse — it could never produce a verdict, so the failover would be silently inert. |
| `failoverAfterSec` | `1200` (20min) | How long the primary reviewer may stay non-decisive before gate② hands off to the first fallback entry that itself reaches a decisive verdict. Irrelevant when `fallback` is empty. |
| `escalateAfterSec` | `86400` (24h) | How long a current-head review may stay non-decisive before sapwood applies `needs-human` to the PR and emits `review-silence-escalated`. This adds visibility only: the lane stays driving, polling continues, and gate② is never softened. A configured failover receives its full `failoverAfterSec` evaluation window first. |

A fallback-obtained approval is **advisory, never verdict-bearing** on its own: it's
re-verified against live PR data through the recorded mode's own rules at every use, and
the always-blocking signals (unresolved review threads, a standing
`CHANGES_REQUESTED` from anyone) block regardless of any failover state.

**Choosing a reviewer entry point (`triggerCommand`, #156):** sapwood doesn't hard-code how you
invoke a review — the default posts `@codex review`, which triggers a Codex PR-comment review,
but you can point this at any bot or reviewer entry point your workflow uses (e.g. a different
bot's mention, or your own CI-triggering comment). The verdict *parser* stays Codex-shaped for
now regardless of this setting — it looks for `COMMENTED`/`APPROVED` review states from a
Codex-bot (or `trustedReviewers`-allowlisted) identity — so a custom trigger whose reviewer posts
a different verdict shape (e.g. a differently-formatted approval comment) is not yet understood
by gate②. Custom verdict formats are out of scope here; see v1.x reviewer adapters.

## `merge`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `conductor-merge` | `conductor-merge`: once gate① (CI green) and gate② (a fresh review on the current head) both pass, the conductor squash-merges, pinned to that exact head (`--match-head-commit`, closing the TOCTOU window). `produce-pr-and-stop`: both gates are still computed and reported every tick, but the engine never calls the merge API — a human merges. |

## `labels`

The label taxonomy the loop reads and writes. GitHub label names are case-insensitively
unique but case-preserving, so sapwood normalizes every label comparison by trimming and
lowercasing both sides. `sapwood init` detects existing labels case-insensitively and sends
lowercase names when creating missing labels; re-runs still preserve existing label casing,
colors, and descriptions. It provisions all workflow labels below plus the fixed taxonomy,
formed by prepending `labels.prefix` to `type:*` and `prio:*`.

`labels.prefix` namespaces all omitted workflow-label defaults and the fixed taxonomy. Set it
to `""` to use bare names. The prefix is normalized to lowercase and may not contain
whitespace. It affects defaults only: any explicitly configured workflow label is used
verbatim, without prepending the prefix. An explicit `escalation.humanLabels` array is likewise
used verbatim.

### Upgrading from pre-#199

> [!WARNING]
> Stop sapwood and complete this label migration **before restarting the engine**. There is no
> automatic bare-label fallback: with the new default prefix, existing bare labels are ignored.

Choose one migration strategy:

1. Set `labels.prefix: ""` to keep the pre-#199 bare namespace; or
2. Rename every existing workflow, taxonomy, and dependency label into the configured namespace
   (by default `sapwood:`), on both issues and PRs. This includes `in-progress`, `needs-human`,
   `blocked`, `reserve`, `verify:n/a`, `plan:approved`, `origin:agent`, `type:*`, `prio:*`, and
   `blocked-by:N`. Remove or update any explicit workflow-label pins so they name the migrated
   labels. Also remove an explicit `escalation.humanLabels` array so it derives from the resolved
   workflow labels, or update its entries to the migrated names; it must contain the migrated
   `labels.needsHuman` value.

This is safety-critical, not cosmetic. A PR carrying only the old bare `needs-human` label no
longer holds the merge gate under the prefixed defaults. Bare `needs-human`/`blocked` issue labels
no longer hold dispatch, and a gated lane can appear human-released and re-enter automatically.
Bare `reserve`, `blocked-by:N`, and `prio:N` labels are also ignored. Pre-#199 generated configs
pin the workflow-label values and `escalation.humanLabels`, but do not contain `labels.prefix`,
so they still require `labels.prefix: ""` or a complete migration—including removing or updating
both sets of explicit pins—before restart.

| Key | Default | Meaning |
|---|---|---|
| `prefix` | `sapwood:` | Namespace for omitted workflow-label defaults and the fixed `type:*`/`prio:*` taxonomy. Empty string selects bare names. |
| `inProgress` | `sapwood:in-progress` | Applied to a claimed issue. |
| `needsHuman` | `sapwood:needs-human` | Escalation — stop autonomy on this issue/PR, ask a human. Its value must be listed case-insensitively in `escalation.humanLabels` so the written label is recognized by both PR and issue holds. |
| `blocked` | `sapwood:blocked` | Held out of the main dispatch lane. |
| `reserve` | `sapwood:reserve` | Not part of the main dispatch lane. |
| `verifyNa` | `sapwood:verify:n/a` | Marks an issue as inherently unverifiable by tests — skips the verification-plan gate and routes through the doc-gate path instead. |
| `planApproved` | `sapwood:plan:approved` | gate⓪ (#88): required, together with a genuine verification-plan section, for `getReadyIssues` to dispatch a non-`verifyNa` issue. Applied by the plan-reviewer peripheral after quality-reviewing the plan — plan *presence* alone is no longer sufficient. See [`security.md`](security.md#plan-approved). |
| `originAgent` | `sapwood:origin:agent` | Provenance stamp applied by the PO/align orchestrator to agent-created issues. See [`security.md`](security.md#origin-agent). |
| `roundPool` | `sapwood:round:pool` | #212: round-pool membership. Applied by the aligning phase's pool-selection pass to up to `ceil(lanes.roundDispatchCap × round.poolFactor)` Ready issues each round; the executing phase dispatches pool members only. Must not equal any other resolved workflow label or `escalation.humanLabels` entry — config load rejects the collision (see the note below). Cleared from **every** open issue that still carries it at round close, with no exemption (engine-only removal, see the note below). |

**`removeLabel` is pinned to `labels.roundPool` only (#212).** This is the first `IForge` write that *removes* a label, and label removal is otherwise reserved for an explicit human act — [#147](https://github.com/herehigher/sapwood/issues/147)'s gated reentry reads a human clearing `needs-human`/`blocked` as the very signal that authorizes reclaiming a lane, and gate⓪ treats `plan:approved`/`verify:n/a` presence as a human-trusted adjudication. The engine routes every `removeLabel` call through one guarded helper (`round.ts`'s `removeRoundPoolLabel`) that throws for any label other than the resolved `labels.roundPool` — no session-reachable output schema can ever drive it. Two callers use it, both engine-only, never session-driven: `align.ts`'s pool-selection reconcile pass (clears a stray pool label from any open issue outside this round's selected target, at selection time) and round close (clears the pool label from every open issue that still carries it, no exemptions). Config load additionally rejects `labels.roundPool` aliasing any other protected label, so this removal path can never be pointed at `needs-human`/`blocked`/`plan:approved`/`verify:n/a` even by misconfiguration.

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

**Ambient repo context is received by design, and recorded, not sealed (#236).** Every
role session above still runs `claude -p` inside a real repo worktree, so it
legitimately absorbs that worktree's `CLAUDE.md`, the user's global `CLAUDE.md`/
auto-memory, and the CLI's other dynamic system-prompt sections — same as any
interactive session would. This is intentional: the trust boundary here is
action-side (what a session can *do* — the empty tool allowlist above, the
credential-stripped spawn env, [#219](https://github.com/herehigher/sapwood/issues/219)),
never content-side (what it can *read*), and repo conventions living in `CLAUDE.md`
are exactly what a role session should absorb. Sealing this channel (a clean,
`--bare`-style directory with no ambient `CLAUDE.md`) is reserved for **benchmark**
runs only — see [`security.md`](security.md#ambient-repo-context-record-dont-seal-236)
for the full rationale, the isolation recipe (which MUST use `--bare`), and why that
recipe is never acceptable for production dispatch (`--bare` also disables hooks, and
the guard hook must stay live). Recorded for all **non-align** peripheral phases
today — harvest, architect, plan-review, retro; `align.ts`'s three sessions wire in
via [#232](https://github.com/herehigher/sapwood/issues/232) — every session attempt
assembles a **context manifest**: every source among a deliberately bounded,
ENUMERATED set of standard CLAUDE.md-family paths (see the manifest's own
`probedPaths`; never Claude Code's full resolution graph — imports, ancestor-directory
files, and managed policy are named, not chased, in `knownUnprobed`), each one
content-addressed inline regardless of whether it's git-tracked (a worktree-resolved
`gitCommit` survives only as ADVISORY metadata, never a recoverability guarantee — a
write-capable session could still have modified it), the model/CLI/tool-inventory/
prompt actually used (with an explicit `modelSource` discriminator — never a silent
substitution), MCP server availability, the worktree's resolved HEAD, and the
settings/guard-hook hashes — so two attempts of the same phase are independently
diffable rather than assumed comparable. The probed sources include
`<worktree>/CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, every `*.md`
recursively under `.claude/rules/`, and the user-global `CLAUDE.md` (honoring
`CLAUDE_CONFIG_DIR` when set, else `~/.claude`). The filesystem-derived half is
captured as early as the engine can observe it — anchored to the session's own
stream-json init line, never a bounded wait for the worktree directory to merely
exist (that anchor raced a real checkout once) and never at session teardown —
precisely so a write-capable session's own edits can never be mistaken for what it
started with; a `captureBasis` field on the manifest names whether that anchor
actually fired or the capture fell back to its bound.

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
| `*.fallbackModel` | `sonnet` | Every role session accepts `fallbackModel`. It supplies Claude's `--fallback-model`; set literal `"none"` to omit it and fail loud instead of silently downgrading quality. See [#168](https://github.com/herehigher/sapwood/issues/168) for the environment-failure path. |
| `planReviewer.maxDraftCycles` | `2` | gate⓪ self-heal bound (#77 Amendment 2): max draft→re-review cycles per issue when the reviewer requests a plan draft (a scoped, issues-only drafting session — never a worker lane, never an implementation). Exhausted → the loop applies `needs-human` with the attempt trail. Positive integer only — `0` would turn every draft request into an instant `needs-human`. |
| `harvest.artifactMaxChars` | `20000` | #123: cap, in characters, on the round-artifact markdown block substituted into harvest's prompt as `{{round.artifact}}` (see [`round-artifact.md`](round-artifact.md)). Deterministic truncation, same contract as `retro.digestMaxChars` below. A safety valve — the artifact is naturally small (bounded by the round's own dispatch cap). |
| `architect.lastMergedMaxChars` | `10000` | #132: cap, in characters, on the previous round's merged-PR outcomes substituted into the architect's prompt as `{{round.lastMerged}}` — read from the persisted round artifact (`round_artifacts`, see [`round-artifact.md`](round-artifact.md)), never a live forge read. Numbers-only content (issue/PR/worker, no titles or files-touched — not persisted in the ledger), so the default is smaller than either sibling cap above. Same deterministic-truncation, marked-cut contract. |
| `retro.promptFile` | unset | Override the retro/self-evolution peripheral's prompt (same `#74` pattern). Unset uses the engine's shipped `prompts/retro.md`. |
| `retro.everyNRounds` | `1` | Retro cadence (#104): `1` runs every round; `N > 1` skips every round whose id isn't a multiple of `N` (the phase still closes, marker still set — never wedges the round). |
| `retro.digestMaxChars` | `60000` | Hard cap, in characters, on the engine-built round-scoped read digest (#111 PR-A) substituted into retro's prompt as `{{round.digest}}` — PR diffs + review signals for every PR the round touched, comments/labels for every escalated issue, and the round's commit history. Oversize digests are truncated **deterministically** (same prefix every time for the same content+cap) and the cut is marked in the digest text itself, never silently dropped. |
| `po.backlogDigestMaxChars` | `20000` | Hard cap, in characters, on the milestone-scoped open-issue digest substituted into PO align prompts as `{{backlog.digest}}`. The engine assembles issue numbers, titles, and configured human-hold label annotations at invocation time; zero issues and read failure render distinct explicit notes. **#231:** truncation is now **whole-record** — an issue line either fits in full or is counted as omitted, never sliced mid-line, so a truncated digest can never silently drop the high-numbered tail with no trace; the marker names how many issues were rendered vs. omitted out of the total, and the same counts are recorded in the engine's `input_manifest` table (#231, migration v13->v14) — a durable, best-effort record of what a peripheral session actually saw (read status, content version/hash, counts, truncation), never itself a gate on anything. **Coverage today** is scoped to the channels align.ts itself dispatches a session with — goal file + backlog digest (`po-align`), issue body + backlog digest (`po-triage`), pool candidates (`po-pool`); architect/round-context channels (`architect.lastMergedMaxChars`'s `{{round.lastMerged}}`, the architecture-chapter excerpt, candidate-issue details, doctrine, the round directive) are not yet recorded here — tracked under [#232](https://github.com/herehigher/sapwood/issues/232), which also covers making the manifest load-bearing rather than record-only. **#231:** a failed open-issue read (the digest read itself, not a transient blip elsewhere) now **suppresses issue creation for that align pass entirely** — zero `createIssue` calls, a durable `backlog-read-failed` event recorded — rather than letting the align session create against an invisible/placeholder inventory with no real duplicate detection; the `po-align` session itself still runs (it may still propose issues, which are journaled for audit but not created this pass), and the round-start triage pass is unaffected either way. The next round's own aligning phase retries the read fresh. Minimum `200`. Custom PO prompt files may omit the variable. #212: also reused, unmodified, as the cap on the round-pool selection session's candidate digest (`poolPromptFile` below) — naturally far smaller (bounded by the pool cap), so this is a safety valve there too; the same whole-record truncation fix applies there. |
| `po.poolPromptFile` | unset | #212: override the round-pool **selection** session's prompt — a separate template from `po.promptFile` (align/triage). Same `#74` pattern: a relative path resolves against the config file's own directory. Unset uses the engine's shipped `prompts/po-pool.md`. Only consulted when `roles.po.poolSelection: true` (below) — this session receives the engine-computed candidate digest — the top `ceil(lanes.roundDispatchCap × round.poolFactor)` Ready issues, prio-ordered — and returns which of those issue NUMBERS belong in this round's pool; the engine applies `labels.roundPool` to exactly that (validated) selection. The output schema carries issue numbers only — no label name ever appears in it, so the round-pool label-removal containment invariant (see the `labels` table above) cannot be affected by this session's output even in principle. |
| `po.enabled` | `true` | #127: switch the `aligning` phase's PO **align/triage sessions** (goal-alignment decomposition + the round-start plan-triage pass) off for this deployment. **#233: this no longer affects round-pool selection at all** — that is governed solely by `po.poolSelection` below, independently. `false` → the align/triage session is skipped; `round-defaults.ts`'s `createDefaultPeripherals` OMITS just that portion, never the whole `aligning` phase (round-pool selection still runs). **Warning:** with the PO off, plan-less issues are never triaged into the gate⓪ pipeline (no plan drafting, no decomposition) — they must arrive with a verification plan already in the body, or a human/external process must draft one, before gate⓪ can ever approve them. |
| `po.poolSelection` | `false` | #233: switch the round-pool **selection session** on, independently of `po.enabled` above. Default `false` → the round pool is the deterministic top-cap candidate set every round (`round.poolFactor` above) — the MAIN path, not a fallback; no session spawned; the `pool-selected` event write is still attempted (best-effort, see `round.poolFactor` above) and labels still reconciled exactly as before. `true` → restores the #212 session behavior unchanged: a dedicated PO session (`po.poolPromptFile`) picks a validated subset of the candidate digest, invalid/failed-twice degrades OPEN to the full candidate set (never an empty pool). **Why the default flipped:** controlled experiments across model tiers found this title/number-only session selects EVERY candidate at every tier — it has no evidentiary basis to narrow the reservoir from a bare digest, so it just pays for a session to reproduce the deterministic fallback it would otherwise degrade to. Worse, `round.poolFactor` exists specifically to *over*-select and absorb architect/gate⓪ attrition after selection; a session that actually narrows the reservoir risks underfilling the round. The one non-trivial selection ever observed traced back to contaminated test context, not a real judgment made from candidate titles/numbers alone. **Benchmark note:** if you re-run this experiment, isolate worktree/code reads for that evaluation — production `po-pool` sessions may read the repo like any other role session, but that access is an uncontrolled signal specifically for this experiment (the session's intended input is titles/numbers only). |
| `architect.enabled` | `true` | #127: switch the `architecting` phase off, same mechanism as `po.enabled` above. |
| `planReviewer.enabled` | `true` | #127: switch the WHOLE gate⓪ unit off — the plan-reviewer AND its plan-drafter, which rides along (the drafter has no toggle of its own; it only ever runs from inside the `plan_review` phase). Same omit-the-stub mechanism as `po.enabled` above. **Warning — this can starve dispatch entirely:** the dispatchability gate (deliberately, PLAN Decision #8) still requires every issue without `labels.verifyNa` to carry `labels.planApproved`, and the plan-reviewer is the only thing in the engine that applies it. With gate⓪ off, a human or external process MUST apply `labels.planApproved` (or `labels.verifyNa`) to each issue — otherwise nothing is ever dispatched. The engine repeats this warning in the startup log when the role is disabled. |
| `harvest.enabled` | `true` | #127: switch the `harvesting` phase off, same mechanism as `po.enabled` above. |
| `retro.enabled` | `true` | #127: switch the `retro` phase off, same mechanism as `po.enabled` above. |

Every `enabled: false` above is logged **once**, at the point `createDefaultPeripherals`
builds the peripherals map (engine startup) — never re-logged per round or per tick.

## `guard`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `hard` | `hard`: fail-closed deny — the actual producer≠merger/boundary-write enforcement. `soft`: observe-only — log what would be blocked, but allow it. `soft` is a first-run/dogfood affordance only, never the shipped default; it reaches the hook via a spawn env a worker cannot itself rewrite. |

## `envFailure`

Environment-failure park (#168) — detect an LLM-provider or forge outage as ONE class distinct
from an ordinary task failure, park the engine (no new dispatch) instead of escalating the
issue or spending a gated-reentry attempt, self-heal via a bounded backoff probe, and — only
past a configurable park *duration* — additionally notify a human. Episodes are tracked **per
source** (an `llm` episode and a `forge` episode can be open simultaneously — a mixed storm);
dispatch resumes only when *every* open episode has cleared. See
[`troubleshooting.md`](troubleshooting.md#environment-failure-park-168) for what a parked engine
looks like and what to do about it.

Pattern matching is deterministic (a case-insensitive regex match against a FAILED lane's own
**structured error output** — the process's stderr lines plus errored stream-json result/error
records, never assistant message content, so a worker legitimately *working on* rate-limit
handling whose messages print the exact signature strings stays an ordinary task failure) —
never an LLM judgment call. Every pattern is compiled at config load: a malformed regex, an
empty pattern array, or a backoff cap below the base is a fail-fast startup error (`sapwood
validate` catches all three).

| Key | Default | Meaning |
|---|---|---|
| `llmPatterns` | see `sapwood.config.yaml` | Regex patterns (case-insensitive, compiled/validated at load, non-empty) matched against a FAILED lane's structured error output to classify it as an LLM-provider environment failure — `rate_limit_error`, `usage limit reached`, `credit balance is too low`, `insufficient_quota`, `overloaded_error`, `429 too many requests`, etc. |
| `forgePatterns` | see `sapwood.config.yaml` | Same matching, for a forge (GitHub) environment failure — `could not resolve host`, `connection refused`, `network is unreachable`, `bad gateway`/`gateway timeout`/`service unavailable`, `bad credentials`, `401 unauthorized`, `gh auth login`, etc. |
| `parkEscalateAfterSec` | `3600` (1h) | Park **duration** per episode (not probe count — bounded exponential backoff makes a count an ambiguous measure of elapsed time) past which the engine additionally notifies a human via the channel ladder. Additive, never a state transition — probing/auto-resume continue unaffected either side of an escalation. The clock runs from the episode's FIRST detection and is never reset by further failures (including failed recovery canaries) within the same episode. |
| `probeBackoffBaseSec` | `30` | Initial probe interval while parked (the first probe waits a full base interval — never fires on the same tick the park began). |
| `probeBackoffMaxSec` | `1800` (30min) | Cap on the bounded exponential backoff (`base * 2^attempts`, capped here). Must be >= `probeBackoffBaseSec` (validated at load). |
| `probeModel` | `haiku` | The model the llm-source **ping probe** runs on — deliberately the cheapest tier, independent of `worker.model`. Point it at whatever your account's cheapest alias is. |
| `probeTimeoutSec` | `30` | Hard timeout on one ping — a hung CLI is killed and counted as a failed probe, never allowed to wedge a tick. |
| `probeMaxBudgetUsd` | `0.05` | `--max-budget-usd` for one ping. **Don't set this below ~$0.02**: even fully stripped, a `-p` invocation still carries ~7.4k CLI scaffolding tokens, so the real floor is >$0.01 (~$0.016 measured) — a too-low cap makes **every** probe fail with `Error: Exceeded USD budget (…)` and the engine stays parked until the duration escalation notifies a human (fail-safe, but confusing). The failing probe's error line is recorded in each `park-probe` event so the symptom names itself. |

**How each source recovers:**

- **`forge`** — the probe is an existing lightweight read-only `IForge` call; its success is a
  genuine recovery signal and clears the forge episode outright. While a forge episode is open,
  env-failure issue-requeues are **suspended** (persisted durably, zero forge writes, retry
  counter frozen) and drain automatically on resume; they are exempt from the rollback retry cap
  and never degrade to `needs-human`. Dispatch resumes on the tick **after** the recovery
  probe, not the recovery tick itself — that ordering lets the outage victim's held requeue
  drain (rollback retry runs at the top of a tick, before dispatch) so other Ready issues can't
  race it into the freed lanes.
- **`llm`** — the probe is a **minimal inference ping** (same `CLAUDE_BIN` resolution as a real
  dispatch):

  ```
  claude -p --model <probeModel> --no-session-persistence \
    --system-prompt "You are a heartbeat responder. Only output the requested word." \
    --strict-mcp-config --tools "" \
    --max-budget-usd <probeMaxBudgetUsd> --output-format text \
    "Respond with the single word 'pong' and nothing else."
  ```

  Success = clean exit + a reply that is exactly `pong` (case/whitespace-normalized equality —
  a refusal *containing* the word never counts). The custom system prompt replaces the CLI's
  default one and `--strict-mcp-config`/`--tools ""` strip MCP servers and tool schemas — the
  smallest request the CLI supports; `--no-session-persistence` keeps probe runs off the disk.
  **Honest cost:** ~$0.016 per ping measured (the CLI still sends ~7.4k scaffolding tokens plus
  ~240 output tokens even fully stripped) — at `probeBackoffMaxSec` pacing that is still
  negligible per day. Because the ping is *paid*, it is suppressed while a hard cost/wall-clock
  ceiling breach is active (a spend-safety boundary must not itself keep spending) and while
  dispatch is paused (`data/PAUSE` blocks the canary the ping exists to unlock) — the free
  forge probe keeps running in both states, and duration escalation is unaffected. A canary
  stopped by a **drain** (kill switch / ceiling) is settled *inconclusive*: the canary slot is
  released and the episode continues unchanged — a drain says nothing about the provider, so
  it neither clears the episode nor grows the backoff; the next backoff step simply pings
  again. The ping proves network + auth + *some* account capacity on the cheapest model —
  but **not** that the worker's own model/tier has quota (model-specific caps,
  primary-model-only overload), so a green ping is only a *gate*, never a recovery signal.
  When the backoff interval elapses and the ping succeeds (and no forge episode is open), the
  engine dispatches exactly **one canary lane**. The llm episode clears only when that canary
  reaches a terminal state that is *not* itself env-classified; a canary that env-fails
  continues the *same* episode — the entry time (and therefore the escalation clock) is
  preserved and the backoff keeps growing, so a persistent outage costs one ping + one canary
  per backoff step, never a full-queue redispatch cycle. A broken CLI needs no separate check:
  the ping simply fails — and an **older CLI lacking these flags** fails every probe with
  `error: unknown option …` (the symptom is a permanently parked engine whose `park-probe`
  events name the unknown option; the remedy is upgrading the CLI — these flags exist as of
  2.x). Every failed ping records its first error line in the `park-probe` event, so
  "provider still down" (a 429), "budget cap too low" (`Exceeded USD budget`), and "CLI too
  old" (`unknown option`) are all distinguishable from the event ledger.

**Escalation channel ladder:** an `llm`-sourced escalation with the forge healthy notifies via a
comment on the issue whose lane triggered the episode; a `forge`-sourced escalation — or an
`llm`-sourced one during a mixed storm whose forge episode is also open — never attempts a
GitHub write at all: it falls back to `sapwood status`, a local `ESCALATION` file in the
engine's data dir (written by the engine, read-only informational output, never a control input
— unlike `KILL_SWITCH`/`PAUSE`; removed automatically once the outage resolves), and a log
line. The escalation event records the channel *actually* used, including a comment attempt
that failed and degraded to local.

## `escalation`

| Key | Default | Meaning |
|---|---|---|
| `humanLabels` | `[sapwood:needs-human, sapwood:blocked]` | When omitted, derives from `labels.prefix`. Any matching label on an issue means "stop autonomy, ask a human" for that issue. An explicit array is used verbatim and must list `labels.needsHuman` case-insensitively so PR and issue holds recognize the same escalation label. |

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
