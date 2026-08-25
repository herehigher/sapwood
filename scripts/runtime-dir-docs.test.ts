// Doc-content test partition (docs/REVIEW-DOCTRINE.md): two oracles for the "one home" rule —
// docs/guide/configuration.md's "The `.sapwood/` runtime directory" section describes the
// engine's runtime layout, and nowhere else does.
//
// Oracle A (negative lint) scans docs/**/*.md, README.md, and CHANGELOG.md prose for a stale
// `data/`-rooted runtime path — the pre-rename name. Companion to
// engine/src/config/paths.test.ts's own source-side negative oracle, which covers engine/src
// and dashboard/src the same way this covers docs.
//
// Oracle B (cross-artifact) parses configuration.md's own fenced tree and diffs it against
// `runtimePaths()` (engine/src/config/paths.ts) directly, so the canonical doc cannot silently
// drift from the code that actually decides the layout.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runtimePaths } from "../engine/src/config/paths.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// ── Oracle A: no stale `data/`-rooted literal in doc prose ─────────────────────────────────
//
// Word-boundary aware, not a bare substring match: `(?<![A-Za-z0-9_])data/` excludes only a
// literal `data` immediately preceded by an identifier character (e.g. "metadata/body"), never
// a real path mention (which is always preceded by whitespace, punctuation, or a backtick).
// Fenced code blocks stay IN scope — a stale `touch data/KILL_SWITCH` example is exactly the
// kind of regression this oracle exists to catch. The one necessary exception is the CHANGELOG
// cutover checklist below, which names the OLD path as the deliberate FROM side of a migration.
const DATA_LITERAL_RE = /(?<![A-Za-z0-9_])data\//;

function isFenceDelimiter(line: string): boolean {
  return /^\s*```/.test(line);
}

// The ONLY fence exempted from the scan: matched by its own first content line, not by file or
// line number, so the exemption can't silently widen to swallow an unrelated block. This is the
// literal FROM side of the shipped cutover checklist (CHANGELOG.md) — the whole point of that
// block is to show the pre-rename path being moved away from, so it cannot itself be "fixed".
const CHANGELOG_CUTOVER_MARKER = "# engine stopped (pid gone, no sapwood.lock holder)";

/** Every `data/` offense line. Fenced code blocks are scanned like any other text, except the
 *  single fence whose first line is CHANGELOG_CUTOVER_MARKER (matched by content). */
function findOffenses(relPath: string, content: string): string[] {
  const offenders: string[] = [];
  const lines = content.split("\n");
  let inFence = false;
  let fenceExempt = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isFenceDelimiter(line)) {
      if (!inFence) {
        fenceExempt = lines[i + 1]?.trim() === CHANGELOG_CUTOVER_MARKER;
      } else {
        fenceExempt = false;
      }
      inFence = !inFence;
      continue;
    }
    if (inFence && fenceExempt) continue;
    if (DATA_LITERAL_RE.test(line)) offenders.push(`${relPath}:${i + 1}`);
  }
  return offenders;
}

/** docs/**\/*.md plus the repo-root README.md and CHANGELOG.md — every doc a stale runtime-path
 *  reference could hide in. No directory-level exclusion for docs/design/ or docs/research/:
 *  neither carries a README declaring itself a dated archive, so both are scanned like any
 *  other doc (the one stale reference found under docs/design/ was fixed directly). */
function listMarkdownFiles(): string[] {
  const out: string[] = [join(REPO_ROOT, "README.md"), join(REPO_ROOT, "CHANGELOG.md")];
  const docsRoot = join(REPO_ROOT, "docs");
  for (const entry of readdirSync(docsRoot, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? (entry as unknown as { path: string }).path;
    out.push(join(parent, entry.name));
  }
  return out;
}

test("no stale `data/`-rooted runtime-path literal remains in docs/**/*.md, README.md, or CHANGELOG.md", () => {
  const offenders: string[] = [];
  for (const file of listMarkdownFiles()) {
    const relPath = file.slice(REPO_ROOT.length + 1);
    offenders.push(...findOffenses(relPath, readFileSync(file, "utf8")));
  }
  assert.deepEqual(offenders, []);
});

test("positive fixture: 'workers have no `data/` mount' IS flagged", () => {
  const content = "line one\nState is writable only by the engine (workers have no `data/` mount).\n";
  assert.deepEqual(findOffenses("fixture.md", content), ["fixture.md:2"]);
});

test("positive fixture: a stale `data/sapwood.sqlite` reference IS flagged", () => {
  const content = "line one\nThe state DB path defaults to `data/sapwood.sqlite`.\n";
  assert.deepEqual(findOffenses("fixture.md", content), ["fixture.md:2"]);
});

test("positive fixture: every sentinel + cache sub-path family is individually caught", () => {
  const content = [
    "`data/KILL_SWITCH`",
    "`data/EMERGENCY_STOP`",
    "`data/PAUSE`",
    "`data/ESCALATION`",
    "`data/sessions/state/`",
    "`data/cache/review/clone.git`",
    "`data/DIRECTIVE.md`",
  ].join("\n");
  assert.equal(findOffenses("fixture.md", content).length, 7);
});

test("reverse test: a `.sapwood/`-rooted equivalent of every fixture above is NOT flagged", () => {
  const content = [
    "`.sapwood/KILL_SWITCH`",
    "`.sapwood/EMERGENCY_STOP`",
    "`.sapwood/PAUSE`",
    "`.sapwood/ESCALATION`",
    "`.sapwood/sessions/state/`",
    "`.sapwood/cache/review/clone.git`",
    "`.sapwood/DIRECTIVE.md`",
    "`.sapwood/sapwood.sqlite`",
  ].join("\n");
  assert.deepEqual(findOffenses("fixture.md", content), []);
});

test("reverse test: 'metadata/body' is NOT flagged (word-boundary, not bare substring)", () => {
  const content = "the metadata/body section-set match\n";
  assert.deepEqual(findOffenses("fixture.md", content), []);
});

test("positive fixture: a fenced `data/` literal outside the CHANGELOG cutover block IS flagged", () => {
  const content = ["```bash", "touch data/KILL_SWITCH", "```"].join("\n");
  assert.deepEqual(findOffenses("fixture.md", content), ["fixture.md:2"]);
});

test("reverse test: the CHANGELOG cutover checklist block (marker present) is NOT flagged, the same literal outside that block IS", () => {
  const checklist = ["some prose", "```", CHANGELOG_CUTOVER_MARKER, 'mv "data/sapwood.sqlite" .sapwood/', "```"].join("\n");
  assert.deepEqual(findOffenses("fixture.md", checklist), []);

  const prose = 'Move it with `mv "data/sapwood.sqlite" .sapwood/`.\n';
  assert.equal(findOffenses("fixture.md", prose).length, 1);
});

// ── Oracle B: configuration.md's tree cannot silently drift from runtimePaths() ─────────────

const HEADING = "## The `.sapwood/` runtime directory";

/** Every relative path `runtimePaths()` names, exactly as configuration.md's tree spells it —
 *  derived from the function itself, not a second hand-maintained list, so a path renamed or
 *  added in paths.ts is reflected here with no edit needed. */
function knownRuntimeRelativePaths(): Set<string> {
  const ROOT_TOKEN = "RUNTIME_DIR_DOCS_TEST_ROOT_TOKEN";
  const paths = runtimePaths(ROOT_TOKEN);
  const { root: _root, ...rest } = paths;
  const relPaths = new Set<string>();
  for (const value of Object.values(rest)) {
    assert.ok(value.startsWith(`${ROOT_TOKEN}${sep}`), `expected ${value} to be rooted under the token`);
    relPaths.add(
      value
        .slice(ROOT_TOKEN.length + 1)
        .split(sep)
        .join("/"),
    );
  }
  return relPaths;
}

/** The exact set of relative paths configuration.md's own fenced tree lists, parsed structurally
 *  (not by regex-over-the-whole-file): find the heading, take the first fenced block after it,
 *  drop the root line, and read each remaining line's path up to its `←` comment marker. */
function parseConfigurationTree(content: string): Set<string> {
  const lines = content.split("\n");
  const headingIndex = lines.findIndex((line) => line.trim() === HEADING);
  assert.ok(headingIndex >= 0, `heading "${HEADING}" not found in configuration.md`);
  const fenceStart = lines.findIndex((line, i) => i > headingIndex && /^\s*```\s*$/.test(line));
  assert.ok(fenceStart >= 0, "no fenced tree block found after the heading");
  const fenceEnd = lines.findIndex((line, i) => i > fenceStart && /^\s*```\s*$/.test(line));
  assert.ok(fenceEnd > fenceStart, "fenced tree block never closes");
  const treeLines = lines.slice(fenceStart + 1, fenceEnd).filter((line) => line.trim().length > 0);
  assert.equal(treeLines[0]!.split("←")[0]!.trim(), ".sapwood/", "tree's first line must be the root");
  const paths = new Set<string>();
  for (const line of treeLines.slice(1)) {
    const path = line.split("←")[0]!.trim();
    assert.ok(path.length > 0, `blank path parsed from tree line: ${JSON.stringify(line)}`);
    paths.add(path);
  }
  return paths;
}

/** The actual set-comparison oracle: which `runtimePaths()` entries the documented tree omits,
 *  and which documented entries have no matching `runtimePaths()` field. Factored out so the
 *  reverse test below exercises this comparison directly, not just the tree parser. */
function compareRuntimePaths(documented: Set<string>, known: Set<string>): { missingFromDoc: string[]; extraInDoc: string[] } {
  return {
    missingFromDoc: [...known].filter((p) => !documented.has(p)),
    extraInDoc: [...documented].filter((p) => !known.has(p)),
  };
}

test("configuration.md's runtime-directory tree matches runtimePaths() exactly, both directions", () => {
  const known = knownRuntimeRelativePaths();
  assert.ok(known.size > 10, "sanity: runtimePaths() should name well over 10 sub-paths");
  const content = readFileSync(join(REPO_ROOT, "docs", "guide", "configuration.md"), "utf8");
  const documented = parseConfigurationTree(content);

  const { missingFromDoc, extraInDoc } = compareRuntimePaths(documented, known);
  assert.deepEqual(missingFromDoc, [], "runtimePaths() entries missing from the documented tree");
  assert.deepEqual(extraInDoc, [], "documented tree entries with no matching runtimePaths() field");
});

test("reverse test: the set-comparison oracle catches both a missing and an extra path", () => {
  const known = knownRuntimeRelativePaths();
  const knownArr = [...known];
  const omitted = knownArr[0];
  assert.ok(omitted, "sanity: runtimePaths() names at least one path");
  const treeLines = [".sapwood/", ...knownArr.slice(1), "bogus-entry"];
  const content = `${HEADING}\n\n\`\`\`\n${treeLines.join("\n")}\n\`\`\`\n`;

  const documented = parseConfigurationTree(content);
  const { missingFromDoc, extraInDoc } = compareRuntimePaths(documented, known);
  assert.deepEqual(missingFromDoc, [omitted], "the omitted runtimePaths() entry must be reported missing");
  assert.deepEqual(extraInDoc, ["bogus-entry"], "the synthetic unknown entry must be reported extra");
});
