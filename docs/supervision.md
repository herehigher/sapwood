# Supervision

The playbook for whoever is watching a `sapwood run` session — a human, or a trusted
LLM supervisor session (see [Governance lines](#governance-lines) for what that role
means). Pre-#407, sapwood ships **no daemon/supervisor process of its own**: `sapwood
run` is a foreground engine loop, and something outside it — a terminal, a service
manager, or an operator session — launches it, watches it, and stops it. This page is
that "something outside it"'s manual. It is procedure, not new machinery: every verb
and label named here already exists ([`status`](#supervising-a-run),
[`events`](#supervising-a-run), `park clear`, `gh`); this page is the recipe for using
them as a coherent supervision loop.

Machine-enforced facts (the guard hook, human-merge-only paths, the kill switch vs.
pause distinction, cost ceilings) live in [`docs/security.md`](security.md) and
[`docs/configuration.md`](configuration.md) — this page **points at** them and never
re-enumerates them. What a given event/park-source/escalation-bucket *means* lives in
the generated `sapwood-event-glossary` skill — this page points at that too.

## Supervising a run

Two read-only CLI verbs read the state DB directly, with no live engine session
required — the same DB a running engine is currently writing (WAL, concurrent-read
safe):

- **`sapwood status [db-path] [--json]`** — a point-in-time snapshot: active/driving
  lanes, spend vs. the daily ceiling, kill-switch/pause state, park episodes, base-CI-red.
  `--json` prints a documented, additive-only DTO (`formatVersion 1`) instead of the text
  summary — ignore fields you don't recognize rather than fail on them.
- **`sapwood events [db-path] [options]`** — the event ledger itself, id-cursor and
  kind-filterable. This is the codified monitor recipe: a poll loop no longer hand-rolls
  SQL, it calls this verb on a cadence.

**The poll-cursor recipe.** Keep `nextSinceId` from the previous call and feed it back
as `--since-id` on the next one — every page (including an empty one) advances the
cursor to the ledger's current tail, so a poller can never get stuck rescanning the same
range:

```bash
sapwood events --since-id 0 --json          # first call: full history from the start
# -> read .nextSinceId from the response, e.g. 482
sapwood events --since-id 482 --json        # next poll: only what's new since then
```

Narrow a poll to what you actually need to watch with `--kind`/`--exclude-kind`
(repeatable, mutually exclusive — combining them is a rejected argument, not an invented
precedence) and page with `--limit` (hard-capped; an over-cap request is rejected, never
silently clamped). A busy writer past the finite lock timeout is reported as a clear
"busy, try again" failure — poll again, never treat it as "nothing happened." Reading
through a read-only filesystem snapshot (no live WAL visibility) is reported via
`snapshot.mode: "immutable-fallback"` under `--json` — know which kind of read you're
getting before trusting an empty page as "truly nothing new."

`status`/`events` are **DB-only by design** — neither makes a live GitHub call. The
gated/human-merge/needs-human queues live on GitHub and are read from there; see
[Queue queries](#queue-queries) below.

## Batch open ritual

Before dispatching a batch of work (starting a new `sapwood run`, or resuming after a
gap), work through these in order:

1. **Single-instance check.** Only one `sapwood run` may hold a given data dir
   (`data/sapwood.lock`, docs/troubleshooting.md's "Single-instance lock"). Don't guess —
   either read the lock file's recorded `pid` and confirm liveness yourself
   (`ps -p <pid>`), or let `sapwood run`/`sapwood park clear` make the call: both refuse
   with the holder's pid named when a live engine already has the lock. A refusal here
   means stop and investigate, never retry-until-it-works.
2. **dist/build freshness.** The `/sapwood-run`, `/sapwood-status`, and `/sapwood-stop`
   slash commands invoke the engine's TypeScript source directly (via `tsx`) and are
   always fresh. The bare `sapwood events` / `sapwood park clear` verbs used for
   supervision have no slash-command wrapper yet and, when invoked through a built
   `dist/cli.js` (`docs/getting-started.md`'s "About the bare `sapwood` command"), can be
   running against a stale build if engine source changed since the last
   `npm --workspace engine run build`. Before trusting their output in a batch, either
   rebuild (`npm ci && npm --workspace engine run build`) or invoke them the same way the
   slash commands do (`node .../node_modules/.bin/tsx .../engine/src/cli.ts <verb>`),
   which reads source directly and sidesteps the staleness question entirely.
3. **Config provenance.** Run `sapwood status --json` and read its `config` section:
   `{available: true, provenance: <resolved path>, lanesMax, dailyBudgetUsd}` when a
   config loaded, `{available: false}` when it didn't. `provenance` names the *exact*
   file that was actually loaded (an explicit `--config` or the default probe order) —
   confirm it's the profile you intend to run under before dispatching against it,
   especially when more than one config file exists in the tree.
4. **Dry-run pool sanity.** `sapwood run --dry-run` resolves config and previews an
   **empty-lane-set candidate/upper bound** — ready count, dispatchable count (after the
   real eligibility filter), the effective per-round lane limit, and a cost preview —
   with no worker spawned and no state written. It assumes a fresh round starting from
   zero occupied lanes; it does **not** read live lane occupancy, in-flight dedup, or the
   meta-floor anti-starvation accounting, so treat it as a rough upper bound on what
   *could* dispatch, never a replay of the exact next tick (`computeDryRunPreview`'s own
   doc, `engine/src/cli.ts`; see also [Est-vs-real cost method](#est-vs-real-cost-method)
   below, which leans on this same caveat). Run it before every batch open, not just the
   first one: it catches a config that would starve dispatch (0 dispatchable) or a pool
   that's unexpectedly large/small for what you intended, before any spend happens.

## Batch close ritual

Before ending a supervision session:

1. **Queue sweep.** Run the [queue queries](#queue-queries) below and account for every
   result — a batch does not "close" with an unexplained `needs-human` or
   `human-merge-only` item sitting unmentioned. Either it's handled (a decision recorded,
   a follow-up filed) or it's explicitly carried forward, never silently dropped.
2. **Owner-ruling recovery ritual.** A ruling recorded ONLY as a comment is not evidence a
   worker will ever see — workers read the issue body only (`{{issue.body}}`, see
   [`docs/security.md`](security.md#the-comment-adjudication-cursor-652)), and comments
   remain audit evidence, never the contract a worker is dispatched against; the body
   remains the worker contract. Two incidents are the paid-for cost of skipping this: the
   #604 incident (an owner's verbal endorsement was never recorded, and a later architect
   pass treated the issue as unresolved and blocked it) and the batch-8 incident (PR #651
   round 1: a binding owner ruling sat in issue comment #3 while the worker faithfully
   implemented the stale body — 5 P1s in one PR). Any owner ruling that lands during a
   session — a scope call, a merge authorization, a policy decision — is closed out with
   all four steps below, in order, **in that same session**, before the session ends. Do
   not defer "I'll write it up later," and do not stop partway (recording the ruling
   without rewriting the body reproduces the exact trap that caused batch-8):
   1. **Record the ruling** as a comment on the relevant issue/PR.
   2. **Rewrite the authoritative body** to fold the ruling in — the comment is evidence
      that a decision was made, not the decision a worker will act on.
   3. **Advance the [#652 adjudication
      cursor](security.md#the-comment-adjudication-cursor-652)**
      (`<!-- sapwood:comments-adjudicated-through: <comment-id> -->`) to the ruling
      comment or later, so gate⓪ and dispatch see the body as current rather than stale.
   4. **Remove `needs-human`**, if it was applied for this reason.
3. **Evidence posting.** Where a decision or intervention isn't self-evident from the
   event ledger alone (a `park clear --reason`, a manual label change, a judgment call
   the ledger can't express), post it as a comment on the issue/PR it concerns. GitHub is
   the audit trail for *process* — this durable-knowledge doc is not where a single
   session's blow-by-blow belongs (see this repo's own `CLAUDE.md`, "Documentation
   principle").

## Stop ritual

The kill switch (`data/KILL_SWITCH`) and pause (`data/PAUSE`) are plain file sentinels
next to the engine's state DB — see `/sapwood-stop`'s own doc
(`commands/sapwood-stop.md`) for the exact commands and the two tiers' distinct
semantics (kill switch freezes+drains everything; pause freezes only new dispatch).
This section covers the supervision-side placement/removal discipline layered on top:

- **Sentinel placement.** Set `data/KILL_SWITCH` (`mkdir -p data && touch
  data/KILL_SWITCH`) at the point you actually want dispatch/merges to freeze — the
  engine picks it up at the very next tick-top gate, so there's no reason to pre-place it
  "just in case." The natural placement for a clean stop is **at the last expected
  merge** of a batch: once the lane(s) you're waiting on have merged, set the sentinel
  before anything new could be dispatched into the gap.
- **Drain semantics.** A first stop signal (SIGTERM/SIGINT, or the kill-switch sentinel)
  freezes dispatch and asks in-flight lanes to hand off gracefully within
  `cfg.cost.drainWindowSec` (default 300s) before the conductor escalates to a hard kill.
  A **second** signal skips the drain and hard-exits immediately — in-flight lanes are
  NOT drained, so only send a second signal when you deliberately want to abandon
  whatever's running. `sapwood status` while draining shows the same active/driving
  lanes you'd see mid-run; watch it (or poll `events`) until active lanes reach zero
  rather than assuming the drain finished the moment you set the sentinel.
- **Sentinel removal.** `data/KILL_SWITCH`/`data/PAUSE` are OUT-OF-BAND controls — the
  engine never removes either one itself. Remove the sentinel only once you intend the
  *next* `sapwood run` (or the next tick, if the process is still alive under a signal
  stop rather than a hard exit) to resume normal dispatch — a leftover `KILL_SWITCH`
  after a stop-and-restart cycle silently re-freezes the fresh run, which reads as "the
  engine won't dispatch anything" with no other symptom. Confirm removal with `sapwood
  status`'s `kill switch: inactive` / `pause: inactive` lines before assuming the next
  run will actually work.

## Interpretation pointers

What a given event kind, park source, or escalation bucket **means**, and how urgent it
is, is generated reference — read the `sapwood-event-glossary` skill
(`.claude-plugin/skills/sapwood-event-glossary/SKILL.md`), not this doc: it's
regenerated from the engine's own source of truth and would drift the moment this page
tried to duplicate it. Its `routine` / `expected-noise` / `investigate` / `intervene`
actionability tiers are the vocabulary the rest of this playbook assumes.

**Expected-noise counting.** A single `expected-noise` event (a failed canary probe, a
retried thread write) is not a signal on its own — these kinds exist precisely because
the underlying retry/degrade path is supposed to self-heal. What IS worth reading is the
*count* over a window: `sapwood events --kind <kind> --since-id <cursor>` and counting
the matches tells you whether a given expected-noise kind is firing once (ignore it) or
repeatedly (worth reading the surrounding `investigate`/`intervene` events for what's
actually wrong upstream). This is a supervisor-side read, not an engine threshold — no
kind is reclassified by count; you are just choosing where to look next.

## Known blind spot: persistent forge-fetch failure in queued arms

**Adjudicated bounded blind spot (#662, 2026-08-06 ruling, Option B).** Several
`queued`-outcome arms in the drive family — `ac-drift-check-unavailable`
(`checkAcDriftBeforeDrive`), `comment-cursor-check-unavailable`
(`checkCommentCursorBeforeDrive`), and the `*-escalation-write-failed` /
`fix-leg-dispatch-failed` group — retry forever on a forge fetch that fails on *every*
attempt, not just a transient one. There is deliberately no consecutive-failure escalation
cap: distinguishing "permanently broken" from "rate-limited/network-blip" by a bare retry
count would either escalate a healthy lane on a bad day or need a second knob to avoid
that, and no dogfood evidence of an actual silent wedge has shown up to justify the
complexity (marginal-complexity doctrine — see `REVIEW-DOCTRINE.md`'s adjudication
principles, and #662 for the full ruling record). The containment is honest visibility —
one `drive-queued` event per reason change (never per-tick spam, #383 dedup) plus this
watch recipe — not an automatic escalation.

Spot a wedged lane with the same two read-only verbs from
[Supervising a run](#supervising-a-run):

```bash
# 1. Which lanes are driving right now, and on which (worker, issue, pr)?
sapwood status --json

# 2. For a lane that's been driving far longer than this repo's PRs normally take to
#    clear gate②, has its drive-queued reason stopped changing? These reason strings are
#    the forge-fetch-failure class:
#      ac-drift-check-unavailable, comment-cursor-check-unavailable,
#      review-disputed-escalation-write-failed, review-non-convergent-escalation-write-failed,
#      fix-rounds-cap-label-failed, fix-rounds-cap-comment-failed, fix-leg-dispatch-failed
sapwood events --issue <N> --kind drive-queued
```

If the same reason string keeps recurring across repeated polls with no `merged`,
`needs-human`, `ac-snapshot-drift`, or `comment-cursor-stale` event ever following it, the
forge call behind that arm is very likely broken for good, not transient — escalate by
hand (apply `needs-human`, comment the issue with the evidence) the same as any other
operator-observed intervention (see [Batch close ritual](#batch-close-ritual)).

## Queue queries

The gated (awaiting review gate) and human-merge-only/needs-human queues live on
GitHub, not in the state DB — `status`/`events` are deliberately DB-only (see
[Supervising a run](#supervising-a-run)). Query them with `gh` directly. Label names
below are the shipped defaults (`labels.prefix: sapwood:`); a repo running a different
prefix or a fully custom label set needs the equivalent substitution. `blocked`/`hold`
meaning (and how each differs from `needs-human`) lives in `docs/configuration.md`'s
`escalation.humanLabels`/`holdLabels` tables — read there, never re-derived here.

```bash
# Issues/PRs a human owes the next decision on:
gh issue list --repo OWNER/REPO --label "sapwood:needs-human" --state open
gh pr list    --repo OWNER/REPO --label "sapwood:needs-human" --state open

# Why is issue N labelled needs-human? The reason is on the carrier itself (#655's own
# marker-deduped comment on the FIRST escalation) and in the ledger — the latter is one
# command, no jq projection needed:
sapwood events --issue N

# PRs a human must merge (one-way verdict — never re-decided by the loop):
gh pr list    --repo OWNER/REPO --label "sapwood:human-merge-only" --state open

# blocked:
gh issue list --repo OWNER/REPO --label "sapwood:blocked" --state open
gh pr list    --repo OWNER/REPO --label "sapwood:blocked" --state open

# hold:
gh pr list    --repo OWNER/REPO --label "sapwood:hold" --state open
```

`sapwood status`'s `gated PRs (awaiting review gate)` count is the DB-side lane view
(PRs currently `driving`, waiting on gate②) — cross-reference it against the `gh pr
list` queries above rather than treating either alone as the complete picture: a PR can
be `driving` in the DB and simultaneously carry a human hold label on GitHub.

## Governance lines

- **List-never-merge.** A supervisor session's job is visibility and, where authorized,
  narrowly-scoped intervention (the kill switch, the pause sentinel, `park clear`) — it
  is never a merge decision. Merge authority follows the configured merge gate
  (`docs/security.md`), and `sapwood:human-merge-only` PRs are a human's call
  structurally, not a supervisor's to route around.
- **Owner decides, supervisor records+nags.** Scope/policy/merge-authorization decisions
  are the owner's; a supervisor session's job is to surface the queues that need a
  decision, record the decision once made (see [Batch close ritual](#batch-close-ritual)
  above), and follow up on anything left open — never to decide on the owner's behalf.
- **Breaker-park clear discipline.** `park clear --reason "<text>"` (#644) records the
  operator's reason for clearing a park episode verbatim in the receipt event and echoes
  it in stdout. It's advisory for a human clearing by hand; for an agent supervisor it is
  **required practice** — every clear an agent supervisor performs carries a `--reason`.
  Clearing the SAME source repeatedly in one session is a signal the underlying problem
  isn't actually resolving — treat a second same-source clear as a reason to stop
  clearing and escalate to a human (apply `needs-human` / raise it explicitly) rather
  than clear a third time.

> **OWNER RULING RECORDED (2026-08-04, PM session, this round):** an LLM supervisor
> session occupies the TRUSTED OPERATOR role. Interventions (kill-switch sentinel, pause
> sentinel, `park clear`) are operator surface — producer≠reviewer≠merger does not
> implicate the supervisor. Auditability requirement: agent-performed breaker-park
> clears must carry a recorded reason; repeated clears of the same source escalate to
> needs-human instead of auto-clearing. "Who watches the supervisor" stays an explicitly
> open PLAN.md long-arc item — not resolved, not silently assumed.

## Est-vs-real cost method

`sapwood run --dry-run` prices a batch BEFORE it starts (`previewUsd` — candidate count
× the configured soft per-worker budget). `sapwood status --json`'s `spend` section
prices what actually happened (`todayUsd`, `settledByWorker`, plus `unclassifiedUsd` +
an `incomplete` flag so a client can never mistake attribution gaps for zero spend). The
engine itself already reconciles ITS OWN per-lane estimate against the real terminal
`total_cost_usd` at terminal settlement (done/failed/handoff alike, not just a clean
finish), when a positive terminal cost is actually available — logging the divergence
when it is, and logging the estimate as the recorded spend (never a fabricated $0) when
it isn't (`writeTerminalSentinel`'s own doc, `engine/src/roles/worker.ts`; see
`docs/PLAN.md`'s Security model) — that is a per-lane mechanism, not a supervision one.

The supervision-side practice is a coarser, session-scoped series: note the dry-run
preview at batch open, note the settled spend at batch close, and track the two numbers
against each other across sessions. A preview that's consistently far from settled
spend (in either direction) is worth investigating — a stale `pricing.yaml`, a
config change that shifted which model workers run under, or a batch composition that
doesn't match what dry-run assumed (dry-run prices an empty-lane-set fresh round; it
does not replay exact next-tick occupancy). This is pure supervisor-side bookkeeping —
no new engine machinery backs it, and none should: the per-lane reconciliation the
engine already does is the authoritative number.

## See also

- [`docs/security.md`](security.md) — the trust/governance model: the guard hook,
  human-merge-only paths (canonical list — never re-enumerated here), the kill switch vs.
  pause distinction, cost ceilings.
- [`docs/configuration.md`](configuration.md) — every config key referenced above
  (`labels`, `escalation`, `cost`, `engine`) with its default and full semantics.
- [`docs/troubleshooting.md`](troubleshooting.md) — the single-instance lock, park
  episodes (env-failure/rapid-restart/consecutive-stalls/idle-churn), and what to do
  when each fires — the mechanics this playbook assumes.
- [`docs/PLAN.md`](PLAN.md) — architecture, the v1.1 real-supervisor roadmap item, and
  the open "who watches the supervisor" long-arc question.
- `sapwood-event-glossary` skill
  (`.claude-plugin/skills/sapwood-event-glossary/SKILL.md`) — what every event
  kind/park source/escalation bucket means and how actionable it is.
