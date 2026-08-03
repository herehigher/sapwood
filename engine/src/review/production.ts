// review/production.ts (#288) — the real config -> EngineAgentReviewer -> per-lane drive wiring.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { SapwoodConfig } from "../config/config.js";
import { loadDoctrine, NO_DOCTRINE } from "../config/doctrine.js";
import type { IForge } from "../forge/forge.js";
import { baseRedPin } from "../loop/base-ci.js";
import type { RoleRunner } from "../roles/peripheral.js";
import type { State, WorkerRow } from "../state/state.js";
import type { PerAcResult } from "./agent-output.js";
import { deliverEngineReviewAudit, type EngineReviewArtifact } from "./audit.js";
import { CodexExecReviewSessionExecutor, DEFAULT_CODEX_PRICING } from "./codex-exec.js";
import type { EngineAgentDriveDeps } from "./drive.js";
import { makeEngineAgentReviewer } from "./engine-agent.js";
import {
  createPrivateClone,
  defaultPrivateCloneDir,
  defaultWorktreeRoot,
  type MaterializeResult,
  materializeWithExternalFetch,
} from "./materializer.js";
import { formatIdentity, type ReviewSessionExecutor } from "./review-session.js";

export interface ProductionEngineAgentOptions {
  sourceRepoDir?: string;
  privateCloneDir?: string;
  worktreeRoot?: string;
  reviewTreeRoot?: string;
  materializeOverride?: (head: string) => Promise<MaterializeResult>;
  now: () => Date;
  newRunId?: () => string;
  log?: (message: string) => void;
}

const REVIEW_TREE_NAME = /^([0-9a-f]{40})-.+/i;

/** #489: the event kind announcing a decisive engine-agent gate② verdict. Copy entry lives in
 *  docs/frontend-design.md §7 (every engine PR that adds a kind extends that map). */
export const ENGINE_REVIEW_VERDICT = "engine-review-verdict";

/** Verbatim status keys (`agent-output.ts`'s own vocabulary), all three always present so a
 *  consumer never has to distinguish "zero" from "absent". */
function countPerAcStatuses(perAC: readonly PerAcResult[]): Record<PerAcResult["status"], number> {
  const counts = { confirmed: 0, "cannot-confirm": 0, "claim-accepted": 0 };
  for (const ac of perAC) counts[ac.status]++;
  return counts;
}

function gcWarning(log: (message: string) => void, action: string, err: unknown): void {
  try {
    log(`[sapwood:review-tree-gc] ${action} failed (non-fatal): ${String(err)}`);
  } catch {
    // Cleanup observability is best-effort too; a broken logger cannot turn GC into a gate.
  }
}

/** #612: the spend_ledger `worker` key an engine-agent review SESSION's own cost is recorded
 *  under — deliberately DIFFERENT from the reviewed lane's own `worker.name`. Recording it under
 *  the lane's name would make `State.getWorkerActualModels(issue)` (its `WHERE worker = ?` read,
 *  keyed on the exact lane name) pick up the REVIEWER's own model as one of "the producing lane's
 *  actual models" — poisoning engine-agent.ts's D5 model-separation check, so a LATER review of
 *  the SAME lane (a fix-round re-review, same worker name) would see the reviewer overlapping
 *  itself and fail closed forever. A distinct key sidesteps that; `cost.roundBudgetUsd`/
 *  `cost.dailyBudgetUsd` still see the spend either way (spentUsdAfterId/dailySpendUsd are plain
 *  SUM(usd) reads over spend_ledger, never filtered by worker). */
function reviewSpendWorkerKey(workerName: string): string {
  return `${workerName}:engine-review`;
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
  options: ProductionEngineAgentOptions,
) {
  const sourceRepoDir = options.sourceRepoDir ?? process.cwd();
  const cloneDir = options.privateCloneDir ?? defaultPrivateCloneDir(sourceRepoDir);
  const worktreeRoot = options.worktreeRoot ?? defaultWorktreeRoot(sourceRepoDir);
  const treeRoot = options.reviewTreeRoot ?? join(sourceRepoDir, "data", "review", "trees");
  const artifacts = new Map<string, EngineReviewArtifact>();
  let activeWorker: string | null = null; // conductor DRIVE is single-writer serial
  const now = options.now;
  const log = options.log ?? console.error;

  // #443: the executor-selection composition. `claude` (the default) supplies NOTHING here — the
  // reviewer's own default seam over `runner` is byte-for-byte the pre-#443 path. `codex-exec`
  // builds the local codex session runner, wired to this engine's real durable event channel so
  // R1/R2's honest-recording events (advisory budget, unknown cost, containment blind spot) land in
  // the same event stream every other engine fact does.
  const executor: ReviewSessionExecutor | undefined =
    cfg.reviewer.agent?.runner === "codex-exec"
      ? new CodexExecReviewSessionExecutor({
          stateDir: join(sourceRepoDir, "data", "sessions", "review-codex"),
          // The SAME wall-clock ceiling every other session in this engine gets — a timeout is not
          // a cost cap, and R1 changes nothing about it.
          timeoutSec: cfg.worker.timeoutSec,
          pricing: cfg.reviewer.agent.codexPricing ?? DEFAULT_CODEX_PRICING,
          log,
          appendEvent: (kind, payload) => state.appendEvent(kind, payload),
        })
      : undefined;

  const reviewer = makeEngineAgentReviewer({
    cfg,
    runner,
    ...(executor ? { executor } : {}),
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
      // #395 (gate② P3): thread the same forge-call timeout `gh` calls use — one user-tunable
      // knob for both external-process bounds, rather than a second one just for materializer.ts.
      const clone = await createPrivateClone({ sourceRepoDir, cloneDir, worktreeRoot, timeoutMs: cfg.liveness.forgeCallTimeoutMs });
      // #499: an externally-created PR head (update-branch, foreign push, fork PR) is absent
      // from the local object store — fall back to one bounded fetch from the forge remote.
      const result = await materializeWithExternalFetch({
        clone,
        oid: head,
        treeDir,
        timeoutMs: cfg.liveness.forgeCallTimeoutMs,
        sourceRepoDir,
        log,
      });
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

  /** #489: the decisive gate② verdict, announced in the durable event stream. Under
   *  `reviewer.mode: engine-agent` the verdict used to live ONLY in the WAL + the PR audit comment,
   *  so a supervisor watching the event log saw a PR open and then merge with nothing in between —
   *  reconstructing gate② meant joining three sources by hand. Emitted from the ONE site where a
   *  WAL row gets its `decisive_outcome`, so there is no second place a verdict can be born.
   *
   *  SUMMARY only (counts, never the findings themselves): the full artifact keeps its one home in
   *  the WAL row / audit comment.
   *
   *  LOG-FIRST, before the WAL write (the same ordering the audit path uses), with the log itself
   *  as the dedup memory (#169/#294) keyed by runId: a crash anywhere around the pair replays into
   *  exactly ONE event for that run, while the lane's NEXT attempt — a different runId — still gets
   *  its own. Best-effort like every other observability write here: a failed append is logged, and
   *  never turns the event log into a gate on the review. */
  const appendVerdictEvent = (worker: WorkerRow, pr: number, runId: string, outcome: "approved" | "rejected"): void => {
    try {
      if (state.runEventRecorded(ENGINE_REVIEW_VERDICT, worker.name, runId)) return;
      const wal = state.getEngineReviewWal(worker.name);
      if (!wal || wal.runId !== runId) {
        // The WAL update below is runId-guarded too and would be a no-op for this run — say so
        // rather than emitting a verdict event carrying a head this attempt cannot vouch for.
        log(`[sapwood:engine-review-verdict] lane ${worker.name} has no WAL row for run ${runId} — verdict event not emitted`);
        return;
      }
      const artifact = artifacts.get(wal.head);
      state.appendEvent(ENGINE_REVIEW_VERDICT, {
        worker: worker.name,
        issue: worker.issue,
        pr,
        head: wal.head,
        runId,
        outcome,
        // null, not 0: "this composition never saw the artifact" is not "the review found nothing"
        // (the same never-fabricate stance `treeManifestHash` takes when unobserved).
        findingCount: artifact ? artifact.findings.length : null,
        perAC: artifact ? countPerAcStatuses(artifact.perAC) : null,
      });
    } catch (err) {
      try {
        log(`[sapwood:engine-review-verdict] event append failed (non-fatal): ${String(err)}`);
      } catch {
        // A broken logger cannot turn observability into a gate either.
      }
    }
  };

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
        // #612: read BEFORE appendVerdictEvent flips this same marker — a same-process replay of
        // this exact runId (the crash shape appendVerdictEvent's own doc describes: the engine
        // died between the event append and the WAL write) must record the review session's
        // spend ONCE, not once per replay. spend_ledger has no runId column of its own to dedupe
        // against directly, so this reuses the SAME durable dedup memory the verdict event
        // already relies on.
        const spendAlreadyRecorded = state.runEventRecorded(ENGINE_REVIEW_VERDICT, worker.name, runId);
        appendVerdictEvent(worker, pr, runId, outcome);
        state.recordEngineReviewWalDecisiveOutcome(worker.name, runId, outcome);
        if (!spendAlreadyRecorded) {
          // #612: fold the review session's own cost into spend_ledger here — the ONE call site
          // where a WAL row becomes decisive, same rationale appendVerdictEvent's doc gives for
          // being the one place a verdict is born. Previously this spend lived ONLY inside
          // engine_review_wal.review_artifact_json.sessionSpends, invisible to
          // cost.roundBudgetUsd/dailyBudgetUsd and every ledger-based report.
          const walForSpend = state.getEngineReviewWal(worker.name);
          const artifactForSpend = walForSpend?.runId === runId ? artifacts.get(walForSpend.head) : undefined;
          if (artifactForSpend) {
            const usd = artifactForSpend.sessionSpends.reduce((sum, s) => sum + (s.kind === "unknown" ? 0 : s.usd), 0);
            const identity = artifactForSpend.sessionActualIdentities[0];
            state.recordSpend(reviewSpendWorkerKey(worker.name), worker.issue, usd, now().toISOString(), [
              {
                model: identity ? formatIdentity(identity) : "unknown",
                inputTokens: 0,
                outputTokens: 0,
                cacheCreationTokens: 0,
                cacheReadTokens: 0,
              },
            ]);
          }
        }
        try {
          const wal = state.getEngineReviewWal(worker.name);
          if (wal?.runId === runId && wal.decisiveOutcome === outcome && !state.getLiveEngineReviewHeads().includes(wal.head))
            deleteReviewTreesForHead(treeRoot, wal.head, log);
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
      // #502: read fresh per call, straight off the durable ledger — the pin the conductor's
      // per-tick base-CI observation left there. Never cached across ticks: a base that went green
      // must stop lanes reporting a base-inherited wait on their very next poll.
      getBaseRedPin: () => baseRedPin(state),
    };
  };

  return { reviewer, driveDepsForLane };
}
