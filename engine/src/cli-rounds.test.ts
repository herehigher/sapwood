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
import { test } from "node:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEngine, runDryRun, tickOnlyFlagError, type EngineOverrides } from "./cli.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import { State } from "./state.js";
import type { IForge, Issue, PRStatus, PRReviewData, CommitInfo } from "./forge.js";
import type { PeripheralPhase } from "./round.js";

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

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

  async detectOwnerKind(): Promise<"user"> { return "user"; }
  async getReadyIssues(): Promise<Issue[]> { return []; }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(n: number, l: string): Promise<void> { this.issueLabels[n] = [...(this.issueLabels[n] ?? []), l]; }
  async addPRLabel(): Promise<void> {}
  async openPR(): Promise<number> { return 1; }
  async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  async mergePR(): Promise<void> {}
  async addPRComment(): Promise<void> {}
  async addIssueComment(): Promise<void> {}
  async getIssueBody(): Promise<string> { return ""; }
  updateIssueBodyCalls: Array<[number, string]> = [];
  async updateIssueBody(issue: number, body: string): Promise<void> { this.updateIssueBodyCalls.push([issue, body]); }
  async getPRReviewData(): Promise<PRReviewData> {
    return {
      headOid: "x", author: "producer", updatedAt: "2026-01-01T00:00:00Z", isDraft: false,
      labels: [], state: "OPEN", reactions: [], reviews: [], unresolvedThreads: 0,
    };
  }
  async getPRDiff(): Promise<string> { return ""; }
  async getCommitsSince(): Promise<CommitInfo[]> { return []; }
  async branchExists(): Promise<boolean> { return false; }
  async countOpenIssuesInMilestone(): Promise<number> { return 0; }
  async listMilestoneTitles(): Promise<string[]> { return []; }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> { return this.planReviewCandidates; }
  async getIssueLabels(issue: number): Promise<string[]> { return this.issueLabels[issue] ?? []; }
  async getIssueComments(issue: number) { return this.issueComments[issue] ?? []; }
  async createIssue(): Promise<number> { return 0; }
  async listOpenIssueNumbers(): Promise<number[]> { return []; }
  async getIssuesNeedingPlanTriage(): Promise<Issue[]> { return []; }
}

test("sapwood run (default driver): runEngine reaches runRounds via createDefaultPeripherals wired to a REAL RoleRunner — dispatches real role sessions to the stub claude binary, and a graceful stop still closes the in-flight round", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-cli-rounds-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const state = new State(":memory:");
    const forge = new FakeForge();
    const cfg = mkCfg(); // engine.driver unset -> defaults to "rounds"
    assert.equal(cfg.engine.driver, "rounds");

    let stop = (): void => {};
    const overrides: EngineOverrides = {
      cfg, forge, state,
      roleRunnerDeps: {
        stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin: bin,
        heartbeatMs: 50, guardHookPath: mkHook(dir),
      },
      sleep: async () => {},
      registerSignals: (requestStop) => { stop = requestStop; return () => {}; },
      // Same graceful-stop-mid-round trigger as round-defaults.test.ts: fire right after the
      // FIRST phase completes — the round must still run every remaining phase (including
      // harvest) to close, proving the safety property survives the cli.ts wiring switch.
      onRoundPhase: (_roundId, phase: PeripheralPhase) => {
        if (phase === "aligning") stop();
      },
    };

    const code = await runEngine(["node", "sapwood", "run"], overrides);

    assert.equal(code, 0);
    const round = state.getRound(1)!;
    assert.equal(round.phase, "closed", "graceful stop still let the in-flight round finish (harvest included)");

    // Proof the round path reached a REAL RoleRunner (not a fake): the stub `claude` binary
    // actually ran, leaving real sentinel files behind for at least one role session.
    const sentinels = readdirSync(dir).filter((f) => f.endsWith(".done.json"));
    assert.ok(sentinels.length > 0, "expected at least one real role session to have run to completion");
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
      cfg, forge, state,
      roleRunnerDeps: {
        stateDir: join(dir, "roles"), worktreeRoot: join(dir, "worktrees"), claudeBin: bin,
        heartbeatMs: 50, guardHookPath: mkHook(dir),
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

// ── gate② P2 (#106 review): tick-only flags FAIL FAST under rounds, never silently ignored ──

test("tickOnlyFlagError: --once/--until-idle produce an actionable error; --dry-run and plain runs do not", () => {
  assert.equal(tickOnlyFlagError(["node", "sapwood", "run"]), null);
  assert.equal(tickOnlyFlagError(["node", "sapwood", "run", "--dry-run"]), null);
  assert.match(tickOnlyFlagError(["node", "sapwood", "run", "--once"])!, /--once only apply to the tick driver/);
  assert.match(tickOnlyFlagError(["node", "sapwood", "run", "--once"])!, /engine\.driver: tick/);
  assert.match(tickOnlyFlagError(["node", "sapwood", "run", "--once"])!, /--stop-after-issues/);
  assert.match(tickOnlyFlagError(["node", "sapwood", "run", "--until-idle"])!, /--until-idle only apply/);
  assert.match(
    tickOnlyFlagError(["node", "sapwood", "run", "--once", "--until-idle"])!,
    /--once\/--until-idle only apply/,
  );
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

    const { code, stderr } = await captureStderr(() =>
      runEngine(["node", "sapwood", "run", flag], { cfg, forge: trackingForge, state }),
    );

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
    () => runEngine(["node", "sapwood", "run", "--milestone", "M4"], { cfg, forge, state }),
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

  const code = await runEngine(
    ["node", "sapwood", "run", "--milestone", "M4 — UX surface + CLI"],
    { cfg, forge, state, sleep: async () => {}, registerSignals: () => () => {} },
  );

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

test("sapwood run: engine.driver: tick still reaches the M4 tick-driver escape hatch", async () => {
  const state = new State(":memory:");
  const forge = new FakeForge();
  const cfg = mkCfg({ engine: { driver: "tick" } });
  assert.equal(cfg.engine.driver, "tick");

  const overrides: EngineOverrides = { cfg, forge, state };
  // --once bounds the tick driver to a single tick so this test terminates quickly; the round
  // orchestrator has no such flag (see cli.ts's RUN_USAGE) — proof the tick path, not the round
  // path, is the one actually running here.
  const code = await runEngine(["node", "sapwood", "run", "--once"], overrides);
  assert.equal(code, 0);
  assert.equal(state.getRound(1), undefined, "the tick driver never opens a round — that's round.ts's own concept");
});
