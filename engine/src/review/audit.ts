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
function renderFindingsList(findings: readonly ClassifiedFinding[]): string {
  return findings.length > 0
    ? findings
        .map(
          (f) =>
            `- **${escapeCell(f.id)}**\n${f.body
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n")}`,
        )
        .join("\n")
    : "- None recorded.";
}

/** #513: the Provenance line's identity clause — "decisive reviewer identity" singular, plural
 *  when more than one. An empty array is defensive only: the post-session D5 check in
 *  engine-agent.ts already fails a verdict closed whenever the session's own identity list comes
 *  back empty, so a REAL persisted artifact always carries at least one. */
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
 *     at least the decisive attempt's own spend) — reachable only via a hand-written or corrupted
 *     WAL row that otherwise still passes `parseEngineReviewArtifact`'s array-shape check (an
 *     empty array is a valid, if never-produced-in-production, `ReviewSessionSpend[]`). Without
 *     this branch the fall-through below would render "provider-reported spend (0 attempts)
 *     $0.000000" — a positive measurement claim asserted from zero records, the exact failure
 *     class (#513) this whole rendering function exists to close.
 *   - every executed attempt `known`     -> a real, summed, provider-reported total.
 *   - any attempt `estimated` (none `unknown`) -> the SAME summed total, but labelled an estimate
 *     (token usage × pinned prices) — mixing in an estimated attempt makes the sum inexact too.
 *   - any attempt `unknown`              -> no total is claimable; report the recorded numeric
 *     subtotal (known + estimated attempts only) alongside how many attempts lacked telemetry,
 *     never silently treating "unknown" as "$0".
 *  `spends` is one entry per EXECUTED attempt, in order (`EngineReviewArtifact.sessionSpends`'s
 *  own doc) — never an aggregate computed elsewhere. */
function renderSpendClause(spends: readonly ReviewSessionSpend[]): string {
  if (spends.length === 0) return "logical-review spend `no attempt spend recorded`";
  const n = spends.length;
  const attempts = `${n} attempt${n === 1 ? "" : "s"}`;
  const numeric = (s: ReviewSessionSpend): number => (s.kind === "unknown" ? 0 : s.usd);
  const unknownCount = spends.filter((s) => s.kind === "unknown").length;
  if (unknownCount > 0) {
    const subtotal = spends.reduce((sum, s) => sum + numeric(s), 0);
    return `logical-review spend \`unknown total\`; recorded numeric subtotal \`$${subtotal.toFixed(6)}\` (${attempts}; ${unknownCount} lacked telemetry)`;
  }
  const total = spends.reduce((sum, s) => sum + numeric(s), 0);
  if (spends.some((s) => s.kind === "estimated")) {
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
  const blocking = artifact.findings.filter((f) => effectiveSeverity(f) !== "advisory");
  const advisory = artifact.findings.filter((f) => effectiveSeverity(f) === "advisory");
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
 *  required strings, exactly the same fail-closed posture `perAC`/`findings` already get below. */
function isValidIdentity(v: unknown): v is ReviewSessionIdentity {
  return (
    !!v &&
    typeof v === "object" &&
    typeof (v as { provider?: unknown }).provider === "string" &&
    typeof (v as { model?: unknown }).model === "string"
  );
}

/** #513: strict per-spend validation of the `ReviewSessionSpend` discriminated union — `known`/
 *  `estimated` require a numeric `usd`, `unknown` requires nothing else, any other `kind` (or a
 *  missing one) fails closed to `null` via the `.every()` call site below, exactly as a malformed
 *  `perAC`/`findings` entry already does. */
function isValidSpend(v: unknown): v is ReviewSessionSpend {
  if (!v || typeof v !== "object") return false;
  const s = v as { kind?: unknown; usd?: unknown };
  if (s.kind === "known" || s.kind === "estimated") return typeof s.usd === "number";
  return s.kind === "unknown";
}

/** #513 (amended ruling): NO legacy read path. An old `sessionActualModels`-shaped artifact (no
 *  `sessionSpends` at all) fails the `Array.isArray(v.sessionSpends)` check below and returns
 *  `null` — `deliverEngineReviewAudit` already reports its existing named reason ("WAL has no
 *  validated decisive review artifact") for a `null` parse, so this is a VALIDATION guarantee
 *  (fail closed on a stale/malformed artifact), not a compatibility one. */
export function parseEngineReviewArtifact(json: string): EngineReviewArtifact | null {
  try {
    const v = JSON.parse(json) as Partial<EngineReviewArtifact>;
    if (
      !Array.isArray(v.perAC) ||
      !Array.isArray(v.findings) ||
      !Array.isArray(v.sessionActualIdentities) ||
      !Array.isArray(v.sessionSpends) ||
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
