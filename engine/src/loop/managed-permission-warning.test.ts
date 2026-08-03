// managed-permission-warning.test.ts (#554): the fixture-file red test the issue's verification
// plan asks for — flag true -> one warning line (with resolution text) present; flag false or
// the file absent -> no line. No timing-dependent assertions (repo doctrine): this is a pure
// file-read-and-log check, no clock, no wait.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectManagedPermissionMode } from "./managed-permission-warning.js";

function withFixtureDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-managed-settings-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("allowManagedPermissionRulesOnly: true -> exactly one warning, with resolution text", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "managed-settings.json");
    writeFileSync(path, JSON.stringify({ allowManagedPermissionRulesOnly: true }));
    const logged: string[] = [];
    const tripped = detectManagedPermissionMode((line) => logged.push(line), { path });
    assert.equal(tripped, true);
    assert.equal(logged.length, 1);
    assert.match(logged[0]!, /allowManagedPermissionRulesOnly/);
    // Both operator exits named, plus the docs/security.md anchor.
    assert.match(logged[0]!, /mirror/i);
    assert.match(logged[0]!, /accept/i);
    assert.match(logged[0]!, /docs\/security\.md#/);
  });
});

test("allowManagedPermissionRulesOnly: false -> silent, no warning", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "managed-settings.json");
    writeFileSync(path, JSON.stringify({ allowManagedPermissionRulesOnly: false }));
    const logged: string[] = [];
    const tripped = detectManagedPermissionMode((line) => logged.push(line), { path });
    assert.equal(tripped, false);
    assert.equal(logged.length, 0);
  });
});

test("managed settings file absent -> silent, no warning, no throw (the normal case)", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "does-not-exist.json");
    const logged: string[] = [];
    const tripped = detectManagedPermissionMode((line) => logged.push(line), { path });
    assert.equal(tripped, false);
    assert.equal(logged.length, 0);
  });
});

test("managed settings file unreadable/malformed JSON -> silent, no warning, no throw", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "managed-settings.json");
    writeFileSync(path, "{ not valid json");
    const logged: string[] = [];
    const tripped = detectManagedPermissionMode((line) => logged.push(line), { path });
    assert.equal(tripped, false);
    assert.equal(logged.length, 0);
  });
});

test("managed settings present but flag absent entirely -> silent, no warning", () => {
  withFixtureDir((dir) => {
    const path = join(dir, "managed-settings.json");
    writeFileSync(path, JSON.stringify({ permissions: { deny: ["Bash"] } }));
    const logged: string[] = [];
    const tripped = detectManagedPermissionMode((line) => logged.push(line), { path });
    assert.equal(tripped, false);
    assert.equal(logged.length, 0);
  });
});
