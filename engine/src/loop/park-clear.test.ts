// park-clear.test.ts (#475): the engine-owned operator clear — receipt-first ordering, the
// live-engine refusal, and the break-glass path's continued heal. Real in-memory/tmpdir State,
// no timers and no clocks steering assertions (repo rule): the ordering assertion is a call
// recorder over the State seam, and the refusal uses THIS process's own (indisputably alive) pid.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runPark } from "../cli.js";
import type { EventKind } from "../state/event-kinds/index.js";
import { INSTANCE_LOCK_FILENAME, type ParkSource, State } from "../state/state.js";
import { clearParksReceiptFirst } from "./park-clear.js";

const park = (s: State, source: ParkSource, reason = `${source} reason`): void => {
  s.enterPark(source, reason, null, "2026-07-31T00:00:00.000Z");
};

/** A State seam that RECORDS the protocol's write order — the only honest way to pin "receipt
 *  precedes row deletion", since after the fact both the append and the delete have happened. */
function recorder(s: State): { state: Parameters<typeof clearParksReceiptFirst>[0]; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    state: {
      parkedSources: () => s.parkedSources(),
      appendEvent: (kind: EventKind, payload: unknown) => {
        calls.push(`append:${kind}`);
        return s.appendEvent(kind, payload);
      },
      clearPark: (source: ParkSource) => {
        calls.push(`clearPark:${source}`);
        s.clearPark(source);
      },
    } as Parameters<typeof clearParksReceiptFirst>[0],
  };
}

test("receipt-first: the park-resumed receipt is appended BEFORE the row is deleted (startup-path order, #473)", () => {
  const s = new State(":memory:");
  park(s, "consecutive-stalls");
  const { state, calls } = recorder(s);
  const cleared = clearParksReceiptFirst(state, "consecutive-stalls");
  assert.deepEqual(
    calls,
    ["append:park-resumed", "clearPark:consecutive-stalls"],
    "receipt first, row deletion second — a kill between them leaves a closed-in-log episode the engine heals, never a receiptless clear",
  );
  assert.equal(cleared.length, 1);
  assert.equal(s.isParked(), false);
  const resumed = s.eventsAfterId(0, ["park-resumed"]);
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0]!.payload, {
    source: "consecutive-stalls",
    enteredAt: "2026-07-31T00:00:00.000Z",
    via: "operator-clear",
  });
  s.close();
});

test("no --source clears every open episode, each receipt-first; a named source clears only that one", () => {
  const s = new State(":memory:");
  park(s, "consecutive-stalls");
  park(s, "idle-churn");
  const only = clearParksReceiptFirst(s, "idle-churn");
  assert.deepEqual(
    only.map((p) => p.source),
    ["idle-churn"],
  );
  assert.equal(s.parkRow("consecutive-stalls") !== null, true, "the untargeted episode stands");

  const { state, calls } = recorder(s);
  park(s, "rapid-restart");
  const all = clearParksReceiptFirst(state, null);
  assert.deepEqual(new Set(all.map((p) => p.source)), new Set(["consecutive-stalls", "rapid-restart"]));
  assert.deepEqual(calls, ["append:park-resumed", "clearPark:consecutive-stalls", "append:park-resumed", "clearPark:rapid-restart"]);
  assert.equal(s.isParked(), false);
  s.close();
});

test("clearing an unparked source is a no-op — no receipt for an episode that was never open", () => {
  const s = new State(":memory:");
  park(s, "idle-churn");
  assert.deepEqual(clearParksReceiptFirst(s, "consecutive-stalls"), []);
  assert.equal(s.eventsAfterId(0, ["park-resumed"]).length, 0);
  assert.equal(s.isParked(), true);
  s.close();
});

// ── the CLI verb ────────────────────────────────────────────────────────────────────────────

function withDataDir(fn: (dir: string, dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-park-clear-"));
  try {
    fn(dir, join(dir, "sapwood.sqlite"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sapwood park clear: clears the episode, takes down the ESCALATION marker, and releases the lock it took", () => {
  withDataDir((dir, dbPath) => {
    const s = new State(dbPath);
    park(s, "consecutive-stalls");
    s.writeEscalationMarker({ source: "consecutive-stalls", reason: "wedged", message: "m", at: "2026-07-31T00:00:00.000Z" });
    s.close();
    assert.equal(existsSync(join(dir, "ESCALATION")), true);

    const res = runPark(["node", "sapwood", "park", "clear", dbPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /consecutive-stalls/);
    assert.equal(existsSync(join(dir, "ESCALATION")), false, "the answered alarm is taken down");
    assert.equal(existsSync(join(dir, INSTANCE_LOCK_FILENAME)), false, "the verb releases the data-dir lock it acquired");

    const after = new State(dbPath);
    assert.equal(after.isParked(), false);
    const resumed = after.eventsAfterId(0, ["park-resumed"]);
    assert.equal(resumed.length, 1);
    assert.equal((resumed[0]!.payload as { via: string }).via, "operator-clear");
    after.close();
  });
});

test("sapwood park clear REFUSES against a data dir held by a live engine — never a silent racy clear", () => {
  withDataDir((dir, dbPath) => {
    const s = new State(dbPath);
    park(s, "idle-churn");
    s.close();
    // The lockfile a live engine holds. `process.pid` is this very process — indisputably alive,
    // so the refusal is decided by a fact, not by a race (instance-lock.ts's pidIsAlive).
    writeFileSync(
      join(dir, INSTANCE_LOCK_FILENAME),
      JSON.stringify({ pid: process.pid, token: "held", acquiredAt: "2026-07-31T00:00:00.000Z" }) + "\n",
    );

    const res = runPark(["node", "sapwood", "park", "clear", dbPath]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /refusing/i);
    assert.match(res.stderr, new RegExp(String(process.pid)));

    const after = new State(dbPath);
    assert.equal(after.isParked(), true, "the park stands — the refusal changed nothing");
    assert.equal(after.eventsAfterId(0, ["park-resumed"]).length, 0, "and left no receipt behind");
    after.close();
    assert.equal(existsSync(join(dir, INSTANCE_LOCK_FILENAME)), true, "the live holder's lock is never displaced");
  });
});

test("sapwood park clear on an unparked engine: nothing to clear, exit 0", () => {
  withDataDir((_dir, dbPath) => {
    new State(dbPath).close();
    const res = runPark(["node", "sapwood", "park", "clear", dbPath]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /no open park episode/);
  });
});

test("sapwood park clear: missing DB, unknown source, and unknown subcommand all fail closed", () => {
  withDataDir((dir, dbPath) => {
    new State(dbPath).close();
    assert.equal(runPark(["node", "sapwood", "park", "clear", join(dir, "nope.sqlite")]).code, 1);
    const bad = runPark(["node", "sapwood", "park", "clear", dbPath, "--source", "bogus"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /unknown --source/);
    assert.equal(runPark(["node", "sapwood", "park", "wat"]).code, 1);
    assert.equal(runPark(["node", "sapwood", "park", "clear", "--help"]).code, 0);
  });
});

test("the verb's clear is the SAME act the engine's startup path honors: a later start neither re-parks nor double-receipts", async () => {
  const { detectConsecutiveStalls } = await import("./stall-breaker.js");
  const { ConfigSchema } = await import("../config/config.js");
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  withDataDir((dir, dbPath) => {
    const s = new State(dbPath);
    for (let i = 0; i < 3; i++) {
      s.appendEvent("run-started", { configHash: "h" });
      s.appendEvent("engine-stalled", { windowMs: 600_000 });
    }
    s.appendEvent("run-started", { configHash: "h" });
    detectConsecutiveStalls(
      s,
      cfg,
      () => new Date(),
      () => {},
    ); // trips + parks + escalates
    assert.equal(s.isParked(), true);
    s.close();

    assert.equal(runPark(["node", "sapwood", "park", "clear", dbPath, "--source", "consecutive-stalls"]).code, 0);

    const next = new State(dbPath);
    next.appendEvent("run-started", { configHash: "h" });
    const outcome = detectConsecutiveStalls(
      next,
      cfg,
      () => new Date(),
      () => {},
    );
    assert.deepEqual(
      outcome,
      { restartAfterStall: false, streak: 0, tripped: false },
      "the receipt closed the episode and reset the streak",
    );
    assert.equal(next.eventsAfterId(0, ["park-resumed"]).length, 1, "exactly one receipt — the startup path adds none of its own");
    assert.equal(existsSync(join(dir, "ESCALATION")), false);
    next.close();
  });
});
