// review/agent-output.ts (#286, E4a, design #279 §2/§6) — the engine-agent review session's
// structured JSON output: STRICT schema validation + pure engine-side derivation into an
// ApprovalResult. "The session never chooses outcomes" (design #279 §1): the session emits
// per-AC judgments and findings only; `deriveApprovalResult` (below) is the ONE place that turns
// those into approved/rejected. No `overall`, no `headOid` field is accepted at all — even a
// producer-influenced or malfunctioning session smuggling one in fails validation outright (an
// extra key rejects the WHOLE output, see `validateAgentReviewOutput`), so "an output claiming
// overall: approved" can never reach a verdict through this path (design #279 §1: "no overall,
// no headOid"). Malformed/unparseable output is NOT a verdict — `parseAgentReviewOutputText`
// returns `null` for it, and engine-agent.ts's retry/`unavailable` path (design #279 §6) is what
// consumes that, never a partial-accept.

import type { ApprovalResult } from "../roles/reviewer.js";
import { type Finding, isFinding, validateFindings } from "../roles/reviewer.js";
import { parseStructuredBlock } from "../state/structured-output.js";
import type { AcceptanceCriterion } from "./ac-snapshot.js";

/** One AC-manifest id's per-criterion judgment (design #279 §2/§4.1):
 *   - `confirmed`      — code-verifiable AND satisfied by the FULL chain (design #279 §4): a
 *                        named, substantive, non-skipped test on the discovery path (agent
 *                        judgment) plus the engine's own deterministic CI-evidence check (out of
 *                        THIS module's scope — engine-agent.ts/E4b compose the two).
 *   - `cannot-confirm` — the agent looked and could not establish the criterion holds — a
 *                        BLOCKING signal (see deriveApprovalResult: any cannot-confirm entry
 *                        without an accompanying finding gets one synthesized).
 *   - `claim-accepted` — no code-verifiable evidence exists for this criterion (e.g. a doc/config
 *                        change with no natural test) but the agent accepts the claim anyway —
 *                        recorded as an unreproduced-claim marker
 *                        (ApprovalEvidence.unreproducedClaims, reviewer.ts's #286 extension),
 *                        never silently indistinguishable from `confirmed`. */
export type PerAcStatus = "confirmed" | "cannot-confirm" | "claim-accepted";

const PER_AC_STATUSES: readonly PerAcStatus[] = ["confirmed", "cannot-confirm", "claim-accepted"];

export interface PerAcResult {
  id: string;
  status: PerAcStatus;
}

/** The session's ENTIRE structured output, post-validation — exactly `perAC` + `findings`, never
 *  more (design #279 §1/§6: "Output schema unchanged (perAC + findings; no overall, no
 *  headOid)"). */
export interface AgentReviewOutput {
  perAC: PerAcResult[];
  findings: Finding[];
}

/** Strict per-entry shape guard: EXACTLY `{id, status}` — an extra key on one entry invalidates
 *  that entry (and, via validateAgentReviewOutput's `.every`, the whole output — no partial
 *  accept). `status` must be one of the three PerAcStatus literals; anything else (a typo, a
 *  future/unsupported value) fails closed. */
function isPerAcResult(v: unknown): v is PerAcResult {
  if (typeof v !== "object" || v === null) return false;
  const keys = Object.keys(v as Record<string, unknown>);
  if (keys.length !== 2 || !keys.includes("id") || !keys.includes("status")) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.id === "string" && r.id.length > 0 && typeof r.status === "string" && (PER_AC_STATUSES as readonly string[]).includes(r.status)
  );
}

/**
 * Validate an ALREADY-PARSED value against the strict schema (design #279 §2): exactly the two
 * top-level keys `perAC`/`findings` (an `overall`/`headOid`/anything else fails the WHOLE output
 * — never a partial-accept that silently drops just the extra key); every `perAC` entry exactly
 * `{id, status}` with `status` one of the three literals; `perAC`'s ids EXACTLY cover
 * `manifest`'s ids as a SET — an unknown id, a missing id, or a duplicate id all invalidate the
 * whole output (design #279 §2: "ids MUST exactly cover the AC-snapshot manifest ids"); the
 * `findings` array is validated via `validateAgentFindings` (below) — reviewer.ts's shared
 * `validateFindings` (reused as the base, never re-implemented; an empty array is valid, see that
 * function's own doc) plus THIS layer's stricter requirements (exact `{id, body}` keys, unique
 * ids — #302 review, Codex P2).
 *
 * Returns `null` on ANY violation — fail-closed, never a best-effort partial parse. This is the
 * ONE gate a session's raw output must clear before `deriveApprovalResult` (below) ever runs; a
 * `null` here is engine-agent.ts's signal to retry (once, within the remaining budget) or, on a
 * second failure, return `unavailable` — never a partial/degraded verdict.
 */
export function validateAgentReviewOutput(raw: unknown, manifest: readonly AcceptanceCriterion[]): AgentReviewOutput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const topKeys = Object.keys(raw as Record<string, unknown>);
  if (topKeys.length !== 2 || !topKeys.includes("perAC") || !topKeys.includes("findings")) return null;
  const obj = raw as Record<string, unknown>;

  if (!Array.isArray(obj.perAC) || !obj.perAC.every(isPerAcResult)) return null;
  const perAC = obj.perAC as PerAcResult[];

  const manifestIds = new Set(manifest.map((a) => a.id));
  const seenIds = new Set<string>();
  for (const entry of perAC) {
    if (!manifestIds.has(entry.id)) return null; // unknown id
    if (seenIds.has(entry.id)) return null; // duplicate id
    seenIds.add(entry.id);
  }
  if (seenIds.size !== manifestIds.size) return null; // missing id(s)

  if (!validateAgentFindings(obj.findings)) return null;
  const findings = obj.findings as Finding[];

  return { perAC, findings };
}

/** #302 review (Codex P2, findings strictness): the ENGINE-AGENT layer's OWN stricter findings
 *  validation — reviewer.ts's shared `validateFindings` (E1's contract for every reviewer kind)
 *  stays untouched; this wraps it and adds what THIS session-output schema additionally requires:
 *   - exact `{id, body}` keys per finding — an extra key on one finding invalidates the WHOLE
 *     output (same no-partial-accept stance as `isPerAcResult` above);
 *   - id UNIQUENESS within the array — a finding id is E4c's (#288) audit/dedup key, so a
 *     duplicate must fail the whole output here, never be discovered downstream. */
function validateAgentFindings(v: unknown): v is Finding[] {
  if (!validateFindings(v)) return false;
  const seen = new Set<string>();
  for (const f of v) {
    if (Object.keys(f).length !== 2) return false; // exact {id, body} — isFinding checked presence/types
    if (seen.has(f.id)) return false; // duplicate finding id
    seen.add(f.id);
  }
  return true;
}

/** Parse + validate the session's raw `resultText` (worker.ts's `parseResultText` output) in one
 *  step — engine-agent.ts's actual call site. Reuses state/structured-output.ts's
 *  `parseStructuredBlock` — the SAME `<<<SAPWOOD_RESULT>>>...<<<END_SAPWOOD_RESULT>>>` sentinel
 *  convention every other role's structured output already uses (fix-response.ts's
 *  `validateFixResponseOutput` is the closest sibling: parse the block, JSON.parse its metadata,
 *  schema-validate) — rather than requiring the session's ENTIRE final message to be bare JSON.
 *  `null` on a missing/truncated block, a JSON.parse failure, or a schema/AC-id violation
 *  (`validateAgentReviewOutput`) — all three are "NOT a verdict" (design #279 §6): the session's
 *  own retry-once path is what a `null` here feeds, never a thrown exception (a malformed session
 *  transcript is an expected, not exceptional, outcome). No BODY segment is ever consumed here —
 *  `findings[].body` travels as an ordinary JSON string field inside the metadata block itself
 *  (same convention fix-response.ts's `reply` field uses), never a separate raw-markdown segment. */
export function parseAgentReviewOutputText(text: string, manifest: readonly AcceptanceCriterion[]): AgentReviewOutput | null {
  const block = parseStructuredBlock(text);
  if (!block) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(block.metadataRaw);
  } catch {
    return null;
  }
  return validateAgentReviewOutput(raw, manifest);
}

/**
 * Pure engine-side derivation (design #279 §1: "rejected is ENGINE-derived ... the session never
 * chooses outcomes") from an ALREADY-VALIDATED AgentReviewOutput into an ApprovalResult. Never
 * produces `pending`/`unavailable` — those are engine-agent.ts's own setup/retry-path outcomes,
 * entirely outside a validated output's reach; this function's whole domain is "given a session
 * that ran and produced a well-formed answer, what does gate② do with it."
 *
 *  - Any `findings` entry, OR any `cannot-confirm` perAC entry, ⇒ `rejected`. `rejected.findings`
 *    must be non-empty BY TYPE (reviewer.ts's tuple contract, `[Finding, ...Finding[]]`) — a
 *    `cannot-confirm` entry with NO accompanying finding (the agent flagged a criterion but wrote
 *    no finding body for it) gets ONE synthesized per such entry, ONLY when the session's own
 *    `findings` array was empty (documented decision: design #279 §2's "findings non-empty
 *    guaranteed" requirement — when the session already supplied findings, they're used verbatim,
 *    never padded with redundant per-AC restatements).
 *  - Zero findings AND every perAC entry `confirmed`/`claim-accepted` ⇒ `approved`. Every
 *    `claim-accepted` id is recorded in `ApprovalEvidence.unreproducedClaims` (reviewer.ts's #286
 *    extension) — an explicit, auditable "taken on trust" trail, never silently folded into an
 *    ordinary confirmed approval.
 */
export function deriveApprovalResult(output: AgentReviewOutput, headOid: string): ApprovalResult {
  const cannotConfirm = output.perAC.filter((a) => a.status === "cannot-confirm");
  const claimAccepted = output.perAC.filter((a) => a.status === "claim-accepted");

  const findings: Finding[] =
    output.findings.length > 0
      ? output.findings
      : cannotConfirm.map((a) => ({
          id: `ac-${a.id}`,
          body: `Acceptance criterion ${a.id} could not be confirmed by the engine-agent review session.`,
        }));

  if (findings.length > 0) {
    return { kind: "rejected", headOid, findings: findings as [Finding, ...Finding[]] };
  }

  return {
    kind: "approved",
    headOid,
    evidence: {
      freshApprovingReviews: 0,
      freshTrustedSignals: 0,
      ...(claimAccepted.length > 0 ? { unreproducedClaims: claimAccepted.map((a) => a.id) } : {}),
    },
  };
}

// Re-exported so a consumer that only needs the shape guard (e.g. a future prompt-contract test)
// doesn't need to reach back into reviewer.ts directly for it.
export { isFinding };
