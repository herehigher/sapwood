# Design #279 — engine-side LLM review agent (`engine-agent`)

Status: **adjudicated design** (issue #279, M10). Negotiated over five adversarial
review rounds with Codex (gpt-5.6-sol high), final verdict APPROVE (2026-07-21);
owner rulings D1–D5 recorded below. Inline `[R2-n]`/`[R3]`/`[R4]` markers anchor
which review finding a provision closes. One deliberate PARTIAL REJECTION of a
review demand is recorded in §5a (producer label/board mutation boundary — descoped
to a standalone hardening issue; rationale inline; owner may override at PR review).
Evidence base for the problem statement: docs/research/review-bot-landscape-2026-07.md.

## Owner rulings

- **D1** static-only v1 (no producer-code execution; no Bash in session).
- **D2** sanitized checkout — SUPERSEDED BY D6+D7 (2026-07-21 post-adjudication
  cost/benefit re-review): the load-bearing security component was the engine-private
  clone, not the custom projection; instruction-file exclusion contradicted
  security.md's standing adjudication that role sessions legitimately absorb repo
  `CLAUDE.md` (§Ambient repo context, with context-manifest audit). See §3.
- **D3** rerun-when-needed, serial after CI; CI-covered AC is mapping-confirmed, not
  re-executed by the agent.
- **D4** mandatory checkbox AC, engine-assigned IDs.
- **D5 (2026-07-21)** v1 runner = claude CLI family ONLY. "Different model" =
  different Claude model (e.g. worker sonnet × reviewer opus), enforced at parse and
  at runtime via actual modelUsage comparison. A codex-exec runner is a follow-up
  issue (the adapter seam requires no change to add it; its token-approximate cost
  accounting is designed then). Rationale recorded: claude runner keeps cost tracking
  and the hard budget cap (`--max-budget-usd`, JSONL total_cost_usd) lossless; codex
  exec has no budget flag and, under plan auth, no dollar visibility at all.
- **D6 (2026-07-21)** materializer simplified: the custom plumbing extractor
  (ls-tree/cat-file) is dropped. The load-bearing defense against the git
  config/hooks/filters execution class is the ENGINE-PRIVATE CLONE plus environment
  config isolation — with those in place, a stock env-isolated checkout has no code
  execution surface, and the remaining `.gitattributes` eol/ident content
  normalization is an accepted, harmless residual (the review object is the
  engine-supplied diff anyway). This reverses R3/R4's plumbing contract by owner
  ruling: the plumbing added large custom machinery for a near-zero security delta.
- **D7 (2026-07-21)** instruction files are NOT excluded from the reviewer's tree.
  Blanket exclusion harms review (legitimate repo conventions are exactly what a
  role session should absorb — security.md's standing adjudication — and instruction
  changes themselves need in-context review). The authority-channel injection risk is
  contained by a different, cheaper mechanism: **instruction-path change escalation**
  (§3a) — a PR touching the instruction-resolution-graph paths routes to needs-human,
  so an in-PR injected instruction can at worst blind THIS agent review and can never
  reach autonomous merge. Standing (already-merged) instructions are human-vetted by
  the same rule, so absorbing them as authority is absorbing human-vetted content.
  Bonus: the same escalation covers the CURRENT hosted-Codex path's `AGENTS.md`
  exposure (that bot reads PR-head AGENTS.md as review guidance) — one mechanism,
  both reviewer kinds.

## 1. Seam [R2-1 closed]

```ts
type ApprovalResult =
  | { kind: "approved"; headOid: string; evidence: ApprovalEvidence }   // requires findings.length === 0
  | { kind: "rejected"; headOid: string; findings: Finding[] }          // validated findings -> FIXABLE path
  | { kind: "pending"; headOid: string }
  | { kind: "unavailable"; headOid: string | null; reason: string };

interface ReviewerAdapter {
  readonly kind: ReviewerKind;
  trigger(ctx: ReviewContext): Promise<void>;
  evaluate(ctx: ReviewContext): Promise<ApprovalResult>;
}
```

- `rejected` is ENGINE-derived (any finding, or any perAC cannot-confirm ⇒ rejected;
  the session never chooses outcomes). merge-driver maps `rejected` onto the existing
  HANDLE_THREADS→FIXABLE lane (deriveGate unchanged; fix_rounds cap unchanged).
- Blocking derivation stays engine-side over live PRReviewData; adapters return
  approval-side results only. Exhaustive factory; engine-agent primary-only (fallback
  entries GitHub/human kinds); engine-agent in `fallback` rejected at parse.
- **Findings transport to the fix leg** [R2-1]: the fix-leg forge proxy gains ONE
  bounded read tool for top-level PR comments filtered to engine audit markers
  (`getPRAuditComments(pr, lastN)`), same read-only containment as the existing
  #244 tools. fix.md's proxy-evidence doctrine is preserved (no prompt-injected
  findings); the audit comment remains non-authoritative for verdicts.

## 2. Drive flow [R2-5, R2-6 closed]

```
attempt-gate: per-head ATTEMPT PIN, two kinds [R3]:
              · DECISIVE pin — a decisive verdict (approved/rejected) was produced
                for head H AND its audit comment is delivery-receipted: PERMANENT
                for H, never rerun. In produce-pr-and-stop (where driveOne still
                runs every tick and lanes stay driving) the audit comment is the
                durable record for the human merger; the engine never re-reviews H.
                In auto-merge mode a decisive verdict is consumed in-tick; a
                transient merge failure clears nothing — the NEXT head or an
                explicit human re-request is the only path to a new session for H
                (re-running on an unchanged H after audit delivery is redundant by
                construction).
              · UNAVAILABLE pin — retry with backoff (reviewer.agent.retryAfterSec,
                default 900s) between paid attempts on the same head. Fallback
                activation [R3]: the #54 chain is consulted on the EXISTING
                failoverAfterSec clock measured from the pin's first attempt-start
                for H; backoff only spaces paid primary attempts inside that window,
                and each backoff expiry IS the primary-recovery probe (next paid
                attempt). Pin = {head, at, runId, kind} on the lane's worker row
                (same storage pattern as the review-trigger pin).
preflight:    OPEN, non-draft, no human/hold labels, MERGEABLE, no unresolved
              threads, no standing CHANGES_REQUESTED, CI green (trusted checks, §4)
identity:     resolve headOid H + baseOid B (PRStatus gains baseOid — GraphQL
              baseRefOid) + diff bytes hash D via getPRDiff; then REFETCH status and
              require head==H ∧ base==B; one mismatch ⇒ restart resolution once,
              second ⇒ queue this tick [R2-6]
WAL:          persist {runId, H, B, D, attempt-start} to state BEFORE spawning —
              crash recovery reconciles the audit marker against this record [R2-6]
materialize:  archive projection at H (§3), verified
session:      static review, structured output, retry ≤1 within one logical budget
validate:     per-AC by snapshot IDs (§5); AC-section drift check (§5)
audit:        discover-before-post (marker {kind,H,D,runId}); post; record delivery;
              post failure ⇒ queue, no downstream action
refetch:      PRStatus+PRReviewData; head==H ∧ base==B ∧ no blocking ∧ CI still green
consume:      approved → deriveGate → mergePR(pr, H) · rejected → FIXABLE ·
              unavailable → pin backoff, #54 fallback / #170 escalation timing runs
              from the pin's attempt-start
```

Residual (accepted, documented): base movement in the refetch→merge gap — same
exposure as today's hosted-bot path.

## 3. Materialization: private-clone checkout [R2-4 closed; D6 supersedes the R3/R4 plumbing contract]

The reviewer never touches the shared repository. The engine materializes a plain
source tree:

- **Engine-private bare clone** (unchanged, load-bearing — D6), at a path
  structurally outside every worker worktree/mount, fetched by the engine itself —
  never the shared repository whose `.git/config` is writable from worker worktrees
  via `Bash(git *)`. The git config/hooks/filters execution class requires a
  producer-writable config; the private clone has none (local config asserted empty
  at clone time).
- **Stock env-isolated checkout** (D6, replacing the plumbing extractor):
  `git -C <private-clone> --work-tree=<tmpdir> checkout <H> -- .` under
  `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`, `--no-replace-objects`,
  and `-c core.symlinks=false` (symlinks materialize as plain text files — nothing
  for read-containment to follow out of the tree). No `.git` directory lands in the
  tmpdir (and the session has no Bash, D1). Checkout OID verified
  post-materialization. Accepted residual: in-tree `.gitattributes` eol/ident
  normalization — content-preserving, zero execution surface; the review object is
  the engine-supplied diff in any case.
- **Instruction files are INCLUDED** (D7, reversing the exclusion): repo `CLAUDE.md`
  / `.claude/**` are legitimate role-session context per security.md's standing
  "Ambient repo context" adjudication, absorbed under the SAME context-manifest
  audit every role session already gets (the manifest records exactly which
  instruction files were absorbed — existing machinery). Guard hooks stay enabled;
  read-containment root = the tmpdir. The authority-channel risk is contained by
  §3a, not by exclusion.
- The tree manifest (file list + content hash) is recorded in the WAL record for
  audit parity.

## 3a. Instruction-path change escalation (D7's containment mechanism)

A PR whose changed files touch the instruction-resolution graph — `CLAUDE.md`,
`CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules/**`, plus `AGENTS.md` (the
hosted bot's guidance file) — is routed to **needs-human** by the engine (label
applied once; merge gated, the WORK is not blocked — updating instruction files is
sometimes the legitimate task, so this is escalation, never a guard write-denial
that would mask real intent). Trust chain established:

- Standing instructions were themselves merge-gated by a human under this rule →
  absorbing them as session authority is absorbing human-vetted content.
- An in-PR instruction edit can at worst blind the CURRENT agent review; the PR
  cannot reach autonomous merge, so the injection buys nothing.
- The same rule covers the hosted-Codex reviewer's PR-head `AGENTS.md` exposure —
  previously an undocumented accepted residual of the CURRENT default gate②.

Path list is config (`escalation.instructionPaths`) with the defaults above.
Content-channel injection (diff/comment text persuading the reviewer) remains a
documented accepted residual under the trusted-repos-first posture — structurally
unclosable for any LLM reviewer, mitigated by the blocking-signal asymmetry (a
false approval from one source never clears CI, human labels, or threads).

## 4. CI execution evidence [R2-2 closed]

`code-verifiable` + `confirmed` requires the FULL chain:

1. Agent (static): the AC maps to a named, substantive test — present in the tree,
   not skipped/todo/conditionally-disabled, on the test-discovery path (agent reads
   test config/workflow files in the projection), assertions non-vacuous.
2. Engine (deterministic): every entry in `ci.requiredChecks` (new config, list of
   `{name, app}` pairs, `app` defaulting to `github-actions`) has a CheckRun-type
   entry on H with conclusion SUCCESS **whose check suite belongs to the configured
   GitHub App** [R3: the getPRChecks GraphQL query gains `checkSuite { app { slug } }`;
   a same-named check from an untrusted app is NOT evidence]. SKIPPED/NEUTRAL/
   legacy-status-context DO NOT satisfy it [closes the ciGreen SKIPPED/NEUTRAL hole
   for this path; general gate① ciGreen semantics were unchanged that round and noted
   as a follow-up hardening candidate — **CLOSED by #401 (F26)**: gate① `ciGreen`
   (`forge/forge.ts`'s `parsePRStatus`) now requires `conclusion === "SUCCESS"` from
   every CheckRun, so SKIPPED/NEUTRAL no longer read as green on ANY path. #401
   carried across the CONCLUSION half of this item's stance only: a legacy commit
   status context with state `SUCCESS` still passes gate①, because the reason THIS
   item rejects one is app-ownership binding (a status context has no check suite, so
   it can never match a configured `{name, app}` pair) — a `ci.requiredChecks`-specific
   requirement, not a gate①-wide one. The Status API has no SKIPPED/NEUTRAL concept
   for the closed hole to reappear through, and rejecting it gate①-wide would
   permanently wedge every Status-API CI repo — the F26 class #401 exists to remove,
   and something #401's own AC forbids the fix from doing silently. **Readjudicated,
   not deviated:** PR #422's review read the retained legacy path as a third
   adjudication direction outside #401's two-way AC, twice. The repo owner ruled on
   2026-07-29 (PR #422, supervising session): dispute ACCEPTED, scope call upheld —
   #401's "SUCCESS-only" requirement is scoped to CHECKRUN CONCLUSIONS, the legacy
   status-context path is unchanged, and the strict app-bound boundary remains the
   opt-in `ci.requiredChecks` chain. Recorded here because that ruling is durable
   knowledge; the PR thread is only where it happened. #401
   narrowed that existing predicate rather than promoting `requiredChecksSatisfied`
   to the merge gate, because this function is fail-closed on an empty
   `ci.requiredChecks` (the default) and promoting it would have wedged every repo
   that has not configured one. See docs/configuration.md `ci` → "gate① CI evidence"
   for the shipped behavior and the path-filtered-workflow adjustment path].
   Deterministic check↔workflow-command binding is
   adjudicated infeasible statically [R3]: the agent reviews workflow-file changes in
   the diff (prompt-directed), and the residual is documented — not engine-proven.
3. `ci.requiredChecks` empty ⇒ `code-verifiable` AC can at best be `claim-based`
   (fail-closed: no trusted execution evidence exists) — parse-time warning when
   mode=engine-agent and the list is empty.

Residual (accepted, documented): a producer with status-write capability cannot forge
a CheckRun of the Actions app; deeper CI-config tampering (workflow edits) is visible
to the agent in the diff and is prompt-directed review focus, not engine-proven.

## 5. AC authority: dispatch snapshot [R2-3, R3 closed]

- **BEFORE worker launch** [R3: ordering explicit — snapshot precedes dispatch's
  spawn, same transaction as the claim] the engine extracts the checkbox AC set and
  persists an **AC manifest** {FULL issue body hash, [(id, text)]} in state. IDs are
  ordinal+hash WITHIN the snapshot — later reorders/edits cannot shift them.
- State is writable only by the engine (workers have no data/ mount — existing
  structural guarantee); the manifest is an integrity PIN authored by the engine, not
  an approval artifact, so the state-not-verdict-bearing doctrine is intact.
- At review time the engine refetches the issue body: **ANY body drift (full-body
  hash mismatch — covering AC, verification plan, and every other reviewer input in
  the body)** [R3: widened from AC-section-only] ⇒ `unavailable` + `needsHuman` with
  a drift-explaining comment (renewed gate⓪ adjudication is the human path back). The
  session reviews against the SNAPSHOTTED body text, never the live fetch. No guard
  change needed.

## 5a. Producer label/board mutation boundary — PARTIAL REJECTION of the R3 demand

R3 demanded a producer issue/status-mutation boundary (labels, board status) land
before E4. Adjudication: the full-body snapshot (§5) closes the reviewer-INPUT half
of that demand entirely. The remaining half — a producer's `gh` capability to mutate
labels/board status — is a PRE-EXISTING, system-wide exposure (every gate already
reads live labels today; nothing about engine-agent widens it) and is consistent with
the locked trusted-repos-first posture. Blocking M10 on it would couple this design
to a whole-system trust-model change. DISPOSITION: standalone hardening issue
(backlog, references this section); explicitly out of #279 scope. Owner may override.

## 6. Session contract (updated)

As v2 §3 plus: spawn via claude CLI only (D5); the session runs in the §3
materialized tree and absorbs its instruction files as ordinary role-session context
(D7, context-manifest audited); config example model `opus` against a `sonnet`
worker; `--max-budget-usd` = remaining logical budget on attempt 2; attempt start
recorded in the pin. Output schema unchanged (perAC + findings; no overall, no
headOid). All setup failures (materialize failure included) map to `unavailable`.

## 7. Config (updated)

```yaml
reviewer:
  mode: engine-agent
  agent:
    model: opus            # REQUIRED; parse-reject if == worker.model
    effort: high
    promptFile: prompts/engine-reviewer.md
    costCapUsd: 3          # whole-logical-review cap
    retryAfterSec: 900     # backoff between paid attempts on the same head
ci:
  requiredChecks:          # execution evidence (§4): CheckRun name + owning App
    - name: test
      app: github-actions  # default; a same-named check from another app is not evidence
```

All v2 strictness retained (dead-config rejection, no fallbackModel, exhaustive
factory, primary same-model-trusted empty-list rejection, runtime modelUsage
comparison ⇒ unavailable when indistinguishable).

## 8. Audit trail (updated)

v2 §6 plus: WAL-first ordering (runId persisted pre-session), discover-before-post
against the marker, delivery receipt recorded, restart reconciliation from the WAL
record. Single-identity provenance limitation unchanged (documented, non-authoritative
comment).

## 9. Non-goals (v1)

v2 list plus: codex-exec runner (D5 follow-up) · general gate① ciGreen
SKIPPED/NEUTRAL semantics change (was a v1 non-goal — no longer open: **shipped by
#401 (F26)**, `ciGreen` requires `SUCCESS`; see §4 item 2) · producer `gh issue edit`
guard blocking (snapshot+drift makes it unnecessary for this design).

## 10. Execution plan (8 PRs) [R2 plan findings closed]

1. **E1 — seam refactor** (+ `rejected` outcome in the type from day one): adapter
   split, blocking extraction, exhaustive factory; zero behavior change, regression
   pin.
2. **E2 — AC machinery**: checkbox extractor + IDs, pre-launch FULL-BODY snapshot +
   any-drift fail-closed + snapshotted-body review input (engine-side enforcement)
   [R3], issue template + gate⓪ prompt tightening, docs.
3. **E3a — private-clone materializer** (slimmed by D6): engine-private bare clone +
   stock env-isolated checkout (`--work-tree`, config isolation, `--no-replace-objects`,
   `core.symlinks=false`), OID verification, tree manifest. Instruction files
   included (D7). Pure infra, independently testable.
4. **E3b — review session mode** (slimmed by D7): role-session spawn against a
   materialized tree (cwd facility), guard containment root wiring, no-Bash tool
   profile, context-manifest recording (existing role-session machinery).
4a. **E6 — instruction-path change escalation** (§3a, D7): changed-files match
   against `escalation.instructionPaths` → needs-human on the PR; covers hosted-bot
   and engine-agent gates alike. Independent of E1–E4 (own PR, generic hardening);
   must ship within M10 because §3's D7 trust chain relies on it.
5. **E4a — adapter + config + session validation**: engine-agent adapter, config
   schema + strictness batch, output validation, runtime model-separation check.
6. **E4b — drive ordering**: attempt pin + backoff, preflight, identity resolution
   (PRStatus baseOid), WAL, refetch composition into driveOne.
7. **E4c — audit + fix transport + crash recovery**: audit comment + marker dedup +
   delivery receipt, `getPRAuditComments` proxy tool, restart reconciliation.
8. **E5 — docs + round close** (same round as behavior change): configuration.md,
   role-paradigm.md, security.md (private-clone materialization, instruction-path
   escalation + content-channel accepted residual, single-identity
   limitation, CI-evidence chain), PLAN.md decision row.

Dependencies: E1→{E4a,E4b}; E2→E4a; E3a→E3b→E4a; E4a→E4b→E4c; E6 independent (must
land within M10); E5 last. Each PR is
independently reviewable; none touches guard.ts (no human-merge-only path in scope
except security.md docs, which is doc-gate).
