// doctrine.test.ts (#167, repartitioned #1123 PR-2): loadDoctrine — core + repo part, always
// present (never an "absent doctrine" state — the old whole-composition placeholder is retired).
// Missing repo file ->
// core + explicit NO_REPO_DOCTRINE placeholder; present -> core + content, bounded/truncated
// deterministically via retro-digest.ts's capDigest, with a marked truncation. Present-but-
// unreadable is its own fail-fast branch, matching worker.ts's loadWorkerPromptTemplate contract.
//
// #411: also proves the CHANNEL is actually turned on for THIS repo — #167 shipped the
// mechanism, but sapwood.config.yaml's doctrine block sat commented out (defaulting to a path,
// docs/REVIEW-DOCTRINE.md, that didn't exist) until #411, so every real dispatch/architect/
// gated-reentry render silently took the placeholder path. loadDoctrine's own units above already
// cover the mechanism; this section is an end-to-end check against this repo's actual
// sapwood.config.yaml + docs/REVIEW-DOCTRINE.md, the pair loadDoctrine's unit tests can't see
// (they only ever construct throwaway fixture files/dirs).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { defaultDoctrineCorePath, loadDoctrine, NO_REPO_DOCTRINE } from "./doctrine.js";

// engine/src/config/doctrine.test.ts -> three levels up is the repo root (same pattern as
// guard.fuzz.test.ts's/init.test.ts's own repoRoot constants).
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_CONFIG_PATH = join(REPO_ROOT, "sapwood.config.yaml");

const CORE_TEXT = readFileSync(defaultDoctrineCorePath(), "utf8");

test("loadDoctrine: a missing repo file -> core + the explicit NO_REPO_DOCTRINE placeholder, never an error", () => {
  const result = loadDoctrine("/nonexistent/REVIEW-DOCTRINE.md", 1000);
  assert.equal(result, `${CORE_TEXT}\n\n${NO_REPO_DOCTRINE}`);
  assert.match(result, /has not adopted a repo-level review doctrine file/i);
});

test("loadDoctrine: a present repo file under the cap -> core + its content verbatim", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    const content = "# Review doctrine\n\nSome invariant text.\n";
    writeFileSync(path, content);
    assert.equal(loadDoctrine(path, 10_000), `${CORE_TEXT}\n\n${content}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDoctrine: repo content over maxChars is deterministically truncated with a marked cut, never a silent drop — the cap bounds the repo part only", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    const content = "x".repeat(5000);
    writeFileSync(path, content);
    const result = loadDoctrine(path, 100);
    assert.ok(result.startsWith(`${CORE_TEXT}\n\n`), "the core is never truncated by the repo-part cap");
    const repoPart = result.slice(`${CORE_TEXT}\n\n`.length);
    assert.ok(repoPart.length <= 100, `expected the repo part to respect the 100-char cap, got ${repoPart.length}`);
    assert.match(repoPart, /truncated/i);
    // Deterministic: same content + same cap -> byte-for-byte same output.
    assert.equal(result, loadDoctrine(path, 100));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── #830: HTML comments in the repo doctrine file must never reach the composed prompt text ────

test("loadDoctrine: strips an HTML comment shaped like doctrine-template.md's leading header from the repo part, leaving the plain-prose control content intact", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    const content = [
      "<!--",
      "  sapwood review doctrine — this repository's own review knowledge, read by the worker",
      "  dispatch brief. Configured as `doctrine.file` in sapwood.config.yaml (default:",
      "  docs/REVIEW-DOCTRINE.md).",
      "-->",
      "",
      "# Review doctrine",
      "",
      "REAL_INVARIANT_CONTROL_LINE",
    ].join("\n");
    writeFileSync(path, content);
    const result = loadDoctrine(path, 10_000);
    assert.ok(!result.includes("<!--"), "the HTML comment must be stripped from the composed doctrine text");
    assert.ok(!result.includes("Configured as `doctrine.file`"), "the comment's config-key sentence must not reach the prompt");
    assert.ok(result.includes("# Review doctrine"), "plain-prose heading survives the strip");
    assert.ok(result.includes("REAL_INVARIANT_CONTROL_LINE"), "plain-prose control content survives the strip");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDoctrine: an empty repo file (exists, zero bytes) is NOT treated as absent — core + empty repo part, never NO_REPO_DOCTRINE", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-doctrine-"));
  try {
    const path = join(dir, "REVIEW-DOCTRINE.md");
    writeFileSync(path, "");
    assert.equal(loadDoctrine(path, 1000), `${CORE_TEXT}\n\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDoctrine: a PRESENT-but-unreadable repo path (a directory, not a file) throws naming the path — never degrades to a placeholder", () => {
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

test("loadDoctrine: a missing shipped core throws naming the path — never degrades to a placeholder", () => {
  // `corePath`'s default resolves the real, shared, installed core (defaultDoctrineCorePath()) —
  // moving/deleting THAT would race every other concurrently running suite that also calls
  // loadDoctrine. Passing an explicit nonexistent corePath exercises the same guard without
  // touching the shared file.
  const missingCorePath = "/nonexistent/doctrine-core.md";
  assert.throws(
    () => loadDoctrine("/nonexistent/REVIEW-DOCTRINE.md", 1000, missingCorePath),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(err.message.includes(missingCorePath), `expected error to name the path ${missingCorePath}, got: ${err.message}`);
      return true;
    },
  );
});

test("doctrine-core.md: measures <= 8000 chars, the release-controlled ceiling (a CI test, not config)", () => {
  assert.ok(CORE_TEXT.length <= 8000, `expected the core to be <= 8000 chars, got ${CORE_TEXT.length}`);
});

// ── #411: the channel actually turned on for THIS repo ──────────────────────────────────────
// Loads sapwood.config.yaml + docs/REVIEW-DOCTRINE.md exactly as the real worker/architect
// renderers do (loadConfig resolves doctrine.file to an absolute, config-file-relative path;
// loadDoctrine reads + caps it) — no fixture, the actual repo files. Before #411 this test fails
// on `main`: doctrine.file falls back to its default (docs/REVIEW-DOCTRINE.md), that file didn't
// exist, and loadDoctrine took the placeholder branch instead of loading real content.

test("#411: this repo's own sapwood.config.yaml resolves doctrine.file and loads NON-EMPTY repo content, not the placeholder", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.doesNotMatch(
    loaded,
    /has not adopted a repo-level review doctrine file/i,
    "expected real repo doctrine content, not the absent placeholder",
  );
  assert.ok(loaded.length > CORE_TEXT.length, "expected the composed text to carry real repo content beyond the core alone");
});

// #419 review round 2 (Codex sol high, P2-1): the ORIGINAL wording here called a missed
// classification "bounded and recoverable" on its own — false against env-failure.ts's
// DEFAULT_LLM_FAILURE_PATTERNS-comment accounting, which states a WORKER-lane miss is bounded by
// nothing in that file (it can recur on every subsequently dispatched issue); only the engine's
// own outer cost ceiling bounds it. The retracted overclaim must never silently return — a
// negative lint over the banned class, now run over the FULL concatenation (core + repo part),
// since either half could in principle reintroduce it.
test("#419: the loaded doctrine (core + repo part) never reintroduces the retracted 'bounded and recoverable' overclaim for a worker-lane env-failure miss", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.doesNotMatch(loaded, /bounded and recoverable/i);
});

// #830 AC5: docs/REVIEW-DOCTRINE.md — the doctrine file THIS repo's own live config points
// `doctrine.file` at — carries its own leading HTML comment (the same shape as
// doctrine-template.md's header, per #830's issue body). No special-casing for that file was
// added anywhere: it is cleaned by the exact same loadDoctrine call every other repo's doctrine
// file goes through. Before the loader-side fix, this test fails on `main`.
test("#830 AC5: this repo's own docs/REVIEW-DOCTRINE.md loads with its leading HTML comment stripped — no special-casing needed, same loadDoctrine path every repo's doctrine.file uses", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const rawFile = readFileSync(cfg.doctrine.file, "utf8");
  assert.match(rawFile, /<!--/, "sanity: the on-disk file itself still carries its leading HTML comment (never edited by this fix)");
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  assert.ok(!loaded.includes("<!--"), "the composed doctrine text handed to a session must carry no HTML comment");
});

test("#411: this repo's own repo part is under doctrine.maxChars with NO truncation marker (not silently cut)", () => {
  const cfg = loadConfig(REPO_CONFIG_PATH);
  const loaded = loadDoctrine(cfg.doctrine.file, cfg.doctrine.maxChars);
  const repoPart = loaded.slice(`${CORE_TEXT}\n\n`.length);
  assert.ok(
    repoPart.length < cfg.doctrine.maxChars,
    `expected the repo part (${repoPart.length} chars) to be under maxChars (${cfg.doctrine.maxChars})`,
  );
  // #419 review round 2 (Codex sol high, P3): a bare /truncated/i regex would false-fail CI the
  // moment legitimate doctrine prose ever contains the word "truncated". Pin the EXACT marker
  // capDigest emits instead (retro-digest.ts's `capDigest`) — no other string in this repo's
  // residue prose can accidentally match it.
  assert.ok(!repoPart.includes("[... digest truncated:"), "expected no capDigest truncation marker in this repo's own doctrine text");
});
