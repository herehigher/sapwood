import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * STYLE doctrine (docs/REVIEW-DOCTRINE.md, "Is this test real?"): a computed-style assertion must
 * never be `notEqual`/existence-only, "which any non-default value satisfies." Recurring class,
 * three occurrences: #879 (the rule's origin), #897 (hero.test.ts's own comment names the same
 * shape), and #923/PR #947 — `assert.notEqual(computed.borderWidth, "0px")` still passed on
 * happy-dom's empty-string return for an unresolved `var(--hairline)` border shorthand. A prose
 * re-scan step (worker.md step 8, retro #398) already asks the worker to catch this before
 * finishing; it shipped a third time immediately after that step landed. This scan turns the one
 * reproduced shape (the literal "0px" as the excluded value) into a build failure instead of
 * relying on a re-read instruction alone.
 *
 * Scoped to the literal "0px" only, not a blanket "any notEqual" ban: `notEqual(x, "")` and
 * `notEqual(x, "none")` have live, legitimate uses elsewhere in this suite (a real "did a font
 * actually resolve" or "is this element actually hidden" check, not a rendered-dimension proof —
 * see Transport.test.tsx, hero.test.ts's own #897 comment, ConfigDrawer.test.tsx). Widening the
 * ban to those literals would flag tests that already reasoned about this correctly.
 */
test('STYLE doctrine: no new assert.notEqual(x, "0px") tautology under dashboard/src', () => {
  const srcDir = new URL(".", import.meta.url).pathname;
  const self = new URL(import.meta.url).pathname;
  const offenders: string[] = [];
  for (const file of listTestFiles(srcDir)) {
    if (file === self) continue; // this file's own doc comment quotes the banned literal
    const text = readFileSync(file, "utf8");
    if (/notEqual\([^,]+,\s*["']0px["']\s*\)/.test(text)) offenders.push(file.slice(srcDir.length));
  }
  assert.deepEqual(
    offenders,
    [],
    `assert.notEqual(x, "0px") proves nothing — happy-dom can return "" for an unresolved var() ` +
      `border/dimension shorthand, which is also != "0px". Assert the exact resolved value instead: ${JSON.stringify(offenders)}`,
  );
});

function listTestFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTestFiles(full));
    else if (/\.test\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}
