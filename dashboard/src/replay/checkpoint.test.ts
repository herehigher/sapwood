import assert from "node:assert/strict";
import test from "node:test";
import type { DomainEvent } from "../domain-event.ts";
import { buildCheckpoints, CHECKPOINT_INTERVAL, foldToPosition } from "./checkpoint.ts";
import { foldReplay, initialReplayState } from "./reducer.ts";

/** A synthetic, multi-lane, multi-kind log — dispatch/drive/merge cycles across three lanes,
 *  with an escalation branch on every 5th issue, so the fold actually exercises lanes, droplets,
 *  rings, titles, AND open attention, not just one repeated no-op kind. Sequential ids 1..n. */
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

// ── checkpoint cadence ─────────────────────────────────────────────────────────────────────────

test(`buildCheckpoints places one checkpoint every ${CHECKPOINT_INTERVAL} events, none for a trailing partial batch`, () => {
  const log = syntheticLog(2200);
  const checkpoints = buildCheckpoints(log, 3);
  assert.equal(checkpoints.length, Math.floor(2200 / CHECKPOINT_INTERVAL));
  assert.deepEqual(
    checkpoints.map((c) => c.atId),
    [500, 1000, 1500, 2000],
  );
});

test("buildCheckpoints places zero checkpoints under one full interval", () => {
  const log = syntheticLog(499);
  assert.deepEqual(buildCheckpoints(log, 3), []);
});

// ── O(distance) scrub — spy proves folding starts from the nearest checkpoint, not event 0 ─────

test("foldToPosition folds only the slice since the nearest checkpoint, never the whole log", () => {
  const log = syntheticLog(2200);
  const checkpoints = buildCheckpoints(log, 3);

  let calls = 0;
  let eventsSeen = 0;
  const spy: typeof foldReplay = (state, events) => {
    calls++;
    eventsSeen += events.length;
    return foldReplay(state, events);
  };

  // Target sits 37 events past the id=1500 checkpoint — folding from scratch would process 1537
  // events; folding from the nearest checkpoint processes only the 37-event distance.
  const target = 1537;
  foldToPosition(log, checkpoints, target, 3, spy);

  assert.equal(calls, 1, "exactly one fold call — no per-event looping through this seam");
  assert.equal(eventsSeen, target - 1500, "only the distance from the nearest checkpoint, not from event 0");
});

test("foldToPosition below the first checkpoint folds from the initial state (no checkpoint to use yet)", () => {
  const log = syntheticLog(2200);
  const checkpoints = buildCheckpoints(log, 3);

  let eventsSeen = 0;
  const spy: typeof foldReplay = (state, events) => {
    eventsSeen += events.length;
    return foldReplay(state, events);
  };

  foldToPosition(log, checkpoints, 200, 3, spy);
  assert.equal(eventsSeen, 200);
});

// ── fold-equivalence property: checkpoint→N === 0→N ─────────────────────────────────────────────

test("folding to position N from a checkpoint yields state identical to folding 0→N", () => {
  const log = syntheticLog(2600);
  const checkpoints = buildCheckpoints(log, 3);

  for (const target of [1, 250, 500, 501, 999, 1500, 1501, 2000, 2599, 2600]) {
    const viaCheckpoint = foldToPosition(log, checkpoints, target, 3);
    const fromScratch = log.filter((e) => e.id <= target);
    const viaFullReplay = foldReplay(initialReplayState(3), fromScratch).state;
    assert.deepEqual(viaCheckpoint, viaFullReplay, `mismatch at target ${target}`);
  }
});
