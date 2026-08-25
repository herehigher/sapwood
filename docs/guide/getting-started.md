# Getting started

sapwood is a [Claude Code](https://claude.com/claude-code) plugin: it turns a GitHub
issue backlog into reviewed pull requests. This page takes you from a clean repo to a
first autonomous run.

## Requirements

- **Node.js ≥ 24** (the engine uses the built-in `node:sqlite`, no native build step).
- **Claude Code CLI ≥ 2.1.209** — the engine's declared minimum (`MIN_CLAUDE_CLI_VERSION`,
  `engine/src/roles/worker.ts`; see [Configuration: `worker`](configuration.md#worker) for why
  this exact version). Authenticate it and make sure it can run the configured models with `claude -p` in a
  non-interactive shell. Workers and the default `engine-agent` reviewer are headless Claude
  sessions; this is a real Anthropic usage path and incurs real spend. A CLI below the floor is
  not refused outright — a once-per-start startup check WARNs (never blocks) when the resolved
  binary is older or its version could not be determined; an unnoticed below-floor CLI instead
  fails every worker leg and every environment probe with `error: unknown option ...`, which the
  engine misreads as a provider outage rather than an outdated CLI.
- **GitHub CLI (`gh`)**, authenticated with the `project` scope:
  ```
  gh auth login
  gh auth refresh -s project   # if you're already logged in but missing the scope
  ```
- A GitHub repo with a ProjectV2 board you're willing to let sapwood drive.

## Install

### Channel B — Claude Code marketplace

```
/plugin marketplace add herehigher/sapwood-plugin
/plugin install sapwood@sapwood
```

After the owner's first catalog promotion, the plugin supplies `/sapwood-run`,
`/sapwood-status`, `/sapwood-stop`, and `/sapwood-dashboard`. They use the released package
without a build step. The first command invocation may download the package through `npx` and
therefore needs network access; later calls reuse npm's local cache. `init` and `validate` use
Channel C (or Channel A), not a slash command.

On Windows, these slash commands need the POSIX `sh` that Claude Code supplies (Git Bash or
WSL); see the operator [install-scope observations](supervision.md#install-scope-observations).
`/sapwood-dashboard` starts `sapwood dashboard`; if it cannot open a browser, it prints the
loopback URL and keeps serving until you stop it with Ctrl+C.

### Plugin-only slash commands (Channel B)

These thin wrappers are available only in a Claude Code session that has loaded the sapwood
plugin (Channel B, above) — they are **not** loaded by Channel A's contributor checkout or
Channel C's npm install. Channel A and C users get the same functionality from the linked or
installed `sapwood` CLI (`run`/`status`/`dashboard`) and, for stop/pause control, the
file-sentinel commands (raw or the `sapwood pause`/`stop`/`estop` CLI verbs) above.

- **`/sapwood-run [--once|--until-idle|--dry-run]`** — runs `sapwood run` with the given
  mode and reports its output. No flags = daemon mode.
- **`/sapwood-status [db-path]`** — runs `sapwood status`, reading the state DB directly
  (`.sapwood/sapwood.sqlite` by default). Works even with no engine session currently
  running.
- **`/sapwood-dashboard [--port PORT] [--config PATH]`** — runs `sapwood dashboard`, opening
  it in your default browser or printing the loopback URL in a headless environment.
- **`/sapwood-stop [--emergency|--clear-emergency|--pause|--resume|--lift]`** — sapwood's
  three tiers of human control:
  - **`--emergency`**: the strictest tier — hard-kills running/fixing lane process groups
    without a drain window. In-flight WIP is lost; clear it with `--clear-emergency` only after
    human review.
  - No argument: trips the **kill switch** — freezes all new dispatch and merges;
    running workers are asked to hand off gracefully, then the conductor escalates to a
    hard kill past the drain window. `--lift` reverses it.
  - **`--pause`**: the gentle tier — freezes new dispatch *only*. Everything already in
    flight (running workers, PRs moving through the review/merge gate) keeps going
    normally. `--resume` lifts it.

  See [`security.md`](../security.md#human-controls-three-tiers) for the full semantics, including
  how pause interacts with `--until-idle`.

### Channel C — npm

The engine publishes to npm as the bare package `sapwood` (the `@sapwood` scope is reserved
for future split packages — see [`10-releasing.md`](../dev-guide/10-releasing.md)). This is the
consumer path: no clone, build, or link step.

```
npx sapwood@<version> init
npx sapwood@<version> validate
npx sapwood@<version> run --dry-run
npx sapwood@<version> dashboard
```

Or install it once and use the bare `sapwood` command from then on:

```
npm i -g sapwood@alpha
sapwood --version
sapwood dashboard
```

`alpha` is the pre-release dist-tag (a pre-release version never becomes `latest` — see
[`10-releasing.md`](../dev-guide/10-releasing.md)); use the shipped version or `latest` after a
plain release.

### Channel A — contributor checkout

Only contributors building sapwood itself need this channel. From an existing checkout:

```
npm ci
npm run build
```

This creates `engine/dist/` in the checkout. To put `sapwood` on your PATH for the commands
below, run:

```
npm link --workspace engine
```

Alternatively, skip linking and replace every `sapwood <cmd>` below with
`node engine/dist/cli.js <cmd>`. `npm run build` already builds every workspace, dashboard
included, so there is no separate end-user dashboard build step on any channel.

## Bootstrap the target repo, then run `sapwood init`

Run sapwood from the repository root. In a Git repository, sapwood refuses commands that use
engine state from a subdirectory or linked worktree; run them from the canonical main worktree
root instead. Non-Git directories retain their exact-cwd behaviour.

`init` loads an existing config before it can provision anything. From the repo you want
sapwood to operate on, create its ProjectV2 board first and note the number:

```
gh project create --owner YOU --title NAME
gh project list --owner YOU
```

Replace `YOU` with the GitHub user or organization that owns the board. The project number
is also in the board URL. Then create the minimal valid config below, replacing all-caps
values with your target repository and the board number you just created:

```sh
cat > sapwood.config.yaml <<'YAML'
board:
  owner: YOU
  repo: REPOSITORY
  projectNumber: PROJECT_NUMBER
YAML
```

Verify that config and then initialize from the target repo:

```
sapwood validate
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
   workflow-label values are used verbatim. Existing repositories still carrying the older
   bare (unprefixed) label taxonomy must complete the
   [label migration before restarting sapwood](configuration.md#upgrading-from-unprefixed-labels).
   The **engine repeats this same provisioning pass at every `sapwood run` startup**, from the
   same list — so a repo initialized before a newer workflow label existed (say
   `sapwood:round:pool`) simply gets that label created on the next start, with no manual
   label-creation step. It is best-effort: if the token cannot create labels, the engine logs
   the failure and starts anyway.
4. **Ensures any configured milestones exist** (`config.milestones`; empty by default —
   sapwood only needs labels + board lanes, milestones are your organizational choice).
5. **Ensures the ProjectV2 board's `Status` field has the configured lanes**
   (`Ready` / `In Progress` / `Done` by default).
6. **Provisions the L1 worker deploy key — the default onboarding path
   for the worker's write capability.** `init` generates a per-repo ed25519 SSH key
   (`ssh-keygen`), registers it as a **write** deploy key (`gh repo deploy-key add --allow-write
   --title sapwood-worker`) under your own logged-in `gh` credential (requires repo admin), runs a
   preflight SSH auth check, and — once green — writes BOTH `worker.deployKeyPath` and
   `worker.deployKeyId` into your config: the local `(path, id)` pair is the anchor every later
   `sapwood init` run RECONCILES against — never the bare key title, which may validly belong to
   a different machine (the config schema rejects a config carrying only one half of the pair).
   `init` writes the key under the self-ignoring `.sapwood/` runtime root, so it never needs to
   touch your repo's own `.gitignore` to keep the private key out of an ordinary `git add -A`; a
   deliberate `git add -f` can still stage it.
   From then on, every worker leg — dispatch, resume, AND fix — pushes over git transport ONLY,
   through this key, with **no forge API credential in its environment at all**: it structurally
   cannot open a PR, approve a review, label an issue, or touch the board — the engine does all of
   that from its own, separately-held credential (see
   [Worker credential tiers](../security/credential-tiers.md#worker-credential-tiers) for the full L0/L1
   picture and honest residuals). If you don't have repo admin, `init` logs exactly what to do by
   hand (or skip — the engine runs fully functional either way, at L0, today's fuller-credentialed
   default) and moves on; it never fails `init` over this. On a LATER run, if the recorded key
   ever stops reconciling (wiped local state, a second machine, a rotated/foreign key sharing the
   title, a hand-edited id pointing at an unrelated key), `init` never deletes or touches any
   existing remote key — from an interactive terminal
   it offers to register an additional key just for this machine (titled
   `sapwood-worker-<hostname>`); non-interactively it degrades to L0 and names the manual steps.
7. **Scaffolds starter goal and review-doctrine files** at their configured paths
   (`goal.file`, `doctrine.file`) if missing — never overwrites an existing file.
8. **Scaffolds `.github/ISSUE_TEMPLATE/`** (feature / fix / docs / chore, matching the
   structure the gate⓪ verification-plan-drafter normalizes toward) — each template is written only
   if that file is missing, so repos with their own templates are untouched.

If `init` fails partway through (e.g. a `gh` scope problem), fix the reported issue and
re-run — every step is detect-before-create, so nothing is duplicated.

## Configure

Review and expand the `sapwood.config.yaml` you created for bootstrap. Only
`board.owner`, `board.repo`, and `board.projectNumber` are required; every other key has a
sensible default. See [`configuration.md`](configuration.md) for the full reference.

## Prepare the board and gates before your first run

### Confirm the ProjectV2 board

In the board UI, ensure its `Status` single-select field contains a `Ready` option (the
default sapwood lanes are `Todo`, `Ready`, `In Progress`, and `Done`). `init` ensures the
configured lanes exist.

### Before your first run: make gate① real

> [!IMPORTANT]
> Hand-author and merge at least one CI workflow before your first sapwood run. It must run on
> pull requests and report a successful check with a stable name. Workflows under
> `.github/workflows/**` are human-merge-only: sapwood workers must not be able to weaken or
> create the merge evidence that gate① trusts. An empty repository therefore needs this human
> bootstrap PR before sapwood can produce a mergeable result.
>
> Then configure the check that your workflow actually reports, for example:
>
> ```yaml
> ci:
>   requiredChecks:
>     - name: test
>       app: github-actions
> ```
>
> `reviewer.mode` defaults to `engine-agent`, which is a second paid, headless Claude session.
> With the shipped empty `ci.requiredChecks` list, `sapwood run` refuses to start rather than
> queueing every PR fail-closed forever — `sapwood validate` reports the same refusal.
> Configure the check above before your first run. Do not start an unattended run until the
> pull-request check above is visible and green on a human-authored test PR.

For the operational distinction between a healthy wait, standby, a frozen ceiling, and a
genuine wedge, use the [engine-state reference table](troubleshooting.md#reading-engine-state-at-a-glance).

## Trust model prerequisites

sapwood's plugin-enforced controls are necessary, but a fresh install does not configure
the GitHub-side and identity boundaries that make unattended merge fully load-bearing.
Complete this setup before choosing L3.

**Provided out of the box:**

- The default `guard.mode: hard` blocks the producer's covered GitHub governance commands,
  and the conductor is the only sapwood process that calls the merge API.
- The conductor requires its configured CI and fresh-review gates before it merges; an
  unspecified CI requirement fails closed rather than becoming merge evidence.

**Required deployment setup:**

- Protect the repository's default branch in GitHub. Prohibit direct and force pushes,
  require pull requests with the review and status checks you rely on, and do not give the
  worker identity or deploy key a bypass. This is the mandatory platform backstop for the
  producer's inherited host tool surface; sapwood can warn when protection is absent, but
  does not enforce it.
- Use a merger GitHub identity and credential distinct from the worker identity. Give the
  worker the L1 deploy-key path (`worker.deployKeyPath` and `worker.deployKeyId`) rather than
  a forge API credential, and keep the conductor's merger credential outside the worker's
  normal credential lookup paths. Actual unreadability requires the L2 [enterprise posture
  checklist](../security/credential-tiers.md#l2-enterprise-posture-checklist). Both controls
  matter: branch protection prevents a producer from bypassing review with a direct push, while
  a distinct merger identity prevents it from acting as the conductor. Without both, producer ≠
  merger is not a fully load-bearing deployment guarantee.

Credential isolation has deliberate limits: the L1 environment removes the normal forge
credential path, but it is not OS-level confinement from arbitrary code or the host's
credential store. Read Security's [Accepted blind spots](../security.md#accepted-blind-spots),
[Worker credential tiers](../security/credential-tiers.md#worker-credential-tiers), and
[Worker-leg user-settings persistence vector — detect & disclose](../security/role-sessions.md#worker-leg-user-settings-persistence-vector--detect--disclose)
before relying on unattended merge.

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

  **The tick driver runs no peripherals.** Before starting this L1 recipe, hand-apply
  `sapwood:plan:approved` to a normal issue after checking its plan, or hand-apply
  `sapwood:verify:n/a` to an inherently unverifiable docs/chore issue; otherwise a `Ready`
  issue is not dispatchable. With the shipped label names, the corresponding GitHub CLI commands
  are `gh issue edit ISSUE --add-label "sapwood:plan:approved"` and
  `gh issue edit ISSUE --add-label "sapwood:verify:n/a"`.
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

At every level, `sapwood status` tells you what's happening without needing a live
session. Channel A's controls are file sentinels in the target repo (the repo containing
`.sapwood/`), reached through the first-class `sapwood` CLI verbs — all three act on the
exact same three files:

```sh
sapwood estop --confirm   # strictest: no-drain hard kill; --confirm is REQUIRED
sapwood estop clear       # clear only after human review
sapwood stop              # drain-first: freeze new dispatch and merges; drain workers
sapwood stop clear        # lift the kill switch on the next tick
sapwood pause             # gentle: stop new dispatch; in-flight work continues
sapwood pause clear       # remove PAUSE; dispatch resumes next tick only if no EMERGENCY_STOP or KILL_SWITCH remains
```

Each verb is equivalent to a raw file operation on the runtime root, reachable directly if the
CLI is unavailable:

```sh
sapwood estop --confirm   # equivalent to: mkdir -p .sapwood && touch .sapwood/EMERGENCY_STOP
sapwood estop clear       # equivalent to: rm -f .sapwood/EMERGENCY_STOP
sapwood stop              # equivalent to: mkdir -p .sapwood && touch .sapwood/KILL_SWITCH
sapwood stop clear        # equivalent to: rm -f .sapwood/KILL_SWITCH
sapwood pause             # equivalent to: mkdir -p .sapwood && touch .sapwood/PAUSE
sapwood pause clear       # equivalent to: rm -f .sapwood/PAUSE
```

The CLI form additionally prints the tier's live semantics on activation (and, for
`stop`, the configured drain window) and is idempotent — re-running an already-active
verb, or clearing an already-inactive one, is a normal exit-0 no-op. `sapwood <tier>
--help` documents each tier's exact semantics.

See [`security.md`](../security.md#human-controls-three-tiers) for the full semantics, including
how pause interacts with `--until-idle`.

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
  itself meaningful (see [troubleshooting.md](troubleshooting.md#how-a-dead-engine-says-why-it-died)).
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
  see [troubleshooting.md](troubleshooting.md#consecutive-stalls-park) for the
  operator-clear step. These are backstops, not a substitute: configure the
  supervisor's **own** circuit-breaker too — a *prerequisite* for unattended supervised
  runs ([security.md](../security.md)'s supervisor prerequisite).
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
# The repo the engine drives; config, .sapwood/ and logs resolve from here.
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

A plan being present isn't enough on its own either: the configured
`labels.planApproved` label (`sapwood:plan:approved` by default) is also required before
`getReadyIssues` will dispatch an issue without `labels.verifyNa` — it
means the gate⓪ verification-plan-reviewer peripheral judged the acceptance criteria and verification plan
actually executable, not just present. See
[`security.md`](../security.md#the-planapproved-label-and-gate) for the full gate. The default rounds driver
runs the verification-plan-reviewer peripheral each round and applies it automatically when it approves
a plan; `sapwood init` provisions the label like `sapwood:verify:n/a` and
`sapwood:origin:agent` above.

Acceptance criteria must be written as literal checkbox lines — `- [ ] ...` — under the
`## Acceptance criteria` heading, never as prose. The engine parses exactly this
shape into the authoritative AC set a worker is dispatched against; a malformed or empty
checkbox set blocks dispatch even with `plan:approved` applied. The engine also snapshots
the full issue body BEFORE a worker ever spawns, and re-checks it for drift at review
time — see
[`security.md`](../security/adjudication.md#the-ac-authority-dispatch-snapshot) for the
full mechanism.

Any issue a human didn't personally author — including one an agent role opens on your
behalf — should carry the configured `labels.originAgent` label (`sapwood:origin:agent` by
default); see
[`security.md`](../security.md#the-originagent-label-convention) for why.

### The goal file is the project's spec

sapwood treats the north-star goal file (`goal.file` in `sapwood.config.yaml`, default
`docs/GOAL.md`) as the project's spec, not a second copy of one that lives somewhere else. Its
five sections — Goal, Non-goals, Constraints, Architecture, Current milestone (see
`engine/prompts/goal-template.md` for the scaffold every new project fills in) — are what an
issue is checked against, not decoration: the architect peripheral flags an issue that
contradicts the Architecture section, the PO's own dissent channel raises the same kind of
concern about a Ready issue, and the aligning pass derives new issues directly from the gap
between Current milestone and what the codebase already does. Nothing downstream points back at
a spec section as its own proof of done, though — a decomposed parent's acceptance plan names an
executable CI check on `main`, never "matches the Architecture section" or similar: the goal file
is what work is checked against, never what a passing check cites as its evidence.

### The `Origin:` line on agent-filed issues

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

### What the `Ready` gate does *not* check: duplicates

**Nothing in the loop checks whether an issue you move to `Ready` duplicates another open
issue.** That is a decision, not an oversight. Move two issues describing the same work to
`Ready` and the loop dispatches two workers into two worktrees and produces two PRs that
will conflict on merge. Keeping the backlog free of duplicates is the human's job, at the
moment of moving an issue to `Ready`.

Duplicate detection does exist in the loop, in exactly one place, and it covers a different
case: the PO's align pass searches open and recently-closed issues before filing a proposal
**of its own**, so the loop does not duplicate itself. That search is never run against an
issue a human authored. The roles nearest the gate are out by charter, not by omission:

- **gate⓪ (`verification-plan-reviewer`)** judges whether a plan is executable, explicitly
  *not* whether the underlying work is a good idea — a human already decided that by moving
  the issue to `Ready`. Duplicate-checking a human's `Ready` is second-guessing *why/what*,
  the one decision this project reserves for the human.
- **`architect`** looks for contradiction across a round's candidate pool. An open duplicate
  *outside* that pool is, by construction, not what it is reading.

Why no machinery: sapwood is trusted-repos-first — a small team that mostly knows its own
backlog — and the cheap version has an expensive failure mode. A title/keyword search that
labels near-matches at the `Ready` gate fires on unrelated issues sharing vocabulary, and a
duplicate warning you learn to ignore costs more than the duplicate it was meant to catch.
If your backlog outgrows this, the fix belongs where the decision already lives: search
before you hit `Ready`, not a label after.

## Running the dashboard

sapwood ships a web dashboard over the same state DB `sapwood status` reads. Its data
views are always read-only; a single write route also lets it issue pause/stop/estop
control actions, which is enabled by default. Every channel ships the dashboard already
built — launch it directly:

```
sapwood dashboard
```

`sapwood dashboard [--port PORT] [--config PATH]` starts the dashboard's data server
(`dashboard/server.ts`) and opens it in your default browser (or prints the URL in a
headless environment). It runs on `4517` by default — override with `--port` or
`SAPWOOD_DASHBOARD_PORT`. `--config PATH` loads config from that path instead of
probing the defaults, matching `status --config`/`events --config`. Set `BROWSER=none`
to suppress the auto-open (headless/CI/scripts).

The control actions (pause, stop, estop) exposed in the dashboard UI go through that
one write route, `POST /api/control`, gated by the `dashboard.controls` config key —
`true` by default; set it to `false` for a pure-spectator deployment where the
dashboard can only ever read. See [`security.md`](../security.md) for the dashboard's
full trust posture.

## Next steps

- [`configuration.md`](configuration.md) — every config key.
- [`security.md`](../security.md) — the trust and governance model.
- [`troubleshooting.md`](troubleshooting.md) — common failures and what they mean.
