// review/production.ts (#288) — the real config -> EngineAgentReviewer -> per-lane drive wiring.

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
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
      const result = await materialize({ clone, oid: head, treeDir: join(treeRoot, `${head}-${randomUUID()}`) });
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
      recordWalDecisiveOutcome: (runId, outcome) => state.recordEngineReviewWalDecisiveOutcome(worker.name, runId, outcome),
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
