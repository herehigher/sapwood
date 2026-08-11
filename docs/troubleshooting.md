# Troubleshooting

What common failures mean and how to respond.

## Operator intervention routing

Choose the scenario that matches. This index links to the source procedure; it does not
replace it.

- **Stop everything:** [Kill switch](supervision.md#stop-ritual) · [Emergency
  stop](supervision.md#stop-ritual) · [Human controls (three
  tiers)](security.md#human-controls-three-tiers)
- **Stop new dispatch only:** [Pause](supervision.md#stop-ritual) · [Human controls
  (three tiers)](security.md#human-controls-three-tiers)
- **A lane looks stuck:** [Stale heartbeat reclaim (and restart
  adoption)](#stale-heartbeat-reclaim-and-restart-adoption) · [Interpretation
  pointers](supervision.md#interpretation-pointers)
- **Crashed mid-round:** [Crash & resume semantics
  (rerun-not-resume)](loop-walkthrough-v0.2.md#4-crash--resume-semantics-rerun-not-resume)
- **I want to change direction:** Pause stops only new dispatch; an in-flight lane runs to completion unless stopped with the [Kill switch](supervision.md#stop-ritual).
  Editing it yields body-hash `needs-human`; follow [Human controls (three tiers)](security.md#human-controls-three-tiers) and [Ready issue never dispatches](#ready-issue-never-dispatches) for re-adjudication and gated re-entry (no redirect).

## Ready issue never dispatches

First distinguish an issue that is not eligible from one that is eligible but waiting for
capacity. A `Ready` board status alone is not enough.

- **Gate⓪ plan path:** a normal issue needs a genuine verification-plan section, a non-empty
  checkbox acceptance-criteria list under `## Acceptance criteria`, and the configured
  `sapwood:plan:approved` label. Under the normal `rounds` driver, the plan-review peripheral
  can apply that label. Under the L1 `tick` driver, it never runs, so a human must apply the
  label after reviewing the plan.
- **Doc-gate path:** an inherently unverifiable docs/chore issue instead needs the configured
  `sapwood:verify:n/a` label and must not still carry `sapwood:needs-human`. Do not put both
  `sapwood:verify:n/a` and `sapwood:plan:approved` on the same issue: that mixed state is
  deliberately fail-closed. A `verify:n/a` proposal accompanied by `needs-human` still needs a
  human adjudication (remove `needs-human`) before it can proceed.
- **Lane and holds:** the issue must be open and on this configured ProjectV2 board's `Ready`
  lane. `sapwood:needs-human` and `sapwood:blocked` keep it out of either dispatch path; resolve
  the stated problem, then remove the appropriate hold yourself. `sapwood:planless` is excluded
  by the `rounds` driver's pooled selection, but the L1 `tick` driver's unpooled `Ready` path does
  not test that label. Do not diagnose a tick candidate as skipped because it is `planless`.
- **Snapshot drift:** `ac-snapshot-drift` is a later, fail-closed condition: a worker was
  already dispatched, then the issue body changed before review. It adds `needs-human`; inspect
  its durable record with `sapwood events --issue ISSUE --kind ac-snapshot-drift`, resolve the
  body change by restoring the original plan/acceptance criteria or explicitly re-approving the
  new body, then remove `sapwood:needs-human` to request gated re-entry. If the original
  `needs-human` label write failed, that lane is permanently outside automatic re-entry even if a
  human later adds or removes the label; review and merge its PR manually. It is not evidence that
  a fresh `Ready` issue was silently skipped. A comment that ONLY advances the
  `sapwood:comments-adjudicated-through` cursor marker (#703's per-comment discipline) does not by
  itself trigger this (#752) — the AC-authority hash ignores that one well-formed marker line; any
  other body edit still drifts as above. The sibling `comment-cursor-stale` recheck (still ahead of
  gate②) also correctly recognizes that same marker advance rather than bouncing it as pending
  (#752 PO-adjudication finding 1, fixed in the same change) — a marker-only comment does not
  produce either escalation.

The run narrative defaults to `data/logs/sapwood.log` and is also teed to stderr; use
`sapwood status` for active lanes and `sapwood events --issue ISSUE` for durable escalation
facts. Today, an in-memory dispatch result can name capacity reasons such as `cap`, `no-lane`,
or `over-budget`, but the normal CLI does **not** persist a per-candidate skip reason for an
issue excluded before dispatch eligibility. If the checks above all pass and no lane appears,
capture the run narrative and event output for a follow-up rather than reading an idle
`--until-idle` exit as success.

## Config validation errors

Run `sapwood validate [path]` after any config edit. It loads the same config the real
`run`/`init` would, and reports one of three outcomes:

- **`sapwood validate: OK — <path> (lanes.max=…, guard.mode=…, merge.mode=…)`** — the
  config is valid; the summary line echoes a few effective values as a sanity check.
- **`sapwood validate: invalid config:` + one issue per line** — a Zod validation
  failure: an unknown key (typo), a wrong type, or a value outside a field's allowed
  range. The path shown (e.g. `worker.timeoutSec`) tells you exactly which key to fix.
- **`sapwood validate: <message>`** — something other than a schema mismatch: the file
  doesn't exist at the given/default path, or it exists but isn't valid YAML/JSON.

**`worker.promptFile` fail-fast:** `validate` also eagerly loads and renders the
configured prompt template (the same check `sapwood run` does at startup, before any
dispatch). A `promptFile` that's set but missing, unreadable, empty, or that references
an unknown `{{var}}` fails validation — fix the path or the template, there is no
silent fallback to the shipped default once `promptFile` is set.

**`stop.onMilestoneComplete` fail-fast:** if you set `stop.onMilestoneComplete` (or pass
`--stop-on-milestone`, or its `--milestone NAME` shortcut — see [`run
--milestone`](configuration.md#stop)), `sapwood run` checks the name against the repo's
real milestone titles *before dispatching anything*. An unmatched name — including a
near-miss like `"M4"` when the real title is `"M4 — UX surface + CLI"` — aborts startup
with an error listing the milestone titles that actually exist in the repo. Match the
title exactly, including any em-dash/suffix.

## `needs-human` label

> [!WARNING]
> Upgrading a pre-#199 repository? Complete the
> [label migration before restarting sapwood](configuration.md#upgrading-from-pre-199). Old bare
> hold labels are not recognized by the new prefixed defaults.

`labels.needsHuman` (default `sapwood:needs-human`) means: **automation has stopped working
this issue/PR and is waiting on you.** sapwood deliberately degrades rare edge cases to human
attention rather than building more automation to handle them — see the issue comment or PR
thread for the specific reason (a structured event and/or comment is posted alongside the
label explaining what happened).

To clear it: investigate and resolve whatever's described, then remove the configured
`labels.needsHuman` label by hand. Removing it does not automatically re-dispatch anything —
if the issue should re-enter the loop, move it back to `Ready` on the board yourself. The one
exception is a lane escalated while holding a PR: removing the label is enough on its own, and
the engine reclaims it straight back to the merge gate (see
[Startup residue](#startup-residue-after-a-crash-or-quota-storm) for how a restart repairs the
bookkeeping that makes this work).

Both `escalation.humanLabels` (default `[sapwood:needs-human, sapwood:blocked]`) hold an issue out of
the main dispatch lane — any issue carrying either label is skipped by dispatch
regardless of its board status.

## Dirty-worktree degrade

When a lane is torn down (a dead worker reclaimed, a drain-window escalation, or a
`.failed` sentinel) and its worktree might hold uncommitted work, sapwood **never
deletes it** — it can't prove the worktree is clean, and deleting possibly-uncommitted
work is worse than leaving it on disk. Instead:

- The worktree is retained at its original path.
- The configured `labels.needsHuman` label is applied to the issue **and**, if a PR already
  exists for that lane, to the PR itself (the merge gate reads a PR's own labels, not the
  source issue's — a crash-with-WIP must not let its incomplete PR auto-merge while the WIP
  awaits salvage).
- An issue comment is posted naming the exact worktree path:
  > "sapwood: lane `<name>` was torn down with possibly-uncommitted changes in its
  > worktree. Automation never deletes work it can't prove is clean (#69) — the
  > worktree was left on disk at: `<path>`. Salvage or discard it by hand, then remove
  > the `<configured labels.needsHuman value>` label."

To resolve: go to the path named in the comment, decide whether the uncommitted changes
are worth keeping (commit/push them yourself, or discard the worktree by hand), then
remove the configured `labels.needsHuman` label. The lane will not be reused until you do.

### A retained `retro` worktree

Role sessions get the same protection in a deliberately lighter form. `retro` is the one
role that writes code (it drafts a self-improvement proposal and pushes it as a branch), so
when a retro session ends in a timeout/crash/failure with uncommitted edits still in its
worktree, that worktree is kept on disk instead of deleted, and a `role-worktree-retained`
event records the path, the round, the outcome, and how dirtiness was determined.

There is **no label, no comment, and nothing to clear** — a retro session has no issue or PR
to escalate against, and a lost draft costs one round's proposals at most (the next round's
retro starts over from the same history). The retention exists purely so the loss is
diagnosable rather than silent. Salvage the draft if it's worth keeping, otherwise delete
the directory; nothing in the loop waits on either.

## Kill switch recovery

If `data/KILL_SWITCH` is set (by a loaded plugin slash command or by hand), all new dispatch and
merges are frozen and running workers are being drained. The switch is part of the stateful
data directory; see [Data directory is stateful](configuration.md#data-directory-is-stateful)
before moving, deleting, or restoring `data/`. Recovery:

1. Check `sapwood status` — it reports `kill switch: ACTIVE` and shows any in-flight
   lanes still draining.
2. Once you're satisfied it's safe to resume, run `sapwood stop clear` (equivalent to
   `rm -f data/KILL_SWITCH`; or `/sapwood-stop --lift` in a session where the plugin
   is loaded — #731 added the CLI verb, all three act on the exact same file).
3. Dispatch and merges resume on the **next tick** — a switch lifted mid-tick doesn't
   take effect within that same tick.

If a drain escalated to a hard kill (the drain window elapsed before a worker handed
off), that lane's issue/PR will carry `needs-human` — see above.

## Single-instance lock (#382)

Only one `sapwood run` may drive a given data dir (and therefore a given board) at a
time — two concurrent engines double-drive: duplicate dispatch, conflicting merges. At
startup, before any board read/write or reconcile, the engine takes a lock at
`data/sapwood.lock` (beside `sapwood.sqlite`) recording its pid; a second start against
the same data dir exits 1 with a message naming the holder's pid and the lock path.

The lock is released on every normal exit (stop conditions, `--once`, kill switch,
graceful signals). A **crash** leaves it behind by design — the next start checks
whether the recorded pid is still alive and, if it is dead, takes the stale lock over
automatically (logged, plus a durable `instance-lock-taken-over` event). Crash + restart,
including a supervisor's fast restart (#431), therefore needs no manual step.

The one case that can need a hand: the previous engine died without releasing AND the OS
has since recycled its pid onto some unrelated live process. The liveness check then
reads "alive" and startup is refused — deliberately the safe direction (a false refusal,
never a false takeover). If you've confirmed the named pid is not a sapwood engine
(`ps -p <pid>`), delete `data/sapwood.lock` and start again.

Stale-lock takeovers are serialized through a mutex directory, `data/sapwood.lock.takeover`,
held only for the sub-second takeover itself. If an engine **crashes inside that window**, the
directory is left behind and every later start that needs a takeover refuses with a message
naming it — deliberately fail-closed (a visible refusal, never a possible double-drive). The
check: if `data/sapwood.lock.takeover` exists and **no** sapwood engine is running against
this data dir, remove the directory (`rmdir data/sapwood.lock.takeover`) and start again.
Ordinary starts (no stale lock to take over) are unaffected by a leftover mutex directory.

A crash can also leave a stray `sapwood.lock.tmp-*` file in `data/` — a sidecar of the lock's
atomic create. Its name is unique per process start and is never re-matched by a later
engine: harmless, safe to delete.

## Environment-failure park (#168)

A failure whose structured error output matches an environment-failure signature — an
LLM-provider issue (429 / usage-limit / credit-exhausted) or a forge issue (network unreachable
/ 5xx / `gh` auth errors) — is treated as a fault in *sapwood's own environment*, not in the
task the worker was doing. (Only the process's stderr and errored result records are matched —
never the worker's own message content, so a worker *writing code about* rate limits can't trip
this.) This is deliberately a **different** class from an ordinary task failure or the kill
switch above: the engine never applies `needs-human` and never spends a gated-reentry attempt
for it — the affected issue goes back to `Ready` untouched (during a forge outage, the requeue
itself is held durably and drains on resume), and the engine **parks** instead: new dispatch
stops, but in-flight lanes keep running/draining exactly as normal (the same "only DISPATCH is
gated" behavior as `PAUSE`, not the kill switch's harder freeze-and-drain).

**What a parked engine looks like:**

```
$ sapwood status
...
park: PARKED (forge) since 2026-07-14T09:12:03.000Z (612s) — reason: could not resolve host —
  no new dispatch; in-flight lanes proceed normally; probing on backoff, auto-resumes on recovery
```

- `source` is `llm` or `forge` — which upstream tripped the signature match. Episodes are
  per-source: a mixed storm (both upstreams broken) shows one `park:` line per source, and
  dispatch resumes only when **every** episode has cleared.
- `reason` is a short excerpt of the matched failure text.
- The duration shown is wall-clock since the FIRST detection in this episode — further
  env-failures (including failed recovery canaries) while already parked never reset this clock.

**What sapwood does on its own (no action needed for a transient outage):** while parked, the
engine re-checks the failed source on a bounded exponential backoff
(`envFailure.probeBackoffBaseSec` doubling up to `probeBackoffMaxSec`):

- A **forge** episode clears the moment a lightweight read-only GitHub call succeeds again —
  dispatch resumes that same tick, and any requeues held during the outage drain right after.
- An **llm** episode is stricter. At each backoff step sapwood first sends a **minimal
  inference ping** (~$0.016 per ping on `envFailure.probeModel`, default `haiku`, budget-capped
  by `envFailure.probeMaxBudgetUsd`); a failed ping means the provider is still down — and the
  ping's own error line is recorded in the `park-probe` event, so `Exceeded USD budget` (your
  `probeMaxBudgetUsd` is set below the ~$0.016 floor) and `unknown option` (your claude CLI is
  too old for the ping's flags — upgrade it) are immediately distinguishable from a real
  outage. A green ping proves basic network/auth/capacity but *not* that your worker's
  model/tier has quota — so it only unlocks exactly **one canary lane**. If the canary
  completes without an env-classified failure, the provider is provably back and the episode
  clears; if the canary itself env-fails, the same episode continues with a longer backoff.
  You may therefore see a single `canary lane <name> in flight` note in `sapwood status` while
  parked — that is the recovery test, not a dispatch leak.

Most outages (a `gh` blip, a temporary rate-limit window) resolve this way with zero human
involvement.

**When a human IS notified:** if an episode's *duration* (not probe count — backoff makes a
count an ambiguous measure of elapsed time) exceeds `envFailure.parkEscalateAfterSec` (default
1h), sapwood additionally notifies a human — this is **additive**, never a state change: probing
keeps going, and an auto-resume still fires normally afterward even after an escalation fired.
The channel depends on what's actually reachable:

- **Forge reachable** (an `llm` episode, forge healthy) — a comment on the issue that triggered
  the episode.
- **Forge unreachable** (a `forge` episode, or any escalation during a mixed storm) — sapwood
  does not attempt a GitHub write at all: it falls back to **local-only** signals: `sapwood
  status` (above), a plain-text `ESCALATION` file in the engine's data dir (`data/ESCALATION`
  by default) written by the engine — informational output only, never read back as a control
  input, unlike `KILL_SWITCH`/`PAUSE`, and removed automatically once the outage resolves —
  and a `[sapwood:park]` log line.

The escalation also names how many issue requeues are being held for resume, so nothing is
invisibly parked-behind-the-park.

**What to do:**

1. Run `sapwood status` (or `cat data/ESCALATION` if the forge itself is down) to see each
   episode's source/reason/duration.
2. If the underlying outage is a known, expected one (a GitHub incident, an account-level rate
   limit reset time you already know), you can just wait — sapwood keeps probing/canarying and
   resumes on its own.
3. If you fix the underlying problem yourself (renew a `gh` token, restore network, wait out a
   credit/usage window), no action is needed on sapwood's side either — the next scheduled
   probe (or canary) picks up the recovery and auto-resumes.
4. There is no manual "unpark" flag — recovery is always evidenced by the environment actually
   working again (a successful forge read, or a canary lane completing). Restarting the engine
   does not lose the park state or its duration clock — it resumes probing, not dispatching —
   and does not, on its own, clear a still-genuinely-broken environment either.

## Rapid-restart park (#431)

At startup the engine counts its own recent process births (`run-started` events) —
`engine.rapidRestart.maxBirths` starts (default 5, the current start included) within
`engine.rapidRestart.windowSec` (default 600s) means a **crash loop**, which is not a
sanctioned restart pattern. The engine then emits `rapid-restart-detected`, **parks**
autonomous dispatch (the same park machinery as an environment failure — visible in
`sapwood status` as `PARKED (rapid-restart)` and in `data/ESCALATION`), and stays up
without dispatching.

Recovery: stop whatever is restarting the engine (usually a supervisor without its own
restart limit — configure one; see [security.md](security.md)'s supervisor
prerequisite), fix the crash's cause, and start the engine once the window has drained
— a start that counts fewer than `maxBirths` births clears the park automatically
(`park-resumed`, `via: restart-window-clear`). No state surgery is needed;
`sapwood park clear --source rapid-restart` (with the engine stopped) also works but
should never be necessary.

## Consecutive-stalls park (#407)

The progress watchdog ([configuration.md](configuration.md)'s `liveness.watchdogTickMultiplier`)
diagnoses a *single* stall: it appends a durable `engine-stalled` event and exits nonzero so a
supervisor can restart the engine. At startup the engine reads that record back: a restart after
a stalled run appends `engine-restart-after-stall` and proceeds through the normal startup
reconcile (rerun-not-resume — no manual step). But once the last `liveness.maxConsecutiveStalls`
runs (default 3) have **all** ended stalled with **no round closed between them**, the wedge is
deterministic — the same bug re-wedging every restart — and restarting again would loop forever.
The engine then emits `consecutive-stalls-detected`, **parks** autonomous dispatch (the same park
machinery as an environment failure — `PARKED (consecutive-stalls)` in `sapwood status`, plus
`data/ESCALATION`), and stays up without dispatching.

Recovery is **operator-explicit — this park never auto-clears.** The stall count that *arms*
the breaker resets only on real progress (a round closing between stalls); how a run exited is
always neutral — clean stops (including the SIGTERM a supervisor sends before every restart)
and hard kills alike — so no restart pattern can launder the wedge. And once the park is
established, no engine-produced signal clears it either: a dispatch-empty round closing while
parked only proves the orchestration loop is healthy, not that the wedge on the (gated)
dispatch surface is gone, so the engine deliberately does not read it as recovery. The steps:

1. Diagnose the wedge — each `engine-stalled` event's payload names the open round/phase, the
   last event, and the tick age — and fix the cause.
2. Stop the engine, then clear the park with the engine's own verb (#475):

   ```sh
   sapwood park clear --source consecutive-stalls
   ```

   It performs the clear inside the engine's protocol, **receipt-first**: the `park-resumed`
   receipt (`via: operator-clear`) is appended *before* the `park_state` row is deleted, and the
   `data/ESCALATION` marker comes down last — the same order the engine's startup path uses.
   It **refuses** while a live engine holds the data dir (the single-instance lock, #382), which
   is exactly the case where a raw row deletion could let a dispatch gate see the absent row
   before any receipt is in the ledger.
3. Start the engine again. The streak restarts from zero — if the wedge was not actually fixed,
   a fresh streak re-parks and re-escalates as a new episode.

**Break-glass fallback.** If the CLI is unavailable, deleting the row by hand still works — the
engine's *next start* recognizes a receiptless missing row on an escalated episode as an operator
act, writes the same `park-resumed` receipt, and removes the marker:

```sh
sqlite3 data/sapwood.sqlite "DELETE FROM park_state WHERE source = 'consecutive-stalls'"
```

Do this only with the engine **stopped**, and restart it afterwards: between the deletion and the
next start there is no receipt in the ledger, and a running engine's dispatch gate would observe
the absent row in that window.

Until you act, the park and its single, deduped escalation stand across any number of restarts
— nothing is re-spammed and nothing is lost. A *transient* wedge (a host sleeping mid-round, a
passing outage) closes rounds between its stalls and never trips the breaker at all.

## Idle-churn park (#470)

Standby ([configuration.md](configuration.md)'s `round.standby.enabled`) is what stops the loop
opening rounds it has nothing to do in. It asks one question before each round: *is there
provably any work?* The failure this park exists for is that question answered **wrongly yes** —
a probe signal counting work nothing enabled can ever consume (a role that is switched off, a
selector reading a superset of what the consumer actually takes, a label nobody will ever remove).
Standby then never engages, and the loop opens round after round, each one perfectly healthy and
each one achieving exactly nothing. The live case was six such rounds in twelve minutes (dogfood
F32, rounds 244–249) — found only because a human happened to be reading the round ledger.

The breaker bounds it: once `round.idleChurn.consecutiveIdenticalRoundsThreshold` rounds (default
5) in a row have closed both **idle** (no dispatch, no lane left in flight) and **state-identical**
(each appended exactly the same durable facts as the one before — same kinds, same payloads), the
engine appends `idle-churn-detected`, **parks** dispatch (`PARKED (idle-churn)` in `sapwood
status`, plus `data/ESCALATION`), and stays up without opening another round.

**Read the event first — it names the diagnosis.** Its `probeSignals` field names the standby
probe signal(s) that held those rounds open:

```sh
sqlite3 data/sapwood.sqlite \
  "SELECT payload FROM events WHERE kind = 'idle-churn-detected' ORDER BY id DESC LIMIT 1"
```

- A **named signal** (e.g. `ready-issues`, `handoff-resume-candidates`, `plan-triage-candidates`)
  is the thing to investigate: ask what would CONSUME that work. If the honest answer is
  "nothing, until a person acts", that signal is missing its terminal — the standing design rule
  is that every signal must name the state in which a deterministic failure stops it counting.
  The signal names come from `probe-signals.ts`'s `PROBE_SIGNALS` registry, where each entry
  states its consumer and its terminal in so many words (#469) — read the entry with the name
  the event gave you. Usually the fix is either that terminal, or the
  human-side action the signal is waiting on (promote the issue, clear the hold, remove the label).
- An **empty** list means the probe never ran at all — standby is disabled, or its
  "last round was idle" precondition was never met. Then the churn is not probe-driven; start
  from the round ledger (`round-phase` events) and what the rounds were doing instead.

Recovery is **operator-explicit — this park never auto-clears**, and unlike an environment park
there is nothing to probe: the loop itself is healthy, so no signal the engine could re-test would
mean anything. Fix the cause, stop the engine, then:

```sh
sapwood park clear --source idle-churn
```

The verb is receipt-first and refuses under a live engine — see the
[consecutive-stalls section](#consecutive-stalls-park-407) for why, and for the raw-SQL
break-glass fallback (same shape, `source = 'idle-churn'`). Start the engine again afterwards;
the running loop also notices the row is gone at its next round-open check. The streak restarts
from zero — the detection event consumes the rounds that produced it — so if the cause was not
actually fixed, a fresh set of K rounds re-parks as a new episode rather than re-spamming the old
one.

## How a dead engine says why it died (#407)

Every run's fate is the **last run-lifecycle event** in the ledger after its `run-started`:

- `run-ended` — a clean stop; the payload's `stoppedBy` names the path (`signal`, `once`,
  `idle`, `stop-condition` + the condition's name, `kill-switch`, or `error` with the thrown
  message).
- `engine-stalled` — the watchdog self-diagnosed a stall and exited nonzero; the payload carries
  the round/phase, last event, and tick age at fire time.
- *neither* — the process died without getting to write anything: a crash, an OOM kill, or a
  `kill -9`. The absence is itself the record.

The dashboard derives its dead-engine state from exactly this partition (`stopped` with a
reason / `stalled` with a reason / bare crashed-or-killed), so it and the ledger can never
disagree.

## Where to look after an unattended run

The run log (`logging.path`, default `data/logs/sapwood.log`) is the disposable human/LLM
narrative: startup, tick and round lifecycle summaries, degradations, and park notices. Merges
announce themselves here too — one `[sapwood:drive] lane <lane> pr #<n> MERGED (<headOid>)` line
per merged PR (#570), so the engine's most consequential act is visible to a live `tail -f`
without querying SQLite. Start here to understand the shape of a run; the previous rotation, when
present, is `<path>.1`.

The SQLite events ledger is the structured source of truth for transitions needed by
correctness, audit, replay, and dashboards. Query it when you need durable facts; event payloads
are deliberately not mirrored into the narrative log.

Lane and role JSONL files contain raw subprocess output. Inspect them for a worker or peripheral
session's model/tool transcript details; that raw stream is deliberately not copied into either
the narrative log or the events ledger.

## Tick errors (`sapwood status` / run summary)

`sapwood run`'s exit line reports a tick-error count:
`sapwood run: stopped after N tick(s), M tick error(s) (<reason>)`. A nonzero `M` most
often means the forge (GitHub, via `gh`) was transiently unreachable during one or more
ticks — a network blip, a `gh` rate limit, an API outage. The engine's design is to
**fail toward retrying, not toward crashing**: a tick that throws is counted and
logged, and the next tick tries again on its normal cadence.

- In **daemon** or **`--until-idle`** mode, a nonzero tick-error count is not itself a
  failure exit (`code 0`) — contained, retried errors are the retry design working, not
  a terminal problem. Watch the count over time; a count that keeps climbing without
  the engine ever making progress suggests something is wrong beyond a transient blip
  (check `gh auth status`, GitHub's status page, network connectivity).
- In **`--once`** mode, a run whose single tick attempt produced *only* tick errors
  (zero successful ticks) exits `1` — a one-shot invocation (cron, a script) has no
  later tick to retry, so this must surface as a failure to the caller.

`sapwood status` doesn't itself surface historical tick errors (it reads point-in-time
state), but it will show whether lanes are stuck (no progress on `running`/`driving`
workers) as a symptom of the same underlying connectivity problem.

## Stale heartbeat reclaim (and restart adoption)

Each running worker writes a heartbeat, refreshed by the *engine's* in-process timer —
so engine downtime (crash, restart, SIGHUP killing a session-bound `sapwood run`)
stops the heartbeat while detached workers keep working. What happens when the most
recent heartbeat is older than `worker.heartbeatStaleSecs` (default 180s) depends on
whether the worker process itself is still alive (#169):

- **Worker process still alive**, and its first dispatch is within `worker.timeoutSec`:
  the lane is **adopted**, not killed. The engine requests a graceful handoff (SIGTERM),
  holds the lane while the worker drains and exits — the worktree is left exactly as the
  worker left it — then writes the `.handoff` sentinel and resumes the same session in
  that same worktree through the ordinary handoff/resume path. An engine restart never
  hard-kills a healthy worker mid-work. Adoption is recorded as a `lane-adopted` event,
  which also notes that spend during the engine's downtime was unobserved (nothing was
  supervising the worker while the engine was down — a deliberate, bounded blind spot).
- **Worker process dead, unknown, or past `worker.timeoutSec`**: the conductor considers
  the lane dead and reclaims it on the next tick. A hung process that stopped
  heartbeating, or one that has outlived the wall-clock bound, cannot hold a lane
  forever.

Both are expected recovery behavior, not bugs: they are what make the engine safe to
restart at any time.

If dead-lane reclaim finds no terminal sentinel and a possibly-dirty worktree, it
follows the dirty-worktree degrade path above (retain + `needs-human`), never a silent
requeue of in-progress work.

## `gh` auth / scope problems (`init`)

`sapwood init` preflights authentication before touching anything, and fails with an
actionable, specific message (an `InitError`, not a stack trace) for the two failure
modes it checks:

- **Not logged in**: `init failed: not logged in to GitHub — run: gh auth login`
- **Missing the `project` scope**: `init failed: missing `project` token scope — run: gh
  auth refresh -s project`

Run the suggested command, then re-run `sapwood init` — it's idempotent, so re-running
after a preflight failure never duplicates anything it already managed to do (it fails
before any mutation on this path anyway).

If `init` fails partway through a *later* step (labels/milestones/board), each step is
independently detect-before-create — just re-run `init` after addressing whatever it
reported; already-provisioned pieces are left untouched.

## Missing workflow labels / round-pool label writes failing

Every `sapwood run` startup reconciles the repo's labels against the full list the resolved
config names — the same list `sapwood init` provisions — and creates any that are missing. A
repo initialized before a newer workflow label existed therefore heals itself on the next
start; you never need to create one by hand.

If the pass fails (typically a token without permission to create labels), the engine logs
`[sapwood:startup] could not reconcile the configured workflow labels; continuing: …` and
starts anyway. Downstream, a round whose round-pool label writes **all** fail records a
`pool-labels-failed` state event and withholds dispatch for the rest of that round — including
any issue still carrying a pool label from an earlier round, since that label is not this
round's selection. In-flight lanes still drain and a handed-off lane still resumes; only new
dispatch is withheld. The next round re-selects and the engine stays alive throughout. Fix the
token's permissions, or create the labels manually, and the following round proceeds normally.

## Open issues nobody has placed on a board

Every `sapwood run` startup reports (never places) open issues that no one has triaged onto a
project board:

```
[sapwood:startup] 3 open issue(s) on no project board at all: #53, #512, #513 (a further 32 sit on another board — placed, not a gap)
```

Only issues on **no project at all** are listed — those are the actionable ones, typically
freshly filed and awaiting triage. An issue that sits on a *different* board is placed on
purpose (a repo may partition, say, an autonomous queue from a human-only one), so it is a
single trailing count rather than a row; when nothing is unplaced, the check prints nothing at
all regardless of how large that count is. Membership comes from GitHub's own project-item data
on the issue, so there is no ignore list to maintain.

The list is capped at 25 enumerated issues, but the stated total is always the true count. If
either underlying read might be incomplete (the board paginated past its ceiling, or the
open-issue read hit its `--limit`), the check logs `could not compute …` and skips — a wrong gap
report is worse than none. Nothing here blocks startup.

## Startup residue after a crash or quota storm

A run that dies mid-flight (an OOM kill, a provider quota storm, a hard restart) leaves lanes
behind whose board/label state no longer matches reality. Every `sapwood run` startup now
**repairs** that residue instead of only reporting it, so the only manual step left is the one
that needs judgment: removing `labels.needsHuman`.

What startup does, in order, and the state events it names each repair with:

| Residue | What startup does | Event |
| --- | --- | --- |
| An issue stuck in the `In Progress` column with a stale `labels.inProgress` label, whose lane is gone and which has **no open PR** | Moves it back to `Ready` and strips the label, restoring pool eligibility | `orphan-healed` (and `orphan-heal-failed` if a write is refused) |
| A `failed` lane holding a PR whose escalation never recorded that its `needs-human` write landed | If the hold label is **observably present**, records it, so removing the label later triggers gated reentry | `gated-flag-healed` |
| The same lane with **no** hold label present | Left alone and surfaced — the engine cannot tell "never labelled" from "already cleared", and guessing would re-dispatch a lane nobody has looked at | `gated-flag-unprovable` |
| A lane an **environment failure** killed while it held an **open PR**, never escalated (nothing on its issue) | Returns it to `driving`, so the ordinary drive/merge path picks the PR back up. Its rework-round count and preserved worktree are untouched | `lane-revived` |

The last repair also runs mid-run, on the first tick after an [environment-failure
park](#environment-failure-park-168) resumes. It **waits while the engine is parked** — on a
restart as much as mid-run — because until the episode clears, the environment is still the
thing that killed the lane.

It acts only on lanes an environment failure actually killed, proven by that failure's own
durable record — never on a lane that reached the same state some other way. Concretely it
leaves alone:

- a lane whose issue carries a hold label — that one belongs to gated reentry, and startup
  records the hold so removing the label later wakes it through *that* path (`gated-flag-healed`);
- a PR marked `labels.humanMergeOnly` — a human must merge that one, and the loop never drives
  it again;
- a lane whose escalation was real but whose `needs-human` write failed — it stays fail-closed
  to a human, exactly as before;
- a merged or closed PR — there is nothing left to drive. A **merge** is remembered
  (`lane-revival-terminal`) so the lane is never re-checked; a **closed** PR is not, because
  reopening it is allowed and should let the lane resume.

Two deliberate limits:

- **An orphan whose lane still holds an open PR is never healed.** That issue belongs to the
  gated-reentry path; returning it to `Ready` would let a second worker start work on an issue
  that already has a producer's PR open. Merge or close the PR (or remove the hold label to let
  reentry drive it), rather than moving the issue by hand.
- **A `gated-flag-unprovable` lane needs you.** It is a standing alarm, re-emitted once per
  engine start until the PR is merged/closed or the lane is retired.

Repairs are idempotent — a startup that fails partway simply retries on the next start, and a
forge failure on one issue never aborts the pass or the run.

### A dead lane's open PR is found mid-run, not only at the next start

A worker can push its branch and open its PR and *then* die, before the engine ever associates
that PR with the lane. The lane settles `failed` with no PR on record, its issue is handed back
to `Ready`, and the PR stays open with nobody driving it. Startup reconcile finds this — but
only at the next restart, which in a live run meant one PR sitting unowned for the whole run
while its issue was picked up again from scratch.

Every tick, after the tick's reclaims have landed and before it dispatches anything, sapwood
now looks at the lanes that ended **terminally with no PR of their own**. Usually there are
none and it stops there, costing nothing; when there are, one open-PR listing answers for all
of them. A PR it matches to such a lane — by that lane's engine-authored owner marker, or,
failing that, by an unmarked body whose closing keyword names that lane's issue and no other —
is:

- reported as `orphan-detected` (with `midRun: true`, naming the lane and the PR), and
- handed to a person — `labels.needsHuman` on the **issue** (`orphan-pr-escalated`), so the
  requeued issue cannot be re-dispatched behind the still-open PR.

Then it is your call: finish or close that PR (either resolves the attention item on its own,
like every other escalation), or remove the label to hand the issue back to the pool.

Each dead lane is checked **once**, whatever the answer — this is not a per-tick board scan —
and the check is suspended while the engine is parked, for the same reason the lane revival
above waits: under a forge park, the forge is the very thing that is down.

Two deliberate limits:

- **The closing-keyword fallback can over-report, on purpose.** The marker is the reliable
  signal, but this residue exists *because* the engine never got to stamp one, so a match on the
  PR body is the only thing that can see the case at all. It is kept
  narrow — asked only about issues of lanes already known dead, never about a body that carries
  an owner marker, and never when two open PRs claim the same issue — and it never looks at a PR
  some lane already holds, or at an issue a live lane is working right now. What is left is one
  removable `needs-human` label on an issue where somebody else's PR happens to name it, traded
  against the alternative: an unowned PR nobody sees for the rest of the run.
- **It never adopts the PR back into the drive loop.** The engine auto-drives a dead lane's PR
  only where it can prove the worktree was clean; this path is reached precisely when it
  cannot, and auto-merging possibly-incomplete work is the one outcome here you could not undo.

### Empty rounds over a backlog that can't move

Rounds churn (and burn paid role sessions) only while there is work an **enabled role can
actually consume**. An issue that is claimed (carrying `labels.inProgress`) or held (carrying
any `escalation.humanLabels` label) counts as neither: it is off the `Ready` lane, so no pool,
gate⓪, or triage pass can reach it. A milestone whose entire open backlog is claimed or held
therefore puts the run into **standby** rather than opening round after empty round. The
startup repairs above are what return such a backlog to work: once a dead lane's stale label is
stripped, its issue is `Ready` again and counts as work on the very next probe.

If a run is in standby and you believe there *is* work: check that the issues aren't still
carrying a stale `labels.inProgress` from a lane that died before this feature landed (remove
it and move them back to `Ready`), and see
[Where to look after an unattended run](#where-to-look-after-an-unattended-run).

## Every lane is waiting on CI at once (`base CI: RED`)

If `sapwood status` reports

```
base CI: RED at <sha> since <when> — failing: <check>; every open lane's CI evidence inherits
this until the default branch is fixed
```

the problem is **not** any one PR. The default branch's own HEAD commit is CI-red, so every open
PR's merge-ref CI inherits that red and every lane sits in the same CI-evidence wait — each lane's
queued reason says `base-inherited` and names the same commit. This is the shape two individually
green PRs can produce by *composition*: each passed alone, their merge did not.

**What to do:** fix the default branch (revert, or land a fix). Nothing on the sapwood side needs
touching — the lanes are waiting, not wedged, and they resume the ordinary per-PR CI-evidence path
by themselves on their next poll once the branch is green. The engine raises exactly **one**
escalation for the episode, no matter how many lanes are waiting or how long it stands, and
resolves it itself (`escalation-resolved`, `via: base-green`) on the round after the branch
recovers. A new red commit landing on the default branch is a new fact and escalates once more.

**If status says `base CI: not known red` but lanes still all wait:** the engine could not read
the default branch's checks (it fails closed to "not red" rather than guessing) — look for
`[sapwood:base-ci] default-branch check read failed` in the log, and check `gh` auth as under
[`gh` auth / scope problems](#gh-auth--scope-problems-init).

## See also

- [`security.md`](security.md) — the guard, human controls, and escalation model
  behind several of the behaviors above.
- [`configuration.md`](configuration.md) — every config key referenced above.
