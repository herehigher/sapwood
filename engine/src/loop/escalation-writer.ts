// escalation-writer.ts (#432 round 6, gate② third confirm): the SHARED degrade-to-human
// escalation writer for a bare ISSUE (no worker row, no PR) — the exact discipline
// conductor.ts's own `escalateNeedsHuman` already established for worker-lane escalations,
// generalized so probeHasWork's two retry-cap terminals (dissent.ts's unpostable-concern
// escalation, round.ts's roundPool-removal-cap escalation) share ONE implementation instead of
// two hand-rolled copies.
//
// Why this file exists at all (the root cause both hand-rolled copies got wrong, identically):
// each wrote `addLabel(needsHuman)` FIRST, and only appended its terminal event ON SUCCESS,
// silently `return`ing on failure. That has two independent defects, both closed here:
//
//   1. A DETERMINISTIC label-write failure (the exact case a retry-cap escalation exists to
//      handle — e.g. a repo permission problem, or the same broken-resource condition that
//      caused the retries to fail in the first place) means the terminal event NEVER lands,
//      so the caller's own idempotence/pending check keeps seeing "not yet escalated" forever —
//      the retry-cap signal pins the probe true indefinitely, the exact F32 shape this whole
//      issue exists to close.
//   2. Even on a SUCCESSFUL label write, a crash strictly between the write landing and the
//      event append leaves an ownerless `needs-human`: no event proves the engine applied it,
//      so escalation-sweep.ts's `sweepResolvedHolds` (F34's OWNERSHIP IS PROOF rule — its own
//      module doc) can never remove it, even after the resolution it was blocking is long gone.
//
// The fix is `conductor.ts`'s OWN established discipline for exactly this shape (`WorkerRow`
// escalations there): the label write is BEST-EFFORT (never gates anything downstream), and the
// terminal event is UNCONDITIONAL — appended immediately after the write attempt regardless of
// its outcome, with that outcome recorded IN the payload (`labeled: 0 | 1`) rather than branched
// on. `escalation-reconcile.ts`'s `ESCALATION_SOURCES` table calls this proof shape `"payload"`
// (the same classification `drive-needs-human` already carries) — ownership is proven only when
// `labeled === 1`, exactly like every other `"payload"`-proof escalation in this codebase.
//
// UNCONDITIONAL is what closes defect 1 (a failing write no longer blocks the terminal from
// existing at all) and narrows defect 2 to the same theoretically-nonzero gap between two
// sequential local operations every OTHER write-then-record pattern in this codebase already
// accepts (e.g. conductor.ts's own reclaim/dispatch event appends) — not a window a REPEATED
// failure can walk into, only a literal kill at that exact instruction. Callers are additionally
// responsible for their OWN idempotence check (does the terminal event already exist for this
// key?) BEFORE calling this — see dissent.ts's `pendingDurableConcerns`/round.ts's
// `poolRemovalEscalated` — so a caller retrying after a crash-interrupted attempt re-attempts
// the (idempotent, GitHub-side no-op-if-already-applied) label write and completes the missing
// event, rather than silently re-escalating something already handed to a human.
import type { IForge } from "../forge/forge.js";
import type { EventKind } from "../state/event-kinds/index.js";
import type { State } from "../state/state.js";

/** #655: the marker for a bare-issue escalation's optional reason comment — keyed on (eventKind,
 *  issue) since each of this writer's callers escalates a given issue via exactly one eventKind
 *  (`reconcile.ts`'s orphan-PR sweep latches its own candidate via `ORPHAN_SWEEP_CHECKED` before a
 *  re-check is even possible; `round.ts`'s pool-removal-cap latches via `poolRemovalEscalated`
 *  before a re-attempt), so a single dedup key per (eventKind, issue) can never collide across two
 *  genuinely different escalations of the same issue the way a bare `issue`-only key could. */
export function needsHumanReasonMarker(eventKind: EventKind, issue: number): string {
  return `<!-- sapwood:needs-human-reason:${eventKind}:${issue} -->`;
}

/** Best-effort `needs-human` label write + UNCONDITIONAL outcome-bearing terminal event — see
 *  this module's own doc for the full crash-window/failure-tolerance argument. `eventKind`'s
 *  payload always carries `issue` and `labeled` (`1` on a successful write, `0` — with
 *  `labelError` — otherwise); `extraPayload` carries whatever additional identity fields the
 *  caller's own event shape needs (e.g. dissent.ts's `round_id`/`reason`). The event append is
 *  itself best-effort (contained, never thrown) — same "residual, stated not overclaimed" stance
 *  as every other durable-record append in this codebase: a lost append means only that the
 *  NEXT pass's idempotence check still sees "not yet escalated" and retries the whole sequence,
 *  which is always safe (the label write is idempotent, and this function recomputes its own
 *  outcome fresh on every call — it never assumes a prior attempt's result).
 *
 *  #655: `reasonComment`, when given, posts a marker-deduped courtesy comment on the issue AFTER
 *  the unconditional event append above — the reason plus the standard removal instruction, same
 *  visibility conductor.ts's `escalateNeedsHuman` gives its own first-escalation carrier. Entirely
 *  best-effort (a failed read OR a failed post is caught, never re-thrown): this writer's whole
 *  point is that the label outcome and the terminal event are NEVER gated on a forge write that
 *  can fail, and a courtesy comment must not become a second thing that can. Omitted by
 *  `dissent.ts`'s caller by definition — that escalation exists BECAUSE repeated comment posting
 *  already failed, so attempting one more here would be the exact failure mode this writer exists
 *  to route around. */
export async function escalateToNeedsHuman(
  // #384: the two members this writer actually uses, rather than the whole `IForge`/`SapwoodConfig`
  // — every existing caller still satisfies it, and a narrow caller (reconcile.ts's mid-run orphan
  // sweep) no longer has to carry a full forge/config it has no other use for.
  forge: Pick<IForge, "addLabel" | "getIssueComments" | "addIssueComment">,
  state: Pick<State, "appendEvent">,
  cfg: { labels: { needsHuman: string } },
  issue: number,
  eventKind: EventKind,
  extraPayload: Record<string, unknown>,
  reasonComment?: string,
): Promise<void> {
  let labeled = 1;
  let labelError: string | null = null;
  try {
    await forge.addLabel(issue, cfg.labels.needsHuman);
  } catch (e) {
    labeled = 0;
    labelError = String(e);
  }
  try {
    state.appendEvent(eventKind, { issue, ...extraPayload, labeled, ...(labelError != null ? { labelError } : {}) });
  } catch {
    // Best-effort — see this function's own doc for why a lost append here is safe to retry.
  }
  if (reasonComment != null) {
    try {
      const marker = needsHumanReasonMarker(eventKind, issue);
      const existing = await forge.getIssueComments(issue);
      if (!existing.some((c) => c.body.includes(marker))) {
        await forge.addIssueComment(issue, `${marker}\n${reasonComment}`);
      }
    } catch {
      // Best-effort — see this function's own doc for why a lost/duplicated attempt here is safe.
    }
  }
}
