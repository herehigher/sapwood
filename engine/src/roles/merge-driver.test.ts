// merge-driver.ts tests:
//  1. mergeDecision parity suite — a TS port of 0day's matrix, with #273's stricter
//     OID-bound rejection of the legacy bare-reaction action.
//  2. deriveGate — the scheduling-gate glue (gate①/gate②/labels/state -> MERGE/WAIT/HUMAN).
//  3. MergeDriver.driveOne — end-to-end with a fake IForge + fake Reviewer (no real gh calls).
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import type { AuditDeliveryResult } from "../review/drive.js";
import { type DriveOutcome, deriveGate, MergeDriver, mergeDecision, reviewSilenceDuration } from "./merge-driver.js";
import type {
  ApprovalResult,
  ReviewAction,
  Reviewer,
  ReviewFallbackLock,
  ReviewTriggerContext,
  ReviewTriggerPin,
  ReviewVerdict,
} from "./reviewer.js";
import { CODEX_REVIEWER_LOGINS, CodexReviewer, HumanReviewer, SameModelTrustedReviewer } from "./reviewer.js";

// ─────────────────────────────────────────────────────────────────────────────────────────
// 1) mergeDecision parity suite (0day ops/loop/test_loop_merge_driver.sh, 23 assertions)
// ─────────────────────────────────────────────────────────────────────────────────────────

test("mergeDecision parity: MERGE_OK + OPEN + clean label -> MERGE (trustedApproval irrelevant to MERGE_OK)", () => {
  assert.equal(mergeDecision("MERGE_OK", ""), "MERGE");
  assert.equal(mergeDecision("MERGE_OK", "type:ops,infra"), "MERGE");
  assert.equal(mergeDecision("MERGE_OK", "", "OPEN"), "MERGE");
});

test("mergeDecision #273: APPROVED_PR_LEVEL (bare 👍) always fails closed because it has no OID", () => {
  assert.equal(mergeDecision("APPROVED_PR_LEVEL", "", "OPEN", true), "ESCALATE");
  assert.equal(mergeDecision("APPROVED_PR_LEVEL", "type:ops,infra", "OPEN", true), "ESCALATE");
  assert.equal(mergeDecision("APPROVED_PR_LEVEL", "", "OPEN", false), "ESCALATE");
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
const HOLD_LABELS = ["hold"];
const gateInput = (over: Partial<Parameters<typeof deriveGate>[0]> = {}) => ({
  ciGreen: true,
  ciRed: false,
  mergeable: "MERGEABLE" as const,
  reviewAction: "MERGE_OK" as ReviewAction,
  isDraft: false,
  prState: "OPEN" as const,
  labels: [] as string[],
  humanLabels: HUMAN_LABELS,
  holdLabels: HOLD_LABELS,
  prFixCap: 2,
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

test("deriveGate (#246): HANDLE_THREADS (findings) -> FIXABLE when the fix loop is enabled (prFixCap > 0)", () => {
  assert.equal(deriveGate(gateInput({ reviewAction: "HANDLE_THREADS" })), "FIXABLE");
});

test("deriveGate (#246): prFixCap === 0 folds HANDLE_THREADS straight to HUMAN — byte-for-byte the pre-#246 behavior", () => {
  assert.equal(deriveGate(gateInput({ reviewAction: "HANDLE_THREADS", prFixCap: 0 })), "HUMAN");
});

test("deriveGate (#246): CI_RED alongside a decisive (MERGE_OK) verdict -> FIXABLE when enabled; still-pending CI (not red) stays WAIT", () => {
  assert.equal(deriveGate(gateInput({ ciGreen: false, ciRed: true })), "FIXABLE");
  assert.equal(deriveGate(gateInput({ ciGreen: false, ciRed: false })), "WAIT"); // still pending, unchanged
});

test("deriveGate (#246): prFixCap === 0 folds CI_RED straight to WAIT — byte-for-byte the pre-#246 behavior (ciRed didn't exist before, so WAIT was always the fold for ciGreen===false)", () => {
  assert.equal(deriveGate(gateInput({ ciGreen: false, ciRed: true, prFixCap: 0 })), "WAIT");
});

test("deriveGate (#246): ciGreen wins over ciRed when somehow both are set (belt-and-suspenders — a real rollup never reports both true)", () => {
  assert.equal(deriveGate(gateInput({ ciGreen: true, ciRed: true })), "MERGE");
});

test("deriveGate (#270): CONFLICTING routes before every review action, including born-conflicted zero-checks", () => {
  for (const reviewAction of ["WAIT_REVIEW", "HANDLE_THREADS", "MERGE_OK"] as const) {
    assert.equal(deriveGate(gateInput({ mergeable: "CONFLICTING", ciGreen: false, ciRed: false, reviewAction })), "FIXABLE", reviewAction);
  }
});

test("deriveGate (#270): conflict respects cap, human, hold, open, and draft precedence", () => {
  assert.equal(deriveGate(gateInput({ mergeable: "CONFLICTING", prFixCap: 0 })), "HUMAN");
  assert.equal(deriveGate(gateInput({ mergeable: "CONFLICTING", labels: ["needs-human"] })), "HUMAN");
  assert.equal(deriveGate(gateInput({ mergeable: "CONFLICTING", labels: ["hold"] })), "WAIT");
  assert.equal(deriveGate(gateInput({ mergeable: "CONFLICTING", prState: "CLOSED" })), "HUMAN");
  assert.equal(deriveGate(gateInput({ mergeable: "CONFLICTING", isDraft: true })), "HUMAN");
});

test("deriveGate (#270): UNKNOWN and every non-CONFLICTING route remain unchanged", () => {
  assert.equal(deriveGate(gateInput({ mergeable: "UNKNOWN" })), "MERGE");
  assert.equal(deriveGate(gateInput({ mergeable: "UNKNOWN", ciGreen: false })), "WAIT");
  assert.equal(deriveGate(gateInput({ mergeable: "MERGEABLE", reviewAction: "HANDLE_THREADS" })), "FIXABLE");
});

test("deriveGate (#246): FIXABLE still yields to prior fail-safe checks — draft/non-OPEN/human-label all outrank it", () => {
  assert.equal(deriveGate(gateInput({ reviewAction: "HANDLE_THREADS", isDraft: true })), "HUMAN");
  assert.equal(deriveGate(gateInput({ reviewAction: "HANDLE_THREADS", prState: "CLOSED" })), "HUMAN");
  assert.equal(deriveGate(gateInput({ reviewAction: "HANDLE_THREADS", labels: ["needs-human"] })), "HUMAN");
});

test("deriveGate (#246 review round 1, C5): the CI_RED branch (MERGE_OK + ciGreen:false + ciRed:true) ALSO yields to every prior fail-safe check — draft/non-OPEN/human-label all outrank it, same precedence as the HANDLE_THREADS branch above", () => {
  const ciRedInput = { ciGreen: false, ciRed: true, reviewAction: "MERGE_OK" as ReviewAction };
  assert.equal(deriveGate(gateInput({ ...ciRedInput, isDraft: true })), "HUMAN");
  assert.equal(deriveGate(gateInput({ ...ciRedInput, prState: "CLOSED" })), "HUMAN");
  assert.equal(deriveGate(gateInput({ ...ciRedInput, prState: "MERGED" })), "HUMAN");
  assert.equal(deriveGate(gateInput({ ...ciRedInput, labels: ["needs-human"] })), "HUMAN");
  assert.equal(deriveGate(gateInput({ ...ciRedInput, labels: ["blocked", "type:feature"] })), "HUMAN");
  // Sanity: with none of those present, it's genuinely FIXABLE (not accidentally HUMAN).
  assert.equal(deriveGate(gateInput(ciRedInput)), "FIXABLE");
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
  assert.equal(deriveGate(gateInput({ labels: ["Needs-Human"] })), "HUMAN");
  assert.equal(mergeDecision("MERGE_OK", "Needs-Human", "OPEN", false, HUMAN_LABELS), "ESCALATE");
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// #248: deriveGate — the hold (WAIT-tier) label, three-tier escalation model
// ─────────────────────────────────────────────────────────────────────────────────────────

test("deriveGate (#248): a hold label -> WAIT, even with MERGE_OK + CI green", () => {
  assert.equal(deriveGate(gateInput({ labels: ["hold"] })), "WAIT");
  assert.equal(deriveGate(gateInput({ labels: ["Hold", "type:feature"] })), "WAIT"); // case-insensitive, like humanLabels
});

test("deriveGate (#248): hold precedes review signals AND FIXABLE — WAIT regardless of the underlying verdict", () => {
  assert.equal(deriveGate(gateInput({ labels: ["hold"], reviewAction: "WAIT_REVIEW" })), "WAIT");
  assert.equal(deriveGate(gateInput({ labels: ["hold"], reviewAction: "HANDLE_THREADS" })), "WAIT"); // never FIXABLE
  assert.equal(deriveGate(gateInput({ labels: ["hold"], ciGreen: false, ciRed: true })), "WAIT"); // never FIXABLE (CI_RED path)
  assert.equal(deriveGate(gateInput({ labels: ["hold"], reviewAction: "REVIEW_UNAVAILABLE" })), "WAIT");
});

test("deriveGate (#248): hold + needs-human simultaneously -> HUMAN wins (escalation semantics, fail-safe)", () => {
  assert.equal(deriveGate(gateInput({ labels: ["hold", "needs-human"] })), "HUMAN");
  assert.equal(deriveGate(gateInput({ labels: ["hold", "blocked"] })), "HUMAN");
});

test("deriveGate (#248): hold still yields to the prior fail-safe checks — draft/non-OPEN outrank it too", () => {
  assert.equal(deriveGate(gateInput({ labels: ["hold"], isDraft: true })), "HUMAN");
  assert.equal(deriveGate(gateInput({ labels: ["hold"], prState: "CLOSED" })), "HUMAN");
  assert.equal(deriveGate(gateInput({ labels: ["hold"], prState: "MERGED" })), "HUMAN");
});

test("deriveGate (#248): no hold label configured (empty holdLabels) never fires WAIT-via-hold — sanity that hold is opt-in, not a hidden default", () => {
  assert.equal(deriveGate(gateInput({ labels: ["hold"], holdLabels: [] })), "MERGE"); // "hold" text present but nothing configured to match it
});

test("deriveGate (#248 review round 1, G3 hazard 1 — substring): holdLabels matches by EXACT identity, never substring — a short/generic entry does NOT hold every label sharing that substring", () => {
  // A single-word holdLabels entry like "sapwood" must NOT hold every sapwood:-prefixed PR —
  // only labelsIncludeAnySubstring (humanLabels' historical semantics) would do that.
  assert.equal(deriveGate(gateInput({ labels: ["sapwood:hold"], holdLabels: ["sapwood"] })), "MERGE");
  // Sanity: the SAME PR label matched by its OWN full, exact name still holds.
  assert.equal(deriveGate(gateInput({ labels: ["sapwood:hold"], holdLabels: ["sapwood:hold"] })), "WAIT");
});

test("deriveGate (#248 review round 1, G3 hazard 2 — empty entry): an empty/whitespace holdLabels entry never holds every PR — config load rejects it, but the pure function itself is safe if ever called with one directly", () => {
  assert.equal(deriveGate(gateInput({ labels: ["type:feature"], holdLabels: [""] })), "MERGE");
  assert.equal(deriveGate(gateInput({ labels: [], holdLabels: [""] })), "MERGE");
});

test("#248 review round 1 (G3): reviewSilenceDuration's holdLabelPresent input is exact-match at its OWN call site too (MergeDriver.driveOne) — a substring-only entry never suppresses the silence clock", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "WAIT_REVIEW", headOid: null };
  const driver = new MergeDriver({
    forge,
    reviewer,
    cfg: mkCfg({
      reviewer: { escalateAfterSec: 60 },
      labels: { needsHuman: "needs-human" },
      escalation: { humanLabels: HUMAN_LABELS, holdLabels: ["sapwood"] }, // deliberately a substring of the PR's real label below
    }),
    now: () => new Date("2026-07-15T00:02:00.000Z"),
  });
  const pin = { head: "HEAD", at: "2026-07-15T00:00:00.000Z" };
  forge.reviewData = { ...forge.reviewData, labels: ["sapwood:hold"] }; // NOT exactly "sapwood" — must not match
  const outcome = await driver.driveOne(7, 46, pin, noopRecord);
  assert.deepEqual(outcome, {
    kind: "queued",
    pr: 7,
    reason: "gate-pending:WAIT_REVIEW",
    reviewSilenceEscalation: { head: "HEAD", silenceSec: 120 }, // fires — the misconfigured substring never suppressed it
    holdObservation: { held: false }, // #294: same exact-match rule — the substring entry observes NOT held
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// 3) MergeDriver.driveOne — end-to-end with fakes (no real gh calls)
// ─────────────────────────────────────────────────────────────────────────────────────────

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
  merged: Array<[number, string]> = [];
  labelsAdded: Array<[number, string]> = [];
  prLabelsAdded: Array<[number, string]> = [];
  comments: Array<[number, string]> = [];
  changedFiles: Array<{ filename: string; previousFilename?: string }> = [];
  changedFilesErr: Error | null = null;
  calls: string[] = [];
  status: PRStatus = { number: 1, headOid: "HEAD", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  reviewData: PRReviewData = {
    headOid: "HEAD",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    reviews: [],
    unresolvedThreads: 0,
  };
  statusErr: Error | null = null;
  statusSequence: PRStatus[] = [];
  mergeErr: Error | null = null;

  override async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  override async getReadyIssues(): Promise<Issue[]> {
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
  override async addLabel(n: number, l: string): Promise<void> {
    this.labelsAdded.push([n, l]);
  }
  override async removeLabel(): Promise<void> {}
  override async addPRLabel(pr: number, label: string): Promise<void> {
    this.calls.push("add-pr-label");
    this.prLabelsAdded.push([pr, label]);
    this.reviewData = { ...this.reviewData, labels: [...this.reviewData.labels, label] };
  }
  override async openPR(): Promise<number> {
    return 1;
  }
  override async getPRStatus(): Promise<PRStatus> {
    this.calls.push("status");
    if (this.statusErr) throw this.statusErr;
    return this.statusSequence.shift() ?? this.status;
  }
  override async mergePR(pr: number, headOid: string): Promise<void> {
    this.calls.push("merge");
    if (this.mergeErr) throw this.mergeErr;
    this.merged.push([pr, headOid]);
  }
  override async addPRComment(pr: number, body: string): Promise<void> {
    this.calls.push("comment");
    this.comments.push([pr, body]);
  }
  override async addIssueComment(): Promise<void> {}
  override async getIssueBody(): Promise<string> {
    return "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  override async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
  }
  override async getPRReviewData(): Promise<PRReviewData> {
    this.calls.push("review-data");
    return this.reviewData;
  }
  override async getPRDiff(): Promise<string> {
    return "";
  }
  override async getPRChangedFiles() {
    this.calls.push("changed-files");
    if (this.changedFilesErr) throw this.changedFilesErr;
    return { files: this.changedFiles, complete: true };
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
  override async getIssueComments() {
    return [];
  }
  override async createIssue(): Promise<number> {
    return 0;
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
}

class FakeReviewer implements Reviewer {
  readonly kind = "different-model-codex" as const;
  triggered: number[] = [];
  triggeredWith: Array<[number, number]> = [];
  triggerContexts: Array<ReviewTriggerContext | undefined> = [];
  triggerErr: Error | null = null;
  verdict: ReviewVerdict = { action: "MERGE_OK", headOid: "HEAD", generationResponded: true, coverageEstablished: true };
  async triggerReview(_forge: IForge, pr: number, issue: number, context?: ReviewTriggerContext): Promise<void> {
    if (this.triggerErr) throw this.triggerErr;
    this.triggered.push(pr);
    this.triggeredWith.push([pr, issue]);
    this.triggerContexts.push(context);
  }
  verdictFromData(): ReviewVerdict {
    return this.verdict;
  }
}

const LEGACY_LABEL_CONFIG = {
  labels: {
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
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1 }, ...LEGACY_LABEL_CONFIG, ...over });

// #55 P1-B: driveOne now takes (pr, issue, triggerPin, recordTrigger). Most of the tests below
// are about the GATE/MERGE machinery downstream of the trigger check, not the trigger check
// itself — so they pass a pin that already matches FakeForge's default head ("HEAD"), which
// skips straight past the trigger branch exactly like the pre-#55 tests (that always assumed
// an already-triggered lane). The trigger-pin behavior itself is covered in its own section
// below ("review-trigger pin (#55 P1-B)").
const ALREADY_TRIGGERED = { head: "HEAD", at: "2020-01-01T00:00:00Z" };
const noopRecord = (_head: string, _at: string): void => {};
/** #403 (F25): a never-triggered lane's pin. driveOne takes a `ReviewTriggerPin`, not `null` —
 *  the engine reads these two null fields straight off the WorkerRow (conductor.ts), so this is
 *  the shape production actually passes, not a stand-in for it. */
const NEVER_TRIGGERED: ReviewTriggerPin = { head: null, at: null };

test("#292 MergeDriver: instruction-path change escalates once before review, then the exact PR-label latch suppresses all repeat writes", async () => {
  const forge = new FakeForge();
  forge.changedFiles = [{ filename: "src/new-name.md", previousFilename: "CLAUDE.md" }];
  const reviewer = new FakeReviewer();
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });

  const first = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(first.kind, "needs-human");
  assert.match(first.reason, /instruction-path-change:CLAUDE\.md/);
  assert.deepEqual(forge.prLabelsAdded, [[7, "needs-human"]]);
  assert.equal(forge.comments.length, 1);
  assert.match(forge.comments[0]?.[1] ?? "", /human-vetted reviewer authority.*#292/);
  assert.deepEqual(reviewer.triggered, []);

  const second = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(second.kind, "needs-human");
  assert.deepEqual(forge.prLabelsAdded, [[7, "needs-human"]]);
  assert.equal(forge.comments.length, 1);
  assert.equal(forge.calls.filter((call) => call === "changed-files").length, 1, "latched tick must not refetch files");
});

test("#292 MergeDriver: an existing needs-human label returns HUMAN before file fetch or review trigger", async () => {
  const forge = new FakeForge();
  forge.reviewData = { ...forge.reviewData, labels: ["needs-human"] };
  forge.changedFiles = [{ filename: "src/app.ts" }];
  const reviewer = new FakeReviewer();

  // For a needs-human-labeled PR that does not touch instruction paths, the terminal outcome is
  // unchanged from pre-#292 (needs-human); the latch deliberately avoids the wasted trigger.
  const outcome = await new MergeDriver({ forge, reviewer, cfg: mkCfg() }).driveOne(7, 46, NEVER_TRIGGERED, noopRecord);
  assert.deepEqual(outcome, { kind: "needs-human", pr: 7, reason: "gate:HUMAN:instruction-path-latch", holdObservation: { held: false } });
  assert.equal(forge.calls.includes("changed-files"), false);
  assert.deepEqual(reviewer.triggered, []);
  assert.deepEqual(forge.comments, []);
});

test("#292 MergeDriver regression pin: a non-matching PR keeps the pre-#292 merge outcome/call path, plus exactly one changed-files read", async () => {
  const forge = new FakeForge();
  forge.changedFiles = [{ filename: "src/app.ts" }];
  const outcome = await new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() }).driveOne(
    7,
    46,
    ALREADY_TRIGGERED,
    noopRecord,
  );
  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD", holdObservation: { held: false } });
  assert.deepEqual(forge.calls, ["status", "review-data", "changed-files", "merge"]);
  assert.deepEqual(forge.prLabelsAdded, []);
  assert.deepEqual(forge.comments, []);
});

test("#292 MergeDriver: changed-files read failure queues fail-closed before review or merge", async () => {
  const forge = new FakeForge();
  forge.changedFilesErr = new Error("rate limited");
  const reviewer = new FakeReviewer();
  const outcome = await new MergeDriver({ forge, reviewer, cfg: mkCfg() }).driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.reason, /instruction-path-files-unavailable.*rate limited/);
  assert.deepEqual(reviewer.triggered, []);
  assert.deepEqual(forge.merged, []);
});

test("#170 reviewSilenceDuration: non-decisive age, label latch, and failover window", () => {
  const base = {
    action: "WAIT_REVIEW" as ReviewAction,
    triggerPin: { head: "HEAD", at: "2026-07-14T00:00:00.000Z" },
    now: new Date("2026-07-15T00:00:00.000Z"),
    escalateAfterSec: 86400,
    needsHumanLabelPresent: false,
    holdLabelPresent: false,
    fallbackConfigured: false,
    failoverAfterSec: 1200,
  };
  assert.equal(reviewSilenceDuration(base), 86400);
  assert.equal(reviewSilenceDuration({ ...base, action: "REVIEW_UNAVAILABLE" }), 86400);
  assert.equal(reviewSilenceDuration({ ...base, action: "MERGE_OK" }), null);
  assert.equal(reviewSilenceDuration({ ...base, now: new Date("2026-07-14T23:59:59.000Z") }), null);
  assert.equal(reviewSilenceDuration({ ...base, needsHumanLabelPresent: true }), null);
  assert.equal(reviewSilenceDuration({ ...base, triggerPin: { head: "HEAD", at: null } }), null);
  assert.equal(
    reviewSilenceDuration({
      ...base,
      escalateAfterSec: 300,
      fallbackConfigured: true,
      failoverAfterSec: 1200,
      now: new Date("2026-07-14T00:10:00.000Z"),
    }),
    null,
  );
  assert.equal(
    reviewSilenceDuration({
      ...base,
      escalateAfterSec: 300,
      fallbackConfigured: true,
      failoverAfterSec: 1200,
      now: new Date("2026-07-14T00:20:00.000Z"),
    }),
    1200,
  );
});

test("#248 reviewSilenceDuration: a hold label provably suppresses the silence escalation, exactly like needsHumanLabelPresent", () => {
  const base = {
    action: "WAIT_REVIEW" as ReviewAction,
    triggerPin: { head: "HEAD", at: "2026-07-14T00:00:00.000Z" },
    now: new Date("2026-07-15T00:00:00.000Z"), // 86400s silence — well past escalateAfterSec
    escalateAfterSec: 86400,
    needsHumanLabelPresent: false,
    holdLabelPresent: false,
    fallbackConfigured: false,
    failoverAfterSec: 1200,
  };
  assert.equal(reviewSilenceDuration(base), 86400); // sanity: fires without a hold
  assert.equal(reviewSilenceDuration({ ...base, holdLabelPresent: true }), null); // suppressed while held
});

test("#248 reviewSilenceDuration: clock resumes on hold removal using the SAME trigger pin (no reset, no burst — a single fresh evaluation)", () => {
  const base = {
    action: "WAIT_REVIEW" as ReviewAction,
    triggerPin: { head: "HEAD", at: "2026-07-14T00:00:00.000Z" },
    now: new Date("2026-07-15T00:00:00.000Z"),
    escalateAfterSec: 86400,
    needsHumanLabelPresent: false,
    holdLabelPresent: true,
    fallbackConfigured: false,
    failoverAfterSec: 1200,
  };
  // Held: suppressed across repeated calls (pure function, no hidden accumulation of "missed"
  // escalations — calling it 3 times while held is identical to calling it once).
  assert.equal(reviewSilenceDuration(base), null);
  assert.equal(reviewSilenceDuration(base), null);
  assert.equal(reviewSilenceDuration(base), null);
  // Removed: the NEXT call resumes off the unchanged pin — the full elapsed silence (including
  // the time spent held) is what fires, not a re-started/zeroed count. This is the accepted,
  // documented tick-scale race window (docs/PLAN.md's escalation-model section): a SINGLE
  // decisive evaluation the instant the hold lifts, never a delayed or repeated one.
  assert.equal(reviewSilenceDuration({ ...base, holdLabelPresent: false }), 86400);
});

test("#170 MergeDriver: an aged silent current-head review signals once; a fresh head resets the clock", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "WAIT_REVIEW", headOid: null };
  const driver = new MergeDriver({
    forge,
    reviewer,
    cfg: mkCfg({
      reviewer: { escalateAfterSec: 60 },
      labels: { needsHuman: "needs-human" },
      escalation: { humanLabels: HUMAN_LABELS },
    }),
    now: () => new Date("2026-07-15T00:02:00.000Z"),
  });
  const pin = { head: "HEAD", at: "2026-07-15T00:00:00.000Z" };
  assert.deepEqual(await driver.driveOne(7, 46, pin, noopRecord), {
    kind: "queued",
    pr: 7,
    reason: "gate-pending:WAIT_REVIEW",
    reviewSilenceEscalation: { head: "HEAD", silenceSec: 120 },
    holdObservation: { held: false }, // #294
  });

  forge.reviewData = { ...forge.reviewData, labels: ["Needs-Human"] };
  const latched = await driver.driveOne(7, 46, pin, noopRecord);
  assert.equal(latched.kind, "needs-human");
  assert.equal(latched.reviewSilenceEscalation, undefined);

  forge.reviewData = { ...forge.reviewData, headOid: "FRESH", labels: [] };
  forge.status = { ...forge.status, headOid: "FRESH" };
  let recorded: [string, string] | null = null;
  const fresh = await driver.driveOne(7, 46, pin, (head, at) => {
    recorded = [head, at];
  });
  assert.equal(fresh.kind, "queued");
  assert.equal(fresh.reviewSilenceEscalation, undefined);
  assert.deepEqual(recorded, ["FRESH", "2026-07-15T00:02:00.000Z"]);
});

test("MergeDriver.driveOne (#248): a hold label on the PR -> queued (WAIT), even with MERGE_OK + CI green — no merge, and the engine writes nothing", async () => {
  const forge = new FakeForge();
  forge.reviewData = { ...forge.reviewData, labels: ["sapwood:hold"] };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(forge.merged, []);
  assert.deepEqual(forge.labelsAdded, []); // engine never writes a hold label, and never escalates one either
});

test("MergeDriver.driveOne (#248): #170 silence escalation is suppressed while a hold label stands on the PR, and resumes (single fresh evaluation) once removed", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "WAIT_REVIEW", headOid: null };
  const driver = new MergeDriver({
    forge,
    reviewer,
    cfg: mkCfg({
      reviewer: { escalateAfterSec: 60 },
      labels: { needsHuman: "needs-human" },
      escalation: { humanLabels: HUMAN_LABELS, holdLabels: HOLD_LABELS },
    }),
    now: () => new Date("2026-07-15T00:02:00.000Z"),
  });
  const pin = { head: "HEAD", at: "2026-07-15T00:00:00.000Z" };
  forge.reviewData = { ...forge.reviewData, labels: ["hold"] };

  // Held: the silence clock never fires, and — because the gate itself is now WAIT-via-hold —
  // the outcome is queued exactly like the ordinary WAIT_REVIEW path, just with no signal.
  const held = await driver.driveOne(7, 46, pin, noopRecord);
  assert.equal(held.kind, "queued");
  assert.equal(held.reviewSilenceEscalation, undefined);

  // Hold removed (same pin, same elapsed 120s past the 60s threshold): the very next call
  // resumes and fires — a single fresh evaluation, not a burst of pent-up escalations.
  forge.reviewData = { ...forge.reviewData, labels: [] };
  const resumed = await driver.driveOne(7, 46, pin, noopRecord);
  assert.deepEqual(resumed, {
    kind: "queued",
    pr: 7,
    reason: "gate-pending:WAIT_REVIEW",
    reviewSilenceEscalation: { head: "HEAD", silenceSec: 120 },
    holdObservation: { held: false }, // #294: the release is observable on this very pass
  });
});

// ── #294: hold-visibility — driveOne's STATELESS per-pass hold observation ────────────────
// The signal only; the transition/dedupe into pr-held / pr-released events is conductor.ts's
// (conductor.test.ts covers that half), exactly as #54's reviewerTransition is split.

test("MergeDriver.driveOne (#294): a hold label gating the PR is reported as a stateless observation carrying the label, alongside the unchanged WAIT outcome", async () => {
  const forge = new FakeForge();
  forge.reviewData = { ...forge.reviewData, labels: ["type:feature", "Sapwood:Hold"] };
  const driver = new MergeDriver({
    forge,
    reviewer: new FakeReviewer(),
    cfg: mkCfg({ escalation: { humanLabels: HUMAN_LABELS, holdLabels: ["sapwood:hold"] } }),
  });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  // Gate behavior is untouched (#294 AC): still the plain #248 WAIT, still no merge, no writes.
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(forge.merged, []);
  assert.deepEqual(forge.labelsAdded, []);
  // On-PR casing, so the event payload names the label the human actually applied.
  assert.deepEqual(outcome.holdObservation, { held: true, label: "Sapwood:Hold" });
});

test("MergeDriver.driveOne (#294): an unheld PR reports the NOT-held observation on every pass — the release transition is only detectable because the negative case is reported too", async () => {
  const forge = new FakeForge();
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "merged"); // an unheld, green, approved PR still merges — unchanged
  assert.deepEqual(outcome.holdObservation, { held: false });
});

test("MergeDriver.driveOne (#294, Codex P2): a held PR that is ALSO merge-conflicted still reports the observation — the conflict branch's early return must not blind the whole hold episode", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, mergeable: "CONFLICTING" };
  forge.reviewData = { ...forge.reviewData, labels: ["Sapwood:Hold"] };
  const driver = new MergeDriver({
    forge,
    reviewer: new FakeReviewer(),
    cfg: mkCfg({ escalation: { humanLabels: HUMAN_LABELS, holdLabels: ["sapwood:hold"] } }),
  });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /merge-conflict-held/);
  assert.deepEqual(outcome.holdObservation, { held: true, label: "Sapwood:Hold" });
});

test("MergeDriver.driveOne (#294): the observation is exact-match, like the gate it mirrors — a substring-only configured entry reports NOT held (never a phantom hold event)", async () => {
  const forge = new FakeForge();
  forge.reviewData = { ...forge.reviewData, labels: ["sapwood:hold"] };
  const driver = new MergeDriver({
    forge,
    reviewer: new FakeReviewer(),
    // "sapwood" is a substring of the PR's real label, but not an exact match — the #248 G3 rule.
    cfg: mkCfg({ escalation: { humanLabels: HUMAN_LABELS, holdLabels: ["sapwood"] } }),
  });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.deepEqual(outcome.holdObservation, { held: false });
  assert.equal(outcome.kind, "merged"); // and the gate agrees: not held
});

test("MergeDriver.driveOne: gates pass (CI green + MERGE_OK) -> merges with the PINNED head oid", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD", holdObservation: { held: false } });
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

test("MergeDriver.driveOne (#246 review round 1, C4): SPLIT-STATE observation (CI read saw CLOSED, review read a stale OPEN, SAME head) -> queued, never derives a gate from the stale read", async () => {
  const forge = new FakeForge();
  // Closing a PR doesn't move its head — the head-agreement check alone can't catch this class.
  // reviewData.state predates the close (a moment-earlier read); status.state is fresh.
  forge.status = { ...forge.status, state: "CLOSED" };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /gate-state-mismatch/);
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne (#246 review round 1, C4): a COHERENT CLOSED (both reads agree) still falls through unchanged to deriveGate's own needs-human rule — the new check only catches DISAGREEMENT", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, state: "CLOSED" };
  forge.reviewData = { ...forge.reviewData, state: "CLOSED" };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne (#246 review round 1, C4): SPLIT-STATE also blocks a FIXABLE (HANDLE_THREADS) verdict against a stale-OPEN, actually-CLOSED PR — never dispatches a fix leg against a closed PR", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "HANDLE_THREADS", headOid: "HEAD" };
  forge.status = { ...forge.status, state: "CLOSED" };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /gate-state-mismatch/);
});

test("MergeDriver.driveOne: PR already MERGED (by a human) -> merged outcome, not needs-human (Codex PR #42 P2)", async () => {
  // produce-pr-and-stop's designed happy path: lane stays driving, human merges, next tick
  // must classify the lane as done — not mark the worker failed with a needs-human label.
  const forge = new FakeForge();
  forge.status = { ...forge.status, state: "MERGED" };
  forge.reviewData = { ...forge.reviewData, state: "MERGED" };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD", holdObservation: { held: false } });
  assert.deepEqual(forge.merged, []); // recognized as merged; no second merge attempt
});

test("MergeDriver.driveOne (#294, Codex P2 round 2): a manually-merged PR still carrying its hold label reports NOT held — terminal outcome, the episode closes with pr-released instead of dangling", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, state: "MERGED" };
  forge.reviewData = { ...forge.reviewData, state: "MERGED", labels: ["Sapwood:Hold"] };
  const driver = new MergeDriver({
    forge,
    reviewer: new FakeReviewer(),
    cfg: mkCfg({ escalation: { humanLabels: HUMAN_LABELS, holdLabels: ["sapwood:hold"] } }),
  });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "merged");
  assert.deepEqual(outcome.holdObservation, { held: false });
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

test("MergeDriver.driveOne (#270): born-CONFLICTING zero-check PR -> conflict FIXABLE before review trigger or CI", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, mergeable: "CONFLICTING", ciGreen: false, ciRed: false };
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "WAIT_REVIEW", headOid: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, { head: null, at: null }, noopRecord);
  assert.deepEqual(outcome, {
    kind: "fixable",
    pr: 7,
    reason: "gate:FIXABLE:merge-conflict",
    prescription: "conflict",
    holdObservation: { held: false },
  });
  assert.deepEqual(forge.comments, [], "moot review is never triggered on a conflicting head");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne (#270): conflict + standing findings chooses the single-purpose conflict route", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, mergeable: "CONFLICTING", ciGreen: false, ciRed: true };
  forge.reviewData = { ...forge.reviewData, unresolvedThreads: 3 };
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "HANDLE_THREADS", headOid: "HEAD" };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "fixable");
  assert.equal((outcome as { prescription?: string }).prescription, "conflict");
  assert.match((outcome as { reason: string }).reason, /merge-conflict/);
  assert.doesNotMatch((outcome as { reason: string }).reason, /HANDLE_THREADS/);
});

test("MergeDriver.driveOne (#270): prFixCap:0 escalates conflict; produce-pr-and-stop only reports FIXABLE", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, mergeable: "CONFLICTING", ciGreen: false };
  const human = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg({ lanes: { prFixCap: 0 } }) });
  assert.equal((await human.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord)).kind, "needs-human");
  const stop = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg({ merge: { mode: "produce-pr-and-stop" } }) });
  const stopped = await stop.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(stopped.kind, "stopped");
  assert.match((stopped as { reason: string }).reason, /FIXABLE:merge-conflict/);
  assert.deepEqual(forge.merged, []);
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

test("MergeDriver.driveOne (#270 F6): deterministic merge failure + fresh CONFLICTING -> queued for the normal conflict route", async () => {
  const forge = new FakeForge();
  forge.statusSequence = [forge.status, { ...forge.status, mergeable: "CONFLICTING" }];
  forge.mergeErr = new Error("Pull Request is not mergeable");
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /merge-failed-conflict-recheck/);
});

test("MergeDriver.driveOne (#270 F6): deterministic merge failure + fresh MERGEABLE -> needs-human, no infinite retry", async () => {
  const forge = new FakeForge();
  forge.statusSequence = [forge.status, forge.status];
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

test("MergeDriver.driveOne (#246): unresolved findings (HANDLE_THREADS) -> fixable (fix loop enabled by default), never merges, never labels", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "HANDLE_THREADS", headOid: "HEAD" };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "fixable");
  assert.match((outcome as { reason: string }).reason, /HANDLE_THREADS/);
  assert.deepEqual(forge.merged, []);
  assert.deepEqual(forge.labelsAdded, []); // driveOne itself never labels — the caller (conductor.ts) owns escalation
});

test("MergeDriver.driveOne (#246): prFixCap: 0 -> unresolved findings (HANDLE_THREADS) still needs-human, byte-for-byte the pre-#246 path", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "HANDLE_THREADS", headOid: "HEAD" };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg({ lanes: { prFixCap: 0 } }) });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "needs-human");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne (#246): CI_RED alongside MERGE_OK -> fixable; produce-pr-and-stop mode reports it without dispatch (gates report, never act)", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, ciGreen: false, ciRed: true };
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "fixable");
  assert.match((outcome as { reason: string }).reason, /ciRed=true/);

  const stopDriver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg({ merge: { mode: "produce-pr-and-stop" } }) });
  const stopped = await stopDriver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(stopped.kind, "stopped");
  assert.match((stopped as { reason: string }).reason, /FIXABLE/);
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne (#246): produce-pr-and-stop + HANDLE_THREADS -> stopped (reports FIXABLE), never dispatches, never labels", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "HANDLE_THREADS", headOid: "HEAD" };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg({ merge: { mode: "produce-pr-and-stop" } }) });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "stopped");
  assert.deepEqual(forge.merged, []);
  assert.deepEqual(forge.labelsAdded, []);
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

// ── #147 P1 (Codex PR #151): re-entry review-freshness cutoff — a re-entered (GATED RECLAIM)
// lane's gate② counts only reviews submitted AFTER the recorded trigger pin's `at`. These use
// the real CodexReviewer (FakeReviewer ignores the review data, so the filter would be
// invisible through it). Pin cutoff: 2026-07-02T00:00:00.000Z. ──────────────────────────────

const REENTRY_PIN = { head: "HEAD", at: "2026-07-02T00:00:00.000Z" };
const codexReview = (submittedAt?: string) => ({
  author: "chatgpt-codex-connector",
  commitOid: "HEAD",
  state: "COMMENTED",
  ...(submittedAt !== undefined ? { submittedAt } : {}),
});

test("MergeDriver.driveOne reentered: a STALE review (submitted before the pin) is filtered out -> WAIT_REVIEW, queued, never merged", async () => {
  const forge = new FakeForge();
  forge.reviewData = { ...forge.reviewData, reviews: [codexReview("2026-07-01T00:00:00Z")] };
  const driver = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, REENTRY_PIN, noopRecord, undefined, true);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /gate-pending:WAIT_REVIEW/);
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne reentered: a FRESH review (submitted after the pin) counts -> merged", async () => {
  const forge = new FakeForge();
  forge.reviewData = { ...forge.reviewData, reviews: [codexReview("2026-07-02T00:05:00Z")] };
  const driver = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, REENTRY_PIN, noopRecord, undefined, true);
  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD", holdObservation: { held: false } });
});

test("MergeDriver.driveOne reentered: a review with NO submittedAt can never prove freshness -> filtered (fail-closed), queued", async () => {
  const forge = new FakeForge();
  forge.reviewData = { ...forge.reviewData, reviews: [codexReview()] }; // pre-#147 fixture shape
  const driver = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, REENTRY_PIN, noopRecord, undefined, true);
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne NOT reentered (param omitted): the same pre-pin review still counts — non-reentry gate② semantics unchanged", async () => {
  const forge = new FakeForge();
  forge.reviewData = { ...forge.reviewData, reviews: [codexReview("2026-07-01T00:00:00Z")] };
  const driver = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, REENTRY_PIN, noopRecord);
  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD", holdObservation: { held: false } });
});

test("MergeDriver.driveOne reentered (round-2 P1): a STANDING pre-reentry human CHANGES_REQUESTED skips the time filter — a fresh post-pin clean Codex review cannot speak for it, so the lane re-escalates, never merges", async () => {
  const forge = new FakeForge();
  forge.reviewData = {
    ...forge.reviewData,
    reviews: [
      // A HUMAN's undismissed change request on the CURRENT head, left before the re-entry.
      { author: "hank-human", commitOid: "HEAD", state: "CHANGES_REQUESTED", submittedAt: "2026-07-01T00:00:00Z" },
      // The fresh post-pin clean Codex COMMENTED — an accept signal from a DIFFERENT reviewer,
      // which must NOT override hank's standing block.
      codexReview("2026-07-02T00:05:00Z"),
    ],
  };
  // #246: prFixCap: 0 isolates this test to the STANDING-CR filter itself (this test's actual
  // concern) — with the fix loop enabled, HANDLE_THREADS now routes to FIXABLE, not needs-human;
  // that routing is covered on its own by the dedicated #246 driveOne/deriveGate tests above.
  const driver = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg({ lanes: { prFixCap: 0 } }) });
  const outcome = await driver.driveOne(7, 46, REENTRY_PIN, noopRecord, undefined, true);
  assert.equal(outcome.kind, "needs-human");
  assert.match((outcome as { reason: string }).reason, /HANDLE_THREADS/);
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne reentered (round-2 P1): a pre-reentry CR already CLEARED by the same author's pre-reentry APPROVED is no standing block — the filter applies and the stale APPROVED does NOT merge, lane queues for the fresh review", async () => {
  const forge = new FakeForge();
  forge.reviewData = {
    ...forge.reviewData,
    reviews: [
      // alice requested changes, then approved — both BEFORE the re-entry. Her standing state
      // is cleared (per-author semantics), so phase 1 finds no block; phase 2's filter then
      // drops both as stale. Crucially, alice is a TRUSTED login here: if the filter were
      // skipped, her stale APPROVED would satisfy gate② and merge — the original stale-accept
      // hole. It must instead queue for the fresh post-reentry review.
      { author: "alice", commitOid: "HEAD", state: "CHANGES_REQUESTED", submittedAt: "2026-07-01T00:00:00Z" },
      { author: "alice", commitOid: "HEAD", state: "APPROVED", submittedAt: "2026-07-01T01:00:00Z" },
    ],
  };
  const driver = new MergeDriver({ forge, reviewer: new CodexReviewer(["alice"]), cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, REENTRY_PIN, noopRecord, undefined, true);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /gate-pending:WAIT_REVIEW/);
  assert.deepEqual(forge.merged, []);
});

// ── review-trigger pin (#55 P1-B): the trigger decision now lives IN driveOne, at the point
// the head is known, replacing the old once-per-lane MergeDriver.ensureTriggered (removed) ──

test("MergeDriver.driveOne: no trigger recorded yet (pin.head === null) -> posts the trigger, records {head, now}, and queues (never gates this tick)", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const recorded: Array<[string, string]> = [];
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg(), now: () => new Date("2026-07-07T08:00:00Z") });
  const outcome = await driver.driveOne(7, 46, { head: null, at: null }, (h, a) => recorded.push([h, a]));
  assert.deepEqual(outcome, { kind: "queued", pr: 7, reason: "review-triggered", holdObservation: { held: false } });
  assert.deepEqual(reviewer.triggeredWith, [[7, 46]]); // issue #46 threaded through
  assert.deepEqual(reviewer.triggerContexts, [{ head: "HEAD", baseHead: null }]);
  assert.deepEqual(recorded, [["HEAD", "2026-07-07T08:00:00.000Z"]]);
  assert.deepEqual(forge.merged, []); // never gates/merges on the SAME tick as the trigger
});

test("MergeDriver.driveOne #273: unanswered prior head re-triggers with a full PR review, not an uncovered delta", async () => {
  const forge = new FakeForge(); // forge.status/reviewData default headOid: "HEAD"
  const reviewer = new FakeReviewer();
  const recorded: Array<[string, string]> = [];
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg(), now: () => new Date("2026-07-07T09:00:00Z") });
  const outcome = await driver.driveOne(7, 46, { head: "OLD_HEAD", at: "2026-07-07T07:00:00Z" }, (h, a) => recorded.push([h, a]));
  assert.deepEqual(outcome, { kind: "queued", pr: 7, reason: "review-triggered", holdObservation: { held: false } });
  assert.deepEqual(recorded, [["HEAD", "2026-07-07T09:00:00.000Z"]]);
  assert.deepEqual(reviewer.triggerContexts, [{ head: "HEAD", baseHead: null }]);
});

test("MergeDriver.driveOne #273: a prior head with trusted recorded coverage permits a delta trigger", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  await driver.driveOne(
    7,
    46,
    { head: "OLD_HEAD", at: "2026-07-07T07:00:00Z", generation: 1, coveredHead: "OLD_HEAD", deltaChain: 0 },
    noopRecord,
  );
  assert.deepEqual(reviewer.triggerContexts, [{ head: "HEAD", baseHead: "OLD_HEAD" }]);
});

test("MergeDriver.driveOne #273: third-party CHANGES_REQUESTED never buys delta coverage", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, headOid: "H1" };
  forge.reviewData = {
    ...forge.reviewData,
    headOid: "H1",
    reviews: [{ author: "random-account", commitOid: "H1", state: "CHANGES_REQUESTED", submittedAt: "2026-07-07T08:01:00Z" }],
  };
  const reviewer = new CodexReviewer([]);
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  let covered = true;
  await driver.driveOne(
    7,
    46,
    { head: "H1", at: "2026-07-07T08:00:00Z", generation: 1, inFlight: true },
    noopRecord,
    undefined,
    false,
    (_head, _generation, coverageEstablished) => {
      covered = coverageEstablished;
    },
  );
  assert.equal(covered, false);

  forge.status = { ...forge.status, headOid: "H2" };
  forge.reviewData = { ...forge.reviewData, headOid: "H2", reviews: [] };
  const triggerReviewer = new FakeReviewer();
  await new MergeDriver({ forge, reviewer: triggerReviewer, cfg: mkCfg() }).driveOne(
    7,
    46,
    { head: "H1", at: "2026-07-07T08:00:00Z", generation: 1, inFlight: false, coveredHead: null },
    noopRecord,
  );
  assert.deepEqual(triggerReviewer.triggerContexts, [{ head: "H2", baseHead: null }]);
});

test("MergeDriver.driveOne #273: after deltaChainMax consecutive deltas, the next head trigger is full-PR and resets the chain", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const recorded: unknown[] = [];
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg({ reviewer: { deltaChainMax: 3 } }) });
  const pin = {
    head: "H3",
    at: "2026-07-07T07:00:00Z",
    generation: 4,
    ambiguous: true,
    deltaChain: 3,
    inFlight: true,
    coveredHead: "H3",
  };
  await driver.driveOne(7, 46, pin, (_head, _at, meta) => recorded.push(meta));
  assert.deepEqual(reviewer.triggerContexts, [{ head: "HEAD", baseHead: null }]);
  assert.deepEqual(recorded, [{ generation: 5, ambiguous: true, deltaChain: 0, inFlight: true }]);
});

test("MergeDriver.driveOne (#270): mid-review conflict wins next tick; resolved push re-triggers and only the fresh-head review merges", async () => {
  const forge = new FakeForge();
  const driver = new MergeDriver({
    forge,
    reviewer: new CodexReviewer([]),
    cfg: mkCfg(),
    now: () => new Date("2026-07-19T01:00:00Z"),
  });
  const oldPin = { head: "HEAD", at: "2026-07-19T00:00:00Z", generation: 1, ambiguous: false, deltaChain: 0, inFlight: true };

  assert.equal((await driver.driveOne(7, 46, oldPin, noopRecord)).kind, "queued", "review is initially pending");
  forge.status = { ...forge.status, mergeable: "CONFLICTING" };
  forge.reviewData = {
    ...forge.reviewData,
    reviews: [{ author: CODEX_REVIEWER_LOGINS[0], commitOid: "HEAD", state: "COMMENTED", submittedAt: "2026-07-19T00:30:00Z" }],
  };
  const conflicted = await driver.driveOne(7, 46, oldPin, noopRecord);
  assert.equal(conflicted.kind, "fixable", "conflict supersedes the now-moot accepted review");
  assert.equal((conflicted as { prescription?: string }).prescription, "conflict");

  forge.status = { ...forge.status, headOid: "RESOLVED", mergeable: "MERGEABLE", ciGreen: true };
  forge.reviewData = { ...forge.reviewData, headOid: "RESOLVED" };
  const recorded: Array<[string, string, unknown]> = [];
  assert.equal((await driver.driveOne(7, 46, oldPin, (h, at, meta) => recorded.push([h, at, meta]))).kind, "queued");
  assert.deepEqual(
    recorded,
    [["RESOLVED", "2026-07-19T01:00:00.000Z", { generation: 2, ambiguous: true, deltaChain: 0, inFlight: true }]],
    "a response that arrived only while conflict handling bypassed verdict recording establishes no coverage, so the next trigger is full",
  );

  const newPin = {
    head: "RESOLVED",
    at: "2026-07-19T01:00:00.000Z",
    generation: 2,
    ambiguous: true,
    deltaChain: 0,
    inFlight: true,
  };
  forge.reviewData = {
    ...forge.reviewData,
    comments: [
      {
        login: `${CODEX_REVIEWER_LOGINS[0]}[bot]`,
        createdAt: "2026-07-19T01:01:00Z",
        body: "Codex Review: Didn't find any major issues.",
      },
    ],
  };
  assert.equal(
    (await driver.driveOne(7, 46, newPin, noopRecord)).kind,
    "queued",
    "a delayed OID-less H1 response posted after the H2 trigger cannot satisfy the ambiguous H2 generation",
  );
  forge.reviewData = {
    ...forge.reviewData,
    reviews: [
      ...forge.reviewData.reviews,
      { author: CODEX_REVIEWER_LOGINS[0], commitOid: "RESOLVED", state: "COMMENTED", submittedAt: "2026-07-19T01:05:00Z" },
    ],
  };
  assert.equal((await driver.driveOne(7, 46, newPin, noopRecord)).kind, "merged");
  assert.deepEqual(forge.merged, [[7, "RESOLVED"]]);
});

test("MergeDriver.driveOne: pin matches the CURRENT head -> no re-trigger, proceeds straight to gating", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.deepEqual(reviewer.triggered, []); // no fresh trigger posted
  assert.equal(outcome.kind, "merged"); // gate ran normally and merged
});

test("MergeDriver.driveOne #273: a decisive current-generation verdict closes the in-flight marker even while CI still waits", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, ciGreen: false };
  const recorded: Array<[string, number]> = [];
  const driver = new MergeDriver({ forge, reviewer: new FakeReviewer(), cfg: mkCfg() });
  const outcome = await driver.driveOne(
    7,
    46,
    { ...ALREADY_TRIGGERED, generation: 4, inFlight: true },
    noopRecord,
    undefined,
    false,
    (head, generation) => recorded.push([head, generation]),
  );
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(recorded, [["HEAD", 4]]);
});

test("MergeDriver.driveOne P1: stale threads cannot close H2; H3 stays ambiguous and rejects a delayed OID-less H2 comment", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, headOid: "H2" };
  forge.reviewData = { ...forge.reviewData, headOid: "H2", unresolvedThreads: 2 };
  const driver = new MergeDriver({
    forge,
    reviewer: new CodexReviewer([]),
    cfg: mkCfg(),
    now: () => new Date("2026-07-19T02:00:00Z"),
  });
  const h2Pin = {
    head: "H2",
    at: "2026-07-19T01:00:00Z",
    generation: 2,
    ambiguous: false,
    deltaChain: 1,
    inFlight: true,
  };
  const closed: Array<[string, number]> = [];
  assert.equal((await driver.driveOne(7, 46, h2Pin, noopRecord, undefined, false, (h, g) => closed.push([h, g]))).kind, "fixable");
  assert.deepEqual(closed, [], "bare PR-wide threads are not a response attributable to trigger(H2)");

  forge.status = { ...forge.status, headOid: "H3" };
  forge.reviewData = { ...forge.reviewData, headOid: "H3", unresolvedThreads: 0 };
  let h3Meta: { generation: number; ambiguous: boolean; deltaChain: number; inFlight: boolean } | undefined;
  assert.equal((await driver.driveOne(7, 46, h2Pin, (_h, _at, meta) => (h3Meta = meta))).kind, "queued");
  assert.equal(h3Meta?.ambiguous, true);

  const h3Pin = { head: "H3", at: "2026-07-19T02:00:00.000Z", ...h3Meta };
  forge.reviewData = {
    ...forge.reviewData,
    comments: [
      {
        login: `${CODEX_REVIEWER_LOGINS[0]}[bot]`,
        createdAt: "2026-07-19T02:01:00Z",
        body: "Codex Review: Didn't find any major issues.",
      },
    ],
  };
  const delayed = await driver.driveOne(7, 46, h3Pin, noopRecord);
  assert.equal(delayed.kind, "queued");
  assert.match((delayed as { reason: string }).reason, /WAIT_REVIEW/);
});

test("MergeDriver.driveOne P1: a formal H2 response closes in-flight but generation 3 still rejects delayed OID-less artifacts", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, headOid: "H2", ciGreen: false };
  forge.reviewData = {
    ...forge.reviewData,
    headOid: "H2",
    reviews: [
      {
        author: CODEX_REVIEWER_LOGINS[0],
        commitOid: "H2",
        state: "DISMISSED",
        submittedAt: "2026-07-19T01:01:00Z",
      },
    ],
  };
  const driver = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg() });
  const h2Pin = {
    head: "H2",
    at: "2026-07-19T01:00:00Z",
    generation: 2,
    ambiguous: false,
    deltaChain: 1,
    inFlight: true,
  };
  let h2Closed = false;
  let h2Covered = false;
  await driver.driveOne(7, 46, h2Pin, noopRecord, undefined, false, (_head, _generation, coverage) => {
    h2Closed = true;
    h2Covered = coverage;
  });
  assert.equal(h2Closed, true);
  assert.equal(h2Covered, true);

  forge.status = { ...forge.status, headOid: "H3" };
  forge.reviewData = { ...forge.reviewData, headOid: "H3", reviews: [] };
  let h3Meta: { generation: number; ambiguous: boolean; deltaChain: number; inFlight: boolean } | undefined;
  await driver.driveOne(7, 46, { ...h2Pin, inFlight: false, coveredHead: "H2" }, (_h, _at, meta) => {
    h3Meta = meta;
  });
  assert.equal(h3Meta?.ambiguous, false);

  forge.reviewData = {
    ...forge.reviewData,
    comments: [
      {
        login: `${CODEX_REVIEWER_LOGINS[0]}[bot]`,
        createdAt: "2026-07-19T02:01:00Z",
        body: "Codex Review: Didn't find any major issues.",
      },
    ],
  };
  const delayed = await driver.driveOne(7, 46, { head: "H3", at: "2026-07-19T02:00:00Z", ...h3Meta }, noopRecord);
  assert.equal(delayed.kind, "queued");
  assert.match((delayed as { reason: string }).reason, /WAIT_REVIEW/);
});

test("MergeDriver.driveOne #273: trusted coverage can land after another response already closed in-flight", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, headOid: "H2", ciGreen: false };
  forge.reviewData = {
    ...forge.reviewData,
    headOid: "H2",
    reviews: [
      {
        author: CODEX_REVIEWER_LOGINS[0],
        commitOid: "H2",
        state: "DISMISSED",
        submittedAt: "2026-07-19T01:01:00Z",
      },
    ],
  };
  let recorded: [string, number, boolean] | undefined;
  await new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg() }).driveOne(
    7,
    46,
    { head: "H2", at: "2026-07-19T01:00:00Z", generation: 2, inFlight: false },
    noopRecord,
    undefined,
    false,
    (head, generation, coverage) => {
      recorded = [head, generation, coverage];
    },
  );
  assert.deepEqual(recorded, ["H2", 2, true]);
});

test("MergeDriver.driveOne #273: pin-cleared re-entry preserves strict generation correlation", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, headOid: "H2" };
  forge.reviewData = { ...forge.reviewData, headOid: "H2" };
  const driver = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg(), now: () => new Date("2026-07-19T03:00:00Z") });
  let meta: { generation: number; ambiguous: boolean; deltaChain: number; inFlight: boolean } | undefined;
  await driver.driveOne(7, 46, { head: null, at: null, generation: 2, coveredHead: "H1" }, (_h, _at, next) => {
    meta = next;
  });
  assert.equal(meta?.generation, 3);

  forge.reviewData = {
    ...forge.reviewData,
    comments: [
      {
        login: `${CODEX_REVIEWER_LOGINS[0]}[bot]`,
        createdAt: "2026-07-19T03:01:00Z",
        body: "Codex Review: Didn't find any major issues.",
      },
    ],
  };
  const outcome = await driver.driveOne(7, 46, { head: "H2", at: "2026-07-19T03:00:00Z", ...meta }, noopRecord, undefined, true);
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /WAIT_REVIEW/);
});

test("MergeDriver.driveOne: a trigger-post failure (rate-limit/network) -> queued, never throws, and NO pin is recorded (round-2 P2)", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.triggerErr = new Error("gh: API rate limit exceeded");
  const recorded: Array<[string, string]> = [];
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg() });
  const outcome = await driver.driveOne(7, 46, { head: null, at: null }, (h, a) => recorded.push([h, a]));
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /review-trigger-failed/);
  assert.deepEqual(recorded, [] as ReviewFallbackLock[]); // no pin recorded for a trigger that never posted
  assert.deepEqual(forge.merged, []);
});

test("MergeDriver.driveOne: head change mid-drive re-triggers exactly once per new head, one drive call at a time", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg(), now: () => new Date("2026-07-07T10:00:00Z") });
  let pin = { head: null as string | null, at: null as string | null };
  const record = (h: string, a: string) => {
    pin = { head: h, at: a };
  };

  // Tick 1: never triggered -> triggers for "HEAD", queues.
  const t1 = await driver.driveOne(7, 46, pin, record);
  assert.deepEqual(t1, { kind: "queued", pr: 7, reason: "review-triggered", holdObservation: { held: false } });
  assert.deepEqual(pin, { head: "HEAD", at: "2026-07-07T10:00:00.000Z" });

  // Tick 2: pin matches -> no re-trigger, gates through to merge.
  const t2 = await driver.driveOne(7, 46, pin, record);
  assert.equal(t2.kind, "merged");
  assert.equal(reviewer.triggered.length, 1); // still exactly once

  // A push moves the head; tick 3 must re-trigger exactly once for the NEW head, then queue.
  forge.status = { ...forge.status, headOid: "HEAD2" };
  forge.reviewData = { ...forge.reviewData, headOid: "HEAD2" };
  const t3 = await driver.driveOne(7, 46, pin, record);
  assert.deepEqual(t3, { kind: "queued", pr: 7, reason: "review-triggered", holdObservation: { held: false } });
  assert.deepEqual(pin, { head: "HEAD2", at: "2026-07-07T10:00:00.000Z" });
  assert.equal(reviewer.triggered.length, 2); // one more trigger, not a flood
});

// A helper type check so the reason field is always present on non-merged/stopped outcomes.
void ((): DriveOutcome => ({ kind: "queued", pr: 1, reason: "x" }));

// ─────────────────────────────────────────────────────────────────────────────────────────
// 4) Reviewer failover (#54): MergeDriver.driveOne wired to resolveReviewVerdict
// ─────────────────────────────────────────────────────────────────────────────────────────

/** A Reviewer stand-in with a fixed kind + scripted verdict (unlike FakeReviewer, whose kind
 *  is pinned to "different-model-codex") — lets these tests build a fallback chain. */
class ScriptedReviewer implements Reviewer {
  constructor(
    readonly kind: Reviewer["kind"],
    private readonly action: ReviewAction,
  ) {}
  async triggerReview(): Promise<void> {}
  verdictFromData(): ReviewVerdict {
    return { action: this.action, headOid: this.action === "REVIEW_UNAVAILABLE" ? null : "HEAD" };
  }
}

const NO_LOCK: ReviewFallbackLock = { head: null, kind: null };
const noopRecordFallback = (_lock: { head: string | null; kind: string | null }): void => {};
// Triggered long before "now" (2026-07-07T09:00:00Z, 1h later — well past the default
// failoverAfterSec, and past every explicit failoverAfterSec used below).
const TRIGGERED_LONG_AGO = { head: "HEAD", at: "2026-07-07T08:00:00Z" };
const NOW = () => new Date("2026-07-07T09:00:00Z");

test("MergeDriver.driveOne: no fallback wired (5th arg omitted) -> byte-for-byte the pre-#54 behavior", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "REVIEW_UNAVAILABLE", headOid: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkCfg(), now: NOW });
  const outcome = await driver.driveOne(7, 46, TRIGGERED_LONG_AGO, noopRecord);
  assert.equal(outcome.kind, "queued");
  assert.equal(outcome.reviewerTransition, undefined);
  assert.deepEqual(forge.comments, []);
});

test("MergeDriver.driveOne: fallback configured but reviewer.failoverAfterSec not yet reached -> still queues on the primary, no switch", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "WAIT_REVIEW", headOid: "HEAD" };
  const fallbackReviewers = [new ScriptedReviewer("human", "MERGE_OK")];
  const cfg = mkCfg({ reviewer: { fallback: ["human"], failoverAfterSec: 7200 } }); // 2h, elapsed is 1h
  const driver = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers, now: NOW });
  const outcome = await driver.driveOne(7, 46, TRIGGERED_LONG_AGO, noopRecord, { lock: NO_LOCK, recordFallback: noopRecordFallback });
  assert.equal(outcome.kind, "queued");
  assert.equal(outcome.reviewerTransition, undefined);
  assert.deepEqual(forge.merged, []);
  assert.deepEqual(forge.comments, []);
});

test("MergeDriver.driveOne: threshold crossed -> gates via the fallback's OWN verdict, merges, reports a switch transition, and records the new lock (comment/event announcement is the conductor's, deduped there)", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "WAIT_REVIEW", headOid: "HEAD" }; // primary still down
  const fallbackReviewers = [new ScriptedReviewer("same-model-trusted", "MERGE_OK")];
  const cfg = mkCfg({ reviewer: { trustedReviewers: ["trusted-bot"], fallback: ["same-model-trusted"], failoverAfterSec: 1200 } }); // 20min, elapsed 1h
  const recorded: ReviewFallbackLock[] = [];
  const driver = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers, now: NOW });
  const outcome = await driver.driveOne(7, 46, TRIGGERED_LONG_AGO, noopRecord, {
    lock: NO_LOCK,
    recordFallback: (lock) => recorded.push(lock),
  });
  assert.equal(outcome.kind, "merged");
  assert.deepEqual(outcome.reviewerTransition, { kind: "switch", mode: "same-model-trusted", head: "HEAD" });
  assert.deepEqual(forge.merged, [[7, "HEAD"]]);
  assert.deepEqual(forge.comments, []); // announcement moved to the conductor (needs event-log dedup)
  assert.deepEqual(recorded, [{ head: "HEAD", kind: "same-model-trusted" }]);
});

// ── #54 R2 (PR #71 review): the two halves of the corrected lock semantics ──

test("MergeDriver.driveOne R2: the lock SURVIVES primary non-decisiveness — re-verified against the live approval artifact, merges, lock untouched", async () => {
  const forge = new FakeForge();
  forge.reviewData = {
    ...forge.reviewData,
    reviews: [{ author: "trusted-bot", commitOid: "HEAD", state: "APPROVED" }], // the artifact exists
  };
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "WAIT_REVIEW", headOid: "HEAD" }; // primary down/undecided again
  // failoverAfterSec 7200 (elapsed 1h) -> BELOW threshold: this exercises the lock re-verify
  // path specifically, not the ordinary failover chain.
  const cfg = mkCfg({ reviewer: { trustedReviewers: ["trusted-bot"], fallback: ["same-model-trusted"], failoverAfterSec: 7200 } });
  const recorded: ReviewFallbackLock[] = [];
  const driver = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers: [new SameModelTrustedReviewer(["trusted-bot"])], now: NOW });
  const outcome = await driver.driveOne(7, 46, TRIGGERED_LONG_AGO, noopRecord, {
    lock: { head: "HEAD", kind: "same-model-trusted" },
    recordFallback: (l) => recorded.push(l),
  });
  assert.equal(outcome.kind, "merged");
  assert.deepEqual(forge.merged, [[7, "HEAD"]]);
  assert.deepEqual(recorded, [] as ReviewFallbackLock[]); // lock unchanged — never re-written, never cleared here
});

test("MergeDriver.driveOne R2: the lock does NOT override fresh blocking signals — a standing human CHANGES_REQUESTED on the locked head blocks (fable-review P1)", async () => {
  const forge = new FakeForge();
  forge.reviewData = {
    ...forge.reviewData,
    reviews: [
      { author: "trusted-bot", commitOid: "HEAD", state: "APPROVED" }, // the fallback approval exists...
      { author: "some-human", commitOid: "HEAD", state: "CHANGES_REQUESTED" }, // ...but a human blocked since
    ],
  };
  // Real primary mode (not scripted): CodexReviewer derives HANDLE_THREADS from the standing
  // change request — the exact end-to-end repro from the fable review, now expected to block.
  const primary = new CodexReviewer();
  // #246: prFixCap: 0 isolates this test to the LOCK-vs-fresh-signal concern it actually tests
  // (fable-review P1) — with the fix loop enabled, HANDLE_THREADS routes to FIXABLE, covered by
  // its own dedicated #246 tests above.
  const cfg = mkCfg({
    reviewer: { trustedReviewers: ["trusted-bot"], fallback: ["same-model-trusted"], failoverAfterSec: 1200 },
    lanes: { prFixCap: 0 },
  });
  const recorded: ReviewFallbackLock[] = [];
  const driver = new MergeDriver({
    forge,
    reviewer: primary,
    cfg,
    fallbackReviewers: [new SameModelTrustedReviewer(["trusted-bot"])],
    now: NOW,
  });
  const outcome = await driver.driveOne(7, 46, TRIGGERED_LONG_AGO, noopRecord, {
    lock: { head: "HEAD", kind: "same-model-trusted" },
    recordFallback: (l) => recorded.push(l),
  });
  assert.equal(outcome.kind, "needs-human"); // HANDLE_THREADS gates HUMAN — never merged
  assert.deepEqual(forge.merged, []);
  assert.deepEqual(recorded, [] as ReviewFallbackLock[]); // and the block does not clear the lock either (head unchanged)
});

test("MergeDriver.driveOne R2: transient non-merge outcomes leave the lock in place — cleared only on merge or head change (Codex PR #71 P2)", async () => {
  const forge = new FakeForge();
  forge.status = { ...forge.status, ciGreen: false }; // gate① pending -> MERGE_OK still queues
  const reviewer = new FakeReviewer(); // primary decisive MERGE_OK (recovered)
  const cfg = mkCfg({ reviewer: { trustedReviewers: ["trusted-bot"], fallback: ["same-model-trusted"], failoverAfterSec: 1200 } });
  const recorded: ReviewFallbackLock[] = [];
  const driver = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers: [new SameModelTrustedReviewer(["trusted-bot"])], now: NOW });
  const lock: ReviewFallbackLock = { head: "HEAD", kind: "same-model-trusted" };
  const t1 = await driver.driveOne(7, 46, TRIGGERED_LONG_AGO, noopRecord, { lock, recordFallback: (l) => recorded.push(l) });
  assert.equal(t1.kind, "queued"); // CI not green — no merge this tick
  assert.deepEqual(recorded, [] as ReviewFallbackLock[]); // the lock is NOT cleared on a transient non-merge tick
  assert.deepEqual(t1.reviewerTransition, { kind: "revert", mode: "different-model-codex", head: "HEAD" });

  forge.status = { ...forge.status, ciGreen: true }; // next tick: CI green
  const t2 = await driver.driveOne(7, 46, TRIGGERED_LONG_AGO, noopRecord, { lock, recordFallback: (l) => recorded.push(l) });
  assert.equal(t2.kind, "merged");
  assert.deepEqual(recorded, [] as ReviewFallbackLock[]); // still never cleared at resolution time
});

test("MergeDriver.driveOne R2: a FORGED lock row (no matching approval on the PR) synthesizes nothing — the PR just keeps queuing (fable-review P2)", async () => {
  const forge = new FakeForge(); // reviewData has NO reviews at all
  const reviewer = new FakeReviewer();
  reviewer.verdict = { action: "WAIT_REVIEW", headOid: "HEAD" };
  const cfg = mkCfg({ reviewer: { fallback: ["human"], failoverAfterSec: 7200 } }); // below threshold -> lock path
  const driver = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers: [new HumanReviewer()], now: NOW });
  const outcome = await driver.driveOne(7, 46, TRIGGERED_LONG_AGO, noopRecord, {
    lock: { head: "HEAD", kind: "human" }, // forged: claims a human approval that does not exist
    recordFallback: noopRecordFallback,
  });
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(forge.merged, []); // never a synthesized MERGE_OK
});

test("MergeDriver.driveOne R2: a head change clears the (now stale) lock in the re-trigger branch — the only drive-path clear", async () => {
  const forge = new FakeForge(); // live head is "HEAD"
  const reviewer = new FakeReviewer();
  const cfg = mkCfg({ reviewer: { fallback: ["human"], failoverAfterSec: 1200 } });
  const recorded: ReviewFallbackLock[] = [];
  const driver = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers: [new HumanReviewer()], now: NOW });
  const outcome = await driver.driveOne(
    7,
    46,
    { head: "OLD_HEAD", at: "2026-07-07T07:00:00Z" }, // pin for the old head -> re-trigger branch
    noopRecord,
    { lock: { head: "OLD_HEAD", kind: "human" }, recordFallback: (l) => recorded.push(l) },
  );
  assert.deepEqual(outcome, { kind: "queued", pr: 7, reason: "review-triggered", holdObservation: { held: false } });
  assert.deepEqual(recorded, [{ head: null, kind: null }]); // stale episode ended with the old head
});

test("MergeDriver.driveOne: primary recovers cleanly (MERGE_OK) with NO prior lock -> normal merge, no reviewer-failover machinery involved", async () => {
  const forge = new FakeForge();
  const reviewer = new FakeReviewer(); // default verdict: MERGE_OK
  const cfg = mkCfg({ reviewer: { trustedReviewers: ["trusted-bot"], fallback: ["same-model-trusted"], failoverAfterSec: 1200 } });
  const driver = new MergeDriver({
    forge,
    reviewer,
    cfg,
    fallbackReviewers: [new ScriptedReviewer("same-model-trusted", "WAIT_REVIEW")],
    now: NOW,
  });
  const outcome = await driver.driveOne(7, 46, TRIGGERED_LONG_AGO, noopRecord, { lock: NO_LOCK, recordFallback: noopRecordFallback });
  assert.equal(outcome.kind, "merged");
  assert.equal(outcome.reviewerTransition, undefined);
  assert.deepEqual(forge.comments, []);
});

// ── #287 (E4b): the engine-agent driveOne path — scripted-timeline tests (#277-style corpus) ──
//
// These construct MergeDriver directly with an INJECTED engine-agent-shaped reviewer + an
// injected engineAgentDeps context — the only way this path is ever exercised (see
// review/drive.ts's own module-header doc on production reachability). Every test below drives
// the REAL `MergeDriver.driveOne` (never review/drive.ts's driveEngineAgentReview directly), to
// prove the actual wiring the issue's verification plan names.

function mkEngineAgentCfg(over: Record<string, unknown> = {}): SapwoodConfig {
  return ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    worker: { model: "sonnet" },
    ...LEGACY_LABEL_CONFIG,
    reviewer: { mode: "engine-agent", agent: { model: "opus", retryAfterSec: 900 } },
    ci: { requiredChecks: [{ name: "test", app: "github-actions" }] },
    ...over,
  }) as SapwoodConfig;
}

class EngineAgentFakeForge extends FakeForge {
  checksPage: { checks: { name: string; status: string; conclusion: string | null; state: string | null; appSlug?: string | null }[] } = {
    checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: "github-actions" }],
  };
  constructor() {
    super();
    // Identity resolution (review/drive.ts's resolveIdentity) requires PRStatus.baseOid — the
    // base FakeForge default predates #287 and never set one.
    this.status = { ...this.status, baseOid: "BASE" };
  }
  override async getPRChecks() {
    return { ...this.checksPage, total: this.checksPage.checks.length };
  }
}

interface EARecorded {
  pin: { head: string; at: string; runId: string; kind: "decisive" | "unavailable" } | null;
  wal: {
    runId: string;
    head: string;
    base: string;
    diffHash: string;
    treeManifestHash: string | null;
    attemptStart: string;
    decisiveOutcome: "approved" | "rejected" | null;
    reviewArtifactJson: string | null;
    auditCommentId: string | null;
    auditDeliveredAt: string | null;
  } | null;
}

function mkEngineAgentDeps(
  recorded: EARecorded,
  overrides: { auditDelivery?: (r: ApprovalResult) => Promise<AuditDeliveryResult>; now?: () => Date } = {},
) {
  let runIdCursor = 0;
  return {
    now: overrides.now ?? (() => new Date("2026-01-01T00:00:00.000Z")),
    newRunId: () => `run-${++runIdCursor}`,
    getAttemptPin: () => recorded.pin,
    recordAttemptPin: (pin: EARecorded["pin"]) => {
      recorded.pin = pin;
    },
    getWal: () => recorded.wal,
    recordWal: (wal: { runId: string; head: string; base: string; diffHash: string; attemptStart: string }) => {
      recorded.wal = {
        ...wal,
        treeManifestHash: null,
        decisiveOutcome: null,
        reviewArtifactJson: null,
        auditCommentId: null,
        auditDeliveredAt: null,
      };
    },
    recordWalDecisiveOutcome: (runId: string, outcome: "approved" | "rejected") => {
      if (recorded.wal && recorded.wal.runId === runId) recorded.wal = { ...recorded.wal, decisiveOutcome: outcome };
    },
    auditDelivery: async (result: ApprovalResult) => {
      const delivered = await (
        overrides.auditDelivery ??
        (async (): Promise<AuditDeliveryResult> => ({ delivered: false, reason: "#288 not implemented in this test" }))
      )(result);
      if (delivered.delivered && recorded.wal) {
        recorded.wal = { ...recorded.wal, reviewArtifactJson: "{}", auditCommentId: "C1", auditDeliveredAt: "2026-01-01T00:00:01.000Z" };
      }
      return delivered;
    },
    reconcileAuditDelivery: async (): Promise<AuditDeliveryResult> => ({ delivered: false, reason: "nothing to reconcile" }),
    ciChecksCap: 20,
  };
}

test("MergeDriver.driveOne (engine-agent): preflight short-circuits BEFORE any paid session — a draft PR never reaches evaluate()", async () => {
  const forge = new EngineAgentFakeForge();
  forge.reviewData = { ...forge.reviewData, isDraft: true };
  let evaluated = false;
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      evaluated = true;
      return { kind: "pending" as const, headOid: "HEAD" };
    },
  };
  const cfg = mkEngineAgentCfg();
  const recorded: EARecorded = { pin: null, wal: null };
  const driver = new MergeDriver({ forge, reviewer, cfg });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.equal(outcome.kind, "queued");
  assert.equal(evaluated, false);
  assert.equal(recorded.wal, null);
});

test("MergeDriver.driveOne (engine-agent): missing engineAgentDeps fails closed to queued, never throws", async () => {
  const forge = new EngineAgentFakeForge();
  const reviewer = { kind: "engine-agent" as const, evaluate: async () => ({ kind: "pending" as const, headOid: "HEAD" }) };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord);
  assert.equal(outcome.kind, "queued");
});

test("MergeDriver.driveOne (engine-agent): approved + delivered + clean refetch -> MERGE, via the SAME finalizeVerdict/deriveGate/mergePR path the classic reviewers use", async () => {
  const forge = new EngineAgentFakeForge();
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => ({ kind: "approved" as const, headOid: "HEAD", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } }),
  };
  const recorded: EARecorded = { pin: null, wal: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(
    7,
    46,
    ALREADY_TRIGGERED,
    noopRecord,
    undefined,
    undefined,
    undefined,
    mkEngineAgentDeps(recorded, { auditDelivery: async () => ({ delivered: true }) }),
  );
  assert.equal(outcome.kind, "merged");
  assert.deepEqual(forge.merged, [[7, "HEAD"]]);
  assert.equal(recorded.pin?.kind, "decisive");
});

test("MergeDriver.driveOne (engine-agent): rejected + delivered -> FIXABLE (conductor-merge mode), via the shared finalizeVerdict HANDLE_THREADS->FIXABLE lane", async () => {
  const forge = new EngineAgentFakeForge();
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async (): Promise<ApprovalResult> => ({ kind: "rejected", headOid: "HEAD", findings: [{ id: "f1", body: "bug found" }] }),
  };
  const cfg = mkEngineAgentCfg({ lanes: { prFixCap: 2 } });
  const recorded: EARecorded = { pin: null, wal: null };
  const driver = new MergeDriver({ forge, reviewer, cfg });
  const outcome = await driver.driveOne(
    7,
    46,
    ALREADY_TRIGGERED,
    noopRecord,
    undefined,
    undefined,
    undefined,
    mkEngineAgentDeps(recorded, { auditDelivery: async () => ({ delivered: true }) }),
  );
  assert.equal(outcome.kind, "fixable");
});

test("MergeDriver.driveOne (engine-agent): produce-pr-and-stop — gates report, never merge; a DECISIVE, delivered verdict on a REPEAT tick still never re-runs a session (permanent pin, tick-loop test)", async () => {
  const forge = new EngineAgentFakeForge();
  let evaluations = 0;
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      evaluations++;
      return { kind: "approved" as const, headOid: "HEAD", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } };
    },
  };
  const cfg = mkEngineAgentCfg({ merge: { mode: "produce-pr-and-stop" } });
  const recorded: EARecorded = { pin: null, wal: null };
  const deps = mkEngineAgentDeps(recorded, { auditDelivery: async () => ({ delivered: true }) });
  const driver = new MergeDriver({ forge, reviewer, cfg });

  const first = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, deps);
  assert.equal(first.kind, "stopped");
  assert.equal(evaluations, 1);
  assert.equal(recorded.pin?.kind, "decisive");

  // Tick loop: driveOne runs again for the SAME (audited) head — never re-reviews it.
  const second = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, deps);
  assert.equal(second.kind, "stopped");
  assert.equal(evaluations, 1, "produce-pr-and-stop never re-reviews an audited head");
  const third = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, deps);
  assert.equal(third.kind, "stopped");
  assert.equal(evaluations, 1);
});

test("MergeDriver.driveOne (engine-agent): unavailable pin backoff — a repeat tick within retryAfterSec never re-runs the session; expiry IS the next paid attempt", async () => {
  const forge = new EngineAgentFakeForge();
  let evaluations = 0;
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      evaluations++;
      return { kind: "unavailable" as const, headOid: "HEAD", reason: "session crashed" };
    },
  };
  const cfg = mkEngineAgentCfg();
  const recorded: EARecorded = { pin: null, wal: null };
  let now = new Date("2026-01-01T00:00:00.000Z");
  const deps = mkEngineAgentDeps(recorded, { now: () => now });
  const driver = new MergeDriver({ forge, reviewer, cfg });

  await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, deps);
  assert.equal(evaluations, 1);
  assert.equal(recorded.pin?.kind, "unavailable");

  now = new Date("2026-01-01T00:05:00.000Z"); // 300s later — under the 900s retryAfterSec
  const second = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, deps);
  assert.equal(evaluations, 1, "still within backoff — no new session");
  assert.equal(second.kind, "queued");

  now = new Date("2026-01-01T00:16:00.000Z"); // 960s after the FIRST attempt — backoff expired
  await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, deps);
  assert.equal(evaluations, 2, "backoff expiry IS the primary-recovery probe — a fresh paid attempt");
});

test("MergeDriver.driveOne (engine-agent): a head change clears the pin — a fresh head gets its own attempt even right after a decisive verdict on the old head", async () => {
  const forge = new EngineAgentFakeForge();
  let evaluations = 0;
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      evaluations++;
      return { kind: "approved" as const, headOid: forge.status.headOid, evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } };
    },
  };
  const cfg = mkEngineAgentCfg({ merge: { mode: "produce-pr-and-stop" } });
  const recorded: EARecorded = { pin: null, wal: null };
  const deps = mkEngineAgentDeps(recorded, { auditDelivery: async () => ({ delivered: true }) });
  const driver = new MergeDriver({ forge, reviewer, cfg });

  await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, deps);
  assert.equal(evaluations, 1);
  assert.equal(recorded.pin?.head, "HEAD");

  // A push moves the head.
  forge.status = { ...forge.status, headOid: "HEAD2" };
  forge.reviewData = { ...forge.reviewData, headOid: "HEAD2" };
  await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, deps);
  assert.equal(evaluations, 2, "the new head is not blocked by the old head's decisive pin");
  assert.equal(recorded.pin?.head, "HEAD2");
});

test("MergeDriver.driveOne (engine-agent): approved but audit delivery UNAVAILABLE -> queued, never merges (E4c's ordering invariant)", async () => {
  const forge = new EngineAgentFakeForge();
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => ({ kind: "approved" as const, headOid: "HEAD", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } }),
  };
  const recorded: EARecorded = { pin: null, wal: null };
  // Default mkEngineAgentDeps auditDelivery always reports delivered:false — the PRODUCTION shape.
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(forge.merged, []);
  assert.equal(recorded.pin?.kind, "unavailable", "never permanent without a receipted audit comment");
});

test("#288 ordering: rejected but audit/receipt unavailable never reaches FIXABLE or #170 escalation", async () => {
  const forge = new EngineAgentFakeForge();
  const cfg = mkEngineAgentCfg({ reviewer: { mode: "engine-agent", agent: { model: "opus" }, escalateAfterSec: 1 } });
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => ({
      kind: "rejected" as const,
      headOid: "HEAD",
      findings: [{ id: "F1", body: "bug" }] as [{ id: string; body: string }],
    }),
  };
  const recorded: EARecorded = { pin: null, wal: null };
  const deps = {
    ...mkEngineAgentDeps(recorded, {
      auditDelivery: async () => ({ delivered: false, reason: "post failed" }),
      now: () => new Date("2026-01-01T01:00:00Z"),
    }),
    getFirstAttemptAt: () => "2026-01-01T00:00:00Z",
  };
  const driver = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers: [], now: () => new Date("2026-01-01T01:00:00Z") });
  const outcome = await driver.driveOne(7, 1, ALREADY_TRIGGERED, noopRecord, undefined, false, undefined, deps);
  assert.equal(outcome.kind, "queued");
  assert.equal(outcome.reviewSilenceEscalation, undefined);
  assert.equal(forge.merged.length, 0);
});

test("MergeDriver.driveOne (engine-agent): post-session refetch race — head moved between session and consume discards the approval, never merges", async () => {
  const forge = new EngineAgentFakeForge();
  let statusCalls = 0;
  const originalGetPRStatus = forge.getPRStatus.bind(forge);
  forge.getPRStatus = async () => {
    statusCalls++;
    // calls 1-2: the initial status0 fetch + identity resolution's own refetch — head unchanged.
    // call 3+: the POST-SESSION refetch (Promise.all with getPRReviewData) — a push landed in between.
    return statusCalls <= 2 ? originalGetPRStatus() : { ...(await originalGetPRStatus()), headOid: "PUSHED" };
  };
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => ({ kind: "approved" as const, headOid: "HEAD", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } }),
  };
  const recorded: EARecorded = { pin: null, wal: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(
    7,
    46,
    ALREADY_TRIGGERED,
    noopRecord,
    undefined,
    undefined,
    undefined,
    mkEngineAgentDeps(recorded, { auditDelivery: async () => ({ delivered: true }) }),
  );
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(forge.merged, [], "the race must discard the merge, never let it through");
  assert.equal(recorded.pin?.kind, "decisive", "the audit was already receipted — the pin stays permanent regardless of the race");
});

test("MergeDriver.driveOne (engine-agent): WAL precedes spawn — the WAL row exists (with this attempt's H/B/D) by the time evaluate() is invoked", async () => {
  const forge = new EngineAgentFakeForge();
  let walSeenInsideEvaluate: unknown;
  const recorded: EARecorded = { pin: null, wal: null };
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      walSeenInsideEvaluate = recorded.wal;
      return { kind: "pending" as const, headOid: "HEAD" };
    },
  };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.ok(walSeenInsideEvaluate, "WAL must be persisted before the session spawns");
  assert.equal((walSeenInsideEvaluate as { head: string }).head, "HEAD");
});

// ── #303 review round 2 (Codex gpt-5.6-sol high P1 #1): terminal-state handling ───────────────

test("MergeDriver.driveOne (engine-agent, produce-pr-and-stop human-merge transition, decisive pin PRESENT): a human merges the audited PR out of band — the NEXT tick detects MERGED and finally closes the lane, never re-attempts consume", async () => {
  const forge = new EngineAgentFakeForge();
  forge.status = { ...forge.status, state: "MERGED" };
  let evaluated = false;
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      evaluated = true;
      return { kind: "pending" as const, headOid: "HEAD" };
    },
  };
  const recorded: EARecorded = {
    pin: { head: "HEAD", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" },
    wal: {
      runId: "run-1",
      head: "HEAD",
      base: "BASE",
      diffHash: "d",
      treeManifestHash: null,
      attemptStart: "2026-01-01T00:00:00.000Z",
      decisiveOutcome: "approved",
      reviewArtifactJson: null,
      auditCommentId: null,
      auditDeliveredAt: null,
    },
  };
  const cfg = mkEngineAgentCfg({ merge: { mode: "produce-pr-and-stop" } });
  const driver = new MergeDriver({ forge, reviewer, cfg });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD" });
  assert.equal(evaluated, false, "MERGED short-circuits before the decisive-pin consume path is ever reached");
});

test("MergeDriver.driveOne (engine-agent, produce-pr-and-stop human-merge transition, NO pin at all): the very first read already shows MERGED -> merged outcome directly, no session, no pin/WAL machinery touched", async () => {
  const forge = new EngineAgentFakeForge();
  forge.reviewData = { ...forge.reviewData, state: "MERGED" };
  let evaluated = false;
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      evaluated = true;
      return { kind: "pending" as const, headOid: "HEAD" };
    },
  };
  const recorded: EARecorded = { pin: null, wal: null };
  const cfg = mkEngineAgentCfg({ merge: { mode: "produce-pr-and-stop" } });
  const driver = new MergeDriver({ forge, reviewer, cfg });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.deepEqual(outcome, { kind: "merged", pr: 7, headOid: "HEAD" });
  assert.equal(evaluated, false);
  assert.equal(recorded.pin, null);
  assert.equal(recorded.wal, null);
});

test("MergeDriver.driveOne (engine-agent): a COHERENT CLOSED-without-merge -> needs-human (classic deriveGate non-OPEN parity)", async () => {
  const forge = new EngineAgentFakeForge();
  forge.status = { ...forge.status, state: "CLOSED" };
  forge.reviewData = { ...forge.reviewData, state: "CLOSED" };
  const reviewer = { kind: "engine-agent" as const, evaluate: async () => ({ kind: "pending" as const, headOid: "HEAD" }) };
  const recorded: EARecorded = { pin: null, wal: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.deepEqual(outcome, { kind: "needs-human", pr: 7, reason: "engine-agent: gate:HUMAN:pr-state-CLOSED" });
});

test("MergeDriver.driveOne (engine-agent): split-state reads (status OPEN, review-data CLOSED) -> queued, never derives anything from a mixed pair", async () => {
  const forge = new EngineAgentFakeForge();
  forge.reviewData = { ...forge.reviewData, state: "CLOSED" }; // forge.status stays OPEN (default)
  const reviewer = { kind: "engine-agent" as const, evaluate: async () => ({ kind: "pending" as const, headOid: "HEAD" }) };
  const recorded: EARecorded = { pin: null, wal: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.equal(outcome.kind, "queued");
  assert.match((outcome as { reason: string }).reason, /gate-state-mismatch/);
});

test("MergeDriver.driveOne (engine-agent, #303 review P1): identity/session-input coherence — a mismatch-restart resolving a NEW head while the PR-review data still holds the OLD head -> queued, evaluate() never called, no WAL write", async () => {
  const forge = new EngineAgentFakeForge();
  let statusCalls = 0;
  const originalGetPRStatus = forge.getPRStatus.bind(forge);
  forge.getPRStatus = async () => {
    statusCalls++;
    // call 1: driveOne's/drive.ts's own status0 fetch -> HEAD (unchanged).
    // calls 2-3: resolveIdentity's own refetches — the head has moved to HEAD2 (mismatch,
    // restarts once, then resolves HEAD2 as stable).
    return statusCalls === 1 ? originalGetPRStatus() : { ...(await originalGetPRStatus()), headOid: "HEAD2" };
  };
  // getPRReviewData (fetched during preflight, BEFORE identity resolution) is never refreshed —
  // it still reports the stale HEAD, exactly the divergence the coherence check must catch.
  let evaluated = false;
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      evaluated = true;
      return { kind: "pending" as const, headOid: "HEAD2" };
    },
  };
  const recorded: EARecorded = { pin: null, wal: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.equal(outcome.kind, "queued");
  assert.equal(evaluated, false, "an incoherent generation must never spawn a session");
  assert.equal(recorded.wal, null, "no WAL record for an incoherent generation");
});

test("MergeDriver.driveOne (engine-agent, #303 review P1): a decisive verdict whose OWN headOid diverges from this attempt's resolved head -> queued, pin stays 'unavailable' (never permanent), never reaches finalizeVerdict/merge", async () => {
  const forge = new EngineAgentFakeForge();
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => ({
      kind: "approved" as const,
      headOid: "SOME-OTHER-OID",
      evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 },
    }),
  };
  const recorded: EARecorded = { pin: null, wal: null };
  let auditCalled = false;
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(
    7,
    46,
    ALREADY_TRIGGERED,
    noopRecord,
    undefined,
    undefined,
    undefined,
    mkEngineAgentDeps(recorded, {
      auditDelivery: async () => {
        auditCalled = true;
        return { delivered: true };
      },
    }),
  );
  assert.equal(outcome.kind, "queued");
  assert.deepEqual(forge.merged, []);
  assert.equal(auditCalled, false);
  assert.equal(recorded.pin?.kind, "unavailable");
});

test("MergeDriver.driveOne (engine-agent): CI-evidence fixture matrix — SKIPPED conclusion never satisfies preflight, no session", async () => {
  const forge = new EngineAgentFakeForge();
  forge.checksPage = { checks: [{ name: "test", status: "COMPLETED", conclusion: "SKIPPED", state: null, appSlug: "github-actions" }] };
  let evaluated = false;
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      evaluated = true;
      return { kind: "pending" as const, headOid: "HEAD" };
    },
  };
  const recorded: EARecorded = { pin: null, wal: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.equal(outcome.kind, "queued");
  assert.equal(evaluated, false);
});

test("MergeDriver.driveOne (engine-agent): CI-evidence fixture matrix — a foreign-app CheckRun of the same name never satisfies preflight", async () => {
  const forge = new EngineAgentFakeForge();
  forge.checksPage = { checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: "some-other-app" }] };
  let evaluated = false;
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => {
      evaluated = true;
      return { kind: "pending" as const, headOid: "HEAD" };
    },
  };
  const recorded: EARecorded = { pin: null, wal: null };
  const driver = new MergeDriver({ forge, reviewer, cfg: mkEngineAgentCfg() });
  const outcome = await driver.driveOne(7, 46, ALREADY_TRIGGERED, noopRecord, undefined, undefined, undefined, mkEngineAgentDeps(recorded));
  assert.equal(outcome.kind, "queued");
  assert.equal(evaluated, false);
});

test("#288/#54 engine-agent unavailable past first-attempt failover uses fallback's live verdictFromData and can gate", async () => {
  const forge = new EngineAgentFakeForge();
  forge.reviewData = { ...forge.reviewData, reviews: [{ author: "human", state: "APPROVED", commitOid: "HEAD" }] };
  const cfg = mkEngineAgentCfg({
    reviewer: { mode: "engine-agent", agent: { model: "opus", retryAfterSec: 900 }, fallback: ["human"], failoverAfterSec: 60 },
  });
  const recorded: EARecorded = { pin: { head: "HEAD", at: "2026-01-01T00:05:00Z", runId: "run-1", kind: "unavailable" }, wal: null };
  const deps = { ...mkEngineAgentDeps(recorded), getFirstAttemptAt: () => "2026-01-01T00:00:00Z" };
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => ({ kind: "unavailable" as const, headOid: "HEAD", reason: "pin unavailable" }),
  };
  const driver = new MergeDriver({
    forge,
    reviewer,
    cfg,
    fallbackReviewers: [new HumanReviewer()],
    now: () => new Date("2026-01-01T00:10:00Z"),
  });
  const outcome = await driver.driveOne(7, 1, ALREADY_TRIGGERED, noopRecord, undefined, false, undefined, deps);
  assert.equal(outcome.kind, "merged");
  assert.equal(forge.merged.length, 1);
  assert.equal(outcome.reviewerTransition?.mode, "human");
});

test("#288/#170 engine-agent silence past first-attempt escalation emits visibility signal, latched by existing conductor path", async () => {
  const forge = new EngineAgentFakeForge();
  const cfg = mkEngineAgentCfg({ reviewer: { mode: "engine-agent", agent: { model: "opus", retryAfterSec: 900 }, escalateAfterSec: 60 } });
  const recorded: EARecorded = { pin: { head: "HEAD", at: "2026-01-01T00:05:00Z", runId: "run-1", kind: "unavailable" }, wal: null };
  const deps = { ...mkEngineAgentDeps(recorded), getFirstAttemptAt: () => "2026-01-01T00:00:00Z" };
  const reviewer = {
    kind: "engine-agent" as const,
    evaluate: async () => ({ kind: "unavailable" as const, headOid: "HEAD", reason: "pin unavailable" }),
  };
  const driver = new MergeDriver({ forge, reviewer, cfg, fallbackReviewers: [], now: () => new Date("2026-01-01T00:10:00Z") });
  const outcome = await driver.driveOne(7, 1, ALREADY_TRIGGERED, noopRecord, undefined, false, undefined, deps);
  assert.equal(outcome.kind, "queued");
  assert.equal(outcome.reviewSilenceEscalation?.head, "HEAD");
  assert.equal(outcome.reviewSilenceEscalation?.silenceSec, 600);
});
