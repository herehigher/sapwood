import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changelogHasSection,
  checkLockfileVersions,
  checkManifestLockstep,
  checkMarketplaceRef,
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
  MARKETPLACE_PATH,
  marketplaceRefFor,
  moveUnreleasedToVersion,
  npmDistTag,
  type PublishContext,
  readManifestVersion,
  readMarketplaceRef,
  runPrepare,
  runPublish,
  validateReleaseVersion,
  writeManifestVersion,
  writeMarketplaceRef,
} from "./release.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

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

// ── marketplace.json ref: rewrite + lockstep check ──────────────────────────────────

test("marketplaceRefFor: 0.0.0 (pre-first-release) is main, everything else is v<version>", () => {
  assert.equal(marketplaceRefFor("0.0.0"), "main");
  assert.equal(marketplaceRefFor("0.3.0"), "v0.3.0");
  assert.equal(marketplaceRefFor("0.3.0-alpha.1"), "v0.3.0-alpha.1");
});

test("writeMarketplaceRef: rewrites only plugins[0].source.ref — every sibling field, at every level, survives untouched", () => {
  const dir = tmpRepo();
  try {
    const path = join(dir, "marketplace.json");
    const original = {
      name: "sapwood",
      owner: { name: "herehigher", url: "https://github.com/herehigher" },
      description: "the loop",
      plugins: [
        {
          name: "sapwood",
          source: { source: "github", repo: "x/x", ref: "main" },
          description: "plugin-level description",
          keywords: ["a", "b"],
        },
      ],
    };
    writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`);
    writeMarketplaceRef(path, "v0.3.0-alpha.1");

    const expected = structuredClone(original);
    expected.plugins[0]!.source.ref = "v0.3.0-alpha.1";
    // The write's output is byte-identical to re-serializing the mutated object in the same
    // canonical form — not just "parses to the same data" — so a rewrite really is a one-line
    // diff on disk, never a silent reformat of the rest of the file.
    assert.equal(readFileSync(path, "utf8"), `${JSON.stringify(expected, null, 2)}\n`);
    assert.equal(readMarketplaceRef(path), "v0.3.0-alpha.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writeMarketplaceRef: a "ref" string elsewhere in the file (a second plugin\'s own ref, a same-named sibling field) is left alone', () => {
  const dir = tmpRepo();
  try {
    const path = join(dir, "marketplace.json");
    const original = {
      name: "sapwood",
      plugins: [
        { name: "sapwood", source: { source: "github", repo: "x/x", ref: "main" }, ref: "not-the-real-one" },
        { name: "other-plugin", source: { source: "github", repo: "y/y", ref: "v9.9.9" } },
      ],
    };
    writeFileSync(path, `${JSON.stringify(original, null, 2)}\n`);
    writeMarketplaceRef(path, "v0.3.0");

    const written = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(written.plugins[0].source.ref, "v0.3.0");
    // Neither the sibling "ref" field on plugins[0] itself nor the second plugin's own ref were
    // touched — only plugins[0].source.ref, the one path writeMarketplaceRef is contracted to.
    assert.equal(written.plugins[0].ref, "not-the-real-one");
    assert.equal(written.plugins[1].source.ref, "v9.9.9");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeMarketplaceRef: round-trip idempotent — writing the same ref twice produces byte-identical output", () => {
  const dir = tmpRepo();
  try {
    writeFakeMarketplace(dir, "main");
    const path = join(dir, MARKETPLACE_PATH);
    writeMarketplaceRef(path, "v0.3.0");
    const firstWrite = readFileSync(path, "utf8");
    writeMarketplaceRef(path, "v0.3.0");
    assert.equal(readFileSync(path, "utf8"), firstWrite);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkMarketplaceRef: at 0.0.0, any ref is accepted (nothing prepared/tagged yet)", () => {
  const dir = tmpRepo();
  try {
    writeFakeMarketplace(dir, "main");
    assert.deepEqual(checkMarketplaceRef(join(dir, MARKETPLACE_PATH), "0.0.0"), { ok: true });
    writeMarketplaceRef(join(dir, MARKETPLACE_PATH), "anything-at-all");
    assert.deepEqual(checkMarketplaceRef(join(dir, MARKETPLACE_PATH), "0.0.0"), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkMarketplaceRef: past 0.0.0, ref must equal v<version> exactly", () => {
  const dir = tmpRepo();
  try {
    writeFakeMarketplace(dir, "v0.3.0");
    assert.deepEqual(checkMarketplaceRef(join(dir, MARKETPLACE_PATH), "0.3.0"), { ok: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("checkMarketplaceRef: past 0.0.0, a mismatched ref fails with both the actual and expected values", () => {
  const dir = tmpRepo();
  try {
    writeFakeMarketplace(dir, "main"); // stale — never bumped by a prepare
    const r = checkMarketplaceRef(join(dir, MARKETPLACE_PATH), "0.3.0");
    assert.equal(r.ok, false);
    assert.match((r as { message: string }).message, /"main"/);
    assert.match((r as { message: string }).message, /"v0\.3\.0"/);
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

// A minimal but structurally real marketplace.json — only the `plugins[0].source.ref` field
// `checkMarketplaceRef`/`writeMarketplaceRef` actually touch, not every optional field the real
// one carries.
function writeFakeMarketplace(dir: string, ref: string): void {
  const path = join(dir, MARKETPLACE_PATH);
  mkdirSync(dirname(path), { recursive: true });
  const marketplace = {
    name: "sapwood",
    owner: { name: "x" },
    plugins: [{ name: "sapwood", source: { source: "github", repo: "x/x", ref } }],
  };
  writeFileSync(path, `${JSON.stringify(marketplace, null, 2)}\n`);
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

test("lockstep: the repo's own marketplace.json ref agrees with the manifest version", () => {
  const paths = MANIFEST_PATHS.map((p) => join(REPO_ROOT, p));
  const lockstep = checkManifestLockstep(paths);
  assert.equal(lockstep.ok, true, lockstep.ok ? "" : (lockstep as { message: string }).message);
  const version = (lockstep as { version: string }).version;
  const r = checkMarketplaceRef(join(REPO_ROOT, MARKETPLACE_PATH), version);
  assert.equal(r.ok, true, r.ok ? "" : (r as { message: string }).message);
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
  writeFakeMarketplace(dir, marketplaceRefFor(version));
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
    if (file === "gh") return "";
    if (file === "npm" && args[0] === "publish") return "";
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

test("checkPublishPreconditions: fails when marketplace.json's ref doesn't match v<version>", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    writeMarketplaceRef(join(dir, MARKETPLACE_PATH), "main"); // stale — never bumped by a prepare
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    const r = checkPublishPreconditions(deps);
    assert.equal(r.ok, false);
    assert.match((r as { reason: string }).reason, /marketplace\.json/);
    assert.match((r as { reason: string }).reason, /"v0\.3\.0"/);
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
    assert.deepEqual(checkPublishPreconditions(deps), { ok: true, version: "0.3.0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── npm dist-tag selection ──────────────────────────────────────────────────────────

function publishCtx(version: string): PublishContext {
  return { version, prerelease: isPrerelease(version), repoRoot: "" };
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
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    const r = runPublish(deps, { dryRun: true });
    assert.equal(r.code, 0);
    assert.match(r.output, /--dry-run/);
    assert.match(r.output, /--prerelease/);
    assert.match(r.output, /npm publish --workspace engine --tag alpha/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPublish --dry-run: omits --prerelease for a plain release version, npm tag is latest", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    const r = runPublish(deps, { dryRun: true });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.output, /--prerelease/);
    assert.match(r.output, /npm publish --workspace engine --tag latest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
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
    assert.deepEqual(tagCall?.args, ["tag", "-a", `v${version}`, "-m", `v${version}`]);

    const pushCall = calls.find((c) => c.file === "git" && c.args[0] === "push");
    assert.deepEqual(pushCall?.args, ["push", "origin", `v${version}`]);

    const ghCall = calls.find((c) => c.file === "gh");
    assert.equal(ghCall?.args[0], "release");
    assert.equal(ghCall?.args[1], "create");
    assert.equal(ghCall?.args[2], `v${version}`);
    assert.ok(ghCall?.args.includes("--title"));
    assert.ok(ghCall?.args.includes("--notes-file"));
    assert.ok(ghCall?.args.includes("--generate-notes"));
    assert.ok(ghCall?.args.includes("--prerelease"));

    assert.equal(notesFileContents.length, 1);
    assert.equal(notesFileContents[0], extractVersionSection(changelog, version));

    const npmCall = calls.find((c) => c.file === "npm");
    assert.deepEqual(npmCall?.args, ["publish", "--workspace", "engine", "--tag", "alpha"]);
    // never `latest` for a pre-release, and the npm step is the LAST step run — it publishes
    // only once the tag + GitHub Release (the durable "this version shipped" record) exist.
    assert.ok(calls.indexOf(npmCall!) > calls.indexOf(ghCall!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runPublish (real run): --prerelease absent from the gh-release argv for a plain release version, npm tag is latest", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const { exec, calls } = withRecorder(fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }));
    const deps: Deps = { repoRoot: dir, exec };
    const r = runPublish(deps, { dryRun: false });
    assert.equal(r.code, 0);
    const ghCall = calls.find((c) => c.file === "gh");
    assert.ok(!ghCall?.args.includes("--prerelease"));
    const npmCall = calls.find((c) => c.file === "npm");
    assert.deepEqual(npmCall?.args, ["publish", "--workspace", "engine", "--tag", "latest"]);
    assert.ok(calls.indexOf(npmCall!) > calls.indexOf(ghCall!));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── runPrepare preconditions ────────────────────────────────────────────────────────

function setupPrepareRepo(version: string, changelog: string): string {
  const dir = tmpRepo();
  writeFakeManifests(dir, [version, version, version, version]);
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  // The ref written here is deliberately whatever the PRE-bump version would carry — runPrepare
  // must always overwrite it, never trust what's already there.
  writeFakeMarketplace(dir, marketplaceRefFor(version));
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
    assert.equal(readMarketplaceRef(join(dir, MARKETPLACE_PATH)), `v${version}`);
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
    assert.deepEqual(
      [...(addCall?.args.slice(1) ?? [])].sort(),
      [...MANIFEST_PATHS, MARKETPLACE_PATH, "package-lock.json", "CHANGELOG.md"].sort(),
    );

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
