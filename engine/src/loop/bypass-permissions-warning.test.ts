// bypass-permissions-warning.test.ts (#1011 AC3): host.permissionMode: bypassPermissions -> one
// warning log line + one durable event; any other value -> completely silent (no log, no event).
// No timing-dependent assertions (repo doctrine): a pure config-driven branch, no clock, no wait.
import assert from "node:assert/strict";
import { test } from "node:test";
import { detectBypassPermissionsMode } from "./bypass-permissions-warning.js";

test("host.permissionMode: bypassPermissions -> exactly one warning log line + one durable bypass-permissions-mode-configured event", () => {
  const logs: string[] = [];
  const events: Array<[string, unknown]> = [];
  const tripped = detectBypassPermissionsMode(
    { host: { permissionMode: "bypassPermissions" } },
    { appendEvent: (kind, payload) => events.push([kind, payload]) },
    (line) => logs.push(line),
  );
  assert.equal(tripped, true);
  assert.equal(logs.length, 1);
  // Names the mode, the "engine does not gate" stance, and points at the outer-boundary recipe.
  assert.match(logs[0]!, /bypassPermissions/);
  assert.match(logs[0]!, /does not gate/i);
  assert.match(logs[0]!, /docs\/security\.md#/);
  assert.equal(events.length, 1);
  const [kind, payload] = events[0]!;
  assert.equal(kind, "bypass-permissions-mode-configured");
  assert.deepEqual(payload, { permissionMode: "bypassPermissions" });
});

test("host.permissionMode: auto -> completely silent (no log, no event)", () => {
  const logs: string[] = [];
  const events: unknown[] = [];
  const tripped = detectBypassPermissionsMode(
    { host: { permissionMode: "auto" } },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
  );
  assert.equal(tripped, false);
  assert.deepEqual(logs, []);
  assert.deepEqual(events, []);
});

test("host.permissionMode: dontAsk -> completely silent (no log, no event)", () => {
  const logs: string[] = [];
  const events: unknown[] = [];
  const tripped = detectBypassPermissionsMode(
    { host: { permissionMode: "dontAsk" } },
    { appendEvent: (_kind, payload) => events.push(payload) },
    (line) => logs.push(line),
  );
  assert.equal(tripped, false);
  assert.deepEqual(logs, []);
  assert.deepEqual(events, []);
});

test("state.appendEvent throwing (e.g. a SQLite write failure) never escapes the function — the WARN is still logged before the throw, a second failure note is logged, and the call returns normally", () => {
  const logs: string[] = [];
  const tripped = detectBypassPermissionsMode(
    { host: { permissionMode: "bypassPermissions" } },
    {
      appendEvent: () => {
        throw new Error("db write failed");
      },
    },
    (line) => logs.push(line),
  );
  assert.equal(tripped, true);
  assert.equal(logs.length, 2);
  assert.match(logs[0]!, /bypassPermissions/);
  assert.match(logs[1]!, /event write failed/);
});
