// peripheral.ts — the peripheral role runner (#87): runs ONE headless Claude Code session
// scoped to issues-only writes (comment/label/edit issues — never code, never PR review,
// never approve, never merge). Reuses worker.ts's spawn machinery directly (spawnClaudeSession,
// claudeArgs, guardSettings, discoverClaudeBin, parseCostUsd/parseModelUsage) — this module
// never imports `node:child_process` itself (see the #69 grep-invariant test in
// worker.test.ts): worker.ts stays the engine's ONE module that touches the CLI/subprocess
// layer; this module adds a second, NARROWER session shape entirely on top of what it exports.
//
// Unlike WorkerSupervisor's dispatch-now/probe-later two-phase model (built for long-running,
// resumable, PR-producing lanes), a role session's whole point is to run to completion as ONE
// bounded `await` — round.ts's PeripheralStub.run() contract is exactly that shape. So
// RoleRunner.run() spawns, waits out the process, and returns — no probe(), no resume(), no
// dirty-worktree retention (a role session never writes code — allowedTools scoping AND the
// unchanged guard hook both block it — so its worktree is always safe to delete afterward).
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { SapwoodConfig } from "../config/config.js";
import type { ForgeProxyHandle } from "../proxy/mcp-server.js";
import type { ContextManifestKey, ModelUsageEntry, State } from "../state/state.js";
import {
  assembleContextManifest,
  type ContextManifest,
  type RawContextSource,
  readAmbientSource,
  resolveWorktreeHead,
  type WorktreeGitState,
} from "./context-manifest.js";
import {
  claudeArgs,
  discoverClaudeBin,
  guardSettings,
  hasSessionInitLine,
  parseCostUsd,
  parseModelUsage,
  parseResultText,
  parseSessionInit,
  parseToolUsage,
  type SpawnedSession,
  spawnClaudeSession,
} from "./worker.js";

/** #235 PR-B (owner ruling 2026-07-17): the allow/deny matrix for EVERY issues-only peripheral
 *  role (plan-reviewer, plan-drafter, PO/align+triage+pool, harvest, architect) — the ONE place
 *  this matrix is defined, per-role exports below just naming which pair each session wires
 *  in. Two prior rulings combine here:
 *
 *  - Information channels widen wherever side-effect-free: whether to read is the model's own
 *    role-scoped judgment (an architect reasoning about a contradiction via an approval protocol
 *    instead of just reading the code is absurd) — no role needs Read denied on
 *    separation-of-duties grounds, because reading is not producing/approving/merging. So
 *    ROLE_ALLOWED_TOOLS now carries `Read,Grep,Glob` for every peripheral role — architect is
 *    NOT a special case, and neither is any other role in this family.
 *  - The REAL containment boundary for that read grant is #235 PR-A's guard-hook confinement
 *    (`checkReadContainment` in guard.ts, keyed off `SAPWOOD_WORKTREE_ROOT` — see
 *    peripheralSessionEnv below): Read/Grep/Glob resolve to real file content, but ONLY inside
 *    this session's own ephemeral worktree, host-path and `../`-traversal reads both denied.
 *    This allow/deny pair is the CLI's own permission layer on top of that — noise reduction,
 *    same stance every allow/deny list in this file has always taken (worker.ts's own doc), but
 *    now backed by a real fail-closed mechanism on the read side too, not just the write side.
 *
 *  ROLE_DISALLOWED_TOOLS is the cross-source veto half: `--disallowedTools` is a HARD deny that
 *  wins over allow from ANY source, including a target repo's own checked-out
 *  `.claude/settings.json` — an authorization surface this engine does not control. `Write`/
 *  `Edit`/`MultiEdit`/`NotebookEdit` close every write channel; a blanket `Bash` (the bare tool
 *  name, not a pattern) closes command execution entirely — no `git`, no `gh`, no shell of any
 *  kind. This SUBSUMES the old per-pattern `Bash(gh ...)` denies (#101/#102's `--body-file`/
 *  `-F`/`-l`/`-p` bypass classes are moot when there is no Bash grant to bypass THROUGH at all)
 *  and the plan-drafter's/PO's extra label-mutation denies below — simplified accordingly.
 *  Read-only git (`git log` etc.) deliberately stays OUT: the blanket Bash deny already covers
 *  it, and the issue's own scope explicitly excludes adding it as a distinct grant.
 *
 *  Kept as regression trip-wires (peripheral.test.ts pins these exact strings, and the derived
 *  per-role pairs below): a future PR that re-widens either list — an added allow entry, a
 *  removed deny entry — lands inside a failing test rather than silently reopening either the
 *  read-containment boundary or the write/exec boundary this pair enforces. */
export const ROLE_ALLOWED_TOOLS = "Read,Grep,Glob";
export const ROLE_DISALLOWED_TOOLS = "Write,Edit,MultiEdit,NotebookEdit,Bash";

/** The plan-DRAFTER's deny list (#77 Amendment 2's plan-author ≠ plan-approver chain): kept as
 *  its OWN named export — the same regression-trip-wire stance ROLE_DISALLOWED_TOOLS itself
 *  documents — even though #235 PR-B's blanket Bash deny above already makes it byte-identical
 *  to the base. Before #235, this carried extra `Bash(gh issue edit *--add-label/--remove-
 *  label*)` patterns; those are now REDUNDANT (no Bash grant at all reaches `gh` to mutate a
 *  label with in the first place) and have been dropped — label discipline is structural
 *  (plan-review.ts never calls forge.addLabel on the drafter's behalf, see that module's doc),
 *  not a pattern-layer concern anymore. */
export const PLAN_DRAFTER_DISALLOWED_TOOLS = ROLE_DISALLOWED_TOOLS;

/** #214 gate② review (P1) / #235 PR-B: the freshness re-confirm session ("does this plan still
 *  hold against current main?") used to need its OWN allow-list widening — before #235, the base
 *  ROLE_ALLOWED_TOOLS carried no Read grant at all, so this was the SECOND sanctioned widening
 *  in this codebase (after retro.ts's RETRO_ALLOWED_TOOLS). #235 PR-B makes Read/Grep/Glob the
 *  UNIVERSAL peripheral-role baseline, so this pair is no longer a widening at all — it is now
 *  byte-identical to ROLE_ALLOWED_TOOLS/ROLE_DISALLOWED_TOOLS. Kept as its own named export
 *  anyway (same stance as PO_ALLOWED_TOOLS below): plan-review.ts's confirm callsite still
 *  documents which pair it wires explicitly, and a future accidental widening of JUST this
 *  role's grant still lands inside its own regression-trip-wire test. */
export const CONFIRM_ALLOWED_TOOLS = ROLE_ALLOWED_TOOLS;
export const CONFIRM_DISALLOWED_TOOLS = ROLE_DISALLOWED_TOOLS;

/** #110 PR5 / #235 PR-B: the PO/alignment role also carries no Bash grant — `gh issue create` is
 *  performed by the engine from align.ts's validated structured output, never by the session
 *  itself. PO_ALLOWED_TOOLS/PO_DISALLOWED_TOOLS are kept as their own exports (rather than
 *  folded away) so align.ts's callsite still documents which role-specific allow/deny pair it
 *  wires, unchanged in shape from before #110/#235 even though their values are now identical to
 *  the base ROLE_ALLOWED_TOOLS/ROLE_DISALLOWED_TOOLS. Before #235, PO_DISALLOWED_TOOLS carried
 *  extra `Bash(gh issue create *--body-file/--label/--project*)` patterns (#101/#102) closing
 *  flag holes the old (narrower) allow-list opened; those are now REDUNDANT under the blanket
 *  Bash deny and have been dropped. */
export const PO_ALLOWED_TOOLS = ROLE_ALLOWED_TOOLS;
export const PO_DISALLOWED_TOOLS = ROLE_DISALLOWED_TOOLS;

export interface RoleSessionOpts {
  /** A short, log-friendly role identity ("plan-reviewer", "plan-drafter", ...) — becomes
   *  part of the session's lane/sentinel name, never interpreted. */
  roleId: string;
  prompt: string;
  model: string;
  effort: string;
  fallbackModel: string;
  /** #89/#91/#110: per-role ALLOW-list override — the symmetric widening counterpart to
   *  disallowedTools below, for a role whose job legitimately needs MORE than the base
   *  issues-only ROLE_ALLOWED_TOOLS (now empty, #110 PR5). retro.ts's RETRO_ALLOWED_TOOLS (git +
   *  `gh pr create`, #77 decision 6 — proposals land EXCLUSIVELY as PRs) is the ONLY remaining
   *  widening pair: PO_ALLOWED_TOOLS used to widen for `gh issue create` (#89) but #110 retired
   *  that need — the engine performs issue creation itself from align.ts's validated structured
   *  output now. Omitted -> the base ROLE_ALLOWED_TOOLS, unchanged for every role that doesn't
   *  need it. Widening the allow-list is always paired with a role-specific disallowedTools
   *  override too (see retro.ts) — never shipped wide-open. */
  allowedTools?: string;
  /** Per-role deny-list override (e.g. PLAN_DRAFTER_DISALLOWED_TOOLS). Omitted -> the base
   *  ROLE_DISALLOWED_TOOLS. Deny rules take precedence over allows in Claude Code, so this
   *  only ever narrows the base allow scope, never widens it. */
  disallowedTools?: string;
  /** #111 PR-B: an ENGINE-CHOSEN relative path inside the session's ephemeral worktree, read
   *  by the runner RIGHT BEFORE the worktree's unconditional deletion and returned as
   *  RoleSessionResult.scratchText. This is the return channel for a role whose deliverable is
   *  too session-lifecycle-coupled for the final-message structured block (retro writes its PR
   *  proposal to this file mid-session, after its git push — a file survives a truncated
   *  stream/context cutoff that would lose the final message, and a raw file has no
   *  embedded-sentinel collision surface for a body that documents this very codebase). The
   *  path is fixed BY THE CALLER (retro.ts's RETRO_SCRATCH_FILE), never by the session — the
   *  engine decides where it looks; the session can only decide what the file says.
   *
   *  CONTAINMENT (Codex round 1, PR #119): "inside the worktree" is enforced by run() itself,
   *  not assumed — a path that resolves outside the session's worktree root (`../`-escaping,
   *  absolute) is refused with a stderr line and reads as absent (scratchText undefined),
   *  never a file read outside the root. */
  scratchFile?: string;
  /** #234: optional read-only forge MCP proxy attached to this session. When present,
   *  RoleRunner.run() mints a fresh per-session server+token via `mint` (keyed by this exact
   *  session's generated lane name), widens the effective `--allowedTools` with the proxy's
   *  fixed `mcp__forge__*` tool names, injects the resulting inline `--mcp-config`, and
   *  revokes/tears down the handle once the session exits — in EVERY outcome (done/failed/
   *  timeout), before the worktree is deleted. A mint failure is non-fatal (logged, session
   *  proceeds without the proxy attached) — an optional capability's setup failure must never
   *  wedge a role session that would otherwise run fine unaugmented. peripheralSessionEnv's
   *  credential-stripping is unaffected either way: the proxy's bearer token travels via the
   *  `--mcp-config` header, never the spawn env — the proxy is the session's only forge reach. */
  proxy?: {
    mint: (session: { role: string; session: string }) => Promise<ForgeProxyHandle>;
  };
}

export interface RoleSessionResult {
  outcome: "done" | "failed" | "timeout";
  costUsd: number;
  modelUsage: ModelUsageEntry[];
  exitCode: number | null;
  /** The session/lane name this run used — callers key spend-ledger rows off it. */
  name: string;
  /** #110 PR1: the session's final-message text, extracted via worker.ts's parseResultText —
   *  the READ side a role-session caller needs to actually consume structured output (PR0 added
   *  the extraction primitive but wired no caller to it). Always present (possibly "") on a
   *  REAL RoleRunner.run() result; optional here only so the many existing test fakes across
   *  align.test.ts/architect.test.ts/harvest.test.ts/retro.test.ts/round-defaults.test.ts (roles
   *  that don't consume structured output yet, per #110's PR sequence) keep compiling without
   *  updating every literal they construct. A caller that DOES need it reads `?? ""`, the same
   *  empty-string-not-undefined convention parseResultText itself already guarantees. */
  resultText?: string;
  /** #111 PR-B: the raw content of RoleSessionOpts.scratchFile, read from the session's
   *  worktree immediately BEFORE its unconditional deletion. undefined when no scratchFile was
   *  requested OR the file was absent/unreadable — the caller's validator decides what a
   *  missing file means (retro.ts treats it as an invalid attempt: fail closed, retry once,
   *  then the degrade path — never a silently skipped deliverable). */
  scratchText?: string;
  /** #236: this attempt's ambient-context manifest — every effective CLAUDE.md/policy source,
   *  model/CLI/tool-schema/prompt-template info, MCP availability, worktree HEAD, and settings/
   *  hook hashes, gathered right before the worktree is deleted below. Most role sessions hold
   *  no write-capable tool grant at all, so their worktree is provably unchanged from spawn time
   *  (capturing here is equivalent to "at spawn"); `retro` is the one exception (Write + local
   *  git) — see WorktreeGitState's `dirtyBasis` doc for how that case is honestly represented
   *  rather than assumed clean. Always present on a REAL RoleRunner.run() result; optional here
   *  only so existing test fakes (which construct a RoleSessionResult literal directly, never
   *  through RoleRunner.run()) keep compiling without updating every literal — same convention
   *  resultText/scratchText already use. */
  contextManifest?: ContextManifest;
}

export interface RoleRunnerDeps {
  cfg: SapwoodConfig;
  log?: (message: string) => void;
  /** Directory for sentinels/jsonl. Default <cwd>/data/sessions/roles (distinct from
   *  worker.ts's data/sessions/state — role sessions and worker lanes never share a
   *  namespace, so a name collision between the two is structurally impossible). */
  stateDir?: string;
  /** Parent directory holding each session's ephemeral git worktree — same convention as
   *  worker.ts's worktreeRoot. Default <cwd>/.claude/worktrees. */
  worktreeRoot?: string;
  claudeBin?: string;
  /** Path to the compiled guard hook. Default: the dist sibling of this module. */
  guardHookPath?: string;
  heartbeatMs?: number;
  now?: () => Date;
  /** #236 (Codex F1, corrected in R1): bounded poll of the session's OWN stream-json jsonl file
   *  for its `{"type":"system","subtype":"init"}` line, before capturing the filesystem-derived
   *  half of the context manifest. The init line is the CLI's own signal that it finished
   *  loading context (CLAUDE.md layers, MCP servers, tool schema) — the exact "what the session
   *  saw" moment, and (as a side effect) proof the worktree provisioning that same startup did
   *  is complete. This REPLACES the original design (a bounded wait for the worktree DIRECTORY
   *  to exist), which a focused-suite run caught racing: directory existence does not imply
   *  checkout-complete, so a fast poll could observe an empty/partial worktree and record
   *  `CLAUDE.md` as absent when it was actually still being written. Default 100ms poll / 30s
   *  bound (generous — production worktree+context-load is normally well under a second),
   *  overridden lower in tests that don't care about the timeout-fallback path itself. */
  preSpawnCaptureTimeoutMs?: number;
  preSpawnCapturePollMs?: number;
  /** #253: a DEFAULT forge MCP proxy mint, applied to every session whose own RoleSessionOpts
   *  doesn't supply one. round-defaults.ts's stub factories (align.ts/architect.ts/plan-
   *  review.ts/harvest.ts/retro.ts) each build their own session object per invocation, none of
   *  which attach a `proxy` opt today — rather than touching every one of those call sites, the
   *  engine's real startup wiring (cli.ts) supplies ONE mint HERE, shared across every
   *  peripheral phase/round this RoleRunner instance ever runs. A per-call `opts.proxy` still
   *  WINS when a caller supplies one (see run()'s `proxyOpt` fallback below) — this is a
   *  fallback, never a silent override.
   *
   *  cli.ts only ever CONSTRUCTS this field (and passes it here) in the proxy's production-
   *  attach state — `cfg.proxy.enabled: true, shadow: false` (#253 review round 2, H1's
   *  three-state ruling: `enabled: false` never constructs one; `enabled: true, shadow: true`,
   *  the default once enabled, ALSO never constructs one — the machinery stays mintable for a
   *  scoped harness, but no production session holds a handle). peripheral.ts itself has no
   *  opinion on `shadow` at all — this field is simply present or absent, the same "omitted =
   *  today's behavior, unchanged: no session anywhere gets a proxy attached" contract regardless
   *  of WHY the caller omitted it. */
  defaultProxy?: RoleSessionOpts["proxy"];
}

const SENTINEL_EXTS = ["running.json", "done.json", "failed.json", "jsonl"];

/** #236: the FILESYSTEM-derived half of one session attempt's context manifest, captured by
 *  RoleRunner.capturePreSpawnManifestData right after the init-line anchor fires (or the bound
 *  times out) — see that method's doc. Combined with the POST-EXIT self-report half in
 *  RoleRunner.assembleManifest. */
interface PreSpawnManifestCapture {
  sources: RawContextSource[];
  probedPaths: string[];
  head: string | null;
  /** False when the init-line-anchored capture ran but the worktree still didn't exist on disk
   *  at that instant — a distinct fact from "worktree present but every source happened to be
   *  absent" (Codex F5d). Independent of `captureBasis` below: a timeout-fallback capture can
   *  still find a worktree that eventually appeared just after the bound expired, and (in
   *  principle, for a very slow/broken CLI) an init-observed capture could still race a
   *  not-yet-flushed worktree — this is a direct `existsSync` check at capture time, not an
   *  inference from which basis fired. */
  worktreeAppeared: boolean;
  hookContent: string | null;
  capturedAt: string;
  /** Codex F1 (R1): which anchor actually fired — never silently assumed. `"init-observed"`:
   *  the session's own init line was seen in its jsonl before the bound expired (the honest,
   *  intended case). `"timeout-fallback"`: the bound expired with no init line ever observed
   *  (a hung/crashed-before-init session, or a CLI slower than the configured bound) — capture
   *  still proceeds (best-effort, never blocks the session), but the manifest names the
   *  ambiguity rather than silently presenting it as equally reliable. */
  captureBasis: "init-observed" | "timeout-fallback";
}

/** Codex F2b: the fixed, honest note every manifest carries naming what this module deliberately
 *  does NOT enumerate — see context-manifest.ts's module doc and ContextManifest.knownUnprobed's
 *  own doc for the full rationale. A single shared constant (not per-call prose) keeps this
 *  claim consistent across every manifest this engine ever writes. */
const KNOWN_UNPROBED_NOTE =
  "Deliberately NOT enumerated: @import directives inside any probed file, ancestor-directory " +
  "CLAUDE.md files above the worktree root, and any managed/enterprise policy layer — this " +
  "engine records the standard sources it can cheaply probe (see probedPaths), not Claude " +
  "Code's full CLAUDE.md resolution graph.";

/** Sorted `*.md` file names under `dirPath`, RECURSIVELY (Codex F2 residual, R2b — the original
 *  scan took only direct children, missing e.g. `.claude/rules/sub/nested.md`) — tolerant of a
 *  missing/unreadable directory (returns `[]`, never throws). Each entry is a path RELATIVE to
 *  `dirPath` (so a nested file reads as `"sub/nested.md"`, joinable back onto `dirPath` by the
 *  caller) — used for the `.claude/rules/` scan. Node's `recursive: true` readdir option
 *  requires Node 20.17+/22.2+; this engine's floor is Node >=24 (root `package.json`), so it's
 *  always available. */
function listMarkdownFileNames(dirPath: string): string[] {
  try {
    return readdirSync(dirPath, { withFileTypes: true, recursive: true })
      .filter((d) => d.isFile() && d.name.endsWith(".md"))
      .map((d) => relative(dirPath, join((d.parentPath as string | undefined) ?? dirPath, d.name)))
      .sort();
  } catch {
    return [];
  }
}

/** Bounded poll of `jsonlPath` for the session's own init line — the synchronization primitive
 *  #236's pre-spawn manifest capture uses (Codex F1, R1). Resolves `true` the instant the line
 *  is observed, or `false` once `timeoutMs` elapses without it ever appearing (a hung/crashed-
 *  before-init session) — never throws, never waits longer than the bound. Reads the file fresh
 *  on every poll tick (the same tolerant, still-growing-file reader every other jsonl consumer
 *  in this codebase uses); a file that doesn't exist yet reads as `""`, not an error. */
async function waitForInitLine(jsonlPath: string, timeoutMs: number, pollMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let content = "";
    try {
      content = readFileSync(jsonlPath, "utf8");
    } catch {
      /* not created / not flushed yet — keep polling */
    }
    if (hasSessionInitLine(content)) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(pollMs, remaining));
  }
}

/** Build a peripheral session environment without forge credentials or git credential
 *  injection vectors. This is deliberately a denylist rather than a small allowlist: the
 *  Claude CLI may authenticate through Anthropic environment variables or user config, and
 *  also relies on platform-specific runtime variables. Peripheral roles need that runtime
 *  environment, but never need GitHub credentials because they have no forge responsibilities.
 *
 *  Keep this boundary paired with ROLE_ALLOWED_TOOLS's zero-write, zero-`Bash` allowlist (#235
 *  PR-B: `Read,Grep,Glob` only, guard-confined to the worktree — no longer the empty string
 *  #110 shipped, but still zero forge-reaching capability). That allowlist is the primary
 *  action boundary; stripping credentials ensures a future tool-widening regression cannot
 *  silently turn an inherited engine credential into forge authority. */
function peripheralSessionEnv(guardMode: SapwoodConfig["guard"]["mode"], worktreePath: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    const normalized = key.toUpperCase();
    if (
      normalized === "GITHUB_TOKEN" ||
      normalized === "GITHUB_ENTERPRISE_TOKEN" ||
      normalized.startsWith("GH_") ||
      normalized === "GIT_ASKPASS" ||
      normalized.startsWith("GIT_CONFIG_")
    ) {
      continue;
    }
    env[key] = value;
  }
  env.SAPWOOD_GUARD_MODE = guardMode;
  // #235 PR-A: the ABSOLUTE path of THIS role session's worktree, so the guard hook can
  // confine Read/Grep/Glob to it (see guard.ts's checkReadContainment). worktreePath is
  // already resolve()'d by the caller (RoleRunner.run()), the same convention as the
  // scratchFile containment check a few lines below this function's call site.
  env.SAPWOOD_WORKTREE_ROOT = worktreePath;
  return env;
}

/** #235 PR-B: does this `--allowedTools` string grant any WRITE-capable tool — the exact set
 *  assembleManifest's worktree.dirty derivation needs to distinguish from a read-only grant
 *  (Read/Grep/Glob, now the universal peripheral baseline, ROLE_ALLOWED_TOOLS above). Checked as
 *  discrete comma-separated tokens, not a bare substring test — `Bash(...)` entries carry
 *  arbitrary suffixes (e.g. retro's `Bash(git branch*)`), so a token is write-capable when it
 *  IS one of the fixed write-tool names or STARTS WITH `Bash` (any Bash grant is write-capable
 *  by definition: shell access can always mutate the worktree, regardless of which command
 *  pattern it's scoped to). */
function hasWriteCapableGrant(allowedTools: string): boolean {
  return allowedTools
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .some((t) => t === "Write" || t === "Edit" || t === "MultiEdit" || t === "NotebookEdit" || t.startsWith("Bash"));
}

export class RoleRunner {
  private readonly dir: string;
  private readonly worktreeRoot: string;
  private readonly bin: string;
  private readonly hbMs: number;
  private readonly guardHookPath: string;
  private readonly preSpawnCaptureTimeoutMs: number;
  private readonly preSpawnCapturePollMs: number;

  constructor(private readonly deps: RoleRunnerDeps) {
    this.dir = deps.stateDir ?? join(process.cwd(), "data", "sessions", "roles");
    this.worktreeRoot = deps.worktreeRoot ?? join(process.cwd(), ".claude", "worktrees");
    this.bin = deps.claudeBin ?? discoverClaudeBin(process.env);
    this.hbMs = deps.heartbeatMs ?? 30_000;
    this.guardHookPath = deps.guardHookPath ?? fileURLToPath(new URL("../guard/guard-hook.js", import.meta.url));
    this.preSpawnCaptureTimeoutMs = deps.preSpawnCaptureTimeoutMs ?? 30_000;
    this.preSpawnCapturePollMs = deps.preSpawnCapturePollMs ?? 100;
    mkdirSync(this.dir, { recursive: true });
  }

  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }
  private path(name: string, ext: string): string {
    return join(this.dir, `${name}.${ext}`);
  }

  /** Run ONE role session to completion. Never throws on the session's own outcome (done/
   *  failed/timeout are all normal returns) — only throws on a setup failure (name collision,
   *  missing guard hook in hard mode, spawn failure) that must abort the caller's whole
   *  attempt, mirroring worker.ts's dispatch() fail-fast contract for the same conditions. */
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    const name = `role-${opts.roleId}-${randomUUID().slice(0, 8)}`;
    for (const ext of SENTINEL_EXTS) {
      if (existsSync(this.path(name, ext))) {
        throw new Error(`role session name in use (${name}.${ext} exists) — reassign a fresh name`);
      }
    }
    const guardMode = this.deps.cfg.guard.mode;
    if (guardMode === "hard" && !existsSync(this.guardHookPath)) {
      throw new Error(
        `guard hook not found at ${this.guardHookPath} — build the engine (npm run build) before ` +
          `running a role session; refusing to run an unguarded session in hard mode`,
      );
    }
    const sessionId = randomUUID();
    const jsonlPath = this.path(name, "jsonl");
    const jsonlFd = openSync(jsonlPath, "w");
    // Same inline-JSON (never a file) guard wiring as worker.ts's dispatch(), for the same
    // reason: a settings FILE would be an on-disk target the session could try to mutate.
    const settingsJson = JSON.stringify(guardSettings(this.guardHookPath));
    // #234: mint the read-only forge MCP proxy BEFORE building argv — the resulting tool names
    // widen allowedTools and the mcp-config is an inline argv value, so both must be known before
    // claudeArgs runs. Non-fatal on failure (see RoleSessionOpts.proxy's doc): the session simply
    // runs without the proxy attached, never a wedged/aborted role session over an optional
    // capability's own setup failure.
    // #253: opts.proxy (a caller-supplied mint for THIS session) wins when present; otherwise
    // fall back to the RoleRunner-wide default (RoleRunnerDeps.defaultProxy's own doc) — the
    // engine's real startup wiring attaches the default there rather than touching every
    // stub's own session-construction call site.
    const proxyOpt = opts.proxy ?? this.deps.defaultProxy;
    let proxyHandle: ForgeProxyHandle | undefined;
    if (proxyOpt) {
      try {
        proxyHandle = await proxyOpt.mint({ role: opts.roleId, session: name });
      } catch (e) {
        (this.deps.log ?? console.error)(`[sapwood:forge-proxy] session ${name}: mint failed (non-fatal, proxy unattached): ${String(e)}`);
      }
    }
    // #234 F5 (PR #252 review, P1, Codex #6): EVERYTHING from here on is wrapped in try/finally
    // so the proxy is torn down (token revoked, listener closed) no matter HOW this method exits
    // past a successful mint — including the spawn-error throw a few lines down, and any future
    // exception this method might grow. Before this fix, a spawn failure threw BEFORE the
    // (then-inline) teardown block ever ran, leaking the HTTP listener + a live, never-revoked
    // bearer token for the engine's remaining lifetime.
    try {
      const baseAllowedTools = opts.allowedTools ?? ROLE_ALLOWED_TOOLS;
      const allowedTools = proxyHandle
        ? [baseAllowedTools, ...proxyHandle.toolNames].filter((s) => s.length > 0).join(",")
        : baseAllowedTools;
      const args = claudeArgs({
        prompt: opts.prompt,
        model: opts.model,
        effort: opts.effort,
        fallbackModel: opts.fallbackModel,
        worktree: name,
        name,
        sessionId,
        settings: settingsJson,
        allowedTools,
        disallowedTools: opts.disallowedTools ?? ROLE_DISALLOWED_TOOLS,
        ...(proxyHandle ? { mcpConfig: proxyHandle.mcpConfigJson } : {}),
        // NB: no addDir — same as worker.ts's dispatch(): a role session must never see engine
        // state (sentinels, the sqlite db) via --add-dir.
      });
      const startedMs = this.now().getTime();
      const session = spawnClaudeSession(this.bin, args, {
        jsonlFd,
        env: peripheralSessionEnv(guardMode, resolve(this.worktreeRoot, name)),
      });

      // Register the exit listener BEFORE any await — same rationale as worker.ts's dispatch():
      // Node does not replay `exit` to late listeners, so a very fast exit must already be caught.
      let timedOut = false;
      const exitPromise = new Promise<number | null>((resolve) => {
        session.onExit((code) => resolve(code));
      });

      let spawnErr: unknown;
      await new Promise<void>((resolve) => {
        session.onSpawn(() => resolve());
        session.onError((e) => {
          spawnErr = e;
          resolve();
        });
      });
      if (spawnErr) {
        try {
          closeSync(jsonlFd);
        } catch {
          /* noop */
        }
        this.removeIfExists(jsonlPath);
        throw new Error(`role session spawn failed (${this.bin}): ${String(spawnErr)}`);
      }
      session.onError(() => {
        /* post-spawn error: exitPromise's `exit` still resolves this */
      });

      this.writeJsonAtomic(this.path(name, "running.json"), {
        name,
        role_id: opts.roleId,
        session_id: sessionId,
        wrapper_pid: session.pid,
        started_at: new Date(startedMs).toISOString(),
      });

      // #236 (Codex F1, anchor corrected in R1): capture the FILESYSTEM-derived half of the
      // context manifest (CLAUDE.md-family sources, worktree HEAD, guard hook content) as early as
      // this engine can possibly observe it — right after spawn confirmation, BEFORE waiting out
      // the session. Anchored to the session's OWN init line (worker.ts's hasSessionInitLine),
      // polled from its still-growing jsonl — NOT a bounded wait for the worktree DIRECTORY to
      // exist (the original design): directory existence does not imply checkout-complete, and a
      // focused-suite run caught that race live (CLAUDE.md recorded absent once, flaky). The init
      // line is the CLI's own signal that context loading (worktree provisioning included) is
      // done — the model has not yet taken a turn, so this is exactly the "what the session saw"
      // moment. This matters most for a write-capable session (retro): capturing at TEARDOWN (the
      // pre-#236-fix behavior) would record "what the session left behind" (its own proposal
      // commit, a possibly-edited CLAUDE.md) — not what it started with. If the init line is never
      // observed within the bound, capture proceeds anyway (best-effort, never blocks the
      // session) — `captureBasis` on the resulting manifest names which case fired, never silently
      // presenting a timeout-fallback capture as equally reliable.
      const worktreePath = join(this.worktreeRoot, name);
      const initObserved = await waitForInitLine(jsonlPath, this.preSpawnCaptureTimeoutMs, this.preSpawnCapturePollMs);
      const captureBasis: PreSpawnManifestCapture["captureBasis"] = initObserved ? "init-observed" : "timeout-fallback";
      const worktreeAppeared = existsSync(worktreePath);
      const preSpawn = this.capturePreSpawnManifestData(worktreePath, worktreeAppeared, captureBasis);

      // Wall-clock timeout ceiling (worker.ts's heartbeatTick semantics, minus the live
      // soft-budget estimator — a role session's cost is bounded by its own scope, not tracked
      // mid-run): past worker.timeoutSec, kill the tree; the exit handler above still resolves
      // exitPromise (with whatever code the kill produces), so run() always returns normally.
      const hb = setInterval(() => {
        const elapsedSec = (this.now().getTime() - startedMs) / 1000;
        if (!timedOut && elapsedSec > this.deps.cfg.worker.timeoutSec) {
          timedOut = true;
          clearInterval(hb);
          void this.killTree(session);
        }
      }, this.hbMs);

      const exitCode = await exitPromise;
      clearInterval(hb);
      try {
        closeSync(jsonlFd);
      } catch {
        /* already closed */
      }

      const jsonl = this.readJsonl(jsonlPath);
      const costUsd = parseCostUsd(jsonl);
      const modelUsage = parseModelUsage(jsonl);
      // #110 PR1: the structured-output READ side — same jsonl scan parseCostUsd/parseModelUsage
      // already do, so this costs nothing extra to compute even for roles that don't consume it.
      const resultText = parseResultText(jsonl);
      const outcome: "done" | "failed" | "timeout" = timedOut ? "timeout" : exitCode === 0 ? "done" : "failed";
      const sentinelTag = outcome === "timeout" ? "failed" : outcome;
      this.writeJsonAtomic(this.path(name, `${sentinelTag}.json`), {
        name,
        role_id: opts.roleId,
        session_id: sessionId,
        exit_code: exitCode,
        total_cost_usd: costUsd,
        model_usage: modelUsage,
        ended_at: this.now().toISOString(),
        timed_out: timedOut,
      });
      this.removeIfExists(this.path(name, "running.json"));

      // #111 PR-B: read the caller-requested scratch file BEFORE the worktree deletion below —
      // the deliverable would otherwise be destroyed with the worktree. Absent/unreadable reads
      // as undefined (never a throw): the caller's own validator owns deciding what that means.
      //
      // PATH CONTAINMENT (Codex review round 1, PR #119): the API's contract is "a path INSIDE
      // the session's worktree" — enforced here, in the API itself, not left to callers. A bare
      // join() would let a `../..`-shaped or absolute scratchFile normalize OUTSIDE the worktree
      // and read arbitrary engine files into scratchText. Today's only caller passes a fixed
      // constant (retro.ts's RETRO_SCRATCH_FILE), but the invariant must hold regardless of who
      // calls tomorrow: resolve both sides and require the target to sit strictly UNDER the
      // worktree root. A violating path reads as absent (scratchText undefined — the caller's
      // fail-closed validator path) plus one stderr line naming it — never a read outside root.
      let scratchText: string | undefined;
      if (opts.scratchFile !== undefined) {
        const root = resolve(this.worktreeRoot, name);
        const target = resolve(root, opts.scratchFile);
        if (!target.startsWith(root + sep)) {
          (this.deps.log ?? console.error)(
            `[sapwood:role] session ${name}: scratchFile ${JSON.stringify(opts.scratchFile)} resolves ` +
              `outside the session worktree (${target}) — refusing to read it; scratchText stays undefined`,
          );
        } else {
          try {
            scratchText = readFileSync(target, "utf8");
          } catch {
            /* absent */
          }
        }
      }

      // #236: assemble the POST-EXIT half of the manifest (the session's own self-report — model/
      // cliVersion/tools/mcpTools — plus the auto-memory source, whose path is only knowable from
      // that same self-report) and combine it with the pre-spawn capture above. Never lets
      // manifest gathering fail the session — every read inside is individually tolerant, and the
      // whole block is still guarded here as defense-in-depth.
      let contextManifest: ContextManifest | undefined;
      try {
        contextManifest = this.assembleManifest(name, opts, jsonl, settingsJson, preSpawn);
      } catch (e) {
        (this.deps.log ?? console.error)(`[sapwood:context-manifest] session ${name}: failed to assemble (non-fatal): ${String(e)}`);
      }

      // Always delete the worktree — see the module doc: a role session never writes code
      // (allowedTools scoping + the unchanged guard hook both block it), so unlike worker.ts's
      // dirty-vs-clean retention there is no WIP that could ever need preserving here. Retro's
      // one worktree deliverable (the scratch file) was already captured above; its actual code
      // proposal lives on its PUSHED BRANCH, never in the worktree.
      try {
        rmSync(join(this.worktreeRoot, name), { recursive: true, force: true });
      } catch {
        /* best-effort */
      }

      return {
        outcome,
        costUsd,
        modelUsage,
        exitCode,
        name,
        resultText,
        ...(scratchText !== undefined ? { scratchText } : {}),
        ...(contextManifest !== undefined ? { contextManifest } : {}),
      };
    } finally {
      // #234 F5: revoke + tear down the proxy in EVERY outcome this try block can exit
      // through — normal return, the spawn-error throw above, or any future exception — never
      // only the happy path. A teardown failure is logged, never propagated: the session's own
      // result (or the spawn error already being thrown) is never masked by the proxy's own
      // cleanup failing.
      if (proxyHandle) {
        try {
          await proxyHandle.stop();
        } catch (e) {
          (this.deps.log ?? console.error)(`[sapwood:forge-proxy] session ${name}: teardown failed (non-fatal): ${String(e)}`);
        }
      }
    }
  }

  /** #236 (Codex F1/F2/F3, R1/R2 residual fixes): the FILESYSTEM-derived half of the context
   *  manifest — read once the init-line anchor fires (see run()'s call site doc). Probes a
   *  deliberately bounded, ENUMERATED set of standard CLAUDE.md-family sources (F2 ruling —
   *  never the full resolution graph): `<worktree>/CLAUDE.md`, `<worktree>/CLAUDE.local.md`,
   *  `<worktree>/.claude/CLAUDE.md` (Codex R2a — an officially documented layer the original F2
   *  fix missed), every `*.md` RECURSIVELY under `<worktree>/.claude/rules/` (Codex R2b — the
   *  original scan took only direct children), and the user-global CLAUDE.md — from
   *  `$CLAUDE_CONFIG_DIR/CLAUDE.md` when that env var is set, else `~/.claude/CLAUDE.md` (Codex
   *  R2c — the original hardcoded `homedir()` unconditionally, which is simply wrong when the
   *  operator has relocated Claude Code's config dir). Every source is captured INLINE (F3 —
   *  content-addressed, never a bare git-commit pointer, even for worktree-rooted files: a
   *  write-capable session could still modify/add/remove/untrack one before its own commit, so
   *  `gitCommit` here is ADVISORY metadata only, never a recoverability claim). `worktreeAppeared`
   *  false means the worktree still wasn't on disk at the moment of capture — every source
   *  therefore reads as absent for a real reason (there was nothing to read), which the caller
   *  folds into a `"worktree-missing"` dirtyBasis rather than a plain "clean" or "dirty" guess. */
  private capturePreSpawnManifestData(
    worktreePath: string,
    worktreeAppeared: boolean,
    captureBasis: PreSpawnManifestCapture["captureBasis"],
  ): PreSpawnManifestCapture {
    const capturedAt = this.now().toISOString();
    const probedPaths: string[] = [];
    const sources: RawContextSource[] = [];
    const head = resolveWorktreeHead(worktreePath);

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

    // Mutable, global — path known upfront (no worktree dependency at all), never git-pinned.
    // CLAUDE_CONFIG_DIR (Codex R2c), when set, IS the effective user-global config directory —
    // honoring it here is the difference between probing the real ambient source and a path
    // that's simply wrong on any machine that relocated it.
    const userConfigDir = process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
    addSource("user-global CLAUDE.md", join(userConfigDir, "CLAUDE.md"));

    const hookRead = readAmbientSource(this.guardHookPath);

    return { sources, probedPaths, head, worktreeAppeared, hookContent: hookRead.content, capturedAt, captureBasis };
  }

  /** #236: the POST-EXIT half — the session's own stream-json self-report (worker.ts's
   *  parseSessionInit) plus the auto-memory source (its path is only knowable from that same
   *  report) — combined with the pre-spawn capture into the final manifest. */
  private assembleManifest(
    name: string,
    opts: RoleSessionOpts,
    jsonl: string,
    settingsJson: string,
    pre: PreSpawnManifestCapture,
  ): ContextManifest {
    const init = parseSessionInit(jsonl);
    const capturedPostExit = this.now().toISOString();

    const sources = [...pre.sources];
    const probedPaths = [...pre.probedPaths];
    if (init.memoryPathAuto) {
      const memoryPath = join(init.memoryPathAuto, "MEMORY.md");
      probedPaths.push(memoryPath);
      const memRead = readAmbientSource(memoryPath);
      sources.push({
        label: "auto-memory MEMORY.md",
        path: memoryPath,
        content: memRead.content,
        ...(memRead.reason !== undefined ? { reason: memRead.reason } : {}),
      });
    }

    // See WorktreeGitState.dirtyBasis's doc: a NO-WRITE-CAPABLE-TOOL effective grant is a
    // structural "cannot have been dirtied" guarantee; a grant that includes any write-capable
    // tool (Write/Edit/MultiEdit/NotebookEdit/any Bash(...) entry — today: only `retro`, which
    // holds Write + local git) means the engine cannot rule out a write without a live `git
    // status` it structurally never performs — record that conservatively as dirty, never a
    // false "definitely clean". A worktree that never appeared at all (Codex F5d) gets its OWN
    // distinct basis, never folded into either.
    //
    // #235 PR-B: this used to be a bare "is the allow-list non-empty" check — correct back when
    // ROLE_ALLOWED_TOOLS was "" (an empty grant WAS the only no-write case). #235 PR-B makes
    // Read/Grep/Glob the universal peripheral baseline, so the allow-list is now non-empty for
    // EVERY role while still granting zero write capability — the emptiness check would have
    // mis-recorded every issues-only role's worktree as conservatively dirty. hasWriteCapableGrant
    // below checks for an actual write-capable TOKEN instead of mere non-emptiness.
    const worktreePath = join(this.worktreeRoot, name);
    const effectiveAllowedTools = opts.allowedTools ?? ROLE_ALLOWED_TOOLS;
    const writeCapable = hasWriteCapableGrant(effectiveAllowedTools);
    const worktree: WorktreeGitState = !pre.worktreeAppeared
      ? { path: worktreePath, head: null, headResolution: "unresolved", dirty: true, dirtyBasis: "worktree-missing" }
      : {
          path: worktreePath,
          head: pre.head,
          headResolution: pre.head ? "resolved" : "unresolved",
          dirty: writeCapable,
          dirtyBasis: writeCapable ? "unknown-write-capable-session" : "structural-no-write-tools",
        };

    // #235 PR-B: parse tool usage from the SAME jsonl string every other post-exit field above
    // already scans (worker.ts's parseToolUsage — item 4 of #235's acceptance criteria: which
    // paths/tools a session actually USED land in the manifest). worktreePath (this session's
    // own resolved worktree root, already computed above) is passed as defaultSearchPath: a
    // pathless Grep/Glob call searches exactly this cwd, and Codex review (PR #257 F2) flagged
    // that omitting it understated what the session actually read.
    const { toolUsage, readPaths } = parseToolUsage(jsonl, worktreePath);

    return assembleContextManifest({
      sources,
      probedPaths,
      knownUnprobed: KNOWN_UNPROBED_NOTE,
      capturedPreSpawn: pre.capturedAt,
      capturedPostExit,
      captureBasis: pre.captureBasis,
      model: init.model ?? opts.model,
      modelSource: init.model ? "session-init" : "requested-fallback",
      cliBin: this.bin,
      cliVersion: init.cliVersion,
      toolInventoryTools: init.tools,
      promptTemplateSource: opts.prompt,
      mcpTools: init.mcpServers.map((s) => `${s.name}:${s.status}`),
      worktree,
      settingsJson,
      hookContent: pre.hookContent,
      toolUsage,
      readPaths,
      recordedAt: capturedPostExit,
    });
  }

  private async killTree(session: SpawnedSession): Promise<void> {
    session.killGroup("SIGTERM");
    await sleep(200);
    session.killGroup("SIGKILL");
  }

  private readJsonl(p: string): string {
    try {
      return readFileSync(p, "utf8");
    } catch {
      return "";
    }
  }
  private writeJsonAtomic(p: string, obj: unknown): void {
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj) + "\n");
    renameSync(tmp, p);
  }
  private removeIfExists(p: string): void {
    try {
      rmSync(p, { force: true });
    } catch {
      /* noop */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── #104: shared session-retry helper ───────────────────────────────────────────────────────
//
// architect.ts/align.ts/harvest.ts/retro.ts each hand-rolled the exact same shape (a same-class
// recurrence flagged at gate② on #100/#101/#103): dispatch a role session, record its spend,
// and if its outcome isn't "done" — RoleRunner.run never throws on the session's OWN outcome
// (see the module doc above), so a failed/timeout result is a normal return that MUST be
// checked, not assumed — retry exactly once; a second non-"done" outcome degrades VISIBLY (a
// durable state event plus a stderr line) rather than either silently no-op'ing or wedging the
// round forever. Extracted here as the ONE implementation every caller now ports to.
//
// Deliberately NOT extracted: plan-review.ts's reviewer-session retry. Its shape diverges in a
// way that matters — a second failure there ESCALATES needs-human (a dispatch-gating verdict,
// via forge label/comment, not a state event) rather than degrading-and-proceeding, and only
// the reviewer (never the drafter) is retried at all. Forcing that into this same helper would
// either lose the escalation behavior or bloat the helper with a branch only one caller uses.

/** One session dispatch, with spend recorded against `issue` (0 = round-level, no single issue —
 *  the same documented sentinel every caller already used). */
export interface RetriedSession {
  runner: Pick<RoleRunner, "run">;
  state: Pick<State, "recordSpend" | "appendEvent">;
  session: RoleSessionOpts;
  /** spend_ledger's `issue` column: a real issue number, or 0 for round-level spend with no
   *  single associated issue (harvest/architect/retro's own documented sentinel). */
  issue: number;
  now: () => Date;
  /** The event kind appended on a SECOND non-"done" outcome (e.g. "architect-degraded"). */
  degradeEvent: string;
  /** Built from the final (second) attempt's result — callers keep full control over their own
   *  event payload shape (some include `attempts: 2`, some fold in an `issue` key only when
   *  non-zero — see harvest.ts/retro.ts vs. align.ts), so behavior stays byte-identical to what
   *  each site hand-rolled before this extraction. */
  degradePayload: (result: RoleSessionResult) => Record<string, unknown>;
  /** Same rationale: the stderr line's wording is role-specific ("advisory phase, round not
   *  wedged" vs. "pre-Ready, low stakes", ...), so the caller supplies it verbatim. */
  degradeMessage: (result: RoleSessionResult) => string;
  log?: (message: string) => void;
  /** #110 PR0: OPTIONAL extra pass/fail check beyond `outcome` itself. A "done" outcome that
   *  fails this predicate is treated as a NON-"done" outcome for retry/degrade purposes — e.g.
   *  a session that exited cleanly but whose structured final-message output failed schema
   *  validation (parseResultText's write-side consumers, landing in later #110 PRs). FAIL
   *  CLOSED on a throw (Codex review round 1, P2): a validator that THROWS (e.g. a future
   *  caller's bare zod.parse) counts as invalid — retry once, then the degrade path — never a
   *  propagated exception, which would wedge the round in violation of #110's "malformed output
   *  twice -> degrade path, never a wedged round". Omitted -> today's behavior is
   *  byte-identical: only `outcome` decides done vs. not-done. */
  isValid?: (result: RoleSessionResult) => boolean;
  /** #236: OPTIONAL context-manifest recording — round/phase key prefix plus the persist
   *  callback. Kept as a SEPARATE field rather than widening `state` above's Pick type, so
   *  every existing caller/test fake (typed against `Pick<State,"recordSpend"|"appendEvent">`)
   *  is UNCHANGED — omitted here means no manifest is recorded, zero behavior change. When
   *  supplied, EVERY attempt (not just the final one) is persisted — that's the whole point:
   *  two attempts of one phase must be independently reconstructable, and ambient drift between
   *  them (a CLAUDE.md edited mid-retry, a dirty worktree) is exactly what would otherwise be
   *  lost. `role`/`session`/`attempt` are filled in by runSessionWithRetry itself (role from
   *  `session.roleId`, session from each attempt's own result name, attempt from the 1-or-2
   *  retry ordinal) — the caller supplies only the round/phase half of the key. See
   *  context-manifest.ts's module doc for the (round, phase, role, session, attempt) tuple
   *  #231's separately-developed input manifest joins on later; this module never depends on
   *  that work. */
  contextManifest?: {
    roundId: number;
    phase: string;
    /** Typically `state.recordContextManifest.bind(state)` — kept as a plain function (not a
     *  `Pick<State,...>` object) so a caller can wrap it (e.g. to no-op in a test) without
     *  needing a second fake-state shape. */
    record: (key: ContextManifestKey, json: string, recordedAt: string) => void;
  };
}

/** Run one role session; on a non-"done" outcome (or, when `isValid` is supplied, a "done"
 *  outcome that also fails `isValid` — #110 PR0), retry exactly once; on a SECOND such outcome,
 *  durably record the degradation (contained — a state-write failure here never throws, same
 *  fail-toward-more-work stance as every other appendEvent call site in this codebase) and log
 *  it to stderr. Always returns the LAST attempt's result (the caller decides what "still not
 *  done" means for its own phase: proceed without a note, skip a summary/proposal, etc. — this
 *  helper only owns the retry-and-degrade mechanics, never the phase's own business logic). */
export async function runSessionWithRetry(opts: RetriedSession): Promise<RoleSessionResult> {
  const iso = (): string => opts.now().toISOString();
  const attempt = async (n: number): Promise<RoleSessionResult> => {
    const result = await opts.runner.run(opts.session);
    opts.state.recordSpend(result.name, opts.issue, result.costUsd, iso(), result.modelUsage);
    // #236: persist THIS attempt's context manifest, if the caller opted in and the runner
    // produced one (a fake runner in tests typically won't — RoleSessionResult.contextManifest
    // is optional exactly for that reason, see its own doc). Contained: a persist failure is
    // logged, never propagated — recording ambient context must never itself wedge a round.
    if (opts.contextManifest && result.contextManifest) {
      try {
        const key: ContextManifestKey = {
          roundId: opts.contextManifest.roundId,
          phase: opts.contextManifest.phase,
          role: opts.session.roleId,
          session: result.name,
          attempt: n,
        };
        opts.contextManifest.record(key, JSON.stringify(result.contextManifest), iso());
      } catch (e) {
        (opts.log ?? console.error)(`[sapwood:context-manifest] ${result.name} attempt ${n}: failed to persist (non-fatal): ${String(e)}`);
      }
    }
    return result;
  };
  // isValid omitted -> isDone reduces to the original `outcome === "done"` check exactly.
  // A THROWING validator counts as invalid (fail closed, see the RetriedSession doc above) —
  // the throw must feed the retry/degrade machinery, never escape it.
  const isDone = (result: RoleSessionResult): boolean => {
    if (result.outcome !== "done") return false;
    if (!opts.isValid) return true;
    try {
      return opts.isValid(result);
    } catch {
      return false;
    }
  };
  let result = await attempt(1);
  if (!isDone(result)) {
    result = await attempt(2);
    if (!isDone(result)) {
      try {
        opts.state.appendEvent(opts.degradeEvent, opts.degradePayload(result));
      } catch {
        /* state write failed — the console line below still lands */
      }
      (opts.log ?? console.error)(opts.degradeMessage(result));
    }
  }
  return result;
}
