# 07 — Dashboard (v0.2 — partly built)

The dashboard is **designed in full and built in part**. The `dashboard/`
workspace exists and is load-bearing in CI; its data server is complete against
the design's data contract; the UI is still a scaffold. Read this section as
"which half is real", not as a specification — the authoritative
feature-by-feature spec is [frontend-design.md](../frontend-design.md), and this
guide deliberately does not mirror it.

## What exists today

**The workspace.** Root `package.json` lists `workspaces: ["engine",
"dashboard"]`, so root `-ws` test/typecheck/build reach it. `dashboard/` carries
`package.json` (`@sapwood/dashboard`), `index.html`, `vite.config.ts`, and two
tsconfigs — `tsconfig.json` (bundler resolution, DOM) for `src/` and
`tsconfig.server.json` (NodeNext, no DOM) for the server; `npm run typecheck`
runs both. Runtime dependencies are held to React, React DOM, TanStack Query and
anime.js by a test, per the design's weight budget — no chart library, no CSS
framework.

**The data server** (`dashboard/server.ts`, #142/#360) serves the whole data
contract: four read routes (`GET /api/loop/state`, `/api/events`, `/api/spend`,
`/api/rounds`), the single `dashboard.controls`-gated `POST /api/control`, and
the `dashboard/dist` statics. `createDashboardServer()` opens the engine's own
`State` in `readOnly` mode and binds `127.0.0.1` (default port 4517). It imports
the engine's `State`/config rather than re-querying SQLite, so `sapwood status`
and the dashboard cannot disagree; the config surface is an explicit allowlist;
the write route creates/removes the engine's `PAUSE`/`KILL_SWITCH` sentinels and
never writes a row. The design's §9 "Server — what has landed" records the
decisions behind those choices.

**A thin data layer and design system.** `src/api/` has the fetch client, the
typed payloads, and the polling TanStack Query hooks; `src/tokens.css` +
`src/contrast.ts` implement the design tokens and the WCAG-AA quality-floor
checker (`npm run contrast`); the one bundled display face is committed under
`src/fonts/`.

**Tests and CI.** The workspace has its own suite — `server.test.ts` (the engine-state
derivation truth table, every route's shape and paging contract, the read-only
handle, the loopback bind, the control route's defenses) plus `src/api/api.test.ts`,
`src/scaffold.test.ts` and `src/tokens.test.ts`, run with `node --test`
like the engine's. `.github/workflows/ci.yml` runs `npm --workspace dashboard run
typecheck` and `npm --workspace dashboard test`, so the workspace is gated, not
merely present.

**Proving click/effect wiring: `src/test-dom.ts`.** For most of the dashboard's history the
only render path in tests was `react-dom/server`'s `renderToStaticMarkup` — no effects, no real
events — so a test proving "clicking X calls Y" had no way to click anything; it could only
chain the component's extracted pure functions and hope the JSX wiring on top matched. That gap
was gate②'s single most repeated finding class in the tendency table (retro round #355): the
same "this test doesn't actually exercise the real onClick/composition" shape recurring across
rounds and PRs, each round's fix adding another hand-rolled React-element tree-walker rather
than closing the gap. A test file that needs to click something real now calls
`registerRealDom()` from `src/test-dom.ts` (registers happy-dom in `test.before`/unregisters in
`test.after`) and mounts with `react-dom/client`'s `createRoot`, driving clicks through React's
`act()` — see `Controls.test.tsx`'s own "real DOM" test for the pattern. It is opt-in **per
file**, deliberately: Node's test runner isolates each `*.test.ts(x)` file into its own process,
and happy-dom's `fetch` enforces same-origin/CORS against `window.location`, which breaks
`server.test.ts`'s real network calls if registered process-wide — do not add it to the
dashboard workspace's `test` script's `--import`.

**Upstream of all of it,** the engine already persists the enabling sources:
append-only `events` and `spend_ledger`, `rounds`/`round_artifacts`, live worker
telemetry (`est_cost_usd`, `context_tokens`, `token_composition`), and explicit
transition/degrade/attention events (`engine/src/state/state.ts`,
`engine/src/loop/round-artifact.ts`).

## What is still TODO

- **The UI itself.** `src/App.tsx` is a scaffold shell that renders just enough
  of the payloads to prove the data layer polls and re-renders. The §3 modules —
  loop/round hero, lane board, activity feed, needs-attention strip, cost strip,
  read-only config drawer, and the controls/confirm flow — each land in their own
  issue and none has landed yet.
- **Replay.** The event-folding reducer shared between live and replay, the
  player, and the `?demo` fixture package do not exist; no committed dashboard
  fixture or demo application is in the repo.
- **The launcher.** There is no `sapwood dashboard` command — `sapwood --help`
  lists `init`, `run`, `status`, `park`, `validate` only. `createDashboardServer()`
  has no production caller yet; until the launcher lands the server is started
  from code (the tests do exactly that), and the frontend runs under `vite` dev
  with `/api` proxied to port 4517.
- **`spend.runUsd` stays `null`** until the follow-up that persists the run
  anchor; the header meter falls back whole to the daily tier by design.

The root [`README.md`](../../README.md) roadmap remains the milestone-level
status view.
