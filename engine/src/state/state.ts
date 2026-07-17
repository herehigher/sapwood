// Durable engine state. Replaces 0day's non-atomic jq read-modify-write
// (loop_conductor.sh:738-762). Conductor stays single-writer-serial; WAL gives atomic
// writes + concurrent reads (so `sapwood status` reads a live DB without blocking).
// Fully durable -> engine restart is a clean resume.
//
// Uses Node's built-in node:sqlite (unflagged since Node 22.13 — see engines floor).
// ponytail: zero native dep; if the API bites, swap to better-sqlite3 — same call shape.
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Ordered migrations. index N upgrades schema from user_version N to N+1. Append-only:
// never edit a shipped migration, add a new one. user_version (a SQLite builtin) is the
// on-disk schema version — the migration path #5 asks for.
/** #123 (v9->v10 backfill, Codex round-5 P2 on PR #152): timestamp-approximate ledger cursors
 *  for rounds that predate the cursor columns — everything with ts strictly BEFORE the round's
 *  started_at is pre-round. Exported for direct testing (the migration path itself only runs
 *  once per DB). Idempotent over legacy rows; never invoked on rows startRound stamped, except
 *  harmlessly during the one migration that creates the columns. */
export function backfillLegacyRoundCursors(db: DatabaseSync): void {
  db.exec(`
    UPDATE rounds SET
      start_event_id = COALESCE((SELECT MAX(id) FROM events WHERE ts < rounds.started_at), 0),
      start_spend_id = COALESCE((SELECT MAX(id) FROM spend_ledger WHERE ts < rounds.started_at), 0);
  `);
}

// Exported for state.test.ts's REAL migration test (PR #180 review P3-2): the test builds a
// populated v(N-1) DB by running MIGRATIONS[0..N-1] directly, then opens it with State to prove
// the newest migration preserves existing data. Never call these outside State.migrate()/tests.
export const MIGRATIONS: ((db: DatabaseSync) => void)[] = [
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
  // 9 -> 10: round summary artifact (#123, M5 item 3). One row per CLOSED round — the
  // schema-validated JSON round-artifact.ts assembles from the event ledger at round.ts's
  // closeRound call site (round-artifact.ts's persistRoundArtifact). `round_id` is the primary
  // key (one artifact per round, upsert-on-conflict — see State.saveRoundArtifact); `json` is
  // the full validated object (the source of truth — the on-disk markdown view is always
  // RE-DERIVED from it, never authored independently); `schema_version` lets a future reader
  // (the #17 dashboard included) detect an older artifact shape without re-parsing the JSON.
  (db) => {
    db.exec(`
      CREATE TABLE round_artifacts (
        round_id       INTEGER PRIMARY KEY,
        schema_version INTEGER NOT NULL,
        json           TEXT NOT NULL,
        updated_at     TEXT NOT NULL
      );
      -- #123 (Codex P2, PR #152): the round's ledger WINDOW is id-cursor-bounded, not
      -- timestamp-bounded — events/spend timestamps are millisecond-granular, so a previous
      -- round's tail write landing in the same ms as the next round's started_at would bleed
      -- into the wrong artifact under a ts >= started_at read. startRound stamps the current
      -- MAX(id) of both tables; the artifact reads strictly-greater ids.
      ALTER TABLE rounds ADD COLUMN start_event_id INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE rounds ADD COLUMN start_spend_id INTEGER NOT NULL DEFAULT 0;
    `);
    // Backfill for PRE-migration rows (Codex round-5 P2): an in_progress round can survive an
    // upgrade (crash -> upgrade -> restart resumes it via openRound), and cursor 0 would make
    // its resumed harvest/close aggregate the WHOLE historical ledger. Approximate the cursor
    // from the timestamps the legacy rows do have (ts < started_at = before the round) — the
    // same-ms ambiguity this migration exists to remove is accepted for legacy rows only.
    backfillLegacyRoundCursors(db);
  },
  // 10 -> 11: per-probe lane telemetry (#155) — the priced-cost snapshot + context/composition
  // trio a still-`running` lane's dashboard display needs (docs/frontend-design.md §8),
  // refreshed on every RECLAIM-phase probe (conductor.ts) via State.setLiveTelemetry and
  // cleared the instant the lane leaves `running` (handoff/done/driving/failed) via
  // State.clearLiveTelemetry. This is a LIVE DISPLAY CACHE only — the settled real cost for a
  // finished lane still lives in spend_ledger (recordSpend, unchanged); these three columns are
  // never read for accounting, only for "what is a live lane doing right now". Update-in-place
  // (no companion event-per-probe table, unlike spend_ledger/#47's append-only ledger) —
  // per-tick × per-lane telemetry events would bloat the append-only log for zero replay value
  // (the issue's own implementation note). Nullable, no default: every pre-existing row reads
  // as "no live telemetry" — the exact same shape a freshly-cleared row has, so a pre-#155 DB
  // upgrades with no behavior change until the next probe of a running lane populates them.
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN est_cost_usd REAL;
      ALTER TABLE workers ADD COLUMN context_tokens INTEGER;
      ALTER TABLE workers ADD COLUMN token_composition TEXT;
    `);
  },
  // 11 -> 12: environment-failure park (#168). ONE ROW PER SOURCE (PK = source — PR #180 review
  // P1-1a: a singleton row silently DROPPED a forge failure arriving mid-llm-episode; per-source
  // rows record a mixed storm faithfully, and the engine resumes dispatch only when ZERO rows
  // remain). The CTO architecture directive for #168 is explicit: park state lives in the STATE
  // DB, never a new control-sentinel file. This repo's locked partition is "SQLite = runtime-
  // state machine; sentinels = human out-of-band controls (KILL_SWITCH/PAUSE)" — park state/
  // reason/source/entered-at is runtime state the engine itself derives (an env-failure
  // classification), not a human control input, so it belongs here. The direct payoff: an
  // engine restart mid-park resumes probing (never dispatching) purely from normal state
  // loading — conductor.ts's tick() just re-reads parkedSources() like any other row, no
  // bespoke crash-recovery path needed.
  //
  // Per-source columns are the FIRST detection's classification (see State.enterPark's INSERT
  // OR IGNORE — re-detecting the SAME source while already parked must not reset `entered_at`,
  // or a storm of failures could push the duration-based escalation threshold out
  // indefinitely). `last_probe_at` is NOT NULL — initialized to entered_at at park entry
  // (PR #180 review P1-1c: a NULL "never probed" made the first probe due IMMEDIATELY, which
  // for the llm source meant a same-tick clear-park-and-redispatch oscillation; seeding it
  // makes the first wait a full base backoff). `probe_attempts` backs the bounded exponential
  // backoff (env-failure.ts's probeBackoffSec/probeDue) — a COUNT for backoff math only, never
  // itself the escalation trigger (issue #168 decision 3: escalation is duration-based, since
  // backoff makes a probe count an ambiguous measure of elapsed time). `escalated_at` is a
  // one-way latch per episode: null until the duration-based human notification fires, never
  // re-fires after (additive, not a state transition — probing and auto-resume continue
  // unaffected either way). `canary_worker` (llm rows only; PR #180 review P1-1b): the ONE
  // in-flight canary lane's name while an llm-park recovery attempt is being tested — see
  // conductor.ts's PARK section for the canary contract (the cheap-model inference ping is a
  // capacity filter, never a recovery signal; only a real lane reaching a non-env-classified
  // terminal state clears the llm row).
  (db) => {
    db.exec(`
      CREATE TABLE park_state (
        source         TEXT PRIMARY KEY CHECK (source IN ('llm', 'forge')),
        reason         TEXT NOT NULL,
        trigger_issue  INTEGER,
        entered_at     TEXT NOT NULL,
        last_probe_at  TEXT NOT NULL,
        probe_attempts INTEGER NOT NULL DEFAULT 0,
        escalated_at   TEXT,
        canary_worker  TEXT
      );
    `);
  },
  // 12 -> 13: graceful-handoff resume (#172). Mirrors gated-PR reentry's worker-row column
  // pattern: `resume_attempts` counts successful handoff -> running reentries for this lane;
  // `resume_capped` is the one-way latch set after the cap's needs-human label provably lands.
  // Handoff rows predating this migration start eligible with zero attempts. No table/process/
  // side channel: handoff remains the terminal-but-resumable runtime state it already was.
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN resume_attempts INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workers ADD COLUMN resume_capped INTEGER NOT NULL DEFAULT 0;
    `);
  },
  // 13 -> 14: input manifest (#231) — the "what did this decision actually see" record for
  // every engine-controlled input channel a peripheral SESSION was actually given (goal file,
  // backlog digest, pool candidates, ...). One row per (round, phase, role, session, attempt,
  // channel) — same "one row per dimension" shape as spend_ledger's (lane, model) rows, not a
  // JSON blob, so a channel's read status/counts/truncation stay independently queryable.
  // `attempt` is NEVER supplied from a caller's own in-memory counter (lost across a crash) —
  // it is DERIVED here, from the existing rows for the same (round_id, phase, role, session)
  // tuple (State.nextInputManifestAttempt, a plain MAX(attempt)+1 read), so a crash-rerun that
  // reaches the same session-dispatch point again is automatically attempt 2, 3, ... with zero
  // extra bookkeeping, and its manifest rows are provably DISTINGUISHABLE from the original
  // attempt's (#231 acceptance criterion). A RECORD only (#231 design ruling): nothing in this
  // codebase gates a session or a phase on what this table holds — State.appendInputManifest is
  // a plain write a caller wraps best-effort (align.ts's recordInputManifest), the same "record,
  // not gate" contract as round_artifacts. `ok=0` + `detail` covers a failed read (goal file
  // unreadable, backlog read failed); `total/rendered/omitted/truncated` cover a bounded
  // digest's pack (align.ts's packDigestRecords) — null/0 for a channel with no meaningful count
  // (e.g. a single-file read). `version` is a short content hash (align.ts's contentVersion) so
  // two successful attempts can still be told apart.
  (db) => {
    db.exec(`
      CREATE TABLE input_manifest (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id  INTEGER NOT NULL,
        phase     TEXT NOT NULL,
        role      TEXT NOT NULL,
        session   TEXT NOT NULL,
        attempt   INTEGER NOT NULL,
        channel   TEXT NOT NULL,
        ok        INTEGER NOT NULL,
        version   TEXT,
        total     INTEGER,
        rendered  INTEGER,
        omitted   INTEGER,
        truncated INTEGER NOT NULL DEFAULT 0,
        detail    TEXT,
        ts        TEXT NOT NULL
      );
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
  /** #172: successful handoff -> running reentries for this lane. The initial dispatch is leg
   *  zero and is not counted; bounded by cfg.worker.maxResumes. Optional; DB default 0. */
  resume_attempts?: number;
  /** #172: one-way cap latch. Set only after needs-human provably lands, then permanently
   *  excludes this handoff row from State.handoffWorkers(). Optional; DB default 0. */
  resume_capped?: number;
  /** #155: LIVE priced-cost snapshot (worker.ts's #33 pricing pipeline, baseline-adjusted the
   *  same way the soft-budget check is) for a still-`running` lane — refreshed on every
   *  RECLAIM-phase probe via State.setLiveTelemetry. NULL while not running, or once the lane
   *  is reclaimed (State.clearLiveTelemetry — see the schema v10->v11 migration comment). This
   *  is a display snapshot ONLY: it settles into the real number spend_ledger holds once the
   *  lane terminates, and is never itself read for accounting. */
  est_cost_usd?: number | null;
  /** #155: the newest assistant message's input + cache_read + cache_creation tokens — what
   *  the model saw on its last turn. Deliberately NON-monotonic (a drop marks an auto-compact,
   *  itself display-worthy). NULL while not running / cleared at reclaim. */
  context_tokens?: number | null;
  /** #155: cumulative 4-class token split (JSON-encoded `CategorizedTokenUsage`) for a still-
   *  running lane. NULL while not running / cleared at reclaim. Stored as TEXT (like
   *  round_artifacts.json) rather than 4 separate columns — one JSON blob read/written
   *  atomically per probe, and the shape is display-only (never queried by column). */
  token_composition?: string | null;
}

/** Board status literal reused across forge/state (kept local to avoid a state.ts -> forge.ts
 *  import just for a 4-string union). Must stay in lockstep with IForge.setBoardStatus. */
export type BoardStatus = "backlog" | "ready" | "inProgress" | "done";

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
export type RoundPhase = "aligning" | "architecting" | "plan_review" | "executing" | "harvesting" | "retro" | "closed";

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
  /** #123: id cursors capturing MAX(events.id)/MAX(spend_ledger.id) at startRound — the round's
   *  ledger window is `id > cursor`, immune to same-millisecond timestamp collisions at round
   *  boundaries. 0 on rows predating the v9->v10 migration (long closed, never rebuilt). */
  start_event_id?: number;
  start_spend_id?: number;
}

/** #231: one engine-controlled input channel's read record for one peripheral session attempt —
 *  see the schema v13->v14 migration comment for the full table-shape rationale. `attempt` is
 *  populated by the CALLER from State.nextInputManifestAttempt (itself derived from durable
 *  state, never an in-memory counter) — appendInputManifest never computes it on its own, so
 *  several channel rows from the SAME session dispatch share the SAME attempt number: state.ts
 *  deliberately does not auto-increment per row, since that would make every channel of one
 *  session read as its own "attempt", which is wrong — the whole point is one attempt per
 *  session dispatch, covering however many input channels that dispatch consumed. */
export interface InputManifestRow {
  round_id: number;
  phase: string;
  role: string;
  session: string;
  attempt: number;
  channel: string;
  /** false iff the underlying read for this channel failed (see `detail` for why). */
  ok: boolean;
  /** Short content hash/version of what was actually read — lets two `ok: true` attempts be
   *  told apart even when neither failed. Absent when there's nothing meaningful to hash (a
   *  failed read, or a channel with no content of its own). */
  version?: string | null;
  /** Bounded-digest pack counts (align.ts's packDigestRecords) — null for a channel that isn't
   *  a multi-record digest (e.g. a single-file read uses total=1/rendered=1|0/omitted=0|1). */
  total?: number | null;
  rendered?: number | null;
  omitted?: number | null;
  truncated?: boolean;
  /** Free-text detail — a failure reason on `ok: false`, otherwise unset. */
  detail?: string | null;
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

export type EnvFailureSource = "llm" | "forge";

/** #168: one environment-failure park episode — ONE ROW PER SOURCE (see the schema v11->v12
 *  migration comment for why per-source rows and why this lives in the state DB, not a file
 *  sentinel). `triggerIssue` is the issue whose lane failure caused this episode, or null.
 *  `canaryWorker` (llm rows only) is the in-flight canary lane's name, or null when no canary
 *  is being tested — see conductor.ts's PARK section for the canary contract. */
export interface ParkRow {
  source: EnvFailureSource;
  reason: string;
  triggerIssue: number | null;
  enteredAt: string;
  /** NOT NULL — initialized to enteredAt at park entry, so the first probe/canary waits a full
   *  base backoff instead of firing immediately (PR #180 review P1-1c). */
  lastProbeAt: string;
  probeAttempts: number;
  escalatedAt: string | null;
  canaryWorker: string | null;
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
      throw new Error(`DB schema v${current} is newer than this engine (v${MIGRATIONS.length}); upgrade sapwood`);
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
            gated_reentry_attempts, gated_reentry_capped, gated_escalation_labeled,
            resume_attempts, resume_capped)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           gated_escalation_labeled = excluded.gated_escalation_labeled,
           resume_attempts = excluded.resume_attempts,
           resume_capped = excluded.resume_capped`,
      )
      .run(
        row.name,
        row.issue,
        row.session_id,
        row.state,
        row.started_at,
        row.ended_at,
        row.pr ?? null,
        row.review_triggered ?? 0,
        row.review_triggered_head ?? null,
        row.review_triggered_at ?? null,
        row.review_fallback_head ?? null,
        row.review_fallback_kind ?? null,
        row.gated_reentry_attempts ?? 0,
        row.gated_reentry_capped ?? 0,
        row.gated_escalation_labeled ?? 0,
        row.resume_attempts ?? 0,
        row.resume_capped ?? 0,
      );
  }

  /** Persist the ENGINE-recorded review-trigger pin for `name`'s lane (#55 P1-B) — called ONLY
   *  from MergeDriver.driveOne's recordTrigger callback (conductor.ts wires this method in),
   *  the instant a fresh `@codex review` trigger is posted for a NEW head. A worker/producer
   *  has no path to this method (no reference to State) and posting extra comments themselves
   *  cannot move this pin — it is written exclusively by the engine's own gate loop. */
  recordReviewTrigger(name: string, head: string, at: string): void {
    this.db.prepare("UPDATE workers SET review_triggered_head = ?, review_triggered_at = ? WHERE name = ?").run(head, at, name);
  }

  /** Persist `name`'s lane's reviewer-failover episode marker (#54) — called from
   *  MergeDriver.driveOne's recordFallback callback (conductor.ts wires it in). Both non-null
   *  records a fallback reviewer's MERGE_OK for that head; both null clears it, which happens
   *  ONLY on a head change (driveOne's re-trigger branch — Codex PR #71 P2: never cleared at
   *  verdict-resolution time). Advisory either way: the row is re-verified against live PR
   *  data at every use (see the v6->v7 migration comment). A worker/producer has no reference
   *  to State and cannot reach this method — same structural guarantee as recordReviewTrigger. */
  recordReviewFallback(name: string, head: string | null, kind: string | null): void {
    this.db.prepare("UPDATE workers SET review_fallback_head = ?, review_fallback_kind = ? WHERE name = ?").run(head, kind, name);
  }

  /** #155: refresh a still-`running` lane's LIVE per-probe telemetry trio (update-in-place —
   *  see the schema v10->v11 migration comment for why this is a dedicated pair of methods
   *  rather than routed through upsertWorker's full-row replace: a generic `{...w, ...changes}`
   *  call site would silently carry over a STALE trio from the row it just read, exactly the
   *  crash-rerun hazard this file's migrations avoid elsewhere). Idempotent: re-probing the
   *  same head just overwrites with the same numbers — no counters, no history, no per-probe
   *  event. `tokenComposition` is JSON-encoded (see WorkerRow.token_composition doc). Called
   *  ONLY from conductor.tick()'s RECLAIM-phase KEEP branch, once per probe. */
  setLiveTelemetry(name: string, t: { estCostUsd: number; contextTokens: number; tokenComposition: CategorizedTokenUsage }): void {
    this.db
      .prepare("UPDATE workers SET est_cost_usd = ?, context_tokens = ?, token_composition = ? WHERE name = ?")
      .run(t.estCostUsd, t.contextTokens, JSON.stringify(t.tokenComposition), name);
  }

  /** #155: clear a lane's LIVE telemetry the instant it leaves `running` (handoff / done /
   *  driving / failed — any reclaim outcome). The settled REAL cost stays in spend_ledger
   *  (recordSpend, unchanged) — this only clears the live display trio, so a dead/terminal lane
   *  never shows stale "still running" numbers (the crash semantics the issue calls out: a dead
   *  lane always passes through reclaim, so clearing here is the one place that needs to run).
   *  Safe/idempotent on a row that never had telemetry (NULL -> NULL). */
  clearLiveTelemetry(name: string): void {
    this.db.prepare("UPDATE workers SET est_cost_usd = NULL, context_tokens = NULL, token_composition = NULL WHERE name = ?").run(name);
  }

  getWorker(name: string): WorkerRow | undefined {
    return this.db.prepare("SELECT * FROM workers WHERE name = ?").get(name) as WorkerRow | undefined;
  }

  /** In-flight lanes: workers still in the `running` state (the conductor reclaim/probe set). */
  runningWorkers(): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE state = 'running' ORDER BY name").all() as unknown as WorkerRow[];
  }

  /** Occupied lanes: running + driving (a driving lane holds a PR awaiting the review gate
   *  and still counts against cfg.lanes.max). The dispatch capacity + in-flight set. */
  activeWorkers(): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE state IN ('running', 'driving') ORDER BY name").all() as unknown as WorkerRow[];
  }

  /** Rows that still own an issue for startup reconciliation. Handoff is terminal to the live
   *  scheduler but resumable, so it deliberately prevents a board issue being called orphaned. */
  reconcileWorkers(): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE state IN ('running', 'driving', 'handoff') ORDER BY name")
      .all() as unknown as WorkerRow[];
  }

  /** Lanes holding a PR awaiting the review gate (#13's merge driver). No live worker process —
   *  just a lane occupying capacity until gate①/gate② resolve it to merged/needs-human/queued. */
  drivingWorkers(): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE state = 'driving' ORDER BY name").all() as unknown as WorkerRow[];
  }

  /** #172 graceful-handoff resume candidates. `resume_capped = 0` is a permanent one-way
   *  exclusion after maxResumes is exhausted and the needs-human escalation lands. */
  handoffWorkers(): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE state = 'handoff' AND resume_capped = 0 ORDER BY name")
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
    this.db.prepare("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)").run(new Date().toISOString(), kind, JSON.stringify(payload));
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
    // #172 empirical verification (2026-07-14): Claude Code's resumed result reports PER-LEG
    // total_cost_usd, not a cumulative session total. Record each terminal leg directly; a
    // handoff + any resumed legs therefore sum to the real issue spend with no subtraction or
    // double count. The clamp above remains the safety invariant for corrupt values.
    const rows =
      models.length > 0 ? models : [{ model: "unknown", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }];
    const safeInt = (n: number): number => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);
    const stmt = this.db.prepare(
      `INSERT INTO spend_ledger
         (ts, worker, issue, usd, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // The terminal result's model-usage payload follows the same last-result/per-leg read path
    // as total_cost_usd, so token rows are recorded directly for this leg too.
    rows.forEach((m, i) => {
      stmt.run(
        at,
        worker,
        issue,
        i === 0 ? safeUsd : 0,
        m.model || "unknown",
        safeInt(m.inputTokens),
        safeInt(m.outputTokens),
        safeInt(m.cacheReadTokens),
        safeInt(m.cacheCreationTokens),
      );
    });
  }

  /** #223: transition a worker row to a TERMINAL state and record its settled spend in ONE
   *  sqlite transaction — same shape as registerCanaryDispatch above. conductor.ts's reclaim
   *  path used to persist the terminal `upsertWorker` first and `recordSpend` second as two
   *  separate writes; a crash (or a thrown forge call the caller awaited in between) between
   *  them permanently removed the worker from reclaim while its cost never reached
   *  spend_ledger — every ledger consumer under-counted forever, including the dailyBudgetUsd
   *  hard safety ceiling. Bundling the pair here makes that partial state unrepresentable: it
   *  either both land or neither does, so a lane is always either still reclaimable (retry next
   *  tick) or (terminal AND spend ledgered) — never terminal-without-spend. Callers must do any
   *  forge label/board write AFTER this call, never between the two writes it bundles — a lost
   *  label is cosmetic, a lost ledger row is money (issue #223's ordering rule). */
  settleTerminalWorker(
    row: WorkerRow,
    spend: { worker: string; issue: number; usd: number; at: string; models?: ModelUsageEntry[] },
  ): void {
    this.db.exec("BEGIN");
    try {
      this.upsertWorker(row);
      this.recordSpend(spend.worker, spend.issue, spend.usd, spend.at, spend.models ?? []);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** Cumulative usd ledgered under this worker NAME across all of its terminal legs. */
  spentUsdForWorker(worker: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM spend_ledger WHERE worker = ?").get(worker) as {
      total: number;
    };
    return row.total;
  }

  /** Cumulative spend for `now`'s UTC calendar day (spend_ledger sum, ts-prefix match). */
  dailySpendUsd(now: Date): number {
    const dayPrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const row = this.db.prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM spend_ledger WHERE ts LIKE ?").get(`${dayPrefix}%`) as {
      total: number;
    };
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
    const row = this.db.prepare("SELECT started_at, last_tick_at FROM engine_session WHERE id = 1").get() as
      | { started_at: string; last_tick_at: string }
      | undefined;
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
    const row = this.db.prepare("SELECT reason, at FROM ceiling_breach WHERE id = 1").get() as { reason: string; at: string } | undefined;
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

  // ── Environment-failure park (#168) ─────────────────────────────────────────────────────
  // Deliberately NOT a file sentinel (unlike killSwitchPath/pausePath above) — see the schema
  // v11->v12 migration comment: this is engine-derived runtime state, not a human out-of-band
  // control, so it belongs in the state DB. One row per source (PR #180 review P1-1a); the
  // engine is "parked" while ANY row exists and resumes dispatch only at zero rows. `sapwood
  // status` and conductor.ts's tick() both read fresh (parkedSources()/isParked()) — no
  // caching, same "always live" property the file sentinels have via existsSync.

  /** Enter the parked state for `source`. INSERT OR IGNORE per source — mirrors
   *  recordCeilingBreach: re-detecting the SAME source while its episode is open must NOT reset
   *  `entered_at` (a storm of failing lanes, in one tick or across many, must never keep
   *  pushing the duration-based escalation threshold out). A DIFFERENT source while parked
   *  opens its own row (mixed storm — PR #180 review P1-1a). `last_probe_at` is seeded to `now`
   *  so the first probe/canary waits a full base backoff (P1-1c). Returns true iff THIS call
   *  actually inserted the row, so a caller can fire a park-entry event once per episode. */
  enterPark(source: EnvFailureSource, reason: string, triggerIssue: number | null, now: string): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO park_state (source, reason, trigger_issue, entered_at, last_probe_at, probe_attempts)
         VALUES (?, ?, ?, ?, ?, 0)`,
      )
      .run(source, reason, triggerIssue, now, now);
    return res.changes > 0;
  }

  private static rowToPark(row: {
    source: string;
    reason: string;
    trigger_issue: number | null;
    entered_at: string;
    last_probe_at: string;
    probe_attempts: number;
    escalated_at: string | null;
    canary_worker: string | null;
  }): ParkRow {
    return {
      source: row.source as EnvFailureSource,
      reason: row.reason,
      triggerIssue: row.trigger_issue,
      enteredAt: row.entered_at,
      lastProbeAt: row.last_probe_at,
      probeAttempts: row.probe_attempts,
      escalatedAt: row.escalated_at,
      canaryWorker: row.canary_worker,
    };
  }

  /** Every open park episode, oldest first (at most one per source). */
  parkedSources(): ParkRow[] {
    const rows = this.db.prepare("SELECT * FROM park_state ORDER BY entered_at, source").all() as unknown as Parameters<
      typeof State.rowToPark
    >[0][];
    return rows.map((r) => State.rowToPark(r));
  }

  /** The open episode for one source, or null. */
  parkRow(source: EnvFailureSource): ParkRow | null {
    const row = this.db.prepare("SELECT * FROM park_state WHERE source = ?").get(source) as
      | Parameters<typeof State.rowToPark>[0]
      | undefined;
    return row ? State.rowToPark(row) : null;
  }

  /** Parked = ANY source's episode is open. Dispatch resumes only at zero rows. */
  isParked(): boolean {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM park_state").get() as { n: number };
    return row.n > 0;
  }

  /** Record one FAILED probe attempt (or a failed canary — PR #180 review P1-1b): bump
   *  probe_attempts (backoff grows) and stamp last_probe_at. env-failure.ts's
   *  probeBackoffSec/probeDue re-derive the next-due time from these two fresh every tick —
   *  no separately-persisted next-probe timestamp, so a restart naturally resumes correct
   *  probing with no replay logic of its own. Never touches entered_at/escalated_at — the
   *  episode continues. */
  bumpParkProbe(source: EnvFailureSource, at: string): void {
    this.db.prepare("UPDATE park_state SET last_probe_at = ?, probe_attempts = probe_attempts + 1 WHERE source = ?").run(at, source);
  }

  /** Stamp last_probe_at WITHOUT bumping probe_attempts — the llm path's "ping succeeded,
   *  canary armed" case (PR #180 review P1-1b): pacing must advance (no re-probe every tick
   *  while the canary is pending/launching) but the backoff exponent only grows on a FAILED
   *  outcome (probe failure or canary env-failure), never on the mere act of arming one. */
  touchParkProbe(source: EnvFailureSource, at: string): void {
    this.db.prepare("UPDATE park_state SET last_probe_at = ? WHERE source = ?").run(at, source);
  }

  /** Record (or clear, with null) the llm episode's in-flight canary lane name. */
  setParkCanary(source: EnvFailureSource, worker: string | null): void {
    this.db.prepare("UPDATE park_state SET canary_worker = ? WHERE source = ?").run(worker, source);
  }

  /** #168 (PR #180 round-3 P2-A): register a freshly-dispatched CANARY lane atomically — the
   *  worker row, the episode's canary_worker assignment, and both dispatch events land in ONE
   *  SQLite transaction. Separate writes had a crash window: a worker row persisted without
   *  its canary_worker assignment left a LIVE canary the restarted engine didn't know about,
   *  so the next backoff step launched a second one ("exactly one canary" broken). This method
   *  makes that partial state unrepresentable: it either all lands or none of it does —
   *  including the case where no `source` episode row exists to attach to (the UPDATE matches
   *  zero rows -> the whole registration, worker row included, rolls back and this throws;
   *  a canary must never exist without the episode it is testing). */
  registerCanaryDispatch(row: WorkerRow, source: EnvFailureSource): void {
    this.db.exec("BEGIN");
    try {
      this.upsertWorker(row);
      const res = this.db.prepare("UPDATE park_state SET canary_worker = ? WHERE source = ?").run(row.name, source);
      if (res.changes === 0) {
        throw new Error(`registerCanaryDispatch: no open ${source} park episode to attach canary ${row.name} to`);
      }
      this.appendEvent("dispatched", { worker: row.name, issue: row.issue });
      this.appendEvent("park-canary", { worker: row.name, issue: row.issue });
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** One-way latch: the duration-based human notification has fired for this source's episode.
   *  Never re-fires for the same episode (conductor.ts's escalatePark checks escalatedAt == null
   *  before calling this) — additive, not a state transition: probing/auto-resume are unaffected
   *  either side of this call. */
  recordParkEscalation(source: EnvFailureSource, at: string): void {
    this.db.prepare("UPDATE park_state SET escalated_at = ? WHERE source = ?").run(at, source);
  }

  /** Auto-resume / manual clear for one source. A LATER park of the same source is a fresh
   *  episode with its own entered_at/backoff count, never a continuation. Clearing the LAST
   *  open episode also removes the local escalation marker (PR #180 review P2-2: the marker
   *  described an outage that no longer exists — wiring the clear here, at the single choke
   *  point every resume path goes through, is what guarantees it can never be forgotten). */
  clearPark(source: EnvFailureSource): void {
    this.db.prepare("DELETE FROM park_state WHERE source = ?").run(source);
    if (!this.isParked()) this.clearEscalationMarker();
  }

  /** #168: the LOCAL escalation fallback marker path — a file in the engine's OWN data dir,
   *  alongside KILL_SWITCH/PAUSE for filesystem-layout convenience only. UNLIKE those two, this
   *  file is written BY THE ENGINE (never a human control input) and is read-only informational
   *  output: nothing in this codebase ever reads it back as a decision input (isParked/
   *  parkState() consult only the park_state SQLite row above) — a human/dashboard can `cat` it
   *  to see the last local-fallback escalation without a forge round-trip, during exactly the
   *  window (forge itself unreachable) where a forge-side notification isn't possible. null dir
   *  (in-memory State, tests) -> no path, same convention as killSwitchPath/pausePath. */
  escalationMarkerPath(): string | null {
    return this.dataDir ? join(this.dataDir, "ESCALATION") : null;
  }

  /** Write the local escalation fallback marker (#168's channel-ladder local branch,
   *  conductor.ts's escalatePark). Best-effort content only — this is a side-channel output, not
   *  sapwood state; the caller does not treat a write failure here as a park/probe failure. */
  writeEscalationMarker(payload: Record<string, unknown>): void {
    const p = this.escalationMarkerPath();
    if (!p) return;
    writeFileSync(p, JSON.stringify(payload, null, 2) + "\n");
  }

  /** Best-effort removal of a stale escalation marker once the episode it described has
   *  resolved (conductor.ts clears it on auto-resume) — a missing file is not an error. */
  clearEscalationMarker(): void {
    const p = this.escalationMarkerPath();
    if (!p) return;
    try {
      rmSync(p, { force: true });
    } catch {
      /* noop */
    }
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
      .prepare("INSERT INTO pending_rollbacks (issue, target, reason, attempts, created_at) VALUES (?, ?, ?, 0, ?)")
      .run(issue, target, reason, at);
    return Number(res.lastInsertRowid);
  }

  /** All rollbacks still awaiting success or escalation, oldest first (retry order). */
  pendingRollbacks(): PendingRollback[] {
    return this.db.prepare("SELECT * FROM pending_rollbacks ORDER BY id").all() as unknown as PendingRollback[];
  }

  /** Record one more failed attempt (attempts++, last_attempt_at refreshed) — the row stays,
   *  to be retried again next tick. */
  bumpPendingRollback(id: number, at: string): void {
    this.db.prepare("UPDATE pending_rollbacks SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?").run(at, id);
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
    // #123: id cursors for the round's ledger window (see the v9->v10 migration comment) —
    // everything already in events/spend_ledger at this instant belongs to EARLIER rounds
    // (or the run's own inter-round activity), regardless of timestamp collisions.
    const startEventId = (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as { m: number }).m;
    const startSpendId = (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM spend_ledger").get() as { m: number }).m;
    const res = this.db
      .prepare(
        "INSERT INTO rounds (phase, status, artifact_ref, started_at, updated_at, start_event_id, start_spend_id) VALUES ('aligning', 'in_progress', NULL, ?, ?, ?, ?)",
      )
      .run(now, now, startEventId, startSpendId);
    return {
      round_id: Number(res.lastInsertRowid),
      phase: "aligning",
      status: "in_progress",
      artifact_ref: null,
      started_at: now,
      updated_at: now,
      ended_at: null,
      start_event_id: startEventId,
      start_spend_id: startSpendId,
    };
  }

  /** The most recent round still `in_progress` — a round.ts restart's rerun-not-resume probe
   *  (#77 decision 4). At most one is expected to exist at a time (round.ts's own invariant);
   *  `ORDER BY round_id DESC LIMIT 1` is a defensive tiebreak, not evidence multiple are normal. */
  openRound(): RoundRow | undefined {
    return this.db.prepare("SELECT * FROM rounds WHERE status = 'in_progress' ORDER BY round_id DESC LIMIT 1").get() as
      | RoundRow
      | undefined;
  }

  getRound(id: number): RoundRow | undefined {
    return this.db.prepare("SELECT * FROM rounds WHERE round_id = ?").get(id) as RoundRow | undefined;
  }

  /** Advance the phase cursor. Always CLEARS artifact_ref — a newly-entered phase has no
   *  marker of its own yet (the previous phase's marker is irrelevant once it's done; see the
   *  schema v7->v8 migration comment). */
  advanceRoundPhase(id: number, phase: RoundPhase, now: string): void {
    this.db.prepare("UPDATE rounds SET phase = ?, artifact_ref = NULL, updated_at = ? WHERE round_id = ?").run(phase, now, id);
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

  latestEvent(kind: string): { kind: string; payload: unknown } | undefined {
    const row = this.db.prepare("SELECT kind, payload FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind) as
      | { kind: string; payload: string }
      | undefined;
    return row ? { kind: row.kind, payload: JSON.parse(row.payload) as unknown } : undefined;
  }

  /** Cumulative spend_ledger sum at or after `sinceIso` — harvest's "spend vs round budget"
   *  fact. Same table/column as dailySpendUsd; a `>=` cutoff rather than a calendar-day prefix
   *  match, since a round doesn't align to a day boundary. */
  spentUsdSince(sinceIso: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM spend_ledger WHERE ts >= ?").get(sinceIso) as { total: number };
    return row.total;
  }

  /** #123: id-cursor variant of eventsSince — strictly-greater-than a captured MAX(id), the
   *  round-window read the artifact uses (see the v9->v10 migration comment for why ids, not
   *  timestamps). Same non-empty-kinds guard as eventsSince. */
  eventsAfterId(afterId: number, kinds: string[]): { kind: string; payload: unknown }[] {
    if (kinds.length === 0) throw new Error("eventsAfterId: kinds must be non-empty");
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT kind, payload FROM events WHERE id > ? AND kind IN (${placeholders}) ORDER BY id`)
      .all(afterId, ...kinds) as { kind: string; payload: string }[];
    return rows.map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
  }

  /** #123: id-cursor variant of spentUsdSince (same rationale as eventsAfterId). */
  spentUsdAfterId(afterId: number): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(usd), 0) AS total FROM spend_ledger WHERE id > ?").get(afterId) as { total: number };
    return row.total;
  }

  /** #154: the spend_ledger id-cursor anchor for a fresh RUN — same MAX(id) pattern startRound
   *  uses for its own (per-round) start_spend_id, captured once at engine startup instead of
   *  once per round. Everything already in spend_ledger at this instant belongs to an EARLIER
   *  run (or, for a brand-new DB, nothing); `spentUsdAfterId(this value)` from then on is this
   *  run's own ledgered spend and nothing else — a restart calls this again and gets a fresh
   *  cursor, so it never inherits a prior run's total (unlike dailyBudgetUsd's cross-restart
   *  calendar-day sum, which is deliberately NOT id-anchored). */
  maxSpendLedgerId(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM spend_ledger").get() as { m: number }).m;
  }

  // ── #123: round summary artifact (round_artifacts, migration 9->10) ─────────────────────

  /** Upsert the FINAL round artifact row — one per round (round_id is the PK), so a crash-rerun
   *  of the close path overwrites rather than duplicates. `json` is the schema-validated object
   *  (round-artifact.ts validates BEFORE calling this — state stores, never re-validates). */
  saveRoundArtifact(roundId: number, schemaVersion: number, json: string, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO round_artifacts (round_id, schema_version, json, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(round_id) DO UPDATE SET
           schema_version = excluded.schema_version, json = excluded.json,
           updated_at = excluded.updated_at`,
      )
      .run(roundId, schemaVersion, json, updatedAt);
  }

  /** The persisted artifact row for a round — undefined when the round never closed (or
   *  predates #123). `json` is returned RAW (the caller parses/validates against the version
   *  it understands via `schemaVersion`) — reader for tests and the #17 dashboard. */
  getRoundArtifact(roundId: number): { schemaVersion: number; json: string } | undefined {
    const row = this.db.prepare("SELECT schema_version, json FROM round_artifacts WHERE round_id = ?").get(roundId) as
      | { schema_version: number; json: string }
      | undefined;
    return row ? { schemaVersion: row.schema_version, json: row.json } : undefined;
  }

  /** Where the derived markdown VIEW of a round's artifact lives on disk — null for an
   *  in-memory State (tests), same convention as killSwitchPath/pausePath above. */
  roundArtifactMdPath(roundId: number): string | null {
    return this.dataDir ? join(this.dataDir, "rounds", `round-${roundId}.md`) : null;
  }

  // ── Input manifest (#231) ───────────────────────────────────────────────────────────────

  /** The next attempt number for (round_id, phase, role, session) — MAX(attempt)+1, or 1 when
   *  no row exists yet for that tuple. Pure read; callers compute this ONCE per session
   *  dispatch and pass the SAME number to every appendInputManifest call for that dispatch's
   *  channels (see InputManifestRow's own doc comment for why one call per channel must not
   *  each derive their own attempt). A crash-rerun that reaches the same dispatch point again
   *  reads a higher number automatically — the durable table itself is the counter, nothing to
   *  lose on restart. */
  nextInputManifestAttempt(roundId: number, phase: string, role: string, session: string): number {
    const row = this.db
      .prepare("SELECT COALESCE(MAX(attempt), 0) AS m FROM input_manifest WHERE round_id = ? AND phase = ? AND role = ? AND session = ?")
      .get(roundId, phase, role, session) as { m: number };
    return row.m + 1;
  }

  /** Append one input-manifest row (#231). A plain write — RECORD, not a gate (see the schema
   *  v13->v14 migration comment): callers (align.ts's recordInputManifest) wrap this
   *  best-effort, the same "a write failure here must never block the session it's describing"
   *  contract as every other observability-only append in this file. */
  appendInputManifest(row: InputManifestRow, now?: string): void {
    this.db
      .prepare(
        `INSERT INTO input_manifest
           (round_id, phase, role, session, attempt, channel, ok, version, total, rendered, omitted, truncated, detail, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.round_id,
        row.phase,
        row.role,
        row.session,
        row.attempt,
        row.channel,
        row.ok ? 1 : 0,
        row.version ?? null,
        row.total ?? null,
        row.rendered ?? null,
        row.omitted ?? null,
        row.truncated ? 1 : 0,
        row.detail ?? null,
        now ?? new Date().toISOString(),
      );
  }

  /** Every input-manifest row for one round, oldest first — test/inspection reader. Not
   *  consulted by any engine decision today (see the schema v13->v14 migration comment: the
   *  manifest is a record, not a gate). */
  inputManifestRows(roundId: number): (InputManifestRow & { id: number; ts: string })[] {
    const rows = this.db.prepare("SELECT * FROM input_manifest WHERE round_id = ? ORDER BY id").all(roundId) as Array<{
      id: number;
      round_id: number;
      phase: string;
      role: string;
      session: string;
      attempt: number;
      channel: string;
      ok: number;
      version: string | null;
      total: number | null;
      rendered: number | null;
      omitted: number | null;
      truncated: number;
      detail: string | null;
      ts: string;
    }>;
    return rows.map((r) => ({
      id: r.id,
      round_id: r.round_id,
      phase: r.phase,
      role: r.role,
      session: r.session,
      attempt: r.attempt,
      channel: r.channel,
      ok: r.ok === 1,
      version: r.version,
      total: r.total,
      rendered: r.rendered,
      omitted: r.omitted,
      truncated: r.truncated === 1,
      detail: r.detail,
      ts: r.ts,
    }));
  }
}
