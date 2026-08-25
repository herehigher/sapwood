// doc-links.test.ts — #1094 PR-0 (R8 finding C): DOC_LINKS carries three anchored fragments
// `npm run check-links` cannot see (it only walks Markdown links, and nothing in the shipped
// docs currently links to these anchors) — so a heading rename in the target file breaks a
// production runtime citation with no CI signal. This oracle drives every DOC_LINKS entry
// against the doc it names: an anchored entry must be a real heading slug of the target file;
// an un-anchored entry must resolve to a file that exists. Paths come from DOC_LINKS itself
// (stripped of its known base URL), never a hand-copied list, so a path this module starts
// citing differently breaks here too.
//
// slugify/headingSlugs below are a byte-for-byte copy of scripts/check-links.ts's algorithm, not
// a fresh port ("no new slugger") — importing that module from here fails engine's own
// typecheck: `engine/tsconfig.typecheck.json` sets `rootDir: "src"`, so a file physically outside
// it (TS6059), and NodeNext moduleResolution rejects a raw ".ts" import without
// `allowImportingTsExtensions` (TS5097), which the engine's real build config can't carry (both
// confirmed by trying the import, not assumed). Keep this copy in sync if check-links.ts's
// algorithm ever changes; scripts/check-links.test.ts pins the algorithm's own edge cases.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DOC_LINKS } from "./doc-links.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_BASE_URL = "https://github.com/herehigher/sapwood/blob/main/";

const KEEP_CATEGORY_RE = /[\p{L}\p{M}\p{Nd}]/u;

function slugify(text: string): string {
  const stripped = text.replace(/[`*_]/g, "").toLowerCase();
  let kept = "";
  for (const ch of stripped) {
    if (ch === " " || ch === "-" || KEEP_CATEGORY_RE.test(ch)) kept += ch;
  }
  return kept.trim().replaceAll(" ", "-");
}

function headingSlugs(content: string): Set<string> {
  const slugs = new Set<string>();
  for (const line of content.replaceAll("\r\n", "\n").split("\n")) {
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

for (const [key, url] of Object.entries(DOC_LINKS)) {
  test(`DOC_LINKS.${key} resolves to a real file/heading`, () => {
    assert.ok(url.startsWith(DOC_BASE_URL), `DOC_LINKS.${key}: expected a ${DOC_BASE_URL} URL, got ${url}`);
    const rest = url.slice(DOC_BASE_URL.length);
    const hashIdx = rest.indexOf("#");
    const docPath = hashIdx === -1 ? rest : rest.slice(0, hashIdx);
    const fragment = hashIdx === -1 ? undefined : rest.slice(hashIdx + 1);
    const fullPath = join(REPO_ROOT, docPath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf8");
    } catch {
      assert.fail(`DOC_LINKS.${key}: target doc "${docPath}" does not exist under the repo root`);
    }
    if (fragment !== undefined) {
      const slugs = headingSlugs(content);
      assert.ok(
        slugs.has(fragment),
        `DOC_LINKS.${key}: #${fragment} is not a real heading slug in ${docPath} (have: ${[...slugs].join(", ")})`,
      );
    }
  });
}
