// engine-agent.test.ts (#286, E4a, design #279) — EngineAgentReviewer's evaluate()/trigger()
// against FAKE deps (materializer fn, RoleRunner-shaped runner, AC-snapshot/model-lookup
// functions) — no real subprocess, no real filesystem materialization. Every failure path maps
// to `unavailable`; every setup/model-separation check fires before a session is even spawned
// where possible; cost-remainder arithmetic and the retry-once contract are pinned directly.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseConfig } from "../config/config.js";
import type { IForge, PRReviewData } from "../forge/forge.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import type { ApprovalResult, ReviewContext } from "../roles/reviewer.js";
import { parseStructuredBlock, RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import type { AcSnapshot } from "./ac-snapshot.js";
import type { EngineReviewArtifact } from "./audit.js";
import {
  defaultEngineReviewerPromptPath,
  type EngineAgentReviewer,
  loadEngineReviewerPromptTemplate,
  makeEngineAgentReviewer,
} from "./engine-agent.js";
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

/** #303 review round 2 (P1): `getPRDiff` must NEVER be called by `EngineAgentReviewer.evaluate`
 *  anymore (the diff is caller-supplied via `ctx.diffText`) — `getPRDiffCalls` is a PER-FORGE-
 *  INSTANCE counter (never module-level/shared) so each test's assertion is independent of test
 *  ordering; still present on the fake so a call site that mistakenly reaches for it fails LOUDLY
 *  (returns a value, recorded) rather than throwing a "not a function" TypeError that could mask
 *  which assertion actually caught the regression. */
function mkForge(overrides: Partial<IForge> = {}): IForge & { getPRDiffCalls: number[] } {
  const getPRDiffCalls: number[] = [];
  return {
    getPRDiffCalls,
    getPRDiff: async (pr: number) => {
      getPRDiffCalls.push(pr);
      return "diff --git a/x b/x\n+added line\n";
    },
    ...overrides,
  } as unknown as IForge & { getPRDiffCalls: number[] };
}

/** A resultText carrying a valid sentinel-wrapped structured block for MANIFEST. */
function validResultText(
  perAC: { id: string; status: string }[],
  findings: { id: string; body: string; severity?: string; kind?: string; path?: string }[] = [],
): string {
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
  /** #472 fix round: every `onReviewArtifact` invocation, in call order — the production-path
   *  assertion surface for "the persisted artifact carries what the fix round requires" (path
   *  retention + advisories on both branches), distinct from `evaluate()`'s own return value. */
  artifactCalls: { headOid: string; artifact: EngineReviewArtifact }[];
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
  const artifactCalls: { headOid: string; artifact: EngineReviewArtifact }[] = [];
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
    artifactCalls,
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
        onReviewArtifact: (headOid, artifact) => {
          artifactCalls.push({ headOid, artifact });
        },
      }),
  };
}

// #303 review round 2 (P1): every test's default ctx() now carries `diffText` — the
// engine-supplied diff `EngineAgentReviewer.evaluate` reads instead of calling `ctx.forge.getPRDiff`.
const DEFAULT_DIFF_TEXT = "diff --git a/x b/x\n+added line\n";

// `| undefined` on each key (not plain Partial): under exactOptionalPropertyTypes a fixture must
// be able to pass an EXPLICIT undefined (the "ctx.diffText missing" case below).
function ctx(overrides: { [K in keyof ReviewContext]?: ReviewContext[K] | undefined } = {}): ReviewContext {
  // Cast: the spread of an all-optional override map widens every field to `| undefined`, which
  // is exactly the shape this suite injects and ReviewContext deliberately forbids.
  return { forge: mkForge(), pr: 5, issue: 42, data: mkData(), diffText: DEFAULT_DIFF_TEXT, ...overrides } as ReviewContext;
}

// ── Construction ─────────────────────────────────────────────────────────────────────────────

test("makeEngineAgentReviewer: kind is 'engine-agent'", () => {
  const { build } = mkDeps({ runnerQueue: [] });
  assert.equal(build().kind, "engine-agent");
});

test("EngineAgentReviewer construction throws when cfg.reviewer.agent is not set (defense-in-depth against a hand-built config)", () => {
  // #501: a real parse now ALWAYS default-injects reviewer.agent once mode resolves to
  // engine-agent (zero-config included), so this defense-in-depth check — which exists for a
  // HAND-BUILT config that bypasses the schema's own guarantee, never a config `parseConfig`
  // itself could produce — has to strip the field back out after parsing to still exercise it.
  const cfgWithAgent = parseConfig("board: { owner: a, repo: r, projectNumber: 1 }\nreviewer: { mode: engine-agent }");
  assert.ok(cfgWithAgent.reviewer.agent); // sanity: #501's injection did fire
  const cfgNoAgent = { ...cfgWithAgent, reviewer: { ...cfgWithAgent.reviewer, agent: undefined } };
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

test("evaluate(): ctx.diffText missing -> unavailable, materialize never even attempted, getPRDiff never called (#303 review round 2 P1 — the adapter never fetches its own diff)", async () => {
  const { build, materializeCalls } = mkDeps({ runnerQueue: [] });
  const forge = mkForge();
  const result = await build().evaluate(ctx({ forge, diffText: undefined }));
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /diffText/);
  assert.equal(materializeCalls.length, 0);
  assert.deepEqual(forge.getPRDiffCalls, [], "the adapter must never call getPRDiff itself");
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

test("cost-cap fail-closed (#302 review Codex P1): a timed-out attempt 1 with NO cost record (costKnown: false, costUsd 0) gets NO retry -> unavailable, never a second full cap", async () => {
  const { build, runner } = mkDeps({
    // Only ONE queued result — a retry attempt would exhaust the queue and fail differently;
    // the assertion on runner.calls.length pins that no second session was ever spawned.
    runnerQueue: [mkSessionResult({ outcome: "timeout", costUsd: 0, costKnown: false, resultText: "" })],
  });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /NO recorded cost/i);
  assert.equal(runner.calls.length, 1);
});

test("cost-cap: an explicit costKnown: true with a REAL $0 cost still retries (the honest-zero case, distinct from unknown)", async () => {
  const { build, runner } = mkDeps({
    runnerQueue: [
      mkSessionResult({ outcome: "failed", costUsd: 0, costKnown: true, resultText: "" }),
      mkSessionResult({ resultText: ALL_CONFIRMED, costUsd: 0.5, costKnown: true }),
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

test("post-session D5 (#302 review Codex P1): a session whose ONLY recorded model is the literal 'unknown' sentinel -> unavailable, even with a valid all-confirmed output (unidentifiable model must never gate)", async () => {
  const { build, runner } = mkDeps({
    workerActualModels: [WORKER_MODEL],
    runnerQueue: [
      mkSessionResult({
        // parseModelUsage's no-identity sentinel — filtered on the reviewer side before the
        // comparison, leaving an EMPTY reviewer list ⇒ the existing empty ⇒ unavailable branch.
        modelUsage: [{ model: "unknown", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
        resultText: ALL_CONFIRMED,
      }),
    ],
  });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /reviewer's own actual model is unknown/);
  assert.equal(runner.calls.length, 1);
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

// ── #513: onReviewArtifact accumulates every executed attempt's spend, fires exactly once ──────

test("#513 retry path: two EXECUTED attempts persist two sessionSpends entries (in order), decisive-only identities, onReviewArtifact fires exactly once", async () => {
  // #513 gate② round 2 (P3-A): attempt 1 and attempt 2 report DISTINCT identities (both still
  // distinguishable from the worker's WORKER_MODEL, so D5 passes on both) — with the old test,
  // both attempts happened to report the SAME default AGENT_MODEL identity, so an implementation
  // that wrongly accumulated identities across attempts (instead of scoping to the decisive one)
  // would have deduped down to the identical asserted single-entry array and passed anyway. Only
  // a genuinely DIFFERENT attempt-1 identity makes the "decisive-only" assertion below load-bearing.
  const ATTEMPT_1_MODEL = "opus-legacy-attempt-1-only";
  const { build, artifactCalls } = mkDeps({
    runnerQueue: [
      mkSessionResult({
        resultText: "garbage — attempt 1 produced nothing usable",
        costUsd: 1,
        costKnown: true,
        modelUsage: [{ model: ATTEMPT_1_MODEL, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
      }),
      mkSessionResult({ resultText: ALL_CONFIRMED, costUsd: 0.4, costKnown: true }), // default identity: AGENT_MODEL
    ],
  });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "approved");
  assert.equal(artifactCalls.length, 1, "onReviewArtifact must fire exactly once, on the verdict-producing attempt");
  const { sessionSpends, sessionActualIdentities } = artifactCalls[0]!.artifact;
  assert.deepEqual(sessionSpends, [
    { kind: "known", usd: 1 },
    { kind: "known", usd: 0.4 },
  ]);
  // Identities are scoped to the DECISIVE attempt (attempt 2, AGENT_MODEL) only — attempt 1's own
  // DIFFERENT (failed) session identity (ATTEMPT_1_MODEL) is never folded in, even though its
  // spend is.
  assert.deepEqual(sessionActualIdentities, [{ provider: "anthropic", model: AGENT_MODEL }]);
});

test("#513: an unknown-cost attempt's spend is recorded too, when it's the ONLY (decisive) attempt", async () => {
  const { build, artifactCalls } = mkDeps({
    runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED, costUsd: 0, costKnown: false })],
  });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "approved");
  assert.equal(artifactCalls.length, 1);
  assert.deepEqual(artifactCalls[0]!.artifact.sessionSpends, [{ kind: "unknown" }]);
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

test("evaluate(): the diff reaching the session prompt is BYTE-IDENTICAL to ctx.diffText (the drive-supplied text), and getPRDiff is NEVER called by the adapter (#303 review round 2 P1)", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })] });
  const forge = mkForge();
  const diffText = "UNIQUE_DIFF_MARKER_12345 — byte-for-byte, the exact drive-supplied text";
  await build().evaluate(ctx({ forge, diffText }));
  // Byte-identical: the prompt's diff block, extracted, equals diffText exactly — not merely
  // "contains a substring of it" (a looser match could hide truncation/re-encoding bugs).
  const promptDiffMatch = runner.calls[0]!.prompt.match(/<diff>\n([\s\S]*?)\n<\/diff>/);
  assert.ok(promptDiffMatch, "expected the prompt to carry a <diff>...</diff> block");
  assert.equal(promptDiffMatch![1], diffText);
  assert.match(runner.calls[0]!.prompt, /first criterion/);
  assert.deepEqual(forge.getPRDiffCalls, [], "the adapter must never fetch its own diff — the diff is caller-supplied");
});

test("evaluate(): the SNAPSHOTTED issue body reaches the session prompt inside <issue-body> tags (#302 review P1 — issue #286's What: diff + snapshotted body + AC ids + doctrine; design #279 §5)", async () => {
  const { build, runner } = mkDeps({
    runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })],
    // A body with a verification plan — the reviewer-relevant input the full-body snapshot
    // exists to protect; distinct marker text so the assertion can only match via snapshot.body.
    snapshot: { ...SNAPSHOT, body: "## Why\nstuff\n\n## Verification plan\nUNIQUE_BODY_MARKER_67890" },
  });
  await build().evaluate(ctx());
  const prompt = runner.calls[0]!.prompt;
  assert.match(prompt, /<issue-body>[\s\S]*UNIQUE_BODY_MARKER_67890[\s\S]*<\/issue-body>/);
  // The template renders fully — no {{issue-body}} (or any other) placeholder may survive into
  // a live session prompt (renderEngineReviewerPrompt's own fail-closed contract).
  assert.doesNotMatch(prompt, /\{\{[a-zA-Z0-9._-]+\}\}/);
});

// ── prompt template: placeholder completeness + whitespace tolerance (#302 review Codex P1) ──

test("shipped engine-reviewer prompt (#319, #963): every example sentinel block is plain text (no adjacent markdown fence), balanced, and accepted by the REAL structured-output parser — no test-local expected count", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");

  const startLine = new RegExp(`^${RESULT_BLOCK_START}[ \\t]*$`, "gm");
  const endLine = new RegExp(`^${RESULT_BLOCK_END}[ \\t]*$`, "gm");
  const starts = prompt.match(startLine)?.length ?? 0;
  const ends = prompt.match(endLine)?.length ?? 0;
  assert.ok(starts > 0, "must ship at least one example sentinel block");
  assert.equal(starts, ends, "every start sentinel must have a matching end sentinel");
  assert.doesNotMatch(prompt, new RegExp(`^\`\`\`[ \\t]*\\n${RESULT_BLOCK_START}`, "m"));
  assert.doesNotMatch(prompt, new RegExp(`^${RESULT_BLOCK_END}[ \\t]*\\n\`\`\`[ \\t]*$`, "m"));

  // Real-parser mutation kill: the example span must be something the REAL parser accepts.
  const s = prompt.indexOf(RESULT_BLOCK_START);
  const e = prompt.indexOf(RESULT_BLOCK_END, s);
  assert.ok(e !== -1, "a RESULT_BLOCK_START example has no matching end sentinel");
  assert.ok(
    parseStructuredBlock(prompt.slice(s, e + RESULT_BLOCK_END.length)) !== null,
    "example sentinel block is not accepted by the real parser",
  );
});

// #512 (design adjudication 2026-08-01): the shipped prompt named a Claude-only tool surface in
// three places, which suppressed codex-exec sessions' only tool (a shell) — pin the ABSENCE of the
// contradictory wording, on the file as shipped, via the same loading path.
test("shipped engine-reviewer prompt (#512): does not claim the session has Read/Grep/Glob or forbid Bash — those are Claude-only tool names, false for the codex-exec runner", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  // The materialized-tree bullet ("What you are reviewing") used to open with the Claude-only tool
  // list; it must now name the CAPABILITY (grounding via inspection), not tool names. The Claude
  // tool grant still appears LATER, legitimately, describing that ONE runner's actual hardcoded
  // profile (see the next test) — so this assertion targets the old bullet's own unique wording,
  // not the substring, which the new enforced-list bullet correctly reuses in a runner-scoped way.
  assert.doesNotMatch(
    prompt,
    /your read-only working directory \(`Read`\/`Grep`\/`Glob`/,
    "must not assert the materialized-tree bullet's old Claude-only tool list",
  );
  assert.doesNotMatch(
    prompt,
    /no write tools of any kind\) is a private checkout/,
    "the old parenthetical tool-list phrasing must be gone",
  );
  assert.doesNotMatch(
    prompt,
    /the static-only tool profile.*—.*`Read`\/`Grep`\/`Glob`, no `Bash`, no writes, no forge access\.\s*\n\s*Hardcoded for review sessions/,
    "must not claim the old blanket static-only tool profile as engine-enforced for every runner",
  );
  assert.doesNotMatch(
    prompt,
    /you have none of these\s*\n\s*tools; do not attempt to reach for them\./,
    "must not tell the session it has no tools at all — false for codex-exec, which has a shell",
  );
});

// #512 (PM gate② round 2, P1-1, proven live): the first submitted round missed a FOURTH site — the
// opening identity paragraph — and it was the BINDING one. "never run a shell command" directly
// contradicted the "actually inspect the tree" instruction added at the materialized-tree bullet.
// A live three-arm rerun (same fixture, model, effort) showed the first round changed NOTHING
// observable; fixing this site (plus the model-identity and capability-limit sites below)
// produced materially different findings. These negatives pin the live-proven fix so the
// contradictory phrasing cannot silently return.
test("shipped engine-reviewer prompt (#512, PM gate② round 2, P1-1): never reintroduces the retired shell-forbidding opening paragraph, the Claude-only model-identity claim, or the inability-framed capability-limit paragraph", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.doesNotMatch(
    prompt,
    /never execute the producer's code, never run a shell command, and/,
    "the opening paragraph must not tell the session it may never run a shell command — that is the codex-exec runner's only tree-inspection tool",
  );
  assert.doesNotMatch(
    prompt,
    /You are a different Claude model from/,
    "must not claim the reviewing session is a Claude model — false for codex-exec, and this is exactly the property #443's cross-vendor D5 model separation exists to provide",
  );
  assert.doesNotMatch(
    prompt,
    /you cannot execute code, reach the network, or read\s*\n\s*live GitHub state/,
    "must not phrase 'must not execute/reach the network' as an inability — for codex-exec it is a prohibition on a tool the session actually has",
  );
});

// R1's "Severity and kind" section is the single source of truth for what the engine does with
// `severity`. §6a's boundary row must POINT AT it rather than restate the eligible-kind list a
// second time — a second copy is exactly how the two wordings would drift into contradiction.
test("shipped engine-reviewer prompt (#454, design #402 R6 §6b): the enforced/judged boundary section never restates R1's advisory-eligible kind list", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  const boundary = prompt.slice(prompt.indexOf("## What the engine enforces vs. what you judge"));
  assert.ok(boundary.length > 0, "the boundary section must exist");
  assert.doesNotMatch(
    boundary,
    /"test-coverage"/,
    "§6a must not restate R1's advisory-eligible kind list — it cites the section that owns it",
  );
});

// #512: the runner-honesty rewrite touched several sites in the shipped prompt but must NOT drop
// a placeholder from the shipped file — loadEngineReviewerPromptTemplate(undefined) runs the REAL
// completeness check against the REAL REQUIRED_PROMPT_PLACEHOLDERS registry (#74 fail-fast); a
// dropped placeholder throws here, so this is cross-artifact against production code, not a
// hand-copied literal list.
test("loadEngineReviewerPromptTemplate: the shipped default prompt still satisfies every REQUIRED_PROMPT_PLACEHOLDERS entry (real registry, real loader)", () => {
  assert.doesNotThrow(() => loadEngineReviewerPromptTemplate(undefined));
});

test("#963: evaluate() renders the REAL shipped engine-reviewer.md with a distinctive {{lang.issuesAndPrs}} value reaching the dispatched prompt (drops the reference -> reddens)", async () => {
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      `worker: { model: ${WORKER_MODEL} }\n` +
      `reviewer: { mode: engine-agent, agent: { model: ${AGENT_MODEL}, costCapUsd: 3, effort: high } }\n` +
      "language: { issuesAndPrs: zz-ZZ }\n",
  );
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })], cfg });
  await build().evaluate(ctx());
  assert.ok(runner.calls[0]!.prompt.includes("zz-ZZ"), "the distinctive language value must reach the rendered shipped prompt");
});

test("loadEngineReviewerPromptTemplate: a custom template MISSING a required placeholder throws at load, naming the missing one (#74 fail-fast)", () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-agent-template-"));
  const file = join(dir, "no-diff.md");
  // issue-body / acceptance-criteria / doctrine present; {{diff}} missing.
  writeFileSync(file, "review this\n{{issue-body}}\n{{acceptance-criteria}}\n{{doctrine}}\n");
  assert.throws(() => loadEngineReviewerPromptTemplate(file), /missing required placeholder\(s\): \{\{diff\}\}/);
});

test("loadEngineReviewerPromptTemplate: whitespace placeholder forms ({{ issue-body }}) count as present, and construction over such a template succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-agent-template-"));
  const file = join(dir, "whitespace.md");
  writeFileSync(file, "{{ diff }}\n{{ issue-body }}\n{{ acceptance-criteria }}\n{{ doctrine }}\n");
  assert.doesNotThrow(() => loadEngineReviewerPromptTemplate(file));
});

test("evaluate(): a custom template using WHITESPACE placeholder forms renders fully — variables substituted, no {{...}} survives (#302 review Codex P1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-agent-template-"));
  const file = join(dir, "whitespace-render.md");
  writeFileSync(file, "diff:\n{{ diff }}\nbody:\n{{ issue-body }}\nac:\n{{ acceptance-criteria }}\ndoctrine:\n{{ doctrine }}\n");
  const cfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      `worker: { model: ${WORKER_MODEL} }\n` +
      `reviewer: { mode: engine-agent, agent: { model: ${AGENT_MODEL}, promptFile: "${file}" } }\n`,
  );
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })], cfg });
  await build().evaluate(ctx());
  const prompt = runner.calls[0]!.prompt;
  assert.match(prompt, /the snapshotted issue body/); // SNAPSHOT.body substituted through {{ issue-body }}
  assert.match(prompt, /first criterion/);
  assert.doesNotMatch(prompt, /\{\{\s*[a-zA-Z0-9._-]+\s*\}\}/);
});

test("#701: evaluate() renders {{lang.issuesAndPrs}} from cfg.language.issuesAndPrs — defaults to 'en', follows an override, and is optional (not one of REQUIRED_PROMPT_PLACEHOLDERS)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engine-agent-template-"));
  const file = join(dir, "lang-render.md");
  writeFileSync(file, "diff:{{diff}} body:{{issue-body}} ac:{{acceptance-criteria}} doctrine:{{doctrine}} lang:{{lang.issuesAndPrs}}");

  const defaultCfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      `worker: { model: ${WORKER_MODEL} }\n` +
      `reviewer: { mode: engine-agent, agent: { model: ${AGENT_MODEL}, promptFile: "${file}" } }\n`,
  );
  const { build: buildDefault, runner: runnerDefault } = mkDeps({
    runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })],
    cfg: defaultCfg,
  });
  await buildDefault().evaluate(ctx());
  assert.match(runnerDefault.calls[0]!.prompt, /lang:en/);

  const jaCfg = parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      `worker: { model: ${WORKER_MODEL} }\n` +
      `reviewer: { mode: engine-agent, agent: { model: ${AGENT_MODEL}, promptFile: "${file}" } }\n` +
      "language: { issuesAndPrs: ja }\n",
  );
  const { build: buildJa, runner: runnerJa } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })], cfg: jaCfg });
  await buildJa().evaluate(ctx());
  assert.match(runnerJa.calls[0]!.prompt, /lang:ja/);

  // A template that never references {{lang.issuesAndPrs}} still loads — it's not a mandatory
  // placeholder (loadEngineReviewerPromptTemplate's REQUIRED_PROMPT_PLACEHOLDERS is unchanged).
  const noLangFile = join(dir, "no-lang.md");
  writeFileSync(noLangFile, "{{diff}}\n{{issue-body}}\n{{acceptance-criteria}}\n{{doctrine}}\n");
  assert.doesNotThrow(() => loadEngineReviewerPromptTemplate(noLangFile));
});

test("evaluate(): fallbackModel is 'none' — engine-agent never silently swaps models mid-session (D5)", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })] });
  await build().evaluate(ctx());
  assert.equal(runner.calls[0]!.fallbackModel, "none");
  assert.equal(runner.calls[0]!.model, AGENT_MODEL);
});

// ── #472 fix round (gate② P1): production wiring — changed-path threading + artifact advisories ──
// Both items were previously true ONLY inside finding-axes.ts/agent-output.ts's own unit tests;
// this section proves each through the REAL evaluate() -> attempt() -> onReviewArtifact pipeline,
// per the verification plan's item 10 (engine-agent.test.ts/production.test.ts).

const IN_DIFF_PATH = "src/foo.ts";
const DIFF_TOUCHING_FOO = `diff --git a/${IN_DIFF_PATH} b/${IN_DIFF_PATH}\nindex 1111111..2222222 100644\n--- a/${IN_DIFF_PATH}\n+++ b/${IN_DIFF_PATH}\n@@ -1,1 +1,1 @@\n-old\n+new\n`;

test("evaluate() [#472 P1 item 1]: a finding's path GENUINELY IN the reviewed diff is RETAINED end to end into the persisted artifact (resolveFindingPath's retention branch is live in production)", async () => {
  const text = validResultText(
    MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    [{ id: "f1", body: "a real defect", path: IN_DIFF_PATH }],
  );
  const { build, artifactCalls } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: text })] });
  const result = await build().evaluate(ctx({ diffText: DIFF_TOUCHING_FOO }));
  assert.equal(result.kind, "rejected"); // absent severity -> blocking, unchanged
  assert.equal(artifactCalls.length, 1);
  const finding = artifactCalls[0]!.artifact.findings.find((f) => f.id === "f1");
  assert.ok(finding, "expected the persisted artifact to carry finding f1");
  assert.equal(finding!.path, IN_DIFF_PATH); // KEPT — this diff genuinely touches it
  assert.equal(finding!.pathDropped, undefined); // never marked dropped when it wasn't
});

test("evaluate() [#472 P1 item 1]: a finding's path NOT in the reviewed diff is dropped, pathDropped now means what it says (regression pin for the pre-fix 'every path drops unconditionally' bug)", async () => {
  const text = validResultText(
    MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    [{ id: "f1", body: "a real defect", path: "src/somewhere-else.ts" }],
  );
  const { build, artifactCalls } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: text })] });
  await build().evaluate(ctx({ diffText: DIFF_TOUCHING_FOO }));
  const finding = artifactCalls[0]!.artifact.findings.find((f) => f.id === "f1");
  assert.ok(finding);
  assert.equal(finding!.path, undefined);
  assert.equal(finding!.pathDropped, true); // a REAL check happened — the diff just didn't touch it
});

test("evaluate() [#472 P1 item 2]: an APPROVED verdict's persisted artifact still carries its advisory finding(s) — the audit trail no longer requires rejection to record advisories", async () => {
  const text = validResultText(
    MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    [{ id: "f1", body: "trivial style nit", severity: "advisory", kind: "style" }],
  );
  const { build, artifactCalls } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: text })] });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "approved"); // gate semantics unchanged — advisory-only still approves
  assert.equal(artifactCalls.length, 1);
  assert.deepEqual(
    artifactCalls[0]!.artifact.findings.map((f) => f.id),
    ["f1"],
  );
  assert.equal(artifactCalls[0]!.artifact.findings[0]!.severity, "advisory");
});

test("evaluate() [#472 P1 item 2]: a REJECTED verdict's persisted artifact carries BOTH the blocking and the advisory finding, while the GATE result (result.findings) stays blocking-only per design §1", async () => {
  const text = validResultText(
    MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    [
      { id: "f-block", body: "a real defect" },
      { id: "f-adv", body: "trivial style nit", severity: "advisory", kind: "style" },
    ],
  );
  const { build, artifactCalls } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: text })] });
  const result = await build().evaluate(ctx());
  assert.equal(result.kind, "rejected");
  if (result.kind !== "rejected") throw new Error("unreachable");
  // Gate semantics unchanged: rejected.findings is blocking-only — the advisory never reaches it.
  assert.deepEqual(
    result.findings.map((f) => f.id),
    ["f-block"],
  );
  // The persisted artifact, independently, carries BOTH.
  assert.deepEqual(artifactCalls[0]!.artifact.findings.map((f) => f.id).sort(), ["f-adv", "f-block"]);
  const advisory = artifactCalls[0]!.artifact.findings.find((f) => f.id === "f-adv");
  assert.equal(advisory!.severity, "advisory");
});
