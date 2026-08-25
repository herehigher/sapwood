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

// A fenced code block's delimiter (CommonMark: a line whose trimmed content starts with 3+
// backticks or 3+ tildes; closed by a later line with the SAME character and at least as many
// repeats). Tracked so a shell comment or a `# ...` line inside a fenced sample never counts as
// a real heading — without this, a renamed/removed real heading could hide behind a code-sample
// line that merely looks like one, and this module would report the removed anchor as still
// valid.
const FENCE_RE = /^(`{3,}|~{3,})/;

// Every heading in a Markdown file's slugs, with GitHub-style duplicate-slug suffixing
// (-1, -2, ...): the second `## Foo` on a page gets `foo-1`, the third `foo-2`, and so on.
// Takes content directly (rather than a path) so it is exercisable without touching the
// filesystem; `headingsOf` in scripts/check-links.ts is the path-reading wrapper the checker
// itself uses.
export function headingSlugs(content: string): Set<string> {
  const slugs = new Set<string>();
  let fenceChar: string | null = null;
  let fenceLen = 0;
  for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
    const fenceMatch = FENCE_RE.exec(line.trimStart());
    if (fenceMatch) {
      const marker = fenceMatch[1]!;
      if (fenceChar === null) {
        fenceChar = marker[0]!;
        fenceLen = marker.length;
      } else if (marker[0] === fenceChar && marker.length >= fenceLen) {
        fenceChar = null;
        fenceLen = 0;
      }
      continue; // a fence delimiter line is never a heading itself
    }
    if (fenceChar !== null) continue; // inside a fenced block — never a heading candidate
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
