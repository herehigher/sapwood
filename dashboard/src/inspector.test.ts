import assert from "node:assert/strict";
import test from "node:test";
import {
  ATTENTION_KIND_TO_NODE,
  countEventKind,
  NODE_PHASE,
  readAlign,
  readDegradedPhases,
  readLanesCounters,
  readRetro,
  readSummary,
} from "./inspector.ts";

// ── AC7's fixed mapping ──────────────────────────────────────────────────────────────────────

test("ATTENTION_KIND_TO_NODE: only the three named kinds resolve to a node", () => {
  assert.equal(ATTENTION_KIND_TO_NODE["plan-review-escalated"], "verify");
  assert.equal(ATTENTION_KIND_TO_NODE["verify-na-proposed"], "verify");
  assert.equal(ATTENTION_KIND_TO_NODE["ci-inert-escalated"], "ci");
  for (const kind of [
    "drive-needs-human",
    "drive-no-pr",
    "fix-rounds-capped",
    "fix-leg-verdict-rerun",
    "ceiling-escalated",
    "rollback-escalated",
    "worktree-retained",
    "env-failure-preserved",
    "park-escalated",
    "gated-reentry-capped",
    "gated-reentry-capped-label-failed",
    "reclaim-done",
    "reclaim-failed",
  ] as const) {
    assert.equal(ATTENTION_KIND_TO_NODE[kind], undefined, `${kind} must not resolve to a phase`);
  }
});

test("NODE_PHASE: every stage node resolves to exactly one of the five §6 phases", () => {
  assert.equal(NODE_PHASE["goal-align"], "goal-align");
  assert.equal(NODE_PHASE["arch-review"], "arch-verify");
  assert.equal(NODE_PHASE.verify, "arch-verify");
  assert.equal(NODE_PHASE.lane, "lanes");
  assert.equal(NODE_PHASE.ci, "lanes");
  assert.equal(NODE_PHASE.review, "lanes");
  assert.equal(NODE_PHASE.merge, "lanes");
  assert.equal(NODE_PHASE.summary, "summary");
  assert.equal(NODE_PHASE.retro, "retro");
});

// ── readAlign (AC2 Goal & align, AC6 honest-unknown) ────────────────────────────────────────

test("readAlign: reads created/triaged verbatim off a well-formed artifact", () => {
  const artifact = {
    align: { created: [{ issue: 41, title: "Fix the widget", hasPlan: true }], triaged: [{ issue: 42, drafted: false }] },
  };
  const { created, triaged } = readAlign(artifact);
  assert.deepEqual(created, [{ issue: 41, title: "Fix the widget", hasPlan: true }]);
  assert.deepEqual(triaged, [{ issue: 42, drafted: false }]);
});

test("readAlign: null artifact reports honest-unknown for both lists, never an empty array standing in", () => {
  assert.deepEqual(readAlign(null), { created: null, triaged: null });
});

test("readAlign: artifact with no align section reports honest-unknown", () => {
  assert.deepEqual(readAlign({ spendUsd: 1 }), { created: null, triaged: null });
});

test("readAlign: malformed align.created (wrong item shape) degrades to honest-unknown, never throws", () => {
  const artifact = { align: { created: "not-an-array", triaged: [{ issue: 1, drafted: true }] } };
  const { created, triaged } = readAlign(artifact);
  assert.equal(created, null);
  assert.deepEqual(triaged, [{ issue: 1, drafted: true }]);
});

// ── readDegradedPhases (AC2 Arch review / Verify) ───────────────────────────────────────────

test("readDegradedPhases: filters to only the requested phases", () => {
  const artifact = {
    degradedPhases: [
      { phase: "architect", outcome: "escalated", session: "s1" },
      { phase: "harvest", outcome: "escalated", session: "s2" },
      { phase: "plan_review", outcome: "escalated", session: "s3" },
    ],
  };
  const rows = readDegradedPhases(artifact, ["architect", "plan_review"]);
  assert.deepEqual(rows, [
    { phase: "architect", outcome: "escalated", session: "s1" },
    { phase: "plan_review", outcome: "escalated", session: "s3" },
  ]);
});

test("readDegradedPhases: missing/malformed degradedPhases reports honest-unknown, never throws", () => {
  assert.equal(readDegradedPhases(null, ["architect"]), null);
  assert.equal(readDegradedPhases({ degradedPhases: "nope" }, ["architect"]), null);
});

// ── countEventKind ───────────────────────────────────────────────────────────────────────────

test("countEventKind: counts matching kinds, always confident (0 for an empty/non-matching stream)", () => {
  const events = [
    { kind: "plan-review-escalated" },
    { kind: "no-plan-after-draft" },
    { kind: "plan-review-escalated" },
    { kind: "merged" },
  ];
  assert.equal(countEventKind(events, "plan-review-escalated"), 2);
  assert.equal(countEventKind(events, "no-plan-after-draft"), 1);
  assert.equal(countEventKind(events, "ci-inert-escalated"), 0);
});

// ── readLanesCounters (AC2 Lanes / CI / Review / merge, AC6) ────────────────────────────────

test("readLanesCounters: reads counts off a well-formed artifact", () => {
  const artifact = {
    dispatches: [
      { issue: 1, worker: "w1" },
      { issue: 2, worker: "w2" },
    ],
    merges: [{ issue: 1, worker: "w1", pr: 10 }],
    retries: { gatedReentries: 3, gatedReentryCapped: 1, rollbacksRecovered: 2, rollbacksEscalated: 0 },
    escalations: { needsHuman: [7, 8], ceiling: 1, driveNoPr: 0 },
    handoffs: 4,
  };
  assert.deepEqual(readLanesCounters(artifact), {
    dispatches: 2,
    merges: 1,
    retries: { gatedReentries: 3, gatedReentryCapped: 1, rollbacksRecovered: 2, rollbacksEscalated: 0 },
    escalations: { needsHuman: 2, ceiling: 1, driveNoPr: 0 },
    handoffs: 4,
  });
});

test("readLanesCounters: null artifact reports honest-unknown for every field", () => {
  assert.deepEqual(readLanesCounters(null), { dispatches: null, merges: null, retries: null, escalations: null, handoffs: null });
});

test("readLanesCounters: a malformed retries object degrades only that field to honest-unknown, others unaffected", () => {
  const artifact = {
    dispatches: [],
    merges: [],
    retries: { gatedReentries: "three" },
    escalations: { needsHuman: [], ceiling: 0, driveNoPr: 0 },
    handoffs: 0,
  };
  const c = readLanesCounters(artifact);
  assert.equal(c.retries, null);
  assert.equal(c.dispatches, 0);
  assert.deepEqual(c.escalations, { needsHuman: 0, ceiling: 0, driveNoPr: 0 });
});

// ── readSummary (AC2 Summary) ────────────────────────────────────────────────────────────────

test("readSummary: reads top-line numbers off a well-formed artifact", () => {
  const artifact = { spendUsd: 12.5, roundBudgetUsd: 50, prsOpened: 3, prsMerged: 2, issuesClosed: 2 };
  assert.deepEqual(readSummary(artifact), { spendUsd: 12.5, roundBudgetUsd: 50, prsOpened: 3, prsMerged: 2, issuesClosed: 2 });
});

test("readSummary: null artifact reports honest-unknown for every field, never a fabricated 0", () => {
  assert.deepEqual(readSummary(null), { spendUsd: null, roundBudgetUsd: null, prsOpened: null, prsMerged: null, issuesClosed: null });
});

test("readSummary: a wrong-typed field degrades only that field", () => {
  const artifact = { spendUsd: "12.50", roundBudgetUsd: 50, prsOpened: 3, prsMerged: 2, issuesClosed: 2 };
  const s = readSummary(artifact);
  assert.equal(s.spendUsd, null);
  assert.equal(s.roundBudgetUsd, 50);
});

// ── readRetro (AC2 Retro, AC6) ───────────────────────────────────────────────────────────────

test("readRetro: an opened proposal reads pr + branch", () => {
  const artifact = { retro: { opened: { pr: 99, branch: "retro/foo" }, degraded: null } };
  assert.deepEqual(readRetro(artifact), { known: true, opened: { pr: 99, branch: "retro/foo" }, degraded: null });
});

test("readRetro: a degraded proposal reads branch/title/reason", () => {
  const artifact = { retro: { opened: null, degraded: { branch: "retro/bar", title: "t", reason: "no findings" } } };
  assert.deepEqual(readRetro(artifact), {
    known: true,
    opened: null,
    degraded: { branch: "retro/bar", title: "t", reason: "no findings" },
  });
});

test("readRetro: a present-but-empty retro object is the real 'neither' outcome, not honest-unknown", () => {
  const artifact = { retro: { opened: null, degraded: null } };
  assert.deepEqual(readRetro(artifact), { known: true, opened: null, degraded: null });
});

test("readRetro: a missing retro object is honest-unknown, distinct from the real 'neither' outcome above", () => {
  assert.deepEqual(readRetro({}), { known: false, opened: null, degraded: null });
  assert.deepEqual(readRetro(null), { known: false, opened: null, degraded: null });
});
