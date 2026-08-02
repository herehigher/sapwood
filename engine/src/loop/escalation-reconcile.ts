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
// STRUCTURALLY READ-ONLY (#295 AC3): the only IForge calls in this file are `getPRStatus`,
// `getIssueMeta` and (#398) `getPRLabels`. There is no addLabel/removeLabel/setBoardStatus/mergePR/comment call site
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
// #404 widened only the LEDGER read: registering the two reclaim kinds pulls their every-lane
// events into the kind filter, including the ordinary continuations the predicate then drops.
// That is one more SQLite scan of rows this process already writes — the FORGE bound above is
// untouched, since a dropped payload never reaches an observation.
import type { SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import { ESCALATION_SOURCE_TAGS, type EventKind, kindsTagged } from "../state/event-kinds/index.js";
import type { State } from "../state/state.js";
import { BASE_CI_RED_CLEARED, BASE_CI_RED_ESCALATED, baseCiFailing, baseRedPin, readBaseCi } from "./base-ci.js";
import { MERGED_BOARD_DONE_REASON } from "./conductor.js";

/** How an escalation kind proves it actually applied the needs-human label — see the module doc's
 *  "label absence" note for why this table exists and what a wrong entry would cost.
 *  `always`: the event cannot exist unless the label landed. `payload`: the event records the
 *  outcome itself (`labeled`). `never`: best-effort or no label at all — label absence proves
 *  nothing, so these resolve only by closure/merge. */
export type EscalationProof = "always" | "payload" | "never";

/** #404: a source whose events are attention items only for SOME payloads. The table was
 *  KIND-keyed — an event kind either waits on a person or it does not — which is true of every
 *  row but the two reclaim kinds, whose own `next` decides it. Registering them as bare `always`
 *  would track every ordinary lane continuation (and, worse, grant `label-removed` to paths that
 *  never labelled anything); leaving them out is the F34 hole #404 exists to close. So a row may
 *  carry its own payload predicate alongside its proof mode, and `attentionProof` below is the
 *  ONE reader — deliberately a widened row rather than a parallel map, so a kind can never end up
 *  registered in one place and predicated in another. */
export interface PredicatedSource {
  proof: EscalationProof;
  /** THE definition of "this payload leaves work waiting on a person", for this kind. */
  attention: (payload: Record<string, unknown> | null) => boolean;
}

/** The shared attention condition for BOTH reclaim kinds (#404), written ONCE: a lane whose
 *  `next` is the automatic continuation (`DRIVING` — the PR exists and the drive gate takes it
 *  from here) is not waiting on anybody; every other disposition is (`ESCALATE`,
 *  `ESCALATE_NOPR` — conductor.ts's laneOnReclaimFailed/laneOnReclaimDone). docs/frontend-design
 *  .md §3 states the same rule in prose for the dashboard's strip; the fold there consumes
 *  `attentionProof` rather than re-encoding it.
 *
 *  Fail direction, for a malformed/legacy payload with no `next` at all: it reads as ATTENTION (a
 *  visible row someone can close) rather than as a continuation (silently untracked — the F34
 *  class). Both emission sites have always written `next`, so this is a guard, not a live path. */
const reclaimNeedsAttention = (payload: Record<string, unknown> | null): boolean => payload?.next !== "DRIVING";
/** #404: the payload predicates, keyed by kind. Only the two reclaim kinds have one — the
 *  registry tag carries each source's PROOF MODE (the fact every consumer needs), and the
 *  predicate stays here with the reader that defines what "waiting on a person" means for a
 *  payload, since a function is not something a declaration table can hold. `attentionProof`
 *  below is still the ONE reader of both halves, so a kind can never end up registered in one
 *  place and predicated in another. */
const ATTENTION_PREDICATES: Partial<Record<EventKind, (payload: Record<string, unknown> | null) => boolean>> = {
  "reclaim-failed": reclaimNeedsAttention,
  "reclaim-done": reclaimNeedsAttention,
};

/** #425: DERIVED from the central registry's `escalation-source:*` tags instead of being a
 *  re-spelled table here. This is the list whose omissions this repo has actually paid for —
 *  `fix-rounds-capped`, the most common escalation of all, was missing for four review rounds
 *  (#295 round 4) — so its membership is now a property each kind DECLARES on itself in
 *  `state/event-kinds/`, next to the proof-mode rationale, and event-kinds.test.ts fails in both
 *  directions if this table and those tags ever disagree.
 *
 *  What did NOT move, and why: the "label absence is only a human act if the engine provably
 *  applied the label" doctrine in this module's own header, and the DELIBERATELY-ABSENT rulings
 *  below. Those are statements about kinds that are NOT sources — there is no tag for them to
 *  hang off, and they belong with the reconciler whose behaviour they explain. */
export const ESCALATION_SOURCES: Record<string, EscalationProof | PredicatedSource> = Object.fromEntries(
  ESCALATION_SOURCE_TAGS.flatMap((tag) => {
    const proof = tag.slice("escalation-source:".length) as EscalationProof;
    return kindsTagged(tag).map((kind) => {
      const attention = ATTENTION_PREDICATES[kind];
      return [kind, attention === undefined ? proof : { proof, attention }] as const;
    });
  }),
);

/** The same set as `Object.keys(ESCALATION_SOURCES)`, but TYPED — the ledger-read list both this
 *  module and escalation-sweep.ts pass to `eventsAfterId`. `Object.keys` widens to `string[]`
 *  (the escape hatch #425 set out to close); reading straight off the tags keeps the list a
 *  checked `EventKind[]`, so a kind that leaves the registry breaks the read at compile time
 *  instead of silently narrowing the fold to nothing. */
export const ESCALATION_SOURCE_KINDS: EventKind[] = ESCALATION_SOURCE_TAGS.flatMap((tag) => kindsTagged(tag));

// DELIBERATELY ABSENT from the table above — kinds that leave a lane stopped but are NOT
// issue-keyed needs-human attention items. Recorded here rather than merely omitted, because
// "does this kind need a row?" is exactly the question F34 punishes getting wrong, and an
// unexplained absence reads as an oversight:
//
//  - `resume-held` (#441). Two independent reasons. (1) It is not a NEW attention item: it
//    OBSERVES a `needs-human`/`blocked` label suppressing a handoff resume, and whoever owns that
//    label already has the item — an engine escalation has its own row, and a hand-applied hold's
//    owner is the person who typed it (#397's needs-human split, #400's one-carrier rule).
//    Listing it would double-count one fact. (2) Structurally it MUST stay out: escalation-sweep
//    .ts refuses to touch an issue with any open escalation, so a `resume-held` row would block
//    the sweep of the very stale label that produced it — the F34 wedge, rebuilt by its own fix.
//
//  - `ceiling-breach-entered` / `ceiling-breach-cleared` (#431), `rapid-restart-detected` (#431),
//    `consecutive-stalls-detected` (#407), `idle-churn-detected` (#470). The same answer for the
//    same structural reason: this table is the needs-human-LABEL reconciler, keyed by the ISSUE in
//    each event's payload (`openEscalations`), and none of these carries an issue or applies a
//    label — `openEscalations` would skip them on the `issue === undefined` guard even if listed,
//    so a listed row would be dead weight that reads as coverage. The ceiling's real attention
//    item is the per-lane `ceiling-escalated` (which IS a source); each detector's is its own
//    durable park episode (park_state row + `park-escalated`/`park-resumed` lifecycle + the
//    ESCALATION marker + `sapwood status`), cleared by an operator-explicit park_state deletion,
//    never by this table's label/close/merge reconciliation.
//
//  - `base-ci-red-escalated` (#502). Same structural ground — a red default branch is a RUN-level
//    fact with no issue, no PR and no label. What is DIFFERENT, and why it is named rather than
//    merely omitted: unlike the park-carried kinds, its resolution IS this module's job.
//    `reconcileBaseCiEscalation` below observes base-green on the same once-per-round pass and
//    appends the same `escalation-resolved` receipt every row above emits, keyed on `source`
//    alone — so the kind reuses this module's resolution vocabulary and observer without
//    pretending to be an issue-keyed strip row.
//
//  - every `*-label-failed` / `*-comment-failed` companion EXCEPT
//    `gated-reentry-capped-label-failed`. Those companions are emitted INSTEAD of their terminal
//    (the label-first-or-no-event doctrine), and the terminal is the row. The one exception is a
//    source precisely because its capped branch never latches, so nothing else will ever move
//    that issue — see its own declaration for the argument.

/** The ONE reader of the table above, and the one definition of "does this event leave work
 *  waiting on a person" (#404) — returns the kind's proof mode, or `undefined` when the kind is
 *  not an attention source OR its own predicate rejects this payload. Both ledger folds go
 *  through it (`openEscalations` here, `sweepableHolds` in escalation-sweep.ts) and so will the
 *  dashboard's strip fold, so no two readers can disagree about which payloads count. */
export function attentionProof(kind: string, payload: Record<string, unknown> | null): EscalationProof | undefined {
  const entry = ESCALATION_SOURCES[kind];
  if (entry === undefined) return undefined;
  if (typeof entry === "string") return entry;
  return entry.attention(payload) ? entry.proof : undefined;
}

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
 *  revived, actively-driving lane keeps its strip row and keeps costing a per-round forge read.
 *
 *  #425: DERIVED from the central registry's `escalation-clear` tag — the same treatment
 *  ESCALATION_SOURCES above got, for the same reason (a clear kind missing here is the mirror
 *  image of a source missing there: a strip row nothing can retire). */
export const CLEAR_KINDS = kindsTagged("escalation-clear");

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

/** How an escalation was observed to have been resolved.
 *
 *  #441 review round 2 (Codex P1): the single `"closed"` value was SPLIT into `pr-closed` and
 *  `issue-closed`, because `observeResolution` reaches it down two paths that are not remotely
 *  the same fact, and a downstream consumer cannot tell them apart:
 *    - a CLOSED **PR** is not a completion witness and not a human act. `deriveGate` maps every
 *      non-OPEN PR to HUMAN ("already merged/closed -> never touch", merge-driver.ts), the fold
 *      below deliberately keeps closure NON-terminal because a PR can reopen, and the producer
 *      guard blocks `gh pr merge`/`ready`/`review --approve` but NOT `gh pr close` (guard.ts's
 *      checkCategoryC) — so a worker can put its own lane into this state.
 *    - a CLOSED **issue** is engine/human-owned: `gh issue close|reopen|transfer|delete` is
 *      blocked outright for producers (#353, guard.ts's ISSUE_LIFECYCLE_VERBS), so the closure
 *      was performed by a person or by a merge carrying `Closes #N`.
 *  This module treats both as "no longer waiting on a human" exactly as before — the strip clears
 *  either way, and nothing here changed behaviour. The distinction exists for
 *  `escalation-sweep.ts`, which may only act on a witness that genuinely represents completion or
 *  release; see its own `SWEEPABLE_VIA`. Recording the two separately is a payload REFINEMENT,
 *  not a new contract: this module still writes one transition event per resolution and still
 *  gates nothing.
 *
 *  #502: `base-green` is the RUN-level witness — the default branch's CI is no longer red. It is
 *  the only value produced by an escalation with no issue and no PR, so it never reaches
 *  `escalation-sweep.ts` (that module skips any resolution whose payload carries no numeric
 *  `issue`, and `SWEEPABLE_VIA` does not list it either — a run-level fact applied no label for a
 *  sweep to remove). */
export type ResolutionVia = "merged" | "pr-closed" | "issue-closed" | "label-removed" | "board-fixed" | "base-green";

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
  /** #398: WHICH object the escalation wrote its `needs-human` label on, from the event's own
   *  `carrier` payload field. `"pr"` only for the kinds that emit it and only when they chose the
   *  PR; ABSENT (never `undefined`) otherwise, which reads as `"issue"` — the accurate default
   *  for every pre-#398 ledger event and every escalation that still writes the issue. Load-
   *  bearing for `observeResolution`'s `label-removed` arm ONLY: reading the issue's labels for a
   *  PR-carried hold would see the label missing from the very first pass and report "a human
   *  resolved this" about work nobody has looked at — the FALSE CLEAR this module's own doctrine
   *  calls strictly worse than the zombie rows it exists to remove. */
  carrier?: "pr";
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
    const proof = attentionProof(e.kind, payload);
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
      // #398: only ever set when the event says so AND it actually carries the pr to read labels
      // from — an escalation claiming a "pr" carrier without a pr number is malformed, and the
      // safe reading of it is the issue-side default (a hold that outlives its resolution costs a
      // zombie strip row; a false clear releases a lane nobody looked at).
      ...(payload?.carrier === "pr" && pr !== undefined ? { carrier: "pr" as const } : {}),
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
    if (pr.state === "CLOSED") return "pr-closed"; // #441 r2: NOT a completion witness — see ResolutionVia
  }
  // #295 review round 7: for an escalation the MERGE ITSELF produced, the board is the only honest
  // witness. Checked BEFORE the issue read, and it is the only arm this class has — see below.
  if (esc.producedBy === "merged") {
    return (await boardStatus(esc.issue)) === cfg.board.status.done ? "board-fixed" : null;
  }
  const meta = await forge.getIssueMeta(esc.issue);
  if (meta.state === "CLOSED") return "issue-closed";
  if (!esc.labelProven) return null;
  // #398: the hold is only observable on the object the escalation WROTE — reading the issue for
  // a PR-carried hold would see it absent immediately and report a resolution nobody performed.
  // Costs one extra read (`getPRLabels`) for the PR-carried kinds only, and only while they are
  // genuinely open, so the module doc's "at most 2 read-only calls each per round" bound holds:
  // this arm is reached only when the PR is still OPEN and the issue still open, i.e. exactly the
  // case where the older code was about to make its second call anyway.
  const carrierLabels = esc.carrier === "pr" && esc.pr !== undefined ? await forge.getPRLabels(esc.pr) : meta.labels;
  // The WHOLE human-hold set, matching GATED RECLAIM's own eligibility rule (conductor.ts: "the
  // carrier carries NONE of cfg.escalation.humanLabels") — so this module and the reclaim path
  // can never disagree about whether a human is still holding the lane.
  if (!cfg.escalation.humanLabels.some((label) => labelsInclude(carrierLabels, label))) {
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
    open = openEscalations(state.eventsAfterId(0, [...ESCALATION_SOURCE_KINDS, ...CLEAR_KINDS, RESOLVED_KIND]));
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
  await reconcileBaseCiEscalation(forge, state, cfg, warn);
}

/**
 * #502: the RUN-level arm of this same observer — resolve the base-branch-CI-red escalation once
 * the default branch is no longer red. Lives here, and runs on THIS pass, precisely so base-red
 * gets no reconciliation path of its own: same once-per-round home, same read-only-observation +
 * append-a-transition-event discipline, same `escalation-resolved` vocabulary every issue-keyed
 * row above emits (keyed on `source` alone, since the fact carries no issue — see
 * `ESCALATION_SOURCES`' own `base-ci-red-escalated` ruling).
 *
 * COST, matching this module's own bound: ZERO forge calls while no base-red episode stands (the
 * pin fold drops out before any read), and at most ONE capped `getDefaultBranchChecks` per round
 * while one does.
 *
 * ORDER — RECEIPT FIRST (#431's log-first write rule, the same ordering
 * `reconcileCeilingAnnouncements`' clear side and PR #463's event-before-upsert use): the
 * `escalation-resolved` receipt is appended STRICTLY BEFORE `base-ci-red-cleared`. A kill between
 * the two leaves the episode still pinned with a receipt already written; the next pass re-derives
 * base-green and appends both again, which is a duplicate receipt (noise, paired and honest). The
 * reverse order would clear the pin with no record that the escalation was ever resolved — the
 * direction that silently loses the fact.
 *
 * NOT A GATE. Clearing the pin only stops lanes from LABELLING their CI wait base-inherited; their
 * per-PR CI-evidence path was never diverted, so they are back on it the moment the pin is gone,
 * with no manual step. An unreadable base read leaves the episode open this pass — never a false
 * clear.
 */
export async function reconcileBaseCiEscalation(
  forge: Pick<IForge, "getDefaultBranchChecks">,
  state: Pick<State, "eventsAfterId" | "appendEvent">,
  cfg: SapwoodConfig,
  warn: (message: string) => void,
): Promise<void> {
  let pin: ReturnType<typeof baseRedPin>;
  try {
    pin = baseRedPin(state);
  } catch (e) {
    warn(`[sapwood:base-ci] failed to read the base-red pin — left open this pass: ${String(e)}`);
    return;
  }
  if (pin == null) return;
  const page = await readBaseCi(forge, cfg.proxy.caps.maxChecksPerCall, warn);
  if (page == null) return; // no usable evidence — the episode stays open, same as every other arm
  // "Is the base red RIGHT NOW", asked of whatever commit is the default branch's head THIS pass —
  // deliberately NOT "is the pinned commit still red".
  //
  // PR #523 gate② finding 1: an earlier version required `page.headOid === pin.sha` here, which
  // made the second-broken-push shape (main advances a1 -> b2, and b2 fails too) fall straight
  // through to the resolve/clear below — recording a DURABLE, factually false `via: "base-green"`
  // witness and dropping the pin while the base had never once been green. The window is real, not
  // theoretical: this observer runs in the round's aligning phase, strictly before the executing
  // phase where `observeBaseCi` would re-pin, so `sapwood status` would report `base CI: not known
  // red` about a branch that is red — the exact ambiguity #502 exists to remove. SHA equality was
  // never the question; it only ever identified WHICH episode is being closed, which is what
  // `pin.sha` in the payloads below already records.
  if (baseCiFailing(page, cfg.ci.requiredChecks).length > 0) return; // still red — on whichever commit main is at now
  try {
    state.appendEvent(RESOLVED_KIND, { source: BASE_CI_RED_ESCALATED, sha: pin.sha, via: "base-green" satisfies ResolutionVia });
    state.appendEvent(BASE_CI_RED_CLEARED, { sha: pin.sha, head: page.headOid });
  } catch (e) {
    // Best-effort, exactly like the issue-keyed arm above: a lost append leaves the episode open
    // and the next round re-derives the same resolution.
    warn(`[sapwood:base-ci] base-green receipt/clear append failed — episode left open: ${String(e)}`);
  }
}
