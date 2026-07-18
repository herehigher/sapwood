# Security & trust model

sapwood's core claim is that it's safe to let an autonomous worker write code in your
repo because the loop structurally prevents it from also approving or merging that
code — not because you trust the model to behave. This page describes that model as it
exists today.

## Trust context

sapwood targets **trusted repos first**: your own repo or your team's, where issue
authors are trusted and issue text is not treated as hostile input. The architecture is
built toward public-repo hardening (scoped ephemeral tokens, an allowlisted-reviewer
requirement instead of any-non-author-approval, a threat model treating issue text as
adversarial), but those hardenings are not all in place yet — don't point an
unhardened sapwood at a public repo with untrusted issue authors.

## producer ≠ reviewer ≠ merger

The worker that writes code can never approve its own review or merge its own PR. This
is enforced structurally, not by asking the model nicely:

- **The fail-closed guard hook (`guard.ts`)** is a PreToolUse hook wired into every
  worker's headless `claude -p` session. It's a pure, zero-dependency, deterministic
  function: given a tool name and its input, it decides allow/block. For `Bash`, it
  tokenizes the command (shlex-equivalent splitting, recursing into `$()`/backtick
  substitutions), strips exec-prefixes (`env`, `npx`, leading assignments, etc.), and
  blocks any GitHub-overreach command a producer must never run: `gh pr merge`,
  `gh pr review --approve`, `gh pr ready`, `gh release`, and the mutating `gh api`/
  GraphQL equivalents. Opaque constructs a worker could hide anything inside —
  `eval`, `sh -c`, an interpreter's `-e`/`-c`, process substitution — are blocked
  outright, fail-closed, rather than inspected.
- **The merge is always executed by the conductor**, never the worker. Only
  `merge-driver.ts`'s `driveOne` calls the merge API; `tick()` (the path a worker's own
  session runs inside) never does. This holds even if the guard hook were somehow
  bypassed — it's a structural separation, not just an argv check.
- **Fail-closed on error.** The hook denies on malformed JSON, a non-object payload, a
  malformed `tool_input` for a guarded tool, or any exception thrown while deciding. A
  safety hook that can be disabled by feeding it garbage isn't one.

### Guard modes: hard vs. soft

`guard.mode` (default `hard`) controls how the hook responds to a blocked command:

- **`hard`** — fail-closed deny. This is the actual safety boundary and the only mode
  that should run against real, unattended dispatch.
- **`soft`** — observe-only: the hook logs what it *would* have blocked but allows the
  command through anyway. This exists only as a first-run/dogfood affordance for
  watching what the guard would catch without yet trusting it to block — never the
  shipped default, and not a mode to leave on for real autonomous runs.

The mode reaches the guard hook via a spawn-time environment variable
(`SAPWOOD_GUARD_MODE`) that the engine sets when it launches the worker process — not a
worker-writable settings file — so a worker cannot weaken its own guard mode by editing
config mid-run.

## Issues-only role sessions: read-only, worktree-confined, no shell (#110, #235)

Workers are guarded by the argv-inspecting hook above. The round orchestrator's
issues-only peripheral roles — plan-reviewer, plan-drafter, PO/align+triage+pool,
harvest, and architect — take a different, stronger approach on the WRITE side: they
hold no `Bash` tool grant at all, and no `Write`/`Edit`/`MultiEdit`/`NotebookEdit`
grant either. Each session's only output channel is its final message, which ends in a
structured, sentinel-delimited block. The deterministic engine
(`plan-review.ts`/`align.ts`/`harvest.ts`/`architect.ts`) parses that block, validates
it against a per-role zod schema plus the content invariants worth cheaply re-checking
(e.g. an "approve" claim's body must actually carry a verification-plan section —
schema-valid is not the same as truthful), and performs every GitHub write itself via
`IForge`. Validation is fail-closed: ambiguous, duplicate, or out-of-candidate-set
output (the architect is the one role that picks write targets from a pool — every
flagged issue number is checked against the exact candidate set its prompt was shown)
rejects the WHOLE structured output, never a partial/best-guess apply. A malformed or
invalid attempt retries once; a second failure hits the role's existing degrade path —
gate⓪ escalates to `needs-human` with the attempt trail, the advisory roles (PO,
harvest, architect) degrade-and-proceed with a durable state event, never a silent
no-op and never a wedged round.

**On the READ side (#235), every one of these roles is explicitly granted
`Read`/`Grep`/`Glob`** — `peripheral.ts`'s `ROLE_ALLOWED_TOOLS` is
`"Read,Grep,Glob"`, no longer the empty string, and the architect is not a special
case: the 2026-07-17 owner ruling is that whether to read is the model's own
role-scoped judgment (an architect reasoning about a contradiction via an approval
protocol instead of just reading the code is absurd), because reading is not
producing/approving/merging. What makes this safe is a **real, fail-closed
containment mechanism**, not a permission-layer convention: the guard hook's
`checkReadContainment` (`guard.ts`, landed as #235's PR-A) resolves every
`Read`/`Grep`/`Glob`/`NotebookRead` call's target path against the session's own
`SAPWOOD_WORKTREE_ROOT` (an env var the engine sets at spawn time, the same
credential-stripped, engine-controlled channel `SAPWOOD_GUARD_MODE` already uses) and
**blocks** anything that resolves outside it — an absolute host path, a
`../`-traversal, a symlink escape. A live probe (a real `claude -p --worktree`
session, this role's exact allow/deny pair) is part of this feature's verification:
host-path and traversal reads are denied, an in-worktree read succeeds. Before #235
PR-A, this containment did not exist — a real probe found an absolute host path and a
`../`-traversal BOTH escaped the worktree and returned real host file content, which
is why the read-only allow-list widening in this section shipped only once that gap
was closed, never before.

**`--disallowedTools` is the write/exec-side cross-source veto**: `peripheral.ts`'s
`ROLE_DISALLOWED_TOOLS` denies `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, and a
**blanket `Bash`** — the bare tool name, not a pattern list. `--disallowedTools` wins
over allow from ANY source, including a target repo's own checked-out
`.claude/settings.json`, an authorization surface this engine does not control — so
this is the real boundary, not a convention a repo's own config could quietly
override. Because no shell exists for these sessions to reach `gh` (or anything else)
through at all, the pattern-layer bypass classes earlier hardening closed one glob at
a time (#102's short `-F`/`-l`/`-p` flag aliases, #108's quoted/escaped `-F`
spellings) are structurally moot for them — not closed by a better pattern, but by
removing the capability the pattern was constraining; the blanket `Bash` deny
subsumes every one of those old per-pattern entries by construction. Per-role deny
constants (`PLAN_DRAFTER_DISALLOWED_TOOLS`, `PO_DISALLOWED_TOOLS`,
`HARVEST_DISALLOWED_TOOLS`, `CONFIRM_DISALLOWED_TOOLS`) are now byte-identical to the
base and kept as their own named exports purely for call-site clarity — each is still
independently regression-tested, so a future re-widening of any one role's grant
lands inside a failing test rather than silently reopening a closed bypass class.
Read-only git (`git log` etc.) deliberately stays **out** of the allow-list: the
blanket `Bash` deny already covers it, and adding it back would be a live capability,
not a trip-wire.

Every `RoleRunner` session is additionally spawned without forge credentials:
`peripheralSessionEnv()` in `peripheral.ts` strips inherited `GH_*`,
`GITHUB_TOKEN`, `GITHUB_ENTERPRISE_TOKEN`, `GIT_ASKPASS`, and `GIT_CONFIG_*`
variables through a case-normalized denylist, while preserving the CLI's own
Anthropic authentication and `SAPWOOD_GUARD_MODE`. For the five issues-only roles,
the zero-`Bash`/zero-write tool grant (`Read`/`Grep`/`Glob` allowed, guard-confined
to the worktree, as described above — no `gh`-reaching capability of any kind)
remains the primary boundary; environment absence is a backstop, regression-tested
with a poisoned parent environment, so a future allowlist-widening regression
cannot turn an inherited engine credential into forge authority. Worker-class
`retro` receives the same stripped environment but keeps push working through the
ambient git credential helper, as described below. Code-producing worker lanes are
unaffected: they legitimately hold the token, mediated by the guard hook.

**`retro` is the one exception**, by session class rather than role name: it is
worker-class, with `Read`/`Grep`/`Glob` + local git only — file edits, commit, and
push inside its own ephemeral worktree (proposals land exclusively as PRs through the
normal review gate, never a direct write) — the same broader trust level a
code-producing worker gets, because its job (editing prompts/docs/config from round
history) genuinely needs it. (`Grep`/`Glob` joined its allow-list in #235 alongside
every other role's — retro's job was already code-aware and already carried `Read`;
it was simply missing the other two read tools.) Its `gh` surface, however, is now **zero** — no `gh` entry of any kind remains in
its allowedTools (#111, shipped in two halves):

- **Read side (#111 PR-A):** retro never browses GitHub live. Instead the engine
  builds a round-scoped digest (PR descriptions + diffs + review signals for every PR
  the round touched, comments/labels for every escalated issue, commit history since
  round start) *before* the session runs, bounded by a hard, deterministically-
  truncated character cap (`roles.retro.digestMaxChars`), and substitutes it into the
  prompt. See [`configuration.md`](configuration.md#roles) for the config key and
  `engine/src/retro/retro-digest.ts` for the assembly.
- **Write side (#111 PR-B):** PR creation originates in engine TypeScript, never in
  the session. The session's job ends at commit+push: it writes its intended PR
  (branch/title/body — or an explicit `none` for a quiet round) to a fixed scratch
  path in its worktree (`.sapwood-retro-pr`; the engine chooses the path). Post-
  session the engine parses that file fail-closed, **verifies the claimed branch
  actually exists on the forge** (an engine-side `gh api` read — a session claim is
  never trusted as evidence of a push), and only then calls `forge.openPR()` itself.
  Partial failures degrade visibly and durably (`retro-pr-degraded` event; a pushed
  branch whose `openPR` failed is preserved evidence for a human), never a silent
  no-op and never a wedged round.

The dangerous verbs `guard.ts` already blocks category-C are unchanged, and retro's
old `gh` deny patterns are kept byte-identical as regression trip-wires — the same
stance the issues-only roles took after #110.

**gate⓪'s freshness re-confirm session** ("does this plan still hold against current
`main`?", #214) needed repo read access before #235 for the same reason every other
role does now: a plan referencing a file since renamed is otherwise unverifiable. Before
#235, this was its OWN sanctioned widening (`CONFIRM_ALLOWED_TOOLS`, narrower than
retro's git-and-file-edit grant) — the base issues-only allow-list carried no `Read` at
all yet. #235 makes `Read`/`Grep`/`Glob` the UNIVERSAL issues-only baseline, so
`CONFIRM_ALLOWED_TOOLS`/`CONFIRM_DISALLOWED_TOOLS` are now byte-identical to
`ROLE_ALLOWED_TOOLS`/`ROLE_DISALLOWED_TOOLS` — kept as their own named exports purely
for call-site clarity in `plan-review.ts`. The session reads the conductor's own
checkout, the same ephemeral worktree every role session already gets and the same
guard-hook containment described above; its freshness relative to `main` is the
conductor's responsibility, not a property this grant controls. This session's
decision, like every other role's, is read from its structured output only, applied by
the engine (`plan-review.ts`), never by a tool call of its own.

## Ambient repo context: record, don't seal (#236)

Every session above — worker or peripheral — spawns `claude -p` **inside a real repo
worktree**. That means it legitimately absorbs the target repo's `CLAUDE.md`, the
user's global `CLAUDE.md`/auto-memory, and the CLI's other dynamic system-prompt
sections, exactly like any interactive session would. An earlier internal note claimed
peripheral role sessions got "no repo context beyond what's substituted into the
prompt" — that was never accurate once sessions ran in a real worktree, and the claim
is now corrected at its source (`config.ts`'s `RoleSession` schema comment).

**Owner ruling (2026-07-17), Codex concurring after challenge: this channel stays
open in production.** Sealing it — running with no ambient `CLAUDE.md` at all — would
move the trust boundary to the *content* side, contradicting the locked boundary
this page already states above and in [PLAN.md](PLAN.md#security--trust-model-trusted-first-designed-toward-public):
the boundary is what a session can **do** (the zero-write, zero-`Bash` tool allowlist
— empty until #235, now `Read`/`Grep`/`Glob` guard-confined to the worktree, #110/
#235; the credential-stripped spawn env, #218), never what it can **read**. Repo
conventions
living in `CLAUDE.md` are exactly what a role session *should* absorb — the same
reason a human contributor reads it too. The obligation this channel creates is
**honesty and diagnosability, not isolation**: record what each session attempt
actually saw, so ambient drift between retries (a `CLAUDE.md` edited between attempt 1
and attempt 2, a dirty worktree, a config change) never makes two attempts of the same
phase look comparable when they weren't.

**Wired for all 9/9 `runSessionWithRetry` peripheral call sites today** — harvest,
architect, plan-review (the reviewer, drafter, and #214's confirm sessions), retro,
and (as of [#251](https://github.com/herehigher/sapwood/issues/251)) `align.ts`'s
three PO sessions (`po-align`, `po-triage`, `po-pool`).

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
  git's own plumbing files — see below — never a `git status` call); and
- hashes of the `--settings` JSON and the guard hook file, so a hook/config change
  between attempts is also detectable.

Manifests persist in the state DB's `context_manifests` table, keyed by
`(round, phase, role, session, attempt)` — the same tuple issue #231's separately
developed input manifest will eventually join on. That linkage is deliberately **not**
built here: this table is self-contained (its own migration, its own `State` methods),
so the two features merge independently regardless of order.

**Why no live `git status`.** This engine structurally never execs `git` outside
worker.ts's `claude` CLI launch and `gh.ts`'s `gh` calls — pinned by a grep-invariant
test (`worker.test.ts`, #69) that also bans passing a `cwd` to any subprocess, so the
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
session's tool grant carries no WRITE-capable tool — `Write`/`Edit`/`MultiEdit`/
`NotebookEdit`/any `Bash(...)` entry — the common case, so `dirty: false` is a
structural guarantee; #235 makes `Read`/`Grep`/`Glob` the universal issues-only
baseline, so this is no longer the same thing as "the allow-list is empty" — a
read-only grant is still `dirty: false`); `"unknown-write-capable-session"` (the grant
DOES include a write-capable tool, e.g. `retro`'s `Write`/`Edit`/`Bash(git ...)` — the
engine cannot rule out a write, so `dirty: true` conservatively, never a false
"definitely clean"); and `"worktree-missing"` (the worktree never appeared on disk at
all within the bounded wait — a distinct fact from either of the above, not folded
into a guess).

**What a session actually used (#235).** Alongside HEAD/cleanliness, the manifest also
records which tools a session's stream actually INVOKED (`toolUsage`: name → call
count, parsed from its jsonl `tool_use` blocks — including a DENIED attempt, e.g. a
blocked `Bash` call, since the attempt itself is diagnostic evidence whether or not it
executed) and which paths its `Read`/`Grep`/`Glob`/`NotebookRead` calls named
(`readPaths`, sorted and deduplicated). This is a RECORD of what was asked for, not a
re-verification of where it landed — the guard hook above is the actual containment
enforcement; the manifest exists so a session's read footprint is diagnosable after
the fact, the same "record, don't seal" stance this whole section takes for ambient
`CLAUDE.md` absorption.

### Benchmark isolation recipe (evals only — never production)

**Not to be confused with #235's guard-hook read containment above.** This section's
`--bare` recipe seals a session's AMBIENT CONTEXT (no repo/user `CLAUDE.md`, no
auto-memory, no MCP) for reproducible eval comparisons — a different goal from #235,
which confines an ordinary (non-`--bare`) production session's explicit
`Read`/`Grep`/`Glob` tool CALLS to its own worktree via the guard hook, while leaving
ambient `CLAUDE.md` absorption open (see "Ambient repo context" above). Production
dispatch uses #235's containment; it never uses `--bare` — see why below.

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

## Human-merge-only paths

Some files are structurally off-limits to an autonomous worker because changing them
would let a worker weaken the very mechanism that constrains it. Any change to these is
**human-merge-only**, regardless of what merge mode is configured:

- `guard.ts` / the guard hook wiring
- `reviewer.ts` / `merge-driver.ts`
- security-relevant config (guard mode, reviewer mode, merge mode)
- `.claude/settings*.json` and `.github/workflows/**`

The guard enforces this as a write-path denial (both for the `Write`/`Edit` tools and
for `Bash` redirection/`tee`/`sed -i`/`git mv`/etc. against these paths, checked
position-independently so a wrapper can't hide the write) — but the human-merge-only
rule is also a process rule: even a PR that touches these files and somehow passes CI
and review is not something the conductor should be configured to auto-merge.

### The review-doctrine file is trusted prompt input (#167)

The review-doctrine file (`doctrine.file`, default `docs/REVIEW-DOCTRINE.md`) is
user-editable repo prose and is **not** guard-protected — yet its content is injected
verbatim into the gate② review-trigger comment that the review bot reads, so it can
influence the gate verdict (it could, in principle, instruct the reviewer to wave
things through). It sits inside this page's trusted-repo assumption: doctrine content
is trusted exactly like the rest of the repo's prose, and changes to it deserve the
same review scrutiny as review-gate configuration (`reviewer.*`, `merge.*`). It is
deliberately not sanitized — it's prose written *for* LLM readers, and gate② stays
semantic, not a rules engine.

## Two-tier human controls

sapwood has two independent file-sentinel controls, both living next to the engine's
state DB (`data/`), neither requiring a config edit:

- **Kill switch** (`data/KILL_SWITCH`) — the strict tier. Freezes *all* new dispatch and
  merges. Running workers are asked to hand off gracefully within
  `cost.drainWindowSec`; past that window the conductor escalates to a hard
  process-tree kill. Everything else freezes too: no dispatch, no drive/merge, no
  rollback retry, no reclaim-and-requeue of crashed lanes. Set/lift it with
  `/sapwood-stop` (no argument to set, `--lift` to remove) or by touching/removing the
  file directly.
- **Pause** (`data/PAUSE`) — the gentle tier. Freezes *new dispatch only*. Everything
  already in flight — running workers, PRs already moving through the review/merge
  gate — proceeds exactly as normal. No drain, nothing killed. Use this to stop taking
  on new issues while letting the current round finish (e.g. before a maintenance
  window). Set/lift with `/sapwood-stop --pause` / `--resume`.

If both sentinels are present, the kill switch's stricter behavior governs.

**Interaction with `--until-idle`:** a paused engine dispatches nothing, so once its
in-flight lanes finish it counts as idle and the run exits on its own — "finish the
round, then stop." Removing `data/PAUSE` afterward doesn't resume anything by itself;
start a new `sapwood run`. Under the daemon (`forever`) mode, the engine keeps ticking
and `--resume` takes effect on the very next tick.

### Sentinel isolation boundary (honest statement)

The engine's `data/` directory (which holds both sentinels and the state DB) sits
outside worker git worktrees as a **permission-layer boundary** — the worker process is
not launched with `--add-dir data`, so it has no `claude`-tool path into that directory.
This is **not an OS-level sandbox**, so the guard (`engine/src/guard/guard.ts`) adds
defense-in-depth (#81) on top of that boundary: any `Write`/`Edit` targeting
`data/KILL_SWITCH` or `data/PAUSE` (including via relative traversal, e.g.
`../../data/PAUSE`) is denied, as is `Bash` `touch`/`rm`/`mv`/`git rm`/redirect-to-path
targeting either sentinel, and a sentinel path appearing as a literal argument to any
other command (e.g. `node some-script.js ../../data/PAUSE`) — including glued to a
flag (`--target=../../data/PAUSE`) — with the
sentinel names matched case-insensitively (macOS/APFS default is case-insensitive, so
`data/pause` hits the real file). What remains open, deliberately documented rather
than blocked:

- a script written via the ordinarily-permitted `Write` tool that hardcodes the
  sentinel path *inside its own source* rather than taking it as a CLI argument — the
  guard judges the Bash command line, not a script's file contents, so
  `node some-script.js` (no path argument) is opaque to it;
- directory-level deletion that never names a sentinel, e.g. `rm -rf ../../data`
  (removes both sentinels *and* the state DB). Blocking the bare `data` suffix would
  false-positive on a worker legitimately removing a `data/` dir inside its own repo,
  so this stays a documented residual instead of a guard rule.

Until those are closed too, treat the isolation boundary as "a worker won't
accidentally step here, and the obvious direct/indirect vectors are blocked," not "a
worker provably cannot reach here by any means."

## Cost ceilings vs. the soft worker budget

Two different things are both called "budget," and they behave differently on purpose:

- **`worker.budgetUsdSoft`** is a **soft** per-worker budget, auto-enforced via a live
  token estimate. stream-json carries no in-progress `total_cost_usd` (only the
  terminal result line has that), so the worker accumulates a running USD estimate
  from every streamed assistant message's token usage (priced by a small, explicitly
  approximate per-model rate table — the shipped `pricing.yaml`, overridable via
  `worker.pricingFile` — with cache reads priced at the cache-read rate, not the
  input rate, so a cache-heavy run doesn't look artificially expensive). Crossing
  the threshold triggers a graceful handoff — finish the current atomic step, commit +
  push WIP, write a progress note, drop a `.handoff` sentinel carrying a resumable
  session id, exit clean — **never** a mid-work `SIGKILL`. A hard kill mid-step both
  burns the spend and throws away the work; a graceful handoff preserves both. The
  estimate is reconciled against the real terminal cost when a lane finishes (the
  divergence is logged, not enforced) — it is a trigger signal, not a billing source
  of truth, so `worker.timeoutSec` plus the hard ceiling below remain the actual
  backstop. A handed-off lane re-enters before fresh dispatch when capacity and spend
  gates permit. Each resumed leg gets a fresh soft budget, bounded by
  `worker.maxResumes` (default 2); resumed `total_cost_usd` is per-leg and is ledgered
  directly, so total recorded spend is the sum of the real legs.
- **`cost.dailyBudgetUsd` / `cost.maxWallClockSec`** are **hard** engine-wide ceilings —
  the actual runaway-spend safety boundary, independent of any single worker. Breaching
  either freezes new dispatch/merges and starts draining in-flight workers
  (`cost.drainWindowSec`'s grace window), same "drain before kill" posture as the kill
  switch: give a worker the chance to hand off cleanly, and only escalate to a hard
  process-tree kill once the drain window elapses.

In both directions the design favors **drain-then-escalate over an immediate hard
stop** — a hard kill is the last resort, not the first response, because it destroys
in-progress work as well as spend.

## The `origin:agent` label convention

Any GitHub issue created *by an agent* (as opposed to authored directly by a human)
must carry the `origin:agent` label. `sapwood init` provisions this label like the rest
of the taxonomy.

Today this is a **convention, not yet enforced machinery** — no part of sapwood
currently opens issues on your behalf, so nothing yet applies the label automatically.
The machinery lands with v0.2's round-orchestrator peripheral roles (see
[`PLAN.md`](PLAN.md)'s v0.2 chapter): when a peripheral role (e.g. goal-alignment /
decomposition) opens an issue, it will apply `origin:agent` itself, and an
agent-created issue will additionally require **explicit human confirmation** before it
can enter `Ready` — an agent can propose work, but a human still decides what actually
enters the dispatch queue. Provisioning the label now means that gate can be turned on
later without a taxonomy migration.

## The `plan:approved` label and gate⓪ (#88)

Decision #8's `Ready` gate originally checked only that a verification plan *existed* —
not whether it was any good — and `verify:n/a` was self-declared by whoever wrote the
issue. A 2026-07-09 amendment to Decision #8 (locked in issue #77's comments) closes
that gap: a plan must also pass agent quality review before dispatch.

`getReadyIssues` (`engine/src/forge/forge.ts`) now requires, for any issue not labelled
`verify:n/a`, **both** a verification-plan section in the body **and** the
`plan:approved` label — plan presence alone no longer dispatches. `verify:n/a` still
routes through the doc-gate path, but only when `needs-human` is absent: the
plan-reviewer peripheral may *propose* `verify:n/a` for genuinely unverifiable work, but
it always pairs that proposal with `needs-human` in the same action, so it's a human —
never the agent — who actually opens the doc-gate path, by removing `needs-human`
themselves. `needs-human` and `blocked` block dispatch unconditionally, regardless of
any other label present.

**A plan below standard self-heals rather than stalls** (#77 Amendment 2): when the
reviewer finds the plan missing or inadequate beyond its minor-correction latitude, it
does not park the issue for a human — its structured decision names precisely what's
missing, the engine posts that as a comment (the brief), and the loop dispatches a
**scoped plan-drafting session**: issues-only writes, a session distinct from the
reviewer (plan-author ≠ plan-approver — the reviewer never approves a plan it
authored), never a full worker lane, and it never implements the issue itself. The
draft then comes back through a fresh plan-review. The cycle is bounded — at most
`roles.planReviewer.maxDraftCycles` draft→re-review attempts per issue (default 2) —
after which the loop applies `needs-human` with the full attempt trail preserved
(Decision #9's degrade-to-human). Every attempt is externalized as issue edits/
comments, so a human can inspect or intervene at any point. The Ready-gate enforcement
above is unchanged by any of this: implementation dispatch still requires
`plan:approved` (or adjudicated `verify:n/a`) — only the repair path became more
autonomous.

The plan-reviewer/plan-drafter sessions are wired and, since #110, pure computation:
neither holds a `Bash` tool grant, so neither ever runs `gh` itself. Each session's
final message ends in a structured, sentinel-delimited output block; the engine
(`plan-review.ts`) parses it, validates it against a zod schema, re-checks the one
content invariant worth cheaply verifying — an "approve"/drafted body must actually
carry a verification-plan section, since schema-valid is not the same as truthful —
and only then applies `plan:approved` (or any body correction) itself via `IForge`.
Malformed, schema-invalid, or content-invalid output is treated as a failed attempt:
retried once, then escalated to `needs-human` with the full attempt trail, exactly like
an outright session crash. The shipped default prompt lives at
`engine/prompts/plan-reviewer.md` (`roles.planReviewer.promptFile` overrides it — same
`#74` pattern as `worker.promptFile`).

**`plan:approved` is re-endorsed, not permanent (#214).** The plan-reviewer's candidate
sweep above is now scoped to the round pool rather than the whole Ready lane, and a
prior round's `plan:approved` is re-checked — a lightweight, zero-forge-write-on-confirm
session — every time that issue re-enters a pool, before its approval is trusted for
dispatch again; a session that can't confirm or fails escalates `needs-human` the same
way an initial review does. The label itself is never removed by that check either way.
See [`docs/PLAN.md`](PLAN.md#v02-north-star-the-round-orchestrator) (the "gate⓪ is scoped
to the round pool..." locked decision, issue #214) for the full detail.

## See also

- [`configuration.md`](configuration.md) — the `guard`, `reviewer`, `merge`, `cost`,
  `labels`, and `roles` config sections referenced above.
- [`PLAN.md`](PLAN.md) — the full architecture, decision log, and the v0.2 round
  orchestrator's self-feed design.
