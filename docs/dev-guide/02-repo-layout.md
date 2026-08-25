# 02 — Repository layout

Risk labels below mean **CORE** (central behavior; review carefully), **NORMAL** (ordinary contributor surface), and **HANDS-OFF** (human-merge-only; see [08 — Change-risk map](08-change-risk.md)).

## Top level

| Path | Risk | Purpose |
| --- | --- | --- |
| `engine/` | CORE | npm workspace containing the TypeScript engine, prompts, pricing data, tests, and compiled `dist/`. |
| `commands/` | NORMAL | Claude Code slash-command definitions that invoke the engine CLI or manage control sentinels. |
| `docs/` | NORMAL | Durable architecture, configuration, security, usage, and contributor knowledge. Security-policy edits require elevated review. |
| `.sapwood/` | runtime | The engine's runtime directory — see [Configuration — The `.sapwood/` runtime directory](../guide/configuration.md#the-sapwood-runtime-directory). |
| `sapwood.config.yaml` | CORE | This repository's live configuration — the loop runs from it (no `--config`); the whole file is human-merge-only. Starter for other repos: `sapwood.config.example.yaml`. |
| `biome.json` | NORMAL | Formatting and lint policy for TypeScript sources. |
| `tsconfig.base.json` | NORMAL | Shared strict TypeScript/NodeNext compiler policy. |
| `package.json` | NORMAL | Private npm workspace root and root quality scripts. |
| `scripts/` | NORMAL | Repo-level maintenance scripts with no engine dependency (e.g. `check-links.ts`) — distinct from `engine/scripts/`, which is scoped to the engine npm workspace. |
| `.claude-plugin/` | NORMAL | Claude Code plugin manifest and plugin-facing instructions. Guard hooks are currently wired per session in `worker.ts` and `peripheral.ts`, not registered here. |
| `.github/` | HANDS-OFF for workflows | Issue templates and CI workflow; workflow writes are guard-protected. |

## engine/src — the engine workspace

Tests are colocated with their modules as `*.test.ts`.

| Path | Responsibility and important files |
| --- | --- |
| `cli.ts` | Parses `init`, `run`, `status`, and `validate`; wires config, state, forge, supervisors, reviewers, round/tick drivers, logging, and proxy minting. |
| `index.ts` | Public export surface for embedding or tests; it re-exports engine types and entry points. |
| `config/` | Strict config loading and defaults (`config.ts`), review/escalation prose loading (`doctrine.ts`), directive intake/archive (`directive.ts`), and token pricing (`pricing.ts`). |
| `forge/` | `IForge` plus `GithubForge` (`forge.ts`), the no-shell `gh` execution boundary (`gh.ts`), and label namespace/comparison helpers (`labels.ts`). |
| `guard/` | Fail-closed decision core (`guard.ts`), stdin/stdout PreToolUse adapter (`guard-hook.ts`), bypass matrix, and differential fuzz tests. HANDS-OFF. |
| `loop/` | Scheduler and lifecycle: tick phases (`conductor.ts`), flat driver (`driver.ts`), round orchestration (`round.ts`), alignment/pool selection (`align.ts`), initialization (`init.ts`), startup reconciliation, harvest, dissent, environment-failure parking, and round artifacts. |
| `proxy/` | Per-session read-only forge MCP server (`mcp-server.ts`), role/tool access matrix (`access.ts`), scoped minting (`mint.ts`), tool algebra/caps (`tools.ts`), and write-ahead journal/evidence bundles (`journal.ts`). |
| `retro/` | Builds the bounded round digest (`retro-digest.ts`) and runs the self-improvement role whose changes can only arrive through a branch and PR (`retro.ts`). |
| `roles/` | Worker process/worktree protocol (`worker.ts`), role-session runner (`peripheral.ts`), merge gate (`merge-driver.ts`), reviewer adapters (`reviewer.ts`), plan review, architect, prompts, and ambient context manifests. `reviewer.ts` and `merge-driver.ts` are HANDS-OFF. |
| `state/` | SQLite schema and state API (`state.ts`) plus sentinel-delimited structured-output parsing (`structured-output.ts`). |
| `util/` | Small shared utilities; currently Markdown-safe truncation/rendering in `markdown.ts`. |

Outside `src/`, the engine package also carries `engine/prompts/` (shipped role
prompts, init templates, and issue templates — the non-TypeScript behavior
surface; see [09 — Plugin, commands & prompts](09-plugin-commands-prompts.md)),
`engine/pricing.yaml` (the token-pricing table read by `config/pricing.ts`), and
`engine/scripts/` (developer utilities, currently a retro-digest dry-run). The
repo root's `.nvmrc` pins the Node major for version managers.

## commands/ — Claude Code plugin surface

`commands/sapwood-run.md`, `commands/sapwood-status.md`, and `commands/sapwood-dashboard.md`
delegate to the shared package wrapper described in
[09 — Plugin, commands & prompts](09-plugin-commands-prompts.md#slash-commands-commands), while
preserving the target repository as cwd. `commands/sapwood-stop.md` calls the `sapwood
pause`/`stop`/`estop` CLI verbs, which resolve the `EMERGENCY_STOP`/`KILL_SWITCH`/`PAUSE`
sentinel paths internally; the command file never touches `.sapwood/` directly.

## docs/ — documentation partition

`CLAUDE.md` defines the partition: GitHub records development process; repository docs record durable knowledge. Do not duplicate issue mechanics into docs or put knowledge required by users only in GitHub.

| Document | Audience |
| --- | --- |
| `README.md` | Product overview, requirements, architecture, roadmap, and links. |
| `docs/guide/getting-started.md` | Operators installing and starting sapwood. |
| `docs/guide/configuration.md` | Operators configuring all supported keys. |
| `docs/security.md` | Operators and reviewers evaluating trust boundaries and controls. |
| `docs/security/` | Per-mechanism security reference pages linked from `docs/security.md`'s "Mechanism reference" table. |
| `docs/reference/role-paradigm.md` | Designers and implementers of autonomous roles. |
| `docs/PLAN.md` | Architecture, durable decisions, and planned capabilities. |
| `docs/reference/loop-walkthrough.md` | Behavioral reference for round, tick, state, and UI truth. |
| `docs/reference/frontend-design.md` | Dashboard design spec (built; see [07](07-dashboard.md)). |
| `docs/reference/round-artifact.md` | Round artifact contract and interpretation. |
| `docs/guide/troubleshooting.md` | Operator diagnosis and recovery. |
| `docs/dev-guide/` | Contributors changing the repository. |

## Where to find X

| Question | Start here |
| --- | --- |
| Config schema/defaults/load order | `engine/src/config/config.ts` |
| Gate logic and final merge fail-safe | `engine/src/roles/merge-driver.ts` (`deriveGate`, `mergeDecision`) |
| Reviewer identity/freshness/fallback | `engine/src/roles/reviewer.ts` |
| Database schema | `engine/src/state/state.ts` (`MIGRATIONS`) |
| Tick ordering and lane transitions | `engine/src/loop/conductor.ts` (`tick`) |
| Round phases and scoping | `engine/src/loop/round.ts` (`runRounds`) |
| Worker prompt assembly and session context | `engine/src/roles/worker.ts`, `engine/src/roles/context-manifest.ts` |
| Peripheral role runner | `engine/src/roles/peripheral.ts` (`RoleRunner`) |
| Plan-review output validation | `engine/src/roles/plan-review.ts` |
| Label names and matching | `engine/src/forge/labels.ts` |
| Raw GitHub parsing and calls | `engine/src/forge/forge.ts`, `engine/src/forge/gh.ts` |
| Guard decisions and hook adapter | `engine/src/guard/guard.ts`, `engine/src/guard/guard-hook.ts` |
| Forge proxy access and audit | `engine/src/proxy/access.ts`, `engine/src/proxy/journal.ts` |
| CLI/plugin mapping | `engine/src/cli.ts`, `commands/*.md` |
| Role prompt text and templates | `engine/prompts/` (overrides: each role's `promptFile` config key) |
| Token pricing table | `engine/pricing.yaml`, `engine/src/config/pricing.ts` |
