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

test("#838: the loaded doctrine contains the authoritative-signals-over-inferred-text invariant, traceable to classifyEnvFailure/DEFAULT_LLM_FAILURE_PATTERNS (symbol citation, not a line-range — #838 de-rotted the stale env-failure.ts:31-91 range)", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.match(loaded, /Authoritative signals over inferred text/);
  // Traceable to the source file this invariant was distilled from, by SYMBOL rather than a line
  // range that rots the moment the file grows (#838): classifyEnvFailure is the structured-
  // signals-first function, DEFAULT_LLM_FAILURE_PATTERNS is the enumerated fallback list.
  assert.ok(loaded.includes("classifyEnvFailure"), "expected a citation to classifyEnvFailure");
  assert.ok(loaded.includes("engine/src/loop/env-failure.ts"), "expected a citation to engine/src/loop/env-failure.ts");
  assert.ok(loaded.includes("DEFAULT_LLM_FAILURE_PATTERNS"), "expected a citation to DEFAULT_LLM_FAILURE_PATTERNS");
  // The false-positive-vs-false-negative asymmetry this file's own comments name explicitly.
  assert.match(loaded, /false\s+NEGATIVE/);
  assert.match(loaded, /false\s+POSITIVE/);
  // The contract-internal-format exemption (a self-produced, fail-closed-parsed format counts as
  // authoritative even though it's serialized as text).
  assert.match(loaded, /contracts, not text matching/i);
  // The residual blind spot, stated honestly rather than overclaiming full coverage.
  assert.match(loaded, /residual blind spot|genuinely narrow gap/i);
});

// #419 review round 2 (Codex sol high, P2-1): the ORIGINAL wording here called a missed
// classification "bounded and recoverable" on its own — false against env-failure.ts's
// DEFAULT_LLM_FAILURE_PATTERNS-comment accounting, which states a WORKER-lane miss is bounded by
// nothing in that file (it can recur on every subsequently dispatched issue); only the engine's
// own outer cost ceiling bounds it. These assertions pin the corrected claim so a future edit
// can't silently reintroduce the overclaim. #838 de-rotted the stale env-failure.ts:93-104
// line-range citation to a symbol citation (same DEFAULT_LLM_FAILURE_PATTERNS symbol the
// preceding invariant already cites, since that's where this accounting actually lives).
test("#838: the authoritative-signals invariant names the OUTER safety ceiling (not local boundedness) as what actually bounds a recurring worker-lane miss, traceable to DEFAULT_LLM_FAILURE_PATTERNS's own accounting (symbol citation, not a line-range)", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.ok(
    loaded.includes("DEFAULT_LLM_FAILURE_PATTERNS`'s own accounting"),
    "expected the peripheral-vs-worker-lane citation to reference DEFAULT_LLM_FAILURE_PATTERNS's own accounting",
  );
  assert.match(loaded, /OUTER safety ceiling/);
  assert.ok(loaded.includes("cost.roundBudgetUsd"), "expected a citation to the cost.roundBudgetUsd config key");
  // The overclaim this review round retracted: must NOT appear anywhere in the loaded text.
  assert.doesNotMatch(loaded, /bounded and recoverable/i);
});

test("#411: the loaded doctrine contains the no-timing-dependent-assertions invariant, citing #403 and #416", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.match(loaded, /No timing-dependent assertions/);
  assert.match(loaded, /real timer|subprocess speed|scheduler/i);
  assert.ok(loaded.includes("#403"), "expected a citation to #403");
  assert.ok(loaded.includes("#416"), "expected a citation to #416");
  assert.ok(loaded.includes("#418"), "expected a citation to PR #418 (the canonical fix shape)");
});

// #419 review round 2 (Codex sol high, P2-2): the ORIGINAL wording banned ANY dependence on a
// real timer/subprocess/scheduler, which is broader than the actual lesson and would condemn
// this repo's own accepted practice (materializer.test.ts's real hang-guards + bounded real-git
// passthroughs, and #418 round 3's own documented, non-load-bearing REAL_OP_TIMEOUT_MS widen).
// Refined to distinguish a BANNED load-bearing race from a FINE outer guard / documented margin,
// citing #418's margin-ordering pattern as the worked example. Pinned so a future edit can't
// silently regress to the overbroad version.
test("#419 review: the timing invariant distinguishes a BANNED load-bearing race from a FINE outer hang-guard / documented non-load-bearing margin, citing #418's margin-ordering pattern", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.match(loaded, /BANNED/);
  assert.match(loaded, /FINE/);
  assert.match(loaded, /LOAD-BEARING/);
  assert.ok(loaded.includes("REAL_OP_TIMEOUT_MS"), "expected a citation to REAL_OP_TIMEOUT_MS (the #418 round 3 margin-ordering example)");
  assert.ok(loaded.includes("500ms"), "expected the concrete before/after margin values from #418 round 3");
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

// #838 (gate② round 1 owner adjudication): the header's own curation rule ("above ~85% of
// doctrine.maxChars, an addition must evict or merge at least as much as it adds") must not
// itself get silently evicted by a future edit that's optimizing for char budget — pin its
// distinctive "one-in-one-out" substring so a compaction pass that drops the rule fails loudly.
test("#838: the header's curation rule (one-in-one-out budget discipline) is present, never silently evicted", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.ok(loaded.includes("one-in-one-out"), "expected the curation rule's 'one-in-one-out' substring in the loaded doctrine text");
});
