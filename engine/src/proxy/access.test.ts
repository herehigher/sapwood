// access.test.ts (#244): the forge MCP proxy's role x tool allow/deny matrix — pure lookup,
// deny-by-default for any role not in the table.
import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedToolsForRole, PROXY_ROLE_TOOL_MATRIX } from "./access.js";
import { ISSUE_TOOLS, PR_TOOLS, TOOL_NAMES } from "./tools.js";

test("allowedToolsForRole: every issue-oriented peripheral role gets exactly ISSUE_TOOLS", () => {
  for (const role of [
    "po-pool",
    "po-align",
    "po-triage",
    "harvest",
    "architect",
    "plan-reviewer",
    "plan-drafter",
    "plan-reviewer-confirm",
    "retro",
  ]) {
    assert.deepEqual([...allowedToolsForRole(role)].sort(), [...ISSUE_TOOLS].sort(), `role: ${role}`);
  }
});

test("allowedToolsForRole: the fix-loop worker leg gets exactly PR_TOOLS", () => {
  assert.deepEqual([...allowedToolsForRole("worker")].sort(), [...PR_TOOLS].sort());
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
