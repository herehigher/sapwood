// executor-seam.test.ts (#443, design adjudication 2026-08-01) — the CROSS-RUNNER properties of
// the reviewer-local executor seam, i.e. everything that must hold for BOTH `reviewer.agent.runner`
// values and would otherwise only be checked for one of them:
//   1. executor selection (dispatch), including its fail-closed refusals;
//   2. ONE parsing path — the same session output through either executor produces an identical
//      verdict and an identical `Finding[]`;
//   3. a prose-only/malformed codex output can never block and can never approve;
//   4. the D5 (provider, model) runtime matrix, incl. unidentifiable ⇒ unavailable;
//   5. the default path is byte-for-byte the pre-seam one (regression pin);
//   6. the three honest-recording event kinds are REGISTERED in the copy map that owns the
//      engine's event-kind inventory (docs/reference/frontend-design.md §7 — "every engine PR that adds an
//      event kind must extend this map").
// Fake executors/runners only: no subprocess, no timers (engine/prompts/doctrine-core.md's
// no-timing-dependent-assertions rule).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseConfig, type SapwoodConfig } from "../config/config.js";
import type { IForge, PRReviewData } from "../forge/forge.js";
import type { RoleSessionResult } from "../roles/peripheral.js";
import type { ApprovalResult, ReviewContext } from "../roles/reviewer.js";
import type { AcSnapshot } from "./ac-snapshot.js";
import type { EngineReviewArtifact } from "./audit.js";
import {
  ENGINE_REVIEW_BUDGET_ADVISORY,
  ENGINE_REVIEW_CONTAINMENT_GAP,
  ENGINE_REVIEW_COST_UNKNOWN,
  ENGINE_REVIEW_ORPHANED_GROUP,
} from "./codex-exec.js";
import { makeEngineAgentReviewer, resolveReviewSessionExecutor } from "./engine-agent.js";
import type { MaterializeResult } from "./materializer.js";
import type { ReviewSessionEvidence, ReviewSessionExecutor, ReviewSessionRequest } from "./review-session.js";

const WORKER_MODEL = "sonnet";
const CLAUDE_REVIEWER_MODEL = "opus";
const CODEX_REVIEWER_MODEL = "gpt-5.4-codex";

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

const MATERIALIZED: MaterializeResult = { kind: "materialized", treeDir: "/tmp/executor-seam-test", oid: "h".repeat(40), manifest: [] };
const DIFF_TEXT = "diff --git a/x b/x\n+added line\n";

function claudeCfg(): SapwoodConfig {
  return parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      `worker: { model: ${WORKER_MODEL} }\n` +
      `reviewer: { mode: engine-agent, agent: { model: ${CLAUDE_REVIEWER_MODEL} } }\n`,
  );
}

function codexCfg(): SapwoodConfig {
  return parseConfig(
    "board: { owner: a, repo: r, projectNumber: 1 }\n" +
      `worker: { model: ${WORKER_MODEL} }\n` +
      `reviewer: { mode: engine-agent, agent: { model: ${CODEX_REVIEWER_MODEL}, runner: codex-exec } }\n`,
  );
}

/** One session output, used verbatim on BOTH sides of the identity test below. */
function resultTextFor(findings: { id: string; body: string }[], statuses = ["confirmed", "confirmed"]): string {
  const perAC = MANIFEST.map((a, i) => ({ id: a.id, status: statuses[i] }));
  return `preamble prose\n\n<<<SAPWOOD_RESULT>>>\n${JSON.stringify({ perAC, findings })}\n<<<END_SAPWOOD_RESULT>>>`;
}

function mkForge(): IForge {
  return { getPRDiff: async () => DIFF_TEXT } as unknown as IForge;
}

function mkData(): PRReviewData {
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
  };
}

function ctx(): ReviewContext {
  return { forge: mkForge(), pr: 5, issue: 42, data: mkData(), diffText: DIFF_TEXT } as ReviewContext;
}

/** A `Pick<RoleRunner, "run">` fake — what the DEFAULT (claude) path wraps. */
function fakeRoleRunner(result: Partial<RoleSessionResult>): { run: () => Promise<RoleSessionResult> } {
  return {
    run: async () => ({
      outcome: "done",
      costUsd: 1,
      costKnown: true,
      modelUsage: [{ model: CLAUDE_REVIEWER_MODEL, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
      exitCode: 0,
      name: "role-engine-reviewer-test",
      ...result,
    }),
  };
}

/** A fake codex-exec executor: returns evidence directly, so these tests exercise the SEAM and the
 *  engine-side consumption of it, not codex-exec.ts's spawn machinery (covered in its own suite). */
function fakeCodexExecutor(evidence: Partial<ReviewSessionEvidence>): ReviewSessionExecutor & { calls: ReviewSessionRequest[] } {
  const calls: ReviewSessionRequest[] = [];
  return {
    calls,
    runner: "codex-exec" as const,
    execute: async (req: ReviewSessionRequest) => {
      calls.push(req);
      return {
        outcome: "done" as const,
        resultText: "",
        identity: [{ provider: "openai", model: CODEX_REVIEWER_MODEL }],
        spend: { kind: "estimated" as const, usd: 0.5 },
        sessionId: "thread-1",
        ...evidence,
      };
    },
  };
}

interface BuiltReviewer {
  evaluate: () => Promise<ApprovalResult>;
  artifacts: { headOid: string; artifact: EngineReviewArtifact }[];
}

function build(opts: {
  cfg: SapwoodConfig;
  runner?: { run: () => Promise<RoleSessionResult> };
  executor?: ReviewSessionExecutor;
  workerActualModels?: string[];
}): BuiltReviewer {
  const artifacts: { headOid: string; artifact: EngineReviewArtifact }[] = [];
  const reviewer = makeEngineAgentReviewer({
    materialize: async () => MATERIALIZED,
    runner: opts.runner ?? fakeRoleRunner({}),
    ...(opts.executor ? { executor: opts.executor } : {}),
    getAcSnapshot: () => SNAPSHOT,
    getWorkerActualModels: () => opts.workerActualModels ?? [WORKER_MODEL],
    cfg: opts.cfg,
    // #1123 (PR-2): doctrine is a REQUIRED deps field now (the framework core is always present
    // in the composed text).
    doctrine: "fixture doctrine text",
    now: () => new Date("2026-07-22T00:00:00Z"),
    onReviewArtifact: (headOid, artifact) => artifacts.push({ headOid, artifact }),
  });
  return { evaluate: () => reviewer.evaluate(ctx()), artifacts };
}

// ── 1. dispatch ──────────────────────────────────────────────────────────────────────────────

test("dispatch: the default runner needs no supplied executor — it resolves to the Claude seam over deps.runner", () => {
  const executor = resolveReviewSessionExecutor("claude", { runner: fakeRoleRunner({}) });
  assert.equal(executor.runner, "claude");
});

test("dispatch: runner codex-exec with NO executor supplied is a composition bug — it throws rather than silently reviewing on the Claude default (which would turn a cross-vendor gate back into a same-vendor one)", () => {
  assert.throws(() => resolveReviewSessionExecutor("codex-exec", { runner: fakeRoleRunner({}) }), /no matching ReviewSessionExecutor/);
});

test("dispatch: a supplied executor whose runner disagrees with the configured one is refused — the configured runner and the executing runner can never diverge silently", () => {
  assert.throws(
    () => resolveReviewSessionExecutor("claude", { runner: fakeRoleRunner({}), executor: fakeCodexExecutor({}) }),
    /the configured runner and the executing runner must be the same/,
  );
});

test("dispatch: runner codex-exec with the matching executor uses exactly that executor, and the session request carries the configured model/effort/budget", async () => {
  const executor = fakeCodexExecutor({ resultText: resultTextFor([]) });
  const built = build({ cfg: codexCfg(), executor });
  const result = await built.evaluate();
  assert.equal(result.kind, "approved");
  assert.equal(executor.calls.length, 1);
  assert.deepEqual(
    { model: executor.calls[0]!.model, effort: executor.calls[0]!.effort, budgetUsd: executor.calls[0]!.budgetUsd },
    { model: CODEX_REVIEWER_MODEL, effort: "high", budgetUsd: 3 },
  );
  assert.equal(executor.calls[0]!.treeDir, MATERIALIZED.kind === "materialized" ? MATERIALIZED.treeDir : "");
});

test("dispatch: EngineAgentReviewer construction fails closed when the config asks for codex-exec and the composition root forgot the executor", () => {
  assert.throws(() => build({ cfg: codexCfg() }), /no matching ReviewSessionExecutor/);
});

// ── 2. one parsing path ──────────────────────────────────────────────────────────────────────

test("ONE parsing path: the SAME session output through the claude executor and the codex executor yields an identical verdict and identically-shaped Finding[] — the executor changes WHO runs the session, never what its output may mean", async () => {
  const text = resultTextFor([{ id: "f1", body: "a real problem in x" }], ["confirmed", "cannot-confirm"]);

  const viaClaude = build({ cfg: claudeCfg(), runner: fakeRoleRunner({ resultText: text }) });
  const claudeResult = await viaClaude.evaluate();

  const viaCodex = build({ cfg: codexCfg(), executor: fakeCodexExecutor({ resultText: text }) });
  const codexResult = await viaCodex.evaluate();

  assert.equal(claudeResult.kind, "rejected");
  assert.deepEqual(codexResult, claudeResult, "same output ⇒ same ApprovalResult, byte-for-byte");
  assert.deepEqual(
    viaCodex.artifacts[0]!.artifact.findings,
    viaClaude.artifacts[0]!.artifact.findings,
    "and the same classified findings in the persisted artifact",
  );
  assert.deepEqual(viaCodex.artifacts[0]!.artifact.perAC, viaClaude.artifacts[0]!.artifact.perAC);
});

// ── 3. malformed / prose-only codex output ───────────────────────────────────────────────────

test("a prose-only codex output can never BLOCK and can never APPROVE — it is an invalid attempt (retried once, then unavailable), exactly like the Claude runner's", async () => {
  const executor = fakeCodexExecutor({ resultText: "I reviewed the PR and it looks good to me. LGTM, approving." });
  const result = await build({ cfg: codexCfg(), executor }).evaluate();
  assert.equal(result.kind, "unavailable");
  assert.equal(executor.calls.length, 2, "one retry within the remaining budget, then give up");
});

test("a codex output smuggling an `overall` verdict field fails the whole-output schema — a session can never hand itself a disposition", async () => {
  const smuggled = `<<<SAPWOOD_RESULT>>>\n${JSON.stringify({
    perAC: MANIFEST.map((a) => ({ id: a.id, status: "confirmed" })),
    findings: [],
    overall: "approved",
  })}\n<<<END_SAPWOOD_RESULT>>>`;
  const result = await build({ cfg: codexCfg(), executor: fakeCodexExecutor({ resultText: smuggled }) }).evaluate();
  assert.equal(result.kind, "unavailable");
});

test("a codex session that ran but FAILED, with UNKNOWN spend, is not retried — an unmeasured attempt-1 spend must never be read as `$0 spent, full cap remains`", async () => {
  const executor = fakeCodexExecutor({ outcome: "failed", resultText: "", spend: { kind: "unknown" } });
  const result = await build({ cfg: codexCfg(), executor }).evaluate();
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /NO recorded cost/);
  assert.equal(executor.calls.length, 1, "no retry when the remainder is incomputable");
});

test("an ESTIMATED spend IS subtractable: the retry gets cap − estimate, not a second full cap", async () => {
  const executor = fakeCodexExecutor({ resultText: "prose only", spend: { kind: "estimated", usd: 1.25 } });
  await build({ cfg: codexCfg(), executor }).evaluate();
  assert.deepEqual(
    executor.calls.map((c) => c.budgetUsd),
    [3, 1.75],
  );
});

// ── 4. D5 (provider, model) runtime matrix ───────────────────────────────────────────────────

test("D5 matrix: a codex session whose identity is a DIFFERENT provider is distinguishable even when the model NAME matches the worker's — the comparison is on the (provider, model) pair", async () => {
  const executor = fakeCodexExecutor({
    resultText: resultTextFor([]),
    identity: [{ provider: "openai", model: WORKER_MODEL }],
  });
  const result = await build({ cfg: codexCfg(), executor, workerActualModels: [WORKER_MODEL] }).evaluate();
  assert.equal(result.kind, "approved");
});

test("D5 matrix: a codex session that reports the SAME provider AND model as the producing worker can never gate — a runner is not a vendor, so this is a real possibility, not a hypothetical", async () => {
  const executor = fakeCodexExecutor({
    resultText: resultTextFor([]),
    identity: [{ provider: "anthropic", model: WORKER_MODEL }],
  });
  const result = await build({ cfg: codexCfg(), executor, workerActualModels: [WORKER_MODEL] }).evaluate();
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /anthropic\/sonnet.*never gate/s);
});

test("D5 matrix: an UNIDENTIFIABLE codex session (empty identity — no transcript, or a half-known one) maps to unavailable, never an approval from a model nobody can name", async () => {
  const executor = fakeCodexExecutor({ resultText: resultTextFor([]), identity: [] });
  const result = await build({ cfg: codexCfg(), executor, workerActualModels: [WORKER_MODEL] }).evaluate();
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /reviewer's own actual model is unknown/);
});

test("D5 matrix: an unknown PRODUCING-lane model fails closed for the codex runner too — the pre-session check runs for both runners, only the static overlap comparison is runner-specific", async () => {
  const executor = fakeCodexExecutor({ resultText: resultTextFor([]) });
  const result = await build({ cfg: codexCfg(), executor, workerActualModels: [] }).evaluate();
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /producing worker's actual model is unknown/);
  assert.equal(executor.calls.length, 0, "and no paid session is spawned at all");
});

test("D5 matrix (claude runner, unchanged): a session reporting the worker's own model is still refused, and the message now names the provider on both sides", async () => {
  const result = await build({
    cfg: claudeCfg(),
    runner: fakeRoleRunner({
      resultText: resultTextFor([]),
      modelUsage: [{ model: WORKER_MODEL, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
    }),
  }).evaluate();
  assert.equal(result.kind, "unavailable");
  assert.match((result as { reason: string }).reason, /anthropic\/sonnet/);
});

// ── 5. default-path regression pin ───────────────────────────────────────────────────────────

test("regression pin: with `runner` unset, evaluate() goes through RoleRunner.run({reviewCwd}) with the review profile untouched — the pre-#443 call, field for field", async () => {
  const seen: Record<string, unknown>[] = [];
  const runner = {
    run: async (opts: Record<string, unknown>): Promise<RoleSessionResult> => {
      seen.push(opts);
      return {
        outcome: "done",
        costUsd: 1,
        costKnown: true,
        modelUsage: [{ model: CLAUDE_REVIEWER_MODEL, inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }],
        exitCode: 0,
        name: "role-engine-reviewer-test",
        resultText: resultTextFor([]),
      };
    },
  };
  const cfg = claudeCfg();
  assert.equal(cfg.reviewer.agent?.runner, "claude", "the shipped default");
  const result = await build({ cfg, runner: runner as unknown as { run: () => Promise<RoleSessionResult> } }).evaluate();
  assert.equal(result.kind, "approved");
  assert.deepEqual(seen[0], {
    roleId: "engine-reviewer",
    prompt: seen[0]!.prompt,
    model: CLAUDE_REVIEWER_MODEL,
    effort: "high",
    fallbackModel: "none",
    reviewCwd: MATERIALIZED.kind === "materialized" ? MATERIALIZED.treeDir : "",
    maxBudgetUsd: 3,
  });
});

// ── 6. event-kind registration ───────────────────────────────────────────────────────────────

test("event-kind registration: every honest-recording kind this feature adds is listed in the §7 copy map — the repo's own rule that a new event kind lands in that map in the SAME PR", () => {
  const doc = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "reference", "frontend-design.md"),
    "utf8",
  );
  for (const kind of [
    ENGINE_REVIEW_BUDGET_ADVISORY,
    ENGINE_REVIEW_COST_UNKNOWN,
    ENGINE_REVIEW_CONTAINMENT_GAP,
    ENGINE_REVIEW_ORPHANED_GROUP,
  ]) {
    assert.ok(doc.includes(`| \`${kind}\` |`), `event kind ${kind} must have a plain-language row in docs/reference/frontend-design.md §7`);
  }
});
