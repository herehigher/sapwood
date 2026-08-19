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

test("#924 AC1: the today panel's head carries .panel-head, with the avg-round stat as its own .panel-head-stat last child", () => {
  const html = renderToStaticMarkup(<CostStrip today={todayPanel()} round={null} />);
  assert.match(
    html,
    /<div class="cost-panel-head panel-head"><h3>cost · today<\/h3><span class="data muted cost-panel-avg panel-head-stat">avg round \$4\.80<\/span><\/div>/,
  );
});

test("a round with no artifact data still renders all six stage rows, zero-filled — never a blank chart", () => {
  const html = renderToStaticMarkup(<CostStrip today={todayPanel({ stageBars: [], modelBars: [], avgRoundUsd: null })} round={null} />);
  assert.match(html, /no spend yet/);
});

test("renders a second panel only when a round is given, with its CLOSED badge and footer stats", () => {
  const withoutRound = renderToStaticMarkup(<CostStrip today={todayPanel()} round={null} />);
  // #953: a by-model label's tooltip trigger now carries its own `data-state="closed"` (Radix's
  // own idle-state attribute, unrelated to the CLOSED round badge) — assert the badge class
  // itself, not a loose /closed/i that now also matches that trigger attribute.
  assert.doesNotMatch(withoutRound, /cost-panel-badge/);

  const withRound = renderToStaticMarkup(
    <CostStrip
      today={todayPanel()}
      round={{
        heading: "cost · round 9",
        closed: true,
        stageBars: STAGE_BARS,
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
        modelBars: MODEL_BARS,
        footer: { totalUsd: 1.1, prsMerged: 0, usdPerPr: null, reviewUsd: 0 },
      }}
    />,
  );
  assert.doesNotMatch(html, /\/PR/);
  assert.match(html, /0 PRs merged/);
});

// #1020: no `.cost-bar-target` element ever renders from a real panel render — the roundBudget/6
// tick and its `targetUsd`/`tickPositionPct` plumbing are gone outright.
test("#1020: no .cost-bar-target renders anywhere in a cost panel", () => {
  const html = renderToStaticMarkup(
    <CostStrip today={todayPanel({ stageBars: [{ label: "Lanes", usd: 10 }], modelBars: [] })} round={null} />,
  );
  assert.doesNotMatch(html, /cost-bar-target/);
});

test("the outer section keeps its #cost anchor id (§3 rail target, #727) — the ONE cost-strip instance", () => {
  const html = renderToStaticMarkup(<CostStrip today={todayPanel()} round={null} />);
  assert.match(html, /id="cost"/);
});

// ── #890 (§3 E): the shared CostBar primitive's hatched est share ──────────────────────────────

// #890: `<CostBar>` unconditionally emits its own `<pattern id="cost-bar-est-hatch">` def,
// present/absent est alike — matching the bare `cost-bar-est-hatch` substring proves only that
// SOME bar mounted, not that a hatch RECT actually drew. The discriminating check is the
// fill-url USAGE (`url(#cost-bar-est-hatch)`), which only a bar with a real est segment ever
// emits.
test("a bar carrying estUsd renders the hatch fill-url usage (the actual rect, not just the pattern def); a bar with none does not", () => {
  const withEst = renderToStaticMarkup(
    <CostStrip today={todayPanel({ stageBars: [{ label: "Lanes", usd: 8.9, estUsd: 2.2 }] })} round={null} />,
  );
  assert.match(withEst, /url\(#[^)]*cost-bar-est-hatch\)/);
  const withoutEst = renderToStaticMarkup(<CostStrip today={todayPanel()} round={null} />);
  // Both cases mount the `<pattern>` def itself (every `<CostBar>` instance does) — proving the
  // def's mere presence is NOT what distinguishes them; only the fill-url usage does. Each
  // instance's id is `useId()` + the shared suffix (CostBar.tsx), never a single global id.
  assert.match(withoutEst, /id="[^"]*cost-bar-est-hatch"/);
  assert.doesNotMatch(withoutEst, /url\(#[^)]*cost-bar-est-hatch\)/);
});

test("a CLOSED round panel's bars never carry a hatch — nothing is still running in a closed round", () => {
  const html = renderToStaticMarkup(
    <CostStrip
      today={todayPanel()}
      round={{
        heading: "cost · round 9",
        closed: true,
        stageBars: STAGE_BARS,
        modelBars: MODEL_BARS,
        footer: { totalUsd: 6.2, prsMerged: 3, usdPerPr: 6.2 / 3, reviewUsd: 0 },
      }}
    />,
  );
  assert.doesNotMatch(html, /url\(#[^)]*cost-bar-est-hatch\)/);
});
