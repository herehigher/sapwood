import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineState } from "../api/types.ts";
import { type EngineFacts, Header, resolveSpendMeter, showsPauseChip } from "./Header.tsx";

// ── pure helpers (§3 A / §8) ────────────────────────────────────────────────────────────────

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
const engine = (state: EngineState, extra: Partial<EngineFacts> = {}): EngineFacts => ({
  state,
  pauseActive: false,
  standbyNextCheckSec: null,
  ...extra,
});

test("renders the state word as text, not color alone", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={false} />,
  );
  assert.match(html, />running</);
});

test('the precedence case: stalled + PAUSE set renders `stalled` plus a secondary "PAUSE set" chip', () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("stalled", { pauseActive: true })} spend={SPEND_OK} parked={false} />,
  );
  assert.match(html, />stalled</);
  assert.match(html, /PAUSE set/);
});

test("paused alone renders no secondary chip", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("paused", { pauseActive: true })} spend={SPEND_OK} parked={false} />,
  );
  assert.match(html, />paused</);
  assert.doesNotMatch(html, /PAUSE set/);
});

// #723: the raw §8 word renders unchanged, with `engineStateCaption`'s plain-language phrase
// (and, for standby, the next-check countdown) alongside it — App.test.tsx's own #723 test pins
// this same contract at the App level; this is the component-level half.
test("standby renders its own raw word plus the calm plain-language caption and next-check countdown", () => {
  const html = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("standby", { standbyNextCheckSec: 42 })}
      spend={SPEND_OK}
      parked={false}
    />,
  );
  assert.match(html, />standby</);
  assert.match(html, /idle — nothing to work on right now — checking again in 42s/);
});

test("an env-park episode adds its own small sub-caption alongside standby, never a new state word", () => {
  const notParked = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("standby")} spend={SPEND_OK} parked={false} />,
  );
  assert.doesNotMatch(notParked, /engine-park-caption/);

  const parked = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("standby")} spend={SPEND_OK} parked={true} />,
  );
  assert.match(parked, />standby</);
  assert.match(parked, /engine-park-caption/);
});

test("park never adds its sub-caption outside the standby word (no second, unrelated tier)", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={true} />,
  );
  assert.doesNotMatch(html, /engine-park-caption/);
});

test("every §8 state renders its own raw word", () => {
  const states: EngineState[] = ["running", "standby", "stalled", "paused", "winding-down", "stopping", "stopped"];
  for (const state of states) {
    const html = renderToStaticMarkup(
      <Header disconnected={false} isPending={false} engine={engine(state)} spend={SPEND_OK} parked={false} />,
    );
    assert.match(html, new RegExp(`>${state}<`), `${state} must render its own word`);
  }
});

test("disconnected pre-empts the state word and meter entirely", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={true} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={false} />,
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
      engine={engine("running")}
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
    <Header disconnected={false} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={false} />,
  );
  assert.doesNotMatch(html, /droplet = an issue moving through the loop/);
  assert.doesNotMatch(html, /aria-label="Legend"/);
});
