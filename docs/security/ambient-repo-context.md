# Ambient repo context

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for ambient repo context.

## Ambient repo context: record, don't seal

Every session — worker or peripheral — spawns `claude -p` inside a real repo worktree, so it
legitimately absorbs the worktree's `CLAUDE.md`, the user's global `CLAUDE.md`/auto-memory, and
the CLI's other dynamic system-prompt sections, the same as any interactive session would
(`config.ts`'s `RoleSession` schema comment).

**This channel stays open in production.** Sealing it would move the trust boundary to the
*content* side, contradicting the boundary [PLAN.md](../PLAN.md#security--trust-posture) states:
what a session can **do** (the zero-write, zero-`Bash` tool allowlist — `Read`/`Grep`/`Glob`
guard-confined to the worktree; the credential-stripped spawn env) — never what it can **read**.
The obligation is **honesty and diagnosability, not isolation**: record what each attempt actually
saw, so ambient drift between retries never makes two attempts of the same phase look comparable
when they weren't.

**Wired call sites.** Every `runSessionWithRetry` peripheral call — harvest, architect,
plan-review (reviewer, drafter, confirm), retro, `decompose.ts`'s `po-decompose`, and `align.ts`'s
three PO sessions (`po-align`, `po-triage`, `po-pool`) — plus `WorkerSupervisor.dispatch()`/
`resume()` for worker legs, records the same fingerprint via the shared
`assembleContextManifest`/`capturePreSpawnManifestData` pair (`context-manifest.ts`), factored out
of `peripheral.ts` so both callers share one implementation rather than growing a second one.

**Two-phase capture.** Each attempt's manifest is assembled in two independently timestamped
halves:

- **Pre-spawn (filesystem half, `capturedPreSpawn`)** — anchored to the session's own
  `system/init` stream-json line (`worker.ts::hasSessionInitLine`, polled from its still-growing
  jsonl), never at teardown: for a write-capable session (`retro`), teardown would record what it
  left behind, not what it saw. `captureBasis` names which anchor fired — `"init-observed"` or
  `"timeout-fallback"` (the bound expired; capture still proceeds, best-effort, never blocking).
- **Post-exit (self-report half, `capturedPostExit`)** — the session's own init report (model, CLI
  version, tool names, MCP servers) plus the auto-memory path (only knowable from that same
  report); captured at exit since these values don't drift with worktree edits.

**What's recorded**

| Field | What's captured | Enforcement |
| --- | --- | --- |
| CLAUDE.md family | `<worktree>/CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, every `*.md` recursively under `.claude/rules/`, user-global `CLAUDE.md` (`$CLAUDE_CONFIG_DIR/CLAUDE.md` else `~/.claude/CLAUDE.md`) | `context-manifest.ts::captureClaudeMdSources` |
| Source content | every present source hashed + stored inline, content-addressed, even a git-tracked file; absent (confirmed nonexistent) vs. unreadable (a real blind spot that must never be silently reported as "this layer legitimately doesn't exist") | `context-manifest.ts::assembleContextManifest` (hashing); `::readAmbientSource` (absent/unreadable) |
| auto-memory | `MEMORY.md` under the session's self-reported memory path | `peripheral.ts::assembleManifest` |
| Model / CLI / tools | model, CLI version, a tool-name-set hash, a rendered-prompt hash; `modelSource` (`"session-init"` vs. `"requested-fallback"`) flags a fallback-model switch, a CLI upgrade mid-fleet, or a crashed-before-init session | `worker.ts::parseSessionInit` |
| MCP servers | name + connection status per server, from the init report's `mcp_servers` field, never the tool-name list (`mcp__`-prefixed schemas arrive deferred, after init) | `worker.ts::parseSessionInit` |
| Worktree HEAD | resolved via a namespace-aware, pure-filesystem read of git's plumbing files, never a `git` subprocess | `context-manifest.ts::resolveWorktreeHead` |
| Host posture | the session's own init-reported effective `permissionMode`; a count of denied-command `<sandbox_violations>` blocks, diagnostic only, never gating the session's own outcome | `worker.ts::parseSessionInit` (permissionMode); `::countSandboxViolations` (count) |
| Settings / hook | hash of the `--settings` JSON and the guard hook file content, detecting a change between attempts | `context-manifest.ts::assembleContextManifest` |
| toolUsage / readPaths | tool name → call count, including denied attempts; every `Read`/`Grep`/`Glob`/`NotebookRead` path named, sorted + deduplicated | `worker.ts::parseToolUsage` |

**Boundaries**

- **Not chased:** `@import` directives inside any probed file, ancestor-directory `CLAUDE.md`
  files above the worktree root, and any managed/enterprise policy layer — named in
  `knownUnprobed`, never silently presented as exhaustive
  (`context-manifest.test.ts`: "assembleContextManifest (Codex F2b): probedPaths/knownUnprobed pass
  through verbatim").
- A resolved `gitCommit` on a snapshot is ADVISORY metadata only ("the worktree's HEAD at capture
  time"), never a claim that `git show <gitCommit>:<path>` reproduces the captured content — a
  write-capable session (`retro`) can modify, remove, or untrack a file before its own commit
  (`context-manifest.test.ts`: "EVERY present source content-addressed inline (Codex F3)").
- HEAD resolution is namespace-aware: only `refs/bisect/*`, `refs/rewritten/*`, `refs/worktree/*`
  resolve worktree-local; every other `refs/*` ref (branches, tags, remotes, notes) resolves from
  the shared common store only, never a stale worktree-local shadow
  (`context-manifest.test.ts`: "a STALE worktree-local refs/heads file must NOT shadow the real
  ref in the shared common store").
- `dirty` is derived, never measured: `"structural-no-write-tools"` vs. `"unknown-write-capable-session"`
  turns on whether the effective grant names a write-capable tool, e.g. `retro`'s `Write`/
  `Bash(git ...)` (`peripheral.ts::hasWriteCapableGrant`) — so `dirty: false` is a guarantee about
  that grant, not the session's total capability (an ambient MCP server's own write-capable tools
  are still invisible to this check), and `dirty: true` is never a false "definitely clean".
- `"worktree-missing"` is decided separately from the two bases above, when the worktree never
  appeared on disk at capture time (`peripheral.ts::assembleManifest`; `worker.ts::recordLaneContextManifest`
  for worker legs) — `context-manifest.ts::assembleContextManifest` itself only passes the
  `worktree` field through unchanged, never decides it.
- `git status` is never run against a session-controlled worktree, and no git subprocess ever runs
  inside one: an empirically confirmed worker-set `filter.<name>.clean` turns `git status` into
  code execution (the #65 RCE class, `worker.ts::retainOrDeleteWorktree`'s doc; `worker.test.ts`:
  "#69: drain (SIGTERM) ... NO git subprocess is spawned"; "#69 grep-invariant" enumerates every
  module allowed to import `child_process` at all). HEAD/dirty are pure-filesystem derivations
  instead.
- `toolUsage`/`readPaths` record what a session asked for, not where it landed — the guard hook
  (`checkReadContainment`, `guard.ts`) is the actual containment enforcement; this is a diagnostic
  record only.
- The engine always REQUESTS one fixed `host.permissionMode`, but the CLI can silently fall back to
  a different one; under headless `-p` a fallback to Manual denies anything not allow-listed with no
  engine-visible signal unless this field is read — `null` when the init line carried no such
  field, never a guess. A divergence emits one `permission-mode-mismatch` event — informational
  only, fail-safe-allow, never gating the lane's outcome (`worker.ts::recordPermissionModeMismatch`).
  Whether the Bash sandbox actually engaged has no equivalent positive signal — left to DR #1009.

**Residual notes**

- Manifests persist in `context_manifests`, keyed `(round, phase, role, session, attempt)` — a
  separately developed input-manifest join is deliberately NOT built here; each table stays
  self-contained regardless of merge order.
- A worker leg's manifest key is a sentinel `roundId: 0, phase: "worker"` row per lane name; a
  resume overwrites the prior leg's row (most-recent-leg-wins), never a per-leg history
  (`worker.ts::recordLaneContextManifest`).
- The architect role's drift/contradiction judgment comes from this SAME ambient read access every
  session already has — sapwood has no separate, more-privileged audit role; adding one later is
  not evidence today's posture was incomplete.

Rejected alternatives and live-measurement narrative behind the mechanisms above are archived in
[`design/security-ambient-repo-context-derivations-2026-08.md`](../design/security-ambient-repo-context-derivations-2026-08.md).
