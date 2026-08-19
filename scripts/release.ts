// sapwood release script — `npm run release -- <prepare|publish|stamp> ...`.
// Node built-ins + `git`/`gh` via child_process only, no dependency. Plain Node 24
// type-stripped TypeScript: erasable syntax only (no enums/namespaces/parameter
// properties), local imports carry an explicit `.ts` extension.
//
// Policy this script encodes is written out in docs/dev-guide/10-releasing.md — read
// that first if a check here looks surprising. The four version-carrying manifests are
// written ONLY from here; never hand-edit a manifest's "version" field.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const MANIFEST_PATHS = ["package.json", "engine/package.json", "dashboard/package.json", ".claude-plugin/plugin.json"];

const UNRELEASED_HEADING = "## [Unreleased]";

// Official SemVer 2.0.0 grammar (semver.org). Anchored, so a version string that
// merely CONTAINS a valid semver (leading/trailing junk) is rejected too.
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export type ValidationResult = { ok: true } | { ok: false; message: string };

// Build metadata is rejected in the SOURCE version deliberately: `+...` is stamped at
// build time (see `formatBuildStamp` / `stamp` below), never chosen by a human — a
// human-cut tag that already carried one would create a second, un-lockstepped notion
// of "the version" the moment CI stamped its own.
export function validateReleaseVersion(version: string): ValidationResult {
  if (version.includes("+")) {
    return {
      ok: false,
      message: `version must not include build metadata ("+...") — that is stamped at build time, never chosen by a human; see docs/dev-guide/10-releasing.md's three-layer table.`,
    };
  }
  if (!SEMVER_RE.test(version)) {
    return { ok: false, message: `"${version}" is not a valid SemVer 2.0.0 version (expected MAJOR.MINOR.PATCH[-prerelease]).` };
  }
  return { ok: true };
}

export function isPrerelease(version: string): boolean {
  return version.includes("-");
}

// ── Manifest lockstep ───────────────────────────────────────────────────────────────

export function readManifestVersion(path: string): string {
  const text = readFileSync(path, "utf8");
  const m = text.match(/"version"\s*:\s*"([^"]*)"/);
  if (!m) throw new Error(`no "version" field found in ${path}`);
  return m[1];
}

// Edits the `"version"` line's value in place instead of JSON.parse + stringify, so a
// manifest's existing formatting/indentation/key order is untouched by the bump.
export function writeManifestVersion(path: string, version: string): void {
  const text = readFileSync(path, "utf8");
  const re = /("version"\s*:\s*")([^"]*)(")/;
  if (!re.test(text)) throw new Error(`no "version" field found in ${path}`);
  writeFileSync(path, text.replace(re, `$1${version}$3`));
}

export type LockstepResult = { ok: true; version: string } | { ok: false; message: string };

export function checkManifestLockstep(paths: string[]): LockstepResult {
  const versions = paths.map((path) => ({ path, version: readManifestVersion(path) }));
  const first = versions[0];
  const mismatched = versions.filter((v) => v.version !== first.version);
  if (mismatched.length > 0) {
    return { ok: false, message: `manifest versions disagree: ${versions.map((v) => `${v.path}=${v.version}`).join(", ")}` };
  }
  return { ok: true, version: first.version };
}

// ── CHANGELOG ────────────────────────────────────────────────────────────────────────

function sectionBody(changelog: string, headingStart: number, headingLength: number): { body: string; nextHeadingIndex: number } {
  const bodyStart = headingStart + headingLength;
  const nextHeadingIndex = changelog.indexOf("\n## ", bodyStart);
  const body = nextHeadingIndex === -1 ? changelog.slice(bodyStart) : changelog.slice(bodyStart, nextHeadingIndex);
  return { body: body.replace(/^\s+|\s+$/g, ""), nextHeadingIndex };
}

export function extractUnreleasedBody(changelog: string): string {
  const start = changelog.indexOf(UNRELEASED_HEADING);
  if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading`);
  return sectionBody(changelog, start, UNRELEASED_HEADING.length).body;
}

export function formatChangelogVersionHeading(version: string, date: string): string {
  return `## [${version}] - ${date}`;
}

// Moves the current Unreleased body under a new `## [<version>] - <date>` heading and
// leaves a fresh, empty Unreleased section above it — everything else in the file
// (older version sections) is passed through unchanged.
export function moveUnreleasedToVersion(changelog: string, version: string, date: string): string {
  const start = changelog.indexOf(UNRELEASED_HEADING);
  if (start === -1) throw new Error(`CHANGELOG.md has no "${UNRELEASED_HEADING}" heading`);
  const { body, nextHeadingIndex } = sectionBody(changelog, start, UNRELEASED_HEADING.length);
  const before = changelog.slice(0, start);
  const after = nextHeadingIndex === -1 ? "" : changelog.slice(nextHeadingIndex + 1);
  const replacement = `${UNRELEASED_HEADING}\n\n${formatChangelogVersionHeading(version, date)}\n\n${body}\n\n`;
  return `${before}${replacement}${after}`;
}

export function extractVersionSection(changelog: string, version: string): string | null {
  const heading = `## [${version}]`;
  const start = changelog.indexOf(heading);
  if (start === -1) return null;
  const lineEnd = changelog.indexOf("\n", start);
  const headingLength = (lineEnd === -1 ? changelog.length : lineEnd + 1) - start;
  return sectionBody(changelog, start, headingLength).body;
}

// Lockstep test's other half (docs/dev-guide/10-releasing.md): "0.0.0" is the
// never-yet-released state, where Unreleased is the section of record.
export function changelogHasSection(changelog: string, version: string): boolean {
  return version === "0.0.0" ? changelog.includes(UNRELEASED_HEADING) : changelog.includes(`## [${version}]`);
}

// ── Build stamp ──────────────────────────────────────────────────────────────────────

export function formatChangelogDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function formatBuildDateStamp(now: Date): string {
  return formatChangelogDate(now).replaceAll("-", "");
}

export function formatBuildStamp(version: string, date: string, sha: string): string {
  return `${version}+${date}.${sha}`;
}

// ── exec seam (testable: tests inject a fake) ───────────────────────────────────────

export type Exec = (file: string, args: string[]) => string;

export interface Deps {
  exec: Exec;
  repoRoot: string;
}

function realExec(repoRoot: string): Exec {
  return (file, args) => execFileSync(file, args, { cwd: repoRoot, encoding: "utf8" });
}

// ── publish preconditions ───────────────────────────────────────────────────────────

export type PublishPrecondition = { ok: true; version: string } | { ok: false; reason: string };

export function checkPublishPreconditions(deps: Deps): PublishPrecondition {
  deps.exec("git", ["fetch", "origin", "main"]);
  const head = deps.exec("git", ["rev-parse", "HEAD"]).trim();
  const mainHead = deps.exec("git", ["rev-parse", "origin/main"]).trim();
  if (head !== mainHead) {
    return { ok: false, reason: `HEAD (${head}) is not origin/main (${mainHead}) — publish only runs from a fully-merged main.` };
  }
  const dirty = deps.exec("git", ["status", "--porcelain"]).trim();
  if (dirty !== "") {
    return { ok: false, reason: "working tree is dirty — commit or stash before publishing." };
  }
  const lockstep = checkManifestLockstep(MANIFEST_PATHS.map((p) => join(deps.repoRoot, p)));
  if (!lockstep.ok) return { ok: false, reason: lockstep.message };
  if (lockstep.version === "0.0.0") {
    return { ok: false, reason: "manifests are still at 0.0.0 — nothing prepared to publish yet." };
  }
  const changelog = readFileSync(join(deps.repoRoot, "CHANGELOG.md"), "utf8");
  if (!changelogHasSection(changelog, lockstep.version)) {
    return { ok: false, reason: `CHANGELOG.md has no "## [${lockstep.version}]" section.` };
  }
  const tag = `v${lockstep.version}`;
  if (deps.exec("git", ["tag", "-l", tag]).trim() !== "") {
    return { ok: false, reason: `tag ${tag} already exists — see rollback in docs/dev-guide/10-releasing.md.` };
  }
  return { ok: true, version: lockstep.version };
}

// ── publish steps ────────────────────────────────────────────────────────────────────
// Deliberately an ordered, appendable list rather than inline procedural code: the
// npm-publish step (docs/dev-guide/10-releasing.md's "Delivery channels") lands here
// as one more entry, without touching runPublish's orchestration.

export interface PublishContext {
  version: string;
  prerelease: boolean;
  repoRoot: string;
}

export interface PublishStep {
  name: string;
  describe(ctx: PublishContext): string;
  run(ctx: PublishContext, deps: Deps): void;
}

export const PUBLISH_STEPS: PublishStep[] = [
  {
    name: "tag",
    describe: (ctx) => `git tag -a v${ctx.version} -m "v${ctx.version}"`,
    run: (ctx, deps) => {
      deps.exec("git", ["tag", "-a", `v${ctx.version}`, "-m", `v${ctx.version}`]);
    },
  },
  {
    name: "push-tag",
    describe: (ctx) => `git push origin v${ctx.version}`,
    run: (ctx, deps) => {
      deps.exec("git", ["push", "origin", `v${ctx.version}`]);
    },
  },
  {
    name: "gh-release",
    describe: (ctx) =>
      `gh release create v${ctx.version} --title v${ctx.version} --notes-file <CHANGELOG [${ctx.version}] section> --generate-notes` +
      (ctx.prerelease ? " --prerelease" : ""),
    run: (ctx, deps) => {
      const changelog = readFileSync(join(deps.repoRoot, "CHANGELOG.md"), "utf8");
      const section = extractVersionSection(changelog, ctx.version) ?? "";
      const notesPath = join(tmpdir(), `sapwood-release-notes-${ctx.version}.md`);
      writeFileSync(notesPath, section);
      try {
        const args = ["release", "create", `v${ctx.version}`, "--title", `v${ctx.version}`, "--notes-file", notesPath, "--generate-notes"];
        if (ctx.prerelease) args.push("--prerelease");
        deps.exec("gh", args);
      } finally {
        rmSync(notesPath, { force: true });
      }
    },
  },
];

export interface CommandResult {
  code: number;
  output: string;
}

export function runPublish(deps: Deps, opts: { dryRun: boolean }): CommandResult {
  const pre = checkPublishPreconditions(deps);
  if (!pre.ok) return { code: 1, output: `release publish: ${pre.reason}\n` };
  const ctx: PublishContext = { version: pre.version, prerelease: isPrerelease(pre.version), repoRoot: deps.repoRoot };
  const lines = PUBLISH_STEPS.map((step) => {
    if (!opts.dryRun) step.run(ctx, deps);
    return step.describe(ctx);
  });
  const header = opts.dryRun ? `release publish --dry-run — would run:\n` : `release publish v${ctx.version}:\n`;
  return { code: 0, output: header + lines.map((l) => `  ${l}`).join("\n") + "\n" };
}

// ── prepare ──────────────────────────────────────────────────────────────────────────

export function runPrepare(deps: Deps, version: string): CommandResult {
  const validation = validateReleaseVersion(version);
  if (!validation.ok) return { code: 1, output: `release prepare: ${validation.message}\n` };
  const dirty = deps.exec("git", ["status", "--porcelain"]).trim();
  if (dirty !== "") return { code: 1, output: "release prepare: working tree is dirty — commit or stash first.\n" };

  const branch = `release/v${version}`;
  const actions: string[] = [];

  deps.exec("git", ["checkout", "-b", branch]);
  actions.push(`created branch ${branch}`);

  for (const p of MANIFEST_PATHS) {
    writeManifestVersion(join(deps.repoRoot, p), version);
    actions.push(`bumped ${p} -> ${version}`);
  }

  const changelogPath = join(deps.repoRoot, "CHANGELOG.md");
  const date = formatChangelogDate(new Date());
  const updatedChangelog = moveUnreleasedToVersion(readFileSync(changelogPath, "utf8"), version, date);
  writeFileSync(changelogPath, updatedChangelog);
  actions.push(`moved CHANGELOG Unreleased -> [${version}] - ${date}`);

  deps.exec("git", ["add", ...MANIFEST_PATHS, "CHANGELOG.md"]);
  deps.exec("git", ["commit", "-m", `release: v${version}`]);
  actions.push(`committed "release: v${version}"`);

  deps.exec("git", ["push", "-u", "origin", branch]);
  actions.push(`pushed ${branch}`);

  const prBody = extractVersionSection(updatedChangelog, version) ?? "";
  deps.exec("gh", ["pr", "create", "--title", `release: v${version}`, "--body", prBody, "--base", "main", "--head", branch]);
  actions.push("opened PR (body = the new CHANGELOG section)");

  return { code: 0, output: actions.map((a) => `- ${a}`).join("\n") + "\n" };
}

// ── stamp (CI build-time step) ──────────────────────────────────────────────────────

export function buildStampPath(repoRoot: string): string {
  return join(repoRoot, "engine", "dist", "build-stamp.json");
}

export function runStamp(deps: Deps): CommandResult {
  const sha = deps.exec("git", ["rev-parse", "--short=7", "HEAD"]).trim();
  const date = formatBuildDateStamp(new Date());
  const outPath = buildStampPath(deps.repoRoot);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify({ date, sha }, null, 2)}\n`);
  return { code: 0, output: `wrote ${outPath}: ${date}.${sha}\n` };
}

// ── CLI entry ────────────────────────────────────────────────────────────────────────

function repoRootFromThisFile(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

function main(argv: string[]): number {
  const repoRoot = repoRootFromThisFile();
  const deps: Deps = { exec: realExec(repoRoot), repoRoot };
  const cmd = argv[2];

  if (cmd === "prepare") {
    const version = argv[3];
    if (!version) {
      process.stderr.write("usage: release prepare <version>\n");
      return 1;
    }
    const r = runPrepare(deps, version);
    process.stdout.write(r.output);
    return r.code;
  }
  if (cmd === "publish") {
    const r = runPublish(deps, { dryRun: argv.slice(3).includes("--dry-run") });
    process.stdout.write(r.output);
    return r.code;
  }
  if (cmd === "stamp") {
    const r = runStamp(deps);
    process.stdout.write(r.output);
    return r.code;
  }
  process.stderr.write("usage: release <prepare <version>|publish [--dry-run]|stamp>\n");
  return 1;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exit(main(process.argv));
}
