# 07 — Dashboard (v0.2 — not yet built)

The dashboard is designed but not implemented. There is no `dashboard/` workspace, frontend package, data server, launcher command, or dashboard test suite in the repository today (`package.json` lists only `engine`).

## What exists today

- `docs/frontend-design.md` specifies information architecture, visual language, accessibility, event copy, API shapes, replay semantics, controls, empty/error states, and performance budgets.
- `docs/loop-walkthrough-v0.2.md` defines the engine states and source-of-truth boundaries the UI must render.
- `docs/round-artifact.md` documents the canonical per-round artifact.
- The repository contains live-run logs and engine state under `data/`, but no committed dashboard fixture package or demo application.
- The engine already persists enabling sources: append-only `events` and `spend_ledger`, `rounds`/`round_artifacts`, live worker telemetry (`est_cost_usd`, `context_tokens`, `token_composition`), and explicit transition/degrade/attention-related events (`engine/src/state/state.ts`, `engine/src/loop/round-artifact.ts`). These are engine records, not a dashboard API.

## Planned architecture (from the design)

TODO: `docs/frontend-design.md` specifies a small dashboard npm workspace with a read-only local data server over `data/sapwood.sqlite`, resolved non-secret config fields, and bounded log/state endpoints. The browser should not open SQLite directly or call GitHub. The data boundary is intended to expose named views and an ordered events API, with schema-version handling and redaction at the server.

TODO: the UI is specified around a loop/round hero, lane board, activity feed, needs-attention strip, and cost strip, plus a read-only config drawer. Replay uses append-only events and spend rows with round rows/artifacts as chapter boundaries; mutable live-only state is kept separate from replay. The design also names narrowly scoped pause/stop/start sentinel controls, but the engine and security docs remain authoritative for whether that write surface is enabled.

No frontend framework, state library, chart library, API implementation, or package versions are locked in executable code today. The design explicitly avoids a chart dependency for simple SVG cost graphics, but this remains TODO until a dashboard package exists.

## TODO

The entire implementation is TODO: the workspace, the read-only data server and
its API routes, every panel, replay, the launcher command, and the dashboard's
own tests. The authoritative feature-by-feature specification is
[frontend-design.md](../frontend-design.md) — this guide deliberately does not
mirror it. The root `README.md` roadmap is the milestone-level status view.
