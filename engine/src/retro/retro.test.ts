// retro.test.ts (#91): the `retro` peripheral's self-evolution role. Fakes the underlying role
// session (RoleRunner) directly — same "fake the collaborator, not the CLI" split as
// plan-review.test.ts/harvest.test.ts. Central acceptance criterion: retro proposals appear as
// branches/PRs only — no direct main/docs writes — asserted against the role's OWN write-scope
// constants (RETRO_ALLOWED_TOOLS/RETRO_DISALLOWED_TOOLS) and against how createRetroStub wires
// them into every session it dispatches.
//
// #111 PR-A: the digest-ASSEMBLY tests (bounded cap, empty round, event-kind filtering, per-item
// fetch-failure containment) live in retro-digest.test.ts, next to the module they test — this
// file keeps its original scope: the peripheral's OWN wiring (marker idempotence, write-scope
// grants, cadence, prompt-template rendering) with the digest as one more thing that wiring now
// produces and substitutes in.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import type { LaneProbe, Supervisor } from "../loop/conductor.js";
import { attachAttemptGuard, withHangGuard } from "../loop/hang-guard.test-support.js";
import { type PeripheralPhase, type PeripheralStub, type RoundDeps, runRounds } from "../loop/round.js";
import type { ContextManifest } from "../roles/context-manifest.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import { State } from "../state/state.js";
import {
  createRetroStub,
  defaultRetroPromptPath,
  gatherRetroFacts,
  isQuietRound,
  parseRetroScratch,
  RETRO_ALLOWED_TOOLS,
  RETRO_DISALLOWED_TOOLS,
  RETRO_SCRATCH_FILE,
  type RetroDeps,
  retroMarker,
} from "./retro.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

/** #961: most fixtures below only care about session-dispatch plumbing (allow/deny lists,
 *  scratch parsing, cadence, prompt rendering) and don't care WHY the session dispatches — they
 *  pre-date the quiet-round check and simply started a round with no events at all. A round with
 *  zero events is now a quiet round (`isQuietRound`) and would short-circuit before ever reaching
 *  the session, so those fixtures seed one `dispatched` event to keep the round non-quiet without
 *  otherwise touching the digest/fact counts a handful of OTHER fixtures assert on (a `dispatched`
 *  event carries neither the `retro` nor `pr-touched` tag). The quiet check itself is tested
 *  directly in the "#961 quiet round" section below. */
const seedDispatch = (state: State): void => {
  state.appendEvent("dispatched", { worker: "lane-seed", issue: 0 });
};

class ScriptedRunner {
  calls: RoleSessionOpts[] = [];
  private n = 0;
  private readonly script: RoleSessionResult[];
  constructor(...script: RoleSessionResult[]) {
    this.script = script;
  }
  async run(opts: RoleSessionOpts): Promise<RoleSessionResult> {
    this.calls.push(opts);
    const result = this.script[Math.min(this.n, this.script.length - 1)]!;
    this.n++;
    return result;
  }
}

// #111 PR-B: a "done" session must also carry a VALID scratch file (parseRetroScratch feeds
// runSessionWithRetry's isValid) — "none" is the explicit quiet-round content, so the many
// existing tests that only exercise the session-dispatch plumbing default to it. A result with
// NO scratchText at all is built as a literal where needed (a default parameter can't be
// bypassed by passing undefined explicitly).
const doneResult = (name: string, scratchText = "none"): RoleSessionResult => ({
  outcome: "done",
  costUsd: 0.03,
  modelUsage: [],
  exitCode: 0,
  name,
  scratchText,
});
const timeoutResult = (name: string): RoleSessionResult => ({
  outcome: "timeout",
  costUsd: 0.03,
  modelUsage: [],
  exitCode: null,
  name,
});

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

/** A structurally-valid ContextManifest for #236 persistence tests — `model` doubles as a tag so
 *  the persisted json is trivially distinguishable from another fixture's. Retro is the one role
 *  that legitimately holds write-capable tools, so its OWN dirtyBasis ("unknown-write-capable-
 *  session") is used here rather than the issues-only default — this fixture is not asserting
 *  RoleRunner.run()'s real derivation (peripheral.test.ts covers that), just standing in for
 *  "some real manifest object" at the state-persistence layer. */
const mkFakeManifest = (tag: string): ContextManifest => ({
  sources: [],
  probedPaths: [],
  knownUnprobed: "imports, ancestor dirs, managed policy",
  capturedPreSpawn: "2026-07-17T00:00:00Z",
  capturedPostExit: "2026-07-17T00:00:01Z",
  captureBasis: "init-observed",
  model: tag,
  modelSource: "requested-fallback",
  cliBin: "claude",
  cliVersion: null,
  toolInventoryHash: null,
  promptTemplateVersion: null,
  mcpTools: [],
  worktree: { path: "/wt", head: null, headResolution: "unresolved", dirty: true, dirtyBasis: "unknown-write-capable-session" },
  settingsHash: "hash",
  hookHash: null,
  toolUsage: [],
  readPaths: [],
  recordedAt: "2026-07-17T00:00:01Z",
});

/** #691: `runRounds` drives `round.ts:1161/1692/1726`'s production `for (;;)` loops with no bound
 *  of its own -- see `hang-guard.test-support.ts` (shared with
 *  driver.test.ts/round.test.ts/round-defaults.test.ts/harvest.test.ts -- ONE copy, not five) for
 *  why this needs BOTH `withHangGuard` and `attachAttemptGuard`. */
async function runRoundsGuarded(deps: RoundDeps): ReturnType<typeof runRounds> {
  const attemptGuardFired = attachAttemptGuard(deps);
  const result = await withHangGuard(
    runRounds(deps),
    45_000,
    "runRounds(deps) did not settle within 45000ms — a wedged production for(;;) loop (round.ts:1161/1692/1726), the class that caused the 2026-08-05 livelock (#691)",
  );
  const fired = attemptGuardFired();
  if (fired !== null) throw new Error(fired);
  return result;
}

// ── Write-scope: "proposals appear as branches/PRs only" ────────────────────────────────────

test("RETRO_ALLOWED_TOOLS: grants local git (proposal authorship) — never a merge/review/issue-mutation capability", () => {
  assert.ok(
    RETRO_ALLOWED_TOOLS.includes("Bash(git commit*)") && RETRO_ALLOWED_TOOLS.includes("Bash(git push*)"),
    "can commit + push a branch",
  );
  for (const forbidden of ["gh pr merge", "gh pr review", "gh pr ready", "gh issue edit", "gh issue comment", "gh api"]) {
    assert.ok(!RETRO_ALLOWED_TOOLS.includes(forbidden), `allowed tools must not grant ${forbidden}`);
  }
});

// ── #111: ALL gh grants are gone — reads via the digest (PR-A), writes via the engine (PR-B) ─

test("RETRO_ALLOWED_TOOLS: no gh entries AT ALL (#111 acceptance criterion) — reads come from the digest, PR creation is engine-side", () => {
  for (const removed of [
    "Bash(gh pr view*)",
    "Bash(gh pr list*)",
    "Bash(gh pr diff*)",
    "Bash(gh issue view*)",
    "Bash(gh issue list*)",
    "Bash(gh pr create*)",
  ]) {
    assert.ok(!RETRO_ALLOWED_TOOLS.includes(removed), `allowed tools must no longer grant ${removed}`);
  }
  const ghEntries = RETRO_ALLOWED_TOOLS.split(",").filter((t) => t.includes("gh "));
  assert.deepEqual(ghEntries, [], "zero gh entries of any kind remain");
});

test("RETRO_ALLOWED_TOOLS: local git introspection (branch/checkout/add/commit/push/diff/status/log) is unchanged — never GitHub browsing", () => {
  for (const kept of [
    "Bash(git branch*)",
    "Bash(git checkout*)",
    "Bash(git add*)",
    "Bash(git commit*)",
    "Bash(git push*)",
    "Bash(git diff*)",
    "Bash(git status*)",
    "Bash(git log*)",
  ]) {
    assert.ok(RETRO_ALLOWED_TOOLS.includes(kept), `allowed tools must still grant ${kept}`);
  }
});

test("RETRO_DISALLOWED_TOOLS: explicitly denies merge/review/ready, issue mutation, raw gh api, and a direct push to main/master", () => {
  for (const denied of ["gh pr merge", "gh pr review", "gh pr ready", "gh issue edit", "gh issue comment", "gh api"]) {
    assert.ok(RETRO_DISALLOWED_TOOLS.includes(denied), `disallowed tools must deny ${denied}`);
  }
  assert.ok(RETRO_DISALLOWED_TOOLS.includes("git push*main*"));
  assert.ok(RETRO_DISALLOWED_TOOLS.includes("git push*master*"));
  // #111 PR-B: with zero gh allows left, the gh denies (this one included) are regression
  // trip-wires — kept byte-identical, same stance as peripheral.ts's ROLE_DISALLOWED_TOOLS.
  assert.ok(RETRO_DISALLOWED_TOOLS.includes("Bash(gh pr create *--body-file*)"));
  assert.equal(
    RETRO_DISALLOWED_TOOLS,
    "NotebookEdit,Bash(git push*main*),Bash(git push*master*)," +
      "Bash(gh pr merge*),Bash(gh pr review*),Bash(gh pr ready*)," +
      "Bash(gh pr edit*),Bash(gh issue edit*),Bash(gh issue comment*),Bash(gh api*)," +
      "Bash(gh pr create *--body-file*),Agent,Task",
    "pinned regression string — a future edit here must be deliberate, not silent",
  );
  // #534: RETRO_DISALLOWED_TOOLS is an INDEPENDENT literal (not `= ROLE_DISALLOWED_TOOLS`, unlike
  // every other role's deny list), so peripheral.ts's Agent/Task addition does NOT reach retro
  // automatically — this constant needed its own, explicit append. Retro is the one peripheral
  // role holding a real Write/Edit/MultiEdit + Bash(git commit/push…) grant, so an unblocked
  // retro fan-out would be a fan-out of write-capable children, not read-only ones.
  for (const spawnTool of ["Agent", "Task"]) {
    assert.ok(RETRO_DISALLOWED_TOOLS.split(",").includes(spawnTool), `${spawnTool} explicitly denied — no subagent spawn`);
  }
  assert.ok(!RETRO_DISALLOWED_TOOLS.split(",").includes("Workflow"), "#534: no such tool in the probed CLI surface — not denied");
});

test("createRetroStub: every dispatched session carries RETRO_ALLOWED_TOOLS/RETRO_DISALLOWED_TOOLS — never the base issues-only scope", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(doneResult("role-retro-1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0]!;
  assert.equal(call.allowedTools, RETRO_ALLOWED_TOOLS);
  assert.equal(call.disallowedTools, RETRO_DISALLOWED_TOOLS);
  // #111 PR-B: the engine (not the session) chooses where the PR-proposal scratch file lives.
  assert.equal(call.scratchFile, RETRO_SCRATCH_FILE);
  state.close();
});

test("createRetroStub (#236): a done session's context manifest is persisted, keyed by (round, 'retro', 'retro', session name, attempt 1)", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const manifest = mkFakeManifest("retro-attempt");
  const runner = new ScriptedRunner({ ...doneResult("role-retro-1"), contextManifest: manifest });
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  const rows = state.listContextManifestsForRound(round.round_id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.phase, "retro");
  assert.equal(rows[0]?.role, "retro");
  assert.equal(rows[0]?.session, "role-retro-1");
  assert.equal(rows[0]?.attempt, 1);
  assert.deepEqual(JSON.parse(rows[0]?.json ?? "{}"), manifest);
  state.close();
});

// ── Idempotence + fact-gathering ─────────────────────────────────────────────────────────────

test("createRetroStub: marker present -> returns it unchanged, no session run (idempotence)", async () => {
  const state = new State(":memory:");
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: 3, phase: "retro", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("gatherRetroFacts: counts handoffs, drive-needs-human escalations, and ceiling escalations since round start only", async () => {
  const state = new State(":memory:");
  // #403 (F25), PR #430 gate② P2: no sleep needed any more. The round window is id-cursor-bounded
  // (state.start_event_id, the #123 mechanism), so "before round start" means a lower event id —
  // not an earlier wall-clock millisecond that a real sleep had to manufacture.
  state.appendEvent("handoff", { worker: "lane-x", issue: 99 }); // before round start
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("handoff", { worker: "lane-a", issue: 1 });
  state.appendEvent("handoff", { worker: "lane-b", issue: 2 });
  state.appendEvent("drive-needs-human", { worker: "lane-c", issue: 3, pr: 5, reason: "flaky" });
  state.appendEvent("ceiling-escalated", { worker: "lane-d", issue: 4, reasons: ["dailyBudgetUsd"] });
  const facts = gatherRetroFacts(state, round);
  assert.equal(facts.roundId, round.round_id);
  assert.equal(facts.handoffs, 2); // the pre-round-start handoff is excluded
  assert.equal(facts.needsHumanEscalations, 1);
  assert.equal(facts.ceilingEscalations, 1);
  state.close();
});

test("gatherRetroFacts (#403, F25): the round window is id-cursor-bounded — a round clock AHEAD of the machine clock still counts the round's own events", () => {
  const state = new State(":memory:");
  // The exact seeded-vs-wall-clock mismatch #403 exists to eliminate, in the one place it was
  // still load-bearing: `started_at` comes from the round's INJECTED clock while `appendEvent`
  // stamps the machine clock. Seed the round an hour ahead (a fixture with a seeded clock, or a
  // real host whose clock stepped backward mid-round) and a `ts >= started_at` read drops every
  // event below — the retro then reports a round in which nothing happened. DELIBERATE real-clock
  // read here: what matters is the OFFSET between the two clocks, not either absolute value.
  const roundClockAhead = new Date(Date.now() + 3_600_000).toISOString();
  const round = state.startRound(roundClockAhead);
  state.appendEvent("handoff", { worker: "lane-a", issue: 1 });
  state.appendEvent("drive-needs-human", { worker: "lane-c", issue: 3, pr: 5, reason: "flaky" });
  state.appendEvent("ceiling-escalated", { worker: "lane-d", issue: 4, reasons: ["dailyBudgetUsd"] });
  const facts = gatherRetroFacts(state, round);
  assert.equal(facts.handoffs, 1);
  assert.equal(facts.needsHumanEscalations, 1);
  assert.equal(facts.ceilingEscalations, 1);
  state.close();
});

// ── #961: a QUIET round (zero `retro`/`pr-touched`-tagged events, zero dispatched lanes) skips
// the session structurally — no runner call, no digest build, one durable skip event, phase
// still closes ───────────────────────────────────────────────────────────────────────────────

test("isQuietRound: true for a fresh round with no events in its window", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  assert.equal(await isQuietRound(new MinimalForge(), state, round), true);
  state.close();
});

test("isQuietRound: events BEFORE round start don't count — a round right after a busy one is still quiet", async () => {
  const state = new State(":memory:");
  state.appendEvent("handoff", { worker: "lane-x", issue: 99 }); // before round start
  state.appendEvent("dispatched", { worker: "lane-x", issue: 99 }); // before round start
  const round = state.startRound(new Date().toISOString());
  assert.equal(await isQuietRound(new MinimalForge(), state, round), true);
  state.close();
});

// ── #964's FOURTH signal: an own PR retro previously opened, checked ONLY when the three
// #961 signals above are silent (otherwise-quiet round, zero fresh material) ────────────────

test("isQuietRound (#964): a green, non-conflicting own PR with no changes-requested review is STILL quiet — the fourth signal adds no material", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 5, branch: "retro/x" }); // before round start — same as any prior-round PR
  const forge = new MinimalForge();
  forge.statuses.set(5, { number: 5, headOid: "aaa", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true, ciRed: false });
  assert.equal(await isQuietRound(forge, state, round), true);
  state.close();
});

test("isQuietRound (#964): a red own PR makes an otherwise-quiet round NOT quiet", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 5, branch: "retro/x" });
  const forge = new MinimalForge();
  forge.statuses.set(5, { number: 5, headOid: "aaa", state: "OPEN", mergeable: "MERGEABLE", ciGreen: false, ciRed: true });
  assert.equal(await isQuietRound(forge, state, round), false);
  state.close();
});

test("isQuietRound (#964): a CONFLICTING own PR is also actionable — not quiet", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 5, branch: "retro/x" });
  const forge = new MinimalForge();
  forge.statuses.set(5, { number: 5, headOid: "aaa", state: "OPEN", mergeable: "CONFLICTING", ciGreen: false });
  assert.equal(await isQuietRound(forge, state, round), false);
  state.close();
});

test("isQuietRound (#964): a CHANGES_REQUESTED review on an own PR is also actionable — not quiet", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 5, branch: "retro/x" });
  const forge = new MinimalForge();
  forge.statuses.set(5, { number: 5, headOid: "aaa", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true, ciRed: false });
  forge.reviews.set(5, {
    headOid: "aaa",
    author: "producer",
    updatedAt: "2026-01-01T00:00:00Z",
    isDraft: false,
    labels: [],
    state: "OPEN",
    reactions: [],
    unresolvedThreads: 1,
    reviews: [{ author: "codex", commitOid: "aaa", state: "CHANGES_REQUESTED" }],
  });
  assert.equal(await isQuietRound(forge, state, round), false);
  state.close();
});

test("isQuietRound (#964): a merged own PR is excluded entirely — no longer outstanding, no forge review-read needed", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 5, branch: "retro/x" });
  const forge = new MinimalForge();
  forge.statuses.set(5, { number: 5, headOid: "aaa", state: "MERGED", mergeable: "MERGEABLE", ciGreen: true });
  assert.equal(await isQuietRound(forge, state, round), true);
  state.close();
});

test("isQuietRound (#964): a forge status-read failure fails CLOSED — reads as actionable, not quiet (a wrong 'quiet' costs a missed repair)", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 5, branch: "retro/x" });
  const forge = new MinimalForge();
  forge.statusErrors.add(5);
  assert.equal(await isQuietRound(forge, state, round), false);
  state.close();
});

test("isQuietRound (#964): zero retro-pr-lifecycle events at all -> the fourth signal makes no forge call and adds nothing", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const forge = new MinimalForge();
  assert.equal(await isQuietRound(forge, state, round), true);
  assert.deepEqual(forge.statusCalls, []);
  state.close();
});

test("isQuietRound (#964): the fourth signal is checked ONLY when the three #961 signals are silent — an already-busy round never touches the forge", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("dispatched", { worker: "lane-a", issue: 1 }); // #961 signal 3 alone already makes this non-quiet
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 5, branch: "retro/x" });
  const forge = new MinimalForge();
  forge.statusErrors.add(5); // would flip the verdict if ever reached — it must not be
  assert.equal(await isQuietRound(forge, state, round), false);
  assert.deepEqual(forge.statusCalls, [], "short-circuited before the fourth signal's forge read");
  state.close();
});

test("createRetroStub (#961 AC1, red-first): a quiet round returns the marker WITHOUT calling the session runner or building the digest, and appends exactly one skip event; a re-run with the marker already set is a no-op", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(doneResult("s1"));
  const forge = new MinimalForge();
  // buildRetroDigest always touches getCommitsSince, even for an empty round (the "still renders
  // a digest" test above) — this throws if the quiet check fails to short-circuit BEFORE it.
  forge.getCommitsSince = (): Promise<CommitInfo[]> => {
    throw new Error("buildRetroDigest must never run for a quiet round");
  };
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  const { marker, ranSession } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(marker, retroMarker(round.round_id));
  assert.equal(ranSession, undefined, "#394 (F23): a structural skip -> ranSession stays unset, same as the cadence skip");
  assert.equal(runner.calls.length, 0);
  const skips = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]);
  assert.equal(skips.length, 1);
  assert.deepEqual(skips[0]!.payload, { round_id: round.round_id });

  // Idempotence (#77 decision 4) unchanged: a re-run with the marker already set is a no-op.
  const rerun = await stub.run({ roundId: round.round_id, phase: "retro", marker });
  assert.equal(rerun.marker, marker);
  assert.equal(runner.calls.length, 0);
  assert.equal(
    state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]).length,
    1,
    "no second skip event on the idempotent re-run",
  );
  state.close();
});

// AC2's three cases each carry EXACTLY ONE of the three signals — a `retro`-tagged-only event
// (`handoff`, tags: ["retro", "round-artifact"]), a `pr-touched`-tagged-only event (`merged`,
// tags: ["pr-touched", ...] — no "retro" tag; the shape a harvest merging a PRIOR round's PR
// leaves with zero fresh dispatch), and a bare `dispatched` event — so dropping any ONE of
// `isQuietRound`'s three checks reddens the ONE case that check alone was catching, never a case
// that another check would still catch. (The issue's own suggested `drive-needs-human` fixture
// carries BOTH the `retro` and `pr-touched` tags at once — it would still be caught by whichever
// check survived, so it doesn't mutation-kill either check on its own; these three do.)
test("createRetroStub (#961 AC2): a retro-tagged event alone is material — the session still runs", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("handoff", { worker: "lane-a", issue: 1 });
  assert.equal(await isQuietRound(new MinimalForge(), state, round), false);
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]), []);
  state.close();
});

test("createRetroStub (#961 AC2): a pr-touched-tagged event alone (e.g. harvest merging a PRIOR round's PR, zero fresh dispatch) is material — the session still runs", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("merged", { worker: "lane-a", issue: 7, pr: 42, headOid: "abc" });
  assert.equal(await isQuietRound(new MinimalForge(), state, round), false);
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]), []);
  state.close();
});

test("createRetroStub (#961 AC2): a dispatched lane alone (no retro/pr-touched event) is material — the session still runs", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("dispatched", { worker: "lane-a", issue: 1 });
  assert.equal(await isQuietRound(new MinimalForge(), state, round), false);
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]), []);
  state.close();
});

// #961 P1 fix-leg regression: a round whose ONLY lane activity is a resume or fix leg (never a
// fresh `dispatched` event) is still lane-session-start material — `dispatched` alone used to be
// the third signal, silently missing every resume/fix-leg-continuation path.
test("createRetroStub (#961): a round with zero `dispatched` events but one `fix-leg-started` is NOT quiet — the session runs, no skip event", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("fix-leg-started", { worker: "lane-a", issue: 1, pr: 30, fixRounds: 1, journalCursor: 0 });
  assert.equal(await isQuietRound(new MinimalForge(), state, round), false);
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]), []);
  state.close();
});

test("createRetroStub (#961): a round with zero `dispatched` events but one `resumed` (a handed-off lane resumed, no fresh dispatch) is NOT quiet — the session runs, no skip event", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("resumed", { worker: "lane-a", issue: 1, attempt: 1 });
  assert.equal(await isQuietRound(new MinimalForge(), state, round), false);
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 1);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]), []);
  state.close();
});

test("createRetroStub (#961): everyNRounds off-cadence skip still runs BEFORE the quiet check — an off-cadence round never even evaluates isQuietRound (marker set, no skip event)", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z"); // round_id 1
  const runner = new ScriptedRunner(doneResult("s1"));
  const cfg = mkCfg({ roles: { retro: { everyNRounds: 3 } } });
  const deps: RetroDeps = { now: realClock, state, cfg, runner, forge: new MinimalForge() };
  const { marker } = await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(marker, retroMarker(round.round_id));
  assert.equal(runner.calls.length, 0);
  assert.deepEqual(
    state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]),
    [],
    "the cadence skip returns before the quiet check runs at all — never a second skip event on top",
  );
  state.close();
});

test("createRetroStub: renders the round facts into the prompt and dispatches exactly one session per round, records round-level spend", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("handoff", { worker: "lane-a", issue: 1 });
  state.appendEvent("drive-needs-human", { worker: "lane-b", issue: 2, pr: 5, reason: "flaky" });
  const runner = new ScriptedRunner(doneResult("role-retro-2"));
  const deps: RetroDeps = {
    state,
    cfg: mkCfg(),
    runner,
    forge: new MinimalForge(),
    // Seeded, not realClock: this fixture also seeds the round's own dates below.
    now: () => new Date("2026-07-10T02:00:00.000Z"),
  };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(marker, retroMarker(round.round_id));
  assert.equal(runner.calls.length, 1);
  const call = runner.calls[0]!;
  assert.equal(call.roleId, "retro");
  assert.equal(call.model, "sonnet"); // roles.retro default
  assert.ok(call.prompt.includes(`Round: #${round.round_id}`));
  assert.ok(call.prompt.includes("mid-task): 1")); // handoffs var substituted into its template line
  assert.ok(call.prompt.includes("Gate② rejections this round"));
  assert.equal(state.spentUsdSince("2026-07-10T00:00:00.000Z") >= 0.03, true);
  // #111 PR-A: the round-scoped digest (PR #5's diff/review data, from THIS round's
  // drive-needs-human event above) is substituted into `{{round.digest}}` — not left literal.
  assert.ok(call.prompt.includes("This round's digest"));
  assert.ok(call.prompt.includes("PR #5"), "the touched PR from the drive-needs-human event appears in the digest");
  assert.ok(!call.prompt.includes("{{round.digest}}"), "the placeholder itself must be substituted away");
  state.close();
});

// ── #111 PR-A: the round-scoped digest reaches the session's prompt via the engine, not a
// live `gh` browse ───────────────────────────────────────────────────────────────────────────

test("createRetroStub: uses deps.forge to build the digest (PR diff + review data + commit history) — never a live gh call of its own", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("merged", { worker: "lane-a", issue: 7, pr: 42, headOid: "abc" });
  const runner = new ScriptedRunner(doneResult("s1"));
  const forge = new MinimalForge();
  let diffCalledWith: number | undefined;
  forge.getPRDiff = async (pr: number) => {
    diffCalledWith = pr;
    return "diff --git a/x b/x\n+hello";
  };
  let commitsCalledWith: string | undefined;
  forge.getCommitsSince = async (sinceIso: string) => {
    commitsCalledWith = sinceIso;
    return [{ sha: "abc1234def", message: "fix: something", author: "alice", date: "2026-07-10T01:00:00Z" }];
  };
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(diffCalledWith, 42);
  assert.equal(commitsCalledWith, round.started_at);
  const prompt = runner.calls[0]!.prompt;
  assert.ok(prompt.includes("PR #42"));
  assert.ok(prompt.includes("hello"));
  assert.ok(prompt.includes("abc1234"));
  assert.ok(prompt.includes("fix: something"));
  state.close();
});

test("createRetroStub: an empty round (no touched PRs, no escalated issues) still renders a digest — never a literal placeholder or a crash", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state); // #961: keeps the round non-quiet without touching the retro/pr-touched counts below
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  const prompt = runner.calls[0]!.prompt;
  assert.ok(prompt.includes("PRs touched this round (0)"));
  assert.ok(prompt.includes("Escalated issues this round (0)"));
  state.close();
});

test("createRetroStub: roles.retro.digestMaxChars is honored — a tiny cap truncates the digest deterministically inside the rendered prompt", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("merged", { worker: "lane-a", issue: 7, pr: 42, headOid: "abc" });
  const runner = new ScriptedRunner(doneResult("s1"));
  const forge = new MinimalForge();
  forge.getPRDiff = async () => "x".repeat(5000);
  const cfg = mkCfg({ roles: { retro: { digestMaxChars: 200 } } });
  const deps: RetroDeps = { now: realClock, state, cfg, runner, forge };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  const prompt = runner.calls[0]!.prompt;
  assert.ok(prompt.includes("digest truncated"), "the digest's own truncation marker must appear in the prompt");
  assert.ok(!prompt.includes("x".repeat(5000)), "the oversize diff content must not survive uncut");
  state.close();
});

// ── #111 PR-B: the scratch-file contract (parseRetroScratch, fail-closed) ───────────────────

const PROPOSAL_SCRATCH = "branch: retro/round-1-proposal\ntitle: docs: tighten worker prompt\n\n## Why\n\nRecurring gate② finding.\n";

test("parseRetroScratch: a well-formed proposal parses to exact branch/title/body (body raw markdown, trimmed)", () => {
  const p = parseRetroScratch(PROPOSAL_SCRATCH);
  assert.deepEqual(p, {
    kind: "proposal",
    branch: "retro/round-1-proposal",
    title: "docs: tighten worker prompt",
    body: "## Why\n\nRecurring gate② finding.",
  });
});

test("parseRetroScratch: 'none' (any surrounding whitespace) is the explicit quiet-round outcome", () => {
  assert.deepEqual(parseRetroScratch("none"), { kind: "none" });
  assert.deepEqual(parseRetroScratch("\nnone\n\n"), { kind: "none" });
});

test("parseRetroScratch: fail-closed cases — missing, empty, malformed headers, empty body", () => {
  const missing = parseRetroScratch(undefined);
  assert.equal(missing.kind, "invalid");
  assert.match((missing as { reason: string }).reason, /missing/);

  const empty = parseRetroScratch("   \n  ");
  assert.equal(empty.kind, "invalid");
  assert.match((empty as { reason: string }).reason, /empty/);

  assert.equal(parseRetroScratch("title: x\nbranch: y\nbody").kind, "invalid", "swapped header order fails closed");
  assert.equal(parseRetroScratch("branch: feat/x\nbody with no title line").kind, "invalid");
  assert.equal(parseRetroScratch("branch: feat/x\ntitle: t\n\n   \n").kind, "invalid", "empty body fails closed");
});

test("parseRetroScratch: branch-name sanity fails closed — bad charset, leading dash, dot-dot, and the default branch by name", () => {
  for (const branch of ["has space", "-leading-dash", "a..b", "main", "master", "semi;colon"]) {
    const p = parseRetroScratch(`branch: ${branch}\ntitle: t\n\nbody\n`);
    assert.equal(p.kind, "invalid", `branch ${JSON.stringify(branch)} must fail closed`);
  }
  // Ordinary ref shapes (slashes, dots, dashes) stay valid.
  assert.equal(parseRetroScratch("branch: feat/x.y-z/1\ntitle: t\n\nbody\n").kind, "proposal");
});

// ── #964: the `update` scratch outcome — repair a PR retro already opened ───────────────────

test("parseRetroScratch (#964): a well-formed update parses to exact pr/branch/body", () => {
  const p = parseRetroScratch("update: 42\nbranch: retro/round-1-proposal\n\nThe finding no longer stands; closing the loop.\n");
  assert.deepEqual(p, {
    kind: "update",
    pr: 42,
    branch: "retro/round-1-proposal",
    body: "The finding no longer stands; closing the loop.",
  });
});

test("parseRetroScratch (#964): an update with an empty body is body: null — 'keep the existing body', not a parse failure", () => {
  assert.deepEqual(parseRetroScratch("update: 42\nbranch: retro/x\n\n   \n"), { kind: "update", pr: 42, branch: "retro/x", body: null });
  assert.deepEqual(parseRetroScratch("update: 42\nbranch: retro/x"), { kind: "update", pr: 42, branch: "retro/x", body: null });
});

test("parseRetroScratch (#964): update fails closed — non-numeric/zero/negative PR, missing branch line, and bad branch names", () => {
  for (const bad of ["update: not-a-number\nbranch: retro/x\n", "update: 0\nbranch: retro/x\n", "update: -1\nbranch: retro/x\n"]) {
    assert.equal(parseRetroScratch(bad).kind, "invalid", `${JSON.stringify(bad)} must fail closed`);
  }
  assert.equal(parseRetroScratch("update: 42\nno branch line here\n").kind, "invalid");
  for (const branch of ["has space", "-leading-dash", "a..b", "main", "master"]) {
    assert.equal(parseRetroScratch(`update: 42\nbranch: ${branch}\n`).kind, "invalid", `branch ${JSON.stringify(branch)} must fail closed`);
  }
});

test("parseRetroScratch (#964): 'update:' and 'branch:' first lines never collide — a proposal file is unaffected", () => {
  assert.equal(parseRetroScratch(PROPOSAL_SCRATCH).kind, "proposal");
  assert.equal(parseRetroScratch("none").kind, "none");
});

// ── #111 PR-B: engine-side PR creation — verify push, then openPR, partial failures degrade ─

test("createRetroStub: happy path — session writes a proposal scratch; engine verifies the pushed branch and opens the PR itself with the exact title/body", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(doneResult("s1", PROPOSAL_SCRATCH));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(marker, retroMarker(round.round_id));
  assert.deepEqual(forge.branchExistsCalls, ["retro/round-1-proposal"], "push verified engine-side, by name");
  assert.deepEqual(forge.openPRCalls, [["retro/round-1-proposal", "docs: tighten worker prompt", "## Why\n\nRecurring gate② finding."]]);
  const opened = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-opened"]);
  assert.equal(opened.length, 1);
  // #964: `head` is recorded off a POST-openPR getPRStatus read (MinimalForge.getPRStatus always
  // answers headOid "x") — the `update` outcome's head-moved verification needs it.
  assert.deepEqual(opened[0]!.payload, { round_id: round.round_id, pr: 77, branch: "retro/round-1-proposal", head: "x" });
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded", "retro-degraded"]), []);
  state.close();
});

test("createRetroStub: quiet round ('none' scratch) — no branch check, no openPR, no degrade; the phase just closes", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(doneResult("s1", "none"));
  const forge = new MinimalForge();
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(marker, retroMarker(round.round_id));
  assert.deepEqual(forge.branchExistsCalls, []);
  assert.deepEqual(forge.openPRCalls, []);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded", "retro-degraded"]), []);
  state.close();
});

test("createRetroStub: push verification fails (branch absent on the forge) — openPR is NEVER called, retro-pr-degraded appended, round not wedged", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(doneResult("s1", PROPOSAL_SCRATCH));
  const forge = new MinimalForge(); // branchExistsResult defaults to false
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(marker, retroMarker(round.round_id)); // the phase still closes
  assert.deepEqual(forge.branchExistsCalls, ["retro/round-1-proposal"]);
  assert.deepEqual(forge.openPRCalls, [], "an unverified push must never reach openPR");
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded"]);
  assert.equal(degraded.length, 1);
  const payload = degraded[0]!.payload as { round_id: number; branch: string; reason: string };
  assert.equal(payload.round_id, round.round_id);
  assert.equal(payload.branch, "retro/round-1-proposal");
  assert.match(payload.reason, /no such branch|could not be verified/);
  state.close();
});

test("createRetroStub: openPR throws AFTER a verified push — retro-pr-degraded names the pushed branch as preserved evidence, never a crash", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(doneResult("s1", PROPOSAL_SCRATCH));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  forge.openPRError = new Error("boom: PR already exists");
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(marker, retroMarker(round.round_id)); // degraded, not wedged
  assert.equal(forge.openPRCalls.length, 1);
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded"]);
  assert.equal(degraded.length, 1);
  const payload = degraded[0]!.payload as { branch: string; reason: string };
  assert.equal(payload.branch, "retro/round-1-proposal");
  assert.match(payload.reason, /openPR failed/);
  assert.match(payload.reason, /preserved evidence/);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-opened"]), []);
  state.close();
});

test("createRetroStub: missing scratch file is an INVALID attempt — retried once, then retro-degraded; openPR never called", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  // Literals, not doneResult(name, undefined): an explicit `undefined` argument would trigger
  // the helper's default ("none") — these results must genuinely carry NO scratchText field.
  const noScratch = (name: string): RoleSessionResult => ({
    outcome: "done",
    costUsd: 0.03,
    modelUsage: [],
    exitCode: 0,
    name,
  });
  const runner = new ScriptedRunner(noScratch("s1"), noScratch("s2"));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(marker, retroMarker(round.round_id));
  assert.equal(runner.calls.length, 2, "invalid scratch retries exactly once");
  assert.deepEqual(forge.openPRCalls, []);
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-degraded"]);
  assert.equal(degraded.length, 1);
  assert.deepEqual(degraded[0]!.payload, { round_id: round.round_id, outcome: "done", session: "s2", attempts: 2 });
  state.close();
});

test("createRetroStub: malformed scratch on the first attempt, valid on the retry — two sessions, no degrade, PR opened", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(doneResult("s1", "garbage that is not a proposal"), doneResult("s2", PROPOSAL_SCRATCH));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 2);
  assert.equal(forge.openPRCalls.length, 1);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-degraded", "retro-pr-degraded"]), []);
  state.close();
});

// ── #964: the `update` scratch outcome — engine-side verify-then-append, never openPR ────────

test("createRetroStub (#964): update happy path — appends retro-pr-updated with the fresh head, never calls openPR, and overwrites the PR body", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 77, branch: "retro/round-1-proposal", head: "aaa" });
  const runner = new ScriptedRunner(
    doneResult("s1", "update: 77\nbranch: retro/round-1-proposal\n\nThe finding still stands; pushed a fix.\n"),
  );
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  forge.statuses.set(77, { number: 77, headOid: "bbb", state: "OPEN", mergeable: "MERGEABLE", ciGreen: false });
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.deepEqual(forge.openPRCalls, [], "an update never opens a duplicate PR");
  assert.deepEqual(forge.branchExistsCalls, ["retro/round-1-proposal"]);
  const updated = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-updated"]);
  assert.equal(updated.length, 1);
  assert.deepEqual(updated[0]!.payload, { round_id: round.round_id, pr: 77, branch: "retro/round-1-proposal", head: "bbb" });
  assert.deepEqual(forge.updateIssueBodyCalls, [[77, "The finding still stands; pushed a fix."]]);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded", "retro-degraded"]), []);
  state.close();
});

test("createRetroStub (#964): an empty-body update ('keep the existing body') never calls updateIssueBody", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 77, branch: "retro/round-1-proposal", head: "aaa" });
  const runner = new ScriptedRunner(doneResult("s1", "update: 77\nbranch: retro/round-1-proposal\n"));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  forge.statuses.set(77, { number: 77, headOid: "bbb", state: "OPEN", mergeable: "MERGEABLE", ciGreen: false });
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-updated"]).length, 1);
  assert.deepEqual(forge.updateIssueBodyCalls, []);
  state.close();
});

test("createRetroStub (#964): PR retro never opened -> retro-pr-degraded naming the reason, and NEITHER branchExists NOR openPR is ever called (mutation-kill: dropping this check would proceed to a live forge read)", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  // Deliberately NO prior retro-pr-opened/-updated event for PR 999.
  const runner = new ScriptedRunner(doneResult("s1", "update: 999\nbranch: retro/some-branch\n\nbody\n"));
  const forge = new MinimalForge();
  forge.branchExistsResult = true; // would happily answer true if ever asked — it must not be asked
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.deepEqual(forge.branchExistsCalls, [], "must refuse before ever touching the forge");
  assert.deepEqual(forge.openPRCalls, []);
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded"]);
  assert.equal(degraded.length, 1);
  assert.match((degraded[0]!.payload as { reason: string }).reason, /never opened that PR|does not own/);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-updated"]), []);
  state.close();
});

test("createRetroStub (#964): scratch branch does not match the PR's RECORDED branch -> degrades, and branchExists is never called (mutation-kill: dropping this check would proceed to verify the WRONG branch)", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 77, branch: "retro/the-real-branch", head: "aaa" });
  const runner = new ScriptedRunner(doneResult("s1", "update: 77\nbranch: retro/a-different-branch\n\nbody\n"));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.deepEqual(forge.branchExistsCalls, [], "must refuse before ever checking the (wrong) branch on the forge");
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded"]);
  assert.equal(degraded.length, 1);
  assert.match((degraded[0]!.payload as { reason: string }).reason, /does not match PR #77's recorded branch/);
  state.close();
});

test("createRetroStub (#964): branch not verifiably pushed -> degrades, updateProposalPR's OWN head-moved check never runs a SECOND getPRStatus read", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 77, branch: "retro/x", head: "aaa" });
  const runner = new ScriptedRunner(doneResult("s1", "update: 77\nbranch: retro/x\n\nbody\n"));
  const forge = new MinimalForge(); // branchExistsResult defaults to false
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });

  // ONE getPRStatus(77) call is expected — the digest's OWN "your outstanding PRs" read
  // (gatherOutstandingRetroPRs, built before the session runs at all); updateProposalPR must
  // decline BEFORE its own head-moved check ever issues a second one.
  assert.deepEqual(forge.statusCalls, [77]);
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded"]);
  assert.equal(degraded.length, 1);
  assert.match((degraded[0]!.payload as { reason: string }).reason, /no such branch exists/);
  state.close();
});

test("createRetroStub (#964): recorded head unchanged -> degrades 'nothing to update', never appends retro-pr-updated", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 77, branch: "retro/x", head: "aaa" });
  const runner = new ScriptedRunner(doneResult("s1", "update: 77\nbranch: retro/x\n\nbody\n"));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  forge.statuses.set(77, { number: 77, headOid: "aaa", state: "OPEN", mergeable: "MERGEABLE", ciGreen: false }); // same head
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-updated"]), []);
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded"]);
  assert.equal(degraded.length, 1);
  assert.match((degraded[0]!.payload as { reason: string }).reason, /has not moved/);
  state.close();
});

test("createRetroStub (#964): a LEGACY retro-pr-opened (no recorded head) accepts once branchExists and the current head differs from base", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 77, branch: "retro/x" }); // pre-#964: no head field at all
  const runner = new ScriptedRunner(doneResult("s1", "update: 77\nbranch: retro/x\n\nbody\n"));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  forge.statuses.set(77, { number: 77, headOid: "bbb", baseOid: "base1", state: "OPEN", mergeable: "MERGEABLE", ciGreen: false });
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-updated"]).length, 1);
  state.close();
});

test("createRetroStub (#964): a LEGACY retro-pr-opened whose current head equals base degrades — nothing ahead to update", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 77, branch: "retro/x" });
  const runner = new ScriptedRunner(doneResult("s1", "update: 77\nbranch: retro/x\n\nbody\n"));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  forge.statuses.set(77, { number: 77, headOid: "same", baseOid: "same", state: "OPEN", mergeable: "MERGEABLE", ciGreen: false });
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-updated"]), []);
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded"]);
  assert.equal(degraded.length, 1);
  assert.match((degraded[0]!.payload as { reason: string }).reason, /pre-#964 PR/);
  state.close();
});

test("createRetroStub (#964): a retro-pr-updated event (not just -opened) counts as the prior record — the SECOND update in a row still verifies against it", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  state.appendEvent("retro-pr-opened", { round_id: 0, pr: 77, branch: "retro/x", head: "aaa" });
  state.appendEvent("retro-pr-updated", { round_id: 0, pr: 77, branch: "retro/x", head: "bbb" });
  const runner = new ScriptedRunner(doneResult("s1", "update: 77\nbranch: retro/x\n\nbody\n"));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  forge.statuses.set(77, { number: 77, headOid: "ccc", state: "OPEN", mergeable: "MERGEABLE", ciGreen: false }); // moved again, past "bbb"
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });

  const updated = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-updated"]);
  assert.equal(updated.length, 2);
  assert.deepEqual(updated[1]!.payload, { round_id: round.round_id, pr: 77, branch: "retro/x", head: "ccc" });
  state.close();
});

test("prompts/retro.md instructs the scratch-file contract at the REAL RETRO_SCRATCH_FILE path (cross-artifact against retro.ts's own constant), and never a gh command", () => {
  const body = readFileSync(defaultRetroPromptPath(), "utf8");
  assert.ok(body.includes(RETRO_SCRATCH_FILE), "must name the fixed scratch path — the real retro.ts constant, not a hand-copied literal");
  assert.ok(!body.includes("gh pr create"), "must not instruct the session to open the PR itself");
});

test("#963 (CONVERT): retro.md's OWN shown proposal-format example, fed through the REAL parseRetroScratch, actually parses to a proposal — not a hand-copied header-line pin", () => {
  const body = readFileSync(defaultRetroPromptPath(), "utf8");
  const anchor = "in EXACTLY this format (two labeled header lines, then the body):";
  const anchorIdx = body.indexOf(anchor);
  assert.ok(anchorIdx >= 0, "retro.md must still introduce the proposal format with this exact anchor sentence");
  const fenceStart = body.indexOf("```", anchorIdx);
  assert.ok(fenceStart >= 0, "expected a fenced example immediately after the anchor sentence");
  const contentStart = body.indexOf("\n", fenceStart) + 1;
  const fenceEnd = body.indexOf("```", contentStart);
  assert.ok(fenceEnd > contentStart, "expected a closing fence for the proposal-format example");
  const rawExample = body.slice(contentStart, fenceEnd);

  // The example shows placeholders in retro.md's own `<...>` convention (e.g. "<the branch name
  // you pushed>") — substitute each bracketed placeholder with a fixed literal, uniformly and
  // without guessing field semantics, so what's actually under test is the STRUCTURE (the
  // "branch:"/"title:" labels, the line order, the body starting on line 3) rather than any
  // value we chose. A real drift (dropped label, reordered lines, a header no longer matching
  // "branch:"/"title:") reddens here even though this substitution changes nothing about it.
  const substituted = rawExample.replace(/<[^>]*>/g, "PLACEHOLDER");
  const parsed = parseRetroScratch(substituted);
  assert.equal(
    parsed.kind,
    "proposal",
    `retro.md's own shown example must parse to a proposal via the real parser; got ${JSON.stringify(parsed)} from:\n${substituted}`,
  );
});

test("createRetroStub: a failed session is retried once — non-done then done means exactly two sessions, no degradation event", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(timeoutResult("s1"), doneResult("s2"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(marker, retroMarker(round.round_id));
  assert.equal(runner.calls.length, 2); // exactly one retry
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-degraded"]), []);
  state.close();
});

test("createRetroStub: two failed sessions degrade VISIBLY but never wedge the round — marker still set, retro-degraded event appended", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(timeoutResult("s1"), timeoutResult("s2"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(marker, retroMarker(round.round_id)); // the phase still closes — never wedges the run
  assert.equal(runner.calls.length, 2); // exactly two attempts, never more
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-degraded"]);
  assert.equal(degraded.length, 1);
  assert.deepEqual(degraded[0]!.payload, { round_id: round.round_id, outcome: "timeout", session: "s2", attempts: 2 });
  state.close();
});

// ── #104: roles.retro.everyNRounds cadence ──────────────────────────────────────────────────

test("createRetroStub: everyNRounds > 1 skips a round whose id isn't a multiple of N — marker still set, no session run", async () => {
  const state = new State(":memory:");
  const round1 = state.startRound("2026-07-10T00:00:00.000Z"); // round_id 1
  const round2 = state.startRound("2026-07-10T01:00:00.000Z"); // round_id 2
  const runner = new ScriptedRunner(doneResult("s1"));
  const cfg = mkCfg({ roles: { retro: { everyNRounds: 3 } } });
  const deps: RetroDeps = { now: realClock, state, cfg, runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);

  const r1 = await stub.run({ roundId: round1.round_id, phase: "retro", marker: null });
  assert.equal(r1.marker, retroMarker(round1.round_id));
  assert.equal(runner.calls.length, 0, "round 1 is not a multiple of 3 — skipped");
  assert.equal(r1.ranSession, undefined, "#394 (F23): off-cadence skip -> ranSession stays unset");

  const r2 = await stub.run({ roundId: round2.round_id, phase: "retro", marker: null });
  assert.equal(r2.marker, retroMarker(round2.round_id));
  assert.equal(runner.calls.length, 0, "round 2 is not a multiple of 3 — skipped");
  state.close();
});

test("createRetroStub: everyNRounds > 1 runs on a round whose id IS a multiple of N", async () => {
  const state = new State(":memory:");
  for (let i = 0; i < 2; i++) state.startRound(`2026-07-10T0${i}:00:00.000Z`); // round_id 1, 2
  const round3 = state.startRound("2026-07-10T03:00:00.000Z"); // round_id 3
  seedDispatch(state);
  const runner = new ScriptedRunner(doneResult("role-retro-3"));
  const cfg = mkCfg({ roles: { retro: { everyNRounds: 3 } } });
  const deps: RetroDeps = { now: realClock, state, cfg, runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  const { marker, ranSession } = await stub.run({ roundId: round3.round_id, phase: "retro", marker: null });
  assert.equal(marker, retroMarker(round3.round_id));
  assert.equal(runner.calls.length, 1, "round 3 is a multiple of 3 — retro runs");
  assert.equal(ranSession, true, "#394 (F23): a real retro session dispatched -> ranSession true");
  state.close();
});

test("createRetroStub: everyNRounds default (1) runs every round, unchanged from #91 behavior", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 1);
  state.close();
});

// ── #104: gate⓪ escalations feed retro's needsHumanEscalations count too ───────────────────

test("gatherRetroFacts: plan-review-escalated events (gate⓪) are counted alongside drive-needs-human (gate②) in needsHumanEscalations", async () => {
  const state = new State(":memory:");
  const round = state.startRound(new Date().toISOString());
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 1, pr: 5, reason: "flaky" });
  state.appendEvent("plan-review-escalated", { round_id: round.round_id, issue: 2, reason: "self-heal exhausted" });
  const facts = gatherRetroFacts(state, round);
  assert.equal(facts.needsHumanEscalations, 2);
  state.close();
});

test("createRetroStub: roles.retro.promptFile override is honored (the #74 promptFile pattern)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-retro-"));
  try {
    const promptPath = join(dir, "custom-retro.md");
    writeFileSync(promptPath, "custom retro prompt: round {{round.id}} handoffs={{round.handoffs}}");
    const state = new State(":memory:");
    const round = state.startRound("2026-07-10T00:00:00.000Z");
    seedDispatch(state);
    const runner = new ScriptedRunner(doneResult("s1"));
    const cfg = mkCfg({ roles: { retro: { promptFile: promptPath } } });
    const deps: RetroDeps = { now: realClock, state, cfg, runner, forge: new MinimalForge() };
    const stub = createRetroStub(deps);
    await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
    assert.equal(runner.calls[0]!.prompt, `custom retro prompt: round ${round.round_id} handoffs=0`);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#701: createRetroStub renders {{lang.issuesAndPrs}} from cfg.language.issuesAndPrs — defaults to 'en', follows an override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-retro-"));
  try {
    const promptPath = join(dir, "custom-lang-retro.md");
    writeFileSync(promptPath, "lang={{lang.issuesAndPrs}}");

    const defaultState = new State(":memory:");
    const defaultRound = defaultState.startRound("2026-07-10T00:00:00.000Z");
    seedDispatch(defaultState);
    const defaultRunner = new ScriptedRunner(doneResult("s1"));
    const defaultCfg = mkCfg({ roles: { retro: { promptFile: promptPath } } });
    await createRetroStub({ now: realClock, state: defaultState, cfg: defaultCfg, runner: defaultRunner, forge: new MinimalForge() }).run({
      roundId: defaultRound.round_id,
      phase: "retro",
      marker: null,
    });
    assert.equal(defaultRunner.calls[0]!.prompt, "lang=en");
    defaultState.close();

    const jaState = new State(":memory:");
    const jaRound = jaState.startRound("2026-07-10T00:00:00.000Z");
    seedDispatch(jaState);
    const jaRunner = new ScriptedRunner(doneResult("s1"));
    const jaCfg = mkCfg({ roles: { retro: { promptFile: promptPath } }, language: { issuesAndPrs: "ja" } });
    await createRetroStub({ now: realClock, state: jaState, cfg: jaCfg, runner: jaRunner, forge: new MinimalForge() }).run({
      roundId: jaRound.round_id,
      phase: "retro",
      marker: null,
    });
    assert.equal(jaRunner.calls[0]!.prompt, "lang=ja");
    jaState.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#963: createRetroStub renders the REAL shipped retro.md with a distinctive {{lang.issuesAndPrs}} value reaching the dispatched prompt (drops the reference -> reddens)", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  // #961 (in flight, PR #968): a round with zero events becomes QUIET and skips the retro
  // session entirely — seed one event so this test still exercises a real dispatch regardless
  // of which of #961/#963 lands second.
  state.appendEvent("dispatched", { worker: "lane-seed", issue: 0 });
  const runner = new ScriptedRunner(doneResult("s1"));
  // No roles.retro.promptFile override — this dispatches against the REAL shipped retro.md.
  const cfg = mkCfg({ language: { issuesAndPrs: "zz-ZZ" } });
  await createRetroStub({ now: realClock, state, cfg, runner, forge: new MinimalForge() }).run({
    roundId: round.round_id,
    phase: "retro",
    marker: null,
  });
  assert.ok(runner.calls[0]!.prompt.includes("zz-ZZ"), "the distinctive language value must reach the rendered shipped prompt");
  state.close();
});

test("#453: the tendency table lands inside the substituted {{round.digest}} block, not as a second placeholder — the engine-rendered table + config-derived window reach the real dispatched prompt (cross-artifact against retro-digest.ts's actual output, not a raw-template pin)", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  seedDispatch(state);
  const runner = new ScriptedRunner(doneResult("role-retro-1"));
  const deps: RetroDeps = { now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  await createRetroStub(deps).run({ roundId: round.round_id, phase: "retro", marker: null });
  const prompt = runner.calls[0]!.prompt;
  assert.ok(prompt.includes("## Finding-class tendency"), "the engine-rendered table reached the prompt");
  assert.ok(prompt.includes("roles.retro.tendencyRounds=3"), "the shipped default window is what got rendered");
  assert.ok(!prompt.includes("{{round.digest}}"), "still exactly one substituted digest placeholder");
  state.close();
});

test("prompts/retro.md no longer instructs live gh browsing (negative lint — a banned instruction class per #235, mirrored across shipped prompts)", () => {
  const body = readFileSync(defaultRetroPromptPath(), "utf8");
  for (const removed of ["gh pr view", "gh pr list", "gh issue view", "gh issue list"]) {
    assert.ok(!body.includes(removed), `retro.md must not instruct ${removed}`);
  }
});

test("prompts/retro.md (#964 AC5, doc-gate): describes the `update` outcome, names the actionable-own-PR-first rule, forbids closing a PR, and the tool scope/never-list is unchanged", () => {
  const body = readFileSync(defaultRetroPromptPath(), "utf8");
  assert.ok(body.includes("Your outstanding PRs"), "must name the digest section by its own heading");
  assert.ok(body.includes("update:"), "must document the update: scratch outcome");
  assert.ok(/first candidate/i.test(body), "must state an actionable own PR is the round's first candidate");
  assert.ok(/repair it on its existing branch/i.test(body), "must instruct repairing the EXISTING branch, not a new one");
  assert.ok(/never close or withdraw|close or withdraw a PR/i.test(body), "must forbid closing/withdrawing a PR");
  assert.ok(/a human/i.test(body) && /decides|closes/i.test(body), "closing stays a human decision");
  // #235 freeze holds: no new tool grant, the allow-list stays exactly what RETRO_ALLOWED_TOOLS
  // pins (asserted byte-for-byte elsewhere in this file) — this prompt change never widens it.
  assert.ok(!body.includes("gh pr close"));
  assert.ok(!/these are all|the complete (set|list)/i.test(body), "no positive-completeness phrasing");
});

// ── Integration: wired as round.ts's real `retro` peripheral ────────────────────────────────

class MinimalForge extends UnstubbedForge implements IForge {
  // #379: repo-level label provisioning — no test in this file exercises it.
  override async ensureRepoLabels(): Promise<string[]> {
    return [];
  }
  override async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  override async listIssuesAbsentFromBoard() {
    return { unplaced: [], elsewhere: 0 };
  }
  override async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  override async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  override async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  override async claimIssue(): Promise<void> {}
  override async setBoardStatus(): Promise<void> {}
  override async addSubIssue(): Promise<void> {
    throw new Error("MinimalForge.addSubIssue is not used by this test");
  }
  override async getSubIssues() {
    return [];
  }
  override async addLabel(): Promise<void> {}
  override async removeLabel(): Promise<void> {}
  override async addPRLabel(): Promise<void> {}
  // #111 PR-B: recording + programmable — the engine-side PR-creation tests drive these.
  openPRCalls: Array<[string, string, string]> = [];
  openPRError: Error | null = null;
  override async openPR(branch: string, title: string, body: string): Promise<number> {
    this.openPRCalls.push([branch, title, body]);
    if (this.openPRError) throw this.openPRError;
    return 77;
  }
  branchExistsCalls: string[] = [];
  branchExistsResult = false;
  override async branchExists(branch: string): Promise<boolean> {
    this.branchExistsCalls.push(branch);
    return this.branchExistsResult;
  }
  // #964: programmable per-PR status (default unchanged: OPEN/MERGEABLE/headOid "x"/green) —
  // the `update` outcome's head-moved verification and isQuietRound's fourth-signal tests need
  // to vary this per PR.
  statuses = new Map<number, PRStatus>();
  statusCalls: number[] = [];
  statusErrors = new Set<number>();
  override async getPRStatus(n: number): Promise<PRStatus> {
    this.statusCalls.push(n);
    if (this.statusErrors.has(n)) throw new Error(`simulated status fetch failure for PR #${n}`);
    return this.statuses.get(n) ?? { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
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
  // #964: programmable per-PR review data (default unchanged: no reviews) — isQuietRound's
  // fourth signal and the outstanding-PRs digest section both check for CHANGES_REQUESTED.
  reviews = new Map<number, PRReviewData>();
  override async getPRReviewData(pr: number): Promise<PRReviewData> {
    return (
      this.reviews.get(pr) ?? {
        headOid: "x",
        author: "producer",
        updatedAt: "2026-01-01T00:00:00Z",
        isDraft: false,
        labels: [],
        state: "OPEN",
        reactions: [],
        reviews: [],
        unresolvedThreads: 0,
      }
    );
  }
  override async getPRDiff(_pr: number): Promise<string> {
    return "";
  }
  override async getPRChangedFiles() {
    return { files: [], complete: true };
  }
  override async getCommitsSince(_sinceIso: string): Promise<CommitInfo[]> {
    return [];
  }
  override async countOpenIssuesInMilestone(): Promise<number> {
    return 0;
  }
  override async listMilestoneTitles(): Promise<string[]> {
    return [];
  }
  override async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return [];
  }
  override async getIssueLabels(): Promise<string[]> {
    return [];
  }
  override async getIssueComments() {
    return [];
  }
}

class MinimalSupervisor implements Supervisor {
  async probe(): Promise<LaneProbe> {
    return { done: true, failed: false, handoff: false, hbAge: 1, wrapperAlive: 1, hasPr: false };
  }
  async dispatch(issue: Issue): Promise<{ name: string; sessionId: string }> {
    return { name: `lane-${issue.number}`, sessionId: "s" };
  }
  async resume(_issue: Issue, worker: string): Promise<{ name: string; sessionId: string }> {
    return { name: worker, sessionId: "s" };
  }
  resumeIntentState(): "none" {
    return "none";
  }
  async reclaim(): Promise<{ worktreePath: string | null; worktreeRetained: boolean }> {
    return { worktreePath: null, worktreeRetained: false };
  }
  inspectWorktree(): { worktreePath: string | null; worktreeRetained: boolean } {
    return { worktreePath: null, worktreeRetained: false };
  }
  requestHandoff(): boolean {
    return true;
  }
  clearStaleFixEntrySentinel(): void {}
}

const baseIntegrationDeps = (
  state: State,
  peripherals: Partial<Record<PeripheralPhase, PeripheralStub>>,
  forge: IForge = new MinimalForge(),
): RoundDeps => ({
  now: realClock,
  forge,
  state,
  supervisor: new MinimalSupervisor(),
  // #125: MinimalForge is an intentionally empty board — these tests are about the retro
  // stub's own wiring, not the standby probe, so opt out of it explicitly (same rationale as
  // round.test.ts's own mkCfg default).
  cfg: mkCfg({ round: { standby: { enabled: false } } }),
  tickIntervalSec: 1,
  sleep: async () => {},
  peripherals,
});

test("runRounds integration (#961): MinimalForge's board is empty — a genuinely idle round is QUIET, the session never dispatches, phase still closes", async () => {
  const state = new State(":memory:");
  const runner = new ScriptedRunner(doneResult("role-retro-int"));
  const retroStub = createRetroStub({ now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() });
  const deps = baseIntegrationDeps(state, { retro: retroStub }); // MinimalForge.getReadyIssues() -> [] — zero lanes ever dispatch
  // Graceful stop mid-round (round.test.ts's pattern): the in-flight round still finishes
  // every phase — retro included — and only the NEXT round is withheld.
  const phaseLog: string[] = [];
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  deps.onRoundPhase = (_roundId, phase) => {
    phaseLog.push(phase);
    if (phase === "aligning") stop();
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  assert.ok(phaseLog.includes("retro"), "the retro phase still closes for a quiet round"); // AC3
  // #961: pre-this-issue this round dispatched a full retro session every time (runner.calls.length
  // === 1) purely because it was on-cadence — nothing looked at whether the round had anything to
  // reflect on. An empty board leaves zero dispatched/retro/pr-touched events, so it is now QUIET.
  assert.equal(runner.calls.length, 0, "an idle round is quiet — the retro session never dispatches");
  const round = state.getRound(1)!;
  assert.equal(round.phase, "closed", "the phase still closes on a quiet round");
  const skips = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]);
  assert.equal(skips.length, 1);
  assert.deepEqual(skips[0]!.payload, { round_id: round.round_id });
  state.close();
});

test("runRounds integration (#961): a round that dispatched a lane is NOT quiet — retro still runs, no skip event", async () => {
  const state = new State(":memory:");
  const runner = new ScriptedRunner(doneResult("role-retro-int"));
  const retroStub = createRetroStub({ now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() });
  const forge = new MinimalForge();
  forge.getReadyIssues = async (): Promise<Issue[]> => [{ number: 1, title: "t", labels: ["prio:3-feature"] }];
  forge.getAuthenticatedActor = async () => "sapwood-bot"; // dispatch's own audit-comment step needs this
  const deps = baseIntegrationDeps(state, { retro: retroStub }, forge);
  // #380: a stop signal freezes NEW dispatch from the moment it's requested (round.ts's own doc:
  // "dispatch frozen" once `stopRequested`) — requesting it at "aligning" (as the sibling idle-
  // round test above does) would suppress this test's own dispatch before `executing` ever runs.
  // Requesting it once the round reaches `retro` instead lets `executing` dispatch normally first
  // and still stops the loop before round 2 opens.
  const phaseLog: string[] = [];
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  deps.onRoundPhase = (_roundId, phase) => {
    phaseLog.push(phase);
    if (phase === "retro") stop();
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  assert.ok(phaseLog.includes("retro"), "the retro phase still closes for a dispatching round"); // AC3
  assert.equal(runner.calls.length, 1, "a dispatched lane is material — retro's session still runs");
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-quiet-skipped"]), []);
  state.close();
});

test("runRounds integration: KILL_SWITCH blocks retro entirely — the stub never runs, no marker, no session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-retro-int-"));
  try {
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const runner = new ScriptedRunner(doneResult("role-retro-int"));
    const retroStub = createRetroStub({ now: realClock, state, cfg: mkCfg(), runner, forge: new MinimalForge() });
    const deps = baseIntegrationDeps(state, { retro: retroStub });
    const result = await runRoundsGuarded(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.equal(runner.calls.length, 0);
    assert.equal(result.rounds, 0);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
