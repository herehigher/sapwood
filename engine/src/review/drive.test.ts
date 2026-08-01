// review/drive.test.ts (#287, E4b) — the pure helpers (checkPreflight, resolveIdentity,
// refetchStillValid) plus the full driveEngineAgentReview composition, scripted with fakes.
// This is the module merge-driver.test.ts's engine-agent driveOne suite composes against —
// see that file for the end-to-end driveOne-level tests the issue's verification plan names.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { IForge, PRCheckItem, PRReviewData, PRStatus } from "../forge/forge.js";
import type { ApprovalResult } from "../roles/reviewer.js";
import {
  checkPreflight,
  driveEngineAgentReview,
  type EngineAgentDriveDeps,
  hashDiff,
  refetchStillValid,
  resolveIdentity,
} from "./drive.js";

// `| undefined` on each key (not plain Partial): under exactOptionalPropertyTypes a fixture must
// be able to pass an EXPLICIT undefined to model a field the forge didn't return.
function status(overrides: { [K in keyof PRStatus]?: PRStatus[K] | undefined } = {}): PRStatus {
  // Cast: the spread of an all-optional override map widens every field to `| undefined`, which
  // is exactly the shape a test wants to inject and PRStatus deliberately forbids.
  return {
    number: 1,
    headOid: "H1",
    baseOid: "B1",
    state: "OPEN",
    mergeable: "MERGEABLE",
    ciGreen: true,
    ciRed: false,
    ...overrides,
  } as PRStatus;
}

function data(overrides: Partial<PRReviewData> = {}): PRReviewData {
  return {
    headOid: "H1",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00.000Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    reviews: [],
    unresolvedThreads: 0,
    ...overrides,
  };
}

// ── checkPreflight: one test per gate, all BEFORE any paid session ────────────────────────────

test("checkPreflight: OK when every gate passes", () => {
  assert.deepEqual(checkPreflight({ status: status(), data: data(), humanLabels: [], holdLabels: [] }), { ok: true });
});

test("checkPreflight: PR not OPEN fails", () => {
  const r = checkPreflight({ status: status(), data: data({ state: "CLOSED" }), humanLabels: [], holdLabels: [] });
  assert.equal(r.ok, false);
});

test("checkPreflight: draft PR fails", () => {
  const r = checkPreflight({ status: status(), data: data({ isDraft: true }), humanLabels: [], holdLabels: [] });
  assert.equal(r.ok, false);
});

test("checkPreflight: a human-triage label fails", () => {
  const r = checkPreflight({ status: status(), data: data({ labels: ["needs-human"] }), humanLabels: ["needs-human"], holdLabels: [] });
  assert.equal(r.ok, false);
});

test("checkPreflight: a hold label fails", () => {
  const r = checkPreflight({ status: status(), data: data({ labels: ["hold"] }), humanLabels: [], holdLabels: ["hold"] });
  assert.equal(r.ok, false);
});

test("checkPreflight: not MERGEABLE (CONFLICTING) fails", () => {
  const r = checkPreflight({ status: status({ mergeable: "CONFLICTING" }), data: data(), humanLabels: [], holdLabels: [] });
  assert.equal(r.ok, false);
});

test("checkPreflight: not MERGEABLE (UNKNOWN) fails", () => {
  const r = checkPreflight({ status: status({ mergeable: "UNKNOWN" }), data: data(), humanLabels: [], holdLabels: [] });
  assert.equal(r.ok, false);
});

test("checkPreflight: unresolved threads fail", () => {
  const r = checkPreflight({ status: status(), data: data({ unresolvedThreads: 1 }), humanLabels: [], holdLabels: [] });
  assert.equal(r.ok, false);
});

test("checkPreflight: a standing CHANGES_REQUESTED on the current head fails", () => {
  const r = checkPreflight({
    status: status(),
    data: data({ reviews: [{ author: "alice", commitOid: "H1", state: "CHANGES_REQUESTED" }] }),
    humanLabels: [],
    holdLabels: [],
  });
  assert.equal(r.ok, false);
});

// ── resolveIdentity: mismatch restarts once, then queues ──────────────────────────────────────

test("resolveIdentity: no mismatch — resolves H/B/D on the first round", async () => {
  const forge = {
    getPRDiff: async () => "diff-text",
    getPRStatus: async () => status(),
  };
  const r = await resolveIdentity(forge, 1, status());
  assert.deepEqual(r, { kind: "resolved", H: "H1", B: "B1", D: hashDiff("diff-text"), diffText: "diff-text" });
});

test("resolveIdentity: ONE mismatch restarts using the fresh values, then resolves", async () => {
  let call = 0;
  const forge = {
    getPRDiff: async () => "diff-text",
    getPRStatus: async () => {
      call++;
      // First refetch reports a moved head; second (the restart's own refetch) agrees with itself.
      return call === 1 ? status({ headOid: "H2", baseOid: "B1" }) : status({ headOid: "H2", baseOid: "B1" });
    },
  };
  const r = await resolveIdentity(forge, 1, status());
  assert.deepEqual(r, { kind: "resolved", H: "H2", B: "B1", D: hashDiff("diff-text"), diffText: "diff-text" });
  assert.equal(call, 2);
});

test("resolveIdentity: a SECOND mismatch (still moving) queues — never a third round", async () => {
  let call = 0;
  const forge = {
    getPRDiff: async () => "diff-text",
    getPRStatus: async () => {
      call++;
      return status({ headOid: `H${call + 1}` }); // keeps moving every call
    },
  };
  const r = await resolveIdentity(forge, 1, status());
  assert.equal(r.kind, "queue");
  assert.equal(call, 2); // exactly one restart attempted, not an unbounded retry
});

test("resolveIdentity: missing baseOid queues immediately", async () => {
  const forge = { getPRDiff: async () => "d", getPRStatus: async () => status() };
  const r = await resolveIdentity(forge, 1, status({ baseOid: undefined }));
  assert.equal(r.kind, "queue");
});

test("resolveIdentity: a forge failure queues, never throws", async () => {
  const forge = {
    getPRDiff: async () => {
      throw new Error("rate-limited");
    },
    getPRStatus: async () => status(),
  };
  const r = await resolveIdentity(forge, 1, status());
  assert.equal(r.kind, "queue");
});

// ── refetchStillValid: the post-session refetch race gate ─────────────────────────────────────

test("refetchStillValid: unchanged head/base, no blocking, CI green -> ok", () => {
  assert.deepEqual(refetchStillValid(status(), data(), "H1", "B1"), { ok: true });
});

test("refetchStillValid: head moved -> discard", () => {
  const r = refetchStillValid(status({ headOid: "H2" }), data({ headOid: "H2" }), "H1", "B1");
  assert.equal(r.ok, false);
});

test("refetchStillValid: base moved -> discard", () => {
  const r = refetchStillValid(status({ baseOid: "B2" }), data(), "H1", "B1");
  assert.equal(r.ok, false);
});

test("refetchStillValid: newly blocking (unresolved thread appeared) -> discard", () => {
  const r = refetchStillValid(status(), data({ unresolvedThreads: 1 }), "H1", "B1");
  assert.equal(r.ok, false);
});

test("refetchStillValid: CI regressed -> discard", () => {
  const r = refetchStillValid(status({ ciGreen: false }), data(), "H1", "B1");
  assert.equal(r.ok, false);
});

// ── driveEngineAgentReview: the full composition, scripted with fakes ─────────────────────────

function baseCfg(): SapwoodConfig {
  return ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" },
    worker: { model: "sonnet" },
    reviewer: { mode: "engine-agent", agent: { model: "opus", retryAfterSec: 900 } },
    ci: { requiredChecks: [{ name: "test", app: "github-actions" }] },
  }) as SapwoodConfig;
}

function checksPage(overrides: Partial<PRCheckItem> = {}) {
  return {
    checks: [{ name: "test", status: "COMPLETED", conclusion: "SUCCESS", state: null, appSlug: "github-actions", ...overrides }],
    total: 1,
  };
}

interface Recorded {
  pin: { head: string; at: string; runId: string; kind: "decisive" | "unavailable" } | null;
  wal: {
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
  } | null;
}

function makeDeps(overrides: {
  forge?: Partial<IForge>;
  evaluate?: () => Promise<ApprovalResult>;
  auditDelivery?: EngineAgentDriveDeps["auditDelivery"];
  reconcileAuditDelivery?: EngineAgentDriveDeps["reconcileAuditDelivery"];
  cfg?: SapwoodConfig;
  now?: () => Date;
  runIds?: string[];
  getBaseRedPin?: EngineAgentDriveDeps["getBaseRedPin"];
}): { deps: EngineAgentDriveDeps; recorded: Recorded } {
  const recorded: Recorded = { pin: null, wal: null };
  let runIdCursor = 0;
  const runIds = overrides.runIds ?? ["run-1", "run-2", "run-3"];
  const forge: IForge = {
    getPRStatus: async () => status(),
    getPRReviewData: async () => data(),
    getPRDiff: async () => "diff-text",
    getPRChangedFiles: async () => ({ files: [], complete: true }),
    addPRLabel: async () => {},
    addPRComment: async () => {},
    getPRChecks: async () => checksPage(),
    ...overrides.forge,
  } as IForge;
  const deps: EngineAgentDriveDeps = {
    forge,
    reviewerAdapter: { evaluate: overrides.evaluate ?? (async () => ({ kind: "unavailable", headOid: "H1", reason: "no impl" })) },
    cfg: overrides.cfg ?? baseCfg(),
    now: overrides.now ?? (() => new Date("2026-01-01T00:00:00.000Z")),
    newRunId: () => runIds[runIdCursor++] ?? `run-${runIdCursor}`,
    getAttemptPin: () => recorded.pin,
    recordAttemptPin: (pin) => {
      recorded.pin = pin;
    },
    getWal: () => recorded.wal,
    recordWal: (wal) => {
      recorded.wal = {
        ...wal,
        treeManifestHash: null,
        decisiveOutcome: null,
        reviewArtifactJson: null,
        auditCommentId: null,
        auditDeliveredAt: null,
      };
    },
    recordWalDecisiveOutcome: (runId, outcome) => {
      if (recorded.wal && recorded.wal.runId === runId) recorded.wal = { ...recorded.wal, decisiveOutcome: outcome };
    },
    auditDelivery: overrides.auditDelivery ?? (async () => ({ delivered: false, reason: "no #288 impl in this test" })),
    reconcileAuditDelivery: overrides.reconcileAuditDelivery ?? (async () => ({ delivered: false, reason: "nothing to reconcile" })),
    ciChecksCap: 20,
    ...(overrides.getBaseRedPin ? { getBaseRedPin: overrides.getBaseRedPin } : {}),
  };
  return { deps, recorded };
}

// ── #303 review round 2 (Codex P1 #1): terminal-state handling ────────────────────────────────

test("driveEngineAgentReview: MERGED (status0.state) with NO pin at all -> merged outcome, no session, no pin/WAL touched", async () => {
  const { deps, recorded } = makeDeps({ forge: { getPRStatus: async () => status({ state: "MERGED" }) } });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.deepEqual(outcome, { kind: "merged", headOid: "H1" });
  assert.equal(recorded.pin, null);
  assert.equal(recorded.wal, null);
});

test("driveEngineAgentReview: MERGED (data0.state) with a DECISIVE pin already present (produce-pr-and-stop human-merge transition — the audited PR the pin was written for is now merged) -> merged outcome, the decisive-pin consume path is never even reached", async () => {
  const { deps, recorded } = makeDeps({ forge: { getPRReviewData: async () => data({ state: "MERGED" }) } });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" };
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: "approved",
    reviewArtifactJson: "{}",
    auditCommentId: "C1",
    auditDeliveredAt: "2026-01-01T00:00:01.000Z",
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.deepEqual(outcome, { kind: "merged", headOid: "H1" });
  // The pin/WAL are left exactly as they were — this outcome bypasses the pin machinery
  // entirely (same as the classic path's own MERGED check, which never touches trigger pins).
  assert.equal(recorded.pin?.kind, "decisive");
});

test("driveEngineAgentReview: a COHERENT CLOSED-without-merge (both reads agree) -> needs-human, classic deriveGate non-OPEN parity", async () => {
  const { deps } = makeDeps({
    forge: { getPRStatus: async () => status({ state: "CLOSED" }), getPRReviewData: async () => data({ state: "CLOSED" }) },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "needs-human");
});

test("driveEngineAgentReview: split-state reads (status0.state !== data0.state, NEITHER merged) -> queued, never derives anything from a mixed pair", async () => {
  const { deps } = makeDeps({
    forge: { getPRStatus: async () => status({ state: "OPEN" }), getPRReviewData: async () => data({ state: "CLOSED" }) },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /gate-state-mismatch/);
});

test("#292 driveEngineAgentReview: instruction edit labels/comments once before CI, identity, WAL, or a paid session", async () => {
  const filename = ".claude/rules/team/reviewer`\n\u202e.md";
  let latched = false;
  let fileReads = 0;
  let labelWrites = 0;
  let comments = 0;
  let checkReads = 0;
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    forge: {
      // #397: the latch is `human-merge-only` now, not `needs-human` — this path's verdict is
      // "a human must merge this PR", never "the machine got stuck".
      getPRReviewData: async () => data({ labels: latched ? ["sapwood:human-merge-only"] : [] }),
      getPRChangedFiles: async () => {
        fileReads++;
        return { files: [{ filename }], complete: true };
      },
      addPRLabel: async () => {
        labelWrites++;
        latched = true;
      },
      addPRComment: async (_pr, body) => {
        comments++;
        assert.match(body, /\.claude\/rules\/team\/reviewer\?\?\?\.md.*#292/);
      },
      getPRChecks: async () => {
        checkReads++;
        return checksPage();
      },
    },
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "must not run" };
    },
  });

  const first = await driveEngineAgentReview(deps, 1, 2);
  assert.deepEqual(first, {
    kind: "needs-human",
    reason: "engine-agent: gate:HUMAN:instruction-path-change:.claude/rules/team/reviewer???.md",
  });
  assert.equal(fileReads, 1);
  assert.equal(labelWrites, 1);
  assert.equal(comments, 1);
  assert.equal(checkReads, 0);
  assert.equal(evaluated, false);
  assert.equal(recorded.wal, null);

  const second = await driveEngineAgentReview(deps, 1, 2);
  assert.deepEqual(second, { kind: "needs-human", reason: "engine-agent: gate:HUMAN:instruction-path-latch" });
  assert.equal(fileReads, 1);
  assert.equal(labelWrites, 1);
  assert.equal(comments, 1);
});

test("#292 driveEngineAgentReview: changed-files failure queues fail-closed before CI/session work", async () => {
  let checkReads = 0;
  let evaluated = false;
  const { deps } = makeDeps({
    forge: {
      getPRChangedFiles: async () => {
        throw new Error("files API unavailable");
      },
      getPRChecks: async () => {
        checkReads++;
        return checksPage();
      },
    },
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "must not run" };
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /instruction-path-files-unavailable/);
  assert.equal(checkReads, 0);
  assert.equal(evaluated, false);
});

// ── #303 review round 2 (Codex P1 #2): refetchStillValid split-generation ─────────────────────

test("refetchStillValid: split-generation — status@H (stale) + data@H2 (fresh, unblocked) -> discard (the status-only head check alone would have missed this)", () => {
  const r = refetchStillValid(status({ headOid: "H1" }), data({ headOid: "H2", unresolvedThreads: 0 }), "H1", "B1");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.reason, /data-head-mismatch/);
});

test("driveEngineAgentReview: a REJECTED verdict whose post-session data refetch reports a DIFFERENT (newer, unblocked) head than status -> discarded, never reaches FIXABLE consume", async () => {
  let call = 0;
  const { deps } = makeDeps({
    forge: {
      getPRReviewData: async () => {
        call++;
        // call 1: preflight's top-level fetch, at H1 (matches identity). call 2+: the POST-
        // SESSION refetch reports H2 — a split-generation race, unblocked (unresolvedThreads: 0)
        // so the OLD `deriveBlockingSignal` check alone would NOT have caught it.
        return call === 1 ? data({ headOid: "H1" }) : data({ headOid: "H2", unresolvedThreads: 0 });
      },
      // status stays at H1 throughout — only the review-data read raced ahead.
    },
    evaluate: async () => ({ kind: "rejected", headOid: "H1", findings: [{ id: "f1", body: "bug" }] }),
    auditDelivery: async () => ({ delivered: true }),
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued", "must NOT reach {kind:'consume'} (which would dispatch FIXABLE against the wrong generation)");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /refetch/);
});

test("driveEngineAgentReview: preflight failure -> queued, no WAL, no pin (costs nothing)", async () => {
  const { deps, recorded } = makeDeps({ forge: { getPRReviewData: async () => data({ isDraft: true }) } });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.equal(recorded.wal, null);
  assert.equal(recorded.pin, null);
});

// ── #460 (F37): CONFLICTING preflight routes to {kind:"conflict"}, not an unbounded queue ─────

test("driveEngineAgentReview: mergeable CONFLICTING -> {kind:'conflict'} carrying status/data, no WAL, no pin, no session", async () => {
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    forge: { getPRStatus: async () => status({ mergeable: "CONFLICTING" }) },
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "must not run" };
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.deepEqual(outcome, { kind: "conflict", status: status({ mergeable: "CONFLICTING" }), data: data() });
  assert.equal(evaluated, false, "no session for a structurally conflicted PR");
  assert.equal(recorded.wal, null);
  assert.equal(recorded.pin, null);
});

test("driveEngineAgentReview (#460 P1, review round 2, Codex sol high executable repro): split-generation read — status0 CONFLICTING @H1 races a FRESH data0 @H2 (already conflict-free) -> NOT {kind:'conflict'}; falls through to the ordinary machinery, which queues on the SAME 'not-mergeable:CONFLICTING' preflight reason (no pin exists yet, so no fix leg is ever dispatched against a conflict that may no longer be real on the live head)", async () => {
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    forge: {
      getPRStatus: async () => status({ mergeable: "CONFLICTING", headOid: "H1" }),
      getPRReviewData: async () => data({ headOid: "H2", unresolvedThreads: 0 }), // fresh, unblocked, DIFFERENT head
    },
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "must not run" };
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.notEqual(outcome.kind, "conflict", "a mixed-head read must never take the conflict route on a stale/mismatched status");
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /not-mergeable:CONFLICTING/);
  assert.equal(evaluated, false, "still no paid session — this is a queue, not a fresh attempt");
  assert.equal(recorded.wal, null);
  assert.equal(recorded.pin, null);
});

test("driveEngineAgentReview: mergeable UNKNOWN stays queued (transient) — never routed like CONFLICTING", async () => {
  let evaluated = false;
  const { deps } = makeDeps({
    forge: { getPRStatus: async () => status({ mergeable: "UNKNOWN" }) },
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "must not run" };
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /not-mergeable:UNKNOWN/);
  assert.equal(evaluated, false);
});

test("driveEngineAgentReview: CONFLICTING + a higher-precedence preflight failure (draft) still queues plain — checkPreflight's ordering (draft precedes mergeable) wins, same PRECEDENCE deriveGate assumes; the OUTCOME differs deliberately (deriveGate would escalate draft to HUMAN, engine-agent queues — pre-existing, out of #460's scope)", async () => {
  const { deps } = makeDeps({
    forge: { getPRStatus: async () => status({ mergeable: "CONFLICTING" }), getPRReviewData: async () => data({ isDraft: true }) },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /pr-is-draft/);
});

// ── #460 P1 (PR#462 review round 1, Codex gpt-5.6-sol high): the conflict route must be checked
// BEFORE the attempt-gate/pin machinery — a decisive pin's consume path (refetchStillValid) and
// an unavailable pin's backoff window both sit between the OLD check site and here, and both
// would otherwise swallow a CONFLICTING PR as a generic queue/backoff, wedging an already-pinned
// lane forever (no fix leg would ever move the head). These are pin-aware; every test above this
// point uses pin:null, which is exactly why the gap was missed the first time.

test("driveEngineAgentReview (#460 P1): decisive APPROVED pin + CONFLICTING (ciGreen=false, base moved) -> {kind:'conflict'}, pin untouched, no session — a decisive-pin consume attempt must NOT swallow this as a generic refetch discard", async () => {
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    forge: {
      getPRStatus: async () => status({ mergeable: "CONFLICTING", ciGreen: false, baseOid: "B2" }),
    },
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "must not run" };
    },
  });
  const pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" as const };
  recorded.pin = pin;
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: "approved",
    reviewArtifactJson: "{}",
    auditCommentId: "C1",
    auditDeliveredAt: "2026-01-01T00:00:01.000Z",
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.deepEqual(outcome, {
    kind: "conflict",
    status: status({ mergeable: "CONFLICTING", ciGreen: false, baseOid: "B2" }),
    data: data(),
  });
  assert.equal(evaluated, false, "no session — the pin is decisive, never re-run");
  assert.deepEqual(recorded.pin, pin, "the conflict route never reads or writes the pin");
});

test("driveEngineAgentReview (#460 P1): decisive REJECTED pin + CONFLICTING -> {kind:'conflict'}, not the consume-discard queued", async () => {
  const { deps, recorded } = makeDeps({
    forge: { getPRStatus: async () => status({ mergeable: "CONFLICTING" }) },
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" };
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: "rejected",
    reviewArtifactJson: "{}",
    auditCommentId: "C1",
    auditDeliveredAt: "2026-01-01T00:00:01.000Z",
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "conflict");
});

test("driveEngineAgentReview (#460 P1): unavailable pin INSIDE the backoff window + CONFLICTING -> {kind:'conflict'}, not the backoff queued", async () => {
  const { deps, recorded } = makeDeps({
    forge: { getPRStatus: async () => status({ mergeable: "CONFLICTING" }) },
    // now() === pin.at -> elapsed 0s, well inside retryAfterSec (900s default) — the OLD code
    // would return the backoff-queued reason here, before ever reaching a mergeable check.
    now: () => new Date("2026-01-01T00:00:00.000Z"),
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "unavailable" };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "conflict");
});

test("driveEngineAgentReview (#460 P1): decisive pin + mergeable MERGEABLE, base moved -> still the ORDINARY consume-discard queued — the hoisted conflict check must not swallow a non-conflict refetch discard", async () => {
  const { deps, recorded } = makeDeps({
    forge: { getPRStatus: async () => status({ baseOid: "B2" }) }, // mergeable stays MERGEABLE
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" };
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: "approved",
    reviewArtifactJson: "{}",
    auditCommentId: "C1",
    auditDeliveredAt: "2026-01-01T00:00:01.000Z",
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /decisive-pin consume attempt discarded.*base-moved/);
});

test("driveEngineAgentReview: empty ci.requiredChecks -> preflight CI-evidence never passes, queued, no session", async () => {
  const cfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 1, ownerKind: "user" },
    worker: { model: "sonnet" },
    reviewer: { mode: "engine-agent", agent: { model: "opus" } },
  }) as SapwoodConfig;
  let evaluated = false;
  const { deps } = makeDeps({
    cfg,
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "x" };
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.equal(evaluated, false);
});

test("driveEngineAgentReview: WAL is persisted BEFORE the session (evaluate) is called", async () => {
  let walAtEvaluateTime: unknown;
  const { deps, recorded } = makeDeps({
    evaluate: async () => {
      walAtEvaluateTime = recorded.wal;
      return { kind: "unavailable", headOid: "H1", reason: "x" };
    },
  });
  await driveEngineAgentReview(deps, 1, 2);
  assert.ok(walAtEvaluateTime !== null && walAtEvaluateTime !== undefined, "WAL must already be recorded by the time evaluate() runs");
  assert.equal((walAtEvaluateTime as { head: string }).head, "H1");
});

// ── #303 review (PM P1): identity/session-input coherence ─────────────────────────────────────

test("driveEngineAgentReview: a mismatch-restart resolving a NEW head while data0 still holds the OLD head -> queued, evaluate() NEVER called, no WAL write for that incoherent generation", async () => {
  let statusCalls = 0;
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    forge: {
      // call 1: driveEngineAgentReview's own status0 fetch -> H1.
      // call 2: resolveIdentity's first refetch -> the head has moved to H2 (mismatch, restarts).
      // call 3: resolveIdentity's restart-round refetch -> H2 again (stable) -> resolves H=H2.
      getPRStatus: async () => {
        statusCalls++;
        if (statusCalls === 1) return status();
        return status({ headOid: "H2" });
      },
      // data0 (fetched during preflight, BEFORE identity resolution) is never refreshed — it
      // still reports the OLD head H1, exactly the divergence the coherence check must catch.
      getPRReviewData: async () => data({ headOid: "H1" }),
    },
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H2", reason: "should never run" };
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /incoherence/);
  assert.equal(evaluated, false, "an incoherent generation must never spawn a session");
  assert.equal(recorded.wal, null, "no WAL record for an incoherent generation");
  assert.equal(recorded.pin, null, "no pin write either — this generation was never attempted");
});

test("driveEngineAgentReview: the head moved BEFORE identity resolution even ran (status0 and every resolveIdentity refetch already agree on the NEW head, no restart triggered) — data0 still holds the stale head from a slightly earlier read -> queued, same coherence guard", async () => {
  // Every getPRStatus call — the top-level status0 fetch AND resolveIdentity's own internal
  // refetch — consistently reports H2 (a push landed before ANY of this tick's status reads).
  // resolveIdentity therefore resolves H=H2 in ONE round, with NO internal mismatch/restart at
  // all. But getPRReviewData (a separate read, issued moments earlier during preflight) still
  // reports the pre-push head H1 — the plain race the coherence check exists to catch even when
  // resolveIdentity itself never restarted anything.
  const { deps, recorded } = makeDeps({
    forge: {
      getPRStatus: async () => status({ headOid: "H2" }),
      getPRReviewData: async () => data({ headOid: "H1" }),
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /incoherence/);
  assert.equal(recorded.wal, null);
});

test("driveEngineAgentReview: a decisive verdict whose OWN headOid diverges from this attempt's resolved H -> queued, auditDelivery NEVER called, pin stays 'unavailable' (OID-binding, #273's lesson)", async () => {
  let auditCalled = false;
  const { deps, recorded } = makeDeps({
    evaluate: async () => ({ kind: "approved", headOid: "WRONG-OID", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } }),
    auditDelivery: async () => {
      auditCalled = true;
      return { delivered: true };
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /OID-binding|headOid/);
  assert.equal(auditCalled, false, "a verdict for the wrong oid must never reach the audit-delivery seam");
  assert.equal(recorded.pin?.kind, "unavailable", "never promoted to permanent on an unverified oid");
  assert.equal(recorded.wal?.decisiveOutcome, null, "no decisive outcome recorded for the mismatched verdict");
});

test("driveEngineAgentReview: unavailable verdict -> queued, pin recorded 'unavailable' for backoff", async () => {
  const { deps, recorded } = makeDeps({ evaluate: async () => ({ kind: "unavailable", headOid: "H1", reason: "session crashed" }) });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.equal(recorded.pin?.kind, "unavailable");
  assert.equal(recorded.pin?.head, "H1");
});

test("driveEngineAgentReview: unavailable pin -> backoff not yet elapsed -> queued, no session run", async () => {
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "x" };
    },
    now: () => new Date("2026-01-01T00:10:00.000Z"), // 600s after an 'at' set below — under the 900s retryAfterSec
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "prior", kind: "unavailable" };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /backoff/);
  assert.equal(evaluated, false);
});

test("driveEngineAgentReview: unavailable pin -> backoff EXPIRED -> this tick IS the recovery probe (session runs)", async () => {
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "still broken" };
    },
    now: () => new Date("2026-01-01T00:20:00.000Z"), // 1200s later — past the 900s retryAfterSec
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "prior", kind: "unavailable" };
  await driveEngineAgentReview(deps, 1, 2);
  assert.equal(evaluated, true);
});

test("driveEngineAgentReview: head change clears a prior pin (both kinds) before re-evaluating", async () => {
  const { deps, recorded } = makeDeps({
    forge: { getPRStatus: async () => status({ headOid: "H2" }), getPRReviewData: async () => data({ headOid: "H2" }) },
    evaluate: async () => ({ kind: "unavailable", headOid: "H2", reason: "x" }),
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "prior", kind: "decisive" };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  // Not permanently blocked by the stale H1 decisive pin — the new head got a fresh attempt.
  assert.equal(outcome.kind, "queued"); // unavailable result this attempt, but it DID run
  assert.equal(recorded.pin?.head, "H2");
});

test("driveEngineAgentReview: a decisive pin for the CURRENT head is PERMANENT — never re-runs a session", async () => {
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "x" };
    },
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" };
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: "approved",
    reviewArtifactJson: "{}",
    auditCommentId: "C1",
    auditDeliveredAt: "2026-01-01T00:00:01.000Z",
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(evaluated, false, "a decisive pin must never trigger a new paid session");
  assert.equal(outcome.kind, "consume");
  if (outcome.kind === "consume") {
    // #457 (F36): the cheap-consume path must carry the WAL's OWN runId — the conductor's
    // verdict-rerun breaker keys on it to recognize a re-consumed verdict.
    assert.equal(outcome.verdict.verdictRunId, "run-1");
  }
});

test("#288 restart reconciliation upgrades an unavailable pin from WAL receipt discovery without rerunning the paid session", async () => {
  let evaluated = 0;
  const { deps, recorded } = makeDeps({
    evaluate: async () => {
      evaluated++;
      return { kind: "unavailable", headOid: "H1", reason: "must not run" };
    },
    reconcileAuditDelivery: async () => {
      if (recorded.wal) recorded.wal = { ...recorded.wal, auditCommentId: "IC1", auditDeliveredAt: "2026-01-01T00:00:01Z" };
      return { delivered: true };
    },
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00Z", runId: "run-1", kind: "unavailable" };
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00Z",
    decisiveOutcome: "rejected",
    reviewArtifactJson: JSON.stringify({
      perAC: [],
      findings: [{ id: "F1", body: "bug" }],
      sessionActualIdentities: [{ provider: "anthropic", model: "opus" }],
      sessionSpends: [{ kind: "known", usd: 0.1 }],
      promptHash: "p",
    }),
    auditCommentId: null,
    auditDeliveredAt: null,
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(evaluated, 0);
  assert.equal(recorded.pin?.kind, "decisive");
  assert.equal(outcome.kind, "consume");
  if (outcome.kind === "consume") assert.equal(outcome.verdict.action, "HANDLE_THREADS");
});

test("driveEngineAgentReview: decisive pin consume — refetch mismatch discards THIS tick's consume, pin stays decisive (retried next tick)", async () => {
  const { deps, recorded } = makeDeps({ forge: { getPRReviewData: async () => data({ unresolvedThreads: 1 }) } });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" };
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: "approved",
    reviewArtifactJson: "{}",
    auditCommentId: "C1",
    auditDeliveredAt: "2026-01-01T00:00:01.000Z",
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.equal(recorded.pin?.kind, "decisive", "the pin permanence is independent of a refetch-race discard");
});

test("driveEngineAgentReview: approved verdict but audit delivery UNAVAILABLE -> queued, no downstream action, pin stays 'unavailable' (never permanent)", async () => {
  const { deps, recorded } = makeDeps({
    evaluate: async () => ({ kind: "approved", headOid: "H1", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } }),
    auditDelivery: async () => ({ delivered: false, reason: "#288 not implemented" }),
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.equal(recorded.pin?.kind, "unavailable");
  assert.equal(recorded.wal?.decisiveOutcome, "approved");
});

test("driveEngineAgentReview: approved + delivered + refetch clean -> consume with a MERGE_OK-shaped verdict, pin now PERMANENT decisive", async () => {
  const { deps, recorded } = makeDeps({
    evaluate: async () => ({ kind: "approved", headOid: "H1", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } }),
    auditDelivery: async () => ({ delivered: true }),
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "consume");
  if (outcome.kind === "consume") {
    assert.equal(outcome.verdict.action, "MERGE_OK");
    assert.equal(outcome.verdict.headOid, "H1");
    // #457 (F36): a fresh-session consume carries THIS attempt's runId (the WAL/pin identity).
    assert.equal(outcome.verdict.verdictRunId, "run-1");
  }
  assert.equal(recorded.pin?.kind, "decisive");
  assert.equal(recorded.wal?.decisiveOutcome, "approved");
});

test("driveEngineAgentReview: rejected + delivered -> consume with a HANDLE_THREADS-shaped verdict", async () => {
  const { deps } = makeDeps({
    evaluate: async () => ({ kind: "rejected", headOid: "H1", findings: [{ id: "f1", body: "bug" }] }),
    auditDelivery: async () => ({ delivered: true }),
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "consume");
  if (outcome.kind === "consume") assert.equal(outcome.verdict.action, "HANDLE_THREADS");
});

test("driveEngineAgentReview: post-session refetch — head moved between session and consume -> approval discarded", async () => {
  let call = 0;
  const { deps } = makeDeps({
    forge: {
      getPRStatus: async () => {
        call++;
        // Identity resolution's two reads agree on H1; the POST-SESSION refetch (later calls) sees a moved head.
        return call <= 2 ? status() : status({ headOid: "H9" });
      },
    },
    evaluate: async () => ({ kind: "approved", headOid: "H1", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } }),
    auditDelivery: async () => ({ delivered: true }),
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /refetch/);
});

test("driveEngineAgentReview: post-session refetch — CI regressed between session and consume -> approval discarded", async () => {
  let call = 0;
  const { deps } = makeDeps({
    forge: {
      getPRStatus: async () => {
        call++;
        return call <= 2 ? status() : status({ ciGreen: false });
      },
    },
    evaluate: async () => ({ kind: "approved", headOid: "H1", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } }),
    auditDelivery: async () => ({ delivered: true }),
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
});

test("driveEngineAgentReview: post-session refetch — new blocking signal (thread appeared) -> approval discarded", async () => {
  let call = 0;
  const { deps } = makeDeps({
    forge: {
      getPRReviewData: async () => {
        call++;
        return call === 1 ? data() : data({ unresolvedThreads: 1 });
      },
    },
    evaluate: async () => ({ kind: "approved", headOid: "H1", evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 } }),
    auditDelivery: async () => ({ delivered: true }),
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
});

test("driveEngineAgentReview: 'pending' is treated identically to 'unavailable' (E4a never actually produces it, but the seam is generic — never silently skip the pin)", async () => {
  const { deps, recorded } = makeDeps({ evaluate: async () => ({ kind: "pending", headOid: "H1" }) });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.equal(recorded.pin?.kind, "unavailable");
});

// ── #503: red required CI routes to {kind:"ci-red"}, not an eternal backoff wait ──────────────

test("driveEngineAgentReview (#503): a required check CONCLUDED FAILURE -> {kind:'ci-red'} carrying status/data/failing, no WAL, no pin, no session", async () => {
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    forge: {
      getPRStatus: async () => status({ ciGreen: false, ciRed: true }),
      getPRChecks: async () => checksPage({ conclusion: "FAILURE" }),
    },
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "must not run" };
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.deepEqual(outcome, {
    kind: "ci-red",
    status: status({ ciGreen: false, ciRed: true }),
    data: data(),
    failing: ["test@github-actions"],
  });
  assert.equal(evaluated, false, "no paid session for a red build");
  assert.equal(recorded.wal, null);
  assert.equal(recorded.pin, null);
});

test("driveEngineAgentReview (#503): PENDING required CI (null conclusion) keeps the exact pre-#503 queued wait — red is not pending, and neither is the reverse", async () => {
  const { deps } = makeDeps({
    forge: {
      getPRStatus: async () => status({ ciGreen: false }),
      getPRChecks: async () => checksPage({ status: "IN_PROGRESS", conclusion: null }),
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /CI-evidence not satisfied/);
});

// ── #502: a base-inherited CI wait reads differently from an ordinary branch-CI wait ──────────

test("driveEngineAgentReview (#502): while the base-red pin stands, the CI-wait reason NAMES the base commit and its failing run — distinct from the ordinary branch-CI wait", async () => {
  const forge = { getPRStatus: async () => status({ ciGreen: false }), getPRChecks: async () => checksPage({ conclusion: null }) };
  const ordinary = await driveEngineAgentReview(makeDeps({ forge }).deps, 1, 2);
  const inherited = await driveEngineAgentReview(
    makeDeps({ forge, getBaseRedPin: () => ({ sha: "a1c0ffee", at: "2026-01-01T00:00:00.000Z", failing: ["test@github-actions"] }) }).deps,
    1,
    2,
  );
  const reason = (o: typeof ordinary): string => (o.kind === "queued" ? o.reason : "");
  assert.match(reason(ordinary), /CI-evidence not satisfied/);
  assert.doesNotMatch(reason(ordinary), /base-inherited/);
  assert.match(reason(inherited), /base-inherited/, "the operator can tell 'the base is broken' from 'your branch is broken'");
  assert.match(reason(inherited), /a1c0ffee/, "…and which base commit");
  assert.match(reason(inherited), /test@github-actions/, "…and which run");
  assert.notEqual(reason(ordinary), reason(inherited));
});

test("driveEngineAgentReview (#502): a cleared base-red pin puts the lane straight back on the ordinary per-PR CI-evidence reason — no residue", async () => {
  const { deps } = makeDeps({
    forge: { getPRStatus: async () => status({ ciGreen: false }), getPRChecks: async () => checksPage({ conclusion: null }) },
    getBaseRedPin: () => null,
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.doesNotMatch(outcome.kind === "queued" ? outcome.reason : "", /base-inherited/);
});

test("driveEngineAgentReview (#503): split-generation read (status@H1, data@H2) must NOT take the ci-red route — falls through to queued, next tick re-fetches a coherent pair", async () => {
  const { deps } = makeDeps({
    forge: {
      getPRStatus: async () => status({ ciGreen: false, ciRed: true, headOid: "H1" }),
      getPRReviewData: async () => data({ headOid: "H2" }),
      getPRChecks: async () => checksPage({ conclusion: "FAILURE" }),
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.notEqual(outcome.kind, "ci-red", "a mixed-head read must never dispatch a fix leg against a possibly-stale red");
  assert.equal(outcome.kind, "queued");
});

test("driveEngineAgentReview (#503): a FAILURE from an untrusted app does NOT take the ci-red route — queued exactly as before", async () => {
  const { deps } = makeDeps({
    forge: {
      getPRStatus: async () => status({ ciGreen: false, ciRed: true }),
      getPRChecks: async () => checksPage({ conclusion: "FAILURE", appSlug: "evil-app" }),
    },
  });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.match(outcome.kind === "queued" ? outcome.reason : "", /CI-evidence not satisfied/);
});

// ── #507 review P1: the ci-red route precedes the pin machinery, exactly like the conflict route ─

test("driveEngineAgentReview (#503, #507 P1): decisive APPROVED pin + a required check that went red on the SAME head -> {kind:'ci-red'}, pin untouched, no session — the consume path's refetchStillValid must NOT swallow this forever", async () => {
  let evaluated = false;
  const { deps, recorded } = makeDeps({
    forge: {
      getPRStatus: async () => status({ ciGreen: false, ciRed: true }),
      getPRChecks: async () => checksPage({ conclusion: "FAILURE" }),
    },
    evaluate: async () => {
      evaluated = true;
      return { kind: "unavailable", headOid: "H1", reason: "must not run" };
    },
  });
  const pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "decisive" as const };
  recorded.pin = pin;
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: "approved",
    reviewArtifactJson: "{}",
    auditCommentId: "C1",
    auditDeliveredAt: "2026-01-01T00:00:01.000Z",
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.deepEqual(outcome, {
    kind: "ci-red",
    status: status({ ciGreen: false, ciRed: true }),
    data: data(),
    failing: ["test@github-actions"],
  });
  assert.equal(evaluated, false, "no session — the pin is decisive, never re-run");
  assert.deepEqual(recorded.pin, pin, "the ci-red route never reads or writes the pin");
});

test("driveEngineAgentReview (#503, #507 P1): unavailable pin INSIDE its backoff window + trusted red -> {kind:'ci-red'} immediately, not the backoff queued", async () => {
  const now = new Date("2026-01-01T00:00:10.000Z"); // 10s into a 900s backoff
  const { deps, recorded } = makeDeps({
    forge: {
      getPRStatus: async () => status({ ciGreen: false, ciRed: true }),
      getPRChecks: async () => checksPage({ conclusion: "FAILURE" }),
    },
    now: () => now,
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "unavailable" };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "ci-red", "a red build must not wait out the unavailable-pin backoff");
});

test("driveEngineAgentReview (#503, #507 P1 round 2): an UNDELIVERED crash-persisted decisive artifact blocks the ci-red route — receipt before downstream action", async () => {
  const { deps, recorded } = makeDeps({
    forge: {
      getPRStatus: async () => status({ ciGreen: false, ciRed: true }),
      getPRChecks: async () => checksPage({ conclusion: "FAILURE" }),
    },
    reconcileAuditDelivery: async () => ({ delivered: false, reason: "comment post still failing" }),
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "unavailable" };
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: "rejected",
    reviewArtifactJson: "{}",
    auditCommentId: null,
    auditDeliveredAt: null,
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued", "a fix leg must not move the head while the decisive artifact is undelivered");
  assert.equal(recorded.pin?.kind, "unavailable", "pin untouched — reconcile retries next tick");
});

test("driveEngineAgentReview (#503, #507 P1 round 2): once the WAL reconcile DELIVERS the artifact, the ci-red route proceeds in the same pass", async () => {
  const { deps, recorded } = makeDeps({
    forge: {
      getPRStatus: async () => status({ ciGreen: false, ciRed: true }),
      getPRChecks: async () => checksPage({ conclusion: "FAILURE" }),
    },
    reconcileAuditDelivery: async () => ({ delivered: true }),
  });
  recorded.pin = { head: "H1", at: "2026-01-01T00:00:00.000Z", runId: "run-1", kind: "unavailable" };
  recorded.wal = {
    runId: "run-1",
    head: "H1",
    base: "B1",
    diffHash: "d",
    treeManifestHash: null,
    attemptStart: "2026-01-01T00:00:00.000Z",
    decisiveOutcome: "rejected",
    reviewArtifactJson: "{}",
    auditCommentId: null,
    auditDeliveredAt: null,
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "ci-red", "audit delivered first, then the red routes to a fix leg");
  assert.equal(recorded.pin?.kind, "decisive", "the reconcile upgraded the pin before the route fired");
});
