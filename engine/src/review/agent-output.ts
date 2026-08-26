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

import type { ApprovalEvidence } from "../roles/reviewer.js";
import { isFinding, validateFindings } from "../roles/reviewer.js";
import { parseStructuredBlock, RESULT_BLOCK_START } from "../state/structured-output.js";
import type { AcceptanceCriterion } from "./ac-snapshot.js";
import {
  ALLOWED_FINDING_KEYS,
  applySeverityOverride,
  type ClassifiedFinding,
  effectiveSeverity,
  FINDING_KINDS,
  FINDING_OWNERS,
  resolveFindingPath,
} from "./finding-axes.js";

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
 *  headOid)"). #448 (design #402 R1): `findings` is `ClassifiedFinding[]`, not bare `Finding[]` —
 *  each entry MAY carry the `severity`/`kind`/`path` axes (finding-axes.ts), with `path` already
 *  resolved against the reviewed diff's changed-path set (see `validateAgentReviewOutput`'s
 *  `changedPaths` parameter) by the time it reaches here. */
export interface AgentReviewOutput {
  perAC: PerAcResult[];
  findings: ClassifiedFinding[];
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

/** No diff context supplied ⇒ every `path` is treated as unverifiable (dropped, never voided) —
 *  the same fail-closed direction as every other default in this module: a caller that doesn't
 *  thread the reviewed diff's changed-path set through gets the SAFE degraded reading (path
 *  dropped, `pathDropped` recorded), never a silently-trusted, unverified location. */
const NO_CHANGED_PATHS: ReadonlySet<string> = new Set();

/**
 * Validate an ALREADY-PARSED value against the strict schema (design #279 §2): exactly the two
 * top-level keys `perAC`/`findings` (an `overall`/`headOid`/anything else fails the WHOLE output
 * — never a partial-accept that silently drops just the extra key); every `perAC` entry exactly
 * `{id, status}` with `status` one of the three literals; `perAC`'s ids EXACTLY cover
 * `manifest`'s ids as a SET — an unknown id, a missing id, or a duplicate id all invalidate the
 * whole output (design #279 §2: "ids MUST exactly cover the AC-snapshot manifest ids"); the
 * `findings` array is validated via `validateAgentFindings` (below) — reviewer.ts's shared
 * `validateFindings` (reused as the base, never re-implemented; an empty array is valid, see that
 * function's own doc) plus THIS layer's stricter requirements (allowlisted keys + closed enums,
 * unique ids — #302 review Codex P2, extended #448/design #402 R1 §1).
 *
 * `changedPaths` (#448, design #402 §1's fail-closed-defaults table): the reviewed diff's
 * changed-path set, used ONLY to resolve each finding's optional `path` — a `path` present but not
 * a member of `changedPaths` is dropped to `undefined` with `pathDropped: true` recorded (never a
 * validation failure; see `finding-axes.ts`'s `resolveFindingPath`). Defaults to the empty set
 * (`NO_CHANGED_PATHS`) so an existing caller that hasn't been threaded through with diff context
 * yet degrades safely (every supplied `path` drops) rather than failing to compile or trusting an
 * unverified location.
 *
 * Returns `null` on ANY violation — fail-closed, never a best-effort partial parse. This is the
 * ONE gate a session's raw output must clear before `deriveApprovalResult` (below) ever runs; a
 * `null` here is engine-agent.ts's signal to retry (once, within the remaining budget) or, on a
 * second failure, return `unavailable` — never a partial/degraded verdict.
 */
export function validateAgentReviewOutput(
  raw: unknown,
  manifest: readonly AcceptanceCriterion[],
  changedPaths: ReadonlySet<string> = NO_CHANGED_PATHS,
): AgentReviewOutput | null {
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
  const findings = (obj.findings as ClassifiedFinding[]).map((f) => resolveFindingPath(f, changedPaths));

  return { perAC, findings };
}

const FINDING_SEVERITIES: ReadonlySet<string> = new Set(["blocking", "advisory"]);
const FINDING_KIND_SET: ReadonlySet<string> = new Set(FINDING_KINDS);
const FINDING_OWNER_SET: ReadonlySet<string> = new Set(FINDING_OWNERS);

/** #302 review (Codex P2, findings strictness): the ENGINE-AGENT layer's OWN stricter findings
 *  validation — reviewer.ts's shared `validateFindings` (E1's contract for every reviewer kind)
 *  stays untouched; this wraps it and adds what THIS session-output schema additionally requires:
 *   - #448 (design #402 R1 §1): "the strict-shape guard is relaxed by allowlist, not by
 *     loosening" — every key on a finding must be a MEMBER of `ALLOWED_FINDING_KEYS`
 *     (`finding-axes.ts`); a key outside that set still invalidates the WHOLE output, exactly as
 *     the old `Object.keys(f).length !== 2` count check did (the property it was actually
 *     protecting — "an unknown key voids everything" — is retained verbatim, membership replaces
 *     count as the mechanism);
 *   - a present `severity`/`kind`/`owner` (#865) outside its closed enum invalidates the WHOLE
 *     output — schema drift, NOT coerced to a default (design #402 §1's fail-closed-defaults
 *     table: this is the one row that voids rather than degrades); an ABSENT axis is fine
 *     (validated/defaulted later, see `finding-axes.ts`'s `effectiveSeverity`/`effectiveOwner`);
 *   - a present `path` must be a non-empty string (structural type check only — WHICH string is
 *     valid, i.e. membership in the reviewed diff's changed-path set, is resolved afterward by
 *     `validateAgentReviewOutput`'s `resolveFindingPath` call, and never voids the output);
 *   - id UNIQUENESS within the array — a finding id is E4c's (#288) audit/dedup key, so a
 *     duplicate must fail the whole output here, never be discovered downstream. */
function validateAgentFindings(v: unknown): v is ClassifiedFinding[] {
  if (!validateFindings(v)) return false;
  const seen = new Set<string>();
  for (const f of v) {
    const rec = f as unknown as Record<string, unknown>;
    const keys = Object.keys(rec);
    if (!keys.every((k) => ALLOWED_FINDING_KEYS.has(k))) return false; // unknown key voids the WHOLE output
    if ("severity" in rec && !FINDING_SEVERITIES.has(rec.severity as string)) return false; // invalid enum voids
    if ("kind" in rec && !FINDING_KIND_SET.has(rec.kind as string)) return false; // invalid enum voids
    if ("owner" in rec && !FINDING_OWNER_SET.has(rec.owner as string)) return false; // invalid enum voids (#865)
    if ("path" in rec && (typeof rec.path !== "string" || rec.path.length === 0)) return false;
    if (seen.has(f.id)) return false; // duplicate finding id
    seen.add(f.id);
  }
  return true;
}

/** Fence classifiers exported to pin the subset invariant that makes ambiguity scanning safe. */
export function isStrictFenceDelimiter(line: string): boolean {
  return /^```[a-zA-Z0-9-]*$/.test(line);
}

export function isWiderFenceDelimiter(line: string): boolean {
  return /^(?:`{3,}|~{3,})[\s\S]*$/.test(line);
}

/**
 * Remove the narrow markdown-wrapper shape observed from haiku-tier engine-agent reviewers:
 * an opening fence immediately before the result sentinel and a bare closing fence as the last
 * non-whitespace line. The candidate opener must also be in opening orientation (an even number
 * of plain triple-backtick fence delimiters precede it) and the closing fence must be its direct
 * match (no intervening fence delimiters). Any ambiguous orientation fails closed by returning
 * the original text. Mixed fence types do not pair by simple parity: a tilde fence only closes
 * with tildes, while a longer backtick fence requires at least as many backticks to close.
 * Emulating CommonMark pairing here would be over-engineering, so any exotic fence in scope makes
 * orientation undecidable and refuses the strip. The observed benign haiku wrapper, which uses
 * plain triple-backtick fences throughout, is unaffected.
 * Classification uses a canonical view with all trailing whitespace removed. After
 * canonicalization, a strict line is exactly three backticks followed by tag characters; the
 * wider prefix `{3,}` covers that prefix and `[\s\S]*` covers any remainder. Therefore
 * `strict(canon) => wider(canon)` holds structurally: no whitespace or EOL variant can make a
 * line visible to the strict family but invisible to the ambiguity scan.
 *
 * This deliberately lives at the engine-agent boundary rather than in `parseStructuredBlock`,
 * the shared P1-reviewed containment primitive, so no other peripheral role inherits a wider
 * parser contract. Requiring the oriented symmetric pair cannot hide the truncation shape guarded
 * by the shared trailing-content rule: a truncated body leaves real content after the end
 * sentinel, never only a lone closing fence paired with the opening fence.
 */
function stripSymmetricFence(text: string): string {
  const lines = text.split("\n");
  const canonicalLines = lines.map((line) => line.replace(/\s+$/u, ""));
  let closingIndex = lines.length - 1;
  while (closingIndex >= 0 && canonicalLines[closingIndex]!.trim() === "") closingIndex -= 1;
  if (closingIndex < 0 || canonicalLines[closingIndex] !== "```") return text;

  let resultIndex = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (canonicalLines[i]!.trim() === RESULT_BLOCK_START) {
      resultIndex = i;
      break;
    }
  }
  const openingIndex = resultIndex - 1;
  if (openingIndex < 0 || !isStrictFenceDelimiter(canonicalLines[openingIndex]!)) return text;

  for (let i = 0; i < closingIndex; i += 1) {
    if (i === openingIndex) continue;
    const line = canonicalLines[i]!;
    if (isWiderFenceDelimiter(line) && !isStrictFenceDelimiter(line)) return text;
  }

  let precedingFenceCount = 0;
  for (let i = 0; i < openingIndex; i += 1) {
    if (isStrictFenceDelimiter(canonicalLines[i]!)) precedingFenceCount += 1;
  }
  if (precedingFenceCount % 2 !== 0) return text;

  for (let i = openingIndex + 1; i < closingIndex; i += 1) {
    if (isStrictFenceDelimiter(canonicalLines[i]!)) return text;
  }

  return lines.filter((_line, index) => index !== openingIndex && index !== closingIndex).join("\n");
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
 *  (same convention fix-response.ts's `reply` field uses), never a separate raw-markdown segment.
 *  `changedPaths` (#448) is threaded straight through to `validateAgentReviewOutput` — see that
 *  function's own doc for its fail-closed default when omitted. */
export function parseAgentReviewOutputText(
  text: string,
  manifest: readonly AcceptanceCriterion[],
  changedPaths?: ReadonlySet<string>,
): AgentReviewOutput | null {
  const block = parseStructuredBlock(stripSymmetricFence(text));
  if (!block) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(block.metadataRaw);
  } catch {
    return null;
  }
  return validateAgentReviewOutput(raw, manifest, changedPaths);
}

/** #448 (design #402 R1 §1): `deriveApprovalResult`'s return type widened, structurally, past
 *  `ApprovalResult` (`roles/reviewer.ts`, PROTECTED — never edited by this issue) — an ADDITIVE
 *  extension defined entirely in this UNPROTECTED module, never a patch to the protected type
 *  itself. `rejected.findings` becomes `ClassifiedFinding[]` (readable severity/kind/path/override
 *  bookkeeping without a cast) and `approved.evidence` gains an optional `advisories` array — "the
 *  advisories recorded in the approval evidence" (issue #448's AC). Every value this module
 *  produces is still structurally assignable to plain `ApprovalResult` (a `ClassifiedFinding` IS a
 *  `Finding` with optional extra keys, and `evidence.advisories` is optional) — engine-agent.ts's
 *  existing `result: ApprovalResult`-typed call site keeps compiling and behaving unchanged,
 *  un-narrowed callers simply don't see the richer fields. */
export type ClassifiedApprovalResult =
  | { kind: "approved"; headOid: string; evidence: ApprovalEvidence & { advisories?: ClassifiedFinding[] }; findings?: never }
  | { kind: "rejected"; headOid: string; findings: [ClassifiedFinding, ...ClassifiedFinding[]]; evidence?: never };

/**
 * Pure engine-side derivation (design #279 §1: "rejected is ENGINE-derived ... the session never
 * chooses outcomes") from an ALREADY-VALIDATED AgentReviewOutput into an ApprovalResult. Never
 * produces `pending`/`unavailable` — those are engine-agent.ts's own setup/retry-path outcomes,
 * entirely outside a validated output's reach; this function's whole domain is "given a session
 * that ran and produced a well-formed answer, what does gate② do with it."
 *
 * #448 (design #402 R1 §1) generalizes the ORIGINAL binary rule — "any findings entry ⇒ rejected"
 * — to its severity-aware form, byte-for-byte identical when no finding carries an axis (AC#3, the
 * fail-closed-default pin): every finding is first passed through `applySeverityOverride` (D3),
 * then split into `blocking`/`advisory` via `effectiveSeverity`.
 *
 *  - `blocking.length > 0` ⇒ `rejected`, `rejected.findings` = the blocking findings ONLY (an
 *    advisory finding never reaches `rejected.findings` — its home is `approved.evidence.advisories`
 *    below, on the OTHER branch; a rejected verdict is never reached with any findings still
 *    present that this same output also carries as advisory, since `blocking.length > 0` here
 *    means at least one genuinely blocking finding exists — the advisories are simply omitted from
 *    this branch's array, not lost: they're inert while the PR is rejected on other grounds, and
 *    the same session's next-round output re-derives them fresh).
 *  - `blocking.length === 0` AND any `cannot-confirm` perAC entry ⇒ `rejected` with ONE finding
 *    synthesized per such entry (unchanged mechanism from before #448 — the per-AC path stays
 *    INDEPENDENTLY blocking: no finding severity, however labeled, waives a `cannot-confirm`).
 *    Matches the ORIGINAL "when the session already supplied [blocking-shaped] findings, they're
 *    used verbatim, never padded with redundant per-AC restatements" contract, now gated on
 *    `blocking` rather than raw `findings` presence.
 *  - Otherwise ⇒ `approved`. Every `claim-accepted` id is recorded in
 *    `ApprovalEvidence.unreproducedClaims` (reviewer.ts's #286 extension); every ADVISORY finding
 *    (i.e. every finding present whose `effectiveSeverity` is `"advisory"`) is recorded in
 *    `evidence.advisories` (#448) — an explicit, auditable "recorded but not blocking" trail,
 *    never silently folded into an ordinary confirmed approval.
 */
export function deriveApprovalResult(output: AgentReviewOutput, headOid: string): ClassifiedApprovalResult {
  const cannotConfirm = output.perAC.filter((a) => a.status === "cannot-confirm");
  const claimAccepted = output.perAC.filter((a) => a.status === "claim-accepted");

  const gated = output.findings.map(applySeverityOverride);
  const blocking = gated.filter((f) => effectiveSeverity(f) === "blocking");
  const advisories = gated.filter((f) => effectiveSeverity(f) === "advisory");

  const findings: ClassifiedFinding[] =
    blocking.length > 0
      ? blocking
      : cannotConfirm.map((a) => ({
          id: `ac-${a.id}`,
          body: `Acceptance criterion ${a.id} could not be confirmed by the engine-agent review session.`,
        }));

  if (findings.length > 0) {
    return { kind: "rejected", headOid, findings: findings as [ClassifiedFinding, ...ClassifiedFinding[]] };
  }

  return {
    kind: "approved",
    headOid,
    evidence: {
      freshApprovingReviews: 0,
      freshTrustedSignals: 0,
      ...(claimAccepted.length > 0 ? { unreproducedClaims: claimAccepted.map((a) => a.id) } : {}),
      ...(advisories.length > 0 ? { advisories } : {}),
    },
  };
}

// Re-exported so a consumer that only needs the shape guard (e.g. a future prompt-contract test)
// doesn't need to reach back into reviewer.ts directly for it.
export { isFinding };
