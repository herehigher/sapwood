import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Lane } from "../api/types.ts";
import { LaneBoard, laneHeadStat, laneStateChipText } from "./LaneBoard.tsx";

// ── #924: the lanes panel-head's own stat cluster ───────────────────────────────────────────────

test("laneHeadStat joins model·effort and soft budget, matching the mockup's 'opus · high · soft budget $10'", () => {
  assert.equal(laneHeadStat({ worker: { model: "opus", effort: "high" } }, 10), "opus · high · soft budget $10.00");
});

test("laneHeadStat renders just the readable half when the other is unavailable", () => {
  assert.equal(laneHeadStat({ worker: { model: "opus", effort: "high" } }, null), "opus · high");
  assert.equal(laneHeadStat(null, 10), "soft budget $10.00");
});

test("laneHeadStat is null (no stat cluster at all) when config is unreadable and no budget is configured", () => {
  assert.equal(laneHeadStat(null, null), null);
  assert.equal(laneHeadStat({}, null), null);
});

test("the lanes panel-head renders the real config-sourced stat cluster as its last child", () => {
  const html = renderToStaticMarkup(
    <LaneBoard
      lanesMax={1}
      lanes={[]}
      titles={{}}
      config={{ worker: { model: "opus", effort: "high", budgetUsdSoft: 10 } }}
      workerBudgetUsdSoft={10}
    />,
  );
  assert.match(
    html,
    /<div class="panel-head"><h2>lanes<\/h2><span class="data muted panel-head-stat">opus · high · soft budget \$10\.00<\/span><\/div>/,
  );
});

test("the lanes panel-head renders title-only (no stat cluster) when config is unreadable", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[]} titles={{}} />);
  assert.match(html, /<div class="panel-head"><h2>lanes<\/h2><\/div>/);
});

// #927 (§729 remainder, D35; Q4 owner ruling): the panel-head's REPLAYED chip — `source` defaults
// to "live" so every pre-#927 caller (including the two tests above) keeps rendering unchanged.

test("source defaults to live — no REPLAYED chip renders unless explicitly asked for", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[]} titles={{}} />);
  assert.doesNotMatch(html, /REPLAYED/);
});

test('source="replayed" renders the REPLAYED chip as the panel-head\'s own last child, no config stat present', () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[]} titles={{}} source="replayed" />);
  assert.match(
    html,
    /<div class="panel-head"><h2>lanes<\/h2><span class="lane-board-replayed-chip panel-head-stat">REPLAYED<\/span><\/div>/,
  );
});

test('source="replayed" alongside a real config stat cluster: both render, the chip following the stat', () => {
  const html = renderToStaticMarkup(
    <LaneBoard
      lanesMax={1}
      lanes={[]}
      titles={{}}
      source="replayed"
      config={{ worker: { model: "opus", effort: "high" } }}
      workerBudgetUsdSoft={10}
    />,
  );
  assert.match(
    html,
    /<span class="data muted panel-head-stat">opus · high · soft budget \$10\.00<\/span><span class="lane-board-replayed-chip">REPLAYED<\/span>/,
  );
});

const NOW = new Date("2026-08-06T12:00:00.000Z");

const lane = (overrides: Partial<Lane> = {}): Lane => ({
  lane: "w1",
  issue: 86,
  state: "running",
  pr: null,
  startedAt: "2026-08-06T11:50:00.000Z",
  endedAt: null,
  costUsd: null,
  estCostUsd: null,
  fixRound: 0,
  contextTokens: null,
  tokenComposition: null,
  ...overrides,
});

test("renders exactly lanes.max slots, real lanes plus quiet outlines for the rest", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={3} lanes={[lane()]} titles={{}} now={NOW} />);
  const realCards = html.match(/class="lane-card panel recipe-list-entry"/g) ?? [];
  const emptyCards = html.match(/class="lane-card lane-card-empty"/g) ?? [];
  assert.equal(realCards.length, 1);
  assert.equal(emptyCards.length, 2);
  assert.match(html, /\(idle\)/);
});

test("full lanes: no empty outlines rendered", () => {
  const html = renderToStaticMarkup(
    <LaneBoard lanesMax={2} lanes={[lane({ lane: "w1" }), lane({ lane: "w2", issue: 90 })]} titles={{}} now={NOW} />,
  );
  assert.doesNotMatch(html, /\(idle\)/);
});

test("in-flight cost renders the settles-later caption, not blank or zero", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ costUsd: null })]} titles={{}} now={NOW} />);
  assert.match(html, /settles when the lane ends/);
  assert.doesNotMatch(html, />\$0\.00</);
});

test("settled cost renders the real spend_ledger sum", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ costUsd: 1.2 })]} titles={{}} now={NOW} />);
  assert.match(html, /\$1\.20/);
});

// ── #890 (§3 E): engine-provided est is never silently dropped ─────────────────────────────────

test("a running lane's engine-provided estCostUsd renders as '$X.XX est', never the settles-later placeholder", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ costUsd: null, estCostUsd: 6.21 })]} titles={{}} now={NOW} />);
  assert.match(html, /\$6\.21 est/);
  assert.doesNotMatch(html, /settles when the lane ends/);
});

test("a settled lane's real costUsd wins over any lingering estCostUsd — never both figures shown", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ costUsd: 5.8, estCostUsd: 6.21 })]} titles={{}} now={NOW} />);
  assert.match(html, /\$5\.80/);
  assert.doesNotMatch(html, /6\.21/);
});

test("a lane with a live estimate renders the shared hatched CostBar", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ costUsd: null, estCostUsd: 6.21 })]} titles={{}} now={NOW} />);
  assert.match(html, /class="cost-bar lane-card-bar"/);
  assert.match(html, /url\(#[^)]*cost-bar-est-hatch\)/);
});

test("a lane with neither a settled nor an est figure renders no bar at all — never a zero-width chart", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ costUsd: null, estCostUsd: null })]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /class="cost-bar/);
});

// ── #890: the bar scales against the configured worker soft budget, not the amount it draws —
// a self-scaled max made every positive figure render 100% full, losing all budget context.

// #924 AC2: the settled fill is a `<rect width={settledPct}%>` — a percentage length the browser
// resolves against the bar's own real rendered width, never a hand-computed value.
test("workerBudgetUsdSoft is the bar's ceiling — a small settled amount against a real budget draws a partial-width fill, never full", () => {
  const html = renderToStaticMarkup(
    <LaneBoard lanesMax={1} lanes={[lane({ costUsd: 2 })]} titles={{}} workerBudgetUsdSoft={10} now={NOW} />,
  );
  // The background TRACK line is always full-width (x1="0" x2="100%", a fixed full-width
  // reference) — the settled FILL rect (`class="cost-bar-fill"`, its colour resolved through CSS
  // from `--sap-fill`) is the one whose own `width` must scale against the ceiling.
  assert.match(html, /class="cost-bar-fill" x="0"[^>]*width="20%"/, "$2 of a $10 soft budget is a 20%-wide fill");
  assert.doesNotMatch(html, /class="cost-bar-fill" x="0"[^>]*width="100%"/, "the settled fill itself must never self-scale to full width");
});

test("workerBudgetUsdSoft unset (config unreadable) falls back to the self-scaled total, same as before #890", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ costUsd: 2 })]} titles={{}} now={NOW} />);
  assert.match(
    html,
    /class="cost-bar-fill" x="0"[^>]*width="100%"/,
    "with no real ceiling to measure against, the settled figure fills its own bar",
  );
});

test("a lane that overran its soft budget still draws a full (clamped) bar, never off-track", () => {
  const html = renderToStaticMarkup(
    <LaneBoard lanesMax={1} lanes={[lane({ costUsd: 15 })]} titles={{}} workerBudgetUsdSoft={10} now={NOW} />,
  );
  assert.match(html, /class="cost-bar-fill" x="0"[^>]*width="100%"/);
});

test("a configured budget never forces an empty lane (no settled, no est) to draw a bar", () => {
  const html = renderToStaticMarkup(
    <LaneBoard lanesMax={1} lanes={[lane({ costUsd: null, estCostUsd: null })]} titles={{}} workerBudgetUsdSoft={10} now={NOW} />,
  );
  assert.doesNotMatch(html, /class="cost-bar/);
});

test("shows a PR link only when the lane is driving a PR", () => {
  const withoutPr = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ pr: null })]} titles={{}} now={NOW} />);
  assert.doesNotMatch(withoutPr, /lane-card-pr/);
  const withPr = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ pr: 97, state: "driving" })]} titles={{}} now={NOW} />);
  assert.match(withPr, /lane-card-pr/);
  assert.match(withPr, /#97/);
});

test("state word renders the plain-language caption, not the raw internal state", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ state: "running" })]} titles={{}} now={NOW} />);
  assert.match(html, />writing</);
});

test("#715 gate② [6]: a known active state (running/driving/fixing/handoff) renders no failure glyph", () => {
  for (const state of ["running", "driving", "fixing", "handoff"]) {
    const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ state })]} titles={{}} now={NOW} />);
    assert.doesNotMatch(html, /glyph-fail/, `${state} should not render the failure glyph`);
  }
});

test("#715 gate② [6]: an unexpected lane state (e.g. a future/failed value) renders the static ✕ glyph alongside its color", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ state: "failed" })]} titles={{}} now={NOW} />);
  assert.match(html, /glyph-fail/);
  assert.match(html, /<svg/);
  assert.match(html, />failed</);
});

test("unreadable config (lanes.max null) renders the specified placeholder caption", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={null} lanes={[]} titles={{}} now={NOW} />);
  assert.match(html, /lane count unknown — config unreadable/);
});

test("disconnected renders the disconnected caption instead of lane cards", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={3} lanes={[lane()]} titles={{}} disconnected now={NOW} />);
  assert.match(html, /disconnected/);
  assert.doesNotMatch(html, /lane-board-grid/);
});

// ── #882 (729 ledger row 13, "w1 lane row unnamed on the board") ───────────────────────────────

test("#882: each lane card names its own lane (w1/w2/…), not just the issue it's working", () => {
  const html = renderToStaticMarkup(
    <LaneBoard lanesMax={2} lanes={[lane({ lane: "w1", issue: 94 }), lane({ lane: "w2", issue: 90 })]} titles={{}} now={NOW} />,
  );
  assert.match(html, /class="data lane-card-name">w1</);
  assert.match(html, /class="data lane-card-name">w2</);
});

// #892: EntityRef's folded title moved from a bare `title=` (static-markup-visible) to a Radix
// tooltip that only mounts on real focus — see EntityRef.test.tsx's own real-DOM tests for the
// interactive open/aria-describedby proof. `tabindex="0"` is the SSR-visible signal that a title
// was folded and wired through to a real (Tab-reachable) trigger — EntityRef only adds it when
// there's a title to show.
test("issue numbers carry a type glyph and a folded-title tooltip trigger, same as EntityRef", () => {
  const html = renderToStaticMarkup(
    <LaneBoard lanesMax={1} lanes={[lane({ issue: 86 })]} titles={{ 86: { issueTitle: "Fix the thing" } }} now={NOW} />,
  );
  assert.match(html, /tabindex="0"/);
  assert.match(html, /<svg/);
});

// ── #926 AC4: the state chip never fabricates a field — fixing carries its own round/cap, ─────
// driving shows the PR line, running shows the cost line and no PR line ─────────────────────────

test("laneStateChipText: a fixing lane reads FIXING · ROUND n/cap from lane.fixRound and the configured cap", () => {
  assert.equal(laneStateChipText(lane({ state: "fixing", fixRound: 1 }), 2), "FIXING · ROUND 1/2");
  assert.equal(laneStateChipText(lane({ state: "fixing", fixRound: 2 }), 3), "FIXING · ROUND 2/3");
});

test("laneStateChipText: every other known state keeps its plain laneStateCaption word, never a round count", () => {
  assert.equal(laneStateChipText(lane({ state: "running" }), 2), "writing");
  assert.equal(laneStateChipText(lane({ state: "driving" }), 2), "PR under review");
  assert.equal(laneStateChipText(lane({ state: "handoff" }), 2), "handed off");
});

test("#926 AC4: a fixing lane's rendered chip reads FIXING · ROUND n/cap, sourced from lanes.prFixCap", () => {
  const html = renderToStaticMarkup(
    <LaneBoard lanesMax={1} lanes={[lane({ state: "fixing", fixRound: 1, pr: 99 })]} titles={{}} fixCap={2} now={NOW} />,
  );
  assert.match(html, /FIXING · ROUND 1\/2/);
});

test("#926 AC4: a driving lane's chip is the plain caption (never a round count) and shows the PR line", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ state: "driving", pr: 97 })]} titles={{}} now={NOW} />);
  assert.doesNotMatch(html, /ROUND/);
  assert.match(html, /lane-card-pr/);
});

test("#926 AC4: a running lane shows the est cost line and never a PR line", () => {
  const html = renderToStaticMarkup(
    <LaneBoard lanesMax={1} lanes={[lane({ state: "running", pr: null, estCostUsd: 0.53 })]} titles={{}} now={NOW} />,
  );
  assert.match(html, /\$0\.53 est/);
  assert.doesNotMatch(html, /lane-card-pr/);
});

// ── #926 AC3: the state chip's own uppercase/font-data + the head's closing hairline ───────────

test("#926 AC3: the state chip and the lane's body/foot markup carry the anatomy this card's CSS targets", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={1} lanes={[lane({ state: "running" })]} titles={{}} now={NOW} />);
  assert.match(html, /class="lane-card-head"/);
  assert.match(html, /class="data muted lane-card-state">/);
  assert.match(html, /class="lane-card-state-dot"/);
  assert.match(html, /class="lane-card-issue"/);
});
