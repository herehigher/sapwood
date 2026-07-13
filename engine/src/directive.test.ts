// directive.test.ts (#126): the round directive file — human steering injected at round open.
// resolveRoundDirective is exercised directly here (pure event-log + filesystem logic, no
// session/forge involved); align.test.ts/architect.test.ts cover the prompt-injection wiring on
// top of it.
import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveRoundDirective, directiveArchivePath, NO_ROUND_DIRECTIVE, type DirectiveAppliedPayload,
} from "./directive.js";
import { State } from "./state.js";
import { ConfigSchema, type SapwoodConfig } from "./config.js";

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
    const cfg = mkCfg({ round: { directiveFile: join(d, "DIRECTIVE.md") } });
    const result = resolveRoundDirective(state, cfg, 1);
    assert.equal(result, NO_ROUND_DIRECTIVE);
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 0);
    state.close();
  });
});

test("resolveRoundDirective: file present -> content injected, one directive-applied event with the expected payload shape, file archived to data/directives/round-N.md", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    writeFileSync(directiveFile, "Focus on the auth flow this round.", "utf8");
    const state = new State(":memory:");
    const cfg = mkCfg({ round: { directiveFile } });
    const result = resolveRoundDirective(state, cfg, 7);
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
    const cfg = mkCfg({ round: { directiveFile, directiveMaxChars: 60 } });
    const result = resolveRoundDirective(state, cfg, 1);
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
    const cfg = mkCfg({ round: { directiveFile } });

    const first = resolveRoundDirective(state, cfg, 3);
    assert.equal(first, "original directive");
    assert.equal(existsSync(directiveFile), false); // archived after the first call

    // Simulate an operator dropping a NEW file at the same live path mid-round (or a human
    // editing the archive) — the second call must not pick either up; the event already
    // recorded for this round is the source of truth.
    writeFileSync(directiveFile, "a DIFFERENT directive dropped later", "utf8");

    const second = resolveRoundDirective(state, cfg, 3);
    assert.equal(second, "original directive");
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1, "no duplicate event");
    state.close();
  });
});

test("resolveRoundDirective: crash-rerun — event already recorded but the source file was NOT yet renamed (crash between append and rename) — same content returned, no duplicate event, the rename is completed harmlessly", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    const state = new State(":memory:");
    const cfg = mkCfg({ round: { directiveFile } });

    // Simulate the crash window: the event is durable, but the file is still sitting at the
    // live path (as if the process died right after appendEvent, right before renameSync).
    const payload: DirectiveAppliedPayload = {
      round_id: 5, path: directiveFile, content: "steer toward the payments module",
      sha256: createHash("sha256").update("steer toward the payments module", "utf8").digest("hex"),
    };
    state.appendEvent("directive-applied", payload);
    writeFileSync(directiveFile, "steer toward the payments module", "utf8");

    const result = resolveRoundDirective(state, cfg, 5);
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
    const cfg = mkCfg({ round: { directiveFile } });
    const payload: DirectiveAppliedPayload = {
      round_id: 2, path: directiveFile, content: "done already",
      sha256: createHash("sha256").update("done already", "utf8").digest("hex"),
    };
    state.appendEvent("directive-applied", payload);
    // No file at the live path AND no archive present either (e.g. a human already cleaned it
    // up) — resolveRoundDirective must not throw just because neither exists.
    const result = resolveRoundDirective(state, cfg, 2);
    assert.equal(result, "done already");
    assert.equal(state.eventsAfterId(0, ["directive-applied"]).length, 1);
    state.close();
  });
});

test("resolveRoundDirective: round-scoped — a directive-applied event from a DIFFERENT round never leaks into this round's resolution", () => {
  withTmpDir((d) => {
    const directiveFile = join(d, "DIRECTIVE.md");
    const state = new State(":memory:");
    const cfg = mkCfg({ round: { directiveFile } });
    state.appendEvent("directive-applied", {
      round_id: 99, path: directiveFile, content: "stale from another round", sha256: "x".repeat(64),
    });
    // No file present for THIS round (round 1) and no event scoped to round 1 — falls back to
    // the 'none' placeholder rather than reusing round 99's event.
    const result = resolveRoundDirective(state, cfg, 1);
    assert.equal(result, NO_ROUND_DIRECTIVE);
    state.close();
  });
});

test("directiveArchivePath: a sibling directives/ dir next to the configured directive file, named round-<id>.md", () => {
  assert.equal(
    directiveArchivePath("/repo/data/DIRECTIVE.md", 42),
    "/repo/data/directives/round-42.md",
  );
});
