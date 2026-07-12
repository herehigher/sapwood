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
