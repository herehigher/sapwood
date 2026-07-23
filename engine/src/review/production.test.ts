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

function oid(n: number): string {
  return n.toString(16).padStart(40, "0");
}

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
      { reviewTreeRoot: root },
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
