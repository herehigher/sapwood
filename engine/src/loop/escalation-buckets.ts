// #397: escalation semantics — two ACTION-buckets, not one overloaded label.
//
// `sapwood:needs-human` used to carry six distinct meanings behind one description, so a human
// seeing it could not tell what action was expected or what removing it would do. The split is by
// WHAT THE HUMAN MUST DO, never by carrier (the object already tells you where it sits):
//
//   bucket 1 — `labels.needsHuman`      the machine STOPPED; a human owes the next decision.
//                                       Removal is the #147 reentry handshake, unchanged.
//   bucket 2 — `labels.humanMergeOnly`  a human must MERGE this PR. One-way: written on the PR
//                                       exactly once, never removed or re-decided by the loop.
//   not an escalation — `labels.planless`  a routing fence for a plan-less issue. Nobody owes a
//                                       decision; it is simply off every queue until a plan exists.
//
// This module owns the runtime half: telling a bucket-2 gate verdict apart from a bucket-1 one at
// the single place the conductor acts on `driveOne`'s `needs-human` outcome.

/** #397: the three action-buckets every escalation write site is classified into. */
export type EscalationBucket = "human-merge-only" | "needs-human" | "planless";

/**
 * #397 bucket 2: does this `DriveOutcome`/`needs-human` reason mean "a human must merge this PR"
 * rather than "the machine stopped"?
 *
 * Today the instruction-path trust chain (#292) is the only such verdict — a PR editing reviewer
 * instruction files must never reach autonomous merge, but nothing is stuck and no human owes a
 * fix. Both producers of that reason (`merge-driver.ts`'s `driveOne` and `review/drive.ts`'s
 * engine-agent preflight) build it from `escalateInstructionPathChanges`'s own
 * `InstructionPathEscalationResult`, so the string matched here is a format THIS project defines
 * and emits, not scraped third-party text — the doctrine's "authoritative signal" bar. It is
 * matched as a string rather than a typed outcome field only because `merge-driver.ts` is a
 * human-merge-only path this change deliberately does not touch.
 *
 * Anchored at a reason-segment boundary (`^` or the `engine-agent: ` prefix the drive path adds)
 * so it can never be satisfied by attacker-influenced text later in a reason — the
 * `instruction-path-change` reason appends matched FILE PATHS, and a nested reason wrapper
 * (`fix-loop-unwired:<reason>`) concatenates another reason after a colon.
 *
 * Failure directions are not symmetric, so the match is deliberately narrow: a false NEGATIVE
 * degrades to today's behavior exactly (the lane escalates `needs-human` and enters the human
 * queue — noisier, never unsafe), while a false POSITIVE would settle a genuinely stuck lane with
 * NO label on its issue and no gated-reentry visibility. Narrow is the safe side here.
 */
export function isHumanMergeOnlyVerdict(reason: string): boolean {
  return /^(?:engine-agent: )?gate:HUMAN:instruction-path-/.test(reason);
}
