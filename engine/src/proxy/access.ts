// proxy/access.ts — #244: the role x tool allow/deny matrix for the forge MCP proxy, folded into
// #235's existing allow/deny matrix (docs/security.md's role x tool table). This is the ONE
// table that decides which of the fixed-algebra tools (tools.ts's TOOL_NAMES) a given session
// role may call — mcp-server.ts's handleToolCall is the REAL enforcement point (server-side,
// fail-closed), and startForgeProxyServer's own `toolNames` output (the `--allowedTools` CLI
// widening) is scoped to the same subset, so the CLI-level noise-reduction layer and the actual
// boundary never disagree.
//
// DENY-BY-DEFAULT (issue #244 AC): a role id absent from PROXY_ROLE_TOOL_MATRIX is granted NO
// tool at all — allowedToolsForRole falls back to an empty array via `??`, never a default-allow
// branch a future edit could forget to wire. This mirrors #235 PR-A's guard-hook stance: an
// unrecognized case fails closed, not open.
import { ISSUE_TOOLS, PR_TOOLS, type ToolName } from "./tools.js";

/** Issue-oriented peripheral roles (#234's original consumer set: pool/align/triage/harvest/
 *  architect/plan-review/retro) keep the 4 issue tools — unchanged by this PR. The fix-loop
 *  worker leg (#244, the M9 fix loop's evidence channel for PR review data) gets the 4 NEW
 *  PR-facing tools only: a worker's own issue body already reaches it via the prompt template
 *  (worker.ts's `{{issue.body}}` substitution), so the issue tools would be redundant there, and
 *  granting them would widen a worker's forge-read surface beyond what its job needs. */
export const PROXY_ROLE_TOOL_MATRIX: Readonly<Record<string, readonly ToolName[]>> = Object.freeze({
  "po-pool": ISSUE_TOOLS,
  "po-align": ISSUE_TOOLS,
  "po-triage": ISSUE_TOOLS,
  harvest: ISSUE_TOOLS,
  architect: ISSUE_TOOLS,
  "plan-reviewer": ISSUE_TOOLS,
  "plan-drafter": ISSUE_TOOLS,
  "plan-reviewer-confirm": ISSUE_TOOLS,
  retro: ISSUE_TOOLS,
  worker: PR_TOOLS,
});

/** The tools `role` may call — `[]` (deny-by-default) for any role not in the matrix above,
 *  never a thrown error or an implicit allow-all. Pure, total function: every input has a
 *  defined output. */
export function allowedToolsForRole(role: string): readonly ToolName[] {
  return PROXY_ROLE_TOOL_MATRIX[role] ?? [];
}
