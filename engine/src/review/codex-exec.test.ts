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
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCodexExecArgs,
  CONTAINMENT_GAP_HOST_WIDE_FILE_READS,
  CONTAINMENT_GAP_MODEL_INVOKED_EXECUTION,
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

const SESSION_TIMEOUT_MS = 600_000;
const KILL_GRACE_MS = 200;
const POLL_MS = 1000;
/** The fake child's pid — a small positive number that NEVER reaches the real OS: `killFn` and
 *  `isTreeAlive` are both injected in this suite, so nothing here can signal a live process. */
const FAKE_PID = 4242;

/** A minimal ChildProcess stand-in: stdout/stderr emitters, a pid, and a `finish()` the test calls
 *  when IT decides the session ended — never a real process, never a real clock. `kill()` is
 *  present but deliberately NOT what the executor should use: signalling must go through the
 *  injected `killFn` with a NEGATIVE pid (the whole process group), and a call landing here instead
 *  is the regression this suite exists to catch. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid: number | undefined = FAKE_PID;
  leaderOnlyKills: string[] = [];
  kill(signal: string): boolean {
    this.leaderOnlyKills.push(signal);
    return true;
  }
  emitStdout(text: string): void {
    this.stdout.emit("data", text);
  }
  finish(code: number | null): void {
    this.emit("exit", code);
    this.emit("close", code);
  }
}

interface Harness {
  dir: string;
  events: Array<{ kind: string; payload: Record<string, unknown> }>;
  spawnCalls: Array<{ bin: string; args: string[]; opts: Record<string, unknown> }>;
  child: FakeChild;
  /** Every `killFn(pid, signal)` the executor issued, verbatim — a NEGATIVE pid means the whole
   *  detached process group was signalled, which is the property under test. */
  signals: Array<{ pid: number; signal: string }>;
  /** Fire the pending timer scheduled for exactly `ms` (the executor's timers all have distinct
   *  durations, so this reads as "fire the session bound" / "fire a liveness poll" rather than an
   *  opaque index). Returns false when no such timer is pending. */
  fireTimerAt(ms: number): boolean;
  pendingTimerMs: () => number[];
  /** Scripted GROUP-liveness readings for the injected `isTreeAlive`; the last value repeats. */
  aliveReadings: boolean[];
  executor: CodexExecReviewSessionExecutor;
  req: ReviewSessionRequest;
  cleanup: () => void;
}

/** `stream` is what the fake CLI prints on stdout; `lastMessage`, when set, is written to whatever
 *  path the executor passed to `-o` (i.e. the file channel the final response really travels on). */
function harness(
  opts: { stream?: string; lastMessage?: string; env?: NodeJS.ProcessEnv; rollout?: string; aliveReadings?: boolean[] } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-codex-exec-"));
  const treeDir = join(dir, "tree");
  mkdirSync(treeDir, { recursive: true });
  const codexHome = join(dir, "codex-home");
  const events: Harness["events"] = [];
  const spawnCalls: Harness["spawnCalls"] = [];
  const signals: Harness["signals"] = [];
  const timers: Array<{ ms: number; fire: () => void }> = [];
  const child = new FakeChild();
  // Default: the tree stays ALIVE until the test says otherwise, so no path short-circuits on a
  // liveness reading the test didn't script.
  const aliveReadings = opts.aliveReadings ?? [true];

  if (opts.rollout !== undefined) {
    const day = join(codexHome, "sessions", "2026", "08", "01");
    mkdirSync(day, { recursive: true });
    writeFileSync(join(day, "rollout-2026-08-01T14-00-00-thread-xyz.jsonl"), opts.rollout, "utf8");
  }

  const executor = new CodexExecReviewSessionExecutor({
    stateDir: join(dir, "state"),
    timeoutSec: SESSION_TIMEOUT_MS / 1000,
    killGraceMs: KILL_GRACE_MS,
    livenessPollMs: POLL_MS,
    pricing: PRICING,
    codexBin: "/fake/codex",
    env: { PATH: "/usr/bin", CODEX_HOME: codexHome, GH_TOKEN: "secret", GITHUB_TOKEN: "secret", ...opts.env },
    log: () => {},
    appendEvent: (kind, payload) => events.push({ kind, payload: payload as Record<string, unknown> }),
    newSessionId: () => "fixed",
    killFn: (pid, signal) => {
      signals.push({ pid, signal: String(signal) });
    },
    isTreeAlive: () => (aliveReadings.length > 1 ? (aliveReadings.shift() as boolean) : (aliveReadings[0] as boolean)),
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
    signals,
    aliveReadings,
    pendingTimerMs: () => timers.map((t) => t.ms),
    fireTimerAt: (ms: number) => {
      const entry = timers.find((t) => t.ms === ms);
      if (!entry) return false;
      entry.fire();
      return true;
    },
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

test("codexSessionEnv: forge/git/SSH credential HANDLES are stripped or redirected, provider transport is NOT (a review that cannot reach its provider is broken, not contained)", () => {
  const env = codexSessionEnv(
    {
      PATH: "/usr/bin",
      GH_TOKEN: "x",
      GH_CONFIG_DIR: "/home/u/.config/gh",
      GITHUB_TOKEN: "x",
      GITHUB_ENTERPRISE_TOKEN: "x",
      GIT_ASKPASS: "/bin/echo",
      GIT_CONFIG_GLOBAL: "/home/u/.gitconfig",
      SSH_AUTH_SOCK: "/tmp/ssh-agent.sock",
      SSH_AGENT_PID: "999",
      CODEX_HOME: "/home/u/.codex",
      OPENAI_API_KEY: "sk-test",
    },
    "/state/session.gh-config",
  );
  // Stripped outright: every inherited forge/SSH credential handle. A live agent socket is a
  // USABLE credential with no key file to read, which is why SSH_AUTH_SOCK is on this list.
  for (const stripped of ["GH_TOKEN", "GITHUB_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GIT_ASKPASS", "SSH_AUTH_SOCK", "SSH_AGENT_PID"]) {
    assert.equal(env[stripped], undefined, `${stripped} must not reach a review session`);
  }
  // Redirected/neutralized (set AFTER the strip loop, so an inherited value can never survive).
  assert.equal(env.GH_CONFIG_DIR, "/state/session.gh-config", "gh looks at an empty ephemeral config home, not the operator's");
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  // Preserved: provider transport, and the ordinary runtime environment.
  assert.equal(env.CODEX_HOME, "/home/u/.codex");
  assert.equal(env.OPENAI_API_KEY, "sk-test");
  assert.equal(env.PATH, "/usr/bin");
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
    assert.equal(call.opts.detached, true, "the child leads its own process group, so the timeout can kill the whole tree");
    // stdin is a numeric file descriptor, and the file it points at holds the prompt verbatim.
    const stdio = call.opts.stdio as [number, string, string];
    assert.equal(typeof stdio[0], "number");
    assert.equal(readFileSync(join(h.dir, "state", "engine-reviewer-fixed.prompt.txt"), "utf8"), "review this diff");
    // The hardened env actually reaches the spawn: an empty per-session gh config home, neutralized
    // git config, and no inherited SSH agent socket.
    const env = call.opts.env as NodeJS.ProcessEnv;
    assert.equal(env.GH_CONFIG_DIR, join(h.dir, "state", "engine-reviewer-fixed.gh-config"));
    assert.deepEqual(readdirSync(env.GH_CONFIG_DIR as string), [], "the redirected gh config home is empty, and exists");
    assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
    assert.equal(env.GIT_TERMINAL_PROMPT, "0");
    assert.equal(env.SSH_AUTH_SOCK, undefined);
  } finally {
    h.cleanup();
  }
});

test("execute (R2): the containment blind-spot warning fires at EVERY spawn and names BOTH facets — execution of reviewed code AND host-wide filesystem reads, the latter greppable on its own", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    await run(h);
    const gap = h.events.filter((e) => e.kind === ENGINE_REVIEW_CONTAINMENT_GAP);
    assert.equal(gap.length, 1);
    assert.deepEqual(gap[0]!.payload, {
      runner: "codex-exec",
      session: "engine-reviewer-fixed",
      gaps: [CONTAINMENT_GAP_MODEL_INVOKED_EXECUTION, CONTAINMENT_GAP_HOST_WIDE_FILE_READS],
    });
    // The credential-read exposure is a NAMED entry, not prose folded into an "execution" label —
    // an operator filtering the event stream for it must be able to match on this string alone.
    assert.ok(
      (gap[0]!.payload.gaps as string[]).includes(CONTAINMENT_GAP_HOST_WIDE_FILE_READS),
      "the read-scope gap must be independently greppable",
    );
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

test("execute: the wall-clock ceiling kills the whole PROCESS GROUP — SIGTERM then SIGKILL at the NEGATIVE pid, so a descendant forked by reviewed code cannot outlive the timeout (killing only the leader is the regression this pins)", async () => {
  // The tree stays alive through the grace window, so the SIGKILL escalation is warranted — the
  // reading is scripted, never a real `process.kill(pid, 0)` against a real child.
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK, aliveReadings: [true] });
  try {
    const p = h.executor.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(h.fireTimerAt(SESSION_TIMEOUT_MS), "the session bound — fired on the test's terms, never a real clock");
    await Promise.resolve();
    assert.deepEqual(h.signals, [{ pid: -FAKE_PID, signal: "SIGTERM" }], "the GROUP is signalled, not the leader");
    assert.ok(h.fireTimerAt(KILL_GRACE_MS), "the SIGTERM->SIGKILL grace window elapses with the tree still alive");
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(h.signals, [
      { pid: -FAKE_PID, signal: "SIGTERM" },
      { pid: -FAKE_PID, signal: "SIGKILL" },
    ]);
    assert.deepEqual(h.child.leaderOnlyKills, [], "child.kill() — which reaches ONLY the leader — is never used");
    h.child.finish(0);
    const evidence = await p;
    assert.equal(evidence.outcome, "timeout", "a timeout stays a timeout even if the child then exits 0");
  } finally {
    h.cleanup();
  }
});

test("execute: the SIGKILL escalation is skipped when the whole tree is already gone inside the grace window — peripheral.ts's own awaitKillGrace semantics, reused rather than reimplemented", async () => {
  // Alive at the timeout (so the kill path starts), gone by the time the grace settles.
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK, aliveReadings: [true, true, false] });
  try {
    const p = h.executor.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    h.fireTimerAt(SESSION_TIMEOUT_MS);
    await Promise.resolve();
    h.fireTimerAt(KILL_GRACE_MS);
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(
      h.signals,
      [{ pid: -FAKE_PID, signal: "SIGTERM" }],
      "nothing left in the group ⇒ no SIGKILL at a pid the OS may have recycled",
    );
    h.child.finish(0);
    await p;
  } finally {
    h.cleanup();
  }
});

test("execute: a LOST child-exit notification settles synthetically instead of hanging — two consecutive dead group readings (createExitLossDetector) end the await, and the outcome is `failed`, never `done` on an unobserved exit", async () => {
  // The child never emits `close`/`exit` at all — the wedged-lane scenario. Readings: alive once
  // (the counter must reset on a live reading), then dead twice.
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK, aliveReadings: [true, false, false] });
  try {
    const p = h.executor.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    assert.ok(h.fireTimerAt(POLL_MS), "poll 1 — alive, nothing settles");
    await Promise.resolve();
    assert.ok(h.fireTimerAt(POLL_MS), "poll 2 — first dead reading, still not enough on its own");
    await Promise.resolve();
    assert.ok(h.fireTimerAt(POLL_MS), "poll 3 — second consecutive dead reading ⇒ the exit is lost");
    const evidence = await p; // resolves WITHOUT any close/exit event ever arriving
    assert.equal(evidence.outcome, "failed");
    assert.equal(h.pendingTimerMs().includes(POLL_MS), false, "the poll stops once loss is declared");
  } finally {
    h.cleanup();
  }
});

test("execute: a lost exit AFTER a timeout still reads as `timeout` — the timeout latch wins, exactly as peripheral.ts orders it", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK, aliveReadings: [true, true, false, false] });
  try {
    const p = h.executor.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    h.fireTimerAt(SESSION_TIMEOUT_MS);
    await Promise.resolve();
    h.fireTimerAt(POLL_MS);
    await Promise.resolve();
    h.fireTimerAt(POLL_MS);
    const evidence = await p;
    assert.equal(evidence.outcome, "timeout");
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
