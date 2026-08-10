// Durable engine state. Replaces the predecessor project's non-atomic jq read-modify-write
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
import { capDigest } from "../retro/retro-digest.js";
import type { AcceptanceCriterion, AcSnapshot } from "../review/ac-snapshot.js";
import type { EventKind, KindGlossary } from "./event-kinds/index.js";
import type { EventPayloadFor, EventPayloads, PayloadTypedKind } from "./event-kinds/payloads.js";

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
  // 26 -> 27 (#374): a park episode's OPTIONAL reset-time hint — the Claude CLI's own structured
  // rate-limit telemetry (worker.ts's extractRateLimitResetAt / peripheral.ts's RoleSessionResult
  // .rateLimitResetAtMs) can name the EXACT instant quota resets, strictly better scheduling
  // information than the bounded exponential backoff alone (env-failure.ts's probeDueWithHint).
  // Nullable, set ONCE at park entry (State.enterPark's optional 5th argument) and never
  // overwritten thereafter — same "first detection wins" stance entered_at/reason already take
  // (a storm of classified failures for the SAME episode must not keep moving either the
  // escalation clock OR this hint). A pre-#374 row simply has NULL here, which
  // probeDueWithHint treats identically to "no hint was ever observed" — the existing backoff
  // schedule, unchanged.
  (db) => {
    db.exec(`ALTER TABLE park_state ADD COLUMN reset_hint_at TEXT;`);
  },
  // 27 -> 28 (#431, owner amendment 1): the rapid-restart detector parks through the SAME
  // park_state machinery as the environment sources (existing paradigm, never a new refusal
  // mode), so the source CHECK gains its third member. SQLite cannot ALTER a CHECK constraint —
  // recreate-and-copy, preserving every column and the PRIMARY KEY. Caught by construction in
  // this PR's own tests: enterPark is INSERT OR IGNORE, so the old CHECK swallowed a
  // 'rapid-restart' row SILENTLY (changes = 0) rather than erroring — the fail-open shape this
  // repo's doctrine exists to hunt.
  (db) => {
    db.exec(`
      CREATE TABLE park_state_new (
        source         TEXT PRIMARY KEY CHECK (source IN ('llm', 'forge', 'rapid-restart')),
        reason         TEXT NOT NULL,
        trigger_issue  INTEGER,
        entered_at     TEXT NOT NULL,
        last_probe_at  TEXT NOT NULL,
        probe_attempts INTEGER NOT NULL DEFAULT 0,
        escalated_at   TEXT,
        canary_worker  TEXT,
        reset_hint_at  TEXT
      );
      INSERT INTO park_state_new SELECT source, reason, trigger_issue, entered_at, last_probe_at,
        probe_attempts, escalated_at, canary_worker, reset_hint_at FROM park_state;
      DROP TABLE park_state;
      ALTER TABLE park_state_new RENAME TO park_state;
    `);
  },
  // 28 -> 29 (#407): the consecutive-stall breaker (loop/stall-breaker.ts) parks through the
  // same park_state machinery — the source CHECK gains its fourth member, by the same
  // recreate-and-copy the 27->28 migration used and for the same silent-INSERT-OR-IGNORE
  // reason documented there.
  (db) => {
    db.exec(`
      CREATE TABLE park_state_new (
        source         TEXT PRIMARY KEY CHECK (source IN ('llm', 'forge', 'rapid-restart', 'consecutive-stalls')),
        reason         TEXT NOT NULL,
        trigger_issue  INTEGER,
        entered_at     TEXT NOT NULL,
        last_probe_at  TEXT NOT NULL,
        probe_attempts INTEGER NOT NULL DEFAULT 0,
        escalated_at   TEXT,
        canary_worker  TEXT,
        reset_hint_at  TEXT
      );
      INSERT INTO park_state_new SELECT source, reason, trigger_issue, entered_at, last_probe_at,
        probe_attempts, escalated_at, canary_worker, reset_hint_at FROM park_state;
      DROP TABLE park_state;
      ALTER TABLE park_state_new RENAME TO park_state;
    `);
  },
  // 29 -> 30 (#398): WHICH object the escalation's needs-human label was written on. #147's
  // reentry handshake is "the label the engine provably applied is now ABSENT" — and #398 moves
  // the label for a PR-BORN escalation off the issue and onto the PR (the object the merge gate
  // already reads, and the object a human is actually looking at when they decide the finding is
  // addressed). Absence therefore has to be checked on the object the write went to, so the
  // engine has to remember which one that was: with only `gated_escalation_labeled` to go on, a
  // pre-#398 row (label on the ISSUE) and a post-#398 row (label on the PR) are the same shape —
  // `failed` + pr + marker 1 — and reading the PR's labels for BOTH would see nothing on every
  // legacy row and re-admit it with no human act at all.
  //
  // DEFAULT 'issue' IS THE CUTOVER, and it is the fail-closed direction. Every row that existed
  // before this migration was escalated by the pre-#398 code, which wrote the ISSUE — so the
  // default describes them accurately rather than approximating them, and no backfill is needed
  // or possible (nothing in the ledger could distinguish a carrier that had only one value).
  // Every escalation path that sets `gated_escalation_labeled = 1` now sets this column
  // explicitly in the same write, so a lane that escalates on the PR, is reclaimed, and later
  // re-escalates through an ISSUE-writing path cannot keep a stale 'pr' carrier.
  (db) => {
    db.exec(`ALTER TABLE workers ADD COLUMN gated_escalation_carrier TEXT NOT NULL DEFAULT 'issue';`);
  },
  // 30 -> 31 (#470): the idle-churn breaker (loop/idle-churn.ts) parks through the same
  // park_state machinery — the source CHECK gains its fifth member, by the same
  // recreate-and-copy the 27->28 and 28->29 migrations used and for the same silent-
  // INSERT-OR-IGNORE reason documented there (enterPark is INSERT OR IGNORE, so an unlisted
  // source is swallowed with changes = 0 rather than raising — the fail-open shape this repo's
  // doctrine hunts).
  (db) => {
    db.exec(`
      CREATE TABLE park_state_new (
        source         TEXT PRIMARY KEY CHECK (source IN ('llm', 'forge', 'rapid-restart', 'consecutive-stalls', 'idle-churn')),
        reason         TEXT NOT NULL,
        trigger_issue  INTEGER,
        entered_at     TEXT NOT NULL,
        last_probe_at  TEXT NOT NULL,
        probe_attempts INTEGER NOT NULL DEFAULT 0,
        escalated_at   TEXT,
        canary_worker  TEXT,
        reset_hint_at  TEXT
      );
      INSERT INTO park_state_new SELECT source, reason, trigger_issue, entered_at, last_probe_at,
        probe_attempts, escalated_at, canary_worker, reset_hint_at FROM park_state;
      DROP TABLE park_state;
      ALTER TABLE park_state_new RENAME TO park_state;
    `);
  },
  // 31 -> 32 (#676 gate② finding [1], "unscoped-rebaseline"): an AUTHORITATIVE per-episode signal
  // for whether a `failed`+pr row's escalation is one of the two DRIVE checkpoints that consume
  // the AC-authority snapshot (ac-snapshot-drift / comment-cursor-stale) — the only two GATED
  // RECLAIM should ever re-baseline `ac_snapshots`/`ac_body_hash` for. Every OTHER escalation site
  // (fix-rounds cap, review-disputed, fix-leg-undecidable, the #375 drain escalation, ...) sets
  // `gated_escalation_labeled = 1` on the exact same `failed`+pr shape but has nothing to do with
  // the issue body — re-baselining on ANY of those would silently adopt whatever the live body
  // happens to read as newly authoritative, defeating the drift gate for an edit nobody actually
  // adjudicated. DEFAULT 0 is the fail-closed direction: every pre-migration row (and every
  // escalation site this PR doesn't touch) reads as "not eligible", never as a false positive.
  (db) => {
    db.exec(`ALTER TABLE workers ADD COLUMN ac_rebaseline_eligible INTEGER NOT NULL DEFAULT 0;`);
  },
  // 32 -> 33 (#676 gate② finding [1] round 2, "rebaseline-version-unbound"): the TOCTOU close.
  // `ac_rebaseline_eligible` alone answered "was this escalation about the AC snapshot" but not
  // "is the body GATED RECLAIM is about to trust the SAME one a human actually looked at" — a
  // producer/body editor could drift the body to v2, have a supervisor inspect v2 and clear
  // needs-human, then replace it with v3 before the reclaim tick actually ran; the engine would
  // silently snapshot v3 and drive on, even though nobody ever adjudicated v3. This column pins
  // the live body's hash AT THE MOMENT `checkAcDriftBeforeDrive` observes the drift that triggers
  // the escalation — the version a human investigating `needs-human` would actually see and is
  // presumed to have reviewed. GATED RECLAIM re-baselines only when the live body at reclaim time
  // STILL matches this pinned hash; any further edit refuses the silent adopt and falls through to
  // the ordinary drift re-check instead, forcing a fresh human look at whatever is live NOW. NULL
  // is the fail-OPEN value used only where a pin is structurally impossible (a missing-snapshot or
  // ownership-mismatch anomaly, which never read a live body to pin at all — the existing
  // ownership guard already refuses to re-baseline those) or genuinely not the right model
  // (`checkCommentCursorBeforeDrive`'s comment-cursor-stale escalation, whose remediation IS a
  // human's own post-escalation body edit — see that function's own doc for why pinning there
  // would defeat #676's original fix instead of hardening it).
  //
  // #685 (gate② finding [1] round 3, "null-pin-anything"): that NULL-for-comment-cursor-stale
  // case was itself later found to leave a silent-adopt hole GATED RECLAIM's reclaim loop (not a
  // further schema change — no new migration) now closes by staging a candidate INTO this same
  // column at reclaim time instead of trusting an unpinned NULL outright. See this column's own
  // WorkerRow field doc for the current, non-historical picture.
  (db) => {
    db.exec(`ALTER TABLE workers ADD COLUMN ac_rebaseline_candidate_hash TEXT;`);
  },
  // 33 -> 34 (#645): durable spend attribution. Every settled `spend_ledger` row can now carry
  // WHICH KIND of session earned it (`actor_kind`: worker/fix-leg/peripheral-role/engine-review,
  // see the `SpendActorKind` doc), the peripheral ROLE id where applicable, and whether the
  // settled `usd` came from a pinned-price ESTIMATE rather than the provider's own reported
  // total (`estimated`, 0/1) — the est-vs-real bias series #645's issue names can then be
  // computed by query instead of hand arithmetic. All three are NULLABLE with no default and no
  // backfill: a row written before this migration has no attribution to recover (nothing in the
  // ledger could reconstruct it), so it reads NULL/`unclassified` forever — the same "never
  // guess" stance spendSummaryForDay's own doc already takes for its interim unclassified
  // bucket. A CHECK constraint is deliberately omitted (this codebase's convention for a plain
  // `ADD COLUMN`, see e.g. the v29->v30 carrier column) — validity is a TS union
  // (`SpendActorKind`) plus state.test.ts's write-site sweep test, not a DB constraint.
  (db) => {
    db.exec(`
      ALTER TABLE spend_ledger ADD COLUMN actor_kind TEXT;
      ALTER TABLE spend_ledger ADD COLUMN role TEXT;
      ALTER TABLE spend_ledger ADD COLUMN estimated INTEGER;
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

/** True when a SQLite error means "another connection holds a lock this read couldn't get past
 *  within its busy_timeout" (#642: `sapwood events`'/`status --json`'s structured busy-error
 *  contract). SQLITE_BUSY is primary code 5; the extended variants (SQLITE_BUSY_RECOVERY = 261,
 *  SQLITE_BUSY_SNAPSHOT = 517) both mask to the same primary byte. Same errcode-then-message-
 *  fallback shape as isReadOnlyFsError above, for the same "node:sqlite doesn't always attach a
 *  numeric code" reason. */
function isBusyError(e: unknown): boolean {
  const code = (e as { errcode?: unknown }).errcode;
  if (typeof code === "number") return (code & 0xff) === 5 /* SQLITE_BUSY */;
  return /database is locked|busy/i.test(String((e as { message?: unknown }).message ?? ""));
}

/** #642: the structured failure a read-only caller (`sapwood events`, `status --json`) gets
 *  when a writer holds the DB locked past `timeoutMs` — a NAMED error class instead of the raw
 *  node:sqlite message, so a CLI catch site can render a clean "busy, try again" line (and a
 *  `--json` caller can emit `{error: {kind: "busy", timeoutMs}}`) rather than a stack trace.
 *  Never thrown by a WRITE-mode State (single-writer-serial via the instance lock, #382) — only
 *  the readOnly open/query path below constructs one. */
export class SqliteBusyError extends Error {
  readonly kind = "busy" as const;
  constructor(
    readonly timeoutMs: number,
    cause: unknown,
  ) {
    super(`sapwood: database busy — a writer held the lock for longer than the ${timeoutMs}ms busy timeout`);
    this.name = "SqliteBusyError";
    this.cause = cause;
  }
}

/** #642: the default finite busy timeout every readOnly State open applies (via `PRAGMA
 *  busy_timeout`) before this module's own probe read. Finite and non-zero on purpose: 0 (the
 *  SQLite default) fails on the FIRST instant of contention with a live engine's own
 *  single-statement writes, which are typically sub-millisecond — a short wait absorbs that
 *  ordinary race instead of surfacing it as an error every time a poller's tick lands mid-write.
 *  Callers that need a SHORTER, deterministic window for testing (proving the busy path without
 *  a real multi-second wait) pass `busyTimeoutMs` explicitly — see state.test.ts's locking
 *  fixture. */
export const DEFAULT_READONLY_BUSY_TIMEOUT_MS = 2000;

/** Open a DB read-only for `sapwood status`/`sapwood events`. See the State constructor's
 *  readOnly doc for the full rationale; this is factored out so the normal-open-then-immutable-
 *  fallback control flow reads cleanly. Never mutates sapwood state (query_only, no migrations).
 *
 *  #642: returns `immutableFallback` alongside the handle — the constructor stores it so a
 *  caller (status --json's `snapshot.mode`, events' same field) can report the degraded-snapshot
 *  condition STRUCTURALLY instead of only via the stderr line already printed below (kept,
 *  unchanged, for the plain-text callers that predate this). Also sets a finite `busy_timeout`
 *  BEFORE the probe read, so contention with a live writer waits up to `busyTimeoutMs` and
 *  raises the structured SqliteBusyError above instead of either hanging (it can't — the
 *  timeout is finite) or failing on the very first instant of contention (timeout 0). */
function openReadOnly(path: string, isMemory: boolean, busyTimeoutMs: number): { db: DatabaseSync; immutableFallback: boolean } {
  // In-memory handles (tests) have no on-disk file and no WAL sidecar concern, hence no busy
  // contention with a second connection to probe for either.
  if (isMemory) {
    const db = new DatabaseSync(path, { readOnly: true });
    db.exec("PRAGMA query_only = ON");
    return { db, immutableFallback: false };
  }
  try {
    const db = new DatabaseSync(path, { readOnly: true });
    // Local pragmas — never touch the file, so neither can itself raise SQLITE_BUSY. Set BEFORE
    // the probe read below so the probe (the first real file access) is the one that honors it.
    db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.exec("PRAGMA query_only = ON");
    // Probe: forces the -shm access a WAL DB needs, so a read-only-FS failure lands HERE
    // (where we can fall back) rather than later mid-status. On a writable FS this may
    // create SQLite's own -wal/-shm coordination files — acceptable (not sapwood state).
    db.prepare("PRAGMA user_version").get();
    return { db, immutableFallback: false };
  } catch (e) {
    if (isBusyError(e)) throw new SqliteBusyError(busyTimeoutMs, e);
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
    return { db, immutableFallback: true };
  }
}

// running = live worker (probed each reclaim). driving = produced a PR, lane held awaiting
// the review gate (M3) — no live worker, but still occupies a lane. fixing (#245): a driving
// lane's PR needs rework — a LIVE fix-leg worker process (same #172 resume machinery, same
// worktree/branch/session lineage), addressing its own review findings before returning to
// `driving` with a cleared review-trigger pin (see State.fixingWorkers' doc). done/failed/handoff
// = terminal.
export type WorkerState = "running" | "driving" | "fixing" | "done" | "failed" | "handoff";

/** #398: WHICH forge object an escalation's `needs-human` label was written on. The rule adopted
 *  with the owner (2026-07-27 retro) is "the label lives where the escalation was born": a
 *  PR-caused escalation belongs on the PR, an issue-caused one (no PR exists yet, or the fact is
 *  about the work item) on the issue — never both. Persisted per lane because the #147 reentry
 *  handshake reads label ABSENCE, and absence is only meaningful on the object the write went to.
 *  The pure rule that picks one is conductor.ts's `escalationCarrier`. */
export type EscalationCarrier = "issue" | "pr";

/** #705: the `lane-spawned` event payload shape — a lane's live-process identity at the moment
 *  worker.ts's `dispatch()`/`resume()` confirmed a NEW child for it. `pid` is `null` for the
 *  cross-restart-adoption branch's own honest "no wrapper_pid on record" case (worker.ts's
 *  `resume()` own doc); `worktreePath` is always known once a spawn fact exists at all — a
 *  `worktreePath: null` fact is never recorded (conductor.ts's `spawnFactFrom` treats an absent
 *  `worktreePath` from the Supervisor as "no fact", never as a fact with a null field). */
export interface LaneSpawnFact {
  worker: string;
  issue: number;
  pid: number | null;
  worktreePath: string;
}

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
  /** #398: WHICH object that label write went to — `"pr"` for a PR-BORN escalation (the label
   *  lives on the PR, where the merge gate reads labels and where the human deciding the lane's
   *  fate is looking), `"issue"` for an issue-born one. GATED RECLAIM checks the absence of the
   *  human-hold labels on THIS object, so the handshake reads the same carrier the escalation
   *  wrote. Meaningful only alongside `gated_escalation_labeled = 1`. Optional; DB default
   *  `"issue"` — the accurate description of every pre-#398 row (see the v29->v30 migration). */
  gated_escalation_carrier?: EscalationCarrier;
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
  /** #676 (schema v31->v32, gate② finding [1]): 1 iff THIS row's most recent `failed` transition
   *  was written by `checkAcDriftBeforeDrive` or `checkCommentCursorBeforeDrive` — the two DRIVE
   *  checkpoints whose escalation is actually ABOUT the AC-authority snapshot (a body/cursor edit
   *  since dispatch). GATED RECLAIM's reclaim branch (conductor.ts) reads this to decide whether
   *  re-baselining `ac_snapshots`/`ac_body_hash` against the live body is warranted — a lane
   *  escalated for any OTHER reason (fix-rounds cap, review-disputed, ...) leaves this 0 and its
   *  snapshot untouched. Reset to 0 on every reclaim REGARDLESS of whether it was 1 (single-use
   *  per episode — see the migration comment for why a stale 1 must never leak into a later,
   *  unrelated escalation on the same row). Optional; DB default 0. */
  ac_rebaseline_eligible?: number;
  /** #676 (schema v32->v33, gate② finding [1] round 2, "rebaseline-version-unbound"): the live
   *  body hash pinned as the version a human investigating `needs-human` is presumed to have
   *  actually reviewed. GATED RECLAIM re-baselines only when the live body at reclaim time STILL
   *  hashes to this value; a further edit (reviewed+cleared, then replaced before the reclaim
   *  tick) refuses the silent adopt instead, so the ordinary drift check re-escalates against
   *  whatever is live now. `ac_rebaseline_eligible` alone still gates whether ANY re-baseline
   *  happens; this column only narrows WHEN one that's otherwise eligible is trusted.
   *
   *  Two writers, both pinning "the body a human is presumed to have reviewed," just at different
   *  moments: `checkAcDriftBeforeDrive` pins it AT ESCALATION time (the drift it just detected).
   *  #685 (gate② finding [1] round 3, "null-pin-anything"): GATED RECLAIM's own reclaim loop
   *  (conductor.ts) now ALSO writes this column — for a row that reaches reclaim with this still
   *  NULL (`checkCommentCursorBeforeDrive`'s comment-cursor-stale escalation, whose remediation IS
   *  a human's own post-escalation body edit, so nothing coherent could be pinned at escalation
   *  time — see that function's own doc), the reclaim loop's FIRST observation of the cleared hold
   *  stages the live body hash it just read INTO this column and defers (no state transition, no
   *  snapshot) rather than trusting that single read outright; only a LATER tick's reconfirmation
   *  against the now-staged value actually reclaims. A `null` pin is therefore transient for that
   *  path now — real ONLY for the one tick between the comment-cursor-stale escalation and the
   *  reclaim loop's own staging write — never a permanent "no check applies" state past that tick.
   *  Reset to NULL on every reclaim that actually consumes it (match or mismatch alike), same
   *  single-use-per-episode lifecycle as `ac_rebaseline_eligible`; left untouched on a staging-only
   *  pass (nothing was consumed yet). Optional; DB default NULL. */
  ac_rebaseline_candidate_hash?: string | null;
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

/** #645: `spend_ledger.actor_kind` — durable attribution of WHICH KIND of session earned a
 *  settled row. `worker`/`fix-leg` come from conductor.ts's reclaim path (a `fixing`-origin
 *  lane vs an ordinary one, `w.state === "fixing"` at settle time); `peripheral-role` from
 *  peripheral.ts's `runSessionWithRetry` (every po-align/po-triage/architect/plan-review/
 *  harvest/retro session); `engine-review` from production.ts's decisive-verdict recordSpend
 *  (#612). Every REAL write site sets this explicitly (state.test.ts's write-site sweep test
 *  pins the full set) — `recordSpend`/`settleTerminalWorker` leave it `undefined` (stored as
 *  SQL NULL) only for callers that never claim a kind (test fixtures seeding unrelated state),
 *  the exact same "never guessed" stance a pre-#645 row gets. The read-model
 *  (spendSummaryForDay) renders a NULL row as `unclassified`, unchanged from before this type
 *  existed. */
export type SpendActorKind = "worker" | "fix-leg" | "peripheral-role" | "engine-review";

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

/** One `spend_ledger` row as the dashboard reads it (State.spendPage, #360) — the stored
 *  columns verbatim, token counts camelCased to match the rest of the §8 wire. #645 P2-2:
 *  `actorKind`/`role`/`estimated` are the SAME three durable-attribution columns
 *  `SpendActorKind`'s own doc describes — this method's doc already claimed "the ledger's own
 *  columns, nothing derived" before #645 added them, and that claim was false until now: the raw
 *  paging transport omitted exactly the columns #645 exists to expose. `actorKind`/`role` are
 *  `null` for an unattributed row (pre-#645, or a caller that never claimed a kind), same
 *  never-guess stance as everywhere else; `estimated` is a genuine three-state (`true`/`false`/
 *  `null` — "unknown/never claimed", not "known to be a real total"), read back off the same
 *  0/1/NULL storage `recordSpend` writes. */
export interface SpendLedgerRow {
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
  actorKind: SpendActorKind | null;
  role: string | null;
  estimated: boolean | null;
}

/** One `rounds` row with its artifact left-joined (State.listRounds, #360). `schemaVersion` and
 *  `artifact` are BOTH null for a round that never got one — the reader's cue to render the
 *  round without an outcome tally rather than to skip it. */
export interface RoundListRow {
  roundId: number;
  status: RoundStatus;
  startedAt: string;
  endedAt: string | null;
  /** #123 cursors, from the ROUNDS row — the replay chapter window. Not artifact fields. */
  startEventId: number;
  startSpendId: number;
  eventCount: number;
  schemaVersion: number | null;
  /** The validated artifact JSON, parsed and verbatim (docs/round-artifact.md is its contract). */
  artifact: unknown;
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

/** #461: one finding response from the audit-comment dissent channel. Unlike a thread write it
 *  enqueues NOTHING — an engine-agent finding has no thread to reply to or resolve, and the engine
 *  never edits its own audit comment — so this rides the receipt event only: an `addressed` entry
 *  for audit completeness, a `disputed` one as the durable record `computeFindingDisputeEscalation`
 *  (loop/fix-response.ts) reads back to route the dispute to a human. */
export interface FixResponseSettleFindingWrite {
  runId: string;
  findingIndex: number;
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
  /** #461: see `FixResponseSettleFindingWrite`. Optional with an empty default — a pre-#461
   *  fixture, and every leg that emits no `findingResponses` block, receipts byte-identically. */
  findingWrites?: FixResponseSettleFindingWrite[];
  /** #451 (design #402 §4/D4): the head this fix round's session actually answered — sourced by
   *  the caller from the lane's OWN `review_triggered_head` (state.ts's WorkerRow), read BEFORE
   *  `settleTerminalWorker`'s own write clears it for a `fixing` lane (reclaimTerminalLane's
   *  `fixingPinClear`). A FIXABLE gate can only be derived once `triggerPin.head ===
   *  status.headOid` (merge-driver.ts's driveOne, the trigger-pin branch above the gate switch),
   *  so this durably records EXACTLY the head the dispute/finding was raised against — the one
   *  fact `review-disputed` escalation needs to tell "still current" from "the PR moved since" and
   *  no live GitHub read can answer (a review thread's `isOutdated` only flags a changed SPAN, not
   *  an unrelated push elsewhere on the PR). `null` only for a pre-#451 fixture/caller that omits
   *  it — treated as "head unknown," which the escalation predicate below reads fail-closed. */
  headOid: string | null;
  /** #490: under reviewer.mode engine-agent, thread writes are STRUCTURALLY absent (findings
   *  arrive as one audit comment, never review threads) — so `count: 0` there must not read like
   *  the F36-era pathological empty fix leg. True marks that shape; the receipt event then also
   *  carries `newHead` so a productive leg is tellable from an empty one. Classic path: false,
   *  and the receipt payload stays byte-identical to its pre-#490 shape. */
  threadless: boolean;
  /** #490: the lane worktree's LOCAL head after the leg (worker.ts's laneWorktreeHead — file
   *  reads, engine-authored, never session prose). Evidence of what the leg produced, not proof
   *  of a push. `null` when unobserved. */
  newHead: string | null;
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

/** #431 (owner amendment 1): everything that can hold a park episode. The two environment
 *  sources above carry probe/canary machinery and auto-resume; `rapid-restart` (the crash-loop
 *  detector, loop/rapid-restart.ts) deliberately has NO probe — it clears only when a later
 *  engine start observes the birth window drained (or a human clears it), so the probe loops
 *  in conductor.ts/round.ts must never treat it as an llm/forge episode. #407:
 *  `consecutive-stalls` (the stall breaker, loop/stall-breaker.ts) is the same shape as
 *  rapid-restart — no probe; it clears only when a later engine start observes the stall
 *  streak broken (or a human clears it). #470: `idle-churn` (the idle-churn breaker,
 *  loop/idle-churn.ts) is probe-less for a different reason than either — there is nothing to
 *  probe, because nothing is broken DOWN HERE: the engine is opening and closing rounds
 *  perfectly, and what needs fixing (a probe signal counting work nothing can consume) is
 *  upstream of anything the engine could re-test. It clears when a human clears it. */
export type ParkSource = EnvFailureSource | "rapid-restart" | "consecutive-stalls" | "idle-churn";

/** #475: every ParkSource as a VALUE, for the `sapwood park clear --source` operand check. The
 *  `satisfies Record<ParkSource, 0>` is the point: adding a sixth source above without listing it
 *  here is a compile error, so the CLI's accepted set can never drift behind the type. */
export const PARK_SOURCES: readonly ParkSource[] = Object.keys({
  llm: 0,
  forge: 0,
  "rapid-restart": 0,
  "consecutive-stalls": 0,
  "idle-churn": 0,
} satisfies Record<ParkSource, 0>) as ParkSource[];

/** #643: the same required-per-kind glossary treatment event-kinds/*.ts gives every `EventKind`,
 *  for `ParkSource` — the same `satisfies Record<ParkSource, ...>` exhaustiveness check
 *  `PARK_SOURCES` above already uses, so a sixth source added without a glossary row is a
 *  compile error here too. `generate-glossary.ts` renders this alongside the event-kind glossary
 *  into the sapwood-event-glossary skill. */
export const PARK_SOURCE_GLOSSARY: Record<ParkSource, KindGlossary> = {
  llm: {
    meaning:
      "the LLM session environment (Claude Code) is failing; carries probe/canary machinery and auto-resumes once the probe or canary succeeds.",
    actionability: "intervene",
  },
  forge: {
    meaning: "the forge (GitHub) environment is failing; carries probe machinery and auto-resumes once the probe succeeds.",
    actionability: "intervene",
  },
  "rapid-restart": {
    meaning:
      "the crash-loop breaker tripped on restart cadence; no probe — clears only when a later engine start observes the birth window drained, or a human clears it.",
    actionability: "intervene",
    see: "#431",
  },
  "consecutive-stalls": {
    // #648 gate② P2 (Codex): an OPEN episode never auto-clears (PR #473 round 3 adjudicated
    // this as the deliberate difference from rapid-restart — stall-breaker.ts's own doc). The
    // streak fold is consulted only to decide whether to open a NEW episode after a later
    // start; it is never itself the clearing signal for an episode already open. Same
    // human-only clearing story as idle-churn below, not rapid-restart above.
    meaning: "the stall breaker (#407) tripped on a run of consecutive stalls; no probe — clears only when a human clears it.",
    actionability: "intervene",
    see: "#407",
  },
  "idle-churn": {
    meaning:
      "the idle-churn breaker (#470) tripped: rounds close cleanly but nothing consumable exists upstream; no probe (nothing downstream is broken to re-test) — clears only when a human clears it.",
    actionability: "intervene",
    see: "#470",
  },
} satisfies Record<ParkSource, KindGlossary>;

/** #168: one environment-failure park episode — ONE ROW PER SOURCE (see the schema v11->v12
 *  migration comment for why per-source rows and why this lives in the state DB, not a file
 *  sentinel). `triggerIssue` is the issue whose lane failure caused this episode, or null.
 *  `canaryWorker` (llm rows only) is the in-flight canary lane's name, or null when no canary
 *  is being tested — see conductor.ts's PARK section for the canary contract. */
export interface ParkRow {
  source: ParkSource;
  reason: string;
  triggerIssue: number | null;
  enteredAt: string;
  /** NOT NULL — initialized to enteredAt at park entry, so the first probe/canary waits a full
   *  base backoff instead of firing immediately (PR #180 review P1-1c). */
  lastProbeAt: string;
  probeAttempts: number;
  escalatedAt: string | null;
  canaryWorker: string | null;
  /** #374: the FIRST-observed reset-time hint for this episode (ISO string), or null when none
   *  was ever supplied to State.enterPark — see the schema v26->v27 migration's doc comment. */
  resetHintAt: string | null;
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

/** The default DB path `sapwood run`/`status` use, exported (#382 round 2, codex finding 3) so
 *  cli.ts can derive the data-dir lock path WITHOUT constructing a State — lock arbitration must
 *  precede the DB open/migration a State construction performs, or a refused second engine
 *  (possibly a newer binary) would migrate the live holder's database on its way to exit 1. */
export const DEFAULT_DB_PATH = "data/sapwood.sqlite";

/** #382: the single-instance lockfile's basename, shared by State.instanceLockPath() below and
 *  cli.ts's pre-State lock-path derivation so the two can never drift. */
export const INSTANCE_LOCK_FILENAME = "sapwood.lock";

/** #451 (gate② P2, PM adjudication): the deterministic-truncation cap on a fix leg's `reply`
 *  prose as it's copied into the `fix-response-queued` receipt event (settleTerminalWorker,
 *  below) — never the `pending_thread_writes` row itself, which stays untouched (that copy is
 *  what actually gets POSTED to GitHub, already bounded by GitHub's own comment-length ceiling).
 *  Design #402 §3 rejected UNbounded prose in the ledger, not prose per se; this event is
 *  append-only, once per fix round per thread, and its purpose is audit evidence, not a
 *  full-fidelity copy — the durable ledger and the live thread are supposed to diverge slightly
 *  in exactly this way (see fix-response.ts's `latestThreadResolutions` doc). A hardcoded
 *  internal safety bound, not a user-tunable digest size (logger.ts's `MAX_MESSAGE_BYTES`
 *  precedent, not the config-key `xMaxChars` convention roles.retro.digestMaxChars/
 *  round.directiveMaxChars use for LLM-context budgets) — this exists to keep one append-only
 *  ledger row's prose bounded, not to trade off prompt budget. Truncation is marked, never
 *  silent (capDigest, retro-digest.ts's shared deterministic-truncation primitive). */
const FIX_RESPONSE_LEDGER_REPLY_MAX_CHARS = 4_000;

export class State {
  private readonly db: DatabaseSync;
  // The on-disk directory holding this engine's data (sqlite + sentinels). null for the
  // in-memory handles tests use — there is no directory to watch, so the kill switch is
  // always inactive there (tests inject their own via a real tmp-dir State instead).
  private readonly dataDir: string | null;
  // #642: true iff this readOnly handle took openReadOnly's immutable-fallback branch (a
  // read-only filesystem, so live WAL frames are not visible). Always false for a write-mode
  // handle. Surfaced via isImmutableSnapshot() so a caller can report the degraded-snapshot
  // condition structurally (status --json / events --json's `snapshot.mode`), not only via the
  // stderr line openReadOnly already prints.
  private readonly immutableFallback: boolean;
  // #642: the busy_timeout this handle's readOnly open applied (or DEFAULT_READONLY_BUSY_TIMEOUT_MS
  // for a write-mode handle, which never hits this path — recorded anyway so SqliteBusyError's
  // message is always accurate about the timeout that actually elapsed). eventsPageFiltered
  // reads it back when re-raising a busy error it catches mid-query (a SECOND contention window,
  // not the constructor's own probe).
  private readonly readBusyTimeoutMs: number;

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
  constructor(path = DEFAULT_DB_PATH, opts: { readOnly?: boolean; busyTimeoutMs?: number } = {}) {
    // SQLite won't create missing parent dirs, and data/ is gitignored (absent on a
    // fresh checkout). Create it first. (Codex P2, PR #22.) Skip for special handles.
    const isMemory = path === ":memory:" || path.startsWith("file::memory:");
    this.dataDir = isMemory ? null : dirname(path);
    if (opts.readOnly) {
      this.readBusyTimeoutMs = opts.busyTimeoutMs ?? DEFAULT_READONLY_BUSY_TIMEOUT_MS;
      const opened = openReadOnly(path, isMemory, this.readBusyTimeoutMs);
      this.db = opened.db;
      this.immutableFallback = opened.immutableFallback;
      return;
    }
    this.immutableFallback = false;
    this.readBusyTimeoutMs = DEFAULT_READONLY_BUSY_TIMEOUT_MS;
    if (this.dataDir) {
      mkdirSync(this.dataDir, { recursive: true });
    }
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.migrate();
  }

  /** #642: true iff this handle is a stale, read-only-filesystem snapshot (openReadOnly's
   *  immutable fallback) — live WAL frames from a currently-running engine are NOT visible, so a
   *  reader (status --json / events --json) should say so structurally rather than presenting
   *  the read as equivalent to a normal live-WAL-aware open. Always false for a write-mode
   *  handle (it never takes that branch). */
  isImmutableSnapshot(): boolean {
    return this.immutableFallback;
  }

  /** #642 (Codex gate② round-1 P1 finding 2): normalizes ANY raw SQLITE_BUSY raised while
   *  running `fn` into the structured SqliteBusyError — not just the constructor's own open-
   *  time probe, or a method (eventsPageFiltered, spendSummaryForDay) that already wraps
   *  itself in readTransaction below. A lock acquired by ANOTHER connection AFTER this handle
   *  successfully opened can surface on literally any LATER read — userVersion(),
   *  activeWorkers(), dailySpendUsd(), maxEventId(), any of them — and a caller (cli.ts's
   *  runStatus/runEvents) must not have to special-case every individual State method it
   *  happens to call. Wrap the WHOLE read sequence in one call to this instead.
   *
   *  Already-normalized errors (thrown by a nested readTransaction call) pass through
   *  unchanged — checked FIRST, so they are never double-wrapped: a SqliteBusyError's own
   *  message contains the word "busy", which would otherwise re-match isBusyError's message-
   *  fallback regex and produce a second SqliteBusyError with a different (outer) timeoutMs,
   *  corrupting the original. */
  withBusyNormalization<T>(fn: () => T): T {
    try {
      return fn();
    } catch (e) {
      if (e instanceof SqliteBusyError) throw e;
      if (isBusyError(e)) throw new SqliteBusyError(this.readBusyTimeoutMs, e);
      throw e;
    }
  }

  /** #642 (Codex gate② round-1 P1 findings 1 + 3): BEGIN a short-lived read transaction, run
   *  `fn`, COMMIT — so every read `fn` performs sees ONE consistent snapshot, and any
   *  SQLITE_BUSY along the way is normalized into SqliteBusyError. Used by every method that
   *  needs MORE THAN ONE read to agree with each other (eventsPageFiltered's page + ledger-
   *  tail, spendSummaryForDay's settled/unclassified split + their sum) — see each call site's
   *  own doc for why THAT pair specifically needs one snapshot. Rolls back on any error (a
   *  read-only handle never needs the write a COMMIT would imply; ROLLBACK after a failed
   *  BEGIN is a harmless no-op, never masking the real error). */
  private readTransaction<T>(fn: () => T): T {
    try {
      this.db.exec("BEGIN");
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* BEGIN itself may be what threw (e.g. SQLITE_BUSY before any transaction opened) — a
           ROLLBACK with nothing open is a harmless no-op error, never masks the real one below */
      }
      if (isBusyError(e)) throw new SqliteBusyError(this.readBusyTimeoutMs, e);
      throw e;
    }
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
            gated_escalation_carrier,
            resume_attempts, resume_capped, fix_rounds, fixing_handoff, ac_body_hash,
            ac_rebaseline_eligible, ac_rebaseline_candidate_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
           gated_escalation_carrier = excluded.gated_escalation_carrier,
           resume_attempts = excluded.resume_attempts,
           resume_capped = excluded.resume_capped,
           fix_rounds = excluded.fix_rounds,
           fixing_handoff = excluded.fixing_handoff,
           ac_body_hash = excluded.ac_body_hash,
           ac_rebaseline_eligible = excluded.ac_rebaseline_eligible,
           ac_rebaseline_candidate_hash = excluded.ac_rebaseline_candidate_hash`,
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
        row.gated_escalation_carrier ?? "issue",
        row.resume_attempts ?? 0,
        row.resume_capped ?? 0,
        row.fix_rounds ?? 0,
        row.fixing_handoff ?? 0,
        row.ac_body_hash ?? null,
        row.ac_rebaseline_eligible ?? 0,
        row.ac_rebaseline_candidate_hash ?? null,
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

  /** #645 P1-1: the engine-review decisive verdict's announcing event (production.ts's
   *  ENGINE_REVIEW_VERDICT), its WAL `decisive_outcome` write, and — when this run captured a
   *  validated artifact — its review session's settled spend, in ONE sqlite transaction. Same
   *  shape (and reason) as `settleTerminalWorker`/`upsertWorkerWithEvent` above.
   *
   *  Before this, production.ts's `recordWalDecisiveOutcome` did these as separate writes: the
   *  verdict event FIRST (via `appendEvent`, whose existence `runEventRecorded` reads back as
   *  "this runId is already handled" — the SAME dedup memory a replay consults), then
   *  `recordEngineReviewWalDecisiveOutcome`, then (if the artifact was available) `recordSpend`
   *  LAST. A crash between the first write and the last left the verdict event durably recorded
   *  while spend_ledger never got its row — and because the event's own existence is what a
   *  replay reads as "already recorded, do nothing", that missing spend could never be
   *  recovered: permanently, silently omitted from every ledger-based report (`dailyBudgetUsd`/
   *  `roundBudgetUsd` alike).
   *
   *  Bundling the three writes makes that partial state unrepresentable: either everything here
   *  lands, or (a thrown error anywhere inside) nothing does — so a replay of the SAME runId is
   *  either a clean no-op (the caller's own `runEventRecorded` pre-check reads true and skips
   *  calling this at all) or a fresh, complete attempt, never a half-recorded one.
   *
   *  `verdictKind`/`verdictPayload` are the caller's own event shape — this method does not
   *  interpret them, only appends them atomically with the rest (same `payload: unknown` seam
   *  `upsertWorkerWithEvent` uses). `spend` is omitted when this run's artifact was never
   *  captured — production.ts's own never-fabricate stance, unchanged by this refactor. */
  recordEngineReviewVerdictAndSpend(
    worker: string,
    runId: string,
    outcome: "approved" | "rejected",
    verdictKind: EventKind,
    verdictPayload: unknown,
    spend?: {
      worker: string;
      issue: number;
      usd: number;
      at: string;
      models?: ModelUsageEntry[];
      actorKind?: SpendActorKind;
      role?: string;
      estimated?: boolean;
    },
  ): void {
    this.db.exec("BEGIN");
    try {
      this.appendEvent(verdictKind, verdictPayload);
      this.recordEngineReviewWalDecisiveOutcome(worker, runId, outcome);
      if (spend) {
        this.recordSpend(spend.worker, spend.issue, spend.usd, spend.at, spend.models ?? [], spend.actorKind, spend.role, spend.estimated);
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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

  /** #391 (F19): rows that would be gated-reentry candidates but for `gated_escalation_labeled
   *  = 0` — the 2026-07-24 quota-storm residue. The reclaim-failed/env-era escalation paths
   *  never set that marker, so `gatedFailedWorkers()` excludes these forever and NO human action
   *  (including removing needs-human) can ever wake them; recovery took a direct sqlite UPDATE.
   *  Startup's audit (loop/reconcile.ts's auditGatedEscalationFlags) reads this set, checks each
   *  issue's LIVE labels, and corrects the marker only where the hold is observably present —
   *  never fabricating the "the engine provably applied the label" proof gatedFailedWorkers
   *  depends on. Deliberately the exact complement of gatedFailedWorkers' predicate on that one
   *  column, so a row is in exactly one of the two sets. */
  unlabeledGatedWorkers(): WorkerRow[] {
    return this.db
      .prepare(
        "SELECT * FROM workers WHERE state = 'failed' AND pr IS NOT NULL AND gated_reentry_capped = 0 AND gated_escalation_labeled = 0 ORDER BY name",
      )
      .all() as unknown as WorkerRow[];
  }

  /** #384 (F12): lanes that ended TERMINALLY with no PR of their own on record — the entire
   *  local precondition for an orphaned engine PR. A lane only ever gets its `pr` column written
   *  at the running->driving transition (or the DEAD-with-PR rescue), so a terminal row with a
   *  NULL `pr` is exactly the shape of a lane the engine lost track of before it could associate
   *  what the worker had already pushed — the live 2026-07-24 case (lane #207 `failed`, pr NULL,
   *  PR #365 open and unowned for the rest of the run).
   *
   *  Deliberately DISJOINT from `gatedFailedWorkers`/`unlabeledGatedWorkers` above on the same
   *  one column: a `failed` row that DOES carry a pr is already some other path's property
   *  (gated reentry, #447 revival), and this set must never create a second owner for it.
   *  `done` is included for the same reason `failed` is — reclaim-done's own no-PR branch is a
   *  standing attention item, and a merged lane always carries the pr it merged. */
  terminalPrlessWorkers(): WorkerRow[] {
    return this.db
      .prepare("SELECT * FROM workers WHERE state IN ('failed', 'done') AND pr IS NULL ORDER BY name")
      .all() as unknown as WorkerRow[];
  }

  /** #384 (F12): every PR number ANY worker row currently holds, in any state — the "somebody
   *  already owns this PR" set the mid-run orphan sweep subtracts before it matches anything.
   *  Deliberately state-blind (the same `ownedPrs` concept `diffStartupOrphans` builds from its
   *  own row snapshot): a `driving` lane's PR, a gated-reentry lane's PR and a merged lane's PR
   *  are all equally not-an-orphan, and the sweep must never hand a second owner a PR one of
   *  those paths is already driving. */
  ownedPrNumbers(): number[] {
    return (this.db.prepare("SELECT DISTINCT pr FROM workers WHERE pr IS NOT NULL").all() as { pr: number }[]).map((r) => r.pr);
  }

  /** #425: `kind` is the closed union derived from the central registry (`state/event-kinds/`) —
   *  an undeclared kind is a typecheck failure, not a row nobody ever reads. `payload` is
   *  `unknown` for every kind EXCEPT the handful with a declared payload type (payloads.ts's
   *  `EventPayloadFor`), where writer and reader share one shape. Compile-time only: this method
   *  still stringifies whatever it is handed, with no runtime validation on the append path. */
  appendEvent<K extends EventKind>(kind: K, payload: EventPayloadFor<K>): void {
    // #403 (F25) per-site decision: DELIBERATE wall-clock read, left as-is. `events.ts` answers
    // "when did the engine actually do this", so the honest source is the machine's clock at the
    // moment of the write — a seeded clock here would make the audit trail lie.
    //
    // PR #430 gate② P2 corrected the reasoning that used to sit here. Round 1 of this PR claimed
    // the `ts` was "never read back as a decision input"; that was FALSE. `eventsSince` filters
    // `WHERE ts >= ?`, and retro.ts/retro-digest.ts passed `round.started_at` — an INJECTED-clock
    // value — into it, so the two clocks were in fact compared, and a divergence between them
    // (a seeded round date, a backward host clock step) silently emptied the round's retro.
    // The fix was not to seed this write but to stop comparing clocks at all: those three readers
    // now use `eventsAfterId(round.start_event_id)`, the id cursor #123 added for precisely this
    // reason. So the claim holds now BY CONSTRUCTION rather than by assertion — every round-scoped
    // event read is id-ordered and id-bounded, and the remaining `eventsSince` callers pass an
    // epoch/"all time" sentinel that compares nothing. See eventsSince's own doc below.
    this.db.prepare("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)").run(new Date().toISOString(), kind, JSON.stringify(payload));
  }

  /** #294: the kind of the most recent hold-visibility event for `worker`'s lane, or null if
   *  the lane has never been held — tick()'s dedup source for the transition-only hold events,
   *  the same event-log-as-memory pattern `lastReviewerFallbackEvent` uses below (#169: dedupe
   *  the EVENT, not the signal). MergeDriver observes the hold label live on every gate pass and
   *  has no memory of its own, so the durable log is what makes an episode edge detectable:
   *  announce `pr-held` only when this is not already 'pr-held', `pr-released` only when it is.
   *  Being on-disk is what makes it crash-consistent — a kill -9 between the observation and the
   *  next tick re-reads the same answer and re-emits nothing. */
  lastHoldEvent(worker: string, pr: number): "pr-held" | "pr-released" | null {
    // #294 (Codex P2, PR #372): scoped to (worker, pr), not worker alone — a lane name
    // reassigned to a new issue/PR must not inherit the prior PR's hold episode (a stale
    // 'pr-held' would suppress the new PR's first held announcement, and an unheld new PR
    // would emit a spurious 'pr-released' carrying the new PR number). Bounded blind spot,
    // accepted: a PR still held when its lane is repointed never gets a closing 'pr-released'
    // — the episode simply ends with the last durable 'pr-held' on record.
    const row = this.db
      .prepare(
        `SELECT kind FROM events
         WHERE kind IN ('pr-held', 'pr-released')
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.pr') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(worker, pr) as { kind: string } | undefined;
    return row?.kind === "pr-held" || row?.kind === "pr-released" ? row.kind : null;
  }

  /** #441: the kind of the LATEST event among `kinds` for this exact (worker, issue), or null if
   *  none exists — the issue-scoped twin of `lastHoldEvent`, generalized over a caller-supplied
   *  kind set because the RESUME phase's episode boundary is "any of several outcomes", not one
   *  pair. Same event-log-as-memory contract (#169/#294): the caller re-derives its observation
   *  statelessly every tick and asks this whether the current episode was already announced, so a
   *  `kill -9` between the observation and the next tick re-reads the same answer and re-emits
   *  nothing.
   *
   *  Scoped to (worker, issue), not (worker, pr): the RESUME phase's events precede any PR for an
   *  ordinary lane, and a lane name reassigned to a new ISSUE must not inherit the prior issue's
   *  episode — same rationale `lastHoldEvent` gives for its own (worker, pr) scope. LATEST-wins,
   *  so it is for facts a later event reverses; use `laneEventRecorded` for one-way ones. */
  latestLaneEventKind(kinds: readonly string[], worker: string, issue: number): string | null {
    if (kinds.length === 0) throw new Error("latestLaneEventKind: kinds must be non-empty");
    const row = this.db
      .prepare(
        `SELECT kind FROM events
         WHERE kind IN (${kinds.map(() => "?").join(", ")})
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.issue') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(...kinds, worker, issue) as { kind: string } | undefined;
    return row?.kind ?? null;
  }

  /** #447: has an event of `kind` EVER been recorded for this exact (worker, pr)? The two facts
   *  loop/reconcile.ts's lane revival must remember across ticks — "#397 already settled this PR
   *  as bucket 2" and "this lane's PR was observed MERGED/CLOSED" — are both ONE-WAY, and this
   *  is how the pass remembers them: event-log-as-memory, the #169/#294 pattern, with no new
   *  column and no new table.
   *
   *  ONLY FOR ONE-WAY FACTS. `EXISTS`, not "latest", so nothing can un-record one — that is what
   *  makes the answer ordering-free (no ranking against other terminal kinds), and it is exactly
   *  wrong for any fact a later event can reverse; use `lastHoldEvent`'s latest-wins shape for
   *  those. Scoped to (worker, pr) for the same reason `lastHoldEvent` is: a lane name
   *  reassigned to a new PR must not inherit the prior PR's verdict. */
  laneEventRecorded(kind: string, worker: string, pr: number): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM events
         WHERE kind = ?
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.pr') = ?
         LIMIT 1`,
      )
      .get(kind, worker, pr);
    return row != null;
  }

  /** #489: has an event of `kind` already been appended for this exact (worker, engine-review
   *  runId)? The dedup memory for the LOG-FIRST engine-review verdict event — same
   *  event-log-as-memory pattern as `laneEventRecorded` above (#169/#294), and ONE-WAY for the
   *  same reason: a run reaches a decisive outcome exactly once, and nothing later un-decides it.
   *
   *  Keyed by runId rather than by pr: a lane legitimately reaches SEVERAL decisive verdicts on
   *  the same PR (one per head / fix round), so a (worker, pr) key would suppress every verdict
   *  after the first. The runId is engine-authored (`newRunId`), never derived from session prose,
   *  and is the same identity the WAL row and the audit-comment marker carry. */
  runEventRecorded(kind: string, worker: string, runId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM events
         WHERE kind = ?
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.runId') = ?
         LIMIT 1`,
      )
      .get(kind, worker, runId);
    return row != null;
  }

  /** #447: one worker-row write and the event announcing it, in ONE sqlite transaction — the
   *  same shape (and the same reason) as `settleTerminalWorker` above. A recovery pass that
   *  moves a lane must not be able to leave the move without its record: the row would be
   *  `driving` with nothing in the ledger saying who moved it or why, and a pass whose own
   *  skip-decisions are read back OUT of that ledger (see `laneEventRecorded`) would then be
   *  reasoning from an incomplete history. Either both land or neither does, so a crashed pass
   *  is always re-runnable from an unchanged row. */
  upsertWorkerWithEvent(row: WorkerRow, kind: EventKind, payload: unknown): void {
    this.db.exec("BEGIN");
    try {
      this.upsertWorker(row);
      this.appendEvent(kind, payload);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** #676 gate② finding [2] ("rebaseline-crash-window"): GATED RECLAIM's AC-snapshot re-baseline
   *  — the fresh `ac_snapshots` row, the reclaimed worker row (carrying that SAME fresh
   *  `bodyHash` as `ac_body_hash`), and the `gated-reentry` reset event — in ONE transaction,
   *  same shape as `upsertWorkerWithEvent` above. Before this, `recordAcSnapshot` committed on
   *  its own connection call, separate from the worker upsert: a process exit between the two
   *  left `ac_snapshots.issue` stamped with the NEW hash while `workers.ac_body_hash` still held
   *  the OLD one. On restart, `checkAcDriftBeforeDrive`'s ownership guard (`snapshot.bodyHash !==
   *  expectedHash`) reads that disagreement as "a different, later dispatch overwrote this
   *  lane's snapshot" — the engine's own torn write re-escalating the exact drift this reclaim
   *  had just adjudicated. Either both land or neither does, so a crashed reclaim is always
   *  re-runnable from an unchanged row (the ownership check in the caller sees its OWN prior
   *  snapshot again, never a half-applied one). */
  recordAcSnapshotAndReclaimWorker(snapshot: AcSnapshot, row: WorkerRow, kind: EventKind, payload: unknown): void {
    this.db.exec("BEGIN");
    try {
      this.recordAcSnapshot(snapshot);
      this.upsertWorker(row);
      this.appendEvent(kind, payload);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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

  /** #383 (F4), round 2 (PM P2): the most recent `drive-queued` event's id+REASON recorded for
   *  `worker`'s (worker, pr) lane, or null if none has ever been recorded — conductor.ts tick()'s
   *  dedup source for the DRIVE-queued steady-state event, the same event-log-as-memory pattern
   *  `lastHoldEvent` and `lastReviewerFallbackEvent` use above (#169/#294: dedupe the EVENT, not
   *  the signal). driveOne reports "queued" STATELESSLY on every DRIVE pass a lane sits on a
   *  gate-pending outcome — without this, an unchanged reason re-appends identically every tick
   *  (measured ~30 appends in 600ms against a single WAIT-gated lane). Scoped to (worker, pr),
   *  not worker alone, for the same reason `lastHoldEvent` is: a lane repointed to a new PR must
   *  not inherit the prior PR's last-queued reason.
   *
   *  Carries `id`, not just `reason` — round 1 compared reasons alone, which silently ate a
   *  genuinely NEW episode that happens to repeat an earlier reason string after an intervening
   *  dispatch (drive-fixup) or park-reentry (lane-revived). The id lets the caller compare
   *  against `maxEventIdForKinds`'s episode-reset boundary; see `DRIVE_QUEUED_RESET_KINDS`
   *  (conductor.ts) for which kinds count as a reset and why. */
  lastDriveQueuedEvent(worker: string, pr: number): { id: number; reason: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, payload FROM events
         WHERE kind = 'drive-queued'
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.pr') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(worker, pr) as { id: number; payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { reason?: string };
    return p.reason == null ? null : { id: row.id, reason: p.reason };
  }

  /** #383 (F30), round 2 (PM P2): the same id+value dedup shape as `lastDriveQueuedEvent`, for
   *  the `fix-leg-dispatch-blocked` steady-state event — a real 90-minute llm park measured 77
   *  duplicate events (one unchanged blockReason) before round 1 existed, and round 1's
   *  same-kind-only comparison itself silently ate a genuine RE-block (PAUSE removed, a fix leg
   *  dispatches, PAUSE re-applied) because the blockReason string repeated. Keyed on the durable
   *  payload's bare `blockReason` field (`paused`/`ceiling`/`park`/`run-spend-stop`), not the
   *  FIXUP branch's own composed `fix-leg-admission-blocked:${blockReason}` string. Scoped to
   *  (worker, pr) for the same lane-repointing reason `lastDriveQueuedEvent` is. Carries `id` for
   *  the same episode-reset comparison — see `FIX_LEG_DISPATCH_BLOCKED_RESET_KINDS`
   *  (conductor.ts). */
  lastFixLegDispatchBlockedEvent(worker: string, pr: number): { id: number; blockReason: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, payload FROM events
         WHERE kind = 'fix-leg-dispatch-blocked'
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.pr') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(worker, pr) as { id: number; payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { blockReason?: string };
    return p.blockReason == null ? null : { id: row.id, blockReason: p.blockReason };
  }

  /** #426 (F26): the lane's CI-PENDING pin, read straight back out of the durable log — the most
   *  recent `ci-pending-observed` / `ci-pending-cleared` event for (worker, pr), or null if this
   *  lane has never observed a pending check. THE LOG IS THE PIN: there is no mirror column and no
   *  in-process clock, which is what makes it crash-consistent for free (a `kill -9` mid-wait
   *  re-reads the SAME `at` on restart, so the elapsed clock never resets — #245-248's pattern,
   *  and the same event-log-as-memory contract `lastHoldEvent` documents).
   *
   *  LATEST-wins by id, never by timestamp: `kind === "ci-pending-observed"` is an OPEN pin,
   *  `"ci-pending-cleared"` a cancelled one (gate① resolved green or red, or the head moved — a
   *  check that concludes WITHOUT passing keeps the lane wedged and does NOT cancel). `at` is the
   *  conductor's own injected-clock stamp carried in the payload — read ONLY as a duration input
   *  (merge-driver.ts's `pinElapsedSec`), never for before/after ordering; ordering is the `id`.
   *  `head` scopes the pin: a pin recorded for a superseded head never ages the current one.
   *  Scoped to (worker, pr) for the same lane-repointing reason `lastHoldEvent` is. */
  lastCiPendingEvent(worker: string, pr: number): { id: number; kind: string; head: string | null; at: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT id, kind, payload FROM events
         WHERE kind IN ('ci-pending-observed', 'ci-pending-cleared')
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.pr') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(worker, pr) as { id: number; kind: string; payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { head?: unknown; at?: unknown };
    return {
      id: row.id,
      kind: row.kind,
      head: typeof p.head === "string" ? p.head : null,
      at: typeof p.at === "string" ? p.at : null,
    };
  }

  /** #451 (gate② P1, PM adjudication; gate② round 3 P2, Codex): the SAME id+value dedup shape as
   *  `lastDriveQueuedEvent`/`lastFixLegDispatchBlockedEvent` above, PARAMETRIZED over the two
   *  `review-disputed-*-failed` kinds (round 3, Codex P2: the label-write failure gets the SAME
   *  treatment the comment-write failure already had — both are genuinely PERMANENT failure
   *  classes an over-limit comment or a standing permission problem can make un-retriable-into-
   *  success, so without this dedup either would re-append its `-failed` event EVERY tick forever —
   *  the exact #383/F30 steady-state event-spam class). Keyed on `headOid` (the escalation
   *  evidence's own stable identity — see `DisputeEscalation`, fix-response.ts): a re-attempt
   *  against the SAME head is the SAME episode; a different head (or a write that finally succeeds)
   *  is a genuinely new one. Scoped to (worker, pr), same lane-repointing rationale as its two
   *  DRIVE-side siblings. Carries `id` for the same episode-reset comparison — see
   *  `REVIEW_DISPUTED_ESCALATION_FAILURE_RESET_KINDS` (conductor.ts), shared by both callers. */
  lastReviewDisputedFailureEvent(
    kind: "review-disputed-label-failed" | "review-disputed-comment-failed",
    worker: string,
    pr: number,
  ): { id: number; headOid: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, payload FROM events
         WHERE kind = ?
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.pr') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(kind, worker, pr) as { id: number; payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { headOid?: string };
    return p.headOid == null ? null : { id: row.id, headOid: p.headOid };
  }

  /** #450 (design #402 R3, architectural review amendment 2026-07-31, item 2): the SAME id+value
   *  dedup shape as `lastReviewDisputedFailureEvent` above, for the convergence-stop escalation's
   *  two `review-non-convergent-*-failed` companion kinds — a genuinely permanent failure class
   *  (an over-limit comment, a standing label-permission problem) gets the identical dedup
   *  discipline every other terminal-escalation failure kind in this file already has (#383/#465:
   *  without it, a standing forge-write problem re-appends its own `-failed` event every tick
   *  forever, the F30 steady-state event-spam class). Keyed on `fixRounds` rather than `headOid`
   *  (`lastReviewDisputedFailureEvent`'s own key): this escalation is not thread-bound — there is
   *  no head OID to key on — and `fixRounds` is `escalateNonConvergent`'s own stable identity for
   *  ONE escalation attempt (it never changes mid-attempt; a lane whose `fix_rounds` later
   *  increments has, by construction, left this branch and dispatched another fix leg instead).
   *  Scoped to (worker, pr), same lane-repointing rationale as every sibling helper here. */
  lastReviewNonConvergentFailureEvent(
    kind: "review-non-convergent-label-failed" | "review-non-convergent-comment-failed",
    worker: string,
    pr: number,
  ): { id: number; fixRounds: number } | null {
    const row = this.db
      .prepare(
        `SELECT id, payload FROM events
         WHERE kind = ?
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.pr') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(kind, worker, pr) as { id: number; payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { fixRounds?: unknown };
    return typeof p.fixRounds === "number" ? { id: row.id, fixRounds: p.fixRounds } : null;
  }

  /** #449 gate② P1 fix (design #402 R2): the most recent `drive-fixup` event's id + recorded
   *  `head` for (worker, pr), or `null` if none has ever been recorded — `conductor.ts`'s
   *  `gatherFixDiffPaths` reads this to find the PRECEDING round's head, the start of the range
   *  `IForge.compareChangedFiles` diffs against. Same id-ordered, no-timestamp-comparison shape
   *  as `lastDriveQueuedEvent`/`lastFixLegDispatchBlockedEvent` above — a direct id-DESC query,
   *  not a timestamp read, satisfying design #402's own "no timestamp-based read on this path"
   *  requirement without needing the `eventsAfterId` cursor machinery those two helpers don't
   *  need either.
   *
   *  Distinguishes two DIFFERENT reasons a caller might see no usable head: `null` (no
   *  `drive-fixup` has ever been recorded for this (worker, pr) — round 1, whose exact "preceding
   *  leg" is the whole PR production) from `{ head: null }` (a `drive-fixup` DOES exist but
   *  predates this field — a #449-deploy-transition edge, not a genuine round 1). The caller
   *  tells them apart by checking for a `null` return vs. a non-null return whose `head` is
   *  `null`, and must NOT treat the two identically (see `gatherFixDiffPaths`'s own doc for why:
   *  only the true round-1 case is safe to widen to the full base..head set).
   *
   *  #450 gate② P1: `afterId` (default `0`, so every pre-#450 call site — and the existing pinned
   *  test — is byte-for-byte unchanged) restricts the read to `id > afterId`, the SAME id-cursor
   *  shape `eventsAfterId` already uses elsewhere in this file. `conductor.ts`'s `gatherFixDiffPaths`
   *  passes `CONVERGENCE_EPISODE_RESET_KINDS`'s boundary here so a `drive-fixup` from a PRIOR
   *  convergence episode (before the lane's most recent `gated-reentry`/`lane-revived`) is invisible
   *  to this read — the post-reclaim round then correctly sees "no previous drive-fixup THIS
   *  episode" (`null`), not a stale pre-escalation head. */
  lastDriveFixupEvent(worker: string, pr: number, afterId = 0): { id: number; head: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT id, payload FROM events
         WHERE kind = 'drive-fixup'
           AND id > ?
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.pr') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(afterId, worker, pr) as { id: number; payload: string } | undefined;
    if (!row) return null;
    const p = JSON.parse(row.payload) as { head?: unknown };
    return { id: row.id, head: typeof p.head === "string" ? p.head : null };
  }

  /** #383 round 2 (PM P2): the highest event id among `kinds`, scoped to this (worker, pr) — the
   *  EPISODE-RESET boundary `lastDriveQueuedEvent`/`lastFixLegDispatchBlockedEvent`'s callers
   *  compare their own last-announcement id against. Returns 0 (lower than any real event id,
   *  same sentinel `laneEventRecorded`'s callers rely elsewhere) when none of `kinds` has ever
   *  fired for this lane's PR — a same-kind announcement's id is then trivially > 0, so a lane
   *  with no reset history behaves exactly like round 1 (compare reasons alone). See
   *  `DRIVE_QUEUED_RESET_KINDS`/`FIX_LEG_DISPATCH_BLOCKED_RESET_KINDS` (conductor.ts) for the
   *  concrete kind sets and why each belongs. */
  maxEventIdForKinds(kinds: readonly string[], worker: string, pr: number): number {
    if (kinds.length === 0) return 0;
    const placeholders = kinds.map(() => "?").join(",");
    const row = this.db
      .prepare(
        `SELECT COALESCE(MAX(id), 0) AS m FROM events
         WHERE kind IN (${placeholders})
           AND json_extract(payload, '$.worker') = ?
           AND json_extract(payload, '$.pr') = ?`,
      )
      .get(...kinds, worker, pr) as { m: number };
    return row.m;
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
   *  'unknown' row with 0 tokens, matching every pre-#47 row's shape.
   *
   *  #645: `actorKind`/`role`/`estimated` are the durable attribution columns — see
   *  `SpendActorKind`'s own doc for who sets what and why the three are OPTIONAL here rather
   *  than required (a required param would force every test fixture that seeds unrelated state
   *  through this method to fabricate a kind; omitting is the same honest "unclassified" a
   *  pre-#645 row already renders as, never a guess). Every REAL production write site passes
   *  `actorKind` explicitly (state.test.ts's write-site sweep test pins that set). */
  recordSpend(
    worker: string,
    issue: number,
    usd: number,
    at: string,
    models: ModelUsageEntry[] = [],
    actorKind?: SpendActorKind,
    role?: string,
    estimated?: boolean,
  ): void {
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
         (ts, worker, issue, usd, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
          actor_kind, role, estimated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // The terminal result's model-usage payload follows the same last-result/per-leg read path
    // as total_cost_usd, so token rows are recorded directly for this leg too. Attribution is a
    // property of the SETTLEMENT (this whole call), not of any one model row, so every row this
    // leg produces carries the identical actor_kind/role/estimated.
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
        actorKind ?? null,
        role ?? null,
        estimated === undefined ? null : estimated ? 1 : 0,
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
    spend: {
      worker: string;
      issue: number;
      usd: number;
      at: string;
      models?: ModelUsageEntry[];
      /** #645: see SpendActorKind's own doc. Optional for the same reason recordSpend's own
       *  param is — a required field would force every existing settleTerminalWorker test
       *  fixture to fabricate a kind; omitted renders `unclassified`, never a guess. Every REAL
       *  caller (conductor.ts's reclaimTerminalLane + its two DEAD-lane loops) passes it. */
      actorKind?: SpendActorKind;
      role?: string;
      estimated?: boolean;
    },
    fixResponse?: FixResponseSettleOutcome,
  ): void {
    this.db.exec("BEGIN");
    try {
      this.upsertWorker(row);
      this.recordSpend(spend.worker, spend.issue, spend.usd, spend.at, spend.models ?? [], spend.actorKind, spend.role, spend.estimated);
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
          // #451: `headOid` + per-thread `writes` (threadId/resolution/reply) ride this SAME
          // receipt event — the only durable record of a `disputed` resolution once its
          // pending_thread_writes row clears (attemptThreadWrite drops a disputed row the instant
          // its reply posts; fix-response.ts's own `completeThreadReply` receipt carries no
          // resolution/reply at all). Live GitHub state cannot substitute: an unresolved thread
          // with our reply already posted is indistinguishable, from a pure live read, between
          // "disputed" (final, by design — speak-not-act) and "addressed, resolve still retrying"
          // (the SAME queue's bounded-retry path) — only this durable field tells them apart.
          // fix-response.ts's `latestThreadResolutions` is the one reader.
          this.appendEvent("fix-response-queued", {
            worker: batch.worker,
            issue: batch.issue,
            pr: batch.pr,
            batchKey: batch.batchKey,
            fixRounds: batch.fixRounds,
            count: batch.writes.length,
            headOid: batch.headOid,
            // #490: engine-agent legs only — the classic payload stays byte-identical (AC), so a
            // consumer's `threadless: true` read doubles as "count:0 is structural, not empty".
            ...(batch.threadless ? { threadless: true, newHead: batch.newHead } : {}),
            // #451 (gate② P2): `reply` is capDigest-bounded here (marked, never silent) — see
            // FIX_RESPONSE_LEDGER_REPLY_MAX_CHARS's own doc for why the ledger copy is bounded
            // while the pending_thread_writes row (the one actually posted to GitHub) is not.
            writes: batch.writes.map((w) => ({
              threadId: w.threadId,
              resolution: w.resolution,
              reply: capDigest(w.reply, FIX_RESPONSE_LEDGER_REPLY_MAX_CHARS),
            })),
            // #461: the audit-comment channel's own responses — spread ONLY when the leg emitted
            // any, so a payload without the new block stays byte-identical to its pre-#461 shape.
            // Replies are capDigest-bounded for the same reason the thread ones are; unlike them
            // this IS the only copy (nothing is enqueued for a finding), which is exactly why the
            // bound is marked rather than silent.
            ...((batch.findingWrites ?? []).length > 0
              ? {
                  findingWrites: batch.findingWrites!.map((w) => ({
                    runId: w.runId,
                    findingIndex: w.findingIndex,
                    resolution: w.resolution,
                    reply: capDigest(w.reply, FIX_RESPONSE_LEDGER_REPLY_MAX_CHARS),
                  })),
                }
              : {}),
          });
        }
      }
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** #724 gate② round 4, P1-1: round.ts's E-STOP durable-pid sweep's own atomic settlement — the
   *  row transition (to `failed`), its settled spend, and the `estop-lane-swept` outcome event,
   *  in ONE transaction. Same shape (and reason) as `recordEstopActivation`/`recordDispatch`/
   *  `recordLaneRowAndSpawnFact` above — this is the same atomic-State-method family, not a new
   *  parallel path. Before this, the sweep did these as THREE separate writes (signal the
   *  process, `settleTerminalWorker`, `appendEvent`): a crash between the row-settle and the
   *  event left a `failed` row with NO `estop-lane-swept` trail — permanently invisible, since
   *  nothing else ever re-examines a `failed` row — and a crash before the row-settle (but after
   *  the OS-level SIGKILL) left a genuinely-dead child's row still `driving`/`handoff`, exactly
   *  the shape `reconcileDrivingFixIntents`/`adoptAndReclaimTerminal` (conductor.ts) could
   *  mistake for an ordinary confirmed-resume-intent and try to ADOPT. Bundling row+spend+event
   *  makes the FIRST half of that window unrepresentable (either everything here lands, or
   *  nothing does). The SECOND half — a crash strictly between the OS signal and this call ever
   *  running at all — is NOT closeable by a transaction (the kill already happened outside the
   *  DB); it is closed instead by `estopSweepIntentOpen`'s own durable PRE-KILL marker, written
   *  by the caller BEFORE the first signal — see that method's own doc for the crash-rerun
   *  argument. `settleTerminalWorker` above is left untouched: this is a DELIBERATE sibling, not
   *  a generalization of it (nesting `BEGIN` inside an already-open transaction throws in
   *  sqlite, so calling settleTerminalWorker FROM here was never an option; the alternative —
   *  widening settleTerminalWorker's own signature with an arbitrary extra event — was rejected
   *  as a wider blast radius on a method 14 OTHER call sites already depend on). */
  settleEstopSweptWorker(
    row: WorkerRow,
    spend: { worker: string; issue: number; usd: number; at: string; actorKind?: SpendActorKind },
    eventPayload: { worker: string; issue: number; confirmedDead: boolean },
  ): void {
    this.db.exec("BEGIN");
    try {
      this.upsertWorker(row);
      this.recordSpend(spend.worker, spend.issue, spend.usd, spend.at, [], spend.actorKind);
      this.appendEvent("estop-lane-swept", eventPayload);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** #724 gate② round 4, P1-1: is there an OPEN pre-kill sweep intent for (worker, issue) — the
   *  crash-rerun safety marker round.ts's E-STOP sweep writes BEFORE it ever signals a durable
   *  pid (an `estop-lane-sweep-started` event), so a restart that finds the row STILL `driving`/
   *  `handoff` (settlement never completed — `settleEstopSweptWorker` above never landed) knows
   *  this lane was ALREADY decided must-settle, not a fresh candidate to re-classify from
   *  scratch. This is what makes tick()'s ordinary reconciliation safe to leave untouched: a
   *  round already `in_progress` at `executing` when a crash lands NEVER advances its persisted
   *  `phase` column past `executing` until `runExecuting` returns cleanly (round.ts's own
   *  rerun-not-resume doctrine — `SEQUENCE.indexOf(round.phase)` on restart re-enters exactly
   *  the still-open phase, never a fresh one) — so a restart of THIS round is guaranteed
   *  `freshBatch: false`, which skips tick()'s wave-1 call entirely and lets round.ts's OWN sweep
   *  (not conductor.ts's `reconcileDrivingFixIntents`) be the FIRST thing to observe the row.
   *  Last-event-wins fold over the two-kind pair, the SAME shape escalation-reconcile.ts's own
   *  `openEscalations` uses for a source/resolution pair: a NEWER `estop-lane-swept` (the
   *  completion event) than the newest `estop-lane-sweep-started` means the intent already
   *  closed; no `estop-lane-swept` at all after a `started` means it is still open. */
  estopSweepIntentOpen(worker: string, issue: number): boolean {
    const row = this.db
      .prepare(
        `SELECT kind FROM events
         WHERE kind IN ('estop-lane-sweep-started', 'estop-lane-swept')
           AND json_extract(payload, '$.worker') = ? AND json_extract(payload, '$.issue') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(worker, issue) as { kind: string } | undefined;
    return row?.kind === "estop-lane-sweep-started";
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

  /** #431 (F29): the per-tick liveness heartbeat — the ONE piece of the old `engine_session`
   *  machinery that SURVIVES the wall-clock re-anchor, because it has two live consumers that
   *  are entirely about process liveness, not wall-clock accounting:
   *    1. the #395 progress watchdog samples the tuple `(state.maxEventId(), state.lastTickAt())`
   *       (watchdog.ts) — a quiet-log ticking engine must never self-kill, and last_tick_at is
   *       the half of that tuple that proves a TICK is still flowing;
   *    2. the dashboard's `deriveEngineState` derives `stalled` from `lastTickAt` cross-process
   *       (dashboard server) — its only signal that an engine process is alive at all.
   *  Everything ELSE the old engineSessionStart did is DELETED, not moved: the `started_at`
   *  resurrection across restarts, the staleGapSec gap heuristic, and the pause-to-reset
   *  ritual measured PROCESS LIVENESS, not autonomous action (a parked wait loop refreshed the
   *  heartbeat every iteration and burned the whole budget while doing nothing — the F29
   *  strike). The wall-clock ceiling now anchors to IN-MEMORY process start (conductor.ts's
   *  TickDeps.processStartedAt); a restart at ANY gap length gets a fresh clock by
   *  construction. `started_at` remains a schema column (migrations are append-only) but is
   *  write-only bookkeeping here, never read back. */
  touchLastTick(now: Date): void {
    const nowIso = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO engine_session (id, started_at, last_tick_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET last_tick_at = excluded.last_tick_at`,
      )
      .run(nowIso, nowIso);
  }

  /** Record a ceiling breach: `at` is the FIRST-detected time (preserved across re-detections —
   *  re-detecting a still-active breach on a later tick must NOT reset the drain-window clock),
   *  while `reason` mirrors the CURRENT reason set (#431 round 3, codex P2 — the old INSERT OR
   *  IGNORE froze the first tick's reasons, so a wall-clock breach joining an open daily-budget
   *  one was invisible here, and after midnight status/dashboard kept promising "until
   *  tomorrow" for a breach that actually needed a restart). Per the round-3 write rule
   *  (conductor.ts's reconcileCeilingAnnouncements doc), this row is the MIRROR: the per-reason
   *  entered/cleared events land first, and dedup reads only the log — never this row. */
  recordCeilingBreach(reasons: string[], now: Date): void {
    this.db
      .prepare(
        `INSERT INTO ceiling_breach (id, reason, at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET reason = excluded.reason`,
      )
      .run(JSON.stringify(reasons), now.toISOString());
  }

  ceilingBreach(): { reasons: string[]; at: Date } | null {
    const row = this.db.prepare("SELECT reason, at FROM ceiling_breach WHERE id = 1").get() as { reason: string; at: string } | undefined;
    if (!row) return null;
    return { reasons: JSON.parse(row.reason) as string[], at: new Date(row.at) };
  }

  /** #724 gate② P2-2: the `emergency-stop` activation event and its ceiling_breach row, in ONE
   *  transaction — same shape as `recordEngineReviewVerdictAndSpend` above. Both callers
   *  (conductor.ts's tick() E-STOP branch, round.ts's pre-tick round-level detection path) used
   *  to do `appendEvent("emergency-stop", {})` then `recordCeilingBreach(...)` as two SEPARATE
   *  writes, with a real crash window between them: a crash after the event commits but before
   *  the ceiling_breach row does leaves `ceilingBreach()` reading null on restart — and BOTH
   *  callers' own dedup check ("read ceilingBreach().reasons before writing") is what turns THAT
   *  into a duplicate: a later detection (this same run recovering, or the other of the two
   *  callers) reads "not yet announced" and appends the event again. Bundling the two writes
   *  makes that torn state unrepresentable: either both land, or (a thrown error) neither does.
   *  The caller's own dedup READ is UNCHANGED — it still runs, by the caller, BEFORE calling this
   *  method; this only wraps the two writes the read gates. */
  recordEstopActivation(now: Date): void {
    this.db.exec("BEGIN");
    try {
      this.appendEvent("emergency-stop", {});
      this.recordCeilingBreach(["emergency-stop"], now);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
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

  /** #293: the emergency-stop sentinel — same file-sentinel pattern as killSwitchPath above
   *  (human-flippable, engine-owned data dir, null dir -> never active), but a DIFFERENT
   *  contract: KILL_SWITCH is drain-first (SIGTERM handoff, bounded window, then hard kill);
   *  EMERGENCY_STOP means immediate hard kill with no drain window at all — see conductor.ts's
   *  tick() gate, which checks this BEFORE killSwitchPath so both present -> E-STOP wins. */
  estopPath(): string | null {
    return this.dataDir ? join(this.dataDir, "EMERGENCY_STOP") : null;
  }

  isEstopActive(): boolean {
    const p = this.estopPath();
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

  /** #382: the single-instance lockfile's path — beside the DB, same data-dir placement as the
   *  sentinels above, but ENGINE-written (pid + token + acquiredAt), never a human control
   *  input. Path helper only: acquisition/release logic lives in loop/instance-lock.ts (the
   *  cli.ts run path is its one consumer). null dir (in-memory State, tests) -> no lock, same
   *  convention as killSwitchPath/pausePath — no shared data dir means nothing to double-drive. */
  instanceLockPath(): string | null {
    return this.dataDir ? join(this.dataDir, INSTANCE_LOCK_FILENAME) : null;
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
   *  actually inserted the row, so a caller can fire a park-entry event once per episode.
   *
   *  `resetHintAtIso` (#374, optional — every pre-#374 call site omits it unchanged): a KNOWN
   *  reset instant (worker.ts's extractRateLimitResetAt / peripheral.ts's RoleSessionResult
   *  .rateLimitResetAtMs), stored ONCE at first entry, same "first detection wins" stance as
   *  `reason`/`entered_at` — a later classified failure for the SAME open episode never
   *  overwrites it (INSERT OR IGNORE no-ops the whole row on conflict, this column included). */
  enterPark(source: ParkSource, reason: string, triggerIssue: number | null, now: string, resetHintAtIso: string | null = null): boolean {
    const res = this.db
      .prepare(
        `INSERT OR IGNORE INTO park_state (source, reason, trigger_issue, entered_at, last_probe_at, probe_attempts, reset_hint_at)
         VALUES (?, ?, ?, ?, ?, 0, ?)`,
      )
      .run(source, reason, triggerIssue, now, now, resetHintAtIso);
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
    reset_hint_at: string | null;
  }): ParkRow {
    return {
      source: row.source as ParkSource,
      reason: row.reason,
      triggerIssue: row.trigger_issue,
      enteredAt: row.entered_at,
      lastProbeAt: row.last_probe_at,
      probeAttempts: row.probe_attempts,
      escalatedAt: row.escalated_at,
      canaryWorker: row.canary_worker,
      resetHintAt: row.reset_hint_at,
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
  parkRow(source: ParkSource): ParkRow | null {
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
  registerCanaryDispatch(
    row: WorkerRow,
    source: EnvFailureSource,
    issueTitle?: string,
    // #705 gate② P2-3: same "row transition + spawn fact commit together" rule this method's
    // own transaction already enforces for canary_worker/park-canary — a canary lane is a REAL
    // live child too (read-model.ts's buildStatusDTO includes it via activeWorkers()), so a
    // missing pid/worktreePath here is the same permanently-null-anchors hazard the ordinary
    // dispatch path closes via State.recordDispatch. `undefined` (not passed) is a Supervisor
    // with no opinion on live-process identity — never a fabricated fact.
    spawnFact?: LaneSpawnFact,
  ): void {
    this.db.exec("BEGIN");
    try {
      this.upsertWorker(row);
      const res = this.db.prepare("UPDATE park_state SET canary_worker = ? WHERE source = ?").run(row.name, source);
      if (res.changes === 0) {
        throw new Error(`registerCanaryDispatch: no open ${source} park episode to attach canary ${row.name} to`);
      }
      // #595: a canary dispatch is still a dispatch — its event carries the board row's title
      // (passed in by the caller, which holds it) exactly like the ordinary path's does, so the
      // dashboard never has a tooltip hole on park-canary lanes. Omitted when absent.
      this.appendEvent("dispatched", { worker: row.name, issue: row.issue, ...(issueTitle != null ? { issueTitle } : {}) });
      this.appendEvent("park-canary", { worker: row.name, issue: row.issue });
      if (spawnFact) this.appendEvent("lane-spawned", spawnFact);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** #705 gate② P2-3: the ordinary (non-canary) dispatch's worker row, its `dispatched` event,
   *  and (when the Supervisor reported one) its `lane-spawned` event, in ONE transaction — the
   *  SAME "the row transition and the fact it enables must commit together" rule
   *  `registerCanaryDispatch` already enforces for its own canary_worker/park-canary writes, and
   *  `recordEngineReviewVerdictAndSpend` enforces for verdict+spend. Before this, `conductor.ts`
   *  wrote the row, then `dispatched`, then `lane-spawned` as THREE separate statements — a crash
   *  after the first two but before the third left a lane the ledger already believes is
   *  `running` (so the next tick's dispatch-cap counts it occupied and never retries the spawn)
   *  with NO `lane-spawned` event ever coming — permanently null runtime anchors, undetectable
   *  and unrecoverable after the fact. `spawnFact` is `null`/omitted for a Supervisor with no
   *  opinion on live-process identity (a test double) — never a fabricated fact. */
  recordDispatch(row: WorkerRow, issueTitle: string | undefined, spawnFact: LaneSpawnFact | null): void {
    this.db.exec("BEGIN");
    try {
      this.upsertWorker(row);
      this.appendEvent("dispatched", { worker: row.name, issue: row.issue, ...(issueTitle != null ? { issueTitle } : {}) });
      if (spawnFact) this.appendEvent("lane-spawned", spawnFact);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** #705 gate② P2-3: the general form of the same "row transition + spawn fact, one
   *  transaction" rule — used by every RESUME-family call site (ordinary resume, fix-leg
   *  resume/adoption, cross-restart adoption, `startFixLeg`), each of which already has its own
   *  distinct lifecycle event (`resumed`/`fix-leg-resumed`/`fix-leg-adopted-drained`/
   *  `fix-leg-started`) with its own payload shape — hence the generic
   *  `(lifecycleKind, lifecyclePayload)` pair, same `payload: unknown` seam
   *  `recordEngineReviewVerdictAndSpend` uses for its own caller-shaped event. */
  recordLaneRowAndSpawnFact<K extends EventKind>(
    row: WorkerRow,
    lifecycleKind: K,
    lifecyclePayload: EventPayloadFor<K>,
    spawnFact: LaneSpawnFact | null,
  ): void {
    this.db.exec("BEGIN");
    try {
      this.upsertWorker(row);
      this.appendEvent(lifecycleKind, lifecyclePayload);
      if (spawnFact) this.appendEvent("lane-spawned", spawnFact);
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
  recordParkEscalation(source: ParkSource, at: string): void {
    this.db.prepare("UPDATE park_state SET escalated_at = ? WHERE source = ?").run(at, source);
  }

  /** Auto-resume / manual clear for one source. A LATER park of the same source is a fresh
   *  episode with its own entered_at/backoff count, never a continuation. Clearing the LAST
   *  open episode also removes the local escalation marker (PR #180 review P2-2: the marker
   *  described an outage that no longer exists — wiring the clear here, at the single choke
   *  point every resume path goes through, is what guarantees it can never be forgotten). */
  clearPark(source: ParkSource): void {
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

  /** #431 round 4: does the local ESCALATION marker exist? The log-authority healers
   *  (loop/rapid-restart.ts) use this to rebuild the marker MIRROR when a kill separated it
   *  from its park-escalated event. A null dir (in-memory State — tests) has no marker channel
   *  at all, reported as `true` ("nothing to heal") so healers never spin on a mirror that
   *  cannot exist. */
  escalationMarkerExists(): boolean {
    const p = this.escalationMarkerPath();
    return p == null || existsSync(p);
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
  /* #403 (F25) per-site decision: `now` stays OPTIONAL here, unlike every `now?: () => Date`
   * seam this issue made required. It is not a clock DEPENDENCY — it's a caller-supplied
   * timestamp for callers (round.ts) that already hold this round's `iso()` and want the row to
   * agree with it. Omitted, it falls back to the same deliberate wall clock `appendEvent` above
   * documents: "when did the engine write this row", never a decision input, never compared to a
   * seeded date by any assertion. Making it required would thread a timestamp through nine
   * call sites to change nothing observable. */
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

  /** Durable event-log rows at or after `sinceIso`, restricted to `kinds`. Chronological (by id)
   *  order, parsed payload. `kinds` must be non-empty — an empty SQL `IN ()` is invalid, so this
   *  throws rather than silently returning everything or nothing (a caller bug, not a runtime
   *  condition to degrade gracefully from).
   *
   *  NOT A ROUND-WINDOW READ (#403, F25 — PR #430 gate② P2). `events.ts` is stamped by
   *  `appendEvent` from the MACHINE clock, while a round's `started_at` comes from the round's
   *  INJECTED clock; passing one to the other compares two different clocks, and any divergence
   *  (a fixture that seeds a round date, a host whose clock steps backward mid-round) silently
   *  drops the round's own events. `eventsAfterId` + `RoundRow.start_event_id` is the round-window
   *  read — the #123 mechanism, for exactly this reason (see the v9->v10 migration comment).
   *  gatherRetroFacts / gatherTouchedPRs / gatherDigestIssues used to call THIS and now don't.
   *  What is left is legitimate: callers passing an epoch/"all time" sentinel, where no clock is
   *  being compared at all. Keep it that way. */
  /** #425 phase 1.5: the TYPED access path for the kinds with a declared payload shape — call it
   *  with a list of payload-typed kinds (fix-response.ts's `FIX_LEG_CURSOR_KINDS`, derived from
   *  the registry's `fix-leg` tag) and each row's `payload` comes back as the shape the writer is
   *  compelled to write, instead of `unknown` + a cast at the read site. Purely a compile-time
   *  claim — nothing parses or validates here, so a reader that must tolerate legacy/foreign rows
   *  still guards the fields it depends on (see `fixLegJournalCursor`). */
  eventsSince<K extends PayloadTypedKind>(sinceIso: string, kinds: readonly K[]): { kind: K; payload: EventPayloads[K] }[];
  eventsSince(sinceIso: string, kinds: readonly string[]): { kind: string; payload: unknown }[];
  eventsSince(sinceIso: string, kinds: readonly string[]): { kind: string; payload: unknown }[] {
    if (kinds.length === 0) throw new Error("eventsSince: kinds must be non-empty");
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT kind, payload FROM events WHERE ts >= ? AND kind IN (${placeholders}) ORDER BY id`)
      .all(sinceIso, ...kinds) as { kind: string; payload: string }[];
    return rows.map((r) => ({ kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
  }

  /** #431: how many events of `kind` carry a ts inside the CLOSED window [sinceIso, untilIso] —
   *  the rapid-restart detector's birth count (`run-started` is appended exactly once per
   *  process boot, so this IS the number of process births in the window; wait-loop iterations
   *  append other kinds and can never inflate it, by construction). The clock caveat matches
   *  eventsSince above: `ts` is the real machine clock at write time (appendEvent's own doc), so
   *  both cutoffs must come from the same host clock family (cli.ts's systemClock in
   *  production). The UPPER bound exists for round 2's codex P3: a DB restored from a
   *  fast-clock machine (or a backward host-clock correction) can hold `run-started` rows dated
   *  in this machine's FUTURE — unbounded, those would count for the entire skew, false-tripping
   *  the detector and re-parking even after a manual park clear. A count, not the rows — the
   *  detector needs no payloads. */
  countEventsBetween(sinceIso: string, untilIso: string, kind: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS n FROM events WHERE ts >= ? AND ts <= ? AND kind = ?")
      .get(sinceIso, untilIso, kind) as { n: number };
    return row.n;
  }

  /** #210: every retained worktree path whose LATEST retention has not been released yet — the
   *  input to conductor.ts's releaseVanishedWorktrees scan (docs/frontend-design.md §11
   *  follow-up 4). Identity is the `worktreePath`, not the lane name (lane names are reused
   *  slots), and the decision is "what is the newest event for this path" rather than "was this
   *  path ever released": a slot recycled at the same path is retained again, and that fresh
   *  retention must be able to resolve on its own. Null paths are excluded — they are
   *  unmatchable by construction, which is exactly why the engine never emits one (see
   *  conductor.ts's reportRetainedWorktree). The event log itself is the dedupe memory, so the
   *  scan is restart-safe with no in-memory flag. */
  unreleasedRetainedWorktrees(): { worker: string; issue: number; worktreePath: string }[] {
    // Bare columns alongside a single MAX() come from the max row (documented SQLite behavior),
    // so each group carries its LATEST event's kind and payload fields.
    const rows = this.db
      .prepare(
        `SELECT json_extract(payload, '$.worker') AS worker,
                json_extract(payload, '$.issue') AS issue,
                json_extract(payload, '$.worktreePath') AS worktreePath,
                kind, MAX(id)
         FROM events
         WHERE kind IN ('worktree-retained', 'worktree-released')
           AND json_extract(payload, '$.worktreePath') IS NOT NULL
         GROUP BY json_extract(payload, '$.worktreePath')`,
      )
      .all() as unknown as { worker: string; issue: number; worktreePath: string; kind: string }[];
    return rows
      .filter((r) => r.kind === "worktree-retained")
      .map((r) => ({ worker: r.worker, issue: r.issue, worktreePath: r.worktreePath }));
  }

  latestEvent(kind: string): { kind: string; payload: unknown } | undefined {
    const row = this.db.prepare("SELECT kind, payload FROM events WHERE kind = ? ORDER BY id DESC LIMIT 1").get(kind) as
      | { kind: string; payload: string }
      | undefined;
    return row ? { kind: row.kind, payload: JSON.parse(row.payload) as unknown } : undefined;
  }

  /** #705: the newest known live-process identity for `worker` — pid + worktree path, read off
   *  the `lane-spawned` event the conductor appends every time worker.ts's dispatch()/resume()
   *  confirms a NEW live child for this lane (first dispatch, an ordinary or fix-leg resume, or
   *  a cross-restart adoption of an already-confirmed spawn — worker.ts's own early-return
   *  branch in resume() sources the pid from the persisted running.json `wrapper_pid` for that
   *  last case). Newest wins by event id, the same MAX(id)-per-subject fold
   *  `unreleasedRetainedWorktrees` above uses — a resumed lane's fresh pid/worktree supersedes
   *  its prior leg's stale one, which is exactly the belief-vs-reality case #705 exists for.
   *  `null` when the lane predates #705 or was dispatched through a `Supervisor` that doesn't
   *  report this fact (a test double) — read-model.ts's `buildLaneAnchors` renders that as
   *  `pid: null, pidAlive: "unknown", worktreePath: null`, never a fabricated "dead".
   *
   *  #705 gate② P1-1: scoped by (worker, issue), not worker name alone. A lane NAME is reused
   *  only in the LATENT case (an explicit `name` colliding with a stale sentinel) — production
   *  dispatch() never passes one and refuses reuse via its own stale-sentinel check — but a bare
   *  worker-name fold would silently hand a reused name an OLDER issue's stale pid/worktree, the
   *  same reuse hazard lane-state-label.ts's own (worker, pr) scoping exists to close. */
  latestLaneSpawnFact(worker: string, issue: number): { pid: number | null; worktreePath: string } | null {
    const row = this.db
      .prepare(
        `SELECT json_extract(payload, '$.pid') AS pid, json_extract(payload, '$.worktreePath') AS worktreePath
         FROM events
         WHERE kind = 'lane-spawned' AND json_extract(payload, '$.worker') = ? AND json_extract(payload, '$.issue') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(worker, issue) as { pid: number | null; worktreePath: string | null } | undefined;
    return row && row.worktreePath != null ? { pid: row.pid, worktreePath: row.worktreePath } : null;
  }

  /** #705: the newest `worker-heartbeat` event for `worker` — its row id plus the EVENTS TABLE'S
   *  OWN `ts` column (appendEvent's deliberate wall-clock write, not a payload field), for
   *  read-model.ts's `buildLaneAnchors` to turn into an age-seconds against an INJECTED clock
   *  (never a `Date.now()` read in here — this stays a pure ledger read). `null` when the lane
   *  has no heartbeat yet (freshly dispatched; the first cadence tick isn't due).
   *
   *  #705 gate② P1-1: scoped by (worker, issue) — same lane-name-reuse hazard
   *  `latestLaneSpawnFact` above closes. Filters on the payload's OWN `issue` field rather than
   *  bounding by a `lane-spawned` id cursor: worker.ts's heartbeat emit site
   *  (`gate.tick("worker-heartbeat", { worker, issue, elapsedSec })`) already carries `issue` on
   *  every row, so this is the smallest change that closes the hazard — no payload widening. */
  latestHeartbeatForWorker(worker: string, issue: number): { id: number; ts: string } | null {
    const row = this.db
      .prepare(
        `SELECT id, ts FROM events
         WHERE kind = 'worker-heartbeat' AND json_extract(payload, '$.worker') = ? AND json_extract(payload, '$.issue') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(worker, issue) as { id: number; ts: string } | undefined;
    return row ?? null;
  }

  /** #723: the newest of standby-wait/standby-heartbeat/standby-exit, with its write-time `ts` —
   *  read-model.ts's standby-liveness check needs BOTH the newest kind (an exit newest means
   *  parking already ended) and the write-time clock (the SAME `latestHeartbeatForWorker`-style
   *  events-table `ts`, not a payload field) to tell a genuinely fresh standby dwell from one
   *  whose own last-seen signal has gone stale. `undefined` when none of the three kinds has
   *  ever been written.
   *
   *  #746 gate② finding [0]: `id` is ALSO carried through — a process that exits cleanly (or
   *  self-diagnoses a stall) mid-standby-dwell appends `run-ended`/`engine-stalled` WITHOUT ever
   *  appending `standby-exit` (round.ts's standby loop simply never resumes to reach its own
   *  exit-append site), so kind/ts alone cannot tell "still genuinely parked" from "parking was
   *  cut short by the process dying". `id` gives read-model.ts an authoritative, doctrine-
   *  preferred (id cursor, not timestamp — repo review doctrine's crash-rerun rule) ordering
   *  against `latestRunTerminal`'s own newly-carried `eventId`, so a terminal newer than this
   *  signal can invalidate it even though the signal's own wait/remaining window hasn't elapsed
   *  yet. */
  latestStandbySignal():
    | { id: number; kind: "standby-wait" | "standby-heartbeat" | "standby-exit"; ts: string; payload: unknown }
    | undefined {
    const row = this.db
      .prepare(
        `SELECT id, ts, kind, payload FROM events
         WHERE kind IN ('standby-wait', 'standby-heartbeat', 'standby-exit')
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { id: number; ts: string; kind: string; payload: string } | undefined;
    return row
      ? {
          id: row.id,
          kind: row.kind as "standby-wait" | "standby-heartbeat" | "standby-exit",
          ts: row.ts,
          payload: JSON.parse(row.payload) as unknown,
        }
      : undefined;
  }

  /** #431 rounds 2-3: which side of the entered/cleared pair is newest FOR ONE CEILING REASON —
   *  the id-ordered transition read (the same event-log-as-memory shape
   *  latestHoldVisibilityEvent uses for pr-held/pr-released, #169/#294, and the same
   *  json_extract payload filter that query already relies on). Round 3 (codex P2) scoped the
   *  pair PER REASON: a single global pair could not represent "daily-budget cleared at
   *  midnight while wall-clock stays open", losing both the departure receipt and the next
   *  daily re-breach's announcement. Consumed by conductor.ts's reconcileCeilingAnnouncements. */
  latestCeilingEventForReason(reason: string): "ceiling-breach-entered" | "ceiling-breach-cleared" | null {
    const row = this.db
      .prepare(
        `SELECT kind FROM events
         WHERE kind IN ('ceiling-breach-entered', 'ceiling-breach-cleared')
           AND json_extract(payload, '$.reason') = ?
         ORDER BY id DESC LIMIT 1`,
      )
      .get(reason) as { kind: "ceiling-breach-entered" | "ceiling-breach-cleared" } | undefined;
    return row?.kind ?? null;
  }

  /** #395 item 2: the single latest event's id + kind (no payload — unlike latestEvent(kind)
   *  above, this is not filtered to one kind; it's the ledger's own tail). The liveness
   *  watchdog's stall-record enrichment reads this, alongside maxEventId(), at fire time — "what
   *  was the last thing that happened, and what kind of thing was it" is a materially different
   *  (and cheaper-to-eyeball) fact than the bare id the tuple sampling already compares against. */
  lastEventKind(): { id: number; kind: string } | undefined {
    return this.db.prepare("SELECT id, kind FROM events ORDER BY id DESC LIMIT 1").get() as { id: number; kind: string } | undefined;
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
   *  timestamps). Same non-empty-kinds guard as eventsSince.
   *
   *  #477: each row also carries its own ledger `id` — a fact's ledger id is the one identity
   *  that is unique, monotonic, and crash-safe, which is what a LOG-AUTHORITY identity key must
   *  be (the stall breaker's episode identity was a minted wall-clock timestamp, and two
   *  episodes minted in the same millisecond collided — the #403 F25 class, this time in an
   *  identity comparison instead of a duration). Purely additive for every existing caller. */
  eventsAfterId(afterId: number, kinds: string[]): { id: number; kind: string; payload: unknown }[] {
    if (kinds.length === 0) throw new Error("eventsAfterId: kinds must be non-empty");
    const placeholders = kinds.map(() => "?").join(",");
    const rows = this.db
      .prepare(`SELECT id, kind, payload FROM events WHERE id > ? AND kind IN (${placeholders}) ORDER BY id`)
      .all(afterId, ...kinds) as { id: number; kind: string; payload: string }[];
    return rows.map((r) => ({ id: r.id, kind: r.kind, payload: JSON.parse(r.payload) as unknown }));
  }

  /** #395 (F24 round 2): the events table's own MAX(id) — the liveness watchdog's progress
   *  signal (watchdog.ts's startProgressWatchdog). Same cheap MAX(id) pattern as
   *  maxSpendLedgerId below; `state.appendEvent` is the engine's one durable progress channel
   *  (round-phase entries, dispatched, reclaim outcomes, tick-error, heartbeats, ...) — an
   *  unchanged reading across a full watchdog window means nothing was appended, independent of
   *  which phase is running or how long it legitimately takes. */
  maxEventId(): number {
    return (this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as { m: number }).m;
  }

  /** #710 (gate② P2-1 fix): true ONLY for SQLite's own "no such table: events" error — the one
   *  case rawEventLedgerSummary below may honestly report as "nothing schema-independent to
   *  read" rather than propagate. Message-matched (SQLITE_ERROR's primary code, 1, is far too
   *  generic to gate on numerically — isBusyError/isReadOnlyFsError above both have a NARROW,
   *  specific extended-code family to check; a missing-table error has none, so an exact
   *  message match is the precise signal here), and deliberately scoped to the literal table
   *  name `events` — never a bare `/no such table/` that would also swallow an unrelated
   *  missing-table error as if it meant this one. */
  private static isMissingEventsTableError(e: unknown): boolean {
    return /no such table:\s*events\b/i.test(String((e as { message?: unknown }).message ?? ""));
  }

  /** #710: the schema-window-honesty read `status`/`events` fall back to when userVersion()
   *  disagrees with SCHEMA_VERSION and they refuse to interpret the DB's rows (fail-closed
   *  stands — this method is the ONLY thing either command reads off a mismatched-schema DB).
   *  Literally `SELECT COUNT(*)/MAX(id) FROM events` and NOTHING else — no join, no other
   *  column, no State method that could itself depend on a migration this build doesn't have.
   *  The `events` table's own `(id)` shape predates every migration recorded in MIGRATIONS, so
   *  this read is trustworthy across the whole schema window in both directions (older OR
   *  newer than SCHEMA_VERSION) — degraded, never blind.
   *
   *  #710 (gate② P2-1 fix): returns `null` (never throws) on EXACTLY ONE case — the `events`
   *  table itself missing (a DB so old/corrupt there is nothing schema-independent left to
   *  report), matched via `isMissingEventsTableError` above. Every OTHER failure — SQLITE_BUSY
   *  (a writer's lock landing after `userVersion()` already succeeded, a second contention
   *  window the same shape eventsPageFiltered/spendSummaryForDay's own doc describes),
   *  corruption, or any other query error — now PROPAGATES uncaught, exactly like every other
   *  State read. The original all-errors-become-null shape silently masked a locked-writer
   *  failure as "table missing", which would have rendered the WRONG refusal reason and, worse,
   *  skipped the caller's own busy-error handling (withBusyNormalization/busyResult) entirely —
   *  the schema-mismatch branch that calls this runs INSIDE withBusyNormalization specifically
   *  so a busy error here still gets normalized into the structured SqliteBusyError the CLI
   *  already renders correctly, the same as any other read. */
  rawEventLedgerSummary(): { count: number; maxId: number } | null {
    try {
      const row = this.db.prepare("SELECT COUNT(*) AS cnt, COALESCE(MAX(id), 0) AS maxId FROM events").get() as
        | { cnt: number; maxId: number }
        | undefined;
      return { count: row?.cnt ?? 0, maxId: row?.maxId ?? 0 };
    } catch (e) {
      if (State.isMissingEventsTableError(e)) return null;
      throw e;
    }
  }

  /** #688: the SUBJECT-scoped twin of maxEventId() above — util/heartbeat.ts's createHeartbeatGate
   *  uses this (via worker.ts's per-lane call site) as its spam-suppression progress id instead of
   *  the global MAX(id). Liveness is per-lane: with the global id, two concurrent lanes on the
   *  same cadence permanently starve one of them (whichever ticks second always sees the OTHER
   *  lane's just-appended id and skips, forever — not a race, deterministic; live batch-10
   *  evidence, 2026-08-06). Scoped to `$.worker` — the same payload field `dispatched`,
   *  `park-canary`, `worker-heartbeat`, `egress-suspect`, and the other worker-scoped kinds above
   *  already carry — so "this lane's own progress" is any event mentioning it, not just its own
   *  heartbeats. */
  maxEventIdForWorker(worker: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM events WHERE json_extract(payload, '$.worker') = ?`).get(worker) as {
      m: number;
    };
    return row.m;
  }

  /** #688: maxEventIdForWorker's twin for peripheral.ts's role sessions — the `role-session-*`
   *  event kinds (role-session-heartbeat, role-session-spawn-timeout, role-session-exit-lost) all
   *  key their subject on payload `$.name` (the unique `role-${roleId}-${uuid}` session name, not
   *  the shared `roleId`), so this is the correct per-session scope for the same reason
   *  maxEventIdForWorker is scoped to `$.worker`: multiple concurrent role sessions on the same
   *  cadence must not starve each other via a shared global id. */
  maxEventIdForRoleSession(name: string): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM events WHERE json_extract(payload, '$.name') = ?`).get(name) as {
      m: number;
    };
    return row.m;
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

  // ── #142: dashboard reads (docs/frontend-design.md §8) ─────────────────────────────────
  //
  // Four PURE READS the dashboard's read-only handle needs and nothing else in the engine has
  // an equivalent of. They live here rather than in dashboard/server.ts so there is exactly one
  // module that knows this schema's SQL — §8's requirement that `sapwood status` and the
  // dashboard "can never disagree" is only structural if neither re-derives the other's queries.

  /** The engine's liveness heartbeat, READ-ONLY — the staleness input to §8's engine-state
   *  derivation. Deliberately NOT touchLastTick() (#431's surviving writer), which WRITES: a
   *  spectator reading the clock must never move it. `null` means no heartbeat row exists at
   *  all — the engine has never ticked against this DB. */
  lastTickAt(): string | null {
    const row = this.db.prepare("SELECT last_tick_at FROM engine_session WHERE id = 1").get() as { last_tick_at: string } | undefined;
    return row?.last_tick_at ?? null;
  }

  /** How many events of one kind the ledger holds — §8's ring count is COUNT(kind='merged').
   *  A COUNT rather than eventsAfterId(0, [kind]).length so a growing history never costs a
   *  JSON.parse per row for a number the caller only wants to display. */
  countEvents(kind: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = ?").get(kind) as { n: number }).n;
  }

  /** One ascending page of the RAW event ledger — §8's `/api/events` transport. Unlike
   *  eventsAfterId (kind-filtered, id/ts dropped) the dashboard needs every kind plus the id
   *  (the poll cursor) and ts (the replay clock), so this deliberately takes no kinds filter.
   *  A row whose payload is not parseable JSON is served as `null` rather than throwing — one
   *  corrupt legacy row must not make the whole feed unreadable. */
  eventsPage(afterId: number, limit: number): { id: number; ts: string; kind: string; payload: unknown }[] {
    const rows = this.db.prepare("SELECT id, ts, kind, payload FROM events WHERE id > ? ORDER BY id LIMIT ?").all(afterId, limit) as {
      id: number;
      ts: string;
      kind: string;
      payload: string;
    }[];
    return rows.map((r) => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(r.payload);
      } catch {
        /* corrupt row — served as null, never a 500 for the whole page */
      }
      return { id: r.id, ts: r.ts, kind: r.kind, payload };
    });
  }

  /** #642: `sapwood events`' own pager — deliberately NOT eventsPage above (which takes no kinds
   *  filter, §8's raw-feed contract) nor eventsAfterId (which throws on an empty kinds list and
   *  has no LIMIT at all, the round-window full-read shape #123 needs). The kind filter is a SQL
   *  WHERE clause, so it is applied BEFORE `limit` — an `events --kind X --limit 50` gets up to
   *  50 kind-X rows, never up to 50 raw rows filtered down to fewer (the exact bug #642's AC
   *  calls out). `kinds` and `excludeKinds` are mutually exclusive by construction (the CLI
   *  parse layer rejects both together, same INVARIANT eventsAfterId's non-empty-kinds guard
   *  documents at its own call sites) — passing both here would silently AND them, so callers
   *  must not.
   *
   *  Runs inside readTransaction (above) — a short-lived read transaction under the handle's
   *  own `busy_timeout`, ONE consistent snapshot for both statements it issues.
   *
   *  #642 (Codex gate② round-1 P1 finding 1): the page query and the ledger TAIL (`MAX(id)`)
   *  are read TOGETHER, in the SAME transaction, and the caller (cli.ts's runEvents) uses THIS
   *  `tailId` — never a separate later `state.maxEventId()` call — to compute `nextSinceId` on
   *  an empty filtered page. A separate later call was the actual bug: SQLite's snapshot
   *  isolation means a write committed by ANOTHER connection AFTER this transaction's first
   *  read is invisible to every read inside it (including this one's own tail query, even
   *  though it runs SECOND) — so a matching event that lands between "the filtered page came
   *  back empty" and "some other later read of the max id" would have its id folded into
   *  nextSinceId by a naive two-call sequence, silently skipping it forever. Reading the tail
   *  HERE, inside the SAME transaction as the page query, means it can only ever reflect what
   *  the page query itself already saw (or missed) — a page and a tail that were computed
   *  a moment apart from each other can never disagree about what had already happened. */
  eventsPageFiltered(
    afterId: number,
    // #655: `issue` composes with `kinds`/`excludeKinds` (AC4) — a SEPARATE `AND`ed clause, not
    // folded into the kind/exclude-kind mutual exclusivity above (that pair is exclusive of EACH
    // OTHER, never of `issue`). Matches on the payload's `issue` field via `json_extract`, the
    // same approach this file's own escalation-lookup queries already use (e.g. the
    // `json_extract(payload, '$.issue')` clauses above) — reused rather than a second filtering
    // strategy invented for this one caller. Guarded by `json_valid(payload)` (gate② finding):
    // unlike those escalation-lookup queries, which only ever read rows THIS engine itself wrote
    // (append-only, always valid JSON), this filter runs over the WHOLE unbounded ledger range —
    // `json_extract` raises SQLite's "malformed JSON" error on an invalid payload, which aborts
    // the ENTIRE query, not just that one row, silently losing every later matching event too.
    // `json_valid` short-circuits false before `json_extract` ever runs on that row, so a corrupt
    // row simply never matches — the same "served as null, never a throw" stance this method's
    // own JS-side JSON.parse fallback below already holds for every OTHER filter shape.
    filter: { kinds?: readonly string[]; excludeKinds?: readonly string[]; issue?: number },
    limit: number,
  ): { rows: { id: number; ts: string; kind: string; payload: unknown }[]; tailId: number } {
    let clause = "";
    const params: (string | number)[] = [afterId];
    if (filter.kinds && filter.kinds.length > 0) {
      clause += ` AND kind IN (${filter.kinds.map(() => "?").join(",")})`;
      params.push(...filter.kinds);
    } else if (filter.excludeKinds && filter.excludeKinds.length > 0) {
      clause += ` AND kind NOT IN (${filter.excludeKinds.map(() => "?").join(",")})`;
      params.push(...filter.excludeKinds);
    }
    if (filter.issue !== undefined) {
      clause += ` AND json_valid(payload) AND json_extract(payload, '$.issue') = ?`;
      params.push(filter.issue);
    }
    params.push(limit);
    return this.readTransaction(() => {
      const rawRows = this.db
        .prepare(`SELECT id, ts, kind, payload FROM events WHERE id > ?${clause} ORDER BY id LIMIT ?`)
        .all(...params) as { id: number; ts: string; kind: string; payload: string }[];
      // Same transaction/snapshot as the page query above — see this method's own doc for why
      // that is exactly what closes the P1 finding-1 race.
      const tailRow = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as { m: number };
      const rows = rawRows.map((r) => {
        let payload: unknown = null;
        try {
          payload = JSON.parse(r.payload);
        } catch {
          /* corrupt row — served as null, never a 500/throw for the whole page (eventsPage's
             same stance) */
        }
        // #642 (AC5): a row's `kind` is passed through OPAQUE, never checked against this
        // binary's own event-kinds registry — an older `sapwood events` reading a newer engine's
        // DB must still return that engine's valid-but-unrecognized-here kind, not reject it.
        // Only the CLI's --kind/--exclude-kind ARGUMENT is validated against the registry (cli.ts
        // parseEventsArgs), never a returned row.
        return { id: r.id, ts: r.ts, kind: r.kind, payload };
      });
      return { rows, tailId: tailRow.m };
    });
  }

  /** #709: `sapwood events --tail N`'s pager — the newest N events matching `filter`, returned
   *  in the same ASCENDING (oldest-first) row order eventsPageFiltered above uses: the query
   *  itself runs `ORDER BY id DESC LIMIT ?` to pick the newest N ROWS cheaply (an index walk from
   *  the tail, not a full scan), then the JS side reverses that batch back to ascending — the
   *  --tail output must read top-to-bottom identically to every other events call, never
   *  newest-first.
   *
   *  Same filter shape and the same "kinds/excludeKinds mutually exclusive by construction
   *  (enforced by the CLI parse layer, not here), --issue ANDed on top with a json_valid guard so
   *  one corrupt payload can't abort the whole query, corrupt-payload rows served as null, an
   *  unrecognized kind passed through opaque" contract eventsPageFiltered's own doc spells out in
   *  full — duplicated here rather than factored into a shared helper because the two pagers
   *  differ in the one place that matters (ORDER BY direction, and no `afterId` floor at all), so
   *  each stays a single self-contained read the caller can reason about without cross-referencing
   *  the other.
   *
   *  `tailId` is the ledger's true head (MAX(id)), read in the SAME transaction/snapshot as the
   *  page query — never derived from the returned rows' own ids, and this is the load-bearing
   *  reason a --tail caller gets a correct cursor: a --kind-filtered --tail page's LAST row is not
   *  necessarily the ledger's newest event at all (a non-matching event can sit newer than every
   *  matching row this page returned), so `nextSinceId = rows[last].id` would let a follow-up
   *  `--since-id nextSinceId` silently re-show whatever unfiltered event landed between that last
   *  matching row and the true tail. Handing back the actual tail instead means "everything as of
   *  this snapshot has already been accounted for" stays true regardless of what the filter did.
   *  `--tail 0` is the degenerate case this whole method exists for (cli.ts's #709 cursor-
   *  bootstrap contract): `LIMIT 0` returns zero rows and `tailId` alone becomes the bootstrap
   *  value — "learn where NOW is" with no history read at all. */
  eventsTailFiltered(
    filter: { kinds?: readonly string[]; excludeKinds?: readonly string[]; issue?: number },
    n: number,
  ): { rows: { id: number; ts: string; kind: string; payload: unknown }[]; tailId: number } {
    let clause = "";
    const params: (string | number)[] = [];
    if (filter.kinds && filter.kinds.length > 0) {
      clause += ` AND kind IN (${filter.kinds.map(() => "?").join(",")})`;
      params.push(...filter.kinds);
    } else if (filter.excludeKinds && filter.excludeKinds.length > 0) {
      clause += ` AND kind NOT IN (${filter.excludeKinds.map(() => "?").join(",")})`;
      params.push(...filter.excludeKinds);
    }
    if (filter.issue !== undefined) {
      clause += ` AND json_valid(payload) AND json_extract(payload, '$.issue') = ?`;
      params.push(filter.issue);
    }
    params.push(n);
    return this.readTransaction(() => {
      const rawRows = this.db
        .prepare(`SELECT id, ts, kind, payload FROM events WHERE 1=1${clause} ORDER BY id DESC LIMIT ?`)
        .all(...params) as { id: number; ts: string; kind: string; payload: string }[];
      // Same transaction/snapshot as the page query above — see this method's own doc for why
      // that is exactly what keeps `tailId` honest against the filtered page it was read beside.
      const tailRow = this.db.prepare("SELECT COALESCE(MAX(id), 0) AS m FROM events").get() as { m: number };
      const rows = rawRows.reverse().map((r) => {
        let payload: unknown = null;
        try {
          payload = JSON.parse(r.payload);
        } catch {
          /* corrupt row — served as null, never a throw for the whole page (eventsPage's/
             eventsPageFiltered's same stance) */
        }
        // #709 (same stance as eventsPageFiltered AC5): a row's `kind` is passed through OPAQUE,
        // never checked against this binary's own event-kinds registry.
        return { id: r.id, ts: r.ts, kind: r.kind, payload };
      });
      return { rows, tailId: tailRow.m };
    });
  }

  /** #642 (upgraded by #645, remainder-accounting fix P1-3): the honest per-day spend split
   *  `status --json`'s spend section needs. Before #645 this classified purely by NAME HEURISTIC
   *  (does `worker` match a `workers.name` row?) because `spend_ledger` carried no durable
   *  attribution at all. Now the split is driven by the `actor_kind` column itself: `byWorker` is
   *  every row whose `actor_kind` is `worker` or `fix-leg` (a lane's own settled spend, grouped
   *  by lane name — same key `spentUsdForWorker` reads by), `byRole` is every VALIDLY-attributed
   *  `peripheral-role` row (role IS NOT NULL) grouped by its `role`, and `reviewUsd` is the
   *  `engine-review` total (#612's decisive-verdict spend, formerly only visible as an opaque
   *  `"<lane>:engine-review"` entry in the unclassified bucket).
   *
   *  `unclassifiedUsd` is the COMPLEMENT of those three valid buckets, computed as its OWN SQL
   *  SUM over "everything that does not validly match worker/fix-leg, peripheral-role-with-a-role,
   *  or engine-review" — not the old `actor_kind IS NULL`-only query. P1-3 (gate② finding): the
   *  old query let ANY row whose `actor_kind` matched none of the four known values — a
   *  corrupt/unrecognized string, or a `peripheral-role` row with no `role` at all — match NO
   *  bucket and vanish from BOTH the classified buckets AND `unclassifiedUsd` (fail-open: a real
   *  ledgered dollar simply disappeared from every total). The complement query can't have that
   *  failure mode: every row is `COALESCE(actor_kind, '')`-tested against the SAME three positive
   *  conditions the other three queries use, so a row lands in the complement bucket if and only
   *  if it landed in none of the others — there is no third place for it to go. `COALESCE` (not a
   *  bare `actor_kind IS NULL OR ...`) is deliberate: SQL's three-valued logic would otherwise let
   *  a NULL `actor_kind` make the whole `NOT (...)` expression evaluate to NULL instead of TRUE,
   *  silently excluding it from its own WHERE clause. Deliberately NO backfill and NO
   *  name-heuristic fallback for an unattributed row (pre-v1 doctrine, #645's issue): nothing
   *  here tries to recover what a row didn't durably claim, it only guarantees the total can
   *  never lose track of it.
   *
   *  `todayUsd` is deliberately the JS-side sum of the four bucket totals — NOT a fifth
   *  independent "SUM of every row" SQL query — so `todayUsd === sum(byWorker) + sum(byRole) +
   *  reviewUsd + unclassifiedUsd` holds BY CONSTRUCTION, in EXACT floating-point arithmetic (not
   *  merely "up to rounding"): a fifth independent total and four partition sums are two
   *  DIFFERENT floating-point reductions over the same rows and are not guaranteed to agree bit
   *  for bit (IEEE 754 addition is not associative) even though they partition the same set —
   *  same identity #642's gate②-round-1 P1 finding 3 pinned, preserved exactly. Same day window
   *  as `dailySpendUsd` (ts-prefix match), one `readTransaction` snapshot so a concurrent writer
   *  can never split the reads across two different moments. */
  spendSummaryForDay(now: Date): {
    todayUsd: number;
    byWorker: { worker: string; usd: number }[];
    byRole: { role: string; usd: number }[];
    reviewUsd: number;
    unclassifiedUsd: number;
  } {
    const dayPrefix = now.toISOString().slice(0, 10);
    return this.readTransaction(() => {
      const byWorkerRaw = this.db
        .prepare(
          `SELECT s.worker AS worker, SUM(s.usd) AS usd
           FROM spend_ledger s
           WHERE s.ts LIKE ? AND s.actor_kind IN ('worker', 'fix-leg')
           GROUP BY s.worker ORDER BY usd DESC, worker`,
        )
        .all(`${dayPrefix}%`) as unknown as { worker: string; usd: number }[];
      // #645 P1-3: `role IS NOT NULL` — a malformed `peripheral-role` row with no role is not a
      // valid attribution (it would otherwise render as a bogus `{ role: null, ... }` entry);
      // its spend belongs in the complement bucket below, same as an unrecognized actor_kind
      // value.
      const byRoleRaw = this.db
        .prepare(
          `SELECT s.role AS role, SUM(s.usd) AS usd
           FROM spend_ledger s
           WHERE s.ts LIKE ? AND s.actor_kind = 'peripheral-role' AND s.role IS NOT NULL
           GROUP BY s.role ORDER BY usd DESC, role`,
        )
        .all(`${dayPrefix}%`) as unknown as { role: string; usd: number }[];
      const reviewRow = this.db
        .prepare(`SELECT COALESCE(SUM(s.usd), 0) AS usd FROM spend_ledger s WHERE s.ts LIKE ? AND s.actor_kind = 'engine-review'`)
        .get(`${dayPrefix}%`) as { usd: number };
      // #645 P1-3: the COMPLEMENT of the three positive conditions above, tested against the
      // SAME `COALESCE(actor_kind, '')` value each row is classified by — a NULL, an unknown
      // string, or a role-less `peripheral-role` row all fall through to here, nothing vanishes.
      const unclassifiedRow = this.db
        .prepare(
          `SELECT COALESCE(SUM(s.usd), 0) AS usd
           FROM spend_ledger s
           WHERE s.ts LIKE ?
             AND COALESCE(s.actor_kind, '') NOT IN ('worker', 'fix-leg', 'engine-review')
             AND NOT (COALESCE(s.actor_kind, '') = 'peripheral-role' AND s.role IS NOT NULL)`,
        )
        .get(`${dayPrefix}%`) as { usd: number };
      // Re-shaped into ordinary objects — same null-prototype reason spendByModelForDay documents.
      const byWorker = byWorkerRaw.map((r) => ({ worker: r.worker, usd: r.usd }));
      const byRole = byRoleRaw.map((r) => ({ role: r.role, usd: r.usd }));
      const reviewUsd = reviewRow.usd;
      const unclassifiedUsd = unclassifiedRow.usd;
      const todayUsd =
        byWorker.reduce((sum, r) => sum + r.usd, 0) + byRole.reduce((sum, r) => sum + r.usd, 0) + reviewUsd + unclassifiedUsd;
      return { todayUsd, byWorker, byRole, reviewUsd, unclassifiedUsd };
    });
  }

  /** `now`'s UTC calendar day of spend, grouped by model — §8's `spend.byModel`. Same day
   *  window as dailySpendUsd (ts-prefix match), so the group sums and the headline total can
   *  never disagree. KNOWN CEILING (recordSpend's own shape, not this query's): a settlement
   *  writes one row per model but puts the leg's whole `usd` on the FIRST row, so a multi-model
   *  leg attributes its cost to one of its models while the token counts stay per-model. */
  spendByModelForDay(now: Date): { model: string; usd: number; inputTokens: number; outputTokens: number }[] {
    const dayPrefix = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const rows = this.db
      .prepare(
        `SELECT model, COALESCE(SUM(usd), 0) AS usd,
                COALESCE(SUM(input_tokens), 0) AS inputTokens, COALESCE(SUM(output_tokens), 0) AS outputTokens
         FROM spend_ledger WHERE ts LIKE ? GROUP BY model ORDER BY usd DESC, model`,
      )
      .all(`${dayPrefix}%`) as unknown as { model: string; usd: number; inputTokens: number; outputTokens: number }[];
    // Re-shaped into ordinary objects: node:sqlite hands back null-prototype rows, which
    // deep-equal comparisons (and any structuredClone-style consumer) treat as a different type.
    return rows.map((r) => ({ model: r.model, usd: r.usd, inputTokens: r.inputTokens, outputTokens: r.outputTokens }));
  }

  /** One ascending page of the RAW spend ledger — §8's `/api/spend` transport (#360), the same
   *  id-cursor paging contract eventsPage gives events, so replay can walk both feeds with one
   *  cursor discipline. Rows are the ledger's own columns, nothing derived: a spend panel that
   *  wants a total sums these, it never asks the server for a number it cannot re-derive. #645
   *  P2-2: `actor_kind`/`role`/`estimated` are exposed too (SpendLedgerRow's own doc) — this
   *  method's "the ledger's own columns" claim was false without them; they were added to the
   *  table by #645 but never threaded through this paging read until now. */
  spendPage(afterId: number, limit: number): SpendLedgerRow[] {
    const rows = this.db
      .prepare(
        `SELECT id, ts, worker, issue, usd, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
                actor_kind, role, estimated
         FROM spend_ledger WHERE id > ? ORDER BY id LIMIT ?`,
      )
      .all(afterId, limit) as unknown as {
      id: number;
      ts: string;
      worker: string;
      issue: number;
      usd: number;
      model: string;
      input_tokens: number;
      output_tokens: number;
      cache_read_tokens: number;
      cache_creation_tokens: number;
      actor_kind: string | null;
      role: string | null;
      estimated: number | null;
    }[];
    // Re-shaped into ordinary objects for the same null-prototype reason spendByModelForDay
    // documents, and camelCased to match every other token count on the §8 wire.
    return rows.map((r) => ({
      id: r.id,
      ts: r.ts,
      worker: r.worker,
      issue: r.issue,
      usd: r.usd,
      model: r.model,
      inputTokens: r.input_tokens,
      outputTokens: r.output_tokens,
      cacheReadTokens: r.cache_read_tokens,
      cacheCreationTokens: r.cache_creation_tokens,
      // #645 P1-3's own "never guess" stance: an unrecognized/legacy `actor_kind` string is
      // passed through as-is here (this is the RAW paging transport, not the classified
      // read-model split) rather than silently coerced to null — only a genuinely absent column
      // renders null.
      actorKind: (r.actor_kind as SpendActorKind | null) ?? null,
      role: r.role ?? null,
      estimated: r.estimated === null ? null : r.estimated === 1,
    }));
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

  /** Every round, ascending, with its artifact LEFT-JOINed — §8's `/api/rounds` (#360).
   *
   *  The `rounds` table is the SPINE, not `round_artifacts`: a round that closed without an
   *  artifact (pre-#123 history, or a crash between closeRound and saveRoundArtifact) is still
   *  a round that happened, and dropping it would silently shorten the replay timeline. Such a
   *  row comes back with `schemaVersion: null` / `artifact: null` and renders tally-less.
   *
   *  `eventCount` is the round's own slice of the ledger — its #123 start cursor exclusive, the
   *  NEXT round's start cursor inclusive (the newest event id for the last round). That keeps
   *  the counts a partition of the ledger rather than the unbounded `id > cursor` window
   *  round-artifact.ts uses at close time, when there is no next round yet. Events before the
   *  first round belong to no round and are counted by none. */
  listRounds(): RoundListRow[] {
    const rows = this.db
      .prepare(
        `SELECT r.round_id, r.status, r.started_at, r.ended_at, r.start_event_id, r.start_spend_id,
                a.schema_version, a.json,
                (SELECT COUNT(*) FROM events e
                  WHERE e.id > r.start_event_id
                    AND e.id <= COALESCE(
                      (SELECT MIN(n.start_event_id) FROM rounds n WHERE n.round_id > r.round_id),
                      (SELECT COALESCE(MAX(id), 0) FROM events))) AS event_count
         FROM rounds r LEFT JOIN round_artifacts a ON a.round_id = r.round_id
         ORDER BY r.round_id`,
      )
      .all() as unknown as {
      round_id: number;
      status: RoundStatus;
      started_at: string;
      ended_at: string | null;
      start_event_id: number;
      start_spend_id: number;
      schema_version: number | null;
      json: string | null;
      event_count: number;
    }[];
    return rows.map((r) => {
      let artifact: unknown = null;
      if (r.json !== null) {
        try {
          artifact = JSON.parse(r.json);
        } catch {
          /* engine-written and schema-validated before storage — a corrupt row degrades to the
             artifact-less rendering, never a 500 for the whole timeline */
        }
      }
      return {
        roundId: r.round_id,
        status: r.status,
        startedAt: r.started_at,
        endedAt: r.ended_at,
        startEventId: r.start_event_id,
        startSpendId: r.start_spend_id,
        eventCount: r.event_count,
        schemaVersion: artifact === null ? null : r.schema_version,
        artifact,
      };
    });
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
  /* #403 (F25): `now` optional for the same reason as setRoundMarker's above — a caller-supplied
   * timestamp, not a clock seam; the fallback is the deliberate audit wall-clock. */
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
