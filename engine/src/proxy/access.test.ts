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
    "verification-plan-reviewer",
    "verification-plan-drafter",
    "verification-plan-reviewer-confirm",
    "retro",
  ]) {
    assert.deepEqual([...allowedToolsForRole(role)].sort(), [...ISSUE_TOOLS].sort(), `role: ${role}`);
  }
});

// #413: the gate⓪ role ids are a deny-by-default MATRIX KEY, so a rename that misses this table
// fails CLOSED — the role silently degrades to no tools at all instead of erroring. These two
// tests are the tripwire for exactly that: the first pins the post-rename ids to the issue-tool
// set, the second proves no id in the table resolves to the empty fallback (which is what a
// half-applied rename would leave behind, and what the pre-#413 ids must now do).
test("#413: every PROXY_ROLE_TOOL_MATRIX id resolves to a non-empty tool set — no key silently falls through to the deny-by-default empty array", () => {
  const ids = Object.keys(PROXY_ROLE_TOOL_MATRIX);
  assert.ok(ids.length > 0, "matrix is not empty");
  for (const role of ids) {
    assert.notDeepEqual(allowedToolsForRole(role), [], `matrix key resolves to the empty deny-by-default fallback: ${role}`);
  }
});

test("#413: the pre-rename gate⓪ role ids are GONE from the matrix — a stale caller gets deny-by-default, not a quiet second grant", () => {
  for (const stale of ["plan-reviewer", "plan-drafter", "plan-reviewer-confirm"]) {
    assert.equal(stale in PROXY_ROLE_TOOL_MATRIX, false, `stale id still present: ${stale}`);
    assert.deepEqual(allowedToolsForRole(stale), [], `stale id still granted tools: ${stale}`);
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
