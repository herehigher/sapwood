// IForge: the seam between the conductor and the code host. v1 impl is GithubForge
// (gh CLI + GraphQL). Making GitLab/Gitea an implementation, not a rewrite. Every
// 0day hard-coding (PROJECT_NUMBER, user-vs-org, literal status names, reviewer
// login) lives in SapwoodConfig and is passed in here — never baked into the impl.
//
// SECURITY: all subprocess calls go through gh.ts (execFile with an argv array — never
// exec/shell:true). Issue text is treated as data, never interpolated into a shell.

import type { SapwoodConfig } from "../config/config.js";
import { gh } from "./gh.js";

export type OwnerKind = "user" | "org";

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

/** Everything reviewer.ts needs to derive gate②'s ACTION (0day's pr_gate.sh, review half —
 *  CI/gate① stays on PRStatus.ciGreen). Assembled from 3 read-only gh calls (reactions, pr
 *  view, review threads) — see GithubForge.getPRReviewData. */
export interface PRReviewData {
  headOid: string;
  author: string;
  updatedAt: string; // ISO — the freshness cutoff for reactions (0day pr_gate.sh #92)
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
}

/** The only surface the conductor uses to touch the code host. */
export interface IForge {
  detectOwnerKind(owner: string): Promise<OwnerKind>;
  /** Issue-number-addressable board items with no Status, plus draft/non-issue items that
   *  cannot be moved through setBoardStatus. Used once at engine startup, never for dispatch. */
  listUnplacedIssues(): Promise<UnplacedIssues>;
  getReadyIssues(): Promise<Issue[]>;
  claimIssue(issue: number): Promise<void>;
  setBoardStatus(issue: number, status: "backlog" | "ready" | "inProgress" | "done"): Promise<void>;
  addLabel(issue: number, label: string): Promise<void>;
  /** Add a label to a PULL REQUEST. #69 P1: the merge gate reads a PR's OWN labels
   *  (getPRReviewData → deriveGate's humanLabels check), not the source issue's, so escalating
   *  a crashed-with-WIP lane to `needs-human` must land here to actually gate the PR. */
  addPRLabel(pr: number, label: string): Promise<void>;
  openPR(branch: string, title: string, body: string): Promise<number>;
  getPRStatus(pr: number): Promise<PRStatus>;
  mergePR(pr: number, headOid: string): Promise<void>;
  /** Post a PR comment (e.g. the `@codex review` trigger). #13 reviewer.ts. */
  addPRComment(pr: number, body: string): Promise<void>;
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
   *  for the structured-output rework: post-#110, the engine applies a plan-drafter's revised
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
   *  those are settled, not "awaiting review"). */
  getIssuesNeedingPlanReview(): Promise<Issue[]>;
  /** #87: an issue's current label set — the plan_review orchestrator's per-issue outcome
   *  check after a plan-reviewer/plan-drafter session runs (distinguishing approved vs
   *  needs-human vs still-awaiting without re-fetching the whole board). */
  getIssueLabels(issue: number): Promise<string[]>;
  /** #87: an ISSUE's conversation comments (distinct from getPRReviewData's PR comments,
   *  though the underlying GitHub REST endpoint is the same `issues/<n>/comments` either way —
   *  PRs are issues under the hood). The plan_review orchestrator reads the plan-reviewer's
   *  most recent comment as the plan-drafter's brief (#77 Amendment 2). Newest-last (gh's
   *  default chronological order). */
  getIssueComments(issue: number): Promise<PRComment[]>;
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
  /** #89: OPEN issues in this repo that still lack a verification-plan section in their body —
   *  the PO/triage peripheral's candidate set. Broader than getIssuesNeedingPlanReview: every
   *  open issue regardless of board Status, not just the Ready lane, because triage runs
   *  proactively (before a human ever moves an issue to Ready) so it already carries a plan by
   *  the time gate⓪ sees it. needs-human/blocked/verify:n/a issues are excluded — settled
   *  state, not a drafting target (same exclusion stance as needsPlanReview). */
  getIssuesNeedingPlanTriage(): Promise<Issue[]>;
}

export class GithubForge implements IForge {
  constructor(private readonly cfg: SapwoodConfig) {}

  /** Run `gh` via the shared (execFile, no-shell) helper. Returns stdout. */
  private async gh(args: string[]): Promise<string> {
    return gh(args);
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
    return merged!; // page ceiling hit; return what we have rather than loop unbounded
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
      "number,headRefOid,state,mergeable,statusCheckRollup",
    ]);
    return parsePRStatus(out);
  }

  async getPRDiff(pr: number): Promise<string> {
    return this.gh(["pr", "diff", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`]);
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
    // Per-SEGMENT encoding: branch names routinely contain "/" (feat/x), which must survive as
    // a path separator for GitHub's greedy branch route, while any other reserved character in
    // a segment must not be able to reshape the API path (the branch name originates from a
    // SESSION-written scratch file — treated as data, same stance as every other session-text
    // input in this file). gh exits non-zero on a 404 (and on any network/auth failure) — both
    // read as "not verifiably pushed", the fail direction the IForge doc requires.
    const path = branch.split("/").map(encodeURIComponent).join("/");
    try {
      await this.gh(["api", `repos/${this.cfg.board.owner}/${this.repo()}/branches/${path}`]);
      return true;
    } catch {
      return false;
    }
  }

  async mergePR(pr: number, headOid: string): Promise<void> {
    // --match-head-commit pins the reviewed head: TOCTOU guard against a push between
    // review and merge (0day loop_merge_driver.sh). producer != merger: only the
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

  async addIssueComment(issue: number, body: string): Promise<void> {
    await this.gh(["issue", "comment", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--body", body]);
  }

  async addPRLabel(pr: number, label: string): Promise<void> {
    // `gh pr edit` (not `gh issue edit`) so a PR number is never mis-resolved to a same-number
    // issue on repos where the two namespaces overlap.
    await this.gh(["pr", "edit", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--add-label", label]);
  }

  async getIssueBody(issue: number): Promise<string> {
    const out = await this.gh(["issue", "view", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--json", "body"]);
    const parsed = JSON.parse(out) as { body?: string };
    return parsed.body ?? "";
  }

  async updateIssueBody(issue: number, body: string): Promise<void> {
    await this.gh(["issue", "edit", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--body", body]);
  }

  /** #46: maps an issue to its already-open PR, for the live `sapwood run` wiring
   *  (WorkerDeps.hasOpenPr/findOpenPr) — the "live findOpenPr forge wiring" PLAN.md's M3
   *  deferred list flagged. The selected PR becomes the driving lane's gate/MERGE target, so
   *  selection is fail-closed on ambiguity — see findOpenPrNumber for the full precedence
   *  (closing keywords > oldest-among-closing > a single unambiguous bare `#N` mention;
   *  multiple bare mentions -> null, the lane queues rather than gating a guessed PR). */
  async findOpenPrForIssue(issue: number): Promise<number | null> {
    const out = await this.gh([
      "pr",
      "list",
      "--repo",
      `${this.cfg.board.owner}/${this.repo()}`,
      // gh's default --limit is 30 (Codex PR #50, forge.ts thread): a worker's PR beyond the
      // first page would probe hasPr=false and wrongly escalate a completed lane to
      // needs-human. 200 comfortably covers any repo this loop realistically operates on
      // (lanes.max caps concurrent PRs in single digits). A targeted `--search "#N"` was
      // considered and rejected: GitHub's search tokenizer doesn't reliably exact-match
      // issue-reference tokens (fuzzy hits on similar numbers), which would reintroduce the
      // ambiguity findOpenPrNumber exists to fail closed on. RESIDUAL: a repo with >200 open
      // PRs could still hide the target past the page — accepted for v1 trusted repos;
      // fail direction is the conductor's existing no-PR fail-safe (escalate), never a
      // wrong-PR merge.
      "--state",
      "open",
      "--limit",
      "200",
      "--json",
      "number,body",
    ]);
    const prs = JSON.parse(out) as { number: number; body?: string }[];
    return findOpenPrNumber(
      prs.map((p) => ({ number: p.number, body: p.body ?? "" })),
      issue,
    );
  }

  async getPRReviewData(pr: number): Promise<PRReviewData> {
    // Read-only gh calls (0day pr_gate.sh): PR metadata + reviews, reactions (--paginate), and
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
    const unresolvedThreads = await countUnresolvedThreads((after) =>
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
    );
    return assemblePRReviewData(viewJson, reactionsJson, unresolvedThreads, commentsJson);
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

  async getIssueLabels(issue: number): Promise<string[]> {
    const out = await this.gh(["issue", "view", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--json", "labels"]);
    return parseIssueLabels(out);
  }

  async getIssueComments(issue: number): Promise<PRComment[]> {
    // Same endpoint shape (and pagination discipline) as getPRReviewData's commentsJson fetch
    // — GitHub's REST API serves issue and PR conversation comments off the same
    // `issues/<n>/comments` route, so parsePRComments parses this unchanged.
    const out = await this.gh(["api", `repos/${this.cfg.board.owner}/${this.repo()}/issues/${issue}/comments`, "--paginate", "--slurp"]);
    return parsePRComments(out);
  }

  async createIssue(title: string, body: string): Promise<number> {
    const out = await this.gh(["issue", "create", "--repo", `${this.cfg.board.owner}/${this.repo()}`, "--title", title, "--body", body]);
    const m = out.match(/\/issues\/(\d+)/);
    if (!m) throw new Error(`createIssue: could not parse issue number from: ${out.trim()}`);
    return Number(m[1]);
  }

  async listOpenIssueNumbers(): Promise<number[]> {
    // Same --limit rationale as countOpenIssuesInMilestone: generously above any realistic
    // open-issue count for this loop's use case (ponytail).
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
      "1000",
    ]);
    const issues = JSON.parse(out) as { number: number }[];
    return issues.map((i) => i.number);
  }

  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    const project = await this.fetchProject();
    return selectPlanTriageCandidates(project, this.cfg);
  }

  private repo(): string {
    return this.cfg.board.repo;
  }
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
}

export interface BoardPlacement {
  number: number | null;
  repo: string | null;
  status: string | null;
}

export interface UnplacedIssues {
  issues: number[];
  skipped: number;
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
 * Extract the Verification/Acceptance section's raw text from an issue body (Decision #8's
 * plan) — the SAME fail-closed heading match `hasVerificationPlan` uses to gate dispatch,
 * shared here (not duplicated) so gate②'s reviewer trigger (#46, reviewer.ts) carries exactly
 * the section the `Ready` gate already required to exist. Returns the heading line through
 * (exclusive) the next heading of equal-or-shallower level, or the rest of the body if there is
 * none. null when no such section exists — callers MUST supply an explicit fallback text, never
 * silently omit the plan (verify:n/a issues have no section and are expected to hit this null).
 */
export function extractVerificationPlan(body: string): string | null {
  const heading = /^(#{1,6})\s*(verification|acceptance)[^\n]*$/im.exec(body);
  if (!heading) return null;
  const level = heading[1]!.length;
  const afterHeading = body.slice(heading.index + heading[0].length);
  const nextHeading = new RegExp(`^#{1,${level}}\\s`, "m").exec(afterHeading);
  const section = nextHeading ? afterHeading.slice(0, nextHeading.index) : afterHeading;
  return (heading[0] + section).trim();
}

/** True if the issue carries a verification plan (Decision #8): verify:n/a label OR a
 *  Verification/Acceptance section in the body. Fail-closed: no signal -> false. */
export function hasVerificationPlan(body: string, labels: string[], verifyNaLabel: string): boolean {
  if (labels.includes(verifyNaLabel)) return true;
  return extractVerificationPlan(body) != null;
}

/**
 * Pure match for GithubForge.findOpenPrForIssue. Selecting a lane's PR here decides gate②'s
 * MERGE TARGET, so ambiguity must never be guessed away (gate② PR #50 P2 #2 — a newer PR
 * merely *mentioning* the issue must not out-rank / silently replace the issue's own PR):
 *
 *  1. PREFERRED: closing-keyword semantics — `Fixes/Closes/Resolves #N` (all GitHub-recognized
 *     inflections, case-insensitive, word-bounded, optional colon). A PR that declares it
 *     closes the issue is claiming to BE its PR, not just referencing it.
 *  2. Tiebreak among several closing-keyword matches: the OLDEST open PR (the last element —
 *     the caller passes gh's default newest-first order). Rationale: the issue's original PR
 *     is the one the lane's worker opened first; any newer PR also carrying a closing keyword
 *     for the same issue is a duplicate/rescue attempt and must not silently steal the merge
 *     target from the PR already being driven.
 *  3. FALLBACK: a bare `#N` token (not part of a longer number — `#460` never matches issue
 *     46), accepted ONLY when exactly one candidate matches. Multiple bare-mention candidates
 *     are ambiguous -> null (the lane stays undrivable/queued rather than gating a guessed PR).
 */
export function findOpenPrNumber(prs: { number: number; body: string }[], issue: number): number | null {
  const closing = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?):?\\s+#${issue}(?!\\d)`, "i");
  const closingMatches = prs.filter((pr) => closing.test(pr.body));
  if (closingMatches.length > 0) return closingMatches[closingMatches.length - 1]!.number; // oldest
  const mention = new RegExp(`(^|[^0-9])#${issue}(?!\\d)`);
  const mentions = prs.filter((pr) => mention.test(pr.body));
  return mentions.length === 1 ? mentions[0]!.number : null;
}

type ReadyCfg = {
  board: { owner: string; repo: string; statusField: string; status: { ready: string } };
  labels: { verifyNa: string; planApproved: string; needsHuman: string; blocked: string };
};

/**
 * gate⓪ (#88, amending Decision #8 per #77's 2026-07-09 comment): a verification plan must
 * pass agent quality review before dispatch, not merely exist. `needsHuman`/`blocked` block
 * unconditionally regardless of any other label — the fail-closed floor under both dispatch
 * paths below:
 *
 *  - `verifyNa` present (and `needsHuman` already ruled out) -> the doc-gate path. A human has
 *    effectively adjudicated this: the plan-reviewer peripheral only ever proposes `verifyNa`
 *    paired WITH `needsHuman` in the same action, so `verifyNa` alone means a human accepted
 *    it by removing `needsHuman` themselves.
 *  - otherwise -> dispatchable only if a verification-plan section exists in the body AND
 *    `planApproved` is present (applied by the plan-reviewer peripheral, never by this gate).
 *    Presence alone (pre-#88 behavior) is no longer sufficient.
 *
 * Reuses `extractVerificationPlan` directly rather than `hasVerificationPlan` — the latter's
 * OR-the-two-conditions-together semantics ("has a plan, in either sense") no longer matches
 * gate⓪'s dispatch rule (verifyNa's doc-gate path and a reviewed plan's path are now stricter
 * and mutually exclusive); `hasVerificationPlan` remains exported/tested unchanged as a
 * standalone "does a plan exist in some form" helper for any other caller.
 */
function isDispatchable(body: string, labels: string[], l: ReadyCfg["labels"]): boolean {
  if (labels.includes(l.needsHuman) || labels.includes(l.blocked)) return false;
  // #94 Codex retro-review P2: BOTH dispatch-path labels on one issue is a state the
  // plan-reviewer prompt forbids ("never apply both") — it can only arise from a stale or
  // manual label mutation. Fail closed BEFORE the verifyNa early-true below: a mixed-label
  // issue must not slip through the doc-gate path (which skips the red/green cycle); it waits
  // for a human to remove one of the two labels.
  if (labels.includes(l.verifyNa) && labels.includes(l.planApproved)) return false;
  if (labels.includes(l.verifyNa)) return true;
  return extractVerificationPlan(body) != null && labels.includes(l.planApproved);
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
 *  review (whether or not `needsHuman` also accompanies it, per the plan-reviewer's own
 *  outcome-3 contract). The forbidden verifyNa+planApproved MIXED state (#94 Codex retro P2)
 *  is likewise not a review candidate: it needs a human label CLEANUP, not another session —
 *  isDispatchable already fail-closes it out of dispatch, and dispatching a reviewer at it
 *  would burn a session on a state the prompt forbids it to resolve (it may never remove
 *  labels). The verifyNa check below covers it explicitly by construction. Otherwise: needs
 *  review unless already `planApproved`. */
function needsPlanReview(labels: string[], l: ReadyCfg["labels"]): boolean {
  if (labels.includes(l.needsHuman) || labels.includes(l.blocked)) return false;
  if (labels.includes(l.verifyNa)) return false; // doc-gate path OR the mixed state — neither is reviewable
  return !labels.includes(l.planApproved);
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

/** #89: true when an OPEN issue still lacks a verification plan and isn't already a settled
 *  human state — the PO/triage peripheral's candidate test. Unlike needsPlanReview, this does
 *  NOT gate on board Status (triage runs on any open issue, Ready or not — it exists so a
 *  plan-less issue already carries one BEFORE a human ever moves it to Ready). `verifyNa`
 *  issues are excluded (the doc-gate path; no plan is expected). `needsHuman`/`blocked` are
 *  excluded (settled — a human is already in the loop, not a drafting target). An issue that
 *  already has SOME plan section is excluded too — triage's whole job is to fill the gap, not
 *  to re-draft an existing plan (that quality judgment belongs to gate⓪'s plan-reviewer). */
function needsPlanTriage(body: string, labels: string[], l: ReadyCfg["labels"]): boolean {
  if (labels.includes(l.needsHuman) || labels.includes(l.blocked)) return false;
  if (labels.includes(l.verifyNa)) return false;
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
    state: string;
    mergeable: string;
    // CheckRun entries carry `conclusion`; legacy commit StatusContext entries carry
    // `state` and no `conclusion`. The rollup can mix both.
    statusCheckRollup?: { conclusion?: string | null; state?: string | null }[];
  };
  const checks = d.statusCheckRollup ?? [];
  // FAIL CLOSED: green only when there is >=1 check AND every check is in a *completed*
  // passing state. An EMPTY rollup is NOT green — on a fresh/just-pushed PR, checks may
  // not be created yet, so empty != "this repo has no CI". A null/absent conclusion on a
  // CheckRun means queued/in-progress (not green); SKIPPED/NEUTRAL are completed
  // non-failing; StatusContext entries (no conclusion) pass on state==SUCCESS.
  // ponytail: genuinely CI-less repos get an explicit `ci.requireChecks: false` opt-in
  // when the merge gate is wired (M3), not a silent empty-means-green default.
  // (Codex P1/P2, PR #22.)
  const PASSING = new Set(["SUCCESS", "SKIPPED", "NEUTRAL"]);
  const ciGreen = checks.length > 0 && checks.every((c) => (c.conclusion != null ? PASSING.has(c.conclusion) : c.state === "SUCCESS"));
  return {
    number: d.number,
    headOid: d.headRefOid,
    state: d.state as PRStatus["state"],
    mergeable: d.mergeable === "MERGEABLE" || d.mergeable === "CONFLICTING" ? d.mergeable : "UNKNOWN",
    ciGreen,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Review-gate data (#13 reviewer.ts / merge-driver.ts). Pure parse + assembly; the only
// impure part is GithubForge.getPRReviewData's 3 gh calls above.
// ─────────────────────────────────────────────────────────────────────────────

export const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { id isResolved }
      }
    }
  }
}`;

/** One page of the reviewThreads connection: unresolved count + cursor. Absent/malformed
 *  pageInfo -> terminal (no infinite loop on a bad response). */
export function parseReviewThreadsPage(json: string): {
  unresolved: number;
  hasNextPage: boolean;
  endCursor: string | null;
} {
  const d = JSON.parse(json) as {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: {
            pageInfo?: { hasNextPage?: boolean; endCursor?: string | null };
            nodes?: { isResolved: boolean }[];
          };
        };
      };
    };
  };
  const conn = d.data?.repository?.pullRequest?.reviewThreads;
  return {
    unresolved: (conn?.nodes ?? []).filter((n) => !n.isResolved).length,
    hasNextPage: conn?.pageInfo?.hasNextPage ?? false,
    endCursor: conn?.pageInfo?.endCursor ?? null,
  };
}

/**
 * Total unresolved threads across the WHOLE connection, paging to exhaustion (Codex PR #42
 * P2: a first-100 fetch with all first-page threads resolved would report 0 findings while an
 * unresolved thread sits on page 2 — a fail-open in gate②). Same pattern + page ceiling as
 * fetchProject's items paging. `fetchPage` is injected so the loop is testable offline.
 */
export async function countUnresolvedThreads(fetchPage: (after: string | null) => Promise<string>): Promise<number> {
  let unresolved = 0;
  let after: string | null = null;
  // ponytail: hard page ceiling (50 pages = 5000 threads) so a cursor bug can't spin forever.
  for (let page = 0; page < 50; page++) {
    const p = parseReviewThreadsPage(await fetchPage(after));
    unresolved += p.unresolved;
    if (!p.hasNextPage || !p.endCursor) return unresolved;
    after = p.endCursor;
  }
  return unresolved; // page ceiling hit; return what we counted rather than loop unbounded
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
  type Raw = { body?: string; created_at?: string; user?: { login?: string } };
  const parsed = JSON.parse(json) as Raw[] | Raw[][];
  const arr = parsed.flatMap((p) => (Array.isArray(p) ? p : [p]));
  return arr.map((c) => ({ login: c.user?.login ?? "", createdAt: c.created_at ?? "", body: c.body ?? "" }));
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
): PRReviewData {
  const view = parsePRReviewView(viewJson);
  return {
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
