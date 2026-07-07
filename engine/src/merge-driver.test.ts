// merge-driver.ts tests:
//  1. mergeDecision parity suite — a row-for-row TS port of 0day's
//     ops/loop/test_loop_merge_driver.sh (source: /0day/ops/loop/test_loop_merge_driver.sh).
//  2. deriveGate — the scheduling-gate glue (gate①/gate②/labels/state -> MERGE/WAIT/HUMAN).
//  3. MergeDriver.driveOne — end-to-end with a fake IForge + fake Reviewer (no real gh calls).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeDecision, deriveGate, MergeDriver, type DriveOutcome } from "./merge-driver.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";
import type { Reviewer, ReviewVerdict, ReviewAction } from "./reviewer.js";

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1) mergeDecision parity suite (0day ops/loop/test_loop_merge_driver.sh, 23 assertions)
// ─────────────────────────────────────────────────────────────────────────────────────────

test("mergeDecision parity: MERGE_OK + OPEN + clean label -> MERGE (trustedApproval irrelevant to MERGE_OK)", () => {
  assert.equal(mergeDecision("MERGE_OK", ""), "MERGE");
  assert.equal(mergeDecision("MERGE_OK", "type:ops,infra"), "MERGE");
  assert.equal(mergeDecision("MERGE_OK", "", "OPEN"), "MERGE");
});

test("mergeDecision parity: APPROVED_PR_LEVEL (bare 👍) — only a trusted fresh 👍 auto-merges", () => {
  assert.equal(mergeDecision("APPROVED_PR_LEVEL", "", "OPEN", true), "MERGE"); // Codex-bot fresh 👍
  assert.equal(mergeDecision("APPROVED_PR_LEVEL", "type:ops,infra", "OPEN", true), "MERGE");
  assert.equal(mergeDecision("APPROVED_PR_LEVEL", "", "OPEN", false), "ESCALATE"); // self-👍 only
  assert.equal(mergeDecision("APPROVED_PR_LEVEL", ""), "ESCALATE"); // default trustedApproval=false
  assert.equal(mergeDecision("APPROVED_PR_LEVEL", "risk:fund-path", "OPEN", true), "ESCALATE"); // trusted 👍 but risk label still blocks
  assert.equal(mergeDecision("APPROVED_PR_LEVEL", "", "MERGED", true), "ESCALATE"); // trusted 👍 but non-OPEN still blocks
});

test("mergeDecision parity: risk/fund/needs-human/blocked labels -> ESCALATE even on MERGE_OK", () => {
  assert.equal(mergeDecision("MERGE_OK", "risk:fund-path"), "ESCALATE");
  assert.equal(mergeDecision("MERGE_OK", "needs-human"), "ESCALATE");
  assert.equal(mergeDecision("MERGE_OK", "blocked,infra"), "ESCALATE");
});

test("mergeDecision parity: non-OPEN (already merged/closed) never acted on, even with MERGE_OK", () => {
  assert.equal(mergeDecision("MERGE_OK", "", "MERGED"), "ESCALATE");
  assert.equal(mergeDecision("MERGE_OK", "", "CLOSED"), "ESCALATE");
});

test("mergeDecision parity: terminal non-actionable actions -> ESCALATE (never wait/merge)", () => {
  assert.equal(mergeDecision("CI_RED", ""), "ESCALATE");
  assert.equal(mergeDecision("HANDLE_THREADS", ""), "ESCALATE");
  assert.equal(mergeDecision("DRAFT_HUMAN", ""), "ESCALATE");
  assert.equal(mergeDecision("ESCALATE_HUMAN", ""), "ESCALATE");
});

test("mergeDecision parity: passive-wait actions -> WAIT", () => {
  assert.equal(mergeDecision("WAIT_REVIEW", ""), "WAIT");
  assert.equal(mergeDecision("WAIT_CI", ""), "WAIT");
  assert.equal(mergeDecision("WAIT_EYES", ""), "WAIT");
});

test("mergeDecision parity: fail-safe — unknown/empty ACTION never auto-merges or auto-waits", () => {
  assert.equal(mergeDecision("TOTALLY_UNKNOWN", ""), "ESCALATE");
  assert.equal(mergeDecision("", ""), "ESCALATE");
});

test("mergeDecision (sapwood extension beyond 0day parity): REVIEW_UNAVAILABLE queues (WAIT), never escalates or merges (#13)", () => {
  assert.equal(mergeDecision("REVIEW_UNAVAILABLE", ""), "WAIT");
  assert.equal(mergeDecision("REVIEW_UNAVAILABLE", "needs-human"), "WAIT"); // even with a risk label present
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 2) deriveGate — scheduling gate glue
// ─────────────────────────────────────────────────────────────────────────────────────────

const HUMAN_LABELS = ["needs-human", "blocked"];
const gateInput = (over: Partial<Parameters<typeof deriveGate>[0]> = {}) => ({
  ciGreen: true,
  reviewAction: "MERGE_OK" as ReviewAction,
  isDraft: false,
  prState: "OPEN" as const,
  labels: [] as string[],
  humanLabels: HUMAN_LABELS,
  ...over,
});

test("deriveGate: MERGE_OK + CI green + no labels + OPEN -> MERGE", () => {
  assert.equal(deriveGate(gateInput()), "MERGE");
});

test("deriveGate: MERGE_OK but CI not green -> WAIT (gate① still pending)", () => {
  assert.equal(deriveGate(gateInput({ ciGreen: false })), "WAIT");
});

test("deriveGate: WAIT_REVIEW -> WAIT regardless of CI", () => {
  assert.equal(deriveGate(gateInput({ reviewAction: "WAIT_REVIEW", ciGreen: true })), "WAIT");
});

test("deriveGate: REVIEW_UNAVAILABLE -> WAIT (queue) — never HUMAN, never MERGE (#13)", () => {
  assert.equal(deriveGate(gateInput({ reviewAction: "REVIEW_UNAVAILABLE" })), "WAIT");
});

test("deriveGate: HANDLE_THREADS (findings) -> HUMAN (fixup-worker auto-dispatch deferred, see merge-driver.ts NOTE)", () => {
  assert.equal(deriveGate(gateInput({ reviewAction: "HANDLE_THREADS" })), "HUMAN");
});

test("deriveGate: a draft PR is always HUMAN, even with MERGE_OK + CI green", () => {
  assert.equal(deriveGate(gateInput({ isDraft: true })), "HUMAN");
});

test("deriveGate: a non-OPEN PR is always HUMAN, even with MERGE_OK + CI green", () => {
  assert.equal(deriveGate(gateInput({ prState: "MERGED" })), "HUMAN");
  assert.equal(deriveGate(gateInput({ prState: "CLOSED" })), "HUMAN");
});

test("deriveGate: a configured human-triage label always wins, even with MERGE_OK + CI green", () => {
  assert.equal(deriveGate(gateInput({ labels: ["needs-human"] })), "HUMAN");
  assert.equal(deriveGate(gateInput({ labels: ["blocked", "type:feature"] })), "HUMAN");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3) MergeDriver.driveOne — end-to-end with fakes (no real gh calls)
// ─────────────────────────────────────────────────────────────────────────────────────────

class FakeForge implements IForge {
  merged: Array<[number, string]> = [];
  labelsAdded: Array<[number, string]> = [];
  status: PRStatus = { number: 1, headOid: "HEAD", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  reviewData: PRReviewData = {
    headOid: "HEAD", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false,
    labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0,
  };
  statusErr: Error | null = null;
  mergeErr: Error | null = null;

  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return []; }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(n: number, l: string): Promise<void> { this.labelsAdded.push([n, l]); }
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(): Promise<PRStatus> {
    if (this.statusErr) throw this.statusErr;
    return this.status;
  }
  async mergePR(pr: number, headOid: string): Promise<void> {
    if (this.mergeErr) throw this.mergeErr;
    this.merged.push([pr, headOid]);
  }
  async addPRComment(): Promise<void> {}
  async getIssueBody(): Promise<string> { return ""; }
  async getPRReviewData(): Promise<PRReviewData> { return this.reviewData; }
}

class FakeReviewer implements Reviewer {
  readonly kind = "different-model-codex" as const;
  triggered: number[] = [];
  triggeredWith: Array<[number, number]> = [];
  verdict: ReviewVerdict = { action: "MERGE_OK", headOid: "HEAD" };
  async triggerReview(_forge: IForge, pr: number, issue: number): Promise<void> {
    this.triggered.push(pr);
    this.triggeredWith.push([pr, issue]);
  }
  verdictFromData(): ReviewVerdict { return this.verdict; }
}

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 }, ...over });

// #55 P1-B: driveOne now takes (pr, issue, triggerPin, recordTrigger). Most of the tests below
// are about the GATE/MERGE machinery downstream of the trigger check, not the trigger check
// itself — so they pass a pin that already matches FakeForge's default head ("HEAD"), which
// skips straight past the trigger branch exactly like the pre-#55 tests (that always assumed
// an already-triggered lane). The trigger-pin behavior itself is covered in its own section
// below ("review-trigger pin (#55 P1-B)").
const ALREADY_TRIGGERED = { head: "HEAD", at: "2020-01-01T00:00:00Z" };
const noopRecord = (_head: string, _at: string): void => {};

test("MergeDriver.driveOne: gates pass (CI green + MERGE_OK) -> merges with the PINNED head oid", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD" });
  assert.deepEqual(forge.merged, [[7, "HEAD"]]);
});

test("MergeDriver.driveOne: SPLIT-HEAD observation (CI read saw one head, review read another) -> queued, never merges (Codex PR #42 P1)", async () => {
  const forge = new FakeForge();
  // The CI status call observed old-green commit A while the review-data call observed the
  // newly-reviewed commit HEAD whose CI hasn't run — merging would apply A's CI result to HEAD.
  forge.status = { ...forge.status, headOid: "OLD_GREEN_A", ciGreen: true };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /gate-head-mismatch/);
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne: PR already MERGED (by a human) -> merged outcome, not needs-human (Codex PR #42 P2)", async () => {
  // produce-pr-and-stop's designed happy path: lane stays driving, human merges, next tick
  // must classify the lane as done — not mark the worker failed with a needs-human label.
  const forge = new FakeForge();
  forge.status = { ...forge.status, state: "MERGED" };
  forge.reviewData = { ...forge.reviewData, state: "MERGED" };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD" });
  assert.deepEqual(forge.merged, []); // recognized as merged; no second merge attempt
});

test("MergeDriver.driveOne: merge raced — only ONE read saw MERGED yet -> still merged, wins over head-mismatch queue", async () => {
  const forge = new FakeForge();
  // Status read landed after the human merge (MERGED, head moved to the merge result);
  // review read predates it (OPEN, old head). Must resolve merged, not queue forever.
  forge.status = { ...forge.status, state: "MERGED", headOid: "MERGE_RESULT" };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "merged");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne: PR CLOSED without merge -> still needs-human (genuinely human territory)", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, state: "CLOSED" };
  forge.reviewData = { ...forge.reviewData, state: "CLOSED" };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne: CONFLICTING PR -> needs-human WITHOUT a merge attempt (Codex PR #42 P2)", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, mergeable: "CONFLICTING" };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "needs-human");
  assert.match((outcome as { reason: string }).reason, /merge-conflict/);
  assert.deepEqual(forge.merged, []); // routed to human BEFORE calling mergePR
});

test("MergeDriver.driveOne: mergeability UNKNOWN (GitHub still computing) -> queued, not escalated", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, mergeable: "UNKNOWN" };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /mergeability-unknown/);
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne: TOCTOU merge failure (head moved) -> queued for re-gate, not human", async () => {
  const forge = new FakeForge();
  forge.mergeErr = new Error("GraphQL: Head branch was modified. Review and try the merge again.");
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /merge-failed-retry/);
});

test("MergeDriver.driveOne: deterministic 'not mergeable' merge failure -> needs-human, no infinite retry (Codex PR #42 P2)", async () => {
  const forge = new FakeForge();
  // Conflict surfaced between our status read (MERGEABLE) and the merge call.
  forge.mergeErr = new Error("Pull Request is not mergeable");
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "needs-human");
  assert.match((outcome as { reason: string }).reason, /merge-failed-deterministic/);
});

test("MergeDriver.driveOne: CI not green -> queued (WAIT), never merges", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, ciGreen: false };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne: review verdict REVIEW_UNAVAILABLE -> queued, never escalated or merged (#13)", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "REVIEW_UNAVAILABLE", headOid: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(forge.merged, []);
  assert.deepEqual(forge.labelsAdded, []); // never escalated to human either
});

test("MergeDriver.driveOne: a review-data fetch failure (rate-limit/timeout) -> queued, never throws", async () => {
  const forge = new FakeForge();
  forge.statusErr = new Error("rate limited");
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /gate-data-unavailable/);
});

test("MergeDriver.driveOne: unresolved findings (HANDLE_THREADS) -> needs-human, labels the PR, never merges", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "HANDLE_THREADS", headOid: "HEAD" };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne: a risk/human-triage label on the PR blocks merge even with MERGE_OK + CI green", async () => {
  const forge = new FakeForge();
  forge.reviewData = { ...forge.reviewData, labels: ["needs-human"] };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne: merge.mode=produce-pr-and-stop reports gates but NEVER calls forge.mergePR", async () => {
  const forge = new FakeForge();
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg({ merge: { mode: "produce-pr-and-stop" } }) });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne: TOCTOU — head moved between the gate check and the merge call -> queued, retried (never a silent merge of the new head)", async () => {
  const forge = new FakeForge();
  forge.mergeErr = new Error("failed to merge: head branch was modified"); // gh's own --match-head-commit rejection
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /merge-failed-retry/);
});

// ── review-trigger pin (#55 P1-B): the trigger decision now lives IN driveOne, at the point
// the head is known, replacing the old once-per-lane MergeDriver.ensureTriggered (removed) ──

test("MergeDriver.driveOne: no trigger recorded yet (pin.head === null) -> posts the trigger, records {head, now}, and queues (never gates this tick)", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const recorded: Array<[string, string]> = [];
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg(), now: () => new Date("2026-07-07T08:00:00Z") });
  const outcome = await driver.driveOne(7, 46, { head: null, at: null }, (h, a) => recorded.push([h, a]));
  assert.deepEqual(outcome, { kind: "queued", pr: 7, reason: "review-triggered" });
  assert.deepEqual(reviewer.triggeredWith, [[7, 46]]); // issue #46 threaded through
  assert.deepEqual(recorded, [["HEAD", "2026-07-07T08:00:00.000Z"]]);
  assert.deepEqual(forge.merged, []); // never gates/merges on the SAME tick as the trigger
});

test("MergeDriver.driveOne: trigger pin recorded for a DIFFERENT (older) head -> re-triggers on the NEW head, queues", async () => {
  const forge = new FakeForge(); // forge.status/reviewData default headOid: "HEAD"
  const reviewer = new FakeReviewer();
  const recorded: Array<[string, string]> = [];
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg(), now: () => new Date("2026-07-07T09:00:00Z") });
  const outcome = await driver.driveOne(7, 46, { head: "OLD_HEAD", at: "2026-07-07T07:00:00Z" }, (h, a) => recorded.push([h, a]));
  assert.deepEqual(outcome, { kind: "queued", pr: 7, reason: "review-triggered" });
  assert.deepEqual(recorded, [["HEAD", "2026-07-07T09:00:00.000Z"]]);
});

test("MergeDriver.driveOne: pin matches the CURRENT head -> no re-trigger, proceeds straight to gating", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.deepEqual(reviewer.triggered, []); // no fresh trigger posted
  assert.equal(outcome.kind, "merged"); // gate ran normally and merged
});

test("MergeDriver.driveOne: head change mid-drive re-triggers exactly once per new head, one drive call at a time", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg(), now: () => new Date("2026-07-07T10:00:00Z") });
  let pin = { head: null as string | null, at: null as string | null };
  const record = (h: string, a: string) => { pin = { head: h, at: a }; };

  // Tick 1: never triggered -> triggers for "HEAD", queues.
  const t1 = await driver.driveOne(7, 46, pin, record);
  assert.deepEqual(t1, { kind: "queued", pr: 7, reason: "review-triggered" });
  assert.deepEqual(pin, { head: "HEAD", at: "2026-07-07T10:00:00.000Z" });

  // Tick 2: pin matches -> no re-trigger, gates through to merge.
  const t2 = await driver.driveOne(7, 46, pin, record);
  assert.equal(t2.kind, "merged");
  assert.equal(reviewer.triggered.length, 1); // still exactly once

  // A push moves the head; tick 3 must re-trigger exactly once for the NEW head, then queue.
  forge.status = { ...forge.status, headOid: "HEAD2" };
  forge.reviewData = { ...forge.reviewData, headOid: "HEAD2" };
  const t3 = await driver.driveOne(7, 46, pin, record);
  assert.deepEqual(t3, { kind: "queued", pr: 7, reason: "review-triggered" });
  assert.deepEqual(pin, { head: "HEAD2", at: "2026-07-07T10:00:00.000Z" });
  assert.equal(reviewer.triggered.length, 2); // one more trigger, not a flood
});

// A helper type check so the reason field is always present on non-merged/stopped outcomes.
void ((): DriveOutcome => ({ kind: "queued", pr: 1, reason: "x" }));
