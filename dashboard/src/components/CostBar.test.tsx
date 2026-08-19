import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostBar, HATCH_PATTERN_ID_SUFFIX } from "./CostBar.tsx";

// Each `<CostBar>` instance now mints its own pattern id (`useId()` + the shared suffix) so its
// `fill="url(#…)"` resolves to ITS OWN `<pattern>`, never another instance's — see CostBar.tsx.
// These helpers match by the shared SUFFIX rather than a single hardcoded id, since the exact
// per-render prefix is a React implementation detail these tests must not pin.
const HATCH_FILL_URL_RE = new RegExp(`url\\(#[^)]*${HATCH_PATTERN_ID_SUFFIX}\\)`);

// #924 AC2: the settled fill is a `<rect width="{pct}%">`, a percentage length the browser
// resolves against the SVG's own real rendered width (no `viewBox`) — never a hand-computed
// pixel/user-unit value.
test("settled-only bar draws a solid fill sized to settledUsd/max, no hatch segment", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} max={10} label="lane" />);
  assert.match(html, /class="cost-bar-fill" x="0"[^>]*width="50%"/);
  assert.doesNotMatch(html, HATCH_FILL_URL_RE);
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
      `style="x:max\\(0px, calc\\(40% - 3px\\)\\);width:calc\\(20% \\+ min\\(3px, 40%\\)\\)"[^>]*fill="url\\(#[^)]*${HATCH_PATTERN_ID_SUFFIX}\\)"`,
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
      `style="x:max\\(0px, calc\\(90% - 3px\\)\\);width:calc\\(10% \\+ min\\(3px, 90%\\)\\)"[^>]*fill="url\\(#[^)]*${HATCH_PATTERN_ID_SUFFIX}\\)"`,
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
      `style="x:max\\(0px, calc\\(0% - 3px\\)\\);width:calc\\(50% \\+ min\\(3px, 0%\\)\\)"[^>]*fill="url\\(#[^)]*${HATCH_PATTERN_ID_SUFFIX}\\)"`,
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
      `style="x:max\\(0px, calc\\(0\\.1% - 3px\\)\\);width:calc\\(50% \\+ min\\(3px, 0\\.1%\\)\\)"[^>]*fill="url\\(#[^)]*${HATCH_PATTERN_ID_SUFFIX}\\)"`,
    ),
  );
});
// #924 AC2: the hatch renders BEFORE the pill in DOM/paint order — SVG paints in document order,
// so the pill's own opaque fill, painted second, sits ON TOP and covers the seam; the reverse
// order would let the hatch's flat edge cut a visible notch into the pill's curved cap instead.
test("AC2: the hatch tail renders before the pill in document order, so the pill's opaque fill paints on top of the seam", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} estUsd={2} max={10} label="lane" />);
  const hatchIndex = html.indexOf(HATCH_PATTERN_ID_SUFFIX, html.indexOf("</defs>"));
  const fillIndex = html.indexOf('class="cost-bar-fill"');
  assert.ok(hatchIndex > -1 && fillIndex > -1, "both the hatch tail and the pill must render");
  assert.ok(hatchIndex < fillIndex, "the hatch tail must appear before the pill in the rendered markup");
});

test("zero/absent est renders no hatch rect at all — never a phantom zero-width segment", () => {
  const zero = renderToStaticMarkup(<CostBar settledUsd={5} estUsd={0} max={10} label="lane" />);
  const absent = renderToStaticMarkup(<CostBar settledUsd={5} max={10} label="lane" />);
  assert.doesNotMatch(zero, HATCH_FILL_URL_RE);
  assert.doesNotMatch(absent, HATCH_FILL_URL_RE);
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
  assert.match(html, new RegExp(`<pattern[^>]*id="[^"]*${HATCH_PATTERN_ID_SUFFIX}"`));
  assert.match(html, /patternUnits="userSpaceOnUse"/);
});

// #1020: no `.cost-bar-target` element ever renders, at any settled amount — the tick is gone
// outright, not just hidden behind a prop default.
test("#1020: no .cost-bar-target ever renders — the roundBudget/6 tick is dropped, not restyled", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  assert.doesNotMatch(html, /cost-bar-target/);
});

// ── #1020: the track — a full-width pill in the SAME geometry as the fill ─────────────────────

// #1020: the track is now a full-width ROUNDED RECT, same `y`/`height`/`rx` grammar `.cost-bar-fill`
// draws (never a hand-computed value of its own) — width comes from a plain "100%" SVG length, so
// it always spans the bar's own real rendered box regardless of the settled fill.
test("#1020: the track is a full-width rounded rect, same height/rx as the fill, regardless of the settled amount", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  const trackMatch = html.match(/class="cost-bar-track"[^>]*y="([\d.]+)"[^>]*width="100%"[^>]*height="([\d.]+)"[^>]*rx="([\d.]+)"/);
  assert.ok(trackMatch, "the track must be a rect spanning 100% width with its own y/height/rx");
  const [, y, height, rx] = trackMatch!;
  assert.equal(Number(height), 6, "track height matches the fill's own 6px");
  assert.equal(Number(rx), Number(height) / 2, "track rx is a true pill radius, same formula as the fill");
  const fillMatch = html.match(/class="cost-bar-fill"[^>]*y="([\d.]+)"/);
  assert.equal(Number(y), Number(fillMatch![1]), "track and fill share the same y — one pill drawn under the other");
});

// #1020: the track paints FIRST (bottom of the stack) — the fill (and any est hatch) must sit
// visually on top of it, since the track is the bar's own full-scale "empty" reference the fill
// covers as it grows, not the other way round.
test("#1020: the track renders before the fill in document order, so the fill paints on top of it", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  const trackIndex = html.indexOf('class="cost-bar-track"');
  const fillIndex = html.indexOf('class="cost-bar-fill"');
  assert.ok(trackIndex > -1 && fillIndex > -1, "both the track and the fill must render");
  assert.ok(trackIndex < fillIndex, "the track must appear before the fill in the rendered markup");
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

// ── #923 (D16): the header spend meter's own taller capsule ────────────────────────────────────

// A caller with no `height` prop must render byte-identical geometry to before the prop
// existed — every pre-#923 shared instance (cost panels, lane cards) omits it.
test("#923: the default (no height prop) renders the exact same 12px geometry as before — height=12, track/fill=6/rx=3", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} max={10} label="lane" />);
  assert.match(html, /<svg width="100%" height="12"/);
  assert.match(html, /class="cost-bar-track"[^>]*width="100%"[^>]*height="6"[^>]*rx="3"/);
  assert.match(html, /class="cost-bar-fill"[^>]*height="6"[^>]*rx="3"/);
});

// #923 AC1: the header spend meter passes `height={20}` (D16's "~400×20 outlined capsule") — the
// track/fill geometry scales proportionally (20/12 = 1.667×) rather than staying the 12px drawing
// floating in extra blank space a bare CSS height override would leave.
test("#923: a taller height scales every coordinate proportionally, not just the outer box", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} estUsd={2} max={10} label="lane" height={20} />);
  assert.match(html, /<svg width="100%" height="20"/);
  const trackMatch = html.match(/class="cost-bar-track"[^>]*y="([\d.]+)"[^>]*width="100%"[^>]*height="([\d.]+)"[^>]*rx="([\d.]+)"/);
  assert.equal(Number(trackMatch?.[1]), 3 * (20 / 12), "track y scales");
  assert.equal(Number(trackMatch?.[2]), 6 * (20 / 12), "track height scales");
  assert.equal(Number(trackMatch?.[3]), Number(trackMatch?.[2]) / 2, "track rx stays half the (now taller) track height");
  const fillMatch = html.match(/class="cost-bar-fill"[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"[^>]*rx="([\d.]+)"/);
  assert.equal(Number(fillMatch?.[1]), 3 * (20 / 12), "fill y scales");
  assert.equal(Number(fillMatch?.[2]), 6 * (20 / 12), "fill height scales");
  assert.equal(Number(fillMatch?.[3]), Number(fillMatch?.[2]) / 2, "rx stays half the (now taller) fill height");
});

// ── #1025 (gate② P3): `flush` — the header capsule fills its own box, no centered-pill margin ──

// Omitting `flush` must render BYTE-IDENTICAL geometry to #923's own scaled-centered-pill grammar
// above — this prop is opt-in, every pre-#1025 call site (cost panels, lane cards) never passes it.
test("#1025: without `flush`, a tall bar still renders the scaled-centered-pill geometry, not the full box", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} max={10} label="lane" height={20} />);
  const trackMatch = html.match(/class="cost-bar-track"[^>]*y="([\d.]+)"[^>]*width="100%"[^>]*height="([\d.]+)"[^>]*rx="([\d.]+)"/);
  assert.ok(trackMatch, "the track must render");
  assert.equal(Number(trackMatch?.[1]), 3 * (20 / 12), "unflushed track y still centers within the 20px box");
  assert.equal(Number(trackMatch?.[2]), 6 * (20 / 12), "unflushed track height stays the scaled 10px pill, not the full 20px box");
});

// #1025: `flush` makes the track, fill, AND the hatch tail all cover the full `height` box — the
// header spend meter's only remaining visible shape once #923 D16's outer capsule outline is
// dropped (panels.css), so a centered pill floating inside extra transparent canvas would no
// longer read as a capsule at all.
test("#1025: `flush` fills the FULL box — y=0, height=height, rx=height/2 — for the track, fill, and hatch tail alike", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} estUsd={2} max={10} label="lane" height={20} flush />);

  const trackMatch = html.match(/class="cost-bar-track"[^>]*y="([\d.]+)"[^>]*width="100%"[^>]*height="([\d.]+)"[^>]*rx="([\d.]+)"/);
  assert.ok(trackMatch, "the track must render");
  assert.equal(Number(trackMatch?.[1]), 0, "flush track y is 0 — no transparent margin above it");
  assert.equal(Number(trackMatch?.[2]), 20, "flush track height fills the full 20px box");
  assert.equal(Number(trackMatch?.[3]), 10, "flush track rx is height/2 — a true pill radius at the full height");

  const fillMatch = html.match(/class="cost-bar-fill"[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"[^>]*rx="([\d.]+)"/);
  assert.ok(fillMatch, "the fill must render");
  assert.equal(Number(fillMatch?.[1]), 0, "flush fill y is 0");
  assert.equal(Number(fillMatch?.[2]), 20, "flush fill height fills the full 20px box");
  assert.equal(Number(fillMatch?.[3]), 10, "flush fill rx is height/2");

  // The hatch tail's `y`/`height` are plain attributes (only its `x`/`width` need `calc()`, hence
  // `style=` — CostBar.tsx's own comment on why) — matched here by its distinguishing `style="x:`
  // prefix rather than a class, since (unlike the track/fill) it carries no class of its own.
  const hatchMatch = html.match(/<rect style="x:max\(0px[^>]*y="([\d.]+)"[^>]*height="([\d.]+)"/);
  assert.ok(hatchMatch, "the hatch tail must render");
  assert.equal(Number(hatchMatch?.[1]), 0, "flush hatch tail y is 0 — the SAME geometry as the track/fill, never drifting out of sync");
  assert.equal(Number(hatchMatch?.[2]), 20, "flush hatch tail height fills the full 20px box");
});
