import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { appendAttentionDismissal, readAttentionDismissalIds } from "./attention-dismissals.ts";

test("append repairs an unterminated JSONL tail before adding a dismissal", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-attention-dismissals-"));
  const path = join(dir, "attention-dismissals.jsonl");
  try {
    writeFileSync(path, '{"eventId":1,"kind":"park-escalated","ts":"2026-08-20T00:00:00.000Z"}', "utf8");
    appendAttentionDismissal(path, 2, "run-escalated", new Date("2026-08-20T00:00:01.000Z"));
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0]!).eventId, 1);
    assert.equal(JSON.parse(lines[1]!).eventId, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dismissal reads swallow only a missing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-attention-dismissals-"));
  try {
    assert.deepEqual(readAttentionDismissalIds(join(dir, "missing.jsonl")), []);
    const directoryPath = join(dir, "a-directory");
    // A directory produces EISDIR on read; it is an I/O failure, not an empty dismissal file.
    awaitableWriteDirectory(directoryPath);
    assert.throws(() => readAttentionDismissalIds(directoryPath));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function awaitableWriteDirectory(path: string): void {
  // Keep the setup synchronous so the test exercises the same synchronous reader as the server.
  mkdirSync(path);
}
