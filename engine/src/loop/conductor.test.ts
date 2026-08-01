// Parity tests for the conductor's pure scheduling core — a faithful port of 0day's
// ops/loop/test_loop_conductor.sh assert table. Same semantics, TS types (booleans for
// the bash 0/1 sentinel/flag args, string[] for the CSV label args). If a row here
// disagrees with the bash row it mirrors, that's a parity regression.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ConfigSchema, loadConfig, type SapwoodConfig } from "../config/config.js";
import {
  associateLanePr,
  type CommitInfo,
  type IForge,
  type Issue,
  type PRCheckItem,
  type PRReviewData,
  type PRStatus,
  type ReviewThreadSpan,
  type ReviewThreadsPage,
  readPrOwner,
} from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import type { EngineReviewArtifact } from "../review/audit.js";
import { classicThreadFindingKey, engineAgentFindingKey } from "../review/finding-key.js";
import { type DriveOutcome, MergeDriver } from "../roles/merge-driver.js";
import { CODEX_REVIEWER_LOGINS, CodexReviewer, type ReviewFallbackLock, type ReviewTriggerPin } from "../roles/reviewer.js";
import { WorkerSupervisor } from "../roles/worker.js";
import { State, type WorkerRow } from "../state/state.js";
import { RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import {
  BLOCKER_RECHECK_READS_PER_TICK,
  budgetExceeded,
  capHitEscalationNote,
  classifyLane,
  codingFloor,
  drainEscalationDue,
  driveDecision,
  drivingLaneTerminalForDrain,
  escalationCarrier,
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
  priorFixLegForVerdict,
  type ReclaimResult,
  reconcileStaleBlockers,
  releaseVanishedWorktrees,
  resumeDecision,
  type Supervisor,
  startFixLeg,
  tick,
} from "./conductor.js";
import { reconcileEscalations } from "./escalation-reconcile.js";
import { sweepResolvedHolds } from "./escalation-sweep.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

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
  override async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  override async getReadyIssues(): Promise<Issue[]> {
    this.readyReads++;
    return this.ready;
  }
  override async claimIssue(n: number): Promise<void> {
    this.claimed.push(n);
  }
  override async setBoardStatus(n: number, s: "backlog" | "ready" | "inProgress" | "done"): Promise<void> {
    this.boardSet.push([n, s]);
  }
  override async addSubIssue(): Promise<void> {
    throw new Error("FakeForge.addSubIssue is not used by this test");
  }
  override async getSubIssues() {
    return [];
  }
  override async addLabel(n: number, l: string): Promise<void> {
    if (this.throwOnAddLabel) throw new Error("simulated forge failure");
    this.labelsAdded.push([n, l]);
    const cur = this.issueLabelsByIssue[n] ?? [];
    if (!cur.includes(l)) this.issueLabelsByIssue[n] = [...cur, l];
  }
  labelsRemoved: Array<[number, string]> = [];
  /** #485: when set, removeLabel throws — proves a failed clear leaves the stale label in place
   *  (retried next tick) instead of the engine pretending it removed one. */
  throwOnRemoveLabel = false;
  override async removeLabel(n: number, l: string): Promise<void> {
    if (this.throwOnRemoveLabel) throw new Error("simulated forge failure");
    this.labelsRemoved.push([n, l]);
    this.issueLabelsByIssue[n] = (this.issueLabelsByIssue[n] ?? []).filter((x) => x !== l);
  }
  /** #485: per-issue OPEN/CLOSED state for the blocked-by reconcile's blocker reads. A number
   *  in `metaThrows` simulates a transient forge read failure; anything unlisted reads OPEN.
   *  Shares the single `getIssueMeta` override below with #484's `issueStateByIssue`. */
  issueState: Record<number, "OPEN" | "CLOSED"> = {};
  metaThrows = new Set<number>();
  metaReads: number[] = [];
  /** #398: per-PR label set — the PR-side twin of `issueLabelsByIssue`, mutable so a test can
   *  simulate a human removing needs-human from the PR (the #147 reentry act, now on the carrier
   *  the escalation actually wrote). `addPRLabel` appends here, never removes. */
  prLabelsByPr: Record<number, string[]> = {};
  override async addPRLabel(n: number, l: string): Promise<void> {
    if (this.throwOnAddPRLabel) throw new Error("simulated forge failure");
    this.prLabelsAdded.push([n, l]);
    const cur = this.prLabelsByPr[n] ?? [];
    if (!cur.includes(l)) this.prLabelsByPr[n] = [...cur, l];
    if (!this.prReviewData.labels.includes(l)) this.prReviewData = { ...this.prReviewData, labels: [...this.prReviewData.labels, l] };
  }
  /** #398: mirrors `throwOnAddLabel` for the PR carrier — proves a failed PR-side label write is
   *  recorded as `labeled: 0` and leaves the lane fail-closed-invisible to GATED RECLAIM, exactly
   *  as the issue-side failure always did. */
  throwOnAddPRLabel = false;
  override async getPRLabels(n: number): Promise<string[]> {
    return this.prLabelsByPr[n] ?? [];
  }
  /** #484: GATED RECLAIM's terminality discovery reads the ISSUE's live state before the cap.
   *  Mutable per-issue so a test can close an issue mid-run; unlisted issues read OPEN, which is
   *  every pre-#484 fixture's implicit assumption.
   *  Single merged override serving both #484 (`issueStateByIssue`) and #485 (`issueState` +
   *  `metaThrows`/`metaReads`) — the two landed as separate green PRs whose combination
   *  redeclared `getIssueMeta` (TS2393 on main). */
  issueStateByIssue: Record<number, "OPEN" | "CLOSED"> = {};
  override async getIssueMeta(n: number) {
    this.metaReads.push(n);
    if (this.metaThrows.has(n)) throw new Error("simulated forge failure");
    return {
      number: n,
      title: `issue ${n}`,
      state: this.issueStateByIssue[n] ?? this.issueState[n] ?? ("OPEN" as const),
      labels: this.issueLabelsByIssue[n] ?? [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }
  override async openPR(): Promise<number> {
    return 1;
  }
  /** #451 gate② P3(b): call-count spies — proves computeDisputeEscalation's two forge reads are
   *  SKIPPED (not merely no-op-returned) when the caller already knows the fixable can't be
   *  classic-reviewer-caused (outcome.verdictRunId set). */
  getPRStatusCalls = 0;
  getPRReviewThreadsCalls = 0;
  override async getPRStatus(n: number): Promise<PRStatus> {
    this.getPRStatusCalls++;
    return { ...this.prStatus, number: n };
  }
  /** #426: the check rollup the CI-pending escalation reads for its evidence comment. */
  prChecks: PRCheckItem[] = [];
  override async getPRChecks(_pr: number, cap: number) {
    return { checks: this.prChecks.slice(0, cap), total: this.prChecks.length };
  }
  override async mergePR(pr: number, headOid: string): Promise<void> {
    this.merged.push([pr, headOid]);
  }
  /** #398: the PR-side twins of `throwOnAddIssueComment` / `ambiguousAddIssueComment` — a
   *  PR-born escalation's comment now goes here, so its failure legs have to be simulable on
   *  this carrier too (same two distinct outcomes: a CONFIRMED failure where nothing lands, and
   *  the AMBIGUOUS one where GitHub created the comment but the client still saw an error). */
  throwOnAddPRComment = false;
  ambiguousAddPRComment = false;
  override async addPRComment(pr: number, body: string): Promise<void> {
    if (this.ambiguousAddPRComment) {
      this.prComments.push([pr, body]);
      throw new Error("simulated ambiguous forge failure (client timeout, server may have succeeded)");
    }
    if (this.throwOnAddPRComment) throw new Error("simulated forge failure");
    this.prComments.push([pr, body]);
  }
  /** #246 review round 1 (C3): lets a test simulate a transient issue-comment-post failure
   *  independent of `throwOnAddLabel` — proves a comment failure is handled with the SAME care
   *  as a label failure, not a bare best-effort `.catch(() => {})` right before a terminal
   *  upsert that would otherwise permanently lose the adjudication context. */
  throwOnAddIssueComment = false;
  /** #451 gate② round 3 (Codex P2): simulates the AMBIGUOUS write outcome — GitHub creates the
   *  comment (it lands in `issueComments`, so a later `getIssueComments` read finds it), but the
   *  client still sees an error, distinct from `throwOnAddIssueComment` (a CONFIRMED failure —
   *  nothing lands). Proves the marker-check-before-post path skips a re-post rather than
   *  duplicating the comment on the next retry. */
  ambiguousAddIssueComment = false;
  override async addIssueComment(n: number, body: string): Promise<void> {
    if (this.ambiguousAddIssueComment) {
      this.issueComments.push([n, body]);
      throw new Error("simulated ambiguous forge failure (client timeout, server may have succeeded)");
    }
    if (this.throwOnAddIssueComment) throw new Error("simulated forge failure");
    this.issueComments.push([n, body]);
  }
  // #283: per-issue live body map — mutable so a test can simulate a mid-flight edit between
  // dispatch and a later DRIVE-phase drift check. Defaults to "" (byte-for-byte the pre-#283
  // behavior for any test that never populates it).
  issueBodies: Record<number, string> = {};
  override async getIssueBody(n: number): Promise<string> {
    return this.issueBodies[n] ?? "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  override async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
  }
  /** #450 gate② P3c: call-count spy — proves `gatherFixupFindingRecord`'s forge reads are SKIPPED
   *  (not merely no-op-returned) on a tick where the lane can't dispatch anyway (unconfigured fix
   *  loop, or admission-blocked), mirroring `getPRStatusCalls`/`getPRReviewThreadsCalls` above. */
  getPRReviewDataCalls = 0;
  override async getPRReviewData(): Promise<PRReviewData> {
    this.getPRReviewDataCalls++;
    return this.prReviewData;
  }
  override async getPRDiff(): Promise<string> {
    return "";
  }
  /** #449 (design #402 R2): mutable so a test can populate the changed-file set
   *  `gatherFixDiffPaths`'s ROUND-1 (no previous drive-fixup) branch reads (conductor.ts).
   *  Defaults reproduce every pre-#449 fixture byte-for-byte (an empty, complete set). */
  changedFiles: { files: { filename: string; previousFilename?: string }[]; complete: boolean } = { files: [], complete: true };
  /** #426 review round 3: simulates the changed-file read failing — the instruction-path chain's
   *  own `unavailable` early return, one of the pre-trigger returns that can be the first pass to
   *  see a new head. */
  throwOnGetPRChangedFiles = false;
  override async getPRChangedFiles() {
    if (this.throwOnGetPRChangedFiles) throw new Error("simulated forge failure");
    return this.changedFiles;
  }
  /** #449 gate② P1 fix: mutable per-range compare result, keyed by `"${base}...${head}"` —
   *  `gatherFixDiffPaths`'s round-2+ branch. Default (unscripted range) is an empty, complete
   *  result, matching `getPRChangedFiles`'s own zero-changes default. */
  compareResults: Record<string, { files: { filename: string; previousFilename?: string }[]; complete: boolean }> = {};
  compareCalls: Array<[string, string]> = [];
  throwOnCompareChangedFiles = false;
  override async compareChangedFiles(base: string, head: string) {
    this.compareCalls.push([base, head]);
    if (this.throwOnCompareChangedFiles) throw new Error("simulated forge failure");
    return this.compareResults[`${base}...${head}`] ?? { files: [], complete: true };
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
  override async getIssueLabels(n: number): Promise<string[]> {
    return this.issueLabelsByIssue[n] ?? [];
  }
  /** #451 gate② round 3 (Codex P2): reflects `issueComments` (the same array `addIssueComment`
   *  writes to) — needed so `escalateReviewDisputed`'s marker-check-before-post read can actually
   *  observe a comment the fake just "posted", the same way GithubForge's real read would. */
  override async getIssueComments(n: number) {
    return this.issueComments.filter(([issue]) => issue === n).map(([, body]) => ({ login: "sapwood", createdAt: "t", body }));
  }
  /** #398: the PR-side twin — reflects `prComments` (the array `addPRComment` writes to) so a
   *  PR-carried escalation's marker-check-before-post read can observe a comment this fake just
   *  "posted", exactly as `getIssueComments` does for the issue carrier. */
  override async getPRComments(n: number, cap: number) {
    const comments = this.prComments
      .filter(([pr]) => pr === n)
      .map(([, body], i) => ({ id: `IC_${n}_${i}`, login: "sapwood", createdAt: "t", body }))
      .slice(-cap);
    return { comments, total: comments.length };
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
  // #247: fix-leg thread-response writes — recorded for tests to assert the exact call
  // sequence (fix-response.ts's attemptThreadWrite).
  threadReplies: Array<[string, string]> = [];
  threadResolves: string[] = [];
  /** #247 D5: simulates a transient forge failure on the reply half so a pending row survives
   *  a FIX RESPONSE RETRY attempt — proves DRIVE skips a lane that STILL has a pending write. */
  throwOnReplyToReviewThread = false;
  override async replyToReviewThread(threadId: string, body: string): Promise<void> {
    if (this.throwOnReplyToReviewThread) throw new Error("simulated forge failure");
    this.threadReplies.push([threadId, body]);
  }
  override async resolveReviewThread(threadId: string): Promise<void> {
    this.threadResolves.push(threadId);
    this.prReviewData = { ...this.prReviewData, unresolvedThreads: Math.max(0, this.prReviewData.unresolvedThreads - 1) };
  }
  /** #247 D3/F2(b): attemptThreadWrite's crash-safety marker check reads this back before every
   *  reply-post attempt — simulate GitHub's own live state from every reply already recorded
   *  above (single global bucket by threadId). */
  override async getReviewThreadCommentsTail(threadId: string, cap: number): Promise<string[]> {
    return this.threadReplies
      .filter(([tid]) => tid === threadId)
      .map(([, body]) => body)
      .slice(-cap);
  }
  /** #451: explicit override for getPRReviewThreads — when set, returned verbatim instead of the
   *  default derived-from-threadReplies view below (which has no room for the REVIEWER's own
   *  original finding comment, only our own posted replies — fine for the pre-#451 attemptThreadWrite
   *  tests, not expressive enough for the review-disputed escalation tests, which need a
   *  reviewer-authored comments[0] alongside the producer's reply). `undefined` (the default) is
   *  byte-for-byte the pre-#451 behavior. */
  reviewThreadsOverride: ReviewThreadsPage | undefined = undefined;
  override async getPRReviewThreads(_pr: number, _commentsCap: number): Promise<ReviewThreadsPage> {
    this.getPRReviewThreadsCalls++;
    if (this.reviewThreadsOverride) return this.reviewThreadsOverride;
    const byThread: Record<string, string[]> = {};
    for (const [tid, body] of this.threadReplies) {
      byThread[tid] ??= [];
      byThread[tid].push(body);
    }
    const threads = Object.entries(byThread).map(([id, bodies]) => ({
      id,
      isResolved: false,
      commentsComplete: true,
      comments: bodies.map((body) => ({ author: "worker", body, createdAt: "t" })),
    }));
    return { threads, pageCapped: false };
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
  resumeCalls: Array<{ issue: Issue; worker: string; opts: { proxy?: unknown; prompt?: string; sessionId?: string } | undefined }> = [];
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

test("#310 orderForDispatch: decomposed tracking parents are never dispatched even if a stale Ready read supplies one", () => {
  const cfg = mkCfg();
  assert.deepEqual(
    orderForDispatch(
      [
        { number: 1, title: "child", labels: [] },
        { number: 2, title: "parent", labels: [cfg.labels.decomposed] },
      ],
      cfg,
    ).map((issue) => issue.number),
    [1],
  );
});

// ── #485: auto-clear stale blocked-by labels once the blocker issue closes ─────────────────

/** Runs the reconcile over one issue's labels against a blocker-state map, returning what was
 *  removed on the forge and what the caller's own (in-memory) view of the labels became. */
const runBlockerReconcile = async (
  labels: string[],
  states: Record<number, "OPEN" | "CLOSED">,
  opts: { throws?: number[]; prefix?: string } = {},
) => {
  const forge = new FakeForge();
  forge.issueState = states;
  for (const n of opts.throws ?? []) forge.metaThrows.add(n);
  const cfg = opts.prefix == null ? mkCfg() : mkCfg({ labels: { ...LEGACY_LABEL_CONFIG.labels, prefix: opts.prefix } });
  const out = await reconcileStaleBlockers(forge, [{ number: 9, title: "", labels }], cfg);
  return { removed: forge.labelsRemoved, labels: out[0]?.labels ?? [], reads: forge.metaReads, forge };
};

test("#485 reconcileStaleBlockers: a CLOSED blocker's label is removed, an OPEN blocker's is left alone", async () => {
  const closed = await runBlockerReconcile(["prio:3-feature", "blocked-by:5"], { 5: "CLOSED" });
  assert.deepEqual(closed.removed, [[9, "blocked-by:5"]]);
  assert.deepEqual(closed.labels, ["prio:3-feature"], "the returned issue is unblocked in the same pass");

  const open = await runBlockerReconcile(["prio:3-feature", "blocked-by:5"], { 5: "OPEN" });
  assert.deepEqual(open.removed, [], "an open blocker is unchanged behavior");
  assert.deepEqual(open.labels, ["prio:3-feature", "blocked-by:5"]);
});

test("#485 reconcileStaleBlockers: a transient blocker-read failure keeps the label and never escalates", async () => {
  const r = await runBlockerReconcile(["blocked-by:5"], {}, { throws: [5] });
  assert.deepEqual(r.removed, [], "nothing removed on an unreadable blocker — retried next tick");
  assert.deepEqual(r.labels, ["blocked-by:5"]);
  assert.deepEqual(r.forge.labelsAdded, [], "no needs-human escalation: a flaky read is the common path, not Decision #9");
});

test("#485 reconcileStaleBlockers: a failed removeLabel leaves the stale label in place", async () => {
  const forge = new FakeForge();
  forge.issueState = { 5: "CLOSED" };
  forge.throwOnRemoveLabel = true;
  const out = await reconcileStaleBlockers(forge, [{ number: 9, title: "", labels: ["blocked-by:5"] }], mkCfg());
  assert.deepEqual(out[0]?.labels, ["blocked-by:5"], "the write failed, so the local view must not claim it succeeded");
  assert.deepEqual(forge.labelsAdded, []);
});

test("#485 reconcileStaleBlockers: multiple blockers clear partially — only the closed ones", async () => {
  const r = await runBlockerReconcile(["blocked-by:5", "blocked-by:6", "blocked-by:7"], { 5: "CLOSED", 6: "OPEN", 7: "CLOSED" });
  assert.deepEqual(
    r.removed.map(([, l]) => l),
    ["blocked-by:5", "blocked-by:7"],
  );
  assert.deepEqual(r.labels, ["blocked-by:6"], "still blocked by the one blocker that is still open");
});

test("#485 reconcileStaleBlockers: the exact label token is removed, including the blocked-by:#N form", async () => {
  const r = await runBlockerReconcile(["blocked-by:#5"], { 5: "CLOSED" });
  assert.deepEqual(r.removed, [[9, "blocked-by:#5"]], "removal uses the token the issue actually carries, not a reconstructed one");
});

test("#485 reconcileStaleBlockers: a non-configured-prefix blocked-by label is invisible, exactly as labelsBlockers sees it", async () => {
  const r = await runBlockerReconcile(["blocked-by:5"], { 5: "CLOSED" }, { prefix: "sapwood:" });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.reads, [], "no forge read at all for a label this config does not parse as a blocker");
});

test("#485 reconcileStaleBlockers: blocker reads are deduped across issues and bounded per tick", async () => {
  const forge = new FakeForge();
  forge.issueState = { 5: "CLOSED" };
  await reconcileStaleBlockers(
    forge,
    [
      { number: 9, title: "", labels: ["blocked-by:5"] },
      { number: 10, title: "", labels: ["blocked-by:5"] },
    ],
    mkCfg(),
  );
  assert.deepEqual(forge.metaReads, [5], "one read for the shared blocker, not one per blocked issue");
  assert.deepEqual(
    forge.labelsRemoved.map(([n]) => n),
    [9, 10],
    "both issues still get their own label removed",
  );

  const many = new FakeForge();
  const blocked = Array.from({ length: BLOCKER_RECHECK_READS_PER_TICK + 5 }, (_, k) => ({
    number: 100 + k,
    title: "",
    labels: [`blocked-by:${200 + k}`],
  }));
  for (const b of blocked) many.issueState[Number(b.labels[0]?.split(":")[1])] = "CLOSED";
  await reconcileStaleBlockers(many, blocked, mkCfg());
  assert.equal(many.metaReads.length, BLOCKER_RECHECK_READS_PER_TICK, "the per-tick read budget bounds the pass");
  assert.equal(many.labelsRemoved.length, BLOCKER_RECHECK_READS_PER_TICK, "the rest keep their labels and are retried next tick");
});

test("#485 reconcileStaleBlockers (#212 invariant): a token that also matches a configured workflow label is never removed", async () => {
  // A pathological config that aliases the human-release signature onto a blocked-by-shaped
  // string must not let the engine forge that signature, even with the blocker genuinely closed.
  const forge = new FakeForge();
  forge.issueState = { 7: "CLOSED" };
  const cfg = mkCfg({
    labels: { ...LEGACY_LABEL_CONFIG.labels, needsHuman: "blocked-by:7" },
    escalation: { humanLabels: ["blocked-by:7", "blocked"] },
  });
  const out = await reconcileStaleBlockers(forge, [{ number: 9, title: "", labels: ["blocked-by:7"] }], cfg);
  assert.deepEqual(forge.labelsRemoved, []);
  assert.deepEqual(out[0]?.labels, ["blocked-by:7"]);
});

test("#485 tick: an issue blocked by a CLOSED issue is unblocked and dispatched with no human action", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  forge.ready = [{ number: 9, title: "", labels: ["prio:3-feature", "blocked-by:5"] }];
  forge.issueState = { 5: "CLOSED" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(forge.labelsRemoved, [[9, "blocked-by:5"]]);
  assert.deepEqual(
    sup.dispatched.map((i) => i.number),
    [9],
  );
  assert.deepEqual(
    r.dispatched.filter((d) => d.kind === "dispatched").map((d) => d.issue),
    [9],
  );
  st.close();
});

test("#485 tick: an issue blocked by a still-OPEN issue stays filtered out, exactly as before", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  forge.ready = [{ number: 9, title: "", labels: ["prio:3-feature", "blocked-by:5"] }];
  forge.issueState = { 5: "OPEN" };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(forge.labelsRemoved, []);
  assert.deepEqual(sup.dispatched, [] as Issue[]);
  st.close();
});

test("tick dispatch: claim happens before launch; a claim failure spawns no worker", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"] }];
  forge.claimIssue = async () => {
    throw new Error("board claim failed");
  };
  await assert.rejects(() => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }));
  assert.deepEqual(sup.dispatched, [] as Issue[]); // claim threw first -> nothing launched, no untracked worker
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
  await assert.rejects(() => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }));
  assert.deepEqual(forge.claimed, [7]); // claimed first
  assert.ok(forge.boardSet.some(([n, s]) => n === 7 && s === "ready")); // then rolled back
  assert.equal(st.runningWorkers().length, 0);
  // The rollback succeeded on the first attempt -> no durable retry marker left behind.
  assert.equal(st.pendingRollbacks().length, 0);
  st.close();
});

// ── #283 (M10, E2, design #279 §5): AC-authority dispatch snapshot ─────────────────────────

test("tick dispatch: an AC snapshot is persisted BEFORE the worker ever spawns, from the SAME body getReadyIssues fetched", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  const body = "## Acceptance criteria\n\n- [ ] one\n- [ ] two\n\n## Verification plan\nrun tests";
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"], body }];
  // #403 (F25): held on an object rather than in a `let`. A `let x: T | null = null` only ever
  // assigned INSIDE a callback stays narrowed to `null` at the assertions below, which makes
  // `x!` `never` and the property reads uncheckable; a property keeps its declared type.
  const seenAtSpawn: { snapshot: ReturnType<State["getAcSnapshot"]> } = { snapshot: null };
  const originalDispatch = sup.dispatch.bind(sup);
  sup.dispatch = async (issue: Issue) => {
    // Proves ordering: by the moment the worker is spawned, the snapshot already exists.
    seenAtSpawn.snapshot = st.getAcSnapshot(issue.number);
    return originalDispatch(issue);
  };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.ok(seenAtSpawn.snapshot, "the AC snapshot must already be persisted by the time dispatch() (the spawn) is called");
  assert.equal(seenAtSpawn.snapshot.body, body);
  assert.equal(seenAtSpawn.snapshot.manifest.length, 2);
  // And it's still there (unchanged) after the tick completes.
  const snap = st.getAcSnapshot(7);
  assert.equal(snap?.body, body);
  st.close();
});

test("tick dispatch: the snapshotted body survives a live mid-flight edit — later reads never see the edited text", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  const forge = new FakeForge();
  const originalBody = "## Acceptance criteria\n\n- [ ] original criterion\n\n## Verification plan\nrun tests";
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"], body: originalBody }];
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.getAcSnapshot(7)?.body, originalBody);
  // Simulate a human/producer editing the LIVE issue body after dispatch.
  forge.issueBodies[7] = "## Acceptance criteria\n\n- [ ] EDITED criterion\n\n## Verification plan\nrun tests";
  // #301 review round 3 (P3): this proves State.getAcSnapshot() itself is immutable across a
  // live edit — never re-derived from a live read. It does NOT prove what any review SESSION's
  // input is (that wiring is #286/E4a's job — see ac-snapshot.ts's module header and
  // docs/security.md for the accurate scope statement).
  assert.equal(
    st.getAcSnapshot(7)?.body,
    originalBody,
    "the persisted snapshot never changes once recorded, regardless of a later live body edit",
  );
  st.close();
});

test("tick DRIVE: AC-snapshot drift routes to needs-human with a drift-explaining comment, and driveOne is NEVER called (no silent re-extraction)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const originalBody = "## Acceptance criteria\n\n- [ ] one\n\n## Verification plan\nrun tests";
  // Dispatch normally so the AC snapshot lands through the real DISPATCH path.
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"], body: originalBody }];
  forge.issueBodies[7] = originalBody;
  const firstTick = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  const dispatchedOutcome = firstTick.dispatched.find((d) => d.kind === "dispatched");
  assert.ok(dispatchedOutcome);
  const workerName = (dispatchedOutcome as { worker: string }).worker;
  // The worker finishes with a PR — promotes to `driving` on the NEXT tick's RECLAIM phase.
  sup.probes[workerName] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 99 };
  // A human (or the producer, who holds `gh issue edit`) edits the issue body mid-flight.
  forge.issueBodies[7] = "## Acceptance criteria\n\n- [ ] one EDITED\n\n## Verification plan\nrun tests";
  const gate = new FakeMergeGate();
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(gate.calls.length, 0, "driveOne must never be called once drift is detected");
  assert.ok(forge.labelsAdded.some(([n, l]) => n === 7 && l === "needs-human"));
  assert.ok(
    forge.issueComments.some(([n, body]) => n === 7 && /changed since its dispatch-time AC snapshot/.test(body)),
    "a drift-explaining comment is posted on the issue",
  );
  assert.equal(st.getWorker(workerName)?.state, "failed");
  assert.ok(r.driven.some((d) => d.kind === "needs-human" && d.issue === 7 && d.reason.startsWith("ac-snapshot-drift")));
  st.close();
});

test("tick DRIVE: a driving lane with NO recorded AC snapshot (predates #283, ac_body_hash null) is never treated as drift — drives normally", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-legacy", 4);
  sup.probes["lane-legacy"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending" };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(gate.calls.length, 1, "no snapshot recorded for issue 4 -> not drift -> driveOne runs normally");
  assert.equal(st.getWorker("lane-legacy")?.state, "driving");
  st.close();
});

// ── #301 review (P1#1): crash-window defense — a lane that recorded its OWN dispatch-time hash
//    (ac_body_hash set) but whose ac_snapshots row is missing is an ANOMALY, never silently
//    treated as a pre-#283 legacy lane. This is the shape a crash landing after the board claim
//    but before (or losing) the snapshot write would leave behind — distinct from FIX 1's
//    theoretical analysis (no code path in this codebase actually creates a WorkerRow without
//    first recording its snapshot in the same synchronous step — see conductor.ts's DISPATCH
//    loop comment), this test proves the DEFENSE holds regardless: IF such a row ever existed
//    (crash, corruption, a future refactor of that invariant), it fails closed instead of driving
//    unprotected. ──

test("tick DRIVE (#301 P1#1): a lane whose ac_body_hash is set but whose ac_snapshots row is MISSING (the crash-window shape) escalates as an anomaly — never silently drives as if it were a pre-#283 legacy lane", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // Seed a lane that claims to have recorded a snapshot (ac_body_hash set) but for which NO
  // ac_snapshots row actually exists — the exact shape a crash between the board claim and the
  // snapshot write (or the write itself failing after upsertWorker somehow ran anyway) leaves.
  st.upsertWorker({
    name: "lane-crashed",
    issue: 8,
    session_id: "sess-8",
    state: "driving",
    started_at: "t0",
    ended_at: null,
    pr: 77,
    ac_body_hash: "deadbeefcafe",
  });
  assert.equal(st.getAcSnapshot(8), null, "precondition: no snapshot exists for issue 8");
  const gate = new FakeMergeGate();
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(gate.calls.length, 0, "driveOne must never be called for a lane whose expected snapshot cannot be verified");
  assert.equal(st.getWorker("lane-crashed")?.state, "failed", "the lane re-escalates instead of driving unprotected");
  assert.ok(forge.labelsAdded.some(([n, l]) => n === 8 && l === "needs-human"));
  assert.ok(
    forge.issueComments.some(([n, body]) => n === 8 && /no longer present/.test(body)),
    "the escalation comment explains the snapshot is missing, distinct from an ordinary live-body edit",
  );
  assert.ok(r.driven.some((d) => d.kind === "needs-human" && d.issue === 8 && d.reason.startsWith("ac-snapshot-drift")));
  st.close();
});

test("tick DRIVE (#301 review, P2): a needs-human LABEL WRITE FAILURE never claims the label 'has been applied' or promises automatic reentry, and the durable event is written BEFORE the comment attempt", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  st.upsertWorker({
    name: "lane-labelfail",
    issue: 9,
    session_id: "sess-9",
    state: "driving",
    started_at: "t0",
    ended_at: null,
    pr: 88,
    ac_body_hash: "deadbeefcafe",
  });
  forge.throwOnAddLabel = true;
  const gate = new FakeMergeGate();
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(gate.calls.length, 0);
  const comment = forge.issueComments.find(([n]) => n === 9)?.[1] ?? "";
  assert.ok(!/has been applied/.test(comment), "must never claim the label landed when the write failed");
  assert.ok(/FAILED/.test(comment), "honestly explains the label write failed");
  assert.ok(
    !/re-trigger review/.test(comment) && /manually/.test(comment),
    "never promises automatic reentry (manually adding the label doesn't flip gated_escalation_labeled) — tells the human to review/merge by hand instead",
  );
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["ac-snapshot-drift"]);
  assert.equal(events.length, 1, "the event is durable EVEN THOUGH the comment attempt happens after it");
  const payload = events[0]!.payload as { labeled: number; labelError?: string };
  assert.equal(payload.labeled, 0);
  assert.ok(typeof payload.labelError === "string" && payload.labelError.length > 0);
  assert.equal(st.getWorker("lane-labelfail")?.gated_escalation_labeled, 0);
  st.close();
});

test("tick DRIVE (#301 review round 3, P2 regression fix): the durable ac-snapshot-drift event lands even when the FOLLOW-UP comment post fails — a comment failure can never strand the escalation invisibly", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  st.upsertWorker({
    name: "lane-commentfail",
    issue: 10,
    session_id: "sess-10",
    state: "driving",
    started_at: "t0",
    ended_at: null,
    pr: 90,
    ac_body_hash: "deadbeefcafe",
  });
  forge.throwOnAddIssueComment = true;
  const gate = new FakeMergeGate();
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(gate.calls.length, 0);
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["ac-snapshot-drift"]);
  assert.equal(
    events.length,
    1,
    "the durable event survives a comment-post failure — it was written BEFORE the comment was ever attempted",
  );
  const payload = events[0]!.payload as { labeled: number };
  assert.equal(payload.labeled, 1, "the label itself succeeded — only the comment failed");
  assert.equal(st.getWorker("lane-commentfail")?.state, "failed");
  assert.equal(st.getWorker("lane-commentfail")?.gated_escalation_labeled, 1);
  st.close();
});

// ── #301 review (P1#3): a reclaimed lane's OWN dispatch-time snapshot identity is what's
//    checked, not just "does ANY snapshot currently exist for this issue" — ac_snapshots is
//    upsert-by-issue, and a `failed`+PR lane awaiting GATED RECLAIM is NOT counted as in-flight
//    (activeWorkers() excludes `failed`), so a fresh, independent dispatch of the SAME issue
//    number can legitimately overwrite the issue-keyed snapshot while the older lane still
//    exists, un-reclaimed. ──

test("tick GATED RECLAIM/DRIVE (#301 P1#3): a reclaimed lane's stale ac_body_hash no longer matching the issue's CURRENT ac_snapshots row (a different, later lane's dispatch replaced it) escalates as an ownership anomaly — driveOne is never called against the wrong AC authority", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();

  // Lane A dispatches issue 7 with bodyA.
  const bodyA = "## Acceptance criteria\n\n- [ ] A's criterion\n\n## Verification plan\nrun tests";
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"], body: bodyA }];
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  const laneA = st.runningWorkers().find((w) => w.issue === 7)!;
  assert.ok(laneA);
  const hashA = st.getAcSnapshot(7)!.bodyHash;
  assert.equal(laneA.ac_body_hash, hashA);

  // Lane A fails with a PR, needs-human escalated (the exact shape gatedFailedWorkers() requires
  // — a real DRIVE escalation would produce this same shape; seeded directly here to isolate the
  // ownership-race property under test from the escalation machinery itself).
  st.upsertWorker({ ...laneA, state: "failed", pr: 500, ended_at: "t1", gated_escalation_labeled: 1 });
  forge.issueLabelsByIssue[7] = [cfg.labels.needsHuman];

  // A DIFFERENT, later dispatch for the SAME issue 7 — activeWorkers() excludes `failed`, so
  // DISPATCH does not consider issue 7 in-flight; bodyB overwrites the issue-keyed snapshot.
  const bodyB = "## Acceptance criteria\n\n- [ ] B's DIFFERENT criterion\n\n## Verification plan\nrun tests";
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"], body: bodyB }];
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  const laneB = st.runningWorkers().find((w) => w.issue === 7 && w.name !== laneA.name);
  assert.ok(laneB, "a second, independent lane was dispatched for the same issue");
  const hashB = st.getAcSnapshot(7)!.bodyHash;
  assert.notEqual(hashB, hashA, "the issue-keyed snapshot now belongs to lane B, not lane A");

  // A human removes needs-human -> GATED RECLAIM reactivates lane A back to driving.
  forge.issueLabelsByIssue[7] = [];
  forge.ready = []; // lane B already dispatched this tick; nothing new to dispatch
  const gate = new FakeMergeGate();
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.ok(r.gatedReclaimed.some((g) => g.kind === "reclaimed" && g.worker === laneA.name));
  // Lane A's OWN snapshot hash no longer matches the CURRENT issue-keyed snapshot (now lane B's)
  // -> the drift check must treat this as an ownership mismatch, NEVER silently drive lane A's PR
  // against lane B's AC set.
  assert.equal(
    gate.calls.some((c) => c.pr === 500),
    false,
    "driveOne must never be called for lane A's stale/mismatched snapshot",
  );
  assert.equal(st.getWorker(laneA.name)?.state, "failed", "lane A re-escalates instead of driving unprotected");
  assert.ok(forge.labelsAdded.some(([n, l]) => n === 7 && l === cfg.labels.needsHuman));
  const comment = forge.issueComments.filter(([n]) => n === 7).pop()?.[1] ?? "";
  assert.match(comment, /different, later dispatch appears to have replaced it/);
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
  await assert.rejects(() => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }), /spawn failed/);
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
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  await assert.rejects(() => tick({ now: realClock, forge, state: st, supervisor: sup, cfg }));
  assert.equal(st.pendingRollbacks().length, 1);
  assert.equal(st.pendingRollbacks()[0]?.attempts, 1);

  // Tick 2: no Ready issues (isolates the retry). Attempt #2 hits the cap -> escalate: cleared,
  // needs-human label attempted, a structured "escalated" outcome — no zombie retry loop.
  forge.ready = [];
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.getWorker("lane-dead")?.state, "failed");
  assert.equal(st.pendingRollbacks().length, 1);
  assert.deepEqual(r.rollbacks, [{ kind: "retrying", issue: 4, attempts: 1, reason: "dead-lane-requeue" }]);
  assert.deepEqual(forge.boardSet, []);

  // Next tick: forge recovers -> the persisted row is retried and cleared.
  forge.setBoardStatus = async (n, s) => {
    forge.boardSet.push([n, s]);
  };
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(r.reclaimed[0], { kind: "dead", worker: "lane-dead", issue: 4, rescued: false, costUsd: 0, modelUsage: [] });
  assert.deepEqual(r.rollbacks, [{ kind: "recovered", issue: 4, target: "ready", reason: "dead-lane-requeue" }]);
  assert.deepEqual(forge.boardSet, [[4, "ready"]]);
  assert.equal(st.pendingRollbacks().length, 0);
  st.close();
});

// ── #377 gate② round 4 (P2): the F15 fixture END-TO-END ─────────────────────────────────────
// The unit fixture calls associateLanePr() directly and the probe tests stub `lanePr`, so a
// WIRING regression between them — probe not reading the real branch, mayOpenPr wrong, the
// conductor not persisting the association — would leave every one of those green. This runs the
// live 2026-07-24 scenario through the REAL WorkerSupervisor.probe (real worktree HEAD, real
// terminal sentinel) into the REAL associateLanePr and out through the conductor's reclaim.
test("#377 F15 end-to-end: real probe -> real associateLanePr -> conductor reclaim lands on the lane's OWN branch PR, never the prose PR", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-f15-"));
  try {
    const stateDir = join(dir, "state");
    const worktreeRoot = join(dir, "worktrees");
    const lane = "lane-294-a1b2c3d4";
    const branch = "feat/294-hold-visibility-events";
    mkdirSync(stateDir, { recursive: true });

    // The lane's real worktree, exactly as the `claude` CLI leaves one: `.git` is a FILE
    // pointing at the parent repo's per-worktree gitdir, whose HEAD names the lane's branch.
    const gitDir = join(dir, "parent-git", "worktrees", lane);
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(join(worktreeRoot, lane), { recursive: true });
    writeFileSync(join(worktreeRoot, lane, ".git"), `gitdir: ${gitDir}\n`);
    writeFileSync(join(gitDir, "HEAD"), `ref: refs/heads/${branch}\n`);
    // Terminal sentinel: the worker finished (so mayOpenPr is derived, not stubbed).
    writeFileSync(join(stateDir, `${lane}.done.json`), JSON.stringify({ name: lane, issue: 294, total_cost_usd: 0 }));

    // PR #368's analog: a retro digest whose PROSE cites the issue, on some OTHER branch, with
    // no owner marker. Under the pre-#377 prose match this is what the lane adopted.
    const prosePr = { number: 368, body: "Round 7 retro digest — covers #294 and #295", branch: "retro/round-7" };
    const openPrs = [prosePr];
    const laneForge = {
      async listOpenPrsForBranch(b: string) {
        return openPrs.filter((pr) => pr.branch === b).map((pr) => ({ number: pr.number, body: pr.body }));
      },
      async listOpenPrBodies() {
        return openPrs.map((pr) => ({ number: pr.number, body: pr.body }));
      },
      async updatePRBody(n: number, body: string) {
        openPrs.find((pr) => pr.number === n)!.body = body;
      },
      async openPR(b: string, _title: string, body: string) {
        openPrs.push({ number: 372, body, branch: b });
        return 372;
      },
      async probePushedBranch(b: string): Promise<"present" | "absent" | "unknown"> {
        return b === branch ? "present" : "absent";
      },
      async getIssueMeta(issue: number) {
        return { title: `issue ${issue} title` };
      },
    };

    const supervisor = new WorkerSupervisor({
      now: realClock,
      cfg: mkCfg(),
      stateDir,
      worktreeRoot,
      claudeBin: "claude",
      heartbeatMs: 60_000,
      // The REAL association function — the only seam between probe and the forge.
      lanePr: (l) => associateLanePr(laneForge, l),
    });

    const st = new State(":memory:");
    const forge = new FakeForge();
    seedRunning(st, lane, 294);
    const r = await tick({ now: realClock, forge, state: st, supervisor, cfg: mkCfg() });

    const settled = st.getWorker(lane);
    assert.equal(settled?.state, "driving", "the lane was rescued to driving, not escalated as no-PR");
    assert.equal(settled?.pr, 372, "the engine opened and adopted the lane's OWN branch PR");
    assert.notEqual(settled?.pr, 368, "never the PR that merely cites #294 in prose");
    assert.deepEqual(r.reclaimed, [{ kind: "done", worker: lane, issue: 294, next: "DRIVING", costUsd: 0, modelUsage: [] }]);
    assert.equal(prosePr.body, "Round 7 retro digest — covers #294 and #295", "the unrelated PR is never touched");
    // The PR the engine authored carries the structural marker naming THIS lane.
    assert.deepEqual(readPrOwner(openPrs.find((pr) => pr.number === 372)!.body), { lane, issue: 294 });
    assert.deepEqual(forge.labelsAdded, [], "no needs-human escalation");
    st.close();
    supervisor.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#377 gate② round 3 (P1): a DONE lane whose PR association is UNKNOWN is DEFERRED, not escalated — and settles normally once the forge answers", async () => {
  // The harm: mayOpenPr only becomes true on the very probe the reclaim settles from, so a
  // transient `gh pr create` 502 used to escalate finished work to a human with no later probe
  // to notice the PR that a retry would have opened.
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-blip", 3);
  sup.probes["lane-blip"] = { ...DEFAULT_PROBE, done: true, hasPr: false, prAssociationInconclusive: true };

  const deferred = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(deferred.reclaimed, [], "nothing settled from an unknown association");
  assert.deepEqual(forge.labelsAdded, [], "no premature needs-human escalation");
  assert.equal(st.getWorker("lane-blip")?.state, "running", "the lane is held for the next tick's retry");
  assert.deepEqual(sup.reclaimed, [], "and never torn down as if it were DEAD");

  // Next tick: the forge recovered and the engine's retry opened/found the PR.
  sup.probes["lane-blip"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 372 };
  const settled = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(settled.reclaimed, [{ kind: "done", worker: "lane-blip", issue: 3, next: "DRIVING", costUsd: 0, modelUsage: [] }]);
  assert.equal(st.getWorker("lane-blip")?.state, "driving");
  assert.equal(st.getWorker("lane-blip")?.pr, 372);
  st.close();
});

test("#377 gate② round 3 (P1): a DEAD lane whose PR association is UNKNOWN is never requeued — no duplicate worker racing its pushed branch", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-dead", 4);
  // Confirmed-dead wrapper, no sentinel: without the deferral this requeues issue 4 to Ready and
  // a fresh worker is dispatched onto an issue whose branch is already pushed.
  sup.probes["lane-dead"] = { ...DEFAULT_PROBE, wrapperAlive: 0, hasPr: false, prAssociationInconclusive: true };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(r.reclaimed, []);
  assert.deepEqual(sup.reclaimed, [], "no teardown");
  assert.equal(st.getWorker("lane-dead")?.state, "running");
  assert.deepEqual(forge.boardSet, [], "the issue is NOT handed back to Ready");
  st.close();
});

test("#377 gate② round 3 (P1): the deferral does NOT apply under a kill switch — a drain must still settle every lane", async () => {
  // Safety-layer cross-check: a lane that refuses to settle would fight the very layer whose job
  // is to stop the engine. The drain path keeps the ordinary no-PR disposition.
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const dir = mkdtempSync(join(tmpdir(), "sapwood-conductor-"));
  try {
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const st = new State(join(dir, "sapwood.sqlite"));
    seedRunning(st, "lane-drain", 5);
    sup.probes["lane-drain"] = { ...DEFAULT_PROBE, done: true, hasPr: false, prAssociationInconclusive: true };
    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.ok(r.ceilingBreached);
    assert.equal(st.getWorker("lane-drain")?.state, "done", "a drain settles the lane by the ordinary no-PR rules");
    assert.ok(r.reclaimed.some((o) => o.worker === "lane-drain"));
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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
  await assert.rejects(() => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }), /simulated recordSpend failure/);
  assert.equal(st.getWorker("lane-x")?.state, "running", "terminal transition rolled back with the failed spend write");
  assert.equal(st.spentUsdForWorker("lane-x"), 0);
  assert.deepEqual(forge.labelsAdded, [], "the transaction never committed, so the (now-correctly-ordered) label write never ran");

  // Rerun: recordSpend recovers — the SAME still-`running` lane reclaims and records exactly once.
  st.recordSpend = realRecordSpend;
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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

  await assert.rejects(() => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }), /simulated forge failure/);
  // The #223 fix: state+spend commit BEFORE the forge write now, so a thrown label call can
  // only cost the (cosmetic) label — never the (money) ledger row.
  assert.equal(st.getWorker("lane-y")?.state, "done");
  assert.equal(st.spentUsdForWorker("lane-y"), 6);
  assert.deepEqual(forge.labelsAdded, []);

  // The worker is already terminal, so it never re-enters runningWorkers() — a rerun cannot
  // re-reclaim it and cannot double-record its spend.
  forge.throwOnAddLabel = false;
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
    await assert.rejects(() => tick({ now: realClock, forge, state: before, supervisor: sup, cfg: mkCfg() }));
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
    const r = await tick({ now: realClock, forge: forge2, state: after, supervisor: sup2, cfg: mkCfg() });
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
      () => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }),
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(r.reclaimed[0]!.kind, "kept");
  const row = st.getWorker("lane-keep");
  assert.equal(row?.state, "running"); // the lane itself is untouched — only the trio is cleared
  assert.equal(row?.est_cost_usd, null, "stale pre-restart telemetry cleared, never frozen as live");
  assert.equal(row?.context_tokens, null);
  assert.equal(row?.token_composition, null);
  st.close();
});

test("#287 (E4b, AC#1) tick reclaim: a KEEP lane's probe-carried actualModel is recorded durably onto the worker row — visible via getWorkerActualModels BEFORE any terminal reclaim", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-keep", 1);
  assert.deepEqual(st.getWorkerActualModels(1), [], "nothing observed yet");
  sup.probes["lane-keep"] = { ...DEFAULT_PROBE, actualModel: "claude-opus-4-8" };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(
    st.getWorkerActualModels(1),
    ["claude-opus-4-8"],
    "the lane is still `running` — this is the pre-terminal-settlement signal",
  );
  st.close();
});

test("#287 tick reclaim: a KEEP lane's probe carrying NO actualModel yet (session not initialized) never records anything", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-keep", 1);
  sup.probes["lane-keep"] = { ...DEFAULT_PROBE }; // no actualModel field
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(st.getWorkerActualModels(1), []);
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 5 } }) });
  assert.equal(st.getWorker("lane-driving")?.state, "driving");
  assert.deepEqual(sup.dispatched, [] as Issue[]); // the driving lane keeps capacity full -> #9 not launched
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
    triggerPin: ReviewTriggerPin;
    fallbackLock: ReviewFallbackLock | undefined;
  }> = [];
  outcomes: Record<number, DriveOutcome> = {};
  defaultOutcome: DriveOutcome = { kind: "queued", pr: 0, reason: "default" };
  /** When set, driveOne invokes the caller-supplied recordTrigger with these values before
   *  returning — simulates MergeDriver posting a fresh trigger and persisting its pin. */
  recordOnCall: [string, string] | null = null;
  /** When set, driveOne invokes the caller-supplied recordFallback with this lock (#54) —
   *  simulates resolveReviewVerdict returning a new lock. */
  recordFallbackOnCall: ReviewFallbackLock | null = null;
  recordVerdictOnCall: [string, number, boolean] | null = null;
  // #403 (F25), PR #430 gate② P1: these parameter types are the REAL `ReviewTriggerPin` /
  // `ReviewFallbackLock`, not structural look-alikes. The look-alike (`kind: string | null`
  // where the interface says `ReviewerKind | null`) is precisely why this fake was not
  // assignable to MergeGate — 87 of this file's errors — which is why the file sat on the
  // typecheck exclusion list where a missing clock could hide.
  async driveOne(
    pr: number,
    issue: number,
    triggerPin: ReviewTriggerPin,
    recordTrigger: (head: string, at: string) => void,
    fallback?: {
      lock: ReviewFallbackLock;
      recordFallback: (lock: ReviewFallbackLock) => void;
    },
    _reentered?: boolean,
    recordVerdict?: (head: string, generation: number, coverageEstablished: boolean) => void,
  ): Promise<DriveOutcome> {
    this.calls.push({ pr, issue, triggerPin, fallbackLock: fallback?.lock });
    if (this.recordOnCall) recordTrigger(...this.recordOnCall);
    if (this.recordFallbackOnCall) fallback?.recordFallback(this.recordFallbackOnCall);
    if (this.recordVerdictOnCall) recordVerdict?.(...this.recordVerdictOnCall);
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "done");
  assert.deepEqual(forge.boardSet, [[2, "done"]]);
  assert.equal(st.pendingRollbacks().length, 0);
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["merged"]).length, 1);
  assert.deepEqual(r.driven, [{ kind: "merged", worker: "lane-a", issue: 2, pr: 55 }]);
  st.close();
});

test("#250 merged Done write failure is durable and contained, then drains on the next healthy tick", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "merged", pr: 55, headOid: "H" };
  let failDone = true;
  forge.setBoardStatus = async (issue, status) => {
    if (failDone) throw new Error("transient board failure");
    forge.boardSet.push([issue, status]);
  };

  const first = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "done");
  assert.deepEqual(first.driven, [{ kind: "merged", worker: "lane-a", issue: 2, pr: 55 }]);
  assert.deepEqual(first.rollbacks, [{ kind: "retrying", issue: 2, attempts: 1, reason: "merged-board-done" }]);
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["merged"]).length, 1);
  assert.deepEqual(
    st.pendingRollbacks().map(({ issue, target, reason, attempts }) => ({ issue, target, reason, attempts })),
    [{ issue: 2, target: "done", reason: "merged-board-done", attempts: 1 }],
  );

  failDone = false;
  const second = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(second.rollbacks, [{ kind: "recovered", issue: 2, target: "done", reason: "merged-board-done" }]);
  assert.deepEqual(forge.boardSet, [[2, "done"]]);
  assert.equal(st.pendingRollbacks().length, 0);
  st.close();
});

test("#250 merged Done write honors the #31 retry cap and escalates with evidence", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "merged", pr: 55, headOid: "H" };
  forge.setBoardStatus = async () => {
    throw new Error("board permanently unavailable");
  };
  const cfg = mkCfg({ recovery: { rollbackRetryCap: 2 } });

  const first = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(first.rollbacks, [{ kind: "retrying", issue: 2, attempts: 1, reason: "merged-board-done" }]);
  const second = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(second.rollbacks, [{ kind: "escalated", issue: 2, attempts: 2, reason: "merged-board-done" }]);
  assert.equal(st.pendingRollbacks().length, 0);
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
  const escalated = st.eventsSince("1970-01-01T00:00:00.000Z", ["rollback-escalated"]);
  assert.equal(escalated.length, 1);
  assert.match(JSON.stringify(escalated[0]?.payload), /board permanently unavailable/);
  st.close();
});

test("#250 merge during a forge park queues Done at attempts 0, then drains after the park clears", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "merged", pr: 55, headOid: "H" };
  let boardAttempts = 0;
  forge.setBoardStatus = async (issue, status) => {
    boardAttempts++;
    forge.boardSet.push([issue, status]);
  };
  st.enterPark("forge", "forge down", 2, "2026-07-14T00:00:00Z");
  const cfg = mkCfg({ recovery: { rollbackRetryCap: 1 } });

  const merged = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg,
    mergeGate: gate,
    now: () => new Date("2026-07-14T00:00:01Z"),
  });
  assert.deepEqual(merged.driven, [{ kind: "merged", worker: "lane-a", issue: 2, pr: 55 }]);
  assert.deepEqual(merged.rollbacks, []);
  assert.equal(boardAttempts, 0);
  assert.deepEqual(
    st.pendingRollbacks().map(({ issue, target, reason, attempts }) => ({ issue, target, reason, attempts })),
    [{ issue: 2, target: "done", reason: "merged-board-done", attempts: 0 }],
  );

  st.clearPark("forge");
  const recovered = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(recovered.rollbacks, [{ kind: "recovered", issue: 2, target: "done", reason: "merged-board-done" }]);
  assert.equal(boardAttempts, 1);
  assert.deepEqual(forge.boardSet, [[2, "done"]]);
  assert.equal(st.pendingRollbacks().length, 0);
  st.close();
});

test("#250 crash window after terminal upsert but before pending persist remains bounded visibility drift", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-merged-board-crash-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const beforeCrash = new State(dbPath);
    beforeCrash.upsertWorker({
      name: "lane-a",
      issue: 2,
      session_id: "s-lane-a",
      state: "done",
      started_at: "2026-07-14T00:00:00Z",
      ended_at: "2026-07-14T00:01:00Z",
      pr: 55,
    });
    beforeCrash.close();

    const afterRestart = new State(dbPath);
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    const result = await tick({ now: realClock, forge, state: afterRestart, supervisor: sup, cfg: mkCfg() });
    assert.equal(afterRestart.getWorker("lane-a")?.state, "done");
    assert.equal(afterRestart.pendingRollbacks().length, 0);
    assert.deepEqual(forge.boardSet, []);
    assert.deepEqual(result.dispatched, []);
    afterRestart.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE: needs-human -> worker failed + needs-human label", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "needs-human", pr: 55, reason: "gate:HUMAN" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "failed");
  // #398 AC1: the lane HAS a PR, so the escalation was PR-born — the label lands on the PR (where
  // deriveGate reads labels and where the human deciding this lane's fate is looking) and the
  // issue is left clean. ONE carrier, never both.
  assert.deepEqual(forge.prLabelsAdded, [[55, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, []);
  assert.equal(st.getWorker("lane-a")?.gated_escalation_carrier, "pr");
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  assert.deepEqual(r.driven, [{ kind: "stopped", worker: "lane-a", issue: 2, pr: 55, reason: "gates-passed:MERGE_OK" }]);
  st.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// #294: hold-visibility events — the TRANSITION half. driveOne reports the live hold
// observation statelessly on every pass (merge-driver.test.ts covers that half); these tests
// are about what conductor.ts DOES with it: dedupe the EVENT, not the signal (#169), against
// the durable event log. Gate behavior is not exercised here at all — the FakeMergeGate's
// outcome is scripted, so these prove observability is genuinely additive.
// ─────────────────────────────────────────────────────────────────────────────

test("tick DRIVE (#294): an absent -> held -> held -> absent -> held-again label sequence emits exactly pr-held, nothing, pr-released, pr-held", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  // Every pass returns the SAME gate outcome — only the observation changes, so any emitted
  // event can only have come from the hold transition, never from the gate verdict.
  const observe = (holdObservation: DriveOutcome["holdObservation"]) => {
    gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW", ...(holdObservation ? { holdObservation } : {}) };
  };
  const runTick = () => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  const heldEvents = () => st.eventsSince("1970-01-01T00:00:00.000Z", ["pr-held", "pr-released"]);

  observe({ held: false }); // 1. no hold yet — nothing to announce
  await runTick();
  assert.deepEqual(heldEvents(), [], "an unheld lane never announces a release it never held");

  observe({ held: true, label: "sapwood:hold" }); // 2. a human applies the hold
  await runTick();
  await runTick(); // 3. steady-state held tick — re-observes the same hold, announces nothing

  observe({ held: false }); // 4. the human removes it
  await runTick();

  observe({ held: true, label: "sapwood:hold" }); // 5. held again — a NEW episode announces again
  await runTick();

  assert.deepEqual(
    heldEvents().map((e) => e.kind),
    ["pr-held", "pr-released", "pr-held"],
  );
  // Both events carry the lane + PR the dashboard's ON HOLD card keys off; pr-held names the
  // label a human applied (pr-released has no label to name — the hold is gone).
  assert.deepEqual(heldEvents()[0]!.payload, { worker: "lane-a", issue: 2, pr: 55, label: "sapwood:hold" });
  assert.deepEqual(heldEvents()[1]!.payload, { worker: "lane-a", issue: 2, pr: 55 });
  // The gate outcome itself is untouched by any of this — still the ordinary queued lane.
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  st.close();
});

test("tick DRIVE (#294): two lanes hold and release independently — one lane's episode never dedupes another's", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  seedDriving(st, "lane-b", 3, 56);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "q", holdObservation: { held: true, label: "sapwood:hold" } };
  gate.outcomes[56] = { kind: "queued", pr: 56, reason: "q", holdObservation: { held: false } };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.lastHoldEvent("lane-a", 55), "pr-held");
  assert.equal(st.lastHoldEvent("lane-b", 56), null, "lane-b was never held — lane-a's event must not speak for it");

  // Now lane-b is held while lane-a stays held: lane-b announces, lane-a stays deduped.
  gate.outcomes[56] = { kind: "queued", pr: 56, reason: "q", holdObservation: { held: true, label: "sapwood:hold" } };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  const kinds = st.eventsSince("1970-01-01T00:00:00.000Z", ["pr-held", "pr-released"]);
  assert.deepEqual(
    kinds.map((e) => (e.payload as { worker: string }).worker),
    ["lane-a", "lane-b"],
  );
  st.close();
});

test("tick DRIVE (#294): an outcome carrying NO hold observation emits nothing — the signal is purely additive", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  // Every pre-#294 outcome shape, and the engine-agent path (which never wraps the signal),
  // reaches this branch with holdObservation undefined — it must be a no-op, not a release.
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW" };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["pr-held", "pr-released"]), []);
  st.close();
});

test("tick DRIVE (#294) crash-rerun: a kill -9 between the hold observation and the next tick never double-emits pr-held (the durable event log IS the dedupe memory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-hold-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const held: DriveOutcome = {
      kind: "queued",
      pr: 55,
      reason: "gate-pending:WAIT_REVIEW",
      holdObservation: { held: true, label: "sapwood:hold" },
    };
    const before = new State(path);
    seedDriving(before, "lane-a", 2, 55);
    const gate = new FakeMergeGate();
    gate.outcomes[55] = held;
    await tick({ now: realClock, forge: new FakeForge(), state: before, supervisor: new FakeSupervisor(), cfg: mkCfg(), mergeGate: gate });
    assert.equal(before.eventsSince("1970-01-01T00:00:00.000Z", ["pr-held"]).length, 1);
    before.close(); // kill -9 — no in-memory dedupe flag survives this

    // Reopen and re-tick against the STILL-held PR. The rerun re-observes the identical hold;
    // recognising the episode as already announced can only come from on-disk state.
    const after = new State(path);
    const gate2 = new FakeMergeGate();
    gate2.outcomes[55] = held;
    await tick({ now: realClock, forge: new FakeForge(), state: after, supervisor: new FakeSupervisor(), cfg: mkCfg(), mergeGate: gate2 });
    assert.deepEqual(
      after.eventsSince("1970-01-01T00:00:00.000Z", ["pr-held", "pr-released"]).map((e) => e.kind),
      ["pr-held"],
      "exactly one pr-held survives the restart — no duplicate for the same episode",
    );
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #383 (F4): drive-queued steady-state dedupe. driveOne reports "queued" STATELESSLY on every
// DRIVE pass a lane sits on a gate-pending outcome (it has no memory) — these tests are about
// what conductor.ts DOES with that: dedupe the EVENT, not the signal (#169), the exact shape the
// #294 hold-visibility tests above pin, applied to a second per-tick steady-state site.
// ─────────────────────────────────────────────────────────────────────────────

test("tick DRIVE (#383): a WAIT-gated lane ticked repeatedly with an UNCHANGED reason emits exactly ONE drive-queued", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW" };
  const runTick = () => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  await runTick();
  await runTick();
  await runTick();
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]);
  assert.equal(events.length, 1, "steady-state re-emits nothing after the first observation");
  assert.deepEqual(events[0]!.payload, { worker: "lane-a", issue: 2, pr: 55, reason: "gate-pending:WAIT_REVIEW" });
  st.close();
});

test("tick DRIVE (#504): the queued reason reaches the LOG on the same episode-dedupe basis as the event — once per reason change, silent on steady state", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "engine-agent: checkout of deadbeef failed" };
  const logged: string[] = [];
  const runTick = () =>
    tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, log: (m) => logged.push(m) });
  await runTick();
  await runTick();
  await runTick();
  const wedgeLines = logged.filter((m) => m.includes("[sapwood:drive]"));
  assert.deepEqual(wedgeLines, ["[sapwood:drive] lane lane-a pr #55 queued: engine-agent: checkout of deadbeef failed"]);
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW" };
  await runTick();
  await runTick();
  assert.deepEqual(
    logged.filter((m) => m.includes("[sapwood:drive]")),
    [
      "[sapwood:drive] lane lane-a pr #55 queued: engine-agent: checkout of deadbeef failed",
      "[sapwood:drive] lane lane-a pr #55 queued: gate-pending:WAIT_REVIEW",
    ],
    "one log line per reason change, never per tick",
  );
  // #505 review P3: an episode reset (a fix-leg excursion) re-announces the IDENTICAL reason —
  // the log line must follow the event's episode dedupe, not compare reason strings alone.
  st.appendEvent("drive-fixup", { worker: "lane-a", issue: 2, pr: 55, reason: "gate:FIXABLE:findings" });
  await runTick();
  assert.equal(
    logged.filter((m) => m === "[sapwood:drive] lane lane-a pr #55 queued: gate-pending:WAIT_REVIEW").length,
    2,
    "same reason after a reset is a NEW episode and logs again",
  );
  st.close();
});

test("tick DRIVE (#383): a reason CHANGE (e.g. a fresh review trigger swapping in) re-emits drive-queued", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW" };
  const runTick = () => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  await runTick();
  await runTick(); // steady-state — dedupes
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "review-triggered" };
  await runTick();
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]);
  assert.deepEqual(
    events.map((e) => (e.payload as { reason: string }).reason),
    ["gate-pending:WAIT_REVIEW", "review-triggered"],
    "one append per REASON, not per tick",
  );
  st.close();
});

test("tick DRIVE (#383) crash-rerun: a kill -9 between the drive-queued observation and the next tick never double-emits (the durable event log IS the dedupe memory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-drive-queued-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const queued: DriveOutcome = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW" };
    const before = new State(path);
    seedDriving(before, "lane-a", 2, 55);
    const gate = new FakeMergeGate();
    gate.outcomes[55] = queued;
    await tick({ now: realClock, forge: new FakeForge(), state: before, supervisor: new FakeSupervisor(), cfg: mkCfg(), mergeGate: gate });
    assert.equal(before.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]).length, 1);
    before.close(); // kill -9 — no in-memory dedupe flag survives this

    // Reopen and re-tick against the STILL-queued PR. The rerun re-observes the identical
    // reason; recognising it as already announced can only come from on-disk state.
    const after = new State(path);
    const gate2 = new FakeMergeGate();
    gate2.outcomes[55] = queued;
    await tick({ now: realClock, forge: new FakeForge(), state: after, supervisor: new FakeSupervisor(), cfg: mkCfg(), mergeGate: gate2 });
    assert.equal(
      after.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]).length,
      1,
      "exactly one drive-queued survives the restart — no duplicate for the same steady state",
    );
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE (#383 round 2, PM P2): drive-queued RE-emits after a fix-leg excursion even when the reason repeats EXACTLY (WAIT -> fixable -> dispatch -> WAIT again is a NEW episode, not steady state)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  const waitOutcome: DriveOutcome = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW" };

  // 1. First observation of the WAIT episode.
  gate.outcomes[55] = waitOutcome;
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]).length, 1);

  // 2. Steady state — re-observing the SAME reason still dedupes as usual.
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]).length, 1);

  // 3. Findings land — the lane goes FIXABLE and dispatches a fix leg (drive-fixup fires, the
  // episode-reset boundary).
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(st.getWorker("lane-a")?.state, "fixing");
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]).length, 1);

  // 4. The fix leg completes and pushes; FIXING RECLAIM lands the lane back in `driving` THIS
  // SAME tick, and DRIVE re-evaluates — back to the IDENTICAL WAIT reason as step 1.
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  gate.outcomes[55] = waitOutcome;
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-a")?.state, "driving");

  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]);
  assert.equal(
    events.length,
    2,
    "the post-fix-leg WAIT observation is a NEW episode and must re-announce, even though the reason string repeats exactly",
  );
  assert.deepEqual(
    events.map((e) => (e.payload as { reason: string }).reason),
    ["gate-pending:WAIT_REVIEW", "gate-pending:WAIT_REVIEW"],
  );
  st.close();
});

test("tick DRIVE (#383 round 3, Codex P2): drive-queued RE-emits when a ledger-seeded fix-leg-started sits between two identical WAIT observations (the fixing-upsert-but-pre-drive-fixup crash window)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW" };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]).length, 1);

  // Ledger-seeded: simulate the crash window Codex's secondary review flagged directly, rather
  // than reproducing it via an actual kill -9 — `startFixLeg` (conductor.ts:536) appends
  // `fix-leg-started` the instant the lane's row flips to `fixing`, STRICTLY BEFORE the FIXUP
  // branch's own `drive-fixup` append. A process kill in that gap leaves exactly this: a
  // `fix-leg-started` on record with no `drive-fixup` to follow it.
  st.appendEvent("fix-leg-started", { worker: "lane-a", issue: 2, pr: 55, fixRounds: 1, journalCursor: 0, at: new Date().toISOString() });

  // Re-observe the IDENTICAL WAIT reason (the lane is later rescued/reclaimed and DRIVE lands on
  // the same live gate state it saw before the excursion).
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]);
  assert.equal(
    events.length,
    2,
    "fix-leg-started ALONE (no drive-fixup required) must reset the episode — closing the crash window drive-fixup-only missed",
  );
  st.close();
});

test("tick DRIVE (#383 round 3, Codex P2): drive-queued RE-emits when a ledger-seeded gated-reentry sits between two identical review-triggered observations (post-human-release reclaim is a new episode)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "review-triggered" };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]).length, 1);

  // Ledger-seeded: GATED RECLAIM's failed->driving transition (conductor.ts:2593-2604) clears
  // the review-trigger pin and re-enters DRIVE fresh — a human-mediated round trip through a
  // terminal state, not a continuation of whatever was announced before the escalation.
  st.appendEvent("gated-reentry", { worker: "lane-a", issue: 2, pr: 55, attempt: 1 });

  // The classic driver posts a fresh trigger and DRIVE observes the IDENTICAL reason string
  // again ("review-triggered" recurring is exactly how a freshly-posted trigger looks).
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-queued"]);
  assert.equal(
    events.length,
    2,
    "the post-gated-reentry trigger is a NEW episode and must re-announce, even though the reason string repeats exactly",
  );
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
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt, mintProxy },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "fixing");
  assert.equal(row.fix_rounds, 1);
  assert.equal(row.pr, 55, "same PR — never a new dispatch");
  assert.deepEqual(sup.dispatched, [] as Issue[]);
  assert.equal(sup.resumeCalls.length, 1);
  assert.equal(sup.resumeCalls[0]!.opts?.prompt, "fix #2 pr #55");
  assert.deepEqual(r.driven, [
    { kind: "fixup", worker: "lane-a", issue: 2, pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" },
  ]);
  assert.deepEqual(forge.labelsAdded, []); // no escalation — this is a normal rework dispatch
  st.close();
});

test("tick DRIVE (#270): conflict FIXABLE uses the existing lane/counter with a conflict-only prescription", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:merge-conflict", prescription: "conflict" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "base fix prompt", mintProxy: async () => ({}) as never },
  });
  const prompt = sup.resumeCalls[0]!.opts?.prompt ?? "";
  assert.match(prompt, /Conflict-only prescription/);
  assert.match(prompt, /merge that base branch from origin into\s+the existing PR branch/);
  assert.match(prompt, /Do not address\s+standing review findings/);
  assert.equal(st.getWorker("lane-a")?.fix_rounds, 1, "shared #246 counter, no conflict-specific counter");
  assert.equal(r.driven[0]?.kind, "fixup");
  st.close();
});

test("tick DRIVE (#270): conflict at the shared fix-round cap preserves label + comment before terminal upsert", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 4 }); // #450: default lanes.prFixCap raised 2 -> 4
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:merge-conflict", prescription: "conflict" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
  assert.match(forge.issueComments[0]![1], /merge-conflict/);
  assert.equal(st.getWorker("lane-a")?.state, "failed");
  assert.equal(st.getWorker("lane-a")?.gated_escalation_labeled, 1);
  assert.equal(r.driven[0]?.kind, "needs-human");
  st.close();
});

// ── #460 (F37, P2 — PR#462 review round 1): end-to-end coverage through the REAL engine-agent
// drive path, not a FakeMergeGate-scripted outcome — proves the wiring the AC actually names
// ("one structured event when the route fires") through the whole tick() DRIVE loop: a real
// MergeDriver, a real engine-agent reviewer, a real CONFLICTING PR, into conductor.ts's existing
// "fixable" handling (which is source-agnostic — the classic #270 tests above already pin its
// behavior; this proves the engine-agent route reaches it).

/** Minimal engine-agent drive deps for a lane whose conflict never touches the pin/WAL machinery
 *  (the #460 conflict route is checked BEFORE either) — still fully implements the shape so
 *  TypeScript is satisfied, in case a test's config ever drives past the conflict check. */
function mkEngineAgentDriveDeps() {
  let pin: { head: string; at: string; runId: string; kind: "decisive" | "unavailable" } | null = null;
  let wal: {
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
  } | null = null;
  return {
    now: () => new Date("2026-01-01T00:00:00.000Z"),
    newRunId: () => "run-1",
    getAttemptPin: () => pin,
    recordAttemptPin: (p: typeof pin) => {
      pin = p;
    },
    getWal: () => wal,
    recordWal: (w: { runId: string; head: string; base: string; diffHash: string; attemptStart: string }) => {
      wal = { ...w, treeManifestHash: null, decisiveOutcome: null, reviewArtifactJson: null, auditCommentId: null, auditDeliveredAt: null };
    },
    recordWalDecisiveOutcome: (runId: string, outcome: "approved" | "rejected") => {
      if (wal && wal.runId === runId) wal = { ...wal, decisiveOutcome: outcome };
    },
    auditDelivery: async () => ({ delivered: false, reason: "not exercised by this test" }),
    reconcileAuditDelivery: async () => ({ delivered: false, reason: "not exercised by this test" }),
    ciChecksCap: 20,
  };
}

test("tick DRIVE (#460, real engine-agent path): CONFLICTING PR -> fixable/prescription:'conflict' -> startFixLeg dispatches, exactly ONE drive-fixup event, fix_rounds incremented", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.prStatus = { ...forge.prStatus, mergeable: "CONFLICTING", ciGreen: false };
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const reviewer = { kind: "engine-agent" as const, evaluate: async () => ({ kind: "pending" as const, headOid: "x" }) };
  const gate = new MergeDriver({ forge, reviewer, cfg: mkCfg({ reviewer: { mode: "engine-agent", agent: { model: "sonnet" } } }) });
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg({ reviewer: { mode: "engine-agent", agent: { model: "sonnet" } } }),
    mergeGate: gate,
    engineAgentDriveDeps: mkEngineAgentDriveDeps,
    fixLegResume: { renderFixPrompt: () => "base fix prompt", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup");
  assert.match((r.driven[0] as { reason: string }).reason, /gate:FIXABLE:merge-conflict/);
  const row = st.getWorker("lane-a")!;
  assert.equal(row.fix_rounds, 1);
  assert.equal(row.state, "fixing");
  assert.equal(sup.resumeCalls.length, 1, "the fix leg actually dispatched");
  assert.equal(st.countEvents("drive-fixup"), 1, "exactly one structured event for this route firing");
  st.close();
});

test("tick DRIVE (#460, real engine-agent path): CONFLICTING at the shared fix-round cap still escalates to needs-human (same cap machinery the classic #270 conflict route uses)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.prStatus = { ...forge.prStatus, mergeable: "CONFLICTING", ciGreen: false };
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 4 }); // == default prFixCap (#450: 2 -> 4)
  const reviewer = { kind: "engine-agent" as const, evaluate: async () => ({ kind: "pending" as const, headOid: "x" }) };
  const cfg = mkCfg({ reviewer: { mode: "engine-agent", agent: { model: "sonnet" } } });
  const gate = new MergeDriver({ forge, reviewer, cfg });
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg,
    mergeGate: gate,
    engineAgentDriveDeps: mkEngineAgentDriveDeps,
    fixLegResume: { renderFixPrompt: () => "base fix prompt", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "needs-human");
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
  assert.equal(st.getWorker("lane-a")?.state, "failed");
  assert.equal(sup.resumeCalls.length, 0, "capped — no fix leg dispatched");
  st.close();
});

test("tick DRIVE (#457 x #460, breaker cause isolation on the REAL conflict route): repeated CONFLICTING fixables carry no verdictRunId and keep dispatching legs — the verdict-rerun breaker never fires for conflicts", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.prStatus = { ...forge.prStatus, mergeable: "CONFLICTING", ciGreen: false };
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const reviewer = { kind: "engine-agent" as const, evaluate: async () => ({ kind: "pending" as const, headOid: "x" }) };
  const cfg = mkCfg({ reviewer: { mode: "engine-agent", agent: { model: "sonnet" } } });
  const gate = new MergeDriver({ forge, reviewer, cfg });
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg,
    mergeGate: gate,
    engineAgentDriveDeps: mkEngineAgentDriveDeps,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };
  await tick(deps);
  st.upsertWorker({ ...st.getWorker("lane-a")!, state: "driving", ended_at: "t3" });
  const r2 = await tick(deps);
  assert.equal(r2.driven[0]?.kind, "fixup", "second conflict leg still dispatches — no breaker trip");
  assert.equal(sup.resumeCalls.length, 2);
  assert.equal(st.getWorker("lane-a")?.fix_rounds, 2);
  assert.deepEqual(forge.labelsAdded, []);
  const fixups = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  assert.equal(fixups.length, 2);
  assert.ok(
    fixups.every((e) => (e.payload as { verdictRunId?: string }).verdictRunId === undefined),
    "conflict fixables record no verdictRunId",
  );
  st.close();
});

test("tick DRIVE (#457, F36): verdict-rerun breaker — a SECOND fixable for the SAME engine-agent verdictRunId dispatches NO fix leg, spends NO fix round, and takes the cap-style escalation (label + comment before terminal upsert)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = {
    kind: "fixable",
    pr: 55,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false",
    prescription: "findings",
    verdictRunId: "run-9",
  };
  const fixLegResume = { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never };
  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume });
  assert.equal(r1.driven[0]?.kind, "fixup");
  const fixup = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  assert.equal(fixup.length, 1);
  assert.equal((fixup[0]!.payload as { verdictRunId?: string }).verdictRunId, "run-9", "the dispatch records the verdict identity");

  // The leg reclaims having pushed NOTHING: lane back to `driving`, head unmoved — the next tick
  // re-consumes the SAME pinned decisive verdict (review/drive.ts), i.e. the same verdictRunId.
  st.upsertWorker({ ...st.getWorker("lane-a")!, state: "driving", ended_at: "t3" });
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume });
  const row = st.getWorker("lane-a")!;
  assert.equal(sup.resumeCalls.length, 1, "no second paid leg for the same verdict");
  assert.equal(row.fix_rounds, 1, "no further fix round spent — the breaker fires BEFORE the counter");
  assert.equal(row.state, "failed");
  assert.equal(row.gated_escalation_labeled, 1);
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
  assert.match(forge.issueComments[0]![1], /already ran against this exact review verdict/);
  // #457 review round 1 (P2b, accepted push-failure blind spot): the comment directs the human
  // at the preserved worktree rather than the engine growing push-detection machinery.
  assert.match(forge.issueComments[0]![1], /unpushed commits/);
  assert.equal(r2.driven[0]?.kind, "needs-human");
  assert.equal((r2.driven[0] as { reason: string }).reason, "fix-leg-no-op:verdict-rerun");
  const trip = st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-verdict-rerun"]);
  assert.equal(trip.length, 1);
  assert.equal((trip[0]!.payload as { verdictRunId?: string }).verdictRunId, "run-9");
  st.close();
});

test("tick DRIVE (#457, F36): a DIFFERENT verdictRunId (head moved -> fresh review run) dispatches a fresh fix leg — the breaker keys on the verdict identity, never the lane", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  const fixable = (verdictRunId: string) =>
    ({ kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false", verdictRunId }) as const;
  gate.outcomes[55] = fixable("run-9");
  const fixLegResume = { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume });
  st.upsertWorker({ ...st.getWorker("lane-a")!, state: "driving", ended_at: "t3" });
  gate.outcomes[55] = fixable("run-10");
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume });
  assert.equal(r2.driven[0]?.kind, "fixup");
  assert.equal(sup.resumeCalls.length, 2, "a NEW verdict gets its own leg");
  assert.equal(st.getWorker("lane-a")?.fix_rounds, 2);
  assert.deepEqual(forge.labelsAdded, [], "no escalation — normal rework continues");
  st.close();
});

test("tick DRIVE (#457, F36): a fixable WITHOUT a verdictRunId (classic reviewer / conflict / fallback) never trips the breaker — repeat fixables keep dispatching up to the cap", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const fixLegResume = { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume });
  st.upsertWorker({ ...st.getWorker("lane-a")!, state: "driving", ended_at: "t3" });
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume });
  assert.equal(r2.driven[0]?.kind, "fixup");
  assert.equal(sup.resumeCalls.length, 2, "cause isolation: only engine-agent verdict fixables are breaker-eligible");
  assert.deepEqual(forge.labelsAdded, []);
  st.close();
});

test("tick DRIVE (#457 review round 1 P2, interrupted-leg amnesty): an env-failed then #447-revived leg gets a FRESH leg for the same verdict — only a completed no-op leg after the revival trips the breaker", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = {
    kind: "fixable",
    pr: 55,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false",
    verdictRunId: "run-9",
  };
  const fixLegResume = { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never };
  const deps = { now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume };
  await tick(deps); // leg 1 dispatched (drive-fixup recorded)
  // The leg is killed by an environment failure and later revived (#447) — it never completed,
  // so its dispatch record must not count as a completed no-op leg.
  st.appendEvent("env-failure-preserved", { worker: "lane-a", issue: 2, source: "quota" });
  st.appendEvent("lane-revived", { worker: "lane-a", issue: 2, pr: 55 });
  st.upsertWorker({ ...st.getWorker("lane-a")!, state: "driving", ended_at: null });
  const r2 = await tick(deps);
  assert.equal(r2.driven[0]?.kind, "fixup", "the retry leg for the interrupted one dispatches — no trip");
  assert.equal(sup.resumeCalls.length, 2);
  assert.deepEqual(forge.labelsAdded, []);
  // THAT leg completes having pushed nothing: the same pinned verdict re-consumes — NOW it trips.
  st.upsertWorker({ ...st.getWorker("lane-a")!, state: "driving", ended_at: "t4" });
  const r3 = await tick(deps);
  assert.equal(r3.driven[0]?.kind, "needs-human");
  assert.equal((r3.driven[0] as { reason: string }).reason, "fix-leg-no-op:verdict-rerun");
  assert.equal(sup.resumeCalls.length, 2, "no third leg");
  st.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// #449 (design #402 R2, §3a): the `drive-fixup` event's `findings` + `fixDiffPaths` fields —
// finding IDENTITY, not just the pre-existing `reason` gate string. See finding-key.test.ts for
// the pure key-derivation unit coverage (verification items 1-2); these tests cover the issue's
// verification items 3, 4, and 6 through the FULL tick() DRIVE loop wiring, and item 5 (the exact
// eventsAfterId round-trip R3 will perform) directly against State below.
// ─────────────────────────────────────────────────────────────────────────────

test("tick DRIVE (#449, design #402 R2, classic path): drive-fixup carries findings keyed from UNRESOLVED threads only, plus fixDiffPaths from the changed-file set", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const resolvedThread: ReviewThreadSpan = {
    id: "T-resolved",
    isResolved: true,
    isOutdated: false,
    path: "src/already-fixed.ts",
    line: 3,
    originalLine: 3,
    findingDigest: "resolved-digest",
    anchorCommitOid: "c0",
  };
  const unresolvedThread: ReviewThreadSpan = {
    id: "T-open",
    isResolved: false,
    isOutdated: false,
    path: "src/x.ts",
    line: 10,
    originalLine: 10,
    findingDigest: "open-digest",
    anchorCommitOid: "c1",
  };
  forge.prReviewData = { ...forge.prReviewData, unresolvedThreads: 1, threads: [resolvedThread, unresolvedThread] };
  forge.changedFiles = { files: [{ filename: "src/x.ts" }, { filename: "src/y.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as {
    findings: { key: string; severity: string; kind?: string }[];
    fixDiffPaths: string[];
    fixDiffPathsUnavailable?: boolean;
    head?: string;
  };
  assert.equal(payload.findings.length, 1, "the resolved thread must not appear — only the unresolved one caused this dispatch");
  assert.equal(payload.findings[0]!.severity, "blocking", "classic path: unconditionally blocking, no kind axis");
  assert.equal(payload.findings[0]!.kind, undefined);
  assert.match(payload.findings[0]!.key, /src\/x\.ts/);
  assert.match(payload.findings[0]!.key, /open-digest/);
  assert.doesNotMatch(payload.findings[0]!.key, /resolved-digest/);
  // Round 1 (no previous drive-fixup for this PR) — the full base..head set IS the preceding
  // leg's own diff (the producer's whole PR), not an approximation of it (#449 gate② P1 fix).
  assert.deepEqual(payload.fixDiffPaths, ["src/x.ts", "src/y.ts"]);
  assert.equal(payload.fixDiffPathsUnavailable, undefined);
  assert.equal(payload.head, "x", "the recorded head (PRReviewData.headOid) — the NEXT round's range start");
  st.close();
});

test("tick DRIVE (#449, design #402 R2 verification item 6, classic-path degradation): threads with NO #378 span data still record thread-id keys and complete the tick normally", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const spanlessThread: ReviewThreadSpan = {
    id: "T-spanless",
    isResolved: false,
    isOutdated: true,
    path: null,
    line: null,
    originalLine: null,
    findingDigest: null,
    anchorCommitOid: null,
  };
  forge.prReviewData = { ...forge.prReviewData, unresolvedThreads: 1, threads: [spanlessThread] };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup", "the tick completes normally — no crash, no blanked payload");
  assert.equal(st.getWorker("lane-a")?.state, "fixing");
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[0]!.payload as { findings: { key: string; severity: string }[] };
  assert.equal(payload.findings.length, 1, "an unlocated finding still produces a record — never omitted from the count");
  assert.match(payload.findings[0]!.key, /T-spanless/, "narrower thread-id-only fallback (D1: narrower, never wider)");
  st.close();
});

test("tick DRIVE (#449, design #402 R2, engine-agent path): drive-fixup re-keys the SAME validated WAL findings, effectiveSeverity applied, unlocated finding included", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  // Seed the REAL State-backed WAL row + validated artifact — the exact durable shape
  // production.ts's driveDepsForLane writes via state.recordEngineReviewWal/
  // recordEngineReviewWalArtifact (#288/#448), which gatherFixupFindingRecord reads back.
  st.recordEngineReviewWal("lane-a", { runId: "run-9", head: "h1", base: "b1", diffHash: "d1", attemptStart: "2026-01-01T00:00:00.000Z" });
  const artifact: EngineReviewArtifact = {
    perAC: [],
    findings: [
      { id: "f1", body: "a security defect", severity: "blocking", kind: "security", path: "src/x.ts" },
      // Advisory-eligible kind, NO path — proves an unlocated finding still round-trips end-to-end.
      { id: "f2", body: "nit: naming", severity: "advisory", kind: "style" },
    ],
    sessionActualModels: ["sonnet"],
    promptHash: "hash",
  };
  st.recordEngineReviewWalArtifact("lane-a", "run-9", "rejected", JSON.stringify(artifact));
  const gate = new FakeMergeGate();
  gate.outcomes[55] = {
    kind: "fixable",
    pr: 55,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false",
    verdictRunId: "run-9",
  };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[0]!.payload as { findings: { key: string; severity: string; kind?: string }[] };
  assert.equal(payload.findings.length, 2);
  const [blocking, advisory] = payload.findings;
  assert.equal(blocking!.severity, "blocking");
  assert.equal(blocking!.kind, "security");
  assert.match(blocking!.key, /security/);
  assert.match(blocking!.key, /src\/x\.ts/);
  assert.equal(advisory!.severity, "advisory", "effectiveSeverity: style is D3-eligible, requested advisory honored");
  assert.equal(advisory!.kind, "style");
  // #449 gate② Codex cross-vendor P1 fix: no path -> the "unloc" tag (JSON-tagged-tuple encoding,
  // finding-key.ts), still recorded (never omitted).
  assert.equal((JSON.parse(advisory!.key) as string[])[1], "unloc");
  st.close();
});

test("tick DRIVE (#449, design #402 R2, engine-agent path): a stale/mismatched WAL runId degrades to an empty findings array, never a crash", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  // No recordEngineReviewWal call at all for this lane — verdictRunId points at a WAL row that
  // was never written (or was since superseded), the crash-rerun shape gatherFixupFindingRecord
  // must degrade through, never throw.
  const gate = new FakeMergeGate();
  gate.outcomes[55] = {
    kind: "fixable",
    pr: 55,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false",
    verdictRunId: "run-missing",
  };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup");
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[0]!.payload as { findings: unknown[]; fixDiffPaths: unknown[]; fixDiffPathsUnavailable?: boolean; head?: string };
  assert.deepEqual(payload.findings, []);
  // No trustworthy head either (the WAL lookup failed) — fixDiffPaths has no range to compute at
  // all, so it fails narrow rather than falling back to anything (#449 gate② P1 fix).
  assert.deepEqual(payload.fixDiffPaths, []);
  assert.equal(payload.fixDiffPathsUnavailable, true);
  assert.equal(payload.head, undefined);
  st.close();
});

test("tick DRIVE (#449, design #402 R2 verification item 3): findings + fixDiffPaths are BOUNDED with truncation MARKED, never silently dropped", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  // Well over conductor.ts's private MAX_FIXUP_FINDINGS(50)/MAX_FIXUP_DIFF_PATHS(200) bounds —
  // mirrored here as literals since conductor.ts keeps them module-private (same precedent as
  // PARK_REASON_MAX_CHARS).
  const threads: ReviewThreadSpan[] = Array.from({ length: 60 }, (_, i) => ({
    id: `T-${i}`,
    isResolved: false,
    isOutdated: false,
    path: `src/f${i}.ts`,
    line: 1,
    originalLine: 1,
    findingDigest: `digest-${i}`,
    anchorCommitOid: "c1",
  }));
  forge.prReviewData = { ...forge.prReviewData, unresolvedThreads: 60, threads };
  forge.changedFiles = { files: Array.from({ length: 250 }, (_, i) => ({ filename: `src/changed-${i}.ts` })), complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=60:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[0]!.payload as {
    findings: unknown[];
    findingsTruncated?: boolean;
    fixDiffPaths: string[];
    fixDiffPathsTruncated?: boolean;
  };
  assert.equal(payload.findings.length, 50);
  assert.equal(payload.findingsTruncated, true, "marked, not silently dropped");
  assert.equal(payload.fixDiffPaths.length, 200);
  assert.equal(payload.fixDiffPathsTruncated, true, "marked, not silently dropped");
  st.close();
});

test("tick DRIVE (#449, design #402 R2): under the bound -> no truncation flag at all (absent-means-false, matching severityOverridden/pathDropped's own convention)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[0]!.payload as Record<string, unknown>;
  assert.equal("findingsTruncated" in payload, false);
  assert.equal("fixDiffPathsTruncated" in payload, false);
  assert.equal("fixDiffPathsUnavailable" in payload, false);
  st.close();
});

test("tick DRIVE (#449, design #402 R2 verification item 4, prose-free): a finding's body text never reaches the serialized drive-fixup payload", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const SENTINEL = "SENTINEL_PROSE_MARKER_7f3a";
  st.recordEngineReviewWal("lane-a", { runId: "run-9", head: "h1", base: "b1", diffHash: "d1", attemptStart: "2026-01-01T00:00:00.000Z" });
  const artifact: EngineReviewArtifact = {
    perAC: [],
    findings: [
      {
        id: "f1",
        body: `this finding's body contains ${SENTINEL} and must never leak into the record`,
        severity: "blocking",
        kind: "security",
        path: "src/x.ts",
      },
    ],
    sessionActualModels: ["sonnet"],
    promptHash: "hash",
  };
  st.recordEngineReviewWalArtifact("lane-a", "run-9", "rejected", JSON.stringify(artifact));
  const gate = new FakeMergeGate();
  gate.outcomes[55] = {
    kind: "fixable",
    pr: 55,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false",
    verdictRunId: "run-9",
  };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const serialized = JSON.stringify(events[0]!.payload);
  assert.doesNotMatch(
    serialized,
    new RegExp(SENTINEL),
    "the finding body must never reach the drive-fixup payload — keys/severity/kind only",
  );
  st.close();
});

test("state.eventsAfterId (#449 verification item 5): round r-1's finding set round-trips through the exact id-cursor read R3 will perform — no timestamp comparison anywhere", () => {
  const st = new State(":memory:");
  const cursor = st.maxEventId();
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false",
    findings: [{ key: "classic:src/x.ts:digest-1", severity: "blocking" }],
    fixDiffPaths: ["src/x.ts"],
  });
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 2,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false",
    findings: [{ key: "classic:src/x.ts:digest-1", severity: "blocking" }],
    fixDiffPaths: ["src/x.ts", "src/y.ts"],
  });
  // A DIFFERENT (worker, pr)'s round must never leak into this PR's read.
  st.appendEvent("drive-fixup", {
    worker: "lane-b",
    issue: 3,
    pr: 56,
    fixRounds: 1,
    reason: "r",
    findings: [{ key: "classic:src/z.ts:digest-9", severity: "blocking" }],
    fixDiffPaths: ["src/z.ts"],
  });
  const all = st
    .eventsAfterId(cursor, ["drive-fixup"])
    .map(
      (e) =>
        e.payload as {
          worker: string;
          pr: number;
          fixRounds: number;
          findings: { key: string; severity: string }[];
          fixDiffPaths: string[];
        },
    )
    .filter((p) => p.worker === "lane-a" && p.pr === 55);
  assert.equal(all.length, 2, "both of lane-a's rounds for PR #55, id-ordered");
  const roundOneMinusOne = all[0]!; // "round r-1" relative to the second dispatch
  assert.deepEqual(roundOneMinusOne.findings, [{ key: "classic:src/x.ts:digest-1", severity: "blocking" }]);
  assert.deepEqual(roundOneMinusOne.fixDiffPaths, ["src/x.ts"]);
  const roundR = all[1]!;
  assert.deepEqual(roundR.fixDiffPaths, ["src/x.ts", "src/y.ts"]);
  st.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// #449 gate② P1 fix (design #402 R2): `fixDiffPaths` reworked after gate② review confirmed the
// shipped v1 (the PR's FULL base..head changed-path set, every round) made design §3b's
// `recurrence`/`marginal-complexity` predicates trivially true for every located finding — since
// R1 constrains every located finding's `path` to that SAME full set. The fix: a RANGE diff off
// the PRECEDING drive-fixup's own recorded `head` (`IForge.compareChangedFiles`), falling back to
// the full set ONLY for the genuinely exact round-1 case, and failing NARROW (empty + marked
// `fixDiffPathsUnavailable`) everywhere else — never a silent full-set fallback, which would just
// reproduce the same defect one round later.
// ─────────────────────────────────────────────────────────────────────────────

test("tick DRIVE (#449 gate② P1 fix): round 2's fixDiffPaths is the RANGE since the PRECEDING round's head, not the PR's full changed-path set", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const openThread = (id: string): ReviewThreadSpan => ({
    id,
    isResolved: false,
    isOutdated: false,
    path: "src/x.ts",
    line: 1,
    originalLine: 1,
    findingDigest: `digest-${id}`,
    anchorCommitOid: "c1",
  });
  // Round 1: head H1, the full PR touches ONLY src/full-pr-file.ts. No previous drive-fixup for
  // this PR — the full base..head set is EXACT here, unchanged from before the fix.
  forge.prReviewData = { ...forge.prReviewData, headOid: "H1", unresolvedThreads: 1, threads: [openThread("T1")] };
  forge.changedFiles = { files: [{ filename: "src/full-pr-file.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };
  await tick(deps);
  const round1 = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"])[0]!.payload as { fixDiffPaths: string[]; head?: string };
  assert.deepEqual(round1.fixDiffPaths, ["src/full-pr-file.ts"], "round 1: the full base..head set, exact");
  assert.equal(round1.head, "H1");
  assert.equal(forge.compareCalls.length, 0, "round 1 never calls the range primitive — getPRChangedFiles is exact there");

  // The fix leg pushes: head moves H1 -> H2. Land the lane back in `driving` (mirrors #457's own
  // fixture pattern) so DRIVE re-evaluates a SECOND fixable.
  st.upsertWorker({ ...st.getWorker("lane-a")!, state: "driving", ended_at: "t3" });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", threads: [openThread("T2")] };
  // Script the RANGE result: only src/round2-only-file.ts changed between H1 and H2 — a file the
  // full-PR set (still "src/full-pr-file.ts" only, unchanged) does NOT contain, so this proves
  // the range read is actually driving the result, not a coincidental overlap.
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/round2-only-file.ts" }], complete: true };

  await tick(deps);
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  assert.equal(events.length, 2);
  const round2 = events[1]!.payload as { fixDiffPaths: string[]; fixDiffPathsUnavailable?: boolean; head?: string };
  assert.deepEqual(round2.fixDiffPaths, ["src/round2-only-file.ts"], "round 2: the RANGE since round 1's head — never the full PR set");
  assert.equal(round2.fixDiffPathsUnavailable, undefined);
  assert.equal(round2.head, "H2");
  assert.deepEqual(forge.compareCalls, [["H1", "H2"]], "exactly one range compare, against the PRECEDING round's recorded head");
  st.close();
});

test("tick DRIVE (#449 gate② P1 fix, P3b): compareChangedFiles renames carry BOTH filename and previousFilename into fixDiffPaths", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r",
    findings: [],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 0, threads: [] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/new-name.ts", previousFilename: "src/old-name.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[1]!.payload as { fixDiffPaths: string[] };
  assert.deepEqual(new Set(payload.fixDiffPaths), new Set(["src/new-name.ts", "src/old-name.ts"]));
  st.close();
});

test("tick DRIVE (#449 gate② P1 fix): identical previous/current head (a classic fix leg that resolved threads without pushing) -> EXACT empty range, never a compare call", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r",
    findings: [],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H1", unresolvedThreads: 1, threads: [] }; // SAME head as the recorded round
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[1]!.payload as { fixDiffPaths: string[]; fixDiffPathsUnavailable?: boolean };
  assert.deepEqual(payload.fixDiffPaths, []);
  assert.equal(payload.fixDiffPathsUnavailable, undefined, "a genuinely zero-width range is EXACT, not unavailable");
  assert.equal(forge.compareCalls.length, 0, "short-circuited — no compare call for a same-head range");
  st.close();
});

test("tick DRIVE (#449 gate② P1 fix, P4): compareChangedFiles throwing (e.g. a 404 on a force-pushed-away prior head) -> EMPTY + marked unavailable, NEVER a silent full-set fallback", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r",
    findings: [],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 0, threads: [] };
  forge.throwOnCompareChangedFiles = true;
  // If the rejected fallback ever regresses back in, THIS is what it would wrongly return —
  // asserting fixDiffPaths is empty (not this) is the regression pin.
  forge.changedFiles = { files: [{ filename: "src/the-forbidden-full-set-fallback.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[1]!.payload as { fixDiffPaths: string[]; fixDiffPathsUnavailable?: boolean };
  assert.deepEqual(payload.fixDiffPaths, []);
  assert.equal(payload.fixDiffPathsUnavailable, true);
  st.close();
});

test("tick DRIVE (#449 gate② P1 fix, P3a): compareChangedFiles complete:false (GitHub's own file-count ceiling) -> EMPTY + marked unavailable, never trusted as a partial list", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r",
    findings: [],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 0, threads: [] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/partial.ts" }], complete: false };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[1]!.payload as { fixDiffPaths: string[]; fixDiffPathsUnavailable?: boolean };
  assert.deepEqual(payload.fixDiffPaths, []);
  assert.equal(payload.fixDiffPathsUnavailable, true, "a possibly-partial file list is never trusted for path-membership testing");
  st.close();
});

test("tick DRIVE (#449 gate② P1 fix): round-1's OWN getPRChangedFiles returning complete:false is ALSO treated as unavailable (not just the compare path)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.changedFiles = { files: [{ filename: "src/partial.ts" }], complete: false };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[0]!.payload as { fixDiffPaths: string[]; fixDiffPathsUnavailable?: boolean };
  assert.deepEqual(payload.fixDiffPaths, []);
  assert.equal(payload.fixDiffPathsUnavailable, true);
  st.close();
});

test("tick DRIVE (#449 gate② P1 fix): a previous drive-fixup that PREDATES the `head` field (deploy-transition edge) fails narrow, never the rejected full-set fallback", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  // A pre-#449-P1-fix drive-fixup event — no `head` field at all (the exact shape every event
  // before this fix round carries).
  st.appendEvent("drive-fixup", { worker: "lane-a", issue: 2, pr: 55, fixRounds: 1, reason: "r", findings: [], fixDiffPaths: [] });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 0, threads: [] };
  forge.changedFiles = { files: [{ filename: "src/the-forbidden-full-set-fallback.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const payload = events[1]!.payload as { fixDiffPaths: string[]; fixDiffPathsUnavailable?: boolean };
  assert.deepEqual(payload.fixDiffPaths, []);
  assert.equal(payload.fixDiffPathsUnavailable, true);
  assert.equal(forge.compareCalls.length, 0, "no known range start — never even attempts a compare call");
  st.close();
});

test("tick DRIVE (#449 gate② P2 fix): the confirmed-spawn -> drive-fixup-append window is a single synchronous call — gathering happens BEFORE startFixLeg", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false" };
  // A startFixLeg failure (resume() throws) must land the pre-#449 "row untouched, retried next
  // tick" outcome regardless of how much gathering work already ran — proving gathering moved
  // before the spawn attempt introduces no new failure coupling.
  sup.resumeShouldThrow = "simulated resume failure";
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-leg-dispatch-failed/);
  assert.equal(st.getWorker("lane-a")?.state, "driving", "untouched — startFixLeg's own thrown-resume contract");
  assert.equal(st.getWorker("lane-a")?.fix_rounds ?? 0, 0);
  assert.equal(st.countEvents("drive-fixup"), 0, "no drive-fixup for a leg that never actually spawned");
  st.close();
});

test("priorFixLegForVerdict (#457): matches only the SAME lane's drive-fixup with the SAME verdictRunId; classic drive-fixup events (no verdictRunId) never match", () => {
  const st = new State(":memory:");
  assert.equal(priorFixLegForVerdict(st, "lane-a", "run-9"), false);
  st.appendEvent("drive-fixup", { worker: "lane-a", issue: 2, pr: 55, fixRounds: 1, reason: "r" }); // classic: no verdictRunId
  assert.equal(priorFixLegForVerdict(st, "lane-a", "run-9"), false);
  st.appendEvent("drive-fixup", { worker: "lane-a", issue: 2, pr: 55, fixRounds: 2, reason: "r", verdictRunId: "run-9" });
  assert.equal(priorFixLegForVerdict(st, "lane-a", "run-9"), true);
  assert.equal(priorFixLegForVerdict(st, "lane-b", "run-9"), false, "another lane's dispatch never matches");
  assert.equal(priorFixLegForVerdict(st, "lane-a", "run-10"), false, "another verdict never matches");
  st.close();
});

test("priorFixLegForVerdict (#457 review round 1 P2): interruption events amnesty ONLY the same lane's earlier dispatches — later completed legs trip again", () => {
  const st = new State(":memory:");
  st.appendEvent("drive-fixup", { worker: "lane-a", issue: 2, pr: 55, fixRounds: 1, reason: "r", verdictRunId: "run-9" });
  assert.equal(priorFixLegForVerdict(st, "lane-a", "run-9"), true);
  st.appendEvent("env-failure-preserved", { worker: "lane-a", issue: 2, source: "quota" });
  assert.equal(priorFixLegForVerdict(st, "lane-a", "run-9"), false, "an interrupted leg's dispatch is amnestied");
  st.appendEvent("lane-revived", { worker: "lane-a", issue: 2, pr: 55 });
  assert.equal(priorFixLegForVerdict(st, "lane-a", "run-9"), false, "revival keeps the amnesty");
  st.appendEvent("drive-fixup", { worker: "lane-a", issue: 2, pr: 55, fixRounds: 2, reason: "r", verdictRunId: "run-9" });
  assert.equal(priorFixLegForVerdict(st, "lane-a", "run-9"), true, "the post-revival completed leg trips normally");
  st.appendEvent("env-failure-preserved", { worker: "lane-b", issue: 3, source: "quota" });
  assert.equal(priorFixLegForVerdict(st, "lane-a", "run-9"), true, "another lane's interruption forgives nothing here");
  st.close();
});

// ── #451 (design #402 §4/§4a/D4): review-disputed escalation — a disputed thread costs zero
// paid fix legs. Verification plan items 1-5, 7, 8 (fix-response.test.ts's item 6 covers the
// speak-not-act extension). ────────────────────────────────────────────────────────────────

const disputedGate = (pr = 55, reason = "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false"): DriveOutcome =>
  ({ kind: "fixable", pr, reason, prescription: "findings" }) as const;

test("tick DRIVE (#451, AC1): a FIXABLE tick whose ONE unresolved current-head thread is durably `disputed` for that head escalates needs-human with reason review-disputed, dispatches NO fix leg, and costs ZERO fix rounds", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      {
        id: "PRRT_1",
        isResolved: false,
        commentsComplete: true,
        comments: [
          { author: "codex", body: "this looks like a real bug", createdAt: "t0" },
          { author: "producer", body: "disagree — see design doc §3", createdAt: "t1" },
        ],
      },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [
    { threadId: "PRRT_1", resolution: "disputed", reply: "disagree — see design doc §3" },
  ]);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const fixLegResume = { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume });

  // Assert on the spawn NOT happening — not only on the label (verification plan item 1).
  assert.deepEqual(sup.resumeCalls, [], "no fix leg dispatched");
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "failed");
  assert.equal(row.fix_rounds ?? 0, 0, "zero fix rounds spent (AC3)");
  assert.equal(row.gated_escalation_labeled, 1);
  assert.deepEqual(forge.prLabelsAdded, [[55, "needs-human"]]); // #398: PR-born escalation, PR carrier
  assert.deepEqual(forge.labelsAdded, []);
  assert.equal(r.driven.length, 1);
  assert.equal(r.driven[0]!.kind, "needs-human");
  assert.match((r.driven[0] as { reason: string }).reason, /^review-disputed:/);
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed"]);
  assert.equal(events.length, 1);
  assert.deepEqual((events[0]!.payload as { threads: string[] }).threads, ["PRRT_1"]);
  st.close();
});

test("tick DRIVE (#451, AC4): the escalation comment carries all five evidence items — thread id, reviewer finding body, producer reply verbatim, head OID, fix rounds spent", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 });
  forge.prStatus = { ...forge.prStatus, headOid: "head-7" };
  forge.reviewThreadsOverride = {
    threads: [
      {
        id: "PRRT_evidence",
        isResolved: false,
        commentsComplete: true,
        comments: [{ author: "codex", body: "THE REVIEWER FINDING BODY", createdAt: "t0" }],
      },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(
    st,
    "lane-a",
    2,
    55,
    "head-7",
    [{ threadId: "PRRT_evidence", resolution: "disputed", reply: "THE PRODUCER REPLY VERBATIM" }],
    2,
  );
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(forge.prComments.length, 1);
  const comment = forge.prComments[0]![1];
  assert.match(comment, /PRRT_evidence/, "thread id");
  assert.match(comment, /THE REVIEWER FINDING BODY/, "reviewer finding body");
  assert.match(comment, /THE PRODUCER REPLY VERBATIM/, "producer reply verbatim");
  assert.match(comment, /head-7/, "head OID");
  assert.match(comment, /2 fix round/, "fix rounds spent");
  st.close();
});

test("tick DRIVE (#451, AC2): a MIX of unresolved threads (one disputed, one still unanswered) does NOT escalate — dispatches the fix leg as today", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      {
        id: "PRRT_disputed",
        isResolved: false,
        commentsComplete: true,
        comments: [{ author: "codex", body: "finding A", createdAt: "t0" }],
      },
      { id: "PRRT_open", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding B", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  // Only ONE of the two unresolved threads has a recorded disputed resolution — the other was
  // never answered by any fix round at all.
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_disputed", resolution: "disputed", reply: "disagree" }]);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup", "the deliberate non-escalation — a leg still dispatches");
  assert.equal(st.getWorker("lane-a")?.fix_rounds, 1);
  assert.deepEqual(forge.labelsAdded, [], "no escalation this tick");
  assert.deepEqual(forge.prLabelsAdded, [], "#398: nor on the carrier this escalation would now use");
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed"]), []);
  st.close();
});

test("tick DRIVE (#451, AC2 mix variant): one disputed + one durably ADDRESSED-but-still-unresolved (resolve retry in flight) does NOT escalate", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      {
        id: "PRRT_disputed",
        isResolved: false,
        commentsComplete: true,
        comments: [{ author: "codex", body: "finding A", createdAt: "t0" }],
      },
      {
        id: "PRRT_addressed",
        isResolved: false,
        commentsComplete: true,
        comments: [{ author: "codex", body: "finding B", createdAt: "t0" }],
      },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [
    { threadId: "PRRT_disputed", resolution: "disputed", reply: "disagree" },
    { threadId: "PRRT_addressed", resolution: "addressed", reply: "fixed it" },
  ]);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup", "addressed-but-unresolved is not a dispute — normal rework continues");
  st.close();
});

test("tick DRIVE (#451, AC3): fix_rounds is UNCHANGED across the escalating tick, whether zero or nonzero on entry", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 3 });
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(st.getWorker("lane-a")!.fix_rounds, 3, "fix_rounds carried through unchanged, never incremented");
  st.close();
});

test("tick DRIVE (#451, AC6): a disputed record against an OLDER head does not trigger the escalation once the PR is at a NEWER head — fail-closed, dispatches the fix leg as normal", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-NEW" }; // the PR moved since the dispute
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-OLD", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup", "stale-head dispute never escalates — normal FIXUP proceeds");
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.prLabelsAdded, []); // #398: the carrier this escalation would use, also clean
  st.close();
});

test("tick DRIVE (#451, AC6 unknown-head variant): an unreadable live head read (forge error) fails CLOSED — never escalates, falls through to the normal decision", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  forge.getPRStatus = () => {
    throw new Error("simulated forge outage");
  };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup", "unreadable head -> fail closed, never escalates");
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.prLabelsAdded, []); // #398: ditto
  st.close();
});

test("tick DRIVE (#451, §4a): zero live unresolved threads (the engine-agent case — no thread-creating forge write exists) never escalates via review-disputed, regardless of what fix-response-queued records — the predicate is structurally a no-op there", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = { threads: [], pageCapped: false }; // engine-agent: no threads at all
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup");
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.prLabelsAdded, []); // #398: ditto
  st.close();
});

test("tick DRIVE (#451, disjointness from #457): a review-disputed-eligible tick NEVER also carries a verdictRunId, and the verdict-rerun breaker's own fixables (which always carry zero live threads in these fixtures) never trip review-disputed — the two escalation paths are mutually exclusive by construction", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const fixLegResume = { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never };

  // Lane A: classic-reviewer dispute path — a live unresolved thread, no verdictRunId.
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);

  // Lane B: engine-agent verdict-rerun path — carries verdictRunId, zero live threads (§4a).
  seedDriving(st, "lane-b", 3, 66);
  st.appendEvent("drive-fixup", { worker: "lane-b", issue: 3, pr: 66, fixRounds: 1, reason: "r", verdictRunId: "run-1" });

  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  gate.outcomes[66] = {
    kind: "fixable",
    pr: 66,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false",
    prescription: "findings",
    verdictRunId: "run-1",
  };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate, fixLegResume });

  const byWorker = new Map(r.driven.map((d) => [(d as { worker: string }).worker, d]));
  assert.equal(byWorker.get("lane-a")?.kind, "needs-human");
  assert.match((byWorker.get("lane-a") as { reason: string }).reason, /^review-disputed:/);
  assert.equal(byWorker.get("lane-b")?.kind, "needs-human");
  assert.equal((byWorker.get("lane-b") as { reason: string }).reason, "fix-leg-no-op:verdict-rerun");
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed"]).length, 1);
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-verdict-rerun"]).length, 1);
  st.close();
});

test("tick DRIVE (#451, gate② P3b): a fixable carrying verdictRunId (engine-agent-caused) SKIPS computeDisputeEscalation's two forge reads entirely — a cost cut on top of the structural null, not a behavior change", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-b", 3, 66);
  st.appendEvent("drive-fixup", { worker: "lane-b", issue: 3, pr: 66, fixRounds: 1, reason: "r", verdictRunId: "run-1" });
  const gate = new FakeMergeGate();
  gate.outcomes[66] = {
    kind: "fixable",
    pr: 66,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false",
    prescription: "findings",
    verdictRunId: "run-1",
  };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(forge.getPRStatusCalls, 0, "getPRStatus never called for a verdictRunId-bearing fixable");
  assert.equal(forge.getPRReviewThreadsCalls, 0, "getPRReviewThreads never called for a verdictRunId-bearing fixable");
  st.close();
});

test("tick DRIVE (#451, gate② P3b contrast): a classic-reviewer fixable (no verdictRunId) DOES call both forge reads exactly once", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = { threads: [], pageCapped: false };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(forge.getPRStatusCalls, 1);
  assert.equal(forge.getPRReviewThreadsCalls, 1);
  st.close();
});

test("tick DRIVE (#451, gate② round 3 P1): the terminal worker update + review-disputed event are ONE transaction — a failing event append rolls the worker row back too, never a `failed` lane with no durable escalation record", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  const originalAppendEvent = st.appendEvent.bind(st);
  st.appendEvent = ((kind: string, payload: unknown) => {
    if (kind === "review-disputed") throw new Error("simulated event-append failure");
    return originalAppendEvent(kind, payload);
  }) as typeof st.appendEvent;
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };
  await assert.rejects(() => tick(deps));
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving", "rolled back — the OLD two-write shape would have left this `failed` with no event");
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed"]), []);

  // The forge-side writes (label, comment) already landed — external, outside the transaction —
  // and the system self-heals: restore appendEvent and retry. The comment-idempotency marker
  // (gate② round 3 P2) means the SECOND attempt does not re-post a duplicate comment.
  st.appendEvent = originalAppendEvent;
  const r2 = await tick(deps);
  assert.equal(r2.driven[0]?.kind, "needs-human");
  assert.equal(st.getWorker("lane-a")!.state, "failed");
  assert.equal(forge.prComments.length, 1, "no duplicate comment on the self-healed retry");
  st.close();
});

test("tick DRIVE (#451, AC7): a review-disputed escalation is reclaimable through the existing #147 GATED RECLAIM path once a human clears the label — no new re-entry channel", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(st.getWorker("lane-a")!.state, "failed");
  assert.equal(st.getWorker("lane-a")!.gated_escalation_labeled, 1);
  assert.equal(st.gatedFailedWorkers().length, 1, "visible to GATED RECLAIM's own read path");

  // A human clears the label — the existing #147 mechanism, unmodified, reclaims it. (DRIVE
  // runs again THIS SAME tick against the freshly-reclaimed lane — #147's own documented
  // "same tick sees the reclaim" — and, since nothing about the underlying dispute changed,
  // FakeMergeGate's static outcome re-derives the identical escalation immediately; that is
  // correct, not a test artifact. The claim this test pins is narrower and prior to that: the
  // GENERIC #147 mechanism reclaimed the row at all, with zero review-disputed-specific code.)
  forge.prLabelsByPr[55] = []; // #398: the human clears the carrier the escalation used — the PR
  const r2 = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.deepEqual(r2.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-a", issue: 2, pr: 55, attempt: 1 }]);
  st.close();
});

test("#398 (review round 2): a review-disputed escalation is PR-BORN — label AND adjudication comment land on the PR, the issue stays clean, and the receipt names the carrier", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  // `pr` is a required, non-nullable parameter here and the comment text is entirely about that
  // PR — this is the same PR-born shape as escalateNeedsHuman, so it takes the same carrier.
  assert.deepEqual(forge.prLabelsAdded, [[55, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.issueComments, [], "the adjudication instruction follows the label onto the PR");
  assert.equal(forge.prComments.length, 1);
  assert.match(forge.prComments[0]![1], /every unresolved review thread on the current head/);
  assert.match(forge.prComments[0]![1], /from this pull request/, "the removal instruction names the object that carries the label");
  const row = st.getWorker("lane-a")!;
  assert.equal(row.gated_escalation_labeled, 1);
  assert.equal(row.gated_escalation_carrier, "pr");
  const payload = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed"])[0]!.payload as { carrier: string };
  assert.equal(payload.carrier, "pr", "the reconciler reads the carrier off this payload — without it, a clean issue false-clears");
  st.close();
});

test("tick DRIVE (#451, forge-write-failure ordering): a label-write failure leaves the row driving (retried next tick), never escalates without the label landing", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  forge.throwOnAddPRLabel = true; // #398: the carrier this escalation writes
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving", "no terminal transition without the label landing");
  assert.equal(r.driven[0]?.kind, "queued");
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed"]), [], "no event without a successful label write");
  const failedLabelEvents = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed-label-failed"]);
  assert.equal(failedLabelEvents.length, 1);
  st.close();
});

test("tick DRIVE (#451, gate② P3c): a comment-write failure (label already landed) leaves the row driving, never terminalizes, no review-disputed event — the comment-failure ordering leg", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  forge.throwOnAddPRComment = true; // #398: the carrier this escalation comments on
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving", "no terminal transition without the comment landing");
  assert.equal(row.fix_rounds ?? 0, 0);
  assert.equal(r.driven[0]?.kind, "queued");
  assert.deepEqual(
    st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed"]),
    [],
    "no success event without a successful comment write",
  );
  assert.deepEqual(forge.prLabelsAdded, [[55, "needs-human"]], "the label DID land — this is the ordering-after-label leg");
  const failedCommentEvents = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed-comment-failed"]);
  assert.equal(failedCommentEvents.length, 1);
  assert.equal((failedCommentEvents[0]!.payload as { headOid: string }).headOid, "head-2");
  st.close();
});

test("tick DRIVE (#451, gate② P1): a comment-write failure that keeps failing across MANY ticks appends review-disputed-comment-failed ONCE, not per tick — the #383/#465 transition-dedupe convention, not steady-state spam", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  forge.throwOnAddPRComment = true;
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };
  for (let i = 0; i < 5; i++) await tick(deps);
  assert.equal(
    st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed-comment-failed"]).length,
    1,
    "same episode (same headOid, no reset in between) — one announcement, not five",
  );

  // A genuinely NEW episode (the PR moved to a different head) re-announces.
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_2", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding 2", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  forge.prStatus = { ...forge.prStatus, headOid: "head-3" };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-3", [{ threadId: "PRRT_2", resolution: "disputed", reply: "disagree again" }], 2);
  await tick(deps);
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed-comment-failed"]);
  assert.equal(events.length, 2, "a different headOid is a genuinely new episode, not eaten by the dedup");
  assert.equal((events[1]!.payload as { headOid: string }).headOid, "head-3");
  st.close();
});

test("tick DRIVE (#451, gate② P1): the assembled comment stays under GitHub's limit — per-item and whole-comment truncation, marked, never silent, and the write SUCCEEDS (no permanent-failure wedge) on a pathologically long reply", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  const longFinding = "F".repeat(100_000);
  const longReply = "R".repeat(100_000);
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: longFinding, createdAt: "t0" }] },
      { id: "PRRT_2", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: longFinding, createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [
    { threadId: "PRRT_1", resolution: "disputed", reply: longReply },
    { threadId: "PRRT_2", resolution: "disputed", reply: longReply },
  ]);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "needs-human", "the comment posts successfully — no permanent wedge");
  assert.equal(forge.prComments.length, 1);
  const comment = forge.prComments[0]![1];
  assert.ok(comment.length < 65_536, `comment length ${comment.length} must stay under GitHub's limit`);
  assert.match(comment, /truncated/, "the cut is marked, never silent");
  st.close();
});

test("tick DRIVE (#451, gate② round 3 P2): a label-write failure that keeps failing across MANY ticks appends review-disputed-label-failed ONCE, not per tick — the SAME transition-dedupe the comment path already had", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  forge.throwOnAddPRLabel = true;
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };
  for (let i = 0; i < 5; i++) await tick(deps);
  assert.equal(
    st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed-label-failed"]).length,
    1,
    "same episode (same headOid, no reset in between) — one announcement, not five",
  );

  // A genuinely new episode (a different head) re-announces.
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_2", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding 2", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  forge.prStatus = { ...forge.prStatus, headOid: "head-3" };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-3", [{ threadId: "PRRT_2", resolution: "disputed", reply: "disagree again" }], 2);
  await tick(deps);
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-disputed-label-failed"]);
  assert.equal(events.length, 2, "a different headOid is a genuinely new episode, not eaten by the dedup");
  assert.equal((events[1]!.payload as { headOid: string }).headOid, "head-3");
  st.close();
});

test("tick DRIVE (#451, gate② round 3 P2): an AMBIGUOUS comment-write failure (GitHub created it, client saw an error) does NOT re-post a duplicate comment on retry — the marker-check-before-post path", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  forge.prStatus = { ...forge.prStatus, headOid: "head-2" };
  forge.reviewThreadsOverride = {
    threads: [
      { id: "PRRT_1", isResolved: false, commentsComplete: true, comments: [{ author: "codex", body: "finding", createdAt: "t0" }] },
    ],
    pageCapped: false,
  };
  seedFixResponseQueued(st, "lane-a", 2, 55, "head-2", [{ threadId: "PRRT_1", resolution: "disputed", reply: "disagree" }]);
  forge.ambiguousAddPRComment = true;
  const gate = new FakeMergeGate();
  gate.outcomes[55] = disputedGate();
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };
  const r1 = await tick(deps);
  assert.equal(r1.driven[0]?.kind, "queued", "the client-visible outcome is still a failure this tick");
  assert.equal(forge.prComments.length, 1, "but the comment DID land server-side");
  assert.equal(st.getWorker("lane-a")!.state, "driving");

  // The client's next retry must not duplicate it — the marker-check finds it and skips the post.
  const r2 = await tick(deps);
  assert.equal(r2.driven[0]?.kind, "needs-human", "the marker-check finds it already posted -> proceeds straight to success");
  assert.equal(forge.prComments.length, 1, "no duplicate comment");
  assert.equal(st.getWorker("lane-a")!.state, "failed");
  st.close();
});

test("tick DRIVE (#246 review round 1, C1): fixable but NO fixLegResume dep configured -> DEGRADES to the pre-#246 needs-human escalation (visible, actionable), never a silent retry-forever", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // no fixLegResume
  const row = st.getWorker("lane-a")!;
  // Same terminal shape the plain gate===HUMAN case produces (escalateNeedsHuman, shared code):
  // failed + pr retained + label applied + gated_escalation_labeled=1 — an operator sees
  // needs-human on the issue exactly like pre-#246, not a lane silently stuck in `driving`.
  assert.equal(row.state, "failed");
  assert.equal(row.pr, 55);
  assert.equal(row.fix_rounds ?? 0, 0);
  assert.equal(row.gated_escalation_labeled, 1);
  assert.deepEqual(sup.resumeCalls, []);
  // #398: same shared escalateNeedsHuman, so the same carrier rule — the PR, not the issue.
  assert.deepEqual(forge.prLabelsAdded, [[55, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, []);
  assert.equal(r.driven.length, 1);
  assert.equal(r.driven[0]!.kind, "needs-human");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-loop-unwired/);
  assert.match((r.driven[0] as { reason: string }).reason, /HANDLE_THREADS/);
  st.close();
});

test("tick DRIVE (#246 review round 1, C1): the fixLegResume-unwired degrade's label-write failure STILL terminalizes (escalateNeedsHuman's shared, pre-#246/#147 stance) — labeled=0 marks it fail-closed-invisible to GATED RECLAIM, same as the plain HUMAN-gate case (NOT the newer stay-driving fallback the fix-rounds-cap path owns)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  // #398: the carrier is the PR now, so THIS is the write that has to fail for the fail-closed
  // marker to be exercised — the issue-side thrower would no longer be reached at all.
  forge.throwOnAddPRLabel = true;
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "failed");
  assert.equal(row.gated_escalation_labeled, 0);
  assert.equal(r.driven[0]!.kind, "needs-human");
  st.close();
});

// ── #246 review round 1 (C2, Codex sol-high PR #264): FIXUP dispatch must pass the SAME
// new-leg admission gate RESUME/DISPATCH do (paused / ceiling / park / run-spend-stop). #375:
// round budget is deliberately NOT one of them any more — a fix leg is exempt from
// cost.roundBudgetUsd outright (see the "fixable + round budget exceeded" test below, which now
// asserts the OPPOSITE of what it used to: the fix leg dispatches). The remaining admission
// gates (paused/ceiling/park/run-spend-stop) are entirely unchanged by #375 — a wind-down must
// still drain, never start a brand-new fix leg instead.
// ──────────────────────────────────────────────────────────────────────────────────────────

// #375 (PR #388 review round 2, P1): forceDispatchPause is round.ts's OWN "no new dispatch wave
// this round" signal (round-budget/round-dispatch-cap/milestone/run-level stop conditions) — it
// is NOT a human pause, and none of those are "new dispatch" from an already-driving lane's fix
// leg's point of view. Folding it into the FIXUP admission gate (the OLD behavior this test used
// to pin) reproduced the #375 wedge under a different trigger: once ANY round/run-level stop
// condition fired, every FIXUP attempt blocked on "fix-leg-admission-blocked:paused" forever, the
// round never closing (see round.test.ts's own "runRounds (#375 review round 2, P1)" for the
// full end-to-end reproduction through runRounds()). This test now pins the OPPOSITE: a bare
// forceDispatchPause must NOT block a fix leg at all. The test right after it pins that a GENUINE
// human PAUSE sentinel still does — that half of the old behavior is unchanged, by design.
test("tick DRIVE (#375 review round 2, P1): forceDispatchPause ALONE (no human PAUSE sentinel) does NOT block a FIXUP dispatch — the fix leg still dispatches", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    forceDispatchPause: true,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "fixing", "#375: forceDispatchPause alone no longer blocks a fix leg");
  assert.equal(row.fix_rounds, 1);
  assert.equal(sup.resumeCalls.length, 1);
  assert.equal(r.driven[0]!.kind, "fixup");
  st.close();
});

test("tick DRIVE (#375 review round 2, P1): a GENUINE human PAUSE sentinel (data/PAUSE, not forceDispatchPause) still blocks a FIXUP dispatch — stays driving, queued, no fix leg spawned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-pause-fixup-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55);
    const gate = new FakeMergeGate();
    gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
    writeFileSync(join(dir, "PAUSE"), ""); // a human touches data/PAUSE — no forceDispatchPause involved
    const r = await tick({
      now: realClock,
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
    assert.deepEqual(sup.resumeCalls, []);
    assert.equal(r.driven[0]!.kind, "queued");
    assert.match((r.driven[0] as { reason: string }).reason, /fix-leg-admission-blocked:paused/);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE (#246 C2): an engine-wide ceiling breach (daily budget) blocks a FIXUP dispatch — stays driving, queued, no fix leg spawned", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  st.recordSpend("lane-earlier", 99, 500, new Date().toISOString()); // already over a tiny daily cap
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg({ cost: { dailyBudgetUsd: 10 } }),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving");
  assert.deepEqual(sup.resumeCalls, []);
  assert.equal(r.ceilingBreached, true); // the real CEILING phase still breaches/drains as normal
  assert.equal(r.driven[0]!.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-leg-admission-blocked:ceiling/);
  st.close();
});

test("tick DRIVE (#246 C2): an active environment park blocks a FIXUP dispatch — stays driving, queued, no fix leg spawned", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  st.enterPark("forge", "could not resolve host", 1, new Date().toISOString());
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving");
  assert.deepEqual(sup.resumeCalls, []);
  assert.equal(r.driven[0]!.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-leg-admission-blocked:park/);
  st.close();
});

test("tick DRIVE (#246 C2): a run-level spend stop blocks a FIXUP dispatch — stays driving, queued, no fix leg spawned", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    runSpendStopCrossed: () => true,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving");
  assert.deepEqual(sup.resumeCalls, []);
  assert.equal(r.driven[0]!.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-leg-admission-blocked:run-spend-stop/);
  st.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// #383 (F30): fix-leg-dispatch-blocked steady-state dedupe — same paradigm and same fix as
// drive-queued above, applied to the FIXUP admission-block branch. A real 90-minute llm park
// measured 77 duplicate events (one unchanged blockReason) before this existed.
// ─────────────────────────────────────────────────────────────────────────────

test("tick DRIVE (#383): a fix leg blocked by a human PAUSE sentinel, ticked repeatedly with the SAME blockReason, emits exactly ONE fix-leg-dispatch-blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fix-blocked-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55);
    const gate = new FakeMergeGate();
    gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
    writeFileSync(join(dir, "PAUSE"), "");
    const runTick = () =>
      tick({
        now: realClock,
        forge,
        state: st,
        supervisor: sup,
        cfg: mkCfg(),
        mergeGate: gate,
        fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
      });
    await runTick();
    await runTick();
    await runTick();
    const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-dispatch-blocked"]);
    assert.equal(events.length, 1, "steady-state re-emits nothing after the first observation");
    assert.deepEqual(events[0]!.payload, { worker: "lane-a", issue: 2, pr: 55, blockReason: "paused" });
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE (#383): a blockReason CHANGE (paused -> ceiling) re-emits fix-leg-dispatch-blocked", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fix-blocked-change-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55);
    const gate = new FakeMergeGate();
    gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
    writeFileSync(join(dir, "PAUSE"), "");
    await tick({
      now: realClock,
      forge,
      state: st,
      supervisor: sup,
      cfg: mkCfg(),
      mergeGate: gate,
      fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
    });
    rmSync(join(dir, "PAUSE"));
    st.recordSpend("lane-earlier", 99, 500, new Date().toISOString()); // now over a tiny daily cap
    await tick({
      now: realClock,
      forge,
      state: st,
      supervisor: sup,
      cfg: mkCfg({ cost: { dailyBudgetUsd: 10 } }),
      mergeGate: gate,
      fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
    });
    const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-dispatch-blocked"]);
    assert.deepEqual(
      events.map((e) => (e.payload as { blockReason: string }).blockReason),
      ["paused", "ceiling"],
      "one append per blockReason, not per tick",
    );
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE (#383) crash-rerun: a kill -9 between the fix-leg-dispatch-blocked observation and the next tick never double-emits (the durable event log IS the dedupe memory)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fix-blocked-crash-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    writeFileSync(join(dir, "PAUSE"), "");
    const fixable: DriveOutcome = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
    const before = new State(path);
    seedDriving(before, "lane-a", 2, 55);
    const gate = new FakeMergeGate();
    gate.outcomes[55] = fixable;
    await tick({
      now: realClock,
      forge: new FakeForge(),
      state: before,
      supervisor: new FakeSupervisor(),
      cfg: mkCfg(),
      mergeGate: gate,
      fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
    });
    assert.equal(before.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-dispatch-blocked"]).length, 1);
    before.close(); // kill -9 — no in-memory dedupe flag survives this

    // Reopen and re-tick against the STILL-blocked lane (PAUSE file untouched). The rerun
    // re-observes the identical blockReason; recognising it as already announced can only come
    // from on-disk state.
    const after = new State(path);
    const gate2 = new FakeMergeGate();
    gate2.outcomes[55] = fixable;
    await tick({
      now: realClock,
      forge: new FakeForge(),
      state: after,
      supervisor: new FakeSupervisor(),
      cfg: mkCfg(),
      mergeGate: gate2,
      fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
    });
    assert.equal(
      after.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-dispatch-blocked"]).length,
      1,
      "exactly one fix-leg-dispatch-blocked survives the restart — no duplicate for the same steady state",
    );
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE (#383 round 2, PM P2): fix-leg-dispatch-blocked RE-emits after an intervening dispatch even when blockReason repeats EXACTLY (PAUSE -> cleared -> dispatched -> PAUSE re-applied is a NEW episode, not steady state)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fix-blocked-recur-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55);
    const gate = new FakeMergeGate();
    const fixable: DriveOutcome = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
    const runTick = () =>
      tick({
        now: realClock,
        forge,
        state: st,
        supervisor: sup,
        cfg: mkCfg(),
        mergeGate: gate,
        fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
      });

    // 1. PAUSE applied — the lane is blocked. First observation of the episode.
    gate.outcomes[55] = fixable;
    writeFileSync(join(dir, "PAUSE"), "");
    await runTick();
    assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-dispatch-blocked"]).length, 1);
    assert.equal(st.getWorker("lane-a")?.state, "driving");

    // 2. PAUSE removed — the block clears and the leg actually dispatches (drive-fixup fires,
    // the episode-reset boundary).
    rmSync(join(dir, "PAUSE"));
    await runTick();
    assert.equal(st.getWorker("lane-a")?.state, "fixing");
    assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]).length, 1);

    // 3. The fix leg completes and pushes; FIXING RECLAIM lands the lane back in `driving` THIS
    // SAME tick. A human re-applies PAUSE and DRIVE re-evaluates the SAME still-fixable PR —
    // blocked again with the IDENTICAL blockReason ("paused") as step 1.
    sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
    writeFileSync(join(dir, "PAUSE"), "");
    gate.outcomes[55] = fixable;
    await runTick();
    assert.equal(st.getWorker("lane-a")?.state, "driving");

    const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-dispatch-blocked"]);
    assert.equal(
      events.length,
      2,
      "the re-block after a completed fix leg is a NEW episode and must re-announce, even though blockReason repeats exactly",
    );
    assert.deepEqual(
      events.map((e) => (e.payload as { blockReason: string }).blockReason),
      ["paused", "paused"],
    );
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE (#383 round 3, Codex P2): fix-leg-dispatch-blocked RE-emits when a ledger-seeded fix-leg-dispatch-failed sits between two identical blockReason observations (a cleared block that failed to dispatch still ended the episode)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fix-blocked-dispatch-fail-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55);
    const gate = new FakeMergeGate();
    const fixable: DriveOutcome = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
    gate.outcomes[55] = fixable;
    writeFileSync(join(dir, "PAUSE"), "");
    await tick({
      now: realClock,
      forge,
      state: st,
      supervisor: sup,
      cfg: mkCfg(),
      mergeGate: gate,
      fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
    });
    assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-dispatch-blocked"]).length, 1);

    // Ledger-seeded: `startFixLeg`'s `resume()` throwing (conductor.ts:3025-3031) proves the OLD
    // admission block already cleared and a genuine dispatch attempt was made, even though the
    // attempt itself failed and the lane stays `driving`, un-upserted. Simulated directly rather
    // than actually wiring a throwing supervisor — the throw path itself is already covered by
    // the existing "#246: fixable + FIXUP but startFixLeg's resume() throws" test above; this
    // test is only about whether the resulting event resets the dedup episode.
    st.appendEvent("fix-leg-dispatch-failed", { worker: "lane-a", issue: 2, pr: 55, error: "boom" });

    // PAUSE is still set — re-observe the IDENTICAL blockReason ("paused").
    await tick({
      now: realClock,
      forge,
      state: st,
      supervisor: sup,
      cfg: mkCfg(),
      mergeGate: gate,
      fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
    });
    const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-dispatch-blocked"]);
    assert.equal(
      events.length,
      2,
      "a failed dispatch attempt (fix-leg-dispatch-failed) still ended the OLD block episode — the re-block must announce",
    );
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE (#246 C2): with EVERY admission gate clear and fixLegResume configured, a FIXUP dispatch proceeds normally (admission check is not a permanent regression)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "fixing");
  assert.equal(row.fix_rounds, 1);
  assert.equal(sup.resumeCalls.length, 1);
  assert.equal(r.driven[0]!.kind, "fixup");
  st.close();
});

test("tick DRIVE (#246 review round 2, E1): a ceiling breach crossing DURING the DRIVE loop (not before it) admission-blocks a LATER fixable lane, even though an EARLIER lane in the SAME tick saw it clear — proves the admission check reads FRESH, not a pre-loop snapshot", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // Two driving lanes, both FIXABLE+FIXUP-eligible; state.drivingWorkers() orders by name, so
  // lane-a is admission-checked BEFORE lane-b within this same DRIVE loop.
  seedDriving(st, "lane-a", 2, 55);
  seedDriving(st, "lane-b", 3, 56);
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  gate.outcomes[56] = { kind: "fixable", pr: 56, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  // A monotonic `now()` sequence: +200s per call, regardless of which logical call site makes
  // it — robust to exactly how many now()/iso() calls a given lane's own processing happens to
  // make, since more calls only push further PAST the threshold, never back under it. The first
  // call (engineSessionStartDate, before the loop) anchors the session start at t=0 (elapsed 0,
  // never breached by construction); lane-a's own admission check lands well under the 300s cap;
  // by the time lane-b's admission check runs, elapsed has crossed it.
  const base = new Date("2026-07-18T00:00:00.000Z").getTime();
  let calls = 0;
  const now = () => {
    const d = new Date(base + calls * 200_000);
    calls++;
    return d;
  };
  const r = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg({ cost: { maxWallClockSec: 300 } }),
    mergeGate: gate,
    now,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(st.getWorker("lane-a")?.state, "fixing", "lane-a's admission check ran BEFORE the ceiling crossed — it dispatched normally");
  assert.equal(
    st.getWorker("lane-b")?.state,
    "driving",
    "lane-b's admission check ran AFTER the ceiling crossed — admission-blocked, not dispatched",
  );
  assert.deepEqual(
    sup.resumeCalls.map((c) => c.worker),
    ["lane-a"],
  ); // only lane-a ever reached startFixLeg
  const outcomeB = r.driven.find((d) => d.pr === 56)!;
  assert.equal(outcomeB.kind, "queued");
  assert.match((outcomeB as { reason: string }).reason, /fix-leg-admission-blocked:ceiling/);
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
    now: realClock,
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

// #375 (P0, PM adjudication option (a)-minimal): a driving lane's fix leg is now EXEMPT from
// cost.roundBudgetUsd — a fresh `false` is hardcoded in place of the old
// budgetExceeded(roundSpendUsd, roundBudgetUsd) read (conductor.ts's `driveOverBudget`), because
// an already-open PR has no other completion path (merge or fix — there is no "abandon the PR"
// outcome) and round-budget-blocking it was the dogfood-observed permanent wedge (F7/F8: round
// spend crosses the cap, FIXABLE stays queued forever, the round never closes). This replaces
// the OLD "round budget exceeded -> TRANSIENT queued block" test that used to live here — that
// behavior no longer exists at all (driveDecision's own overBudget-escalate branch can never
// fire from this call site anymore). The three PRE-EXISTING limits still bound a fix leg
// unchanged: cfg.lanes.prFixCap (attempts — see the "fix_rounds cap reached" test below, still
// terminal), worker.budgetUsdSoft (each leg's own per-worker ceiling, untouched by this issue),
// and cfg.cost.dailyBudgetUsd (still a real admission blocker — see the "#246 C2" ceiling test
// above, which is UNCHANGED: daily-budget/wall-clock ceiling breaches still admission-block a
// FIXUP dispatch via fixLegAdmissionBlockReason's `ceilingBreached`, only round budget is exempt).
test("tick DRIVE (#375): fixable + round budget exceeded -> the fix leg is EXEMPT from cost.roundBudgetUsd and dispatches normally (round budget no longer gates a driving lane's fix leg at all)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55); // fix_rounds 0, well under the default cap of 2
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    roundSpendUsd: () => 50, // > default cost.roundBudgetUsd (30) — would have blocked pre-#375
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "fixing", "#375: round budget no longer blocks a fix leg — it dispatches");
  assert.equal(row.fix_rounds, 1);
  assert.equal(sup.resumeCalls.length, 1, "the fix leg WAS dispatched despite round spend > roundBudgetUsd");
  assert.deepEqual(forge.labelsAdded, []); // no escalation — this is a normal rework dispatch
  assert.deepEqual(forge.prLabelsAdded, []); // #398: nor on the PR carrier
  assert.equal(r.driven[0]!.kind, "fixup");
  st.close();
});

// ── #450 (design #402 R3, §3c; architectural review amendment 2026-07-31): the convergence-stop
// escalation — a STALLED progress verdict escalates before ANOTHER fix leg is dispatched, and
// before the fix-rounds cap is even consulted. `classicThreadFindingKey` builds the SAME identity
// key `gatherFixupFindingRecord` (conductor.ts) derives from a live unresolved thread, so a fixture
// can pin "this round's finding is the SAME one as last round's" without re-deriving finding-key.ts's
// own formula. ────────────────────────────────────────────────────────────────────────────────

const cvThread = (id: string, path: string, findingDigest: string): ReviewThreadSpan => ({
  id,
  isResolved: false,
  isOutdated: false,
  path,
  line: 1,
  originalLine: 1,
  findingDigest,
  anchorCommitOid: "c1",
});

test("tick DRIVE (#450, recurrence): a shared finding whose path the preceding fix leg's diff touched escalates review-non-convergent:recurrence — zero further fix rounds spent", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  // Round 1's recorded findings (as #449's `drive-fixup` would have written them) — the SAME
  // finding (path src/a.ts, digest dA) is still open after the fix leg touched exactly that path.
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true }; // the fix leg touched src/a.ts
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.deepEqual(r.driven, [{ kind: "needs-human", worker: "lane-a", issue: 2, pr: 55, reason: "review-non-convergent:recurrence" }]);
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "failed");
  assert.equal(row.fix_rounds, 1, "zero further fix rounds spent on a stalled lane");
  assert.equal(row.gated_escalation_labeled, 1);
  assert.deepEqual(forge.prLabelsAdded, [[55, "needs-human"]]); // #398: PR-born escalation, PR carrier
  assert.deepEqual(forge.labelsAdded, []);
  assert.equal(sup.resumeCalls.length, 0, "no fix leg dispatched");
  const nonConvergent = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]);
  assert.equal(nonConvergent.length, 1);
  assert.equal((nonConvergent[0]!.payload as { signal: string }).signal, "recurrence");
  // The two facts stay separable (issue #450 verification item 6): a stalled lane's escalation
  // NEVER also appends fix-rounds-capped, even though it shares the same terminal shape.
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-rounds-capped"]), []);
  st.close();
});

test("tick DRIVE (#450, recurrence pair — #378 boundary): the SAME finding surviving on a path the fix leg did NOT touch is ordinary continued convergence, not recurrence — dispatches another fix leg", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  // The fix leg touched a DIFFERENT file entirely — src/a.ts (the finding's own path) was never
  // in its diff, so this is #378's case: unchanged code, not recurrence.
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/unrelated.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup", "no escalation — the classifier must not fire recurrence on unchanged code");
  assert.equal(st.getWorker("lane-a")?.state, "fixing");
  assert.equal(st.getWorker("lane-a")?.fix_rounds, 2);
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]), []);
  st.close();
});

test("tick DRIVE (#450, marginal-complexity): curr shares ONE prior finding (row 2's disjoint-continue does not apply) plus a NEW finding inside the touched path -> marginal-complexity", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  // Round 2: keyA is STILL open (unresolved, but on a path the fix leg did NOT touch — never
  // recurrence) AND a brand-new finding (keyD, src/d.ts) appears inside the touched path.
  forge.prReviewData = {
    ...forge.prReviewData,
    headOid: "H2",
    unresolvedThreads: 2,
    threads: [cvThread("TA", "src/a.ts", "dA"), cvThread("TD", "src/d.ts", "dD")],
  };
  // The range diff touches ONLY src/d.ts — never src/a.ts, so recurrence cannot fire for keyA.
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/d.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=2:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.deepEqual(r.driven, [
    { kind: "needs-human", worker: "lane-a", issue: 2, pr: 55, reason: "review-non-convergent:marginal-complexity" },
  ]);
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]);
  assert.equal((events[0]!.payload as { signal: string }).signal, "marginal-complexity");
  st.close();
});

test("tick DRIVE (#450, flat): non-decreasing finding count for two consecutive rounds escalates review-non-convergent:flat", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  const keyB = classicThreadFindingKey({ id: "TB", path: "src/b.ts", findingDigest: "dB" }).key;
  // (round 3's third key, "keyC"/TC/src/c.ts/dC, is built inline via cvThread below — no separate
  // binding needed since nothing else references its raw key string.)
  // Round 1: one finding. Round 2: two findings (shares keyA, adds keyB) — count rose once, not
  // yet a trend (flatStreak 1 at round 2). Neither seeded round records a `head` collision with
  // the live round below, and both are deliberately never referenced by any fixDiffPaths entry —
  // isolating this fixture to the COUNT signal alone (rows 3/5 must never fire here).
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 2,
    reason: "r2",
    findings: [
      { key: keyA, severity: "blocking" },
      { key: keyB, severity: "blocking" },
    ],
    fixDiffPaths: [],
    head: "H2",
  });
  // Round 3 (live): shares keyA with round 2 (non-empty intersection — row 2's disjoint-continue
  // does not apply), drops keyB, adds keyC — count stays at 2 (non-decreasing a SECOND consecutive
  // time: flatStreak reaches 2). The range diff is EMPTY, so neither recurrence (keyA's path is
  // not in it) nor marginal-complexity (keyC's path is not in it) can fire — isolates row 4.
  forge.prReviewData = {
    ...forge.prReviewData,
    headOid: "H3",
    unresolvedThreads: 2,
    threads: [cvThread("TA", "src/a.ts", "dA"), cvThread("TC", "src/c.ts", "dC")],
  };
  forge.compareResults["H2...H3"] = { files: [], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=2:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.deepEqual(r.driven, [{ kind: "needs-human", worker: "lane-a", issue: 2, pr: 55, reason: "review-non-convergent:flat" }]);
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]);
  assert.equal((events[0]!.payload as { signal: string }).signal, "flat");
  // #398 (review round 2): this escalation is PR-BORN — `pr` is required and non-nullable here and
  // the comment is entirely about that PR, exactly escalateNeedsHuman's shape — so label AND
  // comment land on the PR and the issue stays clean. Asserted on THIS fixture rather than a
  // hand-rolled twin: it is the one that deterministically reaches the stall verdict.
  assert.deepEqual(forge.prLabelsAdded, [[55, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.issueComments, []);
  assert.match(forge.prComments[0]![1], /is not converging/);
  assert.match(forge.prComments[0]![1], /from this pull request/, "the removal instruction names the object carrying the label");
  assert.equal(st.getWorker("lane-a")!.gated_escalation_carrier, "pr");
  assert.equal(
    (events[0]!.payload as { carrier: string }).carrier,
    "pr",
    "the reconciler reads the carrier off this payload — without it, a permanently-clean issue false-clears the escalation",
  );
  st.close();
});

// ── #450 gate② Codex cross-vendor (PM-narrowed ruling, 2026-08-01): a capped finding snapshot's
// COUNT is a floor, not a fact — the EXACT 100->75->51 scenario the finding names, wired end-to-end
// through gatherFixupFindingRecord/classifyConvergenceProgress. ───────────────────────────────────

test("tick DRIVE (#450, gate② Codex cross-vendor, truncation rule): three truncated 50-item snapshots (a genuinely falling count) never false-stall as flat — dispatches a fix leg instead of escalating", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 });

  // 50 distinct classic-path keys, shared across all three rounds — the VISIBLE count sits at the
  // cap in every round even though the TRUE count is falling (100 -> 75 -> 51 in the finding's own
  // framing; this fixture only needs the OBSERVABLE shape: every round's own recorded/read set is
  // capped at MAX_FIXUP_FINDINGS=50 and marked truncated).
  const keyFor = (i: number) => classicThreadFindingKey({ id: `T${i}`, path: `src/f${i}.ts`, findingDigest: `d${i}` }).key;
  const fifty = Array.from({ length: 50 }, (_, i) => ({ key: keyFor(i), severity: "blocking" as const }));

  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: fifty,
    findingsTruncated: true,
    fixDiffPaths: [],
    head: "H1",
  });
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 2,
    reason: "r2",
    findings: fifty,
    findingsTruncated: true,
    fixDiffPaths: [],
    head: "H2",
  });

  // Round 3 (live): 51 unresolved threads (the same 50 visible keys plus one more) —
  // gatherFixupFindingRecord's own boundRecords caps this to 50 and marks findingsTruncated: true,
  // so round 3's OWN record is genuinely truncated too, not just the seeded history.
  const threads = Array.from({ length: 51 }, (_, i) => cvThread(`T${i}`, `src/f${i}.ts`, `d${i}`));
  forge.prReviewData = { ...forge.prReviewData, headOid: "H3", unresolvedThreads: 51, threads };
  forge.compareResults["H2...H3"] = { files: [], complete: true }; // no path overlap -> never recurrence/marginal-complexity

  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=51:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });

  assert.equal(r.driven[0]?.kind, "fixup", "never a false review-non-convergent:flat on a truncated-but-genuinely-improving lane");
  assert.equal(st.getWorker("lane-a")?.state, "fixing");
  assert.equal(st.getWorker("lane-a")?.fix_rounds, 3);
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]), []);
  const driveFixupEvents = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  assert.equal(driveFixupEvents.length, 3);
  const round3 = driveFixupEvents[2]!.payload as { findingsTruncated?: boolean; findings: unknown[] };
  assert.equal(
    round3.findingsTruncated,
    true,
    "round 3's own record is genuinely truncated too — the scenario is real, not a test artifact",
  );
  assert.equal(round3.findings.length, 50);
  st.close();
});

test("tick DRIVE (#450, advisories excluded, engine-agent path): a NEW advisory finding inside the touched path never trips marginal-complexity — filtered before the classifier ever sees it", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = engineAgentFindingKey({ id: "f1", kind: "security", path: "src/a.ts" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    verdictRunId: "run-1",
    findings: [{ key: keyA, severity: "blocking", kind: "security" }],
    fixDiffPaths: [],
    head: "H1",
  });
  // Round 2's WAL artifact (the ONLY path that can produce a genuine `severity: "advisory"`
  // finding at all — the classic thread path is unconditionally "blocking", gatherFixupFindingRecord's
  // own doc): keyA survives unchanged (its own path, src/a.ts, is NOT in this round's touched-path
  // set), and a brand-NEW advisory finding (style, src/b.ts) lands INSIDE the touched path. Without
  // the blocking-only filter, that new key would trip row 5 (marginal-complexity) — WITH it, an
  // advisory finding is invisible to the classifier entirely.
  st.recordEngineReviewWal("lane-a", { runId: "run-9", head: "H2", base: "H1", diffHash: "d2", attemptStart: "2026-01-01T00:00:00.000Z" });
  const artifact: EngineReviewArtifact = {
    perAC: [],
    findings: [
      { id: "f1", body: "still open", severity: "blocking", kind: "security", path: "src/a.ts" },
      { id: "f2", body: "nit: naming", severity: "advisory", kind: "style", path: "src/b.ts" },
    ],
    sessionActualModels: ["sonnet"],
    promptHash: "hash",
  };
  st.recordEngineReviewWalArtifact("lane-a", "run-9", "rejected", JSON.stringify(artifact));
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/b.ts" }], complete: true }; // touched src/b.ts, NEVER src/a.ts
  const gate = new FakeMergeGate();
  gate.outcomes[55] = {
    kind: "fixable",
    pr: 55,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=0:ciRed=false",
    verdictRunId: "run-9",
  };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup", "the advisory finding must not fake marginal-complexity");
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]), []);
  st.close();
});

test("tick DRIVE (#450, degradation rule): fixDiffPaths unavailable -> recurrence cannot fire, count-only convergence dispatches a fix leg instead of escalating", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  // The SAME finding survives — this would be `recurrence` if the range diff were trustworthy.
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  // GitHub's own file-count ceiling: an INCOMPLETE compare result -> gatherFixDiffPaths degrades
  // to `{ paths: [], unavailable: true }` (never a partial list standing in silently).
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: false };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(r.driven[0]?.kind, "fixup", "the degradation rule must fail NARROW — a fix leg still dispatches, never a false stall");
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]), []);
  const dispatchEvents = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  const round2 = dispatchEvents[1]!.payload as { fixDiffPathsUnavailable?: boolean; fixDiffPaths: string[] };
  assert.equal(round2.fixDiffPathsUnavailable, true, "the degradation this fixture exercises is genuinely on record");
  assert.deepEqual(round2.fixDiffPaths, []);
  st.close();
});

test("tick DRIVE (#450, three-way precedence): a verdict-rerun wins over a stalled progress verdict — precedence is verdict-rerun -> convergence-stalled -> cap", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = engineAgentFindingKey({ id: "f1", kind: "security", path: "src/a.ts" }).key;
  // A prior `drive-fixup` for this EXACT verdictRunId — priorFixLegForVerdict trips the #457
  // breaker regardless of what the (recurring, would-be-stalled) findings say.
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    verdictRunId: "run-9",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: ["src/a.ts"],
    head: "H1",
  });
  const gate = new FakeMergeGate();
  gate.outcomes[55] = {
    kind: "fixable",
    pr: 55,
    reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false",
    verdictRunId: "run-9",
  };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(
    (r.driven[0] as { reason: string }).reason,
    "fix-leg-no-op:verdict-rerun",
    "verdict-rerun wins outright — never review-non-convergent",
  );
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]), []);
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-verdict-rerun"]).length, 1);
  st.close();
});

test("tick DRIVE (#450, two lanes, one tick): the two facts stay separable — a stalled lane escalates review-non-convergent, a SEPARATE converging lane at the cap escalates fix-rounds-capped, never each other's event", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // Lane A: stalled (recurrence), well under the cap — proves the progress signal, not the cap,
  // drove this escalation.
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  // Lane B: round 1 (no prior drive-fixup at all — always `converging` by definition) sitting
  // AT the cap — a converging lane that simply ran out of budget.
  const cap = mkCfg().lanes.prFixCap;
  seedDriving(st, "lane-b", 20, 66, { fix_rounds: cap });

  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  gate.outcomes[66] = { kind: "fixable", pr: 66, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const byWorker = new Map(r.driven.map((d) => [(d as { worker: string }).worker, d]));
  assert.equal((byWorker.get("lane-a") as { reason: string }).reason, "review-non-convergent:recurrence");
  assert.equal((byWorker.get("lane-b") as { reason: string }).reason, `fix-rounds-cap:${cap}/${cap}`);
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]).length, 1);
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-rounds-capped"]).length, 1);
  // Cross-check: neither lane's own event carries the OTHER lane's kind.
  const nonConvergentPrs = st
    .eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"])
    .map((e) => (e.payload as { pr: number }).pr);
  const cappedPrs = st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-rounds-capped"]).map((e) => (e.payload as { pr: number }).pr);
  assert.deepEqual(nonConvergentPrs, [55]);
  assert.deepEqual(cappedPrs, [66]);
  st.close();
});

test("tick DRIVE (#450, escalation comment content): cites the signal, both rounds' finding keys, and design re-entry (docs/REVIEW-DOCTRINE.md adjudication principle 4)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(forge.prComments.length, 1);
  const comment = forge.prComments[0]![1];
  assert.match(comment, /\*\*recurrence\*\*/, "the signal name");
  assert.match(comment, new RegExp(keyA.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "round r-1's finding key");
  assert.match(comment, /adjudication principle 4/i, "design re-entry citation");
  assert.match(comment, /REVIEW-DOCTRINE\.md/, "the doctrine file, by name");
  assert.match(comment, /design re-entry/i, "design re-entry, not merely human escalation");
  assert.match(comment, /#147 gated reentry/, "the existing return path — no new re-entry channel");
  st.close();
});

test("tick DRIVE (#450, gated reclaim): a review-non-convergent escalation is reclaimable through the existing #147 GATED RECLAIM path once a human clears the label — no new re-entry channel", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.equal(st.getWorker("lane-a")!.state, "failed");
  assert.equal(st.getWorker("lane-a")!.gated_escalation_labeled, 1);
  assert.equal(st.gatedFailedWorkers().length, 1, "visible to GATED RECLAIM's own read path");

  // A human clears the label — the existing #147 mechanism, unmodified, reclaims it.
  forge.prLabelsByPr[55] = []; // #398: the human clears the carrier the escalation used — the PR
  const r2 = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  assert.deepEqual(r2.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-a", issue: 2, pr: 55, attempt: 1 }]);
  st.close();
});

// ── #450 gate② P1 (architectural review, 2026-07-31; PM adjudication accepted): the CONVERGENCE
// EPISODE boundary — a #147 gated reclaim (or a #447 park revival) must reset the fold, never
// classify against pre-escalation history. ────────────────────────────────────────────────────

test("tick DRIVE (#450, gate② P1): stall-escalate -> human clears -> #147 gated reclaim -> the NEXT FIXABLE tick dispatches (round-1-of-episode semantics), NEVER re-escalates, and its drive-fixup's fixDiffPaths derive from the POST-RECLAIM head only (never the human's own intervening diff)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };

  const r1 = await tick(deps);
  assert.deepEqual(r1.driven, [{ kind: "needs-human", worker: "lane-a", issue: 2, pr: 55, reason: "review-non-convergent:recurrence" }]);
  assert.equal(st.getWorker("lane-a")!.state, "failed");
  assert.equal(st.getWorker("lane-a")!.fix_rounds, 1);

  // The human pushes a fix AND clears the label — the #147 gated-reclaim signal.
  forge.prReviewData = { ...forge.prReviewData, headOid: "H3", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  // The WIDE (pre-#450-gate②-P1 buggy) range H1..H3 — what an UNBOUNDED fold would use — is
  // deliberately scripted to touch src/a.ts, so a regression here re-triggers a false STALL.
  forge.compareResults["H1...H3"] = { files: [{ filename: "src/a.ts" }, { filename: "src/wide-range-leak.ts" }], complete: true };
  // The CORRECT round-1-of-episode range: base..H3 (the whole PR), exactly what
  // `gatherFixDiffPaths`' own round-1 branch computes once it correctly sees NO preceding
  // `drive-fixup` THIS episode.
  forge.changedFiles = { files: [{ filename: "src/human-fix.ts" }], complete: true };
  forge.prLabelsByPr[55] = []; // #398: the human clears the carrier the escalation used — the PR

  const r2 = await tick(deps);
  assert.deepEqual(r2.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-a", issue: 2, pr: 55, attempt: 1 }]);
  // DRIVE re-evaluates the SAME tick (#147's own "same tick sees the reclaim") — round-1-of-episode
  // semantics: dispatches a REAL fix leg, never re-escalates.
  assert.deepEqual(r2.driven, [
    { kind: "fixup", worker: "lane-a", issue: 2, pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" },
  ]);
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "fixing");
  assert.equal(row.fix_rounds, 2, "a REAL fix leg dispatched — never a free re-escalation");
  assert.equal(
    st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]).length,
    1,
    "exactly one escalation total (round 1's, still on record) — no immediate post-reclaim re-escalation",
  );
  const driveFixupEvents = st.eventsSince("1970-01-01T00:00:00.000Z", ["drive-fixup"]);
  assert.equal(driveFixupEvents.length, 2);
  const round2 = driveFixupEvents[1]!.payload as { fixDiffPaths: string[]; head?: string };
  assert.deepEqual(
    round2.fixDiffPaths,
    ["src/human-fix.ts"],
    "the post-reclaim head's OWN base..head diff — never the wide H1..H3 range spanning the human's own fix",
  );
  assert.equal(round2.head, "H3");
  st.close();
});

// ── #450 gate② P2 (architectural review, 2026-07-31; accepted): the escalation-comment marker is
// widened with the head OID — a genuinely SECOND stall episode at a NEW head must never be
// suppressed by the FIRST escalation's already-posted comment, even when `fix_rounds` (the OLD,
// sole key component) is unchanged. ────────────────────────────────────────────────────────────

test("tick DRIVE (#450, gate② P2): the escalation-comment marker is keyed on headOid too — a SECOND stall at a DIFFERENT head (identical fix_rounds) posts its OWN fresh comment, never suppressed by the first escalation's marker", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };
  const r1 = await tick(deps);
  assert.equal((r1.driven[0] as { reason: string }).reason, "review-non-convergent:recurrence");
  assert.equal(forge.prComments.length, 1);
  assert.equal(st.getWorker("lane-a")!.state, "failed");

  // Isolates the MARKER's own discriminating behavior from #450 gate② P1's episode-boundary fix
  // (which already prevents this specific double-escalation through the SUPPORTED #147 reclaim
  // path — see the P1 test above): the row returns to `driving` with the SAME `fix_rounds` (no
  // fix leg ever dispatched) and NO recognized episode-reset event, so the classification history
  // is genuinely unchanged and a SECOND, real stall (recurrence again, at a NEW head) is exactly
  // the scenario the marker's own key must not suppress — "independently of P1 it is still wrong"
  // (gate② review's own words).
  st.upsertWorker({ ...st.getWorker("lane-a")!, state: "driving", ended_at: null, gated_escalation_labeled: 0 });
  forge.prLabelsByPr[55] = []; // #398: the human clears the carrier the escalation used — the PR
  forge.prReviewData = { ...forge.prReviewData, headOid: "H3", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H3"] = { files: [{ filename: "src/a.ts" }], complete: true };

  const r2 = await tick(deps);
  assert.equal((r2.driven[0] as { reason: string }).reason, "review-non-convergent:recurrence");
  assert.equal(forge.prComments.length, 2, "a SECOND, fresh comment — never suppressed by the first escalation's marker");
  assert.notEqual(
    forge.prComments[1]![1],
    forge.prComments[0]![1],
    "the two comments carry DIFFERENT markers (different head), so neither's live-read suppresses the other",
  );
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]).length, 2);
  st.close();
});

// ── #450 gate② P3a (accepted): the escalation's own forge-write-failure paths, mirroring
// escalateReviewDisputed's twin tests exactly — label-failed dedupe, comment-failed dedupe, and a
// single write-failure's retry-next-tick contract. ─────────────────────────────────────────────

test("tick DRIVE (#450, gate② P3a): a label-write failure leaves the row driving (retried next tick), never escalates without the label landing", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  forge.throwOnAddPRLabel = true;
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving", "no terminal transition without the label landing");
  assert.equal(row.fix_rounds, 1);
  assert.equal(r.driven[0]?.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /review-non-convergent-escalation-write-failed/);
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]), [], "no event without a successful label write");
  const failedLabelEvents = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent-label-failed"]);
  assert.equal(failedLabelEvents.length, 1);
  st.close();
});

test("tick DRIVE (#450, gate② P3a): a comment-write failure (label already landed) leaves the row driving, never terminalizes, no review-non-convergent event — the comment-failure ordering leg", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  forge.throwOnAddPRComment = true;
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving", "no terminal transition without the comment landing");
  assert.equal(row.fix_rounds, 1);
  assert.equal(r.driven[0]?.kind, "queued");
  assert.deepEqual(
    st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]),
    [],
    "no success event without a successful comment write",
  );
  assert.deepEqual(forge.prLabelsAdded, [[55, "needs-human"]], "the label DID land — this is the ordering-after-label leg");
  const failedCommentEvents = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent-comment-failed"]);
  assert.equal(failedCommentEvents.length, 1);
  assert.equal((failedCommentEvents[0]!.payload as { fixRounds: number }).fixRounds, 1);
  st.close();
});

test("tick DRIVE (#450, gate② P3a): a comment-write failure that keeps failing across MANY ticks appends review-non-convergent-comment-failed ONCE, not per tick — the #383/#465 transition-dedupe convention, not steady-state spam", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  forge.throwOnAddPRComment = true;
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };
  for (let i = 0; i < 5; i++) await tick(deps);
  assert.equal(
    st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent-comment-failed"]).length,
    1,
    "same episode (same fix_rounds, no reset in between) — one announcement, not five",
  );

  // A genuinely LATER round (a real dispatch would have bumped `fix_rounds`) re-announces — the
  // dedupe's own `fixRounds` equality clause, exercised directly (matching
  // `lastReviewNonConvergentFailureEvent`'s own doc: "a lane whose fix_rounds later changes has,
  // by construction, dispatched another fix leg instead").
  st.upsertWorker({ ...st.getWorker("lane-a")!, fix_rounds: 2 });
  await tick(deps);
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent-comment-failed"]);
  assert.equal(events.length, 2, "a different fix_rounds is a genuinely new episode, not eaten by the dedup");
  assert.equal((events[1]!.payload as { fixRounds: number }).fixRounds, 2);
  st.close();
});

test("tick DRIVE (#450, gate② P3a): a label-write failure that keeps failing across MANY ticks appends review-non-convergent-label-failed ONCE, not per tick — the SAME transition-dedupe the comment path already had", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: 1,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  forge.throwOnAddPRLabel = true;
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const deps = {
    now: realClock,
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    mergeGate: gate,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };
  for (let i = 0; i < 5; i++) await tick(deps);
  assert.equal(
    st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent-label-failed"]).length,
    1,
    "same episode (same fix_rounds, no reset in between) — one announcement, not five",
  );

  st.upsertWorker({ ...st.getWorker("lane-a")!, fix_rounds: 2 });
  await tick(deps);
  const events = st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent-label-failed"]);
  assert.equal(events.length, 2, "a different fix_rounds is a genuinely new episode, not eaten by the dedup");
  st.close();
});

// ── #450 gate② P3c (accepted): the fixLegResume/admission checks run BEFORE
// `gatherFixupFindingRecord`'s forge reads — a paused/parked lane under cap stops paying them every
// steady-state tick. ─────────────────────────────────────────────────────────────────────────────

test("tick DRIVE (#450, gate② P3c): a lane under cap, PAUSED, never calls gatherFixupFindingRecord's forge reads (getPRReviewData/compareChangedFiles) — the steady-state cost the #383 90-minute-park evidence base flagged", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-p3c-pause-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
    const gate = new FakeMergeGate();
    gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
    writeFileSync(join(dir, "PAUSE"), ""); // a human touches data/PAUSE
    const r = await tick({
      now: realClock,
      forge,
      state: st,
      supervisor: sup,
      cfg: mkCfg(),
      mergeGate: gate,
      fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
    });
    const row = st.getWorker("lane-a")!;
    assert.equal(row.state, "driving");
    assert.equal(row.fix_rounds, 1, "unchanged — no dispatch, no escalation, this tick simply defers");
    assert.match((r.driven[0] as { reason: string }).reason, /fix-leg-admission-blocked:paused/);
    assert.equal(forge.getPRReviewDataCalls, 0, "gatherFixupFindingRecord's classic-path read never ran");
    assert.equal(forge.compareCalls.length, 0, "gatherFixDiffPaths' range-compare read never ran");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE (#450, gate② P3c): once the pause clears, the SAME lane is evaluated normally — progress IS computed and a fix leg dispatches (proves the deferred tick is not a permanent skip)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-p3c-pause-clear-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 });
    const gate = new FakeMergeGate();
    gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
    const pausePath = join(dir, "PAUSE");
    writeFileSync(pausePath, "");
    const deps = {
      now: realClock,
      forge,
      state: st,
      supervisor: sup,
      cfg: mkCfg(),
      mergeGate: gate,
      fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
    };
    await tick(deps);
    assert.equal(forge.getPRReviewDataCalls, 0);

    rmSync(pausePath);
    const r2 = await tick(deps);
    assert.equal(r2.driven[0]?.kind, "fixup");
    assert.equal(st.getWorker("lane-a")!.state, "fixing");
    assert.equal(st.getWorker("lane-a")!.fix_rounds, 2);
    assert.equal(forge.getPRReviewDataCalls, 1, "progress IS gathered once admission clears");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #450 gate② P3d (accepted): the both-stalled-AND-at-cap precedence, pinned on a SINGLE lane —
// the two-lanes test above covers the pair on separate lanes; this pins the third leg directly. ──

test("tick DRIVE (#450, gate② P3d): a lane BOTH stalled AND at the fix-rounds cap takes review-non-convergent directly, never fix-rounds-capped", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cap = mkCfg().lanes.prFixCap;
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: cap }); // AT the cap already
  const keyA = classicThreadFindingKey({ id: "TA", path: "src/a.ts", findingDigest: "dA" }).key;
  st.appendEvent("drive-fixup", {
    worker: "lane-a",
    issue: 2,
    pr: 55,
    fixRounds: cap,
    reason: "r1",
    findings: [{ key: keyA, severity: "blocking" }],
    fixDiffPaths: [],
    head: "H1",
  });
  forge.prReviewData = { ...forge.prReviewData, headOid: "H2", unresolvedThreads: 1, threads: [cvThread("TA", "src/a.ts", "dA")] };
  forge.compareResults["H1...H2"] = { files: [{ filename: "src/a.ts" }], complete: true };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal((r.driven[0] as { reason: string }).reason, "review-non-convergent:recurrence");
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["review-non-convergent"]).length, 1);
  assert.deepEqual(st.eventsSince("1970-01-01T00:00:00.000Z", ["fix-rounds-capped"]), []);
  st.close();
});

test("tick DRIVE (#246): fix_rounds cap reached (not over budget) -> needs-human label + escalation comment land BEFORE the terminal upsert, failed+pr+gated_escalation_labeled=1 (the ONLY producer of that shape besides prFixCap:0)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // #450: default cfg.lanes.prFixCap rose 2 -> 4 — pin this test's own cap explicitly rather than
  // renumber every literal below, since an explicit config is completely unaffected by that change.
  const cfg = mkCfg({ lanes: { prFixCap: 2 } });
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 }); // == this test's own prFixCap (2): cap reached
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
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
  const cfg = mkCfg({ lanes: { prFixCap: 2 } }); // #450: pin this test's own cap (default rose 2 -> 4)
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 });
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.state, "driving", "no latch — untouched, so the next tick's FIXABLE-at-cap re-derivation retries the label write");
  assert.equal(row.fix_rounds, 2);
  assert.deepEqual(forge.issueComments, [], "no comment posted without a successful label — nothing to escalate yet");
  assert.equal(r.driven[0]!.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-rounds-cap-label-failed/);
  st.close();
});

test("tick DRIVE (#246 review round 1, C3): fix_rounds cap reached, LABEL succeeds but the escalation COMMENT fails -> stays driving (no terminal upsert, no latch) — retried next tick, the comment is never silently swallowed before a terminal transition", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.throwOnAddIssueComment = true;
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ lanes: { prFixCap: 2 } }); // #450: pin this test's own cap (default rose 2 -> 4)
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 });
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  const row = st.getWorker("lane-a")!;
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]], "the label write itself DID succeed");
  assert.equal(
    row.state,
    "driving",
    "no terminal upsert without the comment landing — retried whole, including a harmless re-label, next tick",
  );
  assert.equal(row.fix_rounds, 2);
  assert.equal(row.gated_escalation_labeled ?? 0, 0, "never latched — this row was never terminalized");
  assert.equal(r.driven[0]!.kind, "queued");
  assert.match((r.driven[0] as { reason: string }).reason, /fix-rounds-cap-comment-failed/);
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

  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-a", issue: 10, pr: 99, attempt: 1 }]);
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  assert.equal(st.getWorker("lane-a")?.fix_rounds, 2, "fix_rounds is untouched by GATED RECLAIM — #147 owns gated_reentry_attempts only");

  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 1st tick: DONE -> driving
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 2nd tick: still driving
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 3rd tick: still driving
  // Called once per tick (the trigger-once invariant now lives INSIDE MergeDriver.driveOne,
  // covered by merge-driver.test.ts) — every call carries issue #2 and a null pin (never
  // triggered, per this test's fresh lane).
  assert.equal(gate.calls.length, 3);
  for (const c of gate.calls) {
    assert.equal(c.pr, 55);
    assert.equal(c.issue, 2);
    assert.deepEqual(c.triggerPin, {
      head: null,
      at: null,
      generation: 0,
      ambiguous: false,
      deltaChain: 0,
      inFlight: false,
      coveredHead: null,
    });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 1st tick: records the pin
  assert.equal(st.getWorker("lane-a")?.review_triggered_head, "HEAD1");
  assert.equal(st.getWorker("lane-a")?.review_triggered_at, "2026-07-07T08:00:00.000Z");

  gate.recordOnCall = null; // 2nd tick: driveOne doesn't re-record (simulating a matched pin)
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(gate.calls[1]!.triggerPin, {
    head: "HEAD1",
    at: "2026-07-07T08:00:00.000Z",
    generation: 1,
    ambiguous: false,
    deltaChain: 0,
    inFlight: true,
    coveredHead: null,
  }); // read back
  st.close();
});

test("tick DRIVE #273: generation-attributable trusted verdict persists covered head through the conductor callback", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-a", 2);
  sup.probes["lane-a"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 55 };
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "waiting-ci" };
  gate.recordOnCall = ["HEAD1", "2026-07-07T08:00:00.000Z"];
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

  gate.recordOnCall = null;
  gate.recordVerdictOnCall = ["HEAD1", 1, true];
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  const row = st.getWorker("lane-a")!;
  assert.equal(row.review_trigger_in_flight, 0);
  assert.equal(row.review_covered_head, "HEAD1");
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 1st tick: no lock yet
  assert.deepEqual(gate.calls[0]!.fallbackLock, { head: null, kind: null });

  gate.recordFallbackOnCall = { head: "HEAD1", kind: "same-model-trusted" };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 2nd tick: records the lock
  assert.equal(st.getWorker("lane-a")?.review_fallback_head, "HEAD1");
  assert.equal(st.getWorker("lane-a")?.review_fallback_kind, "same-model-trusted");

  gate.recordFallbackOnCall = null; // 3rd tick: driveOne doesn't re-record
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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
    const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(st.getWorker("lane-a")?.state, "driving"); // an audit-only announcement, no state change
    assert.deepEqual(r1.driven, [{ kind: "queued", worker: "lane-a", issue: 2, pr: 55, reason: "waiting" }]);
    assert.equal(forge.prComments.length, 1);
    assert.match(forge.prComments[0]![1], /same-model-trusted/);

    // Tick 2: the SAME transition reported again (stateless per-tick signal) -> deduped, no
    // second event, no second comment (a produce-pr-and-stop lane would otherwise spam one
    // comment per tick forever).
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(forge.prComments.length, 1);
    assert.equal(rawEventKinds(path).filter((k) => k === "reviewer-fallback-switch").length, 1);

    // Tick 3: a DIFFERENT transition (revert) -> announced (event + comment).
    gate.outcomes[55] = {
      kind: "queued",
      pr: 55,
      reason: "waiting",
      reviewerTransition: { kind: "revert", mode: "different-model-codex", head: "H1" },
    };
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(forge.prComments.length, 2);
    assert.match(forge.prComments[1]![1], /available again/);

    // Tick 4: the revert reported again -> deduped.
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    gate.outcomes[55] = {
      kind: "queued",
      pr: 55,
      reason: "waiting",
      reviewerTransition: { kind: "switch", mode: "human", head: "H2" }, // pushed -> new episode
    };
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // 1st tick: lane -> driving

  // Simulate a forged/corrupt row: the TEXT column holds a kind no Reviewer implements.
  st.recordReviewFallback("lane-a", "HEAD", "totally-bogus-kind");
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  // The gate must see NO lock at all — head nulled too, never a half-valid lock.
  assert.deepEqual(gate.calls[1]!.fallbackLock, { head: null, kind: null });

  // Sanity: a VALID kind round-trips (validation rejects unknowns, not legitimate episodes).
  st.recordReviewFallback("lane-a", "HEAD", "same-model-trusted");
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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

    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

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
    assert.deepEqual(sup.dispatched, [] as Issue[]);
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

    const result = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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
    assert.deepEqual(sup.dispatched, [] as Issue[]);
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

    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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
    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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
    const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
    assert.equal(gate.calls.length, 0); // DRIVE skipped under the switch — never merges
    assert.deepEqual(r1.driven, []);
    // #69 P2: the DONE+PR lane's terminal state IS recorded (reclaimed to driving), not drained.
    assert.equal(r1.reclaimed[0]?.kind, "done");
    assert.equal(st.getWorker("lane-a")?.state, "driving");
    assert.deepEqual(r1.drainRequested, []); // terminal lane, not a drain target
    assert.deepEqual(forge.boardSet, []); // not merged yet

    rmSync(switchPath, { force: true }); // human clears the switch
    const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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

// ── #375 AC2: KILL_SWITCH wind-down must never wait forever on a `driving` lane. Unlike
// running/fixing lanes (a live process the drain can requestHandoff/hard-kill), a `driving`
// lane has nothing to hand off — DRIVE is frozen entirely while the switch is active (#69), so
// the ONLY way one of these ever leaves `driving` under a sustained switch is the SAME bounded
// escalation drainThenEscalate already runs for running/fixing lanes, extended to cover it too
// (drivingLaneTerminalForDrain decides which ones qualify — see that function's own doc). ──

test("tick: KILL_SWITCH drain — a driving lane AT the fix-rounds cap is TERMINAL-for-drain (#375 AC2): escalated to needs-human past the drain window, activeWorkers() reaches zero so wind-down can exit", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-killswitch-drain-driving-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 }); // at this test's own lanes.prFixCap (2) — #450: default rose 2 -> 4
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const cfg = mkCfg({ cost: { drainWindowSec: 60 }, lanes: { prFixCap: 2 } });
    let clock = new Date("2026-07-20T00:00:00Z");
    const now = () => clock;

    const r1 = await tick({ forge, state: st, supervisor: sup, cfg, now });
    assert.equal(r1.ceilingBreached, true);
    assert.deepEqual(r1.escalated, []); // just breached — still within the drain window
    assert.equal(st.getWorker("lane-a")?.state, "driving"); // not yet touched

    clock = new Date(clock.getTime() + 61_000); // past drainWindowSec, switch still active
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now });
    assert.deepEqual(r2.escalated, ["lane-a"]);
    assert.equal(st.getWorker("lane-a")?.state, "failed");
    assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
    // Evidence: the drain reason (fix-capped, not the daily-budget variant) is on the record.
    const ev = st.latestEvent("drive-needs-human") as { payload: { reason: string } } | undefined;
    assert.match(ev!.payload.reason, /drain-fix-rounds-capped:2\/2/);
    // #375 review round 3 (P2): the pre-terminal evidence comment landed too, naming the drain
    // reason (kill-switch), the fix-rounds spent/cap, and the #147 gated-reentry recovery path —
    // a human landing on this needs-human issue is never left with zero explanation.
    assert.equal(forge.issueComments.length, 1);
    assert.equal(forge.issueComments[0]![0], 2);
    assert.match(forge.issueComments[0]![1], /kill-switch drain/);
    assert.match(forge.issueComments[0]![1], /drain-fix-rounds-capped:2\/2/);
    assert.match(forge.issueComments[0]![1], /2 fix round\(s\) spent of 2/);
    assert.match(forge.issueComments[0]![1], /#147 gated reentry/);
    assert.equal(st.activeWorkers().length, 0); // #375 AC2: wind-down's activeWorkers()===0 loop can now exit
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick: KILL_SWITCH drain — a failed EVIDENCE COMMENT (label already succeeded) leaves the row `driving` too (#375 review round 3, P2): never a terminal upsert with no explanation, retried on the very next tick", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-killswitch-drain-driving-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 }); // at this test's own lanes.prFixCap (2) — #450: default rose 2 -> 4
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const cfg = mkCfg({ cost: { drainWindowSec: 60 }, lanes: { prFixCap: 2 } });
    let clock = new Date("2026-07-20T00:00:00Z");
    const now = () => clock;

    await tick({ forge, state: st, supervisor: sup, cfg, now }); // detect breach
    clock = new Date(clock.getTime() + 61_000); // past the drain window

    // Tick 2: the label write succeeds, but the evidence comment fails — the row must stay
    // `driving` (never a needs-human issue with zero explanation of why the engine gave up).
    forge.throwOnAddIssueComment = true;
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now });
    assert.deepEqual(r2.escalated, [], "a failed evidence-comment write must NOT count as drained");
    assert.equal(st.getWorker("lane-a")?.state, "driving", "stays driving — never a terminal upsert without the evidence comment");
    assert.notEqual(st.getWorker("lane-a")?.gated_escalation_labeled, 1, "no terminal latch yet");
    assert.deepEqual(forge.issueComments, [], "the failed comment attempt left no partial trace");
    const failEv = st.latestEvent("drain-driving-escalation-comment-failed") as { payload: { reason: string; error: string } } | undefined;
    assert.match(failEv!.payload.reason, /drain-fix-rounds-capped:2\/2/);

    // Tick 3: forge recovers — retried immediately (same still-elapsed breach window, no fresh
    // window needed). The re-attempted label call is a harmless idempotent duplicate.
    forge.throwOnAddIssueComment = false;
    const r3 = await tick({ forge, state: st, supervisor: sup, cfg, now });
    assert.deepEqual(r3.escalated, ["lane-a"]);
    assert.equal(st.getWorker("lane-a")?.state, "failed");
    assert.equal(st.getWorker("lane-a")?.gated_escalation_labeled, 1);
    assert.equal(forge.issueComments.length, 1);
    assert.match(forge.issueComments[0]![1], /drain-fix-rounds-capped:2\/2/);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick: KILL_SWITCH drain — a driving lane's escalation honors the #69/#147 forge-before-terminal-upsert ordering (#375 review round 2, P2): a failed needs-human label write leaves the row `driving` (never a terminal upsert on a write failure), retried on the very next tick", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-killswitch-drain-driving-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55, { fix_rounds: 2 }); // at this test's own lanes.prFixCap (2) — #450: default rose 2 -> 4
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const cfg = mkCfg({ cost: { drainWindowSec: 60 }, lanes: { prFixCap: 2 } });
    let clock = new Date("2026-07-20T00:00:00Z");
    const now = () => clock;

    await tick({ forge, state: st, supervisor: sup, cfg, now }); // detect breach
    clock = new Date(clock.getTime() + 61_000); // past the drain window

    // Tick 2: the label write fails — unlike escalateNeedsHuman's OTHER callers (which commit
    // the terminal upsert regardless, tracking the failure via gated_escalation_labeled: 0), the
    // drain path must NOT terminalize on a write failure: this IS the row's one scheduled visit
    // for the current breach, so it stays `driving` and is retried, not silently downgraded to
    // permanently-manual.
    forge.throwOnAddLabel = true;
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now });
    assert.deepEqual(r2.escalated, [], "a failed label write must NOT count as drained");
    assert.equal(st.getWorker("lane-a")?.state, "driving", "stays driving — never a terminal upsert on a write failure");
    assert.notEqual(
      st.getWorker("lane-a")?.gated_escalation_labeled,
      1,
      "no gated_escalation_labeled=1 latch on a failed write — this row is NOT terminalized at all yet",
    );
    const failEv = st.latestEvent("drain-driving-escalation-label-failed") as { payload: { reason: string; error: string } } | undefined;
    assert.match(failEv!.payload.reason, /drain-fix-rounds-capped:2\/2/);

    // Tick 3: forge recovers — the SAME still-elapsed breach window retries immediately (no
    // fresh window needed, per recordCeilingBreach's first-detection-only INSERT OR IGNORE).
    forge.throwOnAddLabel = false;
    const r3 = await tick({ forge, state: st, supervisor: sup, cfg, now });
    assert.deepEqual(r3.escalated, ["lane-a"]);
    assert.equal(st.getWorker("lane-a")?.state, "failed");
    assert.equal(st.getWorker("lane-a")?.gated_escalation_labeled, 1);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick: KILL_SWITCH drain — a driving lane mid-fix-loop (fix_rounds>0, under cap) blocked ONLY by the daily-budget ceiling is TERMINAL-for-drain too (#375 AC2: round budget is exempt, but daily budget can still wedge a fix leg)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-killswitch-drain-driving-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 }); // under the default cap (2) — has needed a fix leg before
    st.recordSpend("lane-earlier", 99, 500, "2026-07-20T00:00:01.000Z"); // over a tiny daily cap, same UTC day as `clock`
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const cfg = mkCfg({ cost: { drainWindowSec: 60, dailyBudgetUsd: 10 } });
    let clock = new Date("2026-07-20T00:00:00Z");
    const now = () => clock;

    await tick({ forge, state: st, supervisor: sup, cfg, now }); // detect breach
    clock = new Date(clock.getTime() + 61_000); // past the drain window
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now });

    assert.deepEqual(r2.escalated, ["lane-a"]);
    assert.equal(st.getWorker("lane-a")?.state, "failed");
    assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
    // Evidence: the daily-budget-blocked reason (not the fix-capped variant) is on the record.
    const ev = st.latestEvent("drive-needs-human") as { payload: { reason: string } } | undefined;
    assert.match(ev!.payload.reason, /drain-daily-budget-blocked:fix-rounds=1/);
    assert.equal(st.activeWorkers().length, 0);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick: KILL_SWITCH drain — a driving lane that never needed a fix leg (fix_rounds=0, e.g. MERGE/WAIT-gated) is left alone even past the drain window (#375 AC2 scope: only budget-blocked/fix-capped lanes are terminal-for-drain)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-killswitch-drain-driving-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55); // fix_rounds 0 — never been through the fix loop
    st.recordSpend("lane-earlier", 99, 500, "2026-07-20T00:00:01.000Z"); // daily cap breached too
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const cfg = mkCfg({ cost: { drainWindowSec: 60, dailyBudgetUsd: 10 } });
    let clock = new Date("2026-07-20T00:00:00Z");
    const now = () => clock;

    await tick({ forge, state: st, supervisor: sup, cfg, now }); // detect breach
    clock = new Date(clock.getTime() + 61_000); // past the drain window
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now });

    assert.deepEqual(r2.escalated, []); // never touched — it isn't stuck for a budget reason at all
    assert.equal(st.getWorker("lane-a")?.state, "driving");
    assert.deepEqual(forge.labelsAdded, []);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #375: regression fixtures mirroring the two dogfood-observed wedges (events 37–77 and
// 123–446 — round cap $30 then $60, a FIXABLE fix leg blocked, round never closing; then
// KILL_SWITCH set with the same driving lane still stuck, wind-down spinning 14+ minutes until
// force-killed). Both round-budget tiers now dispatch normally (item 1's exemption); the
// KILL_SWITCH spin is closed by the three tests just above (item 2).
test("tick DRIVE (#375 regression): a driving lane's fix leg dispatches normally at EITHER dogfood round-cap tier ($30 or $60 roundBudgetUsd), however far round spend has crossed it", async () => {
  for (const [roundBudgetUsd, roundSpend] of [
    [30, 45], // first dogfood wedge tier
    [60, 123], // second dogfood wedge tier, after the cap was raised mid-run
  ] as const) {
    const st = new State(":memory:");
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55);
    const gate = new FakeMergeGate();
    gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
    const r = await tick({
      now: realClock,
      forge,
      state: st,
      supervisor: sup,
      cfg: mkCfg({ cost: { roundBudgetUsd } }),
      mergeGate: gate,
      roundSpendUsd: () => roundSpend,
      fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
    });
    assert.equal(st.getWorker("lane-a")?.state, "fixing", `roundBudgetUsd=${roundBudgetUsd}, spend=${roundSpend}`);
    assert.equal(r.driven[0]?.kind, "fixup");
    st.close();
  }
});

// ── #375 review round 1 (P1): the CEILING (daily-budget/wall-clock) drain path must use THIS
// TICK's own OBSERVED DRIVE outcome, never the kill-switch path's heuristic — DRIVE already ran
// this same tick (it precedes the CEILING section), so what actually happened to a driving lane
// is known, not merely inferred from its historical fix_rounds. ──────────────────────────────

test("tick: CEILING drain (daily-budget breach) — a driving lane admission-blocked THIS TICK (ceiling blocks its FIXUP spawn) is escalated past the drain window, using OBSERVED evidence (#375 review round 1, P1)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55); // fix_rounds 0 — the admission block is the ONLY reason it's stuck
  st.recordSpend("lane-earlier", 99, 500, "2026-07-20T00:00:01.000Z"); // over a tiny daily cap, same UTC day as `clock`
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "fixable", pr: 55, reason: "gate:FIXABLE:HANDLE_THREADS:unresolvedThreads=1:ciRed=false" };
  const cfg = mkCfg({ cost: { drainWindowSec: 60, dailyBudgetUsd: 10 } });
  let clock = new Date("2026-07-20T00:00:00Z");
  const now = () => clock;
  const tickOpts = {
    forge,
    state: st,
    supervisor: sup,
    cfg,
    mergeGate: gate,
    now,
    fixLegResume: { renderFixPrompt: () => "p", mintProxy: async () => ({}) as never },
  };

  const r1 = await tick(tickOpts);
  assert.equal(r1.ceilingBreached, true);
  assert.equal(r1.driven[0]?.kind, "queued");
  assert.match((r1.driven[0] as { reason: string }).reason, /fix-leg-admission-blocked:ceiling/);
  assert.deepEqual(r1.escalated, []); // just breached — still within the drain window
  assert.equal(st.getWorker("lane-a")?.state, "driving");

  clock = new Date(clock.getTime() + 61_000); // past drainWindowSec, breach still standing
  const r2 = await tick(tickOpts);
  assert.deepEqual(r2.escalated, ["lane-a"]);
  assert.equal(st.getWorker("lane-a")?.state, "failed");
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
  const ev = st.latestEvent("drive-needs-human") as { payload: { reason: string } } | undefined;
  assert.match(ev!.payload.reason, /drain-ceiling-admission-blocked:fix-rounds=0/);
  st.close();
});

test("tick: CEILING drain (daily-budget breach) — a driving lane in WAIT this tick (fix_rounds>0 from a PAST fix leg, but no NEW fixable finding — its rework is done, just awaiting re-review) is NEVER escalated, even past the drain window: it can still merge for free the instant review lands (#375 review round 1, P1 — the exact false positive the old heuristic would have produced on this path)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55, { fix_rounds: 1 }); // needed a fix leg before, but...
  st.recordSpend("lane-earlier", 99, 500, "2026-07-20T00:00:01.000Z"); // daily cap breached
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate:WAIT_REVIEW" }; // ...its fix leg is DONE, just awaiting re-review
  const cfg = mkCfg({ cost: { drainWindowSec: 60, dailyBudgetUsd: 10 } });
  let clock = new Date("2026-07-20T00:00:00Z");
  const now = () => clock;
  const tickOpts = { forge, state: st, supervisor: sup, cfg, mergeGate: gate, now };

  await tick(tickOpts); // detect breach
  clock = new Date(clock.getTime() + 61_000); // past the drain window, breach still standing
  const r2 = await tick(tickOpts);

  assert.deepEqual(r2.escalated, []); // the OLD heuristic (fix_rounds>0 && dailyBudgetBreached) would wrongly escalate this
  assert.equal(st.getWorker("lane-a")?.state, "driving"); // untouched — free to merge once review lands
  assert.deepEqual(forge.labelsAdded, []);
  st.close();
});

// ── #426 (F26) AC2: drain terminality conditioned on the CI-pending pin. A CI-wedged lane
// typically has fix_rounds === 0 (it never needed the fix loop at all), which is exactly the shape
// BOTH pre-#426 drain arms deliberately left alone — so a ceiling breach or a kill switch spun the
// bounded drain against a lane that could never progress. The pin is what makes it decidable, in
// both arms, without touching #375's no-false-escalation ruling for a lane that is merely WAITING. ──

/** #426: the durable CI-pending pin a wedged lane carries — appended directly (the DRIVE-side pin
 *  lifecycle has its own tests above); these are drain-side tests, and the pin is just their input. */
const seedCiPendingPin = (st: State, worker: string, issue: number, pr: number, at: string, head = "H1") =>
  st.appendEvent("ci-pending-observed", { worker, issue, pr, head, at });

test("#426 AC2 (CEILING drain, observed arm): a CI-wedged fix_rounds=0 lane — pin past the bound — is terminated past the drain window; pre-#426 it hung forever", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55); // fix_rounds 0 — the CI wedge is the ONLY reason it is stuck
  seedCiPendingPin(st, "lane-a", 2, 55, "2026-07-19T00:00:00.000Z"); // pinned a full day ago
  st.recordSpend("lane-earlier", 99, 500, "2026-07-20T00:00:01.000Z"); // over a tiny daily cap
  const gate = new FakeMergeGate();
  // What DRIVE actually sees every tick: gate② decisive, gate① neither green nor red -> WAIT.
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:MERGE_OK", ciPendingObservation: { pending: true, head: "H1" } };
  const cfg = mkCfg({ cost: { drainWindowSec: 60, dailyBudgetUsd: 10 }, ci: { pendingEscalateAfterSec: 3600 } });
  let clock = new Date("2026-07-20T00:00:00Z");
  const now = () => clock;
  const tickOpts = { forge, state: st, supervisor: sup, cfg, mergeGate: gate, now };

  const r1 = await tick(tickOpts);
  assert.equal(r1.ceilingBreached, true);
  assert.deepEqual(r1.escalated, []); // just breached — still inside the drain window
  assert.equal(st.getWorker("lane-a")?.state, "driving");

  clock = new Date(clock.getTime() + 61_000); // past drainWindowSec, breach still standing
  const r2 = await tick(tickOpts);
  assert.deepEqual(r2.escalated, ["lane-a"]);
  assert.equal(st.getWorker("lane-a")?.state, "failed");
  assert.deepEqual(forge.labelsAdded, [[2, "needs-human"]]);
  const ev = st.latestEvent("drive-needs-human") as { payload: { reason: string } } | undefined;
  assert.match(ev!.payload.reason, /drain-ci-pending-wedged:fix-rounds=0/);
  st.close();
});

test("#426 AC2 (CEILING drain): a FRESH CI-pending pin is a healthy WAIT — never terminal, preserving #375's no-false-escalation ruling", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  seedCiPendingPin(st, "lane-a", 2, 55, "2026-07-19T23:59:00.000Z"); // one minute old against a 1h bound
  st.recordSpend("lane-earlier", 99, 500, "2026-07-20T00:00:01.000Z");
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:MERGE_OK", ciPendingObservation: { pending: true, head: "H1" } };
  const cfg = mkCfg({ cost: { drainWindowSec: 60, dailyBudgetUsd: 10 }, ci: { pendingEscalateAfterSec: 3600 } });
  let clock = new Date("2026-07-20T00:00:00Z");
  const now = () => clock;
  const tickOpts = { forge, state: st, supervisor: sup, cfg, mergeGate: gate, now };

  await tick(tickOpts);
  clock = new Date(clock.getTime() + 61_000);
  const r2 = await tick(tickOpts);
  assert.deepEqual(r2.escalated, []); // CI is simply still running — it can go green at any moment
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  assert.deepEqual(forge.labelsAdded, []);
  st.close();
});

test("#426 AC2 (KILL_SWITCH drain, heuristic arm): the same CI-wedged fix_rounds=0 lane is terminal for the wind-down, where DRIVE never runs at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ci-wedged-killswitch-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    seedDriving(st, "lane-a", 2, 55);
    seedCiPendingPin(st, "lane-a", 2, 55, "2026-07-19T00:00:00.000Z");
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const cfg = mkCfg({ cost: { drainWindowSec: 60 }, ci: { pendingEscalateAfterSec: 3600 } });
    let clock = new Date("2026-07-20T00:00:00Z");
    const now = () => clock;

    await tick({ forge, state: st, supervisor: sup, cfg, now }); // detect
    clock = new Date(clock.getTime() + 61_000);
    const r2 = await tick({ forge, state: st, supervisor: sup, cfg, now });

    assert.deepEqual(r2.escalated, ["lane-a"]);
    assert.equal(st.getWorker("lane-a")?.state, "failed");
    const ev = st.latestEvent("drive-needs-human") as { payload: { reason: string } } | undefined;
    assert.match(ev!.payload.reason, /drain-ci-pending-wedged:fix-rounds=0/);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#426 review round 2 (P2): the GATED RECLAIM row transition and its `gated-reentry` reset event land in ONE transaction — row reclaimed <=> reset recorded, so a crash cannot leave an aged pin without its episode boundary", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ ci: { pendingEscalateAfterSec: 3600 } });
  const gate = new FakeMergeGate();
  st.upsertWorker({
    name: "lane-a",
    issue: 10,
    session_id: "s-lane-a",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 99,
    gated_escalation_labeled: 1,
  });
  // The lane carries an OLD, already-past-the-bound CI-pending pin from before its escalation.
  st.appendEvent("ci-pending-observed", { worker: "lane-a", issue: 10, pr: 99, head: "H1", at: "2026-07-19T00:00:00.000Z" });
  forge.issueLabelsByIssue[10] = []; // human removed needs-human — the reentry signal
  gate.outcomes[99] = { kind: "queued", pr: 99, reason: "gate-pending:WAIT_REVIEW" };

  const r = await tick({ now: () => new Date("2026-07-20T00:00:00.000Z"), forge, state: st, supervisor: sup, cfg, mergeGate: gate });

  // The pairing invariant, both directions: the row moved AND the reset event exists.
  assert.deepEqual(r.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-a", issue: 10, pr: 99, attempt: 1 }]);
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  assert.equal(st.getWorker("lane-a")?.gated_reentry_attempts, 1);
  assert.equal(
    (st.latestEvent("gated-reentry") as { payload: { worker: string; pr: number; attempt: number } } | undefined)?.payload.attempt,
    1,
  );
  // Which is what makes the stale pin invisible: the reset event out-IDS the pin, the exact
  // comparison the drain predicate makes. (The atomicity itself is state.ts's own primitive —
  // `upsertWorkerWithEvent`'s rollback is pinned in state.test.ts.)
  assert.ok(st.maxEventIdForKinds(["gated-reentry"], "lane-a", 99) > st.lastCiPendingEvent("lane-a", 99)!.id);
  st.close();
});

test("#426 AC2: a CI-pending pin that a gated reentry already superseded is NOT wedged — the human who reclaimed the lane gets the full bound before the engine calls them again", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-a", 2, 55);
  seedCiPendingPin(st, "lane-a", 2, 55, "2026-07-19T00:00:00.000Z");
  st.appendEvent("gated-reentry", { worker: "lane-a", issue: 2, pr: 55, attempt: 1 }); // ends the episode
  st.recordSpend("lane-earlier", 99, 500, "2026-07-20T00:00:01.000Z");
  const gate = new FakeMergeGate();
  gate.outcomes[55] = { kind: "queued", pr: 55, reason: "gate-pending:WAIT_REVIEW" }; // re-review in flight, no observation
  const cfg = mkCfg({ cost: { drainWindowSec: 60, dailyBudgetUsd: 10 }, ci: { pendingEscalateAfterSec: 3600 } });
  let clock = new Date("2026-07-20T00:00:00Z");
  const now = () => clock;
  const tickOpts = { forge, state: st, supervisor: sup, cfg, mergeGate: gate, now };

  await tick(tickOpts);
  clock = new Date(clock.getTime() + 61_000);
  assert.deepEqual((await tick(tickOpts)).escalated, []);
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  st.close();
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

    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

    // Dispatch: nothing happened, no "skipped" rows either — the phase never ran.
    assert.deepEqual(r.dispatched, []);
    assert.deepEqual(forge.claimed, []);
    assert.deepEqual(sup.dispatched, [] as Issue[]);
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

    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

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
    const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.deepEqual(r1.dispatched, []);
    assert.equal(st.runningWorkers().length, 0);

    rmSync(pausePath, { force: true }); // human resumes
    const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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

  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
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
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(r2.reclaimed, [{ kind: "kept", worker: "lane-adopt", issue: 169 }]);
  assert.deepEqual(sup.handoffRequested, ["lane-adopt"]);
  assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["lane-adopted"]).length, 1);

  // probe()'s real detached path writes this sentinel once the pid is confirmed dead. The
  // conductor settles it on one tick and the existing resume path starts it on the next.
  sup.probes["lane-adopt"] = { ...DEFAULT_PROBE, handoff: true };
  const r3 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  assert.equal(r3.reclaimed[0]?.kind, "handoff");
  assert.equal(st.getWorker("lane-adopt")?.state, "handoff");
  assert.deepEqual(r3.resumed, []);

  const r4 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(r4.resumed, [{ kind: "resumed", worker: "lane-adopt", issue: 169, attempt: 1 }]);
  assert.equal(st.getWorker("lane-adopt")?.state, "running");
  assert.deepEqual(forge.labelsAdded, []);
  st.close();
});

/** #403 (F25), PR #430 gate② round 3: wait until `predicate` holds, with a NAMED rejection if it
 *  never does. The bound exists to keep a genuinely wedged process from hanging the runner until
 *  its outer ceiling — it is deliberately generous (orders of magnitude above the real work being
 *  waited on) so it bounds catastrophe rather than deciding any test's verdict. The banned shape
 *  is the opposite: a tight budget whose expiry IS the assertion (docs/REVIEW-DOCTRINE.md, "No
 *  timing-dependent assertions"). */
const waitForNamed = async (predicate: () => boolean, message: string, timeoutMs = 30_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`hang guard (${timeoutMs}ms): ${message}`);
    await sleep(20);
  }
};

/** True once `pid` no longer exists — `kill(pid, 0)` throws ESRCH for a reaped process. */
const pidIsGone = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

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
  const s1 = new WorkerSupervisor({ now: realClock, cfg, stateDir: dir, claudeBin: bin, heartbeatMs: 60_000 });
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

    s2 = new WorkerSupervisor({ now: realClock, cfg, stateDir: dir, claudeBin: bin, heartbeatMs: 60_000 });
    const adopted = await tick({ now: realClock, forge, state: st, supervisor: s2, cfg });
    assert.deepEqual(adopted.reclaimed, [{ kind: "kept", worker: name, issue: 169 }]);
    assert.equal(st.getWorker(name)?.state, "running");
    assert.deepEqual(forge.labelsAdded, []);
    assert.deepEqual(st.latestEvent("lane-adopted")?.payload, {
      worker: name,
      issue: 169,
      note: "Spend during engine downtime was unobserved.",
    });

    // #403 (F25), PR #430 gate② round 3: a NAMED HANG GUARD, not a real-time budget. This was a
    // 400x20ms bounded poll followed by `assert.throws(process.kill(pid, 0))`, which made the
    // verdict "did a real subprocess exit within 8 seconds of wall clock" — under concurrent load
    // it does not (caught live: this test failed at 10.17s in this PR's own load evidence, with
    // "Missing expected exception", i.e. the wrapper was merely slow, not broken). The wrapper's
    // own work here is a bash TERM trap plus `exit`, so any bound orders of magnitude above that
    // is a backstop rather than a margin: waiting on the condition means the test now fails only
    // if the wrapper never exits AT ALL, and says so by name when it doesn't.
    await waitForNamed(
      () => pidIsGone(running.wrapper_pid),
      "the cooperative wrapper never exited from the graceful SIGTERM (a SIGKILL would not satisfy the marker assertion below either)",
    );
    assert.ok(existsSync(termMarker), "TERM trap wrote its marker; SIGKILL cannot satisfy this assertion");

    const settled = await tick({ now: realClock, forge, state: st, supervisor: s2, cfg });
    assert.equal(settled.reclaimed[0]?.kind, "handoff");
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "probe wrote the detached .handoff sentinel");
    assert.equal(st.getWorker(name)?.state, "handoff");

    const resumed = await tick({ now: realClock, forge, state: st, supervisor: s2, cfg });
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
    now: realClock,
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
  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-ho")?.state, "handoff");
  assert.deepEqual(r1.resumed, []);
  assert.equal(st.spentUsdForWorker("lane-ho"), 3);

  // Next tick: RESUME gets the lane before fresh work and makes it an ordinary running lane.
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(r2.resumed, [{ kind: "resumed", worker: "lane-ho", issue: 172, attempt: 1 }]);
  assert.equal(st.getWorker("lane-ho")?.state, "running");
  assert.equal(st.getWorker("lane-ho")?.resume_attempts, 1);

  // The resumed leg finishes with a PR. Ordinary RECLAIM -> DRIVE handles it in the same tick.
  sup.probes["lane-ho"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 77, costUsd: 2 };
  const r3 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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
    now: realClock,
    cfg,
    stateDir: dir,
    claudeBin: join(dir, "must-not-spawn"),
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

    const result = await tick({ now: realClock, forge: new FakeForge(), state: st, supervisor, cfg });
    assert.deepEqual(result.resumed, [{ kind: "resumed", worker: "lane-crash", issue: 172, attempt: 1 }]);
    assert.equal(st.getWorker("lane-crash")?.state, "running");
    assert.equal(st.getWorker("lane-crash")?.session_id, "surviving-session");
    assert.equal(existsSync(join(dir, "lane-crash.handoff.json")), false, "adoption completes stale handoff removal");
    assert.equal(st.maxSpendLedgerId(), 0, "the stale prior-leg handoff is not re-recorded");

    const reclaimed = await tick({ now: realClock, forge: new FakeForge(), state: st, supervisor, cfg });
    assert.equal(reclaimed.reclaimed[0]?.kind, "dead");
    assert.equal(st.getWorker("lane-crash")?.state, "failed");
    assert.equal(st.spentUsdForWorker("lane-crash"), 1.25);
    await tick({ now: realClock, forge: new FakeForge(), state: st, supervisor, cfg });
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
    now: realClock,
    cfg,
    stateDir: dir,
    claudeBin: join(dir, "must-not-spawn"),
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

    const result = await tick({ now: realClock, forge, state: st, supervisor, cfg });
    assert.deepEqual(result.resumed, [{ kind: "capped", worker: "lane-ambiguous", issue: 1172, attempts: 0 }]);
    assert.equal(st.getWorker("lane-ambiguous")?.resume_capped, 1);
    assert.deepEqual(forge.labelsAdded, [[1172, "needs-human"]]);
    assert.equal(forge.issueComments.length, 1);
    assert.match(forge.issueComments[0]![1], /ambiguous crash state/i);
    assert.match(forge.issueComments[0]![1], /session-evidence/);
    assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["resume-undecidable"]).length, 1);
    assert.equal(st.eventsSince("1970-01-01T00:00:00.000Z", ["resume-failed"]).length, 0);
    assert.equal(existsSync(join(dir, "lane-ambiguous.handoff.json")), true, "evidence remains for human triage");

    const again = await tick({ now: realClock, forge, state: st, supervisor, cfg });
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
  const supervisor = new WorkerSupervisor({ now: realClock, cfg, stateDir: dir, claudeBin: bin });
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

    const resumed = await tick({ now: realClock, forge: new FakeForge(), state, supervisor, cfg });
    assert.deepEqual(resumed.resumed, [{ kind: "resumed", worker: "lane-detached", issue: 172, attempt: 1 }]);
    assert.equal(state.getWorker("lane-detached")?.state, "running");
    assert.equal(existsSync(join(dir, "lane-detached.handoff.json")), false, "normal resume consumed the handoff anchor");
    assert.equal(state.maxSpendLedgerId(), 1, "resume itself does not re-ledger leg 1");

    for (let i = 0; i < 400 && !existsSync(join(dir, "lane-detached.done.json")); i++) await sleep(20);
    assert.ok(existsSync(join(dir, "lane-detached.done.json")), "the real resumed process completed");
    await tick({ now: realClock, forge: new FakeForge(), state, supervisor, cfg });
    assert.equal(state.getWorker("lane-detached")?.state, "done");
    assert.equal(state.spentUsdForWorker("lane-detached"), 3);
    assert.equal(state.maxSpendLedgerId(), 2, "exactly one ledger row per leg");

    await tick({ now: realClock, forge: new FakeForge(), state, supervisor, cfg });
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
  const result = await tick({ now: realClock, forge, state: st, supervisor: new FakeSupervisor(), cfg: mkCfg(), dispatchCapOverride: 0 });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg }); // leg 0 -> handoff
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg }); // resume attempt 1
  sup.probes["lane-cap"] = { ...DEFAULT_PROBE, handoff: true, costUsd: 0.5 };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg }); // resumed leg -> handoff

  const capped = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(capped.resumed, [{ kind: "capped", worker: "lane-cap", issue: 173, attempts: 1 }]);
  assert.equal(st.getWorker("lane-cap")?.resume_capped, 1);
  assert.deepEqual(forge.labelsAdded, [[173, "needs-human"]]);
  assert.equal(sup.resumed.length, 1);

  const again = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(again.resumed, []);
  assert.equal(forge.labelsAdded.length, 1);
  assert.equal(st.eventsSince("2020-01-01T00:00:00Z", ["resume-capped"]).length, 1);
  st.close();
});

test("#295 review round 4 (Codex P1): resume-capped preserves a fixing-origin lane's known PR", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ worker: { maxResumes: 1 } });
  seedRunning(st, "lane-pr", 174);
  st.upsertWorker({ ...st.getWorker("lane-pr")!, pr: 4242 });

  sup.probes["lane-pr"] = { ...DEFAULT_PROBE, handoff: true, costUsd: 1 };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg }); // leg 0 -> handoff
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg }); // resume attempt 1
  sup.probes["lane-pr"] = { ...DEFAULT_PROBE, handoff: true, costUsd: 0.5 };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg }); // resumed leg -> handoff
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg }); // cap

  const [event] = st.eventsSince("2020-01-01T00:00:00Z", ["resume-capped"]);
  // Without the PR, escalation-reconcile can never observe an external merge of it.
  assert.equal((event?.payload as { pr?: number } | undefined)?.pr, 4242);
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

    assert.deepEqual((await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() })).resumed, []);
    rmSync(join(dir, "PAUSE"), { force: true });
    assert.deepEqual((await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() })).resumed, []);
    forge.issueLabelsByIssue[174] = [];
    assert.deepEqual((await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() })).resumed, [
      { kind: "resumed", worker: "lane-p", issue: 174, attempt: 1 },
    ]);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#441 review round 2 (Codex P1): a CLOSED-unmerged PR must not let a lane clear its OWN human gate — sweep + GATED RECLAIM produce no churn across five rounds", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  const gate = new FakeMergeGate();

  // The exact shape gatedFailedWorkers() requires: a failed lane holding a PR, with the engine's
  // own escalation label provably applied (gated_escalation_labeled = 1).
  seedRunning(st, "lane-c", 403);
  const lane = st.getWorker("lane-c")!;
  st.upsertWorker({ ...lane, state: "failed", pr: 430, ended_at: "t1", gated_escalation_labeled: 1 });
  st.appendEvent("drive-needs-human", { worker: "lane-c", issue: 403, pr: 430, labeled: 1 });
  forge.issueLabelsByIssue[403] = [cfg.labels.needsHuman];
  // The producer guard permits `gh pr close`, so a worker can put its own lane here.
  forge.prStatus = { ...forge.prStatus, state: "CLOSED" };

  for (let round = 0; round < 5; round++) {
    await reconcileEscalations(forge, st, cfg);
    await sweepResolvedHolds(forge, st, cfg);
    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(r.gatedReclaimed, [], `round ${round}: the hold still stands — no reentry`);
  }

  assert.deepEqual(forge.issueLabelsByIssue[403], [cfg.labels.needsHuman], "the human gate survived every round");
  assert.equal(st.eventsAfterId(0, ["needs-human-swept"]).length, 0);
  assert.equal(st.eventsAfterId(0, ["gated-reentry"]).length, 0);
  assert.equal(st.eventsAfterId(0, ["gated-reentry-capped"]).length, 0, "the cap was never burned by engine-manufactured reentries");
  assert.equal(st.getWorker("lane-c")?.state, "failed");
  assert.equal(st.getWorker("lane-c")?.gated_reentry_attempts ?? 0, 0);
  // The strip row still clears exactly once — visibility is unchanged, only the WRITE is refused.
  const resolved = st.eventsAfterId(0, ["escalation-resolved"]);
  assert.equal(resolved.length, 1);
  assert.equal((resolved[0]!.payload as { via: string }).via, "pr-closed");
  st.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// #441 (F34): the RESUME phase's hold-suppression event. The SKIP branch itself is unchanged
// (AC3 — the label still suppresses, its removal is still the go-ahead); what these cover is
// that the suppression is now VISIBLE, exactly once per episode, restart-safe, and deduped
// against the durable event log rather than a per-process flag.
// ─────────────────────────────────────────────────────────────────────────────

const resumeHeldEvents = (st: State) => st.eventsAfterId(0, ["resume-held"]).map((e) => e.payload as Record<string, unknown>);

test("#441 (AC2): a hold-suppressed resume emits exactly ONE resume-held across three ticks, naming the label that suppressed it", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  st.upsertWorker({ name: "lane-h", issue: 441, session_id: "s", state: "handoff", started_at: "t", ended_at: "t" });
  forge.issueLabelsByIssue[441] = [cfg.labels.needsHuman];

  for (let i = 0; i < 3; i++) {
    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
    assert.deepEqual(r.resumed, [], "AC3: the label still means SKIP, every tick");
  }

  assert.deepEqual(resumeHeldEvents(st), [{ worker: "lane-h", issue: 441, label: cfg.labels.needsHuman, attempts: 0 }]);
  assert.equal(sup.resumed.length, 0);
  assert.equal(st.getWorker("lane-h")?.state, "handoff");
  st.close();
});

test("#441 (AC3 + episode boundary): removing the label resumes the lane next tick, and a LATER hold announces a NEW episode", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  st.upsertWorker({ name: "lane-h", issue: 441, session_id: "s", state: "handoff", started_at: "t", ended_at: "t" });
  forge.issueLabelsByIssue[441] = [cfg.labels.needsHuman];
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  assert.equal(resumeHeldEvents(st).length, 1);

  // The human clears the hold — removal IS the go-ahead, unchanged by #441.
  forge.issueLabelsByIssue[441] = [];
  const resumedTick = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(resumedTick.resumed, [{ kind: "resumed", worker: "lane-h", issue: 441, attempt: 1 }]);

  // That `resumed` ENDED the episode. A second handoff under a fresh hold is a second episode.
  st.upsertWorker({ ...st.getWorker("lane-h")!, state: "handoff", ended_at: "t" });
  forge.issueLabelsByIssue[441] = ["blocked"]; // any of cfg.escalation.humanLabels, not just needs-human
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  assert.deepEqual(
    resumeHeldEvents(st).map((p) => p.label),
    [cfg.labels.needsHuman, "blocked"],
    "one event per episode — and the second names the label a human actually applied",
  );
  st.close();
});

test("#441: a SKIP that is NOT a hold (paused / no free lane) announces nothing — resume-held means a person, never a budget", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-resume-held-"));
  try {
    const st = new State(join(dir, "sapwood.sqlite"));
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    st.upsertWorker({ name: "lane-p", issue: 441, session_id: "s", state: "handoff", started_at: "t", ended_at: "t" });
    writeFileSync(join(dir, "PAUSE"), "");
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.deepEqual(resumeHeldEvents(st), [], "a paused lane carries no hold — PAUSE is already narrated elsewhere");

    // Lanes full is likewise silent here: same SKIP, still not a human's doing.
    rmSync(join(dir, "PAUSE"), { force: true });
    seedRunning(st, "lane-busy", 442);
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }) });
    assert.deepEqual(resumeHeldEvents(st), []);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#441 crash-rerun: a kill -9 between the hold observation and the next tick never double-emits resume-held", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-resume-held-crash-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const cfg = mkCfg();
    const forge = new FakeForge();
    forge.issueLabelsByIssue[441] = [cfg.labels.needsHuman];

    const before = new State(path);
    before.upsertWorker({ name: "lane-h", issue: 441, session_id: "s", state: "handoff", started_at: "t", ended_at: "t" });
    await tick({ now: realClock, forge, state: before, supervisor: new FakeSupervisor(), cfg });
    assert.equal(resumeHeldEvents(before).length, 1);
    before.close(); // no in-memory dedupe flag survives this

    const after = new State(path);
    await tick({ now: realClock, forge, state: after, supervisor: new FakeSupervisor(), cfg });
    await tick({ now: realClock, forge, state: after, supervisor: new FakeSupervisor(), cfg });
    assert.equal(resumeHeldEvents(after).length, 1, "the durable log IS the memory — one event for one episode");
    after.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#441: two held lanes announce independently — one lane's episode never dedupes another's", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ lanes: { max: 4, roundDispatchCap: 1 } });
  st.upsertWorker({ name: "lane-a", issue: 441, session_id: "s", state: "handoff", started_at: "t", ended_at: "t" });
  st.upsertWorker({ name: "lane-b", issue: 442, session_id: "s", state: "handoff", started_at: "t", ended_at: "t" });
  forge.issueLabelsByIssue[441] = [cfg.labels.needsHuman];
  forge.issueLabelsByIssue[442] = [cfg.labels.needsHuman];

  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });

  assert.deepEqual(
    resumeHeldEvents(st).map((p) => p.worker),
    ["lane-a", "lane-b"],
  );
  st.close();
});

test("#172 ordering: with one free slot, RESUME claims it before a fresh Ready issue reaches DISPATCH", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  st.upsertWorker({ name: "lane-old", issue: 175, session_id: "s", state: "handoff", started_at: "t", ended_at: "t" });
  forge.ready = [{ number: 176, title: "fresh", labels: ["prio:3-feature"] }];
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 1 } }) });
  assert.deepEqual(r.resumed, [{ kind: "resumed", worker: "lane-old", issue: 175, attempt: 1 }]);
  assert.deepEqual(sup.dispatched, [] as Issue[]);
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { roundDispatchCap: 2, max: 3 } }) });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), roundSpendUsd: () => 50 });
  assert.equal(r.overBudget, true);
  assert.ok(r.dispatched.some((d) => d.kind === "skipped" && d.issue === 2 && d.reason === "in-flight"));
  assert.ok(r.dispatched.some((d) => d.kind === "skipped" && d.issue === 3 && d.reason === "over-budget"));
  assert.deepEqual(sup.dispatched, [] as Issue[]); // nothing dispatched
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { max: 2, roundDispatchCap: 2 } }) });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg });

  assert.equal(r.ceilingBreached, true);
  assert.deepEqual(r.ceilingReasons, ["daily-budget"]);
  assert.deepEqual(r.dispatched, [{ kind: "skipped", issue: 2, reason: "ceiling" }]);
  assert.deepEqual(sup.dispatched, [] as Issue[]); // nothing launched
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
    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.equal(r.ceilingBreached, true);
    assert.deepEqual(r.ceilingReasons, ["kill-switch"]);
    assert.deepEqual(r.dispatched, []); // #69 global gate: DISPATCH never even ran
    assert.deepEqual(sup.dispatched, [] as Issue[]);
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(sup.inspected, ["lane-fail-clean"]);
  assert.equal(st.getWorker("lane-fail-clean")?.state, "driving"); // clean -> rescued as before
  assert.equal(st.getWorker("lane-fail-clean")?.pr, 92);
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.prLabelsAdded, []);
  st.close();
});

test("tick ceiling (#431): within ONE process life a wall-clock breach PERSISTS across quiet gaps — the pause-to-reset ritual is deleted; recovery is a restart's fresh anchor", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ cost: { maxWallClockSec: 600 } }); // 10-min cap for the test
  const firstStart = new Date("2026-07-06T00:00:00Z");
  let clock = firstStart;
  const now = () => clock;
  const tickAt = async (iso: string, processStartedAt: Date) => {
    clock = new Date(iso);
    return tick({ forge, state: st, supervisor: sup, cfg, now, processStartedAt });
  };

  // The process ages past the cap -> wall-clock breach at t=15min, dispatch frozen.
  assert.equal((await tickAt("2026-07-06T00:00:00Z", firstStart)).ceilingBreached, false);
  assert.equal((await tickAt("2026-07-06T00:05:00Z", firstStart)).ceilingBreached, false);
  forge.ready = [{ number: 4, title: "", labels: ["prio:3-feature"] }]; // arrives pre-breach
  const breached = await tickAt("2026-07-06T00:15:00Z", firstStart); // 900s alive > 600s cap
  assert.equal(breached.ceilingBreached, true);
  assert.deepEqual(breached.ceilingReasons, ["wall-clock"]);
  assert.deepEqual(breached.dispatched, [{ kind: "skipped", issue: 4, reason: "ceiling" }]);

  // A 16-minute quiet gap WITHIN the same process life recovers nothing: the anchor is process
  // start, so elapsed only grows — the deleted gap machinery's pause-to-reset ritual (an
  // operator pause > 900s used to reset the session) is gone, per the owner adjudication. This
  // process is done dispatching until it exits.
  const stillBreached = await tickAt("2026-07-06T00:31:00Z", firstStart);
  assert.equal(stillBreached.ceilingBreached, true, "no self-reset inside one process life");

  // The modern recovery: a RESTART (any gap length). The new process's fresh in-memory anchor
  // clears the ceiling and resumes dispatch; the durable breach row clears with it, so a
  // re-breach in the new life gets a fresh drain window.
  const restartAt = new Date("2026-07-06T00:32:00Z");
  const recovered = await tickAt("2026-07-06T00:32:00Z", restartAt);
  assert.equal(recovered.ceilingBreached, false);
  assert.equal(st.ceilingBreach(), null);
  assert.ok(recovered.dispatched.some((d) => d.kind === "dispatched" && d.issue === 4));
  st.close();
});

test("tick ceiling (#431): the wall-clock tier anchors to processStartedAt — elapsed past the cap breaches, regardless of tick cadence or gaps", async () => {
  // The old session-gap machinery is gone: no cadence scaling, no stale-gap reset. Elapsed is
  // simply now - processStartedAt, so a slow cadence can never void the tier (the PR #41 P2
  // fail-open class stays closed, now by construction instead of by gap arithmetic).
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ cost: { maxWallClockSec: 600 } }); // 10-min cap
  const processStartedAt = new Date("2026-07-06T00:00:00Z");
  let clock = processStartedAt;
  const now = () => clock;
  const tickAt = async (iso: string) => {
    clock = new Date(iso);
    return tick({ forge, state: st, supervisor: sup, cfg, now, processStartedAt });
  };
  assert.equal((await tickAt("2026-07-06T00:05:00Z")).ceilingBreached, false); // 300s alive < 600s cap
  const r = await tickAt("2026-07-06T00:20:00Z"); // 1200s alive > 600s cap
  assert.equal(r.ceilingBreached, true);
  assert.deepEqual(r.ceilingReasons, ["wall-clock"]);
  st.close();
});

test("tick ceiling (#431 AC1): a RESTART at ANY gap length gets a fresh wall clock — sub-900s and 900s+ gaps behave identically (the deleted inheritance machinery would have breached the short-gap case)", async () => {
  // Simulates the F29 shape: a first process life long enough to breach, then a restart. Under
  // the deleted engine_session machinery a restart within the 900s stale gap INHERITED the
  // breached session (the short-gap restart would see elapsed ~= first life + gap and breach
  // on its first tick); past the gap it reset. Now both restarts anchor at their own process
  // start and neither breaches — identical behavior at 100s and 3600s gaps.
  for (const gapSec of [100, 3600]) {
    const dir = mkdtempSync(join(tmpdir(), "sapwood-wallclock-"));
    try {
      const dbPath = join(dir, "sapwood.sqlite");
      const forge = new FakeForge();
      const cfg = mkCfg({ cost: { maxWallClockSec: 1000 } });
      const base = new Date("2026-07-06T00:00:00Z").getTime();

      // First process life: born t=0, still ticking at t=2000s -> breached (sanity anchor).
      let st = new State(dbPath);
      const firstStart = new Date(base);
      let clock = new Date(base + 2000_000);
      const r1 = await tick({ forge, state: st, supervisor: new FakeSupervisor(), cfg, now: () => clock, processStartedAt: firstStart });
      assert.equal(r1.ceilingBreached, true, "the first life really was past its own cap");
      st.close();

      // Restart after gapSec: a NEW process (fresh in-memory anchor), same durable DB.
      st = new State(dbPath);
      const secondStart = new Date(base + (2000 + gapSec) * 1000);
      clock = secondStart;
      const r2 = await tick({ forge, state: st, supervisor: new FakeSupervisor(), cfg, now: () => clock, processStartedAt: secondStart });
      assert.equal(r2.ceilingBreached, false, `gap ${gapSec}s: a restart starts a fresh clock — no inherited breach`);
      assert.deepEqual(r2.ceilingReasons, [], `gap ${gapSec}s behaves identically to every other gap length`);
      st.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("tick ceiling (#431 AC3): entering the ceiling emits ONE reason-bearing ceiling-breach-entered per episode — named reasons + thresholds + observed values, deduped across re-detections, re-armed by a fresh episode", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ cost: { maxWallClockSec: 600 } });
  const processStartedAt = new Date("2026-07-06T00:00:00Z");
  let clock = processStartedAt;
  const now = () => clock;
  const tickAt = async (iso: string) => {
    clock = new Date(iso);
    return tick({ forge, state: st, supervisor: sup, cfg, now, processStartedAt });
  };
  await tickAt("2026-07-06T00:05:00Z"); // under the cap — no breach, no event (and no spurious `cleared`)
  assert.equal(st.eventsAfterId(0, ["ceiling-breach-entered", "ceiling-breach-cleared"]).length, 0);
  await tickAt("2026-07-06T00:20:00Z"); // breach detected — announced once
  await tickAt("2026-07-06T00:21:00Z"); // still breached — same episode, NO second event
  const events = st.eventsAfterId(0, ["ceiling-breach-entered"]);
  assert.equal(events.length, 1, "one announcement per breach episode, not per tick");
  const payload = events[0]!.payload as {
    reason: string;
    wallClockElapsedSec: number;
    maxWallClockSec: number;
    dailyBudgetUsd: number;
  };
  assert.equal(payload.reason, "wall-clock", "the event names WHICH ceiling (per-reason, round 3)");
  assert.equal(payload.maxWallClockSec, 600, "the event carries the configured threshold");
  assert.equal(payload.wallClockElapsedSec, 1200, "the event carries the observed elapsed");
  assert.equal(typeof payload.dailyBudgetUsd, "number");
  // Episode ends (cap raised): the ledger closes it with ONE `cleared` receipt (round 2: the
  // pr-held/pr-released transition-pair shape), which is what re-arms the next announcement.
  const relaxed = mkCfg({ cost: { maxWallClockSec: 999999 } });
  clock = new Date("2026-07-06T00:22:00Z");
  await tick({ forge, state: st, supervisor: sup, cfg: relaxed, now, processStartedAt });
  assert.equal(st.ceilingBreach(), null, "the relaxed tick cleared the breach row (episode over)");
  assert.equal(st.eventsAfterId(0, ["ceiling-breach-cleared"]).length, 1, "the episode's close has its receipt");
  clock = new Date("2026-07-06T00:23:00Z");
  await tick({ forge, state: st, supervisor: sup, cfg: relaxed, now, processStartedAt });
  assert.equal(
    st.eventsAfterId(0, ["ceiling-breach-cleared"]).length,
    1,
    "cleared is transition-only — steady-state healthy ticks append nothing",
  );
  await tickAt("2026-07-06T00:25:00Z"); // back under the tight cap config -> a fresh episode
  assert.equal(st.eventsAfterId(0, ["ceiling-breach-entered"]).length, 2, "a fresh episode announces again");
  st.close();
});

test("tick ceiling (#431 round 2, codex P2): the kill-9 window between the two breach writes is safe BOTH directions — event-first means no episode is ever silently erased", async () => {
  // Direction 1: killed AFTER the entered event, BEFORE the row commit (the only window the
  // event-first order leaves). Simulate the post-crash DB state directly: announcement present,
  // no ceiling_breach row.
  const dir = mkdtempSync(join(tmpdir(), "sapwood-breach-crash-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    let st = new State(dbPath);
    st.appendEvent("ceiling-breach-entered", { reason: "wall-clock", wallClockElapsedSec: 1200, maxWallClockSec: 600 });
    st.close();

    // 1a: the restart is STILL breached (a daily-budget-style continuation): the row is
    // re-recorded with NO duplicate announcement.
    st = new State(dbPath);
    const forge = new FakeForge();
    const stillStart = new Date("2026-07-06T00:00:00Z");
    await tick({
      forge,
      state: st,
      supervisor: new FakeSupervisor(),
      cfg: mkCfg({ cost: { maxWallClockSec: 600 } }),
      now: () => new Date("2026-07-06T00:20:00Z"),
      processStartedAt: stillStart,
    });
    assert.ok(st.ceilingBreach() !== null, "the row is re-recorded on the next pass");
    assert.equal(st.eventsAfterId(0, ["ceiling-breach-entered"]).length, 1, "no duplicate announcement — the event log already carries it");
    st.close();

    // 1b: the restart has RECOVERED (fresh wall-clock anchor): the open episode is CLOSED with
    // a `cleared` receipt — announced entered + announced cleared, never a silent erasure.
    // (Round 1 keyed dedup on the row's `at`; with the row missing, a recovered restart
    // silently dropped the whole episode — codex's exact reproduction.)
    st = new State(dbPath);
    st.clearCeilingBreach(); // reset the row 1a re-created, isolating 1b to the crash state + recovery
    // Re-simulate the crash state precisely: entered event standing (from the original append), no row.
    const freshStart = new Date("2026-07-06T01:00:00Z");
    await tick({
      forge: new FakeForge(),
      state: st,
      supervisor: new FakeSupervisor(),
      cfg: mkCfg({ cost: { maxWallClockSec: 600 } }),
      now: () => new Date("2026-07-06T01:00:30Z"), // 30s alive — clear
      processStartedAt: freshStart,
    });
    assert.equal(st.ceilingBreach(), null);
    assert.equal(st.eventsAfterId(0, ["ceiling-breach-cleared"]).length, 1, "the prior life's episode is CLOSED in the ledger, not erased");
    st.close();

    // Direction 2 (round 1's hole): a row WITHOUT its event is now unrepresentable by
    // construction — the append precedes recordCeilingBreach on every path — so the remaining
    // assertion is the ledger invariant itself: entered/cleared strictly alternate.
    st = new State(dbPath);
    const kinds = st.eventsAfterId(0, ["ceiling-breach-entered", "ceiling-breach-cleared"]).map((e) => e.kind);
    assert.deepEqual(
      kinds,
      ["ceiling-breach-entered", "ceiling-breach-cleared"],
      "the pair alternates — every episode opens and closes exactly once",
    );
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup1, cfg });
    assert.equal(r1.ceilingBreached, false);
    st.close();

    // Reopen the SAME db path — simulates an engine restart. The ledger must survive.
    st = new State(dbPath);
    const sup2 = new FakeSupervisor();
    seedRunning(st, "lane-b", 2);
    sup2.probes["lane-b"] = { ...DEFAULT_PROBE, done: true, hasPr: true, costUsd: 20 };
    const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup2, cfg });
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

// #450 (design #402 R3, §3c): driveDecision's fifth argument, `progress` — a STALLED verdict
// escalates BEFORE the fixRounds < cap check, and every pre-#450 call (four args, no `progress`
// at all) keeps its EXACT prior behavior via the `"converging"` default.
test("driveDecision (#450): a STALLED progress verdict escalates even with rounds REMAINING under the cap — the progress check precedes the cap check", () => {
  assert.equal(
    driveDecision("FIXABLE", 0, 4, false, { stalled: "recurrence" }),
    "ESCALATE",
    "fixRounds (0) is nowhere near cap (4) — only the stalled verdict explains this ESCALATE",
  );
  assert.equal(driveDecision("FIXABLE", 0, 4, false, { stalled: "flat" }), "ESCALATE");
  assert.equal(driveDecision("FIXABLE", 0, 4, false, { stalled: "marginal-complexity" }), "ESCALATE");
});

test("driveDecision (#450): a converging verdict is unaffected — FIXUP under cap, ESCALATE at cap, identical to the pre-#450 shape", () => {
  assert.equal(driveDecision("FIXABLE", 0, 4, false, "converging"), "FIXUP");
  assert.equal(driveDecision("FIXABLE", 4, 4, false, "converging"), "ESCALATE");
});

test("driveDecision (#450): omitting `progress` entirely defaults to converging — every pre-#450 four-argument call site keeps its exact prior behavior", () => {
  assert.equal(driveDecision("FIXABLE", 0, 3, false), "FIXUP");
  assert.equal(driveDecision("FIXABLE", 3, 3, false), "ESCALATE");
  assert.equal(driveDecision("MERGE", 0, 3, false), "MERGE");
});

// ── #375 AC2: drivingLaneTerminalForDrain — the wind-down predicate that decides whether a
// `driving` lane (no live process, so nothing for the kill-switch drain to hand off/kill) is
// TERMINAL-for-drain: fix-capped (permanent regardless of any ceiling) or budget-blocked
// (already needed at least one fix leg AND the daily-budget hard ceiling is presently
// breached — round budget no longer applies to fix legs at all, #375 item 1). A lane that has
// never needed a fix leg (fixRounds === 0) is never terminal here — it may be perfectly healthy
// (MERGE/WAIT-gated) and simply resumes once the breach/switch clears. ──────────────────────

test("drivingLaneTerminalForDrain (#375): fix-capped is terminal regardless of daily-budget status", () => {
  assert.equal(drivingLaneTerminalForDrain(2, 2, false), true); // at cap, no daily-budget breach
  assert.equal(drivingLaneTerminalForDrain(3, 2, false), true); // past cap (shouldn't happen, fail-safe anyway)
  assert.equal(drivingLaneTerminalForDrain(2, 2, true), true); // at cap AND daily-budget breached
});

test("drivingLaneTerminalForDrain (#375): under cap + daily-budget breached is terminal ONLY once at least one fix round has actually been spent", () => {
  assert.equal(drivingLaneTerminalForDrain(1, 2, true), true); // has needed a fix leg, budget now blocks a fresh one
  assert.equal(drivingLaneTerminalForDrain(0, 2, true), false); // never needed a fix leg — likely MERGE/WAIT, not stuck
});

test("drivingLaneTerminalForDrain (#375): under cap + no daily-budget breach is never terminal — a healthy fix leg is still admissible once DRIVE runs again", () => {
  assert.equal(drivingLaneTerminalForDrain(0, 2, false), false);
  assert.equal(drivingLaneTerminalForDrain(1, 2, false), false);
});

test("drivingLaneTerminalForDrain (#426): the CI-wedged input makes a fix_rounds=0 lane terminal — and only when the caller says the pin is past the bound", () => {
  assert.equal(drivingLaneTerminalForDrain(0, 2, false, true), true); // CI wedged: no fix round ever needed, still stuck
  assert.equal(drivingLaneTerminalForDrain(0, 2, false, false), false); // fresh pin / no pin: an ordinary healthy WAIT
  assert.equal(drivingLaneTerminalForDrain(0, 2, false), false); // omitted (pre-#426 callers) is byte-for-byte the old answer
});

// ── #147: gated-PR reentry — a human removing needs-human from an escalated PR's issue
// reclaims the SAME worker row/PR/branch back into `driving` and re-drives it through the
// ordinary DRIVE loop. No new worker/dispatch, ever. ──────────────────────────────────────────

test("gatedReentryDecision (#400: one input, humanHoldPresent): a human-hold label present -> SKIP (no complete human act yet); cleared + under cap -> RECLAIM; at/over cap -> CAPPED", () => {
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
      review_trigger_generation: 2,
    });
    forge.prStatus = { number: 170, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
    forge.prReviewData = {
      ...forge.prReviewData,
      headOid: "H1",
      labels: [],
      reviews: [],
      comments: [
        {
          login: `${CODEX_REVIEWER_LOGINS[0]}[bot]`,
          createdAt: "2026-07-15T00:01:00Z",
          body: "Codex Review: Didn't find any major issues.",
        },
      ],
    };

    const silent = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
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
    const held = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.equal(st.getWorker("lane-silent")?.state, "failed");
    assert.deepEqual(held.driven, [
      // #397: a `needs-human` PR no longer satisfies the instruction-path latch (that latch is
      // keyed on `human-merge-only` now), so the escalation reason is the ordinary human-label
      // veto it always actually was — a bucket-1 escalation, honestly attributed.
      { kind: "needs-human", worker: "lane-silent", issue: 170, pr: 170, reason: "gate:HUMAN:MERGE_OK" },
    ]);
    assert.equal(rawEventKinds(path).filter((k) => k === "review-silence-escalated").length, 1);

    // #398: ONE removal, on the PR. Before this issue the human had to strip the label from the
    // issue AND the PR (#170 labelled the PR, the next tick's gate:HUMAN labelled the issue) —
    // the double-removal burden this carrier split exists to end. Both escalations now land on
    // the PR, so clearing the PR is the whole human act; the issue was never labelled at all.
    assert.deepEqual(forge.labelsAdded, []);
    forge.prLabelsByPr[170] = [];
    forge.prReviewData = { ...forge.prReviewData, labels: [], reviews: [] };
    const reentered = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(reentered.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-silent", issue: 170, pr: 170, attempt: 1 }]);
    assert.deepEqual(reentered.driven, [{ kind: "queued", worker: "lane-silent", issue: 170, pr: 170, reason: "review-triggered" }]);

    forge.prReviewData = {
      ...forge.prReviewData,
      reviews: [{ author: CODEX_REVIEWER_LOGINS[0], commitOid: "H1", state: "COMMENTED", submittedAt: "2026-07-15T00:03:00Z" }],
    };
    const merged = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(merged.driven, [{ kind: "merged", worker: "lane-silent", issue: 170, pr: 170 }]);
    assert.deepEqual(forge.merged, [[170, "H1"]]);
    assert.equal(sup.dispatched.length, 0);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// #426 (F26): the CI-PENDING aging pin — a check that hangs `IN_PROGRESS` forever used to wedge
// its lane permanently (deriveGate WAIT every tick; reviewSilenceDuration only ages a non-decisive
// REVIEW; neither drain arm could see it). The pin lives entirely in the durable event log.
// ─────────────────────────────────────────────────────────────────────────────────────────

/** The wedge fixture: gate② decisive (a Codex CLEAN verdict is a plain PR comment, not a review),
 *  gate① reporting neither green nor red because one check never leaves IN_PROGRESS. */
function seedCiWedgedPr(forge: FakeForge, pr: number, head = "H1") {
  forge.prStatus = { number: pr, headOid: head, state: "OPEN", mergeable: "MERGEABLE", ciGreen: false, ciRed: false };
  forge.prReviewData = {
    ...forge.prReviewData,
    headOid: head,
    labels: [],
    reviews: [{ author: CODEX_REVIEWER_LOGINS[0], commitOid: head, state: "COMMENTED", submittedAt: "2026-07-19T23:30:00Z" }],
  };
  forge.prChecks = [
    { name: "test", status: "IN_PROGRESS", conclusion: null, state: null },
    { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", state: null },
  ];
}

test("#426 AC1: a permanently IN_PROGRESS check opens the pin ONCE, ages across ticks (and across a RESTART, AC3), then escalates with an evidence comment naming the pending check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ci-pending-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    let st = new State(path);
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    const cfg = mkCfg({ ci: { pendingEscalateAfterSec: 3600 } });
    let clock = new Date("2026-07-20T00:00:00.000Z");
    const now = () => clock;
    const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now });
    seedDriving(st, "lane-ci", 426, 4260, { review_triggered_head: "H1", review_triggered_at: "2026-07-19T23:00:00.000Z" });
    seedCiWedgedPr(forge, 4260);
    const tickOpts = () => ({ forge, state: st, supervisor: sup, cfg, mergeGate: gate, now });

    // Tick 1 — the pin opens, stamped with the tick's own (injected) clock. No escalation: the
    // engine has to have OBSERVED the wedge for a full bound before it may call a human.
    const t1 = await tick(tickOpts());
    assert.deepEqual(t1.driven, [{ kind: "queued", worker: "lane-ci", issue: 426, pr: 4260, reason: "gate-pending:MERGE_OK" }]);
    assert.deepEqual(forge.prLabelsAdded, []);
    assert.deepEqual(st.lastCiPendingEvent("lane-ci", 4260), {
      id: st.lastCiPendingEvent("lane-ci", 4260)!.id,
      kind: "ci-pending-observed",
      head: "H1",
      at: "2026-07-20T00:00:00.000Z",
    });

    // Tick 2, still within the bound — steady state appends NOTHING (the pin is the memory), and
    // the clock is measured from the ORIGINAL observation, not re-stamped.
    clock = new Date("2026-07-20T00:30:00.000Z");
    await tick(tickOpts());
    assert.equal(rawEventKinds(path).filter((k) => k === "ci-pending-observed").length, 1);
    assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.at, "2026-07-20T00:00:00.000Z");

    // AC3 — RESTART mid-wait. A fresh State over the same file re-reads the same pin: the clock
    // does not reset, so the very next tick past the bound escalates on the FULL elapsed age.
    st.close();
    st = new State(path);
    clock = new Date("2026-07-20T01:00:00.000Z"); // exactly 3600s pending
    const t3 = await tick(tickOpts());
    assert.equal(st.getWorker("lane-ci")?.state, "driving"); // visibility only — the lane keeps polling
    assert.deepEqual(t3.driven, [{ kind: "queued", worker: "lane-ci", issue: 426, pr: 4260, reason: "gate-pending:MERGE_OK" }]);
    assert.deepEqual(forge.prLabelsAdded, [[4260, "needs-human"]]);
    // The evidence comment names the check that is actually stuck — and not the one that passed.
    const comment = forge.prComments.find(([pr]) => pr === 4260)?.[1] ?? "";
    assert.match(comment, /still pending: test/);
    assert.doesNotMatch(comment, /lint/);
    assert.match(comment, /3600s/);
    const raw = new DatabaseSync(path);
    const ev = raw.prepare("SELECT payload FROM events WHERE kind = ?").get("ci-pending-escalated") as { payload: string } | undefined;
    raw.close();
    assert.deepEqual(JSON.parse(ev!.payload), { worker: "lane-ci", issue: 426, pr: 4260, head: "H1", pendingSec: 3600, checks: ["test"] });

    // And the label latches it: the next tick routes through the ordinary HUMAN path, with no
    // second escalation comment/event (the same one-per-episode contract #170 has).
    clock = new Date("2026-07-20T02:00:00.000Z");
    const t4 = await tick(tickOpts());
    assert.equal(rawEventKinds(path).filter((k) => k === "ci-pending-escalated").length, 1);
    assert.equal(forge.prComments.filter(([pr]) => pr === 4260).length, 1);
    // #398 carrier handshake: the latch surface `ciPendingDuration` reads (the PR's labels) is the
    // same object this escalation wrote, so the next gate pass sees it and escalates for real —
    // and THAT pass is the one that moves the row and records where the label went.
    assert.deepEqual(t4.driven, [{ kind: "needs-human", worker: "lane-ci", issue: 426, pr: 4260, reason: "gate:HUMAN:MERGE_OK" }]);
    assert.equal(st.getWorker("lane-ci")?.state, "failed");
    assert.equal(st.getWorker("lane-ci")?.gated_escalation_carrier, "pr");
    assert.deepEqual(forge.labelsAdded, [], "never a second carrier: the issue is untouched throughout");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#426 AC3: a check reaching a real conclusion CANCELS the pin — the next pending episode ages from its own start, never inheriting the cancelled one's clock", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ ci: { pendingEscalateAfterSec: 3600 } });
  let clock = new Date("2026-07-20T00:00:00.000Z");
  const now = () => clock;
  const gate = new FakeMergeGate();
  seedDriving(st, "lane-ci", 426, 4260);
  const pending: DriveOutcome = {
    kind: "queued",
    pr: 4260,
    reason: "gate-pending:MERGE_OK",
    ciPendingObservation: { pending: true, head: "H1" },
  };
  const concluded: DriveOutcome = {
    kind: "queued",
    pr: 4260,
    reason: "gate-pending:WAIT_REVIEW",
    ciPendingObservation: { pending: false, head: "H1" },
  };
  const tickOpts = () => ({ forge, state: st, supervisor: sup, cfg, mergeGate: gate, now });

  gate.outcomes[4260] = pending;
  await tick(tickOpts());
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.at, "2026-07-20T00:00:00.000Z");

  // The check completes 59 minutes in — one minute short of the bound.
  clock = new Date("2026-07-20T00:59:00.000Z");
  gate.outcomes[4260] = concluded;
  await tick(tickOpts());
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.kind, "ci-pending-cleared");

  // A re-run goes pending again: a NEW pin, so the accumulated 59 minutes are gone. Two hours of
  // total wall-clock have passed, but only one minute of THIS episode — not wedged, not terminal.
  clock = new Date("2026-07-20T01:00:00.000Z");
  gate.outcomes[4260] = pending;
  await tick(tickOpts());
  const repinned = st.lastCiPendingEvent("lane-ci", 4260);
  assert.equal(repinned?.kind, "ci-pending-observed");
  assert.equal(repinned?.at, "2026-07-20T01:00:00.000Z");
  clock = new Date("2026-07-20T01:01:00.000Z");
  await tick(tickOpts());
  assert.equal(st.getWorker("lane-ci")?.state, "driving");
  st.close();
});

test("#426 review round 2 (P1): a push cancels the OLD head's pin through the REAL review-trigger branch — an aged pre-push pin never terminalizes the freshly-pushed lane in a drain", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ cost: { drainWindowSec: 60, dailyBudgetUsd: 10 }, ci: { pendingEscalateAfterSec: 3600 } });
  let clock = new Date("2026-07-20T00:00:00.000Z");
  const now = () => clock;
  // A REAL MergeDriver: the head-move path under test is driveOne's own early return (it posts a
  // fresh review trigger and queues WITHOUT deriving a gate), which a FakeMergeGate cannot exercise
  // — injecting the new head's observation directly would bypass the very branch this pins.
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now });
  seedDriving(st, "lane-ci", 426, 4260, { review_triggered_head: "H1", review_triggered_at: "2026-07-19T23:00:00.000Z" });
  seedCiWedgedPr(forge, 4260, "H1");
  st.recordSpend("lane-earlier", 99, 500, "2026-07-20T00:00:01.000Z"); // daily cap breached from tick 1
  const tickOpts = () => ({ forge, state: st, supervisor: sup, cfg, mergeGate: gate, now });

  const t1 = await tick(tickOpts());
  assert.equal(t1.ceilingBreached, true);
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.kind, "ci-pending-observed");
  assert.deepEqual(t1.escalated, []); // pin fresh, and the drain window has not elapsed either

  // Two hours later — the OLD pin is well past the 1h bound AND past the drain window — a fix leg
  // (or a human) pushes. The engine's FIRST sight of H2 is the trigger branch's early return.
  clock = new Date("2026-07-20T02:00:00.000Z");
  seedCiWedgedPr(forge, 4260, "H2");
  const t2 = await tick(tickOpts());
  assert.deepEqual(t2.driven, [{ kind: "queued", worker: "lane-ci", issue: 426, pr: 4260, reason: "review-triggered" }]);
  // The drain is past its window on this very tick — and it leaves the healthy lane alone, because
  // the head move ENDED the episode: the old pin is cancelled on the very pass that first saw H2.
  assert.deepEqual(t2.escalated, []);
  assert.equal(st.getWorker("lane-ci")?.state, "driving");
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.kind, "ci-pending-cleared");

  // And the new head starts its own clock from scratch once the gate actually derives for it.
  clock = new Date("2026-07-20T02:01:00.000Z");
  await tick(tickOpts());
  const repinned = st.lastCiPendingEvent("lane-ci", 4260);
  assert.deepEqual([repinned?.kind, repinned?.head, repinned?.at], ["ci-pending-observed", "H2", "2026-07-20T02:01:00.000Z"]);
  st.close();
});

test("#426 review round 3 (P2): a PRE-TRIGGER early return (instruction-path read failure) is the first pass to see a new head — it cancels the old head's pin, so the drain leaves the healthy lane alone", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({
    cost: { drainWindowSec: 60, dailyBudgetUsd: 10 },
    ci: { pendingEscalateAfterSec: 3600 },
    escalation: { humanLabels: ["needs-human", "blocked"], instructionPaths: ["CLAUDE.md"] },
  });
  let clock = new Date("2026-07-20T00:00:00.000Z");
  const now = () => clock;
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now });
  seedDriving(st, "lane-ci", 426, 4260, { review_triggered_head: "H1", review_triggered_at: "2026-07-19T23:00:00.000Z" });
  seedCiWedgedPr(forge, 4260, "H1");
  st.recordSpend("lane-earlier", 99, 500, "2026-07-20T00:00:01.000Z"); // daily cap breached from tick 1
  const tickOpts = () => ({ forge, state: st, supervisor: sup, cfg, mergeGate: gate, now });

  await tick(tickOpts()); // pin opens on H1
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.kind, "ci-pending-observed");

  // A push lands, and on the very first pass that sees H2 the instruction-path changed-file read
  // fails — driveOne returns from a branch that sits BEFORE the review trigger and never derives a
  // gate. It still knows which head it is looking at, which is all the conductor needs.
  clock = new Date("2026-07-20T02:00:00.000Z"); // old pin now past both the bound and the drain window
  seedCiWedgedPr(forge, 4260, "H2");
  forge.throwOnGetPRChangedFiles = true;
  const t2 = await tick(tickOpts());
  assert.match((t2.driven[0] as { reason: string }).reason, /instruction-path-files-unavailable/);
  assert.deepEqual(t2.escalated, []); // the drain is past its window — and finds nothing wedged
  assert.equal(st.getWorker("lane-ci")?.state, "driving");
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.kind, "ci-pending-cleared");
  st.close();
});

test('#426 review round 3 (P2): `pending: "unknown"` on the SAME head is a pure no-op — a pass that never derived a gate can neither open an episode nor cancel a live one', async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ ci: { pendingEscalateAfterSec: 3600 } });
  let clock = new Date("2026-07-20T00:00:00.000Z");
  const now = () => clock;
  const gate = new FakeMergeGate();
  seedDriving(st, "lane-ci", 426, 4260);
  const tickOpts = () => ({ forge, state: st, supervisor: sup, cfg, mergeGate: gate, now });

  // No pin yet: an "unknown" pass must not manufacture one out of thin air.
  gate.outcomes[4260] = {
    kind: "queued",
    pr: 4260,
    reason: "instruction-path-files-unavailable: x",
    ciPendingObservation: { pending: "unknown", head: "H1" },
  };
  await tick(tickOpts());
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260), null);

  // Pin opened by a real gate-deriving pass…
  clock = new Date("2026-07-20T00:10:00.000Z");
  gate.outcomes[4260] = { kind: "queued", pr: 4260, reason: "gate-pending:MERGE_OK", ciPendingObservation: { pending: true, head: "H1" } };
  await tick(tickOpts());
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.at, "2026-07-20T00:10:00.000Z");

  // …and a transient same-head failure pass must NOT cancel it (that would silently reset the
  // clock every time a forge hiccup landed) nor re-stamp it.
  clock = new Date("2026-07-20T00:20:00.000Z");
  gate.outcomes[4260] = {
    kind: "queued",
    pr: 4260,
    reason: "instruction-path-files-unavailable: x",
    ciPendingObservation: { pending: "unknown", head: "H1" },
  };
  await tick(tickOpts());
  const pin = st.lastCiPendingEvent("lane-ci", 4260);
  assert.deepEqual([pin?.kind, pin?.at], ["ci-pending-observed", "2026-07-20T00:10:00.000Z"]);
  st.close();
});

test("#426 review round 3 (P2): the CONFLICT branch — also pre-trigger — cancels the old head's pin on the first pass that sees the new head", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // prFixCap 0: a conflicting PR routes straight to HUMAN, so this test exercises the conflict
  // branch's own `observed()` return without dragging a fix-leg dispatch into it.
  const cfg = mkCfg({ ci: { pendingEscalateAfterSec: 3600 }, lanes: { prFixCap: 0 } });
  let clock = new Date("2026-07-20T00:00:00.000Z");
  const now = () => clock;
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now });
  seedDriving(st, "lane-ci", 426, 4260, { review_triggered_head: "H1", review_triggered_at: "2026-07-19T23:00:00.000Z" });
  seedCiWedgedPr(forge, 4260, "H1");
  const tickOpts = () => ({ forge, state: st, supervisor: sup, cfg, mergeGate: gate, now });

  await tick(tickOpts());
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.kind, "ci-pending-observed");

  clock = new Date("2026-07-20T02:00:00.000Z");
  seedCiWedgedPr(forge, 4260, "H2");
  forge.prStatus = { ...forge.prStatus, mergeable: "CONFLICTING" };
  await tick(tickOpts());
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.kind, "ci-pending-cleared");
  st.close();
});

test("#426 review round 2 (P1-1, adjudicated): a check that CONCLUDES WITHOUT PASSING (CANCELLED) keeps the pin aging — gate① is still not green, so the lane is just as wedged — and the evidence comment names it", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ ci: { pendingEscalateAfterSec: 3600 } });
  let clock = new Date("2026-07-20T00:00:00.000Z");
  const now = () => clock;
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now });
  seedDriving(st, "lane-ci", 426, 4260, { review_triggered_head: "H1", review_triggered_at: "2026-07-19T23:00:00.000Z" });
  seedCiWedgedPr(forge, 4260);
  const tickOpts = () => ({ forge, state: st, supervisor: sup, cfg, mergeGate: gate, now });

  await tick(tickOpts()); // pin opens while `test` is IN_PROGRESS
  assert.equal(st.lastCiPendingEvent("lane-ci", 4260)?.at, "2026-07-20T00:00:00.000Z");

  // The job is CANCELLED half an hour in. parsePRStatus keeps ciGreen false (SUCCESS-only, #401)
  // and ciRed false (CANCELLED is not a failure), so the lane cannot progress on its own — the pin
  // must NOT be cancelled here, or the F26 wedge returns for exactly this shape.
  clock = new Date("2026-07-20T00:30:00.000Z");
  forge.prChecks = [
    { name: "test", status: "COMPLETED", conclusion: "CANCELLED", state: null },
    { name: "lint", status: "COMPLETED", conclusion: "SUCCESS", state: null },
  ];
  await tick(tickOpts());
  const pin = st.lastCiPendingEvent("lane-ci", 4260);
  assert.equal(pin?.kind, "ci-pending-observed", "the pin is still open — a non-passing conclusion is not a resolution");
  assert.equal(pin?.at, "2026-07-20T00:00:00.000Z", "and it still ages from the ORIGINAL observation");

  // Past the bound, measured from the original pin: escalation, naming the CANCELLED check.
  clock = new Date("2026-07-20T01:00:00.000Z");
  await tick(tickOpts());
  assert.deepEqual(forge.prLabelsAdded, [[4260, "needs-human"]]);
  const comment = forge.prComments.find(([pr]) => pr === 4260)?.[1] ?? "";
  assert.match(comment, /concluded without passing: test \(CANCELLED\)/);
  assert.doesNotMatch(comment, /still pending/); // nothing IS pending — the honest evidence says so
  assert.doesNotMatch(comment, /lint/); // the check that actually passed is not the human's problem
  const ev = st.latestEvent("ci-pending-escalated") as { payload: { checks: string[]; blockedChecks?: string[] } } | undefined;
  assert.deepEqual(ev?.payload.checks, []);
  assert.deepEqual(ev?.payload.blockedChecks, ["test (CANCELLED)"]);
  st.close();
});

// ─────────────────────────────────────────────────────────────────────────────────────────
// #248: the human hold label — WAIT-tier control handover, three-tier escalation model
// ─────────────────────────────────────────────────────────────────────────────────────────

/** #248 review round 1 (G4): a runtime, per-scenario belt to the grep-invariant static scan
 * below — records EVERY addLabel/addPRLabel invocation this FakeForge saw (whatever WAS
 * legitimately written, e.g. needs-human on an escalation) and asserts none of it is a
 * configured hold label, case-insensitively. Call after every hold-scenario tick, not just the
 * ones expecting zero writes at all — the escalation-wins test below DOES write needs-human,
 * and that write must still never be the hold label itself. */
function assertNeverWritesHoldLabel(forge: FakeForge, holdLabels: readonly string[]) {
  const normalizedHolds = holdLabels.map((h) => h.toLowerCase());
  for (const [, label] of [...forge.labelsAdded, ...forge.prLabelsAdded]) {
    assert.ok(!normalizedHolds.includes(label.toLowerCase()), `engine wrote a configured hold label: "${label}"`);
  }
}

test("tick DRIVE (#248): a hold label on the PR suppresses drive to WAIT — no merge, no escalation, no dispatch; removing it resumes the ordinary gate path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-hold-round-trip-"));
  try {
    const path = join(dir, "sapwood.sqlite");
    const st = new State(path);
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    const cfg = mkCfg({ escalation: { humanLabels: ["needs-human", "blocked"], holdLabels: ["hold"] } });
    const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg, now: () => new Date("2026-07-19T00:00:00.000Z") });

    st.upsertWorker({
      name: "lane-h",
      issue: 50,
      session_id: "s-lane-h",
      state: "driving",
      started_at: "t0",
      ended_at: null,
      pr: 600,
      review_triggered_head: "H1",
      review_triggered_at: "2026-07-18T00:00:00.000Z",
    });
    forge.prStatus = { number: 600, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
    forge.prReviewData = {
      headOid: "H1",
      author: "producer",
      updatedAt: "2026-01-01T00:00:00Z",
      isDraft: false,
      labels: ["hold"],
      state: "OPEN",
      reactions: [],
      // Would resolve MERGE_OK (and merge, CI green) if not for the hold — proves hold, not an
      // incidental non-decisive verdict, is what's holding the lane.
      reviews: [{ author: CODEX_REVIEWER_LOGINS[0], commitOid: "H1", state: "COMMENTED", submittedAt: "2026-07-19T00:00:30Z" }],
      unresolvedThreads: 0,
    };

    const held1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(held1.driven, [{ kind: "queued", worker: "lane-h", issue: 50, pr: 600, reason: "gate-pending:MERGE_OK" }]);
    assert.equal(st.getWorker("lane-h")?.state, "driving"); // held, not escalated — lane keeps its slot
    assert.equal(st.getWorker("lane-h")?.gated_reentry_attempts ?? 0, 0);

    // A second tick while still held: same outcome, still zero writes of any kind.
    const held2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(held2.driven, [{ kind: "queued", worker: "lane-h", issue: 50, pr: 600, reason: "gate-pending:MERGE_OK" }]);

    // Zero-consumption AC: no gated-reentry attempt burned, no needs-human label/comment
    // anywhere (issue OR PR), no merge, no dispatch — across the whole held window.
    assert.equal(st.getWorker("lane-h")?.gated_reentry_attempts ?? 0, 0);
    assert.deepEqual(forge.labelsAdded, []);
    assert.deepEqual(forge.prLabelsAdded, []); // the engine never writes OR escalates a hold label
    assert.deepEqual(forge.issueComments, []);
    assert.deepEqual(forge.merged, []);
    assert.equal(sup.dispatched.length, 0);
    assert.deepEqual(
      rawEventKinds(path).filter((k) => k === "review-silence-escalated" || k === "gated-reentry" || k === "gated-reentry-capped"),
      [],
    );
    assertNeverWritesHoldLabel(forge, cfg.escalation.holdLabels);

    // The human removes the hold label — the very NEXT tick resumes the ordinary gate path
    // (same lane, same PR, no re-dispatch) and merges.
    forge.prReviewData = { ...forge.prReviewData, labels: [] };
    const resumed = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(resumed.driven, [{ kind: "merged", worker: "lane-h", issue: 50, pr: 600 }]);
    assert.equal(st.getWorker("lane-h")?.state, "done");
    assert.deepEqual(forge.merged, [[600, "H1"]]);
    assert.equal(sup.dispatched.length, 0); // no worker ever spawned across the whole round-trip
    assertNeverWritesHoldLabel(forge, cfg.escalation.holdLabels);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick DRIVE (#248): hold + needs-human simultaneously on the SAME PR -> escalation wins (fail-safe) — the lane fails and needs-human is applied, not silently held", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ escalation: { humanLabels: ["needs-human", "blocked"], holdLabels: ["hold"] } });
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg });

  st.upsertWorker({
    name: "lane-both",
    issue: 51,
    session_id: "s-lane-both",
    state: "driving",
    started_at: "t0",
    ended_at: null,
    pr: 601,
    review_triggered_head: "H1",
    review_triggered_at: "2020-01-01T00:00:00Z",
  });
  forge.prStatus = { number: 601, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  forge.prReviewData = { ...forge.prReviewData, headOid: "H1", labels: ["hold", "needs-human"] };

  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r.driven, [
    // #397: reason is deriveGate's own human-label veto now, not the instruction-path latch.
    { kind: "needs-human", worker: "lane-both", issue: 51, pr: 601, reason: "gate:HUMAN:WAIT_REVIEW" },
  ]);
  assert.equal(st.getWorker("lane-both")?.state, "failed");
  // #248 review round 1 (G4): the escalation DOES write needs-human (asserted above via the
  // outcome kind) — this proves that legitimate write is never, itself, the hold label.
  // #398: on the PR, the carrier this PR-born escalation was born on.
  assert.deepEqual(forge.prLabelsAdded, [[601, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, []);
  assertNeverWritesHoldLabel(forge, cfg.escalation.holdLabels);
  st.close();
});

test("tick GATED RECLAIM (#400): hold has ONE carrier, the PR — an ISSUE-level hold no longer gates reentry; removing needs-human reclaims regardless of what else sits on the issue", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ escalation: { humanLabels: ["needs-human", "blocked"], holdLabels: ["hold"] } });
  const gate = new FakeMergeGate();
  gate.outcomes[700] = { kind: "queued", pr: 700, reason: "gate-pending:WAIT_REVIEW" };

  // Shape of a lane that exhausted its fix-round cap (#147/#246's cap-escalation path):
  // `failed`, a PR, and `gated_escalation_labeled: 1` (the needs-human write already succeeded).
  st.upsertWorker({
    name: "lane-capped",
    issue: 60,
    session_id: "s-lane-capped",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 700,
    gated_escalation_labeled: 1,
    gated_reentry_attempts: 0,
  });

  // A standing needs-human still SKIPs — the human-hold set is the only reentry gate left.
  forge.issueLabelsByIssue[60] = ["needs-human", "hold"];
  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, []);
  assert.equal(st.getWorker("lane-capped")?.gated_reentry_attempts, 0);

  // needs-human removed while an issue-level `hold` still sits there: the go-ahead signal IS the
  // needs-human removal, and hold means nothing on this surface — reclaim proceeds. (#400: the
  // GATED RECLAIM label read no longer feeds a hold check at all.)
  forge.issueLabelsByIssue[60] = ["hold"];
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r2.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-capped", issue: 60, pr: 700, attempt: 1 }]);
  assert.equal(st.getWorker("lane-capped")?.state, "driving");
  assertNeverWritesHoldLabel(forge, cfg.escalation.holdLabels); // still never written by the engine
  st.close();
});

// ── #398: the escalation carrier — "the label lives where the escalation was born" ───────────
//
// The behavioural half of AC2 (the structural half — every write site's declared carrier and the
// four named #69 P1 dual-write exceptions — is escalation-buckets.test.ts's SITE_INVENTORY).
// These fixtures assert the carrier CHOSEN AT RUNTIME from the lane's own `pr`, and the matching
// handshake read on the other side.

test("#398 AC1/AC2: escalationCarrier is a pure function of the lane's pr — the whole rule, in one place", () => {
  assert.equal(escalationCarrier(55), "pr");
  assert.equal(escalationCarrier(null), "issue");
  assert.equal(escalationCarrier(undefined), "issue");
});

test("#398 AC1: a PR-LESS lane's escalation labels the issue — drive-no-pr, the issue-born arm of the same rule", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const gate = new FakeMergeGate();
  // A `driving` row with NO pr is DRIVE's own fail-safe: there is no other object that could
  // carry the fact, so the issue is where it goes. `drive-no-pr` is issue-born by definition.
  st.upsertWorker({
    name: "lane-nopr",
    issue: 77,
    session_id: "s-lane-nopr",
    state: "driving",
    started_at: "t0",
    ended_at: null,
    pr: null,
  });
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(forge.labelsAdded, [[77, "needs-human"]]);
  assert.deepEqual(forge.prLabelsAdded, []);
  st.close();
});

test("#398 AC3: removing the label from the carrier the engine USED re-admits the lane — and the other object needs no action at all", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  const gate = new FakeMergeGate();
  seedDriving(st, "lane-carrier", 88, 880);
  gate.outcomes[880] = { kind: "needs-human", pr: 880, reason: "gate:HUMAN:HANDLE_THREADS" };

  // Tick 1: escalate. PR labelled, issue untouched.
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(forge.prLabelsAdded, [[880, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.issueLabelsByIssue[88] ?? [], [], "the issue was never labelled, so there is nothing there to remove");
  assert.equal(st.getWorker("lane-carrier")?.gated_escalation_carrier, "pr");

  // Tick 2: the label still stands on the PR -> SKIP. Note the ISSUE is already clean here, so a
  // handshake that read the issue would reclaim RIGHT NOW, with the human hold still in place.
  gate.outcomes[880] = { kind: "queued", pr: 880, reason: "gate-pending:WAIT_REVIEW" };
  const held = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(held.gatedReclaimed, []);
  assert.equal(st.getWorker("lane-carrier")?.state, "failed");

  // Tick 3: ONE removal, on the PR — the whole human act. The issue is untouched throughout.
  forge.prLabelsByPr[880] = [];
  const reclaimed = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(reclaimed.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-carrier", issue: 88, pr: 880, attempt: 1 }]);
  assert.equal(st.getWorker("lane-carrier")?.state, "driving");
  assert.deepEqual(forge.labelsRemoved, [], "the engine never had to clear anything on the issue either");
  st.close();
});

test("#398 crash consistency: a kill between the PR label write and the terminal upsert re-escalates idempotently — the carrier and the proof marker land together or not at all", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  const gate = new FakeMergeGate();
  seedDriving(st, "lane-crash", 89, 890);
  gate.outcomes[890] = { kind: "needs-human", pr: 890, reason: "gate:HUMAN:HANDLE_THREADS" };

  // The crash window: `escalateNeedsHuman` writes the label FIRST, then the terminal row. A kill
  // strictly between them leaves the PR labelled with the row still `driving` — nothing durable
  // claims an escalation happened, so nothing can be falsely trusted. Reproduced by landing the
  // label the way the interrupted attempt would have, with the row untouched.
  await forge.addPRLabel(890, "needs-human");
  assert.equal(st.getWorker("lane-crash")?.state, "driving");
  assert.equal(st.getWorker("lane-crash")?.gated_escalation_labeled ?? 0, 0, "no proof marker from a half-finished attempt");

  // The rerun re-derives the same verdict and re-attempts the whole escalation. GitHub's addLabel
  // is idempotent, so the recovery costs one no-op write and leaves exactly one label.
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.equal(r.driven[0]!.kind, "needs-human");
  const row = st.getWorker("lane-crash")!;
  assert.equal(row.state, "failed");
  assert.equal(row.gated_escalation_labeled, 1);
  assert.equal(row.gated_escalation_carrier, "pr", "the carrier and the marker are written by the SAME upsert — they cannot disagree");
  assert.deepEqual(forge.prLabelsByPr[890], ["needs-human"], "idempotent: one label, not two");
  assert.deepEqual(forge.labelsAdded, [], "and the rerun never spills onto the other carrier");
  st.close();
});

test("#398 AC5 (cutover): a lane escalated BEFORE the split keeps the ISSUE handshake — clearing its PR proves nothing, clearing its issue re-admits it", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  const gate = new FakeMergeGate();
  gate.outcomes[900] = { kind: "queued", pr: 900, reason: "gate-pending:WAIT_REVIEW" };
  // Exactly what a pre-#398 escalation left behind: no carrier recorded, so the column's default
  // ("issue") describes it — which is the truth, since the old code could only write the issue.
  st.upsertWorker({
    name: "lane-legacy",
    issue: 90,
    session_id: "s-lane-legacy",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 900,
    gated_escalation_labeled: 1,
  });
  forge.issueLabelsByIssue[90] = ["needs-human"];
  forge.prLabelsByPr[900] = []; // the PR never carried it — reading the PR here would be a false release

  const skipped = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(skipped.gatedReclaimed, [], "an unconditional PR read would have re-admitted this lane with no human act");

  forge.issueLabelsByIssue[90] = [];
  const reclaimed = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(reclaimed.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-legacy", issue: 90, pr: 900, attempt: 1 }]);
  st.close();
});

test("#398 AC6: GATED RECLAIM reads a PR-carried lane's labels via getPRLabels — never the heavy getPRReviewData gate query — and a PR-level HOLD SKIPs reclaim (restoring, on the correct carrier, what #400 removed)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ escalation: { humanLabels: ["needs-human", "blocked"], holdLabels: ["hold"] } });
  const gate = new FakeMergeGate();
  gate.outcomes[910] = { kind: "queued", pr: 910, reason: "gate-pending:WAIT_REVIEW" };
  st.upsertWorker({
    name: "lane-pr-hold",
    issue: 91,
    session_id: "s-lane-pr-hold",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 910,
    gated_escalation_labeled: 1,
    gated_escalation_carrier: "pr",
  });

  // A human is investigating (`hold` on the PR) and has already cleared needs-human. #400 named
  // this exact case as its accepted-but-real cost: the lane would burn a reentry attempt on a
  // go-ahead nobody actually gave. The same fetch that answers "is the hold gone?" sees the hold.
  forge.prLabelsByPr[910] = ["hold"];
  const before = forge.getPRReviewDataCalls;
  const skipped = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(skipped.gatedReclaimed, []);
  assert.equal(st.getWorker("lane-pr-hold")?.gated_reentry_attempts ?? 0, 0, "a PR-level hold costs ZERO reentry attempts");
  assert.equal(
    forge.getPRReviewDataCalls,
    before,
    "the carrier read is getPRLabels — the heavy gate query is not made on the reclaim path at all",
  );

  // The investigation ends: hold lifted, nothing else on the PR -> reclaim.
  forge.prLabelsByPr[910] = [];
  const reclaimed = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(reclaimed.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-pr-hold", issue: 91, pr: 910, attempt: 1 }]);
  assertNeverWritesHoldLabel(forge, cfg.escalation.holdLabels);
  st.close();
});

test("#398 AC6: an ISSUE-carried lane's hold set is UNCHANGED — #400's ruling that an issue-level hold is the wrong carrier for a PR's gate still stands", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ escalation: { humanLabels: ["needs-human", "blocked"], holdLabels: ["hold"] } });
  const gate = new FakeMergeGate();
  gate.outcomes[920] = { kind: "queued", pr: 920, reason: "gate-pending:WAIT_REVIEW" };
  st.upsertWorker({
    name: "lane-issue-hold",
    issue: 92,
    session_id: "s-lane-issue-hold",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 920,
    gated_escalation_labeled: 1,
    gated_escalation_carrier: "issue",
  });
  forge.issueLabelsByIssue[92] = ["hold"]; // needs-human gone; an issue-level hold remains
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-issue-hold", issue: 92, pr: 920, attempt: 1 }]);
  st.close();
});

test("#398 AC4: a PR-escalated lane's issue is kept out of the dispatch pool by board Status + the in-progress label, NOT by an issue-side escalation label", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  const gate = new FakeMergeGate();
  seedDriving(st, "lane-fenced", 93, 930);
  gate.outcomes[930] = { kind: "needs-human", pr: 930, reason: "gate:HUMAN:HANDLE_THREADS" };
  // claimIssue (at dispatch) already moved this issue to In Progress and applied the in-progress
  // label; the escalation does not touch either. `orderForDispatch`/`isPoolEligible` stay pure
  // functions over the BOARD's own item labels — deliberately never a per-issue PR read (the
  // per-tick forge-read inflation the #248 PM ruling rejected).
  forge.issueLabelsByIssue[93] = ["in-progress"];
  forge.ready = []; // an In-Progress issue is not in getReadyIssues() — the fence, structurally

  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.equal(r.driven[0]!.kind, "needs-human");
  assert.deepEqual(forge.prLabelsAdded, [[930, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, [], "no issue-side escalation label — and none is needed to keep it off the queue");
  assert.deepEqual(r.dispatched, []);
  assert.deepEqual(forge.boardSet, [], "the escalation never moves the board either — In Progress is where claimIssue left it");
  // The predicate itself is UNCHANGED by this issue and still a pure function over the board
  // item's own labels — it has no lane/PR association and takes none. Proof: the very same issue
  // scores identically whether or not its PR carries `needs-human`, because `orderForDispatch`
  // cannot see a PR at all. (Making it consult PR labels would mean a per-issue forge read per
  // tick — the read inflation the #248 PM ruling rejected — and is unnecessary: the escalated
  // issue is fenced OFF THE BOARD at `Status: In Progress`, which is why `forge.ready` is empty
  // above even though nothing issue-side was labelled.)
  const boardItem = { number: 93, title: "t", labels: [] as string[] };
  assert.deepEqual(orderForDispatch([boardItem], cfg), [boardItem], "no PR knowledge — a clean board item is dispatchable either way");
  assert.deepEqual(orderForDispatch([{ ...boardItem, labels: ["needs-human"] }], cfg), [], "and the label read itself is untouched");
  st.close();
});

test("tick DRIVE (#248): a `fixing` lane is invisible to the hold check entirely — an in-flight fix leg is never interrupted, because DRIVE only ever iterates `driving` lanes", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ escalation: { humanLabels: ["needs-human", "blocked"], holdLabels: ["hold"] } });
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg });

  st.upsertWorker({
    name: "lane-fixing",
    issue: 52,
    session_id: "s-lane-fixing",
    state: "fixing",
    started_at: "t0",
    ended_at: null,
    pr: 602,
    fix_rounds: 1,
  });
  // A hold on the PR the fix leg is working — irrelevant while the row is `fixing`: this is not
  // a "driving" lane, so tick()'s DRIVE loop (deps.mergeGate.driveOne) never reads it at all.
  // No probe override needed — DEFAULT_PROBE (still running: done:false, failed:false) is
  // exactly the "in-flight, untouched" state this test wants.
  forge.prReviewData = { ...forge.prReviewData, labels: ["hold"] };

  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r.driven, []); // the fixing lane never appears in DRIVE's outcomes at all
  assert.equal(st.getWorker("lane-fixing")?.state, "fixing"); // untouched — still mid fix-leg
  assert.equal(st.getWorker("lane-fixing")?.fix_rounds, 1); // not bumped, not reset
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.prLabelsAdded, []);
  assertNeverWritesHoldLabel(forge, cfg.escalation.holdLabels);
  st.close();
});

test("#248 grep-invariant (engine-wide): no forge.addLabel/addPRLabel call site in engine source ever references a hold label — write-side asymmetry is structural, not just a runtime behavior", () => {
  const srcDir = new URL("../", import.meta.url);
  const files = readdirSync(srcDir, { recursive: true }).filter(
    (f): f is string => typeof f === "string" && f.endsWith(".ts") && !f.endsWith(".test.ts"),
  );
  // Sanity: the known call-site-heavy modules are present in the scan set, so an empty/broken
  // glob can't make this test vacuously pass.
  assert.ok(files.includes("loop/conductor.ts") && files.includes("roles/architect.ts") && files.includes("roles/plan-review.ts"));
  let callSitesScanned = 0;
  const writeCallRe = /\.(addLabel|addPRLabel)\(/g;
  for (const f of files) {
    const src = readFileSync(new URL(f, srcDir), "utf8");
    let m: RegExpExecArray | null;
    // biome-ignore lint/suspicious/noAssignInExpressions: standard exec-loop idiom
    while ((m = writeCallRe.exec(src))) {
      callSitesScanned++;
      // Look at the call's OWN statement only (start of the match to the next semicolon) — not
      // the whole file — so an unrelated `hold` elsewhere (e.g. this exact holdLabels-consuming
      // deriveGate call a few lines away in merge-driver.ts) can't false-positive.
      const semi = src.indexOf(";", m.index);
      const statement = src.slice(m.index, semi === -1 ? m.index + 200 : semi + 1);
      assert.doesNotMatch(
        statement,
        /hold/i,
        `${f}: an addLabel/addPRLabel call site must never reference a hold label — found: ${statement.trim()}`,
      );
    }
  }
  assert.ok(callSitesScanned >= 20, `expected many addLabel/addPRLabel call sites across the engine, saw ${callSitesScanned}`);
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
  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, []); // SKIP — no outcome of any kind
  assert.equal(st.getWorker("lane-h")?.state, "failed"); // untouched
  assert.equal(st.getWorker("lane-h")?.gated_reentry_attempts, 0); // no attempt burned

  // The human clears `blocked` too — now every hold is gone: reclaim proceeds.
  forge.issueLabelsByIssue[50] = [];
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
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

  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  // Reclaimed straight back to `driving` — same worker row, no dispatch.
  assert.deepEqual(r1.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-a", issue: 10, pr: 99, attempt: 1 }]);
  assert.equal(st.getWorker("lane-a")?.state, "driving");
  assert.equal(st.getWorker("lane-a")?.gated_reentry_attempts, 1);
  // The recorded trigger pin was cleared, so driveOne (same tick, right after the reclaim)
  // treats this unchanged head as never-triggered and posts a FRESH @codex review comment.
  assert.equal(forge.prComments.length, 1);
  assert.deepEqual(r1.driven, [{ kind: "queued", worker: "lane-a", issue: 10, pr: 99, reason: "review-triggered" }]);
  assert.equal(sup.dispatched.length, 0); // no worker spawned

  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
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
  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-s", issue: 20, pr: 88, attempt: 1 }]);
  assert.deepEqual(r1.driven, [{ kind: "queued", worker: "lane-s", issue: 20, pr: 88, reason: "review-triggered" }]);

  // Tick 2: pin matches, but the only review predates the re-trigger (07-01 < 07-02) — it is
  // filtered out, the verdict is WAIT_REVIEW, the lane QUEUES. Never a merge.
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
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
  const r3 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
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
  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, [{ kind: "reclaimed", worker: "lane-b", issue: 11, pr: 199, attempt: 1 }]);
  assert.deepEqual(r1.driven, [{ kind: "queued", worker: "lane-b", issue: 11, pr: 199, reason: "review-triggered" }]);
  assert.equal(st.getWorker("lane-b")?.state, "driving");

  // Tick 2: pin now matches -> gate② re-evaluates the SAME standing findings -> HANDLE_THREADS
  // -> needs-human again. Never a merge.
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.equal(st.getWorker("lane-b")?.state, "failed");
  assert.equal(st.getWorker("lane-b")?.gated_reentry_attempts, 1);
  assert.equal(st.getWorker("lane-b")?.gated_reentry_capped, 0); // cap is only latched on the NEXT removal
  assert.deepEqual(r2.driven, [{ kind: "needs-human", worker: "lane-b", issue: 11, pr: 199, reason: "gate:HUMAN:HANDLE_THREADS" }]);
  // #398: the RE-escalation is PR-born (the lane has a PR), so it lands on the PR and records
  // that carrier — while tick 1 above still honoured the seeded row's legacy ISSUE carrier. Both
  // halves of the cutover, in one lane.
  assert.deepEqual(forge.prLabelsAdded, [[199, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, []);
  assert.equal(st.getWorker("lane-b")?.gated_escalation_carrier, "pr");
  // A REPEAT escalation (gated_reentry_attempts > 0) carries the attempt trail — the very first
  // escalation for a lane never gets this comment. #398: posted where the label is, so "remove
  // it again to retry" points at the object that actually carries the hold.
  assert.equal(forge.issueComments.length, 0);
  // Filtered: `prComments` also holds the merge driver's own `@codex review` trigger posts.
  const gatedNotices = () => forge.prComments.filter(([, body]) => body.startsWith("sapwood: gated-PR"));
  assert.equal(gatedNotices().length, 1);
  assert.match(gatedNotices()[0]![1], /attempt 1\/1/);
  assert.match(gatedNotices()[0]![1], /last automatic attempt/);
  // #167 review (Codex P2+P3 adjudication): cap-hit is this codebase's nearest mechanism to
  // the review doctrine's prFixCap→needs-human pattern — the escalation comment states the
  // principle (re-examine design/technical direction, not more patches) SELF-CONTAINED, true
  // regardless of doctrine adoption. mkCfg() here builds cfg via ConfigSchema.parse with no
  // doctrine file on disk at the default path — the legal, common "no doctrine adopted" case
  // (doctrine.ts's NO_DOCTRINE) — so the comment must NOT cite a doctrine file that doesn't
  // exist.
  assert.match(gatedNotices()[0]![1], /re-examine the feature's design/i);
  assert.doesNotMatch(gatedNotices()[0]![1], /review doctrine/i);
  assert.doesNotMatch(gatedNotices()[0]![1], /point 4/i);
  assert.equal(sup.dispatched.length, 0); // never a new worker, even across the re-escalation

  // Human removes needs-human a SECOND time — from the PR, the carrier the re-escalation used —
  // but the cap (1) is already spent.
  forge.prLabelsByPr[199] = [];
  forge.prReviewData = { ...forge.prReviewData, labels: [] };
  const r3 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r3.gatedReclaimed, [{ kind: "capped", worker: "lane-b", issue: 11, pr: 199, attempts: 1 }]);
  assert.equal(st.getWorker("lane-b")?.state, "failed"); // never reclaimed this time
  assert.equal(st.getWorker("lane-b")?.gated_reentry_capped, 1);
  // #398: the CAPPED re-apply goes back onto the same carrier — never the issue, which would
  // leave the block on an object the handshake does not read.
  assert.deepEqual(forge.prLabelsAdded, [
    [199, "needs-human"],
    [199, "needs-human"],
  ]); // re-applied
  assert.deepEqual(forge.labelsAdded, []);
  assert.equal(gatedNotices().length, 2); // the cap-reached notice
  assert.equal(forge.issueComments.length, 0);
  assert.equal(sup.dispatched.length, 0);

  // A THIRD removal changes nothing — the row is permanently excluded from here on.
  forge.prLabelsByPr[199] = [];
  forge.prReviewData = { ...forge.prReviewData, labels: [] };
  const r4 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r4.gatedReclaimed, []);
  assert.equal(st.getWorker("lane-b")?.state, "failed");
  st.close();
});

// ─────────────────────────────────────────────────────────────────────────────
// #484: terminality is discovered BEFORE the cap. Live evidence (round 262, 2026-07-31): the cap
// gate ran first, so a capped lane could never learn its PR was already MERGED — it re-applied
// `needs-human` to CLOSED issues (#295/#377), the next round's escalation sweep removed it again,
// and the two flapped a label forever. The control was lane-433, under the cap, which reclaimed,
// read the PR and recorded the honest `merged` terminal.

test("#484 AC1: a CAPPED gated lane whose PR is already MERGED still reaches the merged terminal — no `gated-reentry-capped` event, no label write, no attempt burned", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ lanes: { gatedReentryCap: 1 } });
  const gate = new FakeMergeGate();

  // The exact live shape: attempts == cap (the CAPPED branch's own precondition) on a lane whose
  // PR a human merged by hand while the escalation stood.
  st.upsertWorker({
    name: "lane-m",
    issue: 295,
    session_id: "s-lane-m",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 458,
    gated_reentry_attempts: 1,
    gated_escalation_labeled: 1,
  });
  forge.issueLabelsByIssue[295] = []; // the sweep already removed the resolved escalation's label
  forge.prStatus = { ...forge.prStatus, state: "MERGED" };
  gate.outcomes[458] = { kind: "merged", pr: 458, headOid: "H1" };

  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r.gatedReclaimed, [{ kind: "merged", worker: "lane-m", issue: 295, pr: 458, attempts: 1 }]);
  // The lane-433 path: DRIVE settles it this SAME tick with the ordinary merged terminal.
  assert.deepEqual(r.driven, [{ kind: "merged", worker: "lane-m", issue: 295, pr: 458 }]);
  assert.equal(st.getWorker("lane-m")?.state, "done");
  assert.deepEqual(forge.boardSet, [[295, "done"]]);
  assert.equal(st.eventsAfterId(0, ["gated-reentry-capped"]).length, 0, "the cap was never reached — terminality is decided first");
  assert.deepEqual(forge.labelsAdded, [], "no needs-human re-applied to a finished lane");
  assert.deepEqual(forge.prLabelsAdded, []);
  assert.equal(st.getWorker("lane-m")?.gated_reentry_attempts, 1, "nothing was re-entered, so no attempt is burned");
  assert.equal(st.eventsAfterId(0, ["gated-reentry"]).length, 0);

  // Terminal: nothing further, forever.
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r2.gatedReclaimed, []);
  assert.equal(forge.labelsAdded.length, 0);
  st.close();
});

test("#484 AC2: a gated lane whose ISSUE is CLOSED never re-escalates — an OPEN zombie PR on a closed issue is surfaced ONCE and latched, not looped (the #397 issue-CLOSED-gates-reentry ruling)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ lanes: { gatedReentryCap: 2 } });
  const gate = new FakeMergeGate();

  // attempts (0) is UNDER the cap, so this is decided by terminality alone — not by the cap.
  st.upsertWorker({
    name: "lane-z",
    issue: 377,
    session_id: "s-lane-z",
    state: "failed",
    started_at: "t0",
    ended_at: "t1",
    pr: 460,
    gated_escalation_labeled: 1,
  });
  forge.issueLabelsByIssue[377] = [];
  forge.issueStateByIssue[377] = "CLOSED";
  forge.prStatus = { ...forge.prStatus, state: "OPEN" }; // the zombie PR

  for (let round = 0; round < 5; round++) {
    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(
      r.gatedReclaimed,
      round === 0 ? [{ kind: "issue-closed", worker: "lane-z", issue: 377, pr: 460, attempts: 0 }] : [],
      `round ${round}: surfaced exactly once`,
    );
  }
  assert.equal(st.eventsAfterId(0, ["gated-reentry-issue-closed"]).length, 1);
  assert.equal(st.eventsAfterId(0, ["gated-reentry"]).length, 0, "never re-entered — the zombie PR is never re-driven");
  assert.equal(st.eventsAfterId(0, ["gated-reentry-capped"]).length, 0);
  assert.deepEqual(forge.labelsAdded, [], "no re-escalation onto a closed issue");
  assert.deepEqual(forge.prLabelsAdded, []);
  assert.deepEqual(forge.issueComments, []);
  assert.equal(st.getWorker("lane-z")?.state, "failed"); // closure is not success
  assert.equal(st.getWorker("lane-z")?.gated_reentry_capped, 1); // latched: permanently out of reentry
  assert.equal(st.gatedFailedWorkers().length, 0);
  st.close();
});

test("#484 AC3: the live sweep↔reentry cycle (round 262: resolve -> sweep -> re-escalate -> goto) converges to silence — two rounds of reconcile+sweep+tick on a CLOSED issue with a MERGED PR", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ lanes: { gatedReentryCap: 1 } });
  const gate = new FakeMergeGate();

  // The 11:59 state: an escalated lane at its cap, its PR hand-merged and its issue closed by
  // that merge, with the engine's own needs-human label still standing on the issue.
  seedRunning(st, "lane-f", 295);
  const lane = st.getWorker("lane-f")!;
  st.upsertWorker({ ...lane, state: "failed", pr: 458, ended_at: "t1", gated_reentry_attempts: 1, gated_escalation_labeled: 1 });
  st.appendEvent("drive-needs-human", { worker: "lane-f", issue: 295, pr: 458, labeled: 1 });
  forge.issueLabelsByIssue[295] = [cfg.labels.needsHuman];
  forge.issueStateByIssue[295] = "CLOSED";
  forge.prStatus = { ...forge.prStatus, state: "MERGED" };
  gate.outcomes[458] = { kind: "merged", pr: 458, headOid: "H1" };

  const round = async () => {
    await reconcileEscalations(forge, st, cfg);
    await sweepResolvedHolds(forge, st, cfg);
    return tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  };

  // Round 1: the escalation resolves (via merged), the sweep lifts the stale hold, and the lane
  // is COLLECTED instead of re-escalated.
  const r1 = await round();
  assert.deepEqual(r1.gatedReclaimed, [{ kind: "merged", worker: "lane-f", issue: 295, pr: 458, attempts: 1 }]);
  assert.equal(st.getWorker("lane-f")?.state, "done");
  assert.deepEqual(forge.issueLabelsByIssue[295], [], "the hold was swept, and nothing put it back");

  // Round 2 (and 3): silence — no re-escalation, so no new resolution, so nothing left to sweep.
  const eventsAfterRound1 = st.eventsAfterId(0, ["gated-reentry-capped", "needs-human-swept", "escalation-resolved"]).length;
  for (let i = 0; i < 2; i++) {
    const r = await round();
    assert.deepEqual(r.gatedReclaimed, []);
  }
  assert.equal(
    st.eventsAfterId(0, ["gated-reentry-capped", "needs-human-swept", "escalation-resolved"]).length,
    eventsAfterRound1,
    "the cycle emits nothing further — no per-round churn",
  );
  assert.equal(st.eventsAfterId(0, ["gated-reentry-capped"]).length, 0);
  assert.deepEqual(forge.labelsAdded, [], "no GitHub label write on a CLOSED issue, ever");
  assert.deepEqual(forge.prLabelsAdded, []);
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
  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r1.gatedReclaimed, []); // no "capped" outcome emitted on a failed label
  assert.equal(st.getWorker("lane-z")?.gated_reentry_capped, 0); // NOT latched
  assert.equal(st.gatedFailedWorkers().length, 1); // still a candidate next tick
  assert.equal(
    st.eventsSince("2020-01-01T00:00:00Z", ["gated-reentry-capped-label-failed"]).length,
    1, // the failure is durably recorded, never a silent swallow
  );

  // Tick 2: the forge recovers — label applied FIRST, then the latch + outcome, exactly once.
  forge.throwOnAddLabel = false;
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(r2.gatedReclaimed, [{ kind: "capped", worker: "lane-z", issue: 40, pr: 500, attempts: 1 }]);
  assert.deepEqual(forge.labelsAdded, [[40, "needs-human"]]); // restored where triage looks
  assert.equal(st.getWorker("lane-z")?.gated_reentry_capped, 1); // latched only now
  assert.equal(st.gatedFailedWorkers().length, 0); // permanently excluded from here on

  // Tick 3: nothing further — the latch holds, no duplicate outcome/label/comment.
  const r3 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }); // no mergeGate
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
  // #398: the carrier is the PR for a PR-bearing lane, so the PR-side write is the one that has
  // to fail here — the invariant under test ("absence proves nothing unless the engine applied
  // it") is carrier-independent, but the write it is about moved.
  forge.throwOnAddPRLabel = true;
  const r1 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.equal(st.getWorker("lane-x")?.state, "failed"); // terminal transition still landed
  assert.equal(st.getWorker("lane-x")?.gated_escalation_labeled, 0); // label write provably failed
  assert.deepEqual(forge.prLabelsAdded, []); // nothing landed on the PR
  assert.deepEqual(forge.labelsAdded, []); // and nothing on the issue either — one carrier, and it failed
  assert.deepEqual(r1.driven, [{ kind: "needs-human", worker: "lane-x", issue: 30, pr: 400, reason: "gate:HUMAN:HANDLE_THREADS" }]);

  // Next tick: the PR has NO needs-human label — exactly the state a transient label
  // failure leaves behind. Without the labeled marker this would read as an explicit human
  // removal and automation would re-admit itself with no human in the loop. It must not.
  forge.throwOnAddPRLabel = false;
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-y")?.state, "failed");
  assert.equal(st.getWorker("lane-y")?.gated_escalation_labeled, 1);
  assert.equal(st.getWorker("lane-y")?.gated_escalation_carrier, "pr");
  assert.deepEqual(forge.prLabelsAdded, [[401, "needs-human"]]);
  assert.deepEqual(forge.labelsAdded, []);
  st.close();
});

test("#397 AC2 lane shape: a failed worker + PR settling on a HUMAN-MERGE-ONLY verdict never enters gatedFailedWorkers(), so no tick can ever re-escalate it to needs-human", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const gate = new FakeMergeGate();
  const cfg = mkCfg({ lanes: { gatedReentryCap: 1 } });
  seedRunning(st, "lane-ipe", 397);
  sup.probes["lane-ipe"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 397 };
  // The exact verdict the #292 instruction-path chain produces once it has already written
  // `human-merge-only` on the PR itself.
  gate.outcomes[397] = { kind: "needs-human", pr: 397, reason: "gate:HUMAN:instruction-path-change:CLAUDE.md" };
  // The issue carries NO human label — which is precisely the state that makes an ORDINARY
  // escalated lane reclaim-eligible. Only the terminal row's shape keeps this one out.
  forge.issueLabelsByIssue[397] = [];

  const first = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
  assert.deepEqual(first.driven, [
    { kind: "needs-human", worker: "lane-ipe", issue: 397, pr: 397, reason: "gate:HUMAN:instruction-path-change:CLAUDE.md" },
  ]);
  assert.equal(st.getWorker("lane-ipe")?.state, "failed");
  assert.equal(st.getWorker("lane-ipe")?.pr, 397);
  // The P1 mechanism: never labelled => permanently invisible to GATED RECLAIM.
  assert.equal(st.getWorker("lane-ipe")?.gated_escalation_labeled, 0);
  assert.equal(st.gatedFailedWorkers().length, 0);
  assert.equal(st.latestEvent("drive-human-merge-only") != null, true, "the bucket is recorded durably, not only in a label");
  assert.equal(st.latestEvent("drive-needs-human") == null, true, "never the bucket-1 escalation event");

  // Repeated ticks — including one that re-runs every reclaim/escalation phase with the cap
  // already spent, the exact conditions that drive an ORDINARY lane into the CAPPED branch's
  // `addLabel(needsHuman)` — still produce nothing at all for this lane.
  st.upsertWorker({ ...st.getWorker("lane-ipe")!, gated_reentry_attempts: 1 });
  for (let i = 0; i < 3; i++) {
    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg, mergeGate: gate });
    assert.deepEqual(r.gatedReclaimed, []);
    assert.deepEqual(r.driven, []);
  }
  assert.equal(st.gatedFailedWorkers().length, 0);
  assert.equal(st.getWorker("lane-ipe")?.gated_escalation_labeled, 0);
  // AC2's headline assertion: `needs-human` is never written to the issue OR the PR for this lane.
  assert.deepEqual(forge.labelsAdded, []);
  assert.deepEqual(forge.prLabelsAdded, []);
  st.close();
});

test("#397 (PR #463 gate② P2): the bucket-2 verdict event is written BEFORE the terminal row — no crash window in which the row looks like env-failure residue with no verdict on record", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const gate = new FakeMergeGate();
  seedRunning(st, "lane-ipe", 397);
  sup.probes["lane-ipe"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 397 };
  gate.outcomes[397] = { kind: "needs-human", pr: 397, reason: "gate:HUMAN:instruction-path-change:CLAUDE.md" };
  forge.issueLabelsByIssue[397] = [];

  // The row write is what a crash could truncate; the verdict #447's revival reads must already
  // be on record by then, or that pass sees `failed` + PR + marker 0 with no verdict — the exact
  // shape an env failure leaves — and re-drives the one lane #397 closed structurally.
  let verdictOnRecordAtRowWrite: boolean | null = null;
  const realUpsert = st.upsertWorker.bind(st);
  st.upsertWorker = (row) => {
    if (row.name === "lane-ipe" && row.state === "failed") {
      verdictOnRecordAtRowWrite = st.laneEventRecorded("drive-human-merge-only", "lane-ipe", 397);
    }
    realUpsert(row);
  };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(verdictOnRecordAtRowWrite, true, "the verdict was already durable when the terminal row landed");
  assert.equal(st.getWorker("lane-ipe")?.state, "failed");
  assert.equal(st.laneEventRecorded("drive-human-merge-only", "lane-ipe", 397), true);
  st.close();
});

test("#397: the SAME lane shape with an ordinary bucket-1 verdict still escalates needs-human and stays gate-reclaimable — the split is by reason, not by lane shape", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const gate = new FakeMergeGate();
  seedRunning(st, "lane-ord", 398);
  sup.probes["lane-ord"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 398 };
  gate.outcomes[398] = { kind: "needs-human", pr: 398, reason: "merge-decision:ESCALATE" };
  forge.issueLabelsByIssue[398] = [];
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-ord")?.gated_escalation_labeled, 1);
  assert.equal(st.gatedFailedWorkers().length, 1);
  assert.deepEqual(forge.prLabelsAdded, [[398, "needs-human"]]); // #398: PR-born verdict, PR carrier
  assert.deepEqual(forge.labelsAdded, []);
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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

test("#394 (F22, AC2): FAILED lane with envSignalStructured=true but UNRECOGNIZED failure text -> still classified llm (the structured signal is authoritative, independent of text patterns)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-rle", 503);
  sup.probes["lane-rle"] = {
    ...DEFAULT_PROBE,
    failed: true,
    hasPr: false,
    // Deliberately NOT matching any configured llm/forge pattern — a brand-new CLI wording this
    // classifier's text patterns were never updated for. Only envSignalStructured proves the park.
    failureText: "some completely novel error string nobody guessed",
    envSignalStructured: true,
  };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

  assert.deepEqual(r.reclaimed, [{ kind: "env-failure", worker: "lane-rle", issue: 503, source: "llm", costUsd: 0, modelUsage: [] }]);
  assert.equal(st.isParked(), true);
  assert.equal(st.parkRow("llm")?.triggerIssue, 503);
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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
  assert.deepEqual(sup.dispatched, [] as Issue[]);
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
  assert.deepEqual(sup.dispatched, [] as Issue[]);

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

test("#447 park-resume: an env-failed lane holding an OPEN PR is NOT revived while parked; the first tick after the resume returns it to `driving` with fix_rounds intact, while a held sibling stays gated reentry's", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg();
  const t0 = new Date("2026-07-30T08:28:00Z");
  // The 2026-07-30 storm's residue, twice over: env-failure-preserved lanes (`failed` + PR +
  // gated_escalation_labeled=0, zero forge writes — nothing was ever labelled). #378 is free;
  // a human has since put needs-human on #433, which makes THAT lane gated reentry's property.
  const preserve = (name: string, issue: number, pr: number, fixRounds: number): void => {
    st.upsertWorker({
      name,
      issue,
      session_id: `s-${name}`,
      state: "failed",
      started_at: t0.toISOString(),
      ended_at: t0.toISOString(),
      pr,
      gated_escalation_labeled: 0,
      fix_rounds: fixRounds,
    });
    // The environment failure's own durable record — the positive evidence revival requires
    // (PR #463 round 2, P1); reclaimTerminalLane's env branch always writes both.
    st.appendEvent("env-failure-preserved", { worker: name, issue, source: "llm", pr, worktreePath: `/w/${name}` });
  };
  preserve("lane-378", 378, 445, 2);
  preserve("lane-433", 433, 444, 1);
  forge.issueLabelsByIssue[433] = ["needs-human"];
  st.enterPark("forge", "could not resolve host", 378, t0.toISOString());

  // Parked tick (probe not yet due): the environment is still what killed the lane — no revival.
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 5_000) });
  assert.equal(st.isParked(), true);
  assert.equal(st.getWorker("lane-378")?.state, "failed");

  // Recovery tick: the probe clears the episode, but revival runs at the TOP of the tick and
  // still saw a live episode — same one-tick deferral P2-B applies to dispatch.
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 31_000) });
  assert.equal(st.isParked(), false);
  assert.equal(st.eventsSince("2020-01-01T00:00:00Z", ["park-resumed"]).length, 1);
  assert.equal(st.getWorker("lane-378")?.state, "failed", "revival is gated on the resume, not on the probe that produced it");

  // First tick after the resume: revived, with everything the DRIVE loop re-enters on intact.
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 62_000) });
  const revived = st.getWorker("lane-378");
  assert.equal(revived?.state, "driving");
  assert.equal(revived?.pr, 445);
  assert.equal(revived?.fix_rounds, 2);
  assert.equal(st.getWorker("lane-433")?.state, "failed", "a live hold is the gated path's signal — never a second owner");
  assert.deepEqual(
    st.eventsSince("2020-01-01T00:00:00Z", ["lane-revived"]).map((e) => e.payload),
    [{ worker: "lane-378", issue: 378, pr: 445 }],
  );

  // Idempotent across later ticks: the revived row is `driving` and no longer a candidate.
  await tick({ forge, state: st, supervisor: sup, cfg, now: () => new Date(t0.getTime() + 93_000) });
  assert.equal(st.eventsSince("2020-01-01T00:00:00Z", ["lane-revived"]).length, 1);
  st.close();
});

test("#447 park-resume: a lane whose PR merged or closed while the engine was parked is left to the terminal paths, never revived to `driving`", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-30T08:28:00Z");
  st.upsertWorker({
    name: "lane-378",
    issue: 378,
    session_id: "s-lane-378",
    state: "failed",
    started_at: t0.toISOString(),
    ended_at: t0.toISOString(),
    pr: 445,
    gated_escalation_labeled: 0,
  });
  st.appendEvent("env-failure-preserved", { worker: "lane-378", issue: 378, source: "llm", pr: 445, worktreePath: "/w" });
  forge.prStatus = { ...forge.prStatus, state: "MERGED" };

  await tick({ forge, state: st, supervisor: sup, cfg: mkCfg(), now: () => new Date(t0.getTime() + 1_000) });
  assert.equal(st.getWorker("lane-378")?.state, "failed");
  assert.equal(st.eventsSince("2020-01-01T00:00:00Z", ["lane-revived"]).length, 0);
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
  assert.deepEqual(sup.dispatched, [] as Issue[]);

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
  assert.deepEqual(sup.dispatched, [] as Issue[]); // parked from this tick's own reclaim -> no dispatch

  // t0+5: backoff (10s) not yet elapsed -> NO canary, NO full dispatch. The old design cleared
  // park here (probe success) and re-dispatched the full queue — the oscillation.
  await tick({ ...deps, now: () => new Date(t0.getTime() + 5_000) });
  assert.deepEqual(sup.dispatched, [] as Issue[]);
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
  assert.deepEqual(sup.dispatched, [] as Issue[]);

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

/** #451: seeds the durable `fix-response-queued` receipt event a completed fix round leaves
 *  behind (state.ts's settleTerminalWorker) — the ONE record computeDisputeEscalation reads to
 *  tell a `disputed` resolution from a live-indistinguishable `addressed`-still-resolving one.
 *  Appended directly rather than driven through the full harvest pipeline: these are DRIVE-side
 *  tests (the READ half); fix-response.test.ts already covers the harvest/WRITE half. */
const seedFixResponseQueued = (
  st: State,
  worker: string,
  issue: number,
  pr: number,
  headOid: string,
  writes: { threadId: string; resolution: "addressed" | "disputed"; reply: string }[],
  fixRounds = 1,
) =>
  st.appendEvent("fix-response-queued", {
    worker,
    issue,
    pr,
    batchKey: `${worker}#${fixRounds}`,
    fixRounds,
    count: writes.length,
    headOid,
    writes,
  });

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

  const result = await startFixLeg({ state: st, supervisor: sup, renderFixPrompt }, row, fixProxy, realClock);

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
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, row, fixProxy, realClock);
  const updated = st.getWorker("lane-9")!;
  assert.equal(updated.fix_rounds, 1);
  assert.equal(updated.resume_attempts, 5, "resume_attempts must never be disturbed by a fix leg starting");
  st.close();
});

test("startFixLeg: a second fix leg on the same row bumps fix_rounds to 2 (rework rounds accumulate)", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-9", 9, 90);
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, fixProxy, realClock);
  // Simulate the fixing leg completing and landing back in driving (FIXING RECLAIM's own job,
  // tested separately below) before a second fix round starts.
  st.upsertWorker({ ...st.getWorker("lane-9")!, state: "driving" });
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, fixProxy, realClock);
  assert.equal(st.getWorker("lane-9")?.fix_rounds, 2);
  st.close();
});

test("startFixLeg: a thrown resume() leaves the row untouched — driving, fix_rounds NOT bumped (a transient spawn failure costs zero fix-round budget)", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  sup.resumeShouldThrow = "mint failed";
  seedDriving(st, "lane-9", 9, 90);
  await assert.rejects(() =>
    startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, fixProxy, realClock),
  );
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
    () => startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, fixProxy, realClock),
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
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "p" }, st.getWorker("lane-9")!, proxy, realClock);
  assert.equal(sup.resumeCalls[0]!.opts?.proxy, proxy);
  st.close();
});

test("startFixLeg: refuses (throws) when proxy.credentialFree is NOT true — a fix leg must never run with ambient forge credentials (A6)", async () => {
  const st = new State(":memory:");
  const sup = new FakeSupervisor();
  seedDriving(st, "lane-9", 9, 90);
  await assert.rejects(
    () =>
      startFixLeg(
        { state: st, supervisor: sup, renderFixPrompt: () => "p" },
        st.getWorker("lane-9")!,
        { mint: async () => ({}) as never },
        realClock,
      ),
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg({ lanes: { max: 1, roundDispatchCap: 5 } }) });
  assert.deepEqual(sup.dispatched, [], "the fixing lane keeps capacity full -> #9 not launched");
  assert.ok(r.dispatched.some((d) => d.kind === "skipped" && d.issue === 9 && d.reason === "no-lane"));
  assert.equal(st.getWorker("lane-fixing")?.state, "fixing", "unchanged — still occupying the lane");
  st.close();
});

test("tick FIXING RECLAIM: a fixing lane reaching DONE+PR (pushed a fix) lands back in `driving` with the review-trigger pin CLEARED (re-triggers a fresh review, #147-style)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fix", 3, 30, {
    review_triggered_head: "OLD_HEAD",
    review_triggered_at: "2026-07-01T00:00:00Z",
    review_trigger_generation: 2,
  });
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 30 };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "driving");
  assert.equal(row.pr, 30);
  assert.equal(row.review_triggered_head, null, "pin cleared — DRIVE must treat this head as never-triggered");
  assert.equal(row.review_triggered_at, null);
  assert.equal(row.review_trigger_generation, 2, "pin clear preserves the lane's strict-correlation generation history");
  assert.equal(r.fixingReclaimed.length, 1);
  assert.equal(r.fixingReclaimed[0]!.kind, "done");
  st.close();
});

// #247: structured review-thread responses harvested from a fixing lane's terminal DONE
// reclaim, enqueued to the durable pending_thread_writes queue, and executed (idempotently)
// by the SAME tick's FIX RESPONSE RETRY phase.
const sapwoodResult = (metadata: Record<string, unknown>): string =>
  `${RESULT_BLOCK_START}\n${JSON.stringify(metadata)}\n${RESULT_BLOCK_END}`;

/** Seeds (a) the `fix-leg-started` event computeFixResponseHarvest's fixLegJournalCursor reads
 *  back (D2/F1 leg-bound scoping — `fixRounds` defaults to 0, matching seedFixing's own default
 *  when `over.fix_rounds` is never set; `journalCursor` is the monotonic row id captured BEFORE
 *  this same journal row below is appended, exactly like conductor.ts's startFixLeg does) and
 *  (b) the journal row itself — the SAME, PR-bound `pr_review_threads` response the fixing
 *  lane's session was actually served (State.listForgeProxyJournalForSession). */
function seedJournaledThreads(st: State, session: string, issue: number, pr: number, threadIds: string[], fixRounds = 0): void {
  const journalCursor = st.maxForgeProxyJournalId(session);
  st.appendEvent("fix-leg-started", { worker: session, issue, pr, fixRounds, journalCursor, at: "2026-07-18T23:59:59Z" });
  const id = st.appendForgeProxyJournalIntent({
    identity: { roundId: 1, phase: "fixing", role: "worker", session, attempt: 1 },
    seq: 1,
    tool: "pr_review_threads",
    proxyVersion: "1",
    argsCanonical: JSON.stringify({ pr }),
    scopeCanonical: "{}",
    capsCanonical: "{}",
    budgetRemainingCalls: 10,
    budgetRemainingBytes: 1000,
    requestedAt: "2026-07-19T00:00:00Z",
  });
  st.recordForgeProxyJournalResponse(id, {
    responseCanonical: JSON.stringify({ pr, threads: threadIds.map((tid) => ({ id: tid })) }),
    contentHash: "h",
    truncated: false,
    fetchedAt: "2026-07-19T00:00:00Z",
  });
}

test("tick FIXING RECLAIM (#247): a fixing lane's valid structured threadResponses output is harvested and enqueued to pending_thread_writes — never executed synchronously", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fix", 3, 30);
  seedJournaledThreads(st, "lane-fix", 3, 30, ["T1", "T2"]);
  const resultText = sapwoodResult({
    threadResponses: [
      { threadId: "T1", reply: "fixed as suggested", resolution: "addressed" },
      { threadId: "T2", reply: "disagree, see PR description", resolution: "disputed" },
    ],
  });
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 30, resultText };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.getWorker("lane-fix")?.state, "driving");
  // Harvested and queued this SAME tick (before FIX RESPONSE RETRY next runs) — but the forge
  // reply/resolve calls happen on drain, never synchronously inside the harvest itself; by the
  // time this tick RETURNS the queue has already been drained once too (FIX RESPONSE RETRY runs
  // before RECLAIM in tick() — the harvest lands AFTER this tick's own retry pass, so the new
  // rows are picked up on the FOLLOWING tick).
  const pending = st.pendingThreadWrites();
  assert.equal(pending.length, 2);
  assert.deepEqual(pending.map((p) => [p.threadId, p.resolution]).sort(), [
    ["T1", "addressed"],
    ["T2", "disputed"],
  ]);
  assert.equal(forge.threadReplies.length, 0, "not yet executed — queued for the NEXT tick's FIX RESPONSE RETRY");

  // The next tick drains the queue: reply+resolve for T1 (addressed), reply-only for T2 (disputed).
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(forge.threadReplies.sort(), [
    ["T1", "fixed as suggested\n\n<!-- sapwood:fix-reply:lane-fix#30#0:T1 -->"],
    ["T2", "disagree, see PR description\n\n<!-- sapwood:fix-reply:lane-fix#30#0:T2 -->"],
  ]);
  assert.deepEqual(forge.threadResolves, ["T1"], "only the addressed thread is resolved — disputed never calls resolveReviewThread");
  assert.deepEqual(st.pendingThreadWrites(), [], "fully drained");
  assert.equal(r2.fixResponses.length, 2);
  assert.ok(r.fixingReclaimed.length === 1 && r.fixingReclaimed[0]!.kind === "done");
  st.close();
});

test("tick FIXING RECLAIM (#247): a fabricated threadId (never journaled to this leg) fails the WHOLE output closed — nothing enqueued, disputed-still-blocks posture preserved", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fix", 3, 30);
  seedJournaledThreads(st, "lane-fix", 3, 30, ["T1"]); // only T1 was ever served to this leg
  const resultText = sapwoodResult({
    threadResponses: [{ threadId: "GHOST", reply: "fabricated", resolution: "addressed" }],
  });
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 30, resultText };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.deepEqual(st.pendingThreadWrites(), [], "fail-closed — no partial execution");
  st.close();
});

test("tick FIXING RECLAIM (#247): malformed/missing structured output degrades visibly (no throw, no crash mid-reclaim) — the lane still lands in driving normally", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedFixing(st, "lane-fix", 3, 30);
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 30 }; // no resultText at all
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  assert.equal(st.getWorker("lane-fix")?.state, "driving", "the fix leg's OWN terminal transition is unaffected by invalid/absent output");
  assert.deepEqual(st.pendingThreadWrites(), []);
  assert.equal(r.fixingReclaimed.length, 1);
  st.close();
});

test("issue #247 AC (D8, real path): an all-disputed structured output resolves NOTHING via the forge — every thread stays open, and the REAL MergeDriver/CodexReviewer gate (not a fake counter) still reports HANDLE_THREADS", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.prReviewData = { ...forge.prReviewData, unresolvedThreads: 2, headOid: "H1", reviews: [] };
  forge.prStatus = { number: 30, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  const sup = new FakeSupervisor();
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg() });
  seedFixing(st, "lane-fix", 3, 30);
  seedJournaledThreads(st, "lane-fix", 3, 30, ["T1", "T2"]);
  const resultText = sapwoodResult({
    threadResponses: [
      { threadId: "T1", reply: "disagree 1", resolution: "disputed" },
      { threadId: "T2", reply: "disagree 2", resolution: "disputed" },
    ],
  });
  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 30, resultText };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // harvest + enqueue
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate }); // drain (replies only)
  assert.equal(forge.threadResolves.length, 0, "an all-disputed batch never calls resolveReviewThread");
  assert.equal(forge.prReviewData.unresolvedThreads, 2, "still open — resolution never touched");
  // Nothing pending anymore -> a THIRD tick actually drives gate② for real.
  const r3 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(st.getWorker("lane-fix")?.pr, 30);
  const laneOutcome = r3.driven.find((d) => d.worker === "lane-fix");
  assert.ok(
    laneOutcome && laneOutcome.kind !== "merged" && "reason" in laneOutcome && laneOutcome.reason.includes("HANDLE_THREADS"),
    `the REAL gate still reports the 2 standing unresolved threads via HANDLE_THREADS — disputed-still-blocks holds through the actual reviewer/merge-driver code path, not a pure function call (got ${JSON.stringify(laneOutcome)})`,
  );
  st.close();
});

// ── #247 D5: a driving lane with a pending thread write is skipped entirely by DRIVE ───────

test("tick DRIVE (#247 D5): a driving lane with a STILL-pending thread write is skipped by DRIVE entirely (never calls driveOne) — re-evaluated once the queue drains", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.throwOnReplyToReviewThread = true; // the FIX RESPONSE RETRY attempt this tick fails, row stays pending
  const sup = new FakeSupervisor();
  const gate = new FakeMergeGate();
  seedDriving(st, "lane-fix", 3, 30);
  st.enqueueThreadWrite(
    {
      worker: "lane-fix",
      issue: 3,
      pr: 30,
      threadId: "T1",
      reply: "fixed",
      resolution: "addressed",
      batchKey: "lane-fix#30#1",
      fixRounds: 1,
    },
    "2026-07-19T00:00:00Z",
  );

  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.equal(gate.calls.length, 0, "driveOne must NEVER be called for a lane with a pending thread write");
  assert.deepEqual(r.driven, [{ kind: "thread-writes-pending", worker: "lane-fix", issue: 3, pr: 30 }]);
  assert.equal(st.pendingThreadWrites().length, 1, "the retry failed (simulated forge error) — the row is still pending");

  // The forge recovers; the next tick's FIX RESPONSE RETRY succeeds, draining the queue —
  // DRIVE then picks the lane back up normally.
  forge.throwOnReplyToReviewThread = false;
  gate.outcomes[30] = { kind: "merged", pr: 30, headOid: "H1" };
  const r2 = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(st.pendingThreadWrites(), []);
  assert.equal(gate.calls.length, 1, "the queue drained -> DRIVE evaluates the lane normally this tick");
  assert.equal(r2.driven[0]?.kind, "merged");
  st.close();
});

test("issue #247 AC (D8, real path): resolving a thread via the queue never buys MERGE_OK absent a fresh review — verified through the REAL MergeDriver/CodexReviewer gate, not a pure deriveReviewAction call", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.prReviewData = { ...forge.prReviewData, unresolvedThreads: 1, headOid: "H1", reviews: [] };
  forge.prStatus = { number: 30, headOid: "H1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  const sup = new FakeSupervisor();
  const gate = new MergeDriver({ forge, reviewer: new CodexReviewer([]), cfg: mkCfg() });
  seedDriving(st, "lane-fix", 3, 30);
  st.enqueueThreadWrite(
    {
      worker: "lane-fix",
      issue: 3,
      pr: 30,
      threadId: "T1",
      reply: "fixed",
      resolution: "addressed",
      batchKey: "lane-fix#30#1",
      fixRounds: 1,
    },
    "2026-07-19T00:00:00Z",
  );

  // ONE tick: FIX RESPONSE RETRY (runs before DRIVE) drains the queue — the FakeForge's
  // resolveReviewThread simulates a real GraphQL resolveReviewThread mutation by decrementing
  // unresolvedThreads — then DRIVE, seeing nothing pending anymore, evaluates gate② for real.
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
  assert.deepEqual(st.pendingThreadWrites(), []);
  assert.equal(forge.prReviewData.unresolvedThreads, 0, "the thread IS now resolved on the (fake) forge");
  assert.notEqual(
    r.driven[0]?.kind,
    "merged",
    "resolving the thread alone never buys MERGE_OK — no fresh accepted review exists on this head, verified via the real gate",
  );
  st.close();
});

test("tick FIXING RECLAIM + DRIVE, same tick: once a fixing lane lands back in driving with a cleared pin, the SAME tick's DRIVE loop re-triggers a fresh review on the new head (findings -> fixing leg spawned -> push -> driving with cleared pin -> fresh trigger posted)", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  // Start driving, spawn a fix leg (the seam #246 will call), then simulate the fix leg pushing
  // and completing — all inside one fabricated flow, then let tick() reclaim + drive it.
  seedDriving(st, "lane-fix", 3, 30, { review_triggered_head: "OLD_HEAD", review_triggered_at: "2026-07-01T00:00:00Z" });
  await startFixLeg({ state: st, supervisor: sup, renderFixPrompt: () => "fix it" }, st.getWorker("lane-fix")!, fixProxy, realClock);
  assert.equal(st.getWorker("lane-fix")?.state, "fixing");

  sup.probes["lane-fix"] = { ...DEFAULT_PROBE, done: true, hasPr: true, prNumber: 30 };
  const gate = new FakeMergeGate();
  gate.outcomes[30] = { kind: "queued", pr: 30, reason: "gate-pending:WAIT_REVIEW" };
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });

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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), mergeGate: gate });
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
    const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
    ...(pr === null ? {} : { pr }),
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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg(), fixLegResume: { renderFixPrompt, mintProxy } });

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
  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }); // no fixLegResume

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
    now: realClock,
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

  const r = await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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

  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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
  await assert.rejects(() => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }), /simulated ledger failure/);
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
    now: realClock,
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
      now: realClock,
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
    now: realClock,
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
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

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

  await assert.rejects(() => tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() }));
  assert.ok(crashed, "sanity: the simulated crash actually fired");
  assert.ok(sup.handoffRequested.includes("lane-fix"), "requestHandoff is durable/idempotent and fired BEFORE the crashed upsert");
  assert.equal(st.getWorker("lane-fix")?.state, "driving", "still driving — the crashed upsert never landed");
  assert.equal(st.getWorker("lane-fix")?.fix_rounds ?? 0, 0, "fix_rounds NOT bumped by the crashed attempt");

  // Retry: the row is STILL driving with the SAME confirmed intent, so the next tick's
  // reconciliation re-enters this exact branch from scratch.
  st.upsertWorker = originalUpsert;
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
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

  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });

  const row = st.getWorker("lane-fix")!;
  assert.equal(row.state, "driving", "never terminalized without a durable, human-visible label landing first");
  const failedLabelEvents = st.eventsSince("1970-01-01T00:00:00Z", ["fix-leg-undecidable-label-failed"]);
  assert.equal(failedLabelEvents.length, 1);
  const terminalEvents = st.eventsSince("1970-01-01T00:00:00Z", ["fix-leg-undecidable"]);
  assert.equal(terminalEvents.length, 0, "the terminalizing event must never fire alongside a failed label write");

  // Retry: label succeeds this time -> now it terminalizes correctly.
  forge.throwOnAddLabel = false;
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  const retried = st.getWorker("lane-fix")!;
  assert.equal(retried.state, "failed");
  assert.equal(retried.gated_escalation_labeled, 1);
  st.close();
});

// ── #210 (frontend-design §11 follow-up 4): worktree-released — the Needs-attention strip's
//   only resolution signal for a retained worktree. The engine already owns the retained path,
//   so the filesystem it manages IS the signal: on tick/startup, a retained folder that is gone
//   (the human salvaged/discarded it) appends the event ONCE. ──

const RELEASE_SINCE = "1970-01-01T00:00:00Z";
const releasedPaths = (st: State) =>
  st.eventsSince(RELEASE_SINCE, ["worktree-released"]).map((e) => (e.payload as { worktreePath: string }).worktreePath);

test("#210: worktree-released fires once per cleaned-up retained path — never while the folder exists, never twice, and never across a restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-released-"));
  const dbPath = join(dir, "state.db");
  const gone = join(dir, "lane-gone");
  const here = join(dir, "lane-here");
  mkdirSync(gone);
  mkdirSync(here);
  try {
    const st = new State(dbPath);
    st.appendEvent("worktree-retained", { worker: "lane-gone", issue: 11, worktreePath: gone });
    st.appendEvent("worktree-retained", { worker: "lane-here", issue: 12, worktreePath: here });

    releaseVanishedWorktrees(st);
    assert.deepEqual(releasedPaths(st), [], "both folders still on disk — nothing is resolved yet");

    rmSync(gone, { recursive: true, force: true }); // the human cleaned it up
    releaseVanishedWorktrees(st);
    const first = st.eventsSince(RELEASE_SINCE, ["worktree-released"]);
    assert.equal(first.length, 1);
    assert.deepEqual(first[0]!.payload, { worker: "lane-gone", issue: 11, worktreePath: gone }, "mirrors worktree-retained's payload");

    releaseVanishedWorktrees(st); // same tick's worth of work again
    assert.deepEqual(releasedPaths(st), [gone], "no repeat emission while the row stays resolved");
    st.close();

    // Restart: the durable event log itself is the memory — a fresh State must not re-emit.
    const restarted = new State(dbPath);
    releaseVanishedWorktrees(restarted);
    assert.deepEqual(releasedPaths(restarted), [gone], "dedupe survives a restart (no in-memory flag involved)");

    rmSync(here, { recursive: true, force: true });
    releaseVanishedWorktrees(restarted);
    assert.deepEqual(releasedPaths(restarted), [gone, here], "each path resolves on its own, when its own folder goes");
    restarted.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#210: a lane slot re-retained at the SAME path after release resolves again — the latest event per path decides, not 'ever released'", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-released-reuse-"));
  const lane = join(dir, "lane-1");
  try {
    const st = new State(":memory:");
    st.appendEvent("worktree-retained", { worker: "lane-1", issue: 20, worktreePath: lane });
    releaseVanishedWorktrees(st); // never created on disk -> resolved immediately
    assert.deepEqual(releasedPaths(st), [lane]);

    // The lane slot is reused (lane names AND their paths are recycled) and retained again.
    mkdirSync(lane, { recursive: true });
    st.appendEvent("worktree-retained", { worker: "lane-1", issue: 21, worktreePath: lane });
    releaseVanishedWorktrees(st);
    assert.deepEqual(releasedPaths(st), [lane], "still on disk — the fresh retention is unresolved");

    rmSync(lane, { recursive: true, force: true });
    releaseVanishedWorktrees(st);
    const events = st.eventsSince(RELEASE_SINCE, ["worktree-released"]);
    assert.equal(events.length, 2, "the second retention gets its own release");
    assert.equal((events[1]!.payload as { issue: number }).issue, 21, "carrying the LATEST retention's worker/issue");
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#210: a retention with a null worktreePath is unmatchable and is never released (the engine must not emit one)", async () => {
  const st = new State(":memory:");
  st.appendEvent("worktree-retained", { worker: "lane-null", issue: 30, worktreePath: null });
  releaseVanishedWorktrees(st);
  assert.deepEqual(releasedPaths(st), [], "a null path can never be matched — it must never be emitted in the first place");

  // ...and the retention the conductor actually emits always carries one.
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  seedRunning(st, "lane-dirty", 31);
  sup.probes["lane-dirty"] = { ...DEFAULT_PROBE, hbAge: 99999, wrapperAlive: 0 };
  sup.reclaimResults["lane-dirty"] = { worktreePath: "/abs/worktrees/lane-dirty", worktreeRetained: true };
  await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
  const retained = st.eventsSince(RELEASE_SINCE, ["worktree-retained"]);
  assert.equal(retained.length, 2);
  assert.equal((retained[1]!.payload as { worktreePath: string | null }).worktreePath, "/abs/worktrees/lane-dirty");
  st.close();
});

test("#210: tick() itself runs the release scan — the strip clears without a dedicated sweep call", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-released-tick-"));
  const lane = join(dir, "lane-tick");
  try {
    const st = new State(":memory:");
    const forge = new FakeForge();
    const sup = new FakeSupervisor();
    mkdirSync(lane);
    st.appendEvent("worktree-retained", { worker: "lane-tick", issue: 40, worktreePath: lane });
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.deepEqual(releasedPaths(st), [], "folder still there");
    rmSync(lane, { recursive: true, force: true });
    await tick({ now: realClock, forge, state: st, supervisor: sup, cfg: mkCfg() });
    assert.deepEqual(releasedPaths(st), [lane]);
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick ceiling (#431 round 3, codex P2-1): the CLEAR path is receipt-first — a kill between the receipt and the row delete never suppresses the NEXT episode's announcement", async () => {
  // Codex's round-2 reproduction: delete -> kill -> new breach was silently unannounced,
  // because the clear path deleted the row FIRST and the stale un-cleared `entered` then
  // deduped the new episode away. Receipt-first makes the only representable kill state
  // "receipt appended, row still present" — simulated directly here.
  const dir = mkdtempSync(join(tmpdir(), "sapwood-clear-crash-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    let st = new State(dbPath);
    // Episode A ran and began clearing: entered + cleared receipts in the log; the kill landed
    // before clearCeilingBreach, so the stale row survives.
    st.appendEvent("ceiling-breach-entered", { reason: "wall-clock", wallClockElapsedSec: 1200, maxWallClockSec: 600 });
    st.appendEvent("ceiling-breach-cleared", { reason: "wall-clock" });
    st.recordCeilingBreach(["wall-clock"], new Date("2026-07-06T00:20:00Z"));
    st.close();

    // Restart, episode B (a NEW wall-clock breach in the new life): MUST announce — the log's
    // latest for wall-clock is `cleared`, so the pair re-arms regardless of the stale row.
    st = new State(dbPath);
    await tick({
      forge: new FakeForge(),
      state: st,
      supervisor: new FakeSupervisor(),
      cfg: mkCfg({ cost: { maxWallClockSec: 600 } }),
      now: () => new Date("2026-07-06T02:20:00Z"),
      processStartedAt: new Date("2026-07-06T02:00:00Z"), // 1200s alive > 600s cap
    });
    const kinds = st.eventsAfterId(0, ["ceiling-breach-entered", "ceiling-breach-cleared"]).map((e) => e.kind);
    assert.deepEqual(
      kinds,
      ["ceiling-breach-entered", "ceiling-breach-cleared", "ceiling-breach-entered"],
      "episode B is announced — the round-2 order would have suppressed it forever",
    );
    st.close();

    // And the benign half: a recovered restart against the same kill state just deletes the
    // stale row with NO further events (the receipt already closed the episode).
    st = new State(dbPath);
    st.clearCeilingBreach();
    st.recordCeilingBreach(["wall-clock"], new Date("2026-07-06T03:00:00Z")); // re-create the kill state
    st.appendEvent("ceiling-breach-cleared", { reason: "wall-clock" }); // (episode B cleared receipt)
    const before = st.eventsAfterId(0, ["ceiling-breach-entered", "ceiling-breach-cleared"]).length;
    await tick({
      forge: new FakeForge(),
      state: st,
      supervisor: new FakeSupervisor(),
      cfg: mkCfg({ cost: { maxWallClockSec: 600 } }),
      now: () => new Date("2026-07-06T03:01:00Z"),
      processStartedAt: new Date("2026-07-06T03:00:30Z"), // 30s alive — clear
    });
    assert.equal(st.ceilingBreach(), null, "the stale row is deleted on the next clear pass");
    assert.equal(
      st.eventsAfterId(0, ["ceiling-breach-entered", "ceiling-breach-cleared"]).length,
      before,
      "and the announce no-ops — no duplicate receipts",
    );
    st.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("tick ceiling (#431 round 3, codex P2-2): interleaving reasons get independent lifecycles — daily opens near midnight, wall-clock joins, midnight clears daily (its OWN receipt; wall-clock stays open; the row names the CURRENT blocker), and a later daily re-breach announces", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  const sup = new FakeSupervisor();
  const cfg = mkCfg({ cost: { maxWallClockSec: 3000, dailyBudgetUsd: 50 } });
  const processStartedAt = new Date("2026-07-06T23:00:00Z");
  let clock = processStartedAt;
  const now = () => clock;
  const tickAt = async (iso: string) => {
    clock = new Date(iso);
    return tick({ forge, state: st, supervisor: sup, cfg, now, processStartedAt });
  };
  const pairLog = () =>
    st
      .eventsAfterId(0, ["ceiling-breach-entered", "ceiling-breach-cleared"])
      .map((e) => `${e.kind === "ceiling-breach-entered" ? "+" : "-"}${(e.payload as { reason: string }).reason}`);

  // 23:40 — daily budget blows ($60 spent on the 6th); wall-clock still under its 3000s cap.
  st.recordSpend("w1", 1, 60, "2026-07-06T23:50:00.000Z", []);
  const r1 = await tickAt("2026-07-06T23:40:00Z"); // 2400s alive < 3000s
  assert.deepEqual(r1.ceilingReasons, ["daily-budget"]);
  assert.deepEqual(pairLog(), ["+daily-budget"]);

  // 23:55 — wall-clock JOINS (3300s alive): its OWN entered; daily stays open with no dup.
  const r2 = await tickAt("2026-07-06T23:55:00Z");
  assert.deepEqual(r2.ceilingReasons, ["daily-budget", "wall-clock"]);
  assert.deepEqual(pairLog(), ["+daily-budget", "+wall-clock"]);
  assert.deepEqual(
    st.ceilingBreach()?.reasons,
    ["daily-budget", "wall-clock"],
    "the row reflects BOTH current reasons (no first-tick freeze)",
  );

  // 00:10 — UTC midnight rolled: daily clears (fresh day, $0) while wall-clock stays breached.
  // Codex's repro: round 2 emitted NOTHING here and the frozen row kept saying daily-budget —
  // status promising "until tomorrow" for a breach that actually needs a restart.
  const r3 = await tickAt("2026-07-07T00:10:00Z");
  assert.deepEqual(r3.ceilingReasons, ["wall-clock"]);
  assert.deepEqual(
    pairLog(),
    ["+daily-budget", "+wall-clock", "-daily-budget"],
    "daily's departure gets ITS receipt; wall-clock stays open",
  );
  assert.deepEqual(st.ceilingBreach()?.reasons, ["wall-clock"], "the row names the CURRENT blocker after midnight");

  // Later on the 7th — daily RE-breaches while wall-clock is still open: announced again.
  st.recordSpend("w2", 2, 60, "2026-07-07T00:20:00.000Z", []);
  const r4 = await tickAt("2026-07-07T00:30:00Z");
  assert.deepEqual(r4.ceilingReasons, ["daily-budget", "wall-clock"]);
  assert.deepEqual(
    pairLog(),
    ["+daily-budget", "+wall-clock", "-daily-budget", "+daily-budget"],
    "the re-breach under a still-open wall-clock is announced — round 2's global pair suppressed it",
  );
  assert.deepEqual(st.ceilingBreach()?.reasons, ["daily-budget", "wall-clock"]);
  st.close();
});

test("tick ceiling (#431 round 3, codex P2-1): the clear transition's WRITE ORDER is receipt-BEFORE-row-delete — the round-3 write rule, observed directly", async () => {
  const st = new State(":memory:");
  // Open a wall-clock episode first (entered + row).
  const processStartedAt = new Date("2026-07-06T00:00:00Z");
  let clock = new Date("2026-07-06T00:20:00Z");
  const now = () => clock;
  const cfg = mkCfg({ cost: { maxWallClockSec: 600 } });
  await tick({ forge: new FakeForge(), state: st, supervisor: new FakeSupervisor(), cfg, now, processStartedAt });
  assert.ok(st.ceilingBreach() !== null);
  // Now observe the clear transition's write sequence through a recording proxy.
  const writes: string[] = [];
  const spied = new Proxy(st, {
    get(target, prop, receiver) {
      if (prop === "appendEvent") {
        return (kind: string, payload: unknown) => {
          writes.push(`append:${kind}`);
          target.appendEvent(kind, payload);
        };
      }
      if (prop === "clearCeilingBreach") {
        return () => {
          writes.push("row:delete");
          target.clearCeilingBreach();
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as State;
  clock = new Date("2026-07-06T00:21:00Z");
  const relaxed = mkCfg({ cost: { maxWallClockSec: 999999 } });
  await tick({ forge: new FakeForge(), state: spied, supervisor: new FakeSupervisor(), cfg: relaxed, now, processStartedAt });
  const clearSeq = writes.filter((w) => w === "append:ceiling-breach-cleared" || w === "row:delete");
  assert.deepEqual(
    clearSeq,
    ["append:ceiling-breach-cleared", "row:delete"],
    "the LOG receipt lands strictly before the row delete — a kill between the two leaves row+receipt (self-healing), never neither (round 2's silent window)",
  );
  st.close();
});

test("tick PARK (#431 round 5, codex P1): an open NON-LLM park (rapid-restart) blocks the llm-canary exception — a green ping arms NO canary, claims nothing, spawns nothing", async () => {
  const st = new State(":memory:");
  const forge = new FakeForge();
  forge.ready = [{ number: 7, title: "", labels: ["prio:3-feature"] }];
  const sup = new FakeSupervisor();
  const t0 = new Date("2026-07-14T00:00:00Z");
  st.enterPark("llm", "rate_limit_error", 7, t0.toISOString());
  // A faithful open rapid-restart episode (log fact + row mirror) — the codex repro's shape:
  // both parks open, NO forge park, ping green.
  st.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5, enteredAt: t0.toISOString() });
  st.enterPark("rapid-restart", "5 engine starts within 600s (threshold 5) — crash loop suspected", null, t0.toISOString());
  let pings = 0;
  const r = await tick({
    forge,
    state: st,
    supervisor: sup,
    cfg: mkCfg(),
    probeLlmReachable: async () => {
      pings++;
      return true;
    },
    now: () => new Date(t0.getTime() + 31_000), // past the base backoff — the ping runs
  });
  assert.equal(pings, 1, "the ping itself still runs (mixed-storm pacing behavior, unchanged)");
  assert.deepEqual(forge.claimed, [], "codex repro claimed:[7] — must be zero claims");
  assert.deepEqual(sup.dispatched, [], "codex repro spawned:[7] — must be zero spawns");
  assert.equal(st.parkRow("llm")?.canaryWorker ?? null, null, "no canary armed while an independent non-llm park stands");
  assert.equal(r.dispatched.filter((d) => d.kind === "dispatched").length, 0);
  assert.ok(st.parkRow("rapid-restart") !== null, "the rapid-restart park stands throughout");
  st.close();
});
