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
 *  Non-greedy and dotAll-equivalent (`[\s\S]*?`, not `.` — a real comment in either template
 *  spans multiple lines) so two adjacent comments are stripped as two matches, never merged into
 *  one that also eats the prose between them. */
export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, "");
}
