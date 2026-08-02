// access.test.ts (#244): the forge MCP proxy's role x tool allow/deny matrix — pure lookup,
// deny-by-default for any role not in the table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedToolsForRole, PROXY_ROLE_TOOL_MATRIX } from "./access.js";
import { ISSUE_TOOLS, PR_TOOLS, TOOL_NAMES } from "./tools.js";

// #533 (PM ruling 2026-08-02, "2 keep / 7 remove"): the issue-tool consumer set is narrowed from
// 7 roles to exactly 2 — po-align (whole-backlog dedup, genuinely open-ended) and architect
// (cross-issue search for related open/recently-updated issues, also open-ended). See
// access.ts's own PROXY_ROLE_TOOL_MATRIX doc comment for the full per-role reasoning.
test("allowedToolsForRole: the two roles the #533 ruling kept get exactly ISSUE_TOOLS", () => {
  for (const role of ["po-align", "architect"]) {
    assert.deepEqual([...allowedToolsForRole(role)].sort(), [...ISSUE_TOOLS].sort(), `role: ${role}`);
  }
});

test("allowedToolsForRole: the fix-loop worker leg gets exactly PR_TOOLS", () => {
  assert.deepEqual([...allowedToolsForRole("worker")].sort(), [...PR_TOOLS].sort());
});

test("allowedToolsForRole: #533 removed roles now get NO tool — deny-by-default, same as any unrecognized role", () => {
  for (const role of ["po-pool", "po-triage", "harvest", "plan-reviewer", "plan-drafter", "plan-reviewer-confirm", "retro"]) {
    assert.deepEqual(allowedToolsForRole(role), [], `role: ${role}`);
    assert.ok(!(role in PROXY_ROLE_TOOL_MATRIX), `role "${role}" must be ABSENT from the matrix, not present with an empty array`);
  }
});

test("allowedToolsForRole: deny-by-default — an unrecognized role gets NO tool, never a default-allow", () => {
  for (const role of ["", "some-typo-d-role", "admin", "codex", "gate2-reviewer"]) {
    assert.deepEqual(allowedToolsForRole(role), [], `role: ${role}`);
  }
});

test("PROXY_ROLE_TOOL_MATRIX: every entry is a subset of the fixed tool algebra, and the matrix is frozen (cannot be mutated at a call site)", () => {
  for (const tools of Object.values(PROXY_ROLE_TOOL_MATRIX)) {
    for (const t of tools) assert.ok((TOOL_NAMES as readonly string[]).includes(t));
  }
  assert.throws(() => {
    (PROXY_ROLE_TOOL_MATRIX as Record<string, readonly string[]>).worker = [];
  });
});

test("allowedToolsForRole: ISSUE_TOOLS and PR_TOOLS never overlap — no role is simultaneously issue- and PR-scoped by accident", () => {
  const overlap = ISSUE_TOOLS.filter((t) => PR_TOOLS.includes(t));
  assert.deepEqual(overlap, []);
});
