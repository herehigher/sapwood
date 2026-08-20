import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cwdContractError } from "./cwd-contract.js";

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}

function makeGitRepo(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  git(dir, ["init", "--quiet"]);
  git(dir, ["config", "user.email", "sapwood-test@example.invalid"]);
  git(dir, ["config", "user.name", "Sapwood test"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  writeFileSync(join(dir, "sapwood.config.yaml"), "board: { owner: acme, repo: widgets, projectNumber: 7 }\n");
  git(dir, ["add", "sapwood.config.yaml"]);
  git(dir, ["commit", "--quiet", "-m", "test fixture"]);
  return realpathSync(dir);
}

function expectedRootError(command: string, root: string): string {
  return `sapwood ${command}: Run sapwood from the repository root. ${root}\n`;
}

test("cwd contract: linked worktrees refuse every root-bound command", () => {
  const repo = makeGitRepo("sapwood-cwd-contract-");
  const claudeLane = join(repo, ".claude", "worktrees", "lane");
  const peripheralLane = join(repo, "peripheral-lane");
  try {
    mkdirSync(join(repo, ".claude", "worktrees"), { recursive: true });
    git(repo, ["worktree", "add", "--quiet", "-b", "claude-lane", claudeLane, "HEAD"]);
    git(repo, ["worktree", "add", "--quiet", "-b", "peripheral-lane", peripheralLane, "HEAD"]);
    for (const [command, lane] of [
      ["run", claudeLane],
      ["init", claudeLane],
      ["status", claudeLane],
      ["events", peripheralLane],
      ["dashboard", peripheralLane],
      ["park", peripheralLane],
      ["pause", peripheralLane],
      ["stop", peripheralLane],
      ["estop", peripheralLane],
    ] as const) {
      assert.equal(cwdContractError(["node", "sapwood", command], lane), expectedRootError(command, repo));
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cwd contract: a main-worktree subdirectory and the last repeated --config path refuse", () => {
  const repoA = makeGitRepo("sapwood-cwd-contract-config-a-");
  const repoB = makeGitRepo("sapwood-cwd-contract-config-b-");
  const subdir = join(repoB, "subdir");
  try {
    mkdirSync(subdir);
    assert.equal(cwdContractError(["node", "sapwood", "pause"], subdir), expectedRootError("pause", repoB));

    const configA = join(repoA, "sapwood.config.yaml");
    const configB = join(repoB, "sapwood.config.yaml");
    assert.equal(
      cwdContractError(["node", "sapwood", "pause", "--config", configB, "--config", configA], repoB),
      expectedRootError("pause", repoB),
    );
    assert.equal(cwdContractError(["node", "sapwood", "pause", "--config", configA, "--config", configB], repoB), undefined);
  } finally {
    rmSync(repoA, { recursive: true, force: true });
    rmSync(repoB, { recursive: true, force: true });
  }
});

test("cwd contract: unavailable git fails closed, while Git environment overrides cannot bypass linked-worktree refusal", () => {
  const repo = makeGitRepo("sapwood-cwd-contract-git-");
  const lane = join(repo, "lane");
  const oldPath = process.env.PATH;
  const oldGitDir = process.env.GIT_DIR;
  try {
    git(repo, ["worktree", "add", "--quiet", "-b", "git-lane", lane, "HEAD"]);
    process.env.PATH = "/nonexistent";
    assert.match(cwdContractError(["node", "sapwood", "stop"], lane)!, /could not determine the repository root \(git unavailable\)/);
    process.env.PATH = oldPath;

    process.env.GIT_DIR = "/nonexistent";
    assert.equal(cwdContractError(["node", "sapwood", "estop", "--confirm"], lane), expectedRootError("estop", repo));
  } finally {
    if (oldPath === undefined) delete process.env.PATH;
    else process.env.PATH = oldPath;
    if (oldGitDir === undefined) delete process.env.GIT_DIR;
    else process.env.GIT_DIR = oldGitDir;
    rmSync(repo, { recursive: true, force: true });
  }
});

test("cwd contract: a submodule root remains valid, bare repositories refuse, and non-git directories retain exact-cwd behaviour", () => {
  const submodule = makeGitRepo("sapwood-cwd-contract-submodule-");
  const superproject = makeGitRepo("sapwood-cwd-contract-superproject-");
  const bare = mkdtempSync(join(tmpdir(), "sapwood-cwd-contract-bare-"));
  const nonGit = mkdtempSync(join(tmpdir(), "sapwood-cwd-contract-non-git-"));
  try {
    git(superproject, ["-c", "protocol.file.allow=always", "submodule", "add", "--quiet", submodule, "vendor/submodule"]);
    git(superproject, ["commit", "--quiet", "-m", "add submodule"]);
    assert.equal(cwdContractError(["node", "sapwood", "status"], join(superproject, "vendor", "submodule")), undefined);

    git(bare, ["init", "--bare", "--quiet"]);
    assert.match(cwdContractError(["node", "sapwood", "run"], bare)!, /bare repository has no worktree/);
    assert.equal(cwdContractError(["node", "sapwood", "run"], nonGit), undefined);
  } finally {
    rmSync(submodule, { recursive: true, force: true });
    rmSync(superproject, { recursive: true, force: true });
    rmSync(bare, { recursive: true, force: true });
    rmSync(nonGit, { recursive: true, force: true });
  }
});
