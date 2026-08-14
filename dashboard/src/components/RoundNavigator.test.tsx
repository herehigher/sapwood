import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { Round } from "../api/types.ts";
import {
  buildRoundListEntries,
  isStandbyRound,
  ROUND_LIST_RENDER_CAP,
  RoundNavigator,
  roundNavLabel,
  stepRoundLeft,
  stepRoundRight,
} from "./RoundNavigator.tsx";

const NOW = new Date("2026-08-10T12:00:00Z");

function artifact(overrides: Partial<{ prsMerged: number; spendUsd: number }> = {}) {
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
    artifact: artifact(),
    ...overrides,
  };
}

function standbyRound(id: number): Round {
  return round({ roundId: id, artifact: artifact({ prsMerged: 0, spendUsd: 0 }) });
}

// ── roundNavLabel: the pill's round-N binding tracks selectedRoundId ────────────────────────────

test("roundNavLabel: a selected round renders 'round N · closed', tinted", () => {
  const label = roundNavLabel([round({ roundId: 9 })], 9, null, "running");
  assert.equal(label.text, "round 9 · closed");
  assert.equal(label.closed, true);
});

test("roundNavLabel: LIVE with an open round renders 'round N · live', untinted", () => {
  const label = roundNavLabel([round({ roundId: 12, status: "in_progress" })], null, 12, "running");
  assert.equal(label.text, "round 12 · live");
  assert.equal(label.closed, false);
});

test("roundNavLabel: LIVE with nothing open falls back to the engine-state caption", () => {
  assert.equal(roundNavLabel([round()], null, null, "standby").text, "live · waiting");
  assert.equal(roundNavLabel([round()], null, null, "stopped").text, "live · stopped");
});

test("roundNavLabel: a fresh DB (no rounds at all) reads 'no rounds yet'", () => {
  assert.equal(roundNavLabel([], null, null, "standby").text, "no rounds yet");
});

test("roundNavLabel tracks a CHANGING selectedRoundId across renders — the binding is live, not frozen at mount", () => {
  const rounds = [round({ roundId: 5 }), round({ roundId: 9 })];
  assert.equal(roundNavLabel(rounds, 5, null, "running").text, "round 5 · closed");
  assert.equal(roundNavLabel(rounds, 9, null, "running").text, "round 9 · closed");
  assert.equal(roundNavLabel(rounds, null, 12, "running").text, "round 12 · live");
});

// ── stepping ─────────────────────────────────────────────────────────────────────────────────

test("stepRoundLeft: from LIVE, lands on the newest closed round", () => {
  const rounds = [round({ roundId: 3 }), round({ roundId: 5 }), round({ roundId: 7, status: "in_progress" })];
  assert.equal(stepRoundLeft(rounds, null), 5);
});

test("stepRoundLeft: steps to the next-older closed round", () => {
  const rounds = [round({ roundId: 3 }), round({ roundId: 5 }), round({ roundId: 9 })];
  assert.equal(stepRoundLeft(rounds, 9), 5);
  assert.equal(stepRoundLeft(rounds, 5), 3);
});

test("stepRoundLeft: already at the oldest closed round — stays put", () => {
  const rounds = [round({ roundId: 3 }), round({ roundId: 5 })];
  assert.equal(stepRoundLeft(rounds, 3), 3);
});

test("stepRoundRight: steps to the next-newer closed round", () => {
  const rounds = [round({ roundId: 3 }), round({ roundId: 5 }), round({ roundId: 9 })];
  assert.equal(stepRoundRight(rounds, 3), 5);
});

test("stepRoundRight: no newer closed round left — returns to LIVE (null)", () => {
  const rounds = [round({ roundId: 3 }), round({ roundId: 5 })];
  assert.equal(stepRoundRight(rounds, 5), null);
});

test("stepRoundRight: already at LIVE — stays at LIVE", () => {
  assert.equal(stepRoundRight([round({ roundId: 3 })], null), null);
});

// ── standby collapsing + newest-first ordering ──────────────────────────────────────────────────

test("isStandbyRound: 0 merged and $0.00 spend is standby; any real merge or spend is not", () => {
  assert.equal(isStandbyRound(standbyRound(1)), true);
  assert.equal(isStandbyRound(round({ artifact: artifact({ prsMerged: 1, spendUsd: 0 }) })), false);
  assert.equal(isStandbyRound(round({ artifact: artifact({ prsMerged: 0, spendUsd: 2.5 }) })), false);
  assert.equal(isStandbyRound(round({ artifact: null, schemaVersion: null })), false, "tally-less is not the same as standby");
});

test("buildRoundListEntries: newest-first ordering", () => {
  const rounds = [round({ roundId: 1 }), round({ roundId: 3 }), round({ roundId: 2 })];
  const entries = buildRoundListEntries(rounds);
  const ids = entries.map((e) => (e.kind === "round" ? e.round.roundId : -1));
  assert.deepEqual(ids, [3, 2, 1]);
});

test("buildRoundListEntries: a consecutive run of standby rounds collapses into one group entry", () => {
  const rounds = [round({ roundId: 10 }), standbyRound(9), standbyRound(8), standbyRound(7), round({ roundId: 6 })];
  const entries = buildRoundListEntries(rounds);
  assert.equal(entries.length, 3, "round 10, the standby-9..7 group, round 6");
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["round", "standby-group", "round"],
  );
  const group = entries[1];
  assert.ok(group);
  assert.equal(group.kind, "standby-group");
  if (group?.kind === "standby-group") assert.equal(group.rounds.length, 3);
});

test("buildRoundListEntries: two standby runs separated by real activity stay two separate groups", () => {
  const rounds = [standbyRound(5), standbyRound(4), round({ roundId: 3 }), standbyRound(2), standbyRound(1)];
  const entries = buildRoundListEntries(rounds);
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["standby-group", "round", "standby-group"],
  );
});

test("buildRoundListEntries: a lone standby round is its own 'round' entry, not a one-item group", () => {
  const entries = buildRoundListEntries([round({ roundId: 5 }), standbyRound(4), round({ roundId: 3 })]);
  assert.deepEqual(
    entries.map((e) => e.kind),
    ["round", "round", "round"],
  );
});

// ── rendering: navigator + round list open/close, cap disclosure ───────────────────────────────

test(".round-list never renders inline by default — only after the navigator pill is opened", () => {
  const html = renderToStaticMarkup(
    <RoundNavigator rounds={[round({ roundId: 1 })]} selectedRoundId={null} onSelectRound={() => {}} liveRoundId={null} now={NOW} />,
  );
  assert.doesNotMatch(html, /round-list/);
  assert.match(html, /round-nav-pill/);
});

// engine-agent audit run 9aaabee8-5885-40d3-a15e-6fecb47b17f3 finding [1]: the old version of this
// test only matched the CLASS NAME `round-row-sep` — it stayed green even if the `·` glyph inside
// that span were deleted, since the class attribute text alone satisfies a bare substring match.
// This asserts the actual rendered separator TEXT sits between the relative-time and tally spans,
// so deleting the glyph (or emptying the span) fails it.
test("the round-row separator between relative time and tally renders the actual '·' glyph, not just the class name", () => {
  const html = renderToStaticMarkup(
    <RoundNavigator
      rounds={[round({ roundId: 1, artifact: artifact({ prsMerged: 1, spendUsd: 12.3 }) })]}
      selectedRoundId={null}
      onSelectRound={() => {}}
      liveRoundId={null}
      now={NOW}
      initiallyOpen
    />,
  );
  assert.match(html, /class="muted round-row-sep" aria-hidden="true">·<\/span>/, "the separator span must actually contain the '·' glyph");
  // The full sequence — relative time, then the real separator, then the tally — never glued
  // together as "…ago1 merged" (the original bug this fix addresses).
  assert.match(html, /round-row-when"[^>]*>[^<]*<\/span><span class="muted round-row-sep"[^>]*>·<\/span><span/);
});

test("a round with a tally shows its merged count and spend", () => {
  const html = renderToStaticMarkup(
    <RoundNavigator
      rounds={[round({ roundId: 1, artifact: artifact({ prsMerged: 5, spendUsd: 12.3 }) })]}
      selectedRoundId={null}
      onSelectRound={() => {}}
      liveRoundId={null}
      now={NOW}
      initiallyOpen
    />,
  );
  assert.match(html, /5 merged/);
  assert.match(html, /\$12\.30/);
});

test("an artifact-less round renders tally-less — 'no summary yet', never a fabricated $0.00", () => {
  const html = renderToStaticMarkup(
    <RoundNavigator
      rounds={[round({ roundId: 1, schemaVersion: null, artifact: null })]}
      selectedRoundId={null}
      onSelectRound={() => {}}
      liveRoundId={null}
      now={NOW}
      initiallyOpen
    />,
  );
  assert.match(html, /no summary yet/);
  assert.match(html, /round-row-tally-less/);
});

test("the still-open round's row button is disabled — not a replay target", () => {
  const html = renderToStaticMarkup(
    <RoundNavigator
      rounds={[round({ roundId: 9, status: "in_progress" })]}
      selectedRoundId={null}
      onSelectRound={() => {}}
      liveRoundId={9}
      now={NOW}
      initiallyOpen
    />,
  );
  assert.match(html, /<button[^>]*disabled[^>]*>round 9 · live/);
});

test("a closed round's row carries aria-pressed reflecting selection", () => {
  const rounds = [round({ roundId: 7 })];
  const selected = renderToStaticMarkup(
    <RoundNavigator rounds={rounds} selectedRoundId={7} onSelectRound={() => {}} liveRoundId={null} now={NOW} initiallyOpen />,
  );
  assert.match(selected, /aria-pressed="true"/);

  const unselected = renderToStaticMarkup(
    <RoundNavigator rounds={rounds} selectedRoundId={null} onSelectRound={() => {}} liveRoundId={null} now={NOW} initiallyOpen />,
  );
  assert.match(unselected, /aria-pressed="false"/);
});

test("no rounds at all: opening the navigator shows 'no rounds yet', no list markup", () => {
  const html = renderToStaticMarkup(
    <RoundNavigator rounds={[]} selectedRoundId={null} onSelectRound={() => {}} liveRoundId={null} now={NOW} initiallyOpen />,
  );
  assert.match(html, /no rounds yet/);
  assert.doesNotMatch(html, /round-list/);
});

// engine-agent audit run 9aaabee8-5885-40d3-a15e-6fecb47b17f3 finding [1]: the old version of this
// test never rendered `RoundNavigator` at all and never asserted the rendered row count or the
// disclosure TEXT — it only proved `buildRoundListEntries(rounds).length > ROUND_LIST_RENDER_CAP`,
// which stays true even if the component silently dropped capping/disclosure entirely. This opens
// the real navigator and pins the exact disclosure copy plus the actual rendered `.round-row` count.
test(`entries beyond the ${ROUND_LIST_RENDER_CAP}-entry cap carry an honest disclosure line, same discipline as the feed`, () => {
  const total = ROUND_LIST_RENDER_CAP + 10;
  const rounds = Array.from({ length: total }, (_, i) => round({ roundId: i + 1, artifact: artifact({ prsMerged: 1 }) }));
  const html = renderToStaticMarkup(
    <RoundNavigator rounds={rounds} selectedRoundId={null} onSelectRound={() => {}} liveRoundId={null} now={NOW} initiallyOpen />,
  );
  assert.match(
    html,
    new RegExp(`showing latest ${ROUND_LIST_RENDER_CAP} of ${total} — ${total} rounds total`),
    "the disclosure line must name the exact rendered/total counts, not just exist",
  );
  const renderedRows = html.match(/class="round-row(?:\s+round-row-selected)?"/g) ?? [];
  assert.equal(
    renderedRows.length,
    ROUND_LIST_RENDER_CAP,
    "exactly the capped number of rows must actually be in the DOM, not just claimed",
  );
});

test(`at or under the ${ROUND_LIST_RENDER_CAP}-entry cap, no disclosure line renders at all — the cap note is honest about when it applies`, () => {
  const rounds = Array.from({ length: ROUND_LIST_RENDER_CAP }, (_, i) => round({ roundId: i + 1, artifact: artifact({ prsMerged: 1 }) }));
  const html = renderToStaticMarkup(
    <RoundNavigator rounds={rounds} selectedRoundId={null} onSelectRound={() => {}} liveRoundId={null} now={NOW} initiallyOpen />,
  );
  assert.doesNotMatch(html, /round-list-cap-note/);
  const renderedRows = html.match(/class="round-row(?:\s+round-row-selected)?"/g) ?? [];
  assert.equal(renderedRows.length, ROUND_LIST_RENDER_CAP);
});
