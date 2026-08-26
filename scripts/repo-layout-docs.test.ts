// Cross-artifact oracle (companion to scripts/runtime-dir-docs.test.ts, which does the same
// job for the `.sapwood/` tree): docs/dev-guide/02-repo-layout.md's two directory tables
// describe the repository's own shape, and nothing keeps them in sync with the tracked Git
// tree except a human noticing drift. This parses both tables and diffs them against
// `git ls-tree` in both directions — every tracked directory has a row, and every row is
// actually tracked — so a moved/renamed/deleted directory shows up as a failing test instead
// of a stale doc. Node built-ins, `node:test`, and `git` only, matching this directory's
// existing scripts (no dependency, no shell — `execFileSync` with an argv array).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const LAYOUT_DOC_PATH = join(REPO_ROOT, "docs", "dev-guide", "02-repo-layout.md");

const TOP_LEVEL_HEADING = "## Top level";
const TOP_LEVEL_HEADER_CELLS = ["Path", "Risk", "Purpose"];
const TOP_LEVEL_RISK_COLUMN = 1;

const ENGINE_SRC_HEADING = "## engine/src — the engine workspace";
const ENGINE_SRC_HEADER_CELLS = ["Path", "Responsibility and important files"];

// The one Risk value that means "Git will never track this" — everything else documented
// under `## Top level` must resolve as a real tracked path.
const RUNTIME_RISK = "runtime";

export interface DocumentedRow {
  readonly path: string;
  readonly risk?: string;
}

export interface LayoutCheckResult {
  readonly missing: string[];
  readonly untracked: string[];
}

// ── Markdown table parsing ──────────────────────────────────────────────────────────────

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 1 && trimmed.startsWith("|") && trimmed.endsWith("|");
}

/** Trims the outer pipes and splits into trimmed cells. Header, separator, and body rows
 *  all go through this one function so "what counts as a cell" never diverges between them. */
function parseRowCells(line: string): string[] {
  const trimmed = line.trim();
  return trimmed
    .slice(1, -1)
    .split("|")
    .map((cell) => cell.trim());
}

// Only the cell-content shape (dashes/colons) — NOT whether the cell count matches the
// header above it. A separator's cell count can only be judged against a specific header, so
// that check lives in findFirstTable, where both rows are in hand.
function isSeparatorShapedRow(line: string): boolean {
  if (!isTableRow(line)) return false;
  const cells = parseRowCells(line);
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

/** The exact heading line to the next `## ` heading (or EOF) — never the whole file, so a
 *  same-shaped table living under a different heading elsewhere can't be picked up by mistake. */
function extractSection(lines: string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.trim() === heading);
  assert.ok(start >= 0, `heading ${JSON.stringify(heading)} not found in ${LAYOUT_DOC_PATH}`);
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i]!.startsWith("## ")) {
      end = i;
      break;
    }
  }
  return lines.slice(start + 1, end);
}

// Blanks out (preserving line count, so callers needn't re-index) fenced code blocks and HTML
// comments across the WHOLE file before section/table search — a table (or a heading) living
// inside either (e.g. commented out to "remove" it without deleting it) must be invisible to the
// parser, not accepted as real documentation or as a section boundary.
const HTML_COMMENT_RE = /<!--[\s\S]*?-->/g;

function blankMatch(match: string): string {
  return match.replace(/[^\n]/g, "");
}

// A fence opener is a line starting with 3+ backticks or 3+ tildes (optionally followed by an
// info string); it closes at the next line starting with the SAME character repeated at least
// as many times, per CommonMark. Line-based, not regex, so an UNCLOSED fence fails closed:
// every line through EOF is consumed and blanked by the same scan that never finds a closer,
// rather than a regex simply failing to match and leaving the "hidden" content searchable.
const FENCE_OPENER_RE = /^\s*([`~]{3,})/;

function matchFenceOpener(line: string): { char: string; length: number } | null {
  const match = FENCE_OPENER_RE.exec(line);
  if (!match) return null;
  const marker = match[1]!;
  return { char: marker[0]!, length: marker.length };
}

function isFenceCloser(line: string, char: string, minLength: number): boolean {
  const trimmed = line.trim();
  if (trimmed.length < minLength) return false;
  for (const ch of trimmed) {
    if (ch !== char) return false;
  }
  return true;
}

function stripFencedCodeBlocks(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const opener = matchFenceOpener(lines[i]!);
    if (!opener) {
      out.push(lines[i]!);
      i++;
      continue;
    }
    out.push(""); // the opener line is itself inside the fence
    i++;
    while (i < lines.length) {
      const candidate = lines[i]!;
      out.push("");
      i++;
      if (isFenceCloser(candidate, opener.char, opener.length)) break;
      // else: unclosed so far — keep consuming and blanking through EOF if no closer ever appears
    }
  }
  return out.join("\n");
}

function stripNonProseBlocks(text: string): string {
  return stripFencedCodeBlocks(text).replace(HTML_COMMENT_RE, blankMatch);
}

// A header row followed by a same-shaped separator of the WRONG cell count fails the parse
// outright — it does not skip past and keep scanning for some other candidate table, because a
// header/separator pair that disagree on column count is a malformed table, not a non-table.
function findFirstTable(sectionLines: string[]): { header: string[]; bodyLines: string[] } {
  for (let i = 0; i < sectionLines.length - 1; i++) {
    const headerLine = sectionLines[i]!;
    if (!isTableRow(headerLine)) continue;
    const separatorLine = sectionLines[i + 1]!;
    if (!isSeparatorShapedRow(separatorLine)) continue;
    const headerCells = parseRowCells(headerLine);
    const separatorCells = parseRowCells(separatorLine);
    assert.equal(
      separatorCells.length,
      headerCells.length,
      `separator row ${JSON.stringify(separatorLine)} has ${separatorCells.length} cells, expected ${headerCells.length} to match its header`,
    );
    const bodyLines: string[] = [];
    for (let j = i + 2; j < sectionLines.length; j++) {
      const bodyLine = sectionLines[j]!;
      if (!isTableRow(bodyLine)) break;
      bodyLines.push(bodyLine);
    }
    return { header: headerCells, bodyLines };
  }
  throw new Error("no Markdown table found in section");
}

// A Path cell must be exactly one code span — "the `engine/` directory" is prose that
// contains a code span, not a documented row, and must not be misread as one.
const CODE_SPAN_RE = /^`([^`]+)`$/;

function parsePathCell(cell: string): string {
  const match = CODE_SPAN_RE.exec(cell);
  assert.ok(match, `Path cell ${JSON.stringify(cell)} is not a single code span`);
  return match![1]!;
}

/** Parses one section's table into documented rows: exact header, exact cell count per row,
 *  Path-is-a-code-span, and no duplicate Path values. `riskColumn` names which cell (if any)
 *  becomes the row's preserved Risk value, for the top-level table's runtime exemption.
 *  `lines` must already be `stripNonProseBlocks`-ed — this function trusts its input and does
 *  not re-strip, since stripping has to run on the WHOLE file before section extraction (a
 *  heading hidden inside a fence/comment must not control section boundaries either). */
function parseDocumentedRows(heading: string, headerCells: string[], lines: string[], riskColumn?: number): DocumentedRow[] {
  const section = extractSection(lines, heading);
  const { header, bodyLines } = findFirstTable(section);
  assert.deepEqual(header, headerCells, `unexpected header cells under ${JSON.stringify(heading)}`);

  const rows: DocumentedRow[] = [];
  const seenPaths = new Set<string>();
  for (const line of bodyLines) {
    const cells = parseRowCells(line);
    assert.equal(
      cells.length,
      headerCells.length,
      `row ${JSON.stringify(line)} under ${JSON.stringify(heading)} does not have ${headerCells.length} cells`,
    );
    const path = parsePathCell(cells[0]!);
    assert.ok(!seenPaths.has(path), `duplicate Path ${JSON.stringify(path)} under ${JSON.stringify(heading)}`);
    seenPaths.add(path);
    rows.push(riskColumn === undefined ? { path } : { path, risk: cells[riskColumn]! });
  }
  return rows;
}

function parseTopLevelRows(content: string): DocumentedRow[] {
  const strippedLines = stripNonProseBlocks(content).split("\n");
  return parseDocumentedRows(TOP_LEVEL_HEADING, TOP_LEVEL_HEADER_CELLS, strippedLines, TOP_LEVEL_RISK_COLUMN);
}

function parseEngineSrcRows(content: string): DocumentedRow[] {
  const strippedLines = stripNonProseBlocks(content).split("\n");
  return parseDocumentedRows(ENGINE_SRC_HEADING, ENGINE_SRC_HEADER_CELLS, strippedLines);
}

// ── Git oracle ───────────────────────────────────────────────────────────────────────────

function gitDirectoryNames(revSpec: string): string[] {
  const stdout = execFileSync("git", ["ls-tree", "-d", "--name-only", revSpec], { cwd: REPO_ROOT, encoding: "utf8" });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function gitIsTracked(repoRelativePath: string): boolean {
  const stdout = execFileSync("git", ["ls-tree", "--name-only", "HEAD", "--", repoRelativePath], { cwd: REPO_ROOT, encoding: "utf8" });
  return stdout.trim().length > 0;
}

// ── Comparison oracle (pure — no Git, no filesystem) ────────────────────────────────────
//
// Factored out from both Git acquisition and Markdown parsing so the fixtures below can feed
// it documented rows, a known-directory set, and a trackedness predicate directly.

export function checkLayoutRows(
  documented: readonly DocumentedRow[],
  knownDirectories: readonly string[],
  isTracked: (repoRelativePath: string) => boolean,
  options: { pathPrefix?: string; riskExemption?: string } = {},
): LayoutCheckResult {
  const pathPrefix = options.pathPrefix ?? "";
  const documentedPaths = new Set(documented.map((row) => row.path));

  const missing = knownDirectories
    .map((dir) => `${dir}/`)
    .filter((dirRow) => !documentedPaths.has(dirRow))
    .sort();

  const untracked = documented
    .filter((row) => options.riskExemption === undefined || row.risk !== options.riskExemption)
    .filter((row) => !isTracked(`${pathPrefix}${row.path}`))
    .map((row) => row.path)
    .sort();

  return { missing, untracked };
}

// ── Live test ────────────────────────────────────────────────────────────────────────────

test("repository layout tables match tracked Git trees in both directions", () => {
  const content = readFileSync(LAYOUT_DOC_PATH, "utf8");
  const topLevelRows = parseTopLevelRows(content);
  const engineSrcRows = parseEngineSrcRows(content);

  const topLevelDirs = gitDirectoryNames("HEAD");
  const engineSrcDirs = gitDirectoryNames("HEAD:engine/src");

  const topLevel = checkLayoutRows(topLevelRows, topLevelDirs, gitIsTracked, { riskExemption: RUNTIME_RISK });
  assert.deepEqual(topLevel.missing, [], `top-level table is missing rows for tracked root directories: ${topLevel.missing.join(", ")}`);
  assert.deepEqual(topLevel.untracked, [], `top-level table documents untracked paths: ${topLevel.untracked.join(", ")}`);

  const engineSrc = checkLayoutRows(engineSrcRows, engineSrcDirs, gitIsTracked, { pathPrefix: "engine/src/" });
  assert.deepEqual(engineSrc.missing, [], `engine/src table is missing rows for tracked directories: ${engineSrc.missing.join(", ")}`);
  assert.deepEqual(engineSrc.untracked, [], `engine/src table documents untracked paths: ${engineSrc.untracked.join(", ")}`);
});

// ── Regression fixtures on the comparison oracle ────────────────────────────────────────

test("fixture: a known directory with no matching documented row is reported missing", () => {
  const documented: DocumentedRow[] = [{ path: "engine/", risk: "CORE" }];
  const result = checkLayoutRows(documented, ["engine", "scripts"], () => true);
  assert.deepEqual(result.missing, ["scripts/"]);
  assert.deepEqual(result.untracked, []);
});

test("fixture: a documented row Git reports as untracked is flagged", () => {
  const documented: DocumentedRow[] = [{ path: "ghost/", risk: "NORMAL" }];
  const result = checkLayoutRows(documented, [], () => false, { riskExemption: RUNTIME_RISK });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.untracked, ["ghost/"]);
});

test("fixture: an untracked row exempted by runtime Risk produces no error", () => {
  const documented: DocumentedRow[] = [{ path: ".sapwood/", risk: RUNTIME_RISK }];
  const result = checkLayoutRows(documented, [], () => false, { riskExemption: RUNTIME_RISK });
  assert.deepEqual(result.missing, []);
  assert.deepEqual(result.untracked, []);
});

test("fixture: a table hidden inside an HTML comment is invisible to the parser — fails as 'no table found', not a vacuous empty parse", () => {
  const heading = "## Fixture: commented-out table";
  const content = [
    heading,
    "",
    "<!--",
    "| Path | Risk | Purpose |",
    "| --- | --- | --- |",
    "| `ghost/` | NORMAL | should never be seen |",
    "-->",
    "",
    "## Next heading",
    "",
  ].join("\n");

  const strippedLines = stripNonProseBlocks(content).split("\n");
  assert.throws(
    () => parseDocumentedRows(heading, TOP_LEVEL_HEADER_CELLS, strippedLines, TOP_LEVEL_RISK_COLUMN),
    /no Markdown table found in section/,
  );
});

test("fixture: a table hidden inside a ~~~ fence is invisible to the parser — fails as 'no table found'", () => {
  const heading = "## Fixture: tilde-fenced table";
  const content = [
    heading,
    "",
    "~~~",
    "| Path | Risk | Purpose |",
    "| --- | --- | --- |",
    "| `ghost/` | NORMAL | should never be seen |",
    "~~~",
    "",
    "## Next heading",
    "",
  ].join("\n");

  const strippedLines = stripNonProseBlocks(content).split("\n");
  assert.throws(
    () => parseDocumentedRows(heading, TOP_LEVEL_HEADER_CELLS, strippedLines, TOP_LEVEL_RISK_COLUMN),
    /no Markdown table found in section/,
  );
});

test("fixture: a table after an unclosed ``` fence is treated as fenced through EOF (fail-closed) — fails as 'no table found'", () => {
  const heading = "## Fixture: unclosed-fence table";
  const content = [
    heading,
    "",
    "```",
    "some example that never closes",
    "",
    "| Path | Risk | Purpose |",
    "| --- | --- | --- |",
    "| `ghost/` | NORMAL | should never be seen |",
  ].join("\n");

  const strippedLines = stripNonProseBlocks(content).split("\n");
  assert.throws(
    () => parseDocumentedRows(heading, TOP_LEVEL_HEADER_CELLS, strippedLines, TOP_LEVEL_RISK_COLUMN),
    /no Markdown table found in section/,
  );
});

test("fixture: zero documented rows still fails the comparison against known directories — not a vacuous pass", () => {
  const result = checkLayoutRows([], ["engine"], () => true);
  assert.deepEqual(result.missing, ["engine/"]);
  assert.deepEqual(result.untracked, []);
});
