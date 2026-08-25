// markdown-slug.ts — GitHub-compatible Markdown heading-slug computation (github-slugger
// behavior). Factored out of scripts/check-links.ts so engine/src/util/doc-links.test.ts can pin
// DOC_LINKS' anchors against the SAME algorithm the doc-link checker uses, rather than a second
// copy that could drift out of sync. Zero imports (a leaf): both scripts/tsconfig.json's bundler
// resolution and engine's own NodeNext resolution can import a zero-import file without either
// side's extension convention fighting the other's.

// Strip inline code/emphasis markers, lowercase, then drop every character that is not a Unicode
// letter/mark/decimal-digit/hyphen/space — deliberately `\p{L}\p{M}\p{Nd}`, NOT `\w` and NOT
// `\p{N}`: JS `\w` keeps only ASCII, and `\p{N}` also keeps Unicode category No/Nl (circled
// digits like the gate marks used in this repo's own headings, e.g. `⓪`/`②`) that GitHub's
// slugger strips. Each remaining literal space maps to its own hyphen — runs are NOT
// collapsed, so "table — reading" (em dash between two spaces, the dash itself dropped above)
// yields "table--reading", matching GitHub exactly.
const KEEP_CATEGORY_RE = /[\p{L}\p{M}\p{Nd}]/u;

export function slugify(text: string): string {
  const stripped = text.replace(/[`*_]/g, "").toLowerCase();
  let kept = "";
  for (const ch of stripped) {
    if (ch === " " || ch === "-" || KEEP_CATEGORY_RE.test(ch)) kept += ch;
  }
  return kept.trim().replaceAll(" ", "-");
}

// A fenced code block's OPENING delimiter (CommonMark): at most 3 leading spaces, then 3+
// backticks or 3+ tildes (an info string may follow — not validated here, this module only needs
// to know a fence opened, never renders the sample). 4+ leading spaces is indented code, not a
// fence at all — the regex's own `{0,3}` cap means a line with a 4th leading space never matches
// at any backtrack position.
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})/;

// Tracked (open char + its repeat count) so a shell comment or a `# ...` line inside a fenced
// sample never counts as a real heading — without this, a renamed/removed real heading could
// hide behind a code-sample line that merely looks like one, and this module would report the
// removed anchor as still valid. A fence with no matching closer runs to end-of-document (every
// line after it, headings included, stays "inside").
export function headingSlugs(content: string): Set<string> {
  const slugs = new Set<string>();
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
    if (fenceChar === null) {
      const open = FENCE_OPEN_RE.exec(line);
      if (open) {
        const marker = open[1]!;
        fenceChar = marker[0]!;
        fenceLen = marker.length;
        continue; // a fence delimiter line is never a heading itself
      }
    } else {
      // CLOSING fence: same char, at least the opening count, at most 3 leading spaces, and
      // NOTHING but optional trailing whitespace after the run — a line like "```text" inside an
      // open fence has trailing content after the run, so it does NOT close it (it's content).
      const closeRe = new RegExp(`^ {0,3}[${fenceChar}]{${fenceLen},}[ \t]*$`);
      if (closeRe.test(line)) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue; // every line while a fence is open is content, never a heading candidate
    }
    const m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = slugify(m[2] ?? "");
    let slug = base;
    let i = 1;
    while (slugs.has(slug)) {
      slug = `${base}-${i}`;
      i++;
    }
    slugs.add(slug);
  }
  return slugs;
}
