// pricing.ts — loads the ESTIMATE-only per-model rate table (#33) from a user-editable YAML
// file, and prices token usage against it. Used ONLY to estimate a worker's in-flight spend
// for the SOFT per-worker budget (worker.budgetUsdSoft) — never for the engine's HARD cost
// ceiling, which is billed off the REAL `total_cost_usd` the Claude CLI reports in its
// terminal stream-json result line (parseCostUsd / state.recordSpend).
//
// Rates live in a YAML file, not in source (PR #85 human review: users won't edit source
// code): the engine ships a commented default at `engine/pricing.yaml` (same shipped-preset
// pattern as `prompts/worker.md`, #74), overridable via `worker.pricingFile` in
// sapwood.config.yaml (relative paths resolve against the CONFIG FILE's directory — see
// config.ts's loadConfig, same rule as promptFile). The estimate-vs-real divergence caveats
// (hand-maintained snapshot, cache-TTL assumption, no discount modeling, per-message sum vs
// server-billed-once) are documented in that YAML's own header, next to the numbers they
// describe; worker.ts's writeTerminalSentinel logs (estimate - real) every time a lane
// finishes so the drift is visible, not silent.
//
// FAIL-CLOSED (#74 precedent): a configured pricingFile that's missing/unreadable/malformed
// throws, NAMING THE PATH — never a silent fallback to the shipped default. Loaded ONCE at
// WorkerSupervisor construction (and by `sapwood validate`), never per tick.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { SapwoodConfig } from "./config.js";
import type { ModelUsageEntry } from "./state.js";

const Rate = z.object({
  /** USD per million input tokens. */
  input: z.number().finite().positive(),
  /** USD per million output tokens. */
  output: z.number().finite().positive(),
  /** 5-minute ephemeral cache write premium (~1.25x input — see pricing.yaml's header). */
  cacheWrite: z.number().finite().positive(),
  /** Cache READS must be priced at this rate, not `input` — pricing a cache-heavy run at the
   *  input rate is the exact over-trigger failure mode #33 exists to prevent: a worker mostly
   *  re-reading a large cached prefix would look artificially expensive and hand off
   *  prematurely, even though a cache read costs roughly a tenth of a fresh input token. */
  cacheRead: z.number().finite().positive(),
}).strict();

/** File shape: `models: {<alias>: {input, output, cacheWrite, cacheRead}}`. Unknown model
 *  ALIASES are allowed (users add their own); unknown FIELDS inside a rate are rejected
 *  (.strict() — a typo'd rate key must not be silently dropped, same stance as config.ts). */
const PricingFile = z.object({
  models: z
    .record(z.string().min(1), Rate)
    .refine((m) => Object.keys(m).length > 0, { message: "models must not be empty" }),
}).strict();

export type ModelRateUsdPerMTok = z.infer<typeof Rate>;
/** Alias -> rate, as loaded from pricing.yaml. Guaranteed non-empty by the schema. */
export type PricingTable = Readonly<Record<string, ModelRateUsdPerMTok>>;

/** Resolves the shipped default rate table — `engine/pricing.yaml` inside the engine package,
 *  NOT relative to the target repo the engine is orchestrating (same resolution rule as
 *  worker.ts's defaultPromptPath: src/ and dist/ are both one level below engine/, and the
 *  file living INSIDE the engine package means `npm pack` ships it). */
export function defaultPricingPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "pricing.yaml");
}

/** Load + validate the rate table, ONCE (at supervisor construction / `sapwood validate`,
 *  never per tick). Either the operator's `worker.pricingFile` (loadConfig has already
 *  resolved a relative path against the CONFIG FILE's directory) or, when unset, the shipped
 *  default. FAIL-CLOSED: a configured file that's missing/unreadable/malformed throws naming
 *  the path — never a silent fallback to the shipped default (#74 precedent). */
export function loadPricingTable(cfg: SapwoodConfig): PricingTable {
  const configured = cfg.worker.pricingFile;
  const file = configured ?? defaultPricingPath();
  if (configured !== undefined && !existsSync(configured)) {
    throw new Error(`worker.pricingFile not found: ${configured} — refusing to run with no model rates`);
  }
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (e) {
    throw new Error(`pricing file unreadable: ${file} (${String(e)}) — refusing to run with no model rates`);
  }
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (e) {
    throw new Error(`pricing file is not valid YAML: ${file} (${String(e)})`);
  }
  const result = PricingFile.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    throw new Error(`pricing file invalid: ${file} — ${issues}`);
  }
  return result.data.models;
}

/** Case-insensitive alias match: exact, or the alias as a SUBSTRING of the model id (so the
 *  table's "opus" row prices "claude-opus-4-8"). A model that matches nothing is priced at
 *  the MOST EXPENSIVE tier in the loaded table — over-estimating only ever costs an
 *  earlier-than-ideal graceful handoff; under-estimating a budget check is the actually
 *  dangerous direction (a soft budget that never fires). */
export function resolveRate(model: string, table: PricingTable): ModelRateUsdPerMTok {
  const m = model.toLowerCase();
  for (const [alias, rate] of Object.entries(table)) {
    const a = alias.toLowerCase();
    if (m === a || m.includes(a)) return rate;
  }
  return mostExpensiveRate(table);
}

/** "Most expensive" = highest input rate, tie-broken by output rate — the conservative
 *  unknown-model fallback tier of whatever table is LOADED (not a hardcoded alias). */
function mostExpensiveRate(table: PricingTable): ModelRateUsdPerMTok {
  let best: ModelRateUsdPerMTok | undefined;
  for (const rate of Object.values(table)) {
    if (!best || rate.input > best.input || (rate.input === best.input && rate.output > best.output)) {
      best = rate;
    }
  }
  return best!; // PricingFile guarantees a non-empty table
}

/** Estimated USD for one usage delta (one streamed assistant message's `usage` block, or any
 *  other ModelUsageEntry). Cache-creation tokens are priced at the cache-write rate; cache-read
 *  tokens at the (much cheaper) cache-read rate — see Rate.cacheRead. */
export function estimateUsd(entry: ModelUsageEntry, table: PricingTable): number {
  const rate = resolveRate(entry.model, table);
  return (
    (entry.inputTokens / 1_000_000) * rate.input +
    (entry.outputTokens / 1_000_000) * rate.output +
    (entry.cacheCreationTokens / 1_000_000) * rate.cacheWrite +
    (entry.cacheReadTokens / 1_000_000) * rate.cacheRead
  );
}
