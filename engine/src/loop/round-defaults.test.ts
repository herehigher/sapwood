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
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import { State } from "../state/state.js";
import { BODY_BLOCK_END, BODY_BLOCK_START, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import type { LaneProbe, Supervisor } from "./conductor.js";
import { noopPeripheralStub, type RoundDeps, runRounds } from "./round.js";
import { buildRoundArtifact, persistRoundArtifact } from "./round-artifact.js";
import { createDefaultPeripherals, renderAlignedGoalsFromSummary, renderLastMergedFromArtifact } from "./round-defaults.js";

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

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
  async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(n: number, l: string): Promise<void> {
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
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
  planTriageCandidates: Issue[] = [];
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return this.planTriageCandidates;
  }
}

class MinimalSupervisor implements Supervisor {
  async probe(): Promise<LaneProbe> {
    return { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
  }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> {
    return { name: `lane-${issue.number}`, sessionId: "s" };
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
 *  so they validate regardless of whatever FakeForge.getIssueBody's stub (always "") would
 *  otherwise fail the content-invariant check on. "po-align" emits a valid empty declaration
 *  (no issues to create) — this file's scoping/wiring properties don't exercise creation. */
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
        `${BODY_BLOCK_START}\nApproved by the scripted test reviewer.\n\n## Verification\n\nStubbed.\n${BODY_BLOCK_END}`;
      return { outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name: `role-${opts.roleId}-1`, resultText };
    }
    if (opts.roleId === "po-triage") {
      const m = /Number: #(\d+)/.exec(opts.prompt);
      const issue = m ? Number(m[1]) : 0;
      const resultText =
        `${RESULT_BLOCK_START}\n${JSON.stringify({ issue })}\n${RESULT_BLOCK_END}\n` +
        `${BODY_BLOCK_START}\nDrafted by the scripted test triage session.\n\n## Verification\n\nStubbed.\n${BODY_BLOCK_END}`;
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
    created: [{ issue: 12, title: "Split the parser", hasPlan: true }],
    triaged: [{ issue: 9, drafted: false }],
  });
  const text = renderAlignedGoalsFromSummary(state, round.round_id)!;
  assert.ok(text.includes("created #12 — Split the parser"));
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
  forge.planReviewCandidates = [
    { number: 5, title: "in-scope review candidate", labels: [], milestone: "M-X" },
    { number: 6, title: "out-of-scope review candidate", labels: [] },
  ];
  forge.planTriageCandidates = [
    { number: 7, title: "in-scope triage candidate", labels: [], milestone: "M-X" },
    { number: 8, title: "out-of-scope triage candidate", labels: [] },
  ];
  const cfg = mkCfg({ round: { milestone: "M-X" } });
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
  forge.planReviewCandidates = [{ number: 5, title: "candidate", labels: [] }];
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

test("createDefaultPeripherals (#127): all five roles.<role>.enabled=false omits every phase — an all-noop map, same shape as an empty peripherals override", () => {
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
  for (const phase of ["aligning", "architecting", "plan_review", "harvesting", "retro"] as const) {
    assert.equal(peripherals[phase], undefined, `${phase} omitted when disabled`);
  }
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
  assert.equal(peripherals.aligning, undefined, "the disabled PO's aligning stub is omitted");
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
  forge.planReviewCandidates = [{ number: 5, title: "candidate", labels: [] }];
  const cfg = mkCfg({ roles: { retro: { enabled: false } } });
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
