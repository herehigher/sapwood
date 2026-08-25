# Ambient repo context

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for ambient repo context.

## Ambient repo context: record, don't seal

Every session above — worker or peripheral — spawns `claude -p` **inside a real repo
worktree**. That means it legitimately absorbs the target repo's `CLAUDE.md`, the
user's global `CLAUDE.md`/auto-memory, and the CLI's other dynamic system-prompt
sections, exactly like any interactive session would. An earlier internal note claimed
peripheral role sessions got "no repo context beyond what's substituted into the
prompt" — that was never accurate once sessions ran in a real worktree, and the claim
is now corrected at its source (`config.ts`'s `RoleSession` schema comment).

**This channel stays
open in production.** Sealing it — running with no ambient `CLAUDE.md` at all — would
move the trust boundary to the *content* side, contradicting the locked boundary
this page already states above and in [PLAN.md](../PLAN.md#security--trust-posture):
the boundary is what a session can **do** (the zero-write, zero-`Bash` tool allowlist,
now `Read`/`Grep`/`Glob` guard-confined to the worktree; the credential-stripped spawn env),
never what it can **read**. Repo
conventions
living in `CLAUDE.md` are exactly what a role session *should* absorb — the same
reason a human contributor reads it too. The obligation this channel creates is
**honesty and diagnosability, not isolation**: record what each session attempt
actually saw, so ambient drift between retries (a `CLAUDE.md` edited between attempt 1
and attempt 2, a dirty worktree, a config change) never makes two attempts of the same
phase look comparable when they weren't.

**Wired for every `runSessionWithRetry` peripheral call site** — harvest,
architect, plan-review (the reviewer, drafter, and confirm sessions), retro,
`decompose.ts`'s PO
decompose sub-mode (`po-decompose`), and `align.ts`'s
three PO sessions (`po-align`, `po-triage`, `po-pool`) — **plus
`WorkerSupervisor`'s `dispatch()`/`resume()`**: every worker/producer leg
records the same host-environment fingerprint. The mechanism is the SAME
`assembleContextManifest`/`capturePreSpawnManifestData` pair, factored out of
`peripheral.ts` into `context-manifest.ts` so both callers share it rather than
growing a second implementation — see `WorkerSupervisor.recordLaneContextManifest`'s
own doc for the worker-specific key/scope choices (a sentinel `roundId: 0, phase:
"worker"` row per lane name, most-recent-leg-wins on resume). One nuance a live
probe surfaced: a session's stream-json init line reports ZERO `mcp__`-prefixed tool
names even when ambient MCP servers are actually loaded (tool schemas arrive
deferred, after init) — the manifest's `mcpTools` field reads the init report's
SEPARATE `mcp_servers` field (name + connection status per server), which is NOT
subject to that deferral, rather than naively deriving MCP presence from the tool
name list.

**The context manifest.** Every wired role session attempt (`RoleRunner.run()` in
`peripheral.ts`) assembles a manifest in TWO PHASES, each with its own recorded
timestamp (`capturedPreSpawn` / `capturedPostExit`) so the manifest states its own
timing rather than leaving it implicit:

- **Pre-spawn (filesystem-derived half):** captured as early as this engine can
  possibly observe it — anchored to the session's OWN `{"type":"system","subtype":
  "init"}` stream-json line (polled from its still-growing jsonl file,
  `worker.ts`'s `hasSessionInitLine`), **never at session teardown**. The init line
  is the CLI's own signal that it finished loading context (worktree provisioning
  included) and is about to hand control to the model — the exact "what the session
  saw" instant. This matters most for `retro`, the one role that holds write-capable
  tools: capturing at teardown (the original design) would have recorded "what the
  session left behind" — its own proposal commit, a possibly-edited `CLAUDE.md` —
  not what it started with. An EARLIER version of this fix anchored to a bounded wait
  for the worktree DIRECTORY to exist instead of the init line; a focused-suite run
  caught that race live (directory existence does not imply checkout-complete —
  `CLAUDE.md` was recorded absent once, flaky), which is why the anchor is the
  session's own content signal, not a filesystem race. If the init line is never
  observed within the bound (a hung or crashed-before-init session), capture still
  proceeds — best-effort, never blocking — and the manifest's `captureBasis` field
  (`"init-observed"` vs. `"timeout-fallback"`) names which case fired, so a
  lower-confidence capture is never silently presented as equally reliable.
- **Post-exit (self-report half):** the session's own stream-json init report — model/
  CLI version/tool inventory/MCP servers — plus the auto-memory source, whose path is
  only knowable from that same report. These don't drift with worktree edits (the
  init event fires once, near stream start), so reading them at exit costs nothing
  extra and needs no earlier synchronization.

It records:

- **a deliberately bounded, ENUMERATED set of standard sources** — never Claude Code's
  full `CLAUDE.md` resolution graph (`@import` directives, ancestor-directory files
  above the worktree root, any managed/enterprise policy layer are named in the
  manifest's own `knownUnprobed` field, not chased). The manifest's `probedPaths`
  field lists exactly what WAS checked: `<worktree>/CLAUDE.md`,
  `<worktree>/CLAUDE.local.md`, `<worktree>/.claude/CLAUDE.md`, every `*.md`
  RECURSIVELY under `<worktree>/.claude/rules/` (if present — nested subdirectories
  included, not just direct children), and the user-global `CLAUDE.md` — from
  `$CLAUDE_CONFIG_DIR/CLAUDE.md` when that environment variable is set (honoring an
  operator's relocated config dir), else `~/.claude/CLAUDE.md`;
- **every present source captured CONTENT-ADDRESSED inline, with no exceptions** —
  even a worktree-rooted, git-tracked file. An earlier design gave git-trackable
  sources a hash-only "recoverable from git history" shape; that was deleted after
  review because it isn't trustworthy for a write-capable session (`retro`): the file
  could be modified, added, removed, or untracked before `retro`'s own commit, so
  `path + commit` would not reliably reproduce the captured content via `git show`.
  A resolved `gitCommit` survives only as **ADVISORY metadata** on the snapshot — "the
  worktree's HEAD at capture time" — never a recoverability claim. Absence is recorded
  too, distinguishing a confirmed-nonexistent file (`"absent"`) from any OTHER read
  failure (`"unreadable"` — permissions, a directory where a file was expected, ...) —
  the latter is a genuine blind spot that must never masquerade as "this layer
  legitimately doesn't exist";
- the model/CLI version/tool-inventory-hash/prompt actually used — read from the
  session's *own* stream-json init report where possible (`roles/worker.ts`'s
  `parseSessionInit`), with an explicit `modelSource` field (`"session-init"` vs.
  `"requested-fallback"`) so a fallback-model switch, a CLI upgrade mid-fleet, or a
  session that crashed before ever reporting in is visible rather than silently
  assumed to match the request. (The tool-inventory hash is named for what it is: a
  hash of the session's reported tool NAMES, not a schema-version string the CLI
  doesn't emit.)
- MCP server availability (name + live connection status, from the same init report);
- the worktree's resolved git HEAD (via a **namespace-aware** pure-filesystem read of
  git's own plumbing files — see below — never a `git status` call);
- hashes of the `--settings` JSON and the guard hook file, so a hook/config change
  between attempts is also detectable; and
- **(#1010) the session's own init-reported EFFECTIVE host `permissionMode`** — the
  engine always REQUESTS one fixed mode (`worker.ts`'s `REQUESTED_PERMISSION_MODE`,
  `auto`), but Claude Code can silently fall back to a different one when that mode is
  unavailable (org settings turn it off / model unsupported), and in a headless `-p`
  run a fallback to Manual means "anything not allow-listed is denied, and Claude keeps
  working" — a leg then under-delivers with no engine-visible signal unless this field
  is read. `null` when the init line carried no such field, never a guess. At lane end
  (the same jsonl read `parseCostUsd`/`scanEgressSuspects` already use), a divergence
  from the requested mode also emits one `permission-mode-mismatch` event — informational
  only, fail-safe in the allow direction, never gating the lane/session's own outcome.
  The `system/init` line carries no separate sandbox field, so "was the Bash sandbox
  actually engaged" cannot be read the same way; that positive-attestation question is
  left to DR #1009.
- **(#1010) `sandboxViolationCount`** — how many `<sandbox_violations>` blocks the CLI
  appended to a denied command's own `tool_result` across the session (`worker.ts`'s
  `countSandboxViolations`: one string match over the already-parsed jsonl, no new
  scanner). Zero when none were found. Together with `permissionMode` above, this is
  today's full observability floor for the permission-mode/Bash-sandbox profile work
  (DR #1009) — a count of observed evidence, never a claim the sandbox was or wasn't
  engaged, and never affects the session's own outcome.

Manifests persist in the state DB's `context_manifests` table, keyed by
`(round, phase, role, session, attempt)` — the same tuple a separately
developed input manifest will eventually join on. That linkage is deliberately **not**
built here: this table is self-contained (its own migration, its own `State` methods),
so the two features merge independently regardless of order.

**Why no live `git status`.** This engine structurally never execs `git` outside
worker.ts's `claude` CLI launch and `gh.ts`'s `gh` calls — pinned by a grep-invariant
test (`worker.test.ts`) that also bans passing a `cwd` to any subprocess, so the
engine cannot exec git *in a worker worktree* even accidentally. The context manifest
honors that boundary: a worktree's HEAD commit is recovered by reading git's own
plumbing files directly (`.git`'s `gitdir:` pointer, `HEAD`, loose/packed refs) —
pure filesystem, no subprocess. The lookup is **namespace-aware**, matching git's own
repository-layout model: once a worktree has a `commondir`, EVERY `refs/*` ref is
SHARED (resolved from the repo-wide common store only — a stale or shadowing
worktree-local file under the same path, left over from an older git version, a
manual edit, or a corrupted worktree, must never be consulted, let alone win) EXCEPT
three genuinely per-worktree namespaces, resolved worktree-local only:
`refs/bisect/*` (an in-progress `git bisect`), `refs/rewritten/*` (`git rebase
--update-refs` scratch state), and `refs/worktree/*`. (An earlier version of this fix
inverted the model — treating only `refs/heads/tags/remotes` as shared — which got
common cases right by coincidence but would have mis-resolved any other shared
namespace, e.g. `refs/notes/*`, from a stale worktree-local shadow.) `dirty` is
derived, never measured,
from three distinct, honestly-labeled bases: `"structural-no-write-tools"` (the
session's ENGINE-GRANTED `--allowedTools` string carries no WRITE-capable tool name —
`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/any `Bash(...)` entry — the common case, so
`dirty: false` is a guarantee about that grant, not about the session's total capability;
host-delegated capability management means an unsealed session can still inherit an ambient host MCP server with
its own write-capable tools, invisible to this name-based check — see the worker-egress
blind-spot section. `Read`/`Grep`/`Glob` is the universal issues-only baseline, so this
is no longer the same thing as "the allow-list is empty" — a read-only grant is still
`dirty: false`); `"unknown-write-capable-session"` (the grant
DOES include a write-capable tool, e.g. `retro`'s `Write`/`Edit`/`Bash(git ...)` — the
engine cannot rule out a write, so `dirty: true` conservatively, never a false
"definitely clean"); and `"worktree-missing"` (the worktree never appeared on disk at
all within the bounded wait — a distinct fact from either of the above, not folded
into a guess).

**What a session actually used.** Alongside HEAD/cleanliness, the manifest also
records which tools a session's stream actually INVOKED (`toolUsage`: name → call
count, parsed from its jsonl `tool_use` blocks — including a DENIED attempt, e.g. a
blocked `Bash` call, since the attempt itself is diagnostic evidence whether or not it
executed) and which paths its `Read`/`Grep`/`Glob`/`NotebookRead` calls named
(`readPaths`, sorted and deduplicated). This is a RECORD of what was asked for, not a
re-verification of where it landed — the guard hook above is the actual containment
enforcement; the manifest exists so a session's read footprint is diagnosable after
the fact, the same "record, don't seal" stance this whole section takes for ambient
`CLAUDE.md` absorption.

**Honest framing.** This same broad, recorded read access is what makes architecture-debt
detection possible at all — the architect role forms its drift/contradiction judgment from the
SAME ambient repo/doc access every session already has, not from a separate, more-privileged
audit grant. sapwood has no standing "audit role" with elevated read scope; if one is ever
justified, it is an addition to this recorded posture, not evidence that today's posture was
incomplete.
