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
}

export interface PRStatus {
  number: number;
  headOid: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergeable: boolean;
  ciGreen: boolean;
}

/** The only surface the conductor uses to touch the code host. ~8 methods. */
export interface IForge {
  detectOwnerKind(owner: string): Promise<OwnerKind>;
  getReadyIssues(): Promise<Issue[]>;
  claimIssue(issue: number): Promise<void>;
  setBoardStatus(issue: number, status: "ready" | "inProgress" | "done"): Promise<void>;
  addLabel(issue: number, label: string): Promise<void>;
  openPR(branch: string, title: string, body: string): Promise<number>;
  getPRStatus(pr: number): Promise<PRStatus>;
  mergePR(pr: number, headOid: string): Promise<void>;
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

  async getReadyIssues(): Promise<Issue[]> {
    // FAIL CLOSED until M2. This is the source-of-truth work-queue boundary: it must
    // return only ProjectV2 items in the configured Ready lane (cfg.board.status.ready)
    // that also carry a verification plan (Decision #8) — never every open issue, which
    // would dispatch Backlog/Blocked/untriaged work. The ProjectV2 GraphQL query lands
    // with the conductor (M2); until then, returning nothing-but-throwing is the safe
    // posture (better no dispatch than a wrong one).
    throw new Error("getReadyIssues: ProjectV2 Ready-lane query wired in M2 (conductor)");
  }

  async claimIssue(issue: number): Promise<void> {
    await this.setBoardStatus(issue, "inProgress");
    await this.addLabel(issue, this.cfg.labels.inProgress);
  }

  async setBoardStatus(issue: number, status: "ready" | "inProgress" | "done"): Promise<void> {
    // ProjectV2 single-select mutation; concrete GraphQL lands with the conductor (M2).
    // The status *value* comes from config (cfg.board.status[status]), never a literal.
    const value = this.cfg.board.status[status];
    void issue; void value;
    throw new Error("setBoardStatus: ProjectV2 mutation wired in M2 (conductor)");
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

  private repo(): string {
    return this.cfg.board.repo;
  }
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
    mergeable: d.mergeable === "MERGEABLE",
    ciGreen,
  };
}
