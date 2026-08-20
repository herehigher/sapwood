# 05 — Core modules

This is the code-level map. Follow [Security](../security.md), [Role paradigm](../role-paradigm.md), and `docs/PLAN.md` for rationale and policy rather than duplicating them here.

## Conductor & tick loop (`loop/conductor.ts`, `loop/driver.ts`)

`tick()` (`engine/src/loop/conductor.ts`) is the single scheduling beat. Its ordered phases handle an active ceiling/kill-switch drain, pending durable writes, environment-failure park/probe, gated PR re-entry, worker reclaim, merge driving, handoff resume, and finally new dispatch. `classifyLane()` (`engine/src/loop/conductor.ts`) combines terminal sentinels, heartbeat age, wrapper liveness, and dispatch age; pure helpers also own priority, blocker, lane-allocation, re-entry, resume, ceiling, and dispatch-order decisions.

Running workers occupy `running`; completed workers with a PR become `driving`; bounded review/CI rework uses `fixing`; graceful budget exits use `handoff`. Dead/no-PR paths requeue through a durable rollback, while PR-backed lanes remain held for the gate or human action. `runDriver()` in `engine/src/loop/driver.ts` repeatedly calls `tick()` for the explicit tick driver, handles cadence/signals, and implements once/until-idle and goal-based wind-down.

The kill switch freezes dispatch and merges, requests graceful handoff, then permits a process-tree kill after `cost.drainWindowSec`. Daily-spend and wall-clock ceilings use the same bounded drain machinery. Change lane classification or tick phase order in `conductor.ts`; change cadence/flat-driver stop behavior in `driver.ts`.

## Rounds (`loop/round.ts`, `loop/align.ts`, `loop/init.ts`, `loop/round-artifact.ts`)

`runRounds()` (`engine/src/loop/round.ts`) layers the durable round state machine over the unchanged tick engine. The persisted phases are `aligning → architecting → plan_review → executing → harvesting → retro → closed` (`RoundPhase` in `engine/src/state/state.ts`). On startup it opens or resumes the current phase, reruns that phase as a fresh idempotent attempt, drains the executing batch, and closes only after post-execution roles and artifact persistence.

`RoundScopedForge` (`engine/src/loop/round.ts`) limits eligible work to a configured milestone; `PoolScopedForge` (`engine/src/loop/round.ts`) limits execution to the selected round-pool label. `engine/src/loop/align.ts` assembles bounded goal/backlog inputs, performs plan triage and pool selection, records input manifests, and reconciles pool labels. `engine/src/loop/init.ts` performs authentication preflight and idempotently provisions config, labels, milestones, board lanes, goal, and doctrine files.

`engine/src/loop/round-artifact.ts` builds a schema-validated summary from event/spend ID cursors; `persistRoundArtifact()` (`engine/src/loop/round-artifact.ts`) stores canonical JSON before deriving `data/rounds/round-N.md`. Harvest consumes that artifact through `engine/src/loop/harvest.ts`. Change phase sequencing/scoping in `round.ts`, alignment/pool policy in `align.ts`, provisioning in `init.ts`, and summary shape/rendering in `round-artifact.ts`.

## Worker lane (`roles/worker.ts`, `roles/context-manifest.ts`)

`WorkerSupervisor` (`engine/src/roles/worker.ts`) is the module that launches producer worker sessions (peripheral role sessions are launched separately by `RoleRunner` in `peripheral.ts`). It assigns a fresh lane/session, creates a git worktree, supplies inline guard and optional MCP settings, streams JSONL under `data/sessions/state/`, writes heartbeat and atomic `.running`/`.done`/`.failed`/`.handoff` evidence, and kills the detached process group only for hard timeout/drain escalation. The wrapper, not the model, writes terminal sentinels; workers do not receive `data/` through `--add-dir`.

A lane is matched to its pull request structurally, never by prose. `probe()` reads the lane worktree's own git `HEAD` (plain file reads — the engine never runs git inside a worker worktree) and asks the forge for the open PR on that branch. **Opening the PR is the engine's ordinary job, not a rescue for a worker that failed to (#351, #605):** the worker's own job ends at push. Once the lane's session is over — a terminal sentinel, or a confirmed-dead wrapper, so a lane that pushed and then crashed is covered too — the engine opens the PR itself, authoring a body that carries `Closes #N` plus a machine-readable owner marker (`<!-- sapwood:pr-owner lane="…" issue="…" -->`, `forge.ts::associateLanePr`). A worker session still holds a `gh` grant and can open its own PR anyway (until #606 removes it); when it does, the engine adopts that PR by stamping the same marker onto it rather than opening a second one — the same idempotent outcome either way. Every engine-authored write waits for the session-over moment: opening a PR before then would race a worker that has chosen to open its own, and stamping one before then is an unconditional read-modify-write that would drop a description edit made in between (GitHub has no conditional PR-body update). Reads are never gated — a PR already carrying this lane's marker associates at any time. Association reads the marker only, so a PR that merely mentions the issue number in its description is never adopted, a PR whose markers disagree is treated as contested rather than unmarked, a branch carrying more than one open PR is refused outright (the engine stamps only a branch's sole, marker-free PR), and a lane whose PR cannot be identified escalates to a human instead of driving a guessed merge target. The branch itself is checked against the engine's own lane sentinels before it is trusted: a worker may `git checkout` its way onto a branch it never produced, so a branch two lanes are both sitting on is refused for both of them rather than guessed between. That closes lane-vs-lane capture; a worker checking out an unrelated branch no lane owns can still have that branch's sole unmarked PR adopted, which would need a trusted record of what the lane itself pushed to close, and does not exist today. `Fixes #N` keeps its ordinary GitHub meaning in the human-facing description — the marker does not replace it.

A forge *write* failure during that association (a 502 on `gh pr create`, a 403 on the marker stamp) is reported as **unknown**, never as "this lane has no PR": the engine only ever opens a lane's missing PR on the same probe the conductor settles the lane from, so collapsing a transient failure into a definitive answer would escalate finished work to a human, or requeue a dead lane onto a fresh worker racing its own pushed branch, with no later probe to correct either. The reclaim loops hold such a lane and retry on the next tick, bounded by `MAX_INCONCLUSIVE_PR_PROBES` so a permanently failing write (`No commits between main and <branch>`) settles by the ordinary no-PR rules instead of pinning a lane slot. The two drain paths — kill switch and cost/wall-clock ceiling — deliberately skip the deferral: a drain exists to settle lanes and stop the engine, so a lane must never refuse to settle there.

Live token usage is estimated with `engine/src/config/pricing.ts`. Crossing `worker.budgetUsdSoft` requests graceful handoff: the session is asked to preserve WIP and exits through `.handoff`; it is never killed merely for crossing the soft budget. Resume reuses the lane, worktree, branch, and session lineage, with durable resume-intent markers and a configured cap.

`assembleContextManifest()` (`engine/src/roles/context-manifest.ts`) records the repo instructions, worktree revision/dirty state, guard identity, model/CLI/tool surface, and capture quality seen by a session attempt. Change process, worktree, prompt rendering, sentinel, or resume behavior in `worker.ts`; change ambient-context evidence shape in `context-manifest.ts`.

## Merge gate (`roles/merge-driver.ts`, `roles/reviewer.ts`)

`Reviewer` (`engine/src/roles/reviewer.ts`) is a read/comment-only adapter. Implementations derive a verdict from fresh PR review data for a specific current head and engine-recorded trigger pin. `makeReviewer()` and `makeFallbackReviewers()` construct the configured primary and ordered fallback chain; a fallback lock is advisory and is revalidated against live data.

`deriveGate()` (`engine/src/roles/merge-driver.ts`) combines open/draft state, exact hold labels, human/escalation labels, CI's green/red/pending distinction, and review action into `MERGE`, `WAIT`, `HUMAN`, or `FIXABLE`. `FIXABLE` sends the same producer lane through a bounded fix leg; `workers.fix_rounds` and `lanes.prFixCap` cap rework. `mergeDecision()` (`engine/src/roles/merge-driver.ts`) is a second, fresh fail-safe immediately before merge; unknown inputs escalate rather than merge. The decision tables are tested row-for-row in `engine/src/roles/merge-driver.test.ts`.

`MergeDriver` (`engine/src/roles/merge-driver.ts`) alone calls `forge.mergePR()`. It triggers review once per head, handles tri-state mergeability and unavailable review data, pins freshness, switches/reverts configured fallbacks, and returns structured outcomes to the conductor. `merge.mode: produce-pr-and-stop` never calls merge. Change verdict identity/freshness in `reviewer.ts`; change gate composition or merge execution in `merge-driver.ts`; change fix-leg admission/launch in `conductor.ts`.

## Peripheral roles (`roles/architect.ts`, `roles/plan-review.ts`, `roles/peripheral.ts`, `retro/`)

Each role follows the five-element contract in [Role paradigm](../role-paradigm.md): mandate, context, capabilities, output contract, and escalation path. `RoleRunner` (`engine/src/roles/peripheral.ts`) launches a worktree-confined headless session with credential stripping, guard wiring, timeout, JSONL/sentinels, optional proxy, context manifest capture, and cleanup. `runSessionWithRetry()` performs the bounded retry/degrade pattern.

Plan review validates approve/draft/verification-not-applicable decisions, retries drafting, and applies comments/body/labels through engine `IForge` calls (`createPlanReviewStub`, `engine/src/roles/plan-review.ts`). The architect reviews goal/backlog/pool consistency and emits validated per-candidate verdicts (`createArchitectStub`, `engine/src/roles/architect.ts`). Alignment/triage and harvest live in `engine/src/loop/align.ts` and `engine/src/loop/harvest.ts`. Retro receives an engine-built digest, may edit/commit/push only in its ephemeral worktree, and asks the engine to open a PR from a validated scratch result (`engine/src/retro/retro.ts`).

Role messages are parsed through `engine/src/state/structured-output.ts` and role-specific strict Zod schemas. Sessions propose; deterministic engine code validates targets and executes all issue/PR writes. Change a role's judgment in its prompt/schema module; change launch isolation in `peripheral.ts`; change forge side effects only in the engine apply path.

## Forge adapter (`forge/`)

`IForge` (`engine/src/forge/forge.ts`) is the engine-facing interface for board, issue, PR, review, branch, and proxy reads/writes. `GithubForge` (`engine/src/forge/forge.ts`) implements it over `gh`; every subprocess crosses `engine/src/forge/gh.ts`, which uses `execFile` with argv arrays and no shell. Parsing helpers in `forge.ts` are pure and unit-tested.

`engine/src/forge/labels.ts` owns the `sapwood:` namespace defaults, taxonomy, case-normalized equality, priority and blocker parsing, and the distinct exact/substring matching semantics. Engine-mediated writes keep LLM role sessions from holding independent forge mutation authority. Change the forge contract/GraphQL parsing in `forge.ts`, command execution in `gh.ts`, and label compatibility in `labels.ts`.

## Guard (`guard/`)

`guardDecision()` (`engine/src/guard/guard.ts`) is the fail-closed PreToolUse security decision. It blocks producer merge/approval/release operations, opaque shell constructs that cannot be safely analyzed, writes to protected boundary files, and session reads outside the engine-supplied worktree root. `engine/src/guard/guard-hook.ts` validates hook input, defaults mode to hard, and maps any malformed input or thrown decision to a denial.

`engine/src/roles/worker.ts` and `engine/src/roles/peripheral.ts` inject the compiled hook through inline Claude settings and refuse hard-mode startup if the artifact is missing. `guard.test.ts` is the bypass matrix; `guard.fuzz.test.ts` performs seeded differential fuzzing over a deterministic 1500-command corpus (`guard/fixtures/fuzz-corpus.ts`), asserted against a static table of `guard.py`'s shared-block verdicts (`guard/fixtures/guard-shared-block-verdicts.ts`) captured once and committed — no Python at test time (#840). Re-deriving that table from a deliberate future re-vendor of `guard.py` is a one-shot, documented script: `engine/scripts/regen-guard-shared-block-fixture.ts`. `guard.ts` itself is a security boundary: read [Security](../security.md) before changing it, and treat it as human-merge-only.

## Forge MCP proxy (`proxy/`)

The proxy is a local, per-session, read-only MCP server. `startForgeProxyServer()` (`engine/src/proxy/mcp-server.ts`) binds loopback on an ephemeral port, mints a bearer token, exposes a fixed issue/PR read algebra, enforces repo scope and caps server-side, and revokes the token on teardown. `createProxyMint()` (`engine/src/proxy/mint.ts`) scopes a server to a round/phase/session.

`PROXY_ROLE_TOOL_MATRIX` (`engine/src/proxy/access.ts`) gives issue tools to named peripheral roles, PR-review tools to fix workers, and nothing to unknown roles. `runJournaledCall()` in `engine/src/proxy/journal.ts` enforces intent → fetch/cap → canonical response/hash persist → delivery. Call/byte budgets are read from the durable journal, and evidence bundles are content-addressed. Change tool availability in `access.ts`, schemas/caps in `tools.ts`, transport/auth in `mcp-server.ts`, and audit ordering in `journal.ts`.

## State & structured output (`state/`)

`State` (`engine/src/state/state.ts`) is the direct `node:sqlite` API for worker/round state, event and spend ledgers, recovery queues, manifests, and proxy audit data. It is single-writer-oriented, WAL-backed, migrates writable databases transactionally, and offers a query-only status path. See [06 — Persistence](06-persistence.md) for the schema and write-order laws.

`engine/src/state/structured-output.ts` extracts exactly one sentinel-delimited result block and rejects malformed, duplicate, or trailing ambiguous output. Role modules then parse its JSON/body through their own Zod and content invariants before any engine write.

## Config & doctrine (`config/`)

`loadConfig()` in `engine/src/config/config.ts` parses YAML/JSON, applies strict Zod defaults/refinements, resolves file paths, rejects unknown keys/collisions, and returns `SapwoodConfig`. All operator-adjustable policy belongs in this schema and the commented starter `sapwood.config.example.yaml`, not as source constants.

`engine/src/config/doctrine.ts` loads and caps trusted review/escalation prose used in prompts; `directive.ts` ingests and archives one round directive; `pricing.ts` validates model rates/context windows for live estimates. Change a tunable by updating schema, defaults/sample, and `docs/configuration.md` together.

## CLI (`cli.ts`) & plugin commands

`runCli()` (`engine/src/cli.ts`) provides synchronous parsing/help/version/validate/status entry behavior; async wiring handles:

| Subcommand | Responsibility |
| --- | --- |
| `init` | Auth preflight and idempotent repository/board scaffolding. |
| `validate [path]` | Config, prompts, and pricing validation without running the loop. |
| `run` | Dry-run preview or configured rounds/tick driver. |
| `status [db-path]` | Query-only SQLite summary without a live engine. |

`commands/sapwood-run.md`, `commands/sapwood-status.md`, and `commands/sapwood-dashboard.md`
use the shared package wrapper; [09 — Plugin, commands & prompts](09-plugin-commands-prompts.md#slash-commands)
owns its resolution details. `commands/sapwood-stop.md` manages
`EMERGENCY_STOP`/`KILL_SWITCH`/`PAUSE`; it does not map to a CLI subcommand.
