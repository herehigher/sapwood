import assert from "node:assert/strict";
import test from "node:test";
import { BUILD_SHA, BUILD_TIME, isDistStale, shortSha } from "./build-info.ts";

// This suite runs under `node --test` directly (no vite processing) — see build-info.ts's own
// doc for why BUILD_SHA/BUILD_TIME read null here; the real embedded value is proven against the
// actual built bundle by bundle.test.ts's "#894 build-injection" test instead.
test("BUILD_SHA/BUILD_TIME degrade to null outside a real vite build, rather than throwing", () => {
  assert.equal(BUILD_SHA, null);
  assert.equal(BUILD_TIME, null);
});

test("isDistStale: an identical dist sha and repo HEAD is fresh", () => {
  assert.equal(isDistStale("abc1234", "abc1234"), false);
});

test("isDistStale: a divergent dist sha and repo HEAD is stale", () => {
  assert.equal(isDistStale("abc1234", "def5678"), true);
});

test("isDistStale: either side unknown reads as fresh — never a guessed staleness claim", () => {
  assert.equal(isDistStale(null, "abc1234"), false);
  assert.equal(isDistStale("abc1234", null), false);
  assert.equal(isDistStale(null, null), false);
});

test("shortSha: truncates to 7 chars, and names an unknown sha honestly", () => {
  assert.equal(shortSha("0123456789abcdef"), "0123456");
  assert.equal(shortSha(null), "unknown");
});
