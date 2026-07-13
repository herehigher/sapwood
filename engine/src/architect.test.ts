// architect.test.ts (#90, reworked by #110 PR4): the `architecting` peripheral's round design/
// review pass. Fakes the underlying role session (RoleRunner) directly — same "fake the
// collaborator, not the CLI" split plan-review.test.ts uses for its own orchestration tests.
// This file is about the ORCHESTRATION logic (candidate gathering, prompt context assembly,
// structured-output parsing/validation, the candidate-set fail-closed invariant, round-level
// idempotent marker skip, scope), not the CLI spawn mechanics (covered by peripheral.test.ts) or
// the architect session's own judgment (which is not testable — it's an LLM call).
//
// #110 PR4 rework note: the architect session no longer touches `gh` at all — every
// RoleSessionResult a test script hands the fake runner carries a `resultText` (the session's
// structured final output, see structured-output.ts) instead of an `effect` callback that used
// to simulate a direct `gh issue comment/edit` side effect. The engine reads `resultText`,
// validates it (including the candidate-set check), and performs every forge write itself.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createArchitectStub, architectMarker, defaultArchitectPromptPath, extractArchitectureChapter,
  loadArchitectureChapter, renderArchitectPrompt, validateArchitectOutput, type ArchitectDeps,
} from "./architect.js";
import { ROLE_ALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS, type RoleSessionOpts, type RoleSessionResult } from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";
import {
  RESULT_BLOCK_START, RESULT_BLOCK_END, BODY_BLOCK_START, BODY_BLOCK_END,
} from "./structured-output.js";
import type { IForge, Issue, PRStatus, PRReviewData, CommitInfo } from "./forge.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

class FakeForge implements IForge {
  planReviewCandidates: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  labelsAdded: Array<[number, string]> = [];
  issueCommentsPosted: Array<[number, string]> = [];

  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return []; }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(n: number, l: string): Promise<void> {
    this.labelsAdded.push([n, l]);
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(n: number): Promise<PRStatus> { return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true }; }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(n: number, body: string): Promise<void> { this.issueCommentsPosted.push([n, body]); }
  async getIssueBody(): Promise<string> { return ""; }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> { this.updateIssueBodyCalls.push([issue, body]); }
  async getPRReviewData(): Promise<PRReviewData> {
    return {
      headOid: "x", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false,
      labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0,
    };
  }
  async getPRDiff(): Promise<string> { return ""; }
  async getCommitsSince(): Promise<CommitInfo[]> { return []; }
  async branchExists(): Promise<boolean> { return false; }
  async countOpenIssuesInMilestone(): Promise<number> { return 0; }
  async listMilestoneTitles(): Promise<string[]> { return []; }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> { return this.planReviewCandidates; }
  async getIssueLabels(issue: number): Promise<string[]> { return this.issueLabels[issue] ?? []; }
  async getIssueComments(issue: number) { return this.issueComments[issue] ?? []; }
}

/** A scripted fake of RoleRunner.run — each call consumes the next scripted result (or the last
 *  one, repeated) and, when given, applies a side effect purely for TEST OBSERVATION (e.g.
 *  asserting on the rendered prompt) — never a forge write anymore; the engine is what performs
 *  every forge write now, driven by resultText. */
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

/** Builds a session's structured final-message text (structured-output.ts's sentinel format)
 *  using the architect's own metadata shape + BODY sub-format (architect.ts's
 *  `<<<CONTRADICTION #N>>>` markers). Mirrors plan-review.test.ts's sapwoodResult helper. */
const architectResult = (
  designNote: string,
  contradictions: Array<{ issue: number; severe: boolean; explanation: string }> = [],
): string => {
  const metadata = { contradictions: contradictions.map(({ issue, severe }) => ({ issue, severe })) };
  const bodyParts = [
    designNote,
    ...contradictions.map((c) => `<<<CONTRADICTION #${c.issue}>>>\n${c.explanation}`),
  ];
  return `${RESULT_BLOCK_START}\n${JSON.stringify(metadata)}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\n${bodyParts.join("\n")}\n${BODY_BLOCK_END}`;
};

const doneResult = (name: string, resultText = ""): RoleSessionResult => ({
  outcome: "done", costUsd: 0.02, modelUsage: [], exitCode: 0, name, resultText,
});
const failedResult = (name: string): RoleSessionResult => ({
  outcome: "failed", costUsd: 0.02, modelUsage: [], exitCode: 1, name,
});

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

// ── round-level marker idempotence (acceptance criterion 1) ────────────────────────────────

test("createArchitectStub: marker present -> returns it unchanged, no forge call, no session run (idempotence)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 1, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("s1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createArchitectStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "architecting", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  assert.equal(forge.issueCommentsPosted.length, 0);
  state.close();
});

test("createArchitectStub: no candidates -> returns the round's marker, no session run", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([{ result: doneResult("s1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner };
  const stub = createArchitectStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "architecting", marker: null });
  assert.equal(marker, architectMarker(5));
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("createArchitectStub: runs exactly ONE session for the whole round regardless of candidate count", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [
    { number: 10, title: "a", labels: [] },
    { number: 11, title: "b", labels: [] },
    { number: 12, title: "c", labels: [] },
  ];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("Round design note.")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  const { marker } = await stub.run({ roundId: 9, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]!.roleId, "architect");
  assert.equal(marker, architectMarker(9));
  // Spend recorded against the architect session's own name.
  assert.equal(state.spentUsdForWorker("architect-1"), 0.02);
  state.close();
});

// ── session-failure handling (fable PR #100 P2) ────────────────────────────────────────────

test("createArchitectStub P2: a failed session is retried once; a successful retry proceeds normally (marker set, both sessions' spend recorded, no degradation event)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 60, title: "t", labels: [] }];
  const runner = new ScriptedRunner([
    { result: failedResult("architect-0") },
    { result: doneResult("architect-0-retry", architectResult("Round design note.")) },
  ]);
  const state = new State(":memory:");
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  const { marker } = await stub.run({ roundId: 8, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 2, "exactly one retry");
  assert.equal(marker, architectMarker(8));
  // The retried session's validated output was actually applied by the engine.
  assert.ok(forge.issueCommentsPosted.some(([n, body]) => n === 60 && body.includes(architectMarker(8))));
  // Both attempts' spend is ledgered under their own session names.
  assert.equal(state.spentUsdForWorker("architect-0"), 0.02);
  assert.equal(state.spentUsdForWorker("architect-0-retry"), 0.02);
  assert.ok(!logged.some(([kind]) => kind === "architect-degraded"), "a converged retry is not a degradation");
  state.close();
});

test("createArchitectStub P2: two failed sessions -> marker STILL set (advisory phase never wedges the round), exactly two sessions, degradation durably visible via appendEvent", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 61, title: "t", labels: [] }];
  const runner = new ScriptedRunner([
    { result: failedResult("architect-0") },
    { result: failedResult("architect-0-retry") },
  ]);
  const state = new State(":memory:");
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  const { marker } = await stub.run({ roundId: 8, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 2, "one retry, never a third attempt");
  // The marker is still set: the architect is advisory — a failed session must not wedge the
  // round or trigger an endless rerun loop of a session that keeps failing.
  assert.equal(marker, architectMarker(8));
  assert.equal(forge.issueCommentsPosted.length, 0, "no note is posted when the session never validates");
  // ...but the degradation is deliberate and OBSERVABLE, not silent: a durable event names the
  // round and the outcome.
  const ev = logged.find(([kind]) => kind === "architect-degraded");
  assert.ok(ev, "an architect-degraded event was durably appended");
  const payload = ev![1] as { round_id: number; outcome: string; reason: string };
  assert.equal(payload.round_id, 8);
  assert.equal(payload.outcome, "failed");
  assert.ok(/failed twice/.test(payload.reason));
  state.close();
});

// ── #110 PR4: malformed / schema-invalid structured output — the isValid hook ──────────────

test("createArchitectStub #110: no structured output block at all, TWICE -> degrades exactly like a session failure — no note, no writes", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 70, title: "t", labels: [] }];
  const runner = new ScriptedRunner([
    { result: doneResult("architect-0", "Looks fine to me, no notes.") },
    { result: doneResult("architect-0-retry", "still just prose, no structured block") },
  ]);
  const state = new State(":memory:");
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => { logged.push([kind, payload]); realAppend(kind, payload); };
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  const { marker } = await stub.run({ roundId: 11, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 2);
  assert.equal(marker, architectMarker(11));
  assert.equal(forge.issueCommentsPosted.length, 0);
  assert.equal(forge.labelsAdded.length, 0);
  const ev = logged.find(([kind]) => kind === "architect-degraded");
  assert.ok(ev);
  const payload = ev![1] as { reason: string };
  assert.ok(/structured output/.test(payload.reason));
  state.close();
});

test("createArchitectStub #110: metadata declares a contradiction with no matching BODY section, TWICE -> invalid, never applied", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 71, title: "t", labels: [] }];
  const badText = `${RESULT_BLOCK_START}\n{"contradictions":[{"issue":71,"severe":false}]}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nJust a design note, no contradiction marker at all.\n${BODY_BLOCK_END}`;
  const runner = new ScriptedRunner([
    { result: doneResult("architect-0", badText) },
    { result: doneResult("architect-0-retry", badText) },
  ]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 12, phase: "architecting", marker: null });
  assert.equal(forge.issueCommentsPosted.length, 0);
  assert.equal(forge.labelsAdded.length, 0);
  state.close();
});

test("createArchitectStub #110: an empty design note (BODY is only contradiction markers), TWICE -> invalid, never applied", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 72, title: "t", labels: [] }];
  const badText = `${RESULT_BLOCK_START}\n{"contradictions":[{"issue":72,"severe":false}]}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\n<<<CONTRADICTION #72>>>\nexplanation text\n${BODY_BLOCK_END}`;
  const runner = new ScriptedRunner([
    { result: doneResult("architect-0", badText) },
    { result: doneResult("architect-0-retry", badText) },
  ]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 13, phase: "architecting", marker: null });
  assert.equal(forge.issueCommentsPosted.length, 0, "no design note text before the first marker -> whole output invalid");
  state.close();
});

// ── #110 PR4: THE CANDIDATE-SET INVARIANT — fail-closed, atomic (issue #110 Design) ────────

test("validateArchitectOutput: a flagged issue outside the candidate set is rejected — the reason names the offending number", () => {
  const text = architectResult("note", [{ issue: 999, severe: false, explanation: "not a real candidate" }]);
  const result = validateArchitectOutput(text, new Set([1, 2, 3]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/#999/.test(result.reason) && /candidate set/.test(result.reason));
});

test("createArchitectStub #110: one valid + one out-of-candidate-set flag -> the WHOLE output is invalid; NOTHING is written (no partial application), even for the valid one", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [
    { number: 80, title: "in-scope", labels: [] },
    { number: 81, title: "also-in-scope", labels: [] },
  ];
  const cfg = mkCfg();
  // 81 is a real candidate (would validly flag); 999 is NOT — it never appeared in this round's
  // candidate pool at all. The whole output must be rejected, so #81's otherwise-valid flag is
  // never applied either.
  const mixedText = architectResult("Round design note.", [
    { issue: 81, severe: true, explanation: "genuinely contradicts the locked architecture" },
    { issue: 999, severe: false, explanation: "an issue never shown to this session" },
  ]);
  const runner = new ScriptedRunner([
    { result: doneResult("architect-0", mixedText) },
    { result: doneResult("architect-0-retry", mixedText) },
  ]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  const { marker } = await stub.run({ roundId: 14, phase: "architecting", marker: null });
  // Advisory degrade: marker still set, round not wedged.
  assert.equal(marker, architectMarker(14));
  // NOTHING was written — not the design note, not #81's valid-looking flag, not its label.
  assert.equal(forge.issueCommentsPosted.length, 0, "no partial application: not even the design note");
  assert.equal(forge.labelsAdded.length, 0, "no partial application: #81's blocked label is never applied either");
  assert.ok(!(forge.issueLabels[81] ?? []).includes(cfg.labels.blocked));
  state.close();
});

// ── contradiction flags + severity (acceptance criterion 2) ────────────────────────────────

test("createArchitectStub: a contradicting issue gets an explanatory comment; severe contradictions also get `blocked`", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [
    { number: 20, title: "fine", labels: [] },
    { number: 21, title: "contradicts locked architecture", labels: [] },
  ];
  const cfg = mkCfg();
  const text = architectResult("Round design note.", [
    { issue: 21, severe: true, explanation: "This issue's approach contradicts the locked producer!=merger invariant." },
  ]);
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", text) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 1, phase: "architecting", marker: null });
  assert.ok(forge.issueCommentsPosted.some(([n, body]) => n === 20 && body.includes(architectMarker(1))));
  assert.ok(forge.issueCommentsPosted.some(([n, body]) => n === 21 && /contradicts/.test(body)));
  assert.ok((forge.issueLabels[21] ?? []).includes(cfg.labels.blocked));
  // The non-contradicting issue is untouched.
  assert.equal(forge.issueLabels[20], undefined);
  state.close();
});

test("createArchitectStub: a non-severe contradiction gets a comment but NOT the blocked label", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [
    { number: 22, title: "fine", labels: [] },
    { number: 23, title: "minor disagreement", labels: [] },
  ];
  const cfg = mkCfg();
  const text = architectResult("Round design note.", [
    { issue: 23, severe: false, explanation: "Could be done differently, but not a genuine conflict." },
  ]);
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", text) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 1, phase: "architecting", marker: null });
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 23));
  assert.equal(forge.issueLabels[23], undefined, "non-severe -> no blocked label");
  state.close();
});

test("createArchitectStub: the anchor for the round design note is the LOWEST-numbered candidate, deterministically", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [
    { number: 50, title: "c", labels: [] },
    { number: 12, title: "a", labels: [] },
    { number: 33, title: "b", labels: [] },
  ];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("Round design note.")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 2, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.ok(runner.calls[0]!.prompt.includes("#12"));
  // The prompt's designNoteIssue substitution names issue 12 specifically as the anchor target
  // (the lowest of 50/12/33).
  assert.ok(runner.calls[0]!.prompt.includes("on #12"));
  // ...and the engine actually posts the note there, not on any other candidate.
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 12));
  assert.ok(!forge.issueCommentsPosted.some(([n]) => n === 50 || n === 33));
  state.close();
});

// ── prompt shipped + config override (acceptance criterion 3) ──────────────────────────────

test("defaultArchitectPromptPath: resolves to a real shipped file with the expected placeholders", () => {
  const template = loadRolePromptTemplate(undefined, defaultArchitectPromptPath());
  assert.ok(template.includes("{{round.id}}"));
  assert.ok(template.includes("{{round.marker}}"));
  assert.ok(template.includes("{{round.designNoteIssue}}"));
  assert.ok(template.includes("{{plan.architectureChapter}}"));
  assert.ok(template.includes("{{candidates.summary}}"));
  assert.ok(template.includes("{{labels.blocked}}"));
  assert.ok(template.includes("{{round.directive}}"), "#126: the shipped architect.md must reference the round directive var");
});

// ── #126: round directive file — human steering injected at round open ─────────────────────

test("createArchitectStub #126: no directive file -> the rendered prompt carries the explicit 'none' placeholder, no directive-applied event", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 7, title: "t", labels: [] }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-architect-directive-"));
  try {
    const cfg = mkCfg({ round: { directiveFile: join(dir, "DIRECTIVE.md") } });
    const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
    const state = new State(":memory:");
    const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md" };
    await createArchitectStub(deps).run({ roundId: 3, phase: "architecting", marker: null });
    assert.ok(runner.calls[0]!.prompt.includes("No round directive was provided for this round."));
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 0);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createArchitectStub #126: a directive file is substituted into the architect prompt, recorded as one directive-applied event, and archived out of the live path", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 7, title: "t", labels: [] }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-architect-directive-"));
  try {
    const directiveFile = join(dir, "DIRECTIVE.md");
    writeFileSync(directiveFile, "Weigh the payments-module candidates first.", "utf8");
    const cfg = mkCfg({ round: { directiveFile } });
    const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
    const state = new State(":memory:");
    const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md" };
    await createArchitectStub(deps).run({ roundId: 6, phase: "architecting", marker: null });
    assert.ok(runner.calls[0]!.prompt.includes("Weigh the payments-module candidates first."));
    const events = state.eventsAfterId(0, ["directive-applied"]);
    assert.equal(events.length, 1);
    const payload = events[0]!.payload as { round_id: number; content: string };
    assert.equal(payload.round_id, 6);
    assert.equal(payload.content, "Weigh the payments-module candidates first.");
    assert.equal(existsSync(directiveFile), false, "consumed: archived out of the live path");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createArchitectStub #126: when aligning already consumed this round's directive, the architect reads back the SAME event — no re-read of the (already-archived, gone) file, no duplicate event", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 7, title: "t", labels: [] }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-architect-directive-"));
  try {
    const directiveFile = join(dir, "DIRECTIVE.md");
    const cfg = mkCfg({ round: { directiveFile } });
    const state = new State(":memory:");
    // Simulate aligning's own consumption of this round's directive (align.ts calls the SAME
    // resolveRoundDirective — this test only needs the resulting durable event + archived file,
    // not align.ts itself).
    const payload = { round_id: 10, path: directiveFile, content: "steer toward payments", sha256: "a".repeat(64) };
    state.appendEvent("directive-applied", payload);

    const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
    const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md" };
    await createArchitectStub(deps).run({ roundId: 10, phase: "architecting", marker: null });
    assert.ok(runner.calls[0]!.prompt.includes("steer toward payments"));
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1, "no duplicate event");
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadRolePromptTemplate: a configured-but-missing architect promptFile throws, naming the path (fail-fast, never silent)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-architect-"));
  try {
    const missing = join(dir, "nonexistent-architect.md");
    assert.throws(
      () => loadRolePromptTemplate(missing, defaultArchitectPromptPath()),
      new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("createArchitectStub: cfg.roles.architect.promptFile override is actually loaded and rendered", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-architect-"));
  try {
    const customPath = join(dir, "custom-architect.md");
    writeFileSync(customPath, "CUSTOM PROMPT round={{round.id}} anchor={{round.designNoteIssue}} note={{round.marker}} goals={{round.alignedGoals}} chapter={{plan.architectureChapter}} candidates={{candidates.summary}} blocked={{labels.blocked}}");
    const forge = new FakeForge();
    forge.planReviewCandidates = [{ number: 7, title: "t", labels: [] }];
    const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
    const state = new State(":memory:");
    const cfg = mkCfg({ roles: { architect: { promptFile: customPath } } });
    const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md" };
    const stub = createArchitectStub(deps);
    await stub.run({ roundId: 3, phase: "architecting", marker: null });
    assert.ok(runner.calls[0]!.prompt.startsWith("CUSTOM PROMPT round=3 anchor=7"));
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── scope assertion: role write scope limited to issues (acceptance criterion 4) ───────────

test("createArchitectStub: the architect session runs under the base issues-only role scope — no widened tool grant", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 8, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 4, phase: "architecting", marker: null });
  assert.equal(runner.calls[0]!.roleId, "architect");
  // No disallowedTools override was passed — peripheral.ts's RoleRunner falls back to the base
  // ROLE_DISALLOWED_TOOLS (no Read/Write/Edit/git/gh-pr/gh-api), same scope every other role
  // gets; the architect is never granted a docs-file write tool or PR visibility. #110 PR4: the
  // architect's own prompt no longer instructs it to call `gh` at all, but the allow/deny-list
  // constants themselves are untouched (PR5's sweep, not this one's).
  assert.equal(runner.calls[0]!.disallowedTools, undefined);
});

test("ROLE_ALLOWED_TOOLS / ROLE_DISALLOWED_TOOLS: issues-only write scope — #110 PR5: NO Bash grant at all (pure computation), no file write, no git, no PR/API access", () => {
  assert.equal(ROLE_ALLOWED_TOOLS, "", "#110 PR5: the base issues-only allow-list is empty — no Bash(...) entry of any kind");
  assert.ok(!ROLE_ALLOWED_TOOLS.includes("Bash("));
  assert.ok(!ROLE_ALLOWED_TOOLS.includes("Write"));
  assert.ok(!ROLE_ALLOWED_TOOLS.includes("Edit,"));
  assert.ok(ROLE_DISALLOWED_TOOLS.includes("Read"));
  assert.ok(ROLE_DISALLOWED_TOOLS.includes("Write"));
  assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(git *)"));
  assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(gh pr *)"));
  assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(gh api *)"));
});

// ── context assembly (architecture chapter, aligned goals, prompt rendering) ───────────────

test("extractArchitectureChapter: extracts the '## Architecture' heading through the next equal-or-shallower heading", () => {
  const doc = "# Title\n\n## Context\nirrelevant\n\n## Architecture (v1)\nsome decisions\nmore text\n\n## Security\nirrelevant too\n";
  const chapter = extractArchitectureChapter(doc);
  assert.ok(chapter);
  assert.ok(chapter!.startsWith("## Architecture (v1)"));
  assert.ok(chapter!.includes("some decisions"));
  assert.ok(!chapter!.includes("Security"));
  assert.ok(!chapter!.includes("Context\nirrelevant"));
});

test("extractArchitectureChapter: no matching heading -> null (caller supplies the fallback, never the whole file)", () => {
  assert.equal(extractArchitectureChapter("# Title\n\n## Something Else\ntext\n"), null);
});

test("loadArchitectureChapter: a real docs/PLAN.md resolves to a non-empty chapter mentioning locked decisions", () => {
  // The repo's own docs/PLAN.md — engine/src/architect.test.ts -> engine/../docs/PLAN.md.
  const here = dirname(fileURLToPath(import.meta.url));
  const planPath = join(here, "..", "..", "docs", "PLAN.md");
  const chapter = loadArchitectureChapter(planPath);
  assert.ok(chapter.startsWith("## Architecture"));
  assert.ok(!chapter.includes("not found"));
});

test("loadArchitectureChapter: missing file degrades to an explicit placeholder, never throws", () => {
  const chapter = loadArchitectureChapter("/definitely/not/a/real/path/PLAN.md");
  assert.ok(chapter.includes("not found"));
});

test("renderArchitectPrompt: substitutes every var; fails closed on an unknown var", () => {
  const out = renderArchitectPrompt("{{a}}-{{b}}", { a: "1", b: "2" });
  assert.equal(out, "1-2");
  assert.throws(() => renderArchitectPrompt("{{nope}}", { a: "1" }), /unknown variable/);
});

test("createArchitectStub: the rendered prompt carries the aligned-goals placeholder when none is supplied (#89 not shipped yet)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 9, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 6, phase: "architecting", marker: null });
  assert.ok(/has not shipped/.test(runner.calls[0]!.prompt));
});

test("createArchitectStub: an explicitly supplied alignedGoals string reaches the prompt verbatim", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 9, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = {
    forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md",
    alignedGoals: "Focus this round on the dashboard API contract.",
  };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 6, phase: "architecting", marker: null });
  assert.ok(runner.calls[0]!.prompt.includes("Focus this round on the dashboard API contract."));
});

// ── validateArchitectOutput: schema/shape validation (unit-level, mirrors plan-review.ts) ──

test("validateArchitectOutput: no structured block at all -> invalid", () => {
  const result = validateArchitectOutput("just some prose, no block", new Set([1]));
  assert.equal(result.ok, false);
});

test("validateArchitectOutput: metadata is not valid JSON -> invalid", () => {
  const text = `${RESULT_BLOCK_START}\nnot json\n${RESULT_BLOCK_END}\n${BODY_BLOCK_START}\nnote\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([1]));
  assert.equal(result.ok, false);
});

test("validateArchitectOutput: a smuggled extra field is rejected outright (.strict() schema)", () => {
  const text = `${RESULT_BLOCK_START}\n{"contradictions":[],"decision":"approve"}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([1]));
  assert.equal(result.ok, false);
});

test("validateArchitectOutput: no BODY block at all -> invalid (the design note is required every pass)", () => {
  const text = `${RESULT_BLOCK_START}\n{"contradictions":[]}\n${RESULT_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([1]));
  assert.equal(result.ok, false);
});

test("validateArchitectOutput: a valid no-contradictions output parses cleanly", () => {
  const text = architectResult("All good this round.");
  const result = validateArchitectOutput(text, new Set([1, 2]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.designNote, "All good this round.");
    assert.deepEqual(result.contradictions, []);
  }
});

test("validateArchitectOutput: a valid contradiction output round-trips issue/severe/explanation", () => {
  const text = architectResult("Design note.", [
    { issue: 5, severe: true, explanation: "Breaks producer!=merger." },
  ]);
  const result = validateArchitectOutput(text, new Set([5, 6]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.contradictions, [{ issue: 5, severe: true, explanation: "Breaks producer!=merger." }]);
  }
});

test("validateArchitectOutput: duplicate CONTRADICTION markers for the same issue -> invalid (ambiguous)", () => {
  const text = `${RESULT_BLOCK_START}\n{"contradictions":[{"issue":5,"severe":false}]}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n<<<CONTRADICTION #5>>>\nfirst\n<<<CONTRADICTION #5>>>\nsecond\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([5]));
  assert.equal(result.ok, false);
});

// ── Codex review round 1: P1 duplicate metadata entries + P2 sub-delimiter containment ─────

test("validateArchitectOutput Codex P1: duplicate metadata entries for the same issue -> invalid — never applied twice with conflicting severity", () => {
  // Both sides collapse to Sets ({21} vs {21}, sizes match), so without the explicit duplicate
  // check this would fail OPEN: schema-valid, set-match-valid, candidate-set-valid — and the
  // write loop would then post #21's comment twice and apply `blocked` off whichever entry's
  // `severe` it hit. The duplication itself must be rejected.
  const text = `${RESULT_BLOCK_START}\n` +
    `{"contradictions":[{"issue":21,"severe":false},{"issue":21,"severe":true}]}\n` +
    `${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n<<<CONTRADICTION #21>>>\nexplanation\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([21]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/duplicate issue/.test(result.reason));
});

test("validateArchitectOutput Codex P2: an explanation embedding an own-line CONTRADICTION marker for another metadata-listed issue -> invalid, never a truncated/mis-associated slice", () => {
  // #5's explanation content contains an own-line `<<<CONTRADICTION #6>>>` — the split consumes
  // it as a real marker, so #5's explanation is silently truncated there and its tail would be
  // mis-associated with #6. With #6's REAL section also present, the embedded marker surfaces
  // as a duplicate #6 marker — fail closed, the whole output is invalid.
  const text = `${RESULT_BLOCK_START}\n` +
    `{"contradictions":[{"issue":5,"severe":false},{"issue":6,"severe":false}]}\n` +
    `${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n` +
    `<<<CONTRADICTION #5>>>\nthis explanation embeds a marker line:\n<<<CONTRADICTION #6>>>\nsmuggled tail\n` +
    `<<<CONTRADICTION #6>>>\nthe real #6 explanation\n` +
    `${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([5, 6]));
  assert.equal(result.ok, false);
});

test("validateArchitectOutput Codex P2: an INLINE '<<<CONTRADICTION' mention inside an explanation -> invalid (sub-delimiter containment, fail closed)", () => {
  // Not own-line, so the split regex never consumes it — the substring survives into the
  // section text, which the containment rule rejects as ambiguous by construction (same
  // no-embedded-sentinels doctrine structured-output.ts applies to its own sentinels).
  const text = architectResult("Design note.", [
    { issue: 5, severe: false, explanation: "see the <<<CONTRADICTION #9>>> marker convention" },
  ]);
  const result = validateArchitectOutput(text, new Set([5]));
  assert.equal(result.ok, false);
});

test("validateArchitectOutput Codex P2: an inline '<<<CONTRADICTION' mention inside the DESIGN NOTE is rejected too", () => {
  const text = architectResult("A note quoting the <<<CONTRADICTION format inline.");
  const result = validateArchitectOutput(text, new Set([1]));
  assert.equal(result.ok, false);
});
