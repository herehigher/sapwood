// Parity tests for the conductor's pure scheduling core — a faithful port of 0day's
// ops/loop/test_loop_conductor.sh assert table. Same semantics, TS types (booleans for
// the bash 0/1 sentinel/flag args, string[] for the CSV label args). If a row here
// disagrees with the bash row it mirrors, that's a parity regression.
import assert from "node:assert/strict";
import { test } from "node:test";
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
  type Supervisor,
  type LaneProbe,
} from "./conductor.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import type { IForge, Issue, PRStatus } from "./forge.js";

// ── tick test doubles (real State, fake forge + supervisor — no claude, no gh) ──
const DEFAULT_PROBE: LaneProbe = { done: false, failed: false, handoff: false, hbAge: 10, wrapperAlive: 1, hasPr: false };

class FakeForge implements IForge {
  ready: Issue[] = [];
  labelsAdded: Array<[number, string]> = [];
  boardSet: Array<[number, string]> = [];
  claimed: number[] = [];
  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return this.ready; }
  async claimIssue(n: number): Promise<void> { this.claimed.push(n); }
  async setBoardStatus(n: number, s: "ready" | "inProgress" | "done"): Promise<void> { this.boardSet.push([n, s]); }
  async addLabel(n: number, l: string): Promise<void> { this.labelsAdded.push([n, l]); }
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(n: number): Promise<PRStatus> { return { number: n, headOid: "x", state: "OPEN", mergeable: true, ciGreen: true }; }
  async mergePR(): Promise<void> {}
}

class FakeSupervisor implements Supervisor {
  probes: Record<string, LaneProbe> = {};
  dispatched: Issue[] = [];
  reclaimed: string[] = [];
  private n = 0;
  async probe(w: string): Promise<LaneProbe> { return this.probes[w] ?? DEFAULT_PROBE; }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> {
    this.dispatched.push(issue);
    const name = `lane-${++this.n}`;
    return { name, sessionId: `sess-${name}` };
  }
  async reclaim(w: string): Promise<void> { this.reclaimed.push(w); }
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
  assert.deepEqual(byWorker["lane-donepr"], { kind: "done", worker: "lane-donepr", issue: 2, next: "DRIVING" });
  assert.deepEqual(byWorker["lane-donenopr"], { kind: "done", worker: "lane-donenopr", issue: 3, next: "ESCALATE_NOPR" });
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
  assert.deepEqual(r.reclaimed[0], { kind: "dead", worker: "lane-dead", issue: 4, rescued: false });
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
  assert.deepEqual(r.reclaimed[0], { kind: "dead", worker: "lane-deadpr", issue: 6, rescued: true });
  assert.deepEqual(sup.reclaimed, ["lane-deadpr"]); // orphan still killed
  assert.deepEqual(forge.boardSet, []); // NOT handed back to Ready (would race the open PR)
  assert.equal(st.getWorker("lane-deadpr")?.state, "driving");
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
