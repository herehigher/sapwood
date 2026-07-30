import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type BoardPlacement, type IForge, type OpenPrBody, referencedIssue } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import type { State, WorkerRow } from "../state/state.js";

export type StartupOrphan =
  | { kind: "issue"; issue: number; reason: "in-progress" | "unplaced" }
  | { kind: "pr"; pr: number; issue: number; reason: "open-engine-pr" };

export interface ReconcileCompletedPayload {
  ok: boolean;
  count: number;
  orphans: StartupOrphan[];
  overflow: number;
  /** #391 (F20): issue numbers this pass actually healed (see healOrphanedIssues). Absent on
   *  pre-#391 events and on the forge-failure path — readers must treat it as optional. */
  healed?: number[];
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

export type ReconcileForge = Pick<IForge, "readStartupReconcileData" | "getIssueMeta" | "removeLabel" | "setBoardStatus">;

export interface ReconcileCfg {
  board: { owner: string; repo: string; status: { inProgress: string } };
  labels: { inProgress: string };
}

/** #391 (F20): return the board+label state of an orphaned issue whose lane is TERMINALLY dead,
 *  so the issue becomes pool-eligible again instead of sitting at In Progress forever. Before
 *  this, startup DETECTED the orphan and stopped there: the dogfood run's issue #145 kept its
 *  `in-progress` label (and its In Progress column) across every restart, invisible to
 *  `selectPoolEligibleIssues` (which requires the Ready column) for as long as the repo lived.
 *
 *  "Terminally dead" is deliberately narrow — an orphan is healed only when:
 *   - it is an `in-progress` orphan (an `unplaced` one is a different residue class, and moving
 *     an unplaced item to Ready would be the engine placing work on the board, which cli.ts's
 *     normalizeUnplacedBoardItems explicitly refuses to do);
 *   - NO open PR references it. A PR-bearing lane is the gated-reentry path's property
 *     (state.ts's gatedFailedWorkers): healing it to Ready would let a SECOND worker be
 *     dispatched at an issue that already has a producer's PR open. This is the whole reason
 *     the issue text scopes F20 to "a dead PR-LESS lane";
 *   - the issue is still OPEN — a closed issue must never be resurrected into the Ready lane.
 *  A human hold (`needs-human`) is deliberately NOT a reason to skip: `isPoolEligible` excludes
 *  held issues anyway, so healing the board/label under the hold is exactly what makes REMOVING
 *  THE LABEL the only manual step left (#391 AC1).
 *
 *  Write order is load-bearing: board FIRST, label second. If the label write is the one that
 *  fails, the issue is already back on Ready and therefore dispatchable (claimIssue re-adds the
 *  label idempotently). The other order would leave it at In Progress with the label gone —
 *  invisible to the pool AND, after this issue's F21 change, no longer even distinguishable to
 *  the standby probe: the worst of both. */
async function healOrphanedIssues(
  forge: ReconcileForge,
  state: Pick<State, "appendEvent">,
  cfg: ReconcileCfg,
  orphans: readonly StartupOrphan[],
  log: (message: string) => void,
): Promise<number[]> {
  const prBearing = new Set(orphans.flatMap((o) => (o.kind === "pr" ? [o.issue] : [])));
  const healed: number[] = [];
  for (const orphan of orphans) {
    if (orphan.kind !== "issue" || orphan.reason !== "in-progress" || prBearing.has(orphan.issue)) continue;
    try {
      if ((await forge.getIssueMeta(orphan.issue)).state !== "OPEN") continue;
      await forge.setBoardStatus(orphan.issue, "ready");
      await forge.removeLabel(orphan.issue, cfg.labels.inProgress);
      healed.push(orphan.issue);
      state.appendEvent("orphan-healed", { issue: orphan.issue, actions: ["board-ready", "label-removed"] });
    } catch (error) {
      // Best-effort, same stance as every other startup pass: a forge hiccup on one issue must
      // not take down the run, and the next startup simply re-detects and retries the same
      // orphan (the heal is idempotent — both writes are no-ops once they've landed).
      log(`[sapwood:reconcile] heal of orphaned issue #${orphan.issue} failed; continuing: ${String(error)}`);
      state.appendEvent("orphan-heal-failed", { issue: orphan.issue, error: String(error) });
    }
  }
  return healed;
}

export async function reconcileStartup(
  forge: ReconcileForge,
  state: Pick<State, "appendEvent" | "reconcileWorkers">,
  cfg: ReconcileCfg,
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
  const healed = await healOrphanedIssues(forge, state, cfg, orphans, log);
  const reported = orphans.slice(0, ORPHAN_REPORT_LIMIT);
  state.appendEvent("reconcile-completed", {
    ok: true,
    count: orphans.length,
    orphans: reported,
    overflow: orphans.length - reported.length,
    healed,
  } satisfies ReconcileCompletedPayload);
  return orphans;
}

/** #391 (F19): audit the `gated_escalation_labeled` marker every gated-reentry candidate depends
 *  on (state.ts's gatedFailedWorkers). Lanes escalated during the 2026-07-24 quota storm carry
 *  the marker at 0 — the reclaim-failed/env-era escalation paths never set it — so a human who
 *  removes `needs-human` gets NOTHING: the row is excluded from every read path, permanently and
 *  silently. Recovery took a direct sqlite UPDATE, invisible to any operator playbook.
 *
 *  What makes correcting it SAFE rather than a false clear: the marker exists to encode "the
 *  engine provably applied the label", because reentry fires on label ABSENCE and absence is only
 *  a human act if the label was ever there. Observing the hold label PRESENT right now is an even
 *  stronger fact than the marker was — whoever applied it, it is on the issue, and the engine
 *  never removes a human-hold label (round.ts's removeRoundPoolLabel refuses to remove anything
 *  but the pool label), so its future disappearance can only be a human. Correcting the marker on
 *  that evidence therefore restores exactly the intended contract, with removing the label as the
 *  ONLY manual step (#391 AC1).
 *
 *  The other direction is deliberately NOT healed: with no hold label present we cannot tell
 *  "the escalation never labelled it" from "a human already removed it", and guessing the latter
 *  would fire reentry at a lane nobody has looked at. Those surface as `gated-flag-unprovable` —
 *  one event per engine start, an honest standing alarm for a lane only a human can move.
 *
 *  Read-only against the forge, one `getIssueMeta` per candidate; the candidate set is the number
 *  of lanes stuck in this residue state, which is small by construction. */
export async function auditGatedEscalationFlags(
  forge: Pick<IForge, "getIssueMeta">,
  state: Pick<State, "unlabeledGatedWorkers" | "upsertWorker" | "appendEvent">,
  cfg: { escalation: { humanLabels: string[] } },
  log: (message: string) => void = console.error,
): Promise<void> {
  let candidates: WorkerRow[];
  try {
    candidates = state.unlabeledGatedWorkers();
  } catch (error) {
    log(`[sapwood:reconcile] gated-flag audit could not read the worker table; skipped: ${String(error)}`);
    return;
  }
  for (const w of candidates) {
    const where = { worker: w.name, issue: w.issue, pr: w.pr ?? null };
    try {
      const meta = await forge.getIssueMeta(w.issue);
      if (!cfg.escalation.humanLabels.some((label) => labelsInclude(meta.labels, label))) {
        state.appendEvent("gated-flag-unprovable", where);
        continue;
      }
      state.upsertWorker({ ...w, gated_escalation_labeled: 1 });
      state.appendEvent("gated-flag-healed", where);
    } catch (error) {
      // Per-lane containment, same shape as escalation-reconcile.ts's own sweep: a read failure
      // leaves this lane exactly as it was and the next startup re-audits it.
      log(`[sapwood:reconcile] gated-flag audit of ${w.name} (#${w.issue}) failed; continuing: ${String(error)}`);
    }
  }
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
