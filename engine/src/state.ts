// Durable engine state. Replaces 0day's non-atomic jq read-modify-write
// (loop_conductor.sh:738-762). Conductor stays single-writer-serial; WAL gives atomic
// writes + concurrent reads (so `sapwood status` reads a live DB without blocking).
// Fully durable -> engine restart is a clean resume.
//
// Uses Node's built-in node:sqlite (unflagged since Node 22.13 — see engines floor).
// ponytail: zero native dep; if the API bites, swap to better-sqlite3 — same call shape.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Ordered migrations. index N upgrades schema from user_version N to N+1. Append-only:
// never edit a shipped migration, add a new one. user_version (a SQLite builtin) is the
// on-disk schema version — the migration path #5 asks for.
const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
  // 0 -> 1: initial schema.
  (db) => {
    db.exec(`
      CREATE TABLE workers (
        name        TEXT PRIMARY KEY,
        issue       INTEGER NOT NULL,
        session_id  TEXT NOT NULL,
        state       TEXT NOT NULL,            -- running | driving | done | failed | handoff
        started_at  TEXT NOT NULL,
        ended_at    TEXT
      );
      CREATE TABLE events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        ts         TEXT NOT NULL,
        kind       TEXT NOT NULL,
        payload    TEXT NOT NULL             -- JSON
      );
    `);
  },
  // 1 -> 2: engine cost ceiling + kill switch (#14). Append-only additions — never edit
  // migration 0.
  (db) => {
    db.exec(`
      -- Every completed (done/failed/handoff) worker's stream-json total_cost_usd, recorded
      -- exactly once by the conductor at reclaim time. Append-only ledger (like events); the
      -- daily cumulative cap is a SUM over rows whose ts falls on the query day. Persisted so
      -- an engine restart mid-day does not reset the cumulative spend (#14).
      CREATE TABLE spend_ledger (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,
        worker   TEXT NOT NULL,
        issue    INTEGER NOT NULL,
        usd      REAL NOT NULL
      );
      -- Singleton row: the ACTIVE engine session backing the wall-clock ceiling
      -- (cfg.cost.maxWallClockSec). A session is continuous ticking: every tick refreshes
      -- last_tick_at; a gap longer than the stale threshold (engine stopped/crashed) resets
      -- started_at. Persisted so a rapid crash-loop restart CANNOT evade the cap (the gap
      -- stays under the threshold), while a deliberate operator pause recovers a
      -- wall-clock-breached engine (Codex PR #41 R2 P1 — a DB-lifetime start time would
      -- permanently breach every data dir maxWallClockSec after its first-ever tick).
      CREATE TABLE engine_session (
        id           INTEGER PRIMARY KEY CHECK (id = 1),
        started_at   TEXT NOT NULL,
        last_tick_at TEXT NOT NULL
      );
      -- Singleton row: set once when a ceiling breach (daily budget / wall-clock / kill
      -- switch) is FIRST detected; cleared once the breach condition resolves. The bounded
      -- drain window (cfg.cost.drainWindowSec) is measured from this "at", not re-armed each
      -- tick, so a still-breached engine doesn't perpetually reset its own drain clock.
      CREATE TABLE ceiling_breach (
        id        INTEGER PRIMARY KEY CHECK (id = 1),
        reason    TEXT NOT NULL,
        at        TEXT NOT NULL
      );
    `);
  },
  // 2 -> 3: review gate + merge driver (#13). A `driving` lane holds a PR awaiting gate①/gate②;
  // it needs the PR NUMBER (not just the boolean "has a PR" the probe already carried) so the
  // merge driver knows which PR to gate/merge, plus a flag so the review trigger (e.g.
  // `@codex review`) is posted once per PR, not every tick. Both nullable/defaulted — NULL/0
  // for every pre-existing row (append-only migration, no backfill needed).
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN pr INTEGER;
      ALTER TABLE workers ADD COLUMN review_triggered INTEGER NOT NULL DEFAULT 0;
    `);
  },
  // 3 -> 4: double-failure rollback/requeue hardening (#31). A recovery-path board mutation
  // (dispatch rollback to Ready / dead-lane requeue to Ready) is persisted here BEFORE it is
  // attempted — so if the mutation itself also fails (a *transient forge failure during
  // recovery*, the exact double-failure window #31 tracks), the row survives to be retried on
  // a later tick instead of the issue being silently stranded In Progress with no worker row
  // and no durable trace. Cleared on success; escalated (needs-human + a structured tick
  // event, never a silent swallow) once attempts hit cfg.recovery.rollbackRetryCap.
  (db) => {
    db.exec(`
      CREATE TABLE pending_rollbacks (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        issue           INTEGER NOT NULL,
        target          TEXT NOT NULL,   -- board status to reach: ready | inProgress | done
        reason          TEXT NOT NULL,   -- dispatch-rollback | dead-lane-requeue
        attempts        INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        last_attempt_at TEXT
      );
    `);
  },
  // 4 -> 5: cost telemetry (#47) — model + categorized token usage alongside the existing USD
  // figure. Extends spend_ledger in place (not a companion table): one row per (lane, model)
  // keeps the daily-cap query (`SUM(usd) FROM spend_ledger WHERE ts LIKE ...`) untouched — it
  // doesn't care about the extra columns. ADD COLUMN...NOT NULL DEFAULT backfills every
  // pre-#47 row with model='unknown' and 0 tokens (accurate: we never captured that for them).
  (db) => {
    db.exec(`
      ALTER TABLE spend_ledger ADD COLUMN model TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE spend_ledger ADD COLUMN input_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE spend_ledger ADD COLUMN output_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE spend_ledger ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE spend_ledger ADD COLUMN cache_creation_tokens INTEGER NOT NULL DEFAULT 0;
    `);
  },
  // 5 -> 6: engine-recorded review-trigger pin (PR #55 P1-B). The old `review_triggered`
  // 0/1 flag let a lane's thumb-verdict freshness cutoff be pinned to the head COMMIT's own
  // committedDate (forge.ts headCommittedAt) — forgeable via GIT_COMMITTER_DATE or a
  // cherry-pick, and never re-armed on a later push (a new head reused the first trigger
  // forever). These two columns replace that semantics with an ENGINE clock pin: the head the
  // trigger was posted for, and the engine's own wall-clock time it posted at — neither
  // derivable from git metadata a worker/producer controls. `review_triggered` stays in the
  // table (append-only migration; dropping a SQLite column needs a table rebuild this fix
  // doesn't need) but is no longer read for gating. Nullable, no default: every pre-existing
  // row (including review_triggered=1 ones) gets NULL head/at, which the merge driver reads as
  // "no trigger recorded for the current head" -> it fires one fresh trigger next tick before
  // any thumb can count. Fail-closed, never a silently-honored stale pin.
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN review_triggered_head TEXT;
      ALTER TABLE workers ADD COLUMN review_triggered_at TEXT;
    `);
  },
  // 6 -> 7: reviewer failover lock (#54). Once a FALLBACK reviewer (cfg.reviewer.fallback)
  // reaches MERGE_OK for a lane's head while the primary is unavailable, that verdict must
  // stay valid for that exact head even if the primary later reports something else
  // (recovery semantics, #54 design) — these two columns are that lock: the head it was
  // recorded for, and which fallback reviewer kind produced it. Read/written exclusively by
  // MergeDriver.driveOne's recordFallback callback (conductor.ts wires it in), same pattern as
  // review_triggered_head/at above. Nullable, no default: every pre-existing row gets NULL
  // (no lock held), which resolveReviewVerdict (reviewer.ts) reads as "nothing to stay valid
  // for" — fail-closed to the primary/no-fallback path, never a spuriously-honored lock.
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN review_fallback_head TEXT;
      ALTER TABLE workers ADD COLUMN review_fallback_kind TEXT;
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

// running = live worker (probed each reclaim). driving = produced a PR, lane held awaiting
// the review gate (M3) — no live worker, but still occupies a lane. done/failed/handoff = terminal.
export type WorkerState = "running" | "driving" | "done" | "failed" | "handoff";

export interface WorkerRow {
  name: string;
  issue: number;
  session_id: string;
  state: WorkerState;
  started_at: string;
  ended_at: string | null;
  /** PR number once a `driving` lane has one (the merge driver's gate/merge target, #13).
   *  Optional (not `null`-required) so every pre-#13 upsertWorker call site — which never set
   *  a PR — still type-checks; the DB column defaults to NULL. */
  pr?: number | null;
  /** Legacy 0/1 "has a trigger ever been posted" flag (#13). No longer consulted for gating
   *  (superseded by review_triggered_head/at, #55 P1-B) — kept only so the column can stay in
   *  the table without a rebuild migration. Optional; defaults to 0. */
  review_triggered?: number;
  /** The head oid this lane's review trigger (e.g. `@codex review`) was last posted for — the
   *  ENGINE-recorded pin (#55 P1-B), set by MergeDriver.driveOne via the recordTrigger callback
   *  the conductor supplies from State (see recordReviewTrigger). NULL/undefined means no
   *  trigger has been recorded for this lane yet (or the DB row predates this column) — the
   *  merge driver treats that as "post one now", and reviewer.ts's thumb verdict treats it as
   *  "no thumb can count yet" (fail-closed on both ends). */
  review_triggered_head?: string | null;
  /** ISO-8601 engine wall-clock timestamp the trigger above was posted at — the thumb-verdict
   *  freshness cutoff (reviewer.ts): a `+1` reaction only counts if `createdAt` is AFTER this
   *  AND review_triggered_head still equals the PR's CURRENT head. Not a git/commit timestamp
   *  (that was the P1-B bug: committedDate is forgeable via GIT_COMMITTER_DATE / cherry-picks
   *  and isn't tied to when the commit actually became the PR's head). */
  review_triggered_at?: string | null;
  /** The head oid a FALLBACK reviewer's MERGE_OK verdict is locked in for (#54) — see the
   *  schema v6->v7 migration comment. NULL/undefined means no fallback lock is held (the
   *  lane is on the primary reviewer, or the fallback chain is unconfigured). */
  review_fallback_head?: string | null;
  /** Which fallback reviewer kind (Reviewer["kind"]) produced the locked verdict above. Always
   *  set together with review_fallback_head (both null, or both non-null). */
  review_fallback_kind?: string | null;
}

/** Board status literal reused across forge/state (kept local to avoid a state.ts -> forge.ts
 *  import just for a 3-string union). Must stay in lockstep with IForge.setBoardStatus. */
export type BoardStatus = "ready" | "inProgress" | "done";

/** Categorized token counts from a stream-json result's `usage` block (#47). Always present
 *  and non-negative — a missing/malformed source field is normalized to 0, never omitted. */
export interface CategorizedTokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

/** One model's token usage for a lane (#47). worker.ts parses this from the stream-json
 *  result's `modelUsage` map (or, when absent, attributes the flat `usage` block to the
 *  session's reported model id — see worker.ts parseModelUsage). `model` is "unknown" only
 *  when the CLI gave no model identifier at all. */
export interface ModelUsageEntry extends CategorizedTokenUsage {
  model: string;
}

/** A durably-persisted recovery-path board mutation still awaiting success or escalation
 *  (#31 — see the schema v3->v4 migration comment for the double-failure window this closes). */
export interface PendingRollback {
  id: number;
  issue: number;
  target: BoardStatus;
  reason: string;
  attempts: number;
  created_at: string;
  last_attempt_at: string | null;
}

export class State {
  private readonly db: DatabaseSync;
  // The on-disk directory holding this engine's data (sqlite + sentinels). null for the
  // in-memory handles tests use — there is no directory to watch, so the kill switch is
  // always inactive there (tests inject their own via a real tmp-dir State instead).
  private readonly dataDir: string | null;

  constructor(path = "data/sapwood.sqlite") {
    // SQLite won't create missing parent dirs, and data/ is gitignored (absent on a
    // fresh checkout). Create it first. (Codex P2, PR #22.) Skip for special handles.
    const isMemory = path === ":memory:" || path.startsWith("file::memory:");
    this.dataDir = isMemory ? null : dirname(path);
    if (this.dataDir) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  /** Apply pending migrations in a transaction, bumping user_version. Idempotent. */
  private migrate(): void {
    const current = this.userVersion();
    if (current > MIGRATIONS.length) {
      throw new Error(
        `DB schema v${current} is newer than this engine (v${MIGRATIONS.length}); upgrade sapwood`,
      );
    }
    for (let v = current; v < MIGRATIONS.length; v++) {
      this.db.exec("BEGIN");
      try {
        MIGRATIONS[v]!(this.db);
        this.db.exec(`PRAGMA user_version = ${v + 1}`);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  userVersion(): number {
    const row = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    return row.user_version;
  }

  upsertWorker(row: WorkerRow): void {
    this.db
      .prepare(
        `INSERT INTO workers
           (name, issue, session_id, state, started_at, ended_at, pr, review_triggered,
            review_triggered_head, review_triggered_at, review_fallback_head, review_fallback_kind)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           issue = excluded.issue, session_id = excluded.session_id,
           state = excluded.state, started_at = excluded.started_at,
           ended_at = excluded.ended_at, pr = excluded.pr,
           review_triggered = excluded.review_triggered,
           review_triggered_head = excluded.review_triggered_head,
           review_triggered_at = excluded.review_triggered_at,
           review_fallback_head = excluded.review_fallback_head,
           review_fallback_kind = excluded.review_fallback_kind`,
      )
      .run(
        row.name, row.issue, row.session_id, row.state, row.started_at, row.ended_at,
        row.pr ?? null, row.review_triggered ?? 0,
        row.review_triggered_head ?? null, row.review_triggered_at ?? null,
        row.review_fallback_head ?? null, row.review_fallback_kind ?? null,
      );
  }

  /** Persist the ENGINE-recorded review-trigger pin for `name`'s lane (#55 P1-B) — called ONLY
   *  from MergeDriver.driveOne's recordTrigger callback (conductor.ts wires this method in),
   *  the instant a fresh `@codex review` trigger is posted for a NEW head. A worker/producer
   *  has no path to this method (no reference to State) and posting extra comments themselves
   *  cannot move this pin — it is written exclusively by the engine's own gate loop. */
  recordReviewTrigger(name: string, head: string, at: string): void {
    this.db
      .prepare("UPDATE workers SET review_triggered_head = ?, review_triggered_at = ? WHERE name = ?")
      .run(head, at, name);
  }

  /** Persist `name`'s lane's reviewer-failover lock (#54) — called from MergeDriver.driveOne's
   *  recordFallback callback (conductor.ts wires it in) the instant resolveReviewVerdict
   *  (reviewer.ts) returns a lock that differs from the one it was given. `head`/`kind` both
   *  null clears the lock (the primary recovered, or there was never one); both non-null
   *  records a fallback reviewer's MERGE_OK for that head. A worker/producer has no reference
   *  to State and cannot reach this method — same structural guarantee as recordReviewTrigger. */
  recordReviewFallback(name: string, head: string | null, kind: string | null): void {
    this.db
      .prepare("UPDATE workers SET review_fallback_head = ?, review_fallback_kind = ? WHERE name = ?")
      .run(head, kind, name);
  }

  getWorker(name: string): WorkerRow | undefined {
    return this.db.prepare("SELECT * FROM workers WHERE name = ?").get(name) as
      | WorkerRow
      | undefined;
  }

  /** In-flight lanes: workers still in the `running` state (the conductor reclaim/probe set). */
  runningWorkers(): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE state = 'running' ORDER BY name")
      .all() as unknown as WorkerRow[];
  }

  /** Occupied lanes: running + driving (a driving lane holds a PR awaiting the review gate
   *  and still counts against cfg.lanes.max). The dispatch capacity + in-flight set. */
  activeWorkers(): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE state IN ('running', 'driving') ORDER BY name")
      .all() as unknown as WorkerRow[];
  }

  /** Lanes holding a PR awaiting the review gate (#13's merge driver). No live worker process —
   *  just a lane occupying capacity until gate①/gate② resolve it to merged/needs-human/queued. */
  drivingWorkers(): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE state = 'driving' ORDER BY name")
      .all() as unknown as WorkerRow[];
  }

  appendEvent(kind: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)")
      .run(new Date().toISOString(), kind, JSON.stringify(payload));
  }

  // ── Engine cost ceiling + kill switch (#14) ───────────────────────────────────────────

  /** Record a completed worker's terminal cost (from stream-json, worker.ts). Call exactly
   *  once per lane at reclaim time (conductor.tick) — append-only, no in-place dedup.
   *  Clamped at this single choke point: the safety accumulator can only GROW. A negative or
   *  non-finite total_cost_usd (corrupt jsonl, bad parse) must never SUBTRACT from the daily
   *  sum and erode the hard cap (gate② PR #41 P3 — defense-in-depth; no worker-reachable
   *  write path is known, since workers get no --add-dir data).
   *
   *  #47: `models` is one row per (lane, model) — usually a single entry (the common case:
   *  one worker, one model for the whole run). The full clamped `usd` is recorded on the
   *  FIRST row only; any additional model rows (a fallback-model mid-run switch) get usd=0.
   *  stream-json's modelUsage map does not reliably carry a per-model cost breakdown across
   *  CLI versions, so rather than fabricate a split this keeps `SUM(usd)` for the lane exactly
   *  equal to the previous single-row behavior (the existing daily-cap query is untouched) —
   *  token counts are still recorded per model either way. Omitted/empty `models` -> one
   *  'unknown' row with 0 tokens, matching every pre-#47 row's shape. */
  recordSpend(worker: string, issue: number, usd: number, at: string, models: ModelUsageEntry[] = []): void {
    const safeUsd = Number.isFinite(usd) && usd > 0 ? usd : 0;
    // #46 resume cost-delta (gate② PR #41 P3 TRAP): a resumed lane reuses the SAME worker
    // name across multiple terminal transitions (handoff -> --resume -> done/failed/handoff
    // again). Claude Code's `--resume` continues the SAME session, so its terminal
    // total_cost_usd is the whole session's cumulative cost, not just the new leg — recording
    // it again in full here would double-count the pre-handoff portion already ledgered under
    // this worker name. Recording only the amount ABOVE what this worker name has already
    // banked makes every recordSpend call safe regardless of how many times it fires for the
    // same name: the first call (nothing banked yet) records the full total unchanged; a
    // resume's call records only the incremental delta. Floored at 0 (never negative) so a
    // lower/equal report — a short/corrupt read, or a CLI whose resume semantics turn out to
    // be non-cumulative after all (unverified here; see #46 scope 3's live run) — just adds
    // nothing further rather than eroding the ledger. DB-backed (not in-memory), so this is
    // correct across an engine restart between the handoff and the resume, too.
    const priorUsd = this.spentUsdForWorker(worker);
    const deltaUsd = Math.max(0, safeUsd - priorUsd);
    const rows = models.length > 0 ? models : [{ model: "unknown", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }];
    const safeInt = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
    const stmt = this.db.prepare(
      `INSERT INTO spend_ledger
         (ts, worker, issue, usd, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // ponytail: token counts are NOT delta-adjusted here (only usd, the flagged double-count
    // risk) — a resumed lane's token counts will over-count on re-terminal, same residual #47
    // already accepts for the model-usage breakdown (see its migration comment). Tracked as a
    // known follow-up, not silently swept: the daily USD cap (the actual safety boundary) is
    // exact; token telemetry for a resumed lane is approximate until that's worth the added
    // per-model bookkeeping.
    rows.forEach((m, i) => {
      stmt.run(
        at, worker, issue, i === 0 ? deltaUsd : 0,
        m.model || "unknown", safeInt(m.inputTokens), safeInt(m.outputTokens),
        safeInt(m.cacheReadTokens), safeInt(m.cacheCreationTokens),
      );
    });
  }

  /** Cumulative usd already ledgered under this worker NAME (across every prior terminal
   *  transition for it — normally one, but a resumed lane can have more). The resume
   *  cost-delta baseline (#46): see recordSpend's comment. */
  spentUsdForWorker(worker: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM spend_ledger WHERE worker = ?")
      .get(worker) as { total: number };
    return row.total;
  }

  /** Cumulative spend for `now`'s UTC calendar day (spend_ledger sum, ts-prefix match). */
  dailySpendUsd(now: Date): number {
    const dayPrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const row = this.db
      .prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM spend_ledger WHERE ts LIKE ?")
      .get(`${dayPrefix}%`) as { total: number };
    return row.total;
  }

  /** Active-session start for the wall-clock ceiling; call once per tick. Each call
   *  refreshes last_tick_at (the session's liveness heartbeat). If the previous tick is
   *  older than staleGapSec — the engine was stopped, crashed, or deliberately paused — the
   *  session RESETS to `now` and the wall-clock elapsed starts over. A continuously ticking
   *  engine (including a rapid crash-loop restart, whose gaps stay under the threshold)
   *  keeps accumulating and CANNOT evade the cap; recovery from a wall-clock breach is a
   *  deliberate operator action (pause longer than the gap, or raise cost.maxWallClockSec).
   *  (Codex PR #41 R2 P1.) */
  engineSessionStart(now: Date, staleGapSec: number): Date {
    const row = this.db
      .prepare("SELECT started_at, last_tick_at FROM engine_session WHERE id = 1")
      .get() as { started_at: string; last_tick_at: string } | undefined;
    const nowIso = now.toISOString();
    if (!row || (now.getTime() - Date.parse(row.last_tick_at)) / 1000 > staleGapSec) {
      this.db
        .prepare(
          `INSERT INTO engine_session (id, started_at, last_tick_at) VALUES (1, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             started_at = excluded.started_at, last_tick_at = excluded.last_tick_at`,
        )
        .run(nowIso, nowIso);
      return now;
    }
    this.db.prepare("UPDATE engine_session SET last_tick_at = ? WHERE id = 1").run(nowIso);
    return new Date(row.started_at);
  }

  /** Record a ceiling breach's first-detected time (INSERT OR IGNORE: re-detecting a
   *  still-active breach on a later tick must NOT reset the drain-window clock). */
  recordCeilingBreach(reasons: string[], now: Date): void {
    this.db
      .prepare("INSERT OR IGNORE INTO ceiling_breach (id, reason, at) VALUES (1, ?, ?)")
      .run(JSON.stringify(reasons), now.toISOString());
  }

  ceilingBreach(): { reasons: string[]; at: Date } | null {
    const row = this.db.prepare("SELECT reason, at FROM ceiling_breach WHERE id = 1").get() as
      | { reason: string; at: string }
      | undefined;
    if (!row) return null;
    return { reasons: JSON.parse(row.reason) as string[], at: new Date(row.at) };
  }

  /** Clear a resolved breach (e.g. the kill switch was lifted, or the daily cap rolled over
   *  to a fresh day) so a later re-breach starts its own fresh drain window. */
  clearCeilingBreach(): void {
    this.db.prepare("DELETE FROM ceiling_breach WHERE id = 1").run();
  }

  /** Out-of-band kill switch: a file sentinel in the engine's OWN data dir (never a worker's
   *  worktree — workers get no --add-dir data, so they cannot see or forge this path).
   *  Flippable by a human (`touch`/`rm`) without touching config. null dir (in-memory State,
   *  tests) -> never active. */
  killSwitchPath(): string | null {
    return this.dataDir ? join(this.dataDir, "KILL_SWITCH") : null;
  }

  isKillSwitchActive(): boolean {
    const p = this.killSwitchPath();
    return p != null && existsSync(p);
  }

  close(): void {
    this.db.close();
  }

  // ── Double-failure rollback/requeue hardening (#31) ───────────────────────────────────

  /** Persist a pending rollback BEFORE attempting the board mutation (durable retry marker).
   *  Returns the row id, which the caller threads through bumpPendingRollback/
   *  clearPendingRollback for the SAME attempt (the row created here IS "attempt 0"; the
   *  immediately-following attempt that motivated this call is recorded via those two, not a
   *  second insert). */
  addPendingRollback(issue: number, target: BoardStatus, reason: string, at: string): number {
    const res = this.db
      .prepare(
        "INSERT INTO pending_rollbacks (issue, target, reason, attempts, created_at) VALUES (?, ?, ?, 0, ?)",
      )
      .run(issue, target, reason, at);
    return Number(res.lastInsertRowid);
  }

  /** All rollbacks still awaiting success or escalation, oldest first (retry order). */
  pendingRollbacks(): PendingRollback[] {
    return this.db
      .prepare("SELECT * FROM pending_rollbacks ORDER BY id")
      .all() as unknown as PendingRollback[];
  }

  /** Record one more failed attempt (attempts++, last_attempt_at refreshed) — the row stays,
   *  to be retried again next tick. */
  bumpPendingRollback(id: number, at: string): void {
    this.db
      .prepare("UPDATE pending_rollbacks SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?")
      .run(at, id);
  }

  /** Resolved — either the mutation succeeded, or attempts hit the bounded retry cap and the
   *  conductor escalated to needs-human instead. Either way, stop retrying. */
  clearPendingRollback(id: number): void {
    this.db.prepare("DELETE FROM pending_rollbacks WHERE id = ?").run(id);
  }
}
