# Security & trust model

sapwood's core claim is that it's safe to let an autonomous worker write code in your
repo because the loop structurally prevents it from also approving or merging that
code — not because you trust the model to behave. This page describes that model as it
exists today.

## Trust context

sapwood targets **trusted repos first**: your own repo or your team's, where issue
authors are trusted and issue text is not treated as hostile input. The architecture is
built toward public-repo hardening (scoped ephemeral tokens, an allowlisted-reviewer
requirement instead of any-non-author-approval, a threat model treating issue text as
adversarial), but those hardenings are not all in place yet — don't point an
unhardened sapwood at a public repo with untrusted issue authors.

## producer ≠ reviewer ≠ merger

The worker that writes code can never approve its own review or merge its own PR. This
is enforced structurally, not by asking the model nicely:

- **The fail-closed guard hook (`guard.ts`)** is a PreToolUse hook wired into every
  worker's headless `claude -p` session. It's a pure, zero-dependency, deterministic
  function: given a tool name and its input, it decides allow/block. For `Bash`, it
  tokenizes the command (shlex-equivalent splitting, recursing into `$()`/backtick
  substitutions), strips exec-prefixes (`env`, `npx`, leading assignments, etc.), and
  blocks any GitHub-overreach command a producer must never run: `gh pr merge`,
  `gh pr review --approve`, `gh pr ready`, `gh release`, and the mutating `gh api`/
  GraphQL equivalents. Opaque constructs a worker could hide anything inside —
  `eval`, `sh -c`, an interpreter's `-e`/`-c`, process substitution — are blocked
  outright, fail-closed, rather than inspected.
- **The merge is always executed by the conductor**, never the worker. Only
  `merge-driver.ts`'s `driveOne` calls the merge API; `tick()` (the path a worker's own
  session runs inside) never does. This holds even if the guard hook were somehow
  bypassed — it's a structural separation, not just an argv check.
- **Fail-closed on error.** The hook denies on malformed JSON, a non-object payload, a
  malformed `tool_input` for a guarded tool, or any exception thrown while deciding. A
  safety hook that can be disabled by feeding it garbage isn't one.

### Guard modes: hard vs. soft

`guard.mode` (default `hard`) controls how the hook responds to a blocked command:

- **`hard`** — fail-closed deny. This is the actual safety boundary and the only mode
  that should run against real, unattended dispatch.
- **`soft`** — observe-only: the hook logs what it *would* have blocked but allows the
  command through anyway. This exists only as a first-run/dogfood affordance for
  watching what the guard would catch without yet trusting it to block — never the
  shipped default, and not a mode to leave on for real autonomous runs.

The mode reaches the guard hook via a spawn-time environment variable
(`SAPWOOD_GUARD_MODE`) that the engine sets when it launches the worker process — not a
worker-writable settings file — so a worker cannot weaken its own guard mode by editing
config mid-run.

## Human-merge-only paths

Some files are structurally off-limits to an autonomous worker because changing them
would let a worker weaken the very mechanism that constrains it. Any change to these is
**human-merge-only**, regardless of what merge mode is configured:

- `guard.ts` / the guard hook wiring
- `reviewer.ts` / `merge-driver.ts`
- security-relevant config (guard mode, reviewer mode, merge mode)
- `.claude/settings*.json` and `.github/workflows/**`

The guard enforces this as a write-path denial (both for the `Write`/`Edit` tools and
for `Bash` redirection/`tee`/`sed -i`/`git mv`/etc. against these paths, checked
position-independently so a wrapper can't hide the write) — but the human-merge-only
rule is also a process rule: even a PR that touches these files and somehow passes CI
and review is not something the conductor should be configured to auto-merge.

## Two-tier human controls

sapwood has two independent file-sentinel controls, both living next to the engine's
state DB (`data/`), neither requiring a config edit:

- **Kill switch** (`data/KILL_SWITCH`) — the strict tier. Freezes *all* new dispatch and
  merges. Running workers are asked to hand off gracefully within
  `cost.drainWindowSec`; past that window the conductor escalates to a hard
  process-tree kill. Everything else freezes too: no dispatch, no drive/merge, no
  rollback retry, no reclaim-and-requeue of crashed lanes. Set/lift it with
  `/sapwood-stop` (no argument to set, `--lift` to remove) or by touching/removing the
  file directly.
- **Pause** (`data/PAUSE`) — the gentle tier. Freezes *new dispatch only*. Everything
  already in flight — running workers, PRs already moving through the review/merge
  gate — proceeds exactly as normal. No drain, nothing killed. Use this to stop taking
  on new issues while letting the current round finish (e.g. before a maintenance
  window). Set/lift with `/sapwood-stop --pause` / `--resume`.

If both sentinels are present, the kill switch's stricter behavior governs.

**Interaction with `--until-idle`:** a paused engine dispatches nothing, so once its
in-flight lanes finish it counts as idle and the run exits on its own — "finish the
round, then stop." Removing `data/PAUSE` afterward doesn't resume anything by itself;
start a new `sapwood run`. Under the daemon (`forever`) mode, the engine keeps ticking
and `--resume` takes effect on the very next tick.

### Sentinel isolation boundary (honest statement)

The engine's `data/` directory (which holds both sentinels and the state DB) sits
outside worker git worktrees as a **permission-layer boundary** — the worker process is
not launched with `--add-dir data`, so it has no `claude`-tool path into that directory.
This is **not an OS-level sandbox**: a worker is still allowlisted to run `Bash(node
*)`/`Bash(npm *)`, and the guard blocks `node -e <inline>` but not `node
some-script.js` where that script (written via the ordinarily-permitted `Write` tool)
reaches out via a relative path like `../../data/PAUSE` and touches or unlinks a
sentinel directly. This residual vector is tracked in **issue #81** (guard
defense-in-depth for `data/KILL_SWITCH` and `data/PAUSE`), not yet closed. Until it is,
treat the sentinel boundary as "a worker won't accidentally step here," not "a worker
provably cannot reach here."

## Cost ceilings vs. the soft worker budget

Two different things are both called "budget," and they behave differently on purpose:

- **`worker.budgetUsdSoft`** is a **soft** per-worker budget. Reaching it is designed to
  trigger a graceful handoff — finish the current atomic step, commit + push WIP, write
  a progress note, drop a `.handoff` sentinel carrying a resumable session id, exit
  clean — **never** a mid-work `SIGKILL`. A hard kill mid-step both burns the spend and
  throws away the work; a graceful handoff preserves both. (Live enforcement of this
  exact threshold is pending a real in-flight cost signal the worker doesn't have yet;
  today the effective per-worker bound is `worker.timeoutSec` plus the hard ceiling
  below.)
- **`cost.dailyBudgetUsd` / `cost.maxWallClockSec`** are **hard** engine-wide ceilings —
  the actual runaway-spend safety boundary, independent of any single worker. Breaching
  either freezes new dispatch/merges and starts draining in-flight workers
  (`cost.drainWindowSec`'s grace window), same "drain before kill" posture as the kill
  switch: give a worker the chance to hand off cleanly, and only escalate to a hard
  process-tree kill once the drain window elapses.

In both directions the design favors **drain-then-escalate over an immediate hard
stop** — a hard kill is the last resort, not the first response, because it destroys
in-progress work as well as spend.

## The `origin:agent` label convention

Any GitHub issue created *by an agent* (as opposed to authored directly by a human)
must carry the `origin:agent` label. `sapwood init` provisions this label like the rest
of the taxonomy.

Today this is a **convention, not yet enforced machinery** — no part of sapwood
currently opens issues on your behalf, so nothing yet applies the label automatically.
The machinery lands with v0.2's round-orchestrator peripheral roles (see
[`PLAN.md`](PLAN.md)'s v0.2 chapter): when a peripheral role (e.g. goal-alignment /
decomposition) opens an issue, it will apply `origin:agent` itself, and an
agent-created issue will additionally require **explicit human confirmation** before it
can enter `Ready` — an agent can propose work, but a human still decides what actually
enters the dispatch queue. Provisioning the label now means that gate can be turned on
later without a taxonomy migration.

## See also

- [`configuration.md`](configuration.md) — the `guard`, `reviewer`, `merge`, `cost`,
  and `labels` config sections referenced above.
- [`PLAN.md`](PLAN.md) — the full architecture, decision log, and the v0.2 round
  orchestrator's self-feed design.
