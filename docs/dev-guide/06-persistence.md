# 06 — Persistence layer (SQLite)

This describes the final schema after every migration in `engine/src/state/state.ts`; it is not migration history. It is a maintainer deep dive: read it before changing state, recovery, or accounting code — a contributor whose change doesn't touch durable state only needs the crash-consistency rules at the end.

## Engine choice & files

`State` uses Node's built-in `node:sqlite`, so the engine has no SQLite npm or native-build dependency. Its default database is `data/sapwood.sqlite`; SQLite may maintain adjacent `data/sapwood.sqlite-wal` and `data/sapwood.sqlite-shm` files. Writable opens set WAL mode and run migrations; the conductor remains the serial writer while status readers can proceed concurrently (`State` constructor, `engine/src/state/state.ts`).

`State(path, { readOnly: true })` opens query-only and performs no migration; the CLI status caller checks the on-disk version before interpreting rows. On a filesystem where a WAL reader cannot create coordination files, `openReadOnly()` falls back to an immutable main-file snapshot and warns that live WAL rows may be absent (`engine/src/state/state.ts`, `engine/src/cli.ts`).

## Schema version & migrations

`MIGRATIONS` is an ordered array at `engine/src/state/state.ts`; array index N upgrades SQLite `PRAGMA user_version` from N to N+1. `SCHEMA_VERSION` is exactly `MIGRATIONS.length` (`engine/src/state/state.ts`) and is currently **21**.

Migrations are forward-only and transactional. Never edit a migration that may have shipped: append a function, preserve existing data, add/update a real upgrade test in `engine/src/state/state.test.ts`, and review the crash/restart and read-only-version behavior. `input_manifest_new` appears only inside a table-rebuild migration and is renamed back; it is not a final table.

## Tables

### Lane execution and accounting

#### `workers`

One durable row per lane/session lineage. Meaningful columns are `name` (primary key), `issue`, `session_id`, lifecycle `state` (`running`, `driving`, `fixing`, `done`, `failed`, `handoff`), start/end timestamps, and `pr`. Review state includes a legacy `review_triggered` flag plus the authoritative `review_triggered_head`/`review_triggered_at` pin and advisory `review_fallback_head`/`review_fallback_kind`. Re-entry/resume fields are `gated_reentry_attempts`, `gated_reentry_capped`, `gated_escalation_labeled`, `resume_attempts`, and `resume_capped`; fix-loop fields are `fix_rounds` and `fixing_handoff`. Nullable `est_cost_usd`, `context_tokens`, and JSON `token_composition` are a live display cache, never accounting.

The conductor writes transitions through `upsertWorker()`, trigger/fallback/telemetry methods, `settleTerminalWorker()`, and canary registration. The conductor, CLI status, round execution, reconciliation, and artifacts read rows through state queries. A row begins at dispatch, changes in place across reclaim/gate/fix/resume, and remains as terminal history; it is not deleted during ordinary completion (`engine/src/state/state.ts`).

#### `events`

Append-only ordered engine history: autoincrement `id`, ISO `ts`, string `kind`, and JSON-text `payload`, with an index on `kind`. `State.appendEvent()` writes `{kind,payload}` with the current timestamp; conductor, rounds, role apply/degrade paths, reconciliation, proxy/response settlement, retro, artifacts, and dashboard-facing readers consume ordered rows.

Payloads are event-specific JSON objects. Stable conventions are identifiers such as `worker`, `issue`, `pr`, and `round_id`, plus transition/outcome fields such as `next`, `reason`, or `mode`. Consumers must validate the payload shape they use; `eventsSince()`/`eventsAfterId()` only parse JSON and preserve ID order. Rows live for the database lifetime and provide replay/audit input (`appendEvent`; `eventsAfterId`).

#### `spend_ledger`

Append-only settled spend, one row per worker/model usage record: `id`, `ts`, `worker`, `issue`, `usd`, `model`, and input/output/cache-read/cache-creation token counts. `recordSpend()` and atomic terminal settlement write it after a worker leg ends; ceiling evaluation, CLI status, per-worker totals, stop conditions, round artifacts, and future dashboard readers aggregate it. Rows are never updated; unknown/uncaptured model data uses the schema defaults.

### Engine controls and recovery

#### `engine_session`

Singleton row `id=1` with `started_at` and `last_tick_at`. `engineSessionStart()` creates/refreshes it; ceiling evaluation reads it. A sufficiently long tick gap begins a new continuous engine session, while short crash/restart gaps preserve the wall-clock ceiling window.

#### `ceiling_breach`

Singleton `id=1`, JSON-encoded reason list in `reason`, and first-detection `at`. The conductor inserts/updates it when kill-switch, daily-cost, or wall-clock reasons become active, reads `at` to keep the drain deadline from resetting, and clears it only when no breach remains. The row therefore exists for one active breach episode.

#### `pending_rollbacks`

Durable board-recovery queue: `id`, `issue`, target board state, reason, retry `attempts`, `created_at`, and `last_attempt_at`. The conductor inserts the intent before attempting dispatch rollback or dead-lane requeue, retries rows each tick, and clears on success or bounded escalation. A row lives from write-ahead intent through successful forge repair or terminal escalation.

#### `pending_thread_writes`

Durable fix-response write queue: `id`, lane `worker`, `issue`, `pr`, `thread_id`, `reply`, `resolution` (`addressed` or `disputed`), independent `reply_posted`/`resolved` progress, `attempts`, idempotent `batch_key`, `fix_rounds`, and timestamps. `settleTerminalWorker()` enqueues a validated fix-leg batch atomically with terminal state/events; conductor/fix-response code posts replies and resolutions, stores receipts as events, retries failures, and clears a row only after all required steps complete. The unique `(batch_key, thread_id)` index makes duplicate settlement insertion a no-op.

#### `park_state`

At most one row for each environment source (`llm`, `forge`): first `reason`, optional `trigger_issue`, `entered_at`, `last_probe_at`, `probe_attempts`, optional `escalated_at`, and optional LLM `canary_worker`. The conductor inserts without resetting an existing episode, schedules/bump probes, latches escalation, assigns/settles canaries, and clears a source only after demonstrated recovery. Restart reads the same rows and remains parked without a separate sentinel.

### Rounds and decision evidence

#### `rounds`

One row per round: autoincrement `round_id`, current `phase`, `status`, phase `artifact_ref`, start/update/end timestamps, and `start_event_id`/`start_spend_id` ledger cursors. `runRounds()` starts, resumes, advances, marks, and closes rows. Peripheral stubs and round-artifact construction read them. One row remains `in_progress` across a crash; it becomes `done` only after `closed`, and is retained as history.

#### `round_artifacts`

One canonical artifact per round: primary-key `round_id`, `schema_version`, validated JSON text, and `updated_at`. `persistRoundArtifact()` upserts it before deriving Markdown; harvest, retro/digest, and inspection readers consume it. Re-running persistence for the same round replaces the canonical row rather than creating duplicates.

#### `input_manifest`

One row per engine-controlled input channel per session attempt: `id`, `round_id`, `phase`, `role`, `session`, positive `attempt`, `channel`, success `ok`, optional content `version`, optional `total`/`rendered`/`omitted` counts, three-state `truncated` (true/false/unknown), optional `detail`, and `ts`. A unique dimension index covers round/phase/role/session/attempt/channel.

Alignment and architect paths derive attempt numbers from durable rows and append best-effort records; inspection/tests read by round. It is observability, not a gate. Each role attempt adds channel rows that remain historical; failed reads are represented with `ok=0` and detail rather than omitted.

#### `context_manifests`

One ambient context snapshot per round/phase/role/session/attempt: `id`, that five-part identity, `recorded_at`, and schema-validated JSON assembled by `roles/context-manifest.ts`. `RoleRunner` records it; state inspection and comparative readers fetch it. The unique identity upserts a repeated capture for the same attempt, making crash-rerun recording idempotent.

### Forge proxy audit

#### `forge_proxy_journal`

One row per proxy call, uniquely ordered by round/phase/role/session/attempt/`seq`. It records tool and proxy version; canonical args, repo scope, caps; remaining call/byte budgets; status (`intent`, `fetched`, `error`, `delivered`); upstream IDs/timestamp/counts/truncation; canonical response, UTF-8 byte size, content hash; sanitized error/timeout; and request/fetch/delivery timestamps.

`proxy/journal.ts` and `State` write intent before the upstream read, then persist response or error, and only then mark successful delivery. Proxy budget/completeness checks, fix-response evidence, audit readers, and bundle creation read it. Rows are append-on-call and update only through their status cursor; intent-only rows are valid crash evidence and conservatively consume a call.

#### `forge_proxy_bundles`

Content-addressed frozen evidence index: SHA-256 `hash` primary key, round/phase/role/session identity, optional `decision_ref`, `byte_size`, optional on-disk `path`, and `created_at`. `persistEvidenceBundle()` writes JSON under `data/proxy-bundles/` and indexes it; decision/audit readers retrieve by hash. Re-persisting identical content keeps the first row through conflict-ignore.

## Crash-consistency rules

These are requirements for state-changing code:

1. **Persist forge intent before the forge write; complete local terminal state only after the externally visible write is known.** Rollbacks and thread responses use durable queues; terminal worker settlement can atomically include dependent queue/events (`pending_rollbacks`, `pending_thread_writes`, `settleTerminalWorker()`).
2. **A durable artifact needs explicit crash-rerun semantics.** Use an idempotency key, upsert, unique dimension, or phase marker. A process-local boolean is not recovery state (`rounds.artifact_ref`, `round_artifacts`, manifest unique keys, proxy bundle hash).
3. **Event deduplication is not signal deduplication.** Prevent duplicate external comments/labels/PRs with durable success/intent state; suppressing a second event alone does not prove the external write occurred. Conversely, retries may need distinct attempt events while sharing one external idempotency key.
4. **Reconciliation is deterministic and last-valid-write wins.** Readers such as event-backed pool selection scan in ID order and use the last valid record for the scoped round; invalid latest payloads fail closed rather than resurrecting an older decision (`engine/src/loop/align.ts`).
5. **Ledger windows use IDs, not timestamps.** Rounds capture maximum event/spend IDs and read strictly greater rows, avoiding equal-timestamp boundary ambiguity (`rounds.start_event_id`, `rounds.start_spend_id`).
