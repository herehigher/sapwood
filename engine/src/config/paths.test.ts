import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  DEPLOY_KEY_BASENAME,
  defaultRuntimeRoot,
  ensureRuntimeRoot,
  findDeployKeyAnchor,
  keyIdSidecarPath,
  type RuntimeRootFsOps,
  realRuntimeRootFsOps,
  runtimePaths,
  SAPWOOD_DIR,
} from "./paths.js";

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
  assert.equal(paths.deployKeySidecar, join(root, "keys", "worker-deploy-key.id"));
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

// A byte-content comparison alone cannot distinguish "the second call skipped the write" from
// "the second call re-wrote the identical bytes" — both leave the same file content behind, so
// a content-only assertion would still pass against an implementation that always re-writes. An
// INJECTED fs (RuntimeRootFsOps) proves the SKIP itself: zero writeFile calls on the second,
// already-stamped-root invocation, plus a positive control pinning that the SAME fake DOES
// record the two real writes on a fresh root — so a "0 calls" result on the second call can't
// be a silent no-op/broken-fake false negative.
function countingFsOps(real: RuntimeRootFsOps): RuntimeRootFsOps & { writeFileCalls: string[] } {
  const writeFileCalls: string[] = [];
  return {
    writeFileCalls,
    exists: real.exists,
    readFile: real.readFile,
    mkdir: real.mkdir,
    writeFile: (path, content) => {
      writeFileCalls.push(path);
      real.writeFile(path, content);
    },
  };
}

test("ensureRuntimeRoot: a second call makes ZERO writeFile calls on an already-stamped root (injected-fs proof, not a content/mtime comparison)", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-ensure-root-idem-"));
  try {
    const root = join(dir, ".sapwood");
    // Positive control: the counting fake actually records real writes (fresh root -> 2 real
    // writes: .gitignore + CACHEDIR.TAG) — proves it isn't a silent false-negative before
    // trusting the "0 calls" assertion below to mean anything.
    const freshOps = countingFsOps(realRuntimeRootFsOps);
    ensureRuntimeRoot(root, undefined, freshOps);
    assert.equal(freshOps.writeFileCalls.length, 2, "a fresh root makes exactly two real writeFile calls");

    const logged: string[] = [];
    const idemOps = countingFsOps(realRuntimeRootFsOps);
    ensureRuntimeRoot(root, (m) => logged.push(m), idemOps);
    assert.equal(
      idemOps.writeFileCalls.length,
      0,
      "an already-stamped root makes NO writeFile call at all — not even a same-content rewrite",
    );
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
// and test files) for any of three bypass shapes the pre-#1077 ~8 independent literals
// demonstrated:
//   - a `"data/"`-shaped string literal, any quote style including a template literal
//     (`` `data/x` ``)
//   - a `join(...)`/`resolve(...)` call carrying a bare `"data"` argument later in its argument
//     list — any quote style (covers `` join(cwd, `data`, x) ``), and MULTILINE (the regex runs
//     against the whole file's text, not line-by-line, so a call whose arguments wrap onto
//     several lines is not a blind spot)
//   - string concatenation off a bare `"data"` literal (`"data" + "/x"`)
// No TypeScript-compiler-API scanner — plain regex plus the mutation-fixture tests below (one
// per bypass shape, proving each regex is not vacuous) is the ceiling here.
//
// The allowlist is a small, fully explicit `file:line` set — no substring/marker skip and no
// file-level exclusion beyond the file named below, with its own reason:
//   - this file and paths.ts itself (the one place the names ARE spelled)
// engine/src/guard/** carries no directory-level allowlist entry: guard.ts's `.sapwood/`
// write-deny rule (#1079) matches this factory's real paths directly, so no `data/` literal
// remains anywhere under engine/src/guard/** — a future one there is a real offense, not
// silently covered by a directory-wide exemption.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SCAN_ROOTS = [join(REPO_ROOT, "engine", "src"), join(REPO_ROOT, "dashboard", "src")];
const FILE_ALLOWLIST = new Set(["engine/src/config/paths.ts", "engine/src/config/paths.test.ts"]);

// Stays EMPTY, not deleted — removing the mechanism entirely would let a future `data/` literal
// silently reintroduce a bypass with no oracle catching it; an empty Set still runs the full
// scan below with zero exemptions.
const ALLOWED_1080_SITES = new Set<string>([]);

// A bare `"data/"` (or `` `data/` ``) string literal, any quote style, optionally absolute.
const DATA_LITERAL_RE = /["'`]\/?data\//;
// `join(...)`/`resolve(...)` carrying a bare "data" argument in ANY position — first argument
// (`join("data", x)`) or later (`join(cwd, "data", x)`) — any quote style, MULTILINE (runs
// against the whole file, `[\s\S]` crosses newlines) so a call whose args wrap onto several
// lines is still caught. The leading-argument group is optional so a first-position "data" is
// not required to be preceded by a comma. Bounded to 200 chars between `(` and the "data"
// argument (generous for a handful of short path-segment arguments, even wrapped one per line)
// — NOT unbounded: an unbounded lazy match has no notion of the call's own closing paren, so it
// would "leak" past unrelated code and match an entirely different, later statement's "data"
// occurrence.
const CALL_DATA_RE = /\b(?:join|resolve)\(\s*(?:[\s\S]{0,200}?,\s*)?["'`]data["'`]\s*[,)]/;
// String concatenation off a bare "data" literal: "data" + "/x".
const CONCAT_DATA_RE = /["'`]data["'`]\s*\+/;

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

/** Every `file:line` this content trips one of the three bypass regexes on, RAW — no
 *  ALLOWED_1080_SITES filtering. The oracle's own detection core: called by the real scan below
 *  (which then filters), by the completeness check (which needs the unfiltered hits to prove
 *  every allowlist entry is actually live, not stale), and by the mutation-fixture tests (module-
 *  private, so all three exercise the IDENTICAL matching logic). */
function rawDataLiteralMatches(relPath: string, content: string): string[] {
  const offenders: string[] = [];
  const lineStartOffsets: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") lineStartOffsets.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStartOffsets.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (lineStartOffsets[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
  for (const re of [DATA_LITERAL_RE, CALL_DATA_RE, CONCAT_DATA_RE]) {
    const global = new RegExp(re.source, "g");
    for (const match of content.matchAll(global)) {
      offenders.push(`${relPath}:${lineAt(match.index)}`);
    }
  }
  return offenders;
}

/** The allowlist-filtered view `rawDataLiteralMatches` feeds the real scan with — what a caller
 *  wants "did anything slip through". */
function findDataLiteralOffenses(relPath: string, content: string): string[] {
  return rawDataLiteralMatches(relPath, content).filter((site) => !ALLOWED_1080_SITES.has(site));
}

test("AC1/AC6: no `data/` runtime-root literal remains outside runtimePaths() and its allowlisted deferrals", () => {
  const offenders: string[] = [];
  const hitAllowlistSites = new Set<string>();
  for (const scanRoot of SCAN_ROOTS) {
    for (const file of listSourceFiles(scanRoot)) {
      const relPath = file.slice(REPO_ROOT.length + 1);
      if (FILE_ALLOWLIST.has(relPath)) continue;
      const content = readFileSync(file, "utf8");
      for (const site of rawDataLiteralMatches(relPath, content)) {
        if (ALLOWED_1080_SITES.has(site)) hitAllowlistSites.add(site);
        else offenders.push(site);
      }
    }
  }
  assert.deepEqual(
    [...ALLOWED_1080_SITES].filter((s) => !hitAllowlistSites.has(s)),
    [],
    "every ALLOWED_1080_SITES entry must correspond to a REAL match — a stale entry hides the allowlist's own drift",
  );
  assert.deepEqual(offenders, []);
});

// ── Mutation fixtures: each bypass shape the oracle above claims to catch, proven non-vacuous ──
// One fixture per shape (`join(cwd, \`data\`, x)`, `resolve(cwd, "data", x)`, "data" as the
// FIRST argument, string concatenation, and multiline `join(` calls), run through the SAME
// findDataLiteralOffenses the real scan uses — if any of these ever stops matching, the oracle
// has regressed silently.
test("negative-oracle mutation fixture: template-literal join segment (`` `data` ``) is caught", () => {
  const offenses = findDataLiteralOffenses("fixture.ts", 'export const p = join(cwd, `data`, "sessions", "roles");\n');
  assert.ok(offenses.length > 0, "join(cwd, `data`, ...) must be flagged");
});

test('negative-oracle mutation fixture: resolve(cwd, "data", x) is caught', () => {
  const offenses = findDataLiteralOffenses("fixture.ts", 'export const p = resolve(cwd, "data", "worker-deploy-key");\n');
  assert.ok(offenses.length > 0, 'resolve(cwd, "data", ...) must be flagged');
});

test('negative-oracle mutation fixture: join("data", x) — "data" as the FIRST argument, no leading comma — is caught', () => {
  const offenses = findDataLiteralOffenses("fixture.ts", 'export const p = join("data", "worker-deploy-key");\n');
  assert.ok(offenses.length > 0, 'join("data", ...) must be flagged even when "data" is the first argument');
});

test('negative-oracle mutation fixture: string concatenation off a bare "data" literal is caught', () => {
  const offenses = findDataLiteralOffenses("fixture.ts", 'export const p = "data" + "/" + name;\n');
  assert.ok(offenses.length > 0, '"data" + ... must be flagged');
});

test('negative-oracle mutation fixture: a multiline join(...) call with "data" wrapped onto its own line is caught', () => {
  const offenses = findDataLiteralOffenses(
    "fixture.ts",
    ["export const p = join(", "  cwd,", '  "data",', '  "sessions",', '  "roles",', ");"].join("\n"),
  );
  assert.ok(offenses.length > 0, "a multiline join(...) carrying a data argument must be flagged");
});

test('negative-oracle mutation fixture: a plain "data/x" literal is still caught', () => {
  const offenses = findDataLiteralOffenses("fixture.ts", 'export const DEFAULT_DB_PATH = "data/sapwood.sqlite";\n');
  assert.ok(offenses.length > 0);
});

test("negative-oracle mutation fixture: a clean .sapwood/-rooted equivalent of every fixture above is NOT flagged", () => {
  const clean = [
    'export const p1 = join(cwd, ".sapwood", "sessions", "roles");',
    'export const p2 = resolve(cwd, ".sapwood", "worker-deploy-key");',
    'export const p3 = ".sapwood" + "/" + name;',
    'export const p4 = join(\n  cwd,\n  ".sapwood",\n  "sessions",\n  "roles",\n);',
    'export const DEFAULT_DB_PATH = ".sapwood/sapwood.sqlite";',
    'export const p5 = join(".sapwood", "worker-deploy-key");',
  ].join("\n");
  assert.deepEqual(findDataLiteralOffenses("fixture.ts", clean), []);
});

// ── #1105: the L1 deploy-key anchor — a filesystem sidecar beside the key itself, discovered
//    from `.sapwood/keys/` directly rather than a value in the audited sapwood.config.yaml ──

test("keyIdSidecarPath: appends .id beside whatever key path is given", () => {
  assert.equal(keyIdSidecarPath("/repo/.sapwood/keys/worker-deploy-key"), "/repo/.sapwood/keys/worker-deploy-key.id");
  assert.equal(keyIdSidecarPath("/repo/.sapwood/keys/worker-deploy-key-myhost"), "/repo/.sapwood/keys/worker-deploy-key-myhost.id");
});

test("DEPLOY_KEY_BASENAME: the fixed primary (non-host-suffixed) key basename", () => {
  assert.equal(DEPLOY_KEY_BASENAME, "worker-deploy-key");
});

test("findDeployKeyAnchor: undefined when the keys directory does not exist at all", () => {
  const root = join(mkdtempSync(join(tmpdir(), "sapwood-anchor-")), ".sapwood");
  try {
    assert.equal(findDeployKeyAnchor(root), undefined);
  } finally {
    rmSync(dirname(root), { recursive: true, force: true });
  }
});

test("findDeployKeyAnchor: undefined when the keys directory exists but has no .id sidecar", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-anchor-"));
  const root = join(dir, ".sapwood");
  try {
    mkdirSync(join(root, "keys"), { recursive: true });
    writeFileSync(join(root, "keys", "worker-deploy-key"), "not a sidecar");
    writeFileSync(join(root, "keys", "worker-deploy-key.pub"), "ssh-ed25519 AAAA");
    assert.equal(findDeployKeyAnchor(root), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findDeployKeyAnchor: finds the primary sidecar and returns its co-located key path and parsed id", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-anchor-"));
  const root = join(dir, ".sapwood");
  try {
    mkdirSync(join(root, "keys"), { recursive: true });
    writeFileSync(join(root, "keys", "worker-deploy-key"), "fake-private-key");
    writeFileSync(join(root, "keys", "worker-deploy-key.id"), "12345\n");
    assert.deepEqual(findDeployKeyAnchor(root), { keyPath: join(root, "keys", "worker-deploy-key"), keyId: 12345 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findDeployKeyAnchor: a sidecar with no co-located key file, or one that is not a regular file, is never a candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-anchor-"));
  const root = join(dir, ".sapwood");
  try {
    mkdirSync(join(root, "keys"), { recursive: true });
    writeFileSync(join(root, "keys", "worker-deploy-key.id"), "12345\n");
    assert.equal(findDeployKeyAnchor(root), undefined, "no co-located key file at all");
    mkdirSync(join(root, "keys", "worker-deploy-key"));
    assert.equal(findDeployKeyAnchor(root), undefined, "a directory standing in for the key file");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("findDeployKeyAnchor: a sidecar whose content is not a plain positive decimal integer (0, negative, non-numeric, 1e3, 0x10) is never a candidate", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-anchor-"));
  const root = join(dir, ".sapwood");
  try {
    mkdirSync(join(root, "keys"), { recursive: true });
    writeFileSync(join(root, "keys", "worker-deploy-key"), "fake-private-key");
    for (const raw of ["0", "-5", "not-a-number", "1e3", "0x10", "+5", "5.0"]) {
      writeFileSync(join(root, "keys", "worker-deploy-key.id"), `${raw}\n`);
      assert.equal(findDeployKeyAnchor(root), undefined, `id text ${JSON.stringify(raw)} must be rejected`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// #1105: mtime ordering, not real-time delay — utimesSync sets each sidecar's mtime explicitly
// so this pins the "most recently WRITTEN wins" rule deterministically, with no dependency on
// wall-clock timing or filesystem mtime granularity (docs/REVIEW-DOCTRINE.md's no-timing-
// dependent-tests rule: go around the clock, never wait on it).
test("findDeployKeyAnchor: when more than one sidecar exists (a stale primary plus a fresher per-host replacement), the most recently WRITTEN one wins", () => {
  const dir = mkdtempSync(join(tmpdir(), "sapwood-anchor-"));
  const root = join(dir, ".sapwood");
  try {
    mkdirSync(join(root, "keys"), { recursive: true });
    writeFileSync(join(root, "keys", "worker-deploy-key"), "fake-private-key");
    writeFileSync(join(root, "keys", "worker-deploy-key-myhost-2"), "fake-private-key");
    const stalePath = join(root, "keys", "worker-deploy-key.id");
    const freshPath = join(root, "keys", "worker-deploy-key-myhost-2.id");
    writeFileSync(stalePath, "1\n");
    writeFileSync(freshPath, "99\n");
    const older = new Date(Date.now() - 60_000);
    const newer = new Date();
    utimesSync(stalePath, older, older);
    utimesSync(freshPath, newer, newer);
    assert.deepEqual(findDeployKeyAnchor(root), { keyPath: join(root, "keys", "worker-deploy-key-myhost-2"), keyId: 99 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
