import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type BoardPlacement, findLaneOwnedPr, hasPrOwnerMarker, type IForge, type OpenPrBody, referencedIssue } from "../forge/forge.js";
import { labelsIncludeAny } from "../forge/labels.js";
import type { EscalationCarrier, State, WorkerRow } from "../state/state.js";
import { escalateToNeedsHuman } from "./escalation-writer.js";

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
 *  #593: BUT a no-hold reading is not automatically ambiguous — it is exactly the shape a hold
 *  leaves once the human act it was waiting for has already happened OUTSIDE the engine (an
 *  owner/PM merge, a hand-close). Before alarming, this audit checks the SAME two terminal
 *  witnesses escalation-sweep.ts's `SWEEPABLE_VIA` already treats as authorizing (#441/F34):
 *  `merged` (a merge is a reviewer/merger act by construction, guard.ts blocks producer merges)
 *  and `issue-closed` (`gh issue close` is blocked for producers too, #353). Either one means a
 *  human already moved this lane — retiring it with `gated-lane-retired` is not a new judgment,
 *  it is recognizing a fact the ledger already trusts elsewhere. The genuinely ambiguous LIVE
 *  case — no hold, no terminal witness, nothing to point to — still alarms, unchanged: that arm
 *  is load-bearing and this issue does not widen it.
 *
 *  #398 — BOTH CARRIERS, because the evidence can now live on either (this is the issue's own
 *  "make its audit carrier-agnostic" requirement, #391 already being in the tree). The residue
 *  class this function exists to recover is "the label write landed on GitHub but the local flag
 *  never committed", and since #398 routes a PR-bearing lane's `needs-human` onto the PR, most of
 *  those rows now carry their proof there. An issue-only read would call them unprovable and
 *  leave them permanently invisible to every read path — failing safe, but silently deleting the
 *  recovery #391 was built to provide. Reading both is not a breach of "one carrier, never both":
 *  that rule governs WRITES, and this is precisely the case where the engine does not know what
 *  its own interrupted attempt managed to do. The heal records the SINGLE carrier the hold was
 *  actually found on, so the handshake downstream is single-carrier again.
 *
 *  Read-only against the forge: one `getIssueMeta` per candidate, plus one `getPRLabels` ONLY for
 *  a PR-bearing candidate whose issue came back clean; the candidate set is the number of lanes
 *  stuck in this residue state, which is small by construction. */
export async function auditGatedEscalationFlags(
  forge: Pick<IForge, "getIssueMeta" | "getPRLabels" | "getPRStatus">,
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
      if (meta.state === "CLOSED") {
        retireGatedLane(state, w, "issue-closed");
        continue;
      }
      const carrier = await observeHoldCarrier(forge, cfg, w, meta.labels);
      if (carrier === null) {
        // #593: one extra read, spent only here — the candidate set is already small, and this
        // is the one place per candidate where the read-budget doc allows it (see this
        // function's own doc). `unlabeledGatedWorkers()` guarantees `pr` is non-null; the guard
        // is fail-safe defense, same stance as `reviveEnvFailedPrLanes`'s identical check.
        if (w.pr != null && (await forge.getPRStatus(w.pr)).state === "MERGED") {
          retireGatedLane(state, w, "merged");
          continue;
        }
        state.appendEvent("gated-flag-unprovable", { worker: w.name, issue: w.issue, pr: w.pr ?? null });
        continue;
      }
      handGatedLaneToReentry(state, w, carrier);
    } catch (error) {
      // Per-lane containment, same shape as escalation-reconcile.ts's own sweep: a read failure
      // leaves this lane exactly as it was and the next startup re-audits it.
      log(`[sapwood:reconcile] gated-flag audit of ${w.name} (#${w.issue}) failed; continuing: ${String(error)}`);
    }
  }
}

/** #398: WHICH object currently carries a human hold for this lane — `null` if neither does.
 *  Shared by the #391 gated-flag audit and #447's revival fence so the two can never disagree
 *  about where a hold counts, the same one-owner discipline `handGatedLaneToReentry` itself has.
 *
 *  ORDER IS LOAD-BEARING, in two ways. The issue is checked first from labels the caller ALREADY
 *  fetched, so a lane whose issue answers costs no second forge call at all — the PR read is a
 *  fallback, not an addition. And when BOTH objects carry a hold, "issue" is the fail-safe
 *  answer: healing to the issue means clearing the ISSUE reclaims the lane, whereupon DRIVE's own
 *  `deriveGate` reads the PR's still-standing hold and re-escalates — one bounded reentry attempt,
 *  self-correcting. Healing to the PR instead would let a lane whose issue still says `blocked`
 *  drive on with nothing left to stop it.
 *
 *  A PR read that THROWS propagates to the caller's own per-lane containment (it must not be
 *  swallowed into a `null`): unreadable is not the same fact as "no hold present", and reporting
 *  the latter would emit a false `gated-flag-unprovable` alarm for a lane the next start could
 *  have healed. */
async function observeHoldCarrier(
  forge: Pick<IForge, "getPRLabels">,
  cfg: { escalation: { humanLabels: string[] } },
  w: WorkerRow,
  issueLabels: string[],
): Promise<EscalationCarrier | null> {
  if (labelsIncludeAny(issueLabels, cfg.escalation.humanLabels)) return "issue";
  if (w.pr == null) return null;
  return labelsIncludeAny(await forge.getPRLabels(w.pr), cfg.escalation.humanLabels) ? "pr" : null;
}

/** #391 F19's per-lane heal, shared with #447's revival pass below (PR #463 gate② P1): record
 *  that this lane's escalation label is observably present, which is the ONLY thing standing
 *  between it and gated reentry. Extracted rather than duplicated so the two callers can never
 *  drift — one heal, one event kind, one owner. Both writes land together (see
 *  State.upsertWorkerWithEvent): a marker corrected with no `gated-flag-healed` in the ledger
 *  would silently move a lane between owners.
 *
 *  #398: `carrier` is the object the caller's own `observeHoldCarrier` actually FOUND the hold on
 *  — never assumed. Recording it explicitly (rather than leaning on the column default) matters
 *  because these rows arrive with `gated_escalation_labeled = 0`, which can mean an escalation
 *  whose PR-side write failed: a stale carrier left standing would send GATED RECLAIM to look for
 *  a hold on the object this audit just proved does NOT have one. */
function handGatedLaneToReentry(state: Pick<State, "upsertWorkerWithEvent">, w: WorkerRow, carrier: EscalationCarrier): void {
  state.upsertWorkerWithEvent({ ...w, gated_escalation_labeled: 1, gated_escalation_carrier: carrier }, "gated-flag-healed", {
    worker: w.name,
    issue: w.issue,
    pr: w.pr ?? null,
    // #398: WHICH object the hold was found on rides in the receipt too — an operator reading the
    // ledger to answer "what do I have to clear to release this lane?" gets the answer from the
    // heal itself, not by inferring it from the row's shape.
    carrier,
  });
}

/** #593: retire a gated lane the audit has just PROVEN terminal by one of the two authorizing
 *  witnesses escalation-sweep.ts already recognizes (#441/F34) — a merge or an issue close, both
 *  acts a producer cannot perform itself. Sets the SAME one-way latch `gated_reentry_capped`
 *  uses everywhere else in this file (conductor.ts's `gated-reentry-issue-closed` is the sibling
 *  write): `unlabeledGatedWorkers()`'s query requires it at 0, so a retired row leaves this
 *  audit's own candidate set for good and `gated-flag-unprovable` never fires for it again. This
 *  is not gated reentry (`handGatedLaneToReentry` above) — that path exists for a LIVE hold a
 *  human can still remove; a merged/closed lane has nothing left to reenter, so retiring here
 *  never drives it. */
function retireGatedLane(state: Pick<State, "upsertWorkerWithEvent">, w: WorkerRow, witness: "merged" | "issue-closed"): void {
  state.upsertWorkerWithEvent({ ...w, gated_reentry_capped: 1 }, "gated-lane-retired", {
    worker: w.name,
    issue: w.issue,
    pr: w.pr ?? null,
    witness,
  });
}

export type LaneRevivalForge = Pick<IForge, "getIssueLabels" | "getPRLabels" | "getPRStatus">;

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
      // #398: the same both-carriers observation the gated-flag audit makes, through the same
      // helper — a human holding this lane may well have put the label on the PR, and revival
      // must see that hold wherever it sits. Less severe than the audit's own miss (a wrongly
      // revived lane meets deriveGate's PR-label veto on the very next DRIVE tick and escalates),
      // but there is no reason for the two fences to disagree about where a hold counts.
      const holdCarrier = await observeHoldCarrier(forge, cfg, w, await forge.getIssueLabels(w.issue));
      if (holdCarrier !== null) {
        handGatedLaneToReentry(state, w, holdCarrier);
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

/** #384 (F12): the escalation this sweep raises — registered in escalation-reconcile.ts's
 *  `ESCALATION_SOURCES` as `payload` proof, so a merge/close of the orphan PR, a closure of its
 *  issue, or a human removing the hold resolves it exactly like every other issue-carried
 *  escalation, with no second reconciliation path. */
export const ORPHAN_PR_ESCALATED = "orphan-pr-escalated";
/** The one-way per-lane latch: this terminal, PR-less lane HAS been asked "is there an engine PR
 *  out there with your name on it?" — recorded whichever way the answer came out, so the sweep
 *  costs at most ONE forge read per dead lane for the life of the repo, never one per tick. */
const ORPHAN_SWEEP_CHECKED = "orphan-sweep-checked";

/** What the mid-run sweep found: an OPEN PR a dead lane left behind, and HOW it was matched —
 *  `marker` is the engine's own structural owner stamp, `prose` the narrow closing-keyword
 *  fallback below. The distinction rides in the event so a reviewer of the ledger can tell an
 *  authoritative match from an inferred one without re-deriving it. */
export interface MidRunOrphan {
  pr: number;
  issue: number;
  worker: string;
  via: "marker" | "prose";
}

/** THE ORPHAN PR THIS DEAD LANE LEFT BEHIND, or null. Two tiers, structured signal first:
 *
 *  1. `findLaneOwnedPr` — the ENGINE-AUTHORED `sapwood:pr-owner` marker naming this exact lane
 *     and issue (#377). Authoritative, unambiguous, and the only signal the association path
 *     itself will act on.
 *  2. FALLBACK, and deliberately narrow: an open PR with NO owner marker at all whose body
 *     closes/references THIS candidate's issue and no other (`referencedIssue`), and which is the
 *     ONLY such PR. This tier is not decoration — it is the only tier that can see the live F12
 *     case at all. The residue exists precisely BECAUSE the association failed (an inconclusive
 *     forge write during the quota storm, a branch already gone, an unwired lane-PR surface), and
 *     a failed association is exactly the state in which no marker was ever stamped: PR #365
 *     carried none, which is why startup's own prose match (`diffStartupOrphans`) was the thing
 *     that eventually found it. A marker-only sweep would be honest and useless here.
 *
 *  Which failure direction the fallback favours, stated rather than left for the reviewer to
 *  discover: it can produce a FALSE POSITIVE — a PR someone else wrote whose body says "closes
 *  #207" while lane-207 happens to be dead. That costs one `needs-human` label on the issue,
 *  visible, removable, and arguably the right answer anyway (a second producer must not be
 *  dispatched at an issue that already has an open PR). The FALSE NEGATIVE it trades against is
 *  the bug this issue exists to fix: an unowned PR nobody sees for the remainder of the run,
 *  while its issue is re-dispatched behind it. The fallback is narrowed three ways so the
 *  positive direction stays small: it is asked only about the ISSUES OF LANES ALREADY KNOWN
 *  DEAD (never the whole open-PR list), it refuses any body carrying an owner marker at all
 *  (`hasPrOwnerMarker` — that PR's ownership is the marker's business, including the ambiguous
 *  two-disagreeing-markers case), and two prose matches for one issue read as ambiguous, not as
 *  a pick. */
function laneOrphanPr(openPrs: readonly OpenPrBody[], w: WorkerRow): { pr: number; via: "marker" | "prose" } | null {
  const marked = findLaneOwnedPr(openPrs, w.name, w.issue);
  if (marked !== null) return { pr: marked, via: "marker" };
  const claimed = openPrs.filter((pr) => !hasPrOwnerMarker(pr.body) && referencedIssue(pr.body) === w.issue);
  return claimed.length === 1 ? { pr: claimed[0]!.number, via: "prose" } : null;
}

/** The forge surface the mid-run sweep needs. `listOpenPrBodies` is DUCK-TYPED (optional) for the
 *  same reason cli.ts's `buildLanePrAssociator` duck-types the rest of `LanePrForge`: it is a
 *  `GithubForge` method that is deliberately not part of the narrower `IForge` every test double
 *  implements. Production always has it; a bare-`IForge` double degrades to a no-op sweep. */
export type OrphanSweepForge = Pick<IForge, "addLabel" | "getIssueComments" | "addIssueComment"> &
  Partial<Pick<GithubOpenPrReader, "listOpenPrBodies">>;

interface GithubOpenPrReader {
  listOpenPrBodies(): Promise<OpenPrBody[]>;
}

/** #384 (F12): notice an open engine PR whose lane is dead MID-RUN, instead of only at the next
 *  startup reconcile.
 *
 *  The live case (dogfood run 2026-07-24): lane #207 died, `reclaimTerminalLane` saw no PR on the
 *  probe, so the issue was requeued to Ready and the lane settled `failed` with a NULL `pr` — but
 *  the worker had ALREADY pushed and opened PR #365. `diffStartupOrphans` above would have caught
 *  it, except it runs exactly once, at startup: nothing re-scanned, the PR sat unowned for the
 *  whole run, and the issue was free to be re-dispatched behind it (duplicate work).
 *
 *  WHY THIS IS NOT A PER-TICK BOARD SCAN. The candidate set is LOCAL and small: terminal lanes
 *  with no PR on record (`terminalPrlessWorkers`), each latched after its single check. In the
 *  steady state — and in every tick where nothing died — the pass makes ZERO forge calls and
 *  returns before it asks for anything. When a lane does die, ONE bounded `gh pr list` answers for
 *  every candidate in that pass. Detection is therefore within ONE tick of the death, which is
 *  what "bounded number of ticks" costs here.
 *
 *  WHAT COUNTS AS "THIS LANE'S PR": the engine's own owner marker first, a deliberately narrow
 *  prose fallback second — see `laneOrphanPr` below, which also names which failure direction
 *  that fallback trades toward and why it cannot simply be dropped.
 *
 *  A CANDIDATE WHOSE ISSUE A LIVE LANE OWNS IS NOT SWEPT AT ALL (and is not latched either — it
 *  becomes a candidate again once that lane settles). After a dead lane's issue is requeued, a
 *  FRESH lane may be working it, and that lane's own not-yet-associated PR would prose-match the
 *  DEAD lane's issue perfectly. Holding the issue then would fence off live, healthy work on the
 *  strength of an inferred match — the one false positive worth spending a local DB read to avoid.
 *
 *  DISPOSITION: needs-human on the ISSUE, via the shared writer, with the PR in the payload.
 *  Holding the issue is what closes the duplicate-work risk (`isPoolEligible` excludes held
 *  issues), and the payload's `pr` is what lets escalation-reconcile resolve the item when the
 *  orphan PR is merged or closed. Deliberately NOT auto-adoption into `driving`: the engine adopts
 *  a dead lane's PR only where it can prove the worktree was clean (reclaimTerminalLane's
 *  `rescued` branch), and this pass — reached precisely because the lane's PR was NEVER
 *  associated — has no such proof. Auto-driving possibly-incomplete work toward merge is the one
 *  mistake here that a human cannot undo; the hold is the one they can.
 *
 *  AN OPEN PARK EPISODE SUSPENDS THE PASS, on the pass's own authority (the same one-owner
 *  placement `reviveEnvFailedPrLanes` uses): under a FORGE park the forge is the thing that is
 *  down, and under an LLM park the delay costs only detection latency that the resume pays back.
 *
 *  Crash-rerun: the latch is written AFTER the escalation, so a kill in between re-checks the
 *  same lane next tick and re-runs an idempotent label write. A forge read that throws latches
 *  NOTHING — the lane keeps its place in the candidate set. */
export async function sweepMidRunOrphanPrs(
  forge: OrphanSweepForge,
  state: Pick<State, "isParked" | "terminalPrlessWorkers" | "reconcileWorkers" | "ownedPrNumbers" | "latestLaneEventKind" | "appendEvent">,
  cfg: { labels: { needsHuman: string } },
  log: (message: string) => void = console.error,
): Promise<MidRunOrphan[]> {
  const listOpenPrBodies = forge.listOpenPrBodies?.bind(forge);
  if (listOpenPrBodies === undefined) return [];
  let candidates: WorkerRow[];
  let ownedPrs: Set<number>;
  try {
    if (state.isParked()) return [];
    // The same owning set startup reconciliation calls an owner (running/driving/fixing/handoff).
    const live = new Set(state.reconcileWorkers().map((w) => w.issue));
    ownedPrs = new Set(state.ownedPrNumbers());
    candidates = state
      .terminalPrlessWorkers()
      .filter((w) => !live.has(w.issue) && state.latestLaneEventKind([ORPHAN_SWEEP_CHECKED], w.name, w.issue) === null);
  } catch (error) {
    log(`[sapwood:reconcile] mid-run orphan sweep could not read the worker table; skipped: ${String(error)}`);
    return [];
  }
  if (candidates.length === 0) return [];
  let openPrs: OpenPrBody[];
  try {
    openPrs = await listOpenPrBodies();
  } catch (error) {
    log(`[sapwood:reconcile] mid-run orphan sweep could not list open PRs; retrying next tick: ${String(error)}`);
    return [];
  }
  // A PR some worker row already holds is nobody's orphan (`ownedPrNumbers` — a driving lane's,
  // a gated-reentry lane's, a merged lane's), and one lane's orphan is not also the next lane's:
  // two dead lanes on the same requeued issue must not raise the same attention item twice.
  const unowned = openPrs.filter((pr) => !ownedPrs.has(pr.number));
  const claimedThisPass = new Set<number>();
  const orphans: MidRunOrphan[] = [];
  for (const w of candidates) {
    const found = laneOrphanPr(
      unowned.filter((pr) => !claimedThisPass.has(pr.number)),
      w,
    );
    if (found !== null) {
      const { pr, via } = found;
      state.appendEvent("orphan-detected", {
        kind: "pr",
        pr,
        issue: w.issue,
        reason: "open-engine-pr",
        worker: w.name,
        midRun: true,
        via,
      });
      await escalateToNeedsHuman(
        forge,
        state,
        cfg,
        w.issue,
        ORPHAN_PR_ESCALATED,
        { pr, worker: w.name, via },
        // #655: reason visibility — the label write outcome/terminal event are unaffected by a
        // failed comment (escalateToNeedsHuman's own doc).
        `sapwood: PR #${pr} is open but this issue's lane (${w.name}) is dead (${via}) — held for a human rather than left for the ` +
          `next requeue to duplicate the work. Remove \`${cfg.labels.needsHuman}\` from this issue once resolved to retry (#147 gated reentry).`,
      );
      orphans.push({ pr, issue: w.issue, worker: w.name, via });
      claimedThisPass.add(pr);
      log(`[sapwood:reconcile] PR #${pr} is open but its lane ${w.name} (#${w.issue}) is dead (${via}) — issue held for a human.`);
    }
    state.appendEvent(ORPHAN_SWEEP_CHECKED, { worker: w.name, issue: w.issue, pr: found?.pr ?? null });
  }
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
