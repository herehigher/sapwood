# The round summary artifact (#123)

Every closed round leaves one **engine-built, schema-validated JSON record** of its full
mechanical history — dispatches, merges, retries, review-fallback episodes, escalations,
spend, degraded phases, the retro proposal outcome, and the PO/aligning phase's
decomposition summary. It is assembled purely from sapwood's own durable event ledger at
round close (`engine/src/loop/round-artifact.ts`), never from a session's output and never from
a live GitHub query.

**JSON is the single source of truth.** The markdown view is a deterministic *render* of
the validated JSON object — never independently authored — and is what the harvest prompt
consumes (`{{round.artifact}}`, capped by
[`roles.harvest.artifactMaxChars`](../guide/configuration.md#roles)).

## Where it lives

| Form | Location | Notes |
|---|---|---|
| JSON (source of truth) | `round_artifacts` table in the state DB, keyed by `round_id` | One row per closed round; upserted, so a crash-rerun of the close path overwrites rather than duplicates. `schema_version` lets readers detect older shapes without parsing. |
| Markdown (derived view) | `data/rounds/round-<id>.md` | Written at round close for on-disk runs only (an in-memory state has no data dir). Always re-derived from the just-validated JSON. |

## The schema — the dashboard (#17) data contract

`RoundArtifactSchema` (zod, `engine/src/loop/round-artifact.ts`) **is** the #17 dashboard's
round-view data contract: any change to it is a change to that contract and must bump
`ROUND_ARTIFACT_SCHEMA_VERSION`. Top-level fields (v1):

| Field | Type | Meaning |
|---|---|---|
| `schemaVersion` | `1` | Contract version. |
| `roundId`, `startedAt`, `endedAt` | int, ISO string, ISO string \| null | `endedAt` is null only on a mid-round (harvest-time) build; the persisted artifact always sets it. |
| `dispatches` | `{issue, worker}[]` | Every lane this round dispatched, in ledger order. |
| `merges` | `{issue, worker, pr}[]` | Every autonomous merge. |
| `prsOpened`, `prsMerged`, `issuesClosed` | int | Throughput counters (PR-opened = first reclaim transition into `driving`; issues-closed rides the worker `Closes #N` convention). |
| `spendUsd`, `roundBudgetUsd` | number | Ledgered spend since round start vs. the configured round budget. |
| `retries` | object | `gatedReentries` / `gatedReentryCapped` (#147) and `rollbacksRecovered` / `rollbacksEscalated` (#31). |
| `reviewRounds` | object | Reviewer-failover episodes (#54): `reviewerFallbackSwitches` / `reviewerFallbackReverts`. |
| `escalations` | object | `needsHuman` (deduped issue numbers, first-seen order — drive gate② + gate⓪ plan-review), `ceiling`, `driveNoPr` counts. |
| `handoffs` | int | Soft-budget graceful handoffs. |
| `degradedPhases` | `{phase, outcome, session}[]` | Every peripheral degradation this round (po-align/po-triage/architect/harvest/retro). |
| `roundStops` | `{name, detail}[]` | Round-level stop-condition hits. |
| `retro` | object | The retro proposal outcome: `opened {pr, branch}` or `degraded {branch, title, reason}` or neither. |
| `align` | object \| null | The PO/aligning phase's own summary: `created {issue, title, hasPlan}[]` + `triaged {issue, drafted}[]`. Null when no summary was recorded (degraded align). |

Scope: strictly the events between the round's own open and close. Run-scoped events
(standby waits, #125) are never part of a round's artifact.

## Who consumes it

- **Harvest** (`{{round.artifact}}`): the artifact replaced harvest's mechanical-aggregation
  duties — the session keeps only judgment (what to *say* about each needs-human issue).
  The pre-#123 `harvest-summary` event is gone; the persisted row is the machine-readable
  round record.
- **Architect**: receives the aligning phase's structured decomposition detail
  (`align-summary` → `{{round.alignedGoals}}`) instead of a pointer note. It also receives the
  **previous** round's `merges` (issue/PR/worker only — no titles, no files-touched, neither is
  persisted anywhere the ledger reads from) as `{{round.lastMerged}}` (#132) — post-review context
  for architectural drift, bounded by `roles.architect.lastMergedMaxChars`. First round / no prior
  round / a missing prior-round artifact all render an explicit placeholder, never an empty
  substitution or a live forge read.
- **Dashboard (#17)**: reads `round_artifacts` rows directly; this schema is the contract.
