// comment-cursor-gate.ts (#652) — the IMPURE half of the comment-adjudication cursor: fetching
// the live comment stream + authenticated actor, resolving the engine-comment exemption, and
// (on a stale/invalid cursor) applying the needs-human degrade with a deduplicated pointer
// comment. Pure marker parse + pending-comment computation lives in comment-cursor.ts (same
// pure/impure split as ac-snapshot.ts vs. conductor.ts's checkAcDriftBeforeDrive).
//
// Shared by every gate⓪/dispatch/drive checkpoint (design adjudicated 2026-08-05, extended #652
// round 1): gate⓪ (plan-review.ts, pre-spend + pre-apply + the drafter-write checkpoint added in
// round 1), dispatch (conductor.ts, claim -> re-read -> rollback), and drive (conductor.ts,
// before gate② invocation) — one freshness check, one escalation action, so no checkpoint can
// silently diverge in what counts as stale or how the degrade looks. `checkBodyDrift` (round 1)
// is a second, narrower check gate⓪'s pre-apply and drafter-write checkpoints also run: not
// "does the comment stream vouch for this body" (checkCommentCursorFreshness's job) but "is the
// live body still the exact one a session was given" — both funnel into the SAME
// `escalateCommentCursorStale` discard/degrade below.
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
import { hashBody } from "./ac-snapshot.js";
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
    // #652 round 1 (finding 5): an EXPLICIT `null` when the forge returned no id — never a
    // silently-coerced `""` (computeCommentCursor's own `comment-id-missing` arm is what decides
    // what an id-less comment means; this call site's only job is to report the fact honestly).
    return { id: c.id ?? null, isEngine };
  });
  return computeCommentCursor(body, stream);
}

/** #652 round 1 (finding 1/2): a distinct discard CAUSE from ordinary comment-cursor staleness —
 *  the LIVE body a checkpoint just fetched no longer hash-matches the body a reviewer/drafter
 *  SESSION was actually given as its input (a maintainer edited it directly, no comment involved
 *  — the AC-snapshot mechanism's own drift class, ac-snapshot.ts's `checkAcSnapshotDrift`, just
 *  applied to gate⓪'s pre-session body instead of a dispatch-time snapshot). Returns `null` when
 *  the two bodies match (nothing to discard); otherwise a synthetic `ok: false`
 *  `CommentCursorResult` carrying reason `"body-drift"` — reusing the EXACT SAME discard/escalate
 *  machinery (`escalateCommentCursorStale`, the dedup key, the pointer-comment builder) an
 *  invalid/stale comment-adjudication cursor already uses, rather than a second bespoke
 *  escalation surface for "something about this issue no longer matches what a session judged." */
export function checkBodyDrift(liveBody: string, sessionRenderedBody: string): CommentCursorResult | null {
  if (hashBody(liveBody) === hashBody(sessionRenderedBody)) return null;
  return {
    ok: false,
    reason: "body-drift",
    detail:
      "the issue body changed since the session that produced this decision was given its input " +
      `(rendered ${hashBody(sessionRenderedBody).slice(0, 12)}, live ${hashBody(liveBody).slice(0, 12)}).`,
    pending: [],
  };
}

/** Apply the needs-human degrade for a confirmed stale/invalid cursor: the existing needs-human
 *  label (best-effort — a write failure is reported, never thrown, matching every other
 *  escalation site's accepted stance in this codebase) plus ONE deduplicated pointer comment.
 *  Dedup is a LIVE marker scan (same idiom as conductor.ts's `commentOnEscalationCarrier`) keyed
 *  on `commentCursorDedupeKey(result)` — the SAME cursor/pending set never produces a second
 *  comment, but a genuinely NEW pending comment (a different dedup key) gets its own fresh post.
 *
 *  #652 round 1 (finding 3, adopting #659's escalation-writer.ts discipline — see that module's
 *  own doc for the full argument): the dedup READ (`getIssueComments`) and the pointer-comment
 *  POST (`addIssueComment`) are now CONTAINED exactly like the label write above — a failure
 *  there is reported (`posted: false`, `postError`), never thrown past this function. Before this
 *  round, a dedup-fetch/post failure threw straight out AFTER the label had already landed,
 *  stranding the issue labeled `needs-human` with no pointer comment AND no durable event (every
 *  caller only appended its `comment-cursor-stale` event on the non-throw path) — the needs-human
 *  exclusion from pool/dispatch eligibility then means nothing ever retries it. Every caller now
 *  threads this function's full outcome into an UNCONDITIONAL event append instead. */
export async function escalateCommentCursorStale(
  forge: Pick<IForge, "addLabel" | "getIssueComments" | "addIssueComment">,
  cfg: Pick<SapwoodConfig, "labels">,
  issue: number,
  result: CommentCursorResult,
): Promise<{ labeled: boolean; labelError?: string; posted: boolean; postError?: string }> {
  let labeled = true;
  let labelError: string | undefined;
  try {
    await forge.addLabel(issue, cfg.labels.needsHuman);
  } catch (e) {
    labeled = false;
    labelError = String(e);
  }

  let posted = false;
  let postError: string | undefined;
  try {
    const marker = commentCursorPointerMarker(commentCursorDedupeKey(result));
    const existing = await forge.getIssueComments(issue);
    const alreadyPosted = existing.some((c) => c.body.includes(marker));
    if (!alreadyPosted) {
      await forge.addIssueComment(issue, buildCommentCursorPointerComment(result));
      posted = true;
    }
  } catch (e) {
    postError = String(e);
  }
  return {
    labeled,
    posted,
    ...(labelError !== undefined ? { labelError } : {}),
    ...(postError !== undefined ? { postError } : {}),
  };
}
