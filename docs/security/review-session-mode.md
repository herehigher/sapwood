# Review session mode

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for review session mode.

## Review session mode: closed MCP/settings surface, forced-hard guard

The engine-agent reviewer runs a static review session directly against an
already-**materialized** tree — `review/materializer.ts`'s private-clone checkout of the exact
reviewed commit, with no `.git` at all (D1: static-only, no producer-code execution). Unlike an
ordinary worker/peripheral session, this materialized cwd is **producer-controlled content** — the
PR head under review — so the ambient-context posture the section above locks in ("what a session
can *read* is not the boundary") needs one further closure specific to this mode: a materialized
tree can carry its own `.mcp.json` or `.claude/settings.json`, and neither the `--disallowedTools
Bash` grant nor the PreToolUse guard hook mediates MCP-server-process launches or
settings-declared hooks at all — both fire at session **init**, before any tool call either
mechanism could ever intercept. `peripheral.ts`'s `RoleRunner.run({ reviewCwd })` closes this,
hardcoded (not caller-overridable) for every review session:

- **`--strict-mcp-config` + an explicit empty `--mcp-config '{"mcpServers":{}}'`** — zero MCP
  servers configured from any source (project/user/ambient included), regardless of what the
  materialized tree's own `.mcp.json` declares (the CLI never even reads it under
  `--strict-mcp-config`).
- **`--setting-sources ""`** — zero FILE-based settings sources loaded (neither `project` nor
  `local`, both resolved against the session's own cwd — the materialized/producer tree — nor
  `user`, the operator's own `~/.claude/settings.json`). Verified empirically against a live
  `claude` CLI (not assumed from `--help` text alone): with the default (unrestricted) sources, a
  debug-log run showed the CLI applying the operator's real `~/.claude/settings.json` permission
  entries at session init; with `--setting-sources ""`, that application never happened, while the
  CLI still ran a full turn cleanly (exit 0, empty stderr). Excluding `user` too — not just
  `project`/`local` — closes a specific residual this page already names above: a worker leg's
  `Bash(node *)`/`Bash(npm *)` grant runs with the operator's REAL `$HOME` and, absent an
  operator-configured Bash sandbox, is not filesystem-confined from it (the "forge MCP proxy"
  section's `workerCredentialFreeEnv` HONEST SCOPE note, and its `steal.mjs` proof-of-concept —
  see also [Execution profiles](execution-profiles.md#execution-profiles-host-permission-mode--bash-sandbox) for the
  operator recipe that closes the named-path subset of this residual), so a producer could in
  principle have
  influenced the operator's own `~/.claude/settings.json` in an *earlier* round; a review session
  loading `user` settings would inherit whatever that earlier influence left behind. Loading no
  file sources at all removes that inheritance path for review specifically, without requiring the
  broader (still-open) worker HOME residual to be solved — ordinary WORKER legs (dispatch/resume/
  fix, as opposed to this review-session mode) are covered separately: see
  "Worker-leg user-settings persistence vector — detect & disclose" below
  for that mechanism.
- **The guard hook keeps working regardless** — it is mounted via **inline** `--settings`
  (`guardSettings()`'s JSON, passed as a CLI argument value, never a file), which this "Benchmark
  isolation recipe" section already establishes is a *separate* mechanism from file-based settings
  discovery (inline `--settings` layers additively; excluding file sources via `--setting-sources`
  doesn't touch it). A review session's read-containment (`SAPWOOD_WORKTREE_ROOT` = the
  materialized tree) is therefore unaffected by closing every file-based settings source.
- **Guard mode is forced `hard`** for every review session (`SAPWOOD_GUARD_MODE=hard` in the spawn
  env), regardless of the engine's configured `guard.mode` — a review session is security-bearing
  by construction and must never silently inherit a weaker, soft (observe-only) posture just
  because the operator runs ordinary worker/role sessions that way.
- **The tool profile (`Read`/`Grep`/`Glob`, no `Bash`) and the no-forge-proxy rule are hardcoded**
  in `RoleRunner.run()` itself, not a caller convention — supplying `allowedTools`/
  `disallowedTools`/`proxy` alongside `reviewCwd` is refused (thrown), the same treatment a
  materialized directory that doesn't exist at spawn time gets (every setup failure maps to a
  `session-unavailable` outcome, never a silent degraded run).

**Projection sanitization contract.** `review/materializer.ts` creates an engine-private bare clone
outside every worker worktree and materializes the pinned head into a temporary plain tree. That
private clone may be reused only after its origin identity matches the requested source and its
allowlisted local config is re-asserted clean both before and after an env-isolated, hooks-disabled
fetch with an explicit mirror refspec; any failed assertion or operation discards it and falls back
to a fresh clone. Every git operation ignores global/system config, and hooks are disabled
command-locally on both fetch and checkout. Dangerous exec-capable clone-local keys fail closed,
and the remote section is restricted to an explicit `url`/`fetch` subkey allowlist;
checkout also disables replacement objects and materializes symlinks as plain text; the resulting
tree contains no `.git` directory, the requested OID is verified after checkout, and a hashed
manifest of the resulting tree is recorded. Instruction files remain
present by design. Their authority risk is handled by the
instruction-path escalation below, while the closed session profile above prevents project MCP or
settings files in that producer-controlled tree from gaining an execution channel.

The other sanitization boundary is the write from the session to GitHub. The session's structured
output is data, never instructions for the engine to execute: a strict schema accepts only complete
per-AC judgments and findings, and deterministic code derives the verdict. When `review/audit.ts`
renders the human evidence record, it escapes table cells and blockquotes every line of finding
prose before it crosses into a PR comment. That quoting prevents session prose from matching the
hosted-reviewer's clean-verdict or reviewed-head parsers. Audit comments are explicitly
non-authoritative and are never read back as gate② approvals.

### Benchmark isolation recipe (evals only — never production)

**Not to be confused with the guard-hook read containment above.** This section's
`--bare` recipe seals a session's AMBIENT CONTEXT (no repo/user `CLAUDE.md`, no
auto-memory, no MCP) for reproducible eval comparisons — a different goal from that
containment,
which confines an ordinary (non-`--bare`) production session's explicit
`Read`/`Grep`/`Glob` tool CALLS to its own worktree via the guard hook, while leaving
ambient `CLAUDE.md` absorption open (see "Ambient repo context" above). Production
dispatch uses that containment; it never uses `--bare` — see why below.

Isolation is the *correct* tool for one use case: comparing models/prompts/configs in
a controlled eval where ambient repo/user state must NOT leak into the comparison. For
that case only, run `claude -p` against a **clean, throwaway directory** with explicit,
full prompt injection instead of ambient discovery:

- **`--bare` is MANDATORY, not optional.** Per Claude Code's own docs, `--bare` is the
  *only* mode where the flags you pass become the SOLE inputs — without it, `~/.claude`
  and the current-directory config still load underneath whatever you pass
  (`--settings` is *additive* to the ambient settings layers, not a replacement; an
  `--mcp-config` can still retain ambient MCP servers rather than fully overriding
  them). Skipping `--bare` and hand-picking a few explicit flags does **not** achieve
  isolation — it just adds explicit context on top of the same ambient channel this
  page otherwise documents as intentionally open. `--bare` skips hooks, LSP, plugin
  sync, attribution, auto-memory, background prefetches, keychain reads, and
  `CLAUDE.md` auto-discovery in one flag, and sets `CLAUDE_CODE_SIMPLE=1`.
- a fresh, empty working directory (no repo `CLAUDE.md`, no prior session state);
- `--system-prompt` / `--system-prompt-file` and `--append-system-prompt[-file]` to
  supply exactly the context the eval wants the model to have, explicitly (`--bare`'s
  own doc names these as the intended way to inject context under it);
- `--add-dir` only for the specific paths the eval needs;
- `--mcp-config` (fully replacing, not augmenting, the MCP surface) or omit MCP
  entirely, plus `--settings`, to pin the exact tool/MCP surface rather than
  inheriting whatever's ambient on the runner machine;
- `--agents`/`--plugin-dir` pinned or omitted, same rationale.

**It is not acceptable for production dispatch under any configuration**: `--bare`
disables hooks, and the fail-closed guard hook (`guard.ts`) is the actual
producer≠reviewer≠merger safety boundary this whole page describes — running without
it is running unguarded, full stop, regardless of how convenient the isolation is for
reproducibility. Benchmark runs are a separate, offline, human-supervised activity;
they never feed sapwood's own dispatch loop.
