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
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Issue } from "./forge.js";
import type { SapwoodConfig } from "./config.js";
import type { Supervisor, LaneProbe } from "./conductor.js";

/** Last `total_cost_usd` across the stream-json result lines (0 if none/garbage). */
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
    "--session-id", o.sessionId,
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
  private readonly bin: string;
  private readonly hbMs: number;
  private readonly guardHookPath: string;
  private readonly lanes = new Map<string, Lane>();
  // Detached lanes (persisted running.json, no in-memory handle — engine restarted while the
  // worker kept running) already asked to hand off. Keeps requestHandoff idempotent-per-tick
  // for lanes we can only reach by persisted pid (Codex PR #41 P1).
  private readonly detachedHandoffRequested = new Set<string>();

  constructor(private readonly deps: WorkerDeps) {
    this.dir = deps.stateDir ?? join(process.cwd(), "data", "sessions", "state");
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
    // never the KILL escalation reclaim() adds). Caveat: with no attached onExit handler the
    // .handoff sentinel cannot be written, so a cooperative exit is later classified DEAD;
    // the SIGTERM still lets the worker checkpoint (commit+push) before exiting, which is the
    // part that preserves work — the pushed state is itself the handoff (PLAN.md).
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
      const cost = parseCostUsd(this.readJsonl(lane.jsonlPath));
      const endedAt = this.now().toISOString();
      const base = { name, issue: lane.issue, session_id: lane.sessionId, total_cost_usd: cost, ended_at: endedAt };
      // .handoff means "resumable, work preserved" — claim it ONLY when the worker exited
      // cleanly (code 0) AFTER a handoff request, i.e. it caught SIGTERM and completed its
      // commit/checkpoint. A handoff-requested worker that died by signal/non-zero was aborted
      // mid-step -> .failed, not a false "resumable" (Codex R3 P2). timedOut is always failed.
      const tag = lane.timedOut
        ? "failed"
        : lane.handoffRequested && code === 0
          ? "handoff"
          : code === 0
            ? "done"
            : "failed";
      this.writeJsonAtomic(this.path(name, `${tag}.json`), { ...base, exit_code: code });
      this.removeIfExists(this.path(name, "running.json"));
    }
    this.lanes.delete(name);
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
    return { done, failed, handoff, hbAge, wrapperAlive, hasPr, costUsd, ...(prNumber != null ? { prNumber } : {}) };
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
