/**
 * Extract every Markdown section whose heading matches `headingPattern`, preserving body order.
 * A section runs through (but excludes) the next heading of equal or shallower level. Nested
 * matching sections are already contained in their matching ancestor and are emitted only once.
 * `headingPattern` is a pattern fragment interpolated after the heading hashes: do not pass
 * anchors or backreferences. Matching is forced case-insensitive, and a sticky flag is stripped.
 *
 * `level`, when given, restricts a MATCH to a heading with exactly that many `#`s (enforced in
 * the same regex the match runs against, not a post-filter over the any-level result) — every
 * heading still contributes to section boundaries regardless of level, only which ones count as
 * a match narrows. A post-filter can't do this: the any-level result already collapses a nested
 * match into its enclosing match (see above), so an unwanted outer heading (e.g. an H1 wrapping
 * the real H2) would have already swallowed the one the caller actually wants. Omitted, matching
 * stays any-level 1-6 — byte-identical to this function's pre-`level` behavior.
 */
export function extractMarkdownSections(body: string, headingPattern: RegExp, level?: number): string[] {
  const flags = [...new Set(`${headingPattern.flags.replace(/[gmy]/g, "")}i`)].join("");
  const hashCount = level === undefined ? "{1,6}" : `{${level}}`;
  const headingMatcher = new RegExp(`^(#${hashCount})\\s*${headingPattern.source}[^\\n]*$`, flags);
  const realHeadings: Array<{ start: number; level: number; matches: boolean; terminates: boolean }> = [];
  let offset = 0;
  let fence: { character: "`" | "~"; length: number } | null = null;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (fence) {
      const closer = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
      if (closer?.[0] === fence.character && closer.length >= fence.length) fence = null;
    } else {
      const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (opener) {
        fence = { character: opener[0] as "`" | "~", length: opener.length };
        offset += rawLine.length + 1;
        continue;
      }
      const heading = /^(#{1,6})\s/.exec(line);
      const matchingHeading = headingMatcher.exec(line);
      if (heading || matchingHeading) {
        realHeadings.push({
          start: offset,
          level: (heading?.[1] ?? matchingHeading?.[1])!.length,
          matches: matchingHeading != null,
          terminates: heading != null,
        });
      }
    }
    offset += rawLine.length + 1;
  }

  const sections: Array<{ start: number; end: number }> = [];

  for (const [index, heading] of realHeadings.entries()) {
    if (!heading.matches) continue;
    const end =
      realHeadings.slice(index + 1).find((candidate) => candidate.terminates && candidate.level <= heading.level)?.start ?? body.length;

    if (sections.some((section) => heading.start >= section.start && end <= section.end)) continue;
    sections.push({ start: heading.start, end });
  }

  return sections.map(({ start, end }) => body.slice(start, end).trim());
}

/** #672 (Codex gate② P2 on #665, moved here #975): untrusted text (an issue/PR comment body, a
 *  forge-read CI-log excerpt — anyone who can comment or trigger CI authored it) is about to be
 *  interpolated straight into a `<...>...</...>`-delimited data block inside a role prompt or
 *  proxy tool response. A literal closing tag (or a forged peer tag) inside that text would
 *  otherwise close/reopen the block early and hand the reader attacker-authored text framed as
 *  structure rather than as quoted content — a prompt-injection escape hatch. Escaping every `<`
 *  is the minimal neutralization: it denies the text the one character every one of this
 *  codebase's data-block delimiters opens on, without touching anything else about the text's
 *  readability as plain text. No matching unescape exists anywhere downstream — every consumer of
 *  this function is a read-only judgment prompt or tool response, never a place that reconstitutes
 *  or re-emits the original bytes.
 *
 *  Lives in this dependency-free leaf module (not `roles/plan-review.ts`, its original #672 home)
 *  so `proxy/tools.ts` can reuse the SAME neutralization for `pr_failed_checks`' CI-log excerpt
 *  (#975) without creating an import cycle: `proxy/tools.ts` -> `roles/plan-review.ts` ->
 *  `roles/peripheral.ts` -> `proxy/access.ts` -> `proxy/tools.ts` would otherwise close a loop.
 *  Every caller (`roles/plan-review.ts`, `loop/decompose.ts` #965, `proxy/tools.ts` #975) imports
 *  directly from here — no re-export shim (pre-v1: no compat layers). */
export function escapeAngleBrackets(text: string): string {
  return text.replaceAll("<", "&lt;");
}

/** #830: strip every HTML comment (`<!-- ... -->`) from `text` before it is substituted into a
 *  role prompt. A scaffolded file a human edits in a text editor or on GitHub (goal-template.md,
 *  doctrine-template.md, and anything shaped like them) authors ITS OWN customization guidance as
 *  inline HTML comments — invisible on a rendered-markdown viewer, but ordinary text to a raw
 *  substitution into an LLM prompt. Doing this at the LOAD boundary (`doctrine.ts`'s
 *  `loadDoctrine`, `align.ts`'s `{{plan.md}}` substitution, `architect.ts`'s
 *  `loadGoalExcerptWithStatus`) rather than by editing the templates keeps the on-disk file —
 *  and a human editing it — untouched; only the copy actually handed to a session is cleaned.
 *
 *  A blanket `/<!--[\s\S]*?-->/g` is not Markdown-aware — it would strip a `<!-- ... -->` marker
 *  quoted inside a backtick span (this repo's own docs/REVIEW-DOCTRINE.md:55,
 *  `` `<!-- sapwood:floor:<name> -->` ``, corrupting the very floor marker every doctrine load
 *  composes into the prompt) or shown as a literal example inside a fenced code block. This
 *  single-pass scanner walks `text` once, tracking four mutually exclusive states — inside a
 *  FENCED block (``` or ~~~, closer run length >= opener run length, the same shape
 *  `extractMarkdownSections` above already tracks), on an INDENTED CODE line (4+ spaces or a tab
 *  at line start — copied through whole, untouched, like fenced content), inside a BACKTICK SPAN
 *  (opened by a run of N backticks, closed only by the next run of EXACTLY N backticks — a
 *  shorter or longer run is not a closer and is copied through as literal text), or NORMAL TEXT —
 *  and only strips a `<!--...-->` pair found in NORMAL TEXT; content inside a fence, an indented
 *  code line, or a backtick span is copied through byte-for-byte, comments and all.
 *
 *  Ceiling on the indented-code recognition: a 4-space Markdown list-continuation line reads as
 *  code too (indistinguishable from real code without a full tokenizer), so a scaffold comment
 *  indented under a list item would survive uncut. No shipped template has one today — pinned by
 *  a negative-lint test in markdown.test.ts — so a future template edit that adds one would need
 *  to catch this gap itself.
 *
 *  An UNTERMINATED `<!--` (no matching `-->` anywhere after it) is left completely unchanged,
 *  never stripped to end-of-string: a truncated opener is more likely a Markdown edge case (a
 *  literal `<!--` in prose, or a comment a human is mid-editing) than license to discard
 *  everything after it, and silently deleting real trailing doctrine content on a parse ambiguity
 *  is the worse failure of the two directions — see markdown.test.ts's pin for this exact case. */
export function stripHtmlComments(text: string): string {
  let out = "";
  let i = 0;
  let atLineStart = true;
  let fence: { char: "`" | "~"; length: number } | null = null;

  while (i < text.length) {
    if (atLineStart) {
      const lineEnd = text.indexOf("\n", i);
      const lineBreakAt = lineEnd === -1 ? text.length : lineEnd + 1;
      const rawLine = lineEnd === -1 ? text.slice(i) : text.slice(i, lineEnd);
      // Detection only: a CRLF line's trailing \r must not defeat the anchored fence/indent
      // regexes below. The output slices always read from `text` directly, so this never changes
      // an emitted byte.
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (fence) {
        const closer = /^ {0,3}(`+|~+)[ \t]*$/.exec(line)?.[1];
        if (closer?.[0] === fence.char && closer.length >= fence.length) fence = null;
        out += text.slice(i, lineBreakAt);
        i = lineBreakAt;
        continue;
      }
      const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (opener) {
        fence = { char: opener[0] as "`" | "~", length: opener.length };
        out += text.slice(i, lineBreakAt);
        i = lineBreakAt;
        continue;
      }
      if (/^(?: {4,}|\t)/.test(line)) {
        out += text.slice(i, lineBreakAt);
        i = lineBreakAt;
        continue;
      }
      atLineStart = false;
    }

    const ch = text[i]!;
    if (ch === "\n") {
      out += ch;
      i++;
      atLineStart = true;
      continue;
    }
    if (ch === "`") {
      let j = i;
      while (text[j] === "`") j++;
      const openLen = j - i;
      // Scan forward for the next run of EXACTLY openLen backticks — a run of any other length
      // is not a valid closer and is skipped whole (its own length disqualifies every backtick
      // inside it as a partial match).
      let k = j;
      let closerStart = -1;
      while (k < text.length) {
        if (text[k] === "`") {
          let m = k;
          while (text[m] === "`") m++;
          if (m - k === openLen) {
            closerStart = k;
            break;
          }
          k = m;
        } else {
          k++;
        }
      }
      if (closerStart !== -1) {
        // The whole span, opener through closer, copied verbatim — a comment quoted inside it
        // (a doctrine floor marker shown as inline code, e.g.) is real prose, not a live comment.
        out += text.slice(i, closerStart + openLen);
        i = closerStart + openLen;
      } else {
        out += text.slice(i, j); // no closer anywhere in the rest of the text -> literal backticks
        i = j;
      }
      continue;
    }
    if (ch === "<" && text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      if (end !== -1) {
        i = end + 3;
        continue;
      }
      out += text.slice(i); // unterminated: keep the remainder byte-for-byte, never truncate to EOF
      i = text.length;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}
