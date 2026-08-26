import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

/**
 * STYLE doctrine (engine/prompts/doctrine-core.md, "Is this test real?"): a computed-style assertion must
 * never be `notEqual`/existence-only — any non-default value satisfies it, so the assertion proves
 * nothing about the actual rendered value. happy-dom compounds this: it returns "" (not "0px") for
 * an unresolved `var(...)` border/dimension shorthand, and "" is also != "0px", so the tautology
 * still passes when the style never resolved at all. This scan turns that shape (the literal
 * "0px" as the excluded value) into a build failure instead of relying on a re-read instruction
 * alone. Anchor: #879.
 *
 * Scoped to the literal "0px" only, not a blanket "any notEqual" ban: `notEqual(x, "")` and
 * `notEqual(x, "none")` have live, legitimate uses elsewhere in this suite (a real "did a font
 * actually resolve" or "is this element actually hidden" check, not a rendered-dimension proof).
 * Widening the ban to those literals would flag tests that already reasoned about this correctly.
 *
 * The matcher is line-based text matching, not a parser: a string literal or trailing inline
 * comment that happens to quote the exact `assert.notEqual(..., "0px")` shape on a code line will
 * still trip the scan (it doesn't distinguish code from same-line prose) — reword the line rather
 * than working around the scan.
 */

// Anchored on `assert.notEqual(`/`assert.strict.notEqual(` (this repo's only call shapes — see
// self-test) so a same-named method on some other object (`api.notEqual(x, "0px")`) doesn't false
// -positive. Non-greedy `[^;]*?` then lets the match skip over commas and nested parens in the
// first argument (e.g. `assert.notEqual(getComputedStyle(el, "::before").width, "0px")`) by
// searching forward for the first `, "0px"` that is itself followed by `,` (a trailing message
// arg) or `)` (call end), rather than assuming the first comma in the call is the argument
// boundary.
const ZERO_PX_NOT_EQUAL = /\bassert(?:\.strict)?\.notEqual\([^;]*?,\s*["']0px["']\s*[,)]/;

/** True if `line` contains an `assert.notEqual(..., "0px" [, message])` tautology call. */
export function hasZeroPxNotEqual(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.startsWith("//") || trimmed.startsWith("*")) return false; // comment lines, not code
  return ZERO_PX_NOT_EQUAL.test(line);
}

test("hasZeroPxNotEqual matcher self-test", () => {
  const cases: Array<[line: string, expected: boolean, label: string]> = [
    // positive: shapes the old whole-file regex missed
    [`assert.notEqual(computed.borderWidth, "0px")`, true, "plain call"],
    [`assert.notEqual(computed.borderWidth, "0px", "border should resolve")`, true, "with message arg"],
    [`assert.notEqual(getComputedStyle(el, "::before").width, "0px")`, true, "nested-paren first arg"],
    [`  assert.notEqual(x, '0px')`, true, "single-quoted literal"],
    [`assert.strict.notEqual(x, "0px")`, true, "assert.strict.notEqual variant"],
    // negative: legitimate uses and non-code lines that must not trip the scan
    [`assert.notEqual(x, "")`, false, "empty-string literal is a legitimate check"],
    [`assert.notEqual(x, "none")`, false, "none literal is a legitimate check"],
    [`assert.strictEqual(x, "0px")`, false, "strictEqual is not notEqual"],
    [`api.notEqual(x, "0px")`, false, "non-assert object sharing the method name"],
    [`notEqual(x, "0px")`, false, "bare call with no assert-namespace prefix"],
    [`// assert.notEqual(x, "0px") — do not do this`, false, "line comment"],
    [` * assert.notEqual(x, "0px") in a docblock`, false, "docblock continuation line"],
  ];
  for (const [line, expected, label] of cases) {
    assert.equal(hasZeroPxNotEqual(line), expected, `${label}: ${line}`);
  }
});

test('STYLE doctrine: no new assert.notEqual(x, "0px") tautology under dashboard/src', () => {
  const srcDir = new URL(".", import.meta.url).pathname;
  const self = new URL(import.meta.url).pathname;
  const offenders: string[] = [];
  for (const file of listTestFiles(srcDir)) {
    if (file === self) continue; // this file's own doc comment / self-test table quote the banned literal
    const lines = readFileSync(file, "utf8").split("\n");
    for (const [i, line] of lines.entries()) {
      if (hasZeroPxNotEqual(line)) {
        offenders.push(`${file.slice(srcDir.length)}:${i + 1}`);
        break;
      }
    }
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
