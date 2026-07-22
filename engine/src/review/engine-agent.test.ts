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

// #303 review round 2 (P1): every test's default ctx() now carries `diffText` — the
// engine-supplied diff `EngineAgentReviewer.evaluate` reads instead of calling `ctx.forge.getPRDiff`.
const DEFAULT_DIFF_TEXT = "diff --git a/x b/x\n+added line\n";

function ctx(overrides: Partial<ReviewContext> = {}): ReviewContext {
  return { forge: mkForge(), pr: 5, issue: 42, data: mkData(), diffText: DEFAULT_DIFF_TEXT, ...overrides };
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
  assert.doesNotMatch(prompt, /^```[ \t]*\n<<<SAPWOOD_RESULT>>>/m);
  assert.doesNotMatch(prompt, /^<<<END_SAPWOOD_RESULT>>>[ \t]*\n```[ \t]*$/m);
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

test("evaluate(): fallbackModel is 'none' — engine-agent never silently swaps models mid-session (D5)", async () => {
  const { build, runner } = mkDeps({ runnerQueue: [mkSessionResult({ resultText: ALL_CONFIRMED })] });
  await build().evaluate(ctx());
  assert.equal(runner.calls[0]!.fallbackModel, "none");
  assert.equal(runner.calls[0]!.model, AGENT_MODEL);
});
