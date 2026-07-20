# GitHub auto-review bots: invocation & execution mechanisms (landscape, 2026-07)

Research snapshot informing sapwood's gate② reviewer-adapter design. Produced from two
independent investigations (Codex gpt-5.6-sol medium; Claude Sonnet with official-doc web
research) cross-validated against each other and against sapwood's implementation
(`engine/src/roles/reviewer.ts`, `merge-driver.ts`, PR #277).

**Method note.** Claims below marked *observed* are community/live-PR observations, not
vendor contracts. Where the two investigations disagreed, the disagreement is stated
rather than resolved.

---

## 1. Per-bot mechanisms

### 1.1 OpenAI Codex code review

- **Trigger**: top-level PR comment `@codex review` (optional focus suffix, e.g.
  `@codex review for security regressions`). Per-repo auto-review toggle in Codex
  settings (fires on PR opened / draft→ready). Repo must be connected to Codex cloud
  with Code review enabled.
- **Execution**: OpenAI-managed cloud sandbox (may run code/tests to validate findings).
  Not the repo's Actions runner. Metered against the user/org Codex plan.
- **Identity & auth**: GitHub App connector installed by an org admin; short-lived
  installation tokens. Bot login `chatgpt-codex-connector[bot]` — *observed*, not
  documented; no published permission manifest or stable-login contract.
- **Output**: standard GitHub PR review scoped to P0/P1 findings. Normal review state is
  **COMMENTED**, not APPROVED. A clean result sometimes arrives as a plain conversation
  comment ("Didn't find any major issues") with no review object at all. 👀 reaction on
  the trigger comment signals in-progress.
- **Config**: hierarchical `AGENTS.md` (nearest file wins), `## Review guidelines`
  section recommended.
- **Programmatic**: no public API for the cloud review job — the GitHub comment/review
  data plane is the only automation seam. Structured alternatives exist *outside* the
  managed flow: `codex exec review --base <ref>` (`--json`, `--output-schema`) and
  `openai/codex-action` (exposes `final-message`), both self-run.

### 1.2 Claude Code review — two distinct mechanisms

**(a) Managed Code Review app** (Team/Enterprise research preview):

- **Trigger**: per-repo behavior set by an org owner — once after PR creation, after
  every push, or manual via a top-level PR comment *starting with* `@claude review`
  (commenter must be owner/member/collaborator; PR open).
- **Execution**: Anthropic-hosted parallel agent fleet. Billed from a separate usage-
  credit pool (~$15–25/review). Unavailable for zero-data-retention orgs.
- **Identity & auth**: Claude GitHub App, org-installed; Contents/Issues/PRs read-write.
- **Output**: `Claude Code Review` check run + inline comments + severity labels; a
  short confirmation comment when clean. **Explicitly never approves or blocks.** One
  investigation reports a machine-parseable severity JSON blob
  (`bughunter-severity: {...}`) in the check-run details; the other could not confirm —
  treat as unverified until probed live.
- **Config**: hierarchical `CLAUDE.md` (violations ≈ nit findings) + root `REVIEW.md`
  (review-only instructions, highest priority).

**(b) `anthropics/claude-code-action`** (general-purpose Action):

- **Trigger**: `@claude` mention (phrase configurable) or any workflow event with an
  explicit `prompt`. Runs **on the user's own Actions runner**; user pays Actions
  minutes + model tokens (Anthropic API / Bedrock / Vertex).
- **Output**: one tracking comment (optionally inline comments). **Documented as unable
  to submit a formal PR review, approve, or request changes.**
- **Programmatic**: the strongest structured route of any vendor — JSON-schema
  `structured_output`, `claude -p --output-format json`, Agent SDK.

### 1.3 GitHub Copilot code review

- **Trigger**: **reviewer assignment, not a comment** — Reviewers UI, `gh pr edit
  --add-reviewer`, or the standard REST review-request endpoint with reviewer login
  `copilot-pull-request-reviewer[bot]`. Auto-review via branch rulesets (on open,
  on push, drafts; Low/Medium effort). `@copilot` comments address the coding agent,
  not the reviewer.
- **Execution**: first-party GitHub service; agentic context-gathering runs in an
  Actions-backed ephemeral environment (GitHub-hosted runners by default). AI credits
  (attributed to requester / PR author) + Actions minutes.
- **Identity & auth**: built-in GitHub service — no third-party App install, no PAT.
- **Output**: formal GitHub PR review that is **always event type COMMENT** — never
  APPROVE / REQUEST_CHANGES; never satisfies required approvals; inline suggested
  changes. Replies to its comments are not processed.
- **Config**: `.github/copilot-instructions.md`, path-scoped
  `.github/instructions/**/*.instructions.md`, root `AGENTS.md` — all read from the
  **base branch** (a PR cannot rewrite the rules used to review it).
- **Programmatic**: cleanest official *invocation* API of the three (standard reviewer-
  request REST call); verdict read-back is generic review polling with self-defined
  policy. Local `copilot -p ... --output-format json` exists but is separate from the
  native PR reviewer.

---

## 2. Comparison

| Dimension | Codex | Claude (managed) | Claude (action) | Copilot |
|---|---|---|---|---|
| Native trigger | PR comment `@codex review` | PR comment `@claude review` / auto | `@claude` mention / any event | Reviewer assignment (REST/UI/CLI) |
| Runs on | OpenAI cloud | Anthropic cloud | User's Actions runner | GitHub service + Actions env |
| Bot identity | `chatgpt-codex-connector[bot]` (*observed*) | Claude GitHub App | App / `GITHUB_TOKEN` | `copilot-pull-request-reviewer[bot]` |
| Output | PR review (COMMENTED), P0/P1 only; clean = plain comment | Check run + inline comments; non-blocking | Tracking comment; no formal review possible | Formal review, always COMMENT |
| Machine verdict API | None | None confirmed | `structured_output` / SDK | None (poll standard APIs) |
| Instruction file | `AGENTS.md` | `CLAUDE.md` + `REVIEW.md` | `CLAUDE.md` + workflow args | `copilot-instructions.md`, `AGENTS.md` (base branch) |

**Shared conclusion of both investigations**: every hosted reviewer is advisory. None
offers an approve/reject merge-gate contract, a completion callback, or a job API. The
GitHub comment/review/reaction data plane is the only integration seam — exactly the
seam sapwood's gate② is built on.

---

## 3. How sapwood's gate② maps onto this landscape

sapwood's reviewer stack (`reviewer.ts` + `merge-driver.ts`) implements, independently,
the four practices the external research recommends for any orchestrator: pin every
accepted artifact to the current head, verify bot identity, reject stale findings, and
own the verdict schema.

- **Trigger side**: `CodexReviewer.triggerReview` posts `triggerCommand` (default
  `@codex review`, configurable via `reviewer.triggerCommand`, #156) + the issue's
  verification plan + repo review doctrine (#167) as a PR comment — vendor-API-free.
- **Verdict side**: each tick re-fetches `PRReviewData` (reviews, reactions, top-level
  comments, unresolved threads) via `gh` and derives
  `MERGE_OK | WAIT_REVIEW | HANDLE_THREADS | REVIEW_UNAVAILABLE` in a pure function.
  Codex-specific adaptations match the observed behavior above: ACCEPT includes
  **COMMENTED**; a clean-comment regex channel covers the no-review-object clean case;
  👀 = in progress.
- **Trust shape**: approving signals are identity-narrowed (Codex bot login +
  `trustedReviewers`) and head/pin-bound; blocking signals are deliberately
  *unfiltered* (anyone's unresolved thread or standing CHANGES_REQUESTED blocks).
- **PR #277 (OID-bound verdicts)**: review artifacts are keyed by commit OID — the
  trigger states the head under review and requests `Reviewed head OID: <oid>` back;
  head moves mid-review mark the next pin generation ambiguous, in which OID-less clean
  comments and +1 reactions fail closed; re-triggers are delta-scoped
  (`reviewer.deltaChainMax`). This hardens exactly the stale-artifact class the
  landscape's advisory-output model makes possible.
- **Failure direction**: query failure → REVIEW_UNAVAILABLE (queue, never soften);
  silence → fallback chain (#54) / needs-human escalation (#170) — the designed
  degradation for services with no SLA and no callback.

## 4. Architectural implications

1. **Bot identity is an undocumented contract.** `chatgpt-codex-connector` is observed,
   not promised. The `trustedReviewers` extensible allowlist hedges a rename; the
   failure mode (silent perpetual WAIT_REVIEW) is made visible by `escalateAfterSec`.
2. **`triggerCommand` is configurable; the verdict parser is not.** Pointing the
   trigger at `@claude review` (also a top-level-comment protocol) would fire the
   managed Claude reviewer, but sapwood's parser is Codex-shaped (clean-verdict regex,
   identity allowlist, COMMENTED semantics). Swapping bots requires the v1.x
   reviewer-adapter seam — consistent with the boundary already documented in
   `config.ts`.
3. **Copilot does not fit the current seam.** It cannot be comment-triggered
   (reviewer-assignment API; no `IForge` method exists), and its always-COMMENT output
   collides with sapwood's "COMMENTED = accept" rule: naively allowlisting the Copilot
   bot would let a findings-laden review satisfy gate② on the formal-review path
   (unresolved threads being the only remaining block). A future Copilot adapter must
   scope ACCEPT semantics per bot.
4. **The strongest machine-readable verdicts are engine-driven, not hosted.** Both
   investigations independently conclude that self-run CLI/SDK routes
   (`codex exec --output-schema`, `claude -p --output-format json`) are the only paths
   to a real structured verdict contract — relevant to any future engine-side reviewer
   mode.
