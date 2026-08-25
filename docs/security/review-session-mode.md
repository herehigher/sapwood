# Review session mode

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for review session mode.

## Review session mode: closed MCP/settings surface, forced-hard guard

The engine-agent reviewer runs a static review session against an already-**materialized**
tree — `review/materializer.ts`'s private-clone checkout of the exact reviewed commit, with no
`.git` at all (D1: static-only, no producer-code execution).

That materialized cwd is **producer-controlled content** — the PR head under review. The
ambient-context boundary ("what a session can *read* is not the boundary" — see [Ambient repo
context: record, don't
seal](ambient-repo-context.md#ambient-repo-context-record-dont-seal)) therefore needs one closure
specific to review sessions.

A materialized tree can carry its own `.mcp.json` or `.claude/settings.json`. Neither the
`--disallowedTools Bash` grant nor the PreToolUse guard hook mediates MCP-server-process launches
or settings-declared hooks at all — both fire at session **init**, before any tool call either
mechanism could ever intercept. `peripheral.ts`'s `RoleRunner.run({ reviewCwd })` closes this,
hardcoded (not caller-overridable) for every review session:

| Invariant | Enforcement point | Test |
| --- | --- | --- |
| `--strict-mcp-config` + an explicit empty `--mcp-config` load zero MCP servers from any source, regardless of what the materialized tree's own `.mcp.json` declares. | `worker.ts::claudeArgs`; `peripheral.ts::RoleRunner.run` (hardcodes both for `reviewCwd`) | `peripheral.test.ts:2799`; `review-session.test.ts:235` |
| `--setting-sources ""` loads ZERO file settings sources — not user, project, or local; only the inline guard `--settings` applies. | `worker.ts::claudeArgs`; `peripheral.ts::RoleRunner.run` (hardcodes `settingSources: ""`) | `peripheral.test.ts:2839`; `review-session.test.ts:278` |
| The guard hook rides in on inline `--settings` (`guardSettings()`'s JSON, never a file) — a separate mechanism `--setting-sources` doesn't touch; its containment root (`SAPWOOD_WORKTREE_ROOT`) is the materialized tree. | `worker.ts::guardSettings`; `peripheral.ts::RoleRunner.run`; `guard.ts::checkReadContainment` | `review-session.test.ts`: "LIVE containment: guard-hook.ts ... BLOCKS a Read outside the materialized tree" |
| Guard mode is forced `hard` for every review session (`SAPWOOD_GUARD_MODE=hard`), regardless of the configured `guard.mode`. | `peripheral.ts::RoleRunner.run` | `peripheral.test.ts:2847`; `review-session.test.ts`: "LIVE containment ... under a configured soft guard.mode, a review session still blocks" |
| The tool profile is `Read`/`Grep`/`Glob` only — `Write`/`Edit`/`MultiEdit`/`NotebookEdit`/`Bash`/`Agent`/`Task` all denied, so a review session structurally never writes — and the no-forge-proxy rule is hardcoded for `reviewCwd`; a caller-supplied `allowedTools`/`disallowedTools`/`proxy` throws, never silently overridden. | `peripheral.ts::RoleRunner.run` | `peripheral.test.ts:1040,2761,2971` |
| A missing materialized directory at spawn time is a setup failure mapping to `session-unavailable`, never a silent degraded run. | `peripheral.ts::RoleRunner.run` | `peripheral.test.ts:2945` |
| The materialized tree comes from a private, origin-verified clone that discards and re-clones on any local-config drift; hooks and dangerous git config keys are disabled/rejected. | `review/materializer.ts::createPrivateClone` | `materializer.test.ts`: "fails closed on core.hooksPath"; "config-clean is re-asserted on every reuse" |
| Checkout disables replacement objects, writes symlinks as plain text, and yields a `.git`-free tree with a post-checkout OID verification and a hashed manifest. | `review/materializer.ts::materialize` | `materializer.test.ts`: "--no-replace-objects is load-bearing"; "a tracked symlink materializes as a plain regular text file ... manifest recorded" |
| The session's structured output is data, not instructions — a strict schema accepts only complete per-AC judgments/findings, and deterministic code alone derives the verdict. | `review/agent-output.ts::validateAgentReviewOutput`, `::deriveApprovalResult` | `agent-output.test.ts`: "extra top-level key (e.g. overall) -> null" |
| Every finding's prose is escaped and blockquoted before it reaches the PR comment, so it cannot match an external verdict parser; audit comments are never read back as gate② approvals. | `review/audit.ts::buildAuditComment` | `audit.test.ts`: "hostile finding bodies cannot inject approval-parseable lines into the audit comment" |

**Residuals.** Excluding `user` settings (not just `project`/`local`) closes a specific gap: a
worker leg's `Bash(node *)`/`Bash(npm *)` grant runs with the operator's REAL `$HOME` and, absent
an operator-configured Bash sandbox, is not filesystem-confined from it.

See [Execution profiles](execution-profiles.md#execution-profiles-host-permission-mode--bash-sandbox)
for the operator recipe that closes the named-path subset of that gap, and
[role-sessions.md's Worker-leg user-settings persistence
vector](role-sessions.md#worker-leg-user-settings-persistence-vector--detect--disclose) for how
ordinary WORKER legs (as opposed to review-session mode) are covered instead.

Instruction files remain present in the materialized tree by design; their authority risk is
handled by [instruction-path
escalation](instruction-path-escalation.md#instruction-path-changes-escalate-to-human-review),
while the closed session profile above prevents a producer's own MCP/settings files in that tree
from gaining an execution channel.

### Benchmark isolation recipe (evals only — never production)

**Not to be confused with the guard-hook read containment above.** This recipe's `--bare` flag
seals a session's ambient context (no repo/user `CLAUDE.md`, no auto-memory, no MCP) for
reproducible eval comparisons — a different goal from the guard hook's containment, which confines
an ordinary session's `Read`/`Grep`/`Glob` tool calls to its own worktree while leaving ambient
`CLAUDE.md` absorption open ([Ambient repo context: record, don't
seal](ambient-repo-context.md#ambient-repo-context-record-dont-seal)). Production dispatch never
uses `--bare` — see why below.

Isolation is the *correct* tool for one use case: comparing models/prompts/configs in a controlled
eval where ambient repo/user state must NOT leak into the comparison. For that case only, run
`claude -p` against a **clean, throwaway directory** with explicit, full prompt injection instead
of ambient discovery:

- **`--bare` is MANDATORY, not optional.** Without it, `~/.claude` and the current-directory
  config still load underneath whatever flags you pass (`--settings` is *additive*, not a
  replacement; `--mcp-config` can retain ambient MCP servers rather than fully overriding them) —
  hand-picking flags without `--bare` does not achieve isolation. `--bare` skips hooks, LSP, plugin
  sync, attribution, auto-memory, background prefetches, keychain reads, and `CLAUDE.md`
  auto-discovery in one flag, and sets `CLAUDE_CODE_SIMPLE=1`.
- a fresh, empty working directory (no repo `CLAUDE.md`, no prior session state);
- `--system-prompt` / `--system-prompt-file` and `--append-system-prompt[-file]` to supply exactly
  the context the eval wants the model to have, explicitly (`--bare`'s own doc names these as the
  intended way to inject context under it);
- `--add-dir` only for the specific paths the eval needs;
- `--mcp-config` (fully replacing, not augmenting, the MCP surface) or omit MCP entirely, plus
  `--settings`, to pin the exact tool/MCP surface rather than inheriting whatever's ambient on the
  runner machine;
- `--agents`/`--plugin-dir` pinned or omitted, same rationale.

**Not acceptable for production dispatch under any configuration**: `--bare` disables hooks, and
the fail-closed guard hook (`guard.ts`) is the actual producer≠reviewer≠merger safety boundary this
whole page describes — running without it is running unguarded, full stop. Benchmark runs are a
separate, offline, human-supervised activity; they never feed sapwood's own dispatch loop.
