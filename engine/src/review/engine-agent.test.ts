// engine-agent.test.ts (#286, E4a, design #279) — EngineAgentReviewer's evaluate()/trigger()
// against FAKE deps (materializer fn, RoleRunner-shaped runner, AC-snapshot/model-lookup
// functions) — no real subprocess, no real filesystem materialization. Every failure path maps
// to `unavailable`; every setup/model-separation check fires before a session is even spawned
// where possible; cost-remainder arithmetic and the retry-once contract are pinned directly.
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseConfig } from "../config/config.js";
import type { IForge, PRReviewData } from "../forge/forge.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import type { ApprovalResult, ReviewContext } from "../roles/reviewer.js";
import type { AcSnapshot } from "./ac-snapshot.js";
import { type EngineAgentReviewer, makeEngineAgentReviewer } from "./engine-agent.js";
import type { MaterializeResult } from "./materializer.js";

// ── Fixtures ─────────────────────────────────────────────────────────────────────────────────

const AGENT_MODEL = "opus";
const WORKER_MODEL = "sonnet";

function mkCfg() {
  return parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      `worker: { model: ${WORKER_MODEL} }\n` +
      `reviewer: { mode: engine-agent, agent: { model: ${AGENT_MODEL}, costCapUsd: 3, effort: high } }\n`,
  );
}

const MANIFEST = [
  { id: "1-aaaaaaaa", text: "first criterion" },
  { id: "2-bbbbbbbb", text: "second criterion" },
];

const SNAPSHOT: AcSnapshot = {
  issue: 42,
  bodyHash: "hash",
  body: "the snapshotted issue body",
  manifest: MANIFEST,
  snapshottedAt: "2026-07-22T00:00:00Z",
};

const MATERIALIZED: MaterializeResult = { kind: "materialized", treeDir: "/tmp/engine-agent-test", oid: "h".repeat(40), manifest: [] };

function mkData(overrides: Partial<PRReviewData> = {}): PRReviewData {
  return {
    headOid: "h".repeat(40),
    author: "producer",
    updatedAt: "2026-07-22T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    reviews: [],
    unresolvedThreads: 0,
    ...overrides,
  };
}

function mkForge(overrides: Partial<IForge> = {}): IForge {
  return { getPRDiff: async () => "diff --git a/x b/x\n+added line\n", ...overrides } as unknown as IForge;
}

/** A resultText carrying a valid sentinel-wrapped structured block for MANIFEST. */
function validResultText(perAC: { id: string; status: string }[], findings: { id: string; body: string }[] = []): string {
  return `reasoning preamble\n\n<<<SAPWOOD_RESULT>>>\n${JSON.stringify({ perAC, findings })}\n<<<END_SAPWOOD_RESULT>>>`;
}

const ALL_CONFIRMED = validResultText(MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })));

function mkSessionResult(overrides: Partial<RoleSessionResult> = {}): RoleSessionResult {
  return {
    outcome: "done",
    costUsd: 1,
    modelUsage: [{ model: AGENT_MODEL, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    exitCode: 0,
    name: "role-engine-reviewer-test",
    resultText: ALL_CONFIRMED,
    ...overrides,
  };
}

/** A queued-response fake for `Pick<RoleRunner, "run">` — each call pops the next queued entry
 *  (a RoleSessionResult, or a `{ throwMsg }` marker simulating a spawn/setup failure runner.run()
 *  itself throws). Records every call's opts for assertion (maxBudgetUsd threading, etc). */
class FakeRunner {
  calls: RoleSessionOpts[] = [];
  private queue: (RoleSessionResult | { throwMsg: string })[];
  constructor(queue: (RoleSessionResult | { throwMsg: string })[]) {
    this.queue = queue;
  }
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    const next = this.queue.shift();
    if (!next) throw new Error("FakeRunner: no more queued results — test scripted too few attempts");
    if ("throwMsg" in next) throw new Error(next.throwMsg);
    return next;
  }
}

interface Deps {
  materializeCalls: string[];
  runner: FakeRunner;
  getAcSnapshotCalls: number[];
  build: () => EngineAgentReviewer;
}

function mkDeps(opts: {
  runnerQueue: (RoleSessionResult | { throwMsg: string })[];
  snapshot?: AcSnapshot | null;
  workerActualModels?: string[];
  materialize?: MaterializeResult | ((headOid: string) => Promise<MaterializeResult>);
  cfg?: ReturnType<typeof mkCfg>;
}): Deps {
  const materializeCalls: string[] = [];
  const getAcSnapshotCalls: number[] = [];
  const runner = new FakeRunner(opts.runnerQueue);
  const materializeFn = async (headOid: string): Promise<MaterializeResult> => {
    materializeCalls.push(headOid);
    if (typeof opts.materialize === "function") return opts.materialize(headOid);
    return opts.materialize ?? MATERIALIZED;
  };
  return {
    materializeCalls,
    runner,
    getAcSnapshotCalls,
    build: () =>
      makeEngineAgentReviewer({
        materialize: materializeFn,
        runner,
        getAcSnapshot: (issue) => {
          getAcSnapshotCalls.push(issue);
          return opts.snapshot === undefined ? SNAPSHOT : opts.snapshot;
        },
        getWorkerActualModels: () => opts.workerActualModels ?? [WORKER_MODEL],
        cfg: opts.cfg ?? mkCfg(),
        now: () => new Date("2026-07-22T00:00:00Z"),
      }),
  };
}

function ctx(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return { forge: mkForge(), pr: 5, issue: 42, data: mkData(), ...overrides };
}

// ── Construction ─────────────────────────────────────────────────────────────────────────────

test("makeEngineAgentReviewer: kind is 'engine-agent'", () => {
  const { build } = mkDeps({ runnerQueue: [] });
  assert.equal(build().kind, "engine-agent");
});

test("EngineAgentReviewer construction throws when cfg.reviewer.agent is not set (defense-in-depth against a hand-built config)", () => {
  const cfgNoAgent = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }");
  const { build } = mkDeps({ runnerQueue: [], cfg: cfgNoAgent as unknown as ReturnType<typeof mkCfg> });
  assert.throws(() => build(), /requires cfg\.reviewer\.agent/);
});

// ── trigger(): no-op ─────────────────────────────────────────────────────────────────────────

test("trigger(): no-op — resolves without touching the forge at all", async () => {
  const { build } = mkDeps({ runnerQueue: [] });
  const forge = mkForge({
    addPRComment: async () => {
      throw new Error("trigger() must never call the forge");
    },
  });
  await build().trigger(ctx({ forge }));
});

// ── evaluate(): failure paths -> unavailable ────────────────────────────────────────────────

test("evaluate(): no PRReviewData -> unavailable, headOid null", async () => {
  const { build } = mkDeps({ runnerQueue: [] });
  const result = await build().evaluate({ forge: mkForge(), pr: 5, issue: 42 });
  assert.deepEqual(result, { kind: "unavailable", headOid: null, reason: "no PRReviewData supplied to evaluate()" });
});

test("evaluate(): no AC snapshot recorded for the issue -> unavailable, fail closed, no session spawned", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [], snapshot: null });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /no AC snapshot recorded/);
  assert.equal(runner.calls.length, 0);
});

test("evaluate(): producing worker's actual model UNKNOWN (empty array) -> unavailable, pre-session, no session spawned (D5 fail-closed on unknown)", async () => {
  const { build, runner, materializeCalls } = mkDeps({ runnerQueue: [], workerActualModels: [] });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /actual model is unknown/);
  assert.equal(runner.calls.length, 0);
  assert.equal(materializeCalls.length, 0); // pre-session check short-circuits before materialize too
});

test("evaluate(): producing worker's actual model EQUALS reviewer.agent.model -> unavailable, pre-session (D5)", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [], workerActualModels: [AGENT_MODEL] });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /D5/);
  assert.equal(runner.calls.length, 0);
});

test("evaluate(): getPRDiff throws -> unavailable, materialize never even attempted", async () => {
  const { build, materializeCalls } = mkDeps({ runnerQueue: [] });
  const forge = mkForge({
    getPRDiff: async () => {
      throw new Error("network blip");
    },
  });
  const result = await build().evaluate(ctx({ forge }));
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /getPRDiff.*network blip/);
  assert.equal(materializeCalls.length, 0);
});

test("evaluate(): materialize failure -> unavailable, never spawns a session", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [], materialize: { kind: "failure", reason: "clone blew up" } });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.equal(runner.calls.length, 0); // runReviewSession itself short-circuits on a failed materialize
});

test("evaluate(): deps.materialize() THROWING (a caller-wrapper bug) is caught and mapped to unavailable, not an uncaught rejection", async () => {
  const { build, runner } = mkDeps({
    runnerQueue: [],
    materialize: async () => {
      throw new Error("wrapper bug");
    },
  });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.equal(runner.calls.length, 0);
});

test("evaluate(): spawn/setup failure (runner.run() throws) -> unavailable, no retry", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [{ throwMsg: "spawn failed: ENOENT" }] });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.equal(runner.calls.length, 1); // never retried — a setup failure isn't fixed by trying again
});

test("evaluate(): invalid/unparseable output on BOTH attempts -> unavailable after exactly one retry", async () => {
  const { build, runner } = mkDeps({
    runnerQueue: [
      mkSessionResult({ resultText: "not structured output at all", costUsd: 1 }),
      mkSessionResult({ resultText: "still garbage", costUsd: 1 }),
    ],
  });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /attempt 2 \(retry\) also produced no valid output/);
  assert.equal(runner.calls.length, 2);
});

test("evaluate(): a crashed/timed-out attempt 1 (outcome != done) also counts as a failed attempt and retries", async () => {
  const { build, runner } = mkDeps({
    runnerQueue: [
      mkSessionResult({ outcome: "timeout", costUsd: 0.5, resultText: "" }),
      mkSessionResult({ resultText: ALL_CONFIRMED, costUsd: 0.5 }),
    ],
  });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "approved");
  assert.equal(runner.calls.length, 2);
});

test("evaluate(): post-session model-separation re-check — the session's OWN modelUsage matches the worker's model -> unavailable, even with an otherwise-valid output (D5)", async () => {
  const { build, runner } = mkDeps({
    workerActualModels: [WORKER_MODEL],
    runnerQueue: [
      mkSessionResult({
        modelUsage: [{ model: WORKER_MODEL, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
        resultText: ALL_CONFIRMED,
      }),
    ],
  });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /D5/);
  assert.equal(runner.calls.length, 1); // a same-model verdict is never retried either
});

// ── evaluate(): cost-remainder arithmetic ───────────────────────────────────────────────────

test("cost-remainder: attempt 2's budget = costCapUsd - attempt 1's recorded cost", async () => {
  const { build, runner } = mkDeps({
    runnerQueue: [mkSessionResult({ resultText: "garbage", costUsd: 1 }), mkSessionResult({ resultText: ALL_CONFIRMED, costUsd: 0.4 })],
  });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "approved");
  assert.equal(runner.calls.length, 2);
  assert.equal(runner.calls[0]!.maxBudgetUsd, 3); // costCapUsd from mkCfg()
  assert.equal(runner.calls[1]!.maxBudgetUsd, 2); // 3 - 1
});

test("cost-remainder: remainder <= 0 (attempt 1 cost meets/exceeds the cap) -> NO retry, unavailable", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: "garbage", costUsd: 3 })] });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /exhausted its cost cap/);
  assert.equal(runner.calls.length, 1);
});

test("cost-remainder: attempt 1 cost STRICTLY exceeds the cap (over-budget report) -> still no retry (remainder negative)", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: "garbage", costUsd: 3.5 })] });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.equal(runner.calls.length, 1);
});

// ── evaluate(): success paths ────────────────────────────────────────────────────────────────

test("evaluate(): attempt 1 valid, all confirmed, zero findings -> approved directly, no retry", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })] });
  const result = await build().evaluate(ctx());
  const expected: ApprovalResult = {
    kind: "approved",
    headOid: "h".repeat(40),
    evidence: { freshApprovingReviews: 0, freshTrustedSignals: 0 },
  };
  assert.deepEqual(result, expected);
  assert.equal(runner.calls.length, 1);
});

test("evaluate(): a finding in the output -> rejected, findings passed through", async () => {
  const text = validResultText(
    MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    [{ id: "f1", body: "something is off" }],
  );
  const { build } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: text })] });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") throw new Error("unreachable");
  assert.deepEqual(result.findings, [{ id: "f1", body: "something is off" }]);
});

test("evaluate(): materialize is called with ctx.data.headOid, and getAcSnapshot with ctx.issue", async () => {
  const { build, materializeCalls, getAcSnapshotCalls } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })] });
  const headOid = "d".repeat(40);
  await build().evaluate(ctx({ data: mkData({ headOid }), issue: 99 }));
  assert.deepEqual(materializeCalls, [headOid]);
  assert.deepEqual(getAcSnapshotCalls, [99]);
});

test("evaluate(): the diff is threaded into the session prompt (fetched via ctx.forge.getPRDiff, never a live issue body)", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })] });
  const forge = mkForge({ getPRDiff: async () => "UNIQUE_DIFF_MARKER_12345" });
  await build().evaluate(ctx({ forge }));
  assert.match(runner.calls[0]!.prompt, /UNIQUE_DIFF_MARKER_12345/);
  assert.match(runner.calls[0]!.prompt, /first criterion/);
});

test("evaluate(): fallbackModel is 'none' — engine-agent never silently swaps models mid-session (D5)", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })] });
  await build().evaluate(ctx());
  assert.equal(runner.calls[0]!.fallbackModel, "none");
  assert.equal(runner.calls[0]!.model, AGENT_MODEL);
});
