// lane-state-label.ts tests (#399): the PR-side lane-state mirror — the ledger-derived belief
// fold, the per-transition apply/clear, the idle-tick dedupe, the crash-restart heal, and the
// fail-closed removal guard. Pure functions plus one `:memory:` State and a two-method fake
// forge — no clock, no timers (the module reads neither).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import { State } from "../state/state.js";
import {
  LANE_STATE_CLEARED,
  LANE_STATE_LABELED,
  lanesCarryingStateLabel,
  removeLaneStateLabel,
  syncLaneStateLabels,
} from "./lane-state-label.js";

const mkCfg = (): SapwoodConfig => ConfigSchema.parse({ board: { owner: "owner", repo: "r", projectNumber: 1 } });

/** The only two forge members this feature touches. `failAdd`/`failRemove` script the
 *  ambiguous-write arms. */
class FakeForge extends UnstubbedForge implements IForge {
  added: Array<[number, string]> = [];
  removed: Array<[number, string]> = [];
  failAdd = false;
  failRemove = false;
  override async addPRLabel(pr: number, label: string): Promise<void> {
    if (this.failAdd) throw new Error("gh exploded");
    this.added.push([pr, label]);
  }
  override async removePRLabel(pr: number, label: string): Promise<void> {
    if (this.failRemove) throw new Error("gh exploded");
    this.removed.push([pr, label]);
  }
}

const lane = (name: string, issue: number, state: "running" | "driving" | "fixing" | "done" | "failed", pr: number | null) => ({
  name,
  issue,
  session_id: `s-${name}`,
  state,
  started_at: "2026-08-03T00:00:00.000Z",
  ended_at: null,
  ...(pr == null ? {} : { pr }),
});

const deps = (forge: FakeForge, state: State, cfg: SapwoodConfig) => ({ forge, state, cfg, log: () => {} });

// ── lanesCarryingStateLabel: the ledger-derived belief fold ──────────────────────────────────

test("lanesCarryingStateLabel: latest-wins per (worker, pr) — a label opens the belief, a clear closes it", () => {
  const ev = (kind: string, worker: string, pr: number) => ({ kind, payload: { worker, issue: 1, pr } });
  assert.deepEqual(lanesCarryingStateLabel([]), []);
  assert.deepEqual(lanesCarryingStateLabel([ev(LANE_STATE_LABELED, "lane-a", 7)]), [{ worker: "lane-a", pr: 7 }]);
  assert.deepEqual(lanesCarryingStateLabel([ev(LANE_STATE_LABELED, "lane-a", 7), ev(LANE_STATE_CLEARED, "lane-a", 7)]), []);
  // Scoped to (worker, pr), like every other lane-scoped fold: a lane repointed to a new PR does
  // not inherit the prior PR's belief.
  const repointed = [ev(LANE_STATE_LABELED, "lane-a", 7), ev(LANE_STATE_CLEARED, "lane-a", 8)];
  assert.deepEqual(lanesCarryingStateLabel(repointed), [{ worker: "lane-a", pr: 7 }]);
});

test("lanesCarryingStateLabel: a malformed payload is skipped, never thrown", () => {
  assert.deepEqual(lanesCarryingStateLabel([{ kind: LANE_STATE_LABELED, payload: null }]), []);
  assert.deepEqual(lanesCarryingStateLabel([{ kind: LANE_STATE_LABELED, payload: { worker: "a" } }]), []);
});

// ── the state-transition fixtures (AC1) ──────────────────────────────────────────────────────

test("#399 AC1: drive -> fix -> merge — the lane-state label lands once when the lane starts driving, is NOT re-applied for the fix leg, and is gone once the lane merges", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();

  state.upsertWorker(lane("lane-a", 1, "driving", 42));
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(forge.added, [[42, cfg.labels.laneState]]);

  // The lane goes into a fix leg: still actively worked, so the label stays — and is not rewritten.
  state.upsertWorker(lane("lane-a", 1, "fixing", 42));
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.equal(forge.added.length, 1, "a driving -> fixing transition is not a second label write");
  assert.deepEqual(forge.removed, []);

  // Merged: the lane is terminal, so the PR must not keep advertising a driver.
  state.upsertWorker({ ...lane("lane-a", 1, "done", 42), ended_at: "2026-08-03T01:00:00.000Z" });
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(forge.removed, [[42, cfg.labels.laneState]]);
  assert.deepEqual(lanesCarryingStateLabel(state.eventsAfterId(0, [LANE_STATE_LABELED, LANE_STATE_CLEARED])), []);
  state.close();
});

test("#399 AC1: drive -> escalate (failed lane) strips the label, and a DEAD lane that never carried one is left alone", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();

  state.upsertWorker(lane("lane-a", 1, "driving", 42));
  await syncLaneStateLabels(deps(forge, state, cfg));
  state.upsertWorker({ ...lane("lane-a", 1, "failed", 42), ended_at: "2026-08-03T01:00:00.000Z" });
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(forge.removed, [[42, cfg.labels.laneState]]);

  // A lane that died before it ever drove a PR: nothing was believed, nothing is written.
  const before = forge.removed.length;
  state.upsertWorker({ ...lane("lane-b", 2, "failed", 43), ended_at: "2026-08-03T01:00:00.000Z" });
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.equal(forge.removed.length, before, "a lane the engine never labelled is never un-labelled");
  state.close();
});

test("#399 AC1: a PR-less lane is never labelled — the label's carrier is the PR, and there is nothing to carry it", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  state.upsertWorker(lane("lane-a", 1, "running", null));
  await syncLaneStateLabels(deps(forge, state, mkCfg()));
  assert.deepEqual(forge.added, []);
  state.close();
});

// ── dedupe (AC3) ─────────────────────────────────────────────────────────────────────────────

test("#399 AC3: a steady-state fixing lane writes NOTHING across N idle ticks — the #383 event-spam lesson, dedup on the ledger not the signal", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  state.upsertWorker(lane("lane-a", 1, "fixing", 42));
  for (let tick = 0; tick < 10; tick++) await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(forge.added, [[42, cfg.labels.laneState]], "one write, not ten");
  assert.deepEqual(forge.removed, []);
  assert.equal(state.eventsAfterId(0, [LANE_STATE_LABELED]).length, 1, "one event, not ten");
  state.close();
});

test("#399 AC3: a terminal lane's clear is written once — idle ticks after it re-derive the same answer and write nothing", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  state.upsertWorker(lane("lane-a", 1, "driving", 42));
  await syncLaneStateLabels(deps(forge, state, cfg));
  state.upsertWorker({ ...lane("lane-a", 1, "done", 42), ended_at: "2026-08-03T01:00:00.000Z" });
  for (let tick = 0; tick < 5; tick++) await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(forge.removed, [[42, cfg.labels.laneState]]);
  state.close();
});

// ── crash / write-failure heal (AC2) ─────────────────────────────────────────────────────────

test("#399 AC2: a crash-restart strips a stale PR-side lane-state label — the belief outlives the process, so the first sweep after the restart heals the merged PR", async () => {
  const state = new State(":memory:");
  const cfg = mkCfg();
  // The pre-crash engine: labelled the PR while it drove, then died mid-transition — the lane row
  // is terminal (the merge landed) but the PR still carries the label.
  state.appendEvent(LANE_STATE_LABELED, { worker: "lane-a", issue: 1, pr: 42 });
  state.upsertWorker({ ...lane("lane-a", 1, "done", 42), ended_at: "2026-08-03T01:00:00.000Z" });

  const forge = new FakeForge();
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(forge.removed, [[42, cfg.labels.laneState]]);
  state.close();
});

test("#399 AC2: a FAILED removal keeps the belief standing so the next tick retries — a stranded label is never written off", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  state.appendEvent(LANE_STATE_LABELED, { worker: "lane-a", issue: 1, pr: 42 });
  state.upsertWorker({ ...lane("lane-a", 1, "done", 42), ended_at: "2026-08-03T01:00:00.000Z" });

  forge.failRemove = true;
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(lanesCarryingStateLabel(state.eventsAfterId(0, [LANE_STATE_LABELED, LANE_STATE_CLEARED])), [
    { worker: "lane-a", pr: 42 },
  ]);

  forge.failRemove = false;
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(forge.removed, [[42, cfg.labels.laneState]]);
  state.close();
});

test("#399: a FAILED apply retracts the belief so the next tick retries the label — and a terminal lane in between never issues a removal for a label that was never applied", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  state.upsertWorker(lane("lane-a", 1, "driving", 42));

  forge.failAdd = true;
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(forge.added, []);
  assert.deepEqual(lanesCarryingStateLabel(state.eventsAfterId(0, [LANE_STATE_LABELED, LANE_STATE_CLEARED])), []);

  forge.failAdd = false;
  await syncLaneStateLabels(deps(forge, state, cfg));
  assert.deepEqual(forge.added, [[42, cfg.labels.laneState]]);
  state.close();
});

// ── the fail-closed removal guard (AC4) ──────────────────────────────────────────────────────

test("#399 AC4: removeLaneStateLabel refuses every label but the configured lane-state one — needs-human, blocked and a hold label all throw, and not one reaches the forge", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  await assert.rejects(() => removeLaneStateLabel(forge, cfg, 1, cfg.labels.needsHuman), /refusing to remove/);
  await assert.rejects(() => removeLaneStateLabel(forge, cfg, 1, cfg.labels.blocked), /refusing to remove/);
  await assert.rejects(() => removeLaneStateLabel(forge, cfg, 1, cfg.escalation.holdLabels[0] as string), /refusing to remove/);
  await assert.rejects(() => removeLaneStateLabel(forge, cfg, 1, cfg.labels.humanMergeOnly), /refusing to remove/);
  await assert.rejects(() => removeLaneStateLabel(forge, cfg, 1, cfg.labels.roundPool), /refusing to remove/);
  await assert.rejects(() => removeLaneStateLabel(forge, cfg, 1, "some-arbitrary-label"), /refusing to remove/);
  assert.deepEqual(forge.removed, [], "not one rejected call ever reached the forge");

  await removeLaneStateLabel(forge, cfg, 1, cfg.labels.laneState); // the ONE allowed label
  assert.deepEqual(forge.removed, [[1, cfg.labels.laneState]]);
});

test("#399 AC4: the guard matches case-insensitively, like every other label comparison in the engine", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  await removeLaneStateLabel(forge, cfg, 1, cfg.labels.laneState.toUpperCase());
  assert.deepEqual(forge.removed, [[1, cfg.labels.laneState.toUpperCase()]]);
});

// ── config: the label may not alias a protected one (the roundPool guard's shape) ─────────────

test("#399: config load rejects labels.laneState aliasing any protected label — the engine auto-removes it, so an alias would forge a human-release signature", () => {
  const base = { board: { owner: "o", repo: "r", projectNumber: 1 } };
  for (const alias of ["sapwood:needs-human", "sapwood:blocked", "sapwood:hold", "sapwood:round:pool", "sapwood:human-merge-only"]) {
    assert.throws(
      () => ConfigSchema.parse({ ...base, labels: { laneState: alias } }),
      /laneState/,
      `aliasing labels.laneState onto ${alias} must be rejected`,
    );
  }
});
