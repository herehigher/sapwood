// events.test.ts (#642): `sapwood events` — the codified dogfood monitor recipe. Covers AC5's
// full flag contract (--since-id/--kind/--exclude-kind/--limit/--json, filter-before-limit,
// kind+exclude-kind rejection, the cursor's empty-page-still-advances contract, unknown-kind-
// argument rejection naming valid kinds, an unknown-kind DB ROW passed through opaque, and the
// hard page cap) plus AC6's busy-DB failure contract.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseEventsArgs, runCli, runEvents } from "../cli.js";
import { State } from "../state/state.js";

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-events-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// biome-ignore lint/suspicious/noExplicitAny: test-side JSON, asserted field by field below
function parseStdout(r: { stdout: string }): any {
  return JSON.parse(r.stdout);
}

// ── parseEventsArgs: pure flag parsing ──────────────────────────────────────────────────────

test("parseEventsArgs: defaults — since-id 0, no kind filter, default limit, text mode", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events"]);
  assert.deepEqual(parsed, {
    help: false,
    dbPath: "data/sapwood.sqlite",
    sinceId: 0,
    kinds: [],
    excludeKinds: [],
    limit: 100,
    json: false,
  });
});

test("parseEventsArgs: --since-id/--kind/--exclude-kind(repeat rejected together)/--limit/--json parse", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--since-id", "42", "--kind", "merged", "--limit", "10", "--json"]);
  assert.deepEqual(parsed, {
    help: false,
    dbPath: "data/sapwood.sqlite",
    sinceId: 42,
    kinds: ["merged"],
    excludeKinds: [],
    limit: 10,
    json: true,
  });
});

test("parseEventsArgs: --kind is repeatable", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--kind", "merged", "--kind", "dispatched"]);
  assert.deepEqual(parsed.kinds, ["merged", "dispatched"]);
});

test("parseEventsArgs: --since-id requires a non-negative integer", () => {
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--since-id"]).error ?? "", /--since-id requires a value/);
  // A leading "-" reads as another flag, not a value — same fail-closed convention every other
  // value-taking flag in this file uses (e.g. parseStopFlags): "-1" can never be typed as a
  // negative NUMBER value, only rejected as a missing operand.
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--since-id", "-1"]).error ?? "", /--since-id requires a value/);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--since-id", "abc"]).error ?? "", /non-negative integer/);
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--since-id", "0"]).error, undefined);
});

test("parseEventsArgs: --limit requires a positive integer, hard-capped (#642 AC5: rejected above cap, not silently clamped)", () => {
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--limit", "0"]).error ?? "", /positive integer/);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--limit", "abc"]).error ?? "", /positive integer/);
  const aboveCap = parseEventsArgs(["node", "sapwood", "events", "--limit", "1001"]);
  assert.match(aboveCap.error ?? "", /exceeds the hard cap of 1000/);
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--limit", "1000"]).error, undefined, "exactly the cap is fine");
});

test("parseEventsArgs: #642 Codex gate② round-1 P2 finding 4 — --since-id/--limit reject non-canonical numeric forms (hex, exponential) and an unsafe-magnitude --since-id", () => {
  // "0x10" and "1e3" are both legal JS numeric-literal forms Number() happily parses (16 and
  // 1000 respectively) — neither is what an operator/script means by "an integer" typed on a
  // command line, and silently accepting them means two visually-different flag values pick the
  // identical cursor/page size for no reason the caller can see.
  assert.match(
    parseEventsArgs(["node", "sapwood", "events", "--since-id", "0x10"]).error ?? "",
    /--since-id requires a non-negative integer/,
  );
  assert.match(
    parseEventsArgs(["node", "sapwood", "events", "--since-id", "1e3"]).error ?? "",
    /--since-id requires a non-negative integer/,
  );
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--limit", "0x10"]).error ?? "", /--limit requires a positive integer/);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--limit", "1e3"]).error ?? "", /--limit requires a positive integer/);
  // A canonical-decimal string too large to represent exactly as a JS number (Number.MAX_SAFE_
  // INTEGER is 2^53-1, 16 digits) must be rejected rather than silently rounded to a NEARBY id —
  // a wrong-but-plausible-looking cursor is worse than a clear rejection.
  const unsafe = parseEventsArgs(["node", "sapwood", "events", "--since-id", "99999999999999999999"]);
  assert.match(unsafe.error ?? "", /--since-id requires a non-negative integer/);
  // Canonical decimal, safe magnitude: still accepted (no regression from the tightened check).
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--since-id", "123"]).sinceId, 123);
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--limit", "250"]).limit, 250);
});

test("parseEventsArgs: --kind and --exclude-kind together is rejected — no invented precedence (#642 AC5)", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--kind", "merged", "--exclude-kind", "dispatched"]);
  assert.match(parsed.error ?? "", /--kind and --exclude-kind cannot combine/);
});

test("parseEventsArgs: an unknown --kind ARGUMENT is rejected, naming valid kinds from the #425 registry", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--kind", "not-a-real-kind"]);
  assert.match(parsed.error ?? "", /unknown --kind: not-a-real-kind/);
  assert.match(parsed.error ?? "", /valid kinds:/);
  assert.match(parsed.error ?? "", /merged/); // a real kind name shows up in the list
});

test("parseEventsArgs: an unknown --exclude-kind ARGUMENT is rejected the same way", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--exclude-kind", "bogus"]);
  assert.match(parsed.error ?? "", /unknown --exclude-kind: bogus/);
});

test("parseEventsArgs: --help / -h wins over everything else", () => {
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--help", "--kind", "bogus"]).help, true);
});

test("parseEventsArgs: unknown flag is a fail-closed error", () => {
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--bogus"]).error ?? "", /unknown flag: --bogus/);
});

test("parseEventsArgs: a positional db-path is accepted, same convention as status", () => {
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "/tmp/x.sqlite"]).dbPath, "/tmp/x.sqlite");
});

// ── runEvents: DB-backed behavior ───────────────────────────────────────────────────────────

test("events: no DB at the given path reports 'engine has never run', exit 0, no file created", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const r = runEvents(["node", "sapwood", "events", dbPath]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /no state DB/);
  });
});

test("events: --json filter-before-limit — --kind merged --limit 1 returns the FIRST matching merged event, not the first raw event filtered down to nothing", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("dispatched", { issue: 2 });
    seed.appendEvent("dispatched", { issue: 3 });
    seed.appendEvent("merged", { pr: 10 });
    seed.close();

    const r = runEvents(["node", "sapwood", "events", dbPath, "--kind", "merged", "--limit", "1", "--json"]);
    assert.equal(r.code, 0);
    const body = parseStdout(r);
    assert.equal(body.formatVersion, 1);
    assert.deepEqual(
      body.events.map((e: { kind: string }) => e.kind),
      ["merged"],
    );
    assert.equal(body.nextSinceId, 4);
    assert.deepEqual(body.snapshot, { mode: "live" });
  });
});

test("events: --exclude-kind drops the named kind and keeps everything else", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("merged", { pr: 10 });
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--exclude-kind", "dispatched", "--json"]));
    assert.deepEqual(
      body.events.map((e: { kind: string }) => e.kind),
      ["merged"],
    );
  });
});

test("events: #642 AC5 cursor contract — an EMPTY filtered page still advances nextSinceId to the ledger's current tail, never leaving a poller pinned rescanning the same range", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("dispatched", { issue: 2 });
    seed.appendEvent("dispatched", { issue: 3 });
    seed.close();

    // No "merged" event exists anywhere — a naive cursor would stay pinned at 0 forever.
    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--kind", "merged", "--json"]));
    assert.deepEqual(body.events, []);
    assert.equal(body.nextSinceId, 3, "advances to the ledger's current max id, not stuck at 0");
  });
});

test("events: an empty DB with no matching filter and no rows at all keeps the cursor at sinceId (nothing to advance past)", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    new State(dbPath).close();
    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--since-id", "5", "--kind", "merged", "--json"]));
    assert.deepEqual(body.events, []);
    assert.equal(body.nextSinceId, 5);
  });
});

test("events: a DB row whose kind is absent from this binary's registry is returned OPAQUE, never rejected (#642 AC5) — an older reader must not choke on a newer engine's valid kind", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    const db = (seed as unknown as { db: DatabaseSync }).db;
    db.prepare("INSERT INTO events (ts, kind, payload) VALUES (?, ?, ?)").run("2026-08-04T00:00:00.000Z", "a-future-kind", "{}");
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--json"]));
    assert.deepEqual(
      body.events.map((e: { kind: string }) => e.kind),
      ["a-future-kind"],
    );
  });
});

test("events: text mode lists one line per event plus a trailing nextSinceId line", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("merged", { pr: 10 });
    seed.close();

    const r = runEvents(["node", "sapwood", "events", dbPath]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /#1 {2}.*merged.*"pr":10/);
    assert.match(r.stdout, /nextSinceId: 1/);
  });
});

test("events: --kind + --exclude-kind together is rejected via the full CLI, exit 1, usage shown", () => {
  const r = runCli(["node", "sapwood", "events", "--kind", "merged", "--exclude-kind", "dispatched"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /cannot combine/);
});

test("events: --help / -h prints usage and exits 0, never touching a DB", () => {
  const r = runCli(["node", "sapwood", "events", "--help"]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /usage: sapwood events/);
});

test("events: --limit above the hard cap is rejected via the full CLI, exit 1", () => {
  const r = runCli(["node", "sapwood", "events", "--limit", "5000"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /exceeds the hard cap/);
});

test("#642 AC6: events against a locked writer fails with a structured busy error, exit 1, never a hang or a raw stack trace", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    new State(dbPath).close();
    // Force rollback-journal locking semantics (WAL lets readers proceed alongside a writer —
    // see state.test.ts's own comment for the full rationale this mirrors).
    const modeSwitch = new DatabaseSync(dbPath);
    modeSwitch.exec("PRAGMA journal_mode = DELETE");
    modeSwitch.close();

    const writer = new DatabaseSync(dbPath);
    writer.exec("BEGIN EXCLUSIVE");
    try {
      const r = runCli(["node", "sapwood", "events", dbPath, "--json"]);
      assert.equal(r.code, 1);
      assert.equal(r.stdout, "");
      const body = JSON.parse(r.stderr);
      assert.equal(body.error.kind, "busy");
      assert.ok(body.error.timeoutMs > 0);
    } finally {
      writer.exec("ROLLBACK");
      writer.close();
    }
  });
});
