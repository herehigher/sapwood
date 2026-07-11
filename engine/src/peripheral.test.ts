// peripheral.test.ts (#87): the role runner — a stub `claude` binary (zero token, same
// integration style as worker.test.ts) drives the real spawn/sentinel/timeout/cost-parse path.
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, chmodSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RoleRunner, ROLE_ALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS, PLAN_DRAFTER_DISALLOWED_TOOLS,
  PO_ALLOWED_TOOLS, PO_DISALLOWED_TOOLS, runSessionWithRetry,
  type RoleRunnerDeps, type RoleSessionOpts, type RoleSessionResult, type RetriedSession,
} from "./peripheral.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

const cfg: SapwoodConfig = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });

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
    cfg, stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin,
    heartbeatMs: 50, guardHookPath: mkHook(dir), ...over,
  });

test("run: stub claude exits 0 -> outcome done, cost/model usage parsed, running sentinel cleared", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
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

test("run: non-zero exit -> outcome failed, .failed sentinel", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\nexit 3\n`);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
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
      cfg: tcfg, stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin: bin,
      heartbeatMs: 100, guardHookPath: mkHook(dir),
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
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
    const a = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    const b = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    assert.notEqual(a.name, b.name);
    assert.ok(existsSync(join(dir, `${a.name}.done.json`)));
    assert.ok(existsSync(join(dir, `${b.name}.done.json`)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: guard hook missing in hard mode -> throws, refuses to spawn an unguarded session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, FAST_STUB);
    const runner = new RoleRunner({
      cfg, stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin: bin,
      guardHookPath: join(dir, "nonexistent-hook.js"),
    });
    await assert.rejects(
      () => runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" }),
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
      cfg: softCfg, stateDir: dir, worktreeRoot: join(dir, "worktrees"), claudeBin: bin,
      guardHookPath: join(dir, "nonexistent-hook.js"),
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    assert.equal(result.outcome, "done");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: argv scopes the session to issues-only writes — no code paths, no PR/review/merge capability, no --add-dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    const at = (flag: string): string => seen[seen.indexOf(flag) + 1] ?? "";
    assert.equal(at("--allowedTools"), ROLE_ALLOWED_TOOLS);
    assert.equal(at("--disallowedTools"), ROLE_DISALLOWED_TOOLS);
    assert.ok(!seen.includes("--add-dir"), "never mounts the engine's data dir");
    // No merge/review/PR capability anywhere in the tool-scoping strings (the acceptance
    // criterion: "generated settings for a peripheral session contain no merge/review
    // capability").
    for (const tools of [ROLE_ALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS]) {
      assert.ok(!/gh pr merge|gh pr review|gh pr ready/.test(tools) || tools === ROLE_DISALLOWED_TOOLS);
    }
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("gh pr"), "allowed tools carry no PR capability at all");
    assert.ok(!ROLE_ALLOWED_TOOLS.includes("git"), "allowed tools carry no git/code capability");
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(gh pr *)"), "PR namespace explicitly disallowed");
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Read") && ROLE_DISALLOWED_TOOLS.includes("Write"), "no file access");
    // Codex PR #99 P1: --body-file reads body text from a FILE — a repo-read bypass, denied
    // for both commands (best-effort pattern layer; see peripheral.ts's enforcement doc).
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(gh issue comment *--body-file*)"));
    assert.ok(ROLE_DISALLOWED_TOOLS.includes("Bash(gh issue edit *--body-file*)"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PLAN_DRAFTER_DISALLOWED_TOOLS: strict superset of the base denies, adding label mutation (plan-author ≠ plan-approver)", () => {
  assert.ok(PLAN_DRAFTER_DISALLOWED_TOOLS.startsWith(ROLE_DISALLOWED_TOOLS), "keeps every base deny");
  assert.ok(PLAN_DRAFTER_DISALLOWED_TOOLS.includes("Bash(gh issue edit *--add-label*)"));
  assert.ok(PLAN_DRAFTER_DISALLOWED_TOOLS.includes("Bash(gh issue edit *--remove-label*)"));
  // The base (reviewer) scope must NOT deny label mutation — applying plan:approved/needs-human
  // is the reviewer's legitimate job.
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
      roleId: "plan-drafter", prompt: "p", model: "sonnet", effort: "medium",
      disallowedTools: PLAN_DRAFTER_DISALLOWED_TOOLS,
    });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    assert.equal(seen[seen.indexOf("--disallowedTools") + 1], PLAN_DRAFTER_DISALLOWED_TOOLS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("PO_ALLOWED_TOOLS: strict superset of the base allows, adding issue creation (#89 goal decomposition) — no board-status/PR/code capability anywhere", () => {
  assert.ok(PO_ALLOWED_TOOLS.startsWith(ROLE_ALLOWED_TOOLS), "keeps every base allow");
  assert.ok(PO_ALLOWED_TOOLS.includes("Bash(gh issue create*)"));
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
  const escaped = inner.split("*").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*");
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

test("ROLE_DISALLOWED_TOOLS: legitimate role writes (`gh issue comment/edit --body`) still pass, including bodies that merely CONTAIN the substring \"-F\" without it being its own argv token", () => {
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

test("run: the PO's allowedTools + disallowedTools pair BOTH reach the argv (the align/triage session wiring)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(
      dir,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${join(dir, "args.seen")}"\necho '{"type":"result","total_cost_usd":0}'\nexit 0\n`,
    );
    const runner = mkRunner(dir, bin);
    await runner.run({
      roleId: "po-align", prompt: "p", model: "sonnet", effort: "medium",
      allowedTools: PO_ALLOWED_TOOLS, disallowedTools: PO_DISALLOWED_TOOLS,
    });
    const seen = readFileSync(join(dir, "args.seen"), "utf8").split("\n");
    assert.equal(seen[seen.indexOf("--allowedTools") + 1], PO_ALLOWED_TOOLS);
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
      roleId: "retro", prompt: "p", model: "sonnet", effort: "medium",
      allowedTools: widerScope, disallowedTools: "Bash(gh pr merge*)",
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
      cfg, stateDir: dir, worktreeRoot, claudeBin: bin, heartbeatMs: 50, guardHookPath: mkHook(dir),
    });
    const result = await runner.run({ roleId: "plan-reviewer", prompt: "p", model: "sonnet", effort: "medium" });
    assert.ok(!existsSync(join(worktreeRoot, result.name)), "worktree removed unconditionally after run()");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("run: spend baseline — costUsd is 0 when the stub emits no result line", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-role-"));
  try {
    const bin = mkStub(dir, `#!/usr/bin/env bash\necho 'no json here'\nexit 0\n`);
    const runner = mkRunner(dir, bin);
    const result = await runner.run({ roleId: "plan-drafter", prompt: "p", model: "sonnet", effort: "medium" });
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
  outcome: "done", costUsd: 0, modelUsage: [], exitCode: 0, name: "role-x-1", ...over,
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
  recordSpend(worker: string, issue: number, usd: number): void { this.spends.push([worker, issue, usd]); }
  appendEvent(kind: string, payload: Record<string, unknown>): void { this.events.push([kind, payload]); }
}

const mkOpts = (
  runner: FakeRunner, state: FakeState, isValid: RetriedSession["isValid"],
): RetriedSession => ({
  runner, state, session: { roleId: "test-role", prompt: "p", model: "sonnet", effort: "medium" },
  issue: 0, now: () => new Date("2026-07-11T00:00:00Z"),
  degradeEvent: "test-degraded",
  degradePayload: (result) => ({ attempts: 2, exitCode: result.exitCode }),
  degradeMessage: (result) => `test role degraded: ${result.outcome}`,
  ...(isValid !== undefined ? { isValid } : {}),
});

test("runSessionWithRetry + isValid: a valid \"done\" result on the FIRST attempt — no retry, no degrade", async () => {
  const runner = new FakeRunner([mkResult()]);
  const state = new FakeState();
  const result = await runSessionWithRetry(mkOpts(runner, state, () => true));
  assert.equal(runner.calls.length, 1);
  assert.equal(state.events.length, 0);
  assert.equal(result.outcome, "done");
});

test("runSessionWithRetry + isValid: \"done\" but invalid on attempt 1, valid on attempt 2 — exactly one retry, no degrade event", async () => {
  const runner = new FakeRunner([mkResult({ name: "role-x-1" }), mkResult({ name: "role-x-2" })]);
  const state = new FakeState();
  let calls = 0;
  const result = await runSessionWithRetry(mkOpts(runner, state, () => { calls++; return calls >= 2; }));
  assert.equal(runner.calls.length, 2, "invalid first attempt triggers exactly one retry");
  assert.equal(state.events.length, 0, "eventually-valid result never degrades");
  assert.equal(state.spends.length, 2, "spend is recorded for BOTH attempts regardless of validity");
  assert.equal(result.name, "role-x-2");
});

test("runSessionWithRetry + isValid: \"done\" but invalid on BOTH attempts — degrades exactly like a non-\"done\" outcome (event + message)", async () => {
  const runner = new FakeRunner([mkResult(), mkResult()]);
  const state = new FakeState();
  const result = await runSessionWithRetry(mkOpts(runner, state, () => false));
  assert.equal(runner.calls.length, 2);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0]![0], "test-degraded");
  assert.deepEqual(state.events[0]![1], { attempts: 2, exitCode: result.exitCode });
  assert.equal(result.outcome, "done"); // last attempt's raw result is still returned as-is
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

