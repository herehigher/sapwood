// events.test.ts (#642): `sapwood events` — the codified dogfood monitor recipe. Covers AC5's
// full flag contract (--since-id/--kind/--exclude-kind/--limit/--json, filter-before-limit,
// kind+exclude-kind rejection, the cursor's empty-page-still-advances contract, unknown-kind-
// argument rejection naming valid kinds, an unknown-kind DB ROW passed through opaque, and the
// hard page cap) plus AC6's busy-DB failure contract.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { parseEventsArgs, runCli, runEvents } from "../cli.js";
import { SCHEMA_VERSION, State } from "../state/state.js";

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

test("parseEventsArgs: defaults — since-id 0, no kind filter, default limit, text mode, no --tail", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events"]);
  assert.deepEqual(parsed, {
    help: false,
    dbPath: ".sapwood/sapwood.sqlite",
    configPath: undefined,
    sinceId: 0,
    kinds: [],
    excludeKinds: [],
    issue: undefined,
    limit: 100,
    json: false,
    tail: undefined,
  });
});

test("parseEventsArgs: --since-id/--kind/--exclude-kind(repeat rejected together)/--limit/--json parse", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--since-id", "42", "--kind", "merged", "--limit", "10", "--json"]);
  assert.deepEqual(parsed, {
    help: false,
    dbPath: ".sapwood/sapwood.sqlite",
    configPath: undefined,
    sinceId: 42,
    kinds: ["merged"],
    excludeKinds: [],
    issue: undefined,
    limit: 10,
    json: true,
    tail: undefined,
  });
});

// ── #709: --tail ─────────────────────────────────────────────────────────────────────────

test("parseEventsArgs: --tail parses a non-negative integer, 0 included (the cursor-bootstrap value)", () => {
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--tail", "5"]).tail, 5);
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--tail", "0"]).tail, 0);
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--tail", "0"]).error, undefined);
});

test("parseEventsArgs: --tail requires a value, and a canonical non-negative-integer one", () => {
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--tail"]).error ?? "", /--tail requires a value/);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--tail", "-1"]).error ?? "", /--tail requires a value/);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--tail", "abc"]).error ?? "", /non-negative integer/);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--tail", "0x10"]).error ?? "", /--tail requires a non-negative integer/);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--tail", "1e3"]).error ?? "", /--tail requires a non-negative integer/);
});

test("parseEventsArgs: --tail is hard-capped at the same MAX_PAGE_LIMIT as --limit, rejected above cap, not silently clamped", () => {
  const aboveCap = parseEventsArgs(["node", "sapwood", "events", "--tail", "1001"]);
  assert.match(aboveCap.error ?? "", /exceeds the hard cap of 1000/);
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--tail", "1000"]).error, undefined, "exactly the cap is fine");
});

test("parseEventsArgs: --tail composes with --kind/--exclude-kind/--issue (no rejection)", () => {
  const withKind = parseEventsArgs(["node", "sapwood", "events", "--tail", "5", "--kind", "merged"]);
  assert.equal(withKind.error, undefined);
  assert.equal(withKind.tail, 5);
  assert.deepEqual(withKind.kinds, ["merged"]);

  const withIssue = parseEventsArgs(["node", "sapwood", "events", "--tail", "5", "--issue", "7"]);
  assert.equal(withIssue.error, undefined);
  assert.equal(withIssue.issue, 7);
});

test("parseEventsArgs (#709 AC): --tail combined with --since-id is REJECTED — one cursor semantics, not an invented precedence", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--tail", "5", "--since-id", "10"]);
  assert.match(parsed.error ?? "", /--tail cannot combine with --since-id/);
  // Order-independent: --since-id before --tail is rejected the same way.
  const reversed = parseEventsArgs(["node", "sapwood", "events", "--since-id", "10", "--tail", "5"]);
  assert.match(reversed.error ?? "", /--tail cannot combine with --since-id/);
  // An explicit `--since-id 0` (the same value as the untouched default) still counts as GIVEN —
  // the conflict is about the FLAG being passed, not its value.
  const explicitZero = parseEventsArgs(["node", "sapwood", "events", "--tail", "5", "--since-id", "0"]);
  assert.match(explicitZero.error ?? "", /--tail cannot combine with --since-id/);
});

test("parseEventsArgs (#709): --tail alone, with --since-id left untouched at its default, is NOT rejected", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--tail", "5"]);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.sinceId, 0);
  assert.equal(parsed.tail, 5);
});

test("parseEventsArgs: --issue parses and requires a non-negative integer", () => {
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--issue", "42"]).issue, 42);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--issue"]).error ?? "", /--issue requires a value/);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--issue", "-1"]).error ?? "", /--issue requires a value/);
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--issue", "abc"]).error ?? "", /non-negative integer/);
  assert.equal(parseEventsArgs(["node", "sapwood", "events", "--issue", "0"]).issue, 0);
});

test("parseEventsArgs: --issue composes with --kind (not mutually exclusive, unlike --kind/--exclude-kind)", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--issue", "7", "--kind", "merged"]);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.issue, 7);
  assert.deepEqual(parsed.kinds, ["merged"]);
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

// ── #710: --config ──────────────────────────────────────────────────────────────────────────

test("parseEventsArgs (#710): --config parses, same fail-closed value-taking convention as status's --config", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--config", "/tmp/cfg.yaml"]);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.configPath, "/tmp/cfg.yaml");
});

test("parseEventsArgs (#710): --config with no operand is an error, never a silent default-config read", () => {
  assert.match(parseEventsArgs(["node", "sapwood", "events", "--config"]).error ?? "", /--config requires a path/);
});

test("parseEventsArgs (#710): --config followed by a flag is an error, never consumed as a path", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "--config", "--bogus"]);
  assert.match(parsed.error ?? "", /--config requires a path/);
});

test("parseEventsArgs (#710): --config interleaves with the other flags without its operand becoming a positional/kind", () => {
  const parsed = parseEventsArgs(["node", "sapwood", "events", "/tmp/x.sqlite", "--config", "/tmp/cfg.yaml", "--kind", "merged"]);
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.dbPath, "/tmp/x.sqlite");
  assert.equal(parsed.configPath, "/tmp/cfg.yaml");
  assert.deepEqual(parsed.kinds, ["merged"]);
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

test("events: #655 AC4 --issue returns exactly the events whose payload issue equals N, mixed-issue ledger", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("drive-needs-human", { worker: "lane-1", issue: 1, pr: 10, reason: "gate:HUMAN" });
    seed.appendEvent("dispatched", { issue: 2 });
    seed.appendEvent("drive-needs-human", { worker: "lane-2", issue: 2, pr: 20, reason: "fix-rounds-cap:2/2" });
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--issue", "1", "--json"]));
    assert.deepEqual(
      body.events.map((e: { kind: string }) => e.kind),
      ["dispatched", "drive-needs-human"],
    );
    assert.equal(body.nextSinceId, 2, "the last MATCHING row's id, not the ledger tail — the page had rows");
  });
});

test("events: #655 AC4 --issue composes with --kind (an AND, not an OR)", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("drive-needs-human", { worker: "lane-1", issue: 1, pr: 10, reason: "gate:HUMAN" });
    seed.appendEvent("drive-needs-human", { worker: "lane-2", issue: 2, pr: 20, reason: "fix-rounds-cap:2/2" });
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--issue", "1", "--kind", "drive-needs-human", "--json"]));
    assert.deepEqual(
      body.events.map((e: { kind: string; payload: unknown }) => e.payload),
      [{ worker: "lane-1", issue: 1, pr: 10, reason: "gate:HUMAN" }],
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

// ── runEvents: --tail (#709 AC) ─────────────────────────────────────────────────────────────

test("events --tail (#709 AC): empty ledger — --tail N on a freshly-created (never-written) DB returns no events and nextSinceId 0", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    new State(dbPath).close();
    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--tail", "5", "--json"]));
    assert.deepEqual(body.events, []);
    assert.equal(body.nextSinceId, 0);
  });
});

test("events --tail (#709 AC): --tail 0 --json is the cursor-bootstrap idiom — empty events array plus nextSinceId set to the ledger's CURRENT head", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("dispatched", { issue: 2 });
    seed.appendEvent("merged", { pr: 10 });
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--tail", "0", "--json"]));
    assert.deepEqual(body.events, []);
    assert.equal(body.nextSinceId, 3, "the ledger's current head, with zero history read");

    // The bootstrap idiom itself: a follow-up --since-id at that cursor sees nothing yet (no
    // new event has landed), and once one does, exactly that one event — never a re-show of
    // anything --tail 0 already implicitly "saw".
    const followUp = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--since-id", String(body.nextSinceId), "--json"]));
    assert.deepEqual(followUp.events, []);
  });
});

test("events --tail (#709 AC): N larger than the ledger size returns every event, oldest-first, same order as the non-tail path", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("dispatched", { issue: 2 });
    seed.appendEvent("merged", { pr: 10 });
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--tail", "100", "--json"]));
    assert.deepEqual(
      body.events.map((e: { id: number }) => e.id),
      [1, 2, 3],
    );
    assert.equal(body.nextSinceId, 3);
  });
});

test("events --tail (#709 AC): returns exactly the newest N events, oldest-first", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("dispatched", { issue: 2 });
    seed.appendEvent("dispatched", { issue: 3 });
    seed.appendEvent("merged", { pr: 10 });
    seed.appendEvent("merged", { pr: 11 });
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--tail", "2", "--json"]));
    assert.deepEqual(
      body.events.map((e: { id: number }) => e.id),
      [4, 5],
      "the 2 newest ids, in ascending order — never newest-first",
    );
    assert.equal(body.nextSinceId, 5);
  });
});

test("events --tail (#709 AC): composes with --kind — the newest N MATCHING events, filter applied before the newest-N cut", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("merged", { pr: 1 }); // id 1
    seed.appendEvent("dispatched", { issue: 1 }); // id 2
    seed.appendEvent("merged", { pr: 2 }); // id 3
    seed.appendEvent("dispatched", { issue: 2 }); // id 4
    seed.appendEvent("merged", { pr: 3 }); // id 5
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--kind", "merged", "--tail", "2", "--json"]));
    assert.deepEqual(
      body.events.map((e: { id: number }) => e.id),
      [3, 5],
      "the 2 newest MERGED events, not the 2 newest raw rows filtered down to fewer",
    );
    // #709 hard constraint: nextSinceId is the ledger's TRUE head (5), not the last MATCHING
    // row's id — here they happen to coincide (id 5 is both), so this also exercises the
    // non-coincident case below.
    assert.equal(body.nextSinceId, 5);
  });
});

test("events --tail (#709 AC): composes with --exclude-kind", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("merged", { pr: 1 });
    seed.appendEvent("dispatched", { issue: 2 });
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--exclude-kind", "dispatched", "--tail", "5", "--json"]));
    assert.deepEqual(
      body.events.map((e: { kind: string }) => e.kind),
      ["merged"],
    );
  });
});

test("events --tail (#709 hard constraint): nextSinceId is the ledger's TRUE head, not the last MATCHING row's id, when a newer non-matching event exists past the last match", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("merged", { pr: 1 }); // id 1 — the only "merged" row
    seed.appendEvent("dispatched", { issue: 1 }); // id 2 — newer, but filtered out
    seed.close();

    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--kind", "merged", "--tail", "5", "--json"]));
    assert.deepEqual(
      body.events.map((e: { id: number }) => e.id),
      [1],
    );
    // If nextSinceId had been derived from the last MATCHING row (id 1) instead of the true
    // ledger head (id 2), a follow-up --since-id 1 would re-scan and could re-show event id 2
    // under a DIFFERENT filter later — the true-head contract avoids that entirely.
    assert.equal(body.nextSinceId, 2, "the ledger's true head, not the last matching row's id (1)");
  });
});

test("events (#709 AC): --tail combined with --since-id is REJECTED via the full CLI, exit 1, usage shown", () => {
  const r = runCli(["node", "sapwood", "events", "--tail", "5", "--since-id", "10"]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /--tail cannot combine with --since-id/);
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

// ── #710: --config resolution + config-mismatch regression ─────────────────────────────────

const MINIMAL_CONFIG = "board: { owner: acme, repo: widgets, projectNumber: 7 }\nlanes: { max: 3 }\ncost: { dailyBudgetUsd: 50 }\n";

test("events (#710 AC1): --config loads the named config — --json's config.provenance names it, text stamps the same path on the 'config:' line", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const configPath = join(dir, "sapwood.dogfood.yaml");
    writeFileSync(configPath, MINIMAL_CONFIG);
    new State(dbPath).close();

    const jsonResult = runEvents(["node", "sapwood", "events", dbPath, "--config", configPath, "--json"]);
    assert.equal(jsonResult.code, 0);
    const body = parseStdout(jsonResult);
    assert.deepEqual(body.config, { available: true, provenance: configPath });

    const textResult = runEvents(["node", "sapwood", "events", dbPath, "--config", configPath]);
    assert.equal(textResult.code, 0);
    assert.match(textResult.stdout, new RegExp(`config: ${configPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  });
});

test("events (#710): no --config given, none found at the default probe names — config.provenance is absent, exit 0 (best-effort, unchanged)", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    new State(dbPath).close();
    const body = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--json"]));
    assert.deepEqual(body.config, { available: false });
    const textResult = runEvents(["node", "sapwood", "events", dbPath]);
    assert.match(textResult.stdout, /config: none found/);
  });
});

test("events (#710): an EXPLICIT --config naming a missing file fails CLOSED — exit 1, clear error, never a silent degrade", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const missingConfig = join(dir, "does-not-exist.yaml");
    new State(dbPath).close();
    const r = runEvents(["node", "sapwood", "events", dbPath, "--config", missingConfig]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /sapwood events:/);
  });
});

test("events/status (#710 AC2 — config-mismatch trap regression, gate② P2-2 fix): with a SECOND (default-named) config file GENUINELY reachable by the cwd probe, the flagged --config wins on every surface — provenance, the daily cap, AND the probe-only warning never leak from the probed file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-events-config-mismatch-"));
  const dbPath = join(dir, "sapwood.sqlite");
  // The probed default (what a bare `status`/`events` with no --config would pick up). Leaves
  // ci.requiredChecks empty under the default reviewer.mode: engine-agent — config.ts's own
  // parse-boundary warning fires for exactly this shape, giving this file a DISTINCT, assertable
  // fingerprint beyond just its own dailyBudgetUsd.
  writeFileSync(
    join(dir, "sapwood.config.yaml"),
    "board: { owner: acme, repo: widgets, projectNumber: 1 }\nlanes: { max: 1 }\ncost: { dailyBudgetUsd: 100 }\n",
  );
  // The RUN's actual config — a differently-named file, only reachable via --config. Sets
  // ci.requiredChecks non-empty specifically so it does NOT trigger that warning — the two
  // configs are now distinguishable on BOTH dailyBudgetUsd and warning behavior.
  const runConfigPath = join(dir, "sapwood.dogfood.yaml");
  writeFileSync(
    runConfigPath,
    "board: { owner: acme, repo: widgets, projectNumber: 2 }\nlanes: { max: 9 }\ncost: { dailyBudgetUsd: 300 }\nci: { requiredChecks: [{ name: build }] }\n",
  );
  new State(dbPath).close();

  const previousCwd = process.cwd();
  const originalWarn = console.warn;
  const warnCalls: string[] = [];
  const warnedAboutRequiredChecks = () => warnCalls.some((w) => w.includes("ci.requiredChecks is empty"));
  try {
    // #710 gate② P2-2: chdir INTO dir — `loadConfig`'s/`resolveConfigProvenance`'s probe checks
    // DEFAULT_CONFIG_PATHS' relative names against the CURRENT WORKING DIRECTORY (config.ts's own
    // `DEFAULT_CONFIG_PATHS.find(existsSync)`), so without this the probed-default fixture above
    // is never actually reachable and this test would pass even if a leak existed.
    process.chdir(dir);
    console.warn = ((...args: unknown[]) => {
      warnCalls.push(args.map(String).join(" "));
    }) as typeof console.warn;

    // Precondition: prove the probed default is a REAL, live temptation — WITHOUT --config, a
    // bare `events` genuinely finds and loads it (relative provenance, its own $100 cap's config,
    // and its warning fires). If this fails, the fixture below proves nothing.
    warnCalls.length = 0;
    const probedBody = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--json"]));
    assert.equal(probedBody.config.provenance, "sapwood.config.yaml", "precondition: the probe found the default-named file");
    assert.ok(warnedAboutRequiredChecks(), "precondition: the probed default's own ci.requiredChecks warning actually fires");

    // The regression itself: --config names the RUN's file — provenance, caps, AND the probed
    // default's warning must all come from (or reflect) the FLAGGED file, never the probed one.
    warnCalls.length = 0;
    const eventsBody = parseStdout(runEvents(["node", "sapwood", "events", dbPath, "--config", runConfigPath, "--json"]));
    assert.deepEqual(eventsBody.config, { available: true, provenance: runConfigPath });
    assert.ok(!warnedAboutRequiredChecks(), "the probed default's warning must never fire when --config points elsewhere");

    // Same trap, on `status` --json: the daily cap must be the RUN's $300, never the committed
    // repo config's $100 — this is the exact live trap batch-11 T1 observed (#710's Why).
    warnCalls.length = 0;
    const statusBody = parseStdout(runCli(["node", "sapwood", "status", dbPath, "--config", runConfigPath, "--json"]));
    assert.equal(statusBody.config.provenance, runConfigPath);
    assert.equal(statusBody.spend.dailyBudgetUsd, 300);
    assert.notEqual(statusBody.spend.dailyBudgetUsd, 100);
    assert.ok(!warnedAboutRequiredChecks(), "status --config must not leak the probed default's warning either");
  } finally {
    console.warn = originalWarn;
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #710: schema-window honesty ─────────────────────────────────────────────────────────────

test("events (#710 AC3): DB schema OLDER than this engine still refuses to interpret rows, but reports both schema versions PLUS the raw event count/max id (degraded, not blind)", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("merged", { pr: 10 });
    seed.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 1");
    raw.close();

    const r = runEvents(["node", "sapwood", "events", dbPath]);
    assert.equal(r.code, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /DB schema v1.*older.*events never migrates/);
    // The degraded read: 2 events written above, max id 2 — schema-independent, so still honest
    // even though the schema mismatch means neither event's KIND/PAYLOAD is interpreted here.
    assert.match(r.stderr, /2 event\(s\) in the ledger, max id 2/);

    const jsonResult = runEvents(["node", "sapwood", "events", dbPath, "--json"]);
    assert.equal(jsonResult.code, 1);
    const body = JSON.parse(jsonResult.stderr);
    assert.equal(body.error.kind, "schema-mismatch");
    assert.equal(body.error.dbVersion, 1);
    assert.equal(body.error.expectedVersion, SCHEMA_VERSION);
    assert.equal(body.error.rawEventCount, 2);
    assert.equal(body.error.maxEventId, 2);
  });
});

test("status (#710 AC3): DB schema OLDER than this engine reports the same degraded schema-independent read", () => {
  withDir((dir) => {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("dispatched", { issue: 1 });
    seed.appendEvent("dispatched", { issue: 2 });
    seed.appendEvent("dispatched", { issue: 3 });
    seed.close();
    const raw = new DatabaseSync(dbPath);
    raw.exec("PRAGMA user_version = 1");
    raw.close();

    const r = runCli(["node", "sapwood", "status", dbPath, "--json"]);
    assert.equal(r.code, 1);
    const body = JSON.parse(r.stderr);
    assert.equal(body.error.kind, "schema-mismatch");
    assert.equal(body.error.dbVersion, 1);
    assert.equal(body.error.expectedVersion, SCHEMA_VERSION);
    assert.equal(body.error.rawEventCount, 3);
    assert.equal(body.error.maxEventId, 3);
  });
});
