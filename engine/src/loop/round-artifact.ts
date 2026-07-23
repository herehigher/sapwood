// round-artifact.ts (#123, M5 item 3): the engine-built round summary artifact — a single,
// schema-validated JSON record of a closed round's full mechanical history (dispatches, merges,
// retries, review-fallback episodes, escalations, spend, degradations, the retro proposal
// outcome, and the aligning phase's decomposition/triage summary), assembled PURELY from the
// round's own durable event-ledger rows (+ its `rounds` row + the round cost config) — NO new
// event kinds, no forge reads, no session output. JSON is the source of truth; the markdown view
// (renderRoundArtifactMarkdown) is a deterministic RENDER of it, never independently authored.
//
// Two entry points, one pure core:
//   - assembleRoundArtifact: ledger ROWS in -> artifact out. No state/forge access of its own —
//     a fixture-ledger unit test constructs the `events` array literally, no mocks needed.
//   - buildRoundArtifact: the thin state-reading wrapper (eventsSince + spentUsdSince) real
//     callers use — harvest.ts calls it MID-round (endedAt: null, unpersisted — just to render
//     its own prompt input) and round.ts calls it again at ACTUAL close (endedAt: the close
//     timestamp, then persisted via persistRoundArtifact) to produce the durable, final record.
//
// SCOPE (design guidance #6): strictly the events between this round's OWN started_at and its
// close — never the standby-wait/-exit events round.ts appends between rounds (those belong to
// the RUN, not any one round; they are simply never in ROUND_ARTIFACT_EVENT_KINDS below) and
// never another round's activity (gated-reentry events are naturally time-scoped: whichever
// round is open when a reentry tick fires is the round that gets credited, which is correct —
// there is no cross-round bleed to guard against here).
//
// #17 dashboard data contract: this module's zod schema (RoundArtifactSchema) IS that contract,
// documented in docs/round-artifact.md — any change here is a change to that contract.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { capDigest } from "../retro/retro-digest.js";
import type { RoundRow, State } from "../state/state.js";

export const ROUND_ARTIFACT_SCHEMA_VERSION = 1;

const IssueWorker = z.object({ issue: z.number().int(), worker: z.string() }).strict();
const IssueWorkerPr = z.object({ issue: z.number().int(), worker: z.string(), pr: z.number().int() }).strict();

export const RoundArtifactSchema = z
  .object({
    schemaVersion: z.literal(ROUND_ARTIFACT_SCHEMA_VERSION),
    roundId: z.number().int().positive(),
    startedAt: z.string(),
    /** null when assembled BEFORE the round actually closed (harvest's mid-round read) — the
     *  persisted, final artifact (round.ts's close-time build) always sets this. */
    endedAt: z.string().nullable(),
    dispatches: z.array(IssueWorker),
    merges: z.array(IssueWorkerPr),
    prsOpened: z.number().int().nonnegative(),
    prsMerged: z.number().int().nonnegative(),
    issuesClosed: z.number().int().nonnegative(),
    spendUsd: z.number().nonnegative(),
    roundBudgetUsd: z.number().nonnegative(),
    retries: z
      .object({
        gatedReentries: z.number().int().nonnegative(),
        gatedReentryCapped: z.number().int().nonnegative(),
        rollbacksRecovered: z.number().int().nonnegative(),
        rollbacksEscalated: z.number().int().nonnegative(),
      })
      .strict(),
    reviewRounds: z
      .object({
        reviewerFallbackSwitches: z.number().int().nonnegative(),
        reviewerFallbackReverts: z.number().int().nonnegative(),
      })
      .strict(),
    escalations: z
      .object({
        needsHuman: z.array(z.number().int()),
        ceiling: z.number().int().nonnegative(),
        driveNoPr: z.number().int().nonnegative(),
      })
      .strict(),
    egressSuspects: z
      .array(
        z
          .object({
            worker: z.string(),
            issue: z.number().int(),
            executable: z.string(),
            snippet: z.string(),
          })
          .strict(),
      )
      .default([]),
    handoffs: z.number().int().nonnegative(),
    degradedPhases: z.array(
      z
        .object({
          phase: z.string(),
          outcome: z.string(),
          session: z.string(),
        })
        .strict(),
    ),
    roundStops: z.array(z.object({ name: z.string(), detail: z.string() }).strict()),
    retro: z
      .object({
        opened: z.object({ pr: z.number().int(), branch: z.string() }).strict().nullable(),
        degraded: z.object({ branch: z.string(), title: z.string(), reason: z.string() }).strict().nullable(),
      })
      .strict(),
    align: z
      .object({
        created: z.array(z.object({ issue: z.number().int(), title: z.string(), hasPlan: z.boolean() }).strict()),
        triaged: z.array(z.object({ issue: z.number().int(), drafted: z.boolean() }).strict()),
      })
      .strict()
      .nullable(),
    // #237: every PO-dissent concern actually POSTED this round (dissent.ts's postConcerns —
    // idempotent by marker, so this is "delivered", not "raised" — a duplicate the marker
    // suppressed never lands here twice). `.default([])` so a PRE-#237 persisted round_artifacts
    // row (round-defaults.ts's RoundArtifactSchema.parse of an old JSON blob) still parses —
    // absent reads as "no objections", the same as an empty array. ONLY concern-posted events
    // whose OWN payload `round_id` matches THIS round (assembleRoundArtifact checks this
    // explicitly, never event-ID-window membership alone) — #237 round-2 adjudication (finding 2)
    // fixed a real misattribution: dissent.ts's reconcileDurableConcerns (the durable sweep) can
    // append a concern-posted event whose event ID falls inside a LATER round's window while its
    // payload still names the concern's true ORIGINAL round — that event belongs in
    // `concernsReconciled` below, never here.
    concerns: z.array(z.object({ issue: z.number().int(), reason: z.string() }).strict()).default([]),
    // #237 round-2 adjudication (2026-07-19, finding 2): concern-posted events that land in THIS
    // round's event-ID window but carry a DIFFERENT round_id in their payload — i.e. the durable
    // sweep (dissent.ts's reconcileDurableConcerns) caught up a receipt (or, rarely, delivered a
    // long-overdue first post) for a concern that actually belongs to an earlier round whose own
    // artifact already closed without it. Listed separately so nothing silently vanishes from the
    // round-summary VIEW, without falsely claiming THIS round raised it. `.default([])` for the
    // same pre-#237 back-compat reason as `concerns` above.
    concernsReconciled: z
      .array(z.object({ issue: z.number().int(), reason: z.string(), originRound: z.number().int() }).strict())
      .default([]),
  })
  .strict();

export type RoundArtifact = z.infer<typeof RoundArtifactSchema>;

/** Event kinds this artifact reads — deliberately excludes standby-wait/standby-exit (run-scoped,
 *  never appended while a round is open) and anything else that isn't part of a round's own
 *  mechanical record (module doc, design guidance #6). */
export const ROUND_ARTIFACT_EVENT_KINDS = [
  "dispatched",
  "merged",
  "reclaim-done",
  "reclaim-failed",
  "reclaim-dead",
  "drive-needs-human",
  "drive-queued",
  "drive-stopped",
  "drive-no-pr",
  "plan-review-escalated",
  "egress-suspect",
  "handoff",
  "ceiling-escalated",
  "gated-reentry",
  "gated-reentry-capped",
  "rollback-recovered",
  "rollback-escalated",
  "reviewer-fallback-switch",
  "reviewer-fallback-revert",
  "round-stop",
  "po-degraded",
  "triage-degraded",
  "architect-degraded",
  "harvest-degraded",
  "retro-degraded",
  "retro-pr-opened",
  "retro-pr-degraded",
  "align-summary",
  // #237: PO-dissent concerns actually delivered this round (dissent.ts's postConcerns).
  "concern-posted",
];

/** Maps a `*-degraded` event kind to the human-readable phase name recorded in the artifact. */
const DEGRADE_PHASE_BY_KIND: Record<string, string> = {
  "po-degraded": "po-align",
  "triage-degraded": "po-triage",
  "architect-degraded": "architect",
  "harvest-degraded": "harvest",
  "retro-degraded": "retro",
};

interface LedgerEvent {
  kind: string;
  payload: unknown;
}

export type AlignSection = NonNullable<RoundArtifact["align"]>;

/** Folds one align-summary payload into an accumulated align section (Codex round-6 P2, PR
 *  #152): created is a by-issue UNION (a crash-rerun's second summary must never erase the
 *  first run's already-landed creations); a triage outcome is by-issue LAST-WINS (the rerun's
 *  fresher attempt supersedes). Shared by the artifact assembler and round-defaults.ts's
 *  architect-context render, so the two can never disagree on merge semantics. */
export function mergeAlignSummary(acc: AlignSection | null, payload: unknown): AlignSection {
  const p = payload as {
    created?: Array<{ issue: number; title: string; hasPlan: boolean }>;
    triaged?: Array<{ issue: number; drafted: boolean }>;
  };
  const merged: AlignSection = acc ?? { created: [], triaged: [] };
  for (const c of p.created ?? []) {
    if (!merged.created.some((x) => x.issue === c.issue)) merged.created.push(c);
  }
  for (const t of p.triaged ?? []) {
    const i = merged.triaged.findIndex((x) => x.issue === t.issue);
    if (i >= 0) merged.triaged[i] = t;
    else merged.triaged.push(t);
  }
  return merged;
}

interface RoundMeta {
  roundId: number;
  startedAt: string;
  endedAt: string | null;
}

/** Pure assembly: ledger ROWS in, artifact out. No state/forge access — the fixture-ledger unit
 *  test constructs `events` literally. `events` is expected to already be scoped to this round's
 *  window (state.eventsSince(round.started_at, ROUND_ARTIFACT_EVENT_KINDS), or an equivalent
 *  fixture array) — this function does no further time-filtering of its own. */
export function assembleRoundArtifact(events: LedgerEvent[], meta: RoundMeta, spendUsd: number, roundBudgetUsd: number): RoundArtifact {
  const dispatches: Array<{ issue: number; worker: string }> = [];
  const merges: Array<{ issue: number; worker: string; pr: number }> = [];
  let gatedReentries = 0;
  let gatedReentryCapped = 0;
  let rollbacksRecovered = 0;
  let rollbacksEscalated = 0;
  let reviewerFallbackSwitches = 0;
  let reviewerFallbackReverts = 0;
  const needsHumanSet = new Set<number>();
  const needsHumanOrder: number[] = [];
  const egressSuspects: Array<{ worker: string; issue: number; executable: string; snippet: string }> = [];
  let ceiling = 0;
  let driveNoPr = 0;
  let handoffs = 0;
  const degradedPhases: Array<{ phase: string; outcome: string; session: string }> = [];
  const roundStops: Array<{ name: string; detail: string }> = [];
  let retroOpened: { pr: number; branch: string } | null = null;
  let retroDegraded: { branch: string; title: string; reason: string } | null = null;
  let align: {
    created: Array<{ issue: number; title: string; hasPlan: boolean }>;
    triaged: Array<{ issue: number; drafted: boolean }>;
  } | null = null;
  const concerns: Array<{ issue: number; reason: string }> = [];
  const concernsReconciled: Array<{ issue: number; reason: string; originRound: number }> = [];

  const addNeedsHuman = (issue: unknown): void => {
    if (typeof issue === "number" && !needsHumanSet.has(issue)) {
      needsHumanSet.add(issue);
      needsHumanOrder.push(issue);
    }
  };

  for (const e of events) {
    const p = e.payload as Record<string, unknown>;
    switch (e.kind) {
      case "dispatched":
        dispatches.push({ issue: p.issue as number, worker: p.worker as string });
        break;
      case "merged":
        merges.push({ issue: p.issue as number, worker: p.worker as string, pr: p.pr as number });
        break;
      case "reclaim-done":
      case "reclaim-failed":
        // prsOpened counts the first reclaim transition INTO `driving` — same definition
        // driver.ts's prsOpenedThisTick / harvest.ts's (pre-#123) gatherRoundFacts used.
        break;
      case "drive-needs-human":
        addNeedsHuman(p.issue);
        break;
      case "drive-queued":
      case "drive-stopped":
        break;
      case "drive-no-pr":
        driveNoPr++;
        break;
      case "plan-review-escalated":
        addNeedsHuman(p.issue);
        break;
      case "egress-suspect":
        egressSuspects.push({
          worker: p.worker as string,
          issue: p.issue as number,
          executable: p.executable as string,
          snippet: p.snippet as string,
        });
        break;
      case "handoff":
        handoffs++;
        break;
      case "ceiling-escalated":
        ceiling++;
        break;
      case "gated-reentry":
        gatedReentries++;
        break;
      case "gated-reentry-capped":
        gatedReentryCapped++;
        break;
      case "rollback-recovered":
        rollbacksRecovered++;
        break;
      case "rollback-escalated":
        rollbacksEscalated++;
        break;
      case "reviewer-fallback-switch":
        reviewerFallbackSwitches++;
        break;
      case "reviewer-fallback-revert":
        reviewerFallbackReverts++;
        break;
      case "round-stop":
        roundStops.push({ name: p.name as string, detail: p.detail as string });
        break;
      // The two retro outcomes are mutually exclusive — LAST event wins outright (Codex P2,
      // PR #152): a crash-rerun can log retro-pr-opened then retro-pr-degraded (the rerun
      // fails on the already-existing branch) in the same round's window, and the artifact
      // must record the later outcome alone, never both.
      case "retro-pr-opened":
        retroOpened = { pr: p.pr as number, branch: p.branch as string };
        retroDegraded = null;
        break;
      case "retro-pr-degraded":
        retroDegraded = { branch: p.branch as string, title: p.title as string, reason: p.reason as string };
        retroOpened = null;
        break;
      case "align-summary":
        // MERGED across events, never replaced (Codex round-6 P2): a crash between the
        // summary append and the phase-marker persist reruns aligning, whose SECOND summary
        // records only the rerun's work — the first run's already-landed creations must not
        // vanish from the source of truth. Union by issue; triage outcome: last wins.
        align = mergeAlignSummary(align, p);
        break;
      case "concern-posted": {
        // #237: one entry per concern actually DELIVERED (dissent.ts's marker check already
        // dedups cross-round — a suppressed repost never appends this event at all). #237
        // round-2 adjudication (finding 2): the payload's OWN `round_id` — not event-ID-window
        // membership — decides whether this belongs to THIS round's "delivered" list or the
        // separate "reconciled from an earlier round" one; dissent.ts's reconcileDurableConcerns
        // (the durable sweep) can append an event in a LATER round's window whose payload still
        // names the concern's true original round.
        const payloadRoundId = typeof p.round_id === "number" ? p.round_id : meta.roundId;
        const entry = { issue: p.issue as number, reason: String(p.reason ?? "") };
        if (payloadRoundId === meta.roundId) concerns.push(entry);
        else concernsReconciled.push({ ...entry, originRound: payloadRoundId });
        break;
      }
      case "po-degraded":
      case "triage-degraded":
      case "architect-degraded":
      case "harvest-degraded":
      case "retro-degraded":
        degradedPhases.push({
          phase: DEGRADE_PHASE_BY_KIND[e.kind]!,
          outcome: String(p.outcome ?? "unknown"),
          session: String(p.session ?? "unknown"),
        });
        break;
      default:
        break;
    }
  }

  // prsOpened: the FIRST reclaim transition into `driving` — reclaim-done/failed whose `next` is
  // DRIVING, or a reclaim-dead lane rescued straight into driving (same three qualifying shapes
  // harvest.ts's pre-#123 gatherRoundFacts used — driver.ts's prsOpenedThisTick definition, read
  // off the durable ledger since harvest/round-close run well after the ticks that produced
  // these events).
  const prsOpened = events.filter((e) => {
    if (e.kind === "reclaim-done" || e.kind === "reclaim-failed") {
      return (e.payload as { next?: string }).next === "DRIVING";
    }
    if (e.kind === "reclaim-dead") return (e.payload as { rescued?: boolean }).rescued === true;
    return false;
  }).length;

  const prsMerged = merges.length;

  return {
    schemaVersion: ROUND_ARTIFACT_SCHEMA_VERSION,
    roundId: meta.roundId,
    startedAt: meta.startedAt,
    endedAt: meta.endedAt,
    dispatches,
    merges,
    prsOpened,
    prsMerged,
    // A merged lane's PR closes its issue via the worker's own `Closes #N` convention — the same
    // "merged" event backs both counts (harvest.ts's pre-#123 convention, preserved).
    issuesClosed: prsMerged,
    spendUsd,
    roundBudgetUsd,
    retries: { gatedReentries, gatedReentryCapped, rollbacksRecovered, rollbacksEscalated },
    reviewRounds: { reviewerFallbackSwitches, reviewerFallbackReverts },
    escalations: { needsHuman: needsHumanOrder, ceiling, driveNoPr },
    egressSuspects,
    handoffs,
    degradedPhases,
    roundStops,
    retro: { opened: retroOpened, degraded: retroDegraded },
    align,
    concerns,
    concernsReconciled,
  };
}

/** State-reading wrapper: fetches this round's own event window + cumulative spend, then calls
 *  the pure assembler above. `endedAt` is threaded explicitly (never read off `round.ended_at`,
 *  which is still null in the DB at the moment a MID-round caller like harvest.ts builds this) —
 *  callers pass null for an unpersisted, in-progress read and the real close timestamp when
 *  building the FINAL artifact at round.ts's actual close. */
export function buildRoundArtifact(state: State, round: RoundRow, roundBudgetUsd: number, endedAt: string | null): RoundArtifact {
  // Id-cursor window, not a timestamp window (Codex P2, PR #152): events/spend timestamps are
  // ms-granular, so a previous round's tail write in the same ms as this round's started_at
  // would bleed into this artifact under ts >= started_at. The cursors captured at startRound
  // are collision-free. `?? 0` covers rows read back before the v9->v10 columns existed —
  // degrades to the old whole-ledger lower bound, never throws.
  const events = state.eventsAfterId(round.start_event_id ?? 0, ROUND_ARTIFACT_EVENT_KINDS);
  const spendUsd = state.spentUsdAfterId(round.start_spend_id ?? 0);
  return assembleRoundArtifact(events, { roundId: round.round_id, startedAt: round.started_at, endedAt }, spendUsd, roundBudgetUsd);
}

function section(title: string, lines: string[]): string {
  return [`## ${title}`, lines.length > 0 ? lines.join("\n") : "(none)"].join("\n");
}

/** Deterministic markdown VIEW of an artifact — never independently authored, always derived
 *  from the same validated object the JSON row holds (module doc: JSON is the source of truth).
 *  Used both as the on-disk `data/rounds/round-<id>.md` view and as the `{{round.artifact}}`
 *  prompt-substitution text (harvest.ts). */
export function renderRoundArtifactMarkdown(artifact: RoundArtifact): string {
  const parts: string[] = [
    `# Round #${artifact.roundId} summary`,
    `Started: ${artifact.startedAt} | Ended: ${artifact.endedAt ?? "(round still in progress)"}`,
    section(
      "Dispatches",
      artifact.dispatches.map((d) => `- #${d.issue} -> ${d.worker}`),
    ),
    section(
      "Merges",
      artifact.merges.map((m) => `- #${m.issue} (PR #${m.pr}) via ${m.worker}`),
    ),
    section("Throughput", [
      `PRs opened: ${artifact.prsOpened}`,
      `PRs merged: ${artifact.prsMerged}`,
      `Issues closed: ${artifact.issuesClosed}`,
    ]),
    section("Spend", [`$${artifact.spendUsd.toFixed(2)} of the $${artifact.roundBudgetUsd.toFixed(2)} round budget`]),
    section("Retries", [
      `Gated reentries: ${artifact.retries.gatedReentries} (capped: ${artifact.retries.gatedReentryCapped})`,
      `Rollbacks recovered: ${artifact.retries.rollbacksRecovered} | escalated: ${artifact.retries.rollbacksEscalated}`,
    ]),
    section("Review rounds (reviewer failover)", [
      `Switches to fallback: ${artifact.reviewRounds.reviewerFallbackSwitches}`,
      `Reverts to primary: ${artifact.reviewRounds.reviewerFallbackReverts}`,
    ]),
    section("Escalations", [
      `Needs-human: ${artifact.escalations.needsHuman.length > 0 ? artifact.escalations.needsHuman.map((n) => `#${n}`).join(", ") : "(none)"}`,
      `Hard-ceiling escalations: ${artifact.escalations.ceiling}`,
      `Drive-no-PR: ${artifact.escalations.driveNoPr}`,
    ]),
    section(
      "Egress suspects (informational)",
      artifact.egressSuspects.map((s) => `- #${s.issue} (${s.worker}): ${s.executable} — ${s.snippet}`),
    ),
    section("Handoffs", [`Soft-budget handoffs: ${artifact.handoffs}`]),
    section(
      "Degraded phases",
      artifact.degradedPhases.map((d) => `- ${d.phase}: ${d.outcome} (session ${d.session})`),
    ),
    section(
      "Round-stop hits",
      artifact.roundStops.map((h) => `- ${h.name}: ${h.detail}`),
    ),
    section(
      "Retro proposal",
      artifact.retro.opened
        ? [`PR #${artifact.retro.opened.pr} (branch ${artifact.retro.opened.branch})`]
        : artifact.retro.degraded
          ? [`Degraded: ${artifact.retro.degraded.reason} (branch ${artifact.retro.degraded.branch})`]
          : ["(no proposal this round)"],
    ),
    section(
      "PO / goal-alignment",
      artifact.align
        ? [
            ...artifact.align.created.map((c) => `- created #${c.issue} — ${c.title}${c.hasPlan ? "" : " (no plan yet)"}`),
            ...artifact.align.triaged.map((t) => `- triaged #${t.issue}${t.drafted ? " (plan drafted)" : " (still planless)"}`),
          ]
        : ["(no aligning-phase summary recorded)"],
    ),
    // #237: the PO dissent channel — every concern actually delivered this round (comment
    // posted, marker-verified). Adjudication itself is never rendered here (it's the issue's
    // own GitHub lifecycle, not a round-scoped fact) — `sapwood status` reports the standing
    // unadjudicated count instead (cli.ts).
    section(
      "Objections raised",
      artifact.concerns.map((c) => `- #${c.issue}: ${c.reason}`),
    ),
    // #237 round-2 adjudication (2026-07-19, finding 2): concerns the durable sweep
    // (dissent.ts's reconcileDurableConcerns) caught up THIS round but that actually belong to an
    // earlier round — never folded into "Objections raised" above (that would falsely claim THIS
    // round raised them). Omitted entirely (not even a "(none)" placeholder) when empty — the
    // common case — so a round that never reconciles anything renders no extra noise.
    ...(artifact.concernsReconciled.length > 0
      ? [
          section(
            "Objections reconciled from earlier rounds",
            artifact.concernsReconciled.map((c) => `- #${c.issue} (originally round ${c.originRound}): ${c.reason}`),
          ),
        ]
      : []),
  ];
  return parts.join("\n\n");
}

/** Validate + persist the FINAL round artifact: a schema-invalid object throws (the caller —
 *  round.ts — contains this so a persistence bug never blocks the round from closing). Writes
 *  the DB row (source of truth) and, when the state has an on-disk data dir (a real run, not an
 *  in-memory test), the derived markdown view to `data/rounds/round-<id>.md` — never the other
 *  way around; the markdown is ALWAYS re-derived from the just-validated object, never authored
 *  independently (module doc). */
export function persistRoundArtifact(state: State, artifact: RoundArtifact, now: string): void {
  const validated = RoundArtifactSchema.parse(artifact);
  state.saveRoundArtifact(validated.roundId, validated.schemaVersion, JSON.stringify(validated), now);
  const mdPath = state.roundArtifactMdPath(validated.roundId);
  if (mdPath) {
    mkdirSync(dirname(mdPath), { recursive: true });
    writeFileSync(mdPath, renderRoundArtifactMarkdown(validated), "utf8");
  }
}

/** Cap the markdown view for prompt substitution — same deterministic-truncation contract as
 *  retro-digest.ts's capDigest (reused directly, not reimplemented). */
export function capRoundArtifactMarkdown(md: string, maxChars: number): string {
  return capDigest(md, maxChars);
}
