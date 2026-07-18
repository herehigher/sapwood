// loop/fix-response.ts — #247: a fix leg's structured review-thread response — reply +
// resolution per thread — validated and engine-executed, extending #110's structured-output
// paradigm (state/structured-output.ts) to the fix-loop (#245's `fixing` lane, #244's
// `pr_review_threads` proxy tool).
//
// Why (issue #247): a fix leg holds zero forge credentials (#218) and never touches `gh` — its
// final message ends in ONE structured block naming, per review thread it addressed, a reply
// and a resolution (`addressed` | `disputed`). The ENGINE parses + validates that block, checks
// every named threadId against the SAME journaled `pr_review_threads` response the leg was
// actually served (proxy/journal.ts's write-ahead journal — no TOCTOU between what the leg saw
// and what the engine acts on), and ONLY THEN executes replies/resolves via IForge. Gate
// integrity never rests on this: MERGE_OK requires a FRESH accepted review on the new head
// (reviewer.ts/merge-driver.ts, head-pinned verdicts, unchanged by this module) — resolving
// every thread on a PR can never by itself buy a merge, because unresolvedThreads is re-derived
// LIVE from GitHub (countUnresolvedThreads) on every gate② read, entirely independent of
// anything this module writes to the local durable queue below.
//
// FAIL-CLOSED VALIDATION (issue #247 AC — the duplicate-entry fail-open class from the #110
// review is a named regression to guard): an unknown threadId, a duplicate threadId, an empty
// reply, or an unrecognized resolution value rejects the WHOLE output — never a partial
// execution. validateFixResponseOutput below is the one gate; its caller (conductor.ts's
// reclaimTerminalLane) either enqueues EVERY entry or none.
//
// IDEMPOTENT EXECUTION (issue #247 AC — "a failed resolve retries next tick; replies are never
// double-posted"): validated entries are persisted to State's pending_thread_writes queue
// (schema v20->v21) BEFORE any forge call is attempted — the same write-ahead-durable-queue
// shape pending_rollbacks established for board mutations (#31). attemptThreadWrite below makes
// ONE attempt per tick per row: it never re-attempts a reply once reply_posted is set, and a
// resolve failure leaves the row for the NEXT tick's attempt without re-posting the reply.
import { z } from "zod";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import { TOOL_PR_REVIEW_THREADS } from "../proxy/tools.js";
import type { ForgeProxyJournalRow, PendingThreadWrite, State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";

// ── Structured-output schema + validator ────────────────────────────────────────────────────

const FixThreadResponseEntrySchema = z
  .object({
    threadId: z.string().min(1),
    /** Empty rejected here (schema-level, not a separate post-hoc check) — an empty reply is
     *  exactly as unaccountable as harvest.ts's own empty-comment-body rejection. */
    reply: z.string().min(1),
    resolution: z.enum(["addressed", "disputed"]),
  })
  .strict();

const FixResponseMetadataSchema = z
  .object({
    threadResponses: z.array(FixThreadResponseEntrySchema),
  })
  .strict();

export interface FixThreadResponse {
  threadId: string;
  reply: string;
  resolution: "addressed" | "disputed";
}

export type FixResponseValidation = { ok: true; responses: FixThreadResponse[] } | { ok: false; reason: string };

function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Parse + schema-validate + journal-validate a fix leg's structured output. `knownThreadIds`
 *  is the set of thread ids that actually appeared in a `pr_review_threads` response THIS
 *  leg's session was served (journaledReviewThreadIds below) — a fabricated or stale threadId
 *  fails the WHOLE batch closed, never partially honored (issue #247 AC, same all-or-nothing
 *  posture harvest.ts's validateHarvestOutput takes for its own out-of-set case). An empty
 *  `threadResponses` array is valid (nothing to report -> nothing executed). Duplicate threadId
 *  entries are rejected outright (Codex #110-review duplicate-entry fail-open class): the
 *  contract is ONE response per thread. */
export function validateFixResponseOutput(text: string, knownThreadIds: ReadonlySet<string>): FixResponseValidation {
  const block = parseStructuredBlock(text);
  if (!block) return { ok: false, reason: "no structured output block found (missing or truncated sentinel)" };
  let metadata: unknown;
  try {
    metadata = JSON.parse(block.metadataRaw);
  } catch {
    return { ok: false, reason: "structured output metadata is not valid JSON" };
  }
  const parsed = FixResponseMetadataSchema.safeParse(metadata);
  if (!parsed.success) {
    return { ok: false, reason: `structured output metadata failed schema validation: ${describeZodError(parsed.error)}` };
  }
  const seen = new Set<string>();
  for (const r of parsed.data.threadResponses) {
    if (seen.has(r.threadId)) {
      return { ok: false, reason: `duplicate threadId ${r.threadId} in threadResponses — one response per thread, never two` };
    }
    seen.add(r.threadId);
    if (!knownThreadIds.has(r.threadId)) {
      return {
        ok: false,
        reason: `threadId ${r.threadId} was not present in the journaled pr_review_threads response(s) served to this leg`,
      };
    }
  }
  return { ok: true, responses: parsed.data.threadResponses };
}

/** Every review-thread id that appeared in ANY 'fetched'/'delivered' `pr_review_threads`
 *  journal row among `rows` — the no-TOCTOU set validateFixResponseOutput checks against.
 *  Unioned across every such row (not just the latest) because a leg may call the tool more
 *  than once (e.g. varying `lastN`) and may legitimately reply about a thread seen on an
 *  earlier call. A malformed/unparseable response row is skipped, never thrown (journal rows
 *  are engine-written via canonicalJson, so this is defense-in-depth, not an expected path). */
export function journaledReviewThreadIds(rows: readonly ForgeProxyJournalRow[]): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.tool !== TOOL_PR_REVIEW_THREADS) continue;
    if (row.status !== "fetched" && row.status !== "delivered") continue;
    if (!row.responseCanonical) continue;
    try {
      const parsed = JSON.parse(row.responseCanonical) as { threads?: { id?: unknown }[] };
      for (const t of parsed.threads ?? []) {
        if (typeof t.id === "string") ids.add(t.id);
      }
    } catch {
      // Malformed journal row — skip rather than throw (fail toward "unknown", never a crash).
    }
  }
  return ids;
}

// ── Durable-queue execution (mirrors conductor.ts's attemptRollback shape, #31) ─────────────

export type FixResponseWriteOutcome =
  | { kind: "recorded"; worker: string; issue: number; threadId: string } // disputed: reply posted, no resolve
  | { kind: "resolved"; worker: string; issue: number; threadId: string } // addressed: reply + resolve both done
  | { kind: "retrying"; worker: string; issue: number; threadId: string; attempts: number }
  | { kind: "escalated"; worker: string; issue: number; threadId: string; attempts: number };

/** One attempt at a durably-persisted fix-thread write (#247). `row` may be a freshly-enqueued
 *  row (attempts: 0) or one read back via state.pendingThreadWrites() on a later tick. Same
 *  bounded-retry-then-escalate contract as attemptRollback: never throws — a still-failing
 *  forge only bumps the retry count or escalates to needs-human once `cfg.recovery.
 *  rollbackRetryCap` is hit (the SAME cap board-mutation recovery uses; no new config key for
 *  a second, functionally-identical bounded-retry policy).
 *
 *  IDEMPOTENCY (issue #247 AC): the reply half is attempted ONLY when `row.replyPosted` is still
 *  false — once it flips true (persisted before this function returns on that attempt), no
 *  later call ever re-posts it, regardless of how the resolve half fares. A `disputed` row has
 *  no resolve half at all: it is cleared (fully done) the instant its reply posts. */
export async function attemptThreadWrite(
  forge: Pick<IForge, "replyToReviewThread" | "resolveReviewThread" | "addLabel" | "addPRLabel">,
  state: Pick<State, "markThreadReplyPosted" | "markThreadResolved" | "bumpThreadWriteAttempt" | "clearThreadWrite" | "appendEvent">,
  cfg: Pick<SapwoodConfig, "recovery" | "labels">,
  row: PendingThreadWrite,
  iso: () => string,
): Promise<FixResponseWriteOutcome> {
  let replyPosted = row.replyPosted;
  if (!replyPosted) {
    try {
      await forge.replyToReviewThread(row.threadId, row.reply);
      state.markThreadReplyPosted(row.id, iso());
      replyPosted = true;
    } catch (e) {
      return escalateOrRetry(forge, state, cfg, row, e, iso);
    }
  }
  if (row.resolution === "disputed") {
    // Speak-not-act (issue #247's Why, PLAN.md dissent doctrine): a disputed thread stays open
    // on GitHub — nothing left to do once its reply lands.
    state.clearThreadWrite(row.id);
    state.appendEvent("fix-thread-recorded", { worker: row.worker, issue: row.issue, pr: row.pr, threadId: row.threadId });
    return { kind: "recorded", worker: row.worker, issue: row.issue, threadId: row.threadId };
  }
  if (!row.resolved) {
    try {
      await forge.resolveReviewThread(row.threadId);
      state.markThreadResolved(row.id, iso());
      state.clearThreadWrite(row.id);
      state.appendEvent("fix-thread-resolved", { worker: row.worker, issue: row.issue, pr: row.pr, threadId: row.threadId });
      return { kind: "resolved", worker: row.worker, issue: row.issue, threadId: row.threadId };
    } catch (e) {
      return escalateOrRetry(forge, state, cfg, row, e, iso);
    }
  }
  // Defensive only: reply posted, addressed, and already resolved — a prior attempt succeeded
  // at both but the row was somehow never cleared. Clear it now rather than retry forever.
  state.clearThreadWrite(row.id);
  return { kind: "resolved", worker: row.worker, issue: row.issue, threadId: row.threadId };
}

/** Bump-and-retry under `cfg.recovery.rollbackRetryCap`; escalate (needs-human label, best-
 *  effort — attemptRollback's own precedent) and clear the row once the cap is hit. Never
 *  throws. */
async function escalateOrRetry(
  forge: Pick<IForge, "addLabel" | "addPRLabel">,
  state: Pick<State, "bumpThreadWriteAttempt" | "clearThreadWrite" | "appendEvent">,
  cfg: Pick<SapwoodConfig, "recovery" | "labels">,
  row: PendingThreadWrite,
  e: unknown,
  iso: () => string,
): Promise<FixResponseWriteOutcome> {
  const attempts = row.attempts + 1;
  if (attempts >= cfg.recovery.rollbackRetryCap) {
    state.clearThreadWrite(row.id);
    await forge.addLabel(row.issue, cfg.labels.needsHuman).catch(() => {});
    await forge.addPRLabel(row.pr, cfg.labels.needsHuman).catch(() => {});
    state.appendEvent("fix-thread-write-escalated", {
      worker: row.worker,
      issue: row.issue,
      pr: row.pr,
      threadId: row.threadId,
      attempts,
      error: String(e),
    });
    return { kind: "escalated", worker: row.worker, issue: row.issue, threadId: row.threadId, attempts };
  }
  state.bumpThreadWriteAttempt(row.id, iso());
  state.appendEvent("fix-thread-write-retry-failed", {
    worker: row.worker,
    issue: row.issue,
    pr: row.pr,
    threadId: row.threadId,
    attempts,
    error: String(e),
  });
  return { kind: "retrying", worker: row.worker, issue: row.issue, threadId: row.threadId, attempts };
}
