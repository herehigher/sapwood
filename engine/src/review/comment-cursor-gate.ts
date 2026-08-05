// comment-cursor-gate.ts (#652) — the IMPURE half of the comment-adjudication cursor: fetching
// the live comment stream + authenticated actor, resolving the engine-comment exemption, and
// (on a stale/invalid cursor) applying the needs-human degrade with a deduplicated pointer
// comment. Pure marker parse + pending-comment computation lives in comment-cursor.ts (same
// pure/impure split as ac-snapshot.ts vs. conductor.ts's checkAcDriftBeforeDrive).
//
// Shared by all three checkpoints (design adjudicated 2026-08-05): gate⓪ (plan-review.ts,
// pre-spend + pre-apply), dispatch (conductor.ts, claim -> re-read -> rollback), and drive
// (conductor.ts, before gate② invocation) — one freshness check, one escalation action, so the
// three checkpoints cannot silently diverge in what counts as stale or how the degrade looks.
//
// FETCH-FAILURE STANCE: neither function here catches a forge read failure — both propagate it.
// Every call site rides its OWN existing retry/environment-failure path for a thrown error
// (design adjudicated 2026-08-05: "a comment/body fetch failure performs no issue write and
// propagates through the existing retry/environment-failure path"). Gate⓪'s reviewOneIssue
// already lets an unguarded `forge.getIssueBody` throw straight out of the pool loop; dispatch's
// claim happens inside conductor.ts's existing rollback-on-failure try/catch; drive's call site
// wraps this module's check the same way checkAcDriftBeforeDrive wraps its own live read (queued,
// retried next tick) — see each call site for its own handling.

import type { SapwoodConfig } from "../config/config.js";
import { ENGINE_COMMENT_MARKER, type IForge } from "../forge/forge.js";
import {
  buildCommentCursorPointerComment,
  type CommentCursorResult,
  type CommentStreamEntry,
  commentCursorDedupeKey,
  commentCursorPointerMarker,
  computeCommentCursor,
} from "./comment-cursor.js";

export type { CommentCursorResult } from "./comment-cursor.js";
export { commentCursorIsStale } from "./comment-cursor.js";

/** Fetch the issue's comment stream + the authenticated forge actor, resolve each comment's
 *  engine-exemption flag, and compute the cursor result against `body` (the caller's own
 *  authoritative read — this function never fetches the body itself: gate⓪ re-reads it every
 *  cycle already, dispatch re-reads it per its own checkpoint, and drive deliberately uses the
 *  AC-SNAPSHOTTED body, never a fresh live one — see each call site).
 *
 *  Engine-comment exemption (design adjudicated 2026-08-05): a comment is exempt ONLY when it
 *  carries the central `ENGINE_COMMENT_MARKER` (forge.ts) AND its author matches the resolved
 *  actor — never either alone. An unresolvable actor (`getAuthenticatedActor` returns `null`)
 *  exempts NO comment; every comment is then treated as non-engine, the maximally fail-closed
 *  reading. */
export async function checkCommentCursorFreshness(
  forge: Pick<IForge, "getIssueComments" | "getAuthenticatedActor">,
  issue: number,
  body: string,
): Promise<CommentCursorResult> {
  const [comments, actor] = await Promise.all([forge.getIssueComments(issue), forge.getAuthenticatedActor()]);
  const stream: CommentStreamEntry[] = comments.map((c): CommentStreamEntry => {
    const isEngine = actor != null && c.login === actor && c.body.includes(ENGINE_COMMENT_MARKER);
    return { id: c.id ?? "", isEngine };
  });
  return computeCommentCursor(body, stream);
}

/** Apply the needs-human degrade for a confirmed stale/invalid cursor: the existing needs-human
 *  label (best-effort — a write failure is reported, never thrown, matching every other
 *  escalation site's accepted stance in this codebase) plus ONE deduplicated pointer comment.
 *  Dedup is a LIVE marker scan (same idiom as conductor.ts's `commentOnEscalationCarrier`) keyed
 *  on `commentCursorDedupeKey(result)` — the SAME cursor/pending set never produces a second
 *  comment, but a genuinely NEW pending comment (a different dedup key) gets its own fresh post. */
export async function escalateCommentCursorStale(
  forge: Pick<IForge, "addLabel" | "getIssueComments" | "addIssueComment">,
  cfg: Pick<SapwoodConfig, "labels">,
  issue: number,
  result: CommentCursorResult,
): Promise<{ labeled: boolean; labelError?: string; posted: boolean }> {
  let labeled = true;
  let labelError: string | undefined;
  try {
    await forge.addLabel(issue, cfg.labels.needsHuman);
  } catch (e) {
    labeled = false;
    labelError = String(e);
  }

  const marker = commentCursorPointerMarker(commentCursorDedupeKey(result));
  const existing = await forge.getIssueComments(issue);
  const alreadyPosted = existing.some((c) => c.body.includes(marker));
  if (!alreadyPosted) {
    await forge.addIssueComment(issue, buildCommentCursorPointerComment(result));
  }
  return { labeled, posted: !alreadyPosted, ...(labelError !== undefined ? { labelError } : {}) };
}
