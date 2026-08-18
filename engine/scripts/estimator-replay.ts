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
//
// Exit non-zero if the directory has no *.jsonl files, or if any file's signed relative error
// falls outside [-12%, +5%] of the real total — the same under-biased-but-bounded band the #935
// PO adjudication set for the estimator (reference figures on the original dogfood lane #920
// captures: -1.7% / -1.3%).
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { ConfigSchema } from "../src/config/config.js";
import { estimateUsd, loadPricingTable } from "../src/config/pricing.js";
import { parseAssistantUsageDeltas } from "../src/roles/worker.js";

const LOWER_BAND = -0.12;
const UPPER_BAND = 0.05;

function findTerminalResult(jsonl: string): { total_cost_usd: number } | undefined {
  for (const line of jsonl.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(t) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (obj.type === "result" && typeof obj.total_cost_usd === "number") {
      return { total_cost_usd: obj.total_cost_usd };
    }
  }
  return undefined;
}

async function main(): Promise<void> {
  const dirArg = process.argv[2];
  if (!dirArg) {
    console.error("usage: npx tsx scripts/estimator-replay.ts <fixture-dir>");
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

  const cfg = ConfigSchema.parse({ board: { owner: "o", repo: "r", projectNumber: 4 } });
  const pricing = loadPricingTable(cfg);

  let anyOutOfBand = false;
  for (const file of files) {
    const jsonl = readFileSync(join(dir, file), "utf8");
    const real = findTerminalResult(jsonl);
    if (!real) {
      console.error(`${file}: no terminal result line — skipped`);
      anyOutOfBand = true;
      continue;
    }
    const deduped = parseAssistantUsageDeltas(jsonl);
    const estimateUsdTotal = deduped.reduce((sum, d) => sum + estimateUsd(d, pricing), 0);
    const signedError = (estimateUsdTotal - real.total_cost_usd) / real.total_cost_usd;
    const outOfBand = signedError < LOWER_BAND || signedError > UPPER_BAND;
    if (outOfBand) anyOutOfBand = true;
    console.log(
      `${file}: estimate=$${estimateUsdTotal.toFixed(4)} real=$${real.total_cost_usd.toFixed(4)} ` +
        `error=${(signedError * 100).toFixed(1)}%${outOfBand ? "  OUT OF BAND [-12%, +5%]" : ""}`,
    );
  }

  process.exit(anyOutOfBand ? 1 : 0);
}

await main();
