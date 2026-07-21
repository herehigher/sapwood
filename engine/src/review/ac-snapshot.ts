// ac-snapshot.ts (#283, design #279 §5, owner ruling D4) — the AC-authority dispatch snapshot.
//
// Design #279 §5's problem statement: per-AC verdicts need an authoritative, immutable AC set,
// but producers hold `gh issue edit` capability (worker.ts's grant) — the live issue body is
// therefore NOT authoritative once a worker has been dispatched against it. This module is the
// engine-side fix: BEFORE a worker ever spawns, conductor.ts's DISPATCH loop calls
// `buildAcSnapshot` on the exact issue body `getReadyIssues` just fetched and persists the
// result via `State.recordAcSnapshot` — same fail-closed unit as the claim/dispatch attempt
// itself (a snapshot-write failure throws and rolls the board back to Ready exactly like a
// dispatch() failure would, so a lane can never run against an unrecorded AC set). Later, before
// conductor.ts's DRIVE loop ever hands a driving lane to `gate.driveOne`, it re-fetches the
// LIVE issue body and calls `checkAcSnapshotDrift`: ANY full-body hash drift (not just the AC
// section — every reviewer input in the body, per design #279 §5's R3 widening) fails closed —
// the lane is escalated to `needsHuman` with a drift-explaining comment, and `driveOne` is never
// called that tick. There is no re-extraction path: a body edit after dispatch can never
// silently re-author the acceptance criteria a worker is being judged against.
//
// Pure module — no forge/state I/O of its own (state.ts owns persistence, conductor.ts owns the
// forge calls); everything here is a plain function over strings, easily corpus-tested.
import { createHash } from "node:crypto";
import { type AcceptanceCriterion, extractAcceptanceCriteria } from "../forge/forge.js";

export type { AcceptanceCriterion };

/** sha256 hex of the FULL issue body — deliberately the whole body, not just the AC section
 *  (design #279 §5, R3: "widened from AC-section-only" — a verification-plan edit or any other
 *  reviewer-relevant prose change must also count as drift, not just an AC-line edit). */
export function hashBody(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** The persisted AC-authority manifest for one dispatch attempt. `body` is the FULL snapshotted
 *  text — review sessions read THIS, never a live re-fetch (design #279 §5's "review sessions
 *  receive the SNAPSHOTTED body" requirement) — `bodyHash` is `hashBody(body)`, kept alongside
 *  rather than re-derived on every read so a caller never needs the (slightly) more expensive
 *  hash just to check `snapshottedAt`/`manifest`. `manifest` is `extractAcceptanceCriteria(body)
 *  ?? []` — an EMPTY array (never null) for a `verify:n/a` issue with no checkbox AC section;
 *  `isDispatchable` (forge.ts) is what refuses to dispatch a non-`verifyNa` issue with a
 *  malformed/empty AC set in the first place, so by the time a snapshot is taken for such an
 *  issue, an empty manifest here is either a legitimate doc-gate issue or a caller (e.g. a test)
 *  that bypassed that gate deliberately — this module never re-enforces dispatchability, only
 *  records what it's given. */
export interface AcSnapshot {
  issue: number;
  bodyHash: string;
  body: string;
  manifest: AcceptanceCriterion[];
  snapshottedAt: string;
}

/** Build the snapshot from the SAME body text the dispatch decision was made against (conductor.ts
 *  passes `issue.body` straight through — never a fresh live read at snapshot time; the whole
 *  point is one authoritative read, not two that could disagree). Never throws: an issue with no
 *  AC section (a `verify:n/a` issue, or a caller that bypassed `isDispatchable`) simply gets an
 *  empty `manifest`, same as `extractAcceptanceCriteria`'s own null-to-callers-decide contract. */
export function buildAcSnapshot(issue: number, body: string, at: string): AcSnapshot {
  return {
    issue,
    bodyHash: hashBody(body),
    body,
    manifest: extractAcceptanceCriteria(body) ?? [],
    snapshottedAt: at,
  };
}

/** Review-time drift check (design #279 §5): `ok: true` carries the SNAPSHOTTED body/manifest —
 *  by construction, never the `liveBody` argument — so a caller literally cannot leak a live
 *  re-fetch into a review session even by accident; the only way to ever see live text is via a
 *  DIFFERENT, explicit call the caller makes itself. `ok: false` means the full body hash no
 *  longer matches what was recorded at dispatch time — ANY drift, not just inside the AC
 *  section (R3's widening) — and carries a human-readable reason string for the drift-explaining
 *  comment conductor.ts posts; the caller (conductor.ts's DRIVE loop) treats this as "route to
 *  needsHuman, never call driveOne this tick, never silently re-extract." */
export type AcDriftResult = { ok: true; body: string; manifest: AcceptanceCriterion[] } | { ok: false; reason: string };

export function checkAcSnapshotDrift(liveBody: string, snapshot: AcSnapshot): AcDriftResult {
  const liveHash = hashBody(liveBody);
  if (liveHash === snapshot.bodyHash) {
    return { ok: true, body: snapshot.body, manifest: snapshot.manifest };
  }
  return {
    ok: false,
    reason: `issue body changed since its dispatch-time AC snapshot (snapshotted ${snapshot.bodyHash.slice(0, 12)}, live ${liveHash.slice(0, 12)})`,
  };
}
