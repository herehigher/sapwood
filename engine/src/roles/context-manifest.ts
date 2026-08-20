// context-manifest.ts — #236: ambient session context, RECORDED, never sealed.
//
// Owner ruling (2026-07-17, Codex concurring after challenge): peripheral role sessions spawn
// `claude -p` in a repo worktree and legitimately absorb that worktree's CLAUDE.md, the user's
// global CLAUDE.md/auto-memory, and the CLI's other dynamic system-prompt sections — same as any
// interactive session would. That channel STAYS OPEN in production. Sealing it would move the
// trust boundary to the CONTENT side, contradicting #219's locked boundary: the boundary is what
// a session can DO (action-side — the empty tool allowlist, #110; the stripped credential env,
// #218), never what it can READ. Repo conventions living in CLAUDE.md are exactly what a role
// session SHOULD absorb.
//
// So the obligation here is HONESTY and DIAGNOSABILITY, not isolation: every session ATTEMPT
// records what it actually saw AMONG A DELIBERATELY BOUNDED, ENUMERATED SET OF STANDARD SOURCES
// (see `probedPaths`/`knownUnprobed` below) — this module does NOT reimplement Claude Code's full
// CLAUDE.md resolution graph (imports, ancestor-directory files, managed/enterprise policy). The
// manifest names its own blind spots rather than silently pretending to be exhaustive. Ambient
// drift between retries (a CLAUDE.md edited between attempt 1 and attempt 2, a dirty worktree, a
// config change) is what this exists to make visible, never to hide. Isolation remains correct —
// but only for BENCHMARK runs, documented as a separate recipe in docs/security.md, never wired
// into production dispatch (it needs `--bare`, which also disables the guard hook).
//
// This module is PURE (assembleContextManifest touches no filesystem/subprocess — every input
// is data the caller already gathered) so the "fixture env in, manifest out" shape the #236
// verification plan asks for needs no real filesystem or spawned CLI. resolveWorktreeHead is the
// one exception: it reads git's own plumbing files directly (`.git`, `HEAD`, loose/packed refs)
// — PURE FILESYSTEM, never a subprocess. That's deliberate: worker.test.ts's #69 grep-invariant
// test pins that `node:child_process` is importable ONLY by worker.ts (spawning the `claude` CLI
// itself) and gh.ts (`gh` via execFile) — no engine module, this one included, may ever exec
// `git`. Reading git's plumbing files by hand is the only way to recover a worktree's HEAD
// commit without crossing that boundary.
//
// Persistence lives in state.ts's context_manifests table (own table, own methods — see the
// schema v13->v14 migration comment), keyed by (round, phase, role, session, attempt). Issue
// #231 (input manifest, developed in parallel) will eventually LINK its rows to these via that
// SAME shared key — this module never builds or depends on that linkage; it only guarantees the
// key it writes under is stable and reconstructable independently of #231's schema.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
// #235 PR-B: a TYPE-ONLY import (see this module's header doc — PURE, no filesystem/subprocess
// of its own). worker.ts owns parseToolUsage (the jsonl-scan that PRODUCES this shape, the same
// "read side" home parseModelUsage/ModelUsageEntry already establish for spend); this module
// only carries the resulting data through assembleContextManifest, same as every other field
// here.
import type { ToolUsageEntry } from "./worker.js";

export type { ToolUsageEntry };

// ── Manifest shape ─────────────────────────────────────────────────────────────────────────

export type ContextSourceKind = "snapshot" | "absent";

/** Codex review round 1 (F3): a source is ALWAYS content-addressed inline, even one that lives
 *  inside the worktree's own git history — a separate "git-recoverable, hash-only" kind (this
 *  module's original design) was DELETED because it isn't actually trustworthy for a
 *  write-capable session (retro): the file could be modified/added/removed before retro's own
 *  commit, untracked, or symlinked, making `path + commit` NOT reproduce this exact content via
 *  `git show`. `gitCommit` survives as OPTIONAL, ADVISORY metadata only — "the worktree's
 *  resolved HEAD at capture time", never a recoverability guarantee. */
export interface SnapshotSource {
  kind: "snapshot";
  label: string;
  path: string;
  hash: string;
  content: string;
  /** ADVISORY ONLY (Codex F3): the worktree's resolved HEAD commit at capture time, present only
   *  for sources living inside a worktree whose HEAD this module could resolve. NOT a claim that
   *  `git show <gitCommit>:<path>` reproduces `content` — the actual bytes are captured above
   *  precisely because that claim cannot be trusted for a write-capable session. */
  gitCommit?: string;
}

/** A source path that's effective in principle but wasn't captured — recorded rather than
 *  silently dropped, so "this session saw fewer CLAUDE.md layers than usual" is itself a
 *  visible, diffable fact. */
export interface AbsentSource {
  kind: "absent";
  label: string;
  path: string;
  /** Codex F5b: an ENOENT (confirmed nonexistent) must never be conflated with any OTHER read
   *  failure (permission denied, path is a directory, a transient I/O error, ...) — the latter
   *  is a genuine blind spot ("we don't know what's there"), not "this layer legitimately
   *  doesn't exist". Defaults to `"absent"` only for callers/fixtures that don't distinguish. */
  reason: "absent" | "unreadable";
}

export type ContextSource = SnapshotSource | AbsentSource;

export interface WorktreeGitState {
  path: string;
  /** Resolved via resolveWorktreeHead's pure-filesystem git-plumbing read, or null when
   *  unresolvable (see that function's doc for the cases it gives up on — always honest, never
   *  a guess). */
  head: string | null;
  headResolution: "resolved" | "unresolved";
  dirty: boolean;
  /** How `dirty` was determined — never a measured `git status` call (this engine execs `git`
   *  nowhere outside worker.ts's claude-launch spawn / gh.ts's `gh` calls; see this module's
   *  header doc), so every value here is a DERIVATION, not a live read:
   *  - `"structural-no-write-tools"` — the session's effective ENGINE-GRANTED `--allowedTools`
   *    string carries NO WRITE-CAPABLE tool NAME (`Write`/`Edit`/`MultiEdit`/`NotebookEdit`/any
   *    `Bash(...)` entry — every peripheral role's `ROLE_ALLOWED_TOOLS`/`PO_ALLOWED_TOOLS`/
   *    `CONFIRM_ALLOWED_TOOLS` grant exactly `Read,Grep,Glob` and nothing else, #235 PR-B) and it
   *    gets a FRESH worktree, so `dirty: false` is a guarantee about that grant, not proof the
   *    session had no write capability at all: capability DR #616 means an unsealed session (any
   *    role not running gate②'s `reviewCwd` mode) can still inherit an ambient host MCP server
   *    with its own write-capable tools — `hasWriteCapableGrant`'s name-based check cannot see
   *    those, and this basis says nothing about them either. Before #235 this was phrased as
   *    "the grant is EMPTY" — that was equivalent back when the base allow-list carried nothing
   *    at all; #235 makes `Read`/`Grep`/`Glob` (guard-confined to the worktree, see
   *    `docs/security.md`) the universal peripheral baseline, so "empty" and "no write-capable
   *    tool" are no longer the same test — `peripheral.ts`'s `hasWriteCapableGrant` is the actual
   *    check this basis is derived from, not a bare emptiness check.
   *  - `"unknown-write-capable-session"` — the session's tool grant INCLUDES a write-capable
   *    tool (today: only `retro`, which holds `Write`/`Grep`/`Glob`/local `git` for its own
   *    worktree). The engine cannot prove clean vs. dirty without a live git-status read it
   *    structurally never performs, so `dirty` is recorded conservatively as `true` — an honest
   *    "cannot rule out," never a false "definitely clean" carried over from the
   *    no-write-capable-tool case it doesn't apply to.
   *  - `"worktree-missing"` (Codex F5d): the worktree path did not exist at capture time at all —
   *    a distinct, more specific fact than "unknown", so `dirty: true` here reads as "we could
   *    not even confirm the worktree existed", never conflated with the write-capable-but-present
   *    case above.
   *  - `"measured"` — reserved for a FUTURE real measurement mechanism; unused today (no call
   *    site sets it) but kept in the union so a later implementation has a value to report
   *    without redefining this field's shape. */
  dirtyBasis: "structural-no-write-tools" | "unknown-write-capable-session" | "worktree-missing" | "measured";
}

export interface ContextManifest {
  sources: ContextSource[];
  /** Codex F2b: every concrete path (or glob-style pattern, for a directory scan) this manifest
   *  actually checked for content — present or not. The affirmative complement to
   *  `knownUnprobed`: together they make this manifest's coverage claim precise instead of
   *  implicit ("every effective source" would be a lie; "these exact paths" is not). */
  probedPaths: string[];
  /** Codex F2b: a short, human-readable note naming the CLAUDE.md-resolution layers this module
   *  deliberately does NOT enumerate (Claude Code's `@import` directives inside a probed file,
   *  ancestor-directory CLAUDE.md files above the worktree root, and any managed/enterprise
   *  policy layer) — never silently omitted, always named. See this module's header doc for why
   *  chasing the full resolution graph is out of scope. */
  knownUnprobed: string;
  /** Codex F1 (anchor corrected in R1): when the FILESYSTEM-derived half of this manifest
   *  (sources, worktree HEAD, hook content) was captured — as early as this engine can observe
   *  it (anchored to the session's OWN init line, polled from its jsonl — see `captureBasis`),
   *  never at session teardown. For a write-capable session (retro), teardown-time capture would
   *  record "what the session left behind" (e.g. its own proposal commit) rather than "what it
   *  saw" — this timestamp makes that distinction auditable instead of implicit. */
  capturedPreSpawn: string;
  /** Codex F1: when the session'S OWN SELF-REPORT half (model/cliVersion/tools/mcpTools, plus
   *  the auto-memory source — its path is only knowable from this same self-report) was
   *  captured. Always at/after session exit: these values don't drift with worktree edits (the
   *  init event fires once, near stream start, before this manifest could possibly read it) and
   *  reading them at exit costs nothing extra (the same jsonl scan every other post-exit field
   *  already performs). */
  capturedPostExit: string;
  /** Codex F1 (R1): which anchor produced `capturedPreSpawn` — never silently assumed reliable.
   *  `"init-observed"`: the session's own `{"type":"system","subtype":"init"}` line was seen in
   *  its jsonl before the bound expired — the CLI had finished loading context (worktree
   *  provisioning included) and the model had not yet taken a turn, i.e. exactly "what the
   *  session saw". `"timeout-fallback"`: the bound expired with no init line ever observed (a
   *  hung/crashed-before-init session, or a CLI slower than the configured bound) — the
   *  filesystem-derived half was still captured (best-effort, never blocks the session), but
   *  its reliability is weaker and this field says so rather than hiding the ambiguity. */
  captureBasis: "init-observed" | "timeout-fallback";
  /** The model the session actually ran under (may differ from the requested model on a
   *  fallback-model switch) — prefer the session's OWN report over the request when available. */
  model: string;
  /** Codex F5a: which of the two possible sources `model` came from — never silently
   *  substituted. `"session-init"`: the session's own stream-json init report named a model.
   *  `"requested-fallback"`: the init report carried none (e.g. a stub with no init line, or a
   *  crashed-before-init session), so this falls back to the model the ENGINE requested — which
   *  may not be what actually ran. */
  modelSource: "session-init" | "requested-fallback";
  cliBin: string;
  cliVersion: string | null;
  /** Codex F5c (renamed from `toolSchemaVersion`): a content hash of the session's OWN reported
   *  tool-NAME inventory (worker.ts's parseSessionInit `tools`) — it hashes NAMES, never a tool
   *  schema (no CLI-exposed schema-version string exists; verified against Claude Code 2.1.212's
   *  stream-json init event). Identical hash == identical tool-name set available to the
   *  session; it is not evidence the underlying tool SCHEMAS (parameter shapes, descriptions)
   *  are unchanged. */
  toolInventoryHash: string | null;
  /** Same proxy rationale as toolInventoryHash: sapwood has no separate prompt-template-version
   *  registry today, so this is a content hash of the FULLY RENDERED prompt actually sent —
   *  arguably more precise than a template version number (it also captures per-round
   *  substitutions), and honestly documented as such rather than a fabricated version string. */
  promptTemplateVersion: string | null;
  /** `"<mcp server name>:<status>"` entries (e.g. "codegraph:pending") from the session's own
   *  init report — both the SET of available servers and each one's actual connection status,
   *  which is closer to "availability" than a bare name list. Sorted for determinism. */
  mcpTools: string[];
  /** #1010/#1011: the session's own init-reported EFFECTIVE host permission mode (the CLI's
   *  `permissionMode` field on its `system/init` stream-json line) — recorded alongside
   *  `mcpTools`/`toolInventoryHash` above with the same "prefer the session's own report" stance,
   *  no new hashing. The engine always REQUESTS the CONFIGURED `host.permissionMode` (`worker.ts`'s
   *  `REQUESTED_PERMISSION_MODE` is only that key's schema default, "auto"), but Claude Code can
   *  silently fall back to a different one when the requested mode is unavailable — this is the
   *  honest record of what the session actually got. `null` when the init line carried no such
   *  field (an older CLI, a parse miss, or a crashed-before-init session), never a guess. */
  permissionMode: string | null;
  /** #1010: how many `<sandbox_violations>` blocks worker.ts's `countSandboxViolations` found
   *  across this session's own denied-command `tool_result`s — the only stream-json evidence a
   *  Bash-sandbox profile engaged (see `permissionMode`'s own doc for why no positive-engagement
   *  field exists). Zero when none were found, never a guess; never affects the session's own
   *  outcome. */
  sandboxViolationCount: number;
  worktree: WorktreeGitState;
  /** Hash of the exact `--settings` JSON string passed to the CLI (guardSettings' output) —
   *  hashed rather than stored verbatim: it's fully reproducible from guardHookPath + guard
   *  mode, and keeping the manifest's bulk in the CLAUDE.md sources (the actual point of this
   *  file) matters more than duplicating a value the engine already knows how to regenerate. */
  settingsHash: string;
  /** Hash of the guard hook file's content, or null when unreadable at manifest time. */
  hookHash: string | null;
  /** #235 PR-B: which tools the session's stream actually INVOKED (name -> call count) —
   *  distinct from toolInventoryHash above, which only records what tools were AVAILABLE. Empty
   *  for a session whose jsonl carried no parseable tool_use block (a pure-text session, or one
   *  that crashed before its first turn). See worker.ts's parseToolUsage for the exact parse. */
  toolUsage: ToolUsageEntry[];
  /** #235 PR-B: every distinct path a Read/Grep/Glob/NotebookRead tool_use call named, sorted +
   *  deduplicated — the read-path half of "what did this session actually use" (item 4 of
   *  #235's acceptance criteria). An explicit path is recorded exactly as the session supplied
   *  it, never re-resolved; a PATHLESS Grep/Glob call (which searches — and reads from — the
   *  session's own cwd) is recorded as the caller-supplied worktree root instead of silently
   *  dropped (worker.ts's `parseToolUsage`'s `defaultSearchPath`, Codex review PR #257 F2) — see
   *  that function's doc for the exact substitution. #235 PR-A's guard hook
   *  (checkReadContainment) is the actual containment enforcement; this field is a diagnostic
   *  record of what was ASKED for / where it searched, not a re-verification of where it landed.
   *  Empty when the session made no such call. */
  readPaths: string[];
  recordedAt: string;
}

// ── Assembly (pure) ────────────────────────────────────────────────────────────────────────

/** One ambient source as read by the caller — content already loaded from disk (or wherever it
 *  lives) BEFORE calling assembleContextManifest, so this function stays fixture-testable with
 *  no real filesystem. */
export interface RawContextSource {
  label: string;
  path: string;
  /** Present file content, or null when the path wasn't captured at manifest time (see
   *  `reason` below for why). */
  content: string | null;
  /** Required in spirit whenever `content` is null (Codex F5b) — defaults to `"absent"` when
   *  omitted so existing fixtures that don't distinguish keep compiling. `"absent"`: confirmed
   *  nonexistent (ENOENT). `"unreadable"`: some OTHER read failure (permissions, a directory
   *  where a file was expected, ...) — a genuine blind spot that must never masquerade as "this
   *  layer legitimately doesn't exist". */
  reason?: "absent" | "unreadable";
  /** ADVISORY ONLY (Codex F3) — see SnapshotSource.gitCommit's doc. Omitted -> the resulting
   *  SnapshotSource carries no `gitCommit` field at all. */
  gitCommit?: string;
}

export interface ContextManifestEnv {
  sources: RawContextSource[];
  probedPaths: string[];
  knownUnprobed: string;
  capturedPreSpawn: string;
  capturedPostExit: string;
  captureBasis: "init-observed" | "timeout-fallback";
  model: string;
  modelSource: "session-init" | "requested-fallback";
  cliBin: string;
  cliVersion?: string | null;
  toolInventoryTools?: string[];
  promptTemplateSource?: string | null;
  /** `"<name>:<status>"` pairs or bare names — assemble() sorts, never re-derives status. */
  mcpTools: string[];
  /** #1010: optional so existing fixtures/callers that predate this field keep compiling —
   *  assemble() defaults an omitted value to `null`, same as `cliVersion` above. */
  permissionMode?: string | null;
  /** #1010: optional so existing fixtures/callers that predate this field keep compiling —
   *  assemble() defaults an omitted value to `0`, the same honest-empty stance every other
   *  omittable count/list field here takes. */
  sandboxViolationCount?: number;
  worktree: WorktreeGitState;
  settingsJson: string;
  /** The guard hook file's content, for hashing — null when unreadable. Assembling a manifest
   *  must never itself fail a session, so a read failure upstream is passed through as null
   *  rather than this function ever throwing. */
  hookContent: string | null;
  /** #235 PR-B: pre-parsed from the session's jsonl (worker.ts's parseToolUsage — the same jsonl
   *  string this manifest's other post-exit fields already scan). Omitted -> both resulting
   *  manifest fields default to `[]`, so existing fixtures/tests that don't care about this
   *  addition keep compiling unchanged. */
  toolUsage?: ToolUsageEntry[];
  readPaths?: string[];
  recordedAt: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Content hash of a sorted string list — the shared proxy tool/mcp-inventory hashing uses. */
function hashList(items: readonly string[]): string {
  return sha256(JSON.stringify([...items].sort()));
}

/** Pure: classify + hash every source, hash settings/hook/tool-inventory, sort mcpTools. Zero
 *  filesystem or subprocess access — every input is data the caller already gathered. Never
 *  throws (the manifest is diagnostic; a malformed input degrades to a null/empty field, never
 *  an exception that could abort session teardown). */
export function assembleContextManifest(env: ContextManifestEnv): ContextManifest {
  const sources: ContextSource[] = env.sources.map((s) => {
    if (s.content === null) return { kind: "absent", label: s.label, path: s.path, reason: s.reason ?? "absent" };
    const hash = sha256(s.content);
    return { kind: "snapshot", label: s.label, path: s.path, hash, content: s.content, ...(s.gitCommit ? { gitCommit: s.gitCommit } : {}) };
  });
  const tools = env.toolInventoryTools ?? [];
  return {
    sources,
    probedPaths: [...env.probedPaths],
    knownUnprobed: env.knownUnprobed,
    capturedPreSpawn: env.capturedPreSpawn,
    capturedPostExit: env.capturedPostExit,
    captureBasis: env.captureBasis,
    model: env.model,
    modelSource: env.modelSource,
    cliBin: env.cliBin,
    cliVersion: env.cliVersion ?? null,
    toolInventoryHash: tools.length > 0 ? hashList(tools) : null,
    promptTemplateVersion: env.promptTemplateSource ? sha256(env.promptTemplateSource) : null,
    mcpTools: [...env.mcpTools].sort(),
    permissionMode: env.permissionMode ?? null,
    sandboxViolationCount: env.sandboxViolationCount ?? 0,
    worktree: env.worktree,
    settingsHash: sha256(env.settingsJson),
    hookHash: env.hookContent === null ? null : sha256(env.hookContent),
    toolUsage: env.toolUsage ?? [],
    readPaths: env.readPaths ?? [],
    recordedAt: env.recordedAt,
  };
}

// ── Real-environment gathering (fs-only; no subprocess) ──────────────────────────────────────

const HEX40 = /^[0-9a-f]{40}$/i;

function tryReadTrim(path: string): string | null {
  try {
    return readFileSync(path, "utf8").trim();
  } catch {
    return null;
  }
}

export interface AmbientReadResult {
  content: string | null;
  /** Present (and meaningful) only when `content` is null — see RawContextSource.reason's doc. */
  reason?: "absent" | "unreadable";
}

/** #236 (Codex F5b): read a source file's content for the manifest — tolerant, never throws.
 *  Distinguishes ENOENT ("absent" — confirmed nonexistent) from any OTHER read failure
 *  ("unreadable" — permissions, a directory, a transient I/O error, ...): the latter is a real
 *  blind spot and must never be silently reported as "this layer legitimately doesn't exist". */
export function readAmbientSource(path: string): AmbientReadResult {
  try {
    return { content: readFileSync(path, "utf8") };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | undefined)?.code;
    return { content: null, reason: code === "ENOENT" ? "absent" : "unreadable" };
  }
}

/** Backward-compatible convenience wrapper over readAmbientSource for callers that only need the
 *  content (not the absent/unreadable distinction) — content only, tolerant, never throws. */
export function readAmbientSourceContent(path: string): string | null {
  return readAmbientSource(path).content;
}

/** Worktree-LOCAL git ref namespaces (Codex F4 residual, R3 — direction corrected from the
 *  original fix): per git's own repository-layout docs, once a worktree has a `commondir`,
 *  EVERY `refs/*` ref is SHARED (lives in the common store) EXCEPT these three prefixes, which
 *  are genuinely per-worktree and never appear in the common store at all:
 *  `refs/bisect/*` (an in-progress `git bisect`), `refs/rewritten/*` (`git rebase --update-refs`
 *  scratch state), and `refs/worktree/*` (explicitly worktree-scoped refs). The ORIGINAL version
 *  of this fix inverted the model — treating only `refs/heads/tags/remotes` as shared and
 *  everything else as worktree-local — which got common cases right by coincidence but would
 *  have mis-resolved any other shared namespace (e.g. `refs/notes/*`, a custom `refs/*`
 *  convention) from a stale worktree-local shadow. The default is now "shared unless in this
 *  small enumerated local set", matching git's actual layout. */
const WORKTREE_LOCAL_REF_NAMESPACES = ["refs/bisect/", "refs/rewritten/", "refs/worktree/"];

function isWorktreeLocalRef(ref: string): boolean {
  return WORKTREE_LOCAL_REF_NAMESPACES.some((ns) => ref.startsWith(ns));
}

/** Resolve `worktreePath`'s current HEAD commit via PURE FILESYSTEM reads of git's own plumbing
 *  files — no subprocess (see this module's header doc for why: the engine structurally never
 *  execs `git` outside worker.ts's claude-CLI-launch spawn and gh.ts's `gh` calls, pinned by
 *  worker.test.ts's #69 grep-invariant test). Handles the linked-worktree `.git` FILE form
 *  `git worktree add` always produces (a `gitdir:` pointer) — never a plain `.git` DIRECTORY,
 *  which resolves to null here (this function is only meant to run against an actual linked
 *  worktree). Resolves a detached HEAD directly, or a symbolic ref.
 *
 *  NAMESPACE-AWARE lookup (Codex F4, corrected direction in R3): a ref under one of the small,
 *  ENUMERATED worktree-local namespaces (`refs/bisect/*`, `refs/rewritten/*`,
 *  `refs/worktree/*`) is resolved worktree-local only. EVERY OTHER `refs/*` ref (branches, tags,
 *  remote-tracking, notes, or any custom namespace) is SHARED — resolved ONLY from the common
 *  dir (loose file, then `packed-refs`), NEVER from a worktree-local file under the same path,
 *  which — if present at all — is either stale or belongs to a different concept entirely and
 *  must not be allowed to shadow the real ref. Never throws: any missing/unexpected
 *  git-internals shape (a git version this wasn't tested against, a ref this doesn't know how
 *  to resolve) is an HONEST "couldn't determine" (null), never a guess. */
/** #428: the `gitdir:` pointer half of resolveWorktreeHead below, factored out so a second
 *  pure-filesystem git-plumbing reader (peripheral.ts's retro dirty check, which baselines on
 *  `<gitDir>/index`'s mtime) resolves a linked worktree's real git directory the SAME way rather
 *  than re-parsing the pointer file itself. Null on anything that isn't a linked worktree
 *  (`.git` absent, unreadable, or a plain DIRECTORY) — honest "couldn't determine", never a
 *  guess, exactly as resolveWorktreeHead's own doc describes. */
export function resolveWorktreeGitDir(worktreePath: string): string | null {
  try {
    const dotGitContent = tryReadTrim(join(worktreePath, ".git"));
    if (dotGitContent === null || !dotGitContent.startsWith("gitdir:")) return null;
    const gitDirRaw = dotGitContent.slice("gitdir:".length).trim();
    return isAbsolute(gitDirRaw) ? gitDirRaw : resolve(worktreePath, gitDirRaw);
  } catch {
    return null;
  }
}

/** #834: the shared "resolve the git-index-mtime PURITY BASELINE" glue peripheral.ts's
 *  maybeRetainWorktree (#428) established inline and worker.ts's settleMergedWorktree /
 *  worktree-janitor.ts's present-directory sweep arm now also need — factored out once three
 *  call sites wanted the identical `resolveWorktreeGitDir` + `<gitDir>/index` stat + NaN-on-
 *  failure shape, rather than growing a third copy. Returns `NaN` — worktreeMaybeDirty's own
 *  documented fail-safe-dirty input — whenever the `.git` pointer can't be resolved (not a
 *  linked worktree) or the index file can't be stat'd (no index written yet); never guesses a
 *  baseline it can't prove. PURE FILESYSTEM, same class as resolveWorktreeGitDir/
 *  resolveWorktreeHead above — no subprocess, so it stays outside worker.ts's #69 grep-invariant
 *  git-import boundary. */
export function resolveWorktreeIndexBaselineMs(worktreePath: string): number {
  const gitDir = resolveWorktreeGitDir(worktreePath);
  if (gitDir === null) return Number.NaN;
  try {
    return statSync(join(gitDir, "index")).mtimeMs;
  } catch {
    return Number.NaN; // no index written yet -> fail-safe dirty
  }
}

export function resolveWorktreeHead(worktreePath: string): string | null {
  try {
    const gitDir = resolveWorktreeGitDir(worktreePath);
    if (gitDir === null) return null;
    const head = tryReadTrim(join(gitDir, "HEAD"));
    if (head === null) return null;
    if (HEX40.test(head)) return head.toLowerCase(); // detached HEAD
    const refMatch = /^ref:\s*(\S+)$/.exec(head);
    if (!refMatch) return null;
    const ref = refMatch[1]!;
    const commonDirRaw = tryReadTrim(join(gitDir, "commondir"));
    const commonDir = commonDirRaw ? (isAbsolute(commonDirRaw) ? commonDirRaw : resolve(gitDir, commonDirRaw)) : gitDir;
    const worktreeLocal = isWorktreeLocalRef(ref);
    // Shared refs (the default — everything except the small worktree-local set above) resolve
    // from the common store ONLY — a worktree-local file under the same path (stale or
    // otherwise) must never be consulted, let alone win (Codex F4).
    const looseCandidate = worktreeLocal ? join(gitDir, ref) : join(commonDir, ref);
    const sha = tryReadTrim(looseCandidate);
    if (sha && HEX40.test(sha)) return sha.toLowerCase();
    if (!worktreeLocal) {
      const packed = tryReadTrim(join(commonDir, "packed-refs"));
      if (packed) {
        for (const line of packed.split("\n")) {
          const t = line.trim();
          if (!t || t.startsWith("#") || t.startsWith("^")) continue;
          const parts = t.split(/\s+/);
          const packedSha = parts[0];
          const packedRef = parts[1];
          if (packedRef === ref && packedSha && HEX40.test(packedSha)) return packedSha.toLowerCase();
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Shared pre-spawn CLAUDE.md-family probe (#617: factored out of peripheral.ts so worker.ts's
// producer-leg manifest wiring reuses the SAME probe list instead of growing a parallel one — this
// repo's "one scanner, not a second one" doctrine, #410's scanEgressSuspects precedent) ─────────

/** Codex F2b: the fixed, honest note every manifest carries naming what this module deliberately
 *  does NOT enumerate. A single shared constant (not per-call prose) keeps this claim consistent
 *  across every manifest this engine ever writes — peripheral role sessions and, as of #617,
 *  worker/producer legs too. */
export const KNOWN_UNPROBED_NOTE =
  "Deliberately NOT enumerated: @import directives inside any probed file, ancestor-directory " +
  "CLAUDE.md files above the worktree root, and any managed/enterprise policy layer — this " +
  "engine records the standard sources it can cheaply probe (see probedPaths), not Claude " +
  "Code's full CLAUDE.md resolution graph.";

/** Sorted `*.md` file names under `dirPath`, RECURSIVELY — tolerant of a missing/unreadable
 *  directory (returns `[]`, never throws). Each entry is a path RELATIVE to `dirPath` (so a
 *  nested file reads as `"sub/nested.md"`, joinable back onto `dirPath` by the caller) — used for
 *  the `.claude/rules/` scan. Node's `recursive: true` readdir option requires Node 20.17+/22.2+;
 *  this engine's floor is Node >=24 (root `package.json`), so it's always available. */
export function listMarkdownFileNames(dirPath: string): string[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true, recursive: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => relative(dirPath, join((d.parentPath as string | undefined) ?? dirPath, d.name)))
      .sort();
  } catch {
    return [];
  }
}

/** The CLAUDE.md-family half of a pre-spawn manifest capture: `<worktreePath>/CLAUDE.md`,
 *  `CLAUDE.local.md`, `.claude/CLAUDE.md`, every `*.md` recursively under `.claude/rules/`, and
 *  the user-global CLAUDE.md (`$CLAUDE_CONFIG_DIR/CLAUDE.md` when set, else `~/.claude/CLAUDE.md`).
 *  `head` is a plain argument, never resolved here — callers already have their OWN
 *  resolveWorktreeHead (this module's, or worker.ts's #490 `.git`-path variant), and this
 *  function stays agnostic to which one produced it. */
export function captureClaudeMdSources(worktreePath: string, head: string | null): { sources: RawContextSource[]; probedPaths: string[] } {
  const probedPaths: string[] = [];
  const sources: RawContextSource[] = [];
  const addSource = (label: string, path: string): void => {
    probedPaths.push(path);
    const r = readAmbientSource(path);
    sources.push({
      label,
      path,
      content: r.content,
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
      ...(r.content !== null && head ? { gitCommit: head } : {}),
    });
  };

  addSource("repo CLAUDE.md", join(worktreePath, "CLAUDE.md"));
  addSource("repo CLAUDE.local.md", join(worktreePath, "CLAUDE.local.md"));
  addSource("repo .claude/CLAUDE.md", join(worktreePath, ".claude", "CLAUDE.md"));

  const rulesDirPath = join(worktreePath, ".claude", "rules");
  probedPaths.push(join(rulesDirPath, "**", "*.md")); // recorded even if the directory is absent
  for (const fileName of listMarkdownFileNames(rulesDirPath)) {
    addSource(`repo .claude/rules/${fileName}`, join(rulesDirPath, fileName));
  }

  const userConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
  addSource("user-global CLAUDE.md", join(userConfigDir, "CLAUDE.md"));

  return { sources, probedPaths };
}

/** The FILESYSTEM-derived half of one session attempt's context manifest — CLAUDE.md-family
 *  sources plus the guard hook's own content, captured together so a caller (peripheral.ts's
 *  RoleRunner, worker.ts's WorkerSupervisor) has one function to call right after its own
 *  init-line anchor fires (or times out) rather than assembling this shape by hand. */
export interface PreSpawnManifestCapture {
  sources: RawContextSource[];
  probedPaths: string[];
  head: string | null;
  /** False when the init-line-anchored capture ran but the worktree still didn't exist on disk
   *  at that instant — a distinct fact from "worktree present but every source happened to be
   *  absent". */
  worktreeAppeared: boolean;
  hookContent: string | null;
  capturedAt: string;
  /** `"init-observed"`: the session's own init line was seen before the bound expired.
   *  `"timeout-fallback"`: the bound expired with no init line ever observed — capture still
   *  proceeds (best-effort, never blocks the session), but the manifest names the ambiguity
   *  rather than silently presenting it as equally reliable. */
  captureBasis: "init-observed" | "timeout-fallback";
}

export function capturePreSpawnManifestData(
  worktreePath: string,
  worktreeAppeared: boolean,
  captureBasis: PreSpawnManifestCapture["captureBasis"],
  head: string | null,
  guardHookPath: string,
  capturedAt: string,
): PreSpawnManifestCapture {
  const { sources, probedPaths } = captureClaudeMdSources(worktreePath, head);
  const hookRead = readAmbientSource(guardHookPath);
  return { sources, probedPaths, head, worktreeAppeared, hookContent: hookRead.content, capturedAt, captureBasis };
}
