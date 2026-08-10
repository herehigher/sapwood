import assert from "node:assert/strict";
import test from "node:test";
import { applyTheme, nextTheme, readStoredTheme, restoreTheme, toggleTheme } from "./theme.ts";

/** Minimal stand-ins for `document`/`localStorage` — this repo's test harness has neither (see
 *  theme.ts's own header comment). Installed for the duration of `run()` and removed after, so
 *  every other test keeps running in the harness's real "no DOM" condition. */
function withFakeBrowserGlobals<T>(storedTheme: string | null, run: () => T) {
  const setAttributeCalls: Array<[string, string]> = [];
  const removeAttributeCalls: string[] = [];
  const g = globalThis as unknown as { document?: unknown; localStorage?: unknown };
  g.document = {
    documentElement: {
      setAttribute: (name: string, value: string) => setAttributeCalls.push([name, value]),
      removeAttribute: (name: string) => removeAttributeCalls.push(name),
    },
  };
  const store = new Map<string, string>();
  if (storedTheme !== null) store.set("sapwood-theme", storedTheme);
  g.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  };
  let result: T;
  try {
    result = run();
  } finally {
    delete g.document;
    delete g.localStorage;
  }
  return { result, setAttributeCalls, removeAttributeCalls };
}

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

test("applyTheme mutates the DOM attribute AND persists the choice", () => {
  const dark = withFakeBrowserGlobals(null, () => applyTheme("heartwood"));
  assert.deepEqual(dark.setAttributeCalls, [["data-theme", "heartwood"]]);
  assert.deepEqual(dark.removeAttributeCalls, []);

  const system = withFakeBrowserGlobals("sapwood", () => applyTheme(null));
  assert.deepEqual(system.setAttributeCalls, []);
  assert.deepEqual(system.removeAttributeCalls, ["data-theme"]);
});

// Gate② finding theme-override-not-restored: a stored override must be RE-APPLIED to the DOM on
// mount, not just read into React state — otherwise a reload under a `heartwood` override on a
// light-system browser stays light while the rail's own label claims dark is active.
test("restoreTheme re-applies a stored override to the DOM and returns it", () => {
  const { result, setAttributeCalls, removeAttributeCalls } = withFakeBrowserGlobals("heartwood", () => restoreTheme());
  assert.equal(result, "heartwood");
  assert.deepEqual(setAttributeCalls, [["data-theme", "heartwood"]]);
  assert.deepEqual(removeAttributeCalls, []);
});

test("restoreTheme with no stored override leaves the DOM at system default (no attribute write)", () => {
  const { result, setAttributeCalls, removeAttributeCalls } = withFakeBrowserGlobals(null, () => restoreTheme());
  assert.equal(result, null);
  assert.deepEqual(setAttributeCalls, []);
  assert.deepEqual(removeAttributeCalls, ["data-theme"]);
});

// #727 gate② finding rail-ac1-coverage: IconRail's click handler is now a one-line delegation to
// THIS function — testing it directly (with real `nextTheme`/`applyTheme` calls, not substitutes)
// is what actually proves the production composition still works, since a test that hands
// `railContent` its own callback instead would stay green even with `nextTheme`/`applyTheme`
// silently dropped from IconRail's real click handler.
test("toggleTheme advances the cycle, applies it to the DOM/storage, AND hands the new value to the caller's setter", () => {
  let setCalls: unknown[] = [];
  const setTheme = (next: unknown) => setCalls.push(next);

  const fromSystem = withFakeBrowserGlobals(null, () => toggleTheme(null, setTheme));
  assert.deepEqual(setCalls, ["sapwood"], "system -> light");
  assert.deepEqual(fromSystem.setAttributeCalls, [["data-theme", "sapwood"]]);

  setCalls = [];
  const fromLight = withFakeBrowserGlobals(null, () => toggleTheme("sapwood", setTheme));
  assert.deepEqual(setCalls, ["heartwood"], "light -> dark");
  assert.deepEqual(fromLight.setAttributeCalls, [["data-theme", "heartwood"]]);

  setCalls = [];
  const fromDark = withFakeBrowserGlobals("heartwood", () => toggleTheme("heartwood", setTheme));
  assert.deepEqual(setCalls, [null], "dark -> system");
  assert.deepEqual(fromDark.removeAttributeCalls, ["data-theme"]);
});
