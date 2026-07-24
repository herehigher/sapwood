// server.ts (#142) — the dashboard's read-only data server. docs/frontend-design.md §8 is the
// contract; this file implements its two READ routes (`/api/loop/state`, `/api/events`) and
// nothing else. The remaining §8 surface (`/api/spend`, `/api/rounds`, the single gated
// `POST /api/control`, and the `dashboard/dist` statics) lands in #360 — the ROUTES table below
// is the seam it slots into, so adding them is registration, not restructuring.
//
// Posture, all three structural rather than promised:
//   - the SQLite handle is opened READ-ONLY (State's `readOnly` mode), so no route — present or
//     future — can write through it even by accident;
//   - the listener binds 127.0.0.1 explicitly, never 0.0.0.0;
//   - `config` is an ALLOWLIST of named keys (§3 E), so a config that later grows a sensitive
//     key does not silently start serving it.
//
// It deliberately imports the ENGINE's own State/config rather than re-querying SQLite itself:
// §8 requires that `sapwood status` and the dashboard can never disagree about engine state, and
// that only holds if both read through the same module.
import { createServer, type Server } from "node:http";
import { loadConfig, type SapwoodConfig } from "../engine/src/config/config.js";
import { engineSessionGapSec } from "../engine/src/loop/conductor.js";
import { State, type WorkerRow } from "../engine/src/state/state.js";

/** §8 default; overridable so several data dirs can be inspected side by side. */
export const DEFAULT_PORT = 4517;

/** Page size cap for `/api/events` — a poll tail is small; replay pages from `after=0` and is
 *  expected to walk. Bounds one response, never the total the caller can read. */
export const MAX_EVENTS_LIMIT = 1000;
const DEFAULT_EVENTS_LIMIT = 500;

// ── engine state (§8 derivation) ───────────────────────────────────────────────────────────

export type EngineState = "running" | "standby" | "stalled" | "paused" | "winding-down" | "stopping" | "stopped";

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
 *  direction: nothing is ticking, so nothing may render green. */
export function deriveEngineState(f: EngineFacts): EngineState {
  if (f.killSwitch) return f.activeLanes > 0 ? "stopping" : "stopped";
  if (f.ceilingBreach) return "winding-down";
  const tickAgeSec = f.lastTickAt === null ? Number.POSITIVE_INFINITY : (f.now.getTime() - Date.parse(f.lastTickAt)) / 1000;
  if (!(tickAgeSec <= f.staleGapSec)) return "stalled"; // NaN (unparseable timestamp) is stale too
  if (f.pause) return "paused";
  if (!f.roundOpen && f.standbyWaiting) return "standby";
  return "running";
}

// ── config allowlist (§3 E) ────────────────────────────────────────────────────────────────

const ROLE_KEYS = ["planReviewer", "planDrafter", "architect", "po", "harvest", "retro"] as const;

/** The EXHAUSTIVE list of resolved-config leaves the server will serve, grouped the way §3 E's
 *  drawer groups them (Board · Lanes · Worker · Safety · Review & merge · Labels), plus the
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
  "worker.fallbackModel",
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
  ...ROLE_KEYS.flatMap((r) => [`roles.${r}.model`, `roles.${r}.effort`, `roles.${r}.fallbackModel`]),
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

// ── /api/loop/state (§8) ───────────────────────────────────────────────────────────────────

/** A lane's cost is `null` WHILE IN FLIGHT (§8): the real bill is written to spend_ledger at
 *  reclaim, so a running/fixing lane genuinely has no settled number — and a `0` there would
 *  render as a finished, free lane rather than an unknown one. */
const inFlight = (w: WorkerRow): boolean => w.state === "running" || w.state === "fixing";

function laneItem(state: State, w: WorkerRow): Record<string, unknown> {
  let tokenComposition: unknown = null;
  if (w.token_composition) {
    try {
      tokenComposition = JSON.parse(w.token_composition);
    } catch {
      /* engine-written, should never happen — a display field degrades to null, never a 500 */
    }
  }
  return {
    lane: w.name,
    issue: w.issue,
    state: w.state,
    pr: w.pr ?? null,
    startedAt: w.started_at,
    endedAt: w.ended_at,
    costUsd: inFlight(w) ? null : state.spentUsdForWorker(w.name),
    estCostUsd: w.est_cost_usd ?? null,
    contextTokens: w.context_tokens ?? null,
    tokenComposition,
  };
}

/** #125: the newest standby-wait is newer than any standby-exit — read off the SAME two events
 *  round.ts appends, in id order, so "parked" here means exactly what it means to the engine. */
function standbyWaiting(state: State): boolean {
  const trail = state.eventsAfterId(0, ["standby-wait", "standby-exit"]);
  return trail[trail.length - 1]?.kind === "standby-wait";
}

export function loopState(state: State, cfg: SapwoodConfig | null, now: Date): Record<string, unknown> {
  const active = state.activeWorkers();
  const breach = state.ceilingBreach();
  const round = state.openRound();
  const lastTickAt = state.lastTickAt();
  const engineState = deriveEngineState({
    now,
    killSwitch: state.isKillSwitchActive(),
    activeLanes: active.length,
    ceilingBreach: breach,
    pause: state.isPauseActive(),
    lastTickAt,
    staleGapSec: engineSessionGapSec(cfg?.engine.tickIntervalSec ?? 0),
    roundOpen: round !== undefined,
    standbyWaiting: standbyWaiting(state),
  });
  return {
    engine: {
      state: engineState,
      // §8: reasons carry ceiling_breach.reasons ONLY while winding-down. A `ceiling_breach`
      // row can outlive the winding-down state — KILL_SWITCH (stopping/stopped) and a stale
      // engine both outrank it in deriveEngineState while the row is still open — so gating on
      // the DERIVED state, not on the row's mere existence, keeps a manually stopped or dead
      // dashboard from surfacing an irrelevant budget/kill reason (Codex review P2).
      reasons: engineState === "winding-down" ? (breach?.reasons ?? []) : [],
      lastTickAt,
    },
    lanes: {
      max: cfg?.lanes.max ?? null, // null, never a fabricated 3, when the config is unreadable
      items: active.map((w) => laneItem(state, w)),
    },
    round: round ? { id: round.round_id, phase: round.phase } : null,
    spend: {
      todayUsd: state.dailySpendUsd(now),
      dailyBudgetUsd: cfg?.cost.dailyBudgetUsd ?? null,
      // #154's run anchor lives only in the engine PROCESS's memory; §11 follow-up #206's
      // `run-started` event is what persists it. Until that lands there is no honest way to
      // compute a run-scoped sum from the DB alone, so this stays null and the header falls
      // back WHOLE to the daily tier (§3 A) — never a run numerator over a daily denominator.
      runUsd: null,
      runBudgetUsd: cfg?.stop.afterSpendUsd ?? null,
      byModel: state.spendByModelForDay(now),
    },
    rings: state.countEvents("merged"),
    // Path only, never content (§8) — the phase inspector's "view log" entry opens it locally.
    logPath: cfg?.logging.path ?? null,
    config: cfg ? allowlistedConfig(cfg) : null,
  };
}

// ── routing ────────────────────────────────────────────────────────────────────────────────

interface Reply {
  status: number;
  body: unknown;
}

interface Ctx {
  state: State;
  config: SapwoodConfig | null;
  now: () => Date;
}

type Handler = (url: URL, ctx: Ctx) => Reply;

/** Parse a non-negative integer query param. `null` = absent (use the default); `undefined` =
 *  present but malformed, which is a 400 — a paging cursor the server guessed at is a silently
 *  wrong feed, so this validates at the boundary instead of coercing. */
function intParam(url: URL, name: string, min: number): number | null | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null || raw === "") return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min) return undefined;
  return n;
}

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "/api/loop/state": {
    GET: (_url, ctx) => ({ status: 200, body: loopState(ctx.state, ctx.config, ctx.now()) }),
  },
  "/api/events": {
    GET: (url, ctx) => {
      const after = intParam(url, "after", 0);
      const limit = intParam(url, "limit", 1);
      if (after === undefined || limit === undefined) {
        return { status: 400, body: { error: "after must be an integer >= 0; limit an integer >= 1" } };
      }
      const from = after ?? 0;
      const events = ctx.state.eventsPage(from, Math.min(limit ?? DEFAULT_EVENTS_LIMIT, MAX_EVENTS_LIMIT));
      // An empty tail keeps the caller's own cursor: rewinding lastId to 0 would make a polling
      // client re-fold the entire history on every quiet poll.
      return { status: 200, body: { events, lastId: events[events.length - 1]?.id ?? from } };
    },
  },
};

export interface DashboardServerOptions {
  dbPath: string;
  /** Passed to loadConfig; undefined probes the default sapwood.config.* names in cwd. An
   *  unreadable config is NOT fatal — the affected fields report null (§8), same as `status`. */
  configPath?: string;
  /** 0 asks the OS for a free port (tests). */
  port?: number;
  now?: () => Date;
}

/** Open the read-only handle, bind loopback, resolve once the server is actually listening. */
export async function createDashboardServer(opts: DashboardServerOptions): Promise<{ server: Server; state: State; port: number }> {
  const state = new State(opts.dbPath, { readOnly: true });
  let config: SapwoodConfig | null = null;
  try {
    config = loadConfig(opts.configPath);
  } catch {
    config = null; // reported as null fields, never fatal — the DB read is the point
  }
  const ctx: Ctx = { state, config, now: opts.now ?? (() => new Date()) };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const route = ROUTES[url.pathname];
    const handler = route?.[req.method ?? "GET"];
    const reply: Reply = !route
      ? { status: 404, body: { error: `no such route: ${url.pathname}` } }
      : !handler
        ? { status: 405, body: { error: `${req.method} not allowed on ${url.pathname}` } }
        : handler(url, ctx);
    const payload = JSON.stringify(reply.body);
    // No CORS headers, ever: the dashboard is same-origin with this server, and granting none
    // is what keeps a foreign page from reading a local engine's state (§8).
    res.writeHead(reply.status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // Loopback ONLY — never 0.0.0.0. This server has no auth of its own; "reachable" and
    // "authorized" are the same thing here, so the bind address IS the access control.
    server.listen(opts.port ?? DEFAULT_PORT, "127.0.0.1", resolve);
  });
  const address = server.address();
  return { server, state, port: typeof address === "object" && address ? address.port : (opts.port ?? DEFAULT_PORT) };
}
