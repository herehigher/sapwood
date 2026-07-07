import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { parseCostUsd, parseModelUsage, discoverClaudeBin, claudeArgs, guardSettings, shellSingleQuote, WorkerSupervisor } from "./worker.js";
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

const sup = (dir: string, claudeBin: string, hasPr = false) =>
  new WorkerSupervisor({
    cfg,
    stateDir: dir,
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

test("requestHandoff but the worker dies by signal (no clean wrap-up) -> .failed, not a false handoff (Codex R3 P2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-worker-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nsleep 30\n`); // no TERM trap -> SIGTERM kills it (code null)
    const s = sup(dir, bin);
    const { name } = await s.dispatch({ number: 9, title: "t", labels: [] });
    await sleep(200);
    s.requestHandoff(name);
    for (let i = 0; i < 400 && !existsSync(join(dir, `${name}.failed.json`)); i++) await sleep(20);
    assert.ok(existsSync(join(dir, `${name}.failed.json`)), "aborted (signal-killed) drain is .failed");
    assert.ok(!existsSync(join(dir, `${name}.handoff.json`)), "NOT a false resumable handoff");
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

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
