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

// #924 AC2: the hatch tail's own `x`/`width` are CSS geometry properties (via `style`, not plain
// attributes — SVG presentation attributes don't support `calc()`), extended `FILL_RADIUS` (3px)
// px BACKWARD under the pill's own curved cap so the pill (rendered on top — see the DOM-order
// test below) covers the seam cleanly, with no gap where the cap's `rx` corner recedes inward.
// Extending backward only moves the LEADING edge; the trailing edge (at the settled+est total)
// is exactly `width` further right, unaffected — `40% - 3px` to `40% - 3px + (20% + 3px)` = `60%`.
// `max(0px, ...)`/`min(3px, N%)` are the general clamp form (see the sub-3px test below for why) —
// at a settled share comfortably wider than 3px, they're inert: `max(0px, positive)` = the
// positive value, `min(3px, wide%)` = 3px, exactly the unclamped arithmetic.
test("settled + est draws the est tail immediately after the settled fill, hatched, extended 3px back under the pill's own cap", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} estUsd={2} max={10} label="lane" />);
  // settled: 0 -> 40%; est: 40% -> 60% (width 20%), tail's own leading edge pulled back 3px.
  assert.match(html, /class="cost-bar-fill" x="0"[^>]*width="40%"/);
  assert.match(
    html,
    new RegExp(
      `style="x:max\\(0px, calc\\(40% - 3px\\)\\);width:calc\\(20% \\+ min\\(3px, 40%\\)\\)"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`,
    ),
  );
});

test("est is clamped so the total never draws past 100% of the track", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={9} estUsd={5} max={10} label="lane" />);
  // settled: 90%; est would be 50% more (140% total) -> clamped tail is 10% wide, ending at 100%.
  assert.match(html, /class="cost-bar-fill" x="0"[^>]*width="90%"/);
  assert.match(
    html,
    new RegExp(
      `style="x:max\\(0px, calc\\(90% - 3px\\)\\);width:calc\\(10% \\+ min\\(3px, 90%\\)\\)"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`,
    ),
  );
});

// #924 AC2: at 0% settled (no pill exists to cover a backward extension), the hatch tail's own
// leading edge clamps back to exactly 0% — the general `max(0px, calc(0% - 3px))` form always
// resolves non-negative, so this is the SAME clamp mechanism as the sub-3px case below, not a
// separate branch. Extending unclamped here would overshoot the bar's own left edge with nothing
// hiding the seam (the box is `overflow: visible` now, so an unhidden extension there would be a
// real, visible defect, not just a harmless 0.5px stroke straddle).
test("est-only (0% settled, no pill to cover a seam) renders the hatch tail clamped to exactly 0%", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={0} estUsd={5} max={10} label="lane" />);
  assert.doesNotMatch(html, /class="cost-bar-fill"/, "no settled amount -> no pill at all");
  assert.match(
    html,
    new RegExp(
      `style="x:max\\(0px, calc\\(0% - 3px\\)\\);width:calc\\(50% \\+ min\\(3px, 0%\\)\\)"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`,
    ),
  );
});

// #924 AC2 (Codex re-read, ec33d5b): a settled share NARROWER than FILL_RADIUS (a pill under 3px
// wide, not just absent) hits the SAME failure mode 0% did before the clamp existed — the raw
// `calc(0.1% - 3px)` is still negative (0.1% of any real container width is nowhere near 3px), and
// `.cost-bar`'s own `overflow: visible` means that negative x now actually PAINTS past the bar's
// own left edge instead of quietly clipping there. `max(0px, ...)` pins the leading edge at 0
// regardless of how narrow the settled share is; `min(3px, 0.1%)` shrinks the matching width
// extension so the trailing edge (at the settled+est total) still lands unaffected.
test("a sub-3px settled share (0.1%) still clamps the hatch tail's leading edge to 0px, never negative", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={0.01} estUsd={5} max={10} label="lane" />);
  assert.match(html, /class="cost-bar-fill" x="0"[^>]*width="0\.1%"/, "a real, if tiny, pill still renders");
  assert.match(
    html,
    new RegExp(
      `style="x:max\\(0px, calc\\(0\\.1% - 3px\\)\\);width:calc\\(50% \\+ min\\(3px, 0\\.1%\\)\\)"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`,
    ),
  );
});
// #924 AC2: the hatch renders BEFORE the pill in DOM/paint order — SVG paints in document order,
// so the pill's own opaque fill, painted second, sits ON TOP and covers the seam; the reverse
// order would let the hatch's flat edge cut a visible notch into the pill's curved cap instead.
test("AC2: the hatch tail renders before the pill in document order, so the pill's opaque fill paints on top of the seam", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} estUsd={2} max={10} label="lane" />);
  const hatchIndex = html.indexOf(HATCH_PATTERN_ID, html.indexOf("</defs>"));
  const fillIndex = html.indexOf('class="cost-bar-fill"');
  assert.ok(hatchIndex > -1 && fillIndex > -1, "both the hatch tail and the pill must render");
  assert.ok(hatchIndex < fillIndex, "the hatch tail must appear before the pill in the rendered markup");
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
