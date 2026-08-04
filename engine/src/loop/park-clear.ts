// park-clear.ts (#475): the ENGINE-OWNED operator clear for a park episode — the protocol half
// of `sapwood park clear` (the CLI half, including the single-instance-lock coordination, is
// cli.ts's runPark).
//
// Why this exists. PR #473 (#407) shipped the consecutive-stalls park with an operator-explicit
// clearing story whose only documented action was raw SQL against a live DB
// (`DELETE FROM park_state WHERE source='consecutive-stalls'`) followed by a restart. Codex's
// confirmation pass flagged the residual: run against a RUNNING engine, a dispatch gate can
// observe the absent row before the restart records the `park-resumed {via:"operator-clear"}`
// receipt and takes down the escalation marker — a window in which dispatch is un-gated with no
// receipt yet logged. The doc mandating a restart made it acceptable for v1; owning the operation
// removes it.
//
// The order is the STARTUP PATH's order, verbatim (stall-breaker.ts's operator-clear branch,
// rapid-restart.ts's window-clear branch): receipt -> row -> marker. `clearPark` is the single
// choke point that does the last two, so this module appends the receipt and then calls it —
// there is no second implementation of the clear, and the ordering guarantee is the same one
// #431 round 4 argued for: a kill between the two writes leaves an episode CLOSED IN THE LOG
// with a stray row, which the next engine start deletes silently (the receipt dedup prevents a
// duplicate). The reverse order is the failure this replaces — a deleted row with no receipt.
//
// Deliberately NOT here: the reverse healing direction. A row deleted BY HAND (the break-glass
// fallback the docs keep) is still recognized and receipted by the startup path exactly as #473
// shipped it — this module adds a sanctioned channel, it does not remove the unsanctioned one.
import type { ParkRow, ParkSource, State } from "../state/state.js";

/** The receipt's `via` discriminator — the SAME value the startup path writes, on purpose: a
 *  ledger reader cannot tell (and must not need to tell) whether the operator used the verb or
 *  the break-glass DELETE. Both are "a human cleared this". */
export const OPERATOR_CLEAR_VIA = "operator-clear";

/** Clear `source` (or EVERY open episode when null), receipt-first. Returns the episodes that
 *  were actually open and got cleared — empty is a legitimate no-op, never an error: clearing an
 *  already-clear park is idempotent.
 *
 *  `clearReason` (#644): the OPERATOR's free-text reason for clearing — distinct from
 *  `row.reason` (why the episode entered park in the first place). Advisory for a human running
 *  the CLI by hand; the #644 owner ruling makes it REQUIRED practice for an LLM supervisor
 *  session (docs/supervision.md's governance section) — auditability for a trusted-operator
 *  intervention, not a machine-enforced gate here. Omitted entirely (never a null/undefined key)
 *  when the caller passes none, so an existing reader of this payload shape sees the exact same
 *  JSON pre-#644 produced — the reverse test cli.ts's runPark relies on. */
export function clearParksReceiptFirst(
  state: Pick<State, "parkedSources" | "appendEvent" | "clearPark">,
  source: ParkSource | null,
  clearReason?: string,
): ParkRow[] {
  const open = state.parkedSources().filter((p) => source === null || p.source === source);
  for (const row of open) {
    // Receipt FIRST. Payload shape matches the startup path's (source/enteredAt/via) so the
    // per-source episode folds — stall-breaker.ts's and rapid-restart.ts's openEpisodeInLog,
    // both keyed on `payload.source` — close on it without knowing which writer produced it.
    // `clearReason` rides alongside, never replacing any of those three keys.
    state.appendEvent("park-resumed", {
      source: row.source,
      enteredAt: row.enteredAt,
      via: OPERATOR_CLEAR_VIA,
      ...(clearReason !== undefined ? { clearReason } : {}),
    });
    state.clearPark(row.source); // row, then (when this was the last episode) the ESCALATION marker
  }
  return open;
}
