import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveRate, estimateUsd } from "./pricing.js";

test("resolveRate: known CLI aliases resolve to distinct rates, ordered opus > sonnet > haiku", () => {
  const opus = resolveRate("opus");
  const sonnet = resolveRate("sonnet");
  const haiku = resolveRate("haiku");
  assert.ok(opus.input > sonnet.input && sonnet.input > haiku.input);
  assert.ok(opus.output > sonnet.output && sonnet.output > haiku.output);
});

test("resolveRate: full model ids resolve via substring match to the same rate as the alias", () => {
  assert.deepEqual(resolveRate("claude-opus-4-8"), resolveRate("opus"));
  assert.deepEqual(resolveRate("claude-sonnet-4-6"), resolveRate("sonnet"));
  assert.deepEqual(resolveRate("claude-haiku-4-5-20251001"), resolveRate("haiku"));
});

test("resolveRate: case-insensitive", () => {
  assert.deepEqual(resolveRate("Claude-Opus-4-8"), resolveRate("opus"));
});

test("resolveRate: unrecognized model falls back to the most expensive known tier (never silently under-estimates)", () => {
  assert.deepEqual(resolveRate("some-future-model-xyz"), resolveRate("opus"));
  assert.deepEqual(resolveRate("unknown"), resolveRate("opus"));
});

test("estimateUsd: accumulates input + output + cache-write + cache-read, each at its OWN rate", () => {
  const rate = resolveRate("opus");
  const entry = {
    model: "claude-opus-4-8",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  };
  const expected = rate.input + rate.output + rate.cacheWrite + rate.cacheRead;
  assert.ok(Math.abs(estimateUsd(entry) - expected) < 1e-9);
});

test("estimateUsd: cache reads are priced far below the input rate — pricing them at the input rate is exactly the over-trigger bug #33 exists to prevent", () => {
  const rate = resolveRate("opus");
  assert.ok(rate.cacheRead < rate.input / 2, "cache-read rate must be meaningfully cheaper than input");
  const cacheHeavy = {
    model: "claude-opus-4-8",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 1_000_000,
  };
  const wrongIfPricedAsInput = (1_000_000 / 1_000_000) * rate.input;
  assert.ok(estimateUsd(cacheHeavy) < wrongIfPricedAsInput);
  assert.ok(Math.abs(estimateUsd(cacheHeavy) - rate.cacheRead) < 1e-9);
});

test("estimateUsd: zero usage -> zero cost; unrecognized model still prices (via the opus fallback), never throws", () => {
  const zero = { model: "opus", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  assert.equal(estimateUsd(zero), 0);
  const weird = { model: "some-future-model", inputTokens: 1000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  assert.ok(estimateUsd(weird) > 0);
});
