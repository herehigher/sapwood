import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfigSchema, type SapwoodConfig } from "./config.js";
import { defaultPricingPath, estimateUsd, loadPricingTable, type PricingTable, resolveRate } from "./pricing.js";

const baseCfg = (pricingFile?: string): SapwoodConfig =>
  ConfigSchema.parse({
    board: { owner: "o", repo: "r", projectNumber: 4 },
    ...(pricingFile ? { worker: { pricingFile } } : {}),
  });

// ── shipped default pricing.yaml ──

test("defaultPricingPath: resolves to the shipped pricing.yaml, which exists", () => {
  const p = defaultPricingPath();
  assert.ok(p.endsWith("pricing.yaml"));
  assert.ok(existsSync(p), `shipped default pricing file missing at ${p}`);
});

test("loadPricingTable: unset pricingFile -> the shipped default, matching the current expected rates", () => {
  const table = loadPricingTable(baseCfg());
  assert.deepEqual(table.opus, { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 200_000 });
  assert.deepEqual(table.sonnet, { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3, contextWindow: 200_000 });
  assert.deepEqual(table.haiku, { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1, contextWindow: 200_000 });
});

test("loadPricingTable: a configured worker.pricingFile WINS over the shipped default, and user-added aliases are allowed", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-pricing-"));
  try {
    const p = join(dir, "my-rates.yaml");
    writeFileSync(
      p,
      [
        "models:",
        "  opus: { input: 7, output: 30, cacheWrite: 8.75, cacheRead: 0.7, contextWindow: 200000 }",
        "  my-custom-model: { input: 2, output: 4, cacheWrite: 2.5, cacheRead: 0.2, contextWindow: 100000 }",
        "",
      ].join("\n"),
    );
    const table = loadPricingTable(baseCfg(p));
    assert.deepEqual(table.opus, { input: 7, output: 30, cacheWrite: 8.75, cacheRead: 0.7, contextWindow: 200_000 });
    assert.deepEqual(table["my-custom-model"], { input: 2, output: 4, cacheWrite: 2.5, cacheRead: 0.2, contextWindow: 100_000 });
    assert.equal(table.sonnet, undefined, "override REPLACES the table — no silent merge with built-ins");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #155: contextWindow — same file, same fail-closed load rules as the USD rates ──

test("loadPricingTable: a model entry missing contextWindow fails loudly, the SAME failure mode as one missing a rate field", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-pricing-"));
  try {
    const p = join(dir, "no-context-window.yaml");
    writeFileSync(p, "models: { opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 } }\n");
    assert.throws(() => loadPricingTable(baseCfg(p)), /no-context-window\.yaml/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadPricingTable: contextWindow must be a positive integer — zero, negative, and non-integer all fail loudly", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-pricing-"));
  try {
    const cases: Array<[string, string]> = [
      ["cw-zero.yaml", "models: { opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 0 } }"],
      ["cw-negative.yaml", "models: { opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: -200000 } }"],
      ["cw-fractional.yaml", "models: { opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 200000.5 } }"],
    ];
    for (const [name, body] of cases) {
      const p = join(dir, name);
      writeFileSync(p, body);
      assert.throws(() => loadPricingTable(baseCfg(p)), new RegExp(name.replace(".", "\\.")), `expected ${name} to fail loudly`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── fail-loud validation (never a silent fallback to built-ins) ──

test("loadPricingTable: a configured pricingFile that's missing fails loudly, NAMING the path", () => {
  assert.throws(() => loadPricingTable(baseCfg("/nonexistent/rates.yaml")), /\/nonexistent\/rates\.yaml/);
});

test("loadPricingTable: malformed YAML / wrong shape / bad rates all fail loudly, never silently fall back", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-pricing-"));
  try {
    const cases: Array<[string, string, RegExp]> = [
      ["not-yaml.yaml", "models: {opus: {input: [unclosed", /not-yaml\.yaml/],
      ["no-models.yaml", "rates: {opus: {input: 1}}", /no-models\.yaml/],
      ["empty-models.yaml", "models: {}", /empty-models\.yaml/],
      [
        "negative.yaml",
        "models: {opus: {input: -5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 200000}}",
        /negative\.yaml/,
      ],
      [
        "non-numeric.yaml",
        "models: {opus: {input: cheap, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 200000}}",
        /non-numeric\.yaml/,
      ],
      ["missing-field.yaml", "models: {opus: {input: 5, output: 25, cacheWrite: 6.25, contextWindow: 200000}}", /missing-field\.yaml/],
      [
        "extra-field.yaml",
        "models: {opus: {input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 200000, vibes: 1}}",
        /extra-field\.yaml/,
      ],
      ["scalar.yaml", "just a string", /scalar\.yaml/],
    ];
    for (const [name, body, re] of cases) {
      const p = join(dir, name);
      writeFileSync(p, body);
      assert.throws(() => loadPricingTable(baseCfg(p)), re, `expected ${name} to fail loudly`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── resolveRate / estimateUsd over a loaded table ──

const table: PricingTable = loadPricingTable(baseCfg());

test("resolveRate: known aliases resolve to distinct rates, ordered opus > sonnet > haiku", () => {
  const opus = resolveRate("opus", table);
  const sonnet = resolveRate("sonnet", table);
  const haiku = resolveRate("haiku", table);
  assert.ok(opus.input > sonnet.input && sonnet.input > haiku.input);
  assert.ok(opus.output > sonnet.output && sonnet.output > haiku.output);
});

test("resolveRate: full model ids resolve via substring match to the same rate as the alias", () => {
  assert.deepEqual(resolveRate("claude-opus-4-8", table), resolveRate("opus", table));
  assert.deepEqual(resolveRate("claude-sonnet-4-6", table), resolveRate("sonnet", table));
  assert.deepEqual(resolveRate("claude-haiku-4-5-20251001", table), resolveRate("haiku", table));
});

test("resolveRate: case-insensitive — both the model id AND the table's alias keys", () => {
  assert.deepEqual(resolveRate("Claude-Opus-4-8", table), resolveRate("opus", table));
});

test("resolveRate: unrecognized model falls back to the most expensive tier of the LOADED table (never silently under-estimates)", () => {
  assert.deepEqual(resolveRate("some-future-model-xyz", table), resolveRate("opus", table));
  assert.deepEqual(resolveRate("unknown", table), resolveRate("opus", table));
  // And with a USER table where a custom alias is the priciest, THAT tier is the fallback —
  // "most expensive" is a property of the loaded table, not a hardcoded "opus".
  const dir = mkdtempSync(join(tmpdir(), "sapwood-pricing-"));
  try {
    const p = join(dir, "custom.yaml");
    writeFileSync(
      p,
      [
        "models:",
        "  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5, contextWindow: 200000 }",
        "  my-premium: { input: 50, output: 250, cacheWrite: 62.5, cacheRead: 5, contextWindow: 200000 }",
        "",
      ].join("\n"),
    );
    const custom = loadPricingTable(baseCfg(p));
    assert.deepEqual(resolveRate("never-heard-of-it", custom), custom["my-premium"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("estimateUsd: accumulates input + output + cache-write + cache-read, each at its OWN rate", () => {
  const rate = resolveRate("opus", table);
  const entry = {
    model: "claude-opus-4-8",
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cacheCreationTokens: 1_000_000,
    cacheReadTokens: 1_000_000,
  };
  const expected = rate.input + rate.output + rate.cacheWrite + rate.cacheRead;
  assert.ok(Math.abs(estimateUsd(entry, table) - expected) < 1e-9);
});

test("estimateUsd: cache reads are priced far below the input rate — pricing them at the input rate is exactly the over-trigger bug #33 exists to prevent", () => {
  const rate = resolveRate("opus", table);
  assert.ok(rate.cacheRead < rate.input / 2, "cache-read rate must be meaningfully cheaper than input");
  const cacheHeavy = {
    model: "claude-opus-4-8",
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 1_000_000,
  };
  const wrongIfPricedAsInput = (1_000_000 / 1_000_000) * rate.input;
  assert.ok(estimateUsd(cacheHeavy, table) < wrongIfPricedAsInput);
  assert.ok(Math.abs(estimateUsd(cacheHeavy, table) - rate.cacheRead) < 1e-9);
});

test("estimateUsd: zero usage -> zero cost; unrecognized model still prices (most-expensive fallback), never throws", () => {
  const zero = { model: "opus", inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  assert.equal(estimateUsd(zero, table), 0);
  const weird = { model: "some-future-model", inputTokens: 1000, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
  assert.ok(estimateUsd(weird, table) > 0);
});
