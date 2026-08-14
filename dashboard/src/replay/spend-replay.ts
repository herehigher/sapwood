/**
 * Replay's spend fold (issue #741, split 2/4 of #146; frontend-design.md §8/§11) — `spend_ledger`
 * is append-only like `events`, so it replays the same way: truncate by the cursor, bucket by
 * phase. Two pieces, matching the two data-contract rules verbatim:
 *
 * - **Cursor alignment** (§8): "the replay cursor maps event → spend position by timestamp
 *   (`spend_ledger.ts <= current event's ts`) — display-grade alignment, no cross-table join."
 * - **Phase bucketing** (§8): "a spend row belongs to the phase whose `round-phase` window ...
 *   contains its `ts` ... rows outside any known phase window — all pre-#206 history — bucket as
 *   'unattributed', drawn last and labeled."
 */

import type { SpendRow } from "../api/types.ts";
import type { DomainEvent } from "../domain-event.ts";

export const UNATTRIBUTED_PHASE = "unattributed";

/** Rows whose `ts` is `<=` `cursorTs` — the display-grade cursor mapping, no join table.
 *  `sortedRows` must be sorted ascending by `ts` (the `/api/spend` wire order already is, since
 *  `spend_ledger` ids are assigned in insertion/time order). Binary search: this runs once per
 *  playback frame, so a linear scan would re-introduce the same sawtooth `player.ts`'s
 *  `advanceFrame` was written to avoid. */
export function spendThroughTs(sortedRows: readonly SpendRow[], cursorTs: string): SpendRow[] {
  let lo = 0;
  let hi = sortedRows.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sortedRows[mid]!.ts <= cursorTs) lo = mid + 1;
    else hi = mid;
  }
  return sortedRows.slice(0, lo);
}

/** One phase's replay window — `[startTs, endTs)`, `endTs: null` for the still-open (latest)
 *  phase, which extends to whatever the cursor currently is. */
export interface PhaseWindow {
  phase: string;
  startTs: string;
  endTs: string | null;
}

/**
 * Builds the phase windows from the event log's full `round-phase` trail (§11 follow-up #1:
 * "the initial `aligning` at round open, every transition, and the terminal `closed`" — the
 * events carry the whole windowing information, no `rounds.phase` mutable read needed). Sorted by
 * event id (insertion order), so a rerun-not-resume re-emission of the same phase (§11: "the
 * engine deliberately does not deduplicate") simply opens a fresh window rather than being
 * folded away — later spend correctly attributes to whichever window it actually falls in.
 * Events before the first `round-phase` produce no window at all; their spend buckets
 * "unattributed" downstream, same as any row with no matching window.
 */
export function buildPhaseWindows(events: readonly DomainEvent[]): PhaseWindow[] {
  const phaseEvents = events
    .filter((e): e is DomainEvent & { payload: { phase: string } } => e.kind === "round-phase" && typeof e.payload?.phase === "string")
    .slice()
    .sort((a, b) => a.id - b.id);
  return phaseEvents.map((e, i) => ({
    phase: e.payload.phase,
    startTs: e.ts,
    endTs: phaseEvents[i + 1]?.ts ?? null,
  }));
}

export interface PhaseSpendBucket {
  phase: string;
  rows: SpendRow[];
}

/**
 * Buckets `rows` by the phase window containing their `ts`. A row with no containing window —
 * every pre-#206 row, and any row before the log's first `round-phase` event — lands in the
 * `UNATTRIBUTED_PHASE` bucket, appended LAST (§8: "drawn last and labeled"; never silently
 * merged into a real phase, which the doc calls out as strictly worse than an honest leftover).
 */
export function bucketSpendByPhase(rows: readonly SpendRow[], windows: readonly PhaseWindow[]): PhaseSpendBucket[] {
  const byPhase = new Map<string, SpendRow[]>();
  const unattributed: SpendRow[] = [];
  for (const row of rows) {
    const window = windows.find((w) => row.ts >= w.startTs && (w.endTs === null || row.ts < w.endTs));
    if (!window) {
      unattributed.push(row);
      continue;
    }
    const bucket = byPhase.get(window.phase);
    if (bucket) bucket.push(row);
    else byPhase.set(window.phase, [row]);
  }
  const buckets: PhaseSpendBucket[] = [...byPhase.entries()].map(([phase, phaseRows]) => ({ phase, rows: phaseRows }));
  if (unattributed.length > 0) buckets.push({ phase: UNATTRIBUTED_PHASE, rows: unattributed });
  return buckets;
}

/**
 * Buckets EACH round's own spend against ITS OWN phase windows independently, then merges the
 * per-phase totals across rounds — the structurally honest fix for #888 gate② run 949439c8
 * finding [0]/its same-timestamp-boundary follow-up. A round's own {spend, phaseWindows} pair
 * (`App.tsx`'s `loadClosedRoundCostLog`) already carries the correct ID-based partition — spend is
 * bounded by the NEXT round's own `startSpendId`, never by timestamp — but concatenating several
 * rounds' `spend`/`phaseWindows` arrays together BEFORE a single `bucketSpendByPhase` call (the
 * prior shape) discards that partition: `bucketSpendByPhase`'s window match is timestamp-only, so
 * an EARLIER round's still-open trailing window can swallow a LATER round's real spend, and ANY
 * fix that instead caps that trailing window at a timestamp reintroduces the identical leak at the
 * exact tie (a round-A row whose `ts` equals round B's own `startedAt`) — a timestamp boundary can
 * never fully stand in for the ID partition. Bucketing round-by-round and merging AFTER never lets
 * one round's windows see another round's spend at all, so no timestamp tie is possible.
 */
export function mergeRoundPhaseBuckets(
  rounds: readonly { spend: readonly SpendRow[]; phaseWindows: readonly PhaseWindow[] }[],
): PhaseSpendBucket[] {
  const byPhase = new Map<string, SpendRow[]>();
  const order: string[] = [];
  for (const { spend, phaseWindows } of rounds) {
    for (const bucket of bucketSpendByPhase(spend, phaseWindows)) {
      const existing = byPhase.get(bucket.phase);
      if (existing) existing.push(...bucket.rows);
      else {
        byPhase.set(bucket.phase, [...bucket.rows]);
        order.push(bucket.phase);
      }
    }
  }
  const buckets: PhaseSpendBucket[] = order
    .filter((phase) => phase !== UNATTRIBUTED_PHASE)
    .map((phase) => ({ phase, rows: byPhase.get(phase)! }));
  const unattributed = byPhase.get(UNATTRIBUTED_PHASE);
  if (unattributed) buckets.push({ phase: UNATTRIBUTED_PHASE, rows: unattributed });
  return buckets;
}

/** `{ label, usd }` bars, summed per bucket — the shape `CostStrip`'s `CostBarGroup.bars` wants,
 *  without this module importing the component layer (`api`/`replay` stay upstream of
 *  `components` — see §9's tree). */
export function phaseSpendBars(buckets: readonly PhaseSpendBucket[]): { label: string; usd: number }[] {
  return buckets.map((b) => ({ label: b.phase, usd: b.rows.reduce((sum, r) => sum + r.usd, 0) }));
}
