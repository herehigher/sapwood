# The role paradigm

For the six peripheral roles below, sapwood's deterministic engine (`runRounds`,
`engine/src/loop/round.ts`) is the only piece of code that ever writes to GitHub on their
behalf — each role session is a scoped, bounded subordinate whose judgment reaches
GitHub only through the engine (#110). The **worker is the write-capable exception** and is
out of this doc's peripheral-role scope: worker sessions hold real write grants
(`Read,Edit,Write,Bash(git *),Bash(gh *),Bash(npm *),...`, with seven `gh` verbs
deny-listed — `engine/src/roles/worker.ts::WORKER_DISALLOWED_TOOLS`: `gh pr merge*`/`gh pr
ready*` are the permission-layer half of this repo's producer≠merger boundary (CLAUDE.md
non-negotiables), defense-in-depth atop guard.ts's own primary, wrapper-bypass-resistant
argv-layer block; #350's `gh pr review*`/`gh release*` are surface narrowing — neither is
needed by any stock worker workflow, so denying them too costs nothing; #488's `gh issue
edit*`/`gh label*`/`gh project*` are governance-signal containment — a producer must never
forge the labels/board `Status` the engine's gates trust) and open their own PRs; their
actual boundary is tier 2 of the
ladder below, the fail-closed guard hook intercepting merge/approve/ready — see
[`security.md`](security.md). Gate② reviewers are also not peripheral roles; their separate
contract is summarized below. This doc is the contract every peripheral role session
satisfies today, and the contract a v1.0 user-defined role (governed extension
points, issue #134) must satisfy to be added safely.

Audience: sapwood developers modifying an existing role, and v1.0 extension authors
writing a new one. This is durable knowledge — what's true on `main` right now — not a
history of how it got here; provenance is a one-line `#nn` reference only. See
[`docs/system-review-2026-07.md`](system-review-2026-07.md) (M5 item 10) for the
review that asked for this doc, and [`docs/PLAN.md`](PLAN.md)'s "Validation depth ∝
decision weight" section for the standing structured-output write inventory this doc
complements (that table tracks *what each role's output drives*; this doc explains
*the shape every role's session/output/idempotency/escalation must have*).

**Citation convention (#535):** every code citation in this doc names a symbol —
`` `file.ts::symbolName` `` — never a line number. Line numbers rot silently as code moves; a
symbol survives a reformat and, when it doesn't, a reader can grep for it and get a useful "not
found" instead of a citation that silently points at the wrong thing. Follow this convention for
any citation you add or edit; do not reintroduce `file.ts:NNN`.

## The six-element contract

Every role in this codebase is defined by six elements. A new role (built-in or,
post-v1.0, user-defined) must specify all six before it ships:

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
6. **Evidence channel** — for every judgment the role's prompt asks of it, name the channel
   through which the session can actually earn the evidence, or the first-class abstention it
   returns instead; a prompt may never ask a question the role can neither answer from a held
   channel nor explicitly decline.

## Gate② reviewer kinds, including engine-agent

Gate② has four reviewer kinds: `different-model-codex`, `same-model-trusted`, `human`,
and `engine-agent`. The first three consume review artifacts already present on GitHub.
`engine-agent` is different: it is an **engine-composed review session**, not a peripheral
role session and not a hosted bot. After deterministic preflight, the engine materializes the
exact PR head from an engine-private clone and runs a static, different-**model** session over
that tree — checked by the engine against the producing worker's own recorded model, not
necessarily a different-Claude-model session: the runner is configurable
(`reviewer.agent.runner: claude | codex-exec`, #443/#501); exactly when that check runs
pre-session vs. post-session is runner-dependent — see `engine/prompts/engine-reviewer.md`'s
ENFORCED list, not restated here. No writes, for
either runner: a review session can never modify the tree or reach the forge. Beyond that,
containment is runner-specific, not one shared profile — the `claude` runner's tool grant
(`Read`/`Grep`/`Glob` only, no Bash, no forge proxy) is hardcoded in `RoleRunner.run()`'s review
mode and a caller cannot widen it, together with an empty strict MCP configuration, no
file-based settings sources, worktree-confined reads, and a forced-hard guard regardless of the
ordinary configured guard mode; the `codex-exec` runner's read-only sandbox blocks writes but not
shell execution or host-wide file reads — a disclosed gap (`engine-review-containment-gap`,
docs/security.md), never claimed as an engine-enforced fence.

The session never approves, labels, comments on, fixes, or merges a PR. Its strict output contains
only per-AC statuses and findings; it cannot name an overall verdict or head OID. The deterministic
engine owns the approval/blocking split:

- zero BLOCKING findings and only `confirmed`/`claim-accepted` AC states derive `approved`; any
  `claim-accepted` IDs remain explicit unreproduced claims in the evidence, and any advisory
  finding is recorded alongside them (#448, design #402 R1) rather than silently dropped;
- any blocking finding or `cannot-confirm` AC derives `rejected`, which enters the existing
  FIXABLE path. `severity: "advisory"` is honored only for an engine-side kind allowlist
  (`style`, `test-coverage`); every other kind is forced back to blocking and the override is
  recorded — the session cannot lower its own gate. The per-AC path blocks independently: a
  `cannot-confirm` rejects regardless of how any finding is labelled;
- malformed output, setup failure, indistinguishable worker/reviewer models, or unavailable
  execution evidence never approves: they retry/back off as allowed, then queue unavailable;
- unresolved threads, standing current-head `CHANGES_REQUESTED`, human/hold labels, instruction-
  path escalation, and the other live merge gates remain engine-side blockers regardless of an
  approval-side result.

An engine-agent decisive result is consumed only after its sanitized, non-authoritative audit
comment has a delivery receipt and a final live refetch still matches the pinned head/base and
gate state. This keeps the review session a bounded judgment source while the engine remains the
only component that turns that judgment into gate behavior.

### The reviewer prompt's enforced/judged split (#454, design #402 §6a)

The reviewer's behavior has two halves, and the shipped prompt
(`engine/prompts/engine-reviewer.md`, operator-tunable via `reviewer.agent.promptFile`) states
which half each of its own instructions belongs to. This is the same producer≠reviewer discipline
applied one level down: what the engine *enforces* is a property of the code, what the reviewer
*judges* is a property of the session — and a prompt that blurs the two invites a tuner to
"tighten" a rule the engine already enforces (a no-op) or to loosen one nothing checks (an
unbounded change).

**Engine-enforced, prompt-independent** — each backed by a live check, not by the prompt saying
so: exactly one `perAC` entry per manifest id (unknown/missing/duplicate voids the whole output);
the finding key allowlist plus closed `severity`/`kind` enums; the advisory-eligible kind
allowlist; a `rejected` verdict always carrying a non-empty findings array; model separation
checked both pre-session (configured models) and post-session (recorded model usage); head/base/
diff identity and snapshotted-body drift, both fail-closed; the hardcoded `Read`/`Grep`/`Glob`-only
tool profile, which a caller cannot widen.

**Agent-judged, unverifiable by the engine** — no schema can check these, and the prompt says so
rather than implying otherwise: whether a named test is substantive rather than merely present;
the evidence-tier choice itself; which `severity` and `kind` a finding deserves; whether a finding
is worth writing at all; the finding classes the prompt names; and the rest of its prose. This
half is where a review earns or loses its value, which is why the shipped default also carries the
triage doctrine (§6b) — triage before writing, name the target `path` and the `kind`, do not
re-raise an adjudicated finding, scope honestly — repeated hand-tuning converged on. Those are
durable defaults in a shipped, reviewable artifact, not one operator's habits.

## The write-scope tier ladder

Three tiers, from strongest to weakest containment (`docs/system-review-2026-07.md`
Principle 4). Every role's writes sit at exactly one tier; prefer moving a future
role's writes UP this ladder over adding a pattern-level deny.

1. **Unreachable (for writes)** — no write tool channel exists at all, for five of this doc's six
   peripheral roles: po, architect, verification-plan-reviewer, verification-plan-drafter, harvest. These five hold
   `ROLE_ALLOWED_TOOLS = "Read,Grep,Glob"` (`engine/src/roles/peripheral.ts::ROLE_ALLOWED_TOOLS`) as their FLOOR —
   a real, non-empty READ channel (widened from an empty grant by #235 PR-B); po's align/triage
   modes and architect widen this further still, to also include `WebSearch`/`WebFetch` under the
   default config (see their own Write-scope rows below for the exact grant) — never `Write`,
   `Edit`, or `MultiEdit` either way. This is paired with the hard veto
   `ROLE_DISALLOWED_TOOLS = "Write,Edit,MultiEdit,NotebookEdit,Bash,Agent,Task"`
   (`engine/src/roles/peripheral.ts::ROLE_DISALLOWED_TOOLS`, which wins over any allow from any source, including a
   target repo's own checked-out settings — except under a target's managed-settings
   `allowManagedPermissionRulesOnly: true`, where the CLI's own contract says CLI-argument
   permission rules (`--disallowedTools` is one) are ignored entirely, discarding this whole
   list, not just the `Agent`/`Task` deny below; whether the engine should detect and refuse that
   mode is open, see issue #554): no `Bash` grant at all, so for them a whole bypass
   class (short-flag aliases, quoting escapes) is structurally moot rather than pattern-denied
   (#110; see [`security.md`](security.md#issues-only-role-sessions-carry-no-shell-110)). This is
   the strongest tier for writes, for these five, because there is nothing to intercept — the
   write capability doesn't exist to begin with; the read channel itself is contained separately,
   by the guard hook's worktree confinement (`checkReadContainment` in `guard.ts`) — enforced
   under the default `guard.mode: hard` (`engine/src/config/config.ts::Guard`), degraded to observe-only (logged, never
   denied) under an operator-configured `guard.mode: soft` (`applyGuardMode`, `engine/src/guard/guard-hook.ts::applyGuardMode`)
   — not by this ladder. **#534:** `ROLE_DISALLOWED_TOOLS` also name-denies subagent spawn —
   `Agent`/`Task` — for every session wired through this matrix, including the hardcoded
   `claude`-runner review profile (`RoleRunner.run()`'s `reviewMode` branch hardcodes
   `ROLE_ALLOWED_TOOLS`/`ROLE_DISALLOWED_TOOLS` directly, never a caller-supplied override — see
   the "Gate② reviewer kinds, including engine-agent" section above). A spawned child inherits
   its parent's `--allowedTools`/`--disallowedTools` — ordinary Claude Code subagent behavior, not
   anything this engine configures. The #534 incident evidenced exactly that leg and no more: the
   three subagents a live `verification-plan-reviewer` session spawned reached no shell either, because the
   blanket `Bash` deny came with them. Whether the guard hook is
   equally transitive — and therefore whether read containment, which only the hook enforces and
   only under `guard.mode: hard`, reaches a child — has never been probed: the deny-list
   observation above evidences the `--allowedTools`/`--disallowedTools` leg only, and must not be
   read as covering the guard hook too. **`retro`, the sixth role, does NOT belong in this tier**:
   `RETRO_ALLOWED_TOOLS` (`engine/src/retro/retro.ts::RETRO_ALLOWED_TOOLS`) grants a real `Write`/`Edit`/`MultiEdit`
   channel plus `Bash` scoped to eight specific `git` subcommands including `commit` and `push`
   (`branch`/`checkout`/`add`/`commit`/`push`/`diff`/`status`/`log`) —
   `RETRO_DISALLOWED_TOOLS` (`retro.ts::RETRO_DISALLOWED_TOOLS`) denies pushing to `main`/`master` by name and
   the merge/review/ready/edit/comment/api `gh` verbs it lists (`gh pr merge*`, `gh pr review*`,
   `gh pr ready*`, `gh pr edit*`, `gh issue edit*`, `gh issue comment*`, `gh api*`,
   `gh pr create *--body-file*`) — not every `gh` verb (plain `gh pr create`, `gh pr comment`,
   `gh repo`, `gh workflow` and the rest are ungoverned by this list), and not
   `Write`/`Edit`/`MultiEdit` or those `git` subcommands — so the write
   capability genuinely exists here, unlike the five roles above. Its containment is a shape this
   ladder does not cleanly name; see its own per-role section below (`### retro (retro)`) for what
   actually holds it. **#534:** the subagent-spawn deny above is `ROLE_DISALLOWED_TOOLS`-specific
   and does NOT reach retro automatically — `RETRO_DISALLOWED_TOOLS` is an independent literal,
   not derived from the shared constant (unlike every other role's deny list in this doc), so its
   own `Agent`/`Task` deny lives in `RETRO_DISALLOWED_TOOLS` itself, appended there directly
   rather than inherited. **The verification-plan-reviewer's freshness re-confirm session (#214, a variant pass
   within `plan_review`, not a whole new role) carries `CONFIRM_ALLOWED_TOOLS =
   ROLE_ALLOWED_TOOLS`** (`engine/src/roles/peripheral.ts::CONFIRM_ALLOWED_TOOLS`) — byte-identical to the base grant
   since #235, so it is no longer a narrower exception; it stays tier 1 for WRITES on the same
   basis as the five roles above: no `Bash` of any kind (no `git`, no `gh`, no shell to reach
   either through), no `Write`/`Edit`/`MultiEdit` — the same "capability doesn't exist" argument
   holds for every write path. See
   [`security.md`](security.md#issues-only-role-sessions-carry-no-shell-110)'s own note on this
   session for the full rationale.
2. **Intercepted** — a tool channel exists, but a fail-closed hook blocks the
   dangerous call before it executes. This is `guard.ts`'s PreToolUse hook, wired into
   every worker session (`worker.ts`) and, defense-in-depth, every role session too
   (`engine/src/roles/peripheral.ts::RoleRunner.run`, `guardSettings`). Reference-only for this doc: **do not
   modify `guard.ts` or its wiring** — it is human-merge-only
   (`CLAUDE.md` non-negotiables). Five of the six roles below — po, architect, verification-plan-reviewer,
   verification-plan-drafter, harvest — sit at tier 1 and do NOT rely on this tier as their primary boundary;
   for them it is only the backstop under tier 1's absence-of-capability. `retro`, the sixth, does
   NOT sit at tier 1 (it holds a real `Write`/`Edit`/`MultiEdit` grant — see tier 1's note above),
   so for retro this tier IS load-bearing rather than a backstop: specifically, the guard hook's
   protected-path write block (`checkWritePath`/`checkBashWritePath` in `guard.ts` — neither takes
   a worktree root; worktree confinement is `checkReadContainment` alone, tier 1's read mechanism
   above) constrains the real write grant it holds, by blocking writes to guard/reviewer/
   merge-driver source, the compiled `engine/dist` gate artifacts, `.github/workflows/**`, and the
   engine config (`protectedPathLabel` in `guard.ts`) from anywhere the session runs, not by
   confining it to its worktree — enforced under the default `guard.mode: hard`
   (`engine/src/config/config.ts::Guard`), degraded to observe-only (logged, never denied) under
   an operator-configured `guard.mode: soft` (`applyGuardMode`, `engine/src/guard/guard-hook.ts::applyGuardMode`
   — the same global short-circuit as tier 1's read containment above, not specific to writes).
   That is not retro's whole containment, and under `soft` it is *all* that is left of it: its
   own `### retro (retro)` row below names the actual combination — this narrowed grant with no
   `gh` entries at all, plus the tier-3 `openProposalPR` choke point gated on an engine-side
   `forge.branchExists` check, neither of which depends on `guard.mode`.
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
(`engine/src/loop/round.ts::PeripheralStub`):

```ts
run(ctx: { roundId: number; phase: PeripheralPhase; marker: string | null }): Promise<{ marker: string }>
```

`round.ts`'s own module doc states the invariant every role's `run()` must honor: a
crash mid-phase leaves the round's persisted phase cursor at that exact phase; on
restart, `round.ts` re-invokes the SAME phase's stub fresh — never resuming
mid-session state. **Idempotency is the stub's own job, keyed by `marker`**, and the
semantics are rerun-not-resume, not a no-prior-writes guarantee: `round.ts` persists
the returned marker only AFTER `stub.run()` completes (`round.ts::runPeripheral`), so a
crash mid-`run()` can leave real forge writes behind while the marker is still
`null`. A `null` marker therefore means "no prior attempt this round COMPLETED — the
phase will run again in full"; a non-null marker means a prior attempt completed and
externalized this phase's work, so the correct response is "return the same marker
unchanged, do no further writes". What makes the full rerun safe is each role's own
per-item behavior, not the round-level marker itself: processed candidates drop out
of the candidate queries (an approved issue no longer matches gate⓪'s query, a
drafted triage issue no longer matches triage's), retro's rerun `openPR` for the same
head branch fails at the forge rather than opening a second PR, and the marker string
embedded in every posted comment makes any residual duplicate externally attributable
to its round/phase.
All six roles below use the same `<!-- sapwood:round:{roundId}:{phase} -->` marker
convention (e.g. `align.ts`'s `alignMarker`, `architect.ts`'s `architectMarker`) and
the same one-line guard at the top of `run()`:
`if (marker != null) return { marker };`.

This is coarse — round-phase granularity, not per-issue — but deliberately so: a
partially-worked round's remaining candidates are picked up next round (or once
dispatchable again) rather than risking duplicate sessions/writes on a resume.

## Per-role sections

### po (aligning)

| Element | Detail |
|---|---|
| Responsibility | Round-open goal decomposition (`align` mode: reads the north-star goal file + round milestone, creates new issues) and a round-start plan-triage pass (`triage` mode: drafts a verification plan directly into an existing plan-less issue's body). Runs first in the round sequence. `engine/src/loop/align.ts::createAligningStub`. |
| Write scope | Tier 1 (unreachable) for writes: align mode runs on `PO_ALIGN_ALLOWED_TOOLS` and triage mode on `PO_TRIAGE_ALLOWED_TOOLS` — both `"Read,Grep,Glob,WebSearch,WebFetch"` (`engine/src/roles/peripheral.ts::PO_ALIGN_ALLOWED_TOOLS`/`peripheral.ts::PO_TRIAGE_ALLOWED_TOOLS`) — when `webAccess.enabled` (default `true`, `engine/src/config/config.ts::WebAccess`); when it's `false`, both fall back to the base `PO_ALLOWED_TOOLS = ROLE_ALLOWED_TOOLS = "Read,Grep,Glob"` (`peripheral.ts::PO_ALLOWED_TOOLS`/`peripheral.ts::ROLE_ALLOWED_TOOLS`; call sites `align.ts::createAligningStub`). Either way, no write grant: `ROLE_DISALLOWED_TOOLS` (`peripheral.ts::ROLE_DISALLOWED_TOOLS`) denies `Write`/`Edit`/`MultiEdit`/`Bash`. Tier 3 choke point: `align.ts::createAligningStub` is the only caller of `forge.createIssue`/`forge.addLabel`/`forge.updateIssueBody`/`forge.addIssueComment` on the PO's behalf. A created issue's `(title, body)` signature has no label field — structurally cannot carry `plan:approved`/`verify:n/a` at creation. Never calls `forge.setBoardStatus` — locked decision "only a human confirms Ready" holds structurally, not by convention. **#237:** both modes may additionally emit `concerns:[{issue, reason}]`, alongside (never instead of) the normal deliverable above — the ONLY write this produces is `addIssueComment` (`engine/src/loop/dissent.ts::postConcerns`); there is no label/status/dispatch write path a concern could ever reach, by construction (no such field exists in `dissent.ts`'s write surface at all). A triage concern is dropped from the post queue entirely if its accompanying triage decision was itself discarded (stale-hash refusal / decision-lost degradation, 2026-07-18 adjudication finding 6) — a concern never outlives the decision it rode along with. |
| Marker idempotency | `alignMarker(roundId)` (`engine/src/loop/align.ts::alignMarker`), the standard `<!-- sapwood:round:N:aligning -->` convention. Round-phase granularity; additionally, triage is naturally per-issue idempotent — a successfully drafted issue carries a plan section and no longer matches `getIssuesNeedingPlanTriage`'s candidate query on a later run (`align.ts::createAligningStub`). **#237:** each concern carries its OWN marker, `<!-- sapwood:concern:<issue>:<hash> -->` (`dissent.ts::concernMarker`), independent of the round marker above — idempotent across rounds by a LIVE check (the issue's current comments, re-read every call) rather than the round ledger, since the same worded concern about the same issue must be re-postable in a LATER round if the issue's body changed in between (the hash covers the concern's wording **and** the issue's body AT POST TIME — a why/what edit changes the hash and re-arms it). Every comment this engine posts is also centrally stamped `<!-- sapwood:engine -->` at the `forge.ts::GithubForge.addIssueComment` write boundary (2026-07-18 adjudication finding 2), regardless of whether the call site embeds its own marker — this is what lets the adjudication scan tell an external reply apart from any engine-authored comment, including ones (architect.ts, conductor.ts) that carried no marker of their own before this change. When the live marker check finds a concern already posted with no matching durable receipt, `postConcerns` reconciles it right there (finding 3, same paradigm as `align.ts`'s own proposal-marker reconcile) rather than losing it silently. **#442 (settled, won't-do):** the round marker stays in a COMMENT rather than moving to the issue-body footer and retiring the comment. Three live consumers depend on the comment form: `dissent.ts::isSapwoodComment`'s adjudication scan reads the comment STREAM to tell an engine comment from an external reply; the `proposal-comment-posted` receipt + `commentedIds` journal (`align.ts`, `decompose.ts`) exists precisely because a comment write is not idempotent, so retiring the comment means retiring durable state, not adding none; and the comment stream is append-only whereas the body is not — three call sites (`plan-review.ts` ×2, `align.ts`'s own triage write) replace an issue body WHOLESALE, and `issue-creation.ts::hasProposalMarkerTrailer` additionally requires the `<!-- sapwood:proposal:… -->` marker to be the body's LAST trailer, so a second footer marker would sit in front of a reconcile key or be destroyed by the next body rewrite. Two facts with two authors keep two carriers; see also the `Origin:` line in the row below. |
| Output schema + validation | Two independent zod schemas around the shared sentinel shape: `AlignMetadataSchema` (`align.ts::AlignMetadataSchema`, array of `{title}`, per-issue bodies split from the BODY block via a nested `<<<ISSUE>>>`/`<<<END_ISSUE>>>` convention, `splitAlignIssueBodies`, `align.ts::splitAlignIssueBodies`) and `TriageMetadataSchema` (`align.ts::TriageMetadataSchema`, `{issue}` + full revised body). `validateAlignOutput` (`align.ts::validateAlignOutput`) rejects duplicate titles in one batch outright. **#442:** it also rejects the whole batch if any proposed body lacks the required one-line `Origin:` evidence statement (`forge.ts::extractOrigin`) — the ONE content invariant it enforces, and deliberately unlike the verification-plan stance below: a planless issue has a downstream route (the `planless` label, a later triage pass), whereas nothing downstream can reconstruct which evidence triggered a proposal once the session that knew it has ended. **Presence only** — what the line SAYS is human-triage prose the engine never parses or routes on (F15/#423: a role's self-report is not a machine anchor; the round/proposal markers are). An engine-wide grep-invariant in `align.test.ts` pins that single call site. See [`getting-started.md`](getting-started.md#the-origin-line-on-agent-filed-issues-442). `validateTriageOutput` (`align.ts::validateTriageOutput`) deliberately does NOT content-check for a verification-plan section — a planless draft is a normal per-issue outcome (fenced `needs-human`/re-matched next round), not an invalid session attempt. **#237:** both schemas additionally accept an optional `concerns` array (`dissent.ts::ConcernSchema`); `dissent.ts::validateConcerns` rejects the WHOLE batch (same fail-closed doctrine as the duplicate-title check) if any concern names an issue outside the session's own injected view — the rendered backlog-digest subset for ALIGN mode; the target issue ONLY for TRIAGE mode (2026-07-18 adjudication finding 7 narrowed this from "digest + target" to match the prompt, which never authorizes a triage concern about any other issue) — or if two concerns name the same issue. |
| Escalation path | Advisory, degrade-and-proceed — pre-Ready, low stakes. A session that fails twice or never validates fires `po-degraded` (align mode) or `triage-degraded` (triage mode) as a durable state event plus a stderr line (`align.ts::createAligningStub`, via `peripheral.ts`'s shared `runSessionWithRetry`); the round is never wedged, and the next round retries naturally. A schema-valid-but-still-planless triage draft is its OWN degradation shape (`triage-degraded`, `no-plan-after-draft`, `align.ts::createAligningStub`) — distinct from a malformed/failed session. **#237:** an out-of-view/duplicate concern invalidates the WHOLE session output (not just the concern) — it goes through this SAME retry-then-degrade path, no new escalation machinery. Adjudication of a delivered concern is never an engine escalation at all — it is the issue's own GitHub lifecycle (close/external-reply/body-changed/silence); `dissent.ts::scanForAdjudication`'s per-round scan (called UNCONDITIONALLY from `round-defaults.ts`, independent of `roles.po.enabled` and of `createAligningStub`'s own internal early-returns — 2026-07-18 adjudication finding 5) only records which of those already happened as a durable `concern-adjudicated` event, for `sapwood status`'s standing count. Neither `body-changed` NOR `closed` carries any human-attribution claim (2026-07-19 round-2 adjudication, finding 3): this engine's own writes can produce either — a later PO/verification-plan-reviewer body revision triggers `body-changed`, and the conductor's own `Closes #N` merge (`round.ts`) closes the issue exactly like a human would by hand. `external-reply` is the ONLY outcome carrying any actor claim at all, and even it only claims "not this engine" (a non-sapwood-stamped comment, which includes other bots), never "a human specifically." Pulling a concerned issue from Ready without closing it ("adopted") is not detected as its own outcome — IForge has no cheap board-status read this module uses, and none was added for this (finding 5's narrowed lifecycle claim). **2026-07-19 round-2 adjudication (findings 1+2):** `postConcerns` (align.ts's own per-round call) is NOT durable-enough on its own — a decision that reaches its terminal receipt (`triage-effects-committed`) is short-circuited from re-collection on any later same-round rerun, so a concern whose post never completed (crash between the terminal receipt and delivery) would otherwise be lost forever. `dissent.ts::reconcileDurableConcerns` is the durable backstop: called unconditionally every round (same home as `scanForAdjudication`), it reads concerns embedded directly in the write-ahead `triage-decision-accepted`/`proposal-set-persisted` events across the WHOLE ledger and re-posts/reconciles any with no matching receipt — always attributed to that DECISION's own original `round_id`, never the round the sweep happens to run in (this is also what keeps `round-artifact.ts`'s per-round "Objections raised" section honest — a receipt landing in a later round's event-ID window but naming an earlier `round_id` is routed to a separate "reconciled from an earlier round" list there, never claimed as that later round's own). |

#### PO decompose sub-mode

A human-applied `labels.split` admits one oversized issue, including an `origin:agent`
child, for one controlled generation. Agent-origin issues without that fresh signature
are never candidates. The session performs goal alignment, a cheap feasibility
self-check, and decomposition in one pass, returning either a bounded child set plus a
coverage declaration or an advisory unresolved-context abstention.

The engine persists the validated proposal set, then fences a successful parent before
creation: reconcile it to Todo, remove only the engine-owned round-pool label if present,
and apply `labels.decomposed`. Only then does the shared align/decompose create loop run. The
parent becomes a human-visible tracking container and is excluded from backlog digests,
triage, pool selection, and dispatch; it is never auto-closed and the engine never removes
`decomposed`. Children receive `origin:agent` and remain outside Ready. Ready-able children
are born with checkbox acceptance criteria plus a verification plan; coarse remainders are
partitioned as finely as current information allows, carry their own unresolved fact and
needed input, and follow the existing planless→`needs-human` path.

Native sub-issue attachment is same-repository and reconciled independently from creation.
An attachment outage never lifts the fence or recreates a child. The parent receives one
marker-idempotent coverage comment mapping parent intent to child issue numbers and naming
remainders. Multi-pass refinement is human-fired: provide the missing input and apply split
to that remainder. There is no automatic recursion.

### architect (architecting)

| Element | Detail |
|---|---|
| Responsibility | One cross-issue design/review pass between goal alignment and dispatch: reads the round's whole candidate batch (issues awaiting gate⓪) plus this round's round-pool members plus the north-star goal file's `## Architecture` chapter, produces a round design note, flags any candidate whose approach contradicts locked architecture (comment; `blocked` label if severe), and separately — for round-pool members only — may return a per-issue `drop`/`needs-human` verdict (comment plus, respectively, removal from the round pool or the `needsHuman` label; see Write scope below). `engine/src/roles/architect.ts::createArchitectStub`. |
| Write scope | Tier 1 (unreachable) for writes: `ARCHITECT_ALLOWED_TOOLS = "Read,Grep,Glob,WebSearch,WebFetch"` (`engine/src/roles/peripheral.ts::ARCHITECT_ALLOWED_TOOLS`) when `webAccess.enabled` (default `true`, `engine/src/config/config.ts::WebAccess`; call site `architect.ts::createArchitectStub`), else the base `ROLE_ALLOWED_TOOLS = "Read,Grep,Glob"` (`peripheral.ts::ROLE_ALLOWED_TOOLS`). Either way, no write grant: `ROLE_DISALLOWED_TOOLS` (`peripheral.ts::ROLE_DISALLOWED_TOOLS`) denies `Write`/`Edit`/`MultiEdit`/`Bash`. Tier 3 choke point: `architect.ts::createArchitectStub` is the sole caller of `forge.addIssueComment`/`forge.addLabel(blocked)`/`forge.addLabel(needsHuman)`/`removeRoundPoolLabel` for this role — the full write surface is wider than a comment-and-`blocked` flag: a severe contradiction gets a comment plus the `blocked` label; separately, a pool-member verdict of `drop` removes the round-pool label (`removeRoundPoolLabel`) plus a comment, and a verdict of `needs-human` adds the `needsHuman` label plus a comment. `validateArchitectOutput` (`architect.ts::validateArchitectOutput`) independently verifies TWO separate authoritative target sets, fail-closed and atomic (one bad number in EITHER array invalidates the WHOLE output, never a partial apply): every flagged `contradictions` issue number must be a member of `candidateNumbers`, the exact candidate set the session's prompt showed it, and every `verdicts` issue number must SEPARATELY be a member of `poolNumbers`, this round's actual round-pool membership — a different set from `candidateNumbers` (the two MAY overlap, but a verdict target is never checked against the candidate set, and a contradiction target is never checked against the pool set) (`architect.ts::validateArchitectOutput`). |
| Marker idempotency | `architectMarker(roundId)` (`architect.ts::architectMarker`), standard convention. No candidates AND no round-pool members this round → marker set, no session run at all (`architect.ts::createArchitectStub`). |
| Output schema + validation | `ArchitectMetadataSchema` (`architect.ts::ArchitectMetadataSchema`, `contradictions: [{issue, severe}]` plus, since #213, `verdicts: [{issue, verdict}]` where `verdict ∈ {drop, needs-human}`); free-text design note + per-issue explanations travel in the BODY block via an architect-owned `<<<CONTRADICTION #N>>>`/`<<<VERDICT #N>>>` sub-delimiter pair, parsed by `parseArchitectBody` (`architect.ts::parseArchitectBody`) with its own fail-closed containment (empty design note, empty/duplicate section, or a residual embedded sub-delimiter after split all reject). `validateArchitectOutput` (`architect.ts::validateArchitectOutput`) chains: schema → non-empty body → sub-format parse → metadata/body section-set match (both arrays) → the candidate-set invariant (`contradictions` against `candidateNumbers`) → the pool-set invariant (`verdicts` against `poolNumbers`). |
| Escalation path | Advisory, degrade-and-proceed — no dispatch decision depends on the design note or the verdicts. A session that fails twice or never validates fires `architect-degraded` (`architect.ts::createArchitectStub`, via `runSessionWithRetry`); the round proceeds with no design note and no verdicts applied, marker still set (a rerun will not retry this phase). |

### verification-plan-reviewer + verification-plan-drafter (plan_review) — one gate⓪ adversarial pair

**Named for what it gates (#413, 2026-08-03).** This pair was called `plan-reviewer` /
`plan-drafter` until #413 renamed it. The old name was wrong in a way that had already
misled a design discussion: it invites the reading that the role adjudicates *the plan of
work* — whether the approach is right — which is precisely the charter it does **not**
have. What it actually reviews is the issue's **verification plan**: its acceptance
criteria and the method for proving them. The current names say so. The rename covered the
role ids, the prompt filenames, and the `roles.verificationPlanReviewer` /
`roles.verificationPlanDrafter` config keys together, because the role id is also a
deny-by-default key in the forge proxy's tool matrix
(`engine/src/proxy/access.ts::PROXY_ROLE_TOOL_MATRIX`) — a half-applied rename there would
fail closed to *no tools* and silently degrade the role instead of erroring. Pre-v1, the
old config keys were retired outright rather than dual-accepted; a config still carrying
`roles.planReviewer`/`roles.planDrafter` fails to parse with an error naming the
replacement (`config.ts::RENAMED_ROLE_KEYS`). Deliberately NOT renamed: the `plan_review`
phase id and its persisted state values, which are storage, not vocabulary.

Documented as one unit because the pair's whole point is an adversarial cycle — author
≠ approver — not because their identities are unified. **They remain two separate
sessions with two separate prompts** (`prompts/verification-plan-reviewer.md`,
`prompts/verification-plan-drafter.md`): the reviewer never drafts a body, and the drafter never
applies a label or approves. `roles.verificationPlanReviewer.enabled` (`engine/src/config/config.ts::Roles`) is
gate⓪'s ONE unit switch — the drafter has no `enabled` toggle of its own because it
only ever runs from inside the plan_review phase (`engine/src/loop/round-defaults.ts::createDefaultPeripherals`).

**The cycle** (`engine/src/roles/plan-review.ts::reviewOneIssue`, one per Ready-lane
candidate issue): the reviewer session judges the issue's CURRENT body (refetched
every cycle, never a phase-start snapshot — `plan-review.ts::reviewOneIssue`) and returns one
of three decisions: `approve` (write any body revision, apply `plan:approved`, done),
`verify_na` (apply `needs-human` THEN `verify:n/a`, ordering-invariant so a partial
double-label failure fails closed non-dispatchable — `plan-review.ts::reviewOneIssue`), or
`draft_request` (brief the drafter). On `draft_request`, the drafter session drafts a
revised body from the reviewer's brief; the engine writes it
(`forge.updateIssueBody`) and loops back to a fresh reviewer cycle against the
drafter's edit. `roles.verificationPlanReviewer.maxDraftCycles` (default 2, `engine/src/config/config.ts::Roles`)
bounds the loop — at the bound, the engine escalates rather than cycling forever
(`plan-review.ts::reviewOneIssue`).

| Element | Detail |
|---|---|
| Responsibility | Gate⓪: every Ready-lane issue must clear plan review (a verification plan the reviewer accepts) before it is dispatchable. The reviewer judges; the drafter repairs on a bounce. `plan-review.ts::createPlanReviewStub`. |
| Write scope | Tier 1 (unreachable) for WRITES on all three sessions (reviewer, drafter, and #214's confirm variant): `ROLE_ALLOWED_TOOLS = "Read,Grep,Glob"` (`engine/src/roles/peripheral.ts::ROLE_ALLOWED_TOOLS`) for the reviewer/drafter (the drafter's `PLAN_DRAFTER_DISALLOWED_TOOLS`, `peripheral.ts::PLAN_DRAFTER_DISALLOWED_TOOLS`, is a regression trip-wire only — it is byte-identical to the base `ROLE_DISALLOWED_TOOLS`, and the real boundary is that shared deny-list, `peripheral.ts::ROLE_DISALLOWED_TOOLS`); the confirm variant carries `CONFIRM_ALLOWED_TOOLS = ROLE_ALLOWED_TOOLS` (`peripheral.ts::CONFIRM_ALLOWED_TOOLS`) — the same real READ channel (repo inspection, so it can actually judge plan freshness against the current checkout) but still no `Bash`/`Write`/`Edit`/`MultiEdit` of any kind on any of the three, so tier 1 holds for every write path. Tier 3 choke point: `plan-review.ts::reviewOneIssue` is the sole caller of `forge.updateIssueBody`/`forge.addLabel(plan:approved\|needs-human\|verify:n/a)`/`forge.addIssueComment` for this phase; `confirmOneIssue` (`plan-review.ts::confirmOneIssue`) is the analogous choke point for the confirm variant — a `"confirm"` decision makes ZERO forge writes, an `"invalidate"` decision routes into the SAME `reviewOneIssue` machinery via its `seed` parameter. The drafter's write is structurally never self-approving: it has no label-write path at all — `plan-review.ts` never calls `forge.addLabel` on the drafter's behalf. |
| Marker idempotency | `planReviewMarker(roundId)` (`plan-review.ts::planReviewMarker`), standard convention, round-phase granularity — the whole phase (every candidate issue) is one unit of idempotent work; a non-null marker skips the entire phase, not just completed issues. |
| Output schema + validation | `VerificationPlanReviewerMetadataSchema` (`plan-review.ts::VerificationPlanReviewerMetadataSchema`, `decision ∈ {approve, draft_request, verify_na}` + `issue`) validated by `validateReviewerOutput` (`plan-review.ts::validateReviewerOutput`) — schema AND a content invariant: an `approve` claim's body (revised or current) must actually have `extractVerificationPlan` find a plan section (schema-valid is not the same as truthful). `VerificationPlanDrafterMetadataSchema` (`plan-review.ts::VerificationPlanDrafterMetadataSchema`, `{issue}` + required body) validated by `validateDrafterOutput` (`plan-review.ts::validateDrafterOutput`) with the SAME content invariant applied to the drafted body. This is the **highest decision-weight** output in the codebase (`plan:approved` is the dispatch key) and carries the deepest validation — see `docs/PLAN.md`'s write-inventory table for the full field-by-field breakdown. |
| Escalation path | Gate-blocking — the ONE role pair whose failure escalates rather than degrading silently. A reviewer session that fails twice, or never validates, applies `needs-human` + an attempt-trail comment (`plan-review.ts::escalateNeedsHuman`) and the `plan-review-escalated` state event; same for a drafter that never validates. Exhausting `maxDraftCycles` escalates the same way (`plan-review.ts::reviewOneIssue`). A human resolution (a real plan, or accepting `verify:n/a` by removing `needs-human`) is required to make the issue dispatchable again — see [`configuration.md`](configuration.md) and issue #147's re-entry path for how a human-resolved gated issue re-enters the loop. |

### harvest (harvesting)

| Element | Detail |
|---|---|
| Responsibility | Round-close summary: briefs the round's needs-human issues with round context (a few lines each, not a report). The write-target BOUND is closed-form pre-session — the engine-built round artifact (`round-artifact.ts`) computes the `needsHuman` set from the durable ledger BEFORE the session runs; the session may brief any subset of that set, including none (an empty `comments` array is valid — the phase closes normally, no degradation event), but never an issue OUTSIDE it. `engine/src/loop/harvest.ts::createHarvestStub`. |
| Write scope | Tier 1 (unreachable) for writes: `createHarvestStub` passes only `disallowedTools` (`harvest.ts::createHarvestStub`), no `allowedTools`, so `peripheral.ts`'s `opts.allowedTools ?? ROLE_ALLOWED_TOOLS` fallthrough gives it the same base `ROLE_ALLOWED_TOOLS = "Read,Grep,Glob"` READ floor as the other four tier-1 roles above — no WRITE grant. `HARVEST_DISALLOWED_TOOLS` (`harvest.ts::HARVEST_DISALLOWED_TOOLS`) is now byte-identical to the base `ROLE_DISALLOWED_TOOLS` (`peripheral.ts::ROLE_DISALLOWED_TOOLS`) — a regression trip-wire only, the same shape as the verification-plan-drafter's `PLAN_DRAFTER_DISALLOWED_TOOLS` above; the standalone `gh issue edit*` pattern-deny it once carried was dropped once the blanket Bash deny made it redundant. Harvest writes comments only, never a label or body edit. Tier 3 choke point: `harvest.ts::createHarvestStub` is the sole caller of `forge.addIssueComment` for this phase; every target is set-checked against the pre-computed `needsHumanIssues` list. |
| Marker idempotency | `harvestMarker(roundId)` (`harvest.ts::harvestMarker`), standard convention. No needs-human issues to brief → no session run, but the phase still closes with its marker set (`harvest.ts::createHarvestStub`). |
| Output schema + validation | `HarvestMetadataSchema` (`harvest.ts::HarvestMetadataSchema`, `comments: [{issue, body}]`) validated by `validateHarvestOutput` (`harvest.ts::validateHarvestOutput`) — schema PLUS a set cross-check: every `issue` must be inside the engine's pre-computed `needsHumanIssues` set, or the WHOLE batch fails (never a partial apply); duplicate issue numbers in one batch are also rejected outright. An empty `comments` array is valid ("nothing to brief" is a legitimate outcome). |
| Escalation path | Advisory, degrade-and-proceed — a summary role must never wedge round termination. A session that fails twice or never validates fires `harvest-degraded` (`harvest.ts::createHarvestStub`, payload shape preserved exactly across the #110 rework: `{round_id, outcome, session, attempts}`); the phase closes with no comments posted. |

### retro (retro)

| Element | Detail |
|---|---|
| Responsibility | Self-evolution / retrospective: analyzes the round's engine-built digest (PR diffs, review signals, escalated-issue comments/labels, commits since round start — `retro-digest.ts`'s `buildRetroDigest`) and proposes prompt/config/doc improvements EXCLUSIVELY as a PR through the normal gate② path, never a direct write. **#453 (design #402 R5):** the digest also carries a cross-round **finding-class tendency table** — `(kind, path-prefix)` → count / distinct PRs / distinct rounds, tabulated from the durable `drive-fixup` finding records over the last `roles.retro.tendencyRounds` rounds (default 3). The engine tabulates only; whether a recurring class is evidence about the *design* is retro's judgment, and reaches the backlog solely as a gate②-reviewed proposal PR — no engine path turns a finding or a finding class into an issue. Cadence-gated by `roles.retro.everyNRounds` (default 1). `engine/src/retro/retro.ts::createRetroStub`. |
| Write scope | **The one role NOT at tier 1** — retro is worker-class (needs real git: branch/commit/push inside its own ephemeral worktree), so its containment is narrower-but-still-strong: `RETRO_ALLOWED_TOOLS` (`retro.ts::RETRO_ALLOWED_TOOLS`) grants `Read/Write/Edit/MultiEdit` + local git only, with **zero `gh` entries of any kind** (#111 PR-B removed the last one, `gh pr create`) — `RETRO_DISALLOWED_TOOLS` (`retro.ts::RETRO_DISALLOWED_TOOLS`) denies pushing to `main`/`master` by name plus the specific merge/review/ready/edit/comment/api `gh` verbs it lists (`gh pr merge*`, `gh pr review*`, `gh pr ready*`, `gh pr edit*`, `gh issue edit*`, `gh issue comment*`, `gh api*`, `gh pr create *--body-file*`) — not every `gh` verb — as a regression trip-wire. Tier 3 choke point: `openProposalPR` (`retro.ts::openProposalPR`) is the sole caller of `forge.openPR`, and only after an engine-side `forge.branchExists` read verifies the session's claimed push — a session's claim is never trusted as evidence by itself. |
| Marker idempotency | `retroMarker(roundId)` (`retro.ts::retroMarker`), standard convention. A round whose id isn't a multiple of `everyNRounds` skips the session but still sets the marker (`retro.ts::createRetroStub`) — the phase always closes. **Worktree retention (#428, closes the gap this row used to name):** retro's ephemeral worktree is no longer deleted unconditionally. `peripheral.ts::RoleRunner.maybeRetainWorktree` KEEPS it when all three hold — a write-capable grant (today only retro), a non-`done` outcome, and uncommitted edits — and appends a durable `role-worktree-retained` event naming the path, round id, outcome, and the basis of the dirty verdict, so a draft lost to a crash/timeout before push is diagnosable instead of silent. Dirtiness is a **pure-filesystem** measurement, never `git status` (which can invoke a session-set clean filter — the #65 RCE class): anything under the worktree newer than the worktree's own git index (`<gitDir>/index`, resolved through the linked-worktree `gitdir:` pointer via `context-manifest.ts::resolveWorktreeGitDir`), reusing `worker.ts::worktreeMaybeDirty` — the ONE such scan — with a different baseline. Failure directions are asymmetric on purpose — a false positive costs disk and is visible in the event (an unresolvable index reads dirty rather than guessing clean); a false negative is only reachable for work the session had already committed, and a linked worktree's objects/refs live in the parent repo's common `.git`, so a commit survives deletion. Still deliberately NOT a #69-style `needs-human` escalation: retro has no issue/PR to attach one to, and the next round simply tries again. The happy path is unchanged — a session that pushes and exits 0 still has its worktree deleted. |
| Output schema + validation | NOT the JSON sentinel block — a fixed scratch file (`RETRO_SCRATCH_FILE = ".sapwood-retro-pr"`, `retro.ts::RETRO_SCRATCH_FILE`) the session writes mid-session (survives a truncated final message). `parseRetroScratch` (`retro.ts::parseRetroScratch`) fail-closed parses either the literal `none` (explicit quiet round) or a labeled `branch:`/`title:`/body proposal, with `invalidBranchReason` (`retro.ts::invalidBranchReason`) checking ref-safety, no `..` traversal, and refusing the default branch by name. A missing file is `invalid`, not "quiet round" — the prompt requires the file always be written. |
| Escalation path | Advisory at the session level (degrade-and-proceed: `retro-degraded`, `retro.ts::createRetroStub`, a lost pass costs one round's proposals only), but the PR-open step has its OWN three-way degrade (`openProposalPR`, `retro.ts::openProposalPR`): branch not verified-pushed → no `openPR` call, degrade naming the branch; `openPR` throws after a verified push → degrade, but the pushed branch is preserved evidence a human (or the next round's retro) can open by hand; success → durable `retro-pr-opened` event. None of these wedge the round. |

## Cross-cutting notes

- **Structured output format.** Five of the six roles (all but retro) share one
  sentinel-delimited shape (`structured-output.ts`): a JSON metadata segment between
  `<<<SAPWOOD_RESULT>>>`/`<<<END_SAPWOOD_RESULT>>>`, plus an optional raw-markdown BODY
  segment between `<<<BODY>>>`/`<<<END_BODY>>>` — kept separate so a markdown body's
  own code fences never have to survive JSON-string escaping. `parseStructuredBlock`
  fails closed on any ambiguity (truncated block, trailing content, an embedded
  sentinel inside the body) — never a partial/best-guess slice.
- **`RoleRunner` and `runSessionWithRetry`.** Every role reuses `engine/src/
  roles/peripheral.ts`'s `RoleRunner` to spawn its session (one bounded `await`, no
  probe/resume — a role session never has real work-in-progress, so its worktree is
  always safe to delete afterward) and its shared `runSessionWithRetry` helper
  (`peripheral.ts::runSessionWithRetry`) for the retry-once-then-degrade mechanics: a session's own
  outcome (`done`/`failed`/`timeout`) is never assumed — a "done" session whose
  structured output fails an `isValid` check is treated identically to a failed one.
  Only verification-plan-reviewer's escalation shape (needs-human, not a state-event degrade) is
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
any phase — will need to declare all six elements above explicitly rather than
inheriting them from a hardcoded module: a write scope chosen from the SAME
engine-enumerated tier ladder (never a bespoke tool grant), a marker-idempotent
`PeripheralStub.run()`, a schema-validated output the engine parses fail-closed, an
explicit escalation choice (advisory vs. gate-blocking), and a named evidence channel
(or first-class abstention) for every judgment its prompt asks of it. This doc is that
prerequisite contract, written against what the six built-in roles already do.
