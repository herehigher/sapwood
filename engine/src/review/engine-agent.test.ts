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

test("shipped engine-reviewer prompt (#319): forbids markdown fences around the sentinel block and any content after the end sentinel", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.match(prompt, /Emit the sentinel block as PLAIN TEXT: never wrap it in a markdown code fence\./);
  assert.match(prompt, /NOTHING — including[\s\S]*— may follow `<<<END_SAPWOOD_RESULT>>>`\./);
  assert.equal(prompt.match(/^<<<SAPWOOD_RESULT>>>[ \t]*$/gm)?.length, 1);
  assert.equal(prompt.match(/^<<<END_SAPWOOD_RESULT>>>[ \t]*$/gm)?.length, 1);
  assert.doesNotMatch(prompt, /^```[ \t]*\n<<<SAPWOOD_RESULT>>>/m);
  assert.doesNotMatch(prompt, /^<<<END_SAPWOOD_RESULT>>>[ \t]*\n```[ \t]*$/m);
});

test("shipped engine-reviewer prompt (#457, F36): pins the execution-class tiering rule — the engine is the execution authority, and the fail-closed carve-outs stay verbatim", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.match(prompt, /Execution-class criteria — the engine, not you, is the execution authority\./);
  assert.match(prompt, /can never be `confirmed` by a static\s+session, and that inability is NOT a gap in the PR\./);
  assert.match(prompt, /tier it\s+`claim-accepted` when the tree corroborates the claim/);
  // The fail-closed carve-outs: these three shapes stay cannot-confirm + finding.
  assert.match(
    prompt,
    /Reserve\s+`cannot-confirm` \(with its finding\) for what the PRODUCER can actually fix in this PR: a missing\s+or vacuous test, an execution claim with no CI coverage at all, or a diff that visibly\s+contradicts the criterion\./,
  );
});

test("shipped engine-reviewer prompt (#457, F36): pins the capability-limit rule — a session's own inability to execute is never itself a finding", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.match(prompt, /A capability limit of this review session[\s\S]*is never itself a finding\./);
  assert.match(prompt, /Every finding must name something the producer\s+\(or a human adjudicator\) can act on IN this PR's content\./);
});

// #454 (design #402 R6 §6a). These assertions pin the enforced/judged BOUNDARY itself, not the
// prose around it: every ENFORCED row named in the shipped prompt corresponds to a real check in
// this repo's source (traced per row in #454's PR body), and the JUDGED half is stated as
// unverifiable-by-the-engine so a prompt tuner knows which half they are editing. A future edit
// that moves a row across the boundary reds here — which is the point: the boundary is a claim
// about the code, and a claim about the code is testable even when the prose around it is not.
test("shipped engine-reviewer prompt (#454, design #402 R6 §6a): the enforced-vs-judged section names every engine-ENFORCED row", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.match(prompt, /## What the engine enforces vs\. what you judge/);
  for (const row of [
    // perAC id-set exactness — validateAgentReviewOutput's manifest-id loop (agent-output.ts).
    /exactly one `perAC` entry per acceptance-criterion id/,
    // ALLOWED_FINDING_KEYS + FINDING_KINDS closed enums (finding-axes.ts, agent-output.ts).
    /the finding key allowlist and the closed `severity`\/`kind` enums/,
    // effectiveSeverity + ADVISORY_ELIGIBLE_KINDS (finding-axes.ts).
    /`severity: "advisory"` is honored only for the allowlisted kinds/,
    // deriveApprovalResult's rejected branch (agent-output.ts).
    /a `rejected` verdict always carries a non-empty findings array/,
    // modelSeparationUnavailableReason: post-session modelUsage always runs (the binding check);
    // pre-session config comparison only when configuredReviewerIdentity() is non-null, i.e.
    // `runner: claude` — it returns null (skipped) for `runner: codex-exec` (engine-agent.ts:454-456,475).
    /model separation, checked against this session's own recorded model usage after it runs[\s\S]*statically derivable/,
    // resolveIdentity/hashDiff (drive.ts) + checkAcSnapshotDrift (ac-snapshot.ts).
    /head\/base\/diff identity, and snapshotted-body drift/,
    // RoleRunner.run()'s reviewCwd branch (peripheral.ts) — hardcoded, refuses an override — is
    // the only tool-profile claim made UNIVERSALLY; anything beyond "no writes" is runner-specific
    // (#512: the codex-exec runner's sandbox does not match the Claude runner's tool grant).
    /no writes, for every runner/,
  ]) {
    assert.match(prompt, row, `enforced row missing from the shipped prompt: ${row}`);
  }
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

test("shipped engine-reviewer prompt (#512): the enforced containment claim is runner-specific, not a single 'static-only' profile", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.match(prompt, /no writes, for every runner/);
  assert.match(prompt, /containment is runner-specific, not one shared "static" profile/);
  assert.match(prompt, /codex-exec runner's read-only sandbox blocks writes\s*\n\s*but not shell execution or host-wide file reads/);
  assert.match(prompt, /never claimed as an engine-enforced fence/);
});

test("shipped engine-reviewer prompt (#512): 'never execute / never reach the network' survives as an INSTRUCTION, not a claimed engine guarantee", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.match(prompt, /Never execute, never reach the network\./);
  assert.match(prompt, /never to run the producer's code, build\/install\/test it, or make\s*\n\s*any network call/);
  assert.match(
    prompt,
    /This is an INSTRUCTION, not a guarantee every runner mechanically enforces for\s*\n\s*you/,
    "the non-negotiable must not be phrased as an engine-enforced guarantee — it is an instruction to the session",
  );
});

// #512 (PM gate② round 2, P1-1, proven live): the first submitted round missed a FOURTH site — the
// opening identity paragraph — and it was the BINDING one. "never run a shell command" directly
// contradicted the "actually inspect the tree" instruction added at the materialized-tree bullet,
// and it sits in the most authoritative position in the whole prompt. A live three-arm rerun (same
// fixture, model, effort) showed the first round changed NOTHING observable (0 command_execution
// items, same as main); fixing this site (plus the model-identity and capability-limit sites below)
// produced 12 command_execution items and materially different findings. These three tests pin the
// live-proven fix so a future edit cannot silently reintroduce the contradiction.
test("shipped engine-reviewer prompt (#512, PM gate② round 2, P1-1): the opening identity paragraph no longer forbids a shell command, and states tree inspection is REQUIRED", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.doesNotMatch(
    prompt,
    /never execute the producer's code, never run a shell command, and/,
    "the opening paragraph must not tell the session it may never run a shell command — that is the codex-exec runner's only tree-inspection tool",
  );
  assert.match(
    prompt,
    /You are a STATIC reviewer: you never execute the producer's code, and you have no write access/,
    "the identity sentence keeps 'never execute the producer's code' and 'no write access' — both genuinely true for every runner",
  );
  assert.match(
    prompt,
    /You DO inspect the materialized tree read-only, with whatever means your session has\s*—?\s*\n?\s*that is REQUIRED, not optional/,
    "the opening paragraph must affirmatively require tree inspection, in the prompt's most authoritative position",
  );
});

test("shipped engine-reviewer prompt (#512, PM gate② round 2, P1-1): the model-identity claim is runner-neutral — not one more site claiming 'Claude'", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.doesNotMatch(
    prompt,
    /You are a different Claude model from/,
    "must not claim the reviewing session is a Claude model — false for codex-exec, and this is exactly the property #443's cross-vendor D5 model separation exists to provide",
  );
  assert.match(prompt, /You run on a different model from the one that produced this PR/);
});

test("shipped engine-reviewer prompt (#512, PM gate② round 2, P1-1): the capability-limit paragraph states 'must not execute/reach the network' as a PROHIBITION, and 'cannot read live GitHub state' as the one genuine inability", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.doesNotMatch(
    prompt,
    /you cannot execute code, reach the network, or read\s*\n\s*live GitHub state/,
    "must not phrase 'must not execute/reach the network' as an inability — for codex-exec it is a prohibition on a tool the session actually has",
  );
  assert.match(
    prompt,
    /you must not execute code or reach the network, and\s*\n\s*cannot read live GitHub state — is never itself a finding\./,
    "keeps the paragraph's actual point (a capability limit is never itself a finding) while separating the prohibition from the one genuine inability",
  );
});

test("shipped engine-reviewer prompt (#454, design #402 R6 §6a): the judged half is stated as unverifiable by the engine, row by row", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.match(
    prompt,
    /Nothing below is checked by the engine[\s\S]*no engine check will catch a bad\s+call/,
    "the judged half must say, in the prompt itself, that the engine cannot verify it",
  );
  for (const row of [
    /whether a named test is \*substantive\*/,
    /the evidence-tier choice itself/,
    /which `severity` and which `kind` a finding deserves/,
    /whether a finding is worth writing at all/,
    /the two finding classes named above/,
    /everything else in this prompt's prose/,
  ]) {
    assert.match(prompt, row, `judged row missing from the shipped prompt: ${row}`);
  }
});

test("shipped engine-reviewer prompt (#454, design #402 R6 §6b): the triage doctrine ships in full and does not contradict R1's axes wording", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  for (const rule of [
    /\*\*Triage before you write\.\*\*/,
    /\*\*Name the target\.\*\*/,
    /\*\*Name the class\.\*\*/,
    /\*\*Do not re-raise an adjudicated finding\.\*\*/,
    /\*\*Scope honestly\.\*\*/,
  ]) {
    assert.match(prompt, rule, `§6b doctrine rule missing: ${rule}`);
  }
  // R1's "Severity and kind" section is the single source of truth for what the engine does with
  // `severity`. §6a's boundary row must POINT AT it rather than restate the eligible-kind list a
  // second time — a second copy is exactly how the two wordings would drift into contradiction.
  const boundary = prompt.slice(prompt.indexOf("## What the engine enforces vs. what you judge"));
  assert.ok(boundary.length > 0, "the boundary section must exist");
  assert.match(boundary, /allowlisted kinds\*\* \("Severity and kind"\s+above\)/, "the advisory row defers to R1's section");
  assert.doesNotMatch(
    boundary,
    /"test-coverage"/,
    "§6a must not restate R1's advisory-eligible kind list — it cites the section that owns it",
  );
});

// #628 (owner ruling 2026-08-04): docs/security.md's evidence-origin tiers (A/B/C/D) reach gate②
// as two added constraints on top of the EXISTING, unchanged confirmed/cannot-confirm/
// claim-accepted mechanics (design #279 §4.1) and the #454 enforced/judged boundary — this test
// pins that the new rule is additive, not a rewrite of either.
test("shipped engine-reviewer prompt (#628): tier-D producer-pasted session artifacts never reach `confirmed` (at most `claim-accepted`), and a tier-C probe confirms only against the issue-recorded probe, never PR-body narration", () => {
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  assert.match(
    prompt,
    /Evidence-tier discipline \(docs\/security\.md's tiered doctrine\)/,
    "names the rule and cites docs/security.md as the tier home",
  );
  assert.match(
    prompt,
    /is tier D and never raises a criterion to `confirmed`, whatever it claims/,
    "tier D never yields confirmed, regardless of what the artifact claims",
  );
  assert.match(
    prompt,
    /at most it supports `claim-accepted` under the existing three-tier mechanics above/,
    "tier D still fits inside the existing three-tier mechanics — no new status was introduced",
  );
  assert.match(
    prompt,
    /may reach `confirmed` only against the probe RECORD on the issue itself/,
    "a tier-C claim confirms only against the recorded probe, not any other artifact",
  );
  assert.match(
    prompt,
    /never against PR-body narration describing what was\s+supposedly done, which is tier D regardless of how detailed it reads/,
    "PR-body narration of a probe is itself tier D, however detailed",
  );
  // Additive, not a rewrite: the existing three-tier vocabulary and the #454 boundary section
  // both still appear verbatim, unperturbed by the new paragraph.
  assert.match(prompt, /\*\*`confirmed`\*\* — the criterion is CODE-VERIFIABLE/);
  assert.match(prompt, /\*\*`cannot-confirm`\*\* — you looked and could NOT establish/);
  assert.match(prompt, /\*\*`claim-accepted`\*\* — the criterion is NOT code-verifiable at all/);
  assert.match(prompt, /## What the engine enforces vs\. what you judge/, "the #454 enforced/judged boundary section is untouched");
});

// #512: the runner-honesty rewrite touched three sites in the shipped prompt but must NOT touch
// REQUIRED_PROMPT_PLACEHOLDERS or drop a placeholder from the shipped file — loadEngineReviewerPromptTemplate(undefined)
// runs the SAME completeness check a custom promptFile gets (#74 fail-fast), so a regression here
// would throw. Every other test in this file already constructs a reviewer against the shipped
// default and would also throw on a missing placeholder; this test names the contract directly.
test("loadEngineReviewerPromptTemplate: the shipped default prompt (post-#512 edit) still satisfies every REQUIRED_PROMPT_PLACEHOLDERS entry", () => {
  assert.doesNotThrow(() => loadEngineReviewerPromptTemplate(undefined));
  const prompt = readFileSync(defaultEngineReviewerPromptPath(), "utf8");
  for (const placeholder of ["{{diff}}", "{{issue-body}}", "{{acceptance-criteria}}", "{{doctrine}}"]) {
    assert.ok(prompt.includes(placeholder), `shipped prompt missing required placeholder ${placeholder}`);
  }
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
