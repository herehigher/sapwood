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
// records exactly what it actually saw, so ambient drift between retries (a CLAUDE.md edited
// between attempt 1 and attempt 2, a dirty worktree, a config change) never makes two attempts
// of the same phase look like apples-to-apples when they weren't. Isolation remains correct —
// but only for BENCHMARK runs, documented as a separate recipe in docs/security.md, never wired
// into production dispatch (it needs `--bare`-style flags that also disable the guard hook).
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
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

// ── Manifest shape ─────────────────────────────────────────────────────────────────────────

export type ContextSourceKind = "git" | "snapshot" | "absent";

/** A CLAUDE.md/policy file whose content is recoverable from git history: path + commit is
 *  enough to reproduce it later (`git show <commit>:<path>`, run by a human/tool OUTSIDE this
 *  engine's own no-git-exec boundary), so the content itself is never duplicated into the
 *  manifest — only its hash, to detect drift. */
export interface GitRecoverableSource {
  kind: "git";
  label: string;
  path: string;
  commit: string;
  hash: string;
}

/** A MUTABLE ambient source (e.g. the user's global `~/.claude/CLAUDE.md` or an auto-memory
 *  file) — edited out-of-band, with no commit to pin content recovery to. Content-addressed: the
 *  ACTUAL content is captured inline, never a bare hash of content that could later change or
 *  disappear (the #236 acceptance criterion: "mutable ambient sources are content-addressed
 *  snapshots, not bare hashes of now-lost content"). */
export interface SnapshotSource {
  kind: "snapshot";
  label: string;
  path: string;
  hash: string;
  content: string;
}

/** A source path that's effective in principle but was absent on disk at manifest time —
 *  recorded rather than silently dropped, so "this session saw fewer CLAUDE.md layers than
 *  usual" is itself a visible, diffable fact. */
export interface AbsentSource {
  kind: "absent";
  label: string;
  path: string;
}

export type ContextSource = GitRecoverableSource | SnapshotSource | AbsentSource;

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
   *  - `"structural-no-write-tools"` — the session's effective tool grant is EMPTY (most
   *    peripheral roles: ROLE_ALLOWED_TOOLS/PO_ALLOWED_TOOLS carry no Write/Edit/Bash at all)
   *    and it gets a FRESH worktree, so `dirty: false` is a structural guarantee, not a guess.
   *  - `"unknown-write-capable-session"` — the session's tool grant is NON-EMPTY (today: only
   *    `retro`, which holds `Write`/local `git` for its own worktree). The engine cannot prove
   *    clean vs. dirty without a live git-status read it structurally never performs, so `dirty`
   *    is recorded conservatively as `true` — an honest "cannot rule out," never a false
   *    "definitely clean" carried over from the empty-allowlist case it doesn't apply to.
   *  - `"measured"` — reserved for a FUTURE real measurement mechanism; unused today (no call
   *    site sets it) but kept in the union so a later implementation has a value to report
   *    without redefining this field's shape. */
  dirtyBasis: "structural-no-write-tools" | "unknown-write-capable-session" | "measured";
}

export interface ContextManifest {
  sources: ContextSource[];
  /** The model the session actually ran under (may differ from the requested model on a
   *  fallback-model switch) — prefer the session's OWN report over the request when available. */
  model: string;
  cliBin: string;
  cliVersion: string | null;
  /** No CLI-exposed schema-version string exists (verified against Claude Code 2.1.212's
   *  stream-json init event) — this is a content hash of the session's OWN reported tool-name
   *  inventory (worker.ts's parseSessionInit `tools`), a faithful proxy: identical hash ==
   *  identical tool schema surface, without fabricating a version string the CLI doesn't emit. */
  toolSchemaVersion: string | null;
  /** Same proxy rationale as toolSchemaVersion: sapwood has no separate prompt-template-version
   *  registry today, so this is a content hash of the FULLY RENDERED prompt actually sent —
   *  arguably more precise than a template version number (it also captures per-round
   *  substitutions), and honestly documented as such rather than a fabricated version string. */
  promptTemplateVersion: string | null;
  /** `"<mcp server name>:<status>"` entries (e.g. "codegraph:pending") from the session's own
   *  init report — both the SET of available servers and each one's actual connection status,
   *  which is closer to "availability" than a bare name list. Sorted for determinism. */
  mcpTools: string[];
  worktree: WorktreeGitState;
  /** Hash of the exact `--settings` JSON string passed to the CLI (guardSettings' output) —
   *  hashed rather than stored verbatim: it's fully reproducible from guardHookPath + guard
   *  mode, and keeping the manifest's bulk in the CLAUDE.md sources (the actual point of this
   *  file) matters more than duplicating a value the engine already knows how to regenerate. */
  settingsHash: string;
  /** Hash of the guard hook file's content, or null when unreadable at manifest time. */
  hookHash: string | null;
  recordedAt: string;
}

// ── Assembly (pure) ────────────────────────────────────────────────────────────────────────

/** One ambient source as read by the caller — content already loaded from disk (or wherever it
 *  lives) BEFORE calling assembleContextManifest, so this function stays fixture-testable with
 *  no real filesystem. */
export interface RawContextSource {
  label: string;
  path: string;
  /** Present file content, or null when the path didn't exist at manifest time. */
  content: string | null;
  /** Set when this source is git-tracked and recoverable at this commit — the caller decides
   *  recoverability (typically: "lives inside the session's own worktree, at its resolved
   *  HEAD"); this function only encodes the resulting shape (GitRecoverableSource vs.
   *  SnapshotSource). Omitted -> always a SnapshotSource (content captured inline), even if the
   *  path happens to live inside some OTHER git repo the caller didn't pin a commit for. */
  gitCommit?: string;
}

export interface ContextManifestEnv {
  sources: RawContextSource[];
  model: string;
  cliBin: string;
  cliVersion?: string | null;
  toolSchemaTools?: string[];
  promptTemplateSource?: string | null;
  /** `"<name>:<status>"` pairs or bare names — assemble() sorts, never re-derives status. */
  mcpTools: string[];
  worktree: WorktreeGitState;
  settingsJson: string;
  /** The guard hook file's content, for hashing — null when unreadable. Assembling a manifest
   *  must never itself fail a session, so a read failure upstream is passed through as null
   *  rather than this function ever throwing. */
  hookContent: string | null;
  recordedAt: string;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Content hash of a sorted string list — the shared proxy tool/mcp-inventory hashing uses. */
function hashList(items: readonly string[]): string {
  return sha256(JSON.stringify([...items].sort()));
}

/** Pure: classify + hash every source, hash settings/hook/tool-schema, sort mcpTools. Zero
 *  filesystem or subprocess access — every input is data the caller already gathered. Never
 *  throws (the manifest is diagnostic; a malformed input degrades to a null/empty field, never
 *  an exception that could abort session teardown). */
export function assembleContextManifest(env: ContextManifestEnv): ContextManifest {
  const sources: ContextSource[] = env.sources.map((s) => {
    if (s.content === null) return { kind: "absent", label: s.label, path: s.path };
    const hash = sha256(s.content);
    if (s.gitCommit) return { kind: "git", label: s.label, path: s.path, commit: s.gitCommit, hash };
    return { kind: "snapshot", label: s.label, path: s.path, hash, content: s.content };
  });
  const tools = env.toolSchemaTools ?? [];
  return {
    sources,
    model: env.model,
    cliBin: env.cliBin,
    cliVersion: env.cliVersion ?? null,
    toolSchemaVersion: tools.length > 0 ? hashList(tools) : null,
    promptTemplateVersion: env.promptTemplateSource ? sha256(env.promptTemplateSource) : null,
    mcpTools: [...env.mcpTools].sort(),
    worktree: env.worktree,
    settingsHash: sha256(env.settingsJson),
    hookHash: env.hookContent === null ? null : sha256(env.hookContent),
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

/** #236: read a source file's content for the manifest — tolerant, never throws. Absence (ENOENT
 *  or any other read failure) reads as null, which assembleContextManifest turns into an
 *  AbsentSource rather than dropping the source entirely. */
export function readAmbientSourceContent(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/** Resolve `worktreePath`'s current HEAD commit via PURE FILESYSTEM reads of git's own plumbing
 *  files — no subprocess (see this module's header doc for why: the engine structurally never
 *  execs `git` outside worker.ts's claude-CLI-launch spawn and gh.ts's `gh` calls, pinned by
 *  worker.test.ts's #69 grep-invariant test). Handles the linked-worktree `.git` FILE form
 *  `git worktree add` always produces (a `gitdir:` pointer) — never a plain `.git` DIRECTORY,
 *  which resolves to null here (this function is only meant to run against an actual linked
 *  worktree). Resolves a detached HEAD directly, or a symbolic ref via a loose ref file
 *  (worktree-local, then the shared common dir) falling back to `packed-refs`. Never throws:
 *  any missing/unexpected git-internals shape (a git version this wasn't tested against, a
 *  ref this doesn't know how to resolve) is an HONEST "couldn't determine" (null), never a
 *  guess and never a crash. */
export function resolveWorktreeHead(worktreePath: string): string | null {
  try {
    const dotGitContent = tryReadTrim(join(worktreePath, ".git"));
    if (dotGitContent === null || !dotGitContent.startsWith("gitdir:")) return null;
    const gitDirRaw = dotGitContent.slice("gitdir:".length).trim();
    const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(worktreePath, gitDirRaw);
    const head = tryReadTrim(join(gitDir, "HEAD"));
    if (head === null) return null;
    if (HEX40.test(head)) return head.toLowerCase(); // detached HEAD
    const refMatch = /^ref:\s*(\S+)$/.exec(head);
    if (!refMatch) return null;
    const ref = refMatch[1]!;
    const commonDirRaw = tryReadTrim(join(gitDir, "commondir"));
    const commonDir = commonDirRaw ? (isAbsolute(commonDirRaw) ? commonDirRaw : resolve(gitDir, commonDirRaw)) : gitDir;
    for (const candidate of [join(gitDir, ref), join(commonDir, ref)]) {
      const sha = tryReadTrim(candidate);
      if (sha && HEX40.test(sha)) return sha.toLowerCase();
    }
    const packed = tryReadTrim(join(commonDir, "packed-refs"));
    if (packed) {
      for (const line of packed.split("\n")) {
        const t = line.trim();
        if (!t || t.startsWith("#") || t.startsWith("^")) continue;
        const parts = t.split(/\s+/);
        const sha = parts[0];
        const packedRef = parts[1];
        if (packedRef === ref && sha && HEX40.test(sha)) return sha.toLowerCase();
      }
    }
    return null;
  } catch {
    return null;
  }
}
