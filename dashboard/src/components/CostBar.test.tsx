import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostBar, HATCH_PATTERN_ID } from "./CostBar.tsx";

// #924 AC2: the settled fill is a `<rect width="{pct}%">`, a percentage length the browser
// resolves against the SVG's own real rendered width (no `viewBox`) — never a hand-computed
// pixel/user-unit value.
test("settled-only bar draws a solid fill sized to settledUsd/max, no hatch segment", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} max={10} label="lane" />);
  assert.match(html, /class="cost-bar-fill" x="0"[^>]*width="50%"/);
  assert.doesNotMatch(html, new RegExp(`url\\(#${HATCH_PATTERN_ID}\\)`));
});

test("settled + est draws the est tail immediately after the settled fill, hatched", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} estUsd={2} max={10} label="lane" />);
  // settled: 0 -> 40%; est: 40% -> 60% (width 20%)
  assert.match(html, /class="cost-bar-fill" x="0"[^>]*width="40%"/);
  assert.match(html, new RegExp(`x="40%"[^>]*width="20%"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`));
});

test("est is clamped so the total never draws past 100% of the track", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={9} estUsd={5} max={10} label="lane" />);
  // settled: 90%; est would be 50% more (140% total) -> clamped tail is 10% wide, ending at 100%.
  assert.match(html, /class="cost-bar-fill" x="0"[^>]*width="90%"/);
  assert.match(html, new RegExp(`x="90%"[^>]*width="10%"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`));
});

test("zero/absent est renders no hatch rect at all — never a phantom zero-width segment", () => {
  const zero = renderToStaticMarkup(<CostBar settledUsd={5} estUsd={0} max={10} label="lane" />);
  const absent = renderToStaticMarkup(<CostBar settledUsd={5} max={10} label="lane" />);
  assert.doesNotMatch(zero, new RegExp(`url\\(#${HATCH_PATTERN_ID}\\)`));
  assert.doesNotMatch(absent, new RegExp(`url\\(#${HATCH_PATTERN_ID}\\)`));
});

// #924 AC2: a zero (or negative-clamped-to-zero) settled share renders no fill rect at all — the
// SAME "never a phantom segment" contract the est hatch tail already has.
test("max <= 0 renders no fill rect at all, never NaN/Infinity and never a phantom zero-width pill", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} estUsd={2} max={0} label="lane" />);
  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /Infinity/);
  assert.doesNotMatch(html, /class="cost-bar-fill"/);
});

test("aria-label discloses both figures when an est is present, settled only otherwise", () => {
  const withEst = renderToStaticMarkup(<CostBar settledUsd={4} estUsd={2} max={10} label="Lanes" />);
  assert.match(withEst, /aria-label="Lanes: \$4\.00 \+ \$2\.00 est"/);
  const settledOnly = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="Lanes" />);
  assert.match(settledOnly, /aria-label="Lanes: \$4\.00"/);
});

test("the hatch pattern def is a real SVG <pattern>, not a decorative rect — the shared texture, never color alone", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} estUsd={2} max={10} label="lane" />);
  assert.match(html, /<pattern[^>]*id="cost-bar-est-hatch"/);
  assert.match(html, /patternUnits="userSpaceOnUse"/);
});

test("the target tick renders at the given coordinate, same contract as the pre-existing cost-panel bar", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} targetPct={70} label="lane" />);
  assert.match(html, /x1="70%"/);
});

test("no target tick renders when targetPct is null", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  assert.doesNotMatch(html, /cost-bar-target/);
});

// ── #924 AC2: the hairline-bar grammar's own geometry ───────────────────────────────────────────

// #924 AC2: the track is a full-width line at a fixed local Y — width comes from a plain "100%"
// SVG length, not a hand-computed value, so it always spans the bar's own real rendered box.
test("AC2: the track is a full-width line at a fixed Y, regardless of the settled fill", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  assert.match(html, /<line class="cost-bar-track" x1="0" y1="5\.5" x2="100%" y2="5\.5">/);
});

// #924 AC2: the fill is a real rounded RECT (`rx` = half its own `height`) — both attributes are
// plain SVG geometry, provable directly from the rendered markup here (no CSS cascade needed, the
// way the previous stroked-line design's `stroke-width`/`stroke-linecap` required a real DOM to
// resolve). `rx` = 3 is exactly `FILL_HEIGHT / 2` (CostBar.tsx) — a true semicircle at both ends,
// fully inside the rect's own x/width box at every settled percentage, 0 through 100 (a rounded
// CORNER never bulges past its own bounds, unlike a stroked line's round LINECAP past its
// endpoint) — so no viewBox/scale-compensation machinery is needed to keep it contained.
test("AC2: the fill rect is 6px tall with rx=3 — a true semicircle cap fully inside its own box", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  const fillMatch = html.match(/class="cost-bar-fill"[^>]*height="([\d.]+)"[^>]*rx="([\d.]+)"/);
  assert.ok(fillMatch, "the fill rect must declare both height and rx");
  const height = Number(fillMatch![1]);
  const rx = Number(fillMatch![2]);
  assert.equal(height, 6, "the pill's own rendered height");
  assert.equal(rx, height / 2, "rx must be exactly half the fill's own height — a true pill radius");
});

test("AC2: the target tick's own span (y1=1, y2=11 — height 10) is a fixed constant, unaffected by the settled amount", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} targetPct={50} label="lane" />);
  const tickMatch = html.match(/class="cost-bar-target"[^>]*y1="([\d.]+)"[^>]*y2="([\d.]+)"/);
  assert.ok(tickMatch, "the target tick must render");
  const tickHeight = Math.abs(Number(tickMatch![2]) - Number(tickMatch![1]));
  assert.equal(tickHeight, 10, "the tick spans a fixed 10px, taller than the fill's own 6px height");
});
