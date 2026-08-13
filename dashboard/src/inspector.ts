/**
 * Phase inspector (frontend-design.md §6 amendment, issue #861) — pure data layer. A stage node
 * maps to one of five drawer "phases"; drawer content is read defensively off `Round.artifact`
 * (`unknown` on the wire — schema-validated server-side, but this file never trusts that and
 * degrades to an honest "not recorded" instead of throwing on anything malformed, AC6).
 */

import type { EventKind } from "./copy.ts";

/** Every clickable hero stage node this issue wires up. `lane` covers ANY of the `w1..wN`
 *  channels — they share one drawer (round-level counters, not per-lane), same as `ci`/`review`/
 *  `merge` all sharing the "Lanes / CI / Review / merge" row in §6's table. */
export type StageNode = "goal-align" | "arch-review" | "verify" | "lane" | "ci" | "review" | "merge" | "summary" | "retro";

export type InspectorPhase = "goal-align" | "arch-verify" | "lanes" | "summary" | "retro";

export const NODE_PHASE: Record<StageNode, InspectorPhase> = {
  "goal-align": "goal-align",
  "arch-review": "arch-verify",
  verify: "arch-verify",
  lane: "lanes",
  ci: "lanes",
  review: "lanes",
  merge: "lanes",
  summary: "summary",
  retro: "retro",
};

export const PHASE_HEADING: Record<InspectorPhase, string> = {
  "goal-align": "Goal & align",
  "arch-verify": "Arch review / Verify",
  lanes: "Lanes / CI / Review / merge",
  summary: "Summary",
  retro: "Retro",
};

/** AC7's fixed, explicit mapping — the ONLY three `attention`-marked kinds that resolve to a
 *  phase. Every other kind is absent here on purpose (see the issue's own enumeration of why
 *  each is ambiguous); `NeedsAttention.tsx` renders no inspect control for an absent kind. */
export const ATTENTION_KIND_TO_NODE: Partial<Record<EventKind, StageNode>> = {
  "plan-review-escalated": "verify",
  "verify-na-proposed": "verify",
  "ci-inert-escalated": "ci",
};

// ── defensive artifact readers (AC6: honest-unknown, never a throw, never a fabricated value) ──

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
}

function asArray(v: unknown): unknown[] | null {
  return Array.isArray(v) ? v : null;
}

function asNumber(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export type CreatedRow = { issue: number; title: string; hasPlan: boolean };
export type TriagedRow = { issue: number; drafted: boolean };

/** `artifact.align` — §6's "created issues (with titles) + triaged issues". `null` for either
 *  list means "not recorded" (no align section at all, or a malformed one) — distinct from an
 *  empty array, which means the aligning phase genuinely created/triaged nothing this round. */
export function readAlign(artifact: unknown): { created: CreatedRow[] | null; triaged: TriagedRow[] | null } {
  const align = asRecord(asRecord(artifact)?.align);
  if (!align) return { created: null, triaged: null };
  const createdArr = asArray(align.created);
  const triagedArr = asArray(align.triaged);
  const created =
    createdArr?.filter((r): r is CreatedRow => {
      const rr = asRecord(r);
      return !!rr && typeof rr.issue === "number" && typeof rr.title === "string" && typeof rr.hasPlan === "boolean";
    }) ?? null;
  const triaged =
    triagedArr?.filter((r): r is TriagedRow => {
      const rr = asRecord(r);
      return !!rr && typeof rr.issue === "number" && typeof rr.drafted === "boolean";
    }) ?? null;
  return { created, triaged };
}

export type DegradedRow = { phase: string; outcome: string; session: string };

/** `artifact.degradedPhases`, filtered to the phases this drawer owns — "architect" (arch
 *  review) and "plan_review" (verify), per round-artifact.ts's `DEGRADE_PHASE_BY_KIND` /
 *  the inline `plan-review-escalated` push. `null` means the artifact carries no (or a
 *  malformed) `degradedPhases` array at all — never an empty list standing in for "unknown". */
export function readDegradedPhases(artifact: unknown, phases: readonly string[]): DegradedRow[] | null {
  const arr = asArray(asRecord(artifact)?.degradedPhases);
  if (!arr) return null;
  return arr
    .filter((r): r is DegradedRow => {
      const rr = asRecord(r);
      return !!rr && typeof rr.phase === "string" && typeof rr.outcome === "string" && typeof rr.session === "string";
    })
    .filter((d) => phases.includes(d.phase));
}

/** Plain count of a `kind` inside the currently-active event fold (live window or replay
 *  cursor, whichever the caller already resolved) — always a confident number, never
 *  "unknown": `events` is an append-only source, not a mutable/malformed one like `artifact`. */
export function countEventKind(events: readonly { kind: string }[], kind: string): number {
  return events.filter((e) => e.kind === kind).length;
}

export type RetriesCounters = {
  gatedReentries: number;
  gatedReentryCapped: number;
  rollbacksRecovered: number;
  rollbacksEscalated: number;
};
export type EscalationsCounters = { needsHuman: number; ceiling: number; driveNoPr: number };

export type LanesCounters = {
  dispatches: number | null;
  merges: number | null;
  retries: RetriesCounters | null;
  escalations: EscalationsCounters | null;
  handoffs: number | null;
};

/** §6's "Lanes / CI / Review / merge" row: `dispatches`/`merges`/`retries`/`escalations`/
 *  `handoffs` — each read independently, so one malformed field never blanks out the others. */
export function readLanesCounters(artifact: unknown): LanesCounters {
  const rec = asRecord(artifact);
  if (!rec) return { dispatches: null, merges: null, retries: null, escalations: null, handoffs: null };
  const retriesRec = asRecord(rec.retries);
  const retries: RetriesCounters | null =
    retriesRec &&
    typeof retriesRec.gatedReentries === "number" &&
    typeof retriesRec.gatedReentryCapped === "number" &&
    typeof retriesRec.rollbacksRecovered === "number" &&
    typeof retriesRec.rollbacksEscalated === "number"
      ? {
          gatedReentries: retriesRec.gatedReentries,
          gatedReentryCapped: retriesRec.gatedReentryCapped,
          rollbacksRecovered: retriesRec.rollbacksRecovered,
          rollbacksEscalated: retriesRec.rollbacksEscalated,
        }
      : null;
  const escRec = asRecord(rec.escalations);
  const escNeedsHuman = escRec ? asArray(escRec.needsHuman) : null;
  const escalations: EscalationsCounters | null =
    escRec && escNeedsHuman && typeof escRec.ceiling === "number" && typeof escRec.driveNoPr === "number"
      ? { needsHuman: escNeedsHuman.length, ceiling: escRec.ceiling, driveNoPr: escRec.driveNoPr }
      : null;
  return {
    dispatches: asArray(rec.dispatches)?.length ?? null,
    merges: asArray(rec.merges)?.length ?? null,
    retries,
    escalations,
    handoffs: asNumber(rec.handoffs),
  };
}

export type SummaryFacts = {
  spendUsd: number | null;
  roundBudgetUsd: number | null;
  prsOpened: number | null;
  prsMerged: number | null;
  issuesClosed: number | null;
};

/** §6's SUMMARY row: "the artifact's own top-line numbers (spend vs round budget, throughput
 *  counters)". */
export function readSummary(artifact: unknown): SummaryFacts {
  const rec = asRecord(artifact);
  return {
    spendUsd: asNumber(rec?.spendUsd),
    roundBudgetUsd: asNumber(rec?.roundBudgetUsd),
    prsOpened: asNumber(rec?.prsOpened),
    prsMerged: asNumber(rec?.prsMerged),
    issuesClosed: asNumber(rec?.issuesClosed),
  };
}

export type RetroOpened = { pr: number; branch: string };
export type RetroDegraded = { branch: string; title: string; reason: string };
export type RetroFacts = { known: boolean; opened: RetroOpened | null; degraded: RetroDegraded | null };

/** §6's RETRO row: "the `retro` outcome object (opened PR / degraded / neither)". `known: false`
 *  means the artifact carries no (or a malformed) `retro` object at all — distinct from a
 *  present-but-both-null `retro` object, which is the real "no proposal this round" outcome. */
export function readRetro(artifact: unknown): RetroFacts {
  const retro = asRecord(asRecord(artifact)?.retro);
  if (!retro) return { known: false, opened: null, degraded: null };
  const openedRec = asRecord(retro.opened);
  const opened: RetroOpened | null =
    openedRec && typeof openedRec.pr === "number" && typeof openedRec.branch === "string"
      ? { pr: openedRec.pr, branch: openedRec.branch }
      : null;
  const degradedRec = asRecord(retro.degraded);
  const degraded: RetroDegraded | null =
    degradedRec && typeof degradedRec.branch === "string" && typeof degradedRec.title === "string" && typeof degradedRec.reason === "string"
      ? { branch: degradedRec.branch, title: degradedRec.title, reason: degradedRec.reason }
      : null;
  return { known: true, opened, degraded };
}
