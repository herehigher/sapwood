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
  (untrusted-input safe), a real supervisor, and eventually a dashboard. v1
  architecture must keep these as *extensions, not rewrites*.
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
| 5 | Default merge gate | **0day-style: autonomous-merge gated on a different-model Codex PR review** — gate① CI green + gate② a fresh non-author Codex review → the Conductor merges (producer≠merger). Reviewer is pluggable; **produce-PR-and-stop** (human merges) and same-model self-review remain selectable modes. Different-model default matches 0day and the security review's recommendation. |
| 6 | Method | 0day's TDD + two-gate + taxonomy as overridable defaults |
| 7 | Config format | **YAML default** — `sapwood.config.yaml`, hand-edited with inline comments (serves "易读易配置"). Zod-validated after parse. The YAML parser also reads JSON for free (YAML ⊃ JSON), so `.json` works with zero extra code; no separate `.ts` config. |
| 8 | Dispatch readiness | **An issue is not `Ready` until it carries a verification plan** — acceptance criteria + how to prove them (tests to write/run, commands, observable outcomes). Authored by the issue author/triage *before* the producer starts (keeps producer≠author). Enforced at the `Ready` gate (`getReadyIssues` refuses issues without one) **and** re-checked by the reviewer at gate② (the PR must satisfy the stated plan). Inherently-unverifiable issues (docs/knowledge, chore) are labelled `verify:n/a` and use the round-close doc gate / a lighter definition-of-done instead, so the gate never blocks legitimate work. Cheap (plan written once, read by worker + reviewer who already read the diff); net-saves by killing wrong-direction PRs and rework. **Amended 2026-07-09 (gate⓪, lands in v0.2 — see the v0.2 chapter):** presence alone is no longer the bar — a **plan-reviewer peripheral (gate⓪)** reviews each plan's quality/feasibility post-`Ready`, pre-dispatch, and `getReadyIssues` requires the plan **and** its `plan:approved` label (fail-closed). `verify:n/a` is never self-declared: gate⓪ can only *propose* it, always paired with `needs-human`, and a human finalizes the adjudication by removing `needs-human` (→ doc-gate path). |
| 9 | Edge-case handling | **Rare edge cases degrade to `needs-human`, never to more machinery** (CTO, 2026-07-07, #69). Automation covers the common path only; when a low-probability edge would require new hardening/persistence/recovery code, the correct handling is: preserve the evidence, label `needs-human`, stop. First application: the drain path never runs git in worker worktrees (the whole #59–#68 issue family collapsed into sentinel-only handoff + dirty-worktree retention). |

## Architecture (v1)

**Plugin layout:**

```
sapwood/
├── .claude-plugin/          # plugin manifest (skills, commands, hooks)
├── skills/                  # dev-round, dev-loop (ported from 0day skills)
├── commands/                # /sapwood-init, /sapwood-run, /sapwood-status, /sapwood-stop ...
├── engine/                  # TS orchestration engine (the port)
│   ├── conductor.ts         # scheduler: tick (reclaim→drive→dispatch), state machine
│   ├── worker.ts            # headless `claude -p` wrapper in a worktree + sentinels
│   ├── merge-driver.ts      # the only place a merge happens (autonomous-merge mode)
│   ├── forge.ts             # IForge interface + GithubForge impl (gh CLI/GraphQL)
│   ├── guard.ts             # fail-closed PreToolUse hook (port of guard.py), zero-dep
│   ├── reviewer.ts          # pluggable review gate (default = different-model Codex review, 0day-style)
│   ├── config.ts            # load sapwood.config.yaml (yaml→zod), JSON also parses; defaults
│   ├── state.ts             # SQLite (WAL) state + per-round metrics/events
│   └── cli.ts               # `sapwood` binary: init / status / stop — runs WITHOUT a live session
└── docs/                    # getting-started, config ref, security model, troubleshooting
```

**Engine design notes**

- **`IForge` interface before M2.** ~8 methods (`getReadyIssues`, `claimIssue`,
  `setBoardStatus`, `openPR`, `getPRStatus`, `mergePR`, `addLabel`, `detectOwnerKind`).
  All `conductor.ts` calls go through it; v1 impl is `GithubForge`. Makes GitLab/Gitea
  an implementation, not a rewrite. Removes every 0day hard-coding (`PROJECT_NUMBER`,
  `user(...)` vs `organization(...)`, literal `"Ready"/"In Progress"/"Done"`,
  trusted-reviewer login) into config.
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
  documented field (mapping in `engine/src/config.ts`).
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
  (`classifyLane` 4-signal lane state, `issuePriority` [matches bare `prio:N` *and* suffixed],
  `labelsBlockers`, `budgetExceeded`, `codingFloor`/`isCodingRank`/`metaLaneAllowed`
  anti-starvation, `laneOnReclaim*`, `driveDecision`). **Structured discriminated-union tick
  result** replaces 0day's stringly-typed `DISPATCHED/RECLAIMED` text protocol. `tick()` =
  reclaim→drive→dispatch with **dependency injection** (`IForge` + `Supervisor` + `State`
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
  boundary — `sapwood.config.*`, the compiled `engine/dist/guard*.js` artifact, and (removed
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
  same-model-trusted-only / human. A verdict is pinned to a **specific head oid** — a
  review of a stale head counts as *no review*. In the Codex / same-model modes, only
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
  **CONFLICTING** → needs-human *before* any merge attempt; deterministic merge failures
  escalate while transient/TOCTOU ones requeue. Two merge modes: **conductor-merges**
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
  budget stays a graceful handoff, never a mid-work kill (#33, still open — needs a
  live cost signal).
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
  **loop/worker spend only** — Codex-review and human-session usage happen outside
  stream-json and are not captured here.
- **Guard boundary extended (#43)** — the merge path is now inside the worker-unwritable
  boundary: `merge-driver.ts` source and the *running* `engine/dist/reviewer.js` /
  `merge-driver.js` artifacts (same vector class as the guard artifact, closed in #26 R3).
  Also **#39**: the hook's direct-invocation check now compares realpaths — symlink
  invocation can no longer silently no-op the guard.
- **Rollback hardening (#31 → PR #44)** — recovery-path board mutations are persisted to
  a `pending_rollbacks` table *before* being attempted and retried each tick until they
  succeed; bounded retries escalate to needs-human with a structured tick-result entry.
  Invariant: a transient forge failure during recovery can no longer strand an issue
  In Progress with no worker row. No `.catch(() => {})` swallows remain in tick paths.
- **Scope boundaries / deferred:** fixup-worker auto-dispatch (review findings fold to
  needs-human for now — 0day's FIXABLE/fix-rounds loop is a follow-up subsystem).
  #33 unchanged (no in-flight cost signal). Review evidence: #42 survived 3 Codex
  rounds (3 P1 + 3 P2 fail-open finds, all fixed + regression-tested); #41 survived 4
  rounds (3 Codex + 1 fresh non-author stand-in when Codex rate-limited) — the
  gate②-when-reviewer-unavailable policy was exercised *on the PR that implements it*.
  ~~live `findOpenPr` forge wiring and the live end-to-end merge-gate run move to M4
  with the loop driver (which MUST pass `tickIntervalSec` into `tick()` and handle the
  `--resume` cost-delta — both flagged in code)~~ **→ #46 (M4): the loop driver
  (`driver.ts`) now passes `tickIntervalSec` into every `tick()`; `State.recordSpend`
  now records only the incremental delta above what's already ledgered for a worker
  name, so a `--resume`d lane (`WorkerSupervisor.resume()`) can't double-count its
  pre-handoff cost; `GithubForge.findOpenPrForIssue` gives `sapwood run` a first-pass
  (not yet hardened) live wiring.** ~~**The gate② verification-plan re-check (Decision
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
  loop yet; an auto-resume *scheduling* policy (deciding WHEN a handed-off lane should
  be resumed during `tick()`) is also not wired — `resume()` is a callable mechanism,
  not yet an automatic one.

## Security & trust model (trusted-first, designed toward public)

The committee's keystone finding: 0day's guard was built for a *trusted* model on a
*private* repo. v1 stays in that context, so the guard's honest-mistake posture is
adequate — **but we build the seams so public-repo hardening is additive, not a
rewrite.** v1 requirements:

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
  invariant holds even if the guard is bypassed. gate② is a fresh non-author Codex
  review; produce-PR-and-stop (human merges) is the conservative selectable mode.
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
- **Issues-only peripheral role sessions carry no shell (#110, supersedes this
  section's original guard-tokenizer scope for these roles):** plan-reviewer,
  plan-drafter, PO/align+triage, harvest, and architect hold no `Bash` tool grant at
  all — pure computation, prompt substituted in, no repo/`gh` access of their own.
  Each session's final message ends in a structured, sentinel-delimited output block;
  the deterministic engine parses it, validates it against a per-role zod schema plus
  cheap content invariants, and performs every GitHub write itself via `IForge`,
  fail-closed (ambiguous/duplicate/out-of-candidate-set output rejects the WHOLE
  attempt, retried once, then the role's degrade path — gate⓪ escalates
  `needs-human`, advisory roles proceed with a durable event). Because no shell
  exists for these sessions, the string-level Bash-pattern bypass classes (short-flag
  aliases, quoting/escaping) earlier hardening chased one glob at a time are moot for
  them — closed by removing the capability, not a better pattern. `retro` stays
  worker-class (`Read`/git + `gh pr create`, proposals land exclusively as PRs) —
  out of this design's scope by session class; its own hardening is #111. Full model:
  `docs/security.md`'s "Issues-only role sessions carry no shell" section.
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
| **plan-reviewer** | `decision`∈{approve, draft_request, verify_na} + `issue` + optional body → `updateIssueBody` + `addLabel(plan:approved)` (approve); `addLabel(needs-human)`+`addLabel(verify:n/a)`+`addIssueComment` (verify_na); routes to drafter (draft_request) — `plan-review.ts:352-384` | `validateReviewerOutput` (`plan-review.ts:164`): `PlanReviewerMetadataSchema` (strict zod) **+ content invariant** — `extractVerificationPlan` must find a plan in the approved body **+** issue-number match to the expected candidate | **High** — `plan:approved` is the gate⓪ dispatch key; a false approve dispatches an unverifiable issue. Deepest validation (schema + content + identity). |
| **plan-drafter** | `issue` + body (revised issue body, required) → `updateIssueBody` only — `plan-review.ts:422` | `validateDrafterOutput` (`plan-review.ts:205`): `PlanDrafterMetadataSchema` (strict) + non-empty body + issue-number match | **Medium** — writes the body but **never** the `plan:approved` label (author ≠ approver, #77 Amendment 2); the reviewer must independently re-approve before dispatch, so the drafter's write is always re-gated. |
| **PO / aligning** | *align mode:* `issues:[{title}]` + per-issue bodies → `createIssue` + `addLabel(origin:agent)` + `addLabel(needs-human)` when planless + `addIssueComment` — `align.ts:291-304`. *triage mode:* `issue` + drafted body → `updateIssueBody` + `addIssueComment` — `align.ts:351` | `validateAlignOutput` (`align.ts:138`) / `validateTriageOutput` (`align.ts:184`): `AlignMetadataSchema`/`TriageMetadataSchema` (strict) **+ content invariant** — `extractVerificationPlan`; a planless creation/draft earns `needs-human`, never a dispatch label | **Low (pre-Ready)** — a created issue structurally cannot carry a dispatch label (engine applies labels, session has no channel); anything planless is fenced `needs-human`; degrade proceeds (low stakes, next round retries). |
| **architect** | `contradictions:[{issue, severe}]` + design note + per-issue explanations → `addIssueComment(anchor, designNote)`; per contradiction `addIssueComment` + `addLabel(blocked)` when `severe` — `architect.ts:387-390` | `validateArchitectOutput` (`architect.ts:235`): `ArchitectMetadataSchema` (strict) + `splitDesignNote` fail-closed sub-format parse (own-line `<<<CONTRADICTION #n>>>` markers, no embedded sub-delimiters) | **Medium** — the `blocked` label gates dispatch of the flagged issue; the design-note comments are advisory. Validation matches: schema + structural body parse, no content-truth check (the note is prose). |
| **harvest** | `comments:[{issue, body}]` → `addIssueComment` only — `harvest.ts:347` | `validateHarvestOutput` (`harvest.ts:217`): `HarvestMetadataSchema` (strict) **+ set cross-check** — every `issue` must be in the engine's pre-computed `needsHumanIssues` set (`gatherRoundFacts`, fixed *before* the session); any out-of-set number fails the **whole** batch | **Low** — comment-only, and the session cannot choose *which* issues it briefs (engine fixes the target set). No labels, no dispatch effect — the set cross-check is the guard against write-target choice leaking to the role. |
| **retro** | Scratch file (`.sapwood-retro-pr`), not the JSON block: `branch`/`title`/`body` or `none` → `openPR(branch, title, body)` — `retro.ts:377` | `parseRetroScratch` (`retro.ts:141`): fail-closed labeled-header parse + `invalidBranchReason` (no default-branch, no `..`, argv-safe) **+ engine-side `forge.branchExists`** push verification before `openPR` (a session's push claim is never trusted) | **Low at write, gate②-bound** — a proposal is *only* a PR; it changes nothing until gate② (CI green + fresh non-author review) merges it. The heavy validation here is authenticity (branch really pushed), not decision quality — correctly, since the merge gate owns the quality call. |

Reading the weight column top-down is the whole point: the one **High**-weight output
(plan-reviewer's `plan:approved`) carries the deepest validation (schema + content
invariant + identity), and weight falls in step with validation down the table. A
future change that inverts that ordering — a heavier write behind lighter validation —
is exactly what this principle exists to catch.

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
  `conductor.ts` (tick: reclaim→drive→dispatch, structured results, parity core), `worker.ts`
  (headless `claude -p` in a worktree), and the guard **wired live** into worker sessions
  (#26, hard-default/soft-opt-in). Parity tests against 0day's pure-function tests
  (`test_loop_conductor.sh`); **dogfooded end-to-end** (claim→worktree→TDD→PR, guard live, no
  self-merge). Key decisions + deferrals (#31/#33/#37) in "M2 engine core" above.
  `merge_decision` + parity vs `test_loop_merge_driver.sh` move to M3 with the merge-driver.
- **M3 — Review gate + merge modes:** ✅ **delivered (PRs #41, #42, #43, #44; hardening
  #39, #40).** `reviewer.ts` + `merge-driver.ts` with the **0day-style default**:
  autonomous-merge gated on a fresh non-author Codex review (gate②) + CI green (gate①),
  merged by the Conductor; produce-PR-and-stop selectable. Pluggable reviewer
  (different-model Codex / same-model-trusted-only / human), engine cost ceiling + kill
  switch (#14), rollback hardening (#31). 23-case parity vs `test_loop_merge_driver.sh`;
  `--match-head-commit` TOCTOU pin. Key decisions + deferrals in "M3 review gate + merge
  modes" above. ~~Live end-to-end merge-gate run moves to M4 with the loop driver.~~
- **M4 — UX surface + CLI:** ✅ **loop driver delivered (#46, PR TBD):** `driver.ts`
  runs `tick()` on `cfg.engine.tickIntervalSec`'s cadence (wired into `TickDeps` so the
  wall-clock ceiling sees the real cadence, not its floor default), stops cleanly on
  SIGINT/SIGTERM after the in-flight tick (never mid-tick), and supports `--once` /
  `--until-idle` alongside the daemon default — `sapwood run [--once|--until-idle]` in
  `cli.ts`. Resume cost-delta protected in `State.recordSpend` (see M3 section above).
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
  degradation. **Commands + status CLI + first-run trust ramp delivered
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
semantics exactly.

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

**Bounce self-heals — an active plan-draft dispatch, never a stall.** A bounced plan
does not park the issue until the next round (that would stall against the autonomy
principle below): the reviewer's bounce comment — what's missing or wrong,
concretely — becomes the brief for a scoped **plan-drafting session** the loop
dispatches. The drafter is an issues-only peripheral like PO/triage (no repo
checkout, no code access, no shell at all — pure computation, #110), runs in a
session distinct from the plan-reviewer (plan-author ≠ plan-approver holds; the
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
  claim → worktree → PR → **Codex review** → CI green + fresh review → **Conductor
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
