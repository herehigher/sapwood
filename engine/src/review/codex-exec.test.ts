// codex-exec.test.ts (#443) — the cross-vendor gate② session runner, against a FAKE spawn and a
// FIXTURE codex home. No real `codex` process is ever started here (the live shadow run is a
// separate, post-merge step, mirroring #313's method) and NOTHING in this file depends on a real
// timer, a subprocess's speed, or the scheduler: the timeout seam is injected and fired explicitly
// (engine/prompts/doctrine-core.md, "No timing-dependent assertions").
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
  ENGINE_REVIEW_ORPHANED_GROUP,
  ENGINE_REVIEW_SESSION_INSPECTION,
  estimateCodexCostUsd,
  findCodexRollout,
  isStrippedEnvKey,
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
  /** Set to make the injected `killFn` throw — e.g. an `ESRCH` for a group that already exited. */
  killThrows: Error | null;
  /** Set to make the injected GROUP-liveness probe throw, so the whole timeout coroutine blows up. */
  throwOnLivenessProbe: Error | null;
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
  // Mutable box so a test can arm the failure injections on the returned harness AFTER construction.
  const state: { killThrows: Error | null; throwOnLivenessProbe: Error | null } = { killThrows: null, throwOnLivenessProbe: null };

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
      if (state.killThrows) throw state.killThrows;
    },
    isTreeAlive: () => {
      if (state.throwOnLivenessProbe) throw state.throwOnLivenessProbe;
      return aliveReadings.length > 1 ? (aliveReadings.shift() as boolean) : (aliveReadings[0] as boolean);
    },
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
    get killThrows() {
      return state.killThrows;
    },
    set killThrows(e: Error | null) {
      state.killThrows = e;
    },
    get throwOnLivenessProbe() {
      return state.throwOnLivenessProbe;
    },
    set throwOnLivenessProbe(e: Error | null) {
      state.throwOnLivenessProbe = e;
    },
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
  assert.deepEqual(t, { threadId: "t1", usage: { inputTokens: 15, outputTokens: 3 }, toolItemCount: 0 });
});

test("parseCodexExecStream: a stream with no usage at all reports usage null — NOT zero (R1: missing telemetry is never read as free)", () => {
  const t = parseCodexExecStream(`{"type":"thread.started","thread_id":"t1"}\n{"type":"turn.failed","error":{"message":"boom"}}\n`);
  assert.equal(t.threadId, "t1");
  assert.equal(t.usage, null);
  assert.equal(t.toolItemCount, 0);
});

// ── #512: the session-inspection census ─────────────────────────────────────────────────────

test("parseCodexExecStream (#512): counts command_execution items — the shell call this runner's control demonstration showed is the actual tree-inspection capability", () => {
  const t = parseCodexExecStream(
    `{"type":"thread.started","thread_id":"t1"}\n` +
      `{"type":"item.completed","item":{"type":"command_execution","command":"rg --files -g 'engine/src/review/*.ts' ."}}\n` +
      `{"type":"item.completed","item":{"type":"command_execution","command":"rg --files -g 'engine/src/review/*.ts' . | wc -l"}}\n` +
      `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n`,
  );
  assert.equal(t.toolItemCount, 2);
});

test("parseCodexExecStream (#512): agent_message is NOT a tool call — a diff-only, zero-inspection session counts zero, honestly", () => {
  const t = parseCodexExecStream(
    `{"type":"thread.started","thread_id":"t1"}\n` +
      `{"type":"item.completed","item":{"type":"agent_message"}}\n` +
      `{"type":"item.completed","item":{"type":"reasoning"}}\n` +
      `{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n`,
  );
  assert.equal(t.toolItemCount, 0);
});

test("parseCodexExecStream (#512): a missing/malformed item.completed item is tolerated, never fatal — mirrors the parser's existing malformed-line tolerance", () => {
  const t = parseCodexExecStream(
    `{"type":"thread.started","thread_id":"t1"}\n` +
      `{"type":"item.completed"}\n` + // no `item` field at all
      `{"type":"item.completed","item":"not an object"}\n` +
      `{"type":"item.completed","item":{"noType":true}}\n` +
      `{"type":"item.completed","item":{"type":"command_execution"}}\n` + // the one real item among the noise
      `not json at all\n` +
      `{ truncated tail`,
  );
  assert.equal(t.toolItemCount, 1);
});

test("parseCodexExecStream (#512): a mixed stream counts every recognized TREE-INSPECTION item type", () => {
  const t = parseCodexExecStream(
    `{"type":"item.completed","item":{"type":"command_execution"}}\n` +
      `{"type":"item.completed","item":{"type":"file_change"}}\n` +
      `{"type":"item.completed","item":{"type":"mcp_tool_call"}}\n` +
      `{"type":"item.completed","item":{"type":"agent_message"}}\n`,
  );
  assert.equal(t.toolItemCount, 3);
});

test("parseCodexExecStream (#512, PM gate② review P2): web_search is NOT counted — a web search is not tree inspection, and this runner's argv disables it anyway (-c tools.web_search=false); counting it would inflate the exact signal this event exists to report honestly", () => {
  const t = parseCodexExecStream(
    `{"type":"item.completed","item":{"type":"command_execution"}}\n` + `{"type":"item.completed","item":{"type":"web_search"}}\n`,
  );
  assert.equal(t.toolItemCount, 1);
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

test("isStrippedEnvKey: the well-known credential FAMILIES an operator's shell carries are dropped — a prompt-injected session dumping `env` is the cheapest exfiltration path there is", () => {
  for (const key of [
    // forge / git / ssh (round 1)
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "GIT_ASKPASS",
    "GIT_CONFIG_GLOBAL",
    "SSH_AUTH_SOCK",
    "SSH_AGENT_PID",
    // cloud (round 2, P1-b)
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "GCLOUD_PROJECT",
    "CLOUDSDK_CONFIG",
    "AZURE_CLIENT_SECRET",
    "KUBECONFIG",
    // registries + docker
    "NPM_TOKEN",
    "NODE_AUTH_TOKEN",
    "CARGO_REGISTRY_TOKEN",
    "PIP_INDEX_URL",
    "TWINE_PASSWORD",
    "DOCKER_AUTH_CONFIG",
    // the generic name-shape sweep
    "SOME_VENDOR_TOKEN",
    "MY_SECRET",
    "STRIPE_API_KEY",
    "SERVICE_APIKEY",
    "DB_PASSWORD",
    "PG_PASSWD",
    "APP_CREDENTIALS",
  ]) {
    assert.equal(isStrippedEnvKey(key), true, `${key} must not reach a review session`);
  }
});

test("isStrippedEnvKey: the keep-set WINS over the sweep — every supported auth mode survives, or every review breaks with no way to catch it short of a paid run", () => {
  for (const key of [
    // Provider transport. Each of these three MATCHES the generic sweep (`_API_KEY`, `_TOKEN`),
    // which is exactly why they are pinned here: `codex doctor --json` reports
    // "auth is provided by environment" for each on a machine with no auth file, so a future
    // widening of the sweep that swallowed one would silently break authentication for those
    // operators. This assertion is the tripwire.
    "OPENAI_API_KEY",
    "CODEX_API_KEY",
    "CODEX_ACCESS_TOKEN",
    "OPENAI_BASE_URL",
    "CODEX_HOME",
    "CODEX_BIN",
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "TERM",
    "TZ",
  ]) {
    assert.equal(isStrippedEnvKey(key), false, `${key} is required for the session to run at all`);
  }
  // The sweep is a whole-key SUFFIX match, so an innocuous name that merely CONTAINS a keyword stays.
  for (const key of ["TOKENIZER_MODE", "SECRETS_MANAGER_REGION_NAME", "MY_PASSWORD_POLICY"]) {
    assert.equal(isStrippedEnvKey(key), false, `${key} is not a credential and must not be swept`);
  }
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
    "project_doc_max_bytes=0",
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

test("execute (#512): the session-inspection census is emitted once per session, carrying the runner, session id, and observed tool-item count — EVIDENCE ONLY, never read back by anything in this test's own assertions on outcome/spend/identity", async () => {
  const streamWithTools =
    `Reading prompt from stdin...\n` +
    `{"type":"thread.started","thread_id":"thread-xyz"}\n` +
    `{"type":"item.completed","item":{"type":"agent_message"}}\n` +
    `{"type":"item.completed","item":{"type":"command_execution","command":"rg --files ."}}\n` +
    `{"type":"item.completed","item":{"type":"command_execution","command":"cat engine/src/foo.test.ts"}}\n` +
    `{"type":"turn.completed","usage":{"input_tokens":1000,"output_tokens":100}}\n`;
  const h = harness({ stream: streamWithTools, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    const evidence = await run(h);
    const inspections = h.events.filter((e) => e.kind === ENGINE_REVIEW_SESSION_INSPECTION);
    assert.equal(inspections.length, 1, "exactly one census per session");
    assert.deepEqual(inspections[0]!.payload, { runner: "codex-exec", session: "engine-reviewer-fixed", toolItemCount: 2 });
    // The evidence still describes a NORMAL, successful session — the census rides alongside the
    // ordinary outcome/spend/identity evidence, it does not replace or gate any of it.
    assert.equal(evidence.outcome, "done");
  } finally {
    h.cleanup();
  }
});

test("execute (#512): a zero-tool-call session (the #443 shadow-run failure mode) still gets its census recorded, honestly, as zero — not omitted", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    await run(h);
    const inspections = h.events.filter((e) => e.kind === ENGINE_REVIEW_SESSION_INSPECTION);
    assert.equal(inspections.length, 1);
    assert.deepEqual(inspections[0]!.payload, { runner: "codex-exec", session: "engine-reviewer-fixed", toolItemCount: 0 });
  } finally {
    h.cleanup();
  }
});

test("execute (#512): the census is emitted with the module's BEST-EFFORT event() helper, not requireEvent — a failing/absent appendEvent must not stop the session from producing a verdict-worthy outcome (unlike the load-bearing containment-gap record)", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    // Swap in an appendEvent that throws for every call AFTER the (load-bearing) containment-gap
    // spawn-time write already succeeded, by making it throw only on this event's kind — proves the
    // failure is swallowed rather than propagated, exactly like ENGINE_REVIEW_COST_UNKNOWN's own
    // best-effort append.
    // biome-ignore lint/suspicious/noExplicitAny: reaching into a private field to arm a targeted failure for this one test
    (h.executor as any).deps.appendEvent = (kind: string, payload: unknown) => {
      if (kind === ENGINE_REVIEW_SESSION_INSPECTION) throw new Error("boom");
      h.events.push({ kind, payload: payload as Record<string, unknown> });
    };
    const evidence = await run(h);
    assert.equal(evidence.outcome, "done", "a broken best-effort event append must never turn a clean session into a failure");
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

test("execute (P1-a): a group that SURVIVES SIGKILL and never emits close/exit still settles — the review returns `timeout` and the surviving group is REPORTED, not awaited (the wedged-lane failure the whole fix exists to remove)", async () => {
  // Every liveness reading says ALIVE forever, so the two-dead-readings detector can NEVER trip;
  // and the child emits no `close`/`exit` at all. Before this fix the await never settled.
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK, aliveReadings: [true] });
  try {
    const p = h.executor.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    h.fireTimerAt(SESSION_TIMEOUT_MS);
    await Promise.resolve();
    h.fireTimerAt(KILL_GRACE_MS); // grace elapses, tree still alive ⇒ SIGKILL
    const evidence = await p; // settles WITHOUT any close/exit and WITHOUT the detector tripping
    assert.equal(evidence.outcome, "timeout");
    assert.deepEqual(h.signals, [
      { pid: -FAKE_PID, signal: "SIGTERM" },
      { pid: -FAKE_PID, signal: "SIGKILL" },
    ]);
    // The surviving group is a separate, durable fact for a human — not a reason to block.
    const orphan = h.events.filter((e) => e.kind === ENGINE_REVIEW_ORPHANED_GROUP);
    assert.equal(orphan.length, 1);
    assert.deepEqual(orphan[0]!.payload, { runner: "codex-exec", session: "engine-reviewer-fixed", pid: FAKE_PID });
  } finally {
    h.cleanup();
  }
});

test("execute (P1-a): a timed-out session whose group DID die reports no orphan — the report is a real observation, not a fixed side effect of every timeout", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK, aliveReadings: [true, true, false] });
  try {
    const p = h.executor.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    h.fireTimerAt(SESSION_TIMEOUT_MS);
    await Promise.resolve();
    h.fireTimerAt(KILL_GRACE_MS);
    const evidence = await p;
    assert.equal(evidence.outcome, "timeout");
    assert.equal(
      h.events.some((e) => e.kind === ENGINE_REVIEW_ORPHANED_GROUP),
      false,
    );
  } finally {
    h.cleanup();
  }
});

test("execute (P1-a, last edge): a THROW anywhere in the timeout termination path still settles — the settle lives in an unconditional finally, and the rejection never escapes the void'd coroutine", async () => {
  // The liveness probe itself throws (a non-ESRCH failure: EPERM, a broken injected probe, ...),
  // so `awaitKillGrace`/`treeIsGone` blow up INSIDE the coroutine — and the child emits no
  // `close`/`exit` ever. Before this fix, execution never reached the settle and the lane hung.
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  try {
    h.throwOnLivenessProbe = new Error("EPERM: liveness probe blew up");
    const p = h.executor.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    h.fireTimerAt(SESSION_TIMEOUT_MS);
    const evidence = await p; // settles despite the throw, with no close/exit ever emitted
    assert.equal(evidence.outcome, "timeout", "the timeout latch decides the outcome however we got here");
    // Give any escaped rejection a turn of the loop to surface before asserting it did not.
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, [], "a failure in the termination path must never escape as an unhandled rejection");
  } finally {
    process.off("unhandledRejection", onUnhandled);
    h.cleanup();
  }
});

test("execute (P2-b): ESRCH from the group signal is 'already gone' — no positive-pid retry, which after a group exit could deliver SIGKILL to a RECYCLED, unrelated process", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK, aliveReadings: [true] });
  try {
    // The scripted kill throws ESRCH for every signal, as the kernel does for a vanished group.
    h.killThrows = Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
    const p = h.executor.execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    h.fireTimerAt(SESSION_TIMEOUT_MS);
    await Promise.resolve();
    h.fireTimerAt(KILL_GRACE_MS);
    const evidence = await p;
    assert.equal(evidence.outcome, "timeout", "and the await still settles — ESRCH is not a reason to hang either");
    assert.deepEqual(
      h.signals.map((s) => s.pid),
      [-FAKE_PID, -FAKE_PID],
      "only ever the NEGATIVE (group) pid: the leader-pid fallback is gone",
    );
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

test("execute (P2-a): the PRE-SPAWN containment record is LOAD-BEARING — an event channel that throws means NO session is spawned, and the throw becomes `unavailable` upstream (the record IS the mitigation for an unfenced gap; it must not be the thing that silently drops)", async () => {
  const h = harness({ stream: STREAM_OK, lastMessage: "x", rollout: ROLLOUT_OK });
  let spawned = 0;
  try {
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
      spawnFn: (() => {
        spawned++;
        return h.child;
        // biome-ignore lint/suspicious/noExplicitAny: fake ChildProcess stand-in
      }) as any,
    });
    await assert.rejects(() => throwing.execute(h.req), /refusing to spawn an unrecorded codex review session/);
    assert.equal(spawned, 0, "nothing is spawned when the blind-spot record cannot be written");
  } finally {
    h.cleanup();
  }
});

test("execute (P2-a): a composition with NO durable event channel at all is refused the same way — a runner that cannot honor the disclosure the docs make on its behalf does not run", async () => {
  const h = harness();
  let spawned = 0;
  try {
    const unwired = new CodexExecReviewSessionExecutor({
      stateDir: join(h.dir, "state3"),
      timeoutSec: 600,
      pricing: PRICING,
      codexBin: "/fake/codex",
      env: { PATH: "/usr/bin" },
      log: () => {},
      newSessionId: () => "fixed3",
      startTimer: () => () => {},
      spawnFn: (() => {
        spawned++;
        return h.child;
        // biome-ignore lint/suspicious/noExplicitAny: fake ChildProcess stand-in
      }) as any,
    });
    await assert.rejects(() => unwired.execute(h.req), /no durable event channel wired/);
    assert.equal(spawned, 0);
  } finally {
    h.cleanup();
  }
});

test("execute (P2-a): post-run events stay BEST-EFFORT — a channel that starts throwing only after the pre-spawn record still lets the review return its evidence (observability never decides a verdict)", async () => {
  const h = harness({ stream: `{"type":"thread.started","thread_id":"thread-xyz"}\n`, lastMessage: "x", rollout: ROLLOUT_OK });
  try {
    // The cost-unknown alert (post-run) throws; the containment record (pre-spawn) succeeded.
    let calls = 0;
    const p = new CodexExecReviewSessionExecutor({
      stateDir: join(h.dir, "state4"),
      timeoutSec: SESSION_TIMEOUT_MS / 1000,
      livenessPollMs: POLL_MS,
      pricing: PRICING,
      codexBin: "/fake/codex",
      env: { PATH: "/usr/bin", CODEX_HOME: join(h.dir, "codex-home") },
      log: () => {},
      appendEvent: () => {
        calls++;
        if (calls > 1) throw new Error("event channel down after the first write");
      },
      newSessionId: () => "fixed4",
      startTimer: () => () => {},
      killFn: () => {},
      isTreeAlive: () => true,
      spawnFn: ((_bin: string, args: string[]) => {
        writeFileSync(args[args.indexOf("-o") + 1]!, "text", "utf8");
        queueMicrotask(() => h.child.emitStdout(`{"type":"thread.started","thread_id":"thread-xyz"}\n`));
        return h.child;
        // biome-ignore lint/suspicious/noExplicitAny: fake ChildProcess stand-in
      }) as any,
    }).execute(h.req);
    await Promise.resolve();
    await Promise.resolve();
    h.child.finish(0);
    const evidence = await p;
    assert.equal(evidence.outcome, "done");
    assert.deepEqual(evidence.spend, { kind: "unknown" }, "the alert it could not write is still the honest reading");
  } finally {
    h.cleanup();
  }
});
