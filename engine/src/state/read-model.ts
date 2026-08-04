// read-model.ts (#642): the ONE shared semantic contract for "what is this engine's state, right
// now, read straight off the SQLite DB" — consumed by BOTH the dashboard (dashboard/server.ts's
// `/api/loop/state`, `/api/events`, `/api/spend`) and the CLI (cli.ts's `status --json` and the
// `events` verb). Before this existed the dashboard had its own engine-state derivation +
// config allowlist + paging cap, and `sapwood status`/a hand-rolled sqlite poll loop each grew
// their own — a second event/spend semantic contract per README's Why (Codex review P2-6,
// 2026-08-04, thread 019fcbe9). This module is the extraction: engine-state derivation, the
// config allowlist, and the paging-cap constant move here from dashboard/server.ts (which
// re-exports them, unchanged in shape, so its own routes and server.test.ts's imports are
// undisturbed — #642 AC1's byte-identical regression test pins that). The CLI-only DTOs (status
// --json's StatusDTO, events' EventsPageDTO) are new here, built OFF the same State methods the
// dashboard reads (state.eventsPage/spendByModelForDay et al.) plus two new ones added alongside
// this module (state.ts's eventsPageFiltered/spendSummaryForDay) for facts the dashboard's own
// routes never needed (kind-filtered paging, the honest settled/unclassified spend split).
//
// CONTRACT (status --json / events --json, #642 AC2): `formatVersion: 1`. Every DTO here is a
// DOCUMENTED PROJECTION — built field by field, never `JSON.stringify`ing a raw WorkerRow or a
// raw event/spend_ledger row. That indirection is deliberate: a DB schema column added for an
// unrelated reason (a new WorkerRow field, a new spend_ledger column) must NEVER become an
// accidental wire-format change just because some serializer walked the row object. The field
// policy is ADDITIVE-ONLY at this format version — a future field is added, never a field
// removed/renamed/retyped, without bumping `formatVersion`. Clients MUST ignore fields they don't
// recognize (forward-compatible by construction) rather than fail closed on an unknown key.
import { DEFAULT_CONFIG_PATHS, type SapwoodConfig } from "../config/config.js";
import type { State, WorkerRow } from "./state.js";

/** #642: the wire format version every `status --json`/`events --json` payload carries at its
 *  top level. A literal `1`, not `number` — TypeScript keeps every DTO's `formatVersion` field
 *  pinned to exactly this value at compile time, so a future bump is a deliberate, visible edit
 *  here (and everywhere it propagates), never an accidental widening. */
export const READ_MODEL_FORMAT_VERSION = 1 as const;

// ── engine-state derivation (moved from dashboard/server.ts, #142/§8, unchanged) ────────────

export type EngineState = "running" | "standby" | "stalled" | "paused" | "winding-down" | "stopping" | "stopped";

/** #407 (item 5): the newest run's terminal event, when it has one — how a dead engine finally
 *  gets to say WHY it is dead. The engine writes exactly one terminal per controlled exit
 *  (cli.ts's appendRunEnded doc): `run-ended` on a clean stop (payload: stoppedBy +
 *  stopCondition?), `engine-stalled` when the watchdog self-diagnosed a stall (payload: the
 *  fire-time enrichment — round/phase, last event, lastTickAt), and NOTHING on a crash/kill —
 *  so a null here under a stale tick age honestly means "crashed or killed". */
export interface RunTerminal {
  kind: "run-ended" | "engine-stalled";
  payload: Record<string, unknown>;
}

/** Everything §8's derivation reads, lifted out of the DB so the rules are unit-testable
 *  against synthetic sentinel/ceiling/PAUSE fixtures without a live engine. */
export interface EngineFacts {
  now: Date;
  killSwitch: boolean;
  /** running + driving + fixing lanes — "drain in progress" for the kill-switch tier. */
  activeLanes: number;
  ceilingBreach: { reasons: string[]; at: Date } | null;
  pause: boolean;
  /** engine_session.last_tick_at, or null when the engine has never ticked here. */
  lastTickAt: string | null;
  staleGapSec: number;
  roundOpen: boolean;
  /** The newest standby-wait is newer than any standby-exit (#125: parked, healthy). */
  standbyWaiting: boolean;
  /** #407: latestRunTerminal(state) — null while the newest run has no terminal yet (alive, or
   *  crashed; the tick age decides which reading the derivation gives it). */
  terminal: RunTerminal | null;
}

/** #431: this lived in the engine as `engineSessionGapSec` and was deleted there along with the
 *  wall-clock session machinery (the wall clock now anchors to in-memory process start and
 *  never reads a gap). The DASHBOARD's need survives independently: the `stalled` derivation is
 *  a UI liveness heuristic over `last_tick_at` (the #431-surviving heartbeat), and it still
 *  wants a cadence-aware bound so a legal slow cadence doesn't render a healthy engine as
 *  stalled. Same math as the deleted helper — max(900s, 2× cadence) tolerates one missed tick
 *  at any legal cadence; non-finite/unknown cadence falls back to the 900s base. */
export function heartbeatStaleGapSec(tickIntervalSec: number): number {
  if (!Number.isFinite(tickIntervalSec) || tickIntervalSec <= 0) return 900;
  return Math.max(900, 2 * tickIntervalSec);
}

/** §8's engine-state derivation, verbatim, in its fixed precedence order:
 *
 *    KILL_SWITCH  >  ceiling breach  >  staleness  >  PAUSE  >  standby  >  running
 *
 *  Two orderings in there are decisions, not accidents. STALENESS BEATS PAUSE (the 2026-07-21
 *  fix resolving §8 against loop-walkthrough §6): a dead engine that happens to have a PAUSE
 *  file must render `stalled`, because "paused" reads as a healthy, resumable engine and a
 *  crashed one is not — the sentinel is demoted to a secondary chip in the UI. And KILL_SWITCH
 *  outranks staleness: a stopped engine IS stale, and `stopped` is the truthful word for it.
 *
 *  An engine that has never ticked (`lastTickAt === null`) counts as stale — the fail-honest
 *  direction: nothing is ticking, so nothing may render green.
 *
 *  #407 (item 5): the stale branch now consults the newest run's terminal event (RunTerminal) to
 *  partition the three dead-engine states instead of one undifferentiated `stalled`:
 *    - `run-ended` -> "stopped": a CLEAN stop, with the stop reason in the terminal payload;
 *    - `engine-stalled` -> "stalled", now with the watchdog's reason payload attached;
 *    - no terminal -> the bare "stalled" of old, now honestly meaning "crashed or killed" —
 *      the engine died without getting to write anything, and that absence IS the record.
 *  Deliberately INSIDE the staleness branch only (the issue's own scoping): a just-stopped
 *  engine keeps its existing within-gap rendering until the tick age crosses the same threshold
 *  every other dead-engine reading already waits for. */
export function deriveEngineState(f: EngineFacts): EngineState {
  if (f.killSwitch) return f.activeLanes > 0 ? "stopping" : "stopped";
  if (f.ceilingBreach) return "winding-down";
  const tickAgeSec = f.lastTickAt === null ? Number.POSITIVE_INFINITY : (f.now.getTime() - Date.parse(f.lastTickAt)) / 1000;
  if (!(tickAgeSec <= f.staleGapSec)) {
    // NaN (unparseable timestamp) is stale too
    return f.terminal?.kind === "run-ended" ? "stopped" : "stalled";
  }
  if (f.pause) return "paused";
  if (!f.roundOpen && f.standbyWaiting) return "standby";
  return "running";
}

/** #125: the newest standby-wait is newer than any standby-exit — read off the SAME two events
 *  round.ts appends, in id order, so "parked" here means exactly what it means to the engine. */
function standbyWaiting(state: Pick<State, "eventsAfterId">): boolean {
  const trail = state.eventsAfterId(0, ["standby-wait", "standby-exit"]);
  return trail[trail.length - 1]?.kind === "standby-wait";
}

/** #407 (item 5): the newest run's terminal event, or null — the same last-event-wins fold shape
 *  as standbyWaiting above, over the run-lifecycle triple. The trick that makes "since the last
 *  run-started" a one-liner: after a terminal lands the process EXITS, so nothing else from that
 *  run can follow it, and the next event of these kinds is necessarily the next run's own
 *  `run-started` — the newest of the three therefore fully decides the newest run's fate:
 *  `run-started` newest = no terminal yet (alive, or crashed — RunTerminal's doc), a terminal
 *  newest = that terminal belongs to the newest run. All three kinds are once-per-process-life
 *  rare, so the whole-history read stays cheap forever. */
export function latestRunTerminal(state: Pick<State, "eventsAfterId">): RunTerminal | null {
  const trail = state.eventsAfterId(0, ["run-started", "run-ended", "engine-stalled"]);
  const last = trail[trail.length - 1];
  if (last === undefined || last.kind === "run-started") return null;
  return { kind: last.kind as RunTerminal["kind"], payload: (last.payload ?? {}) as Record<string, unknown> };
}

/** Read the live facts out of the DB + sentinels and derive §8's engine state word. Shared by
 *  `/api/loop/state` and `POST /api/control` (whose response is exactly this, read AFTER the
 *  signal lands — so the UI renders the real transition, never an optimistic flip). */
export function currentEngineState(
  state: Pick<
    State,
    "openRound" | "isKillSwitchActive" | "activeWorkers" | "ceilingBreach" | "isPauseActive" | "lastTickAt" | "eventsAfterId"
  >,
  cfg: Pick<SapwoodConfig, "engine"> | null,
  now: Date,
): EngineState {
  const round = state.openRound();
  return deriveEngineState({
    now,
    killSwitch: state.isKillSwitchActive(),
    activeLanes: state.activeWorkers().length,
    ceilingBreach: state.ceilingBreach(),
    pause: state.isPauseActive(),
    lastTickAt: state.lastTickAt(),
    staleGapSec: heartbeatStaleGapSec(cfg?.engine.tickIntervalSec ?? 0),
    roundOpen: round !== undefined,
    standbyWaiting: standbyWaiting(state),
    terminal: latestRunTerminal(state),
  });
}

// ── config allowlist (moved from dashboard/server.ts, §3 E, unchanged) ──────────────────────

const ROLE_KEYS = ["verificationPlanReviewer", "verificationPlanDrafter", "architect", "po", "harvest", "retro"] as const;

/** The EXHAUSTIVE list of resolved-config leaves the server/CLI will serve, grouped the way §3
 *  E's drawer groups them (Board · Lanes · Worker · Safety · Review & merge · Labels), plus the
 *  per-role model/effort keys the §3 C lane captions and the §6 phase inspector read.
 *
 *  This is an allowlist and not a denylist on purpose: config grows, and a key added later — a
 *  token, a private URL, an internal path — must default to NOT being served. Everything the
 *  drawer shows is named here or it does not exist. */
export const CONFIG_ALLOWLIST: readonly string[] = [
  // Board
  "board.owner",
  "board.repo",
  "board.projectNumber",
  "board.statusField",
  "board.status.backlog",
  "board.status.ready",
  "board.status.inProgress",
  "board.status.done",
  // Lanes
  "lanes.max",
  "lanes.roundDispatchCap",
  "lanes.reserveCap",
  "lanes.prFixCap",
  "lanes.gatedReentryCap",
  "lanes.frictionMin",
  // Worker
  "worker.model",
  "worker.effort",
  "worker.timeoutSec",
  "worker.budgetUsdSoft",
  "worker.maxResumes",
  "worker.heartbeatStaleSecs",
  // Safety
  "guard.mode",
  "cost.roundBudgetUsd",
  "cost.dailyBudgetUsd",
  "cost.maxWallClockSec",
  "cost.drainWindowSec",
  "stop.afterIssuesMerged",
  "stop.afterPRsOpened",
  "stop.afterSpendUsd",
  "stop.onMilestoneComplete",
  // Review & merge
  "reviewer.mode",
  "reviewer.triggerCommand",
  "reviewer.deltaChainMax",
  "reviewer.agent.model",
  "reviewer.agent.effort",
  "merge.mode",
  // Labels (the resolved names, which is what the UI matches events against)
  "labels.prefix",
  "labels.inProgress",
  "labels.needsHuman",
  "labels.blocked",
  "labels.reserve",
  "labels.verifyNa",
  "labels.planApproved",
  "labels.originAgent",
  "labels.split",
  "labels.decomposed",
  "labels.roundPool",
  // Per-role model/effort (§3 E: the allowlist MUST include these — the captions read them)
  ...ROLE_KEYS.flatMap((r) => [`roles.${r}.model`, `roles.${r}.effort`]),
];

/** Project the resolved config down to CONFIG_ALLOWLIST. Missing/undefined leaves are omitted
 *  entirely rather than serialized as null, so an optional key that is simply unset reads as
 *  absent in the drawer instead of as "configured to nothing". */
export function allowlistedConfig(cfg: SapwoodConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const path of CONFIG_ALLOWLIST) {
    const segments = path.split(".");
    let src: unknown = cfg;
    for (const s of segments) {
      src = src !== null && typeof src === "object" ? (src as Record<string, unknown>)[s] : undefined;
    }
    if (src === undefined) continue;
    let dst = out;
    for (const s of segments.slice(0, -1)) {
      dst[s] ??= {};
      dst = dst[s] as Record<string, unknown>;
    }
    dst[segments[segments.length - 1]!] = src;
  }
  return out;
}

// ── paging cap (moved from dashboard/server.ts, §8) ──────────────────────────────────────────

/** Page size cap shared by every append-only-feed reader — the dashboard's `/api/events`/
 *  `/api/spend` (via dashboard/server.ts's re-export) AND the CLI's `events --limit` (#642 AC5's
 *  "hard page cap"). One number so the two surfaces can never quietly diverge on how large a
 *  single page is allowed to be. The two reading contracts differ on WHAT happens above the cap
 *  (the HTTP routes clamp silently — a read-only GET is idempotent either way; the CLI flag
 *  REJECTS — see cli.ts's parseEventsArgs doc for why a script that asked for N and silently got
 *  fewer is the worse failure mode there), but the cap value itself is this one constant. */
export const MAX_PAGE_LIMIT = 1000;

/** Default page size when the dashboard's `after`/`limit` query param is absent. CLI-side, the
 *  `events` verb defines its OWN smaller terminal-friendly default (cli.ts's DEFAULT_EVENTS_LIMIT)
 *  rather than reusing this — a polling dashboard client and an operator glancing at a terminal
 *  want different defaults, and the CAP (not the default) is what the semantic contract fixes. */
export const DEFAULT_PAGE_LIMIT = 500;

// ── spend (#642 AC3: honest settled + unclassified + incompleteness) ────────────────────────

/** `status --json`'s spend section. `settledByWorker` is the SAME exact-name match
 *  `state.spentUsdForWorker` uses, one row per worker `spend_ledger` actually has settled rows
 *  for today (never every currently-active lane — a lane with zero settled spend today simply
 *  has no row, rather than a fabricated 0 entry cluttering the list). `unclassifiedUsd` is
 *  everything else `todayUsd` counts that ISN'T attributable to a known worker name — #612's
 *  `"<lane>:engine-review"` review-session spend keys land here today (state.ts's
 *  spendSummaryForDay doc) — and `incomplete` is true exactly when that bucket is non-empty, so
 *  a client can never mistake "some spend this DTO couldn't attribute" for "zero spend
 *  happened".
 *
 *  #642 (Codex gate② round-1 P1 finding 3): `todayUsd` is `state.spendSummaryForDay`'s OWN
 *  `todayUsd` — deliberately NOT a separate `state.dailySpendUsd(now)` call. The three numbers
 *  now all come out of `spendSummaryForDay`'s single call (itself one read transaction,
 *  state.ts's own doc), so `todayUsd === sum(settledByWorker) + unclassifiedUsd` holds BY
 *  CONSTRUCTION — there is no independent third read left that a live settlement landing
 *  mid-computation could make disagree with the other two. */
export interface StatusSpendDTO {
  todayUsd: number;
  dailyBudgetUsd: number | null;
  settledByWorker: { worker: string; usd: number }[];
  unclassifiedUsd: number;
  incomplete: boolean;
}

export function buildSpendSection(
  state: Pick<State, "spendSummaryForDay">,
  cfg: Pick<SapwoodConfig, "cost"> | null,
  now: Date,
): StatusSpendDTO {
  const summary = state.spendSummaryForDay(now);
  return {
    todayUsd: summary.todayUsd,
    dailyBudgetUsd: cfg?.cost.dailyBudgetUsd ?? null,
    settledByWorker: summary.byWorker,
    unclassifiedUsd: summary.unclassifiedUsd,
    incomplete: summary.unclassifiedUsd > 0,
  };
}

// ── status --json DTO (#642 AC2/AC4) ─────────────────────────────────────────────────────────

export interface StatusLaneDTO {
  lane: string;
  issue: number;
  pr: number | null;
  state: WorkerRow["state"];
  startedAt: string;
  endedAt: string | null;
  /** null while the lane is IN FLIGHT (running/fixing) — the real bill is written to
   *  spend_ledger at reclaim, so an in-flight lane genuinely has no settled number yet, and a
   *  `0` here would render as a finished, free lane rather than an unknown one (same convention
   *  dashboard/server.ts's laneItem documents for its own `costUsd`). */
  settledUsd: number | null;
}

/** #642 AC4: "without --config, the config-derived section is marked unavailable — status
 *  already renders unknown on config error — keep that stance, surface it structurally." The
 *  EXISTING text `sapwood status` loads config via the SAME best-effort probe `validate`/`init`
 *  use (loadConfig(configPath), configPath undefined -> DEFAULT_CONFIG_PATHS probe) and renders
 *  "unknown" fields ONLY when that load itself fails — never merely because `--config` was
 *  omitted (an omitted flag with a real default-named config sitting in cwd is the common case,
 *  and `validate`'s own `resolvedPath` already treats that as a legitimate, named source). This
 *  DTO keeps EXACTLY that stance rather than inventing a stricter "must pass --config" gate: -
 *  `available: false` iff loadConfig threw (missing/unreadable/invalid config); `available: true`
 *  with `provenance` set to the RESOLVED path — `configPath ?? DEFAULT_CONFIG_PATHS.find(existsSync)`,
 *  the exact expression `runValidate`'s own `resolvedPath` uses — whenever it succeeded, whether
 *  that path came from an explicit `--config` or the default probe. */
export type StatusConfigSection = { available: true; provenance: string; lanesMax: number; dailyBudgetUsd: number } | { available: false };

/** #642 AC2: the `status --json` DTO. Every field is a PROJECTION (see this module's own header
 *  comment for the never-serialize-a-raw-row rule) built off `WorkerRow`/event/spend_ledger
 *  facts, never those rows verbatim. ADDITIVE-ONLY at `formatVersion: 1` — a future field is
 *  added here, never removed/renamed/retyped, without bumping the version; unrecognized fields
 *  MUST be ignored by every client, never treated as a validation failure. */
export interface StatusDTO {
  formatVersion: typeof READ_MODEL_FORMAT_VERSION;
  dbPath: string;
  schemaVersion: number;
  generatedAt: string;
  /** #642 AC6 (stale-immutable): "live" when this read saw the DB through a normal WAL-aware
   *  open (a running engine's uncommitted-to-main rows ARE visible); "immutable-fallback" when
   *  the read-only-filesystem fallback applied (state.ts's openReadOnly doc) — a currently
   *  running engine's newest rows may NOT be visible in that mode. Structural counterpart to the
   *  stderr line openReadOnly already prints for the plain-text callers. */
  snapshot: { mode: "live" | "immutable-fallback" };
  lanes: StatusLaneDTO[];
  drivingCount: number;
  killSwitchActive: boolean;
  pauseActive: boolean;
  ceilingBreach: { reasons: string[]; at: string } | null;
  spend: StatusSpendDTO;
  config: StatusConfigSection;
  unadjudicatedConcerns: number;
}

export interface BuildStatusDTOInput {
  state: State;
  dbPath: string;
  schemaVersion: number;
  cfg: SapwoodConfig | null;
  /** The resolved config path (`runValidate`'s own `resolvedPath` expression), or undefined when
   *  `cfg` is null (load failed / no config found anywhere). */
  configProvenance: string | undefined;
  now: Date;
  unadjudicatedConcerns: number;
}

export function buildStatusDTO(input: BuildStatusDTOInput): StatusDTO {
  const { state, dbPath, schemaVersion, cfg, configProvenance, now, unadjudicatedConcerns } = input;
  const active = state.activeWorkers();
  const inFlight = (w: WorkerRow): boolean => w.state === "running" || w.state === "fixing";
  const ceilingBreach = state.ceilingBreach();
  const config: StatusConfigSection =
    cfg && configProvenance !== undefined
      ? { available: true, provenance: configProvenance, lanesMax: cfg.lanes.max, dailyBudgetUsd: cfg.cost.dailyBudgetUsd }
      : { available: false };
  return {
    formatVersion: READ_MODEL_FORMAT_VERSION,
    dbPath,
    schemaVersion,
    generatedAt: now.toISOString(),
    snapshot: { mode: state.isImmutableSnapshot() ? "immutable-fallback" : "live" },
    lanes: active.map((w) => ({
      lane: w.name,
      issue: w.issue,
      pr: w.pr ?? null,
      state: w.state,
      startedAt: w.started_at,
      endedAt: w.ended_at,
      settledUsd: inFlight(w) ? null : state.spentUsdForWorker(w.name),
    })),
    drivingCount: state.drivingWorkers().length,
    killSwitchActive: state.isKillSwitchActive(),
    pauseActive: state.isPauseActive(),
    ceilingBreach: ceilingBreach ? { reasons: ceilingBreach.reasons, at: ceilingBreach.at.toISOString() } : null,
    spend: buildSpendSection(state, cfg, now),
    config,
    unadjudicatedConcerns,
  };
}

/** `runValidate`'s own `resolvedPath` expression, reused so `status --json`'s config provenance
 *  agrees byte-for-byte with what `sapwood validate`/the text `status` would report as "the"
 *  config, given the same `--config`/cwd. Exported so cli.ts's runStatus doesn't re-derive it. */
export function resolveConfigProvenance(configPath: string | undefined, existsSync: (p: string) => boolean): string | undefined {
  return configPath ?? DEFAULT_CONFIG_PATHS.find(existsSync);
}
