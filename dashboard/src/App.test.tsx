import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { App, appContent, resolveFixCap, toggleConfigOpen } from "./App.tsx";
import { eventsQuery, loopStateQuery, spendQuery } from "./api/queries.ts";
import { IconRail, railContent } from "./components/IconRail.tsx";
import { initialHeroState } from "./hero/state.ts";

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
function minimalAppViewModel(overrides: { configOpen?: boolean; setConfigOpen?: (updater: unknown) => void } = {}) {
  return {
    clock: new Date("2026-01-01T00:00:00Z"),
    loop: { data: undefined, isPending: false },
    events: { events: [], titles: {}, openAttention: [], hero: initialHeroState(null), steps: [], error: undefined, isPending: false },
    disconnected: false,
    parked: false,
    repoUrl: undefined,
    fixCap: 2,
    byModel: { title: "by model", bars: [] },
    byLane: { title: "by lane", bars: [] },
    byPhase: { title: "by phase", bars: [] },
    configOpen: overrides.configOpen ?? false,
    setConfigOpen: overrides.setConfigOpen ?? (() => {}),
    // #741: a minimal live-mode replay view — this fixture never exercises replay itself, only
    // App's config-trigger wiring, so every replay field is the same "nothing selected" shape
    // `useReplay` starts in.
    mode: "live",
    rounds: [],
    replay: {
      mode: "live",
      selectedRoundId: null,
      selectRound: () => {},
      loading: false,
      position: null,
      playing: false,
      speed: 1,
      play: () => {},
      pause: () => {},
      setSpeed: () => {},
      scrub: () => {},
      spendThroughCursor: [],
      phaseWindows: [],
    },
    activeHero: initialHeroState(null),
    activeSteps: [],
    activeEvents: [],
    activeTitles: {},
    activeOpenAttention: [],
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
  engine: { state: "running", reasons: [], lastTickAt: null, pauseActive: false, standbyNextCheckSec: null },
  lanes: { max: 1, items: [] },
  round: null,
  spend: { todayUsd: 0, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
  rings: 0,
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

async function renderSettledApp(
  byPath: Record<string, { status: number; body: unknown }>,
  now?: Date,
  initialConfigOpen?: boolean,
): Promise<string> {
  // `/api/spend` defaults to an empty, successful page — most tests here aren't exercising the
  // cost strip and would otherwise fail on an unstubbed fetch now that App also polls it (#715
  // gate② round 3 [2]). Callers exercising spend explicitly can still override it via `byPath`.
  stubFetch({ ...SPEND_EMPTY, ...byPath });
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
  ]);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <App now={now} initialConfigOpen={initialConfigOpen} />
    </QueryClientProvider>,
  );
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

test("both queries succeeding renders the normal header, not disconnected", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": { status: 200, body: LOOP_STATE_OK },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.doesNotMatch(html, /disconnected/);
  assert.match(html, />running</);
});

// #723: AC12 operator probe — the header must render `standby` (with its calm caption and the
// next-check countdown), never `stalled`, during a healthy backoff dwell.
test("#723: header renders the standby word with its plain-language caption and next-check countdown, not stalled", async () => {
  const html = await renderSettledApp({
    "/api/loop/state": {
      status: 200,
      body: { ...LOOP_STATE_OK, engine: { state: "standby", reasons: [], lastTickAt: null, pauseActive: false, standbyNextCheckSec: 42 } },
    },
    "/api/events": { status: 200, body: { events: [], lastId: 0 } },
  });
  assert.match(html, />standby</);
  assert.match(html, /idle — nothing to work on right now — checking again in 42s/);
  assert.doesNotMatch(html, /stalled/);
});

test("#715 gate② round 3 [2]: a completed lane's settled spend still renders in the by-lane cost strip", async () => {
  // The lane is NOT in `lanes.items` (it already left the active set — merged/reclaimed), but its
  // spend_ledger row still exists, forever, since the ledger is append-only. This is exactly the
  // finding's scenario: the active-worker read model alone would show nothing for this lane.
  const html = await renderSettledApp(
    {
      "/api/loop/state": { status: 200, body: { ...LOOP_STATE_OK, lanes: { max: 1, items: [] } } },
      "/api/events": { status: 200, body: { events: [], lastId: 0 } },
      "/api/spend": {
        status: 200,
        body: {
          spend: [
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
          ],
          lastId: 1,
        },
      },
    },
    new Date("2026-08-06T12:00:00Z"),
  );
  assert.match(html, /w1/);
  assert.match(html, /\$3\.40/);
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
