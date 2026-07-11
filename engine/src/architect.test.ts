// architect.test.ts (#90): the `architecting` peripheral's round design/review pass. Fakes the
// underlying role session (RoleRunner) directly — same "fake the collaborator, not the CLI"
// split plan-review.test.ts uses for its own orchestration tests. This file is about the
// ORCHESTRATION logic (candidate gathering, prompt context assembly, round-level idempotent
// marker skip, scope), not the CLI spawn mechanics (covered by peripheral.test.ts) or the
// architect session's own judgment (which is not testable — it's an LLM call).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createArchitectStub, architectMarker, defaultArchitectPromptPath, extractArchitectureChapter,
  loadArchitectureChapter, renderArchitectPrompt, type ArchitectDeps,
} from "./architect.js";
import { ROLE_ALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS, type RoleSessionOpts, type RoleSessionResult } from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";
import type { IForge, Issue, PRStatus, PRReviewData } from "./forge.js";
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
  async countOpenIssuesInMilestone(): Promise<number> { return 0; }
  async listMilestoneTitles(): Promise<string[]> { return []; }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> { return this.planReviewCandidates; }
  async getIssueLabels(issue: number): Promise<string[]> { return this.issueLabels[issue] ?? []; }
  async getIssueComments(issue: number) { return this.issueComments[issue] ?? []; }
}

/** A scripted fake of RoleRunner.run — consumes the next scripted result and, when given,
 *  applies a side effect to the forge (simulating what the REAL headless architect session
 *  would have done via its own `gh issue comment`/`gh issue edit` tool calls). */
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
  outcome: "done", costUsd: 0.02, modelUsage: [], exitCode: 0, name,
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
  const runner = new ScriptedRunner([{ result: doneResult("s1") }]);
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
  const runner = new ScriptedRunner([{ result: doneResult("s1") }]);
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
  const runner = new ScriptedRunner([{ result: doneResult("architect-1") }]);
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
    {
      result: failedResult("architect-0"),
    },
    {
      result: doneResult("architect-0-retry"),
      effect: () => forge.addIssueComment(60, `Round design note.\n\n${architectMarker(8)}`),
    },
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
  // The retried session actually externalized the note (the effect above simulated it).
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
  // ...but the degradation is deliberate and OBSERVABLE, not silent: a durable event names the
  // round and the outcome.
  const ev = logged.find(([kind]) => kind === "architect-degraded");
  assert.ok(ev, "an architect-degraded event was durably appended");
  const payload = ev![1] as { round_id: number; outcome: string };
  assert.equal(payload.round_id, 8);
  assert.equal(payload.outcome, "failed");
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
  const runner = new ScriptedRunner([
    {
      result: doneResult("architect-1"),
      effect: () => {
        // Simulates the REAL session's own gh calls: round design note on the anchor issue...
        forge.addIssueComment(20, `Round design note.\n\n${architectMarker(1)}`);
        // ...and a contradiction flag + severe label on the offending issue.
        forge.addIssueComment(21, "This issue's approach contradicts the locked producer!=merger invariant.");
        forge.addLabel(21, cfg.labels.blocked);
      },
    },
  ]);
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

test("createArchitectStub: the anchor for the round design note is the LOWEST-numbered candidate, deterministically", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [
    { number: 50, title: "c", labels: [] },
    { number: 12, title: "a", labels: [] },
    { number: 33, title: "b", labels: [] },
  ];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1") }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 2, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.ok(runner.calls[0]!.prompt.includes("#12"));
  // The prompt's designNoteIssue substitution names issue 12 specifically as the anchor target
  // (the lowest of 50/12/33) — checked via the rendered "post ... on #12" instruction text.
  assert.ok(/on #12\b/.test(runner.calls[0]!.prompt));
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
    const runner = new ScriptedRunner([{ result: doneResult("architect-1") }]);
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
  const runner = new ScriptedRunner([{ result: doneResult("architect-1") }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 4, phase: "architecting", marker: null });
  assert.equal(runner.calls[0]!.roleId, "architect");
  // No disallowedTools override was passed — peripheral.ts's RoleRunner falls back to the base
  // ROLE_DISALLOWED_TOOLS (no Read/Write/Edit/git/gh-pr/gh-api), same scope every other role
  // gets; the architect is never granted a docs-file write tool or PR visibility.
  assert.equal(runner.calls[0]!.disallowedTools, undefined);
});

test("ROLE_ALLOWED_TOOLS / ROLE_DISALLOWED_TOOLS: issues-only write scope — no file write, no git, no PR/API access", () => {
  assert.ok(ROLE_ALLOWED_TOOLS.includes("gh issue comment"));
  assert.ok(ROLE_ALLOWED_TOOLS.includes("gh issue edit"));
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
  const runner = new ScriptedRunner([{ result: doneResult("architect-1") }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 6, phase: "architecting", marker: null });
  assert.ok(/has not shipped/.test(runner.calls[0]!.prompt));
});

test("createArchitectStub: an explicitly supplied alignedGoals string reaches the prompt verbatim", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 9, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1") }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = {
    forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md",
    alignedGoals: "Focus this round on the dashboard API contract.",
  };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 6, phase: "architecting", marker: null });
  assert.ok(runner.calls[0]!.prompt.includes("Focus this round on the dashboard API contract."));
});
