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
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { type EngineOverrides, runCli, runDryRun, runEngine, runStatus, tickOnlyFlagError } from "../cli.js";
import { ConfigSchema, configHash, dashboardConfigSubset, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus, StartupReconcileData } from "../forge/forge.js";
import type { LabelSpec } from "../forge/labels.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import { WorkerSupervisor } from "../roles/worker.js";
import type { EventKind } from "../state/event-kinds/index.js";
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

// #784: this file drives `runEngine` — the ONLY entrypoint the new hard error fires from — so
// the shared fixture builder, not each of this file's ~40 call sites, is where the reviewer.mode:
// engine-agent (this file's own default, unset) + ci.requiredChecks pairing gets a non-empty
// value; no test here exercises CI-evidence gating itself, so an arbitrary check name is inert.
const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    goal: { file: DEFAULT_TEST_GOAL_FILE },
    ci: { requiredChecks: [{ name: "test" }] },
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
class FakeForge extends UnstubbedForge implements IForge {
  planReviewCandidates: Issue[] = [];
  issueLabels: Record<number, string[]> = {};
  issueComments: Record<number, { login: string; createdAt: string; body: string }[]> = {};
  unplaced = { issues: [] as number[], skipped: 0 };
  absentIssues: number[] = [];
  absentElsewhere = 0;
  boardCalls: string[] = [];
  reconcileData: StartupReconcileData = { placements: [], openPrs: [] };
  reconcileReads = 0;
  reconcileError: Error | null = null;

  ensureRepoLabelsCalls: LabelSpec[][] = [];
  labelWriteError: Error | null = null;
  override async ensureRepoLabels(specs: readonly LabelSpec[]): Promise<string[]> {
    this.ensureRepoLabelsCalls.push([...specs]);
    if (this.labelWriteError) throw this.labelWriteError;
    return specs.filter((spec) => spec.name === "sapwood:round:pool").map((spec) => spec.name);
  }
  override async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  override async listUnplacedIssues() {
    this.boardCalls.push("list-unplaced");
    return this.unplaced;
  }
  override async listIssuesAbsentFromBoard() {
    this.boardCalls.push("list-absent");
    return { unplaced: this.absentIssues, elsewhere: this.absentElsewhere };
  }
  override async readStartupReconcileData() {
    this.reconcileReads++;
    if (this.reconcileError) throw this.reconcileError;
    return this.reconcileData;
  }
  override async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  override async getPoolEligibleIssues(): Promise<Issue[]> {
    return [];
  }
  override async claimIssue(): Promise<void> {}
  override async setBoardStatus(issue: number, status: Parameters<IForge["setBoardStatus"]>[1]): Promise<void> {
    this.boardCalls.push(`set-${issue}-${status}`);
  }
  override async addSubIssue(): Promise<void> {
    throw new Error("FakeForge.addSubIssue is not used by this test");
  }
  override async getSubIssues() {
    return [];
  }
  override async addLabel(n: number, l: string): Promise<void> {
    this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l];
  }
  override async removeLabel(n: number, l: string): Promise<void> {
    this.issueLabels[n] = (this.issueLabels[n] ?? []).filter((x) => x !== l);
  }
  override async addPRLabel(): Promise<void> {}
  override async openPR(): Promise<number> {
    return 1;
  }
  override async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  override async mergePR(): Promise<void> {}
  override async addPRComment(): Promise<void> {}
  override async addIssueComment(): Promise<void> {}
  override async getIssueBody(): Promise<string> {
    return "";
  }
  updateIssueBodyCalls: Array<[number, string]> = [];
  override async updateIssueBody(issue: number, body: string): Promise<void> {
    this.updateIssueBodyCalls.push([issue, body]);
  }
  override async getPRReviewData(): Promise<PRReviewData> {
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
  override async getPRDiff(): Promise<string> {
    return "";
  }
  override async getPRChangedFiles() {
    return { files: [], complete: true };
  }
  override async getCommitsSince(): Promise<CommitInfo[]> {
    return [];
  }
  override async branchExists(): Promise<boolean> {
    return false;
  }
  override async countOpenIssuesInMilestone(): Promise<number> {
    return 0;
  }
  override async listMilestoneTitles(): Promise<string[]> {
    return [];
  }
  override async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return this.planReviewCandidates;
  }
  override async getIssueLabels(issue: number): Promise<string[]> {
    return this.issueLabels[issue] ?? [];
  }
  override async getIssueComments(issue: number) {
    return this.issueComments[issue] ?? [];
  }
  override async createIssue(): Promise<number> {
    return 0;
  }
  override async listOpenIssueNumbers(): Promise<number[]> {
    return [];
  }
  override async listOpenIssues(): Promise<Issue[]> {
    return [];
  }
  override async getIssuesNeedingPlanTriage(): Promise<Issue[]> {
    return [];
  }
}

test("#379 sapwood run: startup provisions every workflow label the resolved config names — a repo missing round:pool gets it created, and the run proceeds", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: silentLogger,
    });
    assert.equal(code, 0);
    assert.equal(forge.ensureRepoLabelsCalls.length, 1, "one startup reconcile pass, before any dispatch");
    const names = new Set(forge.ensureRepoLabelsCalls[0]!.map((spec) => spec.name));
    for (const name of ["sapwood:round:pool", "sapwood:split", "sapwood:decomposed", "sapwood:hold"]) {
      assert.ok(names.has(name), `${name} is provisioned at startup`);
    }
    const events = state.eventsSince("1970-01-01T00:00:00.000Z", ["labels-reconciled"]);
    assert.deepEqual(
      events.map((e) => e.payload),
      [{ created: ["sapwood:round:pool"] }],
    );
  } finally {
    state.close();
  }
});

test("#379 sapwood run: a DENIED label write is best-effort — logged, no event, startup continues to a normal run", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  forge.labelWriteError = new Error("HTTP 403: Resource not accessible");
  const logged: string[] = [];
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: { log: (line) => logged.push(line) },
    });
    assert.equal(code, 0, "a label-provisioning failure never blocks the engine");
    assert.deepEqual(state.eventsSince("1970-01-01T00:00:00.000Z", ["labels-reconciled"]), []);
    assert.ok(logged.some((line) => /403/.test(line)));
  } finally {
    state.close();
  }
});

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
    assert.deepEqual(forge.boardCalls, ["list-unplaced", "list-absent"]);
    assert.equal(state.eventsSince("1970-01-01T00:00:00.000Z", ["orphan-detected"]).length, 2);
  } finally {
    state.close();
  }
});

test("#633: the branch-protection detector is invoked exactly once per engine start on the tick driver path", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  let calls = 0;
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: silentLogger,
      checkBranchProtection: async () => {
        calls++;
        return false;
      },
    });
    assert.equal(code, 0);
    assert.equal(calls, 1);
  } finally {
    state.close();
  }
});

test("#633: the branch-protection detector is invoked exactly once per engine start on the rounds driver path", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  let calls = 0;
  try {
    const code = await runEngine(["node", "sapwood", "run"], {
      cfg: mkCfg(), // engine.driver unset -> defaults to "rounds"
      forge,
      state,
      logger: silentLogger,
      sleep: async () => {},
      // Same immediate-stop shape as the #407 terminal-table signal test (this file, "a graceful
      // signal stop appends run-ended {stoppedBy: signal}"): the signal arrives before the first
      // round opens, so the loop winds down without ever dispatching — this only needs to prove
      // the startup detector fired, not drive a real round.
      registerSignals: (requestStop) => {
        requestStop();
        return () => {};
      },
      checkBranchProtection: async () => {
        calls++;
        return false;
      },
    });
    assert.equal(code, 0);
    assert.equal(calls, 1);
  } finally {
    state.close();
  }
});

// #799: the claude-version startup check, wired through the SAME two production entry points
// (`runTickEngine`/`runRoundsEngine`) as the #633 branch-protection detector above — same
// production-only-when-both-unset seam shape (EngineOverrides.claudeVersionProbe), so a wiring
// test can observe/replace the check's OUTCOME without ever spawning a real `claude` binary.
test("#799: the claude-version startup check runs after run-started on the tick driver path, and a below-floor arm never gates dispatch of a ready issue", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-claude-version-wiring-"));
  const previousCwd = process.cwd();
  const previousBin = process.env.CLAUDE_BIN;
  const state = new State(":memory:");
  class ReadyForge extends FakeForge {
    claimCalls = 0;
    override async getReadyIssues(): Promise<Issue[]> {
      return [{ number: 9, title: "ready work", labels: [] }];
    }
    override async claimIssue(): Promise<void> {
      this.claimCalls++;
    }
    override async getAuthenticatedActor(): Promise<string | null> {
      return "sapwood-bot";
    }
    override async getDefaultBranchChecks(): Promise<{ branch: string; headOid: string; checks: never[]; total: number }> {
      return { branch: "main", headOid: "deadbeef", checks: [], total: 0 };
    }
  }
  const forge = new ReadyForge();
  try {
    // A real stub `claude` binary (zero token, matches this file's own FAST_STUB convention) —
    // set via CLAUDE_BIN so a real worker dispatch this test's ReadyForge triggers has something
    // safe to spawn instead of ever touching a real `claude` on PATH. guard.mode: "soft" skips
    // the compiled-guard-hook-file existence check dispatch() otherwise fail-closes on outside a
    // real build. chdir into the tmp dir so WorkerSupervisor's default stateDir (cwd-anchored)
    // writes nowhere near the real checkout.
    process.env.CLAUDE_BIN = mkStub(dir, FAST_STUB);
    process.chdir(dir);
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" }, guard: { mode: "soft" } }),
      forge,
      state,
      logger: silentLogger,
      claudeVersionProbe: async () => ({ ok: true, stdout: "1.0.0" }), // below MIN_CLAUDE_CLI_VERSION
    });
    assert.equal(code, 0, "a below-floor CLI never gates startup or dispatch (AC6)");
    const kinds = state.eventsAfterId(0, ["run-started", "claude-cli-version-checked"]).map((e) => e.kind);
    assert.deepEqual(kinds, ["run-started", "claude-cli-version-checked"], "the check runs strictly after run-started (AC3)");
    assert.equal(forge.claimCalls, 1, "dispatch of the ready issue proceeded normally despite the below-floor arm (AC6)");
    // #799 gate② P1 #2 (sol-high round 1 + round 2): dispatch() is fire-and-forget — it returns
    // the moment the child is SPAWNED, not once its terminal sentinel write has landed
    // (worker.test.ts's own "dispatch -> stub claude runs -> .done sentinel" test polls for
    // exactly this same reason). `runEngine()` resolving therefore does NOT prove the spawned
    // lane's onExit finalize has finished writing its sentinel file — sol-high round 1
    // reproduced a REAL flake from this: the full suite ended `4801 pass / 1 fail` on an ENOENT
    // writing `lane-9-*.handoff.json.tmp` because this test's own `rmSync` below raced that
    // still-in-flight write.
    //
    // Round 1's fix polled but silently fell through on exhaustion — sol-high round 2's
    // discriminating mutation (forcing the loop's own `settled` check to always read `false`)
    // still PASSED after burning the full ~4s poll budget, because nothing downstream ever
    // consulted whether the condition was actually observed; teardown proceeded regardless. That
    // is a timing assumption wearing a poll's clothing, not an enforced wait. Fixed: track
    // whether quiescence was ACTUALLY observed (`quiesced`) and assert it explicitly — an
    // exhausted, unsatisfied poll now FAILS the test here, before `finally`'s teardown ever runs,
    // instead of silently proceeding into the exact race this poll exists to prevent. The poll
    // itself stays bounded and condition-based (never a blind sleep, docs/timing-dependent-
    // tests-ban) — only the "what happens when it's never satisfied" behavior changed.
    const stateDir = join(dir, ".sapwood", "sessions", "state");
    let quiesced = false;
    for (let i = 0; i < 200; i++) {
      const entries = existsSync(stateDir) ? readdirSync(stateDir) : [];
      const settled = entries.some((f) => /\.(done|failed|handoff)\.json$/.test(f));
      const inFlight = entries.some((f) => f.endsWith(".tmp"));
      if (settled && !inFlight) {
        quiesced = true;
        break;
      }
      await sleep(20);
    }
    assert.ok(
      quiesced,
      "the dispatched lane's async finalize (spawn -> stdio close -> terminal sentinel write) never " +
        "settled within the bounded poll — proceeding to state.close()/rmSync here would race a still-" +
        "in-flight write, the exact flake sol-high's gate② review reproduced; failing HERE instead of " +
        "silently falling through into that race",
    );
  } finally {
    process.chdir(previousCwd);
    if (previousBin === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = previousBin;
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#799: the claude-version startup check is invoked exactly once per engine start on the rounds driver path, after run-started", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  let calls = 0;
  try {
    const code = await runEngine(["node", "sapwood", "run"], {
      cfg: mkCfg(), // engine.driver unset -> defaults to "rounds"
      forge,
      state,
      logger: silentLogger,
      sleep: async () => {},
      // Same immediate-stop shape as the #633 rounds wiring test above — proves the startup
      // detector fired, not a real round.
      registerSignals: (requestStop) => {
        requestStop();
        return () => {};
      },
      claudeVersionProbe: async () => {
        calls++;
        return { ok: true, stdout: "9.9.9" };
      },
    });
    assert.equal(code, 0);
    assert.equal(calls, 1);
    const kinds = state.eventsAfterId(0, ["run-started", "claude-cli-version-checked"]).map((e) => e.kind);
    assert.deepEqual(kinds, ["run-started", "claude-cli-version-checked"]);
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
    // #415 review finding 3: the widened IForge wasn't reflected in this suite's FakeForge, so
    // a broken production call site to listIssuesAbsentFromBoard would have silently exercised
    // only the try/catch failure path (tsconfig excludes *.test.ts from typechecking). Set a
    // non-empty absent set so the assertion below proves the #412 report actually flows through
    // this REAL runEngine -> normalizeUnplacedBoardItems wiring, not just the unit-level fakes.
    forge.absentIssues = [999];
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
    // #415 review finding 3: proves the #412 absent-issue report reaches State through the REAL
    // production wiring (runEngine -> runRoundsEngine -> normalizeUnplacedBoardItems), not only
    // through the narrower Pick<IForge, ...> fakes in cli.test.ts.
    assert.ok(forge.boardCalls.includes("list-absent"), "the real startup path calls listIssuesAbsentFromBoard");
    assert.deepEqual(state.eventsSince("2020-01-01T00:00:00Z", ["board-gap-detected"]), [
      { kind: "board-gap-detected", payload: { total: 1, issues: [999], elsewhere: 0 } },
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

test("sapwood run (default driver, #253, #551): cfg.proxy.enabled: true wires a REAL default forge MCP proxy into the RoleRunner — a real role session actually gets --mcp-config + widened mcp__forge__* allowedTools", async () => {
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
      proxy: { enabled: true },
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

test("sapwood run (default driver, #551): cfg.proxy.enabled: false (explicit opt-out) -> the RoleRunner NEVER gets a defaultProxy — a real role session's argv carries no --mcp-config, no mcp__forge__* tool name, at all", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-rounds-proxy-disabled-"));
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
      proxy: { enabled: false },
    });
    assert.equal(cfg.proxy.enabled, false);

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
    assert.ok(!argvText.includes("--mcp-config"), "proxy.enabled: false: no session anywhere gets a proxy attached");
    // #444: bind to the AUTHORITATIVE signal — the value of the tool-list flags themselves —
    // rather than scanning the whole argv blob. The blob also carries the rendered PROMPT, and
    // po.md now names `mcp__forge__search_issues` in prose (telling the align session to search
    // before filing, when the tool is attached); prose naming a tool is not a grant of it, so a
    // substring scan over the prompt would fail this test for a non-violation.
    const args = argvText.split("\0");
    const toolListValues = args.filter((_arg, i) => args[i - 1] === "--allowedTools" || args[i - 1] === "--disallowedTools");
    assert.ok(toolListValues.length > 0, "expected the spawned session(s) to carry a tool-list flag at all");
    for (const value of toolListValues) {
      assert.ok(!value.includes("mcp__forge__"), "proxy.enabled: false: allowedTools is never widened");
    }
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
    // #379: the startup label reconcile is wired on the ROUNDS path too, not just the tick
    // driver's — it runs before the round loop (and, like every other startup pass, ahead of the
    // kill-switch check the first phase makes).
    assert.equal(forge.ensureRepoLabelsCalls.length, 1);
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

// #561: the preview's contract is "the REAL dispatch eligibility filter" — and under the rounds
// driver, round.milestone scoping IS part of real eligibility (round.ts wraps the forge in
// RoundScopedForge). An unscoped preview both invents spend for an issue the run would never
// dispatch AND hides the true in-scope pool.
const captureDryRun = async (over: Record<string, unknown>, ready: Issue[]): Promise<string> => {
  class ReadyForge extends FakeForge {
    override async getReadyIssues(): Promise<Issue[]> {
      return ready;
    }
  }
  const originalWrite = process.stdout.write.bind(process.stdout);
  let stdout = "";
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    stdout += chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  try {
    assert.equal(await runDryRun({ cfg: mkCfg(over), forge: new ReadyForge() }), 0);
  } finally {
    process.stdout.write = originalWrite;
  }
  return stdout;
};

const DRY_RUN_READY: Issue[] = [
  { number: 145, title: "out of scope", labels: [], milestone: "v0.2 — Dashboard (dogfood)" },
  { number: 561, title: "in scope", labels: [], milestone: "v0.2.2 — Dogfood hardening" },
  { number: 900, title: "no milestone", labels: [] },
];

test("sapwood run --dry-run: round.milestone scopes the preview — out-of-milestone Ready issues are neither counted nor priced (#561)", async () => {
  const stdout = await captureDryRun({ round: { milestone: "v0.2.2 — Dogfood hardening" } }, DRY_RUN_READY);
  assert.match(stdout, /1 ready issue\(s\), 1 dispatchable, 1 candidate\(s\)/);
  assert.match(stdout, /would dispatch: #561 in scope/);
  assert.doesNotMatch(stdout, /#145/, "an issue the scoped run would never dispatch must not appear as spend");
  assert.doesNotMatch(stdout, /#900/, "no milestone is out of scope too — same rule RoundScopedForge applies");
});

test("sapwood run --dry-run: round.milestone unset -> passthrough, every Ready issue previewed (#561)", async () => {
  const stdout = await captureDryRun({ lanes: { roundDispatchCap: 3 } }, DRY_RUN_READY);
  assert.match(stdout, /3 ready issue\(s\), 3 dispatchable, 3 candidate\(s\)/);
  for (const n of [145, 561, 900]) assert.match(stdout, new RegExp(`would dispatch: #${n}`));
});

test("sapwood run --config loads the named config and resolves worker.promptFile against that config's directory", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-run-config-"));
  const state = new State(":memory:");
  try {
    writeFileSync(join(dir, "worker.md"), "Implement issue #{{issue.number}}: {{issue.title}}\n{{issue.body}}\n");
    writeFileSync(
      join(dir, "alternate.yaml"),
      [
        "board: { owner: o, repo: r, projectNumber: 4 }",
        "engine: { driver: tick }",
        "worker: { promptFile: worker.md }",
        "ci: { requiredChecks: [{ name: test }] }",
        "",
      ].join("\n"),
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
    writeFileSync(
      join(dir, "sapwood.config.yaml"),
      "board: { owner: o, repo: r, projectNumber: 4 }\nengine: { driver: tick }\nci: { requiredChecks: [{ name: test }] }\n",
    );
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
    // #1182: a config load failure renders as `validate`'s one-line presentation (exit 1, no
    // stack trace) via captureStderr's {code, stderr}, not a thrown rejection.
    const missing = await captureStderr(() =>
      runEngine(["node", "sapwood", "run", "--config", join(dir, "missing.yaml"), "--once"], {
        forge,
        state,
        logger: silentLogger,
      }),
    );
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^sapwood run: ENOENT/);
    writeFileSync(join(dir, "invalid.yaml"), "board: { owner: o }\n");
    const invalid = await captureStderr(() =>
      runEngine(["node", "sapwood", "run", "--config", join(dir, "invalid.yaml"), "--once"], {
        forge,
        state,
        logger: silentLogger,
      }),
    );
    assert.equal(invalid.code, 1);
    assert.match(invalid.stderr, /^sapwood run: invalid config:/);
    assert.equal(forge.readyReads, 0);
    assert.equal(state.activeWorkers().length, 0);
    assert.equal(state.getRound(1), undefined);
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// #784 Tier B: startup smoke — `sapwood run` refuses the engine-agent + empty ci.requiredChecks
// foot-gun at the real CLI boundary (a fixture file loaded through `--config`, never the
// committed sapwood.config.yaml — that file's own fix is the issue's human-owned remainder), and
// `sapwood status` against the SAME fixture keeps working: the regression test for the refusal
// staying scoped to `run` rather than the loader (`loadConfig`/`parseConfig` still only warn).
test("#784: sapwood run --config <fixture reproducing engine-agent + empty ci.requiredChecks> refuses at startup — ZERO dispatch; sapwood status --config <same fixture> still succeeds", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-784-smoke-"));
  const state = new State(":memory:");
  try {
    // Both offending values are DEFAULTED, not written — the shape #784 was filed over (this
    // repo's own committed config sets neither key explicitly either).
    writeFileSync(join(dir, "footgun.yaml"), "board: { owner: o, repo: r, projectNumber: 4 }\n");
    const forge = new FakeForge();
    const { code, stderr } = await captureStderr(() =>
      runEngine(["node", "sapwood", "run", "--config", join(dir, "footgun.yaml")], { forge, state, logger: silentLogger }),
    );
    assert.equal(code, 1);
    assert.deepEqual(forge.boardCalls, [], "refused before any dispatch or forge access");
    assert.match(stderr, /reviewer\.mode is "engine-agent"/);
    assert.match(stderr, /ci\.requiredChecks is empty/);

    const status = runStatus(["node", "sapwood", "status", join(dir, "sapwood.sqlite"), "--config", join(dir, "footgun.yaml")]);
    assert.equal(status.code, 0, "the loader still parses this combination fine — only `run` refuses");
    assert.match(status.stdout, /no state DB/);
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

// #1182: the try around runEngine's config resolution must wrap ONLY the load — a real bug in
// applyMilestoneOverride/normalizeLoggingPath (which run AFTER the load, on an already-valid
// cfg) must still propagate as a rejection, never get misreported as a config-load refusal.
// `logging` is defined as a throwing getter so normalizeLoggingPath's own `cfg.logging.path`
// read (not the load itself) is where the throw happens.
test("runEngine: a throw AFTER config load (in normalizeLoggingPath/applyMilestoneOverride) still rejects — never swallowed into the config-load one-line refusal (#1182)", async () => {
  const state = new State(":memory:");
  const cfg = mkCfg({ engine: { driver: "tick" } });
  Object.defineProperty(cfg, "logging", {
    get(): never {
      throw new Error("boom-after-load");
    },
  });
  try {
    await assert.rejects(
      runEngine(["node", "sapwood", "run", "--once"], { cfg, forge: new FakeForge(), state, logger: silentLogger }),
      /boom-after-load/,
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

// ── #668: controlled-exit child reaping — BOTH cli.ts run paths must reap every child their own
// WorkerSupervisor still tracks, on normal completion AND when the run path throws. worker.ts's
// own test suite covers reapChildren's escalation mechanics (fake children) and
// WorkerSupervisor.reapAll()'s real-subprocess adapter wiring exhaustively; these tests prove
// the missing half — that cli.ts's OWN two run paths (runTickEngine, runRoundsEngine) actually
// call it in their `finally`, against the REAL production WorkerSupervisor instance each path
// constructs internally (never exposed via EngineOverrides). Since neither path exposes that
// instance, WorkerSupervisor.prototype.reapAll is patched for the span of one test to inject a
// REAL, still-alive, detached child into the live instance's own lane map at the exact moment
// production code is about to reap it — proving the wiring without re-deriving the whole
// dispatch/worktree/git pipeline (already covered elsewhere).
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const waitForDead = async (pid: number, timeoutMs = 10_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`hang guard (${timeoutMs}ms): pid ${pid} never died`);
    await sleep(20);
  }
};
/** Spawns a real, detached, cooperative (`trap 'exit 0' TERM`) child and waits for its own
 *  ready marker before returning — the same handshake worker.test.ts's longRunningStub uses, so
 *  the reap below never races the trap's own installation. */
const spawnCooperativeChild = async (dir: string): Promise<{ child: ReturnType<typeof spawn>; pid: number }> => {
  const ready = join(dir, `reap-ready-${Math.random().toString(36).slice(2)}`);
  const child = spawn("bash", ["-c", `trap 'exit 0' TERM\ntouch '${ready}'\nfor _ in $(seq 1 600); do sleep 1; done`], {
    detached: true,
    stdio: "ignore",
  });
  await new Promise<void>((res, reject) => {
    child.once("spawn", () => res());
    child.once("error", reject);
  });
  const deadline = Date.now() + 10_000;
  while (!existsSync(ready)) {
    if (Date.now() > deadline) throw new Error("hang guard (10000ms): cooperative stub never installed its TERM trap");
    await sleep(20);
  }
  return { child, pid: child.pid! };
};
/** Patches WorkerSupervisor.prototype.reapAll (for the span of one test) to inject `child` into
 *  the REAL instance's own private lane map the instant production code calls reapAll on it —
 *  the map is otherwise unreachable from outside cli.ts, which never exposes the supervisor it
 *  constructs. Returns the restore function; ALWAYS call it, success or throw. */
const injectLaneOnNextReapAll = (name: string, child: ReturnType<typeof spawn>): (() => void) => {
  const original = WorkerSupervisor.prototype.reapAll;
  let injected = false;
  WorkerSupervisor.prototype.reapAll = function (this: WorkerSupervisor, ...args: Parameters<typeof original>) {
    if (!injected) {
      injected = true;
      (this as unknown as { lanes: Map<string, unknown> }).lanes.set(name, {
        child,
        issue: 668,
        sessionId: "s",
        jsonlFd: -1,
        jsonlPath: "",
        hb: undefined,
        handoffRequested: false,
        reclaiming: false,
        startedMs: 0,
        timedOut: false,
        estimatedCostUsd: 0,
        estimateBaselineUsd: 0,
        jsonlLegOffset: 0,
        prompt: "",
      });
    }
    return original.apply(this, args);
  };
  return () => {
    WorkerSupervisor.prototype.reapAll = original;
  };
};

test("sapwood run (#668, tick driver): a supervisor-tracked child still alive when the run completes normally is reaped before runEngine returns — no orphan process group (AC1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-reap-tick-"));
  try {
    const { child, pid } = await spawnCooperativeChild(dir);
    const restore = injectLaneOnNextReapAll("lane-668-tick-ok", child);
    try {
      const code = await runEngine(["node", "sapwood", "run", "--once"], {
        cfg: mkCfg({ engine: { driver: "tick" } }),
        forge: new FakeForge(),
        state: new State(":memory:"),
        logger: silentLogger,
      });
      assert.equal(code, 0);
    } finally {
      restore();
    }
    await waitForDead(pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run (#668, tick driver): reap ALSO runs when the run path throws — the finally covers the catch's rethrow too, not just the success return (AC2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-reap-tick-throw-"));
  try {
    const { child, pid } = await spawnCooperativeChild(dir);
    const restore = injectLaneOnNextReapAll("lane-668-tick-throw", child);
    try {
      // Same fail-fast throw AFTER supervisor construction as the existing #407 terminal-table
      // test above (an unknown --milestone name) — assertStopMilestoneExists runs after both
      // run paths construct their WorkerSupervisor, so this reaches the finally with a real
      // still-live lane to reap, then rejects exactly as that test already proves.
      await assert.rejects(
        () =>
          runEngine(["node", "sapwood", "run", "--once", "--milestone", "M4"], {
            cfg: mkCfg({ engine: { driver: "tick" } }),
            forge: new FakeForge(),
            state: new State(":memory:"),
            logger: silentLogger,
          }),
        /no milestone titled "M4"/,
      );
    } finally {
      restore();
    }
    await waitForDead(pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run (#668, default/rounds driver): a supervisor-tracked child still alive when a round completes normally is reaped before runEngine returns — no orphan process group (AC1)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-reap-rounds-"));
  try {
    const { child, pid } = await spawnCooperativeChild(dir);
    const restore = injectLaneOnNextReapAll("lane-668-rounds-ok", child);
    try {
      const bin = mkStub(dir, FAST_STUB);
      let stop = (): void => {};
      const code = await runEngine(["node", "sapwood", "run"], {
        cfg: mkCfg({ roles: { retro: { enabled: false } }, round: { standby: { enabled: false } } }),
        forge: new FakeForge(),
        state: new State(":memory:"),
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
      });
      assert.equal(code, 0);
    } finally {
      restore();
    }
    await waitForDead(pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run (#668, default/rounds driver): reap ALSO runs when the run path throws (AC2)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-reap-rounds-throw-"));
  try {
    const { child, pid } = await spawnCooperativeChild(dir);
    const restore = injectLaneOnNextReapAll("lane-668-rounds-throw", child);
    try {
      class NamedMilestoneForge extends FakeForge {
        override async listMilestoneTitles(): Promise<string[]> {
          return ["M4 — UX surface + CLI"];
        }
      }
      await assert.rejects(
        () =>
          runEngine(["node", "sapwood", "run", "--milestone", "M4"], {
            cfg: mkCfg({ roles: { retro: { enabled: false } }, round: { standby: { enabled: false } } }),
            forge: new NamedMilestoneForge(),
            state: new State(":memory:"),
            logger: silentLogger,
          }),
        /no milestone titled "M4"/,
      );
    } finally {
      restore();
    }
    await waitForDead(pid);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #668 gate② finding [0] (2026-08-05): reapAll()'s own outcome must never be silently
// discarded — an unconfirmed death (confirmedDead: false, the orphan-process-group case AC4
// forbids) has to flip an otherwise-clean run's exit code, not vanish into a log line while the
// run reports success. A REAL unconfirmed death can't be manufactured with an actual subprocess
// (nothing in userspace outruns SIGKILL) — reapChildren's own "never dies" fake-child test
// already proves reapAll CAN return that outcome; these tests prove cli.ts's OWN handling of it
// by stubbing WorkerSupervisor.prototype.reapAll to return a fixed outcome array directly. ──────
const stubReapAllReturning = (
  outcomes: readonly { name: string; alreadyDead: boolean; escalated: boolean; confirmedDead: boolean }[],
): (() => void) => {
  const original = WorkerSupervisor.prototype.reapAll;
  WorkerSupervisor.prototype.reapAll = async () => [...outcomes];
  return () => {
    WorkerSupervisor.prototype.reapAll = original;
  };
};

test("sapwood run (#668 gate② finding [0], tick driver): an unconfirmed orphan flips an otherwise-clean run's exit code to 1 — never silently discarded", async () => {
  const restore = stubReapAllReturning([{ name: "lane-orphan", alreadyDead: false, escalated: true, confirmedDead: false }]);
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge: new FakeForge(),
      state: new State(":memory:"),
      logger: silentLogger,
    });
    assert.equal(code, 1, "an unconfirmed orphan must force a failed exit code even though the tick itself succeeded");
  } finally {
    restore();
  }
});

test("sapwood run (#668 gate② finding [0], tick driver): reverse — every outcome confirmedDead:true leaves the exit code exactly as runExitCode would have computed it (no false failure)", async () => {
  const restore = stubReapAllReturning([{ name: "lane-ok", alreadyDead: false, escalated: false, confirmedDead: true }]);
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge: new FakeForge(),
      state: new State(":memory:"),
      logger: silentLogger,
    });
    assert.equal(code, 0, "a fully-confirmed reap must not itself fail an otherwise-clean run");
  } finally {
    restore();
  }
});

test("sapwood run (#668 gate② finding [0], default/rounds driver): an unconfirmed orphan flips an otherwise-clean run's exit code to 1 — never silently discarded", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-reap-orphan-rounds-"));
  const restore = stubReapAllReturning([{ name: "lane-orphan", alreadyDead: false, escalated: true, confirmedDead: false }]);
  try {
    const bin = mkStub(dir, FAST_STUB);
    let stop = (): void => {};
    const code = await runEngine(["node", "sapwood", "run"], {
      cfg: mkCfg({ roles: { retro: { enabled: false } }, round: { standby: { enabled: false } } }),
      forge: new FakeForge(),
      state: new State(":memory:"),
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
    });
    assert.equal(code, 1, "an unconfirmed orphan must force a failed exit code even though the round itself completed");
  } finally {
    restore();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #382 (F9): single-instance lock on the data dir, wired through runEngine — acquired before
// any board/forge access, released on the normal exit path. Pid liveness is either scripted
// (EngineOverrides.pidLiveness) or process.pid's own definitional liveness — never a real
// subprocess lifetime (repo rule).

test("sapwood run (#382): a LIVE holder's lock refuses startup — exit 1, message names pid + lock path, ZERO forge access, holder's lock untouched", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-lock-"));
  const state = new State(join(dir, "sapwood.sqlite"));
  const lockPath = state.instanceLockPath();
  assert.ok(lockPath !== null);
  // The holder pid is THIS test process — its liveness is a fact, probed by the REAL default
  // process.kill(pid, 0) path (no seam), deterministically.
  writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "holder", acquiredAt: "2026-07-31T00:00:00.000Z" }));
  const forge = new FakeForge();
  let forgeTouched = false;
  const trackingForge = new Proxy(forge, {
    get(target, prop, receiver) {
      forgeTouched = true;
      return Reflect.get(target, prop, receiver);
    },
  });
  try {
    const { code, stderr } = await captureStderr(() =>
      runEngine(["node", "sapwood", "run", "--once"], {
        cfg: mkCfg({ engine: { driver: "tick" } }),
        forge: trackingForge,
        state,
        logger: silentLogger,
      }),
    );
    assert.equal(code, 1);
    assert.match(stderr, new RegExp(`pid ${process.pid}`));
    assert.ok(stderr.includes(lockPath), "the refusal names the lock path");
    assert.match(stderr, /refusing to start/);
    assert.equal(forgeTouched, false, "refusal happens before ANY board/forge access — zero double-drive risk");
    const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
    assert.equal(holder.token, "holder", "the live holder's lock survives the refused start");
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run (#382 round 2, codex finding 3): a refused start performs ZERO DB writes — no sqlite file is created, no State is ever constructed", async () => {
  // No `state` override here on purpose: this drives the exact production path where runEngine
  // itself would construct the default State — the finding was that it did so (open + migrate
  // the shared DB) BEFORE lock arbitration. The default paths are cwd-relative, so the test
  // runs inside its own tmp cwd; node:test runs tests in this file sequentially, and the cwd is
  // restored in finally before any other test can observe it.
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-lock-nodb-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    mkdirSync(join(dir, ".sapwood"), { recursive: true });
    const lockPath = join(dir, ".sapwood", "sapwood.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "holder", acquiredAt: "2026-07-31T00:00:00.000Z" }));
    const { code, stderr } = await captureStderr(() =>
      runEngine(["node", "sapwood", "run", "--once"], {
        cfg: mkCfg({ engine: { driver: "tick" } }),
        forge: new FakeForge(),
        logger: silentLogger,
      }),
    );
    assert.equal(code, 1);
    assert.match(stderr, /refusing to start/);
    assert.equal(existsSync(join(dir, ".sapwood", "sapwood.sqlite")), false, "no DB file — the holder's data dir saw zero writes");
    const holder = JSON.parse(readFileSync(lockPath, "utf8")) as { token: string };
    assert.equal(holder.token, "holder", "the live holder's lock survives");
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// Snapshot every file under `root` as {relPath -> raw bytes}, so a before/after comparison can
// prove NOTHING changed — not just that one named file is absent, but that not a single byte
// anywhere in the tree was touched (a content-only check on one path can't rule out an
// unexpected write to a DIFFERENT path).
function snapshotDir(root: string): Map<string, Buffer> {
  const snapshot = new Map<string, Buffer>();
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? (entry as unknown as { path: string }).path;
    const abs = join(parent, entry.name);
    snapshot.set(abs.slice(root.length + 1), readFileSync(abs));
  }
  return snapshot;
}

// The "zero writes" guarantee (#382 round 2, codex finding 3) is against the holder's WHOLE
// directory, not just the DB: a refused engine must never even touch the idempotent root
// markers (.gitignore/cache/CACHEDIR.TAG), since ensureRuntimeRoot only runs AFTER a successful
// lock acquisition (cli.ts's runEngine), never before. This fixture starts from a root that has
// a LIVE lock but NO markers yet (the state a first-ever `sapwood run` against a repo where a
// peer engine just won the race would find) and proves the refused process leaves the directory
// listing and every file's bytes byte-for-byte identical — a weaker "no sqlite file" check could
// not catch a regression that stamped .gitignore/CACHEDIR.TAG ahead of the lock attempt.
test("sapwood run: a refused start performs ZERO filesystem writes against the holder's directory — no DB, no .gitignore, no CACHEDIR.TAG, nothing", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-lock-zerowrite-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    mkdirSync(join(dir, ".sapwood"), { recursive: true });
    const lockPath = join(dir, ".sapwood", "sapwood.lock");
    writeFileSync(lockPath, JSON.stringify({ pid: process.pid, token: "holder", acquiredAt: "2026-07-31T00:00:00.000Z" }));
    const before = snapshotDir(dir);
    const { code, stderr } = await captureStderr(() =>
      runEngine(["node", "sapwood", "run", "--once"], {
        cfg: mkCfg({ engine: { driver: "tick" } }),
        forge: new FakeForge(),
        logger: silentLogger,
      }),
    );
    assert.equal(code, 1);
    assert.match(stderr, /refusing to start/);
    const after = snapshotDir(dir);
    assert.deepEqual([...after.keys()].sort(), [...before.keys()].sort(), "no file was created or removed");
    for (const [relPath, beforeBytes] of before) {
      assert.ok(after.get(relPath)!.equals(beforeBytes), `${relPath} must be byte-for-byte unchanged`);
    }
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ensureRuntimeRoot must run before the FIRST write on every write-capable entry point, not
// just State's own constructor — a crash/refusal/control-only invocation could otherwise leave
// runtime files with no `.gitignore`/`cache/CACHEDIR.TAG`. This is the "fresh run" entry: NO
// `state`/`logger` override, so the REAL FileEngineLogger (writing under the schema default
// `.sapwood/logs/sapwood.log`) and a REAL `roles.skills.enabled: true` render (writing under
// `.sapwood/cache/generated/role-skills`, tagged by `.sapwood/cache/CACHEDIR.TAG`) both run for
// real, proving the single ensureRuntimeRoot call in runEngine (called immediately after winning
// the instance lock, strictly before either) actually lands before both of them.
test("sapwood run: a fresh run self-declares the runtime root before the log driver and an enabled skills-plugin render ever write under it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-run-root-declare-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    mkdirSync(join(dir, "docs"), { recursive: true });
    writeFileSync(
      join(dir, "docs", "security.md"),
      "# Security & trust model\n\n<!-- sapwood:skill:human-merge-only-paths:start -->\nfixture\n<!-- sapwood:skill:human-merge-only-paths:end -->\n\n<!-- sapwood:skill:ac-evidence-tiers:start -->\nfixture\n<!-- sapwood:skill:ac-evidence-tiers:end -->\n",
      "utf8",
    );
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" }, roles: { skills: { enabled: true } } }),
      forge: new FakeForge(),
    });
    assert.equal(code, 0);
    assert.equal(readFileSync(join(dir, ".sapwood", ".gitignore"), "utf8"), "*\n", "root self-declares");
    assert.match(
      readFileSync(join(dir, ".sapwood", "cache", "CACHEDIR.TAG"), "utf8"),
      /^Signature: 8a477f597d28d172789f06886806bc55\n/,
      "cache tier self-declares",
    );
    assert.ok(existsSync(join(dir, ".sapwood", "logs", "sapwood.log")), "the REAL file logger wrote under the already-stamped root");
    assert.ok(
      readdirSync(join(dir, ".sapwood", "cache", "generated", "role-skills")).length > 0,
      "the REAL enabled skills-plugin render wrote under the already-stamped cache tier",
    );
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run (#382): the lock is held for the whole run and released on normal shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-lock-"));
  const state = new State(join(dir, "sapwood.sqlite"));
  const lockPath = state.instanceLockPath();
  assert.ok(lockPath !== null);
  try {
    let lockedDuringTick = false;
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge: new FakeForge(),
      state,
      logger: silentLogger,
      onTick: () => {
        lockedDuringTick = existsSync(lockPath);
      },
    });
    assert.equal(code, 0);
    assert.equal(lockedDuringTick, true, "the lockfile exists while the engine ticks");
    assert.equal(existsSync(lockPath), false, "normal shutdown releases the lock");
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("sapwood run (#382): a stale lock from a dead pid is taken over — the run proceeds, emits instance-lock-taken-over, and releases on exit (crash+restart drill unaffected)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-lock-"));
  const state = new State(join(dir, "sapwood.sqlite"));
  const lockPath = state.instanceLockPath();
  assert.ok(lockPath !== null);
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "crashed", acquiredAt: "2026-07-30T00:00:00.000Z" }));
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge: new FakeForge(),
      state,
      logger: silentLogger,
      pidLiveness: () => false, // scripted: the recorded holder is dead
    });
    assert.equal(code, 0, "a crashed predecessor's lock never blocks the restart");
    const events = state.eventsAfterId(0, ["run-started", "instance-lock-taken-over"]);
    // #382 round 2 (codex finding 4): the takeover belongs to THIS run's replay group, so it
    // must land AFTER run-started — the authoritative grouping boundary (#206) — never before.
    assert.deepEqual(
      events.map((e) => e.kind),
      ["run-started", "instance-lock-taken-over"],
    );
    assert.deepEqual(events[1]!.payload, { lockPath, previousPid: 999999 });
    assert.equal(existsSync(lockPath), false, "the takeover's own lock is released on normal shutdown");
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #431 (owner amendment 1): the rapid-restart detector, wired through runEngine — the count
// includes this boot's own run-started, a trip parks autonomous dispatch via the existing park
// paradigm, and a clean start clears a stale episode. The birth window is steered by seeding
// real-clock run-started events moments before the run (well inside the 600s default window —
// no assertion depends on timing) — never by sleeping.

test("sapwood run (#431): a 5th start inside the window trips the detector — rapid-restart-detected AFTER run-started, a durable park, and ZERO dispatch of the ready issue", async () => {
  const state = new State(":memory:");
  class ReadyForge extends FakeForge {
    claimCalls = 0;
    override async getReadyIssues(): Promise<Issue[]> {
      return [{ number: 9, title: "ready work", labels: [] }];
    }
    override async claimIssue(): Promise<void> {
      this.claimCalls++;
    }
  }
  const forge = new ReadyForge();
  // Four prior births moments ago (a crash loop); this run's own appendRunStarted is the 5th.
  for (let i = 0; i < 4; i++) state.appendEvent("run-started", { configHash: "prior" });
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: silentLogger,
    });
    assert.equal(code, 0, "a trip parks dispatch; it never aborts startup (park, not a refusal mode)");
    const kinds = state.eventsAfterId(0, ["run-started", "rapid-restart-detected", "park-escalated"]).map((e) => e.kind);
    assert.deepEqual(
      kinds.slice(-3),
      ["run-started", "rapid-restart-detected", "park-escalated"],
      "detection lands inside this run's replay group",
    );
    assert.equal(state.isParked(), true, "the standard park gate is what blocks dispatch");
    assert.equal(forge.claimCalls, 0, "the ready issue was never claimed — zero autonomous dispatch under the park");
    const detected = state.eventsAfterId(0, ["rapid-restart-detected"]);
    assert.equal(detected.length, 1);
    const detectedPayload = detected[0]!.payload as { births: number; windowSec: number; maxBirths: number; enteredAt: string };
    assert.equal(detectedPayload.births, 5);
    assert.equal(detectedPayload.windowSec, 600);
    assert.equal(detectedPayload.maxBirths, 5);
    assert.equal(
      state.parkRow("rapid-restart")?.enteredAt,
      detectedPayload.enteredAt,
      "the row mirrors the LOG's minted identity (round 4)",
    );
  } finally {
    state.close();
  }
});

test("sapwood run (#431): a clean start (window drained) CLEARS a stale rapid-restart park and proceeds — the sanctioned-recovery path needs no manual state surgery", async () => {
  const state = new State(":memory:");
  // A faithful open episode: the detection event (round 4's LOG-authority dedup carrier) plus
  // its park-row mirror — what a real trip leaves behind.
  state.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5, enteredAt: "2026-07-30T00:00:00.000Z" });
  state.enterPark("rapid-restart", "old storm", null, "2026-07-30T00:00:00.000Z");
  const forge = new FakeForge();
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: silentLogger,
    });
    assert.equal(code, 0);
    assert.equal(state.isParked(), false, "the stale episode cleared at startup — only 1 birth in the window");
    const resumed = state.eventsAfterId(0, ["park-resumed"]);
    assert.equal(resumed.length, 1);
    assert.deepEqual(resumed[0]!.payload, {
      source: "rapid-restart",
      enteredAt: "2026-07-30T00:00:00.000Z",
      via: "restart-window-clear",
    });
  } finally {
    state.close();
  }
});

// ── #407 (item 1): the terminal-event coverage table — every controlled exit path appends
// exactly ONE `run-ended`, with the driver's own stoppedBy verbatim. The two paths that append
// none are structural (cli.ts's appendRunEnded doc): the watchdog exits via process.exit from
// its own timer (its terminal is `engine-stalled` — watchdog.test.ts's own territory), and a
// hard kill unwinds nothing at all — the ABSENCE is the crash record, which is precisely what
// the dashboard's latestRunTerminal reads it as. ─────────────────────────────────────────────

/** The one run-ended event this run wrote — asserting exactly-one is part of every row. */
function soleRunEnded(state: State): Record<string, unknown> {
  const ended = state.eventsAfterId(0, ["run-ended"]);
  assert.equal(ended.length, 1, "exactly one terminal event per run");
  const trail = state.eventsAfterId(0, ["run-started", "run-ended"]);
  assert.equal(trail[trail.length - 1]!.kind, "run-ended", "the terminal closes the run's own boundary — after run-started");
  return ended[0]!.payload as Record<string, unknown>;
}

test("#407 terminal table, rounds + signal: a graceful signal stop appends run-ended {stoppedBy: signal}", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  try {
    const code = await runEngine(["node", "sapwood", "run"], {
      cfg: mkCfg(),
      forge,
      state,
      logger: silentLogger,
      sleep: async () => {},
      // The signal arrives before the first round opens — the loop winds down immediately.
      registerSignals: (requestStop) => {
        requestStop();
        return () => {};
      },
    });
    assert.equal(code, 0);
    assert.deepEqual(soleRunEnded(state), { stoppedBy: "signal" });
  } finally {
    state.close();
  }
});

test("#407 terminal table, rounds + stop-condition: a completed milestone appends run-ended {stoppedBy: stop-condition, stopCondition: onMilestoneComplete}", async () => {
  const state = new State(":memory:");
  class NamedMilestoneForge extends FakeForge {
    override async listMilestoneTitles(): Promise<string[]> {
      return ["M4 — UX surface + CLI"];
    }
    override async countOpenIssuesInMilestone(): Promise<number> {
      return 0;
    }
  }
  const forge = new NamedMilestoneForge();
  try {
    const code = await runEngine(["node", "sapwood", "run", "--milestone", "M4 — UX surface + CLI"], {
      cfg: mkCfg(),
      forge,
      state,
      logger: silentLogger,
      sleep: async () => {},
      registerSignals: () => () => {},
    });
    assert.equal(code, 0);
    assert.deepEqual(soleRunEnded(state), { stoppedBy: "stop-condition", stopCondition: "onMilestoneComplete" });
  } finally {
    state.close();
  }
});

test("#407 terminal table, rounds + kill-switch: the KILL_SWITCH stop appends run-ended {stoppedBy: kill-switch} even as the run exits 1", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-rounds-terminal-kill-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const forge = new FakeForge();
    const code = await runEngine(["node", "sapwood", "run"], {
      cfg: mkCfg(),
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
    assert.equal(code, 1, "kill-switch stop is a non-zero exit — an operator must notice");
    assert.deepEqual(soleRunEnded(state), { stoppedBy: "kill-switch" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#407 terminal table, tick + --once: the single bounded tick appends run-ended {stoppedBy: once}", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: silentLogger,
    });
    assert.equal(code, 0);
    assert.deepEqual(soleRunEnded(state), { stoppedBy: "once" });
  } finally {
    state.close();
  }
});

test("#407 terminal table, tick + --until-idle: the natural idle exit appends run-ended {stoppedBy: idle}", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge(); // empty board: the first tick is already idle
  try {
    const code = await runEngine(["node", "sapwood", "run", "--until-idle"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: silentLogger,
    });
    assert.equal(code, 0);
    assert.deepEqual(soleRunEnded(state), { stoppedBy: "idle" });
  } finally {
    state.close();
  }
});

test("#407 terminal table, startup error AFTER the run boundary: a thrown startup pass appends run-ended {stoppedBy: error} and still rejects", async () => {
  const state = new State(":memory:");
  class NamedMilestoneForge extends FakeForge {
    override async listMilestoneTitles(): Promise<string[]> {
      return ["M4 — UX surface + CLI"];
    }
  }
  const forge = new NamedMilestoneForge();
  try {
    await assert.rejects(
      () => runEngine(["node", "sapwood", "run", "--milestone", "M4"], { cfg: mkCfg(), forge, state, logger: silentLogger }),
      /no milestone titled "M4"/,
    );
    const payload = soleRunEnded(state);
    assert.equal(payload.stoppedBy, "error");
    assert.match(String(payload.error), /no milestone titled "M4"/);
  } finally {
    state.close();
  }
});

// ── #407 (items 2+3): the stall lifecycle wired through the REAL runEngine startup path — the
// unit-level table lives in stall-breaker.test.ts; these prove cli.ts actually calls it,
// strictly after the run boundary. ───────────────────────────────────────────────────────────

test("sapwood run (#407): a restart after a stalled run appends engine-restart-after-stall AFTER run-started and proceeds normally (tick driver)", async () => {
  const state = new State(":memory:");
  // The previous run's trace: its boundary, then the watchdog's terminal.
  state.appendEvent("run-started", { configHash: "h" });
  state.appendEvent("engine-stalled", { windowMs: 600_000 });
  const forge = new FakeForge();
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: silentLogger,
    });
    assert.equal(code, 0, "startup stall-awareness never blocks the run");
    const trail = state.eventsAfterId(0, ["run-started", "engine-restart-after-stall"]).map((e) => e.kind);
    assert.deepEqual(
      trail,
      ["run-started", "run-started", "engine-restart-after-stall"],
      "the audit record lands inside THIS run's replay group",
    );
    assert.equal(state.isParked(), false, "one stall is a restart, not an escalation");
  } finally {
    state.close();
  }
});

test("sapwood run (#407): the Nth consecutive stalled run trips the breaker at startup — a durable consecutive-stalls park + local escalation, and ZERO dispatch of a ready issue", async () => {
  const state = new State(":memory:");
  for (let i = 0; i < 3; i++) {
    state.appendEvent("run-started", { configHash: "h" });
    state.appendEvent("engine-stalled", { windowMs: 600_000 });
  }
  const dispatched: number[] = [];
  class ReadyForge extends FakeForge {
    override async getReadyIssues(): Promise<Issue[]> {
      return [{ number: 41, title: "wedged forever", labels: [], body: "" } as unknown as Issue];
    }
    override async claimIssue(...args: [number?]): Promise<void> {
      dispatched.push(args[0] ?? -1);
    }
  }
  const forge = new ReadyForge();
  try {
    const code = await runEngine(["node", "sapwood", "run", "--once"], {
      cfg: mkCfg({ engine: { driver: "tick" } }),
      forge,
      state,
      logger: silentLogger,
    });
    assert.equal(code, 0, "the breaker parks dispatch; it does not abort the process");
    assert.equal(state.isParked(), true, "the consecutive-stalls park gates dispatch");
    assert.equal(state.eventsAfterId(0, ["consecutive-stalls-detected"]).length, 1);
    assert.equal(state.eventsAfterId(0, ["park-escalated"]).length, 1, "escalated through the existing needs-human park channel");
    assert.deepEqual(dispatched, [], "no worker was ever dispatched into the wedge");
  } finally {
    state.close();
  }
});

test("#407 terminal table (gate② P2), stale-lock startup failure: a throw in the takeover append — after run-started, before the drivers' body — still closes the boundary with run-ended {stoppedBy: error}", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-terminal-takeover-"));
  const state = new State(join(dir, "sapwood.sqlite"));
  const lockPath = state.instanceLockPath();
  assert.ok(lockPath !== null);
  writeFileSync(lockPath!, JSON.stringify({ pid: 999999, token: "crashed", acquiredAt: "2026-07-30T00:00:00.000Z" }));
  // The P2 window, reproduced exactly: the FIRST write after a successful run-started — the
  // stale-lock takeover event — throws. Before the fix that write sat outside the terminal
  // bracket, so the run exited through main()'s error handler with no terminal at all: a
  // recorded false crash. The bracket now opens immediately after run-started, so this exit is
  // a controlled failure with its run-ended pair.
  const throwing = new Proxy(state, {
    get(target, prop, receiver) {
      if (prop === "appendEvent") {
        return (kind: EventKind, payload: Record<string, unknown>) => {
          if (kind === "instance-lock-taken-over") throw new Error("takeover append exploded");
          return target.appendEvent(kind, payload);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  try {
    await assert.rejects(
      () =>
        runEngine(["node", "sapwood", "run", "--once"], {
          cfg: mkCfg({ engine: { driver: "tick" } }),
          forge: new FakeForge(),
          state: throwing as State,
          logger: silentLogger,
          pidLiveness: () => false, // scripted: the recorded holder is dead
        }),
      /takeover append exploded/,
    );
    const payload = soleRunEnded(state);
    assert.equal(payload.stoppedBy, "error");
    assert.match(String(payload.error), /takeover append exploded/);
    assert.equal(existsSync(lockPath!), false, "the lock still releases through runEngine's own finally");
  } finally {
    state.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
