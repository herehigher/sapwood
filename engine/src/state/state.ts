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
import type { AcceptanceCriterion, AcSnapshot } from "../review/ac-snapshot.js";

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
        reason          TEXT NOT NULL,   -- dispatch-rollback | dead-lane-requeue | merged-board-done
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
  //
  // #231 gate② (Codex sol high F5): `CHECK (attempt > 0)` and a UNIQUE index on the full
  // dimension key make a caller bug (a zero/negative attempt, or two rows for the exact same
  // (round, phase, role, session, attempt, channel)) surface as a thrown SQLite constraint
  // violation instead of silently coexisting as duplicate/nonsensical rows — appendInputManifest
  // is a single-writer-serial write (same assumption the rest of this file already documents for
  // e.g. `rounds`), so no further concurrency modeling belongs here.
  (db) => {
    db.exec(`
      CREATE TABLE input_manifest (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id  INTEGER NOT NULL,
        phase     TEXT NOT NULL,
        role      TEXT NOT NULL,
        session   TEXT NOT NULL,
        attempt   INTEGER NOT NULL CHECK (attempt > 0),
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
      CREATE UNIQUE INDEX input_manifest_dim ON input_manifest (round_id, phase, role, session, attempt, channel);
    `);
  },
  // 14 -> 15: ambient session context manifests (#236 — "record, don't seal"). Peripheral role
  // sessions legitimately absorb ambient repo context (CLAUDE.md layers, memory, dynamic
  // system-prompt sections — #219's locked action-side trust boundary; sealing this channel was
  // rejected). The obligation is honesty: a recorded session ATTEMPT states exactly what it saw
  // (and its own capture timing/coverage — see roles/context-manifest.ts), so ambient drift
  // between retries of the same phase never makes two attempts look comparable when they
  // weren't. Keyed by the SAME (round, phase, role, session, attempt) tuple the migration
  // 13->14 `input_manifest` table (#231, landed first) also uses — this table is deliberately
  // self-contained (own table, own methods below) so the two features merge independently;
  // nothing here depends on #231's schema, and nothing there depends on this one. `json` is an
  // opaque, schema-validated-by-the-caller blob (same round_artifacts.json convention, migration
  // 9->10) — state.ts stores it, never interprets it (see roles/context-manifest.ts for the
  // shape). UNIQUE + upsert-on-conflict (State.recordContextManifest) makes a crash-rerun of the
  // SAME attempt idempotent rather than a duplicate row.
  (db) => {
    db.exec(`
      CREATE TABLE context_manifests (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id    INTEGER NOT NULL,
        phase       TEXT NOT NULL,
        role        TEXT NOT NULL,
        session     TEXT NOT NULL,
        attempt     INTEGER NOT NULL,
        recorded_at TEXT NOT NULL,
        json        TEXT NOT NULL,
        UNIQUE(round_id, phase, role, session, attempt)
      );
    `);
  },
  // 15 -> 16: forge MCP proxy journal + frozen evidence bundles (#234). The proxy's write-ahead
  // contract (issue #234's Journal contract): persist request intent -> fetch+cap -> persist
  // canonical response + hash -> deliver to the session; a response-persist failure yields a
  // typed tool error, never an undeliverable-but-unrecorded call. One row per CALL (not per
  // session, unlike context_manifests/input_manifest's one-row-per-attempt-dimension shape —
  // here `seq` is the dimension, incrementing per call within a session attempt), keyed by the
  // SAME (round, phase, role, session, attempt) 5-tuple #231/#236 already established as this
  // codebase's shared join key across manifest tables, plus a monotonic `seq` (State.
  // nextForgeProxySeq, same MAX()+1-over-durable-rows pattern as nextInputManifestAttempt — the
  // table itself is the counter, nothing to lose on restart). `status` is the row's own
  // write-ahead cursor: 'intent' (persisted before any fetch) -> 'fetched' (canonical response +
  // hash persisted) or 'error' (upstream/timeout, sanitized) -> 'delivered' (handed to the
  // session; audit refinement only — the completeness invariant already holds once a row reaches
  // 'fetched', since the server never delivers a response it hasn't persisted first). Caps/scope/
  // budget are recorded per call (not just the schema version) so a later cap/config change never
  // makes an old row's enforcement ambiguous. `response_json`/`content_hash` are NULL until the
  // fetch step lands — an 'intent'-only row with a NULL response is exactly the shape a crash
  // between intent-persist and fetch leaves behind, and is expected, not corrupt. `response_bytes`
  // (#234 F4, PR #252 review, P1, Codex #4) is the caller-computed `Buffer.byteLength` (UTF-8) of
  // `response_json` at persist time — stored explicitly rather than derived via SQLite's own
  // `LENGTH()`, which counts TEXT-storage-class values in CHARACTERS, not bytes; a multibyte
  // (e.g. emoji-bearing) response would otherwise under-count against `proxy.budget.
  // maxBytesPerSession`, silently admitting more actual bytes than configured.
  //
  // `forge_proxy_bundles` is a SEPARATE, independently keyed table (own primary key: the content
  // hash) — a frozen evidence bundle (default view + exact responses) persisted once per accepted
  // decision, addressed by its own SHA-256 content hash, optionally linked to a decision record
  // via `decision_ref` (a free-text pointer the caller supplies — no consumer produces one in
  // this PR, see #234's scope ruling; the column exists so the first real caller has somewhere to
  // write it without a further migration). `path` is the on-disk JSON file
  // (`<dataDir>/proxy-bundles/<hash>.json`) — NULL for an in-memory State (tests), same
  // null-means-no-directory convention as roundArtifactMdPath.
  (db) => {
    db.exec(`
      CREATE TABLE forge_proxy_journal (
        id                      INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id                INTEGER NOT NULL,
        phase                   TEXT NOT NULL,
        role                    TEXT NOT NULL,
        session                 TEXT NOT NULL,
        attempt                 INTEGER NOT NULL,
        seq                     INTEGER NOT NULL,
        tool                    TEXT NOT NULL,
        proxy_version           TEXT NOT NULL,
        args_json               TEXT NOT NULL,
        scope_json              TEXT NOT NULL,
        caps_json               TEXT NOT NULL,
        budget_remaining_calls  INTEGER,
        budget_remaining_bytes  INTEGER,
        status                  TEXT NOT NULL CHECK (status IN ('intent', 'fetched', 'error', 'delivered')),
        upstream_ids_json       TEXT,
        upstream_updated_at     TEXT,
        counts_json             TEXT,
        truncated               INTEGER NOT NULL DEFAULT 0,
        response_json           TEXT,
        response_bytes          INTEGER,
        content_hash            TEXT,
        error                   TEXT,
        timed_out               INTEGER NOT NULL DEFAULT 0,
        requested_at            TEXT NOT NULL,
        fetched_at              TEXT,
        delivered_at            TEXT
      );
      CREATE UNIQUE INDEX forge_proxy_journal_dim ON forge_proxy_journal (round_id, phase, role, session, attempt, seq);

      CREATE TABLE forge_proxy_bundles (
        hash         TEXT PRIMARY KEY,
        round_id     INTEGER NOT NULL,
        phase        TEXT NOT NULL,
        role         TEXT NOT NULL,
        session      TEXT NOT NULL,
        decision_ref TEXT,
        byte_size    INTEGER NOT NULL,
        path         TEXT,
        created_at   TEXT NOT NULL
      );
    `);
  },
  // 16 -> 17: input_manifest.truncated becomes a genuine THREE-STATE column (#251 gate② review
  // round 3, Codex delta-verify F1). Migration v13->v14 shipped `truncated INTEGER NOT NULL
  // DEFAULT 0` — every caller (align.ts's, and later architect.ts's, recordInputManifest) that
  // simply omitted the field got a silently-coerced `false`, indistinguishable from a caller that
  // deliberately asserted "not truncated". That is exactly the dishonesty #251's own review
  // exists to close: architect.ts's four pass-through channels (last-merged/aligned-goals/
  // doctrine/directive) genuinely don't know whether an UPSTREAM cap already truncated their
  // text, so "omit the field" must round-trip as unknown/NULL, never as a fabricated `false`.
  // SQLite has no ALTER-COLUMN-DROP-NOT-NULL; this is the standard rebuild — new table (same
  // columns, `truncated` now bare `INTEGER`, no NOT NULL/DEFAULT), copy every existing row
  // verbatim (an old 0/1 value is preserved as-is; only NEW writes can ever produce NULL, so no
  // historical row needs backfilling), drop the old table, rename, and recreate the unique index
  // (dropping a table drops its indexes too). No FK relationships touch this table (grep
  // confirms `input_manifest` is never a REFERENCES target anywhere in this schema), so the
  // rebuild is a plain data-preserving swap, no foreign_keys pragma dance required.
  (db) => {
    db.exec(`
      CREATE TABLE input_manifest_new (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        round_id  INTEGER NOT NULL,
        phase     TEXT NOT NULL,
        role      TEXT NOT NULL,
        session   TEXT NOT NULL,
        attempt   INTEGER NOT NULL CHECK (attempt > 0),
        channel   TEXT NOT NULL,
        ok        INTEGER NOT NULL,
        version   TEXT,
        total     INTEGER,
        rendered  INTEGER,
        omitted   INTEGER,
        truncated INTEGER,
        detail    TEXT,
        ts        TEXT NOT NULL
      );
      INSERT INTO input_manifest_new
        (id, round_id, phase, role, session, attempt, channel, ok, version, total, rendered, omitted, truncated, detail, ts)
      SELECT id, round_id, phase, role, session, attempt, channel, ok, version, total, rendered, omitted, truncated, detail, ts
      FROM input_manifest;
      DROP TABLE input_manifest;
      ALTER TABLE input_manifest_new RENAME TO input_manifest;
      CREATE UNIQUE INDEX input_manifest_dim ON input_manifest (round_id, phase, role, session, attempt, channel);
    `);
  },
  // 17 -> 18: index on events(kind) (#237 round-3 adjudication, 2026-07-19). Every kind-filtered
  // read (eventsSince/eventsAfterId — `WHERE id > ? AND kind IN (...)`) has always been a SQL
  // query, never an application-side filter of the whole table — but with no index on `kind`,
  // SQLite still had to scan every row in `events` to evaluate the `kind IN (...)` predicate.
  // dissent.ts's reconcileDurableConcerns (#237) made this cost visible: it runs a kind-filtered
  // scan UNCONDITIONALLY every round, so a healthy long-running engine was paying O(total event
  // history) per round — O(rounds²) cumulative — for a query that only ever wants a handful of
  // concern/decision events. A plain index on `kind` alone (not a composite with `id`) is the
  // cheap, minimal fix: it lets SQLite jump straight to the matching-kind rows instead of
  // scanning every row to check each one's kind, making every such query proportional to the
  // number of MATCHING events, not the whole ledger — with zero new bookkeeping/cursor machinery
  // and no call-site changes required (every existing eventsSince/eventsAfterId call benefits
  // automatically). CREATE INDEX (not UNIQUE) — `kind` is deliberately repeated across many rows.
  (db) => {
    db.exec(`CREATE INDEX events_kind_idx ON events (kind);`);
  },
  // 18 -> 19: fix-loop `fixing` lane state (#245). `fix_rounds` counts REWORK ROUNDS for a PR —
  // how many times a `driving` lane has been sent back into a fix leg to address review
  // findings — and is DELIBERATELY a separate counter from `resume_attempts` (schema v12->v13,
  // #172): that one counts graceful-handoff CONTINUATION legs (the same leg picking back up
  // after a soft-budget pause), an orthogonal axis that must never share a counter with rework
  // rounds (#245 AC — a lane could legitimately need both a resumed continuation AND several fix
  // rounds without either counter contaminating the other's cap accounting). NOT NULL DEFAULT 0:
  // every pre-existing row (none of which has ever been through a fix leg) starts at zero, the
  // same "never attempted" convention gated_reentry_attempts/resume_attempts already use.
  (db) => {
    db.exec(`ALTER TABLE workers ADD COLUMN fix_rounds INTEGER NOT NULL DEFAULT 0;`);
  },
  // 19 -> 20: fix-loop review round 1 fix A2 (#245, Codex sol-high PR #263 review, P1). A
  // soft-budget handoff mid-fix-leg used to write a generic `handoff` row indistinguishable
  // from an ordinary running lane's handoff — the RESUME phase then resumed it as an ORDINARY
  // leg (issue-rendered prompt, no proxy, ambient credentials, target state `running`), silently
  // destroying the fix leg's identity. `fixing_handoff` is the durable marker: set to 1 ONLY
  // when a `fixing`-state lane hands off (reclaimTerminalLane's `p.handoff` branch checks
  // `w.state === "fixing"` at settle time — before the row itself is overwritten), read by the
  // RESUME phase (conductor.ts) to restore a FIX continuation (fix prompt + mandatory
  // `credentialFree` proxy + target state `fixing`, bumping only `resume_attempts`, never
  // `fix_rounds` — the same continuation-leg/rework-round separation `fix_rounds` itself
  // maintains) instead of an ordinary resume. Cleared (0) the instant that resume lands.
  // NOT NULL DEFAULT 0: every pre-existing handoff row (none of which could have been a fixing
  // handoff before this migration existed) is unambiguously ordinary.
  (db) => {
    db.exec(`ALTER TABLE workers ADD COLUMN fixing_handoff INTEGER NOT NULL DEFAULT 0;`);
  },
  // 20 -> 21: fix-leg structured thread-response write queue (#247). A fix leg's structured
  // output validates against the SAME journaled `pr_review_threads` response it was served
  // (proxy/journal.ts, #234/#244 — no TOCTOU between what the leg saw and what the engine acts
  // on), then each per-thread {reply, resolution} decision is persisted HERE before any forge
  // write is attempted — the same write-ahead-durable-queue shape pending_rollbacks established
  // (#31 — see the schema v3->v4 migration comment): a reply/resolve GraphQL mutation can fail
  // transiently, and the retry must survive an engine crash/restart rather than depend on the
  // fix-leg session ever running again (it already exited by the time this row is read back).
  // `reply_posted`/`resolved` are TWO INDEPENDENT completion flags (never a single status
  // column) so a reply that posted successfully is NEVER re-attempted even when that SAME
  // thread's resolve call keeps failing on later ticks — the exact idempotency issue #247's AC
  // names ("a failed resolve retries next tick; replies are never double-posted"). A `disputed`
  // row has no resolve step at all — conductor.ts's attemptThreadWrite (fix-response.ts) clears
  // it the instant reply_posted=1. `pr` is carried on the row (not re-derived from `worker` at
  // drain time) because the worker row itself may already be long gone from `fixing`/`driving`
  // by the time a later tick retries — the row is a self-contained write intent, same
  // independence pending_rollbacks' own (issue, target, reason) triple has from the worker table.
  //
  // AMENDED (branch-local, unmerged — Codex sol-high PR #265 review round 1, D4/D6): `batch_key`
  // + `fix_rounds` added to the SAME v21 table rather than stacking a v22 on top of a migration
  // that hasn't shipped yet. `batch_key` (fix-response.ts's fixResponseBatchKey — `<worker>#
  // <fixRounds>`) identifies the WHOLE validated batch one fix round produced; the UNIQUE index
  // on (batch_key, thread_id) makes State.enqueueThreadWrite's `INSERT OR IGNORE` an idempotent
  // no-op on a duplicate insert (D4's crash-rerun-of-settle safety net — belt-and-suspenders
  // alongside settleTerminalWorker's own atomic commit). `fix_rounds` is carried per-row (not
  // just embedded in batch_key) so it survives as its own queryable provenance field without a
  // caller needing to parse it back out of the key — issue #247 AC's "every executed write
  // journaled with leg/round provenance".
  (db) => {
    db.exec(`
      CREATE TABLE pending_thread_writes (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        worker          TEXT NOT NULL,
        issue           INTEGER NOT NULL,
        pr              INTEGER NOT NULL,
        thread_id       TEXT NOT NULL,
        reply           TEXT NOT NULL,
        resolution      TEXT NOT NULL CHECK (resolution IN ('addressed', 'disputed')),
        reply_posted    INTEGER NOT NULL DEFAULT 0,
        resolved        INTEGER NOT NULL DEFAULT 0,
        attempts        INTEGER NOT NULL DEFAULT 0,
        batch_key       TEXT NOT NULL DEFAULT '',
        fix_rounds      INTEGER NOT NULL DEFAULT 0,
        created_at      TEXT NOT NULL,
        last_attempt_at TEXT
      );
      CREATE UNIQUE INDEX pending_thread_writes_batch_thread ON pending_thread_writes (batch_key, thread_id);
    `);
  },
  // 21 -> 22: OID-bound review-trigger generations and durable covered head (#273). These
  // fields extend the existing per-lane trigger pin: no companion table or timestamp-keyed
  // artifact identity. review_covered_head is amended into this branch-local, unshipped v22.
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN review_trigger_generation INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workers ADD COLUMN review_trigger_ambiguous INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workers ADD COLUMN review_delta_chain INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workers ADD COLUMN review_trigger_in_flight INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE workers ADD COLUMN review_covered_head TEXT;
      UPDATE workers
      SET review_trigger_generation = 1, review_trigger_in_flight = 1
      WHERE review_triggered_head IS NOT NULL;
    `);
  },
  // 22 -> 23: the AC-authority dispatch snapshot (#283, design #279 §5, D4). One row per
  // ISSUE (not per worker/lane, and not append-only like input_manifest/context_manifests) —
  // `issue` is the primary key, upserted via State.recordAcSnapshot. `body` is the FULL
  // snapshotted issue-body text at dispatch time (never re-derived); `body_hash` is
  // `hashBody(body)`, stored alongside rather than re-computed on every drift check;
  // `manifest_json` is the caller's already-extracted `AcceptanceCriterion[]`, opaque JSON
  // (state.ts stores it, never interprets it — same convention as round_artifacts/
  // context_manifests' own `json` columns).
  //
  // #301 review (P1#3, Codex sol high): this table is upsert-by-issue, and — contrary to an
  // earlier draft of this comment — the DISPATCH loop's inFlightIssues check does NOT actually
  // guarantee "at most one active lane per issue" against this table: `activeWorkers()` (the
  // in-flight set) excludes `failed` lanes, so a `failed`+PR lane awaiting GATED RECLAIM (#147)
  // does NOT block a fresh dispatch of the SAME issue number. A later dispatch's snapshot can
  // therefore legitimately OVERWRITE this row while an older, not-yet-reclaimed lane for the
  // same issue still exists. This table alone is consequently NOT sufficient to answer "is this
  // THE snapshot MY lane was dispatched against" — that ownership check is what the
  // workers.ac_body_hash column (migration 23->24 below) exists to close: each WorkerRow stamps
  // its OWN dispatch-time hash at creation, and conductor.ts's drift check (checkAcDriftBeforeDrive)
  // compares that stamped hash against this table's CURRENT row for the issue before ever trusting
  // it as this lane's authority — a mismatch (a different, later lane's snapshot) is treated as an
  // ownership anomaly, same fail-closed escalation as an ordinary live-body drift.
  (db) => {
    db.exec(`
      CREATE TABLE ac_snapshots (
        issue          INTEGER PRIMARY KEY,
        body_hash      TEXT NOT NULL,
        body           TEXT NOT NULL,
        manifest_json  TEXT NOT NULL,
        snapshotted_at TEXT NOT NULL
      );
    `);
  },
  // 23 -> 24 (#301 review, P1#1 + P1#3, Codex sol high): `workers.ac_body_hash` binds a lane's
  // own dispatch-time AC-snapshot identity to ITS OWN row, closing two gaps the issue-keyed
  // ac_snapshots table alone left open:
  //
  //  - P1#3 (ownership race): ac_snapshots is upsert-by-issue, and a `failed`+PR lane awaiting
  //    GATED RECLAIM (#147) does NOT block a fresh dispatch of the SAME issue (activeWorkers()
  //    excludes `failed` — see the migration 22->23 comment above). A later lane's dispatch can
  //    legitimately overwrite the issue-keyed snapshot while an older, un-reclaimed lane for the
  //    same issue still exists. Stamping the EXACT hash a lane's own dispatch recorded onto that
  //    lane's OWN row means a reclaimed lane can verify "is the CURRENT ac_snapshots row for my
  //    issue still MINE" before ever trusting it — a mismatch (a different, later lane's
  //    snapshot silently having replaced it) is caught and escalated, never silently driven.
  //  - P1#1 (crash-window defense in depth): every fresh WorkerRow is created in conductor.ts's
  //    DISPATCH loop strictly AFTER `state.recordAcSnapshot` already succeeded (the same
  //    synchronous try block, no `await` between them, exhaustively verified: no other code path
  //    in this codebase creates a NEW WorkerRow — every other `upsertWorker` call site spreads an
  //    EXISTING row, `{...w, ...}` — see conductor.ts's DISPATCH loop comment). So a non-null
  //    `ac_body_hash` on a lane is a hard guarantee "a snapshot for this exact hash was
  //    successfully recorded at this lane's own dispatch time", not merely an inference from
  //    ac_snapshots' current content. If that snapshot is later missing entirely (unexpected
  //    schema tampering, manual DB surgery, or a future refactor of the invariant above) the
  //    drift check treats a stamped-but-unfindable hash as an anomaly and escalates — it is NEVER
  //    silently treated as an ordinary pre-#283 legacy lane.
  //
  // BACKFILLED, not blanket-NULL (#301 review round 3, P1#1): a DB already at v23 (22->23 shipped
  // ac_snapshots; this migration ships in the SAME release, but a dev DB opened between the two
  // commits — or any future engine build that lands them separately — can already hold
  // `driving`/`failed`+PR workers with a matching ac_snapshots row for their issue) would
  // otherwise migrate every existing row to `ac_body_hash = NULL`, which checkAcDriftBeforeDrive
  // reads as "pre-#283 legacy, nothing to check" — silently DISCARDING drift/ownership protection
  // for a lane that in fact already has a real snapshot recorded. The UPDATE below copies the
  // CURRENT ac_snapshots.body_hash for a row's issue onto every worker row that has one, for
  // EVERY state (not just currently-active) — a `failed`+PR row awaiting GATED RECLAIM needs this
  // exactly as much as a `driving` row, since it can be reactivated later (P1#3's own scenario).
  // A row whose issue has NO ac_snapshots entry (genuinely pre-#283, or dispatched by a caller
  // that bypassed the DISPATCH loop) is left NULL — the correct, honest "nothing recorded" case;
  // NULL after this migration means exactly that, never "predates the migration". If more than
  // one worker row ever shares an issue number (a terminated lane plus a newer one), every one of
  // them is backfilled with the SAME current value; for the common single-lane case this exactly
  // restores the row's own true dispatch-time hash, and for the rarer shared-issue case it is
  // still SAFE, never LESS safe than the NULL default it replaces — a stale row backfilled with a
  // hash that isn't really its own simply fails closed as an ownership mismatch at drive time
  // (P1#3's own mechanism), the same fail-closed outcome that being unable to verify it at all
  // would have produced anyway.
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN ac_body_hash TEXT;
      UPDATE workers
      SET ac_body_hash = (SELECT body_hash FROM ac_snapshots WHERE ac_snapshots.issue = workers.issue)
      WHERE issue IN (SELECT issue FROM ac_snapshots);
    `);
  },
  // 24 -> 25 (#287, E4b, design #279 §2/§6): the engine-agent drive-ordering columns.
  //
  //  - `actual_models_json` (design #287 AC#1, PM scope addition on #287): a durable, EARLY
  //    per-lane record of this worker's OWN observed actual model(s) — JSON array of distinct
  //    model strings, union-appended as they're observed (worker.ts's probe(), reading the live
  //    jsonl's session-init line), NEVER waiting for spend_ledger's terminal-reclaim settlement
  //    (see State.getWorkerActualModels' own doc for why that alone is too late for a still-
  //    `driving` lane's engine-agent review). `'unknown'` is excluded at the WRITE site
  //    (recordWorkerActualModel), same convention spend_ledger's own model column already uses —
  //    never stored as if it were a real, comparable model string. NULL for every pre-#287 row
  //    (nothing observed yet, honest empty — not "known to be blank").
  //  - `engine_review_pin_*` (design #279 §2 R3): the per-head ATTEMPT PIN — same 4-field shape
  //    `{head, at, runId, kind}` design #279 §2 specifies, same storage PATTERN as
  //    review_triggered_head/at above (plain nullable columns on the lane's own row, cleared on
  //    a head change). `engine_review_pin_kind` is plain TEXT ('decisive' | 'unavailable'),
  //    validated at the read boundary (state.ts's own accessor), same "never cast a persisted
  //    string" stance review_fallback_kind already takes.
  //  - `engine_review_first_attempt_at`: a COMPANION clock, deliberately NOT part of the literal
  //    4-field pin — the pin's own `at` is the MOST RECENT attempt-start for the pinned head (it
  //    drives `retryAfterSec` backoff-between-attempts, design #279 §2's "retry with backoff...
  //    between paid attempts"); the #54 fallback chain's `failoverAfterSec` clock is explicitly
  //    measured from the pin's FIRST attempt-start for the head (design #279 §2: "the #54 chain
  //    is consulted on the EXISTING failoverAfterSec clock measured from the pin's first
  //    attempt-start for H") — two genuinely different clocks that a single `at` field cannot
  //    serve simultaneously once a head has been retried more than once. Set ONCE per head (on
  //    the transition from "no pin"/a different head to a pin for a NEW head), left untouched by
  //    every subsequent same-head attempt; cleared alongside the pin on a head change.
  //
  // All five columns nullable, no default: every pre-#287 row gets NULL (no pin, no observed
  // model) — fail-closed, identical in spirit to review_triggered_head/at's own migration.
  (db) => {
    db.exec(`
      ALTER TABLE workers ADD COLUMN actual_models_json TEXT;
      ALTER TABLE workers ADD COLUMN engine_review_pin_head TEXT;
      ALTER TABLE workers ADD COLUMN engine_review_pin_at TEXT;
      ALTER TABLE workers ADD COLUMN engine_review_pin_run_id TEXT;
      ALTER TABLE workers ADD COLUMN engine_review_pin_kind TEXT;
      ALTER TABLE workers ADD COLUMN engine_review_first_attempt_at TEXT;
      -- #287 (design #279 §2 WAL): {runId, H, B, D, attempt-start} persisted BEFORE the engine
      -- spawns a review session — crash recovery (E4c, #288) reconciles the audit marker against
      -- this record. One row PER WORKER NAME (a lane's own current/most-recent WAL entry;
      -- upserted per attempt, never append-only — the prior attempt's WAL is superseded the
      -- instant a new one is persisted, same "current pin state" shape as the workers.* columns
      -- above, not an audit trail of every past attempt). tree_manifest_hash is the sha256 of
      -- the materializer's own sorted tree manifest (review/materializer.ts's TreeManifestEntry[])
      -- — a HASH/POINTER, not the full file listing (design #279 §3's "recorded in the WAL
      -- record for audit parity"; storing the full per-file listing here would duplicate
      -- unbounded tree-shaped data this table was never meant to hold — see review/drive.ts's own
      -- doc for the write-ordering this hash is completed under). NULL until the materialize step
      -- completes (written by a SEPARATE update, still strictly before the review session spawns
      -- — see review/drive.ts). #288 writes decisive_outcome ('approved' | 'rejected') WAL-first,
      -- before any audit-comment network post; only the separate receipt columns introduced by
      -- v26 make the pin permanent and permit downstream consume.
      CREATE TABLE engine_review_wal (
        worker_name         TEXT PRIMARY KEY,
        run_id              TEXT NOT NULL,
        head                TEXT NOT NULL,
        base                TEXT NOT NULL,
        diff_hash           TEXT NOT NULL,
        tree_manifest_hash  TEXT,
        attempt_start       TEXT NOT NULL,
        decisive_outcome    TEXT
      );
    `);
  },
  // 25 -> 26 (#288, E4c, design #279 §8): crash-safe engine-agent audit delivery.
  //  - `review_artifact_json`: the validated, bounded review artifact used to render the
  //    non-authoritative audit comment (per-AC rows, findings, actual session models, prompt
  //    hash). Written with the decisive outcome BEFORE any network post, so restart can rebuild
  //    exactly the same body without paying for another review session.
  //  - `audit_comment_id`: GitHub's opaque top-level comment node id. Its presence is the durable
  //    delivery receipt; prose is never a receipt and never a gate signal.
  //  - `audit_delivered_at`: engine observation time for that receipt. Both receipt fields are
  //    written in one run-id-guarded UPDATE, so a stale completion cannot receipt a newer WAL.
  //  This migration has not shipped, so it also repairs populated v25 development DBs in place:
  //  v25 could persist a `decisive` pin before the receipt columns existed. Such a pin is not
  //  verifiable when its WAL row is absent or has no audit-comment receipt, so all four pin
  //  fields plus the companion first-attempt clock are cleared. The honest downgrade is no pin;
  //  the unchanged head receives a fresh review instead of consuming unauditable state.
  (db) => {
    db.exec(`
      ALTER TABLE engine_review_wal ADD COLUMN review_artifact_json TEXT;
      ALTER TABLE engine_review_wal ADD COLUMN audit_comment_id TEXT;
      ALTER TABLE engine_review_wal ADD COLUMN audit_delivered_at TEXT;
      UPDATE workers
      SET engine_review_pin_head = NULL,
          engine_review_pin_at = NULL,
          engine_review_pin_run_id = NULL,
          engine_review_pin_kind = NULL,
          engine_review_first_attempt_at = NULL
      WHERE engine_review_pin_kind = 'decisive'
        AND NOT EXISTS (
          SELECT 1
          FROM engine_review_wal
          WHERE engine_review_wal.worker_name = workers.name
            AND engine_review_wal.audit_comment_id IS NOT NULL
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
// the review gate (M3) — no live worker, but still occupies a lane. fixing (#245): a driving
// lane's PR needs rework — a LIVE fix-leg worker process (same #172 resume machinery, same
// worktree/branch/session lineage), addressing its own review findings before returning to
// `driving` with a cleared review-trigger pin (see State.fixingWorkers' doc). done/failed/handoff
// = terminal.
export type WorkerState = "running" | "driving" | "fixing" | "done" | "failed" | "handoff";

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
  /** Monotonic generation of this lane's trigger pin. */
  review_trigger_generation?: number;
  /** Observability marker for a superseded in-flight generation; acceptance uses generation. */
  review_trigger_ambiguous?: number;
  /** Consecutive delta-scoped re-triggers since the last full-PR trigger. */
  review_delta_chain?: number;
  /** 1 until a generation-attributable response is observed. */
  review_trigger_in_flight?: number;
  /** Latest trigger head with generation-attributable trusted review coverage. */
  review_covered_head?: string | null;
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
  /** #245: rework rounds — how many times this PR's lane has been sent into a `fixing` leg to
   *  address review findings. Independent of `resume_attempts` (#172's graceful-handoff
   *  continuation counter) — the two axes never share a counter (see the schema v18->v19
   *  migration comment). Bumped exactly once per fix leg started (conductor.ts's startFixLeg),
   *  BEFORE the leg is considered live, so a crash-rerun never loses or double-counts a round.
   *  Optional; DB default 0. */
  fix_rounds?: number;
  /** #245 round-2 fix A2 (schema v19->v20): 1 iff this `handoff` row's PREVIOUS state (the
   *  instant it handed off) was `fixing` — the durable marker the RESUME phase (conductor.ts)
   *  reads to restore a FIX continuation (fix prompt + mandatory `credentialFree` proxy, target
   *  state `fixing`) instead of resuming it as an ordinary leg. Cleared (0) the instant that
   *  resume lands. Optional; DB default 0 (every ordinary handoff row). */
  fixing_handoff?: number;
  /** #283/#301 (schema v23->v24, P1#1 + P1#3 review fixes): this lane's OWN dispatch-time
   *  AC-snapshot hash (ac-snapshot.ts's `AcSnapshot.bodyHash`) — stamped ONCE, at row creation,
   *  from the EXACT snapshot `conductor.ts`'s DISPATCH loop recorded moments earlier in the same
   *  synchronous stretch (never re-read from the DB, so no race with a later dispatch's own
   *  overwrite of the issue-keyed `ac_snapshots` row). `null`/undefined means either a pre-#283
   *  legacy row (no snapshot was ever recorded for it — drive normally, unaffected by any of
   *  this) or a lane created by a test/caller that bypassed the DISPATCH loop entirely. A
   *  NON-null value is a hard guarantee a snapshot was recorded for this exact hash at dispatch
   *  time — conductor.ts's checkAcDriftBeforeDrive treats a later mismatch (or the ac_snapshots
   *  row going missing outright) as a fail-closed anomaly, never as "nothing to check". */
  ac_body_hash?: string | null;
  /** #287 (E4b, AC#1): JSON-encoded array of this lane's own distinct OBSERVED actual model(s)
   *  — see the schema v24->v25 migration comment for the full rationale and getWorkerActualModels'
   *  own doc for how this unions with spend_ledger. Written via State.recordWorkerActualModel
   *  (union-append, 'unknown' excluded); never written via upsertWorker's full-row replace (same
   *  update-in-place stance as est_cost_usd/context_tokens above — a stale `{...w, ...}` call
   *  site must never accidentally clobber this with an old snapshot). NULL until first observed. */
  actual_models_json?: string | null;
  /** #287 (E4b, design #279 §2 R3): the per-head engine-agent ATTEMPT PIN — see the schema
   *  v24->v25 migration comment for the full field-by-field rationale. NULL/undefined means no
   *  pin recorded for this lane (or a pre-#287 row). */
  engine_review_pin_head?: string | null;
  engine_review_pin_at?: string | null;
  engine_review_pin_run_id?: string | null;
  /** Plain TEXT — validated against `"decisive" | "unavailable"` at the read boundary
   *  (review/drive.ts's isAttemptPinKind), never cast. An unrecognized string fails closed to
   *  "no pin" exactly like review_fallback_kind's own read-boundary validation. */
  engine_review_pin_kind?: string | null;
  /** #287 (E4b): the COMPANION clock — see the schema v24->v25 migration comment for why this is
   *  separate from engine_review_pin_at. */
  engine_review_first_attempt_at?: string | null;
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
  /** THREE-STATE, not boolean (schema v16->v17, #251 gate② review round 3): `true`/`false` when
   *  a caller genuinely knows whether ITS OWN cap fired on this channel (e.g. align.ts's
   *  packDigestRecords, architect.ts's capDigest-backed pool-digest); omitted (persists as SQL
   *  NULL, read back as `undefined`/`null`) when the caller has no visibility into truncation at
   *  all — a pass-through channel whose text may already have been capped by a DIFFERENT,
   *  upstream mechanism this one can't see. Never coerce an omitted value to `false`: that was
   *  exactly the fabricated-success-claim this three-state shape replaces (a caller that doesn't
   *  know must not claim it does). */
  truncated?: boolean | null;
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

/** A durably-persisted fix-leg thread-response write still awaiting success or escalation
 *  (#247 — see the schema v20->v21 migration comment). One row per THREAD (a fix leg's
 *  structured output may validate several threadResponses entries at once; each becomes its
 *  own independent row, so one thread's forge failure never blocks another's retry). */
export interface PendingThreadWrite {
  id: number;
  worker: string;
  issue: number;
  pr: number;
  threadId: string;
  reply: string;
  resolution: "addressed" | "disputed";
  replyPosted: boolean;
  resolved: boolean;
  attempts: number;
  /** The fix round's batch key (`<worker>#<fixRounds>`, fix-response.ts's fixResponseBatchKey)
   *  — provenance (issue #247 AC) + the (batch_key, thread_id) de-dup key. */
  batchKey: string;
  /** The lane's fix_rounds counter AT ENQUEUE TIME — provenance (issue #247 AC): which fix
   *  round produced this write. */
  fixRounds: number;
  createdAt: string;
  lastAttemptAt: string | null;
}

/** #247 D4/D6: the two shapes State.settleTerminalWorker's `fixResponse` param accepts —
 *  either a validated batch ready to enqueue (every write executed atomically alongside the
 *  terminal state transition) or an invalid-output descriptor (nothing enqueued, an event
 *  records why). Both are computed PURELY/READ-ONLY by fix-response.ts's
 *  computeFixResponseHarvest, before the transaction that commits them. */
export interface FixResponseSettleWrite {
  threadId: string;
  reply: string;
  resolution: "addressed" | "disputed";
}

export interface FixResponseSettleBatch {
  worker: string;
  issue: number;
  pr: number;
  fixRounds: number;
  batchKey: string;
  writes: FixResponseSettleWrite[];
}

export interface FixResponseSettleInvalid {
  worker: string;
  issue: number;
  pr: number | null;
  reason: string;
}

export type FixResponseSettleOutcome =
  | { kind: "batch"; batch: FixResponseSettleBatch }
  | { kind: "invalid"; invalid: FixResponseSettleInvalid };

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

// ── Ambient session context manifests (#236) ──────────────────────────────────────────────

/** The context_manifests row identity — ONE manifest per session ATTEMPT, keyed by exactly the
 *  tuple documented on the schema v13->v14 migration above. `role` is the RoleSessionOpts.roleId
 *  the caller used ("harvest", "aligning-pool", ...); `session` is the lane/session NAME the
 *  attempt actually ran under (peripheral.ts generates a fresh name per RoleRunner.run() call,
 *  so two attempts of the same phase get two distinct `session` values — `attempt` is still
 *  recorded separately because it's the caller's own retry ordinal, not derivable from the name
 *  alone). */
export interface ContextManifestKey {
  roundId: number;
  phase: string;
  role: string;
  session: string;
  attempt: number;
}

// ── #234: forge MCP proxy journal + frozen evidence bundles ────────────────────────────────

/** The same (round, phase, role, session, attempt) 5-tuple ContextManifestKey/InputManifestRow
 *  use — see the schema v15->v16 migration comment for why the journal reuses it rather than
 *  inventing its own identity shape.
 *
 *  #253 review round 2 (Codex sol-high, H2): the SHAPE is shared, but not every mint() caller
 *  populates it with a value that actually corresponds to a real ContextManifestKey/
 *  InputManifestRow for the SAME session. Two production callers (proxy/mint.ts's
 *  createProxyMint is only ever given what its caller supplies) use fixed SENTINEL values,
 *  documented at their own construction sites:
 *    - cli.ts's `buildTickFixLegResume` (tick-driver fix-loop mint): `roundId: 0, phase: "tick"`
 *      — the tick driver has no round concept at all, so there is no real round to name.
 *    - cli.ts's `runRoundsEngine` RoleRunner-wide `defaultProxy` (every peripheral role session):
 *      `roundId: 0, phase: "peripheral"` — one RoleRunner instance is shared across the WHOLE
 *      run's every round, so no single round id is correct for it.
 *  Only round.ts's `buildFixLegResume` (the rounds driver's per-round fix-loop mint) supplies a
 *  REAL `roundId` (the round actually in flight) and phase ("executing", the only phase a fix
 *  leg is ever dispatched from).
 *  `attempt` is ALWAYS `1` on every current caller, in every case — a fix leg's own resume
 *  attempt is not tracked as a distinct ordinal here (proxy/mint.ts's createProxyMint doc:
 *  harmless for journal UNIQUENESS, since `session` — a fresh name per dispatch/resume — already
 *  disambiguates attempts; but it means `attempt` in this tuple is never a real retry ordinal for
 *  ANY current caller, unlike ContextManifestKey.attempt).
 *  Net effect: this tuple is a durable AUDIT/observability key for the proxy's own journal (what
 *  was called, by which role/session, with what result) — never assume it joins cleanly onto a
 *  real context_manifests or input_manifests row for the sentinel-identity cases above. Whether a
 *  fix leg needs its own tracked attempt ordinal (and whether the tick-driver/RoleRunner-wide
 *  sentinels need a real identity) is evaluated as a live-run finding (#253 item 3), not decided
 *  here. */
export interface ForgeProxyIdentity {
  roundId: number;
  phase: string;
  role: string;
  session: string;
  attempt: number;
}

export type ForgeProxyJournalStatus = "intent" | "fetched" | "error" | "delivered";

/** Fields State.appendForgeProxyJournalIntent persists BEFORE any upstream fetch — the
 *  write-ahead "intent" half of the row (issue #234's Journal contract: "persist request intent
 *  -> fetch+cap -> persist canonical response + hash -> deliver"). `seq` must come from
 *  State.nextForgeProxySeq (never a caller-held in-memory counter — same durable-counter
 *  rationale as nextInputManifestAttempt). */
export interface ForgeProxyJournalIntent {
  identity: ForgeProxyIdentity;
  seq: number;
  tool: string;
  proxyVersion: string;
  /** Canonical (deterministically key-sorted) JSON of the validated tool arguments. */
  argsCanonical: string;
  /** Canonical JSON of the server-enforced scope (e.g. `{"owner":...,"repo":...}`) — recorded
   *  even though it never varies per call, so a row is self-describing without joining config. */
  scopeCanonical: string;
  /** Canonical JSON of the caps this call was checked against. */
  capsCanonical: string;
  budgetRemainingCalls: number | null;
  budgetRemainingBytes: number | null;
  requestedAt: string;
}

/** Fields State.recordForgeProxyJournalResponse persists once the fetch+cap step succeeds — the
 *  write-ahead "response" half. A row that never reaches this (or recordForgeProxyJournalError)
 *  stays status='intent' forever — the honest shape of "we asked, then crashed/restarted before
 *  we knew the outcome". */
export interface ForgeProxyJournalResponse {
  /** Canonical JSON of the exact response delivered — the frozen-bundle source. */
  responseCanonical: string;
  contentHash: string;
  upstreamIds?: string | null; // canonical JSON array, when the tool has upstream ids to name
  upstreamUpdatedAt?: string | null;
  countsCanonical?: string | null; // canonical JSON of counts (e.g. {"total":N,"returned":M})
  truncated: boolean;
  fetchedAt: string;
}

export interface ForgeProxyJournalRow {
  id: number;
  identity: ForgeProxyIdentity;
  seq: number;
  tool: string;
  proxyVersion: string;
  argsCanonical: string;
  scopeCanonical: string;
  capsCanonical: string;
  budgetRemainingCalls: number | null;
  budgetRemainingBytes: number | null;
  status: ForgeProxyJournalStatus;
  upstreamIds: string | null;
  upstreamUpdatedAt: string | null;
  countsCanonical: string | null;
  truncated: boolean;
  responseCanonical: string | null;
  /** UTF-8 byte length of `responseCanonical` (#234 F4) — null until the response is persisted,
   *  same null-until-fetched convention as `responseCanonical`/`contentHash`. */
  responseBytes: number | null;
  contentHash: string | null;
  error: string | null;
  timedOut: boolean;
  requestedAt: string;
  fetchedAt: string | null;
  deliveredAt: string | null;
}

/** State.recordForgeProxyBundle's insert shape — see the schema v15->v16 migration comment for
 *  the table's own rationale. `path` is what State.forgeProxyBundleDir-derived write actually
 *  wrote to disk, or null when there is no data dir (in-memory State). */
export interface ForgeProxyBundleRow {
  hash: string;
  identity: Pick<ForgeProxyIdentity, "roundId" | "phase" | "role" | "session">;
  decisionRef: string | null;
  byteSize: number;
  path: string | null;
  createdAt: string;
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
            review_triggered_head, review_triggered_at, review_trigger_generation,
            review_trigger_ambiguous, review_delta_chain, review_trigger_in_flight,
            review_covered_head,
            review_fallback_head, review_fallback_kind,
            gated_reentry_attempts, gated_reentry_capped, gated_escalation_labeled,
            resume_attempts, resume_capped, fix_rounds, fixing_handoff, ac_body_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           issue = excluded.issue, session_id = excluded.session_id,
           state = excluded.state, started_at = excluded.started_at,
           ended_at = excluded.ended_at, pr = excluded.pr,
           review_triggered = excluded.review_triggered,
           review_triggered_head = excluded.review_triggered_head,
           review_triggered_at = excluded.review_triggered_at,
           review_trigger_generation = excluded.review_trigger_generation,
           review_trigger_ambiguous = excluded.review_trigger_ambiguous,
           review_delta_chain = excluded.review_delta_chain,
           review_trigger_in_flight = excluded.review_trigger_in_flight,
           review_covered_head = CASE
             WHEN excluded.session_id != workers.session_id THEN excluded.review_covered_head
             ELSE workers.review_covered_head
           END,
           review_fallback_head = excluded.review_fallback_head,
           review_fallback_kind = excluded.review_fallback_kind,
           gated_reentry_attempts = excluded.gated_reentry_attempts,
           gated_reentry_capped = excluded.gated_reentry_capped,
           gated_escalation_labeled = excluded.gated_escalation_labeled,
           resume_attempts = excluded.resume_attempts,
           resume_capped = excluded.resume_capped,
           fix_rounds = excluded.fix_rounds,
           fixing_handoff = excluded.fixing_handoff,
           ac_body_hash = excluded.ac_body_hash`,
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
        row.review_trigger_generation ?? 0,
        row.review_trigger_ambiguous ?? 0,
        row.review_delta_chain ?? 0,
        row.review_trigger_in_flight ?? (row.review_triggered_head ? 1 : 0),
        row.review_covered_head ?? null,
        row.review_fallback_head ?? null,
        row.review_fallback_kind ?? null,
        row.gated_reentry_attempts ?? 0,
        row.gated_reentry_capped ?? 0,
        row.gated_escalation_labeled ?? 0,
        row.resume_attempts ?? 0,
        row.resume_capped ?? 0,
        row.fix_rounds ?? 0,
        row.fixing_handoff ?? 0,
        row.ac_body_hash ?? null,
      );
  }

  /** Persist the ENGINE-recorded review-trigger pin for `name`'s lane (#55 P1-B) — called ONLY
   *  from MergeDriver.driveOne's recordTrigger callback (conductor.ts wires this method in),
   *  the instant a fresh `@codex review` trigger is posted for a NEW head. A worker/producer
   *  has no path to this method (no reference to State) and posting extra comments themselves
   *  cannot move this pin — it is written exclusively by the engine's own gate loop. */
  recordReviewTrigger(
    name: string,
    head: string,
    at: string,
    meta?: { generation: number; ambiguous: boolean; deltaChain: number; inFlight: boolean },
  ): void {
    const row = this.getWorker(name);
    const generation = meta?.generation ?? (row?.review_trigger_generation ?? 0) + 1;
    this.db
      .prepare(
        `UPDATE workers SET review_triggered_head = ?, review_triggered_at = ?,
         review_trigger_generation = ?, review_trigger_ambiguous = ?, review_delta_chain = ?,
         review_trigger_in_flight = ? WHERE name = ?`,
      )
      .run(head, at, generation, meta?.ambiguous ? 1 : 0, meta?.deltaChain ?? 0, meta?.inFlight === false ? 0 : 1, name);
  }

  /** Record an attributable response and optional trusted coverage; stale callbacks no-op. */
  recordReviewVerdict(name: string, head: string, generation: number, coverageEstablished: boolean): void {
    this.db
      .prepare(
        `UPDATE workers SET review_trigger_in_flight = 0,
         review_covered_head = CASE WHEN ? = 1 THEN ? ELSE review_covered_head END
         WHERE name = ? AND review_triggered_head = ? AND review_trigger_generation = ?`,
      )
      .run(coverageEstablished ? 1 : 0, head, name, head, generation);
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

  /** #287 (E4b, AC#1): record ONE freshly-observed actual model for `name`'s lane, as early as
   *  worker.ts's probe() sees it (the session-init line, well before the lane's own leg reaches
   *  a terminal reclaim / spend_ledger settlement — see getWorkerActualModels' own doc). Union-
   *  append, idempotent: a model already recorded is a no-op (no duplicate, no extra write);
   *  `'unknown'`/empty are never stored (same exclusion spend_ledger's own model column already
   *  applies at settleTerminalWorker time — an unidentifiable model is never a comparable actual).
   *  Update-in-place on the EXISTING row (never routed through upsertWorker's full-row replace —
   *  see WorkerRow.actual_models_json's own doc for why); a no-op if `name` has no row yet. */
  recordWorkerActualModel(name: string, model: string): void {
    if (!model || model === "unknown") return;
    const row = this.db.prepare("SELECT actual_models_json FROM workers WHERE name = ?").get(name) as
      | { actual_models_json: string | null }
      | undefined;
    if (!row) return;
    let models: string[];
    try {
      const parsed: unknown = row.actual_models_json ? JSON.parse(row.actual_models_json) : [];
      models = Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
    } catch {
      models = []; // corrupt JSON (should never happen — this column is engine-written only) — fail closed, start fresh
    }
    if (models.includes(model)) return; // already recorded, no-op
    models.push(model);
    this.db.prepare("UPDATE workers SET actual_models_json = ? WHERE name = ?").run(JSON.stringify(models), name);
  }

  /** #287 (E4b, design #279 §2 R3): the engine-agent per-head ATTEMPT PIN for `name`'s lane.
   *  `null` clears it (a head change, driveOne's own detection — see review/drive.ts). Also
   *  writes engine_review_first_attempt_at when transitioning from "no pin"/a different head to
   *  a NEW head's first attempt (see the schema v24->v25 migration comment for why this
   *  companion clock exists); left untouched on every subsequent same-head write. Update-in-
   *  place — never routed through upsertWorker (same rationale as recordReviewFallback above). */
  recordEngineReviewAttemptPin(
    name: string,
    pin: { head: string; at: string; runId: string; kind: "decisive" | "unavailable" } | null,
  ): void {
    if (pin === null) {
      this.db
        .prepare(
          "UPDATE workers SET engine_review_pin_head = NULL, engine_review_pin_at = NULL, " +
            "engine_review_pin_run_id = NULL, engine_review_pin_kind = NULL, engine_review_first_attempt_at = NULL WHERE name = ?",
        )
        .run(name);
      return;
    }
    const row = this.getWorker(name);
    const isNewHead = row?.engine_review_pin_head !== pin.head || row?.engine_review_first_attempt_at == null;
    this.db
      .prepare(
        "UPDATE workers SET engine_review_pin_head = ?, engine_review_pin_at = ?, engine_review_pin_run_id = ?, " +
          "engine_review_pin_kind = ?, engine_review_first_attempt_at = ? WHERE name = ?",
      )
      .run(pin.head, pin.at, pin.runId, pin.kind, isNewHead ? pin.at : (row?.engine_review_first_attempt_at ?? pin.at), name);
  }

  /** #287 (E4b): the CURRENT engine-agent attempt pin, validated at this read boundary — an
   *  unrecognized `engine_review_pin_kind` string (should never happen; this column is engine-
   *  written only) fails closed to "no pin", same stance review_fallback_kind's own read
   *  boundary already takes. */
  getEngineReviewAttemptPin(name: string): { head: string; at: string; runId: string; kind: "decisive" | "unavailable" } | null {
    const row = this.getWorker(name);
    if (!row || row.engine_review_pin_head == null || row.engine_review_pin_at == null || row.engine_review_pin_run_id == null) return null;
    if (row.engine_review_pin_kind !== "decisive" && row.engine_review_pin_kind !== "unavailable") return null;
    return {
      head: row.engine_review_pin_head,
      at: row.engine_review_pin_at,
      runId: row.engine_review_pin_run_id,
      kind: row.engine_review_pin_kind,
    };
  }

  /** #287 (E4b): persist `name`'s lane's engine-agent WAL record — see the schema v24->v25
   *  migration comment for the full field rationale and write-ordering. Upsert-by-worker_name
   *  (current attempt only, never append-only — see the migration comment). Called BEFORE the
   *  review session is spawned. */
  recordEngineReviewWal(name: string, wal: { runId: string; head: string; base: string; diffHash: string; attemptStart: string }): void {
    this.db
      .prepare(
        `INSERT INTO engine_review_wal (worker_name, run_id, head, base, diff_hash, tree_manifest_hash, attempt_start, decisive_outcome)
         VALUES (?, ?, ?, ?, ?, NULL, ?, NULL)
         ON CONFLICT(worker_name) DO UPDATE SET
           run_id = excluded.run_id, head = excluded.head, base = excluded.base,
           diff_hash = excluded.diff_hash, tree_manifest_hash = NULL,
           attempt_start = excluded.attempt_start, decisive_outcome = NULL,
           review_artifact_json = NULL, audit_comment_id = NULL, audit_delivered_at = NULL`,
      )
      .run(name, wal.runId, wal.head, wal.base, wal.diffHash, wal.attemptStart);
  }

  /** #287 (E4b, design #279 §3): fill in the materializer's tree-manifest hash once the
   *  materialize step completes — still strictly before the review session spawns (see
   *  review/drive.ts). Guarded by `runId` so a WAL row already superseded by a LATER attempt
   *  (e.g. a crash-restart's fresh WAL write racing a stale in-flight completion) can never have
   *  a stale hash land on the wrong attempt's row. */
  updateEngineReviewWalManifestHash(name: string, runId: string, manifestHash: string): void {
    this.db
      .prepare("UPDATE engine_review_wal SET tree_manifest_hash = ? WHERE worker_name = ? AND run_id = ?")
      .run(manifestHash, name, runId);
  }

  /** #287/#288: record the engine-derived decisive outcome WAL-first, before audit delivery.
   *  This is recovery input, not permission to consume: only a runId-guarded audit receipt makes
   *  the pin permanent. Same stale-run containment as updateEngineReviewWalManifestHash. */
  recordEngineReviewWalDecisiveOutcome(name: string, runId: string, outcome: "approved" | "rejected"): void {
    this.db.prepare("UPDATE engine_review_wal SET decisive_outcome = ? WHERE worker_name = ? AND run_id = ?").run(outcome, name, runId);
  }

  /** #288: persist the validated artifact and engine-derived decisive outcome before posting.
   *  The runId guard is the same stale-attempt containment used by the manifest update. */
  recordEngineReviewWalArtifact(name: string, runId: string, outcome: "approved" | "rejected", artifactJson: string): boolean {
    const result = this.db
      .prepare("UPDATE engine_review_wal SET decisive_outcome = ?, review_artifact_json = ? WHERE worker_name = ? AND run_id = ?")
      .run(outcome, artifactJson, name, runId);
    return result.changes === 1;
  }

  /** #288: durable audit delivery receipt. `true` means THIS run's row was updated; false means
   *  it was superseded and the caller must fail closed rather than claiming delivery. */
  recordEngineReviewAuditReceipt(name: string, runId: string, commentId: string, deliveredAt: string): boolean {
    const result = this.db
      .prepare(
        "UPDATE engine_review_wal SET audit_comment_id = ?, audit_delivered_at = ? " +
          "WHERE worker_name = ? AND run_id = ? AND review_artifact_json IS NOT NULL AND decisive_outcome IS NOT NULL",
      )
      .run(commentId, deliveredAt, name, runId);
    return result.changes === 1;
  }

  /** #287 (E4b): the CURRENT engine-agent WAL record for `name`'s lane (the lane's most recent
   *  attempt — this table is upsert-by-worker_name, never append-only, see the migration
   *  comment). `null` when none has ever been recorded. */
  getEngineReviewWal(name: string): {
    runId: string;
    head: string;
    base: string;
    diffHash: string;
    treeManifestHash: string | null;
    attemptStart: string;
    decisiveOutcome: "approved" | "rejected" | null;
    reviewArtifactJson: string | null;
    auditCommentId: string | null;
    auditDeliveredAt: string | null;
  } | null {
    const row = this.db.prepare("SELECT * FROM engine_review_wal WHERE worker_name = ?").get(name) as
      | {
          run_id: string;
          head: string;
          base: string;
          diff_hash: string;
          tree_manifest_hash: string | null;
          attempt_start: string;
          decisive_outcome: string | null;
          review_artifact_json: string | null;
          audit_comment_id: string | null;
          audit_delivered_at: string | null;
        }
      | undefined;
    if (!row) return null;
    const decisiveOutcome = row.decisive_outcome === "approved" || row.decisive_outcome === "rejected" ? row.decisive_outcome : null;
    return {
      runId: row.run_id,
      head: row.head,
      base: row.base,
      diffHash: row.diff_hash,
      treeManifestHash: row.tree_manifest_hash,
      attemptStart: row.attempt_start,
      decisiveOutcome,
      reviewArtifactJson: row.review_artifact_json,
      auditCommentId: row.audit_comment_id,
      auditDeliveredAt: row.audit_delivered_at,
    };
  }

  /** Heads whose current lane WAL has not reached a decisive outcome. This is the minimal
   *  read-only liveness view used by review-tree GC: both an in-flight attempt and a lane that
   *  escalated to human resolution deliberately remain NULL and therefore retain their tree. */
  getLiveEngineReviewHeads(): string[] {
    const rows = this.db
      .prepare(
        "SELECT DISTINCT head FROM engine_review_wal " +
          "WHERE decisive_outcome IS NULL OR decisive_outcome NOT IN ('approved', 'rejected') ORDER BY head",
      )
      .all() as { head: string }[];
    return rows.map((row) => row.head);
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

  /** Occupied lanes: running + driving + fixing (#245: a `fixing` lane is a live fix-leg worker
   *  process holding the SAME PR's lane occupied while it reworks it — it counts against
   *  cfg.lanes.max exactly like `running`/`driving` do). The dispatch capacity + in-flight set. */
  activeWorkers(): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE state IN ('running', 'driving', 'fixing') ORDER BY name")
      .all() as unknown as WorkerRow[];
  }

  /** Rows that still own an issue for startup reconciliation. Handoff is terminal to the live
   *  scheduler but resumable, so it deliberately prevents a board issue being called orphaned.
   *  #245: `fixing` is included for the same reason `running` is — a live fix-leg process still
   *  owns its issue across a restart. */
  reconcileWorkers(): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE state IN ('running', 'driving', 'fixing', 'handoff') ORDER BY name")
      .all() as unknown as WorkerRow[];
  }

  /** Lanes holding a PR awaiting the review gate (#13's merge driver). No live worker process —
   *  just a lane occupying capacity until gate①/gate② resolve it to merged/needs-human/queued.
   *  A `fixing` lane is deliberately EXCLUDED here (#245): it has a live worker process (unlike
   *  `driving`), so it must never be scanned by the DRIVE loop's gate②/merge machinery — the
   *  structural reason #170's review-silence escalation cannot arm while a lane is fixing (that
   *  clock only ever fires from inside the DRIVE loop, which iterates this exact set). */
  drivingWorkers(): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE state = 'driving' ORDER BY name").all() as unknown as WorkerRow[];
  }

  /** #245 fix-loop candidates: lanes currently running a fix leg — a LIVE worker process (same
   *  heartbeat/timeout/soft-budget supervision as `running`, see conductor.ts's FIXING RECLAIM
   *  phase) holding a PR that needs rework. Never scanned by the DRIVE loop (drivingWorkers()
   *  above) — the two sets are mutually exclusive by construction (a row is in exactly one
   *  `state` at a time). */
  fixingWorkers(): WorkerRow[] {
    return this.db.prepare("SELECT * FROM workers WHERE state = 'fixing' ORDER BY name").all() as unknown as WorkerRow[];
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
   *  the marker) is permanently invisible here (fail-closed, manual drive as before #147).
   *
   *  #245/#246 NARROWED SEMANTICS (fix-loop, #246 landed): with `cfg.lanes.prFixCap > 0`,
   *  ordinary review findings (HANDLE_THREADS) and CI-red no longer escalate straight to
   *  `failed`+pr at all — they route to a `fixing` leg instead (this row's `state` briefly
   *  leaves `driving` entirely, see WorkerState's doc and fixingWorkers()). The ONLY producer of
   *  a `failed`+pr row left standing (besides prFixCap === 0's byte-for-byte pre-#246 fold,
   *  which behaves exactly as before this comment) is the fix_rounds CAP escalation
   *  (conductor.ts's DRIVE loop: driveDecision's FIXABLE-at-cap -> ESCALATE branch) — a lane
   *  that has exhausted its rework-round budget without a clean review. Findings no longer
   *  masquerade as `failed`; a `failed`+pr row reaching this query means "a human's real
   *  judgment call is needed", never "the producer left work unaddressed". */
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
   *  label is cosmetic, a lost ledger row is money (issue #223's ordering rule).
   *
   *  #247 D4 (Codex sol-high PR #265 review round 1, P1): the OPTIONAL `fixResponse` param folds
   *  a `fixing` lane's harvested structured output into this SAME transaction — a validated
   *  batch's entire pending_thread_writes insert set + its `fix-response-queued` receipt event,
   *  or an invalid output's `fix-response-invalid` event, land atomically with the terminal
   *  `driving` state write. Before this, harvesting ran as a SEPARATE call after
   *  settleTerminalWorker returned — a crash in between could lose a validated batch entirely
   *  (the leg already exited; nothing re-runs it), or (less likely but still possible) leave a
   *  partially-inserted batch. The caller (conductor.ts's reclaimTerminalLane, via
   *  fix-response.ts's computeFixResponseHarvest) computes `fixResponse` PURELY/READ-ONLY BEFORE
   *  calling this — the only writes for it happen here, inside the one transaction. */
  settleTerminalWorker(
    row: WorkerRow,
    spend: { worker: string; issue: number; usd: number; at: string; models?: ModelUsageEntry[] },
    fixResponse?: FixResponseSettleOutcome,
  ): void {
    this.db.exec("BEGIN");
    try {
      this.upsertWorker(row);
      this.recordSpend(spend.worker, spend.issue, spend.usd, spend.at, spend.models ?? []);
      if (fixResponse) {
        if (fixResponse.kind === "invalid") {
          this.appendEvent("fix-response-invalid", { ...fixResponse.invalid });
        } else {
          const { batch } = fixResponse;
          for (const w of batch.writes) {
            this.enqueueThreadWrite(
              {
                worker: batch.worker,
                issue: batch.issue,
                pr: batch.pr,
                threadId: w.threadId,
                reply: w.reply,
                resolution: w.resolution,
                batchKey: batch.batchKey,
                fixRounds: batch.fixRounds,
              },
              spend.at,
            );
          }
          this.appendEvent("fix-response-queued", {
            worker: batch.worker,
            issue: batch.issue,
            pr: batch.pr,
            batchKey: batch.batchKey,
            fixRounds: batch.fixRounds,
            count: batch.writes.length,
          });
        }
      }
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

  /** #286 (E4a, D5 runtime half): the PRODUCING lane's own RECORDED ACTUAL model(s) for an
   *  issue — engine-agent.ts's runtime model-separation check reads this to compare against
   *  `reviewer.agent.model`. Resolves the MOST RECENT `workers` row for `issue` (a lane may have
   *  had multiple legs across resumes/fix rounds; the newest one is the one whose PR is under
   *  review), then reads its DISTINCT `model` values from `spend_ledger` (the ONLY durable
   *  storage of a lane's ACTUAL — not requested — model, populated by `recordSpend`/
   *  `settleTerminalWorker` from the CLI's own stream-json report, worker.ts's parseModelUsage).
   *
   *  #287 (E4b, AC#1) CLOSES the honest limitation this doc used to describe: `spend_ledger` rows
   *  are written only at a lane's TERMINAL settlement (reclaim), which can genuinely postdate the
   *  moment an engine-agent review needs a signal — so this now UNIONS spend_ledger's settled
   *  models with `workers.actual_models_json` (State.recordWorkerActualModel), the durable EARLY
   *  record worker.ts's probe() writes as soon as the session-init line (or a later modelUsage
   *  observation) is seen, well before any terminal reclaim. `[]` still means genuinely
   *  "unknown" (design #279 §6: "worker actual unknown ⇒ unavailable" — a same-model verdict
   *  must never gate, so an UNKNOWN actual fails closed exactly like a KNOWN-equal one, never
   *  optimistically treated as "distinguishable"), now reached only when NEITHER source has
   *  observed anything yet. `'unknown'` entries are excluded from both sources — an "unknown"
   *  actual is exactly as indistinguishable as no row at all, never treated as a real, comparable
   *  model string. */
  getWorkerActualModels(issue: number): string[] {
    const lane = this.db
      .prepare("SELECT name, actual_models_json FROM workers WHERE issue = ? ORDER BY started_at DESC LIMIT 1")
      .get(issue) as { name: string; actual_models_json: string | null } | undefined;
    if (!lane) return [];
    const rows = this.db
      .prepare("SELECT DISTINCT model FROM spend_ledger WHERE worker = ? AND model != 'unknown' ORDER BY model")
      .all(lane.name) as { model: string }[];
    const models = new Set(rows.map((r) => r.model));
    if (lane.actual_models_json) {
      try {
        const parsed: unknown = JSON.parse(lane.actual_models_json);
        if (Array.isArray(parsed)) {
          for (const m of parsed) {
            if (typeof m === "string" && m.length > 0 && m !== "unknown") models.add(m);
          }
        }
      } catch {
        // corrupt JSON (should never happen — engine-written only) — ignore, fall back to spend_ledger alone
      }
    }
    return [...models].sort();
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

  // ── Fix-leg thread-response write queue (#247) ──────────────────────────────────────────

  /** Persist one pending thread write BEFORE any forge call is attempted (write-ahead, same
   *  rationale as addPendingRollback) — the row IS "attempt 0"; the immediately-following
   *  attempt is recorded via markThreadReplyPosted/markThreadResolved/bumpThreadWriteAttempt,
   *  never a second insert. `INSERT OR IGNORE` on the (batch_key, thread_id) unique index (D4):
   *  a duplicate insert for the SAME fix round's SAME thread is a silent no-op rather than a
   *  constraint-violation throw — belt-and-suspenders alongside settleTerminalWorker's own
   *  atomic commit (which already makes a genuine duplicate batch practically unreachable).
   *  Returns the row id, or 0 when the insert was ignored (a caller that needs the id back
   *  should not rely on this in that case — no production call site does). */
  enqueueThreadWrite(
    input: {
      worker: string;
      issue: number;
      pr: number;
      threadId: string;
      reply: string;
      resolution: "addressed" | "disputed";
      batchKey: string;
      fixRounds: number;
    },
    at: string,
  ): number {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO pending_thread_writes
           (worker, issue, pr, thread_id, reply, resolution, batch_key, fix_rounds, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(input.worker, input.issue, input.pr, input.threadId, input.reply, input.resolution, input.batchKey, input.fixRounds, at);
    return Number(res.lastInsertRowid);
  }

  /** Every thread write still awaiting completion or escalation, oldest first (retry order). */
  pendingThreadWrites(): PendingThreadWrite[] {
    const rows = this.db.prepare("SELECT * FROM pending_thread_writes ORDER BY id").all() as unknown as RawPendingThreadWrite[];
    return rows.map(mapPendingThreadWrite);
  }

  /** The reply half completed — never re-attempted after this, regardless of how the resolve
   *  half (if any) fares afterward. */
  markThreadReplyPosted(id: number, at: string): void {
    this.db.prepare("UPDATE pending_thread_writes SET reply_posted = 1, last_attempt_at = ? WHERE id = ?").run(at, id);
  }

  /** The resolve half completed (`addressed` rows only — a `disputed` row never calls this). */
  markThreadResolved(id: number, at: string): void {
    this.db.prepare("UPDATE pending_thread_writes SET resolved = 1, last_attempt_at = ? WHERE id = ?").run(at, id);
  }

  /** Record one more failed attempt (attempts++, last_attempt_at refreshed) — the row stays,
   *  to be retried again next tick. */
  bumpThreadWriteAttempt(id: number, at: string): void {
    this.db.prepare("UPDATE pending_thread_writes SET attempts = attempts + 1, last_attempt_at = ? WHERE id = ?").run(at, id);
  }

  /** Resolved — either every remaining half succeeded, or attempts hit the bounded retry cap
   *  and the conductor escalated to needs-human instead. Either way, stop retrying. */
  clearThreadWrite(id: number): void {
    this.db.prepare("DELETE FROM pending_thread_writes WHERE id = ?").run(id);
  }

  /** #247 F3 (Codex sol-high PR #265 review round 2, P2): markThreadReplyPosted + its
   *  fix-thread-reply-posted receipt event, committed in ONE transaction — as two separate
   *  writes, a crash between them could leave the reply durably marked posted with NO receipt
   *  event ever recorded (or vice versa), losing the "every executed write journaled with
   *  leg/round provenance" AC's own promise for that write. `receipt` is fix-response.ts's
   *  provenance() payload — accepted as an opaque object so this method stays agnostic of the
   *  fix-response shape (state.ts owns no fix-response-specific types beyond FixResponseSettle*). */
  completeThreadReply(id: number, at: string, receipt: Record<string, unknown>): void {
    this.db.exec("BEGIN");
    try {
      this.markThreadReplyPosted(id, at);
      this.appendEvent("fix-thread-reply-posted", receipt);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** #247 F3: markThreadResolved + clearThreadWrite + the fix-thread-resolved receipt event, all
   *  in ONE transaction — same rationale as completeThreadReply above, for the resolve half. */
  completeThreadResolve(id: number, at: string, receipt: Record<string, unknown>): void {
    this.db.exec("BEGIN");
    try {
      this.markThreadResolved(id, at);
      this.clearThreadWrite(id);
      this.appendEvent("fix-thread-resolved", receipt);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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
   *  v13->v14 migration comment): callers (align.ts's/architect.ts's recordInputManifest) wrap
   *  this best-effort, the same "a write failure here must never block the session it's
   *  describing" contract as every other observability-only append in this file. `truncated` is
   *  THREE-STATE (schema v16->v17): an omitted `row.truncated` (the caller has no idea whether
   *  this channel was truncated by some upstream mechanism it can't see) persists as SQL NULL,
   *  never coerced to `false` — only an EXPLICIT `true`/`false` from the caller writes 1/0. */
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
        row.truncated === undefined || row.truncated === null ? null : row.truncated ? 1 : 0,
        row.detail ?? null,
        now ?? new Date().toISOString(),
      );
  }

  /** Every input-manifest row for one round, oldest first — test/inspection reader. Not
   *  consulted by any engine decision today (see the schema v13->v14 migration comment: the
   *  manifest is a record, not a gate). `truncated` round-trips as `null` (never `false`) when
   *  the writer never supplied it — schema v16->v17's three-state fix. */
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
      truncated: number | null;
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
      truncated: r.truncated === null ? null : r.truncated === 1,
      detail: r.detail,
      ts: r.ts,
    }));
  }

  // ── #236: ambient session context manifests (context_manifests, migration 14->15) ────────

  /** Upsert ONE session attempt's context manifest. `json` is the caller's already-serialized,
   *  already-assembled manifest (roles/context-manifest.ts's `assembleContextManifest` output —
   *  state.ts stores it opaquely, same round_artifacts.json convention). Idempotent per
   *  (round, phase, role, session, attempt): a crash-rerun that re-records the SAME attempt
   *  overwrites rather than duplicates. Never called for a round/phase/attempt this table
   *  doesn't already understand — the caller (peripheral.ts's runSessionWithRetry) owns
   *  building the key; this method only persists it. */
  recordContextManifest(key: ContextManifestKey, json: string, recordedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO context_manifests (round_id, phase, role, session, attempt, recorded_at, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(round_id, phase, role, session, attempt) DO UPDATE SET
           recorded_at = excluded.recorded_at, json = excluded.json`,
      )
      .run(key.roundId, key.phase, key.role, key.session, key.attempt, recordedAt, json);
  }

  /** The persisted manifest for one exact attempt, or undefined if that attempt never recorded
   *  one. `json` is returned RAW — the caller parses it against the shape it understands
   *  (roles/context-manifest.ts's ContextManifest), same reader contract as getRoundArtifact. */
  getContextManifest(key: ContextManifestKey): { recordedAt: string; json: string } | undefined {
    const row = this.db
      .prepare(
        "SELECT recorded_at, json FROM context_manifests WHERE round_id = ? AND phase = ? AND role = ? AND session = ? AND attempt = ?",
      )
      .get(key.roundId, key.phase, key.role, key.session, key.attempt) as { recorded_at: string; json: string } | undefined;
    return row ? { recordedAt: row.recorded_at, json: row.json } : undefined;
  }

  /** Every manifest recorded for a round, insertion order — the "reconstruct the whole round's
   *  ambient-context history" read (e.g. comparing two attempts of the same phase). */
  listContextManifestsForRound(roundId: number): Array<ContextManifestKey & { recordedAt: string; json: string }> {
    const rows = this.db
      .prepare("SELECT round_id, phase, role, session, attempt, recorded_at, json FROM context_manifests WHERE round_id = ? ORDER BY id")
      .all(roundId) as Array<{
      round_id: number;
      phase: string;
      role: string;
      session: string;
      attempt: number;
      recorded_at: string;
      json: string;
    }>;
    return rows.map((r) => ({
      roundId: r.round_id,
      phase: r.phase,
      role: r.role,
      session: r.session,
      attempt: r.attempt,
      recordedAt: r.recorded_at,
      json: r.json,
    }));
  }

  // ── #283: AC-authority dispatch snapshot (ac_snapshots, migration 22->23) ───────────────

  /** Persist ONE issue's pre-launch AC-authority snapshot (design #279 §5) — INSERT OR REPLACE
   *  keyed by `snapshot.issue` alone (see the migration comment above for why upsert-by-issue,
   *  not append-only, is the right shape). conductor.ts's DISPATCH loop calls this BEFORE
   *  `supervisor.dispatch()` ever spawns the worker, inside the SAME try/catch that already
   *  rolls the board claim back to Ready on a dispatch failure — a write failure here throws
   *  and is caught by that SAME rollback path, so a snapshot-persistence hiccup can never leave
   *  a worker running against an unrecorded AC set. `manifest` is stored as opaque JSON (never
   *  interpreted here, same convention as round_artifacts/context_manifests). */
  recordAcSnapshot(snapshot: AcSnapshot): void {
    this.db
      .prepare(
        `INSERT INTO ac_snapshots (issue, body_hash, body, manifest_json, snapshotted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(issue) DO UPDATE SET
           body_hash = excluded.body_hash,
           body = excluded.body,
           manifest_json = excluded.manifest_json,
           snapshotted_at = excluded.snapshotted_at`,
      )
      .run(snapshot.issue, snapshot.bodyHash, snapshot.body, JSON.stringify(snapshot.manifest), snapshot.snapshottedAt);
  }

  /** The read counterpart — conductor.ts's DRIVE loop consults this before a driving lane ever
   *  reaches `gate.driveOne` (see checkAcSnapshotDrift, ac-snapshot.ts, and
   *  checkAcDriftBeforeDrive, conductor.ts). `null` when no snapshot is currently recorded for
   *  this issue — either a lane dispatched before this migration shipped, or a caller that
   *  bypassed the DISPATCH loop (e.g. a test seeding a worker row directly). The caller's
   *  treatment of `null` depends on ITS OWN lane's `workers.ac_body_hash` (#301 P1#1/P1#3 fix):
   *  a lane that never recorded one (`ac_body_hash` null) treats this as "nothing to compare
   *  against" and drives normally; a lane whose OWN dispatch DID record one (`ac_body_hash` set)
   *  treats a `null` here — or a non-null row whose `bodyHash` no longer matches that lane's own
   *  stamped hash (a LATER, different lane's dispatch has since overwritten it, see the migration
   *  22->23 comment) — as a fail-closed anomaly, never as "nothing to compare against". */
  getAcSnapshot(issue: number): AcSnapshot | null {
    const row = this.db
      .prepare("SELECT issue, body_hash, body, manifest_json, snapshotted_at FROM ac_snapshots WHERE issue = ?")
      .get(issue) as { issue: number; body_hash: string; body: string; manifest_json: string; snapshotted_at: string } | undefined;
    if (!row) return null;
    return {
      issue: row.issue,
      bodyHash: row.body_hash,
      body: row.body,
      manifest: JSON.parse(row.manifest_json) as AcceptanceCriterion[],
      snapshottedAt: row.snapshotted_at,
    };
  }

  // ── #234: forge MCP proxy journal (forge_proxy_journal, migration 15->16) ───────────────

  /** The next per-session sequence number for (round, phase, role, session, attempt) — MAX(seq)+1,
   *  or 1 for the first call. Same durable-counter pattern as nextInputManifestAttempt: the table
   *  itself is the counter, so a crash-rerun continues the sequence with zero extra bookkeeping. */
  nextForgeProxySeq(identity: ForgeProxyIdentity): number {
    const row = this.db
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS m FROM forge_proxy_journal WHERE round_id = ? AND phase = ? AND role = ? AND session = ? AND attempt = ?",
      )
      .get(identity.roundId, identity.phase, identity.role, identity.session, identity.attempt) as { m: number };
    return row.m + 1;
  }

  /** Write-ahead step 1: persist request intent BEFORE any upstream fetch. Returns the row id —
   *  the caller threads it into recordForgeProxyJournalResponse/recordForgeProxyJournalError/
   *  markForgeProxyJournalDelivered. Throws straight through on a write failure (fail-closed: the
   *  proxy server must not proceed to fetch when it can't even record that it's about to). */
  appendForgeProxyJournalIntent(row: ForgeProxyJournalIntent): number {
    const result = this.db
      .prepare(
        `INSERT INTO forge_proxy_journal
           (round_id, phase, role, session, attempt, seq, tool, proxy_version, args_json, scope_json,
            caps_json, budget_remaining_calls, budget_remaining_bytes, status, requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'intent', ?)`,
      )
      .run(
        row.identity.roundId,
        row.identity.phase,
        row.identity.role,
        row.identity.session,
        row.identity.attempt,
        row.seq,
        row.tool,
        row.proxyVersion,
        row.argsCanonical,
        row.scopeCanonical,
        row.capsCanonical,
        row.budgetRemainingCalls,
        row.budgetRemainingBytes,
        row.requestedAt,
      );
    return Number(result.lastInsertRowid);
  }

  /** Write-ahead step 2 (success path): persist the canonical response + hash. The proxy server
   *  MUST deliver nothing to the session until this call returns — a throw here (disk full,
   *  corrupt DB handle, ...) must reach the caller as a typed tool error, never a silently
   *  undelivered-but-unrecorded response (issue #234's Journal contract). `response_bytes` is
   *  computed HERE, from `Buffer.byteLength` (UTF-8) — the one place this column's value is ever
   *  derived, so it can never disagree with itself across call sites (#234 F4, PR #252 review). */
  recordForgeProxyJournalResponse(id: number, r: ForgeProxyJournalResponse): void {
    this.db
      .prepare(
        `UPDATE forge_proxy_journal SET
           status = 'fetched', response_json = ?, response_bytes = ?, content_hash = ?,
           upstream_ids_json = ?, upstream_updated_at = ?, counts_json = ?, truncated = ?,
           fetched_at = ?
         WHERE id = ?`,
      )
      .run(
        r.responseCanonical,
        Buffer.byteLength(r.responseCanonical, "utf8"),
        r.contentHash,
        r.upstreamIds ?? null,
        r.upstreamUpdatedAt ?? null,
        r.countsCanonical ?? null,
        r.truncated ? 1 : 0,
        r.fetchedAt,
        id,
      );
  }

  /** Write-ahead step 2 (failure path): record a sanitized (never token-bearing — the caller
   *  scrubs upstream text before this reaches state.ts) error/timeout in place of a response. */
  recordForgeProxyJournalError(id: number, error: string, timedOut: boolean, at: string): void {
    this.db
      .prepare("UPDATE forge_proxy_journal SET status = 'error', error = ?, timed_out = ?, fetched_at = ? WHERE id = ?")
      .run(error, timedOut ? 1 : 0, at, id);
  }

  /** Audit refinement only (see the schema v15->v16 migration comment): the completeness
   *  invariant already holds once a row reaches 'fetched' — a persist failure never reaches this
   *  call at all (recordForgeProxyJournalResponse already ran, or the caller returned a typed
   *  error instead). A write failure here is caller-tolerated (best-effort), never propagated. */
  markForgeProxyJournalDelivered(id: number, at: string): void {
    this.db.prepare("UPDATE forge_proxy_journal SET status = 'delivered', delivered_at = ? WHERE id = ?").run(at, id);
  }

  /** One journal row by id — test/inspection reader. */
  getForgeProxyJournalRow(id: number): ForgeProxyJournalRow | undefined {
    const row = this.db.prepare("SELECT * FROM forge_proxy_journal WHERE id = ?").get(id) as RawForgeProxyJournalRow | undefined;
    return row ? mapForgeProxyJournalRow(row) : undefined;
  }

  /** Every journal row for one session attempt, sequence order — the fake-runner integration
   *  tests' "did the whole call sequence get journaled correctly" read, and the primitive a
   *  future final-output-acceptance gate would query (issue #234 AC: "final-output acceptance
   *  blocked while any delivered response lacks a journal row" — no consumer wires that gate in
   *  this PR; see journalIsComplete in proxy/journal.ts for the predicate it would use). */
  listForgeProxyJournal(identity: ForgeProxyIdentity): ForgeProxyJournalRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM forge_proxy_journal WHERE round_id = ? AND phase = ? AND role = ? AND session = ? AND attempt = ? ORDER BY seq",
      )
      .all(identity.roundId, identity.phase, identity.role, identity.session, identity.attempt) as unknown as RawForgeProxyJournalRow[];
    return rows.map(mapForgeProxyJournalRow);
  }

  /** #247: every journal row for a SESSION NAME alone (no round/phase/role/attempt filter) — a
   *  fix leg's terminal-reclaim harvest (conductor.ts's reclaimTerminalLane) needs "every
   *  pr_review_threads response this lane's session ever saw" without depending on which
   *  literal `phase`/`attempt` string the caller who minted its proxy used (proxy/mint.ts's
   *  ForgeProxyIdentity.session is the lane name itself, generated fresh per dispatch/resume —
   *  never reused across lanes — so filtering by session alone is exact, not an approximation).
   *  Kept as its own query rather than widening listForgeProxyJournal's signature: that method's
   *  round/phase/role/attempt-scoped contract is exactly what its existing callers (the
   *  budget/completeness readers) need and must keep.
   *
   *  `afterId` (D2, Codex sol-high PR #265 review round 1, P1; replaced with a monotonic ROW ID
   *  cursor in review round 2, F1 — a wall-clock `requestedAt` cutoff admitted an equal-
   *  timestamp prior-leg row, and a cursor captured AFTER resume() confirmed the spawn could
   *  postdate a fast child's genuinely-first tool call): a lane's SESSION NAME persists across
   *  every fix round on it (startFixLeg reuses the same worker row/lane), so session alone would
   *  conflate every round's journal rows together — an EARLIER round's threadId could then
   *  validate a LATER round's structured output. When supplied, only rows with `id > afterId`
   *  are returned (fix-response.ts's fixLegJournalCursor supplies the round's own captured
   *  pre-resume cursor — State.maxForgeProxyJournalId, read BEFORE that round's resume() call
   *  ever runs, so it can never postdate the round's own first journal row) — omit it for the
   *  pre-#247-D2 unscoped read (no production caller does; kept optional so existing tests of
   *  the session-only contract keep working unchanged). */
  listForgeProxyJournalForSession(session: string, afterId?: number): ForgeProxyJournalRow[] {
    const rows = (afterId !== undefined
      ? this.db.prepare("SELECT * FROM forge_proxy_journal WHERE session = ? AND id > ? ORDER BY id").all(session, afterId)
      : this.db
          .prepare("SELECT * FROM forge_proxy_journal WHERE session = ? ORDER BY id")
          .all(session)) as unknown as RawForgeProxyJournalRow[];
    return rows.map(mapForgeProxyJournalRow);
  }

  /** #247 F1: the current max journal row id for `session` — read BEFORE a fix leg's resume()
   *  call ever runs (conductor.ts's startFixLeg / the fixing-continuation resume / the
   *  reconcileDrivingFixIntents adoption path), so it can never postdate that leg's own first
   *  journal row (unlike a wall-clock timestamp captured AFTER resume() confirms the spawn). 0
   *  when the session has no journal rows yet — a valid cursor (not "no cursor"; the caller's
   *  own event-payload lookup is what distinguishes "found a 0 cursor" from "found no cursor-
   *  bearing event at all"). */
  maxForgeProxyJournalId(session: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS maxId FROM forge_proxy_journal WHERE session = ?").get(session) as {
      maxId: number;
    };
    return row.maxId;
  }

  /** Cumulative call count + response bytes already ledgered for this session attempt — the
   *  budget-exhaustion check meters against this (issue #234's Budget: "meter call count +
   *  response bytes against the round ledger machinery" — this table IS that ledger for the
   *  proxy, same SUM-over-a-durable-table shape as spend_ledger's dailySpendUsd/roundSpendSince).
   *
   *  CALLS count EVERY row regardless of status, including 'intent' (#234 F3, PR #252 review,
   *  P1, Codex #2 — reserve-on-intent): journal.ts's runJournaledCall computes remaining budget,
   *  the next seq, and appendForgeProxyJournalIntent in one synchronous stretch with no `await`
   *  between them, so counting 'intent' here closes the concurrent-calls race a
   *  fetched/delivered/error-only count left open (two overlapping tools/call requests could
   *  otherwise both read the same pre-fetch remaining-calls value and both be admitted). A
   *  crashed-before-fetch intent then conservatively consumes one slot forever for that session
   *  attempt — the safe, fail-toward-under-serving direction, not a bug.
   *
   *  BYTES sum `response_bytes` (#234 F4 — explicit UTF-8 byte length, NOT `LENGTH(response_json)`,
   *  which SQLite counts in characters and would under-count a multibyte response) for
   *  'fetched'/'delivered' rows only — an 'error'/'intent' row has no persisted response to
   *  count bytes for. */
  forgeProxyUsage(identity: ForgeProxyIdentity): { calls: number; bytes: number } {
    const row = this.db
      .prepare(
        `SELECT
           COUNT(*) AS calls,
           COALESCE(SUM(response_bytes) FILTER (WHERE status IN ('fetched', 'delivered')), 0) AS bytes
         FROM forge_proxy_journal
         WHERE round_id = ? AND phase = ? AND role = ? AND session = ? AND attempt = ?`,
      )
      .get(identity.roundId, identity.phase, identity.role, identity.session, identity.attempt) as { calls: number; bytes: number };
    return { calls: row.calls, bytes: row.bytes };
  }

  // ── #234: frozen evidence bundles (forge_proxy_bundles, migration 15->16) ────────────────

  /** Where frozen evidence bundle JSON files live on disk — null for an in-memory State (tests),
   *  same convention as roundArtifactMdPath. */
  forgeProxyBundleDir(): string | null {
    return this.dataDir ? join(this.dataDir, "proxy-bundles") : null;
  }

  /** Index one frozen evidence bundle. Idempotent on hash (ON CONFLICT DO NOTHING): the same
   *  content re-persisted (e.g. a retried decision citing an unchanged bundle) is the same
   *  address, not a duplicate row — the FIRST persist's decision_ref/created_at win. */
  recordForgeProxyBundle(row: ForgeProxyBundleRow): void {
    this.db
      .prepare(
        `INSERT INTO forge_proxy_bundles (hash, round_id, phase, role, session, decision_ref, byte_size, path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(hash) DO NOTHING`,
      )
      .run(
        row.hash,
        row.identity.roundId,
        row.identity.phase,
        row.identity.role,
        row.identity.session,
        row.decisionRef,
        row.byteSize,
        row.path,
        row.createdAt,
      );
  }

  /** One bundle by content hash — undefined if never indexed. */
  getForgeProxyBundle(hash: string): ForgeProxyBundleRow | undefined {
    const row = this.db.prepare("SELECT * FROM forge_proxy_bundles WHERE hash = ?").get(hash) as
      | {
          hash: string;
          round_id: number;
          phase: string;
          role: string;
          session: string;
          decision_ref: string | null;
          byte_size: number;
          path: string | null;
          created_at: string;
        }
      | undefined;
    if (!row) return undefined;
    return {
      hash: row.hash,
      identity: { roundId: row.round_id, phase: row.phase, role: row.role, session: row.session },
      decisionRef: row.decision_ref,
      byteSize: row.byte_size,
      path: row.path,
      createdAt: row.created_at,
    };
  }
}

interface RawForgeProxyJournalRow {
  id: number;
  round_id: number;
  phase: string;
  role: string;
  session: string;
  attempt: number;
  seq: number;
  tool: string;
  proxy_version: string;
  args_json: string;
  scope_json: string;
  caps_json: string;
  budget_remaining_calls: number | null;
  budget_remaining_bytes: number | null;
  status: ForgeProxyJournalStatus;
  upstream_ids_json: string | null;
  upstream_updated_at: string | null;
  counts_json: string | null;
  truncated: number;
  response_json: string | null;
  response_bytes: number | null;
  content_hash: string | null;
  error: string | null;
  timed_out: number;
  requested_at: string;
  fetched_at: string | null;
  delivered_at: string | null;
}

function mapForgeProxyJournalRow(r: RawForgeProxyJournalRow): ForgeProxyJournalRow {
  return {
    id: r.id,
    identity: { roundId: r.round_id, phase: r.phase, role: r.role, session: r.session, attempt: r.attempt },
    seq: r.seq,
    tool: r.tool,
    proxyVersion: r.proxy_version,
    argsCanonical: r.args_json,
    scopeCanonical: r.scope_json,
    capsCanonical: r.caps_json,
    budgetRemainingCalls: r.budget_remaining_calls,
    budgetRemainingBytes: r.budget_remaining_bytes,
    status: r.status,
    upstreamIds: r.upstream_ids_json,
    upstreamUpdatedAt: r.upstream_updated_at,
    countsCanonical: r.counts_json,
    truncated: r.truncated === 1,
    responseCanonical: r.response_json,
    responseBytes: r.response_bytes,
    contentHash: r.content_hash,
    error: r.error,
    timedOut: r.timed_out === 1,
    requestedAt: r.requested_at,
    fetchedAt: r.fetched_at,
    deliveredAt: r.delivered_at,
  };
}

interface RawPendingThreadWrite {
  id: number;
  worker: string;
  issue: number;
  pr: number;
  thread_id: string;
  reply: string;
  resolution: "addressed" | "disputed";
  reply_posted: number;
  resolved: number;
  attempts: number;
  batch_key: string;
  fix_rounds: number;
  created_at: string;
  last_attempt_at: string | null;
}

function mapPendingThreadWrite(r: RawPendingThreadWrite): PendingThreadWrite {
  return {
    id: r.id,
    worker: r.worker,
    issue: r.issue,
    pr: r.pr,
    threadId: r.thread_id,
    reply: r.reply,
    resolution: r.resolution,
    replyPosted: r.reply_posted === 1,
    resolved: r.resolved === 1,
    attempts: r.attempts,
    batchKey: r.batch_key,
    fixRounds: r.fix_rounds,
    createdAt: r.created_at,
    lastAttemptAt: r.last_attempt_at,
  };
}
