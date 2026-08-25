# Cost ceilings

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for cost ceilings vs. the soft worker budget.

## Cost ceilings vs. the soft worker budget

Two different things are both called "budget," and they behave differently on purpose:

- **`worker.budgetUsdSoft`** is a **soft** per-worker budget, auto-enforced via a live
  token estimate. stream-json carries no in-progress `total_cost_usd` (only the
  terminal result line has that), so the worker accumulates a running USD estimate
  from every streamed assistant message's token usage (priced by a small, explicitly
  approximate per-model rate table — the shipped `pricing.yaml`, overridable via
  `worker.pricingFile` — with cache reads priced at the cache-read rate, not the
  input rate, so a cache-heavy run doesn't look artificially expensive). Crossing
  the threshold triggers a graceful handoff — finish the current atomic step, commit +
  push WIP, write a progress note, drop a `.handoff` sentinel carrying a resumable
  session id, exit clean — **never** a mid-work `SIGKILL`. A hard kill mid-step both
  burns the spend and throws away the work; a graceful handoff preserves both. The
  estimate is reconciled against the real terminal cost when a lane finishes (the
  divergence is logged, not enforced) — it is a trigger signal, not a billing source
  of truth, so `worker.timeoutSec` plus the hard ceiling below remain the actual
  backstop. A handed-off lane re-enters before fresh dispatch when capacity and spend
  gates permit. Each resumed leg gets a fresh soft budget, bounded by
  `worker.maxResumes` (default 2); resumed `total_cost_usd` is per-leg and is ledgered
  directly, so total recorded spend is the sum of the real legs. The live estimate this
  bullet describes is blind to a spawned subagent's own spend — see the paragraph
  under [Worker denylist vs. peripheral allowlist](role-sessions.md#worker-denylist-vs-peripheral-allowlist-deliberate-asymmetry)
  above for the measured size of that gap and why it's accepted unbounded.
- **`cost.dailyBudgetUsd` / `cost.maxWallClockSec`** are **hard** engine-wide ceilings.
  Breaching either freezes new dispatch/merges and starts draining in-flight workers
  (`cost.drainWindowSec`'s grace window), same "drain before kill" posture as the kill
  switch: give a worker the chance to hand off cleanly, and only escalate to a hard
  process-tree kill once the drain window elapses. Their roles differ:
  `dailyBudgetUsd` is the **durable** runaway-spend boundary — a UTC-calendar-day
  ledger sum that survives restarts. `maxWallClockSec` is a **per-process attention
  alarm** — one clock per process life, anchored at process start in memory, fresh on
  every restart at any gap length. A restart is a *sanctioned* renewal (manual, script,
  or a user-configured supervisor — the human's standing intent); the durable
  cross-restart bounds are money (`dailyBudgetUsd`), gates, guard, and the kill switch,
  never the wall clock. Entering a breach emits a reason-bearing
  `ceiling-breach-entered` event once per episode.

**Engine-agent review-session spend.** Under
`reviewer.mode: engine-agent`, gate②'s review session is itself a paid Claude session — its cost
reaches `spend_ledger` too, recorded once a verdict is decisive
(`review/production.ts`'s `recordWalDecisiveOutcome`, via `State.recordEngineReviewVerdictAndSpend`),
so `dailyBudgetUsd`/`roundBudgetUsd` (both plain, worker-unfiltered `SUM(usd)` reads) count it
like any other spend. The verdict-announcing event, the WAL's `decisive_outcome` write, and this
spend all land in **one SQLite transaction** — doing this as separate writes (event
first, spend last) would let a crash between them leave the verdict durably recorded while the spend
silently, permanently never lands (the event's own existence is the replay dedup memory, so a
retry would read "already handled" and skip the spend forever). It is ledgered under a key
**distinct** from the reviewed lane's own worker name (`<lane>:engine-review`), deliberately:
recording it under the lane's own name would make `State.getWorkerActualModels(issue)` — keyed
on an exact `worker` match — pick up the reviewer's own model as one of "the producing lane's
actual models," poisoning engine-agent.ts's D5 same-model check on that lane's next review (a
fix-round re-review would then see the reviewer overlapping itself and fail closed forever). A
review attempt that never reaches a decisive verdict (all retries exhausted, a setup failure, a
D5 same-model refusal) still records nothing to the ledger — its cost is real but stays visible
only in that attempt's own WAL artifact; this mirrors the whole-logical-review cap, which
reads the WAL, never the ledger, for the exact same reason. **This attributes what IS recorded —
it does not widen this**: the deliberate-absence posture for non-decisive attempts is unchanged,
still no ledger row of any kind for one.

**Durable spend attribution.** `spend_ledger` carries three additional columns, written by
every real spend site: `actor_kind` (`worker` | `fix-leg` | `peripheral-role` | `engine-review` —
conductor.ts's reclaim path sets the first two from whether the terminal lane was a `fixing`-origin
leg; peripheral.ts's shared `runSessionWithRetry` sets `peripheral-role` for every po-align/
po-triage/architect/plan-review/harvest/retro session; production.ts's decisive-verdict callback
above sets `engine-review`), `role` (the peripheral role id, `peripheral-role` rows only), and
`estimated` (0/1, tri-state — NULL when a caller never classified the distinction). `estimated` is
populated at every terminal settlement, worker/fix-leg rows included: `worker.ts`'s
`writeTerminalSentinel` persists which of "a real provider-reported `total_cost_usd`" vs. "the
pinned-price estimator's substitute" fed the recorded cost, threaded through `LaneProbe.costEstimated`
into `conductor.ts`'s terminal `settleTerminalWorker` calls, alongside the engine-review site's own
pre-existing `ReviewSessionSpend.kind` distinction — see docs/guide/supervision.md's Est-vs-real cost
method for how this feeds the estimator-bias query. Pre-v1, plain schema bump: no
migration/backfill for rows written before this — they read `actor_kind IS NULL` forever,
rendered `unclassified` by the read-model (`State.spendSummaryForDay`), same "never guess" stance
as every other unattributed row. `spendPage` (the raw `/api/spend` paging transport) surfaces all
three columns verbatim too — its own "the ledger's own columns" doc now matches what it returns.

The shared read-model's spend section (`status --json`'s `spend` key) reports the real
`lanes`/`roles`/`review` split (`settledByWorker`/`settledByRole`/`reviewUsd`) plus the
`unclassifiedUsd` leftover bucket — now a COMPLEMENT query (every row not validly matching one of
the three positive buckets, including a corrupt/unrecognized `actor_kind` value or a
`peripheral-role` row missing its `role`), not an `actor_kind IS NULL`-only query, so a
malformed row can never silently vanish from every total — and its `incomplete` flag.
`incomplete` is true whenever `unclassifiedUsd > 0` **or** `reviewer.mode` is `engine-agent`
(the schema default): the deliberate-absence posture above means a non-decisive review attempt's
cost can be real yet leave **no ledger row of any kind**, so `unclassifiedUsd` alone can never
prove the day is complete under that mode — `incomplete: false` is only reachable under a
non-engine-agent reviewer mode. See `state/read-model.ts`'s `StatusSpendDTO` doc for the exact
identity `todayUsd` holds by construction.

**Supervisor prerequisite:** operators running unattended under a supervisor
MUST configure the supervisor's own crash-loop circuit-breaker — e.g. systemd's
`StartLimitBurst=5` / `StartLimitIntervalSec=600` (or the equivalent restart-limit in
your process manager) — sapwood *assumes* it. A crash-looping engine is visible in the
supervisor's restart counters; alert THERE. Defense-in-depth behind that assumption:
the engine's own rapid-restart detector (`engine.rapidRestart`, default 5 starts in
10 minutes) parks autonomous dispatch with an escalation when it observes its own
crash-loop, and the single-instance data-dir lock keeps a supervisor's fast
restarts from ever double-driving one board. A crash loop's blast radius is bounded
either way by `dailyBudgetUsd` and the merge gates.

In both directions the design favors **drain-then-escalate over an immediate hard
stop** — a hard kill is the last resort, not the first response, because it destroys
in-progress work as well as spend.
