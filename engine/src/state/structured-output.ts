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
// Parsing is TOLERANT of everything BEFORE the block (a session's preamble/reasoning before its
// actual final answer — the same "the transcript may contain noise before the real answer"
// stance worker.ts's parseCostUsd/parseResultText already take) but FAIL-CLOSED on the block's
// own shape: a start sentinel with no matching end sentinel (a truncated stream, a session that
// ran out of turns mid-emit, a context-window cutoff) is treated as "no block found" — this
// module NEVER returns a partial/best-guess slice.
//
// #234 (adjudicated 2026-07-17, supersedes #217's two-pass needsDetails protocol): abstention as
// a FIRST-CLASS, COMPLETE deliverable — "a mediation system that denies an information request
// and still demands a definitive judgment is a shackle; explicit denial with first-class
// abstention is a guardrail" (the adjudication's shackle criterion). UnresolvedContextSchema is
// the shared shape any per-role metadata schema composes (typically via a zod discriminated
// union alongside that role's own decision variants) so a session that genuinely cannot reach a
// decision from what the forge MCP proxy delivered — budget exhausted mid-session, a needed fact
// simply isn't retrievable within the tool algebra's bounds — can say so directly, with a reason,
// rather than being forced to manufacture a confident-sounding decision it doesn't have grounds
// for. Deliberately lives here (not on any one role's own schema file) because it's a reusable
// building block, not a role-specific shape — same rationale ArchitectContradictionSchema etc.
// stay LOCAL to architect.ts (role-specific) while this one is shared. No consumer composes it
// into a live per-role schema in this PR (#234's scope ruling: proxy-consumer wiring is later,
// separately-flagged work) — this is the primitive that PR wires in.
import { z } from "zod";

export const UnresolvedContextSchema = z
  .object({
    unresolvedContext: z
      .object({
        /** Why the session could not reach a decision — required, non-empty: an abstention with
         *  no reason is exactly as unaccountable as a decision with no rationale, and this
         *  schema exists specifically to avoid the alternative (a manufactured decision) without
         *  trading it for an equally silent abstention. */
        reason: z.string().min(1),
      })
      .strict(),
  })
  .strict();

export type UnresolvedContext = z.infer<typeof UnresolvedContextSchema>;

/** True when `metadata` (already-JSON.parsed metadata from a StructuredBlock) validates as a
 *  complete `unresolvedContext` deliverable. Never throws — a caller composes this as one arm of
 *  its own outcome handling (parse the role's own decision schema first; on failure, fall back to
 *  this check before treating the output as genuinely malformed). */
export function isUnresolvedContext(metadata: unknown): metadata is UnresolvedContext {
  return UnresolvedContextSchema.safeParse(metadata).success;
}

// #310: PO decompose is intentionally one two-arm result, not a staged state machine. Long
// child bodies remain in the raw BODY segment; this metadata only carries bounded identities,
// ordering, remainder honesty, and the set-level coverage declaration.
export const DecomposeChildMetadataSchema = z
  .object({
    title: z.string().min(1),
    kind: z.enum(["ready", "remainder"]),
    blockedBy: z.array(z.number().int().nonnegative()).default([]),
    unresolvedContext: UnresolvedContextSchema.shape.unresolvedContext.optional(),
    informationNeeded: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((child, ctx) => {
    const hasRemainderFields = child.unresolvedContext !== undefined && child.informationNeeded !== undefined;
    if (child.kind === "remainder" && !hasRemainderFields) {
      ctx.addIssue({
        code: "custom",
        message: "remainder children require unresolvedContext and informationNeeded",
      });
    }
    if (child.kind === "ready" && (child.unresolvedContext !== undefined || child.informationNeeded !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "ready children must not carry remainder-only unresolved fields",
      });
    }
  });

const CoverageMappingSchema = z
  .object({
    parentIntent: z.string().min(1),
    children: z.array(z.number().int().nonnegative()).min(1),
  })
  .strict();

export const DecomposeOutputMetadataSchema = z.discriminatedUnion("outcome", [
  z
    .object({
      outcome: z.literal("decomposed"),
      children: z.array(DecomposeChildMetadataSchema).min(1),
      coverage: z
        .object({
          mappings: z.array(CoverageMappingSchema).min(1),
          remainders: z.array(z.number().int().nonnegative()),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      outcome: z.literal("unresolved"),
      reason: z.string().min(1),
      unresolvedContext: UnresolvedContextSchema.shape.unresolvedContext,
    })
    .strict(),
]);

export type DecomposeOutputMetadata = z.infer<typeof DecomposeOutputMetadataSchema>;

// SENTINEL CONTAINMENT (dual-review round 1, P1 — fable + Codex): the BODY segment's raw-text
// nature means a body whose markdown content itself contains a sentinel string (realistic —
// issue #110's own body documents these very sentinels) would otherwise be SILENTLY TRUNCATED
// at the embedded sentinel, and the truncated slice could still schema-validate and be applied
// via updateIssueBody. Two rules close this, both fail-closed:
//   1. TRAILING-WHITESPACE RULE: after the block's final consumed sentinel (END_BODY when a
//      BODY segment is present, END_SAPWOOD_RESULT when not), only whitespace may remain —
//      anything else returns null. This enforces the contract every role prompt already states
//      ("Nothing may follow the last sentinel") and mechanically catches embedded-END_BODY
//      truncation: the real body text continuing past the matched sentinel IS the trailing
//      non-whitespace. The same strictness applies BETWEEN the two segments (the prompts show
//      BODY immediately following the metadata block): prose between END_SAPWOOD_RESULT and
//      <<<BODY>>> would otherwise let a metadata-only decision silently adopt a body the
//      session merely QUOTED after its block.
//   2. NO-EMBEDDED-SENTINELS RULE (belt-and-suspenders): a sliced body containing ANY of the
//      four sentinel strings returns null — ambiguous by construction.
// Escaping machinery (a quoting convention sessions would have to apply and this parser
// unapply) was considered and REJECTED: a session that legitimately needs to write the sentinel
// strings into an issue body is a rare edge, and this repo's degrade-to-human policy says rare
// edges get needs-human + preserved evidence, never more machinery — the parse failure feeds
// the caller's isValid hook, which retries once and then escalates. That escalation is the
// intended rare-edge outcome, not a bug.

/** Marks the start/end of the JSON metadata segment. */
export const RESULT_BLOCK_START = "<<<SAPWOOD_RESULT>>>";
export const RESULT_BLOCK_END = "<<<END_SAPWOOD_RESULT>>>";
/** Marks the start/end of the optional raw-markdown body segment. */
export const BODY_BLOCK_START = "<<<BODY>>>";
export const BODY_BLOCK_END = "<<<END_BODY>>>";

const ALL_SENTINELS = [RESULT_BLOCK_START, RESULT_BLOCK_END, BODY_BLOCK_START, BODY_BLOCK_END];

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
 *  found at all; when a start sentinel is found with no matching end sentinel anywhere after it
 *  (truncated); when anything but whitespace follows the block's final sentinel or sits between
 *  its two segments; or when a sliced body contains any sentinel string — the module doc's
 *  fail-closed containment rules: a caller must never be handed a partial, truncated, or
 *  ambiguous slice to "do its best" with.
 *
 *  Uses the LAST occurrence of RESULT_BLOCK_START: tolerant of a session quoting or explaining
 *  the block format somewhere in its own reasoning BEFORE the real, final block (mirrors
 *  parseResultText/parseCostUsd's own last-line-wins stance for the analogous problem). Nothing
 *  after the block gets that tolerance — the trailing-whitespace rule above. */
export function parseStructuredBlock(text: string): StructuredBlock | null {
  const startIdx = text.lastIndexOf(RESULT_BLOCK_START);
  if (startIdx === -1) return null;
  const metadataStart = startIdx + RESULT_BLOCK_START.length;
  const metadataEnd = text.indexOf(RESULT_BLOCK_END, metadataStart);
  if (metadataEnd === -1) return null; // truncated RESULT block — never trust a partial slice
  const metadataRaw = text.slice(metadataStart, metadataEnd).trim();
  const afterMetadata = metadataEnd + RESULT_BLOCK_END.length;

  const bodyStart = text.indexOf(BODY_BLOCK_START, afterMetadata);
  if (bodyStart === -1) {
    // No BODY segment: END_SAPWOOD_RESULT is the block's final sentinel — trailing rule 1.
    if (text.slice(afterMetadata).trim() !== "") return null;
    return { metadataRaw };
  }
  // A BODY segment follows — it must follow IMMEDIATELY (whitespace only between the segments),
  // or it is something the session wrote AFTER its block, not part of it (rule 1, module doc).
  if (text.slice(afterMetadata, bodyStart).trim() !== "") return null;
  const bodyContentStart = bodyStart + BODY_BLOCK_START.length;
  const bodyEnd = text.indexOf(BODY_BLOCK_END, bodyContentStart);
  if (bodyEnd === -1) return null; // truncated BODY block — fail closed on the WHOLE block
  // Trailing rule 1 at the block's actual final sentinel. This is the silent-truncation P1's
  // mainline defense: real body text continuing past an EMBEDDED <<<END_BODY>>> lands here as
  // trailing non-whitespace, so the truncated slice is rejected instead of returned.
  if (text.slice(bodyEnd + BODY_BLOCK_END.length).trim() !== "") return null;

  const rawBody = text.slice(bodyContentStart, bodyEnd);
  // Rule 2 (belt-and-suspenders): a body carrying any sentinel string is ambiguous — null.
  if (ALL_SENTINELS.some((s) => rawBody.includes(s))) return null;
  const body = rawBody.replace(/^\n/, "").replace(/\n$/, "");
  return { metadataRaw, body };
}
