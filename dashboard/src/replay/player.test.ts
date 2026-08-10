import assert from "node:assert/strict";
import test from "node:test";
import type { DomainEvent } from "../domain-event.ts";
import { buildCheckpoints, CHECKPOINT_INTERVAL } from "./checkpoint.ts";
import {
  advanceFrame,
  BASE_EVENTS_PER_TICK,
  cursorTs,
  INITIAL_TRANSPORT_STATE,
  initialReplayPosition,
  isAtEnd,
  scrubTo,
  transportReducer,
} from "./player.ts";
import { foldReplay, initialReplayState } from "./reducer.ts";

/** Same synthetic-log shape `checkpoint.test.ts` uses — sequential ids, dispatch/drive/merge
 *  cycles across three lanes, so the fold exercises real state, not just a no-op kind. */
function syntheticLog(n: number): DomainEvent[] {
  const lanes = ["w1", "w2", "w3"];
  const events: DomainEvent[] = [];
  let issue = 1000;
  const push = (kind: string, payload: Record<string, unknown>) => {
    if (events.length >= n) return;
    const id = events.length + 1;
    events.push({ known: false, id, ts: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(), kind, payload });
  };
  while (events.length < n) {
    const lane = lanes[issue % lanes.length]!;
    const cur = issue++;
    push("dispatched", { worker: lane, issue: cur, issueTitle: `issue ${cur}` });
    push("reclaim-done", { worker: lane, issue: cur, next: "DRIVING" });
    if (cur % 5 === 0) push("drive-needs-human", { worker: lane, issue: cur, pr: cur + 10_000 });
    else push("merged", { worker: lane, issue: cur, pr: cur + 10_000 });
  }
  return events.slice(0, n);
}

// ── AC1: scrubTo is the checkpointed O(distance) jump, at the transport's own integration layer ──

test("scrubTo folds only the slice since the nearest checkpoint, never the whole log (spied at player.ts, not just checkpoint.ts)", () => {
  const log = syntheticLog(2200);
  const checkpoints = buildCheckpoints(log, 3);

  let calls = 0;
  let eventsSeen = 0;
  const spy: typeof foldReplay = (state, events) => {
    calls++;
    eventsSeen += events.length;
    return foldReplay(state, events);
  };

  const target = 1537; // 37 events past the id=1500 checkpoint
  scrubTo(log, checkpoints, target, 3, spy);

  assert.equal(calls, 1, "exactly one fold call for a scrub — no per-event looping");
  assert.equal(eventsSeen, target - 1500, "only the distance from the nearest checkpoint, not from event 0");
});

test("scrubTo's cursorIndex lands exactly on the target id's position, ready for playback to resume from", () => {
  const log = syntheticLog(2200);
  const checkpoints = buildCheckpoints(log, 3);
  const pos = scrubTo(log, checkpoints, 1537, 3);
  assert.equal(pos.cursorId, 1537);
  assert.equal(pos.cursorIndex, 1537, "sequential-id synthetic log: index N holds event id N+1, so cursorIndex==id here");
  assert.equal(log[pos.cursorIndex - 1]?.id, 1537);
});

// ── AC2: playback folds incremental slices via foldReplay, never foldToPosition per frame ─────

test("advanceFrame folds exactly one slice per call, sized by speed, directly onto the held state", () => {
  const log = syntheticLog(1000);
  let pos = initialReplayPosition(3);

  let calls = 0;
  let lastSliceLen = 0;
  const spy: typeof foldReplay = (state, events) => {
    calls++;
    lastSliceLen = events.length;
    return foldReplay(state, events);
  };

  pos = advanceFrame(pos, log, 1, spy);
  assert.equal(calls, 1);
  assert.equal(lastSliceLen, BASE_EVENTS_PER_TICK * 1);
  assert.equal(pos.cursorId, log[BASE_EVENTS_PER_TICK - 1]?.id);

  pos = advanceFrame(pos, log, 16, spy);
  assert.equal(calls, 2, "a second frame is exactly one more fold call, not a re-fold from 0");
  assert.equal(lastSliceLen, BASE_EVENTS_PER_TICK * 16);
});

test("playing an entire multi-thousand-event log through advanceFrame calls fold O(n / (speed*tick)) times, never once per event and never a refold from 0 (the sawtooth AC2 bans)", () => {
  const log = syntheticLog(4001);
  let pos = initialReplayPosition(3);

  let calls = 0;
  let totalEventsSeen = 0;
  const spy: typeof foldReplay = (state, events) => {
    calls++;
    totalEventsSeen += events.length;
    return foldReplay(state, events);
  };

  const speed = 16;
  while (!isAtEnd(pos, log)) pos = advanceFrame(pos, log, speed, spy);

  const expectedCalls = Math.ceil(log.length / (BASE_EVENTS_PER_TICK * speed));
  assert.equal(calls, expectedCalls, "one fold call per frame, count independent of how far into the log we are");
  assert.equal(totalEventsSeen, log.length, "every event folded exactly once across the whole play-through");
  assert.equal(pos.cursorId, log[log.length - 1]?.id);
});

test("advanceFrame is a no-op once the log is exhausted, rather than re-folding or throwing", () => {
  const log = syntheticLog(3);
  let pos = initialReplayPosition(null);
  pos = advanceFrame(pos, log, 16);
  assert.ok(isAtEnd(pos, log));
  const again = advanceFrame(pos, log, 16);
  assert.deepEqual(again, pos);
});

// ── fold-equivalence: playing through frame-by-frame matches a full fold, and matches after a scrub ──

test("frame-by-frame playback from the start yields state identical to one full foldReplay(0..N)", () => {
  const log = syntheticLog(1234);
  let pos = initialReplayPosition(3);
  while (!isAtEnd(pos, log)) pos = advanceFrame(pos, log, 4);

  const viaFullReplay = foldReplay(initialReplayState(3), log).state;
  assert.deepEqual(pos.state, viaFullReplay);
});

test("resuming playback after a scrub continues from exactly that position — scrub then play equals a full fold to the same end", () => {
  const log = syntheticLog(2200);
  const checkpoints = buildCheckpoints(log, 3);

  let pos = scrubTo(log, checkpoints, 1200, 3);
  while (!isAtEnd(pos, log)) pos = advanceFrame(pos, log, 4);

  const viaFullReplay = foldReplay(initialReplayState(3), log).state;
  assert.deepEqual(pos.state, viaFullReplay, "scrubbing back then playing forward must reach the same terminal state as one full fold");
});

// ── transportReducer: the UI-intent state machine (play/pause/speed), independent of the fold ──

test("transportReducer: play/pause/setSpeed toggle exactly the fields they own", () => {
  let state = INITIAL_TRANSPORT_STATE;
  assert.deepEqual(state, { playing: false, speed: 1 });

  state = transportReducer(state, { type: "play" });
  assert.equal(state.playing, true);

  state = transportReducer(state, { type: "setSpeed", speed: 16 });
  assert.deepEqual(state, { playing: true, speed: 16 });

  state = transportReducer(state, { type: "pause" });
  assert.equal(state.playing, false);
  assert.equal(state.speed, 16, "pausing does not reset the chosen speed");
});

test("transportReducer: scrub and ended both stop playback, same as an explicit pause", () => {
  const playing = { playing: true, speed: 4 } as const;
  assert.deepEqual(transportReducer(playing, { type: "scrub" }), { playing: false, speed: 4 });
  assert.deepEqual(transportReducer(playing, { type: "ended" }), { playing: false, speed: 4 });
});

test(`buildCheckpoints/CHECKPOINT_INTERVAL are still #740's — player.ts adds no second checkpoint cadence`, () => {
  assert.equal(CHECKPOINT_INTERVAL, 500);
});

// ── cursorTs: the spend cursor's timestamp mapping ──────────────────────────────────────────────

test("cursorTs before anything has folded falls back to the round's own startedAt", () => {
  const log = syntheticLog(10);
  const pos = initialReplayPosition(null);
  assert.equal(cursorTs(pos, log, "2026-08-10T09:00:00Z"), "2026-08-10T09:00:00Z");
});

test("cursorTs after folding reads the LAST folded event's ts, not the fallback", () => {
  const log = syntheticLog(10);
  let pos = initialReplayPosition(null);
  pos = advanceFrame(pos, log, 1);
  const lastFolded = log[pos.cursorIndex - 1]!;
  assert.equal(cursorTs(pos, log, "2026-08-10T09:00:00Z"), lastFolded.ts);
});
