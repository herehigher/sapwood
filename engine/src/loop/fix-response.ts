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
// reclaimTerminalLane, via computeFixResponseHarvest) either enqueues EVERY entry or none.
//
// PR-BOUND + LEG-BOUND VALIDATION (Codex sol-high PR #265 review round 1, D2): a journaled
// `pr_review_threads` row is trusted ONLY when both its journaled REQUEST args and its RESPONSE
// identify the CALLER'S OWN pr (journaledReviewThreadIds' `expectedPr` param) — otherwise a fix
// leg for PR A could reference a threadId the engine happened to journal for a DIFFERENT PR B
// (cross-PR confused-deputy write). And only rows from the CURRENT fix round are trusted
// (fixLegJournalCursor) — `startFixLeg` reuses the SAME worker row/session name across every
// fix round on a lane, so filtering by session name alone would let round 2 act on a threadId
// only round 1 ever saw. The cursor reuses the `fix-leg-started` event startFixLeg already
// appends (conductor.ts) — no new schema for this half.
//
// IDEMPOTENT EXECUTION (issue #247 AC — "a failed resolve retries next tick; replies are never
// double-posted"): validated entries are persisted to State's pending_thread_writes queue
// (schema v21) BEFORE any forge call is attempted — the same write-ahead-durable-queue shape
// pending_rollbacks established for board mutations (#31), and (D4) committed in the SAME
// transaction as the fixing lane's terminal state write (State.settleTerminalWorker) so a crash
// between "settled to driving" and "batch enqueued" can never lose a validated batch or enqueue
// a partial one. attemptThreadWrite makes ONE attempt per tick per row: a resolve failure leaves
// the row for the NEXT tick's attempt without re-posting the reply, and (D3) even a reply POST
// that succeeded upstream but crashed before its durable reply_posted flag committed is never
// re-posted — a deterministic marker embedded in the reply body is checked (via a live
// pr_review_threads read) before any repost attempt.
import { z } from "zod";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge, ReviewThreadsPage } from "../forge/forge.js";
import { TOOL_PR_AUDIT_COMMENTS, TOOL_PR_REVIEW_THREADS } from "../proxy/tools.js";
import { parseEngineReviewArtifact } from "../review/audit.js";
import type { FixResponseSettleOutcome, ForgeProxyJournalRow, PendingThreadWrite, State } from "../state/state.js";
import { parseStructuredBlock } from "../state/structured-output.js";

// ── Structured-output schema + validator ────────────────────────────────────────────────────

const FixThreadResponseEntrySchema = z
  .object({
    threadId: z.string().min(1),
    /** D7 (Codex sol-high PR #265 review round 1, P3): TRIMMED length, not raw `.min(1)` — a
     *  whitespace-only reply (" ", "\n") is exactly as unaccountable as an empty one and must
     *  not slip past a bare length check. */
    reply: z.string().refine((s) => s.trim().length > 0, { message: "reply must not be empty or whitespace-only" }),
    resolution: z.enum(["addressed", "disputed"]),
  })
  .strict();

/** #461: the audit-comment-shaped mirror of `FixThreadResponseEntrySchema`. An engine-agent
 *  finding is delivered in ONE audit comment (`review/audit.ts`), never as a review thread, so it
 *  has no `threadId` to key on — its identity is `(runId, findingIndex)`, both rendered in that
 *  same comment. Same field discipline as its thread twin: trimmed-non-empty reply, closed
 *  resolution enum, strict object. */
const FixFindingResponseEntrySchema = z
  .object({
    runId: z.string().min(1),
    findingIndex: z.number().int().nonnegative(),
    reply: z.string().refine((s) => s.trim().length > 0, { message: "reply must not be empty or whitespace-only" }),
    resolution: z.enum(["addressed", "disputed"]),
  })
  .strict();

const FixResponseMetadataSchema = z
  .object({
    threadResponses: z.array(FixThreadResponseEntrySchema),
    /** #461: OPTIONAL — a leg that emits no `findingResponses` at all validates, settles, and
     *  receipts byte-identically to its pre-#461 self (issue AC3). */
    findingResponses: z.array(FixFindingResponseEntrySchema).optional(),
  })
  .strict();

export interface FixThreadResponse {
  threadId: string;
  reply: string;
  resolution: "addressed" | "disputed";
}

export interface FixFindingResponse {
  runId: string;
  findingIndex: number;
  reply: string;
  resolution: "addressed" | "disputed";
}

export type FixResponseValidation =
  | { ok: true; responses: FixThreadResponse[]; findingResponses: FixFindingResponse[] }
  | { ok: false; reason: string };

function describeZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** Parse + schema-validate + journal-validate a fix leg's structured output. `knownThreadIds`
 *  is the set of thread ids that actually appeared in a `pr_review_threads` response THIS
 *  leg's session was served, for its OWN PR, this fix round (journaledReviewThreadIds below) —
 *  a fabricated, cross-PR, or stale (earlier-round) threadId fails the WHOLE batch closed,
 *  never partially honored (issue #247 AC, same all-or-nothing posture harvest.ts's
 *  validateHarvestOutput takes for its own out-of-set case). An empty `threadResponses` array
 *  is valid (nothing to report -> nothing executed). Duplicate threadId entries are rejected
 *  outright (Codex #110-review duplicate-entry fail-open class): the contract is ONE response
 *  per thread. */
export function validateFixResponseOutput(
  text: string,
  knownThreadIds: ReadonlySet<string>,
  /** #461: runId -> how many findings that run's REVIEWED ARTIFACT actually contains — the bound
   *  every `findingIndex` is checked against. Built by `knownAuditFindingCounts` below from two
   *  independent facts (the leg was SERVED that run's audit comment; the engine's own WAL holds
   *  that run's finding array). Defaults to EMPTY, so a caller that supplies nothing rejects every
   *  `findingResponses` entry — fail-closed, never fail-open, for pre-#461 call sites. */
  knownFindingCounts: ReadonlyMap<string, number> = new Map(),
): FixResponseValidation {
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
        reason: `threadId ${r.threadId} was not present in the journaled pr_review_threads response(s) served to this leg for this PR/round`,
      };
    }
  }
  const findingResponses = parsed.data.findingResponses ?? [];
  const seenFindings = new Set<string>();
  for (const r of findingResponses) {
    const key = `${r.runId}#${r.findingIndex}`;
    if (seenFindings.has(key)) {
      return { ok: false, reason: `duplicate finding ${key} in findingResponses — one response per finding, never two` };
    }
    seenFindings.add(key);
    const count = knownFindingCounts.get(r.runId);
    if (count === undefined) {
      return {
        ok: false,
        reason: `runId ${r.runId} was not present in the journaled getPRAuditComments response(s) served to this leg for this PR/round`,
      };
    }
    if (r.findingIndex >= count) {
      return { ok: false, reason: `findingIndex ${r.findingIndex} is out of range for run ${r.runId} (${count} finding(s) reviewed)` };
    }
  }
  return { ok: true, responses: parsed.data.threadResponses, findingResponses };
}

/** Every review-thread id that appeared in a 'fetched'/'delivered' `pr_review_threads` journal
 *  row among `rows`, scoped to `expectedPr` — the no-TOCTOU, PR-bound set
 *  validateFixResponseOutput checks against (D2). A row is trusted ONLY when BOTH its journaled
 *  REQUEST args (`{pr: N}`) and its RESPONSE (`PRReviewThreadsResponse.pr`) identify
 *  `expectedPr` — a row for a different PR is excluded entirely, never contributing any thread
 *  id (closes the cross-PR confused-deputy write: a fix leg for PR A must never get the engine
 *  to act on a threadId only ever journaled for PR B). `rows` is expected to ALREADY be scoped
 *  to the current fix round by the caller (fixLegJournalCursor + State.
 *  listForgeProxyJournalForSession's sinceIso param) — this function does not itself know about
 *  rounds. Unioned across every matching row (not just the latest) because a leg may call the
 *  tool more than once (e.g. varying `lastN`) and may legitimately reply about a thread seen on
 *  an earlier call THIS round. A malformed/unparseable row is skipped, never thrown (journal
 *  rows are engine-written via canonicalJson, so this is defense-in-depth, not an expected
 *  path). */
export function journaledReviewThreadIds(rows: readonly ForgeProxyJournalRow[], expectedPr: number): Set<string> {
  const ids = new Set<string>();
  for (const row of rows) {
    if (row.tool !== TOOL_PR_REVIEW_THREADS) continue;
    if (row.status !== "fetched" && row.status !== "delivered") continue;
    if (!row.responseCanonical) continue;
    let argsPr: unknown;
    try {
      argsPr = (JSON.parse(row.argsCanonical) as { pr?: unknown }).pr;
    } catch {
      continue;
    }
    if (argsPr !== expectedPr) continue; // journaled REQUEST names a different PR — excluded
    let parsed: { pr?: unknown; threads?: { id?: unknown }[] };
    try {
      parsed = JSON.parse(row.responseCanonical) as { pr?: unknown; threads?: { id?: unknown }[] };
    } catch {
      continue;
    }
    if (parsed.pr !== expectedPr) continue; // journaled RESPONSE names a different PR — excluded
    for (const t of parsed.threads ?? []) {
      if (typeof t.id === "string") ids.add(t.id);
    }
  }
  return ids;
}

/** #461: every engine-review RUN id this leg was actually SERVED an audit comment for, scoped to
 *  `expectedPr` — the audit-comment twin of `journaledReviewThreadIds` above, and the first of the
 *  two facts a `findingResponses` entry must clear. Same PR-binding discipline (BOTH the journaled
 *  REQUEST args and the RESPONSE must name `expectedPr`, closing the same cross-PR confused-deputy
 *  shape), same round-scoping by the caller's cursor, same skip-never-throw stance on a malformed
 *  row. `runId` is read as a STRUCTURED field of the tool's own response envelope
 *  (`proxy/tools.ts`'s `fetchPRAuditCommentsResponse`, which spreads the parsed marker), never
 *  scraped out of the rendered Markdown body — the doctrine's authoritative-signals rule. */
export function journaledAuditRunIds(rows: readonly ForgeProxyJournalRow[], expectedPr: number): Set<string> {
  const runIds = new Set<string>();
  for (const row of rows) {
    if (row.tool !== TOOL_PR_AUDIT_COMMENTS) continue;
    if (row.status !== "fetched" && row.status !== "delivered") continue;
    if (!row.responseCanonical) continue;
    let argsPr: unknown;
    try {
      argsPr = (JSON.parse(row.argsCanonical) as { pr?: unknown }).pr;
    } catch {
      continue;
    }
    if (argsPr !== expectedPr) continue;
    let parsed: { pr?: unknown; comments?: { runId?: unknown }[] };
    try {
      parsed = JSON.parse(row.responseCanonical) as { pr?: unknown; comments?: { runId?: unknown }[] };
    } catch {
      continue;
    }
    if (parsed.pr !== expectedPr) continue;
    for (const c of parsed.comments ?? []) {
      if (typeof c.runId === "string") runIds.add(c.runId);
    }
  }
  return runIds;
}

/** #461: the `findingIndex` bound, per run — the SECOND fact a `findingResponses` entry must
 *  clear, and the one the leg cannot influence at all. The count comes from the engine's OWN
 *  persisted review artifact (the `engine_review_wal` row's `EngineReviewArtifact.findings`, the
 *  same array `review/audit.ts` numbers `[N]` when it renders the comment), and is honored ONLY
 *  when that run is also in `servedRunIds` — a leg may only answer a review it was actually shown,
 *  and may only name an index that review actually produced. A WAL that has already moved on to a
 *  newer run authorizes NOTHING (returns empty): the engine cannot prove what the leg was shown,
 *  so it trusts none of it. */
export function knownAuditFindingCounts(
  state: Pick<State, "getEngineReviewWal">,
  worker: string,
  servedRunIds: ReadonlySet<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  const wal = state.getEngineReviewWal(worker);
  if (!wal || !servedRunIds.has(wal.runId) || !wal.reviewArtifactJson) return counts;
  const artifact = parseEngineReviewArtifact(wal.reviewArtifactJson);
  if (artifact) counts.set(wal.runId, artifact.findings.length);
  return counts;
}

/** #247 D2/F1 (Codex sol-high PR #265 review rounds 1+2): the per-fix-round journal cursor —
 *  validateFixResponseOutput must only trust `pr_review_threads` rows THIS fix round's session
 *  actually saw, never an earlier round's journal rows for the SAME session name (`startFixLeg`,
 *  conductor.ts, reuses the SAME worker row/lane name across every fix round — session alone
 *  conflates every round together).
 *
 *  F1 (round 2): a WALL-CLOCK cutoff (round 1's own `fix-leg-started.at`) has three defects a
 *  monotonic ROW ID closes: (1) `requestedAt >= cutoff` admits an equal-timestamp prior-leg row
 *  (a `>=` compare on colliding timestamps, not a strict ordering); (2) the cutoff was captured
 *  AFTER `resume()` already confirmed the spawn, so a genuinely fast child's OWN first tool call
 *  could complete and journal BEFORE the engine got around to computing `now().toISOString()`
 *  for the event it appends immediately after — postdating a legitimate row, spuriously failing
 *  the whole batch; (3) a crash-adopted leg (reconcileDrivingFixIntents' "confirmed" branch)
 *  never went through `startFixLeg` at all, so no `fix-leg-started` event — and thus no
 *  cursor — ever existed for it, permanently rejecting its output. The fix: conductor.ts now
 *  reads `State.maxForgeProxyJournalId(session)` BEFORE each of the three places a fix leg's
 *  child can start making tool calls (`startFixLeg`, the fixing-continuation resume, and the
 *  adoption path), and carries that number as `journalCursor` on the `fix-leg-started` /
 *  `fix-leg-resumed` / `fix-leg-adopted` events respectively (no new schema — same event-reuse
 *  trick as round 1). A row id captured strictly BEFORE resume() is called can never postdate
 *  that leg's own first journal row, closing defect (2); an integer `>` comparison
 *  (`listForgeProxyJournalForSession`'s `id > afterId`) is a true strict ordering, closing defect
 *  (1); and the adoption path now carries its own cursor too, closing defect (3).
 *
 *  Looks up whichever of the three event kinds is NEWEST for (worker, fixRounds) — a lane can
 *  pass through adopt-then-resume for the SAME round (fix_rounds bumped once, at whichever step
 *  first confirms the spawn), so the tightest, most-recent cursor for that round wins. Returns
 *  null only when NO cursor-bearing event exists for (worker, fixRounds) at all — the caller
 *  treats null as "trust nothing this round", fail-closed; `journalCursor: 0` (a session with no
 *  prior journal rows at cursor time) is a perfectly valid cursor, not "no cursor found". */
export function fixLegJournalCursor(state: Pick<State, "eventsSince">, worker: string, fixRounds: number): number | null {
  const events = state.eventsSince("1970-01-01T00:00:00.000Z", ["fix-leg-started", "fix-leg-resumed", "fix-leg-adopted"]);
  for (let i = events.length - 1; i >= 0; i--) {
    const payload = events[i]!.payload as { worker?: unknown; fixRounds?: unknown; journalCursor?: unknown };
    if (payload.worker === worker && payload.fixRounds === fixRounds && typeof payload.journalCursor === "number") {
      return payload.journalCursor;
    }
  }
  return null;
}

/** The stable key identifying ONE fix round's whole batch of thread responses (D4/D6
 *  provenance) — a given (worker, pr, fixRounds) triple produces at most one validated batch by
 *  construction (a fix round runs its session exactly once against exactly one PR), so this
 *  doubles as the pending_thread_writes de-dup key (State.enqueueThreadWrite's `INSERT OR
 *  IGNORE` on (batch_key, thread_id)) and the deterministic reply marker's namespace (D3). `pr`
 *  is included (F5, Codex sol-high PR #265 review round 2, P3): `worker` alone is a lane NAME,
 *  and lane names CAN be reused across an engine's lifetime (a fresh dispatch long after an old
 *  lane's rows were swept) — without `pr` in the key, a name-reuse pathology could let a stale
 *  row from an unrelated PR's fix round collide with a new one's (batch_key, thread_id) pair
 *  under `INSERT OR IGNORE`, silently dropping a legitimate write. */
export function fixResponseBatchKey(worker: string, pr: number, fixRounds: number): string {
  return `${worker}#${pr}#${fixRounds}`;
}

/** Compute (READ-ONLY, no writes — D4) what a fixing lane's terminal DONE output resolves to:
 *  a validated batch ready to enqueue, or an invalid descriptor. Called BEFORE the terminal
 *  state transition so its result can be committed in the SAME atomic transaction
 *  (State.settleTerminalWorker) as the worker row + spend + queue rows + receipt event — a
 *  crash between "settled to driving" and "batch enqueued" is thereby impossible: either
 *  everything lands, or nothing does (the row stays `fixing`, retried next tick, and re-derives
 *  the identical batch from the SAME resultText/journal). */
export function computeFixResponseHarvest(
  state: Pick<State, "listForgeProxyJournalForSession" | "eventsSince" | "getEngineReviewWal">,
  input: {
    worker: string;
    issue: number;
    fixRounds: number;
    prNumber: number | null;
    resultText: string;
    /** #451: the head this fix round answered — see FixResponseSettleBatch.headOid's own doc.
     *  Threaded straight through to the batch; this function does not itself validate it against
     *  anything (the caller, conductor.ts's reclaimTerminalLane, is the one place that still has
     *  it, read from the lane's own row before its terminal write clears it). */
    headOid: string | null;
    /** #490: see FixResponseSettleBatch.threadless/.newHead — threaded straight through, like
     *  headOid above. The caller supplies threadless from cfg.reviewer.mode and newHead from the
     *  probe's worktreeHead. Optional with classic-shaped defaults (false/null) — pre-#490
     *  fixtures and the classic path read identically either way. */
    threadless?: boolean;
    newHead?: string | null;
  },
): FixResponseSettleOutcome {
  if (input.prNumber == null) {
    // Fail-safe only — a fixing lane always already carries a PR (startFixLeg's own invariant).
    return {
      kind: "invalid",
      invalid: { worker: input.worker, issue: input.issue, pr: null, reason: "fixing lane reclaimed DONE with no PR" },
    };
  }
  const cursor = fixLegJournalCursor(state, input.worker, input.fixRounds);
  const rows = cursor != null ? state.listForgeProxyJournalForSession(input.worker, cursor) : [];
  const known = journaledReviewThreadIds(rows, input.prNumber);
  // #461: the audit-comment channel's own known-set — served runs (journal) x that run's reviewed
  // finding count (WAL). Empty on the classic path (no audit comment is ever served there), which
  // is exactly the fail-closed default validateFixResponseOutput applies to `findingResponses`.
  const knownFindings = knownAuditFindingCounts(state, input.worker, journaledAuditRunIds(rows, input.prNumber));
  const validated = validateFixResponseOutput(input.resultText, known, knownFindings);
  if (!validated.ok) {
    return { kind: "invalid", invalid: { worker: input.worker, issue: input.issue, pr: input.prNumber, reason: validated.reason } };
  }
  return {
    kind: "batch",
    batch: {
      worker: input.worker,
      issue: input.issue,
      pr: input.prNumber,
      fixRounds: input.fixRounds,
      batchKey: fixResponseBatchKey(input.worker, input.prNumber, input.fixRounds),
      writes: validated.responses,
      findingWrites: validated.findingResponses,
      headOid: input.headOid,
      threadless: input.threadless ?? false,
      newHead: input.newHead ?? null,
    },
  };
}

// ── Dispute escalation (#451, design #402 §4/§4a/D4) ───────────────────────────────────────

/** One thread's LATEST durably-recorded resolution for a (worker, pr) — see
 *  `latestThreadResolutions`' own doc for why this must come from the event log rather than a
 *  live GitHub read. */
export interface ThreadResolutionRecord {
  resolution: "addressed" | "disputed";
  reply: string;
  /** The head this resolution was recorded against (`fix-response-queued`'s own `headOid`) —
   *  `null` only for a pre-#451 event, read fail-closed (never matches a live head). */
  headOid: string | null;
  fixRounds: number;
}

/** Every thread's LATEST recorded resolution for (worker, pr), folded from `fix-response-queued`
 *  receipt events (state.ts's settleTerminalWorker) in ledger order — newest event wins per
 *  threadId, the same last-event-wins fold escalation-reconcile.ts's `openEscalations` uses for
 *  the identical reason (a thread can be re-disputed across more than one fix round; the LATEST
 *  fact is the only one that matters).
 *
 *  This is the ONE durable source of "was this thread disputed, and against which head" — see
 *  `fix-response-queued`'s own doc (state.ts) for why live GitHub state cannot answer it: an
 *  unresolved thread with our reply already posted is indistinguishable, from a pure live read,
 *  between `disputed` (final, by design) and `addressed` with its resolve call still retrying
 *  (the same pending_thread_writes queue's bounded-retry path). A malformed event (missing/wrong-
 *  typed fields) contributes nothing for that entry, never throws — same best-effort-bookkeeping
 *  stance escalation-reconcile.ts's `openEscalations` takes over the identical ledger. */
export function latestThreadResolutions(
  events: readonly { kind: string; payload: unknown }[],
  worker: string,
  pr: number,
): Map<string, ThreadResolutionRecord> {
  const latest = new Map<string, ThreadResolutionRecord>();
  for (const e of events) {
    if (e.kind !== "fix-response-queued") continue;
    const payload = e.payload as {
      worker?: unknown;
      pr?: unknown;
      fixRounds?: unknown;
      headOid?: unknown;
      writes?: readonly { threadId?: unknown; resolution?: unknown; reply?: unknown }[];
    } | null;
    if (payload?.worker !== worker || payload?.pr !== pr) continue;
    const fixRounds = typeof payload.fixRounds === "number" ? payload.fixRounds : 0;
    const headOid = typeof payload.headOid === "string" ? payload.headOid : null;
    for (const w of payload.writes ?? []) {
      if (typeof w.threadId !== "string") continue;
      if (w.resolution !== "addressed" && w.resolution !== "disputed") continue;
      latest.set(w.threadId, { resolution: w.resolution, reply: typeof w.reply === "string" ? w.reply : "", headOid, fixRounds });
    }
  }
  return latest;
}

/** One disputed item's evidence for a `review-disputed` escalation comment (design §4's five
 *  items, minus the two the caller already has — worker/issue/pr are the lane's own, fix rounds
 *  spent is `w.fix_rounds`). `ref` is whatever identifies the disputed thing on its own path: a
 *  GitHub review-thread id (classic) or `<runId>#<findingIndex>` (#461, engine-agent). */
export interface DisputedEvidence {
  ref: string;
  findingBody: string;
  reply: string;
}

export interface DisputeEscalation {
  headOid: string;
  /** #461: which channel carried the dispute. Both end at the SAME needs-human escalation
   *  (conductor.ts's `escalateReviewDisputed`, the same `review-disputed` event kind and the same
   *  #147 gated-reentry way out) — the tag only picks the noun the comment/payload use, so a human
   *  reading the audit trail can tell a thread dispute from an audit-comment finding dispute. The
   *  two are mutually exclusive on any one tick by construction: the classic predicate needs live
   *  unresolved threads (which the engine-agent path never has), the finding predicate needs a
   *  `verdictRunId` (which the classic path never carries). */
  source: "thread" | "finding";
  items: DisputedEvidence[];
}

/** #451 (design #402 §4/D4): true iff EVERY unresolved review thread on the PR's CURRENT head has
 *  a durably-recorded `disputed` resolution for that SAME head — the one condition under which a
 *  FIXABLE tick escalates directly to `needs-human` instead of dispatching a fix leg, at zero paid
 *  fix-round cost. Returns `null` for every other case (nothing to adjudicate, a mix of
 *  addressed/unanswered threads, a stale-head dispute, a capped/partial thread page, or an
 *  unreadable live read) — the caller falls through to the pre-existing FIXUP/ESCALATE decision
 *  unchanged.
 *
 *  CLASSIC-REVIEWER-PATH ONLY, structurally (design §4a): on the engine-agent path
 *  `getPRReviewThreads` returns zero threads (review/drive.ts's synthetic HANDLE_THREADS mapping
 *  never creates one — merge-driver.ts's own module doc, "the engine has no thread-CREATING forge
 *  write"), so `unresolved.length === 0` below is reached and this returns `null` unconditionally
 *  — this function needs no `verdictRunId`/reviewer-kind branch to stay correct on that path. The
 *  CALLER (conductor.ts) additionally skips calling this function at all when
 *  `outcome.verdictRunId !== undefined` (#451 gate② P3(b)) — a pure cost optimization layered on
 *  top of this correctness property, not a substitute for it: `outcome.verdictRunId` is set only
 *  for an engine-agent-caused fixable, so the two live forge reads below are structurally
 *  guaranteed to end in `null` there, and skipping them is free. Either way, this predicate is
 *  naturally disjoint from #457's verdict-rerun breaker (conductor.ts) — see
 *  conductor.test.ts's disjointness assertion.
 *
 *  FAIL-CLOSED on an unreadable live read, a capped/partial thread page, or an unknown/absent
 *  recorded head (never escalates on an unproven current-head match) — a forge error or an
 *  incomplete view here must never be read as "go ahead," the same posture every other DRIVE
 *  branch in this file's caller takes.
 *
 *  TOCTOU (gate② round 3, Codex P1): the two initial reads (`getPRStatus`, `getPRReviewThreads`)
 *  race a push — the same class of split-read hazard merge-driver.ts's driveOne already guards
 *  against for gate①/gate② (`status.headOid !== data.headOid` -> queue). A push landing
 *  between/during them could let `headOid` (from `getPRStatus`) and `threadsPage` (from
 *  `getPRReviewThreads`, fetched independently) describe two DIFFERENT moments — a durably
 *  recorded `disputed` resolution for head H could then validate against a `threadsPage` view
 *  that is ALREADY stale relative to a newer push, escalating (and writing evidence) against a
 *  head the PR has since moved past. Closed by a THIRD read, `getPRStatus` again, immediately
 *  before returning — the one point every side effect (the label, the comment, the terminal
 *  escalation) is triggered from: the PR must still be OPEN and still be at the SAME `headOid`
 *  every unresolved thread was just validated against, or this returns `null` and the caller
 *  falls through, retried fresh next tick. */
export async function computeDisputeEscalation(
  forge: Pick<IForge, "getPRStatus" | "getPRReviewThreads">,
  state: Pick<State, "eventsSince">,
  cfg: Pick<SapwoodConfig, "proxy">,
  worker: string,
  pr: number,
): Promise<DisputeEscalation | null> {
  let headOid: string;
  let threadsPage: ReviewThreadsPage;
  try {
    const [status, page] = await Promise.all([forge.getPRStatus(pr), forge.getPRReviewThreads(pr, cfg.proxy.caps.maxCommentsPerThread)]);
    headOid = status.headOid;
    threadsPage = page;
  } catch {
    return null; // fail-closed: cannot prove the current head — never escalate on an unreadable read
  }
  // #451 gate② P3(a): `pageCapped` (forge.ts's ReviewThreadsPage doc) means `threads` is only a
  // PARTIAL view — an unresolved, undisputed thread beyond the page ceiling would be invisible,
  // and "every unresolved thread is disputed" could be satisfied by a view that simply never saw
  // the one that isn't. Fail-closed, same posture as the unreadable-read case above: a proof over
  // an admittedly-incomplete set is no proof at all.
  if (threadsPage.pageCapped) return null;
  const unresolved = threadsPage.threads.filter((t) => !t.isResolved);
  if (unresolved.length === 0) return null; // nothing to adjudicate (also the whole §4a engine-agent case)
  const records = latestThreadResolutions(state.eventsSince("1970-01-01T00:00:00.000Z", ["fix-response-queued"]), worker, pr);
  const items: DisputedEvidence[] = [];
  for (const t of unresolved) {
    const record = records.get(t.id);
    if (record === undefined || record.resolution !== "disputed" || record.headOid !== headOid) return null;
    items.push({ ref: t.id, findingBody: t.comments[0]?.body ?? "(no comment body available)", reply: record.reply });
  }
  // #451 gate② round 3 (Codex P1): TOCTOU close — re-validate immediately before the caller acts
  // on this result. See this function's own doc for the race the two reads above are exposed to.
  let recheck: { state: string; headOid: string };
  try {
    recheck = await forge.getPRStatus(pr);
  } catch {
    return null; // fail-closed: cannot reconfirm — never escalate on an unproven current state
  }
  if (recheck.state !== "OPEN" || recheck.headOid !== headOid) return null;
  return { headOid, source: "thread", items };
}

/** #461: every finding response this lane has durably recorded for (worker, pr), newest receipt
 *  wins per `(runId, findingIndex)` — the audit-comment twin of `latestThreadResolutions` above,
 *  folded from the SAME `fix-response-queued` receipts (state.ts's settleTerminalWorker) for the
 *  same reason: nothing on GitHub records that a producer disputed an audit-comment finding (the
 *  comment is engine-written and never edited, and there is no thread to leave unresolved), so
 *  this ledger is the only durable carrier. Malformed entries contribute nothing, never throw. */
export function latestFindingResolutions(
  events: readonly { kind: string; payload: unknown }[],
  worker: string,
  pr: number,
): Map<string, FixFindingResponse> {
  const latest = new Map<string, FixFindingResponse>();
  for (const e of events) {
    if (e.kind !== "fix-response-queued") continue;
    const payload = e.payload as {
      worker?: unknown;
      pr?: unknown;
      findingWrites?: readonly { runId?: unknown; findingIndex?: unknown; resolution?: unknown; reply?: unknown }[];
    } | null;
    if (payload?.worker !== worker || payload?.pr !== pr) continue;
    for (const w of payload.findingWrites ?? []) {
      if (typeof w.runId !== "string" || typeof w.findingIndex !== "number" || !Number.isInteger(w.findingIndex)) continue;
      if (w.resolution !== "addressed" && w.resolution !== "disputed") continue;
      latest.set(`${w.runId}#${w.findingIndex}`, {
        runId: w.runId,
        findingIndex: w.findingIndex,
        resolution: w.resolution,
        reply: typeof w.reply === "string" ? w.reply : "",
      });
    }
  }
  return latest;
}

/** #461 (the audit-comment counterpart of `computeDisputeEscalation` above): the evidence for a
 *  needs-human escalation when a fix leg answered the STANDING engine-agent verdict by disputing
 *  one or more of its findings. Returns `null` — caller falls through to today's decision,
 *  unchanged — whenever there is nothing to adjudicate or the dispute cannot be PROVEN current.
 *
 *  Currency is proven by the run id alone, and that is stronger than it looks: an engine-agent
 *  verdict is head-and-diff-pinned (`review/drive.ts`'s WAL), so `verdictRunId` — the run whose
 *  rejection caused THIS tick's fixable (`merge-driver.ts`'s finalizeVerdict) — changes the moment
 *  the PR does. A dispute recorded against an older run therefore never speaks for the current
 *  verdict, and a leg that actually pushed gets re-reviewed under a new run id whose findings
 *  nobody has disputed yet. No live forge read is needed (or made) to establish any of this.
 *
 *  FAIL-CLOSED, same posture as its thread twin: no WAL row, a WAL that has moved past
 *  `verdictRunId`, an unparseable/absent artifact, or an out-of-range index all yield "no proven
 *  dispute" rather than an escalation the engine cannot show its evidence for. Nothing here
 *  approves anything or touches the verdict — producer ≠ reviewer: the dispute is routed to a
 *  human, never honored by the engine. */
export function computeFindingDisputeEscalation(
  state: Pick<State, "eventsSince" | "getEngineReviewWal">,
  worker: string,
  pr: number,
  verdictRunId: string,
): DisputeEscalation | null {
  const wal = state.getEngineReviewWal(worker);
  if (!wal || wal.runId !== verdictRunId || !wal.reviewArtifactJson) return null;
  const artifact = parseEngineReviewArtifact(wal.reviewArtifactJson);
  if (!artifact) return null;
  const records = [
    ...latestFindingResolutions(state.eventsSince("1970-01-01T00:00:00.000Z", ["fix-response-queued"]), worker, pr).values(),
  ];
  const items = records
    .filter((r) => r.resolution === "disputed" && r.runId === verdictRunId && r.findingIndex < artifact.findings.length)
    .sort((a, b) => a.findingIndex - b.findingIndex)
    .map((r) => ({
      ref: `${r.runId}#${r.findingIndex}`,
      findingBody: artifact.findings[r.findingIndex]?.body ?? "(finding body unavailable)",
      reply: r.reply,
    }));
  return items.length > 0 ? { headOid: wal.head, source: "finding", items } : null;
}

// ── Durable-queue execution (mirrors conductor.ts's attemptRollback shape, #31) ─────────────

export type FixResponseWriteOutcome =
  | { kind: "recorded"; worker: string; issue: number; threadId: string } // disputed: reply posted, no resolve
  | { kind: "resolved"; worker: string; issue: number; threadId: string } // addressed: reply + resolve both done
  | { kind: "retrying"; worker: string; issue: number; threadId: string; attempts: number }
  | { kind: "escalated"; worker: string; issue: number; threadId: string; attempts: number };

/** D3 (Codex sol-high PR #265 review round 1, P1): the deterministic marker embedded in every
 *  posted reply, namespaced by the batch key + threadId — an HTML comment (invisible in
 *  rendered markdown, same convention as harvestMarker/ENGINE_COMMENT_MARKER) that lets a LATER
 *  attempt prove a reply already landed on GitHub even when the durable `reply_posted` flag
 *  itself never committed (a crash between the forge call succeeding and that flag's write). */
function replyMarker(batchKey: string, threadId: string): string {
  return `<!-- sapwood:fix-reply:${batchKey}:${threadId} -->`;
}

/** D3/F2 (Codex sol-high PR #265 review rounds 1+2): true when `marker` is already present
 *  among `threadId`'s own NEWEST comments, per a LIVE read — the crash-safety check
 *  attemptThreadWrite makes BEFORE every reply-post attempt. Uses getReviewThreadCommentsTail
 *  (F2(b): `last:` semantics), not getPRReviewThreads' `first: cap` default view — the marker
 *  this function looks for is, by construction, the NEWEST comment on the thread (it was just
 *  posted), so a `first:`-capped read on a thread longer than the cap would never see it,
 *  producing a false "not posted" on every subsequent tick.
 *
 *  F2(a): DELIBERATELY never catches — a read failure propagates to the caller, which fails
 *  CLOSED (retries next tick, never posts through this unverifiable window). Round 1's version
 *  caught and returned `false` ("not yet posted"), which reposted in EXACTLY the crash window
 *  D3 exists to close (a transient read failure right after a successful post would have looked
 *  identical to "never posted", triggering a duplicate replyToReviewThread call). */
async function replyAlreadyPosted(
  forge: Pick<IForge, "getReviewThreadCommentsTail">,
  threadId: string,
  marker: string,
  commentsCap: number,
): Promise<boolean> {
  const bodies = await forge.getReviewThreadCommentsTail(threadId, commentsCap);
  return bodies.some((b) => b.includes(marker));
}

/** D6 (Codex sol-high PR #265 review round 1, P2): the provenance every receipt event carries —
 *  worker/issue/pr/threadId (the write's own identity) plus batchKey/fixRounds (which fix round
 *  produced it) — "every executed write journaled with leg/round provenance" (issue #247 AC). */
function provenance(row: PendingThreadWrite): {
  worker: string;
  issue: number;
  pr: number;
  threadId: string;
  batchKey: string;
  fixRounds: number;
} {
  return { worker: row.worker, issue: row.issue, pr: row.pr, threadId: row.threadId, batchKey: row.batchKey, fixRounds: row.fixRounds };
}

/** One attempt at a durably-persisted fix-thread write (#247). `row` may be a freshly-enqueued
 *  row (attempts: 0) or one read back via state.pendingThreadWrites() on a later tick. Same
 *  bounded-retry-then-escalate contract as attemptRollback: never throws — a still-failing
 *  forge only bumps the retry count or escalates to needs-human once `cfg.recovery.
 *  rollbackRetryCap` is hit (the SAME cap board-mutation recovery uses; no new config key for
 *  a second, functionally-identical bounded-retry policy).
 *
 *  IDEMPOTENCY (issue #247 AC): the reply half is attempted ONLY when `row.replyPosted` is still
 *  false, and EVEN THEN a marker check (replyAlreadyPosted, D3/F2) runs first — a crash between
 *  a successful post and the durable flag's own commit is reconciled here instead of double-
 *  posting; a FAILED check fails CLOSED (F2(a) — retries next tick, never posts through an
 *  unverifiable window). Once replyPosted is durably true, no later call ever re-posts,
 *  regardless of how the resolve half fares. A `disputed` row has no resolve half at all: it is
 *  cleared (fully done) the instant its reply posts. F3: the reply-posted/resolved state
 *  changes and their own receipt events are each committed atomically
 *  (State.completeThreadReply/completeThreadResolve) — never separate writes a crash could
 *  split. */
export async function attemptThreadWrite(
  forge: Pick<IForge, "replyToReviewThread" | "resolveReviewThread" | "getReviewThreadCommentsTail" | "addPRLabel">,
  state: Pick<State, "completeThreadReply" | "completeThreadResolve" | "bumpThreadWriteAttempt" | "clearThreadWrite" | "appendEvent">,
  cfg: Pick<SapwoodConfig, "recovery" | "labels" | "proxy">,
  row: PendingThreadWrite,
  iso: () => string,
): Promise<FixResponseWriteOutcome> {
  if (!row.replyPosted) {
    const marker = replyMarker(row.batchKey, row.threadId);
    let alreadyPosted: boolean;
    try {
      alreadyPosted = await replyAlreadyPosted(forge, row.threadId, marker, cfg.proxy.caps.maxCommentsPerThread);
    } catch (e) {
      // F2(a): the reconcile read itself failed — never default to "not posted yet" (that
      // would repost through exactly the crash window D3 exists to close). Fail closed: retry
      // (re-check, and maybe post) next tick instead.
      return escalateOrRetry(forge, state, cfg, row, e, iso);
    }
    if (!alreadyPosted) {
      try {
        await forge.replyToReviewThread(row.threadId, `${row.reply}\n\n${marker}`);
      } catch (e) {
        return escalateOrRetry(forge, state, cfg, row, e, iso);
      }
    }
    try {
      state.completeThreadReply(row.id, iso(), provenance(row));
    } catch (e) {
      // D3: the forge post above (or the marker check finding it already there) SUCCEEDED, but
      // this durable write did not — never re-post on the next attempt (replyAlreadyPosted will
      // find the marker and skip straight to here again), only retry THIS write.
      return escalateOrRetry(forge, state, cfg, row, e, iso);
    }
  }
  if (row.resolution === "disputed") {
    // Speak-not-act (issue #247's Why, PLAN.md dissent doctrine): a disputed thread stays open
    // on GitHub — nothing left to do once its reply lands (already receipted above).
    try {
      state.clearThreadWrite(row.id);
    } catch (e) {
      return escalateOrRetry(forge, state, cfg, row, e, iso);
    }
    return { kind: "recorded", worker: row.worker, issue: row.issue, threadId: row.threadId };
  }
  if (!row.resolved) {
    try {
      await forge.resolveReviewThread(row.threadId);
    } catch (e) {
      return escalateOrRetry(forge, state, cfg, row, e, iso);
    }
    try {
      state.completeThreadResolve(row.id, iso(), provenance(row));
    } catch (e) {
      // The resolve mutation itself already succeeded upstream — GitHub's resolveReviewThread
      // on an already-resolved thread is a no-op success, so re-attempting on the next tick is
      // safe (unlike reply, no marker check is needed here).
      return escalateOrRetry(forge, state, cfg, row, e, iso);
    }
    return { kind: "resolved", worker: row.worker, issue: row.issue, threadId: row.threadId };
  }
  // Defensive only: reply posted, addressed, and already resolved — a prior attempt succeeded
  // at both but the row was somehow never cleared. Clear it now rather than retry forever.
  try {
    state.clearThreadWrite(row.id);
  } catch (e) {
    return escalateOrRetry(forge, state, cfg, row, e, iso);
  }
  return { kind: "resolved", worker: row.worker, issue: row.issue, threadId: row.threadId };
}

/** Bump-and-retry under `cfg.recovery.rollbackRetryCap`; escalate once the cap is hit. Never
 *  throws.
 *
 *  F4 (Codex sol-high PR #265 review round 2, P2): #147's own ordering rule — a durable latch a
 *  human's escalation depends on (the needs-human label) must land BEFORE the evidence it
 *  depends on disappears. Round 1's order (clear the row FIRST, label best-effort/swallowed)
 *  let a FAILED label write leave NOTHING pending: DRIVE would resume the lane the very same
 *  tick with zero trace anything had gone wrong. Now: the label write is attempted FIRST: on
 *  failure the row is KEPT (pending — DRIVE keeps skipping this lane) and the WHOLE escalation
 *  is retried next tick (never silently re-admits the lane); only once the label has landed does
 *  the row actually clear and the escalation event fire.
 *
 *  #398 — CARRIER: ONE label, on the PR. This escalation is PR-born by construction — the write
 *  that failed is a reply to, or a resolution of, a REVIEW THREAD on this lane's pull request —
 *  so the PR is where the fact belongs and where the merge gate reads it. It used to write both
 *  objects, which meant a human had to strip the label TWICE before the lane was released; that
 *  is the F19–F21 residue class the 2026-07-27 retro named (dogfood lanes 144 and 295 both
 *  needed the manual double removal). `row.pr` is non-nullable on `PendingThreadWrite`, so there
 *  is no PR-less arm to fall back to here. */
async function escalateOrRetry(
  forge: Pick<IForge, "addPRLabel">,
  state: Pick<State, "bumpThreadWriteAttempt" | "clearThreadWrite" | "appendEvent">,
  cfg: Pick<SapwoodConfig, "recovery" | "labels">,
  row: PendingThreadWrite,
  e: unknown,
  iso: () => string,
): Promise<FixResponseWriteOutcome> {
  const attempts = row.attempts + 1;
  if (attempts >= cfg.recovery.rollbackRetryCap) {
    try {
      await forge.addPRLabel(row.pr, cfg.labels.needsHuman);
    } catch (labelError) {
      state.bumpThreadWriteAttempt(row.id, iso());
      state.appendEvent("fix-thread-write-escalation-label-failed", { ...provenance(row), attempts, error: String(labelError) });
      return { kind: "retrying", worker: row.worker, issue: row.issue, threadId: row.threadId, attempts };
    }
    state.clearThreadWrite(row.id);
    state.appendEvent("fix-thread-write-escalated", { ...provenance(row), attempts, error: String(e) });
    return { kind: "escalated", worker: row.worker, issue: row.issue, threadId: row.threadId, attempts };
  }
  state.bumpThreadWriteAttempt(row.id, iso());
  state.appendEvent("fix-thread-write-retry-failed", { ...provenance(row), attempts, error: String(e) });
  return { kind: "retrying", worker: row.worker, issue: row.issue, threadId: row.threadId, attempts };
}
