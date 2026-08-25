# Instruction-path escalation

Part of sapwood's security model — `docs/security.md` is the normative model; this page is the mechanism reference for instruction-path changes escalating to human review.

## Instruction-path changes escalate to human review

Standing reviewer instructions are authority, so sapwood treats their merge history as a trust
chain. Before either a hosted-bot review trigger or a paid engine-agent session, the merge gate
checks the PR's rename-aware changed-file list against `escalation.instructionPaths`. A match on
an old or new path applies `labels.humanMergeOnly` before review proceeds and posts one
explanatory comment. If GitHub cannot provide a complete changed-file list within its API ceiling,
the PR also escalates fail-closed. The exact human-merge-only PR label is the latch: later ticks
neither fetch the file list nor repeat either write.

This is deliberately **escalation, not a guard write-denial**: editing standing instructions is
legitimate work, and denying the edit would mask that intent. The worker may produce the change; a
human must adjudicate it. Setting `escalation.instructionPaths: []` explicitly turns the mechanism
off.

**Merge authority stays human; review labor should not.** Rather than parking
the PR needs-human with zero engine review and leaving the human to arrange an out-of-band review
themselves, on a FRESH escalation (never on a later, already-`sapwood:human-merge-only`-
latched tick — the label write is the idempotence latch, so a repeat tick does not re-run this),
the engine also makes ONE advisory `evaluate()` call (one logical advisory evaluation — the
adapter's own `evaluate()` may retry an unparseable/failed attempt internally, engine-agent.ts's
own attempt-retry logic, so this is a claim about one evaluation being REQUESTED, not about how
many sessions run underneath it) and posts its verdict as a PR comment before parking, prefixed
with a prominent banner marking it "instruction-path change: human-merge-only — ADVISORY, not
consumed by the merge driver". That evaluation's instructions come from the reviewer's own
engine-construction-time sources — the doctrine text and prompt template `EngineAgentReviewer`
loads once at construction (engine-agent.ts), plus the dispatch-time AC snapshot
— never a live re-fetch of the PR's own (now human-merge-only) body, so an in-PR instruction-path
edit cannot influence how this review of itself is conducted. The verdict is advisory labor for
the human reviewer only: the route returns `needs-human` unconditionally, whether the evaluation
approves, rejects, or produces nothing at all — no verdict from it ever reaches the merge driver's
consume path. Fail-closed: if the diff fetch, the evaluation, or the comment post fails — OR the
whole operation exceeds a wall-clock deadline (`ADVISORY_REVIEW_DEADLINE_MS`, default 60s,
injectable via `EngineAgentDriveDeps.advisoryReviewDeadlineMs`; a never-settling dependency must
never make the park itself wait) — the PR still parks needs-human exactly as before, with no
different reason string a caller could key on. See `review/drive.ts`'s
`runAdvisoryInstructionPathReview`/`raceWithDeadline` for the implementation and `drive.test.ts`
for the regression coverage (never-consumed, fail-closed, deadline-bounded, latch-skips-rerun,
construction-time-instructions).

### Which carriers are covered, and how immediate the protection is

Two families, protecting two different sessions, with two different timings. Being precise about
this matters: the general claim "instructions absorbed by a review session were previously
human-vetted" is stronger than what the second family's mechanism actually delivers.

- **The ambient-context family** — `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`,
  `.claude/rules/**`, `AGENTS.md`. These are absorbed from the checkout by **worker** and other
  non-review sessions ([Ambient repo context: record, don't
  seal](ambient-repo-context.md#ambient-repo-context-record-dont-seal)), and by a hosted bot reading the PR head.
  They are **not** absorbed by sapwood's own gate② review session: it spawns with
  `--setting-sources ""` (see [Review session mode](review-session-mode.md#review-session-mode-closed-mcpsettings-surface-forced-hard-guard)),
  which also stops the session's own cwd `CLAUDE.md` from loading at all. This was measured live
  the same way the earlier measurement recorded in the peripheral-egress
  section above was taken — a scratch directory whose `CLAUDE.md` declared a unique marker fact, a
  one-shot `claude -p` asking for that fact: the default run answered with the marker, the
  identical run with `--setting-sources ""` answered `UNKNOWN`. Same machine, same operator
  settings, one flag changed — so the difference is the flag, not a local settings deny wearing
  platform clothes.
- **The reviewer's own carriers** — the doctrine file (`doctrine.file`, default
  `docs/REVIEW-DOCTRINE.md`, substituted verbatim into the reviewer prompt) and the reviewer prompt
  itself (shipped as `engine/prompts/**`, repointable via `reviewer.agent.promptFile`). These are
  what a gate② review session actually reads as standing instruction. **Both paths are derived from
  config**, not literals, so an operator who repoints either one stays covered: `loadConfig`
  captures the pre-resolution `doctrine.fileRaw` and `reviewer.agent.promptFileRaw`
  before resolving each to an absolute local path, and the escalation matches those repo-relative
  raw forms against the PR's changed files. The `engine/prompts/**` glob remains a literal default
  covering the shipped prompt, inert in any target repo that is not the engine's own source tree.
  A derived path that points outside the repo (absolute, or `..`-escaping) is skipped rather than
  smuggled into the pattern list — it could never match a repo-relative changed-file path anyway.

The forge-read provenance mechanism's own carriers, `engine/src/forge/forge.ts` and
`engine/src/proxy/**`, are also in `escalation.instructionPaths`: an edit to either does not
reach autonomous merge through this instruction-path channel.

**The second family's protection is delayed by one round, not immediate — say so rather than
overclaim.** Both the doctrine and the prompt are loaded by the ENGINE from its own
config-resolved path at construction, never from the materialized tree under review. A PR editing
them therefore cannot weaken *its own* review; what it would weaken is **every subsequent review
after it merges**. The escalation closes that: the edit cannot reach autonomous merge, so no
un-vetted reviewer instruction ever becomes the authority for a later round. What it does not and
cannot do is make an in-flight review notice the change.

### The mechanism's own carriers join the escalation surface too

Live evidence for why this matters: a PR once merged with zero human eyes,
touching the instruction-path matcher itself (`engine/src/review/instruction-path-escalation.ts`), the
`escalation.instructionPaths` defaults (`engine/src/config/config.ts`), and this file. None of the
three were on any escalation or human-merge-only list, so the merge was compliant with the letter —
a PR gutting the matcher or shrinking the defaults would have reached autonomous merge the same
way. (That instance was benign; the finding is the reachable class.) The ruling put these three paths in the **escalation surface**, alongside the two carrier families
above — not the guard deny-list: the worker may still produce a change here, a human adjudicates
the merge.

**Say the self-reference honestly (SAID — Self-Applies-Its-own-Defenses).** The escalation list now
protects the file that implements it and the file that carries its own defaults. That is
deliberate, not circular: `escalateInstructionPathChanges` evaluates every PR against the
**deployed** config (the version the engine loaded at construction), never against the PR's own
diff. A PR that edits these three paths is checked against the instruction-path list as it exists
on `main` *before* that PR merges — so once this protection itself is deployed, an in-flight edit to
the matcher or its defaults is caught by the very entries this PR adds.

**The exposure window is exactly one bootstrap PR, not an ongoing gap.** Before these three paths
were deployed in `escalation.instructionPaths`, nothing stopped an autonomous merge to any of them
(the evidence above). The PR that first adds them is necessarily evaluated
against the OLD deployed defaults — which do not yet cover its own diff — so it is the one PR that
cannot be protected by its own change. Every PR after it merges is covered. This is why that
bootstrap PR is itself human-merge-expected: the engine has no config-side signal to escalate its own bootstrap PR,
so the merge decision for this one PR is a human responsibility, not an engine one.
