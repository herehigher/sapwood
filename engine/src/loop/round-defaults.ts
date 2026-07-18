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

import type { SapwoodConfig } from "../config/config.js";
import { loadDoctrine } from "../config/doctrine.js";
import type { IForge, Issue } from "../forge/forge.js";
import { labelsInclude } from "../forge/labels.js";
import { createRetroStub } from "../retro/retro.js";
import { capDigest } from "../retro/retro-digest.js";
import { type ArchitectDeps, createArchitectStub, NO_PRIOR_ROUND_YET } from "../roles/architect.js";
import type { RoleRunner } from "../roles/peripheral.js";
import { createPlanReviewStub } from "../roles/plan-review.js";
import type { State } from "../state/state.js";
import { alignMarker, createAligningStub, runPoolSelection } from "./align.js";
import { reconcileDurableConcerns, scanForAdjudication } from "./dissent.js";
import { createHarvestStub } from "./harvest.js";
import { type PeripheralPhase, type PeripheralStub, RoundScopedForge } from "./round.js";
import { type AlignSection, mergeAlignSummary, type RoundArtifact, RoundArtifactSchema } from "./round-artifact.js";

export interface DefaultPeripheralsDeps {
  forge: IForge;
  state: State;
  cfg: SapwoodConfig;
  /** Injected so tests can fake the underlying session, same "fake the collaborator, not the
   *  CLI" split every other role module's Deps uses. A real caller passes a real RoleRunner. */
  runner: Pick<RoleRunner, "run">;
  now?: () => Date;
  log?: (message: string) => void;
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
      return `This round's PO/goal-alignment pass (round ${roundId}) ran and decomposed nothing: ` + `no issues created, no plans triaged.`;
    }
    return [
      `This round's PO/goal-alignment pass (round ${roundId}) recorded:`,
      ...created.map(
        (c) => `- created #${c.issue} — ${c.title}${c.hasPlan ? "" : " (no verification plan yet; labelled for human attention)"}`,
      ),
      ...triaged.map(
        (t) => `- triaged #${t.issue}${t.drafted ? ": plan drafted into the body" : ": still planless (re-matches next round)"}`,
      ),
    ].join("\n");
  } catch {
    return null; // contained — the caller's pointer-note fallback covers a state read failure
  }
}

/** #132 (M5 item 12 — "the architect's second mission"): renders the architect's
 *  `round.lastMerged` context from the PREVIOUS round's persisted summary artifact
 *  (round-artifact.ts's `round_artifacts` table / RoundArtifactSchema, #123's durable ledger) —
 *  never a live forge read (the architect session itself fetches nothing; this is engine-side,
 *  deterministic, compute-at-read assembly, same shape as renderAlignedGoalsFromSummary above:
 *  no new writes, no counters, so a crash-rerun of the architecting phase re-assembles
 *  identically). Scoped deliberately to what the artifact's `merges` field actually stores —
 *  `{issue, worker, pr}` triples (conductor.ts's "merged" event payload carries no title and no
 *  files-touched, so neither is persisted anywhere this reads from); a live forge call to
 *  backfill those would violate the "session fetches nothing" invariant for a nice-to-have, so
 *  this module deliberately does not add one. Titles/files-touched are NOT rendered — numbers
 *  and outcomes only, sufficient for a drift review, not a diff review.
 *
 *  Three outcomes, exported for tests:
 *    1. `roundId <= 1` (no possible prior round) OR the prior round's artifact row is simply
 *       missing (harvest disabled — #127 — or persistence failed, or a corrupt/unparseable row)
 *       -> the SAME explicit `NO_PRIOR_ROUND_YET` placeholder architect.ts's own default uses —
 *       from the architect's point of view "no prior round" and "prior round's data didn't
 *       survive" are indistinguishable, and both must degrade, never throw.
 *    2. The prior round closed with zero merges -> a DISTINCT "merged nothing" placeholder.
 *    3. One or more merges -> a rendered, deterministically-truncated list.
 *
 *  Gate② P2 (PR #166): capDigest is applied at the RETURN BOUNDARY, uniformly to every branch —
 *  the placeholders and the zero-merges sentence too, not just the merges render — so the
 *  "bounded assembly" acceptance criterion holds on EVERY path. A cap configured below a
 *  placeholder's own length is a degenerate-but-legal user choice; it yields the usual
 *  deterministic marked-cut text rather than an unbounded exception to the configured bound. */
export function renderLastMergedFromArtifact(state: State, roundId: number, maxChars: number): string {
  return capDigest(renderLastMergedUncapped(state, roundId), maxChars);
}

function renderLastMergedUncapped(state: State, roundId: number): string {
  if (roundId <= 1) return NO_PRIOR_ROUND_YET;
  const prevRoundId = roundId - 1;
  let row: { schemaVersion: number; json: string } | undefined;
  try {
    row = state.getRoundArtifact(prevRoundId);
  } catch {
    return NO_PRIOR_ROUND_YET; // contained — a state read failure degrades, never throws
  }
  if (!row) return NO_PRIOR_ROUND_YET;
  let artifact: RoundArtifact;
  try {
    artifact = RoundArtifactSchema.parse(JSON.parse(row.json));
  } catch {
    return NO_PRIOR_ROUND_YET; // corrupt/unparseable row — same degrade, never throws
  }
  if (artifact.merges.length === 0) {
    return `Round ${prevRoundId} closed with zero merged PRs — nothing to post-review from the prior round.`;
  }
  return [
    `Merged outcomes from round ${prevRoundId} (issue/PR numbers and the dispatched worker only — ` +
      `titles and files-touched are not persisted in the round ledger, so they are not rendered here; ` +
      `this text is engine-assembled from the durable round artifact, never a live forge read):`,
    ...artifact.merges.map((m) => `- issue #${m.issue} merged via PR #${m.pr} (worker: ${m.worker})`),
  ].join("\n");
}

/** The shipped default peripherals map: every phase (aligning/architecting/plan_review/
 *  harvesting/retro) wired to its real role-session stub — no noop remains. The top-level
 *  `goal.file` (#128) and `roles.retro`'s own config keys (everyNRounds, etc.) are honored
 *  automatically, since each stub reads them off `deps.cfg` itself; this factory adds no config
 *  surface of its own. */
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
  const forge = deps.cfg.round.milestone ? new RoundScopedForge(deps.forge, deps.cfg.round.milestone) : deps.forge;
  const shared = {
    forge,
    state: deps.state,
    cfg: deps.cfg,
    runner: deps.runner,
    ...(deps.now !== undefined ? { now: deps.now } : {}),
    ...(deps.log !== undefined ? { log: deps.log } : {}),
  };

  // A mutable box the architect stub reads at EVERY invocation (createArchitectStub captures
  // this object by reference, not by value) — set below once this round's aligning phase has
  // run. Safe without any locking: round.ts's SEQUENCE runs aligning fully to completion before
  // architecting starts, in the same single-threaded await chain, for the same round.
  const architectDeps: ArchitectDeps = { ...shared };
  const alignStub = createAligningStub(shared);
  const architectStub = createArchitectStub(architectDeps);

  const peripherals: Partial<Record<PeripheralPhase, PeripheralStub>> = {};

  // #127: roles.<role>.enabled toggles — a disabled role's stub is simply OMITTED from the
  // returned map. round.ts's runPeripheral already defaults any unset phase to
  // noopPeripheralStub (`peripherals[phase] ?? noopPeripheralStub`), so a disabled phase
  // no-ops with its marker set exactly like the pre-#127 skeleton did — no round.ts change.
  // planDrafter has no toggle of its own: it only ever runs from inside the plan_review
  // stub, so roles.planReviewer.enabled is gate⓪'s ONE unit switch.
  //
  // #212 AC7 / #233: the aligning phase's round-pool selection is NEVER gated by
  // roles.po.enabled — "the selection bound must not depend on an optional role". So, unlike
  // every other role below, `aligning` is ALWAYS populated: with the PO on, it runs the real
  // alignStub (goal decomposition + triage) THEN runs pool selection over whatever Ready looks
  // like afterward (align.ts's runPoolSelection); with the PO off, only alignStub's own work is
  // skipped — runPoolSelection still runs unconditionally. #233: runPoolSelection's OWN
  // behavior no longer depends on roles.po.enabled either — it depends on its own switch,
  // `roles.po.poolSelection` (default false): a title-only pool-selection session is now an
  // opt-in experiment (controlled testing found it selects every candidate at every tier, so
  // the deterministic engine-computed selection is the default MAIN path, not a fallback for
  // roles.po.enabled=false specifically). The rerun-not-resume marker check happens HERE (not
  // inside alignStub) so a crash mid-selection (after alignStub's own work already externalized)
  // restarts at THIS phase with a still-null marker and safely redoes only the (idempotent)
  // selection pass, never re-running alignStub's own internally-idempotent proposal/triage logic
  // a second time for nothing.
  peripherals.aligning = {
    async run(ctx) {
      if (ctx.marker != null) return { marker: ctx.marker }; // already externalized this round
      // #237 finding 5 (2026-07-18 adjudication on PR #262): the PO-dissent adjudication scan
      // (dissent.ts's scanForAdjudication) is a ROUND-LEVEL hook, deliberately called HERE —
      // never from inside alignStub.run — so it runs every round regardless of
      // `roles.po.enabled` (alignStub.run is skipped entirely below when it's false) and
      // regardless of whatever alignStub.run does internally (including its own early-return on
      // a corrupt proposal journal — align.ts's own doc comment). Scan-then-bail: this always
      // runs before the rest of the phase, whether or not that rest does anything at all.
      // #237 round-2 adjudication (2026-07-19, finding 1): reconcileDurableConcerns runs FIRST —
      // it's the durable backstop that recovers a concern align.ts's own (session-scoped)
      // postConcerns call could never re-collect after its decision went terminal (see
      // dissent.ts's own module doc) — so any concern it recovers is visible to THIS SAME round's
      // scanForAdjudication call right below, not just a future one.
      await reconcileDurableConcerns(forge, deps.state, deps.cfg, deps.log);
      await scanForAdjudication(forge, deps.state, deps.log);
      const result = deps.cfg.roles.po.enabled ? await alignStub.run(ctx) : { marker: alignMarker(ctx.roundId) };
      await runPoolSelection({
        forge,
        cfg: deps.cfg,
        state: deps.state,
        runner: deps.runner,
        roundId: ctx.roundId,
        ...(deps.now !== undefined ? { now: deps.now } : {}),
        ...(deps.log !== undefined ? { log: deps.log } : {}),
      });
      return result;
    },
  };
  if (deps.cfg.roles.architect.enabled) {
    peripherals.architecting = {
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
        //
        // #127 gate② F3: with the PO role DISABLED the aligning phase never ran at all — the
        // fallback note below ("has run ... no structured summary was recorded") would imply a
        // pass that never happened, and the architect would reason from a fabricated phase.
        // Thread an explicit switched-off statement instead.
        architectDeps.alignedGoals = !deps.cfg.roles.po.enabled
          ? `This deployment has the PO/goal-alignment peripheral switched off ` +
            `(roles.po.enabled: false) — the aligning phase no-oped this round ` +
            `(round ${ctx.roundId}). There is no decomposition/triage record to consult; ` +
            `treat the issue backlog as curated outside the loop.`
          : (renderAlignedGoalsFromSummary(deps.state, ctx.roundId) ??
            `This round's PO/goal-alignment peripheral has run (round ${ctx.roundId}, marker ` +
              `${alignMarker(ctx.roundId)}) — see its issue creations/comments on GitHub for the ` +
              `actual decomposition (no structured summary was recorded this round).`);
        // #132: the PREVIOUS round's merged-PR outcomes (round-artifact.ts's persisted
        // round_artifacts row), computed HERE at architect-invocation time from durable state —
        // same "compute at read, never a same-process side effect" rationale as alignedGoals
        // above (a crash-rerun that resumes directly at architecting must see the same context
        // a from-scratch run would).
        architectDeps.lastMerged = renderLastMergedFromArtifact(deps.state, ctx.roundId, deps.cfg.roles.architect.lastMergedMaxChars);
        // #167: this repo's review-doctrine text — the third engine-assembled block (see
        // ArchitectDeps.doctrine's own doc comment). No round-scoping of its own (the doctrine
        // file doesn't vary per round), but loaded HERE, at architect-invocation time, same as
        // alignedGoals/lastMerged above, so a crash-rerun that resumes directly at architecting
        // re-assembles identically and the load logic stays in doctrine.ts, not duplicated here.
        architectDeps.doctrine = loadDoctrine(deps.cfg.doctrine.file, deps.cfg.doctrine.maxChars);
        // #213: this round's ACTUAL pool (cfg.labels.roundPool members) — computed HERE, at
        // architect-invocation time, from a LIVE forge read, same "compute at read, never a
        // same-process handoff" stance as alignedGoals/lastMerged/doctrine above (a crash-rerun
        // that resumes directly at architecting must see the same live label state a from-scratch
        // run would, not a stale snapshot threaded from an earlier phase). By the time architecting
        // runs, the aligning phase has ALREADY run to completion THIS round (round.ts's phase
        // sequence, same single-threaded await chain) and reconciled the pool label to match its
        // own selection (align.ts's reconcilePoolLabels) — so filtering the live pool-eligible set
        // (#214: widened past gate⓪-dispatchable, see below) by the pool label here IS this
        // round's pool, with no second, separate pool concept needed. A read failure degrades to
        // an EMPTY pool (never a thrown
        // phase) — the architect's own #213 degrade-open contract then simply has nothing to
        // batch-review this pass, the same shape a legitimately empty pool already has.
        // #214: reads the WIDENED pool-eligible set (forge.getPoolEligibleIssues), not
        // getReadyIssues — after gate⓪'s own #214 pool-scoping, an unapproved pool member is a
        // real, live pool member that must still show up in the architect's batch-review digest;
        // filtering the narrower gate⓪-passed-only getReadyIssues here would make it invisible to
        // the architect even though plan-review.ts is about to (or already did) review it this
        // same round. Same live-read-at-invocation-time contract as before (#213) — unchanged.
        let poolIssues: Issue[] = [];
        try {
          const eligible = await forge.getPoolEligibleIssues();
          poolIssues = eligible.filter((i) => labelsInclude(i.labels, deps.cfg.labels.roundPool));
        } catch (e) {
          const reason = `pool-member read failed: ${String(e)}`;
          (deps.log ?? console.error)(
            `[sapwood:architect] round ${ctx.roundId}: ${reason} — batch review proceeds with an empty pool this pass`,
          );
          // #213 Codex review round 2, finding 3: a read failure here degrades the SAME way a
          // genuinely-empty pool does (candidates only, if any) — but with a REAL, non-empty
          // pool sitting on GitHub, that means dispatch proceeds completely unreviewed with only
          // an ephemeral log line as evidence, never the durable `architect-review-degraded`
          // event architect.ts's own degrade paths always pair with a skip. Record the SAME
          // honesty event here too, so this failure mode is durably observable exactly like
          // every other reason the pool ends up unfiltered. Best-effort (mirrors
          // runSessionWithRetry's own degrade-append stance): the log line above is the fallback
          // record if this append itself fails.
          try {
            deps.state.appendEvent("architect-review-degraded", { round_id: ctx.roundId, reason });
          } catch {
            /* best-effort honesty event — the log line above already recorded the failure */
          }
        }
        architectDeps.poolIssues = poolIssues;
        return architectStub.run(ctx);
      },
    };
  }
  if (deps.cfg.roles.planReviewer.enabled) peripherals.plan_review = createPlanReviewStub(shared);
  if (deps.cfg.roles.harvest.enabled) peripherals.harvesting = createHarvestStub(shared);
  if (deps.cfg.roles.retro.enabled) peripherals.retro = createRetroStub(shared);

  // #127 acceptance criterion: disabled state logged ONCE here (this factory runs once at
  // startup, wherever a real caller builds its peripherals map) — never per round/tick.
  const disabledPhases = (
    [
      ["po", "aligning"],
      ["architect", "architecting"],
      ["planReviewer", "plan_review"],
      ["harvest", "harvesting"],
      ["retro", "retro"],
    ] as const
  )
    .filter(([role]) => !deps.cfg.roles[role].enabled)
    .map(([, phase]) => phase);
  if (disabledPhases.length > 0) {
    // #212/#233: `aligning` is a partial exception since AC7 — with the PO off it still runs
    // round-pool selection every round (deterministic by default, or the #233 opt-in session if
    // roles.po.poolSelection: true — either way, independent of this flag); it's the PO's own
    // decomposition/triage work that no-ops, not the whole phase. Worded separately so this
    // line stays literally true for every phase it names.
    const noopPhases = disabledPhases.filter((p) => p !== "aligning");
    let line =
      noopPhases.length > 0
        ? `[sapwood:round] peripheral role(s) disabled by config — these phases will no-op every round: ${noopPhases.join(", ")}`
        : `[sapwood:round] peripheral role(s) disabled by config: ${disabledPhases.join(", ")}`;
    if (disabledPhases.includes("aligning")) {
      line +=
        `. NOTE: aligning still runs its #212 round-pool selection every round with roles.po.enabled: ` +
        `false (deterministic unless roles.po.poolSelection: true) — only the PO's own decomposition/triage passes no-op.`;
    }
    // #127 gate② F1: disabling gate⓪'s roles silently starves ALL dispatch — forge.ts's
    // dispatchability gate still (correctly, PLAN Decision #8) requires the planApproved label
    // (or verifyNa), and only the plan-reviewer applies planApproved; the PO is what triages
    // plan-less issues INTO that pipeline. The gating must not soften, so warn loudly, here,
    // once (this same line — still a single startup log).
    const gateWarnings: string[] = [];
    if (disabledPhases.includes("plan_review")) {
      gateWarnings.push(
        `with plan_review off nothing in the engine ever applies ${deps.cfg.labels.planApproved} — ` +
          `a human/external process MUST apply it (or ${deps.cfg.labels.verifyNa}) or NO issue is ever dispatched`,
      );
    }
    if (disabledPhases.includes("aligning")) {
      gateWarnings.push("with aligning off plan-less issues are never triaged into the gate⓪ pipeline");
    }
    if (gateWarnings.length > 0) line += `. WARNING: ${gateWarnings.join("; ")}.`;
    (deps.log ?? console.log)(line);
  }

  return peripherals;
}
