// round-defaults.test.ts (#104): createDefaultPeripherals — the factory that wires the REAL
// role-session stubs (aligning/architecting/plan_review/harvesting/retro) into runRounds's
// `peripherals` map. Two levels: (1) a structural check that the returned map carries all five
// phases and none of them is noopPeripheralStub; (2) an integration test — the SAME "fake the
// collaborator, not the CLI" split every other peripheral test file uses — proving a runRounds
// invocation wired with this factory's output actually dispatches all five real role sessions
// (no noop remains in the shipped default map, #104's acceptance criterion).
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import { State } from "../state/state.js";
import { BODY_BLOCK_END, BODY_BLOCK_START, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import type { LaneProbe, Supervisor } from "./conductor.js";
import { concernHash } from "./dissent.js";
import { noopPeripheralStub, type RoundDeps, runRounds } from "./round.js";
import { buildRoundArtifact, persistRoundArtifact } from "./round-artifact.js";
import { createDefaultPeripherals, renderAlignedGoalsFromSummary, renderLastMergedFromArtifact } from "./round-defaults.js";

// #231: createAligningStub now treats an unreadable goal file as an EXPLICIT align-creation
// failure (no session dispatched) rather than the pre-#231 silent "" — every test here that
// expects a real po-align session dispatch needs a REAL, readable default goal file.
const DEFAULT_TEST_GOAL_DIR = mkdtempSync(join(tmpdir(), "sapwood-round-defaults-goal-"));
const DEFAULT_TEST_GOAL_FILE = join(DEFAULT_TEST_GOAL_DIR, "PLAN.md");
writeFileSync(DEFAULT_TEST_GOAL_FILE, "# Test goal\nHarmless default content for tests that don't care about plan.md.\n");
after(() => rmSync(DEFAULT_TEST_GOAL_DIR, { recursive: true, force: true }));

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    goal: { file: DEFAULT_TEST_GOAL_FILE },
    ...over,
  });

class FakeForge implements IForge {
  async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  planReviewCandidates: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  issueCommentsPosted: Array<[number, string]> = [];
  openIssueNumbers: number[] = [];

  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  ready: Issue[] = [];
  async getReadyIssues(): Promise<Issue[]> {
    return this.ready;
  }
  // #214: aliases the same `ready` backing array — this file's pool-digest/pool-selection tests
  // use `ready` (+ cfg.labels.roundPool on the fixture issues) as the widened pool-eligible set
  // too; none of them are testing gate⓪'s narrower-vs-wider distinction specifically (that's
  // plan-review.test.ts's job).
  async getPoolEligibleIssues(): Promise<Issue[]> {
    return this.ready;
  }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addSubIssue(): Promise<void> {
    throw new Error("FakeForge.addSubIssue is not used by this test");
  }
  async getSubIssues() {
    return [];
  }
  async addLabel(n: number, l: string): Promise<void> {
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  async removeLabel(n: number, l: string): Promise<void> {
    this.issueLabels[n] = (this.issueLabels[n] ?? []).filter((x) => x !== l);
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
  async addIssueComment(n: number, body: string): Promise<void> {
    this.issueCommentsPosted.push([n, body]);
    // #237: mirror align.test.ts/dissent.test.ts's fakes — getIssueComments (below) must reflect
    // what was actually posted, or dissent.ts's own marker-check-before-post idempotency can
    // never be observed against this fixture (it would repost forever, never finding its own
    // prior comment).
    this.issueComments[n] = [...(this.issueComments[n] ?? []), { login: "sapwood-engine", createdAt: new Date().toISOString(), body }];
  }
  async getIssueBody(): Promise<string> {
    return "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
  }
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
  async getPRChangedFiles() {
    return { files: [], complete: true };
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
    return this.planReviewCandidates;
  }
  async getIssueLabels(issue: number): Promise<string[]> {
    return this.issueLabels[issue] ?? [];
  }
  async getIssueComments(issue: number) {
    return this.issueComments[issue] ?? [];
  }
  async createIssue(): Promise<number> {
    return 0;
  }
  async listOpenIssueNumbers(): Promise<number[]> {
    return this.openIssueNumbers;
  }
  async listOpenIssues(): Promise<Issue[]> {
    return [];
  }
  planTriageCandidates: Issue[] = [];
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return this.planTriageCandidates;
  }
  issueMetaState: Record<number, "OPEN" | "CLOSED"> = {};
  async getIssueMeta(issue: number) {
    return {
      number: issue,
      title: "",
      state: this.issueMetaState[issue] ?? ("OPEN" as const),
      labels: [],
      updatedAt: "2026-01-01T00:00:00Z",
    };
  }
}

class MinimalSupervisor implements Supervisor {
  async probe(): Promise<LaneProbe> {
    return { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
  }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> {
    return { name: `lane-${issue.number}`, sessionId: "s" };
  }
  async resume(_issue: Issue, worker: string): Promise<{ name: string; sessionId: string }> {
    return { name: worker, sessionId: "s" };
  }
  resumeIntentState(): "none" {
    return "none";
  }
  async reclaim(): Promise<{ worktreePath: string | null; worktreeRetained: boolean }> {
    return { worktreePath: null, worktreeRetained: false };
  }
  inspectWorktree(): { worktreePath: string | null; worktreeRetained: boolean } {
    return { worktreePath: null, worktreeRetained: false };
  }
  requestHandoff(): boolean {
    return true;
  }
  clearStaleFixEntrySentinel(): void {}
}

/** One shared scripted fake for every role session dispatched across the whole round — real
 *  stubs each get their OWN RoleRunner-shaped dep, but this factory feeds them all the same
 *  `runner`, exactly like a real caller would (peripheral.ts's module doc: RoleRunner is the
 *  single spawn/sentinel/cost-parse implementation every role reuses).
 *
 *  #110 PR1/PR2: role sessions don't touch `gh` anymore — each must emit valid structured
 *  output for the engine to act on, or the engine's own isValid-driven retry doubles the call
 *  count (breaking this file's exact-call-count assertions). "plan-reviewer" emits a
 *  structured-output "approve" decision; "po-triage" emits a structured-output body revision.
 *  Issue numbers are recovered from the rendered prompt (every shipped issues-only role prompt
 *  renders "Number: #<n>" verbatim), and both carry their OWN BODY with a verification section
 *  AND (#283) a checkbox acceptance-criteria section so they validate regardless of whatever
 *  FakeForge.getIssueBody's stub (always "") would otherwise fail the content-invariant check
 *  on. "po-align" emits a valid empty declaration (no issues to create) — this file's scoping/
 *  wiring properties don't exercise creation. */
class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  constructor(
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: constructor shape mirrors the production runner seam.
    private readonly forge: FakeForge,
    // biome-ignore lint/correctness/noUnusedPrivateClassMembers: constructor shape mirrors the production runner seam.
    private readonly cfg: SapwoodConfig,
  ) {}
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    if (opts.roleId === "plan-reviewer") {
      const m = /Number: #(\d+)/.exec(opts.prompt);
      const issue = m ? Number(m[1]) : 0;
      const resultText =
        `${RESULT_BLOCK_START}\n${JSON.stringify({ decision: "approve", issue })}\n${RESULT_BLOCK_END}\n` +
        `${BODY_BLOCK_START}\nApproved by the scripted test reviewer.\n\n## Acceptance criteria\n\n- [ ] stubbed criterion\n\n## Verification\n\nStubbed.\n${BODY_BLOCK_END}`;
      return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: `role-${opts.roleId}-1`, resultText };
    }
    if (opts.roleId === "po-triage") {
      const m = /Number: #(\d+)/.exec(opts.prompt);
      const issue = m ? Number(m[1]) : 0;
      const resultText =
        `${RESULT_BLOCK_START}\n${JSON.stringify({ issue })}\n${RESULT_BLOCK_END}\n` +
        `${BODY_BLOCK_START}\nDrafted by the scripted test triage session.\n\n## Acceptance criteria\n\n- [ ] stubbed criterion\n\n## Verification\n\nStubbed.\n${BODY_BLOCK_END}`;
      return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: `role-${opts.roleId}-1`, resultText };
    }
    if (opts.roleId === "po-align") {
      const resultText = `${RESULT_BLOCK_START}\n${JSON.stringify({ issues: [] })}\n${RESULT_BLOCK_END}`;
      return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: `role-${opts.roleId}-1`, resultText };
    }
    return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: `role-${opts.roleId}-1` };
  }
}

test("createDefaultPeripherals: every PeripheralPhase key is present and none of them is noopPeripheralStub", () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  for (const phase of ["aligning", "architecting", "plan_review", "harvesting", "retro"] as const) {
    assert.ok(peripherals[phase], `expected a real stub for ${phase}`);
    assert.notEqual(peripherals[phase], noopPeripheralStub, `${phase} must not be the noop stub`);
  }
  state.close();
});

test("renderAlignedGoalsFromSummary (#123): renders the align-summary event's per-issue detail; no event (or no round) -> null (pointer-note fallback)", () => {
  const state = new State(":memory:");
  assert.equal(renderAlignedGoalsFromSummary(state, 1), null, "no round row -> null");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  assert.equal(renderAlignedGoalsFromSummary(state, round.round_id), null, "no summary event yet -> null");
  state.appendEvent("align-summary", {
    round_id: round.round_id,
    created: [{ issue: 12, title: "Split the parser", hasPlan: false }],
    triaged: [{ issue: 9, drafted: false }],
  });
  const text = renderAlignedGoalsFromSummary(state, round.round_id)!;
  assert.ok(text.includes("created #12 — Split the parser"));
  assert.ok(text.includes("labelled for human attention"));
  assert.ok(text.includes("triaged #9: still planless"));
  // A second (crash-rerun) summary MERGES — an empty one never erases the first's content
  // (Codex round-6 P2 on PR #152), and a fresher triage outcome for the same issue wins.
  state.appendEvent("align-summary", { round_id: round.round_id, created: [], triaged: [{ issue: 9, drafted: true }] });
  const merged = renderAlignedGoalsFromSummary(state, round.round_id)!;
  assert.ok(merged.includes("created #12 — Split the parser"), "first summary's creation survives the rerun");
  assert.ok(merged.includes("triaged #9: plan drafted"), "the rerun's fresher triage outcome wins");
  state.close();
});

test("architecting stub (#123, Codex round-7 P2): resuming directly at architecting still renders the pre-crash align-summary — the handoff is computed at invocation time from state, never a same-process side effect", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  // A gate⓪ candidate so the architect actually dispatches (it short-circuits on none).
  forge.planReviewCandidates = [{ number: 5, title: "pending design", labels: [] }];
  // Simulate the crash-resume shape: the round + the aligning phase's summary exist in durable
  // state, but the aligning stub never ran in THIS process.
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("align-summary", {
    round_id: round.round_id,
    created: [{ issue: 12, title: "Split the parser", hasPlan: true }],
    triaged: [],
  });
  await peripherals.architecting!.run({ roundId: round.round_id, phase: "architecting", marker: null });
  const architectCall = runner.calls.find((c) => c.roleId === "architect");
  assert.ok(architectCall, "the architect session was dispatched");
  assert.ok(
    architectCall!.prompt.includes("created #12 — Split the parser"),
    "the architect prompt carries the pre-crash summary detail, not the fallback note",
  );
  state.close();
});

test("renderAlignedGoalsFromSummary (#123): an all-empty summary renders the explicit 'decomposed nothing' line, never null", () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("align-summary", { round_id: round.round_id, created: [], triaged: [] });
  assert.ok(renderAlignedGoalsFromSummary(state, round.round_id)!.includes("decomposed nothing"));
  state.close();
});

// ── renderLastMergedFromArtifact (#132): architect post-review context ────────────────────

test("renderLastMergedFromArtifact (#132): round 1 (no possible prior round) -> the explicit 'no prior round' placeholder", () => {
  const state = new State(":memory:");
  const text = renderLastMergedFromArtifact(state, 1, 20_000);
  assert.match(text, /no prior round/i);
  state.close();
});

test("renderLastMergedFromArtifact (#132): prior round's artifact row is missing (harvest disabled, or persistence failed) -> the SAME 'no prior round' placeholder, never a throw", () => {
  const state = new State(":memory:");
  state.startRound("2026-07-10T00:00:00.000Z"); // round 1, no artifact ever persisted for it
  const text = renderLastMergedFromArtifact(state, 2, 20_000);
  assert.match(text, /no prior round/i);
  state.close();
});

test("renderLastMergedFromArtifact (#132): prior round persisted with zero merges -> a DISTINCT 'merged nothing' placeholder, never the no-prior-round text", () => {
  const state = new State(":memory:");
  const round1 = state.startRound("2026-07-10T00:00:00.000Z");
  state.closeRound(round1.round_id, "2026-07-10T01:00:00.000Z");
  const artifact = buildRoundArtifact(state, round1, 30, "2026-07-10T01:00:00.000Z");
  persistRoundArtifact(state, artifact, "2026-07-10T01:00:00.000Z");
  const text = renderLastMergedFromArtifact(state, 2, 20_000);
  assert.match(text, /merged nothing|zero merged/i);
  assert.doesNotMatch(text, /no prior round/i, "must be wordy-distinct from the no-prior-round case");
  state.close();
});

test("renderLastMergedFromArtifact (#132): prior round's merged PRs render as issue/pr/worker lines", () => {
  const state = new State(":memory:");
  const round1 = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("merged", { worker: "lane-12", issue: 12, pr: 34 });
  state.appendEvent("merged", { worker: "lane-9", issue: 9, pr: 30 });
  state.closeRound(round1.round_id, "2026-07-10T01:00:00.000Z");
  const artifact = buildRoundArtifact(state, round1, 30, "2026-07-10T01:00:00.000Z");
  persistRoundArtifact(state, artifact, "2026-07-10T01:00:00.000Z");
  const text = renderLastMergedFromArtifact(state, round1.round_id + 1, 20_000);
  assert.ok(text.includes("#12"));
  assert.ok(text.includes("PR #34"));
  assert.ok(text.includes("#9"));
  assert.ok(text.includes("PR #30"));
  state.close();
});

test("renderLastMergedFromArtifact (#132): boundedness — an oversize rendered digest is deterministically truncated, the cut marked in the text", () => {
  const state = new State(":memory:");
  const round1 = state.startRound("2026-07-10T00:00:00.000Z");
  for (let i = 0; i < 200; i++) {
    state.appendEvent("merged", { worker: `lane-${i}`, issue: 1000 + i, pr: 2000 + i });
  }
  state.closeRound(round1.round_id, "2026-07-10T01:00:00.000Z");
  const artifact = buildRoundArtifact(state, round1, 30, "2026-07-10T01:00:00.000Z");
  persistRoundArtifact(state, artifact, "2026-07-10T01:00:00.000Z");
  const text = renderLastMergedFromArtifact(state, round1.round_id + 1, 200);
  assert.ok(text.length <= 200, "capped at maxChars");
  assert.match(text, /truncated/i);
  state.close();
});

test("renderLastMergedFromArtifact (#132 gate② P2): EVERY branch honors the cap — placeholder branches and the zero-merges sentence are capDigest-bounded too, not just the real-merges render", () => {
  const cap = 20; // deliberately below every placeholder's length — a degenerate but legal config
  const state = new State(":memory:");

  // (a) the no-prior placeholder branches: round 1, and a missing prior-round artifact row.
  const noPrior = renderLastMergedFromArtifact(state, 1, cap);
  assert.ok(noPrior.length <= cap, `round-1 placeholder capped (got ${noPrior.length} chars)`);
  state.startRound("2026-07-10T00:00:00.000Z"); // round 1 exists but never persisted an artifact
  const missingRow = renderLastMergedFromArtifact(state, 2, cap);
  assert.ok(missingRow.length <= cap, `missing-artifact placeholder capped (got ${missingRow.length} chars)`);

  // (b) the zero-merges sentence.
  const state2 = new State(":memory:");
  const r1 = state2.startRound("2026-07-10T00:00:00.000Z");
  state2.closeRound(r1.round_id, "2026-07-10T01:00:00.000Z");
  persistRoundArtifact(state2, buildRoundArtifact(state2, r1, 30, "2026-07-10T01:00:00.000Z"), "2026-07-10T01:00:00.000Z");
  const zeroMerges = renderLastMergedFromArtifact(state2, 2, cap);
  assert.ok(zeroMerges.length <= cap, `zero-merges sentence capped (got ${zeroMerges.length} chars)`);
  state2.close();

  // (c) a real merges render (already covered at cap=200 above; pinned here at the same
  // degenerate cap for branch symmetry).
  const state3 = new State(":memory:");
  const r = state3.startRound("2026-07-10T00:00:00.000Z");
  state3.appendEvent("merged", { worker: "lane-1", issue: 1, pr: 2 });
  state3.closeRound(r.round_id, "2026-07-10T01:00:00.000Z");
  persistRoundArtifact(state3, buildRoundArtifact(state3, r, 30, "2026-07-10T01:00:00.000Z"), "2026-07-10T01:00:00.000Z");
  const merges = renderLastMergedFromArtifact(state3, 2, cap);
  assert.ok(merges.length <= cap, `real-merges render capped (got ${merges.length} chars)`);
  state3.close();
  state.close();
});

test("architecting stub (#132): the architect prompt carries the prior round's merged-outcome context, engine-assembled from the durable round artifact", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, cfg);
  const round1 = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("merged", { worker: "lane-21", issue: 21, pr: 55 });
  state.closeRound(round1.round_id, "2026-07-10T01:00:00.000Z");
  const artifact = buildRoundArtifact(state, round1, 30, "2026-07-10T01:00:00.000Z");
  persistRoundArtifact(state, artifact, "2026-07-10T01:00:00.000Z");
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  forge.planReviewCandidates = [{ number: 5, title: "pending design", labels: [] }];
  const round2 = state.startRound("2026-07-10T02:00:00.000Z");
  await peripherals.architecting!.run({ roundId: round2.round_id, phase: "architecting", marker: null });
  const architectCall = runner.calls.find((c) => c.roleId === "architect");
  assert.ok(architectCall, "the architect session was dispatched");
  assert.ok(architectCall!.prompt.includes("#21"), "the prior round's merged issue number reaches the prompt");
  assert.ok(architectCall!.prompt.includes("PR #55"), "the prior round's merged PR number reaches the prompt");
  state.close();
});

test("architecting stub (#167): the architect prompt carries this repo's review-doctrine text, loaded fresh at architect-invocation time from cfg.doctrine.file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-defaults-doctrine-"));
  try {
    const doctrinePath = join(dir, "DOCTRINE.md");
    writeFileSync(doctrinePath, "same-tick window rule: gate on a post-reclaim thunk, never a pre-tick scalar.");
    const state = new State(":memory:");
    const forge = new FakeForge();
    const cfg = mkCfg({ doctrine: { file: doctrinePath } });
    const runner = new ScriptedRunner(forge, cfg);
    const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
    forge.planReviewCandidates = [{ number: 5, title: "pending design", labels: [] }];
    const round = state.startRound("2026-07-10T00:00:00.000Z");
    await peripherals.architecting!.run({ roundId: round.round_id, phase: "architecting", marker: null });
    const architectCall = runner.calls.find((c) => c.roleId === "architect");
    assert.ok(architectCall, "the architect session was dispatched");
    assert.ok(
      architectCall!.prompt.includes("same-tick window rule: gate on a post-reclaim thunk, never a pre-tick scalar."),
      "the doctrine file's content reaches the architect prompt",
    );
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createDefaultPeripherals (#109 gate② P2): with round.milestone set, the peripherals' forge is milestone-scoped — plan review and PO triage never touch issues outside the round's milestone", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg({ round: { milestone: "M-X" } });
  // #214: plan_review's candidate set is the round pool (roundPool-labelled, pool-eligible),
  // not the raw getIssuesNeedingPlanReview sweep — both fixture issues are unadjudicated pool
  // members, one in-scope and one not, proving the milestone scope still applies post-#214.
  forge.ready = [
    { number: 5, title: "in-scope review candidate", labels: [cfg.labels.roundPool], milestone: "M-X" },
    { number: 6, title: "out-of-scope review candidate", labels: [cfg.labels.roundPool] },
  ];
  forge.planTriageCandidates = [
    { number: 7, title: "in-scope triage candidate", labels: [], milestone: "M-X" },
    { number: 8, title: "out-of-scope triage candidate", labels: [] },
  ];
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });

  // Drive the two candidate-consuming stubs directly (round.ts's SEQUENCE order is round.test.ts
  // territory; the scoping property under test is per-stub).
  await peripherals.plan_review!.run({ roundId: 1, phase: "plan_review", marker: null });
  const reviewerCalls = runner.calls.filter((c) => c.roleId === "plan-reviewer");
  assert.equal(reviewerCalls.length, 1, "exactly one reviewer session — the in-milestone candidate only");
  assert.match(reviewerCalls[0]!.prompt, /in-scope review candidate/);
  assert.doesNotMatch(reviewerCalls[0]!.prompt, /out-of-scope/);

  await peripherals.aligning!.run({ roundId: 1, phase: "aligning", marker: null });
  const triageCalls = runner.calls.filter((c) => c.roleId === "po-triage");
  assert.equal(triageCalls.length, 1, "exactly one triage session — the in-milestone candidate only");
  assert.match(triageCalls[0]!.prompt, /in-scope triage candidate/);
  assert.doesNotMatch(triageCalls[0]!.prompt, /out-of-scope/);
  state.close();
});

test("runRounds integration: wired with createDefaultPeripherals's output, a default round dispatches all five real role sessions — no noop remains in the shipped default map", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  // #214: plan_review's candidate set is the round pool now — pre-label the fixture with
  // cfg.labels.roundPool (this test isn't exercising pool-selection's OWN label-write mechanics,
  // just proving every phase dispatches a real session) so it's visible to createPlanReviewStub
  // once aligning's pool selection runs (a no-op add — the label is already there).
  forge.ready = [{ number: 5, title: "candidate", labels: [cfg.labels.roundPool] }];
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });

  const deps: RoundDeps = {
    forge,
    state,
    supervisor: new MinimalSupervisor(),
    cfg,
    tickIntervalSec: 1,
    sleep: async () => {},
    peripherals,
  };
  // Graceful stop mid-round (round.test.ts's own pattern, reused by align/architect/harvest/
  // retro's integration tests): the in-flight round still finishes every phase before the loop
  // actually stops — only the NEXT round is withheld. Seed a needs-human escalation right after
  // 'aligning' completes so harvest has something to brief (otherwise it appends only its
  // summary event and dispatches no session — still a real stub, but this proves the session
  // dispatch path too).
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  deps.onRoundPhase = (_roundId, phase) => {
    if (phase === "aligning") {
      state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 7, pr: 1, reason: "x" });
      stop();
    }
  };

  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  const round = state.getRound(1)!;
  assert.equal(round.phase, "closed");

  const roleIdsDispatched = new Set(runner.calls.map((c) => c.roleId));
  // Every phase actually reached the runner — proof positive that no phase silently fell back
  // to noopPeripheralStub (which never calls runner.run at all).
  assert.ok(roleIdsDispatched.has("po-align"), "aligning dispatched a real PO session");
  assert.ok(roleIdsDispatched.has("architect"), "architecting dispatched a real architect session");
  assert.ok(roleIdsDispatched.has("plan-reviewer"), "plan_review dispatched a real reviewer session");
  assert.ok(roleIdsDispatched.has("harvest"), "harvesting dispatched a real harvest session");
  assert.ok(roleIdsDispatched.has("retro"), "retro dispatched a real retro session");
  // The plan-review candidate actually converged (the scripted reviewer approved it) — proof
  // the wired plan_review stub is the real orchestration, not a stand-in.
  assert.ok(forge.issueLabels[5]!.includes(cfg.labels.planApproved));
  state.close();
});

test("createDefaultPeripherals (#127): roles.<role>.enabled=false omits that phase's stub, leaving the others wired", () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { retro: { enabled: false } } });
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  assert.equal(peripherals.retro, undefined, "the disabled phase's stub is omitted entirely");
  for (const phase of ["aligning", "architecting", "plan_review", "harvesting"] as const) {
    assert.ok(peripherals[phase], `${phase} stays wired when only retro is disabled`);
    assert.notEqual(peripherals[phase], noopPeripheralStub);
  }
  state.close();
});

test("createDefaultPeripherals (#127): all five roles.<role>.enabled=false omits every session phase — aligning alone stays wired for #212's engine-computed round-pool selection, an all-noop map otherwise", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg({
    roles: {
      po: { enabled: false },
      architect: { enabled: false },
      planReviewer: { enabled: false },
      harvest: { enabled: false },
      retro: { enabled: false },
    },
  });
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  for (const phase of ["architecting", "plan_review", "harvesting", "retro"] as const) {
    assert.equal(peripherals[phase], undefined, `${phase} omitted when disabled`);
  }
  // #212 AC7: aligning is never omitted — with the PO off it still runs the engine-computed
  // fallback selection (no session at all).
  assert.ok(peripherals.aligning, "aligning stays wired even with every role disabled");
  const { ranSession } = await peripherals.aligning!.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 0, "no session was dispatched — the fallback is pure engine computation");
  assert.equal(ranSession, false, "#394 (F23 gate② fix): PO off + deterministic pool fallback -> no session anywhere -> ranSession false");
  state.close();
});

test("createDefaultPeripherals (#394 F23 gate② fix): roles.po.enabled=false but roles.po.poolSelection=true with candidates -> the aligning phase's ranSession is driven by pool-selection ALONE (alignStub itself never runs a session)", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.ready = [{ number: 1, title: "a", labels: [] }];
  const cfg = mkCfg({ roles: { po: { enabled: false, poolSelection: true } } });
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  const { ranSession } = await peripherals.aligning!.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(
    runner.calls.some((c) => c.roleId === "po-pool"),
    true,
    "the po-pool session dispatched",
  );
  assert.equal(ranSession, true, "pool-selection's own dispatch, folded in by round-defaults.ts's wrapper, is enough on its own");
  state.close();
});

test("createDefaultPeripherals (#212 gate② P2-4): every pool label write failing propagates OUT of the aligning phase — round.ts never persists the marker, so a rerun retries selection from scratch", async () => {
  const state = new State(":memory:");
  class FailAddLabelForge extends FakeForge {
    override async addLabel(): Promise<void> {
      throw new Error("simulated forge failure");
    }
  }
  const forge = new FailAddLabelForge();
  forge.ready = [{ number: 1, title: "t", labels: [] }];
  // roles.po disabled keeps this test focused on applyPoolLabels' own throw behavior (the
  // deterministic path also routes every write through it) rather than session scripting.
  const cfg = mkCfg({ roles: { po: { enabled: false } } });
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  await assert.rejects(() => peripherals.aligning!.run({ roundId: 1, phase: "aligning", marker: null }), /ALL 1 label write\(s\) failed/);
  state.close();
});

test("runRounds (#212 gate② r2 finding 3): every pool-label write failing keeps the round in_progress at aligning with a null marker; a second runRounds call resumes the SAME round and retries the phase — never silently advances, never opens a new round", async () => {
  const state = new State(":memory:");
  class FailAddLabelForge extends FakeForge {
    override async addLabel(): Promise<void> {
      throw new Error("simulated forge failure");
    }
    // The base FakeForge hardcodes listOpenIssues() to [] — this test's SECOND runRounds call
    // replays the persisted pool-selected event (gate② r2) and needs the target issue to
    // actually resolve as "still open" (same as a real GithubForge would report for a genuinely
    // open issue), or the replayed target would spuriously resolve empty and mask the
    // total-failure throw this test is pinning.
    override async listOpenIssues(): Promise<Issue[]> {
      return this.ready;
    }
  }
  const forge = new FailAddLabelForge();
  forge.ready = [{ number: 1, title: "t", labels: [] }];
  const cfg = mkCfg({ roles: { po: { enabled: false } } });
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  const deps: RoundDeps = {
    forge,
    state,
    supervisor: new MinimalSupervisor(),
    cfg,
    tickIntervalSec: 1,
    sleep: async () => {},
    peripherals,
    registerSignals: () => () => {}, // never touch real process signals in this test
  };

  // round.ts's runPeripheral has no try/catch around stub.run() — an uncaught peripheral
  // exception propagates straight out of runRounds, the same crash-rerun contract every
  // peripheral relies on (a real deployment restarts the process; here, a second runRounds
  // call over the SAME state simulates exactly that restart).
  await assert.rejects(() => runRounds(deps), /ALL 1 label write\(s\) failed/);
  const round = state.getRound(1)!;
  assert.equal(round.status, "in_progress", "the round never closed");
  assert.equal(round.phase, "aligning", "still sitting at the phase that threw");
  assert.equal(round.artifact_ref, null, "the phase marker was never persisted");

  await assert.rejects(() => runRounds(deps), /ALL 1 label write\(s\) failed/);
  const roundAfterRetry = state.getRound(1)!;
  assert.equal(roundAfterRetry.round_id, round.round_id, "the SAME round was resumed — openRound() picked it back up, no new round opened");
  assert.equal(roundAfterRetry.phase, "aligning");
  assert.equal(roundAfterRetry.artifact_ref, null);
  state.close();
});

test("architecting stub (#127 gate② F3): with roles.po.enabled=false the architect context states the aligning phase is switched off — never the 'ran but recorded no summary' fallback (a fabricated phase)", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  // A gate⓪ candidate so the architect actually dispatches (it short-circuits on none).
  forge.planReviewCandidates = [{ number: 5, title: "pending design", labels: [] }];
  const cfg = mkCfg({ roles: { po: { enabled: false } } });
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  // #212 AC7: aligning is no longer omitted when the PO is disabled — it still runs the
  // engine-computed round-pool selection every round (no session); only the PO's OWN
  // decomposition/triage session is skipped (see the architect-context assertions below).
  assert.ok(peripherals.aligning, "aligning still runs #212's round-pool selection with the PO disabled");
  const round = state.startRound("2026-07-13T00:00:00.000Z");
  await peripherals.architecting!.run({ roundId: round.round_id, phase: "architecting", marker: null });
  const architectCall = runner.calls.find((c) => c.roleId === "architect");
  assert.ok(architectCall, "the architect session was dispatched");
  assert.match(
    architectCall!.prompt,
    /PO\/goal-alignment peripheral switched off/,
    "the architect context names the switched-off deployment state",
  );
  assert.doesNotMatch(
    architectCall!.prompt,
    /no structured summary was recorded/,
    "never the fallback wording that implies the aligning pass ran",
  );
  state.close();
});

test("createDefaultPeripherals #237 finding 5 (2026-07-18 adjudication): the PO-dissent adjudication scan runs even with roles.po.enabled=false — decoupled from the PO's own toggle", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  // A still-open concern from a prior round, posted against an empty body ("" — FakeForge's
  // getIssueBody default) — seeded directly, no PO session ever ran to produce it.
  const hash = concernHash("premise seems wrong", "");
  state.appendEvent("concern-posted", { round_id: 1, issue: 42, reason: "premise seems wrong", hash });
  forge.issueMetaState[42] = "CLOSED"; // the issue closed since — this is what the scan should detect
  const cfg = mkCfg({ roles: { po: { enabled: false } } });
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });

  await peripherals.aligning!.run({ roundId: 2, phase: "aligning", marker: null });

  const adjudicated = state.eventsAfterId(0, ["concern-adjudicated"]);
  assert.equal(adjudicated.length, 1, "the scan ran and adjudicated the concern even though roles.po.enabled is false");
  assert.deepEqual(adjudicated[0]!.payload, { issue: 42, hash, outcome: "closed" });
  // Confirms the PO's OWN decomposition/triage session genuinely never ran (roles.po.enabled
  // gates alignStub.run, not the scan) — same #212 AC7 property the sibling test above checks.
  assert.ok(!runner.calls.some((c) => c.roleId === "po-align" || c.roleId === "po-triage"));
  state.close();
});

test("createDefaultPeripherals #237 round-2 adjudication (2026-07-19, finding 1+2): the REAL terminal-replay path — triage-effects-committed lands but the concern-posted receipt is lost; the NEXT round's unconditional sweep recovers it, attributed to the ORIGINAL round", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  // No `body` set (this fixture's getIssueBody always returns "" — it doesn't track real writes,
  // unlike align.test.ts's fuller fake) — matches "" so #232's concurrent-edit guard sees no
  // (spurious) mismatch; this test isn't about that guard, only about the concern-receipt path.
  forge.planTriageCandidates = [{ number: 91, title: "t", labels: [] }];
  const cfg = mkCfg();

  // Round 5: drive the REAL po-triage session through createAligningStub/createDefaultPeripherals
  // (not a hand-seeded shortcut) — its output carries a concern. Poison ONLY the concern-posted
  // append so the comment lands but its receipt is lost — exactly "crashed strictly between the
  // comment landing and the event append," the real crash window findings 1/2 are about.
  const runner = {
    calls: [] as RoleSessionOpts[],
    async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
      this.calls.push(opts);
      if (opts.roleId === "po-triage") {
        const resultText =
          `${RESULT_BLOCK_START}\n${JSON.stringify({ issue: 91, concerns: [{ issue: 91, reason: "this issue's premise seems wrong" }] })}\n${RESULT_BLOCK_END}\n` +
          `${BODY_BLOCK_START}\n## Verification\n- x\n${BODY_BLOCK_END}`;
        return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: "po-triage-91", resultText };
      }
      const resultText = `${RESULT_BLOCK_START}\n${JSON.stringify({ issues: [] })}\n${RESULT_BLOCK_END}`;
      return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: `role-${opts.roleId}-1`, resultText };
    },
  };
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    if (kind === "concern-posted") throw new Error("simulated crash: concern-posted append lost");
    realAppend(kind, payload);
  };
  const peripheralsRound5 = createDefaultPeripherals({ forge, state, cfg, runner });
  await peripheralsRound5.aligning!.run({ roundId: 5, phase: "aligning", marker: null });
  state.appendEvent = realAppend; // un-poison — the "crash" is over

  // Two comments land on #91: the triage success comment (plan drafted) AND the concern comment
  // (postConcernIfNew posts before attempting the now-poisoned receipt append).
  const round5Comments = forge.issueCommentsPosted.filter(([n]) => n === 91);
  assert.equal(round5Comments.length, 2);
  assert.ok(
    round5Comments.some(([, body]) => /this issue's premise seems wrong/.test(body)),
    "the concern comment landed",
  );
  // ...but the durable receipt for it was lost — the real bug this fix closes.
  assert.equal(state.eventsAfterId(0, ["concern-posted"]).length, 0, "the receipt never landed (simulated crash)");
  // And the decision's OWN per-round journal is now TERMINAL — align.ts's own in-memory
  // re-collection path can never revisit this decision within round 5 again, even on a
  // same-round crash-rerun (not exercised here — the point is round 5 is simply DONE).
  assert.ok(state.eventsAfterId(0, ["triage-effects-committed"]).some((e) => (e.payload as { issue: number }).issue === 91));

  // Round 6 (a LATER round, no session dispatch needed for THIS issue — it's not a triage
  // candidate anymore, its body already has a plan): the unconditional sweep runs regardless.
  forge.planTriageCandidates = []; // #91 no longer needs triage — the body write already landed
  const runnerRound6 = {
    calls: [] as RoleSessionOpts[],
    async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
      this.calls.push(opts);
      const resultText = `${RESULT_BLOCK_START}\n${JSON.stringify({ issues: [] })}\n${RESULT_BLOCK_END}`;
      return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: `role-${opts.roleId}-1`, resultText };
    },
  };
  const peripheralsRound6 = createDefaultPeripherals({ forge, state, cfg, runner: runnerRound6 });
  await peripheralsRound6.aligning!.run({ roundId: 6, phase: "aligning", marker: null });

  assert.equal(
    forge.issueCommentsPosted.filter(([n]) => n === 91).length,
    2,
    "no repost — the live marker was already there, reconciled instead (still just the round-5 pair)",
  );
  const receipts = state.eventsAfterId(0, ["concern-posted"]);
  assert.equal(receipts.length, 1, "round 6's sweep recovered the missing receipt");
  assert.deepEqual(receipts[0]!.payload, {
    round_id: 5, // #237 finding 2: the ORIGINAL round, never round 6 (the sweep's own round)
    issue: 91,
    reason: "this issue's premise seems wrong",
    // This fixture's getIssueBody always returns "" (it doesn't persist updateIssueBody's
    // writes) — the same body value both round 5's post and round 6's reconcile-lookup see.
    hash: concernHash("this issue's premise seems wrong", ""),
    reconciled: true,
  });
  state.close();
});

test("createDefaultPeripherals (#127 gate② F1): disabled roles are logged exactly ONCE — one line naming every disabled phase, carrying the gate⓪ dispatch-starvation warning when planReviewer is among them; nothing logged when all roles are enabled", () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const logged: string[] = [];
  try {
    // #127 gate② R3: CUSTOM label names — the warning must render cfg.labels.planApproved/
    // verifyNa, so a hardcoded "plan:approved"/"verify:n/a" string in round-defaults.ts would
    // fail this test (the repo's no-hardcoded-label-at-call-sites rule, fable PR #101 P3).
    const cfg = mkCfg({
      roles: { planReviewer: { enabled: false }, retro: { enabled: false } },
      labels: { planApproved: "ok-to-build", verifyNa: "no-verify" },
    });
    createDefaultPeripherals({ forge, state, cfg, runner: new ScriptedRunner(forge, cfg), log: (line) => logged.push(line) });
    assert.equal(logged.length, 1, "exactly one startup log line for two disabled roles");
    assert.match(logged[0]!, /^\[sapwood:round\]/);
    assert.match(logged[0]!, /plan_review/);
    assert.match(logged[0]!, /retro/);
    assert.match(
      logged[0]!,
      /ok-to-build/,
      "the planReviewer warning names the CONFIGURED planApproved label a human/external process must now apply",
    );
    assert.match(logged[0]!, /no-verify/, "the configured verifyNa label too");
    assert.doesNotMatch(logged[0]!, /plan:approved/, "never the hardcoded default label name");
    const allOn = mkCfg();
    createDefaultPeripherals({ forge, state, cfg: allOn, runner: new ScriptedRunner(forge, allOn), log: (line) => logged.push(line) });
    assert.equal(logged.length, 1, "an all-enabled factory logs nothing");
  } finally {
    state.close();
  }
});

test("runRounds integration (#127): a disabled role spawns no session for its phase, and the round still closes — the phase no-ops via round.ts's existing noopPeripheralStub default, no round.ts change", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { retro: { enabled: false } } });
  // #214: pre-labelled round-pool member, see the other runRounds integration test's own comment.
  forge.ready = [{ number: 5, title: "candidate", labels: [cfg.labels.roundPool] }];
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });

  const deps: RoundDeps = {
    forge,
    state,
    supervisor: new MinimalSupervisor(),
    cfg,
    tickIntervalSec: 1,
    sleep: async () => {},
    peripherals,
  };
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  deps.onRoundPhase = (_roundId, phase) => {
    // Seed a needs-human escalation right after 'aligning' so harvest actually has something
    // to brief (otherwise it appends only its summary event and dispatches no session — same
    // pattern as this file's other runRounds integration test).
    if (phase === "aligning") {
      state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 7, pr: 1, reason: "x" });
    }
    if (phase === "harvesting") stop(); // stop before the disabled retro phase, same
    // graceful-mid-round pattern as this file's other integration test — the in-flight round
    // still finishes every remaining phase (including the disabled one) before actually
    // stopping; only the NEXT round is withheld.
  };

  const result = await runRounds(deps);
  assert.equal(result.rounds, 1);
  const round = state.getRound(1)!;
  assert.equal(round.phase, "closed", "the round still closes despite the disabled retro peripheral");
  assert.ok(!runner.calls.some((c) => c.roleId === "retro"), "no retro session was spawned");
  // Every OTHER phase still ran a real session — proof the disabled toggle is scoped to retro
  // alone, not a global kill of the peripheral machinery.
  const roleIdsDispatched = new Set(runner.calls.map((c) => c.roleId));
  assert.ok(roleIdsDispatched.has("po-align"));
  assert.ok(roleIdsDispatched.has("architect"));
  assert.ok(roleIdsDispatched.has("plan-reviewer"));
  assert.ok(roleIdsDispatched.has("harvest"));
  state.close();
});

test("runRounds integration: KILL_SWITCH blocks every real peripheral — none of createDefaultPeripherals's stubs ever runs a session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-round-defaults-int-"));
  try {
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const forge = new FakeForge();
    const cfg = mkCfg();
    const runner = new ScriptedRunner(forge, cfg);
    const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
    const deps: RoundDeps = {
      forge,
      state,
      supervisor: new MinimalSupervisor(),
      cfg,
      tickIntervalSec: 1,
      sleep: async () => {},
      peripherals,
    };
    const result = await runRounds(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.equal(result.rounds, 0);
    assert.equal(runner.calls.length, 0);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #213: architect batch review of the round pool — round-defaults wiring ─────────────────

test("architecting stub (#213): only cfg.labels.roundPool-labeled, dispatchable (getReadyIssues) issues reach {{round.pool}} — a non-pool Ready issue is excluded even though it's dispatchable", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, cfg);
  forge.planReviewCandidates = [{ number: 5, title: "pending design", labels: [] }]; // keeps the phase from short-circuiting for unrelated reasons
  forge.ready = [
    { number: 40, title: "pool member A", labels: [cfg.labels.roundPool], body: "body of pool member A" },
    { number: 41, title: "NOT a pool member", labels: [], body: "body of a dispatchable-but-unpooled issue" },
  ];
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  const round = state.startRound("2026-07-17T00:00:00.000Z");
  await peripherals.architecting!.run({ roundId: round.round_id, phase: "architecting", marker: null });
  const architectCall = runner.calls.find((c) => c.roleId === "architect");
  assert.ok(architectCall, "the architect session was dispatched");
  assert.ok(architectCall!.prompt.includes("pool member A"));
  assert.ok(architectCall!.prompt.includes("body of pool member A"));
  assert.ok(!architectCall!.prompt.includes("NOT a pool member"), "a dispatchable issue lacking the pool label is not pool context");
  state.close();
});

test("architecting stub (#213): the pool is computed FRESH at every invocation (live forge read, never cached across calls) — a later call sees the CURRENT label state, not a stale snapshot from an earlier one", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, cfg);
  forge.planReviewCandidates = [{ number: 5, title: "pending design", labels: [] }];
  forge.ready = [{ number: 50, title: "first-round pool member", labels: [cfg.labels.roundPool] }];
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  const round1 = state.startRound("2026-07-17T00:00:00.000Z");
  await peripherals.architecting!.run({ roundId: round1.round_id, phase: "architecting", marker: null });
  const firstCall = runner.calls.find((c) => c.roleId === "architect")!;
  assert.ok(firstCall.prompt.includes("first-round pool member"));

  // Simulate the NEXT round selecting a completely different pool (the live label state changed
  // between invocations) — the SAME factory-built stub must reflect it, proving the pool isn't
  // threaded once at factory-construction time. (The scripted runner's un-validating output makes
  // runSessionWithRetry retry once per invocation — filtering by prompt CONTENT rather than a
  // fixed index sidesteps having to count attempts.)
  const callsBeforeRound2 = runner.calls.filter((c) => c.roleId === "architect").length;
  forge.ready = [{ number: 51, title: "second-round pool member", labels: [cfg.labels.roundPool] }];
  const round2 = state.startRound("2026-07-17T01:00:00.000Z");
  await peripherals.architecting!.run({ roundId: round2.round_id, phase: "architecting", marker: null });
  const round2Calls = runner.calls.filter((c) => c.roleId === "architect").slice(callsBeforeRound2);
  assert.ok(round2Calls.length > 0, "round 2 dispatched at least one architect session");
  assert.ok(round2Calls.every((c) => c.prompt.includes("second-round pool member")));
  assert.ok(
    round2Calls.every((c) => !c.prompt.includes("first-round pool member")),
    "the stale first round's pool member does not leak into round 2's calls",
  );
  state.close();
});

test("architecting stub (#213): {{round.pool}} is deterministically capped at cfg.roles.architect.poolDigestMaxChars, the SAME capDigest-marked-truncation contract as {{round.lastMerged}}", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { architect: { poolDigestMaxChars: 200 } } });
  const runner = new ScriptedRunner(forge, cfg);
  forge.planReviewCandidates = [{ number: 5, title: "pending design", labels: [] }];
  forge.ready = Array.from({ length: 50 }, (_, i) => ({
    number: 100 + i,
    title: `pool member ${i}`,
    labels: [cfg.labels.roundPool],
    body: "x".repeat(50),
  }));
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  const round = state.startRound("2026-07-17T00:00:00.000Z");
  await peripherals.architecting!.run({ roundId: round.round_id, phase: "architecting", marker: null });
  const architectCall = runner.calls.find((c) => c.roleId === "architect")!;
  assert.match(architectCall.prompt, /truncated/i, "the oversize pool digest is deterministically, markedly truncated");
  state.close();
});

test("architecting stub (#213): a pool-member forge read failure degrades to an EMPTY pool (the explicit placeholder), never a thrown phase", async () => {
  const state = new State(":memory:");
  class FailReadyForge extends FakeForge {
    override async getPoolEligibleIssues(): Promise<Issue[]> {
      throw new Error("simulated forge failure");
    }
  }
  const forge = new FailReadyForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, cfg);
  forge.planReviewCandidates = [{ number: 5, title: "pending design", labels: [] }];
  const logged: string[] = [];
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner, log: (line) => logged.push(line) });
  const round = state.startRound("2026-07-17T00:00:00.000Z");
  await peripherals.architecting!.run({ roundId: round.round_id, phase: "architecting", marker: null });
  const architectCall = runner.calls.find((c) => c.roleId === "architect")!;
  assert.ok(architectCall, "the phase never throws — the architect session still ran");
  assert.match(architectCall.prompt, /pool is empty/);
  assert.ok(logged.some((l) => /pool-member read failed/.test(l)));
  state.close();
});

test("architecting stub (#213 Codex review round 2, finding 3): a pool-member forge read failure ALSO records a durable `architect-review-degraded` honesty event (round_id + reason) — not just an ephemeral log line, so a real non-empty pool sitting unreviewed on GitHub is observable, not silent", async () => {
  const state = new State(":memory:");
  class FailReadyForge extends FakeForge {
    override async getPoolEligibleIssues(): Promise<Issue[]> {
      throw new Error("simulated forge failure");
    }
  }
  const forge = new FailReadyForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner(forge, cfg);
  forge.planReviewCandidates = [{ number: 5, title: "pending design", labels: [] }];
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  const round = state.startRound("2026-07-17T00:00:00.000Z");
  await peripherals.architecting!.run({ roundId: round.round_id, phase: "architecting", marker: null });
  const events = state.eventsAfterId(0, ["architect-review-degraded"]);
  assert.equal(events.length, 1);
  const payload = events[0]!.payload as { round_id: number; reason: string };
  assert.equal(payload.round_id, round.round_id);
  assert.match(payload.reason, /pool-member read failed/);
  state.close();
});

test("createDefaultPeripherals (#213 / #127): roles.architect.enabled=false -> the architecting phase is OMITTED entirely, same as before #213 — no architect-review-degraded event, no session, no spam", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg({ roles: { architect: { enabled: false } } });
  forge.ready = [{ number: 40, title: "pool member", labels: [cfg.labels.roundPool] }];
  const runner = new ScriptedRunner(forge, cfg);
  const peripherals = createDefaultPeripherals({ forge, state, cfg, runner });
  assert.equal(peripherals.architecting, undefined, "the phase is omitted, not a degraded no-op");
  state.close();
});
