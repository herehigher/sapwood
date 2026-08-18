// doctrine.test.ts (#167): loadDoctrine — absent file -> explicit NO_DOCTRINE placeholder
// (never an error, unlike worker.promptFile); present -> content, bounded/truncated
// deterministically via retro-digest.ts's capDigest, with a marked truncation. Present-but-
// unreadable is its own third branch (#167 review, Codex P2) — split from "absent" and now
// fail-fast, matching worker.ts's loadWorkerPromptTemplate contract.
//
// #411: also proves the CHANNEL is actually turned on for THIS repo — #167 shipped the
// mechanism, but sapwood.config.yaml's doctrine block sat commented out (defaulting to a path,
// docs/REVIEW-DOCTRINE.md, that didn't exist) until #411, so every real dispatch/architect/
// gated-reentry render silently took the NO_DOCTRINE placeholder path. loadDoctrine's own units
// above already cover the mechanism; this section is an end-to-end check against this repo's
// actual sapwood.config.yaml + docs/REVIEW-DOCTRINE.md, the pair loadDoctrine's unit tests can't
// see (they only ever construct throwaway fixture files/dirs).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { loadDoctrine, NO_DOCTRINE } from "./doctrine.js";

// engine/src/config/doctrine.test.ts -> three levels up is the repo root (same pattern as
// guard.fuzz.test.ts's/init.test.ts's own repoRoot constants).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_CONFIG_PATH = join(REPO_ROOT, "sapwood.config.yaml");

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
    assert.throws(
      () => loadDoctrine(path, 1000),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.match(err.message, /present but unreadable/i);
        assert.ok(err.message.includes(path), `expected error to name the path ${path}, got: ${err.message}`);
        return true;
      },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #411: the channel actually turned on for THIS repo ──────────────────────────────────────
// Loads sapwood.config.yaml + docs/REVIEW-DOCTRINE.md exactly as the real worker/architect
// renderers do (loadConfig resolves doctrine.file to an absolute, config-file-relative path;
// loadDoctrine reads + caps it) — no fixture, the actual repo files. Before #411 this test fails
// on `main`: doctrine.file falls back to its default (docs/REVIEW-DOCTRINE.md), that file didn't
// exist, and loadDoctrine took the NO_DOCTRINE placeholder branch instead of loading real content.

test("#411: this repo's own sapwood.config.yaml resolves doctrine.file and loads NON-EMPTY, non-placeholder content (fails on main before #411 — the file didn't exist)", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.notEqual(loaded, NO_DOCTRINE, "expected real doctrine content, not the 'no doctrine available' placeholder");
  assert.ok(loaded.length > 0, "expected non-empty doctrine content");
});

// #419 review round 2 (Codex sol high, P2-1): the ORIGINAL wording here called a missed
// classification "bounded and recoverable" on its own — false against env-failure.ts's
// DEFAULT_LLM_FAILURE_PATTERNS-comment accounting, which states a WORKER-lane miss is bounded by
// nothing in that file (it can recur on every subsequently dispatched issue); only the engine's
// own outer cost ceiling bounds it. The retracted overclaim must never silently return — a
// negative lint over the banned class (PROSE-PIN's own positive half was deleted: #963).
test("#419: the loaded doctrine never reintroduces the retracted 'bounded and recoverable' overclaim for a worker-lane env-failure miss", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.doesNotMatch(loaded, /bounded and recoverable/i);
});

test("#411: the loaded doctrine is comfortably under doctrine.maxChars with NO truncation marker (not silently cut)", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.ok(
    loaded.length < cfg.doctrine.maxChars,
    `expected content (${loaded.length} chars) to be under maxChars (${cfg.doctrine.maxChars})`,
  );
  // #419 review round 2 (Codex sol high, P3): a bare /truncated/i regex would false-fail CI the
  // moment legitimate doctrine prose ever contains the word "truncated" (this file already
  // discusses truncation in prose, e.g. the no-timing-dependent-assertions invariant's own
  // wording could evolve to mention it). Pin the EXACT marker capDigest emits instead
  // (retro-digest.ts's `capDigest`) — no other string in this file's prose can accidentally match it.
  assert.ok(!loaded.includes("[... digest truncated:"), "expected no capDigest truncation marker in the loaded doctrine text");
});
