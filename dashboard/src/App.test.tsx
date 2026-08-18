import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { mock } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
// #953: must resolve before "./App.tsx" (transitively imports Radix, via Header.tsx's
// HintTooltip.tsx and CostStrip.tsx's own new by-model tooltip) — see test-dom-eager.ts's own doc
// for why: Radix's useLayoutEffect shim decides whether happy-dom exists at MODULE EVALUATION
// time, and registerRealDom()'s test.before()-based registration used to run too late for it (no
// prior test in this file opened a Radix tooltip via real focus, so the gap went unnoticed). The
// `test.after` call right below (not just a comment) is load-bearing too — it breaks contiguity
// with the import group after it, which stops biome's `organizeImports` from merging the two
// groups back into one alphabetically-sorted block that would undo this ordering.
import { unregisterRealDomEager } from "./test-dom-eager.ts";

test.after(() => unregisterRealDomEager());

import {
  App,
  appContent,
  loadInspectorRoundEvents,
  resolveActiveFold,
  resolveFixCap,
  resolveInspectorArtifact,
  resolveInspectorRound,
  resolveRoundSpend,
  resolveWorkerBudgetUsdSoft,
  toggleConfigOpen,
} from "./App.tsx";
import { demoFixtureQuery, eventsQuery, loopStateQuery, MAX_EVENT_HISTORY, roundsQuery, spendQuery } from "./api/queries.ts";
import type { LoopEvent, Round, SpendRow } from "./api/types.ts";
import { Header } from "./components/Header.tsx";
import { IconRail, railContent } from "./components/IconRail.tsx";
import { NeedsAttention } from "./components/NeedsAttention.tsx";
import { parseColorTokens } from "./contrast.ts";
import { buildClosedRoundCostPanel } from "./cost-panel.ts";
import type { DemoBundle } from "./demo/types.ts";
import { type DomainEvent, toDomainEvent } from "./domain-event.ts";
import type { EntityTitles } from "./entities.ts";
import { Hero } from "./hero/Hero.tsx";
import { foldEvents, type HeroState, initialHeroState } from "./hero/state.ts";
import { foldReplay, initialReplayState } from "./replay/reducer.ts";

/** Same tree-walk IconRail.test.tsx uses — finds a node in a REAL React element tree (never a
 *  `renderToStaticMarkup` string, which strips function props) by exact `className`. */
function findByClassName(node: unknown, className: string): { props: Record<string, unknown> } | null {
  if (node === null || typeof node !== "object") return null;
  const props = (node as { props?: Record<string, unknown> }).props;
  if (props?.className === className) return node as { props: Record<string, unknown> };
  const children = props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findByClassName(child, className);
    if (found) return found;
  }
  return null;
}

/** Same idea, but by element TYPE (a component reference) rather than className — needed to
 *  find the `<IconRail>` element itself in `appContent`'s real tree. */
function findByType(node: unknown, type: unknown): { props: Record<string, unknown> } | null {
  if (node === null || typeof node !== "object") return null;
  const n = node as { type?: unknown; props?: Record<string, unknown> };
  if (n.type === type) return n as { props: Record<string, unknown> };
  const children = n.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findByType(child, type);
    if (found) return found;
  }
  return null;
}

/** A minimal-but-real `Parameters<typeof appContent>[0]` — `loop` only needs the two fields
 *  `appContent` actually reads (`isPending`, `data`); the full TanStack `UseQueryResult` shape
 *  isn't worth hand-implementing for a fixture, so it's cast rather than fully typed. */
function minimalAppViewModel(
  overrides: {
    configOpen?: boolean;
    setConfigOpen?: (updater: unknown) => void;
    mode?: "live" | "replay";
    loop?: unknown;
    roundSpend?: unknown;
    activeHero?: HeroState;
    /** #733 engine-agent finding [2]: a self-consistent "viewing a closed round" fixture needs
     *  BOTH of these set together — `rounds` (what Transport's own round list reads) and
     *  `selectedRoundId` (what decides whether Transport's `back to live` affordance renders) —
     *  or the replay view is an impossible one `useReplay` itself could never actually produce. */
    rounds?: unknown[];
    selectedRoundId?: number | null;
    repoUrl?: string;
    activeEvents?: unknown[];
    activeTitles?: EntityTitles;
    // #861
    inspectorNode?: string | null;
    setInspectorNode?: (updater: unknown) => void;
    inspectorArtifact?: unknown;
    // #868 gate② finding [1]
    inspectorEvents?: unknown[];
    roundEvents?: unknown[];
    // #891 gate① engine-agent finding [2]: distinguishable from the default `[]` so a test can
    // prove `appContent` threads this SAME array to both `<Hero>` and `<NeedsAttention>`.
    activeOpenAttention?: DomainEvent[];
    // #895 item 1: the replay cursor's own timestamp — `null` (live/no round loaded) unless a
    // test explicitly sets it to prove the hero's staleness caption rebases against it.
    asOf?: string | null;
    // #920 gate② finding [0]: `replay.position` defaults to `null` (the loading-window shape) —
    // a test proving a fixture reflects a genuinely LOADED closed round (not just a selection)
    // sets this explicitly, same self-consistency posture `rounds`/`selectedRoundId` above
    // already documents for #733 engine-agent finding [2].
    replayPosition?: unknown;
    // #922 AC5 gate② finding [5]: replay's own phase windows (`replay.phaseWindows`) — defaults
    // to `[]` (no windows), same "nothing selected" posture every other replay field starts in; a
    // test proving `roundPhase={mode === "live" ? ... : phaseAtCursor(...)}` sets this explicitly.
    phaseWindows?: { phase: string; startTs: string; endTs: string | null }[];
  } = {},
) {
  return {
    clock: new Date("2026-01-01T00:00:00Z"),
    loop: overrides.loop ?? { data: undefined, isPending: false },
    events: { events: [], titles: {}, openAttention: [], hero: initialHeroState(null), steps: [], error: undefined, isPending: false },
    disconnected: false,
    parked: false,
    repoUrl: overrides.repoUrl,
    fixCap: 2,
    costToday: { heading: "cost · today", avgRoundUsd: null, stageBars: [], targetUsd: null, modelBars: [], footer: null },
    costRound: null,
    configOpen: overrides.configOpen ?? false,
    setConfigOpen: overrides.setConfigOpen ?? (() => {}),
    inspectorNode: overrides.inspectorNode ?? null,
    setInspectorNode: overrides.setInspectorNode ?? (() => {}),
    inspectorArtifact: overrides.inspectorArtifact ?? null,
    // #868 gate② finding [1]: defaults to whatever `activeEvents` resolved to, so every
    // pre-existing test (which only ever set `activeEvents`) keeps feeding the drawer's
    // event-derived counts the SAME fixture it always did, unchanged — a test proving the
    // round-scoping fix sets `inspectorEvents` explicitly, distinct from `activeEvents`.
    inspectorEvents: overrides.inspectorEvents ?? overrides.activeEvents ?? [],
    // #741: a minimal live-mode replay view — this fixture never exercises replay itself, only
    // App's config-trigger wiring, so every replay field is the same "nothing selected" shape
    // `useReplay` starts in.
    mode: overrides.mode ?? "live",
    rounds: overrides.rounds ?? [],
    replay: {
      mode: overrides.mode ?? "live",
      selectedRoundId: overrides.selectedRoundId ?? null,
      selectRound: () => {},
      loading: false,
      position: overrides.replayPosition ?? null,
      playing: false,
      speed: 1,
      play: () => {},
      pause: () => {},
      setSpeed: () => {},
      scrub: () => {},
      spendThroughCursor: [],
      phaseWindows: overrides.phaseWindows ?? [],
      roundEvents: overrides.roundEvents ?? [],
      roundSpend: [],
      asOf: overrides.asOf ?? null,
    },
    activeHero: overrides.activeHero ?? initialHeroState(null),
    activeSteps: [],
    activeEvents: overrides.activeEvents ?? [],
    activeTitles: overrides.activeTitles ?? {},
    activeOpenAttention: overrides.activeOpenAttention ?? [],
    // Mirrors real `App()`: `spendFacts` is always `loop.data?.spend`, straight through.
    spendFacts: (overrides.loop as { data?: { spend?: unknown } } | undefined)?.data?.spend,
    roundSpend: overrides.roundSpend,
  } as unknown as Parameters<typeof appContent>[0];
}

/**
 * #715 gate② [7]: the documented `disconnected` header state (frontend-design.md §3's closing
 * paragraph — "API unreachable → header flips to disconnected with the command to restart") used
 * to render only `loop.error`'s raw fetch-error text, and nothing at all when just the events
 * query failed. These tests pre-settle a QueryClient's cache (prefetchQuery, `retry: false`) so
 * `useQuery` reads the already-resolved error/success state synchronously on first render —
 * `renderToStaticMarkup` never runs effects, so this is the only way to observe a settled async
 * query without a browser-grade test harness this repo doesn't carry as a dependency.
 */

const LOOP_STATE_OK = {
  engine: { state: "running", reasons: [], lastTickAt: null, pauseActive: false, estopActive: false, standbyNextCheckSec: null },
  lanes: { max: 1, items: [] },
  round: null,
  spend: { todayUsd: 0, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
  rings: 0,
  mergedPrs: [],
  logPath: null,
  config: {},
  controlsEnabled: false,
};

function stubFetch(byPath: Record<string, { status: number; body: unknown }>) {
  mock.method(globalThis, "fetch", async (url: string) => {
    const path = url.split("?")[0]!;
    const resp = byPath[path];
    if (!resp) throw new Error(`unstubbed fetch: ${url}`);
    return new Response(JSON.stringify(resp.body), { status: resp.status, headers: { "content-type": "application/json" } });
  });
}

const SPEND_EMPTY = { "/api/spend": { status: 200, body: { spend: [], lastId: 0 } } };
// #766 gate② finding [2] (rounds-failure-renders-empty): `/api/rounds` is now a FOURTH data
// source `App` depends on — defaults to an empty, successful page for every test that isn't
// specifically exercising rounds, same rationale `SPEND_EMPTY` already documents for `/api/spend`.
const ROUNDS_EMPTY = { "/api/rounds": { status: 200, body: { rounds: [] } } };

async function renderSettledApp(
  byPath: Record<string, { status: number; body: unknown }>,
  now?: Date,
  initialConfigOpen?: boolean,
): Promise<string> {
  stubFetch({ ...SPEND_EMPTY, ...ROUNDS_EMPTY, ...byPath });
  // `retryOnMount: false` matters as much as `retry: false` here: a query that has ONLY ever
  // errored (never succeeded) otherwise re-triggers a fresh fetch the instant a new observer
  // mounts (TanStack Query's default `retryOnMount: true`), which collapses `status` back to
  // 'pending' during that in-flight refetch — `renderToStaticMarkup` runs no effects, so it would
  // capture that transient 'pending' snapshot instead of the settled error this test wants.
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await Promise.allSettled([
    client.prefetchQuery(loopStateQuery()),
    client.prefetchQuery(eventsQuery(0)),
    client.prefetchQuery(spendQuery(0)),
    client.prefetchQuery(roundsQuery()),
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <App now={now} initialConfigOpen={initialConfigOpen} />
    </QueryClientProvider>,
  );
}

/**
 * #861 verification plan: "click interactions use a real DOM via `registerRealDom()` ... with
 * `act()`, because `renderToStaticMarkup` runs no effects and dispatches no events." Same
 * settled-query setup as `renderSettledApp` above, but mounted into a real container via
 * `createRoot` so `onClick`/`onKeyDown`/`Escape` actually fire. `fetchCalls` lets a test assert
 * exactly which URLs were ever fetched (AC5: "no fetch call is made" for the log content).
 */
async function mountSettledApp(byPath: Record<string, { status: number; body: unknown }>, now?: Date) {
  const fetchCalls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    fetchCalls.push(url);
    const path = url.split("?")[0]!;
    const resp = { ...SPEND_EMPTY, ...ROUNDS_EMPTY, ...byPath }[path];
    if (!resp) throw new Error(`unstubbed fetch: ${url}`);
    return new Response(JSON.stringify(resp.body), { status: resp.status, headers: { "content-type": "application/json" } });
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await Promise.allSettled([
    client.prefetchQuery(loopStateQuery()),
    client.prefetchQuery(eventsQuery(0)),
    client.prefetchQuery(spendQuery(0)),
    client.prefetchQuery(roundsQuery()),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <App now={now} />
      </QueryClientProvider>,
    );
  });
  const unmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  return { container, fetchCalls, unmount };
}

test.afterEach(() => mock.restoreAll());

test("#716 gate② P1-3: resolveFixCap reads the nested lanes.prFixCap path, not a flat bracket lookup", () => {
  // A non-default cap (6, not the hardcoded fallback 2) — the regression this pins is the flat
  // `config["lanes.prFixCap"]` lookup silently missing every real (nested) server config and
  // always falling back to the default, which a default-valued fixture couldn't distinguish.
  assert.equal(resolveFixCap({ lanes: { prFixCap: 6 } }), 6);
  assert.equal(resolveFixCap({ "lanes.prFixCap": 6 }), 2, "a flat dotted key must not match — the server never serves one");
  assert.equal(resolveFixCap(null), 2);
  assert.equal(resolveFixCap(undefined), 2);
  assert.equal(resolveFixCap({ lanes: {} }), 2);
  assert.equal(resolveFixCap({ lanes: { prFixCap: "6" } }), 2, "a non-number value is never coerced");
});

test("#890: resolveWorkerBudgetUsdSoft reads the nested worker.budgetUsdSoft path, honest-null when unreadable", () => {
  assert.equal(resolveWorkerBudgetUsdSoft({ worker: { budgetUsdSoft: 12 } }), 12);
  assert.equal(resolveWorkerBudgetUsdSoft({ "worker.budgetUsdSoft": 12 }), null, "a flat dotted key must not match");
  assert.equal(resolveWorkerBudgetUsdSoft(null), null);
  assert.equal(resolveWorkerBudgetUsdSoft(undefined), null);
  assert.equal(resolveWorkerBudgetUsdSoft({ worker: {} }), null);
  assert.equal(resolveWorkerBudgetUsdSoft({ worker: { budgetUsdSoft: "12" } }), null, "a non-number value is never coerced");
});

// ── PR #900 gate② finding [1] (attention-strip-wiring-proof): #893's newly-mapped attention
// kinds proven through the REAL production path — a raw wire event from `/api/events`, through
// `useEventHistory`'s real `foldOpenAttention` fold, into `App`'s own `activeOpenAttention` prop
// wiring, rendering the real `NeedsAttention` entry point — not a hand-classified event injected
// directly into the component in isolation. ──────────────────────────────────────────────────

test("#900 finding [1]: review-silence-escalated reaches the needs-attention strip through the REAL wire→fold→App wiring, rendering its REVIEW SILENCE chip", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": {
      status: 200,
      body: {
        events: [{ id: 1, ts: "2026-08-14T00:00:00Z", kind: "review-silence-escalated", payload: { pr: 42, issue: 7, silenceSec: 600 } }],
        lastId: 1,
      },
    },
  });
  assert.match(html, /aria-label="needs attention"/, "the strip section must actually render, not be skipped as empty");
  // #925: the chip now also carries an inline `style` (its per-category tone) between the class
  // attribute and its text — matched loosely rather than the exact adjacent-attribute string.
  assert.match(html, /class="attention-chip"[^>]*>REVIEW SILENCE</);
  assert.match(html, /went unanswered/);
});

test("#900 finding [1]: review-disputed and review-non-convergent BOTH reach the strip through the real wiring, rendering the DISSENT chip", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": {
      status: 200,
      body: {
        events: [
          { id: 1, ts: "2026-08-14T00:00:00Z", kind: "review-disputed", payload: { pr: 42, issue: 7, worker: "w1" } },
          { id: 2, ts: "2026-08-14T00:01:00Z", kind: "review-non-convergent", payload: { pr: 43, issue: 8, worker: "w1" } },
        ],
        lastId: 2,
      },
    },
  });
  const dissentChips = html.match(/class="attention-chip"[^>]*>DISSENT</g)?.length ?? 0;
  assert.equal(dissentChips, 2, "both review-disputed and review-non-convergent must independently reach the strip");
});

test("#715 gate② [7]: header shows the documented disconnected caption when /api/loop/state fails", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 503, body: { error: "nope" } },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.match(html, /disconnected — restart sapwood to reconnect/);
  assert.doesNotMatch(html, /503/, "the header must never leak the raw fetch-error message");
});

test("#715 gate② [7]: header ALSO shows disconnected when only /api/events fails (loop-state is fine)", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 503, body: { error: "nope" } },
  });
  assert.match(html, /disconnected — restart sapwood to reconnect/);
});

test("#715 gate② round 4 [2]: header ALSO shows disconnected when only /api/spend fails (loop-state and events are fine)", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
    "/api/spend": { status: 503, body: { error: "nope" } },
  });
  assert.match(html, /disconnected — restart sapwood to reconnect/);
  assert.doesNotMatch(html, /503/, "the header must never leak the raw fetch-error message");
});

// #766 gate② finding [2] round 3 (rounds-failure-renders-empty): `useRounds()` introduced a
// FOURTH required data source that `disconnected` didn't originally check — a failed `/api/rounds`
// used to leave the header reading healthy while `rounds.data?.rounds ?? []` silently rendered the
// truthful-empty "no rounds yet" caption, converting a real transport failure into an
// honest-looking empty history.
test("#766 gate② finding [2]: header ALSO shows disconnected when only /api/rounds fails (loop-state, events, and spend are fine)", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
    "/api/rounds": { status: 503, body: { error: "nope" } },
  });
  assert.match(html, /disconnected — restart sapwood to reconnect/);
  assert.doesNotMatch(html, /503/, "the header must never leak the raw fetch-error message");
  assert.doesNotMatch(html, /no rounds yet/, "a rounds FETCH failure must never be presented as an honest empty history");
});

// #733 AC4: fed through the REAL App tree (renderSettledApp -> appContent -> Header/Controls),
// never an isolated Controls render with hand-built props — estopActive is the only field that
// differs between the two fetches below.
test("#733 AC4: EMERGENCY_STOP active — Start is disabled and names the real release lever (sapwood estop clear); inactive — Start behaves normally", async () => {
  const activeHtml = await renderSettledApp({
    "/api/loop/state": {
      status: 200,
      body: { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "stopped", estopActive: true } },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.match(activeHtml, /sapwood estop clear/);
  assert.match(activeHtml, /<button[^>]*disabled[^>]*>Start<\/button>/, "Start must not report a resumed outcome while the halt persists");

  const normalHtml = await renderSettledApp({
    "/api/loop/state": {
      status: 200,
      body: { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "stopped", estopActive: false } },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.doesNotMatch(normalHtml, /sapwood estop clear/);
  assert.doesNotMatch(normalHtml, /<button[^>]*disabled[^>]*>Start<\/button>/);
  assert.match(normalHtml, />Start</, "Start renders normally when no halt is active");
});

// #733 engine-agent finding [1]: `engine.state === "running"` and `engine.estopActive === true`
// are NOT mutually exclusive on the real server (`currentEngineState` never folds EMERGENCY_STOP
// into the derived word) — fed through the real App tree with exactly that combination, proving
// App.tsx's `running={loop.data?.engine.state === "running"}` wiring doesn't resurrect the button
// the halt already fired.
test("#733 engine-agent finding [1]: EMERGENCY STOP button never renders when estopActive is true, even while engine.state still reads running", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": {
      status: 200,
      body: { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "running", estopActive: true } },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  // Not a bare /EMERGENCY STOP/ check — the Start persists-notice also legitimately says
  // "EMERGENCY STOP is active…" here (asserted by the AC4 test above); "control-estop" is the
  // button's own class, the precise signal for whether the BUTTON rendered.
  assert.doesNotMatch(html, /class="control-estop"/, "nothing left to stop once the halt has already landed");
});

// #733 AC5 / §3 Operations "two placement rules": the WHOLE control group — including
// EMERGENCY STOP — hides entirely while viewing a closed round, since every verb acts on the
// PRESENT engine while the rest of the page shows an as-of-cursor past; the "back to live" jump
// takes the control group's place.
//
// #733 engine-agent finding [2]: the previous version of this test set `mode: "replay"` while
// leaving `rounds` empty and `replay.selectedRoundId` null — an IMPOSSIBLE view `useReplay` could
// never actually produce (nothing is selected, so there is no round being replayed), and it never
// asserted "back to live" at all. This version selects a real `done` round present in `rounds`, so
// Transport's own `selected` derivation (`rounds.find(r => r.roundId === selectedRoundId)`) is
// genuinely truthy and the "back to live" affordance is a real, asserted fact, not an accident of
// an unreachable fixture.
test("#733 AC5: a selected closed round hides the control group entirely and shows 'back to live' in its place", () => {
  const data = { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "running" } };
  const closedRound = {
    roundId: 42,
    status: "done",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T01:00:00Z",
    startEventId: 1,
    startSpendId: 1,
    eventCount: 10,
    schemaVersion: null,
    artifact: null,
  };

  const replayVm = minimalAppViewModel({ mode: "replay", loop: { data, isPending: false }, rounds: [closedRound], selectedRoundId: 42 });
  const replayHtml = renderToStaticMarkup(appContent(replayVm));
  assert.doesNotMatch(replayHtml, /aria-label="operations"/, "the control group must not render at all while a closed round is selected");
  assert.doesNotMatch(replayHtml, /EMERGENCY STOP/);
  assert.match(replayHtml, /back to live/, "the 'back to live' affordance must be present in the control group's place");

  // Sanity: the SAME rounds list with NOTHING selected (live) renders the control group and no
  // "back to live" jump — proves the assertions above are a real regression guard tied to
  // selection, not a fixture that always/never renders "back to live" regardless of it.
  const liveVm = minimalAppViewModel({ mode: "live", loop: { data, isPending: false }, rounds: [closedRound] });
  const liveHtml = renderToStaticMarkup(appContent(liveVm));
  assert.match(liveHtml, /aria-label="operations"/, "same rounds list, nothing selected -> the control group DOES render");
  assert.match(liveHtml, /EMERGENCY STOP/, "engine.state running -> EMERGENCY STOP renders too");
  assert.doesNotMatch(liveHtml, /back to live/, "no round selected -> no 'back to live' jump either");
});

// #922 AC5 gate② finding [5] (ac5-active-capture): "replay highlights the cursor's phase" —
// `roundPhase` is now derived from `phaseAtCursor(replay.phaseWindows, replay.asOf)` in replay
// mode, never a hardcoded `null` (`App.tsx`'s own call site). Proves BOTH halves at once: (1) the
// active planning node genuinely renders during replay (the whole point — without this wiring no
// `?demo` capture could ever show one, AC5's own bug); (2) dimming stays a LIVE-only concept even
// though `roundPhase` is non-null now — a dimming engine state (`stopped`) + the SAME asOf/
// phaseWindows fixture must NOT dim in replay, only in live (`Hero.tsx`'s `live` prop, not
// `roundPhase !== null`, is what gates it post-#922).
test("#922 AC5: replay derives an active planning node from the cursor's own phase window, and never dims from it (live-only dimming stays intact)", () => {
  const data = { ...LOOP_STATE_OK, engine: { ...LOOP_STATE_OK.engine, state: "stopped" } };
  const phaseWindows = [{ phase: "aligning", startTs: "2026-01-01T00:00:00Z", endTs: null }];
  const closedRound = {
    roundId: 42,
    status: "done",
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: null,
    startEventId: 1,
    startSpendId: 1,
    eventCount: 10,
    schemaVersion: null,
    artifact: null,
  };

  const replayVm = minimalAppViewModel({
    mode: "replay",
    loop: { data, isPending: false },
    rounds: [closedRound],
    selectedRoundId: 42,
    asOf: "2026-01-01T00:05:00Z",
    phaseWindows,
    activeHero: initialHeroState(1),
  });
  const replayHtml = renderToStaticMarkup(appContent(replayVm));
  assert.match(replayHtml, /data-active="true"/, "the replay cursor's own phase (aligning) must render an active planning node");
  assert.doesNotMatch(
    replayHtml,
    /data-dimmed="true"/,
    "a dimming engine state must NOT dim the stage in replay — dimming is live-only, even with a non-null roundPhase",
  );

  // Sanity: the SAME phase/asOf fixture in LIVE mode (round.phase set instead of derived from the
  // replay cursor) DOES dim under the same dimming engine state — proves the assertion above is a
  // real regression guard tied to `live`, not a fixture that never dims regardless of it.
  const liveData = { ...data, round: { phase: "aligning" } };
  const liveVm = minimalAppViewModel({ mode: "live", loop: { data: liveData, isPending: false }, activeHero: initialHeroState(1) });
  const liveHtml = renderToStaticMarkup(appContent(liveVm));
  assert.match(liveHtml, /data-active="true"/, "live mode with the same phase also renders the active planning node");
  assert.match(liveHtml, /data-dimmed="true"/, "live mode with a dimming engine state DOES dim — the same fixture, only `live` differs");
});

test("both queries succeeding renders the normal header, not disconnected", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.doesNotMatch(html, /disconnected/);
  assert.match(html, />running</);
});

// #890 (§3 E): a running lane's engine-provided `estCostUsd`, through the REAL wire→`LiveApp`→
// `sumEstCostUsd`→`<Header estUsd>`/`<CostStrip>` derivation — never a hand-assembled `estUsd`
// prop. WIRING doctrine's data-flow sub-shape: mounted with a real prefetched/settled
// `/api/loop/state` query, not `appContent` called directly with a constructed view model.
test("#890: a live lane's estCostUsd flows through the real fetch pipeline into the header's est tail and the Lanes cost bar's hatch", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": {
      status: 200,
      body: {
        ...LOOP_STATE_OK,
        spend: { todayUsd: 10.4, dailyBudgetUsd: 100, runUsd: null, runBudgetUsd: null, byModel: [] },
        lanes: {
          max: 1,
          items: [
            {
              lane: "w1",
              issue: 90,
              state: "running",
              pr: null,
              startedAt: "2026-08-14T00:00:00Z",
              endedAt: null,
              costUsd: null,
              estCostUsd: 2.2,
              contextTokens: null,
              tokenComposition: null,
            },
          ],
        },
      },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.match(html, /\$10\.40 \+ \$2\.20 est \/ \$100\.00/, "the header meter's est tail must read the lane's own live estimate");
  // #890: a hatch fill-url ANYWHERE on the page is non-discriminating — Header's own est tail
  // already guarantees one regardless of whether the cost panel's own `estUsd` wiring works.
  // Scoping the check to the markup FROM the cost strip's own `id="cost"` anchor onward
  // isolates CostStrip's own subtree — dropping
  // `sumEstCostUsd`'s wiring into `buildTodayCostPanelFromBuckets` would leave THIS assertion red
  // even though the header's own hatch (rendered earlier in the DOM) stays green.
  const costSectionHtml = html.slice(html.indexOf('id="cost"'));
  assert.match(
    costSectionHtml,
    /url\(#cost-bar-est-hatch\)/,
    "the cost panel's own Lanes stage bar must render hatched, independent of the header's own bar",
  );
  // #890: the header/cost-panel assertions above prove `estCostUsd` reached THOSE two
  // consumers, but AC2 is about the LANE CARD itself — this same fixture's lane must render
  // its own "$2.20 est" text and its own hatched bar, isolated to the `aria-label="lanes"`
  // subtree so this can't pass on the header's or cost panel's hatch alone.
  const laneSectionHtml = html.slice(html.indexOf('aria-label="lanes"'), html.indexOf('id="cost"'));
  assert.match(laneSectionHtml, /\$2\.20 est/, "the lane card's own settled/est text must read the lane's live estimate, not '—'");
  assert.match(laneSectionHtml, /class="cost-bar lane-card-bar"/, "the lane card's own CostBar must render");
  assert.match(
    laneSectionHtml,
    /url\(#cost-bar-est-hatch\)/,
    "the lane card's own bar must render hatched, independent of the header's/cost panel's own bars",
  );
});

// #890: a self-scaled `max` (settledUsd + estUsd) draws every positive lane spend as a
// 100%-wide bar regardless of size, losing all budget context. Proven through the real fetch
// pipeline: a lane settled at $2 against a configured `worker.budgetUsdSoft: 10` must draw a
// 20%-wide solid fill, never 100%.
test("#890: a lane's settled cost bar scales against worker.budgetUsdSoft, not itself — a small settled amount never draws a full-width bar", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": {
      status: 200,
      body: {
        ...LOOP_STATE_OK,
        config: { worker: { budgetUsdSoft: 10 } },
        lanes: {
          max: 1,
          items: [
            {
              lane: "w1",
              issue: 90,
              state: "running",
              pr: null,
              startedAt: "2026-08-14T00:00:00Z",
              endedAt: null,
              costUsd: 2,
              estCostUsd: null,
              contextTokens: null,
              tokenComposition: null,
            },
          ],
        },
      },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  const laneBarSvg = html.slice(
    html.indexOf('class="cost-bar lane-card-bar"'),
    html.indexOf("</svg>", html.indexOf('class="cost-bar lane-card-bar"')),
  );
  // The background TRACK line is always full-width (x1="0" x2="100%", a fixed reference) — the
  // settled FILL rect (`class="cost-bar-fill"`, its colour resolved through CSS from
  // `--sap-fill`) is the one whose own `width` must scale against the configured ceiling.
  assert.match(laneBarSvg, /class="cost-bar-fill" x="0"[^>]*width="20%"/, "$2 against a $10 soft budget must draw a 20%-wide fill");
  assert.doesNotMatch(
    laneBarSvg,
    /class="cost-bar-fill" x="0"[^>]*width="100%"/,
    "the settled fill must never self-scale to a full-width bar regardless of the real dollar amount",
  );
});

test("#890: no running lane (LOOP_STATE_OK's own empty lanes.items) renders no est tail at all — never a fabricated one", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.doesNotMatch(html, / est/);
});

// #723: AC12 operator probe — the header must render `standby` (with its calm caption and the
// next-check countdown), never `stalled`, during a healthy backoff dwell.
test("#723: header renders the standby word with its plain-language caption and next-check countdown, not stalled", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": {
      status: 200,
      body: {
        ...LOOP_STATE_OK,
        engine: { state: "standby", reasons: [], lastTickAt: null, pauseActive: false, estopActive: false, standbyNextCheckSec: 42 },
      },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.match(html, />standby</);
  assert.match(html, /idle — nothing to work on right now — checking again in 42s/);
  assert.doesNotMatch(html, /stalled/);
});

test("#715/#880 gate② finding today-stage-history-truncation: TODAY's by-stage bars union EVERY round that started today via the real per-round fetch, not just one hand-injected panel", async () => {
  // Two rounds both started today, each with their own event/spend id ranges — proving the union
  // spans MULTIPLE rounds' fetches, not just a single round's. Round A's lane already left the
  // active set (`lanes.items: []`) and carries no `round-phase` event, so its spend row buckets as
  // "Unattributed" — still visible, never silently dropped, the same #715 scenario as before
  // (the active-worker read model alone would show nothing for this lane). Round B's spend carries
  // a real `round-phase` window, proving cross-round stage attribution also works.
  const ROUND_A_ID = 88006;
  const ROUND_B_ID = 88007;
  const rounds = [
    {
      roundId: ROUND_A_ID,
      status: "done",
      startedAt: "2026-08-06T00:30:00Z",
      endedAt: "2026-08-06T01:30:00Z",
      startEventId: 0,
      startSpendId: 0,
      eventCount: 0,
      schemaVersion: 1,
      artifact: null,
    },
    {
      roundId: ROUND_B_ID,
      status: "done",
      startedAt: "2026-08-06T02:00:00Z",
      endedAt: "2026-08-06T03:00:00Z",
      startEventId: 10,
      startSpendId: 10,
      eventCount: 1,
      schemaVersion: 1,
      artifact: null,
    },
  ];
  const spend = [
    {
      id: 1,
      ts: "2026-08-06T01:00:00Z",
      worker: "w1",
      issue: 5,
      usd: 3.4,
      model: "opus",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      actorKind: "worker",
      role: null,
      estimated: false,
    },
    {
      id: 11,
      ts: "2026-08-06T02:30:00Z",
      worker: "w2",
      issue: 6,
      usd: 1.1,
      model: "sonnet",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      actorKind: "worker",
      role: null,
      estimated: false,
    },
  ];
  const events = [{ id: 11, ts: "2026-08-06T02:00:00Z", kind: "round-phase", payload: { round_id: ROUND_B_ID, phase: "aligning" } }];
  mock.method(globalThis, "fetch", async (url: string) => {
    const parsed = new URL(url, "http://localhost");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/api/loop/state") return json({ ...LOOP_STATE_OK, lanes: { max: 1, items: [] } });
    if (parsed.pathname === "/api/rounds") return json({ rounds });
    if (parsed.pathname === "/api/events") {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const page = events.filter((e) => e.id > after);
      return json({ events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after });
    }
    if (parsed.pathname === "/api/spend") {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 200);
      const page = spend.filter((r) => r.id > after).slice(0, limit);
      return json({ spend: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await Promise.allSettled([
    client.prefetchQuery(loopStateQuery()),
    client.prefetchQuery(eventsQuery(0)),
    client.prefetchQuery(spendQuery(0)),
    client.prefetchQuery(roundsQuery()),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <App now={new Date("2026-08-06T12:00:00Z")} />
      </QueryClientProvider>,
    );
  });
  try {
    // `useTodayCostLog`'s fetch is itself async — flush its effect+promise chain.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const html = container.innerHTML;
    // Round A (no round-phase event) -> Unattributed; round B (a real "aligning" round-phase
    // window) -> Goal & align. Both present together proves the fetch spans BOTH rounds, not just
    // whichever one happened to be selected as "last closed".
    assert.match(html, /Unattributed/);
    assert.match(html, /\$3\.40/);
    assert.match(html, /\$1\.10/);
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// #888 gate② run 949439c8 finding [0] (today-phase-window-cross-round), plus the follow-up final
// gate② finding (same-timestamp round boundary): unlike the test above (round A deliberately has
// NO round-phase trail, so it can only ever bucket as Unattributed), this gives BOTH rounds a real
// trail, including each one's own terminal `closed` phase — the exact shape a real round log has.
// Round A's own per-round fetch necessarily leaves its trailing `closed` window OPEN-ENDED
// (nothing in round A's own truncated event log bounds it — see `PhaseWindow`'s own doc); once
// `useTodayCostLog` concatenates round A's windows ahead of round B's, `bucketSpendByPhase`'s
// first-match `.find` can let round A's stale open window swallow round B's later, REAL spend
// before round B's own window is ever checked. Round B's spend lands inside its own real
// "aligning" window, so a correct implementation must show it there — a naive implementation
// instead drops it (the "closed" phase bucket has no display slot at all). Also carries a row
// belonging to round A BY ID whose ts EQUALS round B's own `startedAt` exactly (the tie the
// ID-cursor guarantee exists to disambiguate) — a timestamp-window-capping fix for the first half
// of this finding reintroduces the SAME leak at that exact instant, so a correct fix must keep
// round association by ID all the way through bucketing, never by a timestamp boundary alone.
test("#888 gate② run 949439c8 finding [0]: TODAY's by-stage bars correctly attribute a LATER round's spend to its OWN phase window, never swallowed by an EARLIER round's open-ended trailing window", async () => {
  const ROUND_A_ID = 88020;
  const ROUND_B_ID = 88021;
  const rounds = [
    {
      roundId: ROUND_A_ID,
      status: "done",
      startedAt: "2026-08-06T00:00:00Z",
      endedAt: "2026-08-06T00:20:00Z",
      startEventId: 0,
      startSpendId: 0,
      eventCount: 3,
      schemaVersion: null,
      artifact: null,
    },
    {
      roundId: ROUND_B_ID,
      status: "done",
      startedAt: "2026-08-06T02:00:00Z",
      endedAt: "2026-08-06T02:10:00Z",
      startEventId: 9,
      startSpendId: 9,
      eventCount: 2,
      schemaVersion: null,
      artifact: null,
    },
  ];
  // Round A's own full trail: aligning -> executing -> closed. Round B's own full trail:
  // aligning -> closed. Both terminal `closed` events land WITHIN their own round's id window
  // (below the next round's own startEventId), matching a real round log exactly.
  const events = [
    { id: 1, ts: "2026-08-06T00:00:00Z", kind: "round-phase", payload: { round_id: ROUND_A_ID, phase: "aligning" } },
    { id: 2, ts: "2026-08-06T00:10:00Z", kind: "round-phase", payload: { round_id: ROUND_A_ID, phase: "executing" } },
    { id: 3, ts: "2026-08-06T00:20:00Z", kind: "round-phase", payload: { round_id: ROUND_A_ID, phase: "closed" } },
    { id: 10, ts: "2026-08-06T02:00:00Z", kind: "round-phase", payload: { round_id: ROUND_B_ID, phase: "aligning" } },
    { id: 11, ts: "2026-08-06T02:10:00Z", kind: "round-phase", payload: { round_id: ROUND_B_ID, phase: "closed" } },
  ];
  const spend = [
    // Round A's own spend, inside its own "executing" window — unaffected by the defect either way.
    {
      id: 1,
      ts: "2026-08-06T00:15:00Z",
      worker: "w1",
      issue: 5,
      usd: 3.4,
      model: "opus",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      actorKind: "worker",
      role: null,
      estimated: false,
    },
    // Round B's own spend, inside its own "aligning" window — but its ts falls AFTER round A's
    // own trailing "closed" window's start, so an unbounded concatenation misattributes it to
    // round A's "closed" phase and drops it entirely.
    {
      id: 11,
      ts: "2026-08-06T02:05:00Z",
      worker: "w2",
      issue: 6,
      usd: 1.1,
      model: "sonnet",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      actorKind: "worker",
      role: null,
      estimated: false,
    },
    // #888 gate② final finding (same-timestamp round boundary): round A's OWN spend (id 2, well
    // under round B's startSpendId cursor — the ID partition `loadClosedRoundCostLog` already
    // gives it), but its ts EQUALS round B's own `startedAt` EXACTLY — the tie the ID-cursor
    // guarantee (frontend-design.md §8) exists specifically to disambiguate. A timestamp-only
    // implementation that caps round A's own trailing window at that same instant excludes this
    // row from round A (half-open windows are `ts < endTs`) and then lets it fall through into
    // round B's own "aligning" window instead — inflating round B's real phase total with a row
    // that, by ID, undeniably belongs to round A.
    {
      id: 2,
      ts: "2026-08-06T02:00:00Z",
      worker: "w1",
      issue: 5,
      usd: 5.5,
      model: "opus",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      actorKind: "worker",
      role: null,
      estimated: false,
    },
  ];
  mock.method(globalThis, "fetch", async (url: string) => {
    const parsed = new URL(url, "http://localhost");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/api/loop/state") return json({ ...LOOP_STATE_OK, lanes: { max: 1, items: [] } });
    if (parsed.pathname === "/api/rounds") return json({ rounds });
    if (parsed.pathname === "/api/events") {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const page = events.filter((e) => e.id > after);
      return json({ events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after });
    }
    if (parsed.pathname === "/api/spend") {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 200);
      const page = spend.filter((r) => r.id > after).slice(0, limit);
      return json({ spend: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await Promise.allSettled([
    client.prefetchQuery(loopStateQuery()),
    client.prefetchQuery(eventsQuery(0)),
    client.prefetchQuery(spendQuery(0)),
    client.prefetchQuery(roundsQuery()),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <App now={new Date("2026-08-06T12:00:00Z")} />
      </QueryClientProvider>,
    );
  });
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // Scope to the TODAY panel specifically (the first `.cost-panel`) — round B, being the
    // last-CLOSED round of the day, would ALSO populate its own correct "COST · ROUND N" panel
    // regardless of this defect (that panel buckets one round's own log in isolation), so
    // asserting anywhere in the whole document would pass even with the bug still present.
    const todayPanel = container.querySelectorAll(".cost-panel")[0] as Element;
    assert.ok(todayPanel, "the TODAY panel must render");
    assert.ok(
      todayPanel.querySelector('[aria-label="Lanes: $3.40"]'),
      "round A's own spend still buckets correctly under its own real phase",
    );
    assert.ok(
      todayPanel.querySelector('[aria-label="Goal & align: $1.10"]'),
      "round B's own spend must bucket under ITS OWN real phase, not vanish into round A's stale open 'closed' window",
    );
    assert.equal(
      todayPanel.querySelector('[aria-label^="Goal & align:"]')?.getAttribute("aria-label"),
      "Goal & align: $1.10",
      "round A's OWN same-timestamp-boundary row (ts === round B's startedAt) must NOT leak into round B's real phase, inflating it past round B's own $1.10",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// #888 gate② run 949439c8 finding [1] (today-cost-log-stale-within-round): `useTodayCostLog`'s
// effect used to key ONLY on the round ID set (+ lanesMax) — once an in-progress round FIRST
// appears, every later `/api/rounds` poll keeps naming the SAME round id, so a fresh phase event
// or spend row landing on that still-open round never re-triggered the fetch; TODAY's by-stage
// panel froze at its very first snapshot for the rest of the round. This mounts the app, lets the
// round's initial single spend row settle, then grows the SAME round's spend (no new round, no
// new id) and forces the poll-equivalent refetch `client.refetchQueries()` already exercises for
// every other live query in this suite — a correct implementation must pick up the new row.
test("#888 gate② run 949439c8 finding [1]: TODAY's by-stage bars stay fresh when the SAME in-progress round gains spend after the first render", async () => {
  const ROUND_ID = 88030;
  const round = {
    roundId: ROUND_ID,
    status: "in_progress",
    startedAt: "2026-08-06T00:00:00Z",
    endedAt: null,
    startEventId: 0,
    startSpendId: 0,
    eventCount: 1,
    schemaVersion: null,
    artifact: null,
  };
  const events = [{ id: 1, ts: "2026-08-06T00:05:00Z", kind: "round-phase", payload: { round_id: ROUND_ID, phase: "aligning" } }];
  const spend: SpendRow[] = [
    {
      id: 1,
      ts: "2026-08-06T00:06:00Z",
      worker: "w1",
      issue: 5,
      usd: 2.0,
      model: "opus",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      actorKind: "worker",
      role: null,
      estimated: false,
    },
  ];
  mock.method(globalThis, "fetch", async (url: string) => {
    const parsed = new URL(url, "http://localhost");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    // The by-model total already flows live off THIS same poll payload — the exact "already
    // flowing" signal the fix is meant to key on, computed fresh every call from `spend`'s
    // current contents (never a separately-tracked counter that could itself go stale).
    const todayUsd = spend.reduce((sum, r) => sum + r.usd, 0);
    if (parsed.pathname === "/api/loop/state") {
      return json({ ...LOOP_STATE_OK, lanes: { max: 1, items: [] }, spend: { ...LOOP_STATE_OK.spend, todayUsd } });
    }
    if (parsed.pathname === "/api/rounds") return json({ rounds: [round] });
    if (parsed.pathname === "/api/events") {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const page = events.filter((e) => e.id > after);
      return json({ events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after });
    }
    if (parsed.pathname === "/api/spend") {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 200);
      const page = spend.filter((r) => r.id > after).slice(0, limit);
      return json({ spend: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await Promise.allSettled([
    client.prefetchQuery(loopStateQuery()),
    client.prefetchQuery(eventsQuery(0)),
    client.prefetchQuery(spendQuery(0)),
    client.prefetchQuery(roundsQuery()),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <App now={new Date("2026-08-06T12:00:00Z")} />
      </QueryClientProvider>,
    );
  });
  try {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    assert.ok(container.querySelector('[aria-label="Goal & align: $2.00"]'), "first render shows the round's initial single spend row");

    // The SAME round id gains a second spend row — no new round opens, no `/api/rounds` set
    // change — then a poll-equivalent refetch runs, same as every other live query on a tick.
    spend.push({
      id: 2,
      ts: "2026-08-06T00:07:00Z",
      worker: "w1",
      issue: 5,
      usd: 1.5,
      model: "opus",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      actorKind: "worker",
      role: null,
      estimated: false,
    });
    await act(async () => {
      await client.refetchQueries();
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    assert.ok(
      container.querySelector('[aria-label="Goal & align: $3.50"]'),
      "the SAME round id gaining spend must refresh TODAY's by-stage total, not freeze at the first snapshot",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// #727 gate② finding config-trigger-test-is-static: IconRail.test.tsx's own render-only test
// can only prove the gear's markup exists, never that clicking it drives App's real `configOpen`
// state into the SAME `ConfigDrawer` #145 built (`renderToStaticMarkup` runs no effects and
// dispatches no real click — this repo's test harness has no jsdom, same limitation
// Controls.test.tsx documents for its own confirm flow). `initialConfigOpen` is the equivalent
// test seam Controls.tsx already established for exactly this class of problem: put the
// component directly into the state a click would produce, and assert the render for that state.
test("#727 gate②: configOpen=true renders the SAME ConfigDrawer the rail gear drives; the removed header trigger never reappears", async () => {
  const closedHtml = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.doesNotMatch(closedHtml, /Config ▸/, "the header trigger #727 removed must never come back");
  assert.doesNotMatch(closedHtml, /aria-label="config"/, "closed by default — ConfigDrawer returns null while !open");
  assert.match(closedHtml, /aria-label="open config"/, "the rail gear is the only remaining trigger");

  const openHtml = await renderSettledApp(
    { "/api/loop/state": { status: 200, body: LOOP_STATE_OK }, "/api/events": { status: 200, body: { events: [], lastId: 0 } } },
    undefined,
    true,
  );
  assert.match(openHtml, /aria-label="config"/, "the exact #145 ConfigDrawer component renders once configOpen is true");
  assert.doesNotMatch(openHtml, /Config ▸/);
});

// #894 AC2 verification plan: "through the actual production data path — the dashboard server's
// served payload ... consumed by the client component that renders the stale-dist chip". This
// goes through the SAME real `/api/loop/state` fetch -> `useLoopState` -> `App` -> `ConfigDrawer`
// wiring the tests above already proved opens the real component — never a synthetic prop handed
// straight to `ConfigDrawer` (that path is `ConfigDrawer.test.tsx`'s job, proving the component's
// own render logic in isolation). Two distinguishable real-shaped `build` payloads: matching
// (chip absent) and diverging (chip present, naming both short SHAs).
test("#894 AC2: through the real server-payload -> App -> ConfigDrawer path, the stale-dist chip is absent when the served build.distSha matches repoHeadSha", async () => {
  const html = await renderSettledApp(
    {
      "/api/loop/state": {
        status: 200,
        body: { ...LOOP_STATE_OK, build: { distSha: "cccccccdist", distTime: "2026-08-17T09:00:00.000Z", repoHeadSha: "cccccccdist" } },
      },
      "/api/events": { status: 200, body: { events: [], lastId: 0 } },
    },
    undefined,
    true,
  );
  assert.match(html, /aria-label="config"/, "the real ConfigDrawer renders (configOpen=true)");
  assert.doesNotMatch(html, /config-drawer-stale-chip/, "matching dist/repo SHAs — no false staleness claim");
});

test("#894 AC2: through the real server-payload -> App -> ConfigDrawer path, the stale-dist chip renders when the served build.distSha diverges from repoHeadSha", async () => {
  const html = await renderSettledApp(
    {
      "/api/loop/state": {
        status: 200,
        body: { ...LOOP_STATE_OK, build: { distSha: "aaaaaaadist", distTime: "2026-08-17T07:00:00.000Z", repoHeadSha: "bbbbbbbhead" } },
      },
      "/api/events": { status: 200, body: { events: [], lastId: 0 } },
    },
    undefined,
    true,
  );
  assert.match(html, /aria-label="config"/, "the real ConfigDrawer renders (configOpen=true)");
  assert.match(html, /config-drawer-stale-chip/, "the server's own served payload evidences a real divergence");
  assert.match(html, /panel built at aaaaaaa, repo at bbbbbbb/);
});

// #727 gate② finding config-trigger-wiring-unexercised (round 2): the test above proves "IF
// configOpen is true THEN ConfigDrawer renders" but never touches the gear's ACTUAL onClick — it
// presets state directly. This closes that gap by driving the rail's REAL rendered gear (the
// exact element tree `railContent` returns, not a stub) through `toggleConfigOpen`, the SAME
// function App wires as `onOpenConfig`, and observing that ONE call flips `configOpen` to true —
// the identical state the test above already proved renders the SAME ConfigDrawer #145 built.
test("#727 gate②: one call to the rail's REAL gear onClick, run through App's own toggleConfigOpen, flips configOpen — the state that opens ConfigDrawer", () => {
  let configOpen = false;
  const tree = railContent(
    "system",
    () => {},
    () => {
      configOpen = toggleConfigOpen(configOpen);
    },
  );
  const gear = findByClassName(tree, "icon-rail-item icon-rail-config");
  assert.ok(gear, "config gear not found in the rail's real element tree");
  assert.equal(configOpen, false);
  (gear!.props.onClick as () => void)();
  assert.equal(configOpen, true, "one gear click must flip configOpen exactly like App's own handler does");
});

// #727 gate② finding config-app-wiring-still-unexercised (round 3): the test above STILL only
// proves a hand-built `railContent(...)` call responds to `toggleConfigOpen` — it never touches
// `App.tsx`'s own `<IconRail onOpenConfig={...}>` JSX, and stays green even if that prop were
// changed to a no-op. `appContent` (extracted from `App.tsx` the same way `railContent` was
// extracted from `IconRail.tsx`) returns the REAL tree `App` renders, with the REAL `onOpenConfig`
// closure attached — this walks THAT tree, finds the REAL `<IconRail>` element inside it, and
// calls its actual prop directly.
test("#727 gate②: appContent's REAL <IconRail onOpenConfig> — App's own production wiring, not a reconstruction — calls setConfigOpen(toggleConfigOpen)", () => {
  const setCalls: unknown[] = [];
  const setConfigOpen = (updater: unknown) => setCalls.push(updater);
  const tree = appContent(minimalAppViewModel({ configOpen: false, setConfigOpen }));

  const rail = findByType(tree, IconRail);
  assert.ok(rail, "IconRail not found in App's real rendered tree");
  const onOpenConfig = rail!.props.onOpenConfig as () => void;
  assert.equal(setCalls.length, 0);
  onOpenConfig();
  assert.equal(setCalls.length, 1, "one call to App's REAL onOpenConfig must call setConfigOpen exactly once");
  assert.equal(
    setCalls[0],
    toggleConfigOpen,
    "App's real handler must pass the exact toggleConfigOpen reference — not a copy, not a no-op",
  );
});

// #727 gate② finding anchor-targets-not-tested: the previous IconRail-only test proved the two
// hrefs exist and nothing else does, but never checked the OTHER end — a target id renamed or
// deleted elsewhere in App would leave a dead `#overview`/`#cost` link with that test still green.
test("#727 gate②: every rail hash anchor resolves to exactly one matching target id in the rendered page", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  for (const id of ["overview", "cost"]) {
    assert.match(html, new RegExp(`href="#${id}"`), `rail must link to #${id}`);
    const targets = html.match(new RegExp(`id="${id}"`, "g")) ?? [];
    assert.equal(targets.length, 1, `expected exactly one id="${id}" target, found ${targets.length}`);
  }
});

// #766 gate② finding [0] (rounds-api-ui-unexercised): the endpoint (server.test.ts) and the
// navigator's rendering (RoundNavigator.test.tsx, hand-fed a Round[]) were only ever tested as
// disconnected halves — nothing proved `fetchRounds`/`roundsQuery`'s response actually reaches
// App's real `<Header>`/`<RoundNavigator>`. This drives the REAL `App` component through the REAL
// query layer, stubbing `/api/rounds` with distinguishable multi-round data — including an
// artifact-less row — and asserts the rendered list shows both, tally and tally-less alike.
//
// #889: the round list now renders only once the navigator pill is clicked open (never inline by
// default), so this needs a real DOM click (`mountSettledApp`, same posture as the phase-inspector
// click tests below) rather than a bare `renderToStaticMarkup` string match.
test("#766 gate② finding [0]: /api/rounds data flows through fetchRounds/roundsQuery into App's real round navigator, including an artifact-less row rendering tally-less", async () => {
  const { container, unmount } = await mountSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
    "/api/rounds": {
      status: 200,
      body: {
        rounds: [
          {
            roundId: 5,
            status: "done",
            startedAt: "2026-08-10T10:00:00Z",
            endedAt: "2026-08-10T10:30:00Z",
            startEventId: 100,
            startSpendId: 50,
            eventCount: 42,
            schemaVersion: 1,
            artifact: { prsMerged: 3, spendUsd: 4.5 },
          },
          {
            // Artifact-less: closed without a persisted artifact (pre-#123 history, or a crash
            // between closeRound and saveRoundArtifact) — §8's "render tally-less, never skip".
            roundId: 6,
            status: "done",
            startedAt: "2026-08-10T11:00:00Z",
            endedAt: "2026-08-10T11:30:00Z",
            startEventId: 200,
            startSpendId: 80,
            eventCount: 10,
            schemaVersion: null,
            artifact: null,
          },
        ],
      },
    },
  });
  try {
    assert.equal(container.querySelector(".round-list"), null, "the round list must not render inline by default");
    const pill = container.querySelector(".round-nav-pill");
    assert.ok(pill, "the header's round navigator pill must render");
    await act(async () => {
      pill.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const list = container.querySelector(".round-list");
    assert.ok(list, "clicking the navigator pill must open the round list");
    const html = list.innerHTML;
    assert.match(html, /round 5/, "round 5's navigator row must render from the real /api/rounds response");
    assert.match(html, /round 6/, "round 6's navigator row must render too");
    assert.match(html, /3 merged/, "round 5's real artifact tally must render");
    assert.match(html, /no summary yet/, "round 6's artifact-less row must render tally-less, not skipped or fabricated");
  } finally {
    await unmount();
  }
});

// ── #766 gate② finding [1] (header-replay-total-is-round-scoped): resolveRoundSpend ────────────
//
// Round 1's fix (finding [0], previous head) mislabeled the SELECTED round's own cursor-truncated
// spend as "run" spend — wrong scope, since a multi-round run's true total needs every earlier
// round too, which this app has no honest way to reconstruct (confirmed: even LIVE mode's own
// `spend.runUsd` is unconditionally `null` server-side — `dashboard/server.ts` has no run-anchor
// machinery at all). `resolveRoundSpend` is the honest replacement: a real number, correctly
// scoped and labeled as "round" (Header.tsx's new third tier), against the round's OWN persisted
// `roundBudgetUsd` — never today's live config, and never claiming a scope this app can't measure.

test("resolveRoundSpend: reads usedUsd straight from the caller's cursor-truncated sum", () => {
  const artifact = { roundBudgetUsd: 100 };
  assert.deepEqual(resolveRoundSpend(12.5, artifact), { usedUsd: 12.5, budgetUsd: 100 });
});

test("resolveRoundSpend: reads budgetUsd from the round's OWN artifact — never today's live config", () => {
  // Deliberately distinguishable: if this read the live config's budget instead of the round's
  // own historical `roundBudgetUsd`, a config change since the round closed would show the WRONG
  // ceiling. $250 here is the round's real historical budget; nothing about "today's config" is
  // ever consulted.
  const artifact = { roundBudgetUsd: 250, prsMerged: 3 };
  const result = resolveRoundSpend(200, artifact);
  assert.equal(result.budgetUsd, 250);
});

test("resolveRoundSpend: an artifact-less round (null artifact) reports an honest null budget, never a guessed one", () => {
  assert.deepEqual(resolveRoundSpend(5, null), { usedUsd: 5, budgetUsd: null });
});

test("resolveRoundSpend: an artifact missing roundBudgetUsd (malformed/unexpected shape) also falls back to null, never throws", () => {
  assert.deepEqual(resolveRoundSpend(5, { someOtherField: 1 }), { usedUsd: 5, budgetUsd: null });
  assert.deepEqual(resolveRoundSpend(5, "not an object"), { usedUsd: 5, budgetUsd: null });
});

test("resolveRoundSpend: usedUsd is 0 (never a stale figure) while the round's log is still loading — spendThroughCursor is empty until then", () => {
  assert.deepEqual(resolveRoundSpend(0, { roundBudgetUsd: 100 }), { usedUsd: 0, budgetUsd: 100 });
});

// ── appContent integration: Header receives the round-scoped reading, and it WINS over live spend ──

test("#766 gate② finding [1]: appContent's REAL <Header round> prop is the round-scoped reading, distinguishable from the live spend also passed through", () => {
  const distinguishableRoundSpend = { usedUsd: 12.5, budgetUsd: 250 };
  const vm = minimalAppViewModel({
    mode: "replay",
    loop: { data: { ...LOOP_STATE_OK, spend: { runUsd: 999, runBudgetUsd: 500, todayUsd: 999, dailyBudgetUsd: 500 } }, isPending: false },
    roundSpend: distinguishableRoundSpend,
  });
  const tree = appContent(vm);

  const header = findByType(tree, Header);
  assert.ok(header, "Header not found in appContent's real tree");
  assert.deepEqual(header!.props.round, distinguishableRoundSpend, "Header must receive vm.roundSpend");
  // `spend` is still passed through (Header.tsx's own `round`-wins-over-`spend` contract handles
  // the precedence) — this pins that the OVERRIDE, not a mutation of `spend` itself, is the fix.
  assert.deepEqual((header!.props.spend as { runUsd: number }).runUsd, 999);
});

test("resolveSpendMeter's run/daily reading is what LIVE mode alone uses: appContent passes round=undefined in live mode, so Header falls through to spend", () => {
  const vm = minimalAppViewModel({
    mode: "live",
    loop: { data: { ...LOOP_STATE_OK, spend: { runUsd: 42, runBudgetUsd: 100, todayUsd: 42, dailyBudgetUsd: 100 } }, isPending: false },
  });
  const tree = appContent(vm);
  const header = findByType(tree, Header);
  assert.equal(header!.props.round, undefined, "live mode must never populate the round override");
});

// ── #766 gate② finding [2] (replay-loading-leaks-live-fold): resolveActiveFold ─────────────────

function domainEvent(id: number, kind: string): DomainEvent {
  return { known: false, id, ts: "2026-08-10T10:00:00Z", kind, payload: {} };
}

// ── #891 gate① engine-agent finding [2] (ac2-shared-fold-wiring-unpinned): appContent's own
// wiring, not two independently-satisfied unit tests ───────────────────────────────────────────

test("#891 AC2: appContent threads the SAME activeOpenAttention array into BOTH <Hero> and <NeedsAttention>, and activeHero.roundEscalated into NeedsAttention's reconciliation prop", () => {
  const distinguishableOpenAttention = [domainEvent(42, "drive-needs-human")];
  const distinguishableHero = { ...initialHeroState(1), roundEscalated: 7 };
  const vm = minimalAppViewModel({
    loop: { data: LOOP_STATE_OK, isPending: false },
    activeOpenAttention: distinguishableOpenAttention,
    activeHero: distinguishableHero,
  });
  const tree = appContent(vm);

  const hero = findByType(tree, Hero);
  assert.ok(hero, "<Hero> not found in appContent's real tree");
  assert.equal(
    hero!.props.openAttention,
    distinguishableOpenAttention,
    "Hero must receive the SAME activeOpenAttention array reference appContent threads elsewhere — proving one shared source, not a separately-satisfied prop",
  );

  const needsAttention = findByType(tree, NeedsAttention);
  assert.ok(needsAttention, "<NeedsAttention> not found in appContent's real tree");
  assert.equal(
    needsAttention!.props.items,
    distinguishableOpenAttention,
    "NeedsAttention must receive the SAME activeOpenAttention array reference as Hero — the #891 AC2 shared-fold contract, provable only by rendering appContent itself",
  );
  assert.equal(
    needsAttention!.props.roundEscalated,
    7,
    "NeedsAttention must receive activeHero.roundEscalated (the reconciliation-sentence input) through appContent's own wiring",
  );
});

// #920 AC1 (WIRING): dimming is a LIVE-open-round-only concept — a present engine state and an
// open ceiling reason dimming an as-of-cursor PAST round is exactly the §11 mode-purity
// contradiction this issue fixes. This test proves it through the REAL appContent/App tree (never
// a hand-built HeroStage fixture), with the SAME dimming-eligible fixture (engine "stopped" AND
// openCeilingReasons non-empty) rendered three ways.
test('#920 AC1: the real App/DemoApp tree renders svg.hero[data-dimmed="false"] in replay and ?demo, even with engine stopped + an open ceiling reason — the same fixture live with an open round dims', async () => {
  const openCeilingEvents: LoopEvent[] = [
    { id: 1, ts: "2026-01-01T00:00:00Z", kind: "ceiling-breach-entered", payload: { reason: "dailyBudgetUsd" } },
  ];
  const stoppedEngine = {
    state: "stopped" as const,
    reasons: [],
    lastTickAt: null,
    pauseActive: false,
    estopActive: false,
    standbyNextCheckSec: null,
  };
  // #920 gate② finding [0]: the REAL fold chain (`foldReplay`, the same function
  // `resolveActiveFold`/`useDemoReplay`'s own `scrubTo`/`endPosition` call under the hood), not a
  // hand-built HeroState — so the ceiling reason genuinely reaches `openCeilingReasons` the way a
  // real closed round's replay position would produce it.
  const replayState = foldReplay(initialReplayState(1), openCeilingEvents.map(toDomainEvent)).state;
  assert.ok(replayState.hero.openCeilingReasons.size > 0, "fixture sanity: openCeilingReasons must actually be non-empty");

  // #920 gate② finding [0] (ac1-replay-fixtures-bypass-real-fold): `mode: "replay"` with no round
  // in `rounds`/`selectedRoundId` is a combination real `useReplay`/`useDemoReplay` can never
  // produce (both derive `mode` FROM `selectedRoundId !== null`) — the SAME self-consistency
  // #733 engine-agent finding [2] already established for `rounds`/`selectedRoundId` above,
  // extended here to `replayPosition` too, so this fixture names a genuinely closed, loaded round.
  const closedRound = {
    roundId: 42,
    status: "done" as const,
    startedAt: "2026-01-01T00:00:00Z",
    endedAt: "2026-01-01T00:10:00Z",
    startEventId: 0,
    startSpendId: 0,
    eventCount: openCeilingEvents.length,
    schemaVersion: 1,
    artifact: null,
  };
  const replayData = { ...LOOP_STATE_OK, engine: stoppedEngine, round: null };
  const replayVm = minimalAppViewModel({
    mode: "replay",
    loop: { data: replayData, isPending: false },
    activeHero: replayState.hero,
    rounds: [closedRound],
    selectedRoundId: closedRound.roundId,
    replayPosition: { state: replayState, cursorId: openCeilingEvents[0]!.id, cursorIndex: openCeilingEvents.length },
  });
  const replayHtml = renderToStaticMarkup(appContent(replayVm));
  assert.match(
    replayHtml,
    /<svg class="hero"[^>]*data-dimmed="false"/,
    "replay must never dim, even with engine stopped + an open ceiling reason",
  );

  // ?demo: the SAME fixture, through the real DemoApp entry point end-to-end (fetch mock + real
  // QueryClient prefetch, same posture `renderSettledDemoApp` elsewhere in this file uses).
  // #920 gate② finding [0]: `rounds: []` left `useDemoReplay`'s `selectedRoundId` (and therefore
  // `mode`) at "live" forever — `resolveActiveFold` then returned the neutral `emptyLive` state,
  // so the ceiling-breach event was NEVER actually folded and this assertion held vacuously. A
  // real round (matching `openCeilingEvents` via `startEventId`/`eventCount`, same cursor
  // discipline `demo/build-round-log.ts` documents) makes `useDemoReplay` select it and land on
  // `mode: "replay"` from the very first render, so the fixture's ceiling event genuinely reaches
  // the real fold this assertion is supposed to be proving something about.
  const demoBundle: DemoBundle = {
    loopState: {
      engine: stoppedEngine,
      lanes: { max: 1, items: [] },
      round: null,
      spend: { todayUsd: 0, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
      rings: 0,
      mergedPrs: [],
      logPath: null,
      config: {},
      controlsEnabled: false,
      build: { distSha: null, distTime: null, repoHeadSha: null },
    },
    rounds: [closedRound],
    events: openCeilingEvents,
    spend: [],
  };
  mock.method(globalThis, "fetch", async (url: string) => {
    const path = url.split("?")[0]!;
    if (path === "/demo-fixture.json") {
      return new Response(JSON.stringify(demoBundle), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`?demo must never call ${url} — it is not a static asset`);
  });
  const demoClient = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await demoClient.prefetchQuery(demoFixtureQuery());
  const demoHtml = renderToStaticMarkup(
    <QueryClientProvider client={demoClient}>
      <App demo />
    </QueryClientProvider>,
  );
  assert.match(
    demoHtml,
    /<svg class="hero"[^>]*data-dimmed="false"/,
    "?demo must never dim, even with engine stopped + an open ceiling reason",
  );
  // Sanity: the fixture's own round must actually be SELECTED (proof `useDemoReplay` reached
  // `mode: "replay"`, not stuck at "live" folding nothing) — the same distinguishable-round-id
  // check the #742 wiring tests already use elsewhere in this file, here proving this test isn't
  // vacuously true the way the original (`rounds: []`) fixture was.
  assert.match(
    demoHtml,
    new RegExp(`round ${closedRound.roundId}`),
    "the fixture's own round must reach Transport's real chapter-mark row",
  );

  // The SAME hero state + engine, but LIVE with a genuinely open round: dims exactly as before.
  const liveData = { ...LOOP_STATE_OK, engine: stoppedEngine, round: { id: 1, phase: "executing" } };
  const liveVm = minimalAppViewModel({ mode: "live", loop: { data: liveData, isPending: false }, activeHero: replayState.hero });
  const liveHtml = renderToStaticMarkup(appContent(liveVm));
  assert.match(liveHtml, /<svg class="hero"[^>]*data-dimmed="true"/, "the SAME fixture, live with an open round, must dim");
});

test("resolveActiveFold: live mode returns the live fold's own fields, untouched", () => {
  const live = {
    hero: initialHeroState(3),
    steps: [],
    events: [domainEvent(1, "merged")],
    titles: { 1: { issueTitle: "live issue" } },
    openAttention: [domainEvent(2, "drive-needs-human")],
  };
  const result = resolveActiveFold("live", null, live, initialReplayState(3));
  assert.equal(result, live);
});

test("resolveActiveFold: replay mode with a loaded position returns THAT position's state, never the live fold", () => {
  const live = {
    hero: initialHeroState(3),
    steps: [],
    events: [domainEvent(999, "merged")], // distinguishable "live" event id
    titles: { 999: { issueTitle: "LIVE — must not leak" } },
    openAttention: [],
  };
  const replayState = { ...initialReplayState(3), events: [domainEvent(1, "dispatched")], titles: { 1: { issueTitle: "replayed issue" } } };
  const result = resolveActiveFold("replay", { state: replayState, cursorId: 1, cursorIndex: 1 }, live, initialReplayState(3));
  assert.deepEqual(result.events, replayState.events);
  assert.deepEqual(result.titles, replayState.titles);
  assert.notDeepEqual(result.events, live.events, "the live event must never leak into a loaded replay position");
});

test("resolveActiveFold: replay mode with NO position yet (round still loading) returns the neutral empty replay state — never falls through to live's distinguishable values", () => {
  const live = {
    hero: initialHeroState(3),
    steps: [],
    events: [domainEvent(999, "merged")],
    titles: { 999: { issueTitle: "LIVE — must not leak during load" } },
    openAttention: [domainEvent(998, "drive-needs-human")],
  };
  const emptyReplay = initialReplayState(3);
  const result = resolveActiveFold("replay", null, live, emptyReplay);
  assert.deepEqual(result.events, emptyReplay.events);
  assert.deepEqual(result.titles, emptyReplay.titles);
  assert.deepEqual(result.openAttention, []);
  assert.notDeepEqual(result.events, live.events, "the loading window must never show the live fold's events");
  assert.notDeepEqual(result.titles, live.titles, "the loading window must never show the live fold's titles");
});

// ── #766 gate② finding [2] (live-only-test-does-not-cover-app-wiring) ──────────────────────────
//
// The previous round's `LiveOnly.test.tsx` coverage only proved the COMPONENT greys out synthetic
// children — it never rendered a REAL snapshot-backed panel (`LaneBoard`, `ConfigDrawer`) through
// `App`/`appContent`, so it would have stayed green even if App.tsx's actual `<LiveOnly>` wrapper
// around those two panels were ever removed or wired with a hardcoded `mode="live"`. These render
// the REAL `appContent` tree with distinguishable live lane/config values present in the view
// model, and assert those exact values are ABSENT from the replay-mode markup while the greyed
// `live only` panel IS present — proof of the actual App-level wiring, not just the component.

const DISTINGUISHABLE_LANE_ISSUE = 424242;
const DISTINGUISHABLE_WORKER = "w-distinguishable-live-only";
const DISTINGUISHABLE_CONFIG_OWNER = "distinguishable-live-only-owner";

function loopDataWithDistinguishableLiveSnapshot() {
  return {
    ...LOOP_STATE_OK,
    lanes: {
      max: 1,
      items: [
        {
          lane: DISTINGUISHABLE_WORKER,
          issue: DISTINGUISHABLE_LANE_ISSUE,
          state: "running",
          pr: null,
          startedAt: "2026-08-10T10:00:00Z",
          endedAt: null,
          costUsd: null,
          estCostUsd: null,
          contextTokens: null,
          tokenComposition: null,
        },
      ],
    },
    config: { board: { owner: DISTINGUISHABLE_CONFIG_OWNER, repo: "sapwood" } },
  };
}

test("#766 gate② finding [2]: LaneBoard's REAL App-wired distinguishable live lane never renders while replaying — the live-only panel replaces it", () => {
  const vm = minimalAppViewModel({ mode: "replay", loop: { data: loopDataWithDistinguishableLiveSnapshot(), isPending: false } });
  const html = renderToStaticMarkup(appContent(vm));

  assert.doesNotMatch(
    html,
    new RegExp(String(DISTINGUISHABLE_LANE_ISSUE)),
    "the live lane's distinguishable issue number must never render in replay",
  );
  assert.doesNotMatch(html, new RegExp(DISTINGUISHABLE_WORKER), "the live lane's distinguishable worker id must never render in replay");
  assert.match(html, /live only/, "the LaneBoard slot must show the greyed live-only panel instead");

  // Sanity: the SAME view model in LIVE mode DOES render the distinguishable lane — proves the
  // fixture itself is real (a broken fixture that never renders anything would pass the assertions
  // above for the wrong reason).
  const liveHtml = renderToStaticMarkup(appContent({ ...vm, mode: "live" } as unknown as Parameters<typeof appContent>[0]));
  assert.match(
    liveHtml,
    new RegExp(String(DISTINGUISHABLE_LANE_ISSUE)),
    "live mode must actually render the lane — proves this is a real regression guard",
  );
});

test("#766 gate② finding [2]: ConfigDrawer's REAL App-wired distinguishable live config never renders while replaying — the live-only panel replaces it", () => {
  const vm = minimalAppViewModel({
    mode: "replay",
    configOpen: true,
    loop: { data: loopDataWithDistinguishableLiveSnapshot(), isPending: false },
  });
  const html = renderToStaticMarkup(appContent(vm));

  assert.doesNotMatch(
    html,
    new RegExp(DISTINGUISHABLE_CONFIG_OWNER),
    "the live config's distinguishable owner value must never render in replay",
  );
  assert.match(html, /live only/, "the ConfigDrawer slot must show the greyed live-only panel instead");

  const liveHtml = renderToStaticMarkup(appContent({ ...vm, mode: "live" } as unknown as Parameters<typeof appContent>[0]));
  assert.match(
    liveHtml,
    new RegExp(DISTINGUISHABLE_CONFIG_OWNER),
    "live mode must actually render the config value — proves this is a real regression guard",
  );
});

// Markup-signature proof, complementing the distinguishable-value tests above: LaneBoard's own
// `aria-label="lanes"` and ConfigDrawer's own `aria-label="config"` — each component's own
// rendered signature, not just its data — are absent from the RENDERED replay markup too. (A
// `findByType` walk of the pre-render JSX tree would find these elements regardless of mode,
// since `<LiveOnly>`'s `children` prop is constructed by JSX before `LiveOnly` ever decides
// whether to use it — `renderToStaticMarkup` is what actually reflects `LiveOnly`'s runtime
// branching, same reasoning `LiveOnly.test.tsx` itself relies on.)
test("#766 gate② finding [2]: neither LaneBoard's nor ConfigDrawer's own rendered signature (aria-label) appears anywhere in the replay markup", () => {
  const vm = minimalAppViewModel({
    mode: "replay",
    configOpen: true,
    loop: { data: loopDataWithDistinguishableLiveSnapshot(), isPending: false },
  });
  const html = renderToStaticMarkup(appContent(vm));
  assert.doesNotMatch(html, /aria-label="lanes"/, "LaneBoard's own aria-label must not render while replaying");
  assert.doesNotMatch(html, /aria-label="config"/, "ConfigDrawer's own aria-label must not render while replaying");
});

// ── #895 item 1: the hero's staleness caption rebases against the replay cursor, never the live
// wall clock — WIRING sub-case: `hero.test.ts` proves `HeroStage`'s own `now` prop drives the
// caption in isolation, this proves App's REAL tree threads the replay cursor's own timestamp
// into it while replaying, rather than always falling back to `appContent`'s own `clock`.

test("#895 item 1: while replaying, the hero's staleness caption reads the replay cursor's own 'as of' timestamp, not appContent's live wall clock", () => {
  const activeHero: HeroState = { ...initialHeroState(null), lastEventTs: "2019-12-31T23:59:50Z" };
  const vm = minimalAppViewModel({
    mode: "replay",
    loop: { data: LOOP_STATE_OK, isPending: false },
    activeHero,
    asOf: "2019-12-31T23:59:55Z",
  });
  const html = renderToStaticMarkup(appContent(vm));
  assert.match(
    html,
    /last event 5s ago/,
    "staleness must rebase against the replay cursor's own 'as of' timestamp, not appContent's own wall-clock `clock` (2026-01-01, years later)",
  );
  assert.doesNotMatch(html, /last event \d+d ago/, "the live wall clock must never leak into a replayed staleness reading");
});

// ── #925 AC4: NeedsAttention's own age reads the SAME replay cursor #895 item 1 established for
// the hero staleness caption — WIRING sub-case: NeedsAttention.test.tsx proves the component's
// own `now` prop drives its row ages in isolation, this proves App's REAL tree threads the
// replay cursor's own timestamp into it while replaying, rather than falling back to
// appContent's own `clock`. ──────────────────────────────────────────────────────────────────

test("#925 AC4: while replaying/demo, NeedsAttention's row age reads the replay cursor's own 'as of' timestamp, not appContent's live wall clock", () => {
  // The fold's only item is trivially the greatest-age one, so it renders the emphasis box's
  // COMPACT form ("10m", no " ago" — NeedsAttention.tsx's own `formatCompactAge` branch).
  const item = { ...domainEvent(1, "drive-needs-human"), ts: "2026-08-10T11:50:00.000Z" };
  const vm = minimalAppViewModel({
    mode: "replay",
    activeOpenAttention: [item],
    asOf: "2026-08-10T12:00:00.000Z",
  });
  const html = renderToStaticMarkup(appContent(vm));
  assert.match(
    html,
    /class="data attention-age attention-age-emphasis"[^>]*>10m</,
    "the row's age must rebase against the replay cursor's own 'as of' timestamp (10 minutes before asOf), not appContent's own wall-clock `clock` (2026-01-01, months before this replayed event)",
  );
  // `clock` (2026-01-01) sits BEFORE this replayed event's own ts (2026-08-10) — falling back to
  // it would produce a NEGATIVE delta, clamped to zero, so a `now: clock` regression here reads
  // "0s" instead of "10m"; this assertion reddens on exactly that regression.
  assert.doesNotMatch(
    html,
    /class="data attention-age attention-age-emphasis"[^>]*>0s</,
    "the live wall clock must never leak into a replayed row's age",
  );
});

// ── #803: App's REAL wiring of `/api/loop/state`'s `mergedPrs` into the hero tally ────────────
//
// hero.test.ts proves `HeroStage` itself honors `mergedPrs` in isolation — this proves App.tsx
// actually THREADS the server's field there (WIRING sub-case of the test-realism doctrine family):
// a real fold (`foldEvents`, not a hand-built droplet) produces a checkpoint droplet whose PR the
// fold's own reducer never resolves (state.ts only handles the plain `merged` kind), and
// `appContent`'s real tree is rendered end to end through `loop.data.mergedPrs`.
function heroWithCheckpointDroplet(pr: number): HeroState {
  const events: DomainEvent[] = [
    { known: false, id: 1, ts: "2026-08-13T10:00:00Z", kind: "dispatched", payload: { worker: "w-803", issue: 803 } },
    {
      known: false,
      id: 2,
      ts: "2026-08-13T10:05:00Z",
      kind: "reclaim-done",
      payload: { worker: "w-803", issue: 803, next: "DRIVING", pr },
    },
  ];
  return foldEvents(initialHeroState(3), events).state;
}

test("#803: App's real tree excludes a droplet from the pending tally when its PR is in loop.data.mergedPrs", () => {
  const pr = 90391;
  const vm = minimalAppViewModel({
    mode: "live",
    loop: { data: { ...LOOP_STATE_OK, mergedPrs: [pr] }, isPending: false },
    activeHero: heroWithCheckpointDroplet(pr),
  });
  const html = renderToStaticMarkup(appContent(vm));
  assert.match(html, /0 merged · 0 pending · 0 needs human/, "the real App tree must exclude the merged-witnessed PR from the tally");
});

test("#803: the SAME droplet renders under the #745 windowed qualifier when loop.data.mergedPrs does not name its PR", () => {
  const pr = 90392;
  const vm = minimalAppViewModel({
    mode: "live",
    loop: { data: { ...LOOP_STATE_OK, mergedPrs: [] }, isPending: false },
    activeHero: heroWithCheckpointDroplet(pr),
  });
  const html = renderToStaticMarkup(appContent(vm));
  assert.match(
    html,
    /0 merged · 0 pending \(1 unverified\) · 0 needs human/,
    "with no persisted merged witness, the droplet falls back to the #745 honest qualifier, proving this isn't a hardcoded suppression",
  );
});

// ── #766/#880 (replay-spend-panel-unexercised, carried into the rebuilt composition) ───────────
//
// `cost-panel.test.ts` proves `buildClosedRoundCostPanel` as a pure transform, and
// `CostStrip.test.tsx` proves the component renders whatever `CostPanelData` it's handed — but
// nothing before this test passed a real round's spend/phase-window log THROUGH that real
// function and then through App's own `<CostStrip today={costToday} round={costRound} />` wiring,
// checking the rendered ROUND panel actually shows the trailing `Unattributed` bucket. This calls
// `buildClosedRoundCostPanel` the EXACT way `App()` does — over a realistic mixed spend set (one
// attributed row inside a real `round-phase` window, one pre-#206 row before any window) — then
// renders it through `appContent`'s real `costRound` slot.

test("#766/#880: real timestamp-truncated, phase-bucketed spend renders through App's ROUND N panel, unattributed bucket included, executing labeled per the fixed §7 stage order", () => {
  const attributedRow: SpendRow = {
    id: 1,
    ts: "2026-08-10T10:15:00Z",
    worker: "w1",
    issue: 42,
    usd: 12.5,
    model: "opus",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    actorKind: "worker",
    role: null,
    estimated: false,
  };
  const preHistoryRow: SpendRow = { ...attributedRow, id: 2, ts: "2026-08-01T00:00:00Z", usd: 3.25 }; // before any round-phase window
  const phaseWindows = [{ phase: "executing", startTs: "2026-08-10T10:00:00Z", endTs: null }];
  const round: Round = {
    roundId: 9,
    status: "done",
    startedAt: "2026-08-10T10:00:00Z",
    endedAt: "2026-08-10T11:00:00Z",
    startEventId: 0,
    startSpendId: 0,
    eventCount: 0,
    schemaVersion: 1,
    artifact: { spendUsd: 15.75, roundBudgetUsd: 30, prsMerged: 2 },
  };
  // The SAME function App() itself calls (cost-panel.ts) — not a hand-authored panel.
  const costRound = buildClosedRoundCostPanel(round, [attributedRow, preHistoryRow], phaseWindows);

  const vm = minimalAppViewModel({ mode: "replay" });
  const html = renderToStaticMarkup(appContent({ ...vm, costRound }));

  assert.match(html, /Lanes/, "the real attributed phase bucket (executing) must render under its §7 label");
  assert.match(html, /\$12\.50/, "the attributed row's real sum must render");
  assert.match(html, /Unattributed/, "the pre-#206 row must land in the labeled unattributed bucket");
  assert.match(html, /\$3\.25/, "the unattributed bucket's real sum must render");
  assert.match(html, /cost · round 9/, "the round panel's heading names the round id");
  assert.match(html, /closed/i, "the round panel carries the CLOSED badge");
});

// #880: `useLastClosedRoundCost`'s own async fetch (`loadClosedRoundCostLog`, via `loadRoundLog`)
// only runs inside a `useEffect` — `renderToStaticMarkup` never fires those, so the test above
// (which proves `buildClosedRoundCostPanel` renders correctly once given data) can't prove LIVE
// mode's own real wiring ever REACHES that function. This mounts the real app (`mountSettledApp`'s
// pattern) with one closed round + its own round-scoped events/spend, flushes the effect, and
// checks the ROUND N panel populates from that fetch — not a hand-injected `costRound` prop.
test("#880: LIVE mode's ROUND N panel is populated by the real useLastClosedRoundCost fetch for the last-closed round, not a hand-injected panel", async () => {
  const CLOSED_ROUND_ID = 88005;
  const rounds = [
    {
      roundId: CLOSED_ROUND_ID,
      status: "done",
      startedAt: "2026-08-10T09:00:00Z",
      endedAt: "2026-08-10T09:30:00Z",
      startEventId: 0,
      startSpendId: 0,
      eventCount: 1,
      schemaVersion: 1,
      artifact: { spendUsd: 9.5, roundBudgetUsd: 30, prsMerged: 1 },
    },
  ];
  const events = [{ id: 1, ts: "2026-08-10T09:05:00Z", kind: "round-phase", payload: { round_id: CLOSED_ROUND_ID, phase: "executing" } }];
  const spend = [
    {
      id: 1,
      ts: "2026-08-10T09:06:00Z",
      worker: "w1",
      issue: 10,
      usd: 9.5,
      model: "opus",
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      actorKind: "worker",
      role: null,
      estimated: false,
    },
  ];
  mock.method(globalThis, "fetch", async (url: string) => {
    const parsed = new URL(url, "http://localhost");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/api/loop/state") return json({ ...LOOP_STATE_OK, round: null });
    if (parsed.pathname === "/api/rounds") return json({ rounds });
    if (parsed.pathname === "/api/events") {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 200);
      const page = events.filter((e) => e.id > after).slice(0, limit);
      return json({ events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after });
    }
    if (parsed.pathname === "/api/spend") {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 200);
      const page = spend.filter((r) => r.id > after).slice(0, limit);
      return json({ spend: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await Promise.allSettled([
    client.prefetchQuery(loopStateQuery()),
    client.prefetchQuery(eventsQuery(0)),
    client.prefetchQuery(spendQuery(0)),
    client.prefetchQuery(roundsQuery()),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  });
  try {
    // `useLastClosedRoundCost`'s fetch is itself async — flush its effect+promise chain.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const html = container.innerHTML;
    assert.match(html, new RegExp(`cost · round ${CLOSED_ROUND_ID}`), "the last-closed round's own id names the panel");
    assert.match(html, /closed/i);
    assert.match(html, /Lanes/, "the round's real spend buckets into the executing/Lanes stage row");
    assert.match(html, /\$9\.50/);
    assert.match(
      html,
      /total \$9\.50 · 1 PR merged · \$9\.50\/PR · review \$0\.00/,
      "footer stats read straight from the round's artifact",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ── #742 (split 3/4 of #146): `?demo` static fixture bundle ────────────────────────────────────
//
// A fixture double (not the real committed `demo/source.ts` recording) — small, self-contained,
// and carrying a distinguishable round id no other test uses, so these tests stay stable
// regardless of future edits to the shipped recording's own content.

const DEMO_ROUND_ID = 987654;
const DEMO_ISSUE_TITLE = "Distinguishable demo fixture issue — round 987654";

function demoBundleFixture(): DemoBundle {
  return {
    loopState: {
      engine: { state: "stopped", reasons: [], lastTickAt: null, pauseActive: false, estopActive: false, standbyNextCheckSec: null },
      lanes: { max: 1, items: [] },
      round: null,
      spend: { todayUsd: 0, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
      rings: 1,
      mergedPrs: [],
      logPath: null,
      config: {},
      controlsEnabled: false,
      build: { distSha: null, distTime: null, repoHeadSha: null },
    },
    rounds: [
      {
        roundId: DEMO_ROUND_ID,
        status: "done",
        startedAt: "2026-08-09T09:00:00Z",
        endedAt: "2026-08-09T09:10:00Z",
        // #793 gate② finding [1]: EXCLUSIVE cursors (`e.id > startEventId`) — 0, not the first
        // included row's own id (1), or that row would be wrongly excluded from its own round.
        startEventId: 0,
        startSpendId: 0,
        eventCount: 2,
        schemaVersion: 1,
        artifact: { prsMerged: 1, spendUsd: 1 },
      },
    ],
    events: [
      { id: 1, ts: "2026-08-09T09:00:05Z", kind: "dispatched", payload: { worker: "lane-a", issue: 1, issueTitle: DEMO_ISSUE_TITLE } },
      { id: 2, ts: "2026-08-09T09:05:00Z", kind: "merged", payload: { issue: 1, pr: 1, worker: "lane-a" } },
    ],
    spend: [
      {
        id: 1,
        ts: "2026-08-09T09:05:00Z",
        worker: "lane-a",
        issue: 1,
        usd: 1,
        model: "claude-sonnet-5",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        actorKind: "worker",
        role: null,
        estimated: false,
      },
    ],
  };
}

async function renderSettledDemoApp(bundle: DemoBundle): Promise<string> {
  mock.method(globalThis, "fetch", async (url: string) => {
    const path = url.split("?")[0]!;
    if (path === "/demo-fixture.json") {
      return new Response(JSON.stringify(bundle), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`?demo must never call ${url} — it is not a static asset`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await client.prefetchQuery(demoFixtureQuery());
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <App demo />
    </QueryClientProvider>,
  );
}

test("#742: ?demo makes zero network calls to /api/loop/state or /api/events — fully static", async () => {
  const calledUrls: string[] = [];
  mock.method(globalThis, "fetch", async (url: string) => {
    calledUrls.push(url);
    if (url.split("?")[0] === "/demo-fixture.json") {
      return new Response(JSON.stringify(demoBundleFixture()), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await client.prefetchQuery(demoFixtureQuery());
  renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <App demo />
    </QueryClientProvider>,
  );
  assert.ok(
    calledUrls.every((u) => !u.startsWith("/api/loop/state") && !u.startsWith("/api/events")),
    `?demo must never call /api/loop/state or /api/events; called: ${calledUrls.join(", ")}`,
  );
});

test("#742: ?demo's fixture data actually drives the transport player — a fixture-unique round id and issue title render", async () => {
  const html = await renderSettledDemoApp(demoBundleFixture());
  assert.match(
    html,
    new RegExp(`round ${DEMO_ROUND_ID}`),
    "the fixture's distinguishable round id must reach Transport's real chapter-mark row",
  );
  assert.match(
    html,
    new RegExp(DEMO_ISSUE_TITLE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    "the fixture's distinguishable issue title must be folded and rendered — proof the fixture's events actually reached the shared reducer, not just its rounds list",
  );
});

test("#880: ?demo's real DemoApp wiring populates BOTH the today panel (whole-bundle spend) and the round panel (the fixture's own artifact-backed footer)", async () => {
  const html = await renderSettledDemoApp(demoBundleFixture());
  assert.match(html, /cost · today/, "the today panel always renders, even in demo/replay mode");
  assert.match(html, new RegExp(`cost · round ${DEMO_ROUND_ID}`), "the round panel names the fixture's own round id");
  assert.match(html, /closed/i, "a demo round is by definition closed — the round panel carries the CLOSED badge");
  // The fixture's one spend row carries no round-phase window, so it buckets as Unattributed —
  // proof the real bucketing pipeline ran, not a hand-authored placeholder.
  assert.match(html, /Unattributed/);
  assert.match(html, /total \$1\.00 · 1 PR merged · \$1\.00\/PR · review \$0\.00/, "footer stats read from the fixture's own artifact");
});

// #895: no test drove the config gear through a real replay/demo App entry point — the #727
// tests above invoke `onOpenConfig` directly or preset `configOpen`, and the #766 LiveOnly tests
// preset `configOpen: true` on a hand-built `minimalAppViewModel`; neither actually CLICKS the
// real rendered gear inside a real, settled, replayable stateful tree and observes the result.
// `?demo` is always replay once its fixture loads (`DemoApp`'s own doc), so this is the real
// production path the AC names: a real DOM mount (`registerRealDom()`, `createRoot`/`act`, same
// posture as `mountSettledApp` above) of the actual `<App demo>` entry point, clicking the actual
// rendered gear button, and reading the actual resulting markup.
test("#895: through the real ?demo/replay production entry point, clicking the real config gear renders the live-only badge in place of ConfigDrawer's content", async () => {
  mock.method(globalThis, "fetch", async (url: string) => {
    const path = url.split("?")[0]!;
    if (path === "/demo-fixture.json") {
      return new Response(JSON.stringify(demoBundleFixture()), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`?demo must never call ${url} — it is not a static asset`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await client.prefetchQuery(demoFixtureQuery());
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <App demo />
        </QueryClientProvider>,
      );
    });
    // `?demo` is always replay, so LaneBoard's own unconditional `<LiveOnly>` already renders
    // one "live only" badge before the gear is ever touched — a bare presence check can't tell
    // that apart from ConfigDrawer's. Counting occurrences isolates the one new badge the click
    // adds (`configOpen`'s own `<LiveOnly>` wrapper renders nothing at all while `configOpen` is
    // false, so this is the drawer's own instance, not a coincidence).
    const badgeCount = () => (container.innerHTML.match(/class="panel live-only"/g) ?? []).length;
    const before = badgeCount();
    assert.equal(before, 1, "LaneBoard's own live-only badge is expected before any click — the drawer's own instance isn't rendered yet");

    const gear = container.querySelector<HTMLButtonElement>('[aria-label="open config"]');
    assert.ok(gear, "the real config gear must render in the real ?demo tree");
    await act(async () => {
      gear.click();
    });

    assert.equal(
      badgeCount(),
      before + 1,
      "clicking the real gear through the real ?demo/replay tree must add exactly one new live-only badge — ConfigDrawer's own",
    );
    assert.doesNotMatch(
      container.innerHTML,
      /aria-label="config"/,
      "ConfigDrawer's own rendered signature must never appear behind the badge — it must silently no-op no longer",
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ── #861 phase inspector ─────────────────────────────────────────────────────────────────────
//
// Content-correctness assertions (AC2–AC6) go through `appContent` — this repo's own WIRING
// doctrine names it directly as a real production entry point (`review/REVIEW-DOCTRINE.md`'s
// "App/appContent" example), the same treatment `#803`/`#766` use above for hero/cost-strip
// content. Click MECHANICS (AC1, AC7) go through a real mounted DOM (`mountSettledApp`,
// `registerRealDom()` above) — `renderToStaticMarkup` strips event handlers, so only a real DOM
// can prove a click/keydown actually reaches the production `onClick`/`onKeyDown` wiring.

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Extracts just the `<aside aria-label="phase inspector">…</aside>` fragment — content
 *  assertions must be scoped to it, never the whole page: the hero SVG renders the SAME
 *  model·effort/review-mode captions next to its own stage nodes regardless of drawer state, so
 *  an unscoped "does this string appear anywhere" check would be a false positive/negative. */
function extractDrawerHtml(html: string): string {
  // #892: PhaseInspectorDrawer is a native <dialog> now (was <aside>) — see its own file comment.
  const match = html.match(/<dialog[^>]*aria-label="phase inspector"[^>]*>[\s\S]*?<\/dialog>/);
  assert.ok(match, "phase inspector drawer not found in rendered html");
  return match[0];
}

/** A `<dt>label</dt><dd>value</dd>` row, adjacent with no gap (the real JSX these components
 *  render) — the label's own row, not a later one that happens to start with the same text. */
function assertRow(html: string, label: string, value: string | number): void {
  const re = new RegExp(`${escapeRegExp(label)}[^<]*</dt><dd[^>]*>${escapeRegExp(String(value))}</dd>`);
  assert.match(html, re, `expected row "${label}: ${value}"`);
}

const INSPECTOR_CONFIG = {
  board: { owner: "acme-inspector", repo: "widgets-inspector" },
  worker: { model: "worker-model-861", effort: "high" },
  roles: {
    po: { model: "po-model-861", effort: "medium" },
    architect: { model: "arch-model-861", effort: "medium" },
    verificationPlanReviewer: { model: "verify-model-861", effort: "low" },
    harvest: { model: "harvest-model-861", effort: "low" },
    retro: { model: "retro-model-861", effort: "low" },
  },
  reviewer: { mode: "engine-agent-861" },
};

const INSPECTOR_REPO_URL = "https://github.com/acme-inspector/widgets-inspector";

// Distinguishable, mutually-unequal, none 0/1 (verification plan's own fixture-quality bar):
// dispatches 3, merges 2, handoffs 5, spendUsd 37.25.
const INSPECTOR_ARTIFACT = {
  schemaVersion: 1,
  roundId: 4242,
  startedAt: "2026-08-10T09:00:00Z",
  endedAt: "2026-08-10T10:00:00Z",
  dispatches: [
    { issue: 701, worker: "w1" },
    { issue: 702, worker: "w2" },
    { issue: 703, worker: "w1" },
  ],
  merges: [
    { issue: 701, worker: "w1", pr: 9001 },
    { issue: 702, worker: "w2", pr: 9002 },
  ],
  prsOpened: 5,
  prsMerged: 2,
  issuesClosed: 2,
  spendUsd: 37.25,
  roundBudgetUsd: 80,
  retries: { gatedReentries: 4, gatedReentryCapped: 2, rollbacksRecovered: 3, rollbacksEscalated: 6 },
  reviewRounds: { reviewerFallbackSwitches: 0, reviewerFallbackReverts: 0 },
  escalations: { needsHuman: [811, 812, 813], ceiling: 9, driveNoPr: 8 },
  egressSuspects: [],
  handoffs: 5,
  degradedPhases: [
    { phase: "architect", outcome: "escalated", session: "sess-arch-861" },
    { phase: "plan_review", outcome: "escalated", session: "sess-verify-861" },
    // Harvest's own degraded session — must never leak into the Arch review / Verify drawer.
    { phase: "harvest", outcome: "escalated", session: "sess-harvest-861" },
  ],
  roundStops: [],
  retro: { opened: { pr: 9099, branch: "retro/branch-861" }, degraded: null },
  align: {
    created: [{ issue: 601, title: "Distinguishable created title 861", hasPlan: true }],
    triaged: [{ issue: 602, drafted: false }],
  },
  concerns: [],
  concernsReconciled: [],
};

function inspectorEvent(id: number, kind: string, payload: Record<string, unknown>): DomainEvent {
  return { known: true, id, ts: `2026-08-10T09:0${id}:00Z`, kind, payload } as DomainEvent;
}

// 3 plan-review-escalated + 2 verify-na-proposed — distinguishable counts for the Arch
// review / Verify drawer's event-derived numbers (AC2). #893: was "no-plan-after-draft", a
// dashboard-only kind the engine never actually registers (dead drift closed by this PR) —
// swapped for another real, distinct engine-registered kind so the fixture stays honest.
const INSPECTOR_EVENTS: DomainEvent[] = [
  inspectorEvent(1, "plan-review-escalated", { issue: 901 }),
  inspectorEvent(2, "plan-review-escalated", { issue: 902 }),
  inspectorEvent(3, "plan-review-escalated", { issue: 903 }),
  inspectorEvent(4, "verify-na-proposed", { issue: 904 }),
  inspectorEvent(5, "verify-na-proposed", { issue: 905 }),
];

function inspectorViewModel(overrides: {
  inspectorNode: string;
  inspectorArtifact?: unknown;
  activeEvents?: DomainEvent[];
  mode?: "live" | "replay";
  logPath?: string | null;
}) {
  return minimalAppViewModel({
    inspectorNode: overrides.inspectorNode,
    inspectorArtifact: "inspectorArtifact" in overrides ? overrides.inspectorArtifact : INSPECTOR_ARTIFACT,
    activeEvents: overrides.activeEvents ?? INSPECTOR_EVENTS,
    repoUrl: INSPECTOR_REPO_URL,
    mode: overrides.mode ?? "live",
    loop: { data: { ...LOOP_STATE_OK, config: INSPECTOR_CONFIG, logPath: overrides.logPath ?? null }, isPending: false },
  });
}

// ── resolveInspectorArtifact (§6 mode-purity binding) ───────────────────────────────────────

test("resolveInspectorArtifact: live mode reads the round matching the live open round's id", () => {
  const rounds = [
    { roundId: 1, artifact: { a: 1 } },
    { roundId: 2, artifact: { a: 2 } },
  ] as unknown as Round[];
  assert.deepEqual(resolveInspectorArtifact("live", rounds, 2, null), { a: 2 });
});

test("resolveInspectorArtifact: replay mode reads the round matching the SELECTED round id, ignoring the live open round entirely", () => {
  const rounds = [
    { roundId: 1, artifact: { a: 1 } },
    { roundId: 2, artifact: { a: 2 } },
  ] as unknown as Round[];
  assert.deepEqual(resolveInspectorArtifact("replay", rounds, 2, 1), { a: 1 });
});

test("resolveInspectorArtifact: no matching round row (open round not yet in /api/rounds, or nothing selected) is an honest null, never a throw", () => {
  assert.equal(resolveInspectorArtifact("live", [], 5, null), null);
  assert.equal(resolveInspectorArtifact("replay", [], null, null), null);
});

// ── #868 gate② finding [1] (live-event-counts-cross-round): round-scoped event counts ──────────
//
// AC2's Arch review / Verify counts must bind to the INSPECTED round, not `useEventHistory`'s
// process-wide, window-bounded display tail — a prior round's matching events must not inflate
// the count (contamination), and a round longer than that display window must not lose any of
// its own events (truncation). `resolveInspectorRound` + `loadInspectorRoundEvents` are the two
// halves LiveApp wires together; both failure directions get their own test below.

test("resolveInspectorRound: finds the round matching the live open round's id, same lookup resolveInspectorArtifact uses", () => {
  const rounds = [
    { roundId: 1, startEventId: 0, eventCount: 3 },
    { roundId: 2, startEventId: 3, eventCount: 1 },
  ] as unknown as Round[];
  assert.equal(resolveInspectorRound(rounds, 2)?.roundId, 2);
});

test("resolveInspectorRound: no matching round row (open round not yet in /api/rounds, or none live) is an honest null, never a throw", () => {
  assert.equal(resolveInspectorRound([], 5), null);
  assert.equal(resolveInspectorRound([{ roundId: 1 } as unknown as Round], null), null);
});

function roundLogRow(id: number, kind: string): { id: number; ts: string; kind: string; payload: Record<string, unknown> | null } {
  return { id, ts: `2026-08-10T09:${String(id).padStart(2, "0")}:00Z`, kind, payload: {} };
}

function inspectorRound(overrides: Partial<Round> = {}): Round {
  return {
    roundId: 2,
    status: "in_progress",
    startedAt: "2026-08-10T09:03:00Z",
    endedAt: null,
    startEventId: 3,
    startSpendId: 0,
    eventCount: 1,
    schemaVersion: null,
    artifact: null,
    ...overrides,
  };
}

test("#868 gate② finding [1] direction 1 (contamination): loadInspectorRoundEvents excludes events at/before the round's own startEventId", async () => {
  const ledger = [
    roundLogRow(1, "plan-review-escalated"), // the PRIOR round's own event — must not count for round 2
    roundLogRow(2, "plan-review-escalated"), // the PRIOR round's own event — must not count for round 2
    roundLogRow(3, "plan-review-escalated"), // the round-1/round-2 boundary row itself — excluded (exclusive cursor)
    roundLogRow(4, "plan-review-escalated"), // round 2's OWN event — must count
  ];
  const round = inspectorRound({ startEventId: 3, eventCount: 1 });
  const fetchPage = async (after: number, limit: number) => {
    const page = ledger.filter((e) => e.id > after).slice(0, limit);
    return { events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after };
  };
  const events = await loadInspectorRoundEvents(round, fetchPage);
  assert.deepEqual(
    events.map((e) => e.id),
    [4],
    "only the event strictly AFTER the round's own startEventId belongs to it — the prior round's matching events must not appear at all",
  );
});

test("#868 gate② finding [1] direction 2 (truncation): loadInspectorRoundEvents collects every one of a round's events, even past useEventHistory's own display-window cap", async () => {
  const total = MAX_EVENT_HISTORY + 5; // deliberately more than the live display window ever retains
  const ledger = Array.from({ length: total }, (_, i) => roundLogRow(i + 1, "plan-review-escalated"));
  const round = inspectorRound({ startEventId: 0, eventCount: total });
  let calls = 0;
  const fetchPage = async (after: number, limit: number) => {
    calls++;
    const page = ledger.filter((e) => e.id > after).slice(0, limit);
    return { events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after };
  };
  const events = await loadInspectorRoundEvents(round, fetchPage);
  assert.equal(events.length, total, "a round longer than useEventHistory's display-window cap must not lose any of its own events");
  assert.ok(calls > 1, "the fixture only proves the property if collecting the round actually took more than one page");
});

// The real-App wiring-level regression: the reviewer's own words for why the prior fixture missed
// this — "the real-App wiring fixture starts at event zero and contains no prior-round matching
// events, so it cannot detect this." This one does: two real rounds, a prior CLOSED one with its
// own matching events, and the CURRENT open one — mounted through the real `<App>` tree with a
// fetch mock that (unlike this file's other `stubFetch`) actually respects `/api/events`'s
// `after`/`limit` query params, the same way the real server does.
test("#868 gate② finding [1]: the real live wiring excludes a PRIOR round's matching events from the currently open round's Verify drawer count", async () => {
  const PRIOR_ROUND_ID = 70020;
  const OPEN_ROUND_ID = 70021;
  const ledger = [
    roundLogRow(1, "plan-review-escalated"), // prior round's own event
    roundLogRow(2, "plan-review-escalated"), // prior round's own event
    roundLogRow(3, "verify-na-proposed"), // prior round's own last event (the boundary row)
    roundLogRow(4, "plan-review-escalated"), // the OPEN round's own event
  ];
  const rounds = [
    {
      roundId: PRIOR_ROUND_ID,
      status: "done",
      startedAt: "2026-08-10T09:00:00Z",
      endedAt: "2026-08-10T09:03:00Z",
      startEventId: 0,
      startSpendId: 0,
      eventCount: 3,
      schemaVersion: null,
      artifact: null,
    },
    {
      roundId: OPEN_ROUND_ID,
      status: "in_progress",
      startedAt: "2026-08-10T09:03:00Z",
      endedAt: null,
      startEventId: 3,
      startSpendId: 0,
      eventCount: 1,
      schemaVersion: null,
      artifact: null,
    },
  ];
  mock.method(globalThis, "fetch", async (url: string) => {
    const parsed = new URL(url, "http://localhost");
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (parsed.pathname === "/api/loop/state") {
      return json({ ...LOOP_STATE_OK, config: INSPECTOR_CONFIG, round: { id: OPEN_ROUND_ID, phase: "executing" } });
    }
    if (parsed.pathname === "/api/rounds") return json({ rounds });
    if (parsed.pathname === "/api/spend") return json({ spend: [], lastId: 0 });
    if (parsed.pathname === "/api/events") {
      const after = Number(parsed.searchParams.get("after") ?? 0);
      const limit = Number(parsed.searchParams.get("limit") ?? 200);
      const page = ledger.filter((e) => e.id > after).slice(0, limit);
      return json({ events: page, lastId: page.length > 0 ? page[page.length - 1]!.id : after });
    }
    throw new Error(`unstubbed fetch: ${url}`);
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await Promise.allSettled([
    client.prefetchQuery(loopStateQuery()),
    client.prefetchQuery(eventsQuery(0)),
    client.prefetchQuery(spendQuery(0)),
    client.prefetchQuery(roundsQuery()),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  });
  try {
    const verifyNode = container.querySelector('[aria-label="inspect Verify"]');
    assert.ok(verifyNode, "the verify stage node must render");
    await act(async () => {
      verifyNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    // The round-scoped fetch this finding's fix adds is itself async — flush its effect+promise
    // chain before reading the rendered count.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const drawer = container.querySelector('dialog[aria-label="phase inspector"]');
    assert.ok(drawer);
    assertRow(
      drawer!.innerHTML,
      "plan-review escalations",
      1,
      // Contaminated (the shared `activeEvents` tail, no round filter) would read 3 — both of the
      // PRIOR round's matching events plus the open round's own one.
    );
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
});

// ── AC2 / AC3 / AC4: drawer content per node class ──────────────────────────────────────────

// gate② finding [0] (ac2-app-wiring): every AC2 content test below injects `inspectorArtifact`/
// `activeEvents` directly into `appContent` — that proves the DRAWER renders whatever it's given
// correctly, but stays green even if `LiveApp` bound the drawer to the wrong artifact or event
// fold entirely. This test instead mounts the REAL `<App>` (`mountSettledApp`) with a
// distinguishable `/api/rounds` artifact and `/api/events` response and opens nodes through real
// clicks — proving the query-to-drawer wiring itself, not just the drawer's own rendering.
test("gate② finding [0]: the real /api/rounds artifact and /api/events response flow through the live query hooks into the drawer — not just a hand-injected prop", async () => {
  const WIRING_ROUND_ID = 70019;
  const { container, unmount } = await mountSettledApp({
    "/api/loop/state": {
      status: 200,
      body: { ...LOOP_STATE_OK, config: INSPECTOR_CONFIG, round: { id: WIRING_ROUND_ID, phase: "executing" } },
    },
    "/api/rounds": {
      status: 200,
      body: {
        rounds: [
          {
            roundId: WIRING_ROUND_ID,
            status: "in_progress",
            startedAt: "2026-08-10T09:00:00Z",
            endedAt: null,
            startEventId: 0,
            startSpendId: 0,
            eventCount: INSPECTOR_EVENTS.length,
            schemaVersion: 1,
            artifact: INSPECTOR_ARTIFACT,
          },
        ],
      },
    },
    "/api/events": {
      status: 200,
      body: {
        events: INSPECTOR_EVENTS.map((e) => ({ id: e.id, ts: e.ts, kind: e.kind, payload: e.payload })),
        lastId: INSPECTOR_EVENTS.length,
      },
    },
  });
  try {
    const goalAlignNode = container.querySelector('[aria-label="inspect Goal & align"]');
    assert.ok(goalAlignNode, "the goal-align stage node must render");
    await act(async () => {
      goalAlignNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    let drawer = container.querySelector('dialog[aria-label="phase inspector"]');
    assert.ok(drawer);
    assert.match(
      drawer.textContent ?? "",
      /Distinguishable created title 861/,
      "the REAL /api/rounds artifact for the currently open round must flow into the drawer",
    );

    const verifyNode = container.querySelector('[aria-label="inspect Verify"]');
    assert.ok(verifyNode, "the verify stage node must render");
    await act(async () => {
      verifyNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    drawer = container.querySelector('dialog[aria-label="phase inspector"]');
    assert.ok(drawer);
    assert.match(
      drawer.textContent ?? "",
      /sess-verify-861/,
      "the REAL /api/rounds artifact's degradedPhases must flow into the Arch review / Verify drawer",
    );
    assertRow(drawer.innerHTML, "plan-review escalations", 3);

    const laneNode = container.querySelector('[aria-label^="inspect w"]');
    assert.ok(laneNode, "a lane stage node must render");
    await act(async () => {
      laneNode.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    drawer = container.querySelector('dialog[aria-label="phase inspector"]');
    assert.ok(drawer);
    assertRow(drawer.innerHTML, "dispatches", 3);
    assertRow(drawer.innerHTML, "merges", 2);
  } finally {
    await unmount();
  }
});

// gate② finding [0] (second half): the Retro drawer's OWN AC2 content test (below) exercises
// only the opened-PR outcome — degraded and neither are the other two outcomes §6's own table
// names explicitly. Both are covered here, through the same real `appContent` entry point.
test("AC2: Retro drawer — a degraded proposal renders its reason/branch, distinct from the opened-PR outcome", () => {
  const artifact = {
    ...INSPECTOR_ARTIFACT,
    retro: { opened: null, degraded: { branch: "retro/degraded-861", title: "t", reason: "no findings this round 861" } },
  };
  const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: "retro", inspectorArtifact: artifact })));
  const drawer = extractDrawerHtml(html);
  assert.match(drawer, /retro\/degraded-861/);
  assert.match(drawer, /no findings this round 861/);
  assert.doesNotMatch(drawer, /href="/, "a degraded proposal never opened a PR, so no GitHub link renders");
});

test("AC2: Retro drawer — neither outcome (no proposal this round) renders honestly, distinct from both opened and degraded", () => {
  const artifact = { ...INSPECTOR_ARTIFACT, retro: { opened: null, degraded: null } };
  const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: "retro", inspectorArtifact: artifact })));
  const drawer = extractDrawerHtml(html);
  assert.match(drawer, /no proposal this round/);
  assert.doesNotMatch(drawer, /href="/, "no proposal means no GitHub link renders");
});

test("AC2/AC3/AC4: Goal & align drawer — the artifact's align section verbatim, GitHub links to issues only, po's model·effort caption, no other phase's fields", () => {
  const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: "goal-align" })));
  const drawer = extractDrawerHtml(html);
  assert.match(drawer, /Goal &amp; align/);
  assert.match(drawer, new RegExp(escapeRegExp("po-model-861 · medium")));
  assert.match(drawer, /Distinguishable created title 861/);
  assert.match(drawer, new RegExp(`href="${escapeRegExp(INSPECTOR_REPO_URL)}/issues/601"`));
  assert.match(drawer, new RegExp(`href="${escapeRegExp(INSPECTOR_REPO_URL)}/issues/602"`));
  assert.match(drawer, /still planless/);
  assert.doesNotMatch(drawer, /37\.25/, "Summary's spend must not leak into Goal & align");
  assert.doesNotMatch(drawer, /gated reentries/, "Lanes counters must not leak into Goal & align");
  assert.doesNotMatch(drawer, /retro\/branch-861/, "Retro's fields must not leak into Goal & align");
});

for (const node of ["arch-review", "verify"] as const) {
  test(`AC2/AC3: Arch review / Verify drawer (opened via ${node}) — degradedPhases limited to architect/plan_review, event-derived escalation counts, ${node}'s own caption`, () => {
    const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: node })));
    const drawer = extractDrawerHtml(html);
    assert.match(drawer, /Arch review \/ Verify/);
    assert.match(drawer, /sess-arch-861/);
    assert.match(drawer, /sess-verify-861/);
    assert.doesNotMatch(drawer, /sess-harvest-861/, "harvest's own degraded session belongs to Summary, not here");
    assertRow(drawer, "plan-review escalations", 3);
    assertRow(drawer, "verify n/a proposed", 2);
    const expectedCaption = node === "arch-review" ? "arch-model-861 · medium" : "verify-model-861 · low";
    assert.match(drawer, new RegExp(escapeRegExp(expectedCaption)));
    assert.doesNotMatch(drawer, /Distinguishable created title 861/, "Goal & align's own fields must not leak here");
  });
}

const LANES_NODE_CAPTION: Record<string, string | null> = {
  lane: "worker-model-861 · high",
  ci: null,
  review: "engine-agent-861",
  merge: null,
};
for (const [node, caption] of Object.entries(LANES_NODE_CAPTION)) {
  test(`AC2/AC3: Lanes / CI / Review / merge drawer (opened via ${node}) — the artifact's counters, ${caption ? "its own caption" : "no caption"}`, () => {
    const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: node })));
    const drawer = extractDrawerHtml(html);
    assert.match(drawer, /Lanes \/ CI \/ Review \/ merge/);
    assertRow(drawer, "dispatches", 3);
    assertRow(drawer, "merges", 2);
    assertRow(drawer, "handoffs", 5);
    assertRow(drawer, "gated reentries", 4);
    assertRow(drawer, "gated reentries capped", 2);
    assertRow(drawer, "rollbacks recovered", 3);
    assertRow(drawer, "rollbacks escalated", 6);
    assertRow(drawer, "needs-human escalations", 3);
    assertRow(drawer, "ceiling escalations", 9);
    assertRow(drawer, "drive-no-pr", 8);
    if (caption) {
      assert.match(drawer, new RegExp(escapeRegExp(caption)));
    } else {
      assert.doesNotMatch(drawer, /worker-model-861/, "CI/merge carry no caption at all (AC3)");
      assert.doesNotMatch(drawer, /engine-agent-861/, "CI/merge carry no caption at all (AC3)");
    }
    assert.doesNotMatch(drawer, /Distinguishable created title 861/, "other phases' fields must not leak here");
  });
}

test("AC2/AC3/AC4: Summary drawer — the artifact's own top-line numbers, harvest's model·effort caption, no other phase's fields", () => {
  const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: "summary" })));
  const drawer = extractDrawerHtml(html);
  assert.match(drawer, /Summary/);
  assert.match(drawer, /\$37\.25 of \$80\.00/);
  assertRow(drawer, "PRs opened", 5);
  assertRow(drawer, "PRs merged", 2);
  assertRow(drawer, "issues closed", 2);
  assert.match(drawer, new RegExp(escapeRegExp("harvest-model-861 · low")));
  assert.doesNotMatch(drawer, /gated reentries/, "Lanes counters must not leak into Summary");
  assert.doesNotMatch(drawer, /Distinguishable created title 861/, "Goal & align's own fields must not leak into Summary");
});

test("AC2/AC3/AC4: Retro drawer — the artifact's retro outcome object, a PR link with no comment anchor, retro's model·effort caption", () => {
  const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: "retro" })));
  const drawer = extractDrawerHtml(html);
  assert.match(drawer, /Retro/);
  assert.match(drawer, new RegExp(`href="${escapeRegExp(INSPECTOR_REPO_URL)}/pull/9099"`));
  assert.match(drawer, /retro\/branch-861/);
  assert.match(drawer, new RegExp(escapeRegExp("retro-model-861 · low")));
  assert.doesNotMatch(drawer, /37\.25/, "Summary's own fields must not leak into Retro");
});

test("AC4: every GitHub link inside the drawer matches the issue/PR URL form exactly — never a comment anchor", () => {
  for (const node of ["goal-align", "retro"] as const) {
    const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: node })));
    const drawer = extractDrawerHtml(html);
    const hrefs = [...drawer.matchAll(/href="([^"]+)"/g)].map((m) => m[1] as string);
    assert.ok(hrefs.length > 0, `expected at least one GitHub link in the ${node} drawer`);
    for (const href of hrefs) {
      assert.match(href, new RegExp(`^${escapeRegExp(INSPECTOR_REPO_URL)}/(issues|pull)/\\d+$`), `unexpected link shape: ${href}`);
    }
  }
});

// ── AC5: view log — text only, live-only ────────────────────────────────────────────────────

test("AC5: the view-log row renders logPath as plain text in live view, and is absent entirely for a replayed (closed) round", () => {
  const liveHtml = renderToStaticMarkup(
    appContent(inspectorViewModel({ inspectorNode: "summary", mode: "live", logPath: "/var/log/sapwood/run-861-unique.log" })),
  );
  assert.match(extractDrawerHtml(liveHtml), /run-861-unique\.log/);

  const replayHtml = renderToStaticMarkup(
    appContent(inspectorViewModel({ inspectorNode: "summary", mode: "replay", logPath: "/var/log/sapwood/run-861-unique.log" })),
  );
  assert.doesNotMatch(extractDrawerHtml(replayHtml), /run-861-unique\.log/, "a replayed/closed round must never show the live log path");
});

// ── AC6: honest-unknown, never synthesized ──────────────────────────────────────────────────

test("AC6: a null artifact renders every phase's rows as an explicit not-recorded state, never a throw", () => {
  for (const node of ["goal-align", "arch-review", "lane", "summary", "retro"] as const) {
    const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: node, inspectorArtifact: null, activeEvents: [] })));
    const drawer = extractDrawerHtml(html);
    assert.match(drawer, /not recorded/, `${node} drawer must show an honest not-recorded state`);
  }
});

test("AC6: an artifact missing the fields a node reads (empty object) degrades to not-recorded, never a throw, never a fabricated 0", () => {
  const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: "lane", inspectorArtifact: {} })));
  const drawer = extractDrawerHtml(html);
  assertRow(drawer, "dispatches", "not recorded");
  assertRow(drawer, "merges", "not recorded");
  assertRow(drawer, "handoffs", "not recorded");
  assertRow(drawer, "gated reentries", "not recorded");
  assertRow(drawer, "needs-human escalations", "not recorded");
});

test("AC6: an artifact whose field is the wrong type degrades to not-recorded, never a throw", () => {
  const malformed = { dispatches: "nope", merges: 5, retries: "nope", escalations: null, handoffs: "nope" };
  const html = renderToStaticMarkup(appContent(inspectorViewModel({ inspectorNode: "lane", inspectorArtifact: malformed })));
  const drawer = extractDrawerHtml(html);
  assertRow(drawer, "dispatches", "not recorded");
  assertRow(drawer, "merges", "not recorded");
  assertRow(drawer, "handoffs", "not recorded");
  assertRow(drawer, "gated reentries", "not recorded");
});

// ── AC1: real-DOM click mechanics ────────────────────────────────────────────────────────────

test("AC1: every §6 phase-inspector stage node renders as a keyboard-reachable, accessibly-named button", async () => {
  const { container, unmount } = await mountSettledApp({
    "/api/loop/state": { status: 200, body: { ...LOOP_STATE_OK, round: { id: 1, phase: "aligning" }, lanes: { max: 1, items: [] } } },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  try {
    for (const label of [
      "inspect Goal & align",
      "inspect Arch review",
      "inspect Verify",
      "inspect w1",
      "inspect CI",
      "inspect Review",
      "inspect merge",
      "inspect Summary",
      "inspect Retro",
    ]) {
      const el = container.querySelector(`[aria-label="${label}"]`);
      assert.ok(el, `expected a clickable node labeled "${label}"`);
      assert.equal(el.getAttribute("role"), "button");
      assert.equal(el.getAttribute("tabindex"), "0");
    }
  } finally {
    await unmount();
  }
});

// #892: was "...the close control and Escape both close it..." — the drawer is a native
// `<dialog>` now, and Escape closing it is a real browser (UA) behavior happy-dom's own
// `HTMLDialogElement` doesn't implement (see `HTMLDialogElement.ts`: `showModal`/`close` just
// toggle the `open` attribute and fire `close`, with no keydown wiring at all) — asserted instead
// at the ONE carrier that can actually prove it, `shots/shots.spec.ts` (Playwright), per this
// issue's verification plan. The close CONTROL (a plain button click) stays provable here.
test("AC1: clicking a hero stage node opens its phase inspector drawer; the close control closes it; the node is keyboard-operable; no unexpected fetch happens", async () => {
  const { container, fetchCalls, unmount } = await mountSettledApp({
    "/api/loop/state": {
      status: 200,
      body: { ...LOOP_STATE_OK, controlsEnabled: true, round: { id: 1, phase: "aligning" }, config: INSPECTOR_CONFIG },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  try {
    const node = container.querySelector('[aria-label="inspect Goal & align"]');
    assert.ok(node, "the goal-align stage node must render with its accessible name");

    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.ok(container.querySelector('dialog[aria-label="phase inspector"]'), "clicking the node must open the drawer");
    assert.match(container.querySelector('dialog[aria-label="phase inspector"]')?.textContent ?? "", /Goal & align/);

    const closeButton = container.querySelector('[aria-label="close phase inspector"]');
    assert.ok(closeButton, "the drawer must render a close control");
    await act(async () => {
      closeButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    assert.equal(container.querySelector('dialog[aria-label="phase inspector"]'), null, "the close control must close the drawer");

    // Keyboard: Enter on the focused node opens it too — proves keyboard operability, not just click.
    await act(async () => {
      node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });
    assert.ok(container.querySelector('dialog[aria-label="phase inspector"]'), "Enter on the node must open the drawer too");

    assert.ok(
      fetchCalls.every(
        (u) => u.startsWith("/api/loop/state") || u.startsWith("/api/events") || u.startsWith("/api/spend") || u.startsWith("/api/rounds"),
      ),
      `opening/closing the drawer must never trigger an unexpected (log content) fetch; saw: ${fetchCalls.join(", ")}`,
    );
  } finally {
    await unmount();
  }
});

// gate② finding [1] (ac5-fetch-proof-vacuous): the test above uses LOOP_STATE_OK, whose logPath
// is null — its fetch-call assertion never actually exercises the condition under which an
// implementation might wrongly fetch log content. This one supplies a genuine, unique, non-null
// logPath through the real /api/loop/state response, opens the drawer through the real mounted
// DOM, and asserts BOTH that the path renders as plain text AND that no fetch call ever names it.
test("AC5: a real non-null logPath renders as plain text once the drawer opens, and is never itself fetched", async () => {
  const LOG_PATH = "/var/log/sapwood/run-861-gate2-unique.log";
  const { container, fetchCalls, unmount } = await mountSettledApp({
    "/api/loop/state": {
      status: 200,
      body: { ...LOOP_STATE_OK, round: { id: 1, phase: "aligning" }, config: INSPECTOR_CONFIG, logPath: LOG_PATH },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  try {
    const node = container.querySelector('[aria-label="inspect Summary"]');
    assert.ok(node, "the summary stage node must render");
    await act(async () => {
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const drawer = container.querySelector('dialog[aria-label="phase inspector"]');
    assert.ok(drawer, "clicking the node must open the drawer");
    assert.match(drawer.textContent ?? "", /run-861-gate2-unique\.log/, "the real, query-sourced logPath must render as plain text");

    assert.ok(
      fetchCalls.every((u) => !u.includes(LOG_PATH)),
      `the log path itself must never be fetched — saw: ${fetchCalls.join(", ")}`,
    );
    assert.ok(
      fetchCalls.every(
        (u) => u.startsWith("/api/loop/state") || u.startsWith("/api/events") || u.startsWith("/api/spend") || u.startsWith("/api/rounds"),
      ),
      `opening the drawer must never trigger an unexpected fetch; saw: ${fetchCalls.join(", ")}`,
    );
  } finally {
    await unmount();
  }
});

// ── AC7: needs-attention strip inspect controls ─────────────────────────────────────────────

// gate② finding [3] (ac7-interactions-incomplete): the previous round of this test only ever
// COUNTED the two "inspect verify" buttons and clicked the CI one — it never clicked the
// plan-review-escalated or verify-na-proposed controls individually (proving EACH one, not just
// their count, opens the right drawer) and never clicked a mapped row's own GitHub link (proving
// link activation does NOT also open the drawer). Both are exercised below, per-row.
test("AC7: plan-review-escalated/verify-na-proposed/ci-inert-escalated rows each render an independent inspect control that opens its own drawer when clicked; clicking the row's own GitHub link never does; an unmapped kind renders no control", async () => {
  const { container, unmount } = await mountSettledApp({
    "/api/loop/state": { status: 200, body: { ...LOOP_STATE_OK, config: INSPECTOR_CONFIG } },
    "/api/events": {
      status: 200,
      body: {
        events: [
          { id: 1, ts: "2026-08-10T09:00:00Z", kind: "plan-review-escalated", payload: { issue: 8001 } },
          { id: 2, ts: "2026-08-10T09:01:00Z", kind: "verify-na-proposed", payload: { issue: 8002 } },
          {
            id: 3,
            ts: "2026-08-10T09:02:00Z",
            kind: "ci-inert-escalated",
            payload: { pr: 8003, issue: 8013, checks: [{ name: "build", conclusion: "neutral" }] },
          },
          { id: 4, ts: "2026-08-10T09:03:00Z", kind: "drive-needs-human", payload: { pr: 8005, issue: 8006 } },
        ],
        lastId: 4,
      },
    },
  });
  try {
    const planReviewLink = container.querySelector('a[href$="/issues/8001"]');
    assert.ok(planReviewLink, "the plan-review-escalated row's own GitHub link must render");
    const planReviewRow = planReviewLink.closest("li");
    assert.ok(planReviewRow);
    const planReviewButton = planReviewRow.querySelector(".attention-inspect");
    assert.ok(planReviewButton, "the plan-review-escalated row must render its own inspect control");

    const verifyNaLink = container.querySelector('a[href$="/issues/8002"]');
    assert.ok(verifyNaLink, "the verify-na-proposed row's own GitHub link must render");
    const verifyNaRow = verifyNaLink.closest("li");
    assert.ok(verifyNaRow);
    const verifyNaButton = verifyNaRow.querySelector(".attention-inspect");
    assert.ok(verifyNaButton, "the verify-na-proposed row must render its own inspect control");

    assert.notEqual(planReviewButton, verifyNaButton, "each row owns its own distinct inspect control, not a shared one");
    assert.ok(!planReviewLink.closest(".attention-inspect"), "the link must not be nested inside the inspect control");
    assert.ok(!planReviewButton.contains(planReviewLink), "the inspect control must not contain the link");

    // Clicking the row's own GitHub link must never open the drawer. `preventDefault` stops
    // happy-dom from actually following the real `target="_blank"` href during the test.
    planReviewLink.addEventListener("click", (e) => e.preventDefault());
    await act(async () => {
      planReviewLink.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    assert.equal(
      container.querySelector('dialog[aria-label="phase inspector"]'),
      null,
      "clicking the row's GitHub link must never open the drawer",
    );

    // Each row's OWN inspect control, clicked individually, opens Arch review / Verify.
    await act(async () => {
      planReviewButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    let drawer = container.querySelector('dialog[aria-label="phase inspector"]');
    assert.ok(drawer, "the plan-review-escalated row's inspect control must open a drawer");
    assert.match(drawer.textContent ?? "", /Arch review \/ Verify/, "plan-review-escalated must open the Arch review / Verify drawer");

    await act(async () => {
      verifyNaButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    drawer = container.querySelector('dialog[aria-label="phase inspector"]');
    assert.ok(drawer, "the verify-na-proposed row's inspect control must open a drawer");
    assert.match(drawer.textContent ?? "", /Arch review \/ Verify/, "verify-na-proposed must open the Arch review / Verify drawer");

    const ciButton = container.querySelector('[aria-label="inspect ci"]');
    assert.ok(ciButton, "the ci-inert-escalated row must render an inspect control");
    const ciRow = ciButton.closest("li");
    assert.ok(ciRow);
    const ciLink = ciRow.querySelector('a[href$="/pull/8003"]');
    assert.ok(ciLink, "the row's own GitHub link to the PR must still be present");
    assert.ok(!ciLink.closest(".attention-inspect"), "the link must not be nested inside the inspect control");
    assert.ok(!ciButton.contains(ciLink), "the inspect control must not contain the link");

    await act(async () => {
      ciButton.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    drawer = container.querySelector('dialog[aria-label="phase inspector"]');
    assert.ok(drawer, "clicking the inspect control must open the drawer");
    assert.match(drawer.textContent ?? "", /Lanes \/ CI \/ Review \/ merge/, "ci-inert-escalated must open the CI/lanes drawer");

    const unmappedLink = container.querySelector('a[href$="/pull/8005"]');
    assert.ok(unmappedLink, "drive-needs-human's own GitHub link must still render, unchanged");
    const unmappedRow = unmappedLink.closest("li");
    assert.ok(unmappedRow);
    assert.equal(unmappedRow.querySelector(".attention-inspect"), null, "an unmapped kind must render no inspect control at all");
  } finally {
    await unmount();
  }
});

// ── #897 AC3: the outcome ring count, proven through the real wire→fold→App wiring ──────────

test("#897 AC3: the hero's ring count reaches the rendered stage through the real /api/events -> fold -> App wiring, not a hand-built HeroStage fixture", async () => {
  const events: LoopEvent[] = [];
  // A distinguishable, non-default ring count — 5 real `merged` events, each a distinct
  // issue/PR, folded through the SAME production entry point every other real-wiring test in
  // this file uses (`renderSettledApp` -> `appContent` -> `Hero` -> `HeroStage`).
  for (let i = 1; i <= 5; i++) {
    events.push({ id: i, ts: `2026-08-14T00:0${i}:00Z`, kind: "merged", payload: { worker: `w${i}`, issue: 100 + i, pr: 200 + i } });
  }
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 200, body: { events, lastId: 5 } },
  });
  assert.match(html, /class="hero-ring-count"[^>]*>5</, "the fixture's real ring count must reach the rendered stage");
  assert.equal(html.match(/class="hero-ring"/g)?.length, 5, "one drawn ring per real merge, through the real fold");
});

// ── #897 AC5: the lane board / activity feed row uses the mockup's full-width split ─────────

test("#897 AC5: the lane board / activity feed pair renders inside its own full-row-spanning wrapper, not loose siblings sharing .stack's outer column template", () => {
  const html = renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      {appContent(minimalAppViewModel())}
    </QueryClientProvider>,
  );
  const rowMatch = html.match(/<div class="lane-activity-row">([\s\S]*?)<\/div>\s*<section id="cost" class="cost-strip"/);
  assert.ok(rowMatch, "LaneBoard/ActivityFeed must render inside a `.lane-activity-row` wrapper, immediately before the cost strip");
  assert.match(
    rowMatch![1] as string,
    /class="panel live-only"|class="lane-board-grid"/,
    "the wrapper carries the lane board (or its live-only placeholder)",
  );
  assert.match(rowMatch![1] as string, /class="panel activity-feed"/, "the wrapper carries the activity feed");
});

test("#897 AC5: .lane-activity-row carries its own auto-fit column template and spans the full .stack row", () => {
  const appCss = readFileSync(new URL("./app.css", import.meta.url), "utf8");
  // The row must span every column of `.stack`'s own outer grid — same list every other
  // full-width module (header, hero, cost strip, …) is already on.
  const spanRule = appCss.match(/\.stack\s*>\s*\.app-header,[\s\S]*?\{([\s\S]*?)\}/);
  assert.ok(spanRule, ".stack's full-width span rule must exist");
  assert.match(spanRule![0] as string, /\.stack\s*>\s*\.lane-activity-row/, ".lane-activity-row must be on the full-width span list");
  assert.match(spanRule![1] as string, /grid-column:\s*1\s*\/\s*-1/);

  // Its OWN nested grid — a column template used by nothing else, so auto-fit's empty-track
  // collapse actually applies (the App.tsx call-site comment explains why the outer `.stack`
  // grid can't give this pair a correct collapse on its own).
  // Anchored to a line START — never the `.stack > .lane-activity-row {` span-list selector
  // matched just above, which shares the same trailing text but a different, unrelated rule body.
  const ownRule = appCss.match(/\n\.lane-activity-row\s*\{([^}]*)\}/);
  assert.ok(ownRule, ".lane-activity-row must declare its own grid");
  assert.match(ownRule![1] as string, /display:\s*grid/);
  assert.match(ownRule![1] as string, /grid-template-columns:\s*repeat\(auto-fit/);
});

// ── #924: one `.panel-head` recipe + one bar grammar + the --sap-text/--sap-fill split ─────────

const tokensCss924 = readFileSync(new URL("./tokens.css", import.meta.url), "utf8");
const panelsCss924 = readFileSync(new URL("./panels.css", import.meta.url), "utf8");
const heroCss924 = readFileSync(new URL("./hero/hero.css", import.meta.url), "utf8");
// `@import` lines resolve under Vite's bundler only — happy-dom's plain <style> injection can't
// follow them (same posture hero.test.ts's own tokensCss/panelsCss/heroCss concatenation takes).
const appCss924 = readFileSync(new URL("./app.css", import.meta.url), "utf8").replace(/^@import.*$/gm, "");

/** A real, fully-populated `AppViewModel` — every module in AC1's derived set (hero,
 *  needs-attention, lanes, activity, cost×2) has real content to render its panel-head from,
 *  including a stat cluster where the design calls for one. */
function fullCoverageViewModel() {
  const heroEvents: DomainEvent[] = [
    { known: false, id: 1, ts: "2026-01-01T00:00:00Z", kind: "pool-selected", payload: { issues: [94] } },
    { known: false, id: 2, ts: "2026-01-01T00:01:00Z", kind: "dispatched", payload: { worker: "w1", issue: 95 } },
  ];
  const stageBars = [{ label: "Goal & align", usd: 0.22 }];
  const vm = minimalAppViewModel({
    loop: {
      isPending: false,
      data: {
        ...LOOP_STATE_OK,
        // #924: a nonzero settled spend is what makes the header's own spend-meter bar render
        // its `.cost-bar-fill` rect at all — that's guarded on `settledPct > 0` (no phantom
        // zero-width pill), so LOOP_STATE_OK's own `todayUsd: 0` would silently drop this module
        // out of the "full coverage" fixture.
        spend: { todayUsd: 4, dailyBudgetUsd: 10, runUsd: null, runBudgetUsd: null, byModel: [] },
        lanes: {
          max: 1,
          items: [
            {
              lane: "w1",
              issue: 95,
              state: "running",
              pr: null,
              startedAt: "2026-01-01T00:00:00Z",
              endedAt: null,
              costUsd: 2,
              estCostUsd: null,
              contextTokens: null,
              tokenComposition: null,
            },
          ],
        },
        config: { worker: { model: "opus", effort: "high", budgetUsdSoft: 10 } },
      },
    },
    activeHero: foldEvents(initialHeroState(3), heroEvents).state,
    activeOpenAttention: [domainEvent(42, "drive-needs-human")],
    activeEvents: [domainEvent(43, "dispatched")],
  });
  // `minimalAppViewModel` always sets `costToday`/`costRound` itself (never driven by its own
  // overrides param) — same override-by-spread posture the #880 wiring test above (`{ ...vm,
  // costRound }`) already takes.
  return {
    ...vm,
    costToday: {
      heading: "cost · today",
      avgRoundUsd: 4.8,
      stageBars,
      targetUsd: 5,
      // #924 gate② PO item 2's own observed boundary case: a by-model label longer than the
      // 7em floor — the exact shape that wrapped under the fixed-width column. #953: the raw id
      // itself now renders aliased ("sonnet"), so the wrap risk this fixture exercises moved to
      // the CSS invariant (overflow/ellipsis) rather than the label column's own max-content grow.
      modelBars: [{ label: "claude-sonnet-5", usd: 7.8 }],
      footer: null,
    },
    costRound: {
      heading: "cost · round 9",
      closed: true,
      stageBars,
      targetUsd: 5,
      modelBars: [{ label: "opus", usd: 4.9 }],
      footer: { totalUsd: 6.2, prsMerged: 3, usdPerPr: 6.2 / 3, reviewUsd: 0 },
    },
  };
}

/** Mounts the FULL production cascade (tokens → panels → hero → app, `app.css`'s own `@import`
 *  order) plus a real `appContent` tree into a real DOM container — AC1/AC2/AC3's own "derived
 *  from the rendered App" requirement, the STYLE doctrine family (`registerRealDom()` + a real
 *  `getComputedStyle` read, never a regex on source text for a cascade-dependent claim). #924
 *  gate② finding [0]: AC1 is explicitly scoped to "at 1440" — happy-dom's default viewport is
 *  narrower, which silently changes which rules win wherever a width-scoped `@media` rule exists
 *  (app.css's own 720px stacking floor). `window.happyDOM.setViewport` (the SAME mechanism
 *  `hero.test.ts`/`Controls.test.tsx` already use for their own width-scoped assertions) forces it
 *  BEFORE the tree mounts, not after — a media query's effect on initial layout/class application
 *  can depend on the width at mount time, not just at the moment a later assertion reads it. */
async function mountAppWithCascade(vm: Parameters<typeof appContent>[0]) {
  (window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }).happyDOM.setViewport({ width: 1440 });
  const style = document.createElement("style");
  style.textContent = `${tokensCss924}\n${panelsCss924}\n${heroCss924}\n${appCss924}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        {appContent(vm)}
      </QueryClientProvider>,
    );
  });
  const cleanup = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
    document.head.removeChild(style);
  };
  return { container, cleanup };
}

/**
 * Every `.panel-head` element the derived set requires, keyed by the head's OWN title text —
 * every module in AC1's set renders a distinct one ("loop", "needs attention", "lanes",
 * "activity", "cost · today", "cost · round 9"), including the cost strip's two panels, which
 * share an outer `aria-label="cost"` ancestor and so can't be told apart by that alone.
 * COVERAGE (doctrine): read off the rendered tree, never a hand count.
 *
 * #924 gate② finding [0]: returns `Element[]` per key, NEVER collapsing same-titled heads onto
 * one another the way an overwriting `Record<string, Element>` would — a regression that rendered
 * a head TWICE (or renamed one module's title to collide with another's) would silently vanish
 * behind "some entry exists for this key" instead of failing the exact-one-per-key check callers
 * now make explicit.
 */
function panelHeadsByModule(container: HTMLElement): Record<string, Element[]> {
  const out: Record<string, Element[]> = {};
  for (const el of container.querySelectorAll(".panel-head")) {
    const title = el.querySelector("h1, h2, h3");
    const key = title?.textContent?.trim().toLowerCase() ?? "unknown";
    if (!out[key]) out[key] = [];
    out[key]!.push(el);
  }
  return out;
}

/** Asserts `key` has EXACTLY one `.panel-head` and returns it — the single call site every AC1
 *  test below uses, so "exactly one, not merely present" is checked uniformly rather than
 *  re-derived per test. */
function theOnlyPanelHead(heads: Record<string, Element[]>, key: string): Element {
  const matches = heads[key] ?? [];
  assert.equal(matches.length, 1, `expected exactly one .panel-head for "${key}"; found ${matches.length}`);
  return matches[0]!;
}

test("AC1: every module in the derived set (hero, needs-attention, lanes, activity, cost×2) renders exactly one .panel-head", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const heads = panelHeadsByModule(container);
    for (const key of ["loop", "needs attention", "lanes", "activity", "cost · today", "cost · round 9"]) {
      theOnlyPanelHead(heads, key);
    }
  } finally {
    await cleanup();
  }
});

const DERIVED_MODULE_HEADS = ["loop", "needs attention", "lanes", "activity", "cost · today", "cost · round 9"];

// #924 gate② PO item 3: the first pass shipped a 16px title (--text-1) at a bare 1px
// letter-spacing — measured on the mockup crops at roughly 18px cap-height / ~0.1em tracking,
// far past this AC's own 0.06em floor. Asserting the EXACT corrected target (not just ">= floor")
// pins the fix in place, not just "still legal."
const TITLE_FONT_PX = 26; // --text-3 (tokens.css)
const TITLE_LETTER_SPACING_PX = 2.2; // ~0.085em at 26px

test("AC1: every panel-head title resolves Fraunces/uppercase, the mockup-scale 26px/2.2px-tracking size (not the undersized first pass), and the head's own border-bottom-width is 1px", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const heads = panelHeadsByModule(container);
    for (const key of DERIVED_MODULE_HEADS) {
      const head = theOnlyPanelHead(heads, key);
      const title = head.querySelector("h1, h2, h3");
      assert.ok(title, `"${key}"'s .panel-head must carry a title element`);
      const titleComputed = getComputedStyle(title as Element);
      assert.match(titleComputed.fontFamily, /Fraunces/, `"${key}" title font-family`);
      assert.equal(titleComputed.textTransform, "uppercase", `"${key}" title text-transform`);
      assert.equal(titleComputed.fontSize, `${TITLE_FONT_PX}px`, `"${key}" title font-size`);
      const letterSpacing = Number.parseFloat(titleComputed.letterSpacing);
      assert.equal(letterSpacing, TITLE_LETTER_SPACING_PX, `"${key}" title letter-spacing`);
      assert.ok(
        letterSpacing >= TITLE_FONT_PX * 0.06,
        `"${key}" title letter-spacing ${letterSpacing}px must clear the AC's own 0.06em floor (${TITLE_FONT_PX * 0.06}px at ${TITLE_FONT_PX}px)`,
      );
      const headComputed = getComputedStyle(head);
      assert.equal(headComputed.borderBottomWidth, "1px", `"${key}" .panel-head border-bottom-width`);
    }
  } finally {
    await cleanup();
  }
});

test("AC1: where a panel-head carries a stat cluster, it is the head's last child with margin-left: auto", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const heads = panelHeadsByModule(container);
    for (const key of ["needs attention", "lanes", "cost · today"]) {
      const head = theOnlyPanelHead(heads, key);
      const lastChild = head.lastElementChild;
      assert.ok(lastChild?.classList.contains("panel-head-stat"), `"${key}"'s .panel-head last child must carry .panel-head-stat`);
      assert.equal(getComputedStyle(lastChild as Element).marginLeft, "auto", `"${key}" stat cluster margin-left`);
    }
  } finally {
    await cleanup();
  }
});

test("AC2: .cost-bar-target stroke resolves to the real --sap-text colour, and .cost-panel-footer is right-aligned", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const tick = container.querySelector(".cost-bar-target");
    assert.ok(tick, "the by-stage group's target tick must render (costToday.targetUsd is set)");
    const expectedSapText = parseTokensLocal(tokensCss924)["--sap-text"];
    assert.equal(getComputedStyle(tick as Element).stroke, expectedSapText, ".cost-bar-target stroke must resolve to --sap-text");

    const footer = container.querySelector(".cost-panel-footer");
    assert.ok(footer, "the closed round panel's footer must render (roundSpend.footer is set)");
    assert.equal(getComputedStyle(footer as Element).textAlign, "right");
  } finally {
    await cleanup();
  }
});

/**
 * #924 AC2: `CostBar.tsx` has no `viewBox` — its track/fill/tick geometry (y=5.5, y=3/height=6, a
 * tick spanning y1=1..y2=11) is set directly in real CSS px, so those numbers only land where
 * they're drawn to when the `<svg>`'s own CSS height ALSO equals 12 (its own default, panels.css);
 * a shorter box would clip the tick, a taller one would leave dead space below the bar — never a
 * distortion now (no scale transform exists to distort), but still a real positioning contract
 * every context sharing this primitive must hold. COVERAGE: every production bar context this
 * fixture renders — a cost-panel bar (multiple: by-stage/by-model, today AND round), the lane
 * card's own bar — never a hand-picked subset.
 *
 * #923 AC1 (D16): the header's `cost-bar spend-meter-bar` instance deliberately does NOT share
 * this 12px default any more — `Header.tsx` passes `CostBar` a `height={20}` prop (the mockup's
 * outlined ~400×20 capsule), and `CostBar.tsx`'s own geometry scales proportionally off it (see
 * `CostBar.test.tsx`'s own `#923` tests), so it is asserted separately at its own 20px, not folded
 * into this loop's single shared expectation.
 */
test("AC2: every 12px-default hairline-bar instance's own CSS height is exactly 12px, the box its track/fill/tick coordinates assume", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const bars = [...container.querySelectorAll("svg.cost-bar")].filter((b) => !b.classList.contains("spend-meter-bar"));
    const contexts = new Set(bars.map((b) => b.getAttribute("class")));
    for (const required of ["cost-bar", "cost-bar lane-card-bar"]) {
      assert.ok(contexts.has(required), `expected a rendered "${required}" bar; got classes: ${[...contexts].join(", ")}`);
    }
    for (const bar of bars) {
      assert.equal(
        getComputedStyle(bar as Element).height,
        "12px",
        `"${bar.getAttribute("class")}" CSS height must be exactly 12px — the box CostBar.tsx's own y-coordinates assume`,
      );
    }
  } finally {
    await cleanup();
  }
});

// #923 AC1 (D16): the header meter's own taller capsule — asserted separately from the 12px-shared
// bars above, since it deliberately doesn't share their default.
test("#923 AC1: the header's spend-meter-bar resolves its own 20px height, ≥ the AC's 16px floor", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const bar = container.querySelector("svg.cost-bar.spend-meter-bar");
    assert.ok(bar, "the header's spend-meter-bar must render");
    assert.equal(getComputedStyle(bar as Element).height, "20px");
  } finally {
    await cleanup();
  }
});

/**
 * #924 AC2: `CostBar.tsx` has no `viewBox` — the track and tick's own `stroke-width: 1` (panels.css)
 * is already a real device px, with no scale-compensation mechanism (`vector-effect`) needed to
 * keep it one. happy-dom has no real layout engine (confirmed directly, repeatedly, in this file
 * and hero.test.ts — `getBoundingClientRect()` returns an all-zero box for every element), so the
 * ACTUAL rendered pixel width still can't be measured here — that is a real-browser fact, same
 * ceiling the light-dark()-outline tests above already document. What IS provable in this harness:
 * the `stroke-width` declaration cascades onto the real elements at all (a regression that dropped
 * it would fail this) — the achievable half of the proof, same STYLE-doctrine posture as the rest
 * of this file.
 */
test("AC2 (track/tick stroke-width): the track and target tick both resolve stroke-width: 1", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const track = container.querySelector(".cost-bar-track");
    assert.ok(track, "a real .cost-bar-track must render");
    assert.equal(getComputedStyle(track as Element).strokeWidth, "1", ".cost-bar-track stroke-width");

    const tick = container.querySelector(".cost-bar-target");
    assert.ok(tick, "a real .cost-bar-target must render (costToday.targetUsd is set)");
    assert.equal(getComputedStyle(tick as Element).strokeWidth, "1", ".cost-bar-target stroke-width");
  } finally {
    await cleanup();
  }
});

/**
 * #924 AC2 (pill end caps): the pill is a real rounded `<rect rx>` (CostBar.tsx), not a stroked
 * line — a rounded CORNER is carved INWARD from the rect's own x/width box, so it's fully
 * contained at every settled percentage with no scale-compensation mechanism needed (unlike a
 * stroked line's round LINECAP, which bulges OUTWARD past its own endpoint and needed
 * `vector-effect: non-scaling-stroke` to stay a true circle under a non-uniform scale that no
 * longer exists here). Same STYLE-doctrine ceiling as the track/tick test above: happy-dom cannot
 * measure the actual rendered corner radius (no real layout engine), so this proves the
 * mechanism is correctly wired — `rx`/`fill`/`stroke` all resolving on the real element is what
 * GUARANTEES a true semicircle cap, fully inside the box, in any real browser (the real-pixel half
 * of that proof — cap containment and the light outline's own visibility at the tip — lives in
 * `shots.spec.ts`, which has a real layout engine).
 */
test("AC2 (pill end caps): the fill pill is a rect with rx=3 (half its own 6px height) and resolves the real --sap-fill/--sap-fill-outline colours", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  const { light: lightTokens } = parseColorTokens(tokensCss924);
  try {
    // #923 AC1 (D16): the header's own instance renders a proportionally BIGGER rx (its `height`
    // prop is 20, not the 12px default) — real, expected, and asserted on its own two tests above;
    // excluded here so this loop's single "rx=3" expectation stays about the shared 12px bars.
    const fills = [...container.querySelectorAll(".cost-bar-fill")].filter((f) => !f.closest("svg.spend-meter-bar"));
    assert.ok(fills.length >= 2, `expected fill rects across cost panel/lane card contexts; found ${fills.length}`);
    for (const fill of fills) {
      assert.equal(fill.tagName.toLowerCase(), "rect", ".cost-bar-fill must be a real <rect>, not a stroked line");
      assert.equal(fill.getAttribute("rx"), "3", ".cost-bar-fill rx — half of FILL_HEIGHT (CostBar.tsx), a true pill radius");
      const computed = getComputedStyle(fill as Element);
      assert.equal(computed.fill, lightTokens["--sap-fill"], ".cost-bar-fill's own fill must resolve the real --sap-fill hex");
      assert.equal(
        computed.stroke,
        lightTokens["--sap-fill-outline"],
        ".cost-bar-fill's own stroke (the light outline) must resolve --sap-fill-outline",
      );
      assert.equal(
        computed.strokeWidth,
        "1",
        ".cost-bar-fill stroke-width — the light outline is a plain 1px stroke, no extra element needed",
      );
    }
  } finally {
    await cleanup();
  }
});

// #924 AC2: a fixed em floor alone still wrapped a longer label (a by-model row's own model
// name, e.g. "claude-sonnet-5") — `minmax(7em, max-content)` keeps the >= 7em floor while growing
// to fit whatever the longest rendered label actually needs. Declared on `.cost-bar-list` (the
// shared grid every `.cost-bar-row` subgrids into, panels.css) — not per-row — so the column is
// sized ONCE across a whole group, keeping every row's bar starting at the same x.
test("AC2: .cost-bar-list's label column is minmax(>= 7em, max-content) — a floor, not a fixed width that can still wrap a longer label", () => {
  const listRule = panelsCss924.match(/\.cost-bar-list\s*\{([^}]*)\}/);
  assert.ok(listRule, ".cost-bar-list rule must exist");
  const columns = listRule![1]!.match(/grid-template-columns:\s*([^;]+);/);
  assert.ok(columns, ".cost-bar-list must declare grid-template-columns");
  // The first grid TRACK is the whole `minmax(...)` call, commas and all — a naive whitespace
  // split would cut it at the comma inside the parens and see only "minmax(7em,".
  const minmax = columns![1]!.trim().match(/^minmax\(([\d.]+)em,\s*max-content\)/);
  assert.ok(minmax, `the label column must start with minmax(<em>, max-content); got "${columns![1]!.trim()}"`);
  const floorEm = Number.parseFloat(minmax![1]!);
  assert.ok(floorEm >= 7, `the label column's floor (${floorEm}em) must be >= 7em`);

  const rowRule = panelsCss924.match(/\.cost-bar-row\s*\{([^}]*)\}/);
  assert.ok(rowRule, ".cost-bar-row rule must exist");
  assert.match(
    rowRule![1]!,
    /grid-template-columns:\s*subgrid\s*;/,
    ".cost-bar-row must subgrid into .cost-bar-list's own column tracks, not size its own independent columns",
  );
});

/**
 * #924 AC2: assert the winning `grid-template-columns` on a rendered `.cost-bar-list` under the
 * full cascade (`getComputedStyle`), not the authored rule — a VALUE test on source alone only
 * proves the SOURCE declares the right thing; a later, more-specific, or width/media-scoped rule
 * could still win on the real element while that test stayed green. Verified directly that
 * happy-dom's
 * `getComputedStyle().gridTemplateColumns` DOES resolve for a real element (unlike the SVG-
 * geometry/`light-dark()` gaps elsewhere in this file) — it echoes the winning declaration's exact
 * text (not a computed max-content pixel value, since happy-dom has no real layout engine for
 * that), which is exactly the CASCADE-APPLICATION fact this finding asks for: a competing rule
 * that changed which value wins would show up here even though it can't fail on rendered pixels.
 * `.cost-bar-row`'s own winning value is checked alongside it — it must actually subgrid into
 * the list's tracks, not size its own columns independently (the fix for the per-row-drift bug).
 */
test("AC2: the winning grid-template-columns on a REAL rendered .cost-bar-list is exactly minmax(7em, max-content) 1fr 4em, and every .cost-bar-row subgrids into it", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const list = container.querySelector(".cost-bar-list");
    assert.ok(list, "a real .cost-bar-list must render (the fixture's stage/model bars)");
    assert.equal(getComputedStyle(list as Element).gridTemplateColumns, "minmax(7em, max-content) 1fr 4em");

    const rows = [...container.querySelectorAll(".cost-bar-row")];
    assert.ok(rows.length > 1, "expected multiple rows sharing one list, to prove the subgrid keeps them aligned");
    for (const row of rows) {
      assert.equal(
        getComputedStyle(row as Element).gridTemplateColumns,
        "subgrid",
        "every .cost-bar-row must subgrid, never size its own columns",
      );
    }
  } finally {
    await cleanup();
  }
});

// #924 gate② finding [1] / PO item 2, extended by #953 AC3: a rendered CASCADE fact, not just
// source text — proves `white-space: nowrap` (plus, #953, `overflow: hidden`/`text-overflow:
// ellipsis`) actually resolves onto every REAL rendered label, not merely that the source declares
// it. happy-dom has no real layout engine (`getBoundingClientRect()` on any element returns an
// all-zero box, verified directly — matching this harness's documented "DOM-free by default"
// posture, docs/dev-guide/07-dashboard.md) — so an actual "does this box span one line or two"
// pixel measurement isn't achievable here; these three computed properties are the STYLE-provable
// half of "never wrapped," and the label column's own `minmax(7em, max-content)` sizing
// (VALUE-checked above, from source) is what gives the nowrap by-stage text room to exist without
// being clipped instead. #953: the fixture's by-model "claude-sonnet-5" now renders aliased down
// to its family word ("sonnet", `format.ts`'s `modelDisplayName`) — the by-stage "Goal & align"
// row is this test's own longer-than-7em case now.
test("AC2/AC3: every rendered cost-bar label resolves white-space: nowrap, overflow: hidden, text-overflow: ellipsis — including a by-model row's aliased family word", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const labels = [...container.querySelectorAll(".cost-bar-label")];
    assert.ok(labels.length > 0, "at least one cost-bar-label must render (the fixture's by-stage/by-model bars)");
    const modelLabel = labels.find((l) => l.textContent === "sonnet");
    assert.ok(modelLabel, "the fixture's by-model row must render the aliased family word, not the raw id");
    for (const label of labels) {
      const computed = getComputedStyle(label as Element);
      assert.equal(computed.whiteSpace, "nowrap", `"${label.textContent}" label must never wrap`);
      assert.equal(computed.overflow, "hidden", `"${label.textContent}" label must clip overflow`);
      assert.equal(computed.textOverflow, "ellipsis", `"${label.textContent}" label must ellipsize`);
    }
  } finally {
    await cleanup();
  }
});

/**
 * #924 AC3: the proof is a STYLE test whose expected colour is computed from the token table via
 * `contrast.ts` (resolve the `light-dark()` pair yourself for the light theme and compare to the
 * resolved value the outline rule declares) — light = 1px stroke of that exact colour, dark =
 * none. Comparing the same unresolved `light-dark(...)` source string in both themes is not the
 * proof; happy-dom never evaluates `light-dark()` (confirmed directly, twice, both with and
 * without a `var()` indirection). `--sap-fill-outline` itself is a literal light-theme hex
 * (tokens.css's `:root[data-theme="sapwood"]` /
 * `@media (prefers-color-scheme: light)` rules, pinned against `--sap-text`'s own light value by
 * `tokens.test.ts`), so a REAL resolved hex now reaches `getComputedStyle` to assert against —
 * `parseColorTokens` (this repo's own light/dark token splitter, `contrast.ts`) is what "resolve
 * the light-dark() pair yourself" means here. Every one of the AC's own named shapes is checked
 * individually, not folded into one generic `.cost-bar-fill` query.
 *
 * #924 AC3: `CostBar.tsx`'s own three shapes (`.cost-bar` pill, `.lane-card-bar` pill,
 * `.spend-meter-bar`) carry their outline directly on `.cost-bar-fill` itself (a plain 1px stroke
 * tracing the rect's own already-rounded path) — same width as the bare `.hero-pool-chip`/droplet
 * outlines below, no second wider element needed.
 */
test("AC3: every named filled shape (.cost-bar pill, .lane-card-bar pill, .hero-pool-chip, an in-motion droplet, .spend-meter-bar) resolves the REAL --sap-text hex as a 1px outline in light theme, and none in dark", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  const { light: lightTokens } = parseColorTokens(tokensCss924);
  const lightOutlineHex = lightTokens["--sap-text"]!;
  assert.ok(lightOutlineHex, "--sap-text must resolve a light-theme hex via parseColorTokens");

  const namedShapes: [string, () => Element | null, string][] = [
    [".cost-bar pill (cost panel)", () => container.querySelector("#cost .cost-bar-fill"), "1"],
    [".lane-card-bar pill", () => container.querySelector("svg.lane-card-bar .cost-bar-fill"), "1"],
    [".hero-pool-chip", () => container.querySelector(".hero-pool-chip rect"), "1px"],
    [
      "an in-motion droplet",
      () => container.querySelector('.hero-droplet:not([data-at="trunk"]):not([data-at="needs-human"]) .hero-droplet-shape'),
      "1px",
    ],
    [".spend-meter-bar", () => container.querySelector("svg.spend-meter-bar .cost-bar-fill"), "1"],
  ];

  try {
    document.documentElement.setAttribute("data-theme", "sapwood");
    for (const [label, find, expectedWidth] of namedShapes) {
      const el = find();
      assert.ok(el, `light theme: ${label} must render`);
      const computed = getComputedStyle(el as Element);
      assert.equal(computed.stroke, lightOutlineHex, `light theme: ${label} outline stroke must resolve the exact --sap-text hex`);
      assert.equal(computed.strokeWidth, expectedWidth, `light theme: ${label} outline width`);
    }

    document.documentElement.setAttribute("data-theme", "heartwood");
    for (const [label, find] of namedShapes) {
      const el = find();
      assert.ok(el, `dark theme: ${label} must render`);
      assert.equal(getComputedStyle(el as Element).stroke, "transparent", `dark theme: ${label} outline stroke must resolve to none`);
    }
  } finally {
    document.documentElement.removeAttribute("data-theme");
    await cleanup();
  }
});

// ── #923 (D14–D18): header card ≥100px, the three-cell navigator, the outlined spend capsule,
// BACK TO LIVE in the header row, and the transport as the header card's own second row ─────────

const CLOSED_ROUND = {
  roundId: 42,
  status: "done",
  startedAt: "2026-01-01T00:00:00Z",
  endedAt: "2026-01-01T01:00:00Z",
  startEventId: 1,
  startSpendId: 1,
  eventCount: 10,
  schemaVersion: null,
  artifact: null,
};

// AC1 (STYLE, `registerRealDom()` + `getComputedStyle`, full cascade at 1440-wide `App` —
// `mountAppWithCascade` above already forces that viewport before mounting).
//
// gate② finding [0] (ac1-style-oracles-incomplete): the first cut's border checks
// (`assert.notEqual(computed.borderWidth, "0px")`) pass on an EMPTY computed string too — exactly
// what happy-dom returns for a `color-mix()`-bearing `border: var(--hairline)` shorthand
// (`.panel-head`'s own documented gap, panels.css) — so a border that failed to apply at all would
// have slipped through undetected. panels.css now declares these three rules' borders as
// longhands (`border-width`/`border-style`/`border-color`), which happy-dom DOES resolve (verified
// directly); this test asserts the exact resolved value instead of merely "not zero". Font-family
// now compares the FULL resolved stack against the real `--font-data` token (not a partial regex
// match on one family name in it), and the caption-below-the-bar claim is backed by an explicit
// `.spend-meter` `flex-direction: column` assertion, not DOM order alone.
test("#923 AC1: .app-header ≥100px, the round-nav stepper's three cells ≥40px each with a resolved 1px border, the pill's font/case/size, and the spend capsule's width/height/border/centred caption", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  const fontDataStack = parseTokensLocal(tokensCss924)["--font-data"];
  assert.ok(fontDataStack, "tokens.css must still declare --font-data for this test's own oracle");
  try {
    const header = container.querySelector(".app-header");
    assert.ok(header, ".app-header must render");
    assert.equal(getComputedStyle(header as Element).minHeight, "100px", ".app-header's declared min-height");

    const stepper = container.querySelector(".round-nav-stepper");
    assert.ok(stepper, ".round-nav-stepper must render");
    assert.equal(getComputedStyle(stepper as Element).minHeight, "40px", ".round-nav-stepper's declared min-height");

    const cells = [...container.querySelectorAll(".round-nav-stepper button")];
    assert.equal(cells.length, 3, "the stepper must carry exactly three cells (chevron | label | chevron)");
    for (const cell of cells) {
      const computed = getComputedStyle(cell as Element);
      assert.equal(computed.minHeight, "40px", `"${cell.className}" cell min-height`);
      assert.equal(computed.borderWidth, "1px", `"${cell.className}" cell must resolve a real 1px border, not an unresolved empty value`);
      assert.equal(computed.borderStyle, "solid", `"${cell.className}" cell border-style`);
    }

    const pill = container.querySelector(".round-nav-pill");
    assert.ok(pill, ".round-nav-pill must render");
    const pillComputed = getComputedStyle(pill as Element);
    assert.equal(
      pillComputed.fontFamily,
      fontDataStack,
      ".round-nav-pill font-family must resolve the COMPLETE --font-data stack, not just its first family",
    );
    assert.equal(pillComputed.textTransform, "uppercase");
    assert.ok(Number.parseFloat(pillComputed.fontSize) >= 14, `.round-nav-pill font-size (${pillComputed.fontSize}) must be >= 14px`);

    const bar = container.querySelector(".spend-meter-bar");
    assert.ok(bar, ".spend-meter-bar must render");
    const barComputed = getComputedStyle(bar as Element);
    assert.ok(
      Number.parseFloat(barComputed.width) >= 360,
      `.spend-meter-bar's declared width (${barComputed.width}) must be >= 360px (25% of the issue's 1440 normalization width)`,
    );
    assert.ok(Number.parseFloat(barComputed.height) >= 16, `.spend-meter-bar's declared height (${barComputed.height}) must be >= 16px`);
    assert.equal(barComputed.borderWidth, "1px", ".spend-meter-bar must resolve a real 1px border, not an unresolved empty value");
    assert.equal(barComputed.borderStyle, "solid", ".spend-meter-bar border-style");

    const caption = container.querySelector(".spend-meter-value");
    assert.ok(caption, ".spend-meter-value caption must render");
    assert.equal(getComputedStyle(caption as Element).textAlign, "center");
    // The caption sits BELOW the bar — proven by BOTH the layout axis (`.spend-meter`'s own
    // flex-direction: column, the mechanism that makes DOM order equal visual order here) AND DOM
    // order itself (#890's "reference element first, annotation after" contract), not DOM order
    // alone — a `flex-direction: row` (or no flex at all) would make "first in markup" mean
    // nothing about "renders above".
    const meter = bar!.closest(".spend-meter");
    assert.ok(meter, ".spend-meter-bar must sit inside .spend-meter");
    assert.equal(getComputedStyle(meter as Element).flexDirection, "column", ".spend-meter must lay its children out in a column");
    const order = [...(meter as Element).querySelectorAll("svg.spend-meter-bar, .spend-meter-value")];
    assert.deepEqual(
      order.map((el) => el.className),
      ["cost-bar spend-meter-bar", "data spend-meter-value"],
      "the bar must precede the caption in DOM order",
    );
  } finally {
    await cleanup();
  }
});

// AC2 (WIRING through App, closed round selected).
test("#923 AC2: closed round selected — BACK TO LIVE is a descendant of .app-header (not the transport row), filled --sap-fill, ≥40px tall, uppercase; Controls is absent", async () => {
  const data = { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "running" } };
  const vm = minimalAppViewModel({ mode: "replay", loop: { data, isPending: false }, rounds: [CLOSED_ROUND], selectedRoundId: 42 });
  const { container, cleanup } = await mountAppWithCascade(vm);
  const { light: lightTokens } = parseColorTokens(tokensCss924);
  try {
    assert.equal(container.querySelectorAll('[aria-label="operations"]').length, 0, "the Controls fieldset must be absent while replaying");

    const btn = container.querySelector(".header-back-to-live");
    assert.ok(btn, "the BACK TO LIVE control must render");
    assert.ok(btn?.closest(".app-header"), "BACK TO LIVE must be a descendant of .app-header");
    assert.equal(btn?.closest("section.transport"), null, "BACK TO LIVE must NOT be a descendant of the transport row");

    const computed = getComputedStyle(btn as Element);
    // happy-dom echoes the resolved var() as the authored hex string, not an rgb() conversion
    // (confirmed directly against this exact property) — compared against the real token, never a
    // hand-copied hex literal that could silently drift from tokens.css.
    assert.equal(computed.backgroundColor.toUpperCase(), lightTokens["--sap-fill"], "background must resolve to the real --sap-fill hex");
    assert.equal(computed.height, "40px");
    assert.equal(computed.textTransform, "uppercase");
  } finally {
    await cleanup();
  }
});

// AC3 (WIRING) — the transport is a descendant of `.app-header`, after a hairline separator;
// `.transport-position` is right-aligned; COVERAGE over both button sets (no engine-verb button
// inside the transport, no media glyph among the verbs).
//
// gate② finding [1] (ac3-separator-oracle-vacuous): the first cut's `assert.notEqual(...,
// "0px")` had the SAME empty-string hole AC1's border checks did (see that test's own updated
// comment) — panels.css's `.transport` rule is longhand now, so this asserts the exact resolved
// value. It also now asserts the transport actually follows `.app-header-row` in DOM order (the
// "second row, AFTER the first" half of AC3/D14 — the earlier version proved ancestry and a
// non-zero border, never ordering).
test("#923 AC3: the transport is a descendant of .app-header, AFTER the header row, separated by a resolved 1px hairline; .transport-position is right-aligned; the transport and the verbs never share a button", async () => {
  const data = { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "running" } };
  const vm = minimalAppViewModel({ mode: "replay", loop: { data, isPending: false }, rounds: [CLOSED_ROUND], selectedRoundId: 42 });
  const { container, cleanup } = await mountAppWithCascade(vm);
  try {
    const transport = container.querySelector('section[aria-label="replay transport"]');
    assert.ok(transport, "the transport section must render");
    const header = transport?.closest(".app-header");
    assert.ok(header, "the transport must be a descendant of .app-header");
    const transportComputed = getComputedStyle(transport as Element);
    assert.equal(transportComputed.borderTopWidth, "1px", "the transport must resolve a real 1px separator, not an unresolved empty value");
    assert.equal(transportComputed.borderTopStyle, "solid", "the transport's separator border-style");

    const headerRow = header?.querySelector(".app-header-row");
    assert.ok(headerRow, "the header row must render");
    const rowIndex = [...header!.children].indexOf(headerRow as Element);
    const transportIndex = [...header!.children].indexOf(transport as Element);
    assert.ok(
      rowIndex >= 0 && transportIndex > rowIndex,
      `the transport (child ${transportIndex}) must render AFTER .app-header-row (child ${rowIndex}) — the second row, not the first`,
    );

    const position = transport?.querySelector(".transport-position");
    assert.ok(position, ".transport-position must render");
    assert.equal(getComputedStyle(position as Element).marginLeft, "auto", ".transport-position must be right-aligned");

    // COVERAGE: every button the transport row renders vs. every button the verbs row renders —
    // read off the rendered tree, never a hand-picked pair. Cross-checked against a SEPARATE live
    // mount (verbs present, transport absent while nothing is selected) so this proves the two
    // sets are genuinely disjoint, rather than one side being vacuously empty here.
    const transportLabels = [...(transport as Element).querySelectorAll("button")].map((b) => b.textContent?.trim());
    const verbGlyphs = ["▶", "⏸"];
    const liveVm = minimalAppViewModel({ mode: "live", loop: { data, isPending: false }, rounds: [CLOSED_ROUND] });
    const live = await mountAppWithCascade(liveVm);
    try {
      const liveVerbLabels = [...live.container.querySelectorAll('[aria-label="operations"] button')].map((b) => b.textContent?.trim());
      assert.ok(liveVerbLabels.length > 0, "the verbs must render in live mode");
      for (const verbLabel of liveVerbLabels) {
        assert.ok(
          verbLabel && !verbGlyphs.some((g) => verbLabel.includes(g)),
          `verb "${verbLabel}" must never carry a media glyph (${verbGlyphs.join(", ")})`,
        );
      }
      for (const transportLabel of transportLabels) {
        assert.ok(
          transportLabel && !liveVerbLabels.includes(transportLabel),
          `transport control "${transportLabel}" must not also be one of the engine verbs`,
        );
      }
    } finally {
      await live.cleanup();
    }
  } finally {
    await cleanup();
  }
});

/** Same raw-value read `contrast.ts`'s own `parseTokens` performs — duplicated locally (rather
 *  than importing `contrast.ts` into this already-large file) since only the ONE token this
 *  suite needs is read; `tokens.test.ts` is the file that actually exercises `contrast.ts` itself. */
function parseTokensLocal(css: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [, name, value] of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(--[\w-]+)\s*:\s*([^;}]+)/g)) {
    out[name!] = value!.trim();
  }
  return out;
}

// ── #923: BACK TO LIVE/stepper glyphs, row-1 proportion, replay-tint, BTL position (MARKUP +
// STYLE + WIRING, real DOM cascade). ────────────────────────────────────────────────────────

// MARKUP: the mockup's "⏩" is a SHAPE (double chevron), not the blue colour-emoji codepoint the
// earlier hand-typed `<span>⏩</span>` rendered — `lucide-react`'s `FastForward` draws the same
// shape in `currentColor`, themeable, never a fixed-colour glyph. Same rule for the stepper's own
// tiny filled ◂▸ characters, which read near-empty at the cell's 40px min-height —
// `ChevronLeft`/`ChevronRight` stroked glyphs replace them.
test("#923: BACK TO LIVE renders lucide-react's FastForward (no U+23E9 colour-emoji glyph); the stepper renders lucide ChevronLeft/ChevronRight (no ◂▸ characters)", async () => {
  const data = { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "running" } };
  const vm = minimalAppViewModel({ mode: "replay", loop: { data, isPending: false }, rounds: [CLOSED_ROUND], selectedRoundId: 42 });
  const { container, cleanup } = await mountAppWithCascade(vm);
  try {
    const btn = container.querySelector(".header-back-to-live");
    assert.ok(btn, "the BACK TO LIVE control must render");
    assert.ok(btn?.querySelector("svg.lucide-fast-forward"), "BACK TO LIVE must render lucide-react's FastForward icon");
    assert.doesNotMatch(btn?.textContent ?? "", /⏩/, "BACK TO LIVE must never render the U+23E9 colour-emoji glyph");

    const stepper = container.querySelector(".round-nav-stepper");
    assert.ok(stepper, ".round-nav-stepper must render");
    assert.ok(stepper?.querySelector("svg.lucide-chevron-left"), "the previous-round cell must render lucide-react's ChevronLeft");
    assert.ok(stepper?.querySelector("svg.lucide-chevron-right"), "the next-round cell must render lucide-react's ChevronRight");
    assert.doesNotMatch(stepper?.textContent ?? "", /[◂▸]/, "the stepper must never render the tiny filled ◂▸ glyph characters");
  } finally {
    await cleanup();
  }
});

// STYLE: `.app-header-row` — not `.app-header` (the card) — carries the ≥100px floor a LIVE
// mount (no transport row beneath it) needs to keep its own content centred rather than
// top-hugging leftover space the card's own min-height otherwise leaves below it.
test("#923: .app-header-row itself is >= 100px (and <= the issue's own 130px upper bound) with align-items: center — the live state no longer top-hugs the card's min-height", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const row = container.querySelector(".app-header-row");
    assert.ok(row, ".app-header-row must render");
    const computed = getComputedStyle(row as Element);
    const minHeight = Number.parseFloat(computed.minHeight);
    assert.ok(minHeight >= 100, `.app-header-row's declared min-height (${computed.minHeight}) must be >= 100px`);
    assert.ok(minHeight <= 130, `.app-header-row's declared min-height (${computed.minHeight}) must be <= 130px`);
    assert.equal(computed.alignItems, "center", ".app-header-row must vertically centre its content");
  } finally {
    await cleanup();
  }
});

// STYLE: replay = amber on the joined stepper's own group border AND each cell's dividing
// border, on a mount with a CLOSED round actually selected (never asserted against the
// live/default case) — the exact resolved `border-color`, in BOTH themes, via `getComputedStyle`
// on the real mounted cascade (`registerRealDom()`, imported at this file's own top). `--sap-text`
// itself is `light-dark(...)`, which happy-dom's CSS engine never evaluates for a colour-typed
// property at all (confirmed directly: unlike `stroke`, which echoes the raw unresolved text
// back, `border-color`/`color` return an EMPTY string the instant the winning declaration touches
// a `light-dark()` chain) — `--stepper-replay-outline` (panels.css/tokens.css) is the literal-hex
// alias that sidesteps this, pinned against `--sap-text`'s own two branches by tokens.test.ts, so
// this test still proves the REAL resolved colour rather than falling back to source text.
test("#923: with a closed round selected, .round-nav-stepper's own border AND each cell's border resolve to the real amber in both themes, never the neutral grey group border", async () => {
  const data = { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "running" } };
  const vm = minimalAppViewModel({ mode: "replay", loop: { data, isPending: false }, rounds: [CLOSED_ROUND], selectedRoundId: 42 });
  const { container, cleanup } = await mountAppWithCascade(vm);
  const { light, dark } = parseColorTokens(tokensCss924);
  try {
    const stepper = container.querySelector(".round-nav-stepper");
    assert.ok(stepper, ".round-nav-stepper must render");
    assert.match(stepper?.className ?? "", /round-nav-stepper-closed/, "a closed round must add the closed modifier class");

    const pill = container.querySelector(".round-nav-pill-closed");
    assert.ok(pill, "the closed pill's own pre-existing tint must still render, unchanged by this fix");

    const cells = [...stepper!.querySelectorAll(".round-nav-arrow, .round-nav-pill")];
    assert.equal(cells.length, 3, "the stepper must carry exactly three cells (chevron | label | chevron)");

    const expectedByTheme = { heartwood: dark["--sap-text"], sapwood: light["--sap-text"] } as const;
    for (const themeAttr of ["heartwood", "sapwood"] as const) {
      document.documentElement.setAttribute("data-theme", themeAttr);
      const expected = expectedByTheme[themeAttr];
      assert.equal(
        getComputedStyle(stepper as Element).borderColor.toUpperCase(),
        expected,
        `${themeAttr}: .round-nav-stepper's border-color must resolve to the real amber`,
      );
      for (const cell of cells) {
        assert.equal(
          getComputedStyle(cell as Element).borderColor.toUpperCase(),
          expected,
          `${themeAttr}: "${(cell as Element).className}" cell's border-color must resolve to the real amber`,
        );
      }
    }
  } finally {
    document.documentElement.removeAttribute("data-theme");
    await cleanup();
  }
});

// A live (non-closed) mount is the CONTROL for the test above — proves the amber modifier is
// genuinely conditional on replaying a closed round, never present by default.
test("#923 (control): a live mount (no round selected) never adds .round-nav-stepper-closed", async () => {
  const { container, cleanup } = await mountAppWithCascade(fullCoverageViewModel());
  try {
    const stepper = container.querySelector(".round-nav-stepper");
    assert.ok(stepper, ".round-nav-stepper must render");
    assert.doesNotMatch(stepper?.className ?? "", /round-nav-stepper-closed/, "live mode must never carry the closed-round amber modifier");
  } finally {
    await cleanup();
  }
});

// WIRING: mockup band-2 order is status · stepper · BACK TO LIVE · meter · "?" — proven as DOM
// order inside `.engine-status` (the header word/navigator/meter's own shared flex row), not just
// AC2's existing ancestry/non-transport proof.
test('#923: BACK TO LIVE sits between the round-nav stepper and the spend meter inside .engine-status ("status · stepper · BACK TO LIVE · meter"), still never a descendant of the transport row', async () => {
  const data = { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "running" } };
  const vm = minimalAppViewModel({ mode: "replay", loop: { data, isPending: false }, rounds: [CLOSED_ROUND], selectedRoundId: 42 });
  const { container, cleanup } = await mountAppWithCascade(vm);
  try {
    const status = container.querySelector(".engine-status");
    assert.ok(status, ".engine-status must render");
    const nav = status?.querySelector(".round-nav");
    const btn = status?.querySelector(".header-back-to-live");
    const meter = status?.querySelector(".spend-meter");
    assert.ok(nav && btn && meter, "the stepper, BACK TO LIVE, and spend meter must all render inside .engine-status");

    const kids = [...(status as Element).children];
    const navIndex = kids.indexOf(nav as Element);
    const btnIndex = kids.indexOf(btn as Element);
    const meterIndex = kids.indexOf(meter as Element);
    assert.ok(
      navIndex >= 0 && navIndex < btnIndex && btnIndex < meterIndex,
      `BACK TO LIVE (child ${btnIndex}) must render between the stepper (child ${navIndex}) and the spend meter (child ${meterIndex})`,
    );

    assert.ok(btn?.closest(".app-header"), "BACK TO LIVE must still be a descendant of .app-header");
    assert.equal(btn?.closest("section.transport"), null, "BACK TO LIVE must still NOT be a descendant of the transport row");
  } finally {
    await cleanup();
  }
});

// WIRING: Header.tsx's `disconnected`/`isPending` early returns used to discard `replayAction`
// entirely (returning a bare `<p>`, never rendering `{replayAction}` at all) — a replay viewer
// who loses the connection, or is still loading, had no way back to live even though App.tsx was
// still passing the button through. Both early-return branches now render it too.
//
// `minimalAppViewModel`'s own return is cast `as unknown as Parameters<typeof appContent>[0]`
// (its own doc comment: the full TanStack `UseQueryResult` shape isn't worth hand-implementing) —
// an override spread OUTSIDE that call loses the cast and gets structurally checked against the
// real `AppViewModel`, which a bare `{ data, isPending }` stand-in can never satisfy. Re-applying
// the SAME cast on the merged object is the established pattern this file already uses whenever a
// test overrides a field after the fact (e.g. the #766 gate② finding [2] tests' own `{ ...vm, mode:
// "live" } as unknown as Parameters<typeof appContent>[0]`).
test("#923: with a closed round selected, BACK TO LIVE still renders inside .app-header while the engine status is disconnected, and while it is still connecting", async () => {
  const data = { ...LOOP_STATE_OK, controlsEnabled: true, engine: { ...LOOP_STATE_OK.engine, state: "running" } };
  const cases = [
    { name: "disconnected", overrides: { disconnected: true } },
    { name: "connecting", overrides: { loop: { data: undefined, isPending: true } } },
  ] as const;
  for (const { name, overrides } of cases) {
    const vm = {
      ...minimalAppViewModel({ mode: "replay", loop: { data, isPending: false }, rounds: [CLOSED_ROUND], selectedRoundId: 42 }),
      ...overrides,
    } as unknown as Parameters<typeof appContent>[0];
    const { container, cleanup } = await mountAppWithCascade(vm);
    try {
      const btn = container.querySelector(".header-back-to-live");
      assert.ok(btn, `${name}: the BACK TO LIVE control must still render`);
      assert.ok(btn?.closest(".app-header"), `${name}: BACK TO LIVE must still be a descendant of .app-header`);
    } finally {
      await cleanup();
    }
  }
});

// ── #925 AC1: row anatomy — height/severity/chip/entity/reason/hairline, through the REAL query
// wiring (registerRealDom() + the full production CSS cascade + a stubbed /api/events), not a
// hand-assembled view-model — docs/dev-guide/07-dashboard.md's still-open "query/data-flow wiring
// has no shared helper yet" gap: this local helper combines `mountAppWithCascade`'s CSS injection
// with `mountSettledApp`'s real fetch stubbing, the same combination that gap names as unmet.

async function mountLiveAppWithCascade(byPath: Record<string, { status: number; body: unknown }>) {
  (window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }).happyDOM.setViewport({ width: 1440 });
  const style = document.createElement("style");
  style.textContent = `${tokensCss924}\n${panelsCss924}\n${heroCss924}\n${appCss924}`;
  document.head.appendChild(style);
  stubFetch({ ...SPEND_EMPTY, ...ROUNDS_EMPTY, ...byPath });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, retryOnMount: false } } });
  await Promise.allSettled([
    client.prefetchQuery(loopStateQuery()),
    client.prefetchQuery(eventsQuery(0)),
    client.prefetchQuery(spendQuery(0)),
    client.prefetchQuery(roundsQuery()),
  ]);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => {
        root.unmount();
      });
      container.remove();
      document.head.removeChild(style);
    },
  };
}

// ── #953 AC2 (WIRING): the real `App` → `LiveApp` → `CostStrip` tree, `/api/loop/state` mocked
// with a real `spend.byModel` payload (the actual production data source `App.tsx`'s own
// `todayModelBars` reads, per `App.tsx`'s own comment on that field — never a hand-assembled
// `CostPanelData`) — proves the alias, the tooltip, and the full-id preservation all survive the
// real wiring, not just the `CostStrip`/`Bar` component in isolation. ──────────────────────────

test("#953 AC2: a by-model row's .cost-bar-label renders the aliased family word, wrapped in a HintTooltip carrying the full raw id, through the real App -> LiveApp -> CostStrip wiring", async () => {
  const { container, cleanup } = await mountLiveAppWithCascade({
    "/api/loop/state": {
      status: 200,
      body: {
        ...LOOP_STATE_OK,
        spend: {
          todayUsd: 12.7,
          dailyBudgetUsd: null,
          runUsd: null,
          runBudgetUsd: null,
          byModel: [
            { model: "claude-sonnet-5", usd: 7.8, inputTokens: 0, outputTokens: 0 },
            { model: "claude-opus-4-1", usd: 4.9, inputTokens: 0, outputTokens: 0 },
          ],
        },
      },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  try {
    const labels = [...container.querySelectorAll(".cost-bar-label")];
    for (const label of labels) {
      assert.equal(label.hasAttribute("title"), false, `"${label.textContent}" .cost-bar-label must carry no bare title= attribute`);
    }

    for (const [alias, fullId] of [
      ["sonnet", "claude-sonnet-5"],
      ["opus", "claude-opus-4-1"],
    ] as const) {
      const label = labels.find((l) => l.textContent === alias);
      assert.ok(label, `a .cost-bar-label reading "${alias}" must render`);
      assert.ok(!labels.some((l) => l.textContent === fullId), `the raw id "${fullId}" must never appear as the visible label text`);
      const trigger = label as HTMLElement;
      assert.equal(trigger.tabIndex, 0, `"${alias}" label must be a real tab stop — a <span> isn't focusable by default`);
      await act(async () => {
        trigger.focus();
      });
      const tooltip = container.querySelector('[role="tooltip"]');
      assert.ok(tooltip, `focusing the "${alias}" label must open its tooltip`);
      assert.equal(tooltip?.textContent, fullId, `the "${alias}" label's tooltip must carry the full id "${fullId}"`);
      await act(async () => {
        trigger.blur();
      });
    }
  } finally {
    await cleanup();
  }
});

// gate① engine-agent finding [0] (ac1-style-oracle): round 1 compared `severity.style.
// backgroundColor` against `chip.style.borderColor` (raw, uncascaded inline reads) and checked
// the reason colour via a regex over CSS source — neither is a computed-style proof. Fixed the
// doctrine-established way (tokens.css's `--sap-fill-outline`/`--stepper-replay-outline`
// precedent): `--attention-tone-rust`/`--attention-tone-review`/`--attention-reason-text`
// (tokens.css) are literal-hex aliases of `--rust`/`--sap-text`/`--bark-text` — pinned against
// those source tokens by tokens.test.ts so they can't drift — that DO resolve via
// `getComputedStyle` in happy-dom (unlike the light-dark()-fed originals). Looped over both
// themes (COVERAGE), same posture the #923 closed-round-stepper STYLE test already takes for the
// identical happy-dom gap.
test("#925 AC1: every .attention-row is >=56px with a hairline separator, its severity bar and chip resolve the REAL rust/--sap-text tone in both themes, the chip is >=30px/uppercase/mono, the entity ref is >=14px mono, and the reason resolves the REAL --bark-text colour and is mono", async () => {
  const fontDataStack = parseTokensLocal(tokensCss924)["--font-data"];
  assert.ok(fontDataStack, "tokens.css must still declare --font-data for this test's own oracle");
  const { light: lightTokens, dark: darkTokens } = parseColorTokens(tokensCss924);
  // Two distinct categories (DECISION/rust, DISSENT/--sap-text) — COVERAGE over both severity
  // tones, not just the default one, and both carry a PR token so the entity-ref cell renders.
  const { container, cleanup } = await mountLiveAppWithCascade({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": {
      status: 200,
      body: {
        events: [
          { id: 1, ts: "2026-08-14T00:00:00Z", kind: "drive-needs-human", payload: { pr: 42, issue: 7 } },
          { id: 2, ts: "2026-08-14T00:01:00Z", kind: "review-disputed", payload: { pr: 43, issue: 8, worker: "w1" } },
        ],
        lastId: 2,
      },
    },
  });
  try {
    const rows = [...container.querySelectorAll(".attention-row")];
    assert.ok(rows.length >= 2, "at least two attention rows must render");

    for (const themeAttr of ["heartwood", "sapwood"] as const) {
      document.documentElement.setAttribute("data-theme", themeAttr);
      const tokens = themeAttr === "heartwood" ? darkTokens : lightTokens;

      for (const row of rows) {
        const rowComputed = getComputedStyle(row as Element);
        assert.ok(Number.parseFloat(rowComputed.minHeight) >= 56, `each row's min-height (${rowComputed.minHeight}) must be >= 56px`);
        assert.equal(rowComputed.borderBottomWidth, "1px", "each row must resolve a real 1px hairline, not an unresolved empty value");
        assert.equal(rowComputed.borderBottomStyle, "solid");

        const severity = row.querySelector(".attention-severity") as HTMLElement | null;
        assert.ok(severity, "each row must render its severity element");
        assert.equal(getComputedStyle(severity as Element).width, "4px");
        assert.equal(severity?.getAttribute("aria-hidden"), "true");

        const chip = row.querySelector(".attention-chip") as HTMLElement | null;
        assert.ok(chip, "each row must render its category chip");
        const chipComputed = getComputedStyle(chip as Element);
        assert.ok(Number.parseFloat(chipComputed.minHeight) >= 30, `chip min-height (${chipComputed.minHeight}) must be >= 30px`);
        assert.equal(chipComputed.textTransform, "uppercase");
        assert.equal(chipComputed.fontFamily, fontDataStack);

        const expectedTone = chip?.textContent === "DISSENT" ? tokens["--sap-text"] : tokens["--rust"];
        const severityComputed = getComputedStyle(severity as Element);
        assert.equal(
          severityComputed.backgroundColor.toUpperCase(),
          expectedTone,
          `${themeAttr}: the severity bar's background must resolve to the real ${chip?.textContent === "DISSENT" ? "--sap-text" : "--rust"} hex`,
        );
        assert.equal(
          chipComputed.borderColor.toUpperCase(),
          expectedTone,
          `${themeAttr}: the chip's border-colour must resolve to the SAME real hex as the severity bar`,
        );

        const entityRef = row.querySelector(".attention-entity-ref") as HTMLElement | null;
        if (entityRef) {
          const entityComputed = getComputedStyle(entityRef);
          assert.ok(Number.parseFloat(entityComputed.fontSize) >= 14, `entity ref font-size (${entityComputed.fontSize}) must be >= 14px`);
          assert.equal(entityComputed.fontFamily, fontDataStack);
        }

        const reason = row.querySelector(".attention-sentence") as HTMLElement | null;
        assert.ok(reason, "each row must render its reason cell");
        const reasonComputed = getComputedStyle(reason as Element);
        assert.equal(reasonComputed.fontFamily, fontDataStack);
        assert.equal(
          reasonComputed.color.toUpperCase(),
          tokens["--bark-text"],
          `${themeAttr}: the reason cell's colour must resolve to the real --bark-text hex`,
        );
      }
    }
    // Both fixture kinds carry a PR token — the `if (entityRef)` guard above would otherwise
    // silently skip its own assertion if wiring ever dropped the token through to the row.
    assert.equal(container.querySelectorAll(".attention-entity-ref").length, 2, "both rows must render an entity ref");
  } finally {
    document.documentElement.removeAttribute("data-theme");
    await cleanup();
  }
});
