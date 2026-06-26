# borehole — Project Goals & Plan (planning only)

## Context

`0day` (github.com/herehigher/0day) is a Polymarket quant system, but its most
reusable asset is the **autonomous development framework** it was built with: an
AI-led, GitHub-native, self-directed dev loop. Today that framework is ~4,700
lines of macOS-bash (~3,400 non-test) entangled with the trading domain, hard to
read, hard to maintain, and not packaged for anyone else to use.

**borehole** extracts that framework, re-implements the engine in TypeScript, and
ships it as a **public, production-usable Claude Code plugin** so any repo can run
"GitHub issues in → reviewed PRs out" with a real governance layer.

This plan was pressure-tested by a four-lens review committee (architecture,
security, strategy, DX). Their central finding reshaped the direction: **the
product is the trust/governance layer, not a dashboard.** producer≠reviewer≠merger,
enforced by a fail-closed hook, is the thing no competitor (Sweep, OpenHands,
Copilot Workspace, Claude's own `/loop`) ships. We lead with that.

The trading domain stays behind in 0day. borehole is the method, not the money.

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
- **Dogfooding is the proof and the pitch:** from M2 onward, borehole builds
  borehole — every remaining feature is driven through borehole's own loop. The
  flagship demonstration is **borehole building its own dashboard (v0.2)**: a
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
| 7 | Config format | JSON default (Zod-validated); `.ts` typed config as opt-in |

## Architecture (v1)

**Plugin layout:**

```
borehole/
├── .claude-plugin/          # plugin manifest (skills, commands, hooks)
├── skills/                  # dev-round, dev-loop (ported from 0day skills)
├── commands/                # /borehole-init, /borehole-run, /borehole-status, /borehole-stop ...
├── engine/                  # TS orchestration engine (the port)
│   ├── conductor.ts         # scheduler: tick (reclaim→drive→dispatch), state machine
│   ├── worker.ts            # headless `claude -p` wrapper in a worktree + sentinels
│   ├── merge-driver.ts      # the only place a merge happens (autonomous-merge mode)
│   ├── forge.ts             # IForge interface + GithubForge impl (gh CLI/GraphQL)
│   ├── guard.ts             # fail-closed PreToolUse hook (port of guard.py), zero-dep
│   ├── reviewer.ts          # pluggable review gate (default = different-model Codex review, 0day-style)
│   ├── config.ts            # load/validate borehole.config.json (zod) + defaults
│   ├── state.ts             # SQLite (WAL) state + per-round metrics/events
│   └── cli.ts               # `borehole` binary: init / status / stop — runs WITHOUT a live session
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
  WAL gives atomic writes + concurrent reads (for `borehole status`). Fully durable
  → engine restart is always a clean resume. Schema is versioned (migration path).
- **Structured tick results** (typed discriminated union) replace the stringly-typed
  `DISPATCHED.../RECLAIMED...` text protocol greped by skills.
- **Keep sentinel-based completion** + heartbeat/PID liveness classification.
- **Claude CLI coupling isolated** in `worker.ts`: every `claude -p` flag, the
  `stream-json` cost parsing, and `CLAUDE_BIN` discovery live in one module. State a
  minimum Claude Code CLI version and test against it in CI.
- **Lifecycle (v1):** conductor ticks via ScheduleWakeup (session-bound — documented
  limitation; durable SQLite makes restart clean). `borehole status` (the CLI, not a
  skill) reads SQLite directly and works with no live session; it detects a dead
  engine and prints the restart command. A real supervisor (launchd/daemon) is v1.1.
- **Skill↔engine IPC:** skills/commands talk to the engine only through the
  `borehole` CLI / a read-only state read — never bespoke SQLite coupling per skill.

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
- **Engine-enforced cost ceiling:** a cumulative/daily USD cap + wall-clock cap in
  the conductor (independent of the CLI `--max-budget-usd`, which is drift-prone),
  with auto-drain on breach + an out-of-band kill switch. Conservative defaults
  (small round budget, dispatch cap 1–2).
- **Designed-for-public seams (built as interfaces in v1, enforced in v1.1):**
  scoped ephemeral GitHub App tokens per worker (replacing host `gh` auth); a written
  threat model treating issue text as hostile data; fixing the public-repo merge-gate
  hole so `MERGE_OK` requires an *allowlisted* reviewer, not any non-author review
  (`pr_gate.sh:240-242` vs `loop_merge_driver.sh:33-34`).

## Onboarding / DX (v1)

- **`/borehole-init` + `borehole init`** must be credible and idempotent:
  1. **Auth preflight:** `gh auth status` + check `project` scope; if missing, print
     the exact fix (`gh auth refresh -s project`) and exit cleanly.
  2. **User-vs-org detection** before any ProjectV2 mutation.
  3. **Idempotent, recovery-safe provisioning:** detect existing board/fields/options
     before creating; tolerate partial failure; safely re-runnable. (0day stops here
     and asks the human to make the board by hand — `bootstrap_github.sh:89`; we
     automate it.)
  4. Writes a starter `borehole.config.json` and wires the guard hook.
- **First-run trust ramp** (the missing safety UX): a `--dry-run` that lists issues
  it *would* dispatch + estimated cost; a **"watch one issue" supervised mode** that
  pauses after worktree/PR/review for explicit confirmation (the recommended first
  run); a cost preview; a documented kill switch (`/borehole-stop drain` semantics,
  including what happens to in-flight workers).
- **Reviewer/cost legibility:** first run prints which reviewer/mode is active and its
  cost implication.
- **Minimum doc set (release gate, not polish):** Getting Started (clone → first PR,
  every prerequisite), Config reference, Conceptual model (3-layer loop, sentinel,
  producer≠merger — in English), Troubleshooting (auth scope, session-death worker
  loss, board partial-failure, budget exhaustion, stuck PR), Security model.

## Build sequencing (planning only)

- **M0 — Skeleton + config + forge:** plugin manifest, `borehole.config.json` schema
  + Zod + defaults, `IForge` interface + `GithubForge` (all hard-coding removed),
  SQLite (WAL) state layer with schema versioning.
- **M0.5 — Minimal onboarding:** `borehole init` (auth preflight, user-vs-org,
  idempotent board/label/milestone provisioning, config write). Early so real users
  can try it and feedback the config schema before it locks.
- **M1 — Guard port (safety first):** zero-dep `guard.ts` + reproduced bypass suite
  + differential/fuzz tests + fail-closed-on-error + hook wiring + `Write`-path
  protections. Nothing autonomous ships before this is green.
- **M2 — Engine core:** `conductor.ts` (tick: reclaim→drive→dispatch), `worker.ts`,
  structured tick results; parity tests against 0day's pure-function tests
  (`test_loop_conductor.sh`, `test_loop_merge_driver.sh`). **Dogfood starts here:**
  run borehole on one borehole issue end-to-end.
- **M3 — Review gate + merge modes:** `reviewer.ts` + `merge-driver.ts` with the
  **0day-style default**: autonomous-merge gated on a fresh non-author Codex review
  (gate②) + CI green (gate①), merged by the Conductor. Pluggable reviewer
  (different-model Codex / same-model-trusted-only / human) and a produce-PR-and-stop
  mode; engine cost ceiling + kill switch. Port 0day's `pr_gate.sh` ACTION protocol +
  `loop_merge_driver.sh` (incl. `--match-head-commit` TOCTOU pin).
- **M4 — UX surface + CLI:** skills/commands (`/borehole-run`, `/borehole-status`,
  `/borehole-stop`, supervised "watch one issue" mode), `borehole` status CLI,
  first-run trust ramp, docs set.
- **v0.2 (post-v1) — Dashboard, built BY borehole (flagship dogfood):** drive the
  entire dashboard build through borehole's own loop on the borehole repo, and
  **record the run** as the launch artifact. Scope: event schema + `GET /api/loop/state`
  & `/events` (current-state, from SQLite) → React views (lane board, event feed)
  reusing 0day's TanStack Query polling + replay player + charts (chart/domain
  components are *new* design, not a port). History-aggregation metrics
  (merge/rework/cycle-time) are a later phase, gated on the GitHub-history work 0day
  never finished (`ops/loop/README.md:109`). Because workers may touch security-
  sensitive files, the human-merge-only rule for guard/hook/reviewer/security config
  (see Security model) stays in force during this dogfood.

## Key risks / watch items

- **Platform risk:** Anthropic/GitHub could ship native "issues → PRs." Mitigation =
  lead with governance depth + community, the part hardest to absorb.
- **Persistence:** v1 workers are session-bound (die on SIGHUP); durable SQLite makes
  restart clean; `borehole status` surfaces dead workers. Real supervisor = v1.1.
- **Process-tree kill:** `worker.ts` must kill the whole `claude` subtree (process
  groups) — 0day couldn't on bash 3.2.
- **Dashboard scope inflation (v0.2):** estimate as new frontend work, not a port.
- **Naming:** "borehole" communicates nothing to a stranger; revisit before public
  launch (minor, pre-launch).

## Verification (how we'll prove v1)

- **Guard:** `guard.ts` reproduces all 0day bypass attempts; differential/fuzz vs
  `guard.py` passes; every mutation path denied fail-closed; hook error/timeout →
  deny. `Write` to `.claude/settings.json` / `.github/workflows/**` blocked.
- **Engine parity:** 0day pure-function tests (priority/blocker/selffeed/merge-decision)
  pass in TS.
- **Session-death recovery (explicit test):** kill the conductor mid-run, restart,
  confirm stale-heartbeat reclaim resets lanes to claimable, and `borehole status`
  shows the dead workers.
- **End-to-end dogfood:** on a trusted throwaway repo — `init` (zero manual GitHub UI
  steps, from clean `gh auth`), seed 2–3 issues. Default 0day-style run:
  claim → worktree → PR → **Codex review** → CI green + fresh review → **Conductor
  merges** (confirm the worker never self-merges). Also exercise the conservative
  produce-PR-and-stop mode (stops for human merge).
- **Cost ceiling:** breach the cumulative cap mid-run → auto-drain; kill switch halts
  dispatch independent of conductor liveness.
- **Onboarding:** missing `project` scope → clear actionable message, no partial board.
