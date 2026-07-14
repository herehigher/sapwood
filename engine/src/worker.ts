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
import {
  existsSync, lstatSync, mkdirSync, openSync, closeSync, readFileSync, readdirSync, renameSync,
  rmSync, statSync, utimesSync, writeFileSync, type Dirent,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Issue } from "./forge.js";
import type { SapwoodConfig } from "./config.js";
import type { Supervisor, LaneProbe, ReclaimResult } from "./conductor.js";
import type { ModelUsageEntry, CategorizedTokenUsage } from "./state.js";
import { estimateUsd, loadPricingTable, type PricingTable } from "./pricing.js";
import { loadDoctrine } from "./doctrine.js";

/** Last `total_cost_usd` across the stream-json result lines (0 if none/garbage). #60/#69: a
 *  lane that's hard-killed (escalated past drain, or never resumed after a handoff) before ever
 *  producing a terminal "result" line has genuinely unrecoverable cost here — total_cost_usd
 *  only ever appears on that line, never mid-stream. That's a known ceiling, not a bug; the
 *  common drain case avoids it because a later `claude --resume` (reusing the untouched
 *  worktree in place) produces a real result line normally. */
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

/** #110 PR0: the READ side for a role session's structured final-message output. Extracts the
 *  `result` string from the LAST `type:"result"` line of a stream-json transcript — the same
 *  line parseCostUsd/parseModelUsage already treat as authoritative. Mirrors parseCostUsd's
 *  tolerance for the stream itself: a non-`{`-prefixed line is skipped outright, a JSON.parse
 *  failure is ignored (never thrown, mid-write tolerance), and an input with no valid result
 *  line returns "".
 *
 *  DELIBERATE divergence from parseCostUsd (Codex review round 1, P2): the last PARSEABLE
 *  result line is AUTHORITATIVE, even when its `result` field is missing/non-string — such a
 *  line RESETS the value to "" rather than letting an EARLIER line's text survive. Cost keeps
 *  the last-VALID value (a lost cost number only under-counts spend); decision text feeding a
 *  validator must never fail open by resurrecting stale text from a superseded result line.
 *  Later #110 PRs parse each role's structured decision block out of this text (per-role zod
 *  schema, sentinel-delimited raw-text bodies); this PR only adds the parse primitive — no
 *  call site uses it yet, so this change is zero behavior change. */
export function parseResultText(jsonl: string): string {
  let text = "";
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      const obj = JSON.parse(t) as { type?: string; result?: unknown };
      if (obj.type === "result") text = typeof obj.result === "string" ? obj.result : "";
    } catch {
      // partial/garbage line — ignore (stream may be mid-write)
    }
  }
  return text;
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

/** #33: the LIVE in-flight cost-estimation signal — distinct from parseModelUsage/parseCostUsd,
 *  which only ever read the terminal `result` line (absent until the whole run finishes).
 *  Claude Code's stream-json carries a `message.usage` block on every streamed `assistant`
 *  event, and that block is PER-MESSAGE (not cumulative) — so summing every assistant line's
 *  usage across the jsonl-so-far gives the running total spent up to that point. Same tolerance
 *  guarantee as parseModelUsage: a malformed/partial line (the stream may be mid-write, or the
 *  worker's Bash tool literally echoed the string "assistant" as text) is skipped, never thrown,
 *  and a line missing/misshaping `message`/`usage` yields zeros rather than aborting the scan. */
export function parseAssistantUsageDeltas(jsonl: string): ModelUsageEntry[] {
  const out: ModelUsageEntry[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue; // partial/garbage line — ignore (stream may be mid-write)
    }
    if (obj.type !== "assistant") continue;
    const message = obj.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) continue;
    const m = message as Record<string, unknown>;
    const model = typeof m.model === "string" && m.model.length > 0 ? m.model : "unknown";
    out.push({ model, ...toCategorized(m.usage) });
  }
  return out;
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
  /** #46: resume a prior session (`--resume <id>`) instead of starting a fresh one
   *  (`--session-id <id>`) — the handoff-resume path. Omitted -> the normal fresh-dispatch
   *  `--session-id` flag, unchanged. `--resume` reuses the SAME session (no --fork-session),
   *  so `sessionId` above should equal this value when both are set. */
  resumeSessionId?: string;
  /** #87: override the coarse `--allowedTools`/`--disallowedTools` noise-reduction pair below —
   *  peripheral.ts's role sessions need a narrower (issues-only) scope than a code-producing
   *  worker's. Omitted -> today's worker defaults, unchanged. Same caveat as the worker
   *  defaults: this is noise reduction only, never the real security boundary (the guard hook
   *  is — see guardSettings). */
  allowedTools?: string;
  disallowedTools?: string;
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
    "--allowedTools", o.allowedTools ?? "Read,Edit,Write,Bash(git *),Bash(gh *),Bash(npm *),Bash(node *),Bash(npx *)",
    "--disallowedTools", o.disallowedTools ?? "Bash(gh pr merge*),Bash(gh pr ready*)",
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

/** #87: an opaque handle over a spawned `claude` process — deliberately leaks NO
 *  `child_process` types to callers (`ChildProcess` never appears in this interface), so
 *  peripheral.ts (the role runner) can drive a spawned session without itself importing
 *  `node:child_process` — worker.ts stays the engine's ONE module that touches the CLI /
 *  subprocess layer (CLAUDE.md non-negotiable; pinned by the #69 grep-invariant test). */
export interface SpawnedSession {
  readonly pid: number | undefined;
  onSpawn(cb: () => void): void;
  onError(cb: (e: unknown) => void): void;
  onExit(cb: (code: number | null) => void): void;
  /** SIGTERM/SIGKILL the WHOLE detached process group (negative pid), falling back to just
   *  the leader pid if group-signalling fails — same tolerance as WorkerSupervisor's own
   *  killGroup/signalGroup. */
  killGroup(sig: NodeJS.Signals): void;
}

/** Spawn a `claude` session: argv array (no shell), detached process group (so the caller can
 *  kill the whole tree), stdio wired to the given jsonl fd. The SAME primitive
 *  WorkerSupervisor.dispatch/resume use internally (not re-implemented — this function is
 *  exported so peripheral.ts's narrower role-session shape reuses it directly rather than
 *  opening a second `child_process` import site). */
export function spawnClaudeSession(
  bin: string,
  args: string[],
  opts: { jsonlFd: number; env: NodeJS.ProcessEnv },
): SpawnedSession {
  const child = spawn(bin, args, {
    detached: true,
    stdio: ["ignore", opts.jsonlFd, opts.jsonlFd],
    env: opts.env,
  });
  const killGroup = (sig: NodeJS.Signals): void => {
    if (child.pid == null) return;
    try {
      process.kill(-child.pid, sig); // negative pid -> the whole detached process group
    } catch {
      try { process.kill(child.pid, sig); } catch { /* already gone */ }
    }
  };
  return {
    get pid() { return child.pid; },
    onSpawn: (cb) => child.once("spawn", cb),
    onError: (cb) => child.on("error", cb),
    onExit: (cb) => child.once("exit", cb),
    killGroup,
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
  estimatedCostUsd: number; // #33: live token-estimation total for THIS RUN (see pricing.ts)
  /** #33 (gate② P1): the estimated USD already in the jsonl at the moment this run started —
   *  0 on a fresh dispatch, and the pre-handoff stream's estimated total on a resume() (which
   *  APPENDS to the preserved jsonl). checkSoftBudget compares (whole-file total − this
   *  baseline) against worker.budgetUsdSoft: the soft budget bounds spend PER RUN, not per
   *  issue lifetime — without the baseline, a lane that handed off AT the budget would re-cross
   *  it on the first heartbeat tick after resume and hand off again instantly, forever (an
   *  unresumable handoff loop). The estimator-side mirror of State.recordSpend's resume
   *  cost-delta baseline. */
  estimateBaselineUsd: number;
}

export class WorkerSupervisor implements Supervisor {
  private readonly dir: string;
  private readonly worktreeRoot: string;
  private readonly bin: string;
  private readonly hbMs: number;
  private readonly guardHookPath: string;
  // #33: the soft-budget estimator's model rate table, loaded ONCE at construction (from
  // worker.pricingFile or the shipped engine/pricing.yaml — see pricing.ts), never per tick.
  // A missing/malformed configured file throws HERE, at startup, before any dispatch.
  private readonly pricing: PricingTable;
  private readonly lanes = new Map<string, Lane>();
  // Detached lanes (persisted running.json, no in-memory handle — engine restarted while the
  // worker kept running) already asked to hand off. Keeps requestHandoff idempotent-per-tick
  // for lanes we can only reach by persisted pid (Codex PR #41 P1). Also consulted by
  // probe()'s detached-confirm-death finalize (#63) — see finalizeDetachedHandoffIfConfirmedDead.
  private readonly detachedHandoffRequested = new Set<string>();
  // #63: detached lanes this supervisor has reclaim()'d (DEAD or ceiling-escalation teardown —
  // going FAILED, not resumable). Guards finalizeDetachedHandoffIfConfirmedDead: a lane torn
  // down via reclaim() must never ALSO be finalized as a resumable .handoff just because it
  // also happens to match "handoff was requested, pid now confirmed dead" — reclaim() already
  // decided its fate.
  private readonly detachedReclaiming = new Set<string>();

  constructor(private readonly deps: WorkerDeps) {
    this.dir = deps.stateDir ?? join(process.cwd(), "data", "sessions", "state");
    this.worktreeRoot = deps.worktreeRoot ?? join(process.cwd(), ".claude", "worktrees");
    this.bin = deps.claudeBin ?? discoverClaudeBin(process.env);
    this.hbMs = deps.heartbeatMs ?? 30_000;
    // Default to the compiled hook sibling (dist/guard-hook.js when running compiled). The
    // "build-dist" step (#26) is the existing `npm run build`; dispatch fails closed below if
    // the file is absent in hard mode rather than running an unguarded worker.
    this.guardHookPath = deps.guardHookPath ?? fileURLToPath(new URL("./guard-hook.js", import.meta.url));
    this.pricing = loadPricingTable(deps.cfg);
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
      startedMs: this.now().getTime(), timedOut: false, estimatedCostUsd: 0, estimateBaselineUsd: 0,
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
      const startedIso = new Date(lane.startedMs).toISOString();
      this.writeJsonAtomic(this.path(laneName, "running.json"), {
        name: laneName, issue: issue.number, session_id: sessionId,
        wrapper_pid: child.pid, started_at: startedIso,
        // #69 (fable P1): the IMMUTABLE first-dispatch time, the dirty-worktree retention
        // baseline. Distinct from started_at, which resume() resets to resume-time for the
        // wall-clock timeout — baselining retention on that would judge pre-handoff WIP (older
        // than the new start) CLEAN and delete it. dispatched_at never moves once set.
        dispatched_at: startedIso,
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
    // #69 (fable P1): carry the IMMUTABLE first-dispatch time across the handoff -> resume
    // boundary. The retention baseline must stay the original dispatch time so pre-handoff WIP
    // (older than this resumed run's start) is still judged possibly-dirty. Absent on a legacy
    // sentinel -> omitted below -> the baseline resolves to NaN -> fail-safe dirty (retain).
    const dispatchedAt = typeof handoff?.dispatched_at === "string" ? handoff.dispatched_at : null;
    const guardMode = this.deps.cfg.guard.mode;
    if (guardMode === "hard" && !existsSync(this.guardHookPath)) {
      throw new Error(
        `guard hook not found at ${this.guardHookPath} — build the engine (npm run build) before ` +
          `resuming; refusing to resume an unguarded worker in hard mode`,
      );
    }
    const prompt = (this.deps.renderPrompt ?? defaultPrompt)(issue);
    const jsonlPath = this.path(name, "jsonl");
    // #33 (gate② P1): snapshot the pre-handoff stream's estimated total ONCE, before the
    // resumed run appends anything, so checkSoftBudget can compare only THIS RUN's new spend
    // against worker.budgetUsdSoft. Without this, a lane that handed off AT the budget would
    // re-cross it on the first heartbeat tick after resume — an unresumable handoff loop.
    // The estimator-side mirror of State.recordSpend's resume cost-delta baseline.
    const estimateBaselineUsd = parseAssistantUsageDeltas(this.readJsonl(jsonlPath))
      .reduce((sum, d) => sum + estimateUsd(d, this.pricing), 0);
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
      startedMs: this.now().getTime(), timedOut: false, estimatedCostUsd: 0, estimateBaselineUsd,
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
        // Preserve the original first-dispatch baseline (not this resume's start).
        ...(dispatchedAt ? { dispatched_at: dispatchedAt } : {}),
      });
      this.touchHeartbeat(name);
      lane.hb = setInterval(() => this.heartbeatTick(name), this.hbMs);
    }
    return { name, sessionId };
  }

  /** Operator/drain-initiated graceful handoff: SIGTERM (not SIGKILL) so the worker wraps up
   *  the current step; onExit then writes the resumable .handoff sentinel. This is the live
   *  handoff path for M2 (the drain half of the kill-switch, PLAN.md) — AND (#33) the path
   *  checkSoftBudget() calls automatically when the live token-ESTIMATE crosses
   *  worker.budgetUsdSoft, since stream-json carries no in-progress REAL total_cost_usd
   *  (only the terminal result message has that). Both callers share this one method, so both
   *  get the same idempotent-per-lane guard below. */
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
    // never the KILL escalation reclaim() adds). There's no attached onExit handler for this
    // path (no live ChildProcess), so the .handoff sentinel can't be triggered by a
    // process-exit callback the way the in-process branch above gets it for free — #63
    // instead confirms death (and writes .handoff) from INSIDE probe(), the next time it's
    // called for this lane; see finalizeDetachedHandoffIfConfirmedDead.
    if (this.detachedHandoffRequested.has(name) || this.detachedReclaiming.has(name)) return false;
    const pid = this.persistedPid(name);
    if (pid == null || this.wrapperAlive(name) !== 1) return false;
    this.detachedHandoffRequested.add(name);
    // #63: persist the request onto running.json itself (not just this process's in-memory
    // set) so a SECOND engine restart — before probe() ever confirms the pid is dead — doesn't
    // forget the request. The in-memory set alone only survives one restart (it's how THIS
    // instance learned to send the SIGTERM below); a fresh instance after another restart has
    // an empty set but can still read this field back off disk.
    //
    // Ordering matters (Codex second-opinion review, PR #67 P2): this write happens BEFORE the
    // SIGTERM, not after. If the engine died in the gap between "signal sent" and "flag
    // persisted", the durable record would never land — the exact restart this field exists to
    // survive could be the one that kills the write. Persisting first closes that gap: by the
    // time the signal (and whatever it triggers) is in flight, the durable record already
    // exists, best-effort though it is.
    //
    // Still best-effort, NEVER throws: requestHandoff is documented on the Supervisor interface
    // as never throwing, and it's called unguarded from the conductor's CEILING drain loop — a
    // write failure here (ENOSPC/EACCES/EROFS/...) must not abort a kill-switch/ceiling drain
    // mid-tick, and must not block the SIGTERM that follows regardless of whether the persist
    // succeeded. The in-memory set above already covers this process's lifetime regardless; the
    // persisted field is purely an enhancement for surviving a second restart.
    try {
      const running = this.readJson(this.path(name, "running.json"));
      if (running) this.writeJsonAtomic(this.path(name, "running.json"), { ...running, handoff_requested: true });
    } catch (e) {
      console.error(`[sapwood:worker] lane ${name}: failed to persist handoff_requested (non-fatal — SIGTERM still sent): ${String(e)}`);
    }
    this.signalGroup(pid, "SIGTERM");
    return true;
  }

  /** Outer liveness heartbeat (mtime), independent of the model self-reporting, plus the
   *  wall-clock timeout ceiling and (#33) the live soft-budget check. */
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
    this.checkSoftBudget(name, lane);
  }

  /** #155: the LIVE per-probe telemetry trio — persisted (by conductor.ts, via
   *  State.setLiveTelemetry) while a lane is still `running`, cleared at reclaim. Computed
   *  fresh from the lane's jsonl-so-far on every call — the same re-parse-every-tick trade-off
   *  checkSoftBudget's own comment documents (a per-worker jsonl is small; correctness-by-
   *  re-derivation beats byte-offset bookkeeping), and no new computation path: this is the
   *  SAME #33 pricing pipeline checkSoftBudget already used, just packaged for persistence too.
   *
   *  `estCostUsd` — the priced-cost snapshot — reuses the EXACT #33 baseline-subtraction
   *  checkSoftBudget uses (never a second baseline mechanism, CTO decision on #155): the
   *  whole-jsonl priced total minus `lane.estimateBaselineUsd`, so a RESUMED lane's persisted
   *  snapshot covers only the current leg, consistent with the soft-budget accounting it shares
   *  this computation with. It settles into the real number spend_ledger holds once the lane
   *  terminates (recordSpend); this method never itself feeds accounting.
   *
   *  `contextTokens` / `tokenComposition` are read straight off the full jsonl-so-far — no
   *  baseline subtraction, because resume() APPENDS (never truncates), so they naturally cover
   *  the whole session, and neither has a comparable "per-run budget" concept to baseline
   *  against. `contextTokens` is deliberately NON-monotonic (the newest assistant message's
   *  input + cache-read + cache-creation tokens only — a drop marks an auto-compact, itself
   *  display-worthy, never smoothed into a running max). `tokenComposition` is the cumulative
   *  4-class split across every streamed assistant message so far. */
  private liveTelemetry(
    lane: Lane,
  ): { estCostUsd: number; contextTokens: number; tokenComposition: CategorizedTokenUsage } {
    const deltas = parseAssistantUsageDeltas(this.readJsonl(lane.jsonlPath));
    const wholeFileUsd = deltas.reduce((sum, d) => sum + estimateUsd(d, this.pricing), 0);
    const estCostUsd = Math.max(0, wholeFileUsd - lane.estimateBaselineUsd);
    const last = deltas[deltas.length - 1];
    const contextTokens = last ? last.inputTokens + last.cacheReadTokens + last.cacheCreationTokens : 0;
    const tokenComposition = deltas.reduce<CategorizedTokenUsage>(
      (acc, d) => ({
        inputTokens: acc.inputTokens + d.inputTokens,
        outputTokens: acc.outputTokens + d.outputTokens,
        cacheCreationTokens: acc.cacheCreationTokens + d.cacheCreationTokens,
        cacheReadTokens: acc.cacheReadTokens + d.cacheReadTokens,
      }),
      { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
    );
    return { estCostUsd, contextTokens, tokenComposition };
  }

  /** #33: soft per-worker budget auto-enforcement via LIVE token estimation. stream-json never
   *  carries an in-progress `total_cost_usd` (only the terminal `result` line has it), so this
   *  re-derives a running USD estimate from every streamed `assistant` message's token usage
   *  (parseAssistantUsageDeltas), priced by the small rate table in pricing.ts — cache reads are
   *  priced at the cache-READ rate there, not the input rate, specifically so a cache-heavy run
   *  does not look artificially expensive and hand off prematurely (the failure mode the issue
   *  flags). Crossing `worker.budgetUsdSoft` triggers the SAME graceful requestHandoff() path
   *  the operator/drain uses: SIGTERM -> `.handoff` sentinel, resumable. NEVER a hard kill,
   *  NEVER a fabricated result line (CLAUDE.md non-negotiable).
   *
   *  Re-parsing the whole jsonl-so-far every tick (rather than tracking a byte offset) is
   *  deliberate: a per-worker jsonl is small relative to a heartbeat interval's cost, and it
   *  keeps this correct-by-construction (no partial-line/byte-offset bookkeeping to get wrong)
   *  at the price of doing a bit of redundant re-parsing — the same trade-off terminalCostUsd's
   *  jsonl fallback already makes. Guarded by `handoffRequested` so a lane already draining
   *  neither re-parses nor re-fires (requestHandoff() is idempotent regardless, but skipping the
   *  parse here is pure waste avoidance once the outcome is already decided). */
  private checkSoftBudget(name: string, lane: Lane): void {
    if (lane.handoffRequested) return;
    // #155: shares its computation with liveTelemetry() (the per-probe persistence path) so the
    // soft-budget figure and the persisted priced-cost snapshot can never drift apart — see
    // liveTelemetry's comment for the PER-RUN (baseline-subtracted) rationale.
    lane.estimatedCostUsd = this.liveTelemetry(lane).estCostUsd;
    if (lane.estimatedCostUsd >= this.deps.cfg.worker.budgetUsdSoft) {
      console.error(
        `[sapwood:worker] lane ${name}: estimated spend $${lane.estimatedCostUsd.toFixed(4)} this run ` +
          `crossed the soft budget $${this.deps.cfg.worker.budgetUsdSoft} — requesting graceful handoff`,
      );
      this.requestHandoff(name);
    }
  }

  private onExit(name: string, code: number | null): void {
    const lane = this.lanes.get(name);
    if (!lane) return;
    clearInterval(lane.hb);
    try { closeSync(lane.jsonlFd); } catch { /* already closed */ }
    // reclaim() owns the lane's terminal state — don't also write a sentinel.
    if (!lane.reclaiming) {
      // #60/#69: the real `claude` CLI has no SIGTERM trap — a handoff-requested process dies
      // by signal (code null) or a non-zero exit, NEVER code 0. So "code === 0 after SIGTERM"
      // is unreachable in practice, and .handoff could never be earned by exit-code-gated logic
      // (Codex R3 P2's original concern was false-positive resumability; empirically the
      // failure mode is the opposite — a real, already-resumable lane getting tagged .failed).
      // #69 drain contract: the supervisor never touches the worktree at all — no commit, no
      // push, nothing. It's left exactly as the worker last left it. Resumability comes
      // entirely from `claude --resume <session_id>` reusing that worktree in place (see
      // resume() above); a handoff-requested lane is tagged .handoff regardless of how it
      // died or what state its worktree is in. timedOut is always .failed — a wall-clock
      // timeout is a distinct, non-drain-requested hard kill.
      const tag = lane.timedOut
        ? "failed"
        : lane.handoffRequested
          ? "handoff"
          : code === 0
            ? "done"
            : "failed";
      this.writeTerminalSentinel(name, lane.issue, lane.sessionId, lane.jsonlPath, tag, code, lane.estimatedCostUsd);
    }
    this.lanes.delete(name);
  }

  /** The ~10 lines every terminal-transition path (onExit here, and #63's detached-lane
   *  finalize below) needs: parse the jsonl for cost/model usage, write the tagged sentinel,
   *  clear the running marker. Extracted so the detached path — which has no live `Lane` (no
   *  ChildProcess, no lane.jsonlPath/issue/sessionId to read off an object) — can reuse the
   *  exact same write shape onExit's real exit callback uses, just fed its issue/sessionId
   *  from the persisted running.json instead. */
  private writeTerminalSentinel(
    name: string, issue: number, sessionId: string, jsonlPath: string,
    tag: "done" | "failed" | "handoff", exitCode: number | null,
    // #33: the live token-ESTIMATE this lane accumulated (undefined for the detached-lane path
    // below, which has no in-memory Lane to have accumulated one). Purely for the divergence log
    // below — never affects what gets written to the sentinel.
    estimatedCostUsd?: number,
  ): void {
    const jsonl = this.readJsonl(jsonlPath);
    const cost = parseCostUsd(jsonl);
    const modelUsage = parseModelUsage(jsonl);
    // #33: reconcile the live estimate against the REAL terminal total_cost_usd and log the gap
    // — this is how the pricing.ts rate table's known drift (see its module doc) is made
    // visible instead of silent, per the estimate-vs-real divergence requirement. Never fatal,
    // never gates anything — logging only. NB: the estimate is RUN-scoped (post-resume spend
    // only — see Lane.estimateBaselineUsd) while a resumed session's total_cost_usd is expected
    // to be session-CUMULATIVE, so a resumed lane's logged divergence is structurally larger;
    // that's a known semantic mismatch of the log line, not rate-table drift.
    if (estimatedCostUsd !== undefined && cost > 0) {
      const divergence = estimatedCostUsd - cost;
      console.error(
        `[sapwood:worker] lane ${name}: cost estimate $${estimatedCostUsd.toFixed(4)} vs real ` +
          `total_cost_usd $${cost.toFixed(4)} (estimate ${divergence >= 0 ? "+" : ""}${divergence.toFixed(4)})`,
      );
    }
    // #69 (fable P1): carry the immutable first-dispatch baseline out of running.json (still
    // present here — removed only at the tail below) into the terminal sentinel, so resume()
    // and the terminal-lane dirty check (inspectWorktree) can recover it after running.json
    // is gone. Omitted when absent (legacy) -> the baseline resolves to NaN -> fail-safe dirty.
    const running = this.readJson(this.path(name, "running.json"));
    const dispatchedAt = typeof running?.dispatched_at === "string" ? running.dispatched_at : null;
    const base = {
      name, issue, session_id: sessionId, total_cost_usd: cost,
      model_usage: modelUsage, ended_at: this.now().toISOString(),
      ...(dispatchedAt ? { dispatched_at: dispatchedAt } : {}),
    };
    this.writeJsonAtomic(this.path(name, `${tag}.json`), { ...base, exit_code: exitCode });
    this.removeIfExists(this.path(name, "running.json"));
  }

  /** #63: the detached-lane counterpart to onExit's in-process finalize. A detached lane
   *  (persisted running.json, no in-memory Lane — the engine restarted while the worker kept
   *  running) has no live ChildProcess to attach an `exit` handler to, so requestHandoff's
   *  detached branch can only SIGTERM the persisted pid — nothing ever wrote .handoff for it,
   *  even once the worker actually died. This is the fix: check for
   *  CONFIRMED death (wrapperAlive() === 0 — a stale heartbeat is NOT a death signal for a
   *  detached lane; its heartbeat only ever advanced via the dead engine's own setInterval)
   *  every time probe() is called, and finalize right here if so.
   *
   *  Placement matters: this runs from INSIDE probe(), ahead of the sentinel reads below and
   *  ahead of the conductor's classifyLane call that follows probe() — never a separate poll
   *  loop. The conductor probes every running lane every tick before classifying it, so a
   *  poller racing that classification could lose: it might see wrapperAlive===0 with no
   *  sentinel yet and get DEAD-reclaimed (killByPid, no .handoff written) before a separate
   *  poller fires. Running the check inside probe() wins that race by construction — the write
   *  always lands before this same call's classification-feeding flags are read.
   *
   *  A request is "known" via EITHER the in-memory detachedHandoffRequested set (this
   *  process's own request) OR running.json's persisted `handoff_requested` field (a request
   *  survives a SECOND engine restart, which wipes the in-memory set but not the file) — either
   *  is sufficient. Skipped entirely for a lane this supervisor has already reclaim()'d
   *  (detachedReclaiming) — that lane is going FAILED, not resumable; see reclaim(). Never
   *  throws: writeTerminalSentinel is already best-effort/non-throwing (same guarantee onExit
   *  relies on). */
  private finalizeDetachedHandoffIfConfirmedDead(name: string): void {
    if (this.detachedReclaiming.has(name)) return;
    if (
      existsSync(this.path(name, "done.json")) ||
      existsSync(this.path(name, "failed.json")) ||
      existsSync(this.path(name, "handoff.json"))
    ) {
      return; // already terminal — nothing to finalize
    }
    const running = this.readJson(this.path(name, "running.json"));
    if (!running) return; // no persisted lane at all — nothing to finalize
    const requested = this.detachedHandoffRequested.has(name) || running.handoff_requested === true;
    if (!requested) return;
    // wrapperAlive: 1 alive (still draining — wait) | -1 unknown/unreadable pid (per the
    // advisory: just stop checking, never treat as dead, never throw) | 0 confirmed dead.
    if (this.wrapperAlive(name) !== 0) return;
    // #69: no git call here — the worktree is left exactly as the worker left it. This finalize
    // exists purely to write the .handoff sentinel for a detached lane (no in-process onExit
    // ever runs for it); it no longer has any WIP-preservation responsibility.
    const issue = typeof running.issue === "number" ? running.issue : -1;
    const sessionId = typeof running.session_id === "string" ? running.session_id : "";
    // Unconditionally "handoff" — no timedOut/code branching (there's no exit code at all
    // here, no live process to report one for). cost will often parse to 0 since a SIGTERM'd
    // claude usually never writes its terminal stream-json result line — the same pre-existing
    // #60 ceiling as the in-process path, not a new gap introduced here.
    this.writeTerminalSentinel(name, issue, sessionId, this.path(name, "jsonl"), "handoff", null);
    this.detachedHandoffRequested.delete(name);
  }

  async probe(name: string): Promise<LaneProbe> {
    // #63: run BEFORE the sentinel existsSync reads below, so a freshly-confirmed-dead
    // detached lane's just-written .handoff.json is observed by THIS SAME probe() call —
    // no separate poll loop, no extra tick lag. See the method comment for why this placement
    // (inside probe, ahead of classification) is what wins the race against the conductor's
    // own DEAD reclassification.
    this.finalizeDetachedHandoffIfConfirmedDead(name);
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
    // #155: LIVE telemetry only for a lane THIS supervisor still holds in-memory (this.lanes —
    // i.e. actually running; onExit deletes the entry the instant the process exits, terminal
    // or not). A DETACHED lane (persisted running.json, no in-memory handle — the engine
    // restarted while the worker kept running) has no known estimateBaselineUsd to reuse, so
    // it's left undefined here rather than inventing a second baseline (assuming a fresh-dispatch
    // baseline of 0 would misprice a resumed detached lane's current leg).
    const lane = this.lanes.get(name);
    const liveTelemetry = lane ? this.liveTelemetry(lane) : undefined;
    return {
      done, failed, handoff, hbAge, wrapperAlive, hasPr, costUsd, modelUsage,
      ...(prNumber != null ? { prNumber } : {}),
      ...(liveTelemetry ? { liveTelemetry } : {}),
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

  /** #69: tears the lane's process down, THEN decides its worktree's fate — see
   *  retainOrDeleteWorktree for the dirty/clean policy. The caller (conductor.ts) uses the
   *  returned ReclaimResult to escalate a retained worktree to a human (issue comment + label);
   *  worker.ts itself never talks to the forge. */
  async reclaim(name: string): Promise<ReclaimResult> {
    const lane = this.lanes.get(name);
    if (lane) {
      lane.reclaiming = true;
      clearInterval(lane.hb);
      await this.killTree(lane.child);
      return this.retainOrDeleteWorktree(name);
    }
    // Cross-process / post-restart: no in-memory handle — kill by the persisted pid. Mark
    // this lane as reclaiming FIRST, before the kill — #63's detached-confirm-death check in
    // probe() must never finalize a lane reclaim() has already decided is going FAILED (a
    // DEAD reclassification or a ceiling-escalation kill), even if it also happens to match
    // "handoff was requested, pid now confirmed dead". reclaim() always wins that race.
    this.detachedReclaiming.add(name);
    this.detachedHandoffRequested.delete(name);
    const pid = this.persistedPid(name);
    if (pid != null) await this.killByPid(pid);
    return this.retainOrDeleteWorktree(name);
  }

  /** #69 (fable P3-b): report a lane's worktree dirtiness WITHOUT any teardown — no kill, no
   *  delete. A `.done`/`.failed` sentinel lane with an open PR is rescued straight to `driving`
   *  (its process already exited; reclaim() is never called, so no dirtiness check would run).
   *  The conductor calls this to apply the same dirty ⇒ needs-human policy the DEAD path uses:
   *  a crashed worker that left uncommitted WIP alongside its PR is escalated to a human rather
   *  than auto-driven toward merge. `worktreeRetained: true` == "possibly dirty"; nothing is
   *  ever deleted here (the terminal path keeps the worktree regardless). */
  inspectWorktree(name: string): ReclaimResult {
    const worktreePath = join(this.worktreeRoot, name);
    if (!existsSync(worktreePath)) return { worktreePath: null, worktreeRetained: false };
    return { worktreePath, worktreeRetained: this.worktreeMaybeDirty(worktreePath, this.dispatchedBaselineMs(name)) };
  }

  /** #69: dirty-worktree retention (replaces #60/#62's supervisor-side git commit+push, and the
   *  #65 RCE class it carried). Automation must never DELETE a worktree that might still hold
   *  uncommitted work — but it must also never RUN GIT in a worktree the worker fully
   *  controlled (that's this whole PR's invariant). `git status --porcelain` was considered and
   *  REJECTED: empirically confirmed (git 2.50.1) to invoke a worker-set `filter.<name>.clean`
   *  when the working-tree file's mtime races the index's own mtime (the classic "racy git"
   *  content recompute) — even with `-c core.fsmonitor=false` — and a worker can force that race
   *  deliberately (`touch -r .git/index <file>` after editing it) with the ordinary Bash access
   *  it already has to its own worktree. That's the exact #65 clean-filter RCE, just reachable
   *  via reclaim() instead of the deleted #62 commit+push path. So dirtiness here is a pure
   *  FILESYSTEM heuristic (worktreeMaybeDirty): any entry under the worktree (except `.git/`)
   *  whose mtime OR ctime is after the lane's FIRST-dispatch time (dispatchedBaselineMs) is
   *  "possibly dirty". False positives (a worker that edited-then-committed a file, whose
   *  timestamps still moved) just cost an extra needs-human retention — the accepted #69 policy
   *  trade-off. False negatives would silently lose real WIP; checking ctime as well as mtime
   *  (fable P2-b) closes the mtime-backdating gap, since unprivileged code cannot backdate
   *  ctime (any write/utimes/chmod bumps it) — never a supervisor-side execution risk. */
  private retainOrDeleteWorktree(name: string): ReclaimResult {
    const worktreePath = join(this.worktreeRoot, name);
    if (!existsSync(worktreePath)) return { worktreePath: null, worktreeRetained: false };
    if (this.worktreeMaybeDirty(worktreePath, this.dispatchedBaselineMs(name))) {
      return { worktreePath, worktreeRetained: true }; // left on disk — caller escalates
    }
    try {
      rmSync(worktreePath, { recursive: true, force: true });
    } catch {
      // Best-effort: an unremovable clean worktree is a minor disk-hygiene issue, not a data
      // loss risk (nothing to lose — it was clean) — don't let it fail the whole reclaim.
    }
    // NOTE (#69 debt, fable P3): the parent repo's `.git/worktrees/<name>` registration (and
    // the lane branch) is left dangling — pre-#69 the engine never deleted worktrees. Harmless
    // for correctness; shows up as a prunable entry in `git worktree list`. A `git worktree
    // prune` (which runs in the TRUSTED main repo, not a worker tree) is a future operator/
    // housekeeping step, deliberately not run here to keep this path git-free.
    return { worktreePath, worktreeRetained: false };
  }

  /** Recursive `.git`-excluding mtime/ctime scan. Never invokes git. Directory timestamps are
   *  checked too (a deleted file is also an uncommitted change, visible only as its parent
   *  dir's bumped timestamp), `lstatSync` never follows symlinks (a planted broken/absolute
   *  link is judged by the link itself), and BOTH mtime and ctime are compared (ctime can't be
   *  backdated by unprivileged code — fable P2-b). The baseline comparison is INCLUSIVE (`>=`,
   *  Codex PR #72 round-2 P2): on a coarse-resolution filesystem a worker can write WIP in the
   *  SAME timestamp tick as dispatch, landing an entry exactly equal to sinceMs — a strict `>`
   *  would read that as clean and DELETE it (a WIP-loss false-negative the degrade-to-human
   *  policy forbids). `>=` widens the fail-safe-dirty window by one tick, the correct direction
   *  (the policy accepts false-positive-dirty, never false-negative-clean). Fails safe (dirty)
   *  on any unreadable/unstatable path or an unknown baseline — the caller only ever deletes on
   *  an explicit `false`. */
  private worktreeMaybeDirty(worktreePath: string, sinceMs: number): boolean {
    if (!Number.isFinite(sinceMs)) return true; // unknown baseline -> can't prove clean
    const touchedSince = (p: string): boolean => {
      const s = lstatSync(p);
      return s.mtimeMs >= sinceMs || s.ctimeMs >= sinceMs;
    };
    const stack: string[] = [worktreePath];
    while (stack.length > 0) {
      const dir = stack.pop()!;
      let entries: Dirent[];
      try {
        if (touchedSince(dir)) return true; // entry added/removed in this dir
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        return true; // unreadable -> fail-safe: treat as possibly dirty
      }
      for (const e of entries) {
        if (e.name === ".git") continue;
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          stack.push(p); // its own timestamps are checked when popped
          continue;
        }
        try {
          if (touchedSince(p)) return true;
        } catch {
          return true; // unstatable -> fail-safe dirty
        }
      }
    }
    return false;
  }

  /** The IMMUTABLE first-dispatch time (`dispatched_at`) that the dirty-worktree retention
   *  check baselines on — set once at dispatch, preserved by resume() (never reset to
   *  resume-time like `started_at`, which drives the wall-clock timeout). Read from whichever
   *  of running.json / the terminal sentinels currently carries it (running.json for a live or
   *  DEAD lane; the sentinel for a terminal lane whose running.json was already removed).
   *  Missing/unparseable everywhere -> NaN, which worktreeMaybeDirty treats as fail-safe dirty
   *  (covers legacy sentinels predating this field). */
  private dispatchedBaselineMs(name: string): number {
    for (const ext of ["running.json", "handoff.json", "done.json", "failed.json"]) {
      const r = this.readJson(this.path(name, ext));
      const iso = typeof r?.dispatched_at === "string" ? r.dispatched_at : null;
      if (iso) {
        const t = Date.parse(iso);
        if (!Number.isNaN(t)) return t;
      }
    }
    return NaN;
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
  // Imperative — headless has no human to confirm; the worker starts immediately. This is the
  // internal last-resort skeleton used ONLY when a caller constructs WorkerSupervisor with no
  // renderPrompt at all (e.g. a test, or a future embedder). The real `sapwood run` entry point
  // (cli.ts) always wires deps.renderPrompt via buildRenderPrompt(cfg) below, which loads the
  // full TDD/two-gate method from the shipped prompts/worker.md (or an operator override) — #74.
  return [
    `You are an autonomous worker. Implement GitHub issue #${issue.number}: ${issue.title}.`,
    `Work on a feature branch, follow the repo's tests-first method, and open a pull request when done.`,
    `Do not merge. Commit and push your work; the conductor handles review and merge.`,
  ].join("\n");
}

// ── #74: file-based worker prompt (config.ts's worker.promptFile + the shipped default) ──

/** Supported `{{var}}` substitutions — deliberately tiny (no template engine, no new
 *  dependency): just the per-issue fields a worker prompt needs to address a specific issue
 *  (config-level vars like {{labels.verifyNa}} live in CONFIG_VARS, merged by buildRenderPrompt). */
const PROMPT_VARS: Record<string, (issue: Issue) => string> = {
  "issue.number": (issue) => String(issue.number),
  "issue.title": (issue) => issue.title,
  "issue.body": (issue) => issue.body ?? "",
  // Labels drive the prompt's own branching (e.g. the verify:n/a doc-gate path) — the worker
  // can't check a label the template never shows it.
  "issue.labels": (issue) => issue.labels.join(", "),
};

/** Simple `{{var}}` substitution (#74) — no template engine. FAILS CLOSED on any `{{...}}`
 *  placeholder outside PROMPT_VARS: a typo'd/unsupported var must not silently pass through as
 *  literal `{{...}}` text in the dispatched prompt (the whole point of a configurable prompt is
 *  knowing exactly what gets sent to the worker). Every well-formed `{{...}}` token is checked —
 *  the name pattern is deliberately broad and the lookup is own-key only, so neither a typo like
 *  `{{issue-title}}` nor a prototype name like `{{constructor}}` can slip through. Malformed
 *  (unclosed) `{{` is left untouched. */
export function renderPromptTemplate(template: string, issue: Issue): string {
  return template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => {
    const name = raw.trim();
    if (!Object.hasOwn(PROMPT_VARS, name)) {
      throw new Error(
        `worker prompt template: unknown variable {{${name}}} — supported: ${Object.keys(PROMPT_VARS).join(", ")}`,
      );
    }
    return PROMPT_VARS[name]!(issue);
  });
}

/** Resolves the shipped default prompt — `engine/prompts/worker.md` inside the engine
 *  package, NOT relative to the target repo the engine is orchestrating. */
export function defaultPromptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // engine/src (tsx) and engine/dist (built) are both one level below engine/ —
  // the prompt lives INSIDE the engine package so `npm pack --workspace engine`
  // ships it (a repo-root prompts/ would be absent from packaged installs).
  return join(here, "..", "prompts", "worker.md");
}

/** Load the worker prompt TEMPLATE, raw and un-substituted, exactly ONCE. Either the operator's
 *  `worker.promptFile` (loadConfig has already resolved a relative path against the CONFIG
 *  FILE's directory, so by here it is effectively absolute) or, when unset, the shipped default
 *  at `engine/prompts/worker.md` (see defaultPromptPath — resolved inside the engine package,
 *  never the orchestrated repo).
 *
 *  FAIL-FAST (#74): an explicitly configured `promptFile` that's missing or unreadable throws
 *  here, NAMING THE PATH — never a silent fallback to the shipped default. Meant to be called
 *  once at startup (buildRenderPrompt), before any dispatch. */
export function loadWorkerPromptTemplate(cfg: SapwoodConfig): string {
  const configured = cfg.worker.promptFile;
  if (configured === undefined) return readFileSync(defaultPromptPath(), "utf8");
  if (!existsSync(configured)) {
    throw new Error(`worker.promptFile not found: ${configured} — refusing to dispatch`);
  }
  try {
    return readFileSync(configured, "utf8");
  } catch (e) {
    throw new Error(`worker.promptFile unreadable: ${configured} (${String(e)}) — refusing to dispatch`);
  }
}

/** Config-level `{{var}}`s — they don't vary per issue. The shipped prompt references the
 *  verify-label by var, not literal, so a repo that customizes `labels.verifyNa` gets a prompt
 *  that names ITS label. */
const CONFIG_VARS: Record<string, (cfg: SapwoodConfig) => string> = {
  "labels.verifyNa": (cfg) => cfg.labels.verifyNa,
  // #167: the repo-level review doctrine (technical invariants + adjudication doctrine) —
  // loaded fresh per render (doctrine.ts's loadDoctrine, config-file-relative-resolved
  // `cfg.doctrine.file`, capped/deterministically-truncated at `cfg.doctrine.maxChars`). Missing
  // file is NOT an error, unlike `worker.promptFile` above — it degrades to doctrine.ts's
  // explicit NO_DOCTRINE placeholder (see that module's doc comment), never a silent empty
  // substitution and never a startup throw.
  "doctrine": (cfg) => loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars),
};

/** Builds the `WorkerDeps.renderPrompt` closure (#74): loads the template ONCE, eagerly —
 *  fail-fast on a missing/unreadable/EMPTY `worker.promptFile` AND on any unknown `{{var}}`
 *  happens here, at call time, not lazily on first dispatch — a bad template discovered at
 *  render time would fire AFTER the dispatch loop already claimed the issue (Ready → In
 *  Progress), forcing a rollback on every tick. The real `sapwood run` entry point (cli.ts)
 *  calls this immediately after loadConfig(), before constructing the WorkerSupervisor, so a
 *  bad promptFile aborts startup with no dispatch ever happening.
 *
 *  Rendering is a SINGLE pass over the original template with one combined var map — a
 *  substituted value is literal output, never re-scanned for `{{...}}`, so a config value like
 *  `{{issue.body}}` cannot smuggle in a second expansion. */
export function buildRenderPrompt(cfg: SapwoodConfig): (issue: Issue) => string {
  const template = loadWorkerPromptTemplate(cfg);
  if (template.trim() === "") {
    throw new Error(
      `worker prompt template is empty${cfg.worker.promptFile !== undefined ? `: ${cfg.worker.promptFile}` : ""} — refusing to dispatch an undirected worker`,
    );
  }
  const vars: Record<string, (issue: Issue) => string> = { ...PROMPT_VARS };
  for (const [name, fromCfg] of Object.entries(CONFIG_VARS)) vars[name] = () => fromCfg(cfg);
  for (const [, raw] of template.matchAll(/\{\{([^{}]*)\}\}/g)) {
    const name = raw!.trim();
    if (!Object.hasOwn(vars, name)) {
      throw new Error(
        `worker prompt template: unknown variable {{${name}}} — supported: ${Object.keys(vars).join(", ")}`,
      );
    }
  }
  return (issue: Issue) =>
    template.replace(/\{\{([^{}]*)\}\}/g, (_match, raw: string) => vars[raw.trim()]!(issue));
}
