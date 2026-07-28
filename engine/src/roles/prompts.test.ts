// prompts.test.ts: snapshot tests for shipped role prompt templates under engine/prompts/.
// Any future edit, intentional or not, must update the matching hash alongside it. Content
// assertions below pin issue-specific language and structural output contracts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultPoolPromptPath, defaultPoPromptPath } from "../loop/align.js";
import { defaultPoDecomposePromptPath } from "../loop/decompose.js";
import { defaultHarvestPromptPath } from "../loop/harvest.js";
import { defaultDoctrineTemplatePath } from "../loop/init.js";
import { defaultRetroPromptPath } from "../retro/retro.js";
import { defaultEngineReviewerPromptPath } from "../review/engine-agent.js";
import { defaultArchitectPromptPath } from "./architect.js";
import { defaultPlanConfirmPromptPath, defaultPlanDrafterPromptPath, defaultPlanReviewerPromptPath } from "./plan-review.js";
import { defaultFixPromptPath, defaultPromptPath } from "./worker.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readPrompt(path: string): string {
  return readFileSync(path, "utf8");
}

// ── Snapshot hashes — update deliberately, alongside a reviewed prompt edit, never casually ───

const SNAPSHOT_HASHES: Record<string, string> = {
  // #321: intentional edits — sentinel examples are plain text, never markdown-fenced.
  "po.md": "49fe0cd968ac611a4f7cb12c624f9196e44e9fa90f0be58a588791afeb263781",
  "architect.md": "08ae9bd5a164533d3d6c96b6a3c98e48c0fa666d41cc85b73d2457358d17f3b2",
  "plan-reviewer.md": "4f957b12d2ff056233cd111d9c968547cc2b4988761c4d1ba6ba40e314c10c93",
  "plan-reviewer-confirm.md": "250c0752f7e2b91418cc76a772123107a36d7de16fa9728c33399061993497fa",
  "plan-drafter.md": "dce0f4aca4c0d323ad8f7176a6612527075d9e6ec83b19396e9d3dc2f68903eb",
  "harvest.md": "59fb5fb1a8a3bebb2429c878c309caffe3105a3f9a32262268b7a14525026d4b",
  "retro.md": "d667893510d96a67e5e8041861daa2d6767e708acfeca2f98c498e09e6a21917",
  "po-pool.md": "a5f51726e886ecaca53dfc9773e7403b602e3cb555cfb972bee2f15e54204d09",
  "po-decompose.md": "b5f5564e6839f59a00ed96cea063ff35a6fe27da3f1a5fb775b6e59b7295bb01",
};

test("prompt snapshot: po.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPoPromptPath())), SNAPSHOT_HASHES["po.md"]);
});

test("prompt snapshot: architect.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultArchitectPromptPath())), SNAPSHOT_HASHES["architect.md"]);
});

test("prompt snapshot: plan-reviewer.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPlanReviewerPromptPath())), SNAPSHOT_HASHES["plan-reviewer.md"]);
});

test("prompt snapshot: plan-reviewer-confirm.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPlanConfirmPromptPath())), SNAPSHOT_HASHES["plan-reviewer-confirm.md"]);
});

test("prompt snapshot: plan-drafter.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPlanDrafterPromptPath())), SNAPSHOT_HASHES["plan-drafter.md"]);
});

test("prompt snapshot: harvest.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultHarvestPromptPath())), SNAPSHOT_HASHES["harvest.md"]);
});

test("prompt snapshot (#235 AC item 3): retro.md is BYTE-IDENTICAL to its pre-#235 content — 'retro unchanged (already code-aware) — do not touch' is enforced here, not just asserted in prose", () => {
  assert.equal(sha256(readPrompt(defaultRetroPromptPath())), SNAPSHOT_HASHES["retro.md"]);
});

test("prompt snapshot: po-pool.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPoolPromptPath())), SNAPSHOT_HASHES["po-pool.md"]);
});

test("prompt snapshot: po-decompose.md hash matches the pinned revision", () => {
  assert.equal(sha256(readPrompt(defaultPoDecomposePromptPath())), SNAPSHOT_HASHES["po-decompose.md"]);
});

test("shipped role prompts (#321): sentinel examples are plain text with no adjacent markdown fences", () => {
  const prompts: ReadonlyArray<readonly [name: string, path: string, sentinelCount: number]> = [
    ["plan-reviewer.md", defaultPlanReviewerPromptPath(), 2],
    ["plan-reviewer-confirm.md", defaultPlanConfirmPromptPath(), 2],
    ["plan-drafter.md", defaultPlanDrafterPromptPath(), 1],
    ["po.md", defaultPoPromptPath(), 4],
    ["po-pool.md", defaultPoolPromptPath(), 1],
    ["po-decompose.md", defaultPoDecomposePromptPath(), 2],
    ["architect.md", defaultArchitectPromptPath(), 2],
    ["harvest.md", defaultHarvestPromptPath(), 1],
  ];

  for (const [name, path, sentinelCount] of prompts) {
    const prompt = readPrompt(path);
    assert.match(prompt, /Emit the sentinel block as PLAIN TEXT: never wrap it in a markdown code fence\./, name);
    assert.equal(prompt.match(/^<<<SAPWOOD_RESULT>>>[ \t]*$/gm)?.length, sentinelCount, name);
    assert.equal(prompt.match(/^<<<END_SAPWOOD_RESULT>>>[ \t]*$/gm)?.length, sentinelCount, name);
    assert.doesNotMatch(prompt, /^ {0,3}(?:`{3,}|~{3,})[^\r\n]*\r?\n<<<SAPWOOD_RESULT>>>[ \t]*$/m, name);
    assert.doesNotMatch(prompt, /^<<<(?:END_SAPWOOD_RESULT|END_BODY)>>>[ \t]*\r?\n {0,3}(?:`{3,}|~{3,})[ \t]*$/m, name);
  }
});

// ── Content assertions — the specific #235 AC language, not just "the file changed somehow" ──

test("po.md (#235 AC item 3, item 4): the intent-prohibition is retained IN SPIRIT (producer ≠ PO still holds) but the old 'wanting to open a file = wrong role' line is gone, replaced by role-scoped read discretion that still forbids rewriting human why/what", () => {
  const body = readPrompt(defaultPoPromptPath());
  assert.ok(body.includes("producer ≠ PO."), "the core intent-prohibition heading survives verbatim");
  assert.ok(!body.includes("wanting to open a file or run tests"), "the old blanket file-read prohibition is gone");
  assert.ok(body.toLowerCase().includes("never rewrite"), "the why/what guardrail survives: reading never licenses rewriting human intent");
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant, confined to the worktree");
});

test("architect.md (#235 AC item 3): no longer claims zero Read/repo access; instead directs citing code evidence when it drives a contradiction", () => {
  const body = readPrompt(defaultArchitectPromptPath());
  assert.ok(!body.includes("You have no Read tool and no repo checkout either"), "the old blanket denial is gone");
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant");
  assert.ok(body.toLowerCase().includes("cite"), "directs citing code evidence, not just asserting a contradiction");
});

test("plan-reviewer.md (#235 AC item 3): judges plan EXECUTABILITY, explicitly warned off demanding implementation-shaped acceptance criteria", () => {
  const body = readPrompt(defaultPlanReviewerPromptPath());
  assert.ok(body.toLowerCase().includes("executab"), "names plan executability as the judgment target");
  assert.ok(
    body.toLowerCase().includes("implementation-shaped") || body.toLowerCase().includes("already implemented"),
    "explicitly warns against implementation-shaped acceptance criteria",
  );
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant");
});

test("harvest.md (#235 AC item 3): repository reads must not alter ledger facts or expand comment scope — both limits stated explicitly", () => {
  const body = readPrompt(defaultHarvestPromptPath());
  assert.ok(body.toLowerCase().includes("ledger fact"), "names the ledger-facts invariant explicitly");
  assert.ok(
    body.toLowerCase().includes("expand") && body.toLowerCase().includes("comment"),
    "names the comment-scope invariant explicitly",
  );
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant");
});

test("plan-drafter.md (#235 PR-B follow-up F1): the matrix grants plan-drafter Read/Grep/Glob (it's a peripheral role, no allowedTools override at its plan-review.ts callsite — falls back to the base), so the prompt's old 'wanting to open a file = wrong role' line — which contradicted that grant — is gone, replaced by role-scoped discretion; 'plan-author ≠ plan-approver' and 'never implement' survive verbatim in spirit", () => {
  const body = readPrompt(defaultPlanDrafterPromptPath());
  assert.ok(
    !body.includes("wanting to open a file or run tests"),
    "the old blanket file-read prohibition (contradicting the matrix) is gone",
  );
  assert.ok(body.includes("Read`/`Grep`/`Glob`"), "names the actual read-only grant");
  assert.ok(body.includes("plan-author ≠ plan-approver."), "the plan-author ≠ plan-approver boundary survives verbatim");
  assert.ok(body.toLowerCase().includes("never implement"), "the never-implement boundary survives");
  assert.ok(body.includes("producer ≠ plan-drafter."), "the core intent-prohibition heading survives verbatim");
});

// ── #283 (design #279 §5, D4): mandatory checkbox acceptance criteria ─────────────────────────

test("plan-reviewer.md (#283): mandates literal `- [ ]` checkbox acceptance criteria — malformed/prose AC is named as not-dispatchable, not just a style nit", () => {
  const body = readPrompt(defaultPlanReviewerPromptPath());
  assert.ok(body.includes("- [ ]"), "shows the literal checkbox syntax");
  assert.ok(body.toLowerCase().includes("not dispatchable"), "states the dispatch consequence explicitly");
});

test("plan-drafter.md (#283): mandates literal `- [ ]` checkbox acceptance criteria in whatever body it drafts", () => {
  const body = readPrompt(defaultPlanDrafterPromptPath());
  assert.ok(body.includes("- [ ] ...`"), "shows the literal checkbox syntax");
  assert.ok(body.toLowerCase().includes("not dispatchable"), "states the dispatch consequence explicitly");
});

// ── #409: reuse-before-build + authoritative-signals-over-inferred, worded per role ───────────

test("#409 worker.md: the reuse check is a Method step placed BEFORE the red-test step and anchored on it, and authoritative-signals is a non-negotiable", () => {
  const body = readPrompt(defaultPromptPath());
  const reuse = body.indexOf("Check what already exists before you build.");
  const red = body.indexOf("Write the tests first (red).");
  assert.ok(reuse > 0, "the reuse step is present");
  assert.ok(reuse < red, "it precedes the red-test step rather than trailing it");
  assert.match(body, /a "red" test that passes immediately/, "anchored on the existing red-test signal, not a bolted-on survey process");
  assert.ok(body.includes("Authoritative signals over inferred ones."), "the signal rule is present");
  assert.ok(
    body.indexOf("Authoritative signals over inferred ones.") > body.indexOf("## Non-negotiables"),
    "and it lives under Non-negotiables, not buried in Method",
  );
});

test("#409 fix.md: carries the authoritative-signals rule (a fix leg is where patterns get widened to pass) and deliberately NOT the reuse step", () => {
  const body = readPrompt(defaultFixPromptPath());
  assert.ok(
    body.includes("Authoritative signals over inferred ones."),
    "the signal rule reaches the fix leg, which runs on its own prompt",
  );
  assert.match(
    body,
    /Widening a free-text pattern until the failing\s+case passes is not a fix/,
    "named in fix-leg terms, not copied from worker.md",
  );
  assert.ok(!body.includes("Check what already exists before you build."), "reuse-before-build is scoped to fresh work, not rework");
});

test("#409 plan-reviewer.md: unexecutable-mechanism plans are bounceable, WITHOUT licensing a re-litigation of the human's why/what", () => {
  const body = readPrompt(defaultPlanReviewerPromptPath());
  assert.ok(body.includes("Mechanism assumptions are plan defects."), "the plan-defect ground is present");
  assert.match(body, /A checkability defect, never a scope re-litigation\./, "explicitly bounded away from re-litigating scope");
  assert.ok(body.includes("not whether the underlying work is a good idea"), "the charter line forbidding re-litigation survives the edit");
  assert.ok(
    !body.includes("Check what already exists before you build."),
    "gate⓪ does not survey the repo for prior art — that would re-litigate a human's Ready call",
  );
});

test("#409 engine-reviewer.md: both finding classes are named, and the closed-output contract is untouched", () => {
  const body = readPrompt(defaultEngineReviewerPromptPath());
  assert.match(body, /re-implements a mechanism the\s+tree already provides/, "the reinvention finding class");
  assert.match(body, /pattern-matches free-form text\s+the project does not control/, "the inferred-signal finding class");
  assert.ok(
    body.includes("beyond exactly `perAC` and `findings`"),
    "no new output field was introduced — the closed schema statement still stands",
  );
});

test("#409 po.md: align mode states reuse-before-build as a rule, including the propose-nothing case", () => {
  const body = readPrompt(defaultPoPromptPath());
  assert.match(body, /In align mode this is a rule, not an option/, "upgraded from the old discretionary half-sentence");
  assert.match(body, /propose nothing/, "the propose-nothing case is explicit");
});

test("#409 doctrine-template.md: the authoritative-signals invariant carries the ordering, the contract-format exemption, and the failure-direction requirement", () => {
  const body = readPrompt(defaultDoctrineTemplatePath());
  assert.ok(body.includes("Authoritative signals over inferred text."), "the invariant is present in the shipped starter doctrine");
  assert.match(body, /bind to a structured\s+signal first/, "structured-signal-first ordering");
  assert.match(
    body,
    /are contracts, not text matching/,
    "the contract-internal-format exemption — this project's own grammars stay allowed",
  );
  assert.match(body, /name the failure direction/, "the false-positive-vs-false-negative choice must be stated");
});

test("#409: the rule is worded per role rather than one paragraph duplicated, and no shared prompt-include mechanism was added", () => {
  const worker = readPrompt(defaultPromptPath());
  const others = [
    defaultFixPromptPath(),
    defaultPlanReviewerPromptPath(),
    defaultEngineReviewerPromptPath(),
    defaultDoctrineTemplatePath(),
  ].map(readPrompt);
  const workerSentence = "To detect or classify an external condition, bind";
  assert.ok(worker.includes(workerSentence), "worker.md's own phrasing");
  for (const body of others) {
    assert.ok(!body.includes(workerSentence), "no file repeats worker.md's sentence verbatim — each role gets wording it can act on");
  }
  for (const body of [worker, ...others]) {
    assert.doesNotMatch(
      body,
      /\{\{\s*(?:include|partial|shared)[^}]*\}\}/,
      "no include/partial directive was introduced into the template language",
    );
  }
});

test("#409: plan-drafter.md and architect.md are deliberately untouched (charter conflicts recorded in the issue)", () => {
  assert.equal(sha256(readPrompt(defaultPlanDrafterPromptPath())), SNAPSHOT_HASHES["plan-drafter.md"]);
  assert.equal(sha256(readPrompt(defaultArchitectPromptPath())), SNAPSHOT_HASHES["architect.md"]);
});
