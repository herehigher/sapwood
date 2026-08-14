# 07 — Dashboard (v0.2)

The dashboard is **designed in full and built out**. The `dashboard/` workspace
exists and is load-bearing in CI; its data server is complete against the
design's data contract, and the §3 UI modules, replay, the `?demo` fixture
package, and the `sapwood dashboard` launcher have all landed. Read this
section as "which pieces are real and where they live", not as a
specification — the authoritative feature-by-feature spec is
[frontend-design.md](../frontend-design.md), and this guide deliberately does
not mirror it.

## What exists today

**The workspace.** Root `package.json` lists `workspaces: ["engine",
"dashboard"]`, so root `-ws` test/typecheck/build reach it. `dashboard/` carries
`package.json` (`@sapwood/dashboard`), `index.html`, `vite.config.ts`, and two
tsconfigs — `tsconfig.json` (bundler resolution, DOM) for `src/` and
`tsconfig.server.json` (NodeNext, no DOM) for the server; `npm run typecheck`
runs both. Runtime dependencies are held to an owner-adjudicated allowlist by a
test, per the design's §2 dependency budget: React, React DOM, TanStack Query,
anime.js, clsx, lucide-react, the two single-package Radix primitives
(tooltip/popover, scoped to hover/focus hint surfaces), and self-hosted
JetBrains Mono — no chart library, no CSS framework.

**Visual evidence: `npm --workspace dashboard run shots`.** Builds the
dashboard, serves `dist/` over `vite preview` (Playwright's own `webServer`
starts and stops it — nothing to run by hand first), and captures the `?demo`
fixture at 1440/1024/720 × light/dark (6 combinations), full page plus
per-module crops. Output is a static HTML contact sheet — `docs/design/mockup/`
frozen baselines on the left, the matching live capture on the right; a module
with no frozen mockup gets a full-page row instead of a crop pairing. No
pixel-diff assertions: the sheet is evidence for a human reviewer or gate②, not
a CI gate — it does not run under `npm test` or in CI. Output lands in
`dashboard/shots-output/` (gitignored); run `npx playwright install chromium`
once before the first local run. This is the tool #729's dispatch material
points reviewers at for before/after visual comparison.

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

**Proving query/data-flow wiring has no equivalent helper yet.** `registerRealDom()` closed the
click-wiring gap; the same class recurred one level up the stack in #866/#868 — a test that
mounts a real entry point but still hands it a synthetic view-model, or a hand-constructed state
combination the real derivation could never itself produce, proves nothing about the actual
TanStack Query hook → server response → render chain (see `docs/REVIEW-DOCTRINE.md`'s WIRING
rule, data-flow sub-shape). Each PR currently re-derives an app-mount-with-settled-queries
pattern ad hoc; the next one to need it should extract it to shared test infra rather than
reinventing it again.

**The UI itself.** `src/App.tsx` wires the full app: the §3 modules — loop/round
hero (`src/hero/Hero.tsx`, `stage.tsx`), lane board (`src/components/LaneBoard.tsx`),
activity feed (`ActivityFeed.tsx`), needs-attention strip (`NeedsAttention.tsx`),
cost strip (`CostStrip.tsx`), the read-only config drawer (`ConfigDrawer.tsx`), the
controls/confirm flow (`Controls.tsx`), plus `Header.tsx` and `IconRail.tsx` — are
all mounted, each with its own test file.

**Replay.** `src/replay/` holds the event-folding reducer shared between live and
replay (`reducer.ts`), the player (`player.ts`), checkpointing (`checkpoint.ts`),
round-log assembly (`round-log.ts`), spend replay (`spend-replay.ts`), and the
`useReplay` hook — each with tests. `src/demo/` holds the `?demo` fixture package:
`source.ts`, `export.ts`/`export-cli.ts`, `useDemoReplay.ts`, and
`build-round-log.ts`, also each with tests.

**The launcher.** `sapwood dashboard` is a first-class CLI verb
(`engine/src/cli.ts`'s usage block, `parseDashboardArgs`, `resolveDashboardPort`);
it builds on `loop/dashboard-launcher.ts`, the only module allowed to spawn the
browser-open child process for this feature. It starts `createDashboardServer()`
against the same state DB `sapwood run`/`status` use, then opens the URL in a
browser (or prints it in a headless environment).

**Upstream of all of it,** the engine already persists the enabling sources:
append-only `events` and `spend_ledger`, `rounds`/`round_artifacts`, live worker
telemetry (`est_cost_usd`, `context_tokens`, `token_composition`), and explicit
transition/degrade/attention events (`engine/src/state/state.ts`,
`engine/src/loop/round-artifact.ts`).

## What is still TODO

- **`spend.runUsd` stays `null`** (`dashboard/server.ts` returns `runUsd: null`,
  asserted by `server.test.ts`) until a follow-up persists a run anchor — there is
  no honest way to compute a run-scoped sum from the DB alone today; the header
  meter falls back whole to the round/daily tiers by design
  (`dashboard/src/App.tsx`'s `resolveRoundSpend`).

The root [`README.md`](../../README.md) roadmap remains the milestone-level
status view.
