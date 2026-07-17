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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import type { CommitInfo, IForge, Issue, PRReviewData, PRStatus } from "../forge/forge.js";
import type { LaneProbe, Supervisor } from "../loop/conductor.js";
import { type PeripheralPhase, type PeripheralStub, type RoundDeps, runRounds } from "../loop/round.js";
import type { ContextManifest } from "../roles/context-manifest.js";
import type { RoleSessionOpts, RoleSessionResult } from "../roles/peripheral.js";
import { State } from "../state/state.js";
import {
  createRetroStub,
  defaultRetroPromptPath,
  gatherRetroFacts,
  parseRetroScratch,
  RETRO_ALLOWED_TOOLS,
  RETRO_DISALLOWED_TOOLS,
  RETRO_SCRATCH_FILE,
  type RetroDeps,
  retroMarker,
} from "./retro.js";

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
  recordedAt: "2026-07-17T00:00:01Z",
});

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
});

test("createRetroStub: every dispatched session carries RETRO_ALLOWED_TOOLS/RETRO_DISALLOWED_TOOLS — never the base issues-only scope", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(doneResult("role-retro-1"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge: new MinimalForge() };
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
  const manifest = mkFakeManifest("retro-attempt");
  const runner = new ScriptedRunner({ ...doneResult("role-retro-1"), contextManifest: manifest });
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge: new MinimalForge() };
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
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: 3, phase: "retro", marker: "prior-marker" });
  assert.equal(marker, "prior-marker");
  assert.equal(runner.calls.length, 0);
  state.close();
});

test("gatherRetroFacts: counts handoffs, drive-needs-human escalations, and ceiling escalations since round start only", async () => {
  const state = new State(":memory:");
  // appendEvent stamps the REAL clock, so the excluded "before round start" event must land
  // strictly before a real-clock started_at (the small sleep guarantees a later millisecond).
  state.appendEvent("handoff", { worker: "lane-x", issue: 99 }); // before round start
  await new Promise((r) => setTimeout(r, 5));
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
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge };
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
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge: new MinimalForge() };
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
  const deps: RetroDeps = { state, cfg, runner, forge };
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

// ── #111 PR-B: engine-side PR creation — verify push, then openPR, partial failures degrade ─

test("createRetroStub: happy path — session writes a proposal scratch; engine verifies the pushed branch and opens the PR itself with the exact title/body", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(doneResult("s1", PROPOSAL_SCRATCH));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round.round_id, phase: "retro", marker: null });

  assert.equal(marker, retroMarker(round.round_id));
  assert.deepEqual(forge.branchExistsCalls, ["retro/round-1-proposal"], "push verified engine-side, by name");
  assert.deepEqual(forge.openPRCalls, [["retro/round-1-proposal", "docs: tighten worker prompt", "## Why\n\nRecurring gate② finding."]]);
  const opened = state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-opened"]);
  assert.equal(opened.length, 1);
  assert.deepEqual(opened[0]!.payload, { round_id: round.round_id, pr: 77, branch: "retro/round-1-proposal" });
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-pr-degraded", "retro-degraded"]), []);
  state.close();
});

test("createRetroStub: quiet round ('none' scratch) — no branch check, no openPR, no degrade; the phase just closes", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(doneResult("s1", "none"));
  const forge = new MinimalForge();
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge };
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
  const runner = new ScriptedRunner(doneResult("s1", PROPOSAL_SCRATCH));
  const forge = new MinimalForge(); // branchExistsResult defaults to false
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge };
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
  const runner = new ScriptedRunner(doneResult("s1", PROPOSAL_SCRATCH));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  forge.openPRError = new Error("boom: PR already exists");
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge };
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
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge };
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
  const runner = new ScriptedRunner(doneResult("s1", "garbage that is not a proposal"), doneResult("s2", PROPOSAL_SCRATCH));
  const forge = new MinimalForge();
  forge.branchExistsResult = true;
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge };
  const stub = createRetroStub(deps);
  await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
  assert.equal(runner.calls.length, 2);
  assert.equal(forge.openPRCalls.length, 1);
  assert.deepEqual(state.eventsSince("2020-01-01T00:00:00.000Z", ["retro-degraded", "retro-pr-degraded"]), []);
  state.close();
});

test("prompts/retro.md instructs the scratch-file contract — fixed path, always written, 'none' for a quiet round — and never a gh command", () => {
  const body = readFileSync(defaultRetroPromptPath(), "utf8");
  assert.ok(body.includes(RETRO_SCRATCH_FILE), "must name the fixed scratch path");
  assert.ok(body.includes("branch:") && body.includes("title:"), "must show the two labeled header lines");
  assert.ok(body.includes("none"), "must name the explicit quiet-round content");
  assert.ok(/always.{0,20}write/is.test(body), "must require the file be written every session");
  assert.ok(!body.includes("gh pr create"), "must not instruct the session to open the PR itself");
});

test("createRetroStub: a failed session is retried once — non-done then done means exactly two sessions, no degradation event", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(timeoutResult("s1"), doneResult("s2"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge: new MinimalForge() };
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
  const runner = new ScriptedRunner(timeoutResult("s1"), timeoutResult("s2"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge: new MinimalForge() };
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
  const deps: RetroDeps = { state, cfg, runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);

  const r1 = await stub.run({ roundId: round1.round_id, phase: "retro", marker: null });
  assert.equal(r1.marker, retroMarker(round1.round_id));
  assert.equal(runner.calls.length, 0, "round 1 is not a multiple of 3 — skipped");

  const r2 = await stub.run({ roundId: round2.round_id, phase: "retro", marker: null });
  assert.equal(r2.marker, retroMarker(round2.round_id));
  assert.equal(runner.calls.length, 0, "round 2 is not a multiple of 3 — skipped");
  state.close();
});

test("createRetroStub: everyNRounds > 1 runs on a round whose id IS a multiple of N", async () => {
  const state = new State(":memory:");
  for (let i = 0; i < 2; i++) state.startRound(`2026-07-10T0${i}:00:00.000Z`); // round_id 1, 2
  const round3 = state.startRound("2026-07-10T03:00:00.000Z"); // round_id 3
  const runner = new ScriptedRunner(doneResult("role-retro-3"));
  const cfg = mkCfg({ roles: { retro: { everyNRounds: 3 } } });
  const deps: RetroDeps = { state, cfg, runner, forge: new MinimalForge() };
  const stub = createRetroStub(deps);
  const { marker } = await stub.run({ roundId: round3.round_id, phase: "retro", marker: null });
  assert.equal(marker, retroMarker(round3.round_id));
  assert.equal(runner.calls.length, 1, "round 3 is a multiple of 3 — retro runs");
  state.close();
});

test("createRetroStub: everyNRounds default (1) runs every round, unchanged from #91 behavior", async () => {
  const state = new State(":memory:");
  const round = state.startRound("2026-07-10T00:00:00.000Z");
  const runner = new ScriptedRunner(doneResult("s1"));
  const deps: RetroDeps = { state, cfg: mkCfg(), runner, forge: new MinimalForge() };
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
    const runner = new ScriptedRunner(doneResult("s1"));
    const cfg = mkCfg({ roles: { retro: { promptFile: promptPath } } });
    const deps: RetroDeps = { state, cfg, runner, forge: new MinimalForge() };
    const stub = createRetroStub(deps);
    await stub.run({ roundId: round.round_id, phase: "retro", marker: null });
    assert.equal(runner.calls[0]!.prompt, `custom retro prompt: round ${round.round_id} handoffs=0`);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("defaultRetroPromptPath: resolves to the shipped prompts/retro.md, which exists and carries the mandatory review-findings-philosophy amendment", () => {
  const p = defaultRetroPromptPath();
  assert.ok(existsSync(p), `expected shipped prompt at ${p}`);
  const body = readFileSync(p, "utf8");
  // #91 issue comment (CTO + user, 2026-07-10): both points must be in the shipped prompt.
  assert.ok(/recurring/i.test(body) && /design signal/i.test(body), "must name recurring findings as a design signal");
  assert.ok(/not a fix queue|point.fix/i.test(body), "must reject a point-fix-queue response to recurring findings");
  assert.ok(/inputs to judge|evidence to weigh/i.test(body), "must treat findings as evidence to judge");
  assert.ok(/accepted/i.test(body) && /rejected/i.test(body), "must require an accepted/rejected classification with reasons");
  for (const v of [
    "{{round.id}}",
    "{{round.handoffs}}",
    "{{round.needsHumanEscalations}}",
    "{{round.ceilingEscalations}}",
    "{{round.digest}}",
  ]) {
    assert.ok(body.includes(v), `retro.md should reference ${v}`);
  }
});

test("prompts/retro.md no longer instructs live gh browsing — it points at the engine-built digest instead", () => {
  const body = readFileSync(defaultRetroPromptPath(), "utf8");
  for (const removed of ["gh pr view", "gh pr list", "gh issue view", "gh issue list"]) {
    assert.ok(!body.includes(removed), `retro.md must not instruct ${removed}`);
  }
  assert.ok(/digest/i.test(body));
});

test("prompts/retro.md never instructs a direct merge/approve — the PR-only path is stated as a non-negotiable", () => {
  const body = readFileSync(defaultRetroPromptPath(), "utf8");
  assert.ok(body.includes("You never:"));
  assert.ok(/merge (your own|.{0,20}any)/i.test(body), "must explicitly forbid self-merge");
  assert.ok(/approve or submit a PR review/i.test(body));
  assert.ok(/exclusively as a pull request/i.test(body));
});

// ── Integration: wired as round.ts's real `retro` peripheral ────────────────────────────────

class MinimalForge implements IForge {
  async listUnplacedIssues() {
    return { issues: [], skipped: 0 };
  }
  async readStartupReconcileData() {
    return { placements: [], openPrs: [] };
  }
  async detectOwnerKind(): Promise<"user"> {
    return "user";
  }
  async getReadyIssues(): Promise<Issue[]> {
    return [];
  }
  async claimIssue(): Promise<void> {}
  async setBoardStatus(): Promise<void> {}
  async addLabel(): Promise<void> {}
  async removeLabel(): Promise<void> {}
  async addPRLabel(): Promise<void> {}
  // #111 PR-B: recording + programmable — the engine-side PR-creation tests drive these.
  openPRCalls: Array<[string, string, string]> = [];
  openPRError: Error | null = null;
  async openPR(branch: string, title: string, body: string): Promise<number> {
    this.openPRCalls.push([branch, title, body]);
    if (this.openPRError) throw this.openPRError;
    return 77;
  }
  branchExistsCalls: string[] = [];
  branchExistsResult = false;
  async branchExists(branch: string): Promise<boolean> {
    this.branchExistsCalls.push(branch);
    return this.branchExistsResult;
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
  async getCommitsSince(): Promise<CommitInfo[]> {
    return [];
  }
  async countOpenIssuesInMilestone(): Promise<number> {
    return 0;
  }
  async listMilestoneTitles(): Promise<string[]> {
    return [];
  }
  async getIssuesNeedingPlanReview(): Promise<Issue[]> {
    return [];
  }
  async getIssueLabels(): Promise<string[]> {
    return [];
  }
  async getIssueComments() {
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
}

const baseIntegrationDeps = (state: State, peripherals: Partial<Record<PeripheralPhase, PeripheralStub>>): RoundDeps => ({
  forge: new MinimalForge(),
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

test("runRounds integration: the real retro stub runs during a normal round close and persists a marker", async () => {
  const state = new State(":memory:");
  const runner = new ScriptedRunner(doneResult("role-retro-int"));
  const retroStub = createRetroStub({ state, cfg: mkCfg(), runner, forge: new MinimalForge() });
  const deps = baseIntegrationDeps(state, { retro: retroStub });
  // Graceful stop mid-round (round.test.ts's pattern): the in-flight round still finishes
  // every phase — retro included — and only the NEXT round is withheld.
  let stop = () => {};
  deps.registerSignals = (requestStop) => {
    stop = requestStop;
    return () => {};
  };
  deps.onRoundPhase = (_roundId, phase) => {
    if (phase === "aligning") stop();
  };
  const result = await runRounds(deps);
  assert.equal(result.stoppedBy, "signal");
  assert.equal(result.rounds, 1);
  assert.equal(runner.calls.length, 1); // retro ran this round — on a GRACEFUL stop
  const round = state.getRound(1)!;
  assert.equal(round.phase, "closed");
  state.close();
});

test("runRounds integration: KILL_SWITCH blocks retro entirely — the stub never runs, no marker, no session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-retro-int-"));
  try {
    const state = new State(join(dir, "sapwood.sqlite"));
    writeFileSync(join(dir, "KILL_SWITCH"), "");
    const runner = new ScriptedRunner(doneResult("role-retro-int"));
    const retroStub = createRetroStub({ state, cfg: mkCfg(), runner, forge: new MinimalForge() });
    const deps = baseIntegrationDeps(state, { retro: retroStub });
    const result = await runRounds(deps);
    assert.equal(result.stoppedBy, "kill-switch");
    assert.equal(runner.calls.length, 0);
    assert.equal(result.rounds, 0);
    state.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
