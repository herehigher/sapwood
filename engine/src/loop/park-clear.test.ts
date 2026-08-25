// park-clear.test.ts (#475): the engine-owned operator clear — receipt-first ordering, the
// live-engine refusal, and the break-glass path's continued heal. Real in-memory/tmpdir State,
// no timers and no clocks steering assertions (repo rule): the ordering assertion is a call
// recorder over the State seam, and the refusal uses THIS process's own (indisputably alive) pid.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseParkArgs, runPark } from "../cli.js";
import type { EventKind } from "../state/event-kinds/index.js";
import { DEFAULT_DB_PATH, INSTANCE_LOCK_FILENAME, type ParkSource, State } from "../state/state.js";
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

// ── #644: `--reason` on the operator clear — recorded verbatim in the receipt, never on the
// legacy no-reason path (reverse test: an omitted clearReason must not even add a null/undefined
// key, so an existing reader of this payload shape sees byte-identical JSON to before #644).
test("#644: clearReason, when given, lands verbatim in the SAME park-resumed receipt payload — sits alongside via/source/enteredAt, never replaces them", () => {
  const s = new State(":memory:");
  park(s, "consecutive-stalls");
  const cleared = clearParksReceiptFirst(s, "consecutive-stalls", "owner ruling #644, PM session 2026-08-04");
  assert.equal(cleared.length, 1);
  const resumed = s.eventsAfterId(0, ["park-resumed"]);
  assert.equal(resumed.length, 1);
  assert.deepEqual(resumed[0]!.payload, {
    source: "consecutive-stalls",
    enteredAt: "2026-07-31T00:00:00.000Z",
    via: "operator-clear",
    clearReason: "owner ruling #644, PM session 2026-08-04",
  });
  s.close();
});

test("#644 reverse test: omitting clearReason leaves the receipt payload byte-identical to pre-#644 — no clearReason key at all, not even null/undefined", () => {
  const s = new State(":memory:");
  park(s, "consecutive-stalls");
  clearParksReceiptFirst(s, "consecutive-stalls");
  const resumed = s.eventsAfterId(0, ["park-resumed"]);
  assert.deepEqual(Object.keys(resumed[0]!.payload as object).sort(), ["enteredAt", "source", "via"], "no clearReason key present at all");
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
//
// #1078: `park clear` is a MUTATING command — no db-path positional any more (AC4). Every test
// below chdirs into a fresh tmp dir instead of passing an explicit db-path, exactly the DEFAULT,
// cwd-relative `.sapwood/` root a real operator's bare `sapwood park clear` would use (same
// pattern stop-control.test.ts's own #1077 "self-declares the root" test already established).

function withDataDir(fn: (dir: string, dbPath: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-park-clear-"));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    fn(dir, join(dir, ".sapwood", "sapwood.sqlite"));
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("sapwood park clear: clears the episode, takes down the ESCALATION marker, and releases the lock it took", () => {
  withDataDir((dir, dbPath) => {
    const s = new State(dbPath);
    park(s, "consecutive-stalls");
    s.writeEscalationMarker({ source: "consecutive-stalls", reason: "wedged", message: "m", at: "2026-07-31T00:00:00.000Z" });
    s.close();
    assert.equal(existsSync(join(dir, ".sapwood", "ESCALATION")), true);

    const res = runPark(["node", "sapwood", "park", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /consecutive-stalls/);
    assert.equal(existsSync(join(dir, ".sapwood", "ESCALATION")), false, "the answered alarm is taken down");
    assert.equal(existsSync(join(dir, ".sapwood", INSTANCE_LOCK_FILENAME)), false, "the verb releases the data-dir lock it acquired");

    const after = new State(dbPath);
    assert.equal(after.isParked(), false);
    const resumed = after.eventsAfterId(0, ["park-resumed"]);
    assert.equal(resumed.length, 1);
    assert.equal((resumed[0]!.payload as { via: string }).via, "operator-clear");
    after.close();
  });
});

test("#644: sapwood park clear --reason lands the text in the receipt payload (read back from the event row) and echoes it in stdout", () => {
  withDataDir((_dir, dbPath) => {
    const s = new State(dbPath);
    park(s, "idle-churn");
    s.close();

    const res = runPark(["node", "sapwood", "park", "clear", "--reason", "confirmed with owner in #604 thread"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /confirmed with owner in #604 thread/, "the reason text is echoed in stdout");

    const after = new State(dbPath);
    const resumed = after.eventsAfterId(0, ["park-resumed"]);
    assert.equal(resumed.length, 1);
    assert.equal((resumed[0]!.payload as { clearReason?: string }).clearReason, "confirmed with owner in #604 thread");
    after.close();
  });
});

test("#644 reverse test: sapwood park clear WITHOUT --reason is byte-identical to pre-#644 behavior — same stdout shape, no clearReason in the payload", () => {
  withDataDir((dir, dbPath) => {
    const s = new State(dbPath);
    park(s, "consecutive-stalls");
    s.writeEscalationMarker({ source: "consecutive-stalls", reason: "wedged", message: "m", at: "2026-07-31T00:00:00.000Z" });
    s.close();

    const res = runPark(["node", "sapwood", "park", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(
      res.stdout,
      "sapwood park clear: 1 park episode(s) cleared, receipt-first\n  cleared consecutive-stalls (parked since 2026-07-31T00:00:00.000Z) — reason: consecutive-stalls reason\n",
    );
    assert.equal(existsSync(join(dir, ".sapwood", "ESCALATION")), false);

    const after = new State(dbPath);
    const resumed = after.eventsAfterId(0, ["park-resumed"]);
    assert.deepEqual(Object.keys(resumed[0]!.payload as object).sort(), ["enteredAt", "source", "via"]);
    after.close();
  });
});

test("#644: sapwood park clear --reason with empty or whitespace-only text is REJECTED fail-closed", () => {
  withDataDir((_dir, dbPath) => {
    new State(dbPath).close();
    const empty = runPark(["node", "sapwood", "park", "clear", "--reason", ""]);
    assert.equal(empty.code, 1);
    assert.match(empty.stderr, /--reason/);

    const whitespace = runPark(["node", "sapwood", "park", "clear", "--reason", "   "]);
    assert.equal(whitespace.code, 1);
    assert.match(whitespace.stderr, /--reason/);
  });
});

test("#644: sapwood park clear --reason with a missing value fails closed, same stance as --source", () => {
  withDataDir((_dir, dbPath) => {
    new State(dbPath).close();
    const missing = runPark(["node", "sapwood", "park", "clear", "--reason"]);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /--reason requires/);

    const flagShaped = runPark(["node", "sapwood", "park", "clear", "--reason", "--source"]);
    assert.equal(flagShaped.code, 1);
    assert.match(flagShaped.stderr, /--reason requires/);
  });
});

test("#644: parseParkArgs — --reason parses to ParkArgs.reason, and the unknown-flag stance is unchanged", () => {
  const ok = parseParkArgs(["node", "sapwood", "park", "clear", "--reason", "text here"]);
  assert.equal(ok.help, false);
  assert.equal(ok.error, undefined);
  assert.equal(ok.reason, "text here");

  const unknown = parseParkArgs(["node", "sapwood", "park", "clear", "--bogus"]);
  assert.equal(unknown.help, false);
  assert.match(unknown.error ?? "", /unknown flag: --bogus/);
});

// #1078 AC4: `park clear` is a mutating command — a positional argument (the pre-#1078 db-path
// escape hatch) is now rejected outright rather than silently reinterpreted as a DB to operate
// on. `status`/`events` deliberately keep accepting one (they stay read-only) — see cli.test.ts.
test("#1078 AC4: sapwood park clear REJECTS a positional argument — no more db-path override on a mutating command", () => {
  const res = parseParkArgs(["node", "sapwood", "park", "clear", "/some/other/db.sqlite"]);
  assert.equal(res.help, false);
  assert.match(res.error ?? "", /unexpected argument/);
  assert.equal(res.dbPath, DEFAULT_DB_PATH, "dbPath stays the fixed default regardless of the rejected positional");
});

test("sapwood park clear REFUSES against a data dir held by a live engine — never a silent racy clear", () => {
  withDataDir((dir, dbPath) => {
    const s = new State(dbPath);
    park(s, "idle-churn");
    s.close();
    // The lockfile a live engine holds. `process.pid` is this very process — indisputably alive,
    // so the refusal is decided by a fact, not by a race (instance-lock.ts's pidIsAlive).
    writeFileSync(
      join(dir, ".sapwood", INSTANCE_LOCK_FILENAME),
      JSON.stringify({ pid: process.pid, token: "held", acquiredAt: "2026-07-31T00:00:00.000Z" }) + "\n",
    );

    const res = runPark(["node", "sapwood", "park", "clear"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /refusing/i);
    assert.match(res.stderr, new RegExp(String(process.pid)));

    const after = new State(dbPath);
    assert.equal(after.isParked(), true, "the park stands — the refusal changed nothing");
    assert.equal(after.eventsAfterId(0, ["park-resumed"]).length, 0, "and left no receipt behind");
    after.close();
    assert.equal(existsSync(join(dir, ".sapwood", INSTANCE_LOCK_FILENAME)), true, "the live holder's lock is never displaced");
  });
});

test("sapwood park clear on an unparked engine: nothing to clear, exit 0", () => {
  withDataDir((_dir, dbPath) => {
    new State(dbPath).close();
    const res = runPark(["node", "sapwood", "park", "clear"]);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /no open park episode/);
  });
});

test("sapwood park clear: unknown source and unknown subcommand fail closed", () => {
  withDataDir((_dir, dbPath) => {
    new State(dbPath).close();
    const bad = runPark(["node", "sapwood", "park", "clear", "--source", "bogus"]);
    assert.equal(bad.code, 1);
    assert.match(bad.stderr, /unknown --source/);
    assert.equal(runPark(["node", "sapwood", "park", "wat"]).code, 1);
    assert.equal(runPark(["node", "sapwood", "park", "clear", "--help"]).code, 0);
  });
});

test("sapwood park clear: no DB at all in this cwd -> a clean 'the engine has never run here' refusal, exit 1", () => {
  withDataDir(() => {
    // No State ever constructed in this dir — DEFAULT_DB_PATH genuinely does not exist.
    const res = runPark(["node", "sapwood", "park", "clear"]);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /no state DB|never run here/);
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

    assert.equal(runPark(["node", "sapwood", "park", "clear", "--source", "consecutive-stalls"]).code, 0);

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
    assert.equal(existsSync(join(dir, ".sapwood", "ESCALATION")), false);
    next.close();
  });
});
