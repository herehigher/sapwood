// escalation-sweep.ts (#441, F34): the WRITE half of escalation resolution — remove the
// `needs-human` label a resolved escalation left behind, but only where the ENGINE provably put
// it there.
//
// Why this exists (dogfood 2026-07-30, F34): #403's fix-round-cap escalation was closed out by a
// human — PR #430 opened, work resumed — and `escalation-reconcile.ts` correctly observed the
// resolution and appended `escalation-resolved`. Nothing removed the label. Three rounds later
// the lane's fix leg soft-budget-handed-off, the RESUME phase read that DEAD label as a live
// human hold, and silently skipped the resume for three more rounds. #400 ruled that "removing
// needs-human IS the go-ahead", which makes a never-swept label a permanent stop sign: every
// path that APPLIES the label had an owner, and no path that RESOLVES it did.
//
// WHO WROTE IT SWEEPS IT. The ownership rule is the whole safety argument, and it is decided by
// EVIDENCE, never by shape: a `needs-human` sitting on an issue looks identical whether a human
// typed it or the engine wrote it, so label presence can never be the input. The proof is
// `escalation-reconcile.ts`'s own `ESCALATION_SOURCES` table — the single definition of "this
// escalation kind cannot have emitted its event unless its addLabel landed" (`always`), "the
// event records the outcome itself" (`payload`, i.e. `drive-needs-human`'s `labeled: 1`), and
// "best-effort or no label at all" (`never`). Only `always`/proven-`payload` escalations are
// swept. A hand-applied label on an issue with NO engine escalation in the ledger has no proof
// and is therefore untouchable, forever — which is the correct answer, not a limitation.
//
// OWNERSHIP IS NOT PERMISSION (#441 review round 2, Codex P1). Proving the engine applied the
// label answers "may we remove OUR label"; it does not answer "has this work been released back
// to automation". Those are different facts, and only the second justifies lifting a stop sign.
// So a sweep needs a second, independent condition: an AUTHORIZING witness, `SWEEPABLE_VIA` =
// {merged, issue-closed}. Notably `pr-closed` is NOT one — a closed-unmerged PR is reopenable,
// producer-reachable (the guard permits `gh pr close`), and mapped to HUMAN by the merge gate, so
// sweeping it would let a lane clear its own human gate and churn. See `SWEEPABLE_VIA` for the
// per-value reasoning and the exact failure it prevents.
//
// ORDERING: WRITE FIRST, RECEIPT SECOND — deliberately the OPPOSITE of PR #463's
// event-before-upsert. The direction is not a house style; it follows from which side is
// idempotent and which failure is worse. There, the event was a fail-CLOSED discriminator: a
// crash before it had to leave the guard armed. Here, `forge.removeLabel` is idempotent by
// contract (removing an absent label is a GitHub no-op) and the bad outcome is the F34 wedge
// itself — a stale hold that suppresses automation forever with no signal. So:
//   1. `escalation-resolved` (appended by the reconciler, this pass or an earlier one) = the
//      EVIDENCE that the escalation is over. Always first; it is what makes the sweep derivable.
//   2. `forge.removeLabel` = the effect. Idempotent, so retrying it is free.
//   3. `needs-human-swept` = the LATCH that stops the retry.
// A `kill -9` in window 1→2 leaves a candidate with no receipt: the next pass re-derives it from
// the unchanged ledger and retries the removal. A crash in window 2→3 re-runs a no-op removal and
// then latches. Either way the ledger alone determines what still needs doing — no new column, no
// new table, and (unlike a receipt-first ordering) no window in which the removal is lost forever.
//
// BOUNDED, ACCEPTED BLIND SPOTS, stated rather than hidden:
//   - A human who RE-applies `needs-human` by hand in the window between the resolution and the
//     sweep loses it. In the ordinary case that window is microseconds — the sweep is wired
//     immediately after `reconcileEscalations` at both call sites, so a resolution observed in a
//     pass is swept in the SAME pass. It widens only across a crash. Closing it properly would
//     need a per-label authorship fact GitHub does not give us cheaply.
//   - An issue carrying ANY still-open escalation is skipped entirely, even for a DIFFERENT
//     source that did resolve: one label, several possible owners, and removing it would clear a
//     hold that is still genuinely live. The cost is that a permanently-open, never-clearing
//     escalation on the same issue (e.g. an `env-failure-preserved` whose PR is never touched)
//     defers its sibling's sweep indefinitely. Fail-safe direction: a label left on is visible
//     and human-clearable; a label taken off wrongly is the bug this module exists to prevent.
//   - #398 (recorded here rather than fixed, and this is the acceptance criterion's own
//     "record that decision instead" arm): once an escalation may carry its label on the PR, this
//     sweep's `removeLabel(issue, …)` is a no-op for that hold and the PR keeps the label. No
//     `IForge.removePRLabel` was added, because neither authorizing witness leaves a PR label
//     that gates anything. `merged` — the PR is merged; `deriveGate` never runs on it again and
//     no reentry can reclaim it. `issue-closed` — the work item is closed, so the lane is over on
//     the issue side too. `pr-closed`, the one witness where an open-ish PR could plausibly keep a
//     live label, is deliberately NOT sweepable (see `SWEEPABLE_VIA`). What is left is cosmetic:
//     a `needs-human` label on a merged or abandoned PR. Adding an engine-side PR-label removal
//     to erase that would put a NEW write capability into the loop — one the #147 handshake does
//     not want (reentry is human-removal-only, by the PLAN.md autonomy principle) — to buy tidier
//     history. If a case ever appears where a stale PR-side label actually gates something, that
//     is the trigger to add the method, and this note is the record that it was weighed first.
//
// COST: zero forge calls in steady state — the receipt drops each candidate out of the fold, so
// a swept escalation is never re-read. At most ONE `removeLabel` per resolved escalation, ever.
import type { SapwoodConfig } from "../config/config.js";
import type { IForge } from "../forge/forge.js";
import type { State } from "../state/state.js";
import { CLEAR_KINDS, ESCALATION_SOURCES, openEscalations, RESOLVED_KIND } from "./escalation-reconcile.js";

/** The sweep's own receipt — appended only after the label removal returned. It is the latch (see
 *  the module doc's ordering note), and it is scoped to `(source, issue)` so a later
 *  re-escalation of the same key gets its own sweep rather than inheriting this one's. */
export const SWEPT_KIND = "needs-human-swept";

/** Every event kind the fold below reads. Exported so a caller reads the ledger ONCE and hands
 *  the same array to both folds (`openEscalations` ignores kinds it does not know). */
export const SWEEP_EVENT_KINDS = [...Object.keys(ESCALATION_SOURCES), ...CLEAR_KINDS, RESOLVED_KIND, SWEPT_KIND];

/** The ONLY resolution witnesses that authorize removing the engine's hold — an allowlist, so a
 *  `via` this module has never heard of (a future arm, a legacy ledger row) can never sweep.
 *
 *  #441 review round 2 (Codex P1, blocking): ownership proof is necessary but NOT sufficient. The
 *  engine may have provably applied the label AND the escalation may be provably over as a strip
 *  row, and it can still be wrong to lift the hold — because "no longer an open attention item"
 *  and "a person released this work back to automation" are different facts. The witness must be
 *  the second one:
 *    - `merged` — the work landed. Producers cannot merge (guard.ts blocks `gh pr merge`), so a
 *      merge is a reviewer/merger act by construction.
 *    - `issue-closed` — the work item was closed, and `gh issue close|reopen|transfer|delete` is
 *      blocked outright for producers (#353), so this is an engine/human act.
 *  Everything else is excluded, each for its own reason:
 *    - `pr-closed` — the P1. A CLOSED PR is neither terminal (it can reopen) nor authorized (the
 *      guard permits `gh pr close`, so a producer can close its own PR) nor complete (the merge
 *      gate maps every non-OPEN PR to HUMAN — "never touch"). Sweeping it would let a lane clear
 *      its OWN human gate: GATED RECLAIM reads the label's absence as authorization, reclaims the
 *      still-CLOSED PR, DRIVE re-derives HUMAN, re-escalates, and the sweep clears it again —
 *      churn until `gated-reentry-capped` latches the row permanently AND has its own fresh label
 *      swept, leaving the lane both invisible and unlabelled. The label stays: a closed-unmerged
 *      PR still owes a human decision.
 *    - `board-fixed` — only ever reachable for merge-produced `rollback-escalated`, which is
 *      `never`-proof and so unreachable here anyway; excluded explicitly rather than by accident.
 *    - `label-removed` — that resolution IS the observation that the hold set is already gone.
 *    - a bare legacy `"closed"` (written before this split) — genuinely ambiguous: the ledger
 *      cannot say whether a PR or the issue closed. Fails closed, permanently, by design. The
 *      cost is a stale label on pre-existing rows that a human clears once; the alternative is
 *      replaying the P1 against every historical PR closure on upgrade. */
const SWEEPABLE_VIA: ReadonlySet<string> = new Set(["merged", "issue-closed"]);

export interface SweepableHold {
  /** The escalation kind whose label this is — the ownership key. */
  source: string;
  issue: number;
  /** The authorizing witness — always a member of `SWEEPABLE_VIA`; carried into the receipt so
   *  the audit trail records WHICH release justified the write. */
  via: string;
}

function payloadString(payload: Record<string, unknown> | null, key: string): string | undefined {
  const v = payload?.[key];
  return typeof v === "string" ? v : undefined;
}

/** Resolved escalations whose `needs-human` label the engine provably applied and has not yet
 *  swept, keyed `${source}:${issue}` — a last-event-wins fold over the durable ledger, the same
 *  shape (and for the same re-escalation reason) as `openEscalations`.
 *
 *  TWO independent conditions must hold, and the fold enforces both: the engine must PROVABLY own
 *  the label (`ESCALATION_SOURCES`, from the key's OWN latest escalation event — so a
 *  `drive-needs-human` re-escalating with `labeled: 0` cannot inherit an earlier proof), and the
 *  resolution must carry an AUTHORIZING witness (`SWEEPABLE_VIA` — proof of ownership alone is
 *  not permission to lift a hold; see that constant's doc for the round-2 P1 this closes).
 *
 *  Three things drop a key back out: a later escalation for it (the label is a live hold again),
 *  its own receipt (already swept), and any resolution whose `via` is not in `SWEEPABLE_VIA`.
 *
 *  A resolution whose escalation event is not in the ledger at all (a truncated or hand-edited
 *  history) yields NO proof and is therefore never swept — fail closed, exactly as the module
 *  doc's ownership rule requires. So does a legacy `via: "closed"` row from before the
 *  pr-closed/issue-closed split, for the reason `SWEEPABLE_VIA` records. */
export function sweepableHolds(events: readonly { kind: string; payload: unknown }[]): Map<string, SweepableHold> {
  const proven = new Map<string, boolean>();
  const sweepable = new Map<string, SweepableHold>();
  for (const e of events) {
    const payload = (e.payload ?? null) as Record<string, unknown> | null;
    const issue = payload?.issue;
    if (typeof issue !== "number" || !Number.isFinite(issue)) continue;
    if (e.kind === SWEPT_KIND || e.kind === RESOLVED_KIND) {
      const source = payloadString(payload, "source");
      if (source === undefined) continue;
      const key = `${source}:${issue}`;
      const via = payloadString(payload, "via");
      if (e.kind === SWEPT_KIND || via === undefined || !SWEEPABLE_VIA.has(via) || proven.get(key) !== true) {
        sweepable.delete(key);
        continue;
      }
      sweepable.set(key, { source, issue, via });
      continue;
    }
    const proof = ESCALATION_SOURCES[e.kind];
    if (proof === undefined) continue;
    const key = `${e.kind}:${issue}`;
    proven.set(key, proof === "always" || (proof === "payload" && payload?.labeled === 1));
    sweepable.delete(key); // escalated again: the label is a LIVE hold once more
  }
  return sweepable;
}

/** Remove the engine's own `needs-human` label from every escalation the ledger says is resolved,
 *  then latch each removal with a `needs-human-swept` receipt. Called at the SAME call sites as
 *  `reconcileEscalations` and immediately after it, so a resolution observed in a pass is swept in
 *  that same pass. Never throws: a per-issue write failure degrades to "left for the next pass"
 *  (logged, no receipt), exactly like the reconciler's own read failures. */
export async function sweepResolvedHolds(
  forge: Pick<IForge, "removeLabel">,
  state: Pick<State, "eventsAfterId" | "appendEvent">,
  cfg: SapwoodConfig,
  log?: (message: string) => void,
): Promise<void> {
  const warn = log ?? console.error;
  let sweepable: Map<string, SweepableHold>;
  let heldIssues: Set<number>;
  try {
    const events = state.eventsAfterId(0, SWEEP_EVENT_KINDS);
    sweepable = sweepableHolds(events);
    // Any escalation still open on the issue owns the label too — see the module doc's second
    // blind spot. Derived from the SAME event array so the two folds can never disagree.
    heldIssues = new Set([...openEscalations(events).values()].map((esc) => esc.issue));
  } catch (e) {
    // Fail closed, same stance as the reconciler: an unreadable ledger cannot justify a write.
    warn(`[sapwood:escalation] failed to read the escalation ledger — swept no labels this pass: ${String(e)}`);
    return;
  }
  // Grouped by ISSUE, because the label is: two resolved escalations on one issue share one
  // carrier, so they share ONE removal — and then latch SEPARATELY, since a later re-escalation
  // of either source must be able to earn its own sweep. A failed removal writes no receipt at
  // all, so the whole group is retried next pass.
  const byIssue = new Map<number, SweepableHold[]>();
  for (const hold of sweepable.values()) {
    if (heldIssues.has(hold.issue)) continue;
    const group = byIssue.get(hold.issue);
    if (group === undefined) byIssue.set(hold.issue, [hold]);
    else group.push(hold);
  }
  for (const [issue, holds] of byIssue) {
    try {
      await forge.removeLabel(issue, cfg.labels.needsHuman);
    } catch (e) {
      warn(`[sapwood:escalation] failed to sweep ${cfg.labels.needsHuman} from #${issue} — retried next pass: ${String(e)}`);
      continue;
    }
    for (const hold of holds) {
      try {
        state.appendEvent(SWEPT_KIND, { issue, source: hold.source, via: hold.via, label: cfg.labels.needsHuman });
      } catch {
        // Best-effort latch: a lost receipt costs one repeated (idempotent) removal next pass.
      }
    }
  }
}
