// Parity tests for the conductor's pure scheduling core — a faithful port of 0day's
// ops/loop/test_loop_conductor.sh assert table. Same semantics, TS types (booleans for
// the bash 0/1 sentinel/flag args, string[] for the CSV label args). If a row here
// disagrees with the bash row it mirrors, that's a parity regression.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigSchema, loadConfig, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import { type DriveOutcome, MergeDriver } from "../roles/merge-driver.js";
import { CODEX_REVIEWER_LOGINS, CodexReviewer } from "../roles/reviewer.js";
import { WorkerSupervisor } from "../roles/worker.js";
import { State, type WorkerRow } from "../state/state.js";
import {
  budgetExceeded,
  capHitEscalationNote,
  classifyLane,
  codingFloor,
  drainEscalationDue,
  driveDecision,
  ENGINE_SESSION_GAP_SEC,
  engineSessionGapSec,
  evaluateCeiling,
  gatedReentryDecision,
  hasReserveLabel,
  isCodingRank,
  issuePriority,
  type LaneProbe,
  labelsBlockers,
  laneOnReclaimDone,
  laneOnReclaimFailed,
  type MergeGate,
  metaLaneAllowed,
  nextRoundId,
  orderForDispatch,
  type ReclaimResult,
  resumeDecision,
  type Supervisor,
  startFixLeg,
  tick,
} from "./conductor.js";

// ── tick test doubles (real State, fake forge + supervisor — no claude, no gh) ──
const DEFAULT_PROBE: LaneProbe = {
  done: false,
  failed: false,
  handoff: false,
  hbAge: 10,
  wrapperAlive: 1,
  dispatchedAgeSec: 10,
  hasPr: false,
};

class FakeForge implements IForge {
  async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  ready: Issue[] = [];
  readyReads = 0;
  labelsAdded: Array<[number, string]> = [];
  prLabelsAdded: Array<[number, string]> = [];
  boardSet: Array<[number, string]> = [];
  claimed: number[] = [];
  prComments: Array<[number, string]> = [];
  issueComments: Array<[number, string]> = [];
  merged: Array<[number, string]> = [];
  /** #69 (fable P2a): when true, addLabel throws — proves the drain-escalation still lands its
   *  structured event + terminal transition (best-effort forge, ordered before the upsert). */
  throwOnAddLabel = false;
  /** #147: per-issue label set — mutable so a test can simulate a human removing needs-human
   *  mid-run. addLabel appends here too (so a label the ENGINE adds is reflected back), never
   *  removes (only a test directly mutating this map models a human's removal). */
  issueLabelsByIssue: Record<number, string[]> = {};
  /** #147: mutable per-PR gate①/gate② inputs for tests that drive a REAL MergeDriver +
   *  Reviewer through conductor.tick() (as opposed to the FakeMergeGate below, which bypasses
   *  these entirely). Defaults reproduce the old static fixtures byte-for-byte, so every
   *  existing FakeMergeGate-based test is unaffected. */
  prStatus: PRStatus = { number: 0, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  prReviewData: PRReviewData = {
    headOid: "x",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    reviews: [],
    unresolvedThreads: 0,
  };
  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  async getReadyIssues(): Promise<Issue[]> {
    this.readyReads++;
    return this.ready;
  }
  async claimIssue(n: number): Promise<void> {
    this.claimed.push(n);
  }
  async setBoardStatus(n: number, s: "backlog" | "ready" | "inProgress" | "done"): Promise<void> {
    this.boardSet.push([n, s]);
  }
  async addLabel(n: number, l: string): Promise<void> {
    if (this.throwOnAddLabel) throw new Error("simulated forge failure");
    this.labelsAdded.push([n, l]);
    const cur = this.issueLabelsByIssue[n] ?? [];
    if (!cur.includes(l)) this.issueLabelsByIssue[n] = [...cur, l];
  }
  labelsRemoved: Array<[number, string]> = [];
  async removeLabel(n: number, l: string): Promise<void> {
    this.labelsRemoved.push([n, l]);
    this.issueLabelsByIssue[n] = (this.issueLabelsByIssue[n] ?? []).filter((x) => x !== l);
  }
  async addPRLabel(n: number, l: string): Promise<void> {
    this.prLabelsAdded.push([n, l]);
    if (!this.prReviewData.labels.includes(l)) this.prReviewData = { ...this.prReviewData, labels: [...this.prReviewData.labels, l] };
  }
  async openPR(): Promise<number> {
    return 1;
  }
  async getPRStatus(n: number): Promise<PRStatus> {
    return { ...this.prStatus, number: n };
  }
  async mergePR(pr: number, headOid: string): Promise<void> {
    this.merged.push([pr, headOid]);
  }
  async addPRComment(pr: number, body: string): Promise<void> {
    this.prComments.push([pr, body]);
  }
  async addIssueComment(n: number, body: string): Promise<void> {
    this.issueComments.push([n, body]);
  }
  async getIssueBody(): Promise<string> {
    return "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
  }
  async getPRReviewData(): Promise<PRReviewData> {
    return this.prReviewData;
  }
  async getPRDiff(): Promise<string> {
    return "";
  }
  async getCommitsSince(): Promise<CommitInfo[]> {
    return [];
  }
  async branchExists(): Promise<boolean> {
    return false;
  }
  async countOpenIssuesInMilestone(): Promise<number> {
    return 0;
  }
  async listMilestoneTitles(): Promise<string[]> {
    return [];
  }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return [];
  }
  async getIssueLabels(n: number): Promise<string[]> {
    return this.issueLabelsByIssue[n] ?? [];
  }
  async getIssueComments() {
    return [];
  }
  async createIssue(): Promise<number> {
    return 0;
  }
  async listOpenIssueNumbers(): Promise<number[]> {
    return [];
  }
  async listOpenIssues(): Promise<Issue[]> {
    return [];
  }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return [];
  }
}

class FakeSupervisor implements Supervisor {
  probes: Record<string, LaneProbe> = {};
  dispatched: Issue[] = [];
  reclaimed: string[] = [];
  resumed: Array<{ issue: Issue; worker: string }> = [];
  resumeIntents: Record<string, "none" | "confirmed" | "unconfirmed"> = {};
  handoffRequested: string[] = [];
  /** #69: per-lane reclaim result. Default: no worktree ever existed (nothing retained). */
  reclaimResults: Record<string, ReclaimResult> = {};
  /** #69 (fable P3-b): per-lane inspectWorktree result for terminal-sentinel lanes. */
  inspectResults: Record<string, ReclaimResult> = {};
  inspected: string[] = [];
  private n = 0;
  async probe(w: string): Promise<LaneProbe> {
    return this.probes[w] ?? DEFAULT_PROBE;
  }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> {
    this.dispatched.push(issue);
    const name = `lane-${++this.n}`;
    return { name, sessionId: `sess-${name}` };
  }
  /** #245: records the opts a caller passed (prompt/proxy) so tests can assert startFixLeg's
   *  own shape without a real forge MCP proxy or a spawned claude process. */
  resumeCalls: Array<{ issue: Issue; worker: string; opts?: { proxy?: unknown; prompt?: string; sessionId?: string } }> = [];
  resumeShouldThrow: string | null = null;
  async resume(
    issue: Issue,
    worker: string,
    opts?: { proxy?: unknown; prompt?: string; sessionId?: string },
  ): Promise<{ name: string; sessionId: string }> {
    this.resumed.push({ issue, worker });
    this.resumeCalls.push({ issue, worker, opts });
    if (this.resumeShouldThrow) throw new Error(this.resumeShouldThrow);
    return { name: worker, sessionId: `s-${worker}` };
  }
  resumeIntentState(worker: string): "none" | "confirmed" | "unconfirmed" {
    return this.resumeIntents[worker] ?? "none";
  }
  async reclaim(w: string): Promise<ReclaimResult> {
    this.reclaimed.push(w);
    return this.reclaimResults[w] ?? { worktreePath: null, worktreeRetained: false };
  }
  inspectWorktree(w: string): ReclaimResult {
    this.inspected.push(w);
    return this.inspectResults[w] ?? { worktreePath: null, worktreeRetained: false };
  }
  requestHandoff(w: string): boolean {
    if (this.handoffRequested.includes(w)) return false;
    this.handoffRequested.push(w);
    return true;
  }
  /** #245 round-2 fix (B1): records every lane cleared, so tests can assert
   *  reconcileDrivingFixIntents calls this on adoption. */
  clearedFixEntrySentinels: string[] = [];
  clearStaleFixEntrySentinel(w: string): void {
    this.clearedFixEntrySentinels.push(w);
  }
}

const LEGACY_LABEL_CONFIG = {
  labels: {
    prefix: "",
    inProgress: "in-progress",
    needsHuman: "needs-human",
    blocked: "blocked",
    reserve: "reserve",
    verifyNa: "verify:n/a",
    planApproved: "plan:approved",
    originAgent: "origin:agent",
  },
  escalation: { humanLabels: ["needs-human", "blocked"] },
};

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" }, ...LEGACY_LABEL_CONFIG, ...over });

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
  assert.deepEqual(
    orderForDispatch(issues, cfg).map((i) => i.number),
    [1],
  );
});

test("tick dispatch: claim happens before launch; a claim failure spawns no worker", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"] }];
  forge.claimIssue = async () => {
    throw new Error("board claim failed");
  };
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
  sup.dispatch = async () => {
    throw new Error("spawn failed");
  };
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
  sup.dispatch = async () => {
    throw new Error("spawn failed");
  };
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
  sup.dispatch = async () => {
    throw new Error("spawn failed");
  };
  forge.setBoardStatus = async () => {
    throw new Error("board unreachable");
  };
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
  forge.setBoardStatus = async () => {
    throw new Error("board unreachable");
  };

  // Unlike the dispatch-rollback path, this one must NOT throw (there's no analogous existing
  // "tick rejects" contract here) — a throw would abort the whole tick over an unrelated dead
  // lane's board mutation, and the worker row is already terminal (`failed`) either way.
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.getWorker("lane-dead")?.state, "failed");
  assert.equal(st.pendingRollbacks().length, 1);
  assert.deepEqual(r.rollbacks, [{ kind: "retrying", issue: 4, attempts: 1, reason: "dead-lane-requeue" }]);
  assert.deepEqual(forge.boardSet, []);

  // Next tick: forge recovers -> the persisted row is retried and cleared.
  forge.setBoardStatus = async (n, s) => {
    forge.boardSet.push([n, s]);
  };
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
  assert.deepEqual(byWorker["lane-donenopr"], {
    kind: "done",
    worker: "lane-donenopr",
    issue: 3,
    next: "ESCALATE_NOPR",
    costUsd: 0,
    modelUsage: [],
  });
  assert.deepEqual(forge.labelsAdded, [[3, "needs-human"]]); // only the no-PR done escalates
  assert.equal(st.getWorker("lane-keep")?.state, "running");
  assert.equal(st.getWorker("lane-donepr")?.state, "driving"); // PR -> lane held for the review gate
  assert.equal(st.getWorker("lane-donenopr")?.state, "done"); // no PR -> lane freed, escalated
  st.close();
});

// ── #223: terminal worker state + settled spend must be ONE atomic transaction, and any forge
//   write must run strictly AFTER it — a crash or thrown forge call between separate writes
//   used to leave a lane terminal (out of reclaim forever) with its cost never reaching
//   spend_ledger, silently under-counting every ledger consumer including the dailyBudgetUsd
//   hard safety ceiling. ─────────────────────────────────────────────────────────────────────

test("#223: recordSpend throwing rolls back the WHOLE terminal transition — the worker stays reclaimable (never terminal-without-spend); a clean retry commits state+spend exactly once", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-x", 30);
  sup.probes["lane-x"] = { ...DEFAULT_PROBE, done: true, hasPr: false, costUsd: 4.5 };

  // Fake state: recordSpend throws (simulates a crash/corruption at the ledger write) —
  // settleTerminalWorker's own BEGIN/COMMIT/ROLLBACK must undo the terminal upsertWorker too.
  const realRecordSpend = st.recordSpend.bind(st);
  st.recordSpend = () => {
    throw new Error("simulated recordSpend failure");
  };
  await assert.rejects(() => tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }), /simulated recordSpend failure/);
  assert.equal(st.getWorker("lane-x")?.state, "running", "terminal transition rolled back with the failed spend write");
  assert.equal(st.spentUsdForWorker("lane-x"), 0);
  assert.deepEqual(forge.labelsAdded, [], "the transaction never committed, so the (now-correctly-ordered) label write never ran");

  // Rerun: recordSpend recovers — the SAME still-`running` lane reclaims and records exactly once.
  st.recordSpend = realRecordSpend;
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.getWorker("lane-x")?.state, "done");
  assert.equal(st.spentUsdForWorker("lane-x"), 4.5, "recorded exactly once — the failed attempt left no partial row to double up on");
  assert.deepEqual(forge.labelsAdded, [[30, "needs-human"]]);
  assert.deepEqual(r.reclaimed, [{ kind: "done", worker: "lane-x", issue: 30, next: "ESCALATE_NOPR", costUsd: 4.5, modelUsage: [] }]);
  st.close();
});

test("#223: a forge label write throwing AFTER the atomic transition leaves the worker terminal WITH spend already ledgered — never terminal-without-spend; the lost label is the accepted cosmetic gap, not a money gap", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-y", 31);
  sup.probes["lane-y"] = { ...DEFAULT_PROBE, done: true, hasPr: false, costUsd: 6 };
  forge.throwOnAddLabel = true;

  await assert.rejects(() => tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }), /simulated forge failure/);
  // The #223 fix: state+spend commit BEFORE the forge write now, so a thrown label call can
  // only cost the (cosmetic) label — never the (money) ledger row.
  assert.equal(st.getWorker("lane-y")?.state, "done");
  assert.equal(st.spentUsdForWorker("lane-y"), 6);
  assert.deepEqual(forge.labelsAdded, []);

  // The worker is already terminal, so it never re-enters runningWorkers() — a rerun cannot
  // re-reclaim it and cannot double-record its spend.
  forge.throwOnAddLabel = false;
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.spentUsdForWorker("lane-y"), 6, "recorded exactly once — the retry never re-touches an already-terminal lane");
  assert.deepEqual(r.reclaimed, []);
  st.close();
});

test("#223 crash-simulation: a State reopened after a mid-transaction spend failure shows no terminal-without-spend row on disk (same reopen pattern as the #211 crash-resume tests)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-atomic-spend-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const before = new State(path);
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedRunning(before, "lane-z", 32);
    sup.probes["lane-z"] = { ...DEFAULT_PROBE, done: true, hasPr: false, costUsd: 9 };
    before.recordSpend = () => {
      throw new Error("simulated crash mid-transaction");
    };
    await assert.rejects(() => tick({ forge, state: before, supervisor: sup, cfg: mkCfg() }));
    before.close();

    // Reopen — the crash/restart boundary. On-disk state must show the terminal transition
    // rolled back WITH the failed spend write, never a terminal row with an empty ledger.
    const after = new State(path);
    assert.equal(after.getWorker("lane-z")?.state, "running", "on-disk row never went terminal without its spend");
    assert.equal(after.spentUsdForWorker("lane-z"), 0);

    // The resumed engine reclaims normally on the next tick and records exactly once.
    const sup2 = new FakeSupervisor();
    sup2.probes["lane-z"] = { ...DEFAULT_PROBE, done: true, hasPr: false, costUsd: 9 };
    const forge2 = new FakeForge();
    const r = await tick({ forge: forge2, state: after, supervisor: sup2, cfg: mkCfg() });
    assert.equal(after.getWorker("lane-z")?.state, "done");
    assert.equal(after.spentUsdForWorker("lane-z"), 9);
    assert.deepEqual(r.reclaimed, [{ kind: "done", worker: "lane-z", issue: 32, next: "ESCALATE_NOPR", costUsd: 9, modelUsage: [] }]);
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#223 table: EVERY terminal reclaim outcome — a throwing recordSpend leaves the worker NOT terminal and NOTHING ledgered, never terminal-without-spend", async () => {
  // One case per distinct settleTerminalWorker call site audited for #223 (gate② P2: the
  // original fault-injection tests only exercised done/ESCALATE_NOPR — a revert of any OTHER
  // outcome back to separate upsertWorker+recordSpend writes must fail HERE). Cases where a
  // forge write deliberately precedes the transaction (ordinary-failed ESCALATE, dead-requeue,
  // env-failure dirty-worktree) are included too — the invariant must hold there as well, even
  // though the forge call itself isn't exercised by this recordSpend-only injection.
  const cases: Array<{
    label: string;
    issue: number;
    probe: LaneProbe;
    inspectResult?: ReclaimResult;
  }> = [
    { label: "handoff", issue: 200, probe: { ...DEFAULT_PROBE, handoff: true, costUsd: 1 } },
    { label: "done -> DRIVING (has PR)", issue: 201, probe: { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 2001, costUsd: 1 } },
    { label: "done -> ESCALATE_NOPR (no PR)", issue: 202, probe: { ...DEFAULT_PROBE, done: true, hasPr: false, costUsd: 1 } },
    {
      label: "env-failure, no PR (llm signature)",
      issue: 203,
      probe: { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "rate_limit_error", costUsd: 1 },
    },
    {
      label: "env-failure, PR, DIRTY worktree (forge signature; zero forge writes by design)",
      issue: 204,
      probe: {
        ...DEFAULT_PROBE,
        failed: true,
        hasPr: true,
        prNumber: 2004,
        failureText: "gh: Service Unavailable (HTTP 503)",
        costUsd: 1,
      },
      inspectResult: { worktreePath: "/tmp/wt-204", worktreeRetained: true },
    },
    {
      label: "env-failure, PR, CLEAN worktree -> rescue to driving",
      issue: 205,
      probe: {
        ...DEFAULT_PROBE,
        failed: true,
        hasPr: true,
        prNumber: 2005,
        failureText: "gh: Service Unavailable (HTTP 503)",
        costUsd: 1,
      },
    },
    {
      label: "ordinary failed -> DRIVING (has PR, clean worktree, no env signature)",
      issue: 206,
      probe: { ...DEFAULT_PROBE, failed: true, hasPr: true, prNumber: 2006, costUsd: 1 },
    },
    {
      label: "ordinary failed -> ESCALATE (no PR, no env signature; forge writes precede the transaction by design)",
      issue: 207,
      probe: { ...DEFAULT_PROBE, failed: true, hasPr: false, costUsd: 1 },
    },
    {
      label: "dead, rescued to driving (has PR)",
      issue: 208,
      probe: { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0, hasPr: true, prNumber: 2008, costUsd: 1 },
    },
    {
      label: "dead, requeued (no PR; forge/board write precedes the transaction by design)",
      issue: 209,
      probe: { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0, hasPr: false, costUsd: 1 },
    },
  ];

  for (const c of cases) {
    const st = new State(":memory:");
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    const name = `lane-${c.issue}`;
    seedRunning(st, name, c.issue);
    sup.probes[name] = c.probe;
    if (c.inspectResult) sup.inspectResults[name] = c.inspectResult;
    // Fake state: recordSpend always throws (simulates a crash/corruption at the ledger write).
    st.recordSpend = () => {
      throw new Error("simulated recordSpend failure");
    };
    await assert.rejects(
      () => tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }),
      /simulated recordSpend failure/,
      `[${c.label}] tick should propagate the injected recordSpend failure`,
    );
    assert.equal(st.getWorker(name)?.state, "running", `[${c.label}] worker must stay reclaimable — never terminal-without-spend`);
    assert.equal(st.spentUsdForWorker(name), 0, `[${c.label}] no partial ledger row either`);
    st.close();
  }
});

// ── #155: per-probe lane telemetry — persisted while KEEP, cleared the instant a lane leaves
// `running` (any reclaim outcome: done/driving, failed/driving, handoff, dead). ────────────

test("tick reclaim: a KEEP lane's probe-carried liveTelemetry is persisted onto the workers row (update-in-place)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-keep", 1);
  const telemetry = {
    estCostUsd: 0.42,
    contextTokens: 41000,
    tokenComposition: { inputTokens: 12000, outputTokens: 3000, cacheReadTokens: 90000, cacheCreationTokens: 4000 },
  };
  sup.probes["lane-keep"] = { ...DEFAULT_PROBE, liveTelemetry: telemetry };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const row = st.getWorker("lane-keep");
  assert.equal(row?.state, "running");
  assert.equal(row?.est_cost_usd, 0.42);
  assert.equal(row?.context_tokens, 41000);
  assert.deepEqual(JSON.parse(row!.token_composition!), telemetry.tokenComposition);

  // A later probe's numbers simply overwrite — no history, no per-probe event.
  sup.probes["lane-keep"] = {
    ...DEFAULT_PROBE,
    liveTelemetry: {
      estCostUsd: 0.5,
      contextTokens: 500,
      tokenComposition: { inputTokens: 12500, outputTokens: 3100, cacheReadTokens: 90000, cacheCreationTokens: 4000 },
    },
  };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const after = st.getWorker("lane-keep");
  assert.equal(after?.est_cost_usd, 0.5);
  assert.equal(after?.context_tokens, 500, "contextTokens dropped — never smoothed into a running max");
  st.close();
});

test("tick reclaim: a KEEP lane whose probe carries NO liveTelemetry (detached post-restart lane) CLEARS a previously-persisted trio — a number we can no longer refresh must not look live (gate② P2)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-keep", 1);
  // A PRE-restart tick persisted a trio; the engine then restarted — the new supervisor has no
  // in-memory Lane for this name, so probe() carries no liveTelemetry (worker.test.ts's
  // detached-lane test pins that). Leaving the old numbers in place would show a frozen
  // cost/context as if live for the lane's whole remaining leg.
  st.setLiveTelemetry("lane-keep", {
    estCostUsd: 0.42,
    contextTokens: 41000,
    tokenComposition: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 },
  });
  sup.probes["lane-keep"] = { ...DEFAULT_PROBE }; // no liveTelemetry field at all
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(r.reclaimed[0]!.kind, "kept");
  const row = st.getWorker("lane-keep");
  assert.equal(row?.state, "running"); // the lane itself is untouched — only the trio is cleared
  assert.equal(row?.est_cost_usd, null, "stale pre-restart telemetry cleared, never frozen as live");
  assert.equal(row?.context_tokens, null);
  assert.equal(row?.token_composition, null);
  st.close();
});

test("tick reclaim: DONE+PR (-> driving) clears any previously-persisted live telemetry — settled cost stays in spend_ledger, unchanged", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  st.setLiveTelemetry("lane-a", {
    estCostUsd: 0.9,
    contextTokens: 999,
    tokenComposition: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 },
  });
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, costUsd: 1.23 };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const row = st.getWorker("lane-a");
  assert.equal(row?.state, "driving");
  assert.equal(row?.est_cost_usd, null, "live telemetry cleared on leaving `running`");
  assert.equal(row?.context_tokens, null);
  assert.equal(row?.token_composition, null);
  assert.equal(
    st.spentUsdForWorker("lane-a"),
    1.23,
    "the SETTLED real cost still lands in spend_ledger, unaffected by the telemetry clear",
  );
  st.close();
});

test("tick reclaim: a DEAD lane (rescued to driving, or torn down failed) clears any previously-persisted live telemetry — a crashed lane always passes through reclaim", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-deadpr", 6);
  st.setLiveTelemetry("lane-deadpr", {
    estCostUsd: 0.3,
    contextTokens: 500,
    tokenComposition: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 },
  });
  sup.probes["lane-deadpr"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0, hasPr: true };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const row = st.getWorker("lane-deadpr");
  assert.equal(row?.state, "driving");
  assert.equal(row?.est_cost_usd, null);
  assert.equal(row?.context_tokens, null);
  assert.equal(row?.token_composition, null);
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
  const cfg = mkCfg({ labels: { needsHuman: "Human-Hold" }, escalation: { humanLabels: ["human-hold", "sapwood:blocked"] } });
  const r = await tick({ forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(sup.reclaimed, ["lane-dirty"]);
  assert.deepEqual(r.reclaimed[0], { kind: "dead", worker: "lane-dirty", issue: 7, rescued: false, costUsd: 0, modelUsage: [] });
  assert.deepEqual(forge.labelsAdded, [[7, "Human-Hold"]]); // human salvages or discards
  assert.equal(forge.issueComments.length, 1);
  assert.equal(forge.issueComments[0]![0], 7);
  assert.match(forge.issueComments[0]![1], /\/abs\/worktrees\/lane-dirty/); // the absolute path
  assert.match(forge.issueComments[0]![1], /lane-dirty/); // the lane name
  assert.match(forge.issueComments[0]![1], /remove the `Human-Hold` label/); // resolved configured label, not a literal default
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

// ─────────────────────────────────────────────────────────────────────────────
// #246: FIXABLE gate wiring — the DRIVE loop's own "fixable" branch (driveDecision's
// FIXUP/ESCALATE refinement, fed by THIS lane's fix_rounds/cfg.lanes.prFixCap/round budget).
// Seeds a `driving` row directly (seedDriving, defined below) and scripts the FakeMergeGate's
// outcome to "fixable" — the deriveGate/prFixCap-enable-switch mapping itself is covered in
// merge-driver.test.ts; these tests are about what conductor.ts DOES once it receives FIXABLE.
// ─────────────────────────────────────────────────────────────────────────────

test("tick DRIVE (#246): fixable + under cap + fixLegResume configured -> dispatches a fix leg (startFixLeg), lane -> fixing, fix_rounds bumped, driven records 'fixup'", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const renderFixPrompt = (issueNumber: number, pr: number) => `fix #${issueNumber} pr #${pr}`;
  const mintProxy = async () => ({}) as never;
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume: { renderFixPrompt, mintProxy } });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "fixing");
  assert.equal(row.fix_rounds, 1);
  assert.equal(row.pr, 55, "same PR — never a new dispatch");
  assert.deepEqual(sup.dispatched, []);
  assert.equal(sup.resumeCalls.length, 1);
  assert.equal(sup.resumeCalls[0]!.opts?.prompt, "fix #2 pr #55");
  assert.deepEqual(r.driven, [
    { kind: "fixup", worker: "lane-a", issue: 2, pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" },
  ]);
  assert.deepEqual(forge.labelsAdded, []); // no escalation — this is a normal rework dispatch
  st.close();
});

test("tick DRIVE (#246): fixable but NO fixLegResume dep configured -> stays driving, queued (fail-closed, never corrupts the lane)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // no fixLegResume
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving");
  assert.equal(row.fix_rounds ?? 0, 0);
  assert.deepEqual(sup.resumeCalls, []);
  assert.deepEqual(r.driven, [{ kind: "queued", worker: "lane-a", issue: 2, pr: 55, reason: "fix-leg-unconfigured" }]);
  st.close();
});

test("tick DRIVE (#246): fixable + FIXUP but startFixLeg's resume() throws -> stays driving, queued, fix_rounds NOT bumped (transient spawn failure costs zero fix-round budget)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  sup.resumeShouldThrow = "mint failed";
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving");
  assert.equal(row.fix_rounds ?? 0, 0);
  assert.equal(r.driven[0]!.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-leg-dispatch-failed/);
  st.close();
});

test("tick DRIVE (#246): fixable + round budget exceeded -> ESCALATE is treated as a TRANSIENT this-tick block (queued, no label, no terminal upsert) — retried next tick, never a permanent cap escalation", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55); // fix_rounds 0, well under the default cap of 2
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    roundSpendUsd: () => 50, // > default cost.roundBudgetUsd (30) -> over budget
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving", "stays driving — never terminal on a mere budget block");
  assert.equal(row.fix_rounds ?? 0, 0);
  assert.deepEqual(sup.resumeCalls, [], "no fix leg dispatched while over budget");
  assert.deepEqual(forge.labelsAdded, []);
  assert.equal(r.driven[0]!.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-leg-over-budget/);
  st.close();
});

test("tick DRIVE (#246): fix_rounds cap reached (not over budget) -> needs-human label + escalation comment land BEFORE the terminal upsert, failed+pr+gated_escalation_labeled=1 (the ONLY producer of that shape besides prFixCap:0)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 }); // == default cfg.lanes.prFixCap (2): cap reached
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "failed");
  assert.equal(row.pr, 55);
  assert.equal(row.gated_escalation_labeled, 1);
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
  assert.equal(forge.issueComments.length, 1);
  assert.match(forge.issueComments[0]![1], /fix-round cap \(2\) reached/);
  assert.match(forge.issueComments[0]![1], /2 round\(s\) spent/);
  assert.deepEqual(r.driven, [{ kind: "needs-human", worker: "lane-a", issue: 2, pr: 55, reason: "fix-rounds-cap:2/2" }]);
  st.close();
});

test("tick DRIVE (#246): fix_rounds cap reached but the needs-human label write FAILS -> stays driving (no upsert, no latch) — retried next tick, exactly like #147's own labeled=0 fail-closed stance", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.throwOnAddLabel = true;
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 });
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving", "no latch — untouched, so the next tick's FIXABLE-at-cap re-derivation retries the label write");
  assert.equal(row.fix_rounds, 2);
  assert.deepEqual(forge.issueComments, [], "no comment posted without a successful label — nothing to escalate yet");
  assert.equal(r.driven[0]!.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-rounds-cap-label-failed/);
  st.close();
});

test("#147 gated-PR reentry (#246): a PR that hit its FIX-ROUNDS CAP (not a plain HANDLE_THREADS escalation) is reclaimed IDENTICALLY once needs-human is removed — proves #147's reclaim/fresh-review/merge machinery is unmodified and reused as the post-adjudication channel, not forked", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now: () => new Date("2026-07-02T00:00:00.000Z") });

  // Pre-existing state: #246's OWN cap-escalation path produced this exact row shape (failed,
  // pr retained, gated_escalation_labeled=1) — the same shape the pre-#246 HANDLE_THREADS
  // escalation produced, and gatedFailedWorkers() cannot (and must not) tell them apart.
  st.upsertWorker({
    name: "lane-a",
    issue: 10,
    session_id: "s-lane-a",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 99,
    fix_rounds: 2,
    review_triggered_head: "H1",
    review_triggered_at: "2026-07-01T00:00:00.000Z",
    gated_escalation_labeled: 1,
  });
  forge.prStatus = { number: 99, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  forge.prReviewData = {
    headOid: "H1",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    reviews: [{ author: CODEX_REVIEWER_LOGINS[0], commitOid: "H1", state: "COMMENTED", submittedAt: "2026-07-02T00:05:00Z" }],
    unresolvedThreads: 0,
  };
  forge.issueLabelsByIssue[10] = []; // human removed needs-human — the reentry signal

  const r1 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-a", issue: 10, pr: 99, attempt: 1 }]);
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  assert.equal(st.getWorker("lane-a")?.fix_rounds, 2, "fix_rounds is untouched by GATED RECLAIM — #147 owns gated_reentry_attempts only");

  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r2.driven, [{ kind: "merged", worker: "lane-a", issue: 10, pr: 99 }]);
  assert.equal(st.getWorker("lane-a")?.state, "done");
  assert.deepEqual(forge.merged, [[99, "H1"]]);
  assert.equal(sup.dispatched.length, 0); // no worker ever spawned across the whole reentry
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
    return (raw.prepare("SELECT kind FROM events ORDER BY id").all() as unknown as Array<{ kind: string }>).map((r) => r.kind);
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
      kind: "queued",
      pr: 55,
      reason: "waiting",
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
      kind: "queued",
      pr: 55,
      reason: "waiting",
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
      kind: "queued",
      pr: 55,
      reason: "waiting",
      reviewerTransition: { kind: "switch", mode: "human", head: "H1" },
    };
    await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    gate.outcomes[55] = {
      kind: "queued",
      pr: 55,
      reason: "waiting",
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

test("#172 kill switch adopts a confirmed-intent handoff and drains it in the same tick", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-killswitch-resume-adopt-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    st.upsertWorker({
      name: "lane-confirmed",
      issue: 172,
      session_id: "pre-adopt-session",
      state: "handoff",
      started_at: "t0",
      ended_at: "t1",
    });
    sup.resumeIntents["lane-confirmed"] = "confirmed";
    sup.probes["lane-confirmed"] = { ...DEFAULT_PROBE }; // adopted child is alive/KEEP
    writeFileSync(join(dir, "KILL_SWITCH"), "");

    const result = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

    assert.deepEqual(result.resumed, [{ kind: "resumed", worker: "lane-confirmed", issue: 172, attempt: 1 }]);
    assert.equal(st.getWorker("lane-confirmed")?.state, "running");
    assert.equal(st.getWorker("lane-confirmed")?.resume_attempts, 1);
    assert.deepEqual(
      sup.resumed.map((x) => x.worker),
      ["lane-confirmed"],
    );
    assert.deepEqual(result.drainRequested, ["lane-confirmed"]);
    assert.deepEqual(sup.handoffRequested, ["lane-confirmed"]);
    assert.deepEqual(result.reclaimed, []);
    assert.deepEqual(sup.dispatched, []);
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
    assert.deepEqual(
      r2.dispatched.map((d) => d.kind),
      ["dispatched"],
    );
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

test("#169 restart adoption: stale confirmed-alive lane requests one graceful handoff, stays held, then follows .handoff -> resume", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-adopt", 169);
  sup.probes["lane-adopt"] = {
    ...DEFAULT_PROBE,
    hbAge: 181,
    wrapperAlive: 1,
    dispatchedAgeSec: 300,
  };
  const cfg = mkCfg({ worker: { heartbeatStaleSecs: 180, timeoutSec: 3600 } });

  const r1 = await tick({ forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(r1.reclaimed, [{ kind: "kept", worker: "lane-adopt", issue: 169 }]);
  assert.deepEqual(sup.handoffRequested, ["lane-adopt"]);
  assert.deepEqual(sup.reclaimed, [], "adoption never enters the hard-kill reclaim path");
  assert.equal(st.getWorker("lane-adopt")?.state, "running", "lane stays held while SIGTERM drains it");
  assert.deepEqual(forge.labelsAdded, [], "adoption never escalates to needs-human");
  assert.deepEqual(st.latestEvent("lane-adopted"), {
    kind: "lane-adopted",
    payload: {
      worker: "lane-adopt",
      issue: 169,
      note: "Spend during engine downtime was unobserved.",
    },
  });

  // The detached wrapper is still draining on the next tick. Persisted/in-memory handoff
  // dedup returns false, so it stays held without a second signal or honesty event.
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(r2.reclaimed, [{ kind: "kept", worker: "lane-adopt", issue: 169 }]);
  assert.deepEqual(sup.handoffRequested, ["lane-adopt"]);
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["lane-adopted"]).length, 1);

  // probe()'s real detached path writes this sentinel once the pid is confirmed dead. The
  // conductor settles it on one tick and the existing resume path starts it on the next.
  sup.probes["lane-adopt"] = { ...DEFAULT_PROBE, handoff: true };
  const r3 = await tick({ forge, state: st, supervisor: sup, cfg });
  assert.equal(r3.reclaimed[0]?.kind, "handoff");
  assert.equal(st.getWorker("lane-adopt")?.state, "handoff");
  assert.deepEqual(r3.resumed, []);

  const r4 = await tick({ forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(r4.resumed, [{ kind: "resumed", worker: "lane-adopt", issue: 169, attempt: 1 }]);
  assert.equal(st.getWorker("lane-adopt")?.state, "running");
  assert.deepEqual(forge.labelsAdded, []);
  st.close();
});

test("#169 fake-runner integration: persisted alive+stale lane gets SIGTERM, probe finalizes .handoff, and conductor resumes with zero needs-human", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-adopt-detached-"));
  const dbPath = join(dir, "sapwood.sqlite");
  const bin = join(dir, "claude-stub");
  const termMarker = join(dir, "term-received");
  const trapReadyMarker = join(dir, "trap-ready");
  // #229: the marker is touched AFTER the trap is installed, so the test can wait on a
  // deterministic ready-sentinel instead of a fixed sleep — under load, bash may not get
  // scheduled in time to install the trap before a fixed-duration sleep elapses, so the
  // later SIGTERM would hit the shell's default (trap-less) handling and the process would
  // die WITHOUT running the trap, silently starving termMarker below (issue #229).
  writeFileSync(bin, `#!/usr/bin/env bash\ntrap 'touch "${termMarker}" ; exit 0' TERM\ntouch "${trapReadyMarker}"\nsleep 30\n`, {
    mode: 0o755,
  });
  const cfg = mkCfg({ guard: { mode: "soft" }, worker: { heartbeatStaleSecs: 1, timeoutSec: 30 } });
  const forge = new FakeForge();
  const st = new State(dbPath);
  const issue = { number: 169, title: "restart adoption", labels: [] };
  const s1 = new WorkerSupervisor({ cfg, stateDir: dir, claudeBin: bin, hasOpenPr: async () => false, heartbeatMs: 60_000 });
  let s2: WorkerSupervisor | undefined;
  try {
    const { name, sessionId } = await s1.dispatch(issue, "lane-169-integration");
    // #229: deterministic handshake instead of a blind sleep — poll (bounded) for the stub's
    // ready-sentinel so the TERM trap is provably installed before anything simulates the
    // restart and later sends SIGTERM. A fixed sleep raced bash's own scheduling under load.
    for (let i = 0; i < 400 && !existsSync(trapReadyMarker); i++) await sleep(20);
    assert.ok(existsSync(trapReadyMarker), "fake-runner stub never signaled its TERM trap was installed");
    st.upsertWorker({
      name,
      issue: issue.number,
      session_id: sessionId,
      state: "running",
      started_at: new Date().toISOString(),
      ended_at: null,
    });
    const running = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")) as { wrapper_pid: number };
    assert.doesNotThrow(() => process.kill(running.wrapper_pid, 0));
    s1.dispose(); // new engine has no in-memory ChildProcess/heartbeat timer
    utimesSync(join(dir, `${name}.heartbeat`), new Date(0), new Date(0));

    s2 = new WorkerSupervisor({ cfg, stateDir: dir, claudeBin: bin, hasOpenPr: async () => false, heartbeatMs: 60_000 });
    const adopted = await tick({ forge, state: st, supervisor: s2, cfg });
    assert.deepEqual(adopted.reclaimed, [{ kind: "kept", worker: name, issue: 169 }]);
    assert.equal(st.getWorker(name)?.state, "running");
    assert.deepEqual(forge.labelsAdded, []);
    assert.deepEqual(st.latestEvent("lane-adopted")?.payload, {
      worker: name,
      issue: 169,
      note: "Spend during engine downtime was unobserved.",
    });

    for (let i = 0; i < 400; i++) {
      try {
        process.kill(running.wrapper_pid, 0);
        await sleep(20);
      } catch {
        break;
      }
    }
    assert.throws(() => process.kill(running.wrapper_pid, 0), "cooperative wrapper exited from the graceful SIGTERM");
    assert.ok(existsSync(termMarker), "TERM trap wrote its marker; SIGKILL cannot satisfy this assertion");

    const settled = await tick({ forge, state: st, supervisor: s2, cfg });
    assert.equal(settled.reclaimed[0]?.kind, "handoff");
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "probe wrote the detached .handoff sentinel");
    assert.equal(st.getWorker(name)?.state, "handoff");

    const resumed = await tick({ forge, state: st, supervisor: s2, cfg });
    assert.deepEqual(resumed.resumed, [{ kind: "resumed", worker: name, issue: 169, attempt: 1 }]);
    assert.equal(st.getWorker(name)?.state, "running");
    assert.deepEqual(forge.labelsAdded, [], "the full adoption/handoff/resume path never labels needs-human");
    await s2.reclaim(name); // stop the resumed fake worker before test cleanup
  } finally {
    s1.dispose();
    s2?.dispose();
    st.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#169 restart adoption bound: stale alive lane past timeout and confirmed-dead lane keep today's DEAD reclaim", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-hung", 1691);
  seedRunning(st, "lane-dead", 1692);
  sup.probes["lane-hung"] = {
    ...DEFAULT_PROBE,
    hbAge: 181,
    wrapperAlive: 1,
    dispatchedAgeSec: 3600.001,
  };
  sup.probes["lane-dead"] = {
    ...DEFAULT_PROBE,
    hbAge: 181,
    wrapperAlive: 0,
    dispatchedAgeSec: 10,
  };

  const r = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg({ worker: { heartbeatStaleSecs: 180, timeoutSec: 3600 } }),
  });
  assert.deepEqual(sup.handoffRequested, []);
  assert.deepEqual(sup.reclaimed, ["lane-dead", "lane-hung"]); // State orders worker names
  assert.deepEqual(
    r.reclaimed.map((x) => x.kind),
    ["dead", "dead"],
  );
  assert.equal(st.latestEvent("lane-adopted"), undefined);
  assert.equal(st.getWorker("lane-hung")?.state, "failed");
  assert.equal(st.getWorker("lane-dead")?.state, "failed");
  st.close();
});

test("#172 integration: handoff settles for one tick, RESUME reuses the lane next tick, then the ordinary done+PR DRIVE path completes; per-leg costs sum", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const gate = new FakeMergeGate();
  gate.outcomes[77] = { kind: "merged", pr: 77, headOid: "H77" };
  seedRunning(st, "lane-ho", 172);

  // Leg 0 reaches its soft budget. It is reclaimed to handoff but must NOT be resumed in the
  // same tick (the RESUME candidate set was snapshotted before RECLAIM).
  sup.probes["lane-ho"] = { ...DEFAULT_PROBE, handoff: true, costUsd: 3 };
  const r1 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-ho")?.state, "handoff");
  assert.deepEqual(r1.resumed, []);
  assert.equal(st.spentUsdForWorker("lane-ho"), 3);

  // Next tick: RESUME gets the lane before fresh work and makes it an ordinary running lane.
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(r2.resumed, [{ kind: "resumed", worker: "lane-ho", issue: 172, attempt: 1 }]);
  assert.equal(st.getWorker("lane-ho")?.state, "running");
  assert.equal(st.getWorker("lane-ho")?.resume_attempts, 1);

  // The resumed leg finishes with a PR. Ordinary RECLAIM -> DRIVE handles it in the same tick.
  sup.probes["lane-ho"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 77, costUsd: 2 };
  const r3 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(r3.driven, [{ kind: "merged", worker: "lane-ho", issue: 172, pr: 77 }]);
  assert.equal(st.getWorker("lane-ho")?.state, "done");
  assert.equal(st.spentUsdForWorker("lane-ho"), 5); // $3 initial leg + $2 resumed leg
  st.close();
});

test("#172 confirmed intent is adopted under PAUSE, then ordinary supervision reclaims its result", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-resume-crash-"));
  const st = new State(join(dir, "sapwood.sqlite"));
  const cfg = mkCfg({ guard: { mode: "soft" } });
  const supervisor = new WorkerSupervisor({
    cfg,
    stateDir: dir,
    claudeBin: join(dir, "must-not-spawn"),
    hasOpenPr: async () => false,
  });
  try {
    st.upsertWorker({
      name: "lane-crash",
      issue: 172,
      session_id: "pre-resume",
      state: "handoff",
      started_at: "t",
      ended_at: "t",
    });
    writeFileSync(
      join(dir, "lane-crash.running.json"),
      JSON.stringify({
        name: "lane-crash",
        issue: 172,
        session_id: "surviving-session",
        wrapper_pid: 999_999_999,
        estimate_baseline_usd: 0.25,
        jsonl_leg_offset: 0,
        resume_pending_db: true,
        spawn_confirmed: true,
      }),
    );
    writeFileSync(
      join(dir, "lane-crash.handoff.json"),
      JSON.stringify({ name: "lane-crash", issue: 172, session_id: "pre-resume", total_cost_usd: 99 }),
    );
    writeFileSync(
      join(dir, "lane-crash.jsonl"),
      JSON.stringify({ type: "result", total_cost_usd: 1.25, model: "claude-opus-4-6", usage: { input_tokens: 10 } }),
    );
    writeFileSync(join(dir, "PAUSE"), "");

    const result = await tick({ forge: new FakeForge(), state: st, supervisor, cfg });
    assert.deepEqual(result.resumed, [{ kind: "resumed", worker: "lane-crash", issue: 172, attempt: 1 }]);
    assert.equal(st.getWorker("lane-crash")?.state, "running");
    assert.equal(st.getWorker("lane-crash")?.session_id, "surviving-session");
    assert.equal(existsSync(join(dir, "lane-crash.handoff.json")), false, "adoption completes stale handoff removal");
    assert.equal(st.maxSpendLedgerId(), 0, "the stale prior-leg handoff is not re-recorded");

    const reclaimed = await tick({ forge: new FakeForge(), state: st, supervisor, cfg });
    assert.equal(reclaimed.reclaimed[0]?.kind, "dead");
    assert.equal(st.getWorker("lane-crash")?.state, "failed");
    assert.equal(st.spentUsdForWorker("lane-crash"), 1.25);
    await tick({ forge: new FakeForge(), state: st, supervisor, cfg });
    assert.equal(st.maxSpendLedgerId(), 1, "adoption and reclaim happen once without resume oscillation");
  } finally {
    supervisor.dispose();
    st.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#172 unconfirmed resume intent escalates and latches under PAUSE without spawning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-resume-undecidable-"));
  const st = new State(join(dir, "sapwood.sqlite"));
  const cfg = mkCfg({ guard: { mode: "soft" } });
  const supervisor = new WorkerSupervisor({
    cfg,
    stateDir: dir,
    claudeBin: join(dir, "must-not-spawn"),
    hasOpenPr: async () => false,
  });
  const forge = new FakeForge();
  try {
    st.upsertWorker({
      name: "lane-ambiguous",
      issue: 1172,
      session_id: "session-evidence",
      state: "handoff",
      started_at: "t",
      ended_at: "t",
    });
    writeFileSync(
      join(dir, "lane-ambiguous.running.json"),
      JSON.stringify({
        name: "lane-ambiguous",
        issue: 1172,
        session_id: "session-evidence",
        resume_pending_db: true,
        spawn_confirmed: false,
      }),
    );
    writeFileSync(
      join(dir, "lane-ambiguous.handoff.json"),
      JSON.stringify({ name: "lane-ambiguous", issue: 1172, session_id: "session-evidence" }),
    );
    writeFileSync(join(dir, "PAUSE"), "");

    const result = await tick({ forge, state: st, supervisor, cfg });
    assert.deepEqual(result.resumed, [{ kind: "capped", worker: "lane-ambiguous", issue: 1172, attempts: 0 }]);
    assert.equal(st.getWorker("lane-ambiguous")?.resume_capped, 1);
    assert.deepEqual(forge.labelsAdded, [[1172, "needs-human"]]);
    assert.equal(forge.issueComments.length, 1);
    assert.match(forge.issueComments[0]![1], /ambiguous crash state/i);
    assert.match(forge.issueComments[0]![1], /session-evidence/);
    assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["resume-undecidable"]).length, 1);
    assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["resume-failed"]).length, 0);
    assert.equal(existsSync(join(dir, "lane-ambiguous.handoff.json")), true, "evidence remains for human triage");

    const again = await tick({ forge, state: st, supervisor, cfg });
    assert.deepEqual(again.resumed, []);
    assert.equal(forge.labelsAdded.length, 1);
  } finally {
    supervisor.dispose();
    st.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#172 detached dispatch marker is not adopted: handoff spawns one real resume and each leg is ledgered once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-detached-handoff-"));
  const state = new State(join(dir, "sapwood.sqlite"));
  const cfg = mkCfg({ guard: { mode: "soft" } });
  const bin = join(dir, "claude-stub");
  writeFileSync(
    bin,
    [
      "#!/usr/bin/env bash",
      'echo \'{"type":"result","total_cost_usd":2,"model":"claude-stub","usage":{"input_tokens":2}}\'',
      "exit 0",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  const supervisor = new WorkerSupervisor({ cfg, stateDir: dir, claudeBin: bin, hasOpenPr: async () => false });
  try {
    state.upsertWorker({
      name: "lane-detached",
      issue: 172,
      session_id: "session-172",
      state: "handoff",
      started_at: "t",
      ended_at: "t",
    });
    // Dispatch-authored marker: deliberately no resume_pending_db. The detached worker's
    // handoff sentinel is the authoritative resume anchor; this stale running marker must not
    // masquerade as proof that a resume already spawned.
    writeFileSync(
      join(dir, "lane-detached.running.json"),
      JSON.stringify({ name: "lane-detached", issue: 172, session_id: "session-172", wrapper_pid: 999_999_999 }),
    );
    writeFileSync(
      join(dir, "lane-detached.handoff.json"),
      JSON.stringify({ name: "lane-detached", issue: 172, session_id: "session-172", total_cost_usd: 1, model_usage: [] }),
    );
    writeFileSync(
      join(dir, "lane-detached.jsonl"),
      JSON.stringify({ type: "result", total_cost_usd: 1, model: "claude-stub", usage: { input_tokens: 1 } }) + "\n",
    );
    state.recordSpend("lane-detached", 172, 1, new Date().toISOString());
    assert.equal(state.maxSpendLedgerId(), 1);

    const resumed = await tick({ forge: new FakeForge(), state, supervisor, cfg });
    assert.deepEqual(resumed.resumed, [{ kind: "resumed", worker: "lane-detached", issue: 172, attempt: 1 }]);
    assert.equal(state.getWorker("lane-detached")?.state, "running");
    assert.equal(existsSync(join(dir, "lane-detached.handoff.json")), false, "normal resume consumed the handoff anchor");
    assert.equal(state.maxSpendLedgerId(), 1, "resume itself does not re-ledger leg 1");

    for (let i = 0; i < 400 && !existsSync(join(dir, "lane-detached.done.json")); i++) await sleep(20);
    assert.ok(existsSync(join(dir, "lane-detached.done.json")), "the real resumed process completed");
    await tick({ forge: new FakeForge(), state, supervisor, cfg });
    assert.equal(state.getWorker("lane-detached")?.state, "done");
    assert.equal(state.spentUsdForWorker("lane-detached"), 3);
    assert.equal(state.maxSpendLedgerId(), 2, "exactly one ledger row per leg");

    await tick({ forge: new FakeForge(), state, supervisor, cfg });
    assert.equal(state.maxSpendLedgerId(), 2, "no handoff-running oscillation can re-record spend");
  } finally {
    supervisor.dispose();
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick dispatch cap 0 is quiet and never fetches Ready issues", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.ready = [{ number: 999, title: "must not be fetched", labels: ["prio:3-feature"] }];
  const result = await tick({ forge, state: st, supervisor: new FakeSupervisor(), cfg: mkCfg(), dispatchCapOverride: 0 });
  assert.equal(forge.readyReads, 0);
  assert.deepEqual(result.dispatched, []);
  st.close();
});

test("#172 cap latch: a second handoff past maxResumes escalates exactly once and is never selected again", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ worker: { maxResumes: 1 } });
  seedRunning(st, "lane-cap", 173);

  sup.probes["lane-cap"] = { ...DEFAULT_PROBE, handoff: true, costUsd: 1 };
  await tick({ forge, state: st, supervisor: sup, cfg }); // leg 0 -> handoff
  await tick({ forge, state: st, supervisor: sup, cfg }); // resume attempt 1
  sup.probes["lane-cap"] = { ...DEFAULT_PROBE, handoff: true, costUsd: 0.5 };
  await tick({ forge, state: st, supervisor: sup, cfg }); // resumed leg -> handoff

  const capped = await tick({ forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(capped.resumed, [{ kind: "capped", worker: "lane-cap", issue: 173, attempts: 1 }]);
  assert.equal(st.getWorker("lane-cap")?.resume_capped, 1);
  assert.deepEqual(forge.labelsAdded, [[173, "needs-human"]]);
  assert.equal(sup.resumed.length, 1);

  const again = await tick({ forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(again.resumed, []);
  assert.equal(forge.labelsAdded.length, 1);
  assert.equal(st.eventsSince("2020-01-01T00:00:00Z", ["resume-capped"]).length, 1);
  st.close();
});

test("#172 pause + full hold-set: a handoff does not resume until PAUSE and configured human holds are both cleared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-resume-pause-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    st.upsertWorker({ name: "lane-p", issue: 174, session_id: "s", state: "handoff", started_at: "t", ended_at: "t" });
    forge.issueLabelsByIssue[174] = ["blocked"]; // full configured hold set, not needs-human only
    writeFileSync(join(dir, "PAUSE"), "");

    assert.deepEqual((await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() })).resumed, []);
    rmSync(join(dir, "PAUSE"), { force: true });
    assert.deepEqual((await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() })).resumed, []);
    forge.issueLabelsByIssue[174] = [];
    assert.deepEqual((await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() })).resumed, [
      { kind: "resumed", worker: "lane-p", issue: 174, attempt: 1 },
    ]);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#172 ordering: with one free slot, RESUME claims it before a fresh Ready issue reaches DISPATCH", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  st.upsertWorker({ name: "lane-old", issue: 175, session_id: "s", state: "handoff", started_at: "t", ended_at: "t" });
  forge.ready = [{ number: 176, title: "fresh", labels: ["prio:3-feature"] }];
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }) });
  assert.deepEqual(r.resumed, [{ kind: "resumed", worker: "lane-old", issue: 175, attempt: 1 }]);
  assert.deepEqual(sup.dispatched, []);
  assert.deepEqual(r.dispatched, [{ kind: "skipped", issue: 176, reason: "no-lane" }]);
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
  assert.deepEqual(
    sup.dispatched.map((i) => i.number),
    [2, 5],
  );
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
  forge.ready = [
    { number: 2, title: "", labels: [] },
    { number: 3, title: "", labels: [] },
  ];
  // over budget: roundSpend 50 > default roundBudgetUsd 30 (thunk since #124 gate② P1-2 —
  // evaluated inside tick(), post-reclaim)
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), roundSpendUsd: () => 50 });
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
  const dispatched = r.dispatched
    .filter((d) => d.kind === "dispatched")
    .map((d) => d.issue)
    .sort((a, b) => a - b);
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

test("classifyLane: #169 stale-heartbeat decision table has exactly one ADOPT branch", () => {
  // args: done, failed, hbAge, threshold, wrapperAlive, dispatchedAgeSec, timeoutSec
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

  // #169 table: only stale heartbeat × confirmed alive × bounded first-dispatch age adopts.
  assert.equal(classifyLane(false, false, 601, 600, 1, 3599, 3600), "ADOPT");
  assert.equal(classifyLane(false, false, 601, 600, 1, 3600, 3600), "ADOPT"); // equal is still within bound
  assert.equal(classifyLane(false, false, 601, 600, 1, 3600.001, 3600), "DEAD");
  assert.equal(classifyLane(false, false, 601, 600, 1, Number.NaN, 3600), "DEAD"); // unparseable dispatched_at
  assert.equal(classifyLane(false, false, 601, 600, 1, -1, 3600), "DEAD"); // invalid/future baseline fails safe
  assert.equal(classifyLane(false, false, 601, 600, 0, 10, 3600), "DEAD"); // confirmed dead unchanged
  assert.equal(classifyLane(false, false, 601, 600, -1, 10, 3600), "DEAD"); // unknown pid unchanged
  assert.equal(classifyLane(false, false, 30, 600, 1, 9999, 3600), "KEEP"); // fast-restart/fresh heartbeat unchanged
});

test("budgetExceeded: total > cap (float); equal is not over", () => {
  assert.equal(budgetExceeded(5.01, 5), true);
  assert.equal(budgetExceeded(5, 5), false);
  assert.equal(budgetExceeded(0, 5), false);
  assert.equal(budgetExceeded(20.5, 20), true);
  assert.equal(budgetExceeded(0, 0), false);
});

test("issuePriority: min configured-prefix prio:N-* across labels, default 3", () => {
  assert.equal(issuePriority(["sapwood:prio:0-gov", "sapwood:type:ops"], "sapwood:"), 0);
  assert.equal(issuePriority(["sapwood:type:feature", "sapwood:prio:1-decision"], "sapwood:"), 1);
  assert.equal(issuePriority(["sapwood:prio:2-blocking-ux"], "sapwood:"), 2);
  assert.equal(issuePriority(["sapwood:prio:3-feature"], "sapwood:"), 3);
  assert.equal(issuePriority(["sapwood:prio:4-fe-polish"], "sapwood:"), 4);
  assert.equal(issuePriority(["sapwood:type:feature"], "sapwood:"), 3); // no prio label -> default 3
  assert.equal(issuePriority([], "sapwood:"), 3); // empty -> 3
  assert.equal(issuePriority(["sapwood:prio:3-feature", "sapwood:prio:0-gov"], "sapwood:"), 0);
});

test("issuePriority: bare forms require labels.prefix to be empty", () => {
  assert.equal(issuePriority(["prio:0"], "sapwood:"), 3);
  assert.equal(issuePriority(["PRIO:2-high"], "sapwood:"), 3);
  assert.equal(issuePriority(["prio:0"], ""), 0);
  assert.equal(issuePriority(["PRIO:2-high"], ""), 2);
  assert.equal(issuePriority(["prio:00"], ""), 3); // malformed -> no match -> default
  assert.equal(issuePriority(["Sapwood:Prio:1"], "sapwood:"), 1); // normalized case variant
});

test("labelsBlockers: parse only the configured-prefix blocked-by:[#]N forms", () => {
  assert.deepEqual(labelsBlockers(["sapwood:blocked-by:42", "sapwood:type:feature"], "sapwood:"), [42]);
  assert.deepEqual(labelsBlockers(["sapwood:blocked-by:42", "sapwood:blocked-by:7"], "sapwood:"), [7, 42]);
  assert.deepEqual(labelsBlockers(["blocked-by:#42"], "sapwood:"), []);
  assert.deepEqual(labelsBlockers(["BLOCKED-BY:#5", "blocked-by:12"], ""), [5, 12]);
  assert.deepEqual(labelsBlockers([], "sapwood:"), []);
});

test("hasReserveLabel: any of the reserve-ish labels present", () => {
  const reserveish = ["reserve", "needs-human"];
  assert.equal(hasReserveLabel(["reserve", "type:decision"], reserveish), true);
  assert.equal(hasReserveLabel(["needs-human"], reserveish), true);
  assert.equal(hasReserveLabel(["Needs-Human"], reserveish), true);
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
    dailySpendUsd: 10,
    dailyBudgetUsd: 100,
    wallClockElapsedSec: 100,
    maxWallClockSec: 14400,
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
    dailySpendUsd: 200,
    dailyBudgetUsd: 100,
    wallClockElapsedSec: 99999,
    maxWallClockSec: 14400,
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
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
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

// ── #147: gated-PR reentry — a human removing needs-human from an escalated PR's issue
// reclaims the SAME worker row/PR/branch back into `driving` and re-drives it through the
// ordinary DRIVE loop. No new worker/dispatch, ever. ──────────────────────────────────────────

test("gatedReentryDecision: any human-hold label present -> SKIP (no complete human act yet); all holds cleared + under cap -> RECLAIM; at/over cap -> CAPPED", () => {
  assert.equal(gatedReentryDecision(true, 0, 2), "SKIP");
  assert.equal(gatedReentryDecision(true, 5, 2), "SKIP"); // a standing hold always wins, regardless of attempts
  assert.equal(gatedReentryDecision(false, 0, 2), "RECLAIM");
  assert.equal(gatedReentryDecision(false, 1, 2), "RECLAIM");
  assert.equal(gatedReentryDecision(false, 2, 2), "CAPPED");
  assert.equal(gatedReentryDecision(false, 3, 2), "CAPPED");
  assert.equal(gatedReentryDecision(false, 0, 0), "CAPPED"); // cap=0 disables reentry outright
});

test("resumeDecision (#172): exhaustive confirmed × undecidable × paused × kill-switch × holds × attempts-vs-cap × capacity table", () => {
  const cap = 2;
  for (const confirmed of [false, true]) {
    for (const undecidable of [false, true]) {
      for (const paused of [false, true]) {
        for (const killed of [false, true]) {
          for (const held of [false, true]) {
            for (const attempts of [1, 2, 3]) {
              for (const full of [false, true]) {
                const actual = resumeDecision(paused, killed, held, confirmed, undecidable, attempts, cap, full ? 2 : 1, 2);
                let expected = "RESUME";
                if (confirmed) expected = "ADOPT";
                else if (killed || held) expected = "SKIP";
                else if (undecidable) expected = "UNDECIDABLE";
                else if (attempts >= cap) expected = "CAPPED";
                else if (paused || full) expected = "SKIP";
                assert.equal(actual, expected, JSON.stringify({ confirmed, undecidable, paused, killed, held, attempts, full }));
              }
            }
          }
        }
      }
    }
  }
  assert.equal(resumeDecision(false, false, false, false, false, 0, 0, 0, 1), "CAPPED");
});

test("#170 review silence: aged episode labels PR + emits once while driving; verdict is human-held; label removal re-enters and merges", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-review-silence-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const st = new State(path);
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    const cfg = mkCfg({ reviewer: { escalateAfterSec: 60 } });
    const now = new Date("2026-07-15T00:02:00.000Z");
    const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now: () => now });

    st.upsertWorker({
      name: "lane-silent",
      issue: 170,
      session_id: "s-lane-silent",
      state: "driving",
      started_at: "t0",
      ended_at: null,
      pr: 170,
      review_triggered_head: "H1",
      review_triggered_at: "2026-07-15T00:00:00.000Z",
    });
    forge.prStatus = { number: 170, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
    forge.prReviewData = { ...forge.prReviewData, headOid: "H1", labels: [], reviews: [] };

    const silent = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.equal(st.getWorker("lane-silent")?.state, "driving");
    assert.deepEqual(silent.driven, [{ kind: "queued", worker: "lane-silent", issue: 170, pr: 170, reason: "gate-pending:WAIT_REVIEW" }]);
    assert.deepEqual(forge.prLabelsAdded, [[170, "needs-human"]]);

    const raw = new DatabaseSync(path);
    const event = raw.prepare("SELECT kind, payload FROM events WHERE kind = ?").get("review-silence-escalated") as
      | { kind: string; payload: string }
      | undefined;
    raw.close();
    assert.equal(event?.kind, "review-silence-escalated");
    assert.deepEqual(JSON.parse(event!.payload), {
      worker: "lane-silent",
      issue: 170,
      pr: 170,
      head: "H1",
      silenceSec: 120,
    });

    // A decisive review later arrives, but the PR label wins: existing gate semantics route the
    // lane to HUMAN and put the issue on the existing gated-reentry hold.
    forge.prReviewData = {
      ...forge.prReviewData,
      reviews: [{ author: CODEX_REVIEWER_LOGINS[0], commitOid: "H1", state: "COMMENTED", submittedAt: "2026-07-15T00:01:00Z" }],
    };
    const held = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.equal(st.getWorker("lane-silent")?.state, "failed");
    assert.deepEqual(held.driven, [{ kind: "needs-human", worker: "lane-silent", issue: 170, pr: 170, reason: "gate:HUMAN:MERGE_OK" }]);
    assert.equal(rawEventKinds(path).filter((k) => k === "review-silence-escalated").length, 1);

    // Human clears both synchronized holds. Existing gated reentry clears the old pin and posts
    // a fresh trigger; only a post-trigger review can then merge.
    forge.issueLabelsByIssue[170] = [];
    forge.prReviewData = { ...forge.prReviewData, labels: [], reviews: [] };
    const reentered = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(reentered.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-silent", issue: 170, pr: 170, attempt: 1 }]);
    assert.deepEqual(reentered.driven, [{ kind: "queued", worker: "lane-silent", issue: 170, pr: 170, reason: "review-triggered" }]);

    forge.prReviewData = {
      ...forge.prReviewData,
      reviews: [{ author: CODEX_REVIEWER_LOGINS[0], commitOid: "H1", state: "COMMENTED", submittedAt: "2026-07-15T00:03:00Z" }],
    };
    const merged = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(merged.driven, [{ kind: "merged", worker: "lane-silent", issue: 170, pr: 170 }]);
    assert.deepEqual(forge.merged, [[170, "H1"]]);
    assert.equal(sup.dispatched.length, 0);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#147 round-4 P2 (Codex PR #151): needs-human removed but `blocked` (another escalation.humanLabels entry) still on the issue -> SKIP, no reclaim; clearing blocked too on a later tick -> RECLAIM proceeds", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg(); // escalation.humanLabels defaults to [needs-human, blocked]
  const gate = new FakeMergeGate();
  gate.outcomes[600] = { kind: "queued", pr: 600, reason: "gate-pending:WAIT_REVIEW" };

  st.upsertWorker({
    name: "lane-h",
    issue: 50,
    session_id: "s-lane-h",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 600,
    gated_escalation_labeled: 1,
  });
  // A human removed needs-human — but `blocked` still stands on the issue. The human-hold set
  // is the WHOLE escalation.humanLabels list (dispatch's standard): the merge driver's
  // human-label veto reads the PR's labels, not the issue's, so a reclaim here would drive an
  // issue-blocked PR toward merge.
  forge.issueLabelsByIssue[50] = ["blocked"];
  const r1 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, []); // SKIP — no outcome of any kind
  assert.equal(st.getWorker("lane-h")?.state, "failed"); // untouched
  assert.equal(st.getWorker("lane-h")?.gated_reentry_attempts, 0); // no attempt burned

  // The human clears `blocked` too — now every hold is gone: reclaim proceeds.
  forge.issueLabelsByIssue[50] = [];
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r2.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-h", issue: 50, pr: 600, attempt: 1 }]);
  assert.equal(st.getWorker("lane-h")?.state, "driving");
  assert.equal(sup.dispatched.length, 0);
  st.close();
});

test("#147 gated-PR reentry: an escalated PR whose threads are resolved and label cleared is reclaimed on the next round, driven through gate② on the EXISTING branch (review-triggered -> merged), and no worker is ever spawned", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  // Fixed engine clock (#147 P1): the re-trigger pin's `at` is recorded from this, and the
  // re-driven gate② counts only reviews submitted strictly AFTER it.
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now: () => new Date("2026-07-02T00:00:00.000Z") });

  // Pre-existing state: gate② already escalated PR #99 (issue #10) to needs-human for
  // HANDLE_THREADS — failed, PR retained (labeled=1: the escalation's label write succeeded),
  // the ORIGINAL drive's trigger pin still on file.
  st.upsertWorker({
    name: "lane-a",
    issue: 10,
    session_id: "s-lane-a",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 99,
    review_triggered_head: "H1",
    review_triggered_at: "2026-07-01T00:00:00.000Z",
    gated_escalation_labeled: 1,
  });
  forge.prStatus = { number: 99, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  // Human resolves the review threads AND removes needs-human from the issue (the explicit
  // reentry signal); a FRESH accepted Codex review lands after the re-entry's trigger
  // (submittedAt > the re-trigger pin — #147 P1: a pre-reentry review would NOT count).
  forge.prReviewData = {
    headOid: "H1",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    reviews: [{ author: CODEX_REVIEWER_LOGINS[0], commitOid: "H1", state: "COMMENTED", submittedAt: "2026-07-02T00:05:00Z" }],
    unresolvedThreads: 0,
  };
  forge.issueLabelsByIssue[10] = [];

  const r1 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  // Reclaimed straight back to `driving` — same worker row, no dispatch.
  assert.deepEqual(r1.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-a", issue: 10, pr: 99, attempt: 1 }]);
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  assert.equal(st.getWorker("lane-a")?.gated_reentry_attempts, 1);
  // The recorded trigger pin was cleared, so driveOne (same tick, right after the reclaim)
  // treats this unchanged head as never-triggered and posts a FRESH @codex review comment.
  assert.equal(forge.prComments.length, 1);
  assert.deepEqual(r1.driven, [{ kind: "queued", worker: "lane-a", issue: 10, pr: 99, reason: "review-triggered" }]);
  assert.equal(sup.dispatched.length, 0); // no worker spawned

  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  // Pin now matches -> gate② evaluates the live (resolved) data; the review post-dates the
  // re-trigger, so it counts -> MERGE_OK; CI green -> merge.
  assert.deepEqual(r2.driven, [{ kind: "merged", worker: "lane-a", issue: 10, pr: 99 }]);
  assert.equal(st.getWorker("lane-a")?.state, "done");
  assert.deepEqual(forge.merged, [[99, "H1"]]);
  assert.equal(sup.dispatched.length, 0); // still zero across the whole re-drive
  st.close();
});

test("#147 P1 (Codex PR #151): a STALE review (submitted before the re-entry's trigger) never satisfies the re-driven gate② — the lane queues until a FRESH post-reentry review lands", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now: () => new Date("2026-07-02T00:00:00.000Z") });

  st.upsertWorker({
    name: "lane-s",
    issue: 20,
    session_id: "s-lane-s",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 88,
    review_triggered_head: "H1",
    review_triggered_at: "2026-06-30T00:00:00.000Z",
    gated_escalation_labeled: 1,
  });
  forge.prStatus = { number: 88, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  // The Codex-P1 scenario exactly: the ORIGINAL pre-escalation COMMENTED review (the one whose
  // threads caused HANDLE_THREADS) still sits on the UNCHANGED head; a human resolves the
  // threads (unresolvedThreads -> 0) and removes needs-human. Without the freshness cutoff,
  // that stale review would read as a fresh accepted review and auto-merge on the tick after
  // the re-trigger — without the re-review ever responding.
  forge.prReviewData = {
    headOid: "H1",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    reviews: [{ author: CODEX_REVIEWER_LOGINS[0], commitOid: "H1", state: "COMMENTED", submittedAt: "2026-07-01T00:00:00Z" }],
    unresolvedThreads: 0,
  };
  forge.issueLabelsByIssue[20] = [];

  // Tick 1: reclaimed + fresh re-trigger posted (pin recorded at the fixed clock, 07-02).
  const r1 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-s", issue: 20, pr: 88, attempt: 1 }]);
  assert.deepEqual(r1.driven, [{ kind: "queued", worker: "lane-s", issue: 20, pr: 88, reason: "review-triggered" }]);

  // Tick 2: pin matches, but the only review predates the re-trigger (07-01 < 07-02) — it is
  // filtered out, the verdict is WAIT_REVIEW, the lane QUEUES. Never a merge.
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r2.driven, [{ kind: "queued", worker: "lane-s", issue: 20, pr: 88, reason: "gate-pending:WAIT_REVIEW" }]);
  assert.deepEqual(forge.merged, []);
  assert.equal(st.getWorker("lane-s")?.state, "driving"); // still waiting on the fresh review

  // The FRESH re-review responds (submitted after the re-trigger pin) — now it counts.
  forge.prReviewData = {
    ...forge.prReviewData,
    reviews: [
      ...forge.prReviewData.reviews,
      { author: CODEX_REVIEWER_LOGINS[0], commitOid: "H1", state: "COMMENTED", submittedAt: "2026-07-02T00:10:00Z" },
    ],
  };
  const r3 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r3.driven, [{ kind: "merged", worker: "lane-s", issue: 20, pr: 88 }]);
  assert.deepEqual(forge.merged, [[88, "H1"]]);
  assert.equal(sup.dispatched.length, 0); // no worker across the whole sequence
  st.close();
});

test("#147 gated-PR reentry: a PR that fails the re-driven gate (findings still standing) re-escalates needs-human with the attempt trail; attempts are bounded (cap reached -> re-escalated + permanently capped, never retried again)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // #246: prFixCap: 0 isolates this test to the #147 gated-reentry-cap/attempt-trail mechanism
  // it actually tests — with the fix loop enabled, standing HANDLE_THREADS would route to
  // FIXABLE (a fix-leg retry) before ever reaching this re-escalation path; that routing has
  // its own dedicated #246 tests above.
  const cfg = mkCfg({ lanes: { gatedReentryCap: 1, prFixCap: 0 } });
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg });

  st.upsertWorker({
    name: "lane-b",
    issue: 11,
    session_id: "s-lane-b",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 199,
    review_triggered_head: "H1",
    review_triggered_at: "2026-07-01T00:00:00.000Z",
    gated_escalation_labeled: 1,
  });
  forge.prStatus = { number: 199, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  // The findings are STILL standing (unresolvedThreads unchanged) — a human removed
  // needs-human believing it was fixed, but a re-review will find the same problem.
  forge.prReviewData = {
    headOid: "H1",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    reviews: [],
    unresolvedThreads: 2,
  };
  forge.issueLabelsByIssue[11] = [];

  // Tick 1: reclaimed + re-triggered (identical shape to the happy-path test above).
  const r1 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-b", issue: 11, pr: 199, attempt: 1 }]);
  assert.deepEqual(r1.driven, [{ kind: "queued", worker: "lane-b", issue: 11, pr: 199, reason: "review-triggered" }]);
  assert.equal(st.getWorker("lane-b")?.state, "driving");

  // Tick 2: pin now matches -> gate② re-evaluates the SAME standing findings -> HANDLE_THREADS
  // -> needs-human again. Never a merge.
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.equal(st.getWorker("lane-b")?.state, "failed");
  assert.equal(st.getWorker("lane-b")?.gated_reentry_attempts, 1);
  assert.equal(st.getWorker("lane-b")?.gated_reentry_capped, 0); // cap is only latched on the NEXT removal
  assert.deepEqual(r2.driven, [{ kind: "needs-human", worker: "lane-b", issue: 11, pr: 199, reason: "gate:HUMAN:HANDLE_THREADS" }]);
  assert.deepEqual(forge.labelsAdded, [[11, "needs-human"]]);
  // A REPEAT escalation (gated_reentry_attempts > 0) carries the attempt trail — the very first
  // escalation for a lane never gets this comment.
  assert.equal(forge.issueComments.length, 1);
  assert.match(forge.issueComments[0]![1], /attempt 1\/1/);
  assert.match(forge.issueComments[0]![1], /last automatic attempt/);
  // #167 review (Codex P2+P3 adjudication): cap-hit is this codebase's nearest mechanism to
  // the review doctrine's prFixCap→needs-human pattern — the escalation comment states the
  // principle (re-examine design/technical direction, not more patches) SELF-CONTAINED, true
  // regardless of doctrine adoption. mkCfg() here builds cfg via ConfigSchema.parse with no
  // doctrine file on disk at the default path — the legal, common "no doctrine adopted" case
  // (doctrine.ts's NO_DOCTRINE) — so the comment must NOT cite a doctrine file that doesn't
  // exist.
  assert.match(forge.issueComments[0]![1], /re-examine the feature's design/i);
  assert.doesNotMatch(forge.issueComments[0]![1], /review doctrine/i);
  assert.doesNotMatch(forge.issueComments[0]![1], /point 4/i);
  assert.equal(sup.dispatched.length, 0); // never a new worker, even across the re-escalation

  // Human removes needs-human a SECOND time — but the cap (1) is already spent.
  forge.issueLabelsByIssue[11] = [];
  const r3 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r3.gatedReclaimed, [{ kind: "capped", worker: "lane-b", issue: 11, pr: 199, attempts: 1 }]);
  assert.equal(st.getWorker("lane-b")?.state, "failed"); // never reclaimed this time
  assert.equal(st.getWorker("lane-b")?.gated_reentry_capped, 1);
  assert.deepEqual(forge.labelsAdded, [
    [11, "needs-human"],
    [11, "needs-human"],
  ]); // re-applied
  assert.equal(forge.issueComments.length, 2); // the cap-reached notice
  assert.equal(sup.dispatched.length, 0);

  // A THIRD removal changes nothing — the row is permanently excluded from here on.
  forge.issueLabelsByIssue[11] = [];
  const r4 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r4.gatedReclaimed, []);
  assert.equal(st.getWorker("lane-b")?.state, "failed");
  st.close();
});

// #167 review (Codex P2+P3 adjudication): capHitEscalationNote — direct unit tests for the
// helper extracted from the gated-reentry-cap escalation comment above. Covers the two
// defects the review found: (a) unconditionally citing "review doctrine, adjudication point
// 4" even when no doctrine file exists; (b) leaking the RESOLVED ABSOLUTE `cfg.doctrine.file`
// path (loadConfig absolutizes it) instead of the raw path as the user wrote it in config.

test("capHitEscalationNote: no doctrine file present -> principle stated self-contained, no doctrine citation", () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    doctrine: { file: "/nonexistent/REVIEW-DOCTRINE.md" },
  });
  const note = capHitEscalationNote(cfg);
  assert.match(note, /last automatic attempt/i);
  assert.match(note, /re-examine the feature's design/i);
  assert.doesNotMatch(note, /review doctrine/i);
  assert.doesNotMatch(note, /\/nonexistent\/REVIEW-DOCTRINE\.md/);
});

test("capHitEscalationNote: a doctrine file loaded via loadConfig -> cites the RAW, pre-resolution path, never the resolved absolute path", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const cfgPath = join(dir, "sapwood.config.yaml");
    const docsDir = join(dir, "docs");
    mkdirSync(docsDir, { recursive: true });
    writeFileSync(join(docsDir, "REVIEW-DOCTRINE.md"), "# doctrine\nadjudication point 4: re-examine design.\n");
    writeFileSync(cfgPath, "board: { owner: o, repo: r, projectNumber: 4 }\ndoctrine: { file: docs/REVIEW-DOCTRINE.md }\n");
    const cfg = loadConfig(cfgPath);
    // Sanity: loadConfig really did resolve the path to an absolute one under dir.
    assert.equal(cfg.doctrine.file, join(docsDir, "REVIEW-DOCTRINE.md"));

    const note = capHitEscalationNote(cfg);
    assert.match(note, /last automatic attempt/i);
    assert.match(note, /review doctrine/i);
    // The RAW, as-configured (relative) path is cited...
    assert.match(note, /`docs\/REVIEW-DOCTRINE\.md`/);
    // ...but the RESOLVED ABSOLUTE path (which would leak this machine's directory layout onto
    // a public GitHub comment) never appears.
    assert.doesNotMatch(note, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("capHitEscalationNote: cfg built via ConfigSchema.parse directly (no loadConfig, no fileRaw) still never cites a resolved absolute path — falls back to cfg.doctrine.file, which is already the raw value in this path", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cfg-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    writeFileSync(path, "doctrine content");
    const cfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      doctrine: { file: path },
    });
    assert.equal(cfg.doctrine.fileRaw, undefined); // never set outside loadConfig
    const note = capHitEscalationNote(cfg);
    assert.match(note, /review doctrine/i);
    assert.match(note, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))); // cfg.doctrine.file IS the raw value here
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#147 round-3 P2 (Codex PR #151): CAPPED latches ONLY after the needs-human label provably lands — a transient label failure retries next tick instead of permanently hiding the PR from human triage", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ lanes: { gatedReentryCap: 1 } });
  const gate = new FakeMergeGate();

  // Cap already spent (attempts = cap = 1) and the human removed needs-human again — the
  // CAPPED branch fires. Its job is to RESTORE the label + latch; if the latch landed while
  // the label write failed, the row would leave gatedFailedWorkers() forever with no label on
  // the issue: invisible to automation AND to human triage.
  st.upsertWorker({
    name: "lane-z",
    issue: 40,
    session_id: "s-lane-z",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 500,
    gated_reentry_attempts: 1,
    gated_escalation_labeled: 1,
  });
  forge.issueLabelsByIssue[40] = [];

  // Tick 1: the label write throws (transient forge failure) — NO latch, NO capped outcome,
  // failure recorded durably; the row stays eligible for a retry.
  forge.throwOnAddLabel = true;
  const r1 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, []); // no "capped" outcome emitted on a failed label
  assert.equal(st.getWorker("lane-z")?.gated_reentry_capped, 0); // NOT latched
  assert.equal(st.gatedFailedWorkers().length, 1); // still a candidate next tick
  assert.equal(
    st.eventsSince("2020-01-01T00:00:00Z", ["gated-reentry-capped-label-failed"]).length,
    1, // the failure is durably recorded, never a silent swallow
  );

  // Tick 2: the forge recovers — label applied FIRST, then the latch + outcome, exactly once.
  forge.throwOnAddLabel = false;
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r2.gatedReclaimed, [{ kind: "capped", worker: "lane-z", issue: 40, pr: 500, attempts: 1 }]);
  assert.deepEqual(forge.labelsAdded, [[40, "needs-human"]]); // restored where triage looks
  assert.equal(st.getWorker("lane-z")?.gated_reentry_capped, 1); // latched only now
  assert.equal(st.gatedFailedWorkers().length, 0); // permanently excluded from here on

  // Tick 3: nothing further — the latch holds, no duplicate outcome/label/comment.
  const r3 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r3.gatedReclaimed, []);
  assert.equal(forge.labelsAdded.length, 1);
  st.close();
});

test("#147 gated-PR reentry: without a mergeGate configured, an eligible failed+PR lane is never reclaimed (mirrors pre-#13 DRIVE behavior — nothing to drive it through)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  st.upsertWorker({
    name: "lane-c",
    issue: 12,
    session_id: "s-lane-c",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 300,
    gated_escalation_labeled: 1,
  });
  forge.issueLabelsByIssue[12] = []; // label already removed
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }); // no mergeGate
  assert.deepEqual(r.gatedReclaimed, []);
  assert.equal(st.getWorker("lane-c")?.state, "failed"); // untouched
  st.close();
});

test("#147 P2 (Codex PR #151): a FAILED needs-human label write means label absence is NOT a human act — the row records labeled=0 and GATED RECLAIM never reclaims it", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  const gate = new FakeMergeGate();

  // A driving lane whose gate outcome escalates — but the needs-human addLabel call throws
  // (transient forge failure). The escalation must still land durably (terminal row + event),
  // with labeled=0 proving the label never applied.
  seedRunning(st, "lane-x", 30);
  sup.probes["lane-x"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 400 };
  gate.outcomes[400] = { kind: "needs-human", pr: 400, reason: "gate:HUMAN:HANDLE_THREADS" };
  forge.throwOnAddLabel = true;
  const r1 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.equal(st.getWorker("lane-x")?.state, "failed"); // terminal transition still landed
  assert.equal(st.getWorker("lane-x")?.gated_escalation_labeled, 0); // label write provably failed
  assert.deepEqual(forge.labelsAdded, []); // nothing landed on the issue
  assert.deepEqual(r1.driven, [{ kind: "needs-human", worker: "lane-x", issue: 30, pr: 400, reason: "gate:HUMAN:HANDLE_THREADS" }]);

  // Next tick: the issue has NO needs-human label — exactly the state a transient label
  // failure leaves behind. Without the labeled marker this would read as an explicit human
  // removal and automation would re-admit itself with no human in the loop. It must not.
  forge.throwOnAddLabel = false;
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r2.gatedReclaimed, []);
  assert.equal(st.getWorker("lane-x")?.state, "failed"); // permanently manual-drive (pre-#147 situation)
  st.close();
});

test("#147 P2: the happy-path escalation records labeled=1 (label applied), which is what makes the later reclaim legitimate", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const gate = new FakeMergeGate();
  seedRunning(st, "lane-y", 31);
  sup.probes["lane-y"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 401 };
  gate.outcomes[401] = { kind: "needs-human", pr: 401, reason: "gate:HUMAN:HANDLE_THREADS" };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-y")?.state, "failed");
  assert.equal(st.getWorker("lane-y")?.gated_escalation_labeled, 1);
  assert.deepEqual(forge.labelsAdded, [[31, "needs-human"]]);
  st.close();
});

// ── #168: environment-failure park — detect, park (per source), canary-probe, auto-resume,
//    timed escalation. Decision table (env-failure × source × has-PR × reentry state), the
//    park/probe/backoff/escalation state machine, channel-ladder selection, and the storm /
//    oscillation / mixed-storm integrations from the issue's Verification section plus the
//    PR #180 review's named regression tests (P1-1..P1-4, P2, P3).

test("#168: FAILED lane with an LLM env-failure signature, no PR -> classified env-failure (not 'failed'), issue requeued to Ready untouched, no needs-human, engine parks (source: llm)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 501);
  sup.probes["lane-a"] = {
    ...DEFAULT_PROBE,
    failed: true,
    hasPr: false,
    failureText: "API Error: rate_limit_error — please retry later",
  };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  assert.deepEqual(r.reclaimed, [{ kind: "env-failure", worker: "lane-a", issue: 501, source: "llm", costUsd: 0, modelUsage: [] }]);
  assert.deepEqual(forge.labelsAdded, []); // never needs-human
  assert.deepEqual(forge.boardSet, [[501, "ready"]]); // returned to the queue (forge healthy — llm-only park)
  assert.equal(st.getWorker("lane-a")?.state, "failed"); // terminal, frees the lane
  assert.equal(st.getWorker("lane-a")?.pr, null); // never satisfies gatedFailedWorkers' pr filter
  assert.equal(st.gatedFailedWorkers().length, 0); // zero gated-reentry consumption
  assert.equal(st.isParked(), true);
  assert.equal(st.parkRow("llm")?.triggerIssue, 501);
  st.close();
});

test("#168: FAILED lane with a forge env-failure signature, no PR -> same disposition, park source: forge; the requeue is SUSPENDED durably (P1-2: zero forge writes while forge-parked)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-b", 502);
  sup.probes["lane-b"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "ssh: Could not resolve host: github.com" };
  // The PARK-section forge probe (post-reclaim, same tick) must also see it still down.
  forge.listOpenIssueNumbers = async () => {
    throw new Error("still down");
  };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  assert.equal(r.reclaimed[0]?.kind, "env-failure");
  assert.equal((r.reclaimed[0] as { source: string }).source, "forge");
  assert.deepEqual(forge.labelsAdded, []);
  // P1-2: NO board write attempted while the forge episode is open — the requeue intent is
  // persisted durably instead, to drain on resume.
  assert.deepEqual(forge.boardSet, []);
  assert.equal(st.pendingRollbacks().length, 1);
  assert.equal(st.pendingRollbacks()[0]?.reason, "env-failure-requeue");
  assert.equal(st.pendingRollbacks()[0]?.attempts, 0); // never attempted -> counter frozen
  assert.equal(st.parkRow("forge")?.source, "forge");
  st.close();
});

test("#168: FAILED lane with an env-failure signature + a CLEAN PR -> unchanged rescue-to-driving disposition, engine STILL parks (decision 1 is unconditional on hasPr)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-c", 503);
  sup.probes["lane-c"] = {
    ...DEFAULT_PROBE,
    failed: true,
    hasPr: true,
    prNumber: 77,
    failureText: "usage limit reached for this billing period",
  };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  // Same disposition an ordinary FAILED+PR lane always had: rescued to driving, no needs-human.
  assert.deepEqual(r.reclaimed, [{ kind: "failed", worker: "lane-c", issue: 503, next: "DRIVING", costUsd: 0, modelUsage: [] }]);
  assert.equal(st.getWorker("lane-c")?.state, "driving");
  assert.equal(st.getWorker("lane-c")?.pr, 77);
  assert.deepEqual(forge.labelsAdded, []);
  // But the engine still parks — decision 1 does not carve out a has-PR exception.
  assert.equal(st.isParked(), true);
  assert.equal(st.parkRow("llm")?.source, "llm");
  st.close();
});

test("#168 P1-4: env-failure + PR + DIRTY worktree -> env precedence: preserved failed+PR shape, ZERO labels/forge writes, zero reentry consumption, worktree retained — never the ordinary dirty=>needs-human path", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.throwOnAddLabel = true; // any needs-human attempt would blow the tick — proves none happens
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-dirty", 505);
  sup.probes["lane-dirty"] = {
    ...DEFAULT_PROBE,
    failed: true,
    hasPr: true,
    prNumber: 88,
    failureText: "gh: Service Unavailable (HTTP 503)",
  };
  sup.inspectResults["lane-dirty"] = { worktreePath: "/tmp/wt-505", worktreeRetained: true };
  forge.listOpenIssueNumbers = async () => {
    throw new Error("down");
  }; // forge outage, consistently
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  assert.deepEqual(r.reclaimed, [{ kind: "env-failure", worker: "lane-dirty", issue: 505, source: "forge", costUsd: 0, modelUsage: [] }]);
  assert.deepEqual(forge.labelsAdded, []); // no needs-human on the issue
  assert.deepEqual(forge.prLabelsAdded, []); // none on the PR either
  assert.deepEqual(forge.issueComments, []); // no retained-worktree comment — zero forge writes
  const row = st.getWorker("lane-dirty");
  assert.equal(row?.state, "failed");
  assert.equal(row?.pr, 88); // lane/PR preserved
  assert.equal(row?.gated_escalation_labeled, 0); // the #147 fail-closed preservation shape
  assert.equal(st.gatedFailedWorkers().length, 0); // invisible to gated reclaim — zero reentry-cap spend
  assert.deepEqual(sup.reclaimed, []); // no teardown — worktree left on disk
  const preserved = st.eventsSince("2020-01-01T00:00:00Z", ["env-failure-preserved"]);
  assert.equal(preserved.length, 1);
  // biome-ignore lint/correctness/noUnsafeOptionalChaining: this test requires the asserted event payload to exist.
  assert.equal((preserved[0]?.payload as { worktreePath: string }).worktreePath, "/tmp/wt-505");
  assert.equal(st.isParked(), true);
  st.close();
});

test("#168 negative: a FAILED lane whose text merely DISCUSSES rate limits (no real signature) is an ORDINARY task failure — needs-human as always, never parks", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-d", 504);
  sup.probes["lane-d"] = {
    ...DEFAULT_PROBE,
    failed: true,
    hasPr: false,
    failureText: "AssertionError: expected the client to add rate limiting; TODO handle usage limits gracefully",
  };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  assert.deepEqual(r.reclaimed, [{ kind: "failed", worker: "lane-d", issue: 504, next: "ESCALATE", costUsd: 0, modelUsage: [] }]);
  assert.deepEqual(forge.labelsAdded, [[504, "needs-human"]]); // ordinary escalation, unchanged
  assert.equal(st.isParked(), false);
  st.close();
});

test("#168 storm: all lanes failing with env signatures in one tick (mixed sources, forge label-writes throwing) -> zero needs-human, zero reentry consumption, BOTH sources parked (P1-1a), forge-suspended requeues durable", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.throwOnAddLabel = true; // proves needs-human is never even ATTEMPTED for these lanes
  forge.listOpenIssueNumbers = async () => {
    throw new Error("outage");
  };
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-e1", 601);
  seedRunning(st, "lane-e2", 602);
  seedRunning(st, "lane-e3", 603);
  sup.probes["lane-e1"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "rate_limit_error" };
  sup.probes["lane-e2"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "gh: Bad credentials" };
  sup.probes["lane-e3"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "overloaded_error" };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  assert.deepEqual(
    r.reclaimed.map((x) => x.kind),
    ["env-failure", "env-failure", "env-failure"],
  );
  assert.deepEqual(forge.labelsAdded, []);
  assert.equal(st.gatedFailedWorkers().length, 0);
  // Mixed storm: the llm episode (e1) AND the forge episode (e2) both exist — the old
  // singleton INSERT OR IGNORE dropped the second source entirely (P1-1a).
  assert.deepEqual(
    st
      .parkedSources()
      .map((p) => p.source)
      .sort(),
    ["forge", "llm"],
  );
  assert.equal(st.parkRow("llm")?.triggerIssue, 601); // first detection wins per source
  assert.equal(st.parkRow("forge")?.triggerIssue, 602);
  // e1 requeued BEFORE the forge episode opened (llm-only park at that instant); e2/e3's
  // requeues arrived after and are suspended durably.
  assert.deepEqual(forge.boardSet, [[601, "ready"]]);
  assert.equal(st.pendingRollbacks().filter((p) => p.reason === "env-failure-requeue").length, 2);
  st.close();
});

test("#168 dispatch gate: parked -> dispatch skipped entirely (mirrors PAUSE: no new lane, not even a 'skipped' row); reclaim/drive of OTHER lanes proceed normally", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  st.enterPark("forge", "could not resolve host", 999, "2026-07-14T00:00:00Z");
  forge.listOpenIssueNumbers = async () => {
    throw new Error("down");
  };
  // A driving lane with a mergeable PR: DRIVE must still proceed while parked (same as PAUSE).
  st.upsertWorker({ name: "lane-drv", issue: 3, session_id: "s", state: "driving", started_at: "t", ended_at: "t2", pr: 56 });
  const gate = new FakeMergeGate();
  gate.outcomes[56] = { kind: "merged", pr: 56, headOid: "H" };
  forge.ready = [{ number: 9, title: "", labels: ["prio:1-high"] }];

  const r = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    now: () => new Date("2026-07-14T00:10:00Z"),
  });

  assert.deepEqual(r.dispatched, []);
  assert.deepEqual(forge.claimed, []);
  assert.deepEqual(sup.dispatched, []);
  assert.equal(gate.calls.length, 1); // DRIVE unaffected by park, exactly like PAUSE
  assert.deepEqual(r.driven, [{ kind: "merged", worker: "lane-drv", issue: 3, pr: 56 }]);
  st.close();
});

test("#168 probe/backoff (P1-1c): the FIRST probe waits a full base backoff (never due immediately); the forge probe reuses an EXISTING lightweight IForge read, no forge write ever", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  let forgeProbeCalls = 0;
  forge.listOpenIssueNumbers = async () => {
    forgeProbeCalls++;
    throw new Error("still down");
  };
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("forge", "could not resolve host", 1, t0.toISOString());

  // Immediately after entry: NOT due (lastProbeAt seeded to entry time; base backoff 30s).
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), now: () => t0 });
  assert.equal(forgeProbeCalls, 0);
  assert.equal(st.parkRow("forge")?.probeAttempts, 0);

  // Past the base backoff -> first probe fires (and fails).
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), now: () => new Date(t0.getTime() + 31_000) });
  assert.equal(forgeProbeCalls, 1);
  assert.equal(st.parkRow("forge")?.probeAttempts, 1);

  // 5s later: under the (now-doubled, attempts=1 -> 60s) backoff -> no second probe.
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), now: () => new Date(t0.getTime() + 36_000) });
  assert.equal(forgeProbeCalls, 1);

  // Past the doubled window -> due again.
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), now: () => new Date(t0.getTime() + 95_000) });
  assert.equal(forgeProbeCalls, 2);
  assert.equal(st.parkRow("forge")?.probeAttempts, 2);
  // Never a single forge WRITE while parked-for-forge — only the read-only probe.
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.issueComments, []);
  assert.deepEqual(forge.boardSet, []);
  st.close();
});

test("#168 P2-B auto-resume (forge): a successful probe clears the episode, but dispatch resumes NEXT tick — never the recovery tick itself", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.ready = [{ number: 701, title: "", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("forge", "could not resolve host", 701, t0.toISOString());
  // forge.listOpenIssueNumbers succeeds by default (FakeForge) -> the probe succeeds once due.

  // Recovery tick: the probe clears the episode, but dispatch stays gated for the remainder of
  // this tick (P2-B — the next tick's rollback-retry-before-dispatch ordering is what makes
  // suspended requeues fair; see the fairness test below for the race this closes).
  const r1 = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    now: () => new Date(t0.getTime() + 31_000), // past the base backoff -> probe due -> succeeds
  });
  assert.equal(st.isParked(), false); // cleared within the recovery tick
  assert.deepEqual(r1.dispatched, []); // ...but no dispatch until the next tick
  assert.deepEqual(sup.dispatched, []);

  // Next tick: fully resumed.
  const r2 = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    now: () => new Date(t0.getTime() + 62_000),
  });
  assert.deepEqual(
    sup.dispatched.map((i) => i.number),
    [701],
  );
  assert.equal(r2.dispatched.filter((d) => d.kind === "dispatched").length, 1);
  st.close();
});

test("#168 P2-B fairness: the outage VICTIM's suspended requeue drains before a competitor can fill the lanes — recovery tick dispatches nothing, next tick's rollback-then-dispatch order admits the victim first", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  // Board-status-driven Ready queue (the old statically-pre-seeded `ready` MASKED this race:
  // the victim looked dispatchable before its board rollback ever executed). The competitor
  // (901) is genuinely Ready throughout; the victim (900) only re-enters Ready when its
  // suspended requeue's setBoardStatus actually lands.
  forge.ready = [{ number: 901, title: "", labels: ["prio:3-feature"] }];
  let forgeUp = false;
  forge.listOpenIssueNumbers = async () => {
    if (!forgeUp) throw new Error("down");
    return [];
  };
  forge.setBoardStatus = async (n, s) => {
    if (!forgeUp) throw new Error("down");
    forge.boardSet.push([n, s]);
    if (s === "ready" && !forge.ready.some((i) => i.number === n)) {
      forge.ready.push({ number: n, title: "", labels: ["prio:3-feature"] });
    }
  };
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ lanes: { max: 1 }, envFailure: { probeBackoffBaseSec: 1, probeBackoffMaxSec: 1 } });
  const t0 = new Date("2026-07-14T00:00:00Z");
  seedRunning(st, "lane-v", 900);
  sup.probes["lane-v"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "Could not resolve host: github.com" };

  // Tick 1: forge outage -> park; the victim's requeue is suspended durably (not in Ready).
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => t0 });
  assert.equal(st.parkRow("forge")?.source, "forge");
  assert.ok(!forge.ready.some((i) => i.number === 900));

  // Tick 2 (recovery): the probe succeeds -> episode clears — but dispatch is DEFERRED, so the
  // competitor cannot grab the single lane while the victim is still stuck behind its requeue.
  forgeUp = true;
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 2_000) });
  assert.equal(st.isParked(), false);
  assert.deepEqual(r2.dispatched, []);
  assert.deepEqual(sup.dispatched, []);

  // Tick 3: ROLLBACK RETRY drains the victim's requeue FIRST (tick-top ordering), so dispatch
  // sees both 900 and 901 — and priority/number order admits the VICTIM into the single lane.
  const r3 = await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 4_000) });
  assert.deepEqual(r3.rollbacks, [{ kind: "recovered", issue: 900, target: "ready", reason: "env-failure-requeue" }]);
  assert.deepEqual(
    sup.dispatched.map((i) => i.number),
    [900],
  );
  st.close();
});

test("#168 Amendment 2: a FAILED llm ping's detail (first stderr line) is recorded in the park-probe event reason — an operator can tell 'provider down' from 'probeMaxBudgetUsd too low'", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 1, t0.toISOString());
  const r = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    now: () => new Date(t0.getTime() + 31_000),
    probeLlmReachable: async () => ({ ok: false, detail: "Error: Exceeded USD budget (0.01)" }),
  });
  void r;
  const probes = st.eventsSince("2020-01-01T00:00:00Z", ["park-probe"]);
  assert.equal(probes.length, 1);
  const payload = probes[0]?.payload as { success: boolean; reason?: string };
  assert.equal(payload.success, false);
  assert.equal(payload.reason, "Error: Exceeded USD budget (0.01)");
  assert.equal(st.parkRow("llm")?.probeAttempts, 1); // still a plain failed probe otherwise
  st.close();
});

test("#168 Amendment 2: a plain-boolean probe fake keeps working (no detail recorded), and a rich {ok:true} arms the canary exactly like `true`", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.ready = [{ number: 810, title: "", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 810, t0.toISOString());
  await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    now: () => new Date(t0.getTime() + 31_000),
    probeLlmReachable: async () => ({ ok: true }),
  });
  assert.equal(st.parkRow("llm")?.canaryWorker, "lane-1"); // canary armed off the rich shape
  const probes = st.eventsSince("2020-01-01T00:00:00Z", ["park-probe"]);
  // biome-ignore lint/correctness/noUnsafeOptionalChaining: this test requires the expected probe event payload.
  assert.equal((probes[0]?.payload as { reason?: string }).reason, undefined); // success carries no reason
  st.close();
});

test("#168 disabled-consumer rule: with no probeLlmReachable wired, tick() never touches the llm episode at all (no bump, no canary); duration escalation still fires regardless", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ envFailure: { parkEscalateAfterSec: 100 } });
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 55, t0.toISOString());

  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 60_000) });
  assert.equal(st.isParked(), true);
  assert.equal(st.parkRow("llm")?.probeAttempts, 0); // never probed — no consumer wired
  assert.equal(st.parkRow("llm")?.canaryWorker, null);

  // The duration escalation is NOT gated on the probe consumer existing.
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 101_000) });
  assert.notEqual(st.parkRow("llm")?.escalatedAt, null);
  assert.equal(st.isParked(), true); // still parked — escalation is additive
  st.close();
});

test("#168 P1-1 canary: a green ping does NOT clear the llm episode — it launches exactly ONE canary lane; the episode clears only when the canary reaches a non-env terminal", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.ready = [{ number: 800, title: "", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 800, t0.toISOString());
  let versionChecks = 0;
  const deps = {
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    probeLlmReachable: async () => {
      versionChecks++;
      return true;
    },
  };

  // Tick 1 (past base backoff): ping ok -> ONE canary dispatched; STILL PARKED.
  const r1 = await tick({ ...deps, now: () => new Date(t0.getTime() + 31_000) });
  assert.equal(versionChecks, 1);
  assert.deepEqual(
    sup.dispatched.map((i) => i.number),
    [800],
  );
  assert.equal(st.isParked(), true, "a green ping is NOT a recovery signal — still parked");
  assert.equal(st.parkRow("llm")?.canaryWorker, "lane-1");
  assert.equal(st.parkRow("llm")?.probeAttempts, 0); // arming a canary never grows the exponent
  assert.equal(r1.dispatched.filter((d) => d.kind === "dispatched").length, 1);

  // Tick 2 (canary still running): no second canary, no re-probe while one is in flight.
  sup.probes["lane-1"] = { ...DEFAULT_PROBE }; // KEEP
  await tick({ ...deps, now: () => new Date(t0.getTime() + 120_000) });
  assert.equal(versionChecks, 1);
  assert.equal(sup.dispatched.length, 1);

  // Canary succeeds (DONE, no PR would ordinarily escalate NOPR — irrelevant here; use a PR to
  // keep it clean): terminal NOT env-classified -> the llm episode clears.
  sup.probes["lane-1"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 90 };
  await tick({ ...deps, now: () => new Date(t0.getTime() + 130_000) });
  assert.equal(st.isParked(), false, "a real lane reaching a non-env terminal is the recovery signal");
  const resumed = st.eventsSince("2020-01-01T00:00:00Z", ["park-resumed"]);
  assert.equal(resumed.length, 1);
  // biome-ignore lint/correctness/noUnsafeOptionalChaining: this test requires the asserted event payload to exist.
  assert.equal((resumed[0]?.payload as { via: string }).via, "canary");
  st.close();
});

test("#168 P1-1 oscillation regression: provider stays down while the ping always succeeds -> exactly ONE canary per backoff step, SAME episode throughout (entered_at stable, attempts grow), duration escalation fires on wall-clock since FIRST entry", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.ready = [{ number: 900, title: "", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ envFailure: { probeBackoffBaseSec: 10, probeBackoffMaxSec: 100, parkEscalateAfterSec: 50 } });
  const t0 = new Date("2026-07-14T00:00:00Z");
  const deps = { forge, state: st, supervisor: sup, cfg, probeLlmReachable: async () => true };

  // t0: the initial failure parks the engine (llm), requeues #900 (forge healthy).
  seedRunning(st, "lane-w", 900);
  sup.probes["lane-w"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "rate_limit_error" };
  await tick({ ...deps, now: () => t0 });
  assert.equal(st.parkRow("llm")?.enteredAt, t0.toISOString());
  assert.deepEqual(sup.dispatched, []); // parked from this tick's own reclaim -> no dispatch

  // t0+5: backoff (10s) not yet elapsed -> NO canary, NO full dispatch. The old design cleared
  // park here (probe success) and re-dispatched the full queue — the oscillation.
  await tick({ ...deps, now: () => new Date(t0.getTime() + 5_000) });
  assert.deepEqual(sup.dispatched, []);
  assert.equal(st.isParked(), true);

  // t0+11: due -> canary #1 (exactly one lane).
  await tick({ ...deps, now: () => new Date(t0.getTime() + 11_000) });
  assert.equal(sup.dispatched.length, 1);
  assert.equal(st.parkRow("llm")?.canaryWorker, "lane-1");

  // Canary #1 env-fails (provider still down): SAME episode — attempts 1, entered_at UNCHANGED.
  sup.probes["lane-1"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "rate_limit_error" };
  await tick({ ...deps, now: () => new Date(t0.getTime() + 20_000) });
  assert.equal(st.parkRow("llm")?.enteredAt, t0.toISOString(), "entered_at never resets — no new episode");
  assert.equal(st.parkRow("llm")?.probeAttempts, 1);
  assert.equal(st.parkRow("llm")?.canaryWorker, null);
  assert.equal(sup.dispatched.length, 1); // no dispatch on the canary-failure tick

  // t0+25: backoff now 20s from the failure at t0+20 -> not due -> no canary.
  await tick({ ...deps, now: () => new Date(t0.getTime() + 25_000) });
  assert.equal(sup.dispatched.length, 1);

  // t0+41: due -> canary #2 (still exactly one per backoff step).
  await tick({ ...deps, now: () => new Date(t0.getTime() + 41_000) });
  assert.equal(sup.dispatched.length, 2);

  // Canary #2 env-fails too: attempts 2, same episode.
  sup.probes["lane-2"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "429 too many requests" };
  await tick({ ...deps, now: () => new Date(t0.getTime() + 45_000) });
  assert.equal(st.parkRow("llm")?.probeAttempts, 2);
  assert.equal(st.parkRow("llm")?.enteredAt, t0.toISOString());

  // t0+51: park DURATION since FIRST entry crosses 50s -> escalation fires (llm source, forge
  // healthy -> issue comment on the trigger issue) even though probes/canaries keep cycling.
  await tick({ ...deps, now: () => new Date(t0.getTime() + 51_000) });
  assert.notEqual(st.parkRow("llm")?.escalatedAt, null);
  assert.equal(forge.issueComments.length, 1);
  assert.equal(forge.issueComments[0]?.[0], 900);
  assert.equal(st.isParked(), true); // escalation is additive — still parked, still cycling
  assert.equal(sup.dispatched.length, 2); // and no extra canary snuck out (t0+51 < t0+45+40)
  st.close();
});

test("#168 P1-1a mixed storm end-to-end: llm episode + forge failure -> BOTH rows; resume requires BOTH healthy (forge probe first, then a clean canary)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.ready = [{ number: 950, title: "", labels: ["prio:3-feature"] }];
  let forgeUp = false;
  forge.listOpenIssueNumbers = async () => {
    if (!forgeUp) throw new Error("down");
    return [];
  };
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ envFailure: { probeBackoffBaseSec: 10, probeBackoffMaxSec: 10 } });
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 950, t0.toISOString());
  st.enterPark("forge", "could not resolve host", 950, t0.toISOString());
  const deps = { forge, state: st, supervisor: sup, cfg, probeLlmReachable: async () => true };

  // While the FORGE episode is open, a green ping must NOT arm a canary (it couldn't
  // even claim an issue) — both episodes persist, zero dispatch.
  await tick({ ...deps, now: () => new Date(t0.getTime() + 11_000) });
  assert.equal(st.parkedSources().length, 2);
  assert.deepEqual(sup.dispatched, []);

  // Forge recovers: its probe clears the forge episode — but the llm episode still blocks.
  forgeUp = true;
  await tick({ ...deps, now: () => new Date(t0.getTime() + 25_000) });
  assert.equal(st.parkRow("forge"), null);
  assert.equal(st.isParked(), true, "resume only at ZERO rows — llm episode still open");

  // Next due step: canary launches; it succeeds -> llm clears -> fully resumed.
  await tick({ ...deps, now: () => new Date(t0.getTime() + 40_000) });
  assert.equal(sup.dispatched.length, 1);
  const canary = st.parkRow("llm")?.canaryWorker;
  assert.ok(canary);
  sup.probes[canary!] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 91 };
  await tick({ ...deps, now: () => new Date(t0.getTime() + 55_000) });
  assert.equal(st.isParked(), false);
  st.close();
});

test("#168 P1-2 named regression: forge outage with EVERY forge write throwing for N>cap ticks -> zero needs-human, requeue row still present (frozen), resume drains it", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  let forgeUp = false;
  forge.throwOnAddLabel = true;
  forge.listOpenIssueNumbers = async () => {
    if (!forgeUp) throw new Error("down");
    return [];
  };
  forge.setBoardStatus = async (n, s) => {
    if (!forgeUp) throw new Error("board unreachable");
    forge.boardSet.push([n, s]);
  };
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ envFailure: { probeBackoffBaseSec: 1, probeBackoffMaxSec: 1 } }); // rollbackRetryCap default 5
  const t0 = new Date("2026-07-14T00:00:00Z");
  seedRunning(st, "lane-p12", 970);
  sup.probes["lane-p12"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "gh: Bad Gateway (HTTP 502)" };
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => t0 });
  assert.equal(st.parkRow("forge")?.source, "forge");

  // N = 8 > rollbackRetryCap (5) parked ticks: the env requeue is SUSPENDED — never attempted,
  // never bumped, never degraded to needs-human, never deleted.
  for (let s = 1; s <= 8; s++) {
    await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + s * 2000) });
  }
  assert.deepEqual(forge.labelsAdded, []); // zero needs-human across the whole outage
  const pending = st.pendingRollbacks().filter((p) => p.reason === "env-failure-requeue");
  assert.equal(pending.length, 1, "the requeue row survives the whole outage");
  assert.equal(pending[0]?.attempts, 0, "frozen — never attempted while suspended");

  // Forge recovers: the probe resumes the engine; the NEXT tick's ROLLBACK RETRY drains it.
  forgeUp = true;
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 20_000) });
  assert.equal(st.isParked(), false);
  const r = await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 22_000) });
  assert.deepEqual(r.rollbacks, [{ kind: "recovered", issue: 970, target: "ready", reason: "env-failure-requeue" }]);
  assert.deepEqual(forge.boardSet, [[970, "ready"]]);
  assert.equal(st.pendingRollbacks().length, 0);
  st.close();
});

test("#168 P1-2 cap exemption: an env-failure requeue that keeps failing while NOT forge-parked (llm park, transient board errors) is bumped past rollbackRetryCap — never needs-human, never deleted; recovers when the board heals", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.throwOnAddLabel = true;
  let boardUp = false;
  forge.setBoardStatus = async (n, s) => {
    if (!boardUp) throw new Error("board transiently failing");
    forge.boardSet.push([n, s]);
  };
  const sup = new FakeSupervisor();
  const cfg = mkCfg(); // recovery.rollbackRetryCap default 5
  seedRunning(st, "lane-cap", 980);
  sup.probes["lane-cap"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "rate_limit_error" };
  const t0 = new Date("2026-07-14T00:00:00Z");
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => t0 }); // llm park; inline requeue attempt fails
  assert.equal(st.parkRow("llm")?.source, "llm");
  assert.equal(st.pendingRollbacks()[0]?.attempts, 1);

  // 7 more ticks (attempts run well past the cap of 5) — llm-parked, so requeues ARE attempted.
  for (let s = 1; s <= 7; s++) {
    await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + s * 1000) });
  }
  const pending = st.pendingRollbacks();
  assert.equal(pending.length, 1, "never deleted at cap");
  assert.ok((pending[0]?.attempts ?? 0) > 5, "bumped past the cap, still retrying");
  assert.deepEqual(forge.labelsAdded, [], "never degraded to needs-human");

  boardUp = true;
  const r = await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 20_000) });
  assert.deepEqual(r.rollbacks, [{ kind: "recovered", issue: 980, target: "ready", reason: "env-failure-requeue" }]);
  st.close();
});

test("#168 escalation: DURATION-based, not probe-count — many rapid (backoff-capped) failed probes never trigger it early; crossing parkEscalateAfterSec does", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.listOpenIssueNumbers = async () => {
    throw new Error("still down");
  };
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ envFailure: { parkEscalateAfterSec: 100, probeBackoffBaseSec: 1, probeBackoffMaxSec: 1 } });
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("forge", "could not resolve host", 1, t0.toISOString());

  // Many probe ticks, 1s backoff each, well under the 100s duration threshold.
  for (let s = 1; s <= 50; s++) {
    await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + s * 1000) });
  }
  assert.ok((st.parkRow("forge")?.probeAttempts ?? 0) >= 40); // plenty of probe attempts happened
  assert.equal(st.parkRow("forge")?.escalatedAt, null); // duration not yet exceeded -> no escalation

  // Cross the duration threshold.
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 101_000) });
  assert.notEqual(st.parkRow("forge")?.escalatedAt, null);
  st.close();
});

test("#168 escalation is ADDITIVE: probing continues after escalation, and a later successful probe still auto-resumes normally", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  let forgeUp = false;
  forge.listOpenIssueNumbers = async () => {
    if (!forgeUp) throw new Error("down");
    return [];
  };
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ envFailure: { parkEscalateAfterSec: 10, probeBackoffBaseSec: 1, probeBackoffMaxSec: 1 } });
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("forge", "could not resolve host", 1, t0.toISOString());

  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 11_000) }); // escalates
  assert.notEqual(st.parkRow("forge")?.escalatedAt, null);

  forgeUp = true; // environment heals
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 13_000) });
  assert.equal(st.isParked(), false); // auto-resumes despite the earlier escalation
  const resumed = st.eventsSince("2020-01-01T00:00:00Z", ["park-resumed"]);
  assert.equal(resumed.length, 1);
  st.close();
});

test("#168 channel ladder: forge-sourced escalation is LOCAL only — zero forge writes, marker written; auto-resume then CLEARS the marker (P2-2 wired)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-park-escalate-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    let forgeUp = false;
    forge.listOpenIssueNumbers = async () => {
      if (!forgeUp) throw new Error("down");
      return [];
    };
    const sup = new FakeSupervisor();
    const cfg = mkCfg({ envFailure: { parkEscalateAfterSec: 10, probeBackoffBaseSec: 1, probeBackoffMaxSec: 1 } });
    const t0 = new Date("2026-07-14T00:00:00Z");
    st.enterPark("forge", "could not resolve host", 42, t0.toISOString());

    await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 11_000) });

    assert.notEqual(st.parkRow("forge")?.escalatedAt, null);
    // Zero forge writes on the local-fallback path — asserted directly, per the CTO directive.
    assert.deepEqual(forge.labelsAdded, []);
    assert.deepEqual(forge.issueComments, []);
    assert.deepEqual(forge.prComments, []);
    assert.deepEqual(forge.boardSet, []);
    const markerPath = st.escalationMarkerPath();
    assert.ok(markerPath && existsSync(markerPath));
    const marker = JSON.parse(readFileSync(markerPath!, "utf8"));
    assert.equal(marker.source, "forge");
    const events = st.eventsSince("2020-01-01T00:00:00Z", ["park-escalated"]);
    // biome-ignore lint/correctness/noUnsafeOptionalChaining: this test requires the expected escalation event payload.
    assert.equal((events[0]?.payload as { channel: string }).channel, "local");

    // P2-2: the forge heals -> auto-resume -> the stale marker is removed with it.
    forgeUp = true;
    await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 13_000) });
    assert.equal(st.isParked(), false);
    assert.equal(existsSync(markerPath!), false, "a resolved outage never leaves a stale ESCALATION file behind");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#168 channel ladder: llm-sourced escalation (forge healthy) goes via the forge (issue comment) channel, event records channel 'forge'", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ envFailure: { parkEscalateAfterSec: 10 } });
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 55, t0.toISOString());
  // No probeLlmReachable wired -> the episode never auto-probes (disabled-consumer) -> the
  // duration escalation still fires on wall-clock alone.

  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 11_000) });

  assert.notEqual(st.parkRow("llm")?.escalatedAt, null);
  assert.equal(forge.issueComments.length, 1);
  assert.equal(forge.issueComments[0]?.[0], 55);
  const events = st.eventsSince("2020-01-01T00:00:00Z", ["park-escalated"]);
  // biome-ignore lint/correctness/noUnsafeOptionalChaining: this test requires the expected escalation event payload.
  assert.equal((events[0]?.payload as { channel: string }).channel, "forge");
  st.close();
});

test("#168 channel ladder (P2-3): an llm-sourced escalation whose forge comment THROWS falls back to local — and the event records the channel ACTUALLY used ('local', not the intended 'forge')", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-park-escalate-fallback-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    forge.addIssueComment = async () => {
      throw new Error("forge unreachable after all");
    };
    const sup = new FakeSupervisor();
    const cfg = mkCfg({ envFailure: { parkEscalateAfterSec: 10 } });
    const t0 = new Date("2026-07-14T00:00:00Z");
    st.enterPark("llm", "rate_limit_error", 55, t0.toISOString());

    await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 11_000) });

    assert.notEqual(st.parkRow("llm")?.escalatedAt, null);
    const markerPath = st.escalationMarkerPath();
    assert.ok(markerPath && existsSync(markerPath));
    const events = st.eventsSince("2020-01-01T00:00:00Z", ["park-escalated"]);
    // biome-ignore lint/correctness/noUnsafeOptionalChaining: this test requires the expected escalation event payload.
    assert.equal((events[0]?.payload as { channel: string }).channel, "local", "the audit trail records the ACTUAL channel");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#168 channel ladder mixed storm: an llm escalation while a FORGE episode is ALSO open goes straight to local (never a doomed GitHub write)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-park-mixed-escalate-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    forge.listOpenIssueNumbers = async () => {
      throw new Error("down");
    };
    forge.addIssueComment = async () => {
      throw new Error("must never be called");
    };
    const sup = new FakeSupervisor();
    const cfg = mkCfg({ envFailure: { parkEscalateAfterSec: 10, probeBackoffBaseSec: 1000, probeBackoffMaxSec: 1000 } });
    const t0 = new Date("2026-07-14T00:00:00Z");
    st.enterPark("llm", "rate_limit_error", 55, t0.toISOString());
    st.enterPark("forge", "could not resolve host", 56, t0.toISOString());

    await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 11_000) });

    // BOTH episodes escalated (duration crossed), both via local — no comment attempt at all.
    assert.notEqual(st.parkRow("llm")?.escalatedAt, null);
    assert.notEqual(st.parkRow("forge")?.escalatedAt, null);
    assert.deepEqual(forge.issueComments, []);
    const events = st.eventsSince("2020-01-01T00:00:00Z", ["park-escalated"]);
    assert.equal(events.length, 2);
    assert.ok(events.every((e) => (e.payload as { channel: string }).channel === "local"));
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#168 restart-mid-park: a fresh State on the SAME db path still sees the episode (canary marker included) and blocks dispatch — resumes probing, never dispatching, purely from normal state loading", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-park-restart-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const st1 = new State(dbPath);
    st1.enterPark("forge", "could not resolve host", 1, "2026-07-14T00:00:00Z");
    st1.close();

    // A brand-new State instance (simulating an engine restart) reads the SAME row back.
    const st2 = new State(dbPath);
    assert.equal(st2.isParked(), true);
    assert.equal(st2.parkRow("forge")?.source, "forge");

    const forge = new FakeForge();
    forge.ready = [{ number: 9, title: "", labels: ["prio:3-feature"] }];
    forge.listOpenIssueNumbers = async () => {
      throw new Error("still down");
    }; // probe still fails
    const sup = new FakeSupervisor();
    const r = await tick({
      forge,
      state: st2,
      supervisor: sup,
      cfg: mkCfg(),
      now: () => new Date("2026-07-14T00:01:00Z"), // past base backoff -> probe due
    });
    assert.deepEqual(r.dispatched, []); // NOT dispatching
    assert.equal(st2.isParked(), true); // still probing (attempted, failed -> stays parked)
    assert.equal(st2.parkRow("forge")?.probeAttempts, 1);
    st2.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#168: pre-park pending rollbacks of OTHER reasons still drain normally while parked (only env-failure requeues are suspended, and only by a forge episode)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // A rollback pending from BEFORE this park episode (e.g. a dead-lane requeue from an earlier
  // tick) — must still be retried and recovered even while parked.
  st.addPendingRollback(88, "ready", "dead-lane-requeue", "2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 1, "2026-07-14T00:00:00Z");

  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), now: () => new Date("2026-07-14T00:00:05Z") });

  assert.deepEqual(r.rollbacks, [{ kind: "recovered", issue: 88, target: "ready", reason: "dead-lane-requeue" }]);
  assert.equal(st.pendingRollbacks().length, 0);
  st.close();
});

test("#168 forge-outage integration: park -> suspended requeue -> restore forge -> auto-resume (next tick) -> the requeue drains and the SAME issue re-dispatches", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  let forgeUp = false;
  forge.listOpenIssueNumbers = async () => {
    if (!forgeUp) throw new Error("down");
    return [];
  };
  // Board-status-driven Ready (P2-B: never statically pre-seed the victim — it only becomes
  // dispatchable once its board rollback actually executes).
  forge.ready = [];
  forge.setBoardStatus = async (n, s) => {
    if (!forgeUp) throw new Error("down");
    forge.boardSet.push([n, s]);
    if (s === "ready" && !forge.ready.some((i) => i.number === n)) {
      forge.ready.push({ number: n, title: "", labels: ["prio:3-feature"] });
    }
  };
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ envFailure: { probeBackoffBaseSec: 1, probeBackoffMaxSec: 1 } });
  const t0 = new Date("2026-07-14T00:00:00Z");
  seedRunning(st, "lane-f", 900);
  sup.probes["lane-f"] = { ...DEFAULT_PROBE, failed: true, hasPr: false, failureText: "Could not resolve host: github.com" };

  // Tick 1: the forge-outage failure parks the engine; the requeue is suspended (durable).
  const r1 = await tick({ forge, state: st, supervisor: sup, cfg, now: () => t0 });
  assert.equal(r1.reclaimed[0]?.kind, "env-failure");
  assert.equal(st.isParked(), true);
  assert.deepEqual(r1.dispatched, []);
  assert.equal(st.pendingRollbacks().length, 1);

  // Tick 2: still down -> stays parked, no dispatch, requeue still suspended.
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 2_000) });
  assert.equal(st.isParked(), true);
  assert.deepEqual(r2.dispatched, []);
  assert.equal(st.pendingRollbacks()[0]?.attempts, 0);

  // Tick 3 (recovery): probe succeeds -> episode clears; dispatch DEFERRED to next tick (P2-B).
  forgeUp = true;
  const r3 = await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 4_000) });
  assert.equal(st.isParked(), false);
  assert.deepEqual(r3.dispatched, []);

  // Tick 4: ROLLBACK RETRY drains the requeue first (victim lands in Ready), then dispatch
  // re-admits the SAME issue — the full round trip.
  const r4 = await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 6_000) });
  assert.deepEqual(r4.rollbacks, [{ kind: "recovered", issue: 900, target: "ready", reason: "env-failure-requeue" }]);
  assert.deepEqual(
    r4.dispatched.map((d) => (d.kind === "dispatched" ? d.issue : null)),
    [900],
  );
  st.close();
});

// ── #168 round 3: canary × safety-layer interactions (P1-A / P1-B) ──────────────────────────

test("#168 P1-A: llm-parked + hard ceiling breached -> ZERO paid ping spawns (the free forge probe keeps running); episode untouched", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  let forgeProbes = 0;
  forge.listOpenIssueNumbers = async () => {
    forgeProbes++;
    throw new Error("down");
  };
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 1, t0.toISOString());
  st.enterPark("forge", "could not resolve host", 2, t0.toISOString());
  // Breach the daily USD ceiling (default cap 100).
  st.recordSpend("old-lane", 1, 200, t0.toISOString());
  let pings = 0;
  await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    now: () => new Date(t0.getTime() + 31_000), // both probes would be due
    probeLlmReachable: async () => {
      pings++;
      return true;
    },
  });
  assert.equal(pings, 0, "a hard cost-ceiling breach must never itself keep spending on pings");
  assert.equal(forgeProbes, 1, "the FREE forge read-probe keeps running under a breach");
  assert.equal(st.parkRow("llm")?.probeAttempts, 0); // untouched, not a synthetic failure
  st.close();
});

test("#168 P1-A: llm-parked + PAUSED -> zero llm pings (pause blocks the canary the ping would unlock — disabled-consumer), forge probes still run", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  let forgeProbes = 0;
  forge.listOpenIssueNumbers = async () => {
    forgeProbes++;
    throw new Error("down");
  };
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 1, t0.toISOString());
  st.enterPark("forge", "could not resolve host", 2, t0.toISOString());
  let pings = 0;
  await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    now: () => new Date(t0.getTime() + 31_000),
    forceDispatchPause: true, // the same `paused` flag the data/PAUSE sentinel drives
    probeLlmReachable: async () => {
      pings++;
      return true;
    },
  });
  assert.equal(pings, 0, "a green ping under pause is pure spend with no consumer");
  assert.equal(forgeProbes, 1);
  assert.equal(st.isParked(), true);
  st.close();
});

test("#168 P1-B: a GRACEFUL drain hitting a live canary is INCONCLUSIVE — slot released, episode intact; the drain-caused .handoff later reclaims WITHOUT falsely clearing the episode", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 900, t0.toISOString());
  seedRunning(st, "lane-c", 900);
  st.setParkCanary("llm", "lane-c");
  sup.probes["lane-c"] = { ...DEFAULT_PROBE }; // live canary (KEEP)
  st.recordSpend("old-lane", 1, 200, t0.toISOString()); // hard ceiling breach -> graceful drain

  const r1 = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), now: () => new Date(t0.getTime() + 1_000) });
  assert.ok(r1.drainRequested.includes("lane-c"));
  let llm = st.parkRow("llm");
  assert.ok(llm, "episode preserved");
  assert.equal(llm?.canaryWorker, null, "slot released — inconclusive");
  assert.equal(llm?.enteredAt, t0.toISOString(), "entered_at untouched");
  assert.equal(llm?.probeAttempts, 0, "a drain is not a probe result — no attempts bump");
  const inconclusive = st.eventsSince("2020-01-01T00:00:00Z", ["park-canary-inconclusive"]);
  assert.equal(inconclusive.length, 1);

  // The drained canary eventually writes .handoff; its reclaim must NOT read as canary success.
  sup.probes["lane-c"] = { ...DEFAULT_PROBE, handoff: true };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), now: () => new Date(t0.getTime() + 2_000) });
  llm = st.parkRow("llm");
  assert.ok(llm, "a drain-caused handoff is ZERO recovery evidence — episode still open");
  assert.equal(st.getWorker("lane-c")?.state, "handoff");
  assert.equal(st.eventsSince("2020-01-01T00:00:00Z", ["park-resumed"]).length, 0);
  st.close();
});

test("#168 P1-B: a HARD drain killing the canary releases the slot (no permanent wedge) — post-recovery the episode probes/advances again", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // Focus on the wedge, not escalation: push the escalation threshold out of the way.
  const cfg = mkCfg({ envFailure: { parkEscalateAfterSec: 999_999 } });
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 910, t0.toISOString());
  seedRunning(st, "lane-h", 910);
  st.setParkCanary("llm", "lane-h");
  sup.probes["lane-h"] = { ...DEFAULT_PROBE };
  st.recordSpend("old-lane", 1, 200, t0.toISOString()); // ceiling breach at tick 1

  // Tick 1: breach first detected -> drain requested, canary released inconclusive.
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => t0 });
  assert.equal(st.parkRow("llm")?.canaryWorker, null);

  // Tick 2, past drainWindowSec (default 300s): HARD kill — lane-h upserted `failed` directly
  // by drainThenEscalate, never via reclaimTerminalLane/settleCanary.
  const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 301_000) });
  assert.ok(r2.escalated.includes("lane-h"));
  assert.equal(st.getWorker("lane-h")?.state, "failed");
  const llm = st.parkRow("llm");
  assert.ok(llm, "episode preserved through the hard drain");
  assert.equal(llm?.canaryWorker, null, "no dangling canary slot — the wedge this fix closes");
  assert.equal(llm?.enteredAt, t0.toISOString());

  // Ceiling heals (fresh UTC day -> daily sum resets) -> the episode can still probe: no wedge.
  let pings = 0;
  await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg,
    now: () => new Date("2026-07-15T00:10:00Z"),
    probeLlmReachable: async () => {
      pings++;
      return false;
    },
  });
  assert.equal(pings, 1, "the episode probes again after recovery — never permanently wedged");
  assert.equal(st.parkRow("llm")?.probeAttempts, 1);
  st.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// #245: fixing lane state + fix-leg resume. FIXABLE-gate wiring (deriving "fixing" from a live
// review verdict) is sibling issue #246 — these tests exercise the machinery #246 will call:
// startFixLeg (the fix-leg-resume shape + fix_rounds counter) and the FIXING RECLAIM phase
// (lane occupancy + supervision + the fixing->driving pin-clear edge), by seeding a `fixing`
// row directly rather than driving one through a real FIXABLE gate decision.
// ─────────────────────────────────────────────────────────────────────────────

const seedDriving = (st: State, name: string, issue: number, pr: number, over: Partial<WorkerRow> = {}) =>
  st.upsertWorker({ name, issue, session_id: `s-${name}`, state: "driving", started_at: "t", ended_at: "t2", pr, ...over });

const seedFixing = (st: State, name: string, issue: number, pr: number, over: Partial<WorkerRow> = {}) =>
  st.upsertWorker({ name, issue, session_id: `s-${name}`, state: "fixing", started_at: "t", ended_at: null, pr, ...over });

// #245 round-2 fix A6: startFixLeg now REQUIRES a credentialFree proxy — every test call below
// supplies this fixture rather than omitting the (now-mandatory) 3rd argument.
const fixProxy = { mint: async () => ({}) as never, credentialFree: true };

test("startFixLeg: transitions driving -> fixing, bumps fix_rounds, resumes the SAME lane (never a fresh dispatch — squash-branch-reuse hazard)", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-9", 9, 90);
  const row = st.getWorker("lane-9")!;
  const renderFixPrompt = (issueNumber: number, pr: number) => `fix #${issueNumber} pr #${pr}`;

  const result = await startFixLeg({ state: st, supervisor: sup, renderFixPrompt }, row, fixProxy);

  assert.equal(result.name, "lane-9");
  const updated = st.getWorker("lane-9")!;
  assert.equal(updated.state, "fixing");
  assert.equal(updated.fix_rounds, 1);
  assert.equal(updated.pr, 90, "same PR — never a new one");
  assert.deepEqual(sup.dispatched, [], "startFixLeg must NEVER dispatch a fresh lane");
  assert.equal(sup.resumeCalls.length, 1);
  assert.equal(sup.resumeCalls[0]!.worker, "lane-9");
  assert.equal(sup.resumeCalls[0]!.issue.number, 9);
  assert.equal(sup.resumeCalls[0]!.opts?.prompt, "fix #9 pr #90");
  assert.equal(
    sup.resumeCalls[0]!.opts?.sessionId,
    "s-lane-9",
    "A1: fix-leg ENTRY passes the row's own session id — no .handoff sentinel exists to read one off",
  );
  st.close();
});

test("startFixLeg: fix_rounds is independent of resume_attempts — starting a fix leg never touches resume_attempts, and a pre-existing resume_attempts value survives untouched", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-9", 9, 90, { resume_attempts: 5 });
  const row = st.getWorker("lane-9")!;
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, row, fixProxy);
  const updated = st.getWorker("lane-9")!;
  assert.equal(updated.fix_rounds, 1);
  assert.equal(updated.resume_attempts, 5, "resume_attempts must never be disturbed by a fix leg starting");
  st.close();
});

test("startFixLeg: a second fix leg on the same row bumps fix_rounds to 2 (rework rounds accumulate)", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-9", 9, 90);
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, fixProxy);
  // Simulate the fixing leg completing and landing back in driving (FIXING RECLAIM's own job,
  // tested separately below) before a second fix round starts.
  st.upsertWorker({ ...st.getWorker("lane-9")!, state: "driving" });
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, fixProxy);
  assert.equal(st.getWorker("lane-9")?.fix_rounds, 2);
  st.close();
});

test("startFixLeg: a thrown resume() leaves the row untouched — driving, fix_rounds NOT bumped (a transient spawn failure costs zero fix-round budget)", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  sup.resumeShouldThrow = "mint failed";
  seedDriving(st, "lane-9", 9, 90);
  await assert.rejects(() => startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, fixProxy));
  const row = st.getWorker("lane-9")!;
  assert.equal(row.state, "driving", "still driving — never transitioned on a failed resume");
  assert.equal(row.fix_rounds ?? 0, 0, "fix_rounds must not be spent on a spawn that never happened");
  st.close();
});

test("startFixLeg: refuses (throws) when the row has no PR — a driving lane must always carry one; fail-safe, not a silent no-op", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  st.upsertWorker({ name: "lane-9", issue: 9, session_id: "s", state: "driving", started_at: "t", ended_at: "t2" }); // no pr
  await assert.rejects(
    () => startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, fixProxy),
    /no PR/i,
  );
  assert.deepEqual(sup.resumeCalls, []);
  st.close();
});

test("startFixLeg: forwards a proxy opt straight through to resume() (the fix leg's evidence channel)", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-9", 9, 90);
  const proxy = { mint: async () => ({}) as never, credentialFree: true };
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, proxy);
  assert.equal(sup.resumeCalls[0]!.opts?.proxy, proxy);
  st.close();
});

test("startFixLeg: refuses (throws) when proxy.credentialFree is NOT true — a fix leg must never run with ambient forge credentials (A6)", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-9", 9, 90);
  await assert.rejects(
    () =>
      startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, { mint: async () => ({}) as never }),
    /credentialFree must be true/i,
  );
  assert.deepEqual(sup.resumeCalls, [], "resume() must never be called without a valid credentialFree proxy");
  assert.equal(st.getWorker("lane-9")?.state, "driving", "row untouched — never transitioned without a valid proxy");
  st.close();
});

test("tick FIXING RECLAIM: activeWorkers/lane-occupancy — a `fixing` lane counts against cfg.lanes.max exactly like driving/running (capacity test)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fixing", 2, 20);
  sup.probes["lane-fixing"] = { ...DEFAULT_PROBE }; // still running (KEEP) this tick
  forge.ready = [{ number: 9, title: "", labels: ["prio:3-feature"] }];
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 5 } }) });
  assert.deepEqual(sup.dispatched, [], "the fixing lane keeps capacity full -> #9 not launched");
  assert.ok(r.dispatched.some((d) => d.kind === "skipped" && d.issue === 9 && d.reason === "no-lane"));
  assert.equal(st.getWorker("lane-fixing")?.state, "fixing", "unchanged — still occupying the lane");
  st.close();
});

test("tick FIXING RECLAIM: a fixing lane reaching DONE+PR (pushed a fix) lands back in `driving` with the review-trigger pin CLEARED (re-triggers a fresh review, #147-style)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fix", 3, 30, { review_triggered_head: "OLD_HEAD", review_triggered_at: "2026-07-01T00:00:00Z" });
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 30 };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "driving");
  assert.equal(row.pr, 30);
  assert.equal(row.review_triggered_head, null, "pin cleared — DRIVE must treat this head as never-triggered");
  assert.equal(row.review_triggered_at, null);
  assert.equal(r.fixingReclaimed.length, 1);
  assert.equal(r.fixingReclaimed[0]!.kind, "done");
  st.close();
});

test("tick FIXING RECLAIM + DRIVE, same tick: once a fixing lane lands back in driving with a cleared pin, the SAME tick's DRIVE loop re-triggers a fresh review on the new head (findings -> fixing leg spawned -> push -> driving with cleared pin -> fresh trigger posted)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // Start driving, spawn a fix leg (the seam #246 will call), then simulate the fix leg pushing
  // and completing — all inside one fabricated flow, then let tick() reclaim + drive it.
  seedDriving(st, "lane-fix", 3, 30, { review_triggered_head: "OLD_HEAD", review_triggered_at: "2026-07-01T00:00:00Z" });
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "fix it" }, st.getWorker("lane-fix")!, fixProxy);
  assert.equal(st.getWorker("lane-fix")?.state, "fixing");

  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 30 };
  const gate = new FakeMergeGate();
  gate.outcomes[30] = { kind: "queued", pr: 30, reason: "gate-pending:WAIT_REVIEW" };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

  assert.equal(st.getWorker("lane-fix")?.state, "driving");
  assert.equal(st.getWorker("lane-fix")?.fix_rounds, 1);
  // DRIVE loop saw the cleared pin (head: null) and drove this lane THIS SAME TICK.
  assert.equal(gate.calls.length, 1);
  assert.equal(gate.calls[0]!.triggerPin.head, null);
  assert.ok(r.driven.some((d) => d.kind === "queued" && d.pr === 30));
  st.close();
});

test("tick FIXING RECLAIM: DEAD (crashed, no sentinel) fixing lane with a clean worktree + PR is rescued straight back to driving with the pin cleared — same #69 has-PR rescue policy as an ordinary running lane", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fix", 4, 40, { review_triggered_head: "OLD_HEAD", review_triggered_at: "2026-07-01T00:00:00Z" });
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0, hasPr: true, prNumber: 40 };
  sup.reclaimResults["lane-fix"] = { worktreePath: "/abs/worktrees/lane-fix", worktreeRetained: false };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "driving");
  assert.equal(row.review_triggered_head, null);
  assert.deepEqual(sup.reclaimed, ["lane-fix"]);
  assert.equal(r.fixingReclaimed[0]!.kind, "dead");
  st.close();
});

test("tick FIXING RECLAIM: DEAD fixing lane with a DIRTY (retained) worktree escalates to failed+needs-human — never auto-rescued with possibly-uncommitted WIP", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fix", 4, 40);
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0, hasPr: true, prNumber: 40 };
  sup.reclaimResults["lane-fix"] = { worktreePath: "/abs/worktrees/lane-fix", worktreeRetained: true };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.getWorker("lane-fix")?.state, "failed");
  assert.deepEqual(forge.labelsAdded, [[4, "needs-human"]]);
  assert.deepEqual(forge.prLabelsAdded, [[40, "needs-human"]]);
  st.close();
});

test("tick FIXING RECLAIM: a still-running (KEEP) fixing lane refreshes live telemetry and stays fixing — heartbeat/timeout/soft-budget supervision applies exactly like a running lane", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fix", 5, 50);
  sup.probes["lane-fix"] = {
    ...DEFAULT_PROBE,
    liveTelemetry: {
      estCostUsd: 1.5,
      contextTokens: 100,
      tokenComposition: { inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 },
    },
  };
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "fixing");
  assert.equal(row.est_cost_usd, 1.5);
  st.close();
});

test("tick DRIVE: #170 review-silence escalation is provably NOT armed during `fixing` — a fixing lane with a very stale review-trigger pin is invisible to drivingWorkers()/the DRIVE loop entirely (that clock only ever fires from inside DRIVE)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const longAgo = "2020-01-01T00:00:00Z"; // far past any escalateAfterSec threshold
  seedFixing(st, "lane-fix", 6, 60, { review_triggered_head: "H", review_triggered_at: longAgo });
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE }; // still running (KEEP) — never reaches DRIVE
  const gate = new FakeMergeGate();
  gate.outcomes[60] = {
    kind: "queued",
    pr: 60,
    reason: "gate-pending:WAIT_REVIEW",
    reviewSilenceEscalation: { head: "H", silenceSec: 999_999_999 },
  };
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(gate.calls.length, 0, "driveOne must never be called for a fixing-state lane");
  assert.deepEqual(forge.prLabelsAdded, [], "no review-silence needs-human label — the escalation path never ran");
  assert.deepEqual(r.driven, []);
  assert.equal(st.getWorker("lane-fix")?.state, "fixing");
  st.close();
});

test("tick kill-switch: a `fixing` lane is drained (SIGTERM) exactly like a `running` lane — never left spinning because the engine considers itself killed", async () => {
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const dir = mkdtempSync(join(tmpdir(), "sapwood-conductor-"));
  try {
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    // Real data dir (not :memory:) so isKillSwitchActive() sees the sentinel file.
    const st = new State(join(dir, "sapwood.sqlite"));
    seedFixing(st, "lane-fix", 7, 70);
    sup.probes["lane-fix"] = { ...DEFAULT_PROBE };
    const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.ok(r.ceilingBreached);
    assert.deepEqual(r.ceilingReasons, ["kill-switch"]);
    assert.ok(r.drainRequested.includes("lane-fix"), "a fixing lane must be drained during a kill-switch tick");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #245 round-2 fix (Codex sol-high review, PR #263): A2 — a `fixing` lane that hands off
// (soft budget) must resume as a FIX continuation, never an ordinary leg. A3 — a crash between
// resume()'s own confirmed spawn and startFixLeg's row-transition upsert must never leave a
// live fix child invisible to the kill-switch drain. A5 — the fixing->driving pin-clear is
// commit-atomic with the state write (proven via settleTerminalWorker's existing all-or-nothing
// transaction, same #223 pattern this file already tests for other fields).
// ─────────────────────────────────────────────────────────────────────────────

const seedFixingHandoff = (st: State, name: string, issue: number, pr: number | null, over: Partial<WorkerRow> = {}) =>
  st.upsertWorker({
    name,
    issue,
    session_id: `s-${name}`,
    state: "handoff",
    started_at: "t",
    ended_at: "t2",
    pr: pr ?? undefined,
    fixing_handoff: 1,
    ...over,
  });

test("tick RESUME (A2): a fixing-origin handoff (fixing_handoff=1) resumes as a FIX continuation — fix prompt + mandatory credentialFree proxy + target state `fixing`, bumping only resume_attempts, never fix_rounds", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixingHandoff(st, "lane-fix", 5, 50, { fix_rounds: 1 });
  const mintProxy = async () => ({}) as never;
  const renderFixPrompt = (issueNumber: number, pr: number) => `fix #${issueNumber} pr #${pr}`;
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), fixLegResume: { renderFixPrompt, mintProxy } });

  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "fixing", "resumes back into `fixing`, never `running`");
  assert.equal(row.fixing_handoff, 0, "cleared once the fix continuation lands");
  assert.equal(row.resume_attempts, 1, "resume_attempts bumped — this IS a continuation leg");
  assert.equal(row.fix_rounds, 1, "fix_rounds UNTOUCHED — a continuation is not a new rework round");
  assert.equal(sup.resumeCalls[0]!.opts?.prompt, "fix #5 pr #50");
  const proxy = sup.resumeCalls[0]!.opts?.proxy as { credentialFree?: boolean } | undefined;
  assert.equal(proxy?.credentialFree, true, "A2: the restored continuation must be credentialFree — never ambient credentials");
  assert.ok(r.resumed.some((o) => o.kind === "resumed" && o.worker === "lane-fix"));
  st.close();
});

test("tick RESUME (A2): a fixing-origin handoff with NO fixLegResume dep configured is left untouched (fail-closed) — never silently resumed as an ordinary leg", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixingHandoff(st, "lane-fix", 5, 50);
  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }); // no fixLegResume

  assert.deepEqual(sup.resumeCalls, [], "resume() must never be called for a fix-leg-origin handoff without the dep wired");
  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "handoff", "left exactly as it was — retried next tick once configured");
  assert.equal(row.fixing_handoff, 1);
  const events = st.eventsSince("1970-01-01T00:00:00Z", ["fix-leg-resume-unconfigured"]);
  assert.equal(events.length, 1);
  assert.deepEqual(r.resumed, []);
  st.close();
});

test("tick RESUME (A2): a fixing-origin handoff with no PR escalates (fail-safe) rather than guessing or silently dropping the fix attempt", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixingHandoff(st, "lane-fix", 5, null);
  await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });

  assert.deepEqual(sup.resumeCalls, []);
  assert.equal(
    st.getWorker("lane-fix")?.state,
    "handoff",
    "not transitioned — escalated via label, not state, since it's already terminal-handoff shaped",
  );
  assert.deepEqual(forge.labelsAdded, [[5, "needs-human"]]);
  const events = st.eventsSince("1970-01-01T00:00:00Z", ["fix-leg-resume-no-pr"]);
  assert.equal(events.length, 1);
  st.close();
});

test("tick (A3): a driving row with a CONFIRMED resume intent (crash between resume()'s confirm and startFixLeg's own upsert) is reconciled to `fixing`, fix_rounds bumped exactly once, and a graceful handoff is requested (never trusts a dead-proxy-adopted child long-term)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-fix", 6, 60, { fix_rounds: 0 });
  sup.resumeIntents["lane-fix"] = "confirmed";
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE }; // still running (KEEP) — nothing else this tick

  const r = await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "fixing", "reconciled — the DB now matches the live confirmed-spawn reality");
  assert.equal(row.fix_rounds, 1, "the FIRST and ONLY bump for this round (startFixLeg's own bump never landed before the crash)");
  assert.ok(sup.handoffRequested.includes("lane-fix"), "never trust the adopted child's proxy channel — drain it gracefully instead");
  assert.ok(
    sup.clearedFixEntrySentinels.includes("lane-fix"),
    "B1: consumes any stale prior-leg done/failed sentinel resume() itself may not have removed before the crash",
  );
  const events = st.eventsSince("1970-01-01T00:00:00Z", ["fix-leg-adopted"]);
  assert.equal(events.length, 1);
  // Reconciliation ran BEFORE FIXING RECLAIM even had a chance to probe it this same tick — no
  // duplicate/second bump from a later phase seeing the now-`fixing` row.
  assert.equal(r.fixingReclaimed.length <= 1, true);
  st.close();
});

test("tick (A3): a driving row with an UNCONFIRMED resume intent escalates to needs-human — ambiguous crash state, never silently retried (would risk a duplicate spawn)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-fix", 6, 60);
  sup.resumeIntents["lane-fix"] = "unconfirmed";

  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "failed");
  assert.equal(row.pr, 60, "failed+PR — the gated-reentry shape, so a human can still reclaim it later");
  assert.deepEqual(forge.labelsAdded, [[6, "needs-human"]]);
  const events = st.eventsSince("1970-01-01T00:00:00Z", ["fix-leg-undecidable"]);
  assert.equal(events.length, 1);
  st.close();
});

test("tick (A3): a driving row with NO resume intent ('none') is left completely untouched — the ordinary, healthy case", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-fix", 6, 60);
  // sup.resumeIntents defaults every unlisted lane to "none".
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "driving");
  assert.equal(row.fix_rounds ?? 0, 0);
  st.close();
});

test("tick (A3): reconciliation runs BEFORE the kill-switch gate — a confirmed driving-row fix intent is drained in the SAME kill-switch tick it's reconciled in", async () => {
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const dir = mkdtempSync(join(tmpdir(), "sapwood-conductor-"));
  try {
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const st = new State(join(dir, "sapwood.sqlite"));
    seedDriving(st, "lane-fix", 6, 60);
    sup.resumeIntents["lane-fix"] = "confirmed";
    sup.probes["lane-fix"] = { ...DEFAULT_PROBE };
    await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.equal(st.getWorker("lane-fix")?.state, "fixing", "reconciled to fixing before the kill-switch gate ran");
    // reconciliation's OWN requestHandoff call (not drainThenEscalate's — that call is a no-op
    // here since requestHandoff is idempotent and reconciliation already asked first) is what
    // drains it — the raw fact of "a handoff was requested this tick" proves it was never left
    // spinning invisibly, regardless of which phase's call actually returned true.
    assert.ok(sup.handoffRequested.includes("lane-fix"), "drained THIS SAME tick — never invisible to the kill switch");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick (A5): the fixing->driving pin-clear is commit-ATOMIC with the state write — a failure inside settleTerminalWorker's transaction rolls back BOTH (never a stale pin surviving with a committed `driving` state)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fix", 3, 30, { review_triggered_head: "OLD_HEAD", review_triggered_at: "2026-07-01T00:00:00Z" });
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 30 };
  // Force recordSpend (the SAME transaction settleTerminalWorker wraps the state write in) to
  // throw — proving the pin-clear + state write can only ever land together, never split.
  st.recordSpend = () => {
    throw new Error("simulated ledger failure");
  };
  await assert.rejects(() => tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }), /simulated ledger failure/);
  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "fixing", "the whole transaction rolled back — state write did NOT land without its paired pin-clear");
  assert.equal(
    row.review_triggered_head,
    "OLD_HEAD",
    "pin untouched — proves it was never written independently of the (rolled-back) state transition",
  );
  st.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// #245 round-2 fix ROUND 2 (Codex sol-high delta re-review): B2 — both resume-adoption paths
// must preserve fix identity and never trust a cross-crash proxy. B3 — reconcileDrivingFixIntents'
// own confirmed-branch ordering must be crash-safe (requestHandoff before the upsert). B4 — an
// unconfirmed-intent escalation must never terminalize on a failed label write.
// ─────────────────────────────────────────────────────────────────────────────

test("tick RESUME (B2a): a fixing-continuation resume() that resolves to ADOPT (a live child already exists from a pre-crash attempt) drains it immediately instead of blessing it — no fresh proxy/prompt passed, fixing_handoff stays 1", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixingHandoff(st, "lane-fix", 5, 50, { fix_rounds: 1 });
  sup.resumeIntents["lane-fix"] = "confirmed"; // -> resumeDecision always yields ADOPT
  const r = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    fixLegResume: { renderFixPrompt: () => "should never be used", mintProxy: async () => ({}) as never },
  });

  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "fixing", "adopted into fixing so it's visible to FIXING RECLAIM");
  assert.equal(row.fixing_handoff, 1, "B2a: stays 1 — the NEXT resume must re-mint a genuinely fresh proxy, this adoption never did");
  assert.equal(row.fix_rounds, 1, "still just a continuation — no new rework round");
  assert.equal(row.resume_attempts, 1);
  assert.equal(sup.resumeCalls[0]!.opts, undefined, "B2a: ADOPT never attempts a fresh mint — no proxy/prompt opts passed at all");
  assert.ok(sup.handoffRequested.includes("lane-fix"), "B2a: drained immediately rather than trusted");
  const events = st.eventsSince("1970-01-01T00:00:00Z", ["fix-leg-adopted-drained"]);
  assert.equal(events.length, 1);
  assert.ok(r.resumed.some((o) => o.kind === "resumed" && o.worker === "lane-fix"));
  st.close();
});

test("tick RESUME (B5): the B2a ADOPT branch calls requestHandoff BEFORE the upsert — a crash between them (simulated: upsertWorker throws once) never loses the drain request, and the retry never double-counts resume_attempts", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixingHandoff(st, "lane-fix", 5, 50, { fix_rounds: 1 });
  sup.resumeIntents["lane-fix"] = "confirmed"; // -> resumeDecision always yields ADOPT

  const originalUpsert = st.upsertWorker.bind(st);
  let crashed = false;
  st.upsertWorker = (row) => {
    if (!crashed && row.name === "lane-fix" && row.state === "fixing") {
      crashed = true;
      throw new Error("simulated crash between requestHandoff and the upsert");
    }
    originalUpsert(row);
  };

  await assert.rejects(() =>
    tick({
      forge,
      state: st,
      supervisor: sup,
      cfg: mkCfg(),
      fixLegResume: { renderFixPrompt: () => "unused", mintProxy: async () => ({}) as never },
    }),
  );
  assert.ok(crashed, "sanity: the simulated crash actually fired");
  assert.ok(sup.handoffRequested.includes("lane-fix"), "B5: requestHandoff is durable/idempotent and fired BEFORE the crashed upsert");
  const midCrash = st.getWorker("lane-fix")!;
  assert.equal(midCrash.state, "handoff", "still handoff — the crashed upsert never landed");
  assert.equal(midCrash.fixing_handoff, 1, "unchanged — still the same confirmed-intent shape for the next tick to re-enter");
  assert.equal(midCrash.resume_attempts ?? 0, 0, "resume_attempts NOT bumped by the crashed attempt");

  // Retry: the row is STILL a fixing-origin handoff with the SAME confirmed intent, so the next
  // tick's RESUME phase re-enters this exact ADOPT branch from scratch.
  st.upsertWorker = originalUpsert;
  await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    fixLegResume: { renderFixPrompt: () => "unused", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "fixing");
  assert.equal(row.resume_attempts, 1, "exactly ONE bump total across both attempts — never double-counted");
  st.close();
});

test("tick kill-switch (B2b): a fixing-origin handoff (fixing_handoff=1) adopted via a confirmed resume intent lands back in `fixing`, never `running` — fix identity preserved through the kill-switch adoption path", async () => {
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const dir = mkdtempSync(join(tmpdir(), "sapwood-conductor-"));
  try {
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const st = new State(join(dir, "sapwood.sqlite"));
    seedFixingHandoff(st, "lane-fix", 5, 50);
    sup.resumeIntents["lane-fix"] = "confirmed";
    sup.probes["lane-fix"] = { ...DEFAULT_PROBE };
    await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

    const row = st.getWorker("lane-fix")!;
    assert.equal(row.state, "fixing", "B2b: must NOT be written as `running` — that would silently discard its fix identity");
    assert.equal(row.fixing_handoff, 1, "unchanged — the kill-switch adoption path never clears it (this isn't a real fix continuation)");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick (B3): reconcileDrivingFixIntents' confirmed branch calls requestHandoff BEFORE the upsert — a crash between them (simulated: upsertWorker throws once) never loses the drain request, and the retry never double-counts fix_rounds", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-fix", 6, 60, { fix_rounds: 0 });
  sup.resumeIntents["lane-fix"] = "confirmed";
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE };

  const originalUpsert = st.upsertWorker.bind(st);
  let crashed = false;
  st.upsertWorker = (row) => {
    if (!crashed && row.name === "lane-fix" && row.state === "fixing") {
      crashed = true;
      throw new Error("simulated crash between requestHandoff and the upsert");
    }
    originalUpsert(row);
  };

  await assert.rejects(() => tick({ forge, state: st, supervisor: sup, cfg: mkCfg() }));
  assert.ok(crashed, "sanity: the simulated crash actually fired");
  assert.ok(sup.handoffRequested.includes("lane-fix"), "requestHandoff is durable/idempotent and fired BEFORE the crashed upsert");
  assert.equal(st.getWorker("lane-fix")?.state, "driving", "still driving — the crashed upsert never landed");
  assert.equal(st.getWorker("lane-fix")?.fix_rounds ?? 0, 0, "fix_rounds NOT bumped by the crashed attempt");

  // Retry: the row is STILL driving with the SAME confirmed intent, so the next tick's
  // reconciliation re-enters this exact branch from scratch.
  st.upsertWorker = originalUpsert;
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "fixing");
  assert.equal(row.fix_rounds, 1, "exactly ONE bump total across both attempts — never double-counted");
  st.close();
});

test("tick (B4): unconfirmed-intent escalation with a FAILING label write does NOT terminalize the row — stays driving, retried next tick, never permanently stranded failed+unlabeled", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.throwOnAddLabel = true;
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-fix", 6, 60);
  sup.resumeIntents["lane-fix"] = "unconfirmed";

  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });

  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "driving", "never terminalized without a durable, human-visible label landing first");
  const failedLabelEvents = st.eventsSince("1970-01-01T00:00:00Z", ["fix-leg-undecidable-label-failed"]);
  assert.equal(failedLabelEvents.length, 1);
  const terminalEvents = st.eventsSince("1970-01-01T00:00:00Z", ["fix-leg-undecidable"]);
  assert.equal(terminalEvents.length, 0, "the terminalizing event must never fire alongside a failed label write");

  // Retry: label succeeds this time -> now it terminalizes correctly.
  forge.throwOnAddLabel = false;
  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg() });
  const retried = st.getWorker("lane-fix")!;
  assert.equal(retried.state, "failed");
  assert.equal(retried.gated_escalation_labeled, 1);
  st.close();
});
