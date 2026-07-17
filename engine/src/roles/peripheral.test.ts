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
printf '{"type":"env_check","gh_token":"%s","github_token":"%s","github_enterprise_token":"%s","gh_config_dir":"%s","gh_host":"%s","git_askpass":"%s","git_config_global":"%s","git_config_count":"%s","anthropic_api_key":"%s","guard_mode":"%s"}\\n' "\${GH_TOKEN-unset}" "\${GITHUB_TOKEN-unset}" "\${GITHUB_ENTERPRISE_TOKEN-unset}" "\${GH_CONFIG_DIR-unset}" "\${GH_HOST-unset}" "\${GIT_ASKPASS-unset}" "\${GIT_CONFIG_GLOBAL-unset}" "\${GIT_CONFIG_COUNT-unset}" "\${ANTHROPIC_API_KEY-unset}" "\${SAPWOOD_GUARD_MODE-unset}"
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

test("run: assembles a context manifest from the real environment — repo CLAUDE.md + auto-memory MEMORY.md snapshotted, model/CLI version/tools/mcp from the session's own init report", async () => {
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
mkdir -p "${worktreeRoot}/$wt"
printf '# fixture repo conventions\\n' > "${worktreeRoot}/$wt/CLAUDE.md"
mkdir -p "${memDir}"
printf -- '- fixture memory entry\\n' > "${memDir}/MEMORY.md"
echo '{"type":"system","subtype":"init","model":"claude-stub-model","claude_code_version":"9.9.9","tools":["Read","Write"],"mcp_servers":[{"name":"codegraph","status":"pending"}],"memory_paths":{"auto":"${memDir}/"}}'
echo '{"type":"result","subtype":"success","total_cost_usd":0.0005,"model":"claude-stub-model","usage":{"input_tokens":3,"output_tokens":7}}'
exit 0
`,
    );
    const runner = mkRunner(dir, bin);
    const prompt = "assemble manifest test";
    const result = await runner.run({ roleId: "test-role", prompt, model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "done");
    const manifest = result.contextManifest;
    assert.ok(manifest, "a REAL RoleRunner.run() result always carries a context manifest");

    assert.equal(manifest!.model, "claude-stub-model", "prefers the session's OWN reported model over the requested one");
    assert.equal(manifest!.cliVersion, "9.9.9");
    assert.ok(manifest!.toolSchemaVersion && manifest!.toolSchemaVersion.length === 64);
    assert.equal(manifest!.promptTemplateVersion, createHash("sha256").update(prompt, "utf8").digest("hex"));
    assert.deepEqual(manifest!.mcpTools, ["codegraph:pending"]);
    assert.ok(manifest!.settingsHash.length === 64);
    assert.ok(manifest!.hookHash && manifest!.hookHash.length === 64, "the guard hook file's content is hashed");

    const repoClaudeMd = manifest!.sources.find((s) => s.label === "repo CLAUDE.md");
    assert.equal(
      repoClaudeMd?.kind,
      "snapshot",
      "no real .git in this stub worktree -> unresolvable HEAD -> classified as a mutable snapshot",
    );
    assert.equal((repoClaudeMd as { content: string }).content, "# fixture repo conventions\n");

    const memoryMd = manifest!.sources.find((s) => s.label === "auto-memory MEMORY.md");
    assert.equal(memoryMd?.kind, "snapshot");
    assert.equal((memoryMd as { content: string }).content, "- fixture memory entry\n");

    // The user-global CLAUDE.md's presence/content depends on the machine running the test, so
    // only its PRESENCE in the source list (not its content) is asserted — kept hermetic.
    assert.ok(manifest!.sources.some((s) => s.label === "user-global CLAUDE.md"));

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

test("run: a stub that emits no init line still assembles a manifest (honest nulls/empties, never a throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB); // no init line, no worktree ever created
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    const manifest = result.contextManifest;
    assert.ok(manifest);
    assert.equal(manifest!.model, "sonnet", "falls back to the requested model when the session reports none");
    assert.equal(manifest!.cliVersion, null);
    assert.equal(manifest!.toolSchemaVersion, null);
    assert.deepEqual(manifest!.mcpTools, []);
    assert.equal(manifest!.worktree.head, null);
    assert.deepEqual(
      manifest!.sources.find((s) => s.label === "repo CLAUDE.md"),
      { kind: "absent", label: "repo CLAUDE.md", path: join(dir, "worktrees", result.name, "CLAUDE.md") },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: a session with a NON-EMPTY allowedTools grant (e.g. retro) records worktree.dirty conservatively — never a false 'definitely clean'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const runner = mkRunner(dir, bin);
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
    assert.equal(manifest!.worktree.dirty, true, "a write-capable session's worktree can never be assumed clean");
    assert.equal(manifest!.worktree.dirtyBasis, "unknown-write-capable-session");
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
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: argv scopes the session to NO Bash grant at all (#110 PR5) — pure computation, no code paths, no PR/review/merge capability, no --add-dir", async () => {
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
    assert.equal(at("--allowedTools"), "", "#110 PR5: no Bash grant of any kind reaches the argv");
    assert.equal(at("--disallowedTools"), ROLE_DISALLOWED_TOOLS);
    assert.equal(at("--fallback-model"), "sonnet");
    assert.ok(!seen.includes("--add-dir"), "never mounts the engine's data dir");
    // No merge/review/PR capability anywhere in the tool-scoping strings (the acceptance
    // criterion: "generated settings for a peripheral session contain no merge/review
    // capability").
    for (const tools of [ROLE_ALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS]) {
      assert.ok(!/gh pr merge|gh pr review|gh pr ready/.test(tools) || tools === ROLE_DISALLOWED_TOOLS);
    }
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("Bash("), "#110 PR5: allowed tools carry NO Bash(...) entry at all");
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("gh pr"), "allowed tools carry no PR capability at all");
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("git"), "allowed tools carry no git/code capability");
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(gh pr *)"), "PR namespace explicitly disallowed");
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Read") && ROLE_DISALLOWED_TOOLS.includes("Write"), "no file access");
    // #102/#108: the deny-glob lines are kept byte-identical as a regression trip-wire (see
    // peripheral.ts's doc) — a future PR re-widening the allow-list lands back inside these.
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(gh issue comment *--body-file*)"));
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(gh issue edit *--body-file*)"));
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

test("PLAN_DRAFTER_DISALLOWED_TOOLS: strict superset of the base denies, adding label mutation (plan-author ≠ plan-approver) — kept as a #110 PR5 regression trip-wire, not live enforcement (neither role has any Bash grant to mutate a label with)", () => {
  assert.ok(PLAN_DRAFTER_DISALLOWED_TOOLS.startsWith(ROLE_DISALLOWED_TOOLS), "keeps every base deny");
  assert.ok(PLAN_DRAFTER_DISALLOWED_TOOLS.includes("Bash(gh issue edit *--add-label*)"));
  assert.ok(PLAN_DRAFTER_DISALLOWED_TOOLS.includes("Bash(gh issue edit *--remove-label*)"));
  // The base (reviewer) deny list does not carry this extra denial — a distinction that only
  // ever mattered when either role had a Bash grant to act on; applying plan:approved/
  // needs-human is now the engine's job (plan-review.ts), never either session's own.
  assert.ok(!ROLE_DISALLOWED_TOOLS.includes("--add-label"));
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

test("PO_DISALLOWED_TOOLS: strict superset of the base denies, closing the `gh issue create` flag holes the new allow opens (file exfil via --body-file, gate⓪ bypass via --label, board writes via --project)", () => {
  assert.ok(PO_DISALLOWED_TOOLS.startsWith(ROLE_DISALLOWED_TOOLS), "keeps every base deny");
  // --body-file on create reads ANY file into a (possibly public) issue body — the same
  // no-repo-read boundary the base list already closes for comment/edit.
  assert.ok(PO_DISALLOWED_TOOLS.includes("Bash(gh issue create *--body-file*)"));
  // --label at creation could self-apply plan:approved/verify:n/a (gate⓪ bypass); labels on
  // PO-created issues are the orchestrator's job (align.ts stamps origin:agent itself).
  assert.ok(PO_DISALLOWED_TOOLS.includes("Bash(gh issue create *--label*)"));
  // --project could place the new issue onto a board lane directly (a board write).
  assert.ok(PO_DISALLOWED_TOOLS.includes("Bash(gh issue create *--project*)"));
});

// ── #102: gh short-flag alias denies (gate② finding on #101 — `-F`/`-l`/`-p` bypass the
// long-flag-only `--body-file`/`--label`/`--project` denies) ───────────────────────────────────
//
// A local, test-only glob matcher mirrors Claude Code's Bash(...) permission-pattern semantics
// (`*` = any run of characters, everything else literal) closely enough to assert deny/allow at
// the ARGV level — not just substring presence in the deny-list string — so these tests actually
// exercise the precise pattern shapes chosen in peripheral.ts, including the space-boundary
// precision the module doc calls out (`*-F*` alone would be too greedy).
function patternMatchesCommand(pattern: string, command: string): boolean {
  const inner = pattern.replace(/^Bash\(/, "").replace(/\)$/, "");
  const escaped = inner
    .split("*")
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`).test(command);
}
const anyDenyMatches = (denyList: string, command: string): boolean =>
  denyList.split(",").some((p) => p.startsWith("Bash(") && patternMatchesCommand(p, command));

test("ROLE_DISALLOWED_TOOLS denies `gh issue comment/edit -F` (#102) — both space-separated and pflag-attached forms", () => {
  assert.ok(anyDenyMatches(ROLE_DISALLOWED_TOOLS, "gh issue comment 12 -F /etc/passwd"));
  assert.ok(anyDenyMatches(ROLE_DISALLOWED_TOOLS, "gh issue comment 12 -F/etc/passwd"), "attached form (no space)");
  assert.ok(anyDenyMatches(ROLE_DISALLOWED_TOOLS, "gh issue edit 12 -F /etc/passwd"));
  assert.ok(anyDenyMatches(ROLE_DISALLOWED_TOOLS, "gh issue edit 12 -F/etc/passwd"), "attached form (no space)");
});

test('ROLE_DISALLOWED_TOOLS: legitimate role writes (`gh issue comment/edit --body`) still pass, including bodies that merely CONTAIN the substring "-F" without it being its own argv token', () => {
  assert.ok(!anyDenyMatches(ROLE_DISALLOWED_TOOLS, `gh issue comment 12 --body "status update"`));
  assert.ok(!anyDenyMatches(ROLE_DISALLOWED_TOOLS, `gh issue edit 12 --body "status update"`));
  // "-F" appears in "PR-Foo" but isn't preceded by a space (not its own token) — the space-
  // boundary pattern shape must not false-deny this the way a bare `*-F*` would.
  assert.ok(!anyDenyMatches(ROLE_DISALLOWED_TOOLS, `gh issue comment 12 --body "see PR-Foo for context"`));
});

test("PLAN_DRAFTER_DISALLOWED_TOOLS inherits the base list's -F short-flag denies (#102)", () => {
  assert.ok(anyDenyMatches(PLAN_DRAFTER_DISALLOWED_TOOLS, "gh issue edit 12 -F /etc/passwd"));
});

test("#102 gate② regression: FLAG-FIRST argv order is denied too — cobra/pflag accepts flags before positionals, and a `subcommand *` shape (space after the subcommand) would let the literal prefix consume the only space before -F", () => {
  assert.ok(anyDenyMatches(ROLE_DISALLOWED_TOOLS, "gh issue comment -F /etc/passwd 12"));
  assert.ok(anyDenyMatches(ROLE_DISALLOWED_TOOLS, "gh issue edit -F /etc/passwd 12"));
  assert.ok(anyDenyMatches(PLAN_DRAFTER_DISALLOWED_TOOLS, "gh issue edit -F /etc/passwd 12"));
  assert.ok(anyDenyMatches(PO_DISALLOWED_TOOLS, "gh issue create -F /etc/passwd --title x"));
  assert.ok(anyDenyMatches(PO_DISALLOWED_TOOLS, "gh issue create -l bad --title x"));
  assert.ok(anyDenyMatches(PO_DISALLOWED_TOOLS, "gh issue create -p Roadmap --title x"));
});

test("PO_DISALLOWED_TOOLS denies `gh issue create -F/-l/-p` (#102) — both space-separated and pflag-attached forms", () => {
  assert.ok(anyDenyMatches(PO_DISALLOWED_TOOLS, "gh issue create --title T -F /etc/passwd"));
  assert.ok(anyDenyMatches(PO_DISALLOWED_TOOLS, "gh issue create --title T -F/etc/passwd"), "attached form");
  assert.ok(anyDenyMatches(PO_DISALLOWED_TOOLS, "gh issue create --title T -l plan:approved"));
  assert.ok(anyDenyMatches(PO_DISALLOWED_TOOLS, "gh issue create --title T -lplan:approved"), "attached form");
  assert.ok(anyDenyMatches(PO_DISALLOWED_TOOLS, "gh issue create --title T -p Roadmap"));
  assert.ok(anyDenyMatches(PO_DISALLOWED_TOOLS, "gh issue create --title T -pRoadmap"), "attached form");
});

test("PO_DISALLOWED_TOOLS: legitimate PO write (`gh issue create --title --body` only) still passes", () => {
  assert.ok(!anyDenyMatches(PO_DISALLOWED_TOOLS, `gh issue create --title "Improve X" --body "Because Y"`));
});

test("run: the PO's allowedTools + disallowedTools pair BOTH reach the argv (the align/triage session wiring) — #110 PR5: the allow half carries no Bash grant", async () => {
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
    assert.equal(seen[seen.indexOf("--allowedTools") + 1], "");
    assert.equal(seen[seen.indexOf("--disallowedTools") + 1], PO_DISALLOWED_TOOLS);
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
  model: tag,
  cliBin: "claude",
  cliVersion: null,
  toolSchemaVersion: null,
  promptTemplateVersion: null,
  mcpTools: [],
  worktree: { path: "/wt", head: null, headResolution: "unresolved", dirty: false, dirtyBasis: "structural-no-write-tools" },
  settingsHash: "hash",
  hookHash: null,
  recordedAt: "2026-07-17T00:00:00Z",
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

test("#110 acceptance sweep: no issues-only role's allowedTools constant contains a Bash( entry (retro excepted, tracked in #111)", () => {
  // Every allow-list-shaped export peripheral.ts/align.ts's roles actually wire into a session —
  // harvest.ts/architect.ts/plan-review.ts's reviewer never override allowedTools at all (see
  // architect.test.ts's/plan-review.test.ts's own "no override passed" assertions), so they fall
  // back to ROLE_ALLOWED_TOOLS below unconditionally; PO/align+triage is the one role with its
  // own named export (PO_ALLOWED_TOOLS). retro.ts's RETRO_ALLOWED_TOOLS is DELIBERATELY excluded
  // — retro is worker-class (Read/git), out of #110's scope, tracked separately in #111.
  const issuesOnlyAllowedTools: Record<string, string> = { ROLE_ALLOWED_TOOLS, PO_ALLOWED_TOOLS };
  for (const [name, tools] of Object.entries(issuesOnlyAllowedTools)) {
    assert.ok(!tools.includes("Bash("), `${name} must carry no Bash(...) allow-list entry, got: ${tools}`);
    assert.equal(tools, "", `${name} must be the empty string (pure computation, no tool grant at all)`);
  }
});

test("#110 PR5 final integration: a role session spawns with empty Bash grants, emits a valid structured-output block, the engine's real validator (plan-review.ts) accepts it, and the resulting write reaches the forge", async () => {
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
    // pair — the #110 PR5 acceptance criterion itself: no Bash(...) grant reaches the argv.
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium", fallbackModel: "sonnet" });
    assert.equal(result.outcome, "done");
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    const allowedArgv = seen[seen.indexOf("--allowedTools") + 1];
    assert.equal(allowedArgv, "", "empty Bash grants reach the argv verbatim");
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
