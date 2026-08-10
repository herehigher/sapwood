# Configuration reference

sapwood is configured by `sapwood.config.yaml` in the repo it operates on. The file is
YAML (with inline comments), but the loader also accepts JSON (`sapwood.config.json`) —
YAML is a superset of JSON, so no separate parser is needed. Config is validated with a
strict [Zod](https://zod.dev) schema (`engine/src/config/config.ts`): **unknown keys are a
validation error**, not a silently-dropped typo, and every numeric ceiling rejects
non-finite values (so `1e999` can't silently disable a budget cap).

`sapwood init` writes a starter file with every key commented; `sapwood validate`
loads and validates a config with zero side effects — run it after any edit:

```
sapwood validate [path]
```

The loader probes, in order: `sapwood.config.yaml`, `sapwood.config.yml`,
`sapwood.config.json`. An explicit path from `sapwood run --config <path>` (including
`--dry-run`), `sapwood status --config <path>`, `sapwood events --config <path>`, or
`sapwood validate [path]` bypasses the probe. `--config` on `status`/`events` is
authoritative once given (#710): a missing/unreadable/invalid file there is a hard error,
never a silent fallback to the probe — the opposite of the no-flag case, which stays
best-effort (a missing config there degrades to "unknown" fields, not a failure). Relative
`logging.path`, `promptFile`, `goal.file`, `doctrine.file`, and `worker.deployKeyPath` keys
resolve from the selected config's directory, so an alternate config's default log lands
beside it; the DB (`data/sapwood.sqlite`), `KILL_SWITCH`/`PAUSE`, sessions, and worktree
roots stay cwd-relative.
Only `board.owner`, `board.repo`, and `board.projectNumber` are
required; every other key has a default.

## Data directory is stateful

Treat `data/` as durable runtime state: back it up, and never delete it while sapwood is
running. SQLite worker rows are the recovery truth; the GitHub board is only a management
view and sapwood deliberately never rebuilds local state from it. `KILL_SWITCH`, `PAUSE`, and
`ESCALATION` also live in this directory and disappear with it. So does `sapwood.lock`, the
single-instance lock (#382): one data dir = one board = at most one running engine — a second
`sapwood run` against the same data dir refuses to start, and a stale lock from a crashed
engine is taken over automatically once its pid is dead (see
[troubleshooting](troubleshooting.md#single-instance-lock-382)). Losing the database resets the
daily `spend_ledger`, so the same UTC day's budget may be spent again; this is a known accepted
residual risk. On the next start sapwood reports detectable board/PR orphans, but does not
requeue, relabel, drive, or otherwise reconstruct them.

## `board`

Identifies the repo and ProjectV2 board the loop drives.

| Key | Default | Meaning |
|---|---|---|
| `owner` | *(required)* | GitHub user or org that owns the repo + board. |
| `repo` | *(required)* | Repository name — every `gh` call targets `owner/repo`. |
| `ownerKind` | auto-detected | `user` \| `org`. Detected at `init` if omitted. |
| `projectNumber` | *(required)* | The ProjectV2 board number. |
| `statusField` | `Status` | The board's single-select field used as the work queue. |
| `status.backlog` | `Todo` | Human-managed intake lane. Whoever adds an item places it here; at startup the engine moves any No-Status issue items here without making them dispatchable. Engine-mediated issue creation must set this Status as its own board-add write. |
| `status.ready` | `Ready` | Lane name for dispatchable issues. |
| `status.inProgress` | `In Progress` | Lane name for claimed issues. |
| `status.done` | `Done` | Lane name for finished issues. |

## `engine`

| Key | Default | Meaning |
|---|---|---|
| `tickIntervalSec` | `60` | How often the engine calls `tick()` — the inter-tick sleep and the liveness watchdog window. (#431 removed the wall-clock session-gap scaling this used to feed.) |
| `rapidRestart.maxBirths` | `5` | #431: the crash-loop detector — at startup the engine counts its own recent process births (`run-started` events, one per boot; wait-loop iterations can never inflate it) inside `rapidRestart.windowSec`. Reaching `maxBirths` (the current start counts) parks autonomous dispatch with an escalation — the existing park paradigm, visible in `sapwood status` and `data/ESCALATION` — until a later start observes the window drained (see [troubleshooting.md](troubleshooting.md)). Normal restarts never trip it. Births are counted in a closed window ending at the detector's own clock, so future-dated `run-started` rows (a DB restored from a fast-clock machine, or a backward host-clock step) never count — they can neither false-trip the detector nor defeat a manual park clear. |
| `rapidRestart.windowSec` | `600` | The birth-counting window for `rapidRestart.maxBirths`. |
| `driver` | `rounds` | Which engine `sapwood run` drives (#106). `rounds` — the round orchestrator: peripheral roles (aligning/architecting/plan_review/harvesting/retro) wrapped around the same tick engine, one round at a time (see [`PLAN.md`'s round-orchestrator section](../docs/PLAN.md#v02-north-star-the-round-orchestrator)). `tick` — the bare M4 loop driver, no peripherals; `--once`/`--until-idle` only apply in this mode (under `rounds` they are a startup **error** — exit 1 before any dispatch — never silently ignored). Every safety behavior (KILL_SWITCH, cost ceilings, drain-before-kill, graceful stop still running harvest) holds under both. |

## `liveness`

#395: a host sleeping mid-round with a forge/spawn call in flight has to wake into a working
engine, not a silently wedged one — a dogfood run once sat ~30 minutes after wake with zero
events because an in-flight `gh` call / role-session spawn confirmation had no bound at all.
Every key here closes exactly that class of hang.

| Key | Default | Meaning |
|---|---|---|
| `forgeCallTimeoutMs` | `60000` | Hard per-call ceiling on a single `gh`/`git` CLI invocation (`gh.ts` — the one place the engine shells out to `gh`, every `GithubForge` call routes through it; `review/materializer.ts`'s private-clone fetch/clone/checkout reuse this same knob). Most callers fail toward retry: every `GithubForge` call either lives inside `tick()` (contained by the tick-error path) or has its own local try/catch (`probeForgeReachable`, `checkFinalMilestone`, `escalatePark`'s forge-comment fallback, ...), and `classifyEnvFailure`/park is driven exclusively by worker-leg output *text*, never by `GithubForge`'s own exceptions — so a `gh` timeout cannot directly trigger a park episode. It **can** still reach a fatal exit indirectly: peripheral stubs (e.g. `align.ts`'s round-pool label writes) call the forge directly with deliberate crash-rerun semantics, so a burst of timeouts there can propagate, uncaught, all the way to `cli.ts`'s top-level `process.exit(1)` — the same pre-existing fail-fast stance any other burst of forge failures on that path already has, not a gap this default introduces. 60s (not `proxy.timeoutMs`'s 30s) gives headroom for `gh api --paginate` reads over potentially large pages (`getCommitsSince`, `getPRReviewData`, `getIssueComments`); empirically ample for this repo's own heaviest paginated read (~0.5s). |
| `spawnConfirmTimeoutMs` | `30000` | Hard ceiling on waiting for a freshly spawned child (a role session, or a worker leg — `dispatch()` and `resume()` both) to report Node's own `spawn`/`error` event. Node gives that confirmation no timeout of its own — a callback lost across a host sleep hangs the await forever without this bound. On timeout the (possibly still-alive) child is best-effort killed and the attempt fails toward retry, the same way a genuine spawn error already does. |
| `watchdogTickMultiplier` | `10` | The liveness watchdog (`watchdog.ts`'s `startProgressWatchdog`), armed once per run by **both** `engine.driver` values (`tick` and `rounds`, the production default) as an independent background timer — never raced against, or keyed on the duration of, any single `tick()` call. It fires when `state`'s event log has gone **completely quiet** — no durable event appended at all — for a full `tickIntervalSec × watchdogTickMultiplier` window, regardless of which phase is running or how long that phase legitimately takes. This is deliberately *not* a tick-duration trigger: `reviewer.mode: engine-agent` awaits a full LLM review session inline inside `tick()`, bounded only by `worker.timeoutSec` (default 3600s, up to two attempts) — a healthy 10–20 minute review would trip any duration-based window tight enough to be useful, self-killing the engine mid-review. Making the trigger progress-based instead means every otherwise-quiet stretch needs *something* to emit a heartbeat so it doesn't starve the counter — already wired for an inline review/role session, an ordinary worker leg, and `round.ts`'s standby-backoff and park-recovery waits. Fires a durable `engine-stalled` event and exits the process nonzero so a supervisor can restart it; deliberately not an in-process self-heal/abort (the stuck await's own resources are reclaimed by the process exit itself, never cancelled in place). |
| `maxConsecutiveStalls` | `3` | The consecutive-stall **breaker** (#407) — the watchdog's decision half. The watchdog above diagnoses *one* stall and exits so a supervisor can restart; this threshold decides when restarting stops being the answer: once this many consecutive runs have **each** ended in a self-diagnosed stall (`engine-stalled`) with **no round closed anywhere between them**, the next start stops blind-retrying — it **parks** autonomous dispatch (the same park machinery as an environment failure, visible as `PARKED (consecutive-stalls)` in `sapwood status` plus `data/ESCALATION`) and escalates to a human, evidence preserved in the event log. A *transient* wedge (host sleep, a passing outage) closes rounds between its stalls, which resets the streak — it never accumulates strikes; only a *deterministic* wedge (the same bug re-wedging every restart) trips it. Ordinary restarts after a single stall just append `engine-restart-after-stall` and proceed through normal startup reconcile. The streak resets **only** on a closed round between stalls — never on how a run exited (clean stops, supervisor SIGTERMs, and crashes are all neutral, so no restart pattern can launder the wedge). The established park **never auto-clears** (a dispatch-empty round closing while parked proves loop health, not wedge recovery): fix the wedge, then clear the park explicitly with `sapwood park clear --source consecutive-stalls` (engine stopped; receipt-first, #475) and start the engine again; see [troubleshooting.md](troubleshooting.md#consecutive-stalls-park-407). |

## `logging`

Run-scoped, disposable narrative output for humans and LLMs. It complements rather than
duplicates the structured events ledger and raw lane/role output. Opening the configured file
is a fail-fast startup check before dispatch; a later write failure is reported once and file
logging is disabled while stderr teeing continues. Rotation keeps only the current file and
one `<path>.1` generation.

| Key | Default | Meaning |
|---|---|---|
| `path` | `data/logs/sapwood.log` | Destination for the run narrative. A relative path—including the default—resolves against the config file's own directory, not the CLI's cwd. |
| `teeToStderr` | `true` | Write each timestamped file record to stderr as well. |
| `maxBytes` | `10485760` (10 MiB) | Before an append would cross this positive byte limit, replace `<path>.1` with the current file and start a fresh current file. |

## `dashboard`

Knobs for the v0.2 dashboard ([`frontend-design.md`](frontend-design.md)). Schema only today —
the dashboard reads them; no engine behavior depends on them.

| Key | Default | Meaning |
|---|---|---|
| `controls` | `true` | Does this deployment's dashboard **drive** the loop or only watch it? `true` shows the Operations verbs (start/pause/resume/stop) and serves their `POST /api/control` route. `false` = pure spectator: the buttons are absent and the route is **not registered at all** (404, not a refusal), so a read-only deployment (a shared screen, a demo, a recorded walkthrough) cannot be clicked into touching the loop. A config the server cannot read is treated the same way — fail-closed, no write route. A capability gate for the deployment as a whole, never a per-user permission model — sapwood has no user accounts. |

## `lanes`

Concurrency and dispatch shape.

| Key | Default | Meaning |
|---|---|---|
| `max` | `3` | Max concurrent workers (occupied lanes). |
| `roundDispatchCap` | `2` | Max new dispatches in a single round/tick (conservative by design). |
| `reserveCap` | `1` | **Accepted, not yet wired** — parsed and validated, but no engine code reads it yet. |
| `prFixCap` | `4` | (#245/#246; default raised 2 → 4 by #450) A **cost ceiling**, not a quality ceiling — the hard cap `workers.fix_rounds` is checked against once the `FIXABLE` gate (#246) decides whether a further fix leg is warranted. The **quality stop** is `review/convergence.ts`'s progress classifier (#450, design #402 R3): a lane whose findings stop shrinking — the same finding recurring on code the fix leg just touched (`recurrence`), the count staying flat for two consecutive rounds (`flat`), or a new problem appearing inside the fix leg's own diff (`marginal-complexity`) — escalates to `needs-human` (`review-non-convergent:<signal>`) *before* this cap is ever consulted, citing the doctrine's design-re-entry principle (`docs/REVIEW-DOCTRINE.md`). `prFixCap` is reached only by a lane still measurably converging by that signal; raising it no longer trades quality for rounds, only cost for rounds. `0` still folds straight to `needs-human`, unchanged. `#245` ships the `fixing` lane state + fix-leg-resume machinery this cap gates; `#246` wires the gate decision itself. **A cap above `0` runs the fix loop by default ([#551](https://github.com/herehigher/sapwood/issues/551) flipped `proxy.enabled`'s default to `true`; #385):** the loop is production-attached whenever [`proxy.enabled`](#proxy) is `true`, which it now is unless an operator explicitly opts out. Only an explicit `proxy.enabled: false` degrades every `FIXABLE` gate to a `fix-loop-unwired:<reason>` needs-human escalation — **announced once at startup** in that opt-out case (a `[sapwood:startup]` log line naming the opt-out, plus one durable `fix-loop-unattached` event) instead of only becoming visible on the first PR it escalates. Setting `prFixCap: 0` silences the announcement by making the fold explicit. |
| `frictionMin` | `0` | **Accepted, not yet wired** — no dispatch rate-limit is enforced from it yet. |
| `gatedReentryCap` | `2` | (#147) Bounds the **GATED RECLAIM** phase: a gate②-escalated PR that a human clears of **every** `escalation.humanLabels` entry (default `sapwood:needs-human` *and* `sapwood:blocked` — the same hold set dispatch honors) is reclaimed back to `driving` and re-driven through the existing gate①/gate② + merge path — no new worker, same PR/branch. Each reclaim counts as one attempt; once this many have re-escalated, a further label removal is rejected (re-applies `labels.needsHuman` + a "cap reached" comment) and the lane is never retried again — merge it by hand. `0` disables automatic reentry outright. **Which object to clear (#398):** the one the escalation was written on — "the label lives where the escalation was born", so a PR-caused escalation is cleared on the **PR** and an issue-caused one on the **issue**, never both. The engine records the carrier it used per lane, so a lane escalated before this split still releases on its issue. For a PR-carried lane the same read also honors `escalation.holdLabels` on the PR: a hold there SKIPs reclaim entirely and costs no attempt. |

## `worker`

Per-worker execution.

| Key | Default | Meaning |
|---|---|---|
| `model` | `opus` | Model the headless worker runs as. `reviewer.agent.model` defaults one tier ABOVE it (`fable`, #582 option (a)) so the gate sits at or above the producer — see [Reviewer tier vs. worker tier](#reviewer-tier-vs-worker-tier). |
| `effort` | `high` | `low` \| `medium` \| `high`. |
| `fallbackModel` | `sonnet` | Model passed to Claude's `--fallback-model` when the primary is unavailable. **At the shipped defaults (`model: opus`, `fallbackModel: sonnet`) this is already a real one-tier-down fallback**, not a no-op — an unavailable primary silently downgrades to `sonnet` out of the box. Set to literal `"none"` to omit the flag and fail loud rather than silently downgrade quality; the environment-failure handling path is documented in [#168](https://github.com/herehigher/sapwood/issues/168). |
| `timeoutSec` | `3600` | Wall-clock hard cap per worker (enforced). |
| `budgetUsdSoft` | `10` | **Soft** per-worker USD budget, auto-enforced via a live token-usage estimate (stream-json carries no in-progress real cost). Crossing it triggers a graceful handoff (commit + push WIP, progress note, `.handoff` sentinel, clean exit) — never a mid-work kill. The estimate is a per-model rate-table approximation (see `pricingFile` below), reconciled (logged, not enforced) against the real cost when the worker finishes; `timeoutSec` plus the engine's hard `cost` ceiling below remain the actual backstop. **This default is calibrated for small-to-medium work and does not fit every model/effort profile** — see [Calibrating `budgetUsdSoft`](#calibrating-budgetusdsoft) below before running substantive issues, especially at the shipped `worker.model: opus` default, which is the profile this section's figures were measured on. |
| `maxResumes` | `2` | Maximum fresh worker legs after the initial leg hands off. RESUME runs before DISPATCH, keeps the issue In Progress, and reuses the same session/worktree; each leg gets a fresh `budgetUsdSoft`. `0` disables automatic resume. Once exhausted, the handoff is latched and escalated once to `needs-human`. Total per-issue soft-budget exposure is bounded by `budgetUsdSoft × (1 + maxResumes)`, still under the engine-wide daily cap. |
| `pricingFile` | unset | Override the model rate table the soft-budget estimator prices against. A relative path resolves against **the config file's own directory** (same rule as `promptFile`). Unset uses the engine's shipped `pricing.yaml` — a commented snapshot of per-model USD-per-million-token rates (`input` / `output` / `cacheWrite` / `cacheRead`) plus each model's `contextWindow` (tokens — the dashboard's context-usage gauge denominator). Your file **replaces** the shipped table entirely (no merging), so copy every model you use; you may add your own aliases. Aliases match case-insensitively as substrings of the model id (`opus` matches `claude-opus-4-8`); a model matching nothing is priced at the most expensive tier in the loaded table. A set-but-missing/unreadable/malformed file — including a model entry missing `contextWindow` — is a fail-fast startup error (`sapwood validate` catches it too) — never a silent fallback to the shipped rates. |
| `heartbeatStaleSecs` | `180` | A worker heartbeat older than this is considered dead (stale-heartbeat reclaim). |
| `egressSuspectCommands` | `[curl, wget, nc, ncat, netcat, socat, ssh, scp, sftp, rsync, ftp, telnet]` | Executable names recorded by the monitor-only worker-egress tripwire. Matching is lexical at executable position in completed Bash tool calls; each deduplicated match becomes an `egress-suspect` event and never blocks or changes the lane outcome. An override **replaces** the default array entirely (no merging); set `[]` to disable the tripwire. |
| `promptFile` | unset | Override the worker's prompt template with your own file. A relative path resolves against **the config file's own directory**, not the CLI's cwd — so the same config behaves identically no matter where `sapwood` is invoked from. Unset uses the engine's shipped `prompts/worker.md` (TDD + two-gate method). |
| `fixPromptFile` | unset | (#245) Override the **fix-leg** prompt — the instruction a `fixing`-state resume (same worker row/worktree/branch/session as the original leg, never a new dispatch) receives instead of the ordinary issue-rendered prompt above. Same resolution/fail-fast rules as `promptFile`. Unset uses the engine's shipped `prompts/fix.md` (fetch findings via the PR-facing proxy tools, address them, push to the same branch). |
| `deployKeyPath` | unset | (#606 gate② round 1–2, [#351 final ruling](security.md#worker-credential-tiers-351-606)) Path to the per-repo SSH **write deploy key** `sapwood init` provisions — set TOGETHER with `deployKeyId` below (they are the LOCAL anchor pair the owner ruling reconciles against; a title is never authoritative for "mine"). The config schema REJECTS a config with only one of the pair set (a parse error naming the missing half and pointing at re-running `sapwood init`) — see `deployKeyId`'s own row. Both set + reconciled green activates **L1**: every worker leg — dispatch, resume, AND fix — runs with `GIT_SSH_COMMAND` pinned to this key (composed onto the credential-free base for a fix leg, never replacing its severing) and no forge API credential reachable in its env at all (`Bash(gh *)` drops out of the leg's tool grant too). Same relative-path resolution as `promptFile`. Unset (the default) is **L0** — today's full credentialed env, unchanged. A reconcile failure (missing local file, a rotated/foreign remote id, a public-key content mismatch, an SSH auth failure) never blocks dispatch: **the running engine only ever logs a guidance-carrying WARN and runs that leg at L0 — dispatch/resume/fix never write to config.** Only a SEPARATE, later `sapwood init` invocation clears the stale anchor (and, run interactively, offers to register an additional per-machine key); until that happens, every leg keeps re-hitting the same reconcile failure and the same WARN, which is the correct, safe, stable state. See [Security & trust model](security.md#worker-credential-tiers-351-606) for the full tier table, the reconcile state machine, and residuals. |
| `deployKeyId` | unset | (#606 gate② round 1–2) The GitHub-assigned numeric id of the deploy key at `deployKeyPath` above — written by `sapwood init` alongside it, and always set/cleared TOGETHER with it. This is the other half of the local `(path, id)` anchor `sapwood init`'s reconcile pass keys on (including a public-key CONTENT cross-check against that id's own registered key, not just "is this id registered somewhere" — gate② round 2); the bare key TITLE on the repo is never treated as proof of ownership (a `sapwood-worker`-titled key may validly belong to a different machine). The config schema enforces the pair: a config with only `deployKeyPath` or only `deployKeyId` set fails to load at all (a parse error naming the missing half), rather than silently behaving as "nothing configured" or reconciling against a meaningless half-anchor. |

### Calibrating `budgetUsdSoft`

`budgetUsdSoft` is the one worker knob whose right value depends on **your** model, effort,
and issue size — a per-leg cost, not a safety boundary. The shipped `10` is deliberately
conservative and is *not* the right number for every profile.

**Observed cost, sapwood's own dogfood run (2026-07-24, [#386](https://github.com/herehigher/sapwood/issues/386)):** with the
then-shipped `worker.model: opus` + `effort: high` defaults, one leg of a *substantive
implementation* issue cost roughly **$8–20**. [#582](https://github.com/herehigher/sapwood/issues/582)'s option-(a) ruling left the
`worker.model` default at `opus`, so that measurement still describes the shipped profile.
At `budgetUsdSoft: 10` every substantive first leg crossed the
cap and handed off before opening a PR (3 of 3 observed); at `20` those legs carried through
to a PR in one go. Nothing malfunctioned — the graceful handoff did exactly what it promises,
and `maxResumes` picked the work back up. The cap was simply below the cost of the work.

**The live estimate runs high, not exact — denominate the cap accordingly.**
[#594](https://github.com/herehigher/sapwood/issues/594): three consecutive supervised dogfood runs
(2026-08-01–03, batches 2–4) measured the live estimate that enforces `budgetUsdSoft` against
each leg's reconciled real `total_cost_usd` and found the estimate consistently OVER-predicts,
by **+10% to +77% per leg**, worst on small legs (batch-2 mean +23%). Practical effect:
`budgetUsdSoft` is denominated in *estimated* dollars, so a cap sized to a target *real*
per-leg spend needs headroom for this bias — at the recommended `budgetUsdSoft: 20` (the
raise this section's own guidance below suggests for the shipped `opus`/`high` profile),
[#399](https://github.com/herehigher/sapwood/issues/399) saw the soft handoff fire at roughly
**$15 real** spend, twice. **Translation:** size the nominal cap at roughly **target real
per-leg spend × ~1.3** (the batch-2–4 mean) as a starting point, not a guarantee — the bias is
a hand-maintained-rate-table artifact (see `pricing.yaml`'s header for the known divergence
sources), not a fixed constant. The per-leg reconciliation log line (estimate vs. real
`total_cost_usd`, logged whenever a worker finishes) is your own repo's actual figure and
beats this one.

**A too-low cap is a tax, not a loss.** No work is lost: the leg commits and pushes WIP, and
the next leg resumes the same worktree/branch/session. What it costs is *re-priming* — each
resumed leg re-reads its way back into the task — plus one extra tick of wall-clock per
handoff. So the failure mode of a cap that is too low is a slower, somewhat more expensive
route to the same PR, and the failure mode of one that is too high is a bigger single-leg
blast radius. Neither is a runaway: the hard `cost` ceilings below bound both.

**It does not move alone.** Two products constrain the value:

| Product | Compare against | What breaks if you ignore it |
|---|---|---|
| `budgetUsdSoft × lanes.max` | `cost.roundBudgetUsd` | Round spend throttles new dispatch. At the shipped defaults (`10 × 3`) this lands exactly on `roundBudgetUsd: 30`; raising `budgetUsdSoft` to `20` without raising `roundBudgetUsd` roughly doubles how often a round stops dispatching — you trade handoffs for dispatch stalls. |
| `budgetUsdSoft × (1 + maxResumes)` | `cost.dailyBudgetUsd` | Worst-case spend on a **single** issue before the handoff latches and escalates to `needs-human` (`10 × 3 = $30` shipped, `20 × 3 = $60` at the raised value). |

**Practical guidance:**

- **The shipped `opus` / `high` profile on substantive implementation issues** (the profile
  the $8–20 figure was measured on): set `budgetUsdSoft: 20`, and raise
  `cost.roundBudgetUsd` to at least `budgetUsdSoft × lanes.max` so the round throttle doesn't
  become the new bottleneck.
- **A downgraded `sonnet` worker, lower effort, or small/narrow issues** (docs, chores,
  single-file fixes): `10` is fine, and is why it remains the shipped default.
- **Not sure?** Leave it at `10` and read the reconciliation line the engine logs when each
  worker finishes (estimate vs. real `total_cost_usd`) — that is your own per-leg number, for
  your own repo and rate table, and beats any default shipped here.

There is no automatic per-model floor: the engine will not warn you that `budgetUsdSoft` is
low for the model you configured. Deliberately — the *right* cap is a function of issue size,
which the engine cannot know at startup, so the number stays an operator decision informed by
the reconciliation logs above.

The shipped `egressSuspectCommands` table deliberately omits `git`, `gh`, and package
managers: those are loop-owned or governed worker flows and would make poor default signals.
This key tunes an audit tripwire only; it does not create a denylist or a lane hold. The
security boundary and the tripwire's known blind spots are documented in
[Security & trust model](security.md#worker-network-egress-accepted-blind-spot).

**`worker.promptFile` template variables:** `{{issue.number}}`, `{{issue.title}}`,
`{{issue.body}}`, `{{issue.labels}}`, `{{labels.verifyNa}}`. `{{issue.labels}}` renders
the issue's label list; `{{labels.verifyNa}}` renders the configured `verify:n/a` label
name (`labels.verifyNa` below), so a custom prompt can still tell the worker which label
means "skip the test-driven gate and make the doc change instead."

**`worker.fixPromptFile` template variables (round-2 fix A7 — deliberately NARROWER than
`worker.promptFile`'s):** `{{issue.number}}`, `{{pr.number}}`, `{{labels.verifyNa}}` only —
never `{{issue.title}}`/`{{issue.body}}`/`{{issue.labels}}`. A fix leg's evidence channel is
the PR-facing proxy tools (`pr_review_threads`/`pr_reviews`/`pr_checks`/`pr_details`, plus
`pr_audit_comments` for engine-agent findings), not issue prose, so the render function never
needs a full issue object — just the issue and PR numbers (`{{pr.number}}` is required because
a PR-facing tool call takes a PR number, not an issue number, and `{{issue.number}}` alone
doesn't name it).

**A fix leg can disagree, in both review modes (#247, #461).** It holds no forge credentials;
its one structured report is what the engine executes. `threadResponses` answers classic
review threads (`addressed` → the engine replies and resolves; `disputed` → it replies and
leaves the thread open). `findingResponses` answers **engine-agent** findings, which arrive as
one audit comment rather than threads, keyed on that comment's `runId` plus the finding's
rendered `[N]` index; entries naming a run the leg was never served, or an index the reviewed
run never produced, reject the whole report, the same fail-closed rule thread ids follow. A
`disputed` finding approves nothing and changes no verdict — the lane escalates to
`needs-human` (`review-finding-disputed:<n>`) with the reviewer's finding and the producer's
reasoning quoted side by side, and no further paid fix round, so a wrong finding costs one
round and an adjudication instead of `prFixCap` rounds of silence. If you replace the shipped
prompt, keep both blocks documented in yours: an unreported dispute is indistinguishable from
a leg that simply did nothing.

**Fail-fast rules:** the template is loaded once, eagerly, at engine startup (before any
dispatch) — never lazily on first use. A `promptFile` (or `fixPromptFile`) that's set but
missing, unreadable, or empty is a startup error, and so is a template referencing an
unknown `{{var}}`. There is no silent fallback to the shipped default once the key is set:
either the exact file you named loads and validates, or the engine refuses to start.
`sapwood validate` runs this same check, so a broken prompt file is caught before you ever
run the engine.

## `cost`

Engine-enforced **hard** ceilings — the actual runaway-spend safety boundary, independent
of the soft per-worker budget above.

| Key | Default | Meaning |
|---|---|---|
| `roundBudgetUsd` | `30` | Soft per-round dispatch throttle (not the hard safety boundary — see `dailyBudgetUsd`). It counts every `spend_ledger` row after the round's durable start cursor: opening/closing peripheral sessions and each settled worker leg exactly once. Crossing it stops new dispatch, never kills in-flight work, and never skips harvest or retro. |
| `dailyBudgetUsd` | `100` | **Burn-rate cap**, not a total — "$100/day, renews in Xh." Summed from completed workers' actual cost (each worker's terminal `total_cost_usd`, a priced snapshot that settles on that worker's final bill) by **UTC calendar day**, and persisted across restarts (`spend_ledger`), so it renews at the next UTC midnight regardless of any restart in between. A common misreading (2026-07-13 dashboard/cost discussion, #17/#154) is treating this as a run total or an all-time cap — it is neither; see `stop.afterSpendUsd` below for the actual per-run cap. Breaching it freezes new dispatch/merges engine-wide and drains in-flight workers. |
| `maxWallClockSec` | `86400` (24h) | A **per-process attention alarm** (#431): one clock per process life, anchored at process start (in memory, never persisted), breached when *this* engine process has been alive longer than this. A restart — manual, script, or supervisor — is a sanctioned renewal and starts a fresh clock at any gap length. **Not a security boundary**: the durable cross-restart bounds are `dailyBudgetUsd` + guard/gates/kill-switch; crash-loop abuse is caught by `engine.rapidRestart` plus your supervisor's own circuit-breaker (a *prerequisite* for unattended supervised runs — see [security.md](security.md)). Entering the breach emits one reason-bearing `ceiling-breach-entered` event per episode. One caveat: a 24h process life can straddle UTC midnight and therefore span **two** `dailyBudgetUsd` periods (~2× worst-case single-life spend; this existed at the old 4h default with smaller magnitude). Independent of `worker.timeoutSec`, which bounds one worker; there is still no run-duration cap — see the knob table below. |
| `drainWindowSec` | `300` (5min) | Bounded grace window after a ceiling breach (daily budget / wall-clock / kill switch) during which running workers are asked to hand off gracefully before the conductor escalates to a hard process-tree kill. |

## `stop`

Goal-based **final** stop conditions for `sapwood run` — "when is this run complete."
All optional; none set is today's behavior exactly (the run only stops on a signal,
`--once`, or `--until-idle` idleness). Each has a matching CLI flag
(`--stop-after-issues`, `--stop-after-prs`, `--stop-on-milestone`, `--stop-after-spend`)
that overrides the config value for a single invocation. Conditions are OR'd — the first
one satisfied wins and converts the rest of the run into the same wind-down
`--until-idle` uses: stop dispatching new lanes, let every in-flight lane finish on its
own (never a mid-work kill), then exit, naming the condition that fired.

| Key | Default | Meaning |
|---|---|---|
| `afterIssuesMerged` | unset | Stop once this many issues have been merged during **this run** (counted from this process's own tick results — a restart starts the counter back at 0). |
| `afterPRsOpened` | unset | Stop once this many PRs have been opened during this run (counted the first time a lane's PR becomes known to the engine). |
| `onMilestoneComplete` | unset | Stop once the named milestone has zero open issues left. The name must match the milestone's title **exactly** as GitHub displays it — validated against the repo at startup, before any dispatch; a typo aborts the run with the available titles listed rather than silently never firing. |
| `afterSpendUsd` | unset | (#154) Stop once **this run's own ledgered spend** reaches `$N` — the missing money unit: a per-run authorization ("this run may spend $X"), distinct from `roundBudgetUsd` (per-round/soft), `dailyBudgetUsd` (a cross-restart calendar-day *rate* cap, never a run total), and every other `stop.*` condition above (which bound work, not money). Summed from THIS run's own `spend_ledger` rows only — an id-cursor captured once at engine startup, so a **restart starts this sum back at $0** even mid-day (the daily cap still applies, unchanged, since it is deliberately not run-scoped). Each worker's contribution is its terminal cost — a priced snapshot that settles on that worker's final bill. |

**Floor semantics:** each count is a floor, not an exact stopping point. Conditions are
evaluated at tick boundaries, and the tick that crosses the threshold has already run its
own dispatch phase — so up to `lanes.roundDispatchCap` additional lanes may launch in
that same tick and run to completion (including merge) during the wind-down. With
`--once`, a condition hit on the single tick is named in the exit line but the run does
not wait for a wind-down.

**Startup validation:** a configured (or flagged) `onMilestoneComplete` is checked against
the repo's real milestone titles before the run starts dispatching anything; an unknown
title is a hard startup error, not a condition that silently never fires.

The `--stop-*` CLI flags cannot combine with `--dry-run` (which never runs the loop at
all); config-file `stop.*` keys are simply ignored by a dry run.

**Time & spend units, at a glance (#154):** the engine bounds work at several different
granularities, and each one is bounded by a *different* knob (or, for one deliberate
case, no knob at all) — this table exists because two of these are easy to misread (see
`cost.dailyBudgetUsd`/`maxWallClockSec` above for the long-form clarifications):

| Unit | Bounded by | Notes |
|---|---|---|
| tick | `engine.tickIntervalSec` | The dispatch/reclaim/drive cadence itself — not a duration cap on anything, just how often the loop runs. |
| worker lane | `worker.timeoutSec` (hard) / `worker.budgetUsdSoft` (soft) | Hard wall-clock kill vs. a soft budget that triggers a graceful handoff, never a mid-work kill. |
| peripheral session | `worker.timeoutSec` | Peripheral role sessions (aligning/architecting/plan_review/harvesting/retro) reuse the same wall-clock cap as a worker lane. |
| single `gh` call | `liveness.forgeCallTimeoutMs` (#395) | Every `gh` CLI invocation, independent of everything above — bounds a dead socket / hung upstream, not the session that made the call. |
| spawn confirmation | `liveness.spawnConfirmTimeoutMs` (#395) | Bounds waiting for a role session's or worker leg's own process-spawn event — distinct from `worker.timeoutSec`, which bounds the session once it's confirmed running. |
| round | *(deliberately no duration cap)* | Bounded by *work*, not time: `lanes.roundDispatchCap` (dispatch quota) and `cost.roundBudgetUsd` (soft spend throttle) end a round's dispatch; there is no "a round may run at most N minutes" knob, by design — a round's real-world length follows its work. |
| run | `stop.afterSpendUsd` / `afterIssuesMerged` / `afterPRsOpened` / `onMilestoneComplete` | Goal-based, not time-based — a run ends when one of these conditions fires (or on a signal), never on an elapsed-time budget. |
| wall-clock window | `cost.maxWallClockSec` | A per-process attention alarm — one clock per process life, fresh on every restart; see above. Not a long-run limiter, not a security boundary. |
| calendar day | `cost.dailyBudgetUsd` | A burn-rate cap that renews at UTC midnight and survives restarts — the one cross-restart ceiling in this table. |

**`run --milestone NAME` (#129):** a shortcut for the single most common bounded-run
intent — "work only milestone NAME, stop when it's done" — that would otherwise need two
separate settings: `round.milestone` (dispatch scope, config-only) plus
`--stop-on-milestone` (this run's final stop condition). `--milestone NAME` sets both to
`NAME`, **for this run only** (never written back to the config file), and gets the same
startup validation as `--stop-on-milestone` above. Precedence: the CLI flag always wins
over both `round.milestone` and `stop.onMilestoneComplete` in config; it cannot combine
with an explicit `--stop-on-milestone` (ambiguous which name should win — rejected at
startup, before any dispatch, even when the two names match) or with `--dry-run` (same
rule as every `--stop-*` flag above). The scope half (`round.milestone`) only affects the
round orchestrator's dispatch candidates — under `engine.driver: tick` only the
stop-condition half has any effect, since the tick driver has no round to scope. See
[`round`](#round) below for the scoping mechanism on its own.

## `round`

Round-loop scoping (#86) and standby (#125) — which issues the round orchestrator's
dispatch batch draws from, and whether a new round opens at all when there is provably
nothing to do. Scoping is distinct from (but composable with) `stop.onMilestoneComplete`
above: scope and stop are orthogonal mechanisms that happen to reuse the same
GitHub-milestone concept — one can be set without the other, or to two different
milestones. `run --milestone NAME` (above) is a shortcut that sets both to the same name
in one flag, for callers who want the common case ("just work M, stop when it's done")
without reasoning about the two mechanisms separately.

| Key | Default | Meaning |
|---|---|---|
| `milestone` | unset | Milestone TITLE (exact match, same mechanism `stop.onMilestoneComplete` validates against) that scopes this run's dispatch candidates — `sapwood run` only claims/dispatches `Ready` issues in this milestone; every other issue is left untouched. Also skips a round's dispatch batch once the milestone has zero open issues left (a round-level pause, distinct from `stop.onMilestoneComplete`'s run-ending final condition). Unset (the default) scopes nothing — every `Ready` issue is a candidate, today's behavior. Round-orchestrator only (`engine.driver: rounds`); has no effect under the `tick` escape hatch. **[#561](https://github.com/herehigher/sapwood/issues/561):** `sapwood run --dry-run`'s preview reads Ready through the SAME scoping, so its counts, candidate list, and cost estimate cover only in-scope issues — before that fix the preview could quote spend for an issue the scoped run would never dispatch while hiding the real in-scope pool entirely. (The `--milestone` CLI flag still cannot combine with `--dry-run`, unchanged — this is config-level scoping only.) |
| `standby.enabled` | `true` | Pre-round probe (#125): before opening a NEW round, a check — **any carried lane still needing the tick loop** (#433: an in-flight `running`/`driving`/`fixing` lane, a resumable handoff, or a gated-reentry candidate — three local SQLite reads, checked before any network call; the gated set only counts when a merge gate is configured, since nothing else consumes it)? any Ready issue? any plan-review candidate? any open plan-less issue awaiting PO triage? (when `milestone` is set) any open, non-human-held issue left in it? — decides whether there is provably anything for the round to do. All empty -> the round is withheld (an exponential backoff wait, below) instead of opening and running all five peripheral role sessions for nothing. Standby only engages after a round this run already completed with nothing dispatched — the first round always opens, so the PO gets its plan-doc decomposition pass even on a completely empty repo. A probe API failure fails open — the round opens normally (recorded as a `tick-error` event). Known ceiling: a plan-doc edit made *during* standby is invisible to the pure-API probe — file an issue (any probe signal) or restart the run to wake the PO. `false` restores the pre-#125 behavior: a round always opens immediately. **#212:** the milestone check excludes any issue carrying an `escalation.humanLabels` label — a milestone whose open issues are *all* human-held (`needs-human`/`blocked`) no longer counts as work, so standby engages instead of opening empty round after empty round on a backlog nothing enabled can consume; one non-held open issue in the milestone still counts. |
| `standby.backoffCapSec` | `1800` (30min) | Cap on the standby wait: `engine.tickIntervalSec * 2^n` (n = consecutive empty probes), capped here. Any probe hit (a Ready issue appears, etc.) resets the exponent and opens the round immediately — no extra wait. Standby entries/waits/exits are recorded in the event log (`standby-wait`/`standby-exit`). KILL_SWITCH bypasses standby entirely: a round still opens and blocks at its first peripheral phase, same as `standby.enabled: false`. |
| `idleChurn.consecutiveIdenticalRoundsThreshold` | `5` | #470: the **idle-churn breaker** — a runtime backstop for the failure standby exists to prevent but cannot always see. Standby is the first line: it withholds a round when its probe says there is provably nothing to do. But a probe *signal* that counts work nothing enabled can ever consume pins that probe true forever — the loop then opens round after round, each one perfectly healthy and each one achieving nothing (dogfood F32: six empty rounds in 12 minutes). This threshold bounds that: once this many rounds **in a row** close both **idle** (no dispatch, no lane left in flight) *and* **state-identical** (each appended exactly the same durable facts as the one before it — same event kinds, same payloads), the engine appends an `idle-churn-detected` event **naming the probe signal(s) that kept opening those rounds** and **parks** dispatch for a human (`PARKED (idle-churn)` in `sapwood status`, plus `data/ESCALATION`). The count is folded from the event log itself, so a crash mid-count resumes at the same number. A round that dispatches, merges, escalates, posts, or creates *anything* differs from its predecessor and resets it to zero — so a legitimately long wait never accrues one (a lane awaiting CI holds its round *open* rather than closing empty ones), and a genuinely idle backlog engages standby and closes no rounds at all. Generous by default, because a false trip stops a healthy engine while the pathology it catches runs indefinitely. The park does **not** auto-clear: there is nothing to probe — the loop is fine, the fault is upstream of it — so fix the signal, then delete its `park_state` row (see [troubleshooting.md](troubleshooting.md#idle-churn-park-470)). |
| `directiveFile` | `data/DIRECTIVE.md` | #126: a round directive — human steering (why/what direction; execution stays the agents') dropped at this path before or during a round. At round open the engine reads it, substitutes it into both the aligning (`po.md`) and architecting (`architect.md`) prompts as `{{round.directive}}`, then archives it to `data/directives/round-N.md` so it never silently re-applies to a later round. Consume-once is event-sourced (a durable `directive-applied` event, not the file's presence, is the source of truth), so a crash mid-archive is safe to resume. Absent -> prompts render an explicit "No round directive was provided for this round." placeholder, behavior otherwise unchanged. Relative to the process's cwd (same convention as the engine's own `data/sapwood.sqlite` default), **not** resolved relative to this config file like `roles.*.promptFile`/`goal.file`. |
| `directiveMaxChars` | `20000` | Deterministic truncation cap, in characters, on the directive text substituted into the prompts — same marked-cut-never-silent-drop contract as `roles.harvest.artifactMaxChars` / `roles.retro.digestMaxChars` above. |
| `poolFactor` | `1.5` | #212/#233: the engine computes this round's pool CANDIDATE set from Ready (milestone-scoped when `milestone` above is set) — up to `ceil(lanes.roundDispatchCap × poolFactor)` issues, ordered by `prio:*` label ascending then issue number ascending. With `roles.po.poolSelection: false` (the **default**), that full candidate set IS the pool — a deterministic MAIN path, not a fallback (see `roles.po.poolSelection` below for why: controlled testing found the selection session takes every candidate at every model tier anyway). With `roles.po.poolSelection: true`, the PO's dedicated selection session (`roles.po.poolPromptFile`) instead chooses which of those candidates actually belong in this round's pool — it may take all of them, a subset, or (rarely) none. Either way, the engine WRITES the durable decision (a `pool-selected` event) before any label is written, and the open backlog's labels are then RECONCILED to match it exactly — `labels.roundPool` added where missing, removed from any other open issue that has it (healing stale labels from a prior round or a cross-milestone stray as a side effect). A crash-rerun of the aligning phase replays the durable decision instead of recomputing when that event landed — never a fresh, possibly-different PO session unioning onto whatever labels the crashed attempt already applied. **#232:** that event write is now **load-bearing (fail-closed)**, not best-effort — an append failure SKIPS the label reconcile entirely for that pass (never labels GitHub against a decision with no durable record behind it), and records a `pool-selection-decision-lost` honesty event plus a `tick-error`; the round is never wedged (this phase's marker still advances, same degrade-open stance as `po-degraded`/`triage-degraded`), it just retries fresh next round. The executing phase dispatches pool members only (an approved Ready issue outside the pool is never dispatched that round); the standby probe still counts an un-pooled Ready issue as work. `>1` so the candidate set absorbs gate⓪/review attrition between selection and dispatch. The pool label persists through dispatch WITHIN the same round (a dead-lane requeue stays pooled and re-dispatchable) — round close then clears the pool label from **every** open issue that still carries it, with no exemption for "dispatched this round": an issue whose PR is still open at round close loses the label just like any other undispatched member, and must re-enter the pool via a later round's own selection, never by inheriting a stale label. |

## `goal`

The loop's **north-star goal file** (#128) — the alignment yardstick the aligning (PO) and
architecting peripherals read every round, and the entry retro proposals must cite as their
basis.

| Key | Default | Meaning |
|---|---|---|
| `file` | `docs/PLAN.md` | Path to the project's north-star goal file. Same `#74`-style resolution as `worker.promptFile`: a relative path resolves against **the config file's own directory**, not the CLI's cwd. `sapwood init` scaffolds a starter template here — Goal / Non-goals / Constraints / Current milestone, each a short commented section — **iff the resolved path is missing**; it never overwrites an existing file (a second `init` run, or a crash-rerun, is a byte-for-byte no-op once the file exists). **#231:** for the aligning phase's goal-decomposition pass specifically, a missing/unreadable file is now an **explicit, fail-closed failure** — no `po-align` session is spawned, no issues are created that pass, and a durable `goal-file-unreadable` event + a `tick-error` are recorded. This never wedges the round or blocks anything else: the round-start triage pass (which never reads this file) and every other peripheral proceed unaffected, and the next round's own aligning phase retries the read fresh. (The architecting peripheral's own, independent read of this file for its architecture-chapter excerpt is unchanged — it already degrades to a visible placeholder string, never a blank one, on the same failure.) |

**Deprecated back-compat key:** `roles.architect.planMdPath` (#104) was the pre-#128 home for
this same path — it is still accepted, and the two keys are reconciled at config load into the
single resolved `cfg.goal.file` every consumer reads (align.ts's goal-alignment pass and
architect.ts's architecture-chapter extraction no longer read `roles.architect.planMdPath`
directly):

- Only `goal.file` set (or neither, defaulting to `docs/PLAN.md`) — nothing to reconcile.
- Only `roles.architect.planMdPath` set — it wins (today's pre-#128 behavior, unbroken), and
  config load logs exactly **one** deprecation line pointing at `goal.file`.
- Both set and they **agree** — resolves cleanly, no error, no deprecation noise.
- Both set and they **disagree** — a **hard config error at load**, naming both keys, rather
  than silently preferring one (an operator who set both almost certainly meant to change one
  and forgot the other was still there).

## `doctrine`

The loop's **repo-level review doctrine** (#167) — durable review knowledge (recurring technical
invariants + adjudication doctrine for how findings get treated) carried forward across rounds
instead of living only in a human/conductor's memory. Prose for LLM readers, deliberately never
a lint/DSL. Injected into the worker dispatch brief (`{{doctrine}}`), the architect pass
(`{{round.doctrine}}`), and the gate② review-trigger comment (`different-model-codex` mode,
appended after the issue's verification plan so the reviewing bot's attention is aimed at
historical failure zones on top of this PR's own acceptance criteria) — and cited by name in
the gated-PR-reentry-cap escalation comment when automatic fix attempts are exhausted. When no
doctrine file is adopted, the two **internal** prompt surfaces (worker brief, architect pass)
render an explicit "no review doctrine available" placeholder — never a silent empty
substitution — while the **public** gate② trigger comment (posted on the PR) instead appends
nothing at all, byte-identical to before doctrine existed: the internal placeholder text never
appears in a public PR comment.

| Key | Default | Meaning |
|---|---|---|
| `file` | `docs/REVIEW-DOCTRINE.md` | Path to the project's review-doctrine file. Same `#74`-style resolution as `worker.promptFile`/`goal.file`: a relative path resolves against **the config file's own directory**, not the CLI's cwd. `sapwood init` scaffolds a starter template here (technical invariants + adjudication doctrine, seeded from the loop's own distilled review history) **iff the resolved path is missing**; it never overwrites an existing file. **Unlike** `worker.promptFile`, a missing file is not an error — it's a legal, common state (a repo that hasn't adopted the convention, or has opted out): the prompts render an explicit "no review doctrine available" placeholder, behavior otherwise unchanged. |
| `maxChars` | `20000` | Deterministic truncation cap, in characters, on the doctrine text substituted into the prompts — same marked-cut-never-silent-drop contract as `round.directiveMaxChars` / `roles.architect.lastMergedMaxChars` / `roles.retro.digestMaxChars`. |

## Language customization

sapwood has no language-preference config key of its own — it doesn't need one. Every spawned
session (worker, and every peripheral role) runs as a Claude Code session inside the target
repo's own checkout, and Claude Code loads that repo's `CLAUDE.md` automatically. A language
preference — "always respond in Japanese," "write commit messages in French" — belongs there,
in the target repo's own `CLAUDE.md`, exactly like any other repo-specific working convention.
There's nothing to configure in `sapwood.config.yaml` for this.

**Issue-body headings may use any language.** Put an exact own-line marker immediately after
each semantic section heading:

```md
## 受け入れ条件
<!-- sapwood:ac -->

## 検証計画
<!-- sapwood:verification -->
```

The heading remains the Markdown structural boundary and may be in the issue's own language.
The two lower-case ASCII comments are sapwood machine protocol: do not translate, case-change,
width-normalize, duplicate, or place them in a code fence. Once any `<!-- sapwood:<word> -->`
marker occurs outside a fence, anchored mode is a hard override: sapwood ignores legacy heading
matching and requires exactly one correctly placed `ac` marker and one correctly placed
`verification` marker. A partial, duplicate, unknown, or misplaced marker set is planless and
routes to PO triage; it never mixes anchors with English headings or dispatches silently.
This is #588's parsing boundary: issue headings are language-free when paired with sapwood
anchors, rather than English-regex matched protocol.

For compatibility, bodies with no sapwood markers retain the legacy English heading parser
unchanged. An unmarked non-English body is therefore planless and triaged — it does **not**
silently enter the `verify:n/a` doc-gate path, which requires the explicit configured label.

Issue-facing prose an LLM composes (drafted bodies, triage/proposal text, and LLM-written notes)
should use the issue's own language and preserve original-language content unless asked to
translate it. Engine-authored static receipts and escalation comments remain English, including
on non-English issues; this is a deliberate permanent-until-revisited boundary, not a language
selection mechanism.

**Other machine-parsed surfaces remain protocol identifiers.**

- **Config keys and structured-output sentinels** — YAML keys, the
  `<<<SAPWOOD_RESULT>>>`/`<<<BODY>>>` sentinels (`structured-output.ts`), and role JSON metadata
  keys are fixed protocol identifiers. Only their free-text body content is localized.
- **Labels and board `Status` values** — these are user-configured opaque strings, not an
  English-only protocol. sapwood matches them literally and never translates or infers them.

## `recovery`

| Key | Default | Meaning |
|---|---|---|
| `rollbackRetryCap` | `5` | Max retries for a durably-persisted rollback/requeue (e.g. rolling a failed claim back to `Ready`) before the conductor stops retrying and escalates to `needs-human` instead. |

## `reviewer`

Gate② — who reviews a PR before it can merge.

| Key | Default | Meaning |
|---|---|---|
| `mode` | `engine-agent` (#501; was `different-model-codex` before 2026-08-01) | The reviewer kind: `engine-agent` (an engine-composed, static review session using a different Claude model, run locally on the same Claude CLI sapwood itself needs — no extra install), `different-model-codex` (0day-style fresh non-author Codex review, requires the hosted `@codex review` GitHub App), `same-model-trusted` (allowlisted reviewers only), or `human` (any non-author approval). **Cost note:** the `engine-agent` default makes gate② a paid local Claude session — see `agent.costCapUsd` below for its per-review ceiling. |
| `triggerCommand` | `"@codex review"` | The PR-comment text posted to request a review (`different-model-codex` mode). Non-empty string; rejected empty at parse. |
| `deltaChainMax` | `3` | Maximum consecutive `X..Y` delta-scoped re-reviews. The next head move requests a full-PR review and resets the chain. Positive integer. |
| `trustedReviewers` | `[]` | Allowlisted reviewer logins, used by `same-model-trusted`. |
| `fallback` | `[]` | Ordered, opt-in list of reviewer modes to fail over to when the primary is unavailable past `failoverAfterSec`. Entries may be `different-model-codex`, `same-model-trusted`, or `human`; `engine-agent` is deliberately primary-only and is rejected here. Each entry keeps its own mode semantics (identity allowlist for hosted-bot modes, any-non-author approval for `human`). Empty (the default) is byte-for-byte pre-failover behavior: an unavailable primary queues the PR forever, no silent degradation. `same-model-trusted` in `fallback` with an empty `trustedReviewers` is rejected at parse — it could never produce a verdict, so the failover would be silently inert. |
| `failoverAfterSec` | `1200` (20min) | How long the primary reviewer may stay non-decisive before gate② hands off to the first fallback entry that itself reaches a decisive verdict. Irrelevant when `fallback` is empty. |
| `escalateAfterSec` | `86400` (24h) | How long a current-head review may stay non-decisive before sapwood applies `needs-human` to the PR and emits `review-silence-escalated`. This adds visibility only: the lane stays driving, polling continues, and gate② is never softened. A configured failover receives its full `failoverAfterSec` evaluation window first. |
| `agent.model` | `fable` when `mode: engine-agent` and `agent` is omitted (#501 default injection; `sonnet` before #582, 2026-08-03); required (non-empty) if `agent` is set at all | Claude model for the `engine-agent` review session. Must differ from `worker.model` — enforced identically whether `agent` was default-injected or hand-written (D5 is never silently defeated by the default); runtime checks also require the worker's and review session's recorded actual models to be distinguishable. Its tier should also sit **at or above** `worker.model`'s — see [Reviewer tier vs. worker tier](#reviewer-tier-vs-worker-tier) for why, and for the `sapwood validate` warning that flags an inversion. |
| `agent.runner` | `claude` | Which locally-invoked CLI executes the review session (#443). `claude` runs it on the same Claude CLI sapwood already needs — unset is byte-for-byte the pre-#443 behavior. `codex-exec` runs it as a local `codex exec` process instead, making gate② **cross-vendor**: the reviewer's provider differs from the worker's, which is the strongest form of "different model". **Not the same thing as `reviewer.mode: different-model-codex`** — that asks a *hosted* GitHub App to review through a PR comment and spawns nothing locally; this spawns a local process and posts no trigger comment. Requires the `codex` CLI on `PATH` (or `CODEX_BIN`) and a working codex login. Honest-recording semantics for this runner: `agent.costCapUsd` degrades to **advisory** (the CLI has no hard cap — a warning event is emitted before each attempt), post-run spend is a **flagged estimate** from token telemetry (or recorded as *unknown*, never as `$0`), and the containment gaps the CLI cannot close are recorded as a named blind-spot warning event at every spawn. **Read [docs/security.md's `#443` exception](security.md) before enabling this**: a read-only sandbox restricts writes, not execution, and *not the read scope* — a prompt-injected review session can read host-wide files, operator credentials included, and return them through provider-visible output. sapwood strips the well-known credential families from the session's environment (forge/SSH/cloud/registry tokens plus a `*_TOKEN`/`*_SECRET`/`*_API_KEY`/`*_PASSWORD`/`*_CREDENTIALS` sweep) and redirects the `gh`/git config handles — but that list cannot be exhaustive, the rest of the environment is inherited, reads are not confined, and by owner ruling no outer sandbox ships. The wall-clock session timeout (`worker.timeoutSec`) stays hard, and terminates the session's whole process group. |
| `agent.codexPricing` | unset (shipped list price: `$1.25`/`$10` per M tokens in/out) | `{ inputUsdPerMTok, outputUsdPerMTok }` used to turn the codex-exec runner's token telemetry into the `estimated` USD figure. Dead config with `agent.runner: claude` (rejected at parse — that runner reports real dollars). Cached-input and reasoning tokens are deliberately not priced separately: this is a bounded estimate by design, which is why every figure derived from it is flagged. |
| `agent.effort` | `high` | Review-session effort: `low`, `medium`, or `high`. Threaded to the Claude CLI's effort setting, or to codex's `model_reasoning_effort` under `agent.runner: codex-exec`. |
| `agent.promptFile` | shipped `engine/prompts/engine-reviewer.md` | Optional review prompt template. A relative path resolves against the config file's directory. A custom template must contain all mandatory placeholders: `{{diff}}`, `{{issue-body}}`, `{{acceptance-criteria}}`, and `{{doctrine}}`; missing any fails startup. A configured missing, unreadable, empty, or invalid template fails startup; it never falls back silently. **Before editing it, read its "What the engine enforces vs. what you judge" section** (#454, design #402 §6a): the shipped default states which of its own instructions the engine checks in code — per-AC id-set exactness, the finding key allowlist and closed `severity`/`kind` enums, the advisory-eligible kind allowlist, `rejected` implying a non-empty findings array, two-sided model separation, head/base/diff identity and snapshot drift, no write access for every runner (containment beyond that is runner-specific — see `agent.runner` above and [docs/security.md's `#443` exception](security.md)) — and which are judgment the engine cannot verify. Tightening an enforced rule in prose is a no-op (the check, not the prompt, is the source of truth); loosening a judged one is an unbounded behavior change with nothing to catch it. |
| `agent.costCapUsd` | `3` | Positive finite dollar cap for one logical review. The first attempt receives the cap; a single retry after invalid/unparseable output receives only the recorded remainder. Unknown first-attempt spend disables the retry fail-closed. **This is the actual per-review dollar cost of the #501 default** — with `mode: engine-agent` now the zero-config default, every gate② pass on every PR spends up to this much on a local Claude session (in addition to whatever the worker itself spent producing the PR). Lower it, or switch to `different-model-codex`/`human`, if that per-PR review cost isn't wanted. |
| `agent.retryAfterSec` | `900` (15min) | Positive-integer backoff between paid engine-agent attempts on the same head after an unavailable verdict. The unavailable pin's first-attempt clock still governs configured reviewer failover and human escalation. |
| `agent.treeRetentionCap` | `10` | Maximum retained review trees across non-live heads. In-flight and escalated heads are always retained regardless of the cap; all trees for a head are deleted when its last live WAL row is decisively consumed. |

A fallback-obtained approval is **advisory, never verdict-bearing** on its own: it's
re-verified against live PR data through the recorded mode's own rules at every use, and
the always-blocking signals (unresolved review threads, a standing
`CHANGES_REQUESTED` from anyone) block regardless of any failover state.

`reviewer.agent` is rejected with every mode other than `mode: engine-agent` (dead config). With
`mode: engine-agent`, it is **optional** — if omitted, config load default-injects a block for you
(`agent.model` above); if set, `agent.model` is still required and non-empty. It has no
`fallbackModel` field either way. The engine spawns this review directly after deterministic
preflight —
there is no trigger comment or hosted bot to poll. The session emits strictly structured per-AC
judgments and findings; the engine validates that output, derives approval or rejection, writes a
non-authoritative audit comment, then re-fetches the live gate state before consuming the verdict.
Engine-agent review spend is governed only by `agent.costCapUsd`. It is not written to
`spend_ledger`, so it is outside `cost.roundBudgetUsd`, `cost.dailyBudgetUsd`, and
`stop.afterSpendUsd` — instead, every attempt in a logical review that reaches a decisive verdict
(and so produces an audit artifact) has its spend recorded there, one entry per attempt,
discriminant carried verbatim: provider-reported, pinned-price estimate, or explicitly unknown
(see [`security.md`](security.md#producer--reviewer--merger)'s "Single-identity limitation for
engine-agent review"). A logical review that never reaches a decisive verdict (both attempts
exhausted with no usable output) produces no artifact and no audit comment, so its spend is not
recorded there either.

### Reviewer tier vs. worker tier

**The pairing rule: the reviewer's model tier sits at or above the worker's, and the two must
differ.** gate② is the loop's trust anchor — under the default merge mode the conductor merges
on its verdict alone — so the review-quality expectation must never sit *below* the
production-quality expectation. D5 enforces only the *difference* ([`agent.model`](#reviewer)
above); the ordering is stated by the shipped defaults, this section, and a validate-time
warning, never by a parse rejection.

| | Shipped default | Cost expectation |
|---|---|---|
| `worker.model` | `opus` | Bounded by `worker.budgetUsdSoft × (1 + worker.maxResumes)` = **$30/issue** worst case at the shipped values (the bound is in dollars — see [Calibrating `budgetUsdSoft`](#calibrating-budgetusdsoft)). |
| `reviewer.agent.model` | `fable` (#582 option (a); `sonnet` before 2026-08-03) | Bounded by `reviewer.agent.costCapUsd` = **≤$3/PR** per logical review. The cap is dollars, so a review still costs at most $3 — it simply buys fewer tokens at fable rates ($10/$50 per MTok) than it did at sonnet rates. |

Raising the reviewer *above* opus (rather than swapping the pair) keeps the expected total nearly
unchanged: workers dominate spend and are untouched, while reviews are capped an order of
magnitude below them — the dollar-capped review just buys fewer, stronger tokens. The rejected
alternative (worker→sonnet / reviewer→opus) made a config that sets only `worker.model: opus` —
including this repo's own — collide with its defaulted reviewer under D5.

**`sapwood validate` warns on an inversion.** When the configured `reviewer.agent.model` is
priced *below* `worker.model` in the loaded rate table (`worker.pricingFile`, or the shipped
`pricing.yaml`), validate prints a `WARNING — reviewer is cheaper/weaker than worker` line and
still **exits 0**. It stays silent when the rates are equal, when the reviewer's is higher, or
when *either* model is absent from the table. Warning rather than rejection, deliberately: model
strings are free-form and the rate table is a hand-maintained *cost* proxy for capability, so a
hard failure would reject legitimate setups — a cross-vendor `agent.runner: codex-exec` reviewer
has no rate comparable to a Claude worker's at all.

**Raising `worker.model` to `fable`** therefore takes two edits, not one: set
`reviewer.agent.model` to something other than `fable` in the same change, or the parse fails on
D5 with both sides reading `fable`. There is no shipped tier above fable, so at that point the
ordering rule and D5 pull in opposite directions — pick a distinct reviewer and accept the
validate-time inversion warning, or keep the worker at or below `opus`.

**Which CLI runs the review (`agent.runner`, #443)** is a separate question from `reviewer.mode`,
and the two codex-shaped options are easy to confuse:

| | `reviewer.mode: different-model-codex` | `reviewer.agent.runner: codex-exec` |
|---|---|---|
| What runs | a **hosted** GitHub App, asked via a PR comment (`triggerCommand`) | a **local** `codex exec` process sapwood spawns itself |
| Reviewer kind | hosted-bot verdict parsing (`COMMENTED`/`APPROVED`) | `engine-agent` — engine-derived blocking over strictly validated structured output |
| Local install needed | none | the `codex` CLI + a codex login |
| Composes with `mode: engine-agent` | no (it *is* the mode) | yes — it is a dimension *inside* the engine-agent mode (the #501 default) |

Both runners share ONE output-validation path: whatever the session says is validated element-wise
into findings before it can influence any verdict, so a prose-only or malformed reply from either
runner is an invalid attempt — never an approval and never a block.

**Choosing a hosted-bot entry point (`triggerCommand`, #156):** for the hosted-bot modes,
sapwood doesn't hard-code how you invoke a review — the default posts `@codex review`, which
triggers a Codex PR-comment review, but you can point this at any bot or reviewer entry point your
workflow uses. The hosted-bot verdict parser stays Codex-shaped regardless of this setting: it
looks for `COMMENTED`/`APPROVED` review states from a Codex-bot (or
`trustedReviewers`-allowlisted) identity. A custom trigger whose reviewer posts a different
verdict shape is not yet understood by gate②; this trigger/parse contract does not apply to the
engine-agent's structured session output.

## `merge`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `conductor-merge` | `conductor-merge`: once gate① (CI green) and gate② (a fresh review on the current head) both pass, the conductor squash-merges, pinned to that exact head (`--match-head-commit`, closing the TOCTOU window). `produce-pr-and-stop`: both gates are still computed and reported every tick, but the engine never calls the merge API — a human merges. |

## `ci`

| Key | Default | Meaning |
|---|---|---|
| `pendingEscalateAfterSec` | `21600` (6h) | How long gate① may stay **pending** — a check rollup that is neither green nor red — behind an already-decisive gate② verdict before sapwood applies `needs-human` to the PR, posts an evidence comment naming the still-pending check(s), and emits `ci-pending-escalated`. Visibility only, exactly like `reviewer.escalateAfterSec`: the lane stays driving, polling continues, and no gate is softened. The clock is a durable pin in the event log, so it survives an engine restart. It cancels only when gate① actually **resolves** — green or red — or when a push moves the head; any later pending episode then starts from zero. A check that *concludes without passing* (`CANCELLED`, `SKIPPED`, `NEUTRAL`, `STALE`, `ACTION_REQUIRED`) does **not** cancel it: gate① stays not-green, so the lane still cannot progress on its own, and the evidence comment names those checks too. |
| `requiredChecks` | `[]` | Trusted CheckRun execution evidence required by the engine-agent preflight. Each entry is an object with `name` (required, non-empty) and `app` (default `github-actions`, non-empty). Every configured pair must match a current-head CheckRun with conclusion `SUCCESS` and the configured owning GitHub App slug. |

The `name` + `app` binding is part of the evidence contract: a same-named check from an
untrusted app, a legacy status context, or a `SKIPPED`, `NEUTRAL`, queued, or in-progress CheckRun
does not count. The review session supplies the static half of a code-verifiable AC's evidence by
mapping it to a substantive, enabled test on the discovery path; the engine supplies the
deterministic execution half from these trusted CheckRuns.

An empty list is legal so configuration can be adopted incrementally. With
`reviewer.mode: engine-agent`, config loading warns, and the shipped drive preflight queues
fail-closed because it has no trusted execution evidence; no paid review session begins until at
least one required check is configured and satisfied.

**A check that never finishes (`pendingEscalateAfterSec`):** gate① is fail-closed — a queued or
in-progress check is not green, so the lane waits. A check that hangs forever (a runner that never
picks the job up, a required workflow that never starts) would therefore wait forever too. Past
this bound sapwood escalates it the same way it escalates review silence, and — this is the part
that matters for a wind-down — a lane whose pin is past the bound also counts as terminal for the
bounded drain, so a cost-ceiling breach or the kill switch can finish draining instead of spinning
against a lane that can never progress. A pin that is merely fresh is never terminal: that is an
ordinary healthy wait while CI runs.

**A red default branch (no configuration):** base-branch CI awareness needs no config key. While
at least one lane is driving, sapwood reads the default branch's own check rollup once per tick.
If that branch's HEAD commit is CI-red, every open PR's merge-ref CI inherits the red, so sapwood
raises **one** run-level escalation naming the base commit and the failing run (never one per lane
or per poll), each waiting lane's queued reason says the wait is base-inherited and names that
commit, and `sapwood status` reports `base CI: RED at <sha>`. It clears itself once the branch is
green again — no manual step. If `requiredChecks` is configured, only those trusted name+app pairs
can mark the base red; if it is not, any check on that commit whose own conclusion says it ran and
failed counts. Nothing gates on this signal: it is announcement and labelling only, so an
ambiguous or unreadable read simply reports nothing rather than holding a lane.

### gate① CI evidence (all reviewer modes)

Independently of `requiredChecks`, every reviewer mode has a gate① CI signal derived from the
PR's own status-check rollup. It is green only when the rollup has **at least one** check and
**every** check conclusively passed — a modern CheckRun with conclusion `SUCCESS`, or a legacy
commit status context with state `SUCCESS`. There is no configuration knob for this; it is not
the `requiredChecks` list.

Legacy commit status contexts still pass this gate, even though they never satisfy a
`requiredChecks` entry. That is not an inconsistency: `requiredChecks` rejects them because a
status context has no check suite and so its owning GitHub App cannot be verified against a
configured `{name, app}` pair — a binding specific to that opt-in evidence chain. Gate① is the
general "did this repo's CI pass" signal for every reviewer mode, the Status API has no
`SKIPPED`/`NEUTRAL` concept, and rejecting status contexts here would leave any repo whose CI
reports through that API unable to ever reach green. Repos that want the app-bound, forge-resistant
boundary at review time configure `requiredChecks`.

`SKIPPED` and `NEUTRAL` are **not** green (#401). They mean the job did not execute, so they are
not evidence that anything was verified — a workflow whose test job is skipped used to read as
gate①-green and could be merged with zero execution evidence. Queued/in-progress checks
(no conclusion yet) and `CANCELLED` / `STALE` / `ACTION_REQUIRED` are not green either, and an
empty rollup is not green (a just-pushed PR whose checks have not been created yet must not read
as "this repo has no CI"). None of these are treated as CI *failure* either: they leave the gate
waiting rather than dispatching a mechanical CI-fix leg, which cannot fix a job that was
deliberately skipped.

**Compatibility — repos that legitimately skip jobs.** If a workflow uses `paths:` /`paths-ignore:`
filters or a job-level `if:` so that a check reports `SKIPPED` on some PRs, those PRs no longer
reach gate①-green and the lane will wait instead of merging. This is the same trap GitHub's own
required-status-checks have, and it has the same fix: **make the job always run and skip its
steps**, so it still reports `SUCCESS`.

```yaml
# Before: the whole job is filtered out -> reports SKIPPED -> not gate①-green.
on:
  pull_request:
    paths: ["engine/**"]

# After: the job always runs; only the expensive steps are conditional -> reports SUCCESS.
on: pull_request
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          # The default depth-1 clone has no base commit to diff against.
          fetch-depth: 0
      - id: changed
        shell: bash
        run: |
          # set -e so a BROKEN detector fails the job. It must never fall back to
          # "nothing changed" — that skips the tests and still reports SUCCESS, which
          # is exactly the zero-execution-evidence hole this guidance exists to close.
          set -euo pipefail
          files="$(git diff --name-only "${{ github.event.pull_request.base.sha }}"...HEAD)"
          if grep -q '^engine/' <<<"$files"; then
            echo "engine=yes" >> "$GITHUB_OUTPUT"
          else
            echo "engine=no" >> "$GITHUB_OUTPUT"
          fi
      - if: steps.changed.outputs.engine == 'yes'
        run: npm test
```

The failure direction matters more than the detector: a change detector that errors must fail
the job loudly, never default to "no changes". A silent `|| echo no` turns an unfetched ref or a
bad path into a green check with nothing executed — the same hole as a `SKIPPED` job, but harder
to see.

The alternative, if a check should not participate in the merge decision at all, is to not run it
on `pull_request` — a check that never appears in the rollup does not hold the gate, whereas one
that appears as `SKIPPED` does.

## `labels`

The label taxonomy the loop reads and writes. GitHub label names are case-insensitively
unique but case-preserving, so sapwood normalizes every label comparison by trimming and
lowercasing both sides. `sapwood init` detects existing labels case-insensitively and sends
lowercase names when creating missing labels; re-runs still preserve existing label casing,
colors, and descriptions. It provisions all workflow labels below plus the fixed taxonomy,
formed by prepending `labels.prefix` to `type:*` and `prio:*`.

`labels.prefix` namespaces all omitted workflow-label defaults and the fixed taxonomy. Set it
to `""` to use bare names. The prefix is normalized to lowercase and may not contain
whitespace. It affects defaults only: any explicitly configured workflow label is used
verbatim, without prepending the prefix. An explicit `escalation.humanLabels` array is likewise
used verbatim.

**#640: per-label semantics (writer/remover/gates/distinguish-from) are a typed registry, not
just this table's prose.** `engine/src/forge/labels.ts`'s `LABEL_SEMANTICS` — one entry per
workflow, taxonomy, and hold label, exhaustive at compile time — is rendered into the
`sapwood-labels` skill (see [`security.md`](security.md#role-session-skill-injection-an-accident-fence-not-a-jail-639))
against THIS repo's resolved names, so a role session reading it never sees a default or a
`labels.prefix` template. This table stays the operator-facing reference (defaults, config
keys); the registry is that same knowledge's role-session-facing, compile-checked twin.

### Upgrading from pre-#199

> [!WARNING]
> Stop sapwood and complete this label migration **before restarting the engine**. There is no
> automatic bare-label fallback: with the new default prefix, existing bare labels are ignored.

Choose one migration strategy:

1. Set `labels.prefix: ""` to keep the pre-#199 bare namespace; or
2. Rename every existing workflow, taxonomy, and dependency label into the configured namespace
   (by default `sapwood:`), on both issues and PRs. This includes `in-progress`, `needs-human`,
   `blocked`, `reserve`, `verify:n/a`, `plan:approved`, `origin:agent`, `type:*`, `prio:*`, and
   `blocked-by:N`. Remove or update any explicit workflow-label pins so they name the migrated
   labels. Also remove an explicit `escalation.humanLabels` array so it derives from the resolved
   workflow labels, or update its entries to the migrated names; it must contain the migrated
   `labels.needsHuman` value.

This is safety-critical, not cosmetic. A PR carrying only the old bare `needs-human` label no
longer holds the merge gate under the prefixed defaults. Bare `needs-human`/`blocked` issue labels
no longer hold dispatch, and a gated lane can appear human-released and re-enter automatically.
Bare `reserve`, `blocked-by:N`, and `prio:N` labels are also ignored. Pre-#199 generated configs
pin the workflow-label values and `escalation.humanLabels`, but do not contain `labels.prefix`,
so they still require `labels.prefix: ""` or a complete migration—including removing or updating
both sets of explicit pins—before restart.

| Key | Default | Meaning |
|---|---|---|
| `prefix` | `sapwood:` | Namespace for omitted workflow-label defaults and the fixed `type:*`/`prio:*` taxonomy. Empty string selects bare names. |
| `inProgress` | `sapwood:in-progress` | Applied to a claimed issue. |
| `needsHuman` | `sapwood:needs-human` | **Bucket 1 (#397): the machine stopped and a human owes the next decision.** Shipped description, verbatim: `Engine-applied: autonomy stopped, a human decides; remove to hand it back.` Removal is the [#147](https://github.com/herehigher/sapwood/issues/147) gated-reentry handshake — the engine reclaims the lane and re-drives it. Its value must be listed case-insensitively in `escalation.humanLabels` so the written label is recognized by both PR and issue holds. |
| `blocked` | `sapwood:blocked` | An external wait — nobody's queue. Written by the **engine** (the architect's severe-contradiction pass, `roles/architect.ts`) as well as by a human. Shipped description, verbatim: `Engine- or human-applied: an external wait; remove once it clears.` **On a PR it is the human veto channel (#399):** the merge gate matches every `escalation.humanLabels` entry — `needs-human` *and* `blocked` — against the PR's own labels, so applying `sapwood:blocked` to a PR stops the engine merging it, and removing it hands the PR back. See the `humanLabels` row below for the full description of that channel. |
| `reserve` | `sapwood:reserve` | Parked out of the main dispatch lane by a human. Shipped description, verbatim: `Human-applied: parked out of dispatch; remove to make it dispatchable again.` |
| `humanMergeOnly` | `sapwood:human-merge-only` | **Bucket 2 (#397): a human must MERGE this PR** — the PR is not stuck, its merge decision simply is not the loop's to take. Written by the engine on the **PR only**, exactly once, by the instruction-path trust chain ([#292](https://github.com/herehigher/sapwood/issues/292)); never removed and never re-decided by any automated act. Shipped description, verbatim: `Engine-applied on the PR: a human must merge it. The loop never removes or re-decides this.` Deliberately **not** a member of `escalation.humanLabels` — a lane settling on this verdict terminates without `gated_escalation_labeled`, so it is structurally invisible to `State.gatedFailedWorkers()` and can never be gate-reclaimed or re-escalated to `needs-human`. The name reuses [`security.md`](security.md#human-merge-only-paths)'s existing *human-merge-only* vocabulary: one fact, one term. |
| `planless` | `sapwood:planless` | **Not an escalation at all (#397).** A routing fence for an issue that has no verification plan yet — applied by the PO's decomposition remainder path and its no-plan creation path, which both used to borrow `needsHuman` and so put items nobody owed a decision on into the human queue. Shipped description, verbatim: `Engine-applied: no verification plan — off every queue. Not an escalation; add one, then remove.` It is excluded by `isPoolEligible`, `needsPlanReview`, `needsPlanTriage`, and the standby probe exactly as `needsHuman` is, so pool/triage/dispatch exposure is unchanged from before the rename. Not a member of `escalation.humanLabels`. |
| `verifyNa` | `sapwood:verify:n/a` | Marks an issue as inherently unverifiable by tests — skips the verification-plan gate and routes through the doc-gate path instead. |
| `planApproved` | `sapwood:plan:approved` | gate⓪ (#88): required, together with a genuine verification-plan section AND a non-malformed checkbox acceptance-criteria set (`- [ ] ...` lines under `## Acceptance criteria` — #283), for `getReadyIssues` to dispatch a non-`verifyNa` issue. Applied by the verification-plan-reviewer peripheral after quality-reviewing the plan — plan *presence* alone is no longer sufficient. **#214 semantic shift:** this label is no longer "approved forever" — it means *approved when granted, re-endorsed at every round-pool entry before dispatch*. A pool member carrying it from a PRIOR round gets a lightweight confirm pass (see `verificationPlanReviewer.confirmPromptFile` below) checking the plan still holds against current `main` before that approval is trusted again; the label itself is never removed by that pass either way. See [`security.md`](security.md#the-planapproved-label-and-gate-88) and [`security.md`](security.md#the-ac-authority-dispatch-snapshot-283-design-279-5) (the pre-launch AC snapshot + review-time drift check). |
| `originAgent` | `sapwood:origin:agent` | Provenance stamp applied by the PO/align orchestrator to agent-created issues. See [`security.md`](security.md#the-originagent-label-convention). |
| `split` | `sapwood:split` | Human firing signal for PO decomposition. The engine reads but never applies or removes it. On an `origin:agent` child, applying this label permits decomposition, but label application time does **not** define attempt freshness: the signature is derived from the issue title and body evidence. An unchanged title/body fires at most once; editing the body (or title) changes the signature and re-arms a new attempt. |
| `decomposed` | `sapwood:decomposed` | Engine-written parent fence. The parent is retired to Todo as a tracking container and excluded from every engine ingestion/dispatch path. The engine never removes this label and never auto-closes the parent. |
| `roundPool` | `sapwood:round:pool` | #212: round-pool membership. Applied by the aligning phase's pool-selection pass to up to `ceil(lanes.roundDispatchCap × round.poolFactor)` **pool-eligible** issues each round — #214 widened that candidate source past `getReadyIssues` (gate⓪-passed only) to Ready-lane-minus-holds (gate⓪-passed *or* still-awaiting-review), so an unapproved issue can still be selected, reviewed, and approved without ever having been gate⓪-passed first. gate⓪ itself is now scoped to this SAME label (#214) — see the verification-plan-reviewer note above. The executing phase still dispatches gate⓪-passed pool members only. Must not equal any other resolved workflow label or `escalation.humanLabels` entry — config load rejects the collision (see the note below). Cleared from **every** open issue that still carries it at round close, with no exemption (engine-only removal, see the note below). |

| `laneState` | `sapwood:lane:active` | **The PR-side lane-state mirror (#399): "a worker lane is actively on this PR right now."** Applied to a lane's PR while that lane is `driving` or `fixing`, and removed the moment it reaches any terminal state (merged, escalated, dead). Shipped description, verbatim: `Engine-applied on the PR: a lane is actively working it. Removed automatically when the lane ends.` Before this, `needs-human` was the only label the engine ever wrote to a PR and `in-progress` was issue-only, so the PR list — where the merge decision is made — could not tell a lane mid-fix from a dead one. **One label for both active states** on purpose: which of the two a lane is in decides which supervision loop owns it, not whether a human should step in, and the PR list needs one bit. Engine-written *and* engine-removed — the only such label besides `roundPool` — so its removal is routed through one fail-closed guard (`lane-state-label.ts`'s `removeLaneStateLabel`, which throws for any other label) and config load rejects it aliasing any protected label, including a hold label (see the note below). Nothing gates on it: it is a visibility signal, invisible to `deriveGate`, dispatch and every queue. |

**There is no `labels.hold` key.** The human-applied WAIT-tier hold (#248) is configured under `escalation.holdLabels` instead (see the `escalation` table below) — the engine never writes this label (only a human applies/removes it), so unlike every label above there is no engine-owned single value to override.

**`removeLabel` is pinned to `labels.roundPool` only (#212).** This is the first `IForge` write that *removes* a label, and label removal is otherwise reserved for an explicit human act — [#147](https://github.com/herehigher/sapwood/issues/147)'s gated reentry reads a human clearing `needs-human`/`blocked` as the very signal that authorizes reclaiming a lane, and gate⓪ treats `plan:approved`/`verify:n/a` presence as a human-trusted adjudication. The engine routes every `removeLabel` call through one guarded helper (`round.ts`'s `removeRoundPoolLabel`) that throws for any label other than the resolved `labels.roundPool` — no session-reachable output schema can ever drive it. Two callers use it, both engine-only, never session-driven: `align.ts`'s pool-selection reconcile pass (clears a stray pool label from any open issue outside this round's selected target, at selection time) and round close (clears the pool label from every open issue that still carries it, no exemptions). Config load additionally rejects `labels.roundPool` aliasing any other protected label, so this removal path can never be pointed at `needs-human`/`blocked`/`plan:approved`/`verify:n/a` even by misconfiguration.

**`removePRLabel` is pinned to `labels.laneState` only (#399).** The PR-side twin of the rule above, and it matters at least as much: `deriveGate` reads `needs-human`/`blocked` and the hold labels off the **PR's own** labels, so an unguarded PR-label removal would be a path capable of forging a human release on the very object where the merge decision is made. `IForge.removePRLabel` therefore has exactly one production caller — `lane-state-label.ts`'s `removeLaneStateLabel`, which throws (and removes nothing) for any label but the resolved `labels.laneState` — and config load rejects `labels.laneState` aliasing any protected label, `labels.roundPool`, or any `escalation.holdLabels` entry. A second call site is a defect until it arrives with a provenance check of its own.

**The other two authorized engine removals** are each scoped by their own provenance check rather than by that helper (widening it to a second label would destroy the "accepts nothing but `roundPool`" guarantee); the canonical list lives on `round.ts`'s `removeRoundPoolLabel`. (a) `escalation-sweep.ts` clears `labels.needsHuman` when the event log *proves* the engine applied it **and** the resolution witness is a merge or an issue close ([#441](https://github.com/herehigher/sapwood/issues/441)) — a hand-applied label has no such proof and is never touched. (b) The dispatch phase clears a stale `blocked-by:N` label once GitHub reports issue `N` as no longer open ([#485](https://github.com/herehigher/sapwood/issues/485)): `blocked-by:N` is an engine-legible ordering marker (decomposition writes them between a parent's children), not a human adjudication, so a closed blocker now unblocks its dependents on the next tick instead of waiting for someone to strip the label by hand. Only the closed blockers' labels go — an issue naming several blockers stays blocked until the last one closes — and a token matching any configured workflow/escalation label is refused outright. The check is bounded: it looks only at the Ready issues the tick already fetched, deduplicates blocker numbers, and makes at most 20 blocker reads per tick; anything past that (or any transient read failure) keeps its label and is retried on a later tick, never escalated.

## `roles`

Peripheral-role configuration. The round orchestrator (`driver: rounds`, the
`sapwood run` default) loads and runs every one of these role prompts each round.

**Issues-only role sessions carry no shell (#110).** `verificationPlanReviewer`, `verificationPlanDrafter`,
`po` (align + triage), `harvest`, and `architect` sessions hold no `Bash` tool grant at
all — pure computation: the issue/config context is substituted into the prompt, and
the session has no `Read`/`gh` access of its own. Each session's final message ends in
a structured output block; the engine parses it, validates it against a per-role
schema plus cheap content invariants (e.g. re-confirming an "approve" claim's body
really carries a verification-plan section), and performs every GitHub write itself.
Malformed or invalid output retries once, then the role's own degrade path — never a
silent no-op, never a wedged round. `retro` is the one exception: a worker-class
session with `Read` + local git only (proposals land exclusively as PRs, never a
direct write) — see [`security.md`](security.md) for the full model.

**Ambient repo context is received by design, and recorded, not sealed (#236).** Every
role session above still runs `claude -p` inside a real repo worktree, so it
legitimately absorbs that worktree's `CLAUDE.md`, the user's global `CLAUDE.md`/
auto-memory, and the CLI's other dynamic system-prompt sections — same as any
interactive session would. This is intentional: the trust boundary here is
action-side (what a session can *do* — the empty tool allowlist above, the
credential-stripped spawn env, [#219](https://github.com/herehigher/sapwood/issues/219)),
never content-side (what it can *read*), and repo conventions living in `CLAUDE.md`
are exactly what a role session should absorb. Sealing this channel (a clean,
`--bare`-style directory with no ambient `CLAUDE.md`) is reserved for **benchmark**
runs only — see [`security.md`](security.md#ambient-repo-context-record-dont-seal-236)
for the full rationale, the isolation recipe (which MUST use `--bare`), and why that
recipe is never acceptable for production dispatch (`--bare` also disables hooks, and
the guard hook must stay live). Recorded for **all 10/10** `runSessionWithRetry`
peripheral call sites — harvest, architect, plan-review (reviewer, drafter, and
#214's confirm session), retro,
[#310](https://github.com/herehigher/sapwood/issues/310)'s `decompose.ts` PO
decompose sub-mode (`po-decompose`), and (as of
[#251](https://github.com/herehigher/sapwood/issues/251)) `align.ts`'s three PO
sessions (`po-align`, `po-triage`, `po-pool`) — **plus, as of
[#617](https://github.com/herehigher/sapwood/issues/617), every worker/producer leg**
(`WorkerSupervisor.dispatch()`/`resume()`) — every session attempt
assembles a **context manifest**: every source among a deliberately bounded,
ENUMERATED set of standard CLAUDE.md-family paths (see the manifest's own
`probedPaths`; never Claude Code's full resolution graph — imports, ancestor-directory
files, and managed policy are named, not chased, in `knownUnprobed`), each one
content-addressed inline regardless of whether it's git-tracked (a worktree-resolved
`gitCommit` survives only as ADVISORY metadata, never a recoverability guarantee — a
write-capable session could still have modified it), the model/CLI/tool-inventory/
prompt actually used (with an explicit `modelSource` discriminator — never a silent
substitution), MCP server availability, the worktree's resolved HEAD, and the
settings/guard-hook hashes — so two attempts of the same phase are independently
diffable rather than assumed comparable. The probed sources include
`<worktree>/CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, every `*.md`
recursively under `.claude/rules/`, and the user-global `CLAUDE.md` (honoring
`CLAUDE_CONFIG_DIR` when set, else `~/.claude`). The filesystem-derived half is
captured as early as the engine can observe it — anchored to the session's own
stream-json init line, never a bounded wait for the worktree directory to merely
exist (that anchor raced a real checkout once) and never at session teardown —
precisely so a write-capable session's own edits can never be mistaken for what it
started with; a `captureBasis` field on the manifest names whether that anchor
actually fired or the capture fell back to its bound.

**`architect` also batch-reviews the round pool (#213).** Alongside its original,
unchanged drift-review mission (cross-issue consistency + contradiction flags over the
candidate issues still awaiting gate⓪ — see `architect.lastMergedMaxChars` below), the
SAME single session is additionally shown this round's actual **pool** (#212's
`labels.roundPool` members, queued for this round's dispatch — **may overlap with the
drift-review candidates since #214**, whose widened pool candidacy means a pool member
can still be awaiting its first gate⓪ review rather than already approved; the two
output kinds are validated against their own list regardless of overlap) and
returns a per-issue **verdict** for each one: `pass` (the default — say nothing), `drop`
(the engine removes `labels.roundPool` via the one sanctioned label-removal path and
posts the session's reasoned comment — the issue returns to plain Ready, re-selectable
in a later round), or `needs-human` (the engine applies `labels.needsHuman` + the
reasoned comment — only a human ever clears it, #147). As with every other structured
verdict in this loop, the mapping from verdict kind to label is fixed, engine-side
logic — the session's output schema carries no label field at all. Same **degrade-open**
stance as the rest of this role: an invalid/failed session (after one retry) never gates
dispatch — the pool simply proceeds **unfiltered** (no verdict applied to anything), and
the skip is recorded as a DISTINCT, dedicated honesty event (`architect-review-degraded`,
carrying the round id + a reason), separate from the pre-existing `architect-degraded`
(which still covers the underlying session-level retry exhaustion, drift-review note
included). A per-issue write-ahead receipt guards against a crash-rerun re-posting the
same reason comment twice; a transient forge failure on one verdict's write is
contained per-issue (an `architect-verdict-lost` honesty event, the remaining verdicts
still applied) rather than aborting the whole pass.

**gate⓪ is scoped to the round pool, with a freshness re-confirm at every pool entry
(#214).** Before #214, the verification-plan-reviewer swept **every** Ready-lane issue still awaiting
gate⓪ each round — with a large backlog, one phase could burn dozens of sessions on
issues that wouldn't dispatch for rounds, serially, while workers waited. Now the
verification-plan-reviewer's candidate set is the round pool itself (`labels.roundPool` members, read
live by label at phase-start — the phase runs strictly after `architecting` in the round
sequence, so a `drop` verdict's label removal has already landed), split into four
classes: **(1)** a pool member with no `plan:approved` yet gets the full,
unchanged draft→re-review cycle; **(2)** a pool member whose `plan:approved` was granted
in a **prior** round gets a single, lightweight **confirm** session — "does this plan
still hold against current `main`?" — that makes **zero forge writes** on confirm, or
hands its brief straight into the SAME draft→re-review machinery on invalidate (same
`maxDraftCycles` cap, same escalation); **(3)** a pool member approved **this round**
(detected from the round's own event window, #123 — a `plan-approved` event for that
issue with an id after the round's `start_event_id`) is skipped outright, no session at
all — selection→review→dispatch all happening in one round makes re-reviewing a
just-granted approval pure waste; **(4)** a `verify:n/a` pool member is untouched, same
doc-gate path as before. A confirm session that fails or produces invalid output TWICE
is the one **fail-closed** gate in this whole feature (unlike the architect's
degrade-open batch review above) — it escalates `needs-human` with the attempt trail,
never silently lets a possibly-stale plan through. `plan:approved` is never removed by
the confirm path either way (a crash mid-confirm just means a rerun re-confirms — no
marker of its own needed). Non-pool Ready issues get zero gate⓪ attention of any kind
regardless of their approval state — that is the entire point of scoping to the pool.
Widening the pool's own CANDIDATE source (not the confirm/review split above) is what
makes this possible without deadlocking: an unapproved issue must still be reachable by
pool selection (`align.ts`'s `computePoolCandidates`, `round.poolFactor` above) or it
could never be reviewed, approved, or dispatched at all — so pool candidacy is Ready lane
minus `needsHuman`/`blocked` (gate⓪-passed issues **and** issues still awaiting their
first review), one selector reading one project fetch. Dispatch itself is unaffected:
the executing phase's own `PoolScopedForge` still requires gate⓪-passed
(`getReadyIssues`), so a pool member without `plan:approved` still cannot be dispatched
merely for having entered the pool.

**`retro` holds no `gh` grant at all (#111).** Reads: its prompt is seeded with an
engine-built round-scoped digest — PR descriptions + diffs + review signals for every
PR the round touched, comments/labels for every escalated issue, and the round's
commit history — assembled deterministically before the session runs and substituted
in as `{{round.digest}}`. Writes: the session edits, commits, and pushes a proposal
branch, then records its intended PR (branch/title/body, or `none` for a quiet round)
in a fixed scratch file (`.sapwood-retro-pr`) in its worktree; the engine parses that
file fail-closed, verifies the branch really exists on the forge, and opens the PR
itself via the same forge layer every other engine write uses. `retro` keeps only
local git (branch/checkout/add/commit/push/diff/status/log, for its own worktree).

**Renamed in #413 — `planReviewer` → `verificationPlanReviewer`, `planDrafter` →
`verificationPlanDrafter`.** The gate⓪ role reviews an issue's *verification plan* (its
acceptance criteria and how to prove them), never its plan of work, and the keys now say
so. The old names are retired, not deprecated: a config still carrying `roles.planReviewer`
or `roles.planDrafter` fails to load with an error naming the replacement key. Every
sub-key underneath is unchanged, so the fix is renaming the one line. The shipped prompt
files moved with them (`prompts/plan-reviewer.md` → `prompts/verification-plan-reviewer.md`,
and likewise for `-confirm` and the drafter) — a config pointing `promptFile` at a prompt of
its *own* is unaffected.

| Key | Default | Meaning |
|---|---|---|
| `verificationPlanReviewer.promptFile` | unset | Override the gate⓪ verification-plan-reviewer's prompt (same `#74` pattern as `worker.promptFile`: a relative path resolves against the config file's own directory, not the CLI's cwd). Unset uses the engine's shipped `prompts/verification-plan-reviewer.md`. |
| `verificationPlanReviewer.confirmPromptFile` | unset | #214: override the gate⓪ **freshness re-confirm** prompt — the lightweight, single-question pass a round-pool member with a PRIOR-round `plan:approved` gets at every pool entry ("does this plan still hold against current `main`?"), distinct from the full verification-plan-reviewer prompt above. Same `#74` pattern: a relative path resolves against the config file's own directory. Unset uses the engine's shipped `prompts/verification-plan-reviewer-confirm.md`. Shares `verificationPlanReviewer`'s `model`/`effort`/`fallbackModel` — only the prompt differs. |
| `*.fallbackModel` | `sonnet` | Every role session accepts `fallbackModel`. It supplies Claude's `--fallback-model`; set literal `"none"` to omit it and fail loud instead of silently downgrading quality. See [#168](https://github.com/herehigher/sapwood/issues/168) for the environment-failure path. |
| `verificationPlanReviewer.maxDraftCycles` | `2` | gate⓪ self-heal bound (#77 Amendment 2): max draft→re-review cycles per issue when the reviewer requests a plan draft (a scoped, issues-only drafting session — never a worker lane, never an implementation). Exhausted → the loop applies `needs-human` with the attempt trail. Positive integer only — `0` would turn every draft request into an instant `needs-human`. |
| `harvest.artifactMaxChars` | `20000` | #123: cap, in characters, on the round-artifact markdown block substituted into harvest's prompt as `{{round.artifact}}` (see [`round-artifact.md`](round-artifact.md)). Deterministic truncation, same contract as `retro.digestMaxChars` below. A safety valve — the artifact is naturally small (bounded by the round's own dispatch cap). |
| `architect.lastMergedMaxChars` | `10000` | #132: cap, in characters, on the previous round's merged-PR outcomes substituted into the architect's prompt as `{{round.lastMerged}}` — read from the persisted round artifact (`round_artifacts`, see [`round-artifact.md`](round-artifact.md)), never a live forge read. Numbers-only content (issue/PR/worker, no titles or files-touched — not persisted in the ledger), so the default is smaller than either sibling cap above. Same deterministic-truncation, marked-cut contract. |
| `architect.poolDigestMaxChars` | `20000` | #213: cap, in characters, on this round's pool digest substituted into the architect's prompt as `{{round.pool}}` — number/title/body for every `labels.roundPool` member, engine-assembled at architect-invocation time from a live forge read (never cached across a crash-rerun). Full issue bodies (like `candidates.summary`, not the numbers-only shape of `lastMergedMaxChars` above), so the default matches `po.backlogDigestMaxChars`'s size profile rather than `lastMergedMaxChars`'s smaller one. Same deterministic-truncation, marked-cut contract (`capDigest`). |
| `retro.promptFile` | unset | Override the retro/self-evolution peripheral's prompt (same `#74` pattern). Unset uses the engine's shipped `prompts/retro.md`. |
| `retro.everyNRounds` | `1` | Retro cadence (#104): `1` runs every round; `N > 1` skips every round whose id isn't a multiple of `N` (the phase still closes, marker still set — never wedges the round). |
| `retro.digestMaxChars` | `60000` | Hard cap, in characters, on the engine-built round-scoped read digest (#111 PR-A) substituted into retro's prompt as `{{round.digest}}` — PR diffs + review signals for every PR the round touched, comments/labels for every escalated issue, and the round's commit history. Oversize digests are truncated **deterministically** (same prefix every time for the same content+cap) and the cut is marked in the digest text itself, never silently dropped. |
| `retro.tendencyRounds` | `3` | #453 (design #402 R5): how many rounds the digest's **finding-class tendency table** spans, the current round **inclusive** (`1` = this round only). The table groups the engine's own durable per-round finding records (`drive-fixup`'s `findings`, added by #449) into `(kind, path-prefix)` classes with a count, the distinct PRs, and the distinct rounds each was raised on — everything else in the digest is bounded by one round's start cursor, but the recurrence this table exists to surface happens *across* rounds. Read via the ledger's id cursor from the earliest round in the window; a ledger holding fewer rounds than `K` degrades to what exists, never an error. The section shares `retro.digestMaxChars` under the same deterministic, marked truncation, and renders an explicit empty marker rather than disappearing when nothing was recorded. **The engine only tabulates:** no threshold fires and no code path turns a finding or a finding class into an issue — whether a recurring class is evidence about the design is retro's own judgment, and reaches the backlog only as a normal gate②-reviewed proposal PR. Accepted blind spot: a genuine recurring class goes unnoticed if retro is disabled or judges wrong; the mitigation is that the table is durable and visible, not that the engine acts on it. Positive integer only. |
| `po.backlogDigestMaxChars` | `20000` | Hard cap, in characters, on the open-issue digest substituted into PO align prompts as `{{backlog.digest}}`. The engine assembles issue numbers, titles, and configured human-hold label annotations at invocation time; zero issues and read failure render distinct explicit notes. **[#444](https://github.com/herehigher/sapwood/issues/444):** the digest covers **every** open issue, not just `round.milestone`'s — milestone scope now ORDERS and ANNOTATES it instead of filtering it. This round's milestone renders first (so the decomposition focus is what survives a truncated cap); the rest follows, each record marked `[milestone: X — outside this round]` or `[no milestone — outside this round]`, present purely as dedup context. The pre-#444 milestone filter made duplicate agent-filed issues mechanical rather than unlucky: an issue in the next milestone, or carrying no milestone at all (the shape every agent-filed proposal has — that is what keeps it out of the pool), simply could not be seen by the session instructed not to duplicate it. `engine/prompts/po.md` correspondingly no longer calls the digest "authoritative for current open issues": it names the real scope and, where the read-only forge proxy is attached, mandates an `mcp__forge__search_issues` pass on a proposal's key terms before filing. Still ONE bounded pack over the whole list — one cap, exact counts, the same truncation marker, no new config key. **[#528](https://github.com/herehigher/sapwood/issues/528):** the same widening on the **state** axis — the digest also carries the **last 50 closed issues** (most-recently-updated first), rendered last and marked `[recently closed — do not re-propose]`, and the same bounded set joins the engine-side mechanical dedup in `createIssueProposals`, so a normalized-title collision with a closed issue is skipped exactly like an open one (its `proposal-skipped` receipt carries `existingIssueClosed: true`). Before it, both layers were open-only: a fact that shipped and closed could be re-proposed indefinitely (align filed #525 hours after the same gap shipped as #461). The closed read is a **backstop, not a gate** — bounded by a fixed count rather than a configurable window, and if it fails the pass degrades to the pre-#528 open-only surface with a log line, never the creation suppression a failed *open*-issue read triggers. Closed issues are dedup context only: they are never a decomposition target, and they stay outside the in-view bounds the concern channel validates against. **#231:** truncation is now **whole-record** — an issue line either fits in full or is counted as omitted, never sliced mid-line, so a truncated digest can never silently drop the high-numbered tail with no trace; the marker names how many issues were rendered vs. omitted out of the total, and the same counts are recorded in the engine's `input_manifest` table (#231, migration v13->v14) — a durable, best-effort record of what a peripheral session actually saw (read status, content version/hash, counts, truncation), never itself a gate on anything. **Coverage** includes the channels align.ts itself dispatches a session with — goal file + backlog digest (`po-align`), issue body + backlog digest (`po-triage`), pool candidates (`po-pool`) — and, as of [#251](https://github.com/herehigher/sapwood/issues/251), architect's own engine-controlled channels too: `{{round.lastMerged}}`, candidate issue bodies, doctrine, the round directive, and the architecture-chapter excerpt (`architect.ts`, one attempt per session dispatch, same (round, phase, role, session, attempt) keying). The `input_manifest` table itself stays record-only, never a gate — [#232](https://github.com/herehigher/sapwood/issues/232) instead made the ACCEPTED-DECISION events these same align/triage/pool channels feed load-bearing (see `poolFactor` above for `pool-selected`, and the triage write-ahead/concurrent-edit-guard note below), a distinct mechanism from this manifest. **The linkage is shipped, not just planned:** every triage decision/receipt event (`triage-decision-accepted` and its three receipts) carries the SAME (phase, role, session, attempt) identity tuple as that dispatch's own `input_manifest` rows — the identical `attempt` number, not a derived one — so a manifest row and the decision/receipts it informed are joinable by that key with no foreign key needed, and (load-bearing, not just descriptive) a receipt for one attempt can never be mistaken for a different, superseded attempt's own decision. **#231:** a failed open-issue read (the digest read itself, not a transient blip elsewhere) now **suppresses issue creation for that align pass entirely** — zero `createIssue` calls, a durable `backlog-read-failed` event recorded — rather than letting the align session create against an invisible/placeholder inventory with no real duplicate detection; the `po-align` session itself still runs (it may still propose issues, which are journaled for audit but not created this pass), and the round-start triage pass is unaffected either way. The next round's own aligning phase retries the read fresh. Minimum `200`. Custom PO prompt files may omit the variable. #212: also reused, unmodified, as the cap on the round-pool selection session's candidate digest (`poolPromptFile` below). **That pool digest no longer renders title-only lines — each candidate now carries its FULL body (`architect.ts`'s `formatCandidate`, the same renderer/cost the architect phase already pays one phase later), so its size profile now matches `architect.poolDigestMaxChars` below, not the "naturally far smaller" title-only shape this cap was originally sized for; the same whole-record truncation applies, but it now bites far more readily. **The consequence is no longer merely a truncated digest — it can drop a candidate out of the round.** **[#558](https://github.com/herehigher/sapwood/issues/558):** that drop is no longer *silent* — `packDigestRecords`' marker now NAMES the omitted records (`[... candidate issues #41, #57, #63 omitted — exceeded the 20000-char cap; 7/10 rendered ...]`) instead of only counting them, for every caller (the backlog digest above gets the same shape). Pre-#558 an omitted candidate's number appeared nowhere in the rendered prompt, so it was invisible to the session AND to a human reading the transcript — po-pool's own `mcp__forge__*` grant doesn't help when the digest never named the candidate at all. Naming is **additive**: the `omitted` count and `truncated` flag keep their exact pre-#558 meaning, and a named candidate is still **not selectable** — selection is validated against the RENDERED subset, so the number is there to be cross-referenced against the board (and picked up by the next round), not to be chosen this one. Documented degradation: if the named list is itself what blows the cap, the marker falls back to the pre-#558 count-only wording rather than emitting a half-named list (a partial list would read as "these are the omitted ones" and be a lie); keeping one more record *rendered* always wins over naming it, since a rendered record is selectable and a named one is not. |
| `po.poolPromptFile` | unset | #212: override the round-pool **selection** session's prompt — a separate template from `po.promptFile` (align/triage). Same `#74` pattern: a relative path resolves against the config file's own directory. Unset uses the engine's shipped `prompts/po-pool.md`. Only consulted when `roles.po.poolSelection: true` (below) — this session receives the engine-computed candidate digest — the top `ceil(lanes.roundDispatchCap × round.poolFactor)` Ready issues, prio-ordered — and returns which of those issue NUMBERS belong in this round's pool; the engine applies `labels.roundPool` to exactly that (validated) selection. The output schema carries issue numbers only — no label name ever appears in it, so the round-pool label-removal containment invariant (see the `labels` table above) cannot be affected by this session's output even in principle. |
| `po.decomposePromptFile` | unset | #310: override the PO-decompose prompt. Relative paths resolve against the config file; unset uses `prompts/po-decompose.md`. The session keeps the normal issues-only, no-shell, no-forge-credential PO posture. |
| `po.maxChildren` | `8` | Hard per-firing bound, including coarse remainder children. Invalid/over-bound output is retried once, then the parent receives `needs-human` with evidence; no children are created. |
| `po.acceptanceCriteriaHint` | `5` | Prompt-only preferred maximum AC count per child. It is a granularity heuristic, not a hard gate and not a time/cost estimate. Gate⓪ still mechanically requires a non-empty checkbox AC set and a verification section. |
| `po.enabled` | `true` | #127: switch the `aligning` phase's PO **align/triage sessions** (goal-alignment decomposition + the round-start plan-triage pass) off for this deployment. **#233: this no longer affects round-pool selection at all** — that is governed solely by `po.poolSelection` below, independently. `false` → the align/triage session is skipped; `round-defaults.ts`'s `createDefaultPeripherals` OMITS just that portion, never the whole `aligning` phase (round-pool selection still runs). **Warning:** with the PO off, plan-less issues are never triaged into the gate⓪ pipeline (no plan drafting, no decomposition) — they must arrive with a verification plan already in the body, or a human/external process must draft one, before gate⓪ can ever approve them. **#232 (triage write-ahead + concurrent-edit guard):** once a triage session's draft validates, the engine durably records the ACCEPTED decision (`triage-decision-accepted`, keyed by round + issue + the SAME `phase`/`role`/`session`/`attempt` identity as that dispatch's own `input_manifest` rows above) *before* writing anything to GitHub — a crash-rerun that finds this record resumes the body write/comment directly, never a second session. Recovery is BY ISSUE NUMBER from this durable record, not by re-querying "issues that still need triage": an issue whose body write already landed no longer matches that query (it now has a plan section), so a decision stuck between "accepted" and "fully receipted" is found via the journal even when the ordinary candidate scan would no longer surface it. The write itself is guarded: immediately before writing, the engine re-reads the issue's LIVE body and compares its hash to the one the session actually read; a mismatch (a human — or another process — edited the issue while the session ran) REFUSES the write, keeps the old body, and records a durable `triage-stale-hash-skipped` event instead of silently overwriting the concurrent edit — human amendment wins, and the candidate is retried next round from a fresh read. Every receipt (body-committed, comment-posted, effects-committed) is scoped to its decision's own `attempt` number, so a stale receipt left behind by a superseded or unreadable prior attempt can never be mistaken for the current one's — the guarded write and the audit comment are each genuinely re-issued only when their OWN attempt's receipt is missing, never skipped on someone else's. A failed `triage-decision-accepted` append is itself load-bearing/fail-closed the same way as the pool-selected write below: no forge write happens for that issue this pass, and a `triage-decision-lost` honesty event + `tick-error` are recorded instead. |
| `po.poolSelection` | `false` | #233: switch the round-pool **selection session** on, independently of `po.enabled` above. Default `false` → the round pool is the deterministic top-cap candidate set every round (`round.poolFactor` above) — the MAIN path, not a fallback; no session spawned; the `pool-selected` event write is still attempted (**load-bearing/fail-closed, #232** — see `round.poolFactor` above) and labels reconciled to match, unless that write fails. `true` → restores the #212 session behavior unchanged: a dedicated PO session (`po.poolPromptFile`) picks a validated subset of the candidate digest, invalid/failed-twice degrades OPEN to the full candidate set (never an empty pool). **Why the default flipped:** controlled experiments across model tiers found this session — at the time, title/number-only — selects EVERY candidate at every tier — it had no evidentiary basis to narrow the reservoir from a bare digest, so it just paid for a session to reproduce the deterministic fallback it would otherwise degrade to. Worse, `round.poolFactor` exists specifically to *over*-select and absorb architect/gate⓪ attrition after selection; a session that actually narrows the reservoir risks underfilling the round. The one non-trivial selection ever observed traced back to contaminated test context, not a real judgment made from candidate titles/numbers alone. **The opt-in session's digest no longer stops at title/number** — each candidate now carries its FULL body (see `po.backlogDigestMaxChars` above). That finding was never re-run against the body-bearing digest, so it remains the reason the default stays `false`, not a description of what today's opt-in session actually sees. **Benchmark note:** if you re-run this experiment, isolate worktree/code reads for that evaluation — production `po-pool` sessions may read the repo like any other role session, but that access is an uncontrolled signal specifically for this experiment (this session's intended input is each candidate's title/number/labels/body, not a repo read). |
| `architect.enabled` | `true` | #127: switch the `architecting` phase off, same mechanism as `po.enabled` above. |
| `verificationPlanReviewer.enabled` | `true` | #127: switch the WHOLE gate⓪ unit off — the verification-plan-reviewer AND its verification-plan-drafter, which rides along (the drafter has no toggle of its own; it only ever runs from inside the `plan_review` phase). Same omit-the-stub mechanism as `po.enabled` above. **Warning — this can starve dispatch entirely:** the dispatchability gate (deliberately, PLAN Decision #8) still requires every issue without `labels.verifyNa` to carry `labels.planApproved`, and the verification-plan-reviewer is the only thing in the engine that applies it. With gate⓪ off, a human or external process MUST apply `labels.planApproved` (or `labels.verifyNa`) to each issue — otherwise nothing is ever dispatched. The engine repeats this warning in the startup log when the role is disabled. |
| `harvest.enabled` | `true` | #127: switch the `harvesting` phase off, same mechanism as `po.enabled` above. |
| `retro.enabled` | `true` | #127: switch the `retro` phase off, same mechanism as `po.enabled` above. |

Every `enabled: false` above is logged **once**, at the point `createDefaultPeripherals`
builds the peripherals map (engine startup) — never re-logged per round or per tick.

## `proxy`

**#234: engine-hosted, read-only forge MCP proxy for role sessions** (supersedes #217's
two-pass `needsDetails` protocol, adjudicated 2026-07-17: a mediation system that denies
an information request and still demands a definitive judgment is a shackle — explicit
denial with first-class abstention is a guardrail). Credentials never leave the engine
process: a role session gets a fixed, strictly-schema-validated tool algebra —
`issue_details`, `issue_comments`, `issue_relations`, `search_issues` (#234), plus
`pr_details`, `pr_reviews`, `pr_review_threads`, `pr_checks`, `pr_audit_comments` (#244,
the same raw-data contract, extended to PR review data — no gate/verdict logic in any
tool; that stays in `reviewer.ts`/`merge-driver.ts`) — served over a minimal hand-rolled
streamable-HTTP MCP server bound to `127.0.0.1` on an ephemeral port, authenticated by a
random bearer token minted per session and revoked at teardown — never a file on disk,
never an environment variable (the #218 credential-free spawn env is unaffected). Every
call is journaled write-ahead (persist intent → fetch+cap → persist canonical
response+hash → deliver) before the session ever sees a result, metered against a
per-session call/byte budget, and — once accepted — bundled content-addressed as frozen
evidence for later audit/replay. A session's role scopes it to a fixed subset of this
algebra (deny-by-default for an unrecognized role) — see
[`security.md`](security.md#the-forge-mcp-proxys-role-x-tool-matrix-234-244)'s
role x tool matrix table.

**Ships ON by default — a two-state model (#551, deleting the earlier three-state
`shadow` design, #253).** Engine startup (`cli.ts`'s `runTickEngine`/`runRoundsEngine`,
`round.ts`'s `buildFixLegResume`) reads `enabled` to decide production attachment:

1. **`enabled: true`** (default since #551) — both live drivers attach a real handle to
   the fix-loop worker leg, and every peripheral role session gets one too
   (`peripheral.ts`'s `RoleRunner` `defaultProxy`, applied whenever a session's own
   `RoleSessionOpts.proxy` is omitted — which every shipped stub does today).
2. **`enabled: false`** (explicit opt-out) — fully inert, no proxy server is ever
   constructed anywhere, and no other `proxy.*` key changes any runtime behavior. Review
   sessions never get a handle regardless of `enabled`: `peripheral.ts` throws if a
   caller supplies `proxy` together with `reviewCwd`, forces `proxyOpt = undefined` in
   review mode, and both drivers construct their engine-review `RoleRunner`s without
   `defaultProxy` — the default flip does not widen a review session's grant.

`peripheral.ts`'s `RoleRunner` and `worker.ts`'s `WorkerSupervisor` (#244 extended the
mechanism to worker legs' `dispatch()`, mirroring `RoleRunner`'s own `proxy` opt; #245
extended the same mechanism to `resume()` too — see
[`security.md`](security.md#fix-loop-fixing-lane-state-245) for the fix-loop consumer
this exists for) are the two attachment points; a caller-supplied `proxy` opt always
wins over the RoleRunner-wide default, never silently overridden.

**State 2 (`enabled: false`) announces itself** when [`lanes.prFixCap`](#lanes) is above
`0` ([#385](https://github.com/herehigher/sapwood/issues/385)): one `[sapwood:startup]`
log line naming the opt-out plus one durable `fix-loop-unattached` event, emitted once
per run by both drivers — so "the fix loop I configured degrades to needs-human" is
visible at startup, not first observed on an already-escalated PR. State 1 (the default)
and `prFixCap: 0` are silent.

**What `enabled: true` (the default) actually costs.** Every peripheral role session
(`po-pool`/`po-align`/`po-triage`/`harvest`/`architect`/`verification-plan-reviewer`/`verification-plan-drafter`/
`verification-plan-reviewer-confirm`/`retro`, `proxy/access.ts`'s `ISSUE_TOOLS` role scope) carries
4 extra tool schemas (`issue_details`, `issue_comments`, `issue_relations`,
`search_issues`) in its context on every round it runs, whether or not it ever calls
one — the fix-loop worker leg's own scope (`PR_TOOLS`) is 5 tools
(`pr_details`/`pr_reviews`/`pr_review_threads`/`pr_checks`/`pr_audit_comments`). Each
attached session also spins up one ephemeral `127.0.0.1` HTTP listener authenticated by
a bearer token minted fresh for that session and revoked at teardown — never written to
disk or an environment variable, but a real local process resource for the session's
lifetime. Set `enabled: false` to avoid both costs; that reintroduces the needs-human
degradation documented above for any lane whose `prFixCap` is above `0`.

**What `enabled: false` does to the role prompts (#559, ruling 2026-08-03).** Role prompts are
static files with no template variable for proxy state — one file serves both settings, and by
this ruling it stays that way rather than gaining a substitution point. What the opt-out costs is
therefore a documented, bounded degradation, not a silent one: every prompt that names an
`mcp__forge__` tool states the tools' presence as conditional, and the two roles with a real
lookup STEP (`po-align`'s proposal dedup, `architect`'s cross-issue search) carry an explicit
not-attached branch — judge from the substituted context, and say so instead of writing as if you
had searched. So under `enabled: false` those two roles simply do less: `po-align` dedups against
the (bounded, truncatable) backlog digest alone, `architect` judges candidates without the
outside-the-pool search, and both are expected to disclose the gap in their own output. Nothing
fails, no session is left holding an instruction it cannot follow, and no other role loses a step
it had. The invariant is test-enforced (`prompts.test.ts`'s `#559` check), and the authoring rule
behind it is in [`role-paradigm.md`](role-paradigm.md#cross-cutting-notes) — the phrasing is
load-bearing, since [#529](https://github.com/herehigher/sapwood/issues/529)'s live 2×2 measured
that a permissive "you may use one if it helps" capability paragraph produces zero calls even when
the tools ARE attached.

**Still unwired regardless of `enabled`:** ordinary (non-fix-loop) `WorkerSupervisor.
dispatch()` for the main coding-worker leg has no production caller attaching a proxy —
that would require touching `conductor.ts`'s DISPATCH call site, out of #253's/#551's
own scope.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` (#551; was `false`) | Master switch — off means the proxy is fully inert; nothing is ever constructed. On (the default) attaches a real handle to the fix-loop worker leg and every peripheral role session; review sessions are exempt regardless (see above). **Off also degrades two peripheral roles (#559):** `po-align` dedups new proposals against the bounded backlog digest alone and `architect` skips its cross-issue search, each disclosing the gap in its own output — the role prompts are static, so they name the lookup as conditional and carry a not-attached branch rather than instructing a step the session cannot perform (see above; any lane with [`prFixCap`](#lanes) above `0` additionally folds to `needs-human`). |
| `caps.maxIssuesPerCall` | `10` | `issue_details`: max issue numbers per call. A caller-requested batch above this cap is **rejected** (typed error), never silently truncated. |
| `caps.defaultCommentsPerIssue` | `20` | `issue_details`' default view: how many of an issue's **most recent** comments to include (fail-toward-inclusion — the newest comments are the ones most likely to carry an amendment to a stale body). Bounded, not rejected: `comments_complete`/counts/an omitted-range name the cut. |
| `caps.maxCommentsPerCall` | `100` | `issue_comments`: max `lastN` a caller may request explicitly. Also the default view's cap when `fullCommentStreamOptIn` is true. |
| `caps.maxRelationsPerIssue` | `20` (max `100`) | `issue_relations`: cap on each of linked-PRs and cross-references (GraphQL `first: cap` on each connection independently — capped at 100 since that's fed straight into a GraphQL connection argument, which GitHub itself rejects above 100). |
| `caps.maxSearchResults` | `20` | `search_issues`: max matches returned. |
| `caps.fullCommentStreamOptIn` | `false` | `true` widens `issue_details`' default comment cap to `maxCommentsPerCall` instead of `defaultCommentsPerIssue` — still bounded, never truly unbounded. |
| `caps.maxReviewThreadsPerCall` | `20` | `pr_review_threads` (#244): max `lastN` threads a caller may request explicitly (or the default cap when omitted). Same reject-not-truncate contract as `maxCommentsPerCall`. |
| `caps.maxCommentsPerThread` | `20` (max `100`) | `pr_review_threads` (#244): cap on each thread's OWN comment count (GraphQL `comments(first: ...)`), independent of `maxReviewThreadsPerCall`'s bound on the number of threads. |
| `caps.maxReviewsPerCall` | `50` (max `100`) | `pr_reviews` (#244): fetch bound — GraphQL `reviews(last: cap)`. No client-supplied lastN exists for this tool, so this cap alone determines completeness (`complete: reviews.length >= total`), never an over-cap rejection. |
| `caps.maxChecksPerCall` | `50` (max `100`) | `pr_checks` (#244): fetch bound — GraphQL `contexts(first: cap)`. Same no-lastN/completeness-not-rejection stance as `maxReviewsPerCall`. |
| `budget.maxCallsPerSession` | `30` | Hard ceiling on tool calls per session attempt, metered from the journal itself (no separate counter). Exhaustion returns an explicit `budget_exhausted` tool result, never a transport error — a session can still emit `unresolvedContext` and abstain. |
| `budget.maxBytesPerSession` | `2000000` | Same, for cumulative response bytes. |
| `timeoutMs` | `30000` | Hard per-call ceiling — a hung upstream `gh` read must never wedge a session waiting on the proxy forever. Independent of `worker.timeoutSec`, which bounds the whole session. |

## `webAccess`

**#410: the built-in `WebSearch`/`WebFetch` grant** — `architect`, `po-align`, and `po-triage`
only, no other role. Ships **enabled by default**: the capability is read-only, carries no
credential into any project system, is strictly weaker than the worker's own unrestricted Bash
egress (see [`security.md`](security.md#worker-network-egress-accepted-blind-spot)), and every
call is journalled through the same `egress-suspect` ledger event the worker's own tripwire
uses (see [`security.md`](security.md#peripheral-network-egress-websearchwebfetch-detected-not-pinned-410)).
The review family (`verification-plan-reviewer`, `verification-plan-drafter`, `verification-plan-reviewer-confirm`, and every gate②
reviewer session) never reads this key at all — refusal is structural, not a `false` this key
could be set to.

The grant is **not** paired with settings pinning — see `security.md`'s peripheral-egress section
(linked above) for why an earlier pinned version was rejected (it also silently sealed the
target repo's own `CLAUDE.md`) and replaced with `cli.ts`'s lightweight `checkWebAccessSettingsDenial`
startup check: an operator's user-level `permissions.deny` for `WebSearch`/`WebFetch` CAN still
silently strip the grant from a session (zero permission-denial signal) — this check only
*detects and reports* that (one warning log line + one `web-access-denied-by-operator-settings`
state event), it never blocks startup or restores the capability.

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Grants `WebSearch`/`WebFetch` to `architect`/`po-align`/`po-triage`. `false` falls all three back to the base read-only (`Read`/`Grep`/`Glob`) allow-list — no config value ever reaches the review family either way. |

## `guard`

| Key | Default | Meaning |
|---|---|---|
| `mode` | `hard` | `hard`: fail-closed deny — the actual producer≠merger/boundary-write enforcement. `soft`: observe-only — log what would be blocked, but allow it. `soft` is a first-run/dogfood affordance only, never the shipped default; it reaches the hook via a spawn env a worker cannot itself rewrite. |

## `envFailure`

Environment-failure park (#168) — detect an LLM-provider or forge outage as ONE class distinct
from an ordinary task failure, park the engine (no new dispatch) instead of escalating the
issue or spending a gated-reentry attempt, self-heal via a bounded backoff probe, and — only
past a configurable park *duration* — additionally notify a human. Episodes are tracked **per
source** (an `llm` episode and a `forge` episode can be open simultaneously — a mixed storm);
dispatch resumes only when *every* open episode has cleared. See
[`troubleshooting.md`](troubleshooting.md#environment-failure-park-168) for what a parked engine
looks like and what to do about it.

Pattern matching is deterministic (a case-insensitive regex match against a FAILED lane's own
**structured error output** — the process's stderr lines plus errored stream-json result/error
records, never assistant message content, so a worker legitimately *working on* rate-limit
handling whose messages print the exact signature strings stays an ordinary task failure) —
never an LLM judgment call. Every pattern is compiled at config load: a malformed regex, an
empty pattern array, or a backoff cap below the base is a fail-fast startup error (`sapwood
validate` catches all three).

| Key | Default | Meaning |
|---|---|---|
| `llmPatterns` | see `sapwood.config.yaml` | Regex patterns (case-insensitive, compiled/validated at load, non-empty) matched against a FAILED lane's structured error output to classify it as an LLM-provider environment failure — `rate_limit_error`, `usage limit reached`, `credit balance is too low`, `insufficient_quota`, `overloaded_error`, `429 too many requests`, `hit your (?:session\|weekly\|5-hour) limit` (the Claude CLI's own plan-quota-exhaustion message family, #394 — deliberately an ENUMERATED tier alternation, not a wildcard: a wildcard would also match an unrelated "hit your \<X\> limit" line from some other component and false-park a healthy engine), etc. This is the THIRD, last-resort line of defense: two structured, text-free, provider-authoritative signals are checked BEFORE any text pattern — a rejected `rate_limit_event` in the session transcript, and (gate② round 3, #394) an errored `result` record carrying `api_error_status:429`, since a real captured transcript shows the CLI does not always emit both together for the same quota failure. The residual gap (neither structured signal present AND no listed tier word matches) is genuinely narrow, not zero — this text list is not a universal catch-all for unknown wording. |
| `forgePatterns` | see `sapwood.config.yaml` | Same matching, for a forge (GitHub) environment failure — `could not resolve host`, `connection refused`, `network is unreachable`, `bad gateway`/`gateway timeout`/`service unavailable`, `bad credentials`, `401 unauthorized`, `gh auth login`, etc. |
| `parkEscalateAfterSec` | `3600` (1h) | Park **duration** per episode (not probe count — bounded exponential backoff makes a count an ambiguous measure of elapsed time) past which the engine additionally notifies a human via the channel ladder. Additive, never a state transition — probing/auto-resume continue unaffected either side of an escalation. The clock runs from the episode's FIRST detection and is never reset by further failures (including failed recovery canaries) within the same episode. |
| `probeBackoffBaseSec` | `30` | Initial probe interval while parked (the first probe waits a full base interval — never fires on the same tick the park began). |
| `probeBackoffMaxSec` | `1800` (30min) | Cap on the bounded exponential backoff (`base * 2^attempts`, capped here). Must be >= `probeBackoffBaseSec` (validated at load). |
| `probeModel` | `haiku` | The model the llm-source **ping probe** runs on — deliberately the cheapest tier, independent of `worker.model`. Point it at whatever your account's cheapest alias is. |
| `probeTimeoutSec` | `30` | Hard timeout on one ping — a hung CLI is killed and counted as a failed probe, never allowed to wedge a tick. |
| `probeMaxBudgetUsd` | `0.05` | `--max-budget-usd` for one ping. **Don't set this below ~$0.02**: even fully stripped, a `-p` invocation still carries ~7.4k CLI scaffolding tokens, so the real floor is >$0.01 (~$0.016 measured) — a too-low cap makes **every** probe fail with `Error: Exceeded USD budget (…)` and the engine stays parked until the duration escalation notifies a human (fail-safe, but confusing). The failing probe's error line is recorded in each `park-probe` event so the symptom names itself. |

**How each source recovers:**

- **`forge`** — the probe is an existing lightweight read-only `IForge` call; its success is a
  genuine recovery signal and clears the forge episode outright. While a forge episode is open,
  env-failure issue-requeues are **suspended** (persisted durably, zero forge writes, retry
  counter frozen) and drain automatically on resume; they are exempt from the rollback retry cap
  and never degrade to `needs-human`. Dispatch resumes on the tick **after** the recovery
  probe, not the recovery tick itself — that ordering lets the outage victim's held requeue
  drain (rollback retry runs at the top of a tick, before dispatch) so other Ready issues can't
  race it into the freed lanes.
- **`llm`** — the probe is a **minimal inference ping** (same `CLAUDE_BIN` resolution as a real
  dispatch):

  ```
  claude -p --model <probeModel> --no-session-persistence \
    --system-prompt "You are a heartbeat responder. Only output the requested word." \
    --strict-mcp-config --tools "" \
    --max-budget-usd <probeMaxBudgetUsd> --output-format text \
    "Respond with the single word 'pong' and nothing else."
  ```

  Success = clean exit + a reply that is exactly `pong` (case/whitespace-normalized equality —
  a refusal *containing* the word never counts). The custom system prompt replaces the CLI's
  default one and `--strict-mcp-config`/`--tools ""` strip MCP servers and tool schemas — the
  smallest request the CLI supports; `--no-session-persistence` keeps probe runs off the disk.
  **Honest cost:** ~$0.016 per ping measured (the CLI still sends ~7.4k scaffolding tokens plus
  ~240 output tokens even fully stripped) — at `probeBackoffMaxSec` pacing that is still
  negligible per day. Because the ping is *paid*, it is suppressed while a hard cost/wall-clock
  ceiling breach is active (a spend-safety boundary must not itself keep spending) and while
  dispatch is paused (`data/PAUSE` blocks the canary the ping exists to unlock) — the free
  forge probe keeps running in both states, and duration escalation is unaffected. A canary
  stopped by a **drain** (kill switch / ceiling) is settled *inconclusive*: the canary slot is
  released and the episode continues unchanged — a drain says nothing about the provider, so
  it neither clears the episode nor grows the backoff; the next backoff step simply pings
  again. The ping proves network + auth + *some* account capacity on the cheapest model —
  but **not** that the worker's own model/tier has quota (model-specific caps,
  primary-model-only overload), so a green ping is only a *gate*, never a recovery signal.
  When the backoff interval elapses and the ping succeeds (and **no other park of any source is
  open** — forge, rapid-restart, or any future park source: a green LLM light may bypass only
  the LLM's own episode, #431), the
  engine dispatches exactly **one canary lane**. The llm episode clears only when that canary
  reaches a terminal state that is *not* itself env-classified; a canary that env-fails
  continues the *same* episode — the entry time (and therefore the escalation clock) is
  preserved and the backoff keeps growing, so a persistent outage costs one ping + one canary
  per backoff step, never a full-queue redispatch cycle. A broken CLI needs no separate check:
  the ping simply fails — and an **older CLI lacking these flags** fails every probe with
  `error: unknown option …` (the symptom is a permanently parked engine whose `park-probe`
  events name the unknown option; the remedy is upgrading the CLI — these flags exist as of
  2.x). Every failed ping records its first error line in the `park-probe` event, so
  "provider still down" (a 429), "budget cap too low" (`Exceeded USD budget`), and "CLI too
  old" (`unknown option`) are all distinguishable from the event ledger.

**Escalation channel ladder:** an `llm`-sourced escalation with the forge healthy notifies via a
comment on the issue whose lane triggered the episode; a `forge`-sourced escalation — or an
`llm`-sourced one during a mixed storm whose forge episode is also open — never attempts a
GitHub write at all: it falls back to `sapwood status`, a local `ESCALATION` file in the
engine's data dir (written by the engine, read-only informational output, never a control input
— unlike `KILL_SWITCH`/`PAUSE`; removed automatically once the outage resolves), and a log
line. The escalation event records the channel *actually* used, including a comment attempt
that failed and degraded to local.

## `escalation`

| Key | Default | Meaning |
|---|---|---|
| `humanLabels` | `[sapwood:needs-human, sapwood:blocked]` | When omitted, derives from `labels.prefix`. Any matching label means "stop autonomy, ask a human" — read on the **issue** by dispatch (`orderForDispatch`), the standby probe and the pool-consumability check, on the **PR** by the merge gate (`deriveGate`), and by the #147 gated-reentry handshake on whichever of the two that lane's own escalation was written on (#398: "the label lives where the escalation was born"). An explicit array is used verbatim and must list `labels.needsHuman` case-insensitively so PR and issue holds recognize the same escalation label. **The PR-side read is a human control, not just an engine one (#399).** `deriveGate` matches this whole array — by substring, case-insensitively — against the PR's own labels *before* any review or CI signal is consulted, and returns `HUMAN`: no merge, no fix-leg dispatch, no `#170` review-silence escalation. So applying `sapwood:blocked` (or any other entry) **to a PR by hand is a veto** on that PR, and removing it is the [#147](https://github.com/herehigher/sapwood/issues/147) gated-reentry go-ahead. This was working, undocumented behavior before #399 documented it. Two things distinguish it from the `hold` tier: a veto **releases** the lane rather than holding its slot, and `needs-human` is engine-written too, so its presence does not tell you a human put it there — pick `blocked` when what you mean is "an external wait nobody owes a decision on", `hold` when you mean "I am looking at this right now" (see `holdLabels` below). |
| `holdLabels` | `[sapwood:hold]` | (#248) The **human-applied WAIT-tier hold** — distinct from `humanLabels`' engine-written ESCALATE tier (three-tier escalation model: `hold`/`needs-human`/`blocked`, each one fact, one bit). When omitted, derives from `labels.prefix`; `sapwood init` provisions the repo-level label definition for the resolved value(s) (review round 1, G2 — the label otherwise doesn't exist for a human to pick from the PR UI). Entries are trimmed and must be non-empty, and are matched everywhere by **exact case-insensitive identity** (review round 1, G3) — never substring, unlike `humanLabels`'s historical matching — so a short/generic entry can never hold more than configured. **One carrier: the PR** (#400). The label is provisioned with exactly this description, which is the whole contract: `A human is reviewing this PR — automation pauses; remove to resume. No effect on issues.` It is checked in the PR gate (`deriveGate`, `merge-driver.ts`) BEFORE any review signal and before the `FIXABLE` gate — while a matching label sits on the PR, there is no merge, no new fix-leg dispatch, and the `#170` review-silence escalation is suppressed — the lane stays `driving`/`fixing`, holding its slot; an in-flight fix leg a prior tick already dispatched is never interrupted (hold gates only the NEXT drive decision). A simultaneous `humanLabels` entry always wins (fail-safe: escalation semantics, never silently masked by a hold). Applying this label to an **issue** does nothing at all — no engine code reads a hold from an issue (#400 deleted the second carrier `#248` review round 1 had added to `#147`'s GATED RECLAIM phase); to pause an escalated lane, leave `needs-human`/`blocked` in place, since removing it *is* the go-ahead signal. **Write-side asymmetry is the audit trail:** the engine never writes a hold label — only `needsHuman`/`blocked` are ever engine-applied; a human applies and removes `hold` themselves (a future dashboard "I'm reviewing" control is just a remote hand on the same label). Must be a value distinct from every other protected label (`needsHuman`, `blocked`, `roundPool`, …) — config load rejects the collision, same guard `labels.roundPool` uses. See `docs/PLAN.md`'s escalation-model section for the full handshake protocol and its one documented, accepted tick-scale race window. |
| `instructionPaths` | `[CLAUDE.md, CLAUDE.local.md, .claude/CLAUDE.md, .claude/rules/**, AGENTS.md, engine/prompts/**]` | (#292) Canonical repo-root-relative reviewer-instruction paths. Before either classic or engine-agent review work begins, sapwood fetches the PR's rename-aware changed-file list; an old **or** new path matching this list applies `labels.humanMergeOnly` (#397) and posts one explanatory comment. (#527, #549) The reviewer's own instruction carriers are covered on top of this list, DERIVED in their repo-relative form rather than listed literally, so a repointed path stays covered: `doctrine.file` and `reviewer.agent.promptFile` (each captured pre-resolution as `doctrine.fileRaw` / `reviewer.agent.promptFileRaw` by `loadConfig`; a derived path pointing outside the repo is skipped, and nothing is derived when this list is empty). `engine/prompts/**` covers the shipped reviewer prompt and is inert unless the target repo is the engine's own source tree. A list at GitHub's 3,000-file API ceiling is potentially incomplete and escalates to human review without attempting to prove it safe. The exact human-merge-only PR label is the idempotence latch, so repeated ticks never repeat the writes or fetch files again. Matching is case-insensitive because instruction files are consumed on case-insensitive macOS/Windows checkouts; supported glob subset: `*` within one path segment and `**` across zero or more segments. Entries must be non-empty and already trimmed, must not start with `./` or `/`, contain a `..` path segment or `//`, or end with `/`. Set to `[]` to deliberately disable this mechanism; disabled runs do not fetch changed files. This is merge-gate escalation only—workers may legitimately edit instruction files. |

## `notify`

| Key | Default | Meaning |
|---|---|---|
| `mentions` | `[board.owner]` | (#237) Who a PO-dissent concern comment `@`-mentions. A PO/triage session may raise a structured objection (`concerns: [{issue, reason}]`) alongside its normal deliverable; the engine posts it as an idempotent issue comment (never a label, status change, or dispatch effect) `@`-mentioning every entry here. When omitted, derives to the repo owner (`board.owner`). An explicit array is used verbatim, in the given order; entries are `@`-prefixed at render time if not already. |

## `coverage`

| Key | Default | Meaning |
|---|---|---|
| `minPercent` | `0` | **Accepted, not yet wired** — no coverage gate is enforced from it yet; setting it does not add a merge check. |

## `optimize`

| Key | Default | Meaning |
|---|---|---|
| `recur` | `false` | **Accepted, not yet wired** — the recurring optimization round doesn't exist yet. |

## `milestones`

| Key | Default | Meaning |
|---|---|---|
| `milestones` | `[]` | Milestones `sapwood init` ensures exist (idempotent, detect-before-create). Empty = create none — the loop only needs labels and board lanes; milestones are your organizational choice. |

## See also

- [`security.md`](security.md) — why these ceilings and gates exist and what they
  actually guarantee.
- [`troubleshooting.md`](troubleshooting.md) — what a config validation error looks
  like and how to fix it.
