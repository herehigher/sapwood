// #796: the structured-output write inventory's completeness check — the machine half of
// docs/PLAN.md's own claim ("every future … change … updates the table below in the same PR,
// and gate② checks that it did"). Before this test, that sentence was prose only: #212 shipped
// `po-pool` in 2026-07-16 and #233 re-gated it behind its own switch, and neither change ever
// touched the table (issue #796's own finding). Same doc-vs-code cross-check TECHNIQUE as
// escalation-buckets.test.ts:670 (reads docs/PLAN.md, asserts it agrees with the code), extended
// to a REGISTRY-DRIVEN inventory (write-inventory-registry.ts) rather than a single fact,
// following probe-signals.ts/probe-signals.test.ts's "one declarative array, one inventory test"
// shape.
//
// THREE directions, checked separately so each has its own failure message naming the offending
// id — a test checking only one or two would pass with real gaps still open (see this file's own
// git-blame / PR #816 gate② round 1 for exactly that: two doc-only directions shipped first, and
// an independent review reproduced two ways past them — a registry+row deleted while the real
// PRODUCTION dispatch site was left in place stayed green, and moving a marker off its table row
// into ordinary prose also stayed green):
//   1. registry -> table: every WRITE_INVENTORY_ROLE_SESSIONS entry's `tableRole` must appear as
//      a `<!-- sapwood:write-inventory-role:… -->` marker on some row of docs/PLAN.md's
//      write-inventory table specifically (never just anywhere in the file — see direction 2's
//      own doc on why "table row" is parsed structurally, not file-wide).
//   2. table -> registry: every marker found on an actual table row must name a real registry
//      `tableRole`. `readInventoryTableRows` bounds the scan to the table's own `| … |` rows —
//      found by locating the table's header row and reading contiguous table-row-shaped lines
//      until the first non-row line — so a marker sitting in ordinary prose (even reusing the
//      exact same HTML-comment text) is NOT a table row and does not count in EITHER direction.
//   3. source -> registry: every `roleId: "…"` literal dispatch site found by scanning
//      `engine/src` (production code only — `*.test.ts` and this file's own sibling registry
//      excluded) must be a `roleId` in the registry OR named, with a reason, in
//      `WRITE_INVENTORY_NON_REGISTRY_ROLE_IDS`. Directions 1/2 only ever check the registry
//      against the DOCS — nothing forced a genuinely NEW write-driving dispatch site to be
//      registered in the first place. This direction is what actually catches that: it is
//      driven by grepping real source, not the hand-maintained registry echoing itself.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WRITE_INVENTORY_NON_REGISTRY_ROLE_IDS, WRITE_INVENTORY_ROLE_SESSIONS } from "./write-inventory-registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..", "..", "..");
const ENGINE_SRC = join(HERE, "..");

const MARKER_RE = /<!--\s*sapwood:write-inventory-role:([a-z0-9-]+)\s*-->/g;
const TABLE_HEADER_PREFIX = "| Role | Output fields";

const isTableRowShaped = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|");
};

/** The write-inventory table's own `| … |` rows, and ONLY those — bounded by locating the
 *  table's header row (`| Role | Output fields → engine write | … |`) and reading forward past
 *  the `|---|---|…` separator row, collecting contiguous table-row-shaped lines until the first
 *  line that isn't one (the table's own trailing blank line, in practice). This is what makes
 *  direction 2 (and the duplicate-row check below) a claim about THE TABLE, not about
 *  docs/PLAN.md as a whole — see this file's own module doc, direction 2, for the probe this
 *  bound exists to catch (a marker relocated into ordinary prose must NOT count). */
function readInventoryTableRows(): string[] {
  const plan = readFileSync(join(REPO_ROOT, "docs", "PLAN.md"), "utf8");
  const lines = plan.split("\n");
  const headerIdx = lines.findIndex((l) => l.startsWith(TABLE_HEADER_PREFIX));
  assert.ok(
    headerIdx >= 0,
    "docs/PLAN.md's write-inventory table header row was not found — table structure changed, this scan needs updating",
  );
  const rows: string[] = [];
  // headerIdx + 1 is the `|---|---|...` separator row; data rows start at headerIdx + 2.
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !isTableRowShaped(line)) break;
    rows.push(line);
  }
  assert.ok(rows.length > 0, "docs/PLAN.md's write-inventory table header was found but no data rows followed it — parse regressed");
  return rows;
}

function readPlanTableMarkers(): string[] {
  const found: string[] = [];
  for (const row of readInventoryTableRows()) {
    for (const m of row.matchAll(MARKER_RE)) {
      const id = m[1];
      if (id) found.push(id);
    }
  }
  return found;
}

test("#796: docs/PLAN.md's write-inventory table carries a row marker for every registry entry (registry -> table)", () => {
  const tableRoles = new Set(readPlanTableMarkers());
  const expected = new Set(WRITE_INVENTORY_ROLE_SESSIONS.map((e) => e.tableRole));
  for (const tableRole of expected) {
    assert.ok(
      tableRoles.has(tableRole),
      `write-inventory-registry.ts names "${tableRole}" as a structured-output write path, but docs/PLAN.md's ` +
        `write-inventory table has no "<!-- sapwood:write-inventory-role:${tableRole} -->" ROW marker for it — ` +
        `the table has silently gone incomplete`,
    );
  }
});

test("#796: every docs/PLAN.md write-inventory ROW marker names a real registry role (table -> registry)", () => {
  const tableRoles = readPlanTableMarkers();
  const expected = new Set(WRITE_INVENTORY_ROLE_SESSIONS.map((e) => e.tableRole));
  for (const tableRole of tableRoles) {
    assert.ok(
      expected.has(tableRole),
      `docs/PLAN.md's write-inventory table has a row marked "<!-- sapwood:write-inventory-role:${tableRole} -->", ` +
        `but write-inventory-registry.ts has no entry naming it as a real structured-output write path — ` +
        `the row documents a role that doesn't exist (or the registry's tableRole drifted from the doc)`,
    );
  }
});

test("#796: a marker OUTSIDE the table's own rows (e.g. relocated into prose) is never counted by either direction", () => {
  // Direct proof the table-row bound in readInventoryTableRows/readPlanTableMarkers is load-
  // bearing, not just implied by the two tests above passing on the real file: construct a PLAN
  // text with the SAME marker moved off its row into an ordinary paragraph after the table, and
  // confirm it is invisible to the marker reader.
  const table = "| Role | Output fields |\n|---|---|\n| **po-pool** <!-- sapwood:write-inventory-role:po-pool --> | x |\n";
  const proseAfter = "\nSome prose mentioning <!-- sapwood:write-inventory-role:po-nonexistent --> in passing, not a row.\n";
  const lines = (table + proseAfter).split("\n");
  const headerIdx = lines.findIndex((l) => l.startsWith(TABLE_HEADER_PREFIX));
  const rows: string[] = [];
  for (let i = headerIdx + 2; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined || !isTableRowShaped(line)) break;
    rows.push(line);
  }
  const found: string[] = [];
  for (const row of rows) for (const m of row.matchAll(MARKER_RE)) if (m[1]) found.push(m[1]);
  assert.deepEqual(found, ["po-pool"], "the in-row marker must be found and the prose-relocated one must NOT be");
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

// ── #796 gate② (sol-high P1a): source -> registry — the direction that binds a REAL production ────
// dispatch site to the registry, not just the registry to the docs. See this file's module doc,
// direction 3.

const ROLE_ID_LITERAL_RE = /\broleId:\s*"([^"]+)"/g;
/** This file's sibling registry is excluded from the scan on purpose — its own array literals
 *  ARE the registry, not a second production dispatch site restating it. */
const REGISTRY_BASENAME = "write-inventory-registry.ts";

type DispatchSite = { roleId: string; file: string };

function walkProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkProductionTsFiles(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && entry.name !== REGISTRY_BASENAME) {
      out.push(full);
    }
  }
  return out;
}

/** Every `roleId: "…"` literal-string dispatch site in production `engine/src` — the SAME
 *  convention every real call site in write-inventory-registry.ts's `callSite` comments points
 *  at (`grep -rn 'roleId:\s*"' engine/src` confirms it: every non-test, non-registry hit today
 *  IS a real session dispatch — `align.ts`, `decompose.ts`, `architect.ts`, `plan-review.ts`,
 *  `harvest.ts`, `retro/retro.ts`, `review/engine-agent.ts`). Honest bound: this only recognizes
 *  a LITERAL string at the call site; a `roleId` assembled from a variable or template would
 *  evade it silently. Today's codebase has none (verified by the same grep) — a future
 *  non-literal dispatch is a documented blind spot, not a currently-live one. */
function scanProductionRoleIdDispatchSites(): DispatchSite[] {
  const sites: DispatchSite[] = [];
  for (const file of walkProductionTsFiles(ENGINE_SRC)) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(ROLE_ID_LITERAL_RE)) {
      const roleId = m[1];
      if (roleId) sites.push({ roleId, file: relative(REPO_ROOT, file) });
    }
  }
  return sites;
}

test("#796: the source scan actually finds production roleId dispatch sites (regression guard — a path/regex mistake must not silently turn this into a no-op)", () => {
  const sites = scanProductionRoleIdDispatchSites();
  assert.ok(
    sites.length > 0,
    "scanProductionRoleIdDispatchSites found ZERO roleId dispatch sites under engine/src — the walk or regex broke, " +
      "which would make the source -> registry direction below vacuously pass no matter what",
  );
});

test("#796: every production roleId dispatch site is a registered write-inventory entry or a justified allowlist entry (source -> registry, sol-high P1a)", () => {
  const sites = scanProductionRoleIdDispatchSites();
  const registered = new Set(WRITE_INVENTORY_ROLE_SESSIONS.map((e) => e.roleId));
  const allowlisted = new Set(WRITE_INVENTORY_NON_REGISTRY_ROLE_IDS.map((e) => e.roleId));
  const overlap = [...registered].filter((id) => allowlisted.has(id));
  assert.deepEqual(overlap, [], `roleId(s) [${overlap.join(", ")}] are in BOTH the registry and the allowlist — pick one, not both`);
  for (const site of sites) {
    assert.ok(
      registered.has(site.roleId) || allowlisted.has(site.roleId),
      `${site.file} dispatches a session with roleId "${site.roleId}", but write-inventory-registry.ts has no ` +
        `WRITE_INVENTORY_ROLE_SESSIONS entry AND no WRITE_INVENTORY_NON_REGISTRY_ROLE_IDS allowlist entry for it — ` +
        `a new structured-output dispatch site can exist without ever being accounted for here`,
    );
  }
});
