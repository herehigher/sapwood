import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema } from "../config/config.js";
import type { IForge, PRTopLevelComment } from "../forge/forge.js";
import { MergeDriver } from "../roles/merge-driver.js";
import { State } from "../state/state.js";
import { buildAcSnapshot } from "./ac-snapshot.js";
import { makeProductionEngineAgent, sweepReviewTrees } from "./production.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

// ── #489: the decisive engine-agent verdict is announced in the durable event stream ─────────
// One harness, both outcomes: the ONLY difference between an approved and a rejected run here is
// what the session's structured result says, so the two tests below share this seam rather than
// duplicating the ~80-line config -> construction -> drive -> audit wiring a third and fourth time.

const ENGINE_REVIEW_VERDICT = "engine-review-verdict";

async function driveVerdictSeam(opts: {
  tag: string;
  runId: string;
  acStatuses: ("confirmed" | "cannot-confirm" | "claim-accepted")[];
  findings: Record<string, unknown>[];
}): Promise<{ state: State; cleanup: () => void }> {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    worker: { model: "sonnet" },
    reviewer: { mode: "engine-agent", agent: { model: "opus" } },
    ci: { requiredChecks: [{ name: "test", app: "github-actions" }] },
  });
  const H = "a".repeat(40);
  const B = "b".repeat(40);
  const body = "## Acceptance criteria\n\n- [ ] Works correctly\n- [ ] Handles errors\n";
  const snapshot = buildAcSnapshot(12, body, "2026-01-01T00:00:00Z");
  assert.ok(snapshot);
  assert.equal(snapshot!.manifest.length, opts.acStatuses.length);
  const state = new State(":memory:");
  const gcParent = mkdtempSync(join(tmpdir(), `sapwood-review-${opts.tag}-`));
  state.recordAcSnapshot(snapshot!);
  state.upsertWorker({
    name: "lane-12",
    issue: 12,
    session_id: "worker-session",
    state: "driving",
    started_at: "t",
    ended_at: null,
    pr: 7,
  });
  state.recordWorkerActualModel("lane-12", "sonnet");
  const comments: PRTopLevelComment[] = [];
  const reviewData = {
    headOid: H,
    author: "producer",
    state: "OPEN" as const,
    isDraft: false,
    labels: [],
    unresolvedThreads: 0,
    reviews: [],
    comments: [],
    reactions: [],
  };
  const forge = {
    getPRStatus: async () => ({ state: "OPEN", headOid: H, baseOid: B, ciGreen: true, mergeable: "MERGEABLE" }),
    getPRReviewData: async () => reviewData,
    getPRDiff: async () =>
      "diff --git a/src/foo.ts b/src/foo.ts\nindex 1111111..2222222 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    getPRChangedFiles: async () => ({ files: [], complete: true }),
    getPRChecks: async () => ({
      checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: "github-actions" }],
      total: 1,
    }),
    getPRComments: async () => ({ comments, total: comments.length }),
    addPRComment: async (_pr: number, commentBody: string) => {
      comments.push({ id: `IC${comments.length + 1}`, login: "sapwood", createdAt: "2026-01-01T00:00:01Z", body: commentBody });
    },
    mergePR: async () => {},
  } as unknown as IForge;
  const resultText = `<<<SAPWOOD_RESULT>>>\n${JSON.stringify({
    perAC: snapshot!.manifest.map((a, i) => ({ id: a.id, status: opts.acStatuses[i] })),
    findings: opts.findings,
  })}\n<<<END_SAPWOOD_RESULT>>>`;
  const runner = {
    run: async () => ({
      outcome: "done" as const,
      costUsd: 0.1,
      costKnown: true,
      exitCode: 0,
      name: "role-engine-reviewer-test",
      resultText,
      modelUsage: [{ model: "opus", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    }),
  };
  const production = makeProductionEngineAgent(cfg, forge, state, runner, {
    now: () => new Date("2026-01-01T00:00:00Z"),
    newRunId: () => opts.runId,
    reviewTreeRoot: join(gcParent, "trees"),
    materializeOverride: async (head) => ({
      kind: "materialized",
      treeDir: "/private/tree",
      oid: head,
      manifest: [{ path: "x", contentHash: "c" }],
    }),
  });
  const driver = new MergeDriver({ forge, reviewer: production.reviewer, cfg, fallbackReviewers: [] });
  await driver.driveOne(
    7,
    12,
    { head: null, at: null },
    () => {},
    undefined,
    false,
    undefined,
    production.driveDepsForLane(state.getWorker("lane-12")!, 7),
  );
  return {
    state,
    cleanup: () => {
      state.close();
      rmSync(gcParent, { recursive: true, force: true });
    },
  };
}

test("#489 a decisive REJECTED engine-agent verdict appends exactly one event carrying lane/PR/head/run/outcome and its finding + AC counts", async () => {
  const seam = await driveVerdictSeam({
    tag: "verdict-rejected",
    runId: "run-489-rejected",
    acStatuses: ["confirmed", "cannot-confirm"],
    findings: [
      { id: "f1", body: "a real defect", path: "src/foo.ts" },
      { id: "f2", body: "a style nit", severity: "advisory", kind: "style" },
    ],
  });
  try {
    const events = seam.state.eventsSince("1970-01-01T00:00:00.000Z", [ENGINE_REVIEW_VERDICT]);
    assert.equal(events.length, 1, "exactly one verdict event per decisive review run");
    assert.deepEqual(events[0]!.payload, {
      worker: "lane-12",
      issue: 12,
      pr: 7,
      head: "a".repeat(40),
      runId: "run-489-rejected",
      outcome: "rejected",
      findingCount: 2,
      perAC: { confirmed: 1, "cannot-confirm": 1, "claim-accepted": 0 },
    });
  } finally {
    seam.cleanup();
  }
});

test("#489 a decisive APPROVED engine-agent verdict emits the same event — the approved side of gate② is no less visible", async () => {
  const seam = await driveVerdictSeam({
    tag: "verdict-approved",
    runId: "run-489-approved",
    acStatuses: ["confirmed", "confirmed"],
    findings: [],
  });
  try {
    const events = seam.state.eventsSince("1970-01-01T00:00:00.000Z", [ENGINE_REVIEW_VERDICT]);
    assert.equal(events.length, 1);
    assert.deepEqual(events[0]!.payload, {
      worker: "lane-12",
      issue: 12,
      pr: 7,
      head: "a".repeat(40),
      runId: "run-489-approved",
      outcome: "approved",
      findingCount: 0,
      perAC: { confirmed: 2, "cannot-confirm": 0, "claim-accepted": 0 },
    });
  } finally {
    seam.cleanup();
  }
});

test("#489 crash shape: the LOG-FIRST append is deduped from the log itself — a replayed run emits once, a NEW run still emits its own", () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-review-verdict-dedup-"));
  const state = new State(":memory:");
  const head = "a".repeat(40);
  try {
    state.upsertWorker({ name: "lane-a", issue: 1, session_id: "s-a", state: "driving", started_at: "t", ended_at: null, pr: 2 });
    state.recordEngineReviewWal("lane-a", { runId: "run-a", head, base: "b".repeat(40), diffHash: "d-a", attemptStart: "t" });
    const cfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 1 },
      worker: { model: "sonnet" },
      reviewer: { mode: "engine-agent", agent: { model: "opus" } },
    });
    const production = makeProductionEngineAgent(
      cfg,
      {} as IForge,
      state,
      { run: async () => assert.fail("not called") },
      { now: realClock, reviewTreeRoot: root },
    );
    const deps = production.driveDepsForLane(state.getWorker("lane-a")!, 2);
    // The engine died between the event append and the WAL write; the replay repeats the call.
    deps.recordWalDecisiveOutcome("run-a", "rejected");
    deps.recordWalDecisiveOutcome("run-a", "rejected");
    const events = state.eventsSince("1970-01-01T00:00:00.000Z", [ENGINE_REVIEW_VERDICT]);
    assert.equal(events.length, 1, "replaying the same run must not double-emit");
    assert.equal((events[0]!.payload as { runId: string }).runId, "run-a");

    // A later attempt on a new head is a genuinely new verdict, not a duplicate of the old one.
    state.recordEngineReviewWal("lane-a", {
      runId: "run-b",
      head: "c".repeat(40),
      base: "b".repeat(40),
      diffHash: "d-b",
      attemptStart: "t",
    });
    deps.recordWalDecisiveOutcome("run-b", "approved");
    assert.deepEqual(
      state.eventsSince("1970-01-01T00:00:00.000Z", [ENGINE_REVIEW_VERDICT]).map((e) => (e.payload as { runId: string }).runId),
      ["run-a", "run-b"],
    );
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("#314 review-tree sweep bounds repeated attempts to the configured cap", () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-review-trees-"));
  try {
    for (let i = 1; i <= 8; i++) {
      const pending = join(root, `${oid(i)}-attempt-${i}`);
      sweepReviewTrees({ treeRoot: root, retentionCap: 3, liveHeads: [], pendingTreeDir: pending });
      mkdirSync(pending);
      utimesSync(pending, i, i);
    }
    assert.equal(readdirSync(root).length, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#314 review-tree sweep retains a NULL-outcome WAL head even when it is older than the cap", () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-review-trees-"));
  const liveHead = "a".repeat(40);
  try {
    const liveTree = join(root, `${liveHead}-escalated`);
    const orphan = join(root, `${"b".repeat(40)}-orphan`);
    mkdirSync(liveTree);
    mkdirSync(orphan);
    utimesSync(liveTree, 1, 1);
    utimesSync(orphan, 2, 2);
    const pending = join(root, `${"c".repeat(40)}-pending`);

    sweepReviewTrees({ treeRoot: root, retentionCap: 1, liveHeads: [liveHead], pendingTreeDir: pending });
    mkdirSync(pending);

    assert.ok(readdirSync(root).includes(`${liveHead}-escalated`));
    assert.equal(readdirSync(root).includes(`${"b".repeat(40)}-orphan`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("#314 decisive-outcome production hook retains same-head trees until every lane is decisive", () => {
  const root = mkdtempSync(join(tmpdir(), "sapwood-review-trees-"));
  const state = new State(":memory:");
  const head = "a".repeat(40);
  const other = "b".repeat(40);
  try {
    mkdirSync(join(root, `${head}-one`));
    mkdirSync(join(root, `${head}-two`));
    mkdirSync(join(root, `${other}-keep`));
    state.upsertWorker({ name: "lane-a", issue: 1, session_id: "s-a", state: "driving", started_at: "t", ended_at: null, pr: 2 });
    state.upsertWorker({ name: "lane-b", issue: 2, session_id: "s-b", state: "driving", started_at: "t", ended_at: null, pr: 3 });
    state.recordEngineReviewWal("lane-a", { runId: "run-a", head, base: other, diffHash: "d-a", attemptStart: "t" });
    state.recordEngineReviewWal("lane-b", { runId: "run-b", head, base: other, diffHash: "d-b", attemptStart: "t" });
    const cfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 1 },
      worker: { model: "sonnet" },
      reviewer: { mode: "engine-agent", agent: { model: "opus" } },
    });
    const production = makeProductionEngineAgent(
      cfg,
      {} as IForge,
      state,
      { run: async () => assert.fail("not called") },
      { now: realClock, reviewTreeRoot: root },
    );
    production.driveDepsForLane(state.getWorker("lane-a")!, 2).recordWalDecisiveOutcome("run-a", "rejected");
    assert.deepEqual(readdirSync(root).sort(), [`${head}-one`, `${head}-two`, `${other}-keep`].sort());

    production.driveDepsForLane(state.getWorker("lane-b")!, 3).recordWalDecisiveOutcome("run-b", "approved");
    assert.deepEqual(readdirSync(root), [`${other}-keep`]);
  } finally {
    state.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("#288 production seam: config -> construction -> drive -> audit receipt -> merge consume", async () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    worker: { model: "sonnet" },
    reviewer: { mode: "engine-agent", agent: { model: "opus" } },
    ci: { requiredChecks: [{ name: "test", app: "github-actions" }] },
  });
  const H = "a".repeat(40);
  const B = "b".repeat(40);
  const body = "## Acceptance criteria\n\n- [ ] Works correctly\n";
  const snapshot = buildAcSnapshot(12, body, "2026-01-01T00:00:00Z");
  assert.ok(snapshot);
  const state = new State(":memory:");
  const gcParent = mkdtempSync(join(tmpdir(), "sapwood-review-gc-failure-"));
  const gcRoot = join(gcParent, "trees");
  writeFileSync(gcRoot, "not a directory\n");
  const gcLogs: string[] = [];
  state.recordAcSnapshot(snapshot!);
  state.upsertWorker({
    name: "lane-12",
    issue: 12,
    session_id: "worker-session",
    state: "driving",
    started_at: "t",
    ended_at: null,
    pr: 7,
  });
  state.recordWorkerActualModel("lane-12", "sonnet");
  const comments: PRTopLevelComment[] = [];
  let merged = 0;
  const reviewData = {
    headOid: H,
    author: "producer",
    state: "OPEN" as const,
    isDraft: false,
    labels: [],
    unresolvedThreads: 0,
    reviews: [],
    comments: [],
    reactions: [],
  };
  const forge = {
    getPRStatus: async () => ({ state: "OPEN", headOid: H, baseOid: B, ciGreen: true, mergeable: "MERGEABLE" }),
    getPRReviewData: async () => reviewData,
    getPRDiff: async () => "diff --git a/x b/x\n+ok\n",
    getPRChangedFiles: async () => ({ files: [], complete: true }),
    getPRChecks: async () => ({
      checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: "github-actions" }],
      total: 1,
    }),
    getPRComments: async () => ({ comments, total: comments.length }),
    addPRComment: async (_pr: number, commentBody: string) => {
      comments.push({ id: `IC${comments.length + 1}`, login: "sapwood", createdAt: "2026-01-01T00:00:01Z", body: commentBody });
    },
    mergePR: async () => {
      merged++;
    },
  } as unknown as IForge;
  const resultText = `<<<SAPWOOD_RESULT>>>\n${JSON.stringify({ perAC: snapshot!.manifest.map((a) => ({ id: a.id, status: "confirmed" })), findings: [] })}\n<<<END_SAPWOOD_RESULT>>>`;
  const runner = {
    run: async () => ({
      outcome: "done" as const,
      costUsd: 0.1,
      costKnown: true,
      exitCode: 0,
      name: "role-engine-reviewer-test",
      resultText,
      modelUsage: [{ model: "opus", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    }),
  };
  const production = makeProductionEngineAgent(cfg, forge, state, runner, {
    now: () => new Date("2026-01-01T00:00:00Z"),
    newRunId: () => "run-production",
    reviewTreeRoot: gcRoot,
    log: (message) => gcLogs.push(message),
    materializeOverride: async (head) => ({
      kind: "materialized",
      treeDir: "/private/tree",
      oid: head,
      manifest: [{ path: "x", contentHash: "c" }],
    }),
  });
  const driver = new MergeDriver({ forge, reviewer: production.reviewer, cfg, fallbackReviewers: [] });
  const worker = state.getWorker("lane-12")!;
  const outcome = await driver.driveOne(
    7,
    12,
    { head: null, at: null },
    () => {},
    undefined,
    false,
    undefined,
    production.driveDepsForLane(worker, 7),
  );
  assert.equal(outcome.kind, "merged");
  assert.equal(merged, 1);
  assert.equal(comments.length, 1);
  assert.match(comments[0]!.body, /sapwood-audit kind=engine-agent/);
  assert.equal(state.getEngineReviewWal("lane-12")?.auditCommentId, "IC1");
  assert.ok(
    gcLogs.some((line) => line.includes("failed (non-fatal)")),
    "GC failure was swallowed and logged while review completed",
  );
  state.close();
  rmSync(gcParent, { recursive: true, force: true });
});

// ── #472 fix round (gate② P1): the SAME production seam above, proving the two fixed items
// through the REAL config -> construction -> drive -> WAL-persist pipeline (not
// engine-agent.test.ts's own EngineAgentReviewer-level fakes) — the issue's own verification plan
// item 10 names both engine-agent.test.ts AND production.test.ts.

test("#472 production seam: a finding's path genuinely in the reviewed diff reaches the persisted WAL artifact RETAINED, not dropped", async () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    worker: { model: "sonnet" },
    reviewer: { mode: "engine-agent", agent: { model: "opus" } },
    ci: { requiredChecks: [{ name: "test", app: "github-actions" }] },
  });
  const H = "a".repeat(40);
  const B = "b".repeat(40);
  const body = "## Acceptance criteria\n\n- [ ] Works correctly\n";
  const snapshot = buildAcSnapshot(12, body, "2026-01-01T00:00:00Z");
  assert.ok(snapshot);
  const state = new State(":memory:");
  const gcParent = mkdtempSync(join(tmpdir(), "sapwood-review-gc-472-"));
  const gcRoot = join(gcParent, "trees");
  state.recordAcSnapshot(snapshot!);
  state.upsertWorker({
    name: "lane-12",
    issue: 12,
    session_id: "worker-session",
    state: "driving",
    started_at: "t",
    ended_at: null,
    pr: 7,
  });
  state.recordWorkerActualModel("lane-12", "sonnet");
  const comments: PRTopLevelComment[] = [];
  const reviewData = {
    headOid: H,
    author: "producer",
    state: "OPEN" as const,
    isDraft: false,
    labels: [],
    unresolvedThreads: 0,
    reviews: [],
    comments: [],
    reactions: [],
  };
  // The diff genuinely touches "src/foo.ts" — the SAME path the session's finding names below.
  const forge = {
    getPRStatus: async () => ({ state: "OPEN", headOid: H, baseOid: B, ciGreen: true, mergeable: "MERGEABLE" }),
    getPRReviewData: async () => reviewData,
    getPRDiff: async () =>
      "diff --git a/src/foo.ts b/src/foo.ts\nindex 1111111..2222222 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n",
    getPRChangedFiles: async () => ({ files: [], complete: true }),
    getPRChecks: async () => ({
      checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: "github-actions" }],
      total: 1,
    }),
    getPRComments: async () => ({ comments, total: comments.length }),
    addPRComment: async (_pr: number, commentBody: string) => {
      comments.push({ id: `IC${comments.length + 1}`, login: "sapwood", createdAt: "2026-01-01T00:00:01Z", body: commentBody });
    },
    mergePR: async () => {},
  } as unknown as IForge;
  const resultText = `<<<SAPWOOD_RESULT>>>\n${JSON.stringify({
    perAC: snapshot!.manifest.map((a) => ({ id: a.id, status: "confirmed" })),
    findings: [{ id: "f1", body: "a real defect", path: "src/foo.ts" }],
  })}\n<<<END_SAPWOOD_RESULT>>>`;
  const runner = {
    run: async () => ({
      outcome: "done" as const,
      costUsd: 0.1,
      costKnown: true,
      exitCode: 0,
      name: "role-engine-reviewer-test",
      resultText,
      modelUsage: [{ model: "opus", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    }),
  };
  const production = makeProductionEngineAgent(cfg, forge, state, runner, {
    now: () => new Date("2026-01-01T00:00:00Z"),
    newRunId: () => "run-472-a",
    reviewTreeRoot: gcRoot,
    materializeOverride: async (head) => ({
      kind: "materialized",
      treeDir: "/private/tree",
      oid: head,
      manifest: [{ path: "x", contentHash: "c" }],
    }),
  });
  const driver = new MergeDriver({ forge, reviewer: production.reviewer, cfg, fallbackReviewers: [] });
  const worker = state.getWorker("lane-12")!;
  await driver.driveOne(7, 12, { head: null, at: null }, () => {}, undefined, false, undefined, production.driveDepsForLane(worker, 7));

  const wal = state.getEngineReviewWal("lane-12");
  assert.ok(wal?.reviewArtifactJson, "expected a persisted review artifact");
  const artifact = JSON.parse(wal!.reviewArtifactJson!) as { findings: { id: string; path?: string; pathDropped?: boolean }[] };
  const finding = artifact.findings.find((f) => f.id === "f1");
  assert.ok(finding, "expected the persisted WAL artifact to carry finding f1");
  assert.equal(finding!.path, "src/foo.ts"); // KEPT — the diff genuinely touches this path
  assert.equal(finding!.pathDropped, undefined);

  state.close();
  rmSync(gcParent, { recursive: true, force: true });
});

test("#472 production seam: an APPROVED run's persisted WAL artifact still carries its advisory finding (previously always empty on the approved branch)", async () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1 },
    worker: { model: "sonnet" },
    reviewer: { mode: "engine-agent", agent: { model: "opus" } },
    ci: { requiredChecks: [{ name: "test", app: "github-actions" }] },
  });
  const H = "a".repeat(40);
  const B = "b".repeat(40);
  const body = "## Acceptance criteria\n\n- [ ] Works correctly\n";
  const snapshot = buildAcSnapshot(12, body, "2026-01-01T00:00:00Z");
  assert.ok(snapshot);
  const state = new State(":memory:");
  const gcParent = mkdtempSync(join(tmpdir(), "sapwood-review-gc-472-b-"));
  const gcRoot = join(gcParent, "trees");
  state.recordAcSnapshot(snapshot!);
  state.upsertWorker({
    name: "lane-12",
    issue: 12,
    session_id: "worker-session",
    state: "driving",
    started_at: "t",
    ended_at: null,
    pr: 7,
  });
  state.recordWorkerActualModel("lane-12", "sonnet");
  const comments: PRTopLevelComment[] = [];
  const reviewData = {
    headOid: H,
    author: "producer",
    state: "OPEN" as const,
    isDraft: false,
    labels: [],
    unresolvedThreads: 0,
    reviews: [],
    comments: [],
    reactions: [],
  };
  const forge = {
    getPRStatus: async () => ({ state: "OPEN", headOid: H, baseOid: B, ciGreen: true, mergeable: "MERGEABLE" }),
    getPRReviewData: async () => reviewData,
    getPRDiff: async () => "diff --git a/x b/x\n+ok\n",
    getPRChangedFiles: async () => ({ files: [], complete: true }),
    getPRChecks: async () => ({
      checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: "github-actions" }],
      total: 1,
    }),
    getPRComments: async () => ({ comments, total: comments.length }),
    addPRComment: async (_pr: number, commentBody: string) => {
      comments.push({ id: `IC${comments.length + 1}`, login: "sapwood", createdAt: "2026-01-01T00:00:01Z", body: commentBody });
    },
    mergePR: async () => {},
  } as unknown as IForge;
  const resultText = `<<<SAPWOOD_RESULT>>>\n${JSON.stringify({
    perAC: snapshot!.manifest.map((a) => ({ id: a.id, status: "confirmed" })),
    findings: [{ id: "f1", body: "trivial style nit", severity: "advisory", kind: "style" }],
  })}\n<<<END_SAPWOOD_RESULT>>>`;
  const runner = {
    run: async () => ({
      outcome: "done" as const,
      costUsd: 0.1,
      costKnown: true,
      exitCode: 0,
      name: "role-engine-reviewer-test",
      resultText,
      modelUsage: [{ model: "opus", inputTokens: 1, outputTokens: 1, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    }),
  };
  const production = makeProductionEngineAgent(cfg, forge, state, runner, {
    now: () => new Date("2026-01-01T00:00:00Z"),
    newRunId: () => "run-472-b",
    reviewTreeRoot: gcRoot,
    materializeOverride: async (head) => ({
      kind: "materialized",
      treeDir: "/private/tree",
      oid: head,
      manifest: [{ path: "x", contentHash: "c" }],
    }),
  });
  const driver = new MergeDriver({ forge, reviewer: production.reviewer, cfg, fallbackReviewers: [] });
  const worker = state.getWorker("lane-12")!;
  const outcome = await driver.driveOne(
    7,
    12,
    { head: null, at: null },
    () => {},
    undefined,
    false,
    undefined,
    production.driveDepsForLane(worker, 7),
  );
  assert.equal(outcome.kind, "merged"); // gate semantics unchanged — advisory-only still merges

  const wal = state.getEngineReviewWal("lane-12");
  assert.ok(wal?.reviewArtifactJson, "expected a persisted review artifact");
  const artifact = JSON.parse(wal!.reviewArtifactJson!) as { findings: { id: string; severity?: string }[] };
  assert.deepEqual(
    artifact.findings.map((f) => f.id),
    ["f1"],
  );
  assert.equal(artifact.findings[0]!.severity, "advisory");
  // And the delivered audit comment renders it under the Advisory heading, not "None recorded.".
  assert.equal(comments.length, 1);
  const advisoryIdx = comments[0]!.body.indexOf("### Advisory (non-blocking)");
  assert.ok(advisoryIdx >= 0);
  assert.match(comments[0]!.body.slice(advisoryIdx), /trivial style nit/);

  state.close();
  rmSync(gcParent, { recursive: true, force: true });
});
