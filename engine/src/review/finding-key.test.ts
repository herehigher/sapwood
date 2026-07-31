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
    // #449 gate② P1/P2 fix additions (loop/conductor.ts, forge/forge.ts, state/state.ts) — same
    // guarantee, extended to the fix round's own new symbols.
    "gatherFixDiffPaths",
    "changedFilePaths",
    "compareChangedFiles",
    "lastDriveFixupEvent",
  ];
  for (const url of protectedFiles) {
    const source = readFileSync(url, "utf8");
    for (const symbol of introducedSymbols) {
      assert.doesNotMatch(source, new RegExp(symbol), `${url.pathname} unexpectedly references ${symbol}`);
    }
  }
});

// ── key grammar contract (#449 gate② P3c, re-pinned after the Codex cross-vendor P1 fix) ────────
// R3 (design #402's convergence classifier, #450) must extract a key's `path` segment to test
// membership in `fixDiffPaths` — the persisted `drive-fixup` payload's finding entries are
// `{key, severity, kind}`, no separate `path` field (issue #449's own payload shape). These tests
// pin the EXACT JSON-tagged-tuple shapes (see finding-key.ts's "ENCODING" header doc) so an
// innocent format tweak here cannot silently break that future parse, AND so ambiguity between a
// located and an unlocated key is provably impossible — not merely unlikely.

test('#449 gate② P3c: engineAgentFindingKey grammar is pinned — located key is exactly `["engine-agent","loc",<kind>,<path>]`', () => {
  assert.equal(
    engineAgentFindingKey({ id: "f1", kind: "security", path: "src/x.ts" }).key,
    JSON.stringify(["engine-agent", "loc", "security", "src/x.ts"]),
  );
  assert.equal(
    engineAgentFindingKey({ id: "f1", path: "src/x.ts" }).key,
    JSON.stringify(["engine-agent", "loc", "unclassified", "src/x.ts"]),
    "kind absent -> the literal 'unclassified' token",
  );
});

test('#449 gate② P3c: engineAgentFindingKey grammar is pinned — unlocated key is exactly `["engine-agent","unloc",<kind>,<16-hex-char id digest>]`', () => {
  const result = engineAgentFindingKey({ id: "f1", kind: "security" });
  const decoded = JSON.parse(result.key) as string[];
  assert.deepEqual(decoded.slice(0, 3), ["engine-agent", "unloc", "security"]);
  assert.match(decoded[3]!, /^[0-9a-f]{16}$/, "the fourth element is a 16-hex-char digest, never the raw id");
  assert.notEqual(decoded[3], "f1", "the raw id must never appear verbatim");
});

test('#449 gate② P3c: classicThreadFindingKey grammar is pinned — located key is exactly `["classic","loc",<path>,<findingDigest>]`', () => {
  assert.equal(
    classicThreadFindingKey({ id: "T1", path: "src/x.ts", findingDigest: "abc123" }).key,
    JSON.stringify(["classic", "loc", "src/x.ts", "abc123"]),
  );
});

test('#449 gate② P3c: classicThreadFindingKey grammar is pinned — thread-id fallback is exactly `["classic","unloc",<id>]`', () => {
  assert.equal(classicThreadFindingKey({ id: "T1" }).key, JSON.stringify(["classic", "unloc", "T1"]));
  assert.equal(
    classicThreadFindingKey({ id: "T1", path: "src/x.ts", findingDigest: null }).key,
    JSON.stringify(["classic", "unloc", "T1"]),
  );
  assert.equal(classicThreadFindingKey({ id: "T1", path: null, findingDigest: "abc" }).key, JSON.stringify(["classic", "unloc", "T1"]));
});

// ── adversarial: ambiguity impossible BY CONSTRUCTION (#449 gate② Codex cross-vendor P1 fix) ────
// Round 1's colon-joined string (`"engine-agent:<kind>:«unlocated»:<id>"`) had a real injection
// hole Codex found: nothing stops a repo from containing a path literally named `«unlocated»:f1`
// — a session-supplied `path` is untrusted text (validated only for diff membership, never for
// "does it look like our own marker"), so a crafted path could forge equality with an unlocated
// key. The JSON-tagged-tuple encoding closes this structurally: a located key's tag is always
// `"loc"` at array position 1, an unlocated key's is always `"unloc"` — no field's CONTENT can
// ever land at that position, so no path/digest value, however adversarial, can flip one into the
// other. These tests prove it with the sharpest adversarial input available: a path/id set to the
// EXACT byte string an unlocated key for some other finding encodes to.

test("#449 gate② Codex cross-vendor P1 fix: a genuine changed path set to the EXACT text of an unlocated key never compares equal to it", () => {
  const unlocated = engineAgentFindingKey({ id: "f1", kind: "security" }); // no path
  // The sharpest adversarial path: byte-identical to what THIS unlocated key itself encodes to.
  const adversarial = engineAgentFindingKey({ id: "f2", kind: "correctness", path: unlocated.key });
  assert.notEqual(adversarial.key, unlocated.key);
  assert.equal(adversarial.located, true, "a finding WITH a path is always located, regardless of what that path's text looks like");
});

test("#449 gate② Codex cross-vendor P1 fix: a path containing the literal old-style marker/delimiter text is just ordinary path content now", () => {
  const adversarialPath = "«unlocated»:f1"; // the exact text round 1's colon-joined scheme would have produced
  const located = engineAgentFindingKey({ id: "f1", kind: "security", path: adversarialPath });
  const unlocated = engineAgentFindingKey({ id: "f1", kind: "security" });
  assert.notEqual(located.key, unlocated.key);
  assert.equal(JSON.parse(located.key)[3], adversarialPath, "the adversarial text round-trips as ordinary path content, not a forged tag");
});

test("#449 gate② Codex cross-vendor P1 fix (classic path): a thread span path set to the EXACT text of a thread-id-fallback key never compares equal to it", () => {
  const fallback = classicThreadFindingKey({ id: "THREAD_1" }); // no span data
  const adversarial = classicThreadFindingKey({ id: "THREAD_2", path: fallback.key, findingDigest: "deadbeef" });
  assert.notEqual(adversarial.key, fallback.key);
  assert.equal(adversarial.located, true);
});

// ── prose-via-id closed structurally (#449 gate② Codex cross-vendor P2 fix) ─────────────────────
// `Finding.id`'s runtime validation (`isFinding`, roles/reviewer.ts) only requires a non-empty
// string — nothing stops a session from setting `id` to its entire finding body. Round 1 folded
// `id` VERBATIM into the unlocated key; this closes it structurally, not by trusting sessions to
// behave: only a short, non-reversible digest of `id` ever reaches the key.

test("#449 gate② Codex cross-vendor P2 fix: a prose-length Finding.id is folded to a SHORT DIGEST — the raw text never appears in the key", () => {
  const SENTINEL = "SENTINEL_PROSE_SMUGGLED_VIA_ID_7f3a";
  const proseId = `${SENTINEL} — this finding's entire body, smuggled through the id field instead, repeated for length `.repeat(10);
  const result = engineAgentFindingKey({ id: proseId, kind: "security" });
  assert.doesNotMatch(result.key, new RegExp(SENTINEL));
  assert.ok(result.key.length < 100, `key must stay short regardless of id length (got ${result.key.length} chars)`);
  const decoded = JSON.parse(result.key) as string[];
  assert.match(decoded[3]!, /^[0-9a-f]{16}$/);
});

test("#449 gate② Codex cross-vendor P2 fix: the id digest is still a real disambiguator — two DIFFERENT prose ids produce DIFFERENT digests", () => {
  const a = engineAgentFindingKey({ id: "prose id number one, quite long and body-shaped", kind: "security" });
  const b = engineAgentFindingKey({ id: "prose id number two, a totally different body", kind: "security" });
  assert.notEqual(a.key, b.key);
});
