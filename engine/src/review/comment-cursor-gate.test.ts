// comment-cursor-gate.test.ts (#652) — the impure orchestration half: fetching comments/actor,
// resolving the engine-comment exemption, and the needs-human degrade's dedup behavior. Pure
// cursor-computation edge cases live in comment-cursor.test.ts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema } from "../config/config.js";
import { GithubForge, type PRComment } from "../forge/forge.js";
import {
  checkBodyDrift,
  checkCommentCursorFreshness,
  checkCommentCursorFreshnessWithComments,
  commentCursorIsStale,
  escalateCommentCursorStale,
} from "./comment-cursor-gate.js";

const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" } });

function comment(id: string, login: string, body: string, authorAssociation?: string | null): PRComment {
  return { id, login, createdAt: "t", body, ...(authorAssociation !== undefined ? { authorAssociation } : {}) };
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

test("#943 cursor gate: a real GithubForge hides public-only comments while trusted comments retain the marker requirement", async () => {
  const forge = new GithubForge(cfg);
  const responses = [
    [{ id: 1, user: { login: "outside" }, author_association: "NONE", created_at: "t", body: "public noise" }],
    [{ id: "trusted", user: { login: "maintainer" }, author_association: "MEMBER", created_at: "t", body: "binding ruling" }],
  ];
  let read = 0;
  (forge as unknown as { gh: (args: string[]) => Promise<string> }).gh = async (args) => {
    if (args[1] === "graphql" && String(args[3]).includes("viewer { login }")) return JSON.stringify({ data: { viewer: { login: "sapwood-bot\n" } } });
    return JSON.stringify(responses[read++]!);
  };
  const publicResult = await checkCommentCursorFreshness(forge, 9, "body without a cursor marker");
  assert.deepEqual(publicResult, { ok: true, cursor: "0", pending: [] });

  const trustedResult = await checkCommentCursorFreshness(forge, 9, "<!-- sapwood:comments-adjudicated-through: 0 -->");
  assert.deepEqual(trustedResult, { ok: true, cursor: "0", pending: ["trusted"] });
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

// ── #665: checkCommentCursorFreshnessWithComments — the SAME fetch, comments also exposed ───────

test("checkCommentCursorFreshnessWithComments: returns the same cursor result as checkCommentCursorFreshness, PLUS the raw comment stream it fetched — one getIssueComments call, not two", async () => {
  let fetchCount = 0;
  const raw = [comment("1", "owner-human", "a binding ruling")];
  const forge = {
    getIssueComments: async () => {
      fetchCount++;
      return raw;
    },
    getAuthenticatedActor: async () => "sapwood-bot",
  };
  const body = "<!-- sapwood:comments-adjudicated-through: 1 -->";
  const { result, comments } = await checkCommentCursorFreshnessWithComments(forge, 9, body);
  assert.deepEqual(result, { ok: true, cursor: "1", pending: [] });
  assert.deepEqual(
    comments,
    raw,
    "the exact PRComment objects (id, login, body) the forge returned — not just the pure id/isEngine projection",
  );
  assert.equal(fetchCount, 1);
});

// ── #652 round 1 (finding 1/2): checkBodyDrift — the standalone hash compare ────────────────────

test("checkBodyDrift: identical bodies -> null (nothing to discard)", () => {
  assert.equal(checkBodyDrift("same text", "same text"), null);
});

test("checkBodyDrift: a changed body -> a synthetic body-drift CommentCursorResult, pending empty", () => {
  const result = checkBodyDrift("live text, edited", "original text a session was given");
  assert.notEqual(result, null);
  assert.equal(result?.ok, false);
  if (result && !result.ok) {
    assert.equal(result.reason, "body-drift");
    assert.deepEqual(result.pending, []);
    assert.match(result.detail, /changed since the session/);
  }
});

test("checkBodyDrift: whitespace-only differences still count as drift (hash compare, not a semantic diff)", () => {
  const result = checkBodyDrift("text ", "text");
  assert.notEqual(result, null);
});

// #752: checkBodyDrift calls hashBody directly (raw, unmodified) — a marker-only advance must
// STILL read as drift here, unlike the AC-authority hash (ac-snapshot.test.ts). This is #703's
// invariant: a role body-write must not land silently over an operator's freshly-advanced marker.
test("checkBodyDrift: a marker-only advance (no other byte changed) STILL counts as drift — #703's write-time guard must not be defeated by #752's AC-authority normalization", () => {
  const sessionRenderedBody = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 0 -->";
  const liveBody = "## Acceptance criteria\n\n- [ ] one\n\n<!-- sapwood:comments-adjudicated-through: 5236875925 -->";
  const result = checkBodyDrift(liveBody, sessionRenderedBody);
  assert.notEqual(result, null);
  assert.equal(result?.ok, false);
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

// ── #652 round 1 (finding 3): dedup-read/post failures are CONTAINED, never thrown ──────────────

test("escalateCommentCursorStale: a dedup-fetch (getIssueComments) failure is reported, never thrown — label still attempted, posted: false with postError set", async () => {
  const labelsAdded: { issue: number; label: string }[] = [];
  const forge = {
    addLabel: async (issue: number, label: string) => {
      labelsAdded.push({ issue, label });
    },
    getIssueComments: async () => {
      throw new Error("dedup read: 500 internal error");
    },
    addIssueComment: async () => {
      throw new Error("must never be reached — the dedup read already threw");
    },
  };
  const result = { ok: true as const, cursor: "0", pending: ["1"] };
  // Must NOT throw — the whole point of this hardening.
  const outcome = await escalateCommentCursorStale(forge, cfg, 9, result);
  assert.equal(labelsAdded.length, 1, "the label write is attempted regardless of the dedup read's fate");
  assert.equal(outcome.labeled, true);
  assert.equal(outcome.posted, false, "unknown whether it was already posted -> never claim a post that may not have happened");
  assert.match(outcome.postError ?? "", /dedup read: 500 internal error/);
});

test("escalateCommentCursorStale: an addIssueComment (post) failure is reported, never thrown — the dedup read itself succeeded", async () => {
  const labelsAdded: { issue: number; label: string }[] = [];
  const forge = {
    addLabel: async (issue: number, label: string) => {
      labelsAdded.push({ issue, label });
    },
    getIssueComments: async () => [] as PRComment[],
    addIssueComment: async () => {
      throw new Error("502 bad gateway");
    },
  };
  const result = { ok: true as const, cursor: "0", pending: ["1"] };
  const outcome = await escalateCommentCursorStale(forge, cfg, 9, result);
  assert.equal(labelsAdded.length, 1);
  assert.equal(outcome.labeled, true);
  assert.equal(outcome.posted, false);
  assert.match(outcome.postError ?? "", /502 bad gateway/);
});

test("escalateCommentCursorStale: BOTH the label write and the dedup read fail — both outcomes are reported, still never thrown", async () => {
  const forge = {
    addLabel: async () => {
      throw new Error("403 forbidden");
    },
    getIssueComments: async () => {
      throw new Error("network blip");
    },
    addIssueComment: async () => {
      throw new Error("must never be reached");
    },
  };
  const result = { ok: true as const, cursor: "0", pending: ["1"] };
  const outcome = await escalateCommentCursorStale(forge, cfg, 9, result);
  assert.equal(outcome.labeled, false);
  assert.match(outcome.labelError ?? "", /403 forbidden/);
  assert.equal(outcome.posted, false);
  assert.match(outcome.postError ?? "", /network blip/);
});
