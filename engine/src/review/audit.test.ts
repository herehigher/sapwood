import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import type { PRTopLevelComment } from "../forge/forge.js";
import { CLEAN_VERDICT_RE, REVIEWED_HEAD_OID_RE } from "../roles/reviewer.js";
import { buildAuditComment, buildAuditMarker, deliverEngineReviewAudit, type EngineReviewArtifact, parseAuditMarker } from "./audit.js";
import type { EngineReviewWal } from "./drive.js";

const artifact: EngineReviewArtifact = {
  perAC: [{ id: "AC-1", status: "cannot-confirm" }],
  findings: [{ id: "F-1", body: "A concrete defect" }],
  sessionActualModels: ["claude-opus-4-6"],
  promptHash: "b".repeat(64),
};
const wal: EngineReviewWal = {
  runId: "run-123",
  head: "a".repeat(40),
  base: "c".repeat(40),
  diffHash: "d".repeat(64),
  treeManifestHash: "e".repeat(64),
  attemptStart: "2026-01-01T00:00:00.000Z",
  decisiveOutcome: "rejected",
  reviewArtifactJson: JSON.stringify(artifact),
  auditCommentId: null,
  auditDeliveredAt: null,
};

test("#288 marker is deterministic and unique across each identity field", () => {
  const marker = { kind: "engine-agent" as const, head: wal.head, diff: wal.diffHash, runId: wal.runId };
  assert.equal(buildAuditMarker(marker), buildAuditMarker(marker));
  assert.deepEqual(parseAuditMarker(buildAuditMarker(marker)), marker);
  for (const changed of [
    { ...marker, head: "f".repeat(40) },
    { ...marker, diff: "1".repeat(64) },
    { ...marker, runId: "run-124" },
  ])
    assert.notEqual(buildAuditMarker(changed), buildAuditMarker(marker));
});

test("#288 audit body carries per-AC/findings/provenance but never matches approval parsers", () => {
  const body = buildAuditComment(wal, artifact);
  assert.match(body, /AC-1.*cannot-confirm/);
  assert.match(body, /F-1.*concrete defect/);
  assert.match(body, /reviewer model.*opus/i);
  for (const line of body.split("\n")) {
    assert.equal(CLEAN_VERDICT_RE.test(line), false);
    assert.equal(REVIEWED_HEAD_OID_RE.test(line), false);
  }
  const reviewerSource = readFileSync(new URL("../roles/reviewer.ts", import.meta.url), "utf8");
  assert.doesNotMatch(reviewerSource, /sapwood-audit|parseAuditMarker|getPRAuditComments/);
});

test("#288 crash after post before receipt: restart discovers exact marker and records receipt without duplicate post", async () => {
  const existing: PRTopLevelComment = {
    id: "IC_existing",
    login: "bot",
    createdAt: "2026-01-01T00:00:01Z",
    body: buildAuditComment(wal, artifact),
  };
  let posts = 0;
  let receipt: string | null = null;
  const result = await deliverEngineReviewAudit({
    forge: {
      getPRComments: async () => ({ comments: [existing], total: 1 }),
      addPRComment: async () => {
        posts++;
      },
    },
    pr: 7,
    wal,
    commentsCap: 20,
    now: () => new Date("2026-01-01T00:00:02Z"),
    recordReceipt: (_run, id) => {
      receipt = id;
      return true;
    },
  });
  assert.deepEqual(result, { delivered: true });
  assert.equal(posts, 0);
  assert.equal(receipt, "IC_existing");
});

test("#288 post or receipt-write failure never reports delivered", async () => {
  let comments: PRTopLevelComment[] = [];
  const forge = {
    getPRComments: async () => ({ comments, total: comments.length }),
    addPRComment: async (_pr: number, body: string) => {
      comments = [{ id: "IC1", login: "bot", createdAt: "t", body }];
    },
  };
  const result = await deliverEngineReviewAudit({ forge, pr: 7, wal, commentsCap: 20, now: () => new Date(), recordReceipt: () => false });
  assert.equal(result.delivered, false);
  const postFailure = await deliverEngineReviewAudit({
    forge: {
      getPRComments: async () => ({ comments: [], total: 0 }),
      addPRComment: async () => {
        throw new Error("simulated post failure");
      },
    },
    pr: 7,
    wal,
    commentsCap: 20,
    now: () => new Date(),
    recordReceipt: () => true,
  });
  assert.equal(postFailure.delivered, false);
  assert.match(postFailure.reason, /post failure/);
});
