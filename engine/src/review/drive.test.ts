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

function status(overrides: Partial<PRStatus> = {}): PRStatus {
  return { number: 1, headOid: "H1", baseOid: "B1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true, ciRed: false, ...overrides };
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
  assert.deepEqual(r, { kind: "resolved", H: "H1", B: "B1", D: hashDiff("diff-text") });
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
  assert.deepEqual(r, { kind: "resolved", H: "H2", B: "B1", D: hashDiff("diff-text") });
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
  } | null;
}

function makeDeps(overrides: {
  forge?: Partial<IForge>;
  evaluate?: () => Promise<ApprovalResult>;
  auditDelivery?: EngineAgentDriveDeps["auditDelivery"];
  cfg?: SapwoodConfig;
  now?: () => Date;
  runIds?: string[];
}): { deps: EngineAgentDriveDeps; recorded: Recorded } {
  const recorded: Recorded = { pin: null, wal: null };
  let runIdCursor = 0;
  const runIds = overrides.runIds ?? ["run-1", "run-2", "run-3"];
  const forge: IForge = {
    getPRStatus: async () => status(),
    getPRReviewData: async () => data(),
    getPRDiff: async () => "diff-text",
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
      recorded.wal = { ...wal, treeManifestHash: null, decisiveOutcome: null };
    },
    recordWalDecisiveOutcome: (runId, outcome) => {
      if (recorded.wal && recorded.wal.runId === runId) recorded.wal = { ...recorded.wal, decisiveOutcome: outcome };
    },
    auditDelivery: overrides.auditDelivery ?? (async () => ({ delivered: false, reason: "no #288 impl in this test" })),
    ciChecksCap: 20,
  };
  return { deps, recorded };
}

test("driveEngineAgentReview: preflight failure -> queued, no WAL, no pin (costs nothing)", async () => {
  const { deps, recorded } = makeDeps({ forge: { getPRReviewData: async () => data({ isDraft: true }) } });
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(outcome.kind, "queued");
  assert.equal(recorded.wal, null);
  assert.equal(recorded.pin, null);
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
    forge: { getPRStatus: async () => status({ headOid: "H2" }) },
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
  };
  const outcome = await driveEngineAgentReview(deps, 1, 2);
  assert.equal(evaluated, false, "a decisive pin must never trigger a new paid session");
  assert.equal(outcome.kind, "consume");
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
  assert.equal(recorded.wal?.decisiveOutcome, null);
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
