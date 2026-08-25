// #796: the structured-output write inventory's completeness check — the machine half of the
// write-inventory section's own claim ("every future … change … updates the table below in the
// same PR, and gate② checks that it did"). Before this test, that sentence was prose only: #212
// shipped `po-pool` in 2026-07-16 and #233 re-gated it behind its own switch, and neither change
// ever touched the table (issue #796's own finding). Same doc-vs-code cross-check TECHNIQUE as
// escalation-buckets.test.ts:670 (reads docs/PLAN.md, asserts it agrees with the code), extended
// to a REGISTRY-DRIVEN inventory (write-inventory-registry.ts) rather than a single fact,
// following probe-signals.ts/probe-signals.test.ts's "one declarative array, one inventory test"
// shape.
//
// The section this test pins lives in docs/reference/role-paradigm.md (moved there from
// docs/PLAN.md by the docs/PLAN.md goal-shape cleanup — PLAN.md now keeps only a one-paragraph
// pointer to it); the doc-vs-code technique and the three directions below are unchanged by
// where the section lives.
//
// THREE directions, checked separately so each has its own failure message naming the offending
// id — a test checking only one or two would pass with real gaps still open (see PR #816 gate②
// rounds 1-2 for exactly that history: round 1 shipped two doc-only directions, an independent
// review reproduced two ways past them — a registry+row deleted while the real PRODUCTION
// dispatch site was left in place stayed green, and moving a marker off its table row into
// ordinary prose also stayed green; round 2 fixed both, but the table-row bound itself was still
// only "the first `| … |`-shaped header line in the WHOLE FILE" — round 2 review found a THIRD
// bypass: a decoy table inserted earlier in the doc, carrying every marker on its own rows, with
// the real po-pool marker stripped, stayed green because the scan locked onto the decoy's
// header, never the real one):
//   1. registry -> table: every WRITE_INVENTORY_ROLE_SESSIONS entry's `tableRole` must appear as
//      a `<!-- sapwood:write-inventory-role:… -->` marker on some row of THE write-inventory
//      table specifically — never just anywhere in the file, and never on some OTHER table that
//      merely looks like it (see `readInventoryTableRows`'s own doc for the section-anchored
//      bound this requires).
//   2. table -> registry: every marker found on an actual row of THE table must name a real
//      registry `tableRole`.
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
// The write-inventory section (heading + table) lives in docs/reference/role-paradigm.md, not
// docs/PLAN.md — see this file's own module doc.
const ROLE_PARADIGM_PATH = join(REPO_ROOT, "docs", "reference", "role-paradigm.md");
const ROLE_PARADIGM_CONTENT = readFileSync(ROLE_PARADIGM_PATH, "utf8");

const MARKER_RE = /<!--\s*sapwood:write-inventory-role:([a-z0-9-]+)\s*-->/g;

// #796 gate② round 3 (sol-high P2 residual): the UNIQUE anchor for "the real table," not just
// "a `| Role | Output fields` -shaped line somewhere in the file." Both strings are matched
// EXACTLY (whole-line equality, not a prefix test) — a decoy sharing only a prefix, or reusing
// this exact section heading text a second time, is exactly the ambiguity `readInventoryTableRows`
// below refuses to silently resolve.
const SECTION_HEADING = "### Validation depth ∝ decision weight (the structured-output write inventory)";
const TABLE_HEADER_LINE = "| Role | Output fields → engine write | Validation (`engine/src/…`) | Decision weight |";

const isTableRowShaped = (line: string): boolean => {
  const t = line.trim();
  return t.startsWith("|") && t.endsWith("|");
};

/** The write-inventory table's own `| … |` rows, and ONLY those. Two-stage anchor, not a
 *  file-wide scan:
 *
 *  1. Locate `SECTION_HEADING` — required to occur EXACTLY ONCE in `docContent`. Zero or
 *     multiple occurrences throws rather than guessing, per this function's whole point: a parse
 *     regression (the section renamed, or a second copy of the heading text appearing anywhere)
 *     must go RED, never silently resolve to "whichever one the code happened to find first."
 *  2. Within that section's own bound (up to the next `##`/`###` heading, or EOF) — NEVER
 *     outside it — locate `TABLE_HEADER_LINE`, again required to occur EXACTLY ONCE. Only then
 *     read forward past the `|---|---|…` separator row, collecting contiguous table-row-shaped
 *     lines until the first non-row line (the table's own trailing blank line, in practice).
 *
 *  Round 2's version anchored on "the first file-wide line starting with the header's prefix" —
 *  bounded to *a* table, not structurally to *the* inventory table. Round 3's own gate② review
 *  reproduced the gap directly: a decoy `| Role | Output fields |` table inserted EARLIER in
 *  the doc, with every marker moved onto ITS rows and po-pool's real marker removed, stayed
 *  green — the scan locked onto the decoy's header first. Anchoring to the section HEADING first
 *  closes it: nothing before that heading (where a decoy would have to sit to predate the real
 *  table) is ever examined at all. See this file's own decoy-table regression test below, which
 *  runs sol's exact probe through THIS function (not a reimplementation). */
function readInventoryTableRows(docContent: string): string[] {
  const lines = docContent.split("\n");

  const headingIdxs: number[] = [];
  for (let i = 0; i < lines.length; i++) if (lines[i] === SECTION_HEADING) headingIdxs.push(i);
  if (headingIdxs.length === 0) {
    throw new Error(
      `docs/reference/role-paradigm.md: the write-inventory section heading ${JSON.stringify(SECTION_HEADING)} was not found — ` +
        `the section was renamed or removed and this scan needs updating`,
    );
  }
  if (headingIdxs.length > 1) {
    throw new Error(
      `docs/reference/role-paradigm.md: the write-inventory section heading ${JSON.stringify(SECTION_HEADING)} appears ` +
        `${headingIdxs.length} times — ambiguous, refusing to guess which one bounds the real table`,
    );
  }
  const headingIdx = headingIdxs[0]!;

  let sectionEnd = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^#{2,3}\s/.test(lines[i]!)) {
      sectionEnd = i;
      break;
    }
  }

  const headerIdxs: number[] = [];
  for (let i = headingIdx + 1; i < sectionEnd; i++) if (lines[i] === TABLE_HEADER_LINE) headerIdxs.push(i);
  if (headerIdxs.length === 0) {
    throw new Error(
      `docs/reference/role-paradigm.md: no write-inventory table header row found under the ${JSON.stringify(SECTION_HEADING)} ` +
        `section — table structure changed, this scan needs updating`,
    );
  }
  if (headerIdxs.length > 1) {
    throw new Error(
      `docs/reference/role-paradigm.md: ${headerIdxs.length} write-inventory table header rows found under the ` +
        `${JSON.stringify(SECTION_HEADING)} section — ambiguous`,
    );
  }
  const headerIdx = headerIdxs[0]!;

  const rows: string[] = [];
  // headerIdx + 1 is the `|---|---|...` separator row; data rows start at headerIdx + 2, still
  // bounded by sectionEnd so a stray table-row-shaped line past the section can never leak in.
  for (let i = headerIdx + 2; i < sectionEnd; i++) {
    const line = lines[i];
    if (line === undefined || !isTableRowShaped(line)) break;
    rows.push(line);
  }
  if (rows.length === 0) {
    throw new Error(
      "docs/reference/role-paradigm.md's write-inventory table header was found but no data rows followed it — parse regressed",
    );
  }
  return rows;
}

function readDocTableMarkers(docContent: string): string[] {
  const found: string[] = [];
  for (const row of readInventoryTableRows(docContent)) {
    for (const m of row.matchAll(MARKER_RE)) {
      const id = m[1];
      if (id) found.push(id);
    }
  }
  return found;
}

/** Shared by the real (direction 1) test below AND the regression/probe tests further down, so
 *  every one of them exercises the SAME assertion code path — a probe "passing" by accident
 *  because it reimplemented a laxer check is exactly what round 2's own P2 fix was faulted for. */
function assertRegistryCoveredByTableMarkers(tableMarkers: readonly string[]): void {
  const found = new Set(tableMarkers);
  const expected = new Set(WRITE_INVENTORY_ROLE_SESSIONS.map((e) => e.tableRole));
  for (const tableRole of expected) {
    assert.ok(
      found.has(tableRole),
      `write-inventory-registry.ts names "${tableRole}" as a structured-output write path, but role-paradigm.md's ` +
        `write-inventory table has no "<!-- sapwood:write-inventory-role:${tableRole} -->" ROW marker for it — ` +
        `the table has silently gone incomplete`,
    );
  }
}

function assertTableMarkersNameRealRoles(tableMarkers: readonly string[]): void {
  const expected = new Set(WRITE_INVENTORY_ROLE_SESSIONS.map((e) => e.tableRole));
  for (const tableRole of tableMarkers) {
    assert.ok(
      expected.has(tableRole),
      `role-paradigm.md's write-inventory table has a row marked "<!-- sapwood:write-inventory-role:${tableRole} -->", ` +
        `but write-inventory-registry.ts has no entry naming it as a real structured-output write path — ` +
        `the row documents a role that doesn't exist (or the registry's tableRole drifted from the doc)`,
    );
  }
}

test("#796: role-paradigm.md's write-inventory table carries a row marker for every registry entry (registry -> table)", () => {
  assertRegistryCoveredByTableMarkers(readDocTableMarkers(ROLE_PARADIGM_CONTENT));
});

test("#796: every role-paradigm.md write-inventory ROW marker names a real registry role (table -> registry)", () => {
  assertTableMarkersNameRealRoles(readDocTableMarkers(ROLE_PARADIGM_CONTENT));
});

test("#796: role-paradigm.md's write-inventory table has exactly one row per distinct tableRole (no accidental duplicate/split row)", () => {
  const tableRoles = readDocTableMarkers(ROLE_PARADIGM_CONTENT);
  const counts = new Map<string, number>();
  for (const id of tableRoles) counts.set(id, (counts.get(id) ?? 0) + 1);
  for (const [id, count] of counts) {
    assert.equal(count, 1, `"${id}" is marked on ${count} separate role-paradigm.md table rows — expected exactly one`);
  }
});

// ── #796 gate② round 3 (sol-high P2 residual): regressions that run the REAL functions above ────
// against DOCTORED real content — never a local reimplementation of the scan (round 2's own unit
// test was faulted for exactly that: it could not have caught round 2's own bug, since it never
// called readInventoryTableRows/readDocTableMarkers at all).

test("#796 round-3 regression: a decoy table inserted BEFORE the real section, carrying every marker on its OWN rows, with po-pool's real marker stripped, still fails red naming po-pool", () => {
  // sol's exact probe: an earlier decoy `| Role | Output fields |` table whose rows carry every
  // registry tableRole's marker, plus the real po-pool row marker removed from the true table.
  const decoyTableRoles = [...new Set(WRITE_INVENTORY_ROLE_SESSIONS.map((e) => e.tableRole))];
  const decoyTable =
    "| Role | Output fields |\n|---|---|\n" +
    decoyTableRoles.map((r) => `| **${r}** <!-- sapwood:write-inventory-role:${r} --> | decoy row, not the real table |\n`).join("") +
    "\n";

  const poolMarker = " <!-- sapwood:write-inventory-role:po-pool -->";
  assert.ok(ROLE_PARADIGM_CONTENT.includes(poolMarker), "sanity: the real po-pool marker must be present before this probe strips it");
  const realTableWithoutPoolMarker = ROLE_PARADIGM_CONTENT.replace(poolMarker, "");

  const doctored = decoyTable + realTableWithoutPoolMarker;

  assert.throws(
    () => assertRegistryCoveredByTableMarkers(readDocTableMarkers(doctored)),
    /po-pool/,
    "a decoy table earlier in the file, carrying every marker on its own rows, must NOT satisfy the real " +
      "inventory's completeness check — the section-heading anchor must ignore everything before it",
  );
});

test("#796 round-3 regression: relocating po-pool's marker into ordinary prose after the real table still fails red, via the REAL function (not a reimplementation)", () => {
  const poolMarker = " <!-- sapwood:write-inventory-role:po-pool -->";
  assert.ok(ROLE_PARADIGM_CONTENT.includes(poolMarker), "sanity: the real po-pool marker must be present before this probe relocates it");
  const withoutRowMarker = ROLE_PARADIGM_CONTENT.replace(poolMarker, "");
  const doctored = `${withoutRowMarker}\n\nSome unrelated prose mentioning${poolMarker} in passing, not on a table row.\n`;

  assert.throws(
    () => assertRegistryCoveredByTableMarkers(readDocTableMarkers(doctored)),
    /po-pool/,
    "a marker relocated into ordinary prose, even reusing the exact same HTML-comment text, must not count as a row marker",
  );
});

test("#796: readInventoryTableRows throws (never silently passes) if the section heading is missing", () => {
  const doctored = ROLE_PARADIGM_CONTENT.replace(SECTION_HEADING, "### Renamed section, heading text no longer matches");
  assert.throws(() => readInventoryTableRows(doctored), /section heading/i);
});

test("#796: readInventoryTableRows throws (never silently passes) if the section heading is ambiguous (appears more than once)", () => {
  const doctored = `${ROLE_PARADIGM_CONTENT}\n\n${SECTION_HEADING}\n\n(a second copy of the heading text, no real table under it)\n`;
  assert.throws(() => readInventoryTableRows(doctored), /appears 2 times|ambiguous/i);
});

test("#796: readInventoryTableRows throws (never silently passes) if no table header row is found under the section", () => {
  const doctored = ROLE_PARADIGM_CONTENT.replace(TABLE_HEADER_LINE, "| Renamed | Header | Text | Here |");
  assert.throws(() => readInventoryTableRows(doctored), /header row/i);
});

test("#796: docs/reference/role-paradigm.md's per-role sections cover every write-inventory tableRole", () => {
  // ROLE_PARADIGM_CONTENT already holds this same file's content (the write-inventory table
  // moved here too) — reused rather than re-read.
  const roleParadigm = ROLE_PARADIGM_CONTENT;
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
      `write-inventory-registry.ts names "${tableRole}" as a structured-output write path, but docs/reference/role-paradigm.md's ` +
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
