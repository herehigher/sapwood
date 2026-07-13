# The role paradigm

sapwood's deterministic engine (`runRounds`, `engine/src/round.ts`) is the only piece
of code that ever writes to GitHub. Every Claude session it spawns — the six
peripheral roles below, plus the worker (out of scope here; see
[`security.md`](security.md)) — is a scoped, bounded subordinate whose judgment
reaches GitHub only through the engine. This doc is the contract every one of those
role sessions satisfies today, and the contract a v1.0 user-defined role (governed
extension points, issue #134) must satisfy to be added safely.

Audience: sapwood developers modifying an existing role, and v1.0 extension authors
writing a new one. This is durable knowledge — what's true on `main` right now — not a
history of how it got here; provenance is a one-line `#nn` reference only. See
[`docs/system-review-2026-07.md`](system-review-2026-07.md) (M5 item 10) for the
review that asked for this doc, and [`docs/PLAN.md`](PLAN.md)'s "Validation depth ∝
decision weight" section for the standing structured-output write inventory this doc
complements (that table tracks *what each role's output drives*; this doc explains
*the shape every role's session/output/idempotency/escalation must have*).

## The five-element contract

Every role in this codebase is defined by five elements. A new role (built-in or,
post-v1.0, user-defined) must specify all five before it ships:

1. **Responsibility** — what judgment the role's session contributes, and when in the
   round it runs.
2. **Write scope** — which tier of the write-scope ladder (below) the role's writes
   fall into, and which engine module is the choke point if it's tier 3.
3. **Marker idempotency** — the role's `PeripheralStub.run()` rerun-not-resume
   contract: what a non-null incoming marker means, and what re-invoking with a fresh
   marker does.
4. **Output schema + fail-closed validation** — the structured-output shape the
   session returns, the zod schema (or scratch-file grammar) that validates it, and
   what happens when validation fails.
5. **Escalation path** — what the role does when its session degrades (crashes,
   times out, or produces output that never validates): degrade-and-proceed
   (advisory) vs. escalate-needs-human (gate-blocking).

## The write-scope tier ladder

Three tiers, from strongest to weakest containment (`docs/system-review-2026-07.md`
Principle 4). Every role's writes sit at exactly one tier; prefer moving a future
role's writes UP this ladder over adding a pattern-level deny.

1. **Unreachable** — no tool channel exists at all. All six peripheral roles in this
   doc hold `ROLE_ALLOWED_TOOLS = ""` (`engine/src/peripheral.ts:42`) or the
   worker-class-but-`gh`-free `RETRO_ALLOWED_TOOLS`
   (`engine/src/retro.ts:68`, no `gh` entry) — there is no shell for the session to
   reach `gh` through, so a whole bypass class (short-flag aliases, quoting escapes)
   is structurally moot rather than pattern-denied (#110; see
   [`security.md`](security.md#issues-only-role-sessions-carry-no-shell-110)). This is
   the strongest tier because there is nothing to intercept — the capability doesn't
   exist to begin with.
2. **Intercepted** — a tool channel exists, but a fail-closed hook blocks the
   dangerous call before it executes. This is `guard.ts`'s PreToolUse hook, wired into
   every worker session (`worker.ts`) and, defense-in-depth, every role session too
   (`peripheral.ts:200`, `guardSettings`). Reference-only for this doc: **do not
   modify `guard.ts` or its wiring** — it is human-merge-only
   (`CLAUDE.md` non-negotiables). None of the six roles below rely on this tier as
   their primary boundary; it is the backstop under tier 1's absence-of-capability
   for roles, and the actual boundary for the worker (which does hold real write
   grants).
3. **Choke point** — the role's session emits untrusted structured output (a
   sentinel-delimited JSON block, `structured-output.ts`, or retro's scratch file);
   exactly one engine module parses it, validates it fail-closed against a zod schema
   (plus role-specific content/candidate-set invariants), and is the ONLY code that
   calls the corresponding `IForge` write. This is where `#110`'s "engine performs
   every GitHub write itself" design lives — see the per-role sections below for each
   role's own choke-point module and `docs/PLAN.md`'s "Validation depth ∝ decision
   weight" table for the full output-field → write → validation inventory.

A role's write scope is the tier of its *heaviest* write — e.g. the PO session holds
no tool grant (tier 1) for everything, but its `createIssue`/`addLabel`/
`updateIssueBody` calls all originate from the engine at tier 3, keyed off its
validated output.

## Marker idempotency (rerun-not-resume)

Every role implements `round.ts`'s `PeripheralStub` contract
(`engine/src/round.ts:50-52`):

```ts
run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }): Promise<{ marker: string }>
```

`round.ts`'s own module doc states the invariant every role's `run()` must honor: a
crash mid-phase leaves the round's persisted phase cursor at that exact phase; on
restart, `round.ts` re-invokes the SAME phase's stub fresh — never resuming
mid-session state. **Idempotency is the stub's own job, keyed by `marker`**: `null`
means no prior attempt this round externalized anything yet; non-null means a prior
attempt already externalized this phase's work (a comment, a document, an issue), so
the correct response is "return the same marker unchanged, do no further writes" —
never re-running the session or duplicating a side effect. All six roles below use the
same `<!-- sapwood:round:{roundId}:{phase} -->` marker convention
(e.g. `align.ts`'s `alignMarker`, `architect.ts`'s `architectMarker`) and the same
one-line guard at the top of `run()`: `if (marker != null) return { marker };`.

This is coarse — round-phase granularity, not per-issue — but deliberately so: a
partially-worked round's remaining candidates are picked up next round (or once
dispatchable again) rather than risking duplicate sessions/writes on a resume.

## Per-role sections

### po (aligning)

| Element | Detail |
|---|---|
| Responsibility | Round-open goal decomposition (`align` mode: reads the north-star goal file + round milestone, creates new issues) and a round-start plan-triage pass (`triage` mode: drafts a verification plan directly into an existing plan-less issue's body). Runs first in the round sequence. `engine/src/align.ts:240` `createAligningStub`. |
| Write scope | Tier 1 (unreachable): `PO_ALLOWED_TOOLS = ROLE_ALLOWED_TOOLS = ""` (`engine/src/peripheral.ts:42,63`) — no tool grant of any kind. Tier 3 choke point: `align.ts:createAligningStub` (`engine/src/align.ts:240`) is the only caller of `forge.createIssue`/`forge.addLabel`/`forge.updateIssueBody`/`forge.addIssueComment` on the PO's behalf. A created issue's `(title, body)` signature has no label field — structurally cannot carry `plan:approved`/`verify:n/a` at creation. Never calls `forge.setBoardStatus` — locked decision "only a human confirms Ready" holds structurally, not by convention. |
| Marker idempotency | `alignMarker(roundId)` (`engine/src/align.ts:46`), the standard `<!-- sapwood:round:N:aligning -->` convention. Round-phase granularity; additionally, triage is naturally per-issue idempotent — a successfully drafted issue carries a plan section and no longer matches `getIssuesNeedingPlanTriage`'s candidate query on a later run (`align.ts:327-330`). |
| Output schema + validation | Two independent zod schemas around the shared sentinel shape: `AlignMetadataSchema` (`align.ts:95`, array of `{title}`, per-issue bodies split from the BODY block via a nested `<<<ISSUE>>>`/`<<<END_ISSUE>>>` convention, `splitAlignIssueBodies`, `align.ts:110`) and `TriageMetadataSchema` (`align.ts:96`, `{issue}` + full revised body). `validateAlignOutput` (`align.ts:139`) rejects duplicate titles in one batch outright. `validateTriageOutput` (`align.ts:185`) deliberately does NOT content-check for a verification-plan section — a planless draft is a normal per-issue outcome (fenced `needs-human`/re-matched next round), not an invalid session attempt. |
| Escalation path | Advisory, degrade-and-proceed — pre-Ready, low stakes. A session that fails twice or never validates fires `po-degraded` (align mode) or `triage-degraded` (triage mode) as a durable state event plus a stderr line (`align.ts:207-217`, via `peripheral.ts`'s shared `runSessionWithRetry`); the round is never wedged, and the next round retries naturally. A schema-valid-but-still-planless triage draft is its OWN degradation shape (`triage-degraded`, `no-plan-after-draft`, `align.ts:386-392`) — distinct from a malformed/failed session. |

### architect (architecting)

| Element | Detail |
|---|---|
| Responsibility | One cross-issue design/review pass between goal alignment and dispatch: reads the round's whole candidate batch (issues awaiting gate⓪) plus the north-star goal file's `## Architecture` chapter, produces a round design note, and flags any candidate whose approach contradicts locked architecture (comment; `blocked` label if severe). `engine/src/architect.ts:306` `createArchitectStub`. |
| Write scope | Tier 1 (unreachable): no tool grant (`ROLE_ALLOWED_TOOLS = ""`). Tier 3 choke point: `architect.ts:createArchitectStub` (`architect.ts:306`) is the sole caller of `forge.addIssueComment`/`forge.addLabel(blocked)` for this role. **The one role whose session chooses write TARGETS from a pool** (every other role writes only what it was dispatched for) — `validateArchitectOutput` (`architect.ts:236`) independently verifies every flagged issue number is a member of the exact candidate set the session's prompt showed it, fail-closed and atomic: one out-of-set number invalidates the WHOLE output, never a partial apply (`architect.ts:271-279`). |
| Marker idempotency | `architectMarker(roundId)` (`architect.ts:77`), standard convention. No candidates this round → marker set, no session run at all (`architect.ts:326`). |
| Output schema + validation | `ArchitectMetadataSchema` (`architect.ts:166`, `contradictions: [{issue, severe}]`); free-text design note + per-issue explanations travel in the BODY block via an architect-owned `<<<CONTRADICTION #N>>>` sub-delimiter, parsed by `parseArchitectBody` (`architect.ts:191`) with its own fail-closed containment (empty design note, empty/duplicate section, or a residual embedded sub-delimiter after split all reject). `validateArchitectOutput` (`architect.ts:236`) chains: schema → non-empty body → sub-format parse → metadata/body section-set match → the candidate-set invariant. |
| Escalation path | Advisory, degrade-and-proceed — no dispatch decision depends on the design note. A session that fails twice or never validates fires `architect-degraded` (`architect.ts:294-298`, via `runSessionWithRetry`); the round proceeds with no design note, marker still set (a rerun will not retry this phase). |

### plan-reviewer + plan-drafter (plan_review) — one gate⓪ adversarial pair

Documented as one unit because the pair's whole point is an adversarial cycle — author
≠ approver — not because their identities are unified. **They remain two separate
sessions with two separate prompts** (`prompts/plan-reviewer.md`,
`prompts/plan-drafter.md`): the reviewer never drafts a body, and the drafter never
applies a label or approves. `roles.planReviewer.enabled` (`config.ts:237`) is
gate⓪'s ONE unit switch — the drafter has no `enabled` toggle of its own because it
only ever runs from inside the plan_review phase (`round-defaults.ts:109-110`).

**The cycle** (`engine/src/plan-review.ts:279` `reviewOneIssue`, one per Ready-lane
candidate issue): the reviewer session judges the issue's CURRENT body (refetched
every cycle, never a phase-start snapshot — `plan-review.ts:318-320`) and returns one
of three decisions: `approve` (write any body revision, apply `plan:approved`, done),
`verify_na` (apply `needs-human` THEN `verify:n/a`, ordering-invariant so a partial
double-label failure fails closed non-dispatchable — `plan-review.ts:362-368`), or
`draft_request` (brief the drafter). On `draft_request`, the drafter session drafts a
revised body from the reviewer's brief; the engine writes it
(`forge.updateIssueBody`) and loops back to a fresh reviewer cycle against the
drafter's edit. `roles.planReviewer.maxDraftCycles` (default 2, `config.ts:230`)
bounds the loop — at the bound, the engine escalates rather than cycling forever
(`plan-review.ts:375-379`).

| Element | Detail |
|---|---|
| Responsibility | Gate⓪: every Ready-lane issue must clear plan review (a verification plan the reviewer accepts) before it is dispatchable. The reviewer judges; the drafter repairs on a bounce. `plan-review.ts:432` `createPlanReviewStub`. |
| Write scope | Tier 1 (unreachable): no tool grant for either session (`ROLE_ALLOWED_TOOLS = ""`; the drafter's `PLAN_DRAFTER_DISALLOWED_TOOLS`, `peripheral.ts:55`, is a regression trip-wire only — the real boundary is the empty allow-list). Tier 3 choke point: `plan-review.ts:reviewOneIssue` (`plan-review.ts:279`) is the sole caller of `forge.updateIssueBody`/`forge.addLabel(plan:approved\|needs-human\|verify:n/a)`/`forge.addIssueComment` for this phase. The drafter's write is structurally never self-approving: it has no label-write path at all — `plan-review.ts` never calls `forge.addLabel` on the drafter's behalf. |
| Marker idempotency | `planReviewMarker(roundId)` (`plan-review.ts:56`), standard convention, round-phase granularity — the whole phase (every candidate issue) is one unit of idempotent work; a non-null marker skips the entire phase, not just completed issues. |
| Output schema + validation | `PlanReviewerMetadataSchema` (`plan-review.ts:138`, `decision ∈ {approve, draft_request, verify_na}` + `issue`) validated by `validateReviewerOutput` (`plan-review.ts:164`) — schema AND a content invariant: an `approve` claim's body (revised or current) must actually have `extractVerificationPlan` find a plan section (schema-valid is not the same as truthful). `PlanDrafterMetadataSchema` (`plan-review.ts:143`, `{issue}` + required body) validated by `validateDrafterOutput` (`plan-review.ts:205`) with the SAME content invariant applied to the drafted body. This is the **highest decision-weight** output in the codebase (`plan:approved` is the dispatch key) and carries the deepest validation — see `docs/PLAN.md`'s write-inventory table for the full field-by-field breakdown. |
| Escalation path | Gate-blocking — the ONE role pair whose failure escalates rather than degrading silently. A reviewer session that fails twice, or never validates, applies `needs-human` + an attempt-trail comment (`plan-review.ts:293-301`) and the `plan-review-escalated` state event; same for a drafter that never validates. Exhausting `maxDraftCycles` escalates the same way (`plan-review.ts:375-379`). A human resolution (a real plan, or accepting `verify:n/a` by removing `needs-human`) is required to make the issue dispatchable again — see [`configuration.md`](configuration.md) and issue #147's re-entry path for how a human-resolved gated issue re-enters the loop. |

### harvest (harvesting)

| Element | Detail |
|---|---|
| Responsibility | Round-close summary: briefs the round's needs-human issues with round context (a few lines each, not a report). Write TARGETS are closed-form pre-session — the engine-built round artifact (`round-artifact.ts`) computes the `needsHuman` set from the durable ledger BEFORE the session runs; the session's only latitude is what to SAY, never which issues to brief. `engine/src/harvest.ts:227` `createHarvestStub`. |
| Write scope | Tier 1 (unreachable): no tool grant, plus an explicit `HARVEST_DISALLOWED_TOOLS` (`harvest.ts:59`, denies `gh issue edit*` — regression trip-wire; harvest writes comments only, never a label or body edit). Tier 3 choke point: `harvest.ts:createHarvestStub` (`harvest.ts:227`) is the sole caller of `forge.addIssueComment` for this phase; every target is set-checked against the pre-computed `needsHumanIssues` list. |
| Marker idempotency | `harvestMarker(roundId)` (`harvest.ts:78`), standard convention. No needs-human issues to brief → no session run, but the phase still closes with its marker set (`harvest.ts:230,243`). |
| Output schema + validation | `HarvestMetadataSchema` (`harvest.ts:137`, `comments: [{issue, body}]`) validated by `validateHarvestOutput` (`harvest.ts:170`) — schema PLUS a set cross-check: every `issue` must be inside the engine's pre-computed `needsHumanIssues` set, or the WHOLE batch fails (never a partial apply); duplicate issue numbers in one batch are also rejected outright. An empty `comments` array is valid ("nothing to brief" is a legitimate outcome). |
| Escalation path | Advisory, degrade-and-proceed — a summary role must never wedge round termination. A session that fails twice or never validates fires `harvest-degraded` (`harvest.ts:203-212`, payload shape preserved exactly across the #110 rework: `{round_id, outcome, session, attempts}`); the phase closes with no comments posted. |

### retro (retro)

| Element | Detail |
|---|---|
| Responsibility | Self-evolution / retrospective: analyzes the round's engine-built digest (PR diffs, review signals, escalated-issue comments/labels, commits since round start — `retro-digest.ts`'s `buildRetroDigest`) and proposes prompt/config/doc improvements EXCLUSIVELY as a PR through the normal gate② path, never a direct write. Cadence-gated by `roles.retro.everyNRounds` (default 1). `engine/src/retro.ts:249` `createRetroStub`. |
| Write scope | **The one role NOT at tier 1** — retro is worker-class (needs real git: branch/commit/push inside its own ephemeral worktree), so its containment is narrower-but-still-strong: `RETRO_ALLOWED_TOOLS` (`retro.ts:68`) grants `Read/Write/Edit/MultiEdit` + local git only, with **zero `gh` entries of any kind** (#111 PR-B removed the last one, `gh pr create`) — `RETRO_DISALLOWED_TOOLS` (`retro.ts:89`) denies pushing to `main`/`master` by name plus every merge/review/approve/edit `gh` verb as a regression trip-wire. Tier 3 choke point: `openProposalPR` (`retro.ts:351`) is the sole caller of `forge.openPR`, and only after an engine-side `forge.branchExists` read verifies the session's claimed push — a session's claim is never trusted as evidence by itself. |
| Marker idempotency | `retroMarker(roundId)` (`retro.ts:172`), standard convention. A round whose id isn't a multiple of `everyNRounds` skips the session but still sets the marker (`retro.ts:254`) — the phase always closes. **Known gap** (documented in `retro.ts`'s module doc, `retro.ts:242-248`): unlike every issues-only role, retro's ephemeral worktree is unconditionally deleted after the session (`peripheral.ts`), so a session that crashes after editing but before push loses that attempt's draft silently — accepted as low-risk (nothing destructive proposed; next round's retro tries again from the same history), not yet given #69-style dirty-worktree retention. |
| Output schema + validation | NOT the JSON sentinel block — a fixed scratch file (`RETRO_SCRATCH_FILE = ".sapwood-retro-pr"`, `retro.ts:117`) the session writes mid-session (survives a truncated final message). `parseRetroScratch` (`retro.ts:141`) fail-closed parses either the literal `none` (explicit quiet round) or a labeled `branch:`/`title:`/body proposal, with `invalidBranchReason` (`retro.ts:128`) checking ref-safety, no `..` traversal, and refusing the default branch by name. A missing file is `invalid`, not "quiet round" — the prompt requires the file always be written. |
| Escalation path | Advisory at the session level (degrade-and-proceed: `retro-degraded`, `retro.ts:296-304`, a lost pass costs one round's proposals only), but the PR-open step has its OWN three-way degrade (`openProposalPR`, `retro.ts:351-387`): branch not verified-pushed → no `openPR` call, degrade naming the branch; `openPR` throws after a verified push → degrade, but the pushed branch is preserved evidence a human (or the next round's retro) can open by hand; success → durable `retro-pr-opened` event. None of these wedge the round. |

## Cross-cutting notes

- **Structured output format.** Five of the six roles (all but retro) share one
  sentinel-delimited shape (`structured-output.ts`): a JSON metadata segment between
  `<<<SAPWOOD_RESULT>>>`/`<<<END_SAPWOOD_RESULT>>>`, plus an optional raw-markdown BODY
  segment between `<<<BODY>>>`/`<<<END_BODY>>>` — kept separate so a markdown body's
  own code fences never have to survive JSON-string escaping. `parseStructuredBlock`
  fails closed on any ambiguity (truncated block, trailing content, an embedded
  sentinel inside the body) — never a partial/best-guess slice.
- **`RoleRunner` and `runSessionWithRetry`.** Every role reuses `engine/src/
  peripheral.ts`'s `RoleRunner` to spawn its session (one bounded `await`, no
  probe/resume — a role session never has real work-in-progress, so its worktree is
  always safe to delete afterward) and its shared `runSessionWithRetry` helper
  (`peripheral.ts:387`) for the retry-once-then-degrade mechanics: a session's own
  outcome (`done`/`failed`/`timeout`) is never assumed — a "done" session whose
  structured output fails an `isValid` check is treated identically to a failed one.
  Only plan-reviewer's escalation shape (needs-human, not a state-event degrade) is
  deliberately NOT folded into this shared helper — see `peripheral.ts`'s module doc.
- **What this doc is not.** It does not re-derive `docs/PLAN.md`'s structured-output
  write inventory (output field → `IForge` write → validation → decision weight); that
  table is the standing safety baseline every future write-widening change updates.
  It does not re-describe `guard.ts`'s enforcement mechanics (tokenizing, exec-prefix
  stripping, opaque-construct blocking) — see [`security.md`](security.md). It does
  not cover the worker role (code-producing, a different session class entirely) or
  the runtime round-phase state machine (`docs/loop-walkthrough-v0.2.md`'s phase
  table) — this doc is about role CONTRACTS, not round RUNTIME STATES.

## What a v1.0 user-defined role must supply (issue #134, forward-looking)

The governed extension points backlog item depends on this doc (M5 items 1 & 10, per
`docs/system-review-2026-07.md`'s roadmap). A user-defined role — inserted before/after
any phase — will need to declare all five elements above explicitly rather than
inheriting them from a hardcoded module: a write scope chosen from the SAME
engine-enumerated tier ladder (never a bespoke tool grant), a marker-idempotent
`PeripheralStub.run()`, a schema-validated output the engine parses fail-closed, and an
explicit escalation choice (advisory vs. gate-blocking). This doc is that prerequisite
contract, written against what the six built-in roles already do.
