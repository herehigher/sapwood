// review/drive.ts (#287, E4b, design #279 §2) — drive ordering for the engine-agent reviewer
// kind: attempt pins (decisive/unavailable), preflight (before any paid session), identity
// resolution + WAL, and the post-session refetch. Composed into merge-driver.ts's
// MergeDriver.driveOne (see that module's driveEngineAgentOne) as a SEPARATE code path, gated on
// `reviewer.kind === "engine-agent"` — the three existing Reviewer kinds' behavior in driveOne is
// completely untouched by this module (mechanical extract + additive branch, see merge-driver.ts's
// own doc for the regression-pin stance).
//
// PRODUCTION REACHABILITY (read before assuming this runs anywhere real): engine-agent has NO
// production construction path as of this PR. `reviewer.ts`'s `buildReviewerByKind("engine-agent")`
// still THROWS (updated only to name #288/E4c as the enablement point) — so `makeReviewer(cfg)`
// with `reviewer.mode: engine-agent` still throws at engine startup, and conductor.ts's real
// wiring never constructs an `EngineAgentReviewer` to hand to `MergeDriverDeps.reviewer`. Every
// behavior this module implements is proven ONLY via scripted-timeline tests that construct a
// `MergeDriver` directly with an injected `EngineAgentReviewer`-shaped adapter + an injected
// `auditDelivery` seam (see merge-driver.test.ts's engine-agent suite) — never through the real
// config -> conductor -> driveOne path. This is deliberate, not an oversight: shipping a drive
// path where a decisive verdict could reach merge/FIXABLE without a receipted audit comment would
// violate E4c's ordering invariant (audit comment + delivery receipt land in #288). Independent of
// that startup-time block, THIS module's own composition below fails closed a SECOND way: the
// production `auditDelivery` seam (constructed by whatever future caller eventually wires this up)
// is expected to always report `{ delivered: false }` until #288 replaces it with a real
// implementation — see `driveEngineAgentReview`'s own doc on the audit step for why a
// non-delivered decisive verdict can never reach `finalizeVerdict`.
//
// TREE-MANIFEST-HASH SEAM (documented scope note, design #279 §3's "tree manifest ... recorded in
// the WAL record"): `ReviewerAdapter.evaluate()` (the generic interface this module drives against)
// materializes internally and does not expose the resulting manifest — narrowing that seam would
// mean widening `ReviewerAdapter` itself (a shared interface every reviewer kind implements) just
// for one kind's WAL bookkeeping. Instead, `EngineAgentDriveDeps.onTreeManifest` is an OPTIONAL
// side-channel: the code that constructs BOTH this module's deps AND the `EngineAgentReviewer`'s
// own `materialize` closure (EngineAgentReviewerDeps.materialize, per that module's own "caller-
// bound" doc) is expected to wire the same closure to also report the manifest hash here — see
// merge-driver.test.ts for the wiring shape this expects. Until wired, `treeManifestHash` on the
// WAL record simply stays `null` (honest: "not observed by this composition," never fabricated).

import { createHash } from "node:crypto";
import type { SapwoodConfig } from "../config/config.js";
import type { IForge, PRReviewData, PRStatus } from "../forge/forge.js";
import { labelsIncludeAny, labelsIncludeAnySubstring } from "../forge/labels.js";
import type { ApprovalResult, ReviewerAdapter } from "../roles/reviewer.js";
import { changesRequestedOnHead, deriveBlockingSignal } from "../roles/reviewer.js";
import { requiredChecksSatisfied } from "./ci-evidence.js";

/** The per-head engine-agent ATTEMPT PIN (design #279 §2 R3) — see state.ts's schema v24->v25
 *  migration comment for the storage shape this mirrors exactly (4 fields, same as the design
 *  doc's own sketch). */
export interface AttemptPin {
  head: string;
  at: string;
  runId: string;
  kind: "decisive" | "unavailable";
}

/** The WAL record persisted BEFORE a review session spawns (design #279 §2/§8). */
export interface EngineReviewWal {
  runId: string;
  head: string;
  base: string;
  diffHash: string;
  treeManifestHash: string | null;
  attemptStart: string;
  decisiveOutcome: "approved" | "rejected" | null;
}

export type PreflightResult = { ok: true } | { ok: false; reason: string };

/**
 * design #279 §2's preflight gate, EVERY check before any paid session — checked in order (a
 * caller only needs the FIRST failure reason; each is individually unit-tested in isolation).
 * Deliberately does NOT check CI evidence (that's async — requiredChecksSatisfied, called
 * separately by the caller with a fetched `getPRChecks` page) so this stays a pure, sync function.
 */
export function checkPreflight(input: {
  status: PRStatus;
  data: PRReviewData;
  humanLabels: readonly string[];
  holdLabels: readonly string[];
}): PreflightResult {
  if (input.data.state !== "OPEN") return { ok: false, reason: `pr-not-open:${input.data.state}` };
  if (input.data.isDraft) return { ok: false, reason: "pr-is-draft" };
  if (labelsIncludeAnySubstring(input.data.labels, input.humanLabels)) return { ok: false, reason: "human-label-present" };
  if (labelsIncludeAny(input.data.labels, input.holdLabels)) return { ok: false, reason: "hold-label-present" };
  if (input.status.mergeable !== "MERGEABLE") return { ok: false, reason: `not-mergeable:${input.status.mergeable}` };
  if (input.data.unresolvedThreads > 0) return { ok: false, reason: "unresolved-threads" };
  if (changesRequestedOnHead(input.data.reviews, input.data.headOid, input.data.author)) return { ok: false, reason: "changes-requested" };
  return { ok: true };
}

/** sha256 hex of the raw diff text — the "D" of design #279 §2's H/B/D identity triple. */
export function hashDiff(diffText: string): string {
  return createHash("sha256").update(diffText).digest("hex");
}

export type IdentityResult = { kind: "resolved"; H: string; B: string; D: string } | { kind: "queue"; reason: string };

/**
 * design #279 §2 R2-6: resolve H (head) + B (base) + D (diff hash), then REFETCH status and
 * require head==H ∧ base==B; one mismatch restarts resolution ONCE (using the fresh values from
 * the mismatched refetch), a second mismatch queues this tick. Never throws — a forge failure at
 * any step queues (same never-throws contract as merge-driver.ts's own forge reads).
 */
export async function resolveIdentity(
  forge: Pick<IForge, "getPRDiff" | "getPRStatus">,
  pr: number,
  status0: PRStatus,
): Promise<IdentityResult> {
  let H = status0.headOid;
  let B = status0.baseOid ?? null;
  for (let round = 0; round < 2; round++) {
    if (B == null) return { kind: "queue", reason: "engine-agent: PRStatus.baseOid missing — cannot resolve identity" };
    let diffText: string;
    try {
      diffText = await forge.getPRDiff(pr);
    } catch (e) {
      return { kind: "queue", reason: `engine-agent: diff fetch failed: ${String(e)}` };
    }
    const D = hashDiff(diffText);
    let refetched: PRStatus;
    try {
      refetched = await forge.getPRStatus(pr);
    } catch (e) {
      return { kind: "queue", reason: `engine-agent: identity refetch failed: ${String(e)}` };
    }
    if (refetched.headOid === H && (refetched.baseOid ?? null) === B) {
      return { kind: "resolved", H, B, D };
    }
    if (round === 1) return { kind: "queue", reason: "engine-agent: identity mismatch persisted after one restart" };
    H = refetched.headOid;
    B = refetched.baseOid ?? null;
  }
  /* c8 ignore next */
  return { kind: "queue", reason: "engine-agent: identity resolution failed" }; // unreachable, loop always returns above
}

/** Whether a refetched status/data pair still matches the identity (H,B) a decisive verdict was
 *  produced against, with nothing newly blocking and CI still green — design #279 §2's
 *  post-session refetch gate, reused identically by the decisive-pin cheap-consume path. */
export function refetchStillValid(
  status: PRStatus,
  data: PRReviewData,
  H: string,
  B: string,
): { ok: true } | { ok: false; reason: string } {
  if (status.headOid !== H) return { ok: false, reason: `head-moved:${status.headOid}` };
  if ((status.baseOid ?? null) !== B) return { ok: false, reason: `base-moved:${status.baseOid ?? "unknown"}` };
  if (deriveBlockingSignal(data).blocked) return { ok: false, reason: "newly-blocking" };
  if (!status.ciGreen) return { ok: false, reason: "ci-no-longer-green" };
  return { ok: true };
}

/** `resolveReviewVerdict`-shaped synthetic action, so the caller (merge-driver.ts's
 *  driveEngineAgentOne) can hand an engine-agent decisive result to the EXACT SAME
 *  `finalizeVerdict` helper the classic Reviewer path already uses (deriveGate + mergeDecision +
 *  the merge call) — zero duplicated gate/merge logic. */
export function syntheticVerdictAction(kind: "approved" | "rejected"): "MERGE_OK" | "HANDLE_THREADS" {
  return kind === "approved" ? "MERGE_OK" : "HANDLE_THREADS";
}

export type AuditDeliveryResult = { delivered: true } | { delivered: false; reason: string };

/** The engine-agent drive composition's injected dependencies — one bound instance per lane
 *  (worker `name`), mirroring the recordTrigger/recordFallback callback-injection pattern
 *  merge-driver.ts's driveOne already uses for the classic Reviewer path. */
export interface EngineAgentDriveDeps {
  forge: IForge;
  reviewerAdapter: Pick<ReviewerAdapter, "evaluate">;
  cfg: SapwoodConfig;
  now: () => Date;
  newRunId: () => string;
  getAttemptPin: () => AttemptPin | null;
  recordAttemptPin: (pin: AttemptPin | null) => void;
  getWal: () => EngineReviewWal | null;
  recordWal: (wal: { runId: string; head: string; base: string; diffHash: string; attemptStart: string }) => void;
  recordWalDecisiveOutcome: (runId: string, outcome: "approved" | "rejected") => void;
  /** design #279 §3/§8: report the materializer's tree-manifest hash once known — see this
   *  module's own header doc for why this is an optional side-channel rather than a
   *  `ReviewerAdapter.evaluate()` return value. NOT invoked by `driveEngineAgentReview` itself —
   *  it exists so the code that constructs BOTH these deps AND the `EngineAgentReviewer`'s own
   *  `materialize` closure can wire the two together (the materialize closure fires this the
   *  instant it observes a successful `MaterializeResult`, which happens-before the review
   *  session spawns, since `evaluate()` always materializes before invoking the runner). The
   *  handler is expected to resolve the CURRENT run via `getWal()` (no concurrent attempts share
   *  a lane) and call `updateEngineReviewWalManifestHash` — see merge-driver.test.ts's wiring. */
  onTreeManifest?: (manifestHash: string) => void;
  /** E4c's (#288) audit-comment + delivery-receipt seam — see this module's header doc. In
   *  production this is expected to ALWAYS resolve `{ delivered: false }` until #288 replaces it;
   *  tests inject a fake that can succeed, to prove the downstream consume path. */
  auditDelivery: (result: Extract<ApprovalResult, { kind: "approved" | "rejected" }>) => Promise<AuditDeliveryResult>;
  ciChecksCap: number;
}

export type EngineAgentDriveOutcome =
  | { kind: "queued"; reason: string }
  | { kind: "consume"; status: PRStatus; data: PRReviewData; verdict: { action: "MERGE_OK" | "HANDLE_THREADS"; headOid: string } };

/**
 * The full engine-agent drive-ordering pipeline (design #279 §2), EXCLUDING the final
 * deriveGate/mergeDecision/merge-call step — that step is `finalizeVerdict` (merge-driver.ts),
 * shared byte-for-byte with the classic Reviewer path. Returns `{kind:"consume", ...}` when (and
 * only when) a decisive, delivered, refetch-validated verdict is ready to hand to
 * `finalizeVerdict`; every other path returns `{kind:"queued"}` — this function NEVER calls
 * `forge.mergePR` or dispatches a fix leg itself.
 *
 * Ordering (design #279 §2, exact): attempt-gate (pin) -> preflight -> identity -> WAL -> session
 * (evaluate) -> audit -> refetch -> consume. See inline comments for where each step lives.
 */
export async function driveEngineAgentReview(deps: EngineAgentDriveDeps, pr: number, issue: number): Promise<EngineAgentDriveOutcome> {
  const now = deps.now();

  let status0: PRStatus;
  try {
    status0 = await deps.forge.getPRStatus(pr);
  } catch (e) {
    return { kind: "queued", reason: `engine-agent: gate-data-unavailable: ${String(e)}` };
  }

  // ── attempt-gate: the per-head pin (design #279 §2 R3) ──────────────────────────────────────
  let pin = deps.getAttemptPin();
  if (pin && pin.head !== status0.headOid) {
    // Head change clears the pin — same lifecycle as the classic review-trigger pin.
    deps.recordAttemptPin(null);
    pin = null;
  }
  if (pin?.kind === "decisive") {
    // PERMANENT for this head: never re-run a session. Still attempt to CONSUME the already-
    // decisive, already-delivered verdict on every tick (cheap — no paid session) — a transient
    // merge failure or a refetch-race discard on an earlier tick must not permanently strand the
    // lane once the race resolves (design #279 §2: "a transient merge failure clears nothing").
    const wal = deps.getWal();
    if (!wal || wal.runId !== pin.runId || wal.head !== status0.headOid || wal.decisiveOutcome == null) {
      return { kind: "queued", reason: "engine-agent: decisive pin has no matching delivered WAL record — anomaly, fail-closed" };
    }
    let data0: PRReviewData;
    try {
      data0 = await deps.forge.getPRReviewData(pr);
    } catch (e) {
      return { kind: "queued", reason: `engine-agent: gate-data-unavailable: ${String(e)}` };
    }
    const revalidate = refetchStillValid(status0, data0, wal.head, wal.base);
    if (!revalidate.ok) {
      return { kind: "queued", reason: `engine-agent: decisive-pin consume attempt discarded this tick — ${revalidate.reason}` };
    }
    return {
      kind: "consume",
      status: status0,
      data: data0,
      verdict: { action: syntheticVerdictAction(wal.decisiveOutcome), headOid: wal.head },
    };
  }
  if (pin?.kind === "unavailable") {
    const retryAfterSec = deps.cfg.reviewer.agent?.retryAfterSec ?? 900;
    const elapsedSec = (now.getTime() - Date.parse(pin.at)) / 1000;
    if (elapsedSec < retryAfterSec) {
      return { kind: "queued", reason: `engine-agent: backoff — ${Math.ceil(retryAfterSec - elapsedSec)}s remaining` };
    }
    // Backoff expired: this IS the primary-recovery probe — proceed to preflight below.
  }

  // ── preflight (design #279 §2): every gate BEFORE any paid session ─────────────────────────
  let data0: PRReviewData;
  try {
    data0 = await deps.forge.getPRReviewData(pr);
  } catch (e) {
    return { kind: "queued", reason: `engine-agent: gate-data-unavailable: ${String(e)}` };
  }
  const preflight = checkPreflight({
    status: status0,
    data: data0,
    humanLabels: deps.cfg.escalation.humanLabels,
    holdLabels: deps.cfg.escalation.holdLabels,
  });
  if (!preflight.ok) return { kind: "queued", reason: `engine-agent: preflight failed: ${preflight.reason}` };

  let checksPage: { checks: import("../forge/forge.js").PRCheckItem[] };
  try {
    checksPage = await deps.forge.getPRChecks(pr, deps.ciChecksCap);
  } catch (e) {
    return { kind: "queued", reason: `engine-agent: preflight CI-checks fetch failed: ${String(e)}` };
  }
  const ciEvidence = requiredChecksSatisfied(checksPage.checks, deps.cfg.ci.requiredChecks);
  if (!ciEvidence.ok) {
    return { kind: "queued", reason: `engine-agent: preflight CI-evidence not satisfied: ${ciEvidence.unsatisfied.join(", ")}` };
  }

  // ── identity resolution (design #279 §2 R2-6) ───────────────────────────────────────────────
  const identity = await resolveIdentity(deps.forge, pr, status0);
  if (identity.kind === "queue") return { kind: "queued", reason: identity.reason };
  const { H, B, D } = identity;

  // ── WAL persist, BEFORE spawning ────────────────────────────────────────────────────────────
  const runId = deps.newRunId();
  const attemptStart = now.toISOString();
  deps.recordWal({ runId, head: H, base: B, diffHash: D, attemptStart });

  // Provisional pin write (unavailable) BEFORE the session runs — cost containment: if the
  // engine crashes/is killed mid-session, the next tick sees an unavailable pin (backoff), never
  // an unpinned head that would re-attempt immediately. Upgraded to 'decisive' below only on a
  // delivered decisive verdict.
  deps.recordAttemptPin({ head: H, at: attemptStart, runId, kind: "unavailable" });

  // ── session + validate (delegated to the injected ReviewerAdapter, E4a's own responsibility) ─
  const approvalResult = await deps.reviewerAdapter.evaluate({ forge: deps.forge, pr, issue, data: data0 });

  if (approvalResult.kind === "unavailable" || approvalResult.kind === "pending") {
    // Pin already recorded 'unavailable' above (same runId/at) — nothing further to persist.
    // 'pending' is defensively routed here too: EngineAgentReviewer.evaluate() never actually
    // produces it (E4a's own implementation only ever returns approved/rejected/unavailable),
    // but a generic ReviewerAdapter could — never silently skip the pin/backoff for an
    // actionable, non-decisive result.
    const reason = approvalResult.kind === "unavailable" ? approvalResult.reason : "pending (no decisive artifact yet)";
    return { kind: "queued", reason: `engine-agent: ${reason}` };
  }

  // ── audit: discover-before-post, record delivery (E4c/#288's own implementation) ───────────
  // approved | rejected: a decisive verdict, but NOT YET consumable — see this module's header
  // doc. `auditDelivery` not delivered ⇒ queue, no downstream action (design #279 §2's audit
  // step: "post failure ⇒ queue, no downstream action"); the pin stays 'unavailable' (written
  // above) so a repeat attempt is backoff-spaced rather than hammering the paid session again
  // immediately merely because delivery, not the review itself, is what's broken.
  const delivery = await deps.auditDelivery(approvalResult);
  if (!delivery.delivered) {
    return { kind: "queued", reason: `engine-agent: audit delivery unavailable — ${delivery.reason}` };
  }

  // Delivered: the decisive pin is now PERMANENT for H (design #279 §2) — never rerun, even if
  // the refetch below discards THIS tick's consume attempt (the audit receipt, not a successful
  // merge, is what makes the verdict permanent; see this module's header doc).
  deps.recordAttemptPin({ head: H, at: attemptStart, runId, kind: "decisive" });
  deps.recordWalDecisiveOutcome(runId, approvalResult.kind);

  // ── post-session refetch (design #279 §2): discard the approval on ANY change ──────────────
  let status1: PRStatus;
  let data1: PRReviewData;
  try {
    [status1, data1] = await Promise.all([deps.forge.getPRStatus(pr), deps.forge.getPRReviewData(pr)]);
  } catch (e) {
    return { kind: "queued", reason: `engine-agent: post-session refetch failed: ${String(e)}` };
  }
  const revalidate = refetchStillValid(status1, data1, H, B);
  if (!revalidate.ok) {
    return { kind: "queued", reason: `engine-agent: post-session refetch discarded this tick's consume — ${revalidate.reason}` };
  }

  return { kind: "consume", status: status1, data: data1, verdict: { action: syntheticVerdictAction(approvalResult.kind), headOid: H } };
}
