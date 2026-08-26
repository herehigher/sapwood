// finding-axes.test.ts (#448, design #402 R1) — the pure layering primitives: the fail-closed
// severity table (D2/D3), the path-drop-not-void rule, and the two structural invariants the
// issue's own ACs require: finding-axes.ts imports nothing from roles/reviewer.ts beyond the
// `Finding` type, and this PR touches no human-merge-only path (guard.ts's PROTECTED_SUFFIXES).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ADVISORY_ELIGIBLE_KINDS,
  ALLOWED_FINDING_KEYS,
  applySeverityOverride,
  type ClassifiedFinding,
  changedPathsFromDiff,
  effectiveOwner,
  effectiveSeverity,
  FINDING_KINDS,
  FINDING_OWNERS,
  resolveFindingPath,
} from "./finding-axes.js";

// ── the taxonomies themselves ────────────────────────────────────────────────────────────────

test("FINDING_KINDS is the exact five-member taxonomy design #402 §1 specifies", () => {
  assert.deepEqual([...FINDING_KINDS], ["correctness", "security", "design", "test-coverage", "style"]);
});

test("ALLOWED_FINDING_KEYS (#865) is exactly {id, body, severity, kind, path, owner}", () => {
  assert.deepEqual([...ALLOWED_FINDING_KEYS].sort(), ["body", "id", "kind", "owner", "path", "severity"]);
});

test("ADVISORY_ELIGIBLE_KINDS (D3) is exactly {style, test-coverage} — security/correctness/design excluded", () => {
  assert.deepEqual([...ADVISORY_ELIGIBLE_KINDS].sort(), ["style", "test-coverage"]);
  assert.equal(ADVISORY_ELIGIBLE_KINDS.has("security"), false);
  assert.equal(ADVISORY_ELIGIBLE_KINDS.has("correctness"), false);
  assert.equal(ADVISORY_ELIGIBLE_KINDS.has("design"), false);
});

// ── effectiveSeverity: the fail-closed defaults table (design #402 §1) ──────────────────────────

test("effectiveSeverity: severity absent -> blocking (today's exact behavior)", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x" };
  assert.equal(effectiveSeverity(f), "blocking");
});

test("effectiveSeverity: severity absent, kind present -> still blocking (kind is analysis-only, D2)", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x", kind: "style" };
  assert.equal(effectiveSeverity(f), "blocking");
});

test("effectiveSeverity: severity 'blocking' explicit -> blocking, regardless of kind", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x", severity: "blocking", kind: "style" };
  assert.equal(effectiveSeverity(f), "blocking");
});

test("effectiveSeverity: severity 'advisory' + kind in ADVISORY_ELIGIBLE_KINDS -> advisory", () => {
  for (const kind of ["style", "test-coverage"] as const) {
    assert.equal(effectiveSeverity({ id: "f1", body: "x", severity: "advisory", kind }), "advisory");
  }
});

test("effectiveSeverity (D3): severity 'advisory' + kind NOT eligible -> forced blocking", () => {
  for (const kind of ["correctness", "security", "design"] as const) {
    assert.equal(effectiveSeverity({ id: "f1", body: "x", severity: "advisory", kind }), "blocking");
  }
});

test("effectiveSeverity (D3): severity 'advisory' + kind ABSENT -> forced blocking (unclassified is never advisory-eligible)", () => {
  assert.equal(effectiveSeverity({ id: "f1", body: "x", severity: "advisory" }), "blocking");
});

// ── #865 (design #1123 D4): the owner axis — FINDING_OWNERS, effectiveOwner's fail-closed default ──

test("FINDING_OWNERS is the exact two-member taxonomy design #1123 D4 specifies", () => {
  assert.deepEqual([...FINDING_OWNERS], ["producer", "operator"]);
});

test("effectiveOwner: owner absent -> producer (today-equivalent, fail-closed)", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x" };
  assert.equal(effectiveOwner(f), "producer");
});

test("effectiveOwner: owner 'producer' explicit -> producer", () => {
  assert.equal(effectiveOwner({ id: "f1", body: "x", owner: "producer" }), "producer");
});

test("effectiveOwner: owner 'operator' explicit -> operator", () => {
  assert.equal(effectiveOwner({ id: "f1", body: "x", owner: "operator" }), "operator");
});

// ── applySeverityOverride: D3's engine-recorded override ────────────────────────────────────────

test("applySeverityOverride: no severity requested -> same object reference (byte-for-byte pin)", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x" };
  assert.equal(applySeverityOverride(f), f);
});

test("applySeverityOverride: severity 'blocking' explicit -> same object reference, no bookkeeping added", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x", severity: "blocking" };
  assert.equal(applySeverityOverride(f), f);
});

test("applySeverityOverride: legitimately advisory-eligible -> same object reference, no override", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x", severity: "advisory", kind: "style" };
  const out = applySeverityOverride(f);
  assert.equal(out, f);
  assert.equal(out.severityOverridden, undefined);
});

test("applySeverityOverride (D3): advisory requested, kind ineligible -> NEW object, severity forced blocking, override recorded", () => {
  const f: ClassifiedFinding = { id: "f1", body: "a real security defect", severity: "advisory", kind: "security" };
  const out = applySeverityOverride(f);
  assert.notEqual(out, f); // new object, original left untouched
  assert.equal(f.severity, "advisory"); // original reference unmutated
  assert.equal(out.severity, "blocking");
  assert.equal(out.severityOverridden, true);
  assert.equal(out.id, "f1");
  assert.equal(out.body, "a real security defect");
});

test("applySeverityOverride (D3): advisory requested, kind absent -> override recorded the same way", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x", severity: "advisory" };
  const out = applySeverityOverride(f);
  assert.equal(out.severity, "blocking");
  assert.equal(out.severityOverridden, true);
});

// ── resolveFindingPath: dropped-to-unlocated, never voided ──────────────────────────────────────

test("resolveFindingPath: path absent -> same object reference, no bookkeeping", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x" };
  const out = resolveFindingPath(f, new Set(["src/a.ts"]));
  assert.equal(out, f);
  assert.equal(out.pathDropped, undefined);
});

test("resolveFindingPath: path IS a member of the changed-path set -> same object reference, path retained", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x", path: "src/a.ts" };
  const out = resolveFindingPath(f, new Set(["src/a.ts", "src/b.ts"]));
  assert.equal(out, f);
  assert.equal(out.path, "src/a.ts");
});

test("resolveFindingPath: path NOT a member of the changed-path set -> finding RETAINED, path dropped to undefined, drop recorded", () => {
  const f: ClassifiedFinding = { id: "f1", body: "x", path: "src/not-in-diff.ts" };
  const out = resolveFindingPath(f, new Set(["src/a.ts"]));
  assert.notEqual(out, f);
  assert.equal(out.id, "f1");
  assert.equal(out.body, "x");
  assert.equal(out.path, undefined);
  assert.equal(out.pathDropped, true);
  assert.equal(f.path, "src/not-in-diff.ts"); // original untouched
});

test("resolveFindingPath: empty changed-path set drops every supplied path", () => {
  const out = resolveFindingPath({ id: "f1", body: "x", path: "anything.ts" }, new Set());
  assert.equal(out.path, undefined);
  assert.equal(out.pathDropped, true);
});

// ── changedPathsFromDiff: #472 fix round (gate② P1) — the primitive that makes resolveFindingPath's
// retention branch live in production ────────────────────────────────────────────────────────────

test("changedPathsFromDiff: a single modified file — both the diff --git header AND the ---/+++ lines contribute the same path", () => {
  const diff =
    "diff --git a/src/foo.ts b/src/foo.ts\nindex 1111111..2222222 100644\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const paths = changedPathsFromDiff(diff);
  assert.deepEqual([...paths], ["src/foo.ts"]);
});

test("changedPathsFromDiff: multiple files in one diff — every changed path is present", () => {
  const diff = [
    "diff --git a/src/a.ts b/src/a.ts",
    "index 1111111..2222222 100644",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
    "diff --git a/src/b.ts b/src/b.ts",
    "index 3333333..4444444 100644",
    "--- a/src/b.ts",
    "+++ b/src/b.ts",
    "@@ -1,1 +1,1 @@",
    "-old2",
    "+new2",
  ].join("\n");
  assert.deepEqual([...changedPathsFromDiff(diff)].sort(), ["src/a.ts", "src/b.ts"]);
});

test("changedPathsFromDiff: a NEW file (--- /dev/null) contributes its b/ path only", () => {
  const diff =
    "diff --git a/src/new.ts b/src/new.ts\nnew file mode 100644\nindex 0000000..1111111\n--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,1 @@\n+content\n";
  assert.deepEqual([...changedPathsFromDiff(diff)], ["src/new.ts"]);
});

test("changedPathsFromDiff: a DELETED file (+++ /dev/null) still contributes its a/ path", () => {
  const diff =
    "diff --git a/src/gone.ts b/src/gone.ts\ndeleted file mode 100644\nindex 1111111..0000000\n--- a/src/gone.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-content\n";
  assert.deepEqual([...changedPathsFromDiff(diff)], ["src/gone.ts"]);
});

test("changedPathsFromDiff: a RENAME contributes BOTH the old and new path", () => {
  const diff =
    "diff --git a/src/old-name.ts b/src/new-name.ts\nsimilarity index 100%\nrename from src/old-name.ts\nrename to src/new-name.ts\n";
  assert.deepEqual([...changedPathsFromDiff(diff)].sort(), ["src/new-name.ts", "src/old-name.ts"]);
});

test("changedPathsFromDiff: empty diff text -> empty set (never throws)", () => {
  assert.deepEqual([...changedPathsFromDiff("")], []);
});

test("changedPathsFromDiff: a path NOT mentioned anywhere in the diff is correctly absent (the negative case resolveFindingPath relies on)", () => {
  const diff = "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  assert.equal(changedPathsFromDiff(diff).has("src/bar.ts"), false);
});

// resolveFindingPath wired directly to a real changedPathsFromDiff output (not a hand-built Set) —
// closes the gap between the two primitives being unit-correct in isolation and actually composing.

test("resolveFindingPath + changedPathsFromDiff compose correctly: a path the diff touches is kept, one it doesn't is dropped", () => {
  const diff = "diff --git a/src/foo.ts b/src/foo.ts\n--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-old\n+new\n";
  const changed = changedPathsFromDiff(diff);
  const kept = resolveFindingPath({ id: "f1", body: "x", path: "src/foo.ts" }, changed);
  assert.equal(kept.path, "src/foo.ts");
  assert.equal(kept.pathDropped, undefined);
  const dropped = resolveFindingPath({ id: "f2", body: "x", path: "src/bar.ts" }, changed);
  assert.equal(dropped.path, undefined);
  assert.equal(dropped.pathDropped, true);
});

// ── structural invariants the issue's own ACs require ───────────────────────────────────────────

test("finding-axes.ts imports nothing from roles/reviewer.ts beyond the Finding type (issue #448 AC)", () => {
  const source = readFileSync(new URL("./finding-axes.ts", import.meta.url), "utf8");
  const importLines = source.split("\n").filter((l) => l.includes('from "../roles/reviewer.js"'));
  assert.equal(importLines.length, 1, "expected exactly one import from roles/reviewer.js");
  assert.match(importLines[0]!, /^import type \{ Finding \} from "\.\.\/roles\/reviewer\.js";$/);
});

// ── grep invariant (#448 verification plan item 9): this PR touches no human-merge-only path ────
// Mirrors audit.test.ts's own "read the protected source, assert this feature's machinery never
// leaked into it" pattern (audit.test.ts: "audit body carries per-AC/findings/provenance but
// never matches approval parsers" reads reviewer.ts and asserts it stayed free of audit.ts's own
// symbols). guard.ts's PROTECTED_SUFFIXES (human-merge-only, #448 must not edit any of them) are
// read here and asserted free of every symbol this issue's implementation introduces.
test("#448: no PROTECTED_SUFFIXES source file contains this issue's new symbols (guard/reviewer/merge-driver never touched)", () => {
  const protectedFiles = [
    new URL("../guard/guard.ts", import.meta.url),
    new URL("../guard/guard-hook.ts", import.meta.url),
    new URL("../roles/reviewer.ts", import.meta.url),
    new URL("../roles/merge-driver.ts", import.meta.url),
  ];
  const introducedSymbols = [
    "ClassifiedFinding",
    "FINDING_KINDS",
    "ALLOWED_FINDING_KEYS",
    "ADVISORY_ELIGIBLE_KINDS",
    "effectiveSeverity",
    "applySeverityOverride",
    "resolveFindingPath",
    "changedPathsFromDiff",
    "severityOverridden",
    "pathDropped",
    "finding-axes",
  ];
  for (const url of protectedFiles) {
    const source = readFileSync(url, "utf8");
    for (const symbol of introducedSymbols) {
      assert.doesNotMatch(source, new RegExp(symbol), `${url.pathname} unexpectedly references ${symbol}`);
    }
  }
});
