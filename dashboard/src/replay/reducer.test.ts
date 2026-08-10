import assert from "node:assert/strict";
import test from "node:test";
import type { DomainEvent } from "../domain-event.ts";
import { foldEntityTitles, foldOpenAttention } from "../entities.ts";
import { foldEvents, initialHeroState } from "../hero/state.ts";
import { foldReplay, initialReplayState, type ReplayState } from "./reducer.ts";

let seq = 0;
const ev = (kind: string, payload: Record<string, unknown> = {}): DomainEvent => ({
  known: false,
  id: ++seq,
  ts: new Date(Date.UTC(2026, 6, 24, 12, 0, seq)).toISOString(),
  kind,
  payload,
});

test("initialReplayState seeds an empty hero/titles/openAttention triple", () => {
  const state = initialReplayState(3);
  assert.deepEqual(state, { hero: initialHeroState(3), titles: {}, openAttention: {} });
});

test("foldReplay is exactly the composition of the three pre-existing fold primitives — same output, one call", () => {
  const events = [
    ev("pool-selected", { issues: [86] }),
    ev("dispatched", { worker: "w1", issue: 86, issueTitle: "Fix the thing" }),
    ev("reclaim-done", { worker: "w1", issue: 86, next: "DRIVING" }),
    ev("drive-needs-human", { worker: "w1", issue: 86, pr: 90 }),
  ];

  const seed = initialReplayState(2);
  const { state: combined, transitions } = foldReplay(seed, events);

  // The independently-computed expectation: the SAME three primitives, called separately, over
  // the SAME event batch — proving `foldReplay` invents no new folding logic of its own.
  const { state: expectedHero, transitions: expectedTransitions } = foldEvents(seed.hero, events);
  const expectedTitles = foldEntityTitles(events, seed.titles);
  const expectedOpenAttention = foldOpenAttention(events, seed.openAttention);

  assert.deepEqual(combined.hero, expectedHero);
  assert.deepEqual(combined.titles, expectedTitles);
  assert.deepEqual(combined.openAttention, expectedOpenAttention);
  assert.deepEqual(transitions, expectedTransitions);
});

test("foldReplay is id-idempotent through hero's own lastId guard when re-fed an overlapping batch", () => {
  const first = [ev("dispatched", { worker: "w1", issue: 1 })];
  const seed = initialReplayState(1);
  const { state: afterFirst } = foldReplay(seed, first);

  // Re-folding the exact same (already-applied) event must not move the droplet again — hero's
  // `foldEvents` already guards on `id > state.lastId`; this pins that the composition preserves
  // the guard rather than bypassing it.
  const { state: afterReplay, transitions } = foldReplay(afterFirst, first);
  assert.deepEqual(afterReplay.hero, afterFirst.hero);
  assert.deepEqual(transitions, []);
});

test("foldReplay accumulates across successive batches (the live-tail pattern)", () => {
  let state: ReplayState = initialReplayState(1);
  const batch1 = [ev("dispatched", { worker: "w1", issue: 1, issueTitle: "Alpha" })];
  ({ state } = foldReplay(state, batch1));
  assert.equal(state.titles[1]?.issueTitle, "Alpha");
  assert.equal(state.hero.lanes[0]?.phase, "writing");

  const batch2 = [ev("reclaim-done", { worker: "w1", issue: 1, next: "DRIVING" })];
  ({ state } = foldReplay(state, batch2));
  assert.equal(state.hero.lanes[0]?.phase, "driving");
  // titles fold onto the seed across calls, same as before — first-title-wins, never forgotten.
  assert.equal(state.titles[1]?.issueTitle, "Alpha");
});
