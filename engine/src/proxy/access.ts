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

/** #533 (PM ruling 2026-08-02, "2 keep / 7 remove"): #234's original 7-role issue-tool consumer
 *  set (pool/align/triage/harvest/architect/plan-review/retro) is narrowed to exactly TWO —
 *  every removal here is a DECISION, not an oversight; see issue #533's own comment "Ruling (PM
 *  proposal + fable architectural review, 2026-08-02) — 2 keep / 7 remove" (authoritative,
 *  supersedes the issue body) and docs/security.md's forge MCP proxy table for the full per-role
 *  reasoning. The two-step test the ruling applies to every role: (1) CHARTER — is the job
 *  defined over a SET of issues, or over one substituted
 *  artifact? Only the former is a lookup candidate. (2) CLOSEDNESS — if that set is knowable and
 *  small, SUBSTITUTE it; a lookup wins only when the target set is genuinely open-ended.
 *
 *  - `po-align` — KEEP. Dedup runs against the WHOLE backlog (po.md's unconditional
 *    `search_issues` step on every proposal's key terms) — genuinely open-ended, fails
 *    closedness.
 *  - `architect` — KEEP, ask rewritten (architect.md's "Cross-issue search" step): finds related
 *    open/recently-updated issues OUTSIDE this round's pool — by definition not a substitutable
 *    closed set.
 *  - `po-pool` — REMOVE. Its target (the round's OWN candidate pool) is closed and small
 *    (`ceil(roundDispatchCap × poolFactor)`) — the architect phase already substitutes every
 *    pool member's full body one phase later at this exact cost, so `align.ts`'s
 *    `buildPoolCandidateDigest` now substitutes the same `formatCandidate`-shaped body instead
 *    of granting a tool a conditional ask measured at zero calls.
 *  - `po-triage` — REMOVE (demand, not surface: the substituted body suffices; zero measured
 *    need. `WebFetch` — a default grant, unaffected by this change — reaches github.com anyway,
 *    so this narrows a journaled path while an unjournaled one remains: a net GitHub-read
 *    surface change of about zero).
 *  - `plan-reviewer` / `plan-drafter` / `plan-reviewer-confirm` — REMOVE. Each judges/drafts ONE
 *    substituted artifact (an issue body, a reviewer brief, a repo-drift question a READ-ONLY
 *    worktree checkout already answers) — charter fails at step 1.
 *  - `harvest` — REMOVE. Targets arrive as bare `#N`; comments are round-stats boilerplate; the
 *    prompt already forbids expanding targets — charter fails at step 1.
 *  - `retro` — REMOVE. Repairs a live declared-session-contract drift: `retro.md` already said
 *    "you have no `gh` access at all" while this matrix granted it `ISSUE_TOOLS` — removing the
 *    grant makes that sentence true with NO prose edit. Also: retro is the one peripheral role
 *    with a real write channel (a pushed branch); minimum ambient read matters most exactly here.
 *
 *  The fix-loop worker leg (#244/#288, the M9 fix loop's evidence channel for PR review data)
 *  gets the PR-facing tools only: a worker's own issue body already reaches it via the prompt
 *  template (worker.ts's `{{issue.body}}` substitution), so the issue tools would be redundant
 *  there, and granting them would widen a worker's forge-read surface beyond what its job needs.
 *  Untouched by #533 — out of scope (the ruling's own disposition table). */
export const PROXY_ROLE_TOOL_MATRIX: Readonly<Record<string, readonly ToolName[]>> = Object.freeze({
  "po-align": ISSUE_TOOLS,
  architect: ISSUE_TOOLS,
  worker: PR_TOOLS,
});

/** The tools `role` may call — `[]` (deny-by-default) for any role not in the matrix above,
 *  never a thrown error or an implicit allow-all. Pure, total function: every input has a
 *  defined output. */
export function allowedToolsForRole(role: string): readonly ToolName[] {
  return PROXY_ROLE_TOOL_MATRIX[role] ?? [];
}
