import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { toDomainEvent } from "./domain-event.ts";
import { foldOpenAttentionForProbe, REPO_ROOT_DEFAULT_DB_PATH } from "./fold-open-attention.ts";

// PR #937 gate② finding [1]: `npm run fold-open-attention -w dashboard` runs with cwd set to
// `dashboard/`, so a bare `DEFAULT_DB_PATH` ("data/sapwood.sqlite", cwd-relative) would resolve
// to `dashboard/data/sapwood.sqlite` — a different file from the repository-root ledger the
// operator means to inspect. `engine/` is a sibling of `data/`'s parent ONLY at the true
// repository root (dashboard/ has no `engine/` child at all), so resolving `engine/package.json`
// relative to the computed root is a real filesystem check, not a re-assertion of the same
// string arithmetic the fix performs — it fails exactly the way the pre-fix bug would fail.
test("REPO_ROOT_DEFAULT_DB_PATH resolves to the repository root's data/sapwood.sqlite, independent of invocation cwd", () => {
  assert.ok(REPO_ROOT_DEFAULT_DB_PATH.endsWith(`${join("data", "sapwood.sqlite")}`));
  const resolvedRoot = dirname(dirname(REPO_ROOT_DEFAULT_DB_PATH));
  assert.ok(
    existsSync(join(resolvedRoot, "engine", "package.json")),
    `expected ${resolvedRoot} to be the repository root (engine/package.json missing) — the ` +
      `pre-fix bug resolved to dashboard/data/sapwood.sqlite instead, which has no engine/ sibling`,
  );
  assert.ok(
    !REPO_ROOT_DEFAULT_DB_PATH.includes(join("dashboard", "data")),
    "must never resolve inside dashboard/data — the cwd-relative bug",
  );
});

test("the CLI probe applies the operator dismissal file through the shared fold helper", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fold-attention-"));
  const dismissalsPath = join(dir, "attention-dismissals.jsonl");
  try {
    writeFileSync(dismissalsPath, '{"eventId":1,"kind":"park-escalated","ts":"2026-08-20T00:00:00.000Z"}\n', "utf8");
    const events = [toDomainEvent({ id: 1, ts: "2026-08-20T00:00:00.000Z", kind: "park-escalated", payload: { source: "llm" } })];
    assert.deepEqual(foldOpenAttentionForProbe(events, dismissalsPath), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
