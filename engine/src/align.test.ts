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
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAligningStub, alignMarker, loadPlanMd, defaultPoPromptPath, validateAlignOutput,
  validateTriageOutput, type AlignDeps,
} from "./align.js";
import { loadRolePromptTemplate } from "./plan-review.js";
import { PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS } from "./peripheral.js";
import type { RoleSessionOpts, RoleSessionResult } from "./peripheral.js";
import {
  RESULT_BLOCK_START, RESULT_BLOCK_END, BODY_BLOCK_START, BODY_BLOCK_END,
} from "./structured-output.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

class FakeForge implements IForge {
  issueLabels: Record<number, string[]> = {};
  issueBodies: Record<number, string> = {};
  issueCommentsPosted: Array<[number, string]> = [];
  openIssueNumbers: number[] = [];
  createdIssues: Array<{ title: string; body: string }> = [];
  nextIssueNumber = 100;
  boardStatusCalls: Array<[number, string]> = [];
  planTriageCandidates: Issue[] = [];

  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return []; }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(n: number, s: "ready" | "inProgress" | "done"): Promise<void> {
    this.boardStatusCalls.push([n, s]);
  }
  async addLabel(n: number, l: string): Promise<void> {
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(n: number, body: string): Promise<void> { this.issueCommentsPosted.push([n, body]); }
  async getIssueBody(issue: number): Promise<string> { return this.issueBodies[issue] ?? ""; }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
    this.issueBodies[issue] = body;
  }
  async getPRReviewData(): Promise<PRReviewData> {
    return {
      headOid: "x", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false,
      labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0,
    };
  }
  async countOpenIssuesInMilestone(): Promise<number> { return 0; }
  async listMilestoneTitles(): Promise<string[]> { return []; }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> { return []; }
  async getIssueLabels(issue: number): Promise<string[]> { return this.issueLabels[issue] ?? []; }
  async getIssueComments() { return []; }
  async createIssue(title: string, body: string): Promise<number> {
    const n = this.nextIssueNumber++;
    this.createdIssues.push({ title, body });
    this.issueBodies[n] = body;
    this.openIssueNumbers.push(n);
    return n;
  }
  async listOpenIssueNumbers(): Promise<number[]> { return this.openIssueNumbers; }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> { return this.planTriageCandidates; }
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
  return sapwoodResult(
    { issues: issues.map((i) => ({ title: i.title })) },
    issues.map((i) => issueSegment(i.body)).join("\n"),
  );
};

/** A po-triage session's structured output: the entire revised body for one issue. */
const triageResultText = (issue: number, body: string): string => sapwoodResult({ issue }, body);

const doneResult = (name: string, resultText = ""): RoleSessionResult => ({
  outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name, resultText,
});
const failedResult = (name: string): RoleSessionResult => ({
  outcome: "failed", costUsd: 0.01, modelUsage: [], exitCode: 1, name,
});

/** Taps state.appendEvent so a test can assert on durable degradation events (same pattern as
 *  architect.test.ts's fable-P2 tests on PR #100). */
const tapEvents = (state: State): Array<[string, unknown]> => {
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  return logged;
};

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

// A body that satisfies extractVerificationPlan (the content check createAligningStub applies
// per created/drafted issue — a business-logic outcome, never a session-validity gate).
const PLAN_BODY = "Body.\n## Verification\n- run npm test";
const NO_PLAN_BODY = "Just a title, no plan.";

test("createAligningStub: marker present -> returns it unchanged, no forge/session calls at all (idempotence)", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([doneResult("s1")]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "aligning", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  assert.equal(forge.createdIssues.length, 0);
  state.close();
});

test("createAligningStub: dispatches the align session with the PO tool pair (PO_ALLOWED_TOOLS + PO_DISALLOWED_TOOLS), no issues declared -> returns the round's marker", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([doneResult("po-align-1", alignResultText([]))]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(5));
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]!.roleId, "po-align");
  assert.equal(runner.calls[0]!.allowedTools, PO_ALLOWED_TOOLS);
  // Security: the create-flag deny list (file exfil via --body-file, gate⓪ bypass via
  // --label, board writes via --project) must reach the session, not just exist as a const.
  assert.equal(runner.calls[0]!.disallowedTools, PO_DISALLOWED_TOOLS);
  assert.equal(state.spentUsdForWorker("po-align-1"), 0.01);
  state.close();
});

test("createAligningStub: a declared issue with a plan section gets stamped origin:agent, never needs-human, never board status", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([{ title: "Do the thing", body: PLAN_BODY }])),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 1);
  assert.deepEqual(forge.createdIssues[0], { title: "Do the thing", body: PLAN_BODY });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.boardStatusCalls.length, 0, "the PO never sets board Status=Ready");
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(comment.includes("PO alignment"));
  assert.ok(comment.includes(alignMarker(1)));
  state.close();
});

test("createAligningStub: a declared issue WITHOUT a plan section is escalated needs-human, never left silently planless", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([{ title: "Vague issue", body: NO_PLAN_BODY }])),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 2, phase: "aligning", marker: null });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"), "still stamped, even when planless");
  assert.ok(forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.boardStatusCalls.length, 0);
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(/no verification plan/.test(comment));
  state.close();
});

test("createAligningStub: multiple declared issues are each processed independently, in metadata-array order", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([
      { title: "a", body: "## Acceptance criteria\n- x" },
      { title: "b", body: "no plan here" },
    ])),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 3, phase: "aligning", marker: null });
  assert.equal(forge.openIssueNumbers.length, 2);
  assert.deepEqual(forge.createdIssues.map((i) => i.title), ["a", "b"]);
  const [a, b] = forge.openIssueNumbers as [number, number];
  assert.ok(forge.issueLabels[a]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[a]!.includes(cfg.labels.needsHuman));
  assert.ok(forge.issueLabels[b]!.includes("origin:agent"));
  assert.ok(forge.issueLabels[b]!.includes(cfg.labels.needsHuman));
  state.close();
});

test("createAligningStub: triage pass briefs a po-triage session per plan-less candidate, posts a traceable comment", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [
    { number: 50, title: "human-filed, no plan", labels: [], body: "just a description" },
  ];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([])), // align pass: declares nothing
    doneResult("po-triage-50", triageResultText(50, "just a description\n## Verification\n- run npm test")),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 6, phase: "aligning", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["po-align", "po-triage"]);
  assert.equal(runner.calls[1]!.allowedTools, PO_ALLOWED_TOOLS);
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
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 7, phase: "aligning", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["po-align", "po-triage", "po-triage"]);
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 60));
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 61));
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
  const deps: AlignDeps = { forge, state, cfg, runner };
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
    doneResult("po-align-0-retry", alignResultText([{ title: "t", body: "## Verification\n- x" }])),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
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
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 11, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(11), "the round still advances — pre-Ready, low stakes");
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["po-align", "po-align", "po-triage"], "one retry, then triage proceeds");
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
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 12, phase: "aligning", marker: null });
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["po-align", "po-triage", "po-triage"]);
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 81), "success comment after the converged retry");
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
  const deps: AlignDeps = { forge, state, cfg, runner };
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
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 14, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "not retried — schema-valid output is a DONE attempt, even if content-checked afterward");
  assert.deepEqual(forge.updateIssueBodyCalls, [[83, "still no plan here"]], "the (planless) draft is still written — the write is earned by validity, not by content");
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
  const deps: AlignDeps = { forge, state, cfg, runner };
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
    doneResult("po-align-0-retry", alignResultText([{ title: "t", body: "## Verification\n- x" }])),
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
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
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 17, phase: "aligning", marker: null });
  assert.equal(forge.updateIssueBodyCalls.length, 0);
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 90));
  const ev = logged.find(([kind]) => kind === "triage-degraded");
  assert.ok(ev);
  assert.equal((ev![1] as { issue: number }).issue, 90);
  state.close();
});

test("createAligningStub #110: an align block with a wrong number of <<<ISSUE>>> body segments is malformed, not silently truncated/misassigned", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    // Metadata declares 2 issues, but the BODY block only carries one segment.
    doneResult("po-align-0", sapwoodResult({ issues: [{ title: "a" }, { title: "b" }] }, issueSegment("only one body"))),
    doneResult("po-align-0-retry", alignResultText([{ title: "a", body: "## Verification\n- x" }])),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 18, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "the mismatched first attempt was retried");
  assert.equal(forge.createdIssues.length, 1, "only the converged retry's single issue was created");
  state.close();
});

// ── labels.originAgent is config-driven (fable PR #101 P3) ──────────────────────────────────

test("createAligningStub P3: a customized labels.originAgent value is what gets stamped — never a hardcoded 'origin:agent'", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ labels: { originAgent: "bot:made" } });
  const runner = new ScriptedRunner([
    doneResult("po-align-1", alignResultText([{ title: "t", body: "## Verification\n- x" }])),
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
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
});

test("loadPlanMd: reads a real file; a missing path degrades to empty string (contained, never throws)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-align-"));
  try {
    const p = join(dir, "PLAN.md");
    writeFileSync(p, "# The Plan\ngoals here");
    assert.equal(loadPlanMd(p), "# The Plan\ngoals here");
    assert.equal(loadPlanMd(join(dir, "nonexistent.md")), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PO_ALLOWED_TOOLS: carries issue-creation on top of the base scope, but no board-status/project capability (structural no-Ready guarantee)", () => {
  assert.ok(PO_ALLOWED_TOOLS.includes("Bash(gh issue create*)"));
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
  const result = validateAlignOutput(alignResultText([
    { title: "first", body: "Body one." },
    { title: "second", body: "Body two." },
  ]));
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.issues, [
      { title: "first", body: "Body one." },
      { title: "second", body: "Body two." },
    ]);
  }
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
