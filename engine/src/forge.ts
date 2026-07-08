// IForge: the seam between the conductor and the code host. v1 impl is GithubForge
// (gh CLI + GraphQL). Making GitLab/Gitea an implementation, not a rewrite. Every
// 0day hard-coding (PROJECT_NUMBER, user-vs-org, literal status names, reviewer
// login) lives in SapwoodConfig and is passed in here — never baked into the impl.
//
// SECURITY: all subprocess calls go through gh.ts (execFile with an argv array — never
// exec/shell:true). Issue text is treated as data, never interpolated into a shell.
import { gh } from "./gh.js";
import type { SapwoodConfig } from "./config.js";

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

/** One review on the PR (`gh pr view --json reviews`). */
export interface PRReview {
  author: string;
  commitOid: string; // the head this review was submitted against
  state: string; // APPROVED | COMMENTED | CHANGES_REQUESTED | DISMISSED | PENDING
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
  getReadyIssues(): Promise<Issue[]>;
  claimIssue(issue: number): Promise<void>;
  setBoardStatus(issue: number, status: "ready" | "inProgress" | "done"): Promise<void>;
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
  /** Raw issue body text (#46, Decision #8's gate② re-check): reviewer.ts extracts the
   *  verification-plan section from this to carry into the review trigger. Read-only;
   *  "" for an issue with no body rather than throwing (extractVerificationPlan treats an
   *  empty body as "no plan", the same fail-closed outcome as a genuinely planless issue). */
  getIssueBody(issue: number): Promise<string>;
  /** #76: open (state OPEN) issue count in the named milestone — the `stop.onMilestoneComplete`
   *  condition's "is this milestone done" signal. The driver evaluates this at tick boundaries
   *  only (never mid-tick); zero means the milestone has no open issues left, so the condition
   *  fires. A milestone name that doesn't exist in the repo also returns 0 (gh's own query
   *  behavior) — same fail-direction as an already-complete milestone, since either way there is
   *  nothing left to wait for. */
  countOpenIssuesInMilestone(milestone: string): Promise<number>;
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
        "api", "graphql",
        "-f", `query=${query}`,
        "-f", `login=${this.cfg.board.owner}`,
        "-F", `number=${this.cfg.board.projectNumber}`,
        // First page: -F passes the literal `null` as JSON null. Later pages: the cursor is
        // an opaque string -> -f (raw), so a number-/bool-looking cursor isn't mistyped by -F.
        ...(after === null ? ["-F", "after=null"] : ["-f", `after=${after}`]),
      ];
      const out = await this.gh(args);
      const parsed = parseProject(out, statusField);
      if (!merged) merged = parsed;
      else merged.items.push(...parsed.items);
      const pi = parsePageInfo(out);
      if (!pi.hasNextPage || !pi.endCursor) return merged;
      after = pi.endCursor;
    }
    return merged!; // page ceiling hit; return what we have rather than loop unbounded
  }

  async getReadyIssues(): Promise<Issue[]> {
    // Source-of-truth work-queue boundary: only ProjectV2 items in the configured Ready
    // lane, OPEN, in THIS repo, that also carry a verification plan (Decision #8). Never
    // every open issue. Fail-closed: a missing plan -> not returned -> not dispatched.
    const project = await this.fetchProject();
    return selectReadyIssues(project, this.cfg);
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

  async setBoardStatus(issue: number, status: "ready" | "inProgress" | "done"): Promise<void> {
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
      "api", "graphql", "-f", `query=${BOARD_MUTATION}`,
      "-f", `projectId=${project.projectId}`,
      "-f", `itemId=${itemId}`,
      "-f", `fieldId=${project.statusFieldId}`,
      "-f", `optionId=${optionId}`,
    ]);
  }

  async addLabel(issue: number, label: string): Promise<void> {
    await this.gh([
      "issue", "edit", String(issue),
      "--repo", `${this.cfg.board.owner}/${this.repo()}`,
      "--add-label", label,
    ]);
  }

  async openPR(branch: string, title: string, body: string): Promise<number> {
    const out = await this.gh([
      "pr", "create", "--repo", `${this.cfg.board.owner}/${this.repo()}`,
      "--head", branch, "--title", title, "--body", body,
    ]);
    const m = out.match(/\/pull\/(\d+)/);
    if (!m) throw new Error(`openPR: could not parse PR number from: ${out.trim()}`);
    return Number(m[1]);
  }

  async getPRStatus(pr: number): Promise<PRStatus> {
    const out = await this.gh([
      "pr", "view", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`,
      "--json", "number,headRefOid,state,mergeable,statusCheckRollup",
    ]);
    return parsePRStatus(out);
  }

  async mergePR(pr: number, headOid: string): Promise<void> {
    // --match-head-commit pins the reviewed head: TOCTOU guard against a push between
    // review and merge (0day loop_merge_driver.sh). producer != merger: only the
    // conductor calls this, never a worker.
    await this.gh([
      "pr", "merge", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`,
      "--squash", "--delete-branch", "--match-head-commit", headOid,
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
    const out = await this.gh([
      "issue", "view", String(issue), "--repo", `${this.cfg.board.owner}/${this.repo()}`,
      "--json", "body",
    ]);
    const parsed = JSON.parse(out) as { body?: string };
    return parsed.body ?? "";
  }

  /** #46: maps an issue to its already-open PR, for the live `sapwood run` wiring
   *  (WorkerDeps.hasOpenPr/findOpenPr) — the "live findOpenPr forge wiring" PLAN.md's M3
   *  deferred list flagged. The selected PR becomes the driving lane's gate/MERGE target, so
   *  selection is fail-closed on ambiguity — see findOpenPrNumber for the full precedence
   *  (closing keywords > oldest-among-closing > a single unambiguous bare `#N` mention;
   *  multiple bare mentions -> null, the lane queues rather than gating a guessed PR). */
  async findOpenPrForIssue(issue: number): Promise<number | null> {
    const out = await this.gh([
      "pr", "list", "--repo", `${this.cfg.board.owner}/${this.repo()}`,
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
      "--state", "open", "--limit", "200", "--json", "number,body",
    ]);
    const prs = JSON.parse(out) as { number: number; body?: string }[];
    return findOpenPrNumber(prs.map((p) => ({ number: p.number, body: p.body ?? "" })), issue);
  }

  async getPRReviewData(pr: number): Promise<PRReviewData> {
    // Read-only gh calls (0day pr_gate.sh): PR metadata + reviews, reactions (--paginate), and
    // the review-threads connection PAGED TO EXHAUSTION (Codex PR #42 P2 — a first-100-only
    // fetch could report zero findings while an unresolved thread sits on a later page).
    // Never touches merge/approve/ready — this is a read surface only.
    const viewJson = await this.gh([
      "pr", "view", String(pr), "--repo", `${this.cfg.board.owner}/${this.repo()}`,
      "--json", "headRefOid,author,updatedAt,isDraft,labels,state,reviews",
    ]);
    const reactionsJson = await this.gh([
      // --slurp: --paginate alone concatenates one JSON doc per page (unparseable as a
      // single document); --slurp wraps pages in an outer array parsePRReactions flattens.
      "api", `repos/${this.cfg.board.owner}/${this.repo()}/issues/${pr}/reactions`, "--paginate", "--slurp",
    ]);
    const commentsJson = await this.gh([
      // Same pagination discipline. Conversation comments carry Codex's comment-shaped clean
      // verdict ("Didn't find any major issues") — post-#55 P2: that shape has no review
      // object and no +1 reaction, so without this fetch it wedges at WAIT_REVIEW.
      "api", `repos/${this.cfg.board.owner}/${this.repo()}/issues/${pr}/comments`, "--paginate", "--slurp",
    ]);
    const unresolvedThreads = await countUnresolvedThreads((after) =>
      this.gh([
        "api", "graphql", "-f", `query=${REVIEW_THREADS_QUERY}`,
        "-f", `owner=${this.cfg.board.owner}`, "-f", `repo=${this.repo()}`, "-F", `number=${pr}`,
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
      "issue", "list", "--repo", `${this.cfg.board.owner}/${this.repo()}`,
      "--milestone", milestone, "--state", "open", "--json", "number", "--limit", "1000",
    ]);
    const issues = JSON.parse(out) as { number: number }[];
    return issues.length;
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
}

export interface ParsedProject {
  projectId: string;
  statusFieldId: string;
  options: { name: string; id: string }[];
  items: ProjectItem[];
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
    }));
  return {
    projectId: proj.id,
    statusFieldId: proj.field?.id ?? "",
    options: proj.field?.options ?? [],
    items,
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
  labels: { verifyNa: string };
};

/** Ready-lane + OPEN + this repo + has-verification-plan. The dispatch work-queue. */
export function selectReadyIssues(project: ParsedProject, cfg: ReadyCfg): Issue[] {
  const fullName = `${cfg.board.owner}/${cfg.board.repo}`;
  return project.items
    .filter((it) => it.repo === fullName)
    .filter((it) => it.state === "OPEN")
    .filter((it) => it.status === cfg.board.status.ready)
    .filter((it) => hasVerificationPlan(it.body, it.labels, cfg.labels.verifyNa))
    .map((it) => ({ number: it.number, title: it.title, labels: it.labels, body: it.body }));
}

export function findOptionId(project: ParsedProject, name: string): string | undefined {
  return project.options.find((o) => o.name === name)?.id;
}

/** Item id for an issue. Scoped by full `owner/repo` when given — board items are unique by
 *  (repo, number), and a /repo suffix would also match a foreign `other/repo` (Codex R2 P1). */
export function findItemId(project: ParsedProject, issue: number, repoFullName?: string): string | undefined {
  return project.items.find(
    (it) => it.number === issue && (repoFullName === undefined || it.repo === repoFullName),
  )?.itemId;
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
  const ciGreen =
    checks.length > 0 &&
    checks.every((c) => (c.conclusion != null ? PASSING.has(c.conclusion) : c.state === "SUCCESS"));
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
    reviews?: { author?: { login?: string }; commit?: { oid?: string }; state: string }[];
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

export function assemblePRReviewData(viewJson: string, reactionsJson: string, unresolvedThreads: number, commentsJson = "[]"): PRReviewData {
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
