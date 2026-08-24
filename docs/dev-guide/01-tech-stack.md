# 01 — Tech stack

This section records the implementation stack. User-facing installation requirements remain in [Getting started](../guide/getting-started.md).

## Languages & runtime

The engine is TypeScript targeting ES2023. `tsconfig.base.json` enables strict checking, `noUncheckedIndexedAccess`, `noImplicitOverride`, `exactOptionalPropertyTypes`, declarations, and source maps. It uses Node's `NodeNext` module and resolution modes; `engine/package.json` declares `"type": "module"`, so emitted JavaScript is ESM.

Both `package.json` and `engine/package.json` require Node 24 or newer. The state layer imports the built-in `node:sqlite` API (`engine/src/state/state.ts`), avoiding a native SQLite package; the repository standardizes on Node 24 even though the API became unflagged earlier.

## Runtime dependencies

`engine/package.json` declares exactly two runtime packages:

| Package | Role |
| --- | --- |
| `yaml` | Parses `sapwood.config.yaml`; because JSON is valid YAML, the same loader accepts `.json` (`engine/src/config/config.ts`). |
| `zod` | Defines strict configuration, structured role-output, pricing, and artifact validation schemas (`engine/src/config/config.ts`, `engine/src/state/structured-output.ts`). |

Everything else uses Node built-ins, including SQLite, HTTP, crypto, child processes, and the test runner. The minimal dependency set and built-in SQLite choice are explicit supply-chain and zero-native-build choices in `docs/PLAN.md` and `engine/src/state/state.ts`.

## Dev tooling

- npm workspaces: the root `package.json` currently lists only `engine`; root scripts fan out with `npm run -ws` where applicable.
- TypeScript: `tsc` emits `engine/dist/`; `tsc --noEmit` performs type checking (`engine/package.json`).
- Tests: colocated `*.test.ts` files use `node:test`, loaded through `tsx`; there is no Jest or Vitest dependency. This keeps the test framework in Node (`engine/package.json`, `docs/PLAN.md`).
- Biome: `biome.json` supplies formatting and recommended lint rules for `engine/src/**/*.ts`; the root `lint` script runs `biome ci .`.

## External runtime requirements

| Tool | Use | Invocation boundary |
| --- | --- | --- |
| `gh` | GitHub forge reads and writes, including ProjectV2, issues, PRs, and reviews | `engine/src/forge/gh.ts`; `GithubForge` is in `engine/src/forge/forge.ts` |
| `git` | Creates and manages one worktree per worker or role session | `engine/src/roles/worker.ts`, `engine/src/roles/peripheral.ts` |
| Claude Code CLI (`claude`) | Runs headless producer and peripheral sessions | `WorkerSupervisor` in `engine/src/roles/worker.ts` and `RoleRunner` in `engine/src/roles/peripheral.ts` |
| Reviewer service/CLI | Supplies the independent gate verdict | Hosted/trusted/human adapters live in `engine/src/roles/reviewer.ts`; the engine-agent adapter lives under `engine/src/review/` and composes a static `claude` review session. **#501 (2026-08-01): the default mode is `engine-agent`** — sapwood spawns this local `claude` review session itself, on the same CLI it already needs; `different-model-codex` (the pre-#501 default) instead triggers a hosted Codex review through a PR comment, so sapwood never spawns a `codex` executable for that mode either |
| Codex CLI (`codex`) | OPTIONAL — executes the engine-agent review session cross-vendor | Only when `reviewer.agent.runner: codex-exec` (#443): `CodexExecReviewSessionExecutor` in `engine/src/review/codex-exec.ts` spawns `codex exec` against the materialized tree, behind the `ReviewSessionExecutor` seam in `engine/src/review/review-session.ts`. Discovered via `CODEX_BIN` or `PATH`, exactly like `CLAUDE_BIN`. The default runner (`claude`) never touches it. Distinct from the hosted `different-model-codex` mode in the row above: this one is a **local process**, that one is a **GitHub App** |

## What sapwood is NOT built with

- No web framework: no dashboard implementation exists today; see [07 — Dashboard](07-dashboard.md).
- No ORM: `State` executes SQL directly through `node:sqlite` (`engine/src/state/state.ts`).
- No queue or broker: the GitHub ProjectV2 board and labels are the work queue (`CLAUDE.md`, `engine/src/forge/forge.ts`). SQLite stores durable engine state, not a competing task queue.
- No Docker requirement: neither package scripts nor the documented contributor path invokes Docker (`package.json`, `engine/package.json`, `docs/guide/getting-started.md`).
