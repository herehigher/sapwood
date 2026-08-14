import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Round } from "../api/types.ts";
import { Transport } from "./Transport.tsx";

const NOW = new Date("2026-08-10T12:00:00Z");

function round(overrides: Partial<Round> = {}): Round {
  return {
    roundId: 1,
    status: "done",
    startedAt: "2026-08-10T10:00:00Z",
    endedAt: "2026-08-10T10:30:00Z",
    startEventId: 100,
    startSpendId: 50,
    eventCount: 42,
    schemaVersion: 1,
    artifact: { schemaVersion: 1, prsMerged: 3, spendUsd: 4.5 },
    ...overrides,
  };
}

// ── #889: live mode renders nothing at all — the round list moved to the header navigator ──────

test("live mode (nothing selected) renders nothing — no panel, no round list, no controls", () => {
  const html = renderToStaticMarkup(<Transport rounds={[round()]} selectedRoundId={null} onSelectRound={() => {}} now={NOW} />);
  assert.equal(html, "");
});

test("disconnected renders nothing — the header's own navigator already carries that state", () => {
  const html = renderToStaticMarkup(<Transport rounds={[]} selectedRoundId={null} onSelectRound={() => {}} disconnected now={NOW} />);
  assert.equal(html, "");
});

test("a selectedRoundId not (yet) present in `rounds` renders nothing rather than crashing", () => {
  const html = renderToStaticMarkup(<Transport rounds={[]} selectedRoundId={5} onSelectRound={() => {}} now={NOW} />);
  assert.equal(html, "");
});

// ── transport controls: only render once a round is actually selected ──────────────────────────

test("selecting a round reveals play/pause, speed, and scrub controls", () => {
  const html = renderToStaticMarkup(
    <Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} onSelectRound={() => {}} cursorId={100} now={NOW} />,
  );
  assert.match(html, /aria-label="play"/);
  assert.match(html, /aria-label="scrub"/);
  for (const label of ["×1", "×4", "×16"]) assert.match(html, new RegExp(label.replace("×", "×")));
});

test("playing=true shows the pause glyph/label instead of play", () => {
  const html = renderToStaticMarkup(
    <Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} onSelectRound={() => {}} playing cursorId={100} now={NOW} />,
  );
  assert.match(html, /aria-label="pause"/);
  assert.doesNotMatch(html, /aria-label="play"/);
});

test("the active speed carries aria-pressed=true, the others false", () => {
  const html = renderToStaticMarkup(
    <Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} onSelectRound={() => {}} speed={4} cursorId={100} now={NOW} />,
  );
  const pressedTrue = html.match(/aria-pressed="true">×4/);
  assert.ok(pressedTrue, "×4 button carries aria-pressed=true");
  assert.match(html, /aria-pressed="false">×1/);
  assert.match(html, /aria-pressed="false">×16/);
});

test("the scrub bar spans the round's event window and shows the current 'event n/N' position", () => {
  const r = round({ roundId: 1, startEventId: 500, eventCount: 300 });
  const html = renderToStaticMarkup(<Transport rounds={[r]} selectedRoundId={1} onSelectRound={() => {}} cursorId={650} now={NOW} />);
  assert.match(html, /min="500"/);
  assert.match(html, /max="800"/);
  assert.match(html, /value="650"/);
  assert.match(html, /event 150\/300/);
});

test("'back to live' is offered whenever a round is selected", () => {
  const html = renderToStaticMarkup(
    <Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} onSelectRound={() => {}} cursorId={100} now={NOW} />,
  );
  assert.match(html, /back to live/);
});

// ── #766 gate② finding [3] (round-log-load-rejection-sticks): loading / error / retry ──────────

test("loading=true shows an honest 'loading round…' caption, no play/speed/scrub controls yet (nothing to control)", () => {
  const html = renderToStaticMarkup(
    <Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} onSelectRound={() => {}} loading now={NOW} />,
  );
  assert.match(html, /loading round…/);
  assert.doesNotMatch(html, /aria-label="play"/);
  assert.doesNotMatch(html, /aria-label="scrub"/);
  assert.match(html, /back to live/, "back to live stays available even while loading");
});

test("loadError (not loading) shows an honest failure caption and a retry control, never a silently blank panel", () => {
  const html = renderToStaticMarkup(
    <Transport
      rounds={[round({ roundId: 1 })]}
      selectedRoundId={1}
      onSelectRound={() => {}}
      loading={false}
      loadError={new Error("network down")}
      now={NOW}
    />,
  );
  assert.match(html, /could not load this round/);
  assert.match(html, /<button[^>]*>retry<\/button>/);
  assert.doesNotMatch(html, /aria-label="scrub"/, "no scrub bar over a log that failed to load");
});

test("no loadError and not loading: the ordinary transport controls render, not the error state", () => {
  const html = renderToStaticMarkup(
    <Transport rounds={[round({ roundId: 1 })]} selectedRoundId={1} onSelectRound={() => {}} loading={false} loadError={null} now={NOW} />,
  );
  assert.doesNotMatch(html, /could not load this round/);
  assert.match(html, /aria-label="scrub"/);
});
