// peripheral.test.ts (#87): the role runner — a stub `claude` binary (zero token, same
// integration style as worker.test.ts) drives the real spawn/sentinel/timeout/cost-parse path.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { ContextManifest } from "./context-manifest.js";
import {
  CONFIRM_ALLOWED_TOOLS,
  CONFIRM_DISALLOWED_TOOLS,
  PLAN_DRAFTER_DISALLOWED_TOOLS,
  PO_ALLOWED_TOOLS,
  PO_DISALLOWED_TOOLS,
  type RetriedSession,
  ROLE_ALLOWED_TOOLS,
  ROLE_DISALLOWED_TOOLS,
  RoleRunner,
  type RoleRunnerDeps,
  type RoleSessionOpts,
  type RoleSessionResult,
  runSessionWithRetry,
} from "./peripheral.js";
import { validateReviewerOutput } from "./plan-review.js";

const cfg: SapwoodConfig = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });

test("RoleRunner: default guard hook resolves the compiled hook in the guard directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const runner = new RoleRunner({ cfg, stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin: "claude" });
    const guardHookPath = (runner as unknown as { guardHookPath: string }).guardHookPath;
    assert.equal(guardHookPath, fileURLToPath(new URL("../guard/guard-hook.js", import.meta.url)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const mkStub = (dir: string, body: string): string => {
  const p = join(dir, "claude-stub");
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};
const FAST_STUB = `#!/usr/bin/env bash\necho '{"type":"result","subtype":"success","total_cost_usd":0.0005,"model":"claude-stub","usage":{"input_tokens":3,"output_tokens":7}}'\nexit 0\n`;
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
    // #236: most tests here never create a worktree at all (their stub `claude` binary just
    // echoes stream-json lines) — a short bounded wait keeps the suite fast while still
    // exercising the real pre-spawn-capture code path. Tests that DO create a worktree do so via
    // `mkdir -p` in bash, which resolves on the first poll well inside this window.
    preSpawnCaptureTimeoutMs: 150,
    preSpawnCapturePollMs: 10,
    ...over,
  });

test("run: stub claude exits 0 -> outcome done, cost/model usage parsed, running sentinel cleared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "done");
    assert.equal(result.costUsd, 0.0005);
    assert.deepEqual(result.modelUsage, [
      { model: "claude-stub", inputTokens: 3, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
    assert.equal(result.exitCode, 0);
    assert.ok(result.name.startsWith("role-plan-reviewer-"));
    assert.ok(existsSync(join(dir, `${result.name}.done.json`)));
    assert.ok(!existsSync(join(dir, `${result.name}.running.json`)), "running marker cleared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: peripheral spawn strips forge/git credentials while preserving Claude auth and guard mode", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  const poisoned = {
    GH_TOKEN: "poison-gh-token",
    GITHUB_TOKEN: "poison-github-token",
    GITHUB_ENTERPRISE_TOKEN: "poison-github-enterprise-token",
    GH_CONFIG_DIR: "/poison/gh-config",
    GH_HOST: "poison.example",
    GIT_ASKPASS: "/poison/askpass",
    GIT_CONFIG_GLOBAL: "/poison/gitconfig",
    GIT_CONFIG_COUNT: "1",
    ANTHROPIC_API_KEY: "preserved-anthropic-auth",
  } as const;
  const previous = Object.fromEntries(Object.keys(poisoned).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, poisoned);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
printf '{"type":"env_check","gh_token":"%s","github_token":"%s","github_enterprise_token":"%s","gh_config_dir":"%s","gh_host":"%s","git_askpass":"%s","git_config_global":"%s","git_config_count":"%s","anthropic_api_key":"%s","guard_mode":"%s","worktree_root":"%s"}\\n' "\${GH_TOKEN-unset}" "\${GITHUB_TOKEN-unset}" "\${GITHUB_ENTERPRISE_TOKEN-unset}" "\${GH_CONFIG_DIR-unset}" "\${GH_HOST-unset}" "\${GIT_ASKPASS-unset}" "\${GIT_CONFIG_GLOBAL-unset}" "\${GIT_CONFIG_COUNT-unset}" "\${ANTHROPIC_API_KEY-unset}" "\${SAPWOOD_GUARD_MODE-unset}" "\${SAPWOOD_WORKTREE_ROOT-unset}"
echo '{"type":"result","subtype":"success","total_cost_usd":0}'
exit 0
`,
    );
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    const envCheck = JSON.parse(readFileSync(join(dir, `${result.name}.jsonl`), "utf8").split("\n")[0]!);
    assert.deepEqual(envCheck, {
      type: "env_check",
      gh_token: "unset",
      github_token: "unset",
      github_enterprise_token: "unset",
      gh_config_dir: "unset",
      gh_host: "unset",
      git_askpass: "unset",
      git_config_global: "unset",
      git_config_count: "unset",
      anthropic_api_key: "preserved-anthropic-auth",
      guard_mode: "hard",
      // #235 PR-A: the resolved absolute worktree path for THIS session, so the guard hook
      // can confine Read/Grep/Glob to it.
      worktree_root: join(dir, "worktrees", result.name),
    });
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #236: ambient-context manifest assembly, wired through the REAL RoleRunner.run() path ────

test("run: assembles a context manifest from the real environment — repo CLAUDE.md family (incl. .claude/CLAUDE.md + NESTED rules/**/*.md) + auto-memory MEMORY.md snapshotted, model/CLI version/tools/mcp from the session's own init report, captureBasis init-observed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  const worktreeRoot = join(dir, "worktrees");
  const memDir = join(dir, "memory");
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
wt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--worktree" ]; then wt="$arg"; fi
  prev="$arg"
done
mkdir -p "${worktreeRoot}/$wt/.claude/rules/sub"
printf '# fixture repo conventions\\n' > "${worktreeRoot}/$wt/CLAUDE.md"
printf -- '# fixture .claude/CLAUDE.md\\n' > "${worktreeRoot}/$wt/.claude/CLAUDE.md"
printf -- '- rule one\\n' > "${worktreeRoot}/$wt/.claude/rules/one.md"
printf -- '- nested rule\\n' > "${worktreeRoot}/$wt/.claude/rules/sub/nested.md"
mkdir -p "${memDir}"
printf -- '- fixture memory entry\\n' > "${memDir}/MEMORY.md"
echo '{"type":"system","subtype":"init","model":"claude-stub-model","claude_code_version":"9.9.9","tools":["Read","Write"],"mcp_servers":[{"name":"codegraph","status":"pending"}],"memory_paths":{"auto":"${memDir}/"}}'
echo '{"type":"result","subtype":"success","total_cost_usd":0.0005,"model":"claude-stub-model","usage":{"input_tokens":3,"output_tokens":7}}'
exit 0
`,
    );
    const runner = mkRunner(dir, bin, { preSpawnCaptureTimeoutMs: 3000, preSpawnCapturePollMs: 5 });
    const prompt = "assemble manifest test";
    const result = await runner.run({ roleId: "test-role", prompt, model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "done");
    const manifest = result.contextManifest;
    assert.ok(manifest, "a REAL RoleRunner.run() result always carries a context manifest");

    assert.equal(manifest!.model, "claude-stub-model", "prefers the session's OWN reported model over the requested one");
    assert.equal(manifest!.modelSource, "session-init", "the model came from the session's own init report");
    assert.equal(manifest!.cliVersion, "9.9.9");
    assert.ok(manifest!.toolInventoryHash && manifest!.toolInventoryHash.length === 64);
    assert.equal(manifest!.promptTemplateVersion, createHash("sha256").update(prompt, "utf8").digest("hex"));
    assert.deepEqual(manifest!.mcpTools, ["codegraph:pending"]);
    assert.ok(manifest!.settingsHash.length === 64);
    assert.ok(manifest!.hookHash && manifest!.hookHash.length === 64, "the guard hook file's content is hashed");

    // Codex R1: the capture anchored to the session's own init line, not a filesystem race.
    assert.equal(manifest!.captureBasis, "init-observed");

    const repoClaudeMd = manifest!.sources.find((s) => s.label === "repo CLAUDE.md");
    assert.equal(repoClaudeMd?.kind, "snapshot");
    assert.equal((repoClaudeMd as { content: string }).content, "# fixture repo conventions\n");
    assert.equal((repoClaudeMd as { gitCommit?: string }).gitCommit, undefined, "no real .git in this stub worktree -> unresolvable HEAD");

    // Codex F2a: CLAUDE.local.md is probed (absent here).
    assert.deepEqual(
      manifest!.sources.find((s) => s.label === "repo CLAUDE.local.md"),
      { kind: "absent", label: "repo CLAUDE.local.md", path: join(worktreeRoot, result.name, "CLAUDE.local.md"), reason: "absent" },
    );

    // Codex R2a: <worktree>/.claude/CLAUDE.md is now probed (an officially documented layer the
    // original F2 fix missed).
    const dotClaudeClaudeMd = manifest!.sources.find((s) => s.label === "repo .claude/CLAUDE.md");
    assert.equal(dotClaudeClaudeMd?.kind, "snapshot");
    assert.equal((dotClaudeClaudeMd as { content: string }).content, "# fixture .claude/CLAUDE.md\n");

    // Codex R2b: the rules scan is now RECURSIVE — both the direct child and the nested file
    // under sub/ are captured, not just direct children.
    const rule = manifest!.sources.find((s) => s.label === "repo .claude/rules/one.md");
    assert.equal(rule?.kind, "snapshot");
    assert.equal((rule as { content: string }).content, "- rule one\n");
    const nestedRule = manifest!.sources.find((s) => s.label === "repo .claude/rules/sub/nested.md");
    assert.equal(nestedRule?.kind, "snapshot", "nested rule files are found — the scan is recursive");
    assert.equal((nestedRule as { content: string }).content, "- nested rule\n");

    const memoryMd = manifest!.sources.find((s) => s.label === "auto-memory MEMORY.md");
    assert.equal(memoryMd?.kind, "snapshot");
    assert.equal((memoryMd as { content: string }).content, "- fixture memory entry\n");

    // The user-global CLAUDE.md's presence/content depends on the machine running the test, so
    // only its PRESENCE in the source list (not its content) is asserted — kept hermetic.
    assert.ok(manifest!.sources.some((s) => s.label === "user-global CLAUDE.md"));

    // Codex F2b: probedPaths/knownUnprobed make the manifest's own coverage claim explicit.
    assert.ok(manifest!.probedPaths.includes(join(worktreeRoot, result.name, "CLAUDE.md")));
    assert.ok(manifest!.probedPaths.includes(join(worktreeRoot, result.name, "CLAUDE.local.md")));
    assert.ok(manifest!.probedPaths.includes(join(worktreeRoot, result.name, ".claude", "CLAUDE.md")));
    assert.ok(manifest!.probedPaths.includes(join(worktreeRoot, result.name, ".claude", "rules", "**", "*.md")));
    assert.ok(manifest!.probedPaths.includes(join(worktreeRoot, result.name, ".claude", "rules", "one.md")));
    assert.ok(manifest!.probedPaths.includes(join(worktreeRoot, result.name, ".claude", "rules", "sub", "nested.md")));
    assert.ok(manifest!.knownUnprobed.length > 0);

    // Codex F1: the manifest states its own two-phase capture timing.
    assert.ok(manifest!.capturedPreSpawn.length > 0 && manifest!.capturedPostExit.length > 0);
    assert.ok(manifest!.capturedPreSpawn <= manifest!.capturedPostExit, "filesystem data is captured before the session's self-report");

    assert.deepEqual(manifest!.worktree, {
      path: join(worktreeRoot, result.name),
      head: null,
      headResolution: "unresolved",
      dirty: false,
      dirtyBasis: "structural-no-write-tools",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run (#235 PR-B): a session's Read/Grep tool_use calls land in the manifest's toolUsage/readPaths — the 'what did this session actually use' record, alongside the (unchanged) HEAD/cleanliness capture", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  const worktreeRoot = join(dir, "worktrees");
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
wt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--worktree" ]; then wt="$arg"; fi
  prev="$arg"
done
mkdir -p "${worktreeRoot}/$wt"
echo '{"type":"system","subtype":"init","model":"claude-stub-model"}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"1","name":"Read","input":{"file_path":"src/foo.ts"}}]}}'
echo '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"2","name":"Grep","input":{"pattern":"TODO","path":"src"}}]}}'
echo '{"type":"result","subtype":"success","total_cost_usd":0.0005,"model":"claude-stub-model"}'
exit 0
`,
    );
    const runner = mkRunner(dir, bin, { preSpawnCaptureTimeoutMs: 3000, preSpawnCapturePollMs: 5 });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "done");
    const manifest = result.contextManifest;
    assert.ok(manifest);
    assert.deepEqual(manifest!.toolUsage, [
      { tool: "Read", count: 1 },
      { tool: "Grep", count: 1 },
    ]);
    assert.deepEqual(manifest!.readPaths, ["src", "src/foo.ts"]);
    // The read-only Read/Grep/Glob grant (#235 PR-B's universal baseline) must NOT flip
    // worktree.dirty — that's the hasWriteCapableGrant fix this same PR makes: a non-empty
    // allow-list is no longer synonymous with "write-capable" now that Read/Grep/Glob is the
    // default for every issues-only role.
    assert.equal(manifest!.worktree.dirty, false);
    assert.equal(manifest!.worktree.dirtyBasis, "structural-no-write-tools");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run (#235 PR-B): hasWriteCapableGrant correctly distinguishes a read-only allow-list from a write-capable one — CONFIRM_ALLOWED_TOOLS (Read,Grep,Glob) stays 'clean', a Write/Bash-bearing override (retro's shape) is conservatively 'dirty'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  const worktreeRoot = join(dir, "worktrees");
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
wt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--worktree" ]; then wt="$arg"; fi
  prev="$arg"
done
mkdir -p "${worktreeRoot}/$wt"
echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","subtype":"success","total_cost_usd":0}'
exit 0
`,
    );
    const runner = mkRunner(dir, bin, { preSpawnCaptureTimeoutMs: 3000, preSpawnCapturePollMs: 5 });

    const readOnly = await runner.run({
      roleId: "plan-reviewer-confirm",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      allowedTools: CONFIRM_ALLOWED_TOOLS,
    });
    assert.equal(readOnly.contextManifest!.worktree.dirty, false);
    assert.equal(readOnly.contextManifest!.worktree.dirtyBasis, "structural-no-write-tools");

    const writeCapable = await runner.run({
      roleId: "retro",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      allowedTools: "Read,Write,Edit,Grep,Glob,Bash(git *)",
    });
    assert.equal(writeCapable.contextManifest!.worktree.dirty, true);
    assert.equal(writeCapable.contextManifest!.worktree.dirtyBasis, "unknown-write-capable-session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: CLAUDE_CONFIG_DIR, when set, is the effective user-global config dir instead of ~/.claude (Codex R2c)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  const configDir = mkdtempSync(join(tmpdir(), "sapwood-claude-config-"));
  const previous = process.env.CLAUDE_CONFIG_DIR;
  try {
    writeFileSync(join(configDir, "CLAUDE.md"), "# relocated user-global CLAUDE.md\n");
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const bin = mkStub(dir, FAST_STUB); // no worktree needed for this assertion
    const runner = mkRunner(dir, bin, { preSpawnCaptureTimeoutMs: 500, preSpawnCapturePollMs: 10 });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    const manifest = result.contextManifest;
    assert.ok(manifest);
    const userGlobal = manifest!.sources.find((s) => s.label === "user-global CLAUDE.md");
    assert.equal(userGlobal?.kind, "snapshot");
    assert.equal((userGlobal as { content: string }).content, "# relocated user-global CLAUDE.md\n");
    assert.equal((userGlobal as { path: string }).path, join(configDir, "CLAUDE.md"));
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previous;
    rmSync(dir, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("run: a stub that emits no init line and never creates a worktree still assembles a manifest (captureBasis 'timeout-fallback', honest nulls/empties/'worktree-missing', never a throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB); // no init line, no worktree ever created
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    const manifest = result.contextManifest;
    assert.ok(manifest);
    // Codex R1: no init line ever appeared within the bound -> the honest fallback basis, never
    // silently presented as equally reliable as a real init-anchored capture.
    assert.equal(manifest!.captureBasis, "timeout-fallback");
    assert.equal(manifest!.model, "sonnet", "falls back to the requested model when the session reports none");
    assert.equal(manifest!.modelSource, "requested-fallback");
    assert.equal(manifest!.cliVersion, null);
    assert.equal(manifest!.toolInventoryHash, null);
    assert.deepEqual(manifest!.mcpTools, []);
    assert.equal(manifest!.worktree.head, null);
    // Codex F5d: a worktree that never appeared at all gets its OWN distinct basis, never a
    // plain "clean" or "dirty-because-write-capable" guess.
    assert.equal(manifest!.worktree.dirty, true);
    assert.equal(manifest!.worktree.dirtyBasis, "worktree-missing");
    assert.deepEqual(
      manifest!.sources.find((s) => s.label === "repo CLAUDE.md"),
      { kind: "absent", label: "repo CLAUDE.md", path: join(dir, "worktrees", result.name, "CLAUDE.md"), reason: "absent" },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: a session with a NON-EMPTY allowedTools grant (e.g. retro) records worktree.dirty conservatively — never a false 'definitely clean'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  const worktreeRoot = join(dir, "worktrees");
  try {
    // This stub DOES create its worktree (unlike FAST_STUB) so the "worktree-missing" basis
    // from the test above doesn't mask the write-capable-tools basis this test is about.
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
wt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--worktree" ]; then wt="$arg"; fi
  prev="$arg"
done
mkdir -p "${worktreeRoot}/$wt"
echo '{"type":"system","subtype":"init"}'
echo '{"type":"result","subtype":"success","total_cost_usd":0.0005}'
exit 0
`,
    );
    // The init line (emitted right after the worktree is created, same script) anchors the
    // capture deterministically — no race, no need for a large timeout, but kept generous
    // anyway since the point of this test is the dirty/dirtyBasis derivation, not timing.
    const runner = mkRunner(dir, bin, { preSpawnCaptureTimeoutMs: 3000, preSpawnCapturePollMs: 5 });
    const result = await runner.run({
      roleId: "retro",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      allowedTools: "Read,Write,Bash(git *)",
    });
    const manifest = result.contextManifest;
    assert.ok(manifest);
    assert.equal(manifest!.captureBasis, "init-observed");
    assert.equal(manifest!.worktree.dirty, true, "a write-capable session's worktree can never be assumed clean");
    assert.equal(manifest!.worktree.dirtyBasis, "unknown-write-capable-session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: the init-line anchor is not fooled by the worktree DIRECTORY appearing before CLAUDE.md is written (Codex R1 deflake — the exact race a directory-existence anchor would have lost)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  const worktreeRoot = join(dir, "worktrees");
  try {
    // Deliberately reproduces the pre-fix race window: the worktree directory exists for a
    // moment with NO CLAUDE.md in it (a directory-existence poll could sample exactly here and
    // record CLAUDE.md as absent), and only afterward is CLAUDE.md written and the init line
    // emitted. The init-line anchor must never capture before that write completes.
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
wt=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--worktree" ]; then wt="$arg"; fi
  prev="$arg"
done
mkdir -p "${worktreeRoot}/$wt"
sleep 0.2
printf '# written after a delay\\n' > "${worktreeRoot}/$wt/CLAUDE.md"
echo '{"type":"system","subtype":"init","model":"claude-stub-model"}'
echo '{"type":"result","subtype":"success","total_cost_usd":0.0005}'
exit 0
`,
    );
    const runner = mkRunner(dir, bin, { preSpawnCaptureTimeoutMs: 3000, preSpawnCapturePollMs: 5 });
    const result = await runner.run({ roleId: "test-role", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    const manifest = result.contextManifest;
    assert.ok(manifest);
    assert.equal(manifest!.captureBasis, "init-observed");
    const repoClaudeMd = manifest!.sources.find((s) => s.label === "repo CLAUDE.md");
    assert.equal(repoClaudeMd?.kind, "snapshot", "CLAUDE.md must be captured, never raced as absent");
    assert.equal((repoClaudeMd as { content: string }).content, "# written after a delay\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: non-zero exit -> outcome failed, .failed sentinel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nexit 3\n`);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "failed");
    assert.equal(result.exitCode, 3);
    assert.ok(existsSync(join(dir, `${result.name}.failed.json`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: wall-clock timeout kills the tree -> outcome timeout, tagged as a .failed sentinel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap '' TERM\nsleep 30\n`); // ignores TERM -> needs the KILL
    const tcfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { timeoutSec: 1 }, // fires on the first heartbeat tick after 1s elapsed
    });
    const runner = new RoleRunner({
      cfg: tcfg,
      stateDir: dir,
      worktreeRoot: join(dir, "worktrees"),
      claudeBin: bin,
      heartbeatMs: 100,
      guardHookPath: mkHook(dir),
      preSpawnCaptureTimeoutMs: 150,
      preSpawnCapturePollMs: 10,
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "timeout");
    assert.ok(existsSync(join(dir, `${result.name}.failed.json`)));
    const sentinel = JSON.parse(readFileSync(join(dir, `${result.name}.failed.json`), "utf8"));
    assert.equal(sentinel.timed_out, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: two sequential sessions for the same role never collide (random per-run suffix)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const runner = mkRunner(dir, bin);
    const a = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    const b = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.notEqual(a.name, b.name);
    assert.ok(existsSync(join(dir, `${a.name}.done.json`)));
    assert.ok(existsSync(join(dir, `${b.name}.done.json`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: #110 PR1 — resultText carries the stub's final structured-output text (parseResultText's read side, now wired to a real caller)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const resultText = '<<<SAPWOOD_RESULT>>>\\n{\\"decision\\":\\"approve\\",\\"issue\\":1}\\n<<<END_SAPWOOD_RESULT>>>';
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\necho '{"type":"result","subtype":"success","total_cost_usd":0.001,"result":"${resultText}"}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.resultText, '<<<SAPWOOD_RESULT>>>\n{"decision":"approve","issue":1}\n<<<END_SAPWOOD_RESULT>>>');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run: #110 PR1 — no result line at all (e.g. a crashed session) -> resultText is "", never undefined', async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nexit 1\n`);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "failed");
    assert.equal(result.resultText, "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: guard hook missing in hard mode -> throws, refuses to spawn an unguarded session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const runner = new RoleRunner({
      cfg,
      stateDir: dir,
      worktreeRoot: join(dir, "worktrees"),
      claudeBin: bin,
      guardHookPath: join(dir, "nonexistent-hook.js"),
      preSpawnCaptureTimeoutMs: 150,
      preSpawnCapturePollMs: 10,
    });
    await assert.rejects(
      () => runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" }),
      /guard hook not found/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: soft guard mode tolerates a missing hook (no fail-closed refusal)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const softCfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, guard: { mode: "soft" } });
    const runner = new RoleRunner({
      cfg: softCfg,
      stateDir: dir,
      worktreeRoot: join(dir, "worktrees"),
      claudeBin: bin,
      guardHookPath: join(dir, "nonexistent-hook.js"),
      preSpawnCaptureTimeoutMs: 150,
      preSpawnCapturePollMs: 10,
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: argv scopes the session to READ-ONLY, no Bash grant at all (#235 PR-B) — Read/Grep/Glob allowed, everything write/exec-shaped cross-source-vetoed, no PR/review/merge capability, no --add-dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    const at = (flag: string): string => seen[seen.indexOf(flag) + 1] ?? "";
    assert.equal(at("--allowedTools"), ROLE_ALLOWED_TOOLS);
    assert.equal(
      at("--allowedTools"),
      "Read,Grep,Glob",
      "#235 PR-B: explicit read-only allow, confined to the worktree by PR-A's guard containment",
    );
    assert.equal(at("--disallowedTools"), ROLE_DISALLOWED_TOOLS);
    assert.equal(at("--disallowedTools"), "Write,Edit,MultiEdit,NotebookEdit,Bash", "#235 PR-B: blanket Bash deny, not a pattern list");
    assert.equal(at("--fallback-model"), "sonnet");
    assert.ok(!seen.includes("--add-dir"), "never mounts the engine's data dir");
    // No merge/review/PR capability anywhere in the tool-scoping strings (the acceptance
    // criterion: "generated settings for a peripheral session contain no merge/review
    // capability").
    assert.ok(!/gh pr merge|gh pr review|gh pr ready/.test(ROLE_ALLOWED_TOOLS + ROLE_DISALLOWED_TOOLS));
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("Bash("), "#235 PR-B: allowed tools carry NO Bash(...) entry at all");
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("Write") && !ROLE_ALLOWED_TOOLS.includes("Edit"), "read-only — no write channel");
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("git"), "allowed tools carry no git/code-execution capability");
    // #235 PR-B: the deny list is the bare tool name, not a `Bash(...)` pattern — a blanket veto
    // that subsumes every prior gh-specific pattern deny (#101/#102's --body-file/-F/-l/-p
    // bypass classes are moot when there is no Bash grant to reach `gh` through at all).
    assert.ok(ROLE_DISALLOWED_TOOLS.split(",").includes("Bash"), "bare Bash tool name denied, not a pattern");
    assert.ok(!ROLE_DISALLOWED_TOOLS.includes("Read"), "#235: Read is no longer denied — it moved to the allow list");
    for (const writeTool of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      assert.ok(ROLE_DISALLOWED_TOOLS.split(",").includes(writeTool), `${writeTool} explicitly denied as a cross-source veto`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: fallbackModel none omits Claude's fallback flag for a role session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "none" });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    assert.ok(!seen.includes("--fallback-model"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PLAN_DRAFTER_DISALLOWED_TOOLS (#235 PR-B): now byte-identical to the base deny list — kept as its OWN named export purely for call-site documentation clarity, a regression trip-wire in its own right", () => {
  assert.equal(PLAN_DRAFTER_DISALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS);
  // Before #235 PR-B this carried EXTRA `Bash(gh issue edit *--add-label/--remove-label*)`
  // patterns (#77 Amendment 2's plan-author ≠ plan-approver chain) — now redundant under the
  // blanket Bash deny (no Bash grant reaches `gh` to mutate a label with in the first place) and
  // dropped; applying plan:approved/needs-human has been the engine's job (plan-review.ts) since
  // #110, never either session's own.
  assert.ok(!PLAN_DRAFTER_DISALLOWED_TOOLS.includes("--add-label"));
  assert.ok(!PLAN_DRAFTER_DISALLOWED_TOOLS.includes("--remove-label"));
});

test("CONFIRM_ALLOWED_TOOLS/CONFIRM_DISALLOWED_TOOLS (#235 PR-B): no longer a widening — #214's freshness-confirm read grant is now the UNIVERSAL peripheral baseline, so this pair is byte-identical to the base, kept as its own named export for call-site clarity only", () => {
  assert.equal(CONFIRM_ALLOWED_TOOLS, ROLE_ALLOWED_TOOLS);
  assert.equal(CONFIRM_ALLOWED_TOOLS, "Read,Grep,Glob");
  assert.ok(!CONFIRM_ALLOWED_TOOLS.includes("Bash("), "no Bash grant of any kind — no git, no gh, no arbitrary command");
  assert.ok(
    !CONFIRM_ALLOWED_TOOLS.includes("Write") && !CONFIRM_ALLOWED_TOOLS.includes("Edit"),
    "read-only — no write channel to the repo",
  );
  assert.equal(CONFIRM_DISALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS);
  assert.ok(!CONFIRM_DISALLOWED_TOOLS.split(",").includes("Read"), "Read is not denied — it's the whole point of this role's grant");
  for (const writeTool of ["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"]) {
    assert.ok(CONFIRM_DISALLOWED_TOOLS.split(",").includes(writeTool), `base denial preserved: ${writeTool}`);
  }
});

test("run: a per-role disallowedTools override reaches the argv (the drafter's stricter deny-list path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    await runner.run({
      roleId: "plan-drafter",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      disallowedTools: PLAN_DRAFTER_DISALLOWED_TOOLS,
    });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    assert.equal(seen[seen.indexOf("--disallowedTools") + 1], PLAN_DRAFTER_DISALLOWED_TOOLS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PO_ALLOWED_TOOLS: #110 PR5 — no Bash grant at all (issue creation is now an engine-performed write, align.ts's validated structured output) — no board-status/PR/code capability anywhere", () => {
  assert.equal(PO_ALLOWED_TOOLS, ROLE_ALLOWED_TOOLS, "identical to the base (empty) allow-list");
  assert.ok(!PO_ALLOWED_TOOLS.includes("Bash("), "no Bash(...) entry of any kind");
  assert.ok(!PO_ALLOWED_TOOLS.includes("gh issue create"), "issue creation is an engine write, not a session tool call");
  assert.ok(!PO_ALLOWED_TOOLS.includes("gh api"), "no channel to setBoardStatus (locked decision 5: PO never sets Ready)");
  assert.ok(!PO_ALLOWED_TOOLS.includes("gh pr"), "no PR capability");
  assert.ok(!PO_ALLOWED_TOOLS.includes("git"), "no code/repo capability");
});

test("PO_DISALLOWED_TOOLS (#235 PR-B): now byte-identical to the base deny list — kept as its own named export for call-site clarity only", () => {
  assert.equal(PO_DISALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS);
  // Before #235 PR-B this carried EXTRA `Bash(gh issue create *--body-file/--label/--project*)`
  // patterns (#101/#102), closing flag holes the OLD (narrower) allow-list opened. Those are now
  // REDUNDANT — see the next test.
  assert.ok(!PO_DISALLOWED_TOOLS.includes("--body-file"));
  assert.ok(!PO_DISALLOWED_TOOLS.includes("--label"));
  assert.ok(!PO_DISALLOWED_TOOLS.includes("--project"));
});

// ── #101/#102 (historical context, now closed STRUCTURALLY, not by pattern): the old
// `Bash(gh issue create *--body-file*)`-shaped denies (and their `-F`/`-l`/`-p` short-flag
// counterparts) existed to block flag-shaped bypasses of a `gh` command a role session's
// allow-list otherwise granted. #235 PR-B removes the Bash grant those bypasses needed to reach
// `gh` THROUGH at all — the deny list's `Bash` entry below is the BARE tool name, not a pattern,
// so it matches every possible `gh` invocation (and every other Bash invocation) without needing
// to enumerate flag shapes. This subsumes the entire #101/#102 bypass class by construction. ──

test("#101/#102 bypass class closed structurally (#235 PR-B): every peripheral role's deny list carries the bare `Bash` tool name — no `Bash(...)` pattern anywhere could leave a gap for a flag-shaped bypass (`-F`/`-l`/`-p`/`--body-file`/`--label`/`--project`) to slip through, because there is no Bash grant to slip through in the first place", () => {
  for (const [name, denyList] of Object.entries({
    ROLE_DISALLOWED_TOOLS,
    PLAN_DRAFTER_DISALLOWED_TOOLS,
    PO_DISALLOWED_TOOLS,
    CONFIRM_DISALLOWED_TOOLS,
  })) {
    assert.ok(denyList.split(",").includes("Bash"), `${name} carries the blanket Bash deny`);
  }
  for (const [name, allowList] of Object.entries({ ROLE_ALLOWED_TOOLS, PO_ALLOWED_TOOLS, CONFIRM_ALLOWED_TOOLS })) {
    assert.ok(!allowList.includes("Bash("), `${name} grants no Bash(...) entry — nothing for a flag bypass to exploit`);
  }
});

test("run: the PO's allowedTools + disallowedTools pair BOTH reach the argv (the align/triage session wiring) — #235 PR-B: the allow half carries Read/Grep/Glob and no Bash grant", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    await runner.run({
      roleId: "po-align",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      allowedTools: PO_ALLOWED_TOOLS,
      disallowedTools: PO_DISALLOWED_TOOLS,
    });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    assert.equal(seen[seen.indexOf("--allowedTools") + 1], PO_ALLOWED_TOOLS);
    assert.equal(seen[seen.indexOf("--allowedTools") + 1], "Read,Grep,Glob");
    assert.equal(seen[seen.indexOf("--disallowedTools") + 1], PO_DISALLOWED_TOOLS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: the confirm session's allowedTools + disallowedTools pair BOTH reach the argv (#214 gate② review P1, #235 PR-B) — exactly CONFIRM_ALLOWED_TOOLS/CONFIRM_DISALLOWED_TOOLS, now identical to every other peripheral role's baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    await runner.run({
      roleId: "plan-reviewer-confirm",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      allowedTools: CONFIRM_ALLOWED_TOOLS,
      disallowedTools: CONFIRM_DISALLOWED_TOOLS,
    });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    assert.equal(seen[seen.indexOf("--allowedTools") + 1], CONFIRM_ALLOWED_TOOLS);
    assert.equal(seen[seen.indexOf("--allowedTools") + 1], "Read,Grep,Glob");
    assert.equal(seen[seen.indexOf("--disallowedTools") + 1], CONFIRM_DISALLOWED_TOOLS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: a per-role allowedTools override reaches the argv (#91 — retro's wider git+PR-create scope)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    const widerScope = "Read,Write,Edit,Bash(git *),Bash(gh pr create*)";
    await runner.run({
      roleId: "retro",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      allowedTools: widerScope,
      disallowedTools: "Bash(gh pr merge*)",
    });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    assert.equal(seen[seen.indexOf("--allowedTools") + 1], widerScope);
    assert.equal(seen[seen.indexOf("--disallowedTools") + 1], "Bash(gh pr merge*)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: the ephemeral worktree is always deleted afterward — a role session never has WIP worth retaining", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const worktreeRoot = join(dir, "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
prev=""
wt=""
for a in "$@"; do
  if [ "$prev" = "--worktree" ]; then wt="$a"; fi
  prev="$a"
done
mkdir -p "${worktreeRoot}/$wt"
touch "${worktreeRoot}/$wt/marker"
echo '{"type":"result","total_cost_usd":0}'
exit 0
`,
    );
    const runner = new RoleRunner({
      cfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: bin,
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      preSpawnCaptureTimeoutMs: 150,
      preSpawnCapturePollMs: 10,
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.ok(!existsSync(join(worktreeRoot, result.name)), "worktree removed unconditionally after run()");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #111 PR-B: the scratch-file return channel — read BEFORE the worktree's deletion ────────

test("run: scratchFile is read from the session's worktree before deletion — scratchText carries its raw content, worktree still deleted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const worktreeRoot = join(dir, "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    // Stub session: writes the scratch file into its own worktree (same --worktree discovery
    // as the deletion test above), exactly like retro's real session would after its push.
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
prev=""
wt=""
for a in "$@"; do
  if [ "$prev" = "--worktree" ]; then wt="$a"; fi
  prev="$a"
done
mkdir -p "${worktreeRoot}/$wt"
printf 'branch: retro/x\\ntitle: t\\n\\nbody line\\n' > "${worktreeRoot}/$wt/.sapwood-retro-pr"
echo '{"type":"result","total_cost_usd":0}'
exit 0
`,
    );
    const runner = new RoleRunner({
      cfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: bin,
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      preSpawnCaptureTimeoutMs: 150,
      preSpawnCapturePollMs: 10,
    });
    const result = await runner.run({
      roleId: "retro",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      scratchFile: ".sapwood-retro-pr",
    });
    assert.equal(result.scratchText, "branch: retro/x\ntitle: t\n\nbody line\n");
    assert.ok(!existsSync(join(worktreeRoot, result.name)), "worktree still deleted after the scratch read");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: scratchFile requested but the session never wrote it — scratchText is undefined, never a throw", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB); // writes no worktree file at all
    const runner = mkRunner(dir, bin);
    const result = await runner.run({
      roleId: "retro",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      scratchFile: ".sapwood-retro-pr",
    });
    assert.equal(result.outcome, "done");
    assert.equal(result.scratchText, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Codex round 1 (PR #119): scratchFile path containment — "inside the worktree" is enforced by
// run() itself. A `../`-escaping or absolute scratchFile must NEVER be read, even when the file
// it resolves to genuinely exists outside the worktree root.

test("run: a ../-escaping scratchFile is refused — the outside file is NOT read even though it exists, scratchText stays undefined", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const worktreeRoot = join(dir, "worktrees");
    mkdirSync(worktreeRoot, { recursive: true });
    // A real file OUTSIDE every session worktree (a sibling of worktreeRoot itself) — the
    // exact target a `../../secret` scratchFile would resolve to from <worktreeRoot>/<name>/.
    writeFileSync(join(dir, "secret"), "engine-private content");
    const bin = mkStub(dir, FAST_STUB);
    const runner = new RoleRunner({
      cfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: bin,
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      preSpawnCaptureTimeoutMs: 150,
      preSpawnCapturePollMs: 10,
    });
    const result = await runner.run({
      roleId: "retro",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      scratchFile: "../../secret",
    });
    assert.equal(result.outcome, "done");
    assert.equal(result.scratchText, undefined, "an escaping path must read as absent, never as the outside file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: an absolute scratchFile is refused — scratchText stays undefined even though the target exists", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const outside = join(dir, "absolute-target");
    writeFileSync(outside, "outside content");
    const bin = mkStub(dir, FAST_STUB);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({
      roleId: "retro",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      scratchFile: outside,
    });
    assert.equal(result.outcome, "done");
    assert.equal(result.scratchText, undefined, "an absolute path must read as absent, never as its target");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: spend baseline — costUsd is 0 when the stub emits no result line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho 'no json here'\nexit 0\n`);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-drafter", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.costUsd, 0);
    assert.deepEqual(result.modelUsage, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #110 PR0: runSessionWithRetry's `isValid` hook — a fake runner/state, no CLI spawn (the
//    helper itself only touches `Pick<RoleRunner,"run">`/`Pick<State,"recordSpend"|"appendEvent">`,
//    so a real claude-stub binary buys nothing here; contrast the spawn-integration tests above). ──

const mkResult = (over: Partial<RoleSessionResult> = {}): RoleSessionResult => ({
  outcome: "done",
  costUsd: 0,
  modelUsage: [],
  exitCode: 0,
  name: "role-x-1",
  ...over,
});

/** Consumes the next scripted result per call (repeats the last once exhausted) — same
 *  scripted-fake shape align.test.ts/architect.test.ts/plan-review.test.ts use for RoleRunner. */
class FakeRunner {
  calls: RoleSessionOpts[] = [];
  private n = 0;
  constructor(private readonly results: RoleSessionResult[]) {}
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    const r = this.results[Math.min(this.n, this.results.length - 1)]!;
    this.n++;
    return r;
  }
}

class FakeState {
  spends: Array<[string, number, number]> = [];
  events: Array<[string, Record<string, unknown>]> = [];
  recordSpend(worker: string, issue: number, usd: number): void {
    this.spends.push([worker, issue, usd]);
  }
  appendEvent(kind: string, payload: Record<string, unknown>): void {
    this.events.push([kind, payload]);
  }
}

const mkOpts = (runner: FakeRunner, state: FakeState, isValid: RetriedSession["isValid"]): RetriedSession => ({
  runner,
  state,
  session: { roleId: "test-role", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" },
  issue: 0,
  now: () => new Date("2026-07-11T00:00:00Z"),
  degradeEvent: "test-degraded",
  degradePayload: (result) => ({ attempts: 2, exitCode: result.exitCode }),
  degradeMessage: (result) => `test role degraded: ${result.outcome}`,
  ...(isValid !== undefined ? { isValid } : {}),
});

test('runSessionWithRetry + isValid: a valid "done" result on the FIRST attempt — no retry, no degrade', async () => {
  const runner = new FakeRunner([mkResult()]);
  const state = new FakeState();
  const result = await runSessionWithRetry(mkOpts(runner, state, () => true));
  assert.equal(runner.calls.length, 1);
  assert.equal(state.events.length, 0);
  assert.equal(result.outcome, "done");
});

test('runSessionWithRetry + isValid: "done" but invalid on attempt 1, valid on attempt 2 — exactly one retry, no degrade event', async () => {
  const runner = new FakeRunner([mkResult({ name: "role-x-1" }), mkResult({ name: "role-x-2" })]);
  const state = new FakeState();
  let calls = 0;
  const result = await runSessionWithRetry(
    mkOpts(runner, state, () => {
      calls++;
      return calls >= 2;
    }),
  );
  assert.equal(runner.calls.length, 2, "invalid first attempt triggers exactly one retry");
  assert.equal(state.events.length, 0, "eventually-valid result never degrades");
  assert.equal(state.spends.length, 2, "spend is recorded for BOTH attempts regardless of validity");
  assert.equal(result.name, "role-x-2");
});

test('runSessionWithRetry + isValid: "done" but invalid on BOTH attempts — degrades exactly like a non-"done" outcome (event + message)', async () => {
  const runner = new FakeRunner([mkResult(), mkResult()]);
  const state = new FakeState();
  const result = await runSessionWithRetry(mkOpts(runner, state, () => false));
  assert.equal(runner.calls.length, 2);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0]![0], "test-degraded");
  assert.deepEqual(state.events[0]![1], { attempts: 2, exitCode: result.exitCode });
  assert.equal(result.outcome, "done"); // last attempt's raw result is still returned as-is
});

test("runSessionWithRetry + isValid: a THROWING validator counts as invalid — throws twice -> degrade event, never a propagated exception (Codex round 1 P2)", async () => {
  const runner = new FakeRunner([mkResult(), mkResult()]);
  const state = new FakeState();
  // Must resolve normally (a propagated throw would wedge the round, violating #110's
  // "malformed output twice -> degrade path, never a wedged round").
  const result = await runSessionWithRetry(
    mkOpts(runner, state, () => {
      throw new Error("zod.parse blew up");
    }),
  );
  assert.equal(runner.calls.length, 2, "a throwing validator still drives the retry-once path");
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0]![0], "test-degraded");
  assert.equal(result.outcome, "done"); // last attempt's raw result still returned as-is
});

test("runSessionWithRetry + isValid: throws on attempt 1, valid on attempt 2 — one retry, no degrade event", async () => {
  const runner = new FakeRunner([mkResult({ name: "role-x-1" }), mkResult({ name: "role-x-2" })]);
  const state = new FakeState();
  let calls = 0;
  const result = await runSessionWithRetry(
    mkOpts(runner, state, () => {
      calls++;
      if (calls === 1) throw new Error("malformed first output");
      return true;
    }),
  );
  assert.equal(runner.calls.length, 2, "the throw triggers exactly one retry");
  assert.equal(state.events.length, 0, "an eventually-valid result never degrades");
  assert.equal(result.name, "role-x-2");
});

test("runSessionWithRetry: isValid OMITTED — behavior is byte-identical to today (only `outcome` decides done vs. not-done)", async () => {
  // A "done" outcome with no isValid never retries, exactly like before #110.
  const doneRunner = new FakeRunner([mkResult({ outcome: "done" })]);
  const doneState = new FakeState();
  await runSessionWithRetry(mkOpts(doneRunner, doneState, undefined));
  assert.equal(doneRunner.calls.length, 1);
  assert.equal(doneState.events.length, 0);

  // A "failed" outcome with no isValid still retries once, then degrades on a second failure —
  // the pre-#110 behavior, untouched.
  const failRunner = new FakeRunner([mkResult({ outcome: "failed" }), mkResult({ outcome: "failed" })]);
  const failState = new FakeState();
  await runSessionWithRetry(mkOpts(failRunner, failState, undefined));
  assert.equal(failRunner.calls.length, 2);
  assert.equal(failState.events.length, 1);
  assert.equal(failState.events[0]![0], "test-degraded");
});

// ── #236: runSessionWithRetry's OPTIONAL context-manifest recording — round/phase key prefix
//    supplied by the caller, role/session/attempt filled in here. Omitted -> zero behavior
//    change (every test above never sets it and never touches `record`). ──

interface RecordedManifest {
  key: { roundId: number; phase: string; role: string; session: string; attempt: number };
  json: string;
  at: string;
}

/** A structurally-valid ContextManifest whose `model` field doubles as a distinguishing tag —
 *  so a test can assert two attempts' recorded json payloads actually differ (ambient drift). */
const mkManifest = (tag: string): ContextManifest => ({
  sources: [],
  probedPaths: [],
  knownUnprobed: "imports, ancestor dirs, managed policy",
  capturedPreSpawn: "2026-07-17T00:00:00Z",
  capturedPostExit: "2026-07-17T00:00:01Z",
  captureBasis: "init-observed",
  model: tag,
  modelSource: "requested-fallback",
  cliBin: "claude",
  cliVersion: null,
  toolInventoryHash: null,
  promptTemplateVersion: null,
  mcpTools: [],
  worktree: { path: "/wt", head: null, headResolution: "unresolved", dirty: false, dirtyBasis: "structural-no-write-tools" },
  settingsHash: "hash",
  hookHash: null,
  recordedAt: "2026-07-17T00:00:01Z",
});

const mkManifestResult = (manifestTag: string, over: Partial<RoleSessionResult> = {}): RoleSessionResult =>
  mkResult({ contextManifest: mkManifest(manifestTag), ...over });

test("runSessionWithRetry + contextManifest: BOTH attempts are recorded independently — two attempts of one phase are reconstructable, ambient drift visible", async () => {
  const runner = new FakeRunner([mkManifestResult("attempt-1", { name: "role-x-1" }), mkManifestResult("attempt-2", { name: "role-x-2" })]);
  const state = new FakeState();
  const recorded: RecordedManifest[] = [];
  const opts: RetriedSession = {
    ...mkOpts(runner, state, () => false), // always invalid -> forces exactly 2 attempts
    contextManifest: { roundId: 42, phase: "harvesting", record: (key, json, at) => recorded.push({ key, json, at }) },
  };
  await runSessionWithRetry(opts);
  assert.equal(runner.calls.length, 2);
  assert.equal(recorded.length, 2, "every attempt is recorded, not just the last one");

  assert.equal(recorded[0]!.key.roundId, 42);
  assert.equal(recorded[0]!.key.phase, "harvesting");
  assert.equal(recorded[0]!.key.role, "test-role", "role comes from session.roleId");
  assert.equal(recorded[0]!.key.session, "role-x-1", "session comes from THAT attempt's own result name");
  assert.equal(recorded[0]!.key.attempt, 1);

  assert.equal(recorded[1]!.key.session, "role-x-2");
  assert.equal(recorded[1]!.key.attempt, 2);

  // Independently reconstructable: each row's json is that attempt's OWN manifest, not a shared
  // reference — ambient drift between attempt 1 and attempt 2 is visible in the two payloads.
  assert.notEqual(recorded[0]!.json, recorded[1]!.json);
  assert.match(recorded[0]!.json, /attempt-1/);
  assert.match(recorded[1]!.json, /attempt-2/);
});

test("runSessionWithRetry + contextManifest: a first attempt that succeeds immediately still records exactly one manifest", async () => {
  const runner = new FakeRunner([mkManifestResult("only-attempt")]);
  const state = new FakeState();
  const recorded: RecordedManifest[] = [];
  const opts: RetriedSession = {
    ...mkOpts(runner, state, () => true),
    contextManifest: { roundId: 1, phase: "aligning", record: (key, json, at) => recorded.push({ key, json, at }) },
  };
  await runSessionWithRetry(opts);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0]!.key.attempt, 1);
});

test("runSessionWithRetry + contextManifest: omitted -> record is never called (zero behavior change)", async () => {
  const runner = new FakeRunner([mkManifestResult("x")]);
  const state = new FakeState();
  await runSessionWithRetry(mkOpts(runner, state, () => true));
  // No `contextManifest` field on opts at all — nothing to assert beyond "this doesn't throw
  // and behaves like every other isValid test above" (already covered by mkOpts' shape).
  assert.equal(runner.calls.length, 1);
});

test("runSessionWithRetry + contextManifest: the runner's result carries NO manifest (e.g. a bare test fake) -> record is never called", async () => {
  const runner = new FakeRunner([mkResult()]); // no contextManifest field at all
  const state = new FakeState();
  const recorded: RecordedManifest[] = [];
  const opts: RetriedSession = {
    ...mkOpts(runner, state, () => true),
    contextManifest: { roundId: 1, phase: "aligning", record: (key, json, at) => recorded.push({ key, json, at }) },
  };
  await runSessionWithRetry(opts);
  assert.equal(recorded.length, 0);
});

test("runSessionWithRetry + contextManifest: a THROWING record() is non-fatal — never propagates, never blocks retry/degrade", async () => {
  const runner = new FakeRunner([mkManifestResult("a"), mkManifestResult("b")]);
  const state = new FakeState();
  const opts: RetriedSession = {
    ...mkOpts(runner, state, () => false),
    contextManifest: {
      roundId: 1,
      phase: "aligning",
      record: () => {
        throw new Error("db write failed");
      },
    },
  };
  const result = await runSessionWithRetry(opts); // must resolve normally
  assert.equal(runner.calls.length, 2);
  assert.equal(state.events.length, 1, "the normal degrade path still fires — a manifest-write failure never wedges it");
  assert.equal(result.outcome, "done");
});

// ── #110 PR5: acceptance-criteria tests (issue #110's verification plan: "an integration test
// asserting a role session is spawned with empty Bash grants and a structured-output round-trip
// works end-to-end") ───────────────────────────────────────────────────────────────────────────

test("#110/#235 acceptance sweep: no issues-only role's allowedTools constant contains a Bash( entry, and every one is exactly the read-only Read/Grep/Glob baseline (retro excepted — its own wider RETRO_ALLOWED_TOOLS is asserted separately in retro.test.ts)", () => {
  // Every allow-list-shaped export peripheral.ts/align.ts's roles actually wire into a session —
  // harvest.ts/architect.ts/plan-review.ts's reviewer never override allowedTools at all (see
  // architect.test.ts's/plan-review.test.ts's own "no override passed" assertions), so they fall
  // back to ROLE_ALLOWED_TOOLS below unconditionally; PO/align+triage/confirm are the roles with
  // their own named exports (PO_ALLOWED_TOOLS/CONFIRM_ALLOWED_TOOLS). retro.ts's
  // RETRO_ALLOWED_TOOLS is DELIBERATELY excluded — retro is worker-class (Write/git), out of
  // this sweep's scope, asserted separately in retro.test.ts.
  const issuesOnlyAllowedTools: Record<string, string> = { ROLE_ALLOWED_TOOLS, PO_ALLOWED_TOOLS, CONFIRM_ALLOWED_TOOLS };
  for (const [name, tools] of Object.entries(issuesOnlyAllowedTools)) {
    assert.ok(!tools.includes("Bash("), `${name} must carry no Bash(...) allow-list entry, got: ${tools}`);
    assert.equal(tools, "Read,Grep,Glob", `${name} must be exactly the read-only baseline (#235 PR-B), no write/exec grant at all`);
  }
});

test("#110/#235 final integration: a role session spawns with a read-only (no Bash) grant, emits a valid structured-output block, the engine's real validator (plan-review.ts) accepts it, and the resulting write reaches the forge", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const issueNumber = 42;
    const revisedBody = "## Verification\n- run `npm test`, confirm green CI\n- confirm the acceptance criteria above\n";
    const resultText =
      `<<<SAPWOOD_RESULT>>>\n${JSON.stringify({ decision: "approve", issue: issueNumber })}\n<<<END_SAPWOOD_RESULT>>>\n` +
      `<<<BODY>>>\n${revisedBody}\n<<<END_BODY>>>`;
    const jsonLine = JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.002, result: resultText });
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '${jsonLine.replace(/'/g, "'\\''")}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);

    // 1. SPAWN: a real plan-reviewer role session under the DEFAULT (no override) allow/deny
    // pair — the #235 PR-B acceptance criterion: read-only Read/Grep/Glob reaches the argv, no
    // Bash(...) grant anywhere.
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "done");
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    const allowedArgv = seen[seen.indexOf("--allowedTools") + 1];
    assert.equal(allowedArgv, "Read,Grep,Glob", "the read-only baseline reaches the argv verbatim");
    assert.ok(!(allowedArgv ?? "").includes("Bash("), "acceptance criterion: no Bash(...) entry anywhere in the argv");

    // 2. VALIDATE: the engine's REAL validator (plan-review.ts's validateReviewerOutput, not a
    // re-implementation) — schema-valid AND content-verified (the approve claim's revised body
    // actually carries a verification-plan section, extractVerificationPlan re-checked).
    const validated = validateReviewerOutput(result.resultText ?? "", issueNumber, "");
    assert.equal(validated.ok, true, "a well-formed approve+verification-plan output validates");
    if (!validated.ok) return; // unreachable — narrows the type for the write assertions below
    assert.equal(validated.decision.decision, "approve");
    assert.equal(validated.decision.body, revisedBody);

    // 3. WRITE: the engine performs the forge write from the validated decision alone — the
    // session itself never touched `gh` (no Bash grant to touch it with, step 1 above). Mirrors
    // plan-review.ts's reviewOneIssue "approve" branch exactly (updateIssueBody + plan:approved).
    const forgeWrites = { updateIssueBody: [] as Array<[number, string]>, labelsAdded: [] as Array<[number, string]> };
    const forge = {
      updateIssueBody: async (n: number, body: string): Promise<void> => {
        forgeWrites.updateIssueBody.push([n, body]);
      },
      addLabel: async (n: number, l: string): Promise<void> => {
        forgeWrites.labelsAdded.push([n, l]);
      },
    };
    if (validated.decision.body !== undefined) await forge.updateIssueBody(issueNumber, validated.decision.body);
    await forge.addLabel(issueNumber, "plan:approved");

    assert.deepEqual(forgeWrites.updateIssueBody, [[issueNumber, revisedBody]]);
    assert.deepEqual(forgeWrites.labelsAdded, [[issueNumber, "plan:approved"]]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #234: forge MCP proxy wiring — mint/inject/widen-allowedTools/revoke-on-teardown ────────

function fakeProxyHandle(over: Partial<{ mcpConfigJson: string; toolNames: string[] }> = {}) {
  const calls = { minted: 0, stopped: 0 };
  const handle = {
    mcpConfigJson: JSON.stringify({
      mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer proxy-test-token" } } },
    }),
    toolNames: ["mcp__forge__issue_details", "mcp__forge__issue_comments", "mcp__forge__issue_relations", "mcp__forge__search_issues"],
    ...over,
    stop: async () => {
      calls.stopped++;
    },
  };
  return { calls, handle };
}

test("run: a proxy opt mints a handle, widens allowedTools with mcp__forge__* tool names, and injects --mcp-config inline JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    const { calls, handle } = fakeProxyHandle();
    let mintedFor: { role: string; session: string } | undefined;
    const result = await runner.run({
      roleId: "architect",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      proxy: {
        mint: async (session) => {
          mintedFor = session;
          calls.minted++;
          return handle as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof runner.run>[0]["proxy"]>["mint"]>>;
        },
      },
    });
    assert.equal(calls.minted, 1);
    assert.equal(mintedFor?.role, "architect");
    assert.equal(mintedFor?.session, result.name);
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    const allowedTools = seen[seen.indexOf("--allowedTools") + 1] ?? "";
    for (const t of handle.toolNames) assert.ok(allowedTools.includes(t), `${t} missing from allowedTools: ${allowedTools}`);
    const mcpConfigIdx = seen.indexOf("--mcp-config");
    assert.ok(mcpConfigIdx !== -1);
    assert.equal(seen[mcpConfigIdx + 1], handle.mcpConfigJson);
    assert.equal(calls.stopped, 1, "the proxy is torn down once the session exits");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: proxy teardown (stop()) happens on EVERY outcome, including a timed-out session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap '' TERM\nsleep 30\n`);
    const tcfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { timeoutSec: 1 } });
    const runner = new RoleRunner({
      cfg: tcfg,
      stateDir: dir,
      worktreeRoot: join(dir, "worktrees"),
      claudeBin: bin,
      heartbeatMs: 100,
      guardHookPath: mkHook(dir),
      preSpawnCaptureTimeoutMs: 150,
      preSpawnCapturePollMs: 10,
    });
    const { calls, handle } = fakeProxyHandle();
    const result = await runner.run({
      roleId: "architect",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      proxy: { mint: async () => handle as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof runner.run>[0]["proxy"]>["mint"]>> },
    });
    assert.equal(result.outcome, "timeout");
    assert.equal(calls.stopped, 1, "even a timed-out session tears down its proxy");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: a proxy mint FAILURE is non-fatal — the session still runs to completion, unattached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    const result = await runner.run({
      roleId: "architect",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      proxy: {
        mint: async () => {
          throw new Error("simulated bind failure");
        },
      },
    });
    assert.equal(result.outcome, "done");
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    assert.ok(!seen.includes("--mcp-config"), "no proxy attached -> no --mcp-config flag");
    assert.equal(seen[seen.indexOf("--allowedTools") + 1], ROLE_ALLOWED_TOOLS, "falls back to the base allowedTools, unwidened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: #234 F5 (PR #252 review, P1, Codex #6) — a SPAWN FAILURE after a successful proxy mint still tears the proxy down (no leaked listener/token) via the try/finally wrapping every outcome, not just success/timeout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    // A nonexistent claude binary path -> spawnClaudeSession's onError fires -> run() throws
    // "role session spawn failed" BEFORE ever reaching the (old, now-removed) inline teardown
    // block that used to sit after exitPromise resolved.
    const runner = mkRunner(dir, join(dir, "does-not-exist-claude"));
    const { calls, handle } = fakeProxyHandle();
    await assert.rejects(
      () =>
        runner.run({
          roleId: "architect",
          prompt: "p",
          model: "sonnet",
          effort: "medium",
          fallbackModel: "sonnet",
          proxy: {
            mint: async () => {
              calls.minted++;
              return handle as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof runner.run>[0]["proxy"]>["mint"]>>;
            },
          },
        }),
      /spawn failed/i,
    );
    assert.equal(calls.minted, 1);
    assert.equal(calls.stopped, 1, "the proxy is torn down even though run() THREW rather than returned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: #218 regression, extended to a proxy-attached session — the spawn env stays forge/git credential-free, and the proxy's bearer token travels ONLY via --mcp-config, never the env", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  const poisoned = {
    GH_TOKEN: "poison-gh-token",
    GITHUB_TOKEN: "poison-github-token",
    GITHUB_ENTERPRISE_TOKEN: "poison-github-enterprise-token",
    GH_CONFIG_DIR: "/poison/gh-config",
    GH_HOST: "poison.example",
    GIT_ASKPASS: "/poison/askpass",
    GIT_CONFIG_GLOBAL: "/poison/gitconfig",
    GIT_CONFIG_COUNT: "1",
    ANTHROPIC_API_KEY: "preserved-anthropic-auth",
  } as const;
  const previous = Object.fromEntries(Object.keys(poisoned).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, poisoned);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash
env > "${join(dir, "env.seen")}"
echo '{"type":"result","subtype":"success","total_cost_usd":0}'
exit 0
`,
    );
    const runner = mkRunner(dir, bin);
    const { handle } = fakeProxyHandle();
    await runner.run({
      roleId: "architect",
      prompt: "p",
      model: "sonnet",
      effort: "medium",
      fallbackModel: "sonnet",
      proxy: { mint: async () => handle as unknown as Awaited<ReturnType<NonNullable<Parameters<typeof runner.run>[0]["proxy"]>["mint"]>> },
    });
    const envText = readFileSync(join(dir, "env.seen"), "utf8");
    for (const key of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "GH_CONFIG_DIR",
      "GH_HOST",
      "GIT_ASKPASS",
      "GIT_CONFIG_GLOBAL",
    ]) {
      assert.ok(!envText.includes(`${key}=poison`), `${key} leaked into the proxy-attached session's env`);
    }
    assert.ok(envText.includes("ANTHROPIC_API_KEY=preserved-anthropic-auth"), "Claude auth is preserved");
    assert.ok(
      !envText.includes("proxy-test-token"),
      "the proxy's bearer token never reaches the spawn env — it travels via --mcp-config only",
    );
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
