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
- **D2** sanitized checkout — implemented as an ARCHIVE PROJECTION, see §3 [R2-4].
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

## 3. Materialization: plumbing projection [R2-4, R3 closed]

The reviewer NEVER gets a git worktree. The engine materializes a plain source tree:

- [R3] **Engine-private bare clone**, at a path structurally outside every worker
  worktree/mount, fetched by the engine itself — never the shared repository whose
  `.git/config` is writable from worker worktrees via `Bash(git *)`.
- [R3] **Plumbing extraction, not `git archive`**: `git archive` is rejected because
  it consults in-tree `.gitattributes` (`export-ignore` can HIDE files from the
  reviewer, `export-subst` can rewrite content) and local config. [R4] The plumbing
  invocation contract is EXPLICIT — plumbing is only safe under these exact flags
  (bare `ls-tree` still consults `core.quotePath`; object reads honor replace refs
  unless disabled):
  · listing: `git ls-tree -r -z <H>` (NUL-delimited — no `core.quotePath` encoding);
  · content: `git cat-file` raw blob reads, NEVER `--filters`/`--textconv`;
  · both under `--no-replace-objects` (or `GIT_NO_REPLACE_OBJECTS=1`);
  · env config isolation for every materializer git invocation:
    `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null` (the engine-private
    clone's own local config is engine-written and empty-by-construction, asserted
    at clone time).
  Under this contract attributes, filters, hooks, replace refs, and ambient config
  are all unreachable, and the projection is byte-identical to the reviewed commit's
  tree. E3a's AC pins this exact invocation set. No `.git` directory is materialized
  (session also has no Bash, D1).
- Extraction validates paths (no traversal, symlink entries dropped).
- **Instruction sanitization**: `CLAUDE.md`, `**/CLAUDE.md`, `.claude/**` are
  EXCLUDED from the projection — not discovered as instructions AND not readable as
  files; their changes remain reviewable as diff text (the diff is engine-supplied
  data). Guard hooks therefore STAY ENABLED (no --bare/--safe-mode needed — nothing
  to suppress), and read-containment root = the temp tree (SAPWOOD_WORKTREE_ROOT
  mechanism unchanged) [closes the hooks-vs-sanitization dilemma].
- The projection's tree manifest (file list + content hash) is recorded in the WAL
  record for audit parity.

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
   for this path; general gate① ciGreen semantics unchanged this round, noted as a
   follow-up hardening candidate]. Deterministic check↔workflow-command binding is
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

As v2 §3 plus: spawn via claude CLI only (D5); config example model `opus` against a
`sonnet` worker; `--max-budget-usd` = remaining logical budget on attempt 2; attempt
start recorded in the pin. Output schema unchanged (perAC + findings; no overall, no
headOid). All setup failures (archive/materialize failure included) map to
`unavailable`.

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
SKIPPED/NEUTRAL semantics change (follow-up hardening) · producer `gh issue edit`
guard blocking (snapshot+drift makes it unnecessary for this design).

## 10. Execution plan (8 PRs) [R2 plan findings closed]

1. **E1 — seam refactor** (+ `rejected` outcome in the type from day one): adapter
   split, blocking extraction, exhaustive factory; zero behavior change, regression
   pin.
2. **E2 — AC machinery**: checkbox extractor + IDs, pre-launch FULL-BODY snapshot +
   any-drift fail-closed + snapshotted-body review input (engine-side enforcement)
   [R3], issue template + gate⓪ prompt tightening, docs.
3. **E3a — plumbing materializer**: engine-private bare clone + ls-tree/cat-file
   extraction (no `git archive`) [R3], path/symlink validation, instruction
   exclusion, tree manifest. Pure infra, independently testable.
4. **E3b — sanitized session mode**: role-session spawn against a materialized tree
   (cwd facility), guard containment root wiring, no-Bash tool profile.
5. **E4a — adapter + config + session validation**: engine-agent adapter, config
   schema + strictness batch, output validation, runtime model-separation check.
6. **E4b — drive ordering**: attempt pin + backoff, preflight, identity resolution
   (PRStatus baseOid), WAL, refetch composition into driveOne.
7. **E4c — audit + fix transport + crash recovery**: audit comment + marker dedup +
   delivery receipt, `getPRAuditComments` proxy tool, restart reconciliation.
8. **E5 — docs + round close** (same round as behavior change): configuration.md,
   role-paradigm.md, security.md (projection sanitization, single-identity
   limitation, CI-evidence chain), PLAN.md decision row.

Dependencies: E1→{E4a,E4b}; E2→E4a; E3a→E3b→E4a; E4a→E4b→E4c; E5 last. Each PR is
independently reviewable; none touches guard.ts (no human-merge-only path in scope
except security.md docs, which is doc-gate).
