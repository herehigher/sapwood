// round-defaults.ts (#104): constructs the REAL default peripheral stubs for runRounds's
// `peripherals` map — aligning (createAligningStub), architecting (createArchitectStub),
// plan_review (createPlanReviewStub), harvesting (createHarvestStub), retro (createRetroStub) —
// sharing one RoleRunner/State/forge/cfg. round.ts itself is UNCHANGED and keeps defaulting any
// UNSET phase to noopPeripheralStub (deps.peripherals ?? {}) — this factory is what a caller
// that wants a REAL round (not a bare skeleton test) uses to build a fully-populated map with no
// noop left in it. Explicit test overrides (round.ts's own `deps.peripherals`) keep working
// exactly as before: a caller can still pass a partial map, or its own fakes, unaffected by this
// module's existence.
//
// Kept deliberately separate from round.ts itself (rather than folded into runRounds's own
// defaulting): round.ts's only job is the round-loop MECHANICS (phase sequencing, rerun-not-
// resume, stop conditions) and stays free of every role module's own dependencies; this factory
// is the wiring layer a real entry point (or an integration test) reaches for instead.
import type { IForge } from "./forge.js";
import type { State } from "./state.js";
import type { SapwoodConfig } from "./config.js";
import type { RoleRunner } from "./peripheral.js";
import { RoundScopedForge, type PeripheralPhase, type PeripheralStub } from "./round.js";
import { createAligningStub, alignMarker } from "./align.js";
import { createArchitectStub, type ArchitectDeps } from "./architect.js";
import { createPlanReviewStub } from "./plan-review.js";
import { createHarvestStub } from "./harvest.js";
import { createRetroStub } from "./retro.js";

export interface DefaultPeripheralsDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session, same "fake the collaborator, not the
   *  CLI" split every other role module's Deps uses. A real caller passes a real RoleRunner. */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
}

/** The shipped default peripherals map: every phase (aligning/architecting/plan_review/
 *  harvesting/retro) wired to its real role-session stub — no noop remains. `roles.architect`/
 *  `roles.retro`'s own config keys (planMdPath, everyNRounds) are honored automatically, since
 *  each stub reads them off `deps.cfg` itself; this factory adds no config surface of its own.
 *
 *  Feeds the architect stub `alignedGoals` from the aligning phase's own output WHERE
 *  AVAILABLE (#104 scope item 1): the PO/aligning session has no structured return channel
 *  (peripheral.ts's module doc — its output is GitHub side effects, not text this process gets
 *  back), so "available" means a short, deterministic, traceable note — never fabricated
 *  analysis — set once THIS round's aligning phase has actually run, immediately before
 *  architecting runs next in round.ts's own SEQUENCE. Before that (the very first phase, or a
 *  caller that never wires aligning at all), the architect stub falls back to its own built-in
 *  "not available" placeholder, unchanged. */
export function createDefaultPeripherals(deps: DefaultPeripheralsDeps): Partial<Record<PeripheralPhase, PeripheralStub>> {
  // #109 gate② P2: scope the PERIPHERALS' forge to cfg.round.milestone, exactly like runRounds
  // scopes its own tick forge (round.ts:runRounds wraps deps.forge independently — that wrap
  // covers dispatch only, never these stubs). Without this, a milestone-scoped run's PO triage /
  // plan-review candidates come from the WHOLE repo: the peripherals could comment on, draft
  // plans into, or plan:approve issues outside the round's milestone. Wrapping here (not at each
  // caller) fixes every wiring site at once and keeps cli.ts dumb. Double-wrapping an
  // already-scoped forge with the same milestone would be harmless (the filter is idempotent),
  // but no caller does that today: runRounds wraps the raw forge for its ticks, this factory
  // wraps the same raw forge for the stubs — two independent single wraps.
  const forge = deps.cfg.round.milestone
    ? new RoundScopedForge(deps.forge, deps.cfg.round.milestone)
    : deps.forge;
  const shared = {
    forge,
    state: deps.state,
    cfg: deps.cfg,
    runner: deps.runner,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  };

  // A mutable box the architect stub reads at EVERY invocation (createArchitectStub captures
  // this object by reference, not by value) — set below once this round's aligning phase has
  // run. Safe without any locking: round.ts's SEQUENCE runs aligning fully to completion before
  // architecting starts, in the same single-threaded await chain, for the same round.
  const architectDeps: ArchitectDeps = { ...shared };
  const alignStub = createAligningStub(shared);
  const architectStub = createArchitectStub(architectDeps);

  return {
    aligning: {
      async run(ctx) {
        const result = await alignStub.run(ctx);
        architectDeps.alignedGoals =
          `This round's PO/goal-alignment peripheral has run (round ${ctx.roundId}, marker ` +
          `${alignMarker(ctx.roundId)}) — see its issue creations/comments on GitHub for the ` +
          `actual decomposition (the session has no structured text return channel).`;
        return result;
      },
    },
    architecting: architectStub,
    plan_review: createPlanReviewStub(shared),
    harvesting: createHarvestStub(shared),
    retro: createRetroStub(shared),
  };
}
