// Durable engine state. Replaces 0day's non-atomic jq read-modify-write
// (loop_conductor.sh:738-762). Conductor stays single-writer-serial; WAL gives atomic
// writes + concurrent reads (so `sapwood status` reads a live DB without blocking).
// Fully durable -> engine restart is a clean resume.
//
// Uses Node's built-in node:sqlite (unflagged since Node 22.13 — see engines floor).
// ponytail: zero native dep; if the API bites, swap to better-sqlite3 — same call shape.
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
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
  // reaches MERGE_OK for a lane's head while the primary is unavailable, these two columns
  // record that episode: the head it was obtained for, and which fallback reviewer kind
  // produced it. ADVISORY, never verdict-bearing (#54 R2, fable-review P2): this DB is outside
  // the guard write boundary, so the row is re-validated at the conductor read boundary
  // (isReviewerKind — an unknown kind string fails closed to no-lock) AND re-verified against
  // LIVE PR data at every use (resolveReviewVerdict re-runs the recorded mode's own verdict;
  // no matching approval artifact on the current head => no MERGE_OK). Forging this row
  // synthesizes nothing. Written exclusively by MergeDriver.driveOne's recordFallback callback
  // (conductor.ts wires it in), same pattern as review_triggered_head/at above. Nullable, no
  // default: every pre-existing row gets NULL (no episode) — fail-closed.
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN review_fallback_head TEXT;
      ALTER TABLE workers ADD COLUMN review_fallback_kind TEXT;
    `);
  },
  // 7 -> 8: rounds ledger (#86 — round-loop skeleton, #77 decisions 1/2/4). A round layers
  // ABOVE the tick engine: dispatch a batch -> tick until it drains -> peripheral-phase stubs
  // (aligning/architecting/plan_review before executing; harvesting/retro after) -> close ->
  // next round. `phase` is the cursor (round.ts's RoundPhase enum); `status` distinguishes a
  // round still being driven from one fully closed. `artifact_ref` is the CURRENT phase's
  // externalized idempotency marker (#77 decision 4, rerun-not-resume): a crash mid-phase
  // leaves this row `in_progress` at that same phase; on restart the round loop re-invokes
  // ONLY that phase's stub fresh (never resuming a prior attempt's mid-session state, never
  // re-running an earlier already-completed phase), handing the stub this marker so it can
  // recognize "already externalized, don't duplicate" rather than blindly redoing the side
  // effect. Nullable: cleared every time the phase cursor advances (a new phase starts with no
  // marker of its own). One row per round; at most one `in_progress` row is expected at a time
  // (round.ts's own invariant, not DB-enforced — mirrors workers' single-writer-serial
  // assumption elsewhere in this file).
  (db) => {
    db.exec(`
      CREATE TABLE rounds (
        round_id     INTEGER PRIMARY KEY AUTOINCREMENT,
        phase        TEXT NOT NULL,
        status       TEXT NOT NULL,
        artifact_ref TEXT,
        started_at   TEXT NOT NULL,
        updated_at   TEXT NOT NULL,
        ended_at     TEXT
      );
    `);
  },
  // 8 -> 9: gated-PR reentry (#147). A driving lane's PR that gate②/mergeDecision escalates to
  // needs-human (the DRIVE loop's "needs-human" case) parks it `failed` with its `pr` still
  // set — the ONLY shape a `failed` row with a non-null `pr` can have (every OTHER failed path
  // — dead lane, ceiling drain, ESCALATE_NOPR, dirty-worktree retention — never persists a pr,
  // since that column is written exclusively at the running->driving transition). The
  // conductor's GATED RECLAIM phase (conductor.ts tick()) uses that shape to find candidates:
  // once a human removes needs-human from the ISSUE (the explicit re-entry signal, PLAN.md
  // autonomy principle), it reclaims the row straight back to `driving` — same worker name,
  // same PR/branch, no new dispatch. `gated_reentry_attempts` counts how many times THIS row has
  // been reclaimed this way (bounded by cfg.lanes.gatedReentryCap, the prFixCap pattern);
  // `gated_reentry_capped` is a permanent one-way latch set once the cap is spent, so a lane
  // that keeps re-escalating after every attempt is never retried forever — a further label
  // removal just re-escalates and is ignored by GATED RECLAIM's query (gated_reentry_capped = 0
  // filter) from then on. Both NOT NULL DEFAULT 0: every pre-existing row (which by definition
  // was never reclaimed this way) starts at "never attempted, never capped".
  //
  // `gated_escalation_labeled` (#147 P2, Codex PR #151): the reentry signal is "the needs-human
  // label is ABSENT from the issue" — but absence only means a human acted if the engine
  // actually APPLIED the label in the first place. The DRIVE escalation's addLabel call can
  // fail transiently; without a durable success marker, a failed+PR row whose label never
  // landed reads as "a human removed it" on the very next tick and automation re-admits itself
  // with no human in the loop. So the escalation records label-write success (1) or failure (0)
  // here, and gatedFailedWorkers() requires 1: a row whose label write failed is permanently
  // invisible to GATED RECLAIM (same manual-drive situation as pre-#147 — no regression), and
  // the invariant "reclaim requires a real human removal of a label the engine actually
  // applied" holds. BACK-COMPAT (deliberate, fail-closed): pre-existing failed+PR rows from
  // before this migration default to 0 and become invisible to reclaim — their labels were
  // applied by the old code path, but that can't be proven from here, so they stay on the
  // manual-drive path they were already on.
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN gated_reentry_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workers ADD COLUMN gated_reentry_capped INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workers ADD COLUMN gated_escalation_labeled INTEGER NOT NULL DEFAULT 0;
    `);
  },
];

export const SCHEMA_VERSION = MIGRATIONS.length;

/** True when a SQLite error means "can't write to this location because the FILESYSTEM is
 *  read-only" — i.e. the normal read-only open can't create the -shm it needs to read WAL
 *  frames. node:sqlite surfaces the extended result code on `.errcode`; the SQLITE_READONLY
 *  (primary 8) and SQLITE_CANTOPEN (primary 14) families both cover this, across their
 *  extended variants (e.g. SQLITE_READONLY_DIRECTORY = 1544). Falls back to a message match
 *  only if no numeric code is present. Deliberately narrow: a genuine corruption/format error
 *  must propagate, not be silently masked as a "stale snapshot" (Codex PR #70 round-5). */
function isReadOnlyFsError(e: unknown): boolean {
  const code = (e as { errcode?: unknown }).errcode;
  if (typeof code === "number") {
    const primary = code & 0xff;
    return primary === 8 /* SQLITE_READONLY */ || primary === 14 /* SQLITE_CANTOPEN */;
  }
  return /readonly|read-only|unable to open/i.test(String((e as { message?: unknown }).message ?? ""));
}

/** Open a DB read-only for `sapwood status`. See the State constructor's readOnly doc for the
 *  full rationale; this is factored out so the normal-open-then-immutable-fallback control
 *  flow reads cleanly. Never mutates sapwood state (query_only, no migrations). */
function openReadOnly(path: string, isMemory: boolean): DatabaseSync {
  // In-memory handles (tests) have no on-disk file and no WAL sidecar concern.
  if (isMemory) {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    return db;
  }
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    // Probe: forces the -shm access a WAL DB needs, so a read-only-FS failure lands HERE
    // (where we can fall back) rather than later mid-status. On a writable FS this may
    // create SQLite's own -wal/-shm coordination files — acceptable (not sapwood state).
    db.prepare("PRAGMA user_version").get();
    return db;
  } catch (e) {
    if (!isReadOnlyFsError(e)) throw e;
    // Read-only filesystem: SQLite can't create the -shm needed to read live WAL frames.
    // Fall back to immutable (reads the main DB directly, zero file creation) and warn that
    // a running engine's uncommitted-to-main rows won't be visible.
    process.stderr.write(
      `sapwood: state DB at ${path} is on a read-only filesystem — reading it immutably. ` +
        `If the engine is currently running, this snapshot may be stale (uncommitted WAL ` +
        `frames are not visible).\n`,
    );
    const db = new DatabaseSync(`${pathToFileURL(path).href}?immutable=1`, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    return db;
  }
}

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
  /** The head oid a FALLBACK reviewer's MERGE_OK was obtained on (#54) — ADVISORY episode
   *  marker, re-validated + re-verified against live PR data at every use (see the schema
   *  v6->v7 migration comment). NULL/undefined means no episode (the lane is on the primary
   *  reviewer, or the fallback chain is unconfigured). */
  review_fallback_head?: string | null;
  /** Which fallback reviewer kind (Reviewer["kind"]) produced the approval above. Plain TEXT
   *  here; validated with isReviewerKind at the conductor read boundary — an unknown string
   *  fails closed to no-lock. Always set together with review_fallback_head. */
  review_fallback_kind?: string | null;
  /** #147: how many times this lane has been reclaimed by the GATED RECLAIM phase (conductor.ts
   *  tick()) after a human removed needs-human from its issue. 0 for every lane that has never
   *  gone through it (including a first-time drive-needs-human escalation) — see conductor.ts's
   *  DRIVE loop, which uses `> 0` here to attach the attempt-trail comment only on a REPEAT
   *  escalation, never the original one. Optional; DB default 0. */
  gated_reentry_attempts?: number;
  /** #147: one-way latch — 1 once gated_reentry_attempts has hit cfg.lanes.gatedReentryCap AND
   *  a human has removed needs-human again anyway. Permanently excludes the row from
   *  State.gatedFailedWorkers() (fail-closed: never retried forever). Optional; DB default 0. */
  gated_reentry_capped?: number;
  /** #147 P2: 1 iff the DRIVE escalation's needs-human addLabel call SUCCEEDED for this row's
   *  terminal transition — the durable proof that "label absent" later means a human removed
   *  it, not that the engine never applied it. gatedFailedWorkers() requires 1; a row whose
   *  label write failed (0) is permanently invisible to GATED RECLAIM (fail-closed — see the
   *  schema v8->v9 migration comment, incl. the deliberate pre-migration back-compat).
   *  Optional; DB default 0. */
  gated_escalation_labeled?: number;
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

// ── Rounds ledger (#86) ────────────────────────────────────────────────────────────────────

/** The round-loop's phase cursor (round.ts). Peripheral-phase stubs run in `aligning`,
 *  `architecting`, `plan_review` (pre-executing) and `harvesting`, `retro` (post-executing);
 *  `executing` is the real tick-engine dispatch-batch-then-drain phase (no stub — tick()
 *  itself, unmodified); `closed` is terminal. */
export type RoundPhase =
  | "aligning"
  | "architecting"
  | "plan_review"
  | "executing"
  | "harvesting"
  | "retro"
  | "closed";

export type RoundStatus = "in_progress" | "done";

export interface RoundRow {
  round_id: number;
  phase: RoundPhase;
  status: RoundStatus;
  /** The CURRENT phase's externalized idempotency marker, or null if that phase hasn't
   *  persisted one yet. See the schema v7->v8 migration comment for the rerun-not-resume
   *  contract this backs. */
  artifact_ref: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
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

  /** readOnly (#15, Codex PR #70): open the DB for inspection by `sapwood status` WITHOUT
   *  mutating sapwood STATE — no parent-dir mkdir, no journal_mode/foreign_keys pragma
   *  writes, no migrations, and `PRAGMA query_only` so no SQL can write schema/data. The DB
   *  may belong to an engine (possibly an OLDER engine) still running; the caller re-checks
   *  userVersion() itself (cli.ts runStatus) since the schema may be ahead/behind.
   *
   *  Open strategy (Codex PR #70 round-5 P2 — live-correctness wins over zero-sidecars):
   *  status's PRIMARY job is inspecting a LIVE engine, whose newest committed rows can exist
   *  only in the `-wal` sidecar. So we do a NORMAL read-only open first (SQLITE_OPEN_READONLY,
   *  NOT immutable): it reads live WAL frames correctly. SQLite may create its own `-wal`/
   *  `-shm` COORDINATION sidecars to do so — those are SQLite's, not sapwood state, and are
   *  explicitly acceptable here. A probe read in this constructor forces that `-shm` access
   *  now, so the ONE case where a normal open can't work — a read-only FILESYSTEM, where
   *  SQLite can't create the `-shm` it needs (SQLITE_READONLY* / SQLITE_CANTOPEN) — surfaces
   *  here instead of mid-status. Only then do we fall back to an `immutable=1` file: URI
   *  (reads the main DB directly, ZERO file creation) AND warn on stderr that a running
   *  engine's uncommitted-to-main WAL frames won't be visible (a possibly-stale snapshot is
   *  the honest best a read-only FS allows). Write methods throw at the SQLite layer. */
  constructor(path = "data/sapwood.sqlite", opts: { readOnly?: boolean } = {}) {
    // SQLite won't create missing parent dirs, and data/ is gitignored (absent on a
    // fresh checkout). Create it first. (Codex P2, PR #22.) Skip for special handles.
    const isMemory = path === ":memory:" || path.startsWith("file::memory:");
    this.dataDir = isMemory ? null : dirname(path);
    if (opts.readOnly) {
      this.db = openReadOnly(path, isMemory);
      return;
    }
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
            review_triggered_head, review_triggered_at, review_fallback_head, review_fallback_kind,
            gated_reentry_attempts, gated_reentry_capped, gated_escalation_labeled)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           issue = excluded.issue, session_id = excluded.session_id,
           state = excluded.state, started_at = excluded.started_at,
           ended_at = excluded.ended_at, pr = excluded.pr,
           review_triggered = excluded.review_triggered,
           review_triggered_head = excluded.review_triggered_head,
           review_triggered_at = excluded.review_triggered_at,
           review_fallback_head = excluded.review_fallback_head,
           review_fallback_kind = excluded.review_fallback_kind,
           gated_reentry_attempts = excluded.gated_reentry_attempts,
           gated_reentry_capped = excluded.gated_reentry_capped,
           gated_escalation_labeled = excluded.gated_escalation_labeled`,
      )
      .run(
        row.name, row.issue, row.session_id, row.state, row.started_at, row.ended_at,
        row.pr ?? null, row.review_triggered ?? 0,
        row.review_triggered_head ?? null, row.review_triggered_at ?? null,
        row.review_fallback_head ?? null, row.review_fallback_kind ?? null,
        row.gated_reentry_attempts ?? 0, row.gated_reentry_capped ?? 0,
        row.gated_escalation_labeled ?? 0,
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

  /** Persist `name`'s lane's reviewer-failover episode marker (#54) — called from
   *  MergeDriver.driveOne's recordFallback callback (conductor.ts wires it in). Both non-null
   *  records a fallback reviewer's MERGE_OK for that head; both null clears it, which happens
   *  ONLY on a head change (driveOne's re-trigger branch — Codex PR #71 P2: never cleared at
   *  verdict-resolution time). Advisory either way: the row is re-verified against live PR
   *  data at every use (see the v6->v7 migration comment). A worker/producer has no reference
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

  /** #147 gated-PR reentry candidates: `failed` lanes still carrying a PR number. `pr` is
   *  written ONLY at the running->driving transition, so a `failed` row with a non-null `pr`
   *  can only be a DRIVE-loop gate②/mergeDecision escalation (needs-human) — every other failed
   *  path (dead lane, ceiling drain, ESCALATE_NOPR, dirty-worktree retention) never sets it. The
   *  conductor's GATED RECLAIM phase reads this, checks the issue's LIVE needs-human label, and
   *  reclaims eligible rows straight to `driving` — never a new dispatch. `gated_reentry_capped
   *  = 0` permanently drops a row once its reentry attempts are spent (fail-closed one-way
   *  latch — see the schema v8->v9 migration comment); no lane a human keeps re-escalating is
   *  retried forever. `gated_escalation_labeled = 1` (#147 P2) requires the escalation's
   *  needs-human label write to have actually SUCCEEDED — label absence is only a human act if
   *  the engine provably applied the label; a row whose label write failed (or that predates
   *  the marker) is permanently invisible here (fail-closed, manual drive as before #147). */
  gatedFailedWorkers(): WorkerRow[] {
    return this.db
      .prepare(
        "SELECT * FROM workers WHERE state = 'failed' AND pr IS NOT NULL AND gated_reentry_capped = 0 AND gated_escalation_labeled = 1 ORDER BY name",
      )
      .all() as unknown as WorkerRow[];
  }

  appendEvent(kind: string, payload: unknown): void {
    this.db
      .prepare("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)")
      .run(new Date().toISOString(), kind, JSON.stringify(payload));
  }

  /** The most recent reviewer-failover announcement for `worker`'s lane (#54 R2) — tick()'s
   *  dedup source: driveOne reports the switch/revert signal STATELESSLY on every tick the
   *  condition holds (resolveReviewVerdict is pure and has no memory), so the durable event
   *  log itself is the memory of what was already announced. Announce only when the incoming
   *  (kind, mode, pr, head) differs from this row — one announcement per episode transition,
   *  restart-safe, and a NEW head (a new episode) announces again. */
  lastReviewerFallbackEvent(worker: string): { kind: string; mode: string; pr: number; head: string } | null {
    const row = this.db
      .prepare(
        `SELECT kind, payload FROM events
         WHERE kind IN ('reviewer-fallback-switch', 'reviewer-fallback-revert')
           AND json_extract(payload, '$.worker') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(worker) as { kind: string; payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { mode?: string; pr?: number; head?: string };
    return { kind: row.kind, mode: p.mode ?? "", pr: p.pr ?? -1, head: p.head ?? "" };
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

  /** Out-of-band PAUSE sentinel (#75): same file-sentinel pattern as KILL_SWITCH above — a
   *  human-flippable file in the engine's OWN data dir. NOTE: that dir sits outside worker
   *  worktrees as a permission-layer boundary (no --add-dir data), not an OS sandbox — the
   *  same (pre-existing) residual write vector as KILL_SWITCH applies; guard defense-in-depth
   *  for both sentinel paths is tracked as a follow-up. Strictly gentler than the kill switch:
   *  see conductor.tick()'s DISPATCH-only skip, which is the only place this is consulted.
   *  null dir (in-memory State, tests) -> never active, same as killSwitchPath. */
  pausePath(): string | null {
    return this.dataDir ? join(this.dataDir, "PAUSE") : null;
  }

  isPauseActive(): boolean {
    const p = this.pausePath();
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

  // ── Rounds ledger (#86) ─────────────────────────────────────────────────────────────────

  /** Insert a fresh round in phase 'aligning', status 'in_progress', no marker. Returns the
   *  created row (round_id assigned by SQLite). */
  startRound(now: string): RoundRow {
    const res = this.db
      .prepare(
        "INSERT INTO rounds (phase, status, artifact_ref, started_at, updated_at) VALUES ('aligning', 'in_progress', NULL, ?, ?)",
      )
      .run(now, now);
    return {
      round_id: Number(res.lastInsertRowid),
      phase: "aligning",
      status: "in_progress",
      artifact_ref: null,
      started_at: now,
      updated_at: now,
      ended_at: null,
    };
  }

  /** The most recent round still `in_progress` — a round.ts restart's rerun-not-resume probe
   *  (#77 decision 4). At most one is expected to exist at a time (round.ts's own invariant);
   *  `ORDER BY round_id DESC LIMIT 1` is a defensive tiebreak, not evidence multiple are normal. */
  openRound(): RoundRow | undefined {
    return this.db
      .prepare("SELECT * FROM rounds WHERE status = 'in_progress' ORDER BY round_id DESC LIMIT 1")
      .get() as RoundRow | undefined;
  }

  getRound(id: number): RoundRow | undefined {
    return this.db.prepare("SELECT * FROM rounds WHERE round_id = ?").get(id) as RoundRow | undefined;
  }

  /** Advance the phase cursor. Always CLEARS artifact_ref — a newly-entered phase has no
   *  marker of its own yet (the previous phase's marker is irrelevant once it's done; see the
   *  schema v7->v8 migration comment). */
  advanceRoundPhase(id: number, phase: RoundPhase, now: string): void {
    this.db
      .prepare("UPDATE rounds SET phase = ?, artifact_ref = NULL, updated_at = ? WHERE round_id = ?")
      .run(phase, now, id);
  }

  /** Persist a phase stub's externalized idempotency token WITHOUT changing phase — the
   *  rerun-not-resume marker a crash-and-restart hands back to that same phase's stub. */
  setRoundMarker(id: number, marker: string, now?: string): void {
    this.db
      .prepare("UPDATE rounds SET artifact_ref = ?, updated_at = ? WHERE round_id = ?")
      .run(marker, now ?? new Date().toISOString(), id);
  }

  /** Close a round: phase 'closed', status 'done', ended_at stamped. Terminal — round.ts never
   *  reopens a closed round (a new round gets its own row via startRound). */
  closeRound(id: number, now: string): void {
    this.db
      .prepare("UPDATE rounds SET phase = 'closed', status = 'done', updated_at = ?, ended_at = ? WHERE round_id = ?")
      .run(now, now, id);
  }

  // ── #91: harvest/retro round-ledger reads ─────────────────────────────────────────────

  /** Durable event-log rows at or after `sinceIso`, restricted to `kinds` — the harvest/retro
   *  peripherals' round-ledger source (conductor.ts's DRIVE/RECLAIM phases already append every
   *  event these two roles summarize; see harvest.ts's gatherRoundFacts / retro.ts's
   *  gatherRetroFacts for the specific kinds each reads). Chronological (by id) order, parsed
   *  payload. `kinds` must be non-empty — an empty SQL `IN ()` is invalid, so this throws rather
   *  than silently returning everything or nothing (a caller bug, not a runtime condition to
   *  degrade gracefully from). */
  eventsSince(sinceIso: string, kinds: string[]): { kind: string; payload: unknown }[] {
    if (kinds.length === 0) throw new Error("eventsSince: kinds must be non-empty");
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT kind, payload FROM events WHERE ts >= ? AND kind IN (${placeholders}) ORDER BY id`)
      .all(sinceIso, ...kinds) as { kind: string; payload: string }[];
    return rows.map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
  }

  /** Cumulative spend_ledger sum at or after `sinceIso` — harvest's "spend vs round budget"
   *  fact. Same table/column as dailySpendUsd; a `>=` cutoff rather than a calendar-day prefix
   *  match, since a round doesn't align to a day boundary. */
  spentUsdSince(sinceIso: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM spend_ledger WHERE ts >= ?")
      .get(sinceIso) as { total: number };
    return row.total;
  }
}
