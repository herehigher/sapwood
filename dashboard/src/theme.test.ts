import assert from "node:assert/strict";
import test from "node:test";
import { applyTheme, nextTheme, readStoredTheme } from "./theme.ts";

test("nextTheme cycles system default -> sapwood (light) -> heartwood (dark) -> system default", () => {
  assert.equal(nextTheme(null), "sapwood");
  assert.equal(nextTheme("sapwood"), "heartwood");
  assert.equal(nextTheme("heartwood"), null);
});

test("readStoredTheme returns null (system default) with no DOM/localStorage present", () => {
  assert.equal(readStoredTheme(), null);
});

test("applyTheme is a safe no-op with no DOM/localStorage present (this repo's test harness)", () => {
  assert.doesNotThrow(() => applyTheme("heartwood"));
  assert.doesNotThrow(() => applyTheme(null));
});
