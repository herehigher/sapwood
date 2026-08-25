// doc-links.test.ts: DOC_LINKS carries anchored fragments `npm run check-links` cannot see — it
// only walks Markdown links inside the shipped docs, and nothing there currently links to these
// anchors from prose — so a heading rename in the target file would silently break a production
// runtime citation with no CI signal. This oracle drives every DOC_LINKS entry against the doc it
// names: an anchored entry must be a real heading slug of the target file (via
// markdown-slug.ts's headingSlugs, the same algorithm scripts/check-links.ts uses); an
// un-anchored entry must resolve to a file that exists. Paths come from DOC_LINKS itself
// (stripped of its known base URL), never a hand-copied list, so a path this module starts
// citing differently breaks here too.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { DOC_LINKS } from "./doc-links.js";
import { headingSlugs } from "./markdown-slug.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DOC_BASE_URL = "https://github.com/herehigher/sapwood/blob/main/";

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
