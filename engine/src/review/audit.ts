// review/audit.ts (#288, E4c, design #279 §1/§8) — the engine-agent's non-authoritative,
// crash-safe audit-comment transport. Marker identity and receipt state are machine data; the
// Markdown body is human evidence only and is never consumed by reviewer.ts.

import type { IForge, PRTopLevelComment } from "../forge/forge.js";
import type { PerAcResult } from "./agent-output.js";
import type { AuditDeliveryResult, EngineReviewWal } from "./drive.js";
import { type ClassifiedFinding, effectiveSeverity } from "./finding-axes.js";
import { formatIdentity, type ReviewSessionIdentity, type ReviewSessionSpend } from "./review-session.js";

export const AUDIT_MARKER_PREFIX = "<!-- sapwood-audit ";
const MARKER_RE = /^<!-- sapwood-audit kind=([a-z0-9-]+) head=([0-9a-f]+) diff=([0-9a-f]+) run=([A-Za-z0-9._:-]+) -->$/m;

export interface EngineReviewArtifact {
  perAC: PerAcResult[];
  /** #448 (design #402 R1): `ClassifiedFinding[]`, not bare `Finding[]` — a persisted finding may
   *  carry `severity`/`kind`/`path` (and the engine-recorded `severityOverridden`/`pathDropped`
   *  bookkeeping), which `buildAuditComment` below reads to split the rendering into the
   *  blocking/advisory sections. A finding carrying neither axis (every artifact persisted before
   *  #448) still round-trips and renders identically — `effectiveSeverity` defaults absent
   *  `severity` to `"blocking"`. */
  findings: ClassifiedFinding[];
  /** #513 (PM adjudication 2026-08-01 + amendment): REPLACES the old `sessionActualModels:
   *  string[]` outright — no legacy read path (see this repo's own amended ruling: the field is
   *  per-run WAL row state, not an archive, and the only real deployment has zero undelivered
   *  artifacts to strand). Scoped to the DECISIVE attempt ONLY — a failed attempt never passed the
   *  post-session D5 check, so its telemetry is not provenance (engine-agent.ts's `attempt()`). */
  sessionActualIdentities: ReviewSessionIdentity[];
  /** #513: one entry per EXECUTED attempt (not an aggregate), in order, discriminant carried
   *  verbatim — a summed value cannot express "attempt 1 known, attempt 2 unknown" without
   *  discarding evidence, and the logical-review cost cap is a whole-logical-review cap, so a
   *  failed attempt's spend belongs in the record too (engine-agent.ts's `evaluate()`). */
  sessionSpends: ReviewSessionSpend[];
  promptHash: string;
}

export interface AuditMarker {
  kind: "engine-agent";
  head: string;
  diff: string;
  runId: string;
}

export function buildAuditMarker(marker: AuditMarker): string {
  return `${AUDIT_MARKER_PREFIX}kind=${marker.kind} head=${marker.head} diff=${marker.diff} run=${marker.runId} -->`;
}

export function parseAuditMarker(body: string): AuditMarker | null {
  const m = MARKER_RE.exec(body);
  if (m?.[1] !== "engine-agent") return null;
  return { kind: "engine-agent", head: m[2]!, diff: m[3]!, runId: m[4]! };
}

export function markerForWal(wal: EngineReviewWal): AuditMarker {
  return { kind: "engine-agent", head: wal.head, diff: wal.diffHash, runId: wal.runId };
}

export function sameAuditMarker(a: AuditMarker, b: AuditMarker): boolean {
  return a.kind === b.kind && a.head === b.head && a.diff === b.diff && a.runId === b.runId;
}

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

/** Write-boundary sanitization, shared by BOTH the blocking and advisory sections below: never
 *  trust session prose. Blockquoting every body line structurally breaks reviewer.ts's ^ {0,3}
 *  line-start anchors in CLEAN_VERDICT_RE and REVIEWED_HEAD_OID_RE, so finding text — blocking OR
 *  advisory — can never become an approval-parseable engine comment (#448, design #402 §2: the
 *  Advisory section gets "the SAME blockquoted, write-boundary-sanitized rendering `audit.ts`
 *  already applies"). */
function renderFindingsList(entries: readonly IndexedFinding[]): string {
  return entries.length > 0
    ? entries
        .map(
          ({ index, finding }) =>
            `- **[${index}] ${escapeCell(finding.id)}**\n${finding.body
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n")}`,
        )
        .join("\n")
    : "- None recorded.";
}

/** #461: a finding paired with its position in `EngineReviewArtifact.findings` — the identity a
 *  fix leg names in its `findingResponses` block (`loop/fix-response.ts`) to dispute or accept
 *  ONE finding. The index is rendered in the audit comment (`[N]` above) because that comment is
 *  the ONLY channel a credential-free fix leg reads engine-agent findings through
 *  (`pr_audit_comments`), and it must be able to copy the handle verbatim the same way the
 *  classic path copies a `threadId`. It is the ARTIFACT's own index, deliberately NOT a position
 *  within the blocking/advisory section a finding happens to render under — the engine validates
 *  a response against that same array, so the two must be the same number. */
interface IndexedFinding {
  index: number;
  finding: ClassifiedFinding;
}

/** #513: the Provenance line's identity clause — "decisive reviewer identity" singular, plural
 *  when more than one. An empty array is defensive only: `evaluate()`'s post-session D5 check
 *  (engine-agent.ts) already fails a verdict closed whenever a session's own identity list comes
 *  back empty, AND `parseEngineReviewArtifact` (this file, #513 gate② round 2 P2-B) rejects an
 *  empty `sessionActualIdentities` outright — so this branch is reachable only from an
 *  `EngineReviewArtifact` built directly in-process (e.g. a test), never from anything that has
 *  round-tripped through the parser. */
function renderIdentityClause(identities: readonly ReviewSessionIdentity[]): string {
  const label = identities.length === 1 ? "decisive reviewer identity" : "decisive reviewer identities";
  const value = identities.length > 0 ? identities.map(formatIdentity).join(", ") : "unknown";
  return `${label} \`${value}\``;
}

/** #513: the Provenance line's spend clause — an estimate must never be able to read as a
 *  measurement, so the wording (not just the number) changes by discriminant:
 *   - EMPTY (no executed attempts recorded at all) -> no total is claimable, exactly the same
 *     "no data, no positive claim" stance `renderIdentityClause` above already takes on an empty
 *     identity list. `evaluate()` never produces this (every verdict-producing artifact records
 *     at least the decisive attempt's own spend), and `parseEngineReviewArtifact` (#513 gate②
 *     round 2 P2-B) rejects an empty `sessionSpends` outright — so, same as the identity clause,
 *     this branch is reachable only from an artifact built directly in-process, never from
 *     anything that has round-tripped through the parser. Without this branch the fall-through
 *     below would render "provider-reported spend (0 attempts) $0.000000" — a positive
 *     measurement claim asserted from zero records, the exact failure class (#513) this whole
 *     rendering function exists to close.
 *   - every executed attempt `known`     -> a real, summed, provider-reported total.
 *   - every executed attempt `estimated`, none `known`/`unknown` -> the SAME summed total,
 *     labelled an estimate derived from token usage × pinned prices.
 *   - a MIX of `known` and `estimated` (none `unknown`) -> the SAME summed total, still labelled
 *     an estimate (mixing in even one estimated attempt makes the sum inexact), but with a
 *     DIFFERENT parenthetical ("mixed provider-reported and pinned-price-estimated", #513 gate②
 *     round 3 P3-1) — the pure-estimated wording would otherwise claim the WHOLE figure was
 *     token-derived when part of it was genuinely provider-reported.
 *   - any attempt `unknown`, at least one OTHER attempt numeric -> no total is claimable; report
 *     the recorded numeric subtotal (known + estimated attempts only) alongside how many attempts
 *     lacked telemetry, never silently treating "unknown" as "$0". If that subtotal itself
 *     includes an `estimated` entry, the subtotal is labelled an estimate too (#513 gate② round 2
 *     P2-A) — otherwise an estimated dollar figure would launder into an unqualified "recorded
 *     numeric subtotal" the moment an unknown attempt joins it.
 *   - EVERY attempt `unknown` (zero numeric entries at all) -> no subtotal clause at all (#513
 *     gate② round 2 P2-A) — a "recorded numeric subtotal `$0.000000`" would itself be exactly the
 *     "unknown read as $0" failure this whole function exists to forbid, just wearing a subtotal
 *     label instead of a total one.
 *  `spends` is one entry per EXECUTED attempt, in order (`EngineReviewArtifact.sessionSpends`'s
 *  own doc) — never an aggregate computed elsewhere. */
function renderSpendClause(spends: readonly ReviewSessionSpend[]): string {
  if (spends.length === 0) return "logical-review spend `no attempt spend recorded`";
  const n = spends.length;
  const attempts = `${n} attempt${n === 1 ? "" : "s"}`;
  const isNumeric = (s: ReviewSessionSpend): s is Extract<ReviewSessionSpend, { usd: number }> => s.kind !== "unknown";
  const unknownCount = spends.length - spends.filter(isNumeric).length;
  if (unknownCount > 0) {
    const numericSpends = spends.filter(isNumeric);
    if (numericSpends.length === 0) {
      return `logical-review spend \`unknown total\`; no numeric spend recorded (${attempts}; ${unknownCount} lacked telemetry)`;
    }
    const subtotal = numericSpends.reduce((sum, s) => sum + s.usd, 0);
    const subtotalLabel = numericSpends.some((s) => s.kind === "estimated")
      ? "recorded numeric subtotal estimate"
      : "recorded numeric subtotal";
    return `logical-review spend \`unknown total\`; ${subtotalLabel} \`$${subtotal.toFixed(6)}\` (${attempts}; ${unknownCount} lacked telemetry)`;
  }
  const total = spends.reduce((sum, s) => sum + (s.kind === "unknown" ? 0 : s.usd), 0);
  const hasKnown = spends.some((s) => s.kind === "known");
  const hasEstimated = spends.some((s) => s.kind === "estimated");
  if (hasEstimated && hasKnown) {
    return `logical-review spend estimate (mixed provider-reported and pinned-price-estimated; ${attempts}) \`$${total.toFixed(6)}\``;
  }
  if (hasEstimated) {
    return `logical-review spend estimate (token usage × pinned prices; ${attempts}) \`$${total.toFixed(6)}\``;
  }
  return `logical-review provider-reported spend (${attempts}) \`$${total.toFixed(6)}\``;
}

/** Render a stable human record. The wording deliberately contains neither reviewer.ts's
 *  Codex-clean sentence nor its `Reviewed commit/head OID:` assertion format. */
export function buildAuditComment(wal: EngineReviewWal, artifact: EngineReviewArtifact): string {
  const outcome = wal.decisiveOutcome ?? "unknown";
  const acRows =
    artifact.perAC.length > 0 ? artifact.perAC.map((a) => `| ${escapeCell(a.id)} | ${a.status} |`).join("\n") : "| — | no AC entries |";
  // #448 (design #402 §1/§2): split by EFFECTIVE severity (D2's fail-closed default — a finding
  // carrying neither axis is "blocking", so every pre-#448 artifact renders under "### Findings"
  // exactly as it always has) rather than the raw `severity` field, so a D3-overridden finding
  // (severity requested "advisory" but forced back to "blocking") renders under the BLOCKING
  // heading — the heading a reader must act on, never the one a session tried to file it under.
  const indexed: IndexedFinding[] = artifact.findings.map((finding, index) => ({ index, finding }));
  const blocking = indexed.filter((e) => effectiveSeverity(e.finding) !== "advisory");
  const advisory = indexed.filter((e) => effectiveSeverity(e.finding) === "advisory");
  return `${buildAuditMarker(markerForWal(wal))}

## Sapwood engine review audit

This is a non-authoritative evidence record, not a gate② approval or merge instruction.
Engine-derived review disposition recorded: **${outcome}**.

| Acceptance criterion | Evidence tier / status |
|---|---|
${acRows}

### Findings

${renderFindingsList(blocking)}

### Advisory (non-blocking)

${renderFindingsList(advisory)}

Provenance: ${renderIdentityClause(artifact.sessionActualIdentities)}; ${renderSpendClause(artifact.sessionSpends)}; prompt template sha256 \`${artifact.promptHash}\`; projection manifest sha256 \`${wal.treeManifestHash ?? "unavailable"}\`; reviewed object \`${wal.head}\`; diff sha256 \`${wal.diffHash}\`; run \`${wal.runId}\`.
`;
}

/** #513: strict per-identity validation — both fields of the `(provider, model)` pair are
 *  required NON-EMPTY strings, exactly the same fail-closed posture `perAC`/`findings` already
 *  get below. Empty-string acceptance was gate② round 2's P2-B finding: an empty `provider`/
 *  `model` is not a fact any real session telemetry produces (D5 empty-array handling maps "no
 *  identity" to a MISSING array entry, never a present-but-blank one), so accepting it here would
 *  let a corrupted row assert a hollow identity as if it were real. */
function isValidIdentity(v: unknown): v is ReviewSessionIdentity {
  if (!v || typeof v !== "object") return false;
  const id = v as { provider?: unknown; model?: unknown };
  return typeof id.provider === "string" && id.provider.length > 0 && typeof id.model === "string" && id.model.length > 0;
}

/** #513: strict per-spend validation of the `ReviewSessionSpend` discriminated union — `known`/
 *  `estimated` require a FINITE, NON-NEGATIVE numeric `usd` (gate② round 2 P2-B: bare
 *  `typeof usd === "number"` let `JSON.parse('{"usd":1e999}')`'s `Infinity` and negative figures
 *  through, both of which render as nonsense dollar amounts — `$Infinity`, or a spend below zero),
 *  `unknown` requires nothing else, any other `kind` (or a missing one) fails closed to `null` via
 *  the `.every()` call site below, exactly as a malformed `perAC`/`findings` entry already does. */
function isValidSpend(v: unknown): v is ReviewSessionSpend {
  if (!v || typeof v !== "object") return false;
  const s = v as { kind?: unknown; usd?: unknown };
  if (s.kind === "known" || s.kind === "estimated") return typeof s.usd === "number" && Number.isFinite(s.usd) && s.usd >= 0;
  return s.kind === "unknown";
}

/** #513 (amended ruling): NO legacy read path. An old `sessionActualModels`-shaped artifact (no
 *  `sessionSpends` at all) fails the `Array.isArray(v.sessionSpends)` check below and returns
 *  `null` — `deliverEngineReviewAudit` already reports its existing named reason ("WAL has no
 *  validated decisive review artifact") for a `null` parse, so this is a VALIDATION guarantee
 *  (fail closed on a stale/malformed artifact), not a compatibility one.
 *
 *  #513 gate② round 2 (P2-B): `sessionActualIdentities`/`sessionSpends` must be NON-EMPTY, not
 *  merely present arrays — `evaluate()` always produces at least one identity and one spend for a
 *  verdict-producing artifact (D5's post-session check already fails a verdict closed on an empty
 *  identity list; `attempt()` always folds the decisive attempt's own spend into `sessionSpends`),
 *  so a non-empty requirement states the real contract rather than tightening an arbitrary one.
 *  This is also the root cause the round 2 P2 traced its own defensive empty-array rendering
 *  branches to: with this check in place, `renderIdentityClause`/`renderSpendClause`'s own
 *  empty-array handling can only ever be reached by an artifact built directly in-process (never
 *  by anything that has round-tripped through this parser), belt-and-braces rather than the only
 *  thing standing between a corrupted WAL row and a false claim. `perAC`/`findings` stay
 *  LEGITIMATELY empty-able (a snapshot with no AC entries, an approved verdict with zero
 *  findings) — this tightening applies only to the two new #513 fields. */
export function parseEngineReviewArtifact(json: string): EngineReviewArtifact | null {
  try {
    const v = JSON.parse(json) as Partial<EngineReviewArtifact>;
    if (
      !Array.isArray(v.perAC) ||
      !Array.isArray(v.findings) ||
      !Array.isArray(v.sessionActualIdentities) ||
      v.sessionActualIdentities.length === 0 ||
      !Array.isArray(v.sessionSpends) ||
      v.sessionSpends.length === 0 ||
      typeof v.promptHash !== "string"
    )
      return null;
    if (!v.perAC.every((a) => a && typeof a.id === "string" && ["confirmed", "cannot-confirm", "claim-accepted"].includes(a.status)))
      return null;
    if (!v.findings.every((f) => f && typeof f.id === "string" && typeof f.body === "string")) return null;
    if (!v.sessionActualIdentities.every(isValidIdentity)) return null;
    if (!v.sessionSpends.every(isValidSpend)) return null;
    return v as EngineReviewArtifact;
  } catch {
    return null;
  }
}

export interface AuditDeliveryDeps {
  forge: Pick<IForge, "getPRComments" | "addPRComment">;
  pr: number;
  wal: EngineReviewWal;
  commentsCap: number;
  now: () => Date;
  recordReceipt: (runId: string, commentId: string, deliveredAt: string) => boolean;
}

function discover(comments: readonly PRTopLevelComment[], expected: AuditMarker): PRTopLevelComment | null {
  return (
    comments.find((c) => {
      const parsed = parseAuditMarker(c.body);
      return parsed !== null && sameAuditMarker(parsed, expected);
    }) ?? null
  );
}

/** Discover-before-post, then discover-after-post to obtain GitHub's comment id. A crash after
 *  the post but before the receipt is reconciled by the first discovery on the next tick. */
export async function deliverEngineReviewAudit(deps: AuditDeliveryDeps): Promise<AuditDeliveryResult> {
  const artifact = deps.wal.reviewArtifactJson ? parseEngineReviewArtifact(deps.wal.reviewArtifactJson) : null;
  if (!artifact || deps.wal.decisiveOutcome == null) return { delivered: false, reason: "WAL has no validated decisive review artifact" };
  if (deps.wal.auditCommentId) return { delivered: true };
  const expected = markerForWal(deps.wal);
  const receipt = (comment: PRTopLevelComment): AuditDeliveryResult => {
    if (!comment.id) return { delivered: false, reason: "discovered audit comment has no GitHub node id" };
    try {
      return deps.recordReceipt(deps.wal.runId, comment.id, deps.now().toISOString())
        ? { delivered: true }
        : { delivered: false, reason: "runId-guarded audit receipt write did not update the current WAL row" };
    } catch (e) {
      return { delivered: false, reason: `audit receipt write failed: ${String(e)}` };
    }
  };
  try {
    const before = await deps.forge.getPRComments(deps.pr, deps.commentsCap);
    const existing = discover(before.comments, expected);
    if (existing) return receipt(existing);
    await deps.forge.addPRComment(deps.pr, buildAuditComment(deps.wal, artifact));
    const after = await deps.forge.getPRComments(deps.pr, deps.commentsCap);
    const posted = discover(after.comments, expected);
    return posted ? receipt(posted) : { delivered: false, reason: "audit post returned but marker was not discoverable for receipt" };
  } catch (e) {
    return { delivered: false, reason: `audit comment delivery failed: ${String(e)}` };
  }
}
