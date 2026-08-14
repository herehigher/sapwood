import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CostStrip } from "./CostStrip.tsx";

const STAGE_BARS = [
  { label: "Goal & align", usd: 0.22 },
  { label: "Arch review", usd: 0.31 },
  { label: "Verify", usd: 0.18 },
  { label: "Lanes", usd: 8.9 },
  { label: "Summary", usd: 0.26 },
  { label: "Retro", usd: 0.29 },
];

const MODEL_BARS = [
  { label: "opus", usd: 7.8 },
  { label: "sonnet", usd: 2.4 },
];

function todayPanel(overrides: Partial<Parameters<typeof CostStrip>[0]["today"]> = {}) {
  return {
    heading: "cost · today",
    avgRoundUsd: 4.8,
    stageBars: STAGE_BARS,
    targetUsd: 5,
    modelBars: MODEL_BARS,
    footer: null,
    ...overrides,
  };
}

test("renders the today panel's by-stage and by-model groups, and the avg-round header", () => {
  const html = renderToStaticMarkup(<CostStrip today={todayPanel()} round={null} />);
  assert.match(html, /cost · today/);
  assert.match(html, /avg round \$4\.80/);
  assert.match(html, /Goal &amp; align/);
  assert.match(html, /Lanes/);
  assert.match(html, /\$8\.90/);
  assert.match(html, /opus/);
  assert.match(html, /\$7\.80/);
});

test("a round with no artifact data still renders all six stage rows, zero-filled — never a blank chart", () => {
  const html = renderToStaticMarkup(
    <CostStrip today={todayPanel({ stageBars: [], modelBars: [], avgRoundUsd: null, targetUsd: null })} round={null} />,
  );
  assert.match(html, /no spend yet/);
});

test("renders a second panel only when a round is given, with its CLOSED badge and footer stats", () => {
  const withoutRound = renderToStaticMarkup(<CostStrip today={todayPanel()} round={null} />);
  assert.doesNotMatch(withoutRound, /closed/i);

  const withRound = renderToStaticMarkup(
    <CostStrip
      today={todayPanel()}
      round={{
        heading: "cost · round 9",
        closed: true,
        stageBars: STAGE_BARS,
        targetUsd: 5,
        modelBars: MODEL_BARS,
        footer: { totalUsd: 6.2, prsMerged: 3, usdPerPr: 6.2 / 3, reviewUsd: 0 },
      }}
    />,
  );
  assert.match(withRound, /cost · round 9/);
  assert.match(withRound, /closed/i);
  assert.match(withRound, /total \$6\.20/);
  assert.match(withRound, /3 PRs merged/);
  assert.match(withRound, /\$2\.07\/PR/);
  assert.match(withRound, /review \$0\.00/);
});

test("footer's $-per-PR figure is omitted (never a division-by-zero string) when nothing merged", () => {
  const html = renderToStaticMarkup(
    <CostStrip
      today={todayPanel()}
      round={{
        heading: "cost · round 9",
        closed: true,
        stageBars: STAGE_BARS,
        targetUsd: 5,
        modelBars: MODEL_BARS,
        footer: { totalUsd: 1.1, prsMerged: 0, usdPerPr: null, reviewUsd: 0 },
      }}
    />,
  );
  assert.doesNotMatch(html, /\/PR/);
  assert.match(html, /0 PRs merged/);
});

test("the target-tick marker draws at the correct bar coordinate, shared across every stage bar in the group", () => {
  const html = renderToStaticMarkup(
    <CostStrip today={todayPanel({ stageBars: [{ label: "Lanes", usd: 10 }], targetUsd: 5, modelBars: [] })} round={null} />,
  );
  // max is 10 (the bar's own usd, since it exceeds targetUsd 5) -> tick at 50%.
  assert.match(html, /x1="50"/);
});

test("no target tick renders at all when targetUsd is null (no ceiling configured)", () => {
  const html = renderToStaticMarkup(
    <CostStrip today={todayPanel({ stageBars: [{ label: "Lanes", usd: 10 }], targetUsd: null, modelBars: [] })} round={null} />,
  );
  assert.doesNotMatch(html, /cost-bar-target/);
});

test("the outer section keeps its #cost anchor id (§3 rail target, #727) — the ONE cost-strip instance", () => {
  const html = renderToStaticMarkup(<CostStrip today={todayPanel()} round={null} />);
  assert.match(html, /id="cost"/);
});
