/**
 * Extract every Markdown section whose heading matches `headingPattern`, preserving body order.
 * A section runs through (but excludes) the next heading of equal or shallower level. Nested
 * matching sections are already contained in their matching ancestor and are emitted only once.
 * `headingPattern` is a pattern fragment interpolated after the heading hashes: do not pass
 * anchors or backreferences. Matching is forced case-insensitive, and a sticky flag is stripped.
 */
export function extractMarkdownSections(body: string, headingPattern: RegExp): string[] {
  const flags = [...new Set(`${headingPattern.flags.replace(/[gmy]/g, "")}i`)].join("");
  const headingMatcher = new RegExp(`^(#{1,6})\\s*${headingPattern.source}[^\\n]*$`, flags);
  const realHeadings: Array<{ start: number; level: number; matches: boolean }> = [];
  let offset = 0;
  let inFence = false;

  for (const rawLine of body.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (/^(?:```|~~~)/.test(line)) {
      inFence = !inFence;
    } else if (!inFence) {
      const heading = /^(#{1,6})\s/.exec(line);
      const matchingHeading = headingMatcher.exec(line);
      if (heading || matchingHeading) {
        realHeadings.push({
          start: offset,
          level: (heading?.[1] ?? matchingHeading?.[1])!.length,
          matches: matchingHeading != null,
        });
      }
    }
    offset += rawLine.length + 1;
  }

  const sections: Array<{ start: number; end: number }> = [];

  for (const [index, heading] of realHeadings.entries()) {
    if (!heading.matches) continue;
    const end = realHeadings.slice(index + 1).find((candidate) => candidate.level <= heading.level)?.start ?? body.length;

    if (sections.some((section) => heading.start >= section.start && end <= section.end)) continue;
    sections.push({ start: heading.start, end });
  }

  return sections.map(({ start, end }) => body.slice(start, end).trim());
}
