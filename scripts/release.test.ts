import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changelogHasSection,
  checkCatalogPaths,
  checkLockfileVersions,
  checkManifestLockstep,
  checkPublishPreconditions,
  checkTagExists,
  compareSemver,
  type Deps,
  type Exec,
  extractUnreleasedBody,
  extractVersionSection,
  formatBuildStamp,
  isPrerelease,
  MANIFEST_PATHS,
  moveUnreleasedToVersion,
  npmDistTag,
  PUBLISH_STEPS,
  type PublishContext,
  RELEASE_WORKFLOW,
  readManifestVersion,
  runCatalogPromote,
  runDistTag,
  runPrepare,
  runPublish,
  runWindowsSmoke,
  validateReleaseVersion,
  WINDOWS_SMOKE_WORKFLOW,
  waitForReleaseWorkflow,
  writeManifestVersion,
} from "./release.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function runClaude(args: string[], cwd = REPO_ROOT): { status: number | null; stdout: string; stderr: string; error: string } {
  const result = spawnSync("claude", args, { cwd, encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error?.message ?? "",
  };
}

const CLAUDE_VERSION = runClaude(["--version"]);
const CLAUDE_CLI_AVAILABLE = CLAUDE_VERSION.status === 0;
const CLAUDE_VALIDATE_HELP = runClaude(["plugin", "validate", "--help"]);
const CLAUDE_STRICT_SUPPORTED = `${CLAUDE_VALIDATE_HELP.stdout}\n${CLAUDE_VALIDATE_HELP.stderr}`.includes("--strict");

function formatClaudeResult(label: string, result: ReturnType<typeof runClaude>): string {
  return `${label} exit: ${result.status}\n${label} stdout:\n${result.stdout}\n${label} stderr:\n${result.stderr}${result.error ? `\n${label} error: ${result.error}` : ""}`;
}

const CLAUDE_VALIDATION_SKIP_REASON = !CLAUDE_CLI_AVAILABLE
  ? `claude CLI is not on PATH\n${formatClaudeResult("claude --version", CLAUDE_VERSION)}`
  : !CLAUDE_STRICT_SUPPORTED
    ? `claude plugin validate --help does not list --strict\n${formatClaudeResult("claude --version", CLAUDE_VERSION)}\n${formatClaudeResult("claude plugin validate --help", CLAUDE_VALIDATE_HELP)}`
    : false;

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "sapwood-release-test-"));
}

// Mirrors what `execFileSync` actually throws on a non-zero exit — a fake `Exec` that needs to
// simulate `git ls-remote --exit-code`'s exit-code-as-signal contract raises this instead of
// returning a string, exactly like the real child_process call would.
class FakeExecError extends Error {
  status: number;
  constructor(status: number) {
    super(`fake exec exited with status ${status}`);
    this.status = status;
  }
}

// ── semver validation ───────────────────────────────────────────────────────────────

test("validateReleaseVersion: accepts a plain release version", () => {
  assert.deepEqual(validateReleaseVersion("0.3.0"), { ok: true });
});

test("validateReleaseVersion: accepts the pre-1.0 alpha ladder form", () => {
  assert.deepEqual(validateReleaseVersion("0.3.0-alpha.1"), { ok: true });
});

test("validateReleaseVersion: rejects build metadata with a policy-pointing message", () => {
  const r = validateReleaseVersion("0.3.0+20260819.abc1234");
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /build metadata/);
  assert.match((r as { message: string }).message, /docs\/dev-guide\/10-releasing\.md/);
});

test("validateReleaseVersion: rejects a non-semver string", () => {
  assert.equal(validateReleaseVersion("v1").ok, false);
  assert.equal(validateReleaseVersion("1.2").ok, false);
  assert.equal(validateReleaseVersion("").ok, false);
});

// ── prerelease detection ────────────────────────────────────────────────────────────

test("isPrerelease: true for an alpha version, false for a plain release", () => {
  assert.equal(isPrerelease("0.3.0-alpha.1"), true);
  assert.equal(isPrerelease("0.3.0"), false);
});

// ── build stamp formatting ──────────────────────────────────────────────────────────

test("formatBuildStamp: version+date.sha", () => {
  assert.equal(formatBuildStamp("0.3.0-alpha.1", "20260819", "a1b2c3d"), "0.3.0-alpha.1+20260819.a1b2c3d");
});

// ── compareSemver ───────────────────────────────────────────────────────────────────

test("compareSemver: the pre-1.0 ladder orders as alpha.1 < alpha.2 < beta.1 < release < patch < minor", () => {
  const order = ["0.3.0-alpha.1", "0.3.0-alpha.2", "0.3.0-beta.1", "0.3.0", "0.3.1", "0.10.0"];
  for (let i = 0; i < order.length - 1; i++) {
    const a = order[i]!;
    const b = order[i + 1]!;
    assert.ok(compareSemver(a, b) < 0, `expected ${a} < ${b}`);
    assert.ok(compareSemver(b, a) > 0, `expected ${b} > ${a}`);
  }
});

test("compareSemver: equal versions compare to 0", () => {
  assert.equal(compareSemver("0.3.0", "0.3.0"), 0);
  assert.equal(compareSemver("0.3.0-alpha.1", "0.3.0-alpha.1"), 0);
});

test("compareSemver: numeric pre-release identifiers compare by length then lexically, not via Number() — correct even past 2^53", () => {
  const a = "0.3.0-alpha.12345678901234567890";
  const b = "0.3.0-alpha.12345678901234567891";
  // Number(a) and Number(b) both round to the same imprecise float past 2^53; a correct
  // implementation still tells them apart because it never converts to Number at all.
  assert.notEqual(Number(a.split(".").pop()), undefined);
  assert.ok(compareSemver(a, b) < 0, "a should be < b despite exceeding Number.MAX_SAFE_INTEGER");
  assert.ok(compareSemver(b, a) > 0);
  // a shorter numeric identifier is always less than a longer one, regardless of leading digit
  assert.ok(compareSemver("0.3.0-alpha.9", "0.3.0-alpha.10") < 0);
});

test("compareSemver: the major/minor/patch components also compare by length then lexically, not via Number() — a 20-digit major orders correctly", () => {
  const a = "12345678901234567890.0.0";
  const b = "12345678901234567891.0.0";
  assert.ok(compareSemver(a, b) < 0, "a should be < b despite exceeding Number.MAX_SAFE_INTEGER");
  assert.ok(compareSemver(b, a) > 0);
  // a shorter major is always less than a longer one, regardless of leading digit
  assert.ok(compareSemver("9.0.0", "10.0.0") < 0);
});

// ── manifest read/write + lockstep ─────────────────────────────────────────────────

test("writeManifestVersion: edits only the version line, formatting otherwise untouched", () => {
  const dir = tmpRepo();
  try {
    const path = join(dir, "package.json");
    const original = '{\n  "name": "x",\n  "version": "0.0.0",\n  "private": true\n}\n';
    writeFileSync(path, original);
    writeManifestVersion(path, "0.3.0-alpha.1");
    const updated = readFileSync(path, "utf8");
    assert.equal(updated, '{\n  "name": "x",\n  "version": "0.3.0-alpha.1",\n  "private": true\n}\n');
    assert.equal(readManifestVersion(path), "0.3.0-alpha.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeFakeManifests(dir: string, versions: string[]): string[] {
  const paths = MANIFEST_PATHS.map((p) => join(dir, p));
  paths.forEach((p, i) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, JSON.stringify({ name: "x", version: versions[i] }, null, 2) + "\n");
  });
  return paths;
}

// A minimal but structurally real lockfile — only the three `packages[...]` entries
// `checkLockfileVersions` actually reads, not a full `npm install` output.
function writeFakeLockfile(repoRoot: string, version: string): void {
  const lock = {
    name: "sapwood-workspace",
    version,
    lockfileVersion: 3,
    packages: {
      "": { name: "sapwood-workspace", version },
      engine: { name: "sapwood", version },
      dashboard: { name: "@sapwood/dashboard", version },
    },
  };
  writeFileSync(join(repoRoot, "package-lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
}

test("checkManifestLockstep: ok when all four agree", () => {
  const dir = tmpRepo();
  try {
    const paths = writeFakeManifests(dir, ["0.3.0", "0.3.0", "0.3.0", "0.3.0"]);
    assert.deepEqual(checkManifestLockstep(paths), { ok: true, version: "0.3.0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkManifestLockstep: fails when one of the four disagrees", () => {
  const dir = tmpRepo();
  try {
    const paths = writeFakeManifests(dir, ["0.3.0", "0.3.0", "0.2.9", "0.3.0"]);
    const r = checkManifestLockstep(paths);
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /disagree/);
    assert.match((r as { message: string }).message, /0\.2\.9/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("lockstep: the repo's own four manifests agree, and CHANGELOG has a matching section", () => {
  const paths = MANIFEST_PATHS.map((p) => join(REPO_ROOT, p));
  const lockstep = checkManifestLockstep(paths);
  assert.equal(lockstep.ok, true, lockstep.ok ? "" : (lockstep as { message: string }).message);
  const version = (lockstep as { version: string }).version;
  const changelog = readFileSync(join(REPO_ROOT, "CHANGELOG.md"), "utf8");
  assert.equal(changelogHasSection(changelog, version), true, `CHANGELOG.md has no section for manifest version ${version}`);
});

// ── checkLockfileVersions ───────────────────────────────────────────────────────────

test("checkLockfileVersions: ok when root/engine/dashboard entries all match", () => {
  const dir = tmpRepo();
  try {
    writeFakeLockfile(dir, "0.3.0");
    assert.deepEqual(checkLockfileVersions(dir, "0.3.0"), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkLockfileVersions: fails when one of the three packages entries disagrees", () => {
  const dir = tmpRepo();
  try {
    const lock = {
      version: "0.3.0",
      packages: { "": { version: "0.3.0" }, engine: { version: "0.2.9" }, dashboard: { version: "0.3.0" } },
    };
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
    const r = checkLockfileVersions(dir, "0.3.0");
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /engine/);
    assert.doesNotMatch((r as { message: string }).message, /top-level/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('checkLockfileVersions: fails when the lockfile\'s own top-level "version" disagrees, even though all three packages entries agree', () => {
  const dir = tmpRepo();
  try {
    const lock = {
      version: "0.2.9",
      packages: { "": { version: "0.3.0" }, engine: { version: "0.3.0" }, dashboard: { version: "0.3.0" } },
    };
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify(lock));
    const r = checkLockfileVersions(dir, "0.3.0");
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /top-level/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkLockfileVersions: fails when package-lock.json is missing or unreadable", () => {
  const dir = tmpRepo();
  try {
    const r = checkLockfileVersions(dir, "0.3.0");
    assert.equal(r.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── CHANGELOG section parsing (line-anchored headings, CRLF-normalized) ────────────

const SAMPLE_CHANGELOG = `# Changelog

## [Unreleased]

### Added
- new thing

## [0.2.0] - 2026-01-01

### Added
- old thing
`;

test("moveUnreleasedToVersion: promotes Unreleased, leaves a fresh empty one, keeps older sections", () => {
  const updated = moveUnreleasedToVersion(SAMPLE_CHANGELOG, "0.3.0", "2026-08-19");
  assert.match(updated, /## \[Unreleased\]\n\n## \[0\.3\.0\] - 2026-08-19\n\n### Added\n- new thing/);
  assert.match(updated, /## \[0\.2\.0\] - 2026-01-01\n\n### Added\n- old thing/);
  // the fresh Unreleased carries no leftover body between it and the new version heading
  const freshUnreleased = updated.slice(updated.indexOf("## [Unreleased]"), updated.indexOf("## [0.3.0]"));
  assert.equal(freshUnreleased.trim(), "## [Unreleased]");
});

test("extractUnreleasedBody / extractVersionSection / changelogHasSection", () => {
  assert.match(extractUnreleasedBody(SAMPLE_CHANGELOG), /^### Added\n- new thing$/);
  assert.match(extractVersionSection(SAMPLE_CHANGELOG, "0.2.0") ?? "", /^### Added\n- old thing$/);
  assert.equal(extractVersionSection(SAMPLE_CHANGELOG, "9.9.9"), null);
  assert.equal(changelogHasSection(SAMPLE_CHANGELOG, "0.2.0"), true);
  assert.equal(changelogHasSection(SAMPLE_CHANGELOG, "9.9.9"), false);
  assert.equal(changelogHasSection("## [Unreleased]\n", "0.0.0"), true);
});

const PROSE_ONLY_CHANGELOG = `# Changelog

Some notes mention \`## [Unreleased]\` inline, and this paragraph talks about
the ## [Unreleased] heading without it ever starting its own line.

    ## [Unreleased]
    (a 4-space-indented example inside this doc — still not a real heading line)
`;

test("changelog heading matching: a heading mentioned in prose, inline code, or an indented block never counts — missing heading throws/reports false", () => {
  assert.throws(() => extractUnreleasedBody(PROSE_ONLY_CHANGELOG), /has no/);
  assert.equal(changelogHasSection(PROSE_ONLY_CHANGELOG, "0.0.0"), false);
});

const MULTI_SECTION_CHANGELOG = `# Changelog

## [Unreleased]

### Added
- first-section thing

## [0.2.0] - 2026-01-01

### Added
- middle thing

## [0.1.0] - 2026-01-01

### Added
- last thing
`;

test("changelog: extracts the first section (Unreleased) and the last section (nothing follows it) correctly", () => {
  assert.match(extractUnreleasedBody(MULTI_SECTION_CHANGELOG), /first-section thing/);
  assert.match(extractVersionSection(MULTI_SECTION_CHANGELOG, "0.2.0") ?? "", /middle thing/);
  const last = extractVersionSection(MULTI_SECTION_CHANGELOG, "0.1.0");
  assert.match(last ?? "", /last thing/);
  assert.doesNotMatch(last ?? "", /middle thing|first-section thing/);
});

test("changelog parsing normalizes CRLF to LF before matching headings or extracting bodies", () => {
  const crlf = SAMPLE_CHANGELOG.replace(/\n/g, "\r\n");
  assert.match(extractUnreleasedBody(crlf), /^### Added\n- new thing$/);
  assert.match(extractVersionSection(crlf, "0.2.0") ?? "", /^### Added\n- old thing$/);
  assert.equal(changelogHasSection(crlf, "0.2.0"), true);
  const moved = moveUnreleasedToVersion(crlf, "0.3.0", "2026-08-19");
  assert.match(moved, /## \[Unreleased\]\n\n## \[0\.3\.0\] - 2026-08-19\n\n### Added\n- new thing/);
});

// ── checkTagExists: local cache + the actual remote ─────────────────────────────────

test("checkTagExists: true from the local cache alone — never calls the remote", () => {
  const exec: Exec = (file, args) => {
    if (file === "git" && args[0] === "tag" && args[1] === "-l") return "v0.3.0\n";
    throw new Error(`should not reach the remote when the local cache already has it: ${file} ${args.join(" ")}`);
  };
  assert.equal(checkTagExists({ repoRoot: "/unused", exec }, "v0.3.0"), true);
});

test("checkTagExists: false when both the local cache and the remote lack it (ls-remote exit 2)", () => {
  const exec: Exec = (file, args) => {
    if (file === "git" && args[0] === "tag" && args[1] === "-l") return "";
    if (file === "git" && args[0] === "ls-remote") throw new FakeExecError(2);
    throw new Error(`unexpected exec in test: ${file} ${args.join(" ")}`);
  };
  assert.equal(checkTagExists({ repoRoot: "/unused", exec }, "v0.3.0"), false);
});

test("checkTagExists: true when the remote has it even though the local cache doesn't (ls-remote exit 0)", () => {
  const exec: Exec = (file, args) => {
    if (file === "git" && args[0] === "tag" && args[1] === "-l") return "";
    if (file === "git" && args[0] === "ls-remote") return "abc123def\trefs/tags/v0.3.0\n";
    throw new Error(`unexpected exec in test: ${file} ${args.join(" ")}`);
  };
  assert.equal(checkTagExists({ repoRoot: "/unused", exec }, "v0.3.0"), true);
});

test("checkTagExists: a non-2 exit from ls-remote propagates as a real error, never silently read as absent", () => {
  const exec: Exec = (file, args) => {
    if (file === "git" && args[0] === "tag" && args[1] === "-l") return "";
    if (file === "git" && args[0] === "ls-remote") throw new FakeExecError(1);
    throw new Error(`unexpected exec in test: ${file} ${args.join(" ")}`);
  };
  assert.throws(
    () => checkTagExists({ repoRoot: "/unused", exec }, "v0.3.0"),
    (e: unknown) => e instanceof FakeExecError && e.status === 1,
  );
});

// ── publish preconditions (fake exec) ───────────────────────────────────────────────

function setupPublishRepo(version: string, changelog: string): string {
  const dir = tmpRepo();
  writeFakeManifests(dir, [version, version, version, version]);
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  writeFakeLockfile(dir, version);
  return dir;
}

function fakeExec(opts: { head: string; origin: string; dirty: string; tagOut: string; remoteTagExists?: boolean }): Exec {
  return (file, args) => {
    if (file === "git" && args[0] === "fetch") return "";
    if (file === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return opts.head;
    if (file === "git" && args[0] === "rev-parse" && args[1] === "origin/main") return opts.origin;
    if (file === "git" && args[0] === "status") return opts.dirty;
    if (file === "git" && args[0] === "tag" && args[1] === "-l") return opts.tagOut;
    if (file === "git" && args[0] === "ls-remote") {
      if (opts.remoteTagExists) return "abc123def\trefs/tags/v0.3.0\n";
      throw new FakeExecError(2);
    }
    if (file === "git" && (args[0] === "tag" || args[0] === "push")) return "";
    if (file === "gh" && args[0] === "run" && args[1] === "list") return JSON.stringify([{ databaseId: 7, headSha: opts.head }]);
    if (file === "gh") return "";
    if (file === "npm" && args[0] === "publish") return "";
    if (file === "node" && args[0] === "scripts/dashboard-canary.ts") return "";
    throw new Error(`unexpected exec in test: ${file} ${args.join(" ")}`);
  };
}

// Wraps any Exec fake to also record every (file, args) call, in order, and to snapshot the
// content of any `--notes-file` argument at call time — the real gh-release step deletes that
// file in its own `finally` immediately after the exec call returns, so it must be read here,
// synchronously, before control returns to the caller.
function withRecorder(inner: Exec): { exec: Exec; calls: Array<{ file: string; args: string[] }>; notesFileContents: string[] } {
  const calls: Array<{ file: string; args: string[] }> = [];
  const notesFileContents: string[] = [];
  const exec: Exec = (file, args) => {
    calls.push({ file, args: [...args] });
    const notesIdx = args.indexOf("--notes-file");
    if (file === "gh" && notesIdx !== -1) {
      notesFileContents.push(readFileSync(args[notesIdx + 1]!, "utf8"));
    }
    return inner(file, args);
  };
  return { exec, calls, notesFileContents };
}

const READY_CHANGELOG = "## [Unreleased]\n\n## [0.3.0] - 2026-08-19\n\n### Added\n- x\n";

// ── catalog promotion ──────────────────────────────────────────────────────────────

function realExecForTests(defaultCwd: string): Exec {
  return (file, args, cwd = defaultCwd) => execFileSync(file, args, { cwd, encoding: "utf8" });
}

function git(cwd: string, args: string[]): string {
  const commitConfig = ["-c", "commit.gpgsign=false", "-c", "user.name=sapwood-test", "-c", "user.email=test@sapwood.invalid"];
  return execFileSync("git", args[0] === "commit" ? [...commitConfig, ...args] : args, { cwd, encoding: "utf8" });
}

function writeCatalogShell(repoRoot: string, version: string): void {
  mkdirSync(join(repoRoot, ".claude-plugin"), { recursive: true });
  mkdirSync(join(repoRoot, "commands"), { recursive: true });
  mkdirSync(join(repoRoot, "bin"), { recursive: true });
  mkdirSync(join(repoRoot, "scripts", "catalog"), { recursive: true });
  writeFileSync(
    join(repoRoot, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: "sapwood",
        version,
        description: "Test catalog plugin",
        author: { name: "test" },
        homepage: "https://example.invalid/sapwood",
        license: "MIT",
        keywords: ["claude-code"],
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(repoRoot, ".claude-plugin", "marketplace.json"),
    `${JSON.stringify({ name: "sapwood", owner: { name: "test" }, plugins: [{ name: "sapwood", source: "./" }] }, null, 2)}\n`,
  );
  writeFileSync(join(repoRoot, "commands", "sapwood-run.md"), "---\ndescription: Test command\n---\nrun\n");
  writeFileSync(join(repoRoot, "bin", "sapwood-plugin.sh"), "#!/bin/sh\necho sapwood\n");
  writeFileSync(join(repoRoot, "scripts", "catalog", "ci.yml"), "name: Catalog CI\n");
}

function setupCatalogPromotionRepo(
  version = "0.3.0",
  catalogSeedFiles: Record<string, string> = {},
): {
  repoRoot: string;
  catalogRemote: string;
  initialCatalogHead: string;
} {
  const repoRoot = tmpRepo();
  writeFakeManifests(repoRoot, [version, version, version, version]);
  writeFakeLockfile(repoRoot, version);
  writeCatalogShell(repoRoot, version);
  git(repoRoot, ["init"]);
  git(repoRoot, ["add", "."]);
  git(repoRoot, ["commit", "-m", "release shell"]);
  git(repoRoot, ["tag", `v${version}`]);

  const catalogRemote = join(tmpRepo(), "catalog.git");
  execFileSync("git", ["init", "--bare", "--initial-branch=main", catalogRemote], { encoding: "utf8" });
  const catalogSeed = tmpRepo();
  git(catalogSeed, ["clone", catalogRemote, "."]);
  writeFileSync(join(catalogSeed, "README.md"), "# Sapwood catalog\n");
  for (const [path, contents] of Object.entries(catalogSeedFiles)) {
    const fullPath = join(catalogSeed, path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, contents);
  }
  git(catalogSeed, ["add", "."]);
  git(catalogSeed, ["commit", "-m", "seed catalog"]);
  git(catalogSeed, ["push", "origin", "HEAD:main"]);
  const initialCatalogHead = catalogHead(catalogRemote);
  rmSync(catalogSeed, { recursive: true, force: true });
  return { repoRoot, catalogRemote, initialCatalogHead };
}

function catalogHead(catalogRemote: string): string {
  try {
    return execFileSync("git", ["--git-dir", catalogRemote, "rev-parse", "HEAD"], { encoding: "utf8", stdio: "pipe" }).trim();
  } catch {
    return "";
  }
}

function npmViewExec(repoRoot: string, result: string, failPush = false): Exec {
  const real = realExecForTests(repoRoot);
  let shouldFailPush = failPush;
  return (file, args, cwd) => {
    if (file === "npm" && args[0] === "view") return result;
    if (shouldFailPush && file === "git" && args[0] === "push") {
      shouldFailPush = false;
      throw new FakeExecError(1);
    }
    return real(file, args, cwd);
  };
}

test("catalog promotion: the npm registry exact-match is checked before any catalog write", () => {
  const { repoRoot, catalogRemote, initialCatalogHead } = setupCatalogPromotionRepo();
  try {
    const r = runCatalogPromote({ repoRoot, exec: npmViewExec(repoRoot, "0.3.1\n") }, { catalogRemote, dryRun: false });
    assert.equal(r.code, 1);
    assert.match(r.output, /returned "0.3.1"/);
    assert.equal(catalogHead(catalogRemote), initialCatalogHead);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dirname(catalogRemote), { recursive: true, force: true });
  }
});

test("catalog promotion: local bare remote is idempotent and stamps the release commit", () => {
  const { repoRoot, catalogRemote } = setupCatalogPromotionRepo();
  try {
    const deps: Deps = { repoRoot, exec: npmViewExec(repoRoot, "0.3.0\n") };
    const first = runCatalogPromote(deps, { catalogRemote, dryRun: false });
    assert.equal(first.code, 0, first.output);
    const head = catalogHead(catalogRemote);
    assert.notEqual(head, "");
    const clone = tmpRepo();
    git(clone, ["clone", catalogRemote, "."]);
    const plugin = JSON.parse(readFileSync(join(clone, ".claude-plugin", "plugin.json"), "utf8")) as {
      version: string;
      sourceCommit?: string;
      metadata?: unknown;
    };
    assert.equal(plugin.version, "0.3.0");
    assert.equal(plugin.sourceCommit, undefined);
    assert.equal(plugin.metadata, undefined);
    assert.deepEqual(JSON.parse(readFileSync(join(clone, ".claude-plugin", "marketplace.json"), "utf8")).plugins[0].source, "./");
    assert.equal(git(clone, ["log", "-1", "--format=%an <%ae>"]).trim(), "sapwood-release <release@sapwood.invalid>");
    assert.equal(
      git(clone, ["log", "-1", "--format=%s"]).trim(),
      `chore: promote sapwood v0.3.0 from ${git(repoRoot, ["rev-list", "-n", "1", "v0.3.0"]).trim()}`,
    );
    rmSync(clone, { recursive: true, force: true });

    // The catalog carries the release tag, pointing at the promotion commit.
    assert.equal(git(catalogRemote, ["rev-list", "-n", "1", "v0.3.0"]).trim(), head);

    const second = runCatalogPromote(deps, { catalogRemote, dryRun: false });
    assert.equal(second.code, 0, second.output);
    assert.match(second.output, /already matches/);
    assert.equal(catalogHead(catalogRemote), head);
    // Idempotent for the tag too: still exactly one v0.3.0, still at the same commit.
    assert.equal(git(catalogRemote, ["rev-list", "-n", "1", "v0.3.0"]).trim(), head);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dirname(catalogRemote), { recursive: true, force: true });
  }
});

test("catalog promotion: strict manifest-file validation rejects an unknown field", {
  skip: CLAUDE_VALIDATION_SKIP_REASON,
}, () => {
  const { repoRoot, catalogRemote } = setupCatalogPromotionRepo();
  const clone = tmpRepo();
  try {
    const promoted = runCatalogPromote({ repoRoot, exec: npmViewExec(repoRoot, "0.3.0\n") }, { catalogRemote, dryRun: false });
    assert.equal(promoted.code, 0, promoted.output);
    git(clone, ["clone", catalogRemote, "."]);
    const manifestPath = join(clone, ".claude-plugin", "plugin.json");
    const promotedValidation = runClaude(["plugin", "validate", ".claude-plugin/plugin.json", "--strict"], clone);
    assert.equal(
      promotedValidation.status,
      0,
      `promoted plugin manifest failed strict validation\n${formatClaudeResult("claude --version", CLAUDE_VERSION)}\n${formatClaudeResult("promoted manifest validator", promotedValidation)}`,
    );
    const plugin = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    plugin.unknownField = true;
    writeFileSync(manifestPath, `${JSON.stringify(plugin, null, 2)}\n`);
    const invalidValidation = runClaude(["plugin", "validate", ".claude-plugin/plugin.json", "--strict"], clone);
    assert.equal(
      invalidValidation.status,
      1,
      `unknown field must fail strict validation\n${formatClaudeResult("claude --version", CLAUDE_VERSION)}\n${formatClaudeResult("unknown-field validator", invalidValidation)}`,
    );
  } finally {
    rmSync(clone, { recursive: true, force: true });
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dirname(catalogRemote), { recursive: true, force: true });
  }
});

test("catalog promotion: dry-run renders the complete execution plan", () => {
  const { repoRoot, catalogRemote } = setupCatalogPromotionRepo();
  try {
    const r = runCatalogPromote({ repoRoot, exec: npmViewExec(repoRoot, "0.3.0\n") }, { catalogRemote, dryRun: true });
    assert.equal(r.code, 0, r.output);
    assert.equal(
      r.output,
      `release promote --dry-run — would run:\n` +
        `  npm view sapwood@0.3.0 version\n` +
        `  git rev-list -n 1 v0.3.0\n` +
        `  git clone --no-checkout ${repoRoot} <temp>/source\n` +
        `  git checkout --detach v0.3.0 (cwd: <temp>/source)\n` +
        `  git ls-tree -r --name-only v0.3.0 -- .claude-plugin commands bin scripts/catalog/ci.yml (cwd: <temp>/source)\n` +
        `  git clone ${catalogRemote} <temp>/catalog\n` +
        `  rm -rf <temp>/catalog/.claude-plugin <temp>/catalog/commands <temp>/catalog/bin\n` +
        `  cp -R <temp>/source/.claude-plugin <temp>/catalog/.claude-plugin; cp -R <temp>/source/commands <temp>/catalog/commands; cp -R <temp>/source/bin <temp>/catalog/bin\n` +
        `  mkdir -p <temp>/catalog/.github/workflows; cp <temp>/source/scripts/catalog/ci.yml <temp>/catalog/.github/workflows/ci.yml\n` +
        `  stamp <temp>/catalog/.claude-plugin/plugin.json (version 0.3.0) and marketplace.json (version 0.3.0, source ./)\n` +
        `  validate catalog CI allowlist (cwd: <temp>/catalog)\n` +
        `  git status --porcelain (cwd: <temp>/catalog)\n` +
        `  git add -- .claude-plugin commands bin .github/workflows/ci.yml (cwd: <temp>/catalog; if changed)\n` +
        `  git -c commit.gpgsign=false -c user.name=sapwood-release -c user.email=release@sapwood.invalid commit -m "chore: promote sapwood v0.3.0 from <source-commit-sha>" (cwd: <temp>/catalog; if changed)\n` +
        `  git push origin HEAD:main (cwd: <temp>/catalog; if changed)\n` +
        `  git tag v0.3.0 && git push origin v0.3.0 (cwd: <temp>/catalog; if absent)\n`,
    );
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dirname(catalogRemote), { recursive: true, force: true });
  }
});

test("catalog promotion: a failed push is recoverable by re-running promotion alone", () => {
  const { repoRoot, catalogRemote, initialCatalogHead } = setupCatalogPromotionRepo();
  try {
    const failed = runCatalogPromote({ repoRoot, exec: npmViewExec(repoRoot, "0.3.0\n", true) }, { catalogRemote, dryRun: false });
    assert.equal(failed.code, 1);
    assert.equal(catalogHead(catalogRemote), initialCatalogHead);

    const retry = runCatalogPromote({ repoRoot, exec: npmViewExec(repoRoot, "0.3.0\n") }, { catalogRemote, dryRun: false });
    assert.equal(retry.code, 0, retry.output);
    assert.notEqual(catalogHead(catalogRemote), initialCatalogHead);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dirname(catalogRemote), { recursive: true, force: true });
  }
});

test("catalog promotion: the assembled catalog tree accepts only catalog CI paths", () => {
  assert.deepEqual(
    checkCatalogPaths([
      ".claude-plugin/plugin.json",
      "commands/sapwood-run.md",
      "bin/sapwood-plugin.sh",
      ".github/workflows/ci.yml",
      "README.md",
    ]),
    {
      ok: true,
    },
  );
  const r = checkCatalogPaths([".claude-plugin/plugin.json", "scripts/release.ts"]);
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.message, /scripts\/release\.ts/);
});

test("catalog promotion: refuses a nonallowlisted file in the assembled catalog working tree", () => {
  const { repoRoot, catalogRemote, initialCatalogHead } = setupCatalogPromotionRepo("0.3.0", { "scripts/release.ts": "not allowed\n" });
  try {
    const r = runCatalogPromote({ repoRoot, exec: npmViewExec(repoRoot, "0.3.0\n") }, { catalogRemote, dryRun: false });
    assert.equal(r.code, 1);
    assert.match(r.output, /scripts\/release\.ts/);
    assert.equal(catalogHead(catalogRemote), initialCatalogHead);
  } finally {
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(dirname(catalogRemote), { recursive: true, force: true });
  }
});

test("the Windows smoke gates publish: first step, before the tag exists", () => {
  const names = PUBLISH_STEPS.map((step) => step.name);
  assert.equal(names[0], "windows-smoke");
  assert.ok(names.indexOf("windows-smoke") < names.indexOf("tag"));
});

test("the gh-release draft is created before the tag exists at all, which is before it's pushed", () => {
  const names = PUBLISH_STEPS.map((step) => step.name);
  // push-tag is what triggers release.yml, and that job only attaches evidence to an existing
  // draft — so the draft has to exist first, or a failed draft still leaves a local (or pushed)
  // tag behind with nothing for CI to attach evidence to.
  assert.ok(names.indexOf("gh-release") < names.indexOf("tag"));
  assert.ok(names.indexOf("tag") < names.indexOf("push-tag"));
});

test("runWindowsSmoke: dispatches, finds the run for HEAD, watches it with --exit-status", () => {
  const calls: string[][] = [];
  let listed = 0;
  const exec: Exec = (file, args) => {
    calls.push([file, ...args]);
    if (file === "git") return "abc123\n";
    if (args[0] === "run" && args[1] === "list") {
      // First poll: only a stale run for another sha; the fresh one shows up on the second.
      return listed++ === 0
        ? JSON.stringify([{ databaseId: 1, headSha: "old" }])
        : JSON.stringify([
            { databaseId: 2, headSha: "abc123" },
            { databaseId: 1, headSha: "old" },
          ]);
    }
    if (args[0] === "run" && args[1] === "watch" && args[2] !== "2") throw new Error(`watched the wrong run: ${args[2]}`);
    return "";
  };
  runWindowsSmoke({ repoRoot: "/unused", exec });
  assert.deepEqual(calls[1], ["gh", "workflow", "run", WINDOWS_SMOKE_WORKFLOW, "--ref", "main"]);
  assert.deepEqual(calls.at(-1), ["gh", "run", "watch", "2", "--exit-status"]);
  assert.throws(
    () => runWindowsSmoke({ repoRoot: "/unused", exec: (f, a) => (f === "git" ? "abc123" : a[1] === "list" ? "[]" : "") }, 1),
    /no windows-pack-smoke.yml run/,
  );
});

test("catalog promotion steps follow npm publish and the dashboard canary", () => {
  const names = PUBLISH_STEPS.map((step) => step.name);
  assert.ok(names.indexOf("catalog-promote") > names.indexOf("npm-publish"));
  assert.ok(names.indexOf("catalog-promote") > names.indexOf("dashboard-canary"));
  assert.ok(names.indexOf("npm-view-verify") < names.indexOf("catalog-promote"));
});

test("checkPublishPreconditions: fails when HEAD is not origin/main", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "bbb", dirty: "", tagOut: "" }) };
    const r = checkPublishPreconditions(deps);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /not origin\/main/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPublishPreconditions: fails on a dirty tree", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: " M foo.ts\n", tagOut: "" }) };
    const r = checkPublishPreconditions(deps);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /dirty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPublishPreconditions: fails when manifests disagree", () => {
  const dir = tmpRepo();
  try {
    writeFakeManifests(dir, ["0.3.0", "0.3.0", "0.2.9", "0.3.0"]);
    writeFileSync(join(dir, "CHANGELOG.md"), READY_CHANGELOG);
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    const r = checkPublishPreconditions(deps);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /disagree/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPublishPreconditions: fails when package-lock.json disagrees with the manifests", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    writeFakeLockfile(dir, "0.2.9"); // overwrite with a stale lockfile
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    const r = checkPublishPreconditions(deps);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /package-lock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPublishPreconditions: fails when CHANGELOG has no section for the manifest version", () => {
  const dir = setupPublishRepo("0.3.0", "## [Unreleased]\n\nnothing shipped yet\n");
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    const r = checkPublishPreconditions(deps);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /no "## \[0\.3\.0\]" section/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPublishPreconditions: fails when the tag already exists locally", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "v0.3.0\n" }) };
    const r = checkPublishPreconditions(deps);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPublishPreconditions: fails when the tag exists only on the remote, not in the local cache", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "", remoteTagExists: true }) };
    const r = checkPublishPreconditions(deps);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /already exists/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPublishPreconditions: fails at 0.0.0 (nothing prepared yet)", () => {
  const dir = setupPublishRepo("0.0.0", "## [Unreleased]\n");
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    const r = checkPublishPreconditions(deps);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /0\.0\.0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkPublishPreconditions: succeeds when everything lines up (tag absent both locally and on the remote)", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    assert.deepEqual(checkPublishPreconditions(deps), { ok: true, version: "0.3.0", commitSha: "aaa" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── npm dist-tag selection ──────────────────────────────────────────────────────────

function publishCtx(version: string): PublishContext {
  return { version, prerelease: isPrerelease(version), repoRoot: "", commitSha: "aaa" };
}

test("npmDistTag: a plain release is always latest", () => {
  assert.equal(npmDistTag(publishCtx("0.3.0")), "latest");
});

test("npmDistTag: alpha/beta/rc pre-releases use their own identifier as the tag, never a hardcoded alpha", () => {
  assert.equal(npmDistTag(publishCtx("0.3.0-alpha.1")), "alpha");
  assert.equal(npmDistTag(publishCtx("0.3.0-beta.1")), "beta");
  assert.equal(npmDistTag(publishCtx("0.3.0-rc.1")), "rc");
});

test("npmDistTag: a non-alphabetic first pre-release identifier falls back to next, never latest", () => {
  assert.equal(npmDistTag(publishCtx("0.3.0-1")), "next");
});

// ── publish --dry-run output ────────────────────────────────────────────────────────

test("runPublish --dry-run: prints --prerelease for an alpha version, runs nothing", () => {
  const dir = setupPublishRepo("0.3.0-alpha.1", "## [Unreleased]\n\n## [0.3.0-alpha.1] - 2026-08-19\n\n### Added\n- x\n");
  try {
    const { exec, calls } = withRecorder(fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }));
    const deps: Deps = { repoRoot: dir, exec };
    const r = runPublish(deps, { dryRun: true });
    assert.equal(r.code, 0);
    assert.match(r.output, /--dry-run/);
    assert.match(r.output, /--prerelease/);
    assert.match(r.output, /gh release create v0\.3\.0-alpha\.1.*--draft/);
    assert.match(r.output, /gh run watch <release\.yml run for v0\.3\.0-alpha\.1, matched by commit aaa> --exit-status/);
    assert.match(r.output, /node scripts\/dashboard-canary\.ts 0\.3\.0-alpha\.1/);
    // the CI-wait step renders before the canary in the dry-run listing, matching the real order.
    assert.ok(r.output.indexOf("gh run watch") < r.output.indexOf("dashboard-canary.ts"));
    assert.deepEqual(calls, [
      { file: "git", args: ["fetch", "origin", "main"] },
      { file: "git", args: ["rev-parse", "HEAD"] },
      { file: "git", args: ["rev-parse", "origin/main"] },
      { file: "git", args: ["status", "--porcelain"] },
      { file: "git", args: ["tag", "-l", "v0.3.0-alpha.1"] },
      { file: "git", args: ["ls-remote", "--exit-code", "--tags", "origin", "refs/tags/v0.3.0-alpha.1"] },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPublish --dry-run: omits --prerelease for a plain release version", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    const r = runPublish(deps, { dryRun: true });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.output, /--prerelease/);
    assert.match(r.output, /gh release create v0\.3\.0.*--draft/);
    assert.match(r.output, /gh run watch <release\.yml run for v0\.3\.0, matched by commit aaa> --exit-status/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPublish: marks catalog steps as skipped when no catalog remote is configured", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const { exec, calls } = withRecorder(fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }));
    const r = runPublish({ repoRoot: dir, exec }, { dryRun: false });
    assert.equal(r.code, 0, r.output);
    assert.equal((r.output.match(/skipped: no --catalog remote/g) ?? []).length, 2);
    assert.equal(
      calls.some((call) => call.file === "npm" && call.args[0] === "view"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPublish: a mismatched npm view stops before catalog clone or push", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const base = fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" });
    const { exec, calls } = withRecorder((file, args, cwd) => {
      if (file === "npm" && args[0] === "view") return "0.3.1\n";
      return base(file, args, cwd);
    });
    assert.throws(
      () => runPublish({ repoRoot: dir, exec }, { dryRun: false, catalogRemote: "https://catalog.invalid/sapwood-plugin.git" }),
      /npm view sapwood@0\.3\.0 version returned "0\.3\.1"/,
    );
    assert.equal(
      calls.some((call) => call.file === "git" && call.args[0] === "clone"),
      false,
    );
    assert.equal(
      calls.some((call) => call.file === "git" && call.args.join(" ") === "push origin HEAD:main"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const BANNED_MARKETPLACE_INSTALL_COMMAND = "npm ci --ignore-scripts";
const TEXT_FILE_SUFFIX = /\.(?:md|sh|txt|yaml|yml|json)$/;

function filesWithBannedMarketplaceInstallCommand(dirs: string[]): string[] {
  return dirs.flatMap((dir) =>
    readdirSync(dir, { recursive: true })
      .filter((path): path is string => typeof path === "string")
      .filter((path) => TEXT_FILE_SUFFIX.test(path))
      .map((path) => join(dir, path))
      .filter((path) => readFileSync(path, "utf8").includes(BANNED_MARKETPLACE_INSTALL_COMMAND)),
  );
}

test("plugin command documentation never claims marketplace installs run npm ci --ignore-scripts", () => {
  const scannedDirs = [join(REPO_ROOT, "commands"), join(REPO_ROOT, "bin"), join(REPO_ROOT, "docs")];
  const correctedSentence = "A marketplace install has no local engine build; the wrapper falls back to `npx sapwood@<plugin version>`";
  assert.deepEqual(filesWithBannedMarketplaceInstallCommand(scannedDirs), []);
  assert.ok(readFileSync(join(REPO_ROOT, "commands", "sapwood-run.md"), "utf8").includes(correctedSentence));
  assert.ok(readFileSync(join(REPO_ROOT, "commands", "sapwood-status.md"), "utf8").includes(correctedSentence));
  assert.equal(readFileSync(join(REPO_ROOT, "commands", "sapwood-stop.md"), "utf8").includes(BANNED_MARKETPLACE_INSTALL_COMMAND), false);

  const fixtureDir = tmpRepo();
  try {
    const stalePath = join(fixtureDir, "commands", "stale.md");
    mkdirSync(dirname(stalePath), { recursive: true });
    writeFileSync(stalePath, `unrelated fixture text: ${BANNED_MARKETPLACE_INSTALL_COMMAND}\n`);
    assert.deepEqual(filesWithBannedMarketplaceInstallCommand([fixtureDir]), [stalePath]);
  } finally {
    rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test("runPublish: a failed precondition is a non-zero exit with one clear line, no gh/git side effects", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "bbb", dirty: "", tagOut: "" }) };
    const r = runPublish(deps, { dryRun: false });
    assert.equal(r.code, 1);
    assert.equal(r.output.split("\n").filter(Boolean).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPublish (real run, not dry-run): exact tag/push/gh-release argv, --prerelease present, notes file = CHANGELOG section", () => {
  const version = "0.3.0-alpha.1";
  const changelog = `## [Unreleased]\n\n## [${version}] - 2026-08-19\n\n### Added\n- first public early-access cut\n`;
  const dir = setupPublishRepo(version, changelog);
  try {
    const { exec, calls, notesFileContents } = withRecorder(fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }));
    const deps: Deps = { repoRoot: dir, exec };
    const r = runPublish(deps, { dryRun: false });
    assert.equal(r.code, 0);

    const tagCall = calls.find((c) => c.file === "git" && c.args[0] === "tag" && c.args[1] === "-a");
    // "aaa" is the fake HEAD sha (== the precondition-captured commitSha) — the tag names that
    // commit explicitly, never a bare HEAD, so it can't drift from `--target` above.
    assert.deepEqual(tagCall?.args, ["tag", "-a", `v${version}`, "aaa", "-m", `v${version}`]);

    const pushCall = calls.find((c) => c.file === "git" && c.args[0] === "push");
    assert.deepEqual(pushCall?.args, ["push", "origin", `v${version}`]);

    const notesPath = join(tmpdir(), `sapwood-release-notes-${version}.md`);
    const ghCall = calls.find((c) => c.file === "gh" && c.args[0] === "release" && c.args[1] === "create");
    // Exact argv, not a regex/includes check: "aaa" is the fake HEAD sha `fakeExec` returns for
    // `git rev-parse HEAD`, which `checkHeadMatchesOriginMain` threads through as `commitSha`.
    assert.deepEqual(ghCall?.args, [
      "release",
      "create",
      `v${version}`,
      "--target",
      "aaa",
      "--title",
      `v${version}`,
      "--notes-file",
      notesPath,
      "--generate-notes",
      "--draft",
      "--prerelease",
    ]);

    assert.equal(notesFileContents.length, 1);
    assert.equal(notesFileContents[0], extractVersionSection(changelog, version));

    // `npm publish` itself runs inside release.yml's own `npm-publish` job now — this script
    // only waits for that job's run (found by commit sha, same field windows-smoke matches on).
    assert.equal(
      calls.some((c) => c.file === "npm"),
      false,
    );
    // windows-smoke (earlier in PUBLISH_STEPS) also does its own "run list"/"run watch" pair
    // against a different workflow — pick out release.yml's specifically, and the LAST "run
    // watch" call (npm-publish's own wait, since it runs after windows-smoke's).
    const ghRunListCall = calls
      .filter((c) => c.file === "gh" && c.args[0] === "run" && c.args[1] === "list")
      .find((c) => c.args.includes(RELEASE_WORKFLOW));
    assert.deepEqual(ghRunListCall?.args, [
      "run",
      "list",
      "--workflow",
      RELEASE_WORKFLOW,
      "--event",
      "push",
      "--limit",
      "5",
      "--json",
      "databaseId,headSha",
    ]);
    const ghRunWatchCall = calls.filter((c) => c.file === "gh" && c.args[0] === "run" && c.args[1] === "watch").at(-1);
    assert.deepEqual(ghRunWatchCall?.args, ["run", "watch", "7", "--exit-status"]);
    const canaryCall = calls.find((c) => c.file === "node");
    assert.deepEqual(canaryCall?.args, ["scripts/dashboard-canary.ts", version]);
    // the CI-wait step is the LAST publish-shipping step run — it waits only once the tag +
    // GitHub Release (the durable "this version shipped" record) exist.
    assert.ok(calls.indexOf(ghRunWatchCall!) > calls.indexOf(ghCall!));
    assert.ok(calls.indexOf(canaryCall!) > calls.indexOf(ghRunWatchCall!));
    // The draft must exist before the tag exists at all, which must exist before it's pushed:
    // `push-tag` is what triggers release.yml, and that job no longer creates a release on its
    // own if it finds none.
    assert.ok(calls.indexOf(ghCall!) < calls.indexOf(tagCall!));
    assert.ok(calls.indexOf(tagCall!) < calls.indexOf(pushCall!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPublish (real run): --prerelease absent from the gh-release argv for a plain release version", () => {
  const version = "0.3.0";
  const dir = setupPublishRepo(version, READY_CHANGELOG);
  try {
    const { exec, calls } = withRecorder(fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }));
    const deps: Deps = { repoRoot: dir, exec };
    const r = runPublish(deps, { dryRun: false });
    assert.equal(r.code, 0);
    const notesPath = join(tmpdir(), `sapwood-release-notes-${version}.md`);
    const ghCall = calls.find((c) => c.file === "gh" && c.args[0] === "release" && c.args[1] === "create");
    assert.deepEqual(ghCall?.args, [
      "release",
      "create",
      `v${version}`,
      "--target",
      "aaa",
      "--title",
      `v${version}`,
      "--notes-file",
      notesPath,
      "--generate-notes",
      "--draft",
    ]);
    // windows-smoke's own "run watch" comes first (before the tag exists at all); npm-publish's
    // wait is the LAST one, since it runs after gh-release/tag/push-tag.
    const ghRunWatchCall = calls.filter((c) => c.file === "gh" && c.args[0] === "run" && c.args[1] === "watch").at(-1);
    assert.deepEqual(ghRunWatchCall?.args, ["run", "watch", "7", "--exit-status"]);
    assert.ok(calls.indexOf(ghRunWatchCall!) > calls.indexOf(ghCall!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPublish (real run): the draft create is invoked before the tag push", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const { exec, calls } = withRecorder(fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }));
    const deps: Deps = { repoRoot: dir, exec };
    const r = runPublish(deps, { dryRun: false });
    assert.equal(r.code, 0);
    const ghCreateIdx = calls.findIndex((c) => c.file === "gh" && c.args[0] === "release" && c.args[1] === "create");
    const pushIdx = calls.findIndex((c) => c.file === "git" && c.args[0] === "push");
    assert.notEqual(ghCreateIdx, -1);
    assert.notEqual(pushIdx, -1);
    assert.ok(ghCreateIdx < pushIdx, `expected gh-release (index ${ghCreateIdx}) before push-tag (index ${pushIdx})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPublish (real run): a failing draft creation aborts before the tag is pushed", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const base = fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" });
    const { exec, calls } = withRecorder((file, args, cwd) => {
      if (file === "gh" && args[0] === "release" && args[1] === "create") {
        throw new Error("gh release create failed: HTTP 422 Validation Failed");
      }
      return base(file, args, cwd);
    });
    const deps: Deps = { repoRoot: dir, exec };
    assert.throws(() => runPublish(deps, { dryRun: false }), /gh release create failed/);
    // `tag` runs AFTER gh-release now, so a failed draft never even creates a local tag — let
    // alone pushes one that would trigger release.yml against a draft that doesn't exist.
    // (`git tag -l` is excluded: `checkPublishPreconditions` legitimately runs that existence
    // check before any of PUBLISH_STEPS, including the gh-release step that fails here.)
    assert.equal(
      calls.some((call) => call.file === "git" && call.args[0] === "tag" && call.args[1] === "-a"),
      false,
    );
    assert.equal(
      calls.some((call) => call.file === "git" && call.args[0] === "push"),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("waitForReleaseWorkflow: finds the release.yml run matching the tagged commit, watches it with --exit-status", () => {
  const calls: string[][] = [];
  let listed = 0;
  const exec: Exec = (file, args) => {
    calls.push([file, ...args]);
    if (args[0] === "run" && args[1] === "list") {
      // First poll: only a stale run for another commit; the tag's own run shows up second.
      return listed++ === 0
        ? JSON.stringify([{ databaseId: 1, headSha: "old" }])
        : JSON.stringify([
            { databaseId: 2, headSha: "abc123" },
            { databaseId: 1, headSha: "old" },
          ]);
    }
    if (args[0] === "run" && args[1] === "watch" && args[2] !== "2") throw new Error(`watched the wrong run: ${args[2]}`);
    return "";
  };
  waitForReleaseWorkflow({ repoRoot: "/unused", exec }, "abc123");
  assert.deepEqual(calls[0], [
    "gh",
    "run",
    "list",
    "--workflow",
    RELEASE_WORKFLOW,
    "--event",
    "push",
    "--limit",
    "5",
    "--json",
    "databaseId,headSha",
  ]);
  assert.deepEqual(calls.at(-1), ["gh", "run", "watch", "2", "--exit-status"]);
  assert.throws(
    () => waitForReleaseWorkflow({ repoRoot: "/unused", exec: (_f, a) => (a[1] === "list" ? "[]" : "") }, "abc123", 1),
    /no release\.yml run appeared for commit abc123/,
  );
});

test("runDistTag: alpha/beta/rc pre-releases print their own identifier, matching npmDistTag exactly", () => {
  assert.deepEqual(runDistTag("0.3.0-alpha.3"), { code: 0, output: "alpha\n" });
  assert.deepEqual(runDistTag("0.3.0-beta.1"), { code: 0, output: "beta\n" });
  assert.deepEqual(runDistTag("0.3.0-rc.1"), { code: 0, output: "rc\n" });
});

test("runDistTag: a non-alphabetic first pre-release identifier prints next, never latest", () => {
  assert.deepEqual(runDistTag("0.3.0-1"), { code: 0, output: "next\n" });
});

test("runDistTag: a plain release version prints latest", () => {
  assert.deepEqual(runDistTag("0.3.0"), { code: 0, output: "latest\n" });
});

test("runDistTag: an invalid version fails closed instead of guessing a tag", () => {
  const r = runDistTag("not-a-version");
  assert.equal(r.code, 1);
  assert.match(r.output, /not a valid SemVer/);
});

// ── runPrepare preconditions ────────────────────────────────────────────────────────

function setupPrepareRepo(version: string, changelog: string): string {
  const dir = tmpRepo();
  writeFakeManifests(dir, [version, version, version, version]);
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  return dir;
}

// `npm install --package-lock-only` is simulated by writing a lockfile matching `version` at
// the moment it's invoked — the same "the fake produces the side effect the real command
// would" pattern the other fakes use, not a special case for this one command.
function fakePrepareExec(opts: { head: string; origin: string; dirty: string; repoRoot: string; version: string }): Exec {
  return (file, args) => {
    if (file === "git" && args[0] === "fetch") return "";
    if (file === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return opts.head;
    if (file === "git" && args[0] === "rev-parse" && args[1] === "origin/main") return opts.origin;
    if (file === "git" && args[0] === "status") return opts.dirty;
    if (file === "npm" && args[0] === "install") {
      writeFakeLockfile(opts.repoRoot, opts.version);
      return "";
    }
    if (file === "git" && ["checkout", "add", "commit", "push"].includes(args[0]!)) return "";
    if (file === "gh") return "";
    throw new Error(`unexpected exec in test: ${file} ${args.join(" ")}`);
  };
}

const UNRELEASED_WITH_CONTENT = "## [Unreleased]\n\n### Added\n- x\n";

test("runPrepare: (a) fails when HEAD is not origin/main, before touching anything", () => {
  const dir = setupPrepareRepo("0.0.0", UNRELEASED_WITH_CONTENT);
  try {
    const deps: Deps = {
      repoRoot: dir,
      exec: fakePrepareExec({ head: "aaa", origin: "bbb", dirty: "", repoRoot: dir, version: "0.3.0-alpha.1" }),
    };
    const r = runPrepare(deps, "0.3.0-alpha.1");
    assert.equal(r.code, 1);
    assert.match(r.output, /not origin\/main/);
    assert.match(r.output, /up-to-date main/);
    assert.equal(readManifestVersion(join(dir, "package.json")), "0.0.0");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPrepare: (b) fails when the Unreleased body is empty", () => {
  const dir = setupPrepareRepo("0.0.0", "## [Unreleased]\n\n");
  try {
    const deps: Deps = {
      repoRoot: dir,
      exec: fakePrepareExec({ head: "aaa", origin: "aaa", dirty: "", repoRoot: dir, version: "0.3.0-alpha.1" }),
    };
    const r = runPrepare(deps, "0.3.0-alpha.1");
    assert.equal(r.code, 1);
    assert.match(r.output, /Unreleased/);
    assert.match(r.output, /empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPrepare: (c) fails when the new version equals the current one", () => {
  const dir = setupPrepareRepo("0.3.0", UNRELEASED_WITH_CONTENT);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakePrepareExec({ head: "aaa", origin: "aaa", dirty: "", repoRoot: dir, version: "0.3.0" }) };
    const r = runPrepare(deps, "0.3.0");
    assert.equal(r.code, 1);
    assert.match(r.output, /not greater than/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPrepare: (c) fails when the new version is below the current one", () => {
  const dir = setupPrepareRepo("0.3.0", UNRELEASED_WITH_CONTENT);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakePrepareExec({ head: "aaa", origin: "aaa", dirty: "", repoRoot: dir, version: "0.2.9" }) };
    const r = runPrepare(deps, "0.2.9");
    assert.equal(r.code, 1);
    assert.match(r.output, /not greater than/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPrepare: fails if npm install didn't actually bring the lockfile to the new version", () => {
  const dir = setupPrepareRepo("0.0.0", UNRELEASED_WITH_CONTENT);
  writeFakeLockfile(dir, "0.0.0"); // stale — the fake npm install below is a deliberate no-op
  try {
    const exec: Exec = (file, args) => {
      if (file === "git" && args[0] === "fetch") return "";
      if (file === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return "aaa";
      if (file === "git" && args[0] === "rev-parse" && args[1] === "origin/main") return "aaa";
      if (file === "git" && args[0] === "status") return "";
      if (file === "git" && args[0] === "checkout") return "";
      if (file === "npm" && args[0] === "install") return "";
      throw new Error(`unexpected exec in test: ${file} ${args.join(" ")}`);
    };
    const r = runPrepare({ repoRoot: dir, exec }, "0.3.0-alpha.1");
    assert.equal(r.code, 1);
    assert.match(r.output, /package-lock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPrepare: succeeds end-to-end from a 0.0.0 baseline — anything valid is greater", () => {
  const version = "0.3.0-alpha.1";
  const dir = setupPrepareRepo("0.0.0", UNRELEASED_WITH_CONTENT);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakePrepareExec({ head: "aaa", origin: "aaa", dirty: "", repoRoot: dir, version }) };
    const r = runPrepare(deps, version);
    assert.equal(r.code, 0);
    assert.equal(readManifestVersion(join(dir, "package.json")), version);
    assert.deepEqual(checkLockfileVersions(dir, version), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPrepare (real run): exact argv sequence — checkout -b, npm install, add (incl. package-lock.json), commit, push -u, gh pr create", () => {
  const version = "0.3.0-alpha.1";
  const dir = setupPrepareRepo("0.0.0", UNRELEASED_WITH_CONTENT);
  try {
    const { exec, calls } = withRecorder(fakePrepareExec({ head: "aaa", origin: "aaa", dirty: "", repoRoot: dir, version }));
    const deps: Deps = { repoRoot: dir, exec };
    const r = runPrepare(deps, version);
    assert.equal(r.code, 0);

    const checkoutCall = calls.find((c) => c.file === "git" && c.args[0] === "checkout");
    assert.deepEqual(checkoutCall?.args, ["checkout", "-b", `release/v${version}`]);

    const npmCall = calls.find((c) => c.file === "npm");
    assert.deepEqual(npmCall?.args, ["install", "--package-lock-only", "--ignore-scripts"]);

    const addCall = calls.find((c) => c.file === "git" && c.args[0] === "add");
    assert.ok(addCall);
    assert.deepEqual([...(addCall?.args.slice(1) ?? [])].sort(), [...MANIFEST_PATHS, "package-lock.json", "CHANGELOG.md"].sort());

    const commitCall = calls.find((c) => c.file === "git" && c.args[0] === "commit");
    assert.deepEqual(commitCall?.args, ["commit", "-m", `release: v${version}`]);

    const pushCall = calls.find((c) => c.file === "git" && c.args[0] === "push");
    assert.deepEqual(pushCall?.args, ["push", "-u", "origin", `release/v${version}`]);

    const ghCall = calls.find((c) => c.file === "gh");
    assert.equal(ghCall?.args[0], "pr");
    assert.equal(ghCall?.args[1], "create");

    // argv order matters for the mechanical steps (branch first, npm before staging), but the
    // exact call ORDER isn't re-asserted beyond that — each step's own argv is the contract.
    assert.ok(calls.findIndex((c) => c.file === "git" && c.args[0] === "checkout") < calls.findIndex((c) => c.file === "npm"));
    assert.ok(calls.findIndex((c) => c.file === "npm") < calls.findIndex((c) => c.file === "git" && c.args[0] === "add"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
