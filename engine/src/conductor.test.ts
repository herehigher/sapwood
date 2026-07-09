// Parity tests for the conductor's pure scheduling core — a faithful port of 0day's
// ops/loop/test_loop_conductor.sh assert table. Same semantics, TS types (booleans for
// the bash 0/1 sentinel/flag args, string[] for the CSV label args). If a row here
// disagrees with the bash row it mirrors, that's a parity regression.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  nextRoundId,
  classifyLane,
  budgetExceeded,
  issuePriority,
  labelsBlockers,
  hasReserveLabel,
  codingFloor,
  isCodingRank,
  metaLaneAllowed,
  laneOnReclaimDone,
  laneOnReclaimFailed,
  driveDecision,
  tick,
  orderForDispatch,
  evaluateCeiling,
  drainEscalationDue,
  engineSessionGapSec,
  ENGINE_SESSION_GAP_SEC,
  type Supervisor,
  type LaneProbe,
  type MergeGate,
  type ReclaimResult,
} from "./conductor.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";
import type { DriveOutcome } from "./merge-driver.js";

// ── tick test doubles (real State, fake forge + supervisor — no claude, no gh) ──
const DEFAULT_PROBE: LaneProbe = { done: false, failed: false, handoff: false, hbAge: 10, wrapperAlive: 1, hasPr: false };

class FakeForge implements IForge {
  ready: Issue[] = [];
  labelsAdded: Array<[number, string]> = [];
  prLabelsAdded: Array<[number, string]> = [];
  boardSet: Array<[number, string]> = [];
  claimed: number[] = [];
  prComments: Array<[number, string]> = [];
  issueComments: Array<[number, string]> = [];
  /** #69 (fable P2a): when true, addLabel throws — proves the drain-escalation still lands its
   *  structured event + terminal transition (best-effort forge, ordered before the upsert). */
  throwOnAddLabel = false;
  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return this.ready; }
  async claimIssue(n: number): Promise<void> { this.claimed.push(n); }
  async setBoardStatus(n: number, s: "ready" | "inProgress" | "done"): Promise<void> { this.boardSet.push([n, s]); }
  async addLabel(n: number, l: string): Promise<void> {
    if (this.throwOnAddLabel) throw new Error("simulated forge failure");
    this.labelsAdded.push([n, l]);
  }
  async addPRLabel(n: number, l: string): Promise<void> { this.prLabelsAdded.push([n, l]); }
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(n: number): Promise<PRStatus> { return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true }; }
  async mergePR(): Promise<void> {}
  async addPRComment(pr: number, body: string): Promise<void> { this.prComments.push([pr, body]); }
  async addIssueComment(n: number, body: string): Promise<void> { this.issueComments.push([n, body]); }
  async getIssueBody(): Promise<string> { return ""; }
  async getPRReviewData(): Promise<PRReviewData> {
    return {
      headOid: "x", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false,
      labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0,
    };
  }
  async countOpenIssuesInMilestone(): Promise<number> { return 0; }
  async listMilestoneTitles(): Promise<string[]> { return []; }
}

class FakeSupervisor implements Supervisor {
  probes: Record<string, LaneProbe> = {};
  dispatched: Issue[] = [];
  reclaimed: string[] = [];
  handoffRequested: string[] = [];
  /** #69: per-lane reclaim result. Default: no worktree ever existed (nothing retained). */
  reclaimResults: Record<string, ReclaimResult> = {};
  /** #69 (fable P3-b): per-lane inspectWorktree result for terminal-sentinel lanes. */
  inspectResults: Record<string, ReclaimResult> = {};
  inspected: string[] = [];
  private n = 0;
  async probe(w: string): Promise<LaneProbe> { return this.probes[w] ?? DEFAULT_PROBE; }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> {
    this.dispatched.push(issue);
    const name = `lane-${++this.n}`;
    return { name, sessionId: `sess-${name}` };
  }
  async reclaim(w: string): Promise<ReclaimResult> {
    this.reclaimed.push(w);
    return this.reclaimResults[w] ?? { worktreePath: null, worktreeRetained: false };
  }
  inspectWorktree(w: string): ReclaimResult {
    this.inspected.push(w);
    return this.inspectResults[w] ?? { worktreePath: null, worktreeRetained: false };
  }
  requestHandoff(w: string): boolean { this.handoffRequested.push(w); return true; }
}

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" }, ...over });

const seedRunning = (st: State, name: string, issue: number) =>
  st.upsertWorker({ name, issue, session_id: `s-${name}`, state: "running", started_at: "t", ended_at: null });

test("orderForDispatch: priority then number; reserve/needs-human + blocked-by filtered out", () => {
  const cfg = mkCfg();
  const issues: Issue[] = [
    { number: 5, title: "", labels: ["prio:3-feature"] },
    { number: 2, title: "", labels: ["prio:0-gov"] },
    { number: 8, title: "", labels: ["prio:3-feature"] },
    { number: 9, title: "", labels: ["reserve"] }, // filtered
    { number: 7, title: "", labels: ["blocked-by:2"] }, // filtered (carries a blocker)
  ];
  const out = orderForDispatch(issues, cfg).map((i) => i.number);
  assert.deepEqual(out, [2, 5, 8]); // gov(0) first, then features by number
});

test("orderForDispatch: the plain `blocked` escalation label is held out of dispatch", () => {
  const cfg = mkCfg(); // escalation.humanLabels defaults to [needs-human, blocked]
  const issues: Issue[] = [
    { number: 1, title: "", labels: ["prio:3-feature"] },
    { number: 2, title: "", labels: ["prio:3-feature", "blocked"] }, // held
    { number: 3, title: "", labels: ["prio:3-feature", "needs-human"] }, // held
  ];
  assert.deepEqual(orderForDispatch(issues, cfg).map((i) => i.number), [1]);
});

test("tick dispatch: claim happens before launch; a claim failure spawns no worker", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"] }];
  forge.claimIssue = async () => { throw new Error("board claim failed"); };
  await assert.rejects(() => tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }));
  assert.deepEqual(sup.dispatched, []); // claim threw first -> nothing launched, no untracked worker
  assert.equal(st.runningWorkers().length, 0);
  st.close();
});

test("tick dispatch: a launch failure rolls the board back to Ready", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"] }];
  sup.dispatch = async () => { throw new Error("spawn failed"); };
  await assert.rejects(() => tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }));
  assert.deepEqual(forge.claimed, [7]); // claimed first
  assert.ok(forge.boardSet.some(([n, s]) => n === 7 && s === "ready")); // then rolled back
  assert.equal(st.runningWorkers().length, 0);
  // The rollback succeeded on the first attempt -> no durable retry marker left behind.
  assert.equal(st.pendingRollbacks().length, 0);
  st.close();
});

// ── #31: double-failure rollback/requeue hardening ──────────────────────────────────────

test("tick dispatch: dispatch AND rollback both fail -> pending rollback persisted, tick still rejects with the dispatch error, retried + recovered next tick", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"] }];
  sup.dispatch = async () => { throw new Error("spawn failed"); };
  let boardFails = true;
  forge.setBoardStatus = async (n, s) => {
    if (boardFails) throw new Error("board transiently unreachable");
    forge.boardSet.push([n, s]);
  };

  // Tick 1: dispatch throws; the rollback attempt (also transient-failing) is caught and
  // durably persisted instead of a bare `.catch(() => {})` swallow — but the ORIGINAL
  // dispatch error is still what propagates (existing contract, unchanged).
  await assert.rejects(() => tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }), /spawn failed/);
  assert.deepEqual(forge.boardSet, []); // rollback attempt failed -> no successful mutation
  const pending = st.pendingRollbacks();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]?.issue, 7);
  assert.equal(pending[0]?.target, "ready");
  assert.equal(pending[0]?.reason, "dispatch-rollback");
  assert.equal(pending[0]?.attempts, 1);

  // Tick 2: forge recovers; no Ready issues this time (isolates the retry phase from a
  // repeat dispatch attempt). The ROLLBACK RETRY phase (runs before dispatch) picks the
  // persisted row up and clears it on success.
  boardFails = false;
  forge.ready = [];
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(r2.rollbacks, [{ kind: "recovered", issue: 7, target: "ready", reason: "dispatch-rollback" }]);
  assert.equal(st.pendingRollbacks().length, 0);
  assert.deepEqual(forge.boardSet, [[7, "ready"]]);
  st.close();
});

test("tick dispatch: rollback keeps failing past the retry cap -> bounded escalation (needs-human + structured event), never a silent swallow", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"] }];
  sup.dispatch = async () => { throw new Error("spawn failed"); };
  forge.setBoardStatus = async () => { throw new Error("board unreachable"); };
  const cfg = mkCfg({ recovery: { rollbackRetryCap: 2 } });

  // Tick 1: dispatch fails; rollback attempt #1 fails -> persisted, attempts=1 (under cap=2).
  await assert.rejects(() => tick({ forge, state: st, supervisor: sup, cfg }));
  assert.equal(st.pendingRollbacks().length, 1);
  assert.equal(st.pendingRollbacks()[0]?.attempts, 1);

  // Tick 2: no Ready issues (isolates the retry). Attempt #2 hits the cap -> escalate: cleared,
  // needs-human label attempted, a structured "escalated" outcome — no zombie retry loop.
  forge.ready = [];
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(r2.rollbacks, [{ kind: "escalated", issue: 7, attempts: 2, reason: "dispatch-rollback" }]);
  assert.equal(st.pendingRollbacks().length, 0);
  assert.deepEqual(forge.labelsAdded, [[7, "needs-human"]]);
  st.close();
});

test("tick reclaim: DEAD lane no-PR requeue failure does not throw or strand the row — persisted + retried next tick and recovers", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-dead", 4);
  sup.probes["lane-dead"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0 };
  forge.setBoardStatus = async () => { throw new Error("board unreachable"); };

  // Unlike the dispatch-rollback path, this one must NOT throw (there's no analogous existing
  // "tick rejects" contract here) — a throw would abort the whole tick over an unrelated dead
  // lane's board mutation, and the worker row is already terminal (`failed`) either way.
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.getWorker("lane-dead")?.state, "failed");
  assert.equal(st.pendingRollbacks().length, 1);
  assert.deepEqual(r.rollbacks, [{ kind: "retrying", issue: 4, attempts: 1, reason: "dead-lane-requeue" }]);
  assert.deepEqual(forge.boardSet, []);

  // Next tick: forge recovers -> the persisted row is retried and cleared.
  forge.setBoardStatus = async (n, s) => { forge.boardSet.push([n, s]); };
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(r2.rollbacks, [{ kind: "recovered", issue: 4, target: "ready", reason: "dead-lane-requeue" }]);
  assert.equal(st.pendingRollbacks().length, 0);
  assert.deepEqual(forge.boardSet, [[4, "ready"]]);
  st.close();
});

test("tick reclaim: DEAD lane no-PR requeue succeeding on the first try leaves no pending rollback (pre-existing path unchanged)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-dead", 4);
  sup.probes["lane-dead"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0 };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(r.reclaimed[0], { kind: "dead", worker: "lane-dead", issue: 4, rescued: false, costUsd: 0, modelUsage: [] });
  assert.deepEqual(r.rollbacks, [{ kind: "recovered", issue: 4, target: "ready", reason: "dead-lane-requeue" }]);
  assert.deepEqual(forge.boardSet, [[4, "ready"]]);
  assert.equal(st.pendingRollbacks().length, 0);
  st.close();
});

test("tick reclaim: KEEP stays, DONE+PR -> done/DRIVING, DONE+noPR -> escalate+needs-human", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-keep", 1);
  seedRunning(st, "lane-donepr", 2);
  seedRunning(st, "lane-donenopr", 3);
  sup.probes["lane-keep"] = { ...DEFAULT_PROBE };
  sup.probes["lane-donepr"] = { ...DEFAULT_PROBE, done: true, hasPr: true };
  sup.probes["lane-donenopr"] = { ...DEFAULT_PROBE, done: true, hasPr: false };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  const byWorker = Object.fromEntries(r.reclaimed.map((o) => [o.worker, o]));
  assert.equal(byWorker["lane-keep"]!.kind, "kept");
  assert.deepEqual(byWorker["lane-donepr"], { kind: "done", worker: "lane-donepr", issue: 2, next: "DRIVING", costUsd: 0, modelUsage: [] });
  assert.deepEqual(byWorker["lane-donenopr"], { kind: "done", worker: "lane-donenopr", issue: 3, next: "ESCALATE_NOPR", costUsd: 0, modelUsage: [] });
  assert.deepEqual(forge.labelsAdded, [[3, "needs-human"]]); // only the no-PR done escalates
  assert.equal(st.getWorker("lane-keep")?.state, "running");
  assert.equal(st.getWorker("lane-donepr")?.state, "driving"); // PR -> lane held for the review gate
  assert.equal(st.getWorker("lane-donenopr")?.state, "done"); // no PR -> lane freed, escalated
  st.close();
});

test("tick reclaim: DEAD lane with NO PR is torn down, board handed back to ready", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-dead", 4);
  sup.probes["lane-dead"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0 };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(r.reclaimed[0], { kind: "dead", worker: "lane-dead", issue: 4, rescued: false, costUsd: 0, modelUsage: [] });
  assert.deepEqual(sup.reclaimed, ["lane-dead"]);
  assert.deepEqual(forge.boardSet, [[4, "ready"]]);
  assert.equal(st.getWorker("lane-dead")?.state, "failed");
  st.close();
});

test("tick reclaim: DEAD lane WITH a PR is rescued to driving, not requeued (Codex R2 P1)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-deadpr", 6);
  sup.probes["lane-deadpr"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0, hasPr: true };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(r.reclaimed[0], { kind: "dead", worker: "lane-deadpr", issue: 6, rescued: true, costUsd: 0, modelUsage: [] });
  assert.deepEqual(sup.reclaimed, ["lane-deadpr"]); // orphan still killed
  assert.deepEqual(forge.boardSet, []); // NOT handed back to Ready (would race the open PR)
  assert.equal(st.getWorker("lane-deadpr")?.state, "driving");
  st.close();
});

// ── #69 dirty-worktree retention: automation never deletes a worktree with possibly-
// uncommitted work — reclaim() reports it retained, and tick() escalates to a human
// (issue comment with the absolute path + needs-human label). Clean -> deleted, no noise. ──

test("tick reclaim: DEAD lane whose dirty worktree was RETAINED -> needs-human label + issue comment carrying the absolute path and lane name", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-dirty", 7);
  sup.probes["lane-dirty"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0 };
  sup.reclaimResults["lane-dirty"] = { worktreePath: "/abs/worktrees/lane-dirty", worktreeRetained: true };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(sup.reclaimed, ["lane-dirty"]);
  assert.deepEqual(r.reclaimed[0], { kind: "dead", worker: "lane-dirty", issue: 7, rescued: false, costUsd: 0, modelUsage: [] });
  assert.deepEqual(forge.labelsAdded, [[7, "needs-human"]]); // human salvages or discards
  assert.equal(forge.issueComments.length, 1);
  assert.equal(forge.issueComments[0]![0], 7);
  assert.match(forge.issueComments[0]![1], /\/abs\/worktrees\/lane-dirty/); // the absolute path
  assert.match(forge.issueComments[0]![1], /lane-dirty/); // the lane name
  st.close();
});

test("tick reclaim: DEAD lane whose worktree was clean (deleted by reclaim) -> no comment, no needs-human (unchanged path)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-clean", 8);
  sup.probes["lane-clean"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0 };
  sup.reclaimResults["lane-clean"] = { worktreePath: "/abs/worktrees/lane-clean", worktreeRetained: false };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(forge.issueComments, []);
  assert.deepEqual(forge.labelsAdded, []); // requeued to Ready, nothing to triage
  assert.deepEqual(forge.boardSet, [[8, "ready"]]);
  st.close();
});

test("tick capacity: a reclaimed DONE+PR (driving) lane still occupies a lane (Codex R2 P2)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // max=1: one lane, already full and the worker is DONE+PR this tick -> becomes driving.
  seedRunning(st, "lane-driving", 2);
  sup.probes["lane-driving"] = { ...DEFAULT_PROBE, done: true, hasPr: true };
  forge.ready = [{ number: 9, title: "", labels: ["prio:3-feature"] }];
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 5 } }) });
  assert.equal(st.getWorker("lane-driving")?.state, "driving");
  assert.deepEqual(sup.dispatched, []); // the driving lane keeps capacity full -> #9 not launched
  assert.ok(r.dispatched.some((d) => d.kind === "skipped" && d.issue === 9 && d.reason === "no-lane"));
  st.close();
});

// ── #13: DRIVE wiring (deps.mergeGate drives `driving` lanes through gates) ──────────────

class FakeMergeGate implements MergeGate {
  // Every call's (pr, issue, triggerPin, fallback lock) — #55 P1-B / #54: proves the conductor
  // threads the lane's State-recorded pin/lock (and its issue number, #46) into driveOne every
  // tick.
  calls: Array<{
    pr: number;
    issue: number;
    triggerPin: { head: string | null; at: string | null };
    fallbackLock?: { head: string | null; kind: string | null };
  }> = [];
  outcomes: Record<number, DriveOutcome> = {};
  defaultOutcome: DriveOutcome = { kind: "queued", pr: 0, reason: "default" };
  /** When set, driveOne invokes the caller-supplied recordTrigger with these values before
   *  returning — simulates MergeDriver posting a fresh trigger and persisting its pin. */
  recordOnCall: [string, string] | null = null;
  /** When set, driveOne invokes the caller-supplied recordFallback with this lock (#54) —
   *  simulates resolveReviewVerdict returning a new lock. */
  recordFallbackOnCall: { head: string | null; kind: string | null } | null = null;
  async driveOne(
    pr: number,
    issue: number,
    triggerPin: { head: string | null; at: string | null },
    recordTrigger: (head: string, at: string) => void,
    fallback?: {
      lock: { head: string | null; kind: string | null };
      recordFallback: (lock: { head: string | null; kind: string | null }) => void;
    },
  ): Promise<DriveOutcome> {
    this.calls.push({ pr, issue, triggerPin, fallbackLock: fallback?.lock });
    if (this.recordOnCall) recordTrigger(...this.recordOnCall);
    if (this.recordFallbackOnCall) fallback?.recordFallback(this.recordFallbackOnCall);
    return this.outcomes[pr] ?? { ...this.defaultOutcome, pr };
  }
}

test("#69 P1 (Codex PR #72): DEAD lane with an open PR AND a retained dirty worktree is NOT auto-driven — lane failed (never driving), needs-human on BOTH the issue and the PR, driveOne never called", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-wip", 4);
  // Crashed after opening PR #77, with uncommitted WIP still in the worktree.
  sup.probes["lane-wip"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0, hasPr: true, prNumber: 77 };
  sup.reclaimResults["lane-wip"] = { worktreePath: "/abs/worktrees/lane-wip", worktreeRetained: true };
  const gate = new FakeMergeGate();
  gate.outcomes[77] = { kind: "merged", pr: 77, headOid: "H" }; // would auto-merge if driven
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

  // The lane is taken OUT of the auto-drive path: failed, not driving.
  assert.equal(st.getWorker("lane-wip")?.state, "failed");
  assert.equal(gate.calls.length, 0); // driveOne never invoked -> no possibility of merge
  assert.deepEqual(r.driven, []);
  // needs-human lands where the merge gate actually reads labels: on the PR (getPRReviewData),
  // not only the source issue.
  assert.deepEqual(forge.prLabelsAdded, [[77, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, [[4, "needs-human"]]);
  assert.equal(forge.issueComments.length, 1); // retained-worktree report
  assert.deepEqual(forge.boardSet, []); // NOT requeued to Ready (would race the open PR)
  assert.deepEqual(r.reclaimed[0], { kind: "dead", worker: "lane-wip", issue: 4, rescued: false, costUsd: 0, modelUsage: [] });
  st.close();
});

test("tick DRIVE: omitted mergeGate -> driving lanes stay driving untouched, driven=[] (pre-#13 behavior)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  assert.equal(st.getWorker("lane-a")?.pr, 55);
  assert.deepEqual(r.driven, []);
  st.close();
});

test("tick DRIVE: merged -> worker done, board set to done, driven records it", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "merged", pr: 55, headOid: "H" };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "done");
  assert.deepEqual(forge.boardSet, [[2, "done"]]);
  assert.deepEqual(r.driven, [{ kind: "merged", worker: "lane-a", issue: 2, pr: 55 }]);
  st.close();
});

test("tick DRIVE: needs-human -> worker failed + needs-human label", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "needs-human", pr: 55, reason: "gate:HUMAN" };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "failed");
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
  assert.deepEqual(r.driven, [{ kind: "needs-human", worker: "lane-a", issue: 2, pr: 55, reason: "gate:HUMAN" }]);
  st.close();
});

test("tick DRIVE: queued -> stays driving (retried next tick), no board/label side effects", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW" };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "driving"); // untouched
  assert.deepEqual(forge.boardSet, []);
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(r.driven, [{ kind: "queued", worker: "lane-a", issue: 2, pr: 55, reason: "gate-pending:WAIT_REVIEW" }]);
  st.close();
});

test("tick DRIVE: stopped (produce-pr-and-stop) -> stays driving, never treated as merged", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "stopped", pr: 55, reason: "gates-passed:MERGE_OK" };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  assert.deepEqual(r.driven, [{ kind: "stopped", worker: "lane-a", issue: 2, pr: 55, reason: "gates-passed:MERGE_OK" }]);
  st.close();
});

test("tick DRIVE: driveOne is called every tick with the lane's issue number (#46, Decision #8 plan-in-trigger) and its State-recorded trigger pin (#55 P1-B)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "waiting" };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 1st tick: DONE -> driving
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 2nd tick: still driving
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 3rd tick: still driving
  // Called once per tick (the trigger-once invariant now lives INSIDE MergeDriver.driveOne,
  // covered by merge-driver.test.ts) — every call carries issue #2 and a null pin (never
  // triggered, per this test's fresh lane).
  assert.equal(gate.calls.length, 3);
  for (const c of gate.calls) {
    assert.equal(c.pr, 55);
    assert.equal(c.issue, 2);
    assert.deepEqual(c.triggerPin, { head: null, at: null });
  }
  st.close();
});

test("tick DRIVE: driveOne's recordTrigger callback persists the pin into State, which the NEXT tick reads back", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "review-triggered" };
  gate.recordOnCall = ["HEAD1", "2026-07-07T08:00:00.000Z"];
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 1st tick: records the pin
  assert.equal(st.getWorker("lane-a")?.review_triggered_head, "HEAD1");
  assert.equal(st.getWorker("lane-a")?.review_triggered_at, "2026-07-07T08:00:00.000Z");

  gate.recordOnCall = null; // 2nd tick: driveOne doesn't re-record (simulating a matched pin)
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(gate.calls[1]!.triggerPin, { head: "HEAD1", at: "2026-07-07T08:00:00.000Z" }); // read back
  st.close();
});

// ── #54: reviewer-failover lock wiring + audit-trail event ────────────────────────────────

test("tick DRIVE: driveOne's recordFallback callback persists the reviewer-failover lock into State, which the NEXT tick reads back", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "waiting" };
  assert.equal(gate.calls.length, 0);
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 1st tick: no lock yet
  assert.deepEqual(gate.calls[0]!.fallbackLock, { head: null, kind: null });

  gate.recordFallbackOnCall = { head: "HEAD1", kind: "same-model-trusted" };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 2nd tick: records the lock
  assert.equal(st.getWorker("lane-a")?.review_fallback_head, "HEAD1");
  assert.equal(st.getWorker("lane-a")?.review_fallback_kind, "same-model-trusted");

  gate.recordFallbackOnCall = null; // 3rd tick: driveOne doesn't re-record
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(gate.calls[2]!.fallbackLock, { head: "HEAD1", kind: "same-model-trusted" }); // read back
  st.close();
});

/** Raw `events` rows, read via a second connection (WAL allows concurrent reads) — asserts
 *  the on-disk table directly rather than adding a State query method purely for test
 *  introspection (same convention as state.test.ts's rawSpendRows, #47). */
function rawEventKinds(path: string): string[] {
  const raw = new DatabaseSync(path);
  try {
    return (raw.prepare("SELECT kind FROM events ORDER BY id").all() as unknown as Array<{ kind: string }>).map(
      (r) => r.kind,
    );
  } finally {
    raw.close();
  }
}

test("tick DRIVE: reviewerTransition -> structured switch/revert events + PR comments, DEDUPED across ticks (#54 R2: driveOne reports statelessly, tick announces once per episode transition)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-drive-failover-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const st = new State(path);
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedRunning(st, "lane-a", 2);
    sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
    const gate = new FakeMergeGate();
    gate.outcomes[55] = {
      kind: "queued", pr: 55, reason: "waiting",
      reviewerTransition: { kind: "switch", mode: "same-model-trusted", head: "H1" },
    };
    const r1 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(st.getWorker("lane-a")?.state, "driving"); // an audit-only announcement, no state change
    assert.deepEqual(r1.driven, [{ kind: "queued", worker: "lane-a", issue: 2, pr: 55, reason: "waiting" }]);
    assert.equal(forge.prComments.length, 1);
    assert.match(forge.prComments[0]![1], /same-model-trusted/);

    // Tick 2: the SAME transition reported again (stateless per-tick signal) -> deduped, no
    // second event, no second comment (a produce-pr-and-stop lane would otherwise spam one
    // comment per tick forever).
    await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(forge.prComments.length, 1);
    assert.equal(rawEventKinds(path).filter((k) => k === "reviewer-fallback-switch").length, 1);

    // Tick 3: a DIFFERENT transition (revert) -> announced (event + comment).
    gate.outcomes[55] = {
      kind: "queued", pr: 55, reason: "waiting",
      reviewerTransition: { kind: "revert", mode: "different-model-codex", head: "H1" },
    };
    await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(forge.prComments.length, 2);
    assert.match(forge.prComments[1]![1], /available again/);

    // Tick 4: the revert reported again -> deduped.
    await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    st.close();

    const kinds = rawEventKinds(path);
    assert.equal(kinds.filter((k) => k === "reviewer-fallback-switch").length, 1);
    assert.equal(kinds.filter((k) => k === "reviewer-fallback-revert").length, 1);
    assert.equal(forge.prComments.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE: a NEW head re-announces the same transition kind (a new episode is not deduped against the old one)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-drive-failover-head-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const st = new State(path);
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedRunning(st, "lane-a", 2);
    sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
    const gate = new FakeMergeGate();
    gate.outcomes[55] = {
      kind: "queued", pr: 55, reason: "waiting",
      reviewerTransition: { kind: "switch", mode: "human", head: "H1" },
    };
    await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    gate.outcomes[55] = {
      kind: "queued", pr: 55, reason: "waiting",
      reviewerTransition: { kind: "switch", mode: "human", head: "H2" }, // pushed -> new episode
    };
    await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    st.close();
    assert.equal(rawEventKinds(path).filter((k) => k === "reviewer-fallback-switch").length, 2);
    assert.equal(forge.prComments.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE: a forged/unknown review_fallback_kind in the state DB fails closed to NO lock at the read boundary (#54 R2, fable-review P2)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "waiting" };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 1st tick: lane -> driving

  // Simulate a forged/corrupt row: the TEXT column holds a kind no Reviewer implements.
  st.recordReviewFallback("lane-a", "HEAD", "totally-bogus-kind");
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  // The gate must see NO lock at all — head nulled too, never a half-valid lock.
  assert.deepEqual(gate.calls[1]!.fallbackLock, { head: null, kind: null });

  // Sanity: a VALID kind round-trips (validation rejects unknowns, not legitimate episodes).
  st.recordReviewFallback("lane-a", "HEAD", "same-model-trusted");
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(gate.calls[2]!.fallbackLock, { head: "HEAD", kind: "same-model-trusted" });
  st.close();
});

test("tick DRIVE: a driving lane with no known PR number fails safe to needs-human (only when mergeGate is configured)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // Seed a driving lane directly with pr=null (as if rescued from a probe with no prNumber).
  st.upsertWorker({ name: "lane-a", issue: 2, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: null });
  const gate = new FakeMergeGate();
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "failed");
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
  assert.deepEqual(r.driven, [{ kind: "needs-human", worker: "lane-a", issue: 2, pr: -1, reason: "driving-lane-missing-pr" }]);
  st.close();
});

// ── #69: kill switch = ONE global gate at the top of tick() — active means the whole tick
// is drain-only (no rollback retry, no reclaim, no drive/merge, no dispatch). Replaces the
// #59/#61/#64 per-phase gates (and their mid-loop re-read semantics: a switch flipped
// mid-tick now takes effect at the NEXT tick's gate — the documented #69 trade-off). ──

test("tick: kill switch active -> DRAIN + TERMINAL-RECLAIM only: no rollback retry, no drive, no dispatch; a still-running lane is drained, not touched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-killswitch-gate-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    // One still-RUNNING (KEEP) lane (would drain), one DRIVING lane with a mergeable PR
    // (would merge), one Ready issue (would dispatch), one pending rollback (would retry).
    seedRunning(st, "lane-run", 2);
    sup.probes["lane-run"] = { ...DEFAULT_PROBE }; // KEEP: alive, no terminal sentinel
    st.upsertWorker({ name: "lane-drv", issue: 3, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 56 });
    forge.ready = [{ number: 9, title: "", labels: ["prio:1-high"] }];
    st.addPendingRollback(7, "ready", "dispatch-rollback", "t");
    const gate = new FakeMergeGate();
    gate.outcomes[56] = { kind: "merged", pr: 56, headOid: "H" };
    writeFileSync(join(dir, "KILL_SWITCH"), ""); // a human flips it — no config touched

    const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

    assert.equal(r.ceilingBreached, true);
    assert.deepEqual(r.ceilingReasons, ["kill-switch"]);
    assert.deepEqual(r.drainRequested, ["lane-run"]); // still-running lane drained
    assert.deepEqual(sup.handoffRequested, ["lane-run"]);
    assert.deepEqual(r.escalated, []); // drain window not elapsed — no hard kill yet
    assert.deepEqual(r.reclaimed, []); // KEEP lane isn't a terminal reclaim
    // Nothing but drain + terminal-reclaim ran:
    assert.deepEqual(r.driven, []); // drive phase skipped
    assert.deepEqual(r.dispatched, []); // dispatch phase skipped (not even "skipped" rows)
    assert.deepEqual(r.rollbacks, []); // rollback retry skipped
    assert.equal(gate.calls.length, 0); // no possibility of forge.mergePR firing
    assert.deepEqual(sup.dispatched, []);
    assert.deepEqual(sup.reclaimed, []);
    assert.deepEqual(forge.claimed, []);
    assert.deepEqual(forge.boardSet, []);
    assert.deepEqual(forge.labelsAdded, []);
    assert.equal(st.getWorker("lane-run")?.state, "running"); // drained, still running next tick
    assert.equal(st.getWorker("lane-drv")?.state, "driving");
    assert.equal(st.pendingRollbacks().length, 1); // still pending — retried once the switch clears
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#69 P2 (Codex PR #72): kill switch active + a lane that already wrote .handoff -> its terminal state IS recorded (handoff), NOT drained or mislabeled failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-killswitch-gate-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    // A worker that drained gracefully mid-window: it wrote .handoff (terminal, resumable).
    seedRunning(st, "lane-ho", 5);
    sup.probes["lane-ho"] = { ...DEFAULT_PROBE, handoff: true, costUsd: 0.4 };
    // A genuinely still-running lane alongside it, to prove drain still happens for non-terminal.
    seedRunning(st, "lane-keep", 6);
    sup.probes["lane-keep"] = { ...DEFAULT_PROBE };
    writeFileSync(join(dir, "KILL_SWITCH"), "");

    const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

    // The handed-off lane's real terminal state is recorded — not left running, not failed.
    assert.equal(st.getWorker("lane-ho")?.state, "handoff");
    assert.deepEqual(r.reclaimed, [{ kind: "handoff", worker: "lane-ho", issue: 5, costUsd: 0.4, modelUsage: [] }]);
    assert.ok(!r.drainRequested.includes("lane-ho")); // terminal -> not re-drained
    assert.ok(!r.escalated.includes("lane-ho")); // never escalated to failed/needs-human
    assert.deepEqual(forge.labelsAdded, []); // no needs-human for a clean graceful handoff
    // The still-running lane is still drained normally.
    assert.deepEqual(r.drainRequested, ["lane-keep"]);
    assert.equal(st.getWorker("lane-keep")?.state, "running");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE: kill switch NOT active -> driveOne called normally (no regression)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-drive-killswitch-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedRunning(st, "lane-a", 2);
    sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
    const gate = new FakeMergeGate();
    gate.outcomes[55] = { kind: "merged", pr: 55, headOid: "H" };
    // No KILL_SWITCH file written — sentinel absent.
    const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(gate.calls.length, 1);
    assert.equal(st.getWorker("lane-a")?.state, "done");
    assert.deepEqual(forge.boardSet, [[2, "done"]]);
    assert.deepEqual(r.driven, [{ kind: "merged", worker: "lane-a", issue: 2, pr: 55 }]);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick: kill switch records a DONE+PR lane's terminal state under the switch (driving), then DRIVE merges it once cleared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-killswitch-gate-"));
  try {
    const switchPath = join(dir, "KILL_SWITCH");
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedRunning(st, "lane-a", 2);
    sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
    const gate = new FakeMergeGate();
    gate.outcomes[55] = { kind: "merged", pr: 55, headOid: "H" };

    writeFileSync(switchPath, "");
    const r1 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(gate.calls.length, 0); // DRIVE skipped under the switch — never merges
    assert.deepEqual(r1.driven, []);
    // #69 P2: the DONE+PR lane's terminal state IS recorded (reclaimed to driving), not drained.
    assert.equal(r1.reclaimed[0]?.kind, "done");
    assert.equal(st.getWorker("lane-a")?.state, "driving");
    assert.deepEqual(r1.drainRequested, []); // terminal lane, not a drain target
    assert.deepEqual(forge.boardSet, []); // not merged yet

    rmSync(switchPath, { force: true }); // human clears the switch
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(gate.calls.length, 1); // the driving lane is now driven -> merged
    assert.deepEqual(r2.driven, [{ kind: "merged", worker: "lane-a", issue: 2, pr: 55 }]);
    assert.equal(st.getWorker("lane-a")?.state, "done");
    assert.deepEqual(forge.boardSet, [[2, "done"]]);
    assert.equal(st.ceilingBreach(), null); // breach record cleared once the switch lifts
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #75: PAUSE — the gentle tier. Unlike the kill switch, a paused tick does NOT drain or
// freeze: reclaim + DRIVE (existing lanes' PR review/merge progression) proceed exactly as
// normal. Only the DISPATCH phase (new-lane creation) is skipped. ──

test("#75 tick: PAUSE active -> dispatch skipped entirely (no new lane, not even a 'skipped' row); reclaim + drive of existing lanes proceed normally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-pause-gate-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    // A still-running (KEEP) lane: must NOT be drained/touched (unlike the kill switch).
    seedRunning(st, "lane-run", 2);
    sup.probes["lane-run"] = { ...DEFAULT_PROBE };
    // A driving lane with a mergeable PR: DRIVE must still merge it under pause.
    st.upsertWorker({ name: "lane-drv", issue: 3, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 56 });
    const gate = new FakeMergeGate();
    gate.outcomes[56] = { kind: "merged", pr: 56, headOid: "H" };
    // A Ready issue that would normally dispatch.
    forge.ready = [{ number: 9, title: "", labels: ["prio:1-high"] }];
    writeFileSync(join(dir, "PAUSE"), ""); // a human touches data/PAUSE — no config touched

    const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

    // Dispatch: nothing happened, no "skipped" rows either — the phase never ran.
    assert.deepEqual(r.dispatched, []);
    assert.deepEqual(forge.claimed, []);
    assert.deepEqual(sup.dispatched, []);
    // Not a ceiling/kill-switch condition: pause is invisible to those fields.
    assert.equal(r.ceilingBreached, false);
    assert.deepEqual(r.ceilingReasons, []);
    assert.deepEqual(r.drainRequested, []);
    assert.deepEqual(r.escalated, []);
    // The still-running lane was left alone — no drain/handoff request under pause.
    assert.deepEqual(sup.handoffRequested, []);
    assert.equal(st.getWorker("lane-run")?.state, "running");
    // DRIVE still ran and merged the driving lane's PR.
    assert.equal(gate.calls.length, 1);
    assert.deepEqual(r.driven, [{ kind: "merged", worker: "lane-drv", issue: 3, pr: 56 }]);
    assert.equal(st.getWorker("lane-drv")?.state, "done");
    assert.deepEqual(forge.boardSet, [[3, "done"]]);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#75 tick: PAUSE + KILL_SWITCH together behaves exactly as KILL alone (stricter wins)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-pause-kill-gate-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedRunning(st, "lane-run", 2);
    sup.probes["lane-run"] = { ...DEFAULT_PROBE };
    st.upsertWorker({ name: "lane-drv", issue: 3, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 56 });
    const gate = new FakeMergeGate();
    gate.outcomes[56] = { kind: "merged", pr: 56, headOid: "H" };
    forge.ready = [{ number: 9, title: "", labels: ["prio:1-high"] }];
    writeFileSync(join(dir, "PAUSE"), "");
    writeFileSync(join(dir, "KILL_SWITCH"), "");

    const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

    // Identical to the kill-switch-alone behavior: drain + terminal-reclaim only.
    assert.equal(r.ceilingBreached, true);
    assert.deepEqual(r.ceilingReasons, ["kill-switch"]);
    assert.deepEqual(r.drainRequested, ["lane-run"]);
    assert.deepEqual(sup.handoffRequested, ["lane-run"]);
    assert.deepEqual(r.driven, []); // DRIVE did NOT run — kill switch, not pause, governs
    assert.equal(gate.calls.length, 0);
    assert.equal(st.getWorker("lane-drv")?.state, "driving"); // unmerged — kill switch blocks DRIVE too
    assert.deepEqual(r.dispatched, []);
    assert.deepEqual(forge.claimed, []);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#75 tick: removing the PAUSE sentinel restores dispatch on the very next tick, no restart / cache needed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-pause-resume-"));
  try {
    const pausePath = join(dir, "PAUSE");
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    forge.ready = [{ number: 9, title: "", labels: ["prio:1-high"] }];

    writeFileSync(pausePath, "");
    const r1 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.deepEqual(r1.dispatched, []);
    assert.equal(st.runningWorkers().length, 0);

    rmSync(pausePath, { force: true }); // human resumes
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.deepEqual(r2.dispatched.map((d) => d.kind), ["dispatched"]);
    assert.equal(st.runningWorkers().length, 1);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick reclaim: handoff sentinel -> resumable, not killed", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-ho", 5);
  sup.probes["lane-ho"] = { ...DEFAULT_PROBE, handoff: true };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(r.reclaimed[0]!.kind, "handoff");
  assert.deepEqual(sup.reclaimed, []); // NOT reclaimed/killed
  assert.equal(st.getWorker("lane-ho")?.state, "handoff");
  st.close();
});

test("tick dispatch: fills lanes by priority up to roundDispatchCap; claims + records workers", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  forge.ready = [
    { number: 8, title: "", labels: ["prio:3-feature"] },
    { number: 2, title: "", labels: ["prio:1-high"] },
    { number: 5, title: "", labels: ["prio:3-feature"] },
  ];
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { roundDispatchCap: 2, max: 3 } }) });
  const dispatched = r.dispatched.filter((d) => d.kind === "dispatched").map((d) => d.issue);
  assert.deepEqual(dispatched, [2, 5]); // #2 (prio1) first, then #5 (prio3, lower number than #8); cap=2 stops before #8
  assert.deepEqual(sup.dispatched.map((i) => i.number), [2, 5]);
  assert.deepEqual(forge.claimed, [2, 5]);
  assert.equal(st.runningWorkers().length, 2);
  assert.ok(r.dispatched.some((d) => d.kind === "skipped" && d.issue === 8 && d.reason === "cap"));
  // Under-ceiling normal operation is unaffected by #14 (no daily/wall-clock/kill-switch
  // breach): dispatch proceeds exactly as before, ceiling fields are all empty/false.
  assert.equal(r.ceilingBreached, false);
  assert.deepEqual(r.ceilingReasons, []);
  assert.deepEqual(r.drainRequested, []);
  assert.deepEqual(r.escalated, []);
  st.close();
});

test("tick dispatch: skips in-flight issue, respects max lanes, and over-budget halts dispatch", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-x", 2); // #2 already in flight
  forge.ready = [{ number: 2, title: "", labels: [] }, { number: 3, title: "", labels: [] }];
  // over budget: roundSpend 50 > default roundBudgetUsd 30
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), roundSpendUsd: 50 });
  assert.equal(r.overBudget, true);
  assert.ok(r.dispatched.some((d) => d.kind === "skipped" && d.issue === 2 && d.reason === "in-flight"));
  assert.ok(r.dispatched.some((d) => d.kind === "skipped" && d.issue === 3 && d.reason === "over-budget"));
  assert.deepEqual(sup.dispatched, []); // nothing dispatched
  st.close();
});

test("tick dispatch anti-starvation: a meta issue yields a reserved coding lane when coding waits", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // max=2 -> codingFloor=1, meta cap=1. Two meta (rank<=2) + one coding waiting:
  // first meta takes its 1 allowed lane; second meta must yield to the waiting coding issue.
  forge.ready = [
    { number: 1, title: "", labels: ["prio:0-gov"] }, // meta
    { number: 2, title: "", labels: ["prio:1-high"] }, // meta
    { number: 3, title: "", labels: ["prio:3-feature"] }, // coding
  ];
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { max: 2, roundDispatchCap: 2 } }) });
  const dispatched = r.dispatched.filter((d) => d.kind === "dispatched").map((d) => d.issue).sort((a, b) => a - b);
  assert.deepEqual(dispatched, [1, 3]); // one meta (#1) + the coding issue (#3); #2 meta yields the floor
  assert.ok(r.dispatched.some((d) => d.kind === "skipped" && d.issue === 2 && d.reason === "meta-floor"));
  st.close();
});

test("nextRoundId: dirty/missing -> 1, else prev+1", () => {
  assert.equal(nextRoundId(""), 1); // no prior round -> r1
  assert.equal(nextRoundId(undefined), 1); // missing arg -> r1
  assert.equal(nextRoundId("6"), 7);
  assert.equal(nextRoundId("1"), 2);
  assert.equal(nextRoundId("abc"), 1); // dirty -> 1 (never negative/crash)
  assert.equal(nextRoundId("0"), 1); // 0 is not a >=1 start -> 1
  assert.equal(nextRoundId("3x"), 1); // half-dirty -> 1
  assert.equal(nextRoundId(6), 7); // numeric form also accepted
});

test("classifyLane: failed > done > (wrapper-dead | hb-timeout) -> DEAD > KEEP", () => {
  // args: done, failed, hbAge, threshold, wrapperAlive(1 alive | 0 dead | -1 unknown)
  assert.equal(classifyLane(false, false, 30, 600, 1), "KEEP"); // alive, fresh hb, unfinished
  assert.equal(classifyLane(false, false, -1, 600, 1), "KEEP"); // alive, no hb file (just spawned)
  assert.equal(classifyLane(true, false, 30, 600, 1), "DONE");
  assert.equal(classifyLane(true, false, 30, 600, 0), "DONE"); // done sentinel beats dead wrapper
  assert.equal(classifyLane(false, true, 30, 600, 1), "FAILED");
  assert.equal(classifyLane(true, true, 30, 600, 1), "FAILED"); // done+failed -> conservatively FAILED
  assert.equal(classifyLane(false, true, 30, 600, 0), "FAILED"); // failed beats everything
  assert.equal(classifyLane(false, false, 601, 600, 1), "DEAD"); // hb past threshold
  assert.equal(classifyLane(false, false, 600, 600, 1), "KEEP"); // exactly threshold -> not yet over
  assert.equal(classifyLane(false, false, 30, 600, 0), "DEAD"); // fresh hb but wrapper confirmed dead, no sentinel
  assert.equal(classifyLane(false, false, -1, 600, 0), "DEAD"); // no hb + wrapper dead
  assert.equal(classifyLane(false, false, 30, 600, -1), "KEEP"); // liveness unknown + fresh hb -> don't kill
  assert.equal(classifyLane(false, false, -1, 600, -1), "KEEP"); // unknown + no hb (just spawned)
});

test("budgetExceeded: total > cap (float); equal is not over", () => {
  assert.equal(budgetExceeded(5.01, 5), true);
  assert.equal(budgetExceeded(5, 5), false);
  assert.equal(budgetExceeded(0, 5), false);
  assert.equal(budgetExceeded(20.5, 20), true);
  assert.equal(budgetExceeded(0, 0), false);
});

test("issuePriority: min prio:N-* across labels, default 3", () => {
  assert.equal(issuePriority(["prio:0-gov", "type:ops"]), 0);
  assert.equal(issuePriority(["type:feature", "prio:1-decision"]), 1);
  assert.equal(issuePriority(["prio:2-blocking-ux"]), 2);
  assert.equal(issuePriority(["prio:3-feature"]), 3);
  assert.equal(issuePriority(["prio:4-fe-polish"]), 4);
  assert.equal(issuePriority(["type:feature"]), 3); // no prio label -> default 3
  assert.equal(issuePriority([]), 3); // empty -> 3
  assert.equal(issuePriority(["prio:3-feature", "prio:0-gov"]), 0); // multiple -> highest priority (min rank)
});

test("issuePriority: bare init-created labels (prio:N, no suffix) are recognized (Codex R4)", () => {
  // sapwood init.ts creates bare prio:0..3; the real repo also uses suffixed prio:1-high.
  // Both must rank (diverges from the bash twin, which only matched the hyphenated form).
  assert.equal(issuePriority(["prio:0"]), 0);
  assert.equal(issuePriority(["prio:1"]), 1);
  assert.equal(issuePriority(["prio:3"]), 3);
  assert.equal(issuePriority(["prio:2", "prio:0"]), 0); // min across bare labels
  assert.equal(issuePriority(["prio:00"]), 3); // malformed -> no match -> default
});

test("labelsBlockers: parse blocked-by:[#]N, ascending", () => {
  assert.deepEqual(labelsBlockers(["blocked-by:42", "type:feature"]), [42]);
  assert.deepEqual(labelsBlockers(["blocked-by:42", "blocked-by:7"]), [7, 42]);
  assert.deepEqual(labelsBlockers(["type:feature", "prio:3-feature"]), []);
  assert.deepEqual(labelsBlockers([]), []);
  assert.deepEqual(labelsBlockers(["blocked-by:#42", "type:feature"]), [42]); // doc format with # tolerated
  assert.deepEqual(labelsBlockers(["blocked-by:#42", "blocked-by:7"]), [7, 42]); // mixed #/no-#
});

test("hasReserveLabel: any of the reserve-ish labels present", () => {
  const reserveish = ["reserve", "needs-human"];
  assert.equal(hasReserveLabel(["reserve", "type:decision"], reserveish), true);
  assert.equal(hasReserveLabel(["needs-human"], reserveish), true);
  assert.equal(hasReserveLabel(["type:feature", "prio:3-feature"], reserveish), false);
  assert.equal(hasReserveLabel([], reserveish), false);
});

test("codingFloor: ceil(L/2) reserved coding lanes", () => {
  assert.equal(codingFloor(1), 1);
  assert.equal(codingFloor(2), 1);
  assert.equal(codingFloor(3), 2);
  assert.equal(codingFloor(4), 2);
});

test("isCodingRank: rank >= 3 (feature/fe-polish)", () => {
  assert.equal(isCodingRank(3), true);
  assert.equal(isCodingRank(4), true);
  assert.equal(isCodingRank(2), false); // blocking-ux is meta, not coding-floor
  assert.equal(isCodingRank(1), false);
  assert.equal(isCodingRank(0), false);
});

test("metaLaneAllowed: cap = L - codingFloor(L); allow if under cap or no coding waiting", () => {
  assert.equal(metaLaneAllowed(2, 0, 1), true); // L2 cap1: cur0<1 -> allow
  assert.equal(metaLaneAllowed(2, 1, 1), false); // cur1>=cap1 and coding waiting -> deny (reserve floor)
  assert.equal(metaLaneAllowed(2, 1, 0), true); // at cap but no coding waiting -> allow (don't idle a lane)
  assert.equal(metaLaneAllowed(4, 1, 3), true); // L4 cap2: cur1<2 -> allow
});

test("laneOnReclaimDone: has PR -> DRIVING, else ESCALATE_NOPR (fail-safe)", () => {
  assert.equal(laneOnReclaimDone(true), "DRIVING");
  assert.equal(laneOnReclaimDone(false), "ESCALATE_NOPR");
});

test("laneOnReclaimFailed: has PR -> DRIVING (rescue), else ESCALATE", () => {
  assert.equal(laneOnReclaimFailed(true), "DRIVING");
  assert.equal(laneOnReclaimFailed(false), "ESCALATE");
});

// ── #14: engine cost ceiling + kill switch ──────────────────────────────────────────────

test("evaluateCeiling: no breach when under both caps", () => {
  const reasons = evaluateCeiling({
    dailySpendUsd: 10, dailyBudgetUsd: 100, wallClockElapsedSec: 100, maxWallClockSec: 14400,
  });
  assert.deepEqual(reasons, []);
});

test("evaluateCeiling: daily budget / wall-clock each independently breach (#69: the kill switch is no longer a ceiling reason — it's tick()'s global gate)", () => {
  const base = { dailySpendUsd: 10, dailyBudgetUsd: 100, wallClockElapsedSec: 10, maxWallClockSec: 14400 };
  assert.deepEqual(evaluateCeiling({ ...base, dailySpendUsd: 101 }), ["daily-budget"]);
  assert.deepEqual(evaluateCeiling({ ...base, wallClockElapsedSec: 14401 }), ["wall-clock"]);
  assert.deepEqual(evaluateCeiling({ ...base, dailySpendUsd: 100 }), []); // equal is NOT over
});

test("evaluateCeiling: multiple simultaneous breaches report in fixed order (daily, wall-clock)", () => {
  const reasons = evaluateCeiling({
    dailySpendUsd: 200, dailyBudgetUsd: 100, wallClockElapsedSec: 99999, maxWallClockSec: 14400,
  });
  assert.deepEqual(reasons, ["daily-budget", "wall-clock"]);
});

test("drainEscalationDue: bounded by drainWindowSec; equal-at-window is NOT yet due", () => {
  const breachAt = "2026-07-06T00:00:00.000Z";
  const t0 = Date.parse(breachAt);
  assert.equal(drainEscalationDue(breachAt, t0 + 60_000, 60), false); // exactly at window
  assert.equal(drainEscalationDue(breachAt, t0 + 60_001, 60), true); // just past
  assert.equal(drainEscalationDue(breachAt, t0, 60), false); // no time elapsed
});

test("tick ceiling: daily budget breach freezes ALL new dispatch + drains running workers", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-run", 1);
  sup.probes["lane-run"] = { ...DEFAULT_PROBE }; // alive, KEEP — the lane to drain
  // A previously-completed worker's cost, already over the daily cap.
  st.recordSpend("lane-earlier", 99, 500, new Date().toISOString());
  forge.ready = [{ number: 2, title: "", labels: ["prio:3-feature"] }];
  const cfg = mkCfg({ cost: { dailyBudgetUsd: 10 } });
  const r = await tick({ forge, state: st, supervisor: sup, cfg });

  assert.equal(r.ceilingBreached, true);
  assert.deepEqual(r.ceilingReasons, ["daily-budget"]);
  assert.deepEqual(r.dispatched, [{ kind: "skipped", issue: 2, reason: "ceiling" }]);
  assert.deepEqual(sup.dispatched, []); // nothing launched
  assert.deepEqual(r.drainRequested, ["lane-run"]); // the running worker was asked to hand off
  assert.deepEqual(sup.handoffRequested, ["lane-run"]);
  assert.deepEqual(r.escalated, []); // drain window not yet elapsed on first detection
  st.close();
});

test("tick: out-of-band kill switch (file sentinel, engine data dir) -> drain-only tick, nothing dispatched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ceiling-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedRunning(st, "lane-run", 1);
    sup.probes["lane-run"] = { ...DEFAULT_PROBE };
    forge.ready = [{ number: 5, title: "", labels: ["prio:3-feature"] }];
    assert.equal(st.isKillSwitchActive(), false); // no sentinel yet
    writeFileSync(join(dir, "KILL_SWITCH"), ""); // a human flips it — no config touched
    const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.equal(r.ceilingBreached, true);
    assert.deepEqual(r.ceilingReasons, ["kill-switch"]);
    assert.deepEqual(r.dispatched, []); // #69 global gate: DISPATCH never even ran
    assert.deepEqual(sup.dispatched, []);
    assert.deepEqual(sup.handoffRequested, ["lane-run"]);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick: kill switch escalates to a hard kill only after the bounded drain window elapses; a retained dirty worktree is reported to a human", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ceiling-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const st = new State(dbPath);
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedRunning(st, "lane-run", 3);
    sup.probes["lane-run"] = { ...DEFAULT_PROBE };
    // #69: the escalation hard-kill's reclaim finds possibly-uncommitted work — the worktree
    // must survive and the human must be told where it is.
    sup.reclaimResults["lane-run"] = { worktreePath: "/wt/lane-run", worktreeRetained: true };
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const cfg = mkCfg({ cost: { drainWindowSec: 60 } });
    let clock = new Date("2026-07-06T00:00:00Z");
    const now = () => clock;

    const r1 = await tick({ forge, state: st, supervisor: sup, cfg, now });
    assert.equal(r1.ceilingBreached, true);
    assert.deepEqual(r1.drainRequested, ["lane-run"]);
    assert.deepEqual(r1.escalated, []); // just breached — still within the drain window
    assert.equal(st.getWorker("lane-run")?.state, "running"); // not yet touched

    clock = new Date(clock.getTime() + 61_000); // past drainWindowSec, still breached
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now });
    assert.deepEqual(r2.escalated, ["lane-run"]);
    assert.deepEqual(sup.reclaimed, ["lane-run"]); // hard process-tree kill (drain exhausted)
    assert.equal(st.getWorker("lane-run")?.state, "failed");
    assert.deepEqual(forge.labelsAdded, [[3, "needs-human"]]); // fail-safe: human triage
    assert.equal(forge.issueComments.length, 1); // retained-worktree report
    assert.equal(forge.issueComments[0]![0], 3);
    assert.match(forge.issueComments[0]![1], /\/wt\/lane-run/);
    assert.match(forge.issueComments[0]![1], /lane-run/);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#69 P2a (fable): drain-escalation of a retained-dirty lane with a PR -> needs-human on issue AND PR + retained report; a throwing addLabel does NOT orphan it (event lands, still marked failed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ceiling-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedRunning(st, "lane-run", 3);
    // A drained lane that crashed with WIP + an open PR; probe surfaces the PR number.
    sup.probes["lane-run"] = { ...DEFAULT_PROBE, hasPr: true, prNumber: 88 };
    sup.reclaimResults["lane-run"] = { worktreePath: "/wt/lane-run", worktreeRetained: true };
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const cfg = mkCfg({ cost: { drainWindowSec: 60 } });
    let clock = new Date("2026-07-06T00:00:00Z");
    const now = () => clock;

    await tick({ forge, state: st, supervisor: sup, cfg, now }); // detect breach
    clock = new Date(clock.getTime() + 61_000); // past the drain window -> escalate
    // addLabel throws on the escalation — the lane must STILL be recorded failed + event landed.
    forge.throwOnAddLabel = true;
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now });

    assert.deepEqual(r2.escalated, ["lane-run"]); // the loop ran to completion past the throw
    assert.equal(st.getWorker("lane-run")?.state, "failed"); // terminal transition still happened
    // needs-human landed on the PR (best-effort survives the issue-label throw), and the
    // retained-worktree comment landed too — the throw never orphaned the lane.
    assert.deepEqual(forge.prLabelsAdded, [[88, "needs-human"]]);
    assert.equal(forge.issueComments.length, 1);
    assert.match(forge.issueComments[0]![1], /\/wt\/lane-run/);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#69 P3b (fable): a .failed-sentinel lane with an open PR AND a dirty worktree is NOT auto-driven — inspected, escalated to needs-human (issue + PR), never rescued to driving", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-fail-wip", 9);
  // .failed sentinel + open PR would normally rescue to driving; but the worktree is dirty.
  sup.probes["lane-fail-wip"] = { ...DEFAULT_PROBE, failed: true, hasPr: true, prNumber: 91 };
  sup.inspectResults["lane-fail-wip"] = { worktreePath: "/wt/lane-fail-wip", worktreeRetained: true };
  const gate = new FakeMergeGate();
  gate.outcomes[91] = { kind: "merged", pr: 91, headOid: "H" }; // would merge if driven
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

  assert.deepEqual(sup.inspected, ["lane-fail-wip"]); // dirty check ran on the terminal lane
  assert.equal(st.getWorker("lane-fail-wip")?.state, "failed"); // NOT driving
  assert.equal(gate.calls.length, 0); // never driven -> never merged
  assert.deepEqual(r.driven, []);
  assert.deepEqual(forge.labelsAdded, [[9, "needs-human"]]);
  assert.deepEqual(forge.prLabelsAdded, [[91, "needs-human"]]); // where the merge gate reads labels
  assert.equal(forge.issueComments.length, 1);
  assert.equal(r.reclaimed[0]?.kind, "failed");
  st.close();
});

test("#69 P3b (fable): a .failed-sentinel lane with an open PR and a CLEAN worktree still rescues to driving (no regression)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-fail-clean", 9);
  sup.probes["lane-fail-clean"] = { ...DEFAULT_PROBE, failed: true, hasPr: true, prNumber: 92 };
  sup.inspectResults["lane-fail-clean"] = { worktreePath: "/wt/lane-fail-clean", worktreeRetained: false };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(sup.inspected, ["lane-fail-clean"]);
  assert.equal(st.getWorker("lane-fail-clean")?.state, "driving"); // clean -> rescued as before
  assert.equal(st.getWorker("lane-fail-clean")?.pr, 92);
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.prLabelsAdded, []);
  st.close();
});

test("tick ceiling: wall-clock breaches on continuous ticking but RECOVERS after an operator pause (Codex R2 P1)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ cost: { maxWallClockSec: 600 } }); // 10-min cap for the test
  let clock = new Date("2026-07-06T00:00:00Z");
  const now = () => clock;
  const tickAt = async (iso: string) => {
    clock = new Date(iso);
    return tick({ forge, state: st, supervisor: sup, cfg, now });
  };

  // Continuous ticking (5-min intervals, under the 15-min session gap): the session start
  // never moves, so elapsed accumulates past the 600s cap -> wall-clock breach at t=15min.
  assert.equal((await tickAt("2026-07-06T00:00:00Z")).ceilingBreached, false);
  assert.equal((await tickAt("2026-07-06T00:05:00Z")).ceilingBreached, false);
  forge.ready = [{ number: 4, title: "", labels: ["prio:3-feature"] }]; // arrives pre-breach
  const breached = await tickAt("2026-07-06T00:15:00Z"); // 900s elapsed > 600s cap
  assert.equal(breached.ceilingBreached, true);
  assert.deepEqual(breached.ceilingReasons, ["wall-clock"]);
  assert.deepEqual(breached.dispatched, [{ kind: "skipped", issue: 4, reason: "ceiling" }]);

  // An operator pause longer than the session gap (15min) resets the session — the data dir
  // is NOT permanently breached (the original engineStartedAt design was). Dispatch resumes.
  const recovered = await tickAt("2026-07-06T00:31:00Z"); // 16-min gap since the last tick
  assert.equal(recovered.ceilingBreached, false);
  assert.equal(st.ceilingBreach(), null); // the breach record cleared -> a re-breach gets a fresh drain window
  assert.ok(recovered.dispatched.some((d) => d.kind === "dispatched" && d.issue === 4));
  st.close();
});

test("engineSessionGapSec: scales with tick cadence — max(base, 2x); unknown/garbage cadence -> base", () => {
  assert.equal(engineSessionGapSec(0), ENGINE_SESSION_GAP_SEC); // unknown/self-paced
  assert.equal(engineSessionGapSec(60), ENGINE_SESSION_GAP_SEC); // fast cadence: base wins
  assert.equal(engineSessionGapSec(450), ENGINE_SESSION_GAP_SEC); // 2x450=900: base still wins (ties to base)
  assert.equal(engineSessionGapSec(1200), 2400); // slow cadence: 2x cadence wins
  assert.equal(engineSessionGapSec(-5), ENGINE_SESSION_GAP_SEC); // garbage -> fail-safe base
  assert.equal(engineSessionGapSec(NaN), ENGINE_SESSION_GAP_SEC);
  assert.equal(engineSessionGapSec(Infinity), ENGINE_SESSION_GAP_SEC);
});

test("tick ceiling PINNING: a legal slow cadence (>= 15min) must NOT void the wall-clock tier (gate② PR #41 P2)", async () => {
  // With a fixed 900s stale gap, ticking every 20min made EVERY tick look stale: the session
  // reset each tick, elapsed ~= 0 forever, and the wall-clock ceiling silently never fired.
  // With tickIntervalSec passed, the gap scales to 2x cadence and the tier stays live.
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ cost: { maxWallClockSec: 600 } }); // 10-min cap
  let clock = new Date("2026-07-06T00:00:00Z");
  const now = () => clock;
  const tickAt = async (iso: string) => {
    clock = new Date(iso);
    return tick({ forge, state: st, supervisor: sup, cfg, now, tickIntervalSec: 1200 }); // 20-min cadence
  };
  assert.equal((await tickAt("2026-07-06T00:00:00Z")).ceilingBreached, false);
  // t=20min: gap since last tick is 1200s. Old behavior: 1200 > 900 -> session resets ->
  // elapsed 0 -> NO breach, tier dead. Fixed behavior: gap = max(900, 2x1200) = 2400 ->
  // session holds -> elapsed 1200 > 600 cap -> breach. This test fails on the old behavior.
  const r = await tickAt("2026-07-06T00:20:00Z");
  assert.equal(r.ceilingBreached, true);
  assert.deepEqual(r.ceilingReasons, ["wall-clock"]);
  st.close();
});

test("tick ceiling: daily spend accumulates across ticks and SURVIVES a State reopen (restart-safe)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ceiling-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    let st = new State(dbPath);
    const forge = new FakeForge();
    const cfg = mkCfg({ cost: { dailyBudgetUsd: 50 } });

    // First engine "session": a worker completes with PR, cost 40 — under the 50 cap.
    const sup1 = new FakeSupervisor();
    seedRunning(st, "lane-a", 1);
    sup1.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, costUsd: 40 };
    const r1 = await tick({ forge, state: st, supervisor: sup1, cfg });
    assert.equal(r1.ceilingBreached, false);
    st.close();

    // Reopen the SAME db path — simulates an engine restart. The ledger must survive.
    st = new State(dbPath);
    const sup2 = new FakeSupervisor();
    seedRunning(st, "lane-b", 2);
    sup2.probes["lane-b"] = { ...DEFAULT_PROBE, done: true, hasPr: true, costUsd: 20 };
    const r2 = await tick({ forge, state: st, supervisor: sup2, cfg });
    // 40 (persisted from before the restart) + 20 (this session) = 60 > 50 -> breached. If the
    // restart had reset the accumulator this would read 20 and stay under budget.
    assert.equal(r2.ceilingBreached, true);
    assert.deepEqual(r2.ceilingReasons, ["daily-budget"]);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("driveDecision: gate + fix rounds -> scheduling action (fail-safe ESCALATE)", () => {
  assert.equal(driveDecision("MERGE", 0, 3, false), "MERGE");
  assert.equal(driveDecision("WAIT", 0, 3, false), "WAIT");
  assert.equal(driveDecision("FIXABLE", 0, 3, false), "FIXUP"); // under cap -> dispatch fixup
  assert.equal(driveDecision("FIXABLE", 2, 3, false), "FIXUP");
  assert.equal(driveDecision("FIXABLE", 3, 3, false), "ESCALATE"); // at cap -> human
  assert.equal(driveDecision("FIXABLE", 0, 3, true), "ESCALATE"); // over budget -> no new fixup worker
  assert.equal(driveDecision("FIXABLE", NaN, 3, false), "ESCALATE"); // non-number rounds -> fail-safe
  assert.equal(driveDecision("HUMAN", 0, 3, false), "ESCALATE");
  assert.equal(driveDecision("", 0, 3, false), "ESCALATE"); // empty/unknown gate -> fail-safe
  assert.equal(driveDecision("WHATEVER", 0, 3, false), "ESCALATE");
});
