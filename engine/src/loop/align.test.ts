// align.test.ts (#89, reworked by #110 PR2): the `aligning` phase's PO peripheral — goal
// decomposition (creates issues), the round-start triage pass (drafts plans into existing
// plan-less issues), and round-marker idempotence. Fakes the underlying role session
// (RoleRunner) directly, same "fake the collaborator, not the CLI" split as plan-review.test.ts.
//
// #110 PR2 rework note: the PO session no longer touches `gh` at all — every RoleSessionResult
// a test script hands the fake runner carries a `resultText` (the session's structured final
// output, see structured-output.ts) instead of an `effect` callback that used to simulate a
// direct `gh issue create/edit` side effect. The engine reads `resultText`, validates it, and
// performs every forge write itself — exactly what createAligningStub is being tested for here.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import { extractVerificationPlan } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import type { ContextManifest } from "../roles/context-manifest.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import { PO_ALIGN_ALLOWED_TOOLS, PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS, PO_TRIAGE_ALLOWED_TOOLS } from "../roles/peripheral.js";
import { loadRolePromptTemplate } from "../roles/plan-review.js";
import type { EventKind } from "../state/event-kinds/index.js";
import { State } from "../state/state.js";
import { BODY_BLOCK_END, BODY_BLOCK_START, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import {
  type AlignDeps,
  alignMarker,
  buildBacklogDigest,
  CLOSED_ANNOTATION,
  createAligningStub,
  defaultPoolPromptPath,
  defaultPoPromptPath,
  normalizeProposalTitle,
  packDigestRecords,
  proposalId,
  proposalMarker,
  readPlanMd,
  runPoolSelection,
  selectRoundPool,
  validateAlignOutput,
  validatePoolSelectionOutput,
  validateTriageOutput,
} from "./align.js";
import { RoundScopedForge } from "./round.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

class FakeForge extends UnstubbedForge implements IForge {
  // #379: repo-level label provisioning — no test in this file exercises it.
  override async ensureRepoLabels(): Promise<string[]> {
    return [];
  }
  override async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  override async listIssuesAbsentFromBoard() {
    return { unplaced: [], elsewhere: 0 };
  }
  override async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  issueLabels: Record<number, string[]> = {};
  issueBodies: Record<number, string> = {};
  issueCommentsPosted: Array<[number, string]> = [];
  openIssueNumbers: number[] = [];
  backlogIssues: Issue[] = [];
  createdIssues: Array<{ title: string; body: string }> = [];
  nextIssueNumber = 100;
  boardStatusCalls: Array<[number, string]> = [];
  planTriageCandidates: Issue[] = [];

  override async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  ready: Issue[] = [];
  override async getReadyIssues(): Promise<Issue[]> {
    return this.ready;
  }
  // #214: this file's own tests are about POOL SELECTION mechanics (capacity/priority/reconcile/
  // crash-rerun), never about gate⓪'s narrower-vs-wider distinction — so the pool-eligible read
  // aliases the SAME `ready` backing array by default. Tests that specifically need the two to
  // diverge (or to fail independently) override this method directly, same pattern as the
  // getReadyIssues override below.
  override async getPoolEligibleIssues(): Promise<Issue[]> {
    return this.ready;
  }
  override async claimIssue(): Promise<void> {}
  override async setBoardStatus(n: number, s: "backlog" | "ready" | "inProgress" | "done"): Promise<void> {
    this.boardStatusCalls.push([n, s]);
  }
  override async addSubIssue(): Promise<void> {
    throw new Error("FakeForge.addSubIssue is not used by this test");
  }
  override async getSubIssues() {
    return [];
  }
  addLabelCalls: Array<[number, string]> = [];
  override async addLabel(n: number, l: string): Promise<void> {
    this.addLabelCalls.push([n, l]);
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  removeLabelCalls: Array<[number, string]> = [];
  override async removeLabel(n: number, l: string): Promise<void> {
    this.removeLabelCalls.push([n, l]);
    this.issueLabels[n] = (this.issueLabels[n] ?? []).filter((x) => x !== l);
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
  // #237: per-issue comment store — dissent.ts's postConcernIfNew/scanForAdjudication read this
  // back via getIssueComments(issue) to check the marker and detect a human reply. Preset an
  // issue's entry directly in a test that needs to simulate a pre-existing (e.g. human-authored)
  // comment; addIssueComment below always appends to it too, same as real GitHub would.
  comments: Record<number, Array<{ login: string; createdAt: string; body: string }>> = {};
  override async addIssueComment(n: number, body: string): Promise<void> {
    this.issueCommentsPosted.push([n, body]);
    this.comments[n] = [...(this.comments[n] ?? []), { login: "sapwood-engine", createdAt: new Date().toISOString(), body }];
  }
  override async getIssueComments(issue: number) {
    return this.comments[issue] ?? [];
  }
  issueState: Record<number, "OPEN" | "CLOSED"> = {};
  override async getIssueMeta(issue: number) {
    return {
      number: issue,
      title: this.backlogIssues.find((i) => i.number === issue)?.title ?? "",
      state: this.issueState[issue] ?? ("OPEN" as const),
      labels: this.issueLabels[issue] ?? [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }
  override async getIssueBody(issue: number): Promise<string> {
    return this.issueBodies[issue] ?? "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  override async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
    this.issueBodies[issue] = body;
  }
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
  override async getIssueLabels(issue: number): Promise<string[]> {
    return this.issueLabels[issue] ?? [];
  }
  override async createIssue(title: string, body: string): Promise<number> {
    const n = this.nextIssueNumber++;
    this.createdIssues.push({ title, body });
    this.issueBodies[n] = body;
    this.openIssueNumbers.push(n);
    this.backlogIssues.push({ number: n, title, labels: [], body });
    return n;
  }
  override async listOpenIssueNumbers(): Promise<number[]> {
    return this.openIssueNumbers;
  }
  override async listOpenIssues(): Promise<Issue[]> {
    return this.backlogIssues;
  }
  // #528: the bounded recently-closed dedup surface. Empty by default, so every pre-#528 test in
  // this file exercises the unchanged open-only path.
  closedIssues: Issue[] = [];
  override async listRecentlyClosedIssues(): Promise<Issue[]> {
    return this.closedIssues;
  }
  override async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    // #232: getIssueBody/updateIssueBody read/write `issueBodies`, a store independent of this
    // array by construction (tests build candidates directly) — but on REAL GitHub both calls
    // hit the SAME issue, so the concurrent-edit guard's fresh getIssueBody() re-read must see
    // what the candidate query already reported unless a test deliberately diverges them (to
    // simulate a concurrent edit, by pre-setting issueBodies BEFORE this first runs). Seed
    // once, never overwrite an already-present (possibly test-diverged) body.
    for (const c of this.planTriageCandidates) {
      if (!(c.number in this.issueBodies)) this.issueBodies[c.number] = c.body ?? "";
    }
    // #232 gate② F1 (Codex sol high review of PR #249): the REAL selector (forge.ts's
    // getIssuesNeedingPlanTriage) excludes any issue whose body already has a plan section — a
    // static-array fake that ignores live body content masks exactly the bug the reviewer found
    // (a landed-but-unreceipted body write becoming permanently invisible to the recovery loop).
    // Honor live body content here too, same as real GitHub would — including returning the
    // LIVE body (not the possibly-stale candidate fixture body), same as a real `gh` listing.
    return this.planTriageCandidates
      .map((c) => ({ ...c, body: this.issueBodies[c.number] ?? c.body ?? "" }))
      .filter((c) => extractVerificationPlan(c.body) == null);
  }
}

/** Scripted fake of RoleRunner.run — same shape as plan-review.test.ts's ScriptedRunner: each
 *  call consumes the next scripted result (or the last one, repeated). No `effect` callback
 *  anymore (#110 PR2) — a script step's `resultText` IS the session's entire deliverable; the
 *  engine performs every forge write from it. */
class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  private n = 0;
  constructor(private readonly script: RoleSessionResult[]) {}
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    const step = this.script[Math.min(this.n, this.script.length - 1)]!;
    this.n++;
    return step;
  }
}

/** Builds a session's structured final-message text (structured-output.ts's sentinel format) —
 *  the same shape a real role session's last message must end in post-#110. */
const sapwoodResult = (metadata: Record<string, unknown>, body?: string): string => {
  let out = `${RESULT_BLOCK_START}\n${JSON.stringify(metadata)}\n${RESULT_BLOCK_END}`;
  if (body !== undefined) out += `\n${BODY_BLOCK_START}\n${body}\n${BODY_BLOCK_END}`;
  return out;
};

/** Align mode's own nested per-issue body wrapper (align.ts's ISSUE_BODY_START/END) — one
 *  wrapped segment per created issue, concatenated in metadata-array order, then handed to
 *  sapwoodResult as the single outer BODY block. */
const issueSegment = (body: string): string => `<<<ISSUE>>>\n${body}\n<<<END_ISSUE>>>`;

/** A po-align session's structured output for N created issues (title + body pairs). */
const alignResultText = (issues: Array<{ title: string; body: string }>): string => {
  if (issues.length === 0) return sapwoodResult({ issues: [] });
  return sapwoodResult({ issues: issues.map((i) => ({ title: i.title })) }, issues.map((i) => issueSegment(i.body)).join("\n"));
};

/** A po-triage session's structured output: the entire revised body for one issue. */
const triageResultText = (issue: number, body: string): string => sapwoodResult({ issue }, body);

const doneResult = (name: string, resultText = ""): RoleSessionResult => ({
  outcome: "done",
  costUsd: 0.01,
  modelUsage: [],
  exitCode: 0,
  name,
  resultText,
});
const failedResult = (name: string): RoleSessionResult => ({
  outcome: "failed",
  costUsd: 0.01,
  modelUsage: [],
  exitCode: 1,
  name,
});

/** Taps state.appendEvent so a test can assert on durable degradation events (same pattern as
 *  architect.test.ts's fable-P2 tests on PR #100). */
const tapEvents = (state: State): Array<[string, unknown]> => {
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: EventKind, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  return logged;
};

/** #232: same tap as tapEvents, but appendEvent(poisonKind, ...) THROWS instead of landing —
 *  the scripted fixture for the "load-bearing decision event" crash-boundary tests (the write
 *  itself never lands durably, so the caller's fail-closed handling must skip any effect that
 *  would otherwise follow). Every OTHER kind still lands for real (so the honesty-event/tick-
 *  error appends the production code makes IN RESPONSE to the poisoned failure are themselves
 *  observable in `logged`). */
const tapAndPoisonEvents = (state: State, poisonKind: string): Array<[string, unknown]> => {
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: EventKind, payload: unknown) => {
    logged.push([kind, payload]);
    if (kind === poisonKind) throw new Error(`simulated ${poisonKind} append failure`);
    realAppend(kind, payload);
  };
  return logged;
};

/** #232: content-version hash — MUST mirror align.ts's own (unexported) `contentVersion`
 *  exactly (sha256 hex, first 16 chars) so a test can construct a matching/mismatching
 *  `expected_hash` for the concurrent-edit guard and the write-ahead decision fixtures below. */
const contentVersionForTest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

/** #251: a structurally-valid ContextManifest for context-manifest persistence tests — same
 *  shape as architect.test.ts/plan-review.test.ts/retro.test.ts's own `mkFakeManifest` fixtures
 *  (`model` doubles as a tag so the persisted json is trivially distinguishable from another
 *  fixture's). PO sessions carry no gh grant (PO_ALLOWED_TOOLS), same "structural-no-write-tools"
 *  dirtyBasis architect.test.ts's fixture uses. */
const mkFakeManifest = (tag: string): ContextManifest => ({
  sources: [],
  probedPaths: [],
  knownUnprobed: "imports, ancestor dirs, managed policy",
  capturedPreSpawn: "2026-07-17T00:00:00Z",
  capturedPostExit: "2026-07-17T00:00:01Z",
  captureBasis: "init-observed",
  model: tag,
  modelSource: "requested-fallback",
  cliBin: "claude",
  cliVersion: null,
  toolInventoryHash: null,
  promptTemplateVersion: null,
  mcpTools: [],
  worktree: { path: "/wt", head: null, headResolution: "unresolved", dirty: false, dirtyBasis: "structural-no-write-tools" },
  settingsHash: "hash",
  hookHash: null,
  toolUsage: [],
  readPaths: [],
  recordedAt: "2026-07-17T00:00:01Z",
});

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

// #231: createAligningStub now treats an unreadable goal file as an EXPLICIT align-creation
// failure (no session, no creations) rather than the pre-#231 silent "". Every test in this
// file that doesn't care about goal-file content still needs a REAL, readable default so the
// dozens of pre-existing align/pool-selection tests below keep exercising a normal session
// dispatch — a single shared fixture file here keeps that a one-line change instead of touching
// every call site (cleaned up in `after` below, not left behind on disk). Tests that
// specifically exercise the #231 goal-file-missing path override `goal.file` (or
// `deps.planMdPath`) to a path that does NOT exist.
const DEFAULT_TEST_GOAL_DIR = mkdtempSync(join(tmpdir(), "sapwood-align-goal-"));
const DEFAULT_TEST_GOAL_FILE = join(DEFAULT_TEST_GOAL_DIR, "PLAN.md");
writeFileSync(DEFAULT_TEST_GOAL_FILE, "# Test goal\nHarmless default content for tests that don't care about plan.md.\n");
after(() => rmSync(DEFAULT_TEST_GOAL_DIR, { recursive: true, force: true }));

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    ...LEGACY_LABEL_CONFIG,
    goal: { file: DEFAULT_TEST_GOAL_FILE },
    ...over,
  });

// A body that satisfies extractVerificationPlan (the content check createAligningStub applies
// per created/drafted issue — a business-logic outcome, never a session-validity gate).
// Both carry the #442 `Origin:` line: it is a SESSION-validity gate (validateAlignOutput), so
// every fixture body an align session is scripted to emit must have one — orthogonal to whether
// the body also carries a plan, which is the per-issue business outcome these two constants are
// actually about.
const PLAN_BODY = "Body.\n## Verification\n- run npm test\n\n_Origin: static scan_";
const NO_PLAN_BODY = "Just a title, no plan.\n\n_Origin: static scan_";

test("createAligningStub: marker present -> returns it unchanged, no forge/session calls at all (idempotence)", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([doneResult("s1")]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg: mkCfg(), runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "aligning", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  assert.equal(forge.createdIssues.length, 0);
  state.close();
});

test("createAligningStub: dispatches the align session with the PO tool pair (PO_ALIGN_ALLOWED_TOOLS + PO_DISALLOWED_TOOLS — #410's default-on web grant), no issues declared -> returns the round's marker", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg: mkCfg(), runner };
  const stub = createAligningStub(deps);
  const { marker, ranSession } = await stub.run({ roundId: 5, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(5));
  assert.equal(runner.calls.length, 1);
  assert.equal(ranSession, true, "#394 (F23): a real align session dispatched -> ranSession true");
  assert.equal(runner.calls[0]!.roleId, "po-align");
  // #410: mkCfg()'s default cfg carries webAccess.enabled: true, so po-align gets the widened
  // grant — see the dedicated webAccess:false test below for the ungranted fallback.
  assert.equal(runner.calls[0]!.allowedTools, PO_ALIGN_ALLOWED_TOOLS);
  // Security: the create-flag deny list (file exfil via --body-file, gate⓪ bypass via
  // --label, board writes via --project) must reach the session, not just exist as a const.
  assert.equal(runner.calls[0]!.disallowedTools, PO_DISALLOWED_TOOLS);
  assert.equal(state.spentUsdForWorker("po-align-1"), 0.01);
  state.close();
});

test("createAligningStub (#410): webAccess.enabled: false falls the align session back to the ungranted PO_ALLOWED_TOOLS — no WebSearch/WebFetch reaches it", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const state = new State(":memory:");
  const cfg = mkCfg({ webAccess: { enabled: false } });
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 5, phase: "aligning", marker: null });
  assert.equal(runner.calls[0]!.allowedTools, PO_ALLOWED_TOOLS);
  state.close();
});

test("createAligningStub: a declared issue with a plan section gets stamped origin:agent, never needs-human, never board status", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "Do the thing", body: PLAN_BODY }]))]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 1);
  const expectedProposalId = proposalId(1, 0, "Do the thing");
  assert.deepEqual(forge.createdIssues[0], {
    title: "Do the thing",
    body: `${PLAN_BODY}\n\n${proposalMarker(expectedProposalId)}`,
  });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.boardStatusCalls.length, 0, "the PO never sets board Status=Ready");
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(comment.includes("PO alignment"));
  assert.ok(comment.includes(alignMarker(1)));
  state.close();
});

test("createAligningStub #123: the phase externalizes ONE align-summary event recording created issues (with hasPlan) and triage outcomes", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [] }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([{ title: "Do the thing", body: PLAN_BODY }])),
    doneResult("po-triage-1", triageResultText(9, PLAN_BODY)),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });
  const summaries = state.eventsSince("2020-01-01T00:00:00.000Z", ["align-summary"]);
  assert.equal(summaries.length, 1);
  const p = summaries[0]!.payload as {
    round_id: number;
    created: Array<{ issue: number; title: string; hasPlan: boolean }>;
    triaged: Array<{ issue: number; drafted: boolean }>;
  };
  assert.equal(p.round_id, 1);
  assert.deepEqual(p.created, [{ issue: forge.openIssueNumbers[0]!, title: "Do the thing", hasPlan: true }]);
  assert.deepEqual(p.triaged, [{ issue: 9, drafted: true }]);
  state.close();
});

test("createAligningStub #123: a DEGRADED align pass emits NO align-summary — downstream reads a missing summary, never a successful 'decomposed nothing' (Codex P2, PR #152)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  // Both attempts fail — runSessionWithRetry degrades (po-degraded event fires there).
  const runner = new ScriptedRunner([
    { outcome: "failed", costUsd: 0, modelUsage: [], exitCode: 1, name: "po-align-1" },
    { outcome: "failed", costUsd: 0, modelUsage: [], exitCode: 1, name: "po-align-2" },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(state.eventsSince("2020-01-01T00:00:00.000Z", ["align-summary"]).length, 0);
  state.close();
});

// ── #231: fail-closed peripheral input integrity ────────────────────────────────────────────

test("createAligningStub #231: a missing goal file is an EXPLICIT align-creation failure — no po-align session spawned, no creations, a durable event + tick-error, and triage is UNAFFECTED", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [], body: NO_PLAN_BODY }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-align-missing-goal-"));
  try {
    const missingGoalPath = join(dir, "does-not-exist.md");
    const cfg = mkCfg({ goal: { file: missingGoalPath } });
    // Only ONE script step: if a po-align session were (incorrectly) dispatched, it would
    // consume this triage-shaped result and the test's own assertions below would catch the
    // mismatch (roleId/prompt checks), even before the createdIssues/runner.calls.length checks.
    const runner = new ScriptedRunner([doneResult("po-triage-1", triageResultText(9, PLAN_BODY))]);
    const state = new State(":memory:");
    const logs: string[] = [];
    const deps: AlignDeps = { now: realClock, forge, state, cfg, runner, log: (line) => logs.push(line) };
    const stub = createAligningStub(deps);
    const { marker } = await stub.run({ roundId: 7, phase: "aligning", marker: null });

    assert.equal(marker, alignMarker(7));
    assert.equal(runner.calls.length, 1, "no po-align session spawned — only the triage session runs");
    assert.equal(runner.calls[0]!.roleId, "po-triage", "triage is unaffected by goal-file absence");
    assert.equal(forge.createdIssues.length, 0);

    const goalEvents = state.eventsAfterId(0, ["goal-file-unreadable"]);
    assert.equal(goalEvents.length, 1);
    const payload = goalEvents[0]!.payload as { round_id: number; path: string; reason: string };
    assert.equal(payload.round_id, 7);
    assert.equal(payload.path, missingGoalPath);
    assert.ok(payload.reason.length > 0);
    assert.equal(state.eventsAfterId(0, ["tick-error"]).length, 1, "the align-creation abort is also a tick-error");
    assert.ok(logs.some((l) => /goal file unreadable/.test(l)));

    // Triage still proceeds and completes normally despite the goal-file failure.
    assert.equal(forge.updateIssueBodyCalls.length, 1);
    assert.equal(forge.updateIssueBodyCalls[0]![0], 9);

    // #231 gate② F4: the goal-file failure's honesty record IS the durable event above — no
    // po-align input-manifest row is written at all (there is no real session dispatch to
    // describe; minting one anyway would be a phantom attempt). Triage's OWN manifest rows
    // (a different session) are unaffected and still land normally.
    const manifest = state.inputManifestRows(7);
    assert.equal(
      manifest.some((r) => r.session === "po-align"),
      false,
      "no po-align manifest rows at all — no session ever dispatched",
    );
    const triageIssueBodyRow = manifest.find((r) => r.channel === "issue-body");
    assert.ok(triageIssueBodyRow && triageIssueBodyRow.session === "po-triage:9" && triageIssueBodyRow.ok);
    const triageBacklogRow = manifest.find((r) => r.channel === "backlog-digest" && r.session === "po-triage:9");
    assert.ok(triageBacklogRow?.ok, "the backlog read itself succeeded in this test — only the goal file failed");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createAligningStub (#394 F23 gate② fix): an unreadable goal file (persists every round) + an EMPTY board (zero triage candidates) -> NEITHER session dispatches -> ranSession false, never a permanent-block over-report", async () => {
  // The reachable compound state gate② review traced: cfg.goal.file unreadable means the
  // align-creation session never spawns (see the #231 test above); an empty board means the
  // per-issue triage loop has nothing to iterate either. With NEITHER session actually running,
  // this call must report ranSession: false — before this fix it unconditionally reported
  // `true` at the bottom return, which (combined with a quota storm elsewhere the text/telemetry
  // classifier misses) would make round.ts's empty-spin breaker's required-set check permanently
  // unsatisfiable (aligning never lands in degradedPhases either, since no session ever runs to
  // degrade).
  const forge = new FakeForge(); // default: zero planTriageCandidates -> empty board
  const dir = mkdtempSync(join(tmpdir(), "sapwood-align-empty-board-"));
  try {
    const missingGoalPath = join(dir, "does-not-exist.md");
    const cfg = mkCfg({ goal: { file: missingGoalPath } });
    const runner = new ScriptedRunner([doneResult("must-not-run", alignResultText([]))]);
    const state = new State(":memory:");
    const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
    const stub = createAligningStub(deps);
    const { marker, ranSession } = await stub.run({ roundId: 11, phase: "aligning", marker: null });

    assert.equal(marker, alignMarker(11));
    assert.equal(runner.calls.length, 0, "neither the align-creation nor any triage session ever dispatched");
    assert.equal(ranSession, false, "#394 (F23 gate② fix): both dispatch points skipped -> ranSession false");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createAligningStub #231: a backlog read failure SUPPRESSES issue creation (zero createIssue calls) but does not block the po-align session itself or triage", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [], body: NO_PLAN_BODY }];
  forge.listOpenIssues = async () => {
    throw new Error("simulated backlog outage");
  };
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([{ title: "Do the thing", body: PLAN_BODY }])),
    doneResult("po-triage-1", triageResultText(9, PLAN_BODY)),
  ]);
  const state = new State(":memory:");
  const logs: string[] = [];
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner, log: (line) => logs.push(line) };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 8, phase: "aligning", marker: null });

  assert.equal(marker, alignMarker(8));
  assert.equal(runner.calls.length, 2, "the po-align session still runs — only creation is suppressed");
  assert.equal(runner.calls[0]!.roleId, "po-align");
  assert.equal(forge.createdIssues.length, 0, "zero createIssue calls this pass");

  const honesty = state.eventsAfterId(0, ["backlog-read-failed"]);
  assert.equal(honesty.length, 1);
  assert.deepEqual(honesty[0]!.payload, { round_id: 8, reason: "Error: simulated backlog outage" });
  assert.ok(logs.some((l) => /backlog digest read failed/.test(l)));

  // Triage is unaffected — it proceeds and completes normally.
  assert.equal(forge.updateIssueBodyCalls.length, 1);
  assert.equal(forge.updateIssueBodyCalls[0]![0], 9);

  // The validated proposal was journaled (durable, ready to actually create in a FUTURE round
  // whose own backlog read succeeds) even though creation itself was suppressed this pass.
  const persisted = state.eventsAfterId(0, ["proposal-set-persisted"]);
  assert.equal(persisted.length, 1);
  state.close();
});

test("createAligningStub #231: input-manifest rows record what a normal po-align + po-triage pass actually saw", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [], body: NO_PLAN_BODY }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-1", triageResultText(9, PLAN_BODY)),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  await createAligningStub(deps).run({ roundId: 3, phase: "aligning", marker: null });

  const manifest = state.inputManifestRows(3);
  const goalRow = manifest.find((r) => r.channel === "goal-file");
  const alignBacklogRow = manifest.find((r) => r.channel === "backlog-digest" && r.session === "po-align");
  const issueBodyRow = manifest.find((r) => r.channel === "issue-body");
  // #231 gate② F2: the triage session ALSO renders {{backlog.digest}} — it gets its OWN
  // backlog-digest row (same real ok/counts), distinct from po-align's.
  const triageBacklogRow = manifest.find((r) => r.channel === "backlog-digest" && r.session === "po-triage:9");
  assert.ok(goalRow?.ok && goalRow.session === "po-align" && goalRow.attempt === 1 && goalRow.phase === "aligning");
  assert.ok(alignBacklogRow?.ok && alignBacklogRow.attempt === 1);
  assert.ok(issueBodyRow?.ok && issueBodyRow.session === "po-triage:9" && issueBodyRow.attempt === 1);
  assert.ok(triageBacklogRow?.ok && triageBacklogRow.attempt === issueBodyRow!.attempt, "shares the triage session's own attempt number");
  assert.equal(manifest.length, 4, "goal-file + po-align's backlog-digest + issue-body + triage's own backlog-digest");
  assert.equal(
    manifest.every((r) => r.role === "po"),
    true,
  );
  state.close();
});

// ── #251: context-manifest persistence at align.ts's three runSessionWithRetry sites ───────────
//
// #236 wired peripheral.ts's `RetriedSession.contextManifest` opt-in at 5/8 runSessionWithRetry
// call sites (harvest, architect, plan-review's drafter + reviewer, retro), deferring align.ts's
// three (po-align, po-triage, po-pool) to avoid conflicting with #231's parallel rewrite of this
// same file. #251 closes that gap — same shape as architect.test.ts's/plan-review.test.ts's/
// retro.test.ts's own #236 persistence tests: a scripted "done" result carrying a fixture
// `contextManifest`, asserted against `state.listContextManifestsForRound`.

test("createAligningStub #251: the po-align session's context manifest is persisted, keyed by (round, 'aligning', 'po-align', session name, attempt 1)", async () => {
  const forge = new FakeForge();
  const manifest = mkFakeManifest("po-align-attempt");
  const runner = new ScriptedRunner([{ ...doneResult("po-align-1", alignResultText([])), contextManifest: manifest }]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg: mkCfg(), runner };
  await createAligningStub(deps).run({ roundId: 11, phase: "aligning", marker: null });
  const rows = state.listContextManifestsForRound(11);
  const row = rows.find((r) => r.session === "po-align-1");
  assert.ok(row);
  assert.equal(row!.phase, "aligning");
  assert.equal(row!.role, "po-align");
  assert.equal(row!.attempt, 1);
  assert.deepEqual(JSON.parse(row!.json), manifest);
  state.close();
});

test("createAligningStub #251: the po-triage session's context manifest is persisted, keyed by (round, 'aligning', 'po-triage', session name, attempt 1)", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [], body: NO_PLAN_BODY }];
  const manifest = mkFakeManifest("po-triage-attempt");
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    { ...doneResult("po-triage-1", triageResultText(9, PLAN_BODY)), contextManifest: manifest },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg: mkCfg(), runner };
  await createAligningStub(deps).run({ roundId: 12, phase: "aligning", marker: null });
  const rows = state.listContextManifestsForRound(12);
  const row = rows.find((r) => r.session === "po-triage-1");
  assert.ok(row);
  assert.equal(row!.phase, "aligning");
  assert.equal(row!.role, "po-triage");
  assert.equal(row!.attempt, 1);
  assert.deepEqual(JSON.parse(row!.json), manifest);
  state.close();
});

test("createAligningStub #251: the po-pool session's context manifest is persisted, keyed by (round, 'aligning', 'po-pool', session name, attempt 1)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  const manifest = mkFakeManifest("po-pool-attempt");
  const runner = new ScriptedRunner([{ ...doneResult("role-po-pool-1", poolResultText([1])), contextManifest: manifest }]);
  const state = new State(":memory:");
  await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 13 });
  const rows = state.listContextManifestsForRound(13);
  const row = rows.find((r) => r.session === "role-po-pool-1");
  assert.ok(row);
  assert.equal(row!.phase, "aligning");
  assert.equal(row!.role, "po-pool");
  assert.equal(row!.attempt, 1);
  assert.deepEqual(JSON.parse(row!.json), manifest);
  state.close();
});

test("createAligningStub #231 gate② F2: a backlog read failure is reflected TRUTHFULLY in the triage session's OWN backlog-digest manifest row (ok:false), never inherited as ok:true", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [], body: NO_PLAN_BODY }];
  forge.listOpenIssues = async () => {
    throw new Error("simulated backlog outage");
  };
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-1", triageResultText(9, PLAN_BODY)),
  ]);
  const state = new State(":memory:");
  await createAligningStub({ now: realClock, forge, state, cfg, runner }).run({ roundId: 6, phase: "aligning", marker: null });
  const manifest = state.inputManifestRows(6);
  const triageBacklogRow = manifest.find((r) => r.channel === "backlog-digest" && r.session === "po-triage:9");
  assert.ok(triageBacklogRow);
  assert.equal(triageBacklogRow!.ok, false);
  assert.equal(triageBacklogRow!.detail, "Error: simulated backlog outage");
  state.close();
});

test("createAligningStub #231 gate② F2: the triage issue-body manifest version hashes the FULL rendered context (number/title/labels/body), not body alone — a title-only edit changes it", async () => {
  const mkStub = (title: string): AlignDeps => {
    const forge = new FakeForge();
    forge.planTriageCandidates = [{ number: 9, title, labels: ["needs-human"], body: NO_PLAN_BODY }];
    return {
      forge,
      state: new State(":memory:"),
      cfg: mkCfg(),
      runner: new ScriptedRunner([doneResult("po-triage-1", triageResultText(9, PLAN_BODY))]),
      now: realClock,
    };
  };
  const depsA = mkStub("Original title");
  await createAligningStub(depsA).run({ roundId: 1, phase: "aligning", marker: null });
  const versionA = depsA.state.inputManifestRows(1).find((r) => r.channel === "issue-body")!.version;
  depsA.state.close();

  const depsB = mkStub("A completely different title"); // SAME body/labels, different title
  await createAligningStub(depsB).run({ roundId: 1, phase: "aligning", marker: null });
  const versionB = depsB.state.inputManifestRows(1).find((r) => r.channel === "issue-body")!.version;
  depsB.state.close();

  assert.ok(versionA && versionB);
  assert.notEqual(versionA, versionB, "a title-only edit with the SAME body must still change the recorded version");
});

test("createAligningStub (#397): a declared issue WITHOUT a plan section is fenced `planless` — a routing fence, NOT the human-escalation queue", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "Vague issue", body: NO_PLAN_BODY }]))]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 2, phase: "aligning", marker: null });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"), "still stamped, even when planless");
  // #397 class 6: a freshly PO-created plan-less issue was never an escalation — nobody owes a
  // decision on it, a plan is simply missing. It carries the honest fence, and never lands in
  // the human queue.
  assert.ok(forge.issueLabels[newIssue]!.includes(cfg.labels.planless));
  assert.ok(!forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.boardStatusCalls.length, 0);
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(/no verification plan/.test(comment));
  state.close();
});

test("createAligningStub: multiple declared issues are each processed independently, in metadata-array order", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult(
      "po-align-1",
      alignResultText([
        { title: "a", body: "## Acceptance criteria\n- x\n\n_Origin: static scan_" },
        { title: "b", body: "no plan here\n\n_Origin: static scan_" },
      ]),
    ),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 3, phase: "aligning", marker: null });
  assert.equal(forge.openIssueNumbers.length, 2);
  assert.deepEqual(
    forge.createdIssues.map((i) => i.title),
    ["a", "b"],
  );
  const [a, b] = forge.openIssueNumbers as [number, number];
  assert.ok(forge.issueLabels[a]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[a]!.includes(cfg.labels.planless));
  assert.ok(forge.issueLabels[b]!.includes("origin:agent"));
  assert.ok(forge.issueLabels[b]!.includes(cfg.labels.planless)); // #397: the fence, not needs-human
  assert.ok(!forge.issueLabels[b]!.includes(cfg.labels.needsHuman));
  state.close();
});

// ── #216: persist-first proposal creation + per-proposal crash recovery ───────────────────

const THREE_PROPOSALS = [
  { title: "first", body: PLAN_BODY },
  { title: "second", body: PLAN_BODY },
  { title: "third", body: PLAN_BODY },
];

test("createAligningStub #216: crash before the first creation leaves a durable proposal set; rerun creates the full persisted batch once", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const realCreate = forge.createIssue.bind(forge);
  let failFirst = true;
  forge.createIssue = async (title, body) => {
    assert.equal(state.eventsAfterId(0, ["proposal-set-persisted"]).length, 1, "proposal set lands before create");
    if (failFirst) {
      failFirst = false;
      throw new Error("crash before create");
    }
    return realCreate(title, body);
  };
  const firstRunner = new ScriptedRunner([doneResult("po-align-1", alignResultText(THREE_PROPOSALS))]);
  await assert.rejects(
    () =>
      createAligningStub({ now: realClock, forge, state, cfg, runner: firstRunner }).run({ roundId: 216, phase: "aligning", marker: null }),
    /crash before create/,
  );
  assert.equal(forge.createdIssues.length, 0);

  // The scripted result deliberately differs, but must never be consumed: externalization
  // replays the already-persisted validated set without starting another align session.
  const rerun = new ScriptedRunner([doneResult("po-align-2", alignResultText([]))]);
  await createAligningStub({ now: realClock, forge, state, cfg, runner: rerun }).run({ roundId: 216, phase: "aligning", marker: null });
  assert.equal(rerun.calls.length, 0, "a persisted proposal set bypasses the align session entirely");
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second", "third"],
  );
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 3);
  state.close();
});

test("createAligningStub #216: crash after k of n creations reruns exactly the remaining n-k", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const realCreate = forge.createIssue.bind(forge);
  let attempts = 0;
  forge.createIssue = async (title, body) => {
    attempts++;
    if (attempts === 3) throw new Error("crash after two");
    return realCreate(title, body);
  };
  const firstRunner = new ScriptedRunner([doneResult("po-align-1", alignResultText(THREE_PROPOSALS))]);
  await assert.rejects(
    () =>
      createAligningStub({ now: realClock, forge, state, cfg, runner: firstRunner }).run({ roundId: 217, phase: "aligning", marker: null }),
    /crash after two/,
  );
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second"],
  );

  const rerun = new ScriptedRunner([doneResult("po-align-2", alignResultText(THREE_PROPOSALS))]);
  await createAligningStub({ now: realClock, forge, state, cfg, runner: rerun }).run({ roundId: 217, phase: "aligning", marker: null });
  assert.equal(rerun.calls.length, 0);
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second", "third"],
  );
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 3);
  const summaries = state.eventsAfterId(0, ["align-summary"]);
  assert.equal(summaries.length, 1);
  assert.deepEqual((summaries[0]!.payload as { created: Array<{ issue: number; title: string; hasPlan: boolean }> }).created, [
    { issue: 100, title: "first", hasPlan: true },
    { issue: 101, title: "second", hasPlan: true },
    { issue: 102, title: "third", hasPlan: true },
  ]);
  state.close();
});

test("createAligningStub #216: lost creation receipt reconciles by body marker and never recreates the accepted in-flight issue", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const realCreate = forge.createIssue.bind(forge);
  let attempts = 0;
  forge.createIssue = async (title, body) => {
    attempts++;
    const issue = await realCreate(title, body); // GitHub accepted it
    if (attempts === 2) throw new Error("receipt lost");
    return issue;
  };
  const firstRunner = new ScriptedRunner([doneResult("po-align-1", alignResultText(THREE_PROPOSALS))]);
  await assert.rejects(
    () =>
      createAligningStub({ now: realClock, forge, state, cfg, runner: firstRunner }).run({ roundId: 218, phase: "aligning", marker: null }),
    /receipt lost/,
  );
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second"],
  );

  const rerun = new ScriptedRunner([doneResult("po-align-2", alignResultText(THREE_PROPOSALS))]);
  await createAligningStub({ now: realClock, forge, state, cfg, runner: rerun }).run({ roundId: 218, phase: "aligning", marker: null });
  assert.deepEqual(
    forge.createdIssues.map((issue) => issue.title),
    ["first", "second", "third"],
  );
  const receipts = state.eventsAfterId(0, ["proposal-created"]).map((event) => event.payload as { reconciled?: boolean });
  assert.ok(receipts.some((receipt) => receipt.reconciled === true));
  state.close();
});

test("createAligningStub #216: milestone-scoped lost receipt sees an unassigned marker and does not recreate", async () => {
  const innerForge = new FakeForge();
  const forge = new RoundScopedForge(innerForge, "M4");
  const state = new State(":memory:");
  const cfg = mkCfg({ round: { milestone: "M4" } });
  const realCreate = innerForge.createIssue.bind(innerForge);
  let loseReceipt = true;
  innerForge.createIssue = async (title, body) => {
    const issue = await realCreate(title, body);
    if (loseReceipt) {
      loseReceipt = false;
      throw new Error("accepted without receipt");
    }
    return issue;
  };
  await assert.rejects(
    () =>
      createAligningStub({
        now: realClock,
        forge,
        state,
        cfg,
        runner: new ScriptedRunner([doneResult("po-align-1", alignResultText([THREE_PROPOSALS[0]!]))]),
      }).run({ roundId: 221, phase: "aligning", marker: null }),
    /accepted without receipt/,
  );
  assert.equal(innerForge.createdIssues.length, 1);
  assert.equal(innerForge.backlogIssues[0]!.milestone, undefined, "createIssue assigns no milestone");

  const rerun = new ScriptedRunner([failedResult("must-not-run")]);
  await createAligningStub({ now: realClock, forge, state, cfg, runner: rerun }).run({ roundId: 221, phase: "aligning", marker: null });
  assert.equal(rerun.calls.length, 0);
  assert.equal(innerForge.createdIssues.length, 1, "the full-backlog marker scan reconciles instead of recreating");
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 1);
  state.close();
});

test("createAligningStub #216: proposal receipt lands only after reconciled governance labels, fence, and comment complete", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const realAddIssueComment = forge.addIssueComment.bind(forge);
  let failComment = true;
  forge.addIssueComment = async (issue, body) => {
    if (failComment) {
      failComment = false;
      throw new Error("crash before audit comment");
    }
    return realAddIssueComment(issue, body);
  };
  await assert.rejects(
    () =>
      createAligningStub({
        now: realClock,
        forge,
        state,
        cfg,
        runner: new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "planless", body: NO_PLAN_BODY }]))]),
      }).run({ roundId: 222, phase: "aligning", marker: null }),
    /crash before audit comment/,
  );
  assert.equal(forge.createdIssues.length, 1);
  const issue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[issue]!.includes(cfg.labels.originAgent));
  assert.ok(forge.issueLabels[issue]!.includes(cfg.labels.planless)); // #397: the plan-less fence
  assert.equal(forge.issueCommentsPosted.length, 0);
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 0, "partial governance is not terminal");

  const rerun = new ScriptedRunner([failedResult("must-not-run")]);
  await createAligningStub({ now: realClock, forge, state, cfg, runner: rerun }).run({ roundId: 222, phase: "aligning", marker: null });
  assert.equal(rerun.calls.length, 0);
  assert.ok(forge.issueLabels[issue]!.includes(cfg.labels.originAgent));
  assert.ok(forge.issueLabels[issue]!.includes(cfg.labels.planless)); // #397: the plan-less fence
  assert.equal(forge.issueCommentsPosted.filter(([number]) => number === issue).length, 1);
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 1);
  state.close();
});

test("createAligningStub #232 F3 (Codex sol high review of PR #249): crash after the audit comment lands but BEFORE the proposal-created receipt — rerun reconciles via the marker WITHOUT reposting the comment", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  // The #216 deviation this closes: proposal-created was previously written only AFTER every
  // governance effect including the comment, so a crash strictly between the comment landing and
  // this receipt would repost the (non-idempotent) comment on a marker-reconcile rerun. Intercept
  // ONLY the outer `proposal-created` append (never `proposal-comment-posted`, which
  // applyProposalGovernance appends BEFORE this one, right after the comment itself lands) —
  // same "intercept one call site" idiom the #216 tests above use for forge calls.
  const realAppend = state.appendEvent.bind(state);
  let failReceipt = true;
  state.appendEvent = (kind: EventKind, payload: unknown) => {
    if (kind === "proposal-created" && failReceipt) {
      failReceipt = false;
      throw new Error("crash after comment, before receipt");
    }
    realAppend(kind, payload);
  };
  await assert.rejects(
    () =>
      createAligningStub({
        now: realClock,
        forge,
        state,
        cfg,
        runner: new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "planned", body: PLAN_BODY }]))]),
      }).run({ roundId: 231, phase: "aligning", marker: null }),
    /crash after comment, before receipt/,
  );
  assert.equal(forge.createdIssues.length, 1, "the create + governance (incl. the audit comment) already landed before the crash");
  const issue = forge.openIssueNumbers[0]!;
  assert.equal(forge.issueCommentsPosted.filter(([n]) => n === issue).length, 1);
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 0, "the receipt itself never landed");
  assert.equal(
    state.eventsAfterId(0, ["proposal-comment-posted"]).length,
    1,
    "but the comment's OWN receipt did — this is what prevents a repost on rerun",
  );

  const rerun = new ScriptedRunner([failedResult("must-not-run")]);
  await createAligningStub({ now: realClock, forge, state, cfg, runner: rerun }).run({ roundId: 231, phase: "aligning", marker: null });
  assert.equal(rerun.calls.length, 0, "the persisted proposal set skips po-align entirely on rerun");
  assert.equal(forge.createdIssues.length, 1, "no re-create — reconciled via the body marker");
  assert.equal(
    forge.issueCommentsPosted.filter(([n]) => n === issue).length,
    1,
    "no duplicate comment — the proposal-comment-posted receipt skipped reposting",
  );
  assert.equal(state.eventsAfterId(0, ["proposal-created"]).length, 1, "the receipt-less remainder (just this receipt) now completes");
  state.close();
});

test("createAligningStub #216: divergent proposal journal records honesty and advances with zero forge writes", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const roundId = 224;
  const title = "persisted proposal";
  state.appendEvent("proposal-set-persisted", {
    round_id: roundId,
    proposals: [{ proposalId: proposalId(roundId, 0, title), index: 0, title, body: PLAN_BODY }],
  });
  state.appendEvent("proposal-created", { round_id: roundId, proposalId: "unknown-proposal", issue: 77 });
  const logs: string[] = [];
  const runner = new ScriptedRunner([doneResult("must-not-run", alignResultText([]))]);

  const result = await createAligningStub({ now: realClock, forge, state, cfg: mkCfg(), runner, log: (line) => logs.push(line) }).run({
    roundId,
    phase: "aligning",
    marker: null,
  });

  assert.equal(result.marker, alignMarker(roundId));
  assert.equal(runner.calls.length, 0);
  assert.equal(result.ranSession, undefined, "#394 (F23): a corrupt proposal journal skips outright -> ranSession stays unset");
  assert.equal(forge.createdIssues.length, 0);
  assert.equal(forge.issueCommentsPosted.length, 0);
  assert.equal(Object.values(forge.issueLabels).flat().length, 0);
  const honesty = state.eventsAfterId(0, ["proposal-journal-corrupt"]);
  assert.deepEqual(honesty[0]!.payload, {
    round_id: roundId,
    reason: `unknown terminal proposal unknown-proposal for round ${roundId}`,
  });
  assert.match(logs[0]!, /proposal journal corrupt — creating nothing/);
  state.close();
});

test("createAligningStub #216: corrupt proposal journal records honesty and advances with zero forge writes", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 7, title: "would otherwise triage", labels: [], body: NO_PLAN_BODY }];
  const state = new State(":memory:");
  state.appendEvent("proposal-set-persisted", { round_id: 223, proposals: "not-an-array" });
  const logs: string[] = [];
  const runner = new ScriptedRunner([doneResult("must-not-run", alignResultText([]))]);
  const result = await createAligningStub({ now: realClock, forge, state, cfg: mkCfg(), runner, log: (line) => logs.push(line) }).run({
    roundId: 223,
    phase: "aligning",
    marker: null,
  });
  assert.equal(result.marker, alignMarker(223));
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(
    {
      creates: forge.createdIssues.length,
      labels: Object.values(forge.issueLabels).flat().length,
      comments: forge.issueCommentsPosted.length,
      bodyUpdates: forge.updateIssueBodyCalls.length,
    },
    { creates: 0, labels: 0, comments: 0, bodyUpdates: 0 },
  );
  const honesty = state.eventsAfterId(0, ["proposal-journal-corrupt"]);
  assert.equal(honesty.length, 1);
  assert.deepEqual(honesty[0]!.payload, { round_id: 223, reason: "malformed persisted proposal set for round 223" });
  assert.match(logs[0]!, /proposal journal corrupt — creating nothing/);
  state.close();
});

test("createAligningStub #216: normalized-title collision is skipped with a durable honesty event", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [{ number: 44, title: "Fix:  Payment   Retry!", labels: [], body: "existing" }];
  assert.equal(normalizeProposalTitle("FIX payment retry"), normalizeProposalTitle(forge.backlogIssues[0]!.title));
  const state = new State(":memory:");
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "FIX payment retry", body: PLAN_BODY }]))]);
  await createAligningStub({ now: realClock, forge, state, cfg: mkCfg(), runner }).run({ roundId: 219, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 0);
  const skipped = state.eventsAfterId(0, ["proposal-skipped"]);
  assert.equal(skipped.length, 1);
  assert.deepEqual(skipped[0]!.payload, {
    round_id: 219,
    proposalId: proposalId(219, 0, "FIX payment retry"),
    title: "FIX payment retry",
    reason: "normalized-title-collision",
    existingIssue: 44,
  });
  state.close();
});

test("createAligningStub #528: a normalized-title collision with a RECENTLY CLOSED issue is skipped, receipt naming it", async () => {
  const forge = new FakeForge();
  // The #525/#461 shape: the fact shipped and its issue closed, so the open-only surface was blind
  // to it and the proposal could be filed again.
  forge.closedIssues = [{ number: 461, title: "Reviewer path has no dispute channel", labels: [], body: "shipped" }];
  const state = new State(":memory:");
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([{ title: "reviewer path has NO dispute channel!", body: PLAN_BODY }])),
  ]);
  await createAligningStub({ now: realClock, forge, state, cfg: mkCfg(), runner }).run({ roundId: 528, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 0, "a shipped, closed fact is never re-proposed");
  const skipped = state.eventsAfterId(0, ["proposal-skipped"]);
  assert.equal(skipped.length, 1);
  assert.deepEqual(skipped[0]!.payload, {
    round_id: 528,
    proposalId: proposalId(528, 0, "reviewer path has NO dispute channel!"),
    title: "reviewer path has NO dispute channel!",
    reason: "normalized-title-collision",
    existingIssue: 461,
    existingIssueClosed: true,
  });
  state.close();
});

test("createAligningStub #528: the OPEN collision path is byte-identical — an open match wins, and its receipt carries no closed flag", async () => {
  const forge = new FakeForge();
  // Same normalized title present on BOTH surfaces: the open issue is the one named, and the
  // receipt is exactly the pre-#528 payload (the regression half of the pair).
  forge.backlogIssues = [{ number: 44, title: "Fix:  Payment   Retry!", labels: [], body: "existing" }];
  forge.closedIssues = [{ number: 12, title: "fix payment retry", labels: [], body: "shipped" }];
  const state = new State(":memory:");
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "FIX payment retry", body: PLAN_BODY }]))]);
  await createAligningStub({ now: realClock, forge, state, cfg: mkCfg(), runner }).run({ roundId: 529, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 0);
  const skipped = state.eventsAfterId(0, ["proposal-skipped"]);
  assert.deepEqual(skipped[0]!.payload, {
    round_id: 529,
    proposalId: proposalId(529, 0, "FIX payment retry"),
    title: "FIX payment retry",
    reason: "normalized-title-collision",
    existingIssue: 44,
  });
  state.close();
});

test("createAligningStub #528: a failing recently-closed read degrades OPEN — creation proceeds on the pre-#528 surface", async () => {
  const forge = new FakeForge();
  forge.listRecentlyClosedIssues = async () => {
    throw new Error("closed read unavailable");
  };
  const state = new State(":memory:");
  const logs: string[] = [];
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "A fresh gap", body: PLAN_BODY }]))]);
  await createAligningStub({ now: realClock, forge, state, cfg: mkCfg(), runner, log: (line) => logs.push(line) }).run({
    roundId: 530,
    phase: "aligning",
    marker: null,
  });
  // A backstop read failing must never suppress creation the way the (load-bearing) open-issue
  // read does — the worst case is exactly today's blind spot, and it is logged rather than hidden.
  assert.equal(forge.createdIssues.length, 1);
  assert.ok(
    logs.some((line) => /recently-closed dedup read failed/.test(line)),
    "the degraded dedup surface is named in the log, never silent",
  );
  state.close();
});

test("createAligningStub #216: marker-null full-success rerun performs zero forge writes", async () => {
  const forge = new FakeForge();
  const state = new State(":memory:");
  const cfg = mkCfg();
  const first = new ScriptedRunner([doneResult("po-align-1", alignResultText(THREE_PROPOSALS))]);
  await createAligningStub({ now: realClock, forge, state, cfg, runner: first }).run({ roundId: 220, phase: "aligning", marker: null });
  const writes = {
    creates: forge.createdIssues.length,
    labels: Object.values(forge.issueLabels).flat().length,
    comments: forge.issueCommentsPosted.length,
  };

  const rerun = new ScriptedRunner([doneResult("po-align-2", alignResultText(THREE_PROPOSALS))]);
  await createAligningStub({ now: realClock, forge, state, cfg, runner: rerun }).run({ roundId: 220, phase: "aligning", marker: null });
  assert.deepEqual(
    {
      creates: forge.createdIssues.length,
      labels: Object.values(forge.issueLabels).flat().length,
      comments: forge.issueCommentsPosted.length,
    },
    writes,
  );
  state.close();
});

test("createAligningStub: triage pass briefs a po-triage session per plan-less candidate, posts a traceable comment", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 50, title: "human-filed, no plan", labels: [], body: "just a description" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])), // align pass: declares nothing
    doneResult("po-triage-50", triageResultText(50, "just a description\n## Verification\n- run npm test")),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 6, phase: "aligning", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-triage"],
  );
  // #410: mkCfg()'s default cfg carries webAccess.enabled: true, so po-triage gets the widened
  // grant too.
  assert.equal(runner.calls[1]!.allowedTools, PO_TRIAGE_ALLOWED_TOOLS);
  assert.equal(runner.calls[1]!.disallowedTools, PO_DISALLOWED_TOOLS);
  assert.ok(runner.calls[1]!.prompt.includes("#50"));
  assert.equal(state.spentUsdForWorker("po-triage-50"), 0.01);
  assert.deepEqual(forge.updateIssueBodyCalls, [[50, "just a description\n## Verification\n- run npm test"]]);
  const comment = forge.issueCommentsPosted.find(([n]) => n === 50)?.[1] ?? "";
  assert.ok(comment.includes("PO triage"));
  assert.ok(comment.includes(alignMarker(6)));
  assert.equal(marker, alignMarker(6));
  state.close();
});

test("createAligningStub (#410): webAccess.enabled: false falls the triage session back to the ungranted PO_ALLOWED_TOOLS too", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 50, title: "human-filed, no plan", labels: [], body: "just a description" }];
  const cfg = mkCfg({ webAccess: { enabled: false } });
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-50", triageResultText(50, "just a description\n## Verification\n- run npm test")),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 6, phase: "aligning", marker: null });
  assert.equal(runner.calls[0]!.allowedTools, PO_ALLOWED_TOOLS);
  assert.equal(runner.calls[1]!.allowedTools, PO_ALLOWED_TOOLS);
  state.close();
});

test("createAligningStub: triage processes every candidate independently", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [
    { number: 60, title: "a", labels: [], body: "" },
    { number: 61, title: "b", labels: [], body: "" },
  ];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-60", triageResultText(60, "## Verification\n- a")),
    doneResult("po-triage-61", triageResultText(61, "## Verification\n- b")),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 7, phase: "aligning", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-triage", "po-triage"],
  );
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 60));
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 61));
  state.close();
});

test("createAligningStub #374 review (Codex sol-high finding 6): once an earlier triage candidate classifies quota/429 and parks, remaining candidates are SKIPPED — no doomed per-issue sessions", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [
    { number: 60, title: "a", labels: [], body: "" },
    { number: 61, title: "b", labels: [], body: "" },
    { number: 62, title: "c", labels: [], body: "" },
  ];
  const cfg = mkCfg();
  const quotaResult: RoleSessionResult = {
    outcome: "failed",
    costUsd: 0,
    modelUsage: [],
    exitCode: 1,
    name: "po-triage-60",
    failureText: "hit your session limit",
  };
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])), // po-align itself succeeds cleanly
    quotaResult, // po-triage's FIRST candidate (#60) classifies quota/429 -> parks
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 9, phase: "aligning", marker: null });
  // po-align (1 call) + ONLY #60's triage attempt (1 call) — #61/#62 skipped once parked.
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-triage"],
  );
  assert.equal(state.isParked(), true);
  assert.equal(state.parkRow("llm")?.source, "llm");
  assert.equal(
    forge.issueCommentsPosted.some(([n]) => n === 61 || n === 62),
    false,
    "#61/#62 got no forge write at all",
  );
  state.close();
});

test("createAligningStub #374 review (Codex sol-high verify-pass finding 1, P1): an ARMED recovery round (park ALREADY open before this pass) still runs the FIRST triage candidate for real — it IS the canary — never skips on pre-existing park state alone", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [
    { number: 90, title: "a", labels: [], body: "" },
    { number: 91, title: "b", labels: [], body: "" },
  ];
  const cfg = mkCfg();
  // #90's session succeeds cleanly (the provider IS actually back) -> triaged normally.
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-90", triageResultText(90, "## Verification\n- a")),
    doneResult("po-triage-91", triageResultText(91, "## Verification\n- b")),
  ]);
  const state = new State(":memory:");
  // Simulates round.ts's round-opening gate having ARMED this round via a green
  // probeLlmReachable ping — the ping only arms the round to open, it never clears the episode
  // outright (round.ts's own canary doctrine). If the loop guard skipped on "a park row exists"
  // (the pre-fix behavior), #90 would never even get a chance to prove recovery.
  state.enterPark("llm", "prior quota storm", null, "2026-07-24T00:00:00Z");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 10, phase: "aligning", marker: null });
  // BOTH candidates got a real session — #90's success cleared the park, so #91 proceeds
  // normally too (never gated on the STALE pre-pass park state).
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-triage", "po-triage"],
    "the pre-existing park never suppressed dispatch — both candidates ran",
  );
  assert.equal(state.isParked(), false, "#90's 'done' outcome cleared the episode");
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 90));
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 91));
  state.close();
});

test("createAligningStub #374 review (Codex sol-high verify-pass finding 1, P1): an env failure on a FRESH candidate skips later FRESH candidates but a JOURNAL RESUMPTION later in the list still executes (its decision already landed — no session needed, so the park must never suppress it)", async () => {
  const forge = new FakeForge();
  // #60 is the ONLY fresh candidate (forge.getIssuesNeedingPlanTriage()'s live result) — it gets
  // dispatched first and classifies quota/429.
  forge.planTriageCandidates = [{ number: 60, title: "a", labels: [], body: "" }];
  // #61 is NOT a fresh candidate at all (already has a plan section, hence excluded from the
  // live selector) — but a PRIOR attempt this round already validated and durably accepted its
  // triage decision, with no terminal receipt yet (crash between decision-persist and
  // effect-commit). triageWorkNumbers orders it AFTER every fresh candidate (recoveryOnlyNumbers
  // is appended last) — exactly the "resumption later in the list" shape this fix covers.
  const draftedBody61 = "no plan yet\n## Verification\n- run npm test";
  const expectedHash61 = contentVersionForTest("no plan yet");
  forge.issueBodies[61] = "no plan yet"; // the live body the crashed attempt actually read
  const state = new State(":memory:");
  state.appendEvent("triage-decision-accepted", {
    round_id: 40,
    issue: 61,
    phase: "aligning",
    role: "po",
    session: "po-triage:61",
    attempt: 1,
    body: draftedBody61,
    expected_hash: expectedHash61,
  });
  const cfg = mkCfg();
  const quotaResult: RoleSessionResult = {
    outcome: "failed",
    costUsd: 0,
    modelUsage: [],
    exitCode: 1,
    name: "po-triage-60",
    failureText: "hit your session limit",
  };
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])), // po-align itself succeeds cleanly
    quotaResult, // po-triage's ONLY fresh candidate (#60) classifies quota/429 -> parks
  ]);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 40, phase: "aligning", marker: null });
  // po-align (1 call) + ONLY #60's fresh triage attempt (1 call) — #61 dispatches NO session at
  // all (it is a resumption), yet its pending body write/comment/receipts still execute below.
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-triage"],
    "no session is ever dispatched for #61 — it resumes from its durably-recorded decision",
  );
  assert.equal(state.isParked(), true, "#60's classified failure still parks the episode");
  // The load-bearing assertion: #61's resumption was NOT skipped by the park — its decision's
  // effects (guarded body write, success comment) still landed this pass, even though it comes
  // AFTER the parked fresh candidate in triageWorkNumbers.
  assert.deepEqual(forge.updateIssueBodyCalls, [[61, draftedBody61]], "#61's resumed body write still landed");
  assert.ok(
    forge.issueCommentsPosted.some(([n]) => n === 61),
    "#61's success comment still posted",
  );
  state.close();
});

// ── marker-idempotence across a re-run (rerun-not-resume, #77 decision 4) ───────────────────

test("createAligningStub: re-running the SAME round after a marker was already set drafts nothing twice", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 70, title: "t", labels: [], body: "" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-70", triageResultText(70, "## Verification\n- x")),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const first = await stub.run({ roundId: 8, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2);
  const commentsAfterFirst = forge.issueCommentsPosted.length;

  // Simulate round.ts re-invoking the stub for the SAME phase after a crash/rerun — the
  // persisted marker from the first attempt is handed back in.
  const second = await stub.run({ roundId: 8, phase: "aligning", marker: first.marker });
  assert.equal(second.marker, first.marker);
  assert.equal(runner.calls.length, 2, "no new session dispatched on the idempotent re-run");
  assert.equal(forge.issueCommentsPosted.length, commentsAfterFirst, "no duplicate comments posted");
  state.close();
});

// ── session-failure handling (fable PR #101 P2 — RoleRunner.run never throws on the
//    session's own outcome, so failed/timeout must be handled here) ──────────────────────────

test("createAligningStub P2: a failed align session is retried once; a successful retry proceeds normally (declared issues processed, both spends ledgered, no degradation event)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    failedResult("po-align-0"),
    doneResult("po-align-0-retry", alignResultText([{ title: "t", body: PLAN_BODY }])),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 10, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "exactly one retry");
  assert.equal(marker, alignMarker(10));
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"));
  assert.equal(state.spentUsdForWorker("po-align-0"), 0.01);
  assert.equal(state.spentUsdForWorker("po-align-0-retry"), 0.01);
  assert.ok(!logged.some(([kind]) => kind === "po-degraded"), "a converged retry is not a degradation");
  state.close();
});

test("createAligningStub P2: two failed align sessions -> marker STILL set (next round retries naturally), po-degraded durably appended, triage still runs, nothing created", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 80, title: "t", labels: [], body: "" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    failedResult("po-align-0"),
    failedResult("po-align-0-retry"),
    doneResult("po-triage-80", triageResultText(80, "## Verification\n- x")),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 11, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(11), "the round still advances — pre-Ready, low stakes");
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-align", "po-triage"],
    "one retry, then triage proceeds",
  );
  assert.equal(forge.createdIssues.length, 0, "a twice-failed session creates nothing — the engine is the only creator");
  const ev = logged.find(([kind]) => kind === "po-degraded");
  assert.ok(ev, "degradation is durably visible, never a silent skip");
  assert.equal((ev![1] as { round_id: number }).round_id, 11);
  state.close();
});

test("createAligningStub P2: a failed triage session is retried once; the success comment posts only after the retry's draft actually landed", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 81, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    failedResult("po-triage-81"),
    doneResult("po-triage-81-retry", triageResultText(81, "## Verification\n- x")),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 12, phase: "aligning", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align", "po-triage", "po-triage"],
  );
  assert.ok(
    forge.issueCommentsPosted.some(([n]) => n === 81),
    "success comment after the converged retry",
  );
  assert.ok(!logged.some(([kind]) => kind === "triage-degraded"));
  state.close();
});

test("createAligningStub P2: two failed triage sessions -> NO success comment (never a false audit-trail claim), triage-degraded durably appended, candidate left to re-match next round", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 82, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    failedResult("po-triage-82"),
    failedResult("po-triage-82-retry"),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 13, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(13), "the round still advances — pre-Ready, low stakes");
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 82), "no comment claiming a draft that never landed");
  assert.equal(forge.updateIssueBodyCalls.length, 0, "a twice-failed session's output is never written");
  const ev = logged.find(([kind]) => kind === "triage-degraded");
  assert.ok(ev);
  assert.equal((ev![1] as { issue: number }).issue, 82);
  state.close();
});

test("createAligningStub P2: a 'done' triage session whose VALID output left the body STILL planless posts no success comment either — content-checked, not trusted, and NOT retried (schema validity ≠ content truth)", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 83, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  // Session reports success with a WELL-FORMED structured block, but the drafted body itself
  // still has no verification-plan section (a content-invariant failure, not a shape one).
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-83", triageResultText(83, "still no plan here")),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 14, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "not retried — schema-valid output is a DONE attempt, even if content-checked afterward");
  assert.deepEqual(
    forge.updateIssueBodyCalls,
    [[83, "still no plan here"]],
    "the (planless) draft is still written — the write is earned by validity, not by content",
  );
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 83), "the success comment is earned by the content check, not by exit code");
  assert.ok(logged.some(([kind]) => kind === "triage-degraded"));
  state.close();
});

// ── malformed structured output -> fail-closed, same isValid-driven retry+degrade path as a
//    crashed session (#110's "malformed twice -> the role's existing degrade path") ──────────

test("createAligningStub #110: a malformed align block (no sentinel at all) is retried once, then degrades — nothing created, marker still set", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-0", "I created some issues, trust me."), // no structured block at all
    doneResult("po-align-0-retry", "still nothing structured"),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 15, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "one retry, per #110's isValid-driven retry contract");
  assert.equal(marker, alignMarker(15), "the round is never wedged");
  assert.equal(forge.createdIssues.length, 0);
  const ev = logged.find(([kind]) => kind === "po-degraded");
  assert.ok(ev);
  state.close();
});

test("createAligningStub #110: a malformed align block on the FIRST attempt is retried once and a well-formed second attempt succeeds normally", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-0", "not structured at all"),
    doneResult("po-align-0-retry", alignResultText([{ title: "t", body: PLAN_BODY }])),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 16, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 1, "the converged retry's declared issue IS created");
  assert.ok(!logged.some(([kind]) => kind === "po-degraded"), "a converged retry is not a degradation");
  state.close();
});

test("createAligningStub #110: a malformed triage block is retried once, then degrades via triage-degraded — no write, candidate re-matches next round", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 90, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-90", "no sentinel here"),
    doneResult("po-triage-90-retry", "still no sentinel"),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 17, phase: "aligning", marker: null });
  assert.equal(forge.updateIssueBodyCalls.length, 0);
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 90));
  const ev = logged.find(([kind]) => kind === "triage-degraded");
  assert.ok(ev);
  assert.equal((ev![1] as { issue: number }).issue, 90);
  state.close();
});

// ── #232: triage write-ahead acceptance, effect receipts, concurrent-edit guard ────────────────

test("createAligningStub #232: crash-rerun resume — a persisted triage-decision-accepted with no terminal receipt resumes effects DIRECTLY, zero new po-triage sessions", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 93, title: "t", labels: [], body: "no plan yet" }];
  const cfg = mkCfg();
  const state = new State(":memory:");
  // Simulate a PRIOR (crashed) attempt this round that already validated a po-triage session's
  // output and durably persisted the write-ahead decision — but crashed before ANY effect (body
  // write, comment, receipts) landed.
  const draftedBody = "no plan yet\n## Verification\n- run npm test";
  const expectedHash = contentVersionForTest("no plan yet");
  state.appendEvent("triage-decision-accepted", {
    round_id: 22,
    issue: 93,
    phase: "aligning",
    role: "po",
    session: "po-triage:93",
    attempt: 1,
    body: draftedBody,
    expected_hash: expectedHash,
  });
  // Only an align-pass script step: if a po-triage session were (wrongly) dispatched, the
  // ScriptedRunner would repeat this same "done, declares nothing" step for it too, so any
  // triage dispatch would be silently absorbed rather than crashing — the roleId assertion below
  // is what actually proves no po-triage session ran.
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 22, phase: "aligning", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align"],
    "zero po-triage sessions — the persisted decision resumed directly",
  );
  assert.deepEqual(forge.updateIssueBodyCalls, [[93, draftedBody]]);
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 93));
  assert.equal(marker, alignMarker(22));
  state.close();
});

test("createAligningStub #232: crash-rerun resume — a triage-body-committed receipt (crash after the body write, before the comment) skips the guarded write outright, completes only the receipt-less remainder, no duplicate write", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 94, title: "t", labels: [], body: "no plan yet" }];
  const cfg = mkCfg();
  const state = new State(":memory:");
  const draftedBody = "no plan yet\n## Verification\n- run npm test";
  const expectedHash = contentVersionForTest("no plan yet");
  state.appendEvent("triage-decision-accepted", {
    round_id: 23,
    issue: 94,
    phase: "aligning",
    role: "po",
    session: "po-triage:94",
    attempt: 1,
    body: draftedBody,
    expected_hash: expectedHash,
  });
  state.appendEvent("triage-body-committed", {
    round_id: 23,
    issue: 94,
    phase: "aligning",
    role: "po",
    session: "po-triage:94",
    attempt: 1,
  });
  // The prior (crashed) attempt's body write already landed on the live issue before it crashed.
  forge.issueBodies[94] = draftedBody;
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 23, phase: "aligning", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align"],
    "zero po-triage sessions",
  );
  assert.equal(forge.updateIssueBodyCalls.length, 0, "no duplicate write — the body-committed receipt skipped the guard entirely");
  assert.ok(
    forge.issueCommentsPosted.some(([n]) => n === 94),
    "the receipt-less remainder (the comment) still completes",
  );
  state.close();
});

test("createAligningStub #232 gate② F1 (Codex sol high review of PR #249): crash after the body write lands but BEFORE the body-committed receipt — with REAL selector semantics (the issue no longer needs triage) the journal still discovers it by number, completes the remainder, zero new sessions", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 95, title: "t", labels: [], body: "no plan yet" }];
  const cfg = mkCfg();
  const state = new State(":memory:");
  const draftedBody = "no plan yet\n## Verification\n- run npm test";
  const expectedHash = contentVersionForTest("no plan yet");
  // Write-ahead decision persisted by a PRIOR (crashed) attempt.
  state.appendEvent("triage-decision-accepted", {
    round_id: 24,
    issue: 95,
    phase: "aligning",
    role: "po",
    session: "po-triage:95",
    attempt: 1,
    body: draftedBody,
    expected_hash: expectedHash,
  });
  // The body write itself landed on GitHub — but the crash happened strictly BEFORE the
  // triage-body-committed receipt was ever appended (no receipt of any kind exists for #95).
  forge.issueBodies[95] = draftedBody;

  // Sanity check proving the bug this test targets: the FIXED (live-body-aware) selector no
  // longer surfaces #95 as a candidate at all, since its live body already has a plan — exactly
  // the condition that made the OLD "iterate triageCandidates only" recovery loop unreachable.
  const freshCandidates = await forge.getIssuesNeedingPlanTriage();
  assert.ok(
    !freshCandidates.some((i) => i.number === 95),
    "sanity: the fixed selector excludes an issue whose live body already has a plan",
  );

  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 24, phase: "aligning", marker: null });
  assert.deepEqual(
    runner.calls.map((c) => c.roleId),
    ["po-align"],
    "zero po-triage sessions — recovered from the journal BY NUMBER, never rediscovered via the selector",
  );
  assert.equal(
    forge.updateIssueBodyCalls.length,
    0,
    "no duplicate write — updateIssueBodyIfUnchanged's current===newBody short-circuit applies since the write already landed",
  );
  assert.ok(
    forge.issueCommentsPosted.some(([n]) => n === 95),
    "the receipt-less remainder (comment + both receipts) still completes",
  );
  const events = state.eventsAfterId(0, ["triage-body-committed", "triage-effects-committed"]);
  assert.ok(
    events.some((e) => e.kind === "triage-body-committed" && (e.payload as { issue: number }).issue === 95),
    "the missing body-committed receipt is backfilled",
  );
  assert.ok(
    events.some((e) => e.kind === "triage-effects-committed" && (e.payload as { issue: number }).issue === 95),
    "the decision reaches its terminal receipt",
  );
  state.close();
});

test("createAligningStub #232: concurrent-edit guard — a live body change since the session read it REFUSES the write, keeps the old body, records triage-stale-hash-skipped, degrades open", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 92, title: "t", labels: [], body: "original body, no plan" }];
  const cfg = mkCfg();
  // #232: getIssuesNeedingPlanTriage now reflects LIVE body content (the F1 fixture fix above),
  // so the concurrent edit must land AFTER the candidate fetch (which is what expected_hash is
  // derived from) but BEFORE the guard's re-read — i.e. "during" the po-triage session itself,
  // exactly where a real concurrent edit would race a real (seconds-to-minutes) session.
  const runner = {
    calls: [] as RoleSessionOpts[],
    async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
      this.calls.push(opts);
      if (opts.roleId === "po-triage") {
        forge.issueBodies[92] = "a human edited this issue concurrently";
        return doneResult("po-triage-92", triageResultText(92, "## Verification\n- x"));
      }
      return doneResult("po-align-1", alignResultText([]));
    },
  };
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 21, phase: "aligning", marker: null });
  assert.equal(forge.updateIssueBodyCalls.length, 0, "the write is refused — old body kept");
  assert.equal(forge.issueBodies[92], "a human edited this issue concurrently");
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 92), "no success comment for a refused write");
  const ev = logged.find(([kind]) => kind === "triage-stale-hash-skipped");
  assert.ok(ev);
  assert.equal((ev![1] as { issue: number; round_id: number }).issue, 92);
  assert.equal((ev![1] as { round_id: number }).round_id, 21);
  assert.equal(marker, alignMarker(21), "degrades open — the round is never wedged");
  state.close();
});

test("createAligningStub #232: a triage-decision-accepted append failure aborts the write entirely (fail-closed) — no updateIssueBody call, a triage-decision-lost honesty event + tick-error recorded, round not wedged", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 91, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult("po-triage-91", triageResultText(91, "## Verification\n- x")),
  ]);
  const state = new State(":memory:");
  const logged = tapAndPoisonEvents(state, "triage-decision-accepted");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 20, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(20), "round not wedged");
  assert.equal(forge.updateIssueBodyCalls.length, 0, "no write — the decision never durably landed");
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 91));
  assert.ok(
    logged.some(([kind]) => kind === "triage-decision-lost"),
    "a durable honesty event records the loss",
  );
  assert.ok(logged.some(([kind]) => kind === "tick-error"));
  state.close();
});

test("createAligningStub #237 finding 6: a triage concern is DROPPED (never posted) when its accompanying decision fails to persist durably", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 91, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])),
    doneResult(
      "po-triage-91",
      sapwoodResult({ issue: 91, concerns: [{ issue: 91, reason: "this issue's premise seems wrong" }] }, "## Verification\n- x"),
    ),
  ]);
  const state = new State(":memory:");
  const logged = tapAndPoisonEvents(state, "triage-decision-accepted");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 20, phase: "aligning", marker: null });
  assert.ok(
    logged.some(([kind]) => kind === "triage-decision-lost"),
    "the decision itself was lost",
  );
  assert.equal(forge.comments[91]?.length ?? 0, 0, "the concern that rode along with the lost decision is never posted");
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 0);
  state.close();
});

test("createAligningStub #237 finding 6: a triage concern is DROPPED when the concurrent-edit guard refuses the body write (stale hash)", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 92, title: "t", labels: [], body: "original body, no plan" }];
  const cfg = mkCfg();
  const runner = {
    calls: [] as RoleSessionOpts[],
    async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
      this.calls.push(opts);
      if (opts.roleId === "po-triage") {
        forge.issueBodies[92] = "a human edited this issue concurrently";
        return doneResult(
          "po-triage-92",
          sapwoodResult({ issue: 92, concerns: [{ issue: 92, reason: "premise seems wrong" }] }, "## Verification\n- x"),
        );
      }
      return doneResult("po-align-1", alignResultText([]));
    },
  };
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 21, phase: "aligning", marker: null });
  assert.equal(forge.updateIssueBodyCalls.length, 0, "the write is refused");
  assert.equal(forge.comments[92]?.length ?? 0, 0, "the concern is never posted — its decision's effect was refused");
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 0);
  state.close();
});

test("createAligningStub #237 finding 6: a RESUMED triage decision's concern IS posted (the decision itself already persisted successfully in an earlier attempt)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const state = new State(":memory:");
  // Simulate a crash-rerun: an accepted decision from an earlier attempt this round, with no
  // terminal receipt yet — the body write hasn't landed, so this resumes straight to the guard.
  forge.issueBodies[93] = "no plan";
  state.appendEvent("triage-decision-accepted", {
    round_id: 22,
    issue: 93,
    phase: "aligning",
    role: "po",
    session: "po-triage:93",
    attempt: 1,
    body: "## Verification\n- x",
    expected_hash: contentVersionForTest("no plan"),
    concerns: [{ issue: 93, reason: "recovered concern" }],
  });
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 22, phase: "aligning", marker: null });
  assert.equal(forge.updateIssueBodyCalls.length, 1, "the resumed decision's body write lands");
  // Two comments land on #93: the triage success comment (plan drafted) AND the concern —
  // the concern IS posted because the resumed decision already durably persisted.
  assert.equal(forge.comments[93]?.length, 2);
  assert.ok(forge.comments[93]!.some((c) => /recovered concern/.test(c.body)));
  state.close();
});

test("createAligningStub #110 (Codex round 1): a duplicate-title align batch twice -> align's degrade path, NOTHING created (never a double-create)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const dupText = alignResultText([
    { title: "Add X", body: PLAN_BODY },
    { title: "Add X", body: PLAN_BODY },
  ]);
  const runner = new ScriptedRunner([doneResult("po-align-0", dupText), doneResult("po-align-0-retry", dupText)]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 19, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "invalid output is retried once, then degrades");
  assert.equal(marker, alignMarker(19), "the round still advances");
  assert.equal(forge.createdIssues.length, 0, "zero createIssue calls — the duplicate batch is rejected whole, never partially applied");
  assert.ok(logged.some(([kind]) => kind === "po-degraded"));
  state.close();
});

test("createAligningStub #110: an align block with a wrong number of <<<ISSUE>>> body segments is malformed, not silently truncated/misassigned", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    // Metadata declares 2 issues, but the BODY block only carries one segment.
    doneResult("po-align-0", sapwoodResult({ issues: [{ title: "a" }, { title: "b" }] }, issueSegment("only one body"))),
    doneResult("po-align-0-retry", alignResultText([{ title: "a", body: PLAN_BODY }])),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 18, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "the mismatched first attempt was retried");
  assert.equal(forge.createdIssues.length, 1, "only the converged retry's single issue was created");
  state.close();
});

// ── labels.originAgent is config-driven (fable PR #101 P3) ──────────────────────────────────

test("createAligningStub P3: a customized labels.originAgent value is what gets stamped — never a hardcoded 'origin:agent'", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ labels: { ...LEGACY_LABEL_CONFIG.labels, originAgent: "bot:made" } });
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([{ title: "t", body: PLAN_BODY }]))]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 23, phase: "aligning", marker: null });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("bot:made"));
  assert.ok(!forge.issueLabels[newIssue]!.includes("origin:agent"));
  state.close();
});

// ── template rendering + loading (unit) ─────────────────────────────────────────────────────

test("defaultPoPromptPath: resolves to a real shipped file with both align and triage sections", () => {
  const template = loadRolePromptTemplate(undefined, defaultPoPromptPath());
  assert.ok(template.includes("{{po.mode}}"));
  assert.ok(template.includes("{{round.milestone}}"));
  assert.ok(template.includes("{{plan.md}}"));
  assert.ok(template.includes("{{issue.number}}"));
  assert.ok(template.includes("{{issue.body}}"));
  assert.ok(template.includes("{{round.directive}}"), "#126: the shipped po.md must reference the round directive var");
  assert.ok(template.includes("{{backlog.digest}}"));
});

test("po.md #444: the digest is no longer claimed authoritative for open issues, its real scope is named, and pre-filing search is mandated", () => {
  const template = loadRolePromptTemplate(undefined, defaultPoPromptPath());
  assert.ok(
    !/authoritative for current open issues/.test(template),
    "#444: the overclaim that made the milestone-scoped digest look like the complete dedup surface must be gone",
  );
  assert.ok(template.includes("outside this round"), "the prompt must name the digest's actual scope annotations");
  assert.ok(template.includes("mcp__forge__search_issues"), "the prompt must mandate the pre-filing search where the proxy is attached");
  assert.ok(/propose nothing/.test(template), "the existing 'if overlap is uncertain, propose nothing' rule stays");
});

test("po.md #528: the prompt explains the recently-closed half of the dedup surface", () => {
  const template = loadRolePromptTemplate(undefined, defaultPoPromptPath());
  // The annotation align.ts actually renders (CLOSED_ANNOTATION) must be the one the prompt
  // names — a rendered marker the session was never told about is not dedup context.
  // Whitespace-collapsed: the prose wraps, the rendered annotation does not.
  const flattened = template.replace(/\s+/g, " ");
  assert.ok(flattened.includes(CLOSED_ANNOTATION.trim()), "the prompt must name the closed annotation as align.ts renders it");
  assert.ok(!/it holds only OPEN issues/.test(template), "#528: the digest is no longer open-only, so the claim that it is must be gone");
});

test("buildBacklogDigest: number-sorted titles + configured hold annotations are deterministic; a record too large to fit whole is OMITTED, never sliced (#231)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { backlogDigestMaxChars: 200 } } });
  forge.backlogIssues = [
    { number: 20, title: "z".repeat(220), labels: ["blocked"] },
    { number: 3, title: "Earlier gap", labels: ["NEEDS-HUMAN", "unrelated"] },
  ];
  const first = await buildBacklogDigest(forge, cfg);
  forge.backlogIssues.reverse();
  const rerun = await buildBacklogDigest(forge, cfg);
  assert.deepEqual(first, rerun, "the same backlog is byte-identical regardless of forge ordering");
  assert.equal(first.ok, true);
  assert.ok(first.text.length <= 200);
  // #231: #20's line alone (~228 chars) cannot fit whole in a 200-char budget — it is OMITTED
  // in full, never sliced mid-line. #3's short line fits and is rendered.
  assert.match(first.text, /^- #3 — Earlier gap \[hold: needs-human\]/);
  assert.ok(!first.text.includes("- #20"), "a record too large to fit whole is never partially rendered");
  assert.equal(first.total, 2);
  assert.equal(first.rendered, 1);
  assert.equal(first.omitted, 1);
  assert.equal(first.truncated, true);
  assert.match(first.text, /1 more issue\(s\) omitted/);
});

test("buildBacklogDigest #231: a 50-issue fixture proves the high-numbered tail is either rendered or counted as omitted, never silently gone", async () => {
  const forge = new FakeForge();
  // A cap that comfortably fits the low-numbered issues but not all 50 — proves the omitted
  // tail is BOTH visible in the truncation marker's counts AND absent from the rendered text,
  // never just silently missing with no trace (the #231 acceptance criterion fixture).
  const cfg = mkCfg({ roles: { po: { backlogDigestMaxChars: 600 } } });
  forge.backlogIssues = Array.from({ length: 50 }, (_, i) => ({ number: i + 1, title: `issue number ${i + 1}`, labels: [] }));
  const result = await buildBacklogDigest(forge, cfg);
  assert.equal(result.ok, true);
  assert.equal(result.total, 50);
  assert.ok(result.rendered > 0 && result.rendered < 50, "a partial render — some rendered, some omitted");
  assert.equal(result.omitted, 50 - result.rendered);
  assert.equal(result.truncated, true);
  assert.ok(result.text.length <= 600);
  // Every rendered record is a WHOLE, unsliced line: #1 renders first (lowest number, sorted
  // ascending) and every rendered line matches the full "- #N — issue number N" shape — no
  // record is cut mid-line.
  const lines = result.text.split("\n").filter((l) => l.startsWith("- #"));
  assert.equal(lines.length, result.rendered);
  for (const line of lines) assert.match(line, /^- #\d+ — issue number \d+$/);
  // The high-numbered tail (#50 specifically) is either fully rendered or accounted for in the
  // omitted count — never just absent with no trace.
  const tailRendered = result.text.includes("- #50 — issue number 50");
  assert.equal(tailRendered, result.rendered === 50);
  if (!tailRendered) assert.match(result.text, new RegExp(`${result.omitted} more issue\\(s\\) omitted`));
});

test("buildBacklogDigest: zero issues and a contained read failure are distinct, explicit, and machine-checkable (#231: ok/reason, not just text)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const empty = await buildBacklogDigest(forge, cfg);
  assert.deepEqual(empty, {
    text: "(no open issues yet)",
    ok: true,
    total: 0,
    rendered: 0,
    omitted: 0,
    truncated: false,
    renderedIssueNumbers: [],
  });
  forge.listOpenIssues = async () => {
    throw new Error("forge unavailable");
  };
  const failed = await buildBacklogDigest(forge, cfg);
  assert.equal(failed.ok, false);
  assert.equal(failed.text, "(backlog digest unavailable: open-issue read failed)");
  assert.match(failed.reason ?? "", /forge unavailable/);
});

test("buildBacklogDigest #215/#216/#444: milestone scope is local to the digest consumer — it ORDERS and ANNOTATES, it no longer excludes", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [
    { number: 1, title: "M4 work", labels: [], milestone: "M4" },
    { number: 2, title: "M5 work", labels: [], milestone: "M5" },
    { number: 3, title: "unassigned proposal", labels: [] },
  ];
  assert.equal(
    (await buildBacklogDigest(forge, mkCfg({ round: { milestone: "M4" } }))).text,
    "- #1 — M4 work\n- #2 — M5 work [milestone: M5 — outside this round]\n- #3 — unassigned proposal [no milestone — outside this round]",
  );
  // Unscoped round: every open issue is in scope, so nothing carries a scope annotation.
  assert.equal((await buildBacklogDigest(forge, mkCfg())).text, "- #1 — M4 work\n- #2 — M5 work\n- #3 — unassigned proposal");
});

test("buildBacklogDigest #444: an other-milestone / un-milestoned open issue is IN the dedup surface (the #435→#428 pairing shape)", async () => {
  const forge = new FakeForge();
  // The real 07-29/30 shape: a run scoped to v0.2.1 filed #435 duplicating #428 (next
  // milestone) and #439 duplicating #427 (agent-filed, deliberately un-milestoned). Both had to
  // be visible for overlap checking; under the pre-#444 milestone-scoped digest neither was.
  forge.backlogIssues = [
    { number: 428, title: "retro.ts KNOWN GAP comment", labels: [], milestone: "v0.2.2" },
    { number: 430, title: "In-milestone work", labels: ["blocked"], milestone: "v0.2.1" },
    { number: 427, title: "guard.fuzz.test.ts t.skip guards", labels: [] },
  ];
  const digest = await buildBacklogDigest(forge, mkCfg({ round: { milestone: "v0.2.1" } }));
  assert.equal(digest.ok, true);
  assert.equal(digest.total, 3);
  assert.equal(digest.truncated, false);
  // This round's own milestone renders FIRST (decomposition focus survives truncation), the
  // out-of-scope dedup surface follows, each half number-ascending.
  assert.deepEqual(digest.renderedIssueNumbers, [430, 427, 428]);
  assert.ok(digest.text.includes("- #430 — In-milestone work [hold: blocked]"));
  assert.ok(digest.text.includes("- #428 — retro.ts KNOWN GAP comment [milestone: v0.2.2 — outside this round]"));
  assert.ok(digest.text.includes("- #427 — guard.fuzz.test.ts t.skip guards [no milestone — outside this round]"));
});

test("buildBacklogDigest #444: the widened dedup surface still obeys packDigestRecords — an out-of-scope record past the cap is COUNTED, never silently cut", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [
    { number: 1, title: "in scope", labels: [], milestone: "M4" },
    { number: 2, title: "z".repeat(220), labels: [], milestone: "M5" },
  ];
  const digest = await buildBacklogDigest(forge, mkCfg({ round: { milestone: "M4" }, roles: { po: { backlogDigestMaxChars: 200 } } }));
  assert.equal(digest.ok, true);
  assert.ok(digest.text.length <= 200);
  assert.equal(digest.total, 2);
  assert.equal(digest.rendered, 1);
  assert.equal(digest.omitted, 1);
  assert.equal(digest.truncated, true);
  assert.deepEqual(digest.renderedIssueNumbers, [1]);
  assert.ok(!digest.text.includes("- #2"), "a record too large to fit whole is never partially rendered");
  assert.match(digest.text, /1 more issue\(s\) omitted/);
});

test("buildBacklogDigest #528: recently closed issues join the dedup surface, rendered distinctly and LAST", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [
    { number: 430, title: "In-milestone work", labels: [], milestone: "v0.2.1" },
    { number: 427, title: "Un-milestoned proposal", labels: [] },
  ];
  const closed: Issue[] = [
    { number: 461, title: "Reviewer path has no dispute channel", labels: [], milestone: "v0.2.1" },
    { number: 12, title: "Older shipped fact", labels: [] },
  ];
  const digest = await buildBacklogDigest(forge, mkCfg({ round: { milestone: "v0.2.1" } }), closed);
  assert.equal(digest.ok, true);
  assert.equal(digest.total, 4, "the closed set counts toward the digest's own bounded budget");
  assert.equal(digest.truncated, false);
  assert.equal(
    digest.text,
    "- #430 — In-milestone work\n" +
      "- #427 — Un-milestoned proposal [no milestone — outside this round]\n" +
      "- #12 — Older shipped fact [recently closed — do not re-propose]\n" +
      "- #461 — Reviewer path has no dispute channel [recently closed — do not re-propose]",
  );
  // Closed issues are dedup context, never a concern target: the in-view bounds set stays the
  // OPEN rendered subset, so #237's concern validation is unchanged.
  assert.deepEqual(digest.renderedIssueNumbers, [430, 427]);
});

test("buildBacklogDigest #528: the closed tail is what a tight cap drops — counted, never silently cut", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [{ number: 1, title: "open work", labels: [] }];
  const closed: Issue[] = [{ number: 2, title: "z".repeat(220), labels: [] }];
  const digest = await buildBacklogDigest(forge, mkCfg({ roles: { po: { backlogDigestMaxChars: 200 } } }), closed);
  assert.ok(digest.text.length <= 200);
  assert.equal(digest.total, 2);
  assert.equal(digest.rendered, 1);
  assert.equal(digest.omitted, 1);
  assert.equal(digest.truncated, true);
  assert.ok(!digest.text.includes("- #2"), "an oversized closed record is omitted whole, never sliced");
  assert.match(digest.text, /1 more issue\(s\) omitted/);
  assert.deepEqual(digest.renderedIssueNumbers, [1]);
});

test("buildBacklogDigest #528: an empty backlog with recently closed issues still renders them (not the empty placeholder)", async () => {
  const forge = new FakeForge();
  const closed: Issue[] = [{ number: 12, title: "Shipped fact", labels: [] }];
  const digest = await buildBacklogDigest(forge, mkCfg(), closed);
  assert.equal(digest.ok, true);
  assert.equal(digest.text, "- #12 — Shipped fact [recently closed — do not re-propose]");
  assert.deepEqual(digest.renderedIssueNumbers, []);
  // Zero on BOTH surfaces is still the pre-#528 placeholder.
  assert.equal((await buildBacklogDigest(forge, mkCfg(), [])).text, "(no open issues yet)");
});

test("packDigestRecords: an absurdly tiny cap still never exceeds maxChars, even with zero rendered records", () => {
  const result = packDigestRecords(["- #1 — a", "- #2 — b"], 5, "(none)");
  assert.ok(result.text.length <= 5);
  assert.equal(result.total, 2);
  assert.equal(result.rendered, 0);
  assert.equal(result.omitted, 2);
  assert.equal(result.truncated, true);
});

test("createAligningStub #215/#444: the align prompt receives the whole open backlog — this round's milestone first, everything else annotated as dedup-only", async () => {
  const innerForge = new FakeForge();
  innerForge.backlogIssues = [
    { number: 42, title: "Existing bounded work", labels: ["blocked"], milestone: "M4" },
    { number: 43, title: "Other milestone work", labels: [], milestone: "M5" },
  ];
  const forge = new RoundScopedForge(innerForge, "M4");
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const state = new State(":memory:");
  await createAligningStub({ now: realClock, forge, state, cfg: mkCfg({ round: { milestone: "M4" } }), runner }).run({
    roundId: 1,
    phase: "aligning",
    marker: null,
  });
  assert.ok(runner.calls[0]!.prompt.includes("- #42 — Existing bounded work [hold: blocked]"));
  assert.ok(runner.calls[0]!.prompt.includes("- #43 — Other milestone work [milestone: M5 — outside this round]"));
  assert.ok(!runner.calls[0]!.prompt.includes("{{backlog.digest}}"));
  state.close();
});

test("createAligningStub #215: a pre-existing custom PO prompt without {{backlog.digest}} still renders", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-po-custom-"));
  try {
    const promptPath = join(dir, "po.md");
    writeFileSync(promptPath, "custom mode={{po.mode}}\ndirective={{round.directive}}\n");
    const forge = new FakeForge();
    forge.backlogIssues = [{ number: 8, title: "Unused by this override", labels: [] }];
    const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
    const state = new State(":memory:");
    await createAligningStub({ now: realClock, forge, state, cfg: mkCfg({ roles: { po: { promptFile: promptPath } } }), runner }).run({
      roundId: 1,
      phase: "aligning",
      marker: null,
    });
    assert.match(runner.calls[0]!.prompt, /^custom mode=align/m);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#128: a real caller (deps.planMdPath omitted) renders {{plan.md}} from cfg.goal.file, the single resolved north-star path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-goalfile-"));
  try {
    const goalPath = join(dir, "GOAL.md");
    writeFileSync(goalPath, "# North star\nOnly ship what advances the north star.\n");
    const forge = new FakeForge();
    // cfg.goal.file is config-file-relative resolved by loadConfig in a real run; here we set
    // it directly to an absolute path, mirroring what loadConfig would have produced.
    const cfg = mkCfg({ goal: { file: goalPath } });
    const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
    const state = new State(":memory:");
    const deps: AlignDeps = { now: realClock, forge, state, cfg, runner }; // no deps.planMdPath override
    const stub = createAligningStub(deps);
    await stub.run({ roundId: 1, phase: "aligning", marker: null });
    assert.ok(runner.calls[0]!.prompt.includes("Only ship what advances the north star."));
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #126: round directive file — human steering injected at round open ─────────────────────

test("createAligningStub #126: no directive file -> both the align session AND every triage session render the explicit 'none' placeholder, no directive-applied event", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [] }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-directive-"));
  try {
    const cfg = mkCfg({ round: { directiveFile: join(dir, "DIRECTIVE.md") } });
    const runner = new ScriptedRunner([
      doneResult("po-align-1", alignResultText([])),
      doneResult("po-triage-1", triageResultText(9, PLAN_BODY)),
    ]);
    const state = new State(":memory:");
    const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
    const stub = createAligningStub(deps);
    await stub.run({ roundId: 1, phase: "aligning", marker: null });
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      assert.ok(call.prompt.includes("No round directive was provided for this round."));
    }
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 0);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createAligningStub #126: a directive file is substituted into BOTH the align and triage prompts, one directive-applied event recorded, and the file is archived out of the live path", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [] }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-directive-"));
  try {
    const directiveFile = join(dir, "DIRECTIVE.md");
    writeFileSync(directiveFile, "Prioritize the payments module this round.", "utf8");
    const cfg = mkCfg({ round: { directiveFile } });
    const runner = new ScriptedRunner([
      doneResult("po-align-1", alignResultText([])),
      doneResult("po-triage-1", triageResultText(9, PLAN_BODY)),
    ]);
    const state = new State(":memory:");
    const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
    const stub = createAligningStub(deps);
    await stub.run({ roundId: 4, phase: "aligning", marker: null });
    assert.equal(runner.calls.length, 2);
    for (const call of runner.calls) {
      assert.ok(call.prompt.includes("Prioritize the payments module this round."));
    }
    const events = state.eventsAfterId(0, ["directive-applied"]);
    assert.equal(events.length, 1);
    const payload = events[0]!.payload as { round_id: number; path: string; content: string; sha256: string };
    assert.equal(payload.round_id, 4);
    assert.equal(payload.path, directiveFile);
    assert.equal(payload.content, "Prioritize the payments module this round.");
    assert.match(payload.sha256, /^[0-9a-f]{64}$/);
    assert.equal(existsSync(directiveFile), false, "consumed: archived out of the live path");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createAligningStub #126: crash-rerun — a resumed call for the SAME round (marker still null) reuses the recorded directive content, never a duplicate event, even if the live file is re-dropped in between", async () => {
  const forge = new FakeForge();
  const dir = mkdtempSync(join(tmpdir(), "sapwood-directive-"));
  try {
    const directiveFile = join(dir, "DIRECTIVE.md");
    writeFileSync(directiveFile, "original steering", "utf8");
    const cfg = mkCfg({ round: { directiveFile } });
    const state = new State(":memory:");

    const runner1 = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
    const deps1: AlignDeps = { now: realClock, forge, state, cfg, runner: runner1 };
    await createAligningStub(deps1).run({ roundId: 2, phase: "aligning", marker: null });
    assert.ok(runner1.calls[0]!.prompt.includes("original steering"));

    // Simulate a crash-then-resume: the SAME round is re-entered at aligning (marker still
    // null — the earlier attempt never got far enough to persist one) after an operator (or a
    // race) leaves a DIFFERENT file at the live path.
    writeFileSync(directiveFile, "a later, different directive", "utf8");
    forge.planTriageCandidates = [{ number: 9, title: "planless idea", labels: [] }];
    const runner2 = new ScriptedRunner([doneResult("po-triage-2", triageResultText(9, PLAN_BODY))]);
    const deps2: AlignDeps = { now: realClock, forge, state, cfg, runner: runner2 };
    await createAligningStub(deps2).run({ roundId: 2, phase: "aligning", marker: null });
    assert.equal(runner2.calls.length, 1, "the persisted proposal set skips po-align; triage still runs");
    assert.equal(runner2.calls[0]!.roleId, "po-triage");
    assert.ok(runner2.calls[0]!.prompt.includes("original steering"));
    assert.ok(!runner2.calls[0]!.prompt.includes("a later, different directive"));

    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1, "no duplicate event across the resumed call");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readPlanMd #231: reads a real file explicitly (ok: true); a missing path is an EXPLICIT failure (ok: false + reason), never a silent empty string", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-align-"));
  try {
    const p = join(dir, "PLAN.md");
    writeFileSync(p, "# The Plan\ngoals here");
    assert.deepEqual(readPlanMd(p), { ok: true, content: "# The Plan\ngoals here" });
    const missing = readPlanMd(join(dir, "nonexistent.md"));
    assert.equal(missing.ok, false);
    assert.ok(!missing.ok && missing.reason.length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PO_ALLOWED_TOOLS: #110 PR5 — no Bash grant at all (issue creation is now an engine write from validated structured output above), and still no board-status/project capability (structural no-Ready guarantee)", () => {
  assert.ok(!PO_ALLOWED_TOOLS.includes("Bash("), "no Bash(...) entry of any kind");
  assert.ok(!PO_ALLOWED_TOOLS.includes("gh api"), "no channel to board-status/project mutation");
  assert.ok(!PO_ALLOWED_TOOLS.includes("gh project"));
  assert.ok(!PO_ALLOWED_TOOLS.includes("git"), "no code/repo capability");
});

// ── #110 PR2: structured-output parsing/validation — unit tests, no session dispatch ─────────

test("validateAlignOutput: no structured block at all -> fail-closed", () => {
  const result = validateAlignOutput("just some prose, no sentinel");
  assert.equal(result.ok, false);
});

test("validateAlignOutput: truncated sentinel (no matching end) -> fail-closed", () => {
  const text = `${RESULT_BLOCK_START}\n{"issues":[]`;
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
});

test("validateAlignOutput: JSON-invalid metadata -> fail-closed", () => {
  const text = `${RESULT_BLOCK_START}\nnot json\n${RESULT_BLOCK_END}`;
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /not valid JSON/.test(result.reason));
});

test("validateAlignOutput: a smuggled 'labels' field in an issue entry is rejected outright (.strict() schema) — proves a poisoned dispatch-path label at creation is structurally impossible, not just caught after the fact", () => {
  const text = sapwoodResult({ issues: [{ title: "t", labels: ["plan:approved"] }] }, issueSegment(PLAN_BODY));
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /schema validation/.test(result.reason));
});

test("validateAlignOutput (Codex round 1): duplicate titles in one batch -> fail-closed, rejected whole (would double-create the same issue)", () => {
  const result = validateAlignOutput(
    alignResultText([
      { title: "Add X", body: "Body one." },
      { title: "Add X", body: "Body two." },
    ]),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /duplicate issue title/.test(result.reason));
});

test("validateAlignOutput: empty issues array with a stray BODY block present -> fail-closed", () => {
  const text = sapwoodResult({ issues: [] }, "unexpected body text");
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
});

test("validateAlignOutput: issues declared but no BODY block at all -> fail-closed", () => {
  const text = sapwoodResult({ issues: [{ title: "t" }] });
  const result = validateAlignOutput(text);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /BODY block/.test(result.reason));
});

test("validateAlignOutput: well-formed empty declaration -> ok, empty array", () => {
  const result = validateAlignOutput(alignResultText([]));
  assert.ok(result.ok && result.issues.length === 0);
});

test("validateAlignOutput: well-formed multi-issue declaration -> ok, titles and bodies paired in order", () => {
  const result = validateAlignOutput(
    alignResultText([
      { title: "first", body: "Body one.\n\n_Origin: static scan_" },
      { title: "second", body: "Body two.\n\n_Origin: static scan_" },
    ]),
  );
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.issues, [
      { title: "first", body: "Body one.\n\n_Origin: static scan_" },
      { title: "second", body: "Body two.\n\n_Origin: static scan_" },
    ]);
  }
});

// ── #442: the Origin evidence line is required of every agent-filed body ─────────────────────

test("#442 AC1: a proposal body with no `Origin:` line fails align's own output validation — the same channel that already rejects a malformed BODY segment", () => {
  const result = validateAlignOutput(alignResultText([{ title: "Add X", body: "Body.\n## Verification\n- run npm test" }]));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /Origin:/.test(result.reason), `reason names the missing line: ${!result.ok ? result.reason : ""}`);
});

test("#442 AC1: one Origin-less body among several rejects the WHOLE batch, and the reason names which segment", () => {
  const result = validateAlignOutput(
    alignResultText([
      { title: "first", body: PLAN_BODY },
      { title: "second", body: "Body two, no provenance." },
    ]),
  );
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /issue 2\b/.test(result.reason), `reason names the 1-based segment: ${!result.ok ? result.reason : ""}`);
});

test("#442 AC1: `Origin: static scan` — the literal the template names for a repo-reading finding — satisfies the requirement", () => {
  const result = validateAlignOutput(alignResultText([{ title: "Add X", body: "Body.\n## Verification\n- x\n\n_Origin: static scan_" }]));
  assert.ok(result.ok);
});

test("#442 AC1: an empty issues array carries no bodies, so the Origin requirement cannot make a zero-proposal round invalid", () => {
  assert.ok(validateAlignOutput(alignResultText([])).ok);
});

test("#442 AC2 grep-invariant (engine-wide): `extractOrigin` has exactly ONE production call site — align.ts's output validator, which checks PRESENCE — and no other engine module reads the line at all. Origin is human triage prose (F15: a role's self-report is not a machine anchor); the day it becomes a dedupe/routing input, this test is what says so out loud", () => {
  const srcDir = new URL("../", import.meta.url);
  const files = readdirSync(srcDir, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  assert.ok(files.includes("loop/align.ts") && files.includes("forge/forge.ts"), "sanity: the two known modules are in the scan set");
  const callers = files.filter((f) => f !== "forge/forge.ts" && /\bextractOrigin\(/.test(readFileSync(new URL(f, srcDir), "utf8")));
  assert.deepEqual(callers.sort(), ["loop/align.ts"], "extractOrigin has no consumer beyond align's validator");
  const alignSrc = readFileSync(new URL("loop/align.ts", srcDir), "utf8");
  assert.equal((alignSrc.match(/\bextractOrigin\(/g) ?? []).length, 1, "one call, not a second one that reads the text");
  assert.match(alignSrc, /extractOrigin\([^)]*\) == null/, "the single call is a null/presence check, never a read of what the line SAYS");
});

test("validateTriageOutput: missing body -> fail-closed", () => {
  const text = sapwoodResult({ issue: 1 });
  const result = validateTriageOutput(text, 1);
  assert.equal(result.ok, false);
});

test("validateTriageOutput: issue number mismatch -> fail-closed", () => {
  const text = triageResultText(999, PLAN_BODY);
  const result = validateTriageOutput(text, 1);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /mismatch/.test(result.reason));
});

test("validateTriageOutput: well-formed draft, EVEN with no verification plan, is schema-ok (content is checked separately by the caller)", () => {
  const text = triageResultText(1, NO_PLAN_BODY);
  const result = validateTriageOutput(text, 1);
  assert.ok(result.ok);
});

test("validateTriageOutput: well-formed draft -> ok, returns the body verbatim", () => {
  const text = triageResultText(1, PLAN_BODY);
  const result = validateTriageOutput(text, 1);
  assert.ok(result.ok && result.body === PLAN_BODY);
});

// ── #212: selectRoundPool ────────────────────────────────────────────────────────────────────

const mkReady = (number: number, prio: number, milestone?: string): Issue => ({
  number,
  title: `issue ${number}`,
  labels: [`sapwood:prio:${prio}`],
  ...(milestone !== undefined ? { milestone } : {}),
});

test("selectRoundPool: caps the pool at ceil(lanes.roundDispatchCap * round.poolFactor)", async () => {
  const forge = new FakeForge();
  forge.ready = [1, 2, 3, 4, 5].map((n) => mkReady(n, 3));
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1.5 } }); // cap = ceil(3) = 3
  const selected = await selectRoundPool({ forge, cfg });
  assert.equal(selected.length, 3, "exactly ceil(2 * 1.5) = 3 issues selected");
  assert.deepEqual(
    selected.map((i) => i.number),
    [1, 2, 3],
  );
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 2, 3],
  );
  assert.ok(
    forge.addLabelCalls.every(([, l]) => l === cfg.labels.roundPool),
    "only the pool label is ever applied",
  );
  assert.equal(forge.issueLabels[4], undefined, "issue #4 (past the cap) was never labelled");
});

test("selectRoundPool: orders by prio label ascending (prio:0 first) then issue number ascending", async () => {
  const forge = new FakeForge();
  forge.ready = [mkReady(30, 2), mkReady(10, 0), mkReady(20, 0), mkReady(40, 1)];
  const cfg = mkCfg({ lanes: { max: 10, roundDispatchCap: 10 }, round: { poolFactor: 1 } }); // cap = 10, everyone fits
  const selected = await selectRoundPool({ forge, cfg });
  assert.deepEqual(
    selected.map((i) => i.number),
    [10, 20, 40, 30],
    "prio:0 (10 then 20 by number) -> prio:1 (40) -> prio:2 (30)",
  );
});

test("selectRoundPool: milestone-scoped when the caller passes an already-scoped forge (RoundScopedForge) — never re-derives scoping itself", async () => {
  const forge = new FakeForge();
  forge.ready = [mkReady(1, 0, "M4"), mkReady(2, 0), mkReady(3, 0, "M4"), mkReady(4, 0, "M5")];
  const scoped = new RoundScopedForge(forge, "M4");
  const cfg = mkCfg({ lanes: { max: 10, roundDispatchCap: 10 }, round: { poolFactor: 1, milestone: "M4" } });
  const selected = await selectRoundPool({ forge: scoped, cfg });
  assert.deepEqual(
    selected.map((i) => i.number),
    [1, 3],
    "only the M4-milestone issues were selected",
  );
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 3],
  );
});

test("selectRoundPool: idempotent — an already-pool-labelled issue is not re-labelled (crash-rerun safety)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 10, roundDispatchCap: 10 }, round: { poolFactor: 1 } });
  forge.ready = [{ number: 1, title: "a", labels: [cfg.labels.roundPool] }, mkReady(2, 3)];
  const selected = await selectRoundPool({ forge, cfg });
  assert.equal(selected.length, 2, "both issues are still part of the selection");
  assert.deepEqual(forge.addLabelCalls, [[2, cfg.labels.roundPool]], "issue #1 was already labelled — no redundant write");
});

test("selectRoundPool: a pool-eligible read failure degrades to an empty pool (logged, never thrown)", async () => {
  const cfg = mkCfg();
  const logged: string[] = [];
  const forge = new (class extends FakeForge {
    override async getPoolEligibleIssues(): Promise<Issue[]> {
      throw new Error("simulated forge outage");
    }
  })();
  const selected = await selectRoundPool({ forge, cfg, log: (m) => logged.push(m) });
  assert.deepEqual(selected, []);
  assert.equal(forge.addLabelCalls.length, 0);
  assert.ok(logged.some((l) => l.includes("simulated forge outage")));
});

// ── #212/#233 gate① F1: runPoolSelection — the PO's OWN, now OPT-IN, pool-selection session ────

/** A po-pool session's structured output: the selected issue numbers only, no BODY block. */
const poolResultText = (selected: number[]): string => sapwoodResult({ selected });

test("runPoolSelection (#233 AC1): the deterministic DEFAULT path (roles.po.poolSelection=false) still writes the durable pool-selected event, even though no session ran", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2, poolSelection defaults false
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(3, 3)];
  const runner = new ScriptedRunner([]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 3 });
  assert.equal(runner.calls.length, 0, "no session ran on the deterministic default path");
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
  );
  const events = state.eventsAfterId(0, ["pool-selected"]);
  assert.equal(events.length, 1, "the durable event is written even though selection was purely deterministic (#233 AC1)");
  assert.deepEqual(events[0]!.payload, { round_id: 3, issues: [1, 2] }, "the event records exactly what was acted on");
});

test("runPoolSelection (#233 AC1 mirror): the opt-in SESSION path (roles.po.poolSelection=true) also writes the durable pool-selected event, recording the validated selection", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 4 });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
  );
  const events = state.eventsAfterId(0, ["pool-selected"]);
  assert.equal(events.length, 1, "the durable event is written on the session path too");
  assert.deepEqual(
    events[0]!.payload,
    { round_id: 4, issues: [1] },
    "the event records the session's validated (proper subset) selection, not the full candidate set",
  );
});

test("runPoolSelection #232: a pool-selected append failure aborts label effects entirely (fail-closed) — no addLabel calls, a durable pool-selection-decision-lost honesty event + tick-error, round never wedged (empty return)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // deterministic default path
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  const state = new State(":memory:");
  const logged = tapAndPoisonEvents(state, "pool-selected");
  const runner = new ScriptedRunner([]);
  const target = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 9 });
  assert.equal(runner.calls.length, 0, "still no session on the deterministic default path");
  assert.equal(forge.addLabelCalls.length, 0, "no label effects — the decision never durably landed (#232 fail-closed)");
  assert.deepEqual(
    target.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
    "the target is still computed/returned — only the LABEL EFFECTS are skipped",
  );
  assert.ok(
    logged.some(([kind]) => kind === "pool-selection-decision-lost"),
    "a durable honesty event records the loss",
  );
  assert.ok(logged.some(([kind]) => kind === "tick-error"));
  state.close();
});

test("runPoolSelection #232: a pool-selected append failure on the SESSION path also aborts label effects — no addLabel calls even though the session validated a real subset", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const logged = tapAndPoisonEvents(state, "pool-selected");
  await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 10 });
  assert.equal(forge.addLabelCalls.length, 0, "the validated session selection is never labelled — the decision write failed");
  assert.ok(logged.some(([kind]) => kind === "pool-selection-decision-lost"));
  assert.ok(logged.some(([kind]) => kind === "tick-error"));
  state.close();
});

test("runPoolSelection #231: the session path records an input-manifest row for the pool-candidates channel; the deterministic default path does not (no session, nothing to record)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 4 });
  const manifest = state.inputManifestRows(4);
  const row = manifest.find((r) => r.channel === "pool-candidates");
  assert.ok(row);
  assert.equal(row!.session, "po-pool");
  assert.equal(row!.attempt, 1);
  assert.equal(row!.ok, true);
  assert.equal(row!.total, 2);
  assert.equal(row!.rendered, 2);
  assert.equal(row!.truncated, false);
  state.close();

  // The deterministic default path (poolSelection=false, the #233 main path) never dispatches
  // a session, so it never shows a candidate digest to anything — no manifest row to write.
  const forge2 = new FakeForge();
  forge2.ready = [mkReady(1, 3)];
  const state2 = new State(":memory:");
  await runPoolSelection({ now: realClock, forge: forge2, cfg: mkCfg(), state: state2, runner: new ScriptedRunner([]), roundId: 5 });
  assert.equal(state2.inputManifestRows(5).length, 0);
  state2.close();
});

test("runPoolSelection #231 gate② F2: the pool-candidates manifest version hashes the RENDERED digest text, not just candidate numbers — a title-only edit (same numbers) changes it", async () => {
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2

  const forgeA = new FakeForge();
  forgeA.ready = [{ number: 1, title: "Original title", labels: ["sapwood:prio:3"] }];
  const stateA = new State(":memory:");
  await runPoolSelection({
    now: realClock,
    forge: forgeA,
    cfg,
    state: stateA,
    runner: new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]),
    roundId: 1,
  });
  const versionA = stateA.inputManifestRows(1).find((r) => r.channel === "pool-candidates")!.version;
  stateA.close();

  const forgeB = new FakeForge();
  forgeB.ready = [{ number: 1, title: "A completely different title", labels: ["sapwood:prio:3"] }]; // SAME candidate number, different title
  const stateB = new State(":memory:");
  await runPoolSelection({
    now: realClock,
    forge: forgeB,
    cfg,
    state: stateB,
    runner: new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]),
    roundId: 1,
  });
  const versionB = stateB.inputManifestRows(1).find((r) => r.channel === "pool-candidates")!.version;
  stateB.close();

  assert.ok(versionA && versionB);
  assert.notEqual(versionA, versionB, "title drift with the SAME candidate number must still change the recorded version");
});

test("runPoolSelection: roles.po.poolSelection=true — a fake runner's selection is validated and the engine applies labels to EXACTLY that subset, never the full candidate set", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({
    roles: { po: { poolSelection: true } },
    lanes: { max: 3, roundDispatchCap: 2 },
    round: { poolFactor: 1.5 },
  }); // cap = 3
  forge.ready = [1, 2, 3, 4, 5].map((n) => mkReady(n, 3));
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1, 3]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [1, 3],
    "only the session's validated selection, a proper subset of the 3-issue candidate set",
  );
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 3],
    "labels applied to exactly the selected subset — never #2 (a candidate, but not selected) and never #4/#5 (outside the cap)",
  );
  assert.equal(runner.calls.length, 1, "exactly one po-pool session — a valid first attempt needs no retry");
  const call = runner.calls[0]!;
  assert.equal(call.roleId, "po-pool");
  assert.equal(call.allowedTools, PO_ALLOWED_TOOLS, "zero gh grants — same containment as align/triage");
  assert.equal(call.disallowedTools, PO_DISALLOWED_TOOLS);
  assert.match(call.prompt, /#1 —/);
  assert.match(call.prompt, /#3 —/);
  assert.doesNotMatch(call.prompt, /#4 —/, "the candidate digest itself is already cap-bounded — #4 was never even shown");
});

test("runPoolSelection: an out-of-bounds selection (an issue number outside the candidate list) is invalid, retried once, then degrades OPEN to the full deterministic candidate set", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(999, 3)]; // #999 past the cap, never a candidate
  const badSelection = poolResultText([1, 999]); // #999 is not in the candidate list
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", badSelection), doneResult("role-po-pool-2", badSelection)]);
  const state = new State(":memory:");
  const events = tapEvents(state);
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 7 });
  assert.equal(runner.calls.length, 2, "retried exactly once before degrading");
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
    "degraded to the FULL deterministic candidate set (the top-cap Ready issues), not an empty pool",
  );
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [1, 2],
  );
  const degraded = events.find(([kind]) => kind === "pool-degraded");
  assert.ok(degraded, "a durable honesty event was recorded");
  assert.equal((degraded![1] as { round_id: number }).round_id, 7);
});

test("runPoolSelection: an over-cap selection (more issues than the candidate list itself) is invalid the same way", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } }); // cap = 2
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  // Candidates are exactly [1, 2] (cap 2) — a session claiming BOTH plus a duplicate exceeds
  // what schema+bound validation allows (len > cap after a would-be dedupe is still invalid;
  // here it's a straightforward "more than exists" case via an out-of-range extra number).
  const overCap = poolResultText([1, 2, 3]);
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", overCap), doneResult("role-po-pool-2", overCap)]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 2);
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
    "degraded to the deterministic candidate set",
  );
});

test("runPoolSelection: default config (roles.po.poolSelection unset -> false) -> the deterministic path directly, no session dispatched at all, even with roles.po.enabled left at its true default (#233)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  assert.equal(cfg.roles.po.poolSelection, false, "sanity: the #233 default");
  assert.equal(cfg.roles.po.enabled, true, "sanity: align/triage stay on by default — irrelevant to pool selection now");
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(3, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 0, "poolSelection is off by default — no session, not even an attempt");
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
    "the full deterministic top-cap candidate set — the #233 default MAIN path, not a fallback",
  );
});

test("runPoolSelection: roles.po.enabled=false -> pool selection is UNAFFECTED — still the deterministic path (poolSelection defaults false too)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { enabled: false } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(3, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 0, "poolSelection defaults false regardless of roles.po.enabled — no session");
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [1, 2],
    "the full deterministic top-cap candidate set",
  );
});

test("runPoolSelection: roles.po.enabled=false AND roles.po.poolSelection=true -> the session STILL runs (#233 decoupling — pool selection no longer depends on roles.po.enabled at all)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({
    roles: { po: { enabled: false, poolSelection: true } },
    lanes: { max: 3, roundDispatchCap: 2 },
    round: { poolFactor: 1 },
  });
  forge.ready = [mkReady(1, 3), mkReady(2, 3), mkReady(3, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 1, "poolSelection=true dispatches a session even with align/triage (roles.po.enabled) off");
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
    "the session's validated (proper subset) selection, not the full candidate set",
  );
});

test("runPoolSelection: zero Ready candidates -> no session dispatched (nothing to choose from), empty selection", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  forge.ready = [];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(selected, []);
});

test("runPoolSelection: roles.po.poolSelection=true with zero Ready candidates -> still no session dispatched (nothing to choose from), empty selection", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } } });
  forge.ready = [];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 0, "zero candidates short-circuits before a session would ever be dispatched");
  assert.deepEqual(selected, []);
});

test("runPoolSelection (gate② r2): replay path — a persisted pool-selected event is replayed verbatim, no session dispatched even though roles.po.poolSelection=true, no adopt-existing heuristic involved", async () => {
  const forge = new FakeForge();
  // Codex review (P2): with poolSelection left at its #233 default (false), "no session
  // dispatched" is trivially true regardless of replay — it would pass even if replay were
  // broken. poolSelection: true here is what makes this test actually PROVE replay suppresses
  // an OPTED-IN session, not just the deterministic default's own already-no-session behavior.
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  // Ready still shows fresh candidates as the backlog stands NOW — but a durable pool-selected
  // event from a PRIOR (crashed) attempt this round already recorded a decision. Replay must
  // win over a fresh session: a fresh session's own selection could differ (LLM nondeterminism)
  // from what the crashed attempt already decided, and reconciling to a NEW decision would
  // fight the durable record instead of finishing what it started.
  forge.ready = [mkReady(5, 3), mkReady(6, 3)];
  forge.backlogIssues = [{ number: 9, title: "the persisted target", labels: [cfg.labels.roundPool] }];
  const state = new State(":memory:");
  state.appendEvent("pool-selected", { round_id: 1, issues: [9] });
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([5]))]);
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [9],
    "the event's target, never a fresh selection over current Ready",
  );
  assert.equal(runner.calls.length, 0, "no session dispatched — the persisted event was replayed, suppressing the opted-in session");
  assert.deepEqual(forge.addLabelCalls, [], "already labelled — reconcile's idempotent add-skip, no redundant write");
  assert.deepEqual(forge.removeLabelCalls, [], "nothing else carries the pool label — nothing to heal here");
});

test("runPoolSelection (gate② r2): crash window — the event is persisted but ZERO labels landed before the crash (right after the event write); rerun reconciles the FULL target, still no session even though roles.po.poolSelection=true", async () => {
  const forge = new FakeForge();
  // Same Codex P2 rationale as the replay-path test above: poolSelection: true so "still no
  // session" actually demonstrates replay winning over an opted-in session, not just the
  // deterministic default's own vacuous absence of one.
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 3 }, round: { poolFactor: 1 } });
  forge.ready = [];
  forge.backlogIssues = [
    { number: 9, title: "target, not yet labelled", labels: [] },
    { number: 10, title: "also target, not yet labelled", labels: [] },
  ];
  const state = new State(":memory:");
  state.appendEvent("pool-selected", { round_id: 1, issues: [9, 10] });
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([]))]);
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number).sort((a, b) => a - b),
    [9, 10],
  );
  assert.equal(
    runner.calls.length,
    0,
    "no session — the crash-window rerun replays the persisted target, suppressing the opted-in session",
  );
  assert.deepEqual(
    forge.addLabelCalls.map(([n]) => n).sort((a, b) => a - b),
    [9, 10],
    "the crashed attempt never got to label either issue — reconcile finishes the job on rerun",
  );
});

test("runPoolSelection (gate② r2): residual healing (session path, roles.po.poolSelection=true) — an open issue carrying a STALE pool label that is NOT part of this round's target has it removed during selection", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 1 }, round: { poolFactor: 1 } }); // cap = 1
  forge.ready = [mkReady(1, 3)];
  forge.backlogIssues = [
    { number: 1, title: "candidate", labels: [] },
    { number: 99, title: "stale residual — not a candidate this round", labels: [cfg.labels.roundPool] },
  ];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.equal(runner.calls.length, 1, "poolSelection=true actually exercises the session path this test is named for");
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
  );
  assert.deepEqual(forge.removeLabelCalls, [[99, cfg.labels.roundPool]], "the stray residual's label was removed, never left dangling");
});

test("runPoolSelection (gate② r2): residual healing on the DEFAULT deterministic path too — roles.po.poolSelection=false (independent of roles.po.enabled) still clears a stray pool label from a non-candidate open issue", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { enabled: false } }, lanes: { max: 3, roundDispatchCap: 1 }, round: { poolFactor: 1 } });
  forge.ready = [mkReady(1, 3)];
  forge.backlogIssues = [
    { number: 1, title: "candidate", labels: [] },
    { number: 99, title: "stale residual", labels: [cfg.labels.roundPool] },
  ];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
  );
  assert.equal(runner.calls.length, 0, "poolSelection defaults false — no session, ever, regardless of roles.po.enabled");
  assert.deepEqual(forge.removeLabelCalls, [[99, cfg.labels.roundPool]]);
});

// ── #212 gate② r3 ────────────────────────────────────────────────────────────────────────────

test("runPoolSelection (gate② r3 finding 1): a reconcile REMOVAL failure stays degrade-open — a durable pool-reconcile-incomplete event is appended, the phase still completes (never a retry loop over a prioritization mechanism)", async () => {
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 1 }, round: { poolFactor: 1 } }); // cap = 1
  const forge = new (class extends FakeForge {
    override async removeLabel(n: number, l: string): Promise<void> {
      if (n === 99) throw new Error("simulated forge failure removing #99");
      await super.removeLabel(n, l);
    }
  })();
  forge.ready = [mkReady(1, 3)];
  forge.backlogIssues = [
    { number: 1, title: "candidate", labels: [] },
    { number: 99, title: "stale residual whose removal will fail", labels: [cfg.labels.roundPool] },
  ];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const events = tapEvents(state);
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 }); // must NOT throw
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
    "the phase's own target still resolved correctly",
  );
  const incomplete = events.find(([kind]) => kind === "pool-reconcile-incomplete");
  assert.ok(incomplete, "a durable honesty event was recorded");
  assert.deepEqual(incomplete![1], { round_id: 1, failed_issues: [99] });
});

test("runPoolSelection (gate② r3 finding 1): a listOpenIssues read failure during reconcile also stays degrade-open, with a read_failed honesty event — never a throw", async () => {
  const cfg = mkCfg({ lanes: { max: 3, roundDispatchCap: 1 }, round: { poolFactor: 1 } });
  const forge = new (class extends FakeForge {
    override async listOpenIssues(): Promise<Issue[]> {
      throw new Error("simulated open-backlog read failure");
    }
  })();
  forge.ready = [mkReady(1, 3)];
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([1]))]);
  const state = new State(":memory:");
  const events = tapEvents(state);
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [1],
    "the ADD side still succeeded — only the REMOVE side's read failed",
  );
  const incomplete = events.find(([kind]) => kind === "pool-reconcile-incomplete");
  assert.ok(incomplete);
  assert.deepEqual(incomplete![1], { round_id: 1, read_failed: true });
});

test("runPoolSelection (gate② r3 finding 3): two pool-selected events for the same round — the LAST one wins, replayed verbatim, no session even though roles.po.poolSelection=true", async () => {
  const forge = new FakeForge();
  // Codex P2: poolSelection: true, same rationale as the replay-path/crash-window tests above —
  // otherwise "no session" is trivially true under the #233 default and proves nothing about
  // replay actually suppressing an opted-in session.
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  forge.ready = [];
  forge.backlogIssues = [
    { number: 1, title: "first event's target (stale)", labels: [] },
    { number: 2, title: "second (LAST) event's target", labels: [] },
  ];
  const state = new State(":memory:");
  state.appendEvent("pool-selected", { round_id: 1, issues: [1] });
  state.appendEvent("pool-selected", { round_id: 1, issues: [2] });
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([]))]);
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [2],
    "the LAST event's target, not the first",
  );
  assert.equal(runner.calls.length, 0, "no session — replay wins over recompute, suppressing the opted-in session");
});

test("runPoolSelection (gate② r3 finding 3): the LAST pool-selected event for this round is malformed — treated as absent (fresh compute), never a throw; growth stops at one extra append", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { po: { poolSelection: true } }, lanes: { max: 3, roundDispatchCap: 2 }, round: { poolFactor: 1 } });
  forge.ready = [mkReady(5, 3)];
  const state = new State(":memory:");
  state.appendEvent("pool-selected", { round_id: 1, issues: [9] }); // an earlier, well-formed event
  state.appendEvent("pool-selected", { round_id: 1, malformed: true }); // the LAST one — fails the schema
  const runner = new ScriptedRunner([doneResult("role-po-pool-1", poolResultText([5]))]);
  const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 1 });
  assert.deepEqual(
    selected.map((i) => i.number),
    [5],
    "a fresh session ran over the current Ready backlog",
  );
  assert.equal(runner.calls.length, 1, "no replay — the malformed LAST event reads as absent, never a throw");
});

test("applyPoolLabels (gate② P2-4, via selectRoundPool): every label write failing for a non-empty selection THROWS — never silently returns as though the pool were correctly empty", async () => {
  const cfg = mkCfg();
  const forge = new (class extends FakeForge {
    override async addLabel(): Promise<void> {
      throw new Error("simulated forge failure");
    }
  })();
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  await assert.rejects(() => selectRoundPool({ forge, cfg }), /ALL 2 label write\(s\) failed/);
});

test("#379 F2 runPoolSelection: every label write failing PARKS the round — contained, one durable pool-labels-failed event, never a thrown phase (which exited the process)", async () => {
  const cfg = mkCfg();
  const forge = new (class extends FakeForge {
    override async addLabel(): Promise<void> {
      throw new Error("simulated forge failure");
    }
  })();
  forge.ready = [mkReady(1, 3), mkReady(2, 3)];
  const state = new State(":memory:");
  const runner = new ScriptedRunner([]);
  const logs: string[] = [];
  try {
    const selected = await runPoolSelection({ now: realClock, forge, cfg, state, runner, roundId: 4, log: (line) => logs.push(line) });
    assert.deepEqual(selected, [], "nothing landed in the pool, so nothing is dispatchable this round — the round parks");
    const events = state.eventsSince("1970-01-01T00:00:00.000Z", ["pool-labels-failed"]);
    assert.equal(events.length, 1);
    assert.deepEqual((events[0]!.payload as { round_id: number; attempted: number }).round_id, 4);
    assert.deepEqual((events[0]!.payload as { round_id: number; attempted: number }).attempted, 2);
    assert.ok(logs.some((line) => /ALL 2 label write\(s\) failed/.test(line)));
  } finally {
    state.close();
  }
});

test("applyPoolLabels (gate② P2-4): a validly EMPTY selection (zero candidates) never throws — 'select/have nothing' is a legitimate outcome, not a failure", async () => {
  const cfg = mkCfg();
  const forge = new FakeForge();
  forge.ready = [];
  const selected = await selectRoundPool({ forge, cfg });
  assert.deepEqual(selected, []);
});

test("validatePoolSelectionOutput: a valid proper subset of the candidate list is ok", () => {
  const result = validatePoolSelectionOutput(poolResultText([2, 5]), [1, 2, 5, 9], 3);
  assert.ok(result.ok);
  if (result.ok)
    assert.deepEqual(
      result.selected.sort((a, b) => a - b),
      [2, 5],
    );
});

test("validatePoolSelectionOutput: an empty selection is a valid, complete outcome", () => {
  const result = validatePoolSelectionOutput(poolResultText([]), [1, 2, 3], 3);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.selected, []);
});

test("validatePoolSelectionOutput: a selected number outside the candidate list -> fail-closed", () => {
  const result = validatePoolSelectionOutput(poolResultText([1, 42]), [1, 2, 3], 3);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /not in the candidate list/.test(result.reason));
});

test("validatePoolSelectionOutput: a selection longer than the cap -> fail-closed even if every number is a real candidate", () => {
  const result = validatePoolSelectionOutput(poolResultText([1, 2, 3]), [1, 2, 3, 4, 5], 2);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /exceeding the cap/.test(result.reason));
});

test("validatePoolSelectionOutput: a duplicate issue number in the selection -> fail-closed", () => {
  const result = validatePoolSelectionOutput(poolResultText([1, 1]), [1, 2, 3], 3);
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /duplicate/.test(result.reason));
});

test("validatePoolSelectionOutput: no structured output block -> fail-closed", () => {
  const result = validatePoolSelectionOutput("no sentinel here", [1, 2, 3], 3);
  assert.equal(result.ok, false);
});

test("defaultPoolPromptPath resolves to a real, readable shipped file with a selected-numbers structured-output example", () => {
  const path = defaultPoolPromptPath();
  assert.ok(existsSync(path));
  const text = readFileSync(path, "utf8");
  assert.match(text, /selected/);
});

// ── #237: PO dissent channel — concerns alongside align/triage deliverables ─────────────────

test("validateAlignOutput #237: a concern about an in-view issue validates alongside the normal deliverable", () => {
  const result = validateAlignOutput(
    sapwoodResult({ issues: [], concerns: [{ issue: 42, reason: "premise seems wrong" }] }),
    new Set([42]),
  );
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.concerns, [{ issue: 42, reason: "premise seems wrong" }]);
});

test("validateAlignOutput #237: a concern naming an issue outside the injected view is invalid output", () => {
  const result = validateAlignOutput(sapwoodResult({ issues: [], concerns: [{ issue: 999, reason: "x" }] }), new Set([42]));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /outside this session's injected view/.test(result.reason));
});

test("validateAlignOutput #237: `inView` omitted skips the bounds check entirely (back-compat for existing call sites)", () => {
  const result = validateAlignOutput(sapwoodResult({ issues: [], concerns: [{ issue: 999, reason: "x" }] }));
  assert.ok(result.ok);
});

test("validateTriageOutput #237: a concern about the target issue itself validates", () => {
  const result = validateTriageOutput(sapwoodResult({ issue: 1, concerns: [{ issue: 1, reason: "x" }] }, PLAN_BODY), 1, new Set([1]));
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.concerns, [{ issue: 1, reason: "x" }]);
});

test("validateTriageOutput #237: a concern about an issue outside the injected view is invalid output", () => {
  const result = validateTriageOutput(sapwoodResult({ issue: 1, concerns: [{ issue: 2, reason: "x" }] }, PLAN_BODY), 1, new Set([1]));
  assert.equal(result.ok, false);
  assert.ok(!result.ok && /outside this session's injected view/.test(result.reason));
});

test("createAligningStub #237: an align-mode concern about an existing backlog issue is posted, mentions notify.mentions, and carries the marker — zero label/status effects", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [{ number: 42, title: "Existing issue", labels: [], body: "original body" }];
  forge.issueBodies[42] = "original body";
  const cfg = mkCfg({ notify: { mentions: ["alice"] } });
  const runner = new ScriptedRunner([
    doneResult("po-align-1", sapwoodResult({ issues: [], concerns: [{ issue: 42, reason: "this contradicts the goal file" }] })),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });

  assert.equal(forge.comments[42]?.length, 1);
  const body = forge.comments[42]![0]!.body;
  assert.match(body, /@alice/);
  assert.match(body, /this contradicts the goal file/);
  // Zero label/status/dispatch effects from the concern itself (module doc, #237 AC3) — the
  // concern targets an EXISTING issue no proposal/triage write path ever touches.
  assert.deepEqual(
    forge.addLabelCalls.filter(([n]) => n === 42),
    [],
  );
  state.close();
});

test("createAligningStub #237: a concern naming an issue outside the injected view invalidates the WHOLE session output — retried once, then po-degraded (existing degrade path, no new machinery)", async () => {
  const forge = new FakeForge(); // empty backlog -> nothing is in view
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", sapwoodResult({ issues: [], concerns: [{ issue: 999, reason: "x" }] })),
    doneResult("po-align-2", sapwoodResult({ issues: [], concerns: [{ issue: 999, reason: "x" }] })),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });

  assert.equal(runner.calls.length, 2, "retried once on invalid output");
  const degraded = logged.find(([kind]) => kind === "po-degraded");
  assert.ok(degraded, "the existing po-degraded path fires — no new degrade machinery");
  assert.equal(Object.keys(forge.comments).length, 0, "no concern posted from invalid output");
  state.close();
});

test("createAligningStub #237: the SAME worded concern re-arms after a human edits the concerned issue's why/what (AC5 fixture, via the real stub wiring)", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [{ number: 42, title: "Existing issue", labels: [], body: "original body" }];
  forge.issueBodies[42] = "original body";
  const cfg = mkCfg();
  const concernOutput = sapwoodResult({ issues: [], concerns: [{ issue: 42, reason: "same worded concern" }] });
  const runner = new ScriptedRunner([doneResult("po-align-1", concernOutput)]);
  const state = new State(":memory:");
  const stub1 = createAligningStub({ now: realClock, forge, state, cfg, runner });
  await stub1.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(forge.comments[42]?.length, 1);

  // A different round raises the EXACT SAME worded concern with NO edit in between — no repost.
  const runnerSame = new ScriptedRunner([doneResult("po-align-2", concernOutput)]);
  const stub2 = createAligningStub({ now: realClock, forge, state, cfg, runner: runnerSame });
  await stub2.run({ roundId: 2, phase: "aligning", marker: null });
  assert.equal(forge.comments[42]?.length, 1, "no repost — same wording, same (unedited) body");

  // A human edits the issue's why/what.
  forge.issueBodies[42] = "EDITED body";
  forge.backlogIssues = [{ number: 42, title: "Existing issue", labels: [], body: "EDITED body" }];
  const runnerAfterEdit = new ScriptedRunner([doneResult("po-align-3", concernOutput)]);
  const stub3 = createAligningStub({ now: realClock, forge, state, cfg, runner: runnerAfterEdit });
  await stub3.run({ roundId: 3, phase: "aligning", marker: null });
  assert.equal(forge.comments[42]?.length, 2, "the same worded concern re-arms once the issue's body changed");
  state.close();
});

test("createAligningStub #237: crash-rerun replay recovers a previously-validated align concern (persisted alongside the proposal set, no session re-dispatched)", async () => {
  const forge = new FakeForge();
  forge.backlogIssues = [{ number: 42, title: "Existing issue", labels: [], body: "body" }];
  forge.issueBodies[42] = "body";
  const cfg = mkCfg();
  const state = new State(":memory:");
  // Simulate a round whose proposal set (with a concern) was already persisted by a prior
  // (crashed) attempt — proposalProgress replays it, no fresh po-align session runs.
  state.appendEvent("proposal-set-persisted", {
    round_id: 5,
    proposals: [],
    concerns: [{ issue: 42, reason: "recovered concern" }],
  });
  const runner = new ScriptedRunner([doneResult("po-align-should-not-run", sapwoodResult({ issues: [] }))]);
  const deps: AlignDeps = { now: realClock, forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 5, phase: "aligning", marker: null });

  assert.equal(runner.calls.length, 0, "no fresh po-align session — the persisted set (and its concerns) replayed directly");
  assert.equal(forge.comments[42]?.length, 1);
  assert.match(forge.comments[42]![0]!.body, /recovered concern/);
  state.close();
});
