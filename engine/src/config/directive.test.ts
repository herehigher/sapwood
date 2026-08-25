// directive.test.ts (#126): the round directive file — human steering injected at round open.
// resolveRoundDirective is exercised directly here (pure event-log + filesystem logic, no
// session/forge involved); align.test.ts/architect.test.ts cover the prompt-injection wiring on
// top of it.
//
// #1078: round.directiveFile is retired — every fixture below injects the directive path via
// resolveRoundDirective's own `opts.directivePath` override (the same seam ArchitectDeps/
// AlignDeps thread through as `directivePath`), never a config key.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { State } from "../state/state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import { type DirectiveAppliedPayload, directiveArchivePath, NO_ROUND_DIRECTIVE, resolveRoundDirective } from "./directive.js";

const mkCfg = (over: Record<string, unknown> = {}): SapwoodConfig =>
  ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, ...over });

function withTmpDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-directive-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveRoundDirective: no file, no event -> NO_ROUND_DIRECTIVE placeholder, no event appended", () => {
  withTmpDir((d) => {
    const state = new State(":memory:");
    const cfg = mkCfg();
    const result = resolveRoundDirective(state, cfg, 1, { consume: true, directivePath: join(d, "DIRECTIVE.md") });
    assert.equal(result, NO_ROUND_DIRECTIVE);
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 0);
    state.close();
  });
});

test("resolveRoundDirective: file present -> content injected, one directive-applied event with the expected payload shape, file archived to a sibling directives/round-N.md", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    writeFileSync(directiveFile, "Focus on the auth flow this round.", "utf8");
    const state = new State(":memory:");
    const cfg = mkCfg();
    const result = resolveRoundDirective(state, cfg, 7, { consume: true, directivePath: directiveFile });
    assert.equal(result, "Focus on the auth flow this round.");

    const events = state.eventsAfterId(0, ["directive-applied"]);
    assert.equal(events.length, 1);
    const payload = events[0]!.payload as DirectiveAppliedPayload;
    assert.equal(payload.round_id, 7);
    assert.equal(payload.path, directiveFile);
    assert.equal(payload.content, "Focus on the auth flow this round.");
    assert.match(payload.sha256, /^[0-9a-f]{64}$/);
    assert.equal(payload.sha256, createHash("sha256").update("Focus on the auth flow this round.", "utf8").digest("hex"));

    // Archived, not left at the live path — a stale directive must never silently re-apply.
    assert.equal(existsSync(directiveFile), false);
    const archivePath = directiveArchivePath(directiveFile, 7);
    assert.equal(existsSync(archivePath), true);
    assert.equal(readFileSync(archivePath, "utf8"), "Focus on the auth flow this round.");
    state.close();
  });
});

test("resolveRoundDirective: oversize directive is deterministically truncated (capDigest contract) — the cut is marked in the text, never silently dropped, but the recorded sha256 hashes the RAW un-truncated content", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    const raw = "x".repeat(100);
    writeFileSync(directiveFile, raw, "utf8");
    const state = new State(":memory:");
    const cfg = mkCfg({ round: { directiveMaxChars: 60 } });
    const result = resolveRoundDirective(state, cfg, 1, { consume: true, directivePath: directiveFile });
    assert.ok(result.length <= 60, `expected <= 60 chars, got ${result.length}`);
    assert.match(result, /truncated/);

    const payload = state.eventsAfterId(0, ["directive-applied"])[0]!.payload as DirectiveAppliedPayload;
    assert.equal(payload.sha256, createHash("sha256").update(raw, "utf8").digest("hex"));
    state.close();
  });
});

test("resolveRoundDirective: consume-once — a second call the SAME round returns the recorded content verbatim, even if the archived file is edited afterward, and appends no duplicate event", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    writeFileSync(directiveFile, "original directive", "utf8");
    const state = new State(":memory:");
    const cfg = mkCfg();

    const first = resolveRoundDirective(state, cfg, 3, { consume: true, directivePath: directiveFile });
    assert.equal(first, "original directive");
    assert.equal(existsSync(directiveFile), false); // archived after the first call

    // Simulate an operator dropping a NEW file at the same live path mid-round (or a human
    // editing the archive) — the second call must not pick either up; the event already
    // recorded for this round is the source of truth.
    writeFileSync(directiveFile, "a DIFFERENT directive dropped later", "utf8");

    const second = resolveRoundDirective(state, cfg, 3, { consume: true, directivePath: directiveFile });
    assert.equal(second, "original directive");
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1, "no duplicate event");
    state.close();
  });
});

test("resolveRoundDirective: crash-rerun — event already recorded but the source file was NOT yet renamed (crash between append and rename) — same content returned, no duplicate event, the rename is completed harmlessly", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    const state = new State(":memory:");
    const cfg = mkCfg();

    // Simulate the crash window: the event is durable, but the file is still sitting at the
    // live path (as if the process died right after appendEvent, right before renameSync).
    const payload: DirectiveAppliedPayload = {
      round_id: 5,
      path: directiveFile,
      content: "steer toward the payments module",
      sha256: createHash("sha256").update("steer toward the payments module", "utf8").digest("hex"),
    };
    state.appendEvent("directive-applied", payload);
    writeFileSync(directiveFile, "steer toward the payments module", "utf8");

    const result = resolveRoundDirective(state, cfg, 5, { consume: true, directivePath: directiveFile });
    assert.equal(result, "steer toward the payments module");
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1, "no duplicate event on resume");
    // The interrupted rename is completed on this resumed call — never left dangling to be
    // misread as a fresh, unconsumed directive by a later round.
    assert.equal(existsSync(directiveFile), false);
    assert.equal(existsSync(directiveArchivePath(directiveFile, 5)), true);
    state.close();
  });
});

test("resolveRoundDirective: crash-rerun — event recorded AND the rename already completed — a further resumed call is a pure no-op read, no error", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    const state = new State(":memory:");
    const cfg = mkCfg();
    const payload: DirectiveAppliedPayload = {
      round_id: 2,
      path: directiveFile,
      content: "done already",
      sha256: createHash("sha256").update("done already", "utf8").digest("hex"),
    };
    state.appendEvent("directive-applied", payload);
    // No file at the live path AND no archive present either (e.g. a human already cleaned it
    // up) — resolveRoundDirective must not throw just because neither exists.
    const result = resolveRoundDirective(state, cfg, 2, { consume: true, directivePath: directiveFile });
    assert.equal(result, "done already");
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1);
    state.close();
  });
});

test("resolveRoundDirective: round-scoped — a directive-applied event from a DIFFERENT round never leaks into this round's resolution", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    const state = new State(":memory:");
    const cfg = mkCfg();
    state.appendEvent("directive-applied", {
      round_id: 99,
      path: directiveFile,
      content: "stale from another round",
      sha256: "x".repeat(64),
    });
    // No file present for THIS round (round 1) and no event scoped to round 1 — falls back to
    // the 'none' placeholder rather than reusing round 99's event.
    const result = resolveRoundDirective(state, cfg, 1, { consume: true, directivePath: directiveFile });
    assert.equal(result, NO_ROUND_DIRECTIVE);
    state.close();
  });
});

test("directiveArchivePath: a sibling directives/ dir next to the configured directive file, named round-<id>.md", () => {
  assert.equal(directiveArchivePath("/repo/.sapwood/DIRECTIVE.md", 42), "/repo/.sapwood/directives/round-42.md");
});

// ── Gate② I1: the idempotent rename must never swallow a FRESH directive ────────────────────

test("resolveRoundDirective I1: prior event + a live file with a DIFFERENT sha (a fresh directive dropped mid-round) -> file left untouched, archive intact, injected content = the event's; the NEXT round consumes the new file normally", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    writeFileSync(directiveFile, "round-1 steering", "utf8");
    const state = new State(":memory:");
    const cfg = mkCfg();

    // Round 1 consumes normally: event + archive.
    const first = resolveRoundDirective(state, cfg, 1, { consume: true, directivePath: directiveFile });
    assert.equal(first, "round-1 steering");
    assert.equal(readFileSync(directiveArchivePath(directiveFile, 1), "utf8"), "round-1 steering");

    // The operator drops a NEW directive mid-round, intended for the NEXT round.
    writeFileSync(directiveFile, "round-2 steering, dropped mid-round-1", "utf8");

    // A later same-round call (e.g. the architect's) finds the prior event. The sha differs,
    // so the re-attempted rename must NOT run: the fresh file stays at the live path, round 1's
    // archive is not overwritten, and the injected content is still the event's.
    const sameRound = resolveRoundDirective(state, cfg, 1, { consume: false, directivePath: directiveFile });
    assert.equal(sameRound, "round-1 steering");
    assert.equal(existsSync(directiveFile), true, "the fresh directive must not be swallowed");
    assert.equal(readFileSync(directiveFile, "utf8"), "round-2 steering, dropped mid-round-1");
    assert.equal(
      readFileSync(directiveArchivePath(directiveFile, 1), "utf8"),
      "round-1 steering",
      "round 1's archive must still match round 1's event",
    );
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1);

    // The NEXT round (different round id -> different round_id filter window) consumes the new
    // file as a brand-new directive.
    const nextRound = resolveRoundDirective(state, cfg, 2, { consume: true, directivePath: directiveFile });
    assert.equal(nextRound, "round-2 steering, dropped mid-round-1");
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 2);
    assert.equal(existsSync(directiveFile), false);
    assert.equal(readFileSync(directiveArchivePath(directiveFile, 2), "utf8"), "round-2 steering, dropped mid-round-1");
    state.close();
  });
});

test("resolveRoundDirective I1: the crash-leftover cleanup (prior event + live file with MATCHING sha) still completes the rename under consume: false too — no duplicate event", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    const state = new State(":memory:");
    const cfg = mkCfg();
    const payload: DirectiveAppliedPayload = {
      round_id: 4,
      path: directiveFile,
      content: "crash leftover",
      sha256: createHash("sha256").update("crash leftover", "utf8").digest("hex"),
    };
    state.appendEvent("directive-applied", payload);
    writeFileSync(directiveFile, "crash leftover", "utf8");

    // consume: false (an architect call with the PO role enabled) — the prior-event path,
    // including the sha-matched leftover cleanup, must still run.
    const result = resolveRoundDirective(state, cfg, 4, { consume: false, directivePath: directiveFile });
    assert.equal(result, "crash leftover");
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1, "no duplicate event");
    assert.equal(existsSync(directiveFile), false, "the sha-matched leftover is still archived");
    assert.equal(existsSync(directiveArchivePath(directiveFile, 4)), true);
    state.close();
  });
});

// ── Gate② I2: mid-round drops wait for the next round open — never a half-round apply ───────

test("resolveRoundDirective I2: no prior event + consume: false (a mid-round drop reaching a non-consumer) -> NO_ROUND_DIRECTIVE, file untouched, no event", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    writeFileSync(directiveFile, "dropped between aligning and architecting", "utf8");
    const state = new State(":memory:");
    const cfg = mkCfg();
    const result = resolveRoundDirective(state, cfg, 1, { consume: false, directivePath: directiveFile });
    assert.equal(result, NO_ROUND_DIRECTIVE);
    assert.equal(existsSync(directiveFile), true, "a non-consumer never touches the file");
    assert.equal(readFileSync(directiveFile, "utf8"), "dropped between aligning and architecting");
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 0);
    state.close();
  });
});

// ── #1078: retirement of round.directiveFile + the cwd-relative default ────────────────────

test("#1078: round.directiveFile is a retired config key — parsing a config that sets it fails the standard unknown-key error", () => {
  assert.throws(
    () => ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 }, round: { directiveFile: "custom/STEER.md" } }),
    /directiveFile|[Uu]nrecognized/,
  );
});

test("#1078: no directivePath override -> resolveRoundDirective reads/archives .sapwood/DIRECTIVE.md (runtimePaths(defaultRuntimeRoot()).directiveMd), cwd-relative, never a config-derived path", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-directive-cwd-"));
  const previousCwd = process.cwd();
  try {
    mkdirSync(join(dir, ".sapwood"), { recursive: true });
    writeFileSync(join(dir, ".sapwood", "DIRECTIVE.md"), "cwd-default steering", "utf8");
    process.chdir(dir);
    const state = new State(":memory:");
    const result = resolveRoundDirective(state, mkCfg(), 1, { consume: true });
    assert.equal(result, "cwd-default steering");
    assert.equal(existsSync(join(dir, ".sapwood", "DIRECTIVE.md")), false, "archived out of the live default path");
    assert.equal(existsSync(join(dir, ".sapwood", "directives", "round-1.md")), true);
    state.close();
  } finally {
    process.chdir(previousCwd);
    rmSync(dir, { recursive: true, force: true });
  }
});
