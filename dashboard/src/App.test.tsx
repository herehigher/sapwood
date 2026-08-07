import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { App } from "./App.tsx";
import { eventsQuery, loopStateQuery, spendQuery } from "./api/queries.ts";

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
  engine: { state: "running", reasons: [], lastTickAt: null },
  lanes: { max: 1, items: [] },
  round: null,
  spend: { todayUsd: 0, dailyBudgetUsd: null, runUsd: null, runBudgetUsd: null, byModel: [] },
  rings: 0,
  logPath: null,
  config: {},
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

async function renderSettledApp(byPath: Record<string, { status: number; body: unknown }>, now?: Date): Promise<string> {
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
      <App now={now} />
    </QueryClientProvider>,
  );
}

test.afterEach(() => mock.restoreAll());

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
