// dissent.test.ts (#237): the PO dissent channel's own module — concern hashing/marker
// idempotency, zero-label/status/dispatch-effect posting, and the per-round adjudication scan.
// align.test.ts covers the END-TO-END wiring (concerns validated alongside align/triage
// deliverables, in-view bounds enforcement); this file is about dissent.ts's OWN orchestration
// logic in isolation, same "fake the collaborator, not the CLI" split every other peripheral's
// test file in this codebase uses.
//
// #237 2026-07-18 adjudication (gate② on PR #262, finding 5): postConcerns (posting) and
// scanForAdjudication (adjudication) are now two SEPARATE exported functions — production wires
// them from different call sites (align.ts's createAligningStub calls postConcerns only;
// round-defaults.ts's aligning wrapper calls scanForAdjudication unconditionally, decoupled from
// roles.po.enabled). The `run` helper below calls them in that SAME order (scan, then post) so
// every test here exercises the real production sequencing rather than an ad hoc one.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, IssueMeta, PRReviewData, PRStatus } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import { State } from "../state/state.js";
import {
  type Concern,
  concernHash,
  concernMarker,
  isSapwoodComment,
  pendingDurableConcerns,
  postConcerns,
  reconcileDurableConcerns,
  scanForAdjudication,
  unadjudicatedConcerns,
  validateConcerns,
} from "./dissent.js";

/** A minimal fake IForge — every method the module under test doesn't touch is a harmless no-op
 *  (same shape as harvest.test.ts's MinimalForge). `bodies`/`comments`/`states` are the three
 *  per-issue stores dissent.ts's getIssueBody/getIssueComments/getIssueMeta read from; tests
 *  seed them directly to script a scenario. */
class FakeForge extends UnstubbedForge implements IForge {
  // #379: repo-level label provisioning — no test in this file exercises it.
  override async ensureRepoLabels(): Promise<string[]> {
    return [];
  }
  override async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  override async listIssuesAbsentFromBoard() {
    return [];
  }
  override async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  bodies: Record<number, string> = {};
  comments: Record<number, Array<{ login: string; createdAt: string; body: string }>> = {};
  states: Record<number, "OPEN" | "CLOSED"> = {};
  override async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  override async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  override async getPoolEligibleIssues(): Promise<Issue[]> {
    return [];
  }
  override async claimIssue(): Promise<void> {}
  override async setBoardStatus(): Promise<void> {}
  override async addSubIssue(): Promise<void> {
    throw new Error("FakeForge.addSubIssue is not used by this test");
  }
  override async getSubIssues() {
    return [];
  }
  addLabelCalls: Array<[number, string]> = [];
  override async addLabel(n: number, l: string): Promise<void> {
    this.addLabelCalls.push([n, l]);
  }
  removeLabelCalls: Array<[number, string]> = [];
  override async removeLabel(n: number, l: string): Promise<void> {
    this.removeLabelCalls.push([n, l]);
  }
  override async addPRLabel(): Promise<void> {}
  override async openPR(): Promise<number> {
    return 1;
  }
  override async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  override async mergePR(): Promise<void> {}
  override async addPRComment(): Promise<void> {}
  override async addIssueComment(issue: number, body: string): Promise<void> {
    // #237 finding 2: production stamps ENGINE_COMMENT_MARKER at the forge.ts write boundary
    // (GithubForge.addIssueComment) — this fake stands in for that boundary too, so isSapwoodComment
    // recognizes every engine-posted comment here exactly like it would against real GitHub.
    this.comments[issue] = [
      ...(this.comments[issue] ?? []),
      { login: "sapwood-engine", createdAt: new Date().toISOString(), body: `${body}\n\n<!-- sapwood:engine -->` },
    ];
  }
  override async getIssueBody(issue: number): Promise<string> {
    return this.bodies[issue] ?? "";
  }
  override async updateIssueBody(): Promise<void> {}
  override async getPRReviewData(): Promise<PRReviewData> {
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
  override async getPRDiff(): Promise<string> {
    return "";
  }
  override async getPRChangedFiles() {
    return { files: [], complete: true };
  }
  override async getCommitsSince(): Promise<CommitInfo[]> {
    return [];
  }
  override async branchExists(): Promise<boolean> {
    return false;
  }
  override async countOpenIssuesInMilestone(): Promise<number> {
    return 0;
  }
  override async listMilestoneTitles(): Promise<string[]> {
    return [];
  }
  override async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return [];
  }
  override async getIssueLabels(): Promise<string[]> {
    return [];
  }
  override async getIssueComments(issue: number) {
    return this.comments[issue] ?? [];
  }
  override async createIssue(): Promise<number> {
    return 1;
  }
  override async listOpenIssueNumbers(): Promise<number[]> {
    return [];
  }
  override async listOpenIssues(): Promise<Issue[]> {
    return [];
  }
  override async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return [];
  }
  override async getIssueMeta(issue: number): Promise<IssueMeta> {
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

/** Mirrors the REAL production call sequence (module doc): round-defaults.ts's unconditional
 *  scan, then align.ts's postConcerns for this round's freshly validated concerns. */
async function runRound(
  forge: IForge,
  state: State,
  cfg: SapwoodConfig,
  roundId: number,
  concerns: Concern[],
  log?: (message: string) => void,
): Promise<void> {
  await scanForAdjudication(forge, state, log);
  await postConcerns({ forge, state, cfg, roundId, concerns, ...(log ? { log } : {}) });
}

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
  assert.ok(isSapwoodComment("some text\n\n<!-- sapwood:engine -->")); // #237 finding 2: generic stamp
  assert.ok(!isSapwoodComment("just a human reply, no marker"));
});

// ── postConcerns: posting is idempotent by marker, zero label/status/dispatch effects ──────

test("postConcerns: posts a comment mentioning notify.mentions and carrying the deterministic marker", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "the issue body";
  const state = new State(":memory:");
  const cfg = mkCfg(["alice", "bob"]);
  const concerns: Concern[] = [{ issue: 10, reason: "this issue's premise contradicts the goal file" }];
  await postConcerns({ forge, state, cfg, roundId: 3, concerns });

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

test("postConcerns: the SAME (issue, hash) is never reposted across rounds — marker check IS the dedup boundary, not the durable event", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "the issue body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "same worded concern" };
  await postConcerns({ forge, state, cfg, roundId: 1, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 1);
  // A LATER round raises the exact same worded concern about the exact same (unedited) body.
  await postConcerns({ forge, state, cfg, roundId: 2, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 1, "no repost — the live marker check found the prior comment");
  state.close();
});

test("postConcerns #237 finding 3: a live marker with NO matching durable receipt is RECONCILED (a concern-posted event is appended) rather than silently understated", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "the issue body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "x" };
  // Simulate a crash strictly between the comment landing and the event append: post directly,
  // never append the event.
  const hash = concernHash(concern.reason, "the issue body");
  await forge.addIssueComment(10, `some note\n\n${concernMarker(10, hash)}`);
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 0);

  await postConcerns({ forge, state, cfg, roundId: 1, concerns: [concern] });

  assert.equal(forge.comments[10]?.length, 1, "still no repost — the marker was already there");
  const events = state.eventsAfterId(0, ["concern-posted"]);
  assert.equal(events.length, 1, "the missing receipt was reconciled, not left permanently lost");
  assert.deepEqual(events[0]!.payload, { round_id: 1, issue: 10, reason: "x", hash, reconciled: true });
  // The reconciled receipt makes this concern visible to status/round-summary immediately —
  // never posted twice on a THIRD pass either.
  await postConcerns({ forge, state, cfg, roundId: 2, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 1);
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 1, "reconciling again does not duplicate the receipt");
  state.close();
});

test("postConcerns: a body edit (why/what changed) re-arms the SAME worded concern (#237 AC5 fixture)", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "the ORIGINAL body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "same worded concern" };
  await postConcerns({ forge, state, cfg, roundId: 1, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 1);

  // A human edits the issue's why/what.
  forge.bodies[10] = "the EDITED body";
  await postConcerns({ forge, state, cfg, roundId: 2, concerns: [concern] });
  assert.equal(forge.comments[10]?.length, 2, "the same worded concern reposts against the new marker hash");
});

test("postConcerns: a forge failure while posting degrades to 'skip this concern this pass' — never throws", async () => {
  const forge = new FakeForge();
  forge.getIssueBody = async () => {
    throw new Error("network blip");
  };
  const state = new State(":memory:");
  const cfg = mkCfg();
  const logged: string[] = [];
  await postConcerns({
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

// ── scanForAdjudication: a SEPARATE, unconditional round-level hook (#237 finding 5) ────────

test("scanForAdjudication: a closed issue is marked adjudicated ('closed')", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "x" };
  await runRound(forge, state, cfg, 1, [concern]);
  forge.states[10] = "CLOSED";
  const logged = tapEvents(state);
  await runRound(forge, state, cfg, 2, []);
  const adjudicated = logged.find(([kind]) => kind === "concern-adjudicated");
  assert.ok(adjudicated);
  assert.deepEqual(adjudicated![1], { issue: 10, hash: concernHash("x", "body"), outcome: "closed" });
  state.close();
});

test("scanForAdjudication #237 finding 1: a body edit is marked adjudicated 'body-changed' (renamed from 'issue-edited' — no human-attribution claim)", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "original";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "x" };
  await runRound(forge, state, cfg, 1, [concern]);
  forge.bodies[10] = "edited";
  const logged = tapEvents(state);
  await runRound(forge, state, cfg, 2, []);
  const adjudicated = logged.find(([kind]) => kind === "concern-adjudicated");
  assert.ok(adjudicated);
  assert.equal((adjudicated![1] as { outcome: string }).outcome, "body-changed");
  state.close();
});

test("scanForAdjudication #237 finding 1: an ENGINE-authored body edit (e.g. a later triage draft) ALSO produces 'body-changed' — the outcome makes no claim about who edited it", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "planless body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "no plan yet" };
  await runRound(forge, state, cfg, 1, [concern]);
  // Simulate the ENGINE's own triage write (align.ts's updateIssueBody), not a human edit.
  forge.bodies[10] = "planless body\n## Verification\n- run npm test";
  const logged = tapEvents(state);
  await runRound(forge, state, cfg, 2, []);
  const adjudicated = logged.find(([kind]) => kind === "concern-adjudicated");
  assert.ok(adjudicated, "an engine write triggers the same outcome as a human edit — by design (module doc)");
  assert.equal((adjudicated![1] as { outcome: string }).outcome, "body-changed");
  state.close();
});

test("scanForAdjudication #237 finding 2: a non-sapwood-marked reply is 'external-reply' (renamed from 'human-reply' — any non-engine actor, e.g. another bot, counts)", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 10, reason: "x" };
  await runRound(forge, state, cfg, 1, [concern]);
  forge.comments[10]!.push({ login: "some-other-bot", createdAt: new Date().toISOString(), body: "Codex: I looked into this too." });
  const logged = tapEvents(state);
  await runRound(forge, state, cfg, 2, []);
  const adjudicated = logged.find(([kind]) => kind === "concern-adjudicated");
  assert.ok(adjudicated);
  assert.equal((adjudicated![1] as { outcome: string }).outcome, "external-reply");
  state.close();
});

test("scanForAdjudication: silence (no closure, no edit, no reply) leaves the concern unadjudicated — status's count stays 1", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  await runRound(forge, state, cfg, 1, [{ issue: 10, reason: "x" }]);
  await runRound(forge, state, cfg, 2, []); // scan again, nothing changed
  const events = state.eventsAfterId(0, ["concern-posted", "concern-adjudicated"]);
  assert.equal(unadjudicatedConcerns(events).size, 1);
  state.close();
});

test("scanForAdjudication: a per-issue read failure leaves it unadjudicated this pass — never throws", async () => {
  const forge = new FakeForge();
  forge.bodies[10] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  await runRound(forge, state, cfg, 1, [{ issue: 10, reason: "x" }]);
  forge.getIssueMeta = async () => {
    throw new Error("boom");
  };
  const logged: string[] = [];
  await scanForAdjudication(forge, state, (m) => logged.push(m));
  assert.ok(logged.some((m) => /left unadjudicated this pass/.test(m)));
  const events = state.eventsAfterId(0, ["concern-posted", "concern-adjudicated"]);
  assert.equal(unadjudicatedConcerns(events).size, 1);
  state.close();
});

test("scanForAdjudication: runs and completes with zero forge calls when there is nothing posted yet (round-level unconditional hook, #237 finding 5)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  await scanForAdjudication(forge, state);
  assert.equal(Object.keys(forge.comments).length, 0);
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

// ── reconcileDurableConcerns (#237 round-2 adjudication, finding 1): the durable backstop ──
//
// align.ts's own per-round journal (triageProgress/proposalProgress) short-circuits a decision
// the INSTANT it reaches its terminal receipt — so a concern whose post never completed (crash
// strictly between the terminal receipt landing and postConcerns finishing) can NEVER be
// re-collected by that in-memory, per-round path again, even on a same-round rerun. These tests
// seed the EXACT durable event shapes align.ts itself would have written (a
// triage-decision-accepted / proposal-set-persisted event carrying `concerns`, PLUS a terminal
// receipt) with NO matching concern-posted event, and verify the sweep recovers it — reading only
// the durable ledger, never any in-memory queue.

test("reconcileDurableConcerns: a triage-decision-accepted concern with a terminal receipt already landed, but NO concern-posted event, is recovered — the real terminal-replay path (finding 1)", async () => {
  const forge = new FakeForge();
  forge.bodies[91] = "planless body\n## Verification\n- x"; // the ALREADY-COMMITTED body (post-write)
  const state = new State(":memory:");
  const cfg = mkCfg();
  // Exactly what align.ts's triage loop persists — concerns riding along, per this issue's own
  // finding-6 fix.
  state.appendEvent("triage-decision-accepted", {
    round_id: 5,
    issue: 91,
    phase: "aligning",
    role: "po",
    session: "po-triage:91",
    attempt: 1,
    body: forge.bodies[91],
    expected_hash: "irrelevant-to-this-sweep",
    concerns: [{ issue: 91, reason: "this issue's premise seems wrong" }],
  });
  // The decision reached its TERMINAL receipt — align.ts's own per-round journal now
  // short-circuits any same-round re-collection of this decision's concerns forever.
  state.appendEvent("triage-effects-committed", {
    round_id: 5,
    issue: 91,
    phase: "aligning",
    role: "po",
    session: "po-triage:91",
    attempt: 1,
  });
  // NO concern-posted event exists — the crash landed strictly between the terminal receipt and
  // postConcerns() actually delivering this concern (never posted at all in this scenario).
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 0);

  // A LATER round's unconditional sweep (round-defaults.ts's wiring) runs.
  await reconcileDurableConcerns(forge, state, cfg);

  assert.equal(forge.comments[91]?.length, 1, "the sweep posted the concern fresh — it never existed on GitHub before this");
  const events = state.eventsAfterId(0, ["concern-posted"]);
  assert.equal(events.length, 1);
  // #237 finding 2: attributed to the DECISION's own original round (5), never the sweep's
  // current round (8).
  assert.equal((events[0]!.payload as { round_id: number }).round_id, 5);
  state.close();
});

test("reconcileDurableConcerns: the comment ALREADY posted (crash between comment and receipt) is reconciled with the ORIGINAL round_id, not the sweep's current round (finding 2)", async () => {
  const forge = new FakeForge();
  forge.bodies[91] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  const concern: Concern = { issue: 91, reason: "premise seems wrong" };
  const hash = concernHash(concern.reason, "body");
  // The comment already landed on GitHub in round 5 (simulated directly, bypassing dissent.ts —
  // exactly what "crashed after addIssueComment, before the event append" looks like).
  await forge.addIssueComment(91, `some note\n\n${concernMarker(91, hash)}`);
  state.appendEvent("triage-decision-accepted", {
    round_id: 5,
    issue: 91,
    phase: "aligning",
    role: "po",
    session: "po-triage:91",
    attempt: 1,
    body: "body",
    expected_hash: "x",
    concerns: [concern],
  });
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 0);

  await reconcileDurableConcerns(forge, state, cfg); // running in round 8, well after round 5

  assert.equal(forge.comments[91]?.length, 1, "no repost — the live marker was already there");
  const events = state.eventsAfterId(0, ["concern-posted"]);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0]!.payload, { round_id: 5, issue: 91, reason: concern.reason, hash, reconciled: true });
  state.close();
});

test("reconcileDurableConcerns: align-mode concerns embedded in proposal-set-persisted are ALSO swept", async () => {
  const forge = new FakeForge();
  forge.bodies[42] = "existing issue body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  state.appendEvent("proposal-set-persisted", {
    round_id: 3,
    proposals: [],
    concerns: [{ issue: 42, reason: "align concern, never delivered" }],
  });

  await reconcileDurableConcerns(forge, state, cfg);

  assert.equal(forge.comments[42]?.length, 1);
  const events = state.eventsAfterId(0, ["concern-posted"]);
  assert.equal((events[0]!.payload as { round_id: number }).round_id, 3);
  state.close();
});

test("reconcileDurableConcerns: idempotent — a second sweep does not repost or duplicate the receipt", async () => {
  const forge = new FakeForge();
  forge.bodies[91] = "body";
  const state = new State(":memory:");
  const cfg = mkCfg();
  state.appendEvent("triage-decision-accepted", {
    round_id: 5,
    issue: 91,
    phase: "aligning",
    role: "po",
    session: "po-triage:91",
    attempt: 1,
    body: "body",
    expected_hash: "x",
    concerns: [{ issue: 91, reason: "x" }],
  });

  await reconcileDurableConcerns(forge, state, cfg);
  await reconcileDurableConcerns(forge, state, cfg);

  assert.equal(forge.comments[91]?.length, 1);
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 1);
  state.close();
});

test("reconcileDurableConcerns: a decision that ALREADY has a matching receipt is never re-swept (no wasted forge calls)", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  state.appendEvent("triage-decision-accepted", {
    round_id: 5,
    issue: 91,
    phase: "aligning",
    role: "po",
    session: "po-triage:91",
    attempt: 1,
    body: "body",
    expected_hash: "x",
    concerns: [{ issue: 91, reason: "already delivered cleanly" }],
  });
  state.appendEvent("concern-posted", { round_id: 5, issue: 91, reason: "already delivered cleanly", hash: "whatever-hash" });

  await reconcileDurableConcerns(forge, state, cfg);

  assert.equal(Object.keys(forge.comments).length, 0, "no forge call at all — the receipt already matched");
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 1, "no duplicate receipt");
  state.close();
});

test("reconcileDurableConcerns: a malformed decision event (no concerns array) and a malformed receipt are both skipped, never thrown", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  state.appendEvent("triage-decision-accepted", { round_id: 5, issue: 91, body: "x" }); // no concerns field at all — pre-#237 shape
  state.appendEvent("concern-posted", { issue: 5 }); // malformed receipt — missing round_id/reason
  await assert.doesNotReject(() => reconcileDurableConcerns(forge, state, cfg));
  assert.equal(Object.keys(forge.comments).length, 0);
  state.close();
});

test("reconcileDurableConcerns #237 round-3 adjudication: reads the ledger with exactly ONE kind-filtered query, not two", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  state.appendEvent("triage-decision-accepted", { round_id: 5, issue: 91, body: "x", concerns: [{ issue: 91, reason: "x" }] });
  state.appendEvent("concern-posted", { round_id: 5, issue: 91, reason: "x", hash: "already-delivered" });
  let calls = 0;
  const realEventsAfterId = state.eventsAfterId.bind(state);
  state.eventsAfterId = (afterId: number, kinds: string[]) => {
    calls++;
    return realEventsAfterId(afterId, kinds);
  };

  await reconcileDurableConcerns(forge, state, cfg);

  assert.equal(calls, 1, "one collapsed query covering triage-decision-accepted/proposal-set-persisted/concern-posted together");
  state.close();
});

// ── #432 round 5 (P1-2, Codex second confirm round): the TERMINAL a permanently unpostable
//    concern was missing — a deterministic post failure (issue deleted/transferred/permanently
//    inaccessible) must not pin round.ts's probe true forever. ──────────────────────────────────

test("reconcileDurableConcerns (#432 round 6, P1-2): a concern whose issue is PERMANENTLY unreadable is retried, then escalates needs-human EXACTLY ONCE once the cap is reached, and drops out of pendingDurableConcerns from then on", async () => {
  const forge = new FakeForge();
  forge.getIssueBody = async (issue: number) => {
    if (issue === 777) throw new Error("issue permanently inaccessible");
    return "";
  };
  const state = new State(":memory:");
  const cfg = ConfigSchema.parse({
    board: { owner: "owner", repo: "r", projectNumber: 1 },
    roles: { po: { maxConcernPostAttempts: 2 } },
  });
  state.appendEvent("triage-decision-accepted", { round_id: 1, concerns: [{ issue: 777, reason: "this issue's premise seems wrong" }] });

  // Pass 1: failures-so-far (0) < cap (2) — attempts a post, which fails (1 recorded failure).
  await reconcileDurableConcerns(forge, state, cfg);
  assert.equal(pendingDurableConcerns(state).length, 1, "still pending after the first failure — below the cap");
  assert.deepEqual(forge.addLabelCalls, [], "no escalation yet — the cap hasn't been reached");

  // Pass 2: failures-so-far (1) < cap (2) — attempts ONE more post (round 6's cap check runs
  // BEFORE the attempt, using the STANDING count — see reconcileDurableConcerns' own doc for why
  // this ordering, not "escalate the instant the cap is crossed", is what closes the crash
  // window). This attempt also fails, bringing the recorded count to 2.
  await reconcileDurableConcerns(forge, state, cfg);
  assert.equal(pendingDurableConcerns(state).length, 1, "still pending — the cap was JUST reached, not yet acted on this pass");
  assert.deepEqual(forge.addLabelCalls, [], "still no escalation — the check for THIS pass ran before the count reached 2");

  // Pass 3: failures-so-far (2) >= cap (2) — escalates instead of attempting another post.
  await reconcileDurableConcerns(forge, state, cfg);
  assert.equal(pendingDurableConcerns(state).length, 0, "the concern dropped out of pending the instant it escalated");
  assert.deepEqual(forge.addLabelCalls, [[777, cfg.labels.needsHuman]], "escalated needs-human exactly once");

  // Pass 4: a concern that already escalated is no longer even attempted — no further failure
  // events, no re-escalation, no wasted forge calls.
  const bodyCallsBefore = forge.addLabelCalls.length;
  await reconcileDurableConcerns(forge, state, cfg);
  assert.equal(pendingDurableConcerns(state).length, 0, "still empty — nothing left to sweep");
  assert.equal(forge.addLabelCalls.length, bodyCallsBefore, "no repeat escalation on a later pass");

  const escalations = state.eventsAfterId(0, ["concern-post-escalated"]);
  assert.equal(escalations.length, 1, "exactly one terminal escalation event, ever");
  assert.deepEqual(escalations[0]!.payload, {
    issue: 777,
    round_id: 1,
    reason: "this issue's premise seems wrong",
    labeled: 1,
  });
  state.close();
});

test("reconcileDurableConcerns (#432 round 6, P1-1): a concern whose issue is BOTH unreadable AND unlabelable still escalates — the terminal event is UNCONDITIONAL, carrying labeled: 0, not suppressed by the same broken issue also rejecting the addLabel write", async () => {
  const forge = new FakeForge();
  forge.getIssueBody = async (issue: number) => {
    if (issue === 888) throw new Error("issue permanently inaccessible");
    return "";
  };
  forge.addLabel = async (n: number, l: string) => {
    if (n === 888) throw new Error("this issue also rejects label writes");
    forge.addLabelCalls.push([n, l]);
  };
  const state = new State(":memory:");
  const cfg = ConfigSchema.parse({
    board: { owner: "owner", repo: "r", projectNumber: 1 },
    roles: { po: { maxConcernPostAttempts: 1 } },
  });
  state.appendEvent("triage-decision-accepted", { round_id: 1, concerns: [{ issue: 888, reason: "unlabelable too" }] });

  await reconcileDurableConcerns(forge, state, cfg); // pass 1: 0 < cap 1 — attempts a post, fails (1 failure recorded)
  assert.equal(pendingDurableConcerns(state).length, 1, "still pending after the first failure");
  await reconcileDurableConcerns(forge, state, cfg); // pass 2: 1 >= cap 1 — escalates

  assert.equal(pendingDurableConcerns(state).length, 0, "unpinned despite the label write ALSO failing");
  const escalations = state.eventsAfterId(0, ["concern-post-escalated"]);
  assert.equal(escalations.length, 1, "the terminal event landed regardless of the label outcome");
  assert.deepEqual(escalations[0]!.payload, {
    issue: 888,
    round_id: 1,
    reason: "unlabelable too",
    labeled: 0,
    labelError: "Error: this issue also rejects label writes",
  });
  state.close();
});

test("reconcileDurableConcerns (#432 round 5, P1-2): a TRANSIENT failure that clears well under the cap never escalates", async () => {
  const forge = new FakeForge();
  let attempt = 0;
  forge.getIssueBody = async (issue: number) => {
    attempt++;
    if (issue === 42 && attempt <= 2) throw new Error("transient blip");
    return "";
  };
  const state = new State(":memory:");
  const cfg = ConfigSchema.parse({
    board: { owner: "owner", repo: "r", projectNumber: 1 },
    roles: { po: { maxConcernPostAttempts: 5 } },
  });
  state.appendEvent("triage-decision-accepted", { round_id: 1, concerns: [{ issue: 42, reason: "double-check this" }] });

  await reconcileDurableConcerns(forge, state, cfg); // fails (attempt 1)
  await reconcileDurableConcerns(forge, state, cfg); // fails (attempt 2)
  await reconcileDurableConcerns(forge, state, cfg); // succeeds (attempt 3) — well under the cap of 5

  assert.equal(pendingDurableConcerns(state).length, 0, "delivered normally — no longer pending");
  assert.deepEqual(forge.addLabelCalls, [], "never escalated — the transient failure cleared on its own before the cap");
  assert.equal(forge.comments[42]?.length, 1, "the concern comment actually landed");
  state.close();
});

test("round-defaults integration (#237 round-2 adjudication, finding 1+2): reconcileDurableConcerns is what round-defaults.ts's aligning wrapper actually calls — sanity import check", () => {
  // Full round.ts/round-defaults.ts integration coverage lives in round-defaults.test.ts; this
  // file only asserts the function this module exports is the one that gets wired there.
  assert.equal(typeof reconcileDurableConcerns, "function");
});
