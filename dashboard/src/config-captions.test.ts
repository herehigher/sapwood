import assert from "node:assert/strict";
import test from "node:test";
// Test-only import: this file runs under `node --test` directly, never through the vite bundle
// that ships to the browser, so pulling in the engine's own allowlist here does not touch the
// dashboard's runtime dependency budget (scaffold.test.ts's separate check covers that). This is
// the drift guard between the server's CONFIG_ALLOWLIST and this file's own caption list.
import { CONFIG_ALLOWLIST } from "../../engine/src/state/read-model.ts";
import { CONFIG_GROUPS, CONFIG_KEYS, readConfigPath } from "./config-captions.ts";

test("every server-allowlisted config key has a caption and a known group", () => {
  const captioned = new Set(CONFIG_KEYS.map((k) => k.path));
  const missing = CONFIG_ALLOWLIST.filter((path) => !captioned.has(path));
  assert.deepEqual(missing, []);
});

test("the caption list carries no key the server doesn't actually serve", () => {
  const allowed = new Set(CONFIG_ALLOWLIST);
  const extra = CONFIG_KEYS.map((k) => k.path).filter((path) => !allowed.has(path));
  assert.deepEqual(extra, []);
});

test("every caption entry's group is one of the six documented drawer groups", () => {
  for (const key of CONFIG_KEYS) {
    assert.ok((CONFIG_GROUPS as readonly string[]).includes(key.group), `${key.path} has unknown group ${key.group}`);
  }
});

test("readConfigPath walks dotted paths and returns undefined for a missing leaf", () => {
  assert.equal(readConfigPath({ worker: { budgetUsdSoft: 5 } }, "worker.budgetUsdSoft"), 5);
  assert.equal(readConfigPath({ worker: {} }, "worker.budgetUsdSoft"), undefined);
  assert.equal(readConfigPath({}, "board.owner"), undefined);
});
