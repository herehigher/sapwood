import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Lane } from "../api/types.ts";
import { LaneBoard } from "./LaneBoard.tsx";

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
  contextTokens: null,
  tokenComposition: null,
  ...overrides,
});

test("renders exactly lanes.max slots, real lanes plus quiet outlines for the rest", () => {
  const html = renderToStaticMarkup(<LaneBoard lanesMax={3} lanes={[lane()]} titles={{}} now={NOW} />);
  const realCards = html.match(/class="lane-card panel"/g) ?? [];
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
