// #935 AC3 replay fixture — a redacted stream-json excerpt shaped like the lane-920 dogfood
// profile the issue's table cites (de-duplicated $12.80 vs real $12.86, <1% gap), scaled down
// and with invented token counts so the numbers are exact/checkable rather than a large captured
// transcript. Five distinct `message.id` values, each emitted as four `assistant` lines (the
// real CLI's one-line-per-content-block shape: thinking/text/tool_use/tool_use), all carrying
// the message's identical `usage` snapshot — 20 assistant lines total, 5 ids with >1 line each.
// No cache-WRITE tokens, so the 1-hour cache-write premium the pricing table doesn't model (out
// of scope for #935) stays at zero rather than distorting the gap this fixture pins.

interface FixtureMessage {
  id: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
}

const MODEL = "claude-sonnet-4-6";

const MESSAGES: FixtureMessage[] = [
  { id: "msg_935_1", inputTokens: 8000, outputTokens: 1200, cacheReadTokens: 20000 },
  { id: "msg_935_2", inputTokens: 6000, outputTokens: 900, cacheReadTokens: 15000 },
  { id: "msg_935_3", inputTokens: 10000, outputTokens: 1500, cacheReadTokens: 25000 },
  { id: "msg_935_4", inputTokens: 7000, outputTokens: 1000, cacheReadTokens: 18000 },
  { id: "msg_935_5", inputTokens: 9000, outputTokens: 1300, cacheReadTokens: 22000 },
];

const CONTENT_BLOCKS = [{ type: "thinking" }, { type: "text" }, { type: "tool_use" }, { type: "tool_use" }];

function assistantLine(msg: FixtureMessage, content: unknown): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      id: msg.id,
      model: MODEL,
      usage: {
        input_tokens: msg.inputTokens,
        output_tokens: msg.outputTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: msg.cacheReadTokens,
      },
      content: [content],
    },
  });
}

// Sonnet rates from the shipped engine/pricing.yaml (input $3/M, output $15/M, cacheRead $0.3/M) —
// duplicated here as plain arithmetic, not imported, so this fixture's own pinned terminal cost
// doesn't silently drift if the shipped table ever changes; the AC3 test computes the DEDUPED
// estimate through the real pricing pipeline and compares it against this pinned value.
const TERMINAL_COST_USD = MESSAGES.reduce(
  (sum, m) => sum + (m.inputTokens / 1_000_000) * 3 + (m.outputTokens / 1_000_000) * 15 + (m.cacheReadTokens / 1_000_000) * 0.3,
  0,
);

export const ASSISTANT_USAGE_935_JSONL = [
  `{"type":"system","subtype":"init"}`,
  ...MESSAGES.flatMap((msg) => CONTENT_BLOCKS.map((block) => assistantLine(msg, block))),
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: TERMINAL_COST_USD, model: MODEL }),
].join("\n");

export const ASSISTANT_USAGE_935_TERMINAL_COST_USD = TERMINAL_COST_USD;
