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

/**
 * `v` must already be a (possibly absent) array of ITEMS EVERY ONE of which passes `isValid` —
 * gate② finding [2] (malformed-artifact-fabricates-results): a PARTIALLY malformed array used
 * to `.filter()` its bad members out silently, turning a wholly-untrustworthy field into a
 * plausible-looking (often empty, "none this round") recorded value. One invalid member now
 * invalidates the WHOLE field (`null, i.e. "not recorded"`) — never a silently-shortened list. An
 * absent/non-array field is the same honest-unknown, not a distinct case.
 */
function parseTypedArray<T>(v: unknown, isValid: (item: unknown) => item is T): T[] | null {
  const arr = asArray(v);
  if (!arr) return null;
  const validated: T[] = [];
  for (const item of arr) {
    if (!isValid(item)) return null;
    validated.push(item);
  }
  return validated;
}

export type CreatedRow = { issue: number; title: string; hasPlan: boolean };
export type TriagedRow = { issue: number; drafted: boolean };

function isCreatedRow(v: unknown): v is CreatedRow {
  const r = asRecord(v);
  return !!r && typeof r.issue === "number" && typeof r.title === "string" && typeof r.hasPlan === "boolean";
}

function isTriagedRow(v: unknown): v is TriagedRow {
  const r = asRecord(v);
  return !!r && typeof r.issue === "number" && typeof r.drafted === "boolean";
}

/** `artifact.align` — §6's "created issues (with titles) + triaged issues". `null` for either
 *  list means "not recorded" (no align section at all, or a malformed one — including one where
 *  only SOME entries are malformed, per `parseTypedArray`'s own doc) — distinct from an empty
 *  array, which means the aligning phase genuinely created/triaged nothing this round. */
export function readAlign(artifact: unknown): { created: CreatedRow[] | null; triaged: TriagedRow[] | null } {
  const align = asRecord(asRecord(artifact)?.align);
  if (!align) return { created: null, triaged: null };
  return {
    created: parseTypedArray(align.created, isCreatedRow),
    triaged: parseTypedArray(align.triaged, isTriagedRow),
  };
}

export type DegradedRow = { phase: string; outcome: string; session: string };

function isDegradedRow(v: unknown): v is DegradedRow {
  const r = asRecord(v);
  return !!r && typeof r.phase === "string" && typeof r.outcome === "string" && typeof r.session === "string";
}

/** `artifact.degradedPhases`, filtered to the phases this drawer owns — "architect" (arch
 *  review) and "plan_review" (verify), per round-artifact.ts's `DEGRADE_PHASE_BY_KIND` /
 *  the inline `plan-review-escalated` push. `null` means the artifact carries no (or a
 *  malformed — including partially malformed) `degradedPhases` array at all — never an empty
 *  list standing in for "unknown". The requested-phase filter runs only AFTER shape validation
 *  has passed for every entry — it is legitimate scoping, not error suppression. */
export function readDegradedPhases(artifact: unknown, phases: readonly string[]): DegradedRow[] | null {
  const rows = parseTypedArray(asRecord(artifact)?.degradedPhases, isDegradedRow);
  if (rows === null) return null;
  return rows.filter((d) => phases.includes(d.phase));
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

function isDispatchRow(v: unknown): v is { issue: number; worker: string } {
  const r = asRecord(v);
  return !!r && typeof r.issue === "number" && typeof r.worker === "string";
}

function isMergeRow(v: unknown): v is { issue: number; worker: string; pr: number } {
  const r = asRecord(v);
  return !!r && typeof r.issue === "number" && typeof r.worker === "string" && typeof r.pr === "number";
}

function isNumber(v: unknown): v is number {
  return typeof v === "number";
}

/** §6's "Lanes / CI / Review / merge" row: `dispatches`/`merges`/`retries`/`escalations`/
 *  `handoffs` — each read independently, so one malformed field never blanks out the others.
 *  Every array-shaped field (`dispatches`, `merges`, `escalations.needsHuman`) is validated
 *  member-by-member (`parseTypedArray`) before its length is trusted — gate② finding [2]: a
 *  count derived from an unvalidated array counts arbitrary garbage as if it were real rows. */
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
  const escNeedsHuman = escRec ? parseTypedArray(escRec.needsHuman, isNumber) : null;
  const escalations: EscalationsCounters | null =
    escRec && escNeedsHuman !== null && typeof escRec.ceiling === "number" && typeof escRec.driveNoPr === "number"
      ? { needsHuman: escNeedsHuman.length, ceiling: escRec.ceiling, driveNoPr: escRec.driveNoPr }
      : null;
  return {
    dispatches: parseTypedArray(rec.dispatches, isDispatchRow)?.length ?? null,
    merges: parseTypedArray(rec.merges, isMergeRow)?.length ?? null,
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

const MALFORMED = Symbol("malformed");

/** `null`/absent is the legitimate "this outcome didn't happen" value; a present-but-wrong-shape
 *  value is `MALFORMED` — gate② finding [2]: the previous code folded both into the same `null`,
 *  so a malformed `opened` silently read as the genuine "neither" outcome instead of unknown. */
function readRetroOpened(v: unknown): RetroOpened | null | typeof MALFORMED {
  if (v === null || v === undefined) return null;
  const r = asRecord(v);
  if (r && typeof r.pr === "number" && typeof r.branch === "string") return { pr: r.pr, branch: r.branch };
  return MALFORMED;
}

function readRetroDegraded(v: unknown): RetroDegraded | null | typeof MALFORMED {
  if (v === null || v === undefined) return null;
  const r = asRecord(v);
  if (r && typeof r.branch === "string" && typeof r.title === "string" && typeof r.reason === "string") {
    return { branch: r.branch, title: r.title, reason: r.reason };
  }
  return MALFORMED;
}

/** §6's RETRO row: "the `retro` outcome object (opened PR / degraded / neither)". `known: false`
 *  means the artifact carries no `retro` object at all, OR one whose `opened`/`degraded` is
 *  present but malformed (gate② finding [2] — malformed must never read as the real "neither"
 *  outcome) — distinct from a present-but-both-null `retro` object, which IS the real
 *  "no proposal this round" outcome. */
export function readRetro(artifact: unknown): RetroFacts {
  const retro = asRecord(asRecord(artifact)?.retro);
  if (!retro) return { known: false, opened: null, degraded: null };
  const opened = readRetroOpened(retro.opened);
  const degraded = readRetroDegraded(retro.degraded);
  if (opened === MALFORMED || degraded === MALFORMED) return { known: false, opened: null, degraded: null };
  return { known: true, opened, degraded };
}
