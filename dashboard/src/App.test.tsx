import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { App, appContent, resolveActiveFold, resolveFixCap, resolveRoundSpend, toggleConfigOpen } from "./App.tsx";
import { eventsQuery, loopStateQuery, spendQuery } from "./api/queries.ts";
import { Header } from "./components/Header.tsx";
import { IconRail, railContent } from "./components/IconRail.tsx";
import type { DomainEvent } from "./domain-event.ts";
import { initialHeroState } from "./hero/state.ts";
import { initialReplayState } from "./replay/reducer.ts";

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
  } = {},
) {
  return {
    clock: new Date("2026-01-01T00:00:00Z"),
    loop: overrides.loop ?? { data: undefined, isPending: false },
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
    mode: overrides.mode ?? "live",
    rounds: [],
    replay: {
      mode: overrides.mode ?? "live",
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
