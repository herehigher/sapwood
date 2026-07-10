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
import {
  existsSync, mkdirSync, openSync, closeSync, readFileSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SapwoodConfig } from "./config.js";
import type { ModelUsageEntry } from "./state.js";
import {
  claudeArgs, guardSettings, discoverClaudeBin, parseCostUsd, parseModelUsage,
  spawnClaudeSession, type SpawnedSession,
} from "./worker.js";

/** Issues-only write scope (#87 task A): comment/label/edit ISSUES via `gh issue ...` — no
 *  file Read/Write/Edit, no git, no `gh pr`/`gh api` (no PR visibility, no review/approve/
 *  merge capability). Everything the session needs to know about the issue is already
 *  substituted into its prompt (issue.number/title/body/labels), so it needs no READ tool at
 *  all, only the two write actions its role requires. Coarse noise-reduction (same caveat as
 *  worker.ts's tool lists) — the real boundary is the SAME fail-closed guard hook every
 *  session gets via guardSettings, unchanged. */
export const ROLE_ALLOWED_TOOLS = "Bash(gh issue comment*),Bash(gh issue edit*)";
export const ROLE_DISALLOWED_TOOLS =
  "Read,Write,Edit,MultiEdit,Bash(git *),Bash(gh pr *),Bash(gh api *),Bash(gh issue view*)," +
  "Bash(gh issue list*),Bash(gh issue close*),Bash(gh issue reopen*),Bash(gh issue transfer*)," +
  "Bash(gh issue delete*)";

export interface RoleSessionOpts {
  /** A short, log-friendly role identity ("plan-reviewer", "plan-drafter", ...) — becomes
   *  part of the session's lane/sentinel name, never interpreted. */
  roleId: string;
  prompt: string;
  model: string;
  effort: string;
}

export interface RoleSessionResult {
  outcome: "done" | "failed" | "timeout";
  costUsd: number;
  modelUsage: ModelUsageEntry[];
  exitCode: number | null;
  /** The session/lane name this run used — callers key spend-ledger rows off it. */
  name: string;
}

export interface RoleRunnerDeps {
  cfg: SapwoodConfig;
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
}

const SENTINEL_EXTS = ["running.json", "done.json", "failed.json", "jsonl"];

export class RoleRunner {
  private readonly dir: string;
  private readonly worktreeRoot: string;
  private readonly bin: string;
  private readonly hbMs: number;
  private readonly guardHookPath: string;

  constructor(private readonly deps: RoleRunnerDeps) {
    this.dir = deps.stateDir ?? join(process.cwd(), "data", "sessions", "roles");
    this.worktreeRoot = deps.worktreeRoot ?? join(process.cwd(), ".claude", "worktrees");
    this.bin = deps.claudeBin ?? discoverClaudeBin(process.env);
    this.hbMs = deps.heartbeatMs ?? 30_000;
    this.guardHookPath = deps.guardHookPath ?? fileURLToPath(new URL("./guard-hook.js", import.meta.url));
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
    const args = claudeArgs({
      prompt: opts.prompt, model: opts.model, effort: opts.effort,
      worktree: name, name, sessionId, settings: settingsJson,
      allowedTools: ROLE_ALLOWED_TOOLS, disallowedTools: ROLE_DISALLOWED_TOOLS,
      // NB: no addDir — same as worker.ts's dispatch(): a role session must never see engine
      // state (sentinels, the sqlite db) via --add-dir.
    });
    const startedMs = this.now().getTime();
    const session = spawnClaudeSession(this.bin, args, {
      jsonlFd, env: { ...process.env, SAPWOOD_GUARD_MODE: guardMode },
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
      session.onError((e) => { spawnErr = e; resolve(); });
    });
    if (spawnErr) {
      try { closeSync(jsonlFd); } catch { /* noop */ }
      this.removeIfExists(jsonlPath);
      throw new Error(`role session spawn failed (${this.bin}): ${String(spawnErr)}`);
    }
    session.onError(() => { /* post-spawn error: exitPromise's `exit` still resolves this */ });

    this.writeJsonAtomic(this.path(name, "running.json"), {
      name, role_id: opts.roleId, session_id: sessionId,
      wrapper_pid: session.pid, started_at: new Date(startedMs).toISOString(),
    });

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
    try { closeSync(jsonlFd); } catch { /* already closed */ }

    const jsonl = this.readJsonl(jsonlPath);
    const costUsd = parseCostUsd(jsonl);
    const modelUsage = parseModelUsage(jsonl);
    const outcome: "done" | "failed" | "timeout" = timedOut ? "timeout" : exitCode === 0 ? "done" : "failed";
    const sentinelTag = outcome === "timeout" ? "failed" : outcome;
    this.writeJsonAtomic(this.path(name, `${sentinelTag}.json`), {
      name, role_id: opts.roleId, session_id: sessionId, exit_code: exitCode,
      total_cost_usd: costUsd, model_usage: modelUsage, ended_at: this.now().toISOString(),
      timed_out: timedOut,
    });
    this.removeIfExists(this.path(name, "running.json"));

    // Always delete the worktree — see the module doc: a role session never writes code
    // (allowedTools scoping + the unchanged guard hook both block it), so unlike worker.ts's
    // dirty-vs-clean retention there is no WIP that could ever need preserving here.
    try { rmSync(join(this.worktreeRoot, name), { recursive: true, force: true }); } catch { /* best-effort */ }

    return { outcome, costUsd, modelUsage, exitCode, name };
  }

  private async killTree(session: SpawnedSession): Promise<void> {
    session.killGroup("SIGTERM");
    await sleep(200);
    session.killGroup("SIGKILL");
  }

  private readJsonl(p: string): string {
    try { return readFileSync(p, "utf8"); } catch { return ""; }
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
