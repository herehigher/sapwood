// #469: the probe signal registry's INVENTORY test (#425/#397 pattern) — the machine half of the
// "every signal names its terminal" rule that PR #466 (F32) could only state as a code comment.
//
// Three things are checked, and together they close both directions:
//   1. every registry entry declares a non-empty terminal/consumer (the TYPE already makes the
//      field required; this catches an empty-string placeholder);
//   2. registry -> behavior: every PROBING entry has a fixture in this file that makes it, and
//      only it, fire — so an entry that can never fire (unreachable, or shadowed by an earlier
//      one) fails, and a NEW entry with no fixture fails too;
//   3. behavior -> registry: round.ts's `probeHasWork` is scanned and must contain no truth
//      branch of its own — adding `if (await forge.getX()).length) return true;` there instead
//      of registering a signal fails this test (the mutation-check in the PR body).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { Issue } from "../forge/forge.js";
import type { PendingRollback, WorkerRow } from "../state/state.js";
import { firstWorkSignal, PROBE_SIGNALS, type ProbeCtx } from "./probe-signals.js";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** All consumers ON: every signal's `enabled` gate must pass here, or it is unreachable. */
const allOnCfg = (): SapwoodConfig =>
  ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" },
    roles: { po: { enabled: true }, verificationPlanReviewer: { enabled: true } },
    round: { milestone: "M-X" },
  });

/** The three worker signals and the rollback signal only ever ask `.length > 0`, so a fixture
 *  row needs no real columns — one named cast rather than 20 irrelevant fields restated. */
const oneWorker = (): WorkerRow[] => [{} as WorkerRow];
const oneRollback = (): PendingRollback[] => [{} as PendingRollback];

const mkIssue = (over: Partial<Issue> = {}): Issue => ({ number: 1, title: "t", labels: [], ...over });

/** Empty everywhere: no signal fires. Each fixture below overrides exactly one read. */
const baseCtx = (): ProbeCtx => ({
  cfg: allOnCfg(),
  mergeGateConfigured: true,
  state: {
    pendingRollbacks: () => [],
    activeWorkers: () => [],
    handoffWorkers: () => [],
    gatedFailedWorkers: () => [],
    eventsAfterId: () => [],
  },
  forge: {
    getReadyIssues: async () => [],
    getIssuesNeedingPlanReview: async () => [],
    getIssuesNeedingPlanTriage: async () => [],
    getPoolEligibleIssues: async () => [],
    countOpenIssuesInMilestone: async () => 0,
    listOpenIssues: async () => [],
    getIssueMeta: async (issue) => ({ number: issue, title: "t", state: "OPEN", labels: [], updatedAt: "2026-01-01T00:00:00Z" }),
    getPRLabels: async () => [],
  },
});

/** One fixture per PROBING registry entry: a ctx in which THAT signal — and no other — fires.
 *  Keyed by `ProbeSignal.name`; the inventory test asserts this map and the registry are exact
 *  mirrors of each other, so neither a new signal nor a deleted one can pass silently. */
const FIXTURES: Record<string, () => ProbeCtx> = {
  "pending-rollbacks": () => ({ ...baseCtx(), state: { ...baseCtx().state, pendingRollbacks: oneRollback } }),
  "pending-durable-concerns": () => ({
    ...baseCtx(),
    state: {
      ...baseCtx().state,
      // dissent.ts's own fold: a decision event carrying a concern with no `concern-posted`
      // receipt and no `concern-post-escalated` terminal is exactly what stays pending.
      eventsAfterId: () => [{ id: 1, kind: "triage-decision-accepted", payload: { round_id: 1, concerns: [{ issue: 7, reason: "r" }] } }],
    },
  }),
  "active-lanes": () => ({ ...baseCtx(), state: { ...baseCtx().state, activeWorkers: oneWorker } }),
  "handoff-resume-candidates": () => ({ ...baseCtx(), state: { ...baseCtx().state, handoffWorkers: oneWorker } }),
  "gated-reentry-candidates": () => ({
    ...baseCtx(),
    state: { ...baseCtx().state, gatedFailedWorkers: () => [{ issue: 1, pr: 2 } as WorkerRow] },
    // allOnCfg() scopes this run to milestone "M-X" (#630) — the candidate's own issue must be
    // IN that milestone for the fixture to fire; the off-milestone case is its own reverse test.
    forge: { ...baseCtx().forge, getIssueMeta: async (issue) => ({ ...(await baseCtx().forge.getIssueMeta(issue)), milestone: "M-X" }) },
  }),
  "ready-issues": () => ({ ...baseCtx(), forge: { ...baseCtx().forge, getReadyIssues: async () => [mkIssue()] } }),
  "plan-review-candidates": () => ({
    ...baseCtx(),
    forge: { ...baseCtx().forge, getIssuesNeedingPlanReview: async () => [mkIssue()] },
  }),
  "plan-triage-candidates": () => ({
    ...baseCtx(),
    forge: { ...baseCtx().forge, getIssuesNeedingPlanTriage: async () => [mkIssue()] },
  }),
  "pooled-plan-review-repair": () => {
    const cfg = allOnCfg();
    return {
      ...baseCtx(),
      cfg,
      // Eligible AND pool-labelled — the exact `getPoolEligibleIssues() ∩ roundPool` set the
      // class-2 repair consumes. An eligible-but-unlabelled issue is covered by its own test.
      forge: { ...baseCtx().forge, getPoolEligibleIssues: async () => [mkIssue({ labels: [cfg.labels.roundPool] })] },
    };
  },
  "milestone-backlog": () => {
    const cfg = allOnCfg();
    return {
      ...baseCtx(),
      cfg,
      forge: {
        ...baseCtx().forge,
        countOpenIssuesInMilestone: async () => 1,
        // Open, in-milestone, unheld, and NOT plan-complete — nothing excludes it, so the PO's
        // aligning pass can still consume it.
        listOpenIssues: async () => [mkIssue({ milestone: "M-X", body: "no plan here" })],
      },
    };
  },
};

test("#469 AC1: every probe signal declares a non-empty terminal, consumer and unique name", () => {
  assert.ok(PROBE_SIGNALS.length > 0);
  const names = PROBE_SIGNALS.map((s) => s.name);
  assert.deepEqual(names, [...new Set(names)], "signal names must be unique — they are this registry's identity");
  for (const s of PROBE_SIGNALS) {
    assert.ok(s.name.trim().length > 0, "every signal needs a name");
    assert.ok(s.consumer.trim().length > 0, `${s.name}: consumer must say WHO reads this signal and what gates them`);
    assert.ok(
      s.terminal.trim().length > 20,
      `${s.name}: terminal must state the state in which a DETERMINISTIC failure stops this signal counting — not a placeholder`,
    );
  }
});

test("#469 AC1: a declared blind spot (probe: null) states the human-act terminal; no other entry does", () => {
  for (const s of PROBE_SIGNALS.filter((x) => x.probe === null)) {
    assert.match(s.terminal, /^human act observed on the next legitimate wake/, `${s.name}: blind spots share one terminal shape`);
  }
  for (const s of PROBE_SIGNALS.filter((x) => x.probe !== null)) {
    assert.doesNotMatch(s.terminal, /^human act observed/, `${s.name} is probed — its terminal must be its own, not the blind-spot one`);
  }
});

test("#469 AC2: registry -> behavior — every probing signal has a fixture, every fixture a signal, and each fires alone", async () => {
  const probing = PROBE_SIGNALS.filter((s) => s.probe !== null).map((s) => s.name);
  assert.deepEqual(
    probing.filter((n) => FIXTURES[n] === undefined),
    [],
    "new probe signal(s) with no fixture — add one proving the signal can actually fire, or it is unreachable",
  );
  assert.deepEqual(
    Object.keys(FIXTURES).filter((n) => !probing.includes(n)),
    [],
    "fixture(s) for a signal that no longer exists (or is now a blind spot) — delete them",
  );
  assert.equal(await firstWorkSignal(baseCtx()), null, "the all-empty baseline must NOT open a round");
  for (const name of probing) {
    // #470: the probe returns the NAME, so this also pins each entry's ledger contract — a
    // fixture that fires some OTHER signal (a shadowing bug) fails here rather than passing.
    assert.equal(await firstWorkSignal(FIXTURES[name]!()), name, `${name}: registered but unreachable — its fixture opens no round`);
  }
});

test("#469 AC2: no unreachable entry — with every consumer enabled, no signal's own gate excludes it", () => {
  const ctx = baseCtx();
  for (const s of PROBE_SIGNALS.filter((x) => x.probe !== null)) {
    assert.equal(s.enabled?.(ctx) ?? true, true, `${s.name}: gated off even with all consumers enabled — dead entry`);
  }
});

test("#469: local (SQLite) signals are all checked before any forge read — the probe's cost ordering is part of the registry's order", () => {
  const reads = PROBE_SIGNALS.filter((s) => s.probe !== null).map((s) => s.read);
  assert.deepEqual(
    [...reads].sort((a, b) => (a === b ? 0 : a === "local" ? -1 : 1)),
    reads,
    "a forge read must not precede a local one",
  );
});

/** round.ts's probe, sliced from source — BOTH the signal-returning `probeWorkSignal` and the
 *  boolean `probeHasWork` view that wraps it (#470), so a signal cannot be smuggled into either.
 *  The delegation check below reads it. */
function probeSource(): string {
  const src = readFileSync(join(SRC, "loop/round.ts"), "utf8");
  const start = src.indexOf("const probeWorkSignal = async ()");
  assert.ok(start > 0, "probeWorkSignal no longer exists in round.ts under that name — re-point this scan");
  const end = src.indexOf("const toTickDeps = ", start);
  assert.ok(end > start, "could not find the end of the probe");
  return src.slice(start, end);
}

test("#469 AC2: behavior -> registry — round.ts's probe holds NO signal of its own; an unregistered addition there fails this test", () => {
  const body = probeSource();
  assert.ok(body.includes("firstWorkSignal("), "the probe must delegate to the registry");
  // #470 made the probe return the firing signal's NAME, so a smuggled signal is a string return.
  // The one that belongs here is the contained-failure arm: a throwing probe reports
  // `probe-error` and fails OPEN to opening the round.
  const stringReturns = body.match(/return "[^"]*"/g) ?? [];
  assert.deepEqual(
    stringReturns,
    ['return "probe-error"'],
    "the probe named a signal of its own — register it in PROBE_SIGNALS (with its terminal) instead",
  );
  assert.doesNotMatch(body, /\breturn true\b/, "no bare truth branch either — a signal is a registry entry, not a local `return true`");
  assert.ok(/catch \(e\) \{[\s\S]*return "probe-error";/.test(body), "the surviving string return must be the catch's fail-open arm");
  assert.doesNotMatch(body, /\bforge\.\w+\(/, "the probe must issue no forge read of its own — reads belong to a registry entry");
  assert.doesNotMatch(
    body.replace(/deps\.state\.appendEvent/g, ""),
    /\bdeps\.state\.\w+\(/,
    "the probe must issue no state read of its own (appendEvent for the tick-error aside)",
  );
});

test("#469: an eligible-but-UNPOOLED issue still counts as nothing — the round-5 F32 fix survives the refactor", async () => {
  const ctx = baseCtx();
  ctx.forge.getPoolEligibleIssues = async () => [mkIssue({ labels: ["something-else"] })];
  assert.equal(await firstWorkSignal(ctx), null, "a valid PO `selected: []` judgment must not pin the probe true");
});

test("#591: probe-signals treats a fully anchored non-English plan as plan-complete, not milestone backlog work", async () => {
  const ctx = baseCtx();
  ctx.forge.listOpenIssues = async () => [
    mkIssue({
      milestone: "M-X",
      body: "## 受け入れ条件\n<!-- sapwood:ac -->\n\n- [ ] 動作する\n\n## 検証\n<!-- sapwood:verification -->\n\n- npm test を実行する",
    }),
  ];
  assert.equal(await firstWorkSignal(ctx), null);
});

// ── #630 (F32 follow-through, live park batch-7 round 312): gated-reentry-candidates must be
// ── milestone-scoped like the dispatch path already is — an off-milestone needs-human carrier is
// ── not work this run can ever consume, and must not hold the standby probe open over it. ──────

test("#630 AC1/AC2: an off-milestone gated-reentry candidate no longer holds the probe open; an IN-milestone one still does (reverse test)", async () => {
  const cfg = allOnCfg(); // round.milestone = "M-X"
  const mkCandidateCtx = (candidateMilestone: string | undefined): ProbeCtx => ({
    ...baseCtx(),
    cfg,
    state: { ...baseCtx().state, gatedFailedWorkers: () => [{ issue: 144 } as WorkerRow] },
    forge: {
      ...baseCtx().forge,
      getIssueMeta: async (issue) => ({
        number: issue,
        title: "t",
        state: "OPEN",
        labels: [],
        updatedAt: "2026-01-01T00:00:00Z",
        ...(candidateMilestone !== undefined ? { milestone: candidateMilestone } : {}),
      }),
    },
  });
  // Red-pinned-today shape: #144 sits in "v0.2.3", this run is scoped to "M-X" — nothing enabled
  // (align.ts/plan-review.ts, both gated on cfg.round.milestone) can ever consume it this run.
  assert.equal(
    await firstWorkSignal(mkCandidateCtx("v0.2.3")),
    null,
    "a needs-human carrier outside the run's milestone must not hold standby open — nothing this run can consume",
  );
  // Reverse: the same shape, in-scope, must still report — gated reclaim's own consumable set
  // (conductor.ts's per-lane GATED RECLAIM, unchanged by this signal) is unaffected.
  assert.equal(
    await firstWorkSignal(mkCandidateCtx("M-X")),
    "gated-reentry-candidates",
    "an IN-milestone gated candidate still reports — reclaim/dispatch for in-scope candidates is unchanged",
  );
});

test("#630: an unset round.milestone keeps gated-reentry-candidates unscoped — no behavior change for a run that never sets it (RoundScopedForge's own 'unset = no scoping' convention)", async () => {
  const ctx: ProbeCtx = {
    ...baseCtx(),
    cfg: ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4, ownerKind: "user" } }),
    state: { ...baseCtx().state, gatedFailedWorkers: () => [{ issue: 144 } as WorkerRow] },
  };
  assert.equal(
    await firstWorkSignal(ctx),
    "gated-reentry-candidates",
    "no milestone configured means no scoping question can be asked — same stance as every other milestone-gated signal in this registry",
  );
});

test("#730 AC2: an in-scope gated candidate with no human block still holds the probe open for GATED RECLAIM", async () => {
  const cfg = allOnCfg();
  const ctx: ProbeCtx = {
    ...baseCtx(),
    cfg,
    state: { ...baseCtx().state, gatedFailedWorkers: () => [{ issue: 730, pr: 731 } as WorkerRow] },
    forge: {
      ...baseCtx().forge,
      getIssueMeta: async (issue) => ({
        number: issue,
        title: "CI-green gated PR",
        state: "OPEN",
        labels: [],
        milestone: "M-X",
        updatedAt: "2026-08-07T00:00:00Z",
      }),
      getPRLabels: async () => [],
    },
  };

  assert.equal(await firstWorkSignal(ctx), "gated-reentry-candidates");
});

test("#730 gate② P1: an issue-side hold with needs-human cleared and a clean PR remains probe work — #400 carrier parity reaches RECLAIM", async () => {
  const cfg = allOnCfg();
  const ctx: ProbeCtx = {
    ...baseCtx(),
    cfg,
    state: { ...baseCtx().state, gatedFailedWorkers: () => [{ issue: 730, pr: 731 } as WorkerRow] },
    forge: {
      ...baseCtx().forge,
      getIssueMeta: async (issue) => ({
        number: issue,
        title: "issue-held but reentry-ready gated PR",
        state: "OPEN",
        labels: [cfg.escalation.holdLabels[0]!],
        milestone: "M-X",
        updatedAt: "2026-08-10T00:00:00Z",
      }),
      getPRLabels: async () => [],
    },
  };

  assert.equal(
    await firstWorkSignal(ctx),
    "gated-reentry-candidates",
    "#400: an issue-side hold is not part of conductor.ts:3982's issue carrier holdSet, so the next tick can RECLAIM",
  );
});

test("#730 AC1: issue human labels and PR human/hold labels leave gated re-entry out of the probe", async () => {
  const cfg = allOnCfg();
  const ctx: ProbeCtx = {
    ...baseCtx(),
    cfg,
    state: {
      ...baseCtx().state,
      gatedFailedWorkers: () => [
        { issue: 730, pr: 1730 } as WorkerRow,
        { issue: 731, pr: 1731 } as WorkerRow,
        { issue: 732, pr: 1732 } as WorkerRow,
      ],
    },
    forge: {
      ...baseCtx().forge,
      getIssueMeta: async (issue) => ({
        number: issue,
        title: "human-blocked gated candidate",
        state: "OPEN",
        labels: issue === 730 ? [cfg.labels.needsHuman] : [],
        milestone: "M-X",
        updatedAt: "2026-08-07T00:00:00Z",
      }),
      getPRLabels: async (pr) => (pr === 1731 ? [cfg.labels.blocked] : [cfg.escalation.holdLabels[0]!]),
    },
  };

  assert.equal(await firstWorkSignal(ctx), null, "only candidates waiting on a human must not keep standby awake");
});
