// IForge: the seam between the conductor and the code host. v1 impl is GithubForge
// (gh CLI + GraphQL). Making GitLab/Gitea an implementation, not a rewrite. Every
// 0day hard-coding (PROJECT_NUMBER, user-vs-org, literal status names, reviewer
// login) lives in SapwoodConfig and is passed in here — never baked into the impl.
//
// SECURITY: all subprocess calls use execFile with an argv array — never exec/shell:true
// (PLAN security model). Issue text is treated as data, never interpolated into a shell.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { SapwoodConfig } from "./config.js";

const pexecFile = promisify(execFile);

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

  /** Run `gh` with an argv array (no shell). Returns stdout. */
  private async gh(args: string[]): Promise<string> {
    const { stdout } = await pexecFile("gh", args, { maxBuffer: 32 * 1024 * 1024 });
    return stdout;
  }

  async detectOwnerKind(owner: string): Promise<OwnerKind> {
    // `gh api users/<owner>` returns type User or Organization.
    const out = await this.gh(["api", `users/${owner}`, "--jq", ".type"]);
    return out.trim() === "Organization" ? "org" : "user";
  }

  async getReadyIssues(): Promise<Issue[]> {
    const { owner } = this.cfg.board;
    const ready = this.cfg.board.status.ready;
    const out = await this.gh([
      "issue", "list", "--repo", `${owner}/${this.repo()}`,
      "--state", "open", "--limit", "100",
      "--json", "number,title,labels",
    ]);
    const items = JSON.parse(out) as { number: number; title: string; labels: { name: string }[] }[];
    // ponytail: board-Status filtering is a GraphQL ProjectV2 query the conductor wires
    // in M2; for M0 we expose the parse + label shape and filter by the `ready` lane name
    // once the project query lands. Marker so the field isn't silently dropped:
    void ready;
    return items.map((i) => ({ number: i.number, title: i.title, labels: i.labels.map((l) => l.name) }));
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

  // ponytail: repo name is part of board identity; until config carries it explicitly,
  // derive nothing — require it via owner/repo on the project. Stubbed for M0 wiring.
  private repo(): string {
    return process.env["SAPWOOD_REPO"] ?? "sapwood";
  }
}

/** Pure parse of `gh pr view --json ...` output. Exported for offline testing. */
export function parsePRStatus(json: string): PRStatus {
  const d = JSON.parse(json) as {
    number: number;
    headRefOid: string;
    state: string;
    mergeable: string;
    statusCheckRollup?: { conclusion?: string | null }[];
  };
  const checks = d.statusCheckRollup ?? [];
  const ciGreen = checks.length === 0 || checks.every((c) => c.conclusion === "SUCCESS" || c.conclusion === null);
  return {
    number: d.number,
    headOid: d.headRefOid,
    state: d.state as PRStatus["state"],
    mergeable: d.mergeable === "MERGEABLE",
    ciGreen,
  };
}
