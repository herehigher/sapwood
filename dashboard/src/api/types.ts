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
  /** #906 (§294 follow-up #7): whether a person has put this lane's PR on hold —
   *  `State.lastHoldEvent(lane, pr) === "pr-held"` server-side; `deriveReplayedLanes` (App.tsx)
   *  folds the same `pr-held`/`pr-released` events for the replayed reading. `false` when there's
   *  no PR yet or the latest hold event was `pr-released`. */
  held: boolean;
  /** SUM(spend_ledger) — the real bill, written at reclaim; null while in flight. */
  costUsd: number | null;
  /** #33 priced estimate while running; cleared to null the instant the lane stops. */
  estCostUsd: number | null;
  /** #927: `costUsd`'s own provenance — `false` (known-real, provider-reported) is what gates
   *  `copy.ts`'s `calibrationClause`/`LaneBoard.tsx`'s `laneCostText` est→real reading; `true`
   *  or unset never render one. Optional/absent for a live lane — `/api/loop/state` never sends
   *  this field today; only `deriveReplayedLanes` (App.tsx) populates it, from the replayed
   *  fold's own `reclaim-done`-recorded `LaneView.costEstimated`. */
  costEstimated?: boolean | null;
  /** #926: `workers.fix_rounds` — the "round n of cap" numerator for a `fixing` lane's chip
   *  (`lanes.prFixCap` config is the denominator). 0 for a lane that has never entered a fix
   *  round. */
  fixRound: number;
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
    /** #361: the raw PAUSE sentinel, served alongside the derived `state` — §8's precedence
     *  rule can mask a live PAUSE file from `state` (a stale/kill-switched engine never reads
     *  `paused`), so the header's secondary "PAUSE set" chip needs this independently. */
    pauseActive: boolean;
    /** #733: the raw EMERGENCY_STOP sentinel, served the same posture as `pauseActive` above —
     *  §8's precedence can mask it from the derived `state` too. `start` clears PAUSE/KILL_SWITCH
     *  but never this sentinel, so the UI needs it independently to keep Start honest about a
     *  persisting halt (`sapwood estop clear` is the only release lever, #731). */
    estopActive: boolean;
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
  /** #803: PR numbers the persisted event log witnesses as MERGED (merged-witness event kinds) —
   *  a null-honest projection, never a guessed state. A PR absent here simply has no persisted
   *  terminal witness (still open, or closed-without-merge, which the engine never persists). */
  mergedPrs: number[];
  /** Path only; the server never serves log content. */
  logPath: string | null;
  /** Allowlisted subset of the resolved config (§3 E) — never the whole object.
   *  null when the config is unreadable, the same honest-unknown as `lanes.max`. */
  config: Record<string, unknown> | null;
  /** #361: whether the operations-control buttons should render at all — mirrors the server's
   *  own fail-closed gate on whether `POST /api/control` is even registered (an unreadable
   *  config reads as `false`, never the schema's `true` default). */
  controlsEnabled: boolean;
  /** #894: the server's own dist build identity vs. the repo HEAD it currently serves from —
   *  the stale-dist chip's data source. Either field `null` when unknown (no dist build yet, or
   *  the server's repo dir isn't a git checkout) — never a guessed match/mismatch. */
  build: {
    distSha: string | null;
    distTime: string | null;
    repoHeadSha: string | null;
  };
};

/** §3 Operations / §8: the exhaustive verb set `POST /api/control` accepts. `estop` joined once
 *  #724 landed the additive `EMERGENCY_STOP` engine sentinel (#293). */
export type ControlVerb = "start" | "pause" | "resume" | "stop" | "estop";

export const CONTROL_VERBS: readonly ControlVerb[] = ["start", "pause", "resume", "stop", "estop"];

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

/** `GET /api/attention/dismissals` — event occurrences hidden from the live strip only. */
export type AttentionDismissals = { eventIds: number[] };

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

/** `GET /api/rounds` — §8's replay chapter marks + round navigator. `RoundStatus` mirrors the
 *  engine's own `rounds.status` column (`engine/src/state/state.ts`) verbatim — a round is either
 *  still open (`in_progress`) or closed (`done`); the dashboard never derives a third value. */
export type RoundStatus = "in_progress" | "done";

/** One `rounds` row with its artifact left-joined (server's `RoundListRow`, #360). `schemaVersion`
 *  and `artifact` are BOTH `null` for a round that closed without one — render it tally-less,
 *  never skip the row (§8). `startEventId`/`startSpendId` are the #123 id cursors — the exact
 *  replay chapter window this round covers, NOT artifact fields. */
export type Round = {
  roundId: number;
  status: RoundStatus;
  startedAt: string;
  endedAt: string | null;
  startEventId: number;
  startSpendId: number;
  eventCount: number;
  schemaVersion: number | null;
  artifact: unknown;
};

export type RoundsPage = { rounds: Round[] };
