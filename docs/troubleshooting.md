# Troubleshooting

What common failures mean and how to respond.

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

This label means: **automation has stopped working this issue/PR and is waiting on
you.** sapwood deliberately degrades rare edge cases to `needs-human` rather than
building more automation to handle them — see the issue comment or PR thread for the
specific reason (a structured event and/or comment is posted alongside the label
explaining what happened).

To clear it: investigate and resolve whatever's described, then remove the label by
hand. Removing `needs-human` does not automatically re-dispatch anything — if the issue
should re-enter the loop, move it back to `Ready` on the board yourself.

Both `escalation.humanLabels` (default `[needs-human, blocked]`) hold an issue out of
the main dispatch lane — any issue carrying either label is skipped by dispatch
regardless of its board status.

## Dirty-worktree degrade

When a lane is torn down (a dead worker reclaimed, a drain-window escalation, or a
`.failed` sentinel) and its worktree might hold uncommitted work, sapwood **never
deletes it** — it can't prove the worktree is clean, and deleting possibly-uncommitted
work is worse than leaving it on disk. Instead:

- The worktree is retained at its original path.
- A `needs-human` label is applied to the issue **and**, if a PR already exists for that
  lane, to the PR itself (the merge gate reads a PR's own labels, not the source
  issue's — a crash-with-WIP must not let its incomplete PR auto-merge while the WIP
  awaits salvage).
- An issue comment is posted naming the exact worktree path:
  > "sapwood: lane `<name>` was torn down with possibly-uncommitted changes in its
  > worktree. Automation never deletes work it can't prove is clean (#69) — the
  > worktree was left on disk at: `<path>`. Salvage or discard it by hand, then remove
  > the `needs-human` label."

To resolve: go to the path named in the comment, decide whether the uncommitted changes
are worth keeping (commit/push them yourself, or discard the worktree by hand), then
remove the `needs-human` label. The lane will not be reused until you do.

## Kill switch recovery

If `data/KILL_SWITCH` is set (via `/sapwood-stop` or by hand), all new dispatch and
merges are frozen and running workers are being drained. Recovery:

1. Check `sapwood status` — it reports `kill switch: ACTIVE` and shows any in-flight
   lanes still draining.
2. Once you're satisfied it's safe to resume, run `/sapwood-stop --lift` (or
   `rm -f data/KILL_SWITCH`).
3. Dispatch and merges resume on the **next tick** — a switch lifted mid-tick doesn't
   take effect within that same tick.

If a drain escalated to a hard kill (the drain window elapsed before a worker handed
off), that lane's issue/PR will carry `needs-human` — see above.

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

## Stale heartbeat reclaim

Each running worker writes a heartbeat; if the most recent one is older than
`worker.heartbeatStaleSecs` (default 180s), the conductor considers that worker dead and
reclaims its lane on the next tick — regardless of whether the worker process is
actually still running (e.g. a hung process that stopped heartbeating). This is
expected recovery behavior, not a bug: it's what makes a session-bound engine
(`sapwood run` dies on SIGHUP) safe to restart — a stale-heartbeat worker is always
reclaimed on the next tick rather than silently holding its lane forever.

If reclaim finds no terminal sentinel and a possibly-dirty worktree, it follows the
dirty-worktree degrade path above (retain + `needs-human`), never a silent requeue of
in-progress work.

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

## See also

- [`security.md`](security.md) — the guard, human controls, and escalation model
  behind several of the behaviors above.
- [`configuration.md`](configuration.md) — every config key referenced above.
