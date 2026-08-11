// #731 PM gate② finding: the PR's own CI must prove
// docs/patches/731-guard-stop-control-verbs.patch applies cleanly to CURRENT main, without a
// human ever running the apply themselves first. The patch's target files (guard.ts/
// guard.test.ts) are human-merge-only — this repo's worker/producer role can never apply it,
// only ship it — so the ONLY channel this PR has to prove apply-cleanliness is a real `git apply
// --check` run against the checked-out tree, exactly as a human applying the patch would run it.
// This file is a plain new test (not a guard.ts/guard-hook.ts/guard.test.ts edit), so it is NOT
// itself human-merge-only — see docs/security.md "Human-merge-only paths" for the canonical
// protected-path list this file is deliberately outside of. Mirrors
// docs/patches/679-guard-default-branch-push.patch's own apply-check test (#679).
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const PATCH_RELATIVE_PATH = "docs/patches/731-guard-stop-control-verbs.patch";

/** Repo root, resolved via `git rev-parse` from this file's own directory — robust to this file
 *  moving, unlike a hardcoded `join(dir, "..", "..", "..")` chain. */
function repoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: here, encoding: "utf8" }).trim();
}

test("#731 PM gate②: docs/patches/731-guard-stop-control-verbs.patch applies cleanly to the current tree (git apply --check)", () => {
  const root = repoRoot();
  const patchPath = join(root, PATCH_RELATIVE_PATH);
  assert.ok(existsSync(patchPath), `patch file must exist at ${PATCH_RELATIVE_PATH}`);
  // Throws (non-zero exit) on a failed check — node:test fails the test on an uncaught throw,
  // which is exactly the signal a stale/conflicting patch must produce here.
  execFileSync("git", ["apply", "--check", PATCH_RELATIVE_PATH], { cwd: root, stdio: "pipe" });
});
