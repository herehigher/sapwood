// codex-exec.test.ts (#443) — the cross-vendor gate② session runner, against a FAKE spawn and a
// FIXTURE codex home. No real `codex` process is ever started here (the live shadow run is a
// separate, post-merge step, mirroring #313's method) and NOTHING in this file depends on a real
// timer, a subprocess's speed, or the scheduler: the timeout seam is injected and fired explicitly
// (docs/REVIEW-DOCTRINE.md, "No timing-dependent assertions").
//
// What is pinned here:
//   - the containment profile IS the argv (a value assertion, not prose);
//   - the prompt reaches the CLI on stdin from a FILE — never argv, never a shell;
//   - credentials are stripped from the session env, provider transport is not;
//   - R1: advisory-budget warning, estimated spend, cost-unknown alert (never `$0`);
//   - R2: the containment blind-spot warning fires at every spawn;
//   - D5: identity comes from the session's OWN transcript, and is EMPTY when unidentifiable.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCodexExecArgs,
  CONTAINMENT_GAP_EXECUTION_UNDER_READ_ONLY,
  CodexExecReviewSessionExecutor,
  codexHomeDir,
  codexSessionEnv,
  discoverCodexBin,
  ENGINE_REVIEW_BUDGET_ADVISORY,
  ENGINE_REVIEW_CONTAINMENT_GAP,
  ENGINE_REVIEW_COST_UNKNOWN,
  estimateCodexCostUsd,
  findCodexRollout,
  parseCodexExecStream,
  parseCodexRolloutIdentity,
} from "./codex-exec.js";
import type { ReviewSessionRequest } from "./review-session.js";

const PRICING = { inputUsdPerMTok: 2, outputUsdPerMTok: 10 };

/** A minimal ChildProcess stand-in: stdout/stderr emitters, a recorded `kill`, and a `finish()` the
 *  test calls when IT decides the session ended — never a real process, never a real clock. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed: string[] = [];
  kill(signal: string): boolean {
    this.killed.push(signal);
    return true;
  }
  emitStdout(text: string): void {
    this.stdout.emit("data", text);
  }
  finish(code: number | null): void {
    this.emit("close", code);
  }
}

interface Harness {
  dir: string;
  events: Array<{ kind: string; payload: Record<string, unknown> }>;
  spawnCalls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }>;
  child: FakeChild;
  /** Fire the wall-clock timeout the executor scheduled (index 0 = the session bound). */
  fireTimer(index: number): void;
  timerMs: number[];
  executor: CodexExecReviewSessionExecutor;
  req: ReviewSessionRequest;
  cleanup: () => void;
}

/** `stream` is what the fake CLI prints on stdout; `lastMessage`, when set, is written to whatever
 *  path the executor passed to `-o` (i.e. the file channel the final response really travels on). */
function harness(opts: { stream?: string; lastMessage?: string; env?: NodeJS.ProcessEnv; rollout?: string } = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-codex-exec-"));
  const treeDir = join(dir, "tree");
  mkdirSync(treeDir, { recursive: true });
  const codexHome = join(dir, "codex-home");
  const events: Harness["events"] = [];
  const spawnCalls: Harness["spawnCalls"] = [];
  const timers: Array<{ ms: number; fire: () => void }> = [];
  const child = new FakeChild();

  if (opts.rollout !== undefined) {
    const day = join(codexHome, "sessions", "2026", "08", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-08-01T14-00-00-thread-xyz.jsonl"), opts.rollout, "utf8");
  }

  const executor = new CodexExecReviewSessionExecutor({
    stateDir: join(dir, "state"),
    timeoutSec: 600,
    pricing: PRICING,
    codexBin: "/fake/codex",
    env: { PATH: "/usr/bin", CODEX_HOME: codexHome, GH_TOKEN: "secret", GITHUB_TOKEN: "secret", ...opts.env },
    log: () => {},
    appendEvent: (kind, payload) => events.push({ kind, payload: payload as Record<string, unknown> }),
    newSessionId: () => "fixed",
    startTimer: (ms, fire) => {
      const drop = (): void => {
        const i = timers.indexOf(entry);
        if (i >= 0) timers.splice(i, 1);
      };
      // A fired timer leaves the queue, exactly like a real one-shot `setTimeout` — so index 0 is
      // always "the next timer that could fire", never a spent one.
      const entry = {
        ms,
        fire: () => {
          drop();
          fire();
        },
      };
      timers.push(entry);
      return drop;
    },
    spawnFn: ((bin: string, args: string[], o: Record<string, unknown>) => {
      spawnCalls.push({ bin, args, opts: o });
      // The CLI writes its final message to the `-o` path; do that here, before the close event,
      // exactly like the real one does.
      if (opts.lastMessage !== undefined) {
        const oIndex = args.indexOf("-o");
        writeFileSync(args[oIndex + 1]!, opts.lastMessage, "utf8");
      }
      queueMicrotask(() => {
        if (opts.stream !== undefined) child.emitStdout(opts.stream);
      });
      return child;
      // biome-ignore lint/suspicious/noExplicitAny: see above
    }) as any,
  });

  return {
    dir,
    events,
    spawnCalls,
    child,
    timerMs: [],
    fireTimer: (index: number) => timers[index]?.fire(),
    executor,
    req: { treeDir, roleId: "engine-reviewer", prompt: "review this diff", model: "gpt-5.4-codex", effort: "high", budgetUsd: 3 },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** Runs the executor and lets the fake child close cleanly with `code`. */
async function run(h: Harness, code: number | null = 0): Promise<Awaited<ReturnType<CodexExecReviewSessionExecutor["execute"]>>> {
  const p = h.executor.execute(h.req);
  // Two microtask hops: one for the stdout emit queued at spawn, one for the listeners to attach.
  await Promise.resolve();
  await Promise.resolve();
  h.child.finish(code);
  return p;
}

const ROLLOUT_OK =
  `{"type":"session_meta","payload":{"id":"thread-xyz","model_provider":"openai"}}\n` +
  `{"type":"turn_context","payload":{"model":"gpt-5.4-codex","sandbox_policy":{"type":"read-only"}}}\n`;

const STREAM_OK =
  `Reading prompt from stdin...\n` +
  `{"type":"thread.started","thread_id":"thread-xyz"}\n` +
  `{"type":"turn.completed","usage":{"input_tokens":1000000,"cached_input_tokens":0,"output_tokens":100000}}\n`;

// ── pure parsers ─────────────────────────────────────────────────────────────────────────────

test("parseCodexExecStream: picks the thread id and sums turn.completed usage; a non-JSON banner line and unknown events are skipped, never fatal", () => {
  const t = parseCodexExecStream(
    `Reading prompt from stdin...\n` +
      `{"type":"thread.started","thread_id":"t1"}\n` +
      `{"type":"item.completed","item":{"type":"agent_message"}}\n` +
      `{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":2}}\n` +
      `{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}\n` +
      `{ truncated tail`,
  );
  assert.deepEqual(t, { threadId: "t1", usage: { inputTokens: 15, outputTokens: 3 } });
});

test("parseCodexExecStream: a stream with no usage at all reports usage null — NOT zero (R1: missing telemetry is never read as free)", () => {
  const t = parseCodexExecStream(`{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.failed","error":{"message":"boom"}}\n`);
  assert.equal(t.threadId, "t1");
  assert.equal(t.usage, null);
});

test("parseCodexRolloutIdentity: provider + model from the session's own transcript; a HALF-known identity is no identity (D5 fail-closed)", () => {
  assert.deepEqual(parseCodexRolloutIdentity(ROLLOUT_OK), { provider: "openai", model: "gpt-5.4-codex" });
  assert.equal(parseCodexRolloutIdentity(`{"type":"session_meta","payload":{"model_provider":"openai"}}\n`), null, "model missing");
  assert.equal(parseCodexRolloutIdentity(`{"type":"turn_context","payload":{"model":"m"}}\n`), null, "provider missing");
  assert.equal(parseCodexRolloutIdentity("not json at all"), null);
});

test("parseCodexRolloutIdentity: the LAST turn_context wins — a mid-session model change is reported as the model that produced the final message", () => {
  const identity = parseCodexRolloutIdentity(
    `{"type":"session_meta","payload":{"model_provider":"openai"}}\n` +
      `{"type":"turn_context","payload":{"model":"first"}}\n` +
      `{"type":"turn_context","payload":{"model":"second"}}\n`,
  );
  assert.deepEqual(identity, { provider: "openai", model: "second" });
});

test("estimateCodexCostUsd: pinned-price arithmetic over input+output tokens", () => {
  assert.equal(estimateCodexCostUsd({ inputTokens: 1_000_000, outputTokens: 100_000 }, PRICING), 2 + 1);
});

test("discoverCodexBin / codexHomeDir: env overrides win, else the documented defaults", () => {
  assert.equal(discoverCodexBin({ CODEX_BIN: "/opt/codex" }), "/opt/codex");
  assert.equal(discoverCodexBin({}), "codex");
  assert.equal(codexHomeDir({ CODEX_HOME: "/x/.codex" }), "/x/.codex");
  assert.match(codexHomeDir({}), /\.codex$/);
});

test("codexSessionEnv: forge/git credentials are stripped, provider transport is NOT (a review that cannot reach its provider is broken, not contained)", () => {
  const env = codexSessionEnv({
    PATH: "/usr/bin",
    GH_TOKEN: "x",
    GH_CONFIG_DIR: "/home/u/.config/gh",
    GITHUB_TOKEN: "x",
    GITHUB_ENTERPRISE_TOKEN: "x",
    GIT_ASKPASS: "/bin/echo",
    GIT_CONFIG_GLOBAL: "/tmp/gitconfig",
    CODEX_HOME: "/home/u/.codex",
    OPENAI_API_KEY: "sk-test",
  });
  assert.deepEqual(Object.keys(env).sort(), ["CODEX_HOME", "OPENAI_API_KEY", "PATH"]);
});

test("findCodexRollout: locates a transcript by thread id anywhere under <codexHome>/sessions; a missing home or unknown id is null, never a throw", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-codex-home-"));
  try {
    const day = join(dir, "sessions", "2026", "08", "01");
    mkdirSync(day, { recursive: true });
    const p = join(day, "rollout-2026-08-01T14-00-00-abc-123.jsonl");
    writeFileSync(p, ROLLOUT_OK, "utf8");
    assert.equal(findCodexRollout(dir, "abc-123"), p);
    assert.equal(findCodexRollout(dir, "nope"), null);
    assert.equal(findCodexRollout(join(dir, "does-not-exist"), "abc-123"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── the containment profile IS the argv ──────────────────────────────────────────────────────

test("buildCodexExecArgs (R2): the pinned containment profile, as a value — read-only sandbox, config-source isolation, no MCP, no web tools, output to a FILE", () => {
  const args = buildCodexExecArgs({ treeDir: "/t/tree", model: "gpt-5.4-codex", effort: "high", lastMessagePath: "/t/last.txt" });
  assert.deepEqual(args, [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--ignore-user-config",
    "--ignore-rules",
    "--sandbox",
    "read-only",
    "-C",
    "/t/tree",
    "-m",
    "gpt-5.4-codex",
    "-c",
    'model_reasoning_effort="high"',
    "-c",
    "mcp_servers={}",
    "-c",
    "tools.web_search=false",
    "-o",
    "/t/last.txt",
  ]);
  // The prompt is NOWHERE in argv — it travels on stdin, from a file (see the spawn test below).
  assert.equal(
    args.some((a) => a.includes("review this diff")),
    false,
  );
});

test("buildCodexExecArgs: a model name that could be read as a FLAG, or an effort outside the closed set, is refused — argv-injection guard, not an escaping fix", () => {
  assert.throws(
    () => buildCodexExecArgs({ treeDir: "/t", model: "--dangerously-bypass-approvals-and-sandbox", effort: "high", lastMessagePath: "/o" }),
    /refusing model name/,
  );
  assert.throws(() => buildCodexExecArgs({ treeDir: "/t", model: "m", effort: "reckless", lastMessagePath: "/o" }), /refusing effort/);
});

// ── execute(): the whole session, against a fake spawn ───────────────────────────────────────

test("execute: spawns the codex CLI with the pinned profile, cwd = the materialized tree, credential-stripped env, and the prompt delivered on stdin FROM A FILE (never argv, never a shell)", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "the review text", rollout: ROLLOUT_OK });
  try {
    await run(h);
    assert.equal(h.spawnCalls.length, 1);
    const call = h.spawnCalls[0]!;
    assert.equal(call.bin, "/fake/codex");
    assert.equal(call.opts.cwd, h.req.treeDir);
    assert.equal((call.opts.env as NodeJS.ProcessEnv).GH_TOKEN, undefined, "forge credentials never reach a review session");
    assert.equal((call.opts.env as NodeJS.ProcessEnv).GITHUB_TOKEN, undefined);
    assert.equal(call.opts.shell, undefined, "no shell — an argv vector has no interpolation surface");
    // stdin is a numeric file descriptor, and the file it points at holds the prompt verbatim.
    const stdio = call.opts.stdio as [number, string, string];
    assert.equal(typeof stdio[0], "number");
    assert.equal(readFileSync(join(h.dir, "state", "engine-reviewer-fixed.prompt.txt"), "utf8"), "review this diff");
  } finally {
    h.cleanup();
  }
});

test("execute (R2): the containment blind-spot warning fires at EVERY spawn — the adjudicated alternative to claiming a read-only sandbox equals the Claude runner's no-Bash profile", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    await run(h);
    const gap = h.events.filter((e) => e.kind === ENGINE_REVIEW_CONTAINMENT_GAP);
    assert.equal(gap.length, 1);
    assert.deepEqual(gap[0]!.payload, {
      runner: "codex-exec",
      session: "engine-reviewer-fixed",
      gap: CONTAINMENT_GAP_EXECUTION_UNDER_READ_ONLY,
    });
  } finally {
    h.cleanup();
  }
});

test("execute (R1): the cost cap is announced as ADVISORY before the session starts, and the post-run spend is a FLAGGED estimate — never presented as a measurement", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    const evidence = await run(h);
    const advisory = h.events.filter((e) => e.kind === ENGINE_REVIEW_BUDGET_ADVISORY);
    assert.equal(advisory.length, 1);
    assert.deepEqual(advisory[0]!.payload, { runner: "codex-exec", session: "engine-reviewer-fixed", capUsd: 3 });
    // 1M input @ $2/M + 100k output @ $10/M = $3.
    assert.deepEqual(evidence.spend, { kind: "estimated", usd: 3 });
    assert.equal(
      h.events.some((e) => e.kind === ENGINE_REVIEW_COST_UNKNOWN),
      false,
    );
  } finally {
    h.cleanup();
  }
});

test("execute (R1): a session with NO token telemetry reports spend UNKNOWN and alerts — the one thing it must never do is report $0", async () => {
  const h = harness({ stream: `{"type":"thread.started","thread_id":"thread-xyz"}\n`, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    const evidence = await run(h);
    assert.deepEqual(evidence.spend, { kind: "unknown" });
    const alerts = h.events.filter((e) => e.kind === ENGINE_REVIEW_COST_UNKNOWN);
    assert.equal(alerts.length, 1);
    assert.equal(alerts[0]!.payload.runner, "codex-exec");
    assert.match(String(alerts[0]!.payload.reason), /token usage/);
  } finally {
    h.cleanup();
  }
});

test("execute (D5): identity comes from the session's OWN transcript — and is EMPTY when the transcript is missing or unidentifiable, which is what maps the attempt to unavailable upstream", async () => {
  const withRollout = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    const evidence = await run(withRollout);
    assert.deepEqual(evidence.identity, [{ provider: "openai", model: "gpt-5.4-codex" }]);
    assert.equal(evidence.sessionId, "thread-xyz");
  } finally {
    withRollout.cleanup();
  }

  const noRollout = harness({ stream: STREAM_OK, lastMessage: "x" });
  try {
    const evidence = await run(noRollout);
    assert.deepEqual(evidence.identity, [], "no transcript ⇒ unidentifiable ⇒ empty, never inferred from config");
  } finally {
    noRollout.cleanup();
  }

  const noThreadId = harness({ stream: `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n`, rollout: ROLLOUT_OK });
  try {
    const evidence = await run(noThreadId);
    assert.deepEqual(evidence.identity, [], "no thread id on stdout ⇒ no transcript to key on ⇒ unidentifiable");
  } finally {
    noThreadId.cleanup();
  }
});

test("execute: the final response is read from the -o FILE, and outcome follows the exit code", async () => {
  const ok = harness({ stream: STREAM_OK, lastMessage: "FINAL TEXT", rollout: ROLLOUT_OK });
  try {
    const evidence = await run(ok, 0);
    assert.equal(evidence.outcome, "done");
    assert.equal(evidence.resultText, "FINAL TEXT");
    assert.equal(readFileSync(evidence.transcriptPath!, "utf8").includes("thread.started"), true);
  } finally {
    ok.cleanup();
  }

  const failed = harness({ stream: STREAM_OK, rollout: ROLLOUT_OK });
  try {
    const evidence = await run(failed, 1);
    assert.equal(evidence.outcome, "failed");
    assert.equal(evidence.resultText, "", "a session that wrote no final message yields empty text, never a fabricated one");
  } finally {
    failed.cleanup();
  }
});

test("execute: the wall-clock ceiling stays HARD — firing the session bound kills the tree and the outcome is `timeout` regardless of the exit code that follows (R1 changes budgets, never timeouts)", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    const p = h.executor.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    h.fireTimer(0); // the session bound — fired on the test's terms, never a real clock
    assert.deepEqual(h.child.killed, ["SIGTERM"]);
    h.fireTimer(0); // the SIGTERM->SIGKILL grace timer is now first in the queue
    assert.deepEqual(h.child.killed, ["SIGTERM", "SIGKILL"]);
    h.child.finish(0);
    const evidence = await p;
    assert.equal(evidence.outcome, "timeout", "a timeout stays a timeout even if the child then exits 0");
  } finally {
    h.cleanup();
  }
});

test("execute: a materialized tree that vanished before spawn is a SETUP failure — thrown, so runReviewSession maps it to unavailable (never a session against a bad path)", async () => {
  const h = harness();
  try {
    rmSync(h.req.treeDir, { recursive: true, force: true });
    await assert.rejects(() => h.executor.execute(h.req), /does not exist/);
    assert.equal(h.spawnCalls.length, 0);
  } finally {
    h.cleanup();
  }
});

test("execute: a broken event channel cannot become a gate — the session still runs and returns evidence", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    // Replace the executor's sink with one that throws on every append.
    const throwing = new CodexExecReviewSessionExecutor({
      stateDir: join(h.dir, "state2"),
      timeoutSec: 600,
      pricing: PRICING,
      codexBin: "/fake/codex",
      env: { PATH: "/usr/bin" },
      log: () => {},
      appendEvent: () => {
        throw new Error("event channel down");
      },
      newSessionId: () => "fixed2",
      startTimer: () => () => {},
      spawnFn: ((_bin: string, args: string[]) => {
        writeFileSync(args[args.indexOf("-o") + 1]!, "text", "utf8");
        queueMicrotask(() => h.child.emitStdout(STREAM_OK));
        return h.child;
        // biome-ignore lint/suspicious/noExplicitAny: see above
      }) as any,
    });
    const p = throwing.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    h.child.finish(0);
    const evidence = await p;
    assert.equal(evidence.outcome, "done");
  } finally {
    h.cleanup();
  }
});
