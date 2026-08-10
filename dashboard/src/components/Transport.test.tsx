import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Round } from "../api/types.ts";
import { Transport } from "./Transport.tsx";

const NOW = new Date("2026-08-10T12:00:00Z");

/** #766 gate② finding [3]: a hand-built object matching the FULL, authoritative v1
 *  `RoundArtifactSchema` shape (`engine/src/loop/round-artifact.ts`) — the dashboard workspace
 *  never imports `engine/src` at runtime (same established boundary `entities.ts`'s title-fold
 *  doc and `copy.ts`'s `EventKind` mirror already document), so this mirrors the contract by
 *  hand rather than importing the zod schema. Every required field is present with its correct
 *  NAME (`prsMerged`, not `merged` — the exact field the finding caught this renderer missing)
 *  so a fixture drift from the real contract would show up as an obviously-wrong test value, not
 *  a silently-passing invented field. */
function contractValidArtifact(overrides: Partial<{ prsMerged: number; spendUsd: number }> = {}) {
  return {
    schemaVersion: 1,
    roundId: 1,
    startedAt: "2026-08-10T10:00:00Z",
    endedAt: "2026-08-10T10:30:00Z",
    dispatches: [],
    merges: [],
    prsOpened: overrides.prsMerged ?? 3,
    prsMerged: overrides.prsMerged ?? 3,
    issuesClosed: overrides.prsMerged ?? 3,
    spendUsd: overrides.spendUsd ?? 4.5,
    roundBudgetUsd: 100,
    retries: { gatedReentries: 0, gatedReentryCapped: 0, rollbacksRecovered: 0, rollbacksEscalated: 0 },
    reviewRounds: { reviewerFallbackSwitches: 0, reviewerFallbackReverts: 0 },
    escalations: { needsHuman: [], ceiling: 0, driveNoPr: 0 },
    egressSuspects: [],
    handoffs: 0,
    degradedPhases: [],
    roundStops: [],
    retro: { opened: null, degraded: null },
    align: null,
    concerns: [],
    concernsReconciled: [],
  };
}

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
    artifact: contractValidArtifact(),
    ...overrides,
  };
}

// ── round navigator: chapter marks from /api/rounds ─────────────────────────────────────────────

test("empty state: no rounds yet", () => {
  const html = renderToStaticMarkup(<Transport rounds={[]} selectedRoundId={null} onSelectRound={() => {}} now={NOW} />);
  assert.match(html, /no rounds yet/);
});

// #766 gate② finding [2] (rounds-failure-renders-empty): a genuinely FAILED /api/rounds fetch
// must never render as the honest "no rounds yet" empty history — same `disconnected` posture
// LaneBoard/ActivityFeed already carry for their own failed data sources.
test("disconnected=true renders the disconnected caption, never 'no rounds yet' — a fetch failure is not an honest empty history", () => {
  const html = renderToStaticMarkup(<Transport rounds={[]} selectedRoundId={null} onSelectRound={() => {}} disconnected now={NOW} />);
  assert.match(html, /disconnected — restart sapwood to reconnect/);
  assert.doesNotMatch(html, /no rounds yet/);
});

test("lists every round from /api/rounds, one row each", () => {
  const rounds = [round({ roundId: 1 }), round({ roundId: 2 }), round({ roundId: 3, status: "in_progress" })];
  const html = renderToStaticMarkup(<Transport rounds={rounds} selectedRoundId={null} onSelectRound={() => {}} now={NOW} />);
  for (const r of rounds) assert.match(html, new RegExp(`round ${r.roundId}`));
});

test("a round with a tally (artifact present) shows its merged count and spend, read from the REAL v1 artifact field names", () => {
  const html = renderToStaticMarkup(
    <Transport
      rounds={[round({ artifact: contractValidArtifact({ prsMerged: 5, spendUsd: 12.3 }) })]}
      selectedRoundId={null}
      onSelectRound={() => {}}
      now={NOW}
    />,
  );
  assert.match(html, /5 merged/);
  assert.match(html, /\$12\.30/);
});

test("#766 gate② finding [3]: an artifact shaped like the invented 'merged' field (never a real contract field) renders tally-less, not a fabricated count", () => {
  const html = renderToStaticMarkup(
    <Transport rounds={[round({ artifact: { merged: 5, spendUsd: 12.3 } })]} selectedRoundId={null} onSelectRound={() => {}} now={NOW} />,
  );
  assert.doesNotMatch(html, /5 merged/, "there is no 'merged' field on a real artifact — this must not render a count from it");
});

test("an artifact-less round renders tally-less — 'no summary yet', never a fabricated $0/0", () => {
  const artifactLess = round({ schemaVersion: null, artifact: null });
  const html = renderToStaticMarkup(<Transport rounds={[artifactLess]} selectedRoundId={null} onSelectRound={() => {}} now={NOW} />);
  assert.match(html, /no summary yet/);
  assert.doesNotMatch(html, /\$0\.00/);
  assert.match(html, /round-row-tally-less/);
});

test("the still-open round is not selectable for replay — its row's button is disabled", () => {
  const openRound = round({ roundId: 9, status: "in_progress" });
  const html = renderToStaticMarkup(<Transport rounds={[openRound]} selectedRoundId={null} onSelectRound={() => {}} now={NOW} />);
  assert.match(html, /<button[^>]*disabled[^>]*>round 9 · live/);
});

test("a closed round's row button is enabled and marked aria-pressed to reflect selection", () => {
  const r = round({ roundId: 7 });
  const selected = renderToStaticMarkup(<Transport rounds={[r]} selectedRoundId={7} onSelectRound={() => {}} now={NOW} />);
  assert.match(selected, /aria-pressed="true"/);

  const unselected = renderToStaticMarkup(<Transport rounds={[r]} selectedRoundId={null} onSelectRound={() => {}} now={NOW} />);
  assert.match(unselected, /aria-pressed="false"/);
  assert.doesNotMatch(unselected, /<button[^>]*disabled[^>]*>▶ round 7/);
});

// ── transport controls: only render once a round is actually selected ──────────────────────────

test("no transport controls (play/speed/scrub) render while nothing is selected — live mode has no transport", () => {
  const html = renderToStaticMarkup(<Transport rounds={[round()]} selectedRoundId={null} onSelectRound={() => {}} now={NOW} />);
  assert.doesNotMatch(html, /transport-controls/);
  assert.doesNotMatch(html, /aria-label="scrub"/);
});

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
