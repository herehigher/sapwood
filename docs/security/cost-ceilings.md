# Cost ceilings

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for cost ceilings vs. the soft worker budget.

## Cost ceilings vs. the soft worker budget

Two different things are both called "budget": `worker.budgetUsdSoft` is a **soft** per-worker
trigger that hands a lane off gracefully; `cost.dailyBudgetUsd` and `cost.maxWallClockSec` are
**hard**, engine-wide ceilings that freeze new admission and drain.

| Invariant | Enforcement point | Test |
| --- | --- | --- |
| `worker.budgetUsdSoft` is a SOFT per-worker cap enforced from a live token-usage ESTIMATE, never the real `total_cost_usd`. | `worker.ts::checkSoftBudget` | `worker.test.ts:3908` |
| The estimate is rate-tabled via `pricing.yaml`/`worker.pricingFile`; cache reads price at the cache-read rate, not the input rate. | `pricing.ts::estimateUsd` | `pricing.test.ts:26` |
| Crossing the soft budget requests a graceful handoff — a `.handoff` sentinel with a resumable session id — never a mid-work kill. | `worker.ts::checkSoftBudget`/`requestHandoff` | `worker.test.ts:3908` |
| The estimate reconciles against the real terminal cost at lane finish; divergence is logged, never enforced. | `worker.ts::writeTerminalSentinel` | `conductor.test.ts:2435` |
| The soft budget is a trigger signal only — `worker.timeoutSec` plus the hard ceilings below are the real backstop. | `worker.ts::writeTerminalSentinel` | `conductor.test.ts:2435` |
| A handed-off lane re-enters before fresh dispatch, once capacity and spend gates permit. | `worker.ts::resume()` | `worker.test.ts:4051` |
| Each resumed leg gets a FRESH soft budget, baseline-subtracted so a leg that handed off AT the budget doesn't instantly re-fire. | `worker.ts::checkSoftBudget` | `worker.test.ts:4051` |
| Resume is bounded by `worker.maxResumes` (default 2); a second handoff past the cap engine-splits rather than resuming forever. | `conductor.ts` (cap latch) | `conductor.test.ts:9986` |
| A cap-split child's body already carries the origin marker, so it never re-splits — it escalates to needs-human instead. | `conductor.ts` (`CAP_SPLIT_ORIGIN_MARKER` check) | `conductor.test.ts:10098` |
| Each resumed leg's `total_cost_usd` ledgers per-leg, so total recorded spend sums the real legs. | `worker.ts::writeTerminalSentinel` (`jsonlLegOffset`) | `worker.test.ts:4051` |
| `cost.dailyBudgetUsd` is a durable UTC-calendar-day ledger sum that survives restarts. | `config/config.ts` schema; `state.ts::dailySpendUsd` | `config.test.ts:41` |
| `cost.maxWallClockSec` is a per-process alarm, reset by any restart — NOT a durable security boundary. | `config/config.ts` (schema comment) | `conductor.test.ts:10707` |
| The durable cross-restart bounds are `dailyBudgetUsd` plus guard/gates/kill-switch — never the wall clock. | `config/config.ts` (schema comment) | `conductor.test.ts:10707` |
| A breach freezes fresh worker-leg dispatch — every Ready issue is skipped with reason `ceiling`. | `conductor.ts` (DISPATCH loop, per-issue `ceilingBreached` check) | `conductor.test.ts:10550` |
| A breach also blocks RESUME of handed-off lanes and FIXUP fix-leg spawns — the same admission gate as fresh dispatch. | `conductor.ts` (`resumeSpendPaused`; fix-leg admission) | `conductor.test.ts:11029`; `:6374` |
| A breach also skips the paid llm recovery probe, so a live-outage check never spends past an open ceiling. | `conductor.ts:6019` (llm-probe gate, `!ceilingBreached`) | no dedicated unit test found (source-verified only) |
| A breach also drains running/fixing lanes within `cost.drainWindowSec`, same drain-before-kill posture as the kill switch. | `conductor.ts::drainThenEscalate` | `conductor.test.ts` (drain-window tests) |
| A breach does NOT gate an already-driving lane merely awaiting re-review — it can still merge for free. | `conductor.ts` DRIVE loop (no ceiling read); `merge-driver.ts` | `conductor.test.ts:8730` |
| A driving lane whose OWN fix leg the breach blocks THIS TICK is force-escalated to needs-human past the drain window. | `conductor.ts::drainThenEscalate` (observed arm) | `conductor.test.ts:8692` |
| A breach withholds opening a NEW round; the first round of a process life always opens unconditionally. | `round.ts::waitForDispatchClear` | `round.test.ts:5600` |
| `ceiling-breach-entered` fires once per episode, never re-announced while the same breach stays open. | `conductor.ts::reconcileCeilingAnnouncements` | `round.test.ts:5557` |
| A decisive engine-agent verdict ledgers its OWN spend under `<lane>:engine-review`, distinct from the reviewed lane's name. | `production.ts::reviewSpendWorkerKey` | `production.test.ts:332` |
| That write lands in one transaction with the verdict event and the WAL decisive-outcome write. | `state.ts::recordEngineReviewVerdictAndSpend` | `production.test.ts:332` |
| A non-decisive review attempt (retries exhausted, setup failure, a D5 refusal) records ZERO ledger rows. | `production.ts` | `production.test.ts:403` |
| `cost.dailyBudgetUsd` and `cost.roundBudgetUsd` both read `spend_ledger` as a plain, worker-unfiltered `SUM(usd)`, so a review session's spend counts toward either ceiling. | `state.ts::dailySpendUsd`/`spentUsdAfterId` | `production.test.ts:389` |
| Every real spend site stamps `actor_kind` (`worker`\|`fix-leg`\|`peripheral-role`\|`engine-review`). | `state.ts::recordSpend` | `spend-attribution.test.ts` |
| `role` is populated for `peripheral-role` rows only — every other actor kind carries a null role. | `state.ts::recordSpend`; `peripheral.ts::runSessionWithRetry` | `state.test.ts:4154` |
| `estimated` is a 0/1 tri-state (NULL when never classified), recording whether a real provider total or the pinned-price estimator fed the cost. | `worker.ts::writeTerminalSentinel` | `conductor.test.ts:2435` |
| `unclassifiedUsd` is the COMPLEMENT of the three positive buckets — a corrupt `actor_kind` or a role-less `peripheral-role` row lands here, never vanishing. | `state.ts::spendSummaryForDay` | `state.test.ts:1840` |
| `incomplete` is true whenever `unclassifiedUsd > 0` OR `reviewer.mode` is `engine-agent`. | `read-model.ts::buildSpendSection` | `status-json.test.ts:234` |
| Under engine-agent mode `incomplete: false` is unreachable — a non-decisive review can leave no ledger row despite real cost. | `read-model.ts::buildSpendSection` | `status-json.test.ts:263` |

**Boundaries**

- The live soft-budget estimate is blind to a spawned worker subagent's own spend — see [Worker denylist vs. peripheral allowlist](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry) for the accepted gap.
- A ceiling breach does not reach peripheral role sessions of a round that is ALREADY open: `peripheral.ts` carries no ceiling check of its own, so the round's closing harvest/retro sessions still spend after the freeze. A NEW round is withheld while breached, except the first round of a process life, which always opens.
- An in-flight worker/fix leg already running is drained (a chance to hand off cleanly), never instantly killed — escalation to a hard kill waits for `cost.drainWindowSec` to elapse.
- Pre-`actor_kind` rows read `actor_kind IS NULL` forever and render `unclassified` — no migration/backfill, same never-guess stance as every other unattributed row.
- A non-decisive review attempt records nothing to the ledger — its cost is real but visible only in that attempt's own WAL artifact, so both `dailyBudgetUsd` and `roundBudgetUsd` under-count it.
- In both directions (soft budget, hard ceilings) the design favors drain-then-escalate over an immediate hard stop.

**Supervisor prerequisite.** Operators running unattended MUST configure the supervisor's own
crash-loop circuit-breaker (e.g. systemd's `StartLimitBurst=5`/`StartLimitIntervalSec=600`) —
sapwood assumes it; a crash loop shows up only in the supervisor's own restart counters, so alert
there, not on sapwood.

Defense-in-depth behind that assumption, never a substitute: `engine.rapidRestart` (default 5
starts/10min) parks dispatch with an escalation on its own observed crash-loop, and the
single-instance data-dir lock stops a supervisor's fast restarts from ever double-driving one
board. Either way, a crash loop's blast radius stays bounded by `dailyBudgetUsd` and the merge
gates.
