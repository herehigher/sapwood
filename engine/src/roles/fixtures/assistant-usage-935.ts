// #935 AC3 replay fixture. No real dogfood transcript is available to redact here — the
// lane-920/lane-933 jsonl the issue cites live under this repo's `data/` dir, which is
// gitignored and local to the machine that ran that dogfood round, never committed. Absent that,
// this fixture is INVENTED, but built to close the two concrete defects a prior review round
// (PR #939, engine-agent finding [0] ac3-synthetic-replay) found in the first version:
//
//  1. Realistic block multiplicities, not a uniform 4-lines-per-message shape. 13 distinct
//     `message.id`s: 5 emitted as a single `assistant` line, 8 emitted as two lines (a
//     text/tool_use pair) — 21 lines total, 8 ids with >1 line — giving a naive/de-duplicated
//     cost ratio of ~1.70 (see below), the same order of magnitude as the +50-65% skew profile
//     in the issue's own table, not the flagged version's uniform 4x (+300%).
//  2. TERMINAL_COST_USD is a bare literal, not computed from MESSAGES by the same pricing
//     arithmetic the AC3 test exercises — that circularity (self-derived ±5% check) was the
//     first version's other defect. It's set ~0.5% above this fixture's own de-duplicated total
//     (computed offline, see the trailer below), modeling the same small residual gap the
//     issue's own lane-920 data shows between a de-duplicated estimate and the real terminal
//     `total_cost_usd` (the untracked 1-hour cache-write premium, out of scope for #935).
//
// Sonnet rates used to size MESSAGES: input $3/M, output $15/M (engine/pricing.yaml). No cache
// tokens, keeping the arithmetic exact and this fixture's own worked numbers checkable by hand.

interface FixtureMessage {
  id: string;
  /** How many `assistant` lines (content blocks) this ONE message is split across in the stream —
   *  all of them carry the identical `usage` snapshot below. */
  lines: number;
  inputTokens: number;
  outputTokens: number;
}

const MODEL = "claude-sonnet-4-6";

const MESSAGES: FixtureMessage[] = [
  { id: "msg_935_1", lines: 1, inputTokens: 5000, outputTokens: 600 },
  { id: "msg_935_2", lines: 1, inputTokens: 3000, outputTokens: 400 },
  { id: "msg_935_3", lines: 1, inputTokens: 7000, outputTokens: 900 },
  { id: "msg_935_4", lines: 1, inputTokens: 2000, outputTokens: 250 },
  { id: "msg_935_5", lines: 1, inputTokens: 4000, outputTokens: 500 },
  { id: "msg_935_6", lines: 2, inputTokens: 6000, outputTokens: 800 },
  { id: "msg_935_7", lines: 2, inputTokens: 4500, outputTokens: 600 },
  { id: "msg_935_8", lines: 2, inputTokens: 8000, outputTokens: 1000 },
  { id: "msg_935_9", lines: 2, inputTokens: 3500, outputTokens: 450 },
  { id: "msg_935_10", lines: 2, inputTokens: 9000, outputTokens: 1100 },
  { id: "msg_935_11", lines: 2, inputTokens: 5000, outputTokens: 650 },
  { id: "msg_935_12", lines: 2, inputTokens: 7000, outputTokens: 900 },
  { id: "msg_935_13", lines: 2, inputTokens: 6500, outputTokens: 850 },
];

const CONTENT_BLOCKS = [{ type: "text" }, { type: "tool_use" }];

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
        cache_read_input_tokens: 0,
      },
      content: [content],
    },
  });
}

// This fixture's own de-duplicated total, worked by hand offline (13 messages, sonnet rates
// above): $0.3465. TERMINAL_COST_USD below is a fixed literal ~0.5% above that, NOT a formula
// over MESSAGES — see the file header for why (the circularity the prior review flagged).
export const ASSISTANT_USAGE_935_TERMINAL_COST_USD = 0.3482;

export const ASSISTANT_USAGE_935_JSONL = [
  `{"type":"system","subtype":"init"}`,
  ...MESSAGES.flatMap((msg) => CONTENT_BLOCKS.slice(0, msg.lines).map((block) => assistantLine(msg, block))),
  JSON.stringify({ type: "result", subtype: "success", total_cost_usd: ASSISTANT_USAGE_935_TERMINAL_COST_USD, model: MODEL }),
].join("\n");
