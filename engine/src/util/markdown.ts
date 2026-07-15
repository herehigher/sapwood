/**
 * Extract every Markdown section whose heading matches `headingPattern`, preserving body order.
 * A section runs through (but excludes) the next heading of equal or shallower level. Nested
 * matching sections are already contained in their matching ancestor and are emitted only once.
 */
export function extractMarkdownSections(body: string, headingPattern: RegExp): string[] {
  const flags = [...new Set(`${headingPattern.flags.replaceAll("y", "")}gmi`)].join("");
  const headings = body.matchAll(new RegExp(`^(#{1,6})\\s*${headingPattern.source}[^\\n]*$`, flags));
  const sections: Array<{ start: number; end: number }> = [];

  for (const heading of headings) {
    const start = heading.index;
    const level = heading[1]!.length;
    const afterHeadingStart = start + heading[0].length;
    const afterHeading = body.slice(afterHeadingStart);
    const nextHeading = new RegExp(`^#{1,${level}}\\s`, "m").exec(afterHeading);
    const end = nextHeading ? afterHeadingStart + nextHeading.index : body.length;

    if (sections.some((section) => start >= section.start && end <= section.end)) continue;
    sections.push({ start, end });
  }

  return sections.map(({ start, end }) => body.slice(start, end).trim());
}
