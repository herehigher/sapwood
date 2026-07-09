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
3. **Ensures the label taxonomy exists** (`type:*`, `prio:0`–`3`, `in-progress`,
   `needs-human`, `blocked`, `reserve`, `verify:n/a`, `origin:agent`) — detect-before-create,
   so it never clobbers labels you've already customized.
4. **Ensures any configured milestones exist** (`config.milestones`; empty by default —
   sapwood only needs labels + board lanes, milestones are your organizational choice).
5. **Ensures the ProjectV2 board's `Status` field has the configured lanes**
   (`Ready` / `In Progress` / `Done` by default) — if the board doesn't exist at the
   configured `board.projectNumber`, init reports what to create rather than guessing.
6. **Writes a starter `sapwood.config.yaml`** (with inline comments) if none exists yet.

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

3. **`sapwood run --once`** — dispatch one wave, then hand back the terminal. Leave
   exactly one issue `Ready` on the board and run:
   ```
   sapwood run --once
   ```
   This runs a single tick (reclaim → drive → dispatch) and exits. Note what that does
   NOT mean: the dispatched worker keeps running **detached in the background** after the
   CLI returns — its TDD work, the PR, and the review gate all happen later, driven by
   subsequent ticks. Watch it with `sapwood status`, and run `sapwood run --once` again
   (or move to `--until-idle`) to drive the resulting PR through the gate.

4. **`sapwood run --until-idle`** — the actual "watch one issue end-to-end" mode:
   ```
   sapwood run --until-idle
   ```
   Keeps ticking until nothing is in flight and nothing new dispatches, then exits
   cleanly — with one `Ready` issue this is claim → worker → PR → review gate → merge,
   supervised to completion. Also good for a bounded batch run.

5. **`sapwood run`** (daemon / "forever" mode) — ticks on `cfg.engine.tickIntervalSec`'s
   cadence indefinitely, until a signal (Ctrl-C / SIGTERM) or a configured
   [stop condition](configuration.md#stop) fires. This is the steady-state mode once
   you trust the loop.

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

  See [`security.md`](security.md#human-controls) for the full semantics, including how
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
config-only tweak) is inherently unverifiable in the test sense. Label it
`verify:n/a` instead of writing a verification plan: this routes the issue through the
doc-gate path (the reviewer checks that the described durable-knowledge change actually
landed) rather than a red/green test cycle. `sapwood init` provisions the `verify:n/a`
label for you.

As of gate⓪ (#88), a plan being present isn't enough on its own either: a `plan:approved`
label is also required before `getReadyIssues` will dispatch a non-`verify:n/a` issue — it
means the plan-reviewer peripheral judged the acceptance criteria and verification plan
actually executable, not just present. See
[`security.md`](security.md#plan-approved) for the full gate. That peripheral session
isn't wired yet, so today `plan:approved` must be applied by hand; unlike `verify:n/a`
and `origin:agent` above, `sapwood init` does not yet provision this label.

Any issue a human didn't personally author — including one an agent role opens on your
behalf — should carry the `origin:agent` label; see
[`security.md`](security.md#origin-agent) for why.

## Next steps

- [`configuration.md`](configuration.md) — every config key.
- [`security.md`](security.md) — the trust and governance model.
- [`troubleshooting.md`](troubleshooting.md) — common failures and what they mean.
