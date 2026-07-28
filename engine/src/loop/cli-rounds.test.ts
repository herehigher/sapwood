// cli-rounds.test.ts (#106): `sapwood run` switches its DEFAULT engine from the M4 tick-driver
// to the round orchestrator. These tests drive `cli.ts`'s own `runEngine` — the exact function
// `main()` calls — proving the round path (round.ts's runRounds, wired with round-defaults.ts's
// createDefaultPeripherals and a REAL RoleRunner) is reached from production code, not only from
// round.test.ts/round-defaults.test.ts's own direct-library-call tests. Same "fake the
// collaborator (forge), not the CLI" split as round-defaults.test.ts, and the same claude-stub
// style as peripheral.test.ts/worker.test.ts for the RoleRunner side: a stub `claude` binary
// (zero token) drives the real spawn/sentinel/cost-parse path — createDefaultPeripherals's
// stubs are never faked themselves.
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { type EngineOverrides, runCli, runDryRun, runEngine, tickOnlyFlagError } from "../cli.js";
import { ConfigSchema, configHash, dashboardConfigSubset, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus, StartupReconcileData } from "../forge/forge.js";
import { State } from "../state/state.js";
import type { PeripheralPhase } from "./round.js";

// #231: createAligningStub now treats an unreadable goal file as an EXPLICIT align-creation
// failure (no session dispatched) rather than the pre-#231 silent "" — this suite's default
// config needs a REAL, readable goal file so the round path still dispatches a real po-align
// session (this file proves the REAL RoleRunner wiring, so at least one real session must run).
const DEFAULT_TEST_GOAL_DIR = mkdtempSync(join(tmpdir(), "sapwood-cli-rounds-goal-"));
const DEFAULT_TEST_GOAL_FILE = join(DEFAULT_TEST_GOAL_DIR, "PLAN.md");
writeFileSync(DEFAULT_TEST_GOAL_FILE, "# Test goal\nHarmless default content for tests that don't care about plan.md.\n");
after(() => rmSync(DEFAULT_TEST_GOAL_DIR, { recursive: true, force: true }));

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    goal: { file: DEFAULT_TEST_GOAL_FILE },
    ...over,
  });
const silentLogger = { log(_message: string): void {} };

const mkStub = (dir: string, body: string): string => {
  const p = join(dir, "claude-stub");
  writeFileSync(p, body, { mode: 0o755 });
  chmodSync(p, 0o755);
  return p;
};
const FAST_STUB =
  `#!/usr/bin/env bash\necho '{"type":"result","subtype":"success","total_cost_usd":0.0005,` +
  `"model":"claude-stub","usage":{"input_tokens":3,"output_tokens":7}}'\nexit 0\n`;
const mkHook = (dir: string): string => {
  const p = join(dir, "guard-hook.js");
  writeFileSync(p, "process.exit(0)\n");
  return p;
};

// Same shape as round-defaults.test.ts's own FakeForge — this file deliberately doesn't import
// it (that file's FakeForge is a private test fixture, not an exported module) — kept minimal:
// only the methods the aligning/architecting/plan_review/harvesting/retro peripherals + tick()'s
// dispatch-eligibility path actually call.
class FakeForge implements IForge {
  planReviewCandidates: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  unplaced = { issues: [] as number[], skipped: 0 };
  boardCalls: string[] = [];
  reconcileData: StartupReconcileData = { placements: [], openPrs: [] };
  reconcileReads = 0;
  reconcileError: Error | null = null;

  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  async listUnplacedIssues() {
    this.boardCalls.push("list-unplaced");
    return this.unplaced;
  }
  async readStartupReconcileData() {
    this.reconcileReads++;
    if (this.reconcileError) throw this.reconcileError;
    return this.reconcileData;
  }
  async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  async getPoolEligibleIssues(): Promise<Issue[]> {
    return [];
  }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(issue: number, status: Parameters<IForge["setBoardStatus"]>[1]): Promise<void> {
    this.boardCalls.push(`set-${issue}-${status}`);
  }
  async addSubIssue(): Promise<void> {
    throw new Error("FakeForge.addSubIssue is not used by this test");
  }
  async getSubIssues() {
    return [];
  }
  async addLabel(n: number, l: string): Promise<void> {
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  async removeLabel(n: number, l: string): Promise<void> {
    this.issueLabels[n] = (this.issueLabels[n] ?? []).filter((x) => x !== l);
  }
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> {
    return 1;
  }
  async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(): Promise<void> {}
  async getIssueBody(): Promise<string> {
    return "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
  }
  async getPRReviewData(): Promise<PRReviewData> {
    return {
      headOid: "x",
      author: "producer",
      updatedAt: "2026-01-01T00:00:00Z",
      isDraft: false,
      labels: [],
      state: "OPEN",
      reactions: [],
      reviews: [],
      unresolvedThreads: 0,
    };
  }
  async getPRDiff(): Promise<string> {
    return "";
  }
  async getPRChangedFiles() {
    return { files: [], complete: true };
  }
  async getCommitsSince(): Promise<CommitInfo[]> {
    return [];
  }
  async branchExists(): Promise<boolean> {
    return false;
  }
  async countOpenIssuesInMilestone(): Promise<number> {
    return 0;
  }
  async listMilestoneTitles(): Promise<string[]> {
    return [];
  }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return this.planReviewCandidates;
  }
  async getIssueLabels(issue: number): Promise<string[]> {
    return this.issueLabels[issue] ?? [];
  }
  async getIssueComments(issue: number) {
    return this.issueComments[issue] ?? [];
  }
  async createIssue(): Promise<number> {
    return 0;
  }
  async listOpenIssueNumbers(): Promise<number[]> {
    return [];
  }
  async listOpenIssues(): Promise<Issue[]> {
    return [];
  }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return [];
  }
}

test("sapwood run startup reconcile emits board/PR orphans without forge writes, and runs once", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.reconcileData = {
    placements: [{ number: 171, repo: "o/r", status: "In Progress" }],
    openPrs: [{ number: 200, body: "Fixes #171" }],
  };
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: silentLogger,
    });
    assert.equal(code, 0);
    assert.equal(forge.reconcileReads, 1);
    assert.deepEqual(forge.boardCalls, ["list-unplaced"]);
    assert.equal(state.eventsSince("1970-01-01T00:00:00.000Z", ["orphan-detected"]).length, 2);
  } finally {
    state.close();
  }
});

test("sapwood run startup reconcile is quiet when rows match and forge-down is non-fatal", async () => {
  const cfg = mkCfg({ engine: { driver: "tick" } });
  const healthyState = new State(":memory:");
  healthyState.upsertWorker({
    name: "lane-171",
    issue: 171,
    session_id: "s",
    state: "handoff",
    started_at: "2026-07-15T00:00:00.000Z",
    ended_at: null,
    pr: 200,
    // #171 deliberately used handoff here to prove that a terminal-resumable row still owns
    // its In Progress issue + open PR during startup reconciliation. #172 makes an uncapped
    // handoff live work; cap this sentinel-less fixture so the test remains reconcile-only
    // without erasing that original handoff-ownership coverage.
    resume_attempts: cfg.worker.maxResumes,
    resume_capped: 1,
  });
  const healthyForge = new FakeForge();
  healthyForge.reconcileData = {
    placements: [{ number: 171, repo: "o/r", status: "In Progress" }],
    openPrs: [{ number: 200, body: "Fixes #171" }],
  };
  try {
    assert.equal(
      await runEngine(["node", "sapwood", "run", "--once"], { cfg, forge: healthyForge, state: healthyState, logger: silentLogger }),
      0,
    );
    assert.equal(healthyState.eventsSince("1970-01-01T00:00:00.000Z", ["orphan-detected"]).length, 0);
    assert.equal(healthyState.eventsSince("1970-01-01T00:00:00.000Z", ["resume-failed"]).length, 0);
  } finally {
    healthyState.close();
  }

  const failedState = new State(":memory:");
  const failedForge = new FakeForge();
  failedForge.reconcileError = new Error("forge unreachable");
  try {
    const logged: string[] = [];
    assert.equal(
      await runEngine(["node", "sapwood", "run", "--once"], {
        cfg,
        forge: failedForge,
        state: failedState,
        logger: { log: (line) => logged.push(line) },
      }),
      0,
    );
    assert.ok(logged.some((line) => line.startsWith("[sapwood:reconcile]")));
  } finally {
    failedState.close();
  }
});

test("sapwood run (default driver): runEngine reaches runRounds via createDefaultPeripherals wired to a REAL RoleRunner — dispatches real role sessions to the stub claude binary, and a graceful stop still closes the in-flight round", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-rounds-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const state = new State(":memory:");
    const forge = new FakeForge();
    forge.unplaced = { issues: [173], skipped: 0 };
    // #125: FakeForge is an intentionally empty board (this test is about the CLI's wiring to a
    // REAL RoleRunner, not the standby probe) — opt out explicitly so round 1 still opens
    // immediately, same as before #125.
    const cfg = mkCfg({
      logging: { path: "logs/engine.log" },
      roles: { retro: { enabled: false } },
      round: { standby: { enabled: false } },
    }); // engine.driver unset -> defaults to "rounds"
    assert.equal(cfg.engine.driver, "rounds");

    let stop = (): void => {};
    const logged: string[] = [];
    const overrides: EngineOverrides = {
      cfg,
      forge,
      state,
      logger: { log: (line) => logged.push(line) },
      roleRunnerDeps: {
        stateDir: dir,
        worktreeRoot: join(dir, "worktrees"),
        claudeBin: bin,
        heartbeatMs: 50,
        guardHookPath: mkHook(dir),
        // #236 (Codex R1): this suite's stub `claude` binaries emit no init line, so a REAL
        // RoleRunner would otherwise wait the full production preSpawnCaptureTimeoutMs (30s) per
        // dispatched role session before falling back — a fast bound keeps this test's REAL
        // multi-phase round loop fast without changing what it actually proves.
        preSpawnCaptureTimeoutMs: 150,
        preSpawnCapturePollMs: 10,
      },
      sleep: async () => {},
      registerSignals: (requestStop) => {
        stop = requestStop;
        return () => {};
      },
      // Same graceful-stop-mid-round trigger as round-defaults.test.ts: fire right after the
      // FIRST phase completes — the round must still run every remaining phase (including
      // harvest) to close, proving the safety property survives the cli.ts wiring switch.
      onRoundPhase: (_roundId, phase: PeripheralPhase) => {
        if (phase === "aligning") stop();
      },
    };

    const code = await runEngine(["node", "sapwood", "run"], overrides);

    assert.equal(code, 0);
    assert.deepEqual(forge.boardCalls.slice(0, 2), ["list-unplaced", "set-173-backlog"], "normalization runs before the round loop");
    assert.equal(forge.reconcileReads, 1, "round driver reconciles exactly once per engine start");
    assert.deepEqual(state.eventsSince("2020-01-01T00:00:00Z", ["board-normalized"]), [
      { kind: "board-normalized", payload: { issue: 173, status: "backlog" } },
    ]);
    const round = state.getRound(1)!;
    assert.equal(round.phase, "closed", "graceful stop still let the in-flight round finish (harvest included)");

    // Proof the round path reached a REAL RoleRunner (not a fake): the stub `claude` binary
    // actually ran, leaving real sentinel files behind for at least one role session.
    const sentinels = readdirSync(dir).filter((f) => f.endsWith(".done.json"));
    assert.ok(sentinels.length > 0, "expected at least one real role session to have run to completion");
    assert.ok(logged.includes(`[sapwood:run] startup logPath=${resolve("logs/engine.log")}`));
    assert.ok(
      logged.some((line) => line.startsWith("[sapwood:tick] ")),
      "the existing onTick seam records a tick summary",
    );
    assert.ok(
      logged.some((line) => line.startsWith("[sapwood:round] peripheral role(s) disabled by config")),
      "degradation is logged",
    );
    assert.ok(logged.some((line) => line.startsWith("[sapwood:round] round 1: phase aligning completed")));
    assert.ok(
      logged.some((line) => line.startsWith("[sapwood:run] stopped after 1 round(s)")),
      "the stop summary is logged",
    );
    assert.ok(
      logged.every((line) => /^\[sapwood:[^\]]+\]/.test(line)),
      "every run-path message carries a subsystem tag",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run (default driver, #253): cfg.proxy.enabled: true, shadow: false (the go-live flip) wires a REAL default forge MCP proxy into the RoleRunner — a real role session actually gets --mcp-config + widened mcp__forge__* allowedTools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-rounds-proxy-"));
  try {
    const argvLog = join(dir, "argv.log");
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >> "${argvLog}"\nprintf '\\n===\\n' >> "${argvLog}"\n` +
        `echo '{"type":"result","subtype":"success","total_cost_usd":0.0005,"model":"claude-stub","usage":{"input_tokens":3,"output_tokens":7}}'\nexit 0\n`,
    );
    const state = new State(":memory:");
    const forge = new FakeForge();
    const cfg = mkCfg({
      logging: { path: "logs/engine.log" },
      roles: { retro: { enabled: false } },
      round: { standby: { enabled: false } },
      proxy: { enabled: true, shadow: false },
    });

    let stop = (): void => {};
    const overrides: EngineOverrides = {
      cfg,
      forge,
      state,
      logger: silentLogger,
      roleRunnerDeps: {
        stateDir: dir,
        worktreeRoot: join(dir, "worktrees"),
        claudeBin: bin,
        heartbeatMs: 50,
        guardHookPath: mkHook(dir),
        preSpawnCaptureTimeoutMs: 150,
        preSpawnCapturePollMs: 10,
      },
      sleep: async () => {},
      registerSignals: (requestStop) => {
        stop = requestStop;
        return () => {};
      },
      onRoundPhase: (_roundId, phase: PeripheralPhase) => {
        if (phase === "aligning") stop();
      },
    };

    const code = await runEngine(["node", "sapwood", "run"], overrides);
    assert.equal(code, 0);

    const sentinels = readdirSync(dir).filter((f) => f.endsWith(".done.json"));
    assert.ok(sentinels.length > 0, "expected at least one real role session to have run to completion");

    const argvText = readFileSync(argvLog, "utf8");
    assert.ok(argvText.includes("--mcp-config"), "the real RoleRunner attached the default proxy's --mcp-config to a real session");
    assert.ok(argvText.includes("mcp__forge__"), "allowedTools was widened with the proxy's own mcp__forge__* tool names");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run (default driver, #253 review round 2, H1): cfg.proxy.enabled: true, shadow: true (the DEFAULT once enabled) -> the RoleRunner NEVER gets a defaultProxy — a real role session's argv carries no mcp__forge__* tool name and no proxy-shaped --mcp-config content at all (#410: --mcp-config itself is now ALWAYS present, an explicit empty map — the settings-pinning triple every peripheral session gets, proxy or not)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-rounds-proxy-shadow-"));
  try {
    const argvLog = join(dir, "argv.log");
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\0' "$@" >> "${argvLog}"\nprintf '\\n===\\n' >> "${argvLog}"\n` +
        `echo '{"type":"result","subtype":"success","total_cost_usd":0.0005,"model":"claude-stub","usage":{"input_tokens":3,"output_tokens":7}}'\nexit 0\n`,
    );
    const state = new State(":memory:");
    const forge = new FakeForge();
    const cfg = mkCfg({
      logging: { path: "logs/engine.log" },
      roles: { retro: { enabled: false } },
      round: { standby: { enabled: false } },
      proxy: { enabled: true }, // shadow defaults true
    });
    assert.equal(cfg.proxy.shadow, true);

    let stop = (): void => {};
    const overrides: EngineOverrides = {
      cfg,
      forge,
      state,
      logger: silentLogger,
      roleRunnerDeps: {
        stateDir: dir,
        worktreeRoot: join(dir, "worktrees"),
        claudeBin: bin,
        heartbeatMs: 50,
        guardHookPath: mkHook(dir),
        preSpawnCaptureTimeoutMs: 150,
        preSpawnCapturePollMs: 10,
      },
      sleep: async () => {},
      registerSignals: (requestStop) => {
        stop = requestStop;
        return () => {};
      },
      onRoundPhase: (_roundId, phase: PeripheralPhase) => {
        if (phase === "aligning") stop();
      },
    };

    const code = await runEngine(["node", "sapwood", "run"], overrides);
    assert.equal(code, 0);

    const sentinels = readdirSync(dir).filter((f) => f.endsWith(".done.json"));
    assert.ok(sentinels.length > 0, "expected at least one real role session to have run to completion");

    const argvText = readFileSync(argvLog, "utf8");
    // #410: --mcp-config is now unconditional (every peripheral session pins the settings triple),
    // so its bare presence no longer signals a proxy — assert on the PROXY-SHAPED content instead
    // (its mcp__forge__* tool names, which shadow mode must never let any session hold).
    assert.ok(argvText.includes('{"mcpServers":{}}'), "#410: --mcp-config now always carries the explicit empty map");
    assert.ok(!argvText.includes("mcp__forge__"), "shadow mode: no session anywhere gets a proxy attached");
    assert.ok(!argvText.includes("mcp__forge__"), "shadow mode: allowedTools is never widened");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run (default driver): KILL_SWITCH blocks every peripheral AND dispatch — the round path reached via runEngine never spawns a role session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-rounds-kill-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), ""); // KILL_SWITCH lives beside the db file (state.ts)
    const forge = new FakeForge();
    const cfg = mkCfg();

    const overrides: EngineOverrides = {
      cfg,
      forge,
      state,
      logger: silentLogger,
      roleRunnerDeps: {
        stateDir: join(dir, "roles"),
        worktreeRoot: join(dir, "worktrees"),
        claudeBin: bin,
        heartbeatMs: 50,
        guardHookPath: mkHook(dir),
        preSpawnCaptureTimeoutMs: 150,
        preSpawnCapturePollMs: 10,
      },
      sleep: async () => {},
      registerSignals: () => () => {},
    };

    const code = await runEngine(["node", "sapwood", "run"], overrides);

    assert.equal(code, 1, "kill-switch stop is a non-zero exit — an operator must notice");
    // A round IS opened (round.ts's startRound runs before the first phase's kill-switch check),
    // but it never advances past the first phase and never closes — the blocked peripheral, not
    // "no round at all", is the safety property under test (same shape as round-defaults.test.ts's
    // own kill-switch integration test: result.rounds stays 0).
    const round = state.getRound(1);
    assert.ok(round, "the round loop starts a round before checking the kill switch");
    assert.equal(round!.phase, "aligning", "blocked at the FIRST phase — never advanced");
    assert.equal(round!.status, "in_progress", "never closed");
    // RoleRunner's constructor always mkdir's its session dir (even if .run() never fires), so
    // "never spawned" means the dir is empty, not absent.
    const roleDir = join(dir, "roles");
    assert.ok(!existsSync(roleDir) || readdirSync(roleDir).length === 0, "no role session ever ran");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #206: run boundaries + config provenance in the event stream (frontend-design.md §11) ────

test("sapwood run (#206): startup appends exactly ONE run-started event, before the first round opens, carrying the allowlisted config subset + a hash of the full config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-rounds-runstarted-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const state = new State(join(dir, "sapwood.sqlite"));
    // Same KILL_SWITCH shortcut as the test above: the round still OPENS (proving the ordering
    // claim) but freezes at its first phase, so this stays a fast, session-free run.
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const forge = new FakeForge();
    const cfg = mkCfg({ proxy: { enabled: true } });

    await runEngine(["node", "sapwood", "run"], {
      cfg,
      forge,
      state,
      logger: silentLogger,
      roleRunnerDeps: {
        stateDir: join(dir, "roles"),
        worktreeRoot: join(dir, "worktrees"),
        claudeBin: bin,
        heartbeatMs: 50,
        guardHookPath: mkHook(dir),
        preSpawnCaptureTimeoutMs: 150,
        preSpawnCapturePollMs: 10,
      },
      sleep: async () => {},
      registerSignals: () => () => {},
    });

    const stream = state.eventsSince("1970-01-01T00:00:00.000Z", ["run-started", "round-phase", "board-normalized"]);
    assert.equal(stream.filter((e) => e.kind === "run-started").length, 1, "exactly one per process start");
    assert.equal(stream[0]?.kind, "run-started", "the run boundary is the FIRST thing this run wrote");
    assert.deepEqual(stream[1], { kind: "round-phase", payload: { round_id: 1, phase: "aligning" } }, "…and it precedes round 1");

    const payload = stream[0]!.payload as { config: Record<string, unknown>; configHash: string };
    assert.deepEqual(payload.config, JSON.parse(JSON.stringify(dashboardConfigSubset(cfg))));
    assert.equal(payload.configHash, configHash(cfg));
    // The dashboard serves /api/events payloads verbatim, so the allowlist has to hold HERE:
    // `proxy` is set in this run's config and must still be absent from what was written.
    assert.equal(payload.config.proxy, undefined);
    assert.equal(payload.config.logging, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── gate② P2 (#106 review): tick-only flags FAIL FAST under rounds, never silently ignored ──

test("tickOnlyFlagError: --once/--until-idle produce an actionable error; --dry-run and plain runs do not", () => {
  assert.equal(tickOnlyFlagError(["node", "sapwood", "run"]), null);
  assert.equal(tickOnlyFlagError(["node", "sapwood", "run", "--dry-run"]), null);
  assert.match(tickOnlyFlagError(["node", "sapwood", "run", "--once"])!, /--once only apply to the tick driver/);
  assert.match(tickOnlyFlagError(["node", "sapwood", "run", "--once"])!, /engine\.driver: tick/);
  assert.match(tickOnlyFlagError(["node", "sapwood", "run", "--once"])!, /--stop-after-issues/);
  assert.match(tickOnlyFlagError(["node", "sapwood", "run", "--until-idle"])!, /--until-idle only apply/);
  assert.match(tickOnlyFlagError(["node", "sapwood", "run", "--once", "--until-idle"])!, /--once\/--until-idle only apply/);
});

/** Capture what runEngine writes to process.stderr for the duration of `fn`. */
async function captureStderr(fn: () => Promise<number>): Promise<{ code: number; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = "";
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    stderr += chunk.toString();
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await fn();
    return { code, stderr };
  } finally {
    process.stderr.write = original;
  }
}

for (const flag of ["--once", "--until-idle"] as const) {
  test(`sapwood run ${flag} under the rounds default: fails fast with an actionable error — exit 1, ZERO dispatch (no round opened, no role session, no forge call)`, async () => {
    const state = new State(":memory:");
    const forge = new FakeForge();
    let forgeTouched = false;
    // Any forge access at all means dispatch machinery started — fail-fast must precede it.
    const trackingForge = new Proxy(forge, {
      get(target, prop, receiver) {
        forgeTouched = true;
        return Reflect.get(target, prop, receiver);
      },
    });
    const cfg = mkCfg(); // engine.driver defaults to "rounds"

    const { code, stderr } = await captureStderr(() => runEngine(["node", "sapwood", "run", flag], { cfg, forge: trackingForge, state }));

    assert.equal(code, 1);
    assert.match(stderr, /only apply to the tick driver/);
    assert.match(stderr, /engine\.driver: tick/, "the error names the escape hatch");
    assert.match(stderr, /--stop-after-issues/, "the error names the rounds-compatible bounding flags");
    assert.equal(state.getRound(1), undefined, "no round was ever opened");
    assert.equal(forgeTouched, false, "no forge collaborator was ever constructed/called — zero dispatch");
    state.close();
  });
}

// ── #129: `--milestone NAME` — same startup validation as --stop-on-milestone, reached through
// runEngine (the exact function main() calls), proving the shortcut's stop half fails CLOSED
// before any dispatch, exactly like an explicit --stop-on-milestone typo already does. Like
// assertStopMilestoneExists itself (cli.test.ts), an unknown title THROWS rather than returning
// a code — production's main() catches this at the top level (console.error + exit 1); this test
// asserts the same rejection directly, plus zero dispatch (no round ever opened).
test("sapwood run --milestone <unknown title>: fails fast — rejects naming the real titles, ZERO dispatch (no round opened)", async () => {
  const state = new State(":memory:");
  class NamedMilestoneForge extends FakeForge {
    override async listMilestoneTitles(): Promise<string[]> {
      return ["M4 — UX surface + CLI", "v0.2 — Dashboard (dogfood)"];
    }
  }
  const forge = new NamedMilestoneForge();
  const cfg = mkCfg(); // engine.driver defaults to "rounds"

  await assert.rejects(
    () => runEngine(["node", "sapwood", "run", "--milestone", "M4"], { cfg, forge, state, logger: silentLogger }),
    /no milestone titled "M4".*M4 — UX surface \+ CLI/s,
  );
  assert.equal(state.getRound(1), undefined, "no round was ever opened — the throw happens before runRounds starts");
  state.close();
});

test("sapwood run --milestone <real title>: scopes AND stops on the same milestone (round.milestone + stop.onMilestoneComplete both set from one flag)", async () => {
  const state = new State(":memory:");
  class NamedMilestoneForge extends FakeForge {
    override async listMilestoneTitles(): Promise<string[]> {
      return ["M4 — UX surface + CLI"];
    }
    override async countOpenIssuesInMilestone(): Promise<number> {
      return 0; // already exhausted -> the round loop's final stop condition fires immediately
    }
  }
  const forge = new NamedMilestoneForge();
  const cfg = mkCfg(); // engine.driver defaults to "rounds", no round.milestone/stop configured

  const code = await runEngine(["node", "sapwood", "run", "--milestone", "M4 — UX surface + CLI"], {
    cfg,
    forge,
    state,
    logger: silentLogger,
    sleep: async () => {},
    registerSignals: () => () => {},
  });

  // Zero open issues in the milestone from tick 1 -> the round loop's dispatch batch is skipped
  // (round.milestone scoping) AND the final onMilestoneComplete condition fires immediately
  // (stop-condition wind-down) — both halves of the one flag, proven by a clean, prompt exit.
  assert.equal(code, 0);
});

test("sapwood run --dry-run stays driver-agnostic: the preview path works with the rounds default and dispatches nothing", async () => {
  const forge = new FakeForge();
  const cfg = mkCfg(); // engine.driver defaults to "rounds"
  // main() routes --dry-run to runDryRun BEFORE runEngine (so tickOnlyFlagError never sees it);
  // this drives that exact production function with the rounds-default config.
  const originalWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runDryRun({ cfg, forge });
    assert.equal(code, 0);
    assert.match(stdout, /no worker dispatched, no state written/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("sapwood run --config loads the named config and resolves worker.promptFile against that config's directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-run-config-"));
  const state = new State(":memory:");
  try {
    writeFileSync(join(dir, "worker.md"), "Implement issue #{{issue.number}}: {{issue.title}}\n{{issue.body}}\n");
    writeFileSync(
      join(dir, "alternate.yaml"),
      ["board: { owner: o, repo: r, projectNumber: 4 }", "engine: { driver: tick }", "worker: { promptFile: worker.md }", ""].join("\n"),
    );
    const forge = new FakeForge();
    const code = await runEngine(["node", "sapwood", "run", "--config", join(dir, "alternate.yaml"), "--once"], {
      forge,
      state,
      logger: silentLogger,
    });
    assert.equal(code, 0, "the named tick-driver config must win over the cwd's rounds config");
    assert.equal(state.eventsSince("1970-01-01T00:00:00.000Z", ["tick-error"]).length, 0);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run without --config preserves the cwd probe", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-run-config-probe-"));
  const previousCwd = process.cwd();
  const state = new State(":memory:");
  try {
    writeFileSync(join(dir, "sapwood.config.yaml"), "board: { owner: o, repo: r, projectNumber: 4 }\nengine: { driver: tick }\n");
    process.chdir(dir);
    assert.equal(await runEngine(["node", "sapwood", "run", "--once"], { forge: new FakeForge(), state, logger: silentLogger }), 0);
  } finally {
    process.chdir(previousCwd);
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run --dry-run --config loads the named config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-dry-run-config-"));
  const originalWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  try {
    writeFileSync(join(dir, "alternate.yaml"), "board: { owner: o, repo: r, projectNumber: 4 }\nworker: { budgetUsdSoft: 7.25 }\n");
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdout += chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    const code = await runDryRun({ forge: new FakeForge() }, join(dir, "alternate.yaml"));
    assert.equal(code, 0);
    assert.match(stdout, /\$7\.25 soft budget\/worker/);
  } finally {
    process.stdout.write = originalWrite;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run --config load errors occur before dispatch or state writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-run-config-errors-"));
  const state = new State(":memory:");
  class TrackingForge extends FakeForge {
    readyReads = 0;
    override async getReadyIssues(): Promise<Issue[]> {
      this.readyReads++;
      return [];
    }
  }
  const forge = new TrackingForge();
  try {
    await assert.rejects(
      runEngine(["node", "sapwood", "run", "--config", join(dir, "missing.yaml"), "--once"], {
        forge,
        state,
        logger: silentLogger,
      }),
      /ENOENT/,
    );
    writeFileSync(join(dir, "invalid.yaml"), "board: { owner: o }\n");
    await assert.rejects(
      runEngine(["node", "sapwood", "run", "--config", join(dir, "invalid.yaml"), "--once"], {
        forge,
        state,
        logger: silentLogger,
      }),
    );
    assert.equal(forge.readyReads, 0);
    assert.equal(state.activeWorkers().length, 0);
    assert.equal(state.getRound(1), undefined);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runEngine rejects malformed --config before any dispatch or state write", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  try {
    assert.equal(await runEngine(["node", "sapwood", "run", "--config", "--once"], { cfg: mkCfg(), forge, state }), 1);
    assert.deepEqual(forge.boardCalls, []);
    assert.equal(state.activeWorkers().length, 0);
    assert.equal(state.getRound(1), undefined);
  } finally {
    state.close();
  }
});

test("runEngine rejects --milestone --config x.yaml exactly as runCli does", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  try {
    const argv = ["node", "sapwood", "run", "--milestone", "--config", "x.yaml"];
    assert.equal(runCli(argv).code, 1);
    const { code, stderr } = await captureStderr(() => runEngine(argv, { cfg: mkCfg({ engine: { driver: "tick" } }), forge, state }));
    assert.equal(code, 1);
    assert.match(stderr, /--milestone requires a value/);
    assert.deepEqual(forge.boardCalls, []);
    assert.equal(state.activeWorkers().length, 0);
    assert.equal(state.getRound(1), undefined);
  } finally {
    state.close();
  }
});

test("runEngine's tests-only cfg override keeps precedence over --config", async () => {
  const state = new State(":memory:");
  try {
    assert.equal(
      await runEngine(["node", "sapwood", "run", "--config", "/does/not/exist.yaml", "--once"], {
        cfg: mkCfg({ engine: { driver: "tick" } }),
        forge: new FakeForge(),
        state,
        logger: silentLogger,
      }),
      0,
    );
  } finally {
    state.close();
  }
});

test("sapwood run: engine.driver: tick still reaches the M4 tick-driver escape hatch", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg({ engine: { driver: "tick" } });
  assert.equal(cfg.engine.driver, "tick");

  const logged: string[] = [];
  let observedTicks = 0;
  const overrides: EngineOverrides = {
    cfg,
    forge,
    state,
    logger: { log: (line) => logged.push(line) },
    onTick: () => observedTicks++,
  };
  // --once bounds the tick driver to a single tick so this test terminates quickly; the round
  // orchestrator has no such flag (see cli.ts's RUN_USAGE) — proof the tick path, not the round
  // path, is the one actually running here.
  const code = await runEngine(["node", "sapwood", "run", "--once"], overrides);
  assert.equal(code, 0);
  assert.equal(state.getRound(1), undefined, "the tick driver never opens a round — that's round.ts's own concept");
  assert.ok(logged.some((line) => line.startsWith("[sapwood:run] startup logPath=")));
  assert.ok(logged.some((line) => line.startsWith("[sapwood:tick] ")));
  assert.ok(logged.some((line) => line.startsWith("[sapwood:run] stopped after 1 tick(s)")));
  assert.ok(logged.every((line) => /^\[sapwood:[^\]]+\]/.test(line)));
  assert.equal(observedTicks, 1, "logger tick summaries compose with the caller's existing onTick hook");
});
