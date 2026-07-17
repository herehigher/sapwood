# Getting started

sapwood is a [Claude Code](https://claude.com/claude-code) plugin: it turns a GitHub
issue backlog into reviewed pull requests. This page takes you from a clean repo to a
first autonomous run.

## Requirements

- **Node.js ≥ 24** (the engine uses the built-in `node:sqlite`, no native build step).
- **Claude Code CLI ≥ 2.0** — workers run as headless `claude -p` sessions.
- **GitHub CLI (`gh`)**, authenticated with the `project` scope:
  ```
  gh auth login
  gh auth refresh -s project   # if you're already logged in but missing the scope
  ```
- A GitHub repo with a ProjectV2 board you're willing to let sapwood drive.

## Install

Add sapwood as a Claude Code plugin (see the
[Claude Code plugin docs](https://claude.com/claude-code) for how your setup loads
plugins — e.g. `claude plugin add` or a marketplace entry pointing at this repo).
Once installed, the slash commands `/sapwood-run`, `/sapwood-status`, and
`/sapwood-stop` are available inside any Claude Code session opened in the target
repo — they invoke the engine for you, no PATH setup needed.

**About the bare `sapwood` command**: installing the plugin does NOT put a `sapwood`
binary on your PATH. Throughout these docs, `sapwood <cmd>` is shorthand for running
the engine's CLI directly from the plugin checkout:

```
npm ci && npm --workspace engine run build   # once
node <plugin-root>/engine/dist/cli.js <cmd>  # every "sapwood <cmd>" in these docs
```

or put it on PATH yourself with `npm link --workspace engine` from the plugin root.
If you only ever use the slash commands, you can skip this entirely.

## `sapwood init`

Run init once, from the repo you want sapwood to operate on:

```
sapwood init
```

`init` is idempotent and safe to re-run. It:

1. **Preflights your `gh` auth** — fails with the exact fix (`gh auth login` /
   `gh auth refresh -s project`) if you're not logged in or missing the `project`
   scope, before touching anything.
2. **Detects user vs. org** for the configured `board.owner`.
3. **Ensures the label taxonomy exists** (with the default `labels.prefix`: `sapwood:type:*`, `sapwood:prio:0`–`3`,
   `sapwood:in-progress`, `sapwood:needs-human`, `sapwood:blocked`, `sapwood:reserve`,
   `sapwood:verify:n/a`, `sapwood:plan:approved`, `sapwood:origin:agent`) — detection is
   case-insensitive and missing labels are created lowercase, so it never clobbers labels
   you've already customized. Set `labels.prefix: ""` for bare defaults; explicitly configured
   workflow-label values are used verbatim. Existing pre-#199 repositories must complete the
   [label migration before restarting sapwood](configuration.md#upgrading-from-pre-199).
4. **Ensures any configured milestones exist** (`config.milestones`; empty by default —
   sapwood only needs labels + board lanes, milestones are your organizational choice).
5. **Ensures the ProjectV2 board's `Status` field has the configured lanes**
   (`Ready` / `In Progress` / `Done` by default) — if the board doesn't exist at the
   configured `board.projectNumber`, init reports what to create rather than guessing.
6. **Writes a starter `sapwood.config.yaml`** (with inline comments) if none exists yet.
7. **Scaffolds starter goal and review-doctrine files** at their configured paths
   (`goal.file`, `doctrine.file`) if missing — never overwrites an existing file.
8. **Scaffolds `.github/ISSUE_TEMPLATE/`** (feature / fix / docs / chore, matching the
   structure the gate⓪ plan-drafter normalizes toward) — each template is written only
   if that file is missing, so repos with their own templates are untouched.

If `init` fails partway through (e.g. a `gh` scope problem), fix the reported issue and
re-run — every step is detect-before-create, so nothing is duplicated.

## Configure

Edit the `sapwood.config.yaml` init wrote — at minimum, set `board.owner`,
`board.repo`, and `board.projectNumber` to your repo and its ProjectV2 board number.
Every other key has a sensible default. See [`configuration.md`](configuration.md) for
the full reference.

## First-run trust ramp

Don't point sapwood at a live backlog and walk away. Ramp up in stages:

1. **`sapwood validate`** — load and validate your config with zero side effects:
   ```
   sapwood validate
   ```
   Reports either a one-line OK summary (with the effective `lanes.max`,
   `guard.mode`, `merge.mode`) or every validation issue, one per line. Run this after
   any config edit.

2. **`sapwood run --dry-run`** — see what the engine *would* do, without doing it:
   ```
   sapwood run --dry-run
   ```
   Resolves config, lists the `Ready` issues that would be dispatch candidates (a rough
   upper bound — it assumes empty lanes and skips the in-flight/anti-starvation checks a
   real tick applies), and prints a cost estimate (candidates × `worker.budgetUsdSoft`,
   against `cost.dailyBudgetUsd`). No worker is spawned and no state is written — safe
   to run repeatedly.

3. **`sapwood run`** (steady state) — as of #106, this drives the **round
   orchestrator** by default (`engine.driver: rounds`): a round dispatches a batch
   (claim → worker → PR → review gate → merge, same tick engine underneath), then
   runs peripheral roles around it — goal alignment, architecture review, gate⓪ plan
   review, harvest, retrospective — before opening the next round. It ticks
   indefinitely until a signal (Ctrl-C / SIGTERM — the in-flight round always finishes,
   harvest included, before the process exits) or a configured
   [stop condition](configuration.md#stop) fires. There's no `--once`/`--until-idle`
   equivalent for a round — passing either flag under the rounds default is an
   **error** (exit 1, before anything dispatches), never silently ignored; the error
   names the fix (see step 4 below if you want that shape for your first run, or use
   `--stop-after-issues`/`--stop-after-prs`/`--stop-on-milestone` to bound a rounds
   run). For "just work milestone M, stop when it's done" — the most common bounded
   run — `--milestone M` is a shortcut for scoping dispatch to M **and** stopping once
   M is complete, in one flag (see [`configuration.md#stop`](configuration.md#stop)).

4. **The M4 tick-driver escape hatch** — set `engine.driver: tick` in
   `sapwood.config.yaml` to run the pre-#106 loop driver instead (no peripherals):
   ```
   engine:
     driver: tick
   ```
   With `driver: tick`, the same first-run staging `--once`/`--until-idle` flags from
   pre-#106 apply:
   - **`sapwood run --once`** — dispatch one wave, then hand back the terminal. Leave
     exactly one issue `Ready` on the board and run `sapwood run --once`. This runs a
     single tick (reclaim → drive → resume → dispatch) and exits. Note what that does NOT mean:
     the dispatched worker keeps running **detached in the background** after the CLI
     returns — its TDD work, the PR, and the review gate all happen later, driven by
     subsequent ticks. Watch it with `sapwood status`, and run `sapwood run --once`
     again (or move to `--until-idle`) to drive the resulting PR through the gate.
   - **`sapwood run --until-idle`** — the "watch one issue end-to-end" mode: keeps
     ticking until nothing is in flight and nothing new dispatches, then exits cleanly
     — with one `Ready` issue this is claim → worker → PR → review gate → merge,
     supervised to completion. Also good for a bounded batch run.
   - **`sapwood run`** (daemon / "forever" mode) — ticks on
     `cfg.engine.tickIntervalSec`'s cadence indefinitely, same signal/stop-condition
     exit as the round orchestrator above, minus the peripherals.

At every stage, `sapwood status` (below) tells you what's happening without needing a
live session, and `/sapwood-stop` is always available to freeze or gently pause the
engine — see [`security.md`](security.md) for exactly what each control does.

## Slash commands

These are thin wrappers around the `sapwood` CLI, meant to be run from inside a Claude
Code session opened in the target repo:

- **`/sapwood-run [--once|--until-idle|--dry-run]`** — runs `sapwood run` with the given
  mode and reports its output. No flags = daemon mode.
- **`/sapwood-status [db-path]`** — runs `sapwood status`, reading the state DB directly
  (`data/sapwood.sqlite` by default). Works even with no engine session currently
  running.
- **`/sapwood-stop [--pause|--resume|--lift]`** — sapwood's two tiers of human control:
  - No argument: trips the **kill switch** — freezes all new dispatch and merges;
    running workers are asked to hand off gracefully, then the conductor escalates to a
    hard kill past the drain window. `--lift` reverses it.
  - **`--pause`**: the gentle tier — freezes new dispatch *only*. Everything already in
    flight (running workers, PRs moving through the review/merge gate) keeps going
    normally. `--resume` lifts it.

  See [`security.md`](security.md#two-tier-human-controls) for the full semantics, including how
  pause interacts with `--until-idle`.

## Writing a `Ready` issue

sapwood will not dispatch an issue until it's genuinely ready to hand to an autonomous
worker. An issue moves to the `Ready` lane on the board when it carries:

- **Acceptance criteria** — what "done" looks like, stated concretely.
- **A verification plan** — how to prove those criteria are met: tests to write/run,
  commands to execute, observable outcomes to check. The worker reads this first and
  follows it; the reviewer re-checks the finished PR against the same plan at the
  review gate.

Without a verification plan, `getReadyIssues` refuses to dispatch the issue at all —
there's no partial-credit path.

**Docs/chore work that can't be verified by tests** (a documentation change, a
config-only tweak) is inherently unverifiable in the test sense. Label it with the configured
`labels.verifyNa` value (`sapwood:verify:n/a` by default) instead of writing a verification
plan: this routes the issue through the
doc-gate path (the reviewer checks that the described durable-knowledge change actually
landed) rather than a red/green test cycle. `sapwood init` provisions the `sapwood:verify:n/a`
label for you.

As of gate⓪ (#88), a plan being present isn't enough on its own either: the configured
`labels.planApproved` label (`sapwood:plan:approved` by default) is also required before
`getReadyIssues` will dispatch an issue without `labels.verifyNa` — it
means the plan-reviewer peripheral judged the acceptance criteria and verification plan
actually executable, not just present. See
[`security.md`](security.md#the-planapproved-label-and-gate-88) for the full gate. The default rounds driver
runs the plan-reviewer peripheral each round and applies it automatically when it approves
a plan; `sapwood init` provisions the label like `sapwood:verify:n/a` and
`sapwood:origin:agent` above.

Any issue a human didn't personally author — including one an agent role opens on your
behalf — should carry the configured `labels.originAgent` label (`sapwood:origin:agent` by
default); see
[`security.md`](security.md#the-originagent-label-convention) for why.

## Next steps

- [`configuration.md`](configuration.md) — every config key.
- [`security.md`](security.md) — the trust and governance model.
- [`troubleshooting.md`](troubleshooting.md) — common failures and what they mean.
