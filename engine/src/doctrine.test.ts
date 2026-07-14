// doctrine.test.ts (#167): loadDoctrine — absent file -> explicit NO_DOCTRINE placeholder
// (never an error, unlike worker.promptFile); present -> content, bounded/truncated
// deterministically via retro-digest.ts's capDigest, with a marked truncation. Present-but-
// unreadable is its own third branch (#167 review, Codex P2) — split from "absent" and now
// fail-fast, matching worker.ts's loadWorkerPromptTemplate contract.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

test("loadDoctrine: a PRESENT-but-unreadable path (a directory, not a file) throws naming the path — never degrades to NO_DOCTRINE (#167 review P2)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    mkdirSync(path); // exists at the configured path, but readFileSync on a directory throws EISDIR
    assert.throws(() => loadDoctrine(path, 1000), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /present but unreadable/i);
      assert.ok(err.message.includes(path), `expected error to name the path ${path}, got: ${err.message}`);
      return true;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
