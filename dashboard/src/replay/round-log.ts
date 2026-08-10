/**
 * The transport's one-time network load of a closed round's full replayable window — pages
 * `/api/events`/`/api/spend` (via the caller's own fetch functions, so this stays DOM/network-free
 * and directly testable) from the round's #123 cursors until the round's own `eventCount` /
 * ceiling is covered. Once loaded, `player.ts`'s `advanceFrame`/`scrubTo` drive the whole replay
 * from this in-memory array — no further requests per frame or per scrub.
 */

import type { EventsPage, Round, SpendPage, SpendRow } from "../api/types.ts";
import { type DomainEvent, toDomainEvent } from "../domain-event.ts";

/** The exclusive upper bound event id for `round`'s window: the next round's `startEventId`, or
 *  `null` when `round` is the newest round (open-ended — capped by whatever the log currently
 *  holds). Mirrors `listRounds`'s own `event_count` derivation (`engine/src/state/state.ts`). */
export function roundEventCeiling(round: Round, allRounds: readonly Round[]): number | null {
  const next = allRounds.filter((r) => r.roundId > round.roundId).sort((a, b) => a.roundId - b.roundId)[0];
  return next ? next.startEventId : null;
}

/** Pages events from `round.startEventId` until `round.eventCount` have been collected (or the
 *  server stops returning fresh rows) — sorted ascending by id, ready for `buildCheckpoints`. */
export async function loadRoundEvents(
  round: Round,
  ceilingId: number | null,
  fetchPage: (after: number, limit: number) => Promise<EventsPage>,
  pageSize = 500,
): Promise<DomainEvent[]> {
  const collected: DomainEvent[] = [];
  let after = round.startEventId;
  while (collected.length < round.eventCount) {
    const page = await fetchPage(after, pageSize);
    if (page.events.length === 0 || page.lastId === after) break;
    for (const e of page.events) {
      if (ceilingId !== null && e.id > ceilingId) continue;
      collected.push(toDomainEvent(e));
    }
    after = page.lastId;
  }
  return collected.sort((a, b) => a.id - b.id);
}

/** Pages spend rows from `round.startSpendId` through the ceiling round's own `startSpendId` (or
 *  to the end of the ledger, for the newest round) — sorted ascending by `ts` for
 *  `spendThroughTs`'s binary search. */
export async function loadRoundSpend(
  round: Round,
  spendCeilingId: number | null,
  fetchPage: (after: number, limit: number) => Promise<SpendPage>,
  pageSize = 500,
): Promise<SpendRow[]> {
  const collected: SpendRow[] = [];
  let after = round.startSpendId;
  for (;;) {
    const page = await fetchPage(after, pageSize);
    if (page.spend.length === 0 || page.lastId === after) break;
    for (const row of page.spend) {
      if (spendCeilingId !== null && row.id > spendCeilingId) continue;
      collected.push(row);
    }
    after = page.lastId;
    if (spendCeilingId !== null && after >= spendCeilingId) break;
  }
  return collected.sort((a, b) => a.ts.localeCompare(b.ts));
}
