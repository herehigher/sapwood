# Instruction-path escalation

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for instruction-path changes escalating to human review.

## Instruction-path changes escalate to human review

Standing reviewer instructions are authority, so sapwood treats their merge history as a trust
chain. Before either a hosted-bot review trigger or a paid engine-agent session, the merge gate
checks the PR's rename-aware changed-file list against `escalation.instructionPaths`; a match on
an old or new path applies `labels.humanMergeOnly` and posts one explanatory comment. An
incomplete changed-file list (the GitHub API ceiling) escalates fail-closed too, since coverage
can't be proven.

| Invariant | Enforcement | Test |
| --- | --- | --- |
| A pattern matches case-folded (NFC-normalized) paths; `*` matches within one path segment, `**` matches zero or more whole segments; a rename matches on either the old or the new path. | `instruction-path-escalation.ts::instructionPathMatches`, `matchedInstructionPaths` | `instruction-path-escalation.test.ts`: "checkout-safe case-insensitive and * stays within one segment"; "a rename matches either old or new instruction path" |
| The reviewer's own carriers — doctrine file, reviewer prompt — match by a config-derived, repo-relative RAW (pre-resolution) path; a path escaping the repo is skipped, never smuggled in. | `effectiveInstructionPaths`, `repoRelativeCarrier` | `instruction-path-escalation.test.ts`: "#527: … doctrine.file is followed by its raw repo-relative form"; "#549: … promptFile is followed by its raw repo-relative form" |
| Escalation, not write-denial: a human merges it, worker may produce it. `[]` is a deliberate off-switch. The exact human-merge-only label (not `needs-human`) is the idempotence latch. | `escalateInstructionPathChanges` | `instruction-path-escalation.test.ts`: "instructionPaths [] is a true off-switch with zero forge calls"; "#397: a PR carrying only needs-human does NOT satisfy the instruction-path latch — the two buckets stay apart" |
| The matcher, `config.ts`, `docs/security.md`, `docs/security/**` (this page), and `skills-plugin.ts` are on the escalation surface (self-reference, below) — not the guard deny-list. | `config.ts`'s `escalation.instructionPaths` default list | `instruction-path-escalation.test.ts`: "#539/#639/#640 … each newly-covered mechanism-carrier default path escalates a PR that touches it"; "#1094 PR-S: … via the docs/security/** default glob" |
| The classic reviewer trigger and the engine-agent paid-session preflight call the SAME helper, so matching/write semantics can't drift between them. | `merge-driver.ts`, `review/drive.ts` (both call `escalateInstructionPathChanges`) | n/a (structural — one exported helper, two importers) |
| On a fresh (non-latched) escalation, engine-agent also posts one best-effort advisory `evaluate()` verdict — fail-closed, deadline-bounded, NEVER consumed: returns `needs-human` regardless. | `drive.ts::runAdvisoryInstructionPathReview`/`raceWithDeadline` | `drive.test.ts`: "#292/#823 … never consumed … a latched (second) tick skips the advisory evaluate() call entirely" |

**Boundaries**

- The human-merge-only label is written before the comment, as the durable idempotence latch; if
  the comment post then fails, it is never retried — the label alone carries the record. A latched
  PR (label already applied) never re-fetches the changed-file list or re-writes either
  (`instruction-path-escalation.test.ts`: "a post-label comment failure is latched and never
  retried").
- A changed-file-list fetch failure queues for a later tick rather than escalating or clearing —
  it is not yet known whether an instruction path was touched
  (`instruction-path-escalation.test.ts`: "changed-files failure queues fail-closed and performs no
  writes").
- An incomplete changed-file list (GitHub's 3,000-file API ceiling) escalates WITHOUT attempting to
  match — coverage can't be proven, so it fails closed rather than assuming clear
  (`instruction-path-escalation.test.ts`: "an incomplete 3,000-file list escalates without pattern
  matching").
- Every advisory-review failure mode — diff fetch, `evaluate()`, comment post, or exceeding the
  60s deadline (`ADVISORY_REVIEW_DEADLINE_MS`, injectable) — parks `needs-human` with the same
  reason string; no caller can distinguish an advisory hiccup from an ordinary escalation
  (`drive.test.ts`: "#823 … the advisory evaluate() call throwing still parks needs-human with the
  SAME reason (fail-closed, AC2)", and its diff-fetch/comment-post siblings).
- The advisory verdict's instructions are the reviewer's own construction-time doctrine text and
  prompt template plus the dispatch-time AC snapshot — never a live re-fetch of the PR's own
  (human-merge-only) body — so an in-PR instruction-path edit cannot influence the review of itself
  (`drive.test.ts`: "no PR-body/instructions field for an in-PR edit to influence … AC3").

### Which carriers are covered, and how immediate the protection is

Two families, protecting two different sessions, with two different timings — the general claim
"instructions absorbed by a review session were previously human-vetted" is stronger than what the
second family actually delivers.

| Carrier | Covered by | Immediacy |
| --- | --- | --- |
| Ambient files — `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, `.claude/rules/**`, `AGENTS.md` | Read by **worker**/other non-review sessions, and by a hosted bot reading the PR head. | Immediate — NOT absorbed by gate② at all (see the two seals below). |
| Reviewer's own carriers — the doctrine file (`doctrine.file`) and the reviewer prompt (`engine/prompts/**` / `reviewer.agent.promptFile`) | Loaded once at engine construction from the config-resolved path, never from the materialized PR tree. | Delayed one round: an edit can't weaken its OWN review, only every review after it merges — which the escalation stops from reaching autonomous merge. |
| Forge-read provenance — `engine/src/forge/forge.ts`, `engine/src/proxy/**` | Change which public PR comments a worker session can receive. | Immediate — ordinary `escalation.instructionPaths` entries, same as the ambient-file list. |

Gate②'s own two seals: a Claude session spawns with `--setting-sources ""` (also stopping its own
cwd `CLAUDE.md` from loading — [review session
mode](review-session-mode.md#review-session-mode-closed-mcpsettings-surface-forced-hard-guard));
codex-exec runs with `-c project_doc_max_bytes=0`, disabling its own project-instruction discovery
so the reviewed tree's `AGENTS.md`/`AGENTS.override.md` cannot load either ([the
exception](egress.md#peripheral-network-egress-websearchwebfetch-detected-not-pinned)).

A controlled comparison (one flag changed, everything else held constant) confirms the flag
itself — not a local settings deny wearing platform clothes — is what suppresses ambient-file
absorption (comparison archived:
[`security-instruction-path-escalation-derivations-2026-08.md`](../design/security-instruction-path-escalation-derivations-2026-08.md)).

### The mechanism's own carriers join the escalation surface too

**Not circular.** `escalateInstructionPathChanges` checks every PR against the DEPLOYED config —
the version the engine loaded at construction — never against the PR's own diff. Once the matcher,
`config.ts`'s defaults, `docs/security.md`, and `docs/security/**` are themselves in
`escalation.instructionPaths`, an in-flight edit to any of them is caught by the very entries this
mechanism adds (live evidence for the reachable class this closes is archived:
[`security-instruction-path-escalation-derivations-2026-08.md`](../design/security-instruction-path-escalation-derivations-2026-08.md)).

**Bootstrap gap, closed.** The PR that first put these paths in `escalation.instructionPaths` was
checked against the OLD deployed list, which did not yet cover its own diff — the one PR that
could not be protected by its own change, so its merge was a human responsibility. Every PR after
it is covered: the default list lives in `config.ts`, which is itself an entry, so every later
addition escalates on that entry (the root `sapwood.config.yaml` alternative is guard-blocked
outright — `guard.ts::protectedPathLabel` — so `config.ts` is the only route in).
