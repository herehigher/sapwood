// comment-cursor.ts (#652) — pure computation for the comment-adjudication cursor.
//
// Batch-8 incident (2026-08-04, PR #651 round 1): a binding owner ruling recorded as an ISSUE
// COMMENT was invisible to the worker, which reads only the issue BODY ({{issue.body}},
// worker.ts) — that boundary is correct (the body is maintainer-writable; comments become
// world-writable once the repo is public), but nothing checked the body was CURRENT relative to
// its comment thread before the engine spent on gate⓪ review or dispatch. This module is that
// check, expressed as a pure function of (body, comment stream) — no forge/state I/O of its own,
// same pure/impure split as ac-snapshot.ts (the sibling "existing body drift" mechanism this
// extends: see docs/security/adjudication.md's "AC-authority dispatch snapshot" section).
//
// MARKER: `<!-- sapwood:comments-adjudicated-through: <comment-id> -->` in the issue body.
// Semantics: "a maintainer has adjudicated every comment at or before this one" (adjudicated =
// folded into the body OR reviewed-and-nothing-to-fold). Cursor `0` denotes the position BEFORE
// the first comment (nothing adjudicated yet).
//
// ORDERING: stream-position (array index in GitHub's oldest-first issue-comment stream), never
// numeric comment-id comparison — the marker identifies a CONCRETE comment; everything after it
// in the fetched stream is pending, regardless of id spacing/gaps.
//
// FAIL-CLOSED ARMS (design adjudicated 2026-08-05; revised #703 v2, 2026-08-06): a malformed
// marker, a duplicate marker, or a cursor whose target no longer exists in the stream all fail
// closed — `ok: false`. A missing marker with pending non-engine comments ALSO fails closed (the
// exact batch-8 shape: an issue that predates this feature, or that a maintainer forgot to stamp,
// must not silently pass). A missing marker with ZERO comments is the one pass-through case
// (AC8's reverse test: behavior-identical to today — no new writes, labels, or outcome changes;
// the checkpoints that consume this module's result DO add comment/actor reads, see
// docs/security.md).
//
// #703 v2 (POSITION SEMANTICS, supersedes the pre-v2 engine-comment rejection): a cursor pointing
// at an ENGINE comment is now a VALID position, exactly like one pointing at a non-engine
// comment — see `computeCommentCursor`'s own doc at its former rejection site for the full
// design diagnosis. This relaxation ships ONLY together with structural role-marker immutability
// (`applyRoleBodyRewrite` and its call sites in plan-review.ts/align.ts/issue-creation.ts) —
// relaxing the validator alone, before the writers are fixed, would let a role silently
// "self-adjudicate" past real human comments by choosing an engine id that happens to sit after
// them; with immutability shipped first (in the same PR/commit), no role can ever choose ANY
// marker value at all, so this relaxation only ever affects a HUMAN's own deliberate choice.
//
// #652 round 1 (finding 4): marker recognition is STANDALONE-LINE anchored — a marker counts
// only when it is the ENTIRE trimmed line, and never inside a fenced (``` / ~~~) code block. A
// quoted/inline-code example (e.g. an issue body that shows the marker syntax to a maintainer,
// or a review comment quoting a PAST marker) must never parse as authoritative — see
// `findStandaloneMarkerValues` below and docs/security/adjudication.md's "standalone-line" convention.
import { createHash } from "node:crypto";

/** A marker candidate is recognized only when, after trimming, it is the ENTIRE line — prose or
 *  inline-code backticks anywhere on the same line (`` `<!-- sapwood:... -->` `` or "see `<!--
 *  ... -->` above") fail this anchor by construction, no separate inline-code detection needed.
 *
 *  #703 v2 gate② (P2-1): the captured group is DELIBERATELY unconstrained (`.*`, matching a
 *  BLANK value, a multi-token value, or anything else) — this is an ATTEMPT recognizer, not a
 *  valid-value parser. A marker whose payload doesn't validate (not `"0"`, not a bare digit
 *  string) is still recognized as a marker LINE, its captured (trimmed) text simply failing
 *  `computeCommentCursor`'s existing malformed-marker check downstream — exactly like a
 *  single-token gibberish value already did. Before this widening, a BLANK
 *  (`<!-- sapwood:comments-adjudicated-through: -->`) or multi-token (two ids separated by
 *  whitespace) attempt matched NOTHING at all (the old `\s*(\S+?)\s*` required ≥1 non-whitespace
 *  run with nothing else between the colon and `-->`), so the whole line was invisible to every
 *  consumer of this scan: `computeCommentCursor` read it as "no marker" (silently DROPPING a
 *  malformed human attempt instead of failing closed on it), `applyRoleBodyRewrite` could not
 *  preserve it as the current body's marker (silently discarding/"repairing" a broken human
 *  marker by treating the body as markerless), and a ROLE's OWN malformed attempt survived
 *  un-stripped into a rewritten body (issue-creation.ts left it sitting there, looking
 *  authoritative to a casual reader even though nothing ever recognized it as one). Widening
 *  attempt-recognition while leaving valid-VALUE parsing exactly as strict as before closes all
 *  three: a malformed CURRENT attempt now correctly fails closed (`malformed-marker`, refusing
 *  the role write via `checkMarkerWritePrecondition`/gate⓪'s existing checkpoint) instead of
 *  reading as absent, and a role-authored attempt — valid-shaped or not — is always stripped by
 *  `stripStandaloneMarkerLines`, since it is now always RECOGNIZED as an attempt in the first
 *  place. */
const MARKER_LINE_RE = /^<!--\s*sapwood:comments-adjudicated-through:(.*)-->$/;
/** Matches a fence-opening/closing run — 3+ backticks OR 3+ tildes, GFM's two fence characters —
 *  at the start of a (already-trimmed) line. Group 1 is the exact run, so the caller can read off
 *  BOTH which character it is and how long it is (#652 round 2, finding 3 — see
 *  `findStandaloneMarkerValues` below for why both matter). */
const FENCE_RE = /^(`{3,}|~{3,})/;

/** Scan `body` for standalone adjudication-cursor marker lines, in document order, skipping any
 *  that fall inside a fenced code block. Returns the raw marker VALUE text for every standalone
 *  match (never the surrounding markup) — `computeCommentCursor` below decides what an empty,
 *  single, or multi-element result means.
 *
 *  #652 round 2 (finding 3): fence tracking is DELIMITER-AWARE, per CommonMark's own fenced-code
 *  rule — an open fence records its character (`` ` `` or `~`) and run length; a line only CLOSES
 *  it when it is the SAME character, with a run at least as long as the opener's. Before this, any
 *  fence-looking line (either character, any length >= 3) toggled a single boolean, so a `~~~`
 *  line appearing INSIDE a ``` ` ``` fence (e.g. a code sample that itself talks about tilde
 *  fences) incorrectly closed it — the marker line right after would then read as outside any
 *  fence and become authoritative. A same-fence-type line that's merely too SHORT to close (e.g. a
 *  stray `` `` `` inside a ```` ```` ````-opened fence) is, by the same rule, just fence content
 *  too — never a close, and never a new open either (a fence cannot nest). */
function findStandaloneMarkerValues(body: string): string[] {
  return scanStandaloneMarkerLines(body).map((m) => m.value);
}

/** #703: the SAME fence-aware standalone-marker walk `findStandaloneMarkerValues` used to do
 *  inline, factored out so it can hand back the RAW (untrimmed, byte-for-byte) line text and its
 *  0-indexed line position too — `findStandaloneMarkerValues` above (computeCommentCursor's own
 *  read path) still only needs the parsed VALUE, but #703's writer-side helpers below
 *  (`findStandaloneMarkerLines`, `stripStandaloneMarkerLines`, `applyRoleBodyRewrite`) need the
 *  exact original text and its line so they can preserve/remove whole lines verbatim. One walk,
 *  never two independent copies that could drift apart.
 *
 *  Exported (#752 finding 3, PO adjudication on PR #812): ac-snapshot.ts's AC-authority strip
 *  needs each marker line's PARSED VALUE, not just its raw text (`findStandaloneMarkerLines`
 *  above), to decide which marker lines are well-formed enough to excuse from the AC-authority
 *  hash — see that module's `stripAcAuthorityMarkerLines` for why. Purely additive visibility:
 *  this function's own behavior, and every existing caller in THIS file, is unchanged. */
export function scanStandaloneMarkerLines(body: string): Array<{ lineIndex: number; raw: string; value: string }> {
  const lines = body.split(/\r?\n/);
  const found: Array<{ lineIndex: number; raw: string; value: string }> = [];
  let fence: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    const line = rawLine.trim();
    const fenceMatch = FENCE_RE.exec(line);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      if (fence === null) {
        fence = { char: run[0]!, len: run.length };
      } else if (run[0] === fence.char && run.length >= fence.len && line.length === run.length) {
        // #652 round 3 (finding 1): a CLOSER must be BARE — CommonMark allows an info string on
        // opening fences only, so a matching-character, long-enough run followed by anything but
        // whitespace (` ```not-a-closer `; `line` is already trimmed, so "bare" = run IS the
        // whole line) is fence content, not a close.
        fence = null;
      }
      // else: a fence-looking line of the WRONG character, the right character but too SHORT
      // to close the current opener, or a would-be closer carrying an info string, is just
      // fence CONTENT — falls through to the `if (fence) continue` below like any other line
      // inside the block, never toggles.
      continue;
    }
    if (fence !== null) continue;
    const m = MARKER_LINE_RE.exec(line);
    // #703 v2 gate② (P2-1): MARKER_LINE_RE's capture is now unconstrained (see its own doc) —
    // `.trim()` here is what used to be the regex's own `\s*...\s*` framing, applied AFTER
    // matching instead of as part of the pattern, so a blank/whitespace-only payload correctly
    // normalizes to `""` (fails the downstream numeric-or-"0" check) rather than surviving as
    // literal whitespace.
    if (m) found.push({ lineIndex: i, raw: rawLine, value: m[1]!.trim() });
  }
  return found;
}

/** #703: the RAW (untrimmed, byte-for-byte) text of every standalone adjudication-marker line in
 *  `body`, fence-aware exactly like `findStandaloneMarkerValues`. Used by `applyRoleBodyRewrite`
 *  to carry the CURRENT body's marker over verbatim across a role-produced rewrite. */
export function findStandaloneMarkerLines(body: string): string[] {
  return scanStandaloneMarkerLines(body).map((m) => m.raw);
}

/** #703: `body` with every standalone adjudication-marker line REMOVED (fence-aware, same rule
 *  as above). A role session has no standing to introduce or move the marker — see
 *  `applyRoleBodyRewrite`, the only caller. Not exported: the marker-strip is meaningless on its
 *  own without also restoring the current body's marker (or not), which is that function's job.
 *
 *  ac-snapshot.ts's AC-authority hash does NOT reuse this strip (#752 finding 3, PO adjudication
 *  on PR #812) — it has its own deliberately STRICTER sibling, `stripAcAuthorityMarkerLines`,
 *  which only excuses a marker line whose value is well-formed (`"0"` or a bare digit run,
 *  `/^\d+$/`). The two solve different problems and must diverge: THIS strip's job is role-rewrite
 *  RESTORATION — `applyRoleBodyRewrite` must remove ANY marker-shaped line a role wrote,
 *  valid-shaped or not, because a role has no standing to write one regardless of what its payload
 *  says, and the CURRENT body's own (separately-validated) marker is what gets restored
 *  afterward. `stripAcAuthorityMarkerLines`'s job is AC-authority EXCUSAL from the drift hash — a
 *  security boundary where a malformed/malicious marker-shaped line (e.g. one smuggling extra
 *  payload) must NOT be silently excused, so it stays in the hash and drifts fail-closed instead
 *  of being stripped. `scanStandaloneMarkerLines` above is the ONE shared walk both strips build
 *  on, so "what counts as a marker-shaped LINE" never has two definitions — only "which of those
 *  lines gets excused" differs, by design, between the two callers.
 *
 *  gate② round 2 fix (P1): this function does NOT reuse `scanStandaloneMarkerLines`'s own
 *  `body.split(/\r?\n/)` walk for its OWN reconstruction, and deliberately duplicates a slimmer
 *  scan instead — two changes from the pre-round-2 shape:
 *  (1) Byte-preserving reconstruction. `applyRoleBodyRewrite` verifies operator-fence bytes
 *  against the UNSTRIPPED `roleBody` before this function ever runs; the pre-round-2
 *  implementation then rebuilt the WHOLE body via `body.split(/\r?\n/).filter(...).join("\n")`,
 *  which silently rewrites EVERY internal CRLF to LF — including bytes inside an
 *  already-verified operator fence, invalidating that earlier check's result one step later. This
 *  version reuses `splitOperatorFenceLines`'s raw+term technique (split on `"\n"` only, each kept
 *  line rebuilt with its OWN original terminator) — recognition still trims (a trailing `\r` never
 *  defeats standalone-line recognition), only reconstruction is raw, mirroring the operator-fence
 *  path's own split between the two concerns.
 *  (2) Protected-range awareness. A marker-shaped line sitting INSIDE an operator-owned fence
 *  already present in `body` is operator-owned CONTENT, never a role's own marker attempt, and
 *  must never be stripped — the pre-round-2 walk had no concept of "inside a fence" at all (it
 *  only tracked GFM CODE fences, an unrelated syntax) and would strip such a line regardless of
 *  where it sat. This function's ONLY caller (`applyRoleBodyRewrite`) always invokes it on
 *  `roleBodyFenceStripped` — `stripUnpreservedOperatorFenceTags`'s own output, which by
 *  construction leaves behind ONLY fences already byte-identical to a real current-body fence — so
 *  a fresh `scanOperatorFences(body)` on THIS input's own blocks is sufficient to identify every
 *  protected line range; no separate "is this really the operator's fence" check is needed. */
function stripStandaloneMarkerLines(body: string): string {
  const lines = splitOperatorFenceLines(body);
  const protectedRanges = scanOperatorFences(body).blocks.map((b): [number, number] => [b.openLine, b.closeLine]);
  const isProtected = (lineIndex: number): boolean => protectedRanges.some(([s, e]) => lineIndex >= s && lineIndex <= e);

  const markerLineIndices = new Set<number>();
  let codeFence: { char: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.raw.trim();
    const fenceMatch = FENCE_RE.exec(trimmed);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      if (codeFence === null) {
        codeFence = { char: run[0]!, len: run.length };
      } else if (run[0] === codeFence.char && run.length >= codeFence.len && trimmed.length === run.length) {
        codeFence = null;
      }
      continue;
    }
    if (codeFence !== null) continue;
    if (MARKER_LINE_RE.test(trimmed) && !isProtected(i)) markerLineIndices.add(i);
  }
  if (markerLineIndices.size === 0) return body;
  return lines
    .filter((_, i) => !markerLineIndices.has(i))
    .map((l) => l.raw + l.term)
    .join("");
}

/** #827: the operator-owned section fence — `<!-- sapwood:operator-owned -->` … `<!--
 *  /sapwood:operator-owned -->` — marks a BLOCK of body text (not a single line, unlike the #703
 *  adjudication-cursor marker above) as the PO/human's own testimony: a design ruling, ownership
 *  note, or other operator-authored prose no role may rewrite. Same "operator-owned bytes a role
 *  rewrites must preserve verbatim" family as the #703 marker and #805's finding markers — #827's
 *  own "Why": a gate⓪ drafter refining an issue body (batch-14, 2026-08-11, issue #752) quietly
 *  REWORDED a PO ruling it had no standing to touch, laundering a defective sentence forward under
 *  refined phrasing instead of leaving it verbatim for the audit trail.
 *
 *  Recognized the SAME way as the #703 marker (see `scanStandaloneMarkerLines`'s own doc): an
 *  open/close tag counts only when, after trimming, it is the ENTIRE line, and never inside a
 *  fenced (``` / ~~~) code block — an inline or quoted example of the fence syntax (this doc
 *  comment included) must never register as a real boundary. */
const OPERATOR_FENCE_OPEN = "<!-- sapwood:operator-owned -->";
const OPERATOR_FENCE_CLOSE = "<!-- /sapwood:operator-owned -->";

/** gate② round 1 fix (P1b): the whole fence path below splits ONLY on `"\n"` — never `/\r?\n/` —
 *  and every line record keeps its RAW text (any trailing `\r` still attached) plus its absolute
 *  character `start` offset in `body`. `raw.trim()` (which drops a trailing `\r` along with other
 *  whitespace) is used ONLY to RECOGNIZE a fence-tag/code-fence line; a fenced BLOCK's bytes are
 *  always taken by slicing the ORIGINAL string between two line offsets (`body.slice(...)`), never
 *  by rejoining an array with a literal `"\n"` — the pre-fix bug: `body.split(/\r?\n/)` then
 *  `.join("\n")` silently rewrote every internal CRLF to LF, so a role flipping ONLY the fence's
 *  EOL bytes reproduced byte-for-byte-*looking* text that the (LF-normalized) comparison accepted.
 *  Recognition and comparison are deliberately different operations on the SAME underlying text
 *  now: trim for recognition, raw slice for comparison. */
function splitOperatorFenceLines(body: string): Array<{ raw: string; term: string; start: number }> {
  const result: Array<{ raw: string; term: string; start: number }> = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\n") {
      result.push({ raw: body.slice(start, i), term: "\n", start });
      start = i + 1;
    }
  }
  result.push({ raw: body.slice(start), term: "", start });
  return result;
}

interface OperatorFenceBlock {
  raw: string;
  openLine: number;
  closeLine: number;
}

/** The one walk every operator-fence consumer below builds on — mirrors
 *  `scanStandaloneMarkerLines`'s GFM-code-fence awareness and no-nesting stance (a second open
 *  before the first close is content of the still-open block, never a new boundary), extended with
 *  two things the #703 marker walk never needed: (1) `malformed` — true when the loop ends with an
 *  unmatched opener still pending (gate② round 1 fix, P1a: an unclosed `<!-- sapwood:operator-owned
 *  -->` is now an EXPLICIT, ambiguous result, not silently "no block found here", indistinguishable
 *  from "no fence at all"); (2) each block's `openLine`/`closeLine` (0-indexed line positions, not
 *  just its raw text) — `stripUnpreservedOperatorFenceTags` below needs to know exactly WHICH
 *  lines a matched/preserved block owns, so it never touches a byte inside one while stripping a
 *  role's forged tag lines elsewhere in the same body. */
function scanOperatorFences(body: string): {
  blocks: OperatorFenceBlock[];
  malformed: boolean;
  lines: Array<{ raw: string; term: string; start: number }>;
} {
  const lines = splitOperatorFenceLines(body);
  const blocks: OperatorFenceBlock[] = [];
  let codeFence: { char: string; len: number } | null = null;
  let openLine: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.raw.trim();
    const fenceMatch = FENCE_RE.exec(trimmed);
    if (fenceMatch) {
      const run = fenceMatch[1]!;
      if (codeFence === null) {
        codeFence = { char: run[0]!, len: run.length };
      } else if (run[0] === codeFence.char && run.length >= codeFence.len && trimmed.length === run.length) {
        codeFence = null;
      }
      continue;
    }
    if (codeFence !== null) continue;
    if (openLine === null) {
      if (trimmed === OPERATOR_FENCE_OPEN) openLine = i;
    } else if (trimmed === OPERATOR_FENCE_CLOSE) {
      const openL = lines[openLine]!;
      const closeL = lines[i]!;
      // Raw substring of the ORIGINAL body, open-line start through close-line end — see
      // `splitOperatorFenceLines`'s own doc for why this (never a rejoin) is what makes the
      // comparison CRLF-sensitive.
      blocks.push({ raw: body.slice(openL.start, closeL.start + closeL.raw.length), openLine, closeLine: i });
      openLine = null;
    }
  }
  return { blocks, malformed: openLine !== null, lines };
}

/** gate② round 1 fix (P1a): the explicit malformed/ambiguous result an unmatched opener now
 *  produces, alongside whatever well-formed blocks the same body also carries.
 *  `extractOperatorOwnedFences` below still returns only `blocks` (unchanged shape for its
 *  existing callers/tests) — this is the richer result `applyRoleBodyRewrite` reads `malformed`
 *  off of, refusing the ENTIRE write rather than silently treating a broken CURRENT-body boundary
 *  as "no fence here" (which would leave the operator's testimony unprotected). */
export function operatorFenceScanResult(body: string): { blocks: string[]; malformed: boolean } {
  const scan = scanOperatorFences(body);
  return { blocks: scan.blocks.map((b) => b.raw), malformed: scan.malformed };
}

/** Every operator-owned fenced block in `body`, BYTE-FOR-BYTE (CRLF included, see
 *  `splitOperatorFenceLines`) including both tag lines, in document order. An open tag with no
 *  matching close (malformed authoring — a human left a fence unclosed) still yields no block for
 *  that open — see `operatorFenceScanResult` above for the EXPLICIT malformed signal
 *  `applyRoleBodyRewrite` now acts on; this function's own shape is unchanged for callers that only
 *  ever care about well-formed blocks. Fences do not nest — a second open before the first close is
 *  just content of the still-open block, mirroring the #703 marker walk's own no-nesting stance on
 *  GFM fences. */
export function extractOperatorOwnedFences(body: string): string[] {
  return operatorFenceScanResult(body).blocks;
}

/** #827: which of `currentFences` (already extracted from the CURRENT body) are missing — altered,
 *  removed, or present with different bytes — from `roleBody`. Multiset comparison, not a `Set`:
 *  two byte-identical fences in the current body require two matching copies in `roleBody`, not
 *  one shared by both. Empty when `currentFences` is empty (nothing to protect) or every fence
 *  survives somewhere in `roleBody` unmodified — a role may move/append around a fence freely, it
 *  just may never change what is BETWEEN its own open and close tags. Deliberately does NOT (and
 *  cannot) detect REORDERING: a multiset has no position, so two byte-identical fences that simply
 *  swapped places are correctly not a violation at all — moving a fence is explicitly allowed. */
function missingOperatorFences(currentFences: readonly string[], roleBody: string): string[] {
  if (currentFences.length === 0) return [];
  const remaining = extractOperatorOwnedFences(roleBody);
  const missing: string[] = [];
  for (const fence of currentFences) {
    const idx = remaining.indexOf(fence);
    if (idx === -1) {
      missing.push(fence);
    } else {
      remaining.splice(idx, 1);
    }
  }
  return missing;
}

/** gate② round 1 fix (P2): a role body has no standing to introduce its OWN operator-owned fence
 *  tags — `missingOperatorFences` above already refuses a write that loses or alters a REAL current
 *  fence, but nothing previously stopped a role from planting a BRAND-NEW `<!--
 *  sapwood:operator-owned -->` … `<!-- /sapwood:operator-owned -->` pair of its own (or a bare,
 *  unclosed attempt at one) — which would then read as genuine operator authority forever after,
 *  including at brand-new issue creation (`issue-creation.ts`'s `applyRoleBodyRewrite("", ...)`,
 *  where `currentFences` is always `[]` and so nothing was ever "missing" to violate).
 *
 *  Stance: STRIP the tag LINES, keep the CONTENT — same as the #703 marker's own role-authored-
 *  marker stance and #805's finding-marker stance ("a role's OWN attempt is never trusted,
 *  regardless of shape"), not a silent full-block removal (that would delete legitimate role prose
 *  that merely happened to sit between two tag-shaped lines).
 *
 *  Mechanism: `currentFences` (raw; the caller must only invoke this AFTER `missingOperatorFences`
 *  returned empty, i.e. every current fence is already known present in `roleBody`) identifies
 *  which of `roleBody`'s own fence-shaped blocks are the PRESERVED real ones — matched byte-for-
 *  byte, multiset, same rule as the violation check. Every line inside a matched block's
 *  `[openLine, closeLine]` span is untouchable, verbatim, no exceptions (even if it happens to also
 *  look like a tag line — that byte sequence is exactly what made the block match in the first
 *  place). Every OTHER standalone open/close tag line found anywhere else in `roleBody` — a whole
 *  new forged pair, a lone unclosed attempt, a stray unmatched closer, fence-code-quoted examples
 *  excluded (same recognition rule as everywhere else in this file) — is removed; its own inner
 *  content, if any, is left in place untouched. */
function stripUnpreservedOperatorFenceTags(currentFences: readonly string[], roleBody: string): string {
  const scan = scanOperatorFences(roleBody);
  const remaining = [...currentFences];
  const protectedRanges: Array<[number, number]> = [];
  for (const block of scan.blocks) {
    const idx = remaining.indexOf(block.raw);
    if (idx !== -1) {
      remaining.splice(idx, 1);
      protectedRanges.push([block.openLine, block.closeLine]);
    }
  }
  const isProtected = (lineIndex: number): boolean => protectedRanges.some(([s, e]) => lineIndex >= s && lineIndex <= e);

  // Every standalone open/close tag line in `roleBody`, fence-code-aware, INDEPENDENT of pairing —
  // this deliberately also catches a lone unclosed opener or a stray closer with no opener, which
  // `scan.blocks` above (paired boundaries only) never records at all.
  const tagLines: number[] = [];
  {
    let codeFence: { char: string; len: number } | null = null;
    for (let i = 0; i < scan.lines.length; i++) {
      const trimmed = scan.lines[i]!.raw.trim();
      const fenceMatch = FENCE_RE.exec(trimmed);
      if (fenceMatch) {
        const run = fenceMatch[1]!;
        if (codeFence === null) {
          codeFence = { char: run[0]!, len: run.length };
        } else if (run[0] === codeFence.char && run.length >= codeFence.len && trimmed.length === run.length) {
          codeFence = null;
        }
        continue;
      }
      if (codeFence !== null) continue;
      if (trimmed === OPERATOR_FENCE_OPEN || trimmed === OPERATOR_FENCE_CLOSE) tagLines.push(i);
    }
  }

  const toRemove = new Set(tagLines.filter((i) => !isProtected(i)));
  if (toRemove.size === 0) return roleBody;
  return scan.lines
    .filter((_, i) => !toRemove.has(i))
    .map((l) => l.raw + l.term)
    .join("");
}

/** #703 (ruling v2, PO batch-11 2026-08-06 — supersedes v1's "validator unchanged" stance with
 *  "structural role-marker immutability, shipped TOGETHER WITH true validator position
 *  semantics"). The adjudication marker `<!-- sapwood:comments-adjudicated-through: N -->` is
 *  PO/human-owned state: no role session — verification-plan-reviewer's approve-with-revision
 *  (plan-review.ts), verification-plan-drafter's drafted body (plan-review.ts), PO triage
 *  (align.ts), or a role-proposed brand-new issue body (issue-creation.ts) — has standing to
 *  move, create, or delete it, regardless of what the role's own output (or any prompt/plan_review
 *  advice feeding it) claims. This is the STRUCTURAL fix: call it at EVERY point a role-produced
 *  body is about to replace/become the live one, so the writers CANNOT make an invalid choice
 *  no matter what the validator itself now accepts.
 *
 *  `currentBody` is the live body immediately preceding this write (every plan-review.ts/align.ts
 *  call site already takes this exact fresh read for its own #652 pre-write body-drift
 *  checkpoint, so this function adds no new fetch there); issue-creation.ts's brand-new-issue call
 *  site passes `""` — a not-yet-existing issue has no current marker by construction, so the
 *  result is always "strip whatever the role wrote, keep none" (see that call site's own doc).
 *  `roleBody` is the role's proposed replacement (or, for issue-creation, brand-new) text.
 *
 *  PRECONDITION (ruling v2 item 2 — the refusal arm): this function assumes `currentBody`'s own
 *  marker state is ALREADY known-valid (absent, or exactly one well-formed marker) — callers with
 *  a body that might carry invalid marker state of its own (duplicate/malformed) MUST check
 *  `checkMarkerWritePrecondition(currentBody)` first and REFUSE the whole write on failure, never
 *  call this function and silently "repair" human-owned metadata by picking one, or by treating
 *  the broken state as absent. plan-review.ts's two call sites get this for free from the
 *  pre-existing #652 `checkGate0CommentCursor` checkpoint (which already fails closed on
 *  malformed/duplicate markers before ever reaching a write); align.ts's PO-triage call site has
 *  no equivalent checkpoint of its own and calls `checkMarkerWritePrecondition` explicitly.
 *
 *  Mechanism: ANY marker the role emitted is unconditionally stripped from `roleBody` — never
 *  trusted, never inspected for validity, since a role has no authority to write one regardless
 *  of what value it chose. The CURRENT body's marker, if one exists, is then reappended
 *  BYTE-FOR-BYTE (its exact original line text, not a re-derived value) onto the stripped body.
 *  If the current body carries no marker, the applied body gets none either — this function only
 *  ever PRESERVES a pre-existing marker, it never manufactures one.
 *
 *  Validator relaxation (ruling v2 item 3, this file's `computeCommentCursor`): now that no role
 *  can ever choose a marker value, `computeCommentCursor` in turn accepts a cursor pointing at
 *  ANY existing comment (engine included) as a valid position — see that function's own doc.
 *  Shipped in the SAME change as this immutability fix, never the relaxation alone: relaxing the
 *  validator before the writers are fixed would let a role silently self-adjudicate past real
 *  human comments by choosing an engine id positioned after them.
 *
 *  #827 (chosen arm: REJECT, not silent-restore — consistent with #703's own write-time guard,
 *  `checkMarkerWritePrecondition`): checked FIRST, before any marker normalization, in TWO steps.
 *  (1) gate② round 1 fix (P1a): if `currentBody`'s own fence boundary is MALFORMED (an unclosed
 *  `<!-- sapwood:operator-owned -->` opener, `operatorFenceScanResult(currentBody).malformed`),
 *  the write is refused OUTRIGHT — `ok: false, reason: "malformed-operator-fence"` — regardless of
 *  what `roleBody` contains. Before this fix, a malformed CURRENT fence extracted no block at all
 *  (indistinguishable from "no fence exists"), so the role write proceeded silently and the
 *  operator's own (broken-boundary) testimony went completely unprotected; a malformed fence must
 *  never be silently "repaired" or ignored, exactly like the marker's own `malformed-marker` arm.
 *  (2) If `roleBody` altered, removed, or reworded a single byte inside any well-formed
 *  `currentBody` operator-owned fence (`missingOperatorFences` above), the ENTIRE rewrite is
 *  refused — `ok: false, reason: "operator-fence-violation"` — naming the violation in `detail` so
 *  the caller can both refuse the forge write and emit a durable event. Unlike the marker's own
 *  strip-and-restore (silent, single-line, always safe to auto-fix), an operator-owned fence can
 *  hold arbitrary multi-line prose: silently splicing the operator's original text back in would
 *  hide from the ROLE (and from review) that its output was rejected, and would still throw away
 *  whatever legitimate, non-conflicting edits shared the same `roleBody` — reject-the-whole-write
 *  is the honest failure mode, exactly like a `current` body with an already-invalid marker
 *  refuses rather than "repairing" itself. Nothing outside a fence is restricted: content appended
 *  before, between, or after fences passes through unmodified — and reordering a byte-identical
 *  fence relative to the rest of the body is explicitly NOT a violation (a multiset comparison has
 *  no position to compare; see `missingOperatorFences`'s own doc).
 *
 *  gate② round 1 fix (P2): once both checks above pass, `roleBody` is ALSO run through
 *  `stripUnpreservedOperatorFenceTags` — a role has no standing to introduce its OWN operator-owned
 *  fence tags either (they would otherwise read as genuine operator authority forever after); see
 *  that function's own doc for the strip-the-tags-keep-the-content mechanism. This runs even when
 *  `currentBody` carries no fence at all (`currentFences` empty) — including issue-creation.ts's
 *  `applyRoleBodyRewrite("", ...)` call, where a role-proposed BRAND-NEW body's own forged fence
 *  tags are stripped by construction, never accepted as authoritative.
 *
 *  gate② round 2 fix (P1, defense in depth): the fence checks above only ever verify `roleBody`
 *  — the role's UNSTRIPPED, unmodified proposal — before this function's OWN later transforms
 *  (fence-tag stripping, marker stripping, marker reattachment) run. Nothing structurally stopped
 *  one of those LATER transforms from itself altering a byte inside an already-verified fence (the
 *  marker-strip's pre-round-2 EOL-normalization bug was exactly this: verified-then-mangled).
 *  Rather than trust every future transform to individually preserve fence bytes forever, the
 *  FINAL composed body is re-checked against the SAME `currentFences` right before returning: if
 *  any fence no longer reproduces byte-for-byte, the write is refused — never silently returned
 *  with mangled "verified" bytes. The marker reattachment appends OUTSIDE any fence (after a
 *  blank-line separator), so a passing write's fences are always exactly where
 *  `stripUnpreservedOperatorFenceTags` left them; this backstop exists for whatever a FUTURE
 *  transform gets wrong, not because the current pipeline is expected to trip it.
 *
 *  gate② round 3 fix (P2): the marker lines this function REATTACHES after a role rewrite are
 *  `currentBody`'s standalone marker lines EXCLUDING any that sit INSIDE an operator-owned fence
 *  (`currentMarkerLinesForReattach` below) — never the raw, fence-unaware `findStandaloneMarkerLines`.
 *  A marker-shaped line inside a fence is operator-authored prose PROTECTED by the fence (round 2's
 *  own protected-range stance): it already survives verbatim as part of the fence's preserved
 *  bytes, with no help from this reattachment step. Treating it ALSO as "the body's adjudication
 *  cursor to reattach" appended a SECOND copy after the body — two marker lines in the final body,
 *  which fails closed as `duplicate-marker` on the very next write. If `currentBody`'s ONLY
 *  marker-shaped line(s) are inside fences, the reattach branch now sees zero markers and appends
 *  nothing; a real, out-of-fence marker coexisting with a fenced one is still reattached exactly
 *  once, untouched. */
export type RoleBodyRewriteResult =
  | { ok: true; body: string }
  | { ok: false; reason: "operator-fence-violation"; detail: string }
  | { ok: false; reason: "malformed-operator-fence"; detail: string };

/** gate② round 3 fix (P2): `currentBody`'s standalone adjudication-cursor marker lines, excluding
 *  any that sit INSIDE an operator-owned fence — see `applyRoleBodyRewrite`'s own doc for why. Not
 *  exported and does not touch `findStandaloneMarkerLines`'s own exported read semantics (every
 *  OTHER caller — this file's own tests, ac-snapshot.ts's sibling strip — reads every standalone
 *  marker line regardless of fence membership, unchanged); this is a narrower view used ONLY for
 *  deciding what `applyRoleBodyRewrite` re-anchors after a role rewrite. Line-index compatible
 *  with `scanOperatorFences`'s own block ranges: both walks split on the SAME positions for any
 *  body using ordinary `"\n"`/`"\r\n"` line endings (a bare, lone `\r` with no following `\n` is
 *  the one case that could desync them, and does not occur in this codebase's marker/fence
 *  syntax). */
function currentMarkerLinesForReattach(currentBody: string): string[] {
  const protectedRanges = scanOperatorFences(currentBody).blocks.map((b): [number, number] => [b.openLine, b.closeLine]);
  const isProtected = (lineIndex: number): boolean => protectedRanges.some(([s, e]) => lineIndex >= s && lineIndex <= e);
  return scanStandaloneMarkerLines(currentBody)
    .filter((m) => !isProtected(m.lineIndex))
    .map((m) => m.raw);
}

export function applyRoleBodyRewrite(currentBody: string, roleBody: string): RoleBodyRewriteResult {
  const currentScan = operatorFenceScanResult(currentBody);
  if (currentScan.malformed) {
    return {
      ok: false,
      reason: "malformed-operator-fence",
      detail:
        `the issue body carries an unclosed \`${OPERATOR_FENCE_OPEN}\` fence (an opener with no matching ` +
        `\`${OPERATOR_FENCE_CLOSE}\`) — a role write cannot proceed while the operator-owned boundary itself ` +
        "is ambiguous",
    };
  }
  const currentFences = currentScan.blocks;
  const missing = missingOperatorFences(currentFences, roleBody);
  if (missing.length > 0) {
    return {
      ok: false,
      reason: "operator-fence-violation",
      detail:
        `the role-proposed body altered or removed ${missing.length} operator-owned fenced ` +
        `block(s) (\`${OPERATOR_FENCE_OPEN}\` … \`${OPERATOR_FENCE_CLOSE}\`) — a role may append content ` +
        "after a fence but never modify the bytes inside one",
    };
  }
  const roleBodyFenceStripped = stripUnpreservedOperatorFenceTags(currentFences, roleBody);
  const currentMarkerLines = currentMarkerLinesForReattach(currentBody);
  const strippedRoleBody = stripStandaloneMarkerLines(roleBodyFenceStripped);
  const finalBody =
    currentMarkerLines.length === 0 ? strippedRoleBody : `${strippedRoleBody.replace(/\s+$/, "")}\n\n${currentMarkerLines.join("\n")}\n`;

  // gate② round 2 fix (P1 backstop) — see this function's own doc above.
  const finalMissing = missingOperatorFences(currentFences, finalBody);
  if (finalMissing.length > 0) {
    return {
      ok: false,
      reason: "operator-fence-violation",
      detail:
        `the composed body no longer reproduces ${finalMissing.length} operator-owned fenced ` +
        `block(s) (\`${OPERATOR_FENCE_OPEN}\` … \`${OPERATOR_FENCE_CLOSE}\`) byte-for-byte after marker ` +
        "normalization (backstop check) — refusing rather than writing a body whose already-verified " +
        "fence bytes were altered by a later transform",
    };
  }
  return { ok: true, body: finalBody };
}

export type MarkerWritePreconditionResult = { ok: true } | { ok: false; reason: "malformed-marker" | "duplicate-marker"; detail: string };

/** #703 v2 (ruling item 2 — the refusal arm): the precondition `applyRoleBodyRewrite`'s callers
 *  MUST check before calling it, whenever `currentBody`'s own marker state might already be
 *  invalid (a human can leave a body in this state directly; nothing about role immutability
 *  prevents THAT). A role write is REFUSED entirely on failure — never "repaired" by picking a
 *  value or silently dropping the broken marker(s) — because doing either would be the engine
 *  making a human-owned adjudication call on the human's behalf. This is a PURE TEXT precondition
 *  only (no comment-stream/target-existence check — that is `computeCommentCursor`'s job, which
 *  every caller in a position to fetch the comment stream still runs on its own fail-closed
 *  arms): absent marker, or exactly one marker whose value is `"0"` or a bare digit string, is
 *  fine to carry forward untouched; more than one marker, or one whose value is neither, refuses.
 *
 *  plan-review.ts's two `applyRoleBodyRewrite` call sites never need to call this directly — the
 *  pre-existing #652 `checkGate0CommentCursor` checkpoint already runs `computeCommentCursor`
 *  against the SAME live body immediately before either write, and `computeCommentCursor`'s own
 *  malformed-marker/duplicate-marker arms (unchanged by v2) already block on exactly this
 *  condition before the write is ever reached. align.ts's PO-triage call site has no such
 *  pre-existing checkpoint and calls this function explicitly. */
export function checkMarkerWritePrecondition(currentBody: string): MarkerWritePreconditionResult {
  const found = scanStandaloneMarkerLines(currentBody);
  if (found.length === 0) return { ok: true };
  if (found.length > 1) {
    return {
      ok: false,
      reason: "duplicate-marker",
      detail: `the issue body carries ${found.length} adjudication-cursor markers — a role write cannot proceed while the cursor is ambiguous`,
    };
  }
  const value = found[0]!.value;
  if (value !== "0" && !/^\d+$/.test(value)) {
    return {
      ok: false,
      reason: "malformed-marker",
      detail: `the adjudication-cursor marker's value "${value}" is neither "0" nor a comment id — a role write cannot proceed while the marker is malformed`,
    };
  }
  return { ok: true };
}

/** One comment in the fetched, oldest-first issue-comment stream. `isEngine` is resolved by the
 *  CALLER (comment-cursor-gate.ts): both the central `ENGINE_COMMENT_MARKER` (forge.ts) present
 *  in the body AND an authoritative match to the authenticated forge actor — never either alone
 *  (design adjudicated 2026-08-05's engine-comment exemption rule). This module never inspects
 *  comment bodies/authors itself; it only consumes the already-resolved flag. `id` is `null`
 *  (#652 round 1, finding 5) when the underlying forge read returned no id for this comment — an
 *  EXPLICIT signal from the caller, never a silently-coerced `""` that could collide with (or be
 *  mistaken for) a real cursor target; see `computeCommentCursor`'s `comment-id-missing` arm. */
export interface CommentStreamEntry {
  id: string | null;
  isEngine: boolean;
}

export type CursorFailureReason =
  | "missing-marker"
  | "malformed-marker"
  | "duplicate-marker"
  | "cursor-target-not-found"
  | "comment-id-missing"
  // #652 round 1 (finding 1/2): NOT produced by this module's own computation — reserved for
  // comment-cursor-gate.ts's `checkBodyDrift`, which builds a synthetic `CommentCursorResult`
  // carrying this reason when a checkpoint's fresh live-body read no longer byte/hash-matches
  // the body a session was actually given. Declared here so the whole `CommentCursorResult`
  // vocabulary — dedup key, pointer-comment text, event `cause` — stays ONE shared type, never a
  // parallel one for the impure half's own fail-closed arm.
  | "body-drift";

export type CommentCursorResult =
  | { ok: true; cursor: string; pending: string[] }
  | { ok: false; reason: CursorFailureReason; detail: string; pending: string[]; target?: string };

/** Parse the adjudication-cursor marker out of `body` and compute the PENDING non-engine
 *  comment ids — those occurring, by stream position, after the cursor's target in `comments`
 *  (oldest-first, exactly as the forge returned them; this function never reorders). `pending`
 *  is populated on every branch (including every `ok: false` arm) so a caller building the
 *  needs-human pointer comment (comment-cursor-gate.ts) always has a best-effort candidate list
 *  — for a failure arm this is "every non-engine comment", since an invalid/unknown cursor
 *  cannot vouch for anything being adjudicated. */
export function computeCommentCursor(body: string, comments: readonly CommentStreamEntry[]): CommentCursorResult {
  // #652 round 1 (finding 5): checked FIRST, before any marker parsing — an id-less comment
  // anywhere in the stream means NO cursor target lookup (`comments.findIndex((c) => c.id ===
  // raw)` below) can be trusted to be exhaustive, so the whole computation fails closed rather
  // than silently treating a missing id as "never the target" or (worse, pre-round-1) coercing
  // it to `""` and risking an accidental match. Carries the STREAM POSITION (0-indexed,
  // oldest-first) of the FIRST id-less comment — concrete enough for a human to find it.
  const missingIdIndex = comments.findIndex((c) => c.id === null);
  if (missingIdIndex !== -1) {
    return {
      ok: false,
      reason: "comment-id-missing",
      detail:
        `comment at stream position ${missingIdIndex} (0-indexed, oldest-first) carries no id — ` +
        "the adjudication cursor cannot be evaluated against an incomplete comment stream",
      // Best-effort listing: every non-engine comment that DOES carry an id (the id-less
      // comment(s) themselves can't be named as a pending id at all).
      pending: comments.filter((c) => !c.isEngine && c.id !== null).map((c) => c.id!),
    };
  }

  // INVARIANT past this point: no `comments` entry has `id === null` (the guard above returned
  // otherwise) — every `c.id!` below is safe.
  const allNonEngineIds = comments.filter((c) => !c.isEngine).map((c) => c.id!);
  const matches = findStandaloneMarkerValues(body);

  if (matches.length === 0) {
    if (allNonEngineIds.length === 0) return { ok: true, cursor: "0", pending: [] };
    return {
      ok: false,
      reason: "missing-marker",
      detail: "the issue body carries no `sapwood:comments-adjudicated-through` marker, but the issue has non-engine comments",
      pending: allNonEngineIds,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      reason: "duplicate-marker",
      detail: `the issue body carries ${matches.length} adjudication-cursor markers — exactly one is required`,
      pending: allNonEngineIds,
      // #652 round 1 (finding 5): distinct duplicate SETS dedupe distinctly — see
      // commentCursorDedupeKey's own doc for why `target` (not a hardcoded literal) feeds the key.
      // #652 round 2 (finding 4): JSON.stringify, not `join(",")` — matching `pending`'s own
      // serialization just below (commentCursorDedupeKey's doc) — `join(",")` collapses
      // `["a,b", "c"]` and `["a", "b,c"]` to the identical `"a,b,c"` string, so two genuinely
      // different duplicate-marker sets could dedupe-collide on this same key.
      target: JSON.stringify(matches),
    };
  }

  const raw = matches[0]!;
  if (raw === "0") return { ok: true, cursor: "0", pending: allNonEngineIds };
  if (!/^\d+$/.test(raw)) {
    return {
      ok: false,
      reason: "malformed-marker",
      detail: `the adjudication-cursor marker's value "${raw}" is neither "0" nor a comment id`,
      pending: allNonEngineIds,
      target: raw,
    };
  }

  const idx = comments.findIndex((c) => c.id === raw);
  if (idx === -1) {
    return {
      ok: false,
      reason: "cursor-target-not-found",
      detail: `the adjudication cursor points at comment ${raw}, which no longer exists in the issue's comment stream`,
      pending: allNonEngineIds,
      // #652 round 1 (finding 5): keyed by the RAW target, not a shared "invalid" literal — a
      // cursor re-pointed from a still-missing comment (e.g. 999 -> 998, both absent) must dedupe
      // DISTINCTLY, so the maintainer's correction still produces a fresh pointer comment rather
      // than being silently suppressed by the previous target's stale dedup key.
      target: raw,
    };
  }
  // #703 v2 (ruling: "true position semantics"): a cursor pointing at ANY existing comment —
  // engine included — is a valid, unambiguous stream position. Rejecting an engine-comment
  // target (pre-v2's `cursor-targets-engine-comment` arm, deleted here) contradicted this
  // module's own documented model (the marker identifies a POSITION, see this file's own header
  // doc): four independent writers (plan_review's housekeeping advice, two drafter redrafts, and
  // the pre-v2 recovery-comment wording itself) all independently chose "the newest comment id"
  // — decisive usability evidence that a position IS what a marker naturally means, engine or
  // not. `pending` below already computes "non-engine comments strictly after the target index"
  // regardless of the target's own engine status — an engine target sitting AFTER the last human
  // comment naturally yields zero pending (fully adjudicated); one sitting BEFORE a later human
  // comment naturally leaves that comment pending. No special-casing needed once the rejection
  // is gone. Item 1 (structural role-marker immutability, applyRoleBodyRewrite + its call sites)
  // ships together with this relaxation, never alone — relaxing first (without immutability)
  // would let a role silently "self-adjudicate" by moving the cursor past real human comments.
  return {
    ok: true,
    cursor: raw,
    pending: comments
      .slice(idx + 1)
      .filter((c) => !c.isEngine)
      .map((c) => c.id!),
  };
}

/** Does this result require the caller to block gate⓪ spend / dispatch / drive? True for every
 *  `ok: false` arm, and for an `ok: true` cursor that still has pending (unadjudicated) comments
 *  — cursor `0` with any comments is exactly this second case. */
export function commentCursorIsStale(result: CommentCursorResult): boolean {
  return !result.ok || result.pending.length > 0;
}

// Bounded listing for the pointer comment — a runaway comment thread must not produce a runaway
// GitHub comment. ponytail: flat literal cap, raise it (or make it a config key) if a real repo's
// pending set ever needs more than this to be actionable.
const POINTER_COMMENT_ID_CAP = 30;

/** Deterministic dedup key for "the same cursor/pending set" — embedded in the pointer comment
 *  body so comment-cursor-gate.ts's live marker-scan dedup (same idiom as conductor.ts's
 *  `commentOnEscalationCarrier`) recognizes a repeat of the SAME stale condition and skips
 *  reposting, while a NEW comment arriving (changing the pending set) gets its own fresh post.
 *
 *  #652 round 1 (finding 5), two hardenings:
 *   1. `cursor` is the result's own `target` (the RAW marker value an invalid cursor pointed at)
 *      when one is available, never a shared `"invalid"` literal — a cursor corrected from one
 *      still-invalid target to ANOTHER (e.g. 999 -> 998, both absent from the stream) must dedupe
 *      DISTINCTLY, or the maintainer's correction would be silently suppressed as "already
 *      posted." `target` is absent only for `missing-marker`/`comment-id-missing` (no single
 *      marker value exists to key on) and for the pure `pending`-cursor `ok: true` case (which
 *      already keys on its own real `cursor` instead) — both fall back to `"none"`.
 *   2. `pending` is serialized via `JSON.stringify`, not `Array.prototype.join(",")` — `join`
 *      collapses `[]` and `[""]` to the identical `""` string, so an id-less-comment edge case
 *      (pre-hardening, when a missing id silently became `""`) could dedupe-collide with a
 *      genuinely empty pending set. `JSON.stringify` distinguishes `"[]"` from `'[""]'`. */
export function commentCursorDedupeKey(result: CommentCursorResult): string {
  const reason = result.ok ? "pending" : result.reason;
  const cursor = result.ok ? result.cursor : (result.target ?? "none");
  const idsHash = createHash("sha256").update(JSON.stringify(result.pending)).digest("hex").slice(0, 12);
  return `${reason}:${cursor}:${idsHash}`;
}

export function commentCursorPointerMarker(dedupeKey: string): string {
  return `<!-- sapwood:comment-cursor-stale:${dedupeKey} -->`;
}

/** The needs-human pointer comment body (marker-suffixed by addIssueComment's own
 *  stampEngineComment — this function never appends ENGINE_COMMENT_MARKER itself).
 *
 *  #652 round 1 (finding 1/2): a `body-drift` result gets its OWN wording branch — "this issue's
 *  adjudication cursor is invalid" is simply false for a body-drift discard (the cursor itself
 *  may be perfectly valid; what changed is the body a session's decision was computed against),
 *  and the ordinary recovery steps below (advance the marker) do not apply — a body-drift discard
 *  needs no cursor/marker action, only the label removed.
 *
 *  #703 v2 (ruling item 4 — "recovery text = a copy-paste instruction"): `comment-id-missing` ALSO
 *  gets its own wording branch — it is a forge-READ failure (some comment in the stream came back
 *  with no id at all), not a marker problem, so suggesting a marker target here would be
 *  dishonest: no id can be vouched for while the stream itself is incomplete. Every other branch
 *  (valid-but-incomplete, missing/malformed/duplicate marker, deleted target) ends with the EXACT
 *  standalone marker line a human can copy-paste verbatim, worded "comment id N" — never "#N",
 *  which reads as a GitHub issue/PR cross-reference, not a comment id (the T7 finding's original
 *  wording trap, live-reproduced on #688). */
export function buildCommentCursorPointerComment(result: CommentCursorResult): string {
  const dedupeKey = commentCursorDedupeKey(result);
  if (!result.ok && result.reason === "body-drift") {
    return (
      `sapwood: ${result.detail} A pending decision was discarded rather than applied against ` +
      `stale text. No cursor/marker action is needed — remove \`needs-human\` to let the issue ` +
      `re-enter plan review normally on its next pass.\n\n${commentCursorPointerMarker(dedupeKey)}`
    );
  }
  if (!result.ok && result.reason === "comment-id-missing") {
    return (
      `sapwood: ${result.detail} This is a forge-READ problem, not something a marker edit can fix ` +
      `— no comment id can be honestly vouched for while the fetched comment stream is incomplete. ` +
      `Retry the comment fetch (re-run this checkpoint); if one comment genuinely carries no id on ` +
      `GitHub itself, that needs to be resolved directly before this issue's adjudication cursor can ` +
      `be evaluated again. No marker target is suggested here.\n\n${commentCursorPointerMarker(dedupeKey)}`
    );
  }
  const shown = result.pending.slice(0, POINTER_COMMENT_ID_CAP);
  const overflow = result.pending.length - shown.length;
  // #703 v2 gate② (P2-2): rendered as backticked RAW ids — never `#${id}` — everywhere in this
  // comment, not only in the accepted-marker sentence below. `#N` reads as a GitHub issue/PR
  // cross-reference (the exact wording trap the ruling's "comment id N, never #N" line exists to
  // avoid), and a comment id has no special GitHub syntax of its own to render as — a plain
  // backticked number is the unambiguous, copy-paste-safe form.
  const list =
    shown.length > 0 ? shown.map((id) => `\`${id}\``).join(", ") + (overflow > 0 ? ` (+${overflow} more)` : "") : "(none listed)";
  const reasonText = result.ok
    ? "this issue's adjudication cursor is valid but does not yet cover every comment"
    : `this issue's adjudication cursor is invalid (${result.reason}: ${result.detail})`;
  // `result.pending` is always stream-ordered (oldest-first, the same order `computeCommentCursor`
  // builds it in on every branch), so its LAST element — when non-empty — is the newest non-engine
  // comment currently on the issue: the concrete id a fresh marker pointed at it would be accepted
  // by `computeCommentCursor` right now (v2: ANY existing comment id is a valid position, so this
  // is a RECOMMENDATION for the least-surprising correct choice, not the only one that would pass
  // — a human may point the marker at any comment they've actually adjudicated). An empty `pending`
  // means no non-engine comment exists at all — the marker target then is `0`.
  const acceptedId = result.pending.at(-1) ?? "0";
  const acceptedMarkerLine = `<!-- sapwood:comments-adjudicated-through: ${acceptedId} -->`;
  const acceptedText =
    acceptedId === "0"
      ? "this issue currently has no non-engine comments, so comment id `0` is what the marker below targets"
      : `the newest non-engine comment on this issue right now carries comment id \`${acceptedId}\` — the marker below targets it`;
  // Duplicate-marker gets an EXTRA instruction: which of the several existing lines to keep is
  // ambiguous, so "advance the marker" alone is not enough — the human must also remove every
  // OTHER cursor-marker line, leaving exactly the one this comment provides.
  const duplicateNote =
    !result.ok && result.reason === "duplicate-marker"
      ? " This issue currently carries more than one adjudication-cursor marker line — remove every " +
        "OTHER `sapwood:comments-adjudicated-through` line from the body and leave exactly this one."
      : "";
  return (
    `sapwood: ${reasonText}. Pending (non-engine) comment id(s): ${list}.\n\n` +
    `Recovery steps: record the ruling, rewrite the issue body to reflect it, and set the ` +
    `adjudication-cursor marker to EXACTLY this line (copy-paste it verbatim):${duplicateNote}\n\n` +
    `${acceptedMarkerLine}\n\n` +
    `${acceptedText}. Then remove \`needs-human\`.\n\n${commentCursorPointerMarker(dedupeKey)}`
  );
}
