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
   The **engine repeats this same provisioning pass at every `sapwood run` startup**, from the
   same list — so a repo initialized before a newer workflow label existed (say
   `sapwood:round:pool`) simply gets that label created on the next start, with no manual
   label-creation step. It is best-effort: if the token cannot create labels, the engine logs
   the failure and starts anyway.
4. **Ensures any configured milestones exist** (`config.milestones`; empty by default —
   sapwood only needs labels + board lanes, milestones are your organizational choice).
5. **Ensures the ProjectV2 board's `Status` field has the configured lanes**
   (`Ready` / `In Progress` / `Done` by default) — if the board doesn't exist at the
   configured `board.projectNumber`, init reports what to create rather than guessing.
6. **Writes a starter `sapwood.config.yaml`** (with inline comments) if none exists yet.
7. **Scaffolds starter goal and review-doctrine files** at their configured paths
   (`goal.file`, `doctrine.file`) if missing — never overwrites an existing file.
8. **Scaffolds `.github/ISSUE_TEMPLATE/`** (feature / fix / docs / chore, matching the
   structure the gate⓪ verification-plan-drafter normalizes toward) — each template is written only
   if that file is missing, so repos with their own templates are untouched.

If `init` fails partway through (e.g. a `gh` scope problem), fix the reported issue and
re-run — every step is detect-before-create, so nothing is duplicated.

## Configure

Edit the `sapwood.config.yaml` init wrote — at minimum, set `board.owner`,
`board.repo`, and `board.projectNumber` to your repo and its ProjectV2 board number.
Every other key has a sensible default. See [`configuration.md`](configuration.md) for
the full reference.

## L0–L3 autonomy ladder

You do not have to hand sapwood a live backlog and full merge authority on day one.
Choose the level whose risk boundary fits today, then step up **or step down** as often
as you need. These are names for existing controls, not new engine modes: every active
level keeps the same guard, cost ceilings, and configured review gate.
`guard.mode: hard` is what makes the merge promises below enforceable rather than
advisory; `soft` only logs commands that hard mode would block.

Run `sapwood validate` after every config change. It loads and validates the config with
zero side effects and reports either a one-line OK summary (including the effective
`lanes.max`, `guard.mode`, and `merge.mode`) or every validation issue:

```
sapwood validate
```

### L0 — Observe

**Promise:** inspect the candidate work and estimated exposure without letting sapwood
act.

- **Exact config/flags:** keep the config you want to evaluate and run
  `sapwood run --dry-run`. To evaluate a named profile, use
  `sapwood run --dry-run --config PATH`.
- **Risk profile:** read-only preview. No worker is spawned and no state is written.
- **What you see:** the `Ready` issues that would be dispatch candidates and a cost
  estimate (`worker.budgetUsdSoft` × candidate count, compared with
  `cost.dailyBudgetUsd`). The candidate list is a rough upper bound: dry-run assumes
  empty lanes and omits the live tick's in-flight and anti-starvation checks. The *cost*
  side is only as good as `worker.budgetUsdSoft`, and the shipped `10` is calibrated for
  small-to-medium work — on the shipped `opus`/`high` profile a substantive issue runs
  ~$8–20 per leg, so the estimate reads low and legs hand off mid-work. Read
  [Calibrating `budgetUsdSoft`](configuration.md#calibrating-budgetusdsoft) before
  trusting this number for your own profile.
- **Step up:** choose L1's single-issue profile, leave exactly one issue `Ready`, and
  supervise it with `sapwood run --until-idle`.
- **Step down:** from any higher level, return here by stopping the active run and using
  `sapwood run --dry-run`. Repeated previews are a normal operating choice, not a
  failed rollout.

### L1 — Supervise one issue

**Promise:** watch one issue travel from claim to a reviewed PR while merge remains a
human decision.

- **Exact config/flags:** leave exactly one issue `Ready`, use this profile, then run
  `sapwood run --until-idle`:

  ```yaml
  engine:
    driver: tick
  guard:
    mode: hard
  lanes:
    max: 1
    roundDispatchCap: 1
  merge:
    mode: produce-pr-and-stop
  ```

  `--until-idle` is available only with `engine.driver: tick`.
- **Risk profile:** sapwood changes the issue/board, runs one coding worker, pushes its
  branch, opens a PR, and drives the configured review gate, but it never calls the
  merge API. Keeping exactly one issue `Ready` is the dispatch-scope boundary;
  `lanes.max: 1` limits concurrency but does not by itself limit the run to one issue.
- **What you see:** the end-to-end lifecycle in the terminal, `sapwood status`, and
  GitHub. Once the gates pass, the reviewed PR and its lane wait for your merge; keep
  the command running, merge the PR, and it exits after the engine observes that no
  lane remains in flight and nothing else can dispatch.
- **Step up:** move to L2 by restoring `engine.driver: rounds` (or removing the
  override), choosing the concurrency you want, and retaining
  `merge.mode: produce-pr-and-stop`.
- **Step down:** stop the run, move any extra issue out of `Ready`, and return to L0
  dry-run previews. Repeating L1 for each issue is also a fully supported steady
  operating level.

### L2 — Delegate work, keep merge

**Promise:** let sapwood run its normal governed development rounds while every final
merge remains yours.

- **Exact config/flags:** use the default round driver with human merge authority:

  ```yaml
  engine:
    driver: rounds
  guard:
    mode: hard
  merge:
    mode: produce-pr-and-stop
  ```

  Run `sapwood run`, or start with a bounded invocation such as
  `sapwood run --stop-after-prs 1`. See [stop conditions](configuration.md#stop);
  count thresholds are floors checked at tick boundaries, so a crossing tick may
  already have dispatched up to `lanes.roundDispatchCap` additional lanes.
- **Risk profile:** sapwood may claim and implement multiple issues up to the configured
  `lanes.max` and `lanes.roundDispatchCap`, open PRs, and compute/report both review
  gates. `produce-pr-and-stop` prevents the engine from merging; a human merges each
  gated PR.
- **What you see:** complete rounds (alignment, architecture, gate⓪ plan review,
  execution, harvest, and retrospective), plus reviewed PRs queued for your merge
  decision. `sapwood status` remains available without a live session.
- **Step up:** after the review and CI evidence earn your trust, stop the run, change
  only `merge.mode` to `conductor-merge` for L3, then restart. Config is loaded once
  at `runEngine()` startup; editing YAML does not change a running conductor.
- **Step down:** restore the L1 tick-driver profile, set both lane limits to `1`, and
  expose exactly one `Ready` issue. Returning to supervised work is routine risk
  management.

### L3 — Governed unattended merge

**Promise:** let sapwood carry eligible issues through independent review and merge
without waiting for a human click.

- **Exact config/flags:** use the default driver and merge mode:

  ```yaml
  engine:
    driver: rounds
  guard:
    mode: hard
  merge:
    mode: conductor-merge
  ```

  Run `sapwood run`. A bounded unattended run can use an existing stop control, for
  example `sapwood run --milestone "M"` to scope dispatch to that exact milestone and
  wind down when it is complete.
- **Risk profile:** this is the highest-autonomy level. Once gate① (CI) and gate② (the
  configured fresh non-author review) pass, the conductor squash-merges the exact
  reviewed head. The producer still cannot review, approve, or merge its own work;
  guard enforcement, cost ceilings, pause, and the kill switch remain active.
- **What you see:** issues move through the board to reviewed, merged PRs; status and
  run logs provide the operating view, while exceptions escalate to human attention.
- **Step up:** L3 is the top of this ladder; increase scope or concurrency only through
  the existing `round.milestone`, `lanes.max`, and `lanes.roundDispatchCap` controls.
- **Step down:** stop the run, change `merge.mode` back to `produce-pr-and-stop` for
  L2 (or restore the L1 profile for single-issue supervision), then restart. Config
  is loaded once at `runEngine()` startup; editing YAML does not change a running
  conductor. Reducing autonomy does not discard state or bypass the review gate.

### Run shapes behind the levels

The default `engine.driver: rounds` runs a complete round indefinitely until a signal
(Ctrl-C / SIGTERM — the in-flight round always finishes, harvest included) or a
configured [stop condition](configuration.md#stop) fires. A round has no
`--once`/`--until-idle` equivalent; passing either flag with the rounds driver is an
error before dispatch. `--milestone NAME` is the common bounded-round shortcut: it
scopes dispatch to that exact milestone and stops when the milestone is complete.

The L1 profile uses `engine.driver: tick`, the bare loop without peripherals. Its run
shapes are:

- `sapwood run --once` runs one reclaim → drive → resume → dispatch tick and exits.
  A dispatched worker remains detached in the background; later ticks are needed to
  drive its PR through the gate.
- `sapwood run --until-idle` keeps ticking until no lane is in flight and nothing new
  dispatches, then exits.
- `sapwood run` ticks on `engine.tickIntervalSec` indefinitely, with the same
  signal/stop-condition exit behavior as the round driver.

At every level, `sapwood status` (below) tells you what's happening without needing a
live session, and `/sapwood-stop` is always available to freeze or gently pause the
engine — see [`security.md`](security.md) for exactly what each control does.

## Running under a supervisor

sapwood deliberately ships **no supervisor of its own** — process supervision is the
operator's concern, and the platform (systemd, launchd, a loop script) already solves it
with fewer failure modes than a bundled `--supervise` parent would add. What sapwood
ships instead is a **supervision contract** the engine holds up its end of:

- **Exit semantics.** A clean stop — a signal, a `stop.*` condition, `--once`/
  `--until-idle`, the kill switch — writes a durable `run-ended` event naming the reason
  and exits (`0`, except the kill switch and a failed `--once`, which exit `1` so a
  script notices). A **self-diagnosed stall** — the progress watchdog observing a whole
  window with zero durable events — writes `engine-stalled` and exits **nonzero**: that
  nonzero exit is the restart request. A crash writes nothing, and that absence is
  itself meaningful (see [troubleshooting.md](troubleshooting.md#how-a-dead-engine-says-why-it-died-407)).
- **Restart is always safe.** Startup is rerun-not-resume: reconcile recovers the round
  in flight, adopts still-alive detached workers, and a restart after a stall records
  `engine-restart-after-stall` for the audit trail — no manual step, no state surgery.
- **The engine carries its own restart-loop backstops**, so supervision cannot turn a
  deterministic failure into an infinite loop: `engine.rapidRestart` parks a **crash
  loop** (too many process births in a window), and `liveness.maxConsecutiveStalls`
  parks a **deterministic wedge** (consecutive stalled runs with no round closed between
  them) — both escalate to a human through the park channel instead of burning restarts.
  The stall count resets **only on real progress — a round closing — never on how a run
  exited**: clean stops (including the SIGTERM your supervisor sends before every
  restart) and crashes alike are neutral, so no restart pattern can launder a wedge past
  the breaker (the engine cannot observe the intent behind a signal and does not infer
  it). An established `consecutive-stalls` park **never auto-clears**: it stands, with
  its single escalation, across any number of restarts until you clear it explicitly —
  see [troubleshooting.md](troubleshooting.md#consecutive-stalls-park-407) for the
  operator-clear step. These are backstops, not a substitute: configure the
  supervisor's **own** circuit-breaker too — a *prerequisite* for unattended supervised
  runs ([security.md](security.md)'s supervisor prerequisite).
- **Stopping a supervised engine** is the supervisor's stop verb (e.g. `systemctl stop`),
  which sends SIGTERM — the in-flight round finishes, harvest included, and `run-ended`
  is written. The kill switch remains the in-band emergency freeze; note a kill-switch
  stop exits `1`, which a `Restart=on-failure` supervisor will restart into another
  immediate kill-switch exit until you stop the unit or lift the switch.

Worked example — systemd (`/etc/systemd/system/sapwood.service`):

```ini
[Unit]
Description=sapwood engine
After=network-online.target
# The supervisor's OWN circuit-breaker (security.md prerequisite): stop restarting
# after 5 failures inside 10 minutes; `systemctl reset-failed sapwood` re-arms it.
StartLimitIntervalSec=600
StartLimitBurst=5

[Service]
# The repo the engine drives; config, data/ and logs resolve from here.
WorkingDirectory=/srv/my-repo
ExecStart=/usr/bin/env sapwood run
# Restart the watchdog's nonzero stall exit; a clean signal stop stays stopped.
Restart=on-failure
RestartSec=30
# Graceful stop: SIGTERM lets the in-flight round finish (harvest included) and
# write its run-ended terminal. The stop timeout must comfortably outlive
# worker.timeoutSec (default 3600s) so a draining worker is never SIGKILLed
# mid-handoff.
KillSignal=SIGTERM
TimeoutStopSec=3900

[Install]
WantedBy=multi-user.target
```

On macOS, launchd's equivalents are `KeepAlive` with
`<key>SuccessfulExit</key><false/>` (restart only on nonzero exit) and
`ExitTimeOut` for the graceful-stop window; launchd has no built-in start-limit
burst, which makes the engine's own two backstops — and checking
`sapwood status` after any unattended stretch — matter more there.

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
means the verification-plan-reviewer peripheral judged the acceptance criteria and verification plan
actually executable, not just present. See
[`security.md`](security.md#the-planapproved-label-and-gate-88) for the full gate. The default rounds driver
runs the verification-plan-reviewer peripheral each round and applies it automatically when it approves
a plan; `sapwood init` provisions the label like `sapwood:verify:n/a` and
`sapwood:origin:agent` above.

Acceptance criteria must be written as literal checkbox lines — `- [ ] ...` — under the
`## Acceptance criteria` heading, never as prose (#283). The engine parses exactly this
shape into the authoritative AC set a worker is dispatched against; a malformed or empty
checkbox set blocks dispatch even with `plan:approved` applied. The engine also snapshots
the full issue body BEFORE a worker ever spawns, and re-checks it for drift at review
time — see
[`security.md`](security.md#the-ac-authority-dispatch-snapshot-283-design-279-5) for the
full mechanism.

Any issue a human didn't personally author — including one an agent role opens on your
behalf — should carry the configured `labels.originAgent` label (`sapwood:origin:agent` by
default); see
[`security.md`](security.md#the-originagent-label-convention) for why.

### The `Origin:` line on agent-filed issues (#442)

An issue the PO's align pass files ends its body with a one-line `Origin:` statement naming
the **evidence that triggered it** — the event id(s), lane, episode, or parent issue it came
from, or the literal `static scan` when the only evidence was the role reading this
repository. That distinction is the point: a finding backed by something that actually
happened in a run and a finding derived from reading code look identical on an issue page
otherwise, and they deserve different amounts of trust when you triage them.

Two different provenance facts, two different authors, deliberately kept apart:

| | Who states it | Carrier | Read by the engine? |
|---|---|---|---|
| **Process** provenance — which round/pass filed it | the engine | the `Created by sapwood's round N PO alignment pass` comment, its `<!-- sapwood:round:N:aligning -->` / `<!-- sapwood:engine -->` markers, and the `<!-- sapwood:proposal:… -->` body trailer | yes — these are the machine anchors (reconcile, dedupe, the adjudication scan) |
| **Evidence** provenance — what triggered the finding | the role's own session | the `Origin:` line | **no** |

The engine checks only that the `Origin:` line **exists** — a proposed body without one is
invalid session output, retried once and then degraded, the same as a malformed output block.
It never parses, matches, or routes on what the line *says*. That is on purpose: a role's
self-report about its own reasoning is prose, and prose is exactly what must not become a
dedupe or routing key (the failure class F15 taught this project). Read it as testimony to
weigh, not as a field. An engine-wide test pins the single presence-check call site, so the
day something tries to consume the line, it fails loudly rather than quietly.

The line is shipped default prompt text, so it is overridable like any other role prompt —
point `roles.po.promptFile` at your own copy to change it.

## Next steps

- [`configuration.md`](configuration.md) — every config key.
- [`security.md`](security.md) — the trust and governance model.
- [`troubleshooting.md`](troubleshooting.md) — common failures and what they mean.
