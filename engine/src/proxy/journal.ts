// proxy/journal.ts — #234: the write-ahead journal contract + budget metering + frozen evidence
// bundles. mcp-server.ts is the only caller; this module owns the ORDERING invariant (issue
// #234's Journal contract) so it is provable in isolation, without an HTTP server in the loop:
//
//   persist request intent -> fetch+cap -> persist canonical response + hash -> deliver
//
// A response-persist failure (recordForgeProxyJournalResponse throws) must reach the caller as a
// typed tool error and MUST NOT deliver the fetched-but-unrecorded response — runJournaled below
// is the one place that ordering is enforced. No consumer wires the completeness check
// (journalIsComplete) into a live final-output-acceptance gate in this PR (issue #234's scope
// ruling) — it is the primitive the first such gate will call.
//
// HARD INVARIANT (worker.test.ts's #69 grep-invariant test): no node:child_process import, no
// subprocess call, anywhere in this module.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ForgeProxyBundleRow, ForgeProxyIdentity, ForgeProxyJournalResponse, ForgeProxyJournalRow, State } from "../state/state.js";
import { canonicalJson, PROXY_VERSION, type ProxyCaps, type ProxyToolError, sanitizeUpstreamError, toolError } from "./tools.js";

/** The narrow State surface journal.ts needs — kept as a Pick (not the whole State class) so
 *  tests can fake it without a real sqlite handle, same convention peripheral.ts's
 *  RetriedSession.state uses. */
export type ProxyJournalState = Pick<
  State,
  | "nextForgeProxySeq"
  | "appendForgeProxyJournalIntent"
  | "recordForgeProxyJournalResponse"
  | "recordForgeProxyJournalError"
  | "markForgeProxyJournalDelivered"
  | "listForgeProxyJournal"
  | "forgeProxyUsage"
  | "forgeProxyBundleDir"
  | "recordForgeProxyBundle"
>;

export interface ProxyBudget {
  maxCallsPerSession: number;
  maxBytesPerSession: number;
}

/** Remaining budget for `identity`'s session attempt, floored at 0. Computed fresh from the
 *  journal (issue #234's Budget: "meter call count + response bytes against the round ledger
 *  machinery") — never an in-memory counter, so it survives a crash/restart mid-session exactly
 *  like every other durable counter in this codebase. */
export function remainingBudget(
  state: Pick<State, "forgeProxyUsage">,
  identity: ForgeProxyIdentity,
  budget: ProxyBudget,
): { calls: number; bytes: number } {
  const used = state.forgeProxyUsage(identity);
  return { calls: Math.max(0, budget.maxCallsPerSession - used.calls), bytes: Math.max(0, budget.maxBytesPerSession - used.bytes) };
}

export interface JournaledCallInput {
  state: ProxyJournalState;
  identity: ForgeProxyIdentity;
  tool: string;
  args: unknown;
  caps: ProxyCaps;
  budget: ProxyBudget;
  scope: { owner: string; repo: string };
  now: () => Date;
  /** Perform the actual upstream fetch + build the canonical response value. May throw (an
   *  upstream/forge error) — caught and journaled as a sanitized 'error' row. */
  fetch: () => Promise<{
    value: unknown;
    upstreamIds?: (string | number)[];
    upstreamUpdatedAt?: string;
    counts?: Record<string, number>;
    truncated?: boolean;
  }>;
}

/** Thrown by a `fetch` implementation (mcp-server.ts's withTimeout) to signal a hard per-call
 *  timeout, distinct from an ordinary upstream failure — runJournaledCall records `timed_out=1`
 *  on the journal row when it sees this specific type, never inferred from message text. */
export class ProxyTimeoutError extends Error {}

export type JournaledCallResult =
  | { ok: true; journalId: number; response: unknown; contentHash: string }
  | { ok: false; error: ProxyToolError; journalId?: number };

/**
 * The write-ahead sequence for ONE tool call: budget check (before any journal row exists — an
 * exhausted budget never even gets an intent row, nothing was attempted) -> persist intent ->
 * fetch+cap -> persist canonical response+hash (a throw here is the failure this whole function
 * exists to prove: it becomes a typed 'persist_failed' error, and the caller NEVER sees the
 * fetched value) -> return ok so mcp-server.ts can deliver it. On a fetch failure, the error is
 * sanitized and journaled as an 'error' row (never a silent drop — the intent row already proves
 * the call was attempted).
 *
 * CONCURRENCY (#234 F3, PR #252 review, P1, Codex #2): `state` (node:sqlite's `DatabaseSync`) is
 * synchronous, so the stretch from `remainingBudget` through `appendForgeProxyJournalIntent`
 * below runs with NO `await` in between — two overlapping `tools/call` requests cannot both
 * observe the same pre-reservation call count, because whichever one's synchronous block runs
 * first commits its 'intent' row (now counted toward CALL usage, see State.forgeProxyUsage's doc)
 * before the other's `remainingBudget` read can execute. The SAME pattern gates BYTES, just later:
 * the fresh `state.forgeProxyUsage` re-read immediately before `recordForgeProxyJournalResponse`,
 * with no `await` between them, closes the equivalent race across the `await fetch()` boundary
 * (where two calls' fetches can genuinely interleave and both attempt to finalize).
 */
export async function runJournaledCall(input: JournaledCallInput): Promise<JournaledCallResult> {
  const { state, identity, tool, args, caps, budget, scope, now, fetch } = input;
  const remaining = remainingBudget(state, identity, budget);
  if (remaining.calls <= 0) {
    return { ok: false, error: toolError("budget_exhausted", `call budget exhausted (${budget.maxCallsPerSession} calls/session)`) };
  }
  const seq = state.nextForgeProxySeq(identity);
  const requestedAt = now().toISOString();
  const argsCanonical = canonicalJson(args);
  const scopeCanonical = canonicalJson(scope);
  const capsCanonical = canonicalJson(caps);
  // No `await` between remainingBudget above and appendForgeProxyJournalIntent here — see the
  // CONCURRENCY note above. This intent row itself now counts toward the NEXT call's `calls`
  // budget the instant this synchronous block returns.
  const journalId = state.appendForgeProxyJournalIntent({
    identity,
    seq,
    tool,
    proxyVersion: PROXY_VERSION,
    argsCanonical,
    scopeCanonical,
    capsCanonical,
    budgetRemainingCalls: remaining.calls,
    budgetRemainingBytes: remaining.bytes,
    requestedAt,
  });

  let fetched: Awaited<ReturnType<typeof fetch>>;
  try {
    fetched = await fetch();
  } catch (e) {
    const timedOut = e instanceof ProxyTimeoutError;
    const message = sanitizeUpstreamError(e instanceof Error ? e.message : String(e));
    state.recordForgeProxyJournalError(journalId, message, timedOut, now().toISOString());
    return { ok: false, error: toolError("upstream_error", message), journalId };
  }

  const responseCanonical = canonicalJson(fetched.value);
  const contentHash = sha256Hex(responseCanonical);
  const responseBytes = Buffer.byteLength(responseCanonical, "utf8");

  // #234 F3: a FRESH, synchronous re-read of usage — taken as late as possible, immediately
  // before the write below with no `await` in between — is the actual byte-budget gate. The
  // pre-fetch `remaining.bytes` above is now advisory only (recorded on the intent row for
  // observability); another call's response may have landed on this session attempt during our
  // OWN `await fetch()` above, so only a re-check taken right at the finalization boundary can
  // correctly reject a concurrent double-admission.
  const freshUsage = state.forgeProxyUsage(identity);
  if (freshUsage.bytes + responseBytes > budget.maxBytesPerSession) {
    state.recordForgeProxyJournalError(journalId, "response exceeds remaining byte budget", false, now().toISOString());
    return {
      ok: false,
      error: toolError("budget_exhausted", `response would exceed the remaining byte budget (${budget.maxBytesPerSession} bytes/session)`),
      journalId,
    };
  }

  const responseRow: ForgeProxyJournalResponse = {
    responseCanonical,
    contentHash,
    upstreamIds: fetched.upstreamIds !== undefined ? canonicalJson(fetched.upstreamIds) : null,
    upstreamUpdatedAt: fetched.upstreamUpdatedAt ?? null,
    countsCanonical: fetched.counts !== undefined ? canonicalJson(fetched.counts) : null,
    truncated: fetched.truncated ?? false,
    fetchedAt: now().toISOString(),
  };
  try {
    // The write-ahead boundary this whole module exists to enforce: a throw HERE must never let
    // the caller deliver `fetched.value` to the session — it becomes a typed error instead, and
    // the session is free to retry the call or (via unresolvedContext) abstain (issue #234 AC:
    // "a response-persist failure yields a tool error and the session can still abstain").
    state.recordForgeProxyJournalResponse(journalId, responseRow);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      error: toolError("persist_failed", `response could not be journaled: ${sanitizeUpstreamError(message)}`),
      journalId,
    };
  }
  return { ok: true, journalId, response: fetched.value, contentHash };
}

/** Best-effort delivery marker — see the schema v15->v16 migration comment: this is an audit
 *  refinement, not part of the completeness invariant (which already holds once
 *  recordForgeProxyJournalResponse succeeds). Never throws; a failure here is logged by the
 *  caller and otherwise ignored. */
export function markDelivered(state: Pick<State, "markForgeProxyJournalDelivered">, journalId: number, now: () => Date): void {
  state.markForgeProxyJournalDelivered(journalId, now().toISOString());
}

/** True iff every journal row for `identity` that reached the session (status 'fetched' or
 *  'delivered') carries a persisted response + content hash — the predicate a future
 *  final-output-acceptance gate calls (issue #234 AC: "final-output acceptance is blocked while
 *  any delivered response lacks a journal row"). By construction (runJournaledCall's ordering)
 *  this can never be false for rows written through this module — kept as an explicit,
 *  independently-testable check rather than an assumption, defense-in-depth against a future
 *  refactor of the write path. */
export function journalIsComplete(rows: ForgeProxyJournalRow[]): boolean {
  return rows.every((r) => {
    if (r.status !== "fetched" && r.status !== "delivered") return true;
    return r.responseCanonical !== null && r.contentHash !== null;
  });
}

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ── Frozen evidence bundles (issue #234's Frozen evidence bundle) ──────────────────────────

export interface EvidenceBundleInput {
  identity: Pick<ForgeProxyIdentity, "roundId" | "phase" | "role" | "session">;
  /** The default view(s) shown to the session for this decision. */
  defaultView: unknown;
  /** Every exact tool response the session actually used to reach its decision. */
  responses: Array<{ tool: string; args: unknown; response: unknown }>;
  /** A pointer into the decision record this bundle backs — undefined when the caller hasn't
   *  produced one yet (no consumer does, in this PR; see the module doc).
   *
   *  #234: deferred — see follow-up (Codex #7, PR #252 review; moves with #244/consumer
   *  adoption). This is a single, ONE decision per bundle link. A real consumer may find several
   *  decisions cite the SAME content-addressed bundle (e.g. two attempts independently retrieved
   *  identical evidence) — a proper many-to-many link (a join table, or an array here) is a
   *  decision this PR deliberately does not make without a live caller to design it against;
   *  `recordForgeProxyBundle`'s current ON CONFLICT DO NOTHING means only the FIRST decisionRef
   *  for a given hash survives today. */
  decisionRef?: string;
}

export interface PersistedEvidenceBundle {
  hash: string;
  path: string | null;
}

/** Persist ONE frozen evidence bundle, content-addressed by the SHA-256 of its canonical JSON —
 *  issue #234: "persist a content-addressed bundle (default view + exact responses) per accepted
 *  decision, linked from the decision record" (the link is `decisionRef`, when supplied).
 *  Idempotent: re-persisting byte-identical content is a no-op past the first write (same
 *  content -> same hash -> same address, State.recordForgeProxyBundle's ON CONFLICT DO NOTHING).
 *  Writes to `<dataDir>/proxy-bundles/<hash>.json` when a data dir exists; the DB index row is
 *  always recorded regardless (an in-memory State still gets an addressable, hash-keyed record —
 *  `path` is simply null, same null-means-no-directory convention as roundArtifactMdPath).
 *
 *  #234: deferred — see follow-up (Codex #7, PR #252 review; moves with #244/consumer adoption).
 *  The on-disk write below (`existsSync` then `writeFileSync`) is NOT atomic — a crash between
 *  the two could leave a partial file at the content address. Left as-is because there is no
 *  production caller in this PR to observe a torn file, and the DB index row (the actual
 *  addressable record other code would read) is written separately and correctly; a
 *  write-to-temp-then-rename would close this but is not worth adding ahead of a real caller. */
export function persistEvidenceBundle(
  state: Pick<State, "forgeProxyBundleDir" | "recordForgeProxyBundle">,
  input: EvidenceBundleInput,
  now: () => Date,
): PersistedEvidenceBundle {
  const canonical = canonicalJson({ defaultView: input.defaultView, responses: input.responses });
  const hash = sha256Hex(canonical);
  const dir = state.forgeProxyBundleDir();
  let path: string | null = null;
  if (dir) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    path = join(dir, `${hash}.json`);
    if (!existsSync(path)) writeFileSync(path, canonical, "utf8");
  }
  const row: ForgeProxyBundleRow = {
    hash,
    identity: input.identity,
    decisionRef: input.decisionRef ?? null,
    byteSize: Buffer.byteLength(canonical),
    path,
    createdAt: now().toISOString(),
  };
  state.recordForgeProxyBundle(row);
  return { hash, path };
}
