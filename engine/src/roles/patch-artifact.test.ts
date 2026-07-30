// Guard for the human-apply patch artifacts under docs/patches/.
//
// Some issues (#378 is the first) split their delivery: the non-protected half ships as a normal
// PR, and the half that would touch a human-merge-only path (reviewer.ts / merge-driver.ts, see
// PROTECTED_SUFFIXES in guard.ts) ships as a paste-ready unified diff for a human to apply. That
// diff then SITS IN THE TREE, unapplied, until someone gets to it — and every commit that lands on
// its target files in the meantime can silently rot it, turning "paste-ready" into a merge puzzle
// discovered only at apply time.
//
// This makes "the patch still applies" a machine-checked fact rather than the producing worker's
// self-report (engine-agent review of PR #445 flagged exactly that gap). It verifies the context
// the patch expects still matches the real files, WITHOUT shelling out to `git apply`: no
// subprocess, no git dependency, no reliance on cwd being a work tree.
//
// Scope note: this proves the diff would apply, NOT that the suite passes afterward. That second
// half is genuinely unverifiable until a human applies the patch — see the patch header's own
// reproduction recipe.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "../../..");
const PATCH_DIR = join(REPO_ROOT, "docs/patches");

/** One file's worth of a unified diff: the target path plus each hunk's expected ORIGINAL lines
 *  and the 1-based line they must start at. Leading prose before the first `--- a/` is skipped,
 *  which is what lets these patches carry a human-facing header. */
interface PatchHunk {
  path: string;
  oldStart: number;
  before: string[];
}

function parseUnifiedDiff(patch: string): PatchHunk[] {
  const lines = patch.split("\n");
  const hunks: PatchHunk[] = [];
  let path: string | null = null;
  // A hunk ends when it has consumed the ORIGINAL-side line count its own `@@` header declares —
  // never when some line "looks like" the end. Guessing is what an undecorated empty context line
  // (which some diff implementations emit as "" rather than " ") makes unreliable, and the file's
  // own trailing newline is indistinguishable from one.
  let current: { hunk: PatchHunk; remaining: number } | null = null;
  for (const line of lines) {
    if (current && current.remaining === 0) current = null;
    if (!current) {
      const fileHeader = /^--- a\/(.+)$/.exec(line);
      if (fileHeader) {
        path = fileHeader[1]!;
        continue;
      }
      const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
      if (!hunkHeader) continue; // header prose, `+++` line, or trailing text — all ignorable
      assert.ok(path, `hunk header before any file header: ${line}`);
      const hunk: PatchHunk = { path, oldStart: Number(hunkHeader[1]), before: [] };
      hunks.push(hunk);
      current = { hunk, remaining: hunkHeader[2] === undefined ? 1 : Number(hunkHeader[2]) };
      continue;
    }
    if (line.startsWith("\\")) continue; // "\ No newline at end of file" — not a line of content
    if (line.startsWith("+")) continue; // added lines don't exist in the original
    // Context (" ") and removed ("-") lines both exist in the original. A bare "" is an empty
    // context line an implementation chose not to pad.
    current.hunk.before.push(line === "" ? "" : line.slice(1));
    current.remaining--;
  }
  return hunks;
}

const patchFiles = readdirSync(PATCH_DIR).filter((f) => f.endsWith(".patch"));

test("docs/patches: at least one human-apply patch artifact is present and parseable", () => {
  // A zero-patch directory would make every assertion below vacuously true. If the last patch is
  // ever applied and removed, delete this file with it rather than leaving a green no-op.
  assert.ok(patchFiles.length > 0, "no .patch files found under docs/patches");
});

for (const file of patchFiles) {
  test(`docs/patches/${file}: still applies — every hunk's expected context matches the real file`, () => {
    const hunks = parseUnifiedDiff(readFileSync(join(PATCH_DIR, file), "utf8"));
    assert.ok(hunks.length > 0, `${file} parsed to zero hunks — malformed or not a unified diff`);
    const cache = new Map<string, string[]>();
    for (const hunk of hunks) {
      let target = cache.get(hunk.path);
      if (!target) {
        target = readFileSync(join(REPO_ROOT, hunk.path), "utf8").split("\n");
        cache.set(hunk.path, target);
      }
      const actual = target.slice(hunk.oldStart - 1, hunk.oldStart - 1 + hunk.before.length);
      assert.deepEqual(
        actual,
        hunk.before,
        `${file} no longer applies: ${hunk.path} changed under the hunk at line ${hunk.oldStart}. ` +
          `Regenerate the patch against the current file before a human tries to apply it.`,
      );
    }
  });
}
