// pricing.ts — a small, ESTIMATE-only per-model token rate table (#33). Used ONLY to estimate
// a worker's in-flight spend for the SOFT per-worker budget (worker.budgetUsdSoft) — never for
// the engine's HARD cost ceiling, which is billed off the REAL `total_cost_usd` the Claude CLI
// reports in its terminal stream-json result line (parseCostUsd / state.recordSpend). This
// table exists because stream-json carries no in-progress cost figure at all — only per-message
// token counts — so a live soft-budget check has nothing else to price against.
//
// KNOWN ESTIMATE-VS-REAL DIVERGENCE (documented, not a bug — read before "fixing" a mismatch):
//  - Rates below are a hand-maintained snapshot, not looked up live. They WILL drift the moment
//    Anthropic reprices a model, or `worker.model`/`--fallback-model` point at an alias this
//    table doesn't recognize (falls back to the most expensive known tier — see
//    UNKNOWN_MODEL_RATE below).
//  - Real billing may apply batch/priority-tier discounts, promotional intro pricing, or
//    per-org negotiated rates this table knows nothing about.
//  - Cache-WRITE pricing depends on the TTL (1.25x for the 5-minute ephemeral cache, 2x for the
//    1-hour cache); this table always assumes the CLI's default 5-minute ephemeral cache.
//  - The estimate accumulates per-message `usage` deltas as they stream in; the real
//    total_cost_usd is billed once, server-side, at the end of the whole session, and can
//    reflect session-level effects (e.g. a resumed session's cumulative total — see
//    State.recordSpend's resume cost-delta handling) this per-message sum doesn't model.
// worker.ts's writeTerminalSentinel reconciles the two every time a lane finishes: it logs
// (estimate - real) so the drift is visible, not silent.
import type { ModelUsageEntry } from "./state.js";

export interface ModelRateUsdPerMTok {
  input: number;
  output: number;
  /** 5-minute ephemeral cache write premium (~1.25x input — see module doc). */
  cacheWrite: number;
  /** Cache READS must be priced at this rate, not `input` — pricing a cache-heavy run at the
   *  input rate is the exact over-trigger failure mode #33 exists to prevent: a worker that's
   *  mostly re-reading a large cached prefix would look artificially expensive and hand off
   *  prematurely, even though a cache read costs roughly a tenth of a fresh input token. */
  cacheRead: number;
}

/** Anthropic list pricing, USD per million tokens (hand-maintained snapshot — see the module
 *  doc for drift caveats). Deliberately small: it covers only the model aliases THIS project's
 *  config and CLI wiring actually use — `worker.model` defaults to "opus" (sapwood.config.yaml)
 *  and worker.ts's claudeArgs() hard-codes `--fallback-model sonnet`. Keyed by the Claude CLI's
 *  short aliases; resolveRate() below also matches a full model id via substring (e.g.
 *  "claude-opus-4-8" resolves to the "opus" row). */
const RATE_TABLE: Record<string, ModelRateUsdPerMTok> = {
  opus: { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  sonnet: { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  haiku: { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
};

/** Fallback for a model id/alias this table doesn't recognize: price it at the most expensive
 *  known tier, so an unrecognized model estimates HIGH rather than low. Over-estimating only
 *  ever costs an earlier-than-ideal graceful handoff; under-estimating a budget check is the
 *  actually dangerous direction (a soft budget that never fires). */
const UNKNOWN_MODEL_RATE: ModelRateUsdPerMTok = RATE_TABLE.opus!;

export function resolveRate(model: string): ModelRateUsdPerMTok {
  const m = model.toLowerCase();
  for (const [alias, rate] of Object.entries(RATE_TABLE)) {
    if (m === alias || m.includes(alias)) return rate;
  }
  return UNKNOWN_MODEL_RATE;
}

/** Estimated USD for one usage delta (one streamed assistant message's `usage` block, or any
 *  other ModelUsageEntry). Cache-creation tokens are priced at the cache-write rate; cache-read
 *  tokens at the (much cheaper) cache-read rate — see ModelRateUsdPerMTok.cacheRead. */
export function estimateUsd(entry: ModelUsageEntry): number {
  const rate = resolveRate(entry.model);
  return (
    (entry.inputTokens / 1_000_000) * rate.input +
    (entry.outputTokens / 1_000_000) * rate.output +
    (entry.cacheCreationTokens / 1_000_000) * rate.cacheWrite +
    (entry.cacheReadTokens / 1_000_000) * rate.cacheRead
  );
}
