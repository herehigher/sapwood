# Cost ceilings

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for cost ceilings vs. the soft worker budget.

## Cost ceilings vs. the soft worker budget

Two different things are both called "budget": `worker.budgetUsdSoft` is a **soft** per-worker
trigger that hands a lane off gracefully; `cost.dailyBudgetUsd` and `cost.maxWallClockSec` are
**hard**, engine-wide ceilings that freeze new dispatch and drain.

| Invariant | Enforcement point | Test |
| --- | --- | --- |
| `worker.budgetUsdSoft` is a SOFT per-worker cap from a live token-usage ESTIMATE (stream-json has no in-progress `total_cost_usd`; rate-tabled via `pricing.yaml`/`pricingFile`, cache reads at the cache-read rate). Crossing it requests a graceful handoff — SIGTERM, a `.handoff` sentinel with a resumable session id — never a mid-work `SIGKILL`. | `worker.ts::checkSoftBudget`, `requestHandoff` | `worker.test.ts:3908`: "crossing worker.budgetUsdSoft mid-run triggers requestHandoff exactly once ... ends up .handoff (graceful), never .failed" |
| The estimate is reconciled against the real terminal `total_cost_usd` at lane finish (divergence logged, not enforced) — a trigger signal only; `worker.timeoutSec` plus the hard ceilings below are the actual backstop. | `worker.ts::writeTerminalSentinel` | `conductor.test.ts:2435`: "reclaim-done carries costEstimated: true when the probe's settled cost is itself the pinned-price estimator's figure, never a real provider total" |
| A handed-off lane may re-enter once capacity/spend gates permit; each resumed leg gets a FRESH soft budget (baseline-subtracted, so a leg that handed off AT the budget doesn't instantly re-fire), bounded by `worker.maxResumes` (default 2) — a second handoff past the cap engine-splits rather than resuming forever. | `worker.ts::checkSoftBudget`/`resume()` | `worker.test.ts:4051`; `conductor.test.ts:9986`: "a second handoff past maxResumes engine-splits exactly once and is never selected again" |
| Each resumed leg's `total_cost_usd` ledgers per-leg (never cumulative), so total recorded spend sums the real legs rather than double-counting a resumed run's pre-handoff stream. | `worker.ts::writeTerminalSentinel` (`jsonlLegOffset`) | `worker.test.ts:4051` |
| `cost.dailyBudgetUsd` (durable UTC-day ledger sum, survives restarts) and `cost.maxWallClockSec` (per-process alarm, reset by any restart) are HARD ceilings; breaching either freezes new dispatch — fresh worker legs and FIXUP fix-leg spawns only — and drains running/fixing lanes within `cost.drainWindowSec` before a hard kill. | `conductor.ts::evaluateCeiling`, `drainThenEscalate` | `conductor.test.ts:6374`: "an engine-wide ceiling breach (daily budget) blocks a FIXUP dispatch — stays driving, queued, no fix leg spawned" |
| A ceiling breach does NOT gate an already-driving lane's own review/merge progression — `gate.driveOne` and the merge driver carry no ceiling check, so a lane awaiting re-review can still merge for free the instant review lands. | `conductor.ts` DRIVE loop (no ceiling read); `roles/merge-driver.ts` | `conductor.test.ts:8730`: "a driving lane in WAIT ... is NEVER escalated, even past the drain window: it can still merge for free the instant review lands" |
| A decisive engine-agent review verdict ledgers its OWN session spend under a key distinct from the reviewed lane (`<lane>:engine-review`), in the same transaction as the verdict event; a non-decisive attempt (retries exhausted, setup failure, a D5 same-model refusal) records ZERO ledger rows. | `review/production.ts::recordWalDecisiveOutcome`, `state.ts::recordEngineReviewVerdictAndSpend` | `production.test.ts:332`; `production.test.ts:403`: "a NON-decisive (unavailable) engine-agent attempt records ZERO spend_ledger rows" |
| That review-session spend counts toward BOTH `cost.dailyBudgetUsd` and `cost.roundBudgetUsd` — both read `spend_ledger` as a plain, worker-unfiltered `SUM(usd)`, so a review session banks against either ceiling like any other spend. | `state.ts::dailySpendUsd`; `round.ts`'s `spentSoFar`/`state.ts::spentUsdSince` | `production.test.ts:389`: "cost ceilings (roundBudgetUsd/dailyBudgetUsd) see the review session's spend — both read spend_ledger as a global, worker-unfiltered sum" |
| Every real spend site stamps `actor_kind` (`worker`\|`fix-leg`\|`peripheral-role`\|`engine-review`), `role`, and `estimated`; a row with no `actor_kind` lands in `unclassifiedUsd`, never silently zero. | `state.ts::recordSpend`/`settleTerminalWorker`; `peripheral.ts::runSessionWithRetry` | `spend-attribution.test.ts` (cross-artifact call-site oracle); `state.test.ts:4154` |
| The read-model's spend section (`buildSpendSection`) reports `settledByWorker`/`settledByRole`/`reviewUsd` plus a COMPLEMENT-query `unclassifiedUsd`; `incomplete` is true whenever `unclassifiedUsd > 0` OR `reviewer.mode` is `engine-agent` — the latter's deliberate-absence posture means `incomplete: false` is only reachable outside engine-agent review. | `state/read-model.ts::buildSpendSection` | `status-json.test.ts:199`, `:234`, `:263` |

**Boundaries**

- The live soft-budget estimate is blind to a spawned worker subagent's own spend — see [Worker denylist vs. peripheral allowlist](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry) for the accepted gap.
- A ceiling breach freezes new WORKER-shaped dispatch only (fresh legs, fresh FIXUP spawns); it never gates a peripheral role session (po-triage/po-align/architect/plan-review/harvest/retro) — `peripheral.ts` carries no ceiling check of its own.
- An in-flight worker/fix leg already running is drained (SIGTERM, a chance to hand off cleanly), never instantly killed — escalation to a hard kill waits for `cost.drainWindowSec` to elapse.
- Pre-`actor_kind` rows read `actor_kind IS NULL` forever and render `unclassified` — no migration/backfill, same never-guess stance as every other unattributed row.
- Entering a breach emits one reason-bearing `ceiling-breach-entered` event per episode; in both directions (soft budget, hard ceilings) the design favors drain-then-escalate over an immediate hard stop.

**Supervisor prerequisite.** Operators running unattended MUST configure the supervisor's own
crash-loop circuit-breaker (e.g. systemd's `StartLimitBurst=5`/`StartLimitIntervalSec=600`) —
sapwood assumes it; a crash loop shows up only in the supervisor's own restart counters, so alert
there, not on sapwood.

Defense-in-depth behind that assumption, never a substitute: `engine.rapidRestart` (default 5
starts/10min) parks dispatch with an escalation on its own observed crash-loop, and the
single-instance data-dir lock stops a supervisor's fast restarts from ever double-driving one
board. Either way, a crash loop's blast radius stays bounded by `dailyBudgetUsd` and the merge
gates.
