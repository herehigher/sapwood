#!/usr/bin/env -S npx tsx
// estimator-replay.ts (#935 AC3) — real-transcript replay for the live cost estimator
// (parseAssistantUsageDeltas + estimateUsd, engine/src/roles/worker.ts). The three estimator
// mechanisms it exercises (tiered cache pricing, dedup-by-message-id, chars/4 output fallback)
// already have synthetic unit coverage in worker.test.ts; what only a REAL captured stream-json
// transcript can prove is that the estimate lands close to the terminal `result.total_cost_usd`
// on an actual dogfood run, not just on hand-built fixtures.
//
// Real transcripts are dev-time artefacts of one specific issue's development, not framework
// fixtures — they don't belong in this repo (owner ruling 2026-08-18) and are excluded from
// `npm test` entirely. This script is the operator-run substitute: point it at a directory of
// real `*.jsonl` stream-json captures (the dogfood deploy keeps its own under
// `data/fixtures/estimator/`) and it replays the same estimate/compare logic the removed AC3
// unit tests used to run inline, against whatever transcripts are present.
//
// Usage (from engine/): npx tsx scripts/estimator-replay.ts <fixture-dir>
//                        npx tsx scripts/estimator-replay.ts --self-test
//
// Exit non-zero if: the directory has no *.jsonl files; a file has no terminal `result` line
// with a finite, POSITIVE `total_cost_usd` (a zero/missing real cost makes the relative-error
// division meaningless — never silently treated as a pass); a file has fewer than
// MIN_ASSISTANT_LINES assistant lines (an empty/near-empty transcript proves nothing); the
// computed estimate itself is not finite; or any file's signed relative error falls outside
// [-12%, +5%] of the real total — the same under-biased-but-bounded band the #935 PO adjudication
// set for the estimator (reference figures on the original dogfood lane #920 captures:
// -1.7% / -1.3%). Every one of those is a fail-CLOSED condition: an invalid/empty transcript is
// reported and counted as a failure, never silently skipped to a clean exit.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { ConfigSchema } from "../src/config/config.js";
import { estimateUsd, loadPricingTable, type PricingTable } from "../src/config/pricing.js";
import { parseAssistantUsageDeltas } from "../src/roles/worker.js";

const LOWER_BAND = -0.12;
const UPPER_BAND = 0.05;
// A transcript with fewer assistant lines than this cannot meaningfully exercise the
// dedup-by-message-id / chars-per-4 machinery being replayed — treated the same as "empty".
const MIN_ASSISTANT_LINES = 1;

type Verdict =
  | { file: string; ok: true; estimateUsdTotal: number; real: number; signedError: number }
  | { file: string; ok: false; reason: string };

/** Parses `jsonl` once and evaluates it against the real terminal cost — the single fail-closed
 *  gate every file (and the self-test fixtures below) goes through. Never divides by a zero/
 *  missing/non-finite real cost: that path is reported as a failure, not a false "0% error" pass. */
function evaluateTranscript(name: string, jsonl: string, pricing: PricingTable): Verdict {
  const parsed: Record<string, unknown>[] = [];
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try {
      parsed.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      // malformed/partial line — skipped, same tolerance stance as parseAssistantUsageDeltas
    }
  }

  const assistantCount = parsed.filter((o) => o.type === "assistant").length;
  if (assistantCount < MIN_ASSISTANT_LINES) {
    return { file: name, ok: false, reason: `only ${assistantCount} assistant line(s) (need >= ${MIN_ASSISTANT_LINES})` };
  }

  const resultLine = parsed.find((o) => o.type === "result") as { total_cost_usd?: unknown } | undefined;
  const real = resultLine?.total_cost_usd;
  if (typeof real !== "number" || !Number.isFinite(real) || real <= 0) {
    return { file: name, ok: false, reason: "no terminal result line with a finite, positive total_cost_usd" };
  }

  const deduped = parseAssistantUsageDeltas(jsonl);
  const estimateUsdTotal = deduped.reduce((sum, d) => sum + estimateUsd(d, pricing), 0);
  if (!Number.isFinite(estimateUsdTotal)) {
    return { file: name, ok: false, reason: `computed estimate is not finite (${estimateUsdTotal})` };
  }

  const signedError = (estimateUsdTotal - real) / real;
  return { file: name, ok: true, estimateUsdTotal, real, signedError };
}

function printVerdict(v: Verdict): boolean {
  if (!v.ok) {
    console.error(`${v.file}: FAIL — ${v.reason}`);
    return false;
  }
  const outOfBand = v.signedError < LOWER_BAND || v.signedError > UPPER_BAND;
  console.log(
    `${v.file}: estimate=$${v.estimateUsdTotal.toFixed(4)} real=$${v.real.toFixed(4)} ` +
      `error=${(v.signedError * 100).toFixed(1)}%${outOfBand ? "  OUT OF BAND [-12%, +5%]" : ""}`,
  );
  return !outOfBand;
}

// Proves the fail-closed gate itself works, without needing a real transcript on disk — covers
// exactly the class of bug this replaces a silent-pass with: an empty file, a file with no
// terminal result line, and (the reported P2) a terminal result line whose total_cost_usd is 0.
function selfTest(pricing: PricingTable): void {
  const ASSISTANT_LINE = JSON.stringify({
    type: "assistant",
    message: {
      id: "m1",
      model: "claude-sonnet-4-5",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 10, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    },
  });

  const empty = evaluateTranscript("empty.jsonl", "", pricing);
  assert.equal(empty.ok, false, "empty transcript must fail closed");

  const noResult = evaluateTranscript("no-result.jsonl", ASSISTANT_LINE, pricing);
  assert.equal(noResult.ok, false, "a transcript with no terminal result line must fail closed");

  const zeroResultLine = JSON.stringify({ type: "result", total_cost_usd: 0, usage: {} });
  const zeroCost = evaluateTranscript("zero-cost.jsonl", `${ASSISTANT_LINE}\n${zeroResultLine}`, pricing);
  assert.equal(zeroCost.ok, false, "a terminal result with total_cost_usd: 0 must fail closed (the reported P2)");

  const validResultLine = JSON.stringify({ type: "result", total_cost_usd: 1, usage: {} });
  const valid = evaluateTranscript("valid.jsonl", `${ASSISTANT_LINE}\n${validResultLine}`, pricing);
  assert.equal(valid.ok, true, "a well-formed transcript with a positive real cost must still pass through");
  if (valid.ok) assert.ok(Number.isFinite(valid.signedError), "a passing verdict's signedError must be finite");

  console.log("estimator-replay --self-test: PASS (empty / no-result / zero-cost all fail closed)");
}

async function main(): Promise<void> {
  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  const pricing = loadPricingTable(cfg);

  const dirArg = process.argv[2];
  if (dirArg === "--self-test") {
    selfTest(pricing);
    process.exit(0);
  }
  if (!dirArg) {
    console.error("usage: npx tsx scripts/estimator-replay.ts <fixture-dir>  |  --self-test");
    process.exit(1);
  }

  const dir = resolve(dirArg);
  const files = readdirSync(dir)
    .filter((f) => extname(f) === ".jsonl")
    .sort();
  if (files.length === 0) {
    console.error(`estimator-replay: no *.jsonl files found in ${dir}`);
    process.exit(1);
  }

  let allOk = true;
  for (const file of files) {
    const jsonl = readFileSync(join(dir, file), "utf8");
    const verdict = evaluateTranscript(file, jsonl, pricing);
    if (!printVerdict(verdict)) allOk = false;
  }

  process.exit(allOk ? 0 : 1);
}

await main();
