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
import { mergeAlignSummary, type AlignSection } from "./round-artifact.js";
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

/** #123 (supersedes the #104 pointer note): render the architect's `round.alignedGoals` context
 *  from the aligning phase's own `align-summary` state event(s) — the PO's actual per-issue
 *  decomposition/triage record, not a pointer. Null when no summary exists for this round
 *  (degraded align, or a state hiccup — the caller falls back to the deterministic pointer
 *  note). Pure read; exported for tests. */
export function renderAlignedGoalsFromSummary(state: State, roundId: number): string | null {
  try {
    const round = state.getRound(roundId);
    if (!round) return null;
    const summaries = state
      .eventsAfterId(round.start_event_id ?? 0, ["align-summary"])
      .filter((e) => (e.payload as { round_id?: number }).round_id === roundId);
    if (summaries.length === 0) return null;
    // MERGED across events (Codex round-6 P2 on PR #152) — same helper the artifact assembler
    // uses, so a crash-rerun's second summary extends rather than erases the first run's work.
    let merged: AlignSection | null = null;
    for (const s of summaries) merged = mergeAlignSummary(merged, s.payload);
    const { created, triaged } = merged!;
    if (created.length === 0 && triaged.length === 0) {
      return `This round's PO/goal-alignment pass (round ${roundId}) ran and decomposed nothing: ` +
        `no issues created, no plans triaged.`;
    }
    return [
      `This round's PO/goal-alignment pass (round ${roundId}) recorded:`,
      ...created.map((c) => `- created #${c.issue} — ${c.title}${c.hasPlan ? "" : " (no verification plan yet; labelled needs-human)"}`),
      ...triaged.map((t) => `- triaged #${t.issue}${t.drafted ? ": plan drafted into the body" : ": still planless (re-matches next round)"}`),
    ].join("\n");
  } catch {
    return null; // contained — the caller's pointer-note fallback covers a state read failure
  }
}

/** The shipped default peripherals map: every phase (aligning/architecting/plan_review/
 *  harvesting/retro) wired to its real role-session stub — no noop remains. `roles.architect`/
 *  `roles.retro`'s own config keys (planMdPath, everyNRounds) are honored automatically, since
 *  each stub reads them off `deps.cfg` itself; this factory adds no config surface of its own. */
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
    aligning: alignStub,
    architecting: {
      async run(ctx) {
        // #123 acceptance criterion 3: thread the aligning phase's ACTUAL structured
        // decomposition detail (its `align-summary` state event — created issues + triage
        // outcomes) through to the architect, replacing the old deterministic pointer note.
        // Computed HERE, at architect-invocation time, from durable state — never as a side
        // effect of the aligning wrapper running in the same process (Codex round-7 P2 on PR
        // #152: a crash between the phases resumes directly at architecting, and a write-time
        // handoff would silently fall back even though the summary event survived). The read
        // is contained: no summary (degraded align, state hiccup) falls back to the pointer
        // note — never fabricated analysis, never a thrown phase.
        architectDeps.alignedGoals =
          renderAlignedGoalsFromSummary(deps.state, ctx.roundId) ??
          `This round's PO/goal-alignment peripheral has run (round ${ctx.roundId}, marker ` +
          `${alignMarker(ctx.roundId)}) — see its issue creations/comments on GitHub for the ` +
          `actual decomposition (no structured summary was recorded this round).`;
        return architectStub.run(ctx);
      },
    },
    plan_review: createPlanReviewStub(shared),
    harvesting: createHarvestStub(shared),
    retro: createRetroStub(shared),
  };
}
