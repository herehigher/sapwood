// escalation-reconcile.ts (#295): the escalation-resolution reconciler — the durable answer to
// "is this needs-human escalation STILL waiting on a person?", observed from external forge
// state rather than from whether the engine happened to re-dispatch the lane.
//
// Why this exists (issue #295 / the 2026-07-21 design audit): the v0.2 dashboard's
// needs-attention strip rests on one contract — EMPTY STRIP = NOTHING IS WAITING ON A HUMAN
// (frontend-design.md §3). That contract could not hold, because most escalation classes had no
// clearing path at all:
//   - permanent latch, never clears: `gated-reentry-capped` (the one-way latch excludes the row
//     from EVERY read path — gatedFailedWorkers() requires `gated_reentry_capped = 0` — so a
//     hand-merged PR stays invisible forever), merged-path `rollback-escalated` (its retry
//     candidate is deleted BEFORE the alarm fires — conductor.ts's handleRollbackFailure clears
//     the pending row, then labels, then appends), `drive-needs-human` with `labeled: 0`
//     (permanently invisible to GATED RECLAIM, which requires `gated_escalation_labeled = 1`).
//   - `dispatched`-or-nothing: `resume-capped`, `resume-undecidable`, `ceiling-escalated`,
//     `env-failure-preserved`, `drive-no-pr`. If the human resolves the work OUTSIDE the loop
//     (merges by hand, closes the issue), the engine never notices.
// One zombie row trains the operator to ignore the whole strip, which costs more than the strip
// is worth. This module is the fix, and it is deliberately the SAME PARADIGM the dissent loop
// already ships (dissent.ts's `scanForAdjudication`): read external GitHub truth once per round,
// append a TRANSITION-ONLY event, never write to the forge and never touch the escalation
// machinery itself.
//
// STRUCTURALLY READ-ONLY (#295 AC3): the only IForge calls in this file are `getPRStatus` and
// `getIssueMeta`. There is no addLabel/removeLabel/setBoardStatus/mergePR/comment call site
// anywhere below, and nothing this module computes feeds a write path — the `escalation-resolved`
// event is a RECORD for the dashboard fold, never a gate. Existing escalation and gating
// behavior is byte-identical with this module present or absent.
//
// EXACTLY ONCE, WITHOUT A NEW LATCH COLUMN. The dedupe is a LAST-EVENT-WINS fold over the ledger
// itself (`openEscalations` below): per `(source, issue)` key, the key is open iff the newest
// event for it is an escalation rather than a resolution. That choice — rather than a "resolved"
// set or a new `escalation_resolved` column — is what makes RE-escalation work: an issue that
// escalates, gets resolved by a human, and escalates AGAIN is genuinely open a second time, and
// a one-way set would leave that second row stuck on the strip forever (exactly the bug this
// module exists to kill). The append IS the latch, so a `kill -9` strictly between the
// observation and the append leaves NOTHING durable: the rerun simply re-observes and appends
// once (#295 AC2).
//
// gate② round 2: last-event-wins REPLACED an earlier escalations-minus-resolutions COUNT fold,
// which was wrong for repeat-emitting kinds. `gated-reentry-capped-label-failed` is a
// retry-until-success stream — conductor.ts's GATED RECLAIM deliberately re-enters that branch
// every tick until the label lands — so N emissions describe ONE thing waiting on a human, and a
// counting fold would have demanded N separate resolutions to clear a single strip row. The
// deliberate trade this accepts: if the engine keeps re-emitting an escalation for something the
// outside world has ALREADY settled (only reachable when label writes are failing every tick
// against an externally-merged PR), each round re-opens and re-resolves it, one event per round.
// That is noisy but honest — it is an accurate description of a broken forge — and it is
// strictly preferable to suppressing re-opens after a terminal `merged`/`closed`, which would
// resurrect the permanent-zombie bug the moment a closed issue is reopened and re-escalates.
//
// LABEL ABSENCE IS ONLY A HUMAN ACT IF THE ENGINE PROVABLY APPLIED THE LABEL. This is the one
// non-obvious rule here, and it is this codebase's OWN existing doctrine (see state.ts's
// `gatedFailedWorkers` doc on `gated_escalation_labeled`: "label absence is only a human act if
// the engine provably applied the label"). Without it this module would produce FALSE CLEARS,
// which are strictly worse than the zombie rows it removes: for an escalation whose `addLabel`
// failed, the label is missing IMMEDIATELY, so the very first sweep would report "a human
// resolved this" about work nobody has looked at. So `label-removed` fires only for the kinds
// where the event's own existence proves the label landed:
//   - label-first-or-no-event (`gated-reentry-capped`, `resume-capped`, `resume-undecidable`
//     each `continue` past the append on a label failure, emitting a `*-label-failed` sibling
//     instead; `drive-no-pr` awaits an UNGUARDED addLabel before its append, so a throw
//     propagates and the event never lands) -> proven.
//   - `drive-needs-human` -> proven IFF its own payload says so (`labeled: 1`); it is the one
//     kind that records the outcome, and its `labeled: 0` case is precisely the invisible class
//     named above.
//   - best-effort, never-labels, or label-FAILED (`ceiling-escalated` and `rollback-escalated`
//     both `.catch(() => {})` the addLabel; `env-failure-preserved` applies NO label at all, by
//     #168 contract; `gated-reentry-capped-label-failed` IS the label failure) -> NOT proven.
//     These clear via issue-closed / PR-merged-or-closed only, which is still strictly more
//     clearing than the zero paths they have today.
//
// ponytail: no `via: "board-fixed"` observation, though issue #295's sketch names one. Tracing
// the classes above, NONE of them is signalled by a board column — escalation in this engine is
// label-and-event based, and board drift has its own separate `board-normalized` path. Adding it
// would mean a whole-board read every round to service a resolution nothing can currently
// produce, i.e. an unreachable enum arm. Upgrade path if a board-signalled escalation class ever
// lands: one `readStartupReconcileData()` placement read per sweep (board-wide, NOT per-issue)
// feeding a fourth arm in `observeResolution` below.
//
// Cost (the issue left "per tick or per round" to the implementer): per ROUND, wired next to
// `scanForAdjudication` in round-defaults.ts's aligning wrapper — the same unconditional
// round-level home, for the same reason (it must run regardless of which optional roles are
// enabled). A RESOLVED escalation costs ZERO forge calls forever after (the fold drops it before
// any observation); only genuinely-open escalations cost anything, at most 2 read-only calls
// each per round. That bound is the number of things actually waiting on a human, which is small
// by construction — if it is not, the operator has a much louder problem than this sweep's cost.
import type { SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import type { State } from "../state/state.js";

/** How each escalation kind proves it actually applied the needs-human label — see the module
 *  doc's "label absence" note for why this table exists and what a wrong entry would cost.
 *  `always`: the event cannot exist unless the label landed. `payload`: the event records the
 *  outcome itself (`labeled`). `never`: best-effort or no label at all — label absence proves
 *  nothing, so these resolve only by closure/merge. */
const ESCALATION_SOURCES: Record<string, "always" | "payload" | "never"> = {
  "gated-reentry-capped": "always",
  "resume-capped": "always",
  "resume-undecidable": "always",
  "drive-no-pr": "always",
  "drive-needs-human": "payload",
  "ceiling-escalated": "never",
  "rollback-escalated": "never",
  "env-failure-preserved": "never",
  // gate② round 2: the capped branch's own label FAILURE is a distinct attention item
  // (frontend-design.md §3 flags it by name) and a strictly worse zombie than the capped event
  // beside it — the two are mutually exclusive (conductor.ts's GATED RECLAIM `continue`s past
  // the capped append when addLabel throws), and this path additionally never latches, so the
  // row fails `gated_escalation_labeled = 1` forever and NO engine event will ever move that
  // issue again. `never`, necessarily: the label write is precisely what failed, so its absence
  // is the engine's own footprint, not a human's.
  "gated-reentry-capped-label-failed": "never",
  // #295 review round 2 (Codex P2): the fix-leg spawn-uncertainty escalation
  // (conductor.ts's reconcileDrivingFixIntents "unconfirmed" branch). `always`: the event is
  // emitted strictly AFTER its own addLabel succeeded (a failed write `continue`s with only the
  // companion `-label-failed` event, which stays out of this table for the same reason
  // gated-reentry-capped-label-failed does). Its payload carries `pr` (the driving lane's own),
  // so an external merge/close of that PR resolves it like every other pr-bearing source.
  "fix-leg-undecidable": "always",
};

const RESOLVED_KIND = "escalation-resolved";

/** How an escalation was observed to have been resolved. See the module doc for why
 *  `board-fixed` (named in issue #295's sketch) is deliberately absent. */
export type ResolutionVia = "merged" | "closed" | "label-removed";

export interface OpenEscalation {
  /** The escalation event kind this came from — the `source` the dashboard folds on. */
  source: string;
  issue: number;
  /** Present only for the kinds whose payload carries one (`gated-reentry-capped`,
   *  `drive-needs-human`, `env-failure-preserved`); absent — never `undefined` — otherwise, so
   *  the emitted payload stays exactly as wide as the facts justify. */
  pr?: number;
  /** Whether label absence may be read as "a human removed it" — module doc. */
  labelProven: boolean;
}

function payloadNumber(payload: Record<string, unknown> | null, key: string): number | undefined {
  const v = payload?.[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** Every escalation still waiting on a person, keyed `${source}:${issue}` — the count fold the
 *  module doc describes (escalations minus resolutions, in ledger order). Pure over the durable
 *  ledger and exported so a future `sapwood status` / dashboard reader can never disagree with
 *  the sweep about what "open" means (same shared-fold discipline as dissent.ts's
 *  `unadjudicatedConcerns`). A malformed event (no numeric `issue`) is skipped, never thrown —
 *  same best-effort-bookkeeping stance the rest of this codebase's journals take. */
export function openEscalations(events: readonly { kind: string; payload: unknown }[]): Map<string, OpenEscalation> {
  const open = new Map<string, OpenEscalation>();
  // #295 review round 2 (Codex P1 — exactly-once for RETRYING sources): a source that re-emits
  // its escalation event every tick while a companion write keeps failing (e.g.
  // gated-reentry-capped-label-failed) would otherwise REOPEN the escalation after a terminal
  // resolution — merged/closed resolves it, the next tick's retry event re-enters `open`, the
  // next sweep appends a SECOND escalation-resolved, ad infinitum. A merged/closed PR (or
  // closed issue) is a TERMINAL fact: a later same-key event about the SAME pr can only ever be
  // a retry stream, never a genuine re-escalation, so it is suppressed here. `label-removed` is
  // deliberately NOT terminal — a human removing the label and the lane later re-escalating is
  // the one genuine reopen this fold must keep honoring. A later event carrying a DIFFERENT pr
  // (lane repointed — the F15 shape) is a genuinely new episode and clears the suppression.
  const terminal = new Map<string, number | undefined>();
  for (const e of events) {
    const payload = (e.payload ?? null) as Record<string, unknown> | null;
    const issue = payloadNumber(payload, "issue");
    if (issue === undefined) continue;
    if (e.kind === RESOLVED_KIND) {
      const source = typeof payload?.source === "string" ? payload.source : undefined;
      if (source !== undefined) {
        open.delete(`${source}:${issue}`);
        if (payload?.via === "merged" || payload?.via === "closed") {
          terminal.set(`${source}:${issue}`, payloadNumber(payload, "pr"));
        }
      }
      continue;
    }
    const proof = ESCALATION_SOURCES[e.kind];
    if (proof === undefined) continue;
    const pr = payloadNumber(payload, "pr");
    const key = `${e.kind}:${issue}`;
    if (terminal.has(key)) {
      if (terminal.get(key) === pr) continue; // retry stream after a terminal resolution — never reopens
      terminal.delete(key); // different pr: a genuinely new episode
    }
    // The LATEST escalation's own facts win: a re-escalation may carry a different PR, and the
    // stale one would send the observation below at a PR this escalation is not about.
    open.set(key, {
      source: e.kind,
      issue,
      ...(pr !== undefined ? { pr } : {}),
      labelProven: proof === "always" || (proof === "payload" && payload?.labeled === 1),
    });
  }
  return open;
}

/** The read-only observation for ONE open escalation: has the outside world resolved it? Order
 *  is most-informative-first — a merged PR is a richer fact than the issue closure it usually
 *  causes, so it wins when both are true. */
async function observeResolution(forge: IForge, cfg: SapwoodConfig, esc: OpenEscalation): Promise<ResolutionVia | null> {
  if (esc.pr !== undefined) {
    const pr = await forge.getPRStatus(esc.pr);
    if (pr.state === "MERGED") return "merged";
    if (pr.state === "CLOSED") return "closed";
  }
  const meta = await forge.getIssueMeta(esc.issue);
  if (meta.state === "CLOSED") return "closed";
  // The WHOLE human-hold set, matching GATED RECLAIM's own eligibility rule (conductor.ts: "the
  // ISSUE carries NONE of cfg.escalation.humanLabels") — so this module and the reclaim path can
  // never disagree about whether a human is still holding the issue.
  if (esc.labelProven && !cfg.escalation.humanLabels.some((label) => labelsInclude(meta.labels, label))) {
    return "label-removed";
  }
  return null;
}

/** Sweep every open escalation against live forge state and append `escalation-resolved` once
 *  per resolution (module doc). Called UNCONDITIONALLY, once per round, from round-defaults.ts's
 *  aligning wrapper — the same round-level home `scanForAdjudication` uses, and for the same
 *  reason: whether a human is still blocked cannot depend on which optional roles are enabled.
 *  A per-escalation read failure degrades to "left open this pass" (logged, never thrown) — the
 *  next round's sweep retries it fresh. */
export async function reconcileEscalations(
  forge: IForge,
  state: Pick<State, "eventsAfterId" | "appendEvent">,
  cfg: SapwoodConfig,
  log?: (message: string) => void,
): Promise<void> {
  const warn = log ?? console.error;
  let open: Map<string, OpenEscalation>;
  try {
    open = openEscalations(state.eventsAfterId(0, [...Object.keys(ESCALATION_SOURCES), RESOLVED_KIND]));
  } catch (e) {
    // Fail closed: an unreadable ledger must never risk a duplicate append (we cannot tell what
    // was already resolved). A later round reads it again.
    warn(`[sapwood:escalation] failed to read the escalation ledger — swept nothing this pass: ${String(e)}`);
    return;
  }
  for (const esc of open.values()) {
    let via: ResolutionVia | null;
    try {
      via = await observeResolution(forge, cfg, esc);
    } catch (e) {
      warn(`[sapwood:escalation] failed to check ${esc.source} on #${esc.issue} — left open this pass: ${String(e)}`);
      continue;
    }
    if (via === null) continue;
    try {
      state.appendEvent(RESOLVED_KIND, {
        issue: esc.issue,
        ...(esc.pr !== undefined ? { pr: esc.pr } : {}),
        source: esc.source,
        via,
      });
    } catch {
      // Best-effort: the append IS the latch, so a lost one simply leaves the escalation open —
      // the next round's sweep re-derives the same resolution and retries (module doc, AC2).
    }
  }
}
