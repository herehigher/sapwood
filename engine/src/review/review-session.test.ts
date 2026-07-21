// review-session.test.ts (#285) — covers every acceptance criterion in the issue:
//   - role session spawnable with an explicit materialized cwd (spawn-args tests)
//   - guard hook active; Read outside the containment root blocked (LIVE containment test,
//     against the real guard-hook.ts subprocess, over a REAL materialized tree)
//   - tool profile excludes Bash entirely (spawn-args assertion)
//   - context manifest records the absorbed instruction files from the materialized tree
//   - every setup failure (missing dir, upstream materialize() failure) surfaces as
//     `{ kind: "unavailable" }` — never a silent degraded run
//
// `execFileSync`/`spawn` here are TEST-ONLY fixture plumbing (this file is excluded from the
// engine-wide child_process grep-invariant in worker.test.ts, which only scans non-`.test.ts`
// files) — same convention materializer.test.ts already established.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import { RoleRunner, type RoleRunnerDeps, type RoleSessionOpts, type RoleSessionResult } from "../roles/peripheral.js";
import { createPrivateClone, type MaterializeResult, materialize } from "./materializer.js";
import { runReviewSession } from "./review-session.js";

const cfg: SapwoodConfig = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });

// ── fixture plumbing (mirrors materializer.test.ts's own local helpers) ────────────────────

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function initSharedRepoWithInstructions(): string {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-review-session-shared-"));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "fixture"]);
  mkdirSync(join(dir, ".claude", "rules"), { recursive: true });
  writeFileSync(join(dir, "CLAUDE.md"), "# fixture repo conventions\n");
  writeFileSync(join(dir, ".claude", "rules", "x.md"), "- rule x\n");
  writeFileSync(join(dir, "app.ts"), "export const x = 1;\n");
  git(dir, ["add", "CLAUDE.md", ".claude/rules/x.md", "app.ts"]);
  git(dir, ["commit", "-qm", "fixture commit"]);
  return dir;
}

function headOid(dir: string): string {
  return git(dir, ["rev-parse", "HEAD"]).trim();
}

/** Materializes a fresh fixture tree (real private-clone checkout, #284's own machinery) and
 *  returns the `"materialized"` result plus every directory this caller must clean up. Throws
 *  (via the outer `assert.equal`) if materialization itself fails — every test using this helper
 *  expects a clean materialize() as its own precondition, not the thing under test. */
async function materializeFixture(): Promise<{ result: Extract<MaterializeResult, { kind: "materialized" }>; cleanup: () => void }> {
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-review-session-wtroot-"));
  const cloneRoot = mkdtempSync(join(tmpdir(), "sapwood-review-session-clone-"));
  const treeRoot = mkdtempSync(join(tmpdir(), "sapwood-review-session-tree-"));
  const shared = initSharedRepoWithInstructions();
  const cloneDir = join(cloneRoot, "clone.git");
  const clone = await createPrivateClone({ sourceRepoDir: shared, cloneDir, worktreeRoot });
  const treeDir = join(treeRoot, "tree-1");
  const result = await materialize({ clone, oid: headOid(shared), treeDir });
  assert.equal(result.kind, "materialized", "fixture precondition: materialize() itself must succeed");
  const cleanup = (): void => {
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(cloneRoot, { recursive: true, force: true });
    rmSync(treeRoot, { recursive: true, force: true });
    rmSync(shared, { recursive: true, force: true });
  };
  return { result: result as Extract<MaterializeResult, { kind: "materialized" }>, cleanup };
}

// ── runReviewSession: mapping upstream failures + a fake runner (unit-level) ────────────────

test("runReviewSession: an upstream materialize() failure is NEVER handed to the runner at all — maps straight to unavailable, reason passed through verbatim", async () => {
  let called = false;
  const fakeRunner = {
    run: async (): Promise<RoleSessionResult> => {
      called = true;
      return {} as unknown as RoleSessionResult;
    },
  };
  const outcome = await runReviewSession(fakeRunner, {
    materialize: { kind: "failure", reason: "checkout of deadbeef failed: some git error" },
    roleId: "engine-reviewer",
    prompt: "p",
    model: "opus",
    effort: "high",
    fallbackModel: "none",
  });
  assert.equal(called, false, "runner.run must never be called when materialize() already failed");
  assert.deepEqual(outcome, { kind: "unavailable", reason: "checkout of deadbeef failed: some git error" });
});

test("runReviewSession: a materialized result is passed to runner.run as reviewCwd — and NOTHING ELSE overriding the review profile (allowedTools/disallowedTools/proxy are all absent from the call, so RoleRunner.run()'s own hardcoded profile is what actually applies, not a wrapper-level convention)", async () => {
  let seenOpts: RoleSessionOpts | undefined;
  const fakeRunner = {
    run: async (opts: RoleSessionOpts): Promise<RoleSessionResult> => {
      seenOpts = opts;
      return { outcome: "done", costUsd: 0, modelUsage: [], exitCode: 0, name: "role-engine-reviewer-abc" };
    },
  };
  const outcome = await runReviewSession(fakeRunner, {
    materialize: { kind: "materialized", treeDir: "/tmp/some-materialized-tree", oid: "a".repeat(40), manifest: [] },
    roleId: "engine-reviewer",
    prompt: "review this diff",
    model: "opus",
    effort: "high",
    fallbackModel: "none",
  });
  assert.equal(seenOpts?.reviewCwd, "/tmp/some-materialized-tree");
  // Codex sol-high PR #300 review, P2/P3: the tool profile / proxy suppression / forced-hard
  // guard / MCP-settings closure are ALL hardcoded inside RoleRunner.run() itself once reviewCwd
  // is set (and run() now REFUSES a caller supplying allowedTools/disallowedTools/proxy alongside
  // it) — this wrapper passes none of them, so there is nothing here that could silently diverge
  // from run()'s own single source of truth.
  assert.equal(seenOpts?.allowedTools, undefined);
  assert.equal(seenOpts?.disallowedTools, undefined);
  assert.equal(seenOpts?.proxy, undefined, "a review session opts in to NO forge proxy at all");
  assert.deepEqual(outcome, { kind: "ran", outcome: "done", costUsd: 0, modelUsage: [], exitCode: 0, name: "role-engine-reviewer-abc" });
});

test("runReviewSession: a runner.run() setup-failure THROW (e.g. a materialized dir that vanished before spawn) is caught and mapped to unavailable — never propagates, never a silent degraded run", async () => {
  const fakeRunner = {
    run: async (): Promise<RoleSessionResult> => {
      throw new Error(`review session materialized cwd "/tmp/gone" does not exist`);
    },
  };
  const outcome = await runReviewSession(fakeRunner, {
    materialize: { kind: "materialized", treeDir: "/tmp/gone", oid: "b".repeat(40), manifest: [] },
    roleId: "engine-reviewer",
    prompt: "p",
    model: "opus",
    effort: "high",
    fallbackModel: "none",
  });
  assert.equal(outcome.kind, "unavailable");
  assert.match((outcome as { reason: string }).reason, /review session setup failed:.*does not exist/);
});

// ── end-to-end: REAL materializer.materialize() + REAL RoleRunner + a stub claude binary ───

const mkStub = (dir: string, body: string): string => {
  const p = join(dir, "claude-stub");
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};
const mkHook = (dir: string): string => {
  const p = join(dir, "guard-hook.js");
  writeFileSync(p, "process.exit(0)\n");
  return p;
};
const mkRunner = (dir: string, claudeBin: string, over: Partial<RoleRunnerDeps> = {}): RoleRunner =>
  new RoleRunner({
    cfg,
    stateDir: dir,
    worktreeRoot: join(dir, "worktrees"),
    claudeBin,
    heartbeatMs: 50,
    guardHookPath: mkHook(dir),
    preSpawnCaptureTimeoutMs: 3000,
    preSpawnCapturePollMs: 5,
    ...over,
  });

test("end-to-end: runReviewSession spawns directly against the REAL materialized tree — no --worktree flag, cwd IS the tree, no --add-dir, and the tree survives afterward (never deleted by the runner)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-review-session-"));
  const { result, cleanup } = await materializeFixture();
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
printf '%s\\n' "$@" > "${join(dir, "args.seen")}"
pwd > "${join(dir, "pwd.seen")}"
echo '{"type":"result","subtype":"success","total_cost_usd":0.0002}'
exit 0
`,
    );
    const runner = mkRunner(dir, bin);
    const outcome = await runReviewSession(runner, {
      materialize: result,
      roleId: "engine-reviewer",
      prompt: "review this PR",
      model: "opus",
      effort: "high",
      fallbackModel: "none",
    });
    assert.equal(outcome.kind, "ran");
    assert.equal((outcome as { outcome: string }).outcome, "done");

    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    assert.ok(!seen.includes("--worktree"), "no --worktree flag at all in review session mode");
    assert.ok(!seen.includes("--add-dir"), "never mounts engine state, same as every role session");
    // realpathSync on both sides: macOS's tmpdir() lives under a `/tmp` -> `/private/tmp`
    // symlink, so a real shell's `pwd` (which resolves symlinks) can legitimately differ from
    // the un-resolved path string materialize() returned, byte-for-byte, while still being the
    // SAME directory.
    assert.equal(
      realpathSync(readFileSync(join(dir, "pwd.seen"), "utf8").trim()),
      realpathSync(result.treeDir),
      "the spawned process's OWN cwd is the materialized tree",
    );

    // The materialized tree is untouched by RoleRunner's teardown — this runner never created
    // it (no --worktree) and does not own its lifecycle.
    assert.ok(existsSync(result.treeDir), "materialized tree still exists after the session completes");
    assert.ok(existsSync(join(result.treeDir, "CLAUDE.md")), "tree contents untouched");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: the review session's tool profile is Read/Grep/Glob only, no Bash, no forge proxy — even when a RoleRunnerDeps.defaultProxy is configured for OTHER (non-review) role sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-review-session-"));
  const { result, cleanup } = await materializeFixture();
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    let defaultProxyMinted = false;
    const runner = mkRunner(dir, bin, {
      defaultProxy: {
        mint: async () => {
          defaultProxyMinted = true;
          throw new Error("must never be called for a review session");
        },
      },
    });
    const outcome = await runReviewSession(runner, {
      materialize: result,
      roleId: "engine-reviewer",
      prompt: "p",
      model: "opus",
      effort: "high",
      fallbackModel: "none",
    });
    assert.equal(outcome.kind, "ran");
    assert.equal(defaultProxyMinted, false, "the RoleRunner-wide default proxy is NEVER consulted for a review session");

    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    const at = (flag: string): string => seen[seen.indexOf(flag) + 1] ?? "";
    assert.equal(at("--allowedTools"), "Read,Grep,Glob");
    assert.equal(at("--disallowedTools"), "Write,Edit,MultiEdit,NotebookEdit,Bash");
    // Codex sol-high PR #300 review, P1: a review session DOES carry a --mcp-config — the
    // explicit EMPTY one (paired with --strict-mcp-config), never a forge proxy's. "no proxy"
    // and "no --mcp-config at all" are two different claims; only the former holds here.
    assert.equal(at("--mcp-config"), '{"mcpServers":{}}');
    assert.ok(seen.includes("--strict-mcp-config"), "MCP closure: only --mcp-config's (empty) servers ever load");
    assert.equal(at("--setting-sources"), "user", "the materialized (producer-controlled) tree's own project/local settings never load");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: context manifest records the absorbed instruction files FROM THE MATERIALIZED TREE (existing #236 mechanism, unchanged) — CLAUDE.md + .claude/rules/*.md, worktree.path is the materialized dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-review-session-"));
  const { result, cleanup } = await materializeFixture();
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
echo '{"type":"system","subtype":"init","model":"claude-review-stub","claude_code_version":"9.9.9","tools":["Read","Grep","Glob"],"mcp_servers":[]}'
echo '{"type":"result","subtype":"success","total_cost_usd":0.0002,"model":"claude-review-stub"}'
exit 0
`,
    );
    const runner = mkRunner(dir, bin);
    const outcome = await runReviewSession(runner, {
      materialize: result,
      roleId: "engine-reviewer",
      prompt: "review this PR",
      model: "opus",
      effort: "high",
      fallbackModel: "none",
    });
    assert.equal(outcome.kind, "ran");
    const manifest = (outcome as RoleSessionResult).contextManifest;
    assert.ok(manifest, "a real run always carries a context manifest");

    const claudeMd = manifest!.sources.find((s) => s.label === "repo CLAUDE.md");
    assert.equal(claudeMd?.kind, "snapshot");
    assert.equal((claudeMd as { content: string }).content, "# fixture repo conventions\n");
    assert.equal(
      (claudeMd as { path: string }).path,
      join(result.treeDir, "CLAUDE.md"),
      "probed from the MATERIALIZED tree, not a worktree",
    );

    const rule = manifest!.sources.find((s) => s.label === "repo .claude/rules/x.md");
    assert.equal(rule?.kind, "snapshot");
    assert.equal((rule as { content: string }).content, "- rule x\n");

    assert.equal(manifest!.worktree.path, result.treeDir, "the manifest's own worktree.path IS the materialized tree");
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("end-to-end: a materialized directory removed AFTER materialize() succeeded but BEFORE the review session spawns is a setup failure -> unavailable, never a silent degraded run (the 'missing dir' AC)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-review-session-"));
  const { result, cleanup } = await materializeFixture();
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`);
    const runner = mkRunner(dir, bin);
    // Simulate the "missing dir" failure mode named explicitly in the issue's AC: the directory
    // materialize() reported as successfully materialized is gone by the time the review session
    // actually tries to use it (e.g. a concurrent cleanup, a crash-recovery race).
    rmSync(result.treeDir, { recursive: true, force: true });
    const outcome = await runReviewSession(runner, {
      materialize: result,
      roleId: "engine-reviewer",
      prompt: "p",
      model: "opus",
      effort: "high",
      fallbackModel: "none",
    });
    assert.equal(outcome.kind, "unavailable");
    assert.match((outcome as { reason: string }).reason, /does not exist/);
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runReviewSession: an OID-mismatch failure from materialize() (#284/E3a's own AC) surfaces as unavailable through the exact same path as any other materialize() failure", async () => {
  const fakeRunner = { run: async (): Promise<RoleSessionResult> => ({}) as unknown as RoleSessionResult };
  const outcome = await runReviewSession(fakeRunner, {
    materialize: { kind: "failure", reason: "checkout OID mismatch: requested aaaa..., private clone resolved bbbb..." },
    roleId: "engine-reviewer",
    prompt: "p",
    model: "opus",
    effort: "high",
    fallbackModel: "none",
  });
  assert.deepEqual(outcome, { kind: "unavailable", reason: "checkout OID mismatch: requested aaaa..., private clone resolved bbbb..." });
});

// ── LIVE containment test: the REAL guard-hook.ts subprocess, over a REAL materialized tree ─

/** Invokes the REAL guard-hook.ts (via tsx, same pattern guard.test.ts's own symlink-invocation
 *  test uses) with `SAPWOOD_WORKTREE_ROOT` set to `worktreeRoot` — exactly what
 *  peripheralSessionEnv wires for a review session's guard containment root (peripheral.ts). This
 *  is NOT a config assertion: it spawns the real hook process and feeds it a real PreToolUse
 *  payload, exercising guardDecision/checkReadContainment for real. Returns the parsed decision
 *  (`null` = allow, an object = deny). */
async function invokeGuardHookLive(
  payload: Record<string, unknown>,
  worktreeRoot: string,
  guardModeEnv?: string,
): Promise<{ hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } } | null> {
  const srcDir = dirname(fileURLToPath(import.meta.url));
  const engineRoot = join(srcDir, "..", "..");
  const guardHookTs = join(srcDir, "..", "guard", "guard-hook.ts");
  const { stdout } = await new Promise<{ stdout: string; code: number | null }>((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", guardHookTs], {
      cwd: engineRoot,
      env: {
        ...process.env,
        SAPWOOD_WORKTREE_ROOT: worktreeRoot,
        // #285 (Codex sol-high PR #300 review, P2): omitted -> unset, which resolveGuardMode
        // (guard-hook.ts) resolves to "hard" by its own fail-safe default — the SAME value
        // RoleRunner.run() now FORCES into every review session's env regardless of the
        // engine's configured guard.mode. Passed explicitly here only by the soft-mode
        // contrast test below, to demonstrate what the pre-fix (forwarded-unchanged) behavior
        // would have done.
        ...(guardModeEnv !== undefined ? { SAPWOOD_GUARD_MODE: guardModeEnv } : {}),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", reject);
    child.on("exit", (code) => resolvePromise({ stdout: out, code }));
    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();
  });
  const trimmed = stdout.trim();
  return trimmed.length === 0 ? null : JSON.parse(trimmed);
}

test("LIVE containment: guard-hook.ts (the same hook peripheralSessionEnv/guardSettings wire into every role session, including review sessions) actually BLOCKS a Read outside the materialized tree, and ALLOWS one inside — over a REAL private-clone materialized tree, not a stub", async () => {
  const { result, cleanup } = await materializeFixture();
  const outsideDir = mkdtempSync(join(tmpdir(), "sapwood-review-session-outside-"));
  try {
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "must never be read by a review session\n");

    // Read OUTSIDE the materialized tree (a sibling directory) -> BLOCKED.
    const denied = await invokeGuardHookLive(
      { tool_name: "Read", tool_input: { file_path: outsideFile }, cwd: result.treeDir },
      result.treeDir,
    );
    assert.ok(denied, "a Read outside the materialized containment root must be denied");
    assert.equal(denied!.hookSpecificOutput.permissionDecision, "deny");

    // Read INSIDE the materialized tree (an absorbed instruction file, D7) -> ALLOWED.
    const allowedInside = await invokeGuardHookLive(
      { tool_name: "Read", tool_input: { file_path: join(result.treeDir, "CLAUDE.md") }, cwd: result.treeDir },
      result.treeDir,
    );
    assert.equal(allowedInside, null, "a Read of the materialized tree's own CLAUDE.md must be allowed");

    // A `../`-traversal attempt out of the tree -> BLOCKED (same containment mechanism).
    const traversal = await invokeGuardHookLive(
      { tool_name: "Read", tool_input: { file_path: join(result.treeDir, "..", "outside-traversal.txt") }, cwd: result.treeDir },
      result.treeDir,
    );
    assert.ok(traversal, "a `../`-traversal read must be denied");
    assert.equal(traversal!.hookSpecificOutput.permissionDecision, "deny");

    // Bash is denied by the tool profile, not the guard — but the guard's OWN command-safety
    // rules still fire if a Bash call somehow reached the hook (defense in depth); prove the
    // containment root doesn't accidentally widen Bash's own reach either.
    const bashOutside = await invokeGuardHookLive(
      { tool_name: "Bash", tool_input: { command: `cat ${outsideFile}` }, cwd: result.treeDir },
      result.treeDir,
    );
    assert.equal(
      bashOutside,
      null,
      "guardDecision's Bash path has no read-containment rule of its own (the tool profile denies Bash entirely instead) — asserted so this test's own expectations stay honest about what the guard vs. the tool profile each enforce",
    );
  } finally {
    cleanup();
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("LIVE containment (Codex sol-high PR #300 review, P2): under a configured soft guard.mode, a review session still blocks a Read outside the materialized tree — the FORCED-hard env RoleRunner.run() sends is what a real guard-hook.ts subprocess actually enforces, not the engine's configured soft value", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-review-session-"));
  const { result, cleanup } = await materializeFixture();
  const outsideDir = mkdtempSync(join(tmpdir(), "sapwood-review-session-outside-"));
  try {
    const outsideFile = join(outsideDir, "secret.txt");
    writeFileSync(outsideFile, "must never be read by a review session, soft config or not\n");

    // 1) Prove RoleRunner.run() actually FORCES SAPWOOD_GUARD_MODE=hard for a review session
    //    even when the engine's configured guard.mode is "soft" — captured from a REAL run(),
    //    not asserted from config.
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s' "$SAPWOOD_GUARD_MODE" > "${join(dir, "guard_mode.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const softCfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, guard: { mode: "soft" } });
    const runner = new RoleRunner({
      cfg: softCfg,
      stateDir: dir,
      worktreeRoot: join(dir, "worktrees"),
      claudeBin: bin,
      heartbeatMs: 50,
      guardHookPath: join(dir, "guard-hook.js"),
      preSpawnCaptureTimeoutMs: 150,
      preSpawnCapturePollMs: 10,
    });
    writeFileSync(join(dir, "guard-hook.js"), "process.exit(0)\n");
    const outcome = await runReviewSession(runner, {
      materialize: result,
      roleId: "engine-reviewer",
      prompt: "p",
      model: "opus",
      effort: "high",
      fallbackModel: "none",
    });
    assert.equal(outcome.kind, "ran");
    const forcedGuardMode = readFileSync(join(dir, "guard_mode.seen"), "utf8");
    assert.equal(
      forcedGuardMode,
      "hard",
      "the review session's ACTUAL spawn env is forced hard, regardless of the configured soft guard.mode",
    );

    // 2) Replay that EXACT forced value through the REAL guard-hook.ts subprocess (same
    //    containment root as the session actually got) — a Read outside the tree is DENIED.
    const deniedUnderForcedHard = await invokeGuardHookLive(
      { tool_name: "Read", tool_input: { file_path: outsideFile }, cwd: result.treeDir },
      result.treeDir,
      forcedGuardMode,
    );
    assert.ok(deniedUnderForcedHard, "under the forced-hard env a review session actually gets, an outside Read is denied");
    assert.equal(deniedUnderForcedHard!.hookSpecificOutput.permissionDecision, "deny");

    // 3) Contrast: replaying the SAME payload with the engine's raw configured value ("soft" —
    //    what would have reached the guard WITHOUT this fix, had guard.mode simply been forwarded
    //    unchanged) demonstrates the fix actually matters — soft mode turns the same containment
    //    denial into a silent allow (applyGuardMode's own documented behavior).
    const allowedUnderRawSoft = await invokeGuardHookLive(
      { tool_name: "Read", tool_input: { file_path: outsideFile }, cwd: result.treeDir },
      result.treeDir,
      "soft",
    );
    assert.equal(
      allowedUnderRawSoft,
      null,
      "counterfactual: the engine's raw configured 'soft' value, if forwarded unchanged (the pre-fix behavior), would have silently ALLOWED this same outside Read — this is exactly the hole forcing hard closes",
    );
  } finally {
    cleanup();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});
