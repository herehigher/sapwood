# Loop walkthrough (v0.2) — behavior reference, boundaries included

What the engine actually does, step by step, including every boundary and
failure path — written for two readers: the **operator** running sapwood, and
the **#17 dashboard** (its architect needs this to know what "truth" the UI
must render and where the frontend's responsibility ends).

Companions: [`frontend-design.md`](frontend-design.md) owns the UI decisions;
[`round-artifact.md`](round-artifact.md) owns the round data contract;
[`system-review-2026-07.md`](system-review-2026-07.md) owns the why. This doc
owns *behavior*. Code anchors: `round.ts` (round loop), `conductor.ts` (tick),
`cli.ts` (entry/exit), `state.ts` (durable truth).

## 1. The main line — a round's life

`sapwood run` (default driver `rounds`) after fail-fast startup (config,
promptFile, stop-milestone validation — any failure aborts with **zero
dispatch**):

1. **Loop top.** Signal or final `stop.*` already hit? → wind down (§3).
2. **Standby probe** (#125). One local SQLite read + pure GitHub API calls,
   no LLM: Ready issues? gate⓪ candidates? open milestone work? plan-doc
   goals? All empty *and* the last round was idle → **standby**: withhold the
   round, wait `tickIntervalSec × 2^n` (capped at
   `round.standby.backoffCapSec`), emit `standby-wait`, re-probe. Any hit →
   `standby-exit`, proceed. A restart resets the backoff (in-memory only).
3. **Open or resume a round.** An unclosed round in the `rounds` table is
   picked up at its persisted phase cursor (§4); otherwise `startRound`.
4. **Peripheral first half** — `aligning` (PO decomposes goals / triages
   plan-less issues), `architecting` (one cross-issue design pass, fed the
   align summary), `plan_review` (gate⓪: reviewer ⇄ drafter self-heal,
   ≤ `maxDraftCycles`, then `needs-human`). Every phase: KILL_SWITCH checked
   first; marker written after; phase cursor advanced after that. All roles
   are zero-grant sessions — structured output in, engine executes writes.
5. **`executing`.** ONE dispatch-enabled tick (the batch, ≤
   `lanes.roundDispatchCap`, also bounded by free lanes under `lanes.max`),
   then **drain ticks** (dispatch frozen) until zero lanes in flight. DRIVE
   runs during drain, so this round's PRs merge *before* the round closes.
   Round spend is tallied each drain tick against `cost.roundBudgetUsd` —
   over budget marks a round-stop, **never kills a running worker**.
6. **Peripheral second half** — `harvesting` (judgment + needs-human
   briefings over the engine-built artifact), `retro` (engine-built digest
   in; scratch-file proposal out → engine verifies the branch exists and
   opens the PR, or records `retro-pr-degraded`).
7. **Close.** The round-summary artifact is assembled from the ledger,
   validated, upserted into `round_artifacts`, rendered to
   `data/rounds/round-<id>.md`; the round row goes `closed`. An idle round
   waits one tick interval before the loop re-enters at step 1.

Note the asymmetry: **milestone scoping** (`round.milestone`, or the
`--milestone M` flag) bounds *what* the loop works on; **stop conditions**
(`--stop-after-issues/-prs`, `--stop-on-milestone`, config `stop.*`) bound
*when* it exits. `--milestone M` sets both at once.

## 2. Inside one tick (`conductor.ts tick()`, strict order)

1. **KILL_SWITCH gate** — active → this tick is terminal-reclaim + drain
   ONLY (handoff requests; hard kill past `cost.drainWindowSec`). Nothing
   else runs.
2. **PAUSE / wind-down read** — freezes DISPATCH only; reclaim, rollback
   retry, and DRIVE proceed. Fresh file check every tick, no restart needed.
3. **Rollback retry** — pending board mutations from prior failures, before
   any new work; bounded by `recovery.rollbackRetryCap`, then
   `rollback-escalated`.
4. **GATED RECLAIM** (#147) — failed lanes still holding a PR whose
   `needs-human` label a human has since removed re-enter DRIVE, up to
   `lanes.gatedReentryCap` per issue (`gated-reentry` /
   `gated-reentry-capped` events; capped lanes are latched and re-labeled).
5. **RECLAIM** — every running lane classified by four signals (terminal
   sentinel `.handoff`/`.done`/`.failed`; heartbeat age vs
   `worker.heartbeatStaleSecs`; wrapper liveness): KEEP / terminal-record /
   DEAD. A DEAD lane with an open PR is rescued to `driving` (never
   requeued — a second worker racing the PR is the bug class this closes);
   a possibly-dirty worktree is retained on disk and escalated.
6. **CEILING** — `dailyBudgetUsd` + `maxWallClockSec` (post-hoc: spend is
   known only at lane end; overshoot bounded ≈ dispatch cap × worker soft
   budget). Breach → engine-wide dispatch freeze + drain + escalate. The
   engine **keeps ticking while frozen** — see §6.
7. **DRIVE (gate②)** — each `driving` lane's PR: CI green + fresh
   cross-model review → merge (`merged`); review demands work → back to a
   fix lane (`prFixCap` bounded); no PR / unresolvable → `needs-human`.
8. **DISPATCH** — Ready queue ordered by priority (meta-rank issues yield to
   coding work — anti-starvation floor), each candidate checked against:
   ceiling, already-in-flight, round budget, dispatch cap, free lanes.
   Skips are recorded with reasons — dispatch decisions are reconstructible.

## 3. Ways the loop ends

| Path | Trigger | In-flight lanes | Rest of round | Exit code |
|---|---|---|---|---|
| Stop condition | `stop.*` / `--stop-*` hit | **finish fully** | harvest+retro run, round closes | 0 |
| Signal | SIGINT/SIGTERM | **finish fully** | harvest+retro run, round closes | 0 |
| Kill switch | `data/KILL_SWITCH` | handoff window (`drainWindowSec`, default 300 s) → hard kill | **skipped** — round left unclosed | **1** |
| Crash | process death | orphaned; reclaimed by 4-signal logic on restart | round left unclosed | — |
| (PAUSE) | `data/PAUSE` | not an exit: dispatch freezes, everything else continues | rounds keep cycling | — |

Kill switch is the **only** non-zero exit and the only path that skips
harvest/retro. On restart after kill/crash, the unclosed round resumes at its
phase cursor and closes out *before* any new round opens.

## 4. Crash & resume semantics (rerun-not-resume)

- Only two things survive a crash per round: the **phase cursor** and the
  current phase's **idempotency marker** (`advanceRoundPhase` clears the
  marker on every advance — a stale marker can never leak into the next
  phase). A resumed phase re-runs; a non-null marker tells the stub its side
  effects already externalized, so it returns without duplicating them.
- A crash mid-`executing` resumes into **drain-only** (`freshBatch=false` —
  no re-dispatch); round-budget tracking degrades to the still-active lane
  set (a lane that finished in the crash gap is under-counted — accepted).
- The round artifact is **upserted** — a crash between artifact write and
  round close re-runs the close path and overwrites rather than duplicates.

## 5. Budget & safety tiers

| Tier | Knob | On breach | Kills work? |
|---|---|---|---|
| Worker (soft) | `worker.budgetUsdSoft` | graceful handoff: WIP commit+push, `.handoff` | never |
| Round (soft) | `cost.roundBudgetUsd` | no further waves; drain continues | never |
| Engine day (hard) | `cost.dailyBudgetUsd` | freeze all dispatch + drain + escalate | after drain window |
| Engine session (hard) | `cost.maxWallClockSec` (default **4 h**) | same freeze+drain | after drain window |
| Human (hard) | `data/KILL_SWITCH` | freeze + drain + hard kill, exit 1 | after drain window |

Soft tiers preserve work (hard-killing a worker re-burns the same tokens on
requeue, forever); hard tiers exist so the ceiling is actually a ceiling.

## 6. The state truth table — reading the engine at a glance

**This section is the dashboard's core job.** Every "what is it doing?"
question has a deterministic answer assembled from four sources: sentinel
files, the state DB (`workers`, `rounds`, `events`, `spend_ledger`,
`round_artifacts`), the process, and (only for links) GitHub. The classic trap
is **"alive but silent"** — five different truths render identically in a
terminal. A dashboard that cannot distinguish these five has failed its
one job:

| State | The truth | Decisive evidence | What the UI must say |
|---|---|---|---|
| **Working** | lanes running / PRs driving | `workers` rows in `running`/`driving`; recent `events` | normal: lanes, phase, spend |
| **Standby** (#125) | provably nothing to do; parked | `standby-wait` events (attempt n, waitSec) newer than any `dispatched`; open round: none | "Standby — nothing Ready; probing every X min (backoff n)". **Not** an error state |
| **Paused** | human froze dispatch; in-flight work continues | `data/PAUSE` exists | "Paused by operator — in-flight lanes finishing; remove data/PAUSE to resume" |
| **Ceiling-frozen** | hard tier breached; engine ticks but dispatches nothing | `ceiling-escalated` event; spend ≥ `dailyBudgetUsd`, or session age ≥ `maxWallClockSec` (**the 4 h default is the #1 overnight "hang"**) | "Frozen: daily budget / wall-clock ceiling — resumes at midnight / restart". Rust-red, needs a person |
| **Draining to kill** | KILL_SWITCH tripped; handoff window running | `data/KILL_SWITCH` exists; workers transitioning to handoff | countdown against `drainWindowSec`; "will exit 1" |
| **Winding down** | stop condition hit; finishing the round | `round-stop`/stop-condition events; dispatch skipped with reason | "Stop condition met (N issues merged) — finishing in-flight work" |
| **Escalated dry** | board empty because everything needs a human | Ready empty + `needs-human`-labeled issues / `drive-needs-human`, `plan-review-escalated` events | pin the escalation list; "the loop is waiting on YOU, not broken" |
| **Stalled PR** | lane parked in `driving` on a PR reporting no CI | `driving` lane age ≫ normal; (GitHub: PR mergeable=CONFLICTING builds **no merge ref → zero check-suites** — looks like CI never ran) | "PR #N stuck — likely merge conflict suppressing CI" |
| **Dead** | process gone; lanes orphaned | `lastTickAt` age ≫ `tickIntervalSec`; no process | "Engine not running since T — restart resumes round R at phase P" |

Derivation rule: **files beat DB beats staleness** — sentinels are absolute;
then the newest relevant event; a stale `lastTickAt` overrides everything
("whatever the DB says it was doing, it isn't"). The header's one-word state
in frontend-design.md §3-A/§8 is computed from exactly this table and carries
the matching vocabulary.

## 7. Frontend responsibilities and boundaries

**The dashboard is a read-only truth renderer.** Its entire authority:

- **Reads**: state DB read-only (`node:sqlite`), `data/` sentinel existence,
  `data/rounds/*.md`. `round_artifacts` **is** the round-history contract
  (schema-versioned; the UI checks `schemaVersion` and says "newer schema —
  update the dashboard" rather than mis-render).
- **Writes: none.** No sentinel creation (kill/pause stay CLI/human acts —
  a write path would break the read-only security posture and turn the
  dashboard into an attack surface), no config editing, no GitHub writes.
  The dashboard may *display* the exact command to run (`touch
  data/KILL_SWITCH`), never a button that runs it.
- **Not the frontend's job**: deciding state (the truth table above is
  engine-derived data + fixed derivation rules — no heuristics in JS beyond
  it); aggregating GitHub history (deferred per PLAN.md); enriching from
  live GitHub API (issue/PR numbers link out instead — one less credential,
  one less rate limit, one less staleness source).
- **Replay** (frontend-design §2-4): the `events` table is complete and
  append-only; replay re-drives the same UI from any point. Same renderer,
  two clocks — live polling vs. event-time scrubbing. `round_artifacts`
  gives replay its chapter marks (one chapter per round).
