import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type BoardPlacement, type IForge, type OpenPrBody, referencedIssue } from "../forge/forge.js";
import { labelsInclude, labelsIncludeAny } from "../forge/labels.js";
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
 *  stronger fact than the marker was — whoever applied it, it is on the issue, and its future
 *  disappearance is a human act in every case but one. Correcting the marker on that evidence
 *  therefore restores exactly the intended contract, with removing the label as the ONLY manual
 *  step (#391 AC1).
 *
 *  The one exception (#441, F34), stated rather than left as a stale absolute: escalation-sweep.ts
 *  may remove `needs-human` when the ledger PROVES the engine applied it AND the escalation
 *  resolved by a `merged`/`issue-closed` witness (round.ts's `removeRoundPoolLabel` doc lists both
 *  authorized removal paths). Reentry firing off that removal costs exactly ONE
 *  `gated_reentry_attempts` slot — DRIVE re-derives the gate on reclaim, a merged/closed PR maps
 *  straight back to HUMAN, and the lane re-escalates and re-labels — which is the same bounded,
 *  cap-limited cost #400 already accepts for a human who clears the label too early.
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
  state: Pick<State, "unlabeledGatedWorkers" | "upsertWorkerWithEvent" | "appendEvent">,
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
    try {
      const meta = await forge.getIssueMeta(w.issue);
      if (!cfg.escalation.humanLabels.some((label) => labelsInclude(meta.labels, label))) {
        state.appendEvent("gated-flag-unprovable", { worker: w.name, issue: w.issue, pr: w.pr ?? null });
        continue;
      }
      handGatedLaneToReentry(state, w);
    } catch (error) {
      // Per-lane containment, same shape as escalation-reconcile.ts's own sweep: a read failure
      // leaves this lane exactly as it was and the next startup re-audits it.
      log(`[sapwood:reconcile] gated-flag audit of ${w.name} (#${w.issue}) failed; continuing: ${String(error)}`);
    }
  }
}

/** #391 F19's per-lane heal, shared with #447's revival pass below (PR #463 gate② P1): record
 *  that this lane's escalation label is observably present, which is the ONLY thing standing
 *  between it and gated reentry. Extracted rather than duplicated so the two callers can never
 *  drift — one heal, one event kind, one owner. Both writes land together (see
 *  State.upsertWorkerWithEvent): a marker corrected with no `gated-flag-healed` in the ledger
 *  would silently move a lane between owners. */
function handGatedLaneToReentry(state: Pick<State, "upsertWorkerWithEvent">, w: WorkerRow): void {
  // #398: the carrier is "issue" because that is what this heal OBSERVED — the audit's own
  // evidence is a human-hold label found on the ISSUE (`getIssueLabels`, below), so the carrier
  // recorded here must be the object the audit actually looked at. Stated rather than left to
  // the column default: these rows reach the audit with `gated_escalation_labeled = 0`, which can
  // mean an escalation whose PR-side label write FAILED — leaving a stale "pr" carrier standing
  // would make GATED RECLAIM re-check the PR for a hold the audit proved is on the issue.
  state.upsertWorkerWithEvent({ ...w, gated_escalation_labeled: 1, gated_escalation_carrier: "issue" }, "gated-flag-healed", {
    worker: w.name,
    issue: w.issue,
    pr: w.pr ?? null,
  });
}

export type LaneRevivalForge = Pick<IForge, "getIssueLabels" | "getPRStatus">;

/** The three ONE-WAY facts the revival pass reads back out of the ledger to decide a lane
 *  WITHOUT touching the forge: the environment failure that is its entire remit, #397's
 *  bucket-2 verdict, and its own observation that the PR was merged. All three payloads carry
 *  `worker` + `pr`, which is what makes `laneEventRecorded` able to answer them per lane.
 *  `lane-revival-terminal` is recorded for MERGED ONLY — see the function doc. */
const ENV_FAILURE_PRESERVED_EVENT = "env-failure-preserved";
const HUMAN_MERGE_ONLY_EVENT = "drive-human-merge-only";
const REVIVAL_TERMINAL_EVENT = "lane-revival-terminal";

/** #447 (F28 residual): return an env-failed lane that still holds an OPEN PR to `driving`.
 *  This class sits exactly between the two designed owners and was reachable by NEITHER:
 *  `healOrphanedIssues` above heals PR-LESS orphans only (a PR-bearing lane is deferred to the
 *  gated path by design), and gated reentry owns only lanes an escalation LABELLED — an
 *  env-failure never labels (conductor.ts's env-failure-preserved branch makes ZERO forge
 *  writes: the forge may be the very thing that is down), so there is no label whose removal
 *  could fire reentry and `auditGatedEscalationFlags` above cannot prove a marker nobody set.
 *  Four live occurrences each ended in a manual `UPDATE workers SET state='driving'`.
 *
 *  The candidate set is `unlabeledGatedWorkers()` — already the exact complement of
 *  `gatedFailedWorkers()`, so consuming it here creates no second owner for an escalated lane
 *  and needs no new column or table. The row SHAPE alone is not enough to act on, though —
 *  three different settlements produce `failed` + PR + marker 0 — so the split below is decided
 *  by EVIDENCE, LOCAL evidence first, so a lane this pass will never act on costs zero forge
 *  reads per tick rather than two:
 *
 *   1. no `env-failure-preserved` on record for this (worker, pr) -> NOT THIS PASS'S LANE (PR
 *      #463 round 2, P1). The set also holds ordinary gate escalations whose `needs-human`
 *      WRITE failed, which land in the same shape and are deliberately fail-closed: #147's
 *      "manual drive as before" contract, pinned by conductor.test.ts's own #147 P2 test.
 *      Reviving one would resume autonomous driving — review and merge — of a PR a human was
 *      supposed to look at, with no human act, no `gated_reentry_attempts`, no fresh-review
 *      filter, and would clear its still-valid attention item on the way. Requiring the
 *      environment failure's own durable record inverts that: revival acts only where it has
 *      POSITIVE proof of the fault it exists to recover from.
 *      Accepted, bounded compound case: a lane that escalated with a failed label write and was
 *      LATER killed by an environment failure carries both records and does revive. That is the
 *      honest reading of the evidence (the last thing that happened to it was an env kill), and
 *      it is safe because DRIVE re-derives every durable HUMAN condition from live PR state on
 *      the next tick and re-escalates — this time with a label write that can succeed.
 *   2. the lane's PR already settled as #397 bucket 2 -> LEAVE IT. "A human must MERGE this PR"
 *      settles to the SAME shape (and deliberately nothing on the issue); the durable verdict is
 *      what tells them apart. This branch must never be re-driven at all: #397 closed that
 *      reclaim loop structurally and re-driving would re-escalate it every tick. Reachable only
 *      via the compound case above (a bucket-2 settle after an env kill), which is exactly why
 *      it is still checked.
 *   3. the PR was already observed MERGED by an earlier pass -> LEAVE IT, without asking the
 *      forge again (`lane-revival-terminal`). MERGED ONLY: a merge is irreversible, so the
 *      observation is one-way, but GitHub reopens an unmerged CLOSED PR — the same asymmetry
 *      escalation-reconcile.ts's own terminal fold encodes. A CLOSED PR is therefore skipped
 *      WITHOUT being remembered, keeping its one read per pass; honest, rare, and bounded, and
 *      the lane revives by itself if a human reopens the PR.
 *   4. the issue carries ANY of cfg.escalation.humanLabels -> HAND IT TO GATED REENTRY. Not a
 *      bare skip (PR #463 round 1, P1): a bare skip left the lane in this pass's candidate set,
 *      so the moment the human removed the label mid-run, revival — not gated reentry — picked
 *      it up, re-driving with the old trigger pin and `gated_reentry_attempts` still 0, i.e.
 *      with the stale-review filter that makes label removal safe never armed. Correcting the
 *      marker instead is F19's own heal on F19's own evidence (the hold is observably present,
 *      and the engine never removes a human-hold label), and it is ONE-WAY: the row leaves
 *      `unlabeledGatedWorkers()` for good, so the label's later removal reaches exactly one
 *      owner. (Hold set = the FULL cfg.escalation.humanLabels, the same predicate GATED RECLAIM
 *      applies via conductor.ts's hasReserveLabel — not needs-human alone.)
 *   5. the PR is MERGED/CLOSED -> leave the lane to the existing terminal paths (recording only
 *      the MERGED case, per 3). Revival is for LIVE work only.
 *   6. otherwise -> `driving`, and the DRIVE loop re-derives everything else from live PR state,
 *      which is exactly what the manual surgery relied on.
 *
 *  Deliberately writes ONE column. `fix_rounds`, the preserved worktree, the PR number and
 *  `ended_at` (the honest instant the env-failed leg ended — this transition starts no leg, so
 *  restamping it would be a lie and would need a clock this pass otherwise has no use for) are
 *  all left exactly as the failure left them.
 *
 *  AN OPEN PARK EPISODE SUSPENDS THE WHOLE PASS. While the engine is parked the environment is
 *  still the thing that killed these lanes, and DRIVE would act on anything returned to
 *  `driving`. The check lives HERE rather than at each call site (PR #463 round 2, P1) so it
 *  cannot be forgotten by one: the episode is durable in the DB, so a restart mid-park reads
 *  the same open episode the tick does, and startup — which used to call this unconditionally —
 *  now waits for the resume exactly like the tick.
 *
 *  Every forge call is a READ (this pass never writes to the forge — the lane's issue and PR
 *  are left exactly as a human left them). Callers still own ORDERING: startup runs this after
 *  the F19 audit, so a lane whose hold the audit already healed is out of the candidate set
 *  before this pass looks. */
export async function reviveEnvFailedPrLanes(
  forge: LaneRevivalForge,
  state: Pick<State, "isParked" | "unlabeledGatedWorkers" | "laneEventRecorded" | "upsertWorkerWithEvent" | "appendEvent">,
  cfg: { escalation: { humanLabels: string[] } },
  log: (message: string) => void = console.error,
): Promise<string[]> {
  let candidates: WorkerRow[];
  try {
    if (state.isParked()) return [];
    candidates = state.unlabeledGatedWorkers();
  } catch (error) {
    log(`[sapwood:reconcile] lane revival could not read the worker table; skipped: ${String(error)}`);
    return [];
  }
  const revived: string[] = [];
  for (const w of candidates) {
    if (w.pr == null) continue; // fail-safe; unlabeledGatedWorkers() already filters this
    const pr = w.pr;
    try {
      if (!state.laneEventRecorded(ENV_FAILURE_PRESERVED_EVENT, w.name, pr)) continue;
      if (state.laneEventRecorded(HUMAN_MERGE_ONLY_EVENT, w.name, pr)) continue;
      if (state.laneEventRecorded(REVIVAL_TERMINAL_EVENT, w.name, pr)) continue;
      if (labelsIncludeAny(await forge.getIssueLabels(w.issue), cfg.escalation.humanLabels)) {
        handGatedLaneToReentry(state, w);
        continue;
      }
      const prState = (await forge.getPRStatus(pr)).state;
      if (prState !== "OPEN") {
        // MERGED only: a merge is irreversible, a CLOSED PR reopens (branch 3 above).
        if (prState === "MERGED") state.appendEvent(REVIVAL_TERMINAL_EVENT, { worker: w.name, issue: w.issue, pr, prState });
        continue;
      }
      state.upsertWorkerWithEvent({ ...w, state: "driving" }, "lane-revived", { worker: w.name, issue: w.issue, pr });
      revived.push(w.name);
    } catch (error) {
      // Per-lane containment, same stance as the gated-flag audit above. Every write this loop
      // makes is a single atomic statement or one transaction, so a throw anywhere leaves this
      // lane exactly as the pass found it and the next pass (startup or park-resume) retries it.
      log(`[sapwood:reconcile] lane revival of ${w.name} (#${w.issue}, PR #${pr}) failed; continuing: ${String(error)}`);
    }
  }
  return revived;
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
