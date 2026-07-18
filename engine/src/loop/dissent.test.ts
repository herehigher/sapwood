// dissent.test.ts (#237): the PO dissent channel's own module — concern hashing/marker
// idempotency, zero-label/status/dispatch-effect posting, and the per-round adjudication scan.
// align.test.ts covers the END-TO-END wiring (concerns validated alongside align/triage
// deliverables, in-view bounds enforcement); this file is about dissent.ts's OWN orchestration
// logic in isolation, same "fake the collaborator, not the CLI" split every other peripheral's
// test file in this codebase uses.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, IssueMeta, PRReviewData, PRStatus } from "../forge/forge.js";
import { State } from "../state/state.js";
import {
  type Concern,
  concernHash,
  concernMarker,
  isSapwoodComment,
  processConcerns,
  unadjudicatedConcerns,
  validateConcerns,
} from "./dissent.js";

/** A minimal fake IForge — every method the module under test doesn't touch is a harmless no-op
 *  (same shape as harvest.test.ts's MinimalForge). `bodies`/`comments`/`states` are the three
 *  per-issue stores dissent.ts's getIssueBody/getIssueComments/getIssueMeta read from; tests
 *  seed them directly to script a scenario. */
class FakeForge implements IForge {
  async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  bodies: Record<number, string> = {};
  comments: Record<number, Array<{ login: string; createdAt: string; body: string }>> = {};
  states: Record<number, "OPEN" | "CLOSED"> = {};
  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  async getPoolEligibleIssues(): Promise<Issue[]> {
    return [];
  }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  addLabelCalls: Array<[number, string]> = [];
  async addLabel(n: number, l: string): Promise<void> {
    this.addLabelCalls.push([n, l]);
  }
  removeLabelCalls: Array<[number, string]> = [];
  async removeLabel(n: number, l: string): Promise<void> {
    this.removeLabelCalls.push([n, l]);
  }
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> {
    return 1;
  }
  async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(issue: number, body: string): Promise<void> {
    this.comments[issue] = [...(this.comments[issue] ?? []), { login: "sapwood-engine", createdAt: new Date().toISOString(), body }];
  }
  async getIssueBody(issue: number): Promise<string> {
    return this.bodies[issue] ?? "";
  }
  async updateIssueBody(): Promise<void> {}
  async getPRReviewData(): Promise<PRReviewData> {
    return {
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
  async getIssueLabels(): Promise<string[]> {
    return [];
  }
  async getIssueComments(issue: number) {
    return this.comments[issue] ?? [];
  }
  async createIssue(): Promise<number> {
    return 1;
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
  async getIssueMeta(issue: number): Promise<IssueMeta> {
    return { number: issue, title: "", state: this.states[issue] ?? "OPEN", labels: [], updatedAt: "2026-01-01T00:00:00Z" };
  }
}

const mkCfg = (mentions: string[] = ["owner"]): SapwoodConfig =>
  ConfigSchema.parse({
    board: { owner: "owner", repo: "r", projectNumber: 1 },
    notify: { mentions },
  });

const tapEvents = (state: State): Array<[string, unknown]> => {
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  return logged;
};

// ── validateConcerns ────────────────────────────────────────────────────────────────────────

test("validateConcerns: a concern about an in-view issue is ok", () => {
  const result = validateConcerns([{ issue: 5, reason: "premise seems wrong" }], new Set([5, 6]));
  assert.deepEqual(result, { ok: true });
});

test("validateConcerns: a concern about an issue outside the injected view is invalid", () => {
  const result = validateConcerns([{ issue: 99, reason: "x" }], new Set([5, 6]));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /outside this session's injected view/.test(result.reason));
});

test("validateConcerns: two concerns naming the SAME issue is invalid (one concern per issue per session)", () => {
  const result = validateConcerns(
    [
      { issue: 5, reason: "a" },
      { issue: 5, reason: "b" },
    ],
    new Set([5]),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /duplicate concern/.test(result.reason));
});

// ── concernHash / concernMarker (#237 AC5) ──────────────────────────────────────────────────

test("concernHash: the SAME reason + body always hashes identically (deterministic)", () => {
  assert.equal(concernHash("premise is wrong", "the body"), concernHash("premise is wrong", "the body"));
});

test("concernHash: a body edit changes the hash even though the wording is unchanged (#237 AC5)", () => {
  const before = concernHash("premise is wrong", "the ORIGINAL body");
  const after = concernHash("premise is wrong", "the EDITED body");
  assert.notEqual(before, after);
});

test("isSapwoodComment: recognizes any sapwood marker, rejects a plain comment", () => {
  assert.ok(isSapwoodComment("some text\n\n<!-- sapwood:round:1:aligning -->"));
  assert.ok(isSapwoodComment(concernMarker(5, "abc")));
  assert.ok(!isSapwoodComment("just a human reply, no marker"));
});

// ── processConcerns: posting is idempotent by marker, zero label/status/dispatch effects ───

test("processConcerns: posts a comment mentioning notify.mentions and carrying the deterministic marker", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "the issue body";
  const state = new State(":memory:");
  const cfg = mkCfg(["alice", "bob"]);
  const concerns: Concern[] = [{ issue: 10, reason: "this issue's premise contradicts the goal file" }];
  await processConcerns({ forge, state, cfg, roundId: 3, concerns });

  assert.equal(forge.comments[10]?.length, 1);
  const body = forge.comments[10]![0]!.body;
  assert.match(body, /@alice @bob/);
  assert.match(body, /this issue's premise contradicts the goal file/);
  const hash = concernHash(concerns[0]!.reason, "the issue body");
  assert.ok(body.includes(concernMarker(10, hash)));

  // Zero label/status/dispatch effects, by construction — no such call exists on this forge.
  assert.deepEqual(forge.addLabelCalls, []);
  assert.deepEqual(forge.removeLabelCalls, []);

  // Bookkeeping event landed too.
  const events = state.eventsAfterId(0, ["concern-posted"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, { round_id: 3, issue: 10, reason: concerns[0]!.reason, hash });
  state.close();
});

test("processConcerns: the SAME (issue, hash) is never reposted across rounds — marker check IS the dedup boundary, not the durable event", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "the issue body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "same worded concern" };
  await processConcerns({ forge, state, cfg, roundId: 1, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 1);
  // A LATER round raises the exact same worded concern about the exact same (unedited) body.
  await processConcerns({ forge, state, cfg, roundId: 2, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 1, "no repost — the live marker check found the prior comment");
  state.close();
});

test("processConcerns: dedup holds even when the durable concern-posted event never landed (delivery idempotency is the LIVE marker, not the event)", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "the issue body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "x" };
  // Simulate a crash strictly between the comment landing and the event append: post directly,
  // never append the event.
  const hash = concernHash(concern.reason, "the issue body");
  await forge.addIssueComment(10, `some note\n\n${concernMarker(10, hash)}`);
  assert.equal(state.eventsAfterId(0, ["concern-posted"] as never).length, 0);
  await processConcerns({ forge, state, cfg, roundId: 1, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 1, "still no repost — the marker was already there");
  state.close();
});

test("processConcerns: a body edit (why/what changed) re-arms the SAME worded concern (#237 AC5 fixture)", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "the ORIGINAL body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "same worded concern" };
  await processConcerns({ forge, state, cfg, roundId: 1, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 1);

  // A human edits the issue's why/what.
  forge.bodies[10] = "the EDITED body";
  await processConcerns({ forge, state, cfg, roundId: 2, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 2, "the same worded concern reposts against the new marker hash");
});

test("processConcerns: a forge failure while posting degrades to 'skip this concern this pass' — never throws", async () => {
  const forge = new FakeForge();
  forge.getIssueBody = async () => {
    throw new Error("network blip");
  };
  const state = new State(":memory:");
  const cfg = mkCfg();
  const logged: string[] = [];
  await processConcerns({
    forge,
    state,
    cfg,
    roundId: 1,
    concerns: [{ issue: 10, reason: "x" }],
    log: (m) => logged.push(m),
  });
  assert.equal(Object.keys(forge.comments).length, 0);
  assert.ok(logged.some((m) => /skipped this pass/.test(m)));
  state.close();
});

// ── adjudication scan (part of processConcerns, run unconditionally) ───────────────────────

test("adjudication scan: a closed issue is marked adjudicated ('closed')", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "x" };
  await processConcerns({ forge, state, cfg, roundId: 1, concerns: [concern] });
  forge.states[10] = "CLOSED";
  const logged = tapEvents(state);
  await processConcerns({ forge, state, cfg, roundId: 2, concerns: [] });
  const adjudicated = logged.find(([kind]) => kind === "concern-adjudicated");
  assert.ok(adjudicated);
  assert.deepEqual(adjudicated![1], { issue: 10, hash: concernHash("x", "body"), outcome: "closed" });
  state.close();
});

test("adjudication scan: a body edit is marked adjudicated ('issue-edited') — same mechanism that re-arms the marker also resolves the OLD one", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "original";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "x" };
  await processConcerns({ forge, state, cfg, roundId: 1, concerns: [concern] });
  forge.bodies[10] = "edited";
  const logged = tapEvents(state);
  await processConcerns({ forge, state, cfg, roundId: 2, concerns: [] });
  const adjudicated = logged.find(([kind]) => kind === "concern-adjudicated");
  assert.ok(adjudicated);
  assert.equal((adjudicated![1] as { outcome: string }).outcome, "issue-edited");
  state.close();
});

test("adjudication scan: a human reply (a comment with no sapwood marker, after the concern comment) is marked adjudicated ('human-reply')", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "x" };
  await processConcerns({ forge, state, cfg, roundId: 1, concerns: [concern] });
  forge.comments[10]!.push({ login: "a-human", createdAt: new Date().toISOString(), body: "I disagree, proceeding anyway." });
  const logged = tapEvents(state);
  await processConcerns({ forge, state, cfg, roundId: 2, concerns: [] });
  const adjudicated = logged.find(([kind]) => kind === "concern-adjudicated");
  assert.ok(adjudicated);
  assert.equal((adjudicated![1] as { outcome: string }).outcome, "human-reply");
  state.close();
});

test("adjudication scan: silence (no closure, no edit, no reply) leaves the concern unadjudicated — status's count stays 1", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  await processConcerns({ forge, state, cfg, roundId: 1, concerns: [{ issue: 10, reason: "x" }] });
  await processConcerns({ forge, state, cfg, roundId: 2, concerns: [] }); // scan again, nothing changed
  const events = state.eventsAfterId(0, ["concern-posted", "concern-adjudicated"]);
  assert.equal(unadjudicatedConcerns(events).size, 1);
  state.close();
});

test("adjudication scan: a per-issue read failure leaves it unadjudicated this pass — never throws", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  await processConcerns({ forge, state, cfg, roundId: 1, concerns: [{ issue: 10, reason: "x" }] });
  forge.getIssueMeta = async () => {
    throw new Error("boom");
  };
  const logged: string[] = [];
  await processConcerns({ forge, state, cfg, roundId: 2, concerns: [], log: (m) => logged.push(m) });
  assert.ok(logged.some((m) => /left unadjudicated this pass/.test(m)));
  const events = state.eventsAfterId(0, ["concern-posted", "concern-adjudicated"]);
  assert.equal(unadjudicatedConcerns(events).size, 1);
  state.close();
});

// ── unadjudicatedConcerns (shared fold — status/round-artifact both key off this) ──────────

test("unadjudicatedConcerns: a malformed event (missing issue/hash) is skipped, never thrown", () => {
  const events = [
    { kind: "concern-posted", payload: { round_id: 1, issue: 5, hash: "abc", reason: "x" } },
    { kind: "concern-posted", payload: { round_id: 1, reason: "no issue/hash" } },
    { kind: "concern-adjudicated", payload: null },
  ];
  const open = unadjudicatedConcerns(events);
  assert.equal(open.size, 1);
  assert.deepEqual(open.get("5:abc"), { issue: 5, reason: "x", hash: "abc" });
});

test("unadjudicatedConcerns: a matching concern-adjudicated event removes the (issue, hash) from the open set", () => {
  const events = [
    { kind: "concern-posted", payload: { issue: 5, hash: "abc", reason: "x" } },
    { kind: "concern-adjudicated", payload: { issue: 5, hash: "abc", outcome: "closed" } },
  ];
  assert.equal(unadjudicatedConcerns(events).size, 0);
});
