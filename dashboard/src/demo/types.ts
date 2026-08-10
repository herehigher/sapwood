import type { LoopEvent, LoopState, Round, SpendRow } from "../api/types.ts";

/**
 * The `?demo` static fixture (#742, split 3/4 of #146; frontend-design.md §6 "Launch artifact") —
 * one bundled JSON carrying all three replayable sources (`events`, `spend`, `rounds`) plus a
 * static `loopState` snapshot for the non-replayable surfaces (config, lane count) that
 * `?demo` still needs to render the shell. Wire shapes, verbatim — the same `LoopEvent`/`Round`/
 * `SpendRow` types `/api/*` already serves, so `useDemoReplay` folds them through the exact same
 * `toDomainEvent`/`foldReplay` pipeline live and replay use (§9 "one state reducer").
 */
export interface DemoBundle {
  loopState: LoopState;
  rounds: Round[];
  events: LoopEvent[];
  spend: SpendRow[];
}
