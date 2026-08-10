// review/drive.ts (#287, E4b, design #279 §2) — drive ordering for the engine-agent reviewer
// kind: attempt pins (decisive/unavailable), preflight (before any paid session), identity
// resolution + WAL, and the post-session refetch. Composed into merge-driver.ts's
// MergeDriver.driveOne (see that module's driveEngineAgentOne) as a SEPARATE code path, gated on
// `reviewer.kind === "engine-agent"` — the three existing Reviewer kinds' behavior in driveOne is
// completely untouched by this module (mechanical extract + additive branch, see merge-driver.ts's
// own doc for the regression-pin stance).
//
// PRODUCTION REACHABILITY (#288/E4c): cli.ts's executable composition root constructs the real
// EngineAgentReviewer and this module's per-lane deps through review/production.ts. The narrower
// reviewer.ts `buildReviewerByKind` factory deliberately remains unable to build this kind because
// its arguments cannot supply the materializer/runner/state/audit dependencies; classic modes
// continue through that factory. The production `auditDelivery` persists the validated artifact,
// discovers/posts the audit comment, and records a runId-guarded receipt. This module still enforces
// the invariant locally: a non-receipted decisive result queues before finalizeVerdict can observe
// it, regardless of which composition root supplied the dependencies.
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
import type { IForge, PRCheckItem, PRReviewData, PRStatus } from "../forge/forge.js";
import { labelsIncludeAny, labelsIncludeAnySubstring } from "../forge/labels.js";
import type { ApprovalResult, ReviewerAdapter } from "../roles/reviewer.js";
import { changesRequestedOnHead, deriveBlockingSignal } from "../roles/reviewer.js";
import { requiredChecksRed, requiredChecksSatisfied } from "./ci-evidence.js";
import { escalateInstructionPathChanges } from "./instruction-path-escalation.js";

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
  reviewArtifactJson: string | null;
  auditCommentId: string | null;
  auditDeliveredAt: string | null;
}

export type PreflightResult = { ok: true } | { ok: false; reason: string };

/**
 * design #279 §2's preflight gate, EVERY check before any paid session — checked in order (a
 * caller only needs the FIRST failure reason; each is individually unit-tested in isolation).
 * Deliberately does NOT check CI evidence (that's async — requiredChecksSatisfied, called
 * separately by the caller with a fetched `getPRChecks` page) so this stays a pure, sync function.
 *
 * #460 (PR#462 review round 1, P2 wording fix): this ordering matches merge-driver.ts's
 * `deriveGate` PRECEDENCE (state/draft/human-label/hold-label all outrank mergeable in both), but
 * the two do NOT reach the same OUTCOME for every reason: `deriveGate` maps a non-OPEN state,
 * draft, or human-triage label to HUMAN — an escalation — while a `driveEngineAgentReview`
 * preflight failure for any of those same reasons is a plain `queued` (pre-existing engine-agent
 * semantics, uniform for conflicted and non-conflicted PRs alike; changing that divergence is
 * out of #460's scope). Hold-label is the one reason where the two DO line up exactly: `deriveGate`
 * maps it to WAIT, and a `hold-label-present` preflight failure is also `queued` — both a wait,
 * not an escalation.
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

export type IdentityResult = { kind: "resolved"; H: string; B: string; D: string; diffText: string } | { kind: "queue"; reason: string };

/**
 * design #279 §2 R2-6: resolve H (head) + B (base) + D (diff hash), then REFETCH status and
 * require head==H ∧ base==B; one mismatch restarts resolution ONCE (using the fresh values from
 * the mismatched refetch), a second mismatch queues this tick. Never throws — a forge failure at
 * any step queues (same never-throws contract as merge-driver.ts's own forge reads).
 *
 * #303 review round 2 (P1, Codex gpt-5.6-sol high): the returned `diffText` is the EXACT text
 * this function hashed into `D` from the WINNING round (the round whose refetch actually
 * matched) — the caller (`driveEngineAgentReview`) threads it into the session as
 * `ReviewContext.diffText`, so "session input diff === D" is true BY CONSTRUCTION rather than by
 * the adapter fetching its own (potentially later, potentially different) copy. Design #279 §1:
 * "the review object is the engine-supplied diff."
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
      return { kind: "resolved", H, B, D, diffText };
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
 *  post-session refetch gate, reused identically by the decisive-pin cheap-consume path.
 *
 *  #303 review round 2 (P1, Codex gpt-5.6-sol high): also requires `data.headOid === H` —
 *  `status`/`data` are two INDEPENDENT reads (a `Promise.all` pair, or two separately-timed
 *  fetches on the decisive-pin path) that can race a push exactly like `merge-driver.ts`'s
 *  classic head-mismatch guard exists to catch. Without this, `status@H` (stale, pre-push) +
 *  `data@H2` (fresh, post-push, and — critically — UNBLOCKED because the push's own commits
 *  happen to carry no new thread/CR) would pass validation on `status`'s stale head while
 *  actually reading a DIFFERENT generation's review data — a rejected verdict could then dispatch
 *  a fix leg against H2 while carrying findings that were about H1. Checked ALONGSIDE the
 *  existing `status.headOid !== H` check (either alone is sufficient to catch a plain head move;
 *  together they catch the split-generation case where the two reads disagree with EACH OTHER,
 *  not just with H). */
export function refetchStillValid(
  status: PRStatus,
  data: PRReviewData,
  H: string,
  B: string,
): { ok: true } | { ok: false; reason: string } {
  if (status.headOid !== H) return { ok: false, reason: `head-moved:${status.headOid}` };
  if (data.headOid !== H) return { ok: false, reason: `data-head-mismatch:${data.headOid}` };
  if ((status.baseOid ?? null) !== B) return { ok: false, reason: `base-moved:${status.baseOid ?? "unknown"}` };
  if (deriveBlockingSignal(data).blocked) return { ok: false, reason: "newly-blocking" };
  // #783: the pre-existing single reason ("ci-no-longer-green") was honest for a red regression
  // but a LIE for `ciInert` — PR #766's discard read that way even though its rollup was never
  // green on this head at all (every check concluded, none failed, none passed — SKIPPED/NEUTRAL
  // throughout). `ciInert` is the authoritative signal for "never green on this generation";
  // everything else `!ciGreen` covers (a genuine `ciRed` failure, or a rollup still pending) keeps
  // the original wording.
  if (!status.ciGreen) return { ok: false, reason: status.ciInert ? "ci-not-green" : "ci-no-longer-green" };
  return { ok: true };
}

/** #783: one non-passing check named for the `ci-inert-escalated` payload/comment — the same
 *  `{name, conclusion}` shape `merge-driver.ts:710-767`'s CI-red evidence already names checks
 *  with, so a human reading either escalation sees the same vocabulary. `conclusion` is the
 *  modern CheckRun's own conclusion, or the legacy StatusContext's `state`, or `"UNKNOWN"` for a
 *  malformed entry that carries neither — never thrown, this is a display-string builder. */
export interface CiInertEscalationCheck {
  name: string;
  conclusion: string;
}

/** Pure payload-builder for the `ci-inert-escalated` event (#783 AC4): given the PR's own check
 *  list, names every check that did NOT pass — the same rollup `ciInert` was computed from,
 *  fetched separately here (`PRStatus` itself carries no per-check detail) because the escalation
 *  evidence needs names, not just the boolean. Takes the full check list rather than requiring the
 *  caller to pre-filter to non-passing ones, so a caller can pass `getPRChecks`' page verbatim.
 *  NOT wired to any live escalation — that wiring is the human-owned remainder (`merge-driver.ts`/
 *  `conductor.ts` are guard-protected paths this issue does not touch); this is the
 *  producer-reachable building block only. */
export function buildCiInertEscalationPayload(checks: readonly PRCheckItem[]): { checks: CiInertEscalationCheck[] } {
  const nonPassing = checks.filter((c) => (c.conclusion ?? c.state ?? "").toUpperCase() !== "SUCCESS");
  return { checks: nonPassing.map((c) => ({ name: c.name, conclusion: c.conclusion ?? c.state ?? "UNKNOWN" })) };
}

/** Pure message-composition function for the `ci-inert-escalated` comment text (#783 AC5): names
 *  the remedy (make the job always run and skip its STEPS, or move it to a dedicated push-only
 *  workflow — `docs/configuration.md`'s `ci` section spells out both), and cites PR #769 as the
 *  worked example (the hosted aux arm's job-level `if:` left a SKIPPED check wedging gate① until
 *  it moved to its own push-only workflow). `head` and `checks` are the same evidence
 *  `buildCiInertEscalationPayload` names — this function only composes the human-facing string, it
 *  never fetches or decides anything. NOT wired to any live posting path — see that function's own
 *  doc for why. */
export function buildCiInertEscalationComment(head: string, checks: readonly CiInertEscalationCheck[]): string {
  const named = checks.map((c) => `${c.name} (${c.conclusion})`).join(", ");
  return (
    `sapwood: gate① concluded on \`${head}\` without ever going green — ${named} concluded without passing, ` +
    "and nothing in the rollup is still running, so this PR can never resolve on its own. Remedy: make the " +
    "job always run and skip its STEPS (so it reports SUCCESS instead of SKIPPED), or move it to a dedicated " +
    "push-only workflow — see docs/configuration.md's `ci` section for the pattern, and PR #769 for the " +
    "worked example."
  );
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
  /** #288/#54: first attempt clock persisted separately from retry backoff's latest pin time. */
  getFirstAttemptAt?: () => string | null;
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
  /** E4c's (#288) audit-comment + delivery-receipt seam — production binds the crash-safe
   *  discover/post/receipt implementation in production.ts; tests can inject the same contract. */
  auditDelivery: (result: Extract<ApprovalResult, { kind: "approved" | "rejected" }>) => Promise<AuditDeliveryResult>;
  /** #288 restart path: deliver/reconcile solely from the WAL-persisted artifact, without
   *  spawning another paid review session. */
  reconcileAuditDelivery: () => Promise<AuditDeliveryResult>;
  ciChecksCap: number;
  /** #502: the RUN-level base-branch-CI-red pin, if one stands (loop/base-ci.ts's `baseRedPin`,
   *  threaded in by the conductor's composition root — this module never touches storage). Read
   *  ONLY to LABEL the CI wait below: nothing here gates, routes or escalates on it, so a stale or
   *  wrongly-set pin can at worst mis-word a queued reason. Absent (or returning null) reproduces
   *  the pre-#502 reason strings exactly. */
  getBaseRedPin?: () => { sha: string; at: string; failing: string[] } | null;
}

export type EngineAgentDriveOutcome =
  // #782: `status`/`data`, when attached, are a COHERENT same-head pair at the point this outcome
  // was returned (same "never derive a signal from mixed reads" discipline the rest of this
  // module already follows) — merge-driver.ts's `driveEngineAgentOne` reads them to report
  // `DriveOutcome.ciPendingObservation`/`ciPendingEscalation` for the queued shapes AC1 names
  // (preflight-failed, decisive-pin discard, CI-evidence-unsatisfied) and every other coherent-read
  // queue in this pipeline. Omitted on genuinely mixed/unavailable reads (a forge outage before
  // either read landed, a split-generation identity mismatch) — that omission IS the signal:
  // merge-driver.ts treats an absent pair as "this pass learned nothing", never a cancel.
  // #782 gate② round 1 (P1): `ciEvidenceUnsatisfied` marks the ONE queued shape that KNOWS,
  // directly, that gate① evidence itself is the blocker — the preflight CI-evidence gate below
  // (requiredChecksSatisfied() failed) — as opposed to every other queued reason, where "is gate①
  // pending" has to be INFERRED from the aggregate rollup (`status.ciGreen`/`ciRed`). That
  // inference is wrong for an ABSENT required check: a check that never materializes at all (no
  // CheckRun for it on this head — as opposed to one that materialized and concluded non-green,
  // e.g. SKIPPED) leaves the aggregate rollup `ciGreen` computed over only the checks that DID
  // report, which can read `true` even though `ci.requiredChecks` is still unsatisfied — the
  // aggregate-rollup-derived CI arm (`engineAgentCiPending`) would then see `ciGreen: true` and
  // report `pending: false`, the exact silent-wedge shape #782 exists to close, just for a
  // different CI-evidence gap than the SKIPPED one #782's own tests originally covered.
  | { kind: "queued"; reason: string; status?: PRStatus; data?: PRReviewData; ciEvidenceUnsatisfied?: true }
  // #420: `title` from the same PRStatus read that proved the merge (omitted when absent).
  | { kind: "merged"; headOid: string; title?: string }
  | { kind: "needs-human"; reason: string }
  // #460 (F37): a structural merge conflict, not a transient preflight failure — see the
  // `checkPreflight` call site below for why this is distinguished from every other reason.
  // Carries status/data so the caller (merge-driver.ts's driveEngineAgentOne) can run the SAME
  // deriveGate CONFLICTING branch driveOne's classic path already uses, instead of this module
  // re-deriving (or duplicating) that gate itself.
  | { kind: "conflict"; status: PRStatus; data: PRReviewData }
  // #503: a required check CONCLUDED FAILING — red is not pending. Same shape and rationale as
  // the #460 conflict route above: carries status/data so merge-driver.ts's driveEngineAgentOne
  // routes it through the existing FIXABLE machinery (fix-leg dispatch, prFixCap accounting,
  // drive-fixup event) instead of this lane waiting out a red that only a producer push can fix.
  // `failing` is the `name@app` list from requiredChecksRed — evidence, engine-derived.
  | { kind: "ci-red"; status: PRStatus; data: PRReviewData; failing: string[] }
  /** `verdict.verdictRunId` is the WAL/pin runId of the ONE decisive review run this verdict came
   *  from (#457, F36): a decisive pin is PERMANENT per head, so the SAME (runId, head) verdict is
   *  re-consumed on every tick until the head moves — the conductor's fix-leg circuit breaker
   *  keys on it (one fix leg per decisive rejected verdict; a rerun means the leg pushed nothing
   *  and a second identical leg is deterministically useless). Engine-authored identity, never
   *  derived from session prose. */
  | {
      kind: "consume";
      status: PRStatus;
      data: PRReviewData;
      verdict: { action: "MERGE_OK" | "HANDLE_THREADS"; headOid: string; verdictRunId: string };
    };

/**
 * The full engine-agent drive-ordering pipeline (design #279 §2), EXCLUDING the final
 * deriveGate/mergeDecision/merge-call step — that step is `finalizeVerdict` (merge-driver.ts),
 * shared byte-for-byte with the classic Reviewer path. Returns `{kind:"consume", ...}` when (and
 * only when) a decisive, delivered, refetch-validated verdict is ready to hand to
 * `finalizeVerdict`; every other path returns `{kind:"queued"}` — this function NEVER calls
 * `forge.mergePR` or dispatches a fix leg itself.
 *
 * Ordering (design #279 §2 + #292): terminal-state check -> instruction-path escalation ->
 * attempt-gate (pin) -> preflight -> identity -> WAL -> session (evaluate) -> audit -> refetch
 * -> consume. See inline comments for where each step lives.
 *
 * #303 review round 1 (PM P1): TWO coherence checks guard against reviewing one commit and
 * merging another — (1) immediately after identity resolves, `data0.headOid` must equal the
 * resolved H, or this generation queues with NO WAL write and NO session spawn; (2) immediately
 * before `auditDelivery`, a decisive verdict's OWN `headOid` must equal H, or it queues with the
 * pin left 'unavailable' — a verdict is only ever consumed for the exact oid this attempt's
 * pin/WAL carry (the #273 OID-binding lesson).
 *
 * #303 review round 2 (Codex gpt-5.6-sol high, adjudicated by PM, 3 P1):
 *  - Terminal-state blindness: this function used to have NO equivalent of merge-driver.ts's own
 *    early MERGED/split-state checks — a produce-pr-and-stop lane whose audited PR a human just
 *    merged would loop `queued` forever (preflight's `pr-not-open:MERGED` reason, never a
 *    terminal outcome). Fixed by fetching `status0`+`data0` TOGETHER at the very top (mirroring
 *    the classic path's own `Promise.all`) and checking MERGED / split-state / CLOSED BEFORE the
 *    attempt-pin check even runs — covering BOTH the decisive-pin-consume path and the
 *    fresh-attempt path with the SAME single check, since both now read the SAME status0/data0.
 *  - `refetchStillValid` gained `data.headOid === H` (see that function's own doc).
 *  - The engine-supplied diff is now threaded end to end: `resolveIdentity` returns the exact
 *    text it hashed into D, and `evaluate()` receives it as `ctx.diffText` — `EngineAgentReviewer`
 *    never fetches its own diff anymore (engine-agent.ts, #303 review round 2).
 */
export async function driveEngineAgentReview(deps: EngineAgentDriveDeps, pr: number, issue: number): Promise<EngineAgentDriveOutcome> {
  const now = deps.now();

  let status0: PRStatus;
  let data0: PRReviewData;
  try {
    [status0, data0] = await Promise.all([deps.forge.getPRStatus(pr), deps.forge.getPRReviewData(pr)]);
  } catch (e) {
    return { kind: "queued", reason: `engine-agent: gate-data-unavailable: ${String(e)}` };
  }

  // ── terminal-state handling (#303 review round 2 P1, merge-driver.ts's driveOne parity) ──────
  // MERGED wins over everything else, checked on EITHER read (one may predate the merge) — an
  // ALREADY-MERGED PR is terminal success, never re-gated (same rationale as the classic path's
  // own check). Split-state reads (status0.state !== data0.state) never derive anything from a
  // mixed pair — queue, re-read next tick, same "never gate from mixed reads" stance the classic
  // path's own head-mismatch/state-mismatch guards take. A COHERENT CLOSED-without-merge is
  // genuinely human territory — behaviorally the SAME outcome deriveGate's own fail-safe
  // `prState !== OPEN -> HUMAN` rule would reach once a verdict exists; returned directly here
  // since this point in the pipeline never derives one. Placed BEFORE the attempt-pin check so
  // BOTH the decisive-pin-consume path and the fresh-attempt path share this ONE check against
  // the SAME status0/data0 pair (no separate terminal-state gap on either path).
  if (status0.state === "MERGED" || data0.state === "MERGED") {
    return { kind: "merged", headOid: status0.headOid, ...(status0.title !== undefined ? { title: status0.title } : {}) };
  }
  if (status0.state !== data0.state) {
    return { kind: "queued", reason: `engine-agent: gate-state-mismatch: ci-state=${status0.state} review-state=${data0.state}` };
  }
  if (data0.state !== "OPEN") {
    return { kind: "needs-human", reason: `engine-agent: gate:HUMAN:pr-state-${data0.state}` };
  }

  // #292: instruction-path edits change reviewer authority, so escalate before attempt-pin
  // reconciliation, CI reads, diff identity work, or any paid engine-agent session. The shared
  // helper keeps classic and engine-agent matching/write semantics identical.
  const instructionEscalation = await escalateInstructionPathChanges({ forge: deps.forge, pr, labels: data0.labels, cfg: deps.cfg });
  if (instructionEscalation.kind === "unavailable") {
    return { kind: "queued", reason: `engine-agent: ${instructionEscalation.reason}`, status: status0, data: data0 };
  }
  if (instructionEscalation.kind === "latched") {
    // The latch cannot distinguish sapwood's own #292 label write from a human-applied label,
    // and need not: both are human territory. Conductor escalation handling is idempotent.
    return { kind: "needs-human", reason: "engine-agent: gate:HUMAN:instruction-path-latch" };
  }
  if (instructionEscalation.kind === "escalated") {
    return {
      kind: "needs-human",
      reason:
        instructionEscalation.reason === "instruction-path-list-incomplete"
          ? `engine-agent: gate:HUMAN:${instructionEscalation.reason}`
          : `engine-agent: gate:HUMAN:instruction-path-change:${instructionEscalation.matchedPaths.join(",")}`,
    };
  }

  // ── conflict route (#460 F37), checked BEFORE the attempt-gate/pin machinery ───────────────
  // #460 P1 (PR#462 review round 1): the attempt-gate below has TWO paths that can swallow a
  // CONFLICTING PR before it ever reaches the ordinary preflight check further down — a decisive
  // pin's consume path (`refetchStillValid`) necessarily discards a conflicted head (its base
  // moved, or CI is no longer green: a conflicted PR builds no merge ref, so CI is suppressed),
  // and an unavailable pin's backoff window queues unconditionally regardless of mergeability.
  // Both would report a generic "queued"/backoff reason and never reach the conflict route,
  // wedging an APPROVED- or REJECTED-pinned PR that goes conflicted forever (no fix leg would
  // ever move the head). Checked here instead, against the SAME status0/data0 already fetched
  // above, BEFORE any pin read/write — this route never touches the pin at all; when a
  // conflict-fix leg eventually pushes a new head, the ordinary head-change pin-clear above
  // handles it and a fresh review runs. `checkPreflight`'s own ordering (state/draft/human-
  // label/hold-label all precede the mergeable check) still guarantees those higher-precedence
  // gates win over this route — see checkPreflight's own doc for exactly which of those diverge
  // from deriveGate's classic-path precedence (draft/human-label do; hold-label does not).
  //
  // #460 P1 (PR#462 review round 2, Codex sol high, executable repro): `status0` and `data0` are
  // two INDEPENDENT reads (the `Promise.all` above) — a stale `status0@H1` CONFLICTING racing a
  // fresh `data0@H2` that is already conflict-free must NOT take this route (it would dispatch a
  // fix leg, burning a fix-round, against a conflict that no longer exists on the real head). The
  // repo's own split-generation identity discipline (H/B/D triple, `resolveIdentity`'s own doc)
  // applies here too: only act on a mergeability reading when both reads agree on the head it
  // describes. A mismatch falls through to the ordinary machinery below (pin/preflight), which
  // already queues/refetches a split-head pair on its own (e.g. the decisive-pin consume path's
  // `refetchStillValid` head check).
  const conflictCheck = checkPreflight({
    status: status0,
    data: data0,
    humanLabels: deps.cfg.escalation.humanLabels,
    holdLabels: deps.cfg.escalation.holdLabels,
  });
  if (!conflictCheck.ok && conflictCheck.reason === "not-mergeable:CONFLICTING" && status0.headOid === data0.headOid) {
    return { kind: "conflict", status: status0, data: data0 };
  }

  // ── attempt-gate: the per-head pin (design #279 §2 R3) ──────────────────────────────────────
  let pin = deps.getAttemptPin();
  if (pin && pin.head !== status0.headOid) {
    // Head change clears the pin — same lifecycle as the classic review-trigger pin.
    deps.recordAttemptPin(null);
    pin = null;
  }
  // #288: a decisive artifact is WAL-persisted BEFORE its comment post. If the engine crashed
  // after that point (including post-succeeded/receipt-lost), reconcile from the WAL now,
  // before backoff and before any paid session. A successful receipt upgrades the existing pin;
  // a failed reconciliation remains queued/backoff-contained below.
  if (pin?.kind === "unavailable") {
    const wal = deps.getWal();
    if (wal && wal.runId === pin.runId && wal.head === status0.headOid && wal.decisiveOutcome !== null && wal.reviewArtifactJson !== null) {
      const delivery = await deps.reconcileAuditDelivery();
      if (delivery.delivered) {
        deps.recordAttemptPin({ ...pin, kind: "decisive" });
        pin = { ...pin, kind: "decisive" };
      }
    }
  }

  // ── ci-red route (#503), same position rationale as the conflict route above ────────────────
  // #507 review P1 (round 1): this must sit BEFORE the decisive-consume/backoff paths, not at
  // the CI-evidence gate below — a decisive pin is PERMANENT per head, and its consume path
  // (`refetchStillValid`) rejects `ciGreen: false`, so a required check that goes red AFTER a
  // green preflight + paid decisive review (same head — e.g. a re-run, or a flaky check's
  // second landing) would queue on every tick forever, recreating the exact wedge #503 removes.
  // An unavailable pin's backoff window would likewise delay the route pointlessly.
  //
  // #507 review P1 (round 2): but it must sit AFTER the #288 WAL reconciliation above, and must
  // YIELD while a matching decisive artifact is still UNDELIVERED (reconcile just failed) — a
  // fix leg pushed off this route would move the head, the head-change clear above would drop
  // the pin, and the crash-persisted artifact could never be audited (receipt-before-
  // downstream-action). Undelivered is `decisiveOutcome !== null && auditCommentId == null`,
  // the same predicate the decisive-consume anomaly check below reads.
  //
  // Position guarantees: `conflictCheck.ok` requires every higher-precedence preflight gate
  // (state/draft/human-label/hold-label/mergeable/threads) to have passed, and the same-head
  // guard is #460's split-generation discipline. The `status0.ciRed` rollup is only the CHEAP
  // TRIGGER for the checks fetch — the routing decision itself is `requiredChecksRed`'s
  // trusted-app FAILURE evidence; a rollup red with no trusted required-check failure (foreign
  // app, non-required check) falls through to the ordinary machinery unchanged, at the cost of
  // one extra checks fetch on that rare shape.
  const undeliveredDecisiveWal = (() => {
    if (pin?.kind !== "unavailable") return false;
    const wal = deps.getWal();
    return (
      wal != null && wal.runId === pin.runId && wal.head === status0.headOid && wal.decisiveOutcome !== null && wal.auditCommentId == null
    );
  })();
  if (conflictCheck.ok && (status0.ciRed ?? false) && status0.headOid === data0.headOid && !undeliveredDecisiveWal) {
    let checksPage0: { checks: import("../forge/forge.js").PRCheckItem[] };
    try {
      checksPage0 = await deps.forge.getPRChecks(pr, deps.ciChecksCap);
    } catch (e) {
      return { kind: "queued", reason: `engine-agent: CI-checks fetch failed: ${String(e)}`, status: status0, data: data0 };
    }
    const failing = requiredChecksRed(checksPage0.checks, deps.cfg.ci.requiredChecks);
    if (failing.length > 0) {
      // #608: a standing #502 base-red pin means the DEFAULT BRANCH is red, and every open PR's
      // merge-ref CI inherits that failure verbatim — a fix-leg push cannot fix the base, and
      // rerolling CI against a still-red base only self-perpetuates (batch-4's probeLlmPing
      // incident: ~$28 across 3 lanes). Only route to the wait when the PR's ENTIRE failing set is
      // already covered by the pin's (same run names, the evidence the pin already carries) — a
      // failing run NOT in the pin's set is this lane's own red, still a legitimate fix leg.
      const basePin = deps.getBaseRedPin?.() ?? null;
      if (basePin && failing.every((f) => basePin.failing.includes(f))) {
        return {
          kind: "queued",
          reason: `engine-agent: CI-red is base-inherited (the default branch is CI-red at ${basePin.sha} — ${basePin.failing.join(", ")}): ${failing.join(", ")}`,
          status: status0,
          data: data0,
        };
      }
      return { kind: "ci-red", status: status0, data: data0, failing };
    }
  }

  if (pin?.kind === "decisive") {
    // PERMANENT for this head: never re-run a session. Still attempt to CONSUME the already-
    // decisive, already-delivered verdict on every tick (cheap — no paid session) — a transient
    // merge failure or a refetch-race discard on an earlier tick must not permanently strand the
    // lane once the race resolves (design #279 §2: "a transient merge failure clears nothing").
    // Reuses the SAME status0/data0 fetched above (#303 review round 2) — no separate fetch.
    const wal = deps.getWal();
    if (!wal || wal.runId !== pin.runId || wal.head !== status0.headOid || wal.decisiveOutcome == null || wal.auditCommentId == null) {
      return {
        kind: "queued",
        reason: "engine-agent: decisive pin has no matching delivered WAL record — anomaly, fail-closed",
        status: status0,
        data: data0,
      };
    }
    const revalidate = refetchStillValid(status0, data0, wal.head, wal.base);
    if (!revalidate.ok) {
      // #782 AC1 ("decisive-pin discard"): `status0`/`data0` are attached unconditionally here —
      // merge-driver.ts's own `status.headOid === data.headOid` coherence check (mirrored from
      // this module's own "never derive a signal from mixed reads" discipline) safely no-ops the
      // rare `data-head-mismatch` discard reason where they in fact disagree.
      return {
        kind: "queued",
        reason: `engine-agent: decisive-pin consume attempt discarded this tick — ${revalidate.reason}`,
        status: status0,
        data: data0,
      };
    }
    return {
      kind: "consume",
      status: status0,
      data: data0,
      verdict: { action: syntheticVerdictAction(wal.decisiveOutcome), headOid: wal.head, verdictRunId: wal.runId },
    };
  }
  if (pin?.kind === "unavailable") {
    const retryAfterSec = deps.cfg.reviewer.agent?.retryAfterSec ?? 900;
    const elapsedSec = (now.getTime() - Date.parse(pin.at)) / 1000;
    if (elapsedSec < retryAfterSec) {
      return {
        kind: "queued",
        reason: `engine-agent: backoff — ${Math.ceil(retryAfterSec - elapsedSec)}s remaining`,
        status: status0,
        data: data0,
      };
    }
    // Backoff expired: this IS the primary-recovery probe — proceed to preflight below.
  }

  // ── preflight (design #279 §2): every gate BEFORE any paid session ─────────────────────────
  // Reuses the SAME status0/data0 fetched above (#303 review round 2) — no separate fetch.
  const preflight = checkPreflight({
    status: status0,
    data: data0,
    humanLabels: deps.cfg.escalation.humanLabels,
    holdLabels: deps.cfg.escalation.holdLabels,
  });
  // #460 (PR#462 review round 2, P2 wording fix): `preflight.reason` CAN still be
  // "not-mergeable:CONFLICTING" here — the conflictCheck above only special-cases it when
  // `status0.headOid === data0.headOid`; a split-generation read (stale CONFLICTING status0
  // racing a fresh, already-conflict-free data0 at a different head, or vice versa) deliberately
  // falls through to here instead. This is the SAME "queued" every other preflight reason
  // already gets — no separate branch needed, since a head mismatch also means neither read can
  // be trusted enough to act on yet, and the NEXT tick re-fetches both as one fresh, coherent
  // pair. Every reason reaching this line (transient ones like UNKNOWN mergeability, and
  // standing ones like a draft/label/unresolved-thread that persists until a human or the
  // producer changes it) gets the SAME outcome: queued, retried next tick, no session spawned.
  if (!preflight.ok) {
    return { kind: "queued", reason: `engine-agent: preflight failed: ${preflight.reason}`, status: status0, data: data0 };
  }

  let checksPage: { checks: import("../forge/forge.js").PRCheckItem[] };
  try {
    checksPage = await deps.forge.getPRChecks(pr, deps.ciChecksCap);
  } catch (e) {
    return { kind: "queued", reason: `engine-agent: preflight CI-checks fetch failed: ${String(e)}`, status: status0, data: data0 };
  }
  const ciEvidence = requiredChecksSatisfied(checksPage.checks, deps.cfg.ci.requiredChecks);
  if (!ciEvidence.ok) {
    // #503: a trusted-red required check was already routed to {kind:"ci-red"} by the early
    // route above (before the attempt-gate — see its own doc for why, #507 review P1). Reaching
    // this line red therefore means a contradictory read (rollup not red, or heads split) —
    // fail-safe to the same queued wait every other unsatisfied shape gets, aged by the #426
    // pin, re-fetched coherently next tick.
    //
    // #502: while the default branch is itself CI-red, EVERY open PR's merge-ref CI inherits that
    // red and every lane lands here at once — the shape that left three lanes waiting 1.5h+ on
    // unreachable evidence with nothing saying why. The wait itself is unchanged (this is a
    // labelling change, not a routing one); what changes is that the reason names the base commit
    // and its failing run, so "the base is broken" reads differently from "your branch is broken"
    // in the queued reason, the drive event and the operator's log. Plausibly-base-inherited, not
    // provably: the pin proves the BASE is red, not that THIS lane's wait is caused by it, and the
    // wording says "base-inherited" about a lane that could also have its own unrelated problem.
    // That over-attribution is the deliberate trade — it costs wording on a lane that is waiting
    // either way, where staying silent cost the 1.5h.
    const basePin = deps.getBaseRedPin?.() ?? null;
    const baseNote = basePin ? ` (base-inherited: the default branch is CI-red at ${basePin.sha} — ${basePin.failing.join(", ")})` : "";
    // #782 gate② round 2 (P1, CONFIRMED): `getPRChecks` is NOT scoped to `status0`'s head the way
    // `getPRStatus`/`getPRReviewData` are to each other (the `Promise.all` pair at the top of this
    // function) — GitHub answers with whatever the CURRENT head's checks are whenever queried, and
    // `PRChecksPage` (forge.ts) carries no head/sha to bind against. A push landing between the
    // status0/data0 read and THIS read would silently misattribute a NEWER head's (still-forming)
    // evidence gap to status0's (older, possibly already-decided) head — the durable #426 pin is
    // keyed on `status0.headOid`, so that misattribution would age/escalate the WRONG head's clock.
    // Revalidated with one cheap `getPRStatus` re-read; on ANY mismatch (or a failed revalidation —
    // fail-closed, "cannot prove same-head" reads the same as "not same-head") the `status`/`data`
    // pair is OMITTED — this module's own `queued` doc: an absent pair means "this pass learned
    // nothing", the same discipline every other mixed-read site in this file already follows,
    // never a signal merge-driver.ts could act on for the wrong head.
    let sameHead = false;
    try {
      const revalidated = await deps.forge.getPRStatus(pr);
      sameHead = revalidated.headOid === status0.headOid;
    } catch {
      // sameHead stays false — cannot prove it, fail closed.
    }
    return {
      kind: "queued",
      reason: `engine-agent: preflight CI-evidence not satisfied${baseNote}: ${ciEvidence.unsatisfied.join(", ")}`,
      ...(sameHead
        ? {
            status: status0,
            data: data0,
            // #782 gate② round 1 (P1): this branch KNOWS gate① evidence is unsatisfied — see the
            // type's own doc above for why merge-driver.ts must use this directly rather than
            // re-deriving from the aggregate ciGreen/ciRed rollup (an absent required check can
            // leave ciGreen === true). Only attached once round 2's same-head revalidation (above)
            // has actually confirmed the checks page describes THIS status0/data0 pair's head.
            ciEvidenceUnsatisfied: true as const,
          }
        : {}),
    };
  }

  // ── identity resolution (design #279 §2 R2-6) ───────────────────────────────────────────────
  const identity = await resolveIdentity(deps.forge, pr, status0);
  if (identity.kind === "queue") return { kind: "queued", reason: identity.reason };
  const { H, B, D, diffText } = identity;

  // #303 review (PM P1): identity/session-input coherence. `data0` was fetched BEFORE identity
  // resolution and is never refreshed by a mismatch-restart — so on a restart (resolveIdentity
  // moved on to a NEW head H) or a plain race (the head moved between the data0 fetch and
  // identity resolution, even with no restart), `data0.headOid` can silently diverge from the
  // resolved H. `evaluate()` below is handed `ctx.data = data0` (the reviewer session judges
  // `ctx.data.headOid`, the OLD head) while WAL/pin/consume all carry H (the NEW head) — a
  // session that read one commit could gate a merge of another. Checked HERE, BEFORE the WAL
  // write: an incoherent generation gets NO WAL record and NO session at all (never partially
  // attempted) — this tick simply queues, and the NEXT tick re-fetches status0/data0/identity
  // as one fresh, coherent generation. Never throws (same fail-closed-to-queue contract as
  // every other step in this pipeline).
  if (data0.headOid !== H) {
    return {
      kind: "queued",
      reason: `engine-agent: identity/session-input incoherence — data0.headOid (${data0.headOid}) != resolved head H (${H}), refusing to spawn a session against mismatched inputs`,
    };
  }

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
  const approvalResult = await deps.reviewerAdapter.evaluate({ forge: deps.forge, pr, issue, data: data0, diffText });

  if (approvalResult.kind === "unavailable" || approvalResult.kind === "pending") {
    // Pin already recorded 'unavailable' above (same runId/at) — nothing further to persist.
    // 'pending' is defensively routed here too: EngineAgentReviewer.evaluate() never actually
    // produces it (E4a's own implementation only ever returns approved/rejected/unavailable),
    // but a generic ReviewerAdapter could — never silently skip the pin/backoff for an
    // actionable, non-decisive result.
    const reason = approvalResult.kind === "unavailable" ? approvalResult.reason : "pending (no decisive artifact yet)";
    // #782: CI evidence was ALREADY satisfied for this attempt to reach the session at all (the
    // preflight CI-evidence gate above), so `status0`/`data0` here reflect a genuinely
    // CI-resolved head — merge-driver.ts's `engineAgentCiPending` reads `pinAfter.kind ===
    // "unavailable"` (true here, the pin this call just wrote/left) to force the CI arm closed
    // regardless, so attaching the pair is safe/correct either way.
    return { kind: "queued", reason: `engine-agent: ${reason}`, status: status0, data: data0 };
  }

  // #303 review (PM P1, defense in depth): the #273 OID-binding lesson applied to this internal
  // seam — a `ReviewerAdapter.evaluate()` implementation computes its OWN `headOid` on the
  // returned `ApprovalResult` (E4a's own contract), independent of the `H` this attempt's
  // pin/WAL were opened against. Even though `ctx.data.headOid` was just proven === H above,
  // nothing stops a (buggy, or future non-E4a) adapter from returning a DIFFERENT headOid on
  // its verdict — and a verdict is only ever consumed for the EXACT oid the pin/WAL carry.
  // Checked BEFORE `auditDelivery` / the decisive-pin upgrade: a mismatch here queues, the pin
  // STAYS 'unavailable' (never promoted to permanent on an unverified oid), and `auditDelivery`
  // is never called for a verdict that can't be trusted to be about H.
  if (approvalResult.headOid !== H) {
    return {
      kind: "queued",
      reason: `engine-agent: decisive verdict headOid (${approvalResult.headOid}) != this attempt's resolved head H (${H}) — refusing to consume (OID-binding violation, #273's lesson)`,
    };
  }

  // WAL-first audit: persist the engine-derived disposition before any network post. The
  // production callback persists the richer validated artifact alongside it; reconciliation
  // only proceeds when both are present.
  deps.recordWalDecisiveOutcome(runId, approvalResult.kind);

  // ── audit: discover-before-post, record delivery (E4c/#288's own implementation) ───────────
  // approved | rejected: a decisive verdict, but NOT YET consumable — see this module's header
  // doc. `auditDelivery` not delivered ⇒ queue, no downstream action (design #279 §2's audit
  // step: "post failure ⇒ queue, no downstream action"); the pin stays 'unavailable' (written
  // above) so a repeat attempt is backoff-spaced rather than hammering the paid session again
  // immediately merely because delivery, not the review itself, is what's broken.
  const delivery = await deps.auditDelivery(approvalResult);
  if (!delivery.delivered) {
    return { kind: "queued", reason: `engine-agent: audit delivery unavailable — ${delivery.reason}`, status: status0, data: data0 };
  }

  // Delivered: the decisive pin is now PERMANENT for H (design #279 §2) — never rerun, even if
  // the refetch below discards THIS tick's consume attempt (the audit receipt, not a successful
  // merge, is what makes the verdict permanent; see this module's header doc).
  deps.recordAttemptPin({ head: H, at: attemptStart, runId, kind: "decisive" });

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
    // #782 AC1 ("decisive-pin discard", the fresh-attempt twin of the decisive-pin CONSUME
    // discard above): `status1`/`data1` attached unconditionally, same "merge-driver.ts's own
    // head-agreement check safely no-ops a rare mismatch" reasoning as that site.
    return {
      kind: "queued",
      reason: `engine-agent: post-session refetch discarded this tick's consume — ${revalidate.reason}`,
      status: status1,
      data: data1,
    };
  }

  return {
    kind: "consume",
    status: status1,
    data: data1,
    verdict: { action: syntheticVerdictAction(approvalResult.kind), headOid: H, verdictRunId: runId },
  };
}
