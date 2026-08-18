// harvest.test.ts (#91, reworked by #110 PR3): the `harvesting` peripheral's round-close
// summary role. Fakes the underlying role session (RoleRunner) directly — peripheral.test.ts
// already covers the real claude-stub spawn path; this file is about the ORCHESTRATION logic
// (fact-gathering from the durable ledger, marker idempotence, structured-output parsing/
// validation, and — via two integration tests against round.ts's real runRounds — the generic
// graceful-vs-KILL_SWITCH peripheral behavior applied to THIS stub).
//
// #110 PR3 rework note: the session no longer touches `gh` at all — every RoleSessionResult a
// test script hands the fake runner carries a `resultText` (the session's structured final
// output, see structured-output.ts) instead of a `gh issue comment` side effect the pre-#110
// allowedTools grant let it perform directly. The engine reads `resultText`, validates it
// against the round's pre-computed needsHumanIssues set, and performs every addIssueComment
// call itself — exactly what these tests assert on via the fake forge's `comments` capture.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import { UnstubbedForge } from "../forge/unstubbed-forge.test-support.js";
import { ROLE_DISALLOWED_TOOLS, type RoleSessionOpts, type RoleSessionResult } from "../roles/peripheral.js";
import { State } from "../state/state.js";
import { RESULT_BLOCK_END, RESULT_BLOCK_START } from "../state/structured-output.js";
import type { LaneProbe, Supervisor } from "./conductor.js";
import { attachAttemptGuard, withHangGuard } from "./hang-guard.test-support.js";
import {
  createHarvestStub,
  defaultHarvestPromptPath,
  factVars,
  HARVEST_DISALLOWED_TOOLS,
  type HarvestDeps,
  harvestMarker,
  renderFactsTemplate,
  validateHarvestOutput,
} from "./harvest.js";
import { type PeripheralPhase, type PeripheralStub, type RoundDeps, runRounds } from "./round.js";
import { buildRoundArtifact } from "./round-artifact.js";

/** #403 (F25): an EXPLICIT wall-clock injection for fixtures that seed no date and assert
 *  nothing calendar-dependent. Production's `now` seams are required, not optional, precisely so
 *  this choice is written down at each fixture instead of being an invisible default — a test
 *  that DOES seed a date must inject that seeded clock here, not this one. Named (not inlined)
 *  so every deliberate real-clock read in this suite greps as one decision. */
const realClock = (): Date => new Date();

/** Scripted fake of RoleRunner.run — captures every call's opts for assertion, returns the
 *  next scripted result (or the last one, repeated) — same pattern as plan-review.test.ts's
 *  ScriptedRunner. */
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

/** A minimal fake IForge — every method is a no-op EXCEPT addIssueComment/updateIssueBody,
 *  which capture their calls for assertion. #110 PR3: addIssueComment is now the ONLY channel
 *  a validated harvest decision reaches GitHub through (the session itself has no gh grant it
 *  acts on), so this capture is what every "the engine posted X" assertion below reads. */
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
  comments: Array<[number, string]> = [];
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
  override async openPR(): Promise<number> {
    return 1;
  }
  override async getPRStatus(n: number): Promise<PRStatus> {
    return { number: n, headOid: "x", state: "OPEN", mergeable: "MERGEABLE", ciGreen: true };
  }
  override async mergePR(): Promise<void> {}
  override async addPRComment(): Promise<void> {}
  override async addIssueComment(issue: number, body: string): Promise<void> {
    this.comments.push([issue, body]);
  }
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
    return [];
  }
  override async getIssueLabels(): Promise<string[]> {
    return [];
  }
  override async getIssueComments() {
    return [];
  }
}

/** Builds a session's structured final-message text (structured-output.ts's sentinel format,
 *  same helper shape as plan-review.test.ts's sapwoodResult) — harvest never uses the optional
 *  BODY segment (see harvest.ts's module doc: comment bodies travel inside the JSON array). */
const sapwoodResult = (metadata: Record<string, unknown>): string =>
  `${RESULT_BLOCK_START}\n${JSON.stringify(metadata)}\n${RESULT_BLOCK_END}`;

const doneResult = (name: string, resultText = ""): RoleSessionResult => ({
  outcome: "done",
  costUsd: 0.02,
  modelUsage: [],
  exitCode: 0,
  name,
  resultText,
});
const failedResult = (name: string): RoleSessionResult => ({
  outcome: "failed",
  costUsd: 0.02,
  modelUsage: [],
  exitCode: 1,
  name,
});

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

/** #691: `runRounds` drives `round.ts:1161/1692/1726`'s production `for (;;)` loops with no bound
 *  of its own -- see `hang-guard.test-support.ts` (shared with
 *  driver.test.ts/round.test.ts/round-defaults.test.ts/retro.test.ts -- ONE copy, not five) for
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

test("defaultHarvestPromptPath: resolves to the shipped prompts/harvest.md, which exists and instructs the #110 structured-output format (real RESULT_BLOCK_START/END constants — cross-artifact)", () => {
  const p = defaultHarvestPromptPath();
  assert.ok(existsSync(p), `expected shipped prompt at ${p}`);
  const body = readFileSync(p, "utf8");
  // #110 PR3: the session has no gh grant it acts on — every comment travels through the
  // sentinel-delimited structured block, never a direct tool call. RESULT_BLOCK_START/END are the
  // real structured-output.ts constants, not a hand-copied literal — a rename there fails this.
  assert.ok(
    body.includes(RESULT_BLOCK_START) && body.includes(RESULT_BLOCK_END),
    "harvest.md must instruct the structured-output sentinel format",
  );
});

test("#963: createHarvestStub renders the REAL shipped harvest.md with a distinctive {{lang.issuesAndPrs}} value reaching the dispatched prompt (drops the reference -> reddens)", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 9, pr: 1, reason: "x" });
  const resultText = sapwoodResult({ comments: [{ issue: 9, body: "hi" }] });
  const runner = new ScriptedRunner(doneResult("s1", resultText));
  // No roles.harvest.promptFile override — this dispatches against the REAL shipped harvest.md.
  const cfg = mkCfg({ language: { issuesAndPrs: "zz-ZZ" } });
  await createHarvestStub({ now: realClock, forge: new MinimalForge(), state, cfg, runner }).run({
    roundId: round.round_id,
    phase: "harvesting",
    marker: null,
  });
  assert.ok(runner.calls[0]!.prompt.includes("zz-ZZ"), "the distinctive language value must reach the rendered shipped prompt");
  state.close();
});

test("renderFactsTemplate: substitutes known vars, throws on an unknown placeholder (#74 fail-closed pattern)", () => {
  assert.equal(
    renderFactsTemplate("round {{round.id}} spent {{round.spentUsd}}", { "round.id": "5", "round.spentUsd": "1.00" }),
    "round 5 spent 1.00",
  );
  assert.throws(() => renderFactsTemplate("{{bogus}}", {}), /unknown variable \{\{bogus\}\}/);
});

test("buildRoundArtifact (#123, ex-gatherRoundFacts): sums PRs opened/merged, spend, and distinct needs-human issues from the durable ledger since round start", async () => {
  const state = new State(":memory:");
  // Before round start — must be excluded. appendEvent stamps the REAL clock, so the round's
  // started_at must also be a real-clock timestamp strictly after this event (the small sleep
  // guarantees a later millisecond).
  state.appendEvent("merged", { worker: "lane-x", issue: 99, pr: 1, headOid: "h" });
  // Pre-round spend — must be excluded. The window is the id CURSOR captured at startRound
  // (Codex P2, PR #152), so exclusion follows insertion order, not the row's timestamp.
  state.recordSpend("lane-x", 99, 1000, "2026-07-09T00:00:00.000Z");
  await new Promise((r) => setTimeout(r, 5));
  const round = state.startRound(new Date().toISOString());

  state.appendEvent("reclaim-done", { worker: "lane-a", issue: 1, next: "DRIVING" }); // PR opened
  state.appendEvent("reclaim-failed", { worker: "lane-b", issue: 2, next: "DRIVING" }); // PR opened (rescued)
  state.appendEvent("reclaim-failed", { worker: "lane-c", issue: 3, next: "ESCALATE" }); // NOT opened
  state.appendEvent("reclaim-dead", { worker: "lane-d", issue: 4, next: "DRIVING", rescued: true }); // PR opened
  state.appendEvent("reclaim-dead", { worker: "lane-e", issue: 5, next: "REQUEUE", rescued: false }); // NOT opened
  state.appendEvent("merged", { worker: "lane-a", issue: 1, pr: 10, headOid: "h1" });
  state.appendEvent("merged", { worker: "lane-b", issue: 2, pr: 11, headOid: "h2" });
  state.appendEvent("drive-needs-human", { worker: "lane-f", issue: 6, pr: 12, reason: "changes requested" });
  state.appendEvent("drive-needs-human", { worker: "lane-f", issue: 6, pr: 12, reason: "still open" }); // same issue twice
  state.recordSpend("lane-a", 1, 4, new Date().toISOString());
  state.recordSpend("lane-b", 2, 3, new Date().toISOString());

  const artifact = buildRoundArtifact(state, round, 30, null);
  assert.equal(artifact.roundId, round.round_id);
  assert.equal(artifact.prsOpened, 3);
  assert.equal(artifact.prsMerged, 2);
  assert.equal(artifact.issuesClosed, 2);
  assert.equal(artifact.spendUsd, 7);
  assert.equal(artifact.roundBudgetUsd, 30);
  assert.deepEqual(artifact.escalations.needsHuman, [6]); // deduped
  state.close();
});

test("createHarvestStub: marker present -> returns it unchanged, no facts gathered, no session run (idempotence)", async () => {
  const state = new State(":memory:");
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: HarvestDeps = { now: realClock, forge: new MinimalForge(), state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: 5, phase: "harvesting", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("factVars (#123): {{round.artifact}} carries the rendered md verbatim; the pre-#123 fact vars stay supported for custom promptFiles", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("merged", { worker: "lane-a", issue: 1, pr: 10, headOid: "h1" });
  state.appendEvent("drive-needs-human", { worker: "lane-b", issue: 6, pr: 12, reason: "r" });
  const withoutEgress = factVars(buildRoundArtifact(state, round, 30, null), "THE-ARTIFACT-MD");
  assert.equal(withoutEgress["round.egressSuspectCount"], "0");
  assert.equal(withoutEgress["round.egressSuspectList"], "(none)");
  state.appendEvent("egress-suspect", {
    worker: "lane-304",
    issue: 304,
    executable: "curl",
    snippet: "curl https://example.invalid",
  });
  const artifact = buildRoundArtifact(state, round, 30, null);
  const vars = factVars(artifact, "THE-ARTIFACT-MD");
  assert.equal(vars["round.artifact"], "THE-ARTIFACT-MD");
  assert.equal(vars["round.prsMerged"], "1");
  assert.equal(vars["round.needsHumanList"], "#6");
  assert.equal(vars["round.egressSuspectCount"], "1");
  assert.equal(vars["round.egressSuspectList"], "issue #304: curl");
  // Both a pre-#123 custom template and the shipped one render without an unknown-var throw.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: this is the literal template syntax under test.
  renderFactsTemplate("r{{round.id}}: {{round.prsOpened}}/{{round.prsMerged}} ${{round.spentUsd}}", vars);
  renderFactsTemplate(
    "{{round.artifact}} targets: {{round.needsHumanList}} egress: {{round.egressSuspectCount}} — {{round.egressSuspectList}}",
    vars,
  );
  state.close();
});

test("factVars (Codex sol-high PR #417 review, P2-a follow-up — delta re-review): round.egressSuspectList renders a role-session egress-suspect event (issue: 0, peripheral.ts's #410 WebFetch/WebSearch audit) as a role-session entry, never a fabricated 'issue #0' reference — a worker-leg event (a real issue number) in the SAME list is unaffected", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("egress-suspect", { worker: "lane-304", issue: 304, executable: "curl", snippet: "curl https://example.invalid" });
  state.appendEvent("egress-suspect", {
    worker: "role-architect-1a2b3c4d",
    issue: 0,
    executable: "WebFetch",
    snippet: "https://example.invalid/docs",
  });
  const artifact = buildRoundArtifact(state, round, 30, null);
  const vars = factVars(artifact, "THE-ARTIFACT-MD");
  assert.equal(vars["round.egressSuspectCount"], "2");
  assert.equal(vars["round.egressSuspectList"], "issue #304: curl, role session role-architect-1a2b3c4d: WebFetch");
  assert.ok(!vars["round.egressSuspectList"]!.includes("issue #0"), "never renders the nonexistent 'issue #0' reference");
  state.close();
});

test("factVars (#387 F18): round.egressSuspectList marks a loopback hit and leaves a public hit's entry exactly as before — the harvest prompt can tell dev-server noise from real egress", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("egress-suspect", {
    worker: "lane-144",
    issue: 144,
    executable: "curl",
    snippet: "curl http://127.0.0.1:5173/",
    target: "loopback",
  });
  state.appendEvent("egress-suspect", {
    worker: "lane-144",
    issue: 144,
    executable: "curl",
    snippet: "curl https://fonts.example.invalid/x",
  });
  const vars = factVars(buildRoundArtifact(state, round, 30, null), "THE-ARTIFACT-MD");
  assert.equal(vars["round.egressSuspectCount"], "2"); // tagged, not excluded: both still counted
  assert.equal(vars["round.egressSuspectList"], "issue #144: curl (loopback), issue #144: curl");
  state.close();
});

test("createHarvestStub (#123): no needs-human issues this round -> no session run, and NO harvest-summary event — the persisted round artifact (round.ts's close) is the machine-readable record now", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("merged", { worker: "lane-a", issue: 1, pr: 10, headOid: "h1" });
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: HarvestDeps = { now: realClock, forge: new MinimalForge(), state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker, ranSession } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
  assert.equal(marker, harvestMarker(round.round_id));
  assert.equal(runner.calls.length, 0);
  assert.equal(ranSession, false, "#394 (F23): nothing to brief -> no session dispatched -> ranSession false");
  // The pre-#123 harvest-summary event is gone (superseded by the round_artifacts row that
  // round.ts persists at close) — harvest appends nothing when there's nobody to brief.
  const summaries = state.eventsSince("2020-01-01T00:00:00.000Z", ["harvest-summary"]);
  assert.equal(summaries.length, 0);
  state.close();
});

test("createHarvestStub: a needs-human issue this round -> dispatches ONE harvest session with the rendered facts, posts the validated comment via addIssueComment (engine-executed, not session-executed), records round-level spend", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 42, pr: 7, reason: "flaky test" });
  state.appendEvent("merged", { worker: "lane-b", issue: 2, pr: 8, headOid: "h" });
  const resultText = sapwoodResult({ comments: [{ issue: 42, body: "Round context: 1 PR merged this round." }] });
  const runner = new ScriptedRunner(doneResult("role-harvest-abc", resultText));
  const forge = new MinimalForge();
  const deps: HarvestDeps = { forge, state, cfg: mkCfg(), runner, now: () => new Date("2026-07-10T01:00:00.000Z") };
  const stub = createHarvestStub(deps);
  const { marker, ranSession } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });

  assert.equal(marker, harvestMarker(round.round_id));
  assert.equal(runner.calls.length, 1);
  assert.equal(ranSession, true, "#394 (F23): a real harvest session dispatched -> ranSession true");
  const call = runner.calls[0]!;
  assert.equal(call.roleId, "harvest");
  assert.equal(call.model, "sonnet"); // roles.harvest default
  assert.equal(call.effort, "medium");
  // #123: the prompt now carries the rendered round-artifact markdown block.
  assert.ok(call.prompt.includes(`# Round #${round.round_id} summary`));
  assert.ok(call.prompt.includes("PRs merged: 1"));
  assert.ok(call.prompt.includes("#42"));
  // #101 security-review pitfall: comments-only role — the WHOLE `gh issue edit` verb is
  // pattern-denied (labels included), on top of the base issues-only denies.
  assert.equal(call.disallowedTools, HARVEST_DISALLOWED_TOOLS);

  // #110 PR3: the engine posts the comment, from the session's VALIDATED structured output —
  // never the session itself (no gh grant it acts on) — appending the round marker itself
  // (structural, not a prompt instruction the session might get wrong).
  assert.deepEqual(forge.comments, [[42, `Round context: 1 PR merged this round.\n\n${harvestMarker(round.round_id)}`]]);

  // Round-level spend recorded against the session name, issue=0 sentinel (no single issue).
  assert.equal(state.spentUsdSince("2026-07-10T00:00:00.000Z") >= 0.02, true);
  state.close();
});

test("HARVEST_DISALLOWED_TOOLS (#235 PR-B): now byte-identical to the base deny list — kept as its own named export for call-site clarity only. Before #235 this carried an EXTRA `Bash(gh issue edit*)` pattern (no label/body mutation at all); now redundant under the blanket Bash deny and dropped", () => {
  assert.equal(HARVEST_DISALLOWED_TOOLS, ROLE_DISALLOWED_TOOLS);
  assert.ok(HARVEST_DISALLOWED_TOOLS.split(",").includes("Bash"), "blanket Bash deny already covers `gh issue edit`");
});

test("createHarvestStub: a failed session is retried once — non-done then done-and-valid means exactly two sessions, no degradation event", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 42, pr: 7, reason: "x" });
  const retryText = sapwoodResult({ comments: [{ issue: 42, body: "recovered on retry" }] });
  const runner = new ScriptedRunner(failedResult("s1"), doneResult("s2", retryText));
  const forge = new MinimalForge();
  const deps: HarvestDeps = { now: realClock, forge, state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
  assert.equal(marker, harvestMarker(round.round_id));
  assert.equal(runner.calls.length, 2); // exactly one retry
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["harvest-degraded"]), []);
  // The recovered attempt's validated comment still gets posted — a retry-then-succeed is not
  // silently dropped just because the FIRST attempt failed.
  assert.deepEqual(forge.comments, [[42, `recovered on retry\n\n${harvestMarker(round.round_id)}`]]);
  state.close();
});

test("createHarvestStub: two failed sessions degrade VISIBLY but never wedge the round — marker still set, harvest-degraded event appended, no comment posted", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 42, pr: 7, reason: "x" });
  const runner = new ScriptedRunner(failedResult("s1"), failedResult("s2"));
  const forge = new MinimalForge();
  const deps: HarvestDeps = { now: realClock, forge, state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
  assert.equal(marker, harvestMarker(round.round_id)); // the phase still closes — run termination is never blocked
  assert.equal(runner.calls.length, 2); // exactly two attempts, never more
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["harvest-degraded"]);
  assert.equal(degraded.length, 1);
  assert.deepEqual(degraded[0]!.payload, { round_id: round.round_id, outcome: "failed", session: "s2", attempts: 2 });
  assert.deepEqual(forge.comments, []); // nothing ever validated -> nothing ever posted
  state.close();
});

test("createHarvestStub: roles.harvest.promptFile override is honored (the #74 promptFile pattern)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-harvest-"));
  try {
    const promptPath = join(dir, "custom-harvest.md");
    writeFileSync(promptPath, "custom harvest prompt for round {{round.id}}, needs-human: {{round.needsHumanList}}");
    const state = new State(":memory:");
    const round = state.startRound("2026-07-10T00:00:00.000Z");
    state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 9, pr: 1, reason: "x" });
    const resultText = sapwoodResult({ comments: [{ issue: 9, body: "hi" }] });
    const runner = new ScriptedRunner(doneResult("s1", resultText));
    const cfg = mkCfg({ roles: { harvest: { promptFile: promptPath } } });
    const deps: HarvestDeps = { now: realClock, forge: new MinimalForge(), state, cfg, runner };
    const stub = createHarvestStub(deps);
    await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
    assert.equal(runner.calls[0]!.prompt, `custom harvest prompt for round ${round.round_id}, needs-human: #9`);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("#701: createHarvestStub renders {{lang.issuesAndPrs}} from cfg.language.issuesAndPrs — defaults to 'en', follows an override", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-harvest-"));
  try {
    const promptPath = join(dir, "custom-lang-harvest.md");
    writeFileSync(promptPath, "lang={{lang.issuesAndPrs}}");
    const resultText = sapwoodResult({ comments: [{ issue: 9, body: "hi" }] });

    const defaultState = new State(":memory:");
    const defaultRound = defaultState.startRound("2026-07-10T00:00:00.000Z");
    defaultState.appendEvent("drive-needs-human", { worker: "lane-a", issue: 9, pr: 1, reason: "x" });
    const defaultRunner = new ScriptedRunner(doneResult("s1", resultText));
    const defaultCfg = mkCfg({ roles: { harvest: { promptFile: promptPath } } });
    await createHarvestStub({ now: realClock, forge: new MinimalForge(), state: defaultState, cfg: defaultCfg, runner: defaultRunner }).run(
      {
        roundId: defaultRound.round_id,
        phase: "harvesting",
        marker: null,
      },
    );
    assert.equal(defaultRunner.calls[0]!.prompt, "lang=en");
    defaultState.close();

    const jaState = new State(":memory:");
    const jaRound = jaState.startRound("2026-07-10T00:00:00.000Z");
    jaState.appendEvent("drive-needs-human", { worker: "lane-a", issue: 9, pr: 1, reason: "x" });
    const jaRunner = new ScriptedRunner(doneResult("s1", resultText));
    const jaCfg = mkCfg({ roles: { harvest: { promptFile: promptPath } }, language: { issuesAndPrs: "ja" } });
    await createHarvestStub({ now: realClock, forge: new MinimalForge(), state: jaState, cfg: jaCfg, runner: jaRunner }).run({
      roundId: jaRound.round_id,
      phase: "harvesting",
      marker: null,
    });
    assert.equal(jaRunner.calls[0]!.prompt, "lang=ja");
    jaState.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #110 PR3: malformed/schema-invalid/out-of-set structured output — the isValid hook ──────

test("validateHarvestOutput: no structured block at all -> fail-closed", () => {
  const result = validateHarvestOutput("just prose, no sentinel", [42]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/no structured output block/.test(result.reason));
});

test("validateHarvestOutput: JSON-invalid metadata -> fail-closed", () => {
  const text = `${RESULT_BLOCK_START}\nnot json\n${RESULT_BLOCK_END}`;
  const result = validateHarvestOutput(text, [42]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/not valid JSON/.test(result.reason));
});

test("validateHarvestOutput: schema-invalid (comments not an array) -> fail-closed", () => {
  const result = validateHarvestOutput(sapwoodResult({ comments: "nope" }), [42]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/schema validation/.test(result.reason));
});

test("validateHarvestOutput: a smuggled extra metadata field is rejected outright (.strict() schema)", () => {
  const result = validateHarvestOutput(sapwoodResult({ comments: [], extra: "field" }), []);
  assert.equal(result.ok, false);
});

test("validateHarvestOutput: an issue number outside the pre-computed needs-human set -> fail-closed, WHOLE batch rejected (not just the bad entry)", () => {
  const text = sapwoodResult({
    comments: [
      { issue: 42, body: "in-set, fine on its own" },
      { issue: 99, body: "not in this round's set" },
    ],
  });
  const result = validateHarvestOutput(text, [42]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/#99/.test(result.reason) && /outside this round's needs-human set/.test(result.reason));
});

test("validateHarvestOutput: duplicate issue numbers in the batch -> fail-closed, WHOLE batch rejected (Codex round 1 P1: one comment per needs-human issue, never two)", () => {
  const text = sapwoodResult({
    comments: [
      { issue: 42, body: "first" },
      { issue: 42, body: "second, same target" },
    ],
  });
  const result = validateHarvestOutput(text, [42]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/duplicate issue/.test(result.reason));
});

test("validateHarvestOutput: an empty-body comment -> fail-closed", () => {
  const result = validateHarvestOutput(sapwoodResult({ comments: [{ issue: 42, body: "   " }] }), [42]);
  assert.equal(result.ok, false);
  if (!result.ok) assert.ok(/empty body/.test(result.reason));
});

test("validateHarvestOutput: empty comments array is valid, including when the needs-human set is empty", () => {
  const result = validateHarvestOutput(sapwoodResult({ comments: [] }), []);
  assert.deepEqual(result, { ok: true, comments: [] });
});

test("validateHarvestOutput: well-formed comments, all within the pre-computed set -> ok", () => {
  const text = sapwoodResult({
    comments: [
      { issue: 1, body: "a" },
      { issue: 2, body: "b" },
    ],
  });
  const result = validateHarvestOutput(text, [1, 2, 3]);
  assert.deepEqual(result, {
    ok: true,
    comments: [
      { issue: 1, body: "a" },
      { issue: 2, body: "b" },
    ],
  });
});

test("createHarvestStub #110: malformed structured output TWICE -> degrades exactly like a session failure — harvest-degraded event, no comment posted, round still closes", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 42, pr: 7, reason: "x" });
  const runner = new ScriptedRunner(
    doneResult("s1", "I looked at the round and it went fine."),
    doneResult("s1-retry", "still just prose, no structured output"),
  );
  const forge = new MinimalForge();
  const deps: HarvestDeps = { now: realClock, forge, state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
  assert.equal(marker, harvestMarker(round.round_id)); // the phase still closes
  assert.equal(runner.calls.length, 2); // exactly one retry, done outcome doesn't stop it — isValid does
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["harvest-degraded"]);
  assert.equal(degraded.length, 1);
  // Payload shape preserved EXACTLY (pre-#110): a "done" session that never validated still
  // reports outcome: "done" here — the invalid-output cause lives in the stderr line, not here.
  assert.deepEqual(degraded[0]!.payload, { round_id: round.round_id, outcome: "done", session: "s1-retry", attempts: 2 });
  assert.deepEqual(forge.comments, []); // never validated -> never posted
  state.close();
});

test("createHarvestStub #110: an out-of-set issue number TWICE -> degrades fail-closed, no comment posted for ANY issue in the batch (not even the in-set one)", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 42, pr: 7, reason: "x" });
  const poisoned = sapwoodResult({
    comments: [
      { issue: 42, body: "legit" },
      { issue: 999, body: "not this round's issue" },
    ],
  });
  const runner = new ScriptedRunner(doneResult("s1", poisoned), doneResult("s1-retry", poisoned));
  const forge = new MinimalForge();
  const deps: HarvestDeps = { now: realClock, forge, state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
  assert.equal(marker, harvestMarker(round.round_id));
  assert.equal(runner.calls.length, 2);
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["harvest-degraded"]);
  assert.equal(degraded.length, 1);
  assert.deepEqual(forge.comments, []); // the WHOLE batch is rejected — #42 doesn't get a free pass
  state.close();
});

test("createHarvestStub #110: duplicate issue numbers TWICE -> degrades fail-closed (harvest-degraded event), nothing posted for the duplicated issue", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 42, pr: 7, reason: "x" });
  const duplicated = sapwoodResult({
    comments: [
      { issue: 42, body: "first" },
      { issue: 42, body: "second, same target" },
    ],
  });
  const runner = new ScriptedRunner(doneResult("s1", duplicated), doneResult("s1-retry", duplicated));
  const forge = new MinimalForge();
  const deps: HarvestDeps = { now: realClock, forge, state, cfg: mkCfg(), runner };
  const stub = createHarvestStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "harvesting", marker: null });
  assert.equal(marker, harvestMarker(round.round_id)); // the phase still closes — never a wedged round
  assert.equal(runner.calls.length, 2); // exactly one retry
  const degraded = state.eventsSince("2020-01-01T00:00:00.000Z", ["harvest-degraded"]);
  assert.equal(degraded.length, 1);
  assert.deepEqual(forge.comments, []); // ambiguous batch -> zero comments, never "post one of them"
  state.close();
});

// ── Integration: wired as round.ts's real `harvesting` peripheral ──────────────────────────

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

const baseIntegrationDeps = (state: State, peripherals: Partial<Record<PeripheralPhase, PeripheralStub>>): RoundDeps => ({
  now: realClock,
  forge: new MinimalForge(),
  state,
  supervisor: new MinimalSupervisor(),
  // #125: MinimalForge is an intentionally empty board — these tests are about the harvest
  // stub's own wiring, not the standby probe, so opt out of it explicitly (same rationale as
  // round.test.ts's own mkCfg default).
  cfg: mkCfg({ round: { standby: { enabled: false } } }),
  tickIntervalSec: 1,
  sleep: async () => {},
  peripherals,
});

test("runRounds integration: the real harvest stub runs during a normal round close, posts the validated comment, and persists a marker", async () => {
  const state = new State(":memory:");
  // Pre-seed a needs-human escalation so the stub actually dispatches a session (proving it
  // ran, not merely skipped for lack of anything to report).
  const resultText = sapwoodResult({ comments: [{ issue: 7, body: "round context" }] });
  const runner = new ScriptedRunner(doneResult("role-harvest-int", resultText));
  const forge = new MinimalForge();
  const harvestStub = createHarvestStub({ now: realClock, forge, state, cfg: mkCfg(), runner });
  const deps = baseIntegrationDeps(state, { harvesting: harvestStub });
  deps.forge = forge; // same fake forge instance -> the assertion below sees the harvest write
  // Signal a graceful stop mid-round (round.test.ts's pattern): the in-flight round still
  // finishes every phase — harvesting included — and only the NEXT round is withheld.
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  deps.onRoundPhase = (_roundId, phase) => {
    // Appended AFTER startRound (the round already exists once 'aligning' completes), so its
    // ts is guaranteed >= round.started_at — exactly what gatherRoundFacts' window requires.
    if (phase === "aligning") {
      state.appendEvent("drive-needs-human", { worker: "lane-a", issue: 7, pr: 1, reason: "x" });
      stop();
    }
  };
  const result = await runRoundsGuarded(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  assert.equal(runner.calls.length, 1); // the harvest session actually ran — on a GRACEFUL stop
  const round = state.getRound(1)!; // closed rounds are still readable by id
  assert.equal(round.phase, "closed");
  assert.deepEqual(forge.comments, [[7, `round context\n\n${harvestMarker(1)}`]]);
  state.close();
});

test("runRounds integration: KILL_SWITCH blocks harvesting entirely — the stub never runs, no marker, no session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-harvest-int-"));
  try {
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const runner = new ScriptedRunner(doneResult("role-harvest-int"));
    const harvestStub = createHarvestStub({ now: realClock, forge: new MinimalForge(), state, cfg: mkCfg(), runner });
    const deps = baseIntegrationDeps(state, { harvesting: harvestStub });
    const result = await runRoundsGuarded(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.equal(runner.calls.length, 0); // harvest never dispatched a session
    assert.equal(result.rounds, 0); // the round never closed
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
