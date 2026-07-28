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
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import { NO_ROUND_DIRECTIVE } from "../config/directive.js";
import { NO_DOCTRINE } from "../config/doctrine.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import { State } from "../state/state.js";
import { BODY_BLOCK_END, BODY_BLOCK_START, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import {
  type ArchitectDeps,
  architectMarker,
  createArchitectStub,
  defaultArchitectPromptPath,
  extractArchitectureChapter,
  loadArchitectureChapter,
  renderArchitectPrompt,
  validateArchitectOutput,
} from "./architect.js";
import type { ContextManifest } from "./context-manifest.js";
import {
  ARCHITECT_ALLOWED_TOOLS,
  ROLE_ALLOWED_TOOLS,
  ROLE_DISALLOWED_TOOLS,
  type RoleSessionOpts,
  type RoleSessionResult,
} from "./peripheral.js";
import { loadRolePromptTemplate } from "./plan-review.js";

class FakeForge implements IForge {
  async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  async listIssuesAbsentFromBoard() {
    return [];
  }
  async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  planReviewCandidates: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  labelsAdded: Array<[number, string]> = [];
  labelsRemoved: Array<[number, string]> = [];
  issueCommentsPosted: Array<[number, string]> = [];

  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  async getReadyIssues(): Promise<Issue[]> {
    return [];
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
    this.labelsAdded.push([n, l]);
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  async removeLabel(n: number, l: string): Promise<void> {
    this.labelsRemoved.push([n, l]);
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
 *  `<<<CONTRADICTION #N>>>`/`<<<VERDICT #N>>>` markers, #213). Mirrors plan-review.test.ts's
 *  sapwoodResult helper. `verdicts` defaults to `[]` so every pre-#213 call site (2-arg form)
 *  keeps working unchanged. */
const architectResult = (
  designNote: string,
  contradictions: Array<{ issue: number; severe: boolean; explanation: string }> = [],
  verdicts: Array<{ issue: number; verdict: "drop" | "needs-human"; reason: string }> = [],
): string => {
  const metadata = {
    contradictions: contradictions.map(({ issue, severe }) => ({ issue, severe })),
    verdicts: verdicts.map(({ issue, verdict }) => ({ issue, verdict })),
  };
  const bodyParts = [
    designNote,
    ...contradictions.map((c) => `<<<CONTRADICTION #${c.issue}>>>\n${c.explanation}`),
    ...verdicts.map((v) => `<<<VERDICT #${v.issue}>>>\n${v.reason}`),
  ];
  return (
    `${RESULT_BLOCK_START}\n${JSON.stringify(metadata)}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\n${bodyParts.join("\n")}\n${BODY_BLOCK_END}`
  );
};

const doneResult = (name: string, resultText = ""): RoleSessionResult => ({
  outcome: "done",
  costUsd: 0.02,
  modelUsage: [],
  exitCode: 0,
  name,
  resultText,
});
const failedResult = (name: string): RoleSessionResult => ({
  outcome: "failed",
  costUsd: 0.02,
  modelUsage: [],
  exitCode: 1,
  name,
});

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

/** A structurally-valid ContextManifest for #236 persistence tests — `model` doubles as a tag so
 *  the persisted json is trivially distinguishable from another fixture's. */
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
  recordedAt: "2026-07-17T00:00:01Z",
});

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
  const { marker, ranSession } = await stub.run({ roundId: 5, phase: "architecting", marker: null });
  assert.equal(marker, architectMarker(5));
  assert.equal(runner.calls.length, 0);
  assert.equal(ranSession, undefined, "#394 (F23): no session dispatched -> ranSession stays unset (round.ts reads this as false)");
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
  const { marker, ranSession } = await stub.run({ roundId: 9, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.equal(runner.calls[0]!.roleId, "architect");
  assert.equal(marker, architectMarker(9));
  assert.equal(ranSession, true, "#394 (F23): a real session dispatched -> ranSession true");
  // Spend recorded against the architect session's own name.
  assert.equal(state.spentUsdForWorker("architect-1"), 0.02);
  state.close();
});

test("createArchitectStub (#236): a done session's context manifest is persisted, keyed by (round, 'architecting', 'architect', session name, attempt 1)", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 10, title: "a", labels: [] }];
  const manifest = mkFakeManifest("architect-attempt");
  const runner = new ScriptedRunner([{ result: { ...doneResult("architect-1", architectResult("note")), contextManifest: manifest } }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 9, phase: "architecting", marker: null });
  const rows = state.listContextManifestsForRound(9);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.phase, "architecting");
  assert.equal(rows[0]?.role, "architect");
  assert.equal(rows[0]?.session, "architect-1");
  assert.equal(rows[0]?.attempt, 1);
  assert.deepEqual(JSON.parse(rows[0]?.json ?? "{}"), manifest);
  state.close();
});

// ── #251: input-manifest rows for the architect's own engine-controlled channels ───────────
//
// #231 scoped input_manifest coverage to align.ts's own dispatched channels, deliberately
// deferring architect-side channels (its own gate② F1 scoping ruling) since instrumenting them
// then would have conflicted with #236's parallel rewrite of this exact file. #251 closes that
// gap: `last-merged`, `aligned-goals`, `doctrine`, `directive`, `candidate-issues`,
// `architecture-chapter`, and `pool-digest` each get their own row, one attempt per session
// dispatch. Gate② review round 3 (Codex delta-verify F1): `truncated` is a genuine THREE-STATE
// column (schema v16->v17) — `true`/`false` for the three channels this module actually reads/
// caps itself (`candidate-issues`/`architecture-chapter`/`pool-digest`), and `null` (never a
// coerced `false`) for the four pass-through channels (`last-merged`/`aligned-goals`/`doctrine`/
// `directive`), since this module has no visibility into whether an upstream cap already
// truncated them (see architect.ts's own #251 module doc and state.ts's v16->v17 migration
// comment for why the round-2 draft's `truncated: false` assertion there was dishonest).

const contentVersionForTest = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 16);

test("createArchitectStub #251: a real session dispatch records an input-manifest row for each of the 7 engine-controlled channels, sharing one attempt number", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [
    { number: 10, title: "a", labels: [] },
    { number: 11, title: "b", labels: [] },
  ];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  // The repo's own docs/PLAN.md — same resolution as loadArchitectureChapter's own real-file test
  // below (engine/src/roles/architect.test.ts -> engine/../docs/PLAN.md) — needed here so the
  // architecture-chapter channel exercises a genuine ok:true read, not the nonexistent-path
  // fixture every other test in this file uses.
  const realPlanPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "PLAN.md");
  const deps: ArchitectDeps = {
    forge,
    state,
    cfg: mkCfg(),
    runner,
    planMdPath: realPlanPath,
    lastMerged: "Round 8 merged: #100, #101.",
    alignedGoals: "Decompose the auth module first, then billing.",
    doctrine: "Doctrine: never smuggle a label via session output.",
  };
  await createArchitectStub(deps).run({ roundId: 20, phase: "architecting", marker: null });

  const rows = state.inputManifestRows(20);
  assert.equal(
    rows.length,
    7,
    "last-merged + aligned-goals + doctrine + directive + candidate-issues + architecture-chapter + pool-digest",
  );
  assert.ok(
    rows.every((r) => r.phase === "architecting" && r.role === "architect" && r.session === "architect" && r.attempt === 1),
    "all 7 rows share the same (phase, role, session, attempt) identity",
  );

  // `truncated`'s DB column is a genuine three-state `INTEGER` (schema v16->v17: nullable, no
  // DEFAULT) — omitting the key from the object literal we WRITE round-trips as `null`, NEVER as
  // an explicit `false`. This is the regression the round-2 fixture would NOT have caught (it
  // asserted `false`, which is exactly what the pre-fix coercion bug also produced).
  const lastMergedRow = rows.find((r) => r.channel === "last-merged");
  assert.equal(lastMergedRow?.ok, true);
  assert.equal(lastMergedRow?.version, contentVersionForTest("Round 8 merged: #100, #101."));
  assert.equal(lastMergedRow?.truncated, null, "omitted, not coerced to false — the pass-through channel has no cap visibility");

  const alignedGoalsRow = rows.find((r) => r.channel === "aligned-goals");
  assert.equal(alignedGoalsRow?.ok, true);
  assert.equal(alignedGoalsRow?.version, contentVersionForTest("Decompose the auth module first, then billing."));
  assert.equal(alignedGoalsRow?.truncated, null);

  const doctrineRow = rows.find((r) => r.channel === "doctrine");
  assert.equal(doctrineRow?.ok, true);
  assert.equal(doctrineRow?.version, contentVersionForTest("Doctrine: never smuggle a label via session output."));
  assert.equal(doctrineRow?.truncated, null);

  const directiveRow = rows.find((r) => r.channel === "directive");
  assert.equal(directiveRow?.ok, true);
  assert.equal(
    directiveRow?.version,
    contentVersionForTest(NO_ROUND_DIRECTIVE),
    "no directive file configured -> the explicit placeholder",
  );
  assert.equal(directiveRow?.truncated, null);

  const architectureRow = rows.find((r) => r.channel === "architecture-chapter");
  assert.equal(architectureRow?.ok, true, "a real, readable PLAN.md -> a genuine read success");
  assert.equal(architectureRow?.version, contentVersionForTest(loadArchitectureChapter(realPlanPath)));
  assert.equal(architectureRow?.truncated, false, "this module's own read/extract, no length cap applied");

  const candidatesRow = rows.find((r) => r.channel === "candidate-issues");
  assert.equal(candidatesRow?.ok, true);
  assert.equal(candidatesRow?.total, 2);
  assert.equal(candidatesRow?.rendered, 2);
  assert.equal(candidatesRow?.omitted, 0);
  assert.equal(candidatesRow?.truncated, false);

  const poolDigestRow = rows.find((r) => r.channel === "pool-digest");
  assert.equal(poolDigestRow?.ok, true);
  assert.equal(poolDigestRow?.total, 0, "no pool members threaded in this test");
  assert.equal(poolDigestRow?.truncated, false);
  state.close();
});

test("createArchitectStub #251: a missing/unreadable PLAN.md yields architecture-chapter ok:false + detail, no fabricated version — never a knowingly-false success claim", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 10, title: "a", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  await createArchitectStub(deps).run({ roundId: 23, phase: "architecting", marker: null });
  const rows = state.inputManifestRows(23);
  const architectureRow = rows.find((r) => r.channel === "architecture-chapter");
  assert.equal(architectureRow?.ok, false);
  assert.equal(architectureRow?.version, null, "no fabricated version for a placeholder standing in for a failed read");
  assert.ok(architectureRow?.detail?.includes("/nonexistent/PLAN.md"));
  // Every OTHER channel is unaffected — a genuine read failure on ONE channel never contaminates
  // the honesty of the others.
  assert.ok(rows.find((r) => r.channel === "last-merged")?.ok);
  state.close();
});

test("createArchitectStub #251: zero drift-review candidates but a NON-EMPTY pool still records the pool-digest channel — the batch-review target that matters most for coverage", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = []; // zero candidates — an all-approved round
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note", [], [])) }]);
  const state = new State(":memory:");
  const poolIssues: Issue[] = [
    { number: 30, title: "pool member A", labels: [] },
    { number: 31, title: "pool member B", labels: [] },
  ];
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  await createArchitectStub(deps).run({ roundId: 24, phase: "architecting", marker: null });
  const rows = state.inputManifestRows(24);
  const poolDigestRow = rows.find((r) => r.channel === "pool-digest");
  assert.ok(poolDigestRow, "pool-digest is recorded even with zero candidates, as long as the pool is non-empty");
  assert.equal(poolDigestRow!.ok, true);
  assert.equal(poolDigestRow!.total, 2);
  assert.equal(poolDigestRow!.rendered, 2);
  assert.equal(poolDigestRow!.omitted, 0);
  assert.equal(poolDigestRow!.truncated, false);
  const candidatesRow = rows.find((r) => r.channel === "candidate-issues");
  assert.equal(candidatesRow?.total, 0, "candidate-issues is still recorded, just empty — this phase call DID dispatch a session");
  state.close();
});

test("createArchitectStub #251: pool-digest truncated:true when capDigest actually cuts the pool text, with an honest total and no fabricated rendered/omitted split", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note", [], [])) }]);
  const state = new State(":memory:");
  const poolIssues: Issue[] = [
    { number: 40, title: "a", labels: [], body: "x".repeat(500) },
    { number: 41, title: "b", labels: [], body: "y".repeat(500) },
  ];
  const deps: ArchitectDeps = {
    forge,
    state,
    cfg: mkCfg({ roles: { architect: { poolDigestMaxChars: 50 } } }),
    runner,
    planMdPath: "/nonexistent/PLAN.md",
    poolIssues,
  };
  await createArchitectStub(deps).run({ roundId: 25, phase: "architecting", marker: null });
  const poolDigestRow = state.inputManifestRows(25).find((r) => r.channel === "pool-digest");
  assert.equal(poolDigestRow?.ok, true);
  assert.equal(poolDigestRow?.total, 2, "the real pool size, regardless of how much of it survived the character cap");
  assert.equal(poolDigestRow?.truncated, true);
  assert.equal(poolDigestRow?.rendered, null, "capDigest is a character cut — a record-level rendered count is unknowable, never guessed");
  assert.equal(poolDigestRow?.omitted, null);
  state.close();
});

test("createArchitectStub #251: the candidate-issues manifest version changes on a title-only edit (same candidate numbers)", async () => {
  const mkDeps = (title: string): ArchitectDeps => {
    const forge = new FakeForge();
    forge.planReviewCandidates = [{ number: 10, title, labels: [] }];
    return {
      forge,
      state: new State(":memory:"),
      cfg: mkCfg(),
      runner: new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]),
      planMdPath: "/nonexistent/PLAN.md",
    };
  };
  const depsA = mkDeps("Original title");
  await createArchitectStub(depsA).run({ roundId: 1, phase: "architecting", marker: null });
  const versionA = depsA.state.inputManifestRows(1).find((r) => r.channel === "candidate-issues")!.version;
  depsA.state.close();

  const depsB = mkDeps("A completely different title"); // same candidate number, different title
  await createArchitectStub(depsB).run({ roundId: 1, phase: "architecting", marker: null });
  const versionB = depsB.state.inputManifestRows(1).find((r) => r.channel === "candidate-issues")!.version;
  depsB.state.close();

  assert.ok(versionA && versionB);
  assert.notEqual(versionA, versionB, "title drift with the SAME candidate number must still change the recorded version");
});

test("createArchitectStub #251: no candidates AND no pool -> no session dispatch -> zero input-manifest rows (the #243 F4 rule)", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([{ result: doneResult("s1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner };
  await createArchitectStub(deps).run({ roundId: 21, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 0, "no session dispatched");
  assert.equal(state.inputManifestRows(21).length, 0, "a phase call that never dispatches a session never mints a phantom attempt");
  state.close();
});

test("createArchitectStub #251: already-externalized round (marker present) -> no session, no new input-manifest rows", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 10, title: "a", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("s1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner };
  await createArchitectStub(deps).run({ roundId: 22, phase: "architecting", marker: architectMarker(22) });
  assert.equal(runner.calls.length, 0);
  assert.equal(state.inputManifestRows(22).length, 0);
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
  const runner = new ScriptedRunner([{ result: failedResult("architect-0") }, { result: failedResult("architect-0-retry") }]);
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
  state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
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
  const badText =
    `${RESULT_BLOCK_START}\n{"contradictions":[{"issue":71,"severe":false}],"verdicts":[]}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nJust a design note, no contradiction marker at all.\n${BODY_BLOCK_END}`;
  const runner = new ScriptedRunner([{ result: doneResult("architect-0", badText) }, { result: doneResult("architect-0-retry", badText) }]);
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
  const badText =
    `${RESULT_BLOCK_START}\n{"contradictions":[{"issue":72,"severe":false}],"verdicts":[]}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\n<<<CONTRADICTION #72>>>\nexplanation text\n${BODY_BLOCK_END}`;
  const runner = new ScriptedRunner([{ result: doneResult("architect-0", badText) }, { result: doneResult("architect-0-retry", badText) }]);
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
  const result = validateArchitectOutput(text, new Set([1, 2, 3]), new Set());
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
  assert.ok(template.includes("{{round.doctrine}}"), "#167: the shipped architect.md must reference the review-doctrine var");
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

test("createArchitectStub #126: with the PO role DISABLED (#127, aligning never runs) the architect is the round's designated first consumer — the directive is substituted, recorded as one directive-applied event, and archived out of the live path", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 7, title: "t", labels: [] }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-architect-directive-"));
  try {
    const directiveFile = join(dir, "DIRECTIVE.md");
    writeFileSync(directiveFile, "Weigh the payments-module candidates first.", "utf8");
    const cfg = mkCfg({ round: { directiveFile }, roles: { po: { enabled: false } } });
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

test("createArchitectStub #126 gate② I2: with the PO role ENABLED, a directive dropped mid-round (after aligning ran with none) is NOT consumed by the architect — placeholder rendered, file untouched, no event; it waits for the next round's opener", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 7, title: "t", labels: [] }];
  const dir = mkdtempSync(join(tmpdir(), "sapwood-architect-directive-"));
  try {
    const directiveFile = join(dir, "DIRECTIVE.md");
    // Dropped BETWEEN aligning and architecting: no directive-applied event exists (aligning
    // ran with no file present), but the file is now at the live path.
    writeFileSync(directiveFile, "dropped between aligning and architecting", "utf8");
    const cfg = mkCfg({ round: { directiveFile } }); // po enabled (default)
    const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
    const state = new State(":memory:");
    const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md" };
    await createArchitectStub(deps).run({ roundId: 6, phase: "architecting", marker: null });
    assert.ok(runner.calls[0]!.prompt.includes("No round directive was provided for this round."));
    assert.ok(!runner.calls[0]!.prompt.includes("dropped between aligning and architecting"), "never a half-round apply");
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 0);
    assert.equal(existsSync(directiveFile), true, "the file waits, untouched, for the next round's opener");
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
    writeFileSync(
      customPath,
      "CUSTOM PROMPT round={{round.id}} anchor={{round.designNoteIssue}} note={{round.marker}} goals={{round.alignedGoals}} chapter={{plan.architectureChapter}} candidates={{candidates.summary}} blocked={{labels.blocked}}",
    );
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

test("createArchitectStub: the architect session runs under the base issues-only DENY scope — no write/exec grant, ever", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 8, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 4, phase: "architecting", marker: null });
  assert.equal(runner.calls[0]!.roleId, "architect");
  // No disallowedTools override was passed — peripheral.ts's RoleRunner falls back to the base
  // ROLE_DISALLOWED_TOOLS (Write/Edit/MultiEdit/NotebookEdit/blanket Bash denied — no git, no
  // gh-pr, no gh-api, no file write), same scope every other role gets; the architect is never
  // granted a docs-file write tool or PR visibility. #235 PR-B: the architect IS now granted
  // Read/Grep/Glob (ROLE_ALLOWED_TOOLS, no longer "" — architect is not a special case), scoped
  // to its own worktree by #235 PR-A's guard containment, but that's an ALLOW-side change; this
  // assertion is about the (unchanged) deny half. #410: the ALLOW side is now widened by default
  // too (ARCHITECT_ALLOWED_TOOLS, WebSearch/WebFetch) — see the two dedicated tests just below.
  assert.equal(runner.calls[0]!.disallowedTools, undefined);
});

test("createArchitectStub (#410): the architect session's allowedTools is widened to ARCHITECT_ALLOWED_TOOLS (WebSearch/WebFetch) by default — mkCfg()'s default cfg carries webAccess.enabled: true", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 8, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 4, phase: "architecting", marker: null });
  assert.equal(runner.calls[0]!.allowedTools, ARCHITECT_ALLOWED_TOOLS);
});

test("createArchitectStub (#410): webAccess.enabled: false falls the architect session back to the ungranted ROLE_ALLOWED_TOOLS — no WebSearch/WebFetch reaches it", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 8, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const cfg = mkCfg({ webAccess: { enabled: false } });
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 4, phase: "architecting", marker: null });
  assert.equal(runner.calls[0]!.allowedTools, ROLE_ALLOWED_TOOLS);
});

test("ROLE_ALLOWED_TOOLS / ROLE_DISALLOWED_TOOLS: issues-only role scope — #235 PR-B: Read/Grep/Glob allowed (confined to the worktree by PR-A's guard containment), NO Bash grant at all, no file write, no git, no PR/API access", () => {
  assert.equal(
    ROLE_ALLOWED_TOOLS,
    "Read,Grep,Glob",
    "#235 PR-B: explicit read-only allow — architect is not a special case, every peripheral role gets this",
  );
  assert.ok(!ROLE_ALLOWED_TOOLS.includes("Bash("));
  assert.ok(!ROLE_ALLOWED_TOOLS.includes("Write"));
  assert.ok(!ROLE_ALLOWED_TOOLS.includes("Edit,"));
  assert.ok(!ROLE_DISALLOWED_TOOLS.includes("Read"), "#235: Read moved from deny to allow");
  assert.ok(ROLE_DISALLOWED_TOOLS.includes("Write"));
  assert.ok(ROLE_DISALLOWED_TOOLS.includes("MultiEdit"));
  assert.ok(ROLE_DISALLOWED_TOOLS.includes("NotebookEdit"));
  assert.ok(ROLE_DISALLOWED_TOOLS.split(",").includes("Bash"), "#235: a blanket deny, not a Bash(gh pr *)-shaped pattern");
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

test("extractArchitectureChapter: a zero-space matching heading starts a section but does not terminate the preceding one", () => {
  const doc = "## Architecture\nA\n##Architecture second\nB\n## Next\nN";
  assert.equal(extractArchitectureChapter(doc), "## Architecture\nA\n##Architecture second\nB");
});

test("loadArchitectureChapter: a real docs/PLAN.md resolves to a non-empty chapter mentioning locked decisions", () => {
  // The repo's own docs/PLAN.md — engine/src/roles/architect.test.ts -> engine/../docs/PLAN.md.
  const here = dirname(fileURLToPath(import.meta.url));
  const planPath = join(here, "..", "..", "..", "docs", "PLAN.md");
  const chapter = loadArchitectureChapter(planPath);
  assert.ok(chapter.startsWith("## Architecture"));
  assert.ok(!chapter.includes("not found"));
});

test("loadArchitectureChapter: missing file degrades to an explicit placeholder, never throws", () => {
  const chapter = loadArchitectureChapter("/definitely/not/a/real/path/PLAN.md");
  assert.ok(chapter.includes("not found"));
});

test("#128: a real caller (deps.planMdPath omitted) renders {{plan.architectureChapter}} from cfg.goal.file, the single resolved north-star path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-goalfile-"));
  try {
    const goalPath = join(dir, "GOAL.md");
    writeFileSync(goalPath, "# Goal\n\n## Architecture\nOnly the engine performs GitHub writes.\n");
    const forge = new FakeForge();
    forge.planReviewCandidates = [{ number: 9, title: "t", labels: [] }];
    // cfg.goal.file is config-file-relative resolved by loadConfig in a real run; here we set
    // it directly to an absolute path, mirroring what loadConfig would have produced.
    const cfg = mkCfg({ goal: { file: goalPath } });
    const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
    const state = new State(":memory:");
    const deps: ArchitectDeps = { forge, state, cfg, runner }; // no deps.planMdPath override
    const stub = createArchitectStub(deps);
    await stub.run({ roundId: 1, phase: "architecting", marker: null });
    assert.ok(runner.calls[0]!.prompt.includes("Only the engine performs GitHub writes."));
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    forge,
    state,
    cfg: mkCfg(),
    runner,
    planMdPath: "/nonexistent/PLAN.md",
    alignedGoals: "Focus this round on the dashboard API contract.",
  };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 6, phase: "architecting", marker: null });
  assert.ok(runner.calls[0]!.prompt.includes("Focus this round on the dashboard API contract."));
});

test("createArchitectStub (#132): the rendered prompt carries the no-prior-round-data placeholder when deps.lastMerged is not supplied", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 9, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 6, phase: "architecting", marker: null });
  assert.match(runner.calls[0]!.prompt, /no prior round/i);
});

test("createArchitectStub (#132): an explicitly supplied lastMerged string reaches the prompt verbatim", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 9, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = {
    forge,
    state,
    cfg: mkCfg(),
    runner,
    planMdPath: "/nonexistent/PLAN.md",
    lastMerged: "Merged outcomes from round 5: issue #21 merged via PR #55 (worker: lane-21).",
  };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 6, phase: "architecting", marker: null });
  assert.ok(runner.calls[0]!.prompt.includes("issue #21 merged via PR #55"));
});

// ── #167: {{round.doctrine}} — the third engine-assembled block, threaded like lastMerged ──────

test("createArchitectStub (#167): the rendered prompt carries the explicit NO_DOCTRINE placeholder when deps.doctrine is not supplied", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 9, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 6, phase: "architecting", marker: null });
  assert.ok(runner.calls[0]!.prompt.includes(NO_DOCTRINE));
});

test("createArchitectStub (#167): an explicitly supplied doctrine string reaches the prompt verbatim", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 9, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = {
    forge,
    state,
    cfg: mkCfg(),
    runner,
    planMdPath: "/nonexistent/PLAN.md",
    doctrine: "the disabled-consumer rule: gate a probe on whether its consumer is enabled.",
  };
  const stub = createArchitectStub(deps);
  await stub.run({ roundId: 6, phase: "architecting", marker: null });
  assert.ok(runner.calls[0]!.prompt.includes("the disabled-consumer rule: gate a probe on whether its consumer is enabled."));
});

// ── validateArchitectOutput: schema/shape validation (unit-level, mirrors plan-review.ts) ──

test("validateArchitectOutput: no structured block at all -> invalid", () => {
  const result = validateArchitectOutput("just some prose, no block", new Set([1]), new Set());
  assert.equal(result.ok, false);
});

test("validateArchitectOutput: metadata is not valid JSON -> invalid", () => {
  const text = `${RESULT_BLOCK_START}\nnot json\n${RESULT_BLOCK_END}\n${BODY_BLOCK_START}\nnote\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([1]), new Set());
  assert.equal(result.ok, false);
});

test("validateArchitectOutput: a smuggled extra field is rejected outright (.strict() schema)", () => {
  const text =
    `${RESULT_BLOCK_START}\n{"contradictions":[],"verdicts":[],"decision":"approve"}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([1]), new Set());
  assert.equal(result.ok, false);
});

test("validateArchitectOutput: no BODY block at all -> invalid (the design note is required every pass)", () => {
  const text = `${RESULT_BLOCK_START}\n{"contradictions":[],"verdicts":[]}\n${RESULT_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([1]), new Set());
  assert.equal(result.ok, false);
});

test("validateArchitectOutput #213: a missing `verdicts` field is rejected (required, like `contradictions`)", () => {
  const text = `${RESULT_BLOCK_START}\n{"contradictions":[]}\n${RESULT_BLOCK_END}\n` + `${BODY_BLOCK_START}\nnote\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([1]), new Set([1]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.match(result.reason, /verdicts/);
});

test("validateArchitectOutput: a valid no-contradictions output parses cleanly", () => {
  const text = architectResult("All good this round.");
  const result = validateArchitectOutput(text, new Set([1, 2]), new Set());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.designNote, "All good this round.");
    assert.deepEqual(result.contradictions, []);
  }
});

test("validateArchitectOutput: a valid contradiction output round-trips issue/severe/explanation", () => {
  const text = architectResult("Design note.", [{ issue: 5, severe: true, explanation: "Breaks producer!=merger." }]);
  const result = validateArchitectOutput(text, new Set([5, 6]), new Set());
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.contradictions, [{ issue: 5, severe: true, explanation: "Breaks producer!=merger." }]);
  }
});

test("validateArchitectOutput: duplicate CONTRADICTION markers for the same issue -> invalid (ambiguous)", () => {
  const text =
    `${RESULT_BLOCK_START}\n{"contradictions":[{"issue":5,"severe":false}]}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n<<<CONTRADICTION #5>>>\nfirst\n<<<CONTRADICTION #5>>>\nsecond\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([5]), new Set());
  assert.equal(result.ok, false);
});

// ── Codex review round 1: P1 duplicate metadata entries + P2 sub-delimiter containment ─────

test("validateArchitectOutput Codex P1: duplicate metadata entries for the same issue -> invalid — never applied twice with conflicting severity", () => {
  // Both sides collapse to Sets ({21} vs {21}, sizes match), so without the explicit duplicate
  // check this would fail OPEN: schema-valid, set-match-valid, candidate-set-valid — and the
  // write loop would then post #21's comment twice and apply `blocked` off whichever entry's
  // `severe` it hit. The duplication itself must be rejected.
  const text =
    `${RESULT_BLOCK_START}\n` +
    `{"contradictions":[{"issue":21,"severe":false},{"issue":21,"severe":true}],"verdicts":[]}\n` +
    `${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n<<<CONTRADICTION #21>>>\nexplanation\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([21]), new Set());
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/duplicate issue/.test(result.reason));
});

test("validateArchitectOutput Codex P2: an explanation embedding an own-line CONTRADICTION marker for another metadata-listed issue -> invalid, never a truncated/mis-associated slice", () => {
  // #5's explanation content contains an own-line `<<<CONTRADICTION #6>>>` — the split consumes
  // it as a real marker, so #5's explanation is silently truncated there and its tail would be
  // mis-associated with #6. With #6's REAL section also present, the embedded marker surfaces
  // as a duplicate #6 marker — fail closed, the whole output is invalid.
  const text =
    `${RESULT_BLOCK_START}\n` +
    `{"contradictions":[{"issue":5,"severe":false},{"issue":6,"severe":false}]}\n` +
    `${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n` +
    `<<<CONTRADICTION #5>>>\nthis explanation embeds a marker line:\n<<<CONTRADICTION #6>>>\nsmuggled tail\n` +
    `<<<CONTRADICTION #6>>>\nthe real #6 explanation\n` +
    `${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set([5, 6]), new Set());
  assert.equal(result.ok, false);
});

test("validateArchitectOutput Codex P2: an INLINE '<<<CONTRADICTION' mention inside an explanation -> invalid (sub-delimiter containment, fail closed)", () => {
  // Not own-line, so the split regex never consumes it — the substring survives into the
  // section text, which the containment rule rejects as ambiguous by construction (same
  // no-embedded-sentinels doctrine structured-output.ts applies to its own sentinels).
  const text = architectResult("Design note.", [
    { issue: 5, severe: false, explanation: "see the <<<CONTRADICTION #9>>> marker convention" },
  ]);
  const result = validateArchitectOutput(text, new Set([5]), new Set());
  assert.equal(result.ok, false);
});

test("validateArchitectOutput Codex P2: an inline '<<<CONTRADICTION' mention inside the DESIGN NOTE is rejected too", () => {
  const text = architectResult("A note quoting the <<<CONTRADICTION format inline.");
  const result = validateArchitectOutput(text, new Set([1]), new Set());
  assert.equal(result.ok, false);
});

// ── #213: architect batch review of the round pool — per-issue verdicts ───────────────────
//
// THE POOL-SET INVARIANT (validateArchitectOutput unit level) — the same fail-closed/atomic
// shape as THE CANDIDATE-SET INVARIANT above, applied to `verdicts` against a SEPARATE
// `poolNumbers` set.

test("validateArchitectOutput #213: a valid drop/needs-human verdict output round-trips issue/verdict/reason", () => {
  const text = architectResult(
    "Design note.",
    [],
    [
      { issue: 55, verdict: "drop", reason: "conflicts with #56's approach to the same module." },
      { issue: 56, verdict: "needs-human", reason: "ambiguous scope, needs a human call." },
    ],
  );
  const result = validateArchitectOutput(text, new Set(), new Set([55, 56]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.verdicts, [
      { issue: 55, verdict: "drop", reason: "conflicts with #56's approach to the same module." },
      { issue: 56, verdict: "needs-human", reason: "ambiguous scope, needs a human call." },
    ]);
  }
});

test("validateArchitectOutput #213: a verdict for an issue outside this round's pool is rejected — the reason names the offending number", () => {
  const text = architectResult("note", [], [{ issue: 999, verdict: "drop", reason: "not actually a pool member" }]);
  const result = validateArchitectOutput(text, new Set(), new Set([1, 2, 3]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/#999/.test(result.reason) && /pool/.test(result.reason));
});

test("validateArchitectOutput #213: a verdict INSIDE the candidate set but OUTSIDE the pool is still rejected — the two sets are validated independently", () => {
  const text = architectResult("note", [], [{ issue: 7, verdict: "drop", reason: "x" }]);
  // #7 is a valid CANDIDATE, but not a pool member — verdicts are validated against poolNumbers
  // only, never candidateNumbers.
  const result = validateArchitectOutput(text, new Set([7]), new Set([1, 2]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/#7/.test(result.reason));
});

test("validateArchitectOutput #213: duplicate metadata verdict entries for the same issue -> invalid", () => {
  const text =
    `${RESULT_BLOCK_START}\n` +
    `{"contradictions":[],"verdicts":[{"issue":55,"verdict":"drop"},{"issue":55,"verdict":"needs-human"}]}\n` +
    `${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n<<<VERDICT #55>>>\nreason\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set(), new Set([55]));
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/duplicate issue/.test(result.reason));
});

test("validateArchitectOutput #213: a verdict with no matching BODY VERDICT section -> invalid", () => {
  const text =
    `${RESULT_BLOCK_START}\n{"contradictions":[],"verdicts":[{"issue":55,"verdict":"drop"}]}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nJust a design note, no verdict marker at all.\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set(), new Set([55]));
  assert.equal(result.ok, false);
});

test("validateArchitectOutput #213: an unknown verdict enum value is rejected by the schema", () => {
  const text =
    `${RESULT_BLOCK_START}\n{"contradictions":[],"verdicts":[{"issue":55,"verdict":"reject"}]}\n${RESULT_BLOCK_END}\n` +
    `${BODY_BLOCK_START}\nnote\n<<<VERDICT #55>>>\nreason\n${BODY_BLOCK_END}`;
  const result = validateArchitectOutput(text, new Set(), new Set([55]));
  assert.equal(result.ok, false);
});

test("validateArchitectOutput #213: an INLINE '<<<VERDICT' mention inside a reason -> invalid (sub-delimiter containment, same doctrine as CONTRADICTION)", () => {
  const text = architectResult("note", [], [{ issue: 55, verdict: "drop", reason: "see the <<<VERDICT #9>>> marker convention" }]);
  const result = validateArchitectOutput(text, new Set(), new Set([55]));
  assert.equal(result.ok, false);
});

test("validateArchitectOutput #213: CONTRADICTION and VERDICT markers for the SAME issue number coexist without collision — independent maps, independent sets", () => {
  const text = architectResult(
    "note",
    [{ issue: 5, severe: false, explanation: "minor drift" }],
    [{ issue: 5, verdict: "drop", reason: "also a pool member this round" }],
  );
  const result = validateArchitectOutput(text, new Set([5]), new Set([5]));
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.contradictions, [{ issue: 5, severe: false, explanation: "minor drift" }]);
    assert.deepEqual(result.verdicts, [{ issue: 5, verdict: "drop", reason: "also a pool member this round" }]);
  }
});

test("validateArchitectOutput #213: one valid verdict + one out-of-pool verdict -> the WHOLE output is invalid, atomically (mirrors the candidate-set invariant's own atomicity)", () => {
  const text = architectResult(
    "note",
    [],
    [
      { issue: 55, verdict: "drop", reason: "genuinely a pool concern" },
      { issue: 999, verdict: "drop", reason: "never shown as a pool member" },
    ],
  );
  const result = validateArchitectOutput(text, new Set(), new Set([55]));
  assert.equal(result.ok, false);
});

// ── #213: createArchitectStub — verdict application, containment, degrade-open, crash-rerun ─

test("createArchitectStub #213: `drop` removes exactly cfg.labels.roundPool from that pool member and posts a reasoned comment; nothing else is touched", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const poolIssues: Issue[] = [{ number: 55, title: "conflicting task", labels: [cfg.labels.roundPool] }];
  const text = architectResult(
    "Design note.",
    [],
    [{ issue: 55, verdict: "drop", reason: "mutually conflicts with another pool member." }],
  );
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", text) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  await createArchitectStub(deps).run({ roundId: 1, phase: "architecting", marker: null });
  assert.deepEqual(forge.labelsRemoved, [[55, cfg.labels.roundPool]]);
  assert.equal(forge.labelsAdded.length, 0, "drop never adds a label — only removes the pool label");
  assert.ok(forge.issueCommentsPosted.some(([n, body]) => n === 55 && body.includes("mutually conflicts")));
  state.close();
});

test("createArchitectStub #213: `needs-human` ADDS cfg.labels.needsHuman and posts a reasoned comment — never removes the pool label", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const poolIssues: Issue[] = [{ number: 56, title: "ambiguous task", labels: [cfg.labels.roundPool] }];
  const text = architectResult("Design note.", [], [{ issue: 56, verdict: "needs-human", reason: "scope is genuinely ambiguous." }]);
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", text) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  await createArchitectStub(deps).run({ roundId: 1, phase: "architecting", marker: null });
  assert.deepEqual(forge.labelsAdded, [[56, cfg.labels.needsHuman]]);
  assert.equal(forge.labelsRemoved.length, 0, "needs-human never removes the pool label");
  assert.ok(forge.issueCommentsPosted.some(([n, body]) => n === 56 && body.includes("genuinely ambiguous")));
  state.close();
});

test("createArchitectStub #213: `pass` (an unlisted pool member) triggers ZERO writes for that issue", async () => {
  const forge = new FakeForge();
  // A separate candidate anchor keeps the (unrelated, pre-existing) design-note comment off the
  // pool members under test, so the assertions below cleanly isolate verdict-driven writes.
  forge.planReviewCandidates = [{ number: 1, title: "candidate", labels: [] }];
  const cfg = mkCfg();
  const poolIssues: Issue[] = [
    { number: 60, title: "fine task", labels: [cfg.labels.roundPool] },
    { number: 61, title: "also fine", labels: [cfg.labels.roundPool] },
  ];
  const text = architectResult("Design note.", [], []); // no verdicts at all -> every pool member passes
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", text) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  await createArchitectStub(deps).run({ roundId: 1, phase: "architecting", marker: null });
  assert.equal(forge.labelsRemoved.length, 0);
  assert.equal(forge.labelsAdded.length, 0);
  assert.equal(forge.issueCommentsPosted.filter(([n]) => n === 60 || n === 61).length, 0);
  state.close();
});

test("createArchitectStub #213: verdict schema carries NO label field — the mapping from verdict kind to label is fixed, engine-side logic (drop -> roundPool removal, needs-human -> needsHuman addition), unreachable from session output", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg({ labels: { needsHuman: "custom-needs-human", roundPool: "custom-round-pool" } });
  const poolIssues: Issue[] = [
    { number: 70, title: "a", labels: [cfg.labels.roundPool] },
    { number: 71, title: "b", labels: [cfg.labels.roundPool] },
  ];
  const text = architectResult(
    "note",
    [],
    [
      { issue: 70, verdict: "drop", reason: "x" },
      { issue: 71, verdict: "needs-human", reason: "y" },
    ],
  );
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", text) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  await createArchitectStub(deps).run({ roundId: 1, phase: "architecting", marker: null });
  // The CONFIGURED custom label names are what actually got applied — proof the mapping is
  // engine-side config-driven, not something the session's JSON could ever have named.
  assert.deepEqual(forge.labelsRemoved, [[70, "custom-round-pool"]]);
  assert.deepEqual(forge.labelsAdded, [[71, "custom-needs-human"]]);
  state.close();
});

test("createArchitectStub #213: candidates EMPTY but pool NON-EMPTY still runs the session — the pre-#213 short-circuit only checked candidates, which would have silently skipped batch review on an all-approved round", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = []; // nothing awaiting gate⓪ this round
  const cfg = mkCfg();
  const poolIssues: Issue[] = [{ number: 80, title: "already approved", labels: [cfg.labels.roundPool] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("Design note.")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  await createArchitectStub(deps).run({ roundId: 1, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 1, "the session ran despite zero candidates");
  // With zero candidates, the lowest-numbered POOL member is the design-note anchor fallback.
  assert.ok(forge.issueCommentsPosted.some(([n]) => n === 80));
  state.close();
});

test("createArchitectStub (#214): an issue that is BOTH a drift-review candidate AND a pool member (an unapproved pool member still awaiting its first gate⓪ review) gets full, independent treatment from each — a contradiction comment/blocked label AND a verdict label/comment, both applied for the SAME issue number, through the real stub wiring (not just the pure validator)", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  // #214: issue #90 is unapproved (still awaiting gate⓪) AND already pool-labelled — the widened
  // pool-candidate source (forge.getPoolEligibleIssues) makes this a completely routine overlap,
  // not an edge case — see forge.ts's selectPoolEligibleIssues / plan-review.ts's class 1+pool.
  forge.planReviewCandidates = [{ number: 90, title: "overlaps candidates and pool", labels: [cfg.labels.roundPool] }];
  const poolIssues: Issue[] = [{ number: 90, title: "overlaps candidates and pool", labels: [cfg.labels.roundPool] }];
  const text = architectResult(
    "Design note.",
    [{ issue: 90, severe: true, explanation: "breaks the locked interface boundary" }],
    [{ issue: 90, verdict: "needs-human", reason: "scope needs a human's judgment before it proceeds" }],
  );
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", text) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  await createArchitectStub(deps).run({ roundId: 1, phase: "architecting", marker: null });
  // The contradiction half: a comment naming the interface break, plus `blocked` (severe: true).
  assert.ok(forge.issueCommentsPosted.some(([n, body]) => n === 90 && body.includes("breaks the locked interface boundary")));
  assert.ok(forge.labelsAdded.some(([n, l]) => n === 90 && l === cfg.labels.blocked));
  // The verdict half: `needs-human` applied, plus its own reasoned comment — independent of the
  // contradiction write above, neither one suppressing or colliding with the other.
  assert.ok(forge.labelsAdded.some(([n, l]) => n === 90 && l === cfg.labels.needsHuman));
  assert.ok(forge.issueCommentsPosted.some(([n, body]) => n === 90 && body.includes("scope needs a human's judgment")));
  // Never a rejection: overlap between the two lists is not itself an out-of-set violation.
  assert.equal(runner.calls.length, 1);
  state.close();
});

test("createArchitectStub #213: candidates AND pool BOTH empty -> the early return is unchanged (no session, marker set)", async () => {
  const forge = new FakeForge();
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner };
  const { marker } = await createArchitectStub(deps).run({ roundId: 5, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 0);
  assert.equal(marker, architectMarker(5));
  state.close();
});

test("createArchitectStub #213: exactly ONE session runs regardless of pool size, and every pool member's number/title/body reaches the prompt", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const poolIssues: Issue[] = [
    { number: 90, title: "pool task A", labels: [cfg.labels.roundPool], body: "body A" },
    { number: 91, title: "pool task B", labels: [cfg.labels.roundPool], body: "body B" },
    { number: 92, title: "pool task C", labels: [cfg.labels.roundPool], body: "body C" },
  ];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  await createArchitectStub(deps).run({ roundId: 1, phase: "architecting", marker: null });
  assert.equal(runner.calls.length, 1);
  for (const i of poolIssues) {
    assert.ok(runner.calls[0]!.prompt.includes(`#${i.number}`));
    assert.ok(runner.calls[0]!.prompt.includes(i.title));
    assert.ok(runner.calls[0]!.prompt.includes(i.body!));
  }
  state.close();
});

test("createArchitectStub #213: an omitted deps.poolIssues renders the explicit empty-pool placeholder, never a blank substitution", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 9, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", architectResult("note")) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" }; // no poolIssues
  await createArchitectStub(deps).run({ roundId: 6, phase: "architecting", marker: null });
  assert.match(runner.calls[0]!.prompt, /pool is empty/);
});

test("createArchitectStub #213: degrade OPEN — an invalid session (twice) with a NON-EMPTY pool leaves every pool member untouched (no label/comment writes) and fires the DISTINCT `architect-review-degraded` event (round_id + reason), separate from `architect-degraded`", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg();
  const poolIssues: Issue[] = [{ number: 55, title: "t", labels: [cfg.labels.roundPool] }];
  const runner = new ScriptedRunner([
    { result: doneResult("architect-0", "just prose, no structured block at all") },
    { result: doneResult("architect-0-retry", "still no structured block") },
  ]);
  const state = new State(":memory:");
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  const { marker } = await createArchitectStub(deps).run({ roundId: 8, phase: "architecting", marker: null });
  assert.equal(marker, architectMarker(8), "the round is never wedged");
  assert.equal(forge.labelsRemoved.length, 0);
  assert.equal(forge.labelsAdded.length, 0);
  assert.equal(forge.issueCommentsPosted.length, 0, "the pool proceeds completely unfiltered — zero verdict writes");
  assert.ok(
    logged.some(([kind]) => kind === "architect-degraded"),
    "the pre-existing session-degrade event still fires",
  );
  const reviewDegraded = logged.find(([kind]) => kind === "architect-review-degraded");
  assert.ok(reviewDegraded, "a DISTINCT architect-review-degraded event fires — pool filtering was skipped");
  const payload = reviewDegraded![1] as { round_id: number; reason: string };
  assert.equal(payload.round_id, 8);
  assert.ok(payload.reason.length > 0);
  state.close();
});

test("createArchitectStub #213: degrade with an EMPTY pool never fires `architect-review-degraded` — nothing was skipped that would have mattered", async () => {
  const forge = new FakeForge();
  forge.planReviewCandidates = [{ number: 61, title: "t", labels: [] }];
  const runner = new ScriptedRunner([{ result: failedResult("architect-0") }, { result: failedResult("architect-0-retry") }]);
  const state = new State(":memory:");
  const logged: Array<[string, unknown]> = [];
  const realAppend = state.appendEvent.bind(state);
  state.appendEvent = (kind: string, payload: unknown) => {
    logged.push([kind, payload]);
    realAppend(kind, payload);
  };
  const deps: ArchitectDeps = { forge, state, cfg: mkCfg(), runner, planMdPath: "/nonexistent/PLAN.md" }; // no poolIssues -> empty
  await createArchitectStub(deps).run({ roundId: 8, phase: "architecting", marker: null });
  assert.ok(logged.some(([kind]) => kind === "architect-degraded"));
  assert.ok(!logged.some(([kind]) => kind === "architect-review-degraded"), "vacuous with an empty pool — never fired");
  state.close();
});

test("createArchitectStub #213: a FIRST-attempt success that still fails validation (never retried a second TIME by runSessionWithRetry's own hook, since isValid already forced a retry) still fires architect-review-degraded once the FINAL attempt is invalid", async () => {
  // Distinguishes this from runSessionWithRetry's OWN degradeEvent, which only fires on a
  // SECOND invalid/failed attempt — architect-review-degraded is computed independently, right
  // here in createArchitectStub, from the FINAL attempt's own validity (matching the existing
  // "first-attempt success must still be validated" comment already in this module for
  // contradictions).
  const forge = new FakeForge();
  const cfg = mkCfg();
  const poolIssues: Issue[] = [{ number: 55, title: "t", labels: [cfg.labels.roundPool] }];
  const badText = "no structured block, ever";
  const runner = new ScriptedRunner([{ result: doneResult("architect-0", badText) }, { result: doneResult("architect-0-retry", badText) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  await createArchitectStub(deps).run({ roundId: 9, phase: "architecting", marker: null });
  const ev = state.eventsAfterId(0, ["architect-review-degraded"]);
  assert.equal(ev.length, 1);
  state.close();
});

test("createArchitectStub #213 crash-rerun guard: two consecutive runs of the phase with marker:null (simulating a crash between this round's writes landing and round.ts persisting the returned marker) never re-posts the SAME issue's reason comment twice", async () => {
  const forge = new FakeForge();
  // A separate candidate anchor keeps the (unrelated, pre-existing, unprotected) design-note
  // comment off issue #55, so the counts below isolate the verdict-write receipt guard alone.
  forge.planReviewCandidates = [{ number: 1, title: "candidate", labels: [] }];
  const cfg = mkCfg();
  const poolIssues: Issue[] = [{ number: 55, title: "t", labels: [cfg.labels.roundPool] }];
  const text = architectResult("Design note.", [], [{ issue: 55, verdict: "drop", reason: "conflicts with another task." }]);
  const runner = new ScriptedRunner([
    { result: doneResult("architect-1", text) },
    { result: doneResult("architect-2", text) }, // a FRESH session on the "rerun" — same verdict
  ]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  const stub = createArchitectStub(deps);
  // First "attempt" — writes land, but (simulating the crash) the marker is never persisted
  // anywhere durable this test can see (round.ts's own persistence is outside this stub).
  await stub.run({ roundId: 1, phase: "architecting", marker: null });
  assert.equal(forge.issueCommentsPosted.filter(([n]) => n === 55).length, 1);
  assert.equal(forge.labelsRemoved.filter(([n]) => n === 55).length, 1);
  // Second "attempt" — same round, marker STILL null (the crash-rerun contract every peripheral
  // relies on): a FRESH session runs again, but the per-issue receipt from the first attempt
  // guards the write — no duplicate comment, no duplicate label removal.
  await stub.run({ roundId: 1, phase: "architecting", marker: null });
  assert.equal(
    runner.calls.length,
    2,
    "a second session DOES run (round.ts's own marker gate is what's missing in this crash window, not this stub's)",
  );
  assert.equal(forge.issueCommentsPosted.filter(([n]) => n === 55).length, 1, "the reason comment was NEVER reposted");
  assert.equal(forge.labelsRemoved.filter(([n]) => n === 55).length, 1, "the label removal was not reapplied a second time");
  state.close();
});

test("createArchitectStub #213: prompt template ships {{round.pool}} and {{labels.needsHuman}} placeholders", () => {
  const template = loadRolePromptTemplate(undefined, defaultArchitectPromptPath());
  assert.ok(template.includes("{{round.pool}}"));
  assert.ok(template.includes("{{labels.needsHuman}}"));
});

test("createArchitectStub #213 P2 fix: a transient forge failure on ONE verdict's write is CONTAINED — an `architect-verdict-lost` honesty event lands for it, the REMAINING verdict is still applied, and the phase completes (returns its marker, never throws)", async () => {
  const cfg = mkCfg();
  class FlakyRemoveLabelForge extends FakeForge {
    override async removeLabel(n: number, l: string): Promise<void> {
      if (n === 55) throw new Error("simulated transient forge failure (e.g. a one-off 500)");
      return super.removeLabel(n, l);
    }
  }
  const forge = new FlakyRemoveLabelForge();
  // A separate candidate anchor keeps the design-note comment off the pool members under test.
  forge.planReviewCandidates = [{ number: 1, title: "candidate", labels: [] }];
  const poolIssues: Issue[] = [
    { number: 55, title: "drop target (forge write fails)", labels: [cfg.labels.roundPool] },
    { number: 56, title: "needs-human target (succeeds)", labels: [cfg.labels.roundPool] },
  ];
  const text = architectResult(
    "Design note.",
    [],
    [
      { issue: 55, verdict: "drop", reason: "should be dropped, but its forge write will fail." },
      { issue: 56, verdict: "needs-human", reason: "needs a human's call." },
    ],
  );
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", text) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  const { marker } = await createArchitectStub(deps).run({ roundId: 1, phase: "architecting", marker: null });
  // The phase completed normally — one lost verdict never wedges it or aborts the rest.
  assert.equal(marker, architectMarker(1));
  // #55's LABEL write is what failed — no comment landed for it either, AND (Codex review round
  // 2, P1: the receipt is recorded AFTER the label write succeeds, not before) no receipt landed
  // for #55 — a future rerun this round would retry this exact verdict from scratch instead of
  // silently skipping it forever. A PAIRED honesty event still records the loss for this pass.
  assert.equal(forge.issueCommentsPosted.filter(([n]) => n === 55).length, 0);
  const applied55 = state.eventsAfterId(0, ["architect-verdict-applied"]).filter((e) => (e.payload as { issue: number }).issue === 55);
  assert.equal(applied55.length, 0, "no receipt landed for #55 — the label write (the load-bearing effect) never succeeded");
  const lost = state.eventsAfterId(0, ["architect-verdict-lost"]);
  assert.equal(lost.length, 1);
  const lostPayload = lost[0]!.payload as { round_id: number; issue: number; verdict: string; reason: string };
  assert.equal(lostPayload.round_id, 1);
  assert.equal(lostPayload.issue, 55);
  assert.equal(lostPayload.verdict, "drop");
  assert.ok(/simulated transient forge failure/.test(lostPayload.reason));
  // #56's verdict — AFTER the failing one in the loop — is still applied in full.
  assert.deepEqual(forge.labelsAdded, [[56, cfg.labels.needsHuman]]);
  assert.ok(forge.issueCommentsPosted.some(([n, body]) => n === 56 && body.includes("needs a human's call")));
  state.close();
});

test("createArchitectStub #213 P1 fix (Codex review round 2): a TRANSIENT label-write failure leaves NO receipt — a later phase pass (same round, marker still null) retries that exact verdict from scratch and succeeds, rather than the verdict being silently lost forever", async () => {
  const cfg = mkCfg();
  let removeLabelCalls = 0;
  class FlakyOnceForge extends FakeForge {
    override async removeLabel(n: number, l: string): Promise<void> {
      removeLabelCalls++;
      if (n === 55 && removeLabelCalls === 1) throw new Error("simulated one-off transient failure");
      return super.removeLabel(n, l);
    }
  }
  const forge = new FlakyOnceForge();
  forge.planReviewCandidates = [{ number: 1, title: "candidate", labels: [] }];
  const poolIssues: Issue[] = [{ number: 55, title: "t", labels: [cfg.labels.roundPool] }];
  const text = architectResult("Design note.", [], [{ issue: 55, verdict: "drop", reason: "conflicts with another task." }]);
  const runner = new ScriptedRunner([{ result: doneResult("architect-1", text) }, { result: doneResult("architect-2", text) }]);
  const state = new State(":memory:");
  const deps: ArchitectDeps = { forge, state, cfg, runner, planMdPath: "/nonexistent/PLAN.md", poolIssues };
  const stub = createArchitectStub(deps);
  // First pass: the label write throws -> no receipt, an architect-verdict-lost event instead.
  await stub.run({ roundId: 1, phase: "architecting", marker: null });
  assert.equal(state.eventsAfterId(0, ["architect-verdict-applied"]).length, 0, "no receipt after a failed label write");
  assert.equal(state.eventsAfterId(0, ["architect-verdict-lost"]).length, 1);
  assert.equal(forge.issueCommentsPosted.filter(([n]) => n === 55).length, 0);
  // Second pass, same round, marker still null (the crash-rerun contract): NO receipt exists, so
  // this verdict is retried from scratch — the label write now succeeds, the receipt lands, and
  // the reason comment is posted exactly once.
  await stub.run({ roundId: 1, phase: "architecting", marker: null });
  assert.equal(forge.labelsRemoved.filter(([n]) => n === 55).length, 1, "the retried label write succeeded");
  assert.equal(state.eventsAfterId(0, ["architect-verdict-applied"]).length, 1, "the receipt now lands on the retry");
  assert.equal(
    forge.issueCommentsPosted.filter(([n]) => n === 55).length,
    1,
    "the reason comment is posted exactly once, on the successful retry",
  );
  state.close();
});
