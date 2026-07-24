// server.ts (#142, completed in #360) — the dashboard's data server. docs/frontend-design.md §8
// is the contract: four READ routes (`/api/loop/state`, `/api/events`, `/api/spend`,
// `/api/rounds`), exactly ONE write route (`POST /api/control`, gated by `dashboard.controls`),
// and the `dashboard/dist` statics. The API namespace takes precedence over statics.
//
// Posture, all structural rather than promised:
//   - the SQLite handle is opened READ-ONLY (State's `readOnly` mode), so no route — including
//     the write route — can write through it even by accident. `/api/control`'s ONLY effect is
//     creating/removing the engine's own file sentinels (§3 Operations);
//   - the listener binds 127.0.0.1 explicitly, never 0.0.0.0;
//   - `config` is an ALLOWLIST of named keys (§3 E), so a config that later grows a sensitive
//     key does not silently start serving it;
//   - the write route is REGISTERED, not merely hidden, per `dashboard.controls` — a spectator
//     deployment has no such route to POST at.
//
// It deliberately imports the ENGINE's own State/config rather than re-querying SQLite itself:
// §8 requires that `sapwood status` and the dashboard can never disagree about engine state, and
// that only holds if both read through the same module.
import { createReadStream, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, resolve, sep } from "node:path";
import { loadConfig, type SapwoodConfig } from "../engine/src/config/config.js";
import { engineSessionGapSec } from "../engine/src/loop/conductor.js";
import { State, type WorkerRow } from "../engine/src/state/state.js";

/** §8 default; overridable so several data dirs can be inspected side by side. */
export const DEFAULT_PORT = 4517;

/** Page size cap shared by `/api/events` and `/api/spend` — §8 gives them the same paging
 *  contract, so they get the same bound. A poll tail is small; replay pages from `after=0` and
 *  is expected to walk. Bounds one response, never the total the caller can read. */
export const MAX_PAGE_LIMIT = 1000;
const DEFAULT_PAGE_LIMIT = 500;

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

/** Read the live facts out of the DB + sentinels and derive §8's engine state word. Shared by
 *  `/api/loop/state` and `POST /api/control` (whose response is exactly this, read AFTER the
 *  signal lands — so the UI renders the real transition, never an optimistic flip). */
export function currentEngineState(state: State, cfg: SapwoodConfig | null, now: Date): EngineState {
  const round = state.openRound();
  return deriveEngineState({
    now,
    killSwitch: state.isKillSwitchActive(),
    activeLanes: state.activeWorkers().length,
    ceilingBreach: state.ceilingBreach(),
    pause: state.isPauseActive(),
    lastTickAt: state.lastTickAt(),
    staleGapSec: engineSessionGapSec(cfg?.engine.tickIntervalSec ?? 0),
    roundOpen: round !== undefined,
    standbyWaiting: standbyWaiting(state),
  });
}

export function loopState(state: State, cfg: SapwoodConfig | null, now: Date): Record<string, unknown> {
  const active = state.activeWorkers();
  const breach = state.ceilingBreach();
  const round = state.openRound();
  const lastTickAt = state.lastTickAt();
  const engineState = currentEngineState(state, cfg, now);
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

type Handler = (url: URL, ctx: Ctx, req: IncomingMessage) => Reply | Promise<Reply>;

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

/** The one paging contract §8 gives both append-only feeds: ascending by id, `after`/`limit`,
 *  and a `lastId` an empty tail leaves at the caller's own cursor — rewinding it to 0 would make
 *  a polling client re-fold the entire history on every quiet poll. */
function pagedReply<T extends { id: number }>(url: URL, key: string, page: (after: number, limit: number) => T[]): Reply {
  const after = intParam(url, "after", 0);
  const limit = intParam(url, "limit", 1);
  if (after === undefined || limit === undefined) {
    return { status: 400, body: { error: "after must be an integer >= 0; limit an integer >= 1" } };
  }
  const from = after ?? 0;
  const rows = page(from, Math.min(limit ?? DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT));
  return { status: 200, body: { [key]: rows, lastId: rows[rows.length - 1]?.id ?? from } };
}

// ── POST /api/control (§8 / §3 Operations) ─────────────────────────────────────────────────

/** The EXHAUSTIVE set of verbs the route accepts. `estop` is deliberately absent: §3 Operations'
 *  emergency-stop tier needs the additive `EMERGENCY_STOP` engine sentinel (#293) to mean
 *  anything, and a verb that reported success while signalling nothing is worse than a 400. It
 *  joins this list in the same change that lands the sentinel, not before. */
const CONTROL_VERBS = ["start", "pause", "resume", "stop"] as const;

/** Which sentinel each verb sets and which it clears (§3 Operations, verbatim engine semantics —
 *  nothing new is invented here). Start clears BOTH so the next tick simply runs. */
const CONTROL_EFFECT: Record<(typeof CONTROL_VERBS)[number], { set: ("PAUSE" | "KILL_SWITCH")[]; clear: ("PAUSE" | "KILL_SWITCH")[] }> = {
  pause: { set: ["PAUSE"], clear: [] },
  resume: { set: [], clear: ["PAUSE"] },
  stop: { set: ["KILL_SWITCH"], clear: [] },
  start: { set: [], clear: ["KILL_SWITCH", "PAUSE"] },
};

/** A control body is a single short verb; anything larger is not one, so the read is bounded
 *  rather than trusting Content-Length. */
const MAX_CONTROL_BODY_BYTES = 4096;

async function readBody(req: IncomingMessage): Promise<string | null> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_CONTROL_BODY_BYTES) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The route defends itself SERVER-SIDE — a UI confirm binds nobody (§3 Operations). Three
 *  checks, none of which a cross-origin page can satisfy: a custom header (which forces a CORS
 *  preflight this server never grants), a JSON content-type (so a form POST, which needs no
 *  preflight at all, cannot reach the verb), and an `Origin` that, when present, is this very
 *  server's. Together with the loopback bind that is the whole access story. */
async function control(_url: URL, ctx: Ctx, req: IncomingMessage): Promise<Reply> {
  if (req.headers["x-sapwood-control"] === undefined) {
    return { status: 403, body: { error: "missing X-Sapwood-Control header" } };
  }
  const contentType = (req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return { status: 415, body: { error: "content-type must be application/json" } };
  }
  const origin = req.headers.origin;
  if (origin !== undefined && !sameOrigin(origin, req.headers.host)) {
    return { status: 403, body: { error: "cross-origin control requests are refused" } };
  }

  const raw = await readBody(req);
  if (raw === null) return { status: 413, body: { error: "control body too large" } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { status: 400, body: { error: "body must be JSON" } };
  }
  const verb = (parsed as { verb?: unknown } | null)?.verb;
  if (typeof verb !== "string" || !(CONTROL_VERBS as readonly string[]).includes(verb)) {
    return { status: 400, body: { error: `verb must be one of: ${CONTROL_VERBS.join(", ")}` } };
  }

  const paths = { PAUSE: ctx.state.pausePath(), KILL_SWITCH: ctx.state.killSwitchPath() };
  const effect = CONTROL_EFFECT[verb as (typeof CONTROL_VERBS)[number]];
  for (const name of [...effect.set, ...effect.clear]) {
    if (paths[name] === null) return { status: 500, body: { error: "this data dir has no sentinel path" } };
  }
  // Sentinel files ONLY — no DB write (the handle is read-only anyway), no config, no GitHub.
  for (const name of effect.clear) rmSync(paths[name] as string, { force: true });
  for (const name of effect.set) writeFileSync(paths[name] as string, "", "utf8");

  // Read the state back AFTER the signal — §8: Stop answers `stopping` while lanes drain.
  return { status: 200, body: { state: currentEngineState(ctx.state, ctx.config, ctx.now()) } };
}

function sameOrigin(origin: string, host: string | undefined): boolean {
  try {
    return new URL(origin).host === host;
  } catch {
    return false; // an unparseable Origin (including the literal "null") is not ours
  }
}

// ── route table ────────────────────────────────────────────────────────────────────────────

const ROUTES: Record<string, Partial<Record<string, Handler>>> = {
  "/api/loop/state": {
    GET: (_url, ctx) => ({ status: 200, body: loopState(ctx.state, ctx.config, ctx.now()) }),
  },
  "/api/events": {
    GET: (url, ctx) => pagedReply(url, "events", (a, l) => ctx.state.eventsPage(a, l)),
  },
  "/api/spend": {
    GET: (url, ctx) => pagedReply(url, "spend", (a, l) => ctx.state.spendPage(a, l)),
  },
  "/api/rounds": {
    // Unpaged on purpose: one row per ROUND, so this is the chapter index of the whole run —
    // hundreds of rows after a long campaign, not the tens of thousands the event feed reaches.
    GET: (_url, ctx) => ({ status: 200, body: { rounds: ctx.state.listRounds() } }),
  },
};

// ── statics (§8: `dashboard/dist` from the same server) ────────────────────────────────────

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
};

/** Serve one file out of the vite build. Anything that is not a real file under `root` falls
 *  back to `index.html` (the app is client-routed, so `/round/12` is a page, not a 404) — but
 *  ONLY after the resolved path is proven to be inside `root`, so a traversal can neither read
 *  out of the tree nor be laundered into the fallback. `/api/*` never gets here at all. */
function serveStatic(root: string, pathname: string, res: ServerResponse): void {
  let file: string | null = null;
  try {
    const candidate = resolve(root, `.${decodeURIComponent(pathname)}`);
    if (candidate === root || candidate.startsWith(root + sep)) {
      file = existsSync(candidate) && statSync(candidate).isFile() ? candidate : join(root, "index.html");
    }
  } catch {
    file = null; // malformed percent-encoding — not a path we will guess at
  }
  if (file === null || !existsSync(file)) {
    const payload = JSON.stringify({ error: `not found: ${pathname}` });
    res.writeHead(404, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
    res.end(payload);
    return;
  }
  res.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
  createReadStream(file).pipe(res);
}

export interface DashboardServerOptions {
  dbPath: string;
  /** Passed to loadConfig; undefined probes the default sapwood.config.* names in cwd. An
   *  unreadable config is NOT fatal — the affected fields report null (§8), same as `status`. */
  configPath?: string;
  /** 0 asks the OS for a free port (tests). */
  port?: number;
  /** The vite build to serve; defaults to this package's own `dist`. */
  staticDir?: string;
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
  const staticRoot = resolve(opts.staticDir ?? join(import.meta.dirname, "dist"));

  // The write route is REGISTERED per config, not hidden per config: with `dashboard.controls`
  // false there is no such route to POST at, which is what makes the spectator posture
  // structural. An UNREADABLE config lands here too — fail-closed, matching how every other
  // config-derived field degrades to null rather than to a guessed default (§8).
  const routes: typeof ROUTES = config?.dashboard.controls === true ? { ...ROUTES, "/api/control": { POST: control } } : ROUTES;

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      // The API namespace takes precedence over statics (§8) — and an unknown /api/* path is an
      // honest JSON 404, never the SPA shell, so a mistyped fetch fails loudly.
      if (!url.pathname.startsWith("/api/")) return serveStatic(staticRoot, url.pathname, res);

      const route = routes[url.pathname];
      const handler = route?.[req.method ?? "GET"];
      let reply: Reply;
      try {
        reply = !route
          ? { status: 404, body: { error: `no such route: ${url.pathname}` } }
          : !handler
            ? { status: 405, body: { error: `${req.method} not allowed on ${url.pathname}` } }
            : await handler(url, ctx, req);
      } catch (err) {
        reply = { status: 500, body: { error: err instanceof Error ? err.message : String(err) } };
      }
      const payload = JSON.stringify(reply.body);
      // No CORS headers, ever: the dashboard is same-origin with this server, and granting none
      // is what keeps a foreign page from reading a local engine's state (§8) — and what makes
      // the control route's custom-header requirement unsatisfiable from a foreign page.
      res.writeHead(reply.status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
      res.end(payload);
    })();
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
