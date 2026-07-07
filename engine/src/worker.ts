// worker.ts — the ONE module that touches the Claude CLI. Every `claude -p` flag, the
// stream-json cost parsing, CLAUDE_BIN discovery, the worktree, the sentinels, and the
// process-tree kill live here (PLAN.md: "Claude CLI coupling isolated in worker.ts").
//
// It implements the conductor's `Supervisor` seam (dispatch/probe/reclaim). Completion is
// signalled by SENTINEL FILES the wrapper writes — never the model's self-report (the robust
// part of 0day's loop_worker.sh, ported):
//   <name>.running.json   — written at spawn (issue + session_id + pid); resume marker
//   <name>.done.json      — clean exit (carries parsed total_cost_usd)
//   <name>.failed.json    — non-zero exit
//   <name>.handoff.json   — soft-budget graceful handoff (resumable; NOT a kill)
//   <name>.heartbeat      — mtime touched on an interval (outer liveness, not self-report)
//   <name>.jsonl          — claude stream-json output
//
// SECURITY: spawn uses an argv array + detached process group — never a shell. The coarse
// allowed/disallowedTools below are noise-reduction only; the real boundary is the
// fail-closed PreToolUse guard hook wired in via --settings (#26).
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { Issue } from "./forge.js";
import type { SapwoodConfig } from "./config.js";
import type { Supervisor, LaneProbe } from "./conductor.js";
import type { ModelUsageEntry } from "./state.js";

/** Last `total_cost_usd` across the stream-json result lines (0 if none/garbage). #60: a lane
 *  that's hard-killed (escalated past drain, or never resumed after a handoff) before ever
 *  producing a terminal "result" line has genuinely unrecoverable cost here — total_cost_usd
 *  only ever appears on that line, never mid-stream. That's a known ceiling, not a bug; making
 *  the .handoff sentinel reliable (onExit's preserveHandoffWip) is what keeps the common drain
 *  case from hitting it, since a later `claude --resume` produces a real result line normally. */
export function parseCostUsd(jsonl: string): number {
  let cost = 0;
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as { type?: string; total_cost_usd?: number };
      if (obj.type === "result" && typeof obj.total_cost_usd === "number") cost = obj.total_cost_usd;
    } catch {
      // partial/garbage line — ignore (stream may be mid-write)
    }
  }
  return cost;
}

/** Per-model token usage from the last stream-json result line (#47). Mirrors parseCostUsd's
 *  tolerance exactly: a missing result line, a malformed `usage`/`modelUsage`, or a garbage
 *  line never throws — it just yields zeros. Cost accounting (parseCostUsd) must keep working
 *  on ANY CLI version regardless of what this function finds.
 *
 *  Prefers the newer CLI's per-model `modelUsage` map. When that's absent, falls back to
 *  attributing the flat top-level `usage` block to the session's reported model id
 *  (`model` or `modelName` on the result object) — or "unknown" if neither is present. */
export function parseModelUsage(jsonl: string): ModelUsageEntry[] {
  let usage: ModelUsageEntry[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as Record<string, unknown>;
      if (obj.type === "result") usage = extractModelUsage(obj);
    } catch {
      // partial/garbage line — ignore (stream may be mid-write)
    }
  }
  return usage;
}

function extractModelUsage(obj: Record<string, unknown>): ModelUsageEntry[] {
  const modelUsage = obj.modelUsage;
  if (modelUsage && typeof modelUsage === "object" && !Array.isArray(modelUsage)) {
    const entries = Object.entries(modelUsage as Record<string, unknown>)
      .filter(([model]) => typeof model === "string" && model.length > 0)
      .map(([model, u]) => ({ model, ...toCategorized(u) }));
    if (entries.length > 0) return entries;
  }
  // Fallback: no (usable) modelUsage map — attribute the flat top-level usage to the
  // session's main model id, or "unknown" if the result line carries no model identifier.
  const model =
    (typeof obj.model === "string" && obj.model) ||
    (typeof obj.modelName === "string" && obj.modelName) ||
    "unknown";
  return [{ model, ...toCategorized(obj.usage) }];
}

/** Normalizes a stream-json usage block (either snake_case, e.g. top-level `usage`, or
 *  camelCase, e.g. a `modelUsage` entry) into token counts. Missing/non-numeric/negative
 *  fields become 0 — never a parse failure. */
function toCategorized(u: unknown): CategorizedTokenUsageRaw {
  const r = (u && typeof u === "object" ? u : {}) as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
  return {
    inputTokens: num(r.input_tokens ?? r.inputTokens),
    outputTokens: num(r.output_tokens ?? r.outputTokens),
    cacheCreationTokens: num(r.cache_creation_input_tokens ?? r.cacheCreationInputTokens),
    cacheReadTokens: num(r.cache_read_input_tokens ?? r.cacheReadInputTokens),
  };
}

type CategorizedTokenUsageRaw = Omit<ModelUsageEntry, "model">;

/** CLAUDE_BIN env override, else `claude` on PATH. */
export function discoverClaudeBin(env: Record<string, string | undefined>): string {
  const b = env.CLAUDE_BIN?.trim();
  return b ? b : "claude";
}

export interface ClaudeArgsOpts {
  prompt: string;
  model: string;
  effort: string;
  worktree: string;
  name: string;
  sessionId: string;
  addDir?: string;
  settings?: string; // --settings value: inline JSON string (or path); omitted -> no --settings (#26)
  /** #46: resume a prior session (`--resume <id>`) instead of starting a fresh one
   *  (`--session-id <id>`) — the handoff-resume path. Omitted -> the normal fresh-dispatch
   *  `--session-id` flag, unchanged. `--resume` reuses the SAME session (no --fork-session),
   *  so `sessionId` above should equal this value when both are set. */
  resumeSessionId?: string;
}

/** The full `claude -p` argv. Pure, so every flag is testable without spawning. NOTE: no
 *  --max-budget-usd — the per-worker budget is SOFT (monitored + graceful handoff), never a
 *  hard mid-step kill (PLAN.md). The hard ceiling is the conductor's, not the CLI's. */
export function claudeArgs(o: ClaudeArgsOpts): string[] {
  return [
    "-p", o.prompt,
    "--model", o.model,
    "--effort", o.effort,
    "--fallback-model", "sonnet",
    "--worktree", o.worktree,
    "--name", o.name,
    ...(o.resumeSessionId ? ["--resume", o.resumeSessionId] : ["--session-id", o.sessionId]),
    "--permission-mode", "auto",
    // Coarse noise-reduction only — the real boundary is the guard hook (#26).
    "--allowedTools", "Read,Edit,Write,Bash(git *),Bash(gh *),Bash(npm *),Bash(node *),Bash(npx *)",
    "--disallowedTools", "Bash(gh pr merge*),Bash(gh pr ready*)",
    ...(o.addDir ? ["--add-dir", o.addDir] : []),
    ...(o.settings ? ["--settings", o.settings] : []),
    "--output-format", "stream-json", "--include-hook-events", "--verbose",
  ];
}

const SENTINEL_EXTS = ["running.json", "done.json", "failed.json", "handoff.json", "heartbeat", "jsonl"];

/** Per-worker Claude Code settings wiring the fail-closed PreToolUse guard hook (#26). The
 *  command runs `node <hookPath>` (hookPath is trusted — our own dist path — and quoted); the
 *  matcher covers exactly the tools the guard inspects.
 *
 *  FAIL-CLOSED even if `node` can't run the hook (stale dist whose guard-hook.js imports a
 *  missing guard.js, a module-load/syntax error, missing node/PATH): Claude Code treats a
 *  non-zero *non-2* PreToolUse exit as NON-blocking, so the tool would proceed unguarded — a
 *  fail-OPEN in the only live safety boundary (Codex #26 P1). So a hook launch/runtime failure
 *  is mapped to exit 2 (BLOCKING) in hard mode. Soft mode is observe-only, so a crash there
 *  allows (exit 0). Mode is read from the SAPWOOD_GUARD_MODE spawn env. */
export function guardSettings(hookPath: string): object {
  // The command is shell-evaluated, so single-quote the path: double quotes still expand $,
  // backticks, and $() — an install path containing those would break or inject (Codex #26 R2).
  // Single quotes suppress all expansion; embedded single quotes are escaped '\'' .
  const hook = shellSingleQuote(hookPath);
  const command =
    `node ${hook} || { [ "$SAPWOOD_GUARD_MODE" = soft ] && exit 0 || ` +
    `{ echo '[sapwood-guard] hook failed to run — blocking (fail-closed)' >&2; exit 2; }; }`;
  return {
    // Force hooks ON for the worker session: a user/local settings layer with
    // "disableAllHooks": true would otherwise survive (omitted --settings keys keep file
    // values), leaving the guard inert — a fail-OPEN even with the hook file present (Codex
    // #26 R3 P1). Explicitly re-enabling here overrides that layer.
    disableAllHooks: false,
    hooks: {
      PreToolUse: [{ matcher: "Bash|Write|Edit|MultiEdit", hooks: [{ type: "command", command }] }],
    },
  };
}

export interface WorkerDeps {
  cfg: SapwoodConfig;
  /** Directory for sentinels/jsonl/heartbeat. Default <cwd>/data/sessions/state. */
  stateDir?: string;
  /** Parent directory holding each lane's git worktree, keyed by lane name
   *  (`<worktreeRoot>/<name>`). This is the SAME convention the `claude` CLI's `--worktree
   *  <name>` flag resolves against (confirmed against this repo's own `.claude/worktrees/*`
   *  on disk): the engine spawns `claude` with `cwd` inherited from the engine process, so
   *  the CLI resolves `--worktree <name>` relative to that same cwd. Default
   *  <cwd>/.claude/worktrees, mirroring stateDir's cwd-anchored default. */
  worktreeRoot?: string;
  /** claude binary; default discoverClaudeBin(process.env). */
  claudeBin?: string;
  /** probe()'s hasPr — engine wires this to the forge (an open PR for the issue). */
  hasOpenPr: (issue: number) => Promise<boolean>;
  /** probe()'s prNumber (#13 merge driver needs the actual PR number, not just "has one").
   *  Optional and additive: when provided it also derives hasPr (a number means yes); when
   *  omitted, probe() falls back to the legacy hasOpenPr-only boolean path (prNumber stays
   *  undefined — a driving lane rescued that way can't be gated/merged until a number is
   *  known, conductor.ts fails that lane safe rather than guessing). */
  findOpenPr?: (issue: number) => Promise<number | null>;
  /** Worker prompt for an issue. Default: a minimal imperative skeleton. */
  renderPrompt?: (issue: Issue) => string;
  /** Path to the compiled guard hook (node <path>). Default: the dist sibling of this module. */
  guardHookPath?: string;
  heartbeatMs?: number; // default 30_000
  now?: () => Date;
}

interface Lane {
  child: ChildProcess;
  issue: number;
  sessionId: string;
  jsonlFd: number;
  jsonlPath: string;
  hb: NodeJS.Timeout | undefined; // set once the spawn is confirmed still-running
  handoffRequested: boolean;
  reclaiming: boolean;
  startedMs: number; // wall-clock start, for the timeoutSec ceiling
  timedOut: boolean;
}

export class WorkerSupervisor implements Supervisor {
  private readonly dir: string;
  private readonly worktreeRoot: string;
  private readonly bin: string;
  private readonly hbMs: number;
  private readonly guardHookPath: string;
  private readonly lanes = new Map<string, Lane>();
  // Detached lanes (persisted running.json, no in-memory handle — engine restarted while the
  // worker kept running) already asked to hand off. Keeps requestHandoff idempotent-per-tick
  // for lanes we can only reach by persisted pid (Codex PR #41 P1).
  private readonly detachedHandoffRequested = new Set<string>();
  // #60 P1 (Codex review): a nonexistent, per-process-random directory used to override
  // core.hooksPath (see tryGit, which also disables core.fsmonitor alongside it) on every git
  // call preserveHandoffWip makes. A handoff-requested lane's worktree is under the FULL
  // filesystem control of the (possibly compromised) worker while it was alive — outside the
  // PreToolUse guard's reach once it's dead — so it could have planted a pre-commit/pre-push
  // hook, an fsmonitor script, or pointed core.hooksPath at a directory it controls. A
  // command-line `-c core.hooksPath=...` always wins over any config value (local worktree
  // config included), so this can't be overridden by anything the worker set. The directory
  // deliberately never exists: git treats a missing hooksPath as "no hooks to run", no error.
  private readonly noHooksDir = join(tmpdir(), `sapwood-no-hooks-${randomUUID()}`);

  constructor(private readonly deps: WorkerDeps) {
    this.dir = deps.stateDir ?? join(process.cwd(), "data", "sessions", "state");
    this.worktreeRoot = deps.worktreeRoot ?? join(process.cwd(), ".claude", "worktrees");
    this.bin = deps.claudeBin ?? discoverClaudeBin(process.env);
    this.hbMs = deps.heartbeatMs ?? 30_000;
    // Default to the compiled hook sibling (dist/guard-hook.js when running compiled). The
    // "build-dist" step (#26) is the existing `npm run build`; dispatch fails closed below if
    // the file is absent in hard mode rather than running an unguarded worker.
    this.guardHookPath = deps.guardHookPath ?? fileURLToPath(new URL("./guard-hook.js", import.meta.url));
    mkdirSync(this.dir, { recursive: true });
  }

  private path(name: string, ext: string): string {
    return join(this.dir, `${name}.${ext}`);
  }
  private now(): Date {
    return this.deps.now ? this.deps.now() : new Date();
  }

  async dispatch(issue: Issue, name?: string): Promise<{ name: string; sessionId: string }> {
    const laneName = name ?? `lane-${issue.number}-${randomUUID().slice(0, 8)}`;
    // Refuse name reuse — a stale sentinel under this name means a concurrent/old lane; a
    // second worker would clobber its jsonl/sentinels (0day Codex #4).
    for (const ext of SENTINEL_EXTS) {
      if (existsSync(this.path(laneName, ext))) {
        throw new Error(`worker name in use (${laneName}.${ext} exists) — reassign a fresh name`);
      }
    }
    // FAIL-CLOSED: never dispatch an unguarded worker in hard mode. If the compiled guard hook
    // is missing (engine not built), refuse rather than run claude with no live PreToolUse
    // guard — a missing hook file would otherwise be a silent fail-OPEN (#26).
    const guardMode = this.deps.cfg.guard.mode;
    if (guardMode === "hard" && !existsSync(this.guardHookPath)) {
      throw new Error(
        `guard hook not found at ${this.guardHookPath} — build the engine (npm run build) before ` +
          `dispatching; refusing to run an unguarded worker in hard mode`,
      );
    }
    const sessionId = randomUUID();
    const prompt = (this.deps.renderPrompt ?? defaultPrompt)(issue);
    const jsonlPath = this.path(laneName, "jsonl");
    const jsonlFd = openSync(jsonlPath, "w");
    // Guard wiring is passed as INLINE --settings JSON (not a file): a settings *file* under
    // stateDir would be worker-writable via Bash to its absolute path, and Claude reloads hook
    // edits live — a worker could set disableAllHooks:true on its own settings mid-session and
    // disable the guard (Codex #26 R4 P1). An argv JSON string has no file to mutate. Scoped to
    // THIS claude -p only (not a plugin-global hook that would hit the human).
    const settingsJson = JSON.stringify(guardSettings(this.guardHookPath));
    // NB: NO --add-dir for the engine `data/` tree — mounting it would let the worker write its
    // own .done/.failed or mutate state, defeating wrapper-signaled completion (Codex R3 P1).
    const args = claudeArgs({
      prompt, model: this.deps.cfg.worker.model, effort: this.deps.cfg.worker.effort,
      worktree: laneName, name: laneName, sessionId, settings: settingsJson,
    });
    // detached: child is its own process-group leader -> reclaim can SIGKILL the whole tree.
    // SAPWOOD_GUARD_MODE in the spawn env reaches the hook subprocess (inherited from claude)
    // but is NOT worker-writable, so a worker can't flip its own guard hard->soft (#26).
    const child = spawn(this.bin, args, {
      detached: true,
      stdio: ["ignore", jsonlFd, jsonlFd],
      env: { ...process.env, SAPWOOD_GUARD_MODE: guardMode },
    });
    // Register the lane + `exit` handler BEFORE any await. Node does not replay `exit` to
    // listeners attached after it fires, so a fast exit (instant completion / the CLI
    // rejecting args) must already have its handler or its terminal sentinel is lost and the
    // conductor mis-reads the lane as DEAD (Codex PR #32 R2 P2).
    const lane: Lane = {
      child, issue: issue.number, sessionId, jsonlFd, jsonlPath,
      hb: undefined, handoffRequested: false, reclaiming: false,
      startedMs: this.now().getTime(), timedOut: false,
    };
    this.lanes.set(laneName, lane);
    child.on("exit", (code) => this.onExit(laneName, code));

    // spawn() reports a bad CLAUDE_BIN / missing `claude` via an async `error` event, not a
    // throw — AWAIT the spawn outcome before reporting success. On failure clean up + reject
    // so the conductor's claim-rollback runs and no bogus running marker is left (Codex R1 P2).
    let spawnErr: unknown;
    await new Promise<void>((resolve) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => { spawnErr = e; resolve(); });
    });
    if (spawnErr) {
      this.lanes.delete(laneName);
      try { closeSync(jsonlFd); } catch { /* noop */ }
      this.removeIfExists(jsonlPath);
      throw new Error(`worker spawn failed (${this.bin}): ${String(spawnErr)}`);
    }
    // Post-spawn error (rare) must not crash the host — route to a failed exit.
    child.on("error", () => this.onExit(laneName, 1));
    // Only set up the running marker + heartbeat if the child is still alive — a very fast
    // exit during the await is already handled by onExit (lane removed); don't resurrect it.
    if (this.lanes.has(laneName) && child.exitCode === null && child.signalCode === null) {
      this.writeJsonAtomic(this.path(laneName, "running.json"), {
        name: laneName, issue: issue.number, session_id: sessionId,
        wrapper_pid: child.pid, started_at: new Date(lane.startedMs).toISOString(),
      });
      this.touchHeartbeat(laneName);
      lane.hb = setInterval(() => this.heartbeatTick(laneName), this.hbMs);
    }
    return { name: laneName, sessionId };
  }

  /**
   * #46: resume a lane the wrapper handed off (`.handoff` sentinel) via `claude --resume`,
   * reusing the ORIGINAL session id (no --fork-session) so claude continues the same
   * conversation — the "M4 --resume" PLAN.md/#41 flagged. Fail-closed: throws if `name` has no
   * `.handoff` sentinel (nothing resumable — never resume a lane that's still running, already
   * terminal done/failed, or was never confirmed handed off) or the sentinel carries no
   * session_id. The jsonl is APPENDED, not truncated: the pre-handoff stream stays as an audit
   * trail, and parseCostUsd/parseModelUsage already take the LAST "result" line, so a resumed
   * run's terminal line — expected to be the whole session's cumulative total (State.recordSpend
   * handles the double-count risk that assumption carries) — is picked up exactly the same way
   * a fresh single-run jsonl would be.
   *
   * Note: nothing in this engine calls resume() automatically yet. Deciding WHEN a handed-off
   * lane should be resumed (an auto-resume scheduling policy in the conductor/driver) is a
   * separate, not-yet-scoped question — this method is the callable mechanism a future
   * scheduler (or an operator) invokes; #46 only asked for the mechanism + the cost-delta
   * protection it depends on, not the scheduling policy.
   */
  async resume(issue: Issue, name: string): Promise<{ name: string; sessionId: string }> {
    const handoffPath = this.path(name, "handoff.json");
    if (!existsSync(handoffPath)) {
      throw new Error(`resume: ${name} has no .handoff sentinel — nothing to resume`);
    }
    const handoff = this.readJson(handoffPath);
    const sessionId = typeof handoff?.session_id === "string" ? handoff.session_id : null;
    if (!sessionId) {
      throw new Error(`resume: ${name}'s handoff sentinel carries no session_id`);
    }
    const guardMode = this.deps.cfg.guard.mode;
    if (guardMode === "hard" && !existsSync(this.guardHookPath)) {
      throw new Error(
        `guard hook not found at ${this.guardHookPath} — build the engine (npm run build) before ` +
          `resuming; refusing to resume an unguarded worker in hard mode`,
      );
    }
    const prompt = (this.deps.renderPrompt ?? defaultPrompt)(issue);
    const jsonlPath = this.path(name, "jsonl");
    const jsonlFd = openSync(jsonlPath, "a"); // append: preserve the pre-handoff stream
    const settingsJson = JSON.stringify(guardSettings(this.guardHookPath));
    const args = claudeArgs({
      prompt, model: this.deps.cfg.worker.model, effort: this.deps.cfg.worker.effort,
      worktree: name, name, sessionId, resumeSessionId: sessionId, settings: settingsJson,
    });
    const child = spawn(this.bin, args, {
      detached: true,
      stdio: ["ignore", jsonlFd, jsonlFd],
      env: { ...process.env, SAPWOOD_GUARD_MODE: guardMode },
    });
    const lane: Lane = {
      child, issue: issue.number, sessionId, jsonlFd, jsonlPath,
      hb: undefined, handoffRequested: false, reclaiming: false,
      startedMs: this.now().getTime(), timedOut: false,
    };
    this.lanes.set(name, lane);
    child.on("exit", (code) => this.onExit(name, code));

    let spawnErr: unknown;
    await new Promise<void>((resolve) => {
      child.once("spawn", () => resolve());
      child.once("error", (e) => { spawnErr = e; resolve(); });
    });
    if (spawnErr) {
      this.lanes.delete(name);
      try { closeSync(jsonlFd); } catch { /* noop */ }
      throw new Error(`worker resume-spawn failed (${this.bin}): ${String(spawnErr)}`);
    }
    child.on("error", () => this.onExit(name, 1));
    // Clear the handoff sentinel now that the lane is live again — a probe() racing this
    // resume must not still read the lane as terminally handed-off.
    this.removeIfExists(handoffPath);
    if (this.lanes.has(name) && child.exitCode === null && child.signalCode === null) {
      this.writeJsonAtomic(this.path(name, "running.json"), {
        name, issue: issue.number, session_id: sessionId,
        wrapper_pid: child.pid, started_at: new Date(lane.startedMs).toISOString(),
      });
      this.touchHeartbeat(name);
      lane.hb = setInterval(() => this.heartbeatTick(name), this.hbMs);
    }
    return { name, sessionId };
  }

  /** Operator/drain-initiated graceful handoff: SIGTERM (not SIGKILL) so the worker wraps up
   *  the current step; onExit then writes the resumable .handoff sentinel. This is the live
   *  handoff path for M2 (the drain half of the kill-switch, PLAN.md). AUTO cost-triggered
   *  handoff is deferred — it needs a live cost signal, which stream-json does not carry
   *  (total_cost_usd is only in the terminal result message). See the follow-up issue. */
  requestHandoff(name: string): boolean {
    const lane = this.lanes.get(name);
    if (lane) {
      if (lane.reclaiming || lane.handoffRequested) return false;
      lane.handoffRequested = true;
      this.killGroup(lane.child, "SIGTERM");
      return true;
    }
    // Cross-process / post-restart: a persisted `running` lane with no in-memory handle (the
    // engine restarted while the worker kept running). Without this fallback the #14 ceiling
    // drain would silently no-op on such lanes — no SIGTERM for the whole drain window, the
    // worker keeps spending, then gets hard-killed instead of the intended graceful handoff
    // (Codex PR #41 P1). Signal the persisted process group with SIGTERM only (graceful —
    // never the KILL escalation reclaim() adds). Caveat: with no attached onExit handler
    // neither the .handoff sentinel NOR the supervisor-side commit+push (preserveHandoffWip,
    // #60) can run for this detached path — only the in-process onExit (the lane-in-map
    // branch above) gets that guarantee. A detached lane's WIP preservation still depends on
    // whatever the model itself managed before dying; this remains a known gap, not fixed here.
    if (this.detachedHandoffRequested.has(name)) return false;
    const pid = this.persistedPid(name);
    if (pid == null || this.wrapperAlive(name) !== 1) return false;
    this.detachedHandoffRequested.add(name);
    this.signalGroup(pid, "SIGTERM");
    return true;
  }

  /** Outer liveness heartbeat (mtime), independent of the model self-reporting, plus the
   *  wall-clock timeout ceiling. NOTE: this deliberately does NOT monitor cost — stream-json
   *  carries no in-progress total_cost_usd (only the terminal result message has it), so a
   *  per-tick cost check would read 0 the whole run. Auto cost-triggered handoff is a
   *  follow-up (#33); requestHandoff() is the live (drain) path for M2. */
  private heartbeatTick(name: string): void {
    const lane = this.lanes.get(name);
    if (!lane || lane.reclaiming) return;
    // Wall-clock timeout: a hung/overlong claude must not hold a lane forever (without this,
    // a fresh heartbeat + live pid make classifyLane return KEEP indefinitely — Codex R2 P1;
    // 0day wrapped claude in run_timeout). Past timeoutSec: stop refreshing AND kill the tree
    // -> onExit writes .failed -> the conductor reclaims the lane.
    const elapsedSec = (this.now().getTime() - lane.startedMs) / 1000;
    if (!lane.timedOut && elapsedSec > this.deps.cfg.worker.timeoutSec) {
      lane.timedOut = true;
      if (lane.hb) clearInterval(lane.hb);
      void this.killTree(lane.child);
      return;
    }
    this.touchHeartbeat(name);
  }

  private onExit(name: string, code: number | null): void {
    const lane = this.lanes.get(name);
    if (!lane) return;
    clearInterval(lane.hb);
    try { closeSync(lane.jsonlFd); } catch { /* already closed */ }
    // reclaim() owns the lane's terminal state — don't also write a sentinel.
    if (!lane.reclaiming) {
      // #60: the real `claude` CLI has no SIGTERM trap — a handoff-requested process dies by
      // signal (code null) or a non-zero exit, NEVER code 0. So "code === 0 after SIGTERM" is
      // unreachable in practice, and .handoff could never be earned by the old logic (Codex
      // R3 P2's original concern was false-positive resumability; empirically the failure
      // mode is the opposite — a real, already-resumable lane getting tagged .failed). The
      // supervisor now GUARANTEES "resumable" itself: it commits+pushes the worktree's WIP
      // here, independent of the child's exit status, before deciding the tag.
      if (lane.handoffRequested && !lane.timedOut) {
        this.preserveHandoffWip(name);
      }
      const jsonl = this.readJsonl(lane.jsonlPath);
      const cost = parseCostUsd(jsonl);
      const modelUsage = parseModelUsage(jsonl);
      const endedAt = this.now().toISOString();
      const base = {
        name, issue: lane.issue, session_id: lane.sessionId, total_cost_usd: cost,
        model_usage: modelUsage, ended_at: endedAt,
      };
      // .handoff means "resumable, work preserved" — the supervisor-side commit+push above
      // (preserveHandoffWip) is what guarantees that now, not the child's exit code. A
      // handoff-requested lane is .handoff regardless of how it died. timedOut is always
      // .failed — a wall-clock timeout is a distinct, non-drain-requested hard kill.
      const tag = lane.timedOut
        ? "failed"
        : lane.handoffRequested
          ? "handoff"
          : code === 0
            ? "done"
            : "failed";
      this.writeJsonAtomic(this.path(name, `${tag}.json`), { ...base, exit_code: code });
      this.removeIfExists(this.path(name, "running.json"));
    }
    this.lanes.delete(name);
  }

  /** #60: the supervisor-side half of the drain contract — GUARANTEE "WIP preserved" for a
   *  handoff-requested lane, independent of whether the killed `claude` process happened to
   *  commit/push anything itself. Best-effort and NEVER throws: onExit must still write a
   *  terminal sentinel even if every git call here fails. Runs synchronously (execFileSync)
   *  because onExit itself is synchronous (a Node `exit` event handler).
   *
   *  - No worktree on disk (lane never got far enough to check one out) -> nothing to do.
   *  - Clean worktree (nothing to commit) -> nothing to do; no empty commit is created.
   *  - Uncommitted changes -> `git add -A && git commit` in the worktree ONLY (never the repo
   *    root — sapwood.config.yaml may carry an uncommitted local override there).
   *  - `git push` failure is non-fatal/best-effort: the LOCAL commit alone already makes the
   *    lane resumable via `claude --resume` (worker.ts's resume(), ~line 325), even if the
   *    remote push didn't land. Logged, never thrown.
   *  - A stale `index.lock` (left behind by the just-killed process; onExit only runs after
   *    the child has actually exited, so its owner is confirmed dead) is cleared and the
   *    failing command retried once.
   *  - Every git call disables hooks + fsmonitor (see `noHooksDir`) and `commit`/`push` also
   *    pass `--no-verify` as defense in depth — this worktree was under the worker's full
   *    control and must not get to run code as the supervisor via a planted hook, fsmonitor
   *    script, or credential/ssh override (Codex #60 P1 + follow-up second-opinion review).
   *  - Every git call is timeout-bounded (see tryGit) — this all runs synchronously inside
   *    onExit, a Node `exit` handler, so a hung git process (e.g. a network-partitioned push
   *    during the kill-switch drain, of all times) must not block the whole engine forever. */
  private preserveHandoffWip(name: string): void {
    const worktreePath = join(this.worktreeRoot, name);
    if (!existsSync(worktreePath)) return; // never checked out (or already cleaned up) — nothing to preserve

    const status = this.runGit(["status", "--porcelain"], worktreePath);
    if (!status.ok) return; // can't even inspect status — best-effort, give up quietly
    if (status.stdout.trim().length === 0) return; // clean — nothing to commit

    // ponytail: `git add -A` can still execute a worker-committed .gitattributes'
    // filter.<name>.clean program (content filters have no blanket `-c` disable, unlike hooks
    // — confirmed, no equivalent override exists). Closing this needs plumbing (hash-object
    // --no-filters + manual tree/commit-tree) instead of porcelain add/commit — deliberately
    // NOT done here; tracked in #65. Known, documented gap, not an oversight.
    if (!this.runGit(["add", "-A"], worktreePath).ok) return;
    if (!this.runGit(["commit", "--no-verify", "-m", "sapwood: WIP handoff (drain)"], worktreePath).ok) return;

    // push is the one step that talks to credential/transport config, so it gets two more
    // overrides on top of the hooks/fsmonitor ones every call gets: a worker-set
    // credential.helper could run arbitrary code to "provide" credentials, and core.sshCommand
    // could point at a worker-controlled binary. Disabling a legitimate one just means the push
    // fails — already handled as non-fatal below (local commit + .handoff still stand).
    const push = this.runGit(["push", "--no-verify"], worktreePath, ["credential.helper=", "core.sshCommand=ssh"]);
    if (!push.ok) {
      console.error(
        `[sapwood:worker] lane ${name}: handoff commit landed locally but 'git push' failed ` +
          `(non-fatal — resumable via claude --resume regardless): ${push.stderr.trim()}`,
      );
    }
  }

  /** Runs `git <args>` in `cwd`, retrying ONCE if the failure looks like a stale index.lock
   *  from the process onExit just confirmed dead (the owning claude subprocess has already
   *  exited by the time onExit fires — a lock file at this point can only be stale). Never
   *  throws: failures are reported via the returned `ok` flag. `extraConfig` entries are
   *  additional `-c key=value` overrides layered on top of the always-on ones (see tryGit) —
   *  used by the push step for credential/transport-specific overrides. */
  private runGit(args: string[], cwd: string, extraConfig: string[] = []): { ok: boolean; stdout: string; stderr: string } {
    const first = this.tryGit(args, cwd, extraConfig);
    if (first.ok || !/index\.lock/i.test(first.stderr)) return first;
    const gitDir = this.tryGit(["rev-parse", "--absolute-git-dir"], cwd);
    if (!gitDir.ok) return first;
    const lockPath = join(gitDir.stdout.trim(), "index.lock");
    if (!existsSync(lockPath)) return first;
    this.removeIfExists(lockPath);
    return this.tryGit(args, cwd, extraConfig);
  }

  /** Every git invocation from preserveHandoffWip goes through here. Two things are unconditional
   *  on every call, never skippable per-call: the `-c core.hooksPath=...` / `-c
   *  core.fsmonitor=false` overrides (worker-controlled config that could otherwise run code
   *  with the supervisor's privileges — Codex #60 P1 + follow-up review; harmless on commands
   *  with nothing to filter, e.g. status/rev-parse), and a bounded timeout — this runs
   *  synchronously inside onExit, a Node `exit` handler, so a hung git process (a
   *  network-partitioned push, most plausibly, mid kill-switch-drain) must not hang the whole
   *  engine. On timeout the process is SIGKILLed and this reports it as an ordinary failure
   *  (`ok: false`), same as any other git error — callers already treat that as non-fatal. */
  private tryGit(args: string[], cwd: string, extraConfig: string[] = []): { ok: boolean; stdout: string; stderr: string } {
    const fullArgs = [
      "-c", `core.hooksPath=${this.noHooksDir}`,
      "-c", "core.fsmonitor=false",
      ...extraConfig.flatMap((c) => ["-c", c]),
      ...args,
    ];
    try {
      const stdout = execFileSync("git", fullArgs, {
        cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000, killSignal: "SIGKILL",
      });
      return { ok: true, stdout, stderr: "" };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      return { ok: false, stdout: err.stdout ?? "", stderr: err.stderr ?? String(e) };
    }
  }

  async probe(name: string): Promise<LaneProbe> {
    const done = existsSync(this.path(name, "done.json"));
    const failed = existsSync(this.path(name, "failed.json"));
    const handoff = existsSync(this.path(name, "handoff.json"));
    const hbAge = this.heartbeatAge(name);
    const wrapperAlive = this.wrapperAlive(name);
    const issue = this.laneIssue(name);
    let hasPr = false;
    let prNumber: number | undefined;
    if (issue != null) {
      if (this.deps.findOpenPr) {
        const n = await this.deps.findOpenPr(issue);
        hasPr = n != null;
        if (n != null) prNumber = n;
      } else {
        hasPr = await this.deps.hasOpenPr(issue);
      }
    }
    const costUsd = this.terminalCostUsd({ done, failed, handoff }, name);
    const modelUsage = this.terminalModelUsage({ done, failed, handoff }, name);
    return {
      done, failed, handoff, hbAge, wrapperAlive, hasPr, costUsd, modelUsage,
      ...(prNumber != null ? { prNumber } : {}),
    };
  }

  /** The terminal sentinel (whichever is present) carries the parsed stream-json
   *  total_cost_usd (onExit writes it into all three: done/failed/handoff). Feeds the
   *  conductor's #14 engine-ceiling ledger (state.recordSpend).
   *
   *  No sentinel (or a sentinel without a cost) does NOT mean no cost: a lane orphaned by an
   *  engine restart has no attached onExit handler, so it never gets a sentinel — but claude
   *  still wrote its terminal result line to <name>.jsonl. Returning 0 there would let a
   *  restart mid-run omit real spend from spend_ledger and quietly under-count the daily
   *  hard cap (Codex PR #41 R3 P1). Fall back to parsing the jsonl: for a still-running
   *  lane it parses to 0 anyway (total_cost_usd only appears in the terminal result
   *  message), so the fallback is safe unconditionally. */
  private terminalCostUsd(flags: { done: boolean; failed: boolean; handoff: boolean }, name: string): number {
    const ext = flags.done ? "done.json" : flags.failed ? "failed.json" : flags.handoff ? "handoff.json" : null;
    if (ext) {
      const r = this.readJson(this.path(name, ext));
      if (typeof r?.total_cost_usd === "number") return r.total_cost_usd;
    }
    return parseCostUsd(this.readJsonl(this.path(name, "jsonl")));
  }

  /** #47: same terminal-sentinel-first, jsonl-fallback shape as terminalCostUsd (see its
   *  comment for why the fallback is needed — an engine-restart orphan never gets a sentinel). */
  private terminalModelUsage(flags: { done: boolean; failed: boolean; handoff: boolean }, name: string): ModelUsageEntry[] {
    const ext = flags.done ? "done.json" : flags.failed ? "failed.json" : flags.handoff ? "handoff.json" : null;
    if (ext) {
      const r = this.readJson(this.path(name, ext));
      if (Array.isArray(r?.model_usage)) return r.model_usage as ModelUsageEntry[];
    }
    return parseModelUsage(this.readJsonl(this.path(name, "jsonl")));
  }

  async reclaim(name: string): Promise<void> {
    const lane = this.lanes.get(name);
    if (lane) {
      lane.reclaiming = true;
      clearInterval(lane.hb);
      await this.killTree(lane.child);
    } else {
      // Cross-process / post-restart: no in-memory handle — kill by the persisted pid.
      const pid = this.persistedPid(name);
      if (pid != null) await this.killByPid(pid);
    }
  }

  /** Clear timers/fds so a host process can exit cleanly (tests). Does not kill children. */
  dispose(): void {
    for (const lane of this.lanes.values()) {
      clearInterval(lane.hb);
      try { closeSync(lane.jsonlFd); } catch { /* noop */ }
    }
    this.lanes.clear();
  }

  // ── helpers ──────────────────────────────────────────────────────────────
  private async killTree(child: ChildProcess): Promise<void> {
    this.killGroup(child, "SIGTERM");
    await sleep(200); // brief grace, then hard-kill the whole group
    this.killGroup(child, "SIGKILL");
  }
  private async killByPid(pid: number): Promise<void> {
    this.signalGroup(pid, "SIGTERM");
    await sleep(200);
    this.signalGroup(pid, "SIGKILL");
  }
  private killGroup(child: ChildProcess, sig: NodeJS.Signals): void {
    if (child.pid != null) this.signalGroup(child.pid, sig);
  }
  private signalGroup(pid: number, sig: NodeJS.Signals): void {
    try {
      process.kill(-pid, sig); // negative pid -> the whole process group (detached leader)
    } catch {
      try { process.kill(pid, sig); } catch { /* already gone */ }
    }
  }

  private touchHeartbeat(name: string): void {
    const p = this.path(name, "heartbeat");
    if (existsSync(p)) {
      const t = new Date();
      utimesSync(p, t, t);
    } else {
      writeFileSync(p, "");
    }
  }
  private heartbeatAge(name: string): number {
    const p = this.path(name, "heartbeat");
    if (!existsSync(p)) return -1;
    return Math.floor((this.now().getTime() - statSync(p).mtimeMs) / 1000);
  }
  private wrapperAlive(name: string): -1 | 0 | 1 {
    const pid = this.persistedPid(name);
    if (pid == null) return -1; // unknown (no running marker)
    try { process.kill(pid, 0); return 1; } catch { return 0; }
  }
  private persistedPid(name: string): number | null {
    const r = this.readJson(this.path(name, "running.json"));
    return typeof r?.wrapper_pid === "number" ? r.wrapper_pid : null;
  }
  private laneIssue(name: string): number | null {
    for (const ext of ["running.json", "done.json", "failed.json", "handoff.json"]) {
      const r = this.readJson(this.path(name, ext));
      if (typeof r?.issue === "number") return r.issue;
    }
    return null;
  }

  private readJsonl(p: string): string {
    try { return readFileSync(p, "utf8"); } catch { return ""; }
  }
  private readJson(p: string): Record<string, unknown> | null {
    try { return JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>; } catch { return null; }
  }
  private writeJsonAtomic(p: string, obj: unknown): void {
    const tmp = `${p}.tmp.${process.pid}`;
    writeFileSync(tmp, JSON.stringify(obj) + "\n");
    renameSync(tmp, p);
  }
  private removeIfExists(p: string): void {
    try { rmSync(p, { force: true }); } catch { /* noop */ }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** POSIX single-quote escaping: wrap in '...' and replace each ' with '\'' so no shell
 *  expansion ($, backticks, $()) occurs in the interpolated path. */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function defaultPrompt(issue: Issue): string {
  // Imperative — headless has no human to confirm; the worker starts immediately. The TDD /
  // two-gate method lives in the dev-round skill (M4); this is the minimal dispatch skeleton.
  return [
    `You are an autonomous worker. Implement GitHub issue #${issue.number}: ${issue.title}.`,
    `Work on a feature branch, follow the repo's tests-first method, and open a pull request when done.`,
    `Do not merge. Commit and push your work; the conductor handles review and merge.`,
  ].join("\n");
}
