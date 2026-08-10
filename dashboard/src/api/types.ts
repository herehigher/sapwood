/**
 * Response shapes for the read-only endpoints in frontend-design.md §8.
 *
 * The server derives all of this (engine state included) so `sapwood status` and the
 * dashboard can never disagree — the UI types mirror the contract, they don't re-derive it.
 */

/** §8: derived server-side; staleness beats pause, a dead engine never reads "running". */
export type EngineState = "running" | "standby" | "stalled" | "paused" | "winding-down" | "stopping" | "stopped";

export type Lane = {
  lane: string;
  issue: number;
  state: string;
  pr: number | null;
  startedAt: string;
  endedAt: string | null;
  /** SUM(spend_ledger) — the real bill, written at reclaim; null while in flight. */
  costUsd: number | null;
  /** #33 priced estimate while running; cleared to null the instant the lane stops. */
  estCostUsd: number | null;
  /** What the model saw last turn. Deliberately non-monotonic — a drop marks a compact. */
  contextTokens: number | null;
  tokenComposition: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  } | null;
};

export type LoopState = {
  engine: {
    state: EngineState;
    reasons: string[];
    lastTickAt: string | null;
    /** #723: seconds until the next standby probe, served only while `state === "standby"` —
     *  null otherwise (never a stale countdown left over from a prior standby dwell). */
    standbyNextCheckSec: number | null;
  };
  /** `max` is null when the config is unreadable. */
  lanes: { max: number | null; items: Lane[] };
  /** Live phase cursor; null when no round is open (standby). */
  round: { id: number; phase: string } | null;
  spend: {
    todayUsd: number;
    dailyBudgetUsd: number | null;
    /** #154's run anchor lives only in engine-process memory until follow-up #206 persists
     *  it, so the server serves null and the header falls back whole to the daily tier (§3 A). */
    runUsd: number | null;
    runBudgetUsd: number | null;
    byModel: { model: string; usd: number; inputTokens: number; outputTokens: number }[];
  };
  /** COUNT(events WHERE kind='merged') — the ring count. */
  rings: number;
  /** Path only; the server never serves log content. */
  logPath: string | null;
  /** Allowlisted subset of the resolved config (§3 E) — never the whole object.
   *  null when the config is unreadable, the same honest-unknown as `lanes.max`. */
  config: Record<string, unknown> | null;
};

export type LoopEvent = {
  id: number;
  ts: string;
  kind: string;
  /** Stored JSON, verbatim — the §7 copy map is what turns a kind + payload into prose.
   *  `null` on a row whose stored payload wasn't parseable JSON (`state.ts`'s `eventsPage`/
   *  `eventsPageFiltered`: "a corrupt row is served as null, never a 500/throw for the whole
   *  page") — a genuinely honest wire value, not a defect, so every consumer must treat it as
   *  a real possibility rather than assume an object (#715 gate② round 4 [4]). */
  payload: Record<string, unknown> | null;
};

export type EventsPage = { events: LoopEvent[]; lastId: number };

/** One `spend_ledger` row, served verbatim (`server.ts`'s `/api/spend` route, `State.spendPage`) —
 *  `actorKind`/`role`/`estimated` are `null` on a row that never claimed one (#645), same never-
 *  guess stance as everywhere else this triple appears. */
export type SpendRow = {
  id: number;
  ts: string;
  worker: string;
  issue: number;
  usd: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  actorKind: "worker" | "fix-leg" | "peripheral-role" | "engine-review" | null;
  role: string | null;
  estimated: boolean | null;
};

export type SpendPage = { spend: SpendRow[]; lastId: number };
