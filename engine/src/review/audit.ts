// review/audit.ts (#288, E4c, design #279 §1/§8) — the engine-agent's non-authoritative,
// crash-safe audit-comment transport. Marker identity and receipt state are machine data; the
// Markdown body is human evidence only and is never consumed by reviewer.ts.

import type { IForge, PRTopLevelComment } from "../forge/forge.js";
import type { Finding } from "../roles/reviewer.js";
import type { PerAcResult } from "./agent-output.js";
import type { AuditDeliveryResult, EngineReviewWal } from "./drive.js";

export const AUDIT_MARKER_PREFIX = "<!-- sapwood-audit ";
const MARKER_RE = /^<!-- sapwood-audit kind=([a-z0-9-]+) head=([0-9a-f]+) diff=([0-9a-f]+) run=([A-Za-z0-9._:-]+) -->$/m;

export interface EngineReviewArtifact {
  perAC: PerAcResult[];
  findings: Finding[];
  sessionActualModels: string[];
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

/** Render a stable human record. The wording deliberately contains neither reviewer.ts's
 *  Codex-clean sentence nor its `Reviewed commit/head OID:` assertion format. */
export function buildAuditComment(wal: EngineReviewWal, artifact: EngineReviewArtifact): string {
  const outcome = wal.decisiveOutcome ?? "unknown";
  const acRows =
    artifact.perAC.length > 0 ? artifact.perAC.map((a) => `| ${escapeCell(a.id)} | ${a.status} |`).join("\n") : "| — | no AC entries |";
  const findings =
    artifact.findings.length > 0 ? artifact.findings.map((f) => `- **${escapeCell(f.id)}**: ${f.body}`).join("\n") : "- None recorded.";
  const models = artifact.sessionActualModels.length > 0 ? artifact.sessionActualModels.join(", ") : "unknown";
  return `${buildAuditMarker(markerForWal(wal))}

## Sapwood engine review audit

This is a non-authoritative evidence record, not a gate② approval or merge instruction.
Engine-derived review disposition recorded: **${outcome}**.

| Acceptance criterion | Evidence tier / status |
|---|---|
${acRows}

### Findings

${findings}

Provenance: reviewer model(s) \`${models}\`; prompt template sha256 \`${artifact.promptHash}\`; projection manifest sha256 \`${wal.treeManifestHash ?? "unavailable"}\`; reviewed object \`${wal.head}\`; diff sha256 \`${wal.diffHash}\`; run \`${wal.runId}\`.
`;
}

export function parseEngineReviewArtifact(json: string): EngineReviewArtifact | null {
  try {
    const v = JSON.parse(json) as Partial<EngineReviewArtifact>;
    if (!Array.isArray(v.perAC) || !Array.isArray(v.findings) || !Array.isArray(v.sessionActualModels) || typeof v.promptHash !== "string")
      return null;
    if (!v.perAC.every((a) => a && typeof a.id === "string" && ["confirmed", "cannot-confirm", "claim-accepted"].includes(a.status)))
      return null;
    if (!v.findings.every((f) => f && typeof f.id === "string" && typeof f.body === "string")) return null;
    if (!v.sessionActualModels.every((m) => typeof m === "string")) return null;
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
