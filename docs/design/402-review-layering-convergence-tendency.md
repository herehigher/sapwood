# Design #402 — review layering, convergence, and tendency

Status: **adjudicated and shipped** (issue #402, `verify:n/a` doc-gate). Originally a
design-first document — nothing in it was implemented by the issue that produced it;
the deliverable was this doc plus the implementation issues in §11. All six follow-ups
have since landed: **R1** #448 (finding axes + severity gate), **R2** #449 (per-round
finding record), **R3** #450 (convergence classifier, stop, and `prFixCap` 2 → 4),
**R4** #451 (dispute costs zero paid fix legs), **R5** #453 (retro tendency table),
**R6** #454 (this prompt-and-docs round-close, 2026-07-31). Owner rulings D1–D6 below
are adjudicated as written; where the shipped behavior refined a section during
implementation, the section says so in place (§4a is the largest such correction).

**Shipped state vs. this document.** Read the docs, not this file, for what is true now:
[`../PLAN.md`](../PLAN.md)'s fix-loop paragraph (convergence, layering, `prFixCap`
semantics), [`../configuration.md`](../configuration.md) (`lanes.prFixCap`,
`roles.retro.tendencyRounds`, `reviewer.agent.promptFile`),
[`../role-paradigm.md`](../role-paradigm.md) (the reviewer's enforced/judged split), and
the shipped prompt `engine/prompts/engine-reviewer.md` itself. This document remains the
record of *why* — the alternatives rejected and the blind spots accepted on the way.

**One item stays open, and deliberately not as a follow-up of this design:** §4a's
missing dispute channel on the `engine-agent` reviewer path. It is a pre-existing defect
in the review path as already shipped (design #279's findings-transport decision), which
this design's own PR surfaced rather than specified; §4a carries its ⚠️ action-required
note and an already-adjudicated preferred fix for a human to file. #402's own follow-up
set was complete at R1–R6, and closing it never depended on that issue existing.

The review spiral's *mechanics* are sound and out of scope: a fix leg's new commits
already force a genuinely fresh, head-OID-bound review (`conductor.ts`'s trigger-pin
clear in the same transaction as the state change; `merge-driver.ts`'s re-trigger on
head change; `reviewer.ts`'s `freshHeadReviewCount` counting only current-head
reviews). What is missing is any notion of **whether a round made progress**.

Evidence base (all re-verified against `main` at bc5f52f while writing this):

| Claim | Verified at |
|---|---|
| `Finding` is exactly `{id, body}` | `roles/reviewer.ts:246-252` |
| A third key on one finding voids the WHOLE engine-agent output | `review/agent-output.ts`'s `validateAgentFindings` (`Object.keys(f).length !== 2`) |
| `deriveApprovalResult` is binary — any finding ⇒ `rejected` | `review/agent-output.ts:232-256` |
| `deriveReviewAction` cannot tell a nit from a security defect | `roles/reviewer.ts:109` (`unresolvedThreads > 0` ⇒ `HANDLE_THREADS`) |
| `lanes.prFixCap` default 2, escalates at cap | `config/config.ts:82`; `conductor.ts`'s `driveDecision` + `fix-rounds-capped` |
| dispute = speak-not-act, thread stays open | `loop/fix-response.ts:360-368`; `resolution: "addressed" \| "disputed"` at `:61` |
| `reviewer.fallback` is unavailability failover only | `config/config.ts:264` |
| PR#388 = 4 review rounds, PR#389 = 5, every round a real bug | dogfood PM channel, 2026-07-27 |
| crash-consistency finding class recurred across #191/#170/#172 and the M9 wave | repo history |
| the engine records NO per-round finding identity | `state.ts:1627` — `engine_review_wal` is **upsert-by-worker_name**, documented "current attempt only, never append-only"; `drive-fixup`'s payload is `{worker, issue, pr, fixRounds, reason}` |

## Owner rulings

- **D1 — #378 ships FIRST as a plain defect, and is an INPUT to this design, not a
  follow-up of it.** (The explicit ruling the architectural review demanded; #401 got
  the mirror-image ruling and was absorbed.) Rationale: #378's mechanism is *"an
  adjudicated finding on unchanged code is not fresh signal"* — a finding-**identity
  and staleness** correctness fix. This design's items 3 and 4 are about **progress**
  and **adjudication routing**. They are adjacent, not overlapping: #378 decides
  whether a finding counts *at all*, §3 decides what a set of counting findings
  *means*. Concretely, #378's per-thread resolution-oid + span/content-hash plumbing
  is the primitive §3's identity key is built on, so absorbing it would delay this
  design behind its own dependency. Constraint accepted in exchange: **no follow-up in
  §11 may change #378's filter semantics** — §3 consumes its output and never
  re-litigates it. If #378 lands after R2/R3, §3's identity key degrades to
  thread-id-only for the classic path, which is a *narrower* filter, never a wider one
  (fail-closed direction).
- **D2 — one axis reaches the gate, and only one.** `severity` (two states). Every
  other axis is analysis-only. A taxonomy edit must never be a gate change.
- **D3 — the reviewer session may not lower its own gate.** `severity: "advisory"` is
  honored only for an engine-side allowlist of kinds; anything else is forced back to
  blocking and the override is recorded. Engine-enforced, prompt-independent.
- **D4 — a dispute is priced at zero paid fix legs**, not at a threshold. Speak-not-act
  is preserved: the producer replies, the ENGINE escalates, a human adjudicates.
- **D5 — tendency lives in retro, and retro *judges*; the engine only tabulates.** No
  engine path turns a finding into an issue.
- **D6 — `prFixCap` semantics are unchanged; its default rises 2 → 4.** It goes back to
  being a cost ceiling because convergence (§3) now supplies the quality stop.

## 0. The one structural fact that shapes the whole plan

**Every mechanism in §1–§6 can be built without touching a human-merge-only path.**
Verified against `PROTECTED_SUFFIXES` (`guard/guard.ts:617-622` = `guard.ts`,
`guard-hook.ts`, `roles/reviewer.ts`, `roles/merge-driver.ts`) and docs/security.md's
"Human-merge-only paths":

- `isFinding` / `validateFindings` (`reviewer.ts:258-270`) check **presence and type of
  `id`/`body` only — they do not reject extra keys.** So `Finding & {severity, kind}`
  already validates today. The only key-count check is `validateAgentFindings` in
  `review/agent-output.ts` — **unprotected**.
- The binary gate derivation for the engine-agent path is `deriveApprovalResult`, also
  in `review/agent-output.ts` — **unprotected**.
- The fix-round scheduling decision is `driveDecision` in `loop/conductor.ts:283` —
  **unprotected**. `merge-driver.ts`'s `deriveGate` produces the *gate string*, which
  this design does not change.

Consequence: none of §11's issues need the patch-only, human-apply dance #378's ACs
#2–#4 require. That is not a coincidence to be grateful for — it is the reason the
design is shaped this way. Any alternative that would have required editing
`reviewer.ts`/`merge-driver.ts` was rejected on that ground alone unless it bought
something the unprotected placement could not.

## 1. Layering — what a finding carries

```ts
// review/finding-axes.ts (NEW, unprotected). Extends roles/reviewer.ts's Finding
// WITHOUT editing it (see §0): both axes are optional additive keys.
export const FINDING_KINDS = ["correctness", "security", "design", "test-coverage", "style"] as const;
export const ALLOWED_FINDING_KEYS = new Set(["id", "body", "severity", "kind", "path"]);
/** severity: "advisory" is honored ONLY for these kinds (D3). */
export const ADVISORY_ELIGIBLE_KINDS = new Set(["style", "test-coverage"]);

export type ClassifiedFinding = Finding & {
  severity?: "blocking" | "advisory";
  kind?: (typeof FINDING_KINDS)[number];
  /** Target file, validated to be a member of the reviewed diff's changed-path set. */
  path?: string;
};
```

**Gate-consuming axis: `severity` only** (D2). `kind` and `path` exist for §3
(convergence) and §5 (tendency) and are never read by any gate.

**Fail-closed defaults, and the difference from invalid values** — this distinction is
the whole safety argument, so it is stated as a rule, not left to the reader:

| Input | Treated as | Why |
|---|---|---|
| `severity` absent | `blocking` | today's exact behavior; a classic-path reviewer or an older prompt degrades to no change |
| `kind` absent | `unclassified` (analysis only) | ditto; an unclassified finding is never advisory-eligible |
| `path` absent, or naming a file not in the reviewed diff | dropped to `null`, recorded | a path outside the diff is unlocatable, not a schema violation |
| `severity: "advisory"` with `kind ∉ ADVISORY_ELIGIBLE_KINDS` | **forced to `blocking`**, `severityOverridden` recorded in the artifact | D3 — the session must not be able to wave through a security defect by labelling it |
| `severity`/`kind` present with a value outside its enum | **whole output void** | schema drift, not a degraded reading; matches the existing no-partial-accept stance |
| any key outside `ALLOWED_FINDING_KEYS` | **whole output void** | unchanged from today, just an allowlist instead of a count |

**The strict-shape guard is relaxed by allowlist, not by loosening.**
`validateAgentFindings`'s `Object.keys(f).length !== 2` becomes
`Object.keys(f).every(k => ALLOWED_FINDING_KEYS.has(k))` **plus** closed-enum
validation of each present axis. Key count is no longer the check; membership is. The
"an extra key voids the whole output" property is retained verbatim for genuinely
unknown keys — which is what the guard was actually protecting.

**Gate change (`deriveApprovalResult`, `review/agent-output.ts`):**

```
blocking = findings.filter(effectiveSeverity(f) === "blocking")
blocking.length > 0                          ⇒ rejected (findings = blocking only)
blocking.length === 0 ∧ any perAC cannot-confirm ⇒ rejected (synthesized per-AC finding, unchanged)
otherwise                                    ⇒ approved, advisories recorded in evidence
```

The per-AC path stays **independently blocking** and unchanged: any `cannot-confirm`
⇒ `rejected` regardless of finding severities. That is the structural backstop behind
D3 — a reviewer cannot approve a PR whose acceptance criteria it could not confirm, no
matter how it labels its findings. It is also why `test-coverage` can safely be
advisory-eligible: missing coverage *for a listed AC* is a `cannot-confirm`, not a
finding, and blocks on the other path.

**Classic path (`different-model-codex` / `human`): unchanged in v1.** GitHub review
threads carry no severity field, so `deriveReviewAction` (`reviewer.ts:109`, protected)
needs no edit and gets none. Accepted, stated blind spot: **on the classic path every
unresolved thread still blocks, exactly as today.** Layering is an engine-agent-mode
capability in v1. Closing it would mean either inventing a severity convention in
comment prose (inferred text — doctrine violation) or editing a protected path for a
mode whose reviewer cannot supply the data anyway.

**Rejected alternatives.** Numeric severity 0–3 (invites boundary arbitration; the gate
can only act on two states, so two is the honest cardinality). Required, non-optional
axes (invalidates every classic-path and older-prompt output — a gate outage dressed as
a schema improvement). Engine deriving `severity` from `kind` (makes `kind`
gate-consuming, violating D2, and turns adding a taxonomy value into a gate change).
Engine deriving severity from finding prose (inferred text; the doctrine's
authoritative-signals rule forbids it, and the failure direction is a false *approval*
— the worst one available here). Adding the axes to `Finding` in `reviewer.ts`
(protected-path patch-only, for zero benefit over the additive extension in §0).

## 2. Non-blocking disposition

**Decision: recorded only, in v1. No finding ever becomes an issue by an engine path.**

An advisory finding is (a) rendered in the audit comment under its own
`### Advisory (non-blocking)` heading — same blockquoted, write-boundary-sanitized
rendering `audit.ts` already applies, so advisory prose still cannot become an
approval-parseable comment; (b) recorded in the per-round finding record (§3) with its
`kind`; (c) counted in retro's tendency table (§5). It does not block the gate and does
not cost a fix leg.

**Who may promote one to work: retro, and only via its existing PR path.** Retro
already proposes prompts/config/docs changes exclusively as a PR through gate②
(`retro/retro.ts` module doc) and already carries the "recurring findings are a design
signal, not a fix queue" amendment in `prompts/retro.md`. Promotion is therefore
**per-class, not per-finding**, and passes a human-reviewed gate on the way in.

**How this avoids becoming a backlog spam generator** — three properties, stated so a
reviewer can check them: (1) the only finding → issue path runs through a
human-reviewed PR; (2) it is keyed on a *class* seen across PRs, so one nit on one PR
can never produce an issue; (3) the engine has no issue-creating code path for
findings at all, so the spam failure mode is not merely discouraged, it is absent by
construction.

**Rejected.** Engine auto-opens a follow-up issue per advisory finding (one issue per
nit per PR — the spam generator by definition, and it would launder unadjudicated LLM
prose straight into the work queue, against the standing "findings are inputs, not
gospel" principle). Harvest/PO promoting advisories (harvest does hold issue-write
scope, but it works from the board and this would bypass adjudication entirely).
A `severity: "followup"` third state (a disposition masquerading as a severity; the
disposition question is "who decides", and an enum value cannot answer it).

## 3. Convergence — a per-round progress definition

### 3a. The data, and what is honestly new

**Nothing usable exists today.** `engine_review_wal` is upsert-by-`worker_name` and its
own doc says "current attempt only, never append-only" — the previous head's artifact is
overwritten, deliberately, because that table's contract is crash reconciliation for
*one* attempt. `drive-fixup`'s payload carries `{worker, issue, pr, fixRounds, reason}`
— a gate reason string, no finding identity.

**Minimal addition: extend the existing `drive-fixup` event payload.**

```
drive-fixup: { worker, issue, pr, fixRounds, reason,
               findings: [{ key, severity, kind }],   // NEW, bounded, ids only — no prose
               fixDiffPaths: [string] }               // NEW, changed paths of the PRECEDING fix leg
```

Reuses the append-only event ledger and `state.eventsAfterId` (already the id-cursor
read pattern #403 established). Reading round *r−1*'s set is one filtered ledger read.
No new table, no new subsystem, no migration.

**The identity key** (`review/finding-key.ts`, new, unprotected) — structural data only:

- **engine-agent path:** `(kind ?? "unclassified", path ?? "«unlocated»")`.
- **classic path:** the review thread id, plus #378's span content hash once it lands
  (D1) — threads carry `path`/`line`, so both paths produce a `(path, span)`-shaped key.

**Accepted blind spot, stated as such: an *unlocated* finding (no `path`, or a `path`
not in the reviewed diff) contributes to the count signals but never to the recurrence
signal.** Its identity cannot be established from structural data, and the alternative
— hashing normalized finding prose — is defeated by rewording and is exactly the
inferred-text trap the doctrine names. The prompt (§6) asks for `path`; a reviewer that
omits it degrades this lane to count-only convergence, which is weaker, not wrong.

### 3b. The classifier

`review/convergence.ts` (new, unprotected). Pure:
`classifyProgress(prev: FindingKey[], curr: FindingKey[], fixDiffPaths: string[], flatStreak: number) → "converging" | { stalled: reason }`.
Evaluated over **blocking** findings only, at the moment a fix leg's re-review returns
a decisive verdict.

| Shape | Verdict |
|---|---|
| no previous round (round 1) | **continue** — by definition |
| `\|curr\| < \|prev\|`, or `curr ∩ prev = ∅` (all old findings gone, new ones elsewhere) | **continue** — count falling, or new areas |
| a key in `curr ∩ prev` **and** its path is in `fixDiffPaths` (the fix touched it and the finding survived) | **stop:** `recurrence` |
| `\|curr\| ≥ \|prev\|` for two consecutive rounds | **stop:** `flat` |
| a key in `curr \ prev` whose path is in `fixDiffPaths` (new problem *inside* the previous fix) | **stop:** `marginal-complexity` |
| anything else (count up for one round, no recurrence, no new-in-fix) | **continue** — one bad round is not a trend |

`recurrence` deliberately requires *the code to have changed in between*. An
identity-equal finding on **unchanged** code is #378's case and is filtered upstream,
before it ever reaches this function (D1). `marginal-complexity` is the signature the
issue names — the recovery mechanism generating the problem — and is the classifier's
reason for existing beyond simple counting.

### 3c. Wiring and the stop

`driveDecision` (`conductor.ts:283`, unprotected) gains one more input:

```ts
driveDecision(gate, fixRounds, cap, overBudget, progress /* "converging" | {stalled} */)
// FIXABLE ∧ progress.stalled ⇒ ESCALATE  (before the fixRounds < cap check)
```

Escalation reason is `review-non-convergent:<signal>`, with its own event
(`review-non-convergent`) — **deliberately distinct from `fix-rounds-capped`**, because
the entire point of this design is that "rounds spent" and "no longer making progress"
are different facts that were sharing one signal. The escalation comment cites the
signal, the two rounds' finding keys, and the doctrine's runaway-complexity /
design-re-entry principle (which is the intended response, not just human escalation).
Return path is the existing #147 gated reclaim — no new re-entry channel.

**Rejected.** A new `pr_finding_history` table (a table for what an append-only ledger
already stores). Retaining full artifacts per head in `engine_review_wal` (unbounded
prose in state, and it would muddle a contract that exists for single-attempt crash
recovery). Re-reading the PR's audit comments each tick (a network read per tick,
prose parsing, and no equivalent exists on the classic path). Prose-similarity
clustering of finding bodies (inferred text; and the false-positive direction here
silently *stops* a productive lane). Putting the classifier in `merge-driver.ts`'s
`deriveGate` (protected path, and the gate string is a review-state fact — progress is
a lane-history fact, which belongs where fix rounds are already counted).

## 4. Dispute pricing

**Decision: a dispute reaches a human at the earliest moment it is the only thing left,
and costs zero further paid fix legs.**

**Scope, corrected after live operation: this section covers the CLASSIC reviewer path
(threads) only.** The `engine-agent` path has no review threads and therefore had no dispute
channel at all — see §4a, which was written from evidence this design's own PR produced, and
which #461 has since closed with an audit-comment-keyed channel that routes into this same
escalation.

Precisely: on a DRIVE tick where the gate is `FIXABLE` and every unresolved thread on
the current head has a recorded `disputed` resolution for that head, the lane escalates
to `needs-human` with reason `review-disputed` instead of dispatching a fix leg. Both
inputs already exist — `fix-response`'s own thread rows carry the resolution, and live
thread state is already fetched every tick.

**Why "only thing left" and not "immediately on any dispute":** a fix leg may report a
mix (two addressed, one disputed). Escalating that tick would pull a human in while the
lane still has productive, already-paid-for work queued — the mirror image of the bug
being fixed. So the addressed threads' fix pushes, the re-review runs, and the
escalation fires on the tick where the dispute is genuinely the blocker.

**Why zero rounds and not a threshold:** a dispute is not a cost decision, it is a
semantic disagreement between two agents. No number of extra rounds resolves it — the
reviewer re-raises, the producer re-disputes — so a threshold prices one bit of human
judgement in paid fix legs, which is the exact defect this item exists to remove.

**Evidence that goes with it** (in the escalation comment): the thread id, the
reviewer's finding body, the producer's dispute reply verbatim, the head OID both were
written against, and the count of fix rounds already spent. Enough to adjudicate
without opening the PR's thread history.

**Speak-not-act is preserved and strengthened.** The producer still only replies and
never resolves a disputed thread (`fix-response.ts:360-368`, unchanged). The ENGINE
escalates; the human adjudicates. Nothing here lets a producer's dispute clear its own
gate.

**Rejected.** Escalate after N disputed rounds (prices judgement in paid legs — the
defect). Auto-accept a dispute after N rounds (the producer adjudicates its own case by
attrition — a direct non-negotiable violation). Auto-reject a dispute (makes `disputed`
a no-op and destroys the dissent channel PLAN.md's dissent doctrine exists for).
Route disputes to a second reviewer (that is quorum, out of scope per §7 — and a second
LLM's opinion is not adjudication).

## 4a. Scope correction: on the engine-agent path there is no dispute channel at all

**Discovered in live operation, on this design's own PR (#455), and it corrects §4.**
§4 above is written over *review threads*. On the `engine-agent` reviewer path there
are none, so §4's mechanism — and the producer's dissent channel generally — does not
exist there today. The chain, each link verified in source rather than inferred:

1. A `rejected` engine-agent verdict does not come from threads. It is mapped to a
   **synthetic** action: `syntheticVerdictAction` (`review/drive.ts:172`) returns
   `HANDLE_THREADS` for `rejected`, so the existing `finalizeVerdict`/`deriveGate` path
   can be reused unchanged.
2. Findings reach the fix leg through the bounded audit channel only —
   `getPRAuditComments` (`proxy/tools.ts:38`), a **top-level PR comment**, per design
   #279 §1's findings-transport decision.
3. **The engine has no thread-CREATING forge write.** `IForge` exposes
   `replyToReviewThread` and `resolveReviewThread` (both require an existing thread id)
   and, at the GraphQL layer, only `addPullRequestReviewThreadReply` — there is no
   `addPullRequestReviewThread` / `addPullRequestReview` / `createReview` anywhere.
4. Therefore `pr_review_threads` is legitimately EMPTY on an engine-agent-reviewed PR.
5. The fix leg's only report contract *was* `threadResponses`, and every entry is keyed on
   a thread id the engine can verify the producer actually saw. (#461 added the second
   contract this section calls for — see "What closes it" below; points 1-4 are unchanged
   and are exactly why that contract could not simply reuse thread ids.)

⇒ **On the engine-agent path a fix leg can express neither `addressed` nor `disputed`
for any finding.** Not "it is awkward" — there is no id to key an entry on, and
inventing one voids the whole report by design. The dissent doctrine PLAN.md states, and
§4 above prices correctly, is structurally unreachable in the mode this repo actually
runs.

**Observed consequence, this PR:** the sole finding on #455 was `ac5-issue-linkage` — an
explanatory note recording *why* the reviewer marked AC5 `claim-accepted`, alongside
four `confirmed` and two `claim-accepted` criteria and zero defect claims. Because
`deriveApprovalResult` is binary (§1), that note became a `rejected` disposition; because
of this section, the producer could not answer it; so the lane re-dispatched an identical
fix leg with nothing it could act on. This is §1 and §4 failing *together*, and it is the
sharpest available evidence for both: layering would have made the note advisory and
merged, and a dispute channel would have let the producer say so once.

**What closes it.** ⚠️ **ACTION REQUIRED — a human must file a defect issue for this.**
It is *not* one of this design's implementation issues (§11) and is deliberately not
listed there: the gap is a pre-existing hole in the **engine-agent review path** as
already shipped (design #279's findings-transport decision), which this design's own PR
merely surfaced — not a piece of work #402 asked for or specified. Filing it is therefore
**not a precondition for closing #402**, whose follow-up set is complete at R1–R6; it is a
separate defect against the review path, on its own clock. A fix leg cannot open it (no
forge credentials in that session), which is exactly why it is written down here instead
of quietly dropped. Two candidate fixes, already adjudicated so the eventual issue starts
from a decision rather than a blank page:

- **Preferred: extend the fix-leg report contract with an audit-finding response**, keyed
  on `(finding id, head OID)` — both already engine-verifiable (finding ids come from the
  validated artifact; the head is in the audit marker). The engine posts the reply as a
  top-level comment and applies §4's escalation on `disputed`. Adds no forge write the
  engine lacks, and keeps verification on structured data the engine already holds.
- Rejected alternative: **have the engine open a real review thread per blocking
  finding.** It would unify both paths on one channel, but it adds a
  producer-visible forge write surface the engine deliberately does not have today, and
  it converts every finding into a durable GitHub thread — including the advisories §2
  exists to keep cheap.

**Closed by #461** (filed as predicted above), along the preferred line, with one
deliberate divergence in the identity key: **`(runId, findingIndex)`**, not
`(finding id, head OID)`. `Finding.id` is session-supplied and validated only as a
non-empty string — nothing makes it unique within one review — whereas an index into the
validated artifact's own `findings` array is engine-authoritative and unique by
construction; `runId` already pins the head and diff (the WAL is head-and-diff-keyed), so
carrying a separate head OID would add a second, redundant currency check. `review/audit.ts`
renders that index as the `[N]` prefix on every finding so a credential-free fix leg can
copy the handle verbatim, the same way the classic path copies a `threadId`. The fix leg's
report gained an optional `findingResponses` block validated against two independent facts
(the leg was *served* that run's audit comment, per the proxy journal; the run's artifact
*has* that many findings, per the WAL) — an unknown run, an out-of-range index, or a
duplicate rejects the whole report, exactly as `threadResponses` does. A `disputed` response
routes to §4's own escalation — the same `review-disputed` event, carrier, and #147 reentry
path, tagged `source: "finding"`, reason `review-finding-disputed:<n>` — carrying the
reviewer's finding body and the producer's reply. The divergence from "the engine posts the
reply as a top-level comment": it does not post a *separate* comment per response; the
escalation comment is the publication, and an `addressed` response rides the durable receipt
only. Nothing about the verdict changes — a dispute is heard, never honored, by the engine.

The residual §3 note still stands on its own account: on this path the per-round finding
record (R2) remains the only *progress* signal a lane emits, which is why §3 records it.

## 5. Tendency — cross-PR finding-class accounting

**Decision: home = retro (`retro/retro-digest.ts` + `prompts/retro.md`). No new
subsystem.** Justified per the AC's marginal-complexity requirement: retro already
(a) receives a deterministic, engine-built, bounded digest it does not fetch itself,
(b) proposes work exclusively as a gate②-reviewed PR, and (c) already carries the
"a recurring finding class belongs at the design source" doctrine in its prompt. It has
been asked to notice tendency without ever being given the data.

**Mechanism.** The digest gains a **finding-class table**: `(kind, path-prefix)` →
count, distinct PRs, distinct rounds — computed from the same `drive-fixup` finding
records §3 adds, over `state.eventsAfterId`. Truncated under the existing
`roles.retro.digestMaxChars` cap with the existing deterministic, marked truncation —
never a silent drop.

**Cross-*round*, not just cross-PR.** One round's digest is bounded by
`round.start_event_id`; a class recurring across rounds (the #191/#170/#172 →
M9-wave shape) needs a wider read. New config `roles.retro.tendencyRounds` (default
`3`): read from round *n−K*'s `start_event_id`. Bounded, operator-tunable, append-only
ledger, no new storage.

**The rule that turns a class into a design issue is AGENT-JUDGED, not engine-fired.**
The engine supplies the table; retro decides whether a class is evidence about the
design and, if so, proposes an issue against the design through its normal PR path.
Rationale, and it is the doctrine's own: recognizing "the same class" requires reading
design intent, which is why `docs/REVIEW-DOCTRINE.md` is deliberately prose and not a
lint/DSL. An engine threshold firing at `count === 3` would be a spam generator with no
adjudication, and would be wrong precisely in the interesting cases.

**Accepted blind spot, stated as such:** a genuine recurring class goes unnoticed if
retro is disabled, or if retro judges wrong. The mitigation is that the table is
durable and visible in the digest and the ledger — not that the engine acts on it.

**Rejected.** A new `tendency` peripheral role (a whole role for a table retro already
renders). Dashboard-only surfacing (v0.2 dashboard is deferred, and this has to work
headless). Engine-fired issue creation at a numeric threshold (spam + unadjudicated).
A separate tendency store (the event ledger is already append-only, id-cursored, and
crash-safe — a second store would be a second source of truth for the same facts).

## 6. The reviewer prompt as a designed artifact

`reviewer.agent.promptFile` already exists (`config/config.ts:190-209`) and per this
repo's convention operator-tunable behavior lives in shipped config, never hardcoded in
source. No new config key.

**6a. The enforced/judged boundary, stated in the shipped prompt.**
`engine/prompts/engine-reviewer.md` gains a **"What the engine enforces vs. what you
judge"** section. Today a reader of that file cannot tell which of its instructions the
engine actually checks — the undocumented boundary this item exists to close:

| Engine-ENFORCED (structural, prompt-independent) | Agent-JUDGED (prompt-directed, unverifiable by the engine) |
|---|---|
| exactly one `perAC` entry per manifest id; no unknown/duplicate/missing id | whether a named test is *substantive* and non-vacuous |
| key allowlist + closed enums per finding (§1) | the evidence-tier choice itself (`confirmed` vs `cannot-confirm` vs `claim-accepted`) |
| `severity: "advisory"` honored only for allowlisted kinds (D3) | which `severity` and `kind` a finding deserves |
| `rejected` requires a non-empty findings array | whether a finding is worth writing at all |
| model separation, at parse and via runtime `modelUsage` | the two finding classes the prompt names (re-implementation; uncontrolled-text matching) |
| head/base/diff identity; snapshotted-body drift fail-closed | everything else in the prompt's prose |
| static-only tool profile (no `Bash`, no writes) | |

**Row 7 (static-only tool profile) — SUPERSEDED BY #512 (2026-08-01).** This table
records what #402/#454 decided AT THE TIME, when the shipped prompt's only runner was
the Claude CLI (D1/D5, design #279) and "static-only" was true for the whole system.
Once the `codex-exec` runner shipped (#443), that blanket claim became false for one
runner (`codex-exec` has a shell; only its writes are blocked, per
`engine-review-containment-gap`), and #512 found the shipped prompt still asserting it
— suppressing that runner's only tree-inspection tool. #512 narrowed the enforced row to
what is universally true (no write access, for every runner) and moved the rest to
runner-specific containment, stated in `docs/security.md`'s `#443` exception rather than
claimed as one shared engine-enforced fence. The historical row above is left as-shipped
— this note documents the narrowing, it does not rewrite the record.

**6b. The owner's prompt-tuning findings, folded into the shipped default.** These are
the behaviors repeated hand-tuning converged on; per the issue's own framing they
belong in the shipped prompt, not in one operator's habits:

- **Triage before you write.** A finding you would not block a merge for is
  `severity: "advisory"`. Writing everything as blocking is not thoroughness; it is
  declining to triage, and it is the single biggest structural driver of round count.
- **Name the target.** Set `path` to the file a finding is about. A finding the engine
  cannot locate cannot participate in recurrence detection.
- **Name the class.** Set `kind`. A class recurring across PRs is evidence about the
  design, not about this PR — and the engine can only notice that if you label it.
- **Do not re-raise an adjudicated finding.** If a thread's reply disputes your earlier
  finding, the next move is a human's, not a restatement. (The engine also filters this
  — #378 — but the prompt should not generate it in the first place.)
- **Scope honestly.** A finding outside the acceptance-criteria set is legitimate; label
  its severity honestly rather than blocking a PR on adjacent cleanup.

**Rejected.** Hardcoding tuned text in source (violates the user-tunables-in-config
rule). A second, reviewer-specific doctrine file (`doctrine.file` already exists and is
already injected — a second channel would be two sources of truth). Engine-verifying
the prompt's judgment instructions (most are unverifiable by construction; claiming
otherwise would recreate the undocumented boundary this item closes).

## 7. Scope discipline — what is NOT being built

Stated explicitly rather than left implied, per the issue's item 7:

- **Multiple independent reviewers / quorum / voting — OUT for v1.**
  `reviewer.fallback` (`config.ts:264`) is and remains **unavailability failover only**.
  Reason: cost multiplies per PR, and the observed defect was "no progress signal", not
  "one reviewer was wrong in a way a second would have caught." Revisit trigger, named
  so it is falsifiable: if the convergence data (§3) shows STALLED rounds dominated by
  findings a second reviewer would have refuted.
- **Adversarial re-verification of findings — OUT for v1.** Same cost argument. The
  dispute channel (§4) already routes reviewer-vs-producer disagreement to a human,
  which is the cheap version of the same function.
- **Severity or identity inferred from finding prose — never.** Inferred text; the
  failure direction is a false approval.
- **Findings auto-becoming issues — out** (§2).
- **Any change to the review spiral's head-OID / trigger-pin / re-trigger machinery —
  out.** The issue states it is sound; no follow-up in §11 touches it.
- **Layering on the classic path — out for v1** (§1's stated blind spot).
- **Dashboard surfacing of convergence or tendency — deferred** to v0.2 dashboard work.
- **Any edit to `reviewer.ts` / `merge-driver.ts` / `guard.ts` — out**, by design (§0).

## 8. `lanes.prFixCap` migration story

**Semantics: unchanged.** Still a hard per-PR ceiling on paid fix legs. It is not
repurposed, renamed, or given a second meaning. What changes is that it is no longer the
*only* stop — §3 stops a stalled lane earlier — so the cap is now reached only by lanes
that are, by the engine's own measure, still converging.

**Default: 2 → 4.** Evidence: PR#388 needed 4 rounds and PR#389 needed 5, every round
finding a real bug; at the shipped default of 2 both would have escalated with real
defects still in them.

**Why 4 and not 5, when #389 needed 5** — the honest answer, since it is a deliberate
acceptance rather than an oversight: with convergence live, a lane still converging at
round 4 is an outlier worth a human look, and every increment past that prices a
mis-estimate in paid legs. A #389 escalating at round 4 is *not* the failure mode
today's default has — it is a human being asked after four rounds of measured genuine
progress, which is a materially different and correct signal. The #147 gated-reentry
path already lets a human wave such a lane back in for more rounds without a config
change.

**What existing configs do on upgrade:**

- A config that sets `lanes.prFixCap` explicitly: **completely unaffected.** Same
  number, same semantics.
- A config relying on the default: gets `4`. No migration code, no config rewrite, no
  deprecation window, no new key — the schema shape is identical.
- Docs: one line in `docs/configuration.md` (`lanes.prFixCap` — cost ceiling, not a
  quality ceiling; convergence is the quality stop) plus the PLAN.md decision row.

**Worst-case spend, stated honestly rather than waved off:** for a lane the classifier
calls neither converging nor stalled (§3b's "anything else" row), paid fix legs per PR
rise from 2 to 4. A *stalled* lane's worst case falls, often below 2. The outer bound is
unchanged and remains where it already was — `cost.roundBudgetUsd` /
`cost.dailyBudgetUsd` — and naming that outer-layer dependency rather than calling the
increase self-bounded follows the same honesty the doctrine's env-failure example
demands.

## 9. Marginal-complexity check (per mechanism)

The AC requires every proposed mechanism to be checked against the
marginal-complexity principle: reuse named, new machinery justified, accepted blind
spots stated as such.

| Mechanism | Reuses | Genuinely new | Accepted blind spot |
|---|---|---|---|
| §1 finding axes | `Finding`'s extra-key tolerance (§0 — zero protected edits); `validateAgentFindings`'s void-the-whole-output stance; `audit.ts` rendering | `review/finding-axes.ts`: two `const` sets + one type | classic path has no severity; every unresolved thread still blocks there |
| §1 gate split | `deriveApprovalResult`; the independently-blocking per-AC path | one `filter` + one override rule | a reviewer that labels everything blocking gets today's behavior — and should |
| §3 per-round record | the append-only event ledger; `eventsAfterId` id-cursor reads; the existing `drive-fixup` event | two bounded payload fields | prose is not stored, so a human reading the ledger sees keys, not findings (the audit comment holds the prose) |
| §3 identity key | #378's span/content-hash plumbing (D1); the diff's changed-path set | `review/finding-key.ts` | unlocated findings never trigger recurrence — count-only for that lane |
| §3 classifier + stop | `driveDecision`; `escalateNeedsHuman`; #147 gated reclaim | `review/convergence.ts` (pure, ~40 lines) | a lane oscillating with one bad round then one good never trips `flat`; bounded by the cap |
| §4 dispute escalation | `fix-response`'s resolution rows; live thread state already fetched; `escalateNeedsHuman` | one predicate | a dispute inside a mixed round waits one re-review before escalating (deliberate, §4) |
| §5 tendency | `retro-digest.ts`; `digestMaxChars` truncation; retro's PR path; retro's existing doctrine | one digest section + one config key | disabled or mis-judging retro notices nothing; the table stays durable |
| §6 prompt | `reviewer.agent.promptFile`; `doctrine.file` | prose only | every judged behavior is unverifiable by construction — which is now written down |

**Net new source files: three** (`finding-axes.ts`, `finding-key.ts`,
`convergence.ts`), all pure and unit-testable, all unprotected. **New tables: zero.
New roles: zero. New config keys: one** (`roles.retro.tendencyRounds`). **One default
changed** (`lanes.prFixCap`).

## 10. What this design does NOT claim

- It does not claim the classifier is correct in general. It claims the six shapes in
  §3b are recognizable from structural data the engine can hold, and that stopping on
  three of them is better than stopping on a round counter. The shapes are expected to
  be tuned once real convergence data exists; the config-and-prose placement (§6, §8)
  is deliberately where that tuning can happen without a source change.
- It does not claim advisory findings are harmless. It claims they are *recorded*, and
  that the only paths from advisory to merge-blocking-work run through either a
  reviewer's own blocking label or a human-reviewed retro PR.
- It does not claim gate② gets stronger. Layering makes it *narrower* on the
  engine-agent path (advisories no longer block). The compensating properties are D3's
  kind allowlist and the independently-blocking per-AC path (§1).

## 11. Implementation issues

Six, all filed, each independently reviewable, each with its own executable verification
plan. This set is **complete** — it covers every item #402 asked this design to decide.
**None touches a human-merge-only path** (§0). Dependency: `#378 → R2 → R3`; `R2 → R5`;
`R1` independent; `R4` independent; `R6` last (round-close doc gate).

| # | Issue | Scope | Files |
|---|---|---|---|
| **R1** | #448 | Finding axes + severity gate: key allowlist + closed enums, `deriveApprovalResult` blocking split, D3 kind allowlist + `severityOverridden` record, artifact carries axes, audit-comment advisory section, prompt emits the axes | `review/finding-axes.ts` (new), `review/agent-output.ts`, `review/audit.ts`, `engine/prompts/engine-reviewer.md` |
| **R2** | #449 | Per-round finding record: identity key derivation (path validated against the reviewed diff), `drive-fixup` payload gains `findings` + `fixDiffPaths` | `review/finding-key.ts` (new), `loop/conductor.ts`, `review/production.ts` |
| **R3** | #450 | Convergence classifier + stop: pure classifier, `driveDecision` input, `review-non-convergent` event + escalation reason and comment, `lanes.prFixCap` default 2→4, docs | `review/convergence.ts` (new), `loop/conductor.ts`, `config/config.ts`, `docs/configuration.md` |
| **R4** | #451 | Dispute costs zero fix legs: escalate `review-disputed` when every unresolved current-head thread is disputed, with the §4 evidence set | `loop/conductor.ts`, `loop/fix-response.ts` |
| **R5** | #453 | Tendency in retro: finding-class table over K rounds in the digest, `roles.retro.tendencyRounds`, retro prompt points at it | `retro/retro-digest.ts`, `config/config.ts`, `engine/prompts/retro.md` |
| **R6** | #454 | Reviewer prompt as a designed artifact: §6a enforced-vs-judged table, §6b triage doctrine; round-close docs | `engine/prompts/engine-reviewer.md`, `docs/role-paradigm.md`, `docs/configuration.md`, `docs/PLAN.md` |

**Not in this table, on purpose:** §4a's missing dispute channel on the engine-agent path.
That is a **pre-existing defect** in the review path as already shipped, surfaced by this
PR rather than specified by #402, so it is not an implementation issue of this design and
filing it is not a precondition for #402's closure. It carries its own ⚠️ action-required
note and its adjudicated fix in §4a, for a human to file against the review path. Recorded
in the design rather than in an issue because the session that found it had no forge
credentials — the alternative was losing it.
