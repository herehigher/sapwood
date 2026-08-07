/**
 * #716 gate② P1-1: `buildPlayback` is the pure sequencing/endpoint layer whose bug this PR
 * fixes — a batch containing `dispatched` then `reclaim-done` for the SAME issue used to
 * animate the `dispatched` leg straight to the checkpoint (the batch's FINAL position),
 * skipping the backlog→lane beat, while two un-sequenced timelines wrote conflicting
 * transforms onto the same element. These tests pin: each step's endpoints come from ITS OWN
 * intermediate scene, and animating steps never overlap in time. Zero DOM, zero anime.js,
 * zero timers — orchestration coverage the repo's "no timing-dependent tests" rule permits.
 */

import assert from "node:assert/strict";
import test from "node:test";
import type { DomainEvent } from "../domain-event.ts";
import { BEAT, buildPlayback, RING_STROKE, stepDuration, TRAVEL } from "./playback.ts";
import { foldEvents, initialHeroState } from "./state.ts";

let seq = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}): DomainEvent => ({
  known: false,
  id: ++seq,
  ts: new Date(Date.UTC(2026, 6, 24, 12, 0, seq)).toISOString(),
  kind,
  payload,
});

const run = (events: DomainEvent[], lanesMax: number | null = 3) => foldEvents(initialHeroState(lanesMax), events);

test("P1-1: a same-poll dispatch→to-checkpoint batch animates each leg against its OWN intermediate scene, sequenced", () => {
  const { state, steps } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
  ]);
  assert.equal(steps.length, 2);

  const { playback } = buildPlayback(steps, state, 3, new Map());
  assert.equal(playback.length, 2);
  const [dispatch, toCheckpoint] = playback;
  assert.ok(dispatch && toCheckpoint);
  assert.equal(dispatch.transition.kind, "dispatch");
  assert.equal(toCheckpoint.transition.kind, "to-checkpoint");
  assert.ok(dispatch.animate);
  assert.ok(toCheckpoint.animate);

  // The bug: `dispatch`'s `to` must be the LANE position (its own step's destination), never
  // the checkpoint (the batch's FINAL position, which is only where the SECOND step lands).
  assert.ok(dispatch.to);
  assert.ok(toCheckpoint.to);
  assert.notDeepEqual(dispatch.to, toCheckpoint.to, "dispatch must not animate straight to the final (checkpoint) position");

  // Chained: the second step's origin is exactly the first step's destination.
  assert.deepEqual(toCheckpoint.from, dispatch.to);

  // Sequenced, not concurrent: the second step starts no earlier than the first one ends.
  assert.ok(toCheckpoint.offset >= dispatch.offset + dispatch.duration, `${toCheckpoint.offset} < ${dispatch.offset + dispatch.duration}`);
  assert.equal(dispatch.offset, 0);
  assert.equal(dispatch.duration, stepDuration("dispatch"));
});

test("P1-1: a droplet's chain continues correctly across SEPARATE poll batches, not just within one", () => {
  const first = run([ev("dispatched", { worker: "w1", issue: 86 })]);
  const { playback: firstPlayback, finalPoints } = buildPlayback(first.steps, first.state, 3, new Map());
  assert.equal(firstPlayback.length, 1);
  const dispatch = firstPlayback[0];
  assert.ok(dispatch?.animate);

  // The next poll's fold, continuing from where the first left off — `finalPoints` becomes
  // the caller's new `previous`, exactly as Hero.tsx's own effect threads it between renders.
  const second = foldEvents(first.state, [ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 })]);
  const { playback: secondPlayback } = buildPlayback(second.steps, second.state, 3, finalPoints);
  assert.equal(secondPlayback.length, 1);
  const toCheckpoint = secondPlayback[0];
  assert.ok(toCheckpoint);

  // The second poll's travel must start from where the FIRST poll actually left the droplet
  // (the lane), never from a fresh "first-seen" origin guess.
  assert.deepEqual(toCheckpoint.from, dispatch.to);
});

test("P1-1: a non-animating (coalesced) step contributes zero to the timeline and does not advance the cursor", () => {
  const { state, steps } = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("dispatched", { worker: "w2", issue: 2 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 11 }),
    ev("merged", { worker: "w1", issue: 1, pr: 11 }),
    ev("dispatched", { worker: "w3", issue: 3 }),
  ]);
  assert.equal(steps.length, 5);

  const { playback } = buildPlayback(steps, state, 3, new Map());
  assert.deepEqual(
    playback.map((p) => p.animate),
    [false, false, false, true, false],
  );
  // Every non-animating step carries a zero duration and never advances the shared cursor —
  // only the ring (the sole animating step here) gets a real offset/duration.
  for (const p of playback) {
    if (p.animate) continue;
    assert.equal(p.duration, 0);
  }
  const ring = playback.find((p) => p.animate);
  assert.ok(ring);
  assert.equal(ring.offset, 0);
  assert.equal(ring.duration, stepDuration("ring"));
  assert.equal(ring.duration, TRAVEL - BEAT + RING_STROKE);
});

test("P1-1: reduced motion marks every step non-animating, with zero-duration/no-overlap offsets throughout", () => {
  const { state, steps } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
  ]);

  const { playback } = buildPlayback(steps, state, 3, new Map(), { reducedMotion: true });
  assert.ok(playback.every((p) => !p.animate));
  assert.ok(playback.every((p) => p.offset === 0 && p.duration === 0));
});

test("P1-1: finalPoints always reflects the FINAL state, regardless of what animated", () => {
  const { state, steps } = run([
    ev("dispatched", { worker: "w1", issue: 86 }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING", pr: 97 }),
  ]);
  const { finalPoints } = buildPlayback(steps, state, 3, new Map());
  assert.equal(finalPoints.size, 1);
  assert.ok(finalPoints.has(86));
});

test("P1-1: buildPlayback caps lane channel resolution through the same visibleLanes view stage.tsx draws (#716 gate② P1-9)", () => {
  // A dispatch onto a channel beyond `lanesMax` (the raw fold's own overflow behaviour) must
  // still resolve to a CAPPED, renumbered channel — never the raw (possibly huge) index.
  const events: DomainEvent[] = [];
  for (let i = 1; i <= 5; i++) {
    events.push(ev("dispatched", { worker: `w${i}`, issue: i }));
    events.push(ev("reclaim-failed", { worker: `w${i}`, issue: i, next: "ESCALATE" }));
  }
  events.push(ev("dispatched", { worker: "w6", issue: 6 }));
  const { state, steps } = run(events, 2);

  const { playback } = buildPlayback(steps, state, 2, new Map());
  const lastDispatch = [...playback].reverse().find((p) => p.transition.kind === "dispatch" && p.transition.issue === 6);
  assert.ok(lastDispatch);
  assert.ok(
    lastDispatch.laneChannel !== null && lastDispatch.laneChannel < 2,
    `expected a capped channel < 2, got ${lastDispatch.laneChannel}`,
  );
});

test("#716 gate② round 2 P1-3: two non-coalesced merges in ONE poll carry DISTINCT ring numbers, sequenced", () => {
  // Two issues already parked at checkpoint from a PRIOR poll; THIS poll's only fresh events
  // are their two `merged`s — exactly 2 transitions, within COALESCE_AFTER, so BOTH animate.
  // Codex's finding: Hero.tsx used to target the sole `data-current="true"` ring for every
  // "ring" step, so both merges animated the SAME (newest) circle. The data-correctness half
  // of that fix — each transition carrying its OWN ring number, distinctly — is pinned here;
  // the DOM `data-ring="${transition.ring}"` selector itself lives in Hero.tsx, untestable
  // without a browser (see this file's header + the PR's own documented coverage boundary).
  const first = run([
    ev("dispatched", { worker: "w1", issue: 1 }),
    ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING", pr: 11 }),
    ev("dispatched", { worker: "w2", issue: 2 }),
    ev("reclaim-done", { worker: "w2", issue: 2, next: "DRIVING", pr: 12 }),
  ]);
  const second = foldEvents(first.state, [
    ev("merged", { worker: "w1", issue: 1, pr: 11 }),
    ev("merged", { worker: "w2", issue: 2, pr: 12 }),
  ]);
  assert.equal(second.transitions.length, 2);
  assert.ok(second.transitions.every((t) => t.kind === "ring"));

  const { playback } = buildPlayback(second.steps, second.state, 3, new Map());
  assert.equal(playback.length, 2);
  const [ring1, ring2] = playback;
  assert.ok(ring1 && ring2);
  assert.ok(ring1.animate && ring2.animate, "both merges are within COALESCE_AFTER — both must animate");
  assert.ok(ring1.transition.kind === "ring" && ring2.transition.kind === "ring");
  assert.notEqual(ring1.transition.ring, ring2.transition.ring, "each merge must target its OWN ring, never the same one twice");

  // Sequenced: the second flash's window starts no earlier than the first one's ends —
  // otherwise the DOM code's scheduled add/remove for each step's gate flash would overlap
  // (Codex's second symptom).
  assert.ok(ring2.offset >= ring1.offset + ring1.duration, `${ring2.offset} < ${ring1.offset + ring1.duration}`);
});
