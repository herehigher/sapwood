import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import type { EngineState } from "../api/types.ts";
// #892: must resolve before "./Header.tsx" (transitively imports Radix, via HintTooltip.tsx) —
// see this module's own doc for why. Replaces registerRealDom() (this file needs real focus
// interaction now, not just a real `document` for getComputedStyle).
import { unregisterRealDomEager } from "../test-dom-eager.ts";
import { type EngineFacts, Header, resolveSpendMeter, showsPauseChip, spendBarMax } from "./Header.tsx";

test.after(() => unregisterRealDomEager());

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

// #895 item 3: §5 assigns healthy-engine to --moss, not --sap (the "in motion" token this dot was
// hard-wired to). Every earlier return (disconnected, connecting) has already exited by the time
// this dot renders, so reaching it always means a live, reachable engine — a single unconditional
// token, not a state-dependent one.
test("#895 item 3: the engine status dot renders --moss (the healthy-engine token), never --sap", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={false} />,
  );
  assert.match(html, /class="feed-dot" style="background:var\(--moss\)"/);
  assert.doesNotMatch(html, /class="feed-dot" style="background:var\(--sap\)"/);
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
// wins over `spend`'s run/daily tiers when present — the meter's own tooltip names the tier
// explicitly, so a reader (and a test) can tell "round spend" apart from "run"/"daily".
// #892: the tier label moved from a bare `title=` (static-markup-visible) to a Radix tooltip
// (only visible/queryable on real focus) — see the real-DOM tests at the end of this file for
// the "round spend"/"run spend" tier-label proofs.
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
  assert.match(html, /url\(#[^)]*cost-bar-est-hatch\)/);
});

test("no estUsd (replay/demo, or a live snapshot with no running lane): no ' + est' text, no hatch segment", () => {
  const html = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={false} />,
  );
  assert.doesNotMatch(html, / est/);
  assert.doesNotMatch(html, /url\(#[^)]*cost-bar-est-hatch\)/);
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

// ── #1025: mid-width deterministic stacking + dropped spend-meter capsule outline ──────────────

/** Shared setup for the viewport tests below — real cascade (tokens + panels + app), a real
 *  happy-dom viewport, `.engine-status`'s own flex-wrap, `.round-nav-pill`'s white-space, and the
 *  meter's own shrink rule, at a given width. STYLE doctrine (engine/prompts/doctrine-core.md): needs a
 *  real viewport + getComputedStyle read against the full production cascade, never a regex read
 *  of the source text — same posture Controls.test.tsx's own #895 item 6 test already established
 *  for the sibling 720px floor. */
function readHeaderLayout(viewportWidth: number): {
  flexWrap: string;
  lineFlexBasis: string;
  pillWhiteSpace: string;
  meterFlexGrow: string;
  meterFlexShrink: string;
  meterFlexBasis: string;
  meterMinWidth: string;
  barWidth: string;
  barMaxWidth: string;
} {
  (window as unknown as { happyDOM: { setViewport: (v: { width: number }) => void } }).happyDOM.setViewport({
    width: viewportWidth,
  });
  const container = document.createElement("div");
  container.innerHTML = renderToStaticMarkup(
    <Header disconnected={false} isPending={false} engine={engine("running")} spend={SPEND_OK} parked={false} />,
  );
  document.body.appendChild(container);
  try {
    const status = container.querySelector(".engine-status");
    const line = container.querySelector(".engine-status-line");
    const pill = container.querySelector(".round-nav-pill");
    const meter = container.querySelector(".spend-meter");
    const bar = container.querySelector(".spend-meter-bar");
    assert.ok(
      status && line && pill && meter && bar,
      ".engine-status, .engine-status-line, .round-nav-pill, .spend-meter, and .spend-meter-bar must all render",
    );
    const meterComputed = getComputedStyle(meter as Element);
    const barComputed = getComputedStyle(bar as Element);
    return {
      flexWrap: getComputedStyle(status as Element).flexWrap,
      lineFlexBasis: getComputedStyle(line as Element).flexBasis,
      pillWhiteSpace: getComputedStyle(pill as Element).whiteSpace,
      meterFlexGrow: meterComputed.flexGrow,
      meterFlexShrink: meterComputed.flexShrink,
      meterFlexBasis: meterComputed.flexBasis,
      meterMinWidth: meterComputed.minWidth,
      barWidth: barComputed.width,
      barMaxWidth: barComputed.maxWidth,
    };
  } finally {
    document.body.removeChild(container);
  }
}

// #1025: LIVE mode's own Controls verbs (up to and including EMERGENCY STOP) + "?" legend push
// the row's real natural width close to 1400px (see panels.css's own arithmetic comment) — 1400px
// is the floor.
test("#1025 AC1/AC2: .engine-status wraps with .engine-status-line as its own full-width line at/below the 1400px floor; the row stays unbroken above it", () => {
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${appCss}`;
  document.head.appendChild(style);
  try {
    // Above the floor: happy-dom's CSSOM-only getComputedStyle reports an undeclared property as
    // "", not the resolved initial value — this only confirms the media rule hasn't fired early
    // (same posture Controls.test.tsx's #895 item 6 test documents for its own 720px sibling).
    assert.notEqual(readHeaderLayout(1440).flexWrap, "wrap", "well above the floor (AC2), the mid-width rule must not have fired early");
    assert.notEqual(readHeaderLayout(1401).flexWrap, "wrap", "one px above the floor (AC2), the media query must not have fired yet");

    // 995/1024/1200/1300 are all inside the wrapped range this rule now covers — 1200 is the
    // owner walk's own live-mode reference width from panels.css's own breakpoint arithmetic.
    for (const width of [1400, 1300, 1200, 1024, 995]) {
      const layout = readHeaderLayout(width);
      assert.equal(layout.flexWrap, "wrap", `at ${width}px, .engine-status must wrap`);
      assert.equal(layout.lineFlexBasis, "100%", `at ${width}px, .engine-status-line must claim the full first line`);
    }
  } finally {
    document.head.removeChild(style);
  }
});

test("#1025 AC1: .round-nav-pill resolves white-space: nowrap at 995px and 1024px — the stepper label never wraps", () => {
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${appCss}`;
  document.head.appendChild(style);
  try {
    for (const width of [995, 1024]) {
      assert.equal(readHeaderLayout(width).pillWhiteSpace, "nowrap", `at ${width}px, .round-nav-pill must resolve white-space: nowrap`);
    }
  } finally {
    document.head.removeChild(style);
  }
});

// #1025: a multi-line flex container decides which line an item lands on using that item's flex
// BASE size, not its shrunk result — shrinking only happens AFTER placement. 200px is a base size
// small enough that stepper + BACK TO LIVE + the meter fit together on line 2 at 995px replay;
// `flex-grow: 1` then expands the meter back out from there (panels.css's own comment has the
// full page-measured numbers). `.spend-meter-bar` follows its now-flexible parent (`width: 100%`,
// capped at its authored `max-width: 400px`).
test("#1025: at 995px the meter is a genuinely shrinkable flex item with a 200px base size — flex: 1 1 200px, min-width: 0, bar width: 100%/max-width: 400px", () => {
  const style = document.createElement("style");
  style.textContent = `${tokensCss}\n${panelsCss}\n${appCss}`;
  document.head.appendChild(style);
  try {
    const layout = readHeaderLayout(995);
    assert.equal(layout.meterFlexGrow, "1", "at 995px, .spend-meter must be allowed to grow");
    assert.equal(layout.meterFlexShrink, "1", "at 995px, .spend-meter must be allowed to shrink below its base size");
    assert.equal(
      layout.meterFlexBasis,
      "200px",
      "at 995px, .spend-meter's flex BASE size must be small enough for the item to land on line 2 at all",
    );
    assert.equal(layout.meterMinWidth, "0", "at 995px, .spend-meter must not have an implicit shrink floor");
    assert.equal(layout.barWidth, "100%", "at 995px, .spend-meter-bar tracks its now-flexible parent, not a fixed 400px");
    assert.equal(layout.barMaxWidth, "400px", "at 995px, .spend-meter-bar still never exceeds its authored 400px when there's room");
  } finally {
    document.head.removeChild(style);
  }
});

// AC3: the outlined capsule border (superseded #923 D16) is gone from source, not merely
// unasserted — VALUE-family check, same posture the `.spend-meter-value` source check above uses.
test("#1025 AC3: .spend-meter-bar declares no border/outline of its own — the CostBar track pill is the capsule now", () => {
  const match = panelsCss.match(/\.spend-meter-bar\s*\{([^}]*)\}/);
  assert.ok(match, ".spend-meter-bar rule must exist");
  const ruleBody = match?.[1] as string;
  assert.doesNotMatch(ruleBody, /border/, ".spend-meter-bar must declare no border property at all");
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

// ── #892 AC1: the spend-meter tooltip (was a bare `title=`) is a real Radix tooltip now — Tab-
// reachable, tier label visible/queryable on focus. ──────────────────────────────────────────

async function focusSpendMeter(element: React.ReactElement): Promise<{ trigger: HTMLElement; tooltipText: string | null | undefined }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(element);
    });
    const trigger = container.querySelector(".spend-meter") as HTMLElement;
    assert.ok(trigger, "the spend-meter trigger renders");
    assert.equal(trigger.tabIndex, 0, "must be a real tab stop — a <div> isn't focusable by default");
    await act(async () => {
      trigger.focus();
    });
    return { trigger, tooltipText: container.querySelector('[role="tooltip"]')?.textContent };
  } finally {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  }
}

test("real DOM: the `round` prop's meter tooltip is explicitly labeled 'round spend', never conflated with run/daily", async () => {
  const { tooltipText } = await focusSpendMeter(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={{ runUsd: 999, runBudgetUsd: 999, todayUsd: 999, dailyBudgetUsd: 999 }}
      round={{ usedUsd: 12.5, budgetUsd: 250 }}
      parked={false}
    />,
  );
  assert.equal(tooltipText, "round spend");
});

test("real DOM: no `round` prop falls back to the run tier's own tooltip label", async () => {
  const { tooltipText } = await focusSpendMeter(
    <Header
      disconnected={false}
      isPending={false}
      engine={engine("running")}
      spend={{ runUsd: 5, runBudgetUsd: 50, todayUsd: 1, dailyBudgetUsd: 10 }}
      parked={false}
    />,
  );
  assert.equal(tooltipText, "run spend");
});
