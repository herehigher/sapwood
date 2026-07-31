// finding-key.test.ts (#449, design #402 R2) — the pure identity-key derivation: structural data
// only (issue #449's verification items 1-2). See finding-key.ts's own header doc for the exact
// per-path formula and the disclosed unlocated-marking deviation from design #402 §3a's literal
// illustrative tuple.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { boundRecords, classicThreadFindingKey, engineAgentFindingKey } from "./finding-key.js";

// ── engine-agent path ───────────────────────────────────────────────────────────────────────

test("engineAgentFindingKey: identical (kind, path) findings from two different reviews produce equal keys", () => {
  const a = engineAgentFindingKey({ id: "review-1-finding-a", kind: "security", path: "src/x.ts" });
  const b = engineAgentFindingKey({ id: "review-2-finding-b", kind: "security", path: "src/x.ts" });
  assert.equal(a.key, b.key);
  assert.equal(a.located, true);
  assert.equal(b.located, true);
});

test("engineAgentFindingKey: a reworded body has no way to reach the key — body is not even an accepted field", () => {
  // The type signature itself proves the property: neither call below can pass a `body` at all.
  const before = engineAgentFindingKey({ id: "f1", kind: "correctness", path: "src/x.ts" });
  const afterReword = engineAgentFindingKey({ id: "f1", kind: "correctness", path: "src/x.ts" });
  assert.equal(before.key, afterReword.key);
});

test("engineAgentFindingKey: different paths produce different keys", () => {
  const a = engineAgentFindingKey({ id: "f1", kind: "security", path: "src/x.ts" });
  const b = engineAgentFindingKey({ id: "f1", kind: "security", path: "src/y.ts" });
  assert.notEqual(a.key, b.key);
});

test("engineAgentFindingKey: different kinds, same path, produce different keys", () => {
  const a = engineAgentFindingKey({ id: "f1", kind: "security", path: "src/x.ts" });
  const b = engineAgentFindingKey({ id: "f1", kind: "style", path: "src/x.ts" });
  assert.notEqual(a.key, b.key);
});

test("engineAgentFindingKey: kind absent -> unclassified, same key across two absent-kind findings on the same path", () => {
  const a = engineAgentFindingKey({ id: "f1", path: "src/x.ts" });
  const b = engineAgentFindingKey({ id: "f2", path: "src/x.ts" });
  assert.equal(a.key, b.key);
});

// ── unlocated marking (verification item 2) ─────────────────────────────────────────────────

test("engineAgentFindingKey: no path -> located: false, key distinguishable from any located key", () => {
  const unlocated = engineAgentFindingKey({ id: "f1", kind: "security" });
  const located = engineAgentFindingKey({ id: "f1", kind: "security", path: "src/x.ts" });
  assert.equal(unlocated.located, false);
  assert.equal(located.located, true);
  assert.notEqual(unlocated.key, located.key);
});

test("engineAgentFindingKey: two DIFFERENT unlocated findings do not compare equal (never fakes recurrence)", () => {
  const a = engineAgentFindingKey({ id: "finding-a", kind: "security" });
  const b = engineAgentFindingKey({ id: "finding-b", kind: "security" });
  assert.equal(a.located, false);
  assert.equal(b.located, false);
  assert.notEqual(a.key, b.key);
});

test("engineAgentFindingKey: the SAME finding (same id) is stable across two calls (idempotent, not random)", () => {
  const a = engineAgentFindingKey({ id: "finding-a", kind: "security" });
  const b = engineAgentFindingKey({ id: "finding-a", kind: "security" });
  assert.equal(a.key, b.key);
});

// ── classic (thread) path ───────────────────────────────────────────────────────────────────

test("classicThreadFindingKey: path + findingDigest present -> keyed on (path, digest), located: true", () => {
  const result = classicThreadFindingKey({ id: "THREAD_1", path: "src/x.ts", findingDigest: "deadbeef" });
  assert.equal(result.located, true);
  assert.match(result.key, /src\/x\.ts/);
  assert.match(result.key, /deadbeef/);
});

test("classicThreadFindingKey: a thread RECREATED (new thread id) with the SAME span+digest gets the SAME key", () => {
  const round1 = classicThreadFindingKey({ id: "THREAD_ROUND_1", path: "src/x.ts", findingDigest: "deadbeef" });
  const round2 = classicThreadFindingKey({ id: "THREAD_ROUND_2", path: "src/x.ts", findingDigest: "deadbeef" });
  assert.equal(round1.key, round2.key);
});

test("classicThreadFindingKey: a reworded finding (different digest) on the same span gets a DIFFERENT key", () => {
  const original = classicThreadFindingKey({ id: "THREAD_1", path: "src/x.ts", findingDigest: "deadbeef" });
  const reworded = classicThreadFindingKey({ id: "THREAD_1", path: "src/x.ts", findingDigest: "c0ffee" });
  assert.notEqual(original.key, reworded.key);
});

// ── classic-path degradation — #378 span data absent (D1: narrower, never wider) ───────────────

test("classicThreadFindingKey: no path/digest at all -> thread-id-only fallback, located: false", () => {
  const result = classicThreadFindingKey({ id: "THREAD_1" });
  assert.equal(result.located, false);
  assert.match(result.key, /THREAD_1/);
});

test("classicThreadFindingKey: path present but findingDigest null (unkeyable body) -> thread-id fallback", () => {
  const result = classicThreadFindingKey({ id: "THREAD_1", path: "src/x.ts", findingDigest: null });
  assert.equal(result.located, false);
  assert.match(result.key, /THREAD_1/);
});

test("classicThreadFindingKey: digest present but path null (fully outdated thread) -> thread-id fallback", () => {
  const result = classicThreadFindingKey({ id: "THREAD_1", path: null, findingDigest: "deadbeef" });
  assert.equal(result.located, false);
});

test("classicThreadFindingKey: thread-id fallback never crashes and two DIFFERENT threads never collide", () => {
  const a = classicThreadFindingKey({ id: "THREAD_A" });
  const b = classicThreadFindingKey({ id: "THREAD_B" });
  assert.notEqual(a.key, b.key);
});

// ── boundRecords: bounded + marked truncation, never a silent drop ─────────────────────────────

test("boundRecords: under the bound -> all entries kept, truncated: false", () => {
  const result = boundRecords([1, 2, 3], 5);
  assert.deepEqual(result.entries, [1, 2, 3]);
  assert.equal(result.truncated, false);
});

test("boundRecords: exactly at the bound -> all entries kept, truncated: false", () => {
  const result = boundRecords([1, 2, 3], 3);
  assert.deepEqual(result.entries, [1, 2, 3]);
  assert.equal(result.truncated, false);
});

test("boundRecords: over the bound -> truncated to the first N, truncated: true (marked, not silently dropped)", () => {
  const result = boundRecords([1, 2, 3, 4, 5], 3);
  assert.deepEqual(result.entries, [1, 2, 3]);
  assert.equal(result.truncated, true);
});

test("boundRecords: empty input -> empty output, truncated: false", () => {
  const result = boundRecords([], 5);
  assert.deepEqual(result.entries, []);
  assert.equal(result.truncated, false);
});

// ── grep invariants (#449 verification plan item 7) ─────────────────────────────────────────

test("finding-key.ts is pure structural data — no timestamp/wall-clock comparison anywhere in this module", () => {
  const source = readFileSync(new URL("./finding-key.ts", import.meta.url), "utf8");
  for (const forbidden of ["Date.now(", "new Date(", ".getTime(", "Date.parse("]) {
    assert.doesNotMatch(source, new RegExp(forbidden.replace(/[.()]/g, "\\$&")), `finding-key.ts unexpectedly uses ${forbidden}`);
  }
});

test("#449: no PROTECTED_SUFFIXES source file contains this issue's new symbols (guard/reviewer/merge-driver never touched)", () => {
  const protectedFiles = [
    new URL("../guard/guard.ts", import.meta.url),
    new URL("../guard/guard-hook.ts", import.meta.url),
    new URL("../roles/reviewer.ts", import.meta.url),
    new URL("../roles/merge-driver.ts", import.meta.url),
  ];
  const introducedSymbols = [
    "FindingKeyResult",
    "engineAgentFindingKey",
    "classicThreadFindingKey",
    "boundRecords",
    "gatherFixupFindingRecord",
    "FixupFindingRecordEntry",
    "finding-key",
  ];
  for (const url of protectedFiles) {
    const source = readFileSync(url, "utf8");
    for (const symbol of introducedSymbols) {
      assert.doesNotMatch(source, new RegExp(symbol), `${url.pathname} unexpectedly references ${symbol}`);
    }
  }
});
