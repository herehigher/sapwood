// doctrine.test.ts (#167): loadDoctrine — absent file -> explicit NO_DOCTRINE placeholder
// (never an error, unlike worker.promptFile); present -> content, bounded/truncated
// deterministically via retro-digest.ts's capDigest, with a marked truncation.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadDoctrine, NO_DOCTRINE } from "./doctrine.js";

test("loadDoctrine: a missing file returns the explicit NO_DOCTRINE placeholder, never an error", () => {
  const result = loadDoctrine("/nonexistent/REVIEW-DOCTRINE.md", 1000);
  assert.equal(result, NO_DOCTRINE);
  assert.match(result, /no review doctrine|none/i);
});

test("loadDoctrine: a present file under the cap returns its content verbatim", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    const content = "# Review doctrine\n\nSome invariant text.\n";
    writeFileSync(path, content);
    assert.equal(loadDoctrine(path, 10_000), content);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDoctrine: content over maxChars is deterministically truncated with a marked cut, never a silent drop", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    const content = "x".repeat(5000);
    writeFileSync(path, content);
    const result = loadDoctrine(path, 100);
    assert.ok(result.length <= 100, `expected result to respect the 100-char cap, got ${result.length}`);
    assert.match(result, /truncated/i);
    // Deterministic: same content + same cap -> byte-for-byte same output.
    assert.equal(result, loadDoctrine(path, 100));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDoctrine: an empty file (exists, zero bytes) is NOT treated as absent — returns empty content, not NO_DOCTRINE", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    writeFileSync(path, "");
    assert.equal(loadDoctrine(path, 1000), "");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
