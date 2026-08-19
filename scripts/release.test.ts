import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  changelogHasSection,
  checkManifestLockstep,
  checkPublishPreconditions,
  type Deps,
  type Exec,
  extractUnreleasedBody,
  extractVersionSection,
  formatBuildStamp,
  isPrerelease,
  MANIFEST_PATHS,
  moveUnreleasedToVersion,
  readManifestVersion,
  runPublish,
  validateReleaseVersion,
  writeManifestVersion,
} from "./release.ts";

const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

function tmpRepo(): string {
  return mkdtempSync(join(tmpdir(), "sapwood-release-test-"));
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

// ── CHANGELOG section move ──────────────────────────────────────────────────────────

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

// ── publish preconditions (fake exec) ───────────────────────────────────────────────

function setupPublishRepo(version: string, changelog: string): string {
  const dir = tmpRepo();
  writeFakeManifests(dir, [version, version, version, version]);
  writeFileSync(join(dir, "CHANGELOG.md"), changelog);
  return dir;
}

function fakeExec(opts: { head: string; origin: string; dirty: string; tagOut: string }): Exec {
  return (file, args) => {
    if (file === "git" && args[0] === "fetch") return "";
    if (file === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return opts.head;
    if (file === "git" && args[0] === "rev-parse" && args[1] === "origin/main") return opts.origin;
    if (file === "git" && args[0] === "status") return opts.dirty;
    if (file === "git" && args[0] === "tag" && args[1] === "-l") return opts.tagOut;
    if (file === "git" && (args[0] === "tag" || args[0] === "push")) return "";
    if (file === "gh") return "";
    throw new Error(`unexpected exec in test: ${file} ${args.join(" ")}`);
  };
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

test("checkPublishPreconditions: fails when the tag already exists", () => {
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

test("checkPublishPreconditions: succeeds when everything lines up", () => {
  const dir = setupPublishRepo("0.3.0", READY_CHANGELOG);
  try {
    const deps: Deps = { repoRoot: dir, exec: fakeExec({ head: "aaa", origin: "aaa", dirty: "", tagOut: "" }) };
    assert.deepEqual(checkPublishPreconditions(deps), { ok: true, version: "0.3.0" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
