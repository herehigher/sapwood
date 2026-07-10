// peripheral.test.ts (#87): the role runner — a stub `claude` binary (zero token, same
// integration style as worker.test.ts) drives the real spawn/sentinel/timeout/cost-parse path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RoleRunner, ROLE_ALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS, type RoleRunnerDeps,
} from "./peripheral.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

const cfg: SapwoodConfig = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });

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
    cfg, stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin,
    heartbeatMs: 50, guardHookPath: mkHook(dir), ...over,
  });

test("run: stub claude exits 0 -> outcome done, cost/model usage parsed, running sentinel cleared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
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

test("run: non-zero exit -> outcome failed, .failed sentinel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nexit 3\n`);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
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
      cfg: tcfg, stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin: bin,
      heartbeatMs: 100, guardHookPath: mkHook(dir),
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
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
    const a = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    const b = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    assert.notEqual(a.name, b.name);
    assert.ok(existsSync(join(dir, `${a.name}.done.json`)));
    assert.ok(existsSync(join(dir, `${b.name}.done.json`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: guard hook missing in hard mode -> throws, refuses to spawn an unguarded session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const runner = new RoleRunner({
      cfg, stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin: bin,
      guardHookPath: join(dir, "nonexistent-hook.js"),
    });
    await assert.rejects(
      () => runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" }),
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
      cfg: softCfg, stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin: bin,
      guardHookPath: join(dir, "nonexistent-hook.js"),
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    assert.equal(result.outcome, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: argv scopes the session to issues-only writes — no code paths, no PR/review/merge capability, no --add-dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    const at = (flag: string): string => seen[seen.indexOf(flag) + 1] ?? "";
    assert.equal(at("--allowedTools"), ROLE_ALLOWED_TOOLS);
    assert.equal(at("--disallowedTools"), ROLE_DISALLOWED_TOOLS);
    assert.ok(!seen.includes("--add-dir"), "never mounts the engine's data dir");
    // No merge/review/PR capability anywhere in the tool-scoping strings (the acceptance
    // criterion: "generated settings for a peripheral session contain no merge/review
    // capability").
    for (const tools of [ROLE_ALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS]) {
      assert.ok(!/gh pr merge|gh pr review|gh pr ready/.test(tools) || tools === ROLE_DISALLOWED_TOOLS);
    }
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("gh pr"), "allowed tools carry no PR capability at all");
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("git"), "allowed tools carry no git/code capability");
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(gh pr *)"), "PR namespace explicitly disallowed");
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Read") && ROLE_DISALLOWED_TOOLS.includes("Write"), "no file access");
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
      cfg, stateDir: dir, worktreeRoot, claudeBin: bin, heartbeatMs: 50, guardHookPath: mkHook(dir),
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    assert.ok(!existsSync(join(worktreeRoot, result.name)), "worktree removed unconditionally after run()");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: spend baseline — costUsd is 0 when the stub emits no result line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho 'no json here'\nexit 0\n`);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-drafter", prompt: "p", model: "sonnet", effort: "medium" });
    assert.equal(result.costUsd, 0);
    assert.deepEqual(result.modelUsage, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

