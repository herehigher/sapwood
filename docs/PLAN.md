# sapwood — Project Goals & Plan (planning only)

## Context

`0day` (github.com/herehigher/0day) is a Polymarket quant system, but its most
reusable asset is the **autonomous development framework** it was built with: an
AI-led, GitHub-native, self-directed dev loop. Today that framework is ~4,700
lines of macOS-bash (~3,400 non-test) entangled with the trading domain, hard to
read, hard to maintain, and not packaged for anyone else to use.

**sapwood** extracts that framework, re-implements the engine in TypeScript, and
ships it as a **public, production-usable Claude Code plugin** so any repo can run
"GitHub issues in → reviewed PRs out" with a real governance layer.

This plan was pressure-tested by a four-lens review committee (architecture,
security, strategy, DX). Their central finding reshaped the direction: **the
product is the trust/governance layer, not a dashboard.** producer≠reviewer≠merger,
enforced by a fail-closed hook, is the thing no competitor (Sweep, OpenHands,
Copilot Workspace, Claude's own `/loop`) ships. We lead with that.

The trading domain stays behind in 0day. sapwood is the method, not the money.

## Positioning & vision

- **Headline:** "the autonomous coding loop with governance built in" — a
  fail-closed safety layer (producer≠reviewer≠merger) + GitHub as the source of
  truth + a configurable review chain. This is the durable differentiator;
  governance is opinionated, so it's the part Anthropic/GitHub are least likely to
  absorb (a real platform risk the committee flagged).
- **Target user (v1):** a solo dev or small-team lead who actively uses Claude
  Code, maintains a GitHub repo with a live issue backlog, and is comfortable with
  AI opening PRs. **Trust context = trusted repos first** (your own / your team's),
  where issue authors are trusted — matching 0day's proven context.
- **Long-term arc:** evolve into a **governance layer for AI-led development** —
  pluggable forge (GitLab/Gitea), pluggable reviewer, public-repo hardening
  (untrusted-input safe), a real supervisor, and eventually a dashboard. The forge
  goal is deliberately scoped: v1 isolates GitHub calls, but its board, review,
  check-ownership, search, relation, and sub-issue semantics are GitHub-shaped. A
  second forge reuses the portable subset and semantically ports the rest; it is
  not promised as an endpoint swap.
- **Dogfooding is the proof and the pitch:** from M2 onward, sapwood builds
  sapwood — every remaining feature is driven through sapwood's own loop. The
  flagship demonstration is **sapwood building its own dashboard (v0.2)**: a
  recorded autonomous run that produces the dashboard, doubling as the launch
  artifact (the tool building the thing that visualizes it). This is stronger
  evidence than any test suite that the loop handles real, non-trivial work.

## What the framework does (extracted from 0day)

A 3-layer nested loop: `/loop` (harness) ⊃ `/dev-round` (one full round A–E) ⊃
`/dev-loop` → `loop_conductor.sh tick` (one scheduling beat).

- **Work queue = GitHub itself**: a ProjectV2 board `Status` field + issue labels
  *are* the task state (no DB). All via `gh` CLI (REST + GraphQL).
- **Workers = headless `claude -p`** in isolated git worktrees, one per issue.
  Completion signaled by the wrapper writing `.done.json`/`.failed.json` sentinels
  — **not** the model's self-report (keep this; it's the robust part).
- **Safety core = fail-closed PreToolUse hook** (`backend/src/zeroday/loop/guard.py`)
  enforcing **producer≠reviewer≠merger**.
- **State** = `data/sessions/run-state.json` + per-worker sentinels + per-round
  `metrics.json`/`events.jsonl`.

Reference files in 0day (port from): `ops/loop/loop_conductor.sh` (1,392 lines),
`ops/loop/loop_worker.sh`, `ops/loop/loop_merge_driver.sh`, `ops/loop/lib.sh`, and
`scripts/{claim_issue,pr_gate,board_ready,board_done,board_selffeed,
bootstrap_github,session_start}.sh`. Guard: `backend/src/zeroday/loop/guard.py`
+ `backend/tests/loop/test_guard.py`.

## Locked decisions

| # | Decision | Choice |
|---|----------|--------|
| 1 | Form factor | Claude Code plugin (full bundle: skills + commands + hook + engine) |
| 2 | Engine language | TypeScript (whole stack) |
| 3 | Trust context | **Trusted repos first**, architected toward public-repo hardening |
| 4 | Dashboard | **Deferred to v0.2.** v1 ships a CLI/terminal status view; validate demand, then build the dashboard from real usage |
| 5 | Default merge gate | **0day-style: autonomous-merge gated on a different-model Codex PR review** — gate① CI green + gate② a fresh non-author review → the Conductor merges (producer≠merger). Reviewer is pluggable: hosted different-model Codex (default), same-model-trusted, human, or the engine-agent session in Decision #10; **produce-PR-and-stop** remains selectable when a human must merge. Different-model default matches 0day and the security review's recommendation. |
| 6 | Method | 0day's TDD + two-gate + taxonomy as overridable defaults |
| 7 | Config format | **YAML default** — `sapwood.config.yaml`, hand-edited with inline comments (serves "易读易配置"). Zod-validated after parse. The YAML parser also reads JSON for free (YAML ⊃ JSON), so `.json` works with zero extra code; no separate `.ts` config. |
| 8 | Dispatch readiness | **An issue is not `Ready` until it carries a verification plan** — acceptance criteria + how to prove them (tests to write/run, commands, observable outcomes). Authored by the issue author/triage *before* the producer starts (keeps producer≠author). Enforced at the `Ready` gate (`getReadyIssues` refuses issues without one) **and** re-checked by the reviewer at gate② (the PR must satisfy the stated plan). Inherently-unverifiable issues (docs/knowledge, chore) are labelled `verify:n/a` and use the round-close doc gate / a lighter definition-of-done instead, so the gate never blocks legitimate work. Cheap (plan written once, read by worker + reviewer who already read the diff); net-saves by killing wrong-direction PRs and rework. **Amended 2026-07-09 (gate⓪, lands in v0.2 — see the v0.2 chapter):** presence alone is no longer the bar — a **plan-reviewer peripheral (gate⓪)** reviews each plan's quality/feasibility post-`Ready`, pre-dispatch, and `getReadyIssues` requires the plan **and** its `plan:approved` label (fail-closed). `verify:n/a` is never self-declared: gate⓪ can only *propose* it, always paired with `needs-human`, and a human finalizes the adjudication by removing `needs-human` (→ doc-gate path). |
| 9 | Edge-case handling | **Rare edge cases degrade to `needs-human`, never to more machinery** (CTO, 2026-07-07, #69). Automation covers the common path only; when a low-probability edge would require new hardening/persistence/recovery code, the correct handling is: preserve the evidence, label `needs-human`, stop. First application: the drain path never runs git in worker worktrees (the whole #59–#68 issue family collapsed into sentinel-only handoff + dirty-worktree retention). |
| 10 | Engine-agent reviewer | **Engine-composed, static, different-Claude-model gate② session** (#279): D1 no producer-code execution/Bash; D2 superseded by D6's engine-private, config-isolated checkout; D3 runs serially after trusted CI and reruns only when needed; D4 checkbox ACs receive engine IDs; D5 configured and actual reviewer models must differ from the producer's; D6 materializes the exact head from a private clone; D7 includes instruction context but changes to configured instruction paths escalate to human review. The dispatch-time full-body/AC snapshot is authoritative session input; code-verifiable confirmation requires app-slug-bound `ci.requiredChecks`; `engine-agent` is primary-only (never a fallback) and has no fallback model. |

## Architecture (v1)

**Plugin layout:**

```
sapwood/
├── .claude-plugin/          # plugin manifest (skills, commands, hooks)
├── skills/                  # dev-round, dev-loop (ported from 0day skills)
├── commands/                # /sapwood-init, /sapwood-run, /sapwood-status, /sapwood-stop ...
├── engine/                  # TS orchestration engine (the port)
│   ├── conductor.ts         # scheduler: tick (reclaim→drive→resume→dispatch), state machine
│   ├── worker.ts            # headless `claude -p` wrapper in a worktree + sentinels
│   ├── merge-driver.ts      # the only place a merge happens (autonomous-merge mode)
│   ├── forge.ts             # IForge interface + GithubForge impl (gh CLI/GraphQL)
│   ├── guard.ts             # fail-closed PreToolUse hook (port of guard.py), zero-dep
│   ├── reviewer.ts          # pluggable review gate (hosted/trusted/human/engine-agent; Codex default)
│   ├── config.ts            # load sapwood.config.yaml (yaml→zod), JSON also parses; defaults
│   ├── state.ts             # SQLite (WAL) state + per-round metrics/events
│   └── cli.ts               # `sapwood` binary: init / status / stop — runs WITHOUT a live session
└── docs/                    # getting-started, config ref, security model, troubleshooting
```

**Engine design notes**

- **`IForge` seam (audited 2026-07-23, #307).** The pre-M2 intent was ~8 methods;
  the shipped interface is 44. Of those, 25 are portable forge primitives (issues,
  comments, string labels, PRs/MRs, branches/commits/diffs, milestones, and summarized
  CI/merge status) and 19 encode GitHub semantics: ProjectV2 lanes/field mutations,
  the review-thread and raw-check models, `gh search` syntax, issue relations, native
  sub-issues, and GraphQL node-ID operations. `GithubForge` still provides a useful
  isolation seam for runtime orchestration and loop forge operations; init-time auth
  checks and provisioning use the `gh`/`ghText` helper directly. GitLab/Gitea would be
  a semantic port, not an endpoint swap. Do not regroup or abstract the interface while
  there is exactly one implementation; revisit the boundary when a second forge is
  actually scheduled. Config still removes 0day's repository-specific hard-coding
  (`PROJECT_NUMBER`, owner kind, literal board lane names, trusted-reviewer login).
- **SQLite (WAL) state.** Replaces 0day's non-atomic `jq` read-modify-write with no
  locking (`loop_conductor.sh:738-762`). Conductor stays single-writer-serial;
  WAL gives atomic writes + concurrent reads (for `sapwood status`). Fully durable
  → engine restart is always a clean resume. Schema is versioned (migration path).
- **Structured tick results** (typed discriminated union) replace the stringly-typed
  `DISPATCHED.../RECLAIMED...` text protocol greped by skills.
- **Keep sentinel-based completion** + heartbeat/PID liveness classification. Add a
  third terminal state alongside done/failed: **`.handoff`** (soft-budget reached,
  work preserved, resumable) — see the soft-budget design in the Security model.
- **Claude CLI coupling isolated** in `worker.ts`: every `claude -p` flag, the
  `stream-json` cost parsing, and `CLAUDE_BIN` discovery live in one module. State a
  minimum Claude Code CLI version and test against it in CI.
- **Lifecycle (v1):** conductor ticks via ScheduleWakeup (session-bound — documented
  limitation; durable SQLite makes restart clean). `sapwood status` (the CLI, not a
  skill) reads SQLite directly and works with no live session; it detects a dead
  engine and prints the restart command. A real supervisor (launchd/daemon) is v1.1.
- **Skill↔engine IPC:** skills/commands talk to the engine only through the
  `sapwood` CLI / a read-only state read — never bespoke SQLite coupling per skill.

**M0 stack (locked, delivered in PR #22)**

Zero-runtime-dependency-where-possible, fail-closed-by-default:

- **Build/runtime:** npm workspaces (`engine` now; `dashboard` slots in at v0.2),
  strict NodeNext TypeScript, **Node ≥ 24** (floor declared on both root and
  `@sapwood/engine`). Runtime deps: `yaml` + `zod` only.
- **State = built-in `node:sqlite`** (WAL), not `better-sqlite3` — zero native build.
  Schema versioning via `PRAGMA user_version` + ordered, append-only migrations in a
  transaction. `workers` table carries the `handoff` terminal state.
- **Tests = built-in `node:test` + `tsx`**, not jest/vitest — zero test-framework dep.
- **Config:** YAML default (JSON parses for free), Zod-validated and **`.strict()`**
  (unknown keys / typos error, never silently drop) and **`.finite()`** on budget
  ceilings (overflow can't disable the cap). `loadConfig()` probes
  `sapwood.config.{yaml,yml,json}`. Every 0day `LOOP_*` env var is a named, defaulted,
  documented field (mapping in `engine/src/config/config.ts`).
- **Forge:** all subprocess calls use `execFile` with argv arrays — never `shell:true`.
- **CI-green is fail-closed:** an empty `statusCheckRollup` is **not** green (checks
  may be uncreated on a fresh PR); genuinely CI-less repos opt in via `ci.requireChecks`
  when the merge gate is wired (M3). Legacy `StatusContext.state` is honored alongside
  CheckRun `conclusion`.

**M0.5 init (locked, delivered in PR #24)**

`sapwood init` is idempotent + recovery-safe (detect-before-create everywhere):

- **Auth preflight first** — parses `gh auth status`; fails with the exact fix on a bad
  state (`gh auth login` / `gh auth refresh -s project`) before touching anything, so a
  scope problem never leaves a half-provisioned repo. Gates on the `Token scopes:` line
  (multi-host safe).
- **Labels** — detect-before-create (no `--force`), so re-runs preserve user edits;
  taxonomy derived from config.
- **Milestones are config-driven** (`config.milestones`, default `[]`) — init imposes
  none by default; the loop needs labels + board lanes, not milestones. List uses
  `state=all` + line-parsed pagination (closed/`>30` safe).
- **Board** — ensures the `Status` field carries the configured lanes, preserving
  existing option colors + descriptions (the mutation replaces the full set, so it never
  clobbers a lane). If no board exists at the configured number it **reports** that with
  the fix rather than creating a number-mismatched board.
- **`gh.ts`** is the single `execFile`/no-shell boundary for every gh call (forge + init).
- The guard PreToolUse hook is **not** wired here — the guard core lands in M1, and its
  *live* wiring into worker sessions in M2 (issue #26); human-merge-only when wired.

**M1 guard (locked, delivered in PRs #27 / #28)**

`guard.ts` is the fail-closed PreToolUse safety core — a pure, zero-dep, deterministic
`guardDecision(tool, input, cwd)`. Ported the *generic safety mechanism* from 0day's
`guard.py`, **not the trading domain** (CLAUDE.md):

- **Ported:** shlex-equivalent tokenizer, fragment splitting (`$()`/`` `` `` recurse),
  recursive exec-prefix stripping (env/uv/npx/poetry/`command`/`stdbuf`/leading
  assignments), opaque-construct fail-closed detection (`eval`, shell `-c`, interpreter
  `-e`/`-c` incl. versioned `python3.11`, process substitution, `env -S`), and **Category
  C — gh overreach** = the structural producer≠merger/reviewer enforcement (`gh pr
  merge|ready`, `gh pr review --approve/-r`, `gh release`, `gh api` mutating
  merge/release paths + graphql mutations + `@file`/`--input` fail-closed).
- **Omitted:** 0day's Category A (on-chain funds) / B (private keys).
- **Write-path protection (#9):** denies writes to boundary files — `.claude/settings*.json`,
  `.github/workflows/**`, `guard.ts`/`guard-hook.ts`/`reviewer.ts` — across **both** the
  Write/Edit tools **and** Bash (redirections incl. `>|`/`&>`/`>&`, `tee`/`sed -i`/`dd`/
  `cp -t`/`mv`/`rm`/`git rm|mv|restore|checkout`), scanned position-independently so a
  wrapper can't hide the write. These files are human-merge-only.
- **Fail-closed (a deliberate divergence from 0day, which fails open):** the hook denies
  on malformed JSON, a non-object payload, a guarded tool with malformed `tool_input`, or
  any thrown guard. A safety hook disable-able with garbage isn't one.
- **Verification:** a BLOCK/ALLOW bypass matrix (`guard.test.ts`) **plus** a differential
  fuzz (`guard.fuzz.test.ts`) running 1500 seeded commands through both `guard.ts` and
  `guard.py`, asserting sapwood is **at least as strict as guard.py** on the shared
  surface (0 divergences). The guard survived a 6-round adversarial review (18 bypass
  vectors found + closed).

**M2 engine core (locked, delivered in PRs #30 / #32 / #34, dogfood #35→#36)**

The scheduler + worker + live guard. TS port of 0day's `loop_conductor.sh` +
`loop_worker.sh` — the *generic scheduling/worker mechanics only*, never the trading
domain (no reserve/SLA/eval-report/HTML machinery).

- **`conductor.ts`** — pure scheduling core mirrors `test_loop_conductor.sh` row-for-row
  (`classifyLane` 4-signal lane state, `issuePriority` [matches configured-prefix `prio:N`, bare when the prefix is empty, and suffixed],
  `labelsBlockers`, `budgetExceeded`, `codingFloor`/`isCodingRank`/`metaLaneAllowed`
  anti-starvation, `laneOnReclaim*`, `driveDecision`). **Structured discriminated-union tick
  result** replaces 0day's stringly-typed `DISPATCHED/RECLAIMED` text protocol. `tick()` =
  reclaim→drive→resume→dispatch with **dependency injection** (`IForge` + `Supervisor` + `State`
  injected → the whole tick is unit-testable with no real `claude`/`gh`). New **`driving`**
  lane state: a PR-backed reclaimed lane keeps occupying a lane against `lanes.max` until the
  M3 review gate resolves it. Claim-before-launch with board rollback on dispatch failure.
- **`forge`** — landed the M2-deferred ProjectV2 wiring: `getReadyIssues` (Ready-lane + OPEN +
  full `owner/repo` + the **verification-plan gate**, Decision #8, fail-closed, **paginated**)
  and `setBoardStatus`. Owner-kind-agnostic pure parsers, offline-tested.
- **`worker.ts`** — the only module touching the Claude CLI: headless `claude -p` in a git
  worktree (argv array, **no shell**, **detached process group**), atomic sentinels
  (`.running`/`.done`/`.failed`/`.handoff`, tmp+rename), heartbeat + PID liveness,
  **process-tree kill** via `kill(-pid)` (the tree 0day couldn't on bash 3.2), stream-json cost
  parse, name-reuse reject, wall-clock **timeout enforcement**, spawn-error handling.
  Completion is signaled by the WRAPPER, not the model — and there is **no `--add-dir data`**,
  so a worker cannot forge its own sentinels or mutate engine state.
- **Guard wired live (#26)** — attached via **inline `--settings` JSON** (no worker-writable
  settings file) scoped to the worker's `claude -p`, **not** a plugin-global hook (the human's
  interactive session is unaffected). **Hard default / soft opt-in** via the
  **`SAPWOOD_GUARD_MODE` spawn env** (trusted, not worker-writable — a worker cannot weaken its
  own guard). Fail-closed hardening (a 7-round adversarial review) closed **five distinct
  fail-open vectors**: a hook crash → the command maps to exit 2 (blocking); a global
  `disableAllHooks` → forced `false`; and three self-protection writes now blocked by the guard
  boundary — `sapwood.config.*`, the compiled `engine/dist/guard/guard*.js` artifact, and (removed
  entirely) the settings file. Dispatch **fails closed** if the compiled hook is missing.
- **Scope boundaries:** `drive_decision` only — the PR-gate ACTION→action map (0day
  `merge_decision`/`pr_gate`) + parity vs `test_loop_merge_driver.sh` move to **M3** with
  `merge-driver.ts`. Deferred follow-ups: **#31** (double-failure rollback/requeue hardening),
  **#33** (soft-budget *auto*-enforcement — needs a live cost signal, which stream-json does not
  carry). **⚠️ M2 has no live cost cap:** the worker does not monitor in-flight cost and the
  conductor only checks `roundSpendUsd` *before* dispatching, so a running worker is bounded only
  by wall-clock `worker.timeoutSec` — the dollar cost ceiling (per-worker soft + engine hard)
  arrives with **M3 (#14)** *(since landed — see the M3 section below)*. Also **#37** (`init`
  ProjectV2 option-update wipes item status — a real board hazard found during dogfood;
  fixed in PR #40 via ID-preserving option updates).
- **Dogfood proven (#12):** ran the loop end-to-end on a real issue (#35, a `cli --version/--help`
  feature) with a live **sonnet** worker — claim → worktree → TDD → PR (#36) — guard **live in
  hard mode** (PreToolUse firing on every tool call, zero bypass), and the worker **never
  self-merged**. The producer≠reviewer gate then caught two real defects in the autonomous PR
  before merge. *sapwood builds sapwood* is now demonstrated, not just claimed.

**M3 review gate + merge modes (locked, delivered in PRs #41 / #42 / #43 / #44; hardening #39 / #40)**

The gates + the ceiling: the engine can now *finish* work autonomously — review-gate a
PR, merge it under the locked two-gate policy, and stop itself when spend or a human
says stop. TS port of 0day's `pr_gate.sh` ACTION protocol + `loop_merge_driver.sh`.

- **`reviewer.ts` (#13)** — pluggable gate②: **different-model Codex** (default) /
  same-model-trusted-only / human (engine-agent added in M10 — Decision #10). A verdict is pinned
  to a **specific head oid** — a review of a stale head counts as *no review*. In the Codex /
  same-model modes, only
  the Codex bot (or a configured `trustedReviewers` allowlist) can *satisfy* gate②
  (`human` mode accepts any non-author approval — no allowlist there); in every mode a
  `CHANGES_REQUESTED` from **anyone** on the current head blocks until that same
  reviewer later approves. **Review-unavailable (rate-limit/timeout) queues the PR — it
  never skips or softens gate②.**
- **`merge-driver.ts` (#13)** — gate① (CI green, fail-closed: an empty check rollup is
  NOT green) + gate② → squash-merge pinned by **`--match-head-commit`** (TOCTOU: a push
  after the gates fails the merge command itself). `mergeDecision` is a **23-case
  row-for-row parity port** of `test_loop_merge_driver.sh`. Both gate reads must observe
  the **same head** (split observation → requeue). An already-**MERGED** PR resolves as
  done (the designed happy path of `produce-pr-and-stop`, where a human merges);
  **CONFLICTING** → the FIXABLE fix lane (#270: conflict resolution is producer work —
  sensed tick-periodically *before* the review trigger, so a born-conflicted PR with zero
  check-suites never hangs waiting for CI, and a mid-review conflict supersedes the moot
  review; `prFixCap: 0` folds to needs-human; a pre-merge CONFLICTING check stays as
  defense in depth). Deterministic merge failures re-read mergeability — a freshly
  surfaced conflict requeues into the fix lane, genuinely non-conflict deterministic
  failures escalate, transient/TOCTOU ones requeue. Two merge modes: **conductor-merges**
  (default) and **produce-PR-and-stop** (gates report, never merges). The conductor is
  the *only* merger — structurally, `tick()` never calls `mergePR`; only
  `merge-driver.driveOne` does, and no worker can reach it.
- **Cost ceiling + kill switch (#14, simplified in #69)** — engine-enforced,
  worker-unforgeable: a `spend_ledger` in SQLite (restart-safe; a mid-run engine
  restart recovers lane cost from the worker jsonl) feeds a **daily USD cap** checked
  every tick, plus a **wall-clock cap** over an active engine session (session gap
  derived from tick cadence — a legal slow cadence cannot silently disable the tier).
  A **`KILL_SWITCH` file sentinel** in the engine's own data dir (human `touch`/`rm`;
  workers have no write path) is **one global gate at the very top of the conductor
  tick** (#69, replacing the #59/#61/#64 per-phase checks): active ⇒ the tick is
  **drain + terminal-reclaim only** — running workers get the graceful
  `requestHandoff()` drain (and, past the bounded `drainWindowSec`, the process-tree
  kill + needs-human escalation), **and** a lane that has *already* written a
  terminal sentinel (`.handoff`/`.done`/`.failed`) still gets its real outcome
  recorded — finishing a graceful drain is part of draining, not new work, so a
  handed-off lane is never rotted as `running` and then mislabeled `failed`. Everything
  else is blocked: no dispatch, no drive/merge, no rollback retry, and no kill+requeue
  of crashed (no-sentinel) lanes. Accepted trade-off: a switch flipped mid-tick takes
  effect at the next tick's gate, not within the same tick. The per-worker *soft*
  budget stays a graceful handoff, never a mid-work kill (#33). **#375:** a `driving`
  lane has no live process for the drain to hand off/kill, so it used to sit untouched
  for as long as the switch stayed active — once its only next action was itself
  budget-blocked or fix-rounds-capped (see the fix-loop paragraph below), that meant
  forever, spinning the engine's wind-down loop past its drain window with nothing to
  show for it. Such a lane is now escalated to `needs-human` past that SAME bounded
  `drainWindowSec` too, so the engine always exits within it; a `driving` lane that
  isn't stuck for a budget reason (MERGE/WAIT-gated) is left alone and resumes normally
  once the switch clears.
- **Drain contract is sentinel-only; the supervisor never runs git in a worker
  worktree (#69, superseding #60/#62/#63's supervisor-side commit+push)** — a
  drain SIGTERM ends with the supervisor writing the `.handoff` sentinel
  (session_id + cost) and *leaving the worktree untouched*; resume =
  `claude --resume <session_id>` reusing that worktree in place. The #62 approach
  (supervisor commits+pushes the dead worker's WIP) executed git inside a
  worker-controlled worktree — worker-writable git config is attacker-controlled
  input with unclosable code-execution vectors (#65: `.gitattributes` clean filters
  have no `-c` disable), so it was deleted at the root, not patched per-vector.
  **Dirty-worktree retention:** automation never deletes a worktree that may hold
  uncommitted work — lane reclaim (DEAD teardown, drain-window escalation) deletes a
  worktree only when a pure-filesystem check proves it untouched, comparing every
  entry's **mtime *and* ctime** (ctime can't be backdated by unprivileged code)
  against the lane's **immutable first-dispatch time** (`dispatched_at`, carried
  across a `--resume` so pre-handoff WIP is never re-baselined and silently deleted);
  otherwise it stays on disk and the conductor posts the absolute path to the issue +
  applies `needs-human`. A retained worktree also **removes its lane from the
  auto-drive path entirely** — even a lane that opened a PR (whether reclaimed while
  DEAD, escalated during drain, or terminating via a `.failed` sentinel) is marked
  `failed` (never `driving`) and `needs-human` is applied to **the PR itself**,
  because the merge gate reads a PR's own labels (`getPRReviewData`), not the source
  issue's; a crash-with-WIP must not auto-merge its incomplete PR while the WIP awaits
  salvage. Accepted trade-off (Decision #9): WIP is not auto-pushed to the remote, so
  total machine loss before a human intervenes loses at most one worker's
  budget-bounded WIP.
- **Cost telemetry (#47)** — `spend_ledger` also records model id + categorized token
  usage (input/output/cache-read/cache-creation) per (lane, model), parsed from the
  same stream-json result the USD figure already came from. The ledger records
  **loop/worker spend only**. Hosted Codex and human review usage happens outside
  stream-json; engine-agent sessions expose cost to their own whole-review cap, but
  reviewer spend is not written to `spend_ledger`.
- **Guard boundary extended (#43)** — the merge path is now inside the worker-unwritable
  boundary: `merge-driver.ts` source and the *running* `engine/dist/roles/reviewer.js` /
  `merge-driver.js` artifacts (same vector class as the guard artifact, closed in #26 R3).
  Also **#39**: the hook's direct-invocation check now compares realpaths — symlink
  invocation can no longer silently no-op the guard.
- **Rollback hardening (#31 → PR #44; extended to the merged path by #250)** — recovery-path
  board mutations, and since #250 the merged-path board **Done** write, are persisted to
  a `pending_rollbacks` table *before* being attempted and retried each tick until they
  succeed; bounded retries escalate to needs-human with a structured tick-result entry.
  Merged-path rows honor #168 forge-park suspension (frozen during an outage, drained on
  the first healthy tick — an open park is respected even at row creation).
  Invariant: a transient forge failure during recovery can no longer strand an issue
  In Progress with no worker row. No `.catch(() => {})` swallows remain in tick paths.
- **The fix loop (#245/#246/#247, M9, shipped 2026-07-18/19):** review findings get one
  bounded, mechanical rework pass before human escalation, instead of folding straight to
  `needs-human`. A new `fixing` `WorkerState` (`driving → fixing → driving`, counted in
  `activeWorkers()` like the other two) is entered by a fix leg that reuses #172's resume
  machinery (same worker row/worktree/branch/session — never a fresh dispatch, same
  squash-branch-reuse-hazard avoidance #147 below already established), tracked by a new
  `fix_rounds` counter (independent of `resume_attempts`) bounded by `lanes.prFixCap`.
  `deriveGate` (`merge-driver.ts`) derives `FIXABLE` from a live review verdict —
  `HANDLE_THREADS` findings, or `CI_RED` alongside a decisive verdict — whenever the fix
  loop is enabled (`prFixCap > 0`; at `0` it folds straight to `HUMAN`, byte-for-byte the
  pre-#246 behavior); `driveDecision` then turns `FIXABLE` into `FIXUP` (dispatch a fix leg
  via `startFixLeg`, itself gated by the same pause/ceiling/park/run-spend-stop admission
  checks RESUME/DISPATCH already pass — a blocked admission is a transient `queued` retry
  next tick, not an escalation) while `fix_rounds < cap`, or `ESCALATE` when the cap is
  exhausted or the round count is malformed. Of those two, both are terminal — they
  escalate to `needs-human`, the same escalation #147's GATED RECLAIM below can then
  reclaim once a human clears the label.
  **`prFixCap` is a COST ceiling being used as a quality ceiling — the known gap, designed
  (#402, proposed).** "Rounds spent" and "no longer making progress" are different facts
  sharing one signal today: every round looks identical to the engine, so a lane still
  finding real defects escalates at the cap while a lane going nowhere pays the full cap
  first. [`design/402-review-layering-convergence-tendency.md`](design/402-review-layering-convergence-tendency.md)
  is the adjudicated-design deliverable for that: finding severity layering (only a
  blocking/advisory bit reaches the gate), a per-round convergence definition over the
  event ledger, immediate human routing for a `disputed` thread, and cross-PR finding-class
  tendency accounting in retro. Nothing there is implemented yet — its §11 names the
  follow-up issues, and §8 the `prFixCap` migration (semantics unchanged, default 2→4).
  **Round budget paces new work; it never blocks finishing an open PR (#375, fixing two
  dogfood-observed permanent wedges, F7/F8).** A driving lane's fix leg is exempt from
  `cost.roundBudgetUsd` outright — an already-open PR has no other completion path (merge
  or fix; there is no "abandon the PR" outcome), so gating it on round spend could wedge a
  round forever once spend crossed the cap while a PR still needed rework. `cost.roundBudgetUsd`
  now gates **NEW dispatch only** (unchanged there). A fix leg remains bounded by the three
  *other*, pre-existing limits: `lanes.prFixCap` (attempts, as above), `worker.budgetUsdSoft`
  (each leg's own per-worker graceful-handoff ceiling), and `cost.dailyBudgetUsd` (the hard
  daily ceiling — still a real admission blocker via the same pause/ceiling/park/run-spend-stop
  check above). **The exemption is uniform across every round/run-level stop reason, not just
  the spend cap** (PR #388 review round 2): once ANY of `roundBudgetUsd`/`roundDispatchCap`/a
  round milestone/a `stop.*` run-level condition fires, round.ts freezes further waves via the
  SAME `forceDispatchPause` signal — which is a "no new dispatch this round" fact, never a human
  pause, and a fix leg on an already-open PR is never "new dispatch" either way. A fix leg's
  admission gate reads the genuine `data/PAUSE` sentinel only, not `forceDispatchPause` — new
  DISPATCH itself stays fully frozen regardless (round.ts already zeroes its dispatch quota in
  lockstep). **The daily ceiling is the actual hard safety boundary**, exactly as
  everywhere else in this doc — it is deliberately *not* exempted, since it is the boundary
  that exists to stop runaway spend, not to pace one round. A daily-budget-blocked (or
  fix-rounds-capped) driving lane is also now **terminal-for-drain** under the `KILL_SWITCH`
  bounded drain (`drainThenEscalate`, above): a `driving` lane has no live process to hand
  off, so before #375 it could sit forever once DRIVE froze, spinning the wind-down loop
  past its drain window with nothing to show for it (the second dogfood-observed wedge — a
  14-minute spin, force-killed). It now escalates to `needs-human` past the SAME bounded
  `drainWindowSec`, exactly like a hard-killed running/fixing lane, so the engine always
  exits within the drain window. A driving lane that has never needed a fix leg
  (MERGE-/WAIT-gated) is left alone — it isn't stuck for a budget reason, and resumes the
  instant the breach/switch clears. The fix leg pulls its own PR's review findings via the
  PR-facing forge MCP
  proxy tools (#244, attached to `resume()` too) rather than having them relayed through its
  prompt — no prompt-injection transport, no forge credentials handed to the leg — and, per
  #247, can act on individual review threads directly: the engine executes structured
  reply/resolve responses the leg emits, rather than relaying free-text back through a
  prompt. The `fixing → driving` edge clears the review-trigger pin, reusing `driveOne`'s
  own re-trigger machinery exactly like #147's gated reentry does. See
  [`security.md`](security.md#fix-loop-fixing-lane-state-245) for the full mechanism.
  **Narrowed by #147 (gated-PR reentry, 2026-07-13):** a `needs-human` escalated on
  gate②'s findings (`gate:HUMAN:HANDLE_THREADS`, the most frequent shape per the #122
  live-run report) is no longer a dead end requiring a manual fix→re-review→merge
  drive — the conductor's **GATED RECLAIM** phase treats a human clearing the
  issue of *every* `escalation.humanLabels` entry (`sapwood:needs-human` and `sapwood:blocked` by
  default — dispatch's exact hold set, not `needs-human` alone) as the explicit
  re-entry signal (autonomy principle: humans decide *why/what*, here "is this
  actually fixed") and reclaims the SAME
  worker row/PR/branch straight back to `driving`, letting the existing DRIVE loop
  re-trigger review, re-poll gate①/gate②, and merge on green — no new worker/dispatch
  (avoids the squash-branch-reuse hazard a fresh dispatch against a stale head would
  hit). Two fail-closed guards (Codex review of the #147 PR): a re-driven gate②
  counts only reviews submitted *after* the re-entry's own trigger (the stale
  pre-escalation review still sits on the unchanged head and must not satisfy the
  gate) — *unless* a standing `CHANGES_REQUESTED` is present on the head, in which
  case the full review set gates (a fresh review from a different reviewer cannot
  speak for another reviewer's undismissed block, so the lane re-escalates); and
  label absence only counts as a human act when the engine durably recorded that
  its escalation label write actually *succeeded* (a transient label failure must
  not read as human approval next tick). Bounded by
  `lanes.gatedReentryCap` (prFixCap's shape); a lane that keeps
  re-escalating past the cap is permanently excluded and re-labeled for a manual
  merge. This is reentry for an *already-produced* PR, distinct from the fix loop above
  (#245/#246), which handles bounded rework on a lane still in `fixing`/`driving`, before
  it ever reaches this escalated-and-cleared path. #33 unchanged (no in-flight
  cost signal). Review evidence: #42 survived 3 Codex
  rounds (3 P1 + 3 P2 fail-open finds, all fixed + regression-tested); #41 survived 4
  rounds (3 Codex + 1 fresh non-author stand-in when Codex rate-limited) — the
  gate②-when-reviewer-unavailable policy was exercised *on the PR that implements it*.
  ~~live `findOpenPr` forge wiring and the live end-to-end merge-gate run move to M4
  with the loop driver (which MUST pass `tickIntervalSec` into `tick()` and handle the
  `--resume` cost-delta — both flagged in code)~~ **→ #46 (M4): the loop driver
  (`driver.ts`) now passes `tickIntervalSec` into every `tick()`; #172's live empirical
  verification established that resumed `total_cost_usd` is per-leg, so
  `State.recordSpend` records every handoff/resume leg directly with no baseline
  subtraction or double count; ~~`GithubForge.findOpenPrForIssue` gives `sapwood run` a
  first-pass (not yet hardened) live wiring~~ **→ #377: that first-pass wiring selected a lane's
  PR by matching the issue number against PR-body PROSE and, in the 2026-07-24 dogfood run (F15),
  handed a lane an unrelated PR to shepherd. It is deleted. A lane is now matched to its PR
  structurally: the lane worktree's own branch, plus an engine-authored
  `<!-- sapwood:pr-owner … -->` marker the engine stamps onto (or writes into) that branch's PR —
  see docs/dev-guide/05-core-modules.md.** ~~**The gate② verification-plan re-check (Decision
  #8) is NOT yet wired:** the plan gate holds at *dispatch* (`getReadyIssues` refuses
  issues without a verification plan, fail-closed), but the M3 gate data carries no
  issue body, so no code path yet re-checks the finished PR against the plan — that
  lands with the M4 reviewer-prompt work. Until then gate② = fresh non-author review +
  CI, not plan conformance.~~ **→ #46: `reviewer.ts`'s `@codex review` trigger now
  carries the driving lane's extracted verification-plan section (`IForge.getIssueBody`
  + `forge.ts`'s `extractVerificationPlan`, shared with the `Ready`-gate parser) as
  explicit reviewer instructions, with a fail-closed fallback sentence when no plan is
  extractable — never a silent omission. The verdict mechanics are unchanged (Codex's
  review IS the re-check); this only gives it the plan.** Still deferred: the **live**
  merge-gate run and the **live** ceiling/kill-switch run on a real repo (#46 scope
  3/4) — everything above ships covered by fakes only, no real `claude`/`gh` in the
  loop yet. **#172 wires graceful-handoff recovery:** a RESUME phase before DISPATCH
  re-admits eligible `handoff` rows through `WorkerSupervisor.resume()` while capacity and
  fresh-spend gates permit; `worker.maxResumes` bounds the additional legs and escalates a
  capped lane once through `needs-human`.
- **The three-tier escalation model (#248, human hold — WAIT-tier control handover, adjudicated
  2026-07-17).** Humans intervene to *review*, never to *resolve reviews* — but the only
  human-hold signal that existed through #147/#170 (`escalation.humanLabels`, meaning ESCALATE)
  conflated that with a human simply saying "I'm looking at this right now": pressing an
  imagined "I'm reviewing" control would have burned a gated-reentry attempt and fabricated an
  escalation record for a twenty-minute look. The fix is **one handshake protocol — a label as
  carrier; apply = take control, remove = return it — with three tiers, each encoding exactly
  one fact (one fact, one bit):**

  | tier | written by | gate behavior | lane | queue |
  |---|---|---|---|---|
  | `hold` | human | WAIT | **held** (keeps its slot) | none (self-assigned, short) |
  | `needs-human` | **engine** | ESCALATE marker | released | human queue; removal = sign-off |
  | `blocked` | **engine** or human | veto | released | nobody's queue (external wait) |

  Collapsing any two of these into one label loses a bit: escalations would pollute the human
  queue with external-dependency waits (`blocked`), and removing one shared label would
  accidentally sign off two unrelated facts at once.

  **`blocked` is engine-applied too (#397).** The tier table above used to say `blocked` was
  human-written; the code disagreed and the code wins — `roles/architect.ts` applies it when the
  architect pass finds a severe contradiction, and this document's own write-side-asymmetry
  paragraph below ("only `needsHuman`/`blocked` are ever engine-applied") always said so. Both
  passages now read the same way. A human still applies and removes it too; the asymmetry that
  matters is that `hold` is the one tier the engine NEVER writes.

  **The ESCALATE tier splits by required ACTION, not by carrier (#397).** `needs-human` used to
  carry six distinct meanings behind one description, so a human seeing it could not tell what
  was expected of them or what removing it would do. Splitting by carrier
  (`needs-human-pr`/`needs-human-issue`) was rejected — the object already tells you where it
  sits. The split is by what the human must DO, into exactly two buckets, plus one label that
  admits it was never an escalation:

  | label | meaning | carrier | removal |
  |---|---|---|---|
  | `needs-human` | the machine STOPPED; a human owes the next decision | issue (and PR, for visibility) | the #147 reentry handshake, unchanged |
  | `human-merge-only` | a human must MERGE this PR; nothing is stuck | PR only, written once | never removed by any automated act |
  | `planless` | **not an escalation** — no verification plan yet | issue | add a plan; nobody is on the hook |

  `human-merge-only` is deliberately NOT a member of `escalation.humanLabels`. That array is
  checked against ISSUE-side labels (the gated-reentry reclaim fence, `orderForDispatch`, the
  standby probe, `round.ts`'s pool-consumability check), none of which a PR-only label could ever
  satisfy — so adding it there would be a no-op for those checks while quietly widening
  `deriveGate`'s veto set and the config collision guard for no benefit. Instead, a lane settling
  on this verdict terminates WITHOUT `gated_escalation_labeled`, the same mechanism `state.ts`
  already uses to keep no-PR-failed and label-write-failed rows permanently invisible to
  `State.gatedFailedWorkers()`. A row that never enters `gatedFailedWorkers()` can never be
  gate-reclaimed, so the CAPPED branch that re-applies `needs-human` can never fire for it — the
  reclaim loop is closed structurally, not by another label fence. `planless` keeps the exact
  exposure the fence had while it borrowed `needs-human`: `isPoolEligible`, `needsPlanReview`,
  `needsPlanTriage`, and the standby probe each exclude it explicitly.

  **Accepted, bounded cost of the split, stated rather than hidden:** the #292 instruction-path
  latch is now keyed on `human-merge-only`, so a PR carrying `needs-human` no longer short-circuits
  there. It falls through to the ordinary gate path, which costs ONE changed-files read and — only
  when no review-trigger pin exists for the live head yet — ONE review trigger, both once per head,
  never per tick. Latching on `needs-human` as well would report a bucket-1 escalation under a
  bucket-2 reason, and the conductor would then settle that lane without ever labelling its issue. (The 👀 reaction was considered and
  rejected as the hold carrier: it's Codex's own review-protocol signal, it can't suppress
  fix-leg dispatch once findings exist, and it ages into #170's own machinery — a genuinely
  different concern.) Config: `escalation.holdLabels` (default `[sapwood:hold]`, resolved under
  the same `labels.prefix` convention as `escalation.humanLabels` — #199) — deliberately NOT a
  `labels.*` field, because of the write-side rule below. Config load rejects a `holdLabels`
  value that collides with any other protected label (`needsHuman`, `blocked`, `roundPool`, …) —
  the same guard `labels.roundPool`'s collision check uses, generalized: collapsing tiers by
  accidental aliasing is caught at load, not discovered in production.

  **One carrier: the PR (#400).** `hold` means one thing — *a human is looking at this PR right
  now; pause the automation* — and it is read on exactly one surface: the PR (`deriveGate` in
  `merge-driver.ts`, the engine-agent preflight in `review/drive.ts`, and #170's silence
  suppression). See "Gate ordering" below. The shipped label description states the whole
  contract, so no reader has to consult this document to use it: *"A human is reviewing this PR —
  automation pauses; remove to resume. No effect on issues."* (identical in `loop/init.ts`'s
  `requiredLabels` and `docs/configuration.md`, paired by a test).

  **Exact match, not substring (review round 1, G3).** Unlike `escalation.humanLabels` (matched
  by substring — historical, unchanged, its own accepted footgun), a hold label is a configured
  NAME, matched by exact case-insensitive identity (`labelsIncludeAny`/`hasReserveLabel`) at
  every runtime check (`deriveGate`, `review/drive.ts`'s preflight, and `reviewSilenceDuration`'s
  call site). A substring match would let a short entry (e.g. `holdLabels: ["sapwood"]`) hold
  every label sharing that text, or an accidentally-empty entry hold everything unconditionally
  — `escalation.holdLabels` schema entries are also trimmed and rejected if empty, so this class
  of misconfiguration is caught at load, not silently over-broad at runtime.

  **Gate ordering (`deriveGate`, `merge-driver.ts`) — PR-level hold sits between `humanLabels`
  and every review signal:** `prState`/`draft` fail-safes first (unchanged), then `humanLabels`
  (a standing `needs-human`/`blocked` always wins — **escalation semantics win, fail-safe**, so a
  hold applied alongside an existing escalation never masks it), then `holdLabels` -> WAIT
  (before the review-verdict switch, so hold precedes `MERGE`, `WAIT_REVIEW`, `HANDLE_THREADS`,
  and #246's `FIXABLE` alike — a hold suppresses the NEXT action of every kind, not just merge).
  While held: no merge, no NEW fix-leg dispatch, and **#170's review-silence escalation is
  provably suppressed** (`reviewSilenceDuration` gained a `holdLabelPresent` input, checked
  exactly like `needsHumanLabelPresent`) — the lane simply stays `driving`/`fixing`, work
  unfinished, worker on post, keeping its slot rather than being released to the human queue.
  **In-flight fix legs are never interrupted** — same doctrine as the soft worker budget (never
  a mid-work kill): a PR-level hold only ever gates the NEXT drive decision, and structurally
  cannot reach a `fixing` lane at all (`deriveGate`/`driveOne` only ever run over
  `state.drivingWorkers()`; a `fixing` row is invisible to DRIVE until it lands back in
  `driving`, at which point the still-present hold governs the next tick exactly like any other
  driving lane).

  **Why the issue-level carrier was deleted (#400, adjudicated 2026-07-27).** #248 review round 1
  had made `gatedReentryDecision` take a second, issue-level `issueHoldPresent` SKIP input, for a
  human who applies a `hold` to the ISSUE of an already-escalated (`failed`+`needs-human`) lane
  "while investigating" and then removes `needs-human` before finishing. It was deleted: that
  scenario is a human contradicting themselves (removing `needs-human` **is** the go-ahead
  signal — the fix is not to remove it yet), and the carrier was a silent no-op in the state a
  human is most likely to be in, since an issue-level hold on a still-`driving` lane was never
  consulted at all. Two carriers also made the label undescribable — no short description could
  be true of both surfaces. **Accepted, bounded, transitional cost, stated rather than hidden:**
  a human who removes `needs-human` before they are actually ready burns ONE
  `gated_reentry_attempts` slot; the cap bounds it and a re-escalation re-latches the lane. That
  is strictly cheaper than a second carrier plus the detection machinery needed to make it safe —
  and it is transitional: once #398 has GATED RECLAIM read the **PR's** labels for a PR-bearing
  lane, a PR-level hold restores that SKIP on the correct carrier, from the same fetch, at zero
  marginal cost. Deliberately no warning path for a hold applied to an issue: silence is correct
  for a label that has no meaning there, now that its description says so.

  **Write-side asymmetry is the audit trail:** the engine never writes a hold label — only
  `needsHuman`/`blocked` are ever engine-applied (grep-proof: every `addLabel`/`addPRLabel` call
  site in the engine names its label via `cfg.labels.*`, never `escalation.holdLabels`) — a
  human applies and removes `hold` themselves. **`sapwood init` DOES provision the repo-level
  label definition itself** (review round 1, G2) — the shipped `escalation.holdLabels` default
  (`sapwood:hold`) is otherwise unusable on a clean repo (nothing ever creates the GitHub label,
  so a human has nothing to pick from the PR UI); creating the label's NAME/color/description is
  ordinary one-time repo setup, the same act `sapwood init` already performs for
  `needsHuman`/`blocked`/etc — it is not "writing a hold" (applying the label to an issue/PR),
  which the engine still never does. Human review output during a hold needs no special channel:
  threads/`CHANGES_REQUESTED` left while held are ordinary gate② signals (`verdictFrom`'s
  contract already lets anyone's blocking signal count); only trusted identities can *approve*.
  Removing the hold resumes the ordinary gate path next tick — no re-dispatch, no re-triggered
  review unless the head actually moved (same lane, same PR, same session lineage). **Accepted,
  documented bounded blind spot (marginal-complexity principle: zero new machinery over a
  perfect fix):** `reviewSilenceDuration`'s pin-based clock is a pure per-tick evaluation with no
  memory of a hold's own start/end — while held it's suppressed outright, and once removed the
  very next tick resumes counting off the **same, unchanged** trigger pin, i.e. the elapsed
  silence includes time spent held. A hold outlasting `reviewer.escalateAfterSec` can therefore
  fire the `#170` escalation on the very first post-removal tick — a single, tick-scale-imprecise
  evaluation, never a repeated "burst" (the existing label-presence latch still applies from
  that point on). The dashboard's future "I'm reviewing" button (deferred to the dashboard
  milestone, v0.2) is just a remote hand on this SAME label — apply/remove with the panel's own
  credentials; the label mechanics above are the whole contract, the panel is only a control
  surface.

## Security & trust model (trusted-first, designed toward public)

**Positioning statement (locked 2026-07-17 adjudication, issue #238).** sapwood makes
autonomous development bounded, inspectable, recoverable, and conservatively governed.
Models receive broad read access within a recorded, metered repository scope; action
capabilities remain explicitly bounded by role, the guard, engine validation, forge
controls, and review gates. Humans own why/what at Ready; the engine owns durable
process and effects; models supply judgment without being treated as deterministic. It
does not make missing intent or missing evidence deterministic. This statement
supersedes an earlier draft slogan — "information plane fully open, action plane fully
mediated, never constrains curiosity" — rejected in review as overclaiming: workers and
`retro` act directly (not fully mediated), the read proxy is capped (not fully open),
and budgets bound curiosity (curiosity is constrained). The paragraphs below are the
honest, load-bearing version this positioning statement summarizes.

**The trust boundary is on the ACTION side, not the content side.** Under the locked
trusted-repos-first scope, issue and PR content is semi-trusted input, and every model
session — worker or peripheral — is assumed corruptible by prompt injection,
hallucination, or drift; at the boundary those causes are indistinguishable. Workers
already read issue bodies while holding a write-capable token. The safety claim
therefore rests on what a session can *do*, not on making everything it can *read*
trusted. In the shipped defaults, the guard hook's fail-closed hard mode constrains
worker actions, while producer ≠ reviewer ≠ merger keeps production, gate②'s fresh
different-model review, and the Conductor's merge in separate hands (soft guard mode,
other reviewer choices, and produce-PR-and-stop remain selectable). Issues-only
peripheral sessions (PO alignment/triage, architect, plan review/drafting, and harvest)
carry a shared **read-only, worktree-confined, no-shell** grant — `Read`/`Grep`/`Glob`
allowed, `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash` denied (#235's allow/deny
matrix, `engine/src/roles/peripheral.ts`), with the guard hook's own
`checkReadContainment` (keyed off `SAPWOOD_WORKTREE_ROOT`) confining any real read to
the session's own ephemeral worktree — never a host path, `/etc/hosts`, or a
`../`-traversal. No session in this class carries a `gh`/forge credential (#218); the
engine alone executes forge writes from schema-validated structured output. The
board workflow supplies the `origin:agent` governance gate: agent-created issues land outside `Ready`,
and a human moves them to `Ready`; the dispatch code does not verify who moved the card.

**Capability/context decision rule:** within the trusted-repos threat model,
input-side prompt-injection hardening neither drives nor vetoes capability or context
choices. Prompt scope is governed by noise, size, and determinism; capability is
decided by whether its effects are enforceable at the action boundary. This is why
the zero-`gh` peripheral design (#110) was decided by enforceability, and the same
rule governs engine-injected context plus retrieval design (#215; #217, superseded —
see the guardrail/shackle criterion immediately below). Revisit input-side hardening
when untrusted-repo support is actually scheduled, as its own milestone-level
threat-model decision rather than a standing constraint on trusted-repo capabilities.

**The guardrail/shackle criterion (locked 2026-07-17, issue #238; first applied in
#234).** A mediation design for role-session information access must never deny a
request AND still demand a definitive judgment from the same session — that
combination is a shackle: it manufactures confidence from a session that was denied
the evidence to earn it. The alternative is a guardrail: explicit denial paired with
a first-class abstention/escalation path, so a session that cannot get evidence can
say so instead of guessing. This criterion is why #217's two-pass `needsDetails`
protocol (request → engine-inject → decide, with no first-class "still can't tell"
exit once details land) was superseded, pre-implementation, by #234's design: an
engine-hosted, read-only forge MCP proxy, built to widen what a session may ask for
without ever forcing a verdict once it has asked. **Three-state production model (#253,
shipped 2026-07-19):** `enabled: false` (default) stays fully inert — no proxy server is
ever constructed. `enabled: true, shadow: true` (the default once enabled) makes the
proxy mintable and journaled but attaches no real handle to any live session — the
machinery is real, production dispatch isn't. Only `enabled: true, shadow: false` is the
deliberate go-live flip: both live drivers then attach a real handle — a real
`TickDeps.fixLegResume` (`mintProxy` + `renderFixPrompt`) to the fix loop's worker leg,
and a real `RoleRunner` `defaultProxy` to every peripheral role session — two distinct
seams, not one shared mechanism. #253 wired both real consumers and ran + verified a live
shadow bring-up validating the proxy; production ships shadow-first by default, and the
flip to live is a deliberate config change, not an
automatic consequence of shipping. The criterion drove the *design*; see
[`configuration.md`](configuration.md#proxy) for the full three-state contract. The same
2026-07-17 M8 round cut two further
mechanism issues from this posture: #213 (one batched architect session — explicit
`drop`/`needs-human` verdicts per round-pool member, with an unlisted member reading
as `pass` by omission, never a forced binary judgment on every member) and #214
(gate⓪ scoped to the round pool, with a lightweight re-confirm rather than a stale
approval standing in for a judgment nobody actually re-made).

**Ambient repo context — record, don't seal (locked 2026-07-16/17, issue #236).**
Every session — worker or peripheral — runs `claude -p` inside a real repo worktree
and therefore legitimately absorbs that worktree's `CLAUDE.md`, the user's global
`CLAUDE.md`/auto-memory, and the CLI's other dynamic system-prompt sections, same as
any interactive session would (an earlier `config.ts` comment claiming peripheral
sessions got "no repo context beyond what's substituted into the prompt" was already
inaccurate and is now corrected). Applying the capability/context decision rule
above: sealing this channel would be a *content*-side intervention, and the trust
boundary stays action-side — sealing it was considered and rejected (owner ruling,
Codex concurring after challenge). The obligation is honesty and diagnosability, not
isolation: recorded for **all 9/9** `runSessionWithRetry` peripheral call sites today
— harvest, architect, plan-review (reviewer, drafter, and #214's confirm session),
retro, and (as of [#251](https://github.com/herehigher/sapwood/issues/251))
`align.ts`'s three PO sessions (`po-align`, `po-triage`, `po-pool`) — every such
session attempt assembles a **context manifest** (`roles/context-manifest.ts`, persisted in the state
DB's `context_manifests` table) recording every source among a deliberately BOUNDED,
ENUMERATED set of standard CLAUDE.md-family paths — `<worktree>/CLAUDE.md`,
`CLAUDE.local.md`, `.claude/CLAUDE.md`, every `*.md` RECURSIVELY under
`.claude/rules/`, and the user-global `CLAUDE.md` (honoring `CLAUDE_CONFIG_DIR` when
set) — never Claude Code's full resolution graph (`@import` directives,
ancestor-directory files, managed policy are NAMED in the manifest's own
`knownUnprobed`, not chased; `probedPaths` lists exactly what WAS checked). Every
present source is captured CONTENT-ADDRESSED inline, even a worktree-rooted,
git-tracked one (a resolved `gitCommit` survives only as ADVISORY metadata, never a
recoverability guarantee — a write-capable session could have modified/untracked it
before its own commit; codex review round 1 proved the original hash-only
"git-recoverable" design untrustworthy for exactly that case). The filesystem-derived
half (sources, worktree HEAD, hook content) is captured as early as the engine can
observe it — anchored to the session's OWN stream-json init line (polled from its
still-growing jsonl), NEVER at session teardown, and NEVER a bounded wait for the
worktree directory to merely exist (an earlier version of this fix used that anchor;
a focused-suite run caught the resulting race live — directory existence does not
imply checkout-complete). A `captureBasis` field (`"init-observed"` vs.
`"timeout-fallback"`) names which anchor actually fired, so a session that never
reported an init line in time is never silently treated as equally reliable — while
the model/CLI/tool-inventory/MCP half is the session's own stream-json self-report,
read post-exit (with an explicit `modelSource` discriminator — never a silent
substitution). The worktree's resolved HEAD uses a pure-filesystem, NAMESPACE-AWARE
git-plumbing read matching git's actual layout: every `refs/*` is shared (resolved
from the common store only, never a stale worktree-local shadow) EXCEPT the three
genuinely per-worktree namespaces (`refs/bisect`, `refs/rewritten`, `refs/worktree`),
which resolve worktree-local only (an earlier version of this fix inverted that
default, treating only heads/tags/remotes as shared; this engine structurally never
execs `git` outside the two pinned subprocess call sites, #69). Rows are keyed by
`(round, phase, role, session, attempt)` — the same tuple the separately developed
input-manifest work (#231) will eventually join on; the two ship independently by
design. Isolation remains the correct tool, but only for **benchmark** runs (a clean
throwaway directory with explicit `--system-prompt`/`--add-dir`/`--mcp-config`
injection — `--bare` is MANDATORY in that recipe, not optional, since only it makes
passed flags the sole inputs) — never production, since `--bare` also disables hooks
and the guard hook is the actual safety boundary. See
[`security.md`](security.md#ambient-repo-context-record-dont-seal-236) for the full
model and the isolation recipe.

**Honest framing (2026-07-17, issue #238).** This same broad, recorded read access is
what makes architecture-debt detection possible at all — the architect role (and any
future audit-shaped role) forms its drift/contradiction judgment from the SAME
ambient repo/doc access every session already has, not from a separate,
more-privileged audit grant. sapwood has no standing "audit role" with elevated read
scope; if one is ever justified, it is an addition to this recorded posture, not
evidence that today's posture was incomplete.

The committee's keystone finding remains: 0day's guard was built for a *trusted* model
on a *private* repo. v1 stays in that deployment context, **but we build the seams so
public-repo hardening is additive, not a rewrite.** v1 requirements:

- **Guard port hardening (M1, ships green before anything autonomous runs):**
  `guard.ts` is a **zero-dependency** module; reproduce 0day's ~100 bypass cases
  **and** add differential/fuzz testing against `guard.py` on random shell strings
  (the tokenizer divergence — `shlex` vs TS — is the real bypass surface, e.g.
  `guard.py:36-93`). **Fail-closed on hook error/timeout/malformed output** is a
  tested requirement. Engine must use `execFile`/`spawn` with arg arrays — never
  `child_process.exec`/`shell:true`.
- **Structural producer≠merger (not just the argv guard):** the merge is always
  executed by the Conductor, never the worker (matches 0day's `loop_merge_driver.sh`),
  backed by branch protection + a merge identity distinct from the worker, so the
  invariant holds even if the guard is bypassed. gate② is a fresh non-author review from
  the configured reviewer kind (hosted Codex by default, or trusted/human/engine-agent);
  produce-PR-and-stop (human merges) is the conservative selectable mode.
- **Protect the boundary from worker `Write`:** path-level deny on
  `.claude/settings.json` (hook wiring) and `.github/workflows/**`; **human-merge-only**
  for any change to `guard.ts`, hook wiring, `reviewer.ts`, or security config
  (closes the self-dogfooding risk: a worker weakening its own guard).
- **Two-tier cost control — soft per-worker budget, hard engine ceiling:**
  - *Per-worker budget is **soft**.* Reaching it never SIGKILLs a worker mid-step
    (that burns the spend **and** throws away the work). Instead it triggers a
    **graceful handoff**: finish the current atomic step, commit + push WIP, write a
    structured progress note (done / remaining / how to resume) to the PR/issue, drop
    a `.handoff` sentinel carrying the resumable `session_id`, then exit clean. The
    Conductor treats handoff as "incomplete, resumable" and may `--resume` later. Work
    is always durable because the worker checkpoints (commit + push + note) at **every
    green step**, not just at exit — so the latest pushed state is itself a handoff.
    This improves on 0day, which passes `--max-budget-usd` as a hard cut
    (`loop_worker.sh:81`) and only has crash-`--resume` (no pre-budget handoff).
    **Auto-enforced (#33) via live token estimation:** stream-json carries no in-progress
    `total_cost_usd` (only the terminal result line has it), so `worker.ts` accumulates a
    running USD estimate from every streamed `assistant` message's token usage — priced by a
    small, explicitly-marked-as-an-estimate per-model rate table (the shipped `pricing.yaml`,
    user-overridable via `worker.pricingFile`, loaded fail-closed by `pricing.ts`) — and calls the
    same `requestHandoff()` the operator/drain path uses once the estimate crosses
    `worker.budgetUsdSoft`. Cache-read tokens are priced at the cache-read rate, not the input
    rate, so a cache-heavy run doesn't look artificially expensive and hand off prematurely.
    The estimate is reconciled against the real terminal `total_cost_usd` when it lands (the
    divergence is logged, never enforced) — real billing can diverge from the table (repricing,
    discounts, cache-TTL differences), so the estimate is a trigger signal, not a source of truth.
  - *Engine ceiling is **hard**.* A cumulative/daily USD cap + wall-clock cap in the
    conductor (independent of the drift-prone CLI `--max-budget-usd`), with auto-drain
    on breach + an out-of-band kill switch. This is a **safety boundary** for runaway
    spend, not routine cost management — prefer drain (let in-flight workers hand off)
    over kill; hard kill is the last resort. Conservative defaults (small round budget,
    dispatch cap 1–2).
- **Issues-only peripheral role sessions carry no shell and no forge credential
  (#110; read grant widened to worktree-confined by #235, 2026-07-17):**
  plan-reviewer, plan-drafter, PO/align+triage, harvest, and architect hold no
  `Bash` tool grant and no `gh`/forge credential of their own — decisions are
  computed from prompt-injected content plus a real, but worktree-confined,
  `Read`/`Grep`/`Glob` grant (#235), never a live `gh` call. Every role in this
  class shares the SAME allow/deny pair, enforced two ways: `--allowedTools`/
  `--disallowedTools` at spawn, and the guard hook's own `checkReadContainment`
  (keyed off `SAPWOOD_WORKTREE_ROOT`), which resolves a `Read`/`Grep`/`Glob` target
  only inside the session's own ephemeral worktree — a live-tested containment
  (absolute host paths, `/etc/hosts`, `../`-traversal all denied; in-worktree reads
  succeed). Each session's final message ends in a structured, sentinel-delimited
  output block; the deterministic engine parses it, validates it against a
  per-role zod schema plus cheap content invariants, and performs every GitHub
  write itself via `IForge`, fail-closed (ambiguous/duplicate/out-of-candidate-set
  output rejects the WHOLE attempt, retried once, then the role's degrade path —
  gate⓪ escalates `needs-human`, advisory roles proceed with a durable event).
  Because no shell exists for these sessions, the string-level Bash-pattern bypass
  classes (short-flag aliases, quoting/escaping) earlier hardening chased one glob
  at a time are moot for them — closed by removing the capability, not a better
  pattern. `retro` stays worker-class (`Read`/git + `gh pr create`, proposals land
  exclusively as PRs) — out of this design's scope by session class; its own
  hardening is #111. **The write/shell/credential boundary is unchanged by #235's
  read widening — only what a session may *read* grew, never what it may *do*.**
  Full model: `docs/security.md`'s "Issues-only role sessions: read-only,
  worktree-confined, no shell" section.
- **Designed-for-public seams (built as interfaces in v1, enforced in v1.1):**
  scoped ephemeral GitHub App tokens per worker (replacing host `gh` auth); a written
  threat model treating issue text as hostile data; fixing the public-repo merge-gate
  hole so `MERGE_OK` requires an *allowlisted* reviewer, not any non-author review
  (`pr_gate.sh:240-242` vs `loop_merge_driver.sh:33-34`).

### Validation depth ∝ decision weight (the structured-output write inventory)

**The principle.** Judgment flows back into the deterministic engine through exactly
one channel: a role session's structured output (a sentinel-delimited JSON block +
optional raw body — `structured-output.ts`, or, for `retro`, a fixed scratch file).
The engine validates *format* and *permission*, never *decision quality*. So as a
role's output gains **decision weight** — the moment its fields start driving a
dispatch-gating label, a config change, or dispatch order rather than an advisory
comment — the engine-side validation of that output **must deepen in proportion**.
Otherwise a de-facto conductor agent quietly reassembles itself through the
structured-output pipe, unnamed and ungoverned: the containment #110 bought by
removing every role's tool grants is only as strong as what the engine chooses to
honor from what those roles now *say*.

This inventory is the standing safety baseline. **Every future "bring judgment in"
change — a new role, a wider schema, a role output newly wired to a heavier write —
updates the table below in the same PR**, and gate② checks that it did. If a field's
decision weight rises a rung (comment → label → dispatch order → config), its
validation column must show a matching deepening (schema-only → schema + content
invariant → schema + cross-check against an engine-computed set / bound), or the
change doesn't ship.

The inventory below is current as of #119. Each row: the role, which
structured-output fields drive which `IForge` write, the validation gating that
write, and today's decision weight.

| Role | Output fields → engine write | Validation (`engine/src/…`) | Decision weight |
|------|------------------------------|-----------------------------|-----------------|
| **PO / decompose (#310)** | `outcome:"decomposed"` + bounded child set + coverage mapping → fence parent (`decomposed`, Todo, no round-pool), then `createIssue`, child governance labels/comments, `addSubIssue`, and one parent coverage comment. `outcome:"unresolved"` → advisory parent comment only. | `DecomposeOutputMetadataSchema` (strict two-branch union) + `validateDecomposeOutput`: `maxChildren`, exact body cardinality, unique titles, complete/in-range coverage and dependency indices, ready-child acceptance criteria + verification section, and honest planless remainder metadata. The proposal set is journaled before child creation and reconciled by body marker and receipts. | **Medium, pre-Ready** — the session chooses backlog child boundaries, but cannot make any child dispatchable: every child starts outside Ready; planless remainders also receive `needs-human`. The parent fence is engine-computed from the human `split` signature, never session-selected. |
| **plan-reviewer** | `decision`∈{approve, draft_request, verify_na} + `issue` + optional body → `updateIssueBody` + `addLabel(plan:approved)` (approve); `addLabel(needs-human)`+`addLabel(verify:n/a)`+`addIssueComment` (verify_na); routes to drafter **and posts the reviewer brief via `addIssueComment`** before the drafter runs (draft_request) — `plan-review.ts:352-384` | `validateReviewerOutput` (`plan-review.ts:164`): `PlanReviewerMetadataSchema` (strict zod) **+ content invariant** — `extractVerificationPlan` must find a plan in the approved body **+** issue-number match to the expected candidate | **High** — `plan:approved` is the gate⓪ dispatch key; a false approve dispatches an unverifiable issue. Deepest validation (schema + content + identity). |
| **plan-drafter** | `issue` + body (revised issue body, required) → `updateIssueBody` only — `plan-review.ts:422` | `validateDrafterOutput` (`plan-review.ts:205`): `PlanDrafterMetadataSchema` (strict) + non-empty body + issue-number match **+ content invariant** — `extractVerificationPlan` must find a verification/acceptance section in the drafted body (`plan-review.ts:224-226`) | **Medium** — writes the body but **never** the `plan:approved` label (author ≠ approver, #77 Amendment 2); the reviewer must independently re-approve before dispatch, so the drafter's write is always re-gated. |
| **PO / aligning** | *align mode:* `issues:[{title}]` + per-issue bodies → `createIssue` + `addLabel(origin:agent)` + `addLabel(needs-human)` when planless + `addIssueComment` — `align.ts:291-304`. *triage mode:* `issue` + drafted body → `updateIssueBody` + `addIssueComment` — `align.ts:351`. *both modes, #237:* optional `concerns:[{issue, reason}]` alongside the deliverable above → `addIssueComment` only, via `dissent.ts::postConcerns` (triage concerns dropped if their decision was itself discarded — stale-hash refusal / decision-lost — 2026-07-18 adjudication finding 6) | *align:* `validateAlignOutput` (`align.ts:138`): `AlignMetadataSchema` (strict) + per-issue body split; **post-write plan check** — a planless creation earns `needs-human` at creation time (`align.ts:297-304`). *triage:* `validateTriageOutput` (`align.ts:184`): `TriageMetadataSchema` (strict) + issue match + non-empty body — **deliberately no plan invariant** (pre-#110 semantics preserved): the drafted body is written via `updateIssueBody` first, then a plan-conditional success comment (`align.ts:351-356`); a still-planless draft records `triage-degraded` (no label, no success comment) and re-matches triage next round. *concerns (#237):* `dissent.ts::validateConcerns` — **set cross-check**, same doctrine as harvest's below: every `issue` must be inside the session's own injected view — the rendered backlog-digest subset for ALIGN mode; the target issue ONLY for TRIAGE mode (narrowed 2026-07-18, finding 7, to match the prompt's own contract) — or the whole batch is rejected; one concern per issue per session | **Low (pre-Ready)** — a created issue structurally cannot carry a dispatch label (engine applies labels, session has no channel); planless creations are fenced `needs-human`, planless triage drafts stay undispatchable via gate⓪'s `plan:approved` requirement; degrade proceeds (low stakes, next round retries). *concerns:* **lowest possible — comment-only, by construction.** No schema field a concern carries maps to any label/status/dispatch write path (there is none in `dissent.ts` to map to); delivery is idempotent by a deterministic marker (issue + a hash of the concern's wording **and** the concerned issue's body at post time, so a why/what edit re-arms the same worded concern — including an edit this SAME engine made, since the outcome, `body-changed`, deliberately carries no human-attribution claim). A missing durable receipt behind an already-live marker is reconciled in place rather than lost (finding 3), and `dissent.ts::reconcileDurableConcerns` (2026-07-19 round-2 adjudication, findings 1+2) durably sweeps the SAME thing across the whole ledger every round — the backstop for a concern whose decision reached its terminal receipt before `postConcerns` ever delivered it — always attributed to that decision's own original round, never the round the sweep runs in. Adjudication (`closed`/`external-reply`/`body-changed`) runs as its own round-level scan, unconditional on `roles.po.enabled` (finding 5); `closed` and `body-changed` are BOTH neutral/unattributed (2026-07-19, finding 3 — the conductor's own `Closes #N` merges can close an issue exactly like a human would), leaving `external-reply` as the only outcome with any actor claim at all (and even that is "not this engine," never "a human specifically"). |
| **architect** | `contradictions:[{issue, severe}]` + design note + per-issue explanations → `addIssueComment(anchor, designNote)`; per contradiction `addIssueComment` + `addLabel(blocked)` when `severe` — `architect.ts:387-390` | `validateArchitectOutput` (`architect.ts:235`): `ArchitectMetadataSchema` (strict) + `parseArchitectBody` fail-closed sub-format parse (`architect.ts:190`; own-line `<<<CONTRADICTION #n>>>` markers, no embedded sub-delimiters) **+ set cross-check** — every flagged `issue` must be inside the engine-computed candidate set or the whole output is rejected before any write (`architect.ts:270-278`) | **Medium** — the `blocked` label gates dispatch of the flagged issue; the design-note comments are advisory. Validation matches: schema + structural body parse + candidate-set bound on the label target; the prose itself carries no truth check. |
| **harvest** | `comments:[{issue, body}]` → `addIssueComment` only — `harvest.ts:347` | `validateHarvestOutput` (`harvest.ts:217`): `HarvestMetadataSchema` (strict) **+ set cross-check** — every `issue` must be in the engine's pre-computed `needsHumanIssues` set (`gatherRoundFacts`, fixed *before* the session); any out-of-set number fails the **whole** batch | **Low** — comment-only, and the session's target choice is **bounded** by the engine-computed set: it may brief any subset (including none — an empty `comments` array is valid) but can never add an out-of-set target. No labels, no dispatch effect — the set cross-check is the guard against write-target choice leaking beyond the engine's bound. |
| **retro** | Scratch file (`.sapwood-retro-pr`), not the JSON block: `branch`/`title`/`body` or `none` → `openPR(branch, title, body)` — `retro.ts:377` | `parseRetroScratch` (`retro.ts:141`): fail-closed labeled-header parse + `invalidBranchReason` (no default-branch, no `..`, argv-safe) **+ engine-side `forge.branchExists`** push verification before `openPR` (a session's push claim is never trusted) | **Low at write, gate②-bound** — a proposal is *only* a PR; it changes nothing until gate② (CI green + fresh non-author review) merges it. The heavy validation here is authenticity (branch really pushed), not decision quality — correctly, since the merge gate owns the quality call. |

Reading the weight column top-down is the whole point: the one **High**-weight output
(plan-reviewer's `plan:approved`) carries the deepest validation (schema + content
invariant + identity), and weight falls in step with validation down the table. A
future change that inverts that ordering — a heavier write behind lighter validation —
is exactly what this principle exists to catch.

For the full per-role contract behind this table (responsibility, write-scope tier,
marker idempotency, output schema, escalation path) see
[`docs/role-paradigm.md`](role-paradigm.md).

## Onboarding / DX (v1)

- **`/sapwood-init` + `sapwood init`** must be credible and idempotent:
  1. **Auth preflight:** `gh auth status` + check `project` scope; if missing, print
     the exact fix (`gh auth refresh -s project`) and exit cleanly.
  2. **User-vs-org detection** before any ProjectV2 mutation.
  3. **Idempotent, recovery-safe provisioning:** detect existing board/fields/options
     before creating; tolerate partial failure; safely re-runnable. (0day stops here
     and asks the human to make the board by hand — `bootstrap_github.sh:89`; we
     automate it.)
  4. Writes a starter `sapwood.config.yaml` (with explanatory comments) and wires the guard hook.
- **First-run trust ramp** (the missing safety UX): a `--dry-run` that lists issues
  it *would* dispatch + estimated cost; a **"watch one issue" supervised mode** that
  pauses after worktree/PR/review for explicit confirmation (the recommended first
  run); a cost preview; a documented kill switch (`/sapwood-stop drain` semantics,
  including what happens to in-flight workers).
- **Reviewer/cost legibility:** first run prints which reviewer/mode is active and its
  cost implication.
- **Minimum doc set (release gate, not polish):** Getting Started (clone → first PR,
  every prerequisite), Config reference, Conceptual model (3-layer loop, sentinel,
  producer≠merger — in English), Troubleshooting (auth scope, session-death worker
  loss, board partial-failure, budget exhaustion, stuck PR), Security model.

## Build sequencing (planning only)

- **M0 — Skeleton + config + forge:** ✅ **delivered (PR #22).** plugin manifest,
  `sapwood.config.yaml` schema + Zod + defaults, `IForge` interface + `GithubForge`
  (all hard-coding removed), SQLite (WAL) state layer with schema versioning. **Stack
  locked here** (see "M0 stack" above). `getReadyIssues` and `setBoardStatus` fail
  closed until the M2 ProjectV2 query, so no half-wired board access ships early.
- **M0.5 — Minimal onboarding:** ✅ **delivered (PR #24).** `sapwood init` (auth
  preflight, user-vs-org, idempotent board/label/milestone provisioning incl. the
  `verify:n/a` label, config write). Provisions the **inputs** for the Decision #8
  `Ready` gate (the `verify:n/a` label, board lanes); the gate is *enforced* once
  `getReadyIssues` is implemented in M2 (it fails closed until then). Automates the
  manual board step 0day left to the human (`bootstrap_github.sh:89`). Key behaviors
  (see "M0.5 init" above). Early so real users can try it and feedback the config
  schema before it locks.
- **M1 — Guard port (safety first):** ✅ **delivered (PRs #27, #28).** zero-dep
  `guard.ts` + reproduced bypass suite + differential/fuzz tests + fail-closed-on-error
  + `Write`-path protections. Nothing autonomous ships before this is green. Key
  decisions in "M1 guard" above. Live hook wiring into worker sessions landed in **M2
  (#26)** — see "M2 engine core" above.
- **M2 — Engine core:** ✅ **delivered (PRs #30, #32, #34; dogfood #35→#36).**
  `conductor.ts` (tick: reclaim→drive→resume→dispatch, structured results, parity core), `worker.ts`
  (headless `claude -p` in a worktree), and the guard **wired live** into worker sessions
  (#26, hard-default/soft-opt-in). Parity tests against 0day's pure-function tests
  (`test_loop_conductor.sh`); **dogfooded end-to-end** (claim→worktree→TDD→PR, guard live, no
  self-merge). Key decisions + deferrals (#31/#33/#37) in "M2 engine core" above.
  `merge_decision` + parity vs `test_loop_merge_driver.sh` move to M3 with the merge-driver.
- **M3 — Review gate + merge modes:** ✅ **delivered (PRs #41, #42, #43, #44; hardening
  #39, #40).** `reviewer.ts` + `merge-driver.ts` with the **0day-style default**:
  autonomous-merge gated on a fresh non-author Codex review (gate②) + CI green (gate①),
  merged by the Conductor; produce-PR-and-stop selectable. Pluggable reviewer
  (different-model Codex / same-model-trusted-only / human; engine-agent added in M10 —
  Decision #10), engine cost ceiling + kill switch (#14), rollback hardening (#31). 23-case
  parity vs `test_loop_merge_driver.sh`;
  `--match-head-commit` TOCTOU pin. Key decisions + deferrals in "M3 review gate + merge
  modes" above. ~~Live end-to-end merge-gate run moves to M4 with the loop driver.~~
- **M4 — UX surface + CLI:** ✅ **loop driver delivered (#46, PR TBD):** `driver.ts`
  runs `tick()` on `cfg.engine.tickIntervalSec`'s cadence (wired into `TickDeps` so the
  wall-clock ceiling sees the real cadence, not its floor default), stops cleanly on
  SIGINT/SIGTERM after the in-flight tick (never mid-tick), and supports `--once` /
  `--until-idle` alongside the daemon default — `sapwood run [--once|--until-idle]` in
  `cli.ts`. Resumed per-leg cost is recorded directly in `State.recordSpend` (see M3
  section above), and #172 wires capped handoff reentry into `tick()` before DISPATCH.
  gate② now carries the issue's verification plan into the review trigger (Decision
  #8, see M3 section above). **Reviewer failover (#54):** an explicit, ordered,
  opt-in `reviewer.fallback` list (e.g. `[same-model-trusted, human]`) + a
  `reviewer.failoverAfterSec` threshold — when the primary reviewer stays
  non-decisive/unavailable past that threshold, gate② hands off to the first
  fallback reviewer whose OWN mode semantics reaches a decisive verdict (reused,
  never forked), announces a structured event + PR comment naming which mode is
  now gating (deduped against the event log — one announcement per episode
  transition), and reverts to the primary for new verdicts once it recovers. A
  fallback-obtained approval stays valid for its exact head across transient
  non-merge ticks and engine restarts, but it is **advisory, never
  verdict-bearing**: at every use it is re-verified against live PR data through
  the recorded mode's own rules (a forged state-DB row synthesizes nothing), and
  the always-blocking signals — unresolved threads, a standing
  `CHANGES_REQUESTED` from anyone — block regardless of any failover state
  (failover never weakens gate②, silently or otherwise). `fallback:
  [same-model-trusted]` with an empty `trustedReviewers` is rejected at parse
  (it could never fire). Empty `fallback` (the default) is byte-for-byte the
  pre-#54 behavior: an unavailable primary queues the PR forever, no silent
  degradation. **Review-silence visibility (#170):** a current-head review that stays
  non-decisive past `reviewer.escalateAfterSec` (24h default) gets the configured `labels.needsHuman` PR
  label plus a structured event. The label is the latch and routes through the existing
  human hold/re-entry behavior; the lane remains driving, polling continues, and gate②
  is never softened. Configured failover receives its full evaluation window first.
  **Adjudicated findings stop re-consuming fix rounds (#378, F14):** gate② used to see
  review threads only as an aggregate unresolved COUNT, so a finding that had already
  been human-adjudicated and thread-resolved re-entered the FIXABLE gate every time a
  re-review raised it again — on PR #366 the same config-YAML finding cost five fix-round
  evaluations, two of them from reviews against a stale head. `PRReviewData` now carries
  each thread's span (`path`/`line`/`originalLine`), GitHub's own `isOutdated` staleness
  field, a digest of the originating comment identifying WHICH finding the thread is
  about, and the commit that comment was anchored to, all from the SAME paged read that
  already produced the count. An unresolved thread carrying the same finding at the same
  span as an already-resolved thread whose code has not moved since is an *adjudicated
  re-raise* and is excluded from the blocking count. The key is deliberately (finding,
  span) and never a thread id — a re-raise always arrives as a brand-new thread — and
  never a span alone: two unrelated findings can share a line, and a span-only key would
  drop the second, never-adjudicated one out of gate② input (the defect PR #445's review
  caught in the first revision of this work). Because a review bot emits prose rather
  than a typed rule id, the finding comparison is a last-resort text digest, kept at
  whitespace normalization only so it fails toward *not* recognizing a reworded re-raise
  (one more fix round) rather than toward collapsing two distinct findings (a suppressed
  finding). Nothing always-blocking is weakened: a
  resolved thread whose code CHANGED after resolution reads as outdated and its re-raise
  still blocks, an unresolved thread with no prior adjudication on its span still blocks,
  a standing `CHANGES_REQUESTED` still blocks, and absent thread data filters nothing at
  all. A review submitted against a non-current head was already excluded from both
  halves of the gate; that exclusion is now counted and reported rather than emergent.
  Both exclusions are named in the FIXABLE outcome's reason — a filter that silently
  shrank gate② input would be the invisible weakening this project refuses. Delivered in
  two halves because the consuming code is human-merge-only: the `forge.ts` data plumbing
  through the normal loop, the `reviewer.ts`/`merge-driver.ts` consumption as a
  human-apply patch (`docs/patches/378-resolved-thread-head-freshness.patch`).
  **Commands + status CLI + first-run trust ramp delivered
  (#15, PR TBD):** `sapwood status [db-path]` reads the SQLite state DB directly (no
  live engine session) and reports active lanes, PRs awaiting the review gate, spend
  vs. the daily ceiling, and kill-switch state; `sapwood run --dry-run` resolves config
  and reports what would dispatch this round + a cost preview, spawning nothing and
  writing no state — the first-run trust ramp's "see before you run" step. Plugin slash
  commands `/sapwood-run`, `/sapwood-status`, `/sapwood-stop` are thin wrappers in
  `commands/` that shell out to the CLI (`/sapwood-stop` flips the documented
  kill-switch file sentinel — see Security model). Supervised "watch one issue" is the
  existing `--once` mode plus leaving a single issue `Ready` on the board, not a new
  subsystem. **Node.js 22 → 24 (#73):** the engines floor, `.nvmrc`, and CI now match
  the `node:sqlite` requirement stated since M0 — a housekeeping catch-up, not a
  behavior change. **File-based worker prompt (#74):** `worker.promptFile` lets an
  operator replace the shipped `prompts/worker.md` (TDD + two-gate method) with their
  own template, resolved relative to the config file's own directory so the same config
  behaves identically regardless of invocation cwd. The template is loaded and rendered
  eagerly at startup — before any dispatch — so a missing/unreadable/empty file or an
  unknown `{{var}}` is a fail-fast startup error, never a silent fallback to the default
  or a lazily-discovered break mid-run; `sapwood validate` runs the identical check.
  This is also the prerequisite v0.2's self-evolution path needs (below): a
  peripheral role rewriting a prompt has something concrete to open a PR against.
  **PAUSE sentinel (#75):** a second, gentler human control alongside the kill switch —
  `data/PAUSE` freezes new lane dispatch only, while everything already in flight
  (running workers, PRs already moving through the review/merge gate) proceeds exactly
  as normal; no drain, nothing killed. Distinct from the kill switch's strict freeze +
  drain (if both are present, the kill switch's behavior governs). Wired into
  `/sapwood-stop --pause`/`--resume` and `sapwood status`'s `pause: …` line. See
  `docs/security.md` for the full two-tier control model. **Goal-based stop conditions (#76):** optional `stop.afterIssuesMerged` /
  `stop.afterPRsOpened` / `stop.onMilestoneComplete` config (each overridable by a
  matching `--stop-after-issues` / `--stop-after-prs` / `--stop-on-milestone` CLI flag)
  are FINAL break conditions — "when is this run complete" — not a change to the loop's
  unit (still one issue = one lane). Hitting any one (OR semantics, first hit wins)
  converts the rest of the run into the same until-idle wind-down `--until-idle` already
  uses: stop dispatching new lanes, let every in-flight lane finish on its own (never a
  mid-work kill), then exit, naming the condition that fired. Applies on top of
  `--once`/`--until-idle`/the daemon default; standalone from `--dry-run`. Counted from
  *this run's* tick results only (a restart starts every counter back at 0), with no new
  SQLite table: issues merged and PRs opened (a lane's first reclaim into `driving`, the
  earliest point the engine can see a PR exists) both come straight off `TickResult`;
  milestone completion is one small `IForge.countOpenIssuesInMilestone` read per tick.
  **Docs set delivered (#16):** `docs/getting-started.md`, `docs/configuration.md`,
  `docs/security.md`, `docs/troubleshooting.md`, plus a plugin-facing
  `.claude-plugin/CLAUDE.md` for a calling model, and the `origin:agent` label
  (provisioned by `init`, see the v0.2 chapter and `docs/security.md` for what it's
  for). Guard defense-in-depth for the `data/KILL_SWITCH` / `data/PAUSE` sentinel write
  paths (#81): direct `Write`/`Edit` and Bash `touch`/`rm`/`mv`/`git rm`/redirect vectors,
  plus a sentinel path as a literal argument to any command, are now blocked in
  `guard.ts`; a script that hardcodes the sentinel path in its own source (no CLI
  argument) remains an open residual — see `docs/security.md`'s isolation-boundary note.
  **Soft-budget auto-enforcement via token estimation (#33):** `worker.ts` accumulates a
  running USD estimate from every streamed `assistant` message's token usage (input/output/
  cache-write/cache-read — cache reads at the cache-read rate, not the input rate, so a
  cache-heavy run doesn't over-trigger) and calls the existing `requestHandoff()` graceful path
  (SIGTERM -> `.handoff`, resumable, never a hard kill) once the estimate crosses
  `worker.budgetUsdSoft`. Rates are NOT hardcoded in source (PR #85 human review): they live in
  a user-editable YAML — the engine ships a commented `pricing.yaml` default, overridable via
  `worker.pricingFile` (relative paths resolve against the config file's directory, the exact
  #74 promptFile pattern; missing/malformed = fail-fast startup error, never a silent fallback)
  — loaded once at supervisor construction by `pricing.ts`. The estimate is reconciled against
  the real terminal `total_cost_usd` when a lane finishes — the divergence is logged, not
  enforced; the rate table is explicitly a hand-maintained snapshot (see `pricing.yaml`'s
  header), not a live pricing lookup. **Live end-to-end verification delivered (#46),
  closing M4:** on the sapwood repo itself, the driver ran at real cadence with the
  wall-clock ceiling seeing it; gate② carried the issue's verification plan on every
  review trigger; the **first autonomous conductor-merge** landed (PR #51 for issue
  #49 — TOCTOU-pinned, gated on CI green + an identity-gated, pin-fresh Codex
  verdict, lane→done, board→Done, driver exited idle); and a live kill-switch drill
  (flipped mid-work) terminated the worker, froze dispatch, drove the orphaned PR
  through a full gate afterwards, and held state across three driver restarts. The
  drill did what live verification is for — it surfaced real gaps the offline suite
  couldn't (unwired verdict shapes, a merge path the kill switch didn't yet freeze,
  unrecorded killed-worker spend), all since fixed in v1 (the drain-path gaps via the
  #69 redesign, above). **M0–M4 are all delivered and closed; v0.2 is the only open
  milestone.**
- **v0.2 (post-v1) — the open milestone, two workstreams.**
  **① Dashboard, built BY sapwood (flagship dogfood, #17):** drive the
  entire dashboard build through sapwood's own loop on the sapwood repo, and
  **record the run** as the launch artifact. Scope: event schema + `GET /api/loop/state`
  & `/events` (current-state, from SQLite) → React views (lane board, event feed)
  reusing 0day's TanStack Query polling + replay player + charts (chart/domain
  components are *new* design, not a port). History-aggregation metrics
  (merge/rework/cycle-time) are a later phase, gated on the GitHub-history work 0day
  never finished (`ops/loop/README.md:109`). Because workers may touch security-
  sensitive files, the human-merge-only rule for guard/hook/reviewer/security config
  (see Security model) stays in force during this dogfood. The frontend itself —
  scope decisions, information architecture, visual identity, motion/copy specs,
  and the API data contract — is specified in [`frontend-design.md`](frontend-design.md).
  **② Round orchestrator (#86–#91, wired #104),** cut from the locked design in the
  v0.2 chapter below: the round ledger + round-loop skeleton — two-level termination,
  rerun-not-resume (#86); the peripheral role runner — issues+docs write scope,
  idempotent round markers (#87); gate⓪, the verification-plan quality gate —
  `plan:approved` dispatch requirement + the plan-reviewer (#88); the PO role — goal
  alignment / decomposition + plan-drafting triage (#89); the architect role — round
  design/review (#90); and harvest + retrospective — self-evolution via PR + gate②
  only (#91). **#104 closed the wiring gap #100/#101/#103's gate② reviews deliberately
  deferred:** all four peripheral roles (PO/aligning, architect, harvest, retro —
  gate⓪'s plan-reviewer already ran in `runRounds` since #87) are now constructed by
  one factory (`round-defaults.ts`'s `createDefaultPeripherals`) sharing a single
  `RoleRunner`/`State`/forge, feeding the architect stub the PO pass's own output where
  available; a shared `runSessionWithRetry` helper (`peripheral.ts`) replaced four
  hand-rolled outcome-check → retry-once → degrade-visibly loops with one; gate⓪
  escalations now also land in the durable event log (`plan-review-escalated`), so
  harvest/retro's round summaries see BOTH gates, not gate② alone; `roles.architect`
  gained a real `planMdPath` config key (was hardcoded to this repo's own
  `docs/PLAN.md`); and `roles.retro.everyNRounds` (default 1) lets operators thin the
  retrospective cadence. **#106 closed the wiring gap this note used to flag:**
  `sapwood run` now drives the round orchestrator (`runRounds` + `createDefaultPeripherals`,
  a real `RoleRunner`) by DEFAULT (`engine.driver: "rounds"`, config.ts). The M4
  tick-driver (`runDriver`) stays reachable via an explicit escape hatch
  (`engine.driver: "tick"`) until a live dogfood run has validated the round path —
  same CTO-call bias as everything else in this section (rounds is the destination,
  the tick driver is the safety net during the transition). `cli.ts`'s `runEngine`
  dispatches on the resolved config; both paths share the same safety primitives
  (KILL_SWITCH, cost ceilings, drain-before-kill, graceful-stop-still-runs-harvest)
  unchanged — round.ts/state.ts own that logic, `cli.ts` only wires collaborators.
  `--once`/`--until-idle` remain tick-driver-only flags (a round has no single-tick
  concept) — under the rounds default they FAIL FAST at startup (exit 1, zero
  dispatch, error naming the `engine.driver: tick` escape hatch and the `--stop-*`
  alternatives), never silently ignored (gate② P2 on the #106 PR: a trust-ramp user
  typing `--once` must never silently get a long-running round loop instead of a
  bounded tick); `--dry-run` and the `stop.*` final conditions apply to both.
  **#128 promoted the architecture-doc path to a top-level `goal.file` config key** — the
  loop's north-star goal file (Goal / Non-goals / Constraints / Current milestone),
  read by both the aligning (PO) and architecting peripherals, and cited by retro
  proposals as their basis. `roles.architect.planMdPath` (#104, above) is deprecated
  back-compat only: config load reconciles the two into the single resolved
  `cfg.goal.file` every consumer reads (hard error if both are set and disagree; one
  deprecation line if only the old key is set). `sapwood init` scaffolds a starter
  template at the resolved path **iff it's missing** — the onboarding step for a repo
  with no `PLAN.md` yet (see [`configuration.md`](configuration.md#goal)).

  **M6 review-knowledge + environment resilience (2026-07-14):** `#167` shipped the
  repo-level **review doctrine** (`doctrine.file`, default `docs/REVIEW-DOCTRINE.md`,
  scaffolded-iff-missing like the goal file) injected into four prompt surfaces: worker
  brief, architect pass, gated-reentry-cap escalation comment, and the gate② review
  trigger comment (reviewer.ts leg human-merged). Decision recorded on `#178`: the
  doctrine file is deliberately NOT guard-protected — the reviewer applies the doctrine
  loaded at engine construction (never the PR branch's version), so a doctrine-weakening
  PR can't self-approve; a seed invariant tells reviewers to flag doctrine-touching PRs
  toward `needs-human`. `#168` shipped **environment-failure park**: deterministic
  signature classification (structured terminal/error records + stderr only, never
  assistant text) splits "environment broke" from "task broke" — env failures never
  label `needs-human`, never burn reentry attempts; the engine parks (SQLite
  `park_state`, one row per source llm|forge, restart-safe), probes with bounded
  backoff (forge: free read; LLM: a stripped budget-capped `haiku` "pong" ping —
  ~$0.016 measured — suppressed while paused or ceiling-breached), and recovery is
  **episode-continuous**: a green ping only unlocks a single canary lane, only a
  canary reaching a non-env terminal clears the episode, drains release the canary
  as INCONCLUSIVE (never false-clear, never wedge), and duration-based human
  escalation (`parkEscalateAfterSec`) is additive — probing and auto-resume continue
  after it. Channel ladder: forge up → issue comment; forge down → local-only
  (status + `data/ESCALATION` marker + log); while forge-parked, env-failure
  requeues and escalation are write-suppressed (frozen durable, never degraded to
  `needs-human`) — in-flight DRIVE activity and non-env rollbacks keep their
  existing retry behavior. **#216 made PO issue creation persist-first and
  per-proposal idempotent:** the validated proposal set is durably journaled before
  any forge write; each successful creation gets a durable receipt only after its
  governance labels/fence/comment complete; a deterministic HTML body marker reconciles
  the remaining accepted-write/lost-receipt window; and a normalized-title collision
  against the open backlog is durably
  skipped. A crash-rerun with a persisted proposal set skips the aligning session
  entirely; externalization replays the journaled set and creates only proposals
  without a receipt or marker.

## v0.2 north star: the round orchestrator

Locked design (2026-07-08, issue #77; gate⓪ amendment locked 2026-07-09) for v0.2's
second axis — alongside the dashboard, v0.2 also introduces a **round orchestrator**:
a layer *above* the tick engine that adds peripheral roles (goal alignment,
architecture review, gate⓪ plan review, harvest, retrospective) around the existing
dispatch loop, without rewriting it. This section is the durable record of that
design; implementation issues #86–#91 are cut from it (see the v0.2 build-sequencing
bullet above).

**The model — a round is a batch, wrapped in peripherals:**

```
while True:
    if a final stop condition is met: break        # v1: stop.* (#76)
    peripheral: goal alignment / decomposition       # PO role
    peripheral: architecture design / review         # architect role
    for lane in the parallel cap:                    # existing: lanes.max / roundDispatchCap
        await lane(round stop conditions)            # existing: cost.roundBudgetUsd
    peripheral: harvest (results roll-up)
    peripheral: retrospective / self-evolution
```

The round loop dispatches a batch, ticks the existing engine until that batch drains,
runs the peripherals, then opens the next round. **The tick engine (`conductor.ts`) is
not rewritten** — a round is a caller of `tick()`, the same relationship `driver.ts`
already has to it.

**Two-level termination.** Round-level conditions (OR'd, first hit ends *this* round,
not the run) are the round budget (`cost.roundBudgetUsd`, already exists) and an opened-
PR cap (already exists as `lanes.roundDispatchCap`), plus a new round milestone/theme
that also filters which issues a round selects. Final-level conditions are v1's
`stop.*` (#76) — preemptive: hitting one mid-round means no new round opens, the current
one winds down, and the process exits. The two levels count different things: round
level counts PRs opened; final level counts issues merged — matching `stop.*`'s existing
semantics exactly. **#211:** round-budget accounting is the durable spend-ledger window
anchored when the round opens (`start_spend_id`), so opening/closing peripherals and
worker legs all count exactly once across crash/resume. The budget gates *new* dispatch
only; harvest and retro still close an over-budget round. **#375** makes this literal for
lanes already in flight too: a driving lane's fix leg is exempt from `cost.roundBudgetUsd`
outright (see the fix-loop paragraph above) — round budget paces new work, it never blocks
finishing a PR already open, so an over-budget round always still reaches a terminal state
(closed or fully escalated) rather than wedging on a PR it can neither merge nor fix.

**The round pool — explicit per-round task selection (locked 2026-07-16, issue #212).**
"This round's tasks" is an explicit, bounded selection, not an open-ended per-tick
query (the pool *label* remains the effective dispatch authority — the durable event
below records the selection for replay; labels are what dispatch reads): during the aligning
phase the PO selects up to `ceil(lanes.roundDispatchCap × round.poolFactor)` issues from
Ready (milestone-scoped; the factor, default 1.5, absorbs review attrition). Selection is
a PO session choosing from an engine-computed, prio-ordered candidate digest; the session
returns issue numbers only and the **engine** applies the pool label
(`labels.roundPool`, default `sapwood:round:pool`) from validated output — the role keeps
zero forge grants (#110). With `roles.po.enabled: false`, or when the session degrades
(invalid twice — degrade *open*, `pool-degraded` event), the pool is the deterministic
top-of-candidates set: the selection *bound* never depends on an optional role. The
executing phase dispatches **pool members only** (a dispatch-scoped forge wrapper; the
standby probe still sees all of Ready), and the same probe now ignores milestones whose
open issues all carry a human-hold label — a backlog nothing enabled can consume no
longer pins rounds open. Crash model: the chosen selection is persisted as a durable
`pool-selected` event *before* any label write, and a rerun replays it (last event
wins) instead of recomputing — a duplicate selection session is confined to the rare
crash window between the session returning and the event write (inherent: an external
process and a local write cannot be atomic; reconcile keeps the last attempt
authoritative either way). Label writes are a *reconcile* to that target — add
missing, remove strays — with read/remove failures degrading open and leaving a
`pool-reconcile-incomplete` honesty event. The pool label is *intended* to live one
round: round close sweeps it from every open issue that still carries it, best-effort
(failures log as tick-errors; the next selection's reconcile is the further net).
**Write-ahead is load-bearing (#232):** the `pool-selected` write
described above is fail-closed, not best-effort — an append failure now SKIPS label
reconcile for that pass entirely (a `pool-selection-decision-lost` honesty event +
tick-error recorded instead), rather than labeling GitHub against a decision with no
durable record behind it. Degrades open at the *round* level (marker still advances,
next round retries fresh), never a wedge. The same round's `po-triage` pass got the
same treatment: a validated draft is durably recorded as an accepted decision *before*
the body write, so a crash-rerun resumes the write from that record instead of paying
for a second session; the write itself carries the body hash the session actually
read and is refused (old body kept, `triage-stale-hash-skipped` recorded) if the live
body no longer matches — a concurrent human edit wins over a blind overwrite.
Recovery is *by issue number* from the decision journal, not by re-querying "still
needs triage" — the ordinary candidate query excludes an issue the instant its body
has a plan, which is exactly what a landed-but-unreceipted write produces, so a
number-only recovery scan (gate② review, PR #249) is what keeps that decision
reachable. Every decision and its receipts (body-committed, comment-posted,
effects-committed) share one *attempt* number (the same one the #231 input-manifest
row for that dispatch carries — literal join key, not a separate lookup), so a stale
receipt from a superseded or unreadable prior attempt can never be mistaken for the
current one's. The align-creation proposal journal (#216) got the matching fix for its
own audit comment: a `proposal-comment-posted` receipt now guards that non-idempotent
write the same way, so a crash between the comment landing and the final
`proposal-created` receipt reconciles without reposting it.
**Label-removal containment invariant:** every engine call site that strips a label
routes through one guard function that fail-closes on anything but `labels.roundPool`
(aliasing to a protected label is additionally rejected at config load), and no
session output schema carries a label field — removing
`needs-human`/`blocked`/`plan:approved`/`verify:n/a` remains an exclusively human act
(#147's signature). Follow-ups cut from the same design: architect batch review of the
pool (#213) and pool-scoped gate⓪ with freshness re-confirm (#214).

**Peripherals never review or merge.** The goal-alignment/PO, architect, gate⓪
plan-reviewer, harvest, and retrospective roles read and write issues and docs only.
`guard.ts`, `reviewer.ts`, and `merge-driver.ts` stay fixed and non-configurable
regardless of orchestration config —
producer≠reviewer≠merger holds no matter how the round loop is shaped. A graceful exit
(a final stop condition, or the run simply ending) still runs harvest and retrospective
once before stopping, so a round's output is never orphaned — only the kill switch skips
peripherals outright.

**Recovery is rerun-not-resume for peripheral phases.** Workers keep the existing
handoff+resume model (code WIP is expensive to redo). Peripheral phases get a cheaper
contract: phase-level rerun, backed by a `rounds` ledger (round id, phase — aligning /
architecting / executing / harvesting / retro / closed — status, and an artifact
reference) plus idempotent externalized artifacts on GitHub itself (marker comments/
labels, e.g. a `<!-- sapwood:round:N:harvest -->` HTML comment that a rerun checks for
before re-posting). A graceful interrupt finishes the current phase and writes its
cursor before exiting; a crash reruns whatever phase was `in_progress`, and the markers
make that idempotent rather than duplicating output. This deliberately never attempts to
restore a model's mid-conversation state — only its externally-visible artifacts.

**Honest framing (2026-07-17, issue #238).** What a fresh peripheral session
"remembers" across rounds is never conversational continuity — no session resumes a
prior chat. It is externalized institutional memory, held in artifacts a fresh
session re-reads AS RELEVANT TO ITS OWN ROLE — not a uniform feed every role
consumes alike: the goal file and `PLAN.md` (aligning, architecting), issue
bodies/labels/comments (triage, plan review), and the round ledger's own persisted
artifacts (harvest, retro) each reach only the role that needs them (e.g. `po-triage`
does not read the goal file). Calling this "LLM context continuity" would overclaim
a persistence the architecture doesn't have and doesn't need — rerun-not-resume is
the honest name for it.

**Self-evolution goes through a PR, never a direct write.** When the retrospective role
proposes a change to a prompt, doc, or config, it opens a PR through the same gate②
path every other change takes — never a direct write to disk. This is why
`worker.promptFile` (#74) landed in v1: it gives the retrospective role a concrete file
to open a PR against, rather than an inline prompt with no addressable target.

**Issue provenance becomes load-bearing here.** A PO-role-created issue carries
`origin:agent` (the label convention landed in v1 via this issue; see
`docs/security.md`) and initially *requires human confirmation* before it can enter
`Ready` — the round loop can propose work, but a human still decides what actually
enters the dispatch queue. The mechanics of that confirmation gate are a v0.2
implementation detail, cut as its own issue when the milestone opens.

**Ready-as-signature (locked 2026-07-17, issues #237/#238).** Moving an issue to
`Ready` — whether confirming an `origin:agent` proposal or leaving a human-authored
issue's why/what untouched — is a human signature: it endorses that issue's why/what
regardless of who typed the body. Past that point, **dissent, not revision, is the
only agent channel past `Ready`**: a role that believes a `Ready` issue's premise is
wrong may raise it, but may not itself revise the why/what or hold up/reject
dispatch. The mechanism for raising that dissent is #237's PO dissent channel (see
that issue for the mechanics — not duplicated here per the docs/issues source-of-truth
partition). This is why the `origin:agent` confirmation gate above needs no separate
adjudication machinery beyond the ordinary triage path: the human act of moving the
card IS the endorsement; nothing downstream re-litigates it outside that channel.
**Framed honestly (issue #238): this human
confirmation step is the product, not a limitation to be automated away** — it is
the one place autonomy is deliberately bounded by design, matching the positioning
statement's "humans own why/what at Ready" (Security & trust model, above).

**PO decomposition and issue granularity (#310).** A human may apply the prefix-aware
`split` label to an oversized issue. One issues-only PO session returns a bounded set of
minimal dispatchable children plus a parent-intent coverage statement; a mixed set of
Ready-able children and honest, planless coarse remainders is a successful partial
decomposition. A child is minimal when one lane and one PR complete it and its acceptance
criteria are verifiable by that PR's CI plus gate②. The prompt additionally prefers one
worker-soft-budget session, no more than the configurable AC-count hint, and minimal sibling
file overlap; these remain heuristics rather than scheduling gates.

Before any child creation, the validated proposal set is journaled, then the parent is moved
to Todo, stripped only of the round-pool label, and fenced with `decomposed`. It then remains
a human-visible tracking container: every engine ingestion path ignores it, native sub-issue
relations provide the authoritative tree, and the engine neither closes it nor removes the
fence. Children carry `origin:agent` and never inherit Ready; moving each child to Ready is
the human why/what signature. Remainders are partitioned along every discernible boundary,
each naming its own missing input, and follow the ordinary planless `needs-human` path.
Further generations always require a fresh human split act on one remainder; v1 has no
automatic recursion.

GitHub is also the external intake interface: an upstream tool creates an issue in this
repository, applies `origin:agent`, and supplies checkbox acceptance criteria plus a
verification plan (or the human-adjudicated `verify:n/a` path). There is no second intake
database or API contract.

Set-level architect escalation remains deferred. File it only if sustained evidence appears
in one or more of these signals: gate⓪ bounce rate on decomposed children; human edit/delete
rate before the Ready signature; decomposed-child `fix_rounds` versus baseline; or parent
reopens after close.

**gate⓪ — the verification-plan quality gate (locked 2026-07-09, amends Decision
#8).** Decision #8 enforced plan *presence* (dispatch refuses a plan-less issue) and
gate② re-checks the finished PR against the plan — but nothing reviewed the plan's
quality or feasibility before a producer spent budget on it, and `verify:n/a` was
self-declared. gate⓪ closes both holes: a **plan-reviewer** peripheral runs
post-`Ready`, pre-dispatch, in a session distinct from both the plan's author and the
producer. The session itself holds no shell (#110) — it computes a decision only;
approve → the engine applies `plan:approved` (and any body corrections) from that
validated decision; bounce → the engine posts a comment naming what's missing, which
becomes the brief for a scoped plan-draft dispatch (self-heal, next paragraph — never
a parked issue);
judged inherently unverifiable → it only ever **proposes** `verify:n/a`,
always paired with `needs-human` — a human resolves the adjudication (supply a plan,
or accept `verify:n/a` by removing `needs-human`, which routes the issue down the
doc-gate path / human merge). Enforcement is fail-closed in code, never a prompt:
`getReadyIssues` requires the plan present **and** `plan:approved`; `verify:n/a`
without `needs-human` passes via the doc-gate path; `needs-human`/`blocked` never
dispatch.

**gate⓪ is scoped to the round pool, with a freshness re-confirm at every pool entry
(locked 2026-07-17, issue #214) — `plan:approved` semantic shift.** Pre-#214, the
plan-reviewer swept *every* Ready-lane issue still awaiting gate⓪ each round — with a
large backlog, one phase could burn dozens of sessions on issues that wouldn't dispatch
for rounds. Post-#214, the plan-reviewer's candidate set is the round pool itself
(`labels.roundPool` members, read live at phase start — the phase runs after
`architecting` in the round sequence, so a `drop` verdict's label removal has already
landed), split into four classes: an unadjudicated pool member gets the unchanged
full draft→re-review cycle; a pool member whose `plan:approved` was granted in a
**prior** round gets a single lightweight **confirm** session ("does this plan still
hold against current `main`?") — zero forge writes on confirm, or its brief feeds the
SAME draft→re-review machinery (same cap, same escalation) on invalidate; a pool
member approved **this round** (detected from the round's own event window, #123 — a
`plan-approved` event for that issue after the round's `start_event_id`) is skipped
outright, no session at all; a `verify:n/a` pool member is untouched. A confirm
session invalid/failed twice is this feature's one fail-closed gate (unlike the
architect's degrade-open batch review) — `needs-human` with the attempt trail, never a
silently-trusted stale plan. **The practical effect: `plan:approved` is no longer
"approved forever" — it means approved when granted, re-endorsed at every round-pool
entry before dispatch.** Making this possible without deadlocking required widening the
pool's own *candidate* source (not the review split above): pool candidacy is now Ready
lane minus `needsHuman`/`blocked` (gate⓪-passed issues *and* issues still awaiting
their first review) rather than gate⓪-passed issues alone — otherwise an unapproved
issue could never enter the pool, never get reviewed, and so never dispatch. Dispatch
itself is unaffected: the executing phase's pool-scoped forge wrapper still requires
gate⓪-passed (`getReadyIssues`), so a pool member without `plan:approved` still cannot
be dispatched merely for having entered the pool. Non-pool Ready issues get zero gate⓪
attention regardless of approval state — their staleness is irrelevant until they
actually enter a pool.

**Bounce self-heals — an active plan-draft dispatch, never a stall.** A bounced plan
does not park the issue until the next round (that would stall against the autonomy
principle below): the reviewer's bounce comment — what's missing or wrong,
concretely — becomes the brief for a scoped **plan-drafting session** the loop
dispatches. The drafter is an issues-only peripheral like PO/triage (no shell, no
`gh`/forge credential, and no dedicated worker checkout — only the same
worktree-confined `Read`/`Grep`/`Glob` grant every role in this class shares,
#110 + #235), runs in a session distinct from the plan-reviewer (plan-author ≠
plan-approver holds; the
reviewer never approves a plan it authored, its minor-correction latitude aside), and
its structured output — the revised acceptance criteria + verification plan, which
the engine writes into the issue body — never touches anything else; it never
implements the issue itself. Bounded, never a livelock: at most
`roles.planReviewer.maxDraftCycles` draft→re-review cycles per issue (default 2,
YAML-tunable); cycles exhausted → `needs-human` with the full attempt trail
preserved (Decision #9). Accepted trade-off: for a thin why/what-only human-filed
issue, the agent-drafted plan effectively defines "done" — mitigated by that visible
trail and by gate②'s independent re-check of the finished PR against the same plan.
Ready-gate enforcement is unchanged: implementation dispatch still requires
`plan:approved` (or adjudicated `verify:n/a`); only the repair path became more
autonomous.

**Plan authorship moves upstream.** The issue's creator authors the acceptance
criteria + verification plan at creation — for `origin:agent` issues that is the PO
role (a decomposition without a plan is incomplete). A human-filed issue lacking a
plan gets one drafted by the PO/triage peripheral; the loop never blocks waiting for
a human-written plan.

**The separation chain extends: plan-author ≠ plan-approver ≠ producer.** The
plan-reviewer computes a decision only (no shell of its own, #110) — the engine
performs every issue write from its validated output; it never reviews code and never
merges. The safety invariant (producer≠reviewer≠merger, locked decision above) is
untouched.

**The autonomy principle (governs gate⓪ and every future gate).** Humans decide only
the *why/what* of an issue — the act of moving it to `Ready` (including the initial
confirmation of `origin:agent` issues). Everything after `Ready` — plan drafting,
plan review, execution, acceptance — is agentic; the loop never hangs waiting for a
human on the normal path, and rare edges still degrade to `needs-human` (Decision
#9). The precondition that makes this safe: every agent decision is externalized —
issue comments, labels, the round ledger, structured events — observable and
traceable, so a human can watch and intervene on unexpected behavior rather than
being polled for routine approval.

**Dispatch heuristic:** within equal priority, prefer lightweight issues first.

**Role configuration is sketched, not designed.** Each role is expected to need at
least a `role_id`, a `model`, and a `promptFile`, with execution modes (sequential /
routing / parallel / competitive) selectable per role — the detailed shape is deferred
to when v0.2 implementation issues are cut, not locked here.

## Key risks / watch items

- **Platform risk:** Anthropic/GitHub could ship native "issues → PRs." Mitigation =
  lead with governance depth + community, the part hardest to absorb.
- **Persistence:** v1 workers are session-bound (die on SIGHUP); durable SQLite makes
  restart clean; `sapwood status` surfaces dead workers. Real supervisor = v1.1.
- **Process-tree kill:** `worker.ts` must kill the whole `claude` subtree (process
  groups) — 0day couldn't on bash 3.2.
- **Dashboard scope inflation (v0.2):** estimate as new frontend work, not a port.
- **Naming:** "sapwood" communicates nothing to a stranger; revisit before public
  launch (minor, pre-launch).

## Verification (how we'll prove v1)

- **Guard:** `guard.ts` reproduces all 0day bypass attempts; differential/fuzz vs
  `guard.py` passes; every mutation path denied fail-closed; hook error/timeout →
  deny. `Write` to `.claude/settings.json` / `.github/workflows/**` blocked.
- **Engine parity:** 0day pure-function tests (priority/blocker/selffeed/merge-decision)
  pass in TS.
- **Session-death recovery (explicit test):** kill the conductor mid-run, restart,
  confirm stale-heartbeat reclaim resets lanes to claimable, and `sapwood status`
  shows the dead workers.
- **End-to-end dogfood:** on a trusted throwaway repo — `init` (zero manual GitHub UI
  steps, from clean `gh auth`), seed 2–3 issues. Default 0day-style run:
  claim → worktree → PR → **configured independent review** → CI green + fresh review → **Conductor
  merges** (confirm the worker never self-merges). Also exercise the conservative
  produce-PR-and-stop mode (stops for human merge).
- **Soft budget handoff (explicit test):** a worker reaching its soft per-worker
  budget is **not** killed mid-step — it commits + pushes WIP, writes a `.handoff`
  sentinel + progress note, exits clean; the Conductor classifies it resumable and
  `--resume` continues from the pushed state with no lost work.
- **Hard cost ceiling:** breach the cumulative cap mid-run → auto-drain (in-flight
  workers hand off); kill switch halts dispatch **and** the DRIVE/merge-gate loop
  (no new dispatch, no autonomous merges), independent of conductor liveness.
- **Readiness gate:** an issue with no verification plan is refused by `getReadyIssues`
  (never dispatched); one labelled `verify:n/a` passes via the doc-gate path.
- **Onboarding:** missing `project` scope → clear actionable message, no partial board.
