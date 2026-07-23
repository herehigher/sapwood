// review/production.ts (#288) — the real config -> EngineAgentReviewer -> per-lane drive wiring.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { SapwoodConfig } from "../config/config.js";
import { loadDoctrine, NO_DOCTRINE } from "../config/doctrine.js";
import type { IForge } from "../forge/forge.js";
import type { RoleRunner } from "../roles/peripheral.js";
import type { State, WorkerRow } from "../state/state.js";
import { deliverEngineReviewAudit, type EngineReviewArtifact } from "./audit.js";
import type { EngineAgentDriveDeps } from "./drive.js";
import { makeEngineAgentReviewer } from "./engine-agent.js";
import { createPrivateClone, defaultPrivateCloneDir, defaultWorktreeRoot, type MaterializeResult, materialize } from "./materializer.js";

export interface ProductionEngineAgentOptions {
  sourceRepoDir?: string;
  privateCloneDir?: string;
  worktreeRoot?: string;
  reviewTreeRoot?: string;
  materializeOverride?: (head: string) => Promise<MaterializeResult>;
  now?: () => Date;
  newRunId?: () => string;
  log?: (message: string) => void;
}

const REVIEW_TREE_NAME = /^([0-9a-f]{40})-.+/i;

function gcWarning(log: (message: string) => void, action: string, err: unknown): void {
  try {
    log(`[sapwood:review-tree-gc] ${action} failed (non-fatal): ${String(err)}`);
  } catch {
    // Cleanup observability is best-effort too; a broken logger cannot turn GC into a gate.
  }
}

/** Best-effort crash backstop. The pending tree counts toward the cap before it exists, while
 *  every live NULL-outcome WAL head is untouchable even if that temporarily exceeds the cap. */
export function sweepReviewTrees(opts: {
  treeRoot: string;
  retentionCap: number;
  liveHeads: readonly string[];
  pendingTreeDir: string;
  log?: (message: string) => void;
}): void {
  const log = opts.log ?? console.error;
  try {
    if (!existsSync(opts.treeRoot)) return;
    const pendingName = basename(resolve(opts.pendingTreeDir));
    const live = new Set(opts.liveHeads.map((head) => head.toLowerCase()));
    const trees = readdirSync(opts.treeRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && REVIEW_TREE_NAME.test(entry.name))
      .map((entry) => {
        const match = REVIEW_TREE_NAME.exec(entry.name)!;
        return {
          name: entry.name,
          path: join(opts.treeRoot, entry.name),
          head: match[1]!.toLowerCase(),
          mtimeMs: statSync(join(opts.treeRoot, entry.name)).mtimeMs,
        };
      });
    const totalAfterCreate = trees.length + (trees.some((tree) => tree.name === pendingName) ? 0 : 1);
    let excess = Math.max(0, totalAfterCreate - opts.retentionCap);
    for (const tree of trees
      .filter((entry) => entry.name !== pendingName && !live.has(entry.head))
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.name.localeCompare(b.name))) {
      if (excess === 0) break;
      try {
        rmSync(tree.path, { recursive: true, force: true });
        excess--;
      } catch (err) {
        gcWarning(log, `delete ${JSON.stringify(tree.path)}`, err);
      }
    }
  } catch (err) {
    gcWarning(log, `sweep ${JSON.stringify(opts.treeRoot)}`, err);
  }
}

/** Decisive consume cleanup is narrower than the sweep: only directories with this exact full
 *  head prefix are removed, and no cleanup failure may perturb the WAL/review path. */
export function deleteReviewTreesForHead(treeRoot: string, head: string, log: (message: string) => void = console.error): void {
  try {
    if (!existsSync(treeRoot)) return;
    for (const entry of readdirSync(treeRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(`${head}-`)) continue;
      try {
        rmSync(join(treeRoot, entry.name), { recursive: true, force: true });
      } catch (err) {
        gcWarning(log, `delete ${JSON.stringify(join(treeRoot, entry.name))}`, err);
      }
    }
  } catch (err) {
    gcWarning(log, `consume ${JSON.stringify(treeRoot)} for head ${head}`, err);
  }
}

export function makeProductionEngineAgent(
  cfg: SapwoodConfig,
  forge: IForge,
  state: State,
  runner: Pick<RoleRunner, "run">,
  options: ProductionEngineAgentOptions = {},
) {
  const sourceRepoDir = options.sourceRepoDir ?? process.cwd();
  const cloneDir = options.privateCloneDir ?? defaultPrivateCloneDir(sourceRepoDir);
  const worktreeRoot = options.worktreeRoot ?? defaultWorktreeRoot(sourceRepoDir);
  const treeRoot = options.reviewTreeRoot ?? join(sourceRepoDir, "data", "review", "trees");
  const artifacts = new Map<string, EngineReviewArtifact>();
  let activeWorker: string | null = null; // conductor DRIVE is single-writer serial
  const now = options.now ?? (() => new Date());
  const log = options.log ?? console.error;

  const reviewer = makeEngineAgentReviewer({
    cfg,
    runner,
    getAcSnapshot: (issue) => state.getAcSnapshot(issue),
    getWorkerActualModels: (issue) => state.getWorkerActualModels(issue),
    ...(() => {
      const d = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
      return d === NO_DOCTRINE ? {} : { doctrine: d };
    })(),
    now,
    onReviewArtifact: (head, artifact) => artifacts.set(head, artifact),
    materialize: async (head) => {
      const treeDir = join(treeRoot, `${head}-${randomUUID()}`);
      try {
        sweepReviewTrees({
          treeRoot,
          retentionCap: cfg.reviewer.agent!.treeRetentionCap,
          liveHeads: state.getLiveEngineReviewHeads(),
          pendingTreeDir: treeDir,
          log,
        });
      } catch (err) {
        // The liveness query is part of GC too; a read failure must not suppress the review.
        gcWarning(log, `read live WAL heads before sweeping ${JSON.stringify(treeRoot)}`, err);
      }
      if (options.materializeOverride) {
        const result = await options.materializeOverride(head);
        if (result.kind === "materialized" && activeWorker) {
          const wal = state.getEngineReviewWal(activeWorker);
          if (wal?.head === head)
            state.updateEngineReviewWalManifestHash(
              activeWorker,
              wal.runId,
              createHash("sha256").update(JSON.stringify(result.manifest)).digest("hex"),
            );
        }
        return result;
      }
      const clone = await createPrivateClone({ sourceRepoDir, cloneDir, worktreeRoot });
      const result = await materialize({ clone, oid: head, treeDir });
      if (result.kind === "materialized" && activeWorker) {
        const wal = state.getEngineReviewWal(activeWorker);
        if (wal?.head === head) {
          const manifestHash = createHash("sha256").update(JSON.stringify(result.manifest)).digest("hex");
          state.updateEngineReviewWalManifestHash(activeWorker, wal.runId, manifestHash);
        }
      }
      return result;
    },
  });

  const driveDepsForLane = (worker: WorkerRow, pr: number): Omit<EngineAgentDriveDeps, "forge" | "cfg" | "reviewerAdapter"> => {
    activeWorker = worker.name;
    const deliver = async () => {
      const wal = state.getEngineReviewWal(worker.name);
      if (!wal) return { delivered: false as const, reason: "engine-agent WAL row missing" };
      return deliverEngineReviewAudit({
        forge,
        pr,
        wal,
        commentsCap: cfg.proxy.caps.maxAuditCommentsPerCall,
        now,
        recordReceipt: (runId, id, at) => state.recordEngineReviewAuditReceipt(worker.name, runId, id, at),
      });
    };
    return {
      now,
      newRunId: options.newRunId ?? randomUUID,
      getAttemptPin: () => state.getEngineReviewAttemptPin(worker.name),
      getFirstAttemptAt: () => state.getWorker(worker.name)?.engine_review_first_attempt_at ?? null,
      recordAttemptPin: (pin) => state.recordEngineReviewAttemptPin(worker.name, pin),
      getWal: () => state.getEngineReviewWal(worker.name),
      recordWal: (wal) => state.recordEngineReviewWal(worker.name, wal),
      recordWalDecisiveOutcome: (runId, outcome) => {
        state.recordEngineReviewWalDecisiveOutcome(worker.name, runId, outcome);
        try {
          const wal = state.getEngineReviewWal(worker.name);
          if (wal?.runId === runId && wal.decisiveOutcome === outcome) deleteReviewTreesForHead(treeRoot, wal.head, log);
        } catch (err) {
          gcWarning(log, `resolve decisive WAL head for worker ${worker.name}`, err);
        }
      },
      auditDelivery: async (result) => {
        const wal = state.getEngineReviewWal(worker.name);
        const artifact = wal ? artifacts.get(wal.head) : undefined;
        if (!wal || !artifact) return { delivered: false, reason: "validated review artifact side channel missing" };
        if (!state.recordEngineReviewWalArtifact(worker.name, wal.runId, result.kind, JSON.stringify(artifact))) {
          return { delivered: false, reason: "review artifact WAL write lost its runId guard" };
        }
        artifacts.delete(wal.head);
        return deliver();
      },
      reconcileAuditDelivery: () => deliver(),
      ciChecksCap: cfg.proxy.caps.maxChecksPerCall,
    };
  };

  return { reviewer, driveDepsForLane };
}
