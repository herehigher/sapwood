// align.test.ts (#89): the `aligning` phase's PO peripheral — goal decomposition (creates
// issues), the round-start triage pass (drafts plans into existing plan-less issues), and
// round-marker idempotence. Fakes the underlying role session (RoleRunner) directly, same
// "fake the collaborator, not the CLI" split as plan-review.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAligningStub, alignMarker, loadPlanMd, defaultPoPromptPath, type AlignDeps,
} from "./align.js";
import { loadRolePromptTemplate } from "./plan-review.js";
import { PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS } from "./peripheral.js";
import type { RoleSessionOpts, RoleSessionResult } from "./peripheral.js";
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
 *  call consumes the next scripted result (or the last one, repeated) and, when given, applies
 *  a side effect simulating what the REAL headless session would have done. */
class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  private n = 0;
  constructor(private readonly script: Array<{ result: RoleSessionResult; effect?: (opts: RoleSessionOpts) => void }>) {}
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    const step = this.script[Math.min(this.n, this.script.length - 1)]!;
    this.n++;
    step.effect?.(opts);
    return step.result;
  }
}

const doneResult = (name: string): RoleSessionResult => ({
  outcome: "done", costUsd: 0.01, modelUsage: [], exitCode: 0, name,
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

test("createAligningStub: marker present -> returns it unchanged, no forge/session calls at all (idempotence)", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([{ result: doneResult("s1") }]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "aligning", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  assert.equal(forge.createdIssues.length, 0);
  state.close();
});

test("createAligningStub: dispatches the align session with the PO tool pair (PO_ALLOWED_TOOLS + PO_DISALLOWED_TOOLS), no created issues -> returns the round's marker", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([{ result: doneResult("po-align-1") }]); // session runs, creates nothing
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

test("createAligningStub: a PO-created issue with a plan section gets stamped origin:agent, never needs-human, never board status", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      // Simulates the real session's `gh issue create` — carries a real plan section.
      effect: async () => { await forge.createIssue("Do the thing", "Body.\n## Verification\n- run npm test"); },
    },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 1, phase: "aligning", marker: null });
  assert.equal(forge.createdIssues.length, 1);
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman));
  assert.equal(forge.boardStatusCalls.length, 0, "the PO never sets board Status=Ready");
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(comment.includes("PO alignment"));
  assert.ok(comment.includes(alignMarker(1)));
  state.close();
});

test("createAligningStub: a PO-created issue WITHOUT a plan section is escalated needs-human, never left silently planless", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      effect: async () => { await forge.createIssue("Vague issue", "Just a title, no plan."); },
    },
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

test("createAligningStub: multiple created issues are each processed independently", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      effect: async () => {
        await forge.createIssue("a", "## Acceptance criteria\n- x");
        await forge.createIssue("b", "no plan here");
      },
    },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 3, phase: "aligning", marker: null });
  assert.equal(forge.openIssueNumbers.length, 2);
  const [a, b] = forge.openIssueNumbers as [number, number];
  assert.ok(forge.issueLabels[a]!.includes("origin:agent"));
  assert.ok(!forge.issueLabels[a]!.includes(cfg.labels.needsHuman));
  assert.ok(forge.issueLabels[b]!.includes("origin:agent"));
  assert.ok(forge.issueLabels[b]!.includes(cfg.labels.needsHuman));
  state.close();
});

test("createAligningStub: an issue open BEFORE the align session ran is never mistaken for one it created", async () => {
  const forge = new FakeForge();
  forge.openIssueNumbers = [1, 2, 3]; // pre-existing open issues, unrelated to this round
  const cfg = mkCfg();
  const runner = new ScriptedRunner([{ result: doneResult("po-align-1") }]); // creates nothing new
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 4, phase: "aligning", marker: null });
  assert.equal(forge.issueCommentsPosted.length, 0, "no post-check ran against any pre-existing issue");
});

test("createAligningStub: triage pass briefs a po-triage session per plan-less candidate, posts a traceable comment", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [
    { number: 50, title: "human-filed, no plan", labels: [], body: "just a description" },
  ];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: doneResult("po-align-1") }, // align pass: creates nothing
    {
      result: doneResult("po-triage-50"),
      effect: async () => { forge.issueBodies[50] = "just a description\n## Verification\n- run npm test"; },
    },
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
    { result: doneResult("po-align-1") },
    { result: doneResult("po-triage-60"), effect: () => { forge.issueBodies[60] = "## Verification\n- a"; } },
    { result: doneResult("po-triage-61"), effect: () => { forge.issueBodies[61] = "## Verification\n- b"; } },
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
    { result: doneResult("po-align-1") },
    { result: doneResult("po-triage-70"), effect: () => { forge.issueBodies[70] = "## Verification\n- x"; } },
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

test("createAligningStub P2: a failed align session is retried once; a successful retry proceeds normally (created issues processed, both spends ledgered, no degradation event)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: failedResult("po-align-0") },
    {
      result: doneResult("po-align-0-retry"),
      effect: async () => { await forge.createIssue("t", "## Verification\n- x"); },
    },
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 10, phase: "aligning", marker: null });
  assert.equal(runner.calls.length, 2, "exactly one retry");
  assert.equal(marker, alignMarker(10));
  // The retry's creation was still discovered and stamped (the diff runs after the retry).
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes("origin:agent"));
  assert.equal(state.spentUsdForWorker("po-align-0"), 0.01);
  assert.equal(state.spentUsdForWorker("po-align-0-retry"), 0.01);
  assert.ok(!logged.some(([kind]) => kind === "po-degraded"), "a converged retry is not a degradation");
  state.close();
});

test("createAligningStub P2: two failed align sessions -> marker STILL set (next round retries naturally), po-degraded durably appended, triage still runs", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 80, title: "t", labels: [], body: "" }];
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    { result: failedResult("po-align-0") },
    { result: failedResult("po-align-0-retry") },
    { result: doneResult("po-triage-80"), effect: () => { forge.issueBodies[80] = "## Verification\n- x"; } },
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 11, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(11), "phase still externalizes — the round is never wedged");
  assert.deepEqual(runner.calls.map((c) => c.roleId), ["po-align", "po-align", "po-triage"], "one retry, then triage proceeds");
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
    { result: doneResult("po-align-1") },
    { result: failedResult("po-triage-81") },
    { result: doneResult("po-triage-81-retry"), effect: () => { forge.issueBodies[81] = "## Verification\n- x"; } },
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
    { result: doneResult("po-align-1") },
    { result: failedResult("po-triage-82") },
    { result: failedResult("po-triage-82-retry") },
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  const { marker } = await stub.run({ roundId: 13, phase: "aligning", marker: null });
  assert.equal(marker, alignMarker(13), "the round still advances — pre-Ready, low stakes");
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 82), "no comment claiming a draft that never landed");
  const ev = logged.find(([kind]) => kind === "triage-degraded");
  assert.ok(ev);
  assert.equal((ev![1] as { issue: number }).issue, 82);
  state.close();
});

test("createAligningStub P2: a 'done' triage session that left the body STILL planless posts no success comment either — post-checked, not trusted", async () => {
  const forge = new FakeForge();
  forge.planTriageCandidates = [{ number: 83, title: "t", labels: [], body: "no plan" }];
  const cfg = mkCfg();
  // Session reports success but never actually edited the body (contract violation).
  const runner = new ScriptedRunner([
    { result: doneResult("po-align-1") },
    { result: doneResult("po-triage-83") },
  ]);
  const state = new State(":memory:");
  const logged = tapEvents(state);
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 14, phase: "aligning", marker: null });
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 83), "the success comment is earned by the re-fetched body, not by exit code");
  assert.ok(logged.some(([kind]) => kind === "triage-degraded"));
  state.close();
});

// ── gate⓪-bypass containment on created issues (security review — the --label deny is only
//    the best-effort pattern layer; this post-check is the authoritative enforcement, the
//    same stance as plan-review.ts's drafter label post-check) ────────────────────────────────

test("createAligningStub sec: a created issue carrying plan:approved is contained — needs-human applied (unconditional dispatch blocker) + comment naming the poisoned label", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      // Simulates a session that slipped a self-approval past the pattern deny
      // (`gh issue create --label plan:approved`).
      effect: async () => {
        const n = await forge.createIssue("sneaky", "## Verification\n- x");
        forge.issueLabels[n] = [cfg.labels.planApproved];
      },
    },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 20, phase: "aligning", marker: null });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman), "poisoned plan:approved is contained by needs-human");
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(comment.includes(cfg.labels.planApproved), "the containment comment names the poisoned label");
  assert.ok(comment.includes(alignMarker(20)));
  state.close();
});

test("createAligningStub sec: a created issue carrying verify:n/a is likewise contained", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      effect: async () => {
        const n = await forge.createIssue("sneaky", "## Verification\n- x");
        forge.issueLabels[n] = [cfg.labels.verifyNa];
      },
    },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 21, phase: "aligning", marker: null });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman));
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(comment.includes(cfg.labels.verifyNa));
  state.close();
});

test("createAligningStub sec: a clean created issue (plan present, no dispatch-path labels) is untouched by the containment check", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      effect: async () => { await forge.createIssue("clean", "## Verification\n- x"); },
    },
  ]);
  const state = new State(":memory:");
  const deps: AlignDeps = { forge, state, cfg, runner };
  const stub = createAligningStub(deps);
  await stub.run({ roundId: 22, phase: "aligning", marker: null });
  const newIssue = forge.openIssueNumbers[0]!;
  assert.ok(!forge.issueLabels[newIssue]!.includes(cfg.labels.needsHuman), "no false-positive containment");
  const comment = forge.issueCommentsPosted.find(([n]) => n === newIssue)?.[1] ?? "";
  assert.ok(!comment.includes("outside its scope") && !comment.includes(cfg.labels.planApproved));
  state.close();
});

// ── labels.originAgent is config-driven (fable PR #101 P3) ──────────────────────────────────

test("createAligningStub P3: a customized labels.originAgent value is what gets stamped — never a hardcoded 'origin:agent'", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ labels: { originAgent: "bot:made" } });
  const runner = new ScriptedRunner([
    {
      result: doneResult("po-align-1"),
      effect: async () => { await forge.createIssue("t", "## Verification\n- x"); },
    },
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
