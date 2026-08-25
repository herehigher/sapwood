import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { defaultRuntimeRoot, ensureRuntimeRoot, runtimePaths, SAPWOOD_DIR } from "./paths.js";

test("SAPWOOD_DIR is the fixed, dot-prefixed root name", () => {
  assert.equal(SAPWOOD_DIR, ".sapwood");
});

test("defaultRuntimeRoot: <cwd>/.sapwood, cwd-relative by default", () => {
  assert.equal(defaultRuntimeRoot("/repo"), "/repo/.sapwood");
  assert.equal(defaultRuntimeRoot(), join(process.cwd(), ".sapwood"));
});

test("runtimePaths: every named path is under the given root, matching the §4.1 layout", () => {
  const root = "/repo/.sapwood";
  const paths = runtimePaths(root);
  assert.equal(paths.root, root);
  assert.equal(paths.gitignore, join(root, ".gitignore"));
  assert.equal(paths.db, join(root, "sapwood.sqlite"));
  assert.equal(paths.dbWal, join(root, "sapwood.sqlite-wal"));
  assert.equal(paths.dbShm, join(root, "sapwood.sqlite-shm"));
  assert.equal(paths.lock, join(root, "sapwood.lock"));
  assert.equal(paths.killSwitch, join(root, "KILL_SWITCH"));
  assert.equal(paths.estop, join(root, "EMERGENCY_STOP"));
  assert.equal(paths.pause, join(root, "PAUSE"));
  assert.equal(paths.escalation, join(root, "ESCALATION"));
  assert.equal(paths.directiveMd, join(root, "DIRECTIVE.md"));
  assert.equal(paths.directivesDir, join(root, "directives"));
  assert.equal(paths.roundsDir, join(root, "rounds"));
  assert.equal(paths.proxyBundlesDir, join(root, "proxy-bundles"));
  assert.equal(paths.logsDir, join(root, "logs"));
  assert.equal(paths.logFile, join(root, "logs", "sapwood.log"));
  assert.equal(paths.keysDir, join(root, "keys"));
  assert.equal(paths.sessionsStateDir, join(root, "sessions", "state"));
  assert.equal(paths.sessionsRolesDir, join(root, "sessions", "roles"));
  assert.equal(paths.sessionsReviewCodexDir, join(root, "sessions", "review-codex"));
  assert.equal(paths.attentionDismissals, join(root, "attention-dismissals.jsonl"));
  assert.equal(paths.cacheDir, join(root, "cache"));
  assert.equal(paths.cacheDirTag, join(root, "cache", "CACHEDIR.TAG"));
  assert.equal(paths.cacheReviewCloneGit, join(root, "cache", "review", "clone.git"));
  assert.equal(paths.cacheReviewTreesDir, join(root, "cache", "review", "trees"));
  assert.equal(paths.cacheGeneratedRoleSkillsDir, join(root, "cache", "generated", "role-skills"));
  // Two classes (§4.1): everything except cacheDir's own subtree is directly under root.
  for (const [key, value] of Object.entries(paths)) {
    if (key === "root") continue;
    assert.ok(value.startsWith(`${root}/`) || value === root, `${key} (${value}) must be under ${root}`);
  }
});

test("runtimePaths: pure — no filesystem I/O, safe to call against a root that does not exist", () => {
  const missingRoot = join(tmpdir(), "sapwood-paths-pure-probe-does-not-exist");
  assert.equal(existsSync(missingRoot), false);
  runtimePaths(missingRoot);
  assert.equal(existsSync(missingRoot), false, "runtimePaths must not have created anything");
});

// ── ensureRuntimeRoot (AC3): .gitignore + cache/CACHEDIR.TAG, idempotent, never clobbers ──────

test("ensureRuntimeRoot: creates the root, writes .gitignore (*) and cache/CACHEDIR.TAG", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ensure-root-"));
  try {
    const root = join(dir, ".sapwood");
    ensureRuntimeRoot(root);
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), "*\n");
    const tag = readFileSync(join(root, "cache", "CACHEDIR.TAG"), "utf8");
    assert.match(tag, /^Signature: 8a477f597d28d172789f06886806bc55\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureRuntimeRoot: a second call is a no-op — identical content, no error, no log", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ensure-root-idem-"));
  try {
    const root = join(dir, ".sapwood");
    ensureRuntimeRoot(root);
    const gitignoreBefore = readFileSync(join(root, ".gitignore"), "utf8");
    const tagBefore = readFileSync(join(root, "cache", "CACHEDIR.TAG"), "utf8");
    const logged: string[] = [];
    ensureRuntimeRoot(root, (m) => logged.push(m));
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), gitignoreBefore);
    assert.equal(readFileSync(join(root, "cache", "CACHEDIR.TAG"), "utf8"), tagBefore);
    assert.deepEqual(logged, [], "a matching pre-existing file is silently left alone, never logged");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureRuntimeRoot: a pre-existing DIFFERING .gitignore is preserved, not overwritten, and reported once", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ensure-root-differing-"));
  try {
    const root = join(dir, ".sapwood");
    mkdirSync(root, { recursive: true });
    const customGitignore = "# operator-authored, not sapwood's own\ncustom-rule\n";
    writeFileSync(join(root, ".gitignore"), customGitignore);
    const logged: string[] = [];
    ensureRuntimeRoot(root, (m) => logged.push(m));
    assert.equal(readFileSync(join(root, ".gitignore"), "utf8"), customGitignore, "never overwritten");
    assert.equal(logged.length, 1, "reported exactly once");
    assert.match(logged[0]!, /already exists with different content/);
    // cache/CACHEDIR.TAG is still written normally — the differing file was ONLY .gitignore.
    assert.match(readFileSync(join(root, "cache", "CACHEDIR.TAG"), "utf8"), /^Signature: 8a477f597d28d172789f06886806bc55\n/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── AC1/AC6: negative oracle — `runtimePaths()` is the ONLY place these names are spelled ─────
//
// Scans engine/src and dashboard/src (this repo's whole application source, both production
// and test files) for a `"data/"`-shaped string literal or a `join(..., "data")` call — the two
// shapes the pre-#1077 ~8 independent literals took. The allowlist is file-scoped, not
// line-scoped, and each entry states exactly why it is not this leg's job to fix:
//   - this file and paths.ts itself (the one place the names ARE spelled)
//   - engine/src/guard/** — the guard rule's own sentinel-path assumptions are #1079's leg
//   - engine/src/loop/init.test.ts — exercises loop/init.ts's deploy-key provisioning literals,
//     which init.ts itself still spells (marked `// #1080` at each site) because moving the key
//     under keys/ is #1080's move, not this leg's
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCAN_ROOTS = [join(REPO_ROOT, "engine", "src"), join(REPO_ROOT, "dashboard", "src")];
const FILE_ALLOWLIST = new Set(["engine/src/config/paths.ts", "engine/src/config/paths.test.ts", "engine/src/loop/init.test.ts"]);
const DIR_ALLOWLIST_PREFIX = "engine/src/guard/";
const DATA_LITERAL_RE = /["'`]\/?data\//;
const JOIN_DATA_RE = /join\([^)]*,\s*"data"/;
const MARKER_1080 = "#1080";

function listSourceFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    if (!entry.name.endsWith(".ts") && !entry.name.endsWith(".tsx")) continue;
    // Node's recursive readdirSync exposes each dirent's own containing dir on `.path`
    // (Node >=20.12) / `.parentPath` (Node >=21) — this repo's engines floor (>=24) has both.
    const parent = (entry as unknown as { parentPath?: string; path?: string }).parentPath ?? (entry as unknown as { path: string }).path;
    out.push(join(parent, entry.name));
  }
  return out;
}

test("AC1/AC6: no `data/` runtime-root literal remains outside runtimePaths() and its allowlisted deferrals", () => {
  const offenders: string[] = [];
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of listSourceFiles(scanRoot)) {
      const relPath = file.slice(REPO_ROOT.length + 1);
      if (FILE_ALLOWLIST.has(relPath) || relPath.startsWith(DIR_ALLOWLIST_PREFIX)) continue;
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((line, idx) => {
        if (line.includes(MARKER_1080)) return; // #1080: deferred to the init leg, see init.ts
        if (DATA_LITERAL_RE.test(line) || JOIN_DATA_RE.test(line)) {
          offenders.push(`${relPath}:${idx + 1}: ${line.trim()}`);
        }
      });
    }
  }
  assert.deepEqual(offenders, []);
});
