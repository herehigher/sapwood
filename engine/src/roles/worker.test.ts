import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import { estimateUsd, loadPricingTable } from "../config/pricing.js";
import { classifyEnvFailure, DEFAULT_FORGE_FAILURE_PATTERNS, DEFAULT_LLM_FAILURE_PATTERNS } from "../loop/env-failure.js";
import { State } from "../state/state.js";
import {
  buildRenderFixPrompt,
  buildRenderPrompt,
  claudeArgs,
  defaultFixPromptPath,
  defaultPromptPath,
  discoverClaudeBin,
  extractFailureText,
  guardSettings,
  loadFixPromptTemplate,
  loadWorkerPromptTemplate,
  parseAssistantUsageDeltas,
  parseCostUsd,
  parseModelUsage,
  parseResultText,
  parseSessionInit,
  parseToolUsage,
  probeLlmPing,
  renderPromptTemplate,
  shellSingleQuote,
  WORKER_ALLOWED_TOOLS_NO_GH,
  WorkerSupervisor,
  workerCredentialFreeEnv,
} from "./worker.js";

const cfg: SapwoodConfig = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });

test("WorkerSupervisor: default guard hook resolves the compiled hook in the guard directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const supervisor = new WorkerSupervisor({ cfg, stateDir: dir, claudeBin: "claude", hasOpenPr: async () => false });
    const guardHookPath = (supervisor as unknown as { guardHookPath: string }).guardHookPath;
    assert.equal(guardHookPath, fileURLToPath(new URL("../guard/guard-hook.js", import.meta.url)));
    supervisor.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("parseCostUsd: takes the last result line's total_cost_usd", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    `{"type":"assistant","message":{}}`,
    `{"type":"result","subtype":"success","total_cost_usd":0.0123,"usage":{}}`,
  ].join("\n");
  assert.equal(parseCostUsd(jsonl), 0.0123);
});

test("parseCostUsd: multiple results -> last wins; none -> 0; junk lines ignored", () => {
  assert.equal(parseCostUsd(`{"type":"result","total_cost_usd":0.1}\n{"type":"result","total_cost_usd":0.5}`), 0.5);
  assert.equal(parseCostUsd(`no json here\n{"type":"assistant"}`), 0);
  assert.equal(parseCostUsd(""), 0);
  assert.equal(parseCostUsd(`garbage{{{\n{"type":"result","total_cost_usd":0.2}`), 0.2);
});

// ── #110 PR0: parseResultText — the read side for a role session's structured final-message
//    output. Mirrors parseCostUsd's own tolerance test shapes exactly (same fixture style). ──
test("parseResultText: takes the last result line's `result` string", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    `{"type":"assistant","message":{}}`,
    `{"type":"result","subtype":"success","result":"final answer"}`,
  ].join("\n");
  assert.equal(parseResultText(jsonl), "final answer");
});

test("parseResultText: multiple results -> last wins; garbage/partial lines ignored", () => {
  assert.equal(parseResultText(`{"type":"result","result":"first"}\n{"type":"result","result":"second"}`), "second");
  assert.equal(parseResultText(`garbage{{{\n{"type":"result","result":"ok"}`), "ok");
  assert.equal(parseResultText(`no json here\n{"type":"assistant"}`), "");
});

test('parseResultText: missing `result` field -> ""', () => {
  assert.equal(parseResultText(`{"type":"result","subtype":"success","total_cost_usd":0.1}`), "");
});

test("parseResultText: a LAST result line without a string `result` RESETS earlier text — never fail-open on stale text (Codex round 1 P2)", () => {
  // The last parseable result line is authoritative even when it carries no usable text —
  // an earlier line's "old" must NOT survive to be validated and applied downstream.
  assert.equal(parseResultText(`{"type":"result","result":"old"}\n{"type":"result","total_cost_usd":0.1}`), "");
  assert.equal(parseResultText(`{"type":"result","result":"old"}\n{"type":"result","result":42}`), "");
  // A trailing GARBAGE line (unparseable, mid-write) still leaves the last VALID text intact —
  // the reset applies only to parseable result lines, tolerance for the stream is unchanged.
  assert.equal(parseResultText(`{"type":"result","result":"kept"}\ngarbage{{{`), "kept");
});

test('parseResultText: non-string `result` field -> "" (never throws)', () => {
  assert.equal(parseResultText(`{"type":"result","result":{"nested":true}}`), "");
  assert.equal(parseResultText(`{"type":"result","result":42}`), "");
  assert.equal(parseResultText(`{"type":"result","result":null}`), "");
});

test('parseResultText: empty input -> ""', () => {
  assert.equal(parseResultText(""), "");
});

// ── #236: parseSessionInit — the session's own report of its ambient environment, parsed from
//    stream-json's `{"type":"system","subtype":"init",...}` line. Same tolerance-test shapes as
//    parseCostUsd/parseResultText. Field names/shape verified against a real Claude Code CLI
//    2.1.212 probe session (see context-manifest.ts's module doc). ──
test("parseSessionInit: a real-shaped init line yields model/cliVersion/tools/mcpServers/memoryPathAuto", () => {
  const initLine = JSON.stringify({
    type: "system",
    subtype: "init",
    cwd: "/some/worktree",
    model: "claude-haiku-4-5-20251001",
    claude_code_version: "2.1.212",
    tools: ["Read", "Bash"],
    mcp_servers: [
      { name: "codegraph", status: "pending" },
      { name: "github", status: "disabled" },
    ],
    memory_paths: { auto: "/Users/x/.claude/projects/repo/memory/" },
  });
  const jsonl = [initLine, `{"type":"assistant","message":{}}`, `{"type":"result","subtype":"success","total_cost_usd":0.01}`].join("\n");
  const info = parseSessionInit(jsonl);
  assert.equal(info.model, "claude-haiku-4-5-20251001");
  assert.equal(info.cliVersion, "2.1.212");
  assert.deepEqual(info.tools, ["Read", "Bash"]);
  assert.deepEqual(info.mcpServers, [
    { name: "codegraph", status: "pending" },
    { name: "github", status: "disabled" },
  ]);
  assert.equal(info.memoryPathAuto, "/Users/x/.claude/projects/repo/memory/");
});

test("parseSessionInit: no init line, garbage lines, or empty input -> honest empty defaults, never throws", () => {
  const empty = { model: null, cliVersion: null, tools: [], mcpServers: [], memoryPathAuto: null };
  assert.deepEqual(parseSessionInit(""), empty);
  assert.deepEqual(parseSessionInit(`garbage{{{\n{"type":"assistant","message":{}}`), empty);
  assert.deepEqual(parseSessionInit(`{"type":"system","subtype":"hook_started"}`), empty);
});

test("parseSessionInit: only the FIRST init line is used; malformed tools/mcp_servers/memory_paths shapes degrade to defaults instead of throwing", () => {
  const first = JSON.stringify({
    type: "system",
    subtype: "init",
    model: "first-model",
    tools: "not-an-array",
    mcp_servers: [{ status: "pending" }],
  });
  const second = JSON.stringify({ type: "system", subtype: "init", model: "second-model" });
  const info = parseSessionInit(`${first}\n${second}`);
  assert.equal(info.model, "first-model", "the FIRST init line wins");
  assert.deepEqual(info.tools, [], "non-array tools degrades to []");
  assert.deepEqual(
    info.mcpServers,
    [{ name: "unknown", status: "pending" }],
    "a server entry missing `name` degrades, never dropped silently",
  );
  assert.equal(info.memoryPathAuto, null);
});

// ── #47: per-model token usage capture (parseModelUsage) ──
test("parseModelUsage: full modelUsage map capture (newer CLI)", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    JSON.stringify({
      type: "result",
      subtype: "success",
      total_cost_usd: 0.5,
      usage: { input_tokens: 999 }, // top-level usage ignored when modelUsage is present
      modelUsage: {
        "claude-opus-4-6": { inputTokens: 100, outputTokens: 200, cacheReadInputTokens: 30, cacheCreationInputTokens: 10 },
        "claude-sonnet-4-6": { inputTokens: 5, outputTokens: 7, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    }),
  ].join("\n");
  assert.deepEqual(parseModelUsage(jsonl), [
    { model: "claude-opus-4-6", inputTokens: 100, outputTokens: 200, cacheReadTokens: 30, cacheCreationTokens: 10 },
    { model: "claude-sonnet-4-6", inputTokens: 5, outputTokens: 7, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
});

test("parseModelUsage: modelUsage absent -> falls back to top-level usage attributed to the result's model id", () => {
  const jsonl = JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: 0.1,
    model: "claude-sonnet-4-6",
    usage: { input_tokens: 40, output_tokens: 60, cache_creation_input_tokens: 5, cache_read_input_tokens: 15 },
  });
  assert.deepEqual(parseModelUsage(jsonl), [
    { model: "claude-sonnet-4-6", inputTokens: 40, outputTokens: 60, cacheReadTokens: 15, cacheCreationTokens: 5 },
  ]);
});

test("parseModelUsage: modelUsage absent + no model field -> falls back to modelName, else 'unknown'", () => {
  const withModelName = JSON.stringify({
    type: "result",
    total_cost_usd: 0.1,
    modelName: "claude-haiku-4-6",
    usage: { input_tokens: 1, output_tokens: 2 },
  });
  assert.deepEqual(parseModelUsage(withModelName), [
    { model: "claude-haiku-4-6", inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
  const withNeither = JSON.stringify({ type: "result", total_cost_usd: 0.1, usage: { input_tokens: 3 } });
  assert.deepEqual(parseModelUsage(withNeither), [
    { model: "unknown", inputTokens: 3, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
});

test("parseModelUsage: malformed/missing usage -> zeros, never a parse failure (cost still recovers separately)", () => {
  // usage is entirely absent.
  const noUsage = JSON.stringify({ type: "result", total_cost_usd: 0.2 });
  assert.deepEqual(parseModelUsage(noUsage), [
    { model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
  assert.equal(parseCostUsd(noUsage), 0.2); // USD recording must keep working regardless

  // usage is the wrong shape (a string, not an object).
  const wrongShape = `{"type":"result","total_cost_usd":0.3,"usage":"not-an-object"}`;
  assert.deepEqual(parseModelUsage(wrongShape), [
    { model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
  assert.equal(parseCostUsd(wrongShape), 0.3);

  // usage fields are negative/non-numeric — clamp to 0, not NaN or negative.
  const badFields = JSON.stringify({
    type: "result",
    total_cost_usd: 0.4,
    usage: { input_tokens: -5, output_tokens: "oops", cache_read_input_tokens: null },
  });
  assert.deepEqual(parseModelUsage(badFields), [
    { model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);

  // no result line at all / garbage-only stream -> empty, no throw.
  assert.deepEqual(parseModelUsage('no json here\n{"type":"assistant"}'), []);
  assert.deepEqual(parseModelUsage(""), []);
  assert.deepEqual(parseModelUsage("garbage{{{"), []);
});

test("parseModelUsage: multiple result lines -> last one wins (same as parseCostUsd)", () => {
  const jsonl = [
    JSON.stringify({ type: "result", total_cost_usd: 0.1, model: "m1", usage: { input_tokens: 1 } }),
    JSON.stringify({ type: "result", total_cost_usd: 0.2, model: "m2", usage: { input_tokens: 2 } }),
  ].join("\n");
  assert.deepEqual(parseModelUsage(jsonl), [{ model: "m2", inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 }]);
});

// ── #33: parseAssistantUsageDeltas — the live in-flight cost-estimation signal ──
test("parseAssistantUsageDeltas: extracts per-message usage from streamed `assistant` lines, ignoring system/result lines and malformed json", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 100, output_tokens: 50, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    }),
    `garbage{{{`,
    JSON.stringify({
      type: "assistant",
      message: {
        model: "claude-opus-4-8",
        usage: { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 },
      },
    }),
    // a terminal result line must NOT be double-counted as an assistant delta
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 9.99, usage: { input_tokens: 99999 } }),
  ].join("\n");
  assert.deepEqual(parseAssistantUsageDeltas(jsonl), [
    { model: "claude-opus-4-8", inputTokens: 100, outputTokens: 50, cacheCreationTokens: 0, cacheReadTokens: 0 },
    { model: "claude-opus-4-8", inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 2000 },
  ]);
});

test("parseAssistantUsageDeltas: no assistant lines / malformed message / missing usage -> [] or zeros, never throws", () => {
  assert.deepEqual(parseAssistantUsageDeltas(""), []);
  assert.deepEqual(parseAssistantUsageDeltas("garbage{{{\nnot json either"), []);
  assert.deepEqual(parseAssistantUsageDeltas(`{"type":"assistant","message":"not-an-object"}`), []);
  assert.deepEqual(parseAssistantUsageDeltas(`{"type":"assistant"}`), []); // no message field at all
  assert.deepEqual(parseAssistantUsageDeltas(JSON.stringify({ type: "assistant", message: { model: "m", usage: {} } })), [
    { model: "m", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  ]);
});

// ── #235 PR-B: parseToolUsage — which tools/paths a session's stream actually invoked ──
test("parseToolUsage: counts tool_use blocks by name and collects Read/Grep/Glob paths, in first-seen tool order, sorted+deduplicated paths", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    JSON.stringify({
      type: "assistant",
      message: {
        content: [
          { type: "tool_use", id: "1", name: "Read", input: { file_path: "/wt/src/b.ts" } },
          { type: "text", text: "reasoning, not a tool call" },
        ],
      },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "2", name: "Grep", input: { pattern: "foo", path: "/wt/src" } }] },
    }),
    JSON.stringify({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "3", name: "Read", input: { file_path: "/wt/src/a.ts" } }] },
    }),
    JSON.stringify({ type: "result", subtype: "success", total_cost_usd: 0.01 }),
  ].join("\n");
  const { toolUsage, readPaths } = parseToolUsage(jsonl);
  assert.deepEqual(toolUsage, [
    { tool: "Read", count: 2 },
    { tool: "Grep", count: 1 },
  ]);
  assert.deepEqual(readPaths, ["/wt/src", "/wt/src/a.ts", "/wt/src/b.ts"], "sorted, deduplicated");
});

test("parseToolUsage: Glob's explicit path is always captured verbatim, regardless of defaultSearchPath", () => {
  const withPath = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Glob", input: { pattern: "**/*.ts", path: "/wt/src" } }] },
  });
  assert.deepEqual(parseToolUsage(withPath).readPaths, ["/wt/src"]);
  assert.deepEqual(parseToolUsage(withPath, "/wt").readPaths, ["/wt/src"], "explicit path wins over defaultSearchPath, never overridden");
});

test("parseToolUsage (Codex review PR #257 F2): a PATHLESS Grep/Glob call still searches — and reads — the session's cwd, so it's recorded under defaultSearchPath when the caller supplies one (peripheral.ts passes the session's worktree root)", () => {
  const noPathGlob = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Glob", input: { pattern: "**/*.ts" } }] },
  });
  const withoutDefault = parseToolUsage(noPathGlob);
  assert.deepEqual(withoutDefault.toolUsage, [{ tool: "Glob", count: 1 }]);
  assert.deepEqual(
    withoutDefault.readPaths,
    [],
    "defaultSearchPath omitted -> caller doesn't know the worktree root yet, degrades honestly rather than fabricating one",
  );

  const withDefault = parseToolUsage(noPathGlob, "/wt/probe-role-1");
  assert.deepEqual(withDefault.toolUsage, [{ tool: "Glob", count: 1 }]);
  assert.deepEqual(
    withDefault.readPaths,
    ["/wt/probe-role-1"],
    "pathless Glob recorded under the supplied worktree root — it DID read from there",
  );

  const noPathGrep = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Grep", input: { pattern: "TODO" } }] },
  });
  assert.deepEqual(parseToolUsage(noPathGrep, "/wt/probe-role-1").readPaths, ["/wt/probe-role-1"], "same fallback applies to Grep");
});

test("parseToolUsage: defaultSearchPath does NOT apply to Read/NotebookRead — a missing file_path/notebook_path is a malformed call (no cwd-search fallback exists for a single-file read), so it contributes no read path even with a default supplied", () => {
  const readNoPath = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Read", input: {} }] },
  });
  const result = parseToolUsage(readNoPath, "/wt/probe-role-1");
  assert.deepEqual(result.toolUsage, [{ tool: "Read", count: 1 }]);
  assert.deepEqual(result.readPaths, [], "Read has no 'searches cwd' fallback — a missing file_path records nothing, default or not");
});

test("parseToolUsage: NotebookRead's notebook_path is captured under the same read-path record", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "NotebookRead", input: { notebook_path: "/wt/nb.ipynb" } }] },
  });
  assert.deepEqual(parseToolUsage(jsonl).readPaths, ["/wt/nb.ipynb"]);
});

test("parseToolUsage: a DENIED tool call (e.g. an attempted Bash, blocked by the guard hook or the CLI's own disallowedTools) is still counted — the attempt itself is diagnostic evidence, whether or not it executed", () => {
  const jsonl = JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "1", name: "Bash", input: { command: "cat /etc/passwd" } }] },
  });
  const { toolUsage, readPaths } = parseToolUsage(jsonl);
  assert.deepEqual(toolUsage, [{ tool: "Bash", count: 1 }]);
  assert.deepEqual(readPaths, [], "Bash has no read-path field in this module's mapping");
});

test("parseToolUsage: no assistant lines / malformed content / malformed tool_use shapes -> empty result, never throws", () => {
  assert.deepEqual(parseToolUsage(""), { toolUsage: [], readPaths: [] });
  assert.deepEqual(parseToolUsage("garbage{{{\nnot json either"), { toolUsage: [], readPaths: [] });
  assert.deepEqual(parseToolUsage(`{"type":"assistant","message":"not-an-object"}`), { toolUsage: [], readPaths: [] });
  assert.deepEqual(parseToolUsage(`{"type":"assistant","message":{"content":"not-an-array"}}`), { toolUsage: [], readPaths: [] });
  assert.deepEqual(parseToolUsage(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":123}]}}`), {
    toolUsage: [],
    readPaths: [],
  });
  assert.deepEqual(parseToolUsage(`{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":"nope"}]}}`), {
    toolUsage: [{ tool: "Read", count: 1 }],
    readPaths: [],
  });
  assert.deepEqual(parseToolUsage(`{"type":"result","total_cost_usd":0.1}`), { toolUsage: [], readPaths: [] });
});

test("discoverClaudeBin: env CLAUDE_BIN wins, else 'claude'", () => {
  assert.equal(discoverClaudeBin({ CLAUDE_BIN: "/opt/claude" }), "/opt/claude");
  assert.equal(discoverClaudeBin({}), "claude");
  assert.equal(discoverClaudeBin({ CLAUDE_BIN: "" }), "claude"); // empty -> default
});

test("claudeArgs: headless flags, stream-json, worktree/session; no --max-budget-usd (soft budget is monitored, not a hard cut)", () => {
  const args = claudeArgs({
    prompt: "do the thing",
    model: "opus",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "lane-1",
    name: "lane-1",
    sessionId: "uuid-1",
    addDir: "/repo/data",
  });
  assert.ok(args.includes("-p") && args.includes("do the thing"));
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "opus"]);
  assert.deepEqual(args.slice(args.indexOf("--fallback-model"), args.indexOf("--fallback-model") + 2), ["--fallback-model", "sonnet"]);
  assert.ok(args.includes("--worktree") && args.includes("lane-1"));
  assert.ok(args.includes("--session-id") && args.includes("uuid-1"));
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(args.includes("--add-dir") && args.includes("/repo/data"));
  assert.ok(!args.includes("--max-budget-usd")); // soft budget: monitored + graceful handoff, never a hard kill
});

test("claudeArgs: resumeSessionId (#46) uses --resume instead of --session-id, reusing the id", () => {
  const args = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "sess-1",
    resumeSessionId: "sess-1",
  });
  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "sess-1"]);
  assert.ok(!args.includes("--session-id"));
});

test("claudeArgs: fallbackModel defaults, overrides, and supports explicit opt-out", () => {
  const defaults = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  assert.deepEqual(defaults.slice(defaults.indexOf("--fallback-model"), defaults.indexOf("--fallback-model") + 2), [
    "--fallback-model",
    "sonnet",
  ]);
  const custom = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "haiku",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  assert.deepEqual(custom.slice(custom.indexOf("--fallback-model"), custom.indexOf("--fallback-model") + 2), ["--fallback-model", "haiku"]);
  const none = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "none",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  assert.ok(!none.includes("--fallback-model"));
});

test("claudeArgs: allowedTools/disallowedTools override the worker defaults when given (#87 role-runner reuse)", () => {
  const defaults = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  const idx = defaults.indexOf("--allowedTools");
  assert.equal(defaults[idx + 1], "Read,Edit,Write,Bash(git *),Bash(gh *),Bash(npm *),Bash(node *),Bash(npx *)");
  const scoped = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
    allowedTools: "Bash(gh issue comment*)",
    disallowedTools: "Bash(gh pr *)",
  });
  const aIdx = scoped.indexOf("--allowedTools");
  const dIdx = scoped.indexOf("--disallowedTools");
  assert.equal(scoped[aIdx + 1], "Bash(gh issue comment*)");
  assert.equal(scoped[dIdx + 1], "Bash(gh pr *)");
});

test("claudeArgs: --settings only when given (guard hook wiring lands in #26)", () => {
  assert.ok(
    !claudeArgs({ prompt: "p", model: "m", effort: "high", fallbackModel: "sonnet", worktree: "w", name: "w", sessionId: "s" }).includes(
      "--settings",
    ),
  );
  const withSettings = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
    settings: "/tmp/guard.json",
  });
  assert.deepEqual(withSettings.slice(withSettings.indexOf("--settings"), withSettings.indexOf("--settings") + 2), [
    "--settings",
    "/tmp/guard.json",
  ]);
});

test("claudeArgs: --mcp-config only when given (#234), inline JSON — never a file path", () => {
  const withoutProxy = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
  });
  assert.ok(!withoutProxy.includes("--mcp-config"));
  const inlineJson = JSON.stringify({ mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp", headers: {} } } });
  const withProxy = claudeArgs({
    prompt: "p",
    model: "m",
    effort: "high",
    fallbackModel: "sonnet",
    worktree: "w",
    name: "w",
    sessionId: "s",
    mcpConfig: inlineJson,
  });
  const i = withProxy.indexOf("--mcp-config");
  assert.ok(i !== -1);
  assert.equal(withProxy[i + 1], inlineJson);
});

// ── Integration: stub `claude` (zero token) drives the real spawn/sentinel/probe path ──
const mkStub = (dir: string, body: string): string => {
  const p = join(dir, "claude-stub");
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};
const waitFor = async (predicate: () => boolean, message: string): Promise<void> => {
  for (let i = 0; i < 400 && !predicate(); i++) await sleep(20);
  assert.ok(predicate(), message);
};
const waitForFile = (path: string, message = `timed out waiting for ${path}`): Promise<void> => waitFor(() => existsSync(path), message);
const waitForHeartbeatTick = async (path: string): Promise<void> => {
  rmSync(path, { force: true });
  await waitForFile(path, "heartbeat tick did not recreate its marker");
};
const longRunningStub = (dir: string, beforeReady = "", readyName = "stub-ready"): { bin: string; ready: string } => {
  const ready = join(dir, readyName);
  const bin = mkStub(dir, `#!/usr/bin/env bash\n${beforeReady}touch "${ready}"\nfor _ in $(seq 1 600); do sleep 1; done\n`);
  return { bin, ready };
};
const FAST_STUB = `#!/usr/bin/env bash\necho '{"type":"result","subtype":"success","total_cost_usd":0.0001,"model":"claude-stub","usage":{"input_tokens":12,"output_tokens":34}}'\nexit 0\n`;

// A present (dummy) guard hook so hard-mode dispatch doesn't fail closed; the stub `claude`
// ignores --settings, so its contents don't matter here (the hook mode is unit-tested separately).
const mkHook = (dir: string): string => {
  const p = join(dir, "guard-hook.js");
  writeFileSync(p, "process.exit(0)\n");
  return p;
};

// ── #168 (P1-1 amendment, final form): probeLlmPing — the LLM-source park probe's real
//    implementation: a minimal stripped inference ping; success = exit 0 AND trimmed stdout
//    containing "pong" (case-insensitive). Failure carries a `detail` (first stderr/error
//    line) so the park-probe event can name its own cause. ──────────────────────────────────

test("probeLlmPing: exit 0 + 'pong' on stdout -> ok (case-insensitive, whitespace-tolerant), no detail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho "  Pong  "\nexit 0\n`);
    assert.deepEqual(await probeLlmPing(bin, "haiku", 0.05, 30), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: exit 0 but NON-pong stdout -> failure, detail carries the first output line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho "I'm sorry, I can't help with that."\nexit 0\n`);
    const r = await probeLlmPing(bin, "haiku", 0.05, 30);
    assert.equal(r.ok, false);
    assert.ok(r.detail?.includes("I'm sorry"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing (P3): a sentence CONTAINING 'pong' is a failure — success requires the normalized output to EQUAL 'pong'", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho "I cannot return only pong"\nexit 0\n`);
    const r = await probeLlmPing(bin, "haiku", 0.05, 30);
    assert.equal(r.ok, false, "a refusal mentioning 'pong' must never read as provider health");
    assert.ok(r.detail?.includes("I cannot return only pong"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: non-zero exit -> failure even with 'pong' on stdout; detail prefers the STDERR error line (the 'Exceeded USD budget' / 'unknown option' operator signal)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho pong\necho "Error: Exceeded USD budget (0.01)" >&2\nexit 1\n`);
    const r = await probeLlmPing(bin, "haiku", 0.01, 30);
    assert.equal(r.ok, false);
    assert.equal(r.detail, "Error: Exceeded USD budget (0.01)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: an older CLI rejecting the ping's flags surfaces the unknown-option line as detail", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho "error: unknown option '--no-session-persistence'" >&2\nexit 1\n`);
    const r = await probeLlmPing(bin, "haiku", 0.05, 30);
    assert.equal(r.ok, false);
    assert.ok(r.detail?.includes("unknown option"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: a nonexistent binary -> failure with a spawn detail, never throws", async () => {
  const r = await probeLlmPing("/no/such/binary/sapwood-168", "haiku", 0.05, 30);
  assert.equal(r.ok, false);
  assert.ok(r.detail);
});

test("probeLlmPing: a hang past probeTimeoutSec is hard-killed and resolves failure with a timeout detail, never left dangling", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\necho pong\n`);
    const start = Date.now();
    const r = await probeLlmPing(bin, "haiku", 0.05, 1); // 1s timeout vs a 30s hang
    assert.equal(r.ok, false);
    assert.ok(r.detail?.includes("timed out"));
    assert.ok(Date.now() - start < 10_000, "resolved via the timeout kill, not by waiting out the 30s sleep");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probeLlmPing: invoked with exactly the verified argv — -p, --model, --no-session-persistence, --system-prompt, --strict-mcp-config, --tools '', --max-budget-usd, --output-format text, prompt (and NO --max-tokens, which the CLI rejects)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-probe-"));
  const argsFile = join(dir, "args.txt");
  try {
    // NUL-separated capture: one argv entry is the EMPTY string (--tools ""), which a
    // newline-separated printf would silently swallow on split.
    const bin = mkStub(dir, `#!/usr/bin/env bash\nprintf '%s\\0' "$@" > "${argsFile}"\necho pong\nexit 0\n`);
    assert.deepEqual(await probeLlmPing(bin, "my-cheap-model", 0.05, 30), { ok: true });
    const argv = readFileSync(argsFile, "utf8").split("\0").slice(0, -1);
    assert.deepEqual(argv, [
      "-p",
      "--model",
      "my-cheap-model",
      "--no-session-persistence",
      "--system-prompt",
      "You are a heartbeat responder. Only output the requested word.",
      "--strict-mcp-config",
      "--tools",
      "",
      "--max-budget-usd",
      "0.05",
      "--output-format",
      "text",
      "Respond with the single word 'pong' and nothing else.",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sup = (dir: string, claudeBin: string, hasPr = false, worktreeRoot?: string) =>
  new WorkerSupervisor({
    cfg,
    stateDir: dir,
    ...(worktreeRoot ? { worktreeRoot } : {}),
    claudeBin,
    hasOpenPr: async () => hasPr,
    renderPrompt: () => "test prompt",
    heartbeatMs: 50,
    guardHookPath: mkHook(dir),
  });

test("dispatch -> stub claude runs -> .done sentinel + parsed cost; probe sees DONE", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    const { name, sessionId } = await s.dispatch({ number: 7, title: "t", labels: [] });
    assert.ok(name && sessionId);
    // wait for the stub to exit and the sentinel to land
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "done sentinel written");
    const sentinel = JSON.parse(readFileSync(join(dir, `${name}.done.json`), "utf8"));
    assert.equal(sentinel.issue, 7);
    assert.equal(sentinel.total_cost_usd, 0.0001);
    assert.ok(!existsSync(join(dir, `${name}.running.json`)), "running marker cleared on completion");
    const probe = await s.probe(name);
    assert.equal(probe.done, true);
    assert.equal(probe.failed, false);
    // #14: the terminal sentinel's total_cost_usd feeds the conductor's engine-ceiling
    // ledger (state.recordSpend) — probe() must surface it.
    assert.equal(probe.costUsd, 0.0001);
    // #47: the sentinel also carries model_usage (from the stub's flat "usage" — no
    // modelUsage map, so it's the fallback-attributed single entry) — probe() surfaces it too.
    assert.deepEqual(probe.modelUsage, [
      { model: "claude-stub", inputTokens: 12, outputTokens: 34, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #13 findOpenPr (when provided) supplies prNumber and derives hasPr from it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => {
        throw new Error("legacy path must not be used when findOpenPr is provided");
      },
      findOpenPr: async (issue) => (issue === 8 ? 42 : null),
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 8, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    const probe = await s.probe(name);
    assert.equal(probe.hasPr, true);
    assert.equal(probe.prNumber, 42);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: #13 findOpenPr returning null -> hasPr false, prNumber undefined (no legacy fallback call)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => {
        throw new Error("legacy path must not be used when findOpenPr is provided");
      },
      findOpenPr: async () => null,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 9, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    const probe = await s.probe(name);
    assert.equal(probe.hasPr, false);
    assert.equal(probe.prNumber, undefined);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: costUsd is 0 while a lane is still running (no terminal sentinel yet)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir);
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 4, title: "t", labels: [] });
    await waitForFile(ready);
    const probe = await s.probe(name);
    assert.equal(probe.done, false);
    assert.equal(probe.costUsd, 0);
    assert.ok(Number.isFinite(probe.dispatchedAgeSec));
    assert.ok(probe.dispatchedAgeSec! >= 0, "probe surfaces age from persisted dispatched_at");
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("probe: recovers costUsd from the jsonl when a restart-orphaned lane has NO terminal sentinel (Codex PR #41 R3 P1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    // Simulate a lane orphaned by an engine restart: claude finished and wrote its terminal
    // result line to the jsonl, but no attached onExit handler existed to write a sentinel.
    // The probe must not report 0 — that would omit real spend from the daily-cap ledger.
    writeFileSync(join(dir, "lane-orphan.running.json"), JSON.stringify({ issue: 5, wrapper_pid: 999999999 }));
    writeFileSync(
      join(dir, "lane-orphan.jsonl"),
      `{"type":"system"}\n{"type":"result","subtype":"success","total_cost_usd":1.25,"model":"claude-opus-4-6","usage":{"input_tokens":7}}\n`,
    );
    const probe = await s.probe("lane-orphan");
    assert.equal(probe.done, false); // no sentinel — classifyLane will call this DEAD (pid gone)
    assert.ok(Number.isNaN(probe.dispatchedAgeSec), "missing dispatched_at is an explicit unbounded/fail-safe age");
    assert.equal(probe.costUsd, 1.25); // but the real cost is still recovered from the jsonl
    // #47: same fallback recovery applies to model usage — no sentinel, so it's reparsed too.
    assert.deepEqual(probe.modelUsage, [
      { model: "claude-opus-4-6", inputTokens: 7, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
    ]);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch rejects a name already in use (no concurrent same-name clobber)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    writeFileSync(join(dir, "lane-x.running.json"), "{}"); // pretend a lane is occupying the name
    await assert.rejects(() => s.dispatch({ number: 1, title: "t", labels: [] }, "lane-x"), /in use|occupied|exists/i);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reclaim kills a stubborn (ignores TERM) claude subtree via SIGKILL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // Stubborn stub: ignore TERM -> only a process-group KILL stops it.
    const { bin, ready } = longRunningStub(dir, "trap '' TERM\n");
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 2, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before reclaim");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    assert.equal(alive(pid), true);
    await s.reclaim(name);
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "process group killed");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestHandoff -> graceful SIGTERM -> .handoff sentinel (resumable, not killed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // A COOPERATIVE worker: catches SIGTERM and exits 0 (it checkpointed/committed). Only a
    // clean exit-0 after a handoff request counts as a resumable .handoff.
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 3, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "handoff sentinel written on cooperative drain");
    assert.ok(!existsSync(join(dir, `${name}.done.json`)) && !existsSync(join(dir, `${name}.failed.json`)));
    const probe = await s.probe(name);
    assert.equal(probe.handoff, true);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestHandoff reaches a RESTARTED-engine lane via the persisted pid (Codex PR #41 P1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // A cooperative worker that exits 0 on TERM. Dispatch with supervisor #1, then simulate
    // an engine restart: dispose() #1 (clears its in-memory lane map — its exit handler
    // becomes a no-op) and create supervisor #2 over the SAME stateDir. #2 has no in-memory
    // handle, only the persisted running.json — the ceiling drain must still reach the
    // process group via the persisted pid instead of silently no-opping.
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 8, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    assert.equal(alive(pid), true);
    s1.dispose(); // "restart": the new supervisor knows this lane only from disk
    const s2 = sup(dir, bin);
    assert.equal(s2.requestHandoff(name), true); // persisted-pid fallback fires
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM reached the detached process group");
    assert.equal(s2.requestHandoff(name), false); // idempotent: second request is a no-op
    assert.equal(s2.requestHandoff("lane-unknown"), false); // no persisted lane -> false, no throw
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("requestHandoff, worker dies by signal (no clean wrap-up), and no worktree exists on disk -> STILL .handoff, never .failed (#60 supersedes Codex R3 P2: the real CLI never exits 0 on SIGTERM, so gating .handoff on code===0 made it unreachable; the supervisor now guarantees resumability itself, tag-agnostic to exit code)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir); // no TERM trap -> SIGTERM kills it (code null)
    const s = sup(dir, bin); // no worktreeRoot override -> the lane's worktree path never exists
    const { name } = await s.dispatch({ number: 9, title: "t", labels: [] });
    await waitForFile(ready, "stub reached its running state before handoff");
    s.requestHandoff(name);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "handoff-requested + signal-killed is .handoff, not .failed");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#172: resumed no-result SIGTERM ignores leg 1's result and ledgers its baseline-adjusted estimate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const firstLine = JSON.stringify({
    type: "assistant",
    message: { model: "claude-opus-4-6", usage: { input_tokens: 1_000, output_tokens: 200 } },
  });
  const resumedLine = JSON.stringify({
    type: "assistant",
    message: { model: "claude-sonnet-4-6", usage: { input_tokens: 500, output_tokens: 300 } },
  });
  const firstResult = JSON.stringify({
    type: "result",
    subtype: "success",
    total_cost_usd: 1,
    model: "claude-opus-4-6",
    usage: { input_tokens: 1_000, output_tokens: 200 },
  });
  const logs: string[] = [];
  const state = new State(":memory:");
  try {
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  echo '${resumedLine}'`,
        "else",
        `  echo '${firstLine}'`,
        `  echo '${firstResult}'`,
        "fi",
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "test prompt",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
      log: (line) => logs.push(line),
    });
    const pricing = loadPricingTable(cfg);
    const resumedExpected = parseAssistantUsageDeltas(resumedLine).reduce((sum, d) => sum + estimateUsd(d, pricing), 0);
    const { name } = await s.dispatch({ number: 172, title: "t", labels: [] });
    const jsonlPath = join(dir, `${name}.jsonl`);
    for (let i = 0; i < 400 && !readFileSync(jsonlPath, "utf8").includes(firstResult); i++) await sleep(20);
    assert.ok(readFileSync(jsonlPath, "utf8").includes(firstResult), "leg 1 result flushed before SIGTERM");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    const firstProbe = await s.probe(name);
    assert.equal(firstProbe.costUsd, 1);
    state.recordSpend(name, 172, firstProbe.costUsd, new Date().toISOString());

    await s.resume({ number: 172, title: "t", labels: [] }, name);
    for (let i = 0; i < 400 && !readFileSync(jsonlPath, "utf8").includes(resumedLine); i++) await sleep(20);
    assert.ok(readFileSync(jsonlPath, "utf8").includes(resumedLine), "leg 2 usage flushed before SIGTERM");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    const resumedProbe = await s.probe(name);
    assert.ok(
      Math.abs(resumedProbe.costUsd - resumedExpected) < 1e-12,
      `resumed no-result leg cost ${resumedProbe.costUsd} should equal baseline-adjusted estimate ${resumedExpected}`,
    );
    state.recordSpend(name, 172, resumedProbe.costUsd, new Date().toISOString());
    assert.ok(Math.abs(state.spentUsdForWorker(name) - (1 + resumedExpected)) < 1e-12);
    assert.equal(logs.filter((line) => line.includes("source=assistant-usage-estimate")).length, 1);
    s.dispose();
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #46: resume() — --resume after a .handoff ────────────────────────────────────────────────

test("resumeIntentState: reads only matching resume-authored confirmed/unconfirmed markers", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const s = sup(dir, mkStub(dir, FAST_STUB));
    const marker = join(dir, "lane-intent.running.json");
    assert.equal(s.resumeIntentState("lane-intent", 172), "none");
    writeFileSync(
      marker,
      JSON.stringify({ name: "lane-intent", issue: 172, session_id: "s", resume_pending_db: true, spawn_confirmed: false }),
    );
    assert.equal(s.resumeIntentState("lane-intent", 172), "unconfirmed");
    assert.equal(s.resumeIntentState("lane-intent", 999), "none");
    writeFileSync(
      marker,
      JSON.stringify({ name: "lane-intent", issue: 172, session_id: "s", resume_pending_db: true, spawn_confirmed: true }),
    );
    assert.equal(s.resumeIntentState("lane-intent", 172), "confirmed");
    writeFileSync(marker, JSON.stringify({ name: "lane-intent", issue: 172, spawn_confirmed: false }));
    assert.equal(s.resumeIntentState("lane-intent", 172), "none", "dispatch markers are not resume intents");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fails closed when the lane has no .handoff sentinel (nothing to resume)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    await assert.rejects(
      () => s.resume({ number: 1, title: "t", labels: [] }, "lane-never-handed-off"),
      /no \.handoff sentinel|nothing to resume/i,
    );
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a dead matching running sentinel is durable interrupted-resume proof and is adopted", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const s = sup(dir, mkStub(dir, FAST_STUB));
    writeFileSync(
      join(dir, "lane-dead.running.json"),
      JSON.stringify({
        name: "lane-dead",
        issue: 1,
        session_id: "survivor",
        wrapper_pid: 999_999_999,
        resume_pending_db: true,
        spawn_confirmed: true,
      }),
    );
    assert.deepEqual(await s.resume({ number: 1, title: "t", labels: [] }, "lane-dead"), {
      name: "lane-dead",
      sessionId: "survivor",
    });
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: spawn error removes the unconfirmed intent and leaves handoff retryable", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const s = sup(dir, join(dir, "missing-claude"));
    writeFileSync(
      join(dir, "lane-spawn-error.handoff.json"),
      JSON.stringify({ name: "lane-spawn-error", issue: 2, session_id: "retry-session" }),
    );
    writeFileSync(join(dir, "lane-spawn-error.jsonl"), "");

    await assert.rejects(() => s.resume({ number: 2, title: "t", labels: [] }, "lane-spawn-error"), /resume-spawn failed/i);
    assert.equal(existsSync(join(dir, "lane-spawn-error.running.json")), false);
    assert.equal(existsSync(join(dir, "lane-spawn-error.handoff.json")), true);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: --resume reuses the ORIGINAL session id, clears .handoff, and the resumed run's terminal cost is probed normally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const ready = join(dir, "stub-ready");
    // Cooperative stub: a fresh dispatch sleeps and hands off cleanly on TERM. A --resume
    // invocation instead prints ONE more (higher, "cumulative") result line and exits 0 —
    // standing in for claude continuing the same session after --resume.
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        '  echo \'{"type":"result","subtype":"success","total_cost_usd":0.05,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}\'',
        "  exit 0",
        "fi",
        "trap 'exit 0' TERM",
        `touch "${ready}"`,
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = sup(dir, bin);
    const { name, sessionId } = await s.dispatch({ number: 3, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "handed off before resuming");

    const resumed = await s.resume({ number: 3, title: "t", labels: [] }, name);
    assert.equal(resumed.name, name);
    assert.equal(resumed.sessionId, sessionId); // SAME session — no --fork-session
    assert.ok(!existsSync(join(dir, `${name}.handoff.json`)), "handoff sentinel cleared once live again");

    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "resumed run reached a fresh terminal sentinel");
    const probe = await s.probe(name);
    assert.equal(probe.done, true);
    // probe() surfaces the resumed leg's raw per-leg reported cost as-is (0.05); #172 records
    // that value directly in State.recordSpend.
    assert.equal(probe.costUsd, 0.05);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: also sets SAPWOOD_WORKTREE_ROOT to the same lane's resolved worktree path (#235 PR-A) — a resumed leg keeps Read containment too", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const worktreeRoot = join(dir, "worktrees");
    const ready = join(dir, "stub-ready");
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  echo "$SAPWOOD_WORKTREE_ROOT" > "${join(dir, "resume-root.seen.tmp")}"`,
        `  mv "${join(dir, "resume-root.seen.tmp")}" "${join(dir, "resume-root.seen")}"`,
        '  echo \'{"type":"result","subtype":"success","total_cost_usd":0.05,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}\'',
        "  exit 0",
        "fi",
        "trap 'exit 0' TERM",
        `touch "${ready}"`,
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = sup(dir, bin, false, worktreeRoot);
    const { name } = await s.dispatch({ number: 4, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    assert.equal(s.requestHandoff(name), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    await s.resume({ number: 4, title: "t", labels: [] }, name);
    await waitForFile(join(dir, "resume-root.seen"), "resumed worktree root was not published");
    assert.equal(readFileSync(join(dir, "resume-root.seen"), "utf8").trim(), join(worktreeRoot, name));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fails closed in hard mode when the guard hook is missing (no unguarded resume)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 3, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    s.requestHandoff(name);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    // A supervisor whose guard hook path doesn't exist, same as dispatch()'s hard-mode guard.
    const s2 = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      guardHookPath: join(dir, "nonexistent-hook.js"),
    });
    await assert.rejects(() => s2.resume({ number: 3, title: "t", labels: [] }, name), /guard hook not found|unguarded/i);
    s.dispose();
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("guardSettings: PreToolUse hook runs `node <hookPath>` and fails closed (exit 2) on a hook crash", () => {
  const s = guardSettings("/x/dist/guard-hook.js") as {
    disableAllHooks: boolean;
    hooks: { PreToolUse: Array<{ matcher: string; hooks: Array<{ type: string; command: string }> }> };
  };
  assert.equal(s.disableAllHooks, false); // force hooks on so a global disable can't silence the guard
  const entry = s.hooks.PreToolUse[0]!;
  assert.match(entry.matcher, /Bash/);
  assert.equal(entry.hooks[0]!.type, "command");
  const cmd = entry.hooks[0]!.command;
  assert.match(cmd, /^node '\/x\/dist\/guard-hook\.js'/); // single-quoted hook path (no shell expansion)
  assert.match(cmd, /\bexit 2\b/); // a hook launch/runtime failure blocks (fail-closed, hard)
  assert.match(cmd, /SAPWOOD_GUARD_MODE.*soft.*exit 0/); // soft mode allows on crash (observe-only)
});

test("shellSingleQuote: suppresses shell expansion of $, backticks, $()", () => {
  assert.equal(shellSingleQuote("/a/b"), "'/a/b'");
  assert.equal(shellSingleQuote("/p/$(rm -rf x)/h.js"), "'/p/$(rm -rf x)/h.js'"); // $() not expanded
  assert.equal(shellSingleQuote("/it's/here"), "'/it'\\''s/here'"); // embedded quote escaped
});

test("guard hook wrapper fails closed: a crashing hook exits 2 in hard mode, 0 in soft (Codex #26 P1)", async () => {
  // A hook path that makes `node` exit non-zero (module not found). In hard mode the wrapper
  // must map that to exit 2 (BLOCKING); in soft (observe-only) it allows (exit 0).
  const cmd = (
    guardSettings("/nonexistent/sapwood-guard-hook.js") as {
      hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
    }
  ).hooks.PreToolUse[0]!.hooks[0]!.command;
  const run = (mode: string): Promise<number | null> =>
    new Promise((resolve) => {
      const c = spawn("sh", ["-c", cmd], { stdio: "ignore", env: { ...process.env, SAPWOOD_GUARD_MODE: mode } });
      c.on("exit", (code) => resolve(code));
    });
  assert.equal(await run("hard"), 2); // fail-closed: a broken hook BLOCKS the tool
  assert.equal(await run("soft"), 0); // observe-only: a broken hook allows
});

test("dispatch passes INLINE guard --settings (no mutable file) + sets SAPWOOD_GUARD_MODE in the worker env (#26)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const previousGhToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "worker-forge-token";
    const hook = mkHook(dir);
    // Stub records argv + security-relevant env. Unlike peripherals, workers legitimately
    // retain forge credentials so they can push branches and open PRs through the guard.
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\necho "$GH_TOKEN" > "${join(dir, "token.seen.tmp")}"\nmv "${join(dir, "token.seen.tmp")}" "${join(dir, "token.seen")}"\necho "$SAPWOOD_GUARD_MODE" > "${join(dir, "mode.seen.tmp")}"\nmv "${join(dir, "mode.seen.tmp")}" "${join(dir, "mode.seen")}"\nexit 0\n`,
    );
    const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, guard: { mode: "soft" } });
    const s = new WorkerSupervisor({
      cfg: scfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name } = await s.dispatch({ number: 7, title: "t", labels: [] });
    assert.ok(!existsSync(join(dir, `${name}.settings.json`)), "no mutable settings file written");
    // mode.seen is the stub's LAST write — waiting on it guarantees args.seen exists too
    // (waiting on args.seen could race the second write on a slow FS). (Codex #26 R6 P3.)
    await waitForFile(join(dir, "mode.seen"), "guard env marker was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.match(args, /--settings/);
    assert.match(args, /guard-hook\.js/); // the inline JSON carries the hook command
    assert.match(args, /disableAllHooks/);
    assert.equal(readFileSync(join(dir, "mode.seen"), "utf8").trim(), "soft"); // env reached the worker
    assert.equal(readFileSync(join(dir, "token.seen"), "utf8").trim(), "worker-forge-token");
    s.dispose();
  } finally {
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

// #235 PR-A: SAPWOOD_WORKTREE_ROOT reaches the worker's spawn env, resolved to the ABSOLUTE
// path of THIS lane's worktree — the guard hook reads it to confine Read/Grep/Glob (see
// guard.ts's checkReadContainment). Set at spawn exactly where SAPWOOD_GUARD_MODE is, both on
// fresh dispatch() and on resume() (a resumed leg must keep the same containment).
test("dispatch sets SAPWOOD_WORKTREE_ROOT to the resolved absolute worktree path (#235 PR-A)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const worktreeRoot = join(dir, "worktrees");
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\necho "$SAPWOOD_WORKTREE_ROOT" > "${join(dir, "root.seen.tmp")}"\nmv "${join(dir, "root.seen.tmp")}" "${join(dir, "root.seen")}"\nexit 0\n`,
    );
    const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, guard: { mode: "hard" } });
    const s = new WorkerSupervisor({
      cfg: scfg,
      stateDir: dir,
      worktreeRoot,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name } = await s.dispatch({ number: 9, title: "t", labels: [] });
    await waitForFile(join(dir, "root.seen"), "worker worktree root was not published");
    assert.equal(readFileSync(join(dir, "root.seen"), "utf8").trim(), join(worktreeRoot, name));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch fails closed in hard mode when the guard hook is missing (no unguarded worker)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      guardHookPath: join(dir, "nonexistent-hook.js"),
    });
    await assert.rejects(() => s.dispatch({ number: 1, title: "t", labels: [] }), /guard hook not found|unguarded/i);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch rejects (and cleans up) when claude can't spawn — bad CLAUDE_BIN", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const s = sup(dir, join(dir, "does-not-exist-claude"));
    await assert.rejects(() => s.dispatch({ number: 4, title: "t", labels: [] }, "lane-bad"), /spawn failed/i);
    // no bogus running marker / jsonl left behind for the conductor to misread
    assert.ok(!existsSync(join(dir, "lane-bad.running.json")));
    assert.ok(!existsSync(join(dir, "lane-bad.jsonl")));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("enforces worker timeout: a run past timeoutSec is killed and marked failed (Codex R2 P1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap '' TERM\n"); // ignores TERM -> needs the KILL
    const tcfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { timeoutSec: 1 } });
    let fakeNowMs = Date.now();
    const s = new WorkerSupervisor({
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 20,
      guardHookPath: mkHook(dir),
      now: () => new Date(fakeNowMs),
    });
    const { name } = await s.dispatch({ number: 5, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before timeout");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    fakeNowMs += (tcfg.worker.timeoutSec + 1) * 1000;
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.failed.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.failed.json`)), "timed-out worker marked failed");
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "timed-out worker process killed");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #33: soft per-worker budget auto-enforcement via live token estimation ──

test("#33: crossing worker.budgetUsdSoft mid-run triggers requestHandoff exactly once, and the lane ends up .handoff (graceful), never .failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // Emits one streamed assistant usage line big enough to cross a tiny budget, then sleeps
    // with no TERM trap (the empirically-confirmed real CLI shape, #60) so the SIGTERM the
    // budget check fires actually ends the process and lets onExit write the sentinel.
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    // opus: $5/MTok input + $25/MTok output -> 1000 in + 1000 out = $0.005 + $0.025 = $0.03,
    // comfortably over a $0.01 soft budget.
    const tcfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { budgetUsdSoft: 0.01 },
    });
    const s = new WorkerSupervisor({
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    let handoffCalls = 0;
    const original = s.requestHandoff.bind(s);
    s.requestHandoff = (name: string) => {
      handoffCalls++;
      return original(name);
    };
    const { name } = await s.dispatch({ number: 33, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "soft-budget crossing led to a graceful .handoff");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)), "never a hard-kill .failed for a budget-triggered handoff");
    // The terminal sentinel means onExit cleared the heartbeat interval, so the count is final.
    assert.equal(handoffCalls, 1, "requestHandoff fired exactly once for the soft-budget crossing");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#33: a cache-heavy stream under budget does NOT trigger a handoff -- cache reads are priced at the cache-read rate, not the input rate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // 1,000,000 cache-read tokens at opus's cache-read rate (~$0.50/MTok) is ~$0.50 --
    // comfortably under a $2 budget. Priced (WRONGLY) at the input rate ($5/MTok) it would be
    // ~$5.00 and cross the budget on the very first heartbeat tick -- exactly the cache-heavy
    // over-trigger failure mode #33 flags.
    const usageLine = `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":500,"cache_creation_input_tokens":0,"cache_read_input_tokens":1000000}}}`;
    const { bin, ready } = longRunningStub(dir, `echo '${usageLine}'\n`);
    const tcfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { budgetUsdSoft: 2 },
    });
    const s = new WorkerSupervisor({
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 34, title: "t", labels: [] });
    await waitForFile(ready, "cache-heavy usage was flushed before checking the budget");
    assert.ok(readFileSync(join(dir, `${name}.jsonl`), "utf8").includes(usageLine));
    await waitForHeartbeatTick(join(dir, `${name}.heartbeat`));
    assert.ok(!existsSync(join(dir, `${name}.handoff.json`)), "cache-heavy run under budget must NOT hand off");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)));
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#33 (PR #85 review): a broken worker.pricingFile fails at SUPERVISOR CONSTRUCTION (fail-closed, before any dispatch), naming the path — and a valid custom file's rates actually drive the budget check", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // Fail-closed: constructing the supervisor with a missing pricingFile throws immediately.
    const badCfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { pricingFile: "/nonexistent/rates.yaml" },
    });
    assert.throws(
      () =>
        new WorkerSupervisor({ cfg: badCfg, stateDir: dir, claudeBin: "claude", hasOpenPr: async () => false, guardHookPath: mkHook(dir) }),
      /\/nonexistent\/rates\.yaml/,
    );

    // And a VALID custom table is what the budget check prices against: rates 100x the
    // shipped defaults make a tiny usage line cross a budget the default table wouldn't.
    const ratesPath = join(dir, "expensive.yaml");
    writeFileSync(ratesPath, "models: { opus: { input: 500, output: 2500, cacheWrite: 625, cacheRead: 50, contextWindow: 200000 } }\n");
    // 1000 in + 1000 out at 100x rates = $3.00; the shipped table would price it $0.03 —
    // under this $1 budget. A handoff proves the CUSTOM table is in effect.
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const cfgCustom = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { budgetUsdSoft: 1, pricingFile: ratesPath },
    });
    const s = new WorkerSupervisor({
      cfg: cfgCustom,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    const { name } = await s.dispatch({ number: 35, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "custom pricingFile rates drove the soft-budget handoff");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#33 (gate② P1): resume() over a jsonl already past budgetUsdSoft does NOT instantly re-handoff — the soft budget bounds spend PER RUN; new post-resume usage crossing it again MUST", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-33-resume";
    // Fabricate a budget-triggered handed-off lane: a .handoff sentinel + a preserved jsonl
    // whose PRE-EXISTING assistant lines already exceed the $0.01 budget (1000 in + 1000 out
    // on opus ≈ $0.03). resume() appends to this same file — without a baseline, the first
    // heartbeat tick after resume would read ≥ budget and hand off again, forever.
    writeFileSync(
      join(dir, `${name}.handoff.json`),
      JSON.stringify({ name, issue: 33, session_id: "11111111-1111-1111-1111-111111111111", total_cost_usd: 0 }),
    );
    const preExisting = `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`;
    writeFileSync(join(dir, `${name}.jsonl`), preExisting);
    // The resumed stub waits for the test to prove a heartbeat checked the pre-existing spend,
    // then emits NEW usage that crosses the budget again.
    const ready = join(dir, "stub-ready");
    const emitNewUsage = join(dir, "emit-new-usage");
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `touch "${ready}"`,
        `while [ ! -f "${emitNewUsage}" ]; do sleep 0.02; done`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const tcfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { budgetUsdSoft: 0.01 },
    });
    const s = new WorkerSupervisor({
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: mkHook(dir),
    });
    await s.resume({ number: 33, title: "t", labels: [] }, name);
    await waitForFile(ready, "resumed stub reached its pre-new-usage wait");
    await waitForHeartbeatTick(join(dir, `${name}.heartbeat`));
    assert.ok(!existsSync(join(dir, `${name}.handoff.json`)), "pre-handoff spend alone must NOT re-trigger a handoff after resume");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)));
    writeFileSync(emitNewUsage, "");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "new post-resume spend crossing the budget triggers a fresh graceful handoff");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #155: per-probe lane telemetry (priced-cost snapshot, context size, token composition) ──

test("#155: probe() persists the live telemetry trio (estCostUsd, contextTokens, tokenComposition) computed from the jsonl-so-far", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":100,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":10,"output_tokens":5,"cache_creation_input_tokens":0,"cache_read_input_tokens":2000}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 155, title: "t", labels: [] });
    // No heartbeat wait needed — probe() re-derives the trio fresh from the jsonl on every call.
    // Poll until BOTH streamed lines have landed (contextTokens reflects only the newest one).
    let p = await s.probe(name);
    for (let i = 0; i < 200 && p.liveTelemetry?.contextTokens !== 2010; i++) {
      await sleep(20);
      p = await s.probe(name);
    }
    assert.ok(p.liveTelemetry, "a still-running in-memory lane carries live telemetry");
    // opus: input $5/MTok, output $25/MTok, cacheRead $0.5/MTok (shipped pricing.yaml).
    // Line 1: 100in+50out -> 0.0005 + 0.00125 = 0.00175
    // Line 2: 10in+5out+2000cacheRead -> 0.00005 + 0.000125 + 0.001 = 0.001175
    const expectedCost = 0.00175 + 0.001175;
    assert.ok(Math.abs(p.liveTelemetry!.estCostUsd - expectedCost) < 1e-9, `estCostUsd ${p.liveTelemetry!.estCostUsd} ~= ${expectedCost}`);
    // contextTokens: the NEWEST assistant message's input + cache_read + cache_creation only.
    assert.equal(p.liveTelemetry!.contextTokens, 10 + 2000 + 0);
    // tokenComposition: cumulative 4-class split across BOTH streamed messages.
    assert.deepEqual(p.liveTelemetry!.tokenComposition, {
      inputTokens: 110,
      outputTokens: 55,
      cacheCreationTokens: 0,
      cacheReadTokens: 2000,
    });
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#155: contextTokens is deliberately NON-monotonic — a later, smaller assistant message (an auto-compact) drops it, never a running max", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const marker = join(dir, "emit-second");
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        // Large first turn: a big context.
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":50000,"output_tokens":100,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        // Wait for the test to observe the large value before compacting.
        `while [ ! -f "${marker}" ]; do sleep 0.02; done`,
        // Small second turn (post-compaction context is much smaller).
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":500,"output_tokens":50,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 156, title: "t", labels: [] });
    let p = await s.probe(name);
    for (let i = 0; i < 200 && p.liveTelemetry?.contextTokens !== 50000; i++) {
      await sleep(20);
      p = await s.probe(name);
    }
    assert.equal(p.liveTelemetry?.contextTokens, 50000, "large first turn -> large context");
    writeFileSync(marker, "");
    for (let i = 0; i < 200 && p.liveTelemetry?.contextTokens !== 500; i++) {
      await sleep(20);
      p = await s.probe(name);
    }
    assert.equal(p.liveTelemetry?.contextTokens, 500, "smaller second turn DROPS contextTokens — never smoothed into a running max");
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#155: a resumed lane's persisted estCostUsd covers only the CURRENT leg (reuses the #33 baseline) — pre-handoff usage alone must not show as live cost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-155-resume";
    writeFileSync(
      join(dir, `${name}.handoff.json`),
      JSON.stringify({ name, issue: 157, session_id: "22222222-2222-2222-2222-222222222222", total_cost_usd: 0 }),
    );
    // Pre-existing (pre-handoff) usage: opus 1000in+1000out ≈ $0.03 — would show as live cost
    // if the baseline weren't subtracted.
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`,
    );
    const marker = join(dir, "emit-new-usage");
    const bin = mkStub(
      dir,
      [
        `#!/usr/bin/env bash`,
        `while [ ! -f "${marker}" ]; do sleep 0.02; done`,
        // New post-resume usage: opus 200in+0out -> $0.001.
        `echo '{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":200,"output_tokens":0,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}'`,
        `for _ in $(seq 1 600); do sleep 1; done`,
        ``,
      ].join("\n"),
    );
    const s = sup(dir, bin);
    await s.resume({ number: 157, title: "t", labels: [] }, name);
    // Right after resume, before the stub emits anything new: the whole-file total already
    // includes the pre-handoff line, but the baseline snapshot cancels it out.
    const p1 = await s.probe(name);
    assert.ok(p1.liveTelemetry, "resumed lane is tracked in-memory too");
    assert.ok(
      Math.abs(p1.liveTelemetry!.estCostUsd) < 1e-9,
      `pre-handoff spend must not leak into the resumed leg's live cost (got ${p1.liveTelemetry!.estCostUsd})`,
    );
    writeFileSync(marker, "");
    let p2 = await s.probe(name);
    for (let i = 0; i < 200 && !(p2.liveTelemetry && p2.liveTelemetry.estCostUsd > 0); i++) {
      await sleep(20);
      p2 = await s.probe(name);
    }
    const expectedNewLegCost = (200 / 1_000_000) * 5; // opus input rate
    assert.ok(
      Math.abs(p2.liveTelemetry!.estCostUsd - expectedNewLegCost) < 1e-9,
      `new-leg estCostUsd ${p2.liveTelemetry!.estCostUsd} ~= ${expectedNewLegCost}`,
    );
    // contextTokens/tokenComposition are NOT baseline-adjusted — they read the whole jsonl-so-far
    // (resume APPENDS), so they include the pre-handoff line too.
    assert.equal(p2.liveTelemetry!.contextTokens, 200); // newest message only
    assert.deepEqual(p2.liveTelemetry!.tokenComposition, {
      inputTokens: 1200,
      outputTokens: 1000,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    });
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#155: a DETACHED lane (no in-memory handle) carries no live telemetry — never invents a second baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-155-detached";
    writeFileSync(
      join(dir, `${name}.running.json`),
      JSON.stringify({ name, issue: 158, session_id: "s", wrapper_pid: 999999, started_at: new Date().toISOString() }),
    );
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"assistant","message":{"model":"claude-opus-4-8","usage":{"input_tokens":1000,"output_tokens":1000,"cache_creation_input_tokens":0,"cache_read_input_tokens":0}}}\n`,
    );
    const s = sup(dir, "claude"); // no dispatch/resume -> no in-memory Lane for this name
    const p = await s.probe(name);
    assert.equal(p.liveTelemetry, undefined, "a detached lane has no known baseline -> no live telemetry, never a guessed one");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #168: environment-failure failureText capture — probe() reads the SAME jsonl already used
//    for terminalCostUsd/terminalModelUsage (no new capture mechanism), only for a FAILED lane.

test("#168: probe() of a FAILED lane surfaces failureText from the jsonl (stdout+stderr merged)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-168-failed";
    writeFileSync(join(dir, `${name}.failed.json`), JSON.stringify({ name, issue: 168, session_id: "s", total_cost_usd: 0, exit_code: 1 }));
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"system","subtype":"init"}\n` +
        `API Error: 429 too many requests — rate_limit_error\n` + // raw stderr, non-JSON line
        `{"type":"result","subtype":"error","is_error":true,"result":"request failed"}\n`,
    );
    const s = sup(dir, "claude"); // no live process — a static terminal sentinel + jsonl is enough
    const p = await s.probe(name);
    assert.equal(p.failed, true);
    assert.ok(p.failureText?.includes("429 too many requests"), "raw non-JSON stderr lines are captured, not just parsed JSON fields");
    assert.ok(p.failureText?.includes("rate_limit_error"));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#168: probe() of a DONE (non-failed) lane never populates failureText", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-168-done";
    writeFileSync(
      join(dir, `${name}.done.json`),
      JSON.stringify({ name, issue: 168, session_id: "s", total_cost_usd: 0.01, exit_code: 0 }),
    );
    writeFileSync(join(dir, `${name}.jsonl`), `{"type":"result","subtype":"success","total_cost_usd":0.01}\n`);
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.done, true);
    assert.equal(p.failureText, undefined);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#168: failureText is tail-capped for a large jsonl — the classifiable error near the end still comes through", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-168-tail";
    writeFileSync(join(dir, `${name}.failed.json`), JSON.stringify({ name, issue: 168, session_id: "s", total_cost_usd: 0 }));
    const padding = "x".repeat(10_000);
    writeFileSync(join(dir, `${name}.jsonl`), `${padding}\nCould not resolve host: github.com\n`);
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.ok(p.failureText && p.failureText.length <= 4000, "capped, not the whole 10k+ jsonl");
    assert.ok(p.failureText?.includes("Could not resolve host"), "the tail (where the error actually is) survives the cap");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #247: a DONE lane's resultText capture — probe() reads the SAME per-leg jsonl slice
//    terminalCostUsd/terminalModelUsage's jsonl-fallback already reads (currentLegJsonl), only
//    for a DONE lane. A fix leg's structured threadResponses block lives here.

test("#247: probe() of a DONE lane surfaces resultText from the jsonl's final structured result line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-247-done";
    writeFileSync(
      join(dir, `${name}.done.json`),
      JSON.stringify({ name, issue: 247, session_id: "s", total_cost_usd: 0.01, exit_code: 0 }),
    );
    const resultText = '<<<SAPWOOD_RESULT>>>\n{"threadResponses":[]}\n<<<END_SAPWOOD_RESULT>>>';
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"system","subtype":"init"}\n{"type":"result","subtype":"success","total_cost_usd":0.01,"result":${JSON.stringify(resultText)}}\n`,
    );
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.done, true);
    assert.equal(p.resultText, resultText);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#247: probe() of a FAILED (non-DONE) lane never populates resultText", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-247-failed";
    writeFileSync(join(dir, `${name}.failed.json`), JSON.stringify({ name, issue: 247, session_id: "s", total_cost_usd: 0 }));
    writeFileSync(join(dir, `${name}.jsonl`), `{"type":"result","subtype":"error","is_error":true,"result":"some text"}\n`);
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.failed, true);
    assert.equal(p.resultText, undefined);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#247: resultText is scoped to the CURRENT LEG's jsonl offset — a resumed fix leg's own final message, never an earlier leg's superseded result line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-247-leg";
    const legOneLine = `{"type":"result","subtype":"success","total_cost_usd":0.01,"result":"leg one final message — stale"}\n`;
    const legOneBytes = Buffer.byteLength(legOneLine, "utf8");
    const legTwoResult = '<<<SAPWOOD_RESULT>>>\n{"threadResponses":[]}\n<<<END_SAPWOOD_RESULT>>>';
    const legTwoLine = `{"type":"result","subtype":"success","total_cost_usd":0.02,"result":${JSON.stringify(legTwoResult)}}\n`;
    writeFileSync(join(dir, `${name}.jsonl`), legOneLine + legTwoLine);
    writeFileSync(
      join(dir, `${name}.running.json`),
      JSON.stringify({ name, issue: 247, session_id: "s", dispatched_at: new Date().toISOString(), jsonl_leg_offset: legOneBytes }),
    );
    writeFileSync(
      join(dir, `${name}.done.json`),
      JSON.stringify({ name, issue: 247, session_id: "s", total_cost_usd: 0.02, exit_code: 0 }),
    );
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.resultText, legTwoResult, "only the SECOND (current) leg's result text — the first leg's is never leaked through");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #168 (PR #180 review P1-3): failureText is built from STRUCTURED error records only —
//    NEVER assistant message content. A worker legitimately WORKING ON rate-limit handling
//    prints the exact signature strings as part of doing its job; that must never park the
//    engine on an ordinary task failure.

test("extractFailureText: assistant/user/system records and SUCCESSFUL results are excluded; stderr lines + errored results + error records are included", () => {
  const jsonl = [
    `{"type":"system","subtype":"init","model":"opus"}`,
    `{"type":"assistant","message":{"content":[{"type":"text","text":"I will add handling for rate_limit_error and 429 Too Many Requests"}]}}`,
    `{"type":"user","message":{"content":"also handle Could not resolve host"}}`,
    `gh: Bad credentials (HTTP 401)`, // raw stderr — included
    `{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}`, // API error record — included
    `{"type":"result","subtype":"success","result":"clean run mentioning usage limit reached","total_cost_usd":0.1}`, // successful result — excluded
    `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"request failed"}`, // errored result — included
  ].join("\n");
  const out = extractFailureText(jsonl);
  assert.ok(out.includes("gh: Bad credentials"));
  assert.ok(out.includes("overloaded_error"));
  assert.ok(out.includes("[error_during_execution] request failed"));
  assert.ok(!out.includes("429 Too Many Requests"), "assistant content is NEVER included");
  assert.ok(!out.includes("Could not resolve host"), "user content is NEVER included");
  assert.ok(!out.includes("usage limit reached"), "a successful result's text is NEVER included");
});

test("extractFailureText: an unparseable {-prefixed line (mid-write stream fragment, possibly of an assistant message) is SKIPPED, never included", () => {
  const truncatedAssistant = `{"type":"assistant","message":{"content":[{"type":"text","text":"discussing rate_limit_error and how`;
  assert.equal(extractFailureText(truncatedAssistant), "");
});

test("#168 P1-3 contractual negative: exact configured signatures inside ASSISTANT text + a non-env failure -> task failure, no env classification, no park", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const name = "lane-168-neg";
    writeFileSync(join(dir, `${name}.failed.json`), JSON.stringify({ name, issue: 168, session_id: "s", total_cost_usd: 0 }));
    // A worker FIXING rate-limit handling: its assistant messages carry the exact signature
    // strings verbatim; the actual failure is an ordinary failing test.
    writeFileSync(
      join(dir, `${name}.jsonl`),
      `{"type":"assistant","message":{"content":[{"type":"text","text":"Testing the retry path for rate_limit_error, 429 too many requests, usage limit reached, and Could not resolve host"}]}}\n` +
        `{"type":"result","subtype":"error_during_execution","is_error":true,"result":"AssertionError: retry test failed — expected 3 retries, got 0"}\n`,
    );
    const s = sup(dir, "claude");
    const p = await s.probe(name);
    assert.equal(p.failed, true);
    assert.ok(!p.failureText?.includes("rate_limit_error"), "the assistant's signature strings never reach failureText");
    assert.equal(
      classifyEnvFailure(p.failureText ?? "", {
        llm: [...DEFAULT_LLM_FAILURE_PATTERNS],
        forge: [...DEFAULT_FORGE_FAILURE_PATTERNS],
      }),
      null,
      "an ordinary task failure whose assistant text discusses the signatures classifies as a TASK failure",
    );
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fast non-zero exit writes .failed (exit handler attached before the await) — Codex R2 P2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nexit 3\n`); // exits immediately, like the CLI rejecting args
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 8, title: "t", labels: [] }, "lane-fast");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.failed.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.failed.json`)), "fast exit still recorded a .failed sentinel");
    const probe = await s.probe(name);
    assert.equal(probe.failed, true);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #69: the drain contract is sentinel-only — the supervisor NEVER runs git in a worker
// worktree (that's #65's clean-filter RCE class, deleted at the root). Resumability =
// `claude --resume <session_id>` reusing the untouched worktree in place. ────────────────

test("#69: drain (SIGTERM) -> .handoff sentinel carries the session_id, NO git subprocess is spawned, and the worktree is left byte-for-byte untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  const shimDir = mkdtempSync(join(tmpdir(), "sapwood-gitshim-"));
  const gitLog = join(shimDir, "git-invocations.log");
  const oldPath = process.env.PATH;
  try {
    // Exec spy: a `git` shim FIRST on PATH — any git subprocess the supervisor (or anything
    // it spawns) launches during the drain would append here. The invariant: it never does.
    writeFileSync(join(shimDir, "git"), `#!/usr/bin/env bash\necho "$@" >> "${gitLog}"\nexit 0\n`, { mode: 0o755 });
    process.env.PATH = `${shimDir}:${oldPath}`;

    const name = "lane-69-a";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "wip.txt"), "uncommitted work\n"); // WIP at kill time

    // The empirically-confirmed real CLI shape (#60): no SIGTERM trap -> dies by signal.
    const { bin, ready } = longRunningStub(dir);
    const s = sup(dir, bin, false, worktreeRoot);
    const { name: laneName, sessionId } = await s.dispatch({ number: 69, title: "t", labels: [] }, name);
    await waitForFile(ready, "stub reached its running state before drain");
    assert.equal(s.requestHandoff(laneName), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${laneName}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${laneName}.handoff.json`)), ".handoff written despite a signal-killed exit");
    assert.ok(!existsSync(join(dir, `${laneName}.failed.json`)));

    const sentinel = JSON.parse(readFileSync(join(dir, `${laneName}.handoff.json`), "utf8"));
    assert.equal(sentinel.session_id, sessionId, "sentinel carries the resumable session_id");

    assert.ok(!existsSync(gitLog), "NO git subprocess was spawned during the drain");
    assert.equal(readFileSync(join(worktreePath, "wip.txt"), "utf8"), "uncommitted work\n", "worktree untouched");

    s.dispose();
  } finally {
    process.env.PATH = oldPath;
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
    rmSync(shimDir, { recursive: true, force: true });
  }
});

test("#69 grep-invariant (engine-wide, fable P3; extended #284): the ONLY child_process importers are worker.ts (spawn), gh.ts (execFile), and review/materializer.ts (execFile) — and no subprocess call site passes a cwd — the engine structurally CANNOT exec git in a worker worktree", () => {
  const srcDir = new URL("../", import.meta.url);
  const files = readdirSync(srcDir, { recursive: true }).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  // Sanity: the three known subprocess modules are present in the scan set.
  assert.ok(files.includes("roles/worker.ts") && files.includes("forge/gh.ts") && files.includes("review/materializer.ts"));
  for (const f of files) {
    const src = readFileSync(new URL(f, srcDir), "utf8");
    const importsChildProcess = /from "node:child_process"/.test(src);
    if (f === "roles/worker.ts") {
      // spawn ONLY (the claude CLI launch); every exec-style API (what #62's preserveHandoffWip
      // used) is banned — this pins the deletion.
      assert.match(src, /import \{ type ChildProcess, spawn \} from "node:child_process"/, "worker.ts imports spawn only");
      assert.doesNotMatch(src, /\b(execFileSync|execFile|execSync|spawnSync|exec)\b/, "worker.ts has no exec API");
      assert.doesNotMatch(src, /["'`]git["'`]/, "worker.ts references no `git` command");
      assert.doesNotMatch(src, /preserveHandoffWip|runGit|tryGit|noHooksDir/, "deleted helpers not stranded");
      assert.doesNotMatch(src, /\bcwd:/, "worker.ts passes no cwd to any subprocess");
    } else if (f === "forge/gh.ts") {
      // execFile ONLY, no spawn/sync variants, and gh runs in the engine's own cwd (no cwd option).
      assert.doesNotMatch(src, /\b(execFileSync|execSync|spawnSync|spawn)\b/, "gh.ts uses execFile only");
      assert.doesNotMatch(src, /\bcwd:/, "gh.ts passes no cwd to execFile");
    } else if (f === "review/materializer.ts") {
      // #284: a THIRD legitimate importer — the private-clone materializer invokes `git` itself
      // (clone/checkout/rev-parse), ENGINE-side, structurally outside every worker worktree
      // (never runs in a worker's worktree, never touches the shared repo's config). execFile
      // (async) ONLY, same discipline as gh.ts; every git target is passed via `-C`, never a
      // subprocess `cwd` option.
      assert.doesNotMatch(src, /\b(execFileSync|execSync|spawnSync|spawn)\b/, "materializer.ts uses execFile only");
      // Object-literal `cwd:` (an execFile options property) is banned; a `cwd: string` TS
      // parameter annotation (this module's own `defaultPrivateCloneDir(cwd = process.cwd())`
      // helpers) is a different, unrelated thing and must not false-positive here.
      assert.doesNotMatch(src, /[{,]\s*cwd\s*:/, "materializer.ts passes no cwd option to execFile (uses -C instead)");
    } else {
      // Every other engine module must not shell out at all.
      assert.equal(importsChildProcess, false, `${f} must not import node:child_process`);
    }
  }
});

test("#69: timeout still tags .failed even if a handoff was already requested (timeout is a distinct, non-drain hard-kill path)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    // Ignores TERM so it survives requestHandoff's SIGTERM; only the timeout's SIGKILL stops it.
    // #241 (same class of race as #229/PR #240): touch a ready-sentinel immediately after the
    // trap is installed, so requestHandoff's SIGTERM can never beat the trap. That alone still
    // left two real-time races on a real wall-clock timeoutSec (Codex second-opinion review):
    //   (a) the bounded trap-ready poll is itself real-time-unbounded under load -- if it ran
    //       long enough for the real timeout to fire FIRST, requestHandoff would never get a
    //       pending handoff to race against;
    //   (b) even a fast trap-ready could land inside killTree's own 200ms SIGTERM->SIGKILL grace,
    //       letting requestHandoff() return true AFTER timedOut was already set -- silently
    //       reversing "handoff pending, THEN timeout" (the ordering this test exists to pin
    //       down) while every assertion still happened to pass.
    // Both windows exist only because "elapsed since dispatch" was read off the real wall clock.
    // Fix: inject a fully controllable fake clock (WorkerSupervisor's `now` dep, already designed
    // for this) and DRIVE elapsed time explicitly instead of racing it:
    //   1. freeze the clock at dispatch, so elapsedSec is provably 0 no matter how long the real
    //      trap-ready handshake takes in wall-clock time -- the timeout branch cannot fire.
    //   2. confirm the trap, call requestHandoff(), and assert it returns true -- still provably
    //      BEFORE any timeout, since the fake clock has not moved.
    //   3. only THEN advance the fake clock past timeoutSec, and let the heartbeat timer (real,
    //      but fast) observe the new elapsed time and drive the hard-kill path.
    // This proves the exact ordering deterministically; the only remaining real-time waits are
    // monotonic bounded polls for effects that are certain to eventually happen (never a race
    // against a competing real deadline).
    // #241 (Codex delta confirm, P2): a finite `sleep 30` was still a theoretical real-time race
    // -- if the event loop stalled ~30s after the fake-clock advance, the stub would exit
    // NATURALLY (code 0) before heartbeatTick ever observed the new elapsed time, writing
    // .handoff (handoffRequested, not timedOut) instead of .failed. The 600s bounded loop
    // pushes that window far past any test lifetime (while still self-reaping a failure-path
    // orphan): within the test, the stub can only end via the timeout path's SIGKILL.
    const trapReady = join(dir, "trap-ready");
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap '' TERM\ntouch "${trapReady}"\nfor _ in $(seq 1 600); do sleep 1; done\n`);
    const tcfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { timeoutSec: 1 } });
    let fakeNowMs = Date.now();
    const s = new WorkerSupervisor({
      cfg: tcfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 20, // real timer -- but the elapsed-time MATH below is driven by fakeNowMs, not by how fast this fires
      guardHookPath: mkHook(dir),
      now: () => new Date(fakeNowMs),
    });
    const { name: laneName } = await s.dispatch({ number: 63, title: "t", labels: [] });
    // Bounded poll (20ms x 400 = 8s ceiling, same pattern PR #240 used for its own trap-ready
    // handshake) for the trap to be provably installed. The fake clock is still frozen at
    // dispatch time here, so no matter how long this takes in real wall-clock time, the
    // supervisor's own elapsed-time math still reads exactly 0 -- the timeout branch structurally
    // cannot fire during this window (race (a), closed).
    for (let i = 0; i < 400 && !existsSync(trapReady); i++) await sleep(20);
    assert.ok(existsSync(trapReady), "stub's TERM trap was installed before requestHandoff's SIGTERM");
    // Still provably pre-timeout (elapsed reads 0): a pending handoff is established first.
    assert.equal(s.requestHandoff(laneName), true); // sets handoffRequested; the stub ignores this TERM
    // Only NOW advance the fake clock past timeoutSec -- the ordering (handoff pending, THEN
    // timeout) is asserted by construction, not raced (race (b), closed).
    fakeNowMs += (tcfg.worker.timeoutSec + 1) * 1000;
    for (let i = 0; i < 400 && !existsSync(join(dir, `${laneName}.failed.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${laneName}.failed.json`)), "timeout wins over a pending handoff request");
    assert.ok(!existsSync(join(dir, `${laneName}.handoff.json`)));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #69 dirty-worktree retention: reclaim() deletes a worktree ONLY when provably clean
// (pure filesystem mtime heuristic — never a git call); possibly-dirty survives on disk. ──

test("#69: reclaim RETAINS a worktree with a file written after dispatch (possibly dirty) — left on disk for human salvage", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-dirty";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(join(worktreePath, "src"), { recursive: true });

    const { bin } = longRunningStub(dir);
    const s = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 70, title: "t", labels: [] }, name);
    await sleep(50); // ensure the WIP write lands strictly after the recorded lane start
    writeFileSync(join(worktreePath, "src", "wip.txt"), "uncommitted work\n");

    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, true);
    assert.equal(r.worktreePath, worktreePath); // absolute path, for the conductor's escalation
    assert.ok(existsSync(join(worktreePath, "src", "wip.txt")), "worktree (and its WIP) survives");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69: reclaim DELETES a clean worktree (no file touched since dispatch) — no retention noise", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-clean";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "checked-out.txt"), "pre-existing\n"); // pre-dispatch content
    await sleep(20); // strictly before the lane's recorded start

    const { bin, ready } = longRunningStub(dir);
    const s = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 71, title: "t", labels: [] }, name);
    await waitForFile(ready);

    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, false);
    assert.ok(!existsSync(worktreePath), "clean worktree removed as before");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69: reclaim of a lane with NO worktree on disk -> nothing retained, nothing to report", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir);
    const s = sup(dir, bin); // default worktreeRoot -> the lane's worktree path never exists
    const { name } = await s.dispatch({ number: 72, title: "t", labels: [] });
    await waitForFile(ready);
    const r = await s.reclaim(name);
    assert.deepEqual(r, { worktreePath: null, worktreeRetained: false });
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#69: DETACHED reclaim (post-restart, persisted pid) retains a dirty worktree using running.json's dispatched_at as the baseline", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-det";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    const { bin } = longRunningStub(dir);
    const s1 = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s1.dispatch({ number: 73, title: "t", labels: [] }, name);
    await sleep(50);
    writeFileSync(join(worktreePath, "wip.txt"), "post-dispatch work\n"); // dirty
    s1.dispose(); // "restart": s2 only knows this lane via the persisted running.json

    const s2 = sup(dir, bin, false, worktreeRoot);
    const r = await s2.reclaim(laneName);
    assert.equal(r.worktreeRetained, true);
    assert.ok(existsSync(join(worktreePath, "wip.txt")), "worktree survives a detached reclaim too");
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69 (fable P1): a RESUMED lane that crashes does NOT lose pre-handoff WIP — the retention baseline is the immutable first-dispatch time, not the resume-time started_at", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-resume-wip";
    const ready = join(dir, "stub-ready");
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    // Cooperative worker: hands off on TERM. A --resume run just prints a result and exits.
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        '  echo \'{"type":"result","subtype":"success","total_cost_usd":0.02}\'',
        "  exit 0",
        "fi",
        "trap 'exit 0' TERM",
        `touch "${ready}"`,
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 74, title: "t", labels: [] }, name);
    await sleep(50);
    // Pre-handoff WIP: written DURING the first run, mtime after first dispatch.
    writeFileSync(join(worktreePath, "wip.txt"), "pre-handoff uncommitted work\n");
    await waitForFile(ready, "stub installed its TERM trap before handoff");
    assert.equal(s.requestHandoff(laneName), true);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${laneName}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${laneName}.handoff.json`)), "handed off");
    // The handoff sentinel carried the immutable first-dispatch baseline forward.
    const handoff = JSON.parse(readFileSync(join(dir, `${laneName}.handoff.json`), "utf8"));
    assert.equal(typeof handoff.dispatched_at, "string", "dispatched_at persisted into the sentinel");

    // A long gap, then RESUME — the resumed run's started_at is now, AFTER the WIP's mtime.
    await sleep(200);
    const resumed = await s.resume({ number: 74, title: "t", labels: [] }, name);
    assert.equal(resumed.name, name);
    // running.json's started_at moved to resume-time, but dispatched_at is the ORIGINAL.
    const running = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8"));
    assert.ok(Date.parse(running.dispatched_at) < Date.parse(running.started_at), "dispatched_at predates the resume start");

    // The resumed lane is reclaimed (crash / DEAD / escalation). Pre-handoff WIP has an mtime
    // BEFORE the resume start — baselining on started_at would judge it clean and DELETE it
    // (the exact silent loss fable reproduced). Baselining on dispatched_at retains it.
    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, true, "resumed-then-crashed lane RETAINS its pre-handoff WIP");
    assert.ok(existsSync(join(worktreePath, "wip.txt")), "WIP file survives — not silently deleted");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69 (fable P2b): a file whose mtime is BACKDATED before dispatch still reads dirty via ctime — mtime-backdating cannot defeat retention", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-backdate";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    const { bin } = longRunningStub(dir);
    const s = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 75, title: "t", labels: [] }, name);
    await sleep(50);
    const wip = join(worktreePath, "wip.txt");
    writeFileSync(wip, "uncommitted work\n"); // written after dispatch -> ctime is now
    // Backdate mtime+atime to the epoch (what `touch -t`/`touch -r .git/index` does). ctime is
    // NOT settable by utimes and stays at the write time (after dispatch).
    utimesSync(wip, new Date(0), new Date(0));

    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, true, "ctime still exceeds the baseline -> retained despite backdated mtime");
    assert.ok(existsSync(wip), "backdated WIP survives");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#69 (Codex PR #72 round-2): a WIP entry whose mtime EQUALS dispatched_at exactly (same coarse-fs tick) reads dirty -> RETAINED, never deleted as clean (inclusive >= boundary)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-69-sametick";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    const { bin } = longRunningStub(dir);
    const s = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 76, title: "t", labels: [] }, name);
    await sleep(50);
    const wip = join(worktreePath, "wip.txt");
    writeFileSync(wip, "same-tick WIP\n");

    // Simulate the exact-equality tick deterministically. Pick a WHOLE-SECOND baseline in the
    // FUTURE and set the WIP file's mtime to exactly it. Whole-second matters: a modern-epoch
    // ms value loses sub-ms precision as a float (statMs = ns/1e6), so an arbitrary integer ms
    // reads back as e.g. …601.999 — never exactly equal to an integer baseline. A whole-second
    // instant has no sub-second part, so lstat's mtimeMs is an exact integer that round-trips
    // through the ISO dispatched_at. FUTURE so every ctime (pinned at write time, unsettable by
    // utimes) stays BELOW it, ruling out the ctime path. Under `>=` the file reads dirty
    // (mtime == baseline); under a strict `>` nothing exceeds the baseline -> deleted as clean.
    const baselineMs = (Math.floor(Date.now() / 1000) + 100) * 1000; // whole-second ms, future
    utimesSync(wip, new Date(baselineMs), new Date(baselineMs));
    assert.equal(lstatSync(wip).mtimeMs, baselineMs, "fs stored the exact whole-second mtime");
    const running = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8"));
    running.dispatched_at = new Date(baselineMs).toISOString();
    writeFileSync(join(dir, `${laneName}.running.json`), JSON.stringify(running));

    const r = await s.reclaim(laneName);
    assert.equal(r.worktreeRetained, true, "mtime == baseline must be treated as dirty (>=), not clean");
    assert.ok(existsSync(wip), "same-tick WIP survives — not deleted as clean");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

// ── #63: detached-lane handoff — probe() confirms death and finalizes (no onExit callback
// exists for a lane the engine only knows via a persisted running.json). #69: the finalize
// is sentinel-only now — no WIP commit/push, the worktree stays untouched. ──────────────────

test("#63/#69: detached handoff-requested lane confirmed dead -> probe() writes .handoff (session_id intact), clears running.json, leaves the worktree untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-63-a";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(join(worktreePath, "wip.txt"), "uncommitted work\n"); // WIP at kill time

    // No TERM trap -> the real CLI's empirically-confirmed shape (#60): dies by signal.
    const { bin, ready } = longRunningStub(dir);
    const s1 = sup(dir, bin, false, worktreeRoot);
    const { name: laneName, sessionId } = await s1.dispatch({ number: 63, title: "t", labels: [] }, name);
    await waitForFile(ready, "stub reached its running state before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8")).wrapper_pid as number;
    assert.equal(alive(pid), true);
    s1.dispose(); // "restart": s2 has no in-memory lane handle for this name — only the persisted file

    const s2 = sup(dir, bin, false, worktreeRoot);
    assert.equal(s2.requestHandoff(laneName), true); // detached branch: SIGTERM via the persisted pid
    const runningAfterRequest = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8"));
    assert.equal(runningAfterRequest.handoff_requested, true, "request persisted onto running.json");

    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM reached the detached process");

    // probe() is what wins the race against DEAD-reclassification (#63) — it must confirm
    // death and finalize as .handoff right here, not via any onExit callback.
    const probe = await s2.probe(laneName);
    assert.equal(probe.handoff, true);
    assert.ok(existsSync(join(dir, `${laneName}.handoff.json`)), ".handoff sentinel written by probe()");
    assert.ok(!existsSync(join(dir, `${laneName}.running.json`)), "running marker cleared");
    const sentinel = JSON.parse(readFileSync(join(dir, `${laneName}.handoff.json`), "utf8"));
    assert.equal(sentinel.session_id, sessionId, "resumable session_id carried through the detached path");
    // #69: sentinel-only — the worktree was not committed, cleaned, or otherwise touched.
    assert.equal(readFileSync(join(worktreePath, "wip.txt"), "utf8"), "uncommitted work\n");

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#63: a SECOND engine restart before death is confirmed still finalizes — the persisted running.json handoff_requested field survives even though the fresh instance's in-memory set is empty", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir); // no trap -> dies on SIGTERM
    const s1 = sup(dir, bin);
    const { name: laneName } = await s1.dispatch({ number: 64, title: "t", labels: [] });
    await waitForFile(ready, "stub reached its running state before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8")).wrapper_pid as number;
    s1.dispose(); // restart #1: engine forgets the in-process lane

    const sMid = sup(dir, bin);
    assert.equal(sMid.requestHandoff(laneName), true); // detached SIGTERM sent + persisted
    // Simulate restart #2 landing before anyone ever calls probe() on sMid (i.e. before death
    // is confirmed): a brand-new instance whose in-memory detachedHandoffRequested is empty.
    const s2 = sup(dir, bin);
    assert.equal(
      s2.requestHandoff(laneName),
      false,
      "second restart reads handoff_requested, re-signals once, and does not re-announce adoption",
    );

    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "the SIGTERM sent before restart #2 still killed it");

    const probe = await s2.probe(laneName);
    assert.equal(probe.handoff, true, "persisted handoff_requested field alone is enough to finalize");
    assert.ok(existsSync(join(dir, `${laneName}.handoff.json`)));
    assert.ok(!existsSync(join(dir, `${laneName}.running.json`)));

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#169: persisted handoff_requested closes the write-before-signal crash window by re-sending SIGTERM without re-announcing adoption", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  let s1: WorkerSupervisor | undefined;
  let s2: WorkerSupervisor | undefined;
  try {
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 169, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before simulating the crash window");
    const runningPath = join(dir, `${name}.running.json`);
    const running = JSON.parse(readFileSync(runningPath, "utf8")) as Record<string, unknown> & { wrapper_pid: number };
    const pid = running.wrapper_pid;
    assert.equal(alive(pid), true);

    // Simulate: running.json flag persisted, then the engine died before sending SIGTERM.
    writeFileSync(runningPath, `${JSON.stringify({ ...running, handoff_requested: true })}\n`);
    s1.dispose();
    s1 = undefined;

    s2 = sup(dir, bin);
    const proto = WorkerSupervisor.prototype as unknown as {
      signalGroup: (pid: number, sig: NodeJS.Signals) => void;
    };
    const s2Hooks = s2 as unknown as {
      signalGroup: (pid: number, sig: NodeJS.Signals) => void;
    };
    let signalCount = 0;
    s2Hooks.signalGroup = (targetPid, sig) => {
      signalCount++;
      proto.signalGroup.call(s2, targetPid, sig);
    };

    assert.equal(s2.requestHandoff(name), false, "persisted flag suppresses only the duplicate adoption event");
    assert.equal(signalCount, 1, "fresh supervisor re-sends SIGTERM once");
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM reached the wrapper despite the pre-existing persisted flag");

    assert.doesNotThrow(() => assert.equal(s2?.requestHandoff(name), false));
    assert.equal(signalCount, 1, "in-memory set prevents a second signal from the same supervisor");
  } finally {
    s1?.dispose();
    s2?.dispose();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#63: wrapperAlive() === -1 (unreadable pid) -> probe() does not throw, does not finalize, lane stays as-is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    // A persisted lane that claims a handoff was requested but carries no readable wrapper_pid
    // (garbage/missing) -> persistedPid() is null -> wrapperAlive() is -1 (unknown), not 0.
    writeFileSync(join(dir, "lane-63-c.running.json"), JSON.stringify({ issue: 1, session_id: "s", handoff_requested: true }));
    const probe = await s.probe("lane-63-c");
    assert.equal(probe.wrapperAlive, -1);
    assert.equal(probe.handoff, false, "an unknown pid is never treated as confirmed-dead");
    assert.equal(probe.done, false);
    assert.equal(probe.failed, false);
    assert.ok(!existsSync(join(dir, "lane-63-c.handoff.json")));
    assert.ok(existsSync(join(dir, "lane-63-c.running.json")), "running marker untouched — still just 'unknown'");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#63/#69: a lane already reclaim()'d must never also be finalized as .handoff — and its dirty worktree is RETAINED by that reclaim", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const worktreeRoot = mkdtempSync(join(tmpdir(), "sapwood-worktrees-"));
  try {
    const name = "lane-63-d";
    const worktreePath = join(worktreeRoot, name);
    mkdirSync(worktreePath, { recursive: true });

    // Ignores TERM -> survives requestHandoff's SIGTERM; only reclaim()'s SIGKILL stops it —
    // mirroring the "reclaim kills a stubborn claude subtree via SIGKILL" pattern above.
    const { bin, ready } = longRunningStub(dir, "trap '' TERM\n");
    const s1 = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s1.dispatch({ number: 65, title: "t", labels: [] }, name);
    await waitForFile(ready, "stub installed its TERM trap before engine restart");
    writeFileSync(join(worktreePath, "wip.txt"), "uncommitted\n"); // post-dispatch WIP -> dirty
    const pid = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8")).wrapper_pid as number;
    s1.dispose();

    const s2 = sup(dir, bin, false, worktreeRoot);
    assert.equal(s2.requestHandoff(laneName), true); // detached SIGTERM sent (ignored by the stub)
    assert.equal(alive(pid), true, "stub ignores TERM — still alive right after the drain request");

    // The conductor's escalation path (ceiling drain window elapsed, or a DEAD reclassification)
    // reaches this same lane and reclaims it — it's going FAILED, not resumable.
    const r = await s2.reclaim(laneName);
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "reclaim()'s SIGKILL escalation tore it down");
    assert.equal(r.worktreeRetained, true, "dirty worktree preserved for human salvage (#69)");
    assert.ok(existsSync(join(worktreePath, "wip.txt")));

    const probe = await s2.probe(laneName);
    assert.equal(probe.handoff, false, "a reclaimed lane must never be finalized as resumable");
    assert.ok(!existsSync(join(dir, `${laneName}.handoff.json`)), "no .handoff written");

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(worktreeRoot, { recursive: true, force: true });
  }
});

test("#63 F1: a failure persisting handoff_requested onto running.json is swallowed — requestHandoff still returns true and the SIGTERM still lands (Codex second-opinion review, PR #67: it's called unguarded from the conductor's CEILING drain loop, which must never abort mid-tick)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 66, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    s1.dispose(); // "restart": s2 only knows this lane via the persisted running.json

    const s2 = sup(dir, bin);
    // Force the persist write to fail exactly like an ENOSPC/EACCES/EROFS would — stubbing
    // the private writeJsonAtomic is the most portable way to force this (a chmod-based
    // fixture would be a no-op when the test runs as root). requestHandoff must swallow it.
    (s2 as unknown as { writeJsonAtomic: (p: string, obj: unknown) => void }).writeJsonAtomic = () => {
      throw new Error("simulated disk failure");
    };

    let result: boolean | undefined;
    assert.doesNotThrow(() => {
      result = s2.requestHandoff(name);
    });
    assert.equal(result, true, "SIGTERM still gets sent even though the persist write failed");

    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM reached the detached process despite the persist failure");

    // Confirms this actually exercised the failing write path (not a silent no-op): the field
    // never landed, because the stubbed writeJsonAtomic threw instead of writing.
    const running = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8"));
    assert.notEqual(running.handoff_requested, true);

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#63 P2: requestHandoff's detached branch persists handoff_requested BEFORE sending the SIGTERM, not after (Codex second-opinion review, PR #67 — closes the gap where the engine could die between 'signal sent' and 'flag persisted', losing the very record the flag exists to survive)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { bin, ready } = longRunningStub(dir, "trap 'exit 0' TERM\n");
    const s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 67, title: "t", labels: [] });
    await waitForFile(ready, "stub installed its TERM trap before engine restart");
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    s1.dispose(); // "restart": s2 only knows this lane via the persisted running.json

    const s2 = sup(dir, bin);
    // A shared call-order log — wrap (not replace) the real private writeJsonAtomic/signalGroup
    // so the actual persist + actual SIGTERM still happen (this test also verifies the
    // end-to-end outcome), while recording which one ran first.
    const order: string[] = [];
    const proto = WorkerSupervisor.prototype as unknown as {
      writeJsonAtomic: (p: string, obj: unknown) => void;
      signalGroup: (pid: number, sig: NodeJS.Signals) => void;
    };
    const s2Hooks = s2 as unknown as {
      writeJsonAtomic: (p: string, obj: unknown) => void;
      signalGroup: (pid: number, sig: NodeJS.Signals) => void;
    };
    s2Hooks.writeJsonAtomic = (p, obj) => {
      order.push("persist");
      proto.writeJsonAtomic.call(s2, p, obj);
    };
    s2Hooks.signalGroup = (targetPid, sig) => {
      order.push("signal");
      proto.signalGroup.call(s2, targetPid, sig);
    };

    assert.equal(s2.requestHandoff(name), true);
    assert.deepEqual(order, ["persist", "signal"], "the persisted flag write must happen before the SIGTERM is sent");

    const running = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8"));
    assert.equal(running.handoff_requested, true, "persist actually landed on disk");

    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "SIGTERM still reached the detached process");

    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #74: file-based worker prompt ──

test("renderPromptTemplate: substitutes issue.number/title/body/labels", () => {
  const issue = { number: 42, title: "Fix the thing", labels: ["type:docs", "verify:n/a"], body: "do X and Y" };
  const out = renderPromptTemplate("Issue #{{issue.number}}: {{issue.title}} [{{issue.labels}}]\n\n{{issue.body}}", issue);
  assert.equal(out, "Issue #42: Fix the thing [type:docs, verify:n/a]\n\ndo X and Y");
});

test("renderPromptTemplate: absent issue.body substitutes as empty string, never throws", () => {
  const issue = { number: 1, title: "t", labels: [] }; // no body field
  assert.equal(renderPromptTemplate("body=[{{issue.body}}]", issue), "body=[]");
});

test("renderPromptTemplate: fails closed on an unknown {{var}} — no silent literal passthrough", () => {
  const issue = { number: 1, title: "t", labels: [] };
  assert.throws(() => renderPromptTemplate("hello {{issue.author}}", issue), /unknown variable.*issue\.author/i);
});

test("renderPromptTemplate: fails closed on names outside [\\w.] — {{issue-title}} is not literal passthrough", () => {
  const issue = { number: 1, title: "t", labels: [] };
  assert.throws(() => renderPromptTemplate("hello {{issue-title}}", issue), /unknown variable.*issue-title/i);
});

test("renderPromptTemplate: fails closed on prototype-chain names — {{constructor}} never resolves", () => {
  const issue = { number: 1, title: "t", labels: [] };
  assert.throws(() => renderPromptTemplate("hello {{constructor}}", issue), /unknown variable.*constructor/i);
  assert.throws(() => renderPromptTemplate("hello {{toString}}", issue), /unknown variable.*toString/i);
});

test("defaultPromptPath: resolves to the shipped prompts/worker.md, which exists and mentions the vars", () => {
  const p = defaultPromptPath();
  assert.ok(existsSync(p), `expected shipped default prompt at ${p}`);
  const text = readFileSync(p, "utf8");
  assert.match(text, /\{\{issue\.number\}\}/);
  assert.match(text, /\{\{issue\.title\}\}/);
  assert.match(text, /\{\{issue\.body\}\}/);
});

test("loadWorkerPromptTemplate: unset promptFile -> the shipped default (byte-identical)", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  assert.equal(loadWorkerPromptTemplate(scfg), readFileSync(defaultPromptPath(), "utf8"));
});

test("loadWorkerPromptTemplate: promptFile set -> loads that file's raw content", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "custom.md");
    writeFileSync(p, "Custom prompt for #{{issue.number}}");
    const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { promptFile: p } });
    assert.equal(loadWorkerPromptTemplate(scfg), "Custom prompt for #{{issue.number}}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadWorkerPromptTemplate: fails fast, naming the path, when promptFile is missing (never silently falls back)", () => {
  const scfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    worker: { promptFile: "/nonexistent/does-not-exist.md" },
  });
  assert.throws(() => loadWorkerPromptTemplate(scfg), /\/nonexistent\/does-not-exist\.md/);
});

test("loadWorkerPromptTemplate: fails fast when promptFile exists but is unreadable (permission denied)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "unreadable.md");
    writeFileSync(p, "secret template");
    chmodSync(p, 0o000);
    if (process.getuid && process.getuid() === 0) return; // root ignores perms — skip under root
    const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { promptFile: p } });
    assert.throws(() => loadWorkerPromptTemplate(scfg), /unreadable/i);
  } finally {
    chmodSync(join(dir, "unreadable.md"), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: loads once, eagerly (fail-fast happens at build time, not on first render)", () => {
  const scfg = ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    worker: { promptFile: "/nonexistent/does-not-exist.md" },
  });
  assert.throws(() => buildRenderPrompt(scfg), /\/nonexistent\/does-not-exist\.md/);
});

test("buildRenderPrompt: empty/whitespace template throws at build time — never dispatch an undirected worker", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "empty.md");
    writeFileSync(p, "  \n\n\t");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
    });
    assert.throws(() => buildRenderPrompt(scfg), /empty/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: substituted config values are literal — a {{issue.body}}-valued config var is NOT re-expanded", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "inject.md");
    writeFileSync(p, "label: {{labels.verifyNa}}");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      labels: { verifyNa: "{{issue.body}}" },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: [], body: "SECRET" });
    assert.equal(rendered, "label: {{issue.body}}");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: config vars substitute at build time — customized labels.verifyNa reaches the prompt", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "cfg-var.md");
    writeFileSync(p, "skip red/green if labelled {{labels.verifyNa}} on #{{issue.number}}");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      labels: { verifyNa: "no-verify" },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 7, title: "t", labels: [] });
    assert.equal(rendered, "skip red/green if labelled no-verify on #7");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: the shipped default prompt builds clean (all its vars are known)", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: ["verify:n/a"], body: "b" });
  assert.match(rendered, /labelled `sapwood:verify:n\/a`/);
  assert.doesNotMatch(rendered, /\{\{/);
});

// ── #245 round-2 fix A7: buildRenderFixPrompt — deliberately NARROWER var set than
//    buildRenderPrompt's own (issue.number/pr.number/labels.verifyNa only; never
//    issue.title/body/labels — a fix leg's evidence channel is the PR-facing proxy tools, not
//    issue prose) — and takes a bare issue NUMBER, never a fabricated `Issue` object. ──────────

test("defaultFixPromptPath: resolves to the shipped prompts/fix.md, which exists and mentions pr.number/issue.number", () => {
  const p = defaultFixPromptPath();
  assert.ok(existsSync(p));
  const content = readFileSync(p, "utf8");
  assert.match(content, /\{\{pr\.number\}\}/);
  assert.match(content, /\{\{issue\.number\}\}/);
});

test("loadFixPromptTemplate: unset fixPromptFile -> the shipped default (byte-identical)", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  assert.equal(loadFixPromptTemplate(scfg), readFileSync(defaultFixPromptPath(), "utf8"));
});

test("loadFixPromptTemplate: fails fast, naming the path, when fixPromptFile is missing (never silently falls back)", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { fixPromptFile: "/no/such/fix.md" } });
  assert.throws(() => loadFixPromptTemplate(scfg), /fix\.md/);
});

test("buildRenderFixPrompt: the shipped default prompt builds clean (all its vars are known) and takes a bare issue NUMBER + pr number", () => {
  const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  const rendered = buildRenderFixPrompt(scfg)(42, 77);
  assert.match(rendered, /#77/);
  assert.match(rendered, /#42/);
  assert.doesNotMatch(rendered, /\{\{/);
});

test("buildRenderFixPrompt: supported vars are issue.number/pr.number/labels.verifyNa ONLY — issue.title/issue.body/issue.labels are UNKNOWN and fail closed at build time (A7 narrowing)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fixprompt-"));
  try {
    for (const badVar of ["issue.title", "issue.body", "issue.labels"]) {
      const p = join(dir, `bad-${badVar.replace(".", "-")}.md`);
      writeFileSync(p, `fix {{${badVar}}}`);
      const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { fixPromptFile: p } });
      assert.throws(() => buildRenderFixPrompt(cfg), new RegExp(`unknown variable.*${badVar.replace(".", "\\.")}`, "i"));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderFixPrompt: {{issue.number}}/{{pr.number}}/{{labels.verifyNa}} all substitute correctly from a custom template", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fixprompt-"));
  try {
    const p = join(dir, "custom-fix.md");
    writeFileSync(p, "fix issue #{{issue.number}} pr #{{pr.number}}, skip if {{labels.verifyNa}}");
    const cfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { fixPromptFile: p },
      labels: { verifyNa: "verify:custom" },
    });
    const rendered = buildRenderFixPrompt(cfg)(9, 99);
    assert.equal(rendered, "fix issue #9 pr #99, skip if verify:custom");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderFixPrompt: empty/whitespace template throws at build time — never start an undirected fix leg", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fixprompt-"));
  try {
    const p = join(dir, "empty-fix.md");
    writeFileSync(p, "   \n  ");
    const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { fixPromptFile: p } });
    assert.throws(() => buildRenderFixPrompt(cfg), /empty/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #167: {{doctrine}} — repo-level review doctrine injected into the worker brief ─────────────

test("buildRenderPrompt: with no doctrine.file on disk, {{doctrine}} substitutes the explicit 'none' placeholder — behavior unchanged, never an error", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "tpl.md");
    writeFileSync(p, "DOCTRINE: {{doctrine}}");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      doctrine: { file: join(dir, "does-not-exist-DOCTRINE.md") },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: [] });
    assert.match(rendered, /DOCTRINE: \(No review doctrine file is configured/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: with a doctrine.file present, {{doctrine}} substitutes its content, bounded by doctrine.maxChars", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "tpl.md");
    writeFileSync(p, "DOCTRINE: {{doctrine}}");
    const doctrinePath = join(dir, "DOCTRINE.md");
    writeFileSync(doctrinePath, "the disabled-consumer rule matters here");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      doctrine: { file: doctrinePath },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: [] });
    assert.equal(rendered, "DOCTRINE: the disabled-consumer rule matters here");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: an oversized doctrine.file is deterministically truncated with a marked cut when substituted into {{doctrine}}", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "tpl.md");
    writeFileSync(p, "{{doctrine}}");
    const doctrinePath = join(dir, "DOCTRINE.md");
    writeFileSync(doctrinePath, "y".repeat(5000));
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
      // #167 review (Codex P3): doctrine.maxChars now has a 200-char floor (config.ts) so the
      // truncation marker itself always fits — 200 is the smallest legal value here.
      doctrine: { file: doctrinePath, maxChars: 200 },
    });
    const rendered = buildRenderPrompt(scfg)({ number: 1, title: "t", labels: [] });
    assert.ok(rendered.length <= 200, `expected <= 200 chars, got ${rendered.length}`);
    assert.match(rendered, /truncated/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: unknown {{var}} in the template throws at BUILD time, before any issue is claimed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-prompt-"));
  try {
    const p = join(dir, "bad-var.md");
    writeFileSync(p, "work on {{issue.url}}");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: p },
    });
    assert.throws(() => buildRenderPrompt(scfg), /unknown variable.*issue\.url/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("buildRenderPrompt: end-to-end — the dispatched worker's -p prompt equals the rendered template file (fake supervisor)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const templatePath = join(dir, "e2e-worker.md");
    writeFileSync(templatePath, 'Do issue #{{issue.number}} ("{{issue.title}}"):\n{{issue.body}}');
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: templatePath },
    });
    const renderPrompt = buildRenderPrompt(scfg);
    const hook = mkHook(dir);
    // stub records its argv so we can inspect exactly what -p carried (same trick as the
    // #26 inline-settings test above).
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      cfg: scfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt,
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    await s.dispatch({ number: 74, title: "File-based worker prompt", labels: [], body: "wire promptFile through renderPrompt" });
    await waitForFile(join(dir, "args.seen"), "rendered-prompt argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    const expected = renderPromptTemplate(readFileSync(templatePath, "utf8"), {
      number: 74,
      title: "File-based worker prompt",
      labels: [],
      body: "wire promptFile through renderPrompt",
    });
    assert.ok(args.includes(expected), `expected the rendered template in the spawned argv, got:\n${args}`);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// #244: worker-leg forge MCP proxy attachment — mirrors peripheral.ts's RoleRunner mechanism
// (#234), extended here to WorkerSupervisor.dispatch(). Unattached dispatch (every test above
// this section) is COMPLETELY UNCHANGED — these tests only cover the NEW opt-in `proxy` param.
// ─────────────────────────────────────────────────────────────────────────────

function fakeWorkerProxyHandle(over: Partial<{ mcpConfigJson: string; toolNames: string[] }> = {}) {
  const calls = { minted: 0, stopped: 0 };
  const handle = {
    port: 1,
    token: "proxy-test-token",
    url: "http://127.0.0.1:1/mcp",
    mcpConfigJson: JSON.stringify({
      mcpServers: { forge: { type: "http", url: "http://127.0.0.1:1/mcp", headers: { Authorization: "Bearer proxy-test-token" } } },
    }),
    toolNames: ["mcp__forge__pr_details", "mcp__forge__pr_reviews", "mcp__forge__pr_review_threads", "mcp__forge__pr_checks"],
    ...over,
    stop: async () => {
      calls.stopped++;
    },
  };
  return { calls, handle };
}

test("dispatch: a proxy opt mints a handle, widens --allowedTools with the handle's own tool names, and injects --mcp-config inline JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { calls, handle } = fakeWorkerProxyHandle();
    const { name } = await s.dispatch({ number: 1, title: "t", labels: [] }, undefined, {
      proxy: {
        mint: async (session) => {
          calls.minted++;
          assert.equal(session.role, "worker");
          return handle as never;
        },
      },
    });
    await waitForFile(join(dir, "args.seen"), "proxy dispatch argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.match(args, /mcp__forge__pr_details/);
    assert.match(args, /--mcp-config/);
    assert.ok(args.includes(JSON.stringify(handle.mcpConfigJson)) === false); // sanity: not double-JSON-encoded
    const i = args.trim().split("\n").indexOf("--mcp-config");
    assert.equal(args.trim().split("\n")[i + 1], handle.mcpConfigJson);
    assert.equal(calls.minted, 1);
    for (let i2 = 0; i2 < 400 && !existsSync(join(dir, `${name}.done.json`)); i2++) await sleep(20);
    for (let i2 = 0; i2 < 400 && calls.stopped === 0; i2++) await sleep(20);
    assert.equal(calls.stopped, 1, "the proxy is torn down once the lane's process exits (onExit)");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: no proxy opt (every ordinary caller today) -> no --mcp-config flag, --allowedTools unchanged — byte-identical to pre-#244 behavior", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    await s.dispatch({ number: 1, title: "t", labels: [] });
    await waitForFile(join(dir, "args.seen"), "ordinary dispatch argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.doesNotMatch(args, /--mcp-config/);
    assert.doesNotMatch(args, /mcp__forge__/);
    assert.match(args, /Bash\(gh \*\)/, "the code-producing worker's own default --allowedTools is unchanged");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: a proxy mint FAILURE is non-fatal — the lane still dispatches and runs, unattached (mirrors peripheral.ts's RoleRunner stance)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name } = await s.dispatch({ number: 1, title: "t", labels: [] }, undefined, {
      proxy: {
        mint: async () => {
          throw new Error("mint failed");
        },
      },
    });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "lane still completes despite the mint failure");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: a spawn failure with a proxy attached still tears down the minted proxy (never leaks a live listener/token)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: join(dir, "does-not-exist-claude"),
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    const { calls, handle } = fakeWorkerProxyHandle();
    await assert.rejects(
      () =>
        s.dispatch({ number: 1, title: "t", labels: [] }, "lane-bad-proxy", {
          proxy: {
            mint: async () => {
              calls.minted++;
              return handle as never;
            },
          },
        }),
      /spawn failed/i,
    );
    assert.equal(calls.minted, 1);
    assert.equal(calls.stopped, 1, "the proxy is torn down even though dispatch() THREW rather than returned");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #244 (Codex sol-high PR #260 review round 2, P2): the credentialFree GH_CONFIG_DIR scratch
// directory (created BEFORE spawn, once mint has already succeeded) must be cleaned up on the
// spawn-failure path too — not just onExit — or it leaks as directory litter under stateDir
// every time a credentialFree leg fails to spawn.
test("dispatch: a spawn failure on a credentialFree leg (mint succeeded, spawn failed) removes the GH_CONFIG_DIR scratch directory it already created", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: join(dir, "does-not-exist-claude"),
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    const { handle } = fakeWorkerProxyHandle();
    await assert.rejects(
      () =>
        s.dispatch({ number: 1, title: "t", labels: [] }, "lane-credfree-spawnfail", {
          proxy: { mint: async () => handle as never, credentialFree: true },
        }),
      /spawn failed/i,
    );
    const ghConfigDir = join(dir, "lane-credfree-spawnfail.gh-config-empty");
    assert.ok(!existsSync(ghConfigDir), "GH_CONFIG_DIR scratch directory must not survive a spawn failure");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #244 AC (issue's own phrasing): "#218 credential-free regression tests extended to a worker
// leg with the proxy handle attached (spawn env token-free; proxy is the only forge reach)".
// HONEST SCOPE (round-2 delta review, P1): "only forge reach" holds for the `gh`/git
// CREDENTIALED-TOOL path this test asserts — it does NOT mean a worker leg's Bash(node/npm)
// grant can't read an ambient credential store directly off disk (workerCredentialFreeEnv's own
// doc names that residual explicitly; it is NOT closed here or anywhere in this PR). Distinct
// from the ordinary dispatch env test above (line ~1238), which asserts workers LEGITIMATELY
// keep GH_TOKEN by default — this is the NEW, separately-opted-into shape
// (WorkerProxyOpts.credentialFree).
test("dispatch: credentialFree opt strips forge/git credential env vars and severs gh/git's own credential-lookup paths for a worker leg — same denylist as peripheral.ts's #218 regression, NOT a claim of full isolation (see workerCredentialFreeEnv's doc)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const release = join(dir, "release-stub");
  const poisoned = {
    GH_TOKEN: "poison-gh-token",
    GITHUB_TOKEN: "poison-github-token",
    GITHUB_ENTERPRISE_TOKEN: "poison-github-enterprise-token",
    GH_CONFIG_DIR: "/poison/gh-config",
    GH_HOST: "poison.example",
    GIT_ASKPASS: "/poison/askpass",
    GIT_CONFIG_GLOBAL: "/poison/gitconfig",
    GIT_CONFIG_COUNT: "1",
    SSH_AUTH_SOCK: "/poison/ssh-agent.sock",
    ANTHROPIC_API_KEY: "preserved-anthropic-auth",
  } as const;
  const previous = Object.fromEntries(Object.keys(poisoned).map((key) => [key, process.env[key]]));
  try {
    Object.assign(process.env, poisoned);
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\nmv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\nenv > "${join(dir, "env.seen.tmp")}"\nmv "${join(dir, "env.seen.tmp")}" "${join(dir, "env.seen")}"\nfor _ in $(seq 1 400); do [ -f "${release}" ] && break; sleep 0.02; done\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { handle } = fakeWorkerProxyHandle();
    const { name } = await s.dispatch({ number: 1, title: "t", labels: [] }, undefined, {
      proxy: { mint: async () => handle as never, credentialFree: true },
    });
    await waitForFile(join(dir, "env.seen"), "credential-free dispatch env was not published");
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
      assert.ok(!envText.includes(`${key}=poison`), `${key} leaked into the credential-free worker leg's env`);
    }
    assert.ok(envText.includes("ANTHROPIC_API_KEY=preserved-anthropic-auth"), "Claude auth is preserved");
    assert.ok(!envText.includes("proxy-test-token"), "the proxy's bearer token never reaches the spawn env — --mcp-config only");
    // #244 (Codex sol-high PR #260 review, P1): env-var stripping alone is insufficient — assert
    // the FULL severing shape: GH_CONFIG_DIR repointed at a fresh, EMPTY, per-lane directory
    // (never the poisoned value, never the real $HOME/.config/gh), GIT_CONFIG_GLOBAL/SYSTEM
    // pointed at /dev/null, GIT_TERMINAL_PROMPT=0 (fail closed rather than prompt), and no
    // SSH_AUTH_SOCK at all (an inherited agent socket is a live credential channel on its own).
    const ghConfigDirLine = envText.split("\n").find((l) => l.startsWith("GH_CONFIG_DIR="));
    assert.ok(ghConfigDirLine, "GH_CONFIG_DIR must be set");
    const ghConfigDir = ghConfigDirLine!.slice("GH_CONFIG_DIR=".length);
    assert.notEqual(ghConfigDir, "/poison/gh-config");
    assert.ok(existsSync(ghConfigDir), "the GH_CONFIG_DIR path must actually exist as a directory");
    assert.deepEqual(readdirSync(ghConfigDir), [], "GH_CONFIG_DIR must be a FRESH, EMPTY directory — never gh's real stored config");
    assert.match(envText, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
    assert.match(envText, /^GIT_CONFIG_SYSTEM=\/dev\/null$/m);
    assert.match(envText, /^GIT_TERMINAL_PROMPT=0$/m);
    assert.doesNotMatch(envText, /^SSH_AUTH_SOCK=/m);
    // #244 (Codex sol-high PR #260 review, P1): the grant itself narrows — a credentialFree leg
    // whose env can no longer authenticate `gh` at all must not still be OFFERED `gh` as a tool.
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    const allowedToolsIdx = args.trim().split("\n").indexOf("--allowedTools");
    const allowedTools = args.trim().split("\n")[allowedToolsIdx + 1]!;
    assert.doesNotMatch(allowedTools, /Bash\(gh \*\)/, "credentialFree must drop Bash(gh *) from the grant");
    assert.match(allowedTools, /Bash\(git \*\)/, "git stays — its own credential path is what's severed, not the tool grant");
    // #244 (Codex sol-high PR #260 review round 2, P2): the per-lane GH_CONFIG_DIR scratch
    // directory is cleaned up once the lane exits — never left behind as directory litter.
    writeFileSync(release, "");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    for (let i = 0; i < 400 && existsSync(ghConfigDir); i++) await sleep(20);
    assert.ok(!existsSync(ghConfigDir), "GH_CONFIG_DIR scratch directory must be removed once the lane exits (onExit)");
    s.dispose();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test("workerCredentialFreeEnv: pure unit — composes the exact env shape (GH_CONFIG_DIR/GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM/GIT_TERMINAL_PROMPT, no SSH_AUTH_SOCK/GH_TOKEN)", () => {
  const previous = { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK, GH_TOKEN: process.env.GH_TOKEN };
  try {
    process.env.SSH_AUTH_SOCK = "/tmp/agent.sock";
    process.env.GH_TOKEN = "poison";
    const env = workerCredentialFreeEnv("/tmp/fake-gh-config-dir");
    assert.equal(env.GH_CONFIG_DIR, "/tmp/fake-gh-config-dir");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.SSH_AUTH_SOCK, undefined);
    assert.equal(env.GH_TOKEN, undefined);
  } finally {
    if (previous.SSH_AUTH_SOCK === undefined) delete process.env.SSH_AUTH_SOCK;
    else process.env.SSH_AUTH_SOCK = previous.SSH_AUTH_SOCK;
    if (previous.GH_TOKEN === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previous.GH_TOKEN;
  }
});

test("WORKER_ALLOWED_TOOLS_NO_GH: byte-identical to WORKER_ALLOWED_TOOLS minus Bash(gh *), git stays", () => {
  assert.doesNotMatch(WORKER_ALLOWED_TOOLS_NO_GH, /Bash\(gh \*\)/);
  assert.match(WORKER_ALLOWED_TOOLS_NO_GH, /Bash\(git \*\)/);
  assert.match(WORKER_ALLOWED_TOOLS_NO_GH, /Read/);
  assert.match(WORKER_ALLOWED_TOOLS_NO_GH, /Write/);
});

// #244 (Codex sol-high PR #260 review, P2): fail-closed policy — credentialFree + a failed mint
// leaves a leg with NEITHER the gh/git credentialed-tool path (severed by workerCredentialFreeEnv)
// NOR a working evidence channel, so dispatch() must REFUSE outright rather than silently run
// degraded (distinct from the non-credentialFree mint-failure case above, which stays non-fatal).
test("dispatch: credentialFree + mint FAILURE refuses the dispatch outright (fail-closed) — no lane created, no sentinel written", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    await assert.rejects(
      () =>
        s.dispatch({ number: 1, title: "t", labels: [] }, "lane-credfree-mintfail", {
          proxy: {
            mint: async () => {
              throw new Error("mint failed");
            },
            credentialFree: true,
          },
        }),
      /credentialFree|refused/i,
    );
    assert.ok(!existsSync(join(dir, "lane-credfree-mintfail.jsonl")), "no jsonl left behind for a refused dispatch");
    assert.ok(!existsSync(join(dir, "lane-credfree-mintfail.running.json")), "no running marker left behind for a refused dispatch");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #244 (Codex sol-high PR #260 review, P2): durable mint-failure observability — a
// `proxy-mint-failed` event, recorded via WorkerDeps.state, for BOTH branches (non-fatal and
// fail-closed) so a repeated/systemic mint failure is queryable, not just a transient log line.
test("dispatch: a mint failure records a durable 'proxy-mint-failed' event (WorkerDeps.state) — both the non-fatal and the fail-closed branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const state = new State(":memory:");
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
      state,
    });
    // Branch 1: non-fatal (no credentialFree) — the lane still dispatches.
    await s.dispatch({ number: 1, title: "t", labels: [] }, "lane-mintfail-nonfatal", {
      proxy: {
        mint: async () => {
          throw new Error("mint failed #1");
        },
      },
    });
    // Branch 2: fail-closed (credentialFree) — dispatch is refused.
    await assert.rejects(() =>
      s.dispatch({ number: 2, title: "t", labels: [] }, "lane-mintfail-failclosed", {
        proxy: {
          mint: async () => {
            throw new Error("mint failed #2");
          },
          credentialFree: true,
        },
      }),
    );
    const events = state.eventsSince("1970-01-01T00:00:00Z", ["proxy-mint-failed"]);
    assert.equal(events.length, 2);
    const lanes = events.map((e) => (e.payload as { lane: string }).lane).sort();
    assert.deepEqual(lanes, ["lane-mintfail-failclosed", "lane-mintfail-nonfatal"]);
    for (const e of events) {
      const payload = e.payload as { role: string; reason: string };
      assert.equal(payload.role, "worker");
      assert.ok(payload.reason.includes("mint failed"));
    }
    s.dispose();
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch: a proxy attached WITHOUT credentialFree keeps today's env inheritance — a worker leg legitimately keeps GH_TOKEN unless it explicitly opts into credentialFree", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const previousGhToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "worker-forge-token";
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\necho "$GH_TOKEN" > "${join(dir, "token.seen.tmp")}"\nmv "${join(dir, "token.seen.tmp")}" "${join(dir, "token.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { handle } = fakeWorkerProxyHandle();
    await s.dispatch({ number: 1, title: "t", labels: [] }, undefined, { proxy: { mint: async () => handle as never } });
    await waitForFile(join(dir, "token.seen"), "inherited worker token was not published");
    assert.equal(readFileSync(join(dir, "token.seen"), "utf8").trim(), "worker-forge-token");
    s.dispose();
  } finally {
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #245: resume()'s own forge MCP proxy attachment — mirrors dispatch()'s #244 mechanism above,
// extended to WorkerSupervisor.resume() (the fix-loop worker leg's evidence channel). Every
// resume() test ABOVE this section (no proxy/prompt opt) is unchanged behavior; these tests
// cover only the NEW opt-in `proxy`/`prompt` params.
// ─────────────────────────────────────────────────────────────────────────────

/** Dispatches a cooperative (TERM-trap) lane and hands it off, leaving a `.handoff` sentinel
 *  ready for resume() — the common setup every test below needs. `postResumeBody` is the bash
 *  fragment that runs ONLY on the `--resume` invocation (the fresh dispatch always sleeps +
 *  traps TERM, standing in for the original leg). */
async function mkHandoffLane(
  dir: string,
  postResumeBody: string,
): Promise<{ s: WorkerSupervisor; name: string; sessionId: string; hook: string }> {
  const hook = mkHook(dir);
  const ready = join(dir, "stub-ready");
  const bin = mkStub(
    dir,
    [
      "#!/usr/bin/env bash",
      'if [[ "$*" == *"--resume"* ]]; then',
      postResumeBody,
      "fi",
      "trap 'exit 0' TERM",
      `touch "${ready}"`,
      "for _ in $(seq 1 600); do sleep 1; done",
      "",
    ].join("\n"),
  );
  const s = new WorkerSupervisor({
    cfg,
    stateDir: dir,
    claudeBin: bin,
    hasOpenPr: async () => false,
    renderPrompt: () => "issue-rendered-prompt",
    heartbeatMs: 50,
    guardHookPath: hook,
  });
  const { name, sessionId } = await s.dispatch({ number: 9, title: "t", labels: [] });
  await waitForFile(ready, "stub installed its TERM trap before handoff");
  assert.equal(s.requestHandoff(name), true);
  for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
  assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "handed off before resuming");
  return { s, name, sessionId, hook };
}

const RESULT_LINE =
  'echo \'{"type":"result","subtype":"success","total_cost_usd":0.01,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}\'\nexit 0';

test("resume: a proxy opt mints a handle, widens --allowedTools with the handle's own tool names, and injects --mcp-config inline JSON", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  ${RESULT_LINE}`,
    );
    const { calls, handle } = fakeWorkerProxyHandle();
    const resumed = await s.resume({ number: 9, title: "t", labels: [] }, name, {
      proxy: {
        mint: async (session) => {
          calls.minted++;
          assert.equal(session.role, "worker");
          assert.equal(session.session, name);
          return handle as never;
        },
      },
    });
    assert.equal(resumed.name, name);
    await waitForFile(join(dir, "args.seen"), "proxy resume argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.match(args, /mcp__forge__pr_details/);
    assert.match(args, /--mcp-config/);
    const idx = args.trim().split("\n").indexOf("--mcp-config");
    assert.equal(args.trim().split("\n")[idx + 1], handle.mcpConfigJson);
    assert.equal(calls.minted, 1);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    for (let i = 0; i < 400 && calls.stopped === 0; i++) await sleep(20);
    assert.equal(calls.stopped, 1, "the proxy is torn down once the resumed lane's process exits (onExit)");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: opts.prompt REPLACES the ordinary issue-rendered prompt — the fix leg's own fix instruction — and is the exact string passed to claude -p", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  ${RESULT_LINE}`,
    );
    await s.resume({ number: 9, title: "t", labels: [] }, name, { prompt: "fix-leg: address PR #42's review findings" });
    await waitForFile(join(dir, "args.seen"), "prompt-override resume argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8").trim().split("\n");
    const promptIdx = args.indexOf("-p");
    assert.equal(args[promptIdx + 1], "fix-leg: address PR #42's review findings");
    assert.ok(!args.includes("issue-rendered-prompt"), "the ordinary renderPrompt output must not appear when opts.prompt overrides it");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: no proxy/prompt opt -> byte-identical to pre-#245 behavior (renderPrompt output, no --mcp-config)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  ${RESULT_LINE}`,
    );
    await s.resume({ number: 9, title: "t", labels: [] }, name);
    await waitForFile(join(dir, "args.seen"), "ordinary resume argv was not published");
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.doesNotMatch(args, /--mcp-config/);
    assert.doesNotMatch(args, /mcp__forge__/);
    assert.match(args, /issue-rendered-prompt/);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a proxy mint FAILURE is non-fatal — the resumed leg still runs, unattached", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(dir, `  ${RESULT_LINE}`);
    await s.resume({ number: 9, title: "t", labels: [] }, name, {
      proxy: {
        mint: async () => {
          throw new Error("mint failed");
        },
      },
    });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "resumed leg still completes despite the mint failure");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: credentialFree + mint FAILURE refuses the resume outright (fail-closed) — .handoff sentinel and prior jsonl are left INTACT (never destroyed, unlike dispatch()'s fresh-lane cleanup)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(dir, `  ${RESULT_LINE}`);
    const priorJsonl = readFileSync(join(dir, `${name}.jsonl`), "utf8");
    await assert.rejects(
      () =>
        s.resume({ number: 9, title: "t", labels: [] }, name, {
          proxy: {
            mint: async () => {
              throw new Error("mint failed");
            },
            credentialFree: true,
          },
        }),
      /credentialFree|refused/i,
    );
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "a refused resume must leave the lane exactly as resumable as before");
    assert.equal(readFileSync(join(dir, `${name}.jsonl`), "utf8"), priorJsonl, "prior-leg jsonl history must survive a refused resume");
    // A genuine retry (no credentialFree, or a working mint) must still be possible afterward.
    const retried = await s.resume({ number: 9, title: "t", labels: [] }, name);
    assert.equal(retried.name, name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: credentialFree strips forge/git credential env vars and narrows --allowedTools (drops Bash(gh *), keeps Bash(git *)) for the resumed leg", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const release = join(dir, "release-resumed-stub");
  const previousGhToken = process.env.GH_TOKEN;
  try {
    process.env.GH_TOKEN = "poison-gh-token";
    const { s, name } = await mkHandoffLane(
      dir,
      `  printf '%s\\n' "$@" > "${join(dir, "args.seen.tmp")}"\n  mv "${join(dir, "args.seen.tmp")}" "${join(dir, "args.seen")}"\n  env > "${join(dir, "env.seen.tmp")}"\n  mv "${join(dir, "env.seen.tmp")}" "${join(dir, "env.seen")}"\n  for _ in $(seq 1 400); do [ -f "${release}" ] && break; sleep 0.02; done\n  ${RESULT_LINE}`,
    );
    const { handle } = fakeWorkerProxyHandle();
    await s.resume({ number: 9, title: "t", labels: [] }, name, { proxy: { mint: async () => handle as never, credentialFree: true } });
    await waitForFile(join(dir, "env.seen"), "credential-free resume env was not published");
    const envText = readFileSync(join(dir, "env.seen"), "utf8");
    assert.ok(!envText.includes("GH_TOKEN=poison-gh-token"), "GH_TOKEN must not leak into a credentialFree resumed leg's env");
    const ghConfigDirLine = envText.split("\n").find((l) => l.startsWith("GH_CONFIG_DIR="));
    assert.ok(ghConfigDirLine);
    const ghConfigDir = ghConfigDirLine!.slice("GH_CONFIG_DIR=".length);
    assert.ok(existsSync(ghConfigDir), "GH_CONFIG_DIR must exist as a fresh directory");
    assert.deepEqual(readdirSync(ghConfigDir), []);
    assert.match(envText, /^GIT_CONFIG_GLOBAL=\/dev\/null$/m);
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    const allowedToolsIdx = args.trim().split("\n").indexOf("--allowedTools");
    const allowedTools = args.trim().split("\n")[allowedToolsIdx + 1]!;
    assert.doesNotMatch(allowedTools, /Bash\(gh \*\)/);
    assert.match(allowedTools, /Bash\(git \*\)/);
    writeFileSync(release, "");
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    for (let i = 0; i < 400 && existsSync(ghConfigDir); i++) await sleep(20);
    assert.ok(!existsSync(ghConfigDir), "GH_CONFIG_DIR scratch directory is cleaned up once the lane exits");
    s.dispose();
  } finally {
    if (previousGhToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = previousGhToken;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: a mint failure records a durable 'proxy-mint-failed' event (WorkerDeps.state) — both the non-fatal and the fail-closed branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  const state = new State(":memory:");
  try {
    const hook = mkHook(dir);
    const ready = join(dir, "stub-ready");
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  ${RESULT_LINE}`,
        "fi",
        "trap 'exit 0' TERM",
        `touch "${ready}"`,
        "for _ in $(seq 1 600); do sleep 1; done",
        "",
      ].join("\n"),
    );
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
      state,
    });
    const { name: name1 } = await s.dispatch({ number: 1, title: "t", labels: [] }, "lane-resume-mintfail-1");
    await waitForFile(ready, "first stub installed its TERM trap before handoff");
    s.requestHandoff(name1);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name1}.handoff.json`)); i++) await sleep(20);
    await s.resume({ number: 1, title: "t", labels: [] }, name1, {
      proxy: {
        mint: async () => {
          throw new Error("mint failed #1");
        },
      },
    });

    rmSync(ready, { force: true });
    const { name: name2 } = await s.dispatch({ number: 2, title: "t", labels: [] }, "lane-resume-mintfail-2");
    await waitForFile(ready, "second stub installed its TERM trap before handoff");
    s.requestHandoff(name2);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name2}.handoff.json`)); i++) await sleep(20);
    await assert.rejects(() =>
      s.resume({ number: 2, title: "t", labels: [] }, name2, {
        proxy: {
          mint: async () => {
            throw new Error("mint failed #2");
          },
          credentialFree: true,
        },
      }),
    );

    const events = state.eventsSince("1970-01-01T00:00:00Z", ["proxy-mint-failed"]);
    assert.equal(events.length, 2);
    for (const e of events) {
      const payload = e.payload as { role: string; reason: string };
      assert.equal(payload.role, "worker");
      assert.ok(payload.reason.includes("mint failed"));
    }
    s.dispose();
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #245 round-2 fix (Codex sol-high review, PR #263): A1 — resume() must support FIX-LEG ENTRY
// (starting a fix leg from a `driving` lane, which has a `.done`/`.failed` sentinel but NO
// `.handoff` sentinel — the ordinary #172 handoff-resume precondition). The real WorkerSupervisor
// used to throw "no .handoff sentinel — nothing to resume" here, which every prior test missed
// because they all used a FakeSupervisor. This section is a REAL WorkerSupervisor integration.
// ─────────────────────────────────────────────────────────────────────────────

test("resume: FIX-LEG ENTRY (opts.sessionId, no .handoff sentinel) — real WorkerSupervisor integration: dispatch -> done (driving precondition) -> resume -> a second leg reusing the SAME session (A1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        `  printf '%s\\n' "$@" > "${join(dir, "fix-args.seen.tmp")}"`,
        `  mv "${join(dir, "fix-args.seen.tmp")}" "${join(dir, "fix-args.seen")}"`,
        RESULT_LINE,
        "fi",
        `echo '{"type":"result","subtype":"success","total_cost_usd":0.001,"model":"claude-stub","usage":{"input_tokens":1,"output_tokens":1}}'`,
        "exit 0",
      ].join("\n"),
    );
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => true,
      renderPrompt: () => "issue-rendered-prompt",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    // Fresh dispatch completes DONE quickly (the fake stub exits 0 immediately when NOT
    // --resume) — exactly the `driving`-lane precondition a fix leg starts from: a done
    // sentinel, no handoff sentinel.
    const { name, sessionId } = await s.dispatch({ number: 20, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)));
    assert.ok(
      !existsSync(join(dir, `${name}.handoff.json`)),
      "no handoff sentinel — this is exactly the driving-lane precondition a fix leg starts from",
    );

    // The real bug A1 fixes: resume() used to unconditionally require .handoff and throw here.
    const resumed = await s.resume({ number: 20, title: "t", labels: [] }, name, {
      sessionId,
      prompt: "fix-leg: address PR #77's review findings",
    });
    assert.equal(resumed.name, name);
    assert.equal(resumed.sessionId, sessionId, "SAME session — a fix leg continues the original conversation, never --fork-session");

    await waitForFile(join(dir, "fix-args.seen"), "fix-leg argv was not published");
    const args = readFileSync(join(dir, "fix-args.seen"), "utf8").trim().split("\n");
    const promptIdx = args.indexOf("-p");
    assert.equal(args[promptIdx + 1], "fix-leg: address PR #77's review findings");
    const resumeIdx = args.indexOf("--resume");
    assert.equal(args[resumeIdx + 1], sessionId, "claude --resume reuses the ORIGINAL session id");

    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    const probe = await s.probe(name);
    assert.equal(probe.done, true, "the fix leg reaches its own fresh terminal sentinel");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fix-leg entry fails closed with NO terminal sentinel at all (never starts a fix leg with no prior-leg evidence)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    await assert.rejects(
      () => s.resume({ number: 1, title: "t", labels: [] }, "lane-never-existed", { sessionId: "sess-x", prompt: "fix it" }),
      /no done\/failed terminal sentinel/i,
    );
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fix-leg entry fails closed when opts.sessionId is set but opts.prompt is missing (caller bug, not a runtime condition)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    await assert.rejects(
      () => s.resume({ number: 1, title: "t", labels: [] }, "lane-x", { sessionId: "sess-x" }),
      /opts\.sessionId .* requires opts\.prompt/i,
    );
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #245 round-2 fix (A4): a failure AFTER a successful mint (here: the durable intent-write,
// writeJsonAtomic(runningPath, ...)) must still tear down the minted proxy and remove any
// GH_CONFIG_DIR already created — not just a credentialFree mint-failure's own throw.
test("resume: a failure AFTER a successful mint (intent-write failure) tears down the minted proxy and removes any created GH_CONFIG_DIR (A4)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const { s, name } = await mkHandoffLane(dir, `  ${RESULT_LINE}`);
    const runningPath = join(dir, `${name}.running.json`);
    // Force writeJsonAtomic's internal rename to fail deterministically: pre-create the EXACT
    // tmp path it will try to write to as a DIRECTORY (EISDIR on writeFileSync) — no reliance
    // on filesystem permission bits, which root/CI environments can bypass.
    mkdirSync(`${runningPath}.tmp.${process.pid}`, { recursive: true });
    const { calls, handle } = fakeWorkerProxyHandle();
    await assert.rejects(() =>
      s.resume({ number: 9, title: "t", labels: [] }, name, {
        proxy: {
          mint: async () => {
            calls.minted++;
            return handle as never;
          },
          credentialFree: true,
        },
      }),
    );
    assert.equal(calls.minted, 1, "mint succeeded before the intent-write failed");
    assert.equal(calls.stopped, 1, "A4: the minted proxy must be torn down even though the failure happened AFTER mint, not at mint time");
    const ghConfigDir = join(dir, `${name}.gh-config-empty`);
    assert.ok(!existsSync(ghConfigDir), "A4: the GH_CONFIG_DIR scratch directory created before the intent-write failure must be removed");
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// #245 round-2 fix ROUND 2 (Codex sol-high delta re-review): B1 — fix-leg entry required a
// `.done`/`.failed` sentinel to EXIST but never consumed it, so once the fix leg was live
// (lane spawned, spawn confirmed), FIXING RECLAIM's probe() kept reading the STALE prior-leg
// sentinel as if it were the new leg's own terminal signal.
// ─────────────────────────────────────────────────────────────────────────────

test("resume: FIX-LEG ENTRY consumes the stale prior-leg terminal sentinel on spawn confirmation — a live fix child is never mistaken for already-terminal (B1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(
      dir,
      [
        "#!/usr/bin/env bash",
        'if [[ "$*" == *"--resume"* ]]; then',
        "  trap 'exit 0' TERM",
        "  for _ in $(seq 1 600); do sleep 1; done",
        "fi",
        RESULT_LINE,
      ].join("\n"),
    );
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => true,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name, sessionId } = await s.dispatch({ number: 30, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)), "sanity: the stale sentinel exists before the fix leg even starts");

    await s.resume({ number: 30, title: "t", labels: [] }, name, { sessionId, prompt: "fix it" });

    assert.ok(!existsSync(join(dir, `${name}.done.json`)), "B1: the stale sentinel is consumed once THIS leg's spawn is confirmed durable");
    const probe = await s.probe(name);
    assert.equal(probe.done, false, "a live, still-sleeping fix child must never be reported done via a stale sentinel");
    await s.reclaim(name);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fix-leg entry does NOT remove the stale terminal sentinel when the spawn attempt itself fails — the next retry's entry check must still pass (B1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const hook = mkHook(dir);
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: bin,
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      heartbeatMs: 50,
      guardHookPath: hook,
    });
    const { name, sessionId } = await s.dispatch({ number: 31, title: "t", labels: [] });
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.done.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.done.json`)));

    const s2 = new WorkerSupervisor({
      cfg,
      stateDir: dir,
      claudeBin: join(dir, "does-not-exist-claude"),
      hasOpenPr: async () => false,
      renderPrompt: () => "p",
      guardHookPath: hook,
    });
    await assert.rejects(
      () => s2.resume({ number: 31, title: "t", labels: [] }, name, { sessionId, prompt: "fix it" }),
      /resume-spawn failed/i,
    );
    assert.ok(
      existsSync(join(dir, `${name}.done.json`)),
      "the stale sentinel must survive a FAILED spawn attempt — the next retry's entry check needs it",
    );
    s.dispose();
    s2.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
