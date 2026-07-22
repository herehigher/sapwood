import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema } from "../config/config.js";
import type { IForge, PRTopLevelComment } from "../forge/forge.js";
import { MergeDriver } from "../roles/merge-driver.js";
import { State } from "../state/state.js";
import { buildAcSnapshot } from "./ac-snapshot.js";
import { makeProductionEngineAgent } from "./production.js";

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
  state.close();
});
