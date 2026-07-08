import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync, lstatSync, chmodSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import {
  parseCostUsd, parseModelUsage, discoverClaudeBin, claudeArgs, guardSettings, shellSingleQuote,
  WorkerSupervisor, renderPromptTemplate, defaultPromptPath, loadWorkerPromptTemplate, buildRenderPrompt,
} from "./worker.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

const cfg: SapwoodConfig = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });

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

// ── #47: per-model token usage capture (parseModelUsage) ──
test("parseModelUsage: full modelUsage map capture (newer CLI)", () => {
  const jsonl = [
    `{"type":"system","subtype":"init"}`,
    JSON.stringify({
      type: "result", subtype: "success", total_cost_usd: 0.5,
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
    type: "result", subtype: "success", total_cost_usd: 0.1, model: "claude-sonnet-4-6",
    usage: { input_tokens: 40, output_tokens: 60, cache_creation_input_tokens: 5, cache_read_input_tokens: 15 },
  });
  assert.deepEqual(parseModelUsage(jsonl), [
    { model: "claude-sonnet-4-6", inputTokens: 40, outputTokens: 60, cacheReadTokens: 15, cacheCreationTokens: 5 },
  ]);
});

test("parseModelUsage: modelUsage absent + no model field -> falls back to modelName, else 'unknown'", () => {
  const withModelName = JSON.stringify({
    type: "result", total_cost_usd: 0.1, modelName: "claude-haiku-4-6",
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
    type: "result", total_cost_usd: 0.4,
    usage: { input_tokens: -5, output_tokens: "oops", cache_read_input_tokens: null },
  });
  assert.deepEqual(parseModelUsage(badFields), [
    { model: "unknown", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);

  // no result line at all / garbage-only stream -> empty, no throw.
  assert.deepEqual(parseModelUsage("no json here\n{\"type\":\"assistant\"}"), []);
  assert.deepEqual(parseModelUsage(""), []);
  assert.deepEqual(parseModelUsage("garbage{{{"), []);
});

test("parseModelUsage: multiple result lines -> last one wins (same as parseCostUsd)", () => {
  const jsonl = [
    JSON.stringify({ type: "result", total_cost_usd: 0.1, model: "m1", usage: { input_tokens: 1 } }),
    JSON.stringify({ type: "result", total_cost_usd: 0.2, model: "m2", usage: { input_tokens: 2 } }),
  ].join("\n");
  assert.deepEqual(parseModelUsage(jsonl), [
    { model: "m2", inputTokens: 2, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 },
  ]);
});

test("discoverClaudeBin: env CLAUDE_BIN wins, else 'claude'", () => {
  assert.equal(discoverClaudeBin({ CLAUDE_BIN: "/opt/claude" }), "/opt/claude");
  assert.equal(discoverClaudeBin({}), "claude");
  assert.equal(discoverClaudeBin({ CLAUDE_BIN: "" }), "claude"); // empty -> default
});

test("claudeArgs: headless flags, stream-json, worktree/session; no --max-budget-usd (soft budget is monitored, not a hard cut)", () => {
  const args = claudeArgs({
    prompt: "do the thing", model: "opus", effort: "high",
    worktree: "lane-1", name: "lane-1", sessionId: "uuid-1", addDir: "/repo/data",
  });
  assert.ok(args.includes("-p") && args.includes("do the thing"));
  assert.deepEqual(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2), ["--model", "opus"]);
  assert.ok(args.includes("--worktree") && args.includes("lane-1"));
  assert.ok(args.includes("--session-id") && args.includes("uuid-1"));
  assert.ok(args.includes("--output-format") && args.includes("stream-json"));
  assert.ok(args.includes("--add-dir") && args.includes("/repo/data"));
  assert.ok(!args.includes("--max-budget-usd")); // soft budget: monitored + graceful handoff, never a hard kill
});

test("claudeArgs: resumeSessionId (#46) uses --resume instead of --session-id, reusing the id", () => {
  const args = claudeArgs({
    prompt: "p", model: "m", effort: "high", worktree: "w", name: "w",
    sessionId: "sess-1", resumeSessionId: "sess-1",
  });
  assert.deepEqual(args.slice(args.indexOf("--resume"), args.indexOf("--resume") + 2), ["--resume", "sess-1"]);
  assert.ok(!args.includes("--session-id"));
});

test("claudeArgs: --settings only when given (guard hook wiring lands in #26)", () => {
  assert.ok(!claudeArgs({ prompt: "p", model: "m", effort: "high", worktree: "w", name: "w", sessionId: "s" }).includes("--settings"));
  const withSettings = claudeArgs({ prompt: "p", model: "m", effort: "high", worktree: "w", name: "w", sessionId: "s", settings: "/tmp/guard.json" });
  assert.deepEqual(withSettings.slice(withSettings.indexOf("--settings"), withSettings.indexOf("--settings") + 2), ["--settings", "/tmp/guard.json"]);
});

// ── Integration: stub `claude` (zero token) drives the real spawn/sentinel/probe path ──
const mkStub = (dir: string, body: string): string => {
  const p = join(dir, "claude-stub");
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};
const FAST_STUB = `#!/usr/bin/env bash\necho '{"type":"result","subtype":"success","total_cost_usd":0.0001,"model":"claude-stub","usage":{"input_tokens":12,"output_tokens":34}}'\nexit 0\n`;

// A present (dummy) guard hook so hard-mode dispatch doesn't fail closed; the stub `claude`
// ignores --settings, so its contents don't matter here (the hook mode is unit-tested separately).
const mkHook = (dir: string): string => {
  const p = join(dir, "guard-hook.js");
  writeFileSync(p, "process.exit(0)\n");
  return p;
};

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
      cfg, stateDir: dir, claudeBin: bin,
      hasOpenPr: async () => { throw new Error("legacy path must not be used when findOpenPr is provided"); },
      findOpenPr: async (issue) => (issue === 8 ? 42 : null),
      renderPrompt: () => "test prompt", heartbeatMs: 50, guardHookPath: mkHook(dir),
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
      cfg, stateDir: dir, claudeBin: bin,
      hasOpenPr: async () => { throw new Error("legacy path must not be used when findOpenPr is provided"); },
      findOpenPr: async () => null,
      renderPrompt: () => "test prompt", heartbeatMs: 50, guardHookPath: mkHook(dir),
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 4, title: "t", labels: [] });
    await sleep(100);
    const probe = await s.probe(name);
    assert.equal(probe.done, false);
    assert.equal(probe.costUsd, 0);
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
    // Stubborn stub: ignore TERM, sleep long -> only a process-group KILL stops it.
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap '' TERM\nsleep 60\n`);
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 2, title: "t", labels: [] });
    await sleep(100); // let it start
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap 'exit 0' TERM\nsleep 30\n`);
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 3, title: "t", labels: [] });
    await sleep(600); // let bash install its TERM trap before we drain (else it dies by default)
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap 'exit 0' TERM\nsleep 30\n`);
    const s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 8, title: "t", labels: [] });
    await sleep(600); // let bash install its TERM trap
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`); // no TERM trap -> SIGTERM kills it (code null)
    const s = sup(dir, bin); // no worktreeRoot override -> the lane's worktree path never exists
    const { name } = await s.dispatch({ number: 9, title: "t", labels: [] });
    await sleep(200);
    s.requestHandoff(name);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.handoff.json`)), "handoff-requested + signal-killed is .handoff, not .failed");
    assert.ok(!existsSync(join(dir, `${name}.failed.json`)));
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #46: resume() — --resume after a .handoff ────────────────────────────────────────────────

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

test("resume: --resume reuses the ORIGINAL session id, clears .handoff, and the resumed run's terminal cost is probed normally", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
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
        "sleep 30",
        "",
      ].join("\n"),
    );
    const s = sup(dir, bin);
    const { name, sessionId } = await s.dispatch({ number: 3, title: "t", labels: [] });
    await sleep(600); // let bash install its TERM trap before draining
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
    // probe() surfaces the resumed run's raw reported cost as-is (0.05) — the double-count
    // PROTECTION lives one level up, in State.recordSpend (see state.test.ts), not here.
    assert.equal(probe.costUsd, 0.05);
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resume: fails closed in hard mode when the guard hook is missing (no unguarded resume)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap 'exit 0' TERM\nsleep 30\n`);
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 3, title: "t", labels: [] });
    await sleep(600);
    s.requestHandoff(name);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.handoff.json`)); i++) await sleep(20);
    // A supervisor whose guard hook path doesn't exist, same as dispatch()'s hard-mode guard.
    const s2 = new WorkerSupervisor({ cfg, stateDir: dir, claudeBin: bin, hasOpenPr: async () => false, guardHookPath: join(dir, "nonexistent-hook.js") });
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
  const cmd = (guardSettings("/nonexistent/sapwood-guard-hook.js") as {
    hooks: { PreToolUse: Array<{ hooks: Array<{ command: string }> }> };
  }).hooks.PreToolUse[0]!.hooks[0]!.command;
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
  try {
    const hook = mkHook(dir);
    // stub records its argv + the guard mode env, proving the inline settings + env reach the process.
    const bin = mkStub(dir, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho "$SAPWOOD_GUARD_MODE" > "${join(dir, "mode.seen")}"\nexit 0\n`);
    const scfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, guard: { mode: "soft" } });
    const s = new WorkerSupervisor({ cfg: scfg, stateDir: dir, claudeBin: bin, hasOpenPr: async () => false, renderPrompt: () => "p", heartbeatMs: 50, guardHookPath: hook });
    const { name } = await s.dispatch({ number: 7, title: "t", labels: [] });
    assert.ok(!existsSync(join(dir, `${name}.settings.json`)), "no mutable settings file written");
    // mode.seen is the stub's LAST write — waiting on it guarantees args.seen exists too
    // (waiting on args.seen could race the second write on a slow FS). (Codex #26 R6 P3.)
    for (let i = 0; i < 400 && !existsSync(join(dir, "mode.seen")); i++) await sleep(20);
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    assert.match(args, /--settings/);
    assert.match(args, /guard-hook\.js/); // the inline JSON carries the hook command
    assert.match(args, /disableAllHooks/);
    assert.equal(readFileSync(join(dir, "mode.seen"), "utf8").trim(), "soft"); // env reached the worker
    s.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dispatch fails closed in hard mode when the guard hook is missing (no unguarded worker)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = new WorkerSupervisor({ cfg, stateDir: dir, claudeBin: bin, hasOpenPr: async () => false, renderPrompt: () => "p", guardHookPath: join(dir, "nonexistent-hook.js") });
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap '' TERM\nsleep 30\n`); // ignores TERM -> needs the KILL
    const tcfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { timeoutSec: 1 } });
    const s = new WorkerSupervisor({ cfg: tcfg, stateDir: dir, claudeBin: bin, hasOpenPr: async () => false, renderPrompt: () => "p", heartbeatMs: 100, guardHookPath: mkHook(dir) });
    const { name } = await s.dispatch({ number: 5, title: "t", labels: [] });
    const pid = JSON.parse(readFileSync(join(dir, `${name}.running.json`), "utf8")).wrapper_pid as number;
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.failed.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.failed.json`)), "timed-out worker marked failed");
    for (let i = 0; i < 400 && alive(pid); i++) await sleep(20);
    assert.equal(alive(pid), false, "timed-out worker process killed");
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
    const s = sup(dir, bin, false, worktreeRoot);
    const { name: laneName, sessionId } = await s.dispatch({ number: 69, title: "t", labels: [] }, name);
    await sleep(200);
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

test("#69 grep-invariant (engine-wide, fable P3): the ONLY child_process importers are worker.ts (spawn) and gh.ts (execFile), and no subprocess call site passes a cwd — the engine structurally CANNOT exec git in a worker worktree", () => {
  const srcDir = new URL(".", import.meta.url);
  const files = readdirSync(srcDir).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  // Sanity: the two known subprocess modules are present in the scan set.
  assert.ok(files.includes("worker.ts") && files.includes("gh.ts"));
  for (const f of files) {
    const src = readFileSync(new URL(f, srcDir), "utf8");
    const importsChildProcess = /from "node:child_process"/.test(src);
    if (f === "worker.ts") {
      // spawn ONLY (the claude CLI launch); every exec-style API (what #62's preserveHandoffWip
      // used) is banned — this pins the deletion.
      assert.match(src, /import \{ spawn, type ChildProcess \} from "node:child_process"/, "worker.ts imports spawn only");
      assert.doesNotMatch(src, /\b(execFileSync|execFile|execSync|spawnSync|exec)\b/, "worker.ts has no exec API");
      assert.doesNotMatch(src, /["'`]git["'`]/, "worker.ts references no `git` command");
      assert.doesNotMatch(src, /preserveHandoffWip|runGit|tryGit|noHooksDir/, "deleted helpers not stranded");
      assert.doesNotMatch(src, /\bcwd:/, "worker.ts passes no cwd to any subprocess");
    } else if (f === "gh.ts") {
      // execFile ONLY, no spawn/sync variants, and gh runs in the engine's own cwd (no cwd option).
      assert.doesNotMatch(src, /\b(execFileSync|execSync|spawnSync|spawn)\b/, "gh.ts uses execFile only");
      assert.doesNotMatch(src, /\bcwd:/, "gh.ts passes no cwd to execFile");
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap '' TERM\nsleep 30\n`);
    const tcfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, worker: { timeoutSec: 1 } });
    const s = new WorkerSupervisor({
      cfg: tcfg, stateDir: dir, claudeBin: bin,
      hasOpenPr: async () => false, renderPrompt: () => "p", heartbeatMs: 100, guardHookPath: mkHook(dir),
    });
    const { name: laneName } = await s.dispatch({ number: 63, title: "t", labels: [] });
    await sleep(200);
    assert.equal(s.requestHandoff(laneName), true); // sets handoffRequested; the stub ignores this TERM
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

    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
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

    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
    const s = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 71, title: "t", labels: [] }, name);
    await sleep(100);

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
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
    const s = sup(dir, bin); // default worktreeRoot -> the lane's worktree path never exists
    const { name } = await s.dispatch({ number: 72, title: "t", labels: [] });
    await sleep(100);
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

    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
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
        "sleep 30",
        "",
      ].join("\n"),
    );
    const s = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s.dispatch({ number: 74, title: "t", labels: [] }, name);
    await sleep(50);
    // Pre-handoff WIP: written DURING the first run, mtime after first dispatch.
    writeFileSync(join(worktreePath, "wip.txt"), "pre-handoff uncommitted work\n");
    await sleep(600); // let the TERM trap install
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

    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
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

    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`);
    const s1 = sup(dir, bin, false, worktreeRoot);
    const { name: laneName, sessionId } = await s1.dispatch({ number: 63, title: "t", labels: [] }, name);
    await sleep(200);
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`); // no trap -> dies on SIGTERM
    const s1 = sup(dir, bin);
    const { name: laneName } = await s1.dispatch({ number: 64, title: "t", labels: [] });
    await sleep(200);
    const pid = JSON.parse(readFileSync(join(dir, `${laneName}.running.json`), "utf8")).wrapper_pid as number;
    s1.dispose(); // restart #1: engine forgets the in-process lane

    const sMid = sup(dir, bin);
    assert.equal(sMid.requestHandoff(laneName), true); // detached SIGTERM sent + persisted
    // Simulate restart #2 landing before anyone ever calls probe() on sMid (i.e. before death
    // is confirmed): a brand-new instance whose in-memory detachedHandoffRequested is empty.
    const s2 = sup(dir, bin);

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

test("#63: wrapperAlive() === -1 (unreadable pid) -> probe() does not throw, does not finalize, lane stays as-is", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const s = sup(dir, bin);
    // A persisted lane that claims a handoff was requested but carries no readable wrapper_pid
    // (garbage/missing) -> persistedPid() is null -> wrapperAlive() is -1 (unknown), not 0.
    writeFileSync(
      join(dir, "lane-63-c.running.json"),
      JSON.stringify({ issue: 1, session_id: "s", handoff_requested: true }),
    );
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap '' TERM\nsleep 30\n`);
    const s1 = sup(dir, bin, false, worktreeRoot);
    const { name: laneName } = await s1.dispatch({ number: 65, title: "t", labels: [] }, name);
    await sleep(200);
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap 'exit 0' TERM\nsleep 30\n`);
    const s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 66, title: "t", labels: [] });
    await sleep(600); // let bash install its TERM trap
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
    const bin = mkStub(dir, `#!/usr/bin/env bash\ntrap 'exit 0' TERM\nsleep 30\n`);
    const s1 = sup(dir, bin);
    const { name } = await s1.dispatch({ number: 67, title: "t", labels: [] });
    await sleep(600); // let bash install its TERM trap
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
  assert.match(rendered, /labelled `verify:n\/a`/);
  assert.doesNotMatch(rendered, /\{\{/);
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
    writeFileSync(templatePath, "Do issue #{{issue.number}} (\"{{issue.title}}\"):\n{{issue.body}}");
    const scfg = ConfigSchema.parse({
      board: { owner: "o", repo: "r", projectNumber: 4 },
      worker: { promptFile: templatePath },
    });
    const renderPrompt = buildRenderPrompt(scfg);
    const hook = mkHook(dir);
    // stub records its argv so we can inspect exactly what -p carried (same trick as the
    // #26 inline-settings test above).
    const bin = mkStub(dir, `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\nexit 0\n`);
    const s = new WorkerSupervisor({ cfg: scfg, stateDir: dir, claudeBin: bin, hasOpenPr: async () => false, renderPrompt, heartbeatMs: 50, guardHookPath: hook });
    await s.dispatch({ number: 74, title: "File-based worker prompt", labels: [], body: "wire promptFile through renderPrompt" });
    for (let i = 0; i < 400 && !existsSync(join(dir, "args.seen")); i++) await sleep(20);
    const args = readFileSync(join(dir, "args.seen"), "utf8");
    const expected = renderPromptTemplate(readFileSync(templatePath, "utf8"), {
      number: 74, title: "File-based worker prompt", labels: [], body: "wire promptFile through renderPrompt",
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
