import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostBar, HATCH_PATTERN_ID } from "./CostBar.tsx";

// #924 AC2: the settled fill is a `<line x1="0" x2={settledPct}>` (panels.css's own
// `stroke-linecap: round` pill), not a `<rect width>` — `x2` carries the same percentage `width`
// used before.
test("settled-only bar draws a solid fill sized to settledUsd/max, no hatch segment", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} max={10} label="lane" />);
  assert.match(html, /class="cost-bar-fill" x1="0"[^>]*x2="50"/);
  assert.doesNotMatch(html, new RegExp(`url\\(#${HATCH_PATTERN_ID}\\)`));
});

test("settled + est draws the est tail immediately after the settled fill, hatched", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} estUsd={2} max={10} label="lane" />);
  // settled: 0 -> 40%; est: 40% -> 60% (width 20)
  assert.match(html, /class="cost-bar-fill" x1="0"[^>]*x2="40"/);
  assert.match(html, new RegExp(`x="40"[^>]*width="20"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`));
});

test("est is clamped so the total never draws past 100% of the track", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={9} estUsd={5} max={10} label="lane" />);
  // settled: 90%; est would be 50% more (140% total) -> clamped tail is 10% wide, ending at 100.
  assert.match(html, /class="cost-bar-fill" x1="0"[^>]*x2="90"/);
  assert.match(html, new RegExp(`x="90"[^>]*width="10"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`));
});

test("zero/absent est renders no hatch rect at all — never a phantom zero-width segment", () => {
  const zero = renderToStaticMarkup(<CostBar settledUsd={5} estUsd={0} max={10} label="lane" />);
  const absent = renderToStaticMarkup(<CostBar settledUsd={5} max={10} label="lane" />);
  assert.doesNotMatch(zero, new RegExp(`url\\(#${HATCH_PATTERN_ID}\\)`));
  assert.doesNotMatch(absent, new RegExp(`url\\(#${HATCH_PATTERN_ID}\\)`));
});

// #924 AC2: a zero (or negative-clamped-to-zero) settled share renders NEITHER fill line at all —
// the SAME "never a phantom segment" contract the est hatch tail already has, and necessary here
// specifically: a zero-length `stroke-linecap: round` line renders a filled DOT in a real browser,
// which would be a phantom mark at the bar's own start for an unsettled lane.
test("max <= 0 renders no fill line at all, never NaN/Infinity and never a phantom zero-length dot", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} estUsd={2} max={0} label="lane" />);
  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /Infinity/);
  assert.doesNotMatch(html, /class="cost-bar-fill"/);
  assert.doesNotMatch(html, /class="cost-bar-fill-outline"/);
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
  assert.match(html, /x1="70"/);
});

test("no target tick renders when targetPct is null", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  assert.doesNotMatch(html, /cost-bar-target/);
});

// ── #924 AC2: the hairline-bar grammar's own geometry ───────────────────────────────────────────

// #924 AC2: the track is a STROKED line, not a filled rect (`vector-effect: non-scaling-stroke`,
// panels.css, keeps its 1px width crisp under the bar's own non-uniform scaling) — full-width, at
// a fixed local-unit Y regardless of the settled fill.
test("AC2: the track is a full-width line at a fixed Y, its own width fixed via CSS (not a fill rect)", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  assert.match(html, /<line class="cost-bar-track" x1="0" y1="5\.5" x2="100" y2="5\.5">/);
});

// #924 AC2: the fill's own height/pill-radius are not SVG attributes on the element (a `rect`'s
// `rx`/`height`) — they're `stroke-width: 6` + `stroke-linecap: round` on `.cost-bar-fill`
// (panels.css), since a round LINECAP is what keeps the cap a true circle under the bar's
// non-uniform scale (a plain `rx`, fill geometry, is never protected by `vector-effect`). This
// file has no real DOM (`renderToStaticMarkup` only, no CSS cascade), so the STYLE-testable half
// of this fact (that `stroke-width`/`stroke-linecap`/`vector-effect` actually resolve on a real
// rendered element) lives in App.test.tsx's "AC2 (pill end caps)" STYLE test instead — this file
// only proves the two lines (pill + its wider outline) both render at the correct x1/x2 span,
// which the tests above already do.
test("AC2: the fill line and its outline line both render at the same x1/x2 span as each other", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  const fillMatch = html.match(/class="cost-bar-fill" x1="([\d.]+)"[^>]*x2="([\d.]+)"/);
  const outlineMatch = html.match(/class="cost-bar-fill-outline" x1="([\d.]+)"[^>]*x2="([\d.]+)"/);
  assert.ok(fillMatch && outlineMatch, "both the pill's own fill line and its outline line must render");
  assert.deepEqual(fillMatch!.slice(1), outlineMatch!.slice(1), "the outline must span the EXACT same x1/x2 as the pill it outlines");
});

test("AC2: the target tick's own span (y1=1, y2=11 — height 10) is a fixed constant, unaffected by the settled amount", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} targetPct={50} label="lane" />);
  const tickMatch = html.match(/class="cost-bar-target"[^>]*y1="([\d.]+)"[^>]*y2="([\d.]+)"/);
  assert.ok(tickMatch, "the target tick must render");
  const tickHeight = Math.abs(Number(tickMatch![2]) - Number(tickMatch![1]));
  assert.equal(
    tickHeight,
    10,
    "the tick spans a fixed 10 local units — see App.test.tsx's own STYLE test for the >6 (fill's stroke-width) comparison",
  );
});
