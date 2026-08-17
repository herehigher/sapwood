import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineState } from "../api/types.ts";
import { registerRealDom } from "../test-dom.ts";
import { type EngineFacts, Header, resolveSpendMeter, showsPauseChip, spendBarMax } from "./Header.tsx";

registerRealDom();

const panelsCss = readFileSync(new URL("../panels.css", import.meta.url), "utf8");
const tokensCss = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
const appCss = readFileSync(new URL("../app.css", import.meta.url), "utf8");
// #886 gate② run 2e566ac9 finding [3]: `.spend-meter-value` declares no font-size of its own —
// it inherits `body`'s (app.css, driven by tokens.css's `--text-0`). The first cut of this test
// injected only `panelsCss`, leaving happy-dom's own 16px default in play instead of production's
// real 13px, so its "exact" computed letter-spacing (0.32px = 0.02em × 16px) didn't match what
// actually ships (0.02em × 13px = 0.26px). Extracted (not hand-copied) straight from the real
// `body { ... }` rule in app.css so this can't silently desync from the real cascade.
const bodyFontSizeRule = appCss.match(/body\s*\{[^}]*\}/)?.[0];

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

// #766 gate② finding [1]: the `round` prop (replay's honest, correctly-scoped reading) always
// wins over `spend`'s run/daily tiers when present — the header's own title attribute names the
// tier explicitly, so a reader (and a test) can tell "round spend" apart from "run"/"daily".
test("the `round` prop wins outright over `spend` — renders the round figures, never the run/daily pair also passed", () => {
  const html = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={{ runUsd: 999, runBudgetUsd: 999, todayUsd: 999, dailyBudgetUsd: 999 }}
      round={{ usedUsd: 12.5, budgetUsd: 250 }}
      parked={false}
    />,
  );
  assert.match(html, /\$12\.50/);
  assert.match(html, /\$250/);
  assert.doesNotMatch(html, /999/, "the run/daily spend passed alongside round must never leak through");
  assert.match(html, /title="round spend"/, "the meter must be explicitly labeled 'round', never conflated with run/daily");
});

test("no `round` prop: the meter falls back to the ordinary run/daily resolution, unaffected", () => {
  const html = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={{ runUsd: 5, runBudgetUsd: 50, todayUsd: 1, dailyBudgetUsd: 10 }}
      parked={false}
    />,
  );
  assert.match(html, /title="run spend"/);
});

// ── #890 (§3 E): the capsule bar — settled solid + hatched est tail, `header-dark.png` ─────────

test("spendBarMax is the tier's own budget, 0 (no ceiling to measure against) when unset", () => {
  assert.equal(spendBarMax({ tier: "daily", usedUsd: 10, budgetUsd: 100 }), 100);
  assert.equal(spendBarMax({ tier: "daily", usedUsd: 10, budgetUsd: null }), 0);
});

test("the meter renders '$used + $est est / $budget' and the shared CostBar, matching header-dark.png's text line", () => {
  const html = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={{ runUsd: 10.4, runBudgetUsd: 100, todayUsd: 999, dailyBudgetUsd: 999 }}
      estUsd={2.2}
      parked={false}
    />,
  );
  assert.match(html, /\$10\.40 \+ \$2\.20 est \/ \$100\.00/);
  assert.match(html, /class="cost-bar spend-meter-bar"/);
});

test("the est tail renders hatched — the shared cost-bar-est-hatch pattern, never a second hand-rolled texture", () => {
  const html = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={{ runUsd: 10.4, runBudgetUsd: 100, todayUsd: 0, dailyBudgetUsd: 0 }}
      estUsd={2.2}
      parked={false}
    />,
  );
  assert.match(html, /url\(#cost-bar-est-hatch\)/);
});

test("no estUsd (replay/demo, or a live snapshot with no running lane): no ' + est' text, no hatch segment", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={false} />,
  );
  assert.doesNotMatch(html, / est/);
  assert.doesNotMatch(html, /url\(#cost-bar-est-hatch\)/);
});

test("a null usedUsd (a run tier with runBudgetUsd set but runUsd not yet computed) renders no bar at all, never a bar with a fabricated 0", () => {
  const html = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={{ runUsd: null, runBudgetUsd: 100, todayUsd: 0, dailyBudgetUsd: null }}
      parked={false}
    />,
  );
  assert.doesNotMatch(html, /class="cost-bar/);
});

test("a null budgetUsd on `round` (artifact-less round) renders the used amount alone, no '/ $x' suffix", () => {
  const html = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={SPEND_OK}
      round={{ usedUsd: 3.14, budgetUsd: null }}
      parked={false}
    />,
  );
  assert.match(html, /\$3\.14/);
  assert.doesNotMatch(html, /\$3\.14 \//);
});

// #886 gate② run 2e566ac9 finding [3]: mounts the REAL production cascade (`tokensCss` for
// `--text-0`, the extracted real `body { font-size: var(--text-0) }` rule, then `panelsCss`) —
// not just `panelsCss` alone, which left happy-dom at its own 16px default instead of the
// element's real inherited 13px. `.spend-meter-value` declares no font-size of its own, so
// happy-dom's em-resolution against an INHERITED font-size (as opposed to one declared in the
// SAME rule as letter-spacing — see `.hero-phase`'s paired fix, hero.test.ts) is trustworthy
// here, verified by direct reproduction: both properties are asserted at their exact computed
// value against 13px, not just "applied".
test("#879 gate② run 2e566ac9 finding [3]: the spend meter value renders bold at the exact shipped weight/letter-spacing, proven against the REAL production cascade (tokens.css + app.css's body rule + panels.css)", () => {
  assert.ok(bodyFontSizeRule, "app.css must still declare a body { ... } rule for tokensCss/panelsCss to cascade through");
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${bodyFontSizeRule}\n${panelsCss}`;
  document.head.appendChild(style);
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={false} />,
  );
  document.body.appendChild(container);
  try {
    const valueEl = container.querySelector(".spend-meter-value");
    assert.ok(valueEl, "a real .spend-meter-value element must render and match the injected stylesheet's selector");
    const computed = getComputedStyle(valueEl as Element);
    assert.equal(computed.fontSize, "13px", "sanity check: the real body-cascaded font-size the letter-spacing assertion below depends on");
    assert.equal(
      computed.fontWeight,
      "600",
      "the cascade must actually apply the bold weight to the rendered element, not just declare it in source",
    );
    assert.equal(
      computed.letterSpacing,
      "0.26px",
      "0.02em against the REAL inherited 13px body font-size — the exact shipped value, not a stand-in environment's 0.32px",
    );
  } finally {
    document.body.removeChild(container);
    document.head.removeChild(style);
  }

  const match = panelsCss.match(/\.spend-meter-value\s*\{([^}]*)\}/);
  assert.ok(match, ".spend-meter-value rule must exist");
  const body = match?.[1] as string;
  assert.match(body, /font-weight:\s*600/);
  assert.match(body, /letter-spacing:\s*0\.02em\b/, "pin the exact shipped value — not a wildcard letter-spacing check");
});

// ── #889: Header wires the round navigator's own props straight through, unedited ─────────────

test("Header wires selectedRoundId/liveRoundId through to the round navigator pill", () => {
  const live = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={SPEND_OK}
      parked={false}
      rounds={[]}
      selectedRoundId={null}
      liveRoundId={12}
    />,
  );
  assert.match(live, /round-nav-pill/);
  assert.match(live, />round 12 · live</);

  const closed = renderToStaticMarkup(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={SPEND_OK}
      parked={false}
      rounds={[]}
      selectedRoundId={9}
      liveRoundId={null}
    />,
  );
  assert.match(closed, /round-nav-pill-closed/);
  assert.match(closed, />round 9 · closed</);
});

test("does not render, import, or re-implement the legend", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={false} />,
  );
  assert.doesNotMatch(html, /droplet = an issue moving through the loop/);
  assert.doesNotMatch(html, /aria-label="Legend"/);
});
