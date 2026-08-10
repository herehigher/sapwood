// IForge: the seam between the conductor and the code host. v1 impl is GithubForge
// (gh CLI + GraphQL). Making GitLab/Gitea an implementation, not a rewrite. Every
// Predecessor-project hard-coding (PROJECT_NUMBER, user-vs-org, literal status names, reviewer
// login) lives in SapwoodConfig and is passed in here — never baked into the impl.
//
// SECURITY: all subprocess calls go through gh.ts (execFile with an argv array — never
// exec/shell:true). Issue text is treated as data, never interpolated into a shell.

import { createHash } from "node:crypto";
import type { SapwoodConfig } from "../config/config.js";
import type { EventKind } from "../state/event-kinds/index.js";
import { extractMarkdownSections } from "../util/markdown.js";
import { ghWithTimeout } from "./gh.js";
import { createMissingLabels, type LabelSpec, labelsInclude } from "./labels.js";

// Exported (#415 review, finding 2) so a test can assert against the real ceiling value
// instead of duplicating the literal 1000.
export const OPEN_ISSUES_LIMIT = 1000;

/** #528: the recently-closed dedup window, expressed as "the last N closed issues" rather than a
 *  configured time window — no new config key for a backstop, and N is what the underlying `gh`
 *  read bounds natively. 50 covers several dogfood rounds' worth of shipped facts at this repo's
 *  cadence. ponytail: if a repo ever closes issues faster than the align cadence, raise this
 *  literal (or make it a config key) — nothing else in the design changes. */
export const RECENTLY_CLOSED_ISSUES_LIMIT = 50;

/** #237 finding 2: appended to EVERY issue comment GithubForge.addIssueComment posts (see that
 *  method's own doc comment) — the single, unconditional "this engine wrote this" stamp,
 *  regardless of whatever call-site-specific marker (if any) the body already carries. dissent.ts
 *  (`isSapwoodComment`) checks for the generic `<!-- sapwood:` prefix, which this marker (like
 *  every specific one — round/proposal/triage/concern markers) also satisfies — no special-casing
 *  needed on the reading side, only this one write-side guarantee that it is ALWAYS present. */
export const ENGINE_COMMENT_MARKER = "<!-- sapwood:engine -->";

/** Appends ENGINE_COMMENT_MARKER, exported so a caller composing a body that already ends in its
 *  own marker (or not) never needs to special-case the join — this function is idempotent-enough
 *  in intent (always appends once per addIssueComment call; GithubForge is the only caller). */
export function stampEngineComment(body: string): string {
  return `${body}\n\n${ENGINE_COMMENT_MARKER}`;
}

export type OwnerKind = "user" | "org";

/** #377 (gate② round 4): what a branch read on the forge actually established.
 *  `absent` is GitHub's own answer (404); `unknown` means the CHECK failed and nothing was
 *  established at all. See GithubForge.probePushedBranch. */
export type BranchProbe = "present" | "absent" | "unknown";

/** Did this `gh` failure carry GitHub's own 404 status?
 *
 *  The status code is the provider-authoritative signal; `gh` surfaces it in its error text
 *  (`gh: Not Found (HTTP 404)`), which node's execFile rejection carries on `stderr` and in
 *  `message`. There is no richer channel available here — `gh api` exits 1 for every HTTP error
 *  and for network failure alike — so this reads the status token and nothing else: no "not
 *  found" prose matching, and `\b404\b` alone is deliberately NOT accepted (a branch literally
 *  named `404-error-handling` appears in gh's message for unrelated failures).
 *
 *  FAILURE DIRECTION, stated deliberately: this errs toward UNKNOWN. A real 404 whose wording we
 *  fail to match costs at most MAX_INCONCLUSIVE_PR_PROBES deferred ticks before the lane settles
 *  by the ordinary rules — bounded and mild. The opposite error (a network blip misread as
 *  "absent") is the harm this exists to prevent: it settles a lane whose pushed branch never got
 *  a PR, with no later probe to correct it. */
function isHttpNotFound(e: unknown): boolean {
  const err = e as { stderr?: unknown; message?: unknown };
  const text = `${typeof err?.stderr === "string" ? err.stderr : ""}\n${typeof err?.message === "string" ? err.message : ""}`;
  return /HTTP 404\b/.test(text);
}

export interface Issue {
  number: number;
  title: string;
  labels: string[];
  // #74: raw issue body, for worker.ts's {{issue.body}} prompt-template substitution. Optional
  // (additive) — already fetched by the board GraphQL query (ProjectItem.body) and threaded
  // through selectReadyIssues below; older call sites/fixtures that construct an Issue without
  // it keep typechecking, and renderPromptTemplate treats an absent body as "" (Decision #8's
  // getIssueBody uses the same empty-string-not-throw convention for a bodyless issue).
  body?: string;
  // #86: the issue's GitHub milestone TITLE, when it has one — round.ts's RoundScopedForge
  // filters dispatch candidates against cfg.round.milestone using this field. Optional
  // (additive, same pattern as body above): undefined means no milestone assigned, not "no
  // data fetched" (the project GraphQL query always requests it — see projectQuery).
  milestone?: string;
}

export interface PRStatus {
  number: number;
  headOid: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  // Tri-state, not boolean (Codex PR #42 P2): CONFLICTING must route to needs-human
  // BEFORE a merge attempt, while UNKNOWN (GitHub still computing) only queues — a
  // boolean would either retry conflicts forever or escalate a transient UNKNOWN.
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  ciGreen: boolean;
  /** #246: a genuinely FAILED check (completed non-passing conclusion/state) — tri-state
   *  alongside `ciGreen`, not its negation: `ciGreen === false` alone is ambiguous between
   *  "still computing" (queued/in-progress, or an empty just-pushed rollup) and "actually red",
   *  and merge-driver.ts's deriveGate must never dispatch a fix leg for a CI run that simply
   *  hasn't finished yet. `ciRed === false` with `ciGreen === false` means "still pending" —
   *  the FIXABLE gate falls back to WAIT in that case, unchanged from pre-#246 behavior.
   *  Optional: absent (older fixtures/fakes) treated as `false` by every reader (deriveGate's
   *  caller does `status.ciRed ?? false`) — the same "additive, pre-existing callers unaffected"
   *  convention `mergeable`'s tri-state and every other optional PRStatus-adjacent field use. */
  ciRed?: boolean;
  /** #287 (E4b, design #279 §2 R2-6): the PR's BASE ref oid (`gh pr view --json baseRefOid`) —
   *  part of the engine-agent drive path's identity triple (headOid H, baseOid B, diff hash D):
   *  a base move (e.g. main advanced and the PR's diff base shifted) invalidates an in-flight
   *  review exactly like a head move does, so it must be observable alongside headOid. ADDITIVE
   *  and OPTIONAL: absent on any fixture/fake built before this field existed (or a `gh` version
   *  whose JSON genuinely omits it) — every pre-#287 caller/fixture keeps working unchanged,
   *  same "additive, pre-existing callers unaffected" convention `ciRed` above documents. Only
   *  the engine-agent identity-resolution path (review/drive.ts) requires this to be non-null;
   *  every other PRStatus consumer (deriveGate, mergeDecision, the classic Reviewer kinds) never
   *  reads it. */
  baseOid?: string;
  /** #595 (redo of #365 against the #425 event-kind registry): the PR's own title, from a
   *  `--json title` field added to this SAME `gh pr view` read — never an extra call. ADDITIVE
   *  and OPTIONAL, same convention as `ciRed`/`baseOid` above: absent on any pre-#595
   *  fixture/fake. Consumed by #420 (merge-driver.ts, human-merge-only) to stamp the `merged`
   *  event's `prTitle` — that wiring is explicitly out of scope here. */
  title?: string;
}

/** #292: one rename-aware entry from GitHub's pull-request files API. The old path is retained
 * because deleting or renaming standing reviewer instructions changes the authority graph. */
export interface PRChangedFile {
  filename: string;
  previousFilename?: string;
}

export interface PRChangedFilesResult {
  files: PRChangedFile[];
  /** False when GitHub's pull-files REST ceiling means the returned list may be truncated. */
  complete: boolean;
}

/** One reaction on the PR's top-level issue-comment thread (`gh api .../reactions`). */
export interface PRReaction {
  content: string; // "+1" | "eyes" | ...
  createdAt: string; // ISO
  login: string;
}

/** One top-level PR conversation comment (`gh api .../issues/<pr>/comments`). */
export interface PRComment {
  login: string;
  createdAt: string; // ISO
  body: string;
  // #652: the REST numeric comment id (stringified), when the underlying read populated it —
  // parsePRComments always sets this from a real `gh api .../issues/<n>/comments` response.
  // Optional so pre-#652 fixtures/callers that construct a PRComment literal without it keep
  // typechecking; comment-cursor-gate.ts (the ONE consumer that needs comment identity) treats a
  // missing id the same as an unmatched cursor target — never a crash.
  id?: string;
}

/** One bounded top-level PR conversation comment. Unlike PRComment (legacy issue-comment
 *  readers), this carries GitHub's opaque node id so #288 can persist a delivery receipt. */
export interface PRTopLevelComment extends PRComment {
  id: string;
}

export interface PRCommentsPage {
  comments: PRTopLevelComment[];
  total: number;
}

/** One commit (`gh api repos/<owner>/<repo>/commits?since=...`) — #111 PR-A's git-log-since
 *  source for the retro round-digest (see IForge.getCommitsSince's doc for why this is a GitHub
 *  API read rather than a local `git log`). `message` is the FULL commit message (subject +
 *  body) verbatim; callers that want a one-line summary take the first line themselves. */
export interface CommitInfo {
  sha: string;
  message: string;
  author: string;
  date: string; // ISO
}

/** One review on the PR (`gh pr view --json reviews`). */
export interface PRReview {
  author: string;
  commitOid: string; // the head this review was submitted against
  state: string; // APPROVED | COMMENTED | CHANGES_REQUESTED | DISMISSED | PENDING
  /** ISO timestamp the review was SUBMITTED at (gh's `submittedAt`) — #147 P1: the merge
   *  driver's re-entry freshness cutoff. A re-driven gate② (gated-PR reentry) counts only
   *  reviews submitted AFTER the re-entry's own review trigger; without this, the ORIGINAL
   *  Codex review that raised the threads still sits on the (unchanged) head and would satisfy
   *  the "fresh review" gate the moment a human resolves the threads. Optional: absent/
   *  unparseable ⇒ the review can never pass a re-entry freshness filter (fail-closed); older
   *  fixtures keep type-checking and non-reentry gating is unaffected (no filter there). */
  submittedAt?: string;
}

/** Everything reviewer.ts needs to derive gate②'s ACTION (the predecessor project's pr_gate.sh, review half —
 *  CI/gate① stays on PRStatus.ciGreen). Assembled from 3 read-only gh calls (reactions, pr
 *  view, review threads) — see GithubForge.getPRReviewData. */
export interface PRReviewData {
  headOid: string;
  author: string;
  updatedAt: string; // ISO — the freshness cutoff for reactions (the predecessor project's pr_gate.sh #92)
  isDraft: boolean;
  labels: string[];
  state: "OPEN" | "CLOSED" | "MERGED";
  reactions: PRReaction[];
  reviews: PRReview[];
  /** Top-level conversation comments — Codex sometimes delivers its CLEAN verdict as a plain
   *  comment with NO review object and NO +1 reaction (post-#55 P2). Optional: absent ⇒ the
   *  comment-verdict signal simply never fires (fail-closed), older fixtures keep working. */
  comments?: PRComment[] | undefined;
  unresolvedThreads: number;
  /** #378 (F14): the per-thread spans behind `unresolvedThreads`, from the SAME paged read.
   *  Lets gate② tell an already-adjudicated finding (a resolved thread whose span has not
   *  changed since) from a genuinely fresh one — see ReviewThreadSpan and reviewer.ts's
   *  adjudication filter. Optional: absent ⇒ NO filtering happens at all (fail-closed — the
   *  pre-#378 behavior, where every unresolved thread counts), so older fixtures and any forge
   *  fake that doesn't supply it keep gating exactly as before. */
  threads?: ReviewThreadSpan[] | undefined;
}

/** The only surface the conductor uses to touch the code host. */
export interface IForge {
  detectOwnerKind(owner: string): Promise<OwnerKind>;
  /** Issue-number-addressable board items with no Status, plus draft/non-issue items that
   *  cannot be moved through setBoardStatus. Used once at engine startup, never for dispatch. */
  listUnplacedIssues(): Promise<UnplacedIssues>;
  /** #412: every OPEN issue of the configured repo that is NOT a board item at all, in any
   *  lane (unlike listUnplacedIssues, whose input is board membership already and therefore
   *  cannot see an issue that was never added to the board). Read-only, startup-only,
   *  detect-and-report: the engine never places an issue on a board itself — see cli.ts's
   *  normalizeUnplacedBoardItems, the sole caller. Same jurisdiction as listUnplacedIssues:
   *  draft board items and items belonging to another repo don't count as "on board".
   *
   *  #491: split into two classes, because "not on the configured board" over-reports badly on
   *  any repo running a deliberate multi-board partition (this one runs two: a dogfood queue and
   *  a human-only board — ~30 of the reported rows were placed-by-design every startup). An issue
   *  that is a member of ANY project is PLACED, and only counted; the actionable list is the
   *  issues nobody has placed anywhere. */
  listIssuesAbsentFromBoard(): Promise<BoardGapReport>;
  /** One startup-only, read-only view used to surface management-side orphans after local
   *  state loss. It is observability input only: callers must never rebuild workers from it.
   *  PR orphan detection shares listOpenPrBodies' 200-open-PR bound (#50 residual), so PRs
   *  beyond it are not reported. */
  readStartupReconcileData(): Promise<StartupReconcileData>;
  getReadyIssues(): Promise<Issue[]>;
  claimIssue(issue: number): Promise<void>;
  setBoardStatus(issue: number, status: "backlog" | "ready" | "inProgress" | "done"): Promise<void>;
  addLabel(issue: number, label: string): Promise<void>;
  /** #379: REPO-level label provisioning (not an issue write) — create every spec'd label the
   *  repo lacks and return the created names. Idempotent, detect-before-create; called once per
   *  engine start (cli.ts's reconcileWorkflowLabels) so a repo that predates a newer workflow
   *  label gets it rather than failing every write against it forever. */
  ensureRepoLabels(specs: readonly LabelSpec[]): Promise<string[]>;
  /** #212: remove a label from an ISSUE (the WRITE counterpart to addLabel) — round.ts's
   *  round-close pool cleanup uses this to release an undispatched round-pool member back to
   *  plain Ready. Idempotent: removing an absent label is a no-op on GitHub's side, never an
   *  error. */
  removeLabel(issue: number, label: string): Promise<void>;
  /** Add a label to a PULL REQUEST. #69 P1: the merge gate reads a PR's OWN labels
   *  (getPRReviewData → deriveGate's humanLabels check), not the source issue's, so escalating
   *  a crashed-with-WIP lane to `needs-human` must land here to actually gate the PR. */
  addPRLabel(pr: number, label: string): Promise<void>;
  /** #399: remove a label from a PULL REQUEST — the WRITE counterpart to `addPRLabel`, and the
   *  PR-side twin of `removeLabel`. Idempotent (removing an absent label is a no-op on GitHub's
   *  side, never an error), same as its issue-side sibling.
   *
   *  GOVERNANCE: label removal on a PR is at least as significant as on an issue — `deriveGate`
   *  vetoes a merge on `needs-human`/`blocked` and WAITs on a hold label, all read off the PR's
   *  OWN labels. So this method has exactly ONE production caller, `lane-state-label.ts`'s
   *  `removeLaneStateLabel`, which fails closed for any label but the configured
   *  `labels.laneState` — the same shape (and for the same reason) as `removeRoundPoolLabel`
   *  guarding the issue-side `removeLabel`. A second call site is a defect until it arrives with
   *  a provenance check of its own; see `round.ts`'s `removeRoundPoolLabel` doc for the canonical
   *  list of authorized engine removals. */
  removePRLabel(pr: number, label: string): Promise<void>;
  openPR(branch: string, title: string, body: string): Promise<number>;
  getPRStatus(pr: number): Promise<PRStatus>;
  mergePR(pr: number, headOid: string): Promise<void>;
  /** Post a PR comment (e.g. the `@codex review` trigger). #13 reviewer.ts. */
  addPRComment(pr: number, body: string): Promise<void>;
  /** #288: newest top-level PR conversation comments, bounded by GraphQL `last: cap`. Raw
   *  comments only; callers marker-filter them and never derive gate② approval from them. */
  getPRComments(pr: number, cap: number): Promise<PRCommentsPage>;
  /** Post an ISSUE comment (distinct from addPRComment — a reclaimed lane's retained
   *  worktree may have no PR at all yet). #69: the dirty-worktree-retention escalation path
   *  uses this to tell a human where the preserved worktree lives. */
  addIssueComment(issue: number, body: string): Promise<void>;
  /** Fetch gate②'s raw review signals for a PR. #13 reviewer.ts. */
  getPRReviewData(pr: number): Promise<PRReviewData>;
  /** #111 PR-A: a PR's unified diff (`gh pr diff`), read-only. The retro round-digest's ONE
   *  source for "what code actually changed" — retro.ts no longer has a live `gh pr diff`
   *  Bash grant of its own; the engine fetches this itself, once per touched PR, before the
   *  session ever runs (retro-digest.ts's buildRetroDigest). */
  getPRDiff(pr: number): Promise<string>;
  /** #292: rename-aware changed paths for the instruction-authority escalation gate. Both the
   *  current `filename` and optional `previousFilename` are retained because removing or
   *  renaming an instruction file changes the reviewer-resolution graph too. Failures throw so
   *  gate callers queue fail-closed. `complete` is false at GitHub's 3,000-file REST ceiling so
   *  a potentially partial list degrades to human review rather than being treated as safe. */
  getPRChangedFiles(pr: number): Promise<PRChangedFilesResult>;
  /** #449 gate② P1 fix (design #402 R2): the changed-file set between two arbitrary commits —
   *  GitHub's own three-dot compare, `GET /repos/{owner}/{repo}/compare/{base}...{head}`. Unlike
   *  `getPRChangedFiles` (the PR's FULL base..head, paginated to 3,000), this is a RANGE read
   *  used to isolate exactly what changed BETWEEN two specific commits — `base`/`head` are always
   *  full commit OIDs here (never a ref name needing URL-encoding). `complete` is a HEURISTIC
   *  ceiling check (GitHub does not paginate the compare endpoint's `files` array via Link
   *  headers — it silently caps instead), same shape as `getPRChangedFiles`'s own guard; `false`
   *  means the file list may be partial and callers must treat the WHOLE read as unavailable for
   *  path-membership testing, never trust a partial list as if it were complete. */
  compareChangedFiles(base: string, head: string): Promise<PRChangedFilesResult>;
  /** #111 PR-A: commit history since `sinceIso` — the digest's "git log since round start"
   *  source. Deliberately sourced from the GitHub API (`gh api .../commits`), NOT a local
   *  `git log` subprocess: worker.test.ts's #69 grep-invariant pins that the ONLY engine
   *  modules ever allowed to shell a subprocess are worker.ts (spawn, the claude CLI) and
   *  gh.ts (execFile, the `gh` binary) — no other engine module may exec `git` directly. Using
   *  the GitHub API here keeps that invariant intact AND is arguably more correct anyway: it
   *  reads the round's commits from GitHub's own authoritative view, not whatever the engine's
   *  local checkout happens to have fetched. */
  getCommitsSince(sinceIso: string): Promise<CommitInfo[]>;
  /** #111 PR-B: does a branch of this name exist on the FORGE (not any local checkout)? The
   *  engine-side push verification behind retro's engine-side PR creation: the retro session
   *  claims (via its scratch file) to have pushed a proposal branch, and the engine verifies
   *  that claim against GitHub's own view before ever calling openPR — a session claim is
   *  never trusted as evidence of a push. FAIL DIRECTION: any error (404, network, auth) reads
   *  as `false` — the caller then declines to open a PR and degrades visibly, never opens a PR
   *  against an unverified head. */
  branchExists(branch: string): Promise<boolean>;
  /** Raw issue body text (#46, Decision #8's gate② re-check): reviewer.ts extracts the
   *  verification-plan section from this to carry into the review trigger. Read-only;
   *  "" for an issue with no body rather than throwing (extractVerificationPlan treats an
   *  empty body as "no plan", the same fail-closed outcome as a genuinely planless issue). */
  getIssueBody(issue: number): Promise<string>;
  /** #110 PR0: overwrite an issue's body (the WRITE counterpart to getIssueBody). Additive infra
   *  for the structured-output rework: post-#110, the engine applies a verification-plan-drafter's revised
   *  body (and other role-session edits) itself, from validated data — the role session that
   *  produced the text never touches `gh` directly. Unused by any call site in this PR (zero
   *  behavior change); the first real caller lands in PR1/PR2. */
  updateIssueBody(issue: number, body: string): Promise<void>;
  /** #76: open (state OPEN) issue count in the named milestone — the `stop.onMilestoneComplete`
   *  condition's "is this milestone done" signal. The driver evaluates this at tick boundaries
   *  only (never mid-tick); zero means the milestone has no open issues left, so the condition
   *  fires. A milestone name that doesn't exist in the repo also returns 0 (gh's own query
   *  behavior) — same fail-direction as an already-complete milestone, since either way there is
   *  nothing left to wait for. */
  countOpenIssuesInMilestone(milestone: string): Promise<number>;
  /** #76: every milestone TITLE in the repo (open and closed — an already-closed milestone is a
   *  legitimate "instantly complete" stop target). Startup validation for `onMilestoneComplete`:
   *  `gh issue list --milestone` silently returns [] for a title that doesn't match EXACTLY
   *  (probed: "M4" does not match "M4 — UX surface + CLI"), so a typo'd goal would otherwise
   *  fire the stop condition on the first tick — after dispatching a full wave of workers.
   *  cli.ts fails closed against this list BEFORE any dispatch. */
  listMilestoneTitles(): Promise<string[]>;
  /** #87: Ready-lane issues that still need gate⓪ plan review — the `plan_review` peripheral's
   *  candidate set. Distinct from getReadyIssues() (which already applies gate⓪'s dispatch
   *  filter, i.e. only what's ALREADY approved or doc-gated): this returns Ready issues that
   *  haven't yet been adjudicated one way or the other (excludes needsHuman/blocked/verifyNa —
   *  those are settled, not "awaiting review"). Still used by architect.ts's own (unrelated)
   *  drift-review candidate set and round.ts's probeHasWork signal — #214 does NOT repurpose
   *  this method; see getPoolEligibleIssues below for the round-pool's own, WIDER read. */
  getIssuesNeedingPlanReview(): Promise<Issue[]>;
  /** #214: the round-pool's candidate source — LITERALLY Ready lane + OPEN + this repo, minus
   *  the two fail-closed HOLDS (needsHuman/blocked) and the #94 forbidden verifyNa+planApproved
   *  mixed state (a human-cleanup case, not a session target). Deliberately a body-INDEPENDENT
   *  label check, NOT `getReadyIssues() ∪ getIssuesNeedingPlanReview()` (an earlier draft of this
   *  method used that union — gate② review caught the gap: an issue carrying plan:approved whose
   *  verification-plan section was later deleted from the body satisfies neither selector's body
   *  check, so it would be invisible to both and permanently stranded — see selectPoolEligibleIssues'
   *  own doc for the full rationale and the self-healing consequence this fix produces). This is
   *  deliberately WIDER than getReadyIssues() alone: a Ready issue awaiting its first plan review
   *  (no plan:approved yet) is NOT gate⓪-dispatchable, but it still must be reachable by pool
   *  selection — scoping the pool to gate⓪-passed issues only would deadlock the system (an
   *  unapproved issue never enters the pool -> gate⓪ (scoped to the pool, #214) never reviews it
   *  -> it never gets approved -> it never dispatches). align.ts's computePoolCandidates draws
   *  the round pool from this method; plan-review.ts's createPlanReviewStub filters this SAME
   *  read by cfg.labels.roundPool to get its own candidate set (gate⓪ scoped to the pool, #214).
   *  Executing-phase DISPATCH is unaffected — round.ts's PoolScopedForge still wraps the
   *  NARROWER getReadyIssues(), so a pool member without plan:approved still cannot be dispatched
   *  merely for having entered the pool. */
  getPoolEligibleIssues(): Promise<Issue[]>;
  /** #87: an issue's current label set — the plan_review orchestrator's per-issue outcome
   *  check after a verification-plan-reviewer/verification-plan-drafter session runs (distinguishing approved vs
   *  needs-human vs still-awaiting without re-fetching the whole board). */
  getIssueLabels(issue: number): Promise<string[]>;
  /** #398: a PR's current label set — `getIssueLabels`' PR-side twin, and the READ half of the
   *  escalation-carrier split. Once a PR-born escalation writes `needs-human` on the PR (see
   *  `addPRLabel`), the #147 gated-reentry handshake has to observe THAT object's labels to
   *  decide whether a human released the lane; before this method the only way to see a PR's
   *  labels was `getPRReviewData`, the heavy gate query (PR metadata + reviews + reactions +
   *  every review thread paged to exhaustion), which GATED RECLAIM has no other reason to make.
   *  `gh pr view`, never `gh issue view`, for the same number-namespace reason `addPRLabel`
   *  gives. */
  getPRLabels(pr: number): Promise<string[]>;
  /** #87: an ISSUE's conversation comments (distinct from getPRReviewData's PR comments,
   *  though the underlying GitHub REST endpoint is the same `issues/<n>/comments` either way —
   *  PRs are issues under the hood). The plan_review orchestrator reads the verification-plan-reviewer's
   *  most recent comment as the verification-plan-drafter's brief (#77 Amendment 2). Newest-last (gh's
   *  default chronological order). */
  getIssueComments(issue: number): Promise<PRComment[]>;
  /** #652: the authenticated forge actor's login — the ONLY identity signal the comment-
   *  adjudication cursor's engine-comment exemption may trust (paired with the central
   *  `ENGINE_COMMENT_MARKER`; marker AND actor, never either alone, design adjudicated
   *  2026-08-05). Resolved once per check, never cached across calls by this interface — a
   *  caller that needs it repeatedly resolves it once itself. `null` when the identity cannot be
   *  established (auth failure, network error, malformed response) — the caller's contract is:
   *  an unresolvable actor exempts NO comment, ever. */
  getAuthenticatedActor(): Promise<string | null>;
  /** #89: create a new issue (the PO peripheral's decomposition output) — title + body only.
   *  Labels are applied via the existing addLabel path afterward (e.g. `origin:agent`), rather
   *  than bundled into creation, so there is exactly one label-mutation code path in the
   *  engine, not two. Returns the new issue number. */
  createIssue(title: string, body: string): Promise<number>;
  /** #89: every OPEN issue number in this repo. The PO/alignment peripheral's before/after
   *  diff to discover which issues its own session just created via `gh issue create` — a role
   *  session has no structured return channel back to the orchestrator (see peripheral.ts), so
   *  this diff is the only way align.ts learns what got made. Same fail-closed-on-error stance
   *  as the rest of IForge: a thrown gh call propagates, never a partial/empty list. */
  listOpenIssueNumbers(): Promise<number[]>;
  /** #215/#216: every OPEN issue's digest fields plus body. The PO/alignment peripheral uses
   *  the body to reconcile proposal markers after GitHub accepted a create whose local receipt
   *  was lost. Consumers apply any narrower milestone scope locally; reconciliation and title
   *  dedup deliberately operate on this full OPEN backlog. */
  listOpenIssues(): Promise<Issue[]>;
  /** #528: the most recently updated CLOSED issues, capped at `RECENTLY_CLOSED_ISSUES_LIMIT`.
   *  The sibling of listOpenIssues on the STATE axis: a shipped fact whose issue is closed was
   *  invisible to both dedup layers (the align prompt's context and createIssueProposals'
   *  mechanical marker/title checks), so it could be re-proposed indefinitely (the #525/#461
   *  incident). Deliberately BOUNDED, not complete — hitting the cap is the normal case, so this
   *  read never throws an incompleteness error the way listOpenIssues does; it is a backstop
   *  whose absence degrades to the pre-#528 open-only surface, never a gate. */
  listRecentlyClosedIssues(): Promise<Issue[]>;
  /** #89: OPEN issues in this repo that still lack a verification-plan section in their body —
   *  the PO/triage peripheral's candidate set. Broader than getIssuesNeedingPlanReview: every
   *  open issue regardless of board Status, not just the Ready lane, because triage runs
   *  proactively (before a human ever moves an issue to Ready) so it already carries a plan by
   *  the time gate⓪ sees it. needs-human/blocked/verify:n/a issues are excluded — settled
   *  state, not a drafting target (same exclusion stance as needsPlanReview). */
  getIssuesNeedingPlanTriage(): Promise<Issue[]>;
  /** #234: one issue's core metadata (title/state/labels/updatedAt/milestone) — the forge MCP
   *  proxy's `issue_details` tool composes this with getIssueBody/getIssueComments/
   *  getIssueRelations into the default view. Read-only; a nonexistent issue number propagates
   *  gh's own error (fail-closed, same stance as every other single-issue read in this file). */
  getIssueMeta(issue: number): Promise<IssueMeta>;
  /** #234: an issue's relations — PRs that close it (`closedByPullRequestsReferences`) plus
   *  incoming cross-references/connections from its timeline (issues/PRs that mention or link
   *  this one) — the forge MCP proxy's `issue_relations` tool. Each connection is capped
   *  server-side (GraphQL `first: cap`) — the proxy's own tool-level cap is layered on top of,
   *  never wider than, this. Outgoing mentions (this issue's body/comments referencing another
   *  #N) are NOT fetched here — GitHub's GraphQL schema has no such reverse index; the proxy
   *  layer derives those from the body/comment text it already reads for `issue_details`.
   *  Verified against the live GitHub GraphQL schema (2026-07-17, herehigher/sapwood#217: both
   *  `closedByPullRequestsReferences(includeClosedPrs: true)` and
   *  `timelineItems(itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT])` return the expected
   *  shape). */
  getIssueRelations(issue: number, cap: number): Promise<IssueRelations>;
  /** #311: attach `child` beneath `parent` using GitHub's native sub-issue relation. Both
   *  arguments are issue numbers in this forge's configured repository: GithubForge resolves
   *  both through one repository-scoped query and mutates by node id, never by `subIssueUrl`,
   *  so a cross-repository child is unrepresentable at this seam. Crash-rerun safe: GitHub's
   *  duplicate-add VALIDATION error is reconciled with getSubIssues(parent), succeeding only
   *  when the intended relation already exists. This method never reparents. */
  addSubIssue(parent: number, child: number): Promise<void>;
  /** #311: native children of `parent`, read from this forge's configured repository. */
  getSubIssues(parent: number): Promise<SubIssue[]>;
  /** #234: `gh search issues` scoped to this forge's own repo (never caller-controlled — the
   *  query is opaque GitHub search syntax, this forge always adds `--repo owner/repo` itself) —
   *  the proxy's `search_issues` tool. Capped server-side (`--limit cap`). */
  searchIssues(query: string, cap: number): Promise<IssueSearchResult[]>;
  /** #244: a PR's own core metadata (distinct from getPRStatus's `ciGreen` — that's a computed
   *  GATE signal reviewer.ts/merge-driver.ts own; this is the raw fact set) — the forge MCP
   *  proxy's `pr_details` tool. Read-only; a nonexistent PR number propagates gh's own error
   *  (fail-closed, same stance as every other single-PR read in this file). */
  getPRDetails(pr: number): Promise<PRDetails>;
  /** #244 (bounded per Codex sol-high PR #260 review, P1): every review on a PR, verbatim
   *  (author/commitOid/state/body/submittedAt), fetched via a CAPPED GraphQL `reviews(last: cap)`
   *  read (never an unbounded `gh pr view --json reviews` — a PR with hundreds of reviews would
   *  otherwise silently pull them all into one response). `total` is the connection's own
   *  `totalCount`, so the proxy layer can report an honest `complete` flag without a second call.
   *  Deliberately a SEPARATE gh call from getPRReviewData (which reviewer.ts/merge-driver.ts use
   *  to DERIVE gate② verdicts): this method returns raw review data for a session to read, never
   *  a verdict — no role recomputes "did the review pass" (issue #244's "raw data only" ruling). */
  getPRReviews(pr: number, cap: number): Promise<PRReviewsPage>;
  /** #244: every review thread on a PR, each with its own comment bodies, paged to EXHAUSTION
   *  (same Codex PR #42 P2 rationale as countUnresolvedThreads — a first-page-only fetch could
   *  under-report). `commentsCap` bounds how many comments PER THREAD are fetched (GraphQL
   *  `comments(first: commentsCap)`) — each thread's own `commentsComplete` flag (from that
   *  sub-connection's `totalCount`) tells the proxy layer whether commentsCap actually bounded
   *  it. `pageCapped` (Codex sol-high PR #260 review, P1) is true when the outer thread
   *  connection's own pagination hit ITS hard safety ceiling (50 pages) before exhausting the
   *  connection — a DISTINCT incompleteness reason from the proxy's own lastN capping, which
   *  operates on an already-complete `threads` array. The proxy's own `pr_review_threads` tool
   *  applies its OWN, separate cap to the number of THREADS returned (mirrors issue_comments'
   *  lastN contract: this method returns ALL threads it could page to, the tool layer bounds
   *  them). */
  getPRReviewThreads(pr: number, commentsCap: number): Promise<ReviewThreadsPage>;
  /** #244 (bounded per Codex sol-high PR #260 review, P1): a PR's raw per-check-suite
   *  conclusions (CheckRun entries carry `conclusion`, legacy commit StatusContext entries carry
   *  `state` instead — both shapes passed through verbatim, never reduced to a single ciGreen
   *  boolean, which is getPRStatus's job, not this one's), fetched via a CAPPED GraphQL
   *  `contexts(first: cap)` read off the head commit's `statusCheckRollup` (never an unbounded
   *  read — a monorepo PR can carry far more than a handful of check runs). `total` is the
   *  sub-connection's own `totalCount` — the proxy's `pr_checks` tool. */
  getPRChecks(pr: number, cap: number): Promise<PRChecksPage>;
  /** #502: the DEFAULT BRANCH's current check status, read off its HEAD commit's
   *  `statusCheckRollup` through the SAME capped `contexts(first: cap)` connection `getPRChecks`
   *  uses — the one new polling surface base-branch CI awareness needs. Ref-scoped, never
   *  PR-scoped: a red base is a RUN-level fact that gates every open lane at once, and deriving
   *  it from any one PR's merge-ref rollup cannot tell "the base is broken" from "this branch
   *  is broken". Deliberately additive — `getPRChecks`' signature, query and behavior are
   *  untouched. */
  getDefaultBranchChecks(cap: number): Promise<BranchChecksPage>;
  /** #247: post a reply comment on ONE review thread (GraphQL `addPullRequestReviewThreadReply`,
   *  `threadId` a `PullRequestReviewThread` node id — the SAME opaque id `getPRReviewThreads`'
   *  `ReviewThreadItem.id` already carries). The fix-loop's ONLY write path for a fix leg's
   *  reply — the leg itself never calls this; the ENGINE calls it from validated structured
   *  output (issue #247's paradigm: producer never touches the forge, #218). Never mutates
   *  thread resolution — see resolveReviewThread for that, a deliberately separate call so a
   *  `disputed` entry can reply without ever resolving. */
  replyToReviewThread(threadId: string, body: string): Promise<void>;
  /** #247: mark ONE review thread resolved (GraphQL `resolveReviewThread`). Bookkeeping /
   *  courtesy-to-reviewer only — issue #247's Why: "gate integrity does NOT rest on thread
   *  state... the fresh review is the gate", so resolving every thread on a PR can never by
   *  itself flip the merge verdict (unresolvedThreads is re-derived live from GitHub on every
   *  gate② read, via countUnresolvedThreads — this call changes what that NEXT read sees, it
   *  does not touch any cached/decided verdict). Called ONLY for an `addressed` structured-output
   *  entry — never for `disputed` (that thread stays open on purpose, routed to human
   *  adjudication if the fix-loop's round cap is reached, sibling issue #246). */
  resolveReviewThread(threadId: string): Promise<void>;
  /** #247 F2(b) (Codex sol-high PR #265 review round 2, P1): a review thread's OWN newest `cap`
   *  comment bodies (GraphQL `last:`, not `first:`) — fix-response.ts's reply-idempotency marker
   *  check (D3) needs to see the reply it JUST posted, which is by definition the newest comment
   *  on the thread; `getPRReviewThreads`' own `first: cap` default-view read exists for a
   *  different reason (issue #244's completeness contract keeps the OLDEST comments as read
   *  context) and would hide the marker behind a long thread. Deliberately its own read, scoped
   *  to ONE thread by its opaque node id (no PR/owner/repo variable — same out-of-repo-scope-by-
   *  construction shape reply/resolve already have) rather than a param bolted onto the existing
   *  read. */
  getReviewThreadCommentsTail(threadId: string, cap: number): Promise<string[]>;
}

/** #234: one issue's core metadata — see IForge.getIssueMeta's doc. */
export interface IssueMeta {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  labels: string[];
  updatedAt: string;
  milestone?: string;
}

/** #234: one related issue/PR reference — see IForge.getIssueRelations' doc. `state` is passed
 *  through verbatim from GitHub (OPEN/CLOSED for an issue, OPEN/CLOSED/MERGED for a PR). */
export interface RelatedRef {
  number: number;
  title: string;
  state: string;
  labels: string[];
  kind: "issue" | "pr";
}

/** #234: an issue's relations — see IForge.getIssueRelations' doc. `truncated` is true when
 *  either connection returned exactly `cap` entries — GraphQL's `first: cap` gives no total
 *  count, so hitting the cap exactly is the only honest truncation signal available (fail
 *  toward flagging a possible truncation rather than silently under-reporting one). */
export interface IssueRelations {
  linkedPRs: RelatedRef[];
  crossReferences: RelatedRef[];
  truncated: boolean;
}

/** #311: one native GitHub sub-issue. The seam deliberately exposes only same-repository
 *  issue numbers and display fields; opaque node ids never escape GithubForge. */
export interface SubIssue {
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
}

/** #234: one `gh search issues` match — see IForge.searchIssues' doc. */
export interface IssueSearchResult {
  number: number;
  title: string;
  state: string;
  labels: string[];
  updatedAt: string;
}

/** #244: a PR's core metadata — see IForge.getPRDetails' doc. `mergeable` is the same tri-state
 *  PRStatus already uses (never a boolean — CONFLICTING must be distinguishable from GitHub
 *  still-computing UNKNOWN). Deliberately carries NO `ciGreen` — that's a computed gate signal,
 *  not raw data (see IForge.getPRDetails' doc; pr_checks is the raw-data counterpart). */
export interface PRDetails {
  number: number;
  headOid: string;
  baseRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  draft: boolean;
  labels: string[];
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
}

/** #244: one review, verbatim — see IForge.getPRReviews' doc. A proxy-specific shape (distinct
 *  from the internal `PRReview` gate.ts/reviewer.ts consume): carries `body`, which the internal
 *  gate type has no reason to hold, and deliberately does NOT import/extend PRReview — keeping
 *  the raw-data proxy surface uncoupled from the gate-verdict type it must never influence. */
export interface PRReviewItem {
  author: string;
  commitOid: string;
  state: string;
  body: string;
  submittedAt?: string;
}

/** #244 (Codex sol-high PR #260 review, P1): IForge.getPRReviews' bounded result — `total` is
 *  the GraphQL `reviews` connection's own `totalCount`, letting the proxy layer report an honest
 *  `complete` flag (`reviews.length >= total`) without a second call or heuristic. */
export interface PRReviewsPage {
  reviews: PRReviewItem[];
  total: number;
}

/** #244: one review-thread comment — see IForge.getPRReviewThreads' doc. */
export interface ReviewThreadComment {
  author: string;
  body: string;
  createdAt: string;
}

/** #244: one review thread (a GraphQL `PullRequestReviewThread` node) with its own comments —
 *  see IForge.getPRReviewThreads' doc. `commentsComplete` (Codex sol-high PR #260 review, P1):
 *  false when this THREAD's own comments sub-connection carries more than `commentsCap` fetched
 *  (the sub-connection's own `totalCount`/`hasNextPage`) — distinct from `ReviewThreadsPage`'s
 *  `pageCapped`, which is about the OUTER threads connection, not any one thread's comments. */
export interface ReviewThreadItem {
  id: string;
  isResolved: boolean;
  comments: ReviewThreadComment[];
  commentsComplete: boolean;
}

/** #244 (Codex sol-high PR #260 review, P1): IForge.getPRReviewThreads' bounded result.
 *  `pageCapped` is true when fetchAllReviewThreads' hard 50-page safety ceiling was hit BEFORE
 *  the outer reviewThreads connection was exhausted (`hasNextPage` still true) — a distinct
 *  incompleteness reason from the proxy tool's own lastN capping (which operates on an
 *  already-complete `threads` array here). `threads` is only a PARTIAL view of the PR's review
 *  threads when `pageCapped` is true. */
export interface ReviewThreadsPage {
  threads: ReviewThreadItem[];
  pageCapped: boolean;
}

/** #244: one check-suite entry off a PR's `statusCheckRollup` — see IForge.getPRChecks' doc.
 *  `conclusion`/`status` are a modern CheckRun's fields; `state` is a legacy commit StatusContext
 *  entry's own field (mutually exclusive in practice — a CheckRun entry's `state` is always
 *  null here, a StatusContext entry's `conclusion`/`status` are always null — never merged or
 *  guessed into a single value, see parsePRChecks). */
export interface PRCheckItem {
  name: string;
  status: string;
  conclusion: string | null;
  state: string | null;
  /** #287 (E4b, design #279 §4 R3): the GitHub App slug that owns this CheckRun's check suite
   *  (`checkSuite { app { slug } }`) — the binding a same-NAMED check from an untrusted app must
   *  fail, so `ci.requiredChecks`' `{name, app}` pairs can verify OWNERSHIP, not just presence.
   *  Only ever populated for a modern CheckRun node; a legacy StatusContext entry (`state` set,
   *  `conclusion` null) has no check-suite/App concept at all and this is always `null` for one —
   *  review/ci-evidence.ts's requiredChecksSatisfied treats that `null` as "cannot verify
   *  ownership," which is exactly why a legacy status-context check never satisfies a
   *  `ci.requiredChecks` entry (design #279 §4: "SKIPPED/NEUTRAL/legacy-status-context DO NOT
   *  satisfy it"). `undefined` on any pre-#287 fixture/fake reads identically to `null` at every
   *  call site (both fail the ownership check) — additive, no fixture breakage. */
  appSlug?: string | null;
}

/** #244 (Codex sol-high PR #260 review, P1): IForge.getPRChecks' bounded result — `total` is
 *  the GraphQL `contexts` sub-connection's own `totalCount`. */
export interface PRChecksPage {
  checks: PRCheckItem[];
  total: number;
}

/** #502: IForge.getDefaultBranchChecks' bounded result — `getPRChecks`' shape plus the two facts
 *  that make it ref-scoped rather than PR-scoped: WHICH branch GitHub reports as the default, and
 *  WHICH commit is currently its HEAD (the oid the checks below belong to, and the identity the
 *  base-red pin is keyed on). An empty `headOid` means the read produced no usable commit — see
 *  parseDefaultBranchChecksPage. */
export interface BranchChecksPage {
  branch: string;
  headOid: string;
  checks: PRCheckItem[];
  total: number;
}

/** #449 gate② P1 fix: GitHub's documented ceiling on the compare endpoint's `files` array — it
 *  does not paginate via Link headers (unlike `pulls/{pr}/files`), so a response landing AT this
 *  count is treated as possibly-truncated rather than exactly-300-files-by-coincidence, the same
 *  fail-closed-on-ambiguity stance `getPRChangedFiles`'s own 3,000-entry guard takes. */
const COMPARE_FILES_CAP = 300;

/** #449 gate② delta review (force-push/rebase P2): the compare endpoint's `status` field is the
 *  ONLY signal that `files` is actually a `base..head` diff. `"ahead"` (head strictly ahead of
 *  base) and `"identical"` (no changes) are the two states where that holds; every other value —
 *  most commonly `"diverged"`, GitHub's answer once `head`'s branch was force-pushed/rebased out
 *  from under the `base` this caller still has on record — means GitHub computed `files` from
 *  their MERGE-BASE instead, which is a SUPERSET of the true range (it additionally contains
 *  everything the two sides moved independently since diverging). A 200 response is therefore NOT
 *  by itself proof of a trustworthy range: `complete` must fail narrow on `status` too, not just
 *  on `COMPARE_FILES_CAP`. Absent/unrecognized `status` (a response shape this code doesn't
 *  understand) fails narrow the same way — never assumed exact. */
function isExactCompareRange(status: unknown): boolean {
  return status === "ahead" || status === "identical";
}

/** #438: the two channels GithubForge announces a hit paging ceiling on. Structural (not an
 *  import of State) so the forge seam keeps its one-way dependency on config only. An engine
 *  session passes both; a stateless CLI path (`sapwood --dry-run`) passes neither and degrades
 *  to a stderr line, which is all that surface has. */
export interface ForgeDeps {
  log?: (message: string) => void;
  state?: { appendEvent(kind: EventKind, payload: unknown): void };
}

export class GithubForge implements IForge {
  constructor(
    private readonly cfg: SapwoodConfig,
    private readonly deps: ForgeDeps = {},
  ) {}

  /** #438: a paging loop stopped at its safety ceiling, so the read it returned is INCOMPLETE —
   *  and both call sites gate safety-relevant behaviour on it (gate②'s unresolved-finding count;
   *  dispatch eligibility off the board). The ceiling itself is unchanged; what was missing was
   *  any way to know it fired. Announced on the durable ledger (what `sapwood status` / the event
   *  log read) AND the operator log, because the two consumers differ in whether state exists.
   *  ponytail: no dedup — a board that stays over the ceiling re-announces on every read. That is
   *  the intent: the condition is ongoing, not an edge, and going quiet is exactly the failure
   *  #438 fixes. Never load-bearing: an append failure is logged, never propagated into a read
   *  whose contract this issue explicitly does not change. */
  private announcePageCeiling(message: string, payload: Record<string, unknown>): void {
    const log = this.deps.log ?? console.error;
    log(`[sapwood:forge] page ceiling hit — ${message}; the read below is PARTIAL`);
    try {
      this.deps.state?.appendEvent("forge-page-ceiling", payload);
    } catch (e) {
      log(`[sapwood:forge] page-ceiling event append failed (non-fatal): ${String(e)}`);
    }
  }

  /** Run `gh` via the shared (execFile, no-shell) helper. Returns stdout. #395: every call is
   *  bounded by cfg.liveness.forgeCallTimeoutMs — a dead socket/hung upstream must never wedge
   *  the tick loop forever. */
  private async gh(args: string[]): Promise<string> {
    return ghWithTimeout(args, this.cfg.liveness.forgeCallTimeoutMs);
  }

  async detectOwnerKind(owner: string): Promise<OwnerKind> {
    // `gh api users/<owner>` returns type User or Organization.
    const out = await this.gh(["api", `users/${owner}`, "--jq", ".type"]);
    return out.trim() === "Organization" ? "org" : "user";
  }

  /** Fetch + parse the ProjectV2 board (items + Status field options), paging the items
   *  connection to exhaustion — boards with >100 items would otherwise silently drop Ready
   *  issues and break item lookups (Codex P2, PR #30). */
  private async fetchProject(): Promise<ParsedProject> {
    const kind = this.cfg.board.ownerKind ?? (await this.detectOwnerKind(this.cfg.board.owner));
    const root = kind === "org" ? "organization" : "user";
    const query = projectQuery(root, this.cfg.board.statusField);
    const statusField = this.cfg.board.statusField;
    let merged: ParsedProject | undefined;
    let after: string | null = null;
    // ponytail: hard page ceiling (500 items) so a cursor bug can't spin forever.
    for (let page = 0; page < 50; page++) {
      const args = [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        "-f",
        `login=${this.cfg.board.owner}`,
        "-F",
        `number=${this.cfg.board.projectNumber}`,
        // First page: -F passes the literal `null` as JSON null. Later pages: the cursor is
        // an opaque string -> -f (raw), so a number-/bool-looking cursor isn't mistyped by -F.
        ...(after === null ? ["-F", "after=null"] : ["-f", `after=${after}`]),
      ];
      const out = await this.gh(args);
      const parsed = parseProject(out, statusField);
      if (!merged) merged = parsed;
      else {
        merged.items.push(...parsed.items);
        merged.placements.push(...parsed.placements);
      }
      const pi = parsePageInfo(out);
      if (!pi.hasNextPage || !pi.endCursor) return merged;
      after = pi.endCursor;
    }
    // page ceiling hit; return what we have rather than loop unbounded. #415 review: mark it
    // truncated so listIssuesAbsentFromBoard (the one consumer for which a partial view can
    // produce a FALSE "absent" report) can refuse to report instead of risking a wrong answer.
    // #438: the OTHER three consumers (getReadyIssues, listUnplacedIssues, readStartupReconcileData)
    // legitimately proceed on the partial view — so the truncation is announced here, once per
    // read, rather than left to a flag only one caller ever looks at.
    this.announcePageCeiling(
      `project board ${this.cfg.board.owner}/#${this.cfg.board.projectNumber} items stopped at 50 pages with ${merged!.items.length} items read — Ready issues past it are invisible to dispatch`,
      {
        source: "project-items",
        owner: this.cfg.board.owner,
        projectNumber: this.cfg.board.projectNumber,
        pages: 50,
        items: merged!.items.length,
      },
    );
    return { ...merged!, truncated: true };
  }

  async getReadyIssues(): Promise<Issue[]> {
    // Source-of-truth work-queue boundary: only ProjectV2 items in the configured Ready
    // lane, OPEN, in THIS repo, that pass gate⓪ (#88, amending Decision #8): a verify:n/a
    // issue with no needs-human (doc-gate path), or a genuine plan that also carries
    // plan:approved. needs-human/blocked always exclude. Never every open issue. Fail-closed
    // on any error: fetchProject's gh()/GraphQL calls throw straight through this method
    // (no partial/empty ready list on a fetch failure) — see selectReadyIssues below.
    const project = await this.fetchProject();
    return selectReadyIssues(project, this.cfg);
  }

  async listUnplacedIssues(): Promise<UnplacedIssues> {
    const project = await this.fetchProject();
    return selectUnplacedIssues(project.placements, `${this.cfg.board.owner}/${this.cfg.board.repo}`);
  }

  /** #415 review (Codex sol-high P1/P1): a wrong report is worse than no report — refuses to
   *  compute at all (throws, letting normalizeUnplacedBoardItems' existing best-effort catch
   *  degrade to a logged skip) whenever either read that feeds this comparison might be
   *  incomplete: fetchProject hit its page ceiling (a real board item beyond it would be
   *  wrongly reported "absent"), or listOpenIssueNumbers returned exactly its own `gh --limit`
   *  ceiling (a real open issue beyond it could be silently missing from the "absent" set, or
   *  the reported total could undercount). Neither existing method's OWN behavior changes for
   *  its other callers — this is a read-time check layered on top, not a new fetch mode. */
  async listIssuesAbsentFromBoard(): Promise<BoardGapReport> {
    const [project, openIssues] = await Promise.all([this.fetchProject(), this.listOpenIssuePlacements()]);
    if (project.truncated) {
      throw new Error("listIssuesAbsentFromBoard: board read hit fetchProject's page ceiling — refusing a possibly-wrong absent report");
    }
    if (openIssues.length >= OPEN_ISSUES_LIMIT) {
      throw new Error(
        `listIssuesAbsentFromBoard: open-issue read may be incomplete (hit the ${OPEN_ISSUES_LIMIT}-issue limit) — refusing a possibly-wrong absent report`,
      );
    }
    return selectIssuesAbsentFromBoard(openIssues, project.placements, `${this.cfg.board.owner}/${this.cfg.board.repo}`);
  }

  async readStartupReconcileData(): Promise<StartupReconcileData> {
    const project = await this.fetchProject();
    return { placements: project.placements, openPrs: await this.listOpenPrBodies() };
  }

  // #377: no longer private — associateLanePr's marker-scan fallback (for a lane whose worktree,
  // and therefore whose branch, is already gone) reads the same bounded open-PR list startup
  // reconciliation uses. The residual >200-open-PR fail-safe documented in #50 remains.
  async listOpenPrBodies(): Promise<OpenPrBody[]> {
    const out = await this.gh([
      "pr",
      "list",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      // #595: `title` added to this SAME list read (not a new call) — see OpenPrBody.title.
      "number,title,body",
    ]);
    const prs = JSON.parse(out) as { number: number; title?: string; body?: string }[];
    return prs.map((pr) => ({ number: pr.number, body: pr.body ?? "", ...(pr.title !== undefined ? { title: pr.title } : {}) }));
  }

  async claimIssue(issue: number): Promise<void> {
    // Atomic-ish claim: board -> In Progress, then the in-progress label. If the label step
    // fails, roll the board back to Ready so a partial claim can't strand the issue out of
    // the dispatch queue with no worker (Codex R3/R4, PR #30). claimIssue must leave the
    // issue dispatchable on any failure — the conductor relies on that.
    await this.setBoardStatus(issue, "inProgress");
    try {
      await this.addLabel(issue, this.cfg.labels.inProgress);
    } catch (e) {
      await this.setBoardStatus(issue, "ready").catch(() => {});
      throw e;
    }
  }

  async setBoardStatus(issue: number, status: "backlog" | "ready" | "inProgress" | "done"): Promise<void> {
    // ProjectV2 single-select mutation. The status *value* comes from config
    // (cfg.board.status[status]), never a literal. Resolve ids, then mutate. Fail closed
    // if the issue isn't on the board or the lane name doesn't exist (no silent no-op).
    const value = this.cfg.board.status[status];
    const project = await this.fetchProject();
    const itemId = findItemId(project, issue, `${this.cfg.board.owner}/${this.cfg.board.repo}`);
    if (!itemId) throw new Error(`setBoardStatus: issue #${issue} is not on project board ${this.cfg.board.projectNumber}`);
    const optionId = findOptionId(project, value);
    if (!optionId) throw new Error(`setBoardStatus: no "${value}" option in the "${this.cfg.board.statusField}" field`);
    await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${BOARD_MUTATION}`,
      "-f",
      `projectId=${project.projectId}`,
      "-f",
      `itemId=${itemId}`,
      "-f",
      `fieldId=${project.statusFieldId}`,
      "-f",
      `optionId=${optionId}`,
    ]);
  }

  async addLabel(issue: number, label: string): Promise<void> {
    await this.gh(["issue", "edit", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--add-label", label]);
  }

  /** #379: the same provisioning primitive `sapwood init` uses (labels.ts's createMissingLabels),
   *  run against the configured repo through this forge's own bounded `gh`. */
  async ensureRepoLabels(specs: readonly LabelSpec[]): Promise<string[]> {
    return createMissingLabels((args) => this.gh(args), `${this.cfg.board.owner}/${this.repo()}`, specs);
  }

  async removeLabel(issue: number, label: string): Promise<void> {
    await this.gh(["issue", "edit", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--remove-label", label]);
  }

  async openPR(branch: string, title: string, body: string): Promise<number> {
    const out = await this.gh([
      "pr",
      "create",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]);
    const m = out.match(/\/pull\/(\d+)/);
    if (!m) throw new Error(`openPR: could not parse PR number from: ${out.trim()}`);
    return Number(m[1]);
  }

  async getPRStatus(pr: number): Promise<PRStatus> {
    const out = await this.gh([
      "pr",
      "view",
      String(pr),
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--json",
      // #287 (E4b): baseRefOid added — a real `gh pr view --json` field (verified against a live
      // `gh` binary), giving PRStatus.baseOid without switching this call to raw GraphQL.
      // #595: title added to this SAME read (not a new call) — see PRStatus.title's own doc.
      "number,title,headRefOid,baseRefOid,state,mergeable,statusCheckRollup",
    ]);
    return parsePRStatus(out);
  }

  async getPRDiff(pr: number): Promise<string> {
    return this.gh(["pr", "diff", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`]);
  }

  async getPRChangedFiles(pr: number): Promise<PRChangedFilesResult> {
    const out = await this.gh([
      "api",
      `repos/${this.cfg.board.owner}/${this.repo()}/pulls/${pr}/files?per_page=100`,
      "--paginate",
      "--slurp",
    ]);
    const files = parsePRChangedFiles(out);
    return { files, complete: files.length < 3000 };
  }

  /** #449 gate② P1 fix: no `--paginate` — the compare endpoint returns ONE object (not an
   *  array), so `--paginate --slurp` (getPRChangedFiles' own mechanism) does not apply here.
   *  #449 gate② delta review (force-push P2): `complete` additionally requires `status` to be
   *  `"ahead"`/`"identical"` (`isExactCompareRange`, this file) — a `"diverged"` (or any other
   *  non-exact) response is a possibly-wider-than-requested file list, not a trustworthy range,
   *  regardless of how far under `COMPARE_FILES_CAP` it lands. */
  async compareChangedFiles(base: string, head: string): Promise<PRChangedFilesResult> {
    const out = await this.gh(["api", `repos/${this.cfg.board.owner}/${this.repo()}/compare/${base}...${head}`]);
    const files = parseCompareChangedFiles(out);
    const status = (JSON.parse(out) as { status?: unknown }).status;
    return { files, complete: files.length < COMPARE_FILES_CAP && isExactCompareRange(status) };
  }

  async getCommitsSince(sinceIso: string): Promise<CommitInfo[]> {
    // Same --paginate/--slurp discipline as getIssueComments — the commits list endpoint pages
    // at 30/page by default; a round spanning >30 commits must not silently lose the rest.
    const out = await this.gh([
      "api",
      `repos/${this.cfg.board.owner}/${this.repo()}/commits?since=${encodeURIComponent(sinceIso)}&per_page=100`,
      "--paginate",
      "--slurp",
    ]);
    return parseCommitsSince(out);
  }

  async branchExists(branch: string): Promise<boolean> {
    // Unchanged contract (retro.ts depends on it): ANY failure — 404, network, auth — reads as
    // "not verifiably pushed", so a PR is never opened against an unverified head. Implemented
    // on top of the tri-state probe below so the two can't drift; "unknown" collapses to false
    // exactly as it always did.
    return (await this.probePushedBranch(branch)) === "present";
  }

  /** #377 (gate② round 4): branchExists' answer, WITHOUT the lossy collapse — the lane-association
   *  path needs to tell "GitHub says this branch does not exist" apart from "the check itself
   *  failed". Collapsing the two re-created the round-3 harm one call earlier: a transient blip
   *  read as `false` -> fell through to the marker scan -> a CONCLUSIVE "no PR" -> the conductor
   *  settled a lane whose pushed branch never got its PR (see LanePrOutcome).
   *
   *  Per-SEGMENT encoding: branch names routinely contain "/" (feat/x), which must survive as a
   *  path separator for GitHub's greedy branch route, while any other reserved character in a
   *  segment must not be able to reshape the API path (the branch name originates from a
   *  SESSION-written scratch file — treated as data, same stance as every other session-text
   *  input in this file). */
  async probePushedBranch(branch: string): Promise<BranchProbe> {
    const path = branch.split("/").map(encodeURIComponent).join("/");
    try {
      await this.gh(["api", `repos/${this.cfg.board.owner}/${this.repo()}/branches/${path}`]);
      return "present";
    } catch (e) {
      return isHttpNotFound(e) ? "absent" : "unknown";
    }
  }

  async mergePR(pr: number, headOid: string): Promise<void> {
    // --match-head-commit pins the reviewed head: TOCTOU guard against a push between
    // review and merge (the predecessor project's loop_merge_driver.sh). producer != merger: only the
    // conductor calls this, never a worker.
    await this.gh([
      "pr",
      "merge",
      String(pr),
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--squash",
      "--delete-branch",
      "--match-head-commit",
      headOid,
    ]);
  }

  async addPRComment(pr: number, body: string): Promise<void> {
    // The `@codex review` trigger (default reviewer) rides this same call — a plain PR
    // comment, never a review/approval/merge call (producer != reviewer != merger).
    await this.gh(["pr", "comment", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--body", body]);
  }

  async getPRComments(pr: number, cap: number): Promise<PRCommentsPage> {
    const out = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${PR_COMMENTS_QUERY}`,
      "-f",
      `owner=${this.cfg.board.owner}`,
      "-f",
      `repo=${this.repo()}`,
      "-F",
      `number=${pr}`,
      "-F",
      `cap=${cap}`,
    ]);
    return parsePRCommentsPage(out);
  }

  async addIssueComment(issue: number, body: string): Promise<void> {
    // #237 finding 2 (2026-07-18 adjudication on PR #262): stamp EVERY issue comment this engine
    // posts, at this ONE write boundary — regardless of whether the call site already embeds its
    // own specific marker (align.ts's round/proposal/triage markers, dissent.ts's concern
    // marker, harvest.ts's round marker) or none at all (architect.ts's raw contradiction-verdict/
    // per-issue-explanation comments, conductor.ts's retention/escalation comments — audited: both
    // route through this same method, neither embedded a marker of its own before this change).
    // dissent.ts's adjudication scan (isSapwoodComment) relies on EVERY engine comment carrying
    // SOME `<!-- sapwood:` marker to distinguish its own activity from an external reply; a
    // single central stamp here makes that true unconditionally, with no per-call-site duty to
    // remember it. See ENGINE_COMMENT_MARKER's own doc comment.
    await this.gh([
      "issue",
      "comment",
      String(issue),
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--body",
      stampEngineComment(body),
    ]);
  }

  async addPRLabel(pr: number, label: string): Promise<void> {
    // `gh pr edit` (not `gh issue edit`) so a PR number is never mis-resolved to a same-number
    // issue on repos where the two namespaces overlap.
    await this.gh(["pr", "edit", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--add-label", label]);
  }

  async removePRLabel(pr: number, label: string): Promise<void> {
    // `gh pr edit`, never `gh issue edit`, for the same number-namespace reason addPRLabel gives.
    await this.gh(["pr", "edit", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--remove-label", label]);
  }

  async getIssueBody(issue: number): Promise<string> {
    const out = await this.gh(["issue", "view", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--json", "body"]);
    const parsed = JSON.parse(out) as { body?: string };
    return parsed.body ?? "";
  }

  async updateIssueBody(issue: number, body: string): Promise<void> {
    await this.gh(["issue", "edit", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--body", body]);
  }

  /** #377: every OPEN PR whose HEAD is exactly `branch` — the branch-keyed read that replaced
   *  the deleted issue-number-keyed `findOpenPrForIssue` on the lane-association path (see
   *  associateLanePr). A branch is a structural fact about which lane produced the code; a PR
   *  body's prose mention of "#N" is not. Returns every match (GitHub permits several open PRs
   *  off one head against different bases) — the caller disambiguates by marker, never by
   *  picking one arbitrarily. */
  async listOpenPrsForBranch(branch: string): Promise<OpenPrBody[]> {
    const out = await this.gh([
      "pr",
      "list",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--head",
      branch,
      "--state",
      "open",
      "--limit",
      "20",
      "--json",
      // #595: `title` added to this SAME list read (not a new call) — see OpenPrBody.title.
      "number,title,body",
    ]);
    const prs = JSON.parse(out) as { number: number; title?: string; body?: string }[];
    return prs.map((pr) => ({ number: pr.number, body: pr.body ?? "", ...(pr.title !== undefined ? { title: pr.title } : {}) }));
  }

  /** #377: overwrite a PR's body — the WRITE half of the marker contract (the engine stamps the
   *  owner marker onto a PR its worker opened without one). `gh pr edit`, never `gh issue edit`,
   *  for the same number-namespace reason addPRLabel gives. */
  async updatePRBody(pr: number, body: string): Promise<void> {
    await this.gh(["pr", "edit", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--body", body]);
  }

  async getPRReviewData(pr: number): Promise<PRReviewData> {
    // Read-only gh calls (the predecessor project's pr_gate.sh): PR metadata + reviews, reactions (--paginate), and
    // the review-threads connection PAGED TO EXHAUSTION (Codex PR #42 P2 — a first-100-only
    // fetch could report zero findings while an unresolved thread sits on a later page).
    // Never touches merge/approve/ready — this is a read surface only.
    const viewJson = await this.gh([
      "pr",
      "view",
      String(pr),
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--json",
      "headRefOid,author,updatedAt,isDraft,labels,state,reviews",
    ]);
    const reactionsJson = await this.gh([
      // --slurp: --paginate alone concatenates one JSON doc per page (unparseable as a
      // single document); --slurp wraps pages in an outer array parsePRReactions flattens.
      "api",
      `repos/${this.cfg.board.owner}/${this.repo()}/issues/${pr}/reactions`,
      "--paginate",
      "--slurp",
    ]);
    const commentsJson = await this.gh([
      // Same pagination discipline. Conversation comments carry Codex's comment-shaped clean
      // verdict ("Didn't find any major issues") — post-#55 P2: that shape has no review
      // object and no +1 reaction, so without this fetch it wedges at WAIT_REVIEW.
      "api",
      `repos/${this.cfg.board.owner}/${this.repo()}/issues/${pr}/comments`,
      "--paginate",
      "--slurp",
    ]);
    // #378: ONE paged read now yields both gate②'s unresolved total and the per-thread spans
    // its adjudication filter needs — same query, same pass, no extra round trip.
    const { unresolved: unresolvedThreads, threads } = await collectReviewThreads(
      (after) =>
        this.gh([
          "api",
          "graphql",
          "-f",
          `query=${REVIEW_THREADS_QUERY}`,
          "-f",
          `owner=${this.cfg.board.owner}`,
          "-f",
          `repo=${this.repo()}`,
          "-F",
          `number=${pr}`,
          // Same -F null / -f cursor split as fetchProject: an opaque cursor must go raw.
          ...(after === null ? ["-F", "after=null"] : ["-f", `after=${after}`]),
        ]),
      // #438: gate②'s unresolved count comes from this read. A ceiling hit under-counts findings,
      // which fails OPEN (a merge gate seeing fewer objections than exist) — announce it here,
      // where the PR number is in scope.
      (partial) =>
        this.announcePageCeiling(
          `PR #${pr} review threads stopped at 50 pages with ${partial.unresolved} unresolved of ${partial.threads} threads read — gate② is deciding on a PARTIAL finding count`,
          { source: "review-threads", pr, pages: 50, ...partial },
        ),
    );
    return assemblePRReviewData(viewJson, reactionsJson, unresolvedThreads, commentsJson, threads);
  }

  async countOpenIssuesInMilestone(milestone: string): Promise<number> {
    // `gh issue list --milestone` takes the milestone TITLE (not a number) and already scopes to
    // this repo + state:open via the flags below — no GraphQL needed. --limit generously above
    // any realistic milestone size (ponytail: a repo with >1000 open issues in one milestone is
    // not this loop's use case); undercounting past that would only delay the stop condition,
    // never fire it early.
    const out = await this.gh([
      "issue",
      "list",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--milestone",
      milestone,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      "1000",
    ]);
    const issues = JSON.parse(out) as { number: number }[];
    return issues.length;
  }

  async listMilestoneTitles(): Promise<string[]> {
    // state=all: a closed milestone is a valid (instantly-complete) stop target. per_page=100 —
    // ponytail: >100 milestones in one repo is not this loop's use case; validation would only
    // false-reject, visibly, at startup.
    const out = await this.gh(["api", `repos/${this.cfg.board.owner}/${this.repo()}/milestones?state=all&per_page=100`]);
    const milestones = JSON.parse(out) as { title: string }[];
    return milestones.map((m) => m.title);
  }

  async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    const project = await this.fetchProject();
    return selectPlanReviewCandidates(project, this.cfg);
  }

  /** #214: see IForge.getPoolEligibleIssues' doc — one fetchProject read, one selector. */
  async getPoolEligibleIssues(): Promise<Issue[]> {
    const project = await this.fetchProject();
    return selectPoolEligibleIssues(project, this.cfg);
  }

  async getIssueLabels(issue: number): Promise<string[]> {
    const out = await this.gh(["issue", "view", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--json", "labels"]);
    return parseIssueLabels(out);
  }

  /** #398: see IForge.getPRLabels' doc. Same `labels` JSON shape as the issue read, so
   *  `parseIssueLabels` parses it unchanged. */
  async getPRLabels(pr: number): Promise<string[]> {
    const out = await this.gh(["pr", "view", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--json", "labels"]);
    return parseIssueLabels(out);
  }

  async getIssueComments(issue: number): Promise<PRComment[]> {
    // Same endpoint shape (and pagination discipline) as getPRReviewData's commentsJson fetch
    // — GitHub's REST API serves issue and PR conversation comments off the same
    // `issues/<n>/comments` route, so parsePRComments parses this unchanged.
    const out = await this.gh(["api", `repos/${this.cfg.board.owner}/${this.repo()}/issues/${issue}/comments`, "--paginate", "--slurp"]);
    return parsePRComments(out);
  }

  /** #652: `gh api user` — the authenticated actor's own login, per GitHub's REST identity
   *  endpoint (the same token every other `gh` call in this class already uses). Fails closed to
   *  `null` on ANY error (auth failure, network blip, malformed response) — never throws, per
   *  IForge.getAuthenticatedActor's contract that an unresolvable actor exempts no comment. */
  async getAuthenticatedActor(): Promise<string | null> {
    try {
      const out = await this.gh(["api", "user", "--jq", ".login"]);
      const login = out.trim();
      return login.length > 0 ? login : null;
    } catch {
      return null;
    }
  }

  async createIssue(title: string, body: string): Promise<number> {
    const out = await this.gh(["issue", "create", "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--title", title, "--body", body]);
    const m = out.match(/\/issues\/(\d+)/);
    if (!m) throw new Error(`createIssue: could not parse issue number from: ${out.trim()}`);
    return Number(m[1]);
  }

  async listOpenIssueNumbers(): Promise<number[]> {
    // Same --limit rationale as countOpenIssuesInMilestone: generously above any realistic
    // open-issue count for this loop's use case (ponytail). Shares OPEN_ISSUES_LIMIT with
    // listOpenIssues below rather than a duplicated literal (#415 review) — this method's own
    // behavior for its existing callers is unchanged: it still silently returns whatever `gh`
    // gave it, same as before. Only listIssuesAbsentFromBoard treats a result that hits this
    // exact limit as possibly-truncated (see its own doc).
    const out = await this.gh([
      "issue",
      "list",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--state",
      "open",
      "--json",
      "number",
      "--limit",
      String(OPEN_ISSUES_LIMIT),
    ]);
    const issues = JSON.parse(out) as { number: number }[];
    return issues.map((i) => i.number);
  }

  /** #491: listOpenIssueNumbers plus GitHub's own `projectItems` membership — the ONE read
   *  behind the board-gap report. Deliberately not a per-issue lookup (30 extra API calls every
   *  startup) and not an ignore-list config key: `projectItems` rides along on the list call the
   *  check already made, so multi-board awareness costs one extra JSON field. Needs the same
   *  project read scope `fetchProject` already requires, so it grants nothing new; if that field
   *  is unavailable the call throws and normalizeUnplacedBoardItems' best-effort catch degrades
   *  to a logged skip — the same fail-closed posture as the two truncation guards.
   *
   *  Kept separate from listOpenIssueNumbers rather than widening it: that method is also the
   *  cheap forge reachability probe, and it should stay the cheapest read this forge makes. */
  async listOpenIssuePlacements(): Promise<OpenIssuePlacement[]> {
    const out = await this.gh([
      "issue",
      "list",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--state",
      "open",
      "--json",
      "number,projectItems",
      "--limit",
      String(OPEN_ISSUES_LIMIT),
    ]);
    const issues = JSON.parse(out) as { number: number; projectItems?: unknown[] }[];
    return issues.map((i) => ({ number: i.number, onAnyProject: (i.projectItems ?? []).length > 0 }));
  }

  async listOpenIssues(): Promise<Issue[]> {
    // Keep this separate from listOpenIssueNumbers: that smaller read is also the cheap forge
    // reachability probe, while the PO digest needs richer fields and milestone scoping.
    const out = await this.gh([
      "issue",
      "list",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--state",
      "open",
      "--json",
      "number,title,body,labels,milestone",
      "--limit",
      String(OPEN_ISSUES_LIMIT),
    ]);
    const issues = JSON.parse(out) as Array<{
      number: number;
      title: string;
      body?: string;
      labels: Array<{ name: string }>;
      milestone: { title: string } | null;
    }>;
    if (issues.length === OPEN_ISSUES_LIMIT) {
      throw new Error(`listOpenIssues: backlog read is incomplete (limit ${OPEN_ISSUES_LIMIT})`);
    }
    return issues.map((i) => ({
      number: i.number,
      title: i.title,
      ...(i.body !== undefined ? { body: i.body } : {}),
      labels: i.labels.map((label) => label.name),
      ...(i.milestone ? { milestone: i.milestone.title } : {}),
    }));
  }

  /** #528: see IForge.listRecentlyClosedIssues' doc. Same fields and mapping as listOpenIssues
   *  above (so the same dedup code reads both), with two deliberate differences: `--state closed`
   *  and a hard `--limit` that is the BOUND, not a truncation to detect — so no incompleteness
   *  throw. `sort:updated-desc` (gh's own search qualifier) is what makes the bounded slice the
   *  RECENT tail rather than the oldest N; GitHub's issue list has no closed-at sort, and an
   *  issue's close is an update, so recently-updated is the available proxy for recently-closed.
   *  It can drag in an old issue someone just commented on — a harmless extra dedup candidate,
   *  the failure direction this read should favour. */
  async listRecentlyClosedIssues(): Promise<Issue[]> {
    const out = await this.gh([
      "issue",
      "list",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--state",
      "closed",
      "--search",
      "sort:updated-desc",
      "--json",
      "number,title,body,labels,milestone",
      "--limit",
      String(RECENTLY_CLOSED_ISSUES_LIMIT),
    ]);
    const issues = JSON.parse(out) as Array<{
      number: number;
      title: string;
      body?: string;
      labels: Array<{ name: string }>;
      milestone: { title: string } | null;
    }>;
    return issues.map((i) => ({
      number: i.number,
      title: i.title,
      ...(i.body !== undefined ? { body: i.body } : {}),
      labels: i.labels.map((label) => label.name),
      ...(i.milestone ? { milestone: i.milestone.title } : {}),
    }));
  }

  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    const project = await this.fetchProject();
    return selectPlanTriageCandidates(project, this.cfg);
  }

  async getIssueMeta(issue: number): Promise<IssueMeta> {
    const out = await this.gh([
      "issue",
      "view",
      String(issue),
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--json",
      "number,title,state,labels,updatedAt,milestone",
    ]);
    return parseIssueMeta(out);
  }

  async getIssueRelations(issue: number, cap: number): Promise<IssueRelations> {
    const out = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${ISSUE_RELATIONS_QUERY}`,
      "-f",
      `owner=${this.cfg.board.owner}`,
      "-f",
      `repo=${this.repo()}`,
      "-F",
      `number=${issue}`,
      "-F",
      `cap=${cap}`,
    ]);
    // #234 F2 (PR #252 review, P1, Codex #1): pass this forge's OWN owner/repo as the
    // filter — see parseIssueRelations' doc for why a foreign-repo related node must never
    // reach a session (a cross-referencing issue/PR from a DIFFERENT repo the engine's token
    // can read would otherwise leak that repo's title/labels through this channel).
    return parseIssueRelations(out, cap, `${this.cfg.board.owner}/${this.repo()}`);
  }

  async addSubIssue(parent: number, child: number): Promise<void> {
    const idsOut = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${SUB_ISSUE_IDS_QUERY}`,
      "-f",
      `owner=${this.cfg.board.owner}`,
      "-f",
      `repo=${this.repo()}`,
      "-F",
      `parent=${parent}`,
      "-F",
      `child=${child}`,
    ]);
    const ids = parseSubIssueIds(idsOut, parent, child);
    try {
      const mutationOut = await this.gh([
        "api",
        "graphql",
        "-f",
        `query=${ADD_SUB_ISSUE_MUTATION}`,
        "-f",
        `parentId=${ids.parentId}`,
        "-f",
        `childId=${ids.childId}`,
      ]);
      parseAddSubIssueResponse(mutationOut, ids.parentId, ids.childId);
    } catch (error) {
      if (!isSubIssueAlreadyParentedError(error)) throw error;
      const children = await this.getSubIssues(parent);
      if (children.some((candidate) => candidate.number === child)) return;
      throw error;
    }
  }

  async getSubIssues(parent: number): Promise<SubIssue[]> {
    const children: SubIssue[] = [];
    const seenCursors = new Set<string>();
    let after: string | null = null;
    while (true) {
      const out = await this.gh([
        "api",
        "graphql",
        "-f",
        `query=${SUB_ISSUES_QUERY}`,
        "-f",
        `owner=${this.cfg.board.owner}`,
        "-f",
        `repo=${this.repo()}`,
        "-F",
        `parent=${parent}`,
        // First page: -F passes the literal `null` as JSON null. Later pages: the cursor is
        // an opaque string -> -f (raw), so a number-/bool-looking cursor isn't mistyped by -F.
        ...(after === null ? ["-F", "after=null"] : ["-f", `after=${after}`]),
      ]);
      const page = parseSubIssuesPage(out, parent);
      children.push(...page.children);
      if (!page.hasNextPage) return children;
      if (!page.endCursor) {
        throw new Error(`getSubIssues: response for parent #${parent} has a next page but no end cursor`);
      }
      if (seenCursors.has(page.endCursor)) {
        throw new Error(`getSubIssues: response for parent #${parent} repeated pagination cursor ${page.endCursor}`);
      }
      seenCursors.add(page.endCursor);
      after = page.endCursor;
    }
  }

  async searchIssues(query: string, cap: number): Promise<IssueSearchResult[]> {
    // #234 F1 (PR #252 review, P1, reproduced live): `query` is CALLER-CONTROLLED (a role
    // session's tool argument) and `gh`'s pflag parser treats ANY `--`-prefixed argv token as a
    // flag regardless of its position in the array — a query of `--repo=other/repo` silently
    // escaped the forced repo scope (`--repo` is repeatable; the later, attacker-supplied value
    // won). Every FLAG must precede the query, and the query itself must follow a bare `--`
    // terminator so pflag treats it as a positional argument no matter what it starts with —
    // this is the actual scope enforcement, not merely an argument-ordering nicety.
    const out = await this.gh([
      "search",
      "issues",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--json",
      "number,title,state,labels,updatedAt",
      "--limit",
      String(cap),
      "--",
      query,
    ]);
    return parseSearchIssues(out);
  }

  async getPRDetails(pr: number): Promise<PRDetails> {
    const out = await this.gh([
      "pr",
      "view",
      String(pr),
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      "--json",
      "number,headRefOid,baseRefName,state,isDraft,labels,mergeable",
    ]);
    return parsePRDetails(out);
  }

  async getPRReviews(pr: number, cap: number): Promise<PRReviewsPage> {
    // #244 (Codex sol-high PR #260 review, P1): CAPPED GraphQL `reviews(last: cap)` — never the
    // previous unbounded `gh pr view --json reviews` (a PR with hundreds of reviews would
    // otherwise pull them all into one response). `last` (not `first`) so the cap keeps the MOST
    // RECENT reviews, same fail-toward-inclusion stance as every other capped connection here.
    const out = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${PR_REVIEWS_QUERY}`,
      "-f",
      `owner=${this.cfg.board.owner}`,
      "-f",
      `repo=${this.repo()}`,
      "-F",
      `number=${pr}`,
      "-F",
      `cap=${cap}`,
    ]);
    return parsePRReviewsPage(out);
  }

  async getPRReviewThreads(pr: number, commentsCap: number): Promise<ReviewThreadsPage> {
    return fetchAllReviewThreads((after) =>
      this.gh([
        "api",
        "graphql",
        "-f",
        `query=${PR_REVIEW_THREADS_QUERY}`,
        "-f",
        `owner=${this.cfg.board.owner}`,
        "-f",
        `repo=${this.repo()}`,
        "-F",
        `number=${pr}`,
        "-F",
        `commentsCap=${commentsCap}`,
        // Same -F null / -f cursor split as getPRReviewData's own reviewThreads paging.
        ...(after === null ? ["-F", "after=null"] : ["-f", `after=${after}`]),
      ]),
    );
  }

  async getPRChecks(pr: number, cap: number): Promise<PRChecksPage> {
    // #244 (Codex sol-high PR #260 review, P1): CAPPED GraphQL `contexts(first: cap)` off the
    // head commit's statusCheckRollup — never the previous unbounded `gh pr view --json
    // statusCheckRollup` (a monorepo PR can carry far more than a handful of check runs).
    const out = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${PR_CHECKS_QUERY}`,
      "-f",
      `owner=${this.cfg.board.owner}`,
      "-f",
      `repo=${this.repo()}`,
      "-F",
      `number=${pr}`,
      "-F",
      `cap=${cap}`,
    ]);
    return parsePRChecksPage(out);
  }

  /** #502: the base-branch twin of getPRChecks — see IForge.getDefaultBranchChecks' own doc.
   *  Same CAPPED `contexts(first: cap)` connection, no `number` variable (nothing here is
   *  addressable by PR), and the default branch is whatever GitHub says it is. */
  async getDefaultBranchChecks(cap: number): Promise<BranchChecksPage> {
    const out = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${DEFAULT_BRANCH_CHECKS_QUERY}`,
      "-f",
      `owner=${this.cfg.board.owner}`,
      "-f",
      `repo=${this.repo()}`,
      "-F",
      `cap=${cap}`,
    ]);
    return parseDefaultBranchChecksPage(out);
  }

  /** #247: reply to a review thread — see IForge.replyToReviewThread's doc. `threadId` is an
   *  opaque GraphQL node id (never owner/repo/pr-addressable), so this mutation carries no
   *  `owner`/`repo`/`number` variable at all — the SAME out-of-repo-scope-by-construction shape
   *  the proxy's own tool schemas rely on (no field exists to redirect scope through). */
  async replyToReviewThread(threadId: string, body: string): Promise<void> {
    await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${ADD_REVIEW_THREAD_REPLY_MUTATION}`,
      "-f",
      `threadId=${threadId}`,
      "-f",
      `body=${body}`,
    ]);
  }

  /** #247: resolve a review thread — see IForge.resolveReviewThread's doc. */
  async resolveReviewThread(threadId: string): Promise<void> {
    await this.gh(["api", "graphql", "-f", `query=${RESOLVE_REVIEW_THREAD_MUTATION}`, "-f", `threadId=${threadId}`]);
  }

  /** #247 F2(b): the newest `cap` comment bodies on ONE review thread — see
   *  IForge.getReviewThreadCommentsTail's doc for why this exists as its own read. */
  async getReviewThreadCommentsTail(threadId: string, cap: number): Promise<string[]> {
    const out = await this.gh([
      "api",
      "graphql",
      "-f",
      `query=${REVIEW_THREAD_COMMENTS_TAIL_QUERY}`,
      "-f",
      `threadId=${threadId}`,
      "-F",
      `cap=${cap}`,
    ]);
    return parseReviewThreadCommentsTail(out);
  }

  private repo(): string {
    return this.cfg.board.repo;
  }
}

/** #247: `addPullRequestReviewThreadReply` — posts ONE reply comment on an existing review
 *  thread (distinct from a fresh top-level review; this attaches to the thread's own comment
 *  chain, the same UI surface a human's "Reply" button posts to). See
 *  IForge.replyToReviewThread's doc for the write-boundary rationale. */
export const ADD_REVIEW_THREAD_REPLY_MUTATION = `
mutation($threadId: ID!, $body: String!) {
  addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $threadId, body: $body}) {
    comment { id }
  }
}`;

/** #247: `resolveReviewThread` — marks a thread resolved. See IForge.resolveReviewThread's doc
 *  for why this can never by itself flip a merge verdict. */
export const RESOLVE_REVIEW_THREAD_MUTATION = `
mutation($threadId: ID!) {
  resolveReviewThread(input: {threadId: $threadId}) {
    thread { id isResolved }
  }
}`;

/** #247 F2(b) (Codex sol-high PR #265 review round 2, P1): a review thread's OWN newest `cap`
 *  comments, via GraphQL's `node(id:)` root field (a review thread id is a globally-addressable
 *  node — no PR/owner/repo variable needed at all, same out-of-repo-scope-by-construction shape
 *  ADD_REVIEW_THREAD_REPLY_MUTATION/RESOLVE_REVIEW_THREAD_MUTATION already have). `last: $cap`
 *  (not `first:`) is the point: fix-response.ts's crash-safety marker check needs to see the
 *  reply it JUST posted, which is by definition the NEWEST comment on the thread — the proxy's
 *  own `pr_review_threads` tool fetches `first: cap` for an unrelated reason (issue #244's
 *  default-view completeness contract keeps the OLDEST comments as read context), so it cannot
 *  be reused here without risking exactly the marker-hidden-behind-a-long-thread failure this
 *  query exists to avoid. */
export const REVIEW_THREAD_COMMENTS_TAIL_QUERY = `
query($threadId: ID!, $cap: Int!) {
  node(id: $threadId) {
    ... on PullRequestReviewThread {
      comments(last: $cap) {
        nodes { body }
      }
    }
  }
}`;

/** Parses REVIEW_THREAD_COMMENTS_TAIL_QUERY's response into a plain array of comment bodies,
 *  oldest-of-the-tail-first (GraphQL's own connection order) — malformed/absent shape (a stale
 *  threadId that no longer resolves to a PullRequestReviewThread, say) degrades to an empty
 *  array rather than throwing; the caller (replyAlreadyPosted) treats "no comments visible" the
 *  same as "marker not found", which is the correct, fail-toward-safe reading either way (a
 *  vanished thread can't have posted-then-lost a reply the code just tried to post). */
export function parseReviewThreadCommentsTail(json: string): string[] {
  const d = JSON.parse(json) as { data?: { node?: { comments?: { nodes?: { body?: string }[] } } } };
  const nodes = d.data?.node?.comments?.nodes ?? [];
  return nodes.map((n) => n.body ?? "");
}

// ─────────────────────────────────────────────────────────────────────────────
// ProjectV2 board — pure parse/select helpers (exported for offline testing). The
// GraphQL plumbing above is the only impure part; everything below is deterministic.
// ─────────────────────────────────────────────────────────────────────────────

export interface ProjectItem {
  itemId: string;
  number: number;
  title: string;
  state: string;
  body: string;
  repo: string; // nameWithOwner
  labels: string[];
  status: string | null; // current Status single-select value, if set
  milestone: string | null; // #86: GitHub milestone title, or null if unassigned
}

export interface ParsedProject {
  projectId: string;
  statusFieldId: string;
  options: { name: string; id: string }[];
  items: ProjectItem[];
  placements: BoardPlacement[];
  /** #415 review (Codex sol-high P1): set ONLY on fetchProject's page-ceiling path — true means
   *  `items`/`placements` are a PARTIAL view of the board, not the whole thing. Every existing
   *  consumer of ParsedProject (getReadyIssues, listUnplacedIssues, readStartupReconcileData,
   *  ...) ignores this field, unchanged from before it existed — a partial board read was
   *  already possible pre-#412 and none of them treated it specially. listIssuesAbsentFromBoard
   *  is the one consumer for which a partial view is actively dangerous (a board item that sits
   *  beyond the ceiling would be wrongly reported "absent"), so it is the only reader that
   *  checks this and refuses to report rather than risk a false positive. */
  truncated?: true;
}

export interface BoardPlacement {
  number: number | null;
  repo: string | null;
  status: string | null;
}

export interface OpenPrBody {
  number: number;
  body: string;
  /** #595: the PR's title, from a `--json title` field added to the SAME `gh pr list` read this
   *  shape already comes from — never an extra call. Optional: absent on any pre-#595
   *  fixture/fake, and every consumer (associateLanePr -> a lane's reclaim-* payload) treats a
   *  missing title as "no tooltip" rather than an error. */
  title?: string;
}

export interface StartupReconcileData {
  placements: BoardPlacement[];
  openPrs: OpenPrBody[];
}

export interface UnplacedIssues {
  issues: number[];
  skipped: number;
}

/** #491: one open issue plus whether GitHub lists it as an item of ANY project. `onAnyProject`
 *  comes straight from `gh issue list --json projectItems` — a structured membership signal on
 *  the read the gap check already makes, not an inference from labels or title text. */
export interface OpenIssuePlacement {
  number: number;
  onAnyProject: boolean;
}

/** #491: the startup board-gap verdict. `unplaced` is the actionable list (open, on no project
 *  at all — nobody has triaged it anywhere); `elsewhere` counts issues that are off the
 *  configured board but placed on another one, which a multi-board repo does on purpose and
 *  which must therefore never occupy a row in the report. */
export interface BoardGapReport {
  unplaced: number[];
  elsewhere: number;
}

/** Select only this repo's No-Status issue items for startup normalization. Any named Status
 *  is untouched; draft/non-issue and foreign-repo items are outside this forge's write
 *  jurisdiction and counted for one caller-level log line. */
export function selectUnplacedIssues(items: readonly BoardPlacement[], repoFullName: string): UnplacedIssues {
  const unplaced = items.filter((item) => item.status === null);
  return {
    issues: unplaced.flatMap((item) => (item.number !== null && item.repo === repoFullName ? [item.number] : [])),
    skipped: unplaced.filter((item) => item.number === null || item.repo !== repoFullName).length,
  };
}

/** #412: the No-Status normalizer above answers "is this board item misplaced" — this answers
 *  the strictly earlier question, "is this OPEN issue on the board at all". `placements` is
 *  ANY-status board membership (unlike selectUnplacedIssues' filtered input): an item counts as
 *  "on board" regardless of which lane it's in, No-Status included. Same jurisdiction as
 *  selectUnplacedIssues: a draft item (number null) or a foreign-repo item can never mask (or
 *  falsely stand in for) a real absence.
 *
 *  #491: off the configured board is no longer the same verdict as unplaced. Three classes,
 *  in order — on the configured board (authoritative: `placements`, which is repo-scoped and
 *  lane-complete) is not reported at all; on some OTHER project (`onAnyProject`, GitHub's own
 *  membership field) is counted only; on no project anywhere is the actionable list. */
export function selectIssuesAbsentFromBoard(
  openIssues: readonly OpenIssuePlacement[],
  placements: readonly BoardPlacement[],
  repoFullName: string,
): BoardGapReport {
  const onBoard = new Set(placements.flatMap((item) => (item.number !== null && item.repo === repoFullName ? [item.number] : [])));
  const offBoard = openIssues.filter((issue) => !onBoard.has(issue.number));
  return {
    unplaced: offBoard.filter((issue) => !issue.onAnyProject).map((issue) => issue.number),
    elsewhere: offBoard.filter((issue) => issue.onAnyProject).length,
  };
}

/** The project query. `root` is "user" or "organization" (owner-kind agnostic downstream). */
export function projectQuery(root: "user" | "organization", statusField: string): string {
  return `
query($login: String!, $number: Int!, $after: String) {
  ${root}(login: $login) {
    projectV2(number: $number) {
      id
      field(name: ${JSON.stringify(statusField)}) {
        ... on ProjectV2SingleSelectField { id options { id name } }
      }
      items(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          content {
            ... on Issue {
              number title state body
              repository { nameWithOwner }
              labels(first: 100) { nodes { name } }
              milestone { title }
            }
          }
          # first:100 — an item has at most one value per project field, and GitHub caps a
          # ProjectV2 at ~50 fields, so 100 can't truncate the Status value of a real board
          # (a first:20 could, dropping otherwise-Ready issues). (Codex R3 P2, PR #30.)
          # NB: GraphQL comments are '#', not '//' — '//' here is a syntax error (Codex R5 P1).
          fieldValues(first: 100) {
            nodes {
              ... on ProjectV2ItemFieldSingleSelectValue {
                name
                field { ... on ProjectV2SingleSelectField { name } }
              }
            }
          }
        }
      }
    }
  }
}`;
}

export const BOARD_MUTATION = `
mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: {
    projectId: $projectId, itemId: $itemId, fieldId: $fieldId,
    value: { singleSelectOptionId: $optionId }
  }) { projectV2Item { id } }
}`;

/** #311: resolve both issue-number inputs inside exactly this configured repository. */
export const SUB_ISSUE_IDS_QUERY = `
query($owner: String!, $repo: String!, $parent: Int!, $child: Int!) {
  repository(owner: $owner, name: $repo) {
    parent: issue(number: $parent) { id }
    child: issue(number: $child) { id }
  }
}`;

/** #311: node-id-only mutation. Intentionally omits both `subIssueUrl` (cross-repo escape)
 *  and `replaceParent` (this seam never reparents). */
export const ADD_SUB_ISSUE_MUTATION = `
mutation($parentId: ID!, $childId: ID!) {
  addSubIssue(input: {issueId: $parentId, subIssueId: $childId}) {
    issue { id }
    subIssue { id }
  }
}`;

/** #311: one page of a parent's native sub-issue connection. */
export const SUB_ISSUES_QUERY = `
query($owner: String!, $repo: String!, $parent: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    issue(number: $parent) {
      subIssues(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { number title state }
      }
    }
  }
}`;

export function parseSubIssueIds(json: string, parent: number, child: number): { parentId: string; childId: string } {
  const data = JSON.parse(json) as {
    data?: { repository?: { parent?: { id?: unknown } | null; child?: { id?: unknown } | null } | null };
  };
  const parentId = data.data?.repository?.parent?.id;
  const childId = data.data?.repository?.child?.id;
  if (typeof parentId !== "string" || parentId.length === 0) {
    throw new Error(`addSubIssue: parent issue #${parent} was not found in the configured repository`);
  }
  if (typeof childId !== "string" || childId.length === 0) {
    throw new Error(`addSubIssue: child issue #${child} was not found in the configured repository`);
  }
  return { parentId, childId };
}

function parseAddSubIssueResponse(json: string, parentId: string, childId: string): void {
  let data: {
    data?: { addSubIssue?: { issue?: { id?: unknown } | null; subIssue?: { id?: unknown } | null } | null };
  };
  try {
    data = JSON.parse(json) as typeof data;
  } catch (error) {
    throw new Error("addSubIssue: mutation returned malformed JSON", { cause: error });
  }
  const returnedParentId = data.data?.addSubIssue?.issue?.id;
  const returnedChildId = data.data?.addSubIssue?.subIssue?.id;
  if (returnedParentId !== parentId || returnedChildId !== childId) {
    throw new Error(
      `addSubIssue: mutation response did not confirm the requested relation (expected parent ${parentId} and child ${childId})`,
    );
  }
}

function parseSubIssuesPage(json: string, parent: number): { children: SubIssue[]; hasNextPage: boolean; endCursor: string | null } {
  const data = JSON.parse(json) as {
    data?: {
      repository?: {
        issue?: {
          subIssues?: {
            nodes?: { number?: unknown; title?: unknown; state?: unknown }[] | null;
            pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } | null;
          } | null;
        } | null;
      } | null;
    };
  };
  const issue = data.data?.repository?.issue;
  if (!issue) throw new Error(`getSubIssues: parent issue #${parent} was not found in the configured repository`);
  const connection = issue.subIssues;
  const nodes = connection?.nodes;
  if (!Array.isArray(nodes)) throw new Error(`getSubIssues: malformed subIssues response for parent #${parent}`);
  const children = nodes.map<SubIssue>((node) => {
    if (typeof node.number !== "number" || typeof node.title !== "string" || (node.state !== "OPEN" && node.state !== "CLOSED")) {
      throw new Error(`getSubIssues: malformed child in response for parent #${parent}`);
    }
    return { number: node.number, title: node.title, state: node.state };
  });
  const pageInfo = connection?.pageInfo;
  const hasNextPage = pageInfo?.hasNextPage;
  const endCursor = pageInfo?.endCursor;
  if (pageInfo == null || typeof hasNextPage !== "boolean" || (endCursor !== null && typeof endCursor !== "string")) {
    throw new Error(`getSubIssues: malformed pageInfo response for parent #${parent}`);
  }
  return {
    children,
    hasNextPage: typeof hasNextPage === "boolean" ? hasNextPage : false,
    endCursor: typeof endCursor === "string" ? endCursor : null,
  };
}

export function parseSubIssues(json: string, parent: number): SubIssue[] {
  return parseSubIssuesPage(json, parent).children;
}

function isSubIssueAlreadyParentedError(error: unknown): boolean {
  const value = error as { message?: unknown; stderr?: unknown };
  const text = [value?.message, value?.stderr].filter((part): part is string => typeof part === "string").join("\n");
  return (
    text.includes("Failed to add sub-issue") &&
    text.includes("Issue may not contain duplicate sub-issues") &&
    text.includes("Sub issue may only have one parent")
  );
}

/** Parse the project query response. Owner-kind agnostic: reads data.user ?? data.organization. */
export function parseProject(json: string, statusField: string): ParsedProject {
  const d = JSON.parse(json) as { data?: { user?: unknown; organization?: unknown } };
  const owner = (d.data?.user ?? d.data?.organization) as
    | {
        projectV2?: {
          id: string;
          field?: { id?: string; options?: { id: string; name: string }[] };
          items?: { nodes?: RawItem[] };
        };
      }
    | undefined;
  const proj = owner?.projectV2;
  if (!proj) throw new Error("parseProject: no projectV2 in response (bad owner/number, or missing project scope)");
  const items: ProjectItem[] = (proj.items?.nodes ?? [])
    .filter((n): n is RawItem & { content: NonNullable<RawItem["content"]> } => n?.content?.number != null)
    .map((n) => ({
      itemId: n.id,
      number: n.content.number as number, // narrowed by the filter above
      title: n.content.title ?? "",
      state: n.content.state ?? "",
      body: n.content.body ?? "",
      repo: n.content.repository?.nameWithOwner ?? "",
      labels: (n.content.labels?.nodes ?? []).map((l) => l.name),
      status: statusValue(n, statusField),
      milestone: n.content.milestone?.title ?? null,
    }));
  return {
    projectId: proj.id,
    statusFieldId: proj.field?.id ?? "",
    options: proj.field?.options ?? [],
    items,
    placements: (proj.items?.nodes ?? []).map((n) => ({
      number: n.content?.number ?? null,
      repo: n.content?.repository?.nameWithOwner ?? null,
      status: statusValue(n, statusField),
    })),
  };
}

interface RawItem {
  id: string;
  content?: {
    number?: number;
    title?: string;
    state?: string;
    body?: string;
    repository?: { nameWithOwner?: string };
    labels?: { nodes?: { name: string }[] };
    milestone?: { title?: string } | null;
  };
  fieldValues?: { nodes?: { name?: string; field?: { name?: string } }[] };
}

function statusValue(item: RawItem, statusField: string): string | null {
  for (const fv of item.fieldValues?.nodes ?? []) {
    if (fv.field?.name === statusField && fv.name != null) return fv.name;
  }
  return null;
}

/**
 * Extract every Verification/Acceptance section's raw text from an issue body (Decision #8's
 * plan) — the SAME fail-closed heading match `hasVerificationPlan` uses to gate dispatch,
 * shared here (not duplicated) so gate②'s reviewer trigger (#46, reviewer.ts) carries exactly
 * all sections the `Ready` gate already required to exist. Sections are concatenated in body
 * order. Each runs through (exclusive) the next heading of equal-or-shallower level; a nested
 * matching section is already present in its matching ancestor and is not duplicated. null when
 * no such section exists — callers MUST supply an explicit fallback text, never silently omit
 * the plan (verify:n/a issues have no section and are expected to hit this null).
 */
export function extractVerificationPlan(body: string): string | null {
  const sections = extractMarkdownSections(body, /(verification|acceptance)/);
  return sections.length ? sections.join("\n\n") : null;
}

/** Extract only explicit Verification sections. #310 keeps this distinct from
 * extractVerificationPlan's historical Verification-or-Acceptance compatibility shape:
 * a dispatchable implementation issue needs both checkbox AC and concrete verification steps. */
export function extractVerificationSection(body: string): string | null {
  const sections = extractMarkdownSections(body, /verification/);
  return sections.length ? sections.join("\n\n") : null;
}

/**
 * Extract the agent-filed `Origin:` evidence line from an issue body (#442) — the triggering
 * evidence a role names when IT files an issue (event id(s) / lane / episode / parent issue, or
 * the literal `static scan` when the finding came from repo reading alone). Two facts, two
 * authors: the engine's own round/proposal markers testify to PROCESS provenance and are the
 * machine anchors; this line testifies to EVIDENCE provenance and is human triage prose only.
 *
 * The one engine consumer (align.ts's `validateAlignOutput`) checks the line is PRESENT and
 * never what it SAYS — F15/#423: a role's self-report is exactly the kind of prose that must not
 * become a dedupe or routing key. The engine-wide grep-invariant in align.test.ts pins that.
 *
 * Deliberately a plain line scan, NOT the fence-safe heading walk `extractMarkdownSections`
 * does: the only failure it can produce is a false POSITIVE (an `Origin:` line that happens to
 * sit inside a code fence satisfies the presence check), which costs a human one confusing
 * triage read. Fence-safety would buy a false NEGATIVE instead — a whole valid align batch
 * discarded over formatting — which is strictly worse for a line nothing routes on.
 *
 * Tolerates the emphasis wrapping the shipped template suggests (`_Origin: ..._`,
 * `**Origin:** ...`). null when absent or empty — fail-closed, so a session that skipped the
 * line is rejected rather than credited with unnamed provenance.
 */
export function extractOrigin(body: string): string | null {
  const match = /^[ \t]*(?:[_*]{1,2})?Origin:(.*)$/m.exec(body);
  if (!match) return null;
  const text = match[1]!.replace(/^[_*\s]+/, "").replace(/[_*\s]+$/, "");
  return text === "" ? null : text;
}

/** True if the issue carries a verification plan (Decision #8): verify:n/a label OR a
 *  Verification/Acceptance section in the body. Fail-closed: no signal -> false. */
export function hasVerificationPlan(body: string, labels: string[], verifyNaLabel: string): boolean {
  if (labelsInclude(labels, verifyNaLabel)) return true;
  return extractVerificationPlan(body) != null;
}

/** One parsed checkbox acceptance-criterion (#283, design #279 §5, owner ruling D4): `id` is
 *  ordinal+hash — `<1-based position within THIS extraction>-<8 hex chars of sha256(text)>` —
 *  stable WITHIN one snapshot (the same body, parsed once, always yields the same ids; two
 *  criteria with identical text at different ordinals get different ids via the ordinal
 *  prefix). IDs are NOT stable ACROSS a body edit — that is the point: a later re-extraction
 *  of a CHANGED body is exactly what checkAcSnapshotDrift (ac-snapshot.ts) exists to prevent
 *  from ever happening silently at review time. `text` is the trimmed line content after the
 *  checkbox marker, verbatim. */
export interface AcceptanceCriterion {
  id: string;
  text: string;
}

/** Matches one top-level markdown checkbox list item: `- [ ]`, `- [x]`, `- [X]`, optionally
 *  indented up to 3 spaces (CommonMark's own list-item allowance). Anything else under the
 *  heading (prose, a plain `- bullet` with no checkbox, a sub-bullet nested deeper) is not an
 *  acceptance-criterion line and is silently skipped, not counted. Both the unchecked and
 *  checked forms count as real criteria (#301 review, P2 F5): a checked box is still a genuine,
 *  GitHub-rendered checkbox — the issue templates/prompts recommend `- [ ]` for a fresh issue
 *  (nothing should be pre-checked before dispatch), but the extractor doesn't police that; it
 *  only refuses to invent structure that isn't there. */
const CHECKBOX_LINE = /^ {0,3}-\s\[([ xX])\]\s+(.+)$/;

/** A markdown list marker (checkbox or plain) or a heading — anything matching this ends a
 *  wrapped-continuation run (#301 review, P2 F5): a NEW list item or heading is never folded
 *  into the PREVIOUS criterion's text, even though it isn't itself a checkbox line. */
const NEW_BLOCK_LINE = /^ {0,3}(?:[-*+]|\d+[.)])\s|^#{1,6}\s/;

/**
 * Extract the checkbox acceptance-criteria list from an issue body (#283, design #279 §5, D4):
 * every `- [ ]`/`- [x]` line under the FIRST-MATCHING `## Acceptance criteria`-shaped heading
 * (reuses extractMarkdownSections' fence-safe, nesting-safe heading scan — the SAME engine
 * extractVerificationPlan uses, but scoped to a heading containing the literal words
 * "acceptance criteria" — #301 review, P2 F5: tightened from a bare `/acceptance/` substring,
 * which would have false-matched an unrelated heading like "## Acceptance of risk"; every
 * shipped template uses exactly "Acceptance criteria" so this costs nothing real — so a body
 * with an Acceptance-criteria section and a SEPARATE Verification-plan section never pulls
 * checkbox lines that live only in the latter). A checkbox line's WRAPPED CONTINUATION lines
 * (#301 review, P2 F5: the shipped docs/chore templates themselves wrap one criterion across two
 * physical lines) are folded into that criterion's text: any non-blank line immediately
 * following a checkbox (or another continuation line, with no blank line breaking the run) that
 * is itself neither a checkbox, a new list marker, nor a heading is space-joined onto the
 * PRECEDING criterion. A blank line, a new list item, or a heading ends the continuation run.
 * Returns `null` — never `[]` — for BOTH "no matching heading at all" and "heading present but
 * zero checkbox lines under it": either way the issue carries no honest AC set, and
 * `isDispatchable` below (and plan-review.ts's approve-claim re-check) both treat `null`
 * identically, as "malformed/empty, not dispatchable" for a non-`verify:n/a` issue.
 * Order-preserving; see AcceptanceCriterion's own doc for the id scheme (computed over the FINAL
 * folded text, not just the checkbox's own first line).
 */
export function extractAcceptanceCriteria(body: string): AcceptanceCriterion[] | null {
  const sections = extractMarkdownSections(body, /acceptance\s+criteria/);
  if (sections.length === 0) return null;
  const text = sections.join("\n\n");
  const texts: string[] = [];
  let continuing = false;
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const match = CHECKBOX_LINE.exec(line);
    if (match) {
      texts.push(match[2]!.trim());
      continuing = true;
      continue;
    }
    if (line.trim() === "" || NEW_BLOCK_LINE.test(line)) {
      continuing = false;
      continue;
    }
    if (continuing) {
      texts[texts.length - 1] = `${texts[texts.length - 1]} ${line.trim()}`;
    }
  }
  if (texts.length === 0) return null;
  return texts.map((itemText, index) => ({
    id: `${index + 1}-${createHash("sha256").update(itemText).digest("hex").slice(0, 8)}`,
    text: itemText,
  }));
}

const CLOSING_ISSUE_PREFIX = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\s+#`;
const BARE_ISSUE_PREFIX = `(^|[^0-9])#`;
const ISSUE_NUMBER_END = String.raw`(?!\d)`;

/** The single ambiguous issue a PR body REFERENCES, by prose (closing keyword first, then a lone
 *  bare `#N`). Startup reconciliation (loop/reconcile.ts) is the only consumer: an observability
 *  read that reports "this open PR looks related to that issue" to a human.
 *
 *  #377 deliberately removed the OTHER caller this pair once had — `findOpenPrNumber` /
 *  `GithubForge.findOpenPrForIssue`, which SELECTED a worker lane's PR by the same prose match
 *  and, in the live 2026-07-24 F15 case, handed lane-294 an unrelated retro PR whose body merely
 *  said "#294". Prose is fine for a human-facing hint; it is not an ownership signal. Lane->PR
 *  association is keyed on the structural PR-owner marker below instead — do not reintroduce a
 *  prose match on that path. */
export function referencedIssue(body: string): number | null {
  const closing = [...body.matchAll(new RegExp(`${CLOSING_ISSUE_PREFIX}(\\d+)`, "gi"))].map((match) => Number(match[1]));
  const closingIssues = [...new Set(closing)];
  if (closingIssues.length > 0) return closingIssues.length === 1 ? closingIssues[0]! : null;
  const mentions = [...body.matchAll(new RegExp(`${BARE_ISSUE_PREFIX}(\\d+)${ISSUE_NUMBER_END}`, "g"))].map((match) => Number(match[2]));
  const issues = [...new Set(mentions)];
  return issues.length === 1 ? issues[0]! : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// #377 — PR-OWNER MARKER: a NEW contract, introduced here from scratch. Before this there was
// no engine-authored PR-body marker of any kind (the only PR body the engine ever wrote was
// retro.ts's digest prose). It is NOT an extension of ENGINE_COMMENT_MARKER (that stamps ISSUE
// COMMENTS) and NOT an extension of any prior PR-body convention, because none existed.
//
// WHAT it encodes: which WORKER LANE owns a PR, and for which issue — the on-the-forge
// counterpart to the on-disk lane sentinels (`<lane>.running.json` etc.) that record the same
// identity locally. WHY: a lane's PR decides gate②'s merge target, so it must be selected from a
// signal the engine itself wrote about THIS lane, never from free text an untrusted worker
// happened to type (doctrine: authoritative signals over inferred text).
//
// WHO writes it: the ENGINE only (associateLanePr below — it stamps a PR the worker opened, or
// authors the body itself when it opens the PR). Never a worker-prompt instruction: asking the
// worker's LLM to include the marker would leave the marker as agent-authored prose, carrying
// exactly the omission/malformation risk this contract exists to remove.
//
// NOT a replacement for `Fixes #N`: GitHub's own closing-keyword semantics still belong in the
// human-facing description (and the engine writes one when it authors a body). The marker is for
// engine association only.
//
// RESIDUAL, stated honestly: a worker has `gh` and could paste another lane's marker into a PR
// body it controls. That requires knowing the other lane's random 8-hex suffix (a lane only ever
// learns its OWN name, via its worktree path), and a disagreeing second marker in one body reads
// as null (fail closed) rather than resolving to either lane. This is a narrowing, not a proof.
const PR_OWNER_MARKER_RE = /<!--\s*sapwood:pr-owner\s+lane="([^"]+)"\s+issue="(\d+)"\s*-->/g;
// This is deliberately DISTINCT from PR_OWNER_MARKER_RE: the owner marker is stamped on both
// worker-opened and engine-opened PRs, while this marker records only the latter provenance.
const ENGINE_OPENED_PR_MARKER_RE = /<!--\s*sapwood:pr-engine-opened\s+lane="([^"]+)"\s+issue="(\d+)"\s*-->/g;

/** Lane names are engine-generated (`lane-<issue>-<8 hex>`), so this always passes in practice;
 *  it exists so a name that could NOT be read back verbatim can never be written in the first
 *  place (a marker that doesn't round-trip is worse than no marker — it reads as "owned by
 *  someone" while matching nobody). */
const LANE_NAME_RE = /^[A-Za-z0-9._-]+$/;

/** The marker block itself. Throws on a lane name outside LANE_NAME_RE — see its doc. */
export function prOwnerMarker(lane: string, issue: number): string {
  if (!LANE_NAME_RE.test(lane)) throw new Error(`prOwnerMarker: unusable lane name ${JSON.stringify(lane)}`);
  return `<!-- sapwood:pr-owner lane="${lane}" issue="${issue}" -->`;
}

/** Durable provenance for a PR the engine itself opened. This MUST NOT be added when the engine
 * merely adopts a worker-opened PR: that path gets the owner marker above, but is not truthful
 * evidence for the rescue comment's engine-opened statement. */
export function engineOpenedPrMarker(lane: string, issue: number): string {
  if (!LANE_NAME_RE.test(lane)) throw new Error(`engineOpenedPrMarker: unusable lane name ${JSON.stringify(lane)}`);
  return `<!-- sapwood:pr-engine-opened lane="${lane}" issue="${issue}" -->`;
}

/** Reads the dedicated engine-opened marker back from an already-read PR body. Disagreeing
 * markers fail closed, just as owner-marker disagreement does. */
export function isEngineOpenedPr(body: string, lane: string, issue: number): boolean {
  const found = [...body.matchAll(ENGINE_OPENED_PR_MARKER_RE)].map((m) => ({ lane: m[1]!, issue: Number(m[2]) }));
  return found.length > 0 && found.every((marker) => marker.lane === lane && marker.issue === issue);
}

/** The pure read-back — paired with prOwnerMarker so the written and accepted syntax cannot
 *  drift (the same pairing discipline referencedIssue keeps with its own regex fragments).
 *  Returns null for ANY body without a well-formed marker (prose mentions, closing keywords,
 *  links and code fences citing the issue number are all just text here), and also for a body
 *  carrying two markers that DISAGREE — ambiguous ownership is never guessed. */
export function readPrOwner(body: string): { lane: string; issue: number } | null {
  const found = [...body.matchAll(PR_OWNER_MARKER_RE)].map((m) => ({ lane: m[1]!, issue: Number(m[2]) }));
  if (found.length === 0) return null;
  const first = found[0]!;
  return found.every((f) => f.lane === first.lane && f.issue === first.issue) ? first : null;
}

/** Does this body carry a marker AT ALL? Deliberately a SEPARATE question from readPrOwner's —
 *  that one collapses "no marker" and "markers that disagree" into the same `null`, and a caller
 *  that treats the second as the first would stamp its own marker onto a body whose ownership is
 *  already contested, adopt the PR, and leave every later read still returning null (gate② P1 on
 *  PR #423). Association uses BOTH: readPrOwner to claim a PR, this to refuse one it can't. */
export function hasPrOwnerMarker(body: string): boolean {
  return [...body.matchAll(PR_OWNER_MARKER_RE)].length > 0;
}

/** Appends the marker to a PR body, idempotently — the worker's own description (closing keyword
 *  included) is preserved verbatim above it. */
export function stampPrOwner(body: string, lane: string, issue: number): string {
  const marker = prOwnerMarker(lane, issue);
  return body.includes(marker) ? body : `${body.trimEnd()}\n\n${marker}\n`;
}

/** Marker-only selection over a list of open PRs — the fallback for a lane whose branch is no
 *  longer knowable (its worktree was reclaimed). Several PRs claiming the same lane+issue is
 *  ambiguous -> null, the same fail-closed stance the rest of this file takes on merge targets. */
export function findLaneOwnedPr(prs: readonly OpenPrBody[], lane: string, issue: number): number | null {
  const owned = prs.filter((pr) => {
    const owner = readPrOwner(pr.body);
    return owner !== null && owner.lane === lane && owner.issue === issue;
  });
  return owned.length === 1 ? owned[0]!.number : null;
}

/** The forge surface associateLanePr needs. Deliberately NOT folded into IForge — same rationale
 *  the deleted findOpenPrForIssue wiring carried: every fake forge in this repo's tests
 *  implements IForge, and this association path is only ever wired to the real GithubForge
 *  (cli.ts duck-types it and degrades to "no association" otherwise). */
export interface LanePrForge {
  listOpenPrsForBranch(branch: string): Promise<OpenPrBody[]>;
  listOpenPrBodies(): Promise<OpenPrBody[]>;
  updatePRBody(pr: number, body: string): Promise<void>;
  openPR(branch: string, title: string, body: string): Promise<number>;
  /** #377 round 4: the TRI-STATE read, not IForge's lossy `branchExists` boolean — a check that
   *  failed must not read as "nothing was pushed" on this path. */
  probePushedBranch(branch: string): Promise<BranchProbe>;
  getIssueMeta(issue: number): Promise<Pick<IssueMeta, "title">>;
}

export interface LanePrRequest {
  /** The lane name — the same one the on-disk sentinels use. */
  name: string;
  issue: number;
  /** The lane worktree's own current branch, read from its git HEAD (worker.ts's laneBranch), or
   *  null when unknowable (worktree gone, detached HEAD). */
  branch: string | null;
  /** Is the lane's session over — by EITHER structural signal, a terminal sentinel or a
   *  confirmed-dead wrapper (see worker.ts's probe())? This gates EVERY engine-authored WRITE on
   *  this path, both opening a PR and stamping an existing one (gate② round 5):
   *
   *   - Opening one mid-run would race the worker's own `gh pr create`.
   *   - Stamping one mid-run is an unconditional read-modify-write against a body snapshot from
   *     the preceding list call; GitHub offers no conditional PR-body update, so a worker or
   *     human editing the description in between would silently lose those edits.
   *
   *  READS are never gated: a PR that already carries this lane's marker associates at any time.
   *  Because no write can fail before the session ends, the inconclusive-retry budget also
   *  cannot be spent during a phase where the conductor would only ever classify the lane
   *  KEEP — the exact exhaustion the round-5 review flagged. */
  sessionOver: boolean;
}

/** What associateLanePr concluded. The two fields answer DIFFERENT questions, and the caller
 *  (worker.ts's probe -> the conductor's reclaim) needs both:
 *
 *  - `pr`: the lane's PR, when one was conclusively identified.
 *  - `inconclusive`: a forge WRITE this association depended on FAILED (openPR, or the marker
 *    stamp), so the answer is UNKNOWN — not "this lane has no PR". That distinction is
 *    load-bearing (gate② round 3, P1): `sessionOver` only ever becomes true on the very probe the
 *    conductor SETTLES the lane from, so collapsing a transient 502 into a definitive `null`
 *    escalated finished work to a human, or requeued a dead lane onto a FRESH worker while its
 *    pushed branch sat there — with no later probe to correct either. An inconclusive answer is
 *    retried on a later tick instead of being settled.
 *
 *  A definitive refusal (branch not pushed, another lane's marker, a contested body, not yet
 *  allowed to open one) is `{ pr: null, inconclusive: false }` — a real answer about the world,
 *  with nothing to retry. */
export interface LanePrOutcome {
  pr: number | null;
  inconclusive: boolean;
  /** #595: the resolved PR's title, when the read that found it (listOpenPrsForBranch,
   *  listOpenPrBodies, or the title the engine itself opened the PR with) carried one. Never a
   *  new forge call — see OpenPrBody.title. Optional: absent when `pr` is null, or when the
   *  underlying forge response had no title. worker.ts's probe() carries this onto
   *  LaneProbe.prTitle, which conductor.ts's reclaim events persist. */
  title?: string;
  /** True only when the engine itself opened `pr` from the lane's already-pushed branch. */
  engineOpened?: boolean;
}

/**
 * #377: resolve a worker lane to ITS OWN PR. Two structural signals, in order — the lane
 * worktree's branch (which PR was opened off the code this lane actually produced), then the
 * engine-authored owner marker. Never prose.
 *
 *  1. Branch known -> the open PR(s) off that head.
 *     a. one carries THIS lane's marker -> that's the PR.
 *     b. the branch has exactly ONE open PR and it carries NO marker at all -> the engine stamps
 *        it (engine-authored write) and adopts it. The branch is this lane's own worktree HEAD,
 *        so head-identity is the evidence; the stamp makes the association survive the
 *        worktree's deletion.
 *     c. anything else -> no association. That covers another lane's marker, SEVERAL candidates
 *        (even when only one of them is unmarked), and a body whose own markers disagree
 *        (contested, NOT unmarked). No such PR is ever adopted or re-stamped.
 *  2. No PR off the branch, the branch IS on the forge, and the lane's session has ended -> the
 *     engine opens the PR itself (the retro.ts:406 precedent) with the marker in the body it
 *     authors.
 *  3. Otherwise -> marker scan across open PRs (covers a reclaimed worktree).
 *
 * FAIL DIRECTION: no association (null) rather than a guessed one. A lane whose PR can't be
 * identified escalates to a human (conductor's ESCALATE_NOPR) — the F15 failure, by contrast,
 * silently drove a stranger's PR through review.
 *
 * A forge WRITE that fails (403, network) degrades visibly through `log` and yields an
 * INCONCLUSIVE outcome — never a definitive "no PR" (see LanePrOutcome), and never a throw out
 * of the caller's probe() that would wedge the tick.
 */
export async function associateLanePr(forge: LanePrForge, lane: LanePrRequest, log?: (message: string) => void): Promise<LanePrOutcome> {
  const say = (message: string): void => log?.(`[sapwood:forge] lane ${lane.name}: ${message}`);
  /** A real answer about the world: nothing to retry. */
  const refuse = (message: string): LanePrOutcome => {
    say(message);
    return { pr: null, inconclusive: false };
  };
  /** A forge write failed: the answer is UNKNOWN, so the caller must retry rather than settle. */
  const unknown = (message: string): LanePrOutcome => {
    say(message);
    return { pr: null, inconclusive: true };
  };
  if (lane.branch) {
    const candidates = await forge.listOpenPrsForBranch(lane.branch);
    const owned = findLaneOwnedPr(candidates, lane.name, lane.issue);
    if (owned != null) {
      // #719: both title AND engine-opened provenance ride this SAME candidates list — no
      // re-fetch after a crash between openPR and the rescue-reason comment.
      const candidate = candidates.find((c) => c.number === owned);
      const title = candidate?.title;
      const engineOpened = candidate !== undefined && isEngineOpenedPr(candidate.body, lane.name, lane.issue);
      return {
        pr: owned,
        inconclusive: false,
        ...(title !== undefined ? { title } : {}),
        ...(engineOpened ? { engineOpened: true } : {}),
      };
    }
    // Stamp-and-adopt is eligible ONLY for a branch with exactly ONE open PR that carries no
    // marker at all. Both halves of that are load-bearing (gate② P1s on PR #423):
    //  - ONE candidate: an unmarked PR sitting alongside a marker-bearing one used to qualify by
    //    filtering to the unmarked subset, which adopted a merge target against direct evidence
    //    that another lane already claims this head — and made the refusal below unreachable.
    //  - NO marker AT ALL (`hasPrOwnerMarker`, never `readPrOwner(...) === null`): a body whose
    //    markers DISAGREE is contested, not unmarked, and stamping a third marker onto it would
    //    leave every later read still returning null.
    const sole = candidates.length === 1 ? candidates[0]! : null;
    if (sole && !hasPrOwnerMarker(sole.body)) {
      // The lane's own branch, one PR, no marker — ours to claim, but only once nothing is left
      // that could be editing that body concurrently (see LanePrRequest.sessionOver).
      if (!lane.sessionOver) {
        return refuse(`branch ${lane.branch}'s sole PR #${sole.number} is unmarked — deferring the stamp until the session ends`);
      }
      const pr = sole;
      try {
        await forge.updatePRBody(pr.number, stampPrOwner(pr.body, lane.name, lane.issue));
      } catch (e) {
        return unknown(`could not stamp the owner marker on PR #${pr.number} (${String(e)}) — association UNKNOWN, retried later`);
      }
      // #595: `pr` (== `sole`) already carries its own title from the SAME candidates list.
      return { pr: pr.number, inconclusive: false, ...(pr.title !== undefined ? { title: pr.title } : {}) };
    }
    if (candidates.length > 0) {
      return refuse(
        `branch ${lane.branch} has ${candidates.length} open PR(s), none claimable by this lane ` +
          `(another lane's marker, contested markers, or several candidates) — not adopting any`,
      );
    }
    if (lane.sessionOver) {
      // A branch check that FAILED is not a branch that is ABSENT (gate② round 4): only GitHub's
      // own 404 is evidence that nothing was pushed. Anything else leaves the answer unknown, so
      // the lane is retried rather than settled with its pushed work unPRed.
      const pushed = await forge.probePushedBranch(lane.branch);
      if (pushed === "unknown") {
        return unknown(`could not verify whether ${lane.branch} is pushed — association UNKNOWN, retried later`);
      }
      if (pushed === "present") {
        try {
          const title = await forge.getIssueMeta(lane.issue).then((m) => m.title);
          const opened = await forge.openPR(lane.branch, title, engineAuthoredPrBody(lane.name, lane.issue, lane.branch));
          // #595: the PR the engine just opened carries the title it opened WITH — no re-read.
          return { pr: opened, inconclusive: false, title, engineOpened: true };
        } catch (e) {
          return unknown(`could not open a PR for pushed branch ${lane.branch} (${String(e)}) — branch preserved, retried later`);
        }
      }
    }
  }
  // #595/#719: the marker-scan fallback's title and engine-opened provenance ride this SAME
  // listOpenPrBodies read; a reclaimed worktree must not create a second read or lose provenance.
  const bodies = await forge.listOpenPrBodies();
  const marked = findLaneOwnedPr(bodies, lane.name, lane.issue);
  const markedPr = marked != null ? bodies.find((b) => b.number === marked) : undefined;
  const markedTitle = markedPr?.title;
  const engineOpened = markedPr !== undefined && isEngineOpenedPr(markedPr.body, lane.name, lane.issue);
  return {
    pr: marked,
    inconclusive: false,
    ...(markedTitle !== undefined ? { title: markedTitle } : {}),
    ...(engineOpened ? { engineOpened: true } : {}),
  };
}

/** The body the engine writes when IT opens a lane's PR. Carries the human-facing closing keyword,
 * owner marker, and dedicated engine-opened marker; the latter lets restart association recover
 * that fact without a new forge read. */
function engineAuthoredPrBody(lane: string, issue: number, branch: string): string {
  return [
    `Closes #${issue}`,
    "",
    `Opened by the sapwood engine: lane \`${lane}\` pushed \`${branch}\` but ended without opening a PR itself.`,
    "The commits are the worker's; this description is the engine's.",
    "",
    prOwnerMarker(lane, issue),
    engineOpenedPrMarker(lane, issue),
    "",
  ].join("\n");
}

type ReadyCfg = {
  board: { owner: string; repo: string; statusField: string; status: { ready: string } };
  // #397: `planless` is optional here for the same reason `decomposed` is — a hand-built ReadyCfg
  // in a test predates it; a real cfg always resolves it.
  labels: { verifyNa: string; planApproved: string; needsHuman: string; blocked: string; decomposed?: string; planless?: string };
};

/** #397 class 6: the routing fence decompose's remainder path and align's no-plan path apply. It
 *  is NOT an escalation — nobody owes a decision on it — but it must stay off exactly the queues
 *  `needsHuman` kept it off, or renaming it would silently widen pool/triage/review exposure.
 *  Every predicate that excludes on `needsHuman`/`blocked` calls this too. */
function isPlanless(labels: string[], l: ReadyCfg["labels"]): boolean {
  return l.planless !== undefined && labelsInclude(labels, l.planless);
}

function isDecomposed(labels: string[], l: ReadyCfg["labels"]): boolean {
  return l.decomposed !== undefined && labelsInclude(labels, l.decomposed);
}

/**
 * gate⓪ (#88, amending Decision #8 per #77's 2026-07-09 comment): a verification plan must
 * pass agent quality review before dispatch, not merely exist. `needsHuman`/`blocked` block
 * unconditionally regardless of any other label — the fail-closed floor under both dispatch
 * paths below:
 *
 *  - `verifyNa` present (and `needsHuman` already ruled out) -> the doc-gate path. A human has
 *    effectively adjudicated this: the verification-plan-reviewer peripheral only ever proposes `verifyNa`
 *    paired WITH `needsHuman` in the same action, so `verifyNa` alone means a human accepted
 *    it by removing `needsHuman` themselves.
 *  - otherwise -> dispatchable only if a verification-plan section exists in the body AND
 *    `planApproved` is present (applied by the verification-plan-reviewer peripheral, never by this gate).
 *    Presence alone (pre-#88 behavior) is no longer sufficient.
 *
 * Reuses `extractVerificationPlan` directly rather than `hasVerificationPlan` — the latter's
 * OR-the-two-conditions-together semantics ("has a plan, in either sense") no longer matches
 * gate⓪'s dispatch rule (verifyNa's doc-gate path and a reviewed plan's path are now stricter
 * and mutually exclusive); `hasVerificationPlan` remains exported/tested unchanged as a
 * standalone "does a plan exist in some form" helper for any other caller.
 *
 * #283 (M10, E2, design #279 §5, D4): a non-`verifyNa` issue additionally requires a
 * non-malformed, non-empty checkbox acceptance-criteria set (`extractAcceptanceCriteria(body)
 * != null`) — the AC authority every per-AC verdict downstream (the future engine-agent
 * reviewer, design #279 §5) is snapshotted from at dispatch time. A `verifyNa` issue is NOT
 * held to this — the doc-gate path is for inherently unverifiable work, which has no
 * checkbox-shaped AC set by design.
 */
function isDispatchable(body: string, labels: string[], l: ReadyCfg["labels"]): boolean {
  if (isDecomposed(labels, l)) return false;
  if (labelsInclude(labels, l.needsHuman) || labelsInclude(labels, l.blocked)) return false;
  // #94 Codex retro-review P2: BOTH dispatch-path labels on one issue is a state the
  // verification-plan-reviewer prompt forbids ("never apply both") — it can only arise from a stale or
  // manual label mutation. Fail closed BEFORE the verifyNa early-true below: a mixed-label
  // issue must not slip through the doc-gate path (which skips the red/green cycle); it waits
  // for a human to remove one of the two labels.
  if (labelsInclude(labels, l.verifyNa) && labelsInclude(labels, l.planApproved)) return false;
  if (labelsInclude(labels, l.verifyNa)) return true;
  return (
    extractVerificationPlan(body) != null &&
    extractVerificationSection(body) != null &&
    extractAcceptanceCriteria(body) != null &&
    labelsInclude(labels, l.planApproved)
  );
}

/** Ready-lane + OPEN + this repo + gate⓪-dispatchable (#88). The dispatch work-queue. */
export function selectReadyIssues(project: ParsedProject, cfg: ReadyCfg): Issue[] {
  const fullName = `${cfg.board.owner}/${cfg.board.repo}`;
  return project.items
    .filter((it) => it.repo === fullName)
    .filter((it) => it.state === "OPEN")
    .filter((it) => it.status === cfg.board.status.ready)
    .filter((it) => isDispatchable(it.body, it.labels, cfg.labels))
    .map((it) => ({
      number: it.number,
      title: it.title,
      labels: it.labels,
      body: it.body,
      // exactOptionalPropertyTypes: an optional field must be OMITTED, not set to explicit
      // undefined — only include the key when there's a real milestone title.
      ...(it.milestone != null ? { milestone: it.milestone } : {}),
    }));
}

/** #87: true when an issue still needs a gate⓪ plan-review pass — the `plan_review`
 *  peripheral's candidate test. `needsHuman`/`blocked` are settled states (a human is already
 *  in the loop, or must act first) — never re-reviewed. `verifyNa` is the doc-gate path, a
 *  DIFFERENT dispatch route than plan-review's; an issue that already carries it needs no plan
 *  review (whether or not `needsHuman` also accompanies it, per the verification-plan-reviewer's own
 *  outcome-3 contract). The forbidden verifyNa+planApproved MIXED state (#94 Codex retro P2)
 *  is likewise not a review candidate: it needs a human label CLEANUP, not another session —
 *  isDispatchable already fail-closes it out of dispatch, and dispatching a reviewer at it
 *  would burn a session on a state the prompt forbids it to resolve (it may never remove
 *  labels). The verifyNa check below covers it explicitly by construction. Otherwise: needs
 *  review unless already `planApproved`. */
function needsPlanReview(labels: string[], l: ReadyCfg["labels"]): boolean {
  if (isDecomposed(labels, l)) return false;
  if (labelsInclude(labels, l.needsHuman) || labelsInclude(labels, l.blocked)) return false;
  if (isPlanless(labels, l)) return false; // #397: same exclusion this fence had while it borrowed needsHuman
  if (labelsInclude(labels, l.verifyNa)) return false; // doc-gate path OR the mixed state — neither is reviewable
  return !labelsInclude(labels, l.planApproved);
}

/** Ready-lane + OPEN + this repo + still awaiting gate⓪ plan review (#87). The plan_review
 *  peripheral's candidate set — a DIFFERENT (and disjoint at completion) query from
 *  selectReadyIssues, which returns the opposite: issues that have ALREADY passed gate⓪. */
export function selectPlanReviewCandidates(project: ParsedProject, cfg: ReadyCfg): Issue[] {
  const fullName = `${cfg.board.owner}/${cfg.board.repo}`;
  return project.items
    .filter((it) => it.repo === fullName)
    .filter((it) => it.state === "OPEN")
    .filter((it) => it.status === cfg.board.status.ready)
    .filter((it) => needsPlanReview(it.labels, cfg.labels))
    .map((it) => ({
      number: it.number,
      title: it.title,
      labels: it.labels,
      body: it.body,
      ...(it.milestone != null ? { milestone: it.milestone } : {}),
    }));
}

/** #214 gate② review (P2): LITERALLY "Ready lane minus holds" — NOT the isDispatchable ∪
 *  needsPlanReview union an earlier draft of this predicate used. That union has a gap: an
 *  issue that carries `plan:approved` but whose verification-plan SECTION was later deleted
 *  from the body satisfies neither isDispatchable (its body check fails — no plan text) nor
 *  needsPlanReview (its label check fails — planApproved is present) — so it would carry no
 *  hold label, yet could never re-enter a pool, never get confirmed, never get repaired:
 *  permanently and invisibly stranded. This predicate is body-independent by design: OPEN +
 *  Ready status + NOT needsHuman + NOT blocked + NOT the forbidden verifyNa+planApproved mixed
 *  state (#94 — kept excluded: that state needs a human cleanup, not another session, same
 *  stance as selectReadyIssues/selectPlanReviewCandidates). The DESIRABLE consequence: the
 *  approved-but-planless orphan above is now pool-eligible, enters the pool, routes to class 2
 *  (plan-review.ts's confirmOneIssue, since it still carries plan:approved), whose session reads
 *  a plan-less body and invalidates it, which feeds the ordinary draft cycle that repairs it —
 *  the exact self-healing loop #214 exists to build, reached automatically rather than requiring
 *  a special case. */
function isPoolEligible(labels: string[], l: ReadyCfg["labels"]): boolean {
  if (isDecomposed(labels, l)) return false;
  if (labelsInclude(labels, l.needsHuman) || labelsInclude(labels, l.blocked)) return false;
  if (isPlanless(labels, l)) return false; // #397: same exclusion this fence had while it borrowed needsHuman
  if (labelsInclude(labels, l.verifyNa) && labelsInclude(labels, l.planApproved)) return false;
  return true;
}

/** Ready-lane + OPEN + this repo + pool-eligible (#214: Ready lane minus holds — see
 *  isPoolEligible's doc for why this is a body-independent label check, not a dispatchability
 *  union). The round pool's candidate source — see IForge.getPoolEligibleIssues' doc for the
 *  deadlock this widening avoids and what stays narrow (executing-phase dispatch). */
export function selectPoolEligibleIssues(project: ParsedProject, cfg: ReadyCfg): Issue[] {
  const fullName = `${cfg.board.owner}/${cfg.board.repo}`;
  return project.items
    .filter((it) => it.repo === fullName)
    .filter((it) => it.state === "OPEN")
    .filter((it) => it.status === cfg.board.status.ready)
    .filter((it) => isPoolEligible(it.labels, cfg.labels))
    .map((it) => ({
      number: it.number,
      title: it.title,
      labels: it.labels,
      body: it.body,
      ...(it.milestone != null ? { milestone: it.milestone } : {}),
    }));
}

/** #89: true when an OPEN issue still lacks a verification plan and isn't already a settled
 *  human state — the PO/triage peripheral's candidate test. Unlike needsPlanReview, this does
 *  NOT gate on board Status (triage runs on any open issue, Ready or not — it exists so a
 *  plan-less issue already carries one BEFORE a human ever moves it to Ready). `verifyNa`
 *  issues are excluded (the doc-gate path; no plan is expected). `needsHuman`/`blocked` are
 *  excluded (settled — a human is already in the loop, not a drafting target). An issue that
 *  already has SOME plan section is excluded too — triage's whole job is to fill the gap, not
 *  to re-draft an existing plan (that quality judgment belongs to gate⓪'s verification-plan-reviewer). */
function needsPlanTriage(body: string, labels: string[], l: ReadyCfg["labels"]): boolean {
  if (isDecomposed(labels, l)) return false;
  if (labelsInclude(labels, l.needsHuman) || labelsInclude(labels, l.blocked)) return false;
  if (isPlanless(labels, l)) return false; // #397: same exclusion this fence had while it borrowed needsHuman
  if (labelsInclude(labels, l.verifyNa)) return false;
  return extractVerificationPlan(body) == null;
}

/** OPEN + this repo + still lacking a verification plan (#89). The PO/triage peripheral's
 *  candidate set — deliberately NOT scoped to the Ready lane (see needsPlanTriage above). */
export function selectPlanTriageCandidates(project: ParsedProject, cfg: ReadyCfg): Issue[] {
  const fullName = `${cfg.board.owner}/${cfg.board.repo}`;
  return project.items
    .filter((it) => it.repo === fullName)
    .filter((it) => it.state === "OPEN")
    .filter((it) => needsPlanTriage(it.body, it.labels, cfg.labels))
    .map((it) => ({
      number: it.number,
      title: it.title,
      labels: it.labels,
      body: it.body,
      ...(it.milestone != null ? { milestone: it.milestone } : {}),
    }));
}

/** Pure parse of `gh issue view --json labels` (#87). A missing/empty `labels` array or
 *  entries without a usable name degrade to [] — but malformed JSON THROWS (JSON.parse),
 *  deliberately fail-closed: gh emitting non-JSON means the read itself failed, and the
 *  plan-review orchestrator must surface that rather than treat it as "no labels" (which
 *  would mis-route an already-approved issue back into review). */
export function parseIssueLabels(json: string): string[] {
  const parsed = JSON.parse(json) as { labels?: { name?: string }[] };
  return (parsed.labels ?? []).map((l) => l.name ?? "").filter((n) => n.length > 0);
}

export function findOptionId(project: ParsedProject, name: string): string | undefined {
  return project.options.find((o) => o.name === name)?.id;
}

/** Item id for an issue. Scoped by full `owner/repo` when given — board items are unique by
 *  (repo, number), and a /repo suffix would also match a foreign `other/repo` (Codex R2 P1). */
export function findItemId(project: ParsedProject, issue: number, repoFullName?: string): string | undefined {
  return project.items.find((it) => it.number === issue && (repoFullName === undefined || it.repo === repoFullName))?.itemId;
}

/** Items-connection page cursor. Owner-kind agnostic; absent pageInfo -> terminal. */
export function parsePageInfo(json: string): { hasNextPage: boolean; endCursor: string | null } {
  const d = JSON.parse(json) as { data?: { user?: unknown; organization?: unknown } };
  const owner = (d.data?.user ?? d.data?.organization) as
    | { projectV2?: { items?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } } } }
    | undefined;
  const pi = owner?.projectV2?.items?.pageInfo;
  return { hasNextPage: pi?.hasNextPage ?? false, endCursor: pi?.endCursor ?? null };
}

/** Pure parse of `gh pr view --json ...` output. Exported for offline testing. */
export function parsePRStatus(json: string): PRStatus {
  const d = JSON.parse(json) as {
    number: number;
    headRefOid: string;
    // #595: additive — absent on any pre-#595 fixture (see PRStatus.title's own doc).
    title?: string;
    // #287 (E4b): additive — absent on any pre-#287 fixture (see PRStatus.baseOid's own doc).
    baseRefOid?: string;
    state: string;
    mergeable: string;
    // CheckRun entries carry `conclusion`; legacy commit StatusContext entries carry
    // `state` and no `conclusion`. The rollup can mix both.
    statusCheckRollup?: { conclusion?: string | null; state?: string | null }[];
  };
  const checks = d.statusCheckRollup ?? [];
  // FAIL CLOSED: green only when there is >=1 check AND every check CONCLUSIVELY PASSED.
  // An EMPTY rollup is NOT green — on a fresh/just-pushed PR, checks may not be created yet,
  // so empty != "this repo has no CI". A null/absent conclusion on a CheckRun means
  // queued/in-progress (not green); StatusContext entries (no conclusion) pass on
  // state==SUCCESS.
  // ponytail: genuinely CI-less repos get an explicit `ci.requireChecks: false` opt-in
  // when the merge gate is wired (M3), not a silent empty-means-green default.
  // (Codex P1/P2, PR #22.)
  //
  // #401 (F26), adjudicating the deferral recorded in design #279 §4 / §9: SKIPPED and NEUTRAL
  // used to count as passing here, so a workflow whose test job never RAN (path filter, `if:`
  // guard, a required job skipped by a bad matrix) read as gate①-green and could merge with zero
  // execution evidence. They are completed-but-not-executed, not passing — the CONCLUSION half of
  // the stance review/ci-evidence.ts's requiredChecksSatisfied takes on the engine-agent path,
  // now applied gate①-wide.
  //
  // The legacy `state === "SUCCESS"` fallback below is DELIBERATELY KEPT and is READJUDICATED,
  // not a documented deviation: #401's AC named two directions ("conclusion === SUCCESS only" or
  // app-bound evidence), and PR #422's review twice read the retained legacy path as a third one.
  // The repo owner adjudicated it on 2026-07-29 (PR #422, supervising session): dispute ACCEPTED,
  // the AC's SUCCESS-only requirement is scoped to CHECKRUN CONCLUSIONS, and the legacy
  // status-context path stays. Reasoning upheld there, and why it is not a third path:
  // requiredChecksSatisfied rejects a legacy commit StatusContext
  // for a reason that is specific to `ci.requiredChecks` — a status context carries no check
  // suite, so its owning App cannot be verified against a configured `{name, app}` pair
  // (docs/security.md "CI execution evidence for engine-agent review" scopes that rejection to
  // that chain, not to gate①). Gate① is the general "did this repo's CI pass" signal for EVERY
  // reviewer mode, and the Status API has no SKIPPED/NEUTRAL concept at all (states are
  // error|failure|pending|success), so the hole this change closes cannot exist on that path.
  // Dropping it would leave every repo whose CI reports via the Status API (Jenkins, Buildkite,
  // classic CircleCI) unable to EVER reach gate①-green — a permanent wedge, the same F26 class
  // #401 exists to remove. Repos wanting the app-bound, forge-resistant evidence boundary opt in
  // via `ci.requiredChecks`; that is the mechanism for it, and it is unchanged here.
  // Direction chosen: narrow this predicate, NOT adopt requiredChecksSatisfied at the merge gate
  // — that function is fail-closed on an EMPTY `ci.requiredChecks` (the default), so making it
  // gate① would wedge every repo that has not configured a required-check list, and it needs
  // per-check `name`/`appSlug` this `gh pr view --json statusCheckRollup` call does not fetch.
  // Compatibility: a repo that legitimately skips jobs on some PRs (path-filtered workflows) now
  // stays not-green instead of merging — see docs/configuration.md `ci` for the adjustment path
  // (make the job always run and skip its STEPS, so it reports SUCCESS). NOT routed to `ciRed`
  // below: a skipped job is not a failure, and a mechanical CI-fix leg cannot fix one.
  const ciGreen = checks.length > 0 && checks.every((c) => (c.conclusion != null ? c.conclusion === "SUCCESS" : c.state === "SUCCESS"));
  // #246: a completed, non-passing conclusion/state — deliberately NARROWER than "not passing"
  // (which would also match CANCELLED/ACTION_REQUIRED/STALE, ambiguous states a mechanical fix
  // leg shouldn't be dispatched against). An empty rollup is never red (checks.length > 0
  // required) — no checks reported yet is "still pending", the same fail-closed-to-not-green
  // stance ciGreen already takes, not a failure signal.
  const FAILING = new Set(["FAILURE", "TIMED_OUT", "STARTUP_FAILURE", "ERROR"]);
  const ciRed =
    checks.length > 0 &&
    checks.some((c) => (c.conclusion != null ? FAILING.has(c.conclusion) : c.state === "FAILURE" || c.state === "ERROR"));
  return {
    number: d.number,
    headOid: d.headRefOid,
    state: d.state as PRStatus["state"],
    mergeable: d.mergeable === "MERGEABLE" || d.mergeable === "CONFLICTING" ? d.mergeable : "UNKNOWN",
    ciGreen,
    ciRed,
    ...(d.baseRefOid !== undefined ? { baseOid: d.baseRefOid } : {}),
    ...(d.title !== undefined ? { title: d.title } : {}),
  };
}

/** #449 gate② P1 fix: shared per-entry validation between `parsePRChangedFiles` (a page-array of
 *  entries) and `parseCompareChangedFiles` (one compare object's `.files` array) — same
 *  fail-closed shape, same rename provenance (`previous_filename`), different top-level envelope.
 *  `context` names the calling parser in a thrown message so a malformed-entry error is
 *  attributable at a glance. */
function mapChangedFileEntries(entries: readonly unknown[], context: string): PRChangedFile[] {
  return entries.map((entry, index) => {
    if (entry === null || typeof entry !== "object") throw new Error(`${context}: entry ${index} is not an object`);
    const value = entry as { filename?: unknown; previous_filename?: unknown };
    if (typeof value.filename !== "string" || value.filename.length === 0) {
      throw new Error(`${context}: entry ${index} has no filename`);
    }
    if (value.previous_filename !== undefined && typeof value.previous_filename !== "string") {
      throw new Error(`${context}: entry ${index} has an invalid previous_filename`);
    }
    return {
      filename: value.filename,
      ...(value.previous_filename !== undefined ? { previousFilename: value.previous_filename } : {}),
    };
  });
}

/**
 * #292: parse every paginated pull-file entry without dropping rename provenance. Accepts the
 * `gh api --paginate --slurp` page-array shape (and a single flat page for focused tests), and
 * rejects malformed entries fail-closed rather than treating an incomplete path list as safe.
 */
export function parsePRChangedFiles(json: string): PRChangedFile[] {
  const raw: unknown = JSON.parse(json);
  if (!Array.isArray(raw)) throw new Error("getPRChangedFiles: expected an array");
  const entries: unknown[] = raw.every(Array.isArray) ? raw.flat() : raw;
  return mapChangedFileEntries(entries, "getPRChangedFiles");
}

/** #449 gate② P1 fix: the compare endpoint's top-level shape is ONE object carrying a `files`
 *  array (not the bare array `parsePRChangedFiles` expects) — no `--paginate --slurp` page-array
 *  wrapping applies here (see `compareChangedFiles`'s own doc). An absent `files` field is a
 *  legitimate "zero changes between these two commits" answer (e.g. `base === head`), not a
 *  parse error. */
export function parseCompareChangedFiles(json: string): PRChangedFile[] {
  const raw: unknown = JSON.parse(json);
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("compareChangedFiles: expected an object");
  const files = (raw as { files?: unknown }).files;
  if (files === undefined) return [];
  if (!Array.isArray(files)) throw new Error("compareChangedFiles: files is not an array");
  return mapChangedFileEntries(files, "compareChangedFiles");
}

// ─────────────────────────────────────────────────────────────────────────────
// Review-gate data (#13 reviewer.ts / merge-driver.ts). Pure parse + assembly; the only
// impure part is GithubForge.getPRReviewData's 3 gh calls above.
// ─────────────────────────────────────────────────────────────────────────────

// #378 (F14): the node selection carries the thread's SPAN, GitHub's own staleness field, and the
// thread's ORIGINATING comment on top of the `isResolved` flag the unresolved COUNT needs.
// Rationale: gate② used to see nothing but an aggregate count, so an already-adjudicated,
// thread-resolved finding re-raised as a NEW thread on the same unchanged lines was
// indistinguishable from a genuinely fresh one (PR #366: the same config-YAML finding
// re-consumed five fix-round evaluations). `comments(first: 1)` is the comment that RAISED the
// finding — its body identifies WHICH finding this thread is about (span alone does not, see
// findingDigest) and its `commit.oid` is the code state the finding was raised against.
export const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          path
          line
          originalLine
          comments(first: 1) { nodes { body commit { oid } } }
        }
      }
    }
  }
}`;

/**
 * #378 (F14): one review thread reduced to exactly what gate② needs to tell an ALREADY-ADJUDICATED
 * finding from a fresh one — see reviewer.ts's adjudication filter, the only consumer.
 *
 *  - `isOutdated` is GitHub's OWN authoritative field: true when this thread's diff position no
 *    longer exists in the PR's current diff, i.e. the span it targeted has changed since the
 *    thread was written. Preferring it over a locally-computed content hash follows this repo's
 *    "authoritative signals over inferred text" doctrine — it is a provider-computed status
 *    field, not a heuristic over prose. Absent from an older/malformed response it degrades to
 *    `true` (see parseReviewThreadsPage): the two failure directions are NOT symmetric — reading
 *    a stale span as unchanged would let a REAL finding be filtered out of gate② input, while
 *    reading an unchanged span as stale merely costs one duplicate fix-round evaluation, exactly
 *    the (bounded) waste this issue set out to reduce.
 *  - `path`/`line`/`originalLine` are the span itself. `line` is null once a thread goes
 *    outdated (GitHub drops the current-diff position), which is why `originalLine` is carried
 *    alongside rather than instead.
 *  - `findingDigest` identifies WHICH finding the thread is about (see findingDigest). A span
 *    alone does NOT: two entirely unrelated findings can land on the same file:line, and keying
 *    adjudication on the span alone would let the second, never-adjudicated one be silently
 *    treated as a duplicate of the first — a REAL finding dropped from gate② input. null when
 *    the thread has no readable originating comment, which makes it unkeyable and therefore
 *    never filterable.
 *  - `anchorCommitOid` is the commit the thread's ORIGINATING comment was left against — the
 *    state of the code the finding was raised, and subsequently adjudicated, against. Note this
 *    is NOT literally a "resolving commit": GitHub's `PullRequestReviewThread` exposes no such
 *    field at all (`resolvedBy` is a User, not a commit), so this is deliberately named for what
 *    it actually is and used for audit / logging; the load-bearing staleness decision binds to
 *    `isOutdated`, not to this oid.
 */
export interface ReviewThreadSpan {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  originalLine: number | null;
  findingDigest: string | null;
  anchorCommitOid: string | null;
}

/**
 * #378 (F14): a stable fingerprint of a review finding's TEXT, for deciding whether two threads
 * are about the same finding. Empty/whitespace-only -> null (unkeyable, never matchable).
 *
 * This is deliberately the narrowest comparison that still works. There is no structured finding
 * identity to bind to — a review bot emits prose, not a typed event with a rule id — so per this
 * repo's authoritative-signals doctrine this is a last-resort text comparison, and the doctrine's
 * requirement is to keep it narrow and name which failure direction it favours. Normalization is
 * whitespace-runs only: no case folding, no punctuation stripping, no fuzzy/substring matching.
 *
 * The two directions are not symmetric. A too-WIDE comparison collapses two distinct findings
 * into one and drops a real, never-adjudicated finding out of gate② input — a silent gate
 * weakening, the worst outcome available here. A too-NARROW comparison merely fails to recognize
 * a re-raise that was reworded, so the duplicate keeps blocking and costs one more fix-round
 * evaluation — exactly the bounded waste #378 set out to reduce, never a suppressed finding.
 * Every widening trades toward the first. Whitespace collapsing is included only because a
 * markdown re-wrap of byte-identical prose is not a different finding by any reading.
 */
export function findingDigest(body: string | null | undefined): string | null {
  const normalized = (body ?? "").trim().replace(/\s+/g, " ");
  return normalized === "" ? null : createHash("sha256").update(normalized).digest("hex");
}

/** One page of the reviewThreads connection: unresolved count + this page's threads + cursor.
 *  Absent/malformed pageInfo -> terminal (no infinite loop on a bad response); absent per-thread
 *  fields degrade field-by-field (see ReviewThreadSpan) rather than dropping the thread. */
export function parseReviewThreadsPage(json: string): {
  unresolved: number;
  threads: ReviewThreadSpan[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const d = JSON.parse(json) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: {
              id?: string;
              isResolved: boolean;
              isOutdated?: boolean;
              path?: string | null;
              line?: number | null;
              originalLine?: number | null;
              comments?: { nodes?: { body?: string | null; commit?: { oid?: string } }[] };
            }[];
          };
        };
      };
    };
  };
  const conn = d.data?.repository?.pullRequest?.reviewThreads;
  const nodes = conn?.nodes ?? [];
  return {
    unresolved: nodes.filter((n) => !n.isResolved).length,
    threads: nodes.map((n) => {
      const origin = n.comments?.nodes?.[0];
      return {
        id: n.id ?? "",
        isResolved: n.isResolved ?? false,
        // Fail-closed (see ReviewThreadSpan): unknown staleness reads as "the span moved", which
        // can only ever keep a finding in gate② input, never remove one from it.
        isOutdated: n.isOutdated ?? true,
        path: n.path ?? null,
        line: n.line ?? null,
        originalLine: n.originalLine ?? null,
        // Absent body -> null digest -> unkeyable -> never filterable. Same fail-closed shape.
        findingDigest: findingDigest(origin?.body),
        anchorCommitOid: origin?.commit?.oid ?? null,
      };
    }),
    hasNextPage: conn?.pageInfo?.hasNextPage ?? false,
    endCursor: conn?.pageInfo?.endCursor ?? null,
  };
}

/**
 * Every review thread across the WHOLE connection, paging to exhaustion (Codex PR #42 P2: a
 * first-100 fetch with all first-page threads resolved would report 0 findings while an
 * unresolved thread sits on page 2 — a fail-open in gate②). Same pattern + page ceiling as
 * fetchProject's items paging. `fetchPage` is injected so the loop is testable offline.
 * Returns the unresolved TOTAL alongside the threads so gate②'s existing count and #378's
 * per-thread adjudication data come from ONE pass over ONE query, never two round trips.
 */
export async function collectReviewThreads(
  fetchPage: (after: string | null) => Promise<string>,
  // #438: fired exactly once, and only when the page ceiling below actually stopped the loop —
  // an additive optional param because this function only ever sees a `fetchPage` closure and so
  // has no PR context of its own to name. The one production caller (getPRReviewData) does, and
  // announces from there. Existing callers pass nothing and are unaffected.
  onPageCeiling?: (partial: { unresolved: number; threads: number }) => void,
): Promise<{ unresolved: number; threads: ReviewThreadSpan[] }> {
  let unresolved = 0;
  const threads: ReviewThreadSpan[] = [];
  let after: string | null = null;
  // ponytail: hard page ceiling (50 pages = 5000 threads) so a cursor bug can't spin forever.
  for (let page = 0; page < 50; page++) {
    const p = parseReviewThreadsPage(await fetchPage(after));
    unresolved += p.unresolved;
    threads.push(...p.threads);
    if (!p.hasNextPage || !p.endCursor) return { unresolved, threads };
    after = p.endCursor;
  }
  // page ceiling hit; return what we counted rather than loop unbounded — but say so first, since
  // an under-count here reads to gate② as "fewer unresolved findings", i.e. fails OPEN.
  onPageCeiling?.({ unresolved, threads: threads.length });
  return { unresolved, threads };
}

/** The unresolved-count-only view of collectReviewThreads — gate②'s original (pre-#378) read. */
export async function countUnresolvedThreads(fetchPage: (after: string | null) => Promise<string>): Promise<number> {
  return (await collectReviewThreads(fetchPage)).unresolved;
}

/** Pure parse of `gh pr view --json headRefOid,author,updatedAt,isDraft,labels,state,reviews`.
 *  No commit-date plumbing here (see PR #55 P1-B): a commit's own committedDate is NOT tied to
 *  when it became the PR's head — forgeable via GIT_COMMITTER_DATE / cherry-picks, and (worse)
 *  didn't move on a later push, so a stale 👍 could out-live a legitimate re-trigger. The
 *  thumb-verdict freshness pin now lives in engine State (workers.review_triggered_head/at,
 *  set by MergeDriver.driveOne the instant it posts a fresh trigger) — reviewer.ts. */
export function parsePRReviewView(json: string): {
  headOid: string;
  author: string;
  updatedAt: string;
  isDraft: boolean;
  labels: string[];
  state: PRStatus["state"];
  reviews: PRReview[];
} {
  const d = JSON.parse(json) as {
    headRefOid: string;
    author?: { login?: string };
    updatedAt: string;
    isDraft: boolean;
    labels?: { name: string }[];
    state: string;
    reviews?: { author?: { login?: string }; commit?: { oid?: string }; state: string; submittedAt?: string }[];
  };
  return {
    headOid: d.headRefOid,
    author: d.author?.login ?? "",
    updatedAt: d.updatedAt,
    isDraft: d.isDraft,
    labels: (d.labels ?? []).map((l) => l.name),
    state: d.state as PRStatus["state"],
    reviews: (d.reviews ?? []).map((r) => ({
      author: r.author?.login ?? "",
      commitOid: r.commit?.oid ?? "",
      state: r.state,
      // #147 P1: submittedAt rides the same `--json reviews` payload gh already returns — no
      // new gh call. Left undefined when absent (fail-closed at the re-entry filter).
      ...(r.submittedAt !== undefined ? { submittedAt: r.submittedAt } : {}),
    })),
  };
}

/** Pure parse of `gh api .../issues/<pr>/reactions --paginate --slurp`. `--paginate` alone
 *  emits ONE JSON document PER PAGE — a single JSON.parse throws on any PR whose reactions
 *  span pages, wedging the merge gate at "queued" forever (Codex PR #42 P2). `--slurp` wraps
 *  the pages in one array; accept both that (array-of-page-arrays) and the legacy single
 *  flat array so pre-slurp fixtures/callers keep parsing. */
export function parsePRReactions(json: string): PRReaction[] {
  type Raw = { content: string; created_at: string; user?: { login?: string } };
  const parsed = JSON.parse(json) as Raw[] | Raw[][];
  const arr = parsed.flatMap((p) => (Array.isArray(p) ? p : [p]));
  return arr.map((r) => ({ content: r.content, createdAt: r.created_at, login: r.user?.login ?? "" }));
}

/** Assemble the raw gh responses into one PRReviewData. `unresolvedThreads` arrives as an
 *  already-paged total (countUnresolvedThreads) — never a single-page count. Exported for
 *  offline testing; GithubForge.getPRReviewData is the only impure caller. */
/** Pure parse of `gh api .../issues/<pr>/comments --paginate --slurp` (same page shapes as
 *  parsePRReactions). Malformed/missing fields degrade to ""/empty — never a throw. */
export function parsePRComments(json: string): PRComment[] {
  type Raw = { id?: number | string; body?: string; created_at?: string; user?: { login?: string } };
  const parsed = JSON.parse(json) as Raw[] | Raw[][];
  const arr = parsed.flatMap((p) => (Array.isArray(p) ? p : [p]));
  return arr.map((c) => ({
    login: c.user?.login ?? "",
    createdAt: c.created_at ?? "",
    body: c.body ?? "",
    ...(c.id != null ? { id: String(c.id) } : {}),
  }));
}

/** Pure parse of `gh api .../commits?since=... --paginate --slurp` (same page-shape convention
 *  as parsePRComments above). `author` prefers the linked GitHub login (`author.login` — present
 *  when the commit's email matches a GitHub account); falls back to the raw git author name
 *  (`commit.author.name`) for an unlinked/unknown-account commit, same as never for an empty
 *  string. Malformed/missing fields degrade to ""  — never a throw. */
export function parseCommitsSince(json: string): CommitInfo[] {
  type Raw = {
    sha?: string;
    commit?: { message?: string; author?: { name?: string; date?: string } };
    author?: { login?: string } | null;
  };
  const parsed = JSON.parse(json) as Raw[] | Raw[][];
  const arr = parsed.flatMap((p) => (Array.isArray(p) ? p : [p]));
  return arr.map((c) => ({
    sha: c.sha ?? "",
    message: c.commit?.message ?? "",
    author: c.author?.login ?? c.commit?.author?.name ?? "",
    date: c.commit?.author?.date ?? "",
  }));
}

export function assemblePRReviewData(
  viewJson: string,
  reactionsJson: string,
  unresolvedThreads: number,
  commentsJson = "[]",
  threads?: ReviewThreadSpan[],
): PRReviewData {
  const view = parsePRReviewView(viewJson);
  return {
    threads,
    headOid: view.headOid,
    author: view.author,
    updatedAt: view.updatedAt,
    isDraft: view.isDraft,
    labels: view.labels,
    state: view.state,
    reviews: view.reviews,
    reactions: parsePRReactions(reactionsJson),
    comments: parsePRComments(commentsJson),
    unresolvedThreads,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// #234: forge MCP proxy read surface — pure parsers for the 3 new IForge methods above. Same
// impure-gh-call/pure-parse split as everywhere else in this file.
// ─────────────────────────────────────────────────────────────────────────────

/** Pure parse of `gh issue view --json number,title,state,labels,updatedAt,milestone`. */
export function parseIssueMeta(json: string): IssueMeta {
  const d = JSON.parse(json) as {
    number: number;
    title: string;
    state: string;
    labels?: { name: string }[];
    updatedAt: string;
    milestone: { title: string } | null;
  };
  return {
    number: d.number,
    title: d.title,
    // #485: MERGED counts as CLOSED — a blocked-by:N whose N resolved as a merged PR-linked
    // reference is no longer blocking anything. Deliberately an ENUMERATED match, not
    // `!== "OPEN"`: an unrecognized/garbled state must keep reading OPEN, so the blocked-by
    // reconcile's fail-direction stays "leave the label on" rather than "unblock on noise".
    state: d.state === "CLOSED" || d.state === "MERGED" ? "CLOSED" : "OPEN",
    labels: (d.labels ?? []).map((l) => l.name),
    updatedAt: d.updatedAt,
    ...(d.milestone ? { milestone: d.milestone.title } : {}),
  };
}

/** The relations query (#234) — verified against the live GitHub GraphQL schema, see
 *  IForge.getIssueRelations' doc. `includeClosedPrs: true` on closedByPullRequestsReferences:
 *  a PR that closed this issue and was later itself closed/merged is still a real relation,
 *  never silently dropped. `timelineItems` covers both directions GitHub tracks natively:
 *  CROSS_REFERENCED_EVENT (another issue/PR's body/comment mentioned this one) and
 *  CONNECTED_EVENT (an explicit "linked issue" connection, distinct from the closing-PR case
 *  above). `repository { nameWithOwner }` on every related node (#234 F2, PR #252 review, P1,
 *  Codex #1 — verified live, herehigher/sapwood#217): a cross-reference can legitimately
 *  originate from a DIFFERENT repository the engine's `gh` token happens to be able to read
 *  (any repo the operator has access to) — without this field, parseIssueRelations has no way
 *  to tell a same-repo relation from a foreign one, and that foreign repo's issue/PR title +
 *  labels would leak to a credential-free session through this channel (and, via issue_details'
 *  default view, even further). This field is the filter's ONLY input; see parseIssueRelations. */
export const ISSUE_RELATIONS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cap: Int!) {
  repository(owner: $owner, name: $repo) {
    issue(number: $number) {
      closedByPullRequestsReferences(first: $cap, includeClosedPrs: true) {
        nodes { number title state repository { nameWithOwner } labels(first: 20) { nodes { name } } }
      }
      timelineItems(first: $cap, itemTypes: [CROSS_REFERENCED_EVENT, CONNECTED_EVENT]) {
        nodes {
          __typename
          ... on CrossReferencedEvent {
            source {
              __typename
              ... on Issue { number title state repository { nameWithOwner } labels(first: 20) { nodes { name } } }
              ... on PullRequest { number title state repository { nameWithOwner } labels(first: 20) { nodes { name } } }
            }
          }
          ... on ConnectedEvent {
            subject {
              __typename
              ... on Issue { number title state repository { nameWithOwner } labels(first: 20) { nodes { name } } }
              ... on PullRequest { number title state repository { nameWithOwner } labels(first: 20) { nodes { name } } }
            }
          }
        }
      }
    }
  }
}`;

/** Pure parse of the ISSUE_RELATIONS_QUERY response. `expectedRepoFullName` (`owner/repo`) is
 *  REQUIRED and enforced: any related node (linked PR OR cross-reference/connection, whichever
 *  shape) whose `repository.nameWithOwner` does not match it — including a node with NO
 *  repository field at all, a malformed/partial response — is DROPPED, never returned (#234 F2,
 *  PR #252 review, P1, Codex #1: fail-closed on ambiguity, same stance as this file's other
 *  scope-boundary parsers, e.g. selectReadyIssues' own repo filter). The comparison is
 *  CASE-INSENSITIVE (#234 F2b, PR #252 review round 2, P2, Codex): GitHub's own casing for
 *  `nameWithOwner` need not match whatever casing an operator happened to type into
 *  `board.owner`/`board.repo` in config — a naive exact-match would silently drop EVERY
 *  same-repo relation whenever the two disagree only in case, an availability regression, not a
 *  security fix (the fail-closed stance is about WHICH repo, not letter case). Malformed/missing
 *  fields beyond that degrade to empty connections — never a throw (same tolerance as every
 *  other GraphQL parser in this file); a genuinely failed gh call still throws upstream of this
 *  (JSON.parse on non-JSON stderr text). */
export function parseIssueRelations(json: string, cap: number, expectedRepoFullName: string): IssueRelations {
  type LabelNode = { labels?: { nodes?: { name: string }[] } };
  type RepoNode = { repository?: { nameWithOwner?: string } };
  type RefNode = { __typename?: string; number?: number; title?: string; state?: string } & LabelNode & RepoNode;
  type TimelineNode = { __typename?: string; source?: RefNode; subject?: RefNode };
  const labelsOf = (n: LabelNode): string[] => (n.labels?.nodes ?? []).map((l) => l.name);
  const expectedRepoLower = expectedRepoFullName.toLowerCase();
  const sameRepo = (n: RepoNode): boolean => n.repository?.nameWithOwner?.toLowerCase() === expectedRepoLower;
  const d = JSON.parse(json) as {
    data?: {
      repository?: {
        issue?: {
          closedByPullRequestsReferences?: { nodes?: ({ number: number; title: string; state: string } & LabelNode & RepoNode)[] };
          timelineItems?: { nodes?: TimelineNode[] };
        };
      };
    };
  };
  const issue = d.data?.repository?.issue;
  const rawLinkedPRs = issue?.closedByPullRequestsReferences?.nodes ?? [];
  const linkedPRs: RelatedRef[] = rawLinkedPRs.filter(sameRepo).map((n) => ({
    number: n.number,
    title: n.title,
    state: n.state,
    labels: labelsOf(n),
    kind: "pr" as const,
  }));
  const rawTimelineNodes = issue?.timelineItems?.nodes ?? [];
  const crossReferences: RelatedRef[] = [];
  for (const n of rawTimelineNodes) {
    const ref = n.source ?? n.subject;
    if (!ref || ref.number == null) continue;
    if (!sameRepo(ref)) continue; // #234 F2: a foreign-repo cross-reference is never surfaced
    crossReferences.push({
      number: ref.number,
      title: ref.title ?? "",
      state: ref.state ?? "",
      labels: labelsOf(ref),
      kind: ref.__typename === "PullRequest" ? "pr" : "issue",
    });
  }
  // Truncation is judged against the RAW (pre-filter) node counts — GraphQL's `first: cap`
  // hitting the cap means more items MAY exist beyond the fetched window, regardless of how
  // many of the fetched ones were then dropped as foreign-repo (#234 F2): under-reporting
  // truncation because a filter shrank the visible count would be the wrong fail direction.
  return { linkedPRs, crossReferences, truncated: rawLinkedPRs.length >= cap || rawTimelineNodes.length >= cap };
}

/** Pure parse of `gh search issues ... --json number,title,state,labels,updatedAt`. */
export function parseSearchIssues(json: string): IssueSearchResult[] {
  const parsed = JSON.parse(json) as { number: number; title: string; state: string; labels?: { name: string }[]; updatedAt: string }[];
  return parsed.map((i) => ({
    number: i.number,
    title: i.title,
    state: i.state,
    labels: (i.labels ?? []).map((l) => l.name),
    updatedAt: i.updatedAt,
  }));
}

// ─────────────────────────────────────────────────────────────────────────────
// #244: PR-facing forge MCP proxy read surface (extends #234) — pure parsers + the 4 new
// IForge methods above. Same impure-gh-call/pure-parse split as everywhere else in this file.
// ─────────────────────────────────────────────────────────────────────────────

/** Pure parse of `gh pr view --json number,headRefOid,baseRefName,state,isDraft,labels,mergeable`. */
export function parsePRDetails(json: string): PRDetails {
  const d = JSON.parse(json) as {
    number: number;
    headRefOid: string;
    baseRefName?: string;
    state: string;
    isDraft: boolean;
    labels?: { name: string }[];
    mergeable: string;
  };
  return {
    number: d.number,
    headOid: d.headRefOid,
    baseRefName: typeof d.baseRefName === "string" ? d.baseRefName : "",
    state: d.state === "CLOSED" || d.state === "MERGED" ? d.state : "OPEN",
    draft: d.isDraft,
    labels: (d.labels ?? []).map((l) => l.name),
    mergeable: d.mergeable === "MERGEABLE" || d.mergeable === "CONFLICTING" ? d.mergeable : "UNKNOWN",
  };
}

/** #244 (Codex sol-high PR #260 review, P1): the CAPPED reviews query — `reviews(last: $cap)`
 *  keeps the MOST RECENT `cap` reviews (never `first`, which would keep the OLDEST — the same
 *  fail-toward-inclusion stance every other capped connection in this file takes), plus the
 *  connection's own `totalCount` so the proxy layer can report an honest `complete` flag without
 *  a second call. Replaces the previous unbounded `gh pr view --json reviews` read. */
export const PR_REVIEWS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cap: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviews(last: $cap) {
        totalCount
        nodes { author { login } commit { oid } state body submittedAt }
      }
    }
  }
}`;

/** Pure parse of PR_REVIEWS_QUERY. A missing `body` degrades to "" — same tolerance as every
 *  other optional string field in this file, never a throw. */
export function parsePRReviewsPage(json: string): PRReviewsPage {
  const d = JSON.parse(json) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviews?: {
            totalCount?: number;
            nodes?: { author?: { login?: string }; commit?: { oid?: string }; state: string; body?: string; submittedAt?: string }[];
          };
        };
      };
    };
  };
  const conn = d.data?.repository?.pullRequest?.reviews;
  const reviews: PRReviewItem[] = (conn?.nodes ?? []).map((r) => ({
    author: r.author?.login ?? "",
    commitOid: r.commit?.oid ?? "",
    state: r.state,
    body: r.body ?? "",
    ...(r.submittedAt !== undefined ? { submittedAt: r.submittedAt } : {}),
  }));
  return { reviews, total: conn?.totalCount ?? reviews.length };
}

/** #288: bounded top-level PR conversation read. `last` keeps the newest audit marker during
 *  dedup/reconciliation and prevents an old, busy PR from creating an unbounded response. */
export const PR_COMMENTS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cap: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(last: $cap) {
        totalCount
        nodes { id author { login } createdAt body }
      }
    }
  }
}`;

export function parsePRCommentsPage(json: string): PRCommentsPage {
  const d = JSON.parse(json) as {
    data?: {
      repository?: {
        pullRequest?: {
          comments?: {
            totalCount?: number;
            nodes?: Array<{ id?: string; author?: { login?: string }; createdAt?: string; body?: string }>;
          };
        };
      };
    };
  };
  const conn = d.data?.repository?.pullRequest?.comments;
  const comments = (conn?.nodes ?? []).map((c) => ({
    id: c.id ?? "",
    login: c.author?.login ?? "",
    createdAt: c.createdAt ?? "",
    body: c.body ?? "",
  }));
  return { comments, total: conn?.totalCount ?? comments.length };
}

/** #244 (Codex sol-high PR #260 review, P1): the CAPPED checks query — reads the PR's HEAD
 *  commit's `statusCheckRollup.contexts(first: $cap)`, plus the sub-connection's own
 *  `totalCount`. Replaces the previous unbounded `gh pr view --json statusCheckRollup` read.
 *  `contexts` is a union of `CheckRun` (modern) and `StatusContext` (legacy commit status) — both
 *  inline fragments requested, mirroring parsePRStatus's own dual-shape tolerance. */
export const PR_CHECKS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $cap: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: $cap) {
                totalCount
                nodes {
                  __typename
                  ... on CheckRun { name status conclusion checkSuite { app { slug } } }
                  ... on StatusContext { context state }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

/** Pure parse of PR_CHECKS_QUERY. A legacy StatusContext node (`context` instead of `name`, no
 *  `conclusion`) falls back to `context` for the name field — same dual-shape tolerance
 *  parsePRStatus already has for the REST rollup shape. #287 (E4b, design #279 §4 R3): each
 *  CheckRun node's `checkSuite.app.slug` becomes `PRCheckItem.appSlug` — absent/null for a
 *  StatusContext node (no check-suite concept), never guessed. */
export function parsePRChecksPage(json: string): PRChecksPage {
  const d = JSON.parse(json) as {
    data?: {
      repository?: {
        pullRequest?: {
          commits?: {
            nodes?: {
              commit?: {
                statusCheckRollup?: {
                  contexts?: {
                    totalCount?: number;
                    nodes?: {
                      name?: string;
                      context?: string;
                      status?: string;
                      conclusion?: string | null;
                      state?: string | null;
                      checkSuite?: { app?: { slug?: string | null } | null } | null;
                    }[];
                  };
                } | null;
              };
            }[];
          };
        };
      };
    };
  };
  const conn = d.data?.repository?.pullRequest?.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts;
  const checks: PRCheckItem[] = (conn?.nodes ?? []).map((c) => ({
    name: c.name ?? c.context ?? "",
    status: c.status ?? "",
    conclusion: c.conclusion ?? null,
    state: c.state ?? null,
    appSlug: c.checkSuite?.app?.slug ?? null,
  }));
  return { checks, total: conn?.totalCount ?? checks.length };
}

/** #502: the BASE-BRANCH twin of PR_CHECKS_QUERY — the same capped `contexts(first: $cap)` read
 *  off a commit's `statusCheckRollup`, keyed on the repository's DEFAULT BRANCH ref instead of a
 *  PR number. The branch is resolved by GitHub (`defaultBranchRef`), never configured here: a
 *  base-branch name in sapwood config would be a second source of truth for a fact the forge
 *  already owns. */
export const DEFAULT_BRANCH_CHECKS_QUERY = `
query($owner: String!, $repo: String!, $cap: Int!) {
  repository(owner: $owner, name: $repo) {
    defaultBranchRef {
      name
      target {
        ... on Commit {
          oid
          statusCheckRollup {
            contexts(first: $cap) {
              totalCount
              nodes {
                __typename
                ... on CheckRun { name status conclusion checkSuite { app { slug } } }
                ... on StatusContext { context state }
              }
            }
          }
        }
      }
    }
  }
}`;

/** Pure parse of DEFAULT_BRANCH_CHECKS_QUERY — the same node mapping parsePRChecksPage uses (a
 *  legacy StatusContext falls back to `context` for the name and carries no app slug). EVERY
 *  absent level degrades to an EMPTY page rather than throwing: a repo with no default branch, a
 *  non-Commit ref target, or a commit with no rollup at all are all "no evidence", and #502's
 *  consumer reads no-evidence as NOT-base-red. Fabricating a red from a missing field is the one
 *  failure direction this parse must never take. */
export function parseDefaultBranchChecksPage(json: string): BranchChecksPage {
  const d = JSON.parse(json) as {
    data?: {
      repository?: {
        defaultBranchRef?: {
          name?: string;
          target?: {
            oid?: string;
            statusCheckRollup?: {
              contexts?: {
                totalCount?: number;
                nodes?: {
                  name?: string;
                  context?: string;
                  status?: string;
                  conclusion?: string | null;
                  state?: string | null;
                  checkSuite?: { app?: { slug?: string | null } | null } | null;
                }[];
              };
            } | null;
          } | null;
        } | null;
      };
    };
  };
  const ref = d.data?.repository?.defaultBranchRef;
  const conn = ref?.target?.statusCheckRollup?.contexts;
  const checks: PRCheckItem[] = (conn?.nodes ?? []).map((c) => ({
    name: c.name ?? c.context ?? "",
    status: c.status ?? "",
    conclusion: c.conclusion ?? null,
    state: c.state ?? null,
    appSlug: c.checkSuite?.app?.slug ?? null,
  }));
  return { branch: ref?.name ?? "", headOid: ref?.target?.oid ?? "", checks, total: conn?.totalCount ?? checks.length };
}

/** #244: the review-threads-WITH-COMMENTS query — extends REVIEW_THREADS_QUERY (which only
 *  needs `isResolved` for the unresolved COUNT gate②'s reviewer.ts consumes) with each thread's
 *  own comment bodies, for the proxy's `pr_review_threads` tool. `commentsCap` bounds the
 *  PER-THREAD comments sub-connection (`comments(first: $commentsCap)`) — a config-driven cap
 *  (ProxyCaps.maxCommentsPerThread), never hardcoded. `totalCount`/`pageInfo` on that same
 *  sub-connection (Codex sol-high PR #260 review, P1) let parsePRReviewThreadsPage derive a
 *  per-thread `commentsComplete` flag, so a thread whose OWN comments exceed `commentsCap` is
 *  distinguishable from one that doesn't. Kept as its own query (not a widening of
 *  REVIEW_THREADS_QUERY in place) so reviewer.ts's existing unresolved-count path is untouched by
 *  this PR — the two queries evolve independently. */
export const PR_REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String, $commentsCap: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          comments(first: $commentsCap) {
            totalCount
            pageInfo { hasNextPage }
            nodes { author { login } body createdAt }
          }
        }
      }
    }
  }
}`;

/** One page of PR_REVIEW_THREADS_QUERY: the threads on this page plus the cursor — same
 *  terminal-on-malformed-pageInfo tolerance as parseReviewThreadsPage. Each thread's
 *  `commentsComplete` (Codex sol-high PR #260 review, P1) is true when its OWN comments
 *  sub-connection either reports no further page (`hasNextPage: false`) or its `totalCount` is
 *  already within the fetched node count — either signal alone is sufficient; both absent (a
 *  malformed/partial response) degrades to `true` only when nodes were actually returned in full
 *  (empty-and-unknown reads as complete, matching every other tolerant parser in this file). */
export function parsePRReviewThreadsPage(json: string): {
  threads: ReviewThreadItem[];
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const d = JSON.parse(json) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: {
              id: string;
              isResolved: boolean;
              comments?: {
                totalCount?: number;
                pageInfo?: { hasNextPage?: boolean };
                nodes?: { author?: { login?: string }; body?: string; createdAt?: string }[];
              };
            }[];
          };
        };
      };
    };
  };
  const conn = d.data?.repository?.pullRequest?.reviewThreads;
  const threads: ReviewThreadItem[] = (conn?.nodes ?? []).map((n) => {
    const commentNodes = n.comments?.nodes ?? [];
    const hasNextPage = n.comments?.pageInfo?.hasNextPage ?? false;
    const totalCount = n.comments?.totalCount;
    const commentsComplete = !hasNextPage && (totalCount === undefined || totalCount <= commentNodes.length);
    return {
      id: n.id,
      isResolved: n.isResolved,
      comments: commentNodes.map((c) => ({ author: c.author?.login ?? "", body: c.body ?? "", createdAt: c.createdAt ?? "" })),
      commentsComplete,
    };
  });
  return { threads, hasNextPage: conn?.pageInfo?.hasNextPage ?? false, endCursor: conn?.pageInfo?.endCursor ?? null };
}

/**
 * ALL review threads (with their own comments) across the WHOLE connection, paged to
 * EXHAUSTION — same Codex PR #42 P2 rationale as countUnresolvedThreads: a first-100-only fetch
 * could silently miss threads past the first page on a heavily-reviewed PR. The proxy's own
 * `pr_review_threads` tool applies its OWN cap to the returned array afterward (mirrors
 * issue_comments' lastN contract: this function returns everything it could page to, the tool
 * layer bounds it). Same hard page ceiling (50 pages) as countUnresolvedThreads, for the same
 * reason: a cursor bug must never spin forever — `pageCapped` (Codex sol-high PR #260 review,
 * P1) tells the caller whether that ceiling actually cut the fetch short (`hasNextPage` still
 * true when the loop gave up), a DISTINCT incompleteness reason from the tool's own lastN cap.
 */
export async function fetchAllReviewThreads(fetchPage: (after: string | null) => Promise<string>): Promise<ReviewThreadsPage> {
  const all: ReviewThreadItem[] = [];
  let after: string | null = null;
  for (let page = 0; page < 50; page++) {
    const p = parsePRReviewThreadsPage(await fetchPage(after));
    all.push(...p.threads);
    if (!p.hasNextPage || !p.endCursor) return { threads: all, pageCapped: false };
    after = p.endCursor;
  }
  return { threads: all, pageCapped: true }; // page ceiling hit; hasNextPage was still true
}
