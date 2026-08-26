// review/production.ts (#288) — the real config -> EngineAgentReviewer -> per-lane drive wiring.

import { createHash, randomUUID } from "node:crypto";
import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { SapwoodConfig } from "../config/config.js";
import { loadDoctrine } from "../config/doctrine.js";
import { defaultRuntimeRoot, runtimePaths } from "../config/paths.js";
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
 *  docs/reference/frontend-design.md §7 (every engine PR that adds a kind extends that map). */
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

/** Default gate②-tree materialization root — exported (mirrors materializer.ts's own
 *  `defaultPrivateCloneDir`/`defaultWorktreeRoot`) so the runtimePaths()-derived default is
 *  directly testable without constructing the full `makeProductionEngineAgent` wiring. */
export function defaultReviewTreeRoot(cwd: string = process.cwd()): string {
  return runtimePaths(defaultRuntimeRoot(cwd)).cacheReviewTreesDir;
}

/** Default codex-exec review session state dir — same rationale as defaultReviewTreeRoot above. */
export function defaultReviewCodexStateDir(cwd: string = process.cwd()): string {
  return runtimePaths(defaultRuntimeRoot(cwd)).sessionsReviewCodexDir;
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
  const treeRoot = options.reviewTreeRoot ?? defaultReviewTreeRoot(sourceRepoDir);
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
          stateDir: defaultReviewCodexStateDir(sourceRepoDir),
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
    doctrine: loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars),
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
      /** #489: the decisive gate② verdict, announced in the durable event stream. Under
       *  `reviewer.mode: engine-agent` the verdict used to live ONLY in the WAL + the PR audit
       *  comment, so a supervisor watching the event log saw a PR open and then merge with
       *  nothing in between — reconstructing gate② meant joining three sources by hand. Emitted
       *  from the ONE site where a WAL row gets its `decisive_outcome`, so there is no second
       *  place a verdict can be born.
       *
       *  #645 P1-1: the verdict event, the WAL `decisive_outcome` write, and (#612) the review
       *  session's own settled spend now land together in ONE sqlite transaction
       *  (`state.recordEngineReviewVerdictAndSpend` — see its own doc for the crash window this
       *  closes: the old two-write sequence appended the event FIRST, whose existence
       *  `runEventRecorded` reads as "already handled" on replay, then recorded the spend LAST —
       *  a crash between them left the verdict durably recorded with the spend permanently,
       *  silently missing). The pre-check below (`runEventRecorded`) is what makes a genuine
       *  REPEAT call (this exact runId, already fully committed by a prior call) a clean no-op:
       *  post-fix, that check can ONLY read true once the atomic transaction has actually
       *  committed everything, so there is no longer a state where it reads true with the spend
       *  still missing. */
      recordWalDecisiveOutcome: (runId, outcome) => {
        if (state.runEventRecorded(ENGINE_REVIEW_VERDICT, worker.name, runId)) return;
        const wal = state.getEngineReviewWal(worker.name);
        if (!wal || wal.runId !== runId) {
          // The WAL update is runId-guarded too and would be a no-op for this run — say so rather
          // than emitting a verdict event carrying a head this attempt cannot vouch for.
          log(`[sapwood:engine-review-verdict] lane ${worker.name} has no WAL row for run ${runId} — verdict event not emitted`);
          return;
        }
        const artifact = artifacts.get(wal.head);
        state.recordEngineReviewVerdictAndSpend(
          worker.name,
          runId,
          outcome,
          ENGINE_REVIEW_VERDICT,
          {
            worker: worker.name,
            issue: worker.issue,
            pr,
            head: wal.head,
            runId,
            outcome,
            // null, not 0: "this composition never saw the artifact" is not "the review found
            // nothing" (the same never-fabricate stance `treeManifestHash` takes when unobserved).
            findingCount: artifact ? artifact.findings.length : null,
            perAC: artifact ? countPerAcStatuses(artifact.perAC) : null,
          },
          // #612: fold the review session's own cost into spend_ledger atomically with the
          // verdict — the ONE engine-review write site, firing exactly once per decisive WAL row,
          // never per non-decisive attempt (the deliberate-absence posture #645 keeps). Omitted
          // (undefined) when this run's artifact was never captured — production.ts's own
          // never-fabricate stance, unchanged.
          artifact
            ? {
                worker: reviewSpendWorkerKey(worker.name),
                issue: worker.issue,
                // `usd` is already ReviewSessionSpend's `known`+`estimated` sum (audit.ts's own
                // known/estimated/unknown split).
                usd: artifact.sessionSpends.reduce((sum, s) => sum + (s.kind === "unknown" ? 0 : s.usd), 0),
                at: now().toISOString(),
                models: [
                  {
                    model: artifact.sessionActualIdentities[0] ? formatIdentity(artifact.sessionActualIdentities[0]) : "unknown",
                    inputTokens: 0,
                    outputTokens: 0,
                    cacheCreationTokens: 0,
                    cacheReadTokens: 0,
                  },
                ],
                actorKind: "engine-review",
                // true when ANY summed attempt came from the pinned-price estimator rather than a
                // real provider-reported total — the same "mixing in even one estimated attempt
                // makes the sum inexact" stance audit.ts's own subtotal-labelling doc already takes.
                estimated: artifact.sessionSpends.some((s) => s.kind === "estimated"),
              }
            : undefined,
        );
        try {
          const walAfter = state.getEngineReviewWal(worker.name);
          if (
            walAfter?.runId === runId &&
            walAfter.decisiveOutcome === outcome &&
            !state.getLiveEngineReviewHeads().includes(walAfter.head)
          )
            deleteReviewTreesForHead(treeRoot, walAfter.head, log);
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
