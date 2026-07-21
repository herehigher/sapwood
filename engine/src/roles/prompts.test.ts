// prompts.test.ts (#235 PR-B, F1 follow-up): snapshot tests for the role prompt templates under
// engine/prompts/ — every prompt this issue's "role-scoped discretion" flip touches (po.md,
// architect.md, plan-reviewer.md, plan-drafter.md, harvest.md) gets a content hash pinned here
// (any future edit, intentional or not, must update the hash alongside it — the whole point of
// a snapshot test) PLUS assertions on the specific new/retained language the issue's acceptance
// criteria name. plan-drafter.md's flip landed one round later than the other four (a review
// finding: the matrix grants it Read/Grep/Glob same as every peripheral role, but its prompt
// still forbade opening a file) — same shape as the others, added here for the same reason.
// retro.md gets ONLY a hash pin: item 3's "retro unchanged (already code-aware) — do not touch"
// is itself a regression trip-wire this test enforces. po-pool.md is pinned too even though this
// PR doesn't touch it (its non-negotiables never carried the "wanting to open a file" language
// po.md did, so there was nothing to flip) — same trip-wire reasoning.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { defaultPoolPromptPath, defaultPoPromptPath } from "../loop/align.js";
import { defaultHarvestPromptPath } from "../loop/harvest.js";
import { defaultRetroPromptPath } from "../retro/retro.js";
import { defaultArchitectPromptPath } from "./architect.js";
import { defaultPlanDrafterPromptPath, defaultPlanReviewerPromptPath } from "./plan-review.js";

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function readPrompt(path: string): string {
  return readFileSync(path, "utf8");
}

// ── Snapshot hashes — update deliberately, alongside a reviewed prompt edit, never casually ───

const SNAPSHOT_HASHES: Record<string, string> = {
  // #237: intentional edit — po.md now documents the optional `concerns` dissent field.
  "po.md": "708e148423d5d4c6486031ed28c62239c791929457d97fb58f9156ce9d6d1ab5",
  "architect.md": "897b46fd4d8803ad7b25dc1ec467f29a56139af80ed8b7bb44fc42624441cbc5",
  // #283: intentional edit — mandatory checkbox acceptance-criteria language (design #279 §5).
  "plan-reviewer.md": "ba26b2fe1a2bd8c807da46bcda279e331f9298cde01ff35221f4f163e23efc7b",
  "plan-drafter.md": "9cf51940680400e7bb1dc98089c07b960d51fc56cd5698fa7ab692f25dc004da",
  "harvest.md": "c05f0751f6087666860f7568c4613a208dc85f4c5e92ee792f88fc3b5a20ae98",
  "retro.md": "d667893510d96a67e5e8041861daa2d6767e708acfeca2f98c498e09e6a21917",
  "po-pool.md": "20ccec5f8a073f7424651c195c7b85ea685bfe2c2bf49dc9420755e9b2d60b1d",
};

test("prompt snapshot: po.md hash matches the pinned #235 PR-B revision", () => {
  assert.equal(sha256(readPrompt(defaultPoPromptPath())), SNAPSHOT_HASHES["po.md"]);
});

test("prompt snapshot: architect.md hash matches the pinned #235 PR-B revision", () => {
  assert.equal(sha256(readPrompt(defaultArchitectPromptPath())), SNAPSHOT_HASHES["architect.md"]);
});

test("prompt snapshot: plan-reviewer.md hash matches the pinned #235 PR-B revision", () => {
  assert.equal(sha256(readPrompt(defaultPlanReviewerPromptPath())), SNAPSHOT_HASHES["plan-reviewer.md"]);
});

test("prompt snapshot: plan-drafter.md hash matches the pinned #235 PR-B revision", () => {
  assert.equal(sha256(readPrompt(defaultPlanDrafterPromptPath())), SNAPSHOT_HASHES["plan-drafter.md"]);
});

test("prompt snapshot: harvest.md hash matches the pinned #235 PR-B revision", () => {
  assert.equal(sha256(readPrompt(defaultHarvestPromptPath())), SNAPSHOT_HASHES["harvest.md"]);
});

test("prompt snapshot (#235 AC item 3): retro.md is BYTE-IDENTICAL to its pre-#235 content — 'retro unchanged (already code-aware) — do not touch' is enforced here, not just asserted in prose", () => {
  assert.equal(sha256(readPrompt(defaultRetroPromptPath())), SNAPSHOT_HASHES["retro.md"]);
});

test("prompt snapshot: po-pool.md is unchanged — its non-negotiables never carried po.md's 'wanting to open a file' language, so #235 PR-B's flip has nothing to do there", () => {
  assert.equal(sha256(readPrompt(defaultPoolPromptPath())), SNAPSHOT_HASHES["po-pool.md"]);
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
