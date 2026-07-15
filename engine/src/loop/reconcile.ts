import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type BoardPlacement, type IForge, type OpenPrBody, referencedIssue } from "../forge/forge.js";
import type { State, WorkerRow } from "../state/state.js";

export type StartupOrphan =
  | { kind: "issue"; issue: number; reason: "in-progress" | "unplaced" }
  | { kind: "pr"; pr: number; issue: number; reason: "open-engine-pr" };

export interface ReconcileCompletedPayload {
  ok: boolean;
  count: number;
  orphans: StartupOrphan[];
  overflow: number;
}

const ORPHAN_REPORT_LIMIT = 100;

export function diffStartupOrphans(args: {
  placements: readonly BoardPlacement[];
  openPrs: readonly OpenPrBody[];
  workers: readonly WorkerRow[];
  repoFullName: string;
  inProgressStatus: string;
}): StartupOrphan[] {
  const ownedIssues = new Set(args.workers.map((worker) => worker.issue));
  const ownedPrs = new Set(args.workers.flatMap((worker) => (worker.pr == null ? [] : [worker.pr])));
  const issues = new Map<number, "in-progress" | "unplaced">();
  for (const placement of args.placements) {
    if (placement.repo !== args.repoFullName || placement.number === null || ownedIssues.has(placement.number)) continue;
    if (placement.status === args.inProgressStatus) issues.set(placement.number, "in-progress");
    else if (placement.status === null) issues.set(placement.number, "unplaced");
  }
  const orphans: StartupOrphan[] = [...issues.entries()]
    .sort(([a], [b]) => a - b)
    .map(([issue, reason]) => ({ kind: "issue", issue, reason }));
  for (const pr of args.openPrs) {
    const issue = referencedIssue(pr.body);
    if (issue !== null && !ownedPrs.has(pr.number) && !ownedIssues.has(issue)) {
      orphans.push({ kind: "pr", pr: pr.number, issue, reason: "open-engine-pr" });
    }
  }
  return orphans;
}

export async function reconcileStartup(
  forge: Pick<IForge, "readStartupReconcileData">,
  state: Pick<State, "appendEvent" | "reconcileWorkers">,
  cfg: { board: { owner: string; repo: string; status: { inProgress: string } } },
  log: (message: string) => void = console.error,
): Promise<StartupOrphan[]> {
  let orphans: StartupOrphan[];
  try {
    const input = await forge.readStartupReconcileData();
    orphans = diffStartupOrphans({
      ...input,
      workers: state.reconcileWorkers(),
      repoFullName: `${cfg.board.owner}/${cfg.board.repo}`,
      inProgressStatus: cfg.board.status.inProgress,
    });
  } catch (error) {
    log(`[sapwood:reconcile] startup failed; continuing: ${String(error)}`);
    state.appendEvent("reconcile-completed", { ok: false, count: 0, orphans: [], overflow: 0 } satisfies ReconcileCompletedPayload);
    return [];
  }
  for (const orphan of orphans) state.appendEvent("orphan-detected", orphan);
  const reported = orphans.slice(0, ORPHAN_REPORT_LIMIT);
  state.appendEvent("reconcile-completed", {
    ok: true,
    count: orphans.length,
    orphans: reported,
    overflow: orphans.length - reported.length,
  } satisfies ReconcileCompletedPayload);
  return orphans;
}

export interface RoleSweepOptions {
  stateDir?: string;
  worktreeRoot?: string;
  pidStatus?: (pid: number) => "alive" | "dead" | "unreadable";
  log?: (message: string) => void;
}

function processStatus(pid: number): "alive" | "dead" | "unreadable" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH" ? "dead" : "unreadable";
  }
}

/** Sweep only role-* running sentinels. Unknown/unreadable pids are retained, and the distinct
 *  worker sentinel directory plus the role- prefix keep worker lanes/worktrees out of scope. */
export function sweepStaleRoleSessions(state: Pick<State, "appendEvent">, options: RoleSweepOptions = {}): string[] {
  const stateDir = options.stateDir ?? join(process.cwd(), "data", "sessions", "roles");
  const worktreeRoot = options.worktreeRoot ?? join(process.cwd(), ".claude", "worktrees");
  const status = options.pidStatus ?? processStatus;
  if (!existsSync(stateDir)) return [];
  const swept: string[] = [];
  for (const filename of readdirSync(stateDir)) {
    if (!filename.startsWith("role-") || !filename.endsWith(".running.json")) continue;
    const sentinel = join(stateDir, filename);
    let pid: unknown;
    try {
      pid = (JSON.parse(readFileSync(sentinel, "utf8")) as { wrapper_pid?: unknown }).wrapper_pid;
    } catch {
      continue;
    }
    if (!Number.isSafeInteger(pid) || (pid as number) <= 0 || status(pid as number) !== "dead") continue;
    const name = filename.slice(0, -".running.json".length);
    const removed: string[] = [];
    try {
      const worktree = join(worktreeRoot, name);
      // Worktree first preserves the sentinel as a retry anchor if its removal fails; if only
      // sentinel removal fails, the next startup harmlessly retries with the worktree absent.
      if (existsSync(worktree)) {
        rmSync(worktree, { recursive: true, force: true });
        removed.push("worktree");
      }
      rmSync(sentinel);
      removed.push("sentinel");
    } catch (error) {
      options.log?.(`[sapwood:reconcile] role session ${name}: stale-session sweep failed; continuing: ${String(error)}`);
    }
    if (removed.length > 0) {
      state.appendEvent("role-debris-swept", { session: name, removed });
      swept.push(name);
    }
  }
  return swept;
}

export function parseReconcileCompleted(payload: unknown): ReconcileCompletedPayload | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = payload as Partial<ReconcileCompletedPayload>;
  if (value.ok !== true || !Array.isArray(value.orphans) || typeof value.overflow !== "number") return null;
  return value as ReconcileCompletedPayload;
}
