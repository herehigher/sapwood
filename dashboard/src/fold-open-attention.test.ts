import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
// #933's own cross-package import direction (dashboard -> engine), same as fold-open-attention.ts.
import { State } from "../../engine/src/state/state.ts";
import { toDomainEvent } from "./domain-event.ts";
import { countOpenAttention, foldOpenAttentionForProbe, REPO_ROOT_DEFAULT_DB_PATH } from "./fold-open-attention.ts";

// PR #937 gate② finding [1]: `npm run fold-open-attention -w dashboard` runs with cwd set to
// `dashboard/`, so a bare `DEFAULT_DB_PATH` (".sapwood/sapwood.sqlite", cwd-relative) would
// resolve to `dashboard/.sapwood/sapwood.sqlite` — a different file from the repository-root
// ledger the operator means to inspect. `engine/` is a sibling of `.sapwood/`'s parent ONLY at
// the true repository root (dashboard/ has no `engine/` child at all), so resolving
// `engine/package.json` relative to the computed root is a real filesystem check, not a
// re-assertion of the same string arithmetic the fix performs — it fails exactly the way the
// pre-fix bug would fail.
test("REPO_ROOT_DEFAULT_DB_PATH resolves to the repository root's .sapwood/sapwood.sqlite, independent of invocation cwd", () => {
  assert.ok(REPO_ROOT_DEFAULT_DB_PATH.endsWith(`${join(".sapwood", "sapwood.sqlite")}`));
  const resolvedRoot = dirname(dirname(REPO_ROOT_DEFAULT_DB_PATH));
  assert.ok(
    existsSync(join(resolvedRoot, "engine", "package.json")),
    `expected ${resolvedRoot} to be the repository root (engine/package.json missing) — the ` +
      `pre-fix bug resolved to dashboard/.sapwood/sapwood.sqlite instead, which has no engine/ sibling`,
  );
  assert.ok(
    !REPO_ROOT_DEFAULT_DB_PATH.includes(join("dashboard", ".sapwood")),
    "must never resolve inside dashboard/.sapwood — the cwd-relative bug",
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

// #1077 (AC2): no `dismissalsPath` override injected — proves countOpenAttention's own default
// (`join(dirname(dbPath), ATTENTION_DISMISSALS_FILE)`) actually resolves beside an injected
// custom-root dbPath (a wrong default would leave the real open row uncounted-as-dismissed,
// i.e. openCount would stay 1), not merely that an explicit override is respected (the fixture
// above).
test("countOpenAttention: default dismissalsPath resolves beside an injected custom-root dbPath", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-fold-attention-defaultdir-"));
  try {
    const dbPath = join(dir, "sapwood.sqlite");
    const seed = new State(dbPath);
    seed.appendEvent("park-escalated", { source: "llm" });
    seed.close();
    writeFileSync(
      join(dir, "attention-dismissals.jsonl"),
      '{"eventId":1,"kind":"park-escalated","ts":"2026-08-20T00:00:00.000Z"}\n',
      "utf8",
    );
    const { openCount } = countOpenAttention(dbPath);
    assert.equal(openCount, 0, "the co-located dismissal was found via the default dismissalsPath, so the row is not open");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
