// rapid-restart.test.ts (#431, owner amendment 1): the crash-loop detector against a real
// in-memory State. Clock discipline: `run-started` births are appended with the REAL machine
// clock (appendEvent's own doc — deliberate); the detector's window is steered by injecting a
// shifted `now`, never by sleeping — a cutoff shifted an hour into the future excludes
// just-appended births deterministically, and a present-time cutoff includes them with a
// 10-minute window against appends that happened microseconds ago (no assertion rides on
// subprocess speed or scheduler behavior).
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "../config/config.js";
import { State } from "../state/state.js";
import { detectRapidRestart, RAPID_RESTART_PARK_SOURCE } from "./rapid-restart.js";

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

const realNow = () => new Date();
const silentLog = (_line: string) => {};

function seedBirths(s: State, n: number): void {
  for (let i = 0; i < n; i++) s.appendEvent("run-started", { configHash: "h" });
}

test("under the threshold: no trip, no park, no events beyond the births themselves", () => {
  const s = new State(":memory:");
  seedBirths(s, 4); // 4 < default maxBirths 5
  const outcome = detectRapidRestart(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { tripped: false, births: 4 });
  assert.equal(s.parkRow(RAPID_RESTART_PARK_SOURCE), null);
  assert.equal(s.eventsAfterId(0, ["rapid-restart-detected", "park-escalated", "park-resumed"]).length, 0);
  s.close();
});

test("trip at the threshold: rapid-restart-detected + a durable park (dispatch-gating) + an immediate local park-escalated, all AFTER the run boundary", () => {
  const s = new State(":memory:");
  seedBirths(s, 5);
  const logged: string[] = [];
  const outcome = detectRapidRestart(s, mkCfg(), realNow, (line) => logged.push(line));
  assert.deepEqual(outcome, { tripped: true, births: 5 });

  const detected = s.eventsAfterId(0, ["rapid-restart-detected"]);
  assert.equal(detected.length, 1);
  const detectedPayload = detected[0]!.payload as { births: number; windowSec: number; maxBirths: number; enteredAt: string };
  assert.equal(detectedPayload.births, 5);
  assert.equal(detectedPayload.windowSec, 600);
  assert.equal(detectedPayload.maxBirths, 5);

  // The park is the EXISTING paradigm's episode row: every dispatch gate consults isParked().
  const park = s.parkRow(RAPID_RESTART_PARK_SOURCE);
  assert.ok(park !== null, "a durable rapid-restart park episode exists");
  assert.equal(park!.enteredAt, detectedPayload.enteredAt, "round 4: the row mirrors the LOG's minted episode identity");
  assert.equal(s.isParked(), true, "the standard dispatch gates see the park");
  assert.match(park!.reason, /5 engine starts within 600s/);
  assert.equal(park!.triggerIssue, null);
  assert.ok(park!.escalatedAt !== null, "escalated at trip time — the per-tick duration escalation will not re-fire");

  const escalated = s.eventsAfterId(0, ["park-escalated"]);
  assert.equal(escalated.length, 1);
  assert.deepEqual(escalated[0]!.payload, {
    source: RAPID_RESTART_PARK_SOURCE,
    channel: "local",
    triggerIssue: null,
    // round 3: the episode identity rides in the payload — the log-keyed dedup/heal key.
    enteredAt: park!.enteredAt,
  });

  // #382 ordering: every detector event carries a HIGHER id than the last run-started — the
  // detection lands inside this run's replay group, never before the run boundary.
  const all = s.eventsAfterId(0, ["run-started", "rapid-restart-detected", "park-escalated"]);
  assert.deepEqual(all.map((e) => e.kind).slice(-2), ["rapid-restart-detected", "park-escalated"]);
  assert.ok(logged.some((line) => /rapid-restart detector tripped/.test(line)));
  s.close();
});

test("aged births never count: the same 5 births observed from an hour later are outside the window — no trip", () => {
  const s = new State(":memory:");
  seedBirths(s, 5);
  const anHourAhead = () => new Date(Date.now() + 3600_000);
  const outcome = detectRapidRestart(s, mkCfg(), anHourAhead, silentLog);
  assert.deepEqual(outcome, { tripped: false, births: 0 });
  assert.equal(s.parkRow(RAPID_RESTART_PARK_SOURCE), null);
  s.close();
});

test("a clean start CLEARS a stale rapid-restart park (the episode's only auto-resume) with a park-resumed receipt", () => {
  const s = new State(":memory:");
  // A faithful open episode: the detection event (the LOG fact, round 4's dedup carrier) plus
  // its park-row mirror — exactly what a real trip leaves behind.
  s.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5, enteredAt: "2026-07-30T00:00:00.000Z" });
  s.enterPark(RAPID_RESTART_PARK_SOURCE, "old storm", null, "2026-07-30T00:00:00.000Z");
  assert.equal(s.isParked(), true);
  const outcome = detectRapidRestart(s, mkCfg(), (() => new Date(Date.now() + 3600_000)) as () => Date, silentLog);
  assert.equal(outcome.tripped, false);
  assert.equal(s.parkRow(RAPID_RESTART_PARK_SOURCE), null, "the drained window is the sanctioned-recovery signal");
  assert.equal(s.isParked(), false);
  const resumed = s.eventsAfterId(0, ["park-resumed"]);
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0]!.payload, {
    source: RAPID_RESTART_PARK_SOURCE,
    enteredAt: "2026-07-30T00:00:00.000Z",
    via: "restart-window-clear",
  });
  s.close();
});

test("re-trip while already parked: dispatch stays gated but NO duplicate detected/escalated events — the episode row is the dedup carrier", () => {
  const s = new State(":memory:");
  seedBirths(s, 5);
  detectRapidRestart(s, mkCfg(), realNow, silentLog); // birth N: trips, parks, escalates
  s.appendEvent("run-started", {}); // the crash loop restarts again — birth N+1
  const second = detectRapidRestart(s, mkCfg(), realNow, silentLog);
  assert.equal(second.tripped, true);
  assert.equal(s.eventsAfterId(0, ["rapid-restart-detected"]).length, 1, "one detection event per episode, not per birth");
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1, "one escalation per episode — a crash loop must not spam");
  assert.equal(s.isParked(), true);
  s.close();
});

test("only TRUE process births count: steady-state event kinds (heartbeats etc.) can never trip the detector, by construction", () => {
  const s = new State(":memory:");
  seedBirths(s, 2);
  for (let i = 0; i < 50; i++) s.appendEvent("park-wait-heartbeat", { parked: false }); // the F29 wedge's own spam
  const outcome = detectRapidRestart(s, mkCfg(), realNow, silentLog);
  assert.deepEqual(outcome, { tripped: false, births: 2 });
  s.close();
});

test("config keys steer the detector (user-tunables rule): a 2-birth threshold trips on the second start", () => {
  const s = new State(":memory:");
  seedBirths(s, 2);
  const cfg = mkCfg({ engine: { rapidRestart: { maxBirths: 2, windowSec: 1200 } } });
  const outcome = detectRapidRestart(s, cfg, realNow, silentLog);
  assert.deepEqual(outcome, { tripped: true, births: 2 });
  const detected = s.eventsAfterId(0, ["rapid-restart-detected"]);
  const p2 = detected[0]!.payload as { births: number; windowSec: number; maxBirths: number; enteredAt: string };
  assert.equal(p2.births, 2);
  assert.equal(p2.windowSec, 1200);
  assert.equal(typeof p2.enteredAt, "string");
  s.close();
});

test("a State failure inside detection is contained: logged, startup continues, nothing thrown", () => {
  const s = new State(":memory:");
  seedBirths(s, 5);
  const broken = new Proxy(s, {
    get(target, prop, receiver) {
      if (prop === "countEventsBetween") {
        return () => {
          throw new Error("disk exploded");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const logged: string[] = [];
  const outcome = detectRapidRestart(broken as State, mkCfg(), realNow, (line) => logged.push(line));
  assert.deepEqual(outcome, { tripped: false, births: 0 });
  assert.ok(logged.some((line) => /rapid-restart detection failed \(non-fatal/.test(line)));
  s.close();
});

test("heal-on-boot (#431 round 2, codex P2): a birth that died between enterPark and the escalation latch is repaired by the NEXT boot — marker/latch/park-escalated land once, idempotently", () => {
  const s = new State(":memory:");
  seedBirths(s, 5);
  // The post-crash state, constructed directly: detection + park landed, escalation did not
  // (escalated_at null, no park-escalated event) — the exact window codex reproduced.
  s.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5 });
  s.enterPark(
    RAPID_RESTART_PARK_SOURCE,
    "5 engine starts within 600s (threshold 5) — crash loop suspected",
    null,
    "2026-07-31T00:00:00.000Z",
  );
  assert.equal(s.parkRow(RAPID_RESTART_PARK_SOURCE)?.escalatedAt, null);

  s.appendEvent("run-started", {}); // the next boot's own birth
  const outcome = detectRapidRestart(s, mkCfg(), realNow, silentLog);
  assert.equal(outcome.tripped, true);
  assert.ok(s.parkRow(RAPID_RESTART_PARK_SOURCE)?.escalatedAt !== null, "the latch is healed");
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1, "exactly one escalation lands for the episode");
  assert.equal(
    s.eventsAfterId(0, ["rapid-restart-detected"]).length,
    1,
    "no duplicate detection event — the episode row remains the dedup carrier",
  );

  // A further birth in the same storm: fully idempotent — nothing new lands.
  s.appendEvent("run-started", {});
  detectRapidRestart(s, mkCfg(), realNow, silentLog);
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1);
  s.close();
});

test("future-dated births never count (#431 round 2, codex P3): rows past the detector's own clock can neither false-trip nor defeat a manual park clear", () => {
  const s = new State(":memory:");
  seedBirths(s, 5); // stamped with the REAL clock — i.e. the FUTURE relative to the detector's shifted 'now'
  // A restored-DB / backward-clock-step machine: the detector's clock sits an hour BEHIND the
  // rows' stamps. Without the closed window's upper bound these five future rows would trip it.
  const anHourBehind = () => new Date(Date.now() - 3600_000);
  const outcome = detectRapidRestart(s, mkCfg(), anHourBehind, silentLog);
  assert.deepEqual(outcome, { tripped: false, births: 0 });
  assert.equal(s.parkRow(RAPID_RESTART_PARK_SOURCE), null, "no false trip");

  // And the manual-clear path stays honored: a hand-deleted park is NOT immediately re-created
  // by future-dated rows (the troubleshooting contract).
  s.enterPark(RAPID_RESTART_PARK_SOURCE, "old storm", null, "2026-07-30T00:00:00.000Z");
  s.clearPark(RAPID_RESTART_PARK_SOURCE); // the operator's manual clear
  const again = detectRapidRestart(s, mkCfg(), anHourBehind, silentLog);
  assert.equal(again.tripped, false);
  assert.equal(s.parkRow(RAPID_RESTART_PARK_SOURCE), null, "the manual clear sticks");
  s.close();
});

test("heal-on-boot (#431 round 3, codex P3): latch set but NO park-escalated event (died between the two under round 2's order) — the log is repaired without touching the latch semantics", () => {
  const s = new State(":memory:");
  seedBirths(s, 5);
  // Codex's exact reproduction state: detection + park + LATCH landed, the event did not.
  s.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5 });
  s.enterPark(
    RAPID_RESTART_PARK_SOURCE,
    "5 engine starts within 600s (threshold 5) — crash loop suspected",
    null,
    "2026-07-31T00:00:00.000Z",
  );
  s.recordParkEscalation(RAPID_RESTART_PARK_SOURCE, "2026-07-31T00:00:01.000Z");
  assert.ok(s.parkRow(RAPID_RESTART_PARK_SOURCE)?.escalatedAt !== null);
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 0, "the round-2 wedge: latched but never logged");

  s.appendEvent("run-started", {}); // the next boot's own birth
  const outcome = detectRapidRestart(s, mkCfg(), realNow, silentLog);
  assert.equal(outcome.tripped, true);
  const escalated = s.eventsAfterId(0, ["park-escalated"]);
  assert.equal(escalated.length, 1, "the missing audit record is healed — the log is the fact, the latch only mirrors it");
  assert.deepEqual(escalated[0]!.payload, {
    source: RAPID_RESTART_PARK_SOURCE,
    channel: "local",
    triggerIssue: null,
    enteredAt: "2026-07-31T00:00:00.000Z",
  });
  // And idempotent thereafter.
  s.appendEvent("run-started", {});
  detectRapidRestart(s, mkCfg(), realNow, silentLog);
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1);
  s.close();
});

test("heal-on-boot (#431 round 3): event present but latch null (died between event and latch under the NEW order) — the latch is mirrored from the log, never a duplicate event", () => {
  const s = new State(":memory:");
  seedBirths(s, 5);
  s.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5 });
  s.enterPark(RAPID_RESTART_PARK_SOURCE, "storm", null, "2026-07-31T00:00:00.000Z");
  s.appendEvent("park-escalated", {
    source: RAPID_RESTART_PARK_SOURCE,
    channel: "local",
    triggerIssue: null,
    enteredAt: "2026-07-31T00:00:00.000Z",
  });
  assert.equal(s.parkRow(RAPID_RESTART_PARK_SOURCE)?.escalatedAt, null);

  s.appendEvent("run-started", {});
  detectRapidRestart(s, mkCfg(), realNow, silentLog);
  assert.ok(s.parkRow(RAPID_RESTART_PARK_SOURCE)?.escalatedAt !== null, "the latch is mirrored from the log");
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1, "no duplicate event — the log already carries the fact");
  s.close();
});

test("log authority (#431 round 4, codex P2): killed between the park-escalated event and the marker write — the next boot rebuilds the ESCALATION marker, not just the latch", () => {
  // Codex's repro asserted markerExistsAfterHeal:false under round 3. File-backed State so the
  // marker channel actually exists.
  const dir = mkdtempSync(join(tmpdir(), "sapwood-rr-marker-"));
  try {
    const s = new State(join(dir, "sapwood.sqlite"));
    seedBirths(s, 5);
    // Post-crash state: detection + park + park-escalated EVENT landed; marker and latch did not.
    s.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5, enteredAt: "2026-07-31T00:00:00.000Z" });
    s.enterPark(RAPID_RESTART_PARK_SOURCE, "storm", null, "2026-07-31T00:00:00.000Z");
    s.appendEvent("park-escalated", {
      source: RAPID_RESTART_PARK_SOURCE,
      channel: "local",
      triggerIssue: null,
      enteredAt: "2026-07-31T00:00:00.000Z",
    });
    assert.equal(existsSync(join(dir, "ESCALATION")), false, "the kill window: event logged, marker lost");

    s.appendEvent("run-started", {});
    detectRapidRestart(s, mkCfg(), realNow, silentLog);
    assert.equal(existsSync(join(dir, "ESCALATION")), true, "the marker MIRROR is rebuilt from the log");
    assert.ok(s.parkRow(RAPID_RESTART_PARK_SOURCE)?.escalatedAt !== null, "the latch mirror too");
    assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1, "and never a duplicate event — the log side is deduped");
    s.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("log authority (#431 round 4, codex P2): auto-clear is RECEIPT-FIRST — killed between the receipt and clearPark, the next boot deletes the stray row silently (no duplicate receipt, episode already closed in the log)", () => {
  const s = new State(":memory:");
  // Post-crash state under the NEW order: episode opened + receipt appended, row still present.
  s.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5, enteredAt: "2026-07-30T00:00:00.000Z" });
  s.enterPark(RAPID_RESTART_PARK_SOURCE, "old storm", null, "2026-07-30T00:00:00.000Z");
  s.appendEvent("park-resumed", { source: RAPID_RESTART_PARK_SOURCE, enteredAt: "2026-07-30T00:00:00.000Z", via: "restart-window-clear" });
  assert.ok(s.parkRow(RAPID_RESTART_PARK_SOURCE) !== null, "the kill window: receipt down, row not yet deleted");

  const outcome = detectRapidRestart(s, mkCfg(), (() => new Date(Date.now() + 3600_000)) as () => Date, silentLog);
  assert.equal(outcome.tripped, false);
  assert.equal(s.parkRow(RAPID_RESTART_PARK_SOURCE), null, "the stray mirror row is deleted");
  assert.equal(s.eventsAfterId(0, ["park-resumed"]).length, 1, "no duplicate receipt — the log already closed the episode");
  // The round-3 order's loss (row deleted, receipt never written, episode unrecoverable) is
  // unrepresentable going forward: the receipt is the FIRST write of the clear transition.
  s.close();
});

test("log authority (#431 round 4, codex P3): killed between rapid-restart-detected and enterPark — the next birth does NOT duplicate the detection, and the park-row MIRROR is rebuilt under the episode's minted identity", () => {
  const s = new State(":memory:");
  seedBirths(s, 5);
  // Codex's repro: detection landed, the row did not; round 3's row-keyed dedup then appended
  // detectedEvents:2 for the same uninterrupted storm.
  s.appendEvent("rapid-restart-detected", { births: 5, windowSec: 600, maxBirths: 5, enteredAt: "2026-07-31T00:00:00.000Z" });
  assert.equal(s.parkRow(RAPID_RESTART_PARK_SOURCE), null);

  s.appendEvent("run-started", {}); // the next birth in the same storm
  const outcome = detectRapidRestart(s, mkCfg(), realNow, silentLog);
  assert.equal(outcome.tripped, true);
  assert.equal(s.eventsAfterId(0, ["rapid-restart-detected"]).length, 1, "dedup reads the LOG — one detection per episode, not per birth");
  const park = s.parkRow(RAPID_RESTART_PARK_SOURCE);
  assert.ok(park !== null, "the dispatch-gating row is rebuilt");
  assert.equal(park!.enteredAt, "2026-07-31T00:00:00.000Z", "under the episode's own minted identity, not a fresh one");
  assert.ok(park!.escalatedAt !== null, "the escalation mirrors ride along");
  assert.equal(s.eventsAfterId(0, ["park-escalated"]).length, 1);
  s.close();
});
