// structured-output.ts — #110's shared parsing primitive for a peripheral role session's final
// STRUCTURED OUTPUT (PR1 of the #110 sequence: gate⓪'s plan-reviewer/plan-drafter are the first
// consumers; PR2-4 add their own per-role zod schemas around the SAME sentinel-delimited shape
// this module parses, rather than each role reinventing the block format).
//
// Design (issue #110's Design section, authoritative): a role session's final message ends in
// ONE structured block — a JSON metadata segment (decision enum, issue number, and other small
// closed-form fields; NEVER markdown/free text) plus an OPTIONAL raw-text BODY segment carrying
// whatever long markdown the decision produced (a revised issue body, a reviewer's bounce brief,
// a human-facing explanation). The two travel in SEPARATE sentinel-delimited segments
// specifically so a markdown body's own code fences, nested backticks, or embedded quotes never
// have to survive JSON-string escaping — encoding a markdown body as a JSON string value was
// considered and rejected: a body containing a fenced code block (routine in this codebase's own
// issue bodies) would either break the escaping or force the session to get escaping exactly
// right under no supervision, an unforced failure mode structured output exists to avoid.
//
// Parsing is TOLERANT of everything AROUND the block (a session's preamble/reasoning before its
// actual final answer — the same "the transcript may contain noise before the real answer"
// stance worker.ts's parseCostUsd/parseResultText already take) but FAIL-CLOSED on the block's
// own shape: a start sentinel with no matching end sentinel (a truncated stream, a session that
// ran out of turns mid-emit, a context-window cutoff) is treated as "no block found" — this
// module NEVER returns a partial/best-guess slice. The metadata segment's JSON validity and
// shape (a per-role zod schema) are the CALLER's job; this module only locates and slices the
// two segments verbatim.

/** Marks the start/end of the JSON metadata segment. */
export const RESULT_BLOCK_START = "<<<SAPWOOD_RESULT>>>";
export const RESULT_BLOCK_END = "<<<END_SAPWOOD_RESULT>>>";
/** Marks the start/end of the optional raw-markdown body segment. */
export const BODY_BLOCK_START = "<<<BODY>>>";
export const BODY_BLOCK_END = "<<<END_BODY>>>";

export interface StructuredBlock {
  /** Raw text between the RESULT sentinels, un-parsed — the caller's zod schema owns validating
   *  this as JSON (this module only slices it out; JSON.parse is deliberately NOT called here so
   *  every schema-validation error a caller reports is theirs, not something this shared parser
   *  half-owns). */
  metadataRaw: string;
  /** Raw text between the BODY sentinels, with exactly one leading and one trailing newline (the
   *  sentinel-on-its-own-line convention every role prompt uses) stripped — everything else,
   *  including nested code fences, blank lines, and indentation, verbatim. undefined when no
   *  BODY block follows the metadata block (some decisions — e.g. gate⓪'s plain "approve" with
   *  no body revision — legitimately have nothing to carry here). */
  body?: string;
}

/** Locate and slice a session's final-message structured block. Returns null when no block is
 *  found at all, OR when a start sentinel is found with no matching end sentinel anywhere after
 *  it (truncated — see the module doc's fail-closed stance: a caller must never be handed a
 *  partial JSON/body slice to "do its best" with).
 *
 *  Uses the LAST occurrence of RESULT_BLOCK_START: tolerant of a session quoting or explaining
 *  the block format somewhere in its own reasoning before the real, final block (mirrors
 *  parseResultText/parseCostUsd's own last-line-wins stance for the analogous problem). Once the
 *  metadata segment is located, the BODY search starts strictly AFTER it, so a body belonging to
 *  an earlier, superseded block can never be mistaken for the final one's. */
export function parseStructuredBlock(text: string): StructuredBlock | null {
  const startIdx = text.lastIndexOf(RESULT_BLOCK_START);
  if (startIdx === -1) return null;
  const metadataStart = startIdx + RESULT_BLOCK_START.length;
  const metadataEnd = text.indexOf(RESULT_BLOCK_END, metadataStart);
  if (metadataEnd === -1) return null; // truncated RESULT block — never trust a partial slice
  const metadataRaw = text.slice(metadataStart, metadataEnd).trim();
  const afterMetadata = metadataEnd + RESULT_BLOCK_END.length;

  const bodyStart = text.indexOf(BODY_BLOCK_START, afterMetadata);
  if (bodyStart === -1) return { metadataRaw }; // no BODY block — valid for some decisions
  const bodyContentStart = bodyStart + BODY_BLOCK_START.length;
  const bodyEnd = text.indexOf(BODY_BLOCK_END, bodyContentStart);
  if (bodyEnd === -1) return null; // truncated BODY block — fail closed on the WHOLE block

  const rawBody = text.slice(bodyContentStart, bodyEnd);
  const body = rawBody.replace(/^\n/, "").replace(/\n$/, "");
  return { metadataRaw, body };
}
