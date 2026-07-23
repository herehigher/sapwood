// prompts.test.ts: snapshot tests for shipped role prompt templates under engine/prompts/.
// Any future edit, intentional or not, must update the matching hash alongside it. Content
// assertions below pin issue-specific language and structural output contracts.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultPoolPromptPath, defaultPoPromptPath } from "../loop/align.js";
import { defaultHarvestPromptPath } from "../loop/harvest.js";
import { defaultRetroPromptPath } from "../retro/retro.js";
import { defaultArchitectPromptPath } from "./architect.js";
import { defaultPlanConfirmPromptPath, defaultPlanDrafterPromptPath, defaultPlanReviewerPromptPath } from "./plan-review.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readPrompt(path: string): string {
  return readFileSync(path, "utf8");
}

// ── Snapshot hashes — update deliberately, alongside a reviewed prompt edit, never casually ───

const SNAPSHOT_HASHES: Record<string, string> = {
  // #321: intentional edits — sentinel examples are plain text, never markdown-fenced.
  "po.md": "d33d20062d903584608e0799e3d825cb7a0b1fea23c070a5c0271a82a7b8896e",
  "architect.md": "08ae9bd5a164533d3d6c96b6a3c98e48c0fa666d41cc85b73d2457358d17f3b2",
  "plan-reviewer.md": "4a91f393dc61f01d5ab1be3c51504ec92720f8842188e38332c0849538f927f7",
  "plan-reviewer-confirm.md": "5502bd8c5c9196e51f0d45086ba256aa8ce8fd0eaf1249c57120fafe3e49aacf",
  "plan-drafter.md": "2daa2a1f1e4d57acde6a8efafdb806cdb525631cd241d8fa1bfb08dae5914d4c",
  "harvest.md": "59fb5fb1a8a3bebb2429c878c309caffe3105a3f9a32262268b7a14525026d4b",
  "retro.md": "d667893510d96a67e5e8041861daa2d6767e708acfeca2f98c498e09e6a21917",
  "po-pool.md": "a5f51726e886ecaca53dfc9773e7403b602e3cb555cfb972bee2f15e54204d09",
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

test("shipped role prompts (#321): sentinel examples are plain text with no adjacent markdown fences", () => {
  const prompts: ReadonlyArray<readonly [name: string, path: string, sentinelCount: number]> = [
    ["plan-reviewer.md", defaultPlanReviewerPromptPath(), 2],
    ["plan-reviewer-confirm.md", defaultPlanConfirmPromptPath(), 2],
    ["plan-drafter.md", defaultPlanDrafterPromptPath(), 1],
    ["po.md", defaultPoPromptPath(), 4],
    ["po-pool.md", defaultPoolPromptPath(), 1],
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
