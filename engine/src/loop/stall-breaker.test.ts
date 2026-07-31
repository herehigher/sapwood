// stall-breaker.test.ts (#407, items 2+3): the startup stall-awareness pass and the
// consecutive-stall breaker against a real in-memory State — the same harness shape as
// rapid-restart.test.ts, whose detector this module deliberately mirrors. No timers, no clocks
// steering assertions (repo rule): the streak is a pure fold over synthetic event histories, so
// every table row below is a hand-built ledger, never a wait.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import { State } from "../state/state.js";
import { CONSECUTIVE_STALLS_PARK_SOURCE, detectConsecutiveStalls } from "./stall-breaker.js";

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

const realNow = () => new Date();
const silentLog = (_line: string) => {};

/** Seed one COMPLETED run group: run-started, optional closed rounds, then its terminal
 *  ("stalled" | "clean" | "crash" — crash appends no terminal at all, run-ended's own doc). */
function seedRun(s: State, terminal: "stalled" | "clean" | "crash", closedRounds = 0): void {
  s.appendEvent("run-started", { configHash: "h" });
  for (let i = 0; i < closedRounds; i++) s.appendEvent("round-phase", { round_id: i + 1, phase: "closed" });
  if (terminal === "stalled") s.appendEvent("engine-stalled", { windowMs: 600_000 });
  if (terminal === "clean") s.appendEvent("run-ended", { stoppedBy: "signal" });
}

/** This run's own boot: the detector runs strictly AFTER appendRunStarted (cli.ts). */
function boot(s: State): void {
  s.appendEvent("run-started", { configHash: "h" });
}

test("first run ever: nothing to observe — no restart event, no park, streak 0", () => {
  const s = new State(":memory:");
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: false, streak: 0, tripped: false });
  assert.equal(s.eventsAfterId(0, ["engine-restart-after-stall", "consecutive-stalls-detected"]).length, 0);
  assert.equal(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE), null);
  s.close();
});

test("item 2: a restart after a stalled run appends engine-restart-after-stall and CONTINUES — no park below the threshold", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  boot(s);
  const logged: string[] = [];
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, (line) => logged.push(line));
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 1, tripped: false });
  const restarts = s.eventsAfterId(0, ["engine-restart-after-stall"]);
  assert.equal(restarts.length, 1);
  assert.deepEqual(restarts[0]!.payload, { consecutiveStalls: 1 });
  assert.equal(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE), null, "startup continues — recovery is reconcile's job");
  assert.ok(logged.some((line) => /previous run ended in a self-diagnosed stall/.test(line)));
  // #382 ordering: the audit event lands AFTER this run's own boundary, inside its replay group.
  const trail = s.eventsAfterId(0, ["run-started", "engine-restart-after-stall"]);
  assert.equal(trail[trail.length - 1]!.kind, "engine-restart-after-stall");
  s.close();
});

test("item 2: a restart after a CLEAN stop appends nothing — stall-awareness reads the terminal, not mere restart", () => {
  const s = new State(":memory:");
  seedRun(s, "clean");
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: false, streak: 0, tripped: false });
  assert.equal(s.eventsAfterId(0, ["engine-restart-after-stall"]).length, 0);
  s.close();
});

// ── the breaker table (issue #407's own verification plan) ────────────────────────────────

test("breaker table: N-1 consecutive stalls -> restart (no escalation, no park)", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled"); // N-1 = 2 under the default threshold 3
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 2, tripped: false });
  assert.equal(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE), null);
  assert.equal(s.eventsAfterId(0, ["consecutive-stalls-detected", "park-escalated"]).length, 0);
  s.close();
});

test("breaker table: N stalls with NO round closed between them -> park + immediate local escalation through the existing needs-human channel, evidence preserved", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  const logged: string[] = [];
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, (line) => logged.push(line));
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 3, tripped: true });

  const detected = s.eventsAfterId(0, ["consecutive-stalls-detected"]);
  assert.equal(detected.length, 1);
  const payload = detected[0]!.payload as { streak: number; maxConsecutiveStalls: number; enteredAt: string };
  assert.equal(payload.streak, 3);
  assert.equal(payload.maxConsecutiveStalls, 3);

  // The park is the EXISTING paradigm's episode row: every dispatch gate consults isParked().
  const park = s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE);
  assert.ok(park !== null, "a durable consecutive-stalls park episode exists");
  assert.equal(park!.enteredAt, payload.enteredAt, "the row's entered_at mirrors the detection payload's display metadata");
  assert.equal(s.isParked(), true, "the standard dispatch gates see the park");
  assert.match(park!.reason, /3 consecutive stalled runs with no round closed between them/);
  assert.ok(park!.escalatedAt !== null, "escalated at trip time — the per-tick duration ladder will not re-fire");

  const escalated = s.eventsAfterId(0, ["park-escalated"]);
  assert.equal(escalated.length, 1);
  assert.deepEqual(escalated[0]!.payload, {
    source: CONSECUTIVE_STALLS_PARK_SOURCE,
    channel: "local",
    triggerIssue: null,
    // #477: the dedup key is the detection event's own ledger id; enteredAt rides as display.
    episodeId: detected[0]!.id,
    enteredAt: park!.enteredAt,
  });
  assert.ok(logged.some((line) => /consecutive-stall breaker tripped/.test(line)));
  s.close();
});

test("breaker table (transient-wedge regression fixture): N stalls WITH rounds closed between them never trip — a host-sleep wedge accumulates no strikes", () => {
  const s = new State(":memory:");
  // Each run does real work (closes rounds) before its stall — the transient shape.
  seedRun(s, "stalled", 2);
  seedRun(s, "stalled", 1);
  seedRun(s, "stalled", 3);
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  // The last run's own closed rounds reset the count before its stall — streak is 1, never 3.
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 1, tripped: false });
  assert.equal(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE), null);
  assert.equal(s.eventsAfterId(0, ["consecutive-stalls-detected"]).length, 0);
  s.close();
});

test("breaker table: a single closed round anywhere in the span resets the streak — stall, stall, (round closed + stall) counts 1, not 3", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled", 1); // the third run closed a round before wedging
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 1, tripped: false });
  s.close();
});

test("P1 (PR #473 gate②): clean exits are streak-NEUTRAL — a supervisor that SIGTERMs before each restart cannot launder a deterministic wedge (stall, clean, stall, clean, stall still trips at 3)", () => {
  const s = new State(":memory:");
  // The evasion pattern: every wedge cycle is laced with a clean `run-ended` (systemd
  // KillSignal / launchd stop before each restart). Under the rejected reset-on-clean-run
  // semantics this streak stayed at 1 forever; the AC's own condition — no round CLOSED
  // between the stalls — says it is 3.
  seedRun(s, "stalled");
  seedRun(s, "clean");
  seedRun(s, "stalled");
  seedRun(s, "clean");
  seedRun(s, "stalled");
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 3, tripped: true });
  assert.equal(s.isParked(), true, "the wedge is parked despite the interleaved clean stops");
  s.close();
});

test("alternating stall/crash/stall/crash/stall still trips at 3 stalls — a crash is evidence of nothing, in neither direction", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "crash");
  seedRun(s, "stalled");
  seedRun(s, "crash");
  seedRun(s, "stalled");
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 3, tripped: true });
  assert.equal(s.isParked(), true);
  s.close();
});

test("config-driven threshold (user-tunables rule): liveness.maxConsecutiveStalls 2 trips on the second consecutive stall", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  const cfg = mkCfg({ liveness: { maxConsecutiveStalls: 2 } });
  const outcome = detectConsecutiveStalls(s, cfg, realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 2, tripped: true });
  const payload = s.eventsAfterId(0, ["consecutive-stalls-detected"])[0]!.payload as { maxConsecutiveStalls: number };
  assert.equal(payload.maxConsecutiveStalls, 2);
  s.close();
});

// ── the clearing story (module doc, PR #473 round 3 P3): OPERATOR-EXPLICIT only — an open
// episode never auto-clears, not even on a closed round ───────────────────────────────────

test("re-trip while already parked: dispatch stays gated but NO duplicate detected/escalated events — the episode is the dedup carrier", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // trips, parks, escalates
  // The parked run wedges again (round 1 opens unconditionally, so a peripheral wedge can still
  // stall a parked engine), the supervisor restarts it.
  s.appendEvent("engine-stalled", { windowMs: 600_000 });
  boot(s);
  const second = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(second.tripped, true);
  assert.equal(s.eventsAfterId(0, ["consecutive-stalls-detected"]).length, 1, "one detection per episode, not per restart");
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1, "one escalation per episode — a wedge must not spam");
  assert.equal(s.isParked(), true);
  s.close();
});

test("P3 (PR #473 round 3): a dispatch-empty round closing while parked does NOT clear — loop health is not wedge recovery, and the park stands across the restart", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // trips, parks
  // The exact P3 oscillation seed: the park gates dispatch but not the round loop, so the
  // parked run completes and closes a dispatch-empty round, then exits cleanly under the
  // supervisor's SIGTERM. Under the rejected round-2 semantics the next start cleared here —
  // opening the unbounded park -> empty-round clear -> re-wedge -> re-park cycle.
  s.appendEvent("round-phase", { round_id: 4, phase: "closed" });
  s.appendEvent("run-ended", { stoppedBy: "signal" });
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(outcome.tripped, true, "the open episode holds — no auto-clear on any engine-produced signal");
  assert.equal(s.isParked(), true);
  assert.equal(s.eventsAfterId(0, ["park-resumed"]).length, 0, "no clear receipt was ever written by the engine");
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1, "and the standing escalation is not re-spammed");
  s.close();
});

test("clearing is NOT granted to any exit: the parked run stopped gracefully (run-ended, no round closed) OR killed hard leaves the park standing", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // trips, parks
  // The parked run is SIGTERMed before its round could close (or the wedge is in the round
  // loop itself): a clean terminal, zero progress evidence.
  s.appendEvent("run-ended", { stoppedBy: "signal" });
  boot(s);
  const afterClean = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(afterClean.tripped, true);
  assert.equal(s.isParked(), true, "a clean stop is not an operator clear — the park stands");
  // And a hard kill of the next parked run (no terminal at all) changes nothing either.
  boot(s);
  const afterCrash = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(afterCrash.tripped, true);
  assert.equal(s.isParked(), true, "no operator act, no forgiveness — the park stands");
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1, "and the escalation never spams across those restarts");
  s.close();
});

test("THE operator clear: park_state row deleted on a fully-materialized episode — the next start writes the operator-clear receipt, resumes, and removes the ESCALATION marker", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-stall-opclear-"));
  try {
    const s = new State(join(dir, "sapwood.sqlite"));
    seedRun(s, "stalled");
    seedRun(s, "stalled");
    seedRun(s, "stalled");
    boot(s);
    detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // trips, parks, escalates
    assert.equal(existsSync(join(dir, "ESCALATION")), true, "the standing alarm");
    // The operator's documented clear action (troubleshooting.md): delete the park_state row —
    // the same manual channel the sibling rapid-restart park documents ("both paths flow
    // through the same clearPark").
    s.clearPark(CONSECUTIVE_STALLS_PARK_SOURCE);
    boot(s);
    const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
    assert.equal(outcome.tripped, false, "the operator's act is honored — dispatch resumes");
    assert.equal(s.isParked(), false);
    const resumed = s.eventsAfterId(0, ["park-resumed"]);
    assert.equal(resumed.length, 1, "the clear is receipted in the log");
    const resumedPayload = resumed[0]!.payload as { source: string; via: string };
    assert.equal(resumedPayload.source, CONSECUTIVE_STALLS_PARK_SOURCE);
    assert.equal(resumedPayload.via, "operator-clear");
    assert.equal(existsSync(join(dir, "ESCALATION")), false, "the answered alarm is taken down");
    // And the clear STICKS: a further restart neither re-parks nor re-escalates (the receipt
    // closed the episode and reset the fold's streak).
    boot(s);
    const later = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
    assert.deepEqual(later, { restartAfterStall: false, streak: 0, tripped: false });
    assert.equal(s.eventsAfterId(0, ["consecutive-stalls-detected"]).length, 1);
    assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1);
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a cleared episode's stalls are consumed: after the operator clear, one fresh stall counts 1, not 4 — and re-tripping needs a full new streak (a NEW episode)", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // episode 1: parks
  s.clearPark(CONSECUTIVE_STALLS_PARK_SOURCE); // the operator clears without fixing
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // receipts episode 1, resumes
  // The unfixed wedge stalls this run — ONE stall, not four: episode 1's three are consumed.
  s.appendEvent("engine-stalled", { windowMs: 600_000 });
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 1, tripped: false });
  assert.equal(s.eventsAfterId(0, ["consecutive-stalls-detected"]).length, 1, "still only episode 1's detection");
  // Two more stalls re-accumulate a full streak: a genuinely NEW episode parks and escalates.
  s.appendEvent("engine-stalled", { windowMs: 600_000 });
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  s.appendEvent("engine-stalled", { windowMs: 600_000 });
  boot(s);
  const retrip = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(retrip.tripped, true);
  assert.equal(s.eventsAfterId(0, ["consecutive-stalls-detected"]).length, 2, "episode 2 gets its own detection");
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 2, "and its own single escalation");
  s.close();
});

test("#477 (F25 class): two episodes minted at a FROZEN clock — the same timestamp for both — are two distinct identities: 2 detections AND 2 escalations, never a dedupe collision", () => {
  const s = new State(":memory:");
  // The clock is pinned: every mint in this test carries the IDENTICAL enteredAt. Under the
  // rejected timestamp-keyed identity, episode 2's park-escalated matched episode 1's by
  // enteredAt and was swallowed — the deterministic same-millisecond failure a fast machine
  // reproduced on the real clock. Identity is now the detection event's ledger id, so the
  // frozen clock changes nothing.
  const frozen = () => new Date("2026-07-31T12:00:00.000Z");
  // Episode 1: three stalls, trip, operator clear.
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  const first = detectConsecutiveStalls(s, mkCfg(), frozen, silentLog);
  assert.equal(first.tripped, true);
  s.clearPark(CONSECUTIVE_STALLS_PARK_SOURCE); // the operator clears
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), frozen, silentLog); // receipts episode 1, resumes
  // Episode 2: the unfixed wedge stalls three more times — same frozen timestamp throughout.
  for (let i = 0; i < 3; i++) {
    s.appendEvent("engine-stalled", { windowMs: 600_000 });
    boot(s);
    detectConsecutiveStalls(s, mkCfg(), frozen, silentLog);
  }
  const detected = s.eventsAfterId(0, ["consecutive-stalls-detected"]);
  assert.equal(detected.length, 2, "two distinct episodes were detected");
  assert.notEqual(detected[0]!.id, detected[1]!.id, "distinct ledger-id identities despite the identical timestamp");
  const escalated = s.eventsAfterId(0, ["park-escalated"]);
  assert.equal(escalated.length, 2, "each episode got its own escalation — the second was NOT swallowed by a timestamp collision");
  assert.deepEqual(
    escalated.map((e) => (e.payload as { episodeId?: number }).episodeId),
    detected.map((e) => e.id),
    "each escalation is keyed to its own episode's detection-event id",
  );
  s.close();
});

test("#478 legacy ledger (gate② P2): a pre-#477 open episode's escalation (no episodeId) satisfies the dedupe — the first post-upgrade restart appends NOTHING, and a later NEW episode still escalates with an id", () => {
  const s = new State(":memory:");
  // The pre-#477 shape, verbatim: detection + park row + park-escalated WITHOUT episodeId +
  // escalated_at latch, all intact (in-memory State reports the marker channel as "nothing to
  // heal", i.e. intact). The legacy rule: an escalation lacking episodeId belongs to the open
  // episode iff its ledger id is newer than the episode's detection event id.
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  s.appendEvent("consecutive-stalls-detected", { streak: 3, maxConsecutiveStalls: 3, enteredAt: "2026-07-31T00:00:00.000Z" });
  s.enterPark(CONSECUTIVE_STALLS_PARK_SOURCE, "wedge", null, "2026-07-31T00:00:00.000Z");
  s.appendEvent("park-escalated", {
    source: CONSECUTIVE_STALLS_PARK_SOURCE,
    channel: "local",
    triggerIssue: null,
    enteredAt: "2026-07-31T00:00:00.000Z", // pre-#477: no episodeId
  });
  s.recordParkEscalation(CONSECUTIVE_STALLS_PARK_SOURCE, "2026-07-31T00:00:01.000Z");

  // First post-upgrade restart: the intact episode must NOT be re-escalated (#473's per-episode
  // cross-restart never-spam invariant wins over the upgrade seam).
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(outcome.tripped, true, "the legacy episode stands");
  assert.equal(s.isParked(), true);
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1, "zero new park-escalated — the legacy event satisfies the dedupe");

  // The operator clears the legacy episode — the same membership check must recognize the
  // legacy escalation on the operator-clear path too.
  s.clearPark(CONSECUTIVE_STALLS_PARK_SOURCE);
  boot(s);
  const cleared = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(cleared.tripped, false, "the operator clear is honored for a legacy episode");
  assert.equal(s.eventsAfterId(0, ["park-resumed"]).length, 1, "receipted");

  // And a genuinely NEW episode still escalates normally, id-stamped.
  for (let i = 0; i < 3; i++) {
    s.appendEvent("engine-stalled", { windowMs: 600_000 });
    boot(s);
    detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  }
  const detected = s.eventsAfterId(0, ["consecutive-stalls-detected"]);
  assert.equal(detected.length, 2, "the new episode got its own detection");
  const escalated = s.eventsAfterId(0, ["park-escalated"]);
  assert.equal(escalated.length, 2, "…and its own single escalation");
  assert.equal(
    (escalated[1]!.payload as { episodeId?: number }).episodeId,
    detected[1]!.id,
    "the new escalation is id-stamped to its own episode — the legacy arm never leaks forward",
  );
  s.close();
});

// ── log authority / heal-on-boot (the #431 round-4 write rule, applied here verbatim) ─────

test("heal-on-boot: killed between the detection event and enterPark — the next start rebuilds the park-row MIRROR under the episode's own metadata, no duplicate detection", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  // The kill window: detection landed, the row did not (the crashed detector run's own group has
  // no terminal, so the streak is untouched — exactly why a crash must not reset it).
  s.appendEvent("run-started", { configHash: "h" });
  s.appendEvent("consecutive-stalls-detected", { streak: 3, maxConsecutiveStalls: 3, enteredAt: "2026-07-31T00:00:00.000Z" });
  assert.equal(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE), null);

  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(outcome.tripped, true);
  assert.equal(s.eventsAfterId(0, ["consecutive-stalls-detected"]).length, 1, "dedup reads the LOG — one detection per episode");
  const park = s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE);
  assert.ok(park !== null, "the dispatch-gating row is rebuilt");
  assert.equal(park!.enteredAt, "2026-07-31T00:00:00.000Z", "the row's entered_at mirrors the detection payload's display metadata");
  assert.ok(park!.escalatedAt !== null, "the escalation mirrors ride along");
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1);
  s.close();
});

test("heal-on-boot: escalation latch/marker lost between writes — rebuilt idempotently from the log, never a duplicate park-escalated", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-stall-marker-"));
  try {
    const s = new State(join(dir, "sapwood.sqlite"));
    seedRun(s, "stalled");
    seedRun(s, "stalled");
    seedRun(s, "stalled");
    // Post-crash state: detection + park + park-escalated EVENT landed; marker and latch did not.
    s.appendEvent("consecutive-stalls-detected", { streak: 3, maxConsecutiveStalls: 3, enteredAt: "2026-07-31T00:00:00.000Z" });
    // #477: the escalation is keyed on the detection event's ledger id, read back exactly the
    // way production reads it.
    const episodeId = s.eventsAfterId(0, ["consecutive-stalls-detected"]).at(-1)!.id;
    s.enterPark(CONSECUTIVE_STALLS_PARK_SOURCE, "wedge", null, "2026-07-31T00:00:00.000Z");
    s.appendEvent("park-escalated", {
      source: CONSECUTIVE_STALLS_PARK_SOURCE,
      channel: "local",
      triggerIssue: null,
      episodeId,
      enteredAt: "2026-07-31T00:00:00.000Z",
    });
    assert.equal(existsSync(join(dir, "ESCALATION")), false, "the kill window: event logged, marker lost");

    boot(s);
    detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
    assert.equal(existsSync(join(dir, "ESCALATION")), true, "the marker MIRROR is rebuilt from the log");
    assert.ok(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE)?.escalatedAt !== null, "the latch mirror too");
    assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1, "never a duplicate event — the log side is deduped");
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a stray mirror row on a log-CLOSED episode is cleaned up silently — the log's receipt is authoritative and never duplicated", () => {
  const s = new State(":memory:");
  // A defensive/legacy stray-mirror state: the episode is closed in the log (receipt down) but
  // a park_state row exists anyway (a legacy round-2 DB, or state surgery gone sideways). The
  // log wins: the row is a mirror of a closed episode and gets deleted, with no new receipt.
  s.appendEvent("consecutive-stalls-detected", { streak: 3, maxConsecutiveStalls: 3, enteredAt: "2026-07-30T00:00:00.000Z" });
  s.enterPark(CONSECUTIVE_STALLS_PARK_SOURCE, "old wedge", null, "2026-07-30T00:00:00.000Z");
  s.appendEvent("park-resumed", {
    source: CONSECUTIVE_STALLS_PARK_SOURCE,
    enteredAt: "2026-07-30T00:00:00.000Z",
    via: "operator-clear",
  });
  assert.ok(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE) !== null, "the stray state: receipt down, row still present");

  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(outcome.tripped, false);
  assert.equal(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE), null, "the stray mirror row is deleted");
  assert.equal(s.eventsAfterId(0, ["park-resumed"]).length, 1, "no duplicate receipt — the log already closed the episode");
  s.close();
});

test("a State failure inside detection is contained: logged, startup continues, nothing thrown", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  boot(s);
  const broken = new Proxy(s, {
    get(target, prop, receiver) {
      if (prop === "eventsAfterId") {
        return () => {
          throw new Error("disk exploded");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const logged: string[] = [];
  const outcome = detectConsecutiveStalls(broken as State, mkCfg(), realNow, (line) => logged.push(line));
  assert.deepEqual(outcome, { restartAfterStall: false, streak: 0, tripped: false });
  assert.ok(logged.some((line) => /consecutive-stall detection failed \(non-fatal/.test(line)));
  s.close();
});

test("the rapid-restart and consecutive-stalls parks are independent episodes on the shared park_state machinery", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  s.enterPark("rapid-restart", "storm", null, "2026-07-31T00:00:00.000Z");
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.ok(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE) !== null);
  assert.ok(s.parkRow("rapid-restart") !== null, "the sibling episode is untouched");
  assert.equal(s.parkedSources().length, 2);
  s.close();
});
