import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostBar, HATCH_PATTERN_ID } from "./CostBar.tsx";

test("settled-only bar draws a solid fill sized to settledUsd/max, no hatch segment", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} max={10} label="lane" />);
  assert.match(html, /width="50"/);
  assert.doesNotMatch(html, new RegExp(`url\\(#${HATCH_PATTERN_ID}\\)`));
});

test("settled + est draws the est tail immediately after the settled fill, hatched", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={4} estUsd={2} max={10} label="lane" />);
  // settled: 0 -> 40%; est: 40% -> 60% (width 20)
  assert.match(html, /width="40"/);
  assert.match(html, new RegExp(`x="40"[^>]*width="20"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`));
});

test("est is clamped so the total never draws past 100% of the track", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={9} estUsd={5} max={10} label="lane" />);
  // settled: 90%; est would be 50% more (140% total) -> clamped tail is 10% wide, ending at 100.
  assert.match(html, /width="90"/);
  assert.match(html, new RegExp(`x="90"[^>]*width="10"[^>]*fill="url\\(#${HATCH_PATTERN_ID}\\)"`));
});

test("zero/absent est renders no hatch rect at all — never a phantom zero-width segment", () => {
  const zero = renderToStaticMarkup(<CostBar settledUsd={5} estUsd={0} max={10} label="lane" />);
  const absent = renderToStaticMarkup(<CostBar settledUsd={5} max={10} label="lane" />);
  assert.doesNotMatch(zero, new RegExp(`url\\(#${HATCH_PATTERN_ID}\\)`));
  assert.doesNotMatch(absent, new RegExp(`url\\(#${HATCH_PATTERN_ID}\\)`));
});

test("max <= 0 renders a zero-width bar, never NaN/Infinity", () => {
  const html = renderToStaticMarkup(<CostBar settledUsd={5} estUsd={2} max={0} label="lane" />);
  assert.doesNotMatch(html, /NaN/);
  assert.doesNotMatch(html, /Infinity/);
  assert.match(html, /width="0"/);
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
