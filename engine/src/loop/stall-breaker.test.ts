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
  assert.equal(park!.enteredAt, payload.enteredAt, "the row mirrors the LOG's minted episode identity");
  assert.equal(s.isParked(), true, "the standard dispatch gates see the park");
  assert.match(park!.reason, /3 consecutive stalled runs with no round closed between them/);
  assert.ok(park!.escalatedAt !== null, "escalated at trip time — the per-tick duration ladder will not re-fire");

  const escalated = s.eventsAfterId(0, ["park-escalated"]);
  assert.equal(escalated.length, 1);
  assert.deepEqual(escalated[0]!.payload, {
    source: CONSECUTIVE_STALLS_PARK_SOURCE,
    channel: "local",
    triggerIssue: null,
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

test("a CLEAN run between stalls resets the streak ('the last N runs all ended stalled'), a CRASHED run leaves it unchanged (evidence of nothing)", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "clean");
  seedRun(s, "stalled");
  seedRun(s, "crash");
  seedRun(s, "stalled");
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  // clean reset after stall #1; then stall (1), crash (unchanged), stall (2).
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 2, tripped: false });
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

// ── the clearing story (module doc): a graceful stop of the parked run breaks the streak ──

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

test("clearing: the operator gracefully stops the parked engine (run-ended) and restarts — the streak is broken, the park clears with a park-resumed receipt", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // trips, parks
  // The parked run holds at the dispatch gate until the operator SIGTERMs it: a clean exit
  // writes its run-ended terminal (cli.ts item 1) — the human's own fingerprint in the log.
  s.appendEvent("run-ended", { stoppedBy: "signal" });
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: false, streak: 0, tripped: false });
  assert.equal(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE), null, "the broken streak is the sanctioned-recovery signal");
  assert.equal(s.isParked(), false);
  const resumed = s.eventsAfterId(0, ["park-resumed"]);
  assert.equal(resumed.length, 1);
  const resumedPayload = resumed[0]!.payload as { source: string; via: string };
  assert.equal(resumedPayload.source, CONSECUTIVE_STALLS_PARK_SOURCE);
  assert.equal(resumedPayload.via, "stall-streak-clear");
  s.close();
});

test("clearing is NOT granted to an unsanctioned death: the parked run killed hard (no terminal) leaves the streak — and the park — standing", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // trips, parks
  // SIGKILL/OOM: the parked run dies with no terminal at all. A crash is evidence of nothing.
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.equal(outcome.tripped, true);
  assert.equal(s.isParked(), true, "no clean stop, no forgiveness — the park stands");
  s.close();
});

test("a closed episode's stalls are consumed: after a clear, old stalls never re-trip a fresh start (park-resumed resets the fold)", () => {
  const s = new State(":memory:");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  seedRun(s, "stalled");
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // episode 1: parks
  s.appendEvent("run-ended", { stoppedBy: "signal" });
  boot(s);
  detectConsecutiveStalls(s, mkCfg(), realNow, silentLog); // clears episode 1
  // This cleared run itself wedges once (the operator resumed without fixing) — ONE stall, not
  // four: the closed episode's three must not count again.
  s.appendEvent("engine-stalled", { windowMs: 600_000 });
  boot(s);
  const outcome = detectConsecutiveStalls(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { restartAfterStall: true, streak: 1, tripped: false });
  assert.equal(s.eventsAfterId(0, ["consecutive-stalls-detected"]).length, 1, "still only episode 1's detection");
  s.close();
});

// ── log authority / heal-on-boot (the #431 round-4 write rule, applied here verbatim) ─────

test("heal-on-boot: killed between the detection event and enterPark — the next start rebuilds the park-row MIRROR under the episode's minted identity, no duplicate detection", () => {
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
  assert.equal(park!.enteredAt, "2026-07-31T00:00:00.000Z", "under the episode's own minted identity");
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
    s.enterPark(CONSECUTIVE_STALLS_PARK_SOURCE, "wedge", null, "2026-07-31T00:00:00.000Z");
    s.appendEvent("park-escalated", {
      source: CONSECUTIVE_STALLS_PARK_SOURCE,
      channel: "local",
      triggerIssue: null,
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

test("clearing is RECEIPT-FIRST: killed between the park-resumed receipt and clearPark, the next start deletes the stray row silently (no duplicate receipt)", () => {
  const s = new State(":memory:");
  // Post-crash state under the write order: episode opened + receipt appended, row still present.
  s.appendEvent("consecutive-stalls-detected", { streak: 3, maxConsecutiveStalls: 3, enteredAt: "2026-07-30T00:00:00.000Z" });
  s.enterPark(CONSECUTIVE_STALLS_PARK_SOURCE, "old wedge", null, "2026-07-30T00:00:00.000Z");
  s.appendEvent("park-resumed", {
    source: CONSECUTIVE_STALLS_PARK_SOURCE,
    enteredAt: "2026-07-30T00:00:00.000Z",
    via: "stall-streak-clear",
  });
  assert.ok(s.parkRow(CONSECUTIVE_STALLS_PARK_SOURCE) !== null, "the kill window: receipt down, row not yet deleted");

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
