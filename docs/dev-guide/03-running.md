# 03 — Running locally

For installation into another repository, use [Getting started](../getting-started.md). This page covers running the checked-out source as a contributor.

## Prerequisites

- Node 24 or newer (`package.json`, `engine/package.json`).
- npm, supplied with Node.
- Git and a repository that can create worktrees (`engine/src/roles/worker.ts`).
- GitHub CLI authenticated with repository and Project scopes; `sapwood init` performs the preflight (`engine/src/loop/init.ts`).
- Claude Code CLI available as `claude`, or selected with `CLAUDE_BIN` (`engine/src/roles/worker.ts`).
- The default reviewer (#501) is the engine-composed `engine-agent` Claude session (`engine/src/review/`) — it runs locally on the same `claude` CLI above, at a per-review dollar cost (`reviewer.agent.costCapUsd`, default $3; see `docs/configuration.md`). Other supported kinds, selectable via `reviewer.mode`, include a Codex-backed GitHub review trigger (`different-model-codex`, not a locally spawned `codex` command — `engine/src/roles/reviewer.ts`) and trusted/human GitHub reviews.
- Independently of the kind, the `engine-agent` review session has a **runner** dimension (#443, `reviewer.agent.runner`): `claude` (default, the local `claude` CLI) or `codex-exec` — a locally spawned `codex exec` process, which makes gate② cross-vendor and requires the `codex` CLI on `PATH` (or `CODEX_BIN`) plus a codex login. Don't confuse it with the hosted `different-model-codex` mode above: that one spawns nothing and reviews through a PR comment. See `docs/configuration.md` for the runner's advisory-budget and recorded-blind-spot semantics.

## Install & build

From the workspace root:

```bash
npm install
npm run build
```

The root build fans out to the engine workspace. TypeScript emits ESM, declarations, and source maps under `engine/dist/` (`tsconfig.base.json`, `engine/package.json`). The package binary maps `sapwood` to `engine/dist/cli.js`; after building, run it directly with `node engine/dist/cli.js`, or run source with `node --import tsx engine/src/cli.ts`.

## Configuration

The checked-in `sapwood.config.yaml` is this repository's live configuration — the loop runs from it with no `--config`; only non-default values are written (see [Configuration — Two config files](../configuration.md#two-config-files)). `loadConfig()` probes, in order, `sapwood.config.yaml`, `sapwood.config.yml`, then `sapwood.config.json`; `sapwood run --config <path>` (including `--dry-run`), `sapwood status --config <path>`, `sapwood events --config <path>`, `sapwood pause|stop|estop --config <path>` (#731), and `sapwood validate [path]` bypass the probe. `status`/`events`/`pause`/`stop`/`estop`'s `--config` is authoritative once given (#710) — a bad path there is a hard error, never a silent fallback. Relative `logging.path`, `promptFile`, `goal.file`, and `doctrine.file` keys resolve from the selected config's directory, so an alternate config's default log lands beside that config; the DB (`data/sapwood.sqlite`), `EMERGENCY_STOP`/`KILL_SWITCH`/`PAUSE`, sessions, and worktree roots stay cwd-relative. JSON is accepted through the YAML parser. See [Configuration](../configuration.md) for the complete key reference.

Environment variables read or propagated by the engine are deliberately narrow:

| Variable | Effect |
| --- | --- |
| `CLAUDE_BIN` | Overrides the `claude` executable used by workers, roles, and the LLM availability probe (`engine/src/roles/worker.ts`). |
| `CLAUDE_CONFIG_DIR` | Selects the Claude user configuration directory recorded in peripheral context manifests (`engine/src/roles/peripheral.ts`). |
| `GH_*`, `GITHUB_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | Standard authentication inputs consumed by `gh`; peripheral and credential-free fix sessions strip these as documented in `engine/src/roles/peripheral.ts` and `engine/src/roles/worker.ts`. |
| `SAPWOOD_GUARD_MODE` | Engine-set spawn variable carrying configured hard/soft guard mode; do not use it as a contributor override (`engine/src/guard/guard-hook.ts`). |
| `SAPWOOD_WORKTREE_ROOT` | Engine-set absolute containment root for guarded session reads (`engine/src/guard/guard.ts`). |

Human controls are three cwd-relative files, not environment variables: `data/EMERGENCY_STOP`, `data/KILL_SWITCH`, and `data/PAUSE` (`State.estopPath()`, `State.killSwitchPath()`, and `State.pausePath()` in `engine/src/state/state.ts`). Reachable via raw `touch`/`rm` or the first-class `sapwood pause`/`stop`/`estop` CLI verbs, each with a `clear` form (#731) — `estop` additionally requires `--confirm` to activate. `data/DIRECTIVE.md` is an optional round input configured by `round.directiveFile`, not a stop control.

## Running the loop from source

Validate and preview first:

```bash
node --import tsx engine/src/cli.ts validate
node --import tsx engine/src/cli.ts run --dry-run
node --import tsx engine/src/cli.ts run --dry-run --config path/to/sapwood.config.yaml
```

The shipped `engine.driver` default is `rounds`. Start it with:

```bash
node --import tsx engine/src/cli.ts run
node --import tsx engine/src/cli.ts run --config path/to/sapwood.config.yaml
```

For a single scheduling tick, set `engine.driver: tick` in `sapwood.config.yaml`, then run:

```bash
node --import tsx engine/src/cli.ts run --once
```

`--once` and `--until-idle` are rejected under the rounds driver (`engine/src/cli.ts`, `commands/sapwood-run.md`). `--dry-run` does not create state or spawn a worker. A live run creates `data/sapwood.sqlite` and SQLite WAL sidecars as needed, `data/logs/sapwood.log`, worker streams/sentinels in `data/sessions/state/`, role streams/sentinels in `data/sessions/roles/`, and derived round views in `data/rounds/` (`engine/src/state/state.ts`, `engine/src/loop/logger.ts`, `engine/src/roles/worker.ts`, `engine/src/roles/peripheral.ts`).

To exercise drain behavior safely, create `data/KILL_SWITCH` before the tick. The tick observes the switch and does not dispatch or merge; remove it only when the test is complete (`commands/sapwood-stop.md`, `engine/src/loop/conductor.ts`).

## Debugging a failed run

When a run misbehaves, the evidence trail is layered — read it in this order:

1. **`node --import tsx engine/src/cli.ts status`** — lane states, PRs in the
   gate, spend vs. ceiling, e-stop/kill switch/pause state; works read-only with no engine
   running.
2. **`data/logs/sapwood.log`** — the engine's own diagnostic log
   (`engine/src/loop/logger.ts`).
3. **The `events` table** — the append-only decision history
   (`sqlite3 data/sapwood.sqlite "SELECT ts,kind,payload FROM events ORDER BY id DESC LIMIT 40"`);
   dispatch, gate outcomes, degrades, escalations, and reconciliation all land
   here with reasons.
4. **Per-session evidence** — flat files under `data/sessions/state/` named
   per lane (`<lane>.jsonl`, `<lane>.running.json`, terminal sentinels) and
   `data/sessions/roles/` (peripherals): the JSONL stream is the session
   transcript; sentinel files (`.running`/`.done`/`.failed`/`.handoff`) are the
   wrapper's ground truth about how it ended, independent of the model's
   self-report.
5. **A retained worktree** — a failed/held lane's worktree is kept for
   inspection; its branch and dirty state show exactly what the worker left.

Operator-facing failure semantics (`needs-human` reasons, park/probe, degrade
paths) are in [Troubleshooting](../troubleshooting.md).

## Resetting local state

Stop the local engine before deleting runtime files. All of the following are generated under `data/` and can be removed between isolated development runs, but deletion is irreversible and changes recovery behavior:

| Path | What deletion loses |
| --- | --- |
| `data/sapwood.sqlite`, `-wal`, `-shm` | Worker/round state, events, spend, pending recovery writes, proxy audit records, and schema version. Delete the three only as one stopped-engine set. |
| `data/sessions/state/` | Worker JSONL, heartbeat, running/terminal, resume-intent, and handoff evidence; in-flight or resumable lanes can no longer be reconciled. |
| `data/sessions/roles/` | Peripheral role JSONL and terminal evidence. |
| `data/logs/` | Engine diagnostic history only. |
| `data/rounds/`, `data/proxy-bundles/`, `data/directives/` | Derived round Markdown, frozen proxy evidence, and archived human directives. Some have SQLite index/source rows, so deleting only the files leaves incomplete artifacts. |

Do not delete `data/EMERGENCY_STOP`, `data/KILL_SWITCH`, or `data/PAUSE` as part of a blanket reset without deciding to lift those operator controls. Do not delete a retained worker worktree: it may contain WIP preserved for inspection (`engine/src/roles/worker.ts`).
