// comment-cursor-gate.test.ts (#652) — the impure orchestration half: fetching comments/actor,
// resolving the engine-comment exemption, and the needs-human degrade's dedup behavior. Pure
// cursor-computation edge cases live in comment-cursor.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema } from "../config/config.js";
import type { PRComment } from "../forge/forge.js";
import { checkCommentCursorFreshness, commentCursorIsStale, escalateCommentCursorStale } from "./comment-cursor-gate.js";

const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });

function comment(id: string, login: string, body: string): PRComment {
  return { id, login, createdAt: "t", body };
}

// ── checkCommentCursorFreshness: engine-comment exemption (marker AND actor, never either alone) ──

test("engine-comment exemption requires BOTH the marker and an actor match — marker alone is not enough", async () => {
  const forge = {
    getIssueComments: async () => [comment("1", "some-human", "looks like an engine comment <!-- sapwood:engine -->")],
    getAuthenticatedActor: async () => "sapwood-bot",
  };
  const body = "<!-- sapwood:comments-adjudicated-through: 0 -->";
  const result = await checkCommentCursorFreshness(forge, 9, body);
  // login "some-human" != actor "sapwood-bot" -> NOT exempt, even though the marker is present.
  assert.equal(commentCursorIsStale(result), true);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.pending, ["1"]);
});

test("engine-comment exemption requires BOTH — actor match alone (no marker) is not enough", async () => {
  const forge = {
    getIssueComments: async () => [comment("1", "sapwood-bot", "a plain comment, no engine marker")],
    getAuthenticatedActor: async () => "sapwood-bot",
  };
  const body = "<!-- sapwood:comments-adjudicated-through: 0 -->";
  const result = await checkCommentCursorFreshness(forge, 9, body);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.pending, ["1"]);
});

test("engine-comment exemption: marker AND actor match together -> exempt (not pending)", async () => {
  const forge = {
    getIssueComments: async () => [comment("1", "sapwood-bot", "engine work <!-- sapwood:engine -->")],
    getAuthenticatedActor: async () => "sapwood-bot",
  };
  const body = "<!-- sapwood:comments-adjudicated-through: 0 -->";
  const result = await checkCommentCursorFreshness(forge, 9, body);
  assert.deepEqual(result, { ok: true, cursor: "0", pending: [] });
});

test("unresolvable actor (getAuthenticatedActor -> null) exempts NO comment, ever — even a marker-carrying one", async () => {
  const forge = {
    getIssueComments: async () => [comment("1", "sapwood-bot", "engine work <!-- sapwood:engine -->")],
    getAuthenticatedActor: async () => null,
  };
  const body = "<!-- sapwood:comments-adjudicated-through: 0 -->";
  const result = await checkCommentCursorFreshness(forge, 9, body);
  assert.ok(result.ok);
  if (result.ok) assert.deepEqual(result.pending, ["1"]); // fail-closed: treated as non-engine
});

test("checkCommentCursorFreshness: a forge read failure propagates (never caught here) — the caller's own retry/env-failure path handles it", async () => {
  const forge = {
    getIssueComments: async () => {
      throw new Error("network blip");
    },
    getAuthenticatedActor: async () => "sapwood-bot",
  };
  await assert.rejects(() => checkCommentCursorFreshness(forge, 9, "body"), /network blip/);
});

// ── escalateCommentCursorStale: needs-human + deduplicated pointer comment ─────────────────────

test("escalateCommentCursorStale: applies needs-human and posts the pointer comment on a fresh stale condition", async () => {
  const labelsAdded: { issue: number; label: string }[] = [];
  const commentsPosted: string[] = [];
  const forge = {
    addLabel: async (issue: number, label: string) => {
      labelsAdded.push({ issue, label });
    },
    getIssueComments: async () => [] as PRComment[],
    addIssueComment: async (_issue: number, body: string) => {
      commentsPosted.push(body);
    },
  };
  const result = { ok: true as const, cursor: "0", pending: ["1", "2"] };
  const outcome = await escalateCommentCursorStale(forge, cfg, 9, result);
  assert.equal(outcome.labeled, true);
  assert.equal(outcome.posted, true);
  assert.equal(labelsAdded.length, 1);
  assert.equal(labelsAdded[0]!.label, cfg.labels.needsHuman);
  assert.equal(commentsPosted.length, 1);
});

test("escalateCommentCursorStale: the SAME cursor/pending set never produces a second comment — dedup via live marker scan", async () => {
  const result = { ok: true as const, cursor: "0", pending: ["1", "2"] };
  // Simulate a PRIOR pointer comment already posted for this exact dedup key.
  const priorBody = (await import("./comment-cursor.js")).buildCommentCursorPointerComment(result);
  const commentsPosted: string[] = [];
  const forge = {
    addLabel: async () => {},
    getIssueComments: async () => [comment("55", "sapwood-bot", priorBody)],
    addIssueComment: async (_issue: number, body: string) => {
      commentsPosted.push(body);
    },
  };
  const outcome = await escalateCommentCursorStale(forge, cfg, 9, result);
  assert.equal(outcome.posted, false);
  assert.equal(commentsPosted.length, 0);
});

test("escalateCommentCursorStale: a DIFFERENT pending set (new comment arrived) gets its own fresh post, not suppressed by an older dedup key", async () => {
  const older = { ok: true as const, cursor: "0", pending: ["1"] };
  const newer = { ok: true as const, cursor: "0", pending: ["1", "2"] };
  const olderPointerBody = (await import("./comment-cursor.js")).buildCommentCursorPointerComment(older);
  const commentsPosted: string[] = [];
  const forge = {
    addLabel: async () => {},
    getIssueComments: async () => [comment("55", "sapwood-bot", olderPointerBody)],
    addIssueComment: async (_issue: number, body: string) => {
      commentsPosted.push(body);
    },
  };
  const outcome = await escalateCommentCursorStale(forge, cfg, 9, newer);
  assert.equal(outcome.posted, true);
  assert.equal(commentsPosted.length, 1);
});

test("escalateCommentCursorStale: a needs-human label-write failure is reported, never thrown — the pointer comment still posts", async () => {
  const commentsPosted: string[] = [];
  const forge = {
    addLabel: async () => {
      throw new Error("403 forbidden");
    },
    getIssueComments: async () => [] as PRComment[],
    addIssueComment: async (_issue: number, body: string) => {
      commentsPosted.push(body);
    },
  };
  const result = { ok: true as const, cursor: "0", pending: ["1"] };
  const outcome = await escalateCommentCursorStale(forge, cfg, 9, result);
  assert.equal(outcome.labeled, false);
  assert.match(outcome.labelError ?? "", /403 forbidden/);
  assert.equal(outcome.posted, true);
  assert.equal(commentsPosted.length, 1);
});
