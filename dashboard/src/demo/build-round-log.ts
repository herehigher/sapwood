/**
 * Windows one round's slice out of a fully-in-memory `DemoBundle` — the demo-mode equivalent of
 * `replay/round-log.ts`'s network paging, minus the paging: the whole fixture is already loaded
 * (no `?demo` fetch is per-round), so this is a synchronous filter over `bundle.events`/
 * `bundle.spend` instead of an async `fetchPage` loop. Reuses the SAME window boundaries
 * (`roundEventCeiling`) and the same checkpoint/phase-window builders `useReplay` calls — "the
 * same replay player" (#742's own wording), not a parallel fold.
 */

import type { Round, SpendRow } from "../api/types.ts";
import type { DomainEvent } from "../domain-event.ts";
import { toDomainEvent } from "../domain-event.ts";
import { buildCheckpoints, type Checkpoint } from "../replay/checkpoint.ts";
import { roundEventCeiling } from "../replay/round-log.ts";
import { buildPhaseWindows, type PhaseWindow } from "../replay/spend-replay.ts";
import type { DemoBundle } from "./types.ts";

export interface DemoRoundLog {
  round: Round;
  events: DomainEvent[];
  checkpoints: Checkpoint[];
  spend: SpendRow[];
  phaseWindows: PhaseWindow[];
}

export function buildRoundLog(bundle: DemoBundle, round: Round, lanesMax: number | null): DemoRoundLog {
  const ceilingId = roundEventCeiling(round, bundle.rounds);
  const nextRound = bundle.rounds.filter((r) => r.roundId > round.roundId).sort((a, b) => a.roundId - b.roundId)[0];
  const spendCeilingId = nextRound ? nextRound.startSpendId : null;

  const events = bundle.events
    .filter((e) => e.id >= round.startEventId && (ceilingId === null || e.id <= ceilingId))
    .sort((a, b) => a.id - b.id)
    .map(toDomainEvent);

  const spend = bundle.spend
    .filter((r) => r.id >= round.startSpendId && (spendCeilingId === null || r.id <= spendCeilingId))
    .sort((a, b) => a.ts.localeCompare(b.ts));

  return { round, events, checkpoints: buildCheckpoints(events, lanesMax), spend, phaseWindows: buildPhaseWindows(events) };
}
