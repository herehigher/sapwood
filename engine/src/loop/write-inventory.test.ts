// #796: the structured-output write inventory's BIDIRECTIONAL completeness check — the machine
// half of docs/PLAN.md's own claim ("every future … change … updates the table below in the
// same PR, and gate② checks that it did"). Before this test, that sentence was prose only: #212
// shipped `po-pool` in 2026-07-16 and #233 re-gated it behind its own switch, and neither change
// ever touched the table (issue #796's own finding). Same doc-vs-code cross-check TECHNIQUE as
// escalation-buckets.test.ts:670 (reads docs/PLAN.md, asserts it agrees with the code), extended
// to a REGISTRY-DRIVEN inventory (write-inventory-registry.ts) rather than a single fact,
// following probe-signals.ts/probe-signals.test.ts's "one declarative array, one inventory test"
// shape.
//
// Two directions, checked separately so each has its own failure message naming the offending
// id:
//   1. registry -> table: every WRITE_INVENTORY_ROLE_SESSIONS entry's `tableRole` must appear as
//      a `<!-- sapwood:write-inventory-role:… -->` marker somewhere in docs/PLAN.md's table. A
//      structured-output write path with no row is exactly the #796 finding.
//   2. table -> registry: every `<!-- sapwood:write-inventory-role:… -->` marker id found in
//      docs/PLAN.md must appear as SOME entry's `tableRole` in the registry. A table row naming
//      a role with no real write path is dead documentation asserting a guarantee about
//      nothing.
//
// A test that only checked one direction would pass with a row deleted (direction 2 vacuously
// holds — no orphan row) or with a bogus row added (direction 1 vacuously holds — the real roles
// are all still there); see the PR body for both mutation probes run against this exact test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WRITE_INVENTORY_ROLE_SESSIONS } from "./write-inventory-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");

const MARKER_RE = /<!--\s*sapwood:write-inventory-role:([a-z0-9-]+)\s*-->/g;

function readPlanTableMarkers(): string[] {
  const plan = readFileSync(join(REPO_ROOT, "docs", "PLAN.md"), "utf8");
  const found: string[] = [];
  for (const m of plan.matchAll(MARKER_RE)) {
    const id = m[1];
    if (id) found.push(id);
  }
  return found;
}

test("#796: docs/PLAN.md's write-inventory table carries a marker for every registry entry (registry -> table)", () => {
  const tableRoles = new Set(readPlanTableMarkers());
  const expected = new Set(WRITE_INVENTORY_ROLE_SESSIONS.map((e) => e.tableRole));
  for (const tableRole of expected) {
    assert.ok(
      tableRoles.has(tableRole),
      `write-inventory-registry.ts names "${tableRole}" as a structured-output write path, but docs/PLAN.md's ` +
        `write-inventory table has no "<!-- sapwood:write-inventory-role:${tableRole} -->" row marker for it — ` +
        `the table has silently gone incomplete`,
    );
  }
});

test("#796: every docs/PLAN.md write-inventory row marker names a real registry role (table -> registry)", () => {
  const tableRoles = readPlanTableMarkers();
  const expected = new Set(WRITE_INVENTORY_ROLE_SESSIONS.map((e) => e.tableRole));
  assert.ok(tableRoles.length > 0, "docs/PLAN.md's write-inventory table has no row markers at all — parse regressed");
  for (const tableRole of tableRoles) {
    assert.ok(
      expected.has(tableRole),
      `docs/PLAN.md's write-inventory table has a row marked "<!-- sapwood:write-inventory-role:${tableRole} -->", ` +
        `but write-inventory-registry.ts has no entry naming it as a real structured-output write path — ` +
        `the row documents a role that doesn't exist (or the registry's tableRole drifted from the doc)`,
    );
  }
});

test("#796: docs/PLAN.md's write-inventory table has exactly one row per distinct tableRole (no accidental duplicate/split row)", () => {
  const tableRoles = readPlanTableMarkers();
  const counts = new Map<string, number>();
  for (const id of tableRoles) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) {
    assert.equal(count, 1, `"${id}" is marked on ${count} separate docs/PLAN.md table rows — expected exactly one`);
  }
});

test("#796: docs/role-paradigm.md's per-role sections cover every write-inventory tableRole", () => {
  const roleParadigm = readFileSync(join(REPO_ROOT, "docs", "role-paradigm.md"), "utf8");
  const expected = new Set(WRITE_INVENTORY_ROLE_SESSIONS.map((e) => e.tableRole));
  for (const tableRole of expected) {
    // Sub-sections are `### <tableRole> (...)`, e.g. `### po-pool (aligning)`, `### harvest
    // (harvesting)`, or the shared `### po (aligning)` header, which covers BOTH "po-aligning"
    // (po-align/po-triage) and "po-decompose" (the decompose sub-mode is documented as a
    // subsection of the SAME `### po (aligning)` heading, per `#### PO decompose sub-mode`
    // immediately below it — decompose has no separate top-level per-role section of its own),
    // or the pair header `### verification-plan-reviewer + verification-plan-drafter
    // (plan_review) — one gate⓪ adversarial pair`, which names both reviewer/drafter tableRoles
    // literally. A per-role heading is `### <id> (...)` (po-pool, architect, harvest, retro) or
    // contains the literal role id somewhere in a `###` heading line (the reviewer/drafter
    // pair's own two ids).
    const headingLines = roleParadigm.split("\n").filter((l) => l.startsWith("### "));
    const covered = headingLines.some((l) => {
      if (tableRole === "po-aligning" || tableRole === "po-decompose") return /^### po \(/.test(l);
      return l.includes(tableRole);
    });
    assert.ok(
      covered,
      `write-inventory-registry.ts names "${tableRole}" as a structured-output write path, but docs/role-paradigm.md's ` +
        `"Per-role sections" has no heading covering it`,
    );
  }
});
