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
// anywhere below, and this module never gates anything — the `escalation-resolved` event is a
// RECORD, never a decision input for escalation or merge. Existing escalation and gating behavior
// is byte-identical with this module present or absent.
//
// #441 amendment (honesty, not a relaxation): the sentence that used to sit here — "nothing this
// module computes feeds a write path" — is no longer true, and pretending otherwise would be
// exactly the kind of stale doc this codebase treats as a defect. `escalation-sweep.ts` reads the
// `escalation-resolved` events appended below and removes the `needs-human` label an engine
// escalation provably applied (F34: a resolved escalation kept suppressing automation forever
// because nothing ever swept its hold carrier). What is preserved is the part that MATTERS: the
// write lives at the CALL SITE, in its own module, and this file stays a pure observer whose
// forge surface is two read methods. `ESCALATION_SOURCES` is exported for that consumer so the
// label-ownership proof below stays the ONE definition of "the engine applied this label".
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
// `via: "board-fixed"` (issue #295's sketch named it; review round 7 made it reachable). The
// original ruling was that NO class is board-column-signalled, so the arm would be dead code.
// That premise died when round 7 correctly ruled out issue closure for the merged-board-done
// rollback escalation: a worker PR carries `Closes #N`, so the merge that PRODUCED the escalation
// also closes the issue, and closure cannot be evidence anyone repaired the board. What that
// class means is exactly "the Done-board write never landed", so what resolves it is exactly
// "the board says Done" — a fact, directly observable, rather than a human ritual on a closed
// issue nobody browses. Implemented as the doc always specified: ONE `readStartupReconcileData()`
// placement read per sweep (board-wide, never per-issue), taken LAZILY — only if such an
// escalation is actually open, which is rare by construction. This also heals every legacy
// ledger event, which a label-based path could not: it observes the fact, not the act.
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
import { MERGED_BOARD_DONE_REASON } from "./conductor.js";

/** How each escalation kind proves it actually applied the needs-human label — see the module
 *  doc's "label absence" note for why this table exists and what a wrong entry would cost.
 *  `always`: the event cannot exist unless the label landed. `payload`: the event records the
 *  outcome itself (`labeled`). `never`: best-effort or no label at all — label absence proves
 *  nothing, so these resolve only by closure/merge. */
export const ESCALATION_SOURCES: Record<string, "always" | "payload" | "never"> = {
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
  // #295 review round 4 (Codex P1): the fix-round cap — in practice the MOST common escalation
  // of all — was missing from this table entirely, so `openEscalations` skipped it and no
  // external merge/close/label-removal could ever resolve it. `always`, for exactly the reason
  // `fix-leg-undecidable` is: conductor.ts's cap branch appends `fix-rounds-capped` strictly
  // AFTER its own addLabel returned (a throw emits `fix-rounds-cap-label-failed` and `break`s
  // without this event), and its payload carries the driving lane's `pr`.
  "fix-rounds-capped": "always",
  // #457 review round 1 (P1): the verdict-rerun breaker's escalation (conductor.ts's shared
  // fix-escalation branch) — same emission ordering as `fix-rounds-capped`, which it shares a
  // branch with: appended strictly AFTER its own addLabel returned (a throw emits
  // `fix-rounds-cap-label-failed` and `break`s without this event), payload carries the driving
  // lane's `pr`. `always`, for the identical reason. Absent from this table it would be the F34
  // failure class: an invisible escalation no external merge/close/label-removal could resolve.
  "fix-leg-verdict-rerun": "always",
  // #295 review round 10 (Codex P1): the two gate⓪ attention sources frontend-design.md §3 flags
  // by name. Neither carries a PR.
  //
  // `verify-na-proposed` is `always`: emitted strictly AFTER both label writes, under the same
  // fix-rounds-capped doctrine its own comment cites ("an escalation event may only claim what
  // provably landed"), so the event cannot exist unless the label landed.
  "verify-na-proposed": "always",
  // `plan-review-escalated` is `never`, NOT `always` (round 11, Codex P1 — a FALSE-CLEAR risk,
  // the class this module's doctrine calls strictly worse than a zombie row). It has TWO emission
  // sites with opposite orderings: plan-review.ts's own `escalate` appends after an unguarded
  // `escalateForge`, but `runSessionWithRetry` (peripheral.ts) appends the degrade event FIRST
  // and its callers (plan-review.ts:554/708/864) call `escalateForge` afterwards — so a failed
  // addLabel there leaves the event standing with no label at all, and `always` would make the
  // very next sweep read that absence as a human removal. Classified by the WEAKEST site, as the
  // doctrine requires. Cost: it clears by issue closure only, which is still strictly more
  // clearing than the zero paths it had.
  "plan-review-escalated": "never",
  // DELIBERATELY ABSENT (#441): `resume-held`. It is a new event kind that leaves a lane stopped,
  // so the question "does it need a row here?" is exactly the one F34 punishes getting wrong —
  // answered NO, on purpose, for two independent reasons. (1) It is not a new attention item: it
  // OBSERVES a `needs-human`/`blocked` label suppressing a handoff resume, and whoever owns that
  // label already has the item — an engine escalation has its own row above, and a hand-applied
  // hold's owner is the person who typed it (#397's needs-human split, #400's one-carrier rule).
  // Listing it would double-count one fact. (2) Structurally it MUST stay out: escalation-sweep.ts
  // refuses to touch an issue with any open escalation, so a `resume-held` row would block the
  // sweep of the very stale label that produced it — the F34 wedge, rebuilt by its own fix.
  //
  // KNOWN, BOUNDED GAP (#295 review round 10, deferred to #404): frontend-design.md §3 also
  // flags two PREDICATE kinds — `reclaim-failed` when `payload.next` is not an automatic
  // continuation, and `reclaim-done` on its no-PR branch. They are attention items only for
  // SOME payloads, and this table is kind-keyed, not payload-keyed. Externally closing such an
  // issue therefore emits no `escalation-resolved` and its strip row persists. Deferred rather
  // than bolted on: expressing "attention iff payload P" needs a predicate layer this table does
  // not have, and the condition itself lives in the dashboard's fold — the two should be derived
  // from one shared definition, not encoded twice. Stated here rather than silently omitted.
};

/** Events that CLEAR an issue-scoped attention item without resolving it externally — the
 *  dashboard's own fold (docs/frontend-design.md, "Attention items fold over the whole event
 *  history") clears on any later event that MOVES the issue. #295 review round 4 (Codex P2):
 *  this module folded only escalation + resolution kinds, so on an upgraded or long-running DB
 *  every historical escalation whose issue was later re-dispatched stayed "open" here forever —
 *  a per-round forge read each, growing monotonically, plus a misleading late resolution event
 *  for an item the strip already considers cleared. Folding the same clear kinds keeps the two
 *  folds over one ledger from disagreeing. Deliberately NOT terminal (unlike a merged
 *  resolution): a lane that is re-dispatched and escalates AGAIN is a genuine new episode.
 *
 *  #447 (PR #463 gate② P2): `lane-revived` belongs here for the same reason `gated-reentry`
 *  does — it is the OTHER way a `failed` lane returns to `driving`, and the attention item it
 *  clears (`env-failure-preserved`) is precisely the one revival exists to answer. Without it a
 *  revived, actively-driving lane keeps its strip row and keeps costing a per-round forge read. */
export const CLEAR_KINDS = ["dispatched", "merged", "gated-reentry", "lane-revived"] as const;

/** #295 review round 5 (Codex P2), narrowed in round 6: a clear event must not erase an escalation
 *  THAT SAME OPERATION produced. conductor's `case "merged"` calls `handleRollbackFailure` — which
 *  appends `rollback-escalated` — BEFORE it appends its own `merged` event, so the escalation
 *  carries the LOWER event id and an issue-wide clear would erase a human task the merge just
 *  created and did NOT repair: the board transition still failed.
 *
 *  Round 6 (Codex P2): the exemption is keyed on the PRODUCING pair, not on the source. A
 *  `rollback-escalated` from any other recovery path (a dispatch or requeue Ready transition) IS
 *  genuinely superseded by a later `dispatched`/`gated-reentry`, and since this source is
 *  `never`-proof it can never clear by label removal — a source-wide exemption would strand those
 *  forever, re-creating for one source exactly the unbounded-scan defect round 4 fixed. */
const CLEAR_PRODUCES: Record<string, (kind: string, payload: Record<string, unknown> | null) => boolean> = {
  merged: (kind, payload) => kind === "rollback-escalated" && payload?.reason === MERGED_BOARD_DONE_REASON,
};

export const RESOLVED_KIND = "escalation-resolved";

/** How an escalation was observed to have been resolved. See the module doc for why
 *  `board-fixed` (named in issue #295's sketch) is deliberately absent. */
export type ResolutionVia = "merged" | "closed" | "label-removed" | "board-fixed";

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
  /** #295 round 6: the clear kind whose own operation PRODUCED this escalation, if any. That one
   *  clear kind cannot be evidence this escalation was resolved (see CLEAR_PRODUCES); every other
   *  clear kind still clears it. Absent for the overwhelming majority of escalations. */
  producedBy?: string;
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
  // resolution — the next tick's retry event re-enters `open`, the next sweep appends a SECOND
  // escalation-resolved, ad infinitum. A MERGED pr is the one genuinely IRREVERSIBLE fact: a
  // later same-key event about the SAME pr can only ever be a retry stream, never a genuine
  // re-escalation, so it is suppressed here.
  //
  // #295 review round 3 (Codex P2): `closed` is deliberately NOT terminal — an issue (or
  // unmerged PR) can be closed, REOPENED, and genuinely re-escalate under the same key (and for
  // pr-less sources the stored/new pr are both undefined, so the key can never disambiguate);
  // suppressing that would silently eat a real escalation forever. The cost of leaving `closed`
  // non-terminal is bounded and honest: a retry stream against a still-closed entity re-opens
  // the fold entry and the next sweep re-observes the same closure and appends another
  // resolution — escalations and resolutions stay paired (the dashboard fold nets to zero, no
  // zombie), and the stream ends when the failing companion write finally lands. Wrong-side
  // trade-offs compared: a duplicated resolution pair is noise; a suppressed genuine
  // re-escalation is an invisible, permanently-lost attention item. `label-removed` is likewise
  // non-terminal (a human clearing the label and the lane re-escalating is the designed reopen).
  // A later event carrying a DIFFERENT pr (lane repointed — the F15 shape) is a genuinely new
  // episode and clears the suppression.
  const terminal = new Map<string, number | undefined>();
  for (const e of events) {
    const payload = (e.payload ?? null) as Record<string, unknown> | null;
    const issue = payloadNumber(payload, "issue");
    if (issue === undefined) continue;
    if (e.kind === RESOLVED_KIND) {
      const source = typeof payload?.source === "string" ? payload.source : undefined;
      if (source !== undefined) {
        open.delete(`${source}:${issue}`);
        if (payload?.via === "merged") {
          terminal.set(`${source}:${issue}`, payloadNumber(payload, "pr"));
        }
      }
      continue;
    }
    if ((CLEAR_KINDS as readonly string[]).includes(e.kind)) {
      // "a later event moves that issue" — issue-scoped, so every source on that issue clears,
      // not just one key. Same rule the strip applies.
      for (const [key, esc] of [...open.entries()]) {
        if (esc.issue === issue && esc.producedBy !== e.kind) open.delete(key);
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
    const producedBy = Object.keys(CLEAR_PRODUCES).find((clearKind) => CLEAR_PRODUCES[clearKind]?.(e.kind, payload));
    open.set(key, {
      source: e.kind,
      issue,
      ...(pr !== undefined ? { pr } : {}),
      labelProven: proof === "always" || (proof === "payload" && payload?.labeled === 1),
      ...(producedBy !== undefined ? { producedBy } : {}),
    });
  }
  return open;
}

/** The read-only observation for ONE open escalation: has the outside world resolved it? Order
 *  is most-informative-first — a merged PR is a richer fact than the issue closure it usually
 *  causes, so it wins when both are true. */
async function observeResolution(
  forge: IForge,
  cfg: SapwoodConfig,
  esc: OpenEscalation,
  boardStatus: (issue: number) => Promise<string | null>,
): Promise<ResolutionVia | null> {
  if (esc.pr !== undefined) {
    const pr = await forge.getPRStatus(esc.pr);
    if (pr.state === "MERGED") return "merged";
    if (pr.state === "CLOSED") return "closed";
  }
  // #295 review round 7: for an escalation the MERGE ITSELF produced, the board is the only honest
  // witness. Checked BEFORE the issue read, and it is the only arm this class has — see below.
  if (esc.producedBy === "merged") {
    return (await boardStatus(esc.issue)) === cfg.board.status.done ? "board-fixed" : null;
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
    open = openEscalations(state.eventsAfterId(0, [...Object.keys(ESCALATION_SOURCES), ...CLEAR_KINDS, RESOLVED_KIND]));
  } catch (e) {
    // Fail closed: an unreadable ledger must never risk a duplicate append (we cannot tell what
    // was already resolved). A later round reads it again.
    warn(`[sapwood:escalation] failed to read the escalation ledger — swept nothing this pass: ${String(e)}`);
    return;
  }
  // ONE board-wide placement read per sweep, taken LAZILY — only if a merge-produced escalation is
  // actually open (rare by construction), and memoized so N of them still cost one call. A read
  // failure yields `null` for every issue, i.e. "not observed resolved this pass", which is the
  // same fail-open-to-still-open degradation every other arm uses. Deliberately NOT per-issue: the
  // module doc's cost bound ("at most 2 read-only calls each per round") stays intact.
  let placements: Map<number, string | null> | null | undefined;
  const boardStatus = async (issue: number): Promise<string | null> => {
    if (placements === undefined) {
      try {
        const data = await forge.readStartupReconcileData();
        // #295 review round 8 (Codex P1): a ProjectV2 board may span repositories, so an issue
        // NUMBER is not a key — a foreign repo's #7 would supply or overwrite the local #7's
        // status and falsely resolve it. Filter on nameWithOwner exactly as the other board path
        // does (forge.ts's listUnplacedIssues). A null repo fails closed: excluded, so the
        // escalation stays open rather than being cleared on an unattributable placement.
        const nameWithOwner = `${cfg.board.owner}/${cfg.board.repo}`;
        placements = new Map(
          data.placements.filter((p) => p.number != null && p.repo === nameWithOwner).map((p) => [p.number as number, p.status]),
        );
      } catch (e) {
        warn(`[sapwood:escalation] board placement read failed — merge-produced escalations left open this pass: ${String(e)}`);
        placements = null;
      }
    }
    return placements?.get(issue) ?? null;
  };
  for (const esc of open.values()) {
    let via: ResolutionVia | null;
    try {
      via = await observeResolution(forge, cfg, esc, boardStatus);
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
