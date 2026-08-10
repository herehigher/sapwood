import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineState } from "../api/types.ts";
import { displayEngineWord, Header, resolveSpendMeter, showsPauseChip } from "./Header.tsx";

// ── pure helpers (§3 A / §8) ────────────────────────────────────────────────────────────────

test("displayEngineWord: the seven §8 words collapse to the documented display vocabulary", () => {
  const cases: [EngineState, string][] = [
    ["running", "running"],
    ["standby", "waiting"],
    ["stalled", "stalled"],
    ["paused", "paused"],
    ["winding-down", "stopping"],
    ["stopping", "stopping"],
    ["stopped", "stopped"],
  ];
  for (const [state, word] of cases) {
    assert.equal(displayEngineWord(state), word, `${state} -> ${word}`);
  }
});

test("showsPauseChip: the precedence case — a masked PAUSE (state isn't `paused`) still shows the secondary chip", () => {
  assert.equal(showsPauseChip("stalled", true), true, "stale engine + PAUSE file — staleness beats PAUSE in the word, not the fact");
  assert.equal(showsPauseChip("stopped", true), true, "kill switch also outranks PAUSE in the word");
  assert.equal(showsPauseChip("winding-down", true), true, "a ceiling breach also outranks PAUSE in the word");
});

test("showsPauseChip: never shown when PAUSE isn't set, or when the word already IS `paused` (no redundant chip)", () => {
  assert.equal(showsPauseChip("stalled", false), false);
  assert.equal(showsPauseChip("running", false), false);
  assert.equal(showsPauseChip("paused", true), false, "the primary word already says it — no second chip");
});

test("resolveSpendMeter: the run tier when runBudgetUsd is set", () => {
  const view = resolveSpendMeter({ runUsd: 12, runBudgetUsd: 100, todayUsd: 50, dailyBudgetUsd: 200 });
  assert.deepEqual(view, { tier: "run", usedUsd: 12, budgetUsd: 100 });
});

test("resolveSpendMeter: falls back WHOLE to the daily tier when runBudgetUsd is null — never a mixed reading", () => {
  const view = resolveSpendMeter({ runUsd: 12, runBudgetUsd: null, todayUsd: 50, dailyBudgetUsd: 200 });
  assert.deepEqual(view, { tier: "daily", usedUsd: 50, budgetUsd: 200 }, "runUsd (12) must never pair with dailyBudgetUsd (200)");
});

test("resolveSpendMeter: daily tier with no configured ceiling at all reports an honest null budget, never a guessed one", () => {
  const view = resolveSpendMeter({ runUsd: null, runBudgetUsd: null, todayUsd: 3.5, dailyBudgetUsd: null });
  assert.deepEqual(view, { tier: "daily", usedUsd: 3.5, budgetUsd: null });
});

// ── rendering ────────────────────────────────────────────────────────────────────────────────

const SPEND_OK = { runUsd: null, runBudgetUsd: null, todayUsd: 12, dailyBudgetUsd: 100 };

test("renders the state word as text, not color alone", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={{ state: "running", pauseActive: false }} spend={SPEND_OK} parked={false} />,
  );
  assert.match(html, />running</);
});

test('the precedence case: stalled + PAUSE set renders `stalled` plus a secondary "PAUSE set" chip', () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={{ state: "stalled", pauseActive: true }} spend={SPEND_OK} parked={false} />,
  );
  assert.match(html, />stalled</);
  assert.match(html, /PAUSE set/);
});

test("paused alone renders no secondary chip", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={{ state: "paused", pauseActive: true }} spend={SPEND_OK} parked={false} />,
  );
  assert.match(html, />paused</);
  assert.doesNotMatch(html, /PAUSE set/);
});

test("standby collapses to the display word `waiting`, with a park sub-caption only when parked", () => {
  const waiting = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={{ state: "standby", pauseActive: false }} spend={SPEND_OK} parked={false} />,
  );
  assert.match(waiting, />waiting</);
  assert.doesNotMatch(waiting, /park/);

  const parked = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={{ state: "standby", pauseActive: false }} spend={SPEND_OK} parked={true} />,
  );
  assert.match(parked, />waiting</);
  assert.match(parked, /park/);
});

test("winding-down and stopping both collapse to the display word `stopping`", () => {
  const windingDown = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={{ state: "winding-down", pauseActive: false }}
      spend={SPEND_OK}
      parked={false}
    />,
  );
  assert.match(windingDown, />stopping</);
  const stopping = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={{ state: "stopping", pauseActive: false }} spend={SPEND_OK} parked={false} />,
  );
  assert.match(stopping, />stopping</);
});

test("disconnected pre-empts the state word and meter entirely", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={true} isPending={false} engine={{ state: "running", pauseActive: false }} spend={SPEND_OK} parked={false} />,
  );
  assert.match(html, /disconnected — restart sapwood to reconnect/);
  assert.doesNotMatch(html, />running</);
});

test("pending (no data yet) shows the connecting caption", () => {
  const html = renderToStaticMarkup(<Header disconnected={false} isPending={true} spend={undefined} engine={undefined} parked={false} />);
  assert.match(html, /connecting…/);
});

test("the meter renders the run tier's numerator/denominator, never the daily pair, when runBudgetUsd is set", () => {
  const html = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={{ state: "running", pauseActive: false }}
      spend={{ runUsd: 12, runBudgetUsd: 100, todayUsd: 999, dailyBudgetUsd: 999 }}
      parked={false}
    />,
  );
  assert.match(html, /\$12/);
  assert.match(html, /\$100/);
  assert.doesNotMatch(html, /999/);
});

test("does not render, import, or re-implement the legend", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={{ state: "running", pauseActive: false }} spend={SPEND_OK} parked={false} />,
  );
  assert.doesNotMatch(html, /droplet = an issue moving through the loop/);
  assert.doesNotMatch(html, /aria-label="Legend"/);
});
