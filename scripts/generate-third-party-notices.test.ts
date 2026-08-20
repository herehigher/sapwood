import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { packageLegalTexts } from "../engine/scripts/generate-third-party-notices.ts";

test("packageLegalTexts: collects every legal file in deterministic name order and deduplicates identical text", () => {
  const packageRoot = mkdtempSync(join(tmpdir(), "sapwood-notice-files-"));
  try {
    writeFileSync(join(packageRoot, "NOTICE"), "notice\n");
    writeFileSync(join(packageRoot, "LICENSE"), "license\n");
    writeFileSync(join(packageRoot, "COPYING"), "license\n");
    assert.deepEqual(packageLegalTexts(packageRoot), ["license", "notice"]);
  } finally {
    rmSync(packageRoot, { recursive: true, force: true });
  }
});
